// Source health (src/core/health.js): ok, late, silent and never from the facts a bound provider's series hold, with a controlled
// clock (every call takes `now`), the default cadence by kind, an irregular source, the refusals of the last 24 hours, the last
// push when the push log exists, and the route. On a copy of the frozen real GB home plus small synthetic sources.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const H = hasLive ? await import('../src/core/health.js') : {};
const { bind } = hasLive ? await import('../src/core/inputs.js') : {};
const { seriesId, putReadings, putIntervals, putForecasts } = hasLive ? await import('../src/core/facts.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const SITE = 1;
const bindingOf = (role, source) => db.prepare('SELECT b.id FROM binding b JOIN source so ON so.id = b.source_id WHERE b.site_id = ? AND b.role = ? AND so.code = ? AND b.superseded_at IS NULL').get(SITE, role, source);
const roleHealth = (res, role) => res.roles.find((r) => r.role === role);
const lastReceived = (source) => Math.floor(db.prepare(`SELECT MAX(x) m FROM (
  SELECT MAX(r.recorded_at) x FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id WHERE so.code = ?
  UNION ALL SELECT MAX(f.recorded_at) FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN source so ON so.id = s.source_id WHERE so.code = ?)`).get(source, source).m / 1000);

test('the inverter (5 minutes expected): ok within 2 periods, late up to 6 hours, then silent', { skip }, () => {
  const last = lastReceived('sunsynk_5min');
  const at = (age) => roleHealth(H.health(SITE, { now: last + age }), 'inverter_5min').bindings[0];
  const ok = at(500);
  assert.deepEqual([ok.status, ok.expectedEveryS, ok.kind, ok.lastReceivedAt], ['ok', 300, 'instant', last]);
  assert.match(ok.reason, /^Newest data arrived 8 minutes ago; it normally sends every 5 minutes\.$/);
  assert.equal(at(600).status, 'ok', 'exactly 2 periods is still ok');
  assert.equal(at(601).status, 'late');
  assert.equal(at(5.9 * 3600).status, 'late');
  const silent = at(6 * 3600 + 1);
  assert.equal(silent.status, 'silent');
  assert.match(silent.reason, /No new data for 6 h; it normally sends every 5 minutes/);
  assert.equal(roleHealth(H.health(SITE, { now: last + 7 * 3600 }), 'inverter_5min').status, 'silent', 'the role is as bad as its worst binding');
});

test('a source with no data at all is "never", and says so in words', { skip }, () => {
  db.prepare("INSERT INTO source (code, name, contract, traits) VALUES ('quiet_vendor', 'Quiet vendor', '{}', '{\"expectedEveryS\":600}')").run();
  bind(SITE, 'heat_telemetry', 'quiet_vendor', { from: null, reason: 'test' });
  const h = roleHealth(H.health(SITE), 'heat_telemetry').bindings[0];
  assert.deepEqual([h.status, h.lastReceivedAt, h.ageS, h.series], ['never', null, null, 0]);
  assert.match(h.reason, /No data has arrived from quiet_vendor for this home yet/);
});

test('cadence by kind when the source declares none: a forecast 3600 s, a period its own length, a counter 300 s', { skip }, () => {
  const now = 1_900_000_000;
  const mk = (code) => db.prepare("INSERT INTO source (code, name, contract, traits) VALUES (?, ?, '{}', '{}')").run(code, code);
  const stamp = (table, series, whenS) => db.prepare(`UPDATE ${table} SET recorded_at = ? WHERE series_id = ?`).run(whenS * 1000, series);
  // a period source with 900 s periods
  mk('period_vendor'); bind(SITE, 'weather_temp', 'period_vendor', { from: null, reason: 'test' });
  const ps = seriesId('site', SITE, 'ghi_wm2', 'period_vendor');
  putIntervals(ps, [{ start: 1000, end: 1900, value: 1 }, { start: 1900, end: 2800, value: 2 }, { start: 2800, end: 3700, value: 3 }]); stamp('interval_fact', ps, now - 1500);
  const a = roleHealth(H.health(SITE, { now }), 'weather_temp').bindings.find((b) => b.source === 'period_vendor');
  assert.deepEqual([a.kind, a.expectedEveryS, a.status], ['interval', 900, 'ok'], '1500 s old, expected every 900: within 2 periods');
  assert.equal(roleHealth(H.health(SITE, { now: now + 400 }), 'weather_temp').bindings.find((b) => b.source === 'period_vendor').status, 'late');
  // a forecast-only source
  mk('forecast_vendor'); bind(SITE, 'solar_forecast', 'forecast_vendor', { from: null, reason: 'test', keep: true, priority: 9 });
  const fs = seriesId('site', SITE, 'solar_kwh', 'forecast_vendor');
  putForecasts(fs, now - 7000, [{ start: now, end: now + 900, value: 1 }]); db.prepare('UPDATE forecast_fact SET recorded_at = ? WHERE series_id = ?').run((now - 7000) * 1000, fs);
  const f = roleHealth(H.health(SITE, { now }), 'solar_forecast').bindings.find((b) => b.source === 'forecast_vendor');
  assert.deepEqual([f.kind, f.expectedEveryS, f.status], ['forecast', 3600, 'ok'], '7000 s old, expected every 3600');
  assert.equal(roleHealth(H.health(SITE, { now: now + 1000 }), 'solar_forecast').bindings.find((b) => b.source === 'forecast_vendor').status, 'late');
  // a counter on a plug
  const dev = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'smart_plug', 'push', 'h-plug', 'p', '{}', 0)").run(SITE).lastInsertRowid);
  mk('plug_vendor'); bind(SITE, 'plug_energy', 'plug_vendor', { from: null, reason: 'test', deviceId: dev });
  db.prepare("INSERT INTO channel (site_id, source_id, device_id, point, metric_id, kind, recorded_at) VALUES (?, (SELECT id FROM source WHERE code = 'plug_vendor'), ?, 'total', (SELECT id FROM metric WHERE code = 'plug_counter_kwh'), 'counter', 0)").run(SITE, dev);
  const cs = seriesId('device', dev, 'plug_counter_kwh', 'plug_vendor');
  putReadings(cs, [{ ts: now - 200, value: 5 }]); stamp('reading', cs, now - 200);
  const c = roleHealth(H.health(SITE, { now }), 'plug_energy').bindings[0];
  assert.deepEqual([c.kind, c.expectedEveryS, c.status, c.deviceId], ['counter', 300, 'ok', dev]);
  assert.equal(roleHealth(H.health(SITE, { now: now + 500 }), 'plug_energy').bindings[0].status, 'late', 'a device binding reads only that device\'s series');
});

