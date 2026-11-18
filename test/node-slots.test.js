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
const { dayBounds, localDate } = await import('../src/core/time.js');

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
  const DAY = localDate('Europe/London', Math.floor(Date.now() / 1000) - 86400); const [D0] = dayBounds('Europe/London', DAY);
  const living = await createThing({ siteId: home.id, type: 'room', name: 'Living room' });
  const drive = await createThing({ siteId: home.id, type: 'driveway', name: 'Driveway' });
  const plug = await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'test', externalRef: 'n-plug' });
  const car = await addDevice({ siteId: home.id, kind: 'ev_charger', provider: 'test', externalRef: 'n-ev' });
  await relate({ siteId: home.id, from: plug.id, rel: 'located_in', to: living.id });
  await relate({ siteId: home.id, from: car.id, rel: 'located_in', to: drive.id });
  await relate({ siteId: home.id, from: living.id, rel: 'located_in', to: home.id });
  await relate({ siteId: home.id, from: drive.id, rel: 'located_in', to: home.id });
  const p1 = await seriesId('device', plug.id, 'plug_kwh', 'push_native'); const p2 = await seriesId('device', car.id, 'ev_delivered_kwh', 'push_native');
  await asWriter('push_native', async () => {
    await putIntervals(p1, [{ start: D0, end: D0 + 1800, value: 0.2 }, { start: D0 + 1800, end: D0 + 3600, value: 0.3 }]);
    await putIntervals(p2, [{ start: D0, end: D0 + 1800, value: 3 }]);
  });
  await db.prepare(`INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, method_version, built_at, home) VALUES (?, ?, ?, 1800, 0, 'final', 1, 1, 0, 3.5)`).run(home.id, D0, DAY);
  await buildHomePointSlots(home.id, DAY, DAY);
  await buildHomeNodeSlots(home.id, DAY, DAY);
  const at = async (thing, metric) => (await readNodeSlots(thing.id ?? thing, D0, D0 + 86400, [metric])).map((r) => [r.slot_start - D0, r.value, r.state]);
  assert.deepEqual(await at(living, 'energy_kwh'), [[0, 0.2, 'final'], [1800, 0.3, 'final']]);
  assert.deepEqual(await at(drive, 'energy_kwh'), [[0, 3, 'final']]);
  assert.deepEqual((await at(home.id, 'energy_kwh')).slice(0, 2), [[0, 3.2, 'final'], [1800, 0.3, 'partial']], 'each kWh once: the rooms\' devices, not the rooms\' totals on top; the charger is required and said nothing in the second slot');
  const un = await at(home.id, 'untracked_kwh');
  assert.deepEqual(un[0].slice(0, 2), [0, 0.3], '3.5 used, 3.2 tracked');
  assert.equal(await at(living, 'temperature_c').then((r) => r.length), 0, 'no temperature points: no temperature line');
  // rebuilding replaces
  const before = await db.prepare('SELECT COUNT(*) AS n FROM node_slot WHERE thing_id = ?').get(home.id);
  await buildNodeSlots(home.id, DAY, DAY);
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM node_slot WHERE thing_id = ?').get(home.id), before);
});

