// The Providers API (src/core/onboarding.js, routes in src/server.js) on a copy of the frozen real GB home, through a
// real server on a spare port: the read model, every route's happy path and error cases, that a preview and a dry run
// keep nothing, a bind then unbind round trip, channels defined and listed, rejected values, device-scoped bindings,
// and that the roles are read from inputs.js at call time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};
const inputs = hasLive ? await import('../src/core/inputs.js') : {};
const { ingestObservations } = hasLive ? await import('../src/core/channels.js') : {};

let server; let base;
before(async () => {
  if (!hasLive) return;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const SITE = 1;
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const count = (table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('GET /api/sources lists the sources with traits, contract and default channels, and the roles from inputs.js', { skip }, async () => {
  const { status, body } = await get('/api/sources');
  assert.equal(status, 200);
  assert.deepEqual(body.roles.map((r) => r.role), inputs.ROLES);
  const sun = body.sources.find((s) => s.code === 'sunsynk_5min');
  assert.equal(sun.traits.holdS, 300);
  assert.ok(sun.contract.units);
  assert.ok(sun.defaultChannels.some((c) => c.point === 'Grid' && c.metric === 'grid_export_w' && c.part === 'negative'));
  assert.ok(sun.suggestedRoles.includes('inverter_5min'));
  assert.ok(body.metrics.some((m) => m.code === 'solar_w' && m.unit === 'W'));
  assert.deepEqual(body.parts, ['all', 'positive', 'negative', 'abs']);
});

test('GET /api/sites/:id/onboarding: every role, its bindings with periods and data held, devices, channels, rejects', { skip }, async () => {
  const { status, body } = await get(`/api/sites/${SITE}/onboarding`);
  assert.equal(status, 200);
  assert.deepEqual(body.roles.map((r) => r.role), inputs.ROLES);
  const inv = body.roles.find((r) => r.role === 'inverter_5min');
  assert.equal(inv.bindings.length, 1);
  const b = inv.bindings[0];
  assert.deepEqual([b.source, b.from, b.to, b.deviceId, b.priority], ['sunsynk_5min', null, null, null, 0]);
  assert.ok(b.data.series > 0 && b.data.first < b.data.last, 'the real home has inverter data');
  assert.ok(b.defaultChannels.length > 0);
  assert.equal(body.roles.find((r) => r.role === 'solar_forecast').bindings.length, 2, 'two forecast sources by priority');
  assert.ok(Array.isArray(body.devices) && body.devices.length > 0);
  assert.equal(body.rejects.total, 0);
  assert.ok(body.history.length >= 9);
  assert.equal(body.site.timezone, 'Europe/London');
});

test('errors carry a status, a machine code and a plain message', { skip }, async () => {
  const bind = (o) => post(`/api/sites/${SITE}/bindings/preview`, { action: 'bind', role: 'inverter_5min', source: 'sunsynk_5min', ...o });
  const cases = [
    [await bind({ role: 'nope' }), 400, 'unknown_role'],
    [await bind({ source: 'nope' }), 400, 'unknown_source'],
    [await bind({ from: 'yesterday' }), 400, 'bad_date'],
    [await bind({ from: '2026-02-31' }), 400, 'bad_date'],
    [await bind({ deviceId: 99999 }), 400, 'unknown_device'],
    [await bind({ priority: 500 }), 400, 'bad_number'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: 'x', metric: 'solar_w', part: 'sideways' }), 400, 'bad_part'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: 'x', metric: 'not_a_metric' }), 400, 'unknown_metric'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: '  ', metric: 'solar_w' }), 400, 'missing_field'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: 'x', metric: 'solar_w', scale: 0 }), 400, 'bad_number'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: 'x', metric: 'solar_w', scale: 'abc' }), 400, 'bad_number'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'sunsynk_5min', point: 'x', metric: 'solar_w', min: 10, max: 1 }), 400, 'bad_number'],
    [await post(`/api/sites/${SITE}/channels`, { source: 'nope', point: 'x', metric: 'solar_w' }), 400, 'unknown_source'],
    [await post(`/api/sites/${SITE}/channels/retire`, { id: 999999 }), 404, 'not_found'],
    [await get('/api/sites/99999/onboarding'), 404, 'not_found'],
    [await get('/api/sites/99999/rejects'), 404, 'not_found'],
  ];
  for (const [r, status, code] of cases) { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.code, code, JSON.stringify(r.body)); assert.ok(r.body.error.length > 5); }
  assert.equal((await bind({ role: 'nope' })).body.field, 'role');
});

