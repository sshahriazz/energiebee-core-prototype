// Controls on every thing (plan 4.1 to 4.4 and 4.6, src/core/controls.js): what a thing may be asked, which request wins and when a lower
// one returns, external changes that are not reverted, a request on a room that reaches every capable member through its own limits,
// and scenes with their schedules. A temp database; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createThing, relate, updateThing } = await import('../src/core/things.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const C = await import('../src/core/controls.js');
const { setControlLimit } = await import('../src/core/control.js');
const plans = await import('../src/core/plans.js');

const home = await createSite({ name: 'Controls home', isDemo: true });
const NOW = Date.UTC(2026, 10, 18, 10, 0) ; const at = NOW / 1000;
const dev = async (kind, ref) => (await addDevice({ siteId: home.id, kind, provider: 'synthetic', externalRef: ref })).id;
const garage = await createThing({ siteId: home.id, type: 'garage', name: 'Garage' });
const plugA = await dev('smart_plug', 'c-plug-a'); const plugB = await dev('smart_plug', 'c-plug-b'); const bat = await dev('battery', 'c-bat'); const stat = await dev('thermostat', 'c-stat');
for (const [id, to] of [[plugA, garage.id], [plugB, garage.id], [garage.id, home.id], [stat, garage.id], [bat, home.id]]) await relate({ siteId: home.id, from: id, rel: 'located_in', to });
for (const [id, action] of [[plugA, 'on'], [plugA, 'off'], [plugB, 'on'], [plugB, 'off'], [bat, 'charge'], [bat, 'demand'], [stat, 'set_target_temp']]) await plans.setCapability(id, action, true, { source: 'adapter' });
const ask = (o) => C.submitRequest({ validFrom: at, validUntil: at + 3600, source: 'test', now: NOW, ...o });

await test('what a thing may be asked: the actions of its capabilities, and which of them the device is confirmed to deliver', async () => {
  const a = await C.actionsOf(plugA);
  assert.deepEqual(a.map((x) => [x.capability, x.action, x.confirmed]).sort(), [['on_off', 'off', true], ['on_off', 'on', true]]);
  const b = await C.actionsOf(bat);
  assert.ok(b.some((x) => x.action === 'charge' && x.confirmed) && b.some((x) => x.action === 'hold' && !x.confirmed), 'hold is allowed by the capability but the device was never confirmed for it');
});

await test('the winner: the highest priority, the newest among equals, and a lower one returns when it ends (pure)', () => {
  const r = (id, priority, from, until, created = id, cancelled = null) => ({ id, priority, valid_from: from, valid_until: until, created_at: created, cancelled_at: cancelled });
  const list = [r(1, 'optimiser', 0, 100), r(2, 'manual', 10, 50), r(3, 'schedule', 0, 100), r(4, 'manual', 20, 60, 9), r(5, 'safety', 30, 40)];
  assert.equal(C.pickWinner(list, 5).id, 3, 'the schedule beats the optimiser');
  assert.equal(C.pickWinner(list, 15).id, 2, 'a manual request beats both');
  assert.equal(C.pickWinner(list, 25).id, 4, 'the newer of two manual requests');
  assert.equal(C.pickWinner(list, 35).id, 5, 'safety beats everything');
  assert.equal(C.pickWinner(list, 55).id, 4);
  assert.equal(C.pickWinner(list, 70).id, 3, 'when the manual ones end the schedule returns');
  assert.equal(C.pickWinner([r(1, 'manual', 0, 10, 1, 5)], 3), null, 'a cancelled request does not count');
  assert.equal(C.pickWinner(list, 200), null);
  assert.equal(C.nextChange(list, 15), 20);
  assert.equal(C.nextChange(list, 61), 100);
});

await test('a request needs a thing with the capability, an action it allows, a reason and a window; a thing run by an external controller takes only manual ones', async () => {
  await assert.rejects(() => ask({ thingId: plugA, capability: 'battery_storage', action: 'charge' }), /has no capability battery_storage/);
  await assert.rejects(() => ask({ thingId: plugA, capability: 'on_off', action: 'explode' }), /does not allow explode/);
  await assert.rejects(() => ask({ thingId: plugA, capability: 'on_off', action: 'on', validUntil: at - 1 }), /after validFrom/);
  await assert.rejects(() => ask({ thingId: plugA, capability: 'on_off', action: 'on', source: ' ' }), /who asked/);
  await assert.rejects(() => ask({ thingId: plugA, capability: 'on_off', action: 'on', priority: 'whenever' }), /priority is one of/);
  await updateThing(bat, { siteId: home.id, attrs: { external_controller: 'Octopus Intelligent Go' } });
  await assert.rejects(() => ask({ thingId: bat, capability: 'battery_storage', action: 'charge', priority: 'optimiser' }), /run by Octopus Intelligent Go/);
  assert.ok(await ask({ thingId: bat, capability: 'battery_storage', action: 'charge', priority: 'manual' }), 'a person may still ask');
  const nobody = (await createUser({ name: 'Nobody' })).id;
  await assert.rejects(() => ask({ thingId: plugA, capability: 'on_off', action: 'on', actorUserId: nobody }), /may not control/);
  await giveHome(nobody, home.id);
  await db.prepare("INSERT INTO site_grant (user_id, site_id, role, scope, recorded_at) VALUES (?, ?, 'owner', 'all', 0)").run(nobody, home.id).catch(() => null);
});

