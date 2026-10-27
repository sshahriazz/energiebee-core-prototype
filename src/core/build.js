// Stage 5: the build engine. Turns facts into the slot timeline.
// A slot is the home's own length, site.slot_s: 15, 30 (the default, GB settlement) or 60
// minutes, anchored to local midnight (time.js). The engine's step stays the 5-minute sample.
//   1 Align      5-min power -> slot energy; fit each day to the daily totals
//   2 Reconcile  one value per node (meter beats CT); home use by energy balance. Interval facts
//                are spread over slots by overlap: energy is split, a mean (carbon) is time-weighted
//   3 Allocate   who fed whom (solar first to home, then battery, then grid)
//   4 Price      rate over the slot (priceOver: time-weighted when it spans two prices), taxes of
//                the home's country (tax_rule; GB VAT as before), cost per flow, fixed charges by the
//                slot's share of its day (monthly / yearly ones by real seconds), battery stock first
//                in, first out. Money is in minor units of the home's currency (site.currency).
//   5 Check      balance, meter vs CT, counter fit, rate coverage; state per slot
// Provenance: each slot's lineage records the weakest origin of the prices it used (tariff, rate
// rows, tax rules, contracted capacity: `origin`) with every placeholder or synthetic input named
// (`placeholder_inputs`), where its energy data came from (`data_origin`: synthetic for a demo
// home), and `estimated` when a price was a cautious default for a day type not known yet (the
// slot is also flagged QUALITY.ESTIMATED). Lineage only: no number changes.
// Each row carries its length (dur_s) and local time of day (tod_min); kW = kWh × 3600 / slot_s.
// Deterministic: the same facts, slot length and METHOD_VERSION always give the same rows.
//
// buildSite(site, from, to, { asOf }) rebuilds as the core stood at an earlier moment: every
// fact, price and system detail is read as it was known then, and "now" is that moment.
// With { dryRun } nothing is written and the rows are returned (for comparing with today's).
// With { trace: { slot } } (src/core/explain.js) the plain object is filled with the intermediate
// values of exactly that slot (samples, fit, meter vs clamp, balance, flows, prices, stock); it only
// reads values already computed, so no row changes. Absent, every trace line is skipped.
import { db, tx, optimizeDb } from '../db/db.js';
import { seriesId, readReadings, readIntervals, readForecastOfRecord, QUALITY, withKnownAt, inForce } from './facts.js';
import { attributeAt } from './attributes.js';
import { devicesAt } from './devices.js';
import { bindingsFor, sourceAt, holdSOf } from './inputs.js';
import { siteAt } from './versions.js';
import { loadPricing, priceOver, fixedOver } from './pricing.js';
import { METRICS } from '../db/registry.js';
import { nowSec, localDate, dayBounds, slotsOfDay, daysBetween, zonedParts, floorTo, addDays, slotLength, slotFloor, todMinute, slotNoun } from './time.js';
import { inputsProvenance, dataOriginOf } from './provenance.js';
import { buildHeat, hasHeatingSeries } from './heat.js';

export const METHOD_VERSION = 'v3-stock-follows-charge';

const NODES = {
  solar: ['solar_w', 'solar_kwh'], load: ['load_w', 'load_kwh'], imp: ['grid_import_w', 'grid_import_kwh'],
  exp: ['grid_export_w', 'grid_export_kwh'], chg: ['battery_charge_w', 'battery_charge_kwh'], dis: ['battery_discharge_w', 'battery_discharge_kwh'],
};

// Forward-hold integration: each sample holds for up to its source's hold time (r.hold, default 5 minutes). Energy is split at slot boundaries.
// `fl` maps an instant to the start of its slot (the home's grid), slotS is the slot length.
function integrate(readings, slotS, fl) {
  const energy = new Map();
  const cover = new Map();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (r.value == null) continue;
    const hold = r.hold ?? 300;
    const next = readings[i + 1]?.ts ?? r.ts + hold;
    const end = r.ts + Math.min(next - r.ts, hold);
    for (let s = r.ts; s < end;) {
      const slot = fl(s);
      const e = Math.min(end, slot + slotS);
      energy.set(slot, (energy.get(slot) || 0) + (r.value * (e - s)) / 3.6e6);
      cover.set(slot, (cover.get(slot) || 0) + (e - s));
      s = e;
    }
  }
  return { energy, cover };
}

const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());

// The facts of a list that may overlap [slot, slot + slotS), in their original order. Every slot
// starts on the 900 s grid, so the list is indexed once by 15-minute cell instead of scanned per slot.
const CELL = 900;
const cellIndex = new WeakMap();
function overlapping(intervals, slot, slotS) {
  let idx = cellIndex.get(intervals);
  if (!idx) {
    idx = new Map();
    intervals.forEach((f, i) => { for (let c = floorTo(f.start_ts, CELL); c < f.end_ts; c += CELL) (idx.get(c) || idx.set(c, []).get(c)).push(i); });
    cellIndex.set(intervals, idx);
  }
  const hit = new Set();
  for (let c = floorTo(slot, CELL); c < slot + slotS; c += CELL) for (const i of idx.get(c) || []) hit.add(i);
  return [...hit].sort((a, b) => a - b).map((i) => intervals[i]);
}

// Registry aggregation of each metric: 'sum' quantities (energy) are split by overlap,
// 'mean' quantities (carbon intensity) are averaged over the part of the slot they cover.
const AGGREGATION = new Map(METRICS.map((m) => [m.code, m.aggregation]));

// Interval facts over one slot [slot, slot + slotS). Sum: each fact's share by overlap
// (a half-hour meter reading is halved into two 15-minute slots, two are added into an hour).
// Mean: the time-weighted mean of the facts that overlap (a carbon intensity is not halved).
// `cover` is the seconds of the slot the facts span (for a sum, whether the slot is complete).
// `shape(f, slot)`, when given, can replace the time share of a fact longer than the slot with
// another share (the clamp's own profile, below); null keeps the time share.
function slotAgg(intervals, slot, slotS, mode = 'sum', shape = null) {
  let v = null; let w = 0; let cover = 0;
  for (const f of overlapping(intervals, slot, slotS)) {
    if (f.end_ts <= slot || f.start_ts >= slot + slotS || f.value == null) continue;
    const overlap = Math.min(f.end_ts, slot + slotS) - Math.max(f.start_ts, slot);
    cover += overlap;
    const share = shape && overlap < f.end_ts - f.start_ts ? shape(f, slot) : null;
    if (mode === 'mean') { v = (v || 0) + f.value * overlap; w += overlap; } else if (share != null) v = (v || 0) + f.value * share; else v = (v || 0) + (f.value * overlap) / (f.end_ts - f.start_ts);
  }
  return { value: v != null && mode === 'mean' ? v / w : v, cover };
}
const slotSum = (intervals, slot, slotS) => slotAgg(intervals, slot, slotS, 'sum').value;
// A meter's energy for a slot only when its readings cover the whole slot (an hour slot with
// one of its two half-hours read is not measured); otherwise null, so the clamp fills in.
const meterSum = (intervals, slot, slotS, shape = null) => { const r = slotAgg(intervals, slot, slotS, 'sum', shape); return r.cover >= slotS ? r.value : null; };

export function buildSite(siteId, fromDate, toDate, opts = {}) {
  return opts.asOf != null ? withKnownAt(opts.asOf * 1000, () => build(siteId, fromDate, toDate, opts)) : build(siteId, fromDate, toDate, opts);
}

// Counter-fit check codes, one per inverter daily counter.
const FIT_CHECK = { solar: 'counter_fit_solar', load: 'counter_fit_load', imp: 'counter_fit_import', exp: 'counter_fit_export', chg: 'counter_fit_charge', dis: 'counter_fit_discharge' };
// Energy balance: the day's inverter loss against this home's own typical loss.
const LOSS_HISTORY_DAYS = 30; const LOSS_MIN_DAYS = 7;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
// Fields a revision compares, with the smallest change that counts.
const REVISION_FIELDS = [['slots_final', 0], ['slots_provisional', 0], ['slots_missing', 0], ['solar', 0.001], ['home', 0.001], ['grid_import', 0.001],
  ['grid_export', 0.001], ['gas', 0.001], ['total_cost', 0.01], ['saving', 0.01]];
