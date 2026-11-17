// The control path as data (src/db/deltas/031-command.sql, 032, src/core/commands.js): tables only,
// no executor. A new, empty database; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const cmd = await import('../src/core/commands.js');
const plans = await import('../src/core/plans.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');

const site = await createSite({ name: 'Command home', isDemo: true });
const other = await createSite({ name: 'Another home', isDemo: true });
const dev = async (siteId, kind, ref) => (await addDevice({ siteId, kind, provider: 'synthetic', externalRef: ref })).id;
const inverter = await dev(site.id, 'inverter', 'SYN-INV');
const heatPump = await dev(site.id, 'heat_pump', 'SYN-HP');
const charger = await dev(site.id, 'ev_charger', 'SYN-EVC');
const otherBattery = await dev(other.id, 'battery', 'SYN-OTHER-BAT');
const T0 = Date.UTC(2026, 9, 26, 22, 0) / 1000;          // 22:00 UTC
const now0 = (T0 - 600) * 1000;                          // requested ten minutes before
const charge = { action: 'charge', windowStart: T0 + 1800, windowEnd: T0 + 7 * 3600 + 1800, targetSocPct: 100, reservePct: 4, chargeRateW: 2600, mode: 'timed_charge' };
const n = async (sql = 'SELECT COUNT(*) AS n FROM command') => (await db.prepare(sql).get()).n;
const raw = async (deviceId, action, key, extra = {}) => await db.prepare(`INSERT INTO command (device_id, requested_at, valid_from, valid_until, action, desired, desired_hash, idempotency_key, status, plan_run_id)
  VALUES (?, ?, ?, ?, ?, '{}', 'h', ?, ?, ?)`).run(deviceId, extra.requestedAt ?? now0, T0, extra.validUntil ?? T0 + 3600, action, key, extra.status ?? 'pending', extra.planRunId ?? null);

for (const a of ['charge', 'demand', 'export', 'freeze_export']) await plans.setCapability(inverter, a, true, { source: 'adapter' });

await test('a command needs the device to be known to deliver the action (helper and trigger)', async () => {
  const enqueue = async (d) => await cmd.enqueueIfChanged({ deviceId: heatPump, desired: d, validFrom: T0, validUntil: T0 + 3600, now: now0 });
  await assert.rejects(async () => await enqueue({ action: 'set_target_temp', setpointC: 21 }), /cannot deliver set_target_temp/);
  await assert.rejects(async () => await raw(heatPump, 'set_target_temp', 'raw-1'), /no device_capability row with supported = 1/);
  await plans.setCapability(heatPump, 'set_target_temp', false, { source: 'vendor_doc', note: 'schedule only' });
  await assert.rejects(async () => await enqueue({ action: 'set_target_temp', setpointC: 21 }), /cannot deliver/, 'known unsupported');
  await plans.setCapability(heatPump, 'set_target_temp', true, { source: 'probe' });
  const r = await enqueue({ action: 'set_target_temp', setpointC: 21 });
  assert.equal(r.written, true);
  assert.deepEqual([r.command.status, r.command.setpoint_c, r.command.desired], ['pending', 21, { action: 'set_target_temp', setpoint_c: 21 }]);
  await assert.rejects(async () => await plans.setCapability(heatPump, 'charge', true), /not defined in device_action/, 'a capability only for an action of the kind');
  await assert.rejects(async () => await raw(heatPump, 'set_target_temp', 'raw-2', { status: 'acked' }), /starts pending/);
  await cmd.cancelCommand(r.command.id, 'test done', { now: now0 });
});

