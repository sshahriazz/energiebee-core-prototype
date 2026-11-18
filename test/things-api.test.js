// The thing API (plan 1.6, src/routes/things.js) over HTTP on the GB snapshot with its energy graph, and a second home with another
// owner: every route's happy path and shape, the places over time, spaces and systems made and moved, refused writes, merged uids,
// bad input, and who may see what (a home or a thing of another home is the same 404 as a uid that does not exist; shared context
// is read-only and its relations are limited to homes the reader can see; no response carries an integer id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const T = await import('../src/core/things.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');

const alice = await createUser({ name: 'Alice', role: 'owner' }); await giveHome(alice.id, 1);
const bobHome = await createSite({ name: 'Bob home' });
const bob = await createUser({ name: 'Bob', role: 'owner' }); await giveHome(bob.id, bobHome.id);
const admin = await createUser({ name: 'Admin', role: 'admin' });
await addDevice({ siteId: bobHome.id, kind: 'meter_import', provider: 'test', externalRef: 'bob-m1' });
await ensureEnergyGraph(1);
await ensureEnergyGraph(bobHome.id);

const server = app.listen(0);
server.unref();
async function call(path, user, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(user != null ? { 'x-user-id': String(user.id) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}
const uidOf = async (id) => (await db.prepare('SELECT uid FROM thing WHERE id = ?').get(id)).uid;
const homeUid = await uidOf(1);
const bobHomeUid = await uidOf(bobHome.id);
const things = async (user, uid, q = '') => (await call(`/api/homes/${uid}/things${q}`, user)).body.things;
const byType = (list, type) => list.find((t) => t.type === type);
const ID_KEYS = new Set(['id', 'home_id', 'site_id', 'from_id', 'to_id', 'thing_id', 'other_id']);
const noIds = (value, where = '') => {
  if (Array.isArray(value)) value.forEach((v, i) => noIds(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { assert.ok(!ID_KEYS.has(k), `${where}.${k} is an integer id`); noIds(v, `${where}.${k}`); }
};
const UNKNOWN = '01900000-0000-7000-8000-00000000dead';

await test('the registry of types, by kind', { skip }, async () => {
  const r = await call('/api/thing-types?kind=space', alice);
  assert.equal(r.status, 200);
  assert.ok(['room', 'outside_wall', 'driveway'].every((t) => r.body.types.some((x) => x.type === t)));
  assert.ok(r.body.types.every((t) => t.kind === 'space' && Array.isArray(t.attribute_keys)));
  const bad = await call('/api/thing-types?kind=nonsense', alice);
  assert.deepEqual([bad.status, Object.keys(bad.body).sort(), bad.body.code], [400, ['code', 'error'], 'bad_request']);
});

await test('the graph of home 1: spatial tree, energy edges, systems, roll-up; uids only', { skip }, async () => {
  const r = await call(`/api/homes/${homeUid}/graph`, alice);
  assert.equal(r.status, 200);
  noIds(r.body);
  assert.equal(r.body.home.uid, homeUid);
  const feeds = r.body.energy.edges.filter((e) => e.rel === 'feeds');
  assert.equal(feeds.length, 9);
  assert.equal(r.body.energy.edges.filter((e) => e.rel === 'meters').length, 2);
  assert.deepEqual([r.body.energy.wired, r.body.energy.isolated], [true, []]);
  assert.ok(r.body.energy.nodes.every((n) => n.type !== 'meter_gas'), 'the gas meter is on no energy edge');
  assert.equal(r.body.systems.length, 1);
  assert.deepEqual(r.body.systems[0].members.map((m) => m.type).sort(), ['battery', 'inverter', 'pv_array']);
  assert.deepEqual(r.body.spatial.children.map((c) => c.type).sort(), ['battery', 'driveway', 'grid_connection', 'home_supply', 'inverter', 'outside_wall', 'pv_array']);
  const wall = r.body.spatial.children.find((c) => c.type === 'outside_wall');
  assert.deepEqual(wall.children.map((c) => c.type).sort(), ['meter_export', 'meter_gas', 'meter_import']);
  assert.deepEqual([r.body.rollup.arrays, r.body.rollup.batteries], [1, 1]);
  assert.ok(r.body.rollup.pv_kwp > 0 && r.body.rollup.battery_kwh > 0);
});

await test('things of a home, filtered; one thing with its place, relations and systems', { skip }, async () => {
  const spaces = await things(alice, homeUid, '?kind=space');
  assert.deepEqual(spaces.map((t) => t.type).sort(), ['driveway', 'outside_wall']);
  assert.ok(spaces.every((t) => t.home_uid === homeUid && !('id' in t)));
  const all = await things(alice, homeUid);
  const meter = byType(all, 'meter_import');
  const r = await call(`/api/things/${meter.uid}`, alice);
  assert.equal(r.status, 200); noIds(r.body);
  assert.deepEqual(r.body.place.map((t) => t.type), ['meter_import', 'outside_wall', 'house']);
  assert.ok(r.body.relations.in.some((e) => e.rel === 'feeds' && e.from.port === 'meter' && e.to.port === 'grid'));
  assert.ok(r.body.relations.out.some((e) => e.rel === 'feeds' && e.from.port === 'load' && e.to.port === 'grid'));
  const pv = await call(`/api/things/${byType(all, 'pv_array').uid}`, alice);
  assert.deepEqual(pv.body.systems.map((s) => s.name), ['Solar and battery']);
  const tree = await call(`/api/things/${byType(all, 'inverter').uid}/tree?rel=feeds`, alice);
  assert.equal(tree.status, 200);
  const reach = await call(`/api/things/${byType(all, 'pv_array').uid}/reach?rel=feeds&direction=out`, alice);
  assert.deepEqual(reach.body.reach.map((t) => [t.type, t.distance]).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2), [['inverter', 1], ['battery', 2]]);
  const rel = await call(`/api/things/${meter.uid}/relations?rel=feeds&direction=in`, alice);
  assert.deepEqual(rel.body.relations.map((e) => e.from.name), ['Grid connection']);
  const hist = await call(`/api/things/${meter.uid}/history`, alice);
  assert.equal(hist.status, 200); noIds(hist.body);
  assert.ok(hist.body.versions.length >= 1 && hist.body.relations.length >= 4);
});

await test('spaces are made, renamed, filled and moved; a place is readable at any time; a refused placement leaves nothing behind', { skip }, async () => {
  const all = await things(alice, homeUid);
  const wall = byType(all, 'outside_wall'); const gas = byType(all, 'meter_gas');
  const made = await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'room', name: '  Utility room  ', attrs: { floor_area_m2: 6 }, validFrom: Math.floor(Date.now() / 1000) - 86400 } });
  assert.equal(made.status, 201); noIds(made.body);
  assert.equal(made.body.thing.name, 'Utility room');
  assert.equal(made.body.placement.to.uid, homeUid, 'a space with no place is put at the home');
  const room = made.body.thing.uid;
  const before = Date.now();
  const longAgo = Math.floor(Date.now() / 1000) - 7200;
  const moved = await call(`/api/things/${gas.uid}/move`, alice, { method: 'POST', body: { to: room, at: longAgo } });
  assert.equal(moved.status, 200); noIds(moved.body);
  assert.equal(moved.body.from, wall.uid); assert.equal(moved.body.to, room);
  assert.deepEqual((await call(`/api/things/${gas.uid}/place`, alice)).body.place.map((t) => t.name), ['meter_gas', 'Utility room', 'GB fixture home']);
  assert.deepEqual((await call(`/api/things/${gas.uid}/place?at=${moved.body.boundary - 1}`, alice)).body.place.map((t) => t.name), ['meter_gas', 'Outside wall', 'GB fixture home'], 'before the move');
  assert.deepEqual((await call(`/api/things/${gas.uid}/place?known=${before - 1}`, alice)).body.place.map((t) => t.name), ['meter_gas', 'Outside wall', 'GB fixture home'], 'as known before the move');
  const same = await call(`/api/things/${gas.uid}/move`, alice, { method: 'POST', body: { to: room, at: longAgo } });
  assert.equal(same.body.relation, null, 'moving to where it is writes nothing');
  assert.equal((await call(`/api/things/${room}/retire`, alice, { method: 'POST', body: {} })).status, 409);
  assert.match((await call(`/api/things/${room}/retire`, alice, { method: 'POST', body: {} })).body.error, /meter_gas/, 'the 409 names what the room holds');
  const renamed = await call(`/api/things/${room}`, alice, { method: 'PATCH', body: { name: 'Plant room', attrs: { floor_area_m2: 7 } } });
  assert.deepEqual([renamed.status, renamed.body.thing.name, renamed.body.thing.attrs.floor_area_m2], [200, 'Plant room', 7]);
  // a cycle is refused
  const inner = await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'room', name: 'Cupboard', placeIn: room, validFrom: Math.floor(Date.now() / 1000) - 86400 } });
  assert.equal(inner.status, 201);
  const cycle = await call(`/api/things/${room}/move`, alice, { method: 'POST', body: { to: inner.body.thing.uid } });
  assert.equal(cycle.status, 409);
  // a placement in another home is a 404, and the thing is not made
  const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM thing WHERE home_id = 1').get()).n;
  const n = await count();
  const foreign = byType(await things(bob, bobHomeUid), 'outside_wall').uid;
  const refused = await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'room', name: 'Orphan', placeIn: foreign } });
  assert.equal(refused.status, 404);
  assert.equal(await count(), n, 'no orphan');
  // an empty room can be retired; a device of an integration cannot
  assert.equal((await call(`/api/things/${inner.body.thing.uid}/retire`, alice, { method: 'POST', body: {} })).status, 200);
  const dev = await call(`/api/things/${gas.uid}/retire`, alice, { method: 'POST', body: {} });
  assert.deepEqual([dev.status, dev.body.code], [400, 'read_only_kind']);
});