const SLOT_COUNTS = new Set(['slots_final', 'slots_provisional', 'slots_missing']);

// What changed between two versions of a day: figures beyond their smallest step, check results, method.
// A new slot length changes the slot counts without any data changing, so then the counts are
// not compared and the change is recorded once as slot_s (a day without slot_s was half-hours).
export function dayChanges(before, beforeChecks, after, afterChecks) {
  const changed = [];
  const slotBefore = before.slot_s ?? 1800; const slotAfter = after.slot_s ?? 1800;
  const resized = slotBefore !== slotAfter;
  if (resized) changed.push({ field: 'slot_s', from: slotBefore, to: slotAfter });
  for (const [k, eps] of REVISION_FIELDS) {
    if (resized && SLOT_COUNTS.has(k)) continue;
    const a = before[k]; const b = after[k];
    if ((a == null) !== (b == null) || (a != null && Math.abs(a - b) > eps)) changed.push({ field: k, from: a ?? null, to: b ?? null });
  }
  for (const code of new Set([...Object.keys(beforeChecks || {}), ...Object.keys(afterChecks || {})])) {
    if (beforeChecks?.[code] !== afterChecks?.[code]) changed.push({ field: `check:${code}`, from: beforeChecks?.[code] ?? null, to: afterChecks?.[code] ?? null });
  }
  if (before.method_version && after.method_version && before.method_version !== after.method_version) changed.push({ field: 'method_version', from: before.method_version, to: after.method_version });
  return changed;
}

