// POST /api/ingest through a real server on a spare port, on a copy of the frozen real GB home: the native format with counters and events,
// the shorthand, each vendor format (documented shapes, unverified on a real device), device registration, refusals, the token, idempotence,
// quarantine, acks and the log. Times are made from the real clock so no reading is "in the future".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};
const cmd = hasLive ? await import('../src/core/commands.js') : {};
const plans = hasLive ? await import('../src/core/plans.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => { delete process.env.INGEST_TOKEN; server?.close(); });

const SITE = 1;
const T0 = Math.floor(Date.now() / 1000 / 300) * 300 - 7200;          // a five-minute boundary two hours ago
const fx = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'push', `${name}.documented-shape.json`), 'utf8');
async function push(body, { query = '', headers = {}, raw = null } = {}) {
  const r = await fetch(`${base}/api/ingest${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const deviceId = (ref) => db.prepare('SELECT id FROM device WHERE site_id = ? AND external_ref = ?').get(SITE, ref)?.id;
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const logRows = () => count('SELECT COUNT(*) n FROM push_log');
const factRows = () => count('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) AS n');
const series = (ref, metric, table = 'reading') => db.prepare(`SELECT x.* FROM ${table} x JOIN series s ON s.id = x.series_id JOIN metric m ON m.id = s.metric_id
  WHERE s.subject_kind = 'device' AND s.subject_id = ? AND m.code = ? AND x.superseded_at IS NULL ORDER BY ${table === 'reading' ? 'x.ts' : 'x.start_ts'}`).all(String(deviceId(ref)), metric);
const localStamp = (ts, tz = 'Europe/London') => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts * 1000).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };

test('native: a plug registered by its first push, counters with a restart conserve energy, power and relay stored, events as periods', { skip }, async () => {
  const counter = [10, 10.4, 10.8, 0.2, 0.6];                              // restarts between the third and fourth sample
  const obs = counter.map((v, i) => ({ point: 'energy_total', ts: T0 + i * 300, value: v }));
  counter.forEach((_, i) => obs.push({ point: 'power', ts: T0 + i * 300, value: 100 + i }));
  obs.push({ point: 'relay', ts: T0, value: 1 });
  const r = await push({ device: 'plug-A', register: true, kind: 'smart_plug', label: 'Test plug A', emulated: true, observations: obs });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.ok, r.body.created, r.body.format, r.body.source, r.body.site], [true, true, 'native', 'push_native', SITE]);
  assert.deepEqual([r.body.counters, r.body.derived, r.body.rejected, r.body.unmapped], [5, 4, 0, []]);
  assert.match(r.body.warnings.join(' '), /registered a new smart_plug/);
  const dev = db.prepare('SELECT * FROM device WHERE id = ?').get(r.body.device);
  assert.deepEqual([dev.provider, dev.kind, dev.label, JSON.parse(dev.attrs).emulated], ['push', 'smart_plug', 'Test plug A', true]);
  assert.equal(count('SELECT COUNT(*) n FROM channel WHERE device_id = ? AND superseded_at IS NULL', dev.id), 3, 'the plug brought its standard channels: energy_total, power, relay');
  const per = series('plug-A', 'plug_kwh', 'interval_fact');
  assert.equal(per.length, 4);
  assert.ok(Math.abs(per.reduce((t, p) => t + p.value, 0) - 1.4) < 1e-9, 'energy = 0.4 + 0.4 + 0.2 (only what the counter shows after the restart) + 0.4');
  assert.equal(per.filter((p) => p.quality & 16).length, 1, 'the period around the restart is flagged partial');
  assert.equal(series('plug-A', 'plug_counter_kwh').length, 5, 'the raw counter is kept as it was reported');
  assert.equal(series('plug-A', 'plug_w').length, 5);
  assert.equal(series('plug-A', 'plug_on').length, 1);
});

test('native: events as periods and instants, never integrated', { skip }, async () => {
  const r = await push({ device: 'ev-1', register: true, kind: 'ev_charger', emulated: true, observations: [
    { point: 'plugged_in', start: T0 + 600, end: T0 + 1800, kind: 'event' }, { point: 'plugged_in', ts: T0 + 3000, kind: 'event' }, { point: 'plugged_in', ts: T0 + 3600, kind: 'event', value: 0 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.events, 2, 'an explicit 0 is no event');
  const ev = series('ev-1', 'event_ev_plugged_in', 'interval_fact');
  assert.deepEqual(ev.map((e) => [e.start_ts, e.end_ts, e.value]), [[T0 + 600, T0 + 1800, 1], [T0 + 3000, T0 + 3001, 1]]);
});

test('shorthand: several points read at one time, the receive time when no ts is given', { skip }, async () => {
  const before = Date.now() / 1000;
  const r = await push({ device: 'plug-A', points: { power: 55, relay: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, false);
  const p = series('plug-A', 'plug_w').at(-1);
  assert.equal(p.value, 55);
  assert.ok(p.ts >= before - 2 && p.ts <= Date.now() / 1000 + 1);
  assert.deepEqual(series('plug-A', 'plug_on').at(-1).value, 0);
});

test('shelly gen2 through the query string: registered, Wh turned into kWh, receive time, the unused fields named', { skip }, async () => {
  const r = await push(null, { raw: fx('shelly-gen2-switch-status'), query: '?format=shelly_gen2_switch&device=shelly-1&register=1&kind=smart_plug&label=Shelly%20plug' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.format, r.body.source, r.body.created], ['shelly_gen2_switch', 'push_shelly_gen2', true]);
  assert.equal(series('shelly-1', 'plug_w')[0].value, 1823.4);
  assert.ok(Math.abs(series('shelly-1', 'plug_counter_kwh')[0].value - 12.345678) < 1e-9);
  assert.equal(series('shelly-1', 'plug_on')[0].value, 1);
  assert.match(r.body.warnings.join(' '), /not used: voltage, current, freq, temperature/);
  const n = await push(null, { raw: fx('shelly-gen2-notifystatus'), query: '?format=shelly_gen2_switch&register=1&kind=smart_plug' });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  assert.equal(n.body.deviceRef, 'shellyplus1pm-a8032abc1234', 'the message names its own device');
});

test('tasmota: the device local time is read in the home time zone', { skip }, async () => {
  const body = { ...JSON.parse(fx('tasmota-sensor')), Time: localStamp(T0) };
  const r = await push(body, { query: '?format=tasmota_sensor&device=tasmota-1&register=1&kind=smart_plug' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'push_tasmota');
  assert.equal(series('tasmota-1', 'plug_w')[0].ts, T0, 'Europe/London local time converted to UTC');
  assert.equal(series('tasmota-1', 'plug_w')[0].value, 1820);
  assert.ok(Math.abs(series('tasmota-1', 'plug_counter_kwh')[0].value - 123.456) < 1e-9);
});

test('home assistant: a list of states, converted, with the unavailable and the unmapped named', { skip }, async () => {
  const list = JSON.parse(fx('homeassistant-list')).map((s) => ({ ...s, last_updated: new Date((T0 + 60) * 1000).toISOString() }));
  const r = await push(list, { query: '?device=ha-plug&register=1&emulated=1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.format, 'homeassistant_state', 'a list body is read as Home Assistant states');
  assert.equal(r.body.observations, 4);
  assert.equal(series('ha-plug', 'plug_w')[0].value, 1820);
  assert.ok(Math.abs(series('ha-plug', 'plug_counter_kwh')[0].value - 12.345) < 1e-9);
  assert.equal(series('ha-plug', 'plug_on')[0].value, 1);
  assert.match(r.body.warnings.join(' '), /garage_power.*unavailable/);
  assert.equal(count("SELECT COUNT(*) n FROM channel WHERE device_id = ? AND point = 'temperature'", deviceId('ha-plug')), 0, 'a plug has no temperature channel: that point is reported as unmapped');
  assert.deepEqual(r.body.unmapped, ['temperature']);
});

test('a wrapper { format, device, payload } works for any format', { skip }, async () => {
  const r = await push({ format: 'shelly_gen2_switch', device: 'shelly-1', payload: JSON.parse(fx('shelly-gen2-switch-status')) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'push_shelly_gen2');
});

test('an unknown device is refused (404) and logged; nothing is created or stored', { skip }, async () => {
  const devices = count('SELECT COUNT(*) n FROM device'); const facts = factRows();
  const r = await push({ device: 'nobody', points: { power: 1 } });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'unknown_device'); assert.match(r.body.error, /register/);
  assert.equal(count('SELECT COUNT(*) n FROM device'), devices);
  assert.equal(factRows(), facts);
  const row = db.prepare('SELECT * FROM push_log WHERE id = ?').get(r.body.logId);
  assert.deepEqual([row.status, row.error_code, row.site_id], ['rejected', 'unknown_device', SITE]);
});

test('register needs a known kind; an unknown kind or none creates nothing', { skip }, async () => {
  const devices = count('SELECT COUNT(*) n FROM device');
  const a = await push({ device: 'toaster-1', register: true, kind: 'toaster', points: { power: 1 } });
  assert.equal(a.status, 400); assert.equal(a.body.code, 'unknown_kind'); assert.equal(a.body.field, 'kind');
  const b = await push({ device: 'toaster-2', register: true, points: { power: 1 } });
  assert.equal(b.status, 400); assert.equal(b.body.code, 'kind_required');
  assert.equal(count('SELECT COUNT(*) n FROM device'), devices);
});

test('registering a heat pump brings its standard channels; a point with no channel is reported, never dropped silently', { skip }, async () => {
  const r = await push({ device: 'hp-1', register: true, kind: 'heat_pump', emulated: true, observations: [
    { point: 'elec_total', ts: T0, value: 100 }, { point: 'flow_temp', ts: T0, value: 35.5 }, { point: 'mystery', ts: T0, value: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(count('SELECT COUNT(*) n FROM channel WHERE device_id = ? AND superseded_at IS NULL', deviceId('hp-1')), 5, 'a heat pump brings two counters, two temperatures and a defrost event');
  assert.deepEqual(r.body.unmapped, ['mystery']);
  assert.match(r.body.warnings.join(' '), /no channel for: mystery/);
  assert.equal(count("SELECT COUNT(*) n FROM channel_reject WHERE point = 'mystery' AND reason = 'unmapped_point'"), 1);
  assert.equal(series('hp-1', 'heatpump_flow_temp_c')[0].value, 35.5);
});

test('times and values: milliseconds are read as milliseconds and warned, a future time is refused by the channel, nonsense is a 400 with its field', { skip }, async () => {
  const ms = await push({ device: 'plug-A', observations: [{ point: 'power', ts: (T0 + 7000) * 1000, value: 7 }] });
  assert.equal(ms.status, 200);
  assert.match(ms.body.warnings.join(' '), /read as milliseconds/);
  assert.equal(series('plug-A', 'plug_w').find((p) => p.ts === T0 + 7000).value, 7);
  const future = await push({ device: 'plug-A', observations: [{ point: 'power', ts: Math.floor(Date.now() / 1000) + 3600, value: 9 }] });
  assert.equal(future.status, 200);
  assert.equal(future.body.rejected, 1);
  assert.equal(count("SELECT COUNT(*) n FROM channel_reject WHERE reason = 'future_timestamp'"), 1);
  const bad = await push({ device: 'plug-A', observations: [{ point: 'power', ts: 'nonsense', value: 1 }] });
  assert.deepEqual([bad.status, bad.body.code, bad.body.field], [400, 'bad_timestamp', 'observations[0].ts']);
  const nan = await push({ device: 'plug-A', observations: [{ point: 'power', ts: T0, value: 'abc' }] });
  assert.deepEqual([nan.status, nan.body.code], [400, 'bad_value']);
  const inf = await push(null, { raw: `{"device":"plug-A","observations":[{"point":"power","ts":${T0},"value":1e999}]}` });
  assert.deepEqual([inf.status, inf.body.code], [400, 'bad_value'], 'JSON 1e999 is Infinity: refused');
});

test('a counter that goes backwards without being a restart or a wrap is refused and recorded, not stored', { skip }, async () => {
  const r = await push({ device: 'plug-B', register: true, kind: 'smart_plug', emulated: true, observations: [
    { point: 'energy_total', ts: T0, value: 5 }, { point: 'energy_total', ts: T0 + 300, value: 5.5 }, { point: 'energy_total', ts: T0 + 600, value: 3 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rejected, 1);
  assert.equal(count("SELECT COUNT(*) n FROM channel_reject WHERE reason = 'counter_backwards'"), 1);
  assert.deepEqual(series('plug-B', 'plug_counter_kwh').map((x) => x.value), [5, 5.5]);
});

test('limits: more than 5000 observations is a 400, a body over 1 MB is a 413', { skip }, async () => {
  const many = Array.from({ length: 5001 }, (_, i) => ({ point: 'power', ts: T0 + i, value: 1 }));
  const a = await push({ device: 'plug-A', observations: many });
  assert.deepEqual([a.status, a.body.code, a.body.field], [400, 'too_many_observations', 'observations']);
  const big = await push(null, { raw: JSON.stringify({ device: 'plug-A', points: { power: 1 }, note: 'x'.repeat(1.2 * 1024 * 1024) }) });
  assert.deepEqual([big.status, big.body.code], [413, 'too_large']);
  const ok = await push({ device: 'plug-A', observations: many.slice(0, 5000).map((o, i) => ({ ...o, ts: T0 - 20000 + i, value: i % 7 })) });
  assert.equal(ok.status, 200, 'exactly 5000 is accepted');
});

test('a body the core cannot read is quarantined, logged, and stores nothing', { skip }, async () => {
  const facts = factRows(); const quarantined = count("SELECT COUNT(*) n FROM raw_payload WHERE status = 'quarantined'");
  const a = await push(null, { raw: '{"device":"plug-A","observations":[' });
  assert.deepEqual([a.status, a.body.code], [400, 'malformed_json']);
  assert.equal(count("SELECT COUNT(*) n FROM raw_payload WHERE status = 'quarantined'"), quarantined + 1, 'the malformed body is kept as a quarantined receipt');
  const b = await push([1, 2, 3], { query: '?format=native' });
  assert.deepEqual([b.status, b.body.code], [400, 'bad_body']);
  const c = await push(null, { raw: '' });
  assert.equal(c.status, 400);
  assert.equal(factRows(), facts);
  assert.equal(db.prepare('SELECT status, error_code FROM push_log WHERE id = ?').get(a.body.logId).error_code, 'malformed_json');
  const shape = await push({ hello: 1 }, { query: '?format=shelly_gen2_switch&device=plug-A' });
  assert.deepEqual([shape.status, shape.body.code], [400, 'unrecognised_shape']);
  assert.ok(count("SELECT COUNT(*) n FROM raw_payload WHERE status = 'quarantined'") >= quarantined + 2, 'a body of the wrong shape is quarantined too');
});

test('unknown format, unknown source and unknown home are named', { skip }, async () => {
  assert.equal((await push({ points: { power: 1 }, device: 'plug-A' }, { query: '?format=nope' })).body.code, 'unknown_format');
  const src = await push({ device: 'plug-A', source: 'no_such_source', points: { power: 1 } });
  assert.deepEqual([src.status, src.body.code], [400, 'unknown_source']);
  const site = await push({ site: 999, device: 'plug-A', points: { power: 1 } });
  assert.deepEqual([site.status, site.body.code], [404, 'unknown_site']);
});

test('the same push twice stores nothing new: facts are change-only, the receipt is the same, and the log says so', { skip }, async () => {
  const body = { device: 'plug-C', register: true, kind: 'smart_plug', emulated: true, observations: [
    { point: 'energy_total', ts: T0 + 100, value: 1 }, { point: 'energy_total', ts: T0 + 400, value: 1.2 }, { point: 'power', ts: T0 + 100, value: 50 }] };
  const first = await push(body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.written > 0 && first.body.derived === 1);
  const facts = factRows(); const raws = count('SELECT COUNT(*) n FROM raw_payload');
  const second = await push(body);
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.written, second.body.derived, second.body.counters, second.body.duplicate, second.body.rawId], [0, 0, 0, true, first.body.rawId]);
  assert.match(second.body.warnings.join(' '), /received before/);
  assert.equal(factRows(), facts, 'no fact row was added');
  assert.equal(count('SELECT COUNT(*) n FROM raw_payload'), raws, 'no second receipt');
  const rows = db.prepare('SELECT * FROM push_log WHERE id IN (?, ?) ORDER BY id').all(first.body.logId, second.body.logId);
  assert.deepEqual(rows.map((r) => [r.status, r.written]), [['ok', first.body.written], ['ok', 0]], 'two log rows');
  assert.match(rows[1].warnings, /received before/);
});

test('acks go to the control code and are never stored as facts; an ack for an unknown command is refused', { skip }, async () => {
  const battery = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'battery', 'push', 'bat-ack', 'battery', '{}', 0)").run(SITE).lastInsertRowid);
  plans.setCapability(battery, 'charge', true, { source: 'adapter' });
  const BASE = Math.ceil((Date.now() / 1000 + 7200) / 1800) * 1800;
  const c = cmd.enqueueIfChanged({ deviceId: battery, desired: { action: 'charge', windowStart: BASE + 600, windowEnd: BASE + 3600, limitPct: 100 }, validFrom: BASE, validUntil: BASE + 7200, now: (BASE - 60) * 1000 }).command;
  const facts = factRows();
  const ok = await push({ observations: [{ kind: 'ack', commandId: c.id, ref: 'dev-ack-1' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.acks, ok.body.written, ok.body.counters], [1, 0, 0]);
  assert.equal(cmd.getCommand(c.id).ack_ref, 'dev-ack-1');
  assert.ok(cmd.commandLog(c.id).some((e) => e.detail?.state === 'ack_received' && e.detail.ref === 'dev-ack-1'));
  assert.equal(factRows(), facts, 'an ack is a receipt: no reading or interval was written');
  const unknown = await push({ observations: [{ kind: 'ack', commandId: 999999, ref: 'x' }, { point: 'power', ts: T0, value: 1 }], device: 'plug-A' });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.field], [404, 'unknown_command', 'commandId']);
  assert.equal(factRows(), facts, 'nothing in a body with an unknown ack is stored');
});

test('the token: required when INGEST_TOKEN is set (header or Authorization), open when not; refused tokens leave no log row', { skip }, async () => {
  process.env.INGEST_TOKEN = 's3cret-token';
  try {
    const logs = logRows(); const facts = factRows();
    const none = await push({ device: 'plug-A', points: { power: 3 } });
    assert.deepEqual([none.status, none.body.code], [401, 'token_required']);
    const wrong = await push({ device: 'plug-A', points: { power: 3 } }, { headers: { authorization: 'Bearer nope' } });
    assert.deepEqual([wrong.status, wrong.body.code], [401, 'bad_token']);
    const longer = await push({ device: 'plug-A', points: { power: 3 } }, { headers: { 'x-ingest-token': 's3cret-token-and-more-and-more-and-more' } });
    assert.deepEqual([longer.status, longer.body.code], [401, 'bad_token'], 'a token of another length is refused the same way');
    const unicode = await push({ device: 'plug-A', points: { power: 3 } }, { headers: { 'x-ingest-token': encodeURIComponent('s3cret-tökén') } });
    assert.equal(unicode.status, 401);
    assert.equal(logRows(), logs, 'no push_log row for a refused token');
    assert.equal(factRows(), facts);
    const bearer = await push({ device: 'plug-A', points: { power: 3 } }, { headers: { authorization: 'Bearer s3cret-token' } });
    assert.equal(bearer.status, 200, JSON.stringify(bearer.body));
    const header = await push({ device: 'plug-A', points: { power: 4 } }, { headers: { 'x-ingest-token': 's3cret-token' } });
    assert.equal(header.status, 200);
    assert.equal((await get(`/api/sites/${SITE}/pushes`)).body.connect.tokenRequired, true, 'the Devices page is told a token is needed');
  } finally { delete process.env.INGEST_TOKEN; }
  const open = await push({ device: 'plug-A', points: { power: 5 } });
  assert.equal(open.status, 200, 'unset: the endpoint is open');
  assert.equal((await get(`/api/sites/${SITE}/pushes`)).body.connect.tokenRequired, false);
});

test('the pushes route: newest first, what a sender needs to connect, a device filter, the unassigned ones', { skip }, async () => {
  const { status, body } = await get(`/api/sites/${SITE}/pushes`);
  assert.equal(status, 200);
  assert.equal(body.connect.endpoint, '/api/ingest');
  assert.deepEqual(body.connect.formats.map((f) => f.id), ['native', 'shelly_gen2_switch', 'tasmota_sensor', 'homeassistant_state']);
  assert.equal(body.connect.maxObservations, 5000);
  assert.ok(body.pushes.length >= 10);
  assert.ok(body.pushes.every((p, i, a) => i === 0 || a[i - 1].id > p.id), 'newest first');
  const rejectedRow = body.pushes.find((p) => p.status === 'rejected');
  assert.ok(rejectedRow && rejectedRow.errorCode && rejectedRow.error);
  const okRow = body.pushes.find((p) => p.status === 'ok' && p.device);
  for (const k of ['at', 'format', 'source', 'observations', 'written', 'forecasts', 'derived', 'rejected', 'unmapped', 'warnings', 'rawId', 'deviceRef']) assert.ok(k in okRow, k);
  assert.ok(body.pushes.some((p) => p.unassigned), 'a malformed body that could not be given a home is listed too');
  const own = await get(`/api/sites/${SITE}/pushes?device=${deviceId('plug-A')}&limit=3`);
  assert.ok(own.body.pushes.length <= 3 && own.body.pushes.every((p) => p.deviceId === deviceId('plug-A')));
  assert.equal((await get('/api/sites/999/pushes')).status, 404);
});

test('the Devices API shows pushed devices as emulated, with the time of the last push and the counter restart marked', { skip }, async () => {
  const list = (await get(`/api/sites/${SITE}/devices`)).body;
  const a = list.find((d) => d.label === 'Test plug A');
  assert.ok(a && a.emulated === true && a.synthetic === false, 'real endpoint, emulated data: not the synthetic demo');
  assert.equal(typeof a.lastPushAt, 'number');
  const d = (await get(`/api/sites/${SITE}/devices/${a.id}?hours=6`)).body;
  assert.equal(d.emulated, true);
  assert.ok(d.lastPushAt > 0 && d.pushes.length >= 1 && d.pushes[0].deviceId === a.id);
  assert.equal(d.device.ref, 'plug-A');
  assert.ok(d.markers.resets.length >= 1, 'the restart is marked');
  const real = list.find((x) => x.kind === 'meter_import');
  assert.equal(real.emulated, false); assert.equal(real.lastPushAt, null);
});

test('a synthetic demo device is fed by the generator, not by pushes', { skip }, async () => {
  const made = await fetch(`${base}/api/demo/iot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  const r = await push({ site: made.siteId, device: 'synthetic-plug-1', points: { power: 1 } });
  assert.deepEqual([r.status, r.body.code], [400, 'synthetic_device']);
});

