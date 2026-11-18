// A place's timeline (plan 3.3, docs/build/timelines.md): spaces, systems and the home get slots of their own, rolled up from the points of
// what is in them. A thing is in a place by `located_in` (a room holds its devices, the home holds its rooms) and in a system by `part_of`.
//
//   energy_kwh      what the tracked devices in the place used: the consumption of each (a plug, a charger, a heat pump), added up
//   temperature_c   the mean of the temperatures its members report
//   home_kwh        (home only) what the home used, from the build's own slots
//   untracked_kwh   (home only) home_kwh less the tracked devices: never negative beyond the meters' tolerance
//
// Each kWh is counted once: a device is in one place at a time (located_in is one place per thing), and a place's total is its devices
// and its sub-places' devices, not their totals added to its own. Only the members a relation marks `required` decide the place's data
// state (R8): when one of them has no data the slot is `partial`; a gap of an optional member lowers the coverage and is named in the
// lineage, so one dead sensor does not hold the home provisional.
import { db, tx } from '../db/db.js';
import { dayBounds, daysBetween, nowSec } from './time.js';
import { readIntervals } from './facts.js';
import { aggregatePeriodMeans } from './slot-agg.js';

export const NODE_SLOT_VERSION = 2;
export const METER_TOLERANCE_KWH = 0.005;
// the consumption point of each type of device: the amount it used in the slot
const CONSUMES = Object.freeze({ smart_plug: 'plug_kwh', ev_charger: 'ev_delivered_kwh', heat_pump: 'heatpump_elec_kwh', immersion: 'immersion_kwh' });
const TEMPERATURE = 'indoor_temp_c';

/** The things in a place: its subtree by located_in and part_of, each with whether it is required. PURE over the edges. */
export function membersOf(rootId, edges) {
  const children = new Map();
  for (const e of edges) (children.get(e.to) ?? children.set(e.to, []).get(e.to)).push(e);
  const out = []; const seen = new Set([rootId]);
  const walk = (id) => { for (const e of children.get(id) ?? []) { if (seen.has(e.from)) continue; seen.add(e.from); out.push({ id: e.from, required: e.required !== 0 }); walk(e.from); } };
  walk(rootId);
  return out;
}

/** One slot of a place from its members' values ({ id, required, value, coverage } each; value null when the member has no data). */
export function rollUp(members, how = 'sum') {
  const withData = members.filter((m) => m.value != null && m.coverage > 0);
  if (!members.length) return { value: null, coverage: 0, state: 'missing', lineage: { members: 0 } };
  const value = !withData.length ? null : how === 'mean' ? withData.reduce((t, m) => t + m.value, 0) / withData.length : withData.reduce((t, m) => t + m.value, 0);
  const requiredMissing = members.filter((m) => m.required && !(m.value != null && m.coverage > 0));
  const optionalMissing = members.filter((m) => !m.required && !(m.value != null && m.coverage > 0));
  const coverage = withData.length / members.length;
  const state = !withData.length ? 'missing' : requiredMissing.length ? 'partial' : 'final';
  return { value: value == null ? null : Math.round(value * 1e9) / 1e9, coverage: Math.round(coverage * 1e9) / 1e9, state,
    lineage: { members: members.length, with_data: withData.length, ...(requiredMissing.length ? { required_missing: requiredMissing.map((m) => m.id) } : {}), ...(optionalMissing.length ? { optional_missing: optionalMissing.map((m) => m.id) } : {}) } };
}

/** The home's untracked line: what the home used less what the tracked devices did; within the meters' tolerance of zero it is zero. */
export function untracked(homeKwh, trackedKwh, tolerance = METER_TOLERANCE_KWH) {
  if (homeKwh == null || trackedKwh == null) return null;
  const x = homeKwh - trackedKwh;
  return x < 0 ? (x >= -tolerance ? 0 : null) : Math.round(x * 1e9) / 1e9;   // a total below the tracked devices by more than the tolerance is a meter problem, not a negative use
}

// Every placement and membership of the home, ended ones too, with the time each held (null: unbounded): a slot is rolled up from the places things
// were in then, not from where they are now.
async function homeEdges(homeId) {
  return (await db.prepare(`SELECT from_id, to_id, required, valid_from, valid_to FROM thing_relation WHERE home_id = ? AND rel IN ('located_in', 'part_of') AND superseded_at IS NULL`).all(homeId))
    .map((r) => ({ from: Number(r.from_id), to: Number(r.to_id), required: Number(r.required), vf: r.valid_from == null ? null : Number(r.valid_from), vt: r.valid_to == null ? null : Number(r.valid_to) }));
}
/** The things in a place over a window, as segments: [{ from, members: Map(id -> required) }] that change where a placement starts or ends. PURE. */
export function membershipOver(rootId, edges, winFrom, winTo) {
  const cuts = [winFrom, ...[...new Set(edges.flatMap((e) => [e.vf, e.vt]).filter((x) => x != null && x > winFrom && x < winTo))].sort((a, b) => a - b)];
  return cuts.map((from) => ({ from, members: new Map(membersOf(rootId, edges.filter((e) => (e.vf ?? -Infinity) <= from && from < (e.vt ?? Infinity))).map((m) => [m.id, m.required])) }));
}

