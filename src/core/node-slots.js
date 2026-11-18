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

export const NODE_SLOT_VERSION = 1;
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

async function homeEdges(homeId) {
  return (await db.prepare(`SELECT from_id, to_id, required FROM thing_relation WHERE home_id = ? AND rel IN ('located_in', 'part_of') AND superseded_at IS NULL AND valid_to IS NULL`).all(homeId))
    .map((r) => ({ from: Number(r.from_id), to: Number(r.to_id), required: Number(r.required) }));
}

/**
 * Build the slots of one place (a space, a system or the home) for the local days fromDate..toDate, replacing its old rows of those
 * days. Reads the point slots of its members (build them first: buildHomePointSlots). Returns { slots }.
 */
export async function buildNodeSlots(thingId, fromDate, toDate, { builtAt = nowSec() } = {}) {
  const t = await db.prepare(`SELECT t.id, t.kind, t.type, t.home_id, s.timezone FROM thing t LEFT JOIN site s ON s.id = t.home_id WHERE t.id = ?`).get(thingId);
  if (!t || !['home', 'space', 'system'].includes(t.kind)) throw Object.assign(new RangeError('a place timeline is for a home, a space or a system'), { status: 400 });
  const homeId = Number(t.home_id);
  const tz = t.timezone ?? 'UTC';
  const [winFrom] = dayBounds(tz, fromDate); const winTo = dayBounds(tz, toDate)[1];
  const edges = await homeEdges(homeId);
  const members = membersOf(thingId, edges);
  const things = new Map((await db.prepare(`SELECT id, type FROM thing WHERE home_id = ? AND superseded_at IS NULL AND merged_into IS NULL`).all(homeId)).map((x) => [Number(x.id), x.type]));
  const slotsOfPoint = async (memberId, metric) => {
    const p = await db.prepare('SELECT p.id FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND m.code = ? AND p.superseded_at IS NULL').get(memberId, metric);
    if (!p) return null;
    return new Map((await db.prepare('SELECT slot_start, dur_s, mean, delta, coverage FROM point_slot WHERE point_id = ? AND slot_start >= ? AND slot_start < ?').all(p.id, winFrom, winTo)).map((r) => [Number(r.slot_start), r]));
  };
  const energy = []; const temps = [];
  for (const m of members) {
    const type = things.get(m.id);
    if (CONSUMES[type]) { const s = await slotsOfPoint(m.id, CONSUMES[type]); if (s) energy.push({ ...m, slots: s }); }
    const ts = await slotsOfPoint(m.id, TEMPERATURE);
    if (ts) temps.push({ ...m, slots: ts });
  }
  const homeKwh = t.kind === 'home'
    ? new Map((await db.prepare('SELECT slot_start, dur_s, home FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND home IS NOT NULL').all(homeId, winFrom, winTo)).map((r) => [Number(r.slot_start), r]))
    : null;
  const starts = new Set();
  for (const g of [...energy, ...temps]) for (const k of g.slots.keys()) starts.add(k);
  if (homeKwh) for (const k of homeKwh.keys()) starts.add(k);
  const out = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const dur = [...energy, ...temps].map((g) => g.slots.get(start)?.dur_s).find(Boolean) ?? homeKwh?.get(start)?.dur_s ?? 1800;
    const row = (metric, r) => out.push({ start, dur, metric, ...r });
    if (energy.length) {
      const r = rollUp(energy.map((g) => ({ id: g.id, required: g.required, value: g.slots.get(start)?.delta ?? null, coverage: g.slots.get(start)?.coverage ?? 0 })));
      if (r.value != null) row('energy_kwh', r);
      if (homeKwh?.has(start)) {
        const u = untracked(homeKwh.get(start).home, r.value ?? 0);
        row('home_kwh', { value: homeKwh.get(start).home, coverage: 1, state: 'final', lineage: { from: 'site_hh' } });
        if (u != null) row('untracked_kwh', { value: u, coverage: r.coverage, state: r.state === 'missing' ? 'partial' : r.state, lineage: { home_kwh: homeKwh.get(start).home, tracked_kwh: r.value ?? 0, ...r.lineage } });
      }
    } else if (homeKwh?.has(start)) row('home_kwh', { value: homeKwh.get(start).home, coverage: 1, state: 'final', lineage: { from: 'site_hh' } });
    if (temps.length) {
      const r = rollUp(temps.map((g) => ({ id: g.id, required: g.required, value: g.slots.get(start)?.mean ?? null, coverage: g.slots.get(start)?.coverage ?? 0 })), 'mean');
      if (r.value != null) row('temperature_c', r);
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
