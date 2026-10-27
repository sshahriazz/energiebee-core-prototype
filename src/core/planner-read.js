// The planner read layer (plan item B10): the functions through which a Predbat / PredHeat-style
// planner reads the facts, as RESAMPLED ARRAYS on an explicit time axis instead of raw rows.
// Read-only: nothing here writes (no series is created, no row is stored), and the build never
// calls it, so site_hh and the golden hash cannot move.
//
// Every function
//   - takes asOf (epoch MILLISECONDS; default Date.now()) and reads every fact, price, tariff and
//     home setting AS KNOWN AT that moment (facts.js withKnownAt: a version recorded later is
//     invisible, one superseded later is still visible; forecasts by when the core recorded the
//     issue, readForecastAsOf). The same facts and asOf always give the same arrays.
//   - returns arrays on an explicit axis: { start (epoch s), stepS, n, values, cover, quality,
//     origin, bounds }. values[i] covers [start + i*stepS, start + (i+1)*stepS). A step no fact
//     covers is null: a gap is never filled with a zero or a guess. cover[i] is the share of the
//     step the facts covered (0..1); quality[i] is the OR of the facts' QUALITY bits, plus PARTIAL
//     when cover < 1 and FALLBACK when the step came from a lower-priority source.
//   - is bounded: every fact read has a lower AND an upper time limit set by the request (the
//     requested window minus at most one hold, one fact span (series.max_span_s) or the lookback),
//     so its cost does not grow with the length of the history. `bounds` lists each read made:
//     { table, seriesIds, from, to }.
//
// The grid: `from` is rounded down to the step on the home's local grid (time.js slotPhase: 0 for a
// 5-minute step and every whole-hour zone), n = ceil((to - start) / stepS). stepS is a multiple of
// 300 s (Predbat's 5-minute step) up to 3600; 'slot' means the home's own slot length (site.slot_s).
//
// Resampling rules, by the metric's time_role and aggregation (the metric registry, registry.js):
//   instant + integrate (power, W)     mean power over the covered part of each step. Each sample
//                                      holds until the next one, at most holdS (build.js integrate:
//                                      300 s for the inverter's 5-minute samples). energyKwh[i] is the
//                                      energy of the step (W x s / 3.6e6), so a slot's sum is build's.
//   instant + mean (temperature, %,    time-weighted mean of the held samples over the covered part
//     a 0/1 flag)                      (a flag's mean is the share of the step it was 1). Hold: the
//                                      source's sampling (Open-Meteo hourly: 3600 s; heating
//                                      telemetry: 3 h, as heat.js; default 3600 s).
//   instant + last (SoC %, kWh)        last-held: the latest sample whose hold reaches into the step
//                                      (the value at the end of the step, build.js soc_end).
//   interval + sum (energy, kWh)       split by overlap: each fact adds value x overlap / length
//                                      (a half-hour meter reading feeds six 5-minute steps by 1/6).
//   interval + mean (carbon, W/m2)     time-weighted mean of the facts overlapping the step (not split).
//   price (rates())                    the price in force at the step is held across it (priceOver:
//                                      time-weighted when a step spans two prices, as the build).
//   daily counter (counterDifference   5-minute power integrated per step and fitted to the
//     Series())                        inverter's daily total (build.js align), differenced per step,
//                                      with a cumulative counter that resets at local midnight.
// Several series of one source (two sensors, two inverters) are combined per step: summed for
// sum / integrate metrics, averaged for mean / last ones (PredHeat averages its indoor sensors).
// Several sources are tried in priority order PER STEP (a step the first source does not cover is
// taken from the next, flagged FALLBACK); `source` names one or a list to use instead.
//
// Functions: series, counterDifferenceSeries, rates, forecast, loadHistory, predictLoad,
// projectProfile, state, freshness (freshnessOf), window (frameFor). See docs/what-it-does.md
// "Planner read layer" and docs/predbat-slot-compatibility.md for the Predbat / PredHeat inputs each feeds.
import { db } from '../db/db.js';
import * as facts from './facts.js';
import { loadPricing, priceOver, priceAt, fixedOver, fixedPerDay } from './pricing.js';
import { inputsProvenance } from './provenance.js';
import { siteAt } from './versions.js';
import { attributeAt, attributesAt } from './attributes.js';
import { devicesAt } from './devices.js';
import { bindingsFor, holdSOf } from './inputs.js';
import { settingsAt } from './settings.js';
import { localDate, addDays, dayBounds, slotLength, slotPhase, slotFloor, offsetSeconds } from './time.js';

const { QUALITY } = facts;
export const STEP_S = 300;                       // Predbat's simulation step
export const MAX_SPAN_S = 400 * 86400;           // the longest window one call may ask for
export const STATE_LOOKBACK_S = 2 * 86400;       // state(): how far back a latest reading is looked for
// Freshness gate defaults (s): the live inputs a battery plan cannot run without. A planner that
// finds one stale or missing falls back to a demand-only plan (plan_run.status 'stale_inputs',
// docs/predbat-slot-compatibility.md). 60 minutes is the planning design's figure (catalogue PD-06,
// unverified: Predbat itself states none); a caller passes its own limits.
export const DEFAULT_LIMITS = Object.freeze({ soc_pct: 3600, battery_w: 3600, grid_w: 3600, pv_w: 3600, load_w: 3600 });

// What the planner read knows about a source comes from the source's traits (registry.js:
// holdS, live, forecastOnly, namedOnly) and from the home's bindings (inputs.js), not from a list of
// vendors here: a new source declares its hold time and kind in its own row.
const DEFAULT_HOLD_S = 3600;
function sourceTraits() {
  const t = new Map();
  for (const r of db.prepare('SELECT code, traits FROM source').all()) {
    let c = {}; try { c = JSON.parse(r.traits || '{}'); } catch { /* unreadable traits: no flags */ }
    t.set(r.code, { holdS: c.holdS ?? null, live: Boolean(c.live), forecastOnly: Boolean(c.forecastOnly), namedOnly: Boolean(c.namedOnly) });
  }
  return t;
}
const withFlag = (traits, flags) => new Set([...traits].filter(([, v]) => flags.some((f) => v[f])).map(([k]) => k));
// Sources the home has bound to the given roles, in role then priority order.
const boundSources = (siteId, roles, asOfS = null) => [...new Set(roles.flatMap((r) => bindingsFor(siteId, r, asOfS).map((b) => b.source)))];
const READING_ROLES = ['inverter_5min', 'weather_temp'];
const INTERVAL_ROLES = ['meter_energy', 'carbon', 'weather_temp', 'gas_cv', 'ev_dispatch'];
// Forecast sources per metric, in priority order. solar_kwh: our own calibrated forecast first (the
// central the solar cases are derived from, solar-cases.js), Quartz for steps it does not cover.
const FORECAST_SOURCES = {
  solar_kwh: null /* the home's solar_forecast bindings */, solar_kwh_p10: ['core_solar_cases'], solar_kwh_p50: ['core_solar_cases'], solar_kwh_p90: ['core_solar_cases'],
  load_kwh: ['core_forecast'], grid_import_kwh: ['core_forecast'],
};

const CASES = { central: null, p10: 'p10', p50: 'p50', p90: 'p90', pessimistic: 'p10', median: 'p50', optimistic: 'p90' };
// Inverter daily counters (Predbat's load_today, pv_today, import_today, export_today ...): the
// daily total metric -> the 5-minute power metric integrated and fitted to it (build.js NODES).
const COUNTERS = {
  solar_kwh: 'solar_w', load_kwh: 'load_w', grid_import_kwh: 'grid_import_w', grid_export_kwh: 'grid_export_w',
  battery_charge_kwh: 'battery_charge_w', battery_discharge_kwh: 'battery_discharge_w',
};
const COUNTER_ALIASES = { load_today: 'load_kwh', pv_today: 'solar_kwh', import_today: 'grid_import_kwh', export_today: 'grid_export_kwh' };
const DIRECTIONS = { import: 'meter_import', export: 'meter_export', gas: 'meter_gas' };

// ───────────── Small helpers ─────────────

function msOf(asOf) {
  const ms = Math.floor(Number(asOf));
  if (!Number.isFinite(ms)) throw new TypeError(`asOf must be epoch milliseconds, not ${asOf}`);
  if (ms < 1e11) throw new RangeError(`asOf ${asOf} looks like seconds: the read layer takes epoch milliseconds`);
  return ms;
}

