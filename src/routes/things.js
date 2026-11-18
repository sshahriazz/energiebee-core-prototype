// The thing API (plan 1.6): the graph of a home, the tree of its places, spaces and systems made, renamed, retired and moved, and
// the relations between things. Mounted by one line in src/server.js. docs/build/graph.md has the table of routes.
//
// Everything is addressed by uid. A uid that does not exist, one that is not a home where a home is wanted, and one of a home the
// signed-in user may not see answer the same 404 (no existence oracle). Shared context (a tariff, a region) is readable by anyone
// signed in, with its relations limited to homes the user can see, and writable by nobody. Writes need what the owner's other
// routes of /api/sites/:id need: that the user can see the home. Every error body is { error, code }.
import express from 'express';
import { db, tx } from '../db/db.js';
import { canSee, visibleSiteIds } from '../core/users.js';
import * as T from '../core/things.js';
import { stateOf } from '../core/point-state.js';
import { readPointSlots } from '../core/point-slots.js';
import { readNodeSlots } from '../core/node-slots.js';
import { dayBounds, localDate } from '../core/time.js';
import { parseAt, parseKnown, viewThing, viewThings, viewRelations, viewTree, viewHistory, lookup, scrub } from '../core/things-view.js';

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['home', 'space', 'device', 'system', 'context'];
const WALKS = ['located_in', 'part_of', 'feeds', 'meters', 'controls', 'replaces', 'served_by', 'supplied_on'];
const WRITABLE_RELS = ['part_of'];          // feeds, meters and controls are set by integrations and the graph seeder
const ENDABLE_RELS = ['part_of', 'located_in'];
const MADE_KINDS = ['space', 'system'];     // what a person makes through the API
const err = (status, message, code = null) => Object.assign(new Error(message), { status, apiCode: code });
const bad = (message, code = null) => err(400, message, code);
const notFound = (what) => err(404, `No such ${what}`, 'not_found');
const CODES = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found', 409: 'conflict' };

const route = (fn) => async (req, res) => {
  try {
    const out = await fn(req);
    res.status(out.status ?? 200).json(out.body);
  } catch (e) {
    const status = e.status ?? (e instanceof RangeError || e instanceof TypeError ? 400 : 500);
    if (status === 500) console.error('thing api:', e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : scrub(e.message), code: e.apiCode ?? CODES[status] ?? 'error' });
  }
};

