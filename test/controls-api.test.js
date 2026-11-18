// The control API (plan 4.1 to 4.4 and 4.6, src/routes/controls.js) over HTTP: what a thing can be asked, a manual request that wins and
// can be cancelled, a request on a room, scenes with a schedule; by uid only, and another owner's home is a 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createThing, relate } = await import('../src/core/things.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const plans = await import('../src/core/plans.js');

const home = await createSite({ name: 'Control API home', isDemo: true });
const other = await createSite({ name: 'Somebody else', isDemo: true });
const alice = await createUser({ name: 'Alice', role: 'owner' }); await giveHome(alice.id, home.id);
const bob = await createUser({ name: 'Bob', role: 'owner' }); await giveHome(bob.id, other.id);
const garage = await createThing({ siteId: home.id, type: 'garage', name: 'Garage' });
const plug = (await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'synthetic', externalRef: 'api-plug' })).id;
const plug2 = (await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'synthetic', externalRef: 'api-plug-2' })).id;
for (const id of [plug, plug2]) { await relate({ siteId: home.id, from: id, rel: 'located_in', to: garage.id }); for (const a of ['on', 'off']) await plans.setCapability(id, a, true, { source: 'adapter' }); }
await relate({ siteId: home.id, from: garage.id, rel: 'located_in', to: home.id });
const uid = async (id) => (await db.prepare('SELECT uid FROM thing WHERE id = ?').get(id)).uid;
const server = app.listen(0); server.unref();
async function call(path, user, { method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': String(user.id) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), text };
}
const noIds = (v) => { if (Array.isArray(v)) v.forEach(noIds); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!['id', 'home_id', 'thing_id', 'request_id'].includes(k), `${k} is an integer id`); noIds(x); } };

await test('what a thing can be asked, and a manual request that becomes a command and can be cancelled', async () => {
  const p = await uid(plug);
  const c = await call(`/api/things/${p}/controls`, alice);
  assert.equal(c.status, 200); noIds(c.body);
  assert.deepEqual(c.body.actions.map((a) => [a.action, a.confirmed]).sort(), [['off', true], ['on', true]]);
  const r = await call(`/api/things/${p}/requests`, alice, { method: 'POST', body: { capability: 'on_off', action: 'on', forS: 1800, note: 'for the test' } });
  assert.equal(r.status, 201); noIds(r.body);
  assert.deepEqual([r.body.request.priority, r.body.written, r.body.winner === r.body.request.uid], ['manual', true, true]);
  assert.equal((await call(`/api/things/${p}/controls`, alice)).body.requests.length, 1);
  const cancelled = await call(`/api/requests/${r.body.request.uid}/cancel`, alice, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 200);
  assert.ok(cancelled.body.request.cancelled_at > 0 && cancelled.body.winner === null);
  const again = await call(`/api/requests/${r.body.request.uid}/cancel`, alice, { method: 'POST', body: {} });
  assert.equal(again.status, 200, 'cancelling twice is the same answer');
});

await test('a bad request is a 400 with only error and code; a person cannot make a non-manual one', async () => {
  const p = await uid(plug);
  for (const b of [{ capability: 'on_off', action: 'melt' }, { capability: 'thermostat', action: 'on' }, { capability: 'on_off', action: 'on', validFrom: 100, validUntil: 50 }, { action: 'on' }, { capability: 'on_off', action: 'on', forS: 99999999 }]) {
    const r = await call(`/api/things/${p}/requests`, alice, { method: 'POST', body: b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error']);
  }
  const opt = await call(`/api/things/${p}/requests`, alice, { method: 'POST', body: { capability: 'on_off', action: 'on', priority: 'optimiser' } });
  assert.deepEqual([opt.status, opt.body.code], [400, 'read_only_kind']);
});

await test('a request on the garage reaches both plugs; the result names each by uid', async () => {
  const g = await uid(garage.id);
  const r = await call(`/api/things/${g}/group`, alice, { method: 'POST', body: { capability: 'on_off', action: 'off', forS: 600 } });
  assert.equal(r.status, 201); noIds(r.body);
  assert.deepEqual(r.body.members.map((m) => m.status), ['enqueued', 'enqueued']);
  assert.ok(r.body.members.every((m) => /^[0-9a-f-]{36}$/.test(m.thing)));
});

await test('scenes: made, scheduled and applied through the API', async () => {
  const h = await uid(home.id); const p = await uid(plug); const g = await uid(garage.id);
  const made = await call(`/api/homes/${h}/scenes`, alice, { method: 'POST', body: { name: 'Away', items: [{ thing: p, capability: 'on_off', action: 'off' }, { thing: g, capability: 'on_off', action: 'off' }] } });
  assert.equal(made.status, 201); noIds(made.body);
  assert.equal(made.body.scene.items.length, 2);
  const sc = made.body.scene.uid;
  const sched = await call(`/api/scenes/${sc}/schedules`, alice, { method: 'POST', body: { weekdays: [1, 2, 3, 4, 5], fromMin: 480, untilMin: 1020 } });
  assert.equal(sched.status, 201);
  assert.equal(sched.body.scene.schedules[0].fromMin, 480);
  assert.equal((await call(`/api/scenes/${sc}/schedules`, alice, { method: 'POST', body: { weekdays: [9], fromMin: 1, untilMin: 2 } })).status, 400);
  const applied = await call(`/api/scenes/${sc}/apply`, alice, { method: 'POST', body: { forS: 3600 } });
  assert.equal(applied.status, 200); noIds(applied.body);
  assert.equal(applied.body.items.length, 2);
  assert.equal((await call(`/api/homes/${h}/scenes`, alice)).body.scenes.length, 1);
});

await test('another owner sees none of it: the same 404 as a uid that does not exist', async () => {
  const p = await uid(plug); const h = await uid(home.id);
  const missing = (await call('/api/things/01900000-0000-7000-8000-00000000dead/controls', bob)).text;
  for (const [m, path, body] of [['GET', `/api/things/${p}/controls`], ['POST', `/api/things/${p}/requests`, { capability: 'on_off', action: 'on' }], ['POST', `/api/things/${p}/group`, { capability: 'on_off', action: 'on' }],
    ['GET', `/api/homes/${h}/scenes`], ['POST', `/api/homes/${h}/scenes`, { name: 'x', items: [{ thing: p, capability: 'on_off', action: 'on' }] }]]) {
    const r = await call(path, bob, { method: m, body });
    assert.equal(r.status, 404, `${m} ${path}`);
  }
  assert.equal(missing, (await call(`/api/things/${p}/controls`, bob)).text);
});
