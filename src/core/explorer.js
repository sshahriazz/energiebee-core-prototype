// The Data Explorer (GET /api/explorer/*, src/routes/explorer.js): read-only views over every layer
// of the core, from the raw payloads a provider sent, through the bitemporal facts, to the slot
// timeline, with validation against the sources and correlations between any two variables.
//
//   overview    what a home holds: date range, sources, raw payloads, timeline states, check results
//   raw         raw payloads (keyset pages) and one payload: its body, the facts it produced (forward
//               lineage) and a re-run of the adapter's PURE normaliser against them (rederive)
//   series      the home's series with counts; facts: one series' points, as known at any moment
//   timeline    site_hh columns with units and kinds, and the site_day rows
//   slot        the calculation trace of one slot (src/core/explain.js)
//   validate    stored data against its source, per slot or per day (see VALIDATION below)
//   correlate   two variables (timeline columns or series:<id>) on one step, with lag and groups
//   heatmap     one variable by local date and time of day; variables: the catalogue of both
//
// Nothing here writes. Series are looked up, never created (facts.js seriesId would create one).
// Every read is bounded by the request (dates, a limit, an id); the indexes each uses are listed in
// docs/what-it-does.md ("API: Data Explorer").
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from '../db/db.js';
import { QUALITY } from './facts.js';
import { explainSlot, traceSlot, compareRows, ExplainError, pricePieces, localTime, findSeries, minorOf, dayWords, slotWords, pctWords } from './explain.js';
import { series as plannerSeries } from './planner-read.js';
import { loadPricing, priceAt, fixedPerDay } from './pricing.js';
import { buildSite } from './build.js';
import { nowSec, localDate, addDays, dayBounds, daysBetween, slotLength, slotNoun, slotLabel, zonedParts, todMinute, floorTo, parseIso, slotFloor } from './time.js';
import { mapRecords } from '../adapters/tariffscanner.js';
import { mapPrices, mapComponents } from '../adapters/tounify.js';

const bad = (msg) => new ExplainError(msg, 400);
const notFound = (msg) => new ExplainError(msg, 404);
const base = (site) => ({ site: site?.id ?? null, generated_at: nowSec() });

// ───────────── Parameters ─────────────

const one = (v, name) => { if (Array.isArray(v) || (v != null && typeof v === 'object')) throw bad(`${name} must be given once`); return v == null || v === '' ? null : String(v); };
function intParam(q, name, { def = null, min = -Infinity, max = Infinity, required = false } = {}) {
  const v = one(q[name], name);
  if (v == null) { if (required) throw bad(`${name} is required`); return def; }
  if (!/^-?\d+$/.test(v)) throw bad(`${name} must be a whole number, not ${v}`);
  const n = Number(v);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}
