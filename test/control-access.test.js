// Who may command a device: a person acting needs a current control right on the home (access.js canControl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { enqueueIfChanged } = hasLive ? await import('../src/core/commands.js') : {};
const { setCapability } = hasLive ? await import('../src/core/plans.js') : {};
const { createUser, grantSite, revokeSite } = hasLive ? await import('../src/core/access.js') : {};

const SITE = 1;
const BASE = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;

test('a viewer cannot command, an operator can, a revoked operator cannot, the planner (no person) can', { skip }, () => {
  const device = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'sim', 'access-test', 'battery', '{}', 0)").run(SITE).lastInsertRowid);
  setCapability(device, 'charge', true, { source: 'adapter' });
  const ask = (extra) => enqueueIfChanged({ deviceId: device, desired: { action: 'charge', windowStart: BASE + 600, windowEnd: BASE + 3600, limitPct: 100 }, validFrom: BASE, validUntil: BASE + 7200, now: (BASE - 60) * 1000, ...extra });
  const open = () => db.prepare("SELECT COUNT(*) n FROM command WHERE device_id = ? AND status IN ('pending', 'sent')").get(device).n;

  const viewer = createUser({ name: 'viewer' }); grantSite({ siteId: SITE, userId: viewer, role: 'viewer', scope: 'all', now: 0 });
  assert.throws(() => ask({ actorUserId: viewer }), (e) => e.code === 'forbidden');
  const stranger = createUser({ name: 'stranger' });
  assert.throws(() => ask({ actorUserId: stranger }), (e) => e.code === 'forbidden');
  assert.equal(open(), 0, 'a refused call writes nothing');

  const operator = createUser({ name: 'operator' }); grantSite({ siteId: SITE, userId: operator, role: 'operator', scope: 'all', now: 0 });
  assert.equal(ask({ actorUserId: operator }).written, true);
  assert.equal(open(), 1);

  assert.equal(revokeSite({ siteId: SITE, userId: operator, now: (BASE - 30) * 1000 }), 1);
  assert.throws(() => ask({ actorUserId: operator, force: true, now: (BASE - 20) * 1000 }), (e) => e.code === 'forbidden', 'revoked: no more commands');
  assert.equal(ask({ force: true, validUntil: BASE + 7260, now: (BASE - 10) * 1000 }).written, true, 'the planner acts without a person');
});