/**
 * What a place rolls up from its members' points (the lines of a place): the node metric, which point of a member it comes from, which
 * field of the point's slot, how the members combine, and which places have the line. A member's point is found by metric code, so a
 * heat pump and a boiler both give their heat to the heating system through the same line.
 */
export const LINES = Object.freeze([
  { metric: 'energy_kwh', of: (type) => CONSUMES[type] ?? null, field: 'delta', how: 'sum', places: ['home', 'space', 'system'] },
  { metric: 'temperature_c', of: () => TEMPERATURE, field: 'mean', how: 'mean', places: ['home', 'space', 'system'] },
  { metric: 'setpoint_c', of: () => 'indoor_temp_setpoint_c', field: 'mean', how: 'mean', places: ['home', 'space', 'system'] },
  { metric: 'valve_position_pct', of: () => 'valve_position_pct', field: 'mean', how: 'mean', places: ['home', 'space', 'system'] },
  { metric: 'heating_on_share', of: () => 'heating_on', field: 'on_share', how: 'mean', places: ['home', 'space', 'system'] },
  { metric: 'heat_output_kwh', of: () => 'heat_output_kwh', field: 'delta', how: 'sum', places: ['system'] },
  { metric: 'heating_energy_kwh', of: (type) => ({ heat_pump: 'heatpump_elec_kwh', boiler: 'boiler_gas_kwh' })[type] ?? null, field: 'delta', how: 'sum', places: ['system'] },
  { metric: 'heat_pump_energy_kwh', of: (type) => (type === 'heat_pump' ? 'heatpump_elec_kwh' : null), field: 'delta', how: 'sum', places: ['system'] },
  { metric: 'flow_temp_c', of: (type) => ({ heat_pump: 'heatpump_flow_temp_c', boiler: 'boiler_flow_temp_c' })[type] ?? null, field: 'mean', how: 'mean', places: ['system'] },
  { metric: 'return_temp_c', of: (type) => ({ heat_pump: 'heatpump_return_temp_c', boiler: 'boiler_return_temp_c' })[type] ?? null, field: 'mean', how: 'mean', places: ['system'] },
]);
export const BASE_TEMP_C = 15.5;   // the heating degree-day base (the UK's), as heat.js

/** The heating system's own ratios, from its lines of a slot: COP (heat out per electricity in, the heat pump's only, above 1 Wh) and degree-hours. PURE. */
export function heatingRatios({ heatOut, pumpIn, outdoorC, durS }) {
  const cop = heatOut != null && pumpIn != null && pumpIn > 0.001 ? Math.round((heatOut / pumpIn) * 1e9) / 1e9 : null;
  const degreeHours = outdoorC == null ? null : Math.round(Math.max(0, BASE_TEMP_C - outdoorC) * (durS / 3600) * 1e9) / 1e9;
  return { cop, degreeHours };
}

/**
 * Build the slots of one place (a space, a system or the home) for the local days fromDate..toDate, replacing its old rows of those
 * days. Reads the point slots of its members (build them first: buildHomePointSlots). Returns { slots }.
 */
