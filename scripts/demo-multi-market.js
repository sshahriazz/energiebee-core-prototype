// Multi-market demonstration: three SYNTHETIC homes (GB, FR, NL) in a throwaway database, built
// by the production build engine, with the checks printed in plain words.
//
//   node --disable-warning=ExperimentalWarning scripts/demo-multi-market.js
//
// Never touches data/core.db or .env and calls no provider: the database is a new file in the
// system temp folder (DB_FILE, as the tests do) and is deleted when the script ends
// (unless DEMO_DB is set).
// Exit code 1 if any check fails.
//
// Provenance: every figure printed is tagged with where it came from, in the vocabulary of
// src/core/provenance.js ([synthetic prices, sourced VAT], [placeholder taxes] ...). The tags are
// read from the database (origin columns) and from each slot's lineage, not typed here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// DEMO_DB=/some/path/core.db keeps the demo database there (to browse it in the web pages).
const keep = process.env.DEMO_DB;
const dir = keep ? path.dirname(path.resolve(keep)) : fs.mkdtempSync(path.join(os.tmpdir(), 'eb-demo-'));
if (keep) fs.mkdirSync(dir, { recursive: true });
process.env.DB_FILE = keep ? path.resolve(keep) : path.join(dir, 'core.db');
if (!keep) process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const m = await import('./lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { setSlotLength, regionsOf, createSite, setContractedCapacity } = await import('../src/core/sites.js');
const { createTariff, agreeTariff, putRateRows, storeWindows } = await import('../src/core/tariffs.js');
const { processQueue, buildSite } = await import('../src/core/build.js');
const { slotsOfDay, slotNoun, zonedParts, dayBounds, addDays } = await import('../src/core/time.js');
const { format, CURRENCIES } = await import('../src/core/money.js');
const { aliasesOf } = await import('../src/core/regions.js');
const { fixedChargeMicro } = await import('../src/core/tariff-expand.js');
const { periodProvenance, ORIGINS } = await import('../src/core/provenance.js');

const results = [];
const check = (ok, what) => { results.push({ ok: !!ok, what }); return ok ? 'PASS' : 'FAIL'; };
const line = (s = '') => console.log(s);
const rule = (title) => { line(); line(`── ${title} ${'─'.repeat(Math.max(0, 92 - title.length))}`); };
const pad = (v, n) => String(v).padEnd(n);
const lpad = (v, n) => String(v).padStart(n);
const hm = (tz, ts) => { const { hh, mm } = zonedParts(tz, ts); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
const MINOR = { GBP: 'p', EUR: 'c' };
const money = (minor, cur) => `${minor.toFixed(2)} ${cur} minor (${format(minor, cur)})`;

// ───────────── Provenance tags, read from the data ─────────────
// What a set of built slots rests on: their energy data, their prices (tariff and rate rows) and
// their taxes, each with its origin. Prices and taxes come from the slots' lineage; the taxes'
// own origin from tax_rule when no placeholder is named.
function tagOf(rows, country) {
  const L = rows.map((r) => JSON.parse(r.lineage || '{}'));
  const named = new Set(L.flatMap((l) => l.placeholder_inputs || []));
  const has = (re) => [...named].some((x) => re.test(x));
  const parts = [];
  if (L.some((l) => l.data_origin === 'synthetic')) parts.push('synthetic data');
  if (has(/^(tariff|rate) .*\[synthetic\]$/)) parts.push('synthetic prices');
  else if (L.some((l) => l.origin === 'provider')) parts.push('provider prices');
  if (has(/^tax_rule .*\[placeholder\]$/)) parts.push('placeholder taxes');
  else parts.push(`${taxOrigin(country)} VAT`);
  if (L.some((l) => l.estimated)) parts.push('estimated');
  return `[${parts.join(', ')}]`;
}
const taxOrigin = (country) => db.prepare('SELECT origin FROM tax_rule WHERE country = ? AND superseded_at IS NULL').all(country).map((r) => r.origin)
  .sort((a, b) => ORIGINS.indexOf(b) - ORIGINS.indexOf(a))[0] ?? 'no';
const pricesTag = (country) => `[synthetic prices, ${taxOrigin(country) === 'placeholder' ? 'placeholder taxes' : `${taxOrigin(country)} VAT`}]`;
const marketTag = (code) => `[${db.prepare('SELECT origin FROM market WHERE code = ?').get(code)?.origin ?? 'no origin'} market row]`;

line('EnergieBee core · multi-market demonstration');
line(`Database: a throwaway file in ${dir} (deleted on exit). data/core.db and .env are not touched; no provider is called.`);
rule('PROVENANCE');
line('Every figure below carries a tag saying where it came from (src/core/provenance.js). Strongest first:');
line('  sourced      taken from a named, checkable source (the note names it)');
line('  provider     live data fetched from a provider for a real home            (none in this demo)');
line('  user         typed in by the user or installer                            (none in this demo)');
line('  placeholder  a stand-in from memory or an assumption, NOT verified against an official source');
line('  synthetic    generated test or demo data');
line('  derived      computed by the build from the above: it carries the weakest input\'s tag');
line('In this demo:');
line('  synthetic    every inverter sample, meter reading, tariff, unit price, day-ahead (spot) price, subscription,');
line('               the Tempo colour calendar, the meter\'s own HP/HC hours and the contracted capacity (scripts/lib/multi-market.js)');
line('  placeholder  the FR and NL tax values (src/core/tax.js PLACEHOLDER_TAX_RULES, unverified: true) and the FR and NL');
line('               market rows (src/db/seed/markets.js): NOT verified against the official sources, must not be relied on');
line('  sourced      GB VAT (src/db/registry.js VAT_RATES), the GB distribution-region numbering (src/db/seed/regions-gb.js)');
line('               and the GB market row');
line('  derived      every cost, total, fixed charge and check: computed by the production build engine');

const t0 = Date.now();
const homes = m.buildScenario();
line();
line(`Built 3 homes over their days with the production build engine (src/core/build.js) in ${Date.now() - t0} ms.`);
const demoSites = [homes.gb, homes.fr, homes.nl].map((h) => m.siteRow(h.site.id));
line(`Every home is flagged demo (site.is_demo = 1): ${demoSites.map((s) => `${s.name} is_demo=${s.is_demo}`).join(', ')} (${check(demoSites.every((s) => s.is_demo === 1), 'provenance: the three homes are demo homes')}).`);

function header(h, w, label) {
  const s = m.siteRow(h.site.id);
  rule(`${label} · ${s.name} [synthetic home]`);
  line(`Market ${s.market_code} ${marketTag(s.market_code)} · country ${s.country} · currency ${s.currency} (${CURRENCIES[s.currency].symbol}, minor unit ${MINOR[s.currency]}) · ${s.timezone} · slot_s ${s.slot_s} (${slotNoun(s.slot_s)})`);
  line(`Regions: ${regionsOf(s.id).map((r) => `${r.scheme} ${r.code} ${r.name} [${r.origin ?? 'no origin'}]`).join('; ')}`);
  return s;
}

function changeDays(s, w) {
  const built = m.hhRows(s.id, w.change, w.change).length;
  const spring = slotsOfDay(s.timezone, '2026-03-29', s.slot_s).length; const autumn = slotsOfDay(s.timezone, '2025-10-26', s.slot_s).length;
  const want = (86400 + (w.change.endsWith('03-29') ? -3600 : 3600)) / s.slot_s;
  line(`Clock-change day ${w.change}: ${built} slots built [synthetic data] (${check(built === want, `${s.market_code}: ${want} slots on ${w.change}`)}). On this home's grid every`);
  line(`  spring-forward day has ${spring} and every clocks-back day ${autumn} slots of ${s.slot_s} s (23 h and 25 h days).`);
}

function ledger(s, w) {
  const days = m.dayRows(s.id, w.from, w.to);
  const rows = m.hhRows(s.id, w.from, w.to);
  const priced = rows.filter((r) => r.rate_found === 1).length;
  line(`Priced slot coverage: ${priced} of ${rows.length} (${check(priced === rows.length, `${s.market_code}: every slot priced`)}); ledger currency on every day: ${[...new Set(days.map((d) => d.currency))].join(', ')} (${check(days.every((d) => d.currency === s.currency), `${s.market_code}: site_day.currency = ${s.currency}`)})`);
  line(`${pad('Day', 12)}${lpad('slots', 6)}${lpad('import kWh', 12)}${lpad('home kWh', 10)}  ${pad('daily cost', 34)}${pad('fixed charges / day (incl. tax)', 33)}provenance`);
  for (const d of days) {
    const tag = tagOf(rows.filter((r) => r.local_date === d.local_date), s.country);
    line(`${pad(d.local_date, 12)}${lpad(d.slots, 6)}${lpad(d.grid_import.toFixed(2), 12)}${lpad(d.home.toFixed(2), 10)}  ${pad(money(d.total_cost, d.currency), 34)}${pad(`${d.standing_cost.toFixed(4)} ${MINOR[d.currency]}`, 33)}${tag}`);
  }
  // The period's provenance block (the same one the API serves) must call the synthetic data synthetic.
  const p = periodProvenance(db, s, w.from, w.to);
  line(`Provenance block for ${w.from}..${w.to}: worst = ${p.worst}, demo = ${p.demo}; not verified: ${p.placeholders.join('; ')}`);
  line(`  (${check(p.worst === 'synthetic' && p.demo && p.placeholders.length > 0, `${s.market_code}: provenance block says synthetic`)})`);
  return rows;
}

const examples = (rows, pred) => rows.filter(pred);
const reg = (r) => JSON.parse(r.lineage).register;

// ───────────── GB ─────────────
{
  const { gb } = homes;
  const s = header(gb, m.GB, 'GB');
  const dno = regionsOf(s.id).find((r) => r.scheme === 'gb_dno');
  line(`  gb_dno ${dno.code} [${dno.origin}] was assigned from the Octopus GSP letter '${s.gsp_region}'; the same region is also ${aliasesOf({ scheme: 'gb_dno', code: dno.code }).map((a) => `${a.alias_scheme} '${a.alias_code}'`).join(', ')}.`);
  line(`Tariffs [synthetic]: SYN-GB-FLAT (flat, ${m.GB.flat.unit} p/kWh + ${m.GB.flat.standing} p/day ex VAT) on 25 Oct; SYN-GB-DAYNIGHT (day ${m.GB.e7.day} / night ${m.GB.e7.night} p,`);
  line(`  night 00:30–07:30 local, stored as register windows and expanded into rate rows) from 26 Oct; export SYN-GB-OUTGOING ${m.GB.export} p.`);
  line(`  Taxes [${taxOrigin('GB')}]: GB VAT from tax_rule (5 % before 1 Oct 2026; src/db/registry.js VAT_RATES).`);
  changeDays(s, m.GB);
  const rows = ledger(s, m.GB);
  const night = examples(rows, (r) => r.local_date === m.GB.change && reg(r) === 'night');
  const first = night[0]; const last = night[night.length - 1];
  line(`Off-peak example (${m.GB.change}, the 25-hour day): night runs ${hm(s.timezone, first.slot_start)} BST to ${hm(s.timezone, last.slot_start + 1800)} GMT = ${night.length} half-hours = ${night.length / 2} real hours`);
  line(`  (7 on the clock, plus the repeated hour). GB night rate ${first.import_rate_ex} p x ${1 + first.import_vat} = ${m.inc(first).toFixed(4)} p/kWh paid ${tagOf([first], 'GB').replace('synthetic data, ', '')} (${check(Math.abs(m.inc(first) - m.GB.e7.night * 1.05) < 1e-9 && night.length === 16, 'GB: night 8 real hours at 11.5 p x 1.05')}).`);
  const standing = m.dayRows(s.id, m.GB.change, m.GB.change)[0].standing_cost;
  line(`Standing charge on the 50-slot day adds up to ${standing.toFixed(6)} p = 55 p x 1.05 ${pricesTag('GB')} (${check(Math.abs(standing - 57.75) < 1e-9, 'GB: standing 57.75 p on a 25 h day')}).`);
  const { viaRules, viaVatRate } = m.gbBothPaths(s.id);
  const fa = m.fingerprint(viaRules.hhRows); const fb = m.fingerprint(viaVatRate.hhRows);
  const hash = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
  line('Golden path: the same builder run twice as a dry run, taxes from tax_rule vs the old vat_rate path [both sourced VAT]:');
  line(`  ${viaRules.hhRows.length} slots, fingerprints ${hash(fa)} vs ${hash(fb)} (golden-test rounding) -> ${check(fa === fb, 'GB: tax_rule path = vat_rate path, row for row')}. (test/golden-gb.test.js checks the`);
  line('  real home the same way and stays green.)');
  const lin = JSON.parse(first.lineage);
  line(`Slot lineage of that night slot: origin = ${lin.origin}, data_origin = ${lin.data_origin}, placeholder_inputs = ${JSON.stringify(lin.placeholder_inputs)}`);
  line(`  (${check(lin.origin === 'synthetic' && lin.data_origin === 'synthetic' && lin.placeholder_inputs.some((x) => /SYN-GB-DAYNIGHT/.test(x)) && !lin.placeholder_inputs.some((x) => /^tax_rule/.test(x)), 'GB: lineage names the synthetic tariff, VAT stays sourced')})`);
}

// ───────────── FR ─────────────
const frBefore = {};
{
  const { fr } = homes;
  const s = header(fr, m.FR, 'FR');
  line(`Tariffs [synthetic]: SYN-FR-HPHC 28–29 Mar (hp ${m.FR.hphc.hp} / hc ${m.FR.hphc.hc} c ex tax, subscription ${m.FR.hphc.subscription} c/month); the meter's own off-peak hours`);
  line(`  "${m.FR.hphc.meterHc}" (from the bill, synthetic here) replace the tariff's reference ${m.FR.hphc.referenceHc} for this home.`);
  line(`  SYN-FR-TEMPO 30–31 Mar (calendar_tou: blue/white/red days ${Object.entries(m.FR.tempo.colours).map(([d, c]) => `${d.slice(5)} ${c}`).join(', ')} [synthetic calendar]; subscription ${m.FR.tempo.subscription} c/month).`);
  line('  Taxes [placeholder, unverified]: accise 3.37 c/kWh, then TVA 20 % on price + accise and on the subscription.');
  changeDays(s, m.FR);
  const rows = ledger(s, m.FR);
  const hc29 = examples(rows, (r) => r.local_date === m.FR.change && reg(r) === 'hc');
  const hc28 = examples(rows, (r) => r.local_date === m.FR.from && reg(r) === 'hc');
  const want = (m.FR.hphc.hc + 3.37) * 1.2;
  line(`Off-peak example (HP/HC): ${hc28.length / 2} off-peak hours on 28 Mar; ${hc29.length / 2} on 29 Mar, when 02:00–03:00 does not exist (from ${hm(s.timezone, hc29[0].slot_start)}).`);
  line(`  FR hc ${m.FR.hphc.hc} c + accise 3.37 = ${hc29[0].import_rate_ex.toFixed(2)} c, x (1 + ${hc29[0].import_vat}) = ${m.inc(hc29[0]).toFixed(4)} c/kWh paid ${pricesTag('FR')} (${check(hc28.length === 16 && hc29.length === 14 && Math.abs(m.inc(hc29[0]) - want) < 1e-9, 'FR: 8 h / 7 h off-peak at (14.10 + 3.37) x 1.2')}).`);
  const red = examples(rows, (r) => r.local_date === '2026-03-31' && reg(r) === 'red_hp')[0];
  const night30 = examples(rows, (r) => r.local_date === '2026-03-30' && r.slot_start < dayBounds(s.timezone, '2026-03-30')[0] + 6 * 3600);
  line(`Tempo [synthetic calendar]: 30 Mar 00:00–06:00 is ${[...new Set(night30.map(reg))].join('/')} (the night belongs to the blue 29th, colours switch at 06:00); 31 Mar from 06:00 is red_hp:`);
  line(`  ${m.FR.tempo.prices.red_hp} c + 3.37 = ${red.import_rate_ex.toFixed(2)} c x 1.2 = ${m.inc(red).toFixed(4)} c/kWh paid ${pricesTag('FR')} (${check(night30.every((r) => reg(r) === 'blue_hc') && Math.abs(m.inc(red) - (64.7 + 3.37) * 1.2) < 1e-9, 'FR: Tempo colours and red price')}).`);
  const d29 = m.dayRows(s.id, m.FR.change, m.FR.change)[0].standing_cost;
  const [c0, c1] = dayBounds(s.timezone, m.FR.change);
  const exp29 = (fixedChargeMicro(m.FR.hphc.subscription, 'month', c0, c1, s.timezone) / 1e6) * 1.2;
  line(`Monthly subscription on the 23 h day: ${m.FR.hphc.subscription} c x 23 h / 743 h in March x 1.2 = ${exp29.toFixed(4)} c ${pricesTag('FR')} (built ${d29.toFixed(4)} c: ${check(Math.abs(d29 - exp29) < 1e-9, 'FR: subscription pro-rated by real seconds')}).`);
  line('  (A monthly charge is split in whole millionths of a cent so that every month adds up exactly.)');
  const lin = JSON.parse(hc29[0].lineage);
  line(`Slot lineage of that off-peak slot: origin = ${lin.origin}; not verified: ${lin.placeholder_inputs.join('; ')}`);
  line(`  (${check(lin.placeholder_inputs.includes('tax_rule FR/accise [placeholder]') && lin.placeholder_inputs.includes('tax_rule FR/tva [placeholder]'), 'FR: lineage names the placeholder accise and TVA')})`);
  // A tariff in pounds on a home billed in euros is refused by the database.
  const gbpTariff = createTariff({ provider: 'synthetic', tariffCode: 'SYN-FR-IN-GBP', country: 'FR', currency: 'GBP', structure: 'flat', kind: 'flat', origin: 'synthetic' });
  let refused = null;
  try { agreeTariff({ siteId: s.id, deviceId: fr.devices.imp.id, tariffId: gbpTariff.id, validFrom: dayBounds(s.timezone, '2026-04-01')[0] }); } catch (err) { refused = err.message; }
  line(`Currency guard: agreeing SYN-FR-IN-GBP (GBP) for this EUR home -> ${refused ? `refused: "${refused}"` : 'ACCEPTED'} (${check(/currency differs/.test(refused ?? ''), 'FR: GBP tariff refused on a EUR home')}).`);
  let refused2 = null;
  try { createSite({ name: 'FR home in pounds', market: 'FR', currency: 'GBP' }); } catch (err) { refused2 = err.message; }
  line(`  Creating a FR home billed in GBP -> ${refused2 ? `refused: "${refused2}"` : 'ACCEPTED'} (${check(!!refused2, 'FR: home in GBP refused')}).`);
  for (const d of m.dayRows(s.id, '2026-03-30', '2026-03-31')) frBefore[d.local_date] = d.standing_cost;
}

// ───────────── NL ─────────────
{
  const { nl } = homes;
  const s = header(nl, m.NL, 'NL');
  line(`Tariff [synthetic]: SYN-NL-DYNAMIC (spot_indexed, quarter-hour prices = synthetic day-ahead + ${m.NL.markup} c markup), ${m.NL.monthlyFee} c/month supply fee,`);
  line(`  ${m.NL.dailyNetwork} c/day network fee. Taxes [placeholder, unverified]: energiebelasting 10.154 c/kWh, heffingskorting -635.19 EUR/year (a`);
  line('  per-period credit, pro-rated per slot), then BTW 21 % on everything including the credit.');
  changeDays(s, m.NL);
  const fine = ledger(s, m.NL);
  const neg = fine.find((r) => r.slot_start === Date.parse(m.NL.negativeAt) / 1000);
  const energy = neg.total_cost - neg.standing_cost;
  line(`Negative price (26 Oct ${hm(s.timezone, neg.slot_start)}): spot -18.00 [synthetic] + 2.00 = -16.00 c, + energy tax 10.154 [placeholder] = ${neg.import_rate_ex.toFixed(3)} c, x 1.21 [placeholder] = ${m.inc(neg).toFixed(5)} c/kWh paid ${tagOf([neg], 'NL').replace('synthetic data, ', '')}.`);
  line(`  The battery charged from the grid: ${neg.grid_import.toFixed(3)} kWh imported [synthetic data], energy cost ${energy.toFixed(4)} c (${check(m.inc(neg) < 0 && energy < 0, 'NL: negative price gives a negative energy cost')}).`);
  const [a, b] = dayBounds(s.timezone, m.NL.change);
  const wantFixed = (fixedChargeMicro(m.NL.monthlyFee, 'month', a, b, s.timezone) / 1e6 + m.NL.dailyNetwork + -63519 * ((b - a) / (365 * 86400))) * 1.21;
  const gotFixed = m.dayRows(s.id, m.NL.change, m.NL.change)[0].standing_cost;
  line(`Fixed charges on the 25 h day: (599 x 25/745 + 120 - 63519 x 25/8760) x 1.21 = ${wantFixed.toFixed(4)} c ${pricesTag('NL')} (built ${gotFixed.toFixed(4)}: ${check(Math.abs(gotFixed - wantFixed) < 1e-9, 'NL: fixed charges and yearly credit per day')}).`);
  line('  Negative: the yearly credit (a placeholder value) is larger than the fixed fees, as on a low-use Dutch bill.');

  // Switch the slot length and rebuild through the real queue.
  line();
  line('Slot length switch, rebuilt through setSlotLength() + processQueue() (the same queue the sync uses) [synthetic data, synthetic prices, placeholder taxes]:');
  line(`${pad('slot_s', 8)}${lpad('slots 26 Oct', 13)}${lpad('import kWh', 12)}${lpad('home kWh', 11)}${lpad('fixed c', 11)}${lpad('cost c', 11)}${lpad('cost - cost@900', 17)}   rebuild`);
  const sumWin = (rows, k) => rows.reduce((x, r) => x + (r[k] || 0), 0);
  const show = (slotS, rows, note) => line(`${pad(slotS, 8)}${lpad(rows.filter((r) => r.local_date === m.NL.change).length, 13)}${lpad(sumWin(rows, 'grid_import').toFixed(6), 12)}${lpad(sumWin(rows, 'home').toFixed(6), 11)}${lpad(sumWin(rows, 'standing_cost').toFixed(4), 11)}${lpad(sumWin(rows, 'total_cost').toFixed(4), 11)}${lpad((sumWin(rows, 'total_cost') - sumWin(fine, 'total_cost')).toFixed(4), 17)}   ${note}`);
  show(900, fine, 'initial build');
  let energyOk = true; let fixedOk = true; let weightedOk = true; let maxDev = 0; let rangeOk = true;
  for (const slotS of [1800, 3600]) {
    const t1 = Date.now();
    setSlotLength(s.id, slotS);
    const r = processQueue().find((x) => x.siteId === s.id);
    rangeOk &&= r.days === 3 && r.from === m.NL.from && r.to === m.NL.to;
    const coarse = m.hhRows(s.id, m.NL.from, m.NL.to);
    show(slotS, coarse, `${r.days} days from ${r.from} to ${r.to} in ${Date.now() - t1} ms`);
    const A = m.perDay(fine, [...m.ENERGY, 'standing_cost']); const B = m.perDay(coarse, [...m.ENERGY, 'standing_cost']);
    for (const [d, x] of A) for (const k of Object.keys(x)) {
      if (k === 'standing_cost') fixedOk &&= Math.abs(B.get(d)[k] - x[k]) < 1e-6;
      else energyOk &&= Math.abs(B.get(d)[k] - x[k]) < 1e-9;
    }
    const expect = m.expectedCoarseCost(fine, slotS, (t) => t - (t % slotS));
    for (const c of coarse) { const dev = Math.abs(c.total_cost - expect.get(c.slot_start)); maxDev = Math.max(maxDev, dev); weightedOk &&= dev < 1e-9; }
  }
  line(`Energy per day identical at 15, 30 and 60 minutes (${check(energyOk, 'NL: kWh per day equal at 900/1800/3600')}); fixed charges per day identical (${check(fixedOk, 'NL: fixed charges per day equal')}).`);
  line(`Only the 3 days with data are rebuilt, not every day from the first one to today (${check(rangeOk, 'NL: slot change rebuilds only the days with data')}).`);
  line('Cost is consistent, not identical: a longer slot pays the TIME-WEIGHTED mean of its quarter-hour prices on the slot\'s whole');
  line('import, so cost moves wherever price and import both vary inside a slot: here the synthetic quarter-hour price ripple');
  line('every day, and most of all the negative-price hour on 26 Oct.');
  line(`  Every 30 and 60-minute slot = its import x mean of its quarter-hour prices + fixed charges, max deviation ${maxDev.toExponential(1)} c (${check(weightedOk, 'NL: coarse slots priced at the time-weighted mean')}).`);
}

// ───────────── Capacity charge (FR home) ─────────────
{
  const { fr } = homes;
  const s = m.siteRow(fr.site.id);
  rule('Capacity charge · Synthetic FR home [synthetic capacity price, synthetic contracted capacity, placeholder TVA]');
  const price = 95;   // c per kVA per month, ex tax: SYNTHETIC
  const [b] = dayBounds(s.timezone, '2026-03-30'); const [, c] = dayBounds(s.timezone, '2026-03-31');
  putRateRows(fr.tariffs.tempo.id, [{ component: 'capacity', chargePeriod: 'month', validFrom: b, validTo: c, price }]);
  line(`SYN-FR-TEMPO gets a capacity charge of ${price} c per kVA per month ex tax [synthetic] on 30–31 Mar.`);
  const dry = buildSite(s.id, '2026-03-30', '2026-03-31', { dryRun: true });
  const warned = dry.checks.filter((x) => x[1] === 'capacity_charge' && x[2] === 'warn').length;
  const unchanged = dry.dayRows.every((d) => Math.abs(d.standing_cost - frBefore[d.local_date]) < 1e-9);
  line(`  Without a contracted capacity the charge cannot be priced: ${warned} day checks warn 'capacity_charge' and the fixed charges stay as they were (${check(warned === 2 && unchanged, 'capacity: unknown contracted capacity is flagged, not guessed')}).`);
  setContractedCapacity(s.id, 6, { origin: 'synthetic', note: 'demo: puissance souscrite 6 kVA (generated)' });
  const r = processQueue().find((x) => x.siteId === s.id);
  line(`  Contracted capacity set to 6 kVA [synthetic]; the queue rebuilt ${r.days} days (${r.from} to ${r.to}).`);
  let ok = true;
  for (const d of m.dayRows(s.id, '2026-03-30', '2026-03-31')) {
    const [d0, d1] = dayBounds(s.timezone, d.local_date);
    const add = (fixedChargeMicro(price * 6, 'month', d0, d1, s.timezone) / 1e6) * 1.2;
    ok &&= Math.abs(d.standing_cost - frBefore[d.local_date] - add) < 1e-9;
    line(`  ${d.local_date}: fixed charges ${frBefore[d.local_date].toFixed(4)} -> ${d.standing_cost.toFixed(4)} c = + ${price} c x 6 kVA x 24 h / 743 h x 1.2 (${add.toFixed(4)} c) ${pricesTag('FR')}`);
  }
  line(`  (${check(ok, 'capacity: priced per kVA, pro-rated by real seconds, taxed')})`);
  const lin = JSON.parse(m.hhRows(s.id, '2026-03-31', '2026-03-31')[0].lineage);
  line(`  Lineage names the contracted capacity: ${lin.placeholder_inputs.filter((x) => /capacity/.test(x)).join('; ')}`);
}

// ───────────── Estimated Tempo days ─────────────
{
  const { fr } = homes;
  const s = m.siteRow(fr.site.id);
  rule('Estimated Tempo days · SYN-FR-TEMPO [synthetic calendar, synthetic prices]');
  // 1 and 2 April: no colour published yet. The caller's cautious default is the dearest colour.
  const est = storeWindows(fr.tariffs.tempo.id, { registerPrices: m.FR.tempo.prices, tz: s.timezone, fromDate: '2026-04-01', toDate: '2026-04-02', estimate: { dayType: 'red' } });
  const nEst = db.prepare('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND estimated = 1 AND superseded_at IS NULL').get(fr.tariffs.tempo.id).n;
  line(`No colour is known for 1–2 Apr: the windows stored in register_window are expanded with the caller's cautious default (red):`);
  line(`  ${est.filter((x) => x.estimated).length} intervals, priced ${[...new Set(est.filter((x) => x.estimated).map((x) => `${x.register} ${x.price} c`))].join(', ')}, stored as ${nEst} rate rows marked estimated (${check(nEst > 0 && est.some((x) => x.estimated && x.dayType === 'red'), 'Tempo: unknown day priced with the cautious default, marked estimated')}).`);
  storeWindows(fr.tariffs.tempo.id, { registerPrices: m.FR.tempo.prices, tz: s.timezone, fromDate: '2026-04-01', toDate: '2026-04-01', calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-04-01': 'blue' } }, estimate: { dayType: 'red' } });
  const left = db.prepare("SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND estimated = 1 AND superseded_at IS NULL AND valid_from < ?").get(fr.tariffs.tempo.id, dayBounds(s.timezone, '2026-04-02')[0]).n;
  const blue = db.prepare("SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND register LIKE 'blue_%' AND estimated = 0 AND superseded_at IS NULL AND valid_from >= ?").get(fr.tariffs.tempo.id, dayBounds(s.timezone, '2026-04-01')[0]).n;
  line(`Then 1 Apr is published blue [synthetic]: its estimated rows are superseded (kept, not deleted) and replaced by ${blue} blue rows; ${left} estimated rows left before 2 Apr (${check(left === 0 && blue > 0, 'Tempo: the real colour replaces the estimate')}).`);
  line('  A built slot priced from an estimated row is flagged estimated (quality bit 8, lineage estimated: true; test/register-window.test.js).');
}

// ───────────── Provenance table ─────────────
rule('Inputs and their origins');
const inputs = [
  ...db.prepare('SELECT tariff_code AS what, origin, origin_note AS note FROM tariff ORDER BY tariff_code').all().map((r) => ({ ...r, what: `tariff ${r.what}` })),
  ...db.prepare(`SELECT t.tariff_code AS code, r.component, r.origin, COUNT(*) AS n, SUM(r.estimated) AS est FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
      GROUP BY 1, 2, 3 ORDER BY 1, 2`).all().map((r) => ({ what: `rates ${r.code} ${r.component} (${r.n} rows${r.est ? `, ${r.est} estimated` : ''})`, origin: r.origin, note: 'scripts/lib/multi-market.js and this script' })),
  ...db.prepare('SELECT country, code, origin, origin_note AS note FROM tax_rule WHERE superseded_at IS NULL GROUP BY country, code, origin ORDER BY country, code').all().map((r) => ({ what: `tax_rule ${r.country}/${r.code}`, origin: r.origin, note: r.note })),
  ...db.prepare("SELECT code, origin, origin_note AS note FROM market WHERE code IN ('GB', 'FR', 'NL') ORDER BY code").all().map((r) => ({ what: `market ${r.code}`, origin: r.origin, note: r.note })),
  ...[...new Map([homes.gb, homes.fr, homes.nl].flatMap((h) => regionsOf(h.site.id)).map((r) => [`${r.scheme}/${r.code}`, r])).values()].map((r) => ({ what: `region ${r.scheme} ${r.code}`, origin: r.origin, note: r.origin_note })),
  ...db.prepare('SELECT code, origin, origin_note AS note FROM calendar').all().map((r) => ({ what: `calendar ${r.code} (${db.prepare('SELECT COUNT(*) n FROM calendar_day WHERE calendar = ? AND superseded_at IS NULL').get(r.code).n} days)`, origin: r.origin, note: r.note })),
  ...db.prepare('SELECT DISTINCT origin, origin_note AS note FROM register_window').all().map((r) => ({ what: 'register windows (HP/HC, Tempo, day/night)', origin: r.origin, note: r.note })),
  ...demoSites.map((s) => ({ what: `energy data ${s.name}`, origin: s.is_demo ? 'synthetic' : 'provider', note: 'is_demo = 1: inverter samples and meter readings generated (seeded)' })),
  ...db.prepare('SELECT name, contracted_kva, contracted_kva_origin AS origin, contracted_kva_note AS note FROM site WHERE contracted_kva IS NOT NULL').all().map((r) => ({ what: `contracted capacity ${r.name} ${r.contracted_kva} kVA`, origin: r.origin, note: r.note })),
];
line(`${pad('Input', 58)}${pad('Origin', 13)}Source / note`);
for (const i of inputs) line(`${pad(i.what, 58)}${pad(i.origin ?? 'NOT RECORDED', 13)}${i.note ?? ''}`);
line(`(${check(inputs.every((i) => ORIGINS.includes(i.origin)), 'provenance: every input of the demo has an origin')})`);

rule('Summary');
const failed = results.filter((r) => !r.ok);
for (const r of results) line(`${r.ok ? 'PASS' : 'FAIL'}  ${r.what}`);
line();
line(`${results.length - failed.length} of ${results.length} checks passed.`);
line('Nothing in this demo is real market data. FR/NL tax values are placeholders.');
db.close();
process.exitCode = failed.length ? 1 : 0;