test('a preview keeps nothing and shows the impact; "from now on" touches no built slot and needs no reason', { skip }, async () => {
  const before = [count('binding'), count('channel'), count('rebuild_queue')];
  const past = await post(`/api/sites/${SITE}/bindings/preview`, { action: 'unbind', role: 'inverter_5min', at: '2026-10-20' });
  assert.equal(past.status, 200);
  assert.equal(past.body.needsReason, true);
  assert.ok(past.body.impact.changed > 100 && past.body.impact.byField.solar, 'ending the inverter from 20 October removes solar in many slots');
  assert.equal(past.body.impact.firstChangedDate >= '2026-10-20', true);
  assert.deepEqual(past.body.would.map((b) => [b.source, b.toDate]), [['sunsynk_5min', '2026-10-20']]);
  const now = await post(`/api/sites/${SITE}/bindings/preview`, { action: 'bind', role: 'inverter_5min', source: 'sunsynk_5min', from: 'now' });
  assert.equal(now.body.needsReason, false);
  assert.equal(now.body.impact.changed, 0);
  assert.deepEqual([count('binding'), count('channel'), count('rebuild_queue')], before, 'previews wrote nothing');
});

test('a dry run on every write returns what would happen and keeps nothing', { skip }, async () => {
  const before = [count('binding'), count('channel')];
  const b = await post(`/api/sites/${SITE}/bindings`, { dryRun: true, role: 'weather_temp', source: 'open_meteo', from: 'now' });
  assert.equal(b.status, 200); assert.equal(b.body.dryRun, true);
  const u = await post(`/api/sites/${SITE}/bindings/unbind?dryRun=1`, { role: 'weather_temp', at: 'now' });
  assert.equal(u.status, 200); assert.equal(u.body.dryRun, true);
  const c = await post(`/api/sites/${SITE}/channels`, { dryRun: true, source: 'open_meteo', point: 'temp_dry', metric: 'outdoor_temp_c' });
  assert.equal(c.status, 200); assert.equal(c.body.dryRun, true); assert.equal(c.body.channel.point, 'temp_dry');
  const r = await post(`/api/sites/${SITE}/channels/retire`, { dryRun: true, id: db.prepare('SELECT id FROM channel LIMIT 1').get()?.id ?? 1 });
  assert.ok([200, 404].includes(r.status));
  assert.deepEqual([count('binding'), count('channel')], before, 'nothing was kept');
});