await test('enqueueIfChanged writes nothing when the desired state equals the last one the device confirmed', async () => {
  const before = await n();
  const a = await cmd.enqueueIfChanged({ deviceId: inverter, desired: charge, validFrom: T0, validUntil: T0 + 8 * 3600, now: now0 });
  assert.equal(a.written, true);
  const c = a.command;
  assert.deepEqual([c.window_start, c.window_end, c.target_soc_pct, c.reserve_pct, c.charge_rate_w, c.mode], [T0 + 1800, T0 + 7 * 3600 + 1800, 100, 4, 2600, 'timed_charge']);
  assert.equal((await cmd.markSent(c.id, { now: now0 + 1000, registerWrites: 4 })).sent, true);
  const reported = { ...c.desired };
  assert.equal((await cmd.markAcked(c.id, { reported, now: now0 + 20000 })).acked, true);
  assert.equal((await cmd.lastAcked(inverter)).id, c.id);
  // The next cycle wants the same schedule (a new validity, same desired state): nothing is written.
  const again = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { ...charge }, validFrom: T0 + 300, validUntil: T0 + 8 * 3600, now: now0 + 300000 });
  assert.deepEqual([again.written, again.reason, again.command.id], [false, 'unchanged', c.id]);
  assert.equal(await n(), before + 1);
  // A changed target is a new command that supersedes the acked one.
  const changed = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { ...charge, targetSocPct: 90 }, validFrom: T0 + 300, validUntil: T0 + 8 * 3600, now: now0 + 300000 });
  assert.deepEqual([changed.written, changed.command.supersedes_command_id], [true, c.id]);
  assert.deepEqual((await cmd.commandLog(c.id)).map((e) => e.event), ['enqueued', 'sent', 'acked']);
  assert.equal((await cmd.commandLog(c.id))[1].detail.register_writes, 4);
  // force: re-send the same state when the device drifted from it.
  await cmd.cancelCommand(changed.command.id, 'test', { now: now0 + 300000 });
  const forced = await cmd.enqueueIfChanged({ deviceId: inverter, desired: charge, validFrom: T0 + 600, validUntil: T0 + 8 * 3600, force: true, now: now0 + 600000 });
  assert.equal(forced.written, true);
  await cmd.cancelCommand(forced.command.id, 'test', { now: now0 + 600000 });
});

await test('read-back: acked only when the device reports the desired state; otherwise the difference is kept', async () => {
  const r = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'export', exportStart: T0 + 1200, exportEnd: T0 + 3600, limitPct: 40, dischargeRateW: 3000 }, validFrom: T0, validUntil: T0 + 3600, now: now0 });
  const id = r.command.id;
  assert.deepEqual([r.command.export_start, r.command.export_end, r.command.discharge_rate_w], [T0 + 1200, T0 + 3600, 3000]);
  await cmd.markSent(id, { now: now0 + 1000 });
  const wrong = await cmd.markAcked(id, { reported: { ...r.command.desired, limit_pct: 45 }, now: now0 + 11000 });
  assert.deepEqual([wrong.acked, wrong.diff], [false, { limit_pct: { desired: 40, reported: 45 } }]);
  const row = await cmd.getCommand(id);
  assert.deepEqual([row.status, row.diff, row.reported.limit_pct], ['sent', { limit_pct: { desired: 40, reported: 45 } }, 45]);
  assert.equal((await cmd.markAcked(id, { reported: { ...r.command.desired, limit_pct: 40.0000001 }, now: now0 + 21000 })).acked, true);
  assert.deepEqual((await cmd.commandLog(id)).map((e) => e.event), ['enqueued', 'sent', 'readback', 'acked']);
  await assert.rejects(async () => await db.prepare('INSERT INTO command (device_id, requested_at, valid_from, valid_until, action, desired, desired_hash, idempotency_key, export_start, export_end) VALUES (?, ?, ?, ?, \'export\', \'{}\', \'h\', \'x-win\', ?, ?)')
          .run(inverter, now0, T0, T0 + 60, T0 + 600, T0), /export_end must be after export_start/);
});

