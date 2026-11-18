// The four lanes of a timeline (plan 3.8, src/core/lanes.js): actual, forecast, plan and price on the home's one grid, and what the API
// shows of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');
const { buildHomePointSlots } = await import('../src/core/point-slots.js');
const { lanesOf, LANE_NAMES } = await import('../src/core/lanes.js');
const { getThing } = await import('../src/core/things.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { buildSite } = await import('../src/core/build.js');
if (hasLive) await buildSite(1, '2026-10-14', '2026-10-15');   // a few days of stored price slots, as the tariff API test has

const alice = await createUser({ name: 'Alice', role: 'owner' }); await giveHome(alice.id, 1);
const server = app.listen(0); server.unref();
const call = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: { 'x-user-id': String(alice.id) } }); return { status: r.status, body: await r.json() }; };
const thingOf = async (type) => await getThing(Number((await db.prepare("SELECT id FROM thing WHERE home_id = 1 AND type = ? AND superseded_at IS NULL").get(type)).id));

await test('the price lane of a meter: slot by slot on the home\'s grid, with the slot\'s price and fixed charge', { skip }, async () => {
  await ensureEnergyGraph(1);
  const meter = await thingOf('meter_import');
  const first = (await db.prepare('SELECT MIN(slot_start) AS s FROM supply_price_slot WHERE device_id = ?').get(meter.id)).s;
  assert.ok(first, 'the fixture has stored price slots');
  const lanes = await lanesOf(meter, Number(first), Number(first) + 86400, ['price']);
  assert.deepEqual(Object.keys(lanes).sort(), ['grid', 'price']);
  assert.ok(lanes.price.length >= 44 && lanes.price.every((s) => s.dur_s === 1800 && s.unit_inc != null));
  assert.equal(lanes.grid.slot_s, 1800);
});

await test('the forecast lane of the PV array: the forecast of record for each slot, in kWh', { skip }, async () => {
  const array = await thingOf('pv_array');
  const some = await db.prepare(`SELECT MIN(f.start_ts) AS s FROM forecast_fact f JOIN series se ON se.id = f.series_id JOIN point p ON p.id = se.point_id WHERE p.thing_id = ?`).get(array.id);
  assert.ok(some.s, 'the solar forecast sits on the array: its series moved with the plant');
  const lanes = await lanesOf(array, Number(some.s), Number(some.s) + 86400, ['forecast'], { asOfMs: Date.now() + 86400000 });
  assert.ok(lanes.forecast.length >= 1);
  const line = lanes.forecast[0];
  assert.ok(line.slots.length > 10 && line.slots.every((s) => s.value >= 0 && s.issued_at > 0), JSON.stringify(line.slots[0]));
  assert.equal(lanes.actual, undefined, 'only the lanes asked for');
});

await test('lanes through the API; a lane that does not apply is empty, and a bad lane is a 400', { skip }, async () => {
  const meter = await thingOf('meter_import');
  const first = (await db.prepare('SELECT MIN(slot_start) AS s FROM supply_price_slot WHERE device_id = ?').get(meter.id)).s;
  await buildHomePointSlots(1, '2026-10-14', '2026-10-14');
  const r = await call(`/api/things/${meter.uid}/timeline?from=${first}&to=${Number(first) + 86400}&lanes=actual,price,plan,forecast`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.lanes).sort(), ['actual', 'forecast', 'grid', 'plan', 'price']);
  assert.ok(r.body.lanes.price.length > 40);
  assert.deepEqual(r.body.lanes.plan, [], 'no plan for a meter');
  assert.equal((await call(`/api/things/${meter.uid}/timeline?lanes=weather`)).status, 400);
  assert.deepEqual(LANE_NAMES, ['actual', 'forecast', 'plan', 'price']);
});