// The moment read. A given asOf reads every version in force then (knownAt = asOf). Omitted: the
// moment of an enclosing withKnownAt if there is one, else now, read as the CURRENT versions: the
// same rows (nothing can be recorded after now), through the current-row indexes.
function momentOf(asOf) {
  if (asOf != null) { const ms = msOf(asOf); return { ms, knownAt: ms }; }
  const outer = facts.knownAtMs();
  return outer != null ? { ms: outer, knownAt: outer } : { ms: Date.now(), knownAt: null };
}

const tables = new Map();
function hasTable(name) {
  if (!tables.has(name)) tables.set(name, Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)));
  return tables.get(name);
}

// The home as known at knownAt (site_version, versions.js), or today's row (knownAt null, or a
// database where versions are not kept).
function siteOf(siteId, knownAt) {
  const cur = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!cur) throw new RangeError(`no site ${siteId}`);
  if (knownAt == null || !hasTable('site_version')) return cur;
  try { return siteAt(siteId, knownAt) ?? cur; } catch { return cur; }
}

function metricDef(code) {
  const m = db.prepare('SELECT code, unit, time_role, aggregation, domain FROM metric WHERE code = ?').get(code);
  if (!m) throw new RangeError(`unknown metric ${code}`);
  return m;
}

// A step of 5 minutes to an hour (Predbat's step to the longest slot), so every step sits on the
// home's local grid on a clock-change day too.
function stepOf(stepS, site) {
  const s = stepS === 'slot' ? slotLength(site) : stepS == null ? STEP_S : Number(stepS);
  if (!(Number.isInteger(s) && s > 0 && s % STEP_S === 0 && s <= 3600)) throw new RangeError(`stepS must be a multiple of ${STEP_S} s up to 3600 (or 'slot'), not ${stepS}`);
  return s;
}

// The step grid over [from, to): start rounded down on the home's local grid of stepS.
function gridOf(tz, from, to, stepS) {
  const a = Math.floor(Number(from)); const b = Math.floor(Number(to));
  if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) throw new RangeError(`from (${from}) must be before to (${to}), epoch seconds`);
  if (b - a > MAX_SPAN_S) throw new RangeError(`a window of at most ${MAX_SPAN_S / 86400} days is read at once`);
  const start = slotFloor(a, stepS, slotPhase(tz, stepS, a));
  const n = Math.ceil((b - start) / stepS);
  return { start, stepS, n, end: start + n * stepS };
}

// The site's own series of a metric (site, its devices, its carbon and gas regions), never created.
// One branch per subject kind, so each is a search of series' unique key (subject, metric).
function seriesFor(site, metric) {
  const mid = db.prepare('SELECT id FROM metric WHERE code = ?').get(metric)?.id;
  if (mid == null) return [];
  const regions = [];
  if (site.carbon_region != null) regions.push(`carbon:${site.carbon_region}`);
  for (const d of db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(site.id)) {
    try { const ldz = JSON.parse(d.attrs || '{}').ldz; if (ldz) regions.push(`ldz:${ldz}`); } catch { /* attrs not JSON: no gas zone */ }
  }
  return db.prepare(
    `SELECT se.id, se.subject_kind, se.subject_id, so.code AS source FROM series se JOIN source so ON so.id = se.source_id
      WHERE se.subject_kind = 'site' AND se.subject_id = ? AND se.metric_id = ?
     UNION ALL
     SELECT se.id, se.subject_kind, se.subject_id, so.code FROM device d
       JOIN series se ON se.subject_kind = 'device' AND se.subject_id = CAST(d.id AS TEXT) AND se.metric_id = ? JOIN source so ON so.id = se.source_id
      WHERE d.site_id = ?
     UNION ALL
     SELECT se.id, se.subject_kind, se.subject_id, so.code FROM json_each(?) j
       CROSS JOIN series se ON se.subject_kind = 'region' AND se.subject_id = j.value AND se.metric_id = ? JOIN source so ON so.id = se.source_id
     ORDER BY 1`).all(String(site.id), mid, mid, site.id, JSON.stringify(regions), mid);
}

// Interval facts of ONE series over [from, to), bounded below by its longest fact (facts.js
// readIntervals). A series whose max_span_s is NULL (with the column present) has no interval or
// forecast fact at all (delta 013 keeps it on every insert): nothing to read, so no unbounded search.
const noFacts = (id) => facts.spanColumn() && facts.spanOf([id]) == null;
function intervalsOf(id, from, to, bounds) {
  const span = facts.spanOf([id]);
  if (span == null && facts.spanColumn()) { bounds.push({ table: 'interval_fact', seriesIds: [id], from: null, to: null, empty: true }); return []; }
  bounds.push({ table: 'interval_fact', seriesIds: [id], from: span == null ? null : from - span, to });
  return facts.readIntervals([id], from, to);
}

// One site-level series by metric and source, or null (never created: a read must not write).
function siteSeries(siteId, metric, source) {
  return db.prepare(`SELECT se.id FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
    WHERE se.subject_kind = 'site' AND se.subject_id = ? AND m.code = ? AND so.code = ?`).get(String(siteId), metric, source)?.id ?? null;
}

// Candidate series grouped by source, in priority order: `wanted` (a source or a list) when given,
// otherwise the preference list, then any other source alphabetically (skipping `skip`).
function groupsBySource(rows, wanted, prefer, skip) {
  const bySource = new Map();
  for (const r of rows) (bySource.get(r.source) || bySource.set(r.source, []).get(r.source)).push(r);
  const order = wanted != null ? [].concat(wanted)
    : [...prefer.filter((s) => bySource.has(s)), ...[...bySource.keys()].filter((s) => !prefer.includes(s) && !skip.has(s)).sort()];
  return order.filter((s) => bySource.has(s)).map((s) => ({ source: s, series: bySource.get(s) }));
}

const groupBySeries = (rows) => rows.reduce((m, r) => (m.get(r.series_id) ? m.get(r.series_id).push(r) : m.set(r.series_id, [r]), m), new Map());

// ───────────── Resampling engines ─────────────

// Instants: each sample holds until the next one, at most holdS (the build's forward hold). Per
// step: ws (value x seconds), cover (s), the last value whose hold reaches into the step, quality,
// and the energy pieces (value x seconds / 3.6e6, accumulated as build.js integrate does).
function holdAccumulate(rows, g, holdS) {
  const { n, stepS: S } = g;
  const out = { ws: new Float64Array(n), cover: new Float64Array(n), energy: new Float64Array(n), last: new Array(n).fill(null), q: new Int32Array(n) };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.value == null) continue;
    const next = rows[i + 1]?.ts ?? r.ts + holdS;
    const end = r.ts + Math.min(next - r.ts, holdS);
    let s = Math.max(r.ts, g.start);
    const e = Math.min(end, g.end);
    let k = Math.floor((s - g.start) / S);
    while (s < e) {
      const be = Math.min(e, g.start + (k + 1) * S);
      const d = be - s;
      out.ws[k] += r.value * d; out.cover[k] += d; out.energy[k] += (r.value * d) / 3.6e6;
      out.last[k] = r.value; out.q[k] |= r.quality ?? 0;
      s = be; k++;
    }
  }
  return out;
}

// Periods (interval facts, forecasts): split by overlap ('sum'), time-weighted ('mean') or the last
// overlapping one ('last'). Forecast rows also give each step the latest issue that fed it.
function overlapAccumulate(rows, g, mode) {
  const { n, stepS: S } = g;
  const acc = new Float64Array(n); const w = new Float64Array(n); const cover = new Float64Array(n); const q = new Int32Array(n);
  const last = new Array(n).fill(null); const has = new Uint8Array(n);
  const issued = new Array(n).fill(null); const recorded = new Array(n).fill(null);
  for (const f of rows) {
    if (f.value == null) continue;
    const len = f.end_ts - f.start_ts;
    const a = Math.max(f.start_ts, g.start); const b = Math.min(f.end_ts, g.end);
    for (let k = Math.floor((a - g.start) / S); k < n && g.start + k * S < b; k++) {
      const s0 = g.start + k * S;
      const o = Math.min(f.end_ts, s0 + S) - Math.max(f.start_ts, s0);
      if (o <= 0) continue;
      has[k] = 1; cover[k] += o; q[k] |= f.quality ?? 0; last[k] = f.value;
      if (mode === 'sum') acc[k] += (f.value * o) / len; else { acc[k] += f.value * o; w[k] += o; }
      if (f.issued_at != null && (issued[k] == null || f.issued_at > issued[k])) { issued[k] = f.issued_at; recorded[k] = f.recorded_at ?? null; }
    }
  }
  const value = Array.from({ length: n }, (_, k) => (!has[k] ? null : mode === 'sum' ? acc[k] : mode === 'last' ? last[k] : acc[k] / w[k]));
  return { value, cover, q, issued, recorded };
}