await test('what the API will not make or change: devices, homes, feeds; and a system joins by part_of', { skip }, async () => {
  const all = await things(alice, homeUid);
  const made = await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'inverter', name: 'Second inverter' } });
  assert.deepEqual([made.status, made.body.code], [400, 'read_only_kind'], 'a device is not made through the API');
  assert.equal((await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'room', name: '' } })).status, 400);
  assert.equal((await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'heating', name: 'Heating', placeIn: byType(all, 'outside_wall').uid } })).status, 400, 'a system is not placed');
  assert.equal((await call(`/api/things/${byType(all, 'inverter').uid}`, alice, { method: 'PATCH', body: { name: 'x' } })).body.code, 'read_only_kind');
  assert.equal((await call(`/api/things/${homeUid}`, alice, { method: 'PATCH', body: { name: 'x' } })).body.code, 'read_only_kind');
  const heating = await call(`/api/homes/${homeUid}/things`, alice, { method: 'POST', body: { type: 'heating', name: 'Heating' } });
  assert.equal(heating.status, 201); assert.equal(heating.body.placement, null);
  const feeds = await call(`/api/homes/${homeUid}/relations`, alice, { method: 'POST', body: { from: byType(all, 'inverter').uid, rel: 'feeds', to: byType(all, 'home_supply').uid } });
  assert.deepEqual([feeds.status, feeds.body.code], [400, 'read_only_kind'], 'feeds is not written through the API');
  const join = await call(`/api/homes/${homeUid}/relations`, alice, { method: 'POST', body: { from: byType(all, 'inverter').uid, rel: 'part_of', to: heating.body.thing.uid, at: Math.floor(Date.now() / 1000) - 7200 } });
  assert.equal(join.status, 201); noIds(join.body);
  const ended = await call(`/api/relations/${join.body.relation.uid}/end`, alice, { method: 'POST', body: { at: Math.floor(Date.now() / 1000) - 3600 } });
  assert.deepEqual([ended.status, ended.body.what], [200, 'ended']);
  const feedsRow = (await call(`/api/things/${byType(all, 'inverter').uid}/relations?rel=feeds&direction=out&at=${Math.floor(Date.now() / 1000) + 86400}`, alice)).body.relations[0];
  const noEnd = await call(`/api/relations/${feedsRow.uid}/end`, alice, { method: 'POST', body: {} });
  assert.deepEqual([noEnd.status, noEnd.body.code], [400, 'read_only_kind'], 'feeds is not ended through the API');
});