test('a change that alters built slots is refused without a reason (409, nothing written), accepted with one, and queues a rebuild', { skip }, async () => {
  const before = count('binding');
  const refused = await post(`/api/sites/${SITE}/bindings`, { role: 'weather_temp', source: 'open_meteo', from: '2026-10-20' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'reason_required');
  assert.equal(count('binding'), before, 'a refused change wrote nothing');
  const ok = await post(`/api/sites/${SITE}/bindings`, { role: 'weather_temp', source: 'open_meteo', from: '2026-10-20', reason: 'test: switch the weather feed on this date', rebuild: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.role, 'weather_temp');
  const open = ok.body.bindings.filter((b) => !b.toDate);
  assert.equal(open.length, 1);
  assert.equal(open[0].fromDate, '2026-10-20');
  assert.equal(open[0].reason, 'test: switch the weather feed on this date');
  assert.equal(ok.body.queued.fromDate >= '2026-10-12', true);
  assert.ok(ok.body.rebuilt.length >= 1 && ok.body.rebuilt[0].days > 0, 'the affected days were rebuilt');
});

test('round trip: bind a source from now on, then end it; history keeps every row', { skip }, async () => {
  const hist = () => get(`/api/sites/${SITE}/onboarding`).then((r) => r.body);
  const b = await post(`/api/sites/${SITE}/bindings`, { role: 'carbon', source: 'carbon_regional', from: 'now', keep: true, priority: 3 });
  assert.equal(b.status, 201);
  assert.ok(b.body.bindings.some((x) => x.priority === 3 && !x.toDate), 'the new binding sits beside the current one');
  const u = await post(`/api/sites/${SITE}/bindings/unbind`, { role: 'carbon', at: 'now' });
  assert.equal(u.status, 200);
  assert.ok(u.body.ended >= 1);
  const m = await hist();
  const carbon = m.roles.find((r) => r.role === 'carbon');
  assert.equal(carbon.bindings.filter((x) => !x.toDate).length, 0, 'the role has no open binding after it is ended');
  assert.ok(carbon.bindings.length >= 1 && carbon.bindings.every((x) => x.toDate), 'every binding now has an end');
  assert.ok(m.history.filter((h) => h.role === 'carbon').length >= 3, 'the history kept the replaced rows');
  assert.ok(m.history.some((h) => h.role === 'carbon' && h.supersededAt), 'a replaced row is marked');
  // ending a role that has nothing open is reported, not an error
  const again = await post(`/api/sites/${SITE}/bindings/preview`, { action: 'unbind', role: 'carbon', at: 'now' });
  assert.ok(again.body.warnings.some((w) => /nothing to end/.test(w)));
});

test('channels: define, list, replace (the old one is superseded), remove, and the screen\'s device scoping', { skip }, async () => {
  const made = await post(`/api/sites/${SITE}/channels`, { source: 'acme_test_kw', point: 'x' , metric: 'solar_w' });   // unknown source first
  assert.equal(made.status, 400);
  db.prepare("INSERT INTO source (code, name, contract) VALUES ('acme_test_kw', 'Acme (test)', '{}')").run();
  const c1 = await post(`/api/sites/${SITE}/channels`, { source: 'acme_test_kw', point: 'pv_kw', metric: 'solar_w', scale: 1000, part: 'positive', min: 0, max: 60000 });
  assert.equal(c1.status, 201);
  assert.deepEqual([c1.body.channel.scale, c1.body.channel.part, c1.body.channel.min, c1.body.channel.max, c1.body.channel.unit], [1000, 'positive', 0, 60000, 'W']);
  const list = await get(`/api/sites/${SITE}/channels?source=acme_test_kw`);
  assert.equal(list.body.channels.length, 1);
  const c2 = await post(`/api/sites/${SITE}/channels`, { source: 'acme_test_kw', point: 'pv_kw', metric: 'solar_w', scale: 500 });
  assert.deepEqual(c2.body.replaces, [c1.body.id]);
  assert.equal((await get(`/api/sites/${SITE}/channels?source=acme_test_kw`)).body.channels.length, 1, 'one current channel');
  assert.equal((await get(`/api/sites/${SITE}/channels?source=acme_test_kw&all=1`)).body.channels.length, 2, 'the replaced one is kept');
  // a device-scoped channel is listed with its device
  const dev = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'inverter', 'acme', 'onb-dev', 'second inverter', '{}', 0)").run(SITE).lastInsertRowid);
  const cd = await post(`/api/sites/${SITE}/channels`, { source: 'acme_test_kw', point: 'pv_kw', metric: 'solar_w', deviceId: dev });
  assert.equal(cd.body.channel.deviceId, dev);
  const rm = await post(`/api/sites/${SITE}/channels/retire`, { id: c2.body.id });
  assert.equal(rm.status, 200);
  assert.equal((await get(`/api/sites/${SITE}/channels?source=acme_test_kw`)).body.channels.length, 1, 'only the device channel is left');
});

test('device scoping: a second device is bound beside the home, and "home" ends only the home\'s own binding', { skip }, async () => {
  const dev = db.prepare("SELECT id FROM device WHERE external_ref = 'onb-dev'").get().id;
  const b = await post(`/api/sites/${SITE}/bindings`, { role: 'inverter_daily', source: 'sunsynk_daily', from: 'now', deviceId: dev });
  assert.equal(b.status, 201);
  assert.equal(b.body.bindings.filter((x) => !x.toDate).length, 2, 'the home binding and the device binding are both open');
  const u = await post(`/api/sites/${SITE}/bindings/unbind`, { role: 'inverter_daily', at: 'now', deviceId: 'home' });
  assert.equal(u.body.ended, 1);
  assert.deepEqual(u.body.bindings.filter((x) => !x.toDate).map((x) => x.deviceId), [dev], 'only the device binding stays open');
});

test('rejected values and unmapped points are reported by reason and by point', { skip }, async () => {
  db.prepare("INSERT OR IGNORE INTO source (code, name, contract) VALUES ('acme_test_kw', 'Acme (test)', '{}')").run();
  assert.equal((await post(`/api/sites/${SITE}/channels`, { source: 'acme_test_kw', point: 'pv_kw', metric: 'solar_w', min: 0, max: 60000 })).status, 201);
  ingestObservations(SITE, 'acme_test_kw', [
    { point: 'pv_kw', ts: 1900000000, value: 1e9 }, { point: 'pv_kw', ts: 1900000300, value: 'abc' }, { point: 'firmware_temp', ts: 1900000000, value: 41 }, { point: 'firmware_temp', ts: 1900000300, value: 43 }]);
  const { status, body } = await get(`/api/sites/${SITE}/rejects`);
  assert.equal(status, 200);
  assert.deepEqual(body.byReason, { out_of_range: 1, not_a_number: 1, unmapped_point: 1 }, 'an unmapped point is recorded once per batch, however many values it had');
  assert.deepEqual(body.unmapped.map((u) => [u.source, u.point, u.count]), [['acme_test_kw', 'firmware_temp', 1]]);
  assert.equal(body.byPoint.find((x) => x.reason === 'out_of_range').point, 'pv_kw');
  const filtered = await get(`/api/sites/${SITE}/rejects?source=sunsynk_5min`);
  assert.equal(filtered.body.total, 0);
  const model = (await get(`/api/sites/${SITE}/onboarding`)).body;
  assert.equal(model.rejects.total, 3);
});

test('roles are read from inputs.js at call time: a role added later appears with a readable name and can be bound', { skip }, async () => {
  inputs.ROLES.push('test_new_role_energy');
  try {
    const m = (await get(`/api/sites/${SITE}/onboarding`)).body;
    const r = m.roles.find((x) => x.role === 'test_new_role_energy');
    assert.equal(r.label, 'Test new role energy');
    assert.deepEqual(r.bindings, []);
    assert.ok((await get('/api/sources')).body.roles.some((x) => x.role === 'test_new_role_energy'));
    const p = await post(`/api/sites/${SITE}/bindings/preview`, { action: 'bind', role: 'test_new_role_energy', source: 'sunsynk_5min', from: 'now' });
    assert.equal(p.status, 200);
    assert.ok(p.body.warnings.length === 0 || Array.isArray(p.body.warnings));
  } finally { inputs.ROLES.pop(); }
  assert.equal((await post(`/api/sites/${SITE}/bindings/preview`, { action: 'bind', role: 'test_new_role_energy', source: 'sunsynk_5min' })).body.code, 'unknown_role');
});
