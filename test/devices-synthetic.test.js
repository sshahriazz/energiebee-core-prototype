// The synthetic IoT home (src/core/synthetic-iot.js): deterministic, labelled synthetic everywhere, and its history goes through the
// real ingest path, so the counter, gap and refused-value behaviour of the architecture is what the tests see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const G = await import('../src/core/synthetic-iot.js');
const { QUALITY } = await import('../src/core/facts.js');
const { localDate, todMinute } = await import('../src/core/time.js');

const NOW = Date.UTC(2026, 9, 27, 12, 0) / 1000;      // a fixed "now" so every run is the same
const { site, created } = await G.createSyntheticIotHome({ now: NOW });
const dev = G.devicesOf(site.id);
const histEnd = Math.floor((NOW - G.LAG_S) / G.STEP_S) * G.STEP_S;

const series = (deviceId, metric) => db.prepare(`SELECT se.id FROM series se JOIN metric m ON m.id = se.metric_id WHERE se.subject_kind = 'device' AND se.subject_id = ? AND m.code = ?`).get(String(deviceId), metric)?.id;
const readings = (deviceId, metric) => db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND superseded_at IS NULL ORDER BY ts').all(series(deviceId, metric));
const periods = (deviceId, metric) => db.prepare('SELECT start_ts, end_ts, value, quality FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL ORDER BY start_ts').all(series(deviceId, metric));

test('the home is a labelled demo home with five synthetic devices on synthetic sources', () => {
  assert.equal(created, true);
  assert.equal(site.is_demo, 1);
  assert.match(site.name, /Synthetic/);
  const devices = db.prepare('SELECT * FROM device WHERE site_id = ?').all(site.id);
  assert.equal(devices.length, 5);
  assert.ok(devices.every((d) => d.provider === 'synthetic' && /synthetic/i.test(d.label) && G.isSyntheticDevice(d)));
  const sources = db.prepare("SELECT code, name, contract FROM source WHERE code LIKE 'synthetic_%'").all();
  assert.equal(sources.length, 5);
  assert.ok(sources.every((s) => /generated/i.test(s.name) && JSON.parse(s.contract).synthetic));
  // every series of the home belongs to a synthetic source
  const foreign = db.prepare(`SELECT COUNT(*) n FROM series se JOIN source so ON so.id = se.source_id WHERE se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?) AND so.code NOT LIKE 'synthetic_%'`).get(site.id).n;
  assert.equal(foreign, 0);
});

test('creating it again changes nothing and returns the same home', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM reading').get().n;
  const again = await G.createSyntheticIotHome({ now: NOW + 600 });
  assert.equal(again.created, false);
  assert.equal(again.site.id, site.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading').get().n, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM site WHERE env_key = 'synthetic_iot'").get().n, 1);
});

test('deterministic: a step is a pure function of the time, the counters and the context', () => {
  const ctx = { tz: 'Europe/London' };
  const a = G.stepAll(NOW, { ...G.START_STATE, lastTs: NOW - 300 }, ctx);
  const b = G.stepAll(NOW, { ...G.START_STATE, lastTs: NOW - 300 }, ctx);
  assert.deepEqual(a, b);
  assert.equal(G.hash01(12345, 'x'), G.hash01(12345, 'x'));
  assert.notEqual(G.hash01(12345, 'x'), G.hash01(12346, 'x'));
});

test('the history ends half an hour before now, and was written through ingest (counters, channels, rejects)', () => {
  const plug = readings(dev.plug.id, 'plug_counter_kwh');
  assert.equal(plug.at(-1).ts, histEnd);
  assert.ok(plug.length > 800, `${plug.length} plug counter readings`);
  assert.ok(periods(dev.plug.id, 'plug_kwh').length > 800, 'the energy of each period was derived by the core, not written by the generator');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM channel WHERE site_id = ? AND device_id IS NOT NULL').get(site.id).n >= 25, 'channels exist for every device');
});