// Several series of one source to one per step: summed (sum / integrate) or averaged (mean / last).
function combineSeries(parts, n, sumLike) {
  if (parts.length === 1) return parts[0];
  const value = new Array(n).fill(null); const cover = new Float64Array(n); const q = new Int32Array(n);
  const energy = parts.every((p) => p.energy) ? new Float64Array(n) : null;
  const issued = new Array(n).fill(null); const recorded = new Array(n).fill(null);
  for (let k = 0; k < n; k++) {
    let sum = 0; let cnt = 0; let cmin = Infinity; let cmax = 0;
    for (const p of parts) {
      cmin = Math.min(cmin, p.cover[k]); cmax = Math.max(cmax, p.cover[k]); q[k] |= p.q[k];
      if (energy) energy[k] += p.energy[k];
      if (p.issued?.[k] != null && (issued[k] == null || p.issued[k] > issued[k])) { issued[k] = p.issued[k]; recorded[k] = p.recorded[k]; }
      if (p.value[k] == null) continue;
      sum += p.value[k]; cnt++;
    }
    if (cnt) value[k] = sumLike ? sum : sum / cnt;
    cover[k] = sumLike ? cmin : cmax;
  }
  return { value, cover, q, energy, issued, recorded };
}

// Sources in priority order to one array: a step takes the first source that has a value for it.
function fallbackSources(results, g, extra = []) {
  const { n, stepS } = g;
  const values = new Array(n).fill(null); const cover = new Array(n).fill(0); const quality = new Array(n).fill(0);
  const sourceIndex = new Array(n).fill(null);
  const more = Object.fromEntries(extra.map((k) => [k, new Array(n).fill(null)]));
  for (let k = 0; k < n; k++) {
    const i = results.findIndex((r) => r.value[k] != null);
    if (i < 0) { const c = Math.max(0, ...results.map((r) => r.cover[k] || 0)); cover[k] = c / stepS; continue; }
    const r = results[i];
    values[k] = r.value[k]; cover[k] = Math.min(1, r.cover[k] / stepS); sourceIndex[k] = i;
    quality[k] = r.q[k] | (cover[k] < 1 - 1e-9 ? QUALITY.PARTIAL : 0) | (i > 0 ? QUALITY.FALLBACK : 0);
    for (const x of extra) more[x][k] = r[x]?.[k] ?? null;
  }
  return { values, cover, quality, sourceIndex, ...more };
}

// The local clock (UTC offset) over [start, end) as segments, found by bisection on the 900 s grid
// (every real clock change happens on it), at most one Intl call per segment edge and per day.
function offsetSegments(tz, start, end) {
  const segs = [];
  const push = (a, b, off) => { const l = segs[segs.length - 1]; if (l && l.off === off && l.to === a) l.to = b; else segs.push({ from: a, to: b, off }); };
  const split = (a, b, oa, ob) => {
    if (oa === ob) { push(a, b, oa); return; }
    if (b - a <= 900) { push(a, b, oa); return; }                          // a cell never holds a change
    const m = a + Math.max(900, Math.floor((b - a) / 1800) * 900);
    const om = offsetSeconds(tz, m);
    split(a, m, oa, offsetSeconds(tz, m - 1)); split(m, b, om, ob);
  };
  for (let a = start; a < end; a += 86400) {
    const b = Math.min(end, a + 86400);
    split(a, b, offsetSeconds(tz, a), offsetSeconds(tz, b - 1));
  }
  return segs;
}
// Local wall-clock seconds into the day at each instant (DST-safe: read from the clock).
function localClock(tz, start, end) {
  const segs = offsetSegments(tz, start, end);
  return (t) => {
    const s = segs.find((x) => t >= x.from && t < x.to) ?? segs[segs.length - 1];
    return ((((t + s.off) % 86400) + 86400) % 86400);
  };
}

// ───────────── series ─────────────

/**
 * One metric of a home resampled to a step grid, as known at asOf.
 * @param siteId the home
 * @param metric a metric code (registry.js METRICS)
 * @param from,to epoch seconds; the grid starts at from rounded down to the step
 * @param opts { stepS = 300 | 'slot', asOf (ms, default now), source (a source code or a list, in
 *   priority order), kind ('reading' | 'interval': which fact table; default by the metric's
 *   time_role), holdS (instant samples: how long one holds) }
 * @returns {{ siteId, metric, unit, start, stepS, n, values, cover, quality, energyKwh?, sourceIndex,
 *   origin: { rule, timeRole, aggregation, sources, seriesIds, holdS, asOf }, bounds }}
 *   energyKwh only for instant power (integrate). sourceIndex[i] points into origin.sources (null: no data).
 */
export function series(siteId, metric, from, to, opts = {}) {
  const at = momentOf(opts.asOf);
  const asOf = at.ms;
  const site = siteOf(siteId, at.knownAt);
  const stepS = stepOf(opts.stepS, site);
  const g = gridOf(site.timezone, from, to, stepS);
  const def = metricDef(metric);
  const kind = opts.kind ?? (def.time_role === 'instant' ? 'reading' : 'interval');
  if (kind !== 'reading' && kind !== 'interval') throw new RangeError(`kind must be 'reading' or 'interval', not ${kind}`);
  const traits = sourceTraits();
  const skip = withFlag(traits, ['forecastOnly', 'namedOnly']);
  const groups = groupsBySource(seriesFor(site, metric), opts.source, boundSources(siteId, kind === 'reading' ? READING_ROLES : INTERVAL_ROLES), skip);
  const sumLike = def.aggregation === 'sum' || def.aggregation === 'integrate';
  const rule = ruleOf(def, kind);
  const bounds = [];
  const holds = [];
  const results = facts.withKnownAt(at.knownAt, () => groups.map(({ source, series: list }) => {
    const ids = list.map((s) => s.id);
    if (kind === 'reading') {
      const holdS = opts.holdS ?? traits.get(source)?.holdS ?? DEFAULT_HOLD_S;
      holds.push(holdS);
      bounds.push({ table: 'reading', seriesIds: ids, from: g.start - holdS, to: g.end });
      const bySeries = groupBySeries(facts.readReadings(ids, g.start - holdS, g.end));
      const parts = ids.map((id) => {
        const h = holdAccumulate(bySeries.get(id) || [], g, holdS);
        const value = Array.from({ length: g.n }, (_, k) => (h.cover[k] > 0 ? (def.aggregation === 'last' ? h.last[k] : h.ws[k] / h.cover[k]) : null));
        return { value, cover: h.cover, q: h.q, energy: h.energy };
      });
      return combineSeries(parts, g.n, sumLike);
    }
    const mode = def.aggregation === 'sum' ? 'sum' : def.aggregation === 'last' ? 'last' : 'mean';
    const parts = ids.map((id) => overlapAccumulate(intervalsOf(id, g.start, g.end, bounds), g, mode));
    return combineSeries(parts, g.n, sumLike);
  }));
  const out = fallbackSources(results, g, kind === 'reading' && def.aggregation === 'integrate' ? ['energy'] : []);
  const result = {
    siteId, metric, unit: def.unit, start: g.start, stepS, n: g.n, values: out.values, cover: out.cover, quality: out.quality, sourceIndex: out.sourceIndex,
    origin: { rule, timeRole: def.time_role, aggregation: def.aggregation, kind, sources: groups.map((x) => x.source), seriesIds: groups.map((x) => x.series.map((s) => s.id)), holdS: kind === 'reading' ? holds : null, asOf },
    bounds,
  };
  if (out.energy) result.energyKwh = out.energy.map((v, k) => (out.values[k] == null ? null : v));
  return result;
}

function ruleOf(def, kind) {
  if (kind === 'reading') return def.aggregation === 'last' ? 'last_held' : def.aggregation === 'integrate' ? 'mean_power_held' : 'mean_held';
  return def.aggregation === 'sum' ? 'split_by_overlap' : def.aggregation === 'last' ? 'last_overlapping' : 'time_weighted_mean';
}

// ───────────── counterDifferenceSeries ─────────────

