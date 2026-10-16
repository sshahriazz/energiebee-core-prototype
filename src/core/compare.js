// Tariff comparison: the home's actual half-hours (same imports, same exports,
// same times) re-priced on other tariffs. Behaviour is held fixed, so this shows
// what the tariff alone changes, not what a battery tuned for another tariff would do.
import { db } from '../db/db.js';
import { loadPricing, priceAt, rateRow, vatAt } from './pricing.js';
import { slotsOfDay, zonedParts, SLOT } from './time.js';
import { fetchJson } from './http.js';
import { upsertTariff, syncTariffRates } from '../adapters/octopus.js';
import { landRaw } from './facts.js';

// Pick the products Octopus sells today, so the comparison never points at a withdrawn version.
export async function discoverReferenceProducts(siteId) {
  const url = 'https://api.octopus.energy/v1/products/?brand=OCTOPUS_ENERGY&is_business=false&page_size=100';
  const { json } = await fetchJson(url);
  landRaw({ source: 'octopus_rates', siteId, request: { url }, body: json });
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

// Called from the sync job: make sure every comparison tariff has prices for the window.
export async function syncComparison(site, fromTs, toTs) {
  if (!site.gsp_region) return { skipped: 'no region' };
  const products = await discoverReferenceProducts(site.id);
  db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'compare'").run(JSON.stringify({ products }), site.id);
  let rates = 0;
  const done = new Set();
  for (const sc of scenarios(site.gsp_region, products)) {
    for (const [codeStr, direction] of [[sc.import, 'import'], [sc.export, 'export']]) {
      if (!codeStr || done.has(codeStr)) continue;
      done.add(codeStr);
      const t = upsertTariff({ tariffCode: codeStr, direction });
      rates += await syncTariffRates(t, fromTs, toTs, site.id);
    }
  }
  return { products, rates };
}

export function compareSite(siteId, from, to) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const conn = db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'compare'").get(siteId);
  const products = JSON.parse(conn?.meta || '{}').products;
  if (!products || !site.gsp_region) return { ready: false, reason: 'Comparison prices have not been fetched yet. Press Sync.' };
  const rows = db.prepare(`SELECT slot_start, local_date, grid_import, grid_export, state FROM site_hh
    WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND state != 'missing' ORDER BY slot_start`).all(siteId, from, to);
  if (!rows.length) return { ready: false, reason: 'No half-hours in this period yet.' };
  const start = rows[0].slot_start; const end = rows[rows.length - 1].slot_start + SLOT;
  const pricing = loadPricing(siteId, start, end);
  const sc = scenarios(site.gsp_region, products);
  const codes = [...new Set(sc.flatMap((x) => [x.import, x.export]).filter(Boolean))];
  const tariffs = new Map(db.prepare(`SELECT * FROM tariff WHERE tariff_code IN (${codes.map(() => '?').join(',')})`).all(...codes).map((t) => [t.tariff_code, t]));
  const ids = [...tariffs.values()].map((t) => t.id);
  const alt = {
    rates: ids.length ? db.prepare(`SELECT * FROM rate_interval WHERE tariff_id IN (${ids.map(() => '?').join(',')})
      AND superseded_at IS NULL AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ? AND site_id IS NULL`).all(...ids, end, start - 2 * 86400) : [],
    vat: pricing.vat,
  };
  const altPrice = (codeStr, direction, ts) => {
    const t = tariffs.get(codeStr);
    if (!t) return null;
    const u = rateRow(alt, t.id, 'unit', 'single', ts);
    if (!u) return null;
    const st = direction === 'import' ? rateRow(alt, t.id, 'standing', 'single', ts) : null;
    const vat = vatAt(alt, 'electricity', direction, ts);
    return { unit: u.price_ex_vat * (1 + vat), standing: st ? st.price_ex_vat * (1 + vat) : 0 };
  };

  const blank = () => ({ importCost: 0, exportCredit: 0, standing: 0 });
  const totals = { current: blank(), ...Object.fromEntries(sc.map((x) => [x.key, blank()])) };
  const days = new Map();
  const tod = Array.from({ length: 48 }, (_, i) => ({ index: i, n: 0, import: 0, current: 0, agile: 0, nAgile: 0 }));
  const slots = [];
  const nSlots = new Map();
  let skipped = 0; let importKwh = 0; let exportKwh = 0; let negativeSlots = 0;
  const windows = { offPeak: { kwh: 0, cur: 0, agile: 0 }, peak: { kwh: 0, cur: 0, agile: 0 }, other: { kwh: 0, cur: 0, agile: 0 } };

  for (const r of rows) {
    const t = r.slot_start;
    const pi = priceAt(pricing, 'meter_import', t);
    const pe = priceAt(pricing, 'meter_export', t);
    if (!pi || pi.unitEx == null) { skipped++; continue; }
    const cur = { unit: pi.unitEx * (1 + pi.vat), standing: pi.standingEx * (1 + pi.vat), exp: pe?.unitEx != null ? pe.unitEx * (1 + pe.vat) : 0 };
    const alts = {};
    let missing = false;
    for (const x of sc) {
      const ip = altPrice(x.import, 'import', t);
      const ep = x.export ? altPrice(x.export, 'export', t) : { unit: cur.exp };
      if (!ip || !ep) { missing = true; break; }
      alts[x.key] = { unit: ip.unit, standing: ip.standing, exp: ep.unit };
    }
    if (missing) { skipped++; continue; }   // like-for-like: a half-hour counts only if every tariff has a price

    if (!nSlots.has(r.local_date)) nSlots.set(r.local_date, slotsOfDay(site.timezone, r.local_date).length);
    const share = 1 / nSlots.get(r.local_date);
    const imp = r.grid_import || 0; const exp = r.grid_export || 0;
    importKwh += imp; exportKwh += exp;
    const d = days.get(r.local_date) || { date: r.local_date, import: 0, export: 0, provisional: 0, ...Object.fromEntries(['current', ...sc.map((x) => x.key)].map((k) => [k, 0])) };
    if (r.state === 'provisional') d.provisional++;
    d.import += imp; d.export += exp;
    const add = (key, p) => {
      const a = totals[key];
      a.importCost += imp * p.unit; a.exportCredit += exp * p.exp; a.standing += p.standing * share;
      d[key] += imp * p.unit - exp * p.exp + p.standing * share;
    };
    add('current', cur);
    for (const x of sc) add(x.key, alts[x.key]);
    days.set(r.local_date, d);

    const agile = alts.agile?.unit;
    if (agile != null && agile < 0) negativeSlots++;
    const { hh, mm } = zonedParts(site.timezone, t);
    const k = hh * 2 + (mm >= 30 ? 1 : 0);
    const p = tod[k];
    p.n++; p.import += imp; p.current += cur.unit;
    if (agile != null) { p.agile += agile; p.nAgile++; }
    const w = pi.register === 'night' ? windows.offPeak : (hh >= 16 && hh < 19) ? windows.peak : windows.other;
    w.kwh += imp; w.cur += imp * cur.unit; if (agile != null) w.agile += imp * agile;
    slots.push({ slot_start: t, import: imp, export: exp, current: cur.unit, agile, current_export: cur.exp, agile_export: alts.agile_out?.exp ?? null });
  }

  const net = (a) => a.importCost - a.exportCredit + a.standing;
  const nDays = days.size || 1;
  const currentImport = pricing.agreements.find((a) => a.kind === 'meter_import' && a.valid_from <= end && (a.valid_to == null || a.valid_to > start));
  const currentExport = pricing.agreements.find((a) => a.kind === 'meter_export' && a.valid_from <= end && (a.valid_to == null || a.valid_to > start));
  const list = [
    { key: 'current', name: 'Your tariff', note: [currentImport?.tariff_code, currentExport?.tariff_code].filter(Boolean).join(' + '), import: currentImport?.tariff_code, export: currentExport?.tariff_code, current: true },
    ...sc,
  ].map((x) => {
    const a = totals[x.key];
    return { ...x, ...a, net: net(a), avgImport: importKwh ? a.importCost / importKwh : null, avgExport: exportKwh ? a.exportCredit / exportKwh : null,
      vsCurrent: net(a) - net(totals.current), perYear: ((net(a) - net(totals.current)) / nDays) * 365 };
  });

  const profile = tod.map((p) => ({ index: p.index, import: p.n ? p.import / p.n : null, current: p.n ? p.current / p.n : null, agile: p.nAgile ? p.agile / p.nAgile : null }));
  const dayList = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));

  // Insights: where the difference comes from.
  const ins = [];
  const cur = list[0]; const ag = list.find((x) => x.key === 'agile');
  const gbp = (p) => `£${(Math.abs(p) / 100).toFixed(2)}`;
  if (ag) {
    const better = ag.vsCurrent > 0;
    ins.push({ tone: better ? 'good' : 'warn', title: better ? `Your tariff beat Agile by ${gbp(ag.vsCurrent)}` : `Agile would have been ${gbp(ag.vsCurrent)} cheaper`,
      detail: `Over ${nDays} day${nDays === 1 ? '' : 's'} with the same use. That is about ${gbp(ag.perYear)} a year ${better ? 'in your favour' : 'lost'}, if the pattern held.` });
    const won = dayList.filter((d) => d.agile > d.current).length;
    ins.push({ tone: 'info', title: `Your tariff was cheaper on ${won} of ${dayList.length} days`, detail: `Agile would have been cheaper on ${dayList.length - won}.` });
    if (windows.offPeak.kwh > 0.5) {
      ins.push({ tone: 'info', title: `${Math.round((windows.offPeak.kwh / (importKwh || 1)) * 100)}% of imports were in your off-peak window`,
        detail: `${windows.offPeak.kwh.toFixed(1)} kWh at ${(windows.offPeak.cur / windows.offPeak.kwh).toFixed(1)}p on your tariff; Agile averaged ${(windows.offPeak.agile / windows.offPeak.kwh).toFixed(1)}p at those times (${gbp(windows.offPeak.agile - windows.offPeak.cur)} ${windows.offPeak.agile > windows.offPeak.cur ? 'more' : 'less'}).` });
    }
    if (windows.peak.kwh > 0.2) {
      ins.push({ tone: windows.peak.agile > windows.peak.cur ? 'good' : 'tip', title: `${windows.peak.kwh.toFixed(1)} kWh imported between 16:00 and 19:00`,
        detail: `Agile averaged ${(windows.peak.agile / windows.peak.kwh).toFixed(1)}p then, against ${(windows.peak.cur / windows.peak.kwh).toFixed(1)}p on your tariff. Moving that use out of the evening matters most on Agile.` });
    }
    const exportDiff = (list.find((x) => x.key === 'agile_out')?.exportCredit ?? 0) - cur.exportCredit;
    if (exportKwh > 0.5) {
      const agOut = list.find((x) => x.key === 'agile_out');
      ins.push({ tone: exportDiff > 0 ? 'tip' : 'info', title: exportDiff > 0 ? `Agile Outgoing would have paid ${gbp(exportDiff)} more for exports` : `Your export tariff paid ${gbp(exportDiff)} more than Agile Outgoing`,
        detail: `${exportKwh.toFixed(1)} kWh exported, earning ${cur.avgExport != null ? cur.avgExport.toFixed(1) : '–'}p/kWh on your tariff and ${agOut?.avgExport != null ? agOut.avgExport.toFixed(1) : '–'}p/kWh on Agile Outgoing at the same times.` });
    }
    const standingDiff = ag.standing - cur.standing;
    if (Math.abs(standingDiff) > 5) ins.push({ tone: 'info', title: `Standing charges differ by ${gbp(standingDiff)}`, detail: `${standingDiff > 0 ? 'Agile' : 'Your tariff'} has the higher daily charge over these days.` });
    if (negativeSlots) ins.push({ tone: 'info', title: `Agile went below 0p in ${negativeSlots} half-hours`, detail: 'On Agile the home would have been paid for energy imported in those half-hours.' });
  }
  const ev = db.prepare("SELECT label, attrs FROM device WHERE site_id = ? AND kind = 'ev'").all(siteId)
    .find((e) => JSON.parse(e.attrs || '{}').status?.currentState === 'SMART_CONTROL_NOT_AVAILABLE');
  if (ev && /iog|intelli/i.test(cur.import || '')) {
    const dispatches = db.prepare(`SELECT COUNT(*) AS n FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN metric m ON m.id = s.metric_id
      JOIN source src ON src.id = s.source_id WHERE s.subject_kind = 'site' AND s.subject_id = ? AND m.code = 'ev_charge_kwh' AND src.code = 'octopus_kraken'`).get(String(siteId)).n;
    ins.push({ tone: 'warn', title: `${ev.label}: smart control not available`, detail: `Octopus reports the car's state as SMART_CONTROL_NOT_AVAILABLE, and ${dispatches} smart-charge slot${dispatches === 1 ? ' was' : 's were'} recorded. Without slots, the cheap rate in this comparison applies only in the off-peak window.` });
  }
  ins.push({ tone: 'info', title: 'Same use, different prices', detail: 'Every half-hour is re-priced with exactly what the home imported and exported. The comparison does not change when energy is used.' });

  return {
    ready: true, from, to, days: nDays, importKwh, exportKwh, skipped, products, scenarios: list, daily: dayList, profile, slots, windows, insights: ins,
    provisionalSlots: dayList.reduce((s, d) => s + d.provisional, 0),
  };
}
