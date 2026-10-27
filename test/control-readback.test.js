// Stage 4 on a copy of the frozen real GB home: a command from enqueue to a verified effect, with a simulated device.
// Times are an hour or more ahead of the real clock, so facts written now are already known at the cycle's clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const cmd = hasLive ? await import('../src/core/commands.js') : {};
const plans = hasLive ? await import('../src/core/plans.js') : {};
const { ensureControlChannels, setControlLimit } = hasLive ? await import('../src/core/control.js') : {};
const { runControlCycle, createSimulatedDriver } = hasLive ? await import('../src/core/executor.js') : {};
const { seriesId, putReadings } = hasLive ? await import('../src/core/facts.js') : {};

const SITE = 1;
const BASE = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;   // a half-hour boundary two hours ahead (s)
const ms = (s) => s * 1000;
if (hasLive) db.prepare("INSERT INTO source (code, name, contract) VALUES ('ctl_sim', 'Simulated control', '{}')").run();
let n = 0;

// A battery of its own for each test (one open command per device), with the actions it can deliver.
function newBattery(sim = {}, caps = { charge: 'adapter', export: 'adapter', demand: 'adapter' }) {
  const id = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'sim', ?, 'battery', '{}', 0)").run(SITE, `sim-${++n}`).lastInsertRowid);
  for (const [a, source] of Object.entries(caps)) plans.setCapability(id, a, true, { source });
  ensureControlChannels(SITE, 'ctl_sim', id);
  const driver = createSimulatedDriver({ source: 'ctl_sim', ...sim });
  driver.handles = (d) => d.id === id;
  return { id, driver, device: db.prepare('SELECT * FROM device WHERE id = ?').get(id) };
}
const charge = (extra = {}) => ({ action: 'charge', windowStart: BASE + 600, windowEnd: BASE + 3600, limitPct: 100, mode: 'timed_charge', ...extra });
const enqueue = (deviceId, desired, extra = {}) => cmd.enqueueIfChanged({ deviceId, desired, validFrom: BASE, validUntil: BASE + 7200, now: ms(BASE) - 60000, ...extra });
const events = (id) => cmd.commandLog(id).map((e) => e.detail?.state ?? e.event);
// Each test's driver handles only its own battery, as a vendor's driver would.
const cycle = (driver, atS, o = {}) => runControlCycle(SITE, { driver, now: ms(atS), ...o });
const chargingTelemetry = (from, to, w) => putReadings(seriesId('site', SITE, 'battery_charge_w', 'sunsynk_5min'), Array.from({ length: (to - from) / 300 }, (_, i) => ({ ts: from + i * 300, value: w })));