await test('expiry: a late command is never sent; expireStale drops every open command past valid_until', async () => {
  const r = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'demand' }, validFrom: T0, validUntil: T0 + 60, now: now0 });
  assert.deepEqual(await cmd.expireStale({ now: (T0 + 30) * 1000 }), { expired: 0, ids: [] });
  assert.deepEqual(await cmd.expireStale({ now: (T0 + 60) * 1000 }), { expired: 1, ids: [r.command.id] });
  assert.equal((await cmd.getCommand(r.command.id)).status, 'expired');
  await assert.rejects(async () => await cmd.markSent(r.command.id, { now: (T0 + 61) * 1000 }), /is expired, not pending/);
  // Sent too late: expired instead.
  const late = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'demand' }, validFrom: T0, validUntil: T0 + 120, now: now0 });
  assert.deepEqual(await cmd.markSent(late.command.id, { now: (T0 + 121) * 1000 }), { sent: false, status: 'expired' });
  // Already expired when asked: nothing written; the database refuses it too.
  assert.deepEqual((await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'demand' }, validFrom: T0 - 120, validUntil: T0 - 60, now: now0 + 600000 })).reason, 'expired');
  await assert.rejects(async () => await raw(inverter, 'demand', 'late-raw', { requestedAt: (T0 + 3601) * 1000 }), /already expired/);
  // The database never lets a command become sent after valid_until.
  const p = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'freeze_export' }, validFrom: T0, validUntil: T0 + 60, now: now0 });
  await assert.rejects(async () => await db.prepare("UPDATE command SET status = 'sent', sent_at = ? WHERE id = ?").run((T0 + 61) * 1000, p.command.id), /never sent/);
  await cmd.cancelCommand(p.command.id, 'test', { now: now0 });
});

await test('supersede: one open command per device; a changed desired state cancels the pending one', async () => {
  await assert.rejects(async () => await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'stop' }, validFrom: T0, validUntil: T0 + 3600, now: now0 }), /cannot deliver stop/);
  await plans.setCapability(charger, 'stop', true);
  await plans.setCapability(charger, 'charge', true);
  const a2 = await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'stop' }, validFrom: T0, validUntil: T0 + 3600, now: now0 });
  assert.equal(a2.written, true, 'the refused call left nothing behind');
  const same = await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'stop' }, validFrom: T0 + 300, validUntil: T0 + 3600, now: now0 + 300000 });
  assert.deepEqual([same.written, same.reason, same.command.id], [false, 'pending_same', a2.command.id]);
  const b = await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'charge', rateW: 7400 }, validFrom: T0 + 300, validUntil: T0 + 3600, now: now0 + 300000 });
  assert.deepEqual([b.written, b.cancelled, b.command.supersedes_command_id, (await cmd.getCommand(a2.command.id)).status], [true, a2.command.id, a2.command.id, 'cancelled']);
  await assert.rejects(async () => await raw(charger, 'charge', 'second-open'), /UNIQUE constraint failed: command.device_id/);
  // Back to what the device already runs: the open command is cancelled and nothing new is written.
  await cmd.markSent(b.command.id, { now: now0 + 301000 });
  await cmd.markAcked(b.command.id, { reported: { action: 'charge', rate_w: 7400 }, now: now0 + 310000 });
  const c = await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'stop' }, validFrom: T0 + 600, validUntil: T0 + 3600, now: now0 + 600000 });
  const d = await cmd.enqueueIfChanged({ deviceId: charger, desired: { action: 'charge', rateW: 7400 }, validFrom: T0 + 900, validUntil: T0 + 3600, now: now0 + 900000 });
  assert.deepEqual([d.written, d.reason, d.cancelled, (await cmd.getCommand(c.command.id)).status], [false, 'unchanged', c.command.id, 'cancelled']);
});

await test('idempotency key: the same key never makes a second command', async () => {
  const args = { deviceId: inverter, desired: { action: 'freeze_export' }, validFrom: T0, validUntil: T0 + 1800, idempotencyKey: 'plan-77:inverter:slot-0', now: now0 };
  const a = await cmd.enqueueIfChanged(args);
  const b = await cmd.enqueueIfChanged({ ...args, desired: { action: 'demand' } });
  assert.deepEqual([a.written, b.written, b.reason, b.command.id], [true, false, 'duplicate', a.command.id]);
  await cmd.cancelCommand(a.command.id, 'test', { now: now0 });
  await assert.rejects(async () => await raw(inverter, 'demand', 'plan-77:inverter:slot-0'), /UNIQUE constraint failed: command.idempotency_key/);
  // Without a key, the key is the device, the desired state and the validity: a retried call is a duplicate.
  const k1 = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'demand' }, validFrom: T0, validUntil: T0 + 900, now: now0 });
  const k2 = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'demand' }, validFrom: T0, validUntil: T0 + 900, now: now0 + 5 });
  assert.deepEqual([k1.written, k2.reason], [true, 'duplicate']);
  await cmd.cancelCommand(k1.command.id, 'test', { now: now0 });
});