export async function buildNodeSlots(thingId, fromDate, toDate, { builtAt = nowSec() } = {}) {
  const t = await db.prepare(`SELECT t.id, t.kind, t.type, t.home_id, s.timezone, s.carbon_region, s.country, s.market_code FROM thing t LEFT JOIN site s ON s.id = t.home_id WHERE t.id = ?`).get(thingId);
  if (!t || !['home', 'space', 'system'].includes(t.kind)) throw Object.assign(new RangeError('a place timeline is for a home, a space or a system'), { status: 400 });
  const homeId = Number(t.home_id);
  const tz = t.timezone ?? 'UTC';
  const [winFrom] = dayBounds(tz, fromDate); const winTo = dayBounds(tz, toDate)[1];
  const edges = await homeEdges(homeId);
  const segments = membershipOver(thingId, edges, winFrom, winTo);
  const members = [...new Set(segments.flatMap((s) => [...s.members.keys()]))].map((id) => ({ id }));   // everything that was in the place at some time in the window
  const segmentAt = (start) => { let k = 0; while (k + 1 < segments.length && segments[k + 1].from <= start) k++; return segments[k].members; };
  const things = new Map((await db.prepare(`SELECT id, type FROM thing WHERE home_id = ? AND superseded_at IS NULL AND merged_into IS NULL`).all(homeId)).map((x) => [Number(x.id), x.type]));
  const slotsOfPoint = async (memberId, metric) => {
    const p = await db.prepare('SELECT p.id FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND m.code = ? AND p.superseded_at IS NULL').get(memberId, metric);
    if (!p) return null;
    return new Map((await db.prepare('SELECT slot_start, dur_s, mean, delta, coverage, state_shares FROM point_slot WHERE point_id = ? AND slot_start >= ? AND slot_start < ?').all(p.id, winFrom, winTo))
      .map((r) => [Number(r.slot_start), { ...r, on_share: r.state_shares == null ? null : Number((typeof r.state_shares === 'string' ? JSON.parse(r.state_shares) : r.state_shares)['1'] ?? 0) }]));
  };
  // the lines of this place: one list of members (with their slots) each
  const lines = [];
  for (const line of LINES.filter((l) => l.places.includes(t.kind))) {
    const have = [];
    for (const m of members) {
      const metric = line.of(things.get(m.id));
      if (!metric) continue;
      const s = await slotsOfPoint(m.id, metric);
      if (s) have.push({ ...m, slots: s });
    }
    if (have.length) lines.push({ ...line, members: have });
  }
  const homeKwh = t.kind === 'home'
    ? new Map((await db.prepare('SELECT slot_start, dur_s, home FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND home IS NOT NULL').all(homeId, winFrom, winTo)).map((r) => [Number(r.slot_start), r]))
    : null;
  // what energy costs and emits in a slot: the home's import price (the supply price slot of its meter) and the grid's carbon intensity
  const price = new Map((await db.prepare("SELECT slot_start, unit_inc FROM supply_price_slot WHERE site_id = ? AND point = 'meter_import' AND slot_start >= ? AND slot_start < ? ORDER BY slot_start, id").all(homeId, winFrom, winTo)).map((r) => [Number(r.slot_start), Number(r.unit_inc)]));
  const carbonSubject = t.carbon_region != null ? `carbon:${t.carbon_region}` : (t.country ?? t.market_code) === 'FR' ? 'carbon:FR' : null;
  // the region's carbon facts are read on the home's own grid (a region is shared by homes of different slot lengths)
  let carbonPeriods = [];
  if (carbonSubject) {
    const series = (await db.prepare("SELECT s.id FROM series s JOIN point p ON p.id = s.point_id JOIN thing r ON r.id = p.thing_id JOIN metric m ON m.id = s.metric_id WHERE r.kind = 'context' AND r.name = ? AND m.code = 'carbon_intensity'").all(carbonSubject)).map((r) => Number(r.id));
    carbonPeriods = (await readIntervals(series, winFrom - 3600, winTo + 3600)).map((r) => ({ start: Number(r.start_ts), end: Number(r.end_ts), value: r.value }));
  }
  const carbon = { has: (start) => carbonOf(start) != null, get: (start) => carbonOf(start) };
  const carbonCache = new Map();
  function carbonOf(start) {
    if (!carbonCache.has(start)) carbonCache.set(start, carbonPeriods.length ? aggregatePeriodMeans(carbonPeriods, start, start + curDur).mean : null);
    return carbonCache.get(start);
  }
  let curDur = 1800;
  const outdoor = t.kind === 'system' && t.type === 'heating' ? await slotsOfPoint(homeId, 'outdoor_temp_c') : null;
  const starts = new Set();
  for (const l of lines) for (const m of l.members) for (const k of m.slots.keys()) starts.add(k);
  if (homeKwh) for (const k of homeKwh.keys()) starts.add(k);
  const out = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const dur = lines.flatMap((l) => l.members).map((m) => m.slots.get(start)?.dur_s).find(Boolean) ?? homeKwh?.get(start)?.dur_s ?? 1800;
    const row = (metric, r) => out.push({ start, dur, metric, ...r });
    curDur = dur;
    const got = {};
    for (const l of lines) {
      const here = segmentAt(start);
      const inside = l.members.filter((m) => here.has(m.id));
      if (!inside.length) continue;
      const r = rollUp(inside.map((m) => ({ id: m.id, required: here.get(m.id), value: m.slots.get(start)?.[l.field] ?? null, coverage: m.slots.get(start)?.coverage ?? 0 })), l.how);
      if (r.value == null) continue;
      got[l.metric] = r;
      row(l.metric, r);
    }
    const e = got.energy_kwh;
    if (homeKwh?.has(start)) {
      row('home_kwh', { value: homeKwh.get(start).home, coverage: 1, state: 'final', lineage: { from: 'site_hh' } });
      const hk = homeKwh.get(start).home;
      if (price.has(start)) row('home_cost_minor', { value: Math.round(hk * price.get(start) * 1e6) / 1e6, coverage: 1, state: 'final', lineage: { kwh: hk, unit_inc: price.get(start) } });
      if (carbon.has(start)) row('home_carbon_g', { value: Math.round(hk * carbon.get(start) * 1e6) / 1e6, coverage: 1, state: 'final', lineage: { kwh: hk, intensity: carbon.get(start) } });
      const u = untracked(homeKwh.get(start).home, e?.value ?? 0);
      if (u != null && (e || homeKwh.has(start))) {
        const r = { value: u, coverage: e?.coverage ?? 0, state: !e || e.state === 'missing' ? 'partial' : e.state, lineage: { home_kwh: homeKwh.get(start).home, tracked_kwh: e?.value ?? 0, ...(e?.lineage ?? {}) } };
        if (e) { row('untracked_kwh', r); got.untracked_kwh = r; }
      }
    }
    // cost and carbon on each energy line (5.3): the slot's energy at the slot's import price and the grid's intensity
    for (const [metric, r] of Object.entries(got)) {
      const base = { energy_kwh: 'energy', untracked_kwh: 'untracked', heat_pump_energy_kwh: 'heat_pump' }[metric];
      if (!base) continue;
      const kwh = r.value;
      if (kwh == null) continue;
      if (price.has(start)) row(`${base}_cost_minor`, { value: Math.round(kwh * price.get(start) * 1e6) / 1e6, coverage: r.coverage, state: r.state, lineage: { kwh, unit_inc: price.get(start) } });
      if (carbon.has(start)) row(`${base}_carbon_g`, { value: Math.round(kwh * carbon.get(start) * 1e6) / 1e6, coverage: r.coverage, state: r.state, lineage: { kwh, intensity: carbon.get(start) } });
    }
    if (t.kind === 'system' && t.type === 'heating') {
      const { cop, degreeHours } = heatingRatios({ heatOut: got.heat_output_kwh?.value ?? null, pumpIn: got.heat_pump_energy_kwh?.value ?? null, outdoorC: outdoor?.get(start)?.mean ?? null, durS: dur });
      if (cop != null) row('cop', { value: cop, coverage: Math.min(got.heat_output_kwh.coverage, got.heat_pump_energy_kwh.coverage), state: got.heat_output_kwh.state === 'final' && got.heat_pump_energy_kwh.state === 'final' ? 'final' : 'partial', lineage: { heat_output_kwh: got.heat_output_kwh.value, heat_pump_energy_kwh: got.heat_pump_energy_kwh.value } });
      if (degreeHours != null) row('degree_hours', { value: degreeHours, coverage: outdoor.get(start).coverage, state: 'final', lineage: { outdoor_c: outdoor.get(start).mean, base_c: BASE_TEMP_C } });
    }
  }
  await tx(async () => {
    await db.prepare('DELETE FROM node_slot WHERE thing_id = ? AND slot_start >= ? AND slot_start < ?').run(thingId, winFrom, winTo);
    for (const r of out) {
      await db.prepare(`INSERT INTO node_slot (thing_id, slot_start, dur_s, metric, value, coverage, state, lineage, method_version, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`)
        .run(thingId, r.start, r.dur, r.metric, r.value, r.coverage, r.state, JSON.stringify(r.lineage), NODE_SLOT_VERSION, builtAt);
    }
  });
  return { slots: out.length, days: daysBetween(fromDate, toDate).length };
}