await test('a merged thing answers as the one that survived, and bad input is a 400 with only error and code', { skip }, async () => {
  const a = await T.createThing({ siteId: 1, type: 'room', name: 'Merge keep' });
  const b = await T.createThing({ siteId: 1, type: 'room', name: 'Merge drop' });
  await T.mergeThings(a.id, b.id, { siteId: 1, reason: 'api test' });
  const r = await call(`/api/things/${b.uid}`, alice);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.thing.uid, r.body.merged_from], [a.uid, b.uid]);
  const wall = byType(await things(alice, homeUid), 'outside_wall').uid;
  for (const q of ['?at=yesterday-ish', '?known=1700000000', '?at=1700000000000', '/tree?rel=nonsense', '/tree?maxDepth=99', '/reach?direction=sideways', '/relations?direction=up']) {
    const path = q.startsWith('?') ? `/api/things/${wall}${q}` : `/api/things/${wall}${q}`;
    const bad = await call(path, alice);
    assert.equal(bad.status, 400, q);
    assert.deepEqual(Object.keys(bad.body).sort(), ['code', 'error'], q);
  }
});

await test('who may see what: another owner, nobody signed in, an admin, and shared context', { skip }, async () => {
  const all = await things(alice, homeUid);
  const meter = byType(all, 'meter_import');
  const missing = (await call(`/api/things/${UNKNOWN}`, bob)).text;
  const paths = [`/api/homes/${homeUid}/graph`, `/api/homes/${homeUid}/things`, `/api/things/${meter.uid}`, `/api/things/${meter.uid}/tree`, `/api/things/${meter.uid}/place`,
    `/api/things/${meter.uid}/relations`, `/api/things/${meter.uid}/reach`, `/api/things/${meter.uid}/history`];
  for (const p of paths) {
    const asBob = await call(p, bob);
    const random = await call(p.replace(/[0-9a-f-]{36}/, UNKNOWN), bob);
    assert.equal(asBob.status, 404, p);
    assert.equal(asBob.text, random.text, `${p}: another owner's home is the same 404 as a uid that does not exist`);
    assert.equal((await call(p, null)).status, 404, `${p}: nobody owns... a home that has an owner is not shown to nobody`);
    assert.equal((await call(p, admin)).status, 200, `${p}: an admin sees every home`);
  }
  assert.ok(missing.includes('not_found'));
  const wall = byType(all, 'outside_wall').uid;
  for (const [method, p, body] of [['POST', `/api/homes/${homeUid}/things`, { type: 'room', name: 'Intruder' }], ['PATCH', `/api/things/${wall}`, { name: 'Mine' }], ['POST', `/api/things/${wall}/retire`, {}],
    ['POST', `/api/things/${meter.uid}/move`, { to: wall }], ['POST', `/api/homes/${homeUid}/relations`, { from: wall, rel: 'part_of', to: wall }]]) {
    assert.equal((await call(p, bob, { method, body })).status, 404, `${method} ${p}`);
  }
  // a move of bob's thing under alice's space is a 404, not a write
  const bobWall = byType(await things(bob, bobHomeUid), 'outside_wall').uid;
  assert.equal((await call(`/api/things/${bobWall}/move`, bob, { method: 'POST', body: { to: wall } })).status, 404);
  // shared context: readable by anyone, writable by nobody, relations limited to homes the reader can see
  const tariff = await T.createThing({ type: 'tariff', name: 'Shared test tariff', attrs: {} });
  await T.relate({ siteId: 1, from: meter.uid, rel: 'supplied_on', to: tariff.uid, at: Math.floor(Date.now() / 1000) - 7200 });
  const asAlice = await call(`/api/things/${tariff.uid}`, alice);
  const asBob = await call(`/api/things/${tariff.uid}`, bob);
  assert.equal(asAlice.status, 200); assert.equal(asBob.status, 200);
  assert.equal(asAlice.body.relations.in.length, 1);
  assert.equal(asBob.body.relations.in.length, 0, 'bob cannot see the home the tariff is supplied to');
  assert.equal((await call(`/api/things/${tariff.uid}`, admin)).body.relations.in.length, 1);
  assert.equal((await call(`/api/things/${tariff.uid}`, alice, { method: 'PATCH', body: { name: 'Mine' } })).body.code, 'read_only_kind');
  for (const r of [asAlice, asBob]) noIds(r.body);
});