// ───────────── guards ─────────────
// A thing by uid that this user may see: the survivor of a merge (with the uid asked for), or a shared context thing.
async function guard(req, uid, { home = false, what = 'thing' } = {}) {
  if (!UUID.test(String(uid))) throw notFound(home ? 'home' : what);
  let row;
  try { row = await T.getThing(String(uid).toLowerCase()); } catch { throw notFound(home ? 'home' : what); }
  if (home && row.kind !== 'home') throw notFound('home');
  let mergedFrom = null;
  if (row.merged_into != null) {
    const asked = row.uid;
    row = await T.resolveThing(row.id);
    mergedFrom = asked;
  }
  if (row.home_id != null && !await canSee(req.user, row.home_id)) throw notFound(home ? 'home' : what);
  return { thing: row, mergedFrom };
}
// The home of a thing, for the library's walks and writes; a context thing has none.
const homeOf = (t) => (t.home_id == null ? null : Number(t.home_id));
const at = (req, source = req.query) => parseAt(source.at, 'at');
const known = (req) => parseKnown(req.query.known, 'known');
const timeOpts = (req) => { const o = {}; const a = at(req); const k = known(req); if (a !== undefined) o.at = a; if (k !== undefined) o.known = k; return o; };
const body = (req) => { const b = req.body ?? {}; if (typeof b !== 'object' || Array.isArray(b)) throw bad('the body is a JSON object'); return b; };
const text = (v, what, { min = 1, max = 120 } = {}) => {
  if (typeof v !== 'string') throw bad(`${what} is text`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(`${what} is ${min} to ${max} characters`);
  return s;
};
const isVisibleHome = async (user, homeId) => (await visibleSiteIds(user)) === null || (await canSee(user, homeId));

// The relations of a shared context thing, across homes, limited to the homes this user can see.
async function contextRelations(req, thing, opts) {
  const visible = await visibleSiteIds(req.user);
  const t = opts.at ?? Math.floor(Date.now() / 1000);
  const rows = await db.prepare(`SELECT id, uid, home_id, from_id, from_port, rel, to_id, to_port, required, valid_from, valid_to, changed_at, recorded_at, superseded_at
    FROM thing_relation WHERE (from_id = ? OR to_id = ?) AND superseded_at IS NULL AND COALESCE(valid_from, -9000000000) <= ? AND COALESCE(valid_to, 9000000000) > ? ORDER BY rel, id`).all(thing.id, thing.id, t, t);
  return rows.filter((r) => visible === null || (r.home_id != null && visible.has(Number(r.home_id))));
}

// ───────────── reads ─────────────
router.get('/thing-types', route(async (req) => {
  const kind = req.query.kind;
  if (kind != null && !KINDS.includes(kind)) throw bad(`kind is one of ${KINDS.join(', ')}`);
  const rows = await db.prepare('SELECT type, kind, label, attribute_keys, ports, capabilities, std_ref FROM thing_type WHERE (?::text IS NULL OR kind = ?) ORDER BY kind, type').all(kind ?? null, kind ?? null);
  return { body: { types: rows } };
}));

router.get('/homes/:uid/graph', route(async (req) => {
  const { thing: homeThing } = await guard(req, req.params.uid, { home: true });
  const id = Number(homeThing.id);
  const o = timeOpts(req);
  const g = await T.graph(id, { rels: ['feeds', 'meters'], ...o });
  const energyEdges = g.edges.filter((e) => e.rel === 'feeds');
  const onEdge = new Set(g.edges.flatMap((e) => [e.from_id, e.to_id]));
  const types = new Map((await db.prepare('SELECT type, ports FROM thing_type').all()).map((t) => [t.type, t.ports]));
  const electric = (n) => n.kind === 'device' && n.type !== 'hub' && (types.get(n.type) ?? []).some((p) => p.medium === 'ac' || p.medium === 'dc');
  const fed = new Set(energyEdges.flatMap((e) => [e.from_id, e.to_id]));
  const isolated = g.nodes.filter((n) => electric(n) && !fed.has(n.id));
  const members = await T.relationsAt(id, { rels: ['part_of'], ...o });
  const all = await T.thingsOf(id, o);
  const systems = all.filter((n) => n.kind === 'system');
  const spatial = await viewTree(await T.tree(id, { siteId: id, rel: 'located_in', ...o }));
  const site = await db.prepare('SELECT pv_kwp, battery_kwh FROM site WHERE id = ?').get(id);
  const live = (type) => all.filter((n) => n.type === type && n.valid_to == null).length;
  const by = await lookup(members.flatMap((m) => [m.from_id, m.to_id]));
  return { body: {
    home: await viewThing(homeThing), at: o.at ?? null, known: o.known ?? null,
    spatial,
    energy: {
      nodes: await viewThings(g.nodes.filter((n) => onEdge.has(n.id))),
      edges: await viewRelations(g.edges),
      wired: isolated.length === 0,
      isolated: isolated.map((n) => n.uid),
    },
    systems: await Promise.all(systems.map(async (s) => ({
      uid: s.uid, type: s.type, name: s.name,
      members: members.filter((m) => m.to_id === s.id).map((m) => ({ uid: by.get(Number(m.from_id))?.uid, type: by.get(Number(m.from_id))?.type, name: by.get(Number(m.from_id))?.name })),
    }))),
    rollup: { pv_kwp: site?.pv_kwp ?? null, battery_kwh: site?.battery_kwh ?? null, arrays: live('pv_array'), batteries: live('battery') },
  } };
}));

router.get('/homes/:uid/things', route(async (req) => {
  const { thing: homeThing } = await guard(req, req.params.uid, { home: true });
  const { kind, type } = req.query;
  if (kind != null && !KINDS.includes(kind)) throw bad(`kind is one of ${KINDS.join(', ')}`);
  const rows = await T.thingsOf(Number(homeThing.id), { kind: kind ?? null, type: type ?? null, ...timeOpts(req) });
  return { body: { things: await viewThings(rows) } };
}));

router.get('/things/:uid', route(async (req) => {
  const { thing, mergedFrom } = await guard(req, req.params.uid);
  const o = timeOpts(req);
  if (o.known !== undefined && thing.recorded_at > o.known) throw notFound('thing');
  const home = homeOf(thing);
  const shown = home == null ? thing : (await T.thingAsKnown(thing.id, { known: o.known ?? null }));
  let place = []; let out = []; let into = []; let systems = [];
  if (home != null) {
    place = await T.placeChain(thing.id, { siteId: home, rel: 'located_in', ...o });
    const rels = await T.relationsAt(home, { thing: thing.id, ...o });
    out = rels.filter((r) => r.from_id === thing.id);
    into = rels.filter((r) => r.to_id === thing.id);
    const sysIds = out.filter((r) => r.rel === 'part_of').map((r) => r.to_id);
    if (sysIds.length) systems = (await T.thingsOf(home, { kind: 'system', ...o })).filter((s) => sysIds.includes(s.id));
  } else {
    const rels = await contextRelations(req, thing, o);
    out = rels.filter((r) => r.from_id === thing.id);
    into = rels.filter((r) => r.to_id === thing.id);
  }
  return { body: {
    thing: await viewThing(shown),
    ...(mergedFrom ? { merged_from: mergedFrom } : {}),
    place: await viewThings(place),
    relations: { out: await viewRelations(out), in: await viewRelations(into) },
    systems: await viewThings(systems),
  } };
}));

router.get('/things/:uid/tree', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const rel = req.query.rel ?? 'located_in';
  if (!WALKS.includes(rel)) throw bad(`rel is one of ${WALKS.join(', ')}`);
  const maxDepth = req.query.maxDepth == null ? 20 : Number(req.query.maxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50) throw bad('maxDepth is 1 to 50');
  if (thing.home_id == null) return { body: { tree: await viewTree({ ...thing, children: [] }) } };
  return { body: { tree: await viewTree(await T.tree(thing.id, { siteId: homeOf(thing), rel, maxDepth, ...timeOpts(req) })) } };
}));