await test('a manual request beats the optimiser and expires correctly: the optimiser returns, and a cancelled request counts no more', async () => {
  const opt = await ask({ thingId: plugB, capability: 'on_off', action: 'on', priority: 'optimiser', validUntil: at + 7200 });
  let s = await C.settle(plugB, 'on_off', { now: NOW });
  assert.deepEqual([s.winner.id, s.written, s.command.desired.action], [opt.id, true, 'on']);
  const man = await ask({ thingId: plugB, capability: 'on_off', action: 'off', priority: 'manual', validUntil: at + 1800 });
  s = await C.settle(plugB, 'on_off', { now: NOW + 60_000 });
  assert.deepEqual([s.winner.id, s.written, s.command.desired.action], [man.id, true, 'off'], 'the manual request wins and cancels the open command');
  assert.equal((await db.prepare('SELECT request_id FROM command WHERE id = ?').get(s.command.id)).request_id, man.id, 'the command knows the request it came from');
  s = await C.settle(plugB, 'on_off', { now: NOW + 120_000 });
  assert.equal(s.reason, 'pending_same', 'asking again changes nothing');
  s = await C.settle(plugB, 'on_off', { now: NOW + 1900 * 1000 });
  assert.deepEqual([s.winner.id, s.written, s.command.desired.action], [opt.id, true, 'on'], 'the manual request ran out: the optimiser returns');
  const m2 = await ask({ thingId: plugB, capability: 'on_off', action: 'off', priority: 'manual', now: NOW + 2000 * 1000, validFrom: at + 2000, validUntil: at + 3000 });
  await C.cancelRequest(m2.id, { now: NOW + 2100 * 1000 });
  assert.equal((await C.settle(plugB, 'on_off', { now: NOW + 2200 * 1000 })).winner.id, opt.id, 'a cancelled request counts no more');
  await assert.rejects(() => db.prepare("UPDATE control_request SET priority = 'safety' WHERE id = ?").run(opt.id), /never changes/);
  assert.equal((await C.settleAll({ now: NOW + 2200 * 1000 })).some((o) => o.thingId === plugB), true);
});

await test('an external change is a manual request that nothing reverts before it expires, and shows as one', async () => {
  const ext = await C.recordExternalChange({ thingId: stat, capability: 'thermostat', action: 'set_target_temp', desired: { setpointC: 24 }, forS: 1800, now: NOW });
  assert.deepEqual([ext.external, ext.priority, ext.source], [1, 'manual', 'external']);
  const optimiser = await ask({ thingId: stat, capability: 'thermostat', action: 'set_target_temp', desired: { setpointC: 19 }, priority: 'optimiser', validUntil: at + 20000 });
  let s = await C.settle(stat, 'thermostat', { now: NOW + 60_000 });
  assert.deepEqual([s.external, s.written], [true, false], 'nothing is sent, nothing is reverted');
  s = await C.settle(stat, 'thermostat', { now: NOW + 1900 * 1000 });
  assert.deepEqual([s.winner.id, s.written, s.command.desired.setpoint_c], [optimiser.id, true, 19], 'after it expires the optimiser takes over again');
  // a change nobody here made, seen in what the device reports
  const seen = await C.noticeExternalChange({ thingId: stat, capability: 'thermostat', reported: { action: 'set_target_temp', setpoint_c: 23 }, now: NOW + 5000 * 1000 });
  assert.equal(seen, null, 'a command is open: the difference is ours to settle first');
  await db.prepare("UPDATE command SET status = 'cancelled' WHERE device_id = ?").run(stat);
  const seen2 = await C.noticeExternalChange({ thingId: stat, capability: 'thermostat', reported: { action: 'set_target_temp', setpoint_c: 23 }, now: NOW + 9000 * 1000 });
  assert.ok(seen2 && seen2.external === 1 && seen2.desired.setpoint_c === 23, 'recorded as an external change');
  assert.equal(await C.noticeExternalChange({ thingId: stat, capability: 'thermostat', reported: { action: 'set_target_temp', setpoint_c: 23 }, now: NOW + 9100 * 1000 }), null, 'the device runs what the request says');
});

