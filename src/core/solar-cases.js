// Pessimistic, median and optimistic solar cases for the next 48 hours (plan item B5), labelled
// derived. A planner scores a plan against the pessimistic case as well as the central one, so a
// cloudier day than forecast does not leave the battery short.
//
// Method, per slot of the home's own length (site.slot_s):
//  1 Central: the forecast of record of solar_kwh from `central` (default core_forecast, our own
//    calibrated forecast; 'quartz' is accepted): for each future period the latest issue made by
//    `now`, spread over slots by overlap.
//  2 History: for each finished slot of the last `historyDays` days in site_hh (same slot length,
//    not missing), this home's actual solar ÷ the central forecast of record for that slot (the
//    latest issue made before the slot started, the build's rule). Slots whose forecast is below
//    0.05 kWh per half-hour (scaled to the slot) are left out: a ratio of a near-zero forecast is noise.
//  3 Ratios are grouped by local time of day (slotOfDay: the clock, so a clock-change day lines up)
//    and the 0.1, 0.5 and 0.9 quantiles (linear interpolation, as forecast.js) are taken where a time
//    of day has at least `minSamples` ratios.
//  4 Each case = central × its quantile, capped at the most this home made in one slot over the
//    history window. Cases are therefore ordered p10 <= p50 <= p90 in every slot.
// No sun forecast (central 0) gives 0 in every case; a central below the 0.05 kWh threshold is used
// as it is in every case. A time of day below the sample guard gets no row ("insufficient history",
// counted in `insufficient`); when no time of day passes the guard nothing is stored and `reason`
// says "insufficient history". Stored with putForecasts as one issue at `now` per case series
// (solar_kwh_p10 / _p50 / _p90, source core_solar_cases), change-only like every forecast.
//
// Wiring: not a provider step. The cases depend on our own forecast, which src/jobs/sync.js stores
// after the provider steps (recordForecast), so the place to call deriveSolarCases(siteId, now) is
// right after recordForecast in syncSite, logged as its own step. It is not registered through
// providers.js registerAdapter: that would need a market_provider role and row for something that
// fetches nothing, and would change every market's plan. Until wired, call it by hand or from a job.
import { db } from '../db/db.js';
import { seriesId, putForecasts, readForecastOfRecord } from './facts.js';
import { nowSec as clockNow, slotLength, slotPhase, slotFloor, slotOfDay, eachSlotOverlap } from './time.js';

export const SOLAR_CASES_SOURCE = 'core_solar_cases';
export const SOLAR_CASES = Object.freeze([
  Object.freeze({ name: 'pessimistic', metric: 'solar_kwh_p10', q: 0.1 }),
  Object.freeze({ name: 'median', metric: 'solar_kwh_p50', q: 0.5 }),
  Object.freeze({ name: 'optimistic', metric: 'solar_kwh_p90', q: 0.9 }),
]);
// Decision rules, not measured quantities (the source contract in registry.js states the same).
export const SOLAR_CASE_DEFAULTS = Object.freeze({ central: 'core_forecast', historyDays: 30, minSamples: 10, hours: 48, minForecastKwhPerHalfHour: 0.05 });
const CENTRALS = ['core_forecast', 'quartz'];

const quantile = (sorted, p) => {
  const i = (sorted.length - 1) * p; const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
};
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// Energy forecasts (kWh per period) to kWh per slot, split by overlap.
function bySlot(facts, slotS, phase) {
  const out = new Map();
  for (const f of facts) if (f.value != null) eachSlotOverlap(f, slotS, phase, (s, share) => out.set(s, (out.get(s) || 0) + f.value * share));
  return out;
}

/**
 * Derive and store the solar cases of one home for the next `hours` (48) hours.
 * @param siteId the home
 * @param now    the moment of the run, epoch seconds (the issue time of what is stored)
 * @param opts   { central, historyDays, minSamples, hours, minForecastKwhPerHalfHour, dryRun, recordedAt }
 * @returns {{ siteId, issuedAt, origin: 'derived', central, slots, samples, buckets, insufficient,
 *   stored, reason, cases: [{ slot_start, central, p10, p50, p90 }] }} reason is null, or why nothing was stored
 */