function build(siteId, fromDate, toDate, opts) {
  // As known at asOf: the home's zone, slot length, currency, sizes ... as they stood then
  // (site_version, H5). { currentSettings: true } keeps today's settings (a what-if on old facts).
  const versioned = opts.asOf != null && !opts.currentSettings;
  const site = versioned ? siteAt(siteId, opts.asOf * 1000) : db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const tz = site.timezone;
  // The home's slot grid: its length, and where local midnight sits on it (0 for whole-hour zones).
  const slotS = slotLength(site);
  const asOf = opts.asOf ?? null;
  const now = asOf ?? nowSec();
  // Battery size as known then; before details were versioned, only today's value exists.
  const battAttr = asOf != null ? attributeAt(siteId, 'battery_kwh', asOf * 1000) : null;
  const batteryKwh = asOf != null ? (battAttr?.value ?? site.battery_kwh) : site.battery_kwh;
  const batterySource = asOf != null ? (battAttr ? battAttr.source : 'current value (no earlier record)') : (attributeAt(siteId, 'battery_kwh')?.source ?? null);
  const today = localDate(tz, now);
  if (toDate > today) toDate = today;
  if (fromDate > toDate) return { days: 0 };
  const [winStart] = dayBounds(tz, fromDate);
  const [, winEnd] = dayBounds(tz, toDate);
  const phase = ((winStart % slotS) + slotS) % slotS;
  const fl = (t) => slotFloor(t, slotS, phase);
  const sid = (metric, source) => seriesId('site', siteId, metric, source);
  // The calculation trace of one slot (opts.trace), or null: every `if (T…)` line below is then skipped.
  const T = opts.trace && Number.isFinite(opts.trace.slot) ? opts.trace : null;
  if (T) Object.assign(T, { slotS, tz, phase, now, asOf, winStart, winEnd, batteryKwh, batterySource, forecastSource: new Map() });

  // ── Facts for the whole window ──
  // The inverter's sources come from bindings (inputs.js). Each binding is a UNIT: a source, optionally a
  // device, for a period. Units that follow one another take turns; units that overlap in time are two
  // devices (two inverters, two batteries) and their figures are added. Each unit is integrated on its own
  // (its own samples and hold), then summed per slot, so interleaved samples never cut each other's hold.
  const bound5 = bindingsFor(siteId, 'inverter_5min', asOf);
  const boundDaily = bindingsFor(siteId, 'inverter_daily', asOf);
  const powerIds = Object.fromEntries(Object.keys(NODES).map((k) => [k, `power:${k}`]));
  const dailyIds = Object.fromEntries(Object.keys(NODES).map((k) => [k, `daily:${k}`]));
  const socId = 'soc';
  const unitSeries = (bd, metric) => (bd.deviceId == null ? sid(metric, bd.source) : seriesId('device', bd.deviceId, metric, bd.source));
  const unitRows = (bd, metric) => { const hold = holdSOf(bd.source); return readReadings([unitSeries(bd, metric)], Math.max(winStart - 600, bd.from), Math.min(winEnd, bd.to)).map((r) => ({ ...r, hold })); };
  const unitsAt = (units, t) => units.filter((bd) => t >= bd.from && t < bd.to);
  // Sum the units' slot energies; a slot is covered as far as its least covered active unit is.
  const sumUnits = (parts) => {
    if (parts.length === 1) return parts[0].it;
    const energy = new Map(); const cover = new Map();
    for (const { it } of parts) for (const [slot, v] of it.energy) energy.set(slot, (energy.get(slot) || 0) + v);
    for (const slot of new Set(parts.flatMap(({ it }) => [...it.cover.keys()]))) {
      const active = parts.filter(({ bd }) => slot + slotS > bd.from && slot < bd.to);
      cover.set(slot, active.length ? Math.min(...active.map(({ it }) => it.cover.get(slot) || 0)) : 0);
    }
    return { energy, cover };
  };
  const nodeRows = Object.fromEntries(Object.entries(NODES).map(([k, [w]]) => [k, bound5.map((bd) => ({ bd, rows: unitRows(bd, w) }))]));
  const aligned = Object.fromEntries(Object.keys(NODES).map((k) => [k, sumUnits(nodeRows[k].map(({ bd, rows }) => ({ bd, it: integrate(rows, slotS, fl) })))]));
  // Charge level: one unit as it is; several batteries at once as the average weighted by each one's size
  // (device attribute battery_kwh, else the home's); a timestamp where a size or a reading is missing is left out.
  const capOf = (bd) => { if (bd.deviceId == null) return batteryKwh ?? null; try { return JSON.parse(db.prepare('SELECT attrs FROM device WHERE id = ?').get(bd.deviceId)?.attrs || '{}').battery_kwh ?? null; } catch { return null; } };
  const socUnits = bound5.map((bd) => ({ bd, cap: capOf(bd), byTs: new Map(unitRows(bd, 'battery_soc_pct').map((r) => [r.ts, r])) }));
  const socRows = (() => {
    if (socUnits.length === 1) return [...socUnits[0].byTs.values()];
    const out = [];
    for (const ts of [...new Set(socUnits.flatMap((u) => [...u.byTs.keys()]))].sort((x, y) => x - y)) {
      const act = socUnits.filter((u) => ts >= u.bd.from && ts < u.bd.to);
      if (!act.length || act.some((u) => !u.byTs.has(ts))) continue;
      if (act.length === 1) { out.push(act[0].byTs.get(ts)); continue; }
      if (act.some((u) => !u.cap)) continue;
      const cap = act.reduce((t, u) => t + u.cap, 0);
      out.push({ ...act[0].byTs.get(ts), value: act.reduce((t, u) => t + u.byTs.get(ts).value * u.cap, 0) / cap });
    }
    return out;
  })();
  const readings = new Map([...Object.keys(NODES).map((k) => [powerIds[k], nodeRows[k].flatMap((u) => u.rows).sort((x, y) => x.ts - y.ts)]), [socId, socRows]]);
  // Charge level at the end of each slot: the last reading inside it.
  const socBySlot = new Map(socRows.map((r) => [fl(r.ts), r.value]));
  // The inverters' daily totals, one list per unit; a day's total is the sum over the units active that day, and
  // unknown when any of them has no total for it.
  const dailyUnits = Object.fromEntries(Object.entries(NODES).map(([k, [, kwh]]) => [k, boundDaily.map((bd) => ({ bd,
    rows: readIntervals([unitSeries(bd, kwh)], Math.max(winStart, bd.from), Math.min(winEnd, bd.to)).filter((f) => f.start_ts >= bd.from && f.start_ts < bd.to) }))]));
  const dailyTotal = (k, dayStart) => {
    const act = dailyUnits[k].filter(({ bd }) => dayStart >= bd.from && dayStart < bd.to);
    const hit = act.map(({ rows }) => rows.find((f) => f.start_ts === dayStart));
    if (!act.length || hit.some((f) => !f)) return undefined;
    return hit.length === 1 ? hit[0] : { ...hit[0], value: hit.reduce((t, f) => t + f.value, 0) };
  };
  const hasInverter = (readings.get(powerIds.solar) || []).length > 0 || (readings.get(powerIds.imp) || []).length > 0;

  // Meters in use, with their details (gas unit and zone), as known at the moment being built.
  const meters = devicesAt(siteId, "kind IN ('meter_import','meter_export','meter_gas') AND provider != 'env'", asOf != null ? asOf * 1000 : null);
  // Inputs read as they are now because no earlier version was kept (as-of rebuilds only).
  const approximations = [];
  for (const m of meters) if (m.approximateAttrs) approximations.push(`${m.kind} details as first recorded at ${new Date(m.approximateAttrs).toISOString()}`);
  if (asOf != null && !battAttr) approximations.push('battery size: current value (no earlier record)');
  if (versioned && site.approximateSettings != null) approximations.push(`home settings as first recorded at ${new Date(site.approximateSettings).toISOString()}`);
  // Every other input is a role too (inputs.js): the sources bound to it, each for the period it applies.
  // Facts of all of them are merged by time; a home without a source for a role has no such input.
  const meterBound = bindingsFor(siteId, 'meter_energy', asOf);
  const cvBound = bindingsFor(siteId, 'gas_cv', asOf);
  const carbonBound = bindingsFor(siteId, 'carbon', asOf);
  const weatherBound = bindingsFor(siteId, 'weather_temp', asOf);
  const evBound = bindingsFor(siteId, 'ev_dispatch', asOf);
  const forecastBound = bindingsFor(siteId, 'solar_forecast', asOf);
  const intervalsFrom = (bound, series, lo, hi) => bound.flatMap((bd) => readIntervals([series(bd.source)], Math.max(lo, bd.from), Math.min(hi, bd.to)).filter((f) => f.start_ts >= bd.from && f.start_ts < bd.to)).sort((a, b) => a.start_ts - b.start_ts);
  const meterSource = (slot) => sourceAt(meterBound, slot) ?? meterBound[0]?.source ?? null;
  const meterFacts = {};
  // Gas in m3 is converted per gas day with National Gas's calorific value for the meter's zone:
  // kWh = m3 × 1.02264 (volume correction) × CV (MJ/m3) ÷ 3.6. Without a published CV the
  // slot's gas stays unknown rather than converted with a typical value.
  let gasM3 = null; let gasCv = []; let gasLdz = null;
  for (const m of meters) {
    if (m.kind === 'meter_gas') {
      const attrs = JSON.parse(m.attrs || '{}');
      if (attrs.gasUnit?.unit === 'm3') {
        gasM3 = intervalsFrom(meterBound, (src) => seriesId('device', m.id, 'gas_m3', src), winStart, winEnd);
        gasLdz = attrs.ldz || null;
        gasCv = gasLdz ? intervalsFrom(cvBound, (src) => seriesId('region', `ldz:${gasLdz}`, 'gas_cv_mjm3', src), winStart - 86400, winEnd + 86400) : [];
        meterFacts.meter_gas = gasM3;
        continue;
      }
    }
    const metric = m.kind === 'meter_gas' ? 'gas_kwh' : m.kind === 'meter_export' ? 'grid_export_kwh' : 'grid_import_kwh';
    meterFacts[m.kind] = intervalsFrom(meterBound, (src) => seriesId('device', m.id, metric, src), winStart, winEnd);
  }
  const cvAt = (slot) => gasCv.find((f) => f.start_ts <= slot && f.end_ts > slot)?.value ?? null;
  const VOLUME_CORRECTION = 1.02264;   // Gas (Calculation of Thermal Energy) Regulations 1996
  const hasImportMeter = !!meterFacts.meter_import;
  // A configured supplier account means meter data is expected, even before its meters are known.
  const expectMeter = hasImportMeter || !!db.prepare("SELECT 1 FROM connection c JOIN market_provider mp ON mp.adapter = c.provider AND mp.role = 'meter' WHERE c.site_id = ?").get(siteId);
  const evFacts = intervalsFrom(evBound, (src) => sid('ev_charge_kwh', src), winStart, winEnd);
  const carbonFacts = site.carbon_region != null
    ? intervalsFrom(carbonBound, (src) => seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', src), winStart, winEnd) : [];
  const tempByHour = new Map(weatherBound.flatMap((bd) => readReadings([sid('outdoor_temp_c', bd.source)], Math.max(winStart - 3600, bd.from), Math.min(winEnd, bd.to))).map((r) => [r.ts, r.value]));
  // Solar forecast of record: for each period, the latest issue made before it started,
  // so a past slot is compared only with what was known in advance. Quartz when it
  // was used (panel angles known), otherwise our own stored forecast. Each forecast period
  // goes to the slots it overlaps, split by overlap (a 30-minute forecast feeds two 15-minute slots).
  const solarFc = [];
  for (const source of [...new Set(forecastBound.map((bd) => bd.source))]) {   // in priority order: the first source with a forecast for a slot wins
    const rows = db.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts AND issued_at <= ?')
      .all(sid('solar_kwh', source), winStart, winEnd, now);
    const best = new Map();
    for (const f of rows) if (!best.has(f.start_ts) || f.issued_at > best.get(f.start_ts).issued_at) best.set(f.start_ts, f);
    const covered = new Set(solarFc.map((f) => fl(f.start_ts)));
    for (const f of best.values()) if (!covered.has(fl(f.start_ts))) { solarFc.push(f); if (T) T.forecastSource.set(f, source); }
  }
  const solarFcBySlot = new Map();
  for (const f of solarFc) {
    for (let s = fl(f.start_ts); s < f.end_ts; s += slotS) {
      // A period wholly inside the slot counts as it is; one that straddles a boundary by its share.
      const inside = f.start_ts >= s && f.end_ts <= s + slotS;
      const part = inside ? (f.value || 0) : ((f.value || 0) * (Math.min(f.end_ts, s + slotS) - Math.max(f.start_ts, s))) / (f.end_ts - f.start_ts);
      (solarFcBySlot.get(s) || solarFcBySlot.set(s, []).get(s)).push(part);
    }
  }
  const pricing = loadPricing(siteId, winStart, winEnd, versioned ? site : null);
  const dataOrigin = dataOriginOf(site);
  if (T) Object.assign(T, { pricing, ids: { power: powerIds, daily: dailyIds, soc: socId }, hasInverter, hasImportMeter, expectMeter, gasM3: !!gasM3, gasLdz, approximations });

  // Rows as stored now: for the "revised" flag and the revision log. An as-of rebuild has no "before".
  const previous = asOf != null ? new Map() : new Map(db.prepare('SELECT slot_start, dur_s, state, quality, home, total_cost FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?')
    .all(siteId, winStart, winEnd).map((r) => [r.slot_start, r]));
  const previousDays = asOf != null ? new Map() : new Map(db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ?').all(siteId, fromDate, toDate).map((r) => [r.local_date, r]));
  const previousChecks = new Map();
  if (asOf == null) {
    for (const c of db.prepare('SELECT local_date, check_code, status FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ?').all(siteId, fromDate, toDate)) {
      previousChecks.set(c.local_date, { ...(previousChecks.get(c.local_date) || {}), [c.check_code]: c.status });
    }
  }
  // This home's daily inverter loss before the window (completed days), for the balance check.
  const lossHistory = asOf != null ? [] : db.prepare(`SELECT solar_to_loss + battery_to_loss + grid_to_loss AS loss FROM site_day WHERE site_id = ? AND local_date < ? AND local_date >= ?
      AND solar_to_loss + battery_to_loss + grid_to_loss IS NOT NULL AND solar_to_loss + battery_to_loss + grid_to_loss != 0 ORDER BY local_date`)
    .all(siteId, fromDate, addDays(fromDate, -LOSS_HISTORY_DAYS)).map((r) => r.loss);

  // Battery round trip for each day, measured from the inverter's own daily counters over
  // the 30 days ending that day: energy out ÷ (energy in − change in stored energy).
  // It depends only on facts up to that day, so a day gets the same value whether it is
  // rebuilt alone or as part of a full rebuild. Without enough data no loss is applied (1.0).
  const counterSum = db.prepare(`SELECT SUM(value) AS v FROM interval_fact WHERE series_id = ? AND ${inForce()} AND start_ts >= ? AND start_ts < ?`);
  const firstSoc = db.prepare(`SELECT ts, value FROM reading WHERE series_id = ? AND ${inForce()} AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1`);
  const lastSoc = db.prepare(`SELECT ts, value FROM reading WHERE series_id = ? AND ${inForce()} AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1`);
  const efficiencyFor = (date) => {
    const [a] = dayBounds(tz, addDays(date, -29)); const [, b] = dayBounds(tz, date);
    const dailySum = (k) => boundDaily.reduce((t, bd) => (Math.min(b, bd.to) > Math.max(a, bd.from) ? t + (counterSum.get(unitSeries(bd, NODES[k][1]), Math.max(a, bd.from), Math.min(b, bd.to))?.v || 0) : t), 0);
    const inKwh = dailySum('chg'); const outKwh = dailySum('dis');
    // The charge level at an end of the window: the units reading within ten minutes of the earliest (or latest)
    // reading are one moment; one unit as it is, several weighted by size.
    const socAt = (stmt, first) => {
      const got = socUnits.filter((u) => Math.min(b, u.bd.to) > Math.max(a, u.bd.from))
        .map((u) => ({ u, r: stmt.get(unitSeries(u.bd, 'battery_soc_pct'), Math.max(a, u.bd.from), Math.min(b, u.bd.to)) })).filter((x) => x.r);
      if (!got.length) return undefined;
      const edge = first ? Math.min(...got.map((x) => x.r.ts)) : Math.max(...got.map((x) => x.r.ts));
      const near = got.filter((x) => Math.abs(x.r.ts - edge) <= 600);
      if (near.length === 1) return near[0].r.value;
      if (near.some((x) => !x.u.cap)) return undefined;
      const cap = near.reduce((t, x) => t + x.u.cap, 0);
      return near.reduce((t, x) => t + x.r.value * x.u.cap, 0) / cap;
    };
    const s0 = socAt(firstSoc, true); const s1 = socAt(lastSoc, false);
    if (!batteryKwh || s0 == null || s1 == null || inKwh <= 5) return { eff: 1, note: 'not enough battery data to measure; no loss applied' };
    const stored = ((s1 - s0) / 100) * batteryKwh; const net = inKwh - stored; const r = net > 0 ? outKwh / net : null;
    if (r == null || r <= 0.5 || r > 1.02) return { eff: 1, note: `measured ${r?.toFixed(3) ?? '–'}, outside what is possible; no loss applied` };
    return { eff: Math.min(1, r), note: `${outKwh.toFixed(1)} kWh out ÷ (${inKwh.toFixed(1)} kWh in − ${stored.toFixed(1)} kWh change in stored energy), inverter counters, 30 days to ${date}` };
  };
  // Battery energy layers, first in first out: { kwh, p } (p = pence per stored kWh).
  // A rebuild that starts after the first day continues from the stock saved at the end
  // of the day before. On the first day the energy already in the battery at the first
  // charge-level reading is the opening layer; its cost is unknown (p = null).
  // An as-of rebuild starts from the opening layer (it always runs from the first day).
  const prevDay = asOf != null ? null : db.prepare('SELECT battery_stock FROM site_day WHERE site_id = ? AND local_date = ?').get(siteId, addDays(fromDate, -1));
  const socSeries = readings.get(socId) || [];
  const stock = prevDay?.battery_stock ? JSON.parse(prevDay.battery_stock).map(([kwh, p]) => ({ kwh, p })) : [];
  if (!prevDay?.battery_stock && batteryKwh && socSeries.length) stock.push({ kwh: (socSeries[0].value / 100) * batteryKwh, p: null });
  // Adjacent layers at the same price are one layer; first in first out is unchanged.
  const addLayer = (kwh, p) => { const last = stock[stock.length - 1]; if (last && last.p === p) last.kwh += kwh; else stock.push({ kwh, p }); };
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  let unknownStock = false; let lastEff = null;
  const hhRows = [];
  const dayRows = [];
  const checks = [];
  const dayInputs = new Map();

  for (const date of daysBetween(fromDate, toDate)) {
    const daySlots = slotsOfDay(tz, date, slotS);
    const slots = daySlots.filter((s) => s + slotS <= now);
    if (!slots.length) continue;
    // Slots in this day by length (46, 48 or 50 half-hours): the standing charge is spread by
    // each slot's share of the day's real length, so 23 and 25-hour days are exact too.
    const [dayStart, dayEnd] = dayBounds(tz, date);
    const nSlotsDay = (dayEnd - dayStart) / slotS;
    const { eff, note: effNote } = efficiencyFor(date);
    lastEff = { date, eff, note: effNote };
    // The traced slot's day: its length, battery round trip and (below) each node's fit.
    const TD = T && T.slot >= dayStart && T.slot < dayEnd ? (T.day = { date, today, dayStart, dayEnd, nSlotsDay, eff, effNote, align: {} }) : null;

    // ── 1 Align: fit each node's slots to the inverter's daily total ──
    const fit = {};
    for (const k of Object.keys(NODES)) {
      const totalRow = dailyTotal(k, dayStart);
      const sum = daySlots.reduce((s, sl) => s + (aligned[k].energy.get(sl) || 0), 0);
      fit[k] = 1;
      if (totalRow && sum > 0.05 && totalRow.value > 0) {
        const f = totalRow.value / sum;
        if (f > 0.6 && f < 1.6 && date < today) fit[k] = f;
        // The counters read in 0.1 kWh steps, so small totals also pass within 0.2 kWh.
        const ok = Math.abs(f - 1) <= 0.1 || Math.abs(totalRow.value - sum) <= 0.2;
        if (date < today) checks.push([date, FIT_CHECK[k], ok ? 'pass' : 'warn', f, 0.1, `inverter's daily counter ${totalRow.value} kWh vs 5-minute samples ${sum.toFixed(2)} kWh`]);
      }
      if (TD) TD.align[k] = { counter: totalRow ?? null, integratedDay: sum, fit: fit[k] };
    }
    const e = (k, slot) => (aligned[k].energy.get(slot) || 0) * fit[k];
    // Slots shorter than the meter's half-hour: the meter's energy is shared out in proportion to
    // what the clamp measured in each part (its 5-minute profile), so the parts keep the meter's
    // total and the clamp's shape. An even split would put import in a quarter-hour where the
    // house drew none and leave the other short, which reads as false losses. Without clamp data
    // over the half-hour (or with none flowing), the time share is used.
    const ctShape = (k) => (hasInverter ? (f, slot) => {
      let all = 0; let cov = 0;
      for (let s = fl(f.start_ts); s < f.end_ts; s += slotS) { all += aligned[k].energy.get(s) || 0; cov += aligned[k].cover.get(s) || 0; }
      return all > 1e-6 && cov >= 0.8 * (f.end_ts - f.start_ts) ? (aligned[k].energy.get(slot) || 0) / all : null;
    } : null);

    const day = { rows: [], mImp: 0, ctImpBoth: 0, mExp: 0, ctExpBoth: 0, home: 0, loss: 0, lossN: 0, rated: 0, gasNoCv: 0, meterSlots: 0, clampSlots: 0, estimated: 0, capacityUnknown: 0 };
    for (const slot of slots) {
      let q = 0;
      const coverage = hasInverter ? (aligned.solar.cover.get(slot) || aligned.imp.cover.get(slot) || 0) / slotS : 0;
      const TS = TD && slot === T.slot ? (T.slotTrace = { coverage }) : null;

      // ── 2 Reconcile ──
      const solar = hasInverter ? e('solar', slot) : 0;
      const chg = hasInverter ? e('chg', slot) : 0;
      const dis = hasInverter ? e('dis', slot) : 0;
      const mImp = hasImportMeter ? meterSum(meterFacts.meter_import, slot, slotS, ctShape('imp')) : null;
      const mExp = meterFacts.meter_export ? meterSum(meterFacts.meter_export, slot, slotS, ctShape('exp')) : null;
      let imp = null; let exp = null; let impSrc = null; let expSrc = null;
      if (mImp != null) { imp = mImp; impSrc = 'meter'; q |= QUALITY.MEASURED; }
      else if (hasInverter && coverage > 0) { imp = e('imp', slot); impSrc = 'clamp'; q |= QUALITY.FALLBACK; }
      if (mExp != null) { exp = mExp; expSrc = 'meter'; }
      else if (hasInverter && coverage > 0) { exp = e('exp', slot); expSrc = 'clamp'; if (meterFacts.meter_export) q |= QUALITY.FALLBACK; }
      const missing = imp == null;
      if (hasInverter && coverage < 0.8) q |= QUALITY.PARTIAL;

      // What the sources supplied beyond exports and charging. The house used the
      // inverter's measured load; the rest is the inverter's own conversion and
      // standby loss. Without a load reading the balance is all we have.
      const balance = solar + (imp || 0) + dis - (exp || 0) - chg;
      if (balance < -0.02) q |= QUALITY.SUSPECT;
      const measuredLoad = hasInverter && coverage > 0 ? e('load', slot) : null;
      const home = measuredLoad != null ? Math.min(measuredLoad, Math.max(0, balance)) : Math.max(0, balance);
      const loss = measuredLoad != null ? balance - measuredLoad : null;
      const meterVsCt = mImp != null && hasInverter && coverage > 0.5 ? mImp - e('imp', slot) : null;
      if (meterVsCt != null) { day.mImp += mImp; day.ctImpBoth += e('imp', slot); }
      if (mExp != null && hasInverter && coverage > 0.5) { day.mExp += mExp; day.ctExpBoth += e('exp', slot); }
      if (impSrc === 'meter') day.meterSlots++; else if (impSrc === 'clamp') day.clampSlots++;
      // The clamp's own reading, kept when the meter replaced it, so both can be shown side by side.
      const ct = hasInverter && coverage > 0 ? { imp: Math.round(e('imp', slot) * 1e4) / 1e4, exp: Math.round(e('exp', slot) * 1e4) / 1e4 } : null;
      const gasRaw = meterFacts.meter_gas ? meterSum(meterFacts.meter_gas, slot, slotS) : null;
      const cv = gasM3 && gasRaw != null ? cvAt(slot) : null;
      const gas = gasRaw == null ? null : gasM3 ? (cv != null ? (gasRaw * VOLUME_CORRECTION * cv) / 3.6 : null) : gasRaw;
      if (gasM3 && gasRaw != null && cv == null) day.gasNoCv++;
      const ev = slotSum(evFacts, slot, slotS);
      if (TS) {
        // The facts this slot read, with the share of a longer meter reading it took (null: time share).
        const over = (list, k) => {
          if (!list) return null;
          const shape = k ? ctShape(k) : null;
          return overlapping(list, slot, slotS).filter((f) => f.end_ts > slot && f.start_ts < slot + slotS).map((f) => {
            const overlap = Math.min(f.end_ts, slot + slotS) - Math.max(f.start_ts, slot);
            return { ...f, overlap, share: shape && overlap < f.end_ts - f.start_ts ? shape(f, slot) : null };
          });
        };
        TS.samples = Object.fromEntries([...Object.entries(powerIds), ['soc', socId]].map(([k, id]) => [k, (readings.get(id) || []).filter((r) => r.ts >= slot - 300 && r.ts < slot + slotS)]));
        TS.nodes = Object.fromEntries(Object.keys(NODES).map((k) => [k, { integrated: aligned[k].energy.get(slot) ?? null, coverS: aligned[k].cover.get(slot) ?? 0, fit: fit[k], fitted: hasInverter ? e(k, slot) : null }]));
        TS.meter = { import: over(meterFacts.meter_import, 'imp'), export: over(meterFacts.meter_export, 'exp'), gas: over(meterFacts.meter_gas, null), ev: over(evFacts, null),
          gasCv: gasM3 ? gasCv.find((f) => f.start_ts <= slot && f.end_ts > slot) ?? null : null, volumeCorrection: gasM3 ? VOLUME_CORRECTION : null };
        TS.reconcile = { meterSource: meterSource(slot), solar, chg, dis, mImp, mExp, imp, exp, impSrc, expSrc, missing, balance, measuredLoad, home, loss, meterVsCt, ct, gasRaw, cv, gas, ev };
      }

      // ── 3 Allocate (slot-level priority) ──
      const sToHome = Math.min(solar, home);
      const sLeft = solar - sToHome;
      const sToBatt = Math.min(sLeft, chg);
      const sToGrid = Math.min(Math.max(0, sLeft - sToBatt), exp || 0);
      const bToHome = Math.min(dis, Math.max(0, home - sToHome));
      const bToGrid = Math.min(Math.max(0, dis - bToHome), Math.max(0, (exp || 0) - sToGrid));
      const gToHome = Math.min(Math.max(0, home - sToHome - bToHome), imp || 0);
      // Grid charging is bounded by what was imported. Any charge left over came
      // from the battery itself (charge and discharge in the same slot).
      const gToBatt = Math.min(Math.max(0, chg - sToBatt), Math.max(0, (imp || 0) - gToHome));
      // Whatever each source supplied beyond those flows went into losses.
      const sToLoss = Math.max(0, solar - sToHome - sToBatt - sToGrid);
      const bToLoss = Math.max(0, dis - bToHome - bToGrid);
      const gToLoss = Math.max(0, (imp || 0) - gToHome - gToBatt);
      if (TS) TS.allocate = { sToHome, sLeft, sToBatt, sToGrid, bToHome, bToGrid, gToHome, gToBatt, sToLoss, bToLoss, gToLoss };

      // ── 4 Price ──
      const pi = priceOver(pricing, 'meter_import', slot, slotS);
      const pe = priceOver(pricing, 'meter_export', slot, slotS);
      const pg = gas != null ? priceOver(pricing, 'meter_gas', slot, slotS) : null;
      const impInc = pi?.unitEx != null ? pi.unitEx * (1 + pi.vat) : null;
      const expRate = pe?.unitEx != null ? pe.unitEx * (1 + pe.vat) : 0;
      if (impInc != null) { day.rated++; } else q |= QUALITY.CHECK_FAILED;
      // Where the prices came from (weakest input), and whether any was a cautious estimate.
      const prov = inputsProvenance([pi, pe, pg].flatMap((x) => x?.inputs ?? []));
      const priceEstimated = !!(pi?.estimated || pe?.estimated || pg?.estimated);
      if (priceEstimated) { q |= QUALITY.ESTIMATED; day.estimated++; }
      const capacityUnknown = !!(pi?.capacityUnknown || pg?.capacityUnknown);
      if (capacityUnknown) day.capacityUnknown++;
      if (TS) TS.price = { pi, pe, pg, impInc, expRate, prov, priceEstimated, capacityUnknown };

      // Battery stock, first in, first out: draw what was discharged, then add what was charged.
      if (TS) TS.stock = { before: stock.map((l) => ({ ...l })), eff };
      let draw = dis; let drawCost = 0; let fromUnknown = 0;
      while (draw > 1e-9 && stock.length) {
        const l = stock[0]; const take = Math.min(draw, l.kwh);
        if (l.p == null) fromUnknown += take; else drawCost += take * l.p;
        l.kwh -= take; draw -= take;
        if (l.kwh <= 1e-9) stock.shift();
      }
      // Unknown when energy comes from the opening layer, or more is drawn than the records hold.
      const unknownDraw = fromUnknown > 1e-6 || draw > 1e-6;
      if (unknownDraw) { unknownStock = true; q |= QUALITY.ESTIMATED; }
      if (TS) Object.assign(TS.stock, { drawCost, fromUnknown, notCovered: draw, unknownDraw, afterDraw: stock.map((l) => ({ ...l })) });
      if (gToBatt > 0) addLayer(gToBatt * eff, (impInc ?? 0) / eff);
      if (sToBatt > 0) addLayer(sToBatt * eff, 0);   // solar has no fuel cost
      if (TS) TS.stock.afterCharge = stock.map((l) => ({ ...l }));
      // The stock follows the measured charge level. Energy in × efficiency − energy out drifts
      // from what the battery holds (efficiency and capacity are measured, not exact); left alone
      // it ran dry while the battery still held 20%. All layers are scaled together, so their
      // price mix is kept. Stock with no records behind it (only possible before any charge) has unknown cost.
      const socEnd = socBySlot.get(slot);
      if (socEnd != null && batteryKwh) {
        const held = (socEnd / 100) * batteryKwh;
        const total = stock.reduce((t, l) => t + l.kwh, 0);
        if (TS) TS.stock.soc = { socEnd, held, total };
        if (total > 1e-6) { const k = held / total; for (const l of stock) l.kwh *= k; } else if (held > 1e-6) stock.push({ kwh: held, p: null });
      }
      if (TS) TS.stock.after = stock.map((l) => ({ ...l }));

      // Fixed charges with their taxes (a credit such as the Dutch heffingskorting is negative).
      const standing = pi ? fixedOver(pi, slot, slotS, nSlotsDay, tz) + (pg ? fixedOver(pg, slot, slotS, nSlotsDay, tz) : 0) : 0;
      const gasCost = gas != null && pg?.unitEx != null ? gas * pg.unitEx * (1 + pg.vat) : (gas != null ? null : 0);
      const gToHomeCost = impInc != null ? gToHome * impInc : null;
      const gToBattCost = impInc != null ? gToBatt * impInc : null;
      const lossCost = impInc != null ? gToLoss * impInc : null;
      // Unknown when any of the energy drawn was stored before the data starts.
      const bToHomeCost = dis > 0 ? (unknownDraw ? null : drawCost * (bToHome / dis)) : 0;
      const exportCredit = (sToGrid + bToGrid) * expRate;
      // The bill is every imported kWh at its price (including what the inverter lost), plus standing and gas, minus export.
      const totalCost = impInc != null ? gToHomeCost + gToBattCost + lossCost + standing + (gasCost || 0) - exportCredit : null;
      const gridOnly = impInc != null ? home * impInc + standing + (gasCost || 0) : null;
      const ci = slotAgg(carbonFacts, slot, slotS, AGGREGATION.get('carbon_intensity')).value ?? null;
      const carbonG = ci != null && imp != null ? imp * ci : null;
      const carbonSaved = ci != null ? home * ci - (carbonG || 0) : null;
      const temp = tempByHour.get(floorTo(slot, 3600)) ?? null;
      const fcRows = solarFcBySlot.get(slot) || [];
      const solarForecast = fcRows.length ? fcRows.reduce((s, v) => s + v, 0) : null;
      if (TS) {
        TS.costs = { standing, gasCost, gToHomeCost, gToBattCost, lossCost, bToHomeCost, exportCredit, totalCost, gridOnly };
        TS.context = { ci, carbon: overlapping(carbonFacts, slot, slotS).filter((f) => f.end_ts > slot && f.start_ts < slot + slotS), carbonG, carbonSaved, temp, tempHour: floorTo(slot, 3600), solarForecast, forecastParts: [...fcRows],
          forecast: solarFc.filter((f) => f.start_ts < slot + slotS && f.end_ts > slot).map((f) => ({ ...f, source: T.forecastSource.get(f) ?? null })) };
      }

      // ── 5 Check and state ──
      let state = 'final';
      if (missing) state = 'missing';
      else if ((expectMeter && mImp == null) || date >= today) state = 'provisional';
      const prev = previous.get(slot);
      // Once revised, always marked: the flag survives later rebuilds.
      // A row of another slot length is a different slot, not an earlier version of this one.
      if (prev && prev.dur_s === slotS && ((prev.quality & QUALITY.RESTATED) || (prev.state === 'final' && (Math.abs((prev.home ?? 0) - home) > 0.001 || Math.abs((prev.total_cost ?? 0) - (totalCost ?? 0)) > 0.01)))) q |= QUALITY.RESTATED;
      if (TS) TS.state = { state, date, today, expectMeter, prev: prev ?? null };

      const row = {
        site_id: siteId, slot_start: slot, local_date: date, dur_s: slotS, tod_min: todMinute(tz, slot), state, quality: q, currency: site.currency ?? null,
        solar, grid_import: imp, grid_export: exp, battery_charge: chg, battery_discharge: dis, home, loss, gas, ev,
        soc_end: socBySlot.get(slot) ?? null,
        solar_to_home: sToHome, solar_to_battery: sToBatt, solar_to_grid: sToGrid, battery_to_home: bToHome,
        battery_to_grid: bToGrid, grid_to_home: gToHome, grid_to_battery: gToBatt,
        solar_to_loss: sToLoss, battery_to_loss: bToLoss, grid_to_loss: gToLoss, loss_cost: lossCost,
        // import_rate_ex x (1 + import_vat) is the price paid; export_rate is the price received (after any tax).
        import_rate_ex: pi?.unitEx ?? null, import_vat: pi?.vat ?? null, export_rate: pe?.unitEx != null ? expRate : null,
        gas_rate_ex: pg?.unitEx ?? null, gas_vat: pg?.vat ?? null,
        grid_to_home_cost: gToHomeCost, grid_to_battery_cost: gToBattCost, battery_to_home_cost: bToHomeCost,
        export_credit: exportCredit, standing_cost: standing, gas_cost: gasCost, total_cost: totalCost,
        grid_only_cost: gridOnly, saving: gridOnly != null ? gridOnly - totalCost : null,
        carbon_intensity: ci, carbon_g: carbonG, carbon_saved_g: carbonSaved, outdoor_temp: temp, solar_forecast: solarForecast,
        meter_vs_ct: meterVsCt, rate_found: impInc != null ? 1 : 0,
        lineage: JSON.stringify({ import: impSrc, export: expSrc, ...(impSrc === 'meter' || expSrc === 'meter' ? { meter: meterSource(slot) } : {}), solar: hasInverter ? sourceAt(bound5, slot) : null, fit, tariff: pi?.tariffCode ?? null, register: pi?.register ?? null, ...(pi ? { tax: pi.tax.source, ...(pi.tax.unverified ? { taxUnverified: true } : {}), ...(pi.levy ? { levy: pi.levy } : {}) } : {}), carbon: ci != null ? sourceAt(carbonBound, slot) : null, coverage: Math.round(coverage * 100) / 100, ...(ct ? { ct } : {}), ...(gasM3 && gasRaw != null ? { gasM3: Math.round(gasRaw * 1000) / 1000, gasCv: cv, gasLdz, gasCvSource: cv != null ? sourceAt(cvBound, slot) : 'not published yet' } : {}),
          ...(prov ? { origin: prov.origin, placeholder_inputs: prov.placeholder_inputs } : {}), data_origin: dataOrigin,
          ...(priceEstimated ? { estimated: true } : {}), ...(capacityUnknown ? { capacity_unknown: true } : {}) }),
        method_version: METHOD_VERSION, built_at: now,
      };
      day.rows.push(row);
      if (TS) TS.row = row;
      day.home += home;
      if (loss != null) { day.loss += loss; day.lossN++; }
    }
    hhRows.push(...day.rows);

    // ── Day row and checks ──
    const R = day.rows;
    const sum = (k) => R.reduce((s, r) => s + (r[k] ?? 0), 0);
    const anyNull = (k) => R.some((r) => r[k] == null);
    const solarSum = sum('solar');
    const homeSum = sum('home');
    // kWh in a slot to mean kW over it: × 3600 / slot length (× 2 for a half-hour).
    const kw = 3600 / slotS;
    const nightHome = R.filter((r) => { const h = zonedParts(tz, r.slot_start).hh; return h >= 1 && h < 5; }).map((r) => r.home * kw);
    const socs = R.map((r) => r.soc_end).filter((v) => v != null);
    const dayRow = {
      site_id: siteId, local_date: date, slots: R.length, slot_s: slotS, currency: site.currency ?? null,
      slots_final: R.filter((r) => r.state === 'final').length, slots_provisional: R.filter((r) => r.state === 'provisional').length,
      slots_missing: R.filter((r) => r.state === 'missing').length,
      ...Object.fromEntries(['solar', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'home', 'loss', 'gas', 'ev',
        'solar_to_home', 'solar_to_battery', 'solar_to_grid', 'battery_to_home', 'battery_to_grid', 'grid_to_home', 'grid_to_battery',
        'solar_to_loss', 'battery_to_loss', 'grid_to_loss', 'loss_cost',
        'grid_to_home_cost', 'grid_to_battery_cost', 'battery_to_home_cost', 'export_credit', 'standing_cost', 'gas_cost',
        'total_cost', 'grid_only_cost', 'saving', 'carbon_g', 'carbon_saved_g'].map((k) => [k, anyNull(k) && ['total_cost', 'grid_only_cost', 'saving'].includes(k) ? null : sum(k)])),
      // Gas with no reading in any slot is unknown for the day, not zero.
      gas: R.some((r) => r.gas != null) ? sum('gas') : null,
      solar_forecast: R.some((r) => r.solar_forecast != null) ? sum('solar_forecast') : null,
      self_consumption: solarSum > 0.01 ? (sum('solar_to_home') + sum('solar_to_battery')) / solarSum : null,
      self_sufficiency: homeSum > 0.01 ? 1 - sum('grid_to_home') / homeSum : null,
      blended_cost: homeSum > 0.01 && !anyNull('grid_to_home_cost') && !R.some((r) => r.battery_to_home > 0 && r.battery_to_home_cost == null) ? (sum('grid_to_home_cost') + sum('battery_to_home_cost')) / homeSum : null,
      peak_import_kw: Math.max(0, ...R.map((r) => (r.grid_import ?? 0) * kw)),
      base_load_kw: nightHome.length ? Math.min(...nightHome) : null,
      soc_min: socs.length ? Math.min(...socs) : null, soc_max: socs.length ? Math.max(...socs) : null,
      battery_cycles: batteryKwh ? sum('battery_discharge') / batteryKwh : null,
      // Share of slots that are present, priced and pass the balance; finality is reported separately by state.
      integrity: R.length ? R.filter((r) => r.state !== 'missing' && !(r.quality & (QUALITY.SUSPECT | QUALITY.CHECK_FAILED))).length / R.length : null,
      battery_eff: eff,
      // Rounded at every day end (whether rebuilt alone or in a full rebuild), so both give the same numbers.
      battery_stock: (() => {
        for (let i = stock.length - 1; i >= 0; i--) { stock[i].kwh = round6(stock[i].kwh); if (stock[i].p != null) stock[i].p = round6(stock[i].p); if (stock[i].kwh <= 0) stock.splice(i, 1); }
        return JSON.stringify(stock.map((l) => [l.kwh, l.p]));
      })(),
      method_version: METHOD_VERSION, built_at: now,
    };
    dayRows.push(dayRow);
    dayInputs.set(date, { batteryKwh, batterySource, meterSlots: day.meterSlots, clampSlots: day.clampSlots });
    if (day.mImp > 0.1) {
      const diff = (day.mImp - day.ctImpBoth) / day.mImp;
      checks.push([date, 'meter_vs_ct', Math.abs(diff) <= 0.05 ? 'pass' : 'warn', diff, 0.05, `meter ${day.mImp.toFixed(2)} kWh vs inverter CT ${day.ctImpBoth.toFixed(2)} kWh`]);
    }
    if (day.mExp > 0.1) {
      const diff = (day.mExp - day.ctExpBoth) / day.mExp;
      checks.push([date, 'meter_vs_ct_export', Math.abs(diff) <= 0.05 || Math.abs(day.mExp - day.ctExpBoth) <= 0.2 ? 'pass' : 'warn', diff, 0.05, `meter ${day.mExp.toFixed(2)} kWh vs inverter CT ${day.ctExpBoth.toFixed(2)} kWh exported`]);
    }
    // What each source supplied beyond the house, exports and charging is what the inverter
    // used or lost (the *_to_loss flows, the same figure every page prices). It is judged
    // against this home's own typical day, not a fixed share: an inverter's standby use is
    // roughly constant, so a fixed share of house use flags every quiet day.
    if (day.lossN && date < today) {
      day.loss = sum('solar_to_loss') + sum('battery_to_loss') + sum('grid_to_loss');
      const share = day.home > 0.1 ? ` (${((day.loss / day.home) * 100).toFixed(1)}% of home use)` : '';
      if (lossHistory.length >= LOSS_MIN_DAYS) {
        const typical = median(lossHistory.slice(-LOSS_HISTORY_DAYS));
        const band = Math.max(1, 0.5 * typical);
        const ok = Math.abs(day.loss - typical) <= band && day.loss > -0.5;
        checks.push([date, 'energy_balance', ok ? 'pass' : 'warn', day.loss, band, `inverter used or lost ${day.loss.toFixed(1)} kWh${share}; typical ${typical.toFixed(1)} kWh (median of the ${Math.min(lossHistory.length, LOSS_HISTORY_DAYS)} days before), allowed ±${band.toFixed(1)} kWh`]);
      } else {
        checks.push([date, 'energy_balance', 'skip', day.loss, null, `inverter used or lost ${day.loss.toFixed(1)} kWh${share}; this home's typical day is not known yet (needs ${LOSS_MIN_DAYS} earlier days, has ${lossHistory.length})`]);
      }
      lossHistory.push(day.loss);
    }
    checks.push([date, 'rate_coverage', day.rated === R.length ? 'pass' : (day.rated === 0 ? 'fail' : 'warn'), R.length ? day.rated / R.length : 0, 1, `${day.rated} of ${R.length} ${slotNoun(slotS)}s priced`]);
    if (day.estimated) checks.push([date, 'price_estimated', 'warn', day.estimated, 0, `${day.estimated} of ${R.length} ${slotNoun(slotS)}s priced with a cautious default: the day type (e.g. a Tempo colour) was not known yet`]);
    if (day.capacityUnknown) checks.push([date, 'capacity_charge', 'warn', day.capacityUnknown, 0, `the tariff has a capacity charge per kW, but this home's contracted capacity is not known: ${day.capacityUnknown} ${slotNoun(slotS)}s leave it out`]);
    if (gasM3) checks.push([date, 'gas_calorific_value', day.gasNoCv ? 'warn' : 'pass', day.gasNoCv, 0, day.gasNoCv ? `${day.gasNoCv} ${slotNoun(slotS)}s of gas wait for National Gas's calorific value for ${gasLdz}` : `converted with National Gas's calorific value for ${gasLdz}`]);
    checks.push([date, 'completeness', dayRow.slots_missing === 0 ? 'pass' : 'warn', R.length ? 1 - dayRow.slots_missing / R.length : 0, 1, `${dayRow.slots_final} final, ${dayRow.slots_provisional} provisional, ${dayRow.slots_missing} missing`]);
  }
  if (unknownStock && checks.length) checks.push([fromDate, 'battery_stock', 'warn', null, null, `Energy already in the battery when the data starts has unknown cost; those ${slotNoun(slotS)}s show no stored cost`]);
  if (lastEff) checks.push([lastEff.date, 'battery_efficiency', lastEff.eff < 1 ? 'pass' : 'skip', lastEff.eff, null, lastEff.eff < 1 ? `measured round trip ${(lastEff.eff * 100).toFixed(1)}%: ${lastEff.note}` : lastEff.note]);

  if (opts.dryRun) return { days: dayRows.length, slots: hhRows.length, hhRows, dayRows, checks, inputs: Object.fromEntries(dayInputs), approximations };

  // ── Revision log: completed days whose figures, state or checks changed ──
  const revisions = [];
  const checksByDay = new Map();
  for (const [d, code, status] of checks) checksByDay.set(d, { ...(checksByDay.get(d) || {}), [code]: status });
  for (const r of dayRows) {
    if (r.local_date >= today) continue;          // today is still filling in
    const before = previousDays.get(r.local_date);
    const nowChecks = checksByDay.get(r.local_date) || {};
    const changed = before ? dayChanges(before, previousChecks.get(r.local_date) || {}, r, nowChecks) : [];
    // A day built before this log existed has no earlier record: its first row is where history starts.
    const first = !db.prepare('SELECT 1 FROM site_day_revision WHERE site_id = ? AND local_date = ? LIMIT 1').get(siteId, r.local_date);
    if (before && !first && !changed.length) continue;
    revisions.push([siteId, r.local_date, now, r.method_version, first && before ? `${opts.reason || 'rebuild'} (first record of this day)` : (opts.reason || null),
      r.slots_final, r.slots_provisional, r.slots_missing, r.solar, r.home, r.grid_import, r.grid_export, r.gas, r.total_cost, r.saving,
      JSON.stringify(nowChecks), JSON.stringify(dayInputs.get(r.local_date) || {}), before && !first ? JSON.stringify(changed) : null]);
  }

  // ── Write serving rows (replace the window) ──
  tx(() => {
    db.prepare('DELETE FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?').run(siteId, winStart, winEnd);
    db.prepare('DELETE FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ?').run(siteId, fromDate, toDate);
    db.prepare('DELETE FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ?').run(siteId, fromDate, toDate);
    if (hhRows.length) {
      const cols = Object.keys(hhRows[0]);
      const ins = db.prepare(`INSERT INTO site_hh (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of hhRows) ins.run(...cols.map((c) => r[c] ?? null));
    }
    if (dayRows.length) {
      const cols = Object.keys(dayRows[0]);
      const ins = db.prepare(`INSERT INTO site_day (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of dayRows) ins.run(...cols.map((c) => (typeof r[c] === 'number' && !Number.isFinite(r[c]) ? null : r[c] ?? null)));
    }
    const insC = db.prepare('INSERT OR REPLACE INTO check_result (site_id, local_date, check_code, status, measured, tolerance, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of checks) insC.run(siteId, ...c);
    const insR = db.prepare(`INSERT INTO site_day_revision (site_id, local_date, revised_at, method_version, reason, slots_final, slots_provisional, slots_missing,
      solar, home, grid_import, grid_export, gas, total_cost, saving, checks, inputs, changed) VALUES (${Array(18).fill('?').join(',')})`);
    for (const r of revisions) insR.run(...r);
  });
  return { days: dayRows.length, slots: hhRows.length };
}

// The first and last instant of a home's own energy data (inverter samples or meter readings).
export function factSpan(siteId) {
  const sources = [...new Set(bindingsFor(siteId, 'inverter_5min').map((b) => b.source))];
  return db.prepare(`SELECT MIN(a) AS first, MAX(b) AS last FROM (
      SELECT MIN(r.ts) AS a, MAX(r.ts) AS b FROM reading r JOIN series se ON se.id = r.series_id JOIN source so ON so.id = se.source_id
        WHERE se.subject_kind = 'site' AND se.subject_id = ? AND so.code IN (${sources.map(() => '?').join(',') || "''"})
      UNION ALL SELECT MIN(f.start_ts), MAX(f.end_ts) - 1 FROM interval_fact f JOIN series se ON se.id = f.series_id
        WHERE se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))`).get(String(siteId), ...sources, siteId) ?? {};
}

// Rebuild from the earliest day a change touched to the latest day it asked for (the sync asks
// up to now, so today). Each day saves its battery stock, so the rebuild continues from the day
// before; it falls back to the first day only when that saved stock is missing (for example rows
// built before it was saved). The range never starts before the home's first energy data, and a
// request that ends in the past (a slot-length change of a home whose data stops there) is not
// stretched to today, so no run of empty days is built.
export function processQueue() {
  const pending = db.prepare('SELECT site_id, MIN(from_ts) AS from_ts, MAX(to_ts) AS to_ts FROM rebuild_queue WHERE done_at IS NULL GROUP BY site_id').all();
  const out = [];
  for (const p of pending) {
    const site = db.prepare('SELECT * FROM site WHERE id = ?').get(p.site_id);
    if (!site) continue;
    const firstDay = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(p.site_id)?.d;
    const lastDay = db.prepare('SELECT MAX(local_date) AS d FROM site_day WHERE site_id = ?').get(p.site_id)?.d;
    let from = localDate(site.timezone, p.from_ts);
    const today = localDate(site.timezone, nowSec());
    let to = p.to_ts != null && p.to_ts > p.from_ts ? localDate(site.timezone, p.to_ts - 1) : today;
    if (to > today) to = today;
    // Never before the home's own first energy data (inverter or meter readings): a change
    // elsewhere (a price list starting months earlier, weather history) must not create empty half-hours.
    const firstFact = factSpan(p.site_id).first;
    if (firstFact != null && from < localDate(site.timezone, firstFact)) from = localDate(site.timezone, firstFact);
    // Rows of another slot length (the home's slot_s was changed): everything is rebuilt, so the
    // timeline never mixes lengths and the battery stock runs through one grid.
    if (firstDay && db.prepare('SELECT 1 FROM site_hh WHERE site_id = ? AND dur_s != ? LIMIT 1').get(p.site_id, slotLength(site))) {
      if (from > firstDay) from = firstDay;
      if (lastDay && to < lastDay) to = lastDay < today ? lastDay : today;
    }
    if (firstDay && from > firstDay) {
      const prev = db.prepare('SELECT battery_stock FROM site_day WHERE site_id = ? AND local_date = ?').get(p.site_id, addDays(from, -1));
      if (!prev?.battery_stock) from = firstDay;
    }
    const t0 = Date.now();
    const reasons = db.prepare('SELECT DISTINCT reason FROM rebuild_queue WHERE site_id = ? AND done_at IS NULL AND reason IS NOT NULL').all(p.site_id).map((r) => r.reason);
    const res = from <= to ? buildSite(p.site_id, from, to, { reason: reasons.join('; ') || null }) : { days: 0, slots: 0 };
    // Heating rows (site_heat_slot, src/core/heat.js) only for a home with a heating series: one query otherwise.
    const heat = from <= to && hasHeatingSeries(p.site_id) ? buildHeat(p.site_id, from, to) : null;
    // Processed requests are removed; the sync run records what was rebuilt.
    db.prepare('DELETE FROM rebuild_queue WHERE site_id = ? AND done_at IS NULL').run(p.site_id);
    out.push({ siteId: p.site_id, from, to, ms: Date.now() - t0, ...res, ...(heat ? { heat: { days: heat.days, slots: heat.slots } } : {}) });
  }
  // Fresh planner statistics after a rebuild (cheap when nothing is out of date).
  if (out.length) optimizeDb();
  return out;
}
