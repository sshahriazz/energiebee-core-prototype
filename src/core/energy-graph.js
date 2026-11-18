// The energy graph of a home, made from evidence (plan 1.4 and 1.5; docs/build/graph.md).
//
// A home has devices that bring facts (meters, a car) and a plant that only shows in numbers and in a provider's connection:
// an inverter, PV panels, a battery. This module makes the missing physical things, wires them with port-directed `feeds`,
// `meters` and `part_of`, and places things in spaces (an outside wall for the meters, a driveway for the car). It is
// idempotent and never guesses: no evidence, no thing; a relation that cannot be known is not written.
//
//   graphFacts(homeId)           reads only: things (retired ones too), every current relation row (ended ones too), evidence
//   planGraph(facts, declare)    PURE: what to create and relate, from a table of rules; an empty plan means nothing to do
//   applyPlan(homeId, plan, f)   writes through the thing library only, so the database rules judge every edge
//   ensureEnergyGraph(homeId)    facts, plan, and (only if the plan is not empty) lock, re-read, re-plan, apply
//   ensureAllHomes()             every home; one home's failure does not stop the others
//
// Existence is by type among ALL things of the home including retired ones, and a relation is skipped when a current row with
// the same ends and ports exists, ended or not: a retired battery is not made again, and an owner who ended a relation is not
// overruled. A thing that has ever been placed (a located_in row of any state) is not placed again.
//
// Sizes (pv_kwp, battery_kwh and the angles) stay where they are, at home level: nothing reads a size per array yet, so moving
// them now would change about 25 readers twice (they change once, with Phase 2.7).
import { db, tx, inTx } from '../db/db.js';
import { createThing, relate, lockHome } from './things.js';
import { placePlantPoints } from './points.js';
import { ensureLink } from './links.js';

// Home-wide devices sit at home level and need no room: no rule here places one in a room, even when asked.
export const HOME_WIDE = Object.freeze(['inverter', 'pv_array', 'battery', 'home_supply', 'grid_connection', 'hub']);
const NAMES = Object.freeze({
  inverter: 'Inverter', pv_array: 'PV array', battery: 'Battery', grid_connection: 'Grid connection', home_supply: 'Home supply',
  solar_battery: 'Solar and battery', outside_wall: 'Outside wall', driveway: 'Driveway',
});
const SPACE_TYPES = Object.freeze(['floor', 'room', 'garage', 'loft', 'outdoor', 'outside_wall', 'driveway']);
const OUTSIDE = Object.freeze(['meter_import', 'meter_export', 'meter_gas']);       // mounted on an outside wall
const DRIVEWAY = Object.freeze(['ev', 'ev_charger']);                                // stand on the driveway
// The home supply feeds a load through its one ac port (an ev behind a charger is fed by the charger instead).
const LOAD_PORT = Object.freeze({ ev: 'charge', ev_charger: 'ac', heat_pump: 'ac', smart_plug: 'in', immersion: 'ac', iboost: 'ac' });
const PV_KEYS = ['pv_kwp', 'pv_tilt', 'pv_orientation'];
const SOLAR_METRICS = ['solar_w', 'solar_kwh'];
const BATTERY_METRICS = ['battery_soc_pct'];

// ───────────── facts (reads only) ─────────────
export async function graphFacts(homeId) {
  const home = await db.prepare("SELECT id, valid_from FROM thing WHERE id = ? AND kind = 'home' AND superseded_at IS NULL").get(homeId);
  if (!home) return null;
  const things = (await db.prepare(`SELECT id, kind, type, name, valid_from, valid_to FROM thing
    WHERE home_id = ? AND kind <> 'home' AND superseded_at IS NULL AND merged_into IS NULL ORDER BY id`).all(homeId))
    .map((t) => ({ id: Number(t.id), kind: t.kind, type: t.type, name: t.name, valid_from: t.valid_from, retired: t.valid_to != null }));
  const relations = (await db.prepare('SELECT from_id, from_port, rel, to_id, to_port FROM thing_relation WHERE home_id = ? AND superseded_at IS NULL').all(homeId))
    .map((r) => ({ from: Number(r.from_id), fromPort: r.from_port ?? null, rel: r.rel, to: Number(r.to_id), toPort: r.to_port ?? null }));
  const attrs = new Set((await db.prepare('SELECT DISTINCT attr FROM site_attribute WHERE site_id = ? AND value IS NOT NULL AND superseded_at IS NULL').all(homeId)).map((r) => r.attr));
  const provider = await db.prepare(`SELECT 1 AS x FROM connection c WHERE c.site_id = ? AND c.provider IN (SELECT adapter FROM market_provider WHERE role = 'inverter') LIMIT 1`).get(homeId);
  const readings = async (codes) => !!(await db.prepare(`SELECT 1 AS x FROM series s JOIN metric m ON m.id = s.metric_id
    WHERE s.site_id = ? AND m.code IN (${codes.map(() => '?').join(', ')})
      AND (EXISTS (SELECT 1 FROM reading r WHERE r.series_id = s.id) OR EXISTS (SELECT 1 FROM interval_fact f WHERE f.series_id = s.id)) LIMIT 1`).get(homeId, ...codes));
  return {
    home: { id: Number(home.id), valid_from: home.valid_from },
    things, relations,
    evidence: {
      inverterProvider: !!provider,
      pv: PV_KEYS.some((k) => attrs.has(k)), battery: attrs.has('battery_kwh'),
      pvReadings: await readings(SOLAR_METRICS), batteryReadings: await readings(BATTERY_METRICS),
    },
  };
}

