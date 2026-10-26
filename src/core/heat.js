// Heating serving table (plan item B9): site_heat_slot, one row per slot of the home's own length,
// on the same key and slot grid as site_hh (time.js: anchored to local midnight, 46/48/50 half-hours
// on a clock-change day). Built only for a home that has a heating series (a series of a metric in
// domain 'heating', on the home or one of its devices); site_hh and site_day are never touched, so
// the battery timeline and its golden hash cannot move. Disposable like site_hh: rebuilt from facts.
//
// Per slot, from the heating series only (plus the outdoor temperature and the home's prices):
//   indoor_temp_c, setpoint_c   time-weighted mean; each reading holds until the next one, at most
//                               holdMaxS (3 h); several sensors: their mean
//   outdoor_temp_c              a sensor at the home (outdoor_temp_c from any source but open_meteo)
//                               where it has a reading, else Open-Meteo's hourly value (lineage says which)
//   heating_demand_kwh,         sums by overlap (a 30-minute fact feeds two 15-minute slots by half);
//   heat_output_kwh             known only when the facts cover the whole slot (the meter rule of
//                               build.js); several devices add up
//   heating_energy_kwh          heat pump electricity (heatpump_elec_kwh) + boiler gas (boiler_gas_kwh),
//                               for the fuels the home has; heating_fuel says which
//   cop                         heat delivered ÷ heat pump electricity in the slot (electricity only,
//                               above 0.001 kWh); else a COP the device reported (heatpump_cop); else null
//   degree_hours                max(0, baseTempC − outdoor) × slot hours; base 15.5 °C by default
//                               (the UK heating degree-day base), stated in lineage
//   heating_on_fraction         share of the slot heating_on was 1 (several zones: the largest share)
//   flow_temp_c, return_temp_c  heat source water temperatures (heatpump_* or boiler_* metrics), and
//   radiator_temp_c             radiator water: time-weighted means, context only (a home without such a
//                               sensor is not incomplete)
//   cost_minor                  electricity × the import unit price including tax + gas × the gas
//                               unit price including tax (pricing.js priceOver, the home's tariff
//                               agreements and tax rules), minor units of site.currency. As if all
//                               the electricity came from the grid: solar and battery supply are
//                               allocated for the whole home in site_hh, not here. No standing charge.
// State: 'missing' when no heating series has data in the slot; 'provisional' on today or when a
// series the home has does not cover the slot (QUALITY.PARTIAL; lineage.incomplete names them); else 'final'. QUALITY.CHECK_FAILED
// when energy is known and a tariff agreement exists but has no unit price for the slot;
// QUALITY.ESTIMATED when a price was a cautious estimate. Lineage: the series and sources used, the
// outdoor source, the tariffs, the weakest price origin, data_origin, the base temperature.
//
// buildHeat(siteId, fromDate, toDate, { asOf, dryRun }) as buildSite: asOf (s) reads every fact and
// price as known then; dryRun writes nothing and returns the rows. The window never starts before the
// home's first heating fact, so a rebuild from older days creates no run of empty slots.
// Which PredHeat inputs this serves (docs/predbat-predheat-requirements.md, sourced 26 Oct 2026): its
// outside, inside and set-point temperatures (PH-SEN-01..03), heating energy (PH-SEN-04), heating on
// (PH-SEN-05), radiator water temperature (PH-SEN-07), the gas or import price (PH-RATE-01) and the cost
// so far today (PH-OUT-10, by summing). degree_hours, cop, heat_output_kwh and flow/return are ours:
// PredHeat reads none of them (it has no degree days and no flow/return sensors). No heating model or
// planner is built; the model parameters (PH-MOD-*) are configuration, not facts.
import { db, tx } from '../db/db.js';
import { readReadings, readIntervals, QUALITY, withKnownAt, inForce } from './facts.js';
import { loadPricing, priceOver } from './pricing.js';
import { inputsProvenance, dataOriginOf } from './provenance.js';
import { nowSec, localDate, dayBounds, slotsOfDay, daysBetween, slotLength, slotFloor, todMinute, eachSlotOverlap } from './time.js';