await test('a thing\'s points with their state, and its timeline slot by slot and day by day; another owner sees neither', { skip }, async () => {
  const { buildHomePointSlots } = await import('../src/core/point-slots.js');
  const { buildHomeNodeSlots } = await import('../src/core/node-slots.js');
  const all = await things(alice, homeUid);
  const meter = byType(all, 'meter_import');
  const pts = await call(`/api/things/${meter.uid}/points`, alice);
  assert.equal(pts.status, 200); noIds(pts.body);
  const imp = pts.body.points.find((p) => p.metric === 'grid_import_kwh');
  assert.ok(imp && imp.reported && imp.reported.value != null && imp.reported.source === 'octopus_meter', 'the state came from the facts');
  await buildHomePointSlots(1, '2026-10-14', '2026-10-14');
  const day = await call(`/api/things/${meter.uid}/timeline?from=2026-10-14&to=2026-10-15&res=day`, alice);
  assert.equal(day.status, 200); noIds(day.body);
  const line = day.body.lines.find((l) => l.metric === 'grid_import_kwh');
  assert.ok(line.slots.length > 40 && line.slots.every((s) => s.coverage > 0 && s.dur_s === 1800), 'a half-hour slot each, on the home\'s grid');
  assert.equal(line.days.length, 1);
  assert.ok(Math.abs(line.days[0].delta - line.slots.reduce((t, s) => t + s.delta, 0)) < 1e-6, 'the day is its slots added up');
  await buildHomeNodeSlots(1, '2026-10-14', '2026-10-14');
  const home = await call(`/api/things/${homeUid}/timeline?from=2026-10-14&to=2026-10-15`, alice);
  assert.equal(home.body.kind, 'place');
  assert.equal((await call(`/api/things/${meter.uid}/timeline?from=2026-10-14&to=2026-12-31`, alice)).status, 400, 'at most 31 days');
  assert.equal((await call(`/api/things/${meter.uid}/timeline?res=week`, alice)).status, 400);
  for (const p of [`/api/things/${meter.uid}/points`, `/api/things/${meter.uid}/timeline`]) assert.equal((await call(p, bob)).status, 404, p);
});