// ───────────── the plan (pure) ─────────────
// `declare` is what the caller knows that the evidence cannot say (a fixture, a synthetic home): { inverter, pvArray, battery:
// true or a name, gridConnection: true, rooms: [{ name, type = 'room', things: [ids] }] }.
// Returns { create: [{ key, type, name }], relate: [{ from, fromPort, rel, to, toPort }], wired }. A thing is named in a relation
// by its id, or by the key of a thing to create.
export function planGraph(facts, declare = {}) {
  const things = facts.things;
  const everType = (type) => things.some((t) => t.type === type);
  const liveOf = (type) => things.filter((t) => t.type === type && !t.retired);
  const create = [];
  const make = (type, name = null) => { const key = `new:${type}#${create.length + 1}`; create.push({ key, type, name: name ?? NAMES[type] ?? type }); return key; };
  const node = (type) => [...liveOf(type).map((t) => t.id), ...create.filter((c) => c.type === type).map((c) => c.key)];
  const named = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const ev = facts.evidence;

  // 1. things from evidence
  if (!everType('inverter') && (ev.inverterProvider || declare.inverter)) make('inverter', named(declare.inverter));
  if (!everType('pv_array') && (ev.pv || ev.pvReadings || declare.pvArray)) make('pv_array', named(declare.pvArray));
  if (!everType('battery') && (ev.battery || ev.batteryReadings || declare.battery)) make('battery', named(declare.battery));
  const metered = things.some((t) => (t.type === 'meter_import' || t.type === 'meter_export') && !t.retired);
  if (!everType('grid_connection') && (metered || node('inverter').length || declare.gridConnection)) make('grid_connection');
  if (!everType('home_supply') && (node('grid_connection').length || node('inverter').length)) make('home_supply');
  if (!everType('solar_battery') && (node('pv_array').length || node('battery').length)) make('solar_battery');

  // 2. spaces: a space exists only where something is placed in it
  if (!everType('outside_wall') && things.some((t) => OUTSIDE.includes(t.type) && !t.retired)) make('outside_wall');
  if (!everType('driveway') && things.some((t) => DRIVEWAY.includes(t.type) && !t.retired)) make('driveway');
  const roomOf = new Map();   // thing id to the space (id or key) the caller put it in
  for (const room of declare.rooms ?? []) {
    const type = room.type ?? 'room';
    const have = things.find((t) => t.kind === 'space' && t.type === type && t.name === room.name && !t.retired) ?? create.find((c) => c.type === type && c.name === room.name);
    const ref = have ? (have.key ?? have.id) : make(type, room.name);
    for (const id of room.things ?? []) roomOf.set(id, ref);
  }

  // 3. relations
  const relate = [];
  const seen = new Set(facts.relations.map((r) => `${r.from}|${r.fromPort ?? ''}|${r.rel}|${r.to}|${r.toPort ?? ''}`));
  const link = (from, fromPort, rel, to, toPort = null) => {
    if (from == null || to == null) return;
    const k = `${from}|${fromPort ?? ''}|${rel}|${to}|${toPort ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    relate.push({ from, fromPort, rel, to, toPort });
  };
  const inverters = node('inverter');
  const wired = inverters.length <= 1;
  const [I] = inverters;
  const G = node('grid_connection')[0] ?? null;
  const S = node('home_supply')[0] ?? null;
  const sys = node('solar_battery')[0] ?? null;

  for (const m of [...node('meter_import'), ...node('meter_export')]) {
    link(G, 'meter', 'feeds', m, 'grid');
    link(m, null, 'meters', G, null);
    if (wired) { if (I != null) link(m, 'load', 'feeds', I, 'grid'); else link(m, 'load', 'feeds', S, 'in'); }
  }
  if (wired && I != null) {
    for (const pv of node('pv_array')) link(pv, 'dc', 'feeds', I, 'pv');
    for (const b of node('battery')) { link(I, 'battery', 'feeds', b, 'charge'); link(b, 'discharge', 'feeds', I, 'battery'); }
    link(I, 'ac', 'feeds', S, 'in');
  }
  if (wired) {
    const charger = node('ev_charger')[0] ?? null;
    for (const t of things) {
      if (t.retired || !LOAD_PORT[t.type]) continue;
      if (t.type === 'ev' && charger != null) link(charger, 'ev', 'feeds', t.id, 'charge');
      else link(S, 'out', 'feeds', t.id, LOAD_PORT[t.type]);
    }
  }
  for (const x of [...node('pv_array'), ...inverters, ...node('battery')]) link(x, null, 'part_of', sys, null);

  // 4. places: the home, or the space a rule or the caller names; never a room for a home-wide device
  const placed = new Set(facts.relations.filter((r) => r.rel === 'located_in').map((r) => r.from));
  const candidates = [
    ...things.filter((t) => !t.retired && (t.kind === 'device' || t.kind === 'space')).map((t) => ({ ref: t.id, type: t.type, kind: t.kind })),
    ...create.filter((c) => c.type !== 'solar_battery').map((c) => ({ ref: c.key, type: c.type, kind: SPACE_TYPES.includes(c.type) ? 'space' : 'device' })),   // a system is not placed
  ];
  for (const c of candidates) {
    if (typeof c.ref === 'number' && placed.has(c.ref)) continue;
    let to = facts.home.id;
    if (c.kind === 'device' && !HOME_WIDE.includes(c.type)) {
      if (roomOf.has(c.ref)) to = roomOf.get(c.ref);
      else if (OUTSIDE.includes(c.type)) to = node('outside_wall')[0] ?? to;
      else if (DRIVEWAY.includes(c.type)) to = node('driveway')[0] ?? to;
    }
    link(c.ref, null, 'located_in', to, null);
  }
  return { create, relate, wired };
}

export const isEmptyPlan = (plan) => plan.create.length === 0 && plan.relate.length === 0;

// ───────────── writing ─────────────
// Through the thing library only. A thing starts when the home did; a relation starts at the next slot boundary after the later
// of the moments its two ends began (the library snaps it to the home's grid and keeps the exact moment).
export async function applyPlan(homeId, plan, facts) {
  const ids = new Map();
  const began = new Map(facts.things.map((t) => [t.id, t.valid_from ?? facts.home.valid_from ?? 0]));
  began.set(facts.home.id, facts.home.valid_from ?? 0);
  for (const c of plan.create) {
    const t = await createThing({ siteId: homeId, type: c.type, name: c.name, validFrom: facts.home.valid_from ?? null });
    ids.set(c.key, t.id);
    began.set(t.id, facts.home.valid_from ?? 0);
  }
  const idOf = (ref) => (typeof ref === 'string' ? ids.get(ref) : ref);
  for (const r of plan.relate) {
    const from = idOf(r.from);
    const to = idOf(r.to);
    await relate({ siteId: homeId, from, rel: r.rel, to, fromPort: r.fromPort, toPort: r.toPort, at: Math.max(began.get(from) ?? 0, began.get(to) ?? 0) });
  }
  return { created: plan.create.length, related: plan.relate.length };
}

// What follows from the graph being there: the home's own series move onto the plant things, and the inverter is named by the
// provider's plant (a Sunsynk plant id) so a second look at the plant is the same inverter.
async function settle(homeId) {
  await placePlantPoints(homeId);
  const inverter = await db.prepare(`SELECT t.id FROM thing t JOIN device d ON d.id = t.id AND d.provider = 'thing' WHERE t.home_id = ? AND t.type = 'inverter' AND t.superseded_at IS NULL AND t.valid_to IS NULL`).all(homeId);
  if (inverter.length !== 1) return;
  const conn = await db.prepare(`SELECT c.id, c.provider, c.external_ref FROM connection c WHERE c.site_id = ? AND c.external_ref IS NOT NULL AND c.external_ref <> ''
    AND c.provider IN (SELECT adapter FROM market_provider WHERE role = 'inverter') ORDER BY c.id LIMIT 1`).get(homeId);
  if (conn) await ensureLink({ homeId, thingId: Number(inverter[0].id), provider: conn.provider, externalRef: conn.external_ref, connectionId: Number(conn.id) });
}

/**
 * Make what a home's evidence shows and wire it, once. Cheap when there is nothing to do (a few reads); otherwise one transaction
 * under the home's lock, with the facts read again inside it, so two callers make one set of things.
 * @returns {Promise<{ created: number, related: number, wired: boolean } | null>} null when the home has no home thing
 */
export async function ensureEnergyGraph(homeId, { declare = {} } = {}) {
  const first = await graphFacts(homeId);
  if (!first) return null;
  const quick = planGraph(first, declare);
  if (isEmptyPlan(quick)) { await settle(homeId); return { created: 0, related: 0, wired: quick.wired }; }
  const run = async () => {
    await lockHome(homeId);
    const facts = await graphFacts(homeId);
    const plan = planGraph(facts, declare);
    const made = await applyPlan(homeId, plan, facts);
    await settle(homeId);
    return { ...made, wired: plan.wired };
  };
  return inTx() ? await run() : await tx(run);
}

/** Every home, in id order. A failure of one is returned, not thrown: start-up goes on. */
export async function ensureAllHomes() {
  const failed = [];
  let created = 0;
  let related = 0;
  for (const { id } of await db.prepare('SELECT id FROM site ORDER BY id').all()) {
    try {
      const r = await ensureEnergyGraph(Number(id));
      created += r?.created ?? 0;
      related += r?.related ?? 0;
    } catch (err) { failed.push({ homeId: Number(id), error: err.message }); }
  }
  return { created, related, failed };
}