// Fitted energy per step over whole local days [first day start, last day end): the inverter's
// 5-minute power integrated (forward hold, 300 s) and scaled per day to its daily total, exactly
// the build's align step (build.js: fit = total / integrated when 0.05 < integrated, total > 0,
// 0.6 < fit < 1.6 and the day is before today; otherwise 1). Re-implemented, not shared, so the
// build is untouched; test/planner-read.test.js checks it against the build on the GB home.
function fittedDays(siteId, tz, counter, dates, stepS, today, bounds, knownAt) {
  // The sources bound to the inverter roles (inputs.js), each for the period it applies: the same
  // sources the build reads, so a vendor switch moves both together.
  const asOfS = knownAt == null ? null : knownAt / 1000;
  const bound5 = bindingsFor(siteId, 'inverter_5min', asOfS);
  const boundDaily = bindingsFor(siteId, 'inverter_daily', asOfS);
  const [a] = dayBounds(tz, dates[0]); const [, b] = dayBounds(tz, dates[dates.length - 1]);
  const g = { start: a, stepS, n: (b - a) / stepS, end: b };
  // A unit is a binding: a source, optionally a device (two inverters are two units at once). Each is held and
  // integrated on its own, then the energies are added; a step is covered as far as its least covered active unit is.
  const seriesOf = (bd, metric) => (bd.deviceId == null ? siteSeries(siteId, metric, bd.source)
    : db.prepare("SELECT se.id FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id WHERE se.subject_kind = 'device' AND se.subject_id = ? AND m.code = ? AND so.code = ?").get(String(bd.deviceId), metric, bd.source)?.id ?? null);
  const powers = bound5.map((bd) => ({ bd, id: seriesOf(bd, COUNTERS[counter]) })).filter((x) => x.id != null);
  const dailies = boundDaily.map((bd) => ({ bd, id: seriesOf(bd, counter) })).filter((x) => x.id != null);
  const powerId = powers[0]?.id ?? null; const dailyId = dailies[0]?.id ?? null;
  const parts = [];
  for (const { bd, id } of powers) {
    const from = Math.max(a - 600, bd.from); const to = Math.min(b, bd.to);
    bounds.push({ table: 'reading', seriesIds: [id], from, to });
    parts.push({ bd, h: holdAccumulate(to > from ? facts.readReadings([id], from, to) : [], g, holdSOf(bd.source)) });
  }
  let h;
  if (parts.length === 1) h = parts[0].h;
  else {
    h = { energy: new Float64Array(g.n), cover: new Float64Array(g.n), q: new Int32Array(g.n) };
    for (let k = 0; k < g.n; k++) {
      const t = g.start + k * stepS;
      const act = parts.filter(({ bd }) => t + stepS > bd.from && t < bd.to);
      for (const { h: u } of act) { h.energy[k] += u.energy[k]; h.q[k] |= u.q[k]; }
      h.cover[k] = act.length ? Math.min(...act.map(({ h: u }) => u.cover[k])) : 0;
    }
  }
  const dailyParts = dailies.map(({ bd, id }) => ({ bd, rows: intervalsOf(id, Math.max(a, bd.from), Math.min(b, bd.to), bounds).filter((f) => f.start_ts >= bd.from && f.start_ts < bd.to) }));
  // A day's total: the sum over the units active that day, unknown when one of them has none.
  const dailyTotal = (ds) => {
    const act = dailyParts.filter(({ bd }) => ds >= bd.from && ds < bd.to);
    const hit = act.map(({ rows }) => rows.find((f) => f.start_ts === ds));
    if (!act.length || hit.some((f) => !f)) return undefined;
    return hit.length === 1 ? hit[0] : { ...hit[0], value: hit.reduce((t, f) => t + f.value, 0) };
  };
  const values = new Array(g.n).fill(null);
  const days = [];
  for (const date of dates) {
    const [ds, de] = dayBounds(tz, date);
    const k0 = (ds - a) / stepS; const k1 = (de - a) / stepS;
    let sum = 0;
    for (let k = k0; k < k1; k++) sum += h.energy[k];
    const totalRow = dailyTotal(ds);
    let fit = 1;
    if (totalRow && sum > 0.05 && totalRow.value > 0) {
      const f = totalRow.value / sum;
      if (f > 0.6 && f < 1.6 && date < today) fit = f;
    }
    for (let k = k0; k < k1; k++) if (h.cover[k] > 0) values[k] = h.energy[k] * fit;
    days.push({ date, start: ds, end: de, hours: (de - ds) / 3600, totalKwh: totalRow?.value ?? null, integratedKwh: sum, fit, fitted: fit !== 1, today: date >= today, k0, k1 });
  }
  return { g, values, cover: h.cover, q: h.q, days, powerId, dailyId, powerSources: powers.map((x) => x.bd.source), dailySources: dailies.map((x) => x.bd.source) };
}

/**
 * A Predbat-style cumulative daily counter (load_today, pv_today, import_today, export_today, battery
 * charge / discharge) as per-step energy and as the counter itself, as known at asOf.
 * @param metric a daily-total metric (load_kwh, solar_kwh, grid_import_kwh, grid_export_kwh,
 *   battery_charge_kwh, battery_discharge_kwh) or a Predbat name (load_today, pv_today, import_today, export_today)
 * @param opts { stepS = 300 | 'slot' (must divide an hour), asOf (ms) }
 * @returns {{ start, stepS, n, values (kWh per step, fitted; null where no sample), cumulative (kWh
 *   since local midnight at the END of each step: the counter, reset at every local midnight),
 *   resets (indices whose step starts at local midnight), cover, quality, days: [{ date, start, end,
 *   hours (23 / 24 / 25), totalKwh, integratedKwh, fit, fitted, today }], origin, bounds }}
 */
export function counterDifferenceSeries(siteId, metric, from, to, opts = {}) {
  const counter = COUNTER_ALIASES[metric] ?? metric;
  if (!COUNTERS[counter]) throw new RangeError(`no daily counter for ${metric}: one of ${[...Object.keys(COUNTERS), ...Object.keys(COUNTER_ALIASES)].join(', ')}`);
  const at = momentOf(opts.asOf);
  const asOf = at.ms;
  const site = siteOf(siteId, at.knownAt);
  const tz = site.timezone;
  const stepS = stepOf(opts.stepS, site);
  if (3600 % stepS) throw new RangeError(`a counter step must divide an hour, not ${stepS}`);
  const g = gridOf(tz, from, to, stepS);
  const today = localDate(tz, Math.floor(asOf / 1000));
  const dates = [];
  for (let d = localDate(tz, g.start); d <= localDate(tz, g.end - 1); d = addDays(d, 1)) dates.push(d);
  const bounds = [];
  const f = facts.withKnownAt(at.knownAt, () => fittedDays(siteId, tz, counter, dates, stepS, today, bounds, at.knownAt));
  const off = (g.start - f.g.start) / stepS;
  const values = new Array(g.n).fill(null); const cover = new Array(g.n).fill(0); const quality = new Array(g.n).fill(0);
  const cumulative = new Array(g.n).fill(null); const resets = [];
  const midnights = new Set(f.days.map((d) => d.start));
  let run = 0;
  for (let k = 0; k < f.g.n; k++) {
    const t = f.g.start + k * stepS;
    if (midnights.has(t)) run = 0;                                   // local midnight: the counter resets
    if (f.values[k] != null) run += f.values[k];
    const i = k - off;
    if (i < 0 || i >= g.n) continue;
    if (midnights.has(t)) resets.push(i);
    values[i] = f.values[k];
    cover[i] = Math.min(1, f.cover[k] / stepS);
    quality[i] = f.values[k] == null ? 0 : f.q[k] | (cover[i] < 1 - 1e-9 ? QUALITY.PARTIAL : 0);
    cumulative[i] = run;
  }
  return {
    siteId, metric: counter, unit: 'kWh', start: g.start, stepS, n: g.n, values, cumulative, resets, cover, quality,
    days: f.days.map(({ k0, k1, ...d }) => d),
    origin: { rule: 'power_integrated_fitted_to_daily_total', power: { metric: COUNTERS[counter], source: f.powerSources[0] ?? null, sources: f.powerSources, seriesId: f.powerId }, daily: { metric: counter, source: f.dailySources[0] ?? null, sources: f.dailySources, seriesId: f.dailyId }, today, asOf },
    bounds,
  };
}

// ───────────── rates ─────────────

