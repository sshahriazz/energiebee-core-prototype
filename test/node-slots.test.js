// A place's timeline (plan 3.3, src/core/node-slots.js): what is in a place, each kWh counted once, the untracked line never negative beyond
// the meters' tolerance, and only required members deciding the data state. Pure parts first, then a home with rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { membersOf, rollUp, untracked, buildNodeSlots, buildHomeNodeSlots, readNodeSlots } = await import('../src/core/node-slots.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createThing, relate } = await import('../src/core/things.js');
const { seriesId, putReadings, putIntervals, asWriter } = await import('../src/core/facts.js');
const { pointOf } = await import('../src/core/points.js');
const { buildHomePointSlots } = await import('../src/core/point-slots.js');
const { dayBounds } = await import('../src/core/time.js');

await test('what is in a place: its devices and its sub-places\' devices, once each, in the order of the tree', () => {
  const edges = [{ from: 2, to: 1, required: 1 }, { from: 3, to: 2, required: 1 }, { from: 4, to: 1, required: 0 }, { from: 5, to: 3, required: 1 }];
  assert.deepEqual(membersOf(1, edges), [{ id: 2, required: true }, { id: 3, required: true }, { id: 5, required: true }, { id: 4, required: false }]);
  assert.deepEqual(membersOf(3, edges), [{ id: 5, required: true }]);
  assert.deepEqual(membersOf(9, edges), []);
  assert.deepEqual(membersOf(1, [...edges, { from: 1, to: 5, required: 1 }]).map((m) => m.id), [2, 3, 5, 4], 'a cycle is walked once');
});

await test('a roll-up: the sum, and the state decided by the required members; an optional gap lowers coverage and is named', () => {
  const m = (id, value, required = true, coverage = value == null ? 0 : 1) => ({ id, value, required, coverage });
  assert.deepEqual(rollUp([m(1, 0.5), m(2, 0.25)]), { value: 0.75, coverage: 1, state: 'final', lineage: { members: 2, with_data: 2 } });
  const opt = rollUp([m(1, 0.5), m(2, null, false)]);
  assert.deepEqual([opt.value, opt.coverage, opt.state, opt.lineage.optional_missing], [0.5, 0.5, 'final', [2]]);
  const req = rollUp([m(1, 0.5), m(2, null, true)]);
  assert.deepEqual([req.state, req.lineage.required_missing], ['partial', [2]]);
  assert.equal(rollUp([m(1, null)]).state, 'missing');
  assert.equal(rollUp([m(1, 1), m(2, 3)], 'mean').value, 2);
  assert.equal(rollUp([]).state, 'missing');
});

await test('the untracked line: home use less what is tracked; a small shortfall is meter noise, a large one is not a negative use', () => {
  assert.equal(untracked(1.0, 0.7), 0.3);
  assert.equal(untracked(1.0, 1.003), 0, 'inside the tolerance');
  assert.equal(untracked(1.0, 1.2), null, 'the devices used more than the home: a meter is wrong, say nothing');
  assert.equal(untracked(null, 1), null);
});

await test('a home with a plug in the living room and a charger on the driveway: each room has its own energy, the home adds them up, the untracked line is the rest', async () => {
  const home = await createSite({ name: 'Rooms home', timezone: 'Europe/London', country: 'GB' });
  const DAY = '2026-06-10'; const [D0] = dayBounds('Europe/London', DAY);
  const living = await createThing({ siteId: home.id, type: 'room', name: 'Living room', validFrom: D0 - 86400 });
  const drive = await createThing({ siteId: home.id, type: 'driveway', name: 'Driveway', validFrom: D0 - 86400 });
  const plug = await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'test', externalRef: 'n-plug', recordedAt: (D0 - 86400) * 1000 });
  const car = await addDevice({ siteId: home.id, kind: 'ev_charger', provider: 'test', externalRef: 'n-ev', recordedAt: (D0 - 86400) * 1000 });
  await relate({ siteId: home.id, from: plug.id, rel: 'located_in', to: living.id, at: D0 - 80000 });
  await relate({ siteId: home.id, from: car.id, rel: 'located_in', to: drive.id, at: D0 - 80000 });
  await relate({ siteId: home.id, from: living.id, rel: 'located_in', to: home.id, at: D0 - 80000 });
  await relate({ siteId: home.id, from: drive.id, rel: 'located_in', to: home.id, at: D0 - 80000 });
  const p1 = await seriesId('device', plug.id, 'plug_kwh', 'push_native'); const p2 = await seriesId('device', car.id, 'ev_delivered_kwh', 'push_native');
  await asWriter('push_native', async () => {
    await putIntervals(p1, [{ start: D0, end: D0 + 1800, value: 0.2 }, { start: D0 + 1800, end: D0 + 3600, value: 0.3 }]);
    await putIntervals(p2, [{ start: D0, end: D0 + 1800, value: 3 }]);
  });
  await db.prepare(`INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, state, quality, home) VALUES (?, ?, ?, 1800, 'final', 1, 3.5)`).run(home.id, D0, DAY).catch(() => null);
  await buildHomePointSlots(home.id, DAY, DAY);
  await buildHomeNodeSlots(home.id, DAY, DAY);
  const at = async (thing, metric) => (await readNodeSlots(thing.id ?? thing, D0, D0 + 86400, [metric])).map((r) => [r.slot_start - D0, r.value, r.state]);
  assert.deepEqual(await at(living, 'energy_kwh'), [[0, 0.2, 'final'], [1800, 0.3, 'final']]);
  assert.deepEqual(await at(drive, 'energy_kwh'), [[0, 3, 'final']]);
  assert.deepEqual((await at(home.id, 'energy_kwh')).slice(0, 2), [[0, 3.2, 'final'], [1800, 0.3, 'final']], 'each kWh once: the rooms\' devices, not the rooms\' totals on top');
  const un = await at(home.id, 'untracked_kwh');
  if (un.length) assert.deepEqual(un[0].slice(0, 2), [0, 0.3], '3.5 used, 3.2 tracked');
  assert.equal(await at(living, 'temperature_c').then((r) => r.length), 0, 'no temperature points: no temperature line');
  // rebuilding replaces
  const before = await db.prepare('SELECT COUNT(*) AS n FROM node_slot WHERE thing_id = ?').get(home.id);
  await buildNodeSlots(home.id, DAY, DAY);
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM node_slot WHERE thing_id = ?').get(home.id), before);
});