function enumParam(q, name, values, def) {
  const v = one(q[name], name);
  if (v == null) return def;
  if (!values.includes(v)) throw bad(`${name} must be one of ${values.join(', ')}`);
  return v;
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function dateParam(q, name, def = null) {
  const v = one(q[name], name);
  if (v == null) return def;
  if (!isDate(v)) throw bad(`${name} must be a date YYYY-MM-DD`);
  return v;
}
// Epoch seconds, or a local date (its start; for `end`, the start of the next day).
function timeParam(q, name, tz, { end = false } = {}) {
  const v = one(q[name], name);
  if (v == null) return null;
  if (/^\d+$/.test(v)) return Number(v);
  if (isDate(v)) return dayBounds(tz, v)[end ? 1 : 0];
  throw bad(`${name} must be epoch seconds or a date YYYY-MM-DD`);
}
function siteParam(q, { required = true } = {}) {
  const v = one(q.site, 'site');
  if (v == null) { if (required) throw bad('site is required (the home id)'); return null; }
  if (!/^\d+$/.test(v)) throw bad('site must be a home id');
  const s = db.prepare('SELECT * FROM site WHERE id = ?').get(Number(v));
  if (!s) throw notFound(`no home ${v}`);
  return s;
}
const asOfParam = (q) => intParam(q, 'as_of_ms', { min: 1e11, max: 1e14 });
// A range of local dates; defaults to the last `days` days the home has built.
function dateRange(site, q, { days = 7, maxDays = 400 } = {}) {
  const last = db.prepare('SELECT MAX(local_date) AS d FROM site_day WHERE site_id = ?').get(site.id)?.d ?? localDate(site.timezone, nowSec());
  const to = dateParam(q, 'to', null) ?? (q.from ? addDays(dateParam(q, 'from'), days - 1) : last);
  const from = dateParam(q, 'from', null) ?? addDays(to, -(days - 1));
  if (from > to) throw bad('from must not be after to');
  if (daysBetween(from, to).length > maxDays) throw bad(`at most ${maxDays} days at once`);
  return { from, to };
}

// ───────────── Variables: timeline columns ─────────────

const E = (label) => ({ unit: 'kWh', kind: 'energy', agg: 'sum', label });
const M = (label) => ({ unit: 'minor', kind: 'money', agg: 'sum', label });
const PRICE = (label, sql) => ({ unit: 'minor/kWh', kind: 'price', agg: 'mean', label, ...(sql ? { sql } : {}) });
// site_hh columns a chart or a correlation can use: unit, kind (energy | money | price | percent |
// temp | flag | carbon), how a longer step aggregates them (sum | mean | last) and a label.
export const TIMELINE_VARS = Object.freeze({
  solar: E('Solar'), grid_import: E('Grid import'), grid_export: E('Grid export'), battery_charge: E('Battery charge'), battery_discharge: E('Battery discharge'),
  home: E('Home use'), loss: E('Inverter use or loss (balance minus load)'), gas: E('Gas'), ev: E('EV smart charge'),
  solar_to_home: E('Solar to home'), solar_to_battery: E('Solar to battery'), solar_to_grid: E('Solar to grid'), solar_to_loss: E('Solar to inverter loss'),
  battery_to_home: E('Battery to home'), battery_to_grid: E('Battery to grid'), battery_to_loss: E('Battery to inverter loss'),
  grid_to_home: E('Grid to home'), grid_to_battery: E('Grid to battery'), grid_to_loss: E('Grid to inverter loss'),
  solar_forecast: E('Solar forecast of record'), meter_vs_ct: E('Meter minus clamp import'),
  soc_end: { unit: '%', kind: 'percent', agg: 'last', label: 'Battery charge level at the end' },
  import_rate: PRICE('Import price incl. tax', 'import_rate_ex * (1 + import_vat)'), import_rate_ex: PRICE('Import price ex tax'),
  export_rate: PRICE('Export price received'), gas_rate_ex: PRICE('Gas price ex tax'),
  import_vat: { unit: 'fraction', kind: 'percent', agg: 'mean', label: 'Import tax rate' }, gas_vat: { unit: 'fraction', kind: 'percent', agg: 'mean', label: 'Gas tax rate' },
  loss_cost: M('Cost of inverter loss'), grid_to_home_cost: M('Grid to home cost'), grid_to_battery_cost: M('Grid to battery cost'), battery_to_home_cost: M('Battery to home cost'),
  export_credit: M('Export credit'), standing_cost: M('Standing charges'), gas_cost: M('Gas cost'), total_cost: M('Total cost'), grid_only_cost: M('Cost on grid alone'), saving: M('Saving'),
  carbon_intensity: { unit: 'gCO2/kWh', kind: 'carbon', agg: 'mean', label: 'Grid carbon intensity' }, carbon_g: { unit: 'gCO2', kind: 'carbon', agg: 'sum', label: 'Carbon of imports' },
  carbon_saved_g: { unit: 'gCO2', kind: 'carbon', agg: 'sum', label: 'Carbon avoided' },
  outdoor_temp: { unit: 'degC', kind: 'temp', agg: 'mean', label: 'Outdoor temperature' },
  rate_found: { unit: '0/1', kind: 'flag', agg: 'mean', label: 'Import price found' },
});
const DEFAULT_COLS = ['solar', 'home', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'soc_end', 'import_rate', 'export_rate', 'total_cost', 'carbon_intensity', 'outdoor_temp', 'solar_forecast'];
const colSql = (name) => (TIMELINE_VARS[name].sql ? `${TIMELINE_VARS[name].sql} AS ${name}` : name);
const colMeta = (name) => ({ name, unit: TIMELINE_VARS[name].unit, kind: TIMELINE_VARS[name].kind, label: TIMELINE_VARS[name].label, agg: TIMELINE_VARS[name].agg });
const KIND_OF_UNIT = { W: 'power', kWh: 'energy', '%': 'percent', degC: 'temp', 'gCO2/kWh': 'carbon', 'W/m2': 'irradiance', '0/1': 'flag', m3: 'volume', 'MJ/m3': 'other', 'm/s': 'other' };
const kindOfUnit = (u) => KIND_OF_UNIT[u] ?? 'other';

// ───────────── Series of a home ─────────────

const FORECAST_ONLY = new Set(['core_forecast', 'quartz', 'core_solar_cases', 'core_plan']);
function regionsOf(site) {
  const out = [];
  if (site.carbon_region != null) out.push(`carbon:${site.carbon_region}`);
  for (const d of db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(site.id)) {
    try { const ldz = JSON.parse(d.attrs || '{}').ldz; if (ldz) out.push(`ldz:${ldz}`); } catch { /* attrs not JSON */ }
  }
  return out;
}
export function siteSeries(site) {
  return db.prepare(`SELECT se.id, se.subject_kind, se.subject_id, m.code AS metric, m.label, m.unit, m.time_role, m.aggregation, so.code AS source
      FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
     WHERE (se.subject_kind = 'site' AND se.subject_id = ?)
        OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))
        OR (se.subject_kind = 'region' AND se.subject_id IN (SELECT value FROM json_each(?)))
     ORDER BY se.id`).all(String(site.id), site.id, JSON.stringify(regionsOf(site)));
}
// Fact counts per series and table (current and superseded), first and last time.
function seriesStats(ids) {
  const st = new Map(ids.map((id) => [id, {}]));
  if (!ids.length) return st;
  const list = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT series_id, COUNT(*) AS n, SUM(superseded_at IS NOT NULL) AS sup, MIN(ts) AS a, MAX(ts) AS b FROM reading WHERE series_id IN (${list}) GROUP BY series_id`).all(...ids)) st.get(r.series_id).reading = r;
  for (const r of db.prepare(`SELECT series_id, COUNT(*) AS n, SUM(superseded_at IS NOT NULL) AS sup, MIN(start_ts) AS a, MAX(end_ts) AS b FROM interval_fact WHERE series_id IN (${list}) GROUP BY series_id`).all(...ids)) st.get(r.series_id).interval_fact = r;
  for (const r of db.prepare(`SELECT series_id, COUNT(*) AS n, 0 AS sup, MIN(start_ts) AS a, MAX(end_ts) AS b FROM forecast_fact WHERE series_id IN (${list}) GROUP BY series_id`).all(...ids)) st.get(r.series_id).forecast_fact = r;
  return st;
}
function describeSeries(s, st, site) {
  const primary = st.reading?.n ? 'reading' : st.interval_fact?.n ? 'interval_fact' : st.forecast_fact?.n ? 'forecast_fact' : (FORECAST_ONLY.has(s.source) ? 'forecast_fact' : s.time_role === 'instant' ? 'reading' : 'interval_fact');
  const p = st[primary] ?? { n: 0, sup: 0, a: null, b: null };
  const subject = s.subject_kind === 'site' ? '' : s.subject_kind === 'device' ? `, device ${s.subject_id}` : `, ${s.subject_id}`;
  return {
    series_id: s.id, subject_kind: s.subject_kind, subject_id: s.subject_id, metric: s.metric, label: `${s.label} (${s.source}${subject})`, unit: s.unit,
    time_role: s.time_role, aggregation: s.aggregation, source: s.source, first_ts: p.a ?? null, last_ts: p.b ?? null,
    count: (p.n ?? 0) - (p.sup ?? 0), superseded_count: p.sup ?? 0,
    table: primary, tables: Object.fromEntries(['reading', 'interval_fact', 'forecast_fact'].map((t) => [t, st[t]?.n ?? 0])),
    kind: kindOfUnit(s.unit), variable: primary === 'forecast_fact' ? null : `series:${s.id}`, site: site?.id ?? null,
  };
}

// ───────────── Raw payloads ─────────────

const rawRoot = () => path.resolve(dataDir);
function rawPath(r) {
  const p = path.resolve(dataDir, r.file);
  return p.startsWith(rawRoot() + path.sep) ? p : null;
}
const sizeCache = new Map();
function rawSize(r) {
  if (sizeCache.has(r.file)) return sizeCache.get(r.file);
  let s = null;
  try { s = fs.statSync(rawPath(r)).size; } catch { /* the file is not on this machine (a copied database) */ }
  if (s != null) sizeCache.set(r.file, s);
  return s;
}
function rawText(r) { try { const p = rawPath(r); return p ? fs.readFileSync(p, 'utf8') : null; } catch { return null; } }

// Keys and URL parameters that could hold a credential are replaced, wherever they appear.
const SECRET_KEY = /^(password|passwd|pwd|pass|secret|client_secret|token|access_token|refresh_token|id_token|jwt|api_?key|apikey|key|authorization|auth|bearer|cookie|set-cookie|session_?id|sign|signature|nonce|private_?key|credentials?)$/i;
function scrubString(s, n) {
  let out = s.replace(/([?&]([^=&#]+)=)([^&#]*)/g, (m, pre, k) => { let key = k; try { key = decodeURIComponent(k); } catch { /* keep */ } return SECRET_KEY.test(key) ? (n.count++, `${pre}[redacted]`) : m; });
  out = out.replace(/\b(Bearer|Basic|JWT)\s+[A-Za-z0-9._~+/=-]{8,}/g, (m, kind) => (n.count++, `${kind} [redacted]`));
  return out;
}
export function scrub(v, n = { count: 0 }) {
  if (Array.isArray(v)) return v.map((x) => scrub(x, n));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => (SECRET_KEY.test(k) && x != null && typeof x !== 'object' ? (n.count++, [k, '[redacted]']) : [k, scrub(x, n)])));
  }
  return typeof v === 'string' ? scrubString(v, n) : v;
}
const parseJson = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false, value: null }; } };
const requestOf = (r) => { const j = parseJson(r.request ?? 'null'); return scrub(j.ok ? j.value : r.request); };

const LINK = [
  ['reading', 'SELECT COUNT(*) AS n FROM reading WHERE raw_id = ?'], ['interval_fact', 'SELECT COUNT(*) AS n FROM interval_fact WHERE raw_id = ?'],
  ['forecast_fact', 'SELECT COUNT(*) AS n FROM forecast_fact WHERE raw_id = ?'], ['rate_interval', 'SELECT COUNT(*) AS n FROM rate_interval WHERE raw_id = ?'],
];
function linkedCounts(rawId) {
  const out = { total: 0 };
  for (const [t, sql] of LINK) { out[t] = db.prepare(sql).get(rawId).n; out.total += out[t]; }
  return out;
}
const UNLINKED = `NOT EXISTS (SELECT 1 FROM reading WHERE raw_id = p.id) AND NOT EXISTS (SELECT 1 FROM interval_fact WHERE raw_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM forecast_fact WHERE raw_id = p.id) AND NOT EXISTS (SELECT 1 FROM rate_interval WHERE raw_id = p.id)`;

// The facts a payload produced (forward lineage): every table that cites it, up to `limit` rows.
function forwardLineage(rawId, limit = 200) {
  const counts = linkedCounts(rawId);
  const out = [];
  const take = (sql) => { if (out.length < limit) out.push(...db.prepare(`${sql} LIMIT ?`).all(rawId, limit - out.length)); };
  const join = 'JOIN series se ON se.id = x.series_id JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id';
  take(`SELECT 'reading' AS "table", x.series_id, m.code AS metric, so.code AS source, x.ts, x.value, x.quality, x.recorded_at, x.superseded_at FROM reading x ${join} WHERE x.raw_id = ? ORDER BY x.series_id, x.ts, x.recorded_at`);
  take(`SELECT 'interval_fact' AS "table", x.series_id, m.code AS metric, so.code AS source, x.start_ts, x.end_ts, x.value, x.quality, x.recorded_at, x.superseded_at FROM interval_fact x ${join} WHERE x.raw_id = ? ORDER BY x.series_id, x.start_ts, x.recorded_at`);
  take(`SELECT 'forecast_fact' AS "table", x.series_id, m.code AS metric, so.code AS source, x.start_ts, x.end_ts, x.value, x.issued_at, x.recorded_at, NULL AS superseded_at FROM forecast_fact x ${join} WHERE x.raw_id = ? ORDER BY x.series_id, x.start_ts, x.issued_at`);
  take(`SELECT 'rate_interval' AS "table", NULL AS series_id, 'rate:' || x.component || '/' || x.register AS metric, t.provider AS source, x.id AS rate_id, t.tariff_code, x.payment_method, x.charge_period,
      x.valid_from AS start_ts, x.valid_to AS end_ts, x.price_ex_vat AS value, x.recorded_at, x.superseded_at FROM rate_interval x JOIN tariff t ON t.id = x.tariff_id WHERE x.raw_id = ? ORDER BY x.id`);
  return { rows: out, total: counts.total, by_table: counts, truncated: counts.total > out.length };
}

// ───────────── Re-derivation with the adapters' pure normalisers ─────────────

// Sources whose adapter exposes no side-effect-free normaliser. Nothing is refactored for the
// explorer: these payloads are not re-run; validation reads their published values directly instead.
const NOT_PURE = {
  sunsynk_5min: 'src/adapters/sunsynk.js normaliseDay writes each reading as it parses (seriesId, putReadings)',
  sunsynk_daily: 'src/adapters/sunsynk.js normaliseMonth writes as it parses (putIntervals)',
  sunsynk_live: 'src/adapters/sunsynk.js normaliseFlow writes as it parses and stamps the fetch time from the clock',
  octopus_meter: 'src/adapters/octopus.js normaliseConsumption writes as it parses (putIntervals); the gas unit choice reads the meter\'s stored attributes',
  octopus_rates: 'src/adapters/octopus.js maps rate rows inside syncTariffRates (an inner toRows) and writes them with putRates: no mapper is exported',
  octopus_kraken: 'src/adapters/octopus.js normaliseDispatches and normalisePlanned write as they parse',
  carbon_regional: 'src/adapters/carbon.js maps inline in syncCarbon (past and forward periods split by the fetch time)',
  open_meteo: 'src/adapters/openmeteo.js maps inline in syncWeather (past and future hours split by the fetch time)',
  quartz: 'src/adapters/quartz.js maps inline in syncQuartz',
  national_gas_cv: 'src/adapters/nationalgas.js parses the CSV inline in syncGasCv',
  postcodes_io: 'a location lookup: it produces no facts',
};

function derivedRates(r, body, site) {
  if (r.source === 'tariffscanner') {
    if (!Array.isArray(body?.data)) return { problem: 'the payload has no data array', rows: [] };
    const mapped = mapRecords(body.data);
    return { normaliser: 'mapRecords (src/adapters/tariffscanner.js)', rows: [...mapped.tariffs].flatMap(([code, t]) => t.rows.map((x) => ({
      tariff_code: code, component: x.component, register: x.register, charge_period: null, payment_method: x.paymentMethod, valid_from: x.validFrom, valid_to: x.validTo ?? null, value: x.price,
    }))) };
  }
  // tounify: a /prices answer or a /components answer, told apart by the request.
  const req = parseJson(r.request ?? '{}').value ?? {};
  const tz = site?.timezone ?? 'UTC';
  if (String(req.path ?? '').endsWith('/components')) {
    const mc = mapComponents(body, { currency: site?.currency ?? null, zone: tz, captureDayStart: dayBounds(tz, localDate(tz, r.fetched_at))[0] });
    if (!mc.ok) return { normaliser: 'mapComponents (src/adapters/tounify.js)', problem: mc.problems.join('; '), rows: [] };
    return { normaliser: 'mapComponents (src/adapters/tounify.js)', anyTariff: true, rows: mc.rows.map((x) => ({ tariff_code: null, component: 'fixed', register: x.register, charge_period: x.chargePeriod, payment_method: 'ANY', valid_from: x.validFrom, valid_to: null, value: x.price })) };
  }
  const mp = mapPrices(body, { country: site?.country ?? null, currency: site?.currency ?? null });
  if (!mp.ok) return { normaliser: 'mapPrices (src/adapters/tounify.js)', problem: mp.problems.join('; '), rows: [] };
  const rows = (code, list) => list.map((x) => ({ tariff_code: code, component: 'unit', register: 'single', charge_period: null, payment_method: 'ANY', valid_from: x.validFrom, valid_to: x.validTo ?? null, value: x.price }));
  return { normaliser: 'mapPrices (src/adapters/tounify.js)', rows: [...rows(mp.tariff.tariffCode, mp.rows), ...(mp.feedin ? rows(mp.feedin.tariff.tariffCode, mp.feedin.rows) : [])] };
}

/**
 * Re-run the adapter's pure normaliser on a stored body and compare with the stored rows that cite
 * the payload: { supported, ok, rederived_count, stored_count, diffs: [{ key, stored, rederived }] }.
 */
export function rederive(r, body, site) {
  if (!['tariffscanner', 'tounify'].includes(r.source)) {
    return { supported: false, ok: null, rederived_count: null, stored_count: linkedCounts(r.id).total, diffs: [],
      reason: `${r.source}: no side-effect-free normaliser is exported (${NOT_PURE[r.source] ?? 'no adapter normaliser known for this source'}); nothing is refactored for the explorer, so this payload is not re-run. /api/explorer/validate reads its published values directly instead.` };
  }
  if (body == null) return { supported: true, ok: false, rederived_count: 0, stored_count: linkedCounts(r.id).total, diffs: [], reason: 'the payload body could not be read as JSON (or its file is not on this machine)' };
  const d = derivedRates(r, body, site);
  const stored = db.prepare('SELECT x.*, t.tariff_code FROM rate_interval x JOIN tariff t ON t.id = x.tariff_id WHERE x.raw_id = ? ORDER BY x.id').all(r.id);
  const key = (x, any) => [any ? '*' : x.tariff_code, x.component, x.register, x.charge_period ?? '', x.payment_method ?? 'ANY', any ? '' : x.valid_from].join('|');
  const derivedBy = new Map();
  for (const x of d.rows) derivedBy.set(key(x, d.anyTariff), x);
  const landedMs = r.fetched_at * 1000 + 120000;
  const diffs = []; const used = new Set(); let splits = 0;
  for (const s of stored) {
    const k = key(s, d.anyTariff);
    let x = derivedBy.get(k);
    const later = s.recorded_at > landedMs;   // a copy written by a later payload, keeping this one's price for the part it kept
    if (!x && later) x = d.rows.find((y) => (d.anyTariff || y.tariff_code === s.tariff_code) && y.component === s.component && y.register === s.register && (y.payment_method ?? 'ANY') === s.payment_method
      && y.valid_from <= s.valid_from && (y.valid_to == null || y.valid_to > s.valid_from));
    const st = { value: s.price_ex_vat, valid_from: s.valid_from, valid_to: s.valid_to, rate_id: s.id, superseded_at: s.superseded_at };
    if (!x) { diffs.push({ key: k, stored: st, rederived: null }); continue; }
    used.add(x);
    const sameValue = Math.abs(x.value - s.price_ex_vat) < 1e-9;
    const shortened = later && s.valid_to != null && (x.valid_to == null || s.valid_to < x.valid_to);
    const sameEnd = d.anyTariff || (x.valid_to ?? null) === (s.valid_to ?? null) || shortened || (later && x.valid_from !== s.valid_from);
    if (shortened || (later && x.valid_from !== s.valid_from)) splits++;
    if (!sameValue || !sameEnd) diffs.push({ key: k, stored: st, rederived: { value: x.value, valid_from: x.valid_from, valid_to: x.valid_to } });
  }
  return {
    supported: true, normaliser: d.normaliser, ok: !d.problem && diffs.length === 0, rederived_count: d.rows.length, stored_count: stored.length,
    diffs: diffs.slice(0, 100), diff_count: diffs.length, not_stored_count: d.rows.filter((x) => !used.has(x)).length, split_copies: splits,
    ...(d.problem ? { reason: `the normaliser refused the payload: ${d.problem}` } : {}),
    note: 'rows the payload gives that no stored row cites were already held from an earlier payload (an unchanged price is not written twice); a split copy is the part of a row a later payload kept at this price',
  };
}

// ───────────── Published values: reading a stored payload directly ─────────────

// Independently of the adapters, the value a payload published for one fact, by the source's
// contract (src/db/registry.js SOURCES): { value } or { missing: reason }.
const SUNSYNK_LABEL = { solar_w: ['PV', (v) => Math.max(0, v)], load_w: ['Load', (v) => Math.max(0, v)], grid_import_w: ['Grid', (v) => Math.max(0, v)], grid_export_w: ['Grid', (v) => Math.max(0, -v)],
  battery_discharge_w: ['Battery', (v) => Math.max(0, v)], battery_charge_w: ['Battery', (v) => Math.max(0, -v)], battery_soc_pct: ['SOC', (v) => v] };
const SUNSYNK_MONTH = { solar_kwh: 'PV Generation', load_kwh: 'Load Power Consumption', grid_import_kwh: 'Purchased electricity', grid_export_kwh: 'Sold electricity', battery_charge_kwh: 'Charge Energy', battery_discharge_kwh: 'Discharge Energy' };
const OPEN_METEO = { outdoor_temp_c: 'temperature_2m', cloud_pct: 'cloud_cover', humidity_pct: 'relative_humidity_2m', dew_point_c: 'dew_point_2m', wind_speed_ms: 'wind_speed_10m', ghi_wm2: 'shortwave_radiation', gti_wm2: 'global_tilted_irradiance' };
const pad2 = (n) => String(n).padStart(2, '0');
// Local wall-clock HH:mm of an instant: the zone's offset is read once per quarter-hour (every real
// clock change falls on the 900 s grid), so a week of five-minute samples costs a few hundred lookups.
const offsets = new Map();
function localHHMM(tz, ts) {
  const q = floorTo(ts, 900);
  const k = `${tz}|${q}`;
  let off = offsets.get(k);
  if (off === undefined) { const p = zonedParts(tz, q); off = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) / 1000 - q; if (offsets.size > 50000) offsets.clear(); offsets.set(k, off); }
  const d = new Date((ts + off) * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
const LOOKUPS = {
  sunsynk_5min: {
    how: 'the record at the same plant-clock HH:mm under the same label, with the contract\'s signs (grid positive = import, battery positive = discharging)',
    plain: 'each five-minute reading matched by its time of day',
    index(body) { const m = new Map(); for (const info of body?.data?.infos ?? []) for (const rec of info.records ?? []) { const k = `${info.label}|${rec.time}`; (m.get(k) || m.set(k, []).get(k)).push(rec.value); } return m; },
    find(ix, fact, meta, tz) {
      const [label, sign] = SUNSYNK_LABEL[meta.metric] ?? [];
      if (!label) return { missing: `no label for ${meta.metric}` };
      const hhmm = localHHMM(tz, fact.ts);
      const vals = (ix.get(`${label}|${hhmm}`) ?? []).filter((v) => v !== null && v !== '').map((v) => sign(Number(v)));
      if (!vals.length) return { missing: `no ${label} record at ${hhmm}` };
      return { value: vals.find((v) => Math.abs(v - fact.value) < 1e-9) ?? vals[0], candidates: vals.length };
    },
  },
  sunsynk_daily: {
    how: 'the record of the same plant-local day under the counter\'s label',
    plain: 'each daily total matched by its date',
    index(body) { const m = new Map(); for (const info of body?.data?.infos ?? []) for (const rec of info.records ?? []) m.set(`${info.label}|${rec.time}`, Number(rec.value)); return m; },
    find(ix, fact, meta, tz) { const k = `${SUNSYNK_MONTH[meta.metric]}|${localDate(tz, fact.start_ts)}`; return ix.has(k) ? { value: ix.get(k) } : { missing: `no record ${k}` }; },
  },
  octopus_meter: {
    how: 'the consumption row with the same interval_start and interval_end',
    plain: 'each meter reading matched by its start and end time',
    index(body) { const m = new Map(); for (const x of body?.results ?? []) m.set(`${parseIso(x.interval_start)}|${parseIso(x.interval_end)}`, x.consumption); return m; },
    find(ix, fact) { const k = `${fact.start_ts}|${fact.end_ts}`; return ix.has(k) ? { value: ix.get(k) } : { missing: 'no row for that period' }; },
  },
  carbon_regional: {
    how: 'the period with the same from and to: its intensity.forecast',
    plain: 'each half-hour\'s figure matched by its time',
    index(body) { const d = body?.data; const list = Array.isArray(d) ? d[0]?.data : d?.data; const m = new Map(); for (const x of list ?? []) m.set(`${parseIso(x.from)}|${parseIso(x.to)}`, x.intensity?.forecast ?? null); return m; },
    find(ix, fact) { const k = `${fact.start_ts}|${fact.end_ts}`; return ix.has(k) ? { value: ix.get(k) } : { missing: 'no period with those times' }; },
  },
  open_meteo: {
    how: 'the hourly value at the same unix time (irradiance: the value at the end of the hour it covers)',
    plain: 'each hourly value matched by its hour',
    index(body) { const h = body?.hourly; return { h, at: new Map((h?.time ?? []).map((t, i) => [t, i])) }; },
    find(ix, fact, meta) {
      const key = OPEN_METEO[meta.metric];
      if (!key) return { missing: `no field for ${meta.metric}` };
      const i = ix.at.get(fact.ts ?? fact.end_ts);
      return i == null || !Array.isArray(ix.h?.[key]) ? { missing: 'no hour at that time' } : { value: ix.h[key][i] };
    },
  },
  national_gas_cv: {
    how: 'the CSV line whose Applicable For date is the gas day',
    plain: 'the energy in the gas matched by its gas day',
    index(text) { const m = new Map(); for (const line of String(text ?? '').trim().split(/\r?\n/).slice(1)) { const c = line.match(/("([^"]*)"|[^,]*)(,|$)/g)?.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '')) ?? []; m.set(c[1], Number(c[3])); } return m; },
    find(ix, fact, meta, tz) { const [y, mo, d] = localDate(tz, fact.start_ts).split('-'); const k = `${d}/${mo}/${y}`; return ix.has(k) ? { value: ix.get(k) } : { missing: `no line for ${k}` }; },
    text: true,
  },
};
// Published rate rows: { value, valid_from, valid_to } of the row with this start and payment method.
const RATE_LOOKUP = {
  octopus_rates(body, row) {
    const pm = row.payment_method ?? 'ANY';
    const x = (body?.results ?? []).find((y) => parseIso(y.valid_from) === row.valid_from && (y.payment_method || 'ANY') === pm);
    return x ? { value: x.value_exc_vat, valid_from: parseIso(x.valid_from), valid_to: x.valid_to ? parseIso(x.valid_to) : null } : { missing: `no published row starting ${new Date(row.valid_from * 1000).toISOString()}` };
  },
};

// Payloads read and parsed once, kept for later requests too: a payload file never changes (it is
// named by its hash and never rewritten), so a cached body is always the stored one. The row is read
// again on every request (its status may change); at most PAYLOAD_CACHE bodies are kept.
const PAYLOAD_CACHE = 400;
const bodies = new Map();
// `budget` (bytes): how much payload text not read before one request may open for the published-value
// comparisons (`optional` reads); the rest are reported as not opened, and a later request goes on.
function payloadCache({ budget = Infinity } = {}) {
  const cache = new Map();
  let left = budget;
  const get = (rawId, { optional = false } = {}) => {
    if (rawId == null) return null;
    if (cache.get(rawId)?.deferred && !optional) cache.delete(rawId);
    if (!cache.has(rawId)) {
      const r = db.prepare('SELECT p.*, so.code AS source FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.id = ?').get(rawId);
      const key = r ? `${dataDir}|${r.hash}` : null;
      let hit = key ? bodies.get(key) : null;
      if (hit) { bodies.delete(key); bodies.set(key, hit); }   // most recently used last
      if (r && !hit && optional) {
        const size = rawSize(r) ?? 0;
        if (size > left) { cache.set(rawId, { r, deferred: true }); return cache.get(rawId); }
        left -= size;
      }
      if (r && !hit) {
        const text = rawText(r);
        const j = text != null ? parseJson(text) : { ok: false, value: null };
        hit = { text, body: j.value, json: j.ok, ix: null };
        if (text != null && text.length < 4e6) { bodies.set(`${dataDir}|${r.hash}`, hit); if (bodies.size > PAYLOAD_CACHE) bodies.delete(bodies.keys().next().value); }
      }
      cache.set(rawId, r ? { r, ...hit, entry: hit } : { r: null });
    }
    return cache.get(rawId);
  };
  return { get };
}
const RANGE_PAYLOAD_BUDGET = 2.5e6;
function publishedValue(pc, fact, meta, tz) {
  const p = pc.get(fact.raw_id, { optional: true });
  if (!p?.r) return { missing: fact.raw_id == null ? 'the fact cites no payload' : `payload ${fact.raw_id} not found` };
  if (p.deferred) return { deferred: true, missing: `payload ${p.r.id} not opened in this request (a range opens at most ${RANGE_PAYLOAD_BUDGET / 1e6} MB of payloads not read before; they are kept, so asking again goes on)` };
  const L = LOOKUPS[p.r.source];
  if (!L) return { unsupported: `no published-value reader for ${p.r.source}` };
  if (p.text == null) return { missing: `the file of payload ${p.r.id} is not on this machine` };
  p.entry.ix ??= L.index(L.text ? p.text : p.body);
  return L.find(p.entry.ix, fact, meta, tz);
}

// ───────────── 1 overview ─────────────

export function overview(q) {
  const site = siteParam(q);
  const range = db.prepare('SELECT MIN(local_date) AS first_date, MAX(local_date) AS last_date FROM site_day WHERE site_id = ?').get(site.id);
  const list = siteSeries(site);
  const st = seriesStats(list.map((s) => s.id));
  const bySource = new Map();
  for (const s of list) {
    const x = bySource.get(s.source) || bySource.set(s.source, { code: s.source, series: 0, facts: 0, first_ts: null, last_ts: null }).get(s.source);
    x.series++;
    for (const t of ['reading', 'interval_fact', 'forecast_fact']) {
      const r = st.get(s.id)[t];
      if (!r) continue;
      x.facts += r.n - r.sup;
      x.first_ts = x.first_ts == null ? r.a : Math.min(x.first_ts, r.a);
      x.last_ts = x.last_ts == null ? r.b : Math.max(x.last_ts, r.b);
    }
  }
  const raws = db.prepare('SELECT p.id, p.file, so.code AS source, p.fetched_at FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.site_id = ?').all(site.id);
  const unlinked = new Map(db.prepare(`SELECT so.code AS source, SUM(${UNLINKED}) AS n FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.site_id = ? GROUP BY so.code`).all(site.id).map((r) => [r.source, r.n]));
  const rawBy = new Map();
  for (const r of raws) {
    const x = rawBy.get(r.source) || rawBy.set(r.source, { source: r.source, count: 0, bytes: 0, first_at: null, last_at: null, unlinked: unlinked.get(r.source) ?? 0, missing_files: 0 }).get(r.source);
    x.count++;
    const size = rawSize(r);
    if (size == null) x.missing_files++; else x.bytes += size;
    x.first_at = x.first_at == null ? r.fetched_at : Math.min(x.first_at, r.fetched_at);
    x.last_at = x.last_at == null ? r.fetched_at : Math.max(x.last_at, r.fetched_at);
  }
  const tl = db.prepare(`SELECT COUNT(*) AS slots, SUM(state = 'final') AS final, SUM(state = 'provisional') AS provisional, SUM(state = 'missing') AS missing,
    SUM((quality & ${QUALITY.RESTATED}) != 0) AS restated FROM site_hh WHERE site_id = ?`).get(site.id);
  const ck = Object.fromEntries(['pass', 'warn', 'fail', 'skip'].map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM check_result WHERE site_id = ? GROUP BY status').all(site.id)) ck[r.status] = r.n;
  return {
    ...base(site), name: site.name, timezone: site.timezone, is_demo: !!site.is_demo,
    range: { first_date: range?.first_date ?? null, last_date: range?.last_date ?? null },
    slot_s: slotLength(site), currency: site.currency ?? 'GBP', series_count: list.length,
    sources: [...bySource.values()].sort((a, b) => a.code.localeCompare(b.code)),
    raw: { count: raws.length, bytes: [...rawBy.values()].reduce((s, x) => s + x.bytes, 0), by_source: [...rawBy.values()].sort((a, b) => a.source.localeCompare(b.source)),
      shared: db.prepare('SELECT COUNT(*) AS n FROM raw_payload WHERE site_id IS NULL').get().n,
      note: 'unlinked: payloads no fact or rate row cites (often a re-fetch whose values were already held: unchanged facts are not stored twice); shared: catalogue payloads of no home' },
    timeline: { slots: tl.slots ?? 0, final: tl.final ?? 0, provisional: tl.provisional ?? 0, missing: tl.missing ?? 0, restated: tl.restated ?? 0 },
    checks: ck,
  };
}

// ───────────── 2 and 3 raw ─────────────

export function rawList(q) {
  const site = siteParam(q);
  const tz = site.timezone;
  const source = one(q.source, 'source');
  const status = enumParam(q, 'status', ['accepted', 'quarantined'], null);
  const from = timeParam(q, 'from', tz); const to = timeParam(q, 'to', tz, { end: true });
  const limit = intParam(q, 'limit', { def: 50, min: 1, max: 200 });
  const cursor = intParam(q, 'cursor', { min: 1 });
  const where = ['p.site_id = ?']; const args = [site.id];
  if (source) {
    const sid = db.prepare('SELECT id FROM source WHERE code = ?').get(source)?.id;
    if (sid == null) throw bad(`unknown source ${source}`);
    where.push('p.source_id = ?'); args.push(sid);
  }
  if (status) { where.push('p.status = ?'); args.push(status); }
  if (from != null) { where.push('p.fetched_at >= ?'); args.push(from); }
  if (to != null) { where.push('p.fetched_at < ?'); args.push(to); }
  if (cursor != null) { where.push('p.id < ?'); args.push(cursor); }
  const rows = db.prepare(`SELECT p.id, so.code AS source, p.fetched_at, p.status, p.reason, p.hash, p.request, p.file FROM raw_payload p JOIN source so ON so.id = p.source_id
    WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  return {
    ...base(site),
    rows: page.map((r) => ({ id: r.id, source: r.source, fetched_at: r.fetched_at, status: r.status, reason: r.reason ?? null, size: rawSize(r), hash: r.hash, request: requestOf(r), facts_linked: linkedCounts(r.id).total })),
    next: rows.length > limit ? page[page.length - 1].id : null,
  };
}

const BODY_LIMIT = 200000;
export function rawOne(id, q) {
  if (!/^\d+$/.test(String(id ?? ''))) throw bad('the raw payload id must be a number');
  const r = db.prepare('SELECT p.*, so.code AS source FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.id = ?').get(Number(id));
  if (!r) throw notFound(`no raw payload ${id}`);
  const asked = siteParam(q, { required: false });
  if (asked && r.site_id != null && r.site_id !== asked.id) throw notFound(`raw payload ${id} is not one of home ${asked.id}`);
  const site = asked ?? (r.site_id != null ? db.prepare('SELECT * FROM site WHERE id = ?').get(r.site_id) : null);
  const text = rawText(r);
  const j = text != null ? parseJson(text) : { ok: false, value: null };
  const n = { count: 0 };
  let body = text;
  if (j.ok) { const clean = scrub(j.value, n); if (n.count) body = JSON.stringify(clean); } else if (text != null) body = scrubString(text, n);
  const truncated = body != null && body.length > BODY_LIMIT;
  const lineage = forwardLineage(r.id, 200);
  return {
    ...base(site),
    meta: { id: r.id, source: r.source, site_id: r.site_id, fetched_at: r.fetched_at, status: r.status, reason: r.reason ?? null, hash: r.hash, file: r.file, size: text != null ? Buffer.byteLength(text) : rawSize(r), request: requestOf(r), redacted: n.count, file_found: text != null },
    body: truncated ? body.slice(0, BODY_LIMIT) : body, truncated, json_ok: j.ok,
    facts: lineage.rows, total: lineage.total, facts_total: lineage.total, facts_by_table: lineage.by_table, facts_truncated: lineage.truncated,
    rederive: rederive(r, j.ok ? j.value : null, site),
  };
}

// ───────────── 4 and 5 series and facts ─────────────

export function seriesList(q) {
  const site = siteParam(q);
  const text = one(q.q, 'q')?.toLowerCase() ?? null;
  const source = one(q.source, 'source'); const metric = one(q.metric, 'metric');
  let list = siteSeries(site);
  if (source) list = list.filter((s) => s.source === source);
  if (metric) list = list.filter((s) => s.metric === metric);
  if (text) list = list.filter((s) => [s.metric, s.label, s.source, s.subject_id, s.unit].some((x) => String(x).toLowerCase().includes(text)));
  const st = seriesStats(list.map((s) => s.id));
  // An array, as the contract gives it: each item carries the home and generated_at.
  const at = nowSec();
  return list.map((s) => ({ ...describeSeries(s, st.get(s.id), site), generated_at: at }));
}

function seriesById(id) {
  return db.prepare(`SELECT se.*, m.code AS metric, m.label, m.unit, m.time_role, m.aggregation, so.code AS source
    FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id WHERE se.id = ?`).get(id);
}
function siteOfSeries(s) {
  if (s.subject_kind === 'site') return db.prepare('SELECT * FROM site WHERE id = ?').get(Number(s.subject_id)) ?? null;
  if (s.subject_kind === 'device') return db.prepare('SELECT s.* FROM site s JOIN device d ON d.site_id = s.id WHERE d.id = ?').get(Number(s.subject_id)) ?? null;
  return null;
}

export function facts(q) {
  const id = intParam(q, 'series', { required: true, min: 1 });
  const s = seriesById(id);
  if (!s) throw notFound(`no series ${id}`);
  const owner = siteOfSeries(s);
  const asked = siteParam(q, { required: false });
  if (asked && owner && owner.id !== asked.id) throw notFound(`series ${id} is not one of home ${asked.id}`);
  const site = owner ?? asked;
  const tz = site?.timezone ?? 'UTC';
  const asOf = asOfParam(q);
  const all = enumParam(q, 'include_superseded', ['0', '1'], '0') === '1';
  const limit = intParam(q, 'limit', { def: 1000, min: 1, max: 5000 });
  const from = timeParam(q, 'from', tz); const to = timeParam(q, 'to', tz, { end: true });
  if (from != null && to != null && from >= to) throw bad('from must be before to');
  const st = seriesStats([id]).get(id);
  const meta = describeSeries(s, st, site);
  const table = enumParam(q, 'table', ['reading', 'interval_fact', 'forecast_fact'], meta.table);
  const tcol = table === 'reading' ? 'ts' : 'start_ts';
  const where = ['series_id = ?']; const args = [id];
  if (from != null) {
    where.push(table === 'reading' ? 'ts >= ?' : 'end_ts > ?'); args.push(from);
    // A period overlapping the window starts at most its series' longest fact earlier (delta 013):
    // that bound lets the primary key be searched as a range.
    if (table !== 'reading' && s.max_span_s != null) { where.push('start_ts >= ?'); args.push(from - s.max_span_s); }
  }
  if (to != null) { where.push(`${tcol} < ?`); args.push(to); }
  if (table !== 'forecast_fact') {
    if (asOf != null) { where.push(all ? 'recorded_at <= ?' : 'recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)'); args.push(...(all ? [asOf] : [asOf, asOf])); }
    else if (!all) where.push('superseded_at IS NULL');
  } else if (asOf != null) { where.push('recorded_at <= ?'); args.push(asOf); }
  const cols = table === 'reading' ? 'ts, value, quality, recorded_at, superseded_at, raw_id'
    : table === 'interval_fact' ? 'start_ts, end_ts, value, quality, recorded_at, superseded_at, raw_id' : 'start_ts, end_ts, issued_at, value, recorded_at, raw_id';
  // Without a window, the latest points; with one, from its start. Forecasts: the latest issue per
  // period (as known at as_of_ms), or every issue with include_superseded=1.
  const latest = from == null && to == null;
  const cap = table === 'forecast_fact' && !all ? 20000 : limit + 1;
  const order = table === 'forecast_fact' ? `start_ts ${latest ? 'DESC' : ''}, end_ts, issued_at` : `${tcol} ${latest ? 'DESC' : ''}, recorded_at`;
  let rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, cap);
  if (table === 'forecast_fact') {
    const best = new Map();
    for (const r of rows) {
      const k = `${r.start_ts}|${r.end_ts}`;
      if (all) { (best.get(k) || best.set(k, []).get(k)).push(r); continue; }
      if (!best.has(k) || r.issued_at > best.get(k).issued_at) best.set(k, r);
    }
    rows = [...best.values()].flat().map((r) => ({ ...r, quality: null, superseded_at: null }));
  }
  if (latest) rows.reverse();
  rows.sort((a, b) => (a.ts ?? a.start_ts) - (b.ts ?? b.start_ts) || (a.end_ts ?? 0) - (b.end_ts ?? 0) || (a.recorded_at ?? 0) - (b.recorded_at ?? 0));
  const truncated = rows.length > limit;
  if (truncated) rows = latest ? rows.slice(rows.length - limit) : rows.slice(0, limit);
  // Stats over the points in force (as known at as_of_ms when given).
  const inForceAt = (r) => r.superseded_at == null || (asOf != null && r.superseded_at > asOf);
  const live = rows.filter(inForceAt);
  const vals = live.map((r) => r.value).filter((v) => v != null);
  const times = live.map((r) => r.ts ?? r.start_ts);
  const steps = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = steps.length ? steps[steps.length >> 1] : null;
  const versions = table === 'forecast_fact' ? rows.length - new Set(rows.map((r) => `${r.start_ts}|${r.end_ts}`)).size
    : db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE series_id = ? AND superseded_at IS NOT NULL${from != null ? ` AND ${tcol} >= ?` : ''}${to != null ? ` AND ${tcol} < ?` : ''}${asOf != null ? ' AND recorded_at <= ?' : ''}`)
      .get(id, ...(from != null ? [from] : []), ...(to != null ? [to] : []), ...(asOf != null ? [asOf] : [])).n;
  return {
    ...base(site), series: meta, table, as_of_ms: asOf, include_superseded: all, truncated,
    points: rows,
    stats: {
      n: vals.length, min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      gaps: typical ? steps.filter((d) => d > 1.5 * typical).length : 0, typical_step_s: typical, versions,
    },
  };
}

// ───────────── 6 timeline ─────────────

export function timeline(q) {
  const site = siteParam(q);
  const { from, to } = dateRange(site, q, { days: 7, maxDays: 400 });
  const colsText = one(q.cols, 'cols');
  const cols = colsText ? [...new Set(colsText.split(',').map((c) => c.trim()).filter(Boolean))] : DEFAULT_COLS;
  for (const c of cols) if (!TIMELINE_VARS[c]) throw bad(`unknown column ${c}: one of ${Object.keys(TIMELINE_VARS).join(', ')}`);
  const limit = intParam(q, 'limit', { def: 5000, min: 1, max: 40000 });
  const [a] = dayBounds(site.timezone, from); const [, b] = dayBounds(site.timezone, to);
  const rows = db.prepare(`SELECT slot_start, local_date, tod_min, dur_s, state, quality, ${cols.map(colSql).join(', ')} FROM site_hh
    WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start LIMIT ?`).all(site.id, a, b, limit + 1);
  const days = db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date').all(site.id, from, to)
    .map((d) => ({ ...d, battery_stock_layers: d.battery_stock ? JSON.parse(d.battery_stock).length : 0 }));
  return {
    ...base(site), from, to, timezone: site.timezone, slot_s: slotLength(site), currency: site.currency ?? 'GBP',
    cols: cols.map(colMeta), rows: rows.slice(0, limit), truncated: rows.length > limit, days,
  };
}

// ───────────── 7 slot trace ─────────────

export function slot(q) {
  const site = siteParam(q);
  const s = intParam(q, 'slot', { required: true, min: 0 });
  return { ...base(site), ...explainSlot(site.id, s, { asOfMs: asOfParam(q) }) };
}

// ───────────── 11 variables; reading one on a step ─────────────

export function variables(q) {
  const site = siteParam(q);
  const list = siteSeries(site);
  const st = seriesStats(list.map((s) => s.id));
  const series = list.map((s) => describeSeries(s, st.get(s.id), site)).filter((s) => s.variable);
  return {
    ...base(site), slot_s: slotLength(site), currency: site.currency ?? 'GBP',
    variables: [
      ...Object.keys(TIMELINE_VARS).map((name) => ({ ...colMeta(name), source: 'timeline' })),
      ...series.map((s) => ({ name: s.variable, label: s.label, unit: s.unit, kind: s.kind, source: 'series', series_id: s.series_id, metric: s.metric, provider_source: s.source, count: s.count,
        agg: s.aggregation === 'sum' ? 'sum' : s.aggregation === 'last' ? 'last' : 'mean' })),
    ],
    note: 'forecast series are not listed: the forecast of record of each slot is the timeline column solar_forecast',
  };
}

function varMeta(site, name) {
  if (name == null) throw bad('a variable name is required');
  if (name.startsWith('series:')) {
    const id = Number(name.slice(7));
    const s = Number.isInteger(id) ? siteSeries(site).find((x) => x.id === id) : null;
    if (!s) throw bad(`unknown variable ${name}: no series ${name.slice(7)} of home ${site.id}`);
    const d = describeSeries(s, seriesStats([id]).get(id), site);
    if (!d.variable) throw bad(`${name} holds forecasts only: use the timeline column solar_forecast`);
    return { name, label: d.label, unit: d.unit, kind: d.kind, source: 'series', series: s, agg: s.aggregation === 'sum' ? 'sum' : s.aggregation === 'last' ? 'last' : 'mean' };
  }
  if (!TIMELINE_VARS[name]) throw bad(`unknown variable ${name}: see /api/explorer/variables`);
  return { ...colMeta(name), source: 'timeline' };
}
const AGG = {
  sum: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null),
  mean: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
  last: (xs) => (xs.length ? xs[xs.length - 1] : null),
};
// One variable over [a, b) on a step: Map(step start -> value). slot: the home's slots; hour: local
// hour starts; day: local day starts. A step whose parts are all null is null; a partial step
// aggregates the parts it has.
function readVariable(site, v, a, b, step) {
  const tz = site.timezone;
  const dayStart = new Map();
  const dayOf = (d) => dayStart.get(d) ?? dayStart.set(d, dayBounds(tz, d)[0]).get(d);
  const parts = new Map();
  const put = (k, x) => { const p = parts.get(k) || parts.set(k, []).get(k); if (x != null && Number.isFinite(x)) p.push(x); };
  if (v.source === 'timeline') {
    const expr = TIMELINE_VARS[v.name].sql ?? v.name;
    for (const r of db.prepare(`SELECT slot_start, tod_min, local_date, ${expr} AS v FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start`).all(site.id, a, b)) {
      put(step === 'slot' ? r.slot_start : step === 'hour' ? r.slot_start - (r.tod_min % 60) * 60 : dayOf(r.local_date), r.v);
    }
  } else {
    const res = plannerSeries(site.id, v.series.metric, a, b, { stepS: step === 'slot' ? 'slot' : 3600, source: v.series.source });
    for (let i = 0; i < res.n; i++) {
      const t = res.start + i * res.stepS;
      if (t < a || t >= b) continue;
      put(step === 'day' ? dayOf(localDate(tz, t)) : t, res.values[i]);
    }
  }
  const out = new Map();
  for (const [k, xs] of parts) out.set(k, AGG[v.agg](xs));
  return out;
}
// The step axis over local dates [from, to]: slot starts, local hour starts or local day starts.
function axisOf(site, from, to, step) {
  const tz = site.timezone;
  if (step === 'day') return daysBetween(from, to).map((d) => dayBounds(tz, d)[0]);
  const [a] = dayBounds(tz, from); const [, b] = dayBounds(tz, to);
  const s = step === 'slot' ? slotLength(site) : 3600;
  const out = [];
  for (let t = a; t < b; t += s) out.push(t);
  return out;
}

// ───────────── 9 correlate ─────────────

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, slope: sxx > 0 ? sxy / sxx : null, mx, my };
}
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;   // ties share their mean rank
    i = j + 1;
  }
  return r;
}
export function stats(xs, ys) {
  const p = pearson(xs, ys);
  const s = pearson(ranks(xs), ranks(ys));
  return { pearson: p.r, r2: p.r == null ? null : p.r * p.r, spearman: s.r, slope: p.slope, intercept: p.slope == null ? null : p.my - p.slope * p.mx };
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN_POINTS = 8;

export function correlate(q) {
  const site = siteParam(q);
  const step = enumParam(q, 'step', ['slot', 'hour', 'day'], 'slot');
  const { from, to } = dateRange(site, q, { days: 30, maxDays: 400 });
  const x = varMeta(site, one(q.x, 'x')); const y = varMeta(site, one(q.y, 'y'));
  const lag = intParam(q, 'lag', { def: 0, min: -10000, max: 10000 });
  const group = enumParam(q, 'group', ['none', 'hour', 'weekday'], 'none');
  if (group === 'hour' && step === 'day') throw bad('group=hour needs step slot or hour');
  const limitPoints = intParam(q, 'limit_points', { def: 2000, min: 10, max: 5000 });
  const tz = site.timezone;
  const axis = axisOf(site, from, to, step);
  const [a] = dayBounds(tz, from); const [, b] = dayBounds(tz, to);
  const X = readVariable(site, x, a, b, step); const Y = readVariable(site, y, a, b, step);
  const pts = []; let skipped = 0;
  for (let i = 0; i < axis.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= axis.length) continue;
    const xv = X.get(axis[i]) ?? null; const yv = Y.get(axis[j]) ?? null;
    if (xv == null || yv == null) { skipped++; continue; }
    pts.push({ t: axis[i], x: xv, y: yv });
  }
  const meta = (v) => ({ name: v.name, unit: v.unit, label: v.label, kind: v.kind, source: v.source });
  const notes = [`${skipped} step(s) skipped where x or y had no value`, `step ${step}${lag ? `; y is read ${lag} step(s) ${lag > 0 ? 'after' : 'before'} x` : ''}`,
    ...[x, y].filter((v) => v.source === 'series').map((v) => `${v.name} resampled with the planner read layer (src/core/planner-read.js series), as known now`),
    ...[x, y].filter((v) => v.source === 'timeline').map((v) => `${v.name}: site_hh as stored${step !== 'slot' ? ` (${v.agg} per ${step})` : ''}`)];
  const head = { ...base(site), x: meta(x), y: meta(y), from, to, step, lag, group, n: pts.length };
  if (pts.length < MIN_POINTS) return { ...head, error: 'too few points', min_points: MIN_POINTS, notes };
  const s = stats(pts.map((p) => p.x), pts.map((p) => p.y));
  if (s.pearson == null) notes.push('one of the variables is constant over these points: no correlation can be measured');
  let by = null;
  if (group !== 'none') {
    const groups = new Map();
    for (const p of pts) {
      const z = zonedParts(tz, p.t);
      const k = group === 'hour' ? String(z.hh).padStart(2, '0') : WEEKDAYS[new Date(Date.UTC(z.y, z.m - 1, z.d)).getUTCDay()];
      (groups.get(k) || groups.set(k, []).get(k)).push(p);
    }
    const order = group === 'hour' ? [...groups.keys()].sort() : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter((k) => groups.has(k));
    by = order.map((k) => { const g = groups.get(k); return { key: k, n: g.length, pearson: g.length >= MIN_POINTS ? stats(g.map((p) => p.x), g.map((p) => p.y)).pearson : null }; });
  }
  const sample = pts.length <= limitPoints ? pts : Array.from({ length: limitPoints }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (limitPoints - 1))]);
  return { ...head, ...s, points: sample, points_downsampled: sample.length < pts.length, ...(by ? { by_group: by } : {}), notes };
}

// ───────────── 10 heatmap ─────────────

export function heatmap(q) {
  const site = siteParam(q);
  const v = varMeta(site, one(q.var, 'var'));
  const agg = enumParam(q, 'agg', ['mean', 'sum'], 'mean');
  const { from, to } = dateRange(site, q, { days: 30, maxDays: 400 });
  const tz = site.timezone; const slotS = slotLength(site);
  const buckets = 86400 / slotS;
  const [a] = dayBounds(tz, from); const [, b] = dayBounds(tz, to);
  const acc = new Map(daysBetween(from, to).map((d) => [d, { sum: new Array(buckets).fill(0), n: new Array(buckets).fill(0) }]));
  const add = (date, tod, val) => {
    const row = acc.get(date);
    if (!row || val == null || !Number.isFinite(val)) return;
    const k = Math.floor(tod / (slotS / 60));
    row.sum[k] += val; row.n[k]++;
  };
  if (v.source === 'timeline') {
    const expr = TIMELINE_VARS[v.name].sql ?? v.name;
    for (const r of db.prepare(`SELECT local_date, tod_min, ${expr} AS v FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?`).all(site.id, a, b)) add(r.local_date, r.tod_min, r.v);
  } else {
    const res = plannerSeries(site.id, v.series.metric, a, b, { stepS: 'slot', source: v.series.source });
    for (let i = 0; i < res.n; i++) { const t = res.start + i * res.stepS; if (t >= a && t < b && res.values[i] != null) add(localDate(tz, t), todMinute(tz, t), res.values[i]); }
  }
  let min = null; let max = null;
  const rows = [...acc].map(([date, r]) => ({ date, cells: r.sum.map((s, k) => {
    if (!r.n[k]) return null;
    const val = agg === 'sum' ? s : s / r.n[k];
    min = min == null ? val : Math.min(min, val); max = max == null ? val : Math.max(max, val);
    return val;
  }) }));
  return { ...base(site), var: v.name, label: v.label, unit: v.unit, kind: v.kind, agg, from, to, slot_s: slotS, rows, tod_labels: Array.from({ length: buckets }, (_, k) => slotLabel(k, slotS)), min, max,
    note: 'cells are local wall-clock time of day: the repeated hour when clocks go back is aggregated into its cell, the skipped hour when they go forward is null' };
}

// ───────────── 8 validate ─────────────
//
// VALIDATION: every check says what it compared, how, the two values, the tolerance and the evidence.
//   source       re-derivation of the raw payloads behind the slot (adapters' pure normalisers);
//                published values read straight from the stored payloads (source_lookup:*); the
//                carbon intensity used; completeness of the facts behind the slot
//   consistency  the stored row against a rebuild from the facts now held; meter vs inverter clamp;
//                the inverter's daily counters against the 5-minute samples; energy balance of the
//                slot and the day; unit sanity
//   price        the unit rate used against the published rate row (rate_interval.raw_id -> its
//                payload), tax rule applied, standing charge share, cost arithmetic, export rate
//   forecast     the solar forecast of record, forecast error against the actual, temperature
// A day range aggregates the per-slot checks per day (worst status, counts, the worst slot as evidence).

const STATUS_RANK = { fail: 3, warn: 2, pass: 1, skip: 0 };
const ck = (id, group, title, how, fields) => ({ id, group, title, how, source_value: null, our_value: null, unit: null, diff: null, tolerance: null, status: 'skip', evidence: {}, explanation: '', ...fields });
const num = (v) => (v == null || !Number.isFinite(v) ? null : v);
const fx = (v, d = 4) => (v == null || !Number.isFinite(v) ? 'none' : Number(v).toFixed(d));
const POWER = { solar: 'solar_w', load: 'load_w', imp: 'grid_import_w', exp: 'grid_export_w', chg: 'battery_charge_w', dis: 'battery_discharge_w' };

// Everything the checks of a range read, once.
function loadCx(site, from, to, { slot = null } = {}) {
  const tz = site.timezone; const slotS = slotLength(site);
  const [a] = dayBounds(tz, from); const [, b] = dayBounds(tz, to);
  const sidOf = (metric, source) => findSeries('site', site.id, metric, source);
  let built; let pricing;
  if (slot != null) { const t = traceSlot(site.id, slot); built = t.built; pricing = t.trace.pricing ?? loadPricing(site.id, a, b); }
  else { built = buildSite(site.id, from, to, { dryRun: true }); pricing = loadPricing(site.id, a, b); }
  const rows = db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start').all(site.id, a, b);
  const power = Object.fromEntries(Object.entries(POWER).map(([k, m]) => [k, sidOf(m, 'sunsynk_5min')]));
  const socId = sidOf('battery_soc_pct', 'sunsynk_5min');
  const ids = [...Object.values(power), socId].filter((x) => x != null);
  const readings = ids.length ? db.prepare(`SELECT series_id, ts, value, raw_id FROM reading WHERE series_id IN (${ids.map(() => '?').join(',')}) AND ts >= ? AND ts < ? AND superseded_at IS NULL ORDER BY ts`).all(...ids, a - 300, b) : [];
  const intervals = (id, pad = 0) => (id == null ? [] : db.prepare('SELECT series_id, start_ts, end_ts, value, raw_id, recorded_at FROM interval_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND start_ts >= ? AND superseded_at IS NULL ORDER BY start_ts')
    .all(id, a - pad, b + pad, a - pad - 2 * 86400));
  const devices = db.prepare("SELECT * FROM device WHERE site_id = ? AND kind IN ('meter_import','meter_export','meter_gas') AND provider != 'env'").all(site.id);
  const meterId = (kind, metric) => { const d = devices.find((x) => x.kind === kind); return d ? findSeries('device', d.id, metric, 'octopus_meter') : null; };
  const gasDev = devices.find((d) => d.kind === 'meter_gas');
  const gasAttrs = gasDev ? (() => { try { return JSON.parse(gasDev.attrs || '{}'); } catch { return {}; } })() : {};
  const meters = { import: intervals(meterId('meter_import', 'grid_import_kwh')), export: intervals(meterId('meter_export', 'grid_export_kwh')),
    gas: intervals(gasDev ? meterId('meter_gas', gasAttrs.gasUnit?.unit === 'm3' ? 'gas_m3' : 'gas_kwh') : null) };
  const carbonId = site.carbon_region != null ? findSeries('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional') : null;
  const tempId = sidOf('outdoor_temp_c', 'open_meteo');
  const fcRows = (source) => { const id = sidOf('solar_kwh', source); return id == null ? [] : db.prepare('SELECT series_id, start_ts, end_ts, issued_at, value, raw_id FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts').all(id, a, b); };
  const carbon = intervals(carbonId);
  const cvId = gasAttrs.ldz ? findSeries('region', `ldz:${gasAttrs.ldz}`, 'gas_cv_mjm3', 'national_gas_cv') : null;
  const cvs = intervals(cvId, 86400);
  const gasM3 = gasAttrs.gasUnit?.unit === 'm3';
  const temps = tempId == null ? [] : db.prepare('SELECT series_id, ts, value, raw_id FROM reading WHERE series_id = ? AND ts >= ? AND ts < ? AND superseded_at IS NULL').all(tempId, a - 3600, b);
  const forecasts = { quartz: fcRows('quartz'), core_forecast: fcRows('core_forecast') };
  // Facts per slot, indexed once: readings in [slot - 300, slot + slotS) (a sample's hold can reach
  // into the next slot), interval facts and forecast periods by every slot they overlap.
  const phase = ((a % slotS) + slotS) % slotS;
  const fl = (t) => slotFloor(t, slotS, phase);
  const push = (m, k, x) => (m.get(k) || m.set(k, []).get(k)).push(x);
  const byReading = (list) => { const m = new Map(); for (const r of list) { const s0 = fl(r.ts); push(m, s0, r); const s1 = fl(r.ts + 300); if (s1 !== s0) push(m, s1, r); } return m; };
  const byPeriod = (list) => { const m = new Map(); for (const f of list) for (let s = fl(f.start_ts); s < f.end_ts; s += slotS) push(m, s, f); return m; };
  const recordOf = (list) => { const best = new Map(); for (const f of list) { const k = `${f.start_ts}|${f.end_ts}`; if (!best.has(k) || f.issued_at > best.get(k).issued_at) best.set(k, f); } return byPeriod([...best.values()]); };
  const idx = { readings: byReading(readings), import: byPeriod(meters.import), export: byPeriod(meters.export), gas: byPeriod(meters.gas), carbon: byPeriod(carbon), cv: byPeriod(cvs),
    quartz: recordOf(forecasts.quartz), core_forecast: recordOf(forecasts.core_forecast), temps: new Map(temps.map((r) => [r.ts, r])) };
  const at = new Map(); const pieces = new Map();
  return {
    site, tz, slotS, from, to, a, b, built, pricing, rows, readings, meters, power, socId, devices,
    // The facts of one slot (each list holds what overlaps it; readings from 5 minutes before).
    at: (slot) => at.get(slot) ?? at.set(slot, {
      readings: idx.readings.get(slot) ?? [], meters: { import: idx.import.get(slot) ?? [], export: idx.export.get(slot) ?? [], gas: idx.gas.get(slot) ?? [] },
      carbon: idx.carbon.get(slot) ?? [], cv: (idx.cv.get(slot) ?? []).find((f) => f.start_ts <= slot && f.end_ts > slot) ?? null, temp: idx.temps.get(floorTo(slot, 3600)) ?? null, forecasts: { quartz: idx.quartz.get(slot) ?? [], core_forecast: idx.core_forecast.get(slot) ?? [] },
    }).get(slot),
    pieces: (kind, slot) => { const k = `${kind}|${slot}`; return pieces.get(k) ?? pieces.set(k, pricePieces(pricing, kind, slot, slotS)).get(k); },
    rebuilt: new Map(built.hhRows.map((r) => [r.slot_start, r])),
    daily: Object.fromEntries(['solar_kwh', 'load_kwh', 'grid_import_kwh', 'grid_export_kwh', 'battery_charge_kwh', 'battery_discharge_kwh'].map((m) => [m, intervals(sidOf(m, 'sunsynk_daily'))])),
    carbon, carbonId, temps, tempId, forecasts, gasM3, gasLdz: gasAttrs.ldz ?? null,
    checks: db.prepare('SELECT * FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ?').all(site.id, from, to),
    days: db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ?').all(site.id, from, to),
    meta: seriesMetaOf(site), pc: payloadCache({ budget: slot != null ? Infinity : RANGE_PAYLOAD_BUDGET }), rederived: new Map(),
  };
}
function seriesMetaOf(site) { return new Map(siteSeries(site).map((s) => [s.id, s])); }
const overlapOf = (f, s, e) => Math.min(f.end_ts, e) - Math.max(f.start_ts, s);

// ── Words ──
// Every check's `how` and `explanation` are short plain sentences with the slot's own numbers in them.
const kw = (v, d = 3) => `${fx(v, d)} kWh`;
const mo = (cx, v, d = 2) => `${fx(v, d)} ${minorOf(cx.site.currency)}`;
const perKwh = (cx, v) => `${mo(cx, v)} per kWh`;
const minutes = (s) => `${Math.round(s / 60)} minutes`;
// A stored figure in words, by its column's unit.
function valWords(cx, field, v) {
  if (typeof v !== 'number') return v == null ? 'empty' : String(v);
  const unit = TIMELINE_VARS[field]?.unit;
  if (unit === 'kWh') return kw(v);
  if (unit === 'minor') return mo(cx, v);
  if (unit === 'minor/kWh') return perKwh(cx, v);
  if (unit === 'fraction') return pctWords(v);
  if (unit === '%') return `${fx(v, 1)}%`;
  return fx(v, 4);
}
const fieldWords = (field) => (TIMELINE_VARS[field]?.label ?? field.replace(/_/g, ' ')).toLowerCase();
const PROVIDER_WORDS = { sunsynk_5min: 'the inverter (Sunsynk)', sunsynk_daily: 'the inverter (Sunsynk daily totals)', octopus_meter: 'the smart meter (Octopus)', carbon_regional: 'the grid operator (Carbon Intensity)',
  open_meteo: 'the weather service (Open-Meteo)', national_gas_cv: 'National Gas', octopus_rates: 'the supplier (Octopus)', tariffscanner: 'Tariffscanner', tounify: 'tounify' };
const providerWords = (source) => PROVIDER_WORDS[source] ?? source;

// ── Per-slot checks ──
function slotChecks(cx, row) {
  const { slotS } = cx;
  const slot = row.slot_start; const end = slot + slotS; const h = slotS / 3600; const noun = slotNoun(slotS);
  const lin = (() => { try { return JSON.parse(row.lineage || '{}'); } catch { return {}; } })();
  const out = [];
  const ev = (o) => ({ ts: slot, ...o });

  // Stored row vs a rebuild from the facts held now.
  const rb = cx.rebuilt.get(slot) ?? null;
  const cmp = compareRows(row, rb);
  // The figure to show: the first number that differs (a rebuild over a changed row also marks it
  // restated, so the quality bits differ too; that is named in the list, not shown as the value).
  const first = cmp.diffs.find((d) => d.field !== 'quality' && typeof d.stored === 'number') ?? cmp.diffs[0];
  const stale = rb && row.method_version !== rb.method_version;
  const lineageOnly = rb && cmp.matches && !cmp.lineage_matches;
  const shown = cmp.diffs.filter((d) => d.field !== 'quality').slice(0, 4);
  out.push(ck('stored_vs_rebuild', 'consistency', 'The saved figures match a fresh calculation',
    `We worked the ${noun} out again from the data we hold now, exactly as the timeline is built (carrying on from the battery's saved state the day before), and compared every figure with the saved one.`,
    { source_value: first ? first.recomputed : null, our_value: first ? first.stored : null, unit: first ? (TIMELINE_VARS[first.field]?.unit ?? null) : null, diff: first?.diff ?? null, tolerance: 1e-6,
      status: !rb ? 'skip' : lineageOnly ? 'warn' : cmp.matches ? 'pass' : stale ? 'warn' : 'fail', evidence: ev({ table: 'site_hh' }),
      explanation: !rb ? `The fresh calculation did not produce this ${noun}.`
        : lineageOnly ? `Every number matches. Only the saved note of where the numbers came from is older (it lacks ${cmp.lineage_diffs.map((d) => d.key).join(', ')}); recalculating the day would refresh it.`
          : cmp.matches ? `Every saved figure matches the fresh calculation.`
            : `${cmp.diffs.length} figure${cmp.diffs.length > 1 ? 's differ' : ' differs'}: ${shown.map((d) => `${fieldWords(d.field)} is saved as ${valWords(cx, d.field, d.stored)} but works out as ${valWords(cx, d.field, d.recomputed)}`).join('; ')}${cmp.diffs.some((d) => d.field === 'quality') ? ' (so it would also be marked as revised)' : ''}. ${stale ? 'The saved figures were made with an older method.' : 'The saved timeline is out of date (data arrived or changed after it was built) or was edited.'}`,
      diffs: cmp.diffs.slice(0, 20), lineage_diffs: cmp.lineage_diffs.map((d) => d.key) }));

  // Completeness: the facts behind the slot.
  const F = cx.at(slot);
  const inSlot = F.readings.filter((r) => r.ts >= slot && r.ts < end);
  const expected = slotS / 300;
  const counts = Object.fromEntries(Object.entries(cx.power).filter(([, id]) => id != null).map(([k, id]) => [k, inSlot.filter((r) => r.series_id === id).length]));
  const meterCover = F.meters.import.filter((f) => f.value != null).reduce((s, f) => s + Math.max(0, overlapOf(f, slot, end)), 0);
  const expectMeter = cx.devices.some((d) => d.kind === 'meter_import');
  const minCount = Object.values(counts).length ? Math.min(...Object.values(counts)) : null;
  // One five-minute sample may fall either side of a boundary (the inverter's clock drifts), as trust.js counts.
  const complete = (minCount == null || minCount >= expected - 1) && (!expectMeter || meterCover >= slotS);
  const short = Object.entries(counts).filter(([, n]) => n < expected - 1).map(([k, n]) => `${POWER_WORDS[k]} ${n} of ${expected}`);
  out.push(ck('completeness', 'source', 'All the readings are there',
    `We counted the inverter's five-minute readings in the ${noun} (${expected} expected for each flow; one fewer is fine, because a reading can fall either side of the boundary) and checked that the smart meter covers the whole ${noun}.`,
    { source_value: expected, our_value: minCount, unit: 'readings', diff: minCount == null ? null : minCount - expected, tolerance: 1,
      status: minCount == null && !expectMeter ? 'skip' : complete ? 'pass' : 'warn', evidence: ev({ table: 'reading', series_id: cx.power.solar ?? null }),
      explanation: minCount == null && !expectMeter ? `This home sends no inverter readings and has no smart meter.`
        : complete ? `All there: at least ${minCount} of ${expected} readings for each flow${expectMeter ? ` and the meter covers all ${minutes(slotS)}` : ''}.`
          : `Something is missing: ${[...short, ...(expectMeter && meterCover < slotS ? [`the smart meter covers ${minutes(meterCover)} of ${minutes(slotS)}`] : [])].join('; ')}.`,
      counts, meter_cover_s: meterCover }));

  // Meter vs inverter clamp.
  const clampWords = 'the inverter\'s own sensor on the grid cable (its "clamp")';
  for (const [dir, col, key] of [['import', 'grid_import', 'imp'], ['export', 'grid_export', 'exp']]) {
    const meterUsed = lin[dir] === 'octopus_meter';
    const clamp = lin.ct?.[key];
    const meterFact = F.meters[dir][0];
    const id = `meter_vs_ct${dir === 'export' ? '_export' : ''}`;
    const title = `The smart meter and the inverter agree (${dir})`;
    const how = `We compared what the smart meter measured ${dir === 'import' ? 'coming from' : 'going to'} the grid with what ${clampWords} measured in the same ${noun}. The meter is the official figure; the clamp is a cross-check.`;
    if (!meterUsed || clamp == null) {
      out.push(ck(id, 'consistency', title, how, { status: 'skip', unit: 'kWh', evidence: ev({}),
        explanation: !meterUsed ? `There is no smart meter ${dir} reading for this ${noun}${lin[dir] === 'sunsynk_ct' ? ', so the clamp figure is used on its own' : ''}: nothing to compare.` : `The inverter sent no readings for this ${noun}.` }));
      continue;
    }
    const meter = row[col]; const diff = meter - clamp; const tol = Math.max(0.05 * h * 2, 0.1 * Math.abs(meter));
    const ok = Math.abs(diff) <= tol;
    out.push(ck(id, 'consistency', title, how,
      { source_value: meter, our_value: clamp, unit: 'kWh', diff, tolerance: tol, status: ok ? 'pass' : 'warn',
        evidence: ev({ table: 'interval_fact', series_id: meterFact?.series_id ?? null, raw_id: meterFact?.raw_id ?? null }),
        explanation: `The meter measured ${kw(meter)}, the clamp ${kw(clamp)}. ${ok ? `They agree (we allow up to ${kw(tol)} difference).` : `They differ by ${kw(Math.abs(diff))}, more than the ${kw(tol)} we allow; we use the meter's figure.`}` }));
  }

  // Energy balance: in = out + loss.
  if (row.state === 'missing') out.push(ck('balance_slot', 'consistency', 'Energy in equals energy out', 'We add up what came in and what went out.', { status: 'skip', unit: 'kWh', evidence: ev({}), explanation: `The ${noun} is missing, so there is nothing to add up.` }));
  else {
    const inn = (row.solar ?? 0) + (row.grid_import ?? 0) + (row.battery_discharge ?? 0);
    const outE = (row.home ?? 0) + (row.grid_export ?? 0) + (row.battery_charge ?? 0);
    const loss = (row.solar_to_loss ?? 0) + (row.battery_to_loss ?? 0) + (row.grid_to_loss ?? 0);
    const diff = inn - outE - loss;
    out.push(ck('balance_slot', 'consistency', 'Energy in equals energy out', 'We added up what came in (solar, grid and battery) and what went out (house, export, battery charging and what the inverter used). The two should be equal.',
      { source_value: inn, our_value: outE + loss, unit: 'kWh', diff, tolerance: 0.02, status: Math.abs(diff) <= 0.02 ? 'pass' : 'warn', evidence: ev({ table: 'site_hh' }),
        explanation: `In: ${kw(inn)}. Out: ${kw(outE)}, plus ${kw(loss)} used by the inverter. ${Math.abs(diff) <= 0.02 ? 'They match.' : `${kw(-diff)} of the export or battery charging is not covered by anything that came in: the meter and the inverter disagree slightly.`}` }));
  }

  // Gas: the meter's reading converted to kWh (m3 x 1.02264 x calorific value / 3.6).
  if (F.meters.gas.length || row.gas != null) {
    const share = F.meters.gas.filter((f) => f.value != null).reduce((t, f) => t + (f.value * overlapOf(f, slot, end)) / (f.end_ts - f.start_ts), 0);
    const cover = F.meters.gas.filter((f) => f.value != null).reduce((t, f) => t + overlapOf(f, slot, end), 0);
    const want = cover < slotS ? null : cx.gasM3 ? (F.cv ? (share * 1.02264 * F.cv.value) / 3.6 : null) : share;
    const gDiff = want != null && row.gas != null ? row.gas - want : null;
    const ok = gDiff != null && Math.abs(gDiff) <= 1e-6;
    out.push(ck('gas_conversion', 'consistency', 'Gas turned into kWh correctly', cx.gasM3
      ? `The gas meter measures volume (m3) but gas is billed in kWh. We redid the sum: m3 x 1.02264 (a standard correction for temperature and pressure) x the energy in the gas that day (published by National Gas for ${cx.gasLdz}) / 3.6.`
      : 'The gas meter reports kWh; we checked the saved gas figure is the meter\'s.',
      { source_value: want, our_value: row.gas, unit: 'kWh', diff: gDiff, tolerance: 1e-6,
        status: want == null && row.gas == null ? 'skip' : ok ? 'pass' : 'fail',
        evidence: ev({ table: 'interval_fact', series_id: F.meters.gas[0]?.series_id ?? null, raw_id: F.meters.gas[0]?.raw_id ?? null }),
        explanation: want == null && row.gas == null ? (cover < slotS ? `The gas meter reading for this ${noun} has not arrived yet.` : 'National Gas has not yet published the energy in the gas for that day.')
          : cx.gasM3 ? `${fx(share, 3)} m3 x 1.02264 x ${fx(F.cv?.value, 1)} MJ/m3 / 3.6 = ${kw(want)}; saved ${kw(row.gas)}${ok ? '.' : ': they differ.'}` : `The meter read ${kw(share)}; saved ${kw(row.gas)}${ok ? '.' : ': they differ.'}` }));
  }

  // Prices.
  out.push(...priceChecks(cx, row));

  // Carbon intensity used = the source's value for the period.
  const carbonTitle = 'The carbon figure is the grid operator\'s';
  const carbonHow = `We checked the carbon intensity used for the ${noun} against the value the grid operator published for that time.`;
  if (cx.carbonId == null) out.push(ck('carbon_used', 'source', carbonTitle, carbonHow, { status: 'skip', unit: 'gCO2/kWh', evidence: ev({}), explanation: 'This home has no carbon region, so no carbon figure is used.' }));
  else {
    const fs_ = F.carbon.filter((f) => f.value != null);
    const w = fs_.reduce((s, f) => s + overlapOf(f, slot, end), 0);
    const src = w ? fs_.reduce((s, f) => s + f.value * overlapOf(f, slot, end), 0) / w : null;
    const diff = src != null && row.carbon_intensity != null ? row.carbon_intensity - src : null;
    out.push(ck('carbon_used', 'source', carbonTitle, carbonHow,
      { source_value: src, our_value: row.carbon_intensity, unit: 'gCO2/kWh', diff, tolerance: 1e-6,
        status: src == null && row.carbon_intensity == null ? 'skip' : diff != null && Math.abs(diff) <= 1e-6 ? 'pass' : 'fail',
        evidence: ev({ table: 'interval_fact', series_id: cx.carbonId, raw_id: fs_[0]?.raw_id ?? null }),
        explanation: src == null && row.carbon_intensity == null ? 'The grid operator published no figure for this time.'
          : diff != null && Math.abs(diff) <= 1e-6 ? `The grid's carbon intensity was ${fx(src, 0)} g CO2 per kWh, and that is the figure used.`
            : `We used ${fx(row.carbon_intensity, 0)} g CO2 per kWh, but the grid operator's figure is ${fx(src, 0)}.` }));
  }

  out.push(...forecastChecks(cx, row));
  out.push(...lookupChecks(cx, row));
  out.push(unitSanity(cx, row));
  return out;
}
const POWER_WORDS = { solar: 'solar', load: 'house', imp: 'grid import', exp: 'grid export', chg: 'battery charging', dis: 'battery discharging' };

function priceChecks(cx, row) {
  const { tz, slotS, pricing } = cx;
  const slot = row.slot_start; const noun = slotNoun(slotS);
  const out = [];
  const ev = (o) => ({ ts: slot, ...o });
  if (row.import_rate_ex == null) {
    out.push(ck('rate_used', 'price', 'The price used is the right one', 'We looked for the import price in force.', { status: 'fail', unit: 'minor/kWh', evidence: ev({ table: 'rate_interval' }), explanation: `No import price covers this ${noun}, so it is not costed.` }));
    return out;
  }
  for (const [dir, kind] of [['import', 'meter_import'], ['export', 'meter_export']]) {
    const pieces = cx.pieces(kind, slot);
    if (dir === 'export' && (!pieces.length || pieces.every((p) => p.price == null))) continue;
    const Dir = dir === 'import' ? 'Import' : 'Export';
    // The published rate row of each part of the slot.
    const checked = []; const missing = [];
    for (const p of pieces) {
      const rate = p.rate;
      if (!rate) { missing.push(`no price row covers ${hhmmOf(tz, p.from)}`); continue; }
      if (rate.raw_id == null) { missing.push(`this price was not downloaded from a supplier (it was typed in or generated for the demo), so there is no saved copy to compare with`); continue; }
      const pl = cx.pc.get(rate.raw_id);
      let pub = null;
      if (!pl?.r) pub = { missing: `the saved copy (${rate.raw_id}) was not found` };
      else if (pl.text == null) pub = { missing: `the saved copy (${rate.raw_id}) is not on this computer` };
      else if (RATE_LOOKUP[pl.r.source]) pub = RATE_LOOKUP[pl.r.source](pl.body, rate);
      else if (['tariffscanner', 'tounify'].includes(pl.r.source)) {
        const d = cx.rederived.get(rate.raw_id) ?? cx.rederived.set(rate.raw_id, derivedRates(pl.r, pl.body, cx.site)).get(rate.raw_id);
        const x = d.rows.find((y) => (d.anyTariff || y.tariff_code === p.tariff) && y.component === 'unit' && y.register === rate.register && (y.payment_method ?? 'ANY') === (rate.payment_method ?? 'ANY') && y.valid_from <= rate.valid_from && (y.valid_to == null || y.valid_to > rate.valid_from));
        pub = x ? { value: x.value, valid_from: x.valid_from, valid_to: x.valid_to } : { missing: 'the saved copy has no such row' };
      } else pub = { missing: `we cannot read price lists from ${pl.r.source}` };
      checked.push({ p, rate, pub });
    }
    const bad_ = checked.filter((c) => c.pub.value == null || Math.abs(c.pub.value - c.rate.price_ex) > 1e-9 || (c.pub.valid_to !== undefined && c.pub.valid_from === c.rate.valid_from && (c.pub.valid_to ?? null) !== (c.rate.valid_to ?? null)));
    const worst = bad_[0] ?? checked[0];
    const until = (t) => (t == null ? 'further notice' : `${hhmmOf(tz, t)} on ${dayWords(localDate(tz, t))}`);
    const uniq = [...new Set(checked.map((c) => c.rate.price_ex))];
    out.push(ck(`rate_published${dir === 'export' ? '_export' : ''}`, 'price', `${Dir} price matches the supplier's list`,
      `We opened the saved copy of the price list the supplier sent us and checked that the ${dir} price we used, and the dates it applies between, are exactly what it says.`,
      { source_value: worst?.pub.value ?? null, our_value: worst?.rate.price_ex ?? null, unit: 'minor/kWh', diff: worst?.pub.value != null ? worst.rate.price_ex - worst.pub.value : null, tolerance: 1e-9,
        status: !checked.length ? 'skip' : bad_.length ? 'fail' : 'pass', evidence: ev({ table: 'rate_interval', raw_id: worst?.rate.raw_id ?? null, rate_id: worst?.rate.rate_id ?? null }),
        explanation: !checked.length ? `${(missing[0] ?? 'there is no price row to follow').replace(/^./, (c) => c.toUpperCase())}.`
          : bad_.length ? `We used ${perKwh(cx, worst.rate.price_ex)} before VAT, valid until ${until(worst.rate.valid_to)}, but the supplier's list ${worst.pub.value == null ? `could not be matched: ${worst.pub.missing}` : `says ${perKwh(cx, worst.pub.value)}, valid until ${until(worst.pub.valid_to)}`}.`
            : `The ${dir} price we used, ${uniq.map((v) => perKwh(cx, v)).join(' and ')} before VAT, is exactly what the supplier published.` }));
    // The rate stored on the row = the rate rows over the slot (+ per-kWh levies), time-weighted.
    const priced = pieces.filter((p) => p.rate && p.unit_ex != null);
    const src = priced.length === pieces.length && pieces.length ? pieces.reduce((s, p) => s + (p.rate.price_ex + (p.unit_ex - p.supply_ex)) * (p.to - p.from), 0) / slotS : null;
    const ours = dir === 'import' ? row.import_rate_ex : row.export_rate != null && pieces[0]?.vat != null ? row.export_rate / (1 + pieces[0].vat) : null;
    const diff = src != null && ours != null ? ours - src : null;
    const ok = diff != null && Math.abs(diff) <= 1e-6;
    const varies = new Set(pieces.map((p) => p.unit_ex)).size > 1;
    const quarterly = pieces.every((p) => p.to - p.from === 900) && pieces.length <= 4;
    const parts = varies ? (quarterly ? pieces.map((p, i) => `${mo(cx, p.unit_ex)} for the ${['first', 'second', 'third', 'fourth'][i]} quarter-hour`) : pieces.map((p) => `${mo(cx, p.unit_ex)} from ${hhmmOf(tz, p.from)} to ${hhmmOf(tz, p.to)}`)) : [];
    out.push(ck(`rate_used${dir === 'export' ? '_export' : ''}`, 'price', `${Dir} price for the ${noun} adds up`,
      `We took the price in force for each part of the ${noun} (if the price changed part-way, each part counts for its share of the time) and checked it gives the ${dir} price saved for the ${noun}.`,
      { source_value: src, our_value: ours, unit: 'minor/kWh', diff, tolerance: 1e-6, status: src == null ? 'skip' : ok ? 'pass' : 'fail',
        evidence: ev({ table: 'rate_interval', rate_id: priced[0]?.rate.rate_id ?? null, raw_id: priced[0]?.rate.raw_id ?? null }),
        explanation: src == null ? `Part of the ${noun} has no price.`
          : `${varies ? `Price: ${parts.join(' and ')}, so the ${noun} counts as the average ${mo(cx, src)} before VAT.` : `The price was ${perKwh(cx, src)} before VAT for the whole ${noun}.`} Saved: ${mo(cx, ours)}${ok ? '. They match.' : '. They differ.'}` }));
  }

  // Tax: the rule in force, read from the rule tables.
  const tax = taxInForce(cx, 'electricity', 'import', slot);
  const tDiff = tax.vat != null && row.import_vat != null ? row.import_vat - tax.vat : null;
  const tOk = tDiff != null && Math.abs(tDiff) <= 1e-9;
  out.push(ck('tax_rule', 'price', 'The right VAT rate is applied', `We looked up the tax rate in force on that date and checked it is the one added to the price.`,
    { source_value: tax.vat, our_value: row.import_vat, unit: 'fraction', diff: tDiff, tolerance: 1e-9, status: tax.vat == null ? 'skip' : tOk ? 'pass' : 'fail',
      evidence: ev({ table: tax.source, id: tax.ids?.[0] ?? null }), explanation: `${tax.explanation} ${pctWords(row.import_vat)} was applied${tOk ? '.' : ': they differ.'}` }));

  // Standing charge per slot = the day's amount x slot length / day length.
  const date = row.local_date; const [ds, de] = dayBounds(tz, date);
  const pi = priceAt(pricing, 'meter_import', slot);
  const pg = row.gas != null ? priceAt(pricing, 'meter_gas', slot) : null;
  const perDay = pi ? fixedPerDay(pi, slot, tz) + (pg ? fixedPerDay(pg, slot, tz) : 0) : null;
  const want = perDay != null ? (perDay * slotS) / (de - ds) : null;
  const sDiff = want != null && row.standing_cost != null ? row.standing_cost - want : null;
  const sOk = sDiff != null && Math.abs(sDiff) <= 1e-6;
  out.push(ck('standing_share', 'price', `The standing charge is shared fairly`, `The standing charge is a daily amount${pg ? ' (electricity and gas)' : ''}. We shared it over the day by time and checked this ${noun}'s share.`,
    { source_value: want, our_value: row.standing_cost, unit: 'minor', diff: sDiff, tolerance: 1e-6, status: want == null ? 'skip' : sOk ? 'pass' : 'fail', evidence: ev({ table: 'rate_interval' }),
      explanation: want == null ? 'No standing charge is in force.' : `${mo(cx, perDay)} a day x ${minutes(slotS)} / ${(de - ds) / 3600} hours in ${dayWords(date)} = ${mo(cx, want, 4)}; saved ${mo(cx, row.standing_cost, 4)}${sOk ? '.' : ': they differ.'}` }));

  // Cost arithmetic.
  const inc = row.import_rate_ex * (1 + row.import_vat);
  const gasCost = row.gas != null && row.gas_rate_ex != null ? row.gas * row.gas_rate_ex * (1 + row.gas_vat) : (row.gas != null ? null : 0);
  const gridKwh = (row.grid_to_home ?? 0) + (row.grid_to_battery ?? 0) + (row.grid_to_loss ?? 0);
  const expKwh = (row.solar_to_grid ?? 0) + (row.battery_to_grid ?? 0);
  const total = gridKwh * inc + (row.standing_cost ?? 0) + (gasCost ?? 0) - expKwh * (row.export_rate ?? 0);
  const cDiff = row.total_cost != null ? row.total_cost - total : null;
  const cOk = cDiff != null && Math.abs(cDiff) <= 1e-6;
  out.push(ck('cost_arithmetic', 'price', 'The cost adds up', 'We redid the sum: energy from the grid x its price, plus the standing charge and gas, minus what exports earned.',
    { source_value: total, our_value: row.total_cost, unit: 'minor', diff: cDiff, tolerance: 1e-6, status: cDiff == null ? 'skip' : cOk ? 'pass' : 'fail', evidence: ev({ table: 'site_hh' }),
      explanation: `${kw(gridKwh)} x ${mo(cx, inc)} + ${mo(cx, row.standing_cost)} standing${row.gas != null ? ` + ${mo(cx, gasCost)} gas` : ''}${expKwh > 0 ? ` - ${kw(expKwh)} x ${mo(cx, row.export_rate)} for export` : ''} = ${mo(cx, total)}; saved ${mo(cx, row.total_cost)}${cOk ? '.' : `: ${mo(cx, Math.abs(cDiff))} ${cDiff > 0 ? 'too much' : 'too little'}.`}` }));
  return out;
}
const hhmmOf = (tz, ts) => { const p = zonedParts(tz, ts); return `${pad2(p.hh)}:${pad2(p.mm)}`; };

// The percentage tax in force for one fuel and direction, read from tax_rule (or vat_rate).
function taxInForce(cx, fuel, direction, ts) {
  const { site } = cx;
  const rules = site.country ? db.prepare(`SELECT * FROM tax_rule WHERE country = ? AND fuel = ? AND direction = ? AND IFNULL(customer_class, 'domestic') = 'domestic' AND superseded_at IS NULL
    AND valid_from <= ? AND IFNULL(valid_to, 9000000000) > ? ORDER BY seq`).all(site.country, fuel, direction, ts, ts) : [];
  const agreement = cx.pricing.agreements.find((a) => a.kind === (direction === 'export' ? 'meter_export' : fuel === 'gas' ? 'meter_gas' : 'meter_import') && a.valid_from <= ts && (a.valid_to == null || a.valid_to > ts));
  const pct = rules.filter((r) => r.kind === 'percent' && r.applies_to !== 'fixed');
  const when = dayWords(localDate(site.timezone, ts));
  if (rules.length) {
    const bySeq = new Map();
    for (const r of pct) bySeq.set(r.seq, (bySeq.get(r.seq) ?? 0) + r.value);
    const groups = [...bySeq.values()];
    const vat = groups.length <= 1 ? (groups[0] ?? 0) : groups.reduce((m, v) => m * (1 + v), 1) - 1;
    const unverified = rules.some((r) => r.unverified === 1);
    return { source: 'tax_rule', vat, ids: rules.map((r) => r.id),
      explanation: `${pct.length ? `The tax on ${fuel} on ${when} was ${pct.map((r) => `${pctWords(r.value)} ${r.code.toUpperCase()}`).join(' and ')}${groups.length > 1 ? ' (one on top of the other)' : ''}` : `No percentage tax applied to ${fuel} on ${when}`}${unverified ? ' (a stand-in rate, not yet checked against an official source)' : ''}${agreement?.taxes_in_price === 1 ? '; the supplier\'s prices already include the other levies' : ''}.` };
  }
  if (site.country == null || site.country === 'GB') {
    const v = db.prepare('SELECT * FROM vat_rate WHERE fuel = ? AND direction = ? AND valid_from <= ? AND IFNULL(valid_to, 9000000000) > ?').get(fuel, direction, ts, ts);
    return { source: 'vat_rate', vat: v ? v.rate : 0, ids: v ? [v.id ?? null] : [], explanation: v ? `UK VAT on ${fuel} was ${pctWords(v.rate)} on ${when}.` : `No UK VAT rate is recorded for ${when}, so 0%.` };
  }
  return { source: 'tax_rule', vat: 0, ids: [], explanation: `We hold no tax rules for ${site.country}, so taxes are taken as 0% (an assumption).` };
}

function forecastChecks(cx, row) {
  const { tz, slotS } = cx;
  const slot = row.slot_start; const end = slot + slotS; const noun = slotNoun(slotS);
  const out = [];
  const ev = (o) => ({ ts: slot, ...o });
  // Forecast of record: per period the latest issue made before it started; Quartz first, our own
  // forecast for the slots Quartz does not cover; a period straddling the slot counts by its share.
  const pick = (list) => { const best = new Map(); for (const f of list) if (f.start_ts < end && f.end_ts > slot && (!best.has(`${f.start_ts}|${f.end_ts}`) || f.issued_at > best.get(`${f.start_ts}|${f.end_ts}`).issued_at)) best.set(`${f.start_ts}|${f.end_ts}`, f); return [...best.values()]; };
  const F = cx.at(slot);
  let used = pick(F.forecasts.quartz); let source = 'quartz';
  if (!used.length) { used = pick(F.forecasts.core_forecast); source = 'core_forecast'; }
  const part = (f) => (f.start_ts >= slot && f.end_ts <= end ? (f.value || 0) : ((f.value || 0) * overlapOf(f, slot, end)) / (f.end_ts - f.start_ts));
  const rec = used.length ? used.reduce((s, f) => s + part(f), 0) : null;
  const rDiff = rec != null && row.solar_forecast != null ? row.solar_forecast - rec : null;
  const rOk = rDiff != null && Math.abs(rDiff) <= 1e-6;
  const lastIssue = used.length ? Math.max(...used.map((f) => f.issued_at)) : null;
  out.push(ck('solar_forecast_record', 'forecast', 'The saved forecast was made in advance', `We looked up the solar forecast made before this ${noun} started (the latest one issued in advance, never one made afterwards) and checked it is the one saved.`,
    { source_value: rec, our_value: row.solar_forecast, unit: 'kWh', diff: rDiff, tolerance: 1e-6,
      status: rec == null && row.solar_forecast == null ? 'skip' : rOk ? 'pass' : 'fail',
      evidence: ev({ table: 'forecast_fact', series_id: used[0]?.series_id ?? null, raw_id: used[0]?.raw_id ?? null }),
      explanation: rec == null && row.solar_forecast == null ? `No solar forecast was made before this ${noun}.`
        : `The forecast made at ${hhmmOf(tz, lastIssue)} on ${dayWords(localDate(tz, lastIssue))} (${source === 'quartz' ? 'Quartz' : 'our own forecast'}) said ${kw(rec)}; saved ${kw(row.solar_forecast)}${rOk ? '.' : ': they differ.'}` }));
  // Forecast error against what the panels made.
  const eTitle = 'How good the solar forecast was';
  const eHow = `We compared the forecast made in advance with the solar the panels actually made. A big miss means the forecast was off, not that the data is wrong.`;
  if (row.solar_forecast != null && row.solar != null) {
    const err = row.solar - row.solar_forecast; const tol = Math.max(0.2 * (slotS / 1800), 0.5 * Math.max(row.solar, row.solar_forecast));
    out.push(ck('solar_forecast_error', 'forecast', eTitle, eHow,
      { source_value: row.solar, our_value: row.solar_forecast, unit: 'kWh', diff: err, tolerance: tol, status: Math.abs(err) <= tol ? 'pass' : 'warn', evidence: ev({ table: 'site_hh' }),
        explanation: `Forecast ${kw(row.solar_forecast)}, actual ${kw(row.solar)}: ${Math.abs(err) < 0.0005 ? 'spot on' : `${kw(Math.abs(err))} ${err > 0 ? 'more' : 'less'} than forecast${row.solar_forecast > 0 ? ` (${fx(Math.abs(err / row.solar_forecast) * 100, 0)}%)` : ''}`}. ${Math.abs(err) <= tol ? 'That is within the normal range' : 'That is a bigger miss than usual'} (up to ${kw(tol)}).` }));
  } else out.push(ck('solar_forecast_error', 'forecast', eTitle, eHow, { status: 'skip', unit: 'kWh', evidence: ev({}), explanation: `There was no forecast or no solar reading for this ${noun}.` }));
  // Temperature: the hourly reading of the hour holding the slot start.
  const hour = floorTo(slot, 3600);
  const t = F.temp;
  const tDiff = t && row.outdoor_temp != null ? row.outdoor_temp - t.value : null;
  const tOk = tDiff != null && Math.abs(tDiff) <= 1e-9;
  out.push(ck('temperature', 'forecast', 'The outdoor temperature is the weather service\'s', `We checked the outdoor temperature saved for the ${noun} against the weather service's reading for that hour.`,
    { source_value: t?.value ?? null, our_value: row.outdoor_temp, unit: 'degC', diff: tDiff, tolerance: 1e-9, status: !t && row.outdoor_temp == null ? 'skip' : tOk ? 'pass' : 'fail',
      evidence: ev({ table: 'reading', series_id: cx.tempId, raw_id: t?.raw_id ?? null, ts: hour }),
      explanation: !t && row.outdoor_temp == null ? 'The weather service has no reading for that hour.' : `The weather service gave ${fx(t?.value, 1)} °C at ${hhmmOf(tz, hour)}; saved ${fx(row.outdoor_temp, 1)} °C${tOk ? '.' : ': they differ.'}` }));
  return out;
}

// Published values: every fact behind the slot looked up in its own payload.
function lookupChecks(cx, row) {
  const { tz } = cx;
  const slot = row.slot_start;
  const F = cx.at(slot);
  const facts = [
    ...F.readings.map((r) => ({ ...r, kind: 'reading' })),
    ...[...F.meters.import, ...F.meters.export, ...F.meters.gas, ...F.carbon].map((f) => ({ ...f, kind: 'interval' })),
    ...(F.temp ? [{ ...F.temp, kind: 'reading' }] : []),
    ...(F.cv && F.meters.gas.length ? [{ ...F.cv, kind: 'interval' }] : []),
  ];
  const bySource = new Map();
  for (const f of facts) {
    const meta = cx.meta.get(f.series_id);
    if (!meta) continue;
    (bySource.get(meta.source) || bySource.set(meta.source, []).get(meta.source)).push({ f, meta });
  }
  const out = [];
  for (const [source, list] of bySource) {
    const L = LOOKUPS[source];
    const who = providerWords(source);
    const res = list.map(({ f, meta }) => ({ f, meta, pub: L ? publishedValue(cx.pc, f, meta, tz) : { unsupported: true } }));
    const found = res.filter((x) => x.pub.value !== undefined);
    const mism = found.filter((x) => x.pub.value == null ? x.f.value != null : Math.abs(Number(x.pub.value) - x.f.value) > 1e-9);
    const missing = res.filter((x) => x.pub.value === undefined);
    const worst = mism[0] ?? found[0] ?? res[0];
    const unit = worst?.meta.unit ?? '';
    out.push(ck(`source_lookup:${source}`, 'source', `Our numbers match what ${who} sent`,
      L ? `We opened the saved copy of what ${who} sent us and checked every stored number against it (${L.plain}).` : `We cannot read ${who}'s replies yet.`,
      { source_value: worst?.pub.value ?? null, our_value: worst?.f.value ?? null, unit: worst?.meta.unit ?? null, diff: worst?.pub.value != null ? worst.f.value - Number(worst.pub.value) : null, tolerance: 1e-9,
        status: !L || !found.length ? 'skip' : mism.length ? 'fail' : 'pass',
        evidence: { ts: worst?.f.ts ?? worst?.f.start_ts ?? slot, raw_id: worst?.f.raw_id ?? null, series_id: worst?.f.series_id ?? null, table: worst?.f.kind === 'reading' ? 'reading' : 'interval_fact' },
        explanation: !L ? `We cannot read ${who}'s replies yet.` : !found.length ? `We could not check ${missing.length === 1 ? 'the number' : `the ${missing.length} numbers`}: ${missing[0]?.pub.missing ?? 'no saved copy'}.`
          : mism.length ? `${mism.length} of ${found.length} numbers differ: ${worst.meta.metric.replace(/_/g, ' ')} is stored as ${fx(worst.f.value)} ${unit} but the copy says ${fx(Number(worst.pub.value))} ${unit}.`
            : `${found.length > 1 ? `All ${found.length} numbers match` : 'The number matches'} what ${who} sent (${found.length > 1 ? 'for example ' : ''}${fx(worst.f.value, unit === 'W' ? 0 : 3)} ${unit}).${missing.length ? ` ${missing.length} could not be checked: ${missing[0].pub.missing ?? 'no saved copy'}.` : ''}`,
        checked: found.length, mismatched: mism.length, not_found: missing.length - missing.filter((x) => x.pub.deferred).length, not_opened: missing.filter((x) => x.pub.deferred).length }));
  }
  return out;
}

// Re-derivation of the payloads behind a set of facts (supported sources), one check per payload;
// the unsupported sources one 'skip' each.
function rederiveChecks(cx, rawIds) {
  const out = []; const skipped = new Map();
  const ids = [...new Set(rawIds.filter((x) => x != null))].sort((a, b) => a - b);
  // Sources first (no body read): only payloads of a source with a pure normaliser are opened.
  const sourceOf = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT p.id, so.code AS source FROM raw_payload p JOIN source so ON so.id = p.source_id WHERE p.id IN (${part.map(() => '?').join(',')})`).all(...part)) sourceOf.set(r.id, r.source);
  }
  const how = 'We re-ran the code that turns the provider\'s reply into our rows on the saved copy of the reply, and compared the result with what we stored.';
  for (const id of ids) {
    const source = sourceOf.get(id);
    if (!source) continue;
    if (!['tariffscanner', 'tounify'].includes(source)) { (skipped.get(source) || skipped.set(source, []).get(source)).push(id); continue; }
    const p = cx.pc.get(id);
    const res = rederive(p.r, p.json ? p.body : null, cx.site);
    const d = res.diffs[0];
    out.push(ck('rederive', 'source', `A saved reply from ${providerWords(source)} reads the same again`, how,
      { source_value: d?.rederived?.value ?? null, our_value: d?.stored?.value ?? null, unit: 'minor/kWh', diff: d?.rederived && d?.stored ? d.stored.value - d.rederived.value : null, tolerance: 1e-9,
        status: res.ok ? 'pass' : 'fail', evidence: { raw_id: id, table: 'rate_interval' },
        explanation: res.ok ? `All ${res.stored_count} stored price rows match what the reply says.`
          : `${res.diff_count ?? 0} of ${res.stored_count} stored price rows differ${d?.stored && d?.rederived ? `: one is stored as ${perKwh(cx, d.stored.value)} but the reply says ${perKwh(cx, d.rederived.value)}` : ''}${res.reason ? ` (${res.reason})` : ''}.` }));
  }
  for (const [source, list] of skipped) {
    out.push(ck('rederive', 'source', `Saved replies from ${providerWords(source)} read the same again`, how,
      { status: 'skip', evidence: { raw_id: list[0], table: 'raw_payload' },
        explanation: `${list.length} saved repl${list.length > 1 ? 'ies' : 'y'} from ${providerWords(source)} ${list.length > 1 ? 'lie' : 'lies'} behind these figures. The code that reads them also saves as it reads, so it cannot safely be re-run on its own; their numbers are checked against the saved copies directly instead (see "${source === 'octopus_rates' ? 'Import price matches the supplier\'s list' : `Our numbers match what ${providerWords(source)} sent`}").`,
        reason: NOT_PURE[source] ?? null, raw_ids: list.slice(0, 50) }));
  }
  return out;
}

function unitSanity(cx, row) {
  const { site, slotS } = cx; const h = slotS / 3600; const noun = slotNoun(slotS);
  const limits = {
    solar: site.pv_kwp ? site.pv_kwp * h * 1.2 : 30 * h, grid_import: 24 * h, grid_export: 24 * h,
    battery_charge: site.battery_kwh ? Math.max(site.battery_kwh, 6 * h) : 15 * h, battery_discharge: site.battery_kwh ? Math.max(site.battery_kwh, 6 * h) : 15 * h, home: 24 * h + (site.pv_kwp ?? 0) * h,
  };
  const hard = []; const soft = [];
  for (const k of ['solar', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'home', 'gas', 'ev']) if (row[k] != null && row[k] < -1e-9) hard.push(`${fieldWords(k)} is below zero (${kw(row[k], 4)})`);
  for (const [k, lim] of Object.entries(limits)) if (row[k] != null && row[k] > lim) soft.push(`${fieldWords(k)} of ${kw(row[k])} is more than the ${kw(lim)} the system could manage in a ${noun}`);
  if (row.soc_end != null && (row.soc_end < 0 || row.soc_end > 100)) hard.push(`the battery level of ${row.soc_end}% is outside 0 to 100%`);
  if (row.import_rate_ex != null && Math.abs(row.import_rate_ex) > 500) soft.push(`a price of ${perKwh(cx, row.import_rate_ex)} looks wrong`);
  const worst = Object.entries(limits).map(([k, lim]) => [k, (row[k] ?? 0) / lim]).sort((a, b) => b[1] - a[1])[0];
  return ck('unit_sanity', 'consistency', 'The figures are in a believable range', `We checked that no energy figure is below zero or bigger than the system can manage in a ${noun} (${site.pv_kwp ? `${site.pv_kwp} kW of panels` : 'up to 30 kW of panels'}, a normal 100 A supply, a ${site.battery_kwh ? `${site.battery_kwh} kWh` : 'typical'} battery), and that the battery level is between 0 and 100%.`,
    { source_value: worst ? limits[worst[0]] : null, our_value: worst ? row[worst[0]] : null, unit: 'kWh', diff: null, tolerance: null, status: hard.length ? 'fail' : soft.length ? 'warn' : 'pass',
      evidence: { ts: row.slot_start, table: 'site_hh' },
      explanation: hard.length || soft.length ? `${[...hard, ...soft].join('; ').replace(/^./, (c) => c.toUpperCase())}.` : `All figures are in a normal range (the closest to its limit is ${fieldWords(worst?.[0] ?? 'solar')}, at ${fx((worst?.[1] ?? 0) * 100, 0)}% of what the system could manage).` });
}

// ── Day checks ──
const NODE_CHECK = { solar: ['solar_kwh', 'solar'], load: ['load_kwh', 'load'], import: ['grid_import_kwh', 'imp'], export: ['grid_export_kwh', 'exp'], charge: ['battery_charge_kwh', 'chg'], discharge: ['battery_discharge_kwh', 'dis'] };
const NODE_DAY_WORDS = { solar: 'solar', load: 'house use', import: 'grid import', export: 'grid export', charge: 'battery charging', discharge: 'battery discharging' };
function dayChecks(cx, date) {
  const { tz, slotS } = cx;
  const noun = slotNoun(slotS);
  const out = [];
  const [ds] = dayBounds(tz, date);
  const day = dayWords(date);
  const stored = (code) => cx.checks.find((c) => c.local_date === date && c.check_code === code) ?? null;
  const rebuiltCheck = (code) => cx.built.checks.find((c) => c[0] === date && c[1] === code) ?? null;
  // Inverter daily counters vs the 5-minute samples (the build's own check, with the counter fact).
  for (const [k, [metric]] of Object.entries(NODE_CHECK)) {
    const c = stored(`counter_fit_${k}`);
    const counter = cx.daily[metric].find((f) => f.start_ts === ds) ?? null;
    const title = `The inverter's daily total agrees with its readings (${NODE_DAY_WORDS[k]})`;
    const how = `The inverter keeps its own total for each day. We added up its five-minute readings and compared. A difference of up to 10% (or 0.2 kWh) is normal; we then scale that day's readings so they add up to the inverter's total (the "correction factor").`;
    if (!c) {
      if (counter) out.push(ck(`counter_fit_${k}`, 'consistency', title, how, { status: 'skip', unit: 'kWh', evidence: { ts: ds, table: 'interval_fact', series_id: counter.series_id, raw_id: counter.raw_id },
        explanation: rebuiltCheck(`counter_fit_${k}`) ? `${day} is not over yet, so it is not compared yet.` : `The amounts on ${day} are too small to compare (or the day is not over).` }));
      continue;
    }
    const integrated = counter && c.measured ? counter.value / c.measured : null;
    out.push(ck(`counter_fit_${k}`, 'consistency', title, how,
      { source_value: counter?.value ?? null, our_value: integrated, unit: 'kWh', diff: integrated != null ? counter.value - integrated : null, tolerance: 0.1, status: c.status,
        evidence: { ts: ds, table: 'interval_fact', series_id: counter?.series_id ?? null, raw_id: counter?.raw_id ?? null },
        explanation: `The inverter's own total for ${NODE_DAY_WORDS[k]} on ${day} was ${fx(counter?.value, 1)} kWh; its five-minute readings add up to ${fx(integrated, 2)} kWh, so the readings are scaled by ${fx(c.measured, 3)}. ${c.status === 'pass' ? 'That is a normal difference.' : 'That is a bigger difference than usual.'}`, fit: c.measured }));
    if (counter) {
      const meta = cx.meta.get(counter.series_id);
      const pub = meta ? publishedValue(cx.pc, counter, meta, tz) : { missing: 'unknown series' };
      const ok = pub.value != null && Math.abs(counter.value - pub.value) <= 1e-9;
      out.push(ck(`source_lookup:sunsynk_daily:${k}`, 'source', `The daily total matches what the inverter sent (${NODE_DAY_WORDS[k]})`, `We opened the saved copy of the inverter's daily report and checked the total for ${day}.`,
        { source_value: pub.value ?? null, our_value: counter.value, unit: 'kWh', diff: pub.value != null ? counter.value - pub.value : null, tolerance: 1e-9,
          status: pub.value === undefined ? 'skip' : ok ? 'pass' : 'fail', evidence: { ts: ds, table: 'interval_fact', series_id: counter.series_id, raw_id: counter.raw_id },
          explanation: pub.value === undefined ? `We could not check it: ${pub.missing ?? 'no saved copy'}.` : `The inverter's report says ${pub.value} kWh; we stored ${counter.value} kWh${ok ? '.' : ': they differ.'}` }));
    }
  }
  // Meter vs clamp over the day (the build's check, with the sums it compared).
  const rows = cx.rows.filter((r) => r.local_date === date);
  for (const [code, dir, col, key] of [['meter_vs_ct', 'import', 'grid_import', 'imp'], ['meter_vs_ct_export', 'export', 'grid_export', 'exp']]) {
    const c = stored(code);
    if (!c) continue;
    let meter = 0; let clamp = 0; let n = 0;
    for (const r of rows) { const l = JSON.parse(r.lineage || '{}'); if (l[dir] === 'octopus_meter' && l.ct) { meter += r[col] ?? 0; clamp += l.ct[key] ?? 0; n++; } }
    out.push(ck(`${code}_day`, 'consistency', `The smart meter and the inverter agree over the day (${dir})`, `Over the ${noun}s both measured, we compared the smart meter's ${dir} with the inverter's own sensor on the grid cable (its "clamp"). Within 5% is normal.`,
      { source_value: meter, our_value: clamp, unit: 'kWh', diff: meter - clamp, tolerance: 0.05, status: c.status, evidence: { ts: ds, table: 'check_result' },
        explanation: `On ${day}, over ${n} ${noun}s, the meter measured ${kw(meter, 2)} and the clamp ${kw(clamp, 2)}: ${meter > 0 ? `${fx(Math.abs((meter - clamp) / meter) * 100, 1)}% apart` : 'no difference to measure'}. ${c.status === 'pass' ? 'That is normal.' : 'That is more than usual.'}` }));
  }
  // Energy balance of the day.
  const d = cx.days.find((x) => x.local_date === date);
  if (d) {
    const inn = (d.solar ?? 0) + (d.grid_import ?? 0) + (d.battery_discharge ?? 0);
    const outE = (d.home ?? 0) + (d.grid_export ?? 0) + (d.battery_charge ?? 0);
    const loss = (d.solar_to_loss ?? 0) + (d.battery_to_loss ?? 0) + (d.grid_to_loss ?? 0);
    const diff = inn - outE - loss; const tol = 0.1;
    const eb = stored('energy_balance');
    out.push(ck('balance_day', 'consistency', 'Energy in equals energy out over the day', 'We added up the day\'s solar, grid and battery energy coming in, and the house, export, battery charging and inverter use going out. The two should be equal.',
      { source_value: inn, our_value: outE + loss, unit: 'kWh', diff, tolerance: tol, status: Math.abs(diff) <= tol ? 'pass' : 'warn', evidence: { ts: ds, table: 'site_day' },
        explanation: `On ${day}: in ${kw(inn, 2)}; out ${kw(outE, 2)}, plus ${kw(loss, 2)} used by the inverter. ${Math.abs(diff) <= tol ? 'They match.' : `${kw(-diff, 2)} of the export or battery charging is not covered by anything that came in (small disagreements between the meters).`}${eb ? ` The inverter's own use that day is ${eb.status === 'pass' ? 'normal for this home' : eb.status === 'skip' ? 'not judged yet (we need a week of history first)' : 'unusual for this home'}.` : ''}` }));
  }
  if (d) {
    const c = stored('completeness');
    if (c) out.push(ck('completeness_day', 'source', `The ${noun}s of the day are complete`, `We counted how many ${noun}s of the day are final, still waiting for the smart meter, or missing.`,
      { source_value: c.tolerance, our_value: c.measured, unit: 'fraction', diff: c.measured != null && c.tolerance != null ? c.measured - c.tolerance : null, tolerance: 0, status: c.status, evidence: { ts: ds, table: 'check_result' },
        explanation: `On ${day}: ${d.slots_final} ${noun}s final, ${d.slots_provisional} waiting for the smart meter, ${d.slots_missing} missing.` }));
    const r = stored('rate_coverage');
    if (r) out.push(ck('rate_coverage_day', 'price', `Every ${noun} of the day has a price`, `We counted the ${noun}s of the day that have an import price.`,
      { source_value: r.tolerance, our_value: r.measured, unit: 'fraction', diff: r.measured != null && r.tolerance != null ? r.measured - r.tolerance : null, tolerance: 0, status: r.status, evidence: { ts: ds, table: 'check_result' },
        explanation: `${Math.round((r.measured ?? 0) * (d.slots ?? 0))} of ${d.slots} ${noun}s on ${day} have a price.` }));
  }
  if (d && d.solar_forecast != null) {
    const err = (d.solar ?? 0) - d.solar_forecast; const tol = Math.max(1, 0.3 * Math.max(d.solar ?? 0, d.solar_forecast));
    out.push(ck('solar_forecast_error_day', 'forecast', 'How good the solar forecast was over the day', 'We compared the solar forecast made in advance with what the panels made over the whole day. A big miss means the forecast was off, not that the data is wrong.',
      { source_value: d.solar, our_value: d.solar_forecast, unit: 'kWh', diff: err, tolerance: tol, status: Math.abs(err) <= tol ? 'pass' : 'warn', evidence: { ts: ds, table: 'site_day' },
        explanation: `On ${day} we forecast ${kw(d.solar_forecast, 1)} of solar in advance and the panels made ${kw(d.solar, 1)}${d.solar_forecast > 0 ? ` (${fx(Math.abs(err / d.solar_forecast) * 100, 0)}% ${err > 0 ? 'more' : 'less'})` : ''}. ${Math.abs(err) <= tol ? 'That is within the normal range.' : 'That is a bigger miss than usual.'}` }));
  }
  return out;
}

const rawIdsOf = (cx, rows) => {
  const ids = [];
  for (const row of rows) {
    const F = cx.at(row.slot_start);
    for (const r of F.readings) ids.push(r.raw_id);
    for (const f of [...F.meters.import, ...F.meters.export, ...F.meters.gas, ...F.carbon]) ids.push(f.raw_id);
    for (const kind of ['meter_import', 'meter_export']) for (const p of cx.pieces(kind, row.slot_start)) if (p.rate?.raw_id != null) ids.push(p.rate.raw_id);
  }
  return ids;
};

function aggregate(list, date, noun, tz, slotS) {
  const groups = new Map();
  for (const c of list) (groups.get(c.id) || groups.set(c.id, []).get(c.id)).push(c);
  return [...groups.values()].map((g) => {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of g) counts[c.status]++;
    // The worst status, and among those the largest difference.
    const size = (c) => Math.abs(c.diff ?? 0);
    const worst = g.reduce((w, c) => (STATUS_RANK[c.status] > STATUS_RANK[w.status] || (STATUS_RANK[c.status] === STATUS_RANK[w.status] && size(c) > size(w)) ? c : w), g[0]);
    const status = counts.fail ? 'fail' : counts.warn ? 'warn' : counts.pass ? 'pass' : 'skip';
    const rest = { ...worst };
    delete rest.diffs; delete rest.counts;
    const tally = [counts.pass ? `${counts.pass} fine` : null, counts.warn ? `${counts.warn} to look at` : null, counts.fail ? `${counts.fail} wrong` : null, counts.skip ? `${counts.skip} not checked` : null].filter(Boolean).join(', ');
    return { ...rest, status, date, slots: counts,
      explanation: `${g.length} ${noun}s on ${dayWords(date)}: ${tally}.${status === 'warn' || status === 'fail' ? ` The biggest, ${slotWords(tz, worst.evidence?.ts ?? 0, slotS)}: ${worst.explanation}` : ` For example ${slotWords(tz, worst.evidence?.ts ?? 0, slotS)}: ${worst.explanation}`}` };
  });
}

/**
 * GET /api/explorer/validate: { checks: [{ id, group, title, how, source_value, our_value, unit, diff,
 * tolerance, status, evidence, explanation }], summary: { pass, warn, fail, skip } } for one slot
 * (slot=) or a range of local dates (from=, to=; at most 31 days, per-slot checks aggregated per day).
 */
export function validate(q) {
  const site = siteParam(q);
  const slotQ = intParam(q, 'slot', { min: 0 });
  const noun = slotNoun(slotLength(site));
  let checks; let scope;
  if (slotQ != null) {
    const date = localDate(site.timezone, slotQ);
    const cx = loadCx(site, date, date, { slot: slotQ });
    const row = cx.rows.find((r) => r.slot_start === slotQ);
    if (!row) throw notFound(`no stored ${noun} at ${slotQ}`);
    checks = [...slotChecks(cx, row), ...rederiveChecks(cx, rawIdsOf(cx, [row])), ...dayChecks(cx, date)];
    scope = { slot: slotQ, local_time: localTime(site.timezone, slotQ), date };
  } else {
    if (q.from == null && q.to == null) throw bad('give slot=<epoch> or from=&to= (dates)');
    const { from, to } = dateRange(site, q, { days: 1, maxDays: 31 });
    const cx = loadCx(site, from, to);
    checks = [];
    for (const date of daysBetween(from, to)) {
      const rows = cx.rows.filter((r) => r.local_date === date);
      if (!rows.length) continue;
      checks.push(...aggregate(rows.flatMap((r) => slotChecks(cx, r)), date, noun, site.timezone, cx.slotS), ...dayChecks(cx, date).map((c) => ({ ...c, date })));
    }
    checks.push(...rederiveChecks(cx, rawIdsOf(cx, cx.rows)));
    scope = { from, to };
  }
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { ...base(site), ...scope, checks, summary };
}