/**
 * Import, export (and gas) prices per step in MINOR units of the home's currency per kWh including
 * tax, priced exactly as the build prices a slot (pricing.js loadPricing + priceOver; tax applied as
 * unitEx x (1 + vat)), with the fixed charges, as known at asOf.
 * @param opts { stepS = 300 | 'slot', asOf (ms), direction: 'import' | 'export' | 'gas' | 'both'
 *   (import + export, default) | a list }
 * @returns {{ start, stepS, n, currency, unit, import?: Dir, export?: Dir, gas?: Dir, standingPerDay:
 *   [{ date, start, end, import?, export?, gas? }] (minor units per local day incl. tax), origin, bounds }}
 *   Dir = { values (incl. tax; null = unpriced), unitEx, vat, register, tariff, estimated (bool),
 *   unpriced (bool), weighted (bool: the step spans two prices), origin (weakest input origin),
 *   standing (fixed charges of the step incl. tax, minor units), quality }
 */
export function rates(siteId, from, to, opts = {}) {
  const at = momentOf(opts.asOf);
  const asOf = at.ms;
  const site = siteOf(siteId, at.knownAt);
  const tz = site.timezone;
  const stepS = stepOf(opts.stepS, site);
  const g = gridOf(tz, from, to, stepS);
  const dir = opts.direction ?? 'both';
  const wanted = (dir === 'both' ? ['import', 'export'] : [].concat(dir));
  for (const d of wanted) if (!DIRECTIONS[d]) throw new RangeError(`direction must be import, export, gas or both, not ${d}`);
  const bounds = [{ table: 'rate_interval', seriesIds: [], from: g.start - 2 * 86400, to: g.end, note: 'loadPricing: agreements and rate rows overlapping the window; rate rows searched by (tariff_id, valid_from < to)' }];
  return facts.withKnownAt(at.knownAt, () => {
    // The home as known then, as build.js passes it (null: today's row, read by loadPricing itself).
    const p = loadPricing(siteId, g.start, g.end, at.knownAt == null ? null : site);
    const dayCache = new Map();
    const dayOf = (t) => {
      const date = localDate(tz, t);
      if (!dayCache.has(date)) dayCache.set(date, dayBounds(tz, date));
      return [date, ...dayCache.get(date)];
    };
    const out = { siteId, start: g.start, stepS, n: g.n, currency: p.currency ?? site.currency ?? null, unit: 'minor/kWh incl. tax', standingPerDay: [], bounds };
    for (const d of wanted) {
      const kind = DIRECTIONS[d];
      const r = { values: [], unitEx: [], vat: [], register: [], tariff: [], estimated: [], unpriced: [], weighted: [], origin: [], standing: [], quality: [] };
      for (let k = 0; k < g.n; k++) {
        const t = g.start + k * stepS;
        const pr = priceOver(p, kind, t, stepS);
        const unpriced = pr?.unitEx == null;
        const [, ds, de] = dayOf(t);
        r.values.push(unpriced ? null : pr.unitEx * (1 + pr.vat));
        r.unitEx.push(pr?.unitEx ?? null); r.vat.push(pr?.vat ?? null); r.register.push(pr?.register ?? null); r.tariff.push(pr?.tariffCode ?? null);
        r.estimated.push(!!pr?.estimated); r.unpriced.push(unpriced); r.weighted.push(!!pr?.weighted);
        r.origin.push(pr ? (inputsProvenance(pr.inputs ?? [])?.origin ?? null) : null);
        r.standing.push(pr ? fixedOver(pr, t, stepS, (de - ds) / stepS, tz) : null);
        r.quality.push((unpriced ? QUALITY.CHECK_FAILED : 0) | (pr?.estimated ? QUALITY.ESTIMATED : 0));
      }
      out[d] = r;
    }
    // Fixed charges per local day (Predbat's standing charge, PB-RATE-09), priced at the day's first
    // moment inside the window.
    for (let date = localDate(tz, g.start); date <= localDate(tz, g.end - 1); date = addDays(date, 1)) {
      const [ds, de] = dayBounds(tz, date);
      const row = { date, start: ds, end: de };
      for (const d of wanted) { const pr = priceAt(p, DIRECTIONS[d], Math.max(ds, g.start)); row[d] = pr ? fixedPerDay(pr, Math.max(ds, g.start), tz) : null; }
      out.standingPerDay.push(row);
    }
    out.origin = { rule: 'price_held_over_step (priceOver)', directions: wanted, tariffs: [...new Set(p.agreements.map((a) => a.tariff_code))], country: p.country, asOf };
    return out;
  });
}

// ───────────── forecast ─────────────

/**
 * The forecast of record of one metric as known at asOf (the latest issue the core had RECORDED by
 * then, facts.js readForecastAsOf), resampled to the step grid by the metric's rule, with the issue
 * that fed each step.
 * @param opts { case: 'central' | 'p10' | 'p50' | 'p90' (also pessimistic / median / optimistic),
 *   stepS = 300 | 'slot', asOf (ms), source (one or a list, in priority order) }
 *   A case other than central reads the case metric (solar_kwh_p10 ...); a metric with no such case
 *   gives every step null with `missing` saying why.
 * @returns {{ start, stepS, n, values, cover, quality, issuedAt (s, per step), recordedAt (ms, per
 *   step), sourceIndex, segments: [{ from, to, source, issuedAt, recordedAt }] (runs of steps fed by
 *   one issue), origin, bounds, missing? }}
 */
export function forecast(siteId, metric, from, to, opts = {}) {
  const at = momentOf(opts.asOf);
  const asOf = at.ms;
  const site = siteOf(siteId, at.knownAt);
  const stepS = stepOf(opts.stepS, site);
  const g = gridOf(site.timezone, from, to, stepS);
  const caseName = opts.case ?? 'central';
  if (!(caseName in CASES)) throw new RangeError(`case must be central, p10, p50 or p90, not ${caseName}`);
  const target = CASES[caseName] ? `${metric}_${CASES[caseName]}` : metric;
  metricDef(metric);
  const empty = (missing) => ({
    siteId, metric: target, case: caseName, start: g.start, stepS, n: g.n, values: new Array(g.n).fill(null), cover: new Array(g.n).fill(0),
    quality: new Array(g.n).fill(0), issuedAt: new Array(g.n).fill(null), recordedAt: new Array(g.n).fill(null), sourceIndex: new Array(g.n).fill(null),
    segments: [], origin: { sources: [], asOf }, bounds: [], missing,
  });
  if (!db.prepare('SELECT 1 FROM metric WHERE code = ?').get(target)) return empty(`no ${caseName} case is kept for ${metric}`);
  const def = metricDef(target);
  const traits = sourceTraits();
  // Priority: the solar forecast the home binds first, then every other forecast-only source, then the sources bound to the other roles.
  const fixed = target === 'solar_kwh' ? boundSources(siteId, ['solar_forecast']) : FORECAST_SOURCES[target];
  const prefer = fixed ?? [...boundSources(siteId, ['solar_forecast']), ...[...withFlag(traits, ['forecastOnly'])].sort(), ...boundSources(siteId, [...INTERVAL_ROLES, ...READING_ROLES])];
  const all = seriesFor(site, target);
  const groups = opts.source != null ? groupsBySource(all, opts.source, [], new Set())
    : fixed ? groupsBySource(all, prefer.filter((s) => all.some((r) => r.source === s)), [], new Set())
      : groupsBySource(all.filter((r) => r.source !== 'core_plan'), null, prefer, new Set(['core_plan']));
  if (!groups.length) return empty(`no forecast series of ${target} for this home`);
  const mode = def.aggregation === 'sum' ? 'sum' : def.aggregation === 'last' ? 'last' : 'mean';
  const sumLike = def.aggregation === 'sum' || def.aggregation === 'integrate';
  const bounds = [];
  const results = groups.map(({ series: list }) => {
    // A series without any fact is not read (see intervalsOf); the rest share one bounded read.
    const ids = list.map((s) => s.id).filter((id) => !noFacts(id));
    const span = ids.length ? facts.spanOf(ids) : null;
    bounds.push({ table: 'forecast_fact', seriesIds: ids, from: span == null ? null : g.start - span, to: g.end, ...(ids.length ? {} : { empty: true }) });
    const rows = !ids.length ? [] : typeof facts.readForecastAsOf === 'function'
      ? facts.readForecastAsOf(ids, g.start, g.end, asOf)
      // Older facts.js: the provider's issue time stands in for when the core recorded it.
      : ids.flatMap((id) => facts.readForecastOfRecord(id, span == null ? g.start : g.start - span, g.end, Math.floor(asOf / 1000)).map((r) => ({ ...r, series_id: id })));
    const bySeries = groupBySeries(rows);
    return combineSeries(ids.map((id) => overlapAccumulate(bySeries.get(id) || [], g, mode)), g.n, sumLike);
  });
  const out = fallbackSources(results, g, ['issued', 'recorded']);
  const sources = groups.map((x) => x.source);
  const segments = [];
  for (let k = 0; k < g.n; k++) {
    if (out.sourceIndex[k] == null) continue;
    const l = segments[segments.length - 1];
    const src = sources[out.sourceIndex[k]];
    if (l && l.to === g.start + k * stepS && l.source === src && l.issuedAt === out.issued[k]) l.to += stepS;
    else segments.push({ from: g.start + k * stepS, to: g.start + (k + 1) * stepS, source: src, issuedAt: out.issued[k], recordedAt: out.recorded[k] });
  }
  return {
    siteId, metric: target, case: caseName, unit: def.unit, start: g.start, stepS, n: g.n, values: out.values, cover: out.cover, quality: out.quality,
    issuedAt: out.issued, recordedAt: out.recorded, sourceIndex: out.sourceIndex, segments,
    origin: { rule: mode === 'sum' ? 'split_by_overlap' : mode === 'last' ? 'last_overlapping' : 'time_weighted_mean', sources, seriesIds: groups.map((x) => x.series.map((s) => s.id)), asOf, reader: typeof facts.readForecastAsOf === 'function' ? 'readForecastAsOf' : 'readForecastOfRecord' },
    bounds,
  };
}