router.get('/things/:uid/points', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const shown = await stateOf(thing.id);
  return { body: { points: shown.map(({ id, ...p }) => p) } };
}));

// One local day of a point's slots: totals and events add up; anything else is the mean weighted by coverage, with the day's lowest and highest.
const r9 = (x) => Math.round(x * 1e9) / 1e9;
function dayOfPoint(cls, list) {
  if (cls === 'total' || cls === 'event') return { delta: r9(list.reduce((t, x) => t + (x.delta ?? 0), 0)) };
  const withMean = list.filter((x) => x.mean != null);
  const weight = withMean.reduce((t, x) => t + x.coverage, 0);
  return { mean: weight ? r9(withMean.reduce((t, x) => t + x.mean * x.coverage, 0) / weight) : null, min: withMean.length ? Math.min(...withMean.map((x) => x.min ?? x.mean)) : null, max: withMean.length ? Math.max(...withMean.map((x) => x.max ?? x.mean)) : null };
}

// The timeline of a thing: a device's points slot by slot, a place's rolled-up metrics (docs/build/timelines.md). from and to are epoch
// seconds or local dates of the home (default: today); at most 31 days. res=day adds one row per local day to each line.
router.get('/things/:uid/timeline', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const tz = thing.home_id == null ? 'UTC' : (await db.prepare('SELECT timezone FROM site WHERE id = ?').get(thing.home_id))?.timezone ?? 'UTC';
  const stamp = (v, edge) => {
    if (v == null || v === '') return null;
    if (/^\d{1,11}$/.test(String(v))) return Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return dayBounds(tz, String(v))[edge];
    throw bad('from and to are epoch seconds or local dates (YYYY-MM-DD)');
  };
  const today = dayBounds(tz, localDate(tz, Math.floor(Date.now() / 1000)));
  const from = stamp(req.query.from, 0) ?? today[0];
  const to = stamp(req.query.to, 1) ?? today[1];
  if (!(to > from)) throw bad('to is after from');
  if (to - from > 31 * 86400 + 3600) throw bad('at most 31 days at a time');
  const res = req.query.res ?? 'slot';
  if (!['slot', 'day'].includes(res)) throw bad('res is slot or day');
  const day = (rows, pick) => {
    const by = new Map();
    for (const r of rows) { const d = localDate(tz, r.slot_start); (by.get(d) ?? by.set(d, []).get(d)).push(r); }
    return [...by].map(([date, list]) => ({ date, ...pick(list) }));
  };
  if (['home', 'space', 'system'].includes(thing.kind)) {
    const rows = await readNodeSlots(thing.id, from, to);
    const metrics = [...new Set(rows.map((r) => r.metric))].sort();
    return { body: { thing: await viewThing(thing), kind: 'place', from, to, lines: metrics.map((metric) => {
      const slots = rows.filter((r) => r.metric === metric).map(({ metric: _m, ...r }) => r);
      return { metric, slots, ...(res === 'day' ? { days: day(slots, (l) => ({ value: Math.round(l.reduce((t, s) => t + (s.value ?? 0), 0) * 1e9) / 1e9, slots: l.length })) } : {}) };
    }) } };
  }
  const points = await db.prepare('SELECT p.id, p.key, p.class, m.code AS metric, m.unit FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND p.superseded_at IS NULL ORDER BY p.key').all(thing.id);
  const lines = [];
  for (const p of points) {
    const slots = await readPointSlots(p.id, from, to);
    if (!slots.length) continue;
    lines.push({ key: p.key, metric: p.metric, unit: p.unit, class: p.class, slots, ...(res === 'day' ? { days: day(slots, (l) => dayOfPoint(p.class, l)) } : {}) });
  }
  return { body: { thing: await viewThing(thing), kind: 'device', from, to, lines } };
}));