await test('the heating system: heat out, energy in, COP, flow temperature and degree-hours, slot by slot; the pure ratios', async () => {
  const { heatingRatios } = await import('../src/core/node-slots.js');
  assert.deepEqual(heatingRatios({ heatOut: 3, pumpIn: 1, outdoorC: 5.5, durS: 1800 }), { cop: 3, degreeHours: 5 });
  assert.deepEqual(heatingRatios({ heatOut: 3, pumpIn: 0.0005, outdoorC: 20, durS: 1800 }), { cop: null, degreeHours: 0 }, 'below a watt-hour there is no COP; a warm day has no degree-hours');
  assert.deepEqual(heatingRatios({ heatOut: null, pumpIn: 1, outdoorC: null, durS: 1800 }), { cop: null, degreeHours: null });
  const home = await createSite({ name: 'Heating home', timezone: 'Europe/London', country: 'GB' });
  const DAY2 = localDate('Europe/London', Math.floor(Date.now() / 1000) - 86400); const [E0] = dayBounds('Europe/London', DAY2);
  const hp = await addDevice({ siteId: home.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'h-hp' });
  const sys = await createThing({ siteId: home.id, type: 'heating', name: 'Heating' });
  await relate({ siteId: home.id, from: hp.id, rel: 'part_of', to: sys.id });
  const out = await seriesId('device', hp.id, 'heat_output_kwh', 'push_native'); const inn = await seriesId('device', hp.id, 'heatpump_elec_kwh', 'push_native');
  const flow = await seriesId('device', hp.id, 'heatpump_flow_temp_c', 'push_native'); const outdoor = await seriesId('site', home.id, 'outdoor_temp_c', 'open_meteo');
  await asWriter('push_native', async () => { await putIntervals(out, [{ start: E0, end: E0 + 1800, value: 3 }]); await putIntervals(inn, [{ start: E0, end: E0 + 1800, value: 1 }]); await putReadings(flow, [{ ts: E0, value: 38 }, { ts: E0 + 900, value: 42 }]); });
  await asWriter('open_meteo', async () => { await putReadings(outdoor, [{ ts: E0, value: 5.5 }]); });
  await buildHomePointSlots(home.id, DAY2, DAY2);
  await buildNodeSlots(sys.id, DAY2, DAY2);
  const rows = Object.fromEntries((await readNodeSlots(sys.id, E0, E0 + 1800)).map((r) => [r.metric, r.value]));
  assert.deepEqual([rows.heat_output_kwh, rows.heat_pump_energy_kwh, rows.heating_energy_kwh, rows.cop], [3, 1, 1, 3]);
  assert.ok(rows.flow_temp_c >= 38 && rows.flow_temp_c <= 42, `flow ${rows.flow_temp_c}`);
  assert.equal(rows.degree_hours, 5, '(15.5 - 5.5) x 0.5 h');
});

await test('cost and carbon on each energy line: the slot\'s energy at the slot\'s import price and the grid\'s intensity', async () => {
  const home = await createSite({ name: 'Cost home', timezone: 'Europe/London', country: 'GB' });
  await db.prepare('UPDATE site SET carbon_region = 3 WHERE id = ?').run(home.id);
  const DAY3 = localDate('Europe/London', Math.floor(Date.now() / 1000) - 86400); const [F0] = dayBounds('Europe/London', DAY3);
  const room = await createThing({ siteId: home.id, type: 'room', name: 'Cost room' });
  const plug = await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'test', externalRef: 'cost-plug' });
  await relate({ siteId: home.id, from: plug.id, rel: 'located_in', to: room.id });
  await relate({ siteId: home.id, from: room.id, rel: 'located_in', to: home.id });
  const e = await seriesId('device', plug.id, 'plug_kwh', 'push_native'); const ci = await seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional');
  await asWriter('push_native', async () => { await putIntervals(e, [{ start: F0, end: F0 + 1800, value: 2 }]); });
  await asWriter('carbon_regional', async () => { await putIntervals(ci, [{ start: F0 - 1800, end: F0 + 900, value: 100 }, { start: F0 + 900, end: F0 + 3600, value: 300 }]); });
  await db.prepare(`INSERT INTO supply_price_slot (site_id, point, slot_start, dur_s, unit_inc, fixed_inc, lineage, stamp, built_at) VALUES (?, 'meter_import', ?, 1800, 25, 0, '{}'::jsonb, 'x', 0)`).run(home.id, F0);
  await buildHomePointSlots(home.id, DAY3, DAY3);
  await buildHomeNodeSlots(home.id, DAY3, DAY3);
  const get = async (thing, metric) => (await readNodeSlots(thing, F0, F0 + 1800, [metric]))[0];
  assert.equal((await get(room.id, 'energy_kwh')).value, 2);
  assert.equal((await get(room.id, 'energy_cost_minor')).value, 50, '2 kWh at 25 minor units');
  assert.equal((await get(room.id, 'energy_carbon_g')).value, 400, '2 kWh at 200 g/kWh: the slot is 900 s at 100 and 900 s at 300');
});

await test('what was in a place at a time: placements that end and begin split the window into segments (pure)', async () => {
  const { membershipOver } = await import('../src/core/node-slots.js');
  const edges = [{ from: 2, to: 1, required: 1, vf: 0, vt: 100 }, { from: 2, to: 3, required: 1, vf: 100, vt: null }, { from: 3, to: 9, required: 1, vf: null, vt: null }, { from: 4, to: 1, required: 0, vf: null, vt: null }];
  const seg = membershipOver(1, edges, 0, 200);
  assert.deepEqual(seg.map((s) => [s.from, [...s.members]]), [[0, [[2, true], [4, false]]], [100, [[4, false]]]], 'the plug is in place 1 until 100, then it is in place 3');
  assert.deepEqual(membershipOver(3, edges, 0, 200).map((s) => [s.from, [...s.members.keys()]]), [[0, []], [100, [2]]]);
});