export const HEAT_METHOD_VERSION = 'heat-v1';
export const HEAT_DEFAULTS = Object.freeze({ baseTempC: 15.5, holdMaxS: 3 * 3600 });
// The heating metrics the table is built from, and how each is combined across sensors or devices.
const USED = Object.freeze({
  indoor_temp_c: 'mean', indoor_temp_setpoint_c: 'mean', heating_on: 'max',
  heating_demand_kwh: 'sum', heat_output_kwh: 'sum', heatpump_elec_kwh: 'sum', boiler_gas_kwh: 'sum', heatpump_cop: 'mean',
  heatpump_flow_temp_c: 'mean', boiler_flow_temp_c: 'mean', heatpump_return_temp_c: 'mean', boiler_return_temp_c: 'mean', radiator_temp_c: 'mean',
});
// Context only: shown when present, never what makes a slot provisional (a home without a flow sensor
// is not incomplete). The others are the home's heating record: each one the home has must cover the slot.
const CONTEXT = new Set(['heatpump_cop', 'heatpump_flow_temp_c', 'boiler_flow_temp_c', 'heatpump_return_temp_c', 'boiler_return_temp_c', 'radiator_temp_c']);
const INSTANT_COVER = 0.8;   // an instant series covers a slot when its readings hold over 80 % of it (build.js PARTIAL rule)

const subjectSql = `((se.subject_kind = 'site' AND se.subject_id = ?)
  OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?)))`;

/** Whether the home has any heating series (one indexed query; the build's only cost for other homes). */
export function hasHeatingSeries(siteId) {
  return !!db.prepare(`SELECT 1 FROM series se JOIN metric m ON m.id = se.metric_id WHERE m.domain = 'heating' AND ${subjectSql} LIMIT 1`)
    .get(String(siteId), siteId);
}

export function buildHeat(siteId, fromDate, toDate, opts = {}) {
  return opts.asOf != null ? withKnownAt(opts.asOf * 1000, () => build(siteId, fromDate, toDate, opts)) : build(siteId, fromDate, toDate, opts);
}

const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());

// Instants over slots: each reading holds until the next one, at most holdMaxS. Per slot: sum of
// value × seconds and the seconds held (so mean = sum / held, cover = held / slotS).
function holdBySlot(readings, slotS, fl, holdMaxS, winStart, winEnd) {
  const acc = new Map();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (r.value == null) continue;
    const end = Math.min(readings[i + 1]?.ts ?? Infinity, r.ts + holdMaxS, winEnd);
    for (let t = Math.max(r.ts, winStart); t < end;) {
      const s = fl(t); const e = Math.min(end, s + slotS);
      const a = acc.get(s) || acc.set(s, { v: 0, w: 0 }).get(s);
      a.v += r.value * (e - t); a.w += e - t; t = e;
    }
  }
  return acc;
}

// Intervals over slots: sum by overlap share (energies) or time-weighted mean, with the seconds covered.
function intervalBySlot(facts, slotS, phase) {
  const acc = new Map();
  for (const f of facts) {
    if (f.value == null) continue;
    eachSlotOverlap(f, slotS, phase, (s, share, o) => {
      const a = acc.get(s) || acc.set(s, { sum: 0, v: 0, w: 0 }).get(s);
      a.sum += f.value * share; a.v += f.value * o; a.w += o;
    });
  }
  return acc;
}