test('the plug counter restarts: periods around a reset are partial, one at midnight each day and one mid-day', () => {
  const per = periods(dev.plug.id, 'plug_kwh');
  const resets = per.filter((p) => (p.quality & QUALITY.PARTIAL) !== 0);
  assert.ok(resets.length >= 3, `${resets.length} partial periods`);
  const yesterday = localDate('Europe/London', histEnd - 86400);
  const midDay = resets.filter((p) => localDate('Europe/London', p.end_ts) === yesterday && todMinute('Europe/London', p.end_ts) === 845);
  assert.equal(midDay.length, 1, 'the restart at 14:05 yesterday');
  const atMidnight = resets.filter((p) => todMinute('Europe/London', p.end_ts) < 10);
  assert.ok(atMidnight.length >= 2, 'a reset when the local day starts');
});

test('energy is conserved: the derived periods add up to the counter difference (lifetime counters, including across the gap)', () => {
  for (const [dv, raw, derived] of [[dev.heatpump, 'heatpump_elec_counter_kwh', 'heatpump_elec_kwh'], [dev.heatpump, 'heat_output_counter_kwh', 'heat_output_kwh'], [dev.ev, 'ev_delivered_counter_kwh', 'ev_delivered_kwh']]) {
    const r = readings(dv.id, raw);
    const sum = periods(dv.id, derived).reduce((t, p) => t + p.value, 0);
    assert.ok(Math.abs(sum - (r.at(-1).value - r[0].value)) < 1e-6, `${raw}: ${sum} vs ${r.at(-1).value - r[0].value}`);
  }
});

test('the visible gap: the heat counter has a long estimated period, the sensor has no readings in a stretch', () => {
  const per = periods(dev.heatpump.id, 'heat_output_kwh');
  const est = per.filter((p) => (p.quality & QUALITY.ESTIMATED) !== 0);
  assert.equal(est.length, 1);
  assert.ok(est[0].end_ts - est[0].start_ts >= 5400, 'about an hour and a half');
  const t = readings(dev.sensor.id, 'indoor_temp_c');
  const holes = t.slice(1).filter((r, i) => r.ts - t[i].ts > 1800);
  assert.equal(holes.length, 1);
});

test('one refused counter reading and one unmapped point are on record, and the refused value was not stored', () => {
  const rej = db.prepare('SELECT reason, point, value, ts FROM channel_reject WHERE site_id = ? ORDER BY id').all(site.id);
  assert.deepEqual(rej.map((r) => r.reason).sort(), ['counter_backwards', 'unmapped_point']);
  const back = rej.find((r) => r.reason === 'counter_backwards');
  assert.ok(!readings(dev.plug.id, 'plug_counter_kwh').some((r) => r.ts === back.ts), 'no reading was stored at that time');
});

test('events and states came through: defrost and plugged-in events, relay and heating on or off', () => {
  assert.ok(periods(dev.heatpump.id, 'event_defrost').length >= 4);
  assert.ok(periods(dev.ev.id, 'event_ev_plugged_in').length >= 2);
  assert.ok(readings(dev.plug.id, 'plug_on').some((r) => r.value === 1) && readings(dev.plug.id, 'plug_on').some((r) => r.value === 0));
  assert.ok(readings(dev.heatpump.id, 'heating_on').some((r) => r.value === 1));
});

test('the roles are bound where one fits, and the real providers\' default bindings are not', () => {
  const rows = db.prepare('SELECT b.role, s.code AS source, b.device_id FROM binding b JOIN source s ON s.id = b.source_id WHERE b.site_id = ? AND b.superseded_at IS NULL').all(site.id);
  const has = (role, key) => rows.some((r) => r.role === role && r.device_id === dev[key].id && r.source.startsWith('synthetic_'));
  assert.ok(has('plug_energy', 'plug') && has('heat_pump_energy', 'heatpump') && has('heat_output_energy', 'heatpump') && has('heat_telemetry', 'heatpump') && has('heat_telemetry', 'sensor') && has('ev_charger_energy', 'ev'));
  assert.ok(rows.every((r) => r.source.startsWith('synthetic_')), 'no sunsynk or octopus binding');
});

test('the battery can be told to charge and reports its own settings', () => {
  const caps = db.prepare('SELECT action, supported, source FROM device_capability WHERE device_id = ?').all(dev.battery.id);
  assert.ok(caps.some((c) => c.action === 'charge' && c.supported === 1 && c.source === 'adapter'));
  assert.ok(readings(dev.battery.id, 'ctl_work_mode').length >= 1, 'the device reported its work mode');
});
