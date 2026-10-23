// Three SYNTHETIC homes in three markets, built by the real engine: shared by
// scripts/demo-multi-market.js (prints them) and test/multi-market.test.js (asserts them).
//
// Everything here is made up and deterministic (seeded): inverter samples, meter readings,
// tariffs and prices. Only the shapes are real: half-hour or quarter-hour meters, French HP/HC
// with the meter's own off-peak hours and Tempo colours, a Dutch quarter-hour spot-indexed
// price with a negative quarter, GB flat and day/night. The FR and NL taxes are the
// PLACEHOLDER rules of src/core/tax.js, marked unverified: not real rates.
//
// Import this module only after DB_FILE points at a throwaway database (db.js opens it on
// import). It writes homes, devices, tariffs, rates, tax rules and facts into that database.
//
// The build engine reads inverter samples from the 'sunsynk_5min' series and meter readings
// from the 'octopus_meter' series (the only inputs it knows today), so the synthetic values are
// written there; their devices say provider 'synthetic'.
//
// Provenance (src/core/provenance.js): every home is created is_demo = 1 (its energy data is
// 'synthetic'); every tariff, rate row, register window and Tempo calendar day written here is
// 'synthetic'; the FR and NL tax rows are 'placeholder' (src/core/tax.js PLACEHOLDER_TAX_RULES).
// GB VAT is the database's own 'sourced' rule (registry.js VAT_RATES), not written here.
import { db } from '../../src/db/db.js';
import { createSite, assignRegion } from '../../src/core/sites.js';
import { createTariff, putRateRows, storeWindows, agreeTariff, addDevice } from '../../src/core/tariffs.js';
import { seriesId, putReadings, putIntervals } from '../../src/core/facts.js';
import { buildSite } from '../../src/core/build.js';
import { PLACEHOLDER_TAX_RULES } from '../../src/core/tax.js';
import { parseRanges } from '../../src/core/tariff-expand.js';
import { dayBounds, addDays, zonedParts, localDate } from '../../src/core/time.js';

export const H = 3600;

// ───────────── Seeded randomness ─────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ───────────── Synthetic home behaviour ─────────────
// 5-minute samples over local days fromDate..toDate: solar on a bell curve with passing cloud,
// a house with morning and evening peaks, a 40 W inverter standby loss, and a battery that stores
// spare solar, covers shortfalls, and charges from the grid when gridCharge(ts) says so
// (cheap or negative prices). Grid = whatever is left. Every sample balances exactly:
// solar + import + discharge = load + loss + export + charge.
export function synthesise({ tz, fromDate, toDate, seed, pvPeakW, batteryKwh, sunrise = 7, sunset = 18.5, gridCharge = () => 0 }) {
  const rand = rng(seed);
  const [t0] = dayBounds(tz, fromDate);
  const [, t1] = dayBounds(tz, toDate);
  const cap = batteryKwh; const eff = 0.95; const lossW = 40;
  let soc = 0.5 * cap;
  let cloud = 0.8;
  const out = [];
  for (let ts = t0; ts < t1; ts += 300) {
    const { hh, mm } = zonedParts(tz, ts);
    const h = hh + mm / 60;
    cloud = Math.min(1, Math.max(0.35, cloud + (rand() - 0.5) * 0.08));
    const solar = h > sunrise && h < sunset ? Math.round(pvPeakW * Math.sin((Math.PI * (h - sunrise)) / (sunset - sunrise)) ** 1.5 * cloud) : 0;
    let load = 260 + 60 * rand() + (h >= 7 && h < 9 ? 650 : 0) + (h >= 12 && h < 13 ? 300 : 0) + (h >= 17 && h < 21.5 ? 1100 : 0);
    if (rand() < 0.03) load += 2000;   // a kettle
    load = Math.round(load);
    const room = Math.max(0, 0.95 * cap - soc); const avail = Math.max(0, soc - 0.1 * cap);
    const toW = (kwh) => (kwh * 3.6e6) / 300;   // kWh in 5 minutes as W
    let chg = 0; let dis = 0;
    const forced = gridCharge(ts);
    if (forced > 0) chg = Math.min(forced, toW(room / eff));
    else if (solar > load + lossW) chg = Math.min(solar - load - lossW, 2500, toW(room / eff));
    else dis = Math.min(load + lossW - solar, 2500, toW(avail));
    chg = Math.round(chg); dis = Math.round(dis);
    soc += ((chg * eff - dis) * 300) / 3.6e6;
    const net = load + lossW + chg - solar - dis;
    out.push({ ts, solar, load, imp: Math.max(0, net), exp: Math.max(0, -net), chg, dis, socPct: Math.round((soc / cap) * 1000) / 10 });
  }
  return out;
}