await test('a limit on a place binds what is in it; a request on the garage reaches every capable member, each through its own limits', async () => {
  await setControlLimit(garage.id, { action: 'set_target_temp', param: 'setpoint_c', min: 16, max: 22, source: 'owner' });
  const g = await C.groupRequest({ placeId: garage.id, capability: 'thermostat', action: 'set_target_temp', desired: { setpointC: 30 }, validFrom: at + 8000, validUntil: at + 9000, source: 'test', now: NOW + 8000 * 1000 });
  assert.deepEqual(g.members.map((m) => [m.name, m.status]), [['thermostat', 'blocked']], 'the garage\'s comfort range holds the thermostat in it');
  assert.equal(g.members[0].blocks[0].gate, 'limit');
  const ok = await C.groupRequest({ placeId: garage.id, capability: 'on_off', action: 'off', validFrom: at + 8000, validUntil: at + 9000, source: 'test', now: NOW + 8000 * 1000 });
  assert.deepEqual(ok.members.map((m) => [m.type, m.status]).sort(), [['smart_plug', 'enqueued'], ['smart_plug', 'enqueued']]);
  assert.ok(ok.members.every((m) => m.requestId) && /^[0-9a-f-]{36}$/.test(ok.group), 'the requests of one command share a group');
  const again = await C.groupRequest({ placeId: garage.id, capability: 'on_off', action: 'off', validFrom: at + 8000, validUntil: at + 9000, source: 'test', now: NOW + 8001 * 1000 });
  assert.ok(again.members.every((m) => m.status === 'unchanged'), 'asking again reaches nobody twice');
  assert.deepEqual((await C.capableMembers(home.id, 'battery_storage', 'charge')).map((m) => m.type), ['battery'], 'the home holds the garage, and the battery is in it too');
});

await test('a sum limit holds the members together: over it, nobody under the place is sent anything', async () => {
  await db.prepare("INSERT INTO control_limit (device_id, action, param, max_value, source, aggregate, valid_from, recorded_at) VALUES (?, 'set_current', 'current_a', 32, 'installer', 'sum', 0, 0)").run(garage.id);
  const chargerA = await dev('ev_charger', 'c-evc-a'); const chargerB = await dev('ev_charger', 'c-evc-b');
  for (const id of [chargerA, chargerB]) { await relate({ siteId: home.id, from: id, rel: 'located_in', to: garage.id }); await plans.setCapability(id, 'set_current', true, { source: 'adapter' }); }
  const two = await C.groupRequest({ placeId: garage.id, capability: 'ev_charging', action: 'set_current', desired: { currentA: 20 }, validFrom: at + 8000, validUntil: at + 9000, source: 'test', now: NOW + 8000 * 1000 });
  assert.deepEqual(two.members.map((m) => m.status), ['blocked', 'blocked'], '2 x 20 A is over 32 A');
  assert.equal(two.members[0].blocks[0].gate, 'sum_limit');
  const fits = await C.groupRequest({ placeId: garage.id, capability: 'ev_charging', action: 'set_current', desired: { currentA: 16 }, validFrom: at + 8000, validUntil: at + 9000, source: 'test', now: NOW + 8000 * 1000 });
  assert.deepEqual(fits.members.map((m) => m.status), ['enqueued', 'enqueued'], '2 x 16 A is 32 A');
});

await test('scenes: named sets of requests, applied at the priority of a schedule, with the windows they are asked for', async () => {
  const sc = await C.saveScene({ homeId: home.id, name: 'Evening', items: [{ thingId: plugA, capability: 'on_off', action: 'off', desired: {} }, { thingId: garage.id, capability: 'on_off', action: 'off', desired: {} }], now: NOW });
  assert.equal(sc.items.length, 2);
  assert.equal((await C.saveScene({ homeId: home.id, name: 'Evening', items: [{ thingId: plugA, capability: 'on_off', action: 'on', desired: {} }] })).items.length, 1, 'the same name replaces its items');
  await assert.rejects(() => C.saveScene({ homeId: home.id, name: 'Bad', items: [{ thingId: plugA, capability: 'on_off', action: 'melt', desired: {} }] }), /does not allow melt/);
  const applied = await C.applyScene(sc.id, { validFrom: at + 20000, validUntil: at + 21000, now: NOW + 20000 * 1000 });
  assert.equal(applied.items.length, 1);
  assert.equal((await db.prepare("SELECT priority FROM control_request WHERE source = ?").get(`scene:${sc.id}`)).priority, 'schedule');
  const withSchedule = await C.scheduleScene(sc.id, { weekdays: [3, 1, 3], fromMin: 18 * 60, untilMin: 22 * 60 });
  assert.deepEqual(withSchedule.schedules.map((s) => [s.weekdays, s.fromMin, s.untilMin]), [[[1, 3], 1080, 1320]]);
  const w = C.scheduleWindows(withSchedule.schedules[0], 'Europe/London', '2026-11-16', '2026-11-22');
  assert.deepEqual(w.map((x) => x.date), ['2026-11-16', '2026-11-18'], 'Monday and Wednesday');
  assert.equal(w[0].until - w[0].from, 4 * 3600);
});
