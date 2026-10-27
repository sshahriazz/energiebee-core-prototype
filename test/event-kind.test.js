// Events (channel kind event) and the optional ingest checks: future timestamps, stuck samples, clock offset.
// SYNTHETIC devices in an empty database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { ingestObservations, defineChannel } = await import('../src/core/channels.js');
const { seriesId, readIntervals, readReadings, QUALITY } = await import('../src/core/facts.js');

const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('iot', 0)").run().lastInsertRowid);
for (const code of ['ev_vendor', 'plug_vendor']) db.prepare("INSERT INTO source (code, name, contract) VALUES (?, ?, '{}')").run(code, `${code} (test)`);
let n = 0;
const device = (kind) => Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, ?, 'test', ?, ?, '{}', 0)").run(site, kind, `d-${++n}`, kind).lastInsertRowid);
const NOW = 2000000000;
const events = (dev, metric = 'event_ev_plugged_in') => readIntervals([seriesId('device', dev, metric, 'ev_vendor')], 0, 3e9).map((r) => [r.start_ts, r.end_ts, r.value]);
const lastReject = () => db.prepare('SELECT point, reason FROM channel_reject ORDER BY id DESC LIMIT 1').get();

test('an event: an instant is a one-second period, a period is kept as it is, both as 0/1, never integrated', () => {
  const car = device('ev_charger');
  const out = ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: 1000 }, { point: 'plugged_in', start: 5000, end: 5600 }], null, { deviceId: car, now: NOW });
  assert.equal(out.written, 2);
  assert.deepEqual(events(car), [[1000, 1001, 1], [5000, 5600, 1]]);
  const metric = db.prepare("SELECT time_role, aggregation, unit FROM metric WHERE code = 'event_ev_plugged_in'").get();
  assert.deepEqual([metric.time_role, metric.unit], ['interval', '0/1'], 'stored as a 0/1 period (as the vpp events are)');
});

test('an event with value 0 stores nothing, and the same event again stores nothing new', () => {
  const car = device('ev_charger');
  ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: 100, value: 0 }], null, { deviceId: car, now: NOW });
  assert.deepEqual(events(car), []);
  ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: 200 }], null, { deviceId: car, now: NOW });
  const again = ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: 200 }], null, { deviceId: car, now: NOW });
  assert.equal(again.written, 0);
});

test('a kind that does not match the channel is rejected: an event on a value channel, a counter on an event channel', () => {
  const car = device('ev_charger');
  let out = ingestObservations(site, 'ev_vendor', [{ point: 'connected', kind: 'event', ts: 100 }], null, { deviceId: car, now: NOW });
  assert.equal(out.rejected, 1);
  assert.equal(lastReject().reason, 'kind_mismatch');
  out = ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', kind: 'counter', ts: 100, value: 4 }], null, { deviceId: car, now: NOW });
  assert.equal(out.rejected, 1);
  assert.deepEqual(events(car), []);
});

test('a timestamp too far in the future is rejected on counter and event channels (future_timestamp), one inside the tolerance is accepted', () => {
  const car = device('ev_charger');
  const real = Math.floor(Date.now() / 1000);
  const bad = ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: real + 3600 }, { point: 'energy_total', ts: real + 3600, value: 5 }], null, { deviceId: car });
  assert.equal(bad.rejected, 2);
  const reasons = db.prepare('SELECT reason FROM channel_reject ORDER BY id DESC LIMIT 2').all().map((r) => r.reason);
  assert.deepEqual(reasons, ['future_timestamp', 'future_timestamp']);
  const ok = ingestObservations(site, 'ev_vendor', [{ point: 'plugged_in', ts: real + 60 }], null, { deviceId: car });
  assert.equal(ok.written, 1, 'a minute ahead is inside the 300 s tolerance (a slightly fast clock)');
});

test('a channel that declares no tolerance accepts any time: the check is optional', () => {
  const dev = device('smart_plug');
  const real = Math.floor(Date.now() / 1000);
  defineChannel(site, 'plug_vendor', 'free', 'plug_w', { deviceId: dev });
  const out = ingestObservations(site, 'plug_vendor', [{ point: 'free', ts: real + 99999, value: 5 }], null, { deviceId: dev });
  assert.equal(out.rejected, 0);
  defineChannel(site, 'plug_vendor', 'checked', 'plug_w', { futureToleranceS: 60, deviceId: dev });
  assert.equal(ingestObservations(site, 'plug_vendor', [{ point: 'checked', ts: real + 99999, value: 5 }], null, { deviceId: dev }).rejected, 1);
});

test('stuck samples: from the Nth identical reading in a row the sample is stored with the suspect flag, across batches too', () => {
  const dev = device('smart_plug');
  defineChannel(site, 'plug_vendor', 'sticky', 'plug_w', { maxStuckSamples: 3, deviceId: dev });
  const q = () => readReadings([seriesId('device', dev, 'plug_w', 'plug_vendor')], 0, 3e9).map((r) => [r.ts, r.value, Boolean(r.quality & QUALITY.SUSPECT)]);
  const a = ingestObservations(site, 'plug_vendor', [5, 5, 5, 5, 6].map((value, i) => ({ point: 'sticky', ts: 1000 + i * 60, value })), null, { deviceId: dev, now: NOW });
  assert.equal(a.stuck, 2);
  assert.deepEqual(q().map((x) => x[2]), [false, false, true, true, false]);
  const b = ingestObservations(site, 'plug_vendor', [6, 6].map((value, i) => ({ point: 'sticky', ts: 2000 + i * 60, value })), null, { deviceId: dev, now: NOW });
  assert.equal(b.stuck, 1, 'the run of 6 continues from the stored 6: the third in a row is flagged');
  assert.equal(q().length, 7, 'a stuck value is stored (flagged), not dropped');
});

test('a channel clock offset corrects every timestamp of the channel', () => {
  const dev = device('smart_plug');
  defineChannel(site, 'plug_vendor', 'skewed', 'plug_w', { clockOffsetS: -120, deviceId: dev });
  ingestObservations(site, 'plug_vendor', [{ point: 'skewed', ts: 1000, value: 7 }], null, { deviceId: dev, now: NOW });
  assert.deepEqual(readReadings([seriesId('device', dev, 'plug_w', 'plug_vendor')], 0, 3e9).map((r) => [r.ts, r.value]), [[880, 7]]);
});