// Inverter samples into the 5-minute series; meter readings (kWh to 0.001, as meters report)
// into intervals of meterS seconds on the home's local grid.
function storeFacts(siteId, samples, meters, meterS) {
  const s = (metric) => seriesId('site', siteId, metric, 'sunsynk_5min');
  const series = { solar: 'solar_w', load: 'load_w', imp: 'grid_import_w', exp: 'grid_export_w', chg: 'battery_charge_w', dis: 'battery_discharge_w', socPct: 'battery_soc_pct' };
  for (const [k, metric] of Object.entries(series)) putReadings(s(metric), samples.map((x) => ({ ts: x.ts, value: x[k] })));
  for (const [key, dev, metric] of [['imp', meters.import, 'grid_import_kwh'], ['exp', meters.export, 'grid_export_kwh']]) {
    if (!dev) continue;
    const buckets = new Map();
    for (const x of samples) { const b = x.ts - (x.ts % meterS); buckets.set(b, (buckets.get(b) || 0) + (x[key] * 300) / 3.6e6); }
    putIntervals(seriesId('device', dev.id, metric, 'octopus_meter'), [...buckets].map(([start, kwh]) => ({ start, end: start + meterS, value: Math.round(kwh * 1000) / 1000 })));
  }
}

const startOf = (tz, d) => dayBounds(tz, d)[0];

// ───────────── The three homes ─────────────
// Synthetic prices, minor units ex tax (pence for GB, cents for FR and NL).
export const GB = {
  tz: 'Europe/London', from: '2025-10-25', to: '2025-10-27', change: '2025-10-26',
  flat: { unit: 24.5, standing: 60 }, e7: { day: 28, night: 11.5, standing: 55, nightWindow: [30, 450] }, export: 15,
};
export const FR = {
  tz: 'Europe/Paris', from: '2026-03-28', to: '2026-03-31', change: '2026-03-29',
  hphc: { hp: 18.4, hc: 14.1, subscription: 1523, referenceHc: '22:00-06:00', meterHc: 'HC (02H00-07H00 ; 13H00-16H00)' },
  tempo: {
    prices: { blue_hc: 12.3, blue_hp: 14.9, white_hc: 13.9, white_hp: 17.3, red_hc: 14.6, red_hp: 64.7 }, subscription: 1560,
    colours: { '2026-03-29': 'blue', '2026-03-30': 'white', '2026-03-31': 'red' },
  },
};
export const NL = {
  tz: 'Europe/Amsterdam', from: '2025-10-25', to: '2025-10-27', change: '2025-10-26',
  markup: 2.0, monthlyFee: 599, dailyNetwork: 120, negativeAt: '2025-10-26T12:00:00Z',   // 13:00 local: the most negative quarter
};

// Dutch day-ahead quarter-hours, synthetic: night 8 c, morning 14, midday low (negative on the
// 26th, down to −18 c at 13:00), evening peak 22, and a ripple between quarters of an hour.
export function nlSpot(ts) {
  const { hh, mm } = zonedParts(NL.tz, ts);
  const q = mm / 15;
  const base = hh < 6 ? 8 : hh < 9 ? 14 : hh < 12 ? 9 : hh < 15 ? 4 : hh < 17 ? 10 : hh < 21 ? 22 : 12;
  let p = base + [0.6, -0.4, 1.1, -0.9][q];
  if (localDate(NL.tz, ts) === NL.change && hh >= 12 && hh < 15) p = [[-1, -6, -11, -15], [-18, -9, -4, -2], [1, 2, 3, 3.5]][hh - 12][q];
  return Math.round(p * 100) / 100;
}

