// Stage 4: the `state` and `ack` observation kinds and channel access. A state is checked against the channel's range and
// enum and stored as a reading that never queues a rebuild; an ack is a receipt and is never stored as a fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { defineChannel, ingestObservations } = await import('../src/core/channels.js');
const { ensureControlChannels, DEFAULT_MODES } = await import('../src/core/control.js');
const { seriesId } = await import('../src/core/facts.js');

const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('control channels', 0)").run().lastInsertRowid);
const dev = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'sim', 'b1', 'battery', '{}', 0)").run(site).lastInsertRowid);
db.prepare("INSERT INTO source (code, name, contract) VALUES ('ctl_test', 'Control test', '{}')").run();
ensureControlChannels(site, 'ctl_test', dev);
const NOW = Math.floor(Date.now() / 1000);
const rows = (metric) => db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id WHERE s.id = ? AND r.superseded_at IS NULL ORDER BY r.ts`).all(seriesId('device', dev, metric, 'ctl_test'));
const queue = () => db.prepare('SELECT COUNT(*) n FROM rebuild_queue WHERE site_id = ?').get(site).n;
const state = (point, value, ts = NOW) => ({ kind: 'state', point, ts, value });

test('a state is stored as a reading of the device and queues no rebuild', () => {
  const out = ingestObservations(site, 'ctl_test', [state('charge_target_soc', 80), state('work_mode', 1)], null, { deviceId: dev });
  assert.deepEqual([out.states, out.written, out.rejected], [2, 0, 0]);
  assert.deepEqual(rows('ctl_charge_target_soc_pct').map((r) => r.value), [80]);
  assert.deepEqual(rows('ctl_work_mode').map((r) => r.value), [1]);
  assert.equal(queue(), 0, 'what a device says about its settings changes no built slot');
});

test('a state outside the range, outside the enum, without a time, or on a write-only point is rejected and kept apart', () => {
  defineChannel(site, 'ctl_test', 'write_only_point', 'ctl_reserve_pct', { deviceId: dev, access: 'write' });
  const out = ingestObservations(site, 'ctl_test', [state('charge_target_soc', 150), state('work_mode', 9), { kind: 'state', point: 'reserve', value: 5 }, state('write_only_point', 5)], null, { deviceId: dev });
  assert.equal(out.rejected, 4);
  assert.equal(out.states, 0);
  const why = db.prepare('SELECT reason FROM channel_reject WHERE site_id = ? ORDER BY id').all(site).map((r) => r.reason).slice(-4);
  assert.deepEqual(why.sort(), ['not_in_enum', 'out_of_range', 'state_without_time', 'write_only']);
});

test('an ack is returned as a receipt and never stored as a fact', () => {
  const before = db.prepare('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) + (SELECT COUNT(*) FROM forecast_fact) AS n').get().n;
  const out = ingestObservations(site, 'ctl_test', [{ kind: 'ack', ref: 'abc', commandId: 7, ts: NOW }], null, { deviceId: dev });
  assert.deepEqual(out.acks, [{ ref: 'abc', commandId: 7, ts: NOW }]);
  assert.deepEqual([out.written, out.states, out.rejected], [0, 0, 0]);
  assert.equal(db.prepare('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) + (SELECT COUNT(*) FROM forecast_fact) AS n').get().n, before);
});

test('the standard control points are one device\'s readwrite channels, made once', () => {
  assert.equal(ensureControlChannels(site, 'ctl_test', dev), 0);
  const ch = db.prepare("SELECT access, enum_values FROM channel WHERE device_id = ? AND point = 'work_mode' AND superseded_at IS NULL").get(dev);
  assert.equal(ch.access, 'readwrite');
  assert.deepEqual(JSON.parse(ch.enum_values), DEFAULT_MODES);
});
