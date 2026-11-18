// The energy graph on a snapshot of the real GB home (plan 1.4 and 1.5): the plant is made from the connection and the four numbers,
// wired through the thing library (so the database's own rules judged every edge), idempotent, and never made again once gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
const { db } = await import('../src/db/db.js');
const G = await import('../src/core/energy-graph.js');
const { retireThing, relationsAt, thingsOf } = await import('../src/core/things.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');

// The relations of a home as { rel, from: { name, port }, to: { name, port } }, ends named by their things.
const edges = async (homeId, o = {}) => {
  const names = new Map((await db.prepare('SELECT id, name FROM thing WHERE home_id = ?').all(homeId)).map((t) => [Number(t.id), t.name]));
  return (await relationsAt(homeId, { at: null, ...o })).map((r) => ({ rel: r.rel, from: { name: names.get(Number(r.from_id)), port: r.from_port }, to: { name: names.get(Number(r.to_id)), port: r.to_port } }));
};
const mark = async (homeId) => ({
  things: (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(recorded_at), 0) AS r FROM thing WHERE home_id = ?').get(homeId)),
  relations: (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(recorded_at), 0) AS r FROM thing_relation WHERE home_id = ?').get(homeId)),
  versions: (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(recorded_at), 0) AS r FROM thing_attr_version WHERE home_id = ?').get(homeId)),
});

await test('home 1 gets 13 things and 25 relations: ports, places, systems', { skip }, async () => {
  const r = await G.ensureEnergyGraph(1);
  assert.deepEqual([r.created, r.related, r.wired], [8, 25, true]);
  const all = await thingsOf(1);
  assert.equal(all.length, 13, 'the home thing, the four devices and the eight new things');
  const byType = (t) => all.filter((x) => x.type === t);
  for (const t of ['inverter', 'pv_array', 'battery', 'grid_connection', 'home_supply', 'solar_battery', 'outside_wall', 'driveway']) assert.equal(byType(t).length, 1, t);
  assert.equal(byType('solar_battery')[0].kind, 'system');
  const rels = await edges(1);
  const edge = (rel) => rels.filter((x) => x.rel === rel);
  assert.deepEqual(['located_in', 'part_of', 'feeds', 'meters'].map((x) => edge(x).length), [11, 3, 9, 2]);
  const name = (t) => byType(t)[0].name;
  const feeds = edge('feeds').map((x) => `${x.from.name}.${x.from.port}>${x.to.name}.${x.to.port}`).sort();
  assert.deepEqual(feeds, [
    `${name('battery')}.discharge>${name('inverter')}.battery`,
    `${name('grid_connection')}.meter>meter_export.grid`, `${name('grid_connection')}.meter>meter_import.grid`,
    `${name('home_supply')}.out>ev.charge`,
    `${name('inverter')}.ac>${name('home_supply')}.in`, `${name('inverter')}.battery>${name('battery')}.charge`,
    `${name('pv_array')}.dc>${name('inverter')}.pv`,
    'meter_export.load>' + `${name('inverter')}.grid`, 'meter_import.load>' + `${name('inverter')}.grid`,
  ].sort());
  const placeOf = Object.fromEntries(edge('located_in').map((x) => [x.from.name, x.to.name]));
  assert.equal(placeOf.meter_import, 'Outside wall');
  assert.equal(placeOf.meter_gas, 'Outside wall');
  assert.equal(placeOf.ev, 'Driveway');
  for (const t of G.HOME_WIDE) if (byType(t).length) assert.equal(placeOf[byType(t)[0].name], 'GB fixture home', `${t} is at home level, in no room`);
  assert.deepEqual(edge('part_of').map((x) => x.to.name), Array(3).fill('Solar and battery'));
});

await test('running again, and again, writes nothing: no thing, relation or version, no new record time', { skip }, async () => {
  const before = await mark(1);
  for (let i = 0; i < 3; i++) assert.deepEqual(await G.ensureEnergyGraph(1), { created: 0, related: 0, wired: true });
  assert.deepEqual(await mark(1), before);
  const all = await G.ensureAllHomes();
  assert.deepEqual(all.failed, []);
  assert.deepEqual(await mark(1), before);
});

await test('a retired battery is not made again, and a thing that was moved is not put back', { skip }, async () => {
  const battery = (await thingsOf(1, { type: 'battery' }))[0];
  const r = await retireThing(battery.id, { siteId: 1 });
  assert.ok(r.thing.valid_to != null);
  const before = await mark(1);
  await G.ensureEnergyGraph(1);
  assert.deepEqual(await mark(1), before);
  assert.equal((await thingsOf(1, { type: 'battery', at: r.boundary })).length, 0, 'retired: not there from its end');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM thing WHERE home_id = 1 AND type = 'battery'").get()).n, 1);
});

await test('two callers at once make one set of things', async () => {
  const home = await createSite({ name: 'Concurrent home' });
  await addDevice({ siteId: home.id, kind: 'meter_import', provider: 'test', externalRef: 'm1' });
  const [a, b] = await Promise.all([G.ensureEnergyGraph(home.id), G.ensureEnergyGraph(home.id)]);
  assert.equal(a.created + b.created, 3, 'a connection, a supply and an outside wall, once');
  for (const t of ['grid_connection', 'home_supply', 'outside_wall']) assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM thing WHERE home_id = ? AND type = ?').get(home.id, t)).n, 1, t);
});

await test('a home with no evidence stays as it is, and no room is needed for anything', async () => {
  const home = await createSite({ name: 'Bare home' });
  assert.deepEqual(await G.ensureEnergyGraph(home.id), { created: 0, related: 0, wired: true });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM thing WHERE home_id = ?').get(home.id)).n, 1, 'only its home thing');
  assert.equal(await G.ensureEnergyGraph(999999), null, 'no such home');
  const withPlug = await createSite({ name: 'Plug home' });
  await addDevice({ siteId: withPlug.id, kind: 'smart_plug', provider: 'test', externalRef: 'p1' });
  await G.ensureEnergyGraph(withPlug.id);
  const places = await edges(withPlug.id, { rels: ['located_in'] });
  assert.deepEqual(places.map((x) => [x.from.name, x.to.name]), [['smart_plug', 'Plug home']], 'a plug with no room is at home level');
});