const TEMPO_WINDOWS = ['blue', 'white', 'red'].flatMap((c) => [
  { register: `${c}_hp`, calendar: 'fr_tempo', day_type: c, start_min: 360, end_min: 1320 },
  { register: `${c}_hc`, calendar: 'fr_tempo', day_type: c, start_min: 1320, end_min: 360 },
]);

export const SYNTHETIC = { origin: 'synthetic', originNote: 'generated by scripts/lib/multi-market.js (seeded, deterministic): not real market data' };

function placeholderRules(country) {
  const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'placeholder', ?)`);
  for (const r of PLACEHOLDER_TAX_RULES.filter((x) => x.country === country)) {
    ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.currency, r.charge_period, r.seq, r.valid_from, r.valid_to, r.source, r.origin_note);
  }
}

function gbHome() {
  const site = createSite({ name: 'Synthetic GB home', market: 'GB', postcode: 'M1 1AE', gspRegion: 'G', pvKwp: 4, batteryKwh: 9.5, isDemo: true });
  assignRegion(site.id, { alias: { scheme: 'octopus_gsp', code: 'G' }, source: 'installer' });
  assignRegion(site.id, { scheme: 'bzn', code: 'GB', source: 'market' });
  const imp = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: 'SYN-GB-IMPORT', label: 'Import meter (synthetic)' });
  const exp = addDevice({ siteId: site.id, kind: 'meter_export', provider: 'synthetic', externalRef: 'SYN-GB-EXPORT', label: 'Export meter (synthetic)' });
  const [a, b, c] = [startOf(GB.tz, GB.from), startOf(GB.tz, GB.change), startOf(GB.tz, addDays(GB.to, 1))];
  const base = { provider: 'synthetic', country: 'GB', currency: 'GBP', ...SYNTHETIC };
  const flat = createTariff({ ...base, tariffCode: 'SYN-GB-FLAT', structure: 'flat', kind: 'flat', name: 'Synthetic flat' });
  putRateRows(flat.id, [{ component: 'unit', validFrom: a, validTo: c, price: GB.flat.unit }, { component: 'standing', validFrom: a, validTo: c, price: GB.flat.standing }]);
  const e7 = createTariff({ ...base, tariffCode: 'SYN-GB-DAYNIGHT', structure: 'windows', kind: 'tou', name: 'Synthetic day/night (night 00:30-07:30)' });
  storeWindows(e7.id, { windows: [{ register: 'night', start_min: GB.e7.nightWindow[0], end_min: GB.e7.nightWindow[1] }], registerPrices: { day: GB.e7.day, night: GB.e7.night },
    defaultRegister: 'day', tz: GB.tz, fromDate: GB.change, toDate: GB.to });
  putRateRows(e7.id, [{ component: 'standing', validFrom: a, validTo: c, price: GB.e7.standing }]);
  const out = createTariff({ ...base, tariffCode: 'SYN-GB-OUTGOING', direction: 'export', structure: 'export', kind: 'flat', name: 'Synthetic fixed export' });
  putRateRows(out.id, [{ component: 'unit', validFrom: a, validTo: c, price: GB.export }]);
  agreeTariff({ siteId: site.id, deviceId: imp.id, tariffId: flat.id, validFrom: a, validTo: b });
  agreeTariff({ siteId: site.id, deviceId: imp.id, tariffId: e7.id, validFrom: b, validTo: c });
  agreeTariff({ siteId: site.id, deviceId: exp.id, tariffId: out.id, validFrom: a, validTo: c });
  const samples = synthesise({ tz: GB.tz, fromDate: GB.from, toDate: GB.to, seed: 11, pvPeakW: 2600, batteryKwh: 9.5, sunrise: 7.5, sunset: 17.5,
    gridCharge: (ts) => { const { hh, mm } = zonedParts(GB.tz, ts); const m = hh * 60 + mm; return ts >= b && m >= 60 && m < 300 ? 2500 : 0; } });
  storeFacts(site.id, samples, { import: imp, export: exp }, 1800);
  return { site, tariffs: { flat, e7, out }, devices: { imp, exp } };
}

export function frHome() {
  placeholderRules('FR');
  const site = createSite({ name: 'Synthetic FR home', market: 'FR', postcode: '69001', pvKwp: 6, batteryKwh: 10, isDemo: true });
  assignRegion(site.id, { scheme: 'bzn', code: 'FR', source: 'market' });
  const imp = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: 'SYN-FR-PDL', label: 'Linky meter (synthetic)' });
  const [a, b, c] = [startOf(FR.tz, FR.from), startOf(FR.tz, addDays(FR.change, 1)), startOf(FR.tz, addDays(FR.to, 1))];
  const base = { provider: 'synthetic', country: 'FR', currency: 'EUR', ...SYNTHETIC };
  const hphc = createTariff({ ...base, tariffCode: 'SYN-FR-HPHC', structure: 'windows', kind: 'tou', name: 'Synthetic Heures Pleines / Heures Creuses' });
  const prices = { hp: FR.hphc.hp, hc: FR.hphc.hc };
  const reference = parseRanges(FR.hphc.referenceHc).map((r) => ({ ...r, register: 'hc' }));
  const own = parseRanges(FR.hphc.meterHc).map((r) => ({ ...r, register: 'hc', device_id: imp.id, source_text: FR.hphc.meterHc }));
  // The tariff's reference hours for everyone, and this meter's own 8 hours (from the bill) for this home.
  storeWindows(hphc.id, { windows: reference, registerPrices: prices, defaultRegister: 'hp', tz: FR.tz, fromDate: FR.from, toDate: FR.change });
  storeWindows(hphc.id, { windows: [...reference, ...own], registerPrices: prices, defaultRegister: 'hp', deviceId: imp.id, siteId: site.id, tz: FR.tz, fromDate: FR.from, toDate: FR.change });
  putRateRows(hphc.id, [{ component: 'fixed', chargePeriod: 'month', validFrom: a, validTo: b, price: FR.hphc.subscription }]);
  const tempo = createTariff({ ...base, tariffCode: 'SYN-FR-TEMPO', structure: 'windows', kind: 'calendar_tou', name: 'Synthetic Tempo' });
  storeWindows(tempo.id, { windows: TEMPO_WINDOWS, registerPrices: FR.tempo.prices, tz: FR.tz, fromDate: addDays(FR.change, 1), toDate: FR.to,
    calendar: { code: 'fr_tempo', dayStartMin: 360, days: FR.tempo.colours } });
  putRateRows(tempo.id, [{ component: 'fixed', chargePeriod: 'month', validFrom: b, validTo: c, price: FR.tempo.subscription }]);
  agreeTariff({ siteId: site.id, deviceId: imp.id, tariffId: hphc.id, validFrom: a, validTo: b });
  agreeTariff({ siteId: site.id, deviceId: imp.id, tariffId: tempo.id, validFrom: b, validTo: c });
  // The battery charges from the grid in the meter's night off-peak hours (02:00-07:00) on HP/HC.
  const samples = synthesise({ tz: FR.tz, fromDate: FR.from, toDate: FR.to, seed: 22, pvPeakW: 4200, batteryKwh: 10, sunrise: 7.3, sunset: 19.6,
    gridCharge: (ts) => { const { hh } = zonedParts(FR.tz, ts); return ts < b && hh >= 2 && hh < 5 ? 2000 : 0; } });
  storeFacts(site.id, samples, { import: imp }, 1800);
  return { site, tariffs: { hphc, tempo }, devices: { imp } };
}

export function nlHome() {
  placeholderRules('NL');
  const site = createSite({ name: 'Synthetic NL home', market: 'NL', postcode: '3511', pvKwp: 5, batteryKwh: 10, isDemo: true });
  assignRegion(site.id, { scheme: 'bzn', code: 'NL', source: 'market' });
  const imp = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: 'SYN-NL-EAN', label: 'Smart meter, quarter-hours (synthetic)' });
  const [a, c] = [startOf(NL.tz, NL.from), startOf(NL.tz, addDays(NL.to, 1))];
  const dyn = createTariff({ provider: 'synthetic', country: 'NL', currency: 'EUR', tariffCode: 'SYN-NL-DYNAMIC', structure: 'dynamic', kind: 'spot_indexed', nativePeriodS: 900,
    name: 'Synthetic dynamic (day-ahead + markup)', ...SYNTHETIC });
  const rows = [];
  for (let t = a; t < c; t += 900) rows.push({ component: 'unit', validFrom: t, validTo: t + 900, price: Math.round((nlSpot(t) + NL.markup) * 100) / 100 });
  rows.push({ component: 'fixed', register: 'supply', chargePeriod: 'month', validFrom: a, validTo: c, price: NL.monthlyFee });
  rows.push({ component: 'fixed', register: 'network', chargePeriod: 'day', validFrom: a, validTo: c, price: NL.dailyNetwork });
  putRateRows(dyn.id, rows);
  agreeTariff({ siteId: site.id, deviceId: imp.id, tariffId: dyn.id, validFrom: a, validTo: c });
  // The battery soaks up the grid when the price is negative.
  const samples = synthesise({ tz: NL.tz, fromDate: NL.from, toDate: NL.to, seed: 33, pvPeakW: 2800, batteryKwh: 10, sunrise: 8, sunset: 17.8,
    gridCharge: (ts) => (nlSpot(ts) + NL.markup < 0 ? 5000 : 0) });
  storeFacts(site.id, samples, { import: imp }, 900);
  return { site, tariffs: { dyn }, devices: { imp } };
}

// Create the three homes and build each over its days with the production engine.
export function buildScenario() {
  const homes = { gb: gbHome(), fr: frHome(), nl: nlHome() };
  for (const [h, w] of [[homes.gb, GB], [homes.fr, FR], [homes.nl, NL]]) buildSite(h.site.id, w.from, w.to, { reason: 'synthetic demo' });
  return homes;
}

// ───────────── Reading results back ─────────────
export const hhRows = (siteId, from, to) => db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY slot_start').all(siteId, from, to);
export const dayRows = (siteId, from, to) => db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date').all(siteId, from, to);
export const siteRow = (id) => db.prepare('SELECT * FROM site WHERE id = ?').get(id);
export const inc = (r) => (r.import_rate_ex == null ? null : r.import_rate_ex * (1 + r.import_vat));
export const ENERGY = ['solar', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'home'];

// Per-day sums of the given fields over a home's built days.
export function perDay(rows, keys) {
  const out = new Map();
  for (const r of rows) {
    const d = out.get(r.local_date) || out.set(r.local_date, Object.fromEntries(keys.map((k) => [k, 0]))).get(r.local_date);
    for (const k of keys) d[k] += r[k] || 0;
  }
  return out;
}

// What a coarser slot must cost from the quarter-hours it is made of: its import x the
// time-weighted mean of their prices (the price is linear, so mean of prices incl. tax), plus
// the fixed charges. Returns Map slot_start -> expected total_cost.
export function expectedCoarseCost(fineRows, coarseS, phaseOf) {
  const groups = new Map();
  for (const r of fineRows) {
    const k = phaseOf(r.slot_start);
    const g = groups.get(k) || groups.set(k, { imp: 0, price: 0, n: 0, fixed: 0 }).get(k);
    g.imp += r.grid_import; g.price += inc(r); g.n++; g.fixed += r.standing_cost;
  }
  return new Map([...groups].map(([k, g]) => [k, (g.imp * g.price) / g.n + g.fixed]));
}

// The golden test's fingerprint of a dry-run build (same rounding and volatile columns).
export function fingerprint(rows) {
  const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
  const volatile = new Set(['built_at', 'lineage', 'dur_s', 'tod_min']);
  return JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.has(k)).map(([k, v]) => [k, round(v)]))));
}

// The GB home built twice as a dry run: taxes from tax_rule (as production now runs), and with
// the GB tax rules hidden inside a transaction that is rolled back, so pricing falls back to the
// old vat_rate path. Same builder both times.
export function gbBothPaths(siteId) {
  const viaRules = buildSite(siteId, GB.from, GB.to, { dryRun: true });
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE tax_rule SET superseded_at = ? WHERE country = 'GB' AND superseded_at IS NULL").run(Date.now());
    const viaVatRate = buildSite(siteId, GB.from, GB.to, { dryRun: true });
    return { viaRules, viaVatRate };
  } finally {
    db.exec('ROLLBACK');
  }
}
