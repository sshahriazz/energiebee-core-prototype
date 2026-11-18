// Tariff comparison: the home's actual slots (same imports, same exports,
// same times) re-priced on other tariffs. Behaviour is held fixed, so this shows
// what the tariff alone changes, not what a battery tuned for another tariff would do.
// Slots are the home's own length (site.slot_s); prices are taken over the whole slot.
//
// Market-aware: which tariffs are compared depends on the home's market.
//   GB      the Octopus products sold today (Agile import, Agile + Agile Outgoing), for the
//           home's distribution region as an Octopus GSP letter (site.gsp_region, or its gb_dno
//           region's octopus_gsp alias). Prices synced by syncComparison.
//   others  every other import tariff of the home's country and currency held in the database
//           whose prices cover the period (no Octopus code is ever built for them).
// Every scenario is slots (Phase T.6): the home's own tariff from its price slots, an alternative from the slots of its price runs
// put on the home through a stand-in agreement (tariff-slots.js: windows, dynamic prices, fixed and capacity charges, the home's
// country's taxes), and a slot's cost is the home's energy in it times those slots, the same code for every tariff. Money is in the
// home's currency, and a day has its real number of slots.
import { db } from '../db/db.js';
import { loadPricing } from './pricing.js';
import { unitInc } from './slot-price.js';
import { supplyPricer } from './supply-price.js';
import { candidateRuns, candidatePricing, candidatePricer, slotMoney } from './tariff-slots.js';
import { zonedParts, slotLength, slotsPerDay, slotOfDay, slotNoun } from './time.js';
import { mapAsync } from './async.js';
import { CURRENCIES } from './money.js';
import { fetchJson } from './http.js';
import { upsertTariff, syncTariffRates } from '../adapters/octopus.js';
import { landRaw } from './facts.js';
import { aliasesOf } from './regions.js';
import { regionsOf } from './sites.js';
import { inputsProvenance, weakest } from './provenance.js';

// Pick the products Octopus sells today, so the comparison never points at a withdrawn version.
export async function discoverReferenceProducts(siteId) {
  const url = 'https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY&is_business=false&page_size=100';
  const { json } = await fetchJson(url);
  await landRaw({ source: 'octopus_rates', siteId, request: { url }, body: json });
  const live = (json.results || []).filter((p) => !p.available_to || Date.parse(p.available_to) > Date.now());
  const pick = (re, dir) => live.filter((p) => re.test(p.code) && p.direction === dir).sort((a, b) => b.code.localeCompare(a.code))[0]?.code;
  return {
    agileImport: pick(/^AGILE-(?!OUTGOING)/, 'IMPORT'),
    agileExport: pick(/^AGILE-OUTGOING-/, 'EXPORT'),
    flexible: pick(/^VAR-/, 'IMPORT'),
  };
}

export function scenarios(region, products) {
  const code = (product) => (product ? `E-1R-${product}-${region}` : null);
  return [
    { key: 'agile', name: 'Agile Octopus', note: 'Agile import, your current export', import: code(products.agileImport), export: null },
    { key: 'agile_out', name: 'Agile + Agile Outgoing', note: 'both directions on half-hourly prices', import: code(products.agileImport), export: code(products.agileExport) },
  ].filter((x) => x.import);
}

// The Octopus GSP letter of a GB home: the one stored from its postcode, else its distribution
// region's octopus_gsp alias. Null for a home outside GB or with no region.
export async function octopusRegion(site) {
  if ((site.market_code ?? 'GB') !== 'GB') return null;
  if (site.gsp_region) return site.gsp_region;
  const dno = (await regionsOf(site.id)).find((r) => r.scheme === 'gb_dno');
  return dno ? aliasesOf({ scheme: 'gb_dno', code: dno.code }).find((a) => a.alias_scheme === 'octopus_gsp')?.alias_code ?? null : null;
}

