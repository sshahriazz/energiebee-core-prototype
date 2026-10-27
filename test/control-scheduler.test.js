// The control scheduler: a tick runs registered drivers only for homes with a command to act on, and one failing
// driver does not stop the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const cmd = hasLive ? await import('../src/core/commands.js') : {};
const plans = hasLive ? await import('../src/core/plans.js') : {};
const { ensureControlChannels } = hasLive ? await import('../src/core/control.js') : {};
const { createSimulatedDriver } = hasLive ? await import('../src/core/executor.js') : {};
const { controlTick, registerControlDriver, registeredDrivers } = hasLive ? await import('../src/jobs/control.js') : {};

const SITE = 1;
const BASE = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;

test('a tick does nothing without drivers or commands, runs a driver for a home with a pending command, and survives a failing driver', { skip }, async () => {
  assert.deepEqual(await controlTick({ now: BASE * 1000 }), [], 'no driver registered: idle');
  db.prepare("INSERT INTO source (code, name, contract) VALUES ('ctl_sim', 'Simulated control', '{}')").run();
  const id = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'sim', 'sched-1', 'battery', '{}', 0)").run(SITE).lastInsertRowid);
  plans.setCapability(id, 'charge', true, { source: 'adapter' });
  ensureControlChannels(SITE, 'ctl_sim', id);
  const driver = createSimulatedDriver({ source: 'ctl_sim' });
  driver.handles = (d) => d.id === id;
  const unregister = registerControlDriver(driver);
  assert.equal(registeredDrivers().length, 1);
  assert.deepEqual(await controlTick({ now: BASE * 1000 }), [], 'a driver but no open command: idle');

  cmd.enqueueIfChanged({ deviceId: id, desired: { action: 'charge', windowStart: BASE + 600, windowEnd: BASE + 3600, limitPct: 100 }, validFrom: BASE, validUntil: BASE + 7200, now: (BASE - 60) * 1000 });
  const bad = { source: 'ctl_bad', read: async () => { throw new Error('device offline'); }, send: async () => ({}) };
  const r = await controlTick({ now: BASE * 1000, driversList: [bad, driver] });
  assert.equal(r.length, 2);
  assert.match(r.find((x) => x.driver === 'ctl_bad').error, /offline|unknown source|ctl_bad/, 'the failing driver is reported, not thrown');
  assert.ok(r.find((x) => x.driver === 'ctl_sim').result.devices[0].did[0].startsWith('sent'), 'the other driver still ran and sent');
  unregister();
  assert.equal(registeredDrivers().length, 0);
});