function build(siteId, fromDate, toDate, opts) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const o = { ...HEAT_DEFAULTS, ...opts };
  const tz = site.timezone;
  const slotS = slotLength(site);
  const asOf = opts.asOf ?? null;
  const now = asOf ?? nowSec();
  const today = localDate(tz, now);
  if (toDate > today) toDate = today;

  // The home's heating series (and the metrics' time roles), one chosen per metric and subject below.
  const series = db.prepare(`SELECT se.id, se.subject_kind, se.subject_id, m.code AS metric, m.time_role, so.code AS source
      FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
      WHERE m.domain = 'heating' AND ${subjectSql} ORDER BY se.id`).all(String(siteId), siteId)
    .filter((s) => USED[s.metric]);
  const empty = { days: 0, slots: 0, ...(opts.dryRun ? { rows: [] } : {}) };
  if (!series.length) return { ...empty, skipped: 'no heating series' };
  // Never before the home's first heating fact (as known at asOf).
  const ids = series.map((s) => s.id);
  const list = ids.map(() => '?').join(',');
  const firstFact = Math.min(
    db.prepare(`SELECT MIN(ts) AS t FROM reading WHERE series_id IN (${list}) AND ${inForce()}`).get(...ids)?.t ?? Infinity,
    db.prepare(`SELECT MIN(start_ts) AS t FROM interval_fact WHERE series_id IN (${list}) AND ${inForce()}`).get(...ids)?.t ?? Infinity);
  if (!Number.isFinite(firstFact)) return { ...empty, skipped: 'no heating facts' };
  if (localDate(tz, firstFact) > fromDate) fromDate = localDate(tz, firstFact);
  if (fromDate > toDate) return empty;
  const [winStart] = dayBounds(tz, fromDate);
  const [, winEnd] = dayBounds(tz, toDate);
  const phase = ((winStart % slotS) + slotS) % slotS;
  const fl = (t) => slotFloor(t, slotS, phase);

  // ── Facts per series, as slot accumulations ──
  const instIds = series.filter((s) => s.time_role === 'instant').map((s) => s.id);
  const intIds = series.filter((s) => s.time_role === 'interval').map((s) => s.id);
  const readings = groupBy(readReadings(instIds, winStart - o.holdMaxS, winEnd), 'series_id');
  const intervals = groupBy(readIntervals(intIds, winStart, winEnd), 'series_id');
  const acc = new Map();
  for (const s of series) {
    acc.set(s.id, s.time_role === 'instant'
      ? holdBySlot(readings.get(s.id) || [], slotS, fl, o.holdMaxS, winStart, winEnd)
      : intervalBySlot(intervals.get(s.id) || [], slotS, phase));
  }
  // One series per metric and subject: the first stored that has data in the window.
  const chosen = {};
  for (const s of series) {
    if (!acc.get(s.id).size) continue;
    const key = `${s.subject_kind}:${s.subject_id}`;
    const m = (chosen[s.metric] ||= new Map());
    if (!m.has(key)) m.set(key, s);
  }
  const has = (metric) => !!chosen[metric]?.size;
  const sourcesOf = (metric) => [...new Set([...(chosen[metric]?.values() ?? [])].map((s) => s.source))];

  // Outdoor temperature: a sensor at the home first, Open-Meteo where it has none.
  const outdoor = db.prepare(`SELECT se.id, so.code AS source FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
      WHERE m.code = 'outdoor_temp_c' AND ${subjectSql} ORDER BY so.code = 'open_meteo', se.id`).all(String(siteId), siteId);
  const outReadings = groupBy(readReadings(outdoor.map((s) => s.id), winStart - o.holdMaxS, winEnd), 'series_id');
  const outAcc = outdoor.map((s) => ({ ...s, acc: holdBySlot(outReadings.get(s.id) || [], slotS, fl, s.source === 'open_meteo' ? 3600 : o.holdMaxS, winStart, winEnd) }));

  const pricing = loadPricing(siteId, winStart, winEnd);
  const agreed = (kind) => pricing.agreements.some((a) => a.kind === kind);
  const fuel = has('heatpump_elec_kwh') && has('boiler_gas_kwh') ? 'electricity+gas' : has('heatpump_elec_kwh') ? 'electricity' : has('boiler_gas_kwh') ? 'gas' : null;
  const dataOrigin = dataOriginOf(site);
  const used = Object.fromEntries(Object.keys(USED).filter(has).map((m) => [m, sourcesOf(m)]));

  // A metric over one slot, combined across its subjects: { value, complete, present }.
  const slotValue = (metric, slot) => {
    const subs = [...(chosen[metric]?.values() ?? [])];
    if (!subs.length) return null;
    const kind = USED[metric];
    const vals = []; let complete = true; let present = false;
    for (const s of subs) {
      const a = acc.get(s.id).get(slot);
      if (!a || !a.w) { complete = false; continue; }
      present = true;
      if (s.time_role === 'instant') {
        if (a.w < INSTANT_COVER * slotS) complete = false;
        vals.push(a.v / a.w);
      } else if (kind === 'sum') {
        if (a.w < slotS) { complete = false; continue; }
        vals.push(a.sum);
      } else {
        if (a.w < slotS) complete = false;
        vals.push(a.v / a.w);
      }
    }
    let value = null;
    if (kind === 'sum') value = complete ? vals.reduce((x, y) => x + y, 0) : null;
    else if (vals.length) value = kind === 'max' ? Math.max(...vals) : vals.reduce((x, y) => x + y, 0) / vals.length;
    return { value, complete, present };
  };

  const rows = [];
  for (const date of daysBetween(fromDate, toDate)) {
    const slots = slotsOfDay(tz, date, slotS).filter((s) => s + slotS <= now);
    for (const slot of slots) {
      let q = 0;
      const v = Object.fromEntries(Object.keys(USED).map((m) => [m, slotValue(m, slot)]));
      const inputs = Object.keys(USED).filter((m) => !CONTEXT.has(m) && v[m]);
      const present = Object.keys(USED).some((m) => v[m]?.present);
      const complete = inputs.every((m) => v[m].complete);
      const val = (m) => v[m]?.value ?? null;
      const either = (a, b) => (val(a) != null && val(b) != null ? (val(a) + val(b)) / 2 : val(a) ?? val(b));

      let outdoorC = null; let outdoorSrc = null;
      for (const s of outAcc) {
        const a = s.acc.get(slot);
        if (a?.w) { outdoorC = a.v / a.w; outdoorSrc = s.source; break; }
      }
      const elec = val('heatpump_elec_kwh'); const gas = val('boiler_gas_kwh'); const heat = val('heat_output_kwh');
      const energy = fuel == null || (has('heatpump_elec_kwh') && elec == null) || (has('boiler_gas_kwh') && gas == null) ? null : (elec ?? 0) + (gas ?? 0);
      let cop = null; let copFrom = null;
      if (fuel !== 'gas' && elec != null && elec > 0.001 && heat != null) { cop = heat / elec; copFrom = 'heat_output_kwh / heatpump_elec_kwh'; }
      else if (val('heatpump_cop') != null) { cop = val('heatpump_cop'); copFrom = `reported (${sourcesOf('heatpump_cop').join(', ')})`; }

      // ── Price: the home's tariff agreements, taxes included ──
      const pi = elec != null ? priceOver(pricing, 'meter_import', slot, slotS) : null;
      const pg = gas != null ? priceOver(pricing, 'meter_gas', slot, slotS) : null;
      const elecCost = elec != null && pi?.unitEx != null ? elec * pi.unitEx * (1 + pi.vat) : null;
      const gasCost = gas != null && pg?.unitEx != null ? gas * pg.unitEx * (1 + pg.vat) : null;
      if ((elec != null && elecCost == null && agreed('meter_import')) || (gas != null && gasCost == null && agreed('meter_gas'))) q |= QUALITY.CHECK_FAILED;
      const cost = energy == null || (elec != null && elecCost == null) || (gas != null && gasCost == null) ? null : (elecCost ?? 0) + (gasCost ?? 0);
      const estimated = !!(pi?.estimated || pg?.estimated);
      if (estimated) q |= QUALITY.ESTIMATED;
      const prov = inputsProvenance([pi, pg].flatMap((x) => x?.inputs ?? []));

      if (present) q |= QUALITY.MEASURED;
      if (present && !complete) q |= QUALITY.PARTIAL;
      const state = !present ? 'missing' : date >= today || !complete ? 'provisional' : 'final';
      const incomplete = inputs.filter((m) => !v[m].complete);
      rows.push({
        site_id: siteId, slot_start: slot, dur_s: slotS, local_date: date, tod_min: todMinute(tz, slot), state, quality: q,
        indoor_temp_c: val('indoor_temp_c'), setpoint_c: val('indoor_temp_setpoint_c'), outdoor_temp_c: outdoorC,
        flow_temp_c: either('heatpump_flow_temp_c', 'boiler_flow_temp_c'), return_temp_c: either('heatpump_return_temp_c', 'boiler_return_temp_c'),
        radiator_temp_c: val('radiator_temp_c'),
        heating_demand_kwh: val('heating_demand_kwh'), heat_output_kwh: heat, heating_energy_kwh: energy, heating_fuel: fuel,
        cop, degree_hours: outdoorC == null ? null : (Math.max(0, o.baseTempC - outdoorC) * slotS) / 3600,
        heating_on_fraction: val('heating_on'), cost_minor: cost, currency: site.currency ?? null,
        lineage: JSON.stringify({
          series: used, outdoor: outdoorSrc, derived: 'core_heat_model', base_temp_c: o.baseTempC,
          ...(copFrom && cop != null ? { cop: copFrom } : {}),
          ...(pi ? { import: { tariff: pi.tariffCode ?? null, register: pi.register ?? null, tax: pi.tax?.source ?? null } } : {}),
          ...(pg ? { gas: { tariff: pg.tariffCode ?? null, register: pg.register ?? null, tax: pg.tax?.source ?? null } } : {}),
          ...(energy != null && cost == null ? { price: agreed(elec != null ? 'meter_import' : 'meter_gas') ? 'no unit price for this slot' : 'no tariff agreement' } : {}),
          ...(present && incomplete.length ? { incomplete } : {}),
          ...(prov ? { origin: prov.origin, placeholder_inputs: prov.placeholder_inputs } : {}), data_origin: dataOrigin,
          ...(estimated ? { estimated: true } : {}),
        }),
        method_version: HEAT_METHOD_VERSION, built_at: now,
      });
    }
  }
  const days = new Set(rows.map((r) => r.local_date)).size;
  if (opts.dryRun) return { days, slots: rows.length, rows };
  tx(() => {
    db.prepare('DELETE FROM site_heat_slot WHERE site_id = ? AND slot_start >= ? AND slot_start < ?').run(siteId, winStart, winEnd);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      const ins = db.prepare(`INSERT INTO site_heat_slot (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) ins.run(...cols.map((c) => (typeof r[c] === 'number' && !Number.isFinite(r[c]) ? null : r[c] ?? null)));
    }
  });
  return { days, slots: rows.length };
}
