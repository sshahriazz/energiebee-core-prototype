// R23, case 12: a device that accepts writes and reports nothing. Its commands end sent_unverified (written, never acked), never
// count as the state the device was confirmed to run, and a safety action is never queued for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const cmd = await import('../src/core/commands.js');
const plans = await import('../src/core/plans.js');
const { runControlCycle } = await import('../src/core/executor.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { actionsOf } = await import('../src/core/controls.js');

const T0 = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;
const ms = (s) => s * 1000;
const home = Number((await db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Verify', ?, 'GB', 'GB', 'GBP')").run(T0)).lastInsertRowid);
let n = 0;
const boiler = async (verification) => {
  const d = await addDevice({ siteId: home, kind: 'boiler', provider: 'push', externalRef: `b-${++n}`, recordedAt: ms(T0 - 7200) });
  for (const a of ['heat_on', 'heat_off']) await plans.setCapability(d.id, a, true, { source: 'installer', verification });
  return d;
};
// A driver that accepts every write and reports nothing.
const mute = () => { const writes = []; return { source: 'push_native', writes, read: async () => [], send: async (_d, desired) => { writes.push(desired); return { accepted: true }; } }; };
const ask = async (id, action, extra = {}) => await cmd.enqueueIfChanged({ deviceId: id, desired: { action, ...extra }, validFrom: T0, validUntil: T0 + 7200, now: ms(T0) - 60000 });

await test('the verification of an action is declared on the capability and shown with the thing\'s actions', async () => {
  const quiet = await boiler('none'); const loud = await boiler('reported');
  assert.equal(await plans.verificationOf(quiet.id, 'heat_on'), 'none');
  assert.equal(await plans.verificationOf(loud.id, 'heat_on'), 'reported');
  assert.equal((await actionsOf(quiet.id)).find((a) => a.action === 'heat_on').verification, 'none');
  await assert.rejects(plans.setCapability(quiet.id, 'heat_on', true, { verification: 'maybe' }), /verification maybe/);
});

await test('a command on a device that reports nothing is sent once and ends sent_unverified, never acked', async () => {
  const b = await boiler('none'); const driver = mute();
  const r = await ask(b.id, 'heat_on');
  assert.equal(r.written, true);
  const c = await runControlCycle(home, { driver, now: ms(T0), devices: [b.id] });
  assert.deepEqual(c.devices[0].did, [`sent_unverified ${r.command.id}`]);
  const done = await cmd.getCommand(r.command.id);
  assert.deepEqual([done.status, done.acked_at, driver.writes.length], ['sent_unverified', null, 1]);
  assert.deepEqual((await cmd.commandLog(done.id)).map((e) => e.event), ['enqueued', 'sent', 'sent_unverified']);
  assert.deepEqual((await runControlCycle(home, { driver, now: ms(T0) + 60000, devices: [b.id] })).devices.map((d) => d.did).flat(), [], 'nothing more is sent: it is final');
  assert.equal(driver.writes.length, 1);
  await assert.rejects(cmd.markAcked(done.id, { reported: {} }), /sent_unverified/, 'it can never become acked');
});

await test('an unverified command is not the state the device was confirmed to run: the same ask goes out again', async () => {
  const b = await boiler('none'); const driver = mute();
  const first = await ask(b.id, 'heat_on');
  await runControlCycle(home, { driver, now: ms(T0), devices: [b.id] });
  const again = await cmd.enqueueIfChanged({ deviceId: b.id, desired: { action: 'heat_on' }, validFrom: T0, validUntil: T0 + 7200, now: ms(T0) + 120000, idempotencyKey: 'again-1' });
  assert.equal(again.written, true, 'not "unchanged": nothing confirmed it');
  assert.notEqual(again.command.id, first.command.id);
});

await test('a safety action is never queued for a device that cannot confirm it; a comfort action is', async () => {
  const b = await boiler('none'); const ok = await boiler('reported');
  const safety = await ask(b.id, 'heat_off');
  assert.deepEqual([safety.written, safety.reason, safety.blocks.map((x) => x.gate)], [false, 'blocked', ['unverifiable']]);
  assert.equal((await ask(ok.id, 'heat_off')).written, true, 'a device that reports takes the same safety action');
  assert.equal((await ask(b.id, 'heat_on')).written, true, 'comfort is allowed, only not confirmed');
  assert.ok((await cmd.blocksOf(b.id)).some((x) => x.gate === 'unverifiable'), 'the refusal is kept');
});

await test('an effect-verified command ends sent_unverified and its effect check may still say verified', async () => {
  const b = await boiler('effect');
  const r = await ask(b.id, 'heat_on');
  await runControlCycle(home, { driver: mute(), now: ms(T0), devices: [b.id] });
  assert.equal((await cmd.getCommand(r.command.id)).status, 'sent_unverified');
  await cmd.setVerify(r.command.id, 'verified', { watts: 2400 }, { now: ms(T0) + 600000 });
  const done = await cmd.getCommand(r.command.id);
  assert.deepEqual([done.status, done.verify_status], ['sent_unverified', 'verified'], 'seen to work, still never acked by the device');
});