test('with two real homes the push must say which one', { skip }, async () => {
  db.prepare("INSERT INTO site (name, created_at, is_demo) VALUES ('Second home', 1, 0)").run();
  const r = await push({ device: 'plug-A', points: { power: 1 } });
  assert.deepEqual([r.status, r.body.code, r.body.field], [400, 'site_required', 'site']);
  assert.match(r.body.error, /2 homes/); assert.match(r.body.error, /Second home/);
  assert.equal((await push({ site: SITE, device: 'plug-A', points: { power: 2 } })).status, 200);
  assert.equal((await push({ device: 'plug-A', points: { power: 2 } }, { query: `?site=${SITE}` })).status, 200, 'the site can be in the query string');
});

test('a plug reading far beyond what a plug can pass, or a relay that is neither on nor off, is refused by the channel and recorded', { skip }, async () => {
  const r = await push({ site: SITE, device: 'plug-A', observations: [{ point: 'power', ts: T0 + 6600, value: 99999999 }, { point: 'relay', ts: T0 + 6600, value: 5 }, { point: 'power', ts: T0 + 6600, value: 90 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rejected, 2);
  assert.deepEqual(db.prepare("SELECT reason FROM channel_reject WHERE point IN ('power', 'relay') AND reason = 'out_of_range' ORDER BY id DESC LIMIT 2").all().map((x) => x.reason), ['out_of_range', 'out_of_range']);
  assert.equal(series('plug-A', 'plug_w').find((p) => p.ts === T0 + 6600).value, 90, 'the believable reading at the same time is stored');
});