/** Every place of a home (the home, its spaces and its systems). Returns { nodes, slots }. */
export async function buildHomeNodeSlots(siteId, fromDate, toDate, opts = {}) {
  const nodes = await db.prepare(`SELECT id FROM thing WHERE home_id = ? AND kind IN ('home', 'space', 'system') AND superseded_at IS NULL AND merged_into IS NULL ORDER BY id`).all(siteId);
  let slots = 0;
  for (const { id } of nodes) slots += (await buildNodeSlots(Number(id), fromDate, toDate, opts)).slots;
  return { nodes: nodes.length, slots };
}

/** The slots of a place in [from, to), one list per metric. */
export async function readNodeSlots(thingId, from, to, metrics = null) {
  return (await db.prepare(`SELECT slot_start, dur_s, metric, value, coverage, state, lineage FROM node_slot WHERE thing_id = ? AND slot_start >= ? AND slot_start < ?
    AND (?::text[] IS NULL OR metric = ANY(?::text[])) ORDER BY slot_start, metric`).all(thingId, from, to, metrics && `{${metrics.join(',')}}`, metrics && `{${metrics.join(',')}}`))
    .map((r) => ({ ...r, lineage: typeof r.lineage === 'string' ? JSON.parse(r.lineage) : r.lineage }));
}