// Called from the sync job: make sure every comparison tariff has prices for the window.
// Only GB has a reference catalogue (Octopus); other markets compare the tariffs already held.
export async function syncComparison(site, fromTs, toTs) {
  if ((site.market_code ?? 'GB') !== 'GB') return { skipped: `no reference catalogue for market ${site.market_code}` };
  const region = await octopusRegion(site);
  if (!region) return { skipped: 'no region' };
  const products = await discoverReferenceProducts(site.id);
  await db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'compare'").run(JSON.stringify({ products }), site.id);
  let rates = 0;
  const done = new Set();
  for (const sc of scenarios(region, products)) {
    for (const [codeStr, direction] of [[sc.import, 'import'], [sc.export, 'export']]) {
      if (!codeStr || done.has(codeStr)) continue;
      done.add(codeStr);
      const t = await upsertTariff({ tariffCode: codeStr, direction });
      rates += await syncTariffRates(t, fromTs, toTs, site.id);
    }
  }
  return { products, rates };
}

// Other import tariffs of a non-GB home's country and currency, with prices over [start, end),
// as comparison scenarios (each with the home's current export).
async function marketScenarios(site, start, end, currentIds) {
  return (await db.prepare(`SELECT t.* FROM tariff t WHERE t.country = ? AND t.currency = ? AND t.direction = 'import' AND t.fuel = 'electricity'
      AND EXISTS (SELECT 1 FROM rate_interval r WHERE r.tariff_id = t.id AND r.component = 'unit' AND r.superseded_at IS NULL
        AND (r.site_id IS NULL OR r.site_id = ?) AND r.valid_from < ? AND COALESCE(r.valid_to, 9000000000) > ?)
    ORDER BY t.tariff_code`).all(site.country, site.currency, site.id, end, start))
    .filter((t) => !currentIds.has(t.id))
    .map((t) => ({ key: `alt:${t.tariff_code}`, name: t.name || t.tariff_code, note: `${t.tariff_code} import, your current export`, import: t.tariff_code, export: null }));
}

const OFF_PEAK = /^(night|hc|[a-z]+_hc|off_?peak)$/;