export function deriveSolarCases(siteId, now = clockNow(), opts = {}) {
  const o = { ...SOLAR_CASE_DEFAULTS, ...opts };
  if (!CENTRALS.includes(o.central)) throw new Error(`central must be one of ${CENTRALS.join(', ')}, not ${o.central}`);
  const site = db.prepare('SELECT id, timezone, slot_s FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const tz = site.timezone;
  const slotS = slotLength(site);
  const phase = slotPhase(tz, slotS, now);
  const from = slotFloor(now, slotS, phase);
  const to = from + o.hours * 3600;
  const histFrom = from - o.historyDays * 86400;
  const minFc = (o.minForecastKwhPerHalfHour * slotS) / 1800;
  const centralS = seriesId('site', siteId, 'solar_kwh', o.central);
  const out = { siteId, issuedAt: now, origin: 'derived', central: { metric: 'solar_kwh', source: o.central, issued_at: null }, slots: 0, samples: 0,
    buckets: { usable: 0, short: 0 }, insufficient: 0, stored: Object.fromEntries(SOLAR_CASES.map((c) => [c.metric, 0])), reason: null, cases: [] };

  // ── 2 History: actual ÷ forecast of record, per local time of day ──
  const hist = db.prepare(`SELECT slot_start, tod_min, solar FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND dur_s = ?
      AND state != 'missing' AND solar IS NOT NULL ORDER BY slot_start`).all(siteId, histFrom, from, slotS);
  const fcRows = db.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts')
    .all(centralS, histFrom, from);
  const best = new Map();
  for (const f of fcRows) if (!best.has(f.start_ts) || f.issued_at > best.get(f.start_ts).issued_at) best.set(f.start_ts, f);
  const fcPast = bySlot(best.values(), slotS, phase);
  const ratios = new Map();
  let ceiling = 0;
  for (const r of hist) {
    ceiling = Math.max(ceiling, r.solar);
    const fc = fcPast.get(r.slot_start);
    if (fc == null || fc < minFc) continue;
    const k = Math.floor(r.tod_min / (slotS / 60));
    (ratios.get(k) || ratios.set(k, []).get(k)).push(r.solar / fc);
    out.samples++;
  }
  const q = new Map();
  for (const [k, xs] of ratios) {
    if (xs.length < o.minSamples) { out.buckets.short++; continue; }
    const s = [...xs].sort((a, b) => a - b);
    q.set(k, SOLAR_CASES.map((c) => quantile(s, c.q)));
    out.buckets.usable++;
  }
  if (!q.size) {
    out.reason = `insufficient history: no time of day has ${o.minSamples} slots with a forecast of record and an actual in the last ${o.historyDays} days (${out.samples} ratios in all)`;
    return out;
  }

  // ── 1 Central for the horizon, 4 the cases ──
  const central = readForecastOfRecord(centralS, from - 3600, to, now);
  if (!central.length) { out.reason = `no ${o.central} solar forecast issued by ${now}`; return out; }
  out.central.issued_at = Math.max(...central.map((f) => f.issued_at));
  const fcFuture = bySlot(central, slotS, phase);
  const cap = (v) => (ceiling > 0 ? Math.min(v, ceiling) : v);
  const rows = SOLAR_CASES.map(() => []);
  for (let s = from; s < to; s += slotS) {
    const c = fcFuture.get(s);
    if (c == null) continue;
    out.slots++;
    let vals;
    if (c <= 0) vals = SOLAR_CASES.map(() => 0);
    else if (c < minFc) vals = SOLAR_CASES.map(() => c);
    else {
      const qs = q.get(slotOfDay(tz, s, slotS));
      if (!qs) { out.insufficient++; continue; }
      vals = qs.map((x) => cap(c * x));
    }
    vals = vals.map(round6);
    vals.forEach((v, i) => rows[i].push({ start: s, end: s + slotS, value: v }));
    out.cases.push({ slot_start: s, central: round6(c), p10: vals[0], p50: vals[1], p90: vals[2] });
  }
  if (!out.cases.length) { out.reason = 'insufficient history: no forecast slot has a time of day with enough ratios'; return out; }
  if (!o.dryRun) {
    SOLAR_CASES.forEach((c, i) => {
      out.stored[c.metric] = putForecasts(seriesId('site', siteId, c.metric, SOLAR_CASES_SOURCE), now, rows[i], null, o.recordedAt != null ? { recordedAt: o.recordedAt } : {});
    });
  }
  return out;
}
