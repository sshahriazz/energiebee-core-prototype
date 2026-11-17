// Who may command a device: a person acting needs a current control right on the home (access.js canControl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { enqueueIfChanged } = await import('../src/core/commands.js');
const { setCapability } = await import('../src/core/plans.js');
const { createUser, grantSite, revokeSite } = await import('../src/core/access.js');

const SITE = 1;
const BASE = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;

await test('a viewer cannot command, an operator can, a revoked operator cannot, the planner (no person) can', { skip }, async () => {
  const device = Number((await db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'sim', 'access-test', 'battery', '{}', 0)").run(SITE)).lastInsertRowid);
  await setCapability(device, 'charge', true, { source: 'adapter' });
  const ask = async (extra) => await enqueueIfChanged({ deviceId: device, desired: { action: 'charge', windowStart: BASE + 600, windowEnd: BASE + 3600, limitPct: 100 }, validFrom: BASE, validUntil: BASE + 7200, now: (BASE - 60) * 1000, ...extra });
  const open = async () => (await db.prepare("SELECT COUNT(*) n FROM command WHERE device_id = ? AND status IN ('pending', 'sent')").get(device)).n;

  const viewer = await createUser({ name: 'viewer' }); await grantSite({ siteId: SITE, userId: viewer, role: 'viewer', scope: 'all', now: 0 });
  await assert.rejects(async () => await ask({ actorUserId: viewer }), (e) => e.code === 'forbidden');
  const stranger = await createUser({ name: 'stranger' });
  await assert.rejects(async () => await ask({ actorUserId: stranger }), (e) => e.code === 'forbidden');
  assert.equal(await open(), 0, 'a refused call writes nothing');

  const operator = await createUser({ name: 'operator' }); await grantSite({ siteId: SITE, userId: operator, role: 'operator', scope: 'all', now: 0 });
  assert.equal((await ask({ actorUserId: operator })).written, true);
  assert.equal(await open(), 1);

  assert.equal(await revokeSite({ siteId: SITE, userId: operator, now: (BASE - 30) * 1000 }), 1);
  await assert.rejects(async () => await ask({ actorUserId: operator, force: true, now: (BASE - 20) * 1000 }), (e) => e.code === 'forbidden', 'revoked: no more commands');
  assert.equal((await ask({ force: true, validUntil: BASE + 7260, now: (BASE - 10) * 1000 })).written, true, 'the planner acts without a person');
});