export async function compareSite(siteId, from, to) {
  const site = await db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const gb = (site.market_code ?? 'GB') === 'GB';
  const conn = await db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'compare'").get(siteId);
  const products = JSON.parse(conn?.meta || '{}').products;
  const slotS = slotLength(site);
  const currency = site.currency ?? 'GBP';
  const region = gb ? await octopusRegion(site) : null;
  if (gb && (!products || !region)) return { ready: false, currency, slot_s: slotS, reason: 'Comparison prices have not been fetched yet. Press Sync.' };
  const rows = await db.prepare(`SELECT slot_start, local_date, grid_import, grid_export, state FROM site_hh
    WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND state != 'missing' AND dur_s = ? ORDER BY slot_start`).all(siteId, from, to, slotS);
  if (!rows.length) return { ready: false, currency, slot_s: slotS, reason: `No ${slotNoun(slotS)}s in this period yet.` };
  const start = rows[0].slot_start; const end = rows[rows.length - 1].slot_start + slotS;
  const pricing = await loadPricing(siteId, start, end);
  const sc = gb ? scenarios(region, products) : await marketScenarios(site, start, end, new Set(pricing.agreements.map((a) => a.tariff_id)));
  if (!sc.length) return { ready: false, currency, slot_s: slotS, reason: `No other tariffs of market ${site.market_code} are held to compare with.` };
  const codes = [...new Set(sc.flatMap((x) => [x.import, x.export]).filter(Boolean))];
  const tariffs = new Map((await db.prepare(`SELECT * FROM tariff WHERE tariff_code IN (${codes.map(() => '?').join(',')})`).all(...codes)).map((t) => [t.tariff_code, t]));
  // Every scenario is slots: the home's own tariff is read from its price slots (supply-price.js: the stored ones, computed where
  // missing, nothing written), and an alternative is a context that puts the home on that tariff for the whole period, priced by the
  // same code over the tariff's runs (tariff-slots.js). The alternatives are taxed by the same rules as the home's own tariff (its
  // country's tax_rule). A slot is priced over the whole slot, time-weighted when it spans two prices (an hour on Agile), unpriced if
  // any part has no price. The cost of a slot is the home's energy in it times these prices (slotMoney), whichever tariff.
  const homeSlots = await supplyPricer({ siteId, p: pricing, slotS, tz: site.timezone, materialise: true, persist: false });
  await homeSlots.load(rows.map((r) => r.slot_start));
  const runs = await candidateRuns([...tariffs.values()], siteId, start, end);
  const altSlots = new Map(await mapAsync(sc, async (x) => {
    const candidates = [tariffs.get(x.import), x.export && tariffs.get(x.export)].filter(Boolean).map((tariff) => ({ tariff }));
    return [x.key, await candidatePricer({ siteId, pricing: await candidatePricing(pricing, candidates, siteId, start, end, runs), slotS, tz: site.timezone })];
  }));
  const altInputs = new Map(sc.map((x) => [x.key, []]));
  // A candidate's slot at a supply point; null when it has no tariff there or no price in the slot.
  const altSlot = (key, point, ts) => {
    const s = altSlots.get(key).get(point, ts);
    if (!s.price || s.price.unitEx == null) return null;
    if (altInputs.get(key).length < 64) altInputs.get(key).push(...(s.price.inputs ?? []));
    return s;
  };
  const curInputs = [];

  const primary = sc.find((x) => x.key === 'agile') ?? sc[0];
  // How the primary alternative is called in sentences: "Agile" in GB, its name elsewhere.
  const alt = primary.key === 'agile' ? 'Agile' : primary.name;
  const blank = () => ({ importCost: 0, exportCredit: 0, standing: 0 });
  const totals = { current: blank(), ...Object.fromEntries(sc.map((x) => [x.key, blank()])) };
  const days = new Map();
  const tod = Array.from({ length: slotsPerDay(slotS) }, (_, i) => ({ index: i, n: 0, import: 0, current: 0, agile: 0, nAgile: 0 }));
  const slots = [];
  let skipped = 0; let importKwh = 0; let exportKwh = 0; let negativeSlots = 0;
  const windows = { offPeak: { kwh: 0, cur: 0, agile: 0 }, peak: { kwh: 0, cur: 0, agile: 0 }, other: { kwh: 0, cur: 0, agile: 0 } };

  for (const r of rows) {
    const t = r.slot_start;
    const curImp = homeSlots.get('meter_import', t); const curExp = homeSlots.get('meter_export', t);
    const pi = curImp.price; const pe = curExp.price;
    if (!pi || pi.unitEx == null) { skipped++; continue; }
    if (curInputs.length < 64) curInputs.push(...(pi.inputs ?? []), ...(pe?.inputs ?? []));
    const alts = {};
    let missing = false;
    for (const x of sc) {
      const ip = altSlot(x.key, 'meter_import', t);
      const ep = x.export ? altSlot(x.key, 'meter_export', t) : curExp;   // no export tariff in the scenario: the home's own export
      if (!ip || !ep) { missing = true; break; }
      alts[x.key] = { imp: ip, exp: ep };
    }
    if (missing) { skipped++; continue; }   // like-for-like: a half-hour counts only if every tariff has a price

    const imp = r.grid_import || 0; const exp = r.grid_export || 0;
    importKwh += imp; exportKwh += exp;
    const d = days.get(r.local_date) || { date: r.local_date, import: 0, export: 0, provisional: 0, ...Object.fromEntries(['current', ...sc.map((x) => x.key)].map((k) => [k, 0])) };
    if (r.state === 'provisional') d.provisional++;
    d.import += imp; d.export += exp;
    // Energy x the slot's prices and its share of the fixed charges: the same formula for the home's tariff and every alternative.
    const add = (key, s) => {
      const a = totals[key]; const m = slotMoney(imp, exp, s.imp, s.exp);
      const credit = m.exportCredit ?? 0;   // no export price known: no credit, as the home's own build
      a.importCost += m.importCost; a.exportCredit += credit; a.standing += m.fixed;
      d[key] += m.importCost - credit + m.fixed;
    };
    const curUnit = unitInc(pi); const curExpUnit = unitInc(pe) ?? 0;
    add('current', { imp: curImp, exp: curExp });
    for (const x of sc) add(x.key, alts[x.key]);
    days.set(r.local_date, d);

    // The primary alternative (Agile in GB; the first other tariff elsewhere) fills the `agile` fields.
    const agile = alts[primary.key] ? unitInc(alts[primary.key].imp.price) : undefined;
    if (agile != null && agile < 0) negativeSlots++;
    const { hh } = zonedParts(site.timezone, t);
    const p = tod[slotOfDay(site.timezone, t, slotS)];
    p.n++; p.import += imp; p.current += curUnit;
    if (agile != null) { p.agile += agile; p.nAgile++; }
    const w = OFF_PEAK.test(pi.register ?? '') ? windows.offPeak : (hh >= 16 && hh < 19) ? windows.peak : windows.other;
    w.kwh += imp; w.cur += imp * curUnit; if (agile != null) w.agile += imp * agile;
    slots.push({ slot_start: t, import: imp, export: exp, current: curUnit, agile, current_export: curExpUnit, agile_export: alts.agile_out ? (unitInc(alts.agile_out.exp.price) ?? 0) : null });
  }

  const net = (a) => a.importCost - a.exportCredit + a.standing;
  const nDays = days.size || 1;
  const currentImport = pricing.agreements.find((a) => a.kind === 'meter_import' && a.valid_from <= end && (a.valid_to == null || a.valid_to > start));
  const currentExport = pricing.agreements.find((a) => a.kind === 'meter_export' && a.valid_from <= end && (a.valid_to == null || a.valid_to > start));
  // Provenance of each scenario's prices: the weakest of its tariff, rate and tax inputs.
  const provOf = (inputs) => inputsProvenance(inputs) ?? { origin: null, placeholder_inputs: [] };
  const list = [
    { key: 'current', name: 'Your tariff', note: [currentImport?.tariff_code, currentExport?.tariff_code].filter(Boolean).join(' + '), import: currentImport?.tariff_code, export: currentExport?.tariff_code, current: true },
    ...sc,
  ].map((x) => {
    const a = totals[x.key];
    const pv = provOf(x.key === 'current' ? curInputs : [...altInputs.get(x.key), ...(x.export ? [] : curInputs.filter((i) => /OUTGOING|EXPORT/i.test(i.what)))]);
    return { ...x, ...a, net: net(a), avgImport: importKwh ? a.importCost / importKwh : null, avgExport: exportKwh ? a.exportCredit / exportKwh : null,
      vsCurrent: net(a) - net(totals.current), perYear: ((net(a) - net(totals.current)) / nDays) * 365, origin: pv.origin, placeholder_inputs: pv.placeholder_inputs };
  });

  const profile = tod.map((p) => ({ index: p.index, import: p.n ? p.import / p.n : null, current: p.n ? p.current / p.n : null, agile: p.nAgile ? p.agile / p.nAgile : null }));
  const dayList = [...days.values()].sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => (primary.key === 'agile' ? d : { ...d, agile: d[primary.key] }));

  // Insights: where the difference comes from.
  const ins = [];
  const cur = list[0]; const ag = list.find((x) => x.key === primary.key);
  // Amounts in the home's currency (minor units in, major units shown); unit prices in its minor unit.
  const cu = CURRENCIES[currency] ?? CURRENCIES.GBP;
  const money = (p) => `${cu.symbol}${(Math.abs(p) / 10 ** cu.minorExponent).toFixed(cu.minorExponent)}`;
  const mu = { GBP: 'p', EUR: 'c' }[cu.code] ?? ` ${cu.code} minor`;
  const slotsWord = `${slotNoun(slotS)}s`;
  if (ag) {
    const better = ag.vsCurrent > 0;
    ins.push({ tone: better ? 'good' : 'warn', title: better ? `Your tariff beat ${alt} by ${money(ag.vsCurrent)}` : `${alt} would have been ${money(ag.vsCurrent)} cheaper`,
      detail: `Over ${nDays} day${nDays === 1 ? '' : 's'} with the same use. That is about ${money(ag.perYear)} a year ${better ? 'in your favour' : 'lost'}, if the pattern held.` });
    const won = dayList.filter((d) => d.agile > d.current).length;
    ins.push({ tone: 'info', title: `Your tariff was cheaper on ${won} of ${dayList.length} days`, detail: `${alt} would have been cheaper on ${dayList.length - won}.` });
    if (windows.offPeak.kwh > 0.5) {
      ins.push({ tone: 'info', title: `${Math.round((windows.offPeak.kwh / (importKwh || 1)) * 100)}% of imports were in your off-peak window`,
        detail: `${windows.offPeak.kwh.toFixed(1)} kWh at ${(windows.offPeak.cur / windows.offPeak.kwh).toFixed(1)}${mu} on your tariff; ${alt} averaged ${(windows.offPeak.agile / windows.offPeak.kwh).toFixed(1)}${mu} at those times (${money(windows.offPeak.agile - windows.offPeak.cur)} ${windows.offPeak.agile > windows.offPeak.cur ? 'more' : 'less'}).` });
    }
    if (windows.peak.kwh > 0.2) {
      ins.push({ tone: windows.peak.agile > windows.peak.cur ? 'good' : 'tip', title: `${windows.peak.kwh.toFixed(1)} kWh imported between 16:00 and 19:00`,
        detail: `${alt} averaged ${(windows.peak.agile / windows.peak.kwh).toFixed(1)}${mu} then, against ${(windows.peak.cur / windows.peak.kwh).toFixed(1)}${mu} on your tariff. Moving that use out of the evening matters most on ${alt}.` });
    }
    const exportDiff = (list.find((x) => x.key === 'agile_out')?.exportCredit ?? 0) - cur.exportCredit;
    if (exportKwh > 0.5 && list.some((x) => x.key === 'agile_out')) {
      const agOut = list.find((x) => x.key === 'agile_out');
      ins.push({ tone: exportDiff > 0 ? 'tip' : 'info', title: exportDiff > 0 ? `Agile Outgoing would have paid ${money(exportDiff)} more for exports` : `Your export tariff paid ${money(exportDiff)} more than Agile Outgoing`,
        detail: `${exportKwh.toFixed(1)} kWh exported, earning ${cur.avgExport != null ? cur.avgExport.toFixed(1) : '–'}${mu}/kWh on your tariff and ${agOut?.avgExport != null ? agOut.avgExport.toFixed(1) : '–'}${mu}/kWh on Agile Outgoing at the same times.` });
    }
    const standingDiff = ag.standing - cur.standing;
    if (Math.abs(standingDiff) > 5) ins.push({ tone: 'info', title: `Standing charges differ by ${money(standingDiff)}`, detail: `${standingDiff > 0 ? alt : 'Your tariff'} has the higher daily charge over these days.` });
    if (negativeSlots) ins.push({ tone: 'info', title: `${alt} went below 0${mu} in ${negativeSlots} ${slotsWord}`, detail: `On ${alt} the home would have been paid for energy imported in those ${slotsWord}.` });
  }
  const ev = (await db.prepare("SELECT label, attrs FROM device WHERE site_id = ? AND kind = 'ev'").all(siteId))
    .find((e) => JSON.parse(e.attrs || '{}').status?.currentState === 'SMART_CONTROL_NOT_AVAILABLE');
  if (ev && /iog|intelli/i.test(cur.import || '')) {
    const dispatches = (await db.prepare(`SELECT COUNT(*) AS n FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN metric m ON m.id = s.metric_id
      JOIN source src ON src.id = s.source_id WHERE s.subject_kind = 'site' AND s.subject_id = ? AND m.code = 'ev_charge_kwh' AND src.code = 'octopus_kraken'`).get(String(siteId))).n;
    ins.push({ tone: 'warn', title: `${ev.label}: smart control not available`, detail: `Octopus reports the car's state as SMART_CONTROL_NOT_AVAILABLE, and ${dispatches} smart-charge slot${dispatches === 1 ? ' was' : 's were'} recorded. Without slots, the cheap rate in this comparison applies only in the off-peak window.` });
  }
  ins.push({ tone: 'info', title: 'Same use, different prices', detail: `Every ${slotNoun(slotS)} is re-priced with exactly what the home imported and exported. The comparison does not change when energy is used.` });

  return {
    ready: true, currency, slot_s: slotS, from, to, days: nDays, importKwh, exportKwh, skipped, products, scenarios: list, daily: dayList, profile, slots, windows, insights: ins,
    provisionalSlots: dayList.reduce((s, d) => s + d.provisional, 0),
    // Added for other markets: which scenario fills the `agile` fields, and the market compared in.
    market: site.market_code ?? 'GB', primaryKey: primary.key, primaryName: alt,
    provenance: { worst: weakest(list.map((x) => x.origin).filter(Boolean)), placeholders: [...new Set(list.flatMap((x) => x.placeholder_inputs))].sort() },
  };
}