router.get('/things/:uid/place', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (thing.home_id == null) return { body: { place: [] } };
  return { body: { place: await viewThings(await T.placeChain(thing.id, { siteId: homeOf(thing), rel: 'located_in', ...timeOpts(req) })) } };
}));

router.get('/things/:uid/relations', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const { rel, direction = 'both' } = req.query;
  if (rel != null && !WALKS.includes(rel)) throw bad(`rel is one of ${WALKS.join(', ')}`);
  if (!['in', 'out', 'both'].includes(direction)) throw bad('direction is in, out or both');
  const o = timeOpts(req);
  const rows = thing.home_id == null ? await contextRelations(req, thing, o) : await T.relationsAt(homeOf(thing), { thing: thing.id, rels: rel ? [rel] : null, ...o });
  const kept = rows.filter((r) => (rel == null || r.rel === rel) && (direction === 'both' || (direction === 'out' ? r.from_id === thing.id : r.to_id === thing.id)));
  return { body: { relations: await viewRelations(kept) } };
}));

router.get('/things/:uid/reach', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  const rel = req.query.rel ?? 'feeds';
  if (!WALKS.includes(rel)) throw bad(`rel is one of ${WALKS.join(', ')}`);
  const direction = req.query.direction ?? 'out';
  if (!['in', 'out'].includes(direction)) throw bad('direction is in or out');
  const maxDepth = req.query.maxDepth == null ? 50 : Number(req.query.maxDepth);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50) throw bad('maxDepth is 1 to 50');
  if (thing.home_id == null) return { body: { reach: [] } };
  const rows = await T.reach(thing.id, { siteId: homeOf(thing), rel, direction, maxDepth, ...timeOpts(req) });
  const shown = await viewThings(rows);
  return { body: { reach: shown.map((t, i) => ({ ...t, distance: rows[i].depth })) } };
}));

router.get('/things/:uid/history', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (thing.home_id == null) throw bad('the history of shared context is not shown here', 'read_only_kind');
  return { body: await viewHistory(await T.thingHistory(thing.id, { siteId: homeOf(thing) })) };
}));

// ───────────── writes ─────────────
router.post('/homes/:uid/things', route(async (req) => {
  const { thing: homeThing } = await guard(req, req.params.uid, { home: true });
  const home = Number(homeThing.id);
  const b = body(req);
  const type = text(b.type, 'type', { max: 60 });
  const name = text(b.name, 'name');
  const ty = await db.prepare('SELECT kind FROM thing_type WHERE type = ?').get(type);
  if (!ty) throw bad(`no thing type ${type}`);
  if (!MADE_KINDS.includes(ty.kind)) throw bad(`a ${type} is a ${ty.kind}: devices and homes come from integrations, not from this API (spaces and systems can be made)`, 'read_only_kind');
  if (b.attrs != null && (typeof b.attrs !== 'object' || Array.isArray(b.attrs))) throw bad('attrs is an object');
  if (b.placeIn != null && ty.kind === 'system') throw bad('a system is not placed in a space');
  const validFrom = b.validFrom == null ? null : parseAt(b.validFrom, 'validFrom');
  const out = await tx(async () => {
    let dest = null;
    if (b.placeIn != null) {
      const g = await guard(req, text(b.placeIn, 'placeIn', { max: 60 }));
      if (g.thing.home_id !== home) throw notFound('thing');
      dest = g.thing;
    }
    const made = await T.createThing({ siteId: home, type, name, attrs: b.attrs ?? {}, validFrom });
    let placement = null;
    if (ty.kind === 'space') placement = (await T.moveThing(made.id, dest?.id ?? home, { siteId: home, ...(validFrom != null ? { at: validFrom } : {}) })).relation;
    return { made, placement };
  });
  const [placement] = out.placement ? await viewRelations([out.placement]) : [null];
  return { status: 201, body: { thing: await viewThing(out.made), placement } };
}));