test('an irregular source (reports only when something happens) is never late: ok with data, never without', { skip }, () => {
  const h = roleHealth(H.health(SITE, { now: 2_000_000_000 }), 'ev_dispatch');
  assert.ok(h, 'the home has an EV dispatch binding');
  const b = h.bindings[0];
  assert.equal(b.source, 'octopus_kraken');
  assert.ok(['ok', 'never'].includes(b.status), `status ${b.status}`);
  assert.equal(b.expectedEveryS, null);
  if (b.status === 'ok') assert.match(b.reason, /reports only when something happens/);
});

test('refusals of the last 24 hours are counted per source with the top reasons in words', { skip }, () => {
  const now = Math.floor(Date.now() / 1000);
  const src = db.prepare("SELECT id FROM source WHERE code = 'sunsynk_5min'").get().id;
  const ins = db.prepare('INSERT INTO channel_reject (site_id, source_id, point, ts, value, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) ins.run(SITE, src, 'PV', now, 9e9, 'out_of_range', (now - 3600) * 1000);
  ins.run(SITE, src, 'Weird', now, null, 'unmapped_point', (now - 7200) * 1000);
  ins.run(SITE, src, 'PV', now, null, 'out_of_range', (now - 3 * 86400) * 1000);   // older than 24 h: not counted
  const h = roleHealth(H.health(SITE, { now }), 'inverter_5min').bindings[0];
  assert.equal(h.rejected24h.total, 4);
  assert.deepEqual(h.rejected24h.top.map((x) => [x.reason, x.count, x.text]), [['out_of_range', 3, 'outside the allowed range'], ['unmapped_point', 1, 'a point nobody mapped']]);
});

test('the last push is reported when the push log exists, from successful pushes of that source only', { skip }, () => {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'push_log'").get();
  if (!has) return;   // the push log (delta 073) is feature-detected, never assumed
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO push_log (site_id, source, format, received_at, status) VALUES (?, 'sunsynk_5min', 'native', ?, 'ok')").run(SITE, (now - 600) * 1000);
  db.prepare("INSERT INTO push_log (site_id, source, format, received_at, status) VALUES (?, 'sunsynk_5min', 'native', ?, 'rejected')").run(SITE, (now - 10) * 1000);
  const h = roleHealth(H.health(SITE, { now }), 'inverter_5min').bindings[0];
  assert.equal(h.lastPushAt, (now - 600) * 1000, 'the newest OK push, in ms');
  const none = roleHealth(H.health(SITE, { now }), 'meter_energy').bindings[0];
  assert.equal(none.lastPushAt, null);
});

test('GET /api/sites/:id/source-health returns every role with a provider in force and a summary; an unknown home is 404', { skip }, async () => {
  const r = await fetch(`${base}/api/sites/${SITE}/source-health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.roles.length >= 7);
  assert.equal(Object.values(body.summary).reduce((t, n) => t + n, 0), body.roles.length);
  for (const role of body.roles) for (const b of role.bindings) assert.ok(typeof b.reason === 'string' && b.reason.length > 10 && !/undefined|NaN/.test(b.reason), b.reason);
  assert.equal((await fetch(`${base}/api/sites/999/source-health`)).status, 404);
});

test('human() words: seconds, minutes, hours, days', { skip }, () => {
  assert.deepEqual([H.human(30), H.human(300), H.human(3600), H.human(10800), H.human(9000), H.human(86400 * 3)], ['30 s', '5 minutes', '1 h', '3 h', '2.5 h', '3 days']);
});