test('happy path: enqueue, send, read back, acked, and the effect verified in telemetry', { skip }, async () => {
  const b = newBattery();
  const r = enqueue(b.id, charge());
  assert.equal(r.written, true);
  const id = r.command.id;
  const c1 = await cycle(b.driver, BASE);
  assert.deepEqual(c1.devices[0].did, [`sent ${id}`]);
  assert.equal(b.driver.writes.length, 1);
  assert.equal(cmd.getCommand(id).ack_ref, 'ref-1', 'the vendor receipt is kept');
  const c2 = await cycle(b.driver, BASE + 120);
  assert.deepEqual(c2.devices[0].did, [`acked ${id}`], 'acked because the device itself reports the desired state');
  assert.equal(cmd.getCommand(id).reported.action, 'charge');
  assert.equal(cmd.getCommand(id).verify_status, null, 'not checked before the check period has ended');
  assert.deepEqual((await cycle(b.driver, BASE + 700)).devices[0].did, [], 'the check period (window start + 300 s, 300 s long) has not ended');
  chargingTelemetry(BASE + 900, BASE + 1200, 2500);
  const c3 = await cycle(b.driver, BASE + 1300);
  assert.deepEqual(c3.devices[0].did, [`verified ${id}`]);
  const done = cmd.getCommand(id);
  assert.deepEqual([done.status, done.verify_status, b.driver.writes.length], ['acked', 'verified', 1]);
  assert.ok(events(id).includes('unverifiable_fields'), 'the mode label has no state point: said so, not guessed');
  assert.deepEqual(events(id).filter((e) => ['enqueued', 'sent', 'acked', 'verified'].includes(e)), ['enqueued', 'sent', 'acked', 'verified']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id WHERE so.code = ? AND s.metric_id IN (SELECT id FROM metric WHERE code LIKE ?)').get('ctl_sim', '%ack%').n, 0, 'no ack was stored as a fact');
});

test('a device that already runs the state: skipped_unchanged, nothing is written to it', { skip }, async () => {
  const b = newBattery();
  const tz = 'Europe/London';
  const d = charge();
  b.driver.settings.work_mode = 1; b.driver.settings.charge_target_soc = 100;
  b.driver.settings.charge_window_start_min = b.driver.minuteOfDay(d.windowStart, tz); b.driver.settings.charge_window_end_min = b.driver.minuteOfDay(d.windowEnd, tz);
  const id = enqueue(b.id, d).command.id;
  const out = await cycle(b.driver, BASE);
  assert.deepEqual(out.devices[0].did, [`skipped_unchanged ${id}`]);
  assert.deepEqual([b.driver.writes.length, cmd.getCommand(id).status], [0, 'skipped_unchanged']);
});

test('late ack: a command that expired before the device applied it is recorded as applied late, not lost', { skip }, async () => {
  const b = newBattery({ applyAfterMs: 600000 });
  const r = enqueue(b.id, charge(), { validUntil: BASE + 300 });
  const id = r.command.id;
  await cycle(b.driver, BASE + 10);                                   // sent; the device will apply it 10 minutes later
  assert.equal(cmd.getCommand(id).status, 'sent');
  const c2 = await cycle(b.driver, BASE + 400);                       // past valid_until: expired, and the device has not applied it yet
  assert.deepEqual(c2.expired, [id]);
  assert.equal(cmd.getCommand(id).applied_late_at, null);
  b.driver.acks.push({ ref: 'ref-late', commandId: id });
  const c3 = await cycle(b.driver, BASE + 700);                       // the device has now applied it, and sends its receipt
  assert.ok(c3.devices[0].did.includes(`applied_late ${id}`));
  const c = cmd.getCommand(id);
  assert.deepEqual([c.status, c.applied_late_at != null, c.ack_ref], ['expired', true, 'ref-1'], 'the first receipt is kept');
  assert.ok(events(id).includes('applied_late') && events(id).includes('ack_received'));
  assert.equal(cmd.commandLog(id).filter((e) => e.detail?.state === 'ack_received').at(-1).detail.after_expiry, true, 'the receipt that came after expiry is logged as such');
  assert.equal(cmd.markAppliedLate(id, { reported: c.reported }).appliedLate, false, 'recorded once');
  assert.equal(b.driver.writes.length, 1, 'never sent a second time');
});

test('a command is never sent after valid_until, and the database still refuses it', { skip }, async () => {
  const b = newBattery();
  const id = enqueue(b.id, charge(), { validUntil: BASE + 300 }).command.id;
  const out = await cycle(b.driver, BASE + 400);
  assert.deepEqual([out.expired, b.driver.writes.length, cmd.getCommand(id).status], [[id], 0, 'expired']);
  const other = newBattery();
  const id2 = enqueue(other.id, charge(), { validUntil: BASE + 300 }).command.id;
  assert.throws(() => db.prepare("UPDATE command SET status = 'sent', sent_at = ? WHERE id = ?").run(ms(BASE + 400), id2), /past valid_until/);
});

test('a read-back that does not match is retried and then fails; the device state decides', { skip }, async () => {
  const b = newBattery({ ignoreWrites: true });
  const id = enqueue(b.id, charge()).command.id;
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push((await cycle(b.driver, BASE + i * 60, { maxAttempts: 2 })).devices[0].did[0]);
  assert.deepEqual(seen, [`sent ${id}`, `readback_mismatch ${id} -> pending`, `sent ${id}`, `readback_mismatch ${id} -> failed`]);
  const c = cmd.getCommand(id);
  assert.deepEqual([c.status, c.attempts, b.driver.writes.length], ['failed', 2, 2]);
  assert.ok(c.diff.action, 'the difference was kept');
  assert.ok(events(id).includes('retry') && events(id).includes('failed'));
});

test('a slow device is waited for within the settle time, not retried', { skip }, async () => {
  const b = newBattery({ applyAfterMs: 90000 });
  const id = enqueue(b.id, charge()).command.id;
  await cycle(b.driver, BASE, { settleS: 300 });
  assert.deepEqual((await cycle(b.driver, BASE + 60, { settleS: 300 })).devices[0].did, [`waiting ${id}`]);
  assert.deepEqual((await cycle(b.driver, BASE + 120, { settleS: 300 })).devices[0].did, [`acked ${id}`]);
  assert.equal(b.driver.writes.length, 1);
});

test('a write the device refuses goes back to pending and is sent again next cycle', { skip }, async () => {
  const b = newBattery({ refuseNext: 1 });
  const id = enqueue(b.id, charge()).command.id;
  assert.deepEqual((await cycle(b.driver, BASE)).devices[0].did, [`send_refused ${id} -> pending`]);
  assert.deepEqual((await cycle(b.driver, BASE + 60)).devices[0].did, [`sent ${id}`]);
  assert.deepEqual((await cycle(b.driver, BASE + 120)).devices[0].did, [`acked ${id}`]);
  assert.equal(cmd.getCommand(id).last_error, 'device busy');
});

test('effect not seen in telemetry: acked but not_verified, with the evidence', { skip }, async () => {
  const b = newBattery();
  const id = enqueue(b.id, charge({ windowStart: BASE + 7020, windowEnd: BASE + 9000 }), { validUntil: BASE + 9500 }).command.id;
  await cycle(b.driver, BASE); await cycle(b.driver, BASE + 60);
  assert.equal(cmd.getCommand(id).status, 'acked');
  chargingTelemetry(BASE + 7320, BASE + 7620, 0);               // the battery drew nothing
  const out = await cycle(b.driver, BASE + 7700);
  assert.deepEqual(out.devices[0].did, [`not_verified ${id}`]);
  const ev = cmd.commandLog(id).find((e) => e.detail?.state === 'not_verified').detail.evidence;
  assert.deepEqual([ev.metric, ev.min, ev.mean], ['battery_charge_w', 100, 0]);
});

test('gate: a plan that ran on stale inputs cannot queue a charge, but a plain demand command is fine; the open command stays', { skip }, () => {
  const b = newBattery();
  const first = enqueue(b.id, charge());
  assert.equal(first.written, true);
  const start = Math.floor(BASE / 1800) * 1800;
  const stale = plans.savePlan({ siteId: SITE, status: 'stale_inputs', error: 'grid_w 5400 s old (limit 3600 s)', planStart: start, slotS: 1800, horizonH: 24, methodVersion: 't', devices: [{ deviceId: b.id }], slots: [], now: ms(BASE) - 120000, scenario: 'shadow' });
  const refused = enqueue(b.id, charge({ limitPct: 90 }), { planRunId: stale.runId });
  assert.deepEqual([refused.written, refused.reason, refused.blocks.map((x) => x.gate)], [false, 'blocked', ['stale_inputs']]);
  assert.equal(cmd.getCommand(first.command.id).status, 'pending', 'a refused command does not cancel the open one');
  assert.equal(cmd.blocksOf(b.id).length, 1);
  assert.match(cmd.blocksOf(b.id)[0].detail.reason, /5400 s old/);
  cmd.cancelCommand(first.command.id, 'test', { now: ms(BASE) - 50000 });
  assert.equal(enqueue(b.id, { action: 'demand' }, { planRunId: stale.runId }).written, true, 'demand is the fallback of a stale plan');
});

test('gate: live freshness can be required, and a stale home blocks a charge', { skip }, () => {
  const b = newBattery();
  const r = enqueue(b.id, charge(), { freshnessLimits: true });
  assert.deepEqual([r.written, r.blocks?.[0]?.gate], [false, 'stale_inputs'], 'the fixture home has no recent live readings');
});

test('gate: a placeholder capability cannot send a command until it is confirmed', { skip }, () => {
  const b = newBattery({}, { charge: 'placeholder', demand: 'adapter' });
  const r = enqueue(b.id, charge());
  assert.deepEqual([r.written, r.blocks.map((x) => x.gate)], [false, ['placeholder_capability']]);
  plans.setCapability(b.id, 'charge', true, { source: 'probe' });
  assert.equal(enqueue(b.id, charge()).written, true);
});

test('gate: a per-device limit and the action\'s own range', { skip }, () => {
  const b = newBattery();
  setControlLimit(b.id, { action: 'charge', param: 'limit_pct', max: 90, source: 'installer' });
  const over = enqueue(b.id, charge({ limitPct: 100 }));
  assert.deepEqual([over.written, over.blocks.map((x) => x.gate), over.blocks[0].detail.max, over.blocks[0].detail.source], [false, ['limit'], 90, 'installer']);
  const out = enqueue(b.id, charge({ limitPct: 120 }));
  assert.ok(out.blocks.map((x) => x.gate).includes('params'), 'above the 100 the action allows');
  assert.equal(enqueue(b.id, charge({ limitPct: 80 })).written, true);
  setControlLimit(b.id, { action: 'charge', param: 'limit_pct', max: 100, source: 'installer' });   // the installer raises it: the old row is superseded, not deleted
  assert.equal(db.prepare('SELECT COUNT(*) n FROM control_limit WHERE device_id = ?').get(b.id).n, 2);
  assert.equal(enqueue(b.id, charge({ limitPct: 95 })).written, true);
});

test('the database rules of the command tables are intact: final states, one open command, append-only log', { skip }, () => {
  const b = newBattery();
  const id = enqueue(b.id, charge()).command.id;
  assert.throws(() => db.prepare("UPDATE command SET desired = '{}' WHERE id = ?").run(id), /desired state is fixed/);
  cmd.cancelCommand(id, 'done', { now: ms(BASE) - 30000 });
  assert.throws(() => db.prepare("UPDATE command SET status = 'sent', sent_at = ? WHERE id = ?").run(ms(BASE) - 20000, id), /status change not allowed/);
  assert.throws(() => db.prepare('DELETE FROM command_log WHERE command_id = ?').run(id), /append-only/);
  assert.throws(() => cmd.setVerify(id, 'verified', {}), /only an acked command/);
  assert.throws(() => cmd.markAppliedLate(id, { reported: {} }), /only an expired, sent command/);
});