router.patch('/things/:uid', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (!MADE_KINDS.includes(thing.kind)) throw bad(`a ${thing.kind} cannot be changed through this API`, 'read_only_kind');
  const b = body(req);
  const patch = {};
  if (b.name !== undefined) patch.name = text(b.name, 'name');
  if (b.attrs !== undefined) { if (b.attrs === null || typeof b.attrs !== 'object' || Array.isArray(b.attrs)) throw bad('attrs is an object'); patch.attrs = b.attrs; }
  if (!Object.keys(patch).length) throw bad('give name or attrs');
  return { body: { thing: await viewThing(await T.updateThing(thing.id, { siteId: homeOf(thing), ...patch })) } };
}));

router.post('/things/:uid/retire', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (thing.home_id == null || thing.kind === 'home') throw bad(`a ${thing.kind} cannot be retired through this API`, 'read_only_kind');
  if (thing.kind === 'device') {
    const row = await db.prepare('SELECT provider FROM device WHERE id = ?').get(thing.id);
    if (row && row.provider !== 'thing') throw bad('this device comes from an integration: retire it there', 'read_only_kind');
  }
  const when = parseAt(body(req).at, 'at');
  const r = await T.retireThing(thing.id, { siteId: homeOf(thing), ...(when !== undefined ? { at: when } : {}) });
  return { body: { thing: await viewThing(r.thing), changedAt: r.changedAt, boundary: r.boundary, relations: r.relations.map((x) => ({ rel: x.rel, what: x.what })) } };
}));

router.post('/things/:uid/move', route(async (req) => {
  const { thing } = await guard(req, req.params.uid);
  if (thing.home_id == null || thing.kind === 'home') throw bad(`a ${thing.kind} cannot be moved`, 'read_only_kind');
  const b = body(req);
  const g = await guard(req, text(b.to, 'to', { max: 60 }));
  if (g.thing.home_id !== thing.home_id) throw notFound('thing');
  const when = parseAt(b.at, 'at');
  const r = await T.moveThing(thing.id, g.thing.id, { siteId: homeOf(thing), ...(when !== undefined ? { at: when } : {}) });
  const from = r.from == null ? null : (await lookup([r.from])).get(Number(r.from))?.uid ?? null;
  const [relation] = r.relation ? await viewRelations([r.relation]) : [null];
  return { body: { changedAt: r.changedAt, boundary: r.boundary, from, to: g.thing.uid, relation } };
}));

router.post('/homes/:uid/relations', route(async (req) => {
  const { thing: homeThing } = await guard(req, req.params.uid, { home: true });
  const home = Number(homeThing.id);
  const b = body(req);
  if (!WRITABLE_RELS.includes(b.rel)) throw bad(`only ${WRITABLE_RELS.join(', ')} can be written here: feeds, meters and controls are set by integrations`, 'read_only_kind');
  const [from, to] = [await guard(req, text(b.from, 'from', { max: 60 })), await guard(req, text(b.to, 'to', { max: 60 }))];
  for (const g of [from, to]) if (g.thing.home_id !== home) throw notFound('thing');
  const when = parseAt(b.at, 'at');
  const validTo = b.validTo == null ? null : parseAt(b.validTo, 'validTo');
  const r = await T.relate({ siteId: home, from: from.thing.id, rel: b.rel, to: to.thing.id, ...(when !== undefined ? { at: when } : {}), validTo });
  return { status: 201, body: { relation: (await viewRelations([r]))[0] } };
}));

router.post('/relations/:uid/end', route(async (req) => {
  if (!UUID.test(req.params.uid)) throw notFound('relation');
  const r = await db.prepare('SELECT id, home_id, rel FROM thing_relation WHERE uid = ?::uuid AND superseded_at IS NULL').get(req.params.uid.toLowerCase());
  if (!r || r.home_id == null || !await canSee(req.user, r.home_id)) throw notFound('relation');
  if (!ENDABLE_RELS.includes(r.rel)) throw bad(`only ${ENDABLE_RELS.join(', ')} can be ended here`, 'read_only_kind');
  const when = parseAt(body(req).at, 'at');
  const out = await T.unrelate(r.id, { siteId: Number(r.home_id), ...(when !== undefined ? { at: when } : {}) });
  return { body: { what: out.what, boundary: out.boundary } };
}));

export default router;