await test('status flow, retries, skipped writes, fixed desired state and an append-only log', async () => {
  const r = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'charge', targetSocPct: 80 }, validFrom: T0, validUntil: T0 + 3600, now: now0 });
  const id = r.command.id;
  await cmd.markSent(id, { now: now0 + 1000 });
  assert.equal((await cmd.markFailed(id, 'HTTP 503', { retry: true, now: now0 + 2000 })).status, 'pending');
  await cmd.markSent(id, { now: now0 + 3000 });
  assert.equal((await cmd.markFailed(id, 'HTTP 503', { retry: true, maxAttempts: 2, now: now0 + 4000 })).status, 'failed', 'attempts used up');
  const row = await cmd.getCommand(id);
  assert.deepEqual([row.attempts, row.last_error], [2, 'HTTP 503']);
  assert.deepEqual((await cmd.commandLog(id)).map((e) => e.event), ['enqueued', 'sent', 'retry', 'sent', 'failed']);
  await assert.rejects(async () => await db.prepare("UPDATE command SET status = 'pending' WHERE id = ?").run(id), /status change not allowed/);
  await assert.rejects(async () => await db.prepare("UPDATE command SET desired = '{}' WHERE id = ?").run(id), /desired state is fixed/);
  await assert.rejects(async () => await db.prepare('UPDATE command SET reserve_pct = 10 WHERE id = ?').run(id), /desired state is fixed/);
  await assert.rejects(async () => await db.prepare("UPDATE command_log SET event = 'acked' WHERE command_id = ?").run(id), /append-only/);
  await assert.rejects(async () => await db.prepare('DELETE FROM command_log WHERE command_id = ?').run(id), /append-only/);
  // Read before writing: the device already runs it, so nothing is written to it.
  const s = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'charge', targetSocPct: 70 }, validFrom: T0, validUntil: T0 + 3600, now: now0 + 5000 });
  await assert.rejects(async () => await cmd.markSkipped(s.command.id, { reported: { action: 'charge', target_soc_pct: 60 } }), /does not run the desired state/);
  assert.equal((await cmd.markSkipped(s.command.id, { reported: { action: 'charge', target_soc_pct: 70, extra: 1 }, now: now0 + 2e6 })).status, 'skipped_unchanged');
  assert.equal((await cmd.lastAcked(inverter)).id, s.command.id, 'a skipped write is the last confirmed state');
  // What the executor observes but never plans goes to the log.
  await cmd.logObserved(s.command.id, 'hold_charging', { now: now0 + 2.1e6, detail: { soc_pct: 71 } });
  assert.deepEqual((await cmd.commandLog(s.command.id)).at(-1), { at: now0 + 2.1e6, event: 'observed', detail: { soc_pct: 71, state: 'hold_charging' } });
});

await test('a command from a plan run of the same home only; release and auto are registry rows', async () => {
  const planStart = T0;
  const run = plans.savePlan({ siteId: site.id, planStart, slotS: 1800, horizonH: 24, methodVersion: 't', devices: [{ deviceId: inverter }],
    slots: [{ deviceId: inverter, slotStart: planStart + 1800, action: 'charge', chargeLimitPct: 100 }], now: now0 });
  const r = await cmd.enqueueIfChanged({ deviceId: inverter, planRunId: run.runId, desired: { action: 'charge', targetSocPct: 100, windowStart: planStart + 1800, windowEnd: planStart + 3600 }, validFrom: T0, validUntil: T0 + 3600, now: now0 });
  assert.equal(r.command.plan_run_id, run.runId);
  const otherRun = plans.savePlan({ siteId: other.id, planStart, slotS: 1800, methodVersion: 't', devices: [{ deviceId: otherBattery }], slots: [], now: now0 });
  await plans.setCapability(inverter, 'release', true, { source: 'adapter' });
  await assert.rejects(async () => await cmd.enqueueIfChanged({ deviceId: inverter, planRunId: otherRun.runId, desired: { action: 'release' }, validFrom: T0, validUntil: T0 + 3600, now: now0 }), /plan run belongs to another home/);
  const rel = await cmd.enqueueIfChanged({ deviceId: inverter, desired: { action: 'release' }, validFrom: T0, validUntil: T0 + 3600, now: now0 + 1 });
  assert.deepEqual([rel.written, rel.cancelled], [true, r.command.id]);
});