// ───────────── loadHistory and predictLoad ─────────────

function historyDays(daysPrevious) {
  if (typeof daysPrevious === 'number') {
    if (!(Number.isInteger(daysPrevious) && daysPrevious >= 1)) throw new RangeError(`daysPrevious must be a whole number of days, not ${daysPrevious}`);
    return Array.from({ length: daysPrevious }, (_, i) => ({ daysAgo: i + 1, weight: 1 }));
  }
  if (Array.isArray(daysPrevious)) return daysPrevious.map((w, i) => ({ daysAgo: i + 1, weight: Number(w) }));
  if (daysPrevious && Array.isArray(daysPrevious.days)) {
    return daysPrevious.days.map((d, i) => ({ daysAgo: Number(d), weight: Number(daysPrevious.weights?.[i] ?? 1) }));
  }
  throw new RangeError('daysPrevious: a number of days, a list of weights (days 1..n), or { days, weights } as Predbat days_previous / days_previous_weight');
}

/**
 * Home load (kWh per step) of each of the previous days, on one LOCAL TIME-OF-DAY axis (index i =
 * local clock minute i x stepS / 60), as known at asOf. Per day: the inverter's load power integrated
 * and fitted to its daily load total (counterDifferenceSeries' rule), minus the energy of
 * excludeMetrics (Predbat car_charging_energy, PB-LOAD-22: EV dispatches by default, a heat pump's
 * heatpump_elec_kwh for PH-LINK-02), clamped at 0. A day without inverter samples falls back to
 * site_hh.home spread evenly over the slot's steps (flagged INTERPOLATED), only from rows built by asOf.
 * Clock changes: the hour repeated when clocks go back has two real steps per clock index (their
 * mean is kept); the hour skipped when they go forward is null on that day.
 * @param opts { daysPrevious = 7 (days 1..7) | [weights] (days 1..n) | { days: [7, 14], weights:
 *   [1, 0.5] }, stepS = 300 (must divide an hour), asOf (ms), excludeMetrics = ['ev_charge_kwh'],
 *   holidays: ['YYYY-MM-DD', ...] or (date) => bool }
 * @returns {{ axis: 'local_time_of_day', stepS, n, days: [{ date, daysAgo, weight, holiday, start,
 *   end, hours, dst, values, cover, quality, totalKwh, excludedKwh, fit, source }], origin, bounds }}
 */
export function loadHistory(siteId, opts = {}) {
  const at = momentOf(opts.asOf);
  const asOf = at.ms;
  const site = siteOf(siteId, at.knownAt);
  const tz = site.timezone;
  const stepS = stepOf(opts.stepS, site);
  if (3600 % stepS) throw new RangeError(`a load history step must divide an hour, not ${stepS}`);
  const wanted = historyDays(opts.daysPrevious ?? 7);
  if (wanted.some((d) => !(Number.isInteger(d.daysAgo) && d.daysAgo >= 1 && d.daysAgo <= 400) || !Number.isFinite(d.weight) || d.weight < 0)) {
    throw new RangeError('daysPrevious: days 1 to 400 back, weights >= 0');
  }
  const exclude = opts.excludeMetrics ?? ['ev_charge_kwh'];
  const isHoliday = typeof opts.holidays === 'function' ? opts.holidays : ((s) => (d) => s.has(d))(new Set(opts.holidays ?? []));
  const today = localDate(tz, Math.floor(asOf / 1000));
  const nTod = 86400 / stepS;
  const bounds = [];
  const days = facts.withKnownAt(at.knownAt, () => wanted.map(({ daysAgo, weight }) => {
    const date = addDays(today, -daysAgo);
    const f = fittedDays(siteId, tz, 'load_kwh', [date], stepS, today, bounds);
    const day = f.days[0];
    let source = 'readings';
    let values = f.values.slice(); let q = Array.from(f.q); const cover = Array.from(f.cover, (c) => Math.min(1, c / stepS));
    if (values.every((v) => v == null)) {
      // No inverter samples that day: the ledger's home use, if it was built by asOf.
      bounds.push({ table: 'site_hh', seriesIds: [], from: day.start, to: day.end });
      const rows = db.prepare('SELECT slot_start, dur_s, home, quality, built_at FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start')
        .all(siteId, day.start, day.end).filter((r) => r.built_at * 1000 <= asOf && r.home != null);
      source = rows.length ? 'site_hh' : null;
      for (const r of rows) {
        for (let t = r.slot_start; t < r.slot_start + r.dur_s; t += stepS) {
          const k = (t - day.start) / stepS;
          if (k < 0 || k >= values.length) continue;
          values[k] = (r.home * stepS) / r.dur_s; q[k] = r.quality | QUALITY.INTERPOLATED; cover[k] = 1;
        }
      }
    }
    // Energy to leave out (EV, heat pump ...), per real step.
    let excluded = 0;
    for (const metric of exclude) {
      const e = energyPerStep(site, metric, f.g, bounds);
      for (let k = 0; k < values.length; k++) {
        if (!e[k]) continue;
        excluded += e[k];
        if (values[k] != null) values[k] = Math.max(0, values[k] - e[k]);
      }
    }
    // Real steps to the local clock axis.
    const clock = localClock(tz, day.start, day.end);
    const acc = new Float64Array(nTod); const cnt = new Uint8Array(nTod); const covered = new Float64Array(nTod);
    const qq = new Array(nTod).fill(0); const seen = new Uint8Array(nTod);
    for (let k = 0; k < values.length; k++) {
      const i = Math.floor(clock(day.start + k * stepS) / stepS);
      seen[i] = 1;
      if (values[k] == null) continue;
      acc[i] += values[k]; cnt[i]++; covered[i] = Math.max(covered[i], cover[k]); qq[i] |= q[k] | (cover[k] < 1 - 1e-9 ? QUALITY.PARTIAL : 0);
    }
    const out = Array.from({ length: nTod }, (_, i) => (cnt[i] ? acc[i] / cnt[i] : null));
    const total = values.reduce((s, v) => s + (v ?? 0), 0);
    return {
      date, daysAgo, weight, holiday: !!isHoliday(date), start: day.start, end: day.end, hours: day.hours,
      dst: day.hours > 24 ? 'long' : day.hours < 24 ? 'short' : null,
      values: out, cover: Array.from(covered), quality: qq, missingClock: seen.reduce((m, s) => m + (s ? 0 : 1), 0),
      totalKwh: source ? total : null, excludedKwh: excluded, fit: day.fit, source,
    };
  }));
  return {
    siteId, axis: 'local_time_of_day', stepS, n: nTod, tz, today, days,
    origin: { rule: 'load_power_fitted_to_daily_total minus excluded energy, by local clock', excludeMetrics: exclude, asOf },
    bounds,
  };
}

