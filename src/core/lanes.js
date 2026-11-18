// The four lanes of a timeline (plan 3.8, R7, docs/build/timelines.md), all on the home's one grid so a reader (the planner, a page) takes
// one timeline instead of building its own:
//
//   actual    what happened: the point slots (point-slots.js), built from the facts
//   forecast  what is expected: the forecast of record for each slot, the latest issue the core had recorded (solar per PV array, the
//             home's load), added up on the grid the way actual totals are
//   plan      what was decided: the desired states of the plan in force for the device (plan_slot)
//   price     what energy costs: the price slots of a supply point (supply_price_slot), past and future
//
// A lane says nothing for a thing it does not apply to (a room has no price) and is empty, not null, where it applies and holds nothing.
import { db } from '../db/db.js';
import { readForecastAsOf } from './facts.js';
import { readPointSlots } from './point-slots.js';
import { aggregatePeriods, aggregatePeriodMeans } from './slot-agg.js';
import { dayBounds, slotsOfDay, slotLength, localDate, daysBetween } from './time.js';

export const LANE_NAMES = Object.freeze(['actual', 'forecast', 'plan', 'price']);

async function gridOf(homeId, from, to) {
  const home = homeId == null ? null : await db.prepare('SELECT timezone, slot_s FROM site WHERE id = ?').get(homeId);
  const tz = home?.timezone ?? 'UTC'; const slotS = home ? slotLength(home) : 1800;
  const starts = [];
  for (const date of daysBetween(localDate(tz, from), localDate(tz, to - 1))) for (const s of slotsOfDay(tz, date, slotS)) if (s >= from && s < to) starts.push(s);
  return { tz, slotS, starts };
}

/** The lanes of a thing in [from, to): { actual, forecast, plan, price } for the lanes asked (default all). */
export async function lanesOf(thing, from, to, lanes = LANE_NAMES, { asOfMs = Date.now() } = {}) {
  const grid = await gridOf(thing.home_id == null ? null : Number(thing.home_id), from, to);
  const out = {};
  const points = await db.prepare(`SELECT p.id, p.key, p.class, m.code AS metric, m.unit FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND p.superseded_at IS NULL ORDER BY p.key`).all(thing.id);
  if (lanes.includes('actual')) {
    out.actual = [];
    for (const p of points) {
      const slots = await readPointSlots(p.id, from, to);
      if (slots.length) out.actual.push({ key: p.key, metric: p.metric, unit: p.unit, class: p.class, slots });
    }
  }
  if (lanes.includes('forecast')) {
    out.forecast = [];
    for (const p of points) {
      const series = await db.prepare(`SELECT s.id, so.code AS source FROM series s JOIN source so ON so.id = s.source_id WHERE s.point_id = ? AND so.traits::jsonb ->> 'forecastOnly' = 'true' ORDER BY so.code`).all(p.id);
      for (const s of series) {
        const rows = (await readForecastAsOf([Number(s.id)], from - 3600, to, asOfMs)).map((r) => ({ start: Number(r.start_ts), end: Number(r.end_ts), value: r.value, issued: Number(r.issued_at) }));
        if (!rows.length) continue;
        const slots = [];
        for (const start of grid.starts) {
          const agg = p.class === 'total' ? aggregatePeriods(rows, start, start + grid.slotS) : aggregatePeriodMeans(rows, start, start + grid.slotS);
          const v = p.class === 'total' ? agg.delta : agg.mean;
          if (v != null) slots.push({ slot_start: start, dur_s: grid.slotS, value: v, coverage: agg.coverage, issued_at: Math.max(...rows.filter((r) => r.end > start && r.start < start + grid.slotS).map((r) => r.issued)) });
        }
        if (slots.length) out.forecast.push({ key: p.key, metric: p.metric, unit: p.unit, source: s.source, slots });
      }
    }
  }
  const device = await db.prepare('SELECT id, kind FROM device WHERE id = ?').get(thing.id);
  if (lanes.includes('plan')) {
    out.plan = !device ? [] : (await db.prepare(`SELECT DISTINCT ON (slot_start) slot_start, action, power_w, setpoint_c, target_soc_kwh, soc_end_kwh, scenario, variant
      FROM v_plan_in_force WHERE device_id = ? AND slot_start >= ? AND slot_start < ? AND run_status <> 'error' ORDER BY slot_start, run_created_at DESC`).all(thing.id, from, to))
      .map((r) => ({ ...r, slot_start: Number(r.slot_start), dur_s: grid.slotS }));
  }
  if (lanes.includes('price')) {
    out.price = !device ? [] : (await db.prepare(`SELECT slot_start, dur_s, register, unit_inc, fixed_inc, weighted, estimated FROM supply_price_slot WHERE device_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start`).all(thing.id, from, to))
      .map((r) => ({ ...r, slot_start: Number(r.slot_start), weighted: Boolean(r.weighted), estimated: Boolean(r.estimated) }));
  }
  return { grid: { tz: grid.tz, slot_s: grid.slotS }, ...out };
}
