// Limits have a ranking (fix list R17): physical > legal > installer > owner > optimiser. A lower source can only tighten a
// higher one, never loosen it, and the core checks the tightest of all of them before anything is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { setCapability } = await import('../src/core/plans.js');
const { setControlLimit, effectiveLimit, checkGates, LIMIT_SOURCES } = await import('../src/core/control.js');

const site = await createSite({ name: 'limits' });
const inv = (await addDevice({ siteId: site.id, kind: 'inverter', provider: 'test', externalRef: 'inv' })).id;
await setCapability(inv, 'export', true, { source: 'adapter' });
const T = 1_800_000_000_000;   // ms
const gates = async (desired, now = T + 1) => (await checkGates({ deviceId: inv, desired: { action: 'export', ...desired }, now })).filter((b) => b.gate === 'limit');

await test('the ranking, strongest first', () => {
  assert.deepEqual(LIMIT_SOURCES, ['physical', 'legal', 'installer', 'owner', 'optimiser']);
});

await test('every source applies at once: the tightest bound wins, and says whose it is', async () => {
  await setControlLimit(inv, { param: 'rate_w', max: 5000, source: 'physical', basis: 'vendor_doc', now: T });
  await setControlLimit(inv, { param: 'rate_w', max: 3680, source: 'legal', basis: 'dno_approval', now: T });   // a G98 export limit
  await setControlLimit(inv, { action: 'export', param: 'rate_w', max: 3000, source: 'owner', now: T });
  const e = await effectiveLimit(inv, 'export', 'rate_w', T + 1);
  assert.deepEqual([e.max, e.maxSource, e.limits], [3000, 'owner', 3]);
  assert.deepEqual(await gates({ rate_w: 2500 }), []);
  const [b] = await gates({ rate_w: 3200 });
  assert.deepEqual([b.detail.max, b.detail.source], [3000, 'owner']);
});

await test('a lower source cannot loosen a higher one, in the database and through the core', async () => {
  await assert.rejects(async () => await setControlLimit(inv, { action: 'export', param: 'rate_w', max: 4000, source: 'owner', now: T + 10 }), /a lower source can only tighten/);
  await assert.rejects(async () => await setControlLimit(inv, { param: 'rate_w', max: 4000, source: 'optimiser', now: T + 10 }), /a lower source can only tighten/);
  assert.equal((await effectiveLimit(inv, 'export', 'rate_w', T + 11)).max, 3000, 'the refused change left the owner\'s limit in force');
  await assert.rejects(async () => await setControlLimit(inv, { param: 'rate_w', max: 1, source: 'nobody' }), /limit source nobody/);
});

await test('a source replaces only its own limit: the owner\'s new limit does not end the legal one', async () => {
  await setControlLimit(inv, { action: 'export', param: 'rate_w', max: 2000, source: 'owner', now: T + 20 });
  const current = await db.prepare('SELECT source, max_value FROM control_limit WHERE device_id = ? AND superseded_at IS NULL ORDER BY max_value').all(inv);
  assert.deepEqual(current.map((r) => [r.source, r.max_value]), [['owner', 2000], ['legal', 3680], ['physical', 5000]]);
  // A higher source tightening below a lower one is allowed: the lower one simply stops binding.
  await setControlLimit(inv, { param: 'rate_w', max: 1500, source: 'legal', now: T + 30 });
  const e = await effectiveLimit(inv, 'export', 'rate_w', T + 31);
  assert.deepEqual([e.max, e.maxSource], [1500, 'legal']);
});

await test('limits that leave no value block every command', async () => {
  await setControlLimit(inv, { action: 'export', param: 'rate_w', min: 1800, source: 'optimiser', now: T + 40 });
  const e = await effectiveLimit(inv, 'export', 'rate_w', T + 41);
  assert.equal(e.conflict, true);
  const [b] = await gates({ rate_w: 1600 }, T + 41);
  assert.equal(b.detail.conflict, true);
});