// Energy (kWh) of one metric per step of g, 0 where none: interval energy split by overlap, or
// instant power integrated (the metric's first source in priority order). Used to leave EV or heat
// pump energy out of the load history.
function energyPerStep(site, metric, g, bounds) {
  const def = metricDef(metric);
  const e = new Float64Array(g.n);
  const kind = def.time_role === 'instant' ? 'reading' : 'interval';
  if (kind === 'reading' && def.aggregation !== 'integrate') throw new RangeError(`excludeMetrics: ${metric} is not an energy or power metric`);
  if (kind === 'interval' && def.aggregation !== 'sum') throw new RangeError(`excludeMetrics: ${metric} is not an energy metric`);
  const traits = sourceTraits();
  const groups = groupsBySource(seriesFor(site, metric), null, boundSources(site.id, kind === 'reading' ? READING_ROLES : INTERVAL_ROLES), withFlag(traits, ['forecastOnly', 'namedOnly']));
  if (!groups.length) return e;
  for (const s of groups[0].series) {
    if (kind === 'reading') {
      const holdS = traits.get(groups[0].source)?.holdS ?? DEFAULT_HOLD_S;
      bounds.push({ table: 'reading', seriesIds: [s.id], from: g.start - holdS, to: g.end });
      const h = holdAccumulate(facts.readReadings([s.id], g.start - holdS, g.end), g, holdS);
      for (let k = 0; k < g.n; k++) e[k] += h.energy[k];
    } else {
      const r = overlapAccumulate(intervalsOf(s.id, g.start, g.end, bounds), g, 'sum');
      for (let k = 0; k < g.n; k++) e[k] += r.value[k] ?? 0;
    }
  }
  return e;
}

/**
 * Predbat's days_previous weighting (PB-LOAD-09/10/16): for each local time-of-day step, the
 * weighted mean of the history days' load, times scaling. A day with no value at a step is left out
 * of that step's mean (Predbat fills such gaps from load power or its own history; here a gap is
 * never invented). Holiday days are left out unless includeHolidays. dropLowest leaves out the day
 * with the lowest total when more than one day remains (PB-LOAD-08 load_filter_modal).
 * @param history loadHistory() result
 * @param weights one per history day (default each day's own weight); 0 leaves a day out
 * @param scaling Predbat load_scaling (PB-LOAD-16), 1 by default
 * @returns {{ axis, stepS, n, values (kWh per step; null where no day has data), used: [dates], weights, scaling }}
 */
export function predictLoad(history, weights = null, scaling = 1, { dropLowest = false, includeHolidays = false } = {}) {
  if (!history?.days) throw new TypeError('predictLoad: a loadHistory() result');
  const w = weights ?? history.days.map((d) => d.weight);
  if (w.length !== history.days.length) throw new RangeError(`predictLoad: ${history.days.length} days but ${w.length} weights`);
  let use = history.days.map((d, i) => ({ d, w: Number(w[i]) })).filter((x) => x.w > 0 && (includeHolidays || !x.d.holiday) && x.d.values.some((v) => v != null));
  if (dropLowest && use.length > 1) {
    const total = (x) => x.d.values.reduce((s, v) => s + (v ?? 0), 0);
    const lowest = use.reduce((m, x) => (total(x) < total(m) ? x : m), use[0]);
    use = use.filter((x) => x !== lowest);
  }
  const values = Array.from({ length: history.n }, (_, i) => {
    let num = 0; let den = 0;
    for (const { d, w: wi } of use) if (d.values[i] != null) { num += wi * d.values[i]; den += wi; }
    return den > 0 ? (num / den) * scaling : null;
  });
  return { axis: history.axis, stepS: history.stepS, n: history.n, values, used: use.map((x) => x.d.date), weights: use.map((x) => x.w), scaling };
}

/** A time-of-day profile (predictLoad) laid onto a planning window's steps (window().todIndex). */
export function projectProfile(profile, frame) {
  if (profile.stepS !== frame.stepS) throw new RangeError(`profile step ${profile.stepS} s, window step ${frame.stepS} s`);
  return { start: frame.planStart, stepS: frame.stepS, n: frame.nSteps, values: frame.todIndex.map((i) => profile.values[i] ?? null) };
}

// ───────────── state and freshness ─────────────

// Live inputs: key -> [metric, how]. 'sum' adds the latest of several series, 'mean' averages them,
// 'max' takes the highest (a flag: on if any is on); otherwise the freshest series. A metric the
// registry does not have (yet) is simply absent.
const LIVE = {
  soc_pct: ['battery_soc_pct'], pv_w: ['solar_w', 'sum'], load_w: ['load_w', 'sum'], ev_w: ['ev_w', 'sum'],
  battery_temperature_c: ['battery_temperature_c', 'mean'], battery_calibrating: ['battery_calibrating', 'max'],
  ev_soc_pct: ['ev_soc_pct'], ev_charge_limit_pct: ['ev_charge_limit_pct'], ev_connected: ['ev_connected'],
  outdoor_temp_c: ['outdoor_temp_c'], indoor_temp_c: ['indoor_temp_c', 'mean'], setpoint_c: ['indoor_temp_setpoint_c', 'mean'],
  hot_water_temp_c: ['hot_water_temp_c', 'mean'], flow_temp_c: ['heatpump_flow_temp_c', 'mean'], return_temp_c: ['heatpump_return_temp_c', 'mean'],
  boiler_flow_temp_c: ['boiler_flow_temp_c', 'mean'], boiler_return_temp_c: ['boiler_return_temp_c', 'mean'],
  flow_setpoint_c: ['flow_temp_setpoint_c', 'mean'], radiator_temp_c: ['radiator_temp_c', 'mean'],
  heating_on: ['heating_on', 'max'], immersion_on: ['immersion_on', 'max'], valve_position_pct: ['valve_position_pct', 'mean'],
};
// Live order: realtime feeds first (contract flag live), then the sources the home binds for samples.
const liveOrder = (siteId, traits, asOfS = null) => [...[...traits].filter(([, v]) => v.live).map(([k]) => k).sort(), ...boundSources(siteId, READING_ROLES, asOfS)];

/**
 * The latest known live inputs of a home at asOf, each with the time of its reading so a planner can
 * gate on freshness: { value, unit, ts, ageS, source, seriesIds }. Sign conventions are Predbat's:
 * battery_w = discharge - charge (+ discharging), grid_w = export - import (- importing). soc_kwh is
 * soc_pct x the battery size as known at asOf. Plus the devices, attributes and settings as known then.
 * Each reading is the latest non-null one with ts <= asOf in the last lookbackS (2 days).
 */
export function state(siteId, asOf, { lookbackS = STATE_LOOKBACK_S } = {}) {
  const moment = momentOf(asOf);
  const ms = moment.ms;
  const at = Math.floor(ms / 1000);
  const site = siteOf(siteId, moment.knownAt);
  const bounds = [];
  const latest = (id) => {
    bounds.push({ table: 'reading', seriesIds: [id], from: at - lookbackS, to: at + 1 });
    return db.prepare(`SELECT ts, value, quality FROM reading WHERE series_id = ? AND ts <= ? AND ts > ? AND value IS NOT NULL AND ${facts.inForce()}
      ORDER BY ts DESC LIMIT 1`).get(id, at, at - lookbackS) ?? null;
  };
  const inputs = {};
  const traits = sourceTraits();
  const live = liveOrder(siteId, traits, moment.knownAt == null ? null : moment.knownAt / 1000);
  const forecastOnly = withFlag(traits, ['forecastOnly']);
  facts.withKnownAt(moment.knownAt, () => {
    const cache = new Map();
    // The freshest source of a metric; within it every series' latest reading.
    const read = (metric, how = 'one') => {
      if (cache.has(metric)) return cache.get(metric);
      const groups = groupsBySource(seriesFor(site, metric), null, live, forecastOnly);
      let best = null;
      for (const { source, series: list } of groups) {
        const got = list.map((s) => ({ id: s.id, r: latest(s.id) })).filter((x) => x.r);
        if (!got.length) continue;
        // 'one': the freshest series; otherwise every series combined, as old as its oldest reading.
        const use = how === 'one' ? [got.reduce((m, x) => (x.r.ts > m.r.ts ? x : m), got[0])] : got;
        const vals = use.map((x) => x.r.value);
        const value = how === 'sum' ? vals.reduce((a, b) => a + b, 0) : how === 'mean' ? vals.reduce((a, b) => a + b, 0) / vals.length
          : how === 'max' ? Math.max(...vals) : vals[0];
        const ts = Math.min(...use.map((x) => x.r.ts));
        if (!best || ts > best.ts) best = { value, ts, ageS: at - ts, source, seriesIds: use.map((x) => x.id), quality: use.reduce((q, x) => q | x.r.quality, 0) };
      }
      cache.set(metric, best);
      return best;
    };
    for (const [key, [metric, how]] of Object.entries(LIVE)) {
      const r = read(metric, how);
      if (r) inputs[key] = { ...r, unit: metricDef(metric).unit, metric };
    }
    // Predbat's signed powers from our two direction metrics, both from one source (the freshest
    // source where both have a reading); ts is the older of the two readings.
    const pair = (key, plus, minus) => {
      const ofPlus = seriesFor(site, plus); const ofMinus = seriesFor(site, minus);
      const sources = groupsBySource([...ofPlus, ...ofMinus], null, live, forecastOnly).map((x) => x.source);
      let best = null;
      for (const source of sources) {
        const a = ofPlus.find((s) => s.source === source); const b = ofMinus.find((s) => s.source === source);
        if (!a || !b) continue;
        const ra = latest(a.id); const rb = latest(b.id);
        if (!ra || !rb) continue;
        const ts = Math.min(ra.ts, rb.ts);
        if (!best || ts > best.ts) best = { value: ra.value - rb.value, ts, ageS: at - ts, source, seriesIds: [a.id, b.id], quality: ra.quality | rb.quality, unit: 'W', metric: `${plus} - ${minus}` };
      }
      if (best) inputs[key] = best;
    };
    pair('battery_w', 'battery_discharge_w', 'battery_charge_w');
    pair('grid_w', 'grid_export_w', 'grid_import_w');
  });
  const k = moment.knownAt;
  const batt = (() => { try { return attributeAt(siteId, 'battery_kwh', k); } catch { return null; } })();
  const batteryKwh = batt?.value ?? site.battery_kwh ?? null;
  if (inputs.soc_pct && batteryKwh) inputs.soc_kwh = { ...inputs.soc_pct, value: (inputs.soc_pct.value / 100) * batteryKwh, unit: 'kWh', metric: 'battery_soc_pct x battery_kwh', derived: true };
  const safe = (table, fn) => { if (!hasTable(table)) return {}; try { return fn(); } catch { return {}; } };
  return {
    siteId, asOf: ms, at, inputs,
    battery: { kwh: batteryKwh, source: batt?.source ?? (batteryKwh != null ? 'site (current value)' : null) },
    devices: devicesAt(siteId, '1', k).map((d) => ({ id: d.id, kind: d.kind, provider: d.provider, label: d.label, attrs: JSON.parse(d.attrs || '{}'), approximateAttrs: d.approximateAttrs })),
    attributes: safe('attribute_value', () => attributesAt({ siteId }, k)),
    settings: safe('site_setting', () => settingsAt(siteId, k)),
    site: { timezone: site.timezone, slot_s: slotLength(site), currency: site.currency ?? null, country: site.country ?? null },
    bounds,
  };
}

/**
 * The stale-input gate: each required input is ok, stale (older than its limit) or missing.
 * limits: { key: seconds | null } over DEFAULT_LIMITS (soc, battery, grid, PV and load power, 60 min);
 * a key with null is not required, an extra key (indoor_temp_c: 3600) is. ok is false when any
 * required input is stale or missing: the planner should then make a demand-only plan, saved with
 * status 'stale_inputs' and `reason` as its error (plans.js savePlan).
 */
export function freshnessOf(st, limits = {}) {
  const req = { ...DEFAULT_LIMITS, ...limits };
  const inputs = {}; const stale = []; const missing = [];
  for (const [key, limitS] of Object.entries(req)) {
    if (limitS == null) continue;
    const r = st.inputs[key];
    const status = !r ? 'missing' : r.ageS > limitS ? 'stale' : 'ok';
    if (status === 'stale') stale.push(key);
    if (status === 'missing') missing.push(key);
    inputs[key] = { status, ageS: r?.ageS ?? null, limitS, ts: r?.ts ?? null, source: r?.source ?? null };
  }
  const ok = !stale.length && !missing.length;
  const reason = ok ? null : [...stale.map((k) => `${k} ${inputs[k].ageS} s old (limit ${inputs[k].limitS} s)`), ...missing.map((k) => `${k} missing`)].join('; ');
  return { ok, demandOnly: !ok, status: ok ? 'ok' : 'stale_inputs', reason, asOf: st.asOf, inputs, stale, missing };
}
export const freshness = (siteId, asOf, limits = {}) => freshnessOf(state(siteId, asOf), limits);

// ───────────── window ─────────────

/**
 * The planning frame of docs/predbat-slot-compatibility.md for a zone and moment, with the index
 * math in one place. planStart = now rounded down to the home's LOCAL slot grid (slots start at
 * local midnight), minuteOffset = whole minutes gone in slot 0, firstStep = the step holding now.
 * Arrays: slotStarts, stepStarts (epoch s), todIndex (local clock step-of-day index of each step:
 * the index into a loadHistory / predictLoad profile), slotTodMin (local clock minute each slot
 * starts, as site_hh.tod_min), dayStartSteps (steps starting at local midnight: counter resets).
 * Index math: slotOf(step), stepOf(slot) (its first step), stepAt(ts), slotAt(ts) (-1 outside),
 * timeOfStep(i), timeOfSlot(j).
 */
export function frameFor(tz, nowSec, { horizonH = 48, slotS = 1800, stepS = STEP_S } = {}) {
  const now = Math.floor(Number(nowSec));
  if (!Number.isFinite(now)) throw new TypeError(`now must be epoch seconds, not ${nowSec}`);
  if (!(Number.isInteger(slotS) && slotS >= STEP_S && slotS <= 3600 && slotS % STEP_S === 0)) throw new RangeError(`slot length must be a multiple of ${STEP_S} s up to 3600, not ${slotS}`);
  if (!(Number.isInteger(stepS) && stepS > 0 && slotS % stepS === 0)) throw new RangeError(`the step (${stepS} s) must divide the slot (${slotS} s)`);
  if (!(horizonH > 0 && horizonH <= 24 * 14)) throw new RangeError(`horizonH must be between 0 and 336 hours, not ${horizonH}`);
  const planStart = slotFloor(now, slotS, slotPhase(tz, slotS, now));
  const stepsPerSlot = slotS / stepS;
  const nSlots = Math.ceil((horizonH * 3600) / slotS);
  const nSteps = nSlots * stepsPerSlot;
  const end = planStart + nSlots * slotS;
  const clock = localClock(tz, planStart, end);
  const stepStarts = Array.from({ length: nSteps }, (_, i) => planStart + i * stepS);
  const slotStarts = Array.from({ length: nSlots }, (_, j) => planStart + j * slotS);
  const todIndex = stepStarts.map((t) => Math.floor(clock(t) / stepS));
  const slotTodMin = slotStarts.map((t) => Math.floor(clock(t) / 60));
  const dayStartSteps = stepStarts.flatMap((t, i) => (clock(t) === 0 ? [i] : []));
  const inRange = (i, n) => (i >= 0 && i < n ? i : -1);
  return {
    tz, now, slotS, stepS, horizonH, planStart, end, minuteOffset: Math.floor((now - planStart) / 60), offsetS: now - planStart,
    firstStep: Math.floor((now - planStart) / stepS), stepsPerSlot, nSlots, nSteps,
    slotStarts, stepStarts, todIndex, slotTodMin, dayStartSteps,
    slotOf: (step) => Math.floor(step / stepsPerSlot),
    stepOf: (slot) => slot * stepsPerSlot,
    stepAt: (ts) => inRange(Math.floor((ts - planStart) / stepS), nSteps),
    slotAt: (ts) => inRange(Math.floor((ts - planStart) / slotS), nSlots),
    timeOfStep: (i) => planStart + i * stepS,
    timeOfSlot: (j) => planStart + j * slotS,
  };
}

/** The planning frame of a home at nowSec (its zone and slot length as known then): see frameFor. */
export function window(siteId, nowSec, { horizonH = 48, slotS = null, stepS = STEP_S } = {}) {
  const site = siteOf(siteId, Math.floor(Number(nowSec)) * 1000);
  return { siteId, ...frameFor(site.timezone, nowSec, { horizonH, slotS: slotS ?? slotLength(site), stepS }) };
}
