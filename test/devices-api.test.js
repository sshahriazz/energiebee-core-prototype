// The Devices API on a copy of the frozen real GB home, through a real server on a spare port: the list (old fields kept), the detail,
// the synthetic demo home (created once), simulate and commands for synthetic devices only, and every error case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const GB = 1;
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const post = async (p, body = {}) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
let demoSite; let devs;

test('the real GB home lists its real devices with the old fields and no synthetic flag', { skip }, async () => {
  const { status, body } = await get(`/api/sites/${GB}/devices`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body) && body.length >= 3);
  for (const d of body) {
    for (const k of ['kind', 'provider', 'label', 'profileClass', 'annualKwh', 'gasUnit', 'state']) assert.ok(k in d, `old field ${k}`);
    assert.equal(d.synthetic, false, d.label);
    assert.ok(['fresh', 'stale', 'missing'].includes(d.status.status));
    assert.ok(Array.isArray(d.channels) && Array.isArray(d.roles));
  }
  assert.ok(body.some((d) => d.kind === 'meter_import' && d.roles.some((r) => r.role === 'meter_energy')), 'the import meter fills the meter role');
  const inv = body.find((d) => d.id === 'site');
  assert.ok(inv && inv.kind === 'inverter' && inv.channels.length >= 4, 'the home-level inverter is listed as a device');
});

test('detail of a real meter has data and no synthetic banner; simulate and commands are refused for it', { skip }, async () => {
  const meter = (await get(`/api/sites/${GB}/devices`)).body.find((d) => d.kind === 'meter_import');
  const { status, body } = await get(`/api/sites/${GB}/devices/${meter.id}`);
  assert.equal(status, 200);
  assert.equal(body.synthetic, false);
  assert.equal(body.banner, null);
  assert.ok(body.channels.some((c) => c.data && (c.data.points?.length || c.data.periods?.length)));
  for (const path of ['simulate', 'commands']) {
    const r = await post(`/api/sites/${GB}/devices/${meter.id}/${path}`, {});
    assert.equal(r.status, 400); assert.equal(r.body.code, 'not_synthetic'); assert.match(r.body.error, /synthetic/i);
  }
  const inv = await get(`/api/sites/${GB}/devices/site`);
  assert.equal(inv.status, 200);
  assert.ok(inv.body.channels.length >= 4 && inv.body.channels.every((c) => c.data.points.length));
});

test('the demo home: not there, created once, then the same one', { skip }, async () => {
  assert.deepEqual((await get('/api/demo/iot')).body, { exists: false, siteId: null, name: null });
  const a = await post('/api/demo/iot');
  assert.equal(a.status, 200);
  assert.equal(a.body.created, true);
  demoSite = a.body.siteId;
  const b = await post('/api/demo/iot');
  assert.equal(b.body.created, false); assert.equal(b.body.siteId, demoSite);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM site WHERE env_key = 'synthetic_iot'").get().n, 1);
  assert.deepEqual((await get('/api/demo/iot')).body, { exists: true, siteId: demoSite, name: 'Synthetic IoT home (demo data)' });
  // the real home is untouched
  assert.equal(db.prepare('SELECT COUNT(*) n FROM device WHERE site_id = ?').get(GB).n >= 3, true);
});

test('the synthetic home lists five synthetic devices, stale until time is moved forward', { skip }, async () => {
  const { body } = await get(`/api/sites/${demoSite}/devices`);
  devs = Object.fromEntries(body.map((d) => [d.kind, d]));
  assert.equal(body.length, 5);
  assert.ok(body.every((d) => d.synthetic === true && /synthetic/i.test(d.label)));
  assert.ok(body.every((d) => d.status.status === 'stale' && d.status.ageS >= 1800 && d.status.ageS < 3600), 'the history ends half an hour ago');
  const plug = devs.smart_plug;
  assert.ok(plug.channels.some((c) => c.kind === 'counter' && c.point === 'energy_total' && c.last.period));
  assert.ok(devs.heat_pump.roles.some((r) => r.role === 'heat_pump_energy') && devs.ev_charger.roles.some((r) => r.role === 'ev_charger_energy'));
  assert.equal(devs.battery.controllable, true);
  assert.equal(devs.smart_plug.controllable, false);
});

test('detail of the plug: raw counter, derived periods, a marked restart and a refused reading', { skip }, async () => {
  const { status, body } = await get(`/api/sites/${demoSite}/devices/${devs.smart_plug.id}?hours=72`);
  assert.equal(status, 200);
  assert.equal(body.synthetic, true);
  assert.match(body.banner, /Synthetic demo data: generated for this page, not from a real device/);
  const counter = body.channels.find((c) => c.kind === 'counter' && c.point === 'energy_total');
  assert.ok(counter.data.raw.length > 100 && counter.data.periods.length > 100);
  assert.ok(counter.data.periods.some((p) => p.type === 'reset'), 'a period around a restart is marked');
  assert.ok(body.markers.resets.length >= 3);
  assert.ok(body.rejects.some((r) => r.reason === 'counter_backwards' && r.point === 'energy_total'));
  const power = body.channels.find((c) => c.point === 'power');
  assert.ok(power.data.points.length > 100);
});

test('detail of the heat pump: two counters, temperatures, defrost events and a gap; the battery shows its settings', { skip }, async () => {
  const hp = (await get(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}?hours=72`)).body;
  assert.ok(hp.channels.filter((c) => c.kind === 'counter').length === 2);
  assert.ok(hp.channels.find((c) => c.kind === 'event' && c.point === 'defrost').data.intervals.length >= 2);
  assert.ok(hp.markers.gaps.some((g) => g.to - g.from >= 5400), 'the long gap of the heat counter');
  const bat = (await get(`/api/sites/${demoSite}/devices/${devs.battery.id}`)).body;
  assert.equal(bat.controllable, true);
  assert.ok(bat.settings.some((s) => s.label && s.word === 'demand'), 'the work mode in words');
});

test('simulate: exactly the next period, the derived energy equals the counter difference, then it catches up with the clock', { skip }, async () => {
  const before = (await get(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}`)).body.newestTs;
  const r = await post(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}/simulate`, { periods: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.added, 1); assert.equal(r.body.from, before + 300); assert.equal(r.body.to, before + 300);
  const step = r.body.steps.find((s) => s.point === 'elec_total');
  assert.ok(step.derived && step.stored.previous != null);
  assert.ok(Math.abs(step.derived.value - (step.received - step.stored.previous)) < 1e-6, 'the energy is the difference of the counter readings');
  assert.equal(step.derived.end, step.at);
  assert.equal(r.body.steps.every((s) => s.deviceKey === 'heatpump'), true);
  const after = (await get(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}`)).body.newestTs;
  assert.equal(after, before + 300);
  const all = await post(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}/simulate`, { periods: 12 });
  assert.equal(all.body.caughtUp, true);
  assert.ok(all.body.added >= 1 && all.body.added <= 6);
  const none = await post(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}/simulate`, { periods: 1 });
  assert.equal(none.body.added, 0); assert.match(none.body.note, /caught up/);
  const status = (await get(`/api/sites/${demoSite}/devices/${devs.heat_pump.id}`)).body.status.status;
  assert.equal(status, 'fresh');
});

test('commands: the battery reaches acked and verified, the target alternates, a plug cannot be commanded', { skip }, async () => {
  const r = await post(`/api/sites/${demoSite}/devices/${devs.battery.id}/commands`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.written, true);
  assert.equal(r.body.command.status, 'acked');
  assert.equal(r.body.command.verifyStatus, 'verified');
  assert.deepEqual(r.body.path.map((p) => [p.key, p.done]), [['enqueued', true], ['sent', true], ['read_back', true], ['acked', true], ['verified', true]]);
  assert.ok(r.body.log.some((e) => e.event === 'enqueued') && r.body.log.some((e) => e.event === 'sent') && r.body.log.some((e) => e.event === 'acked'));
  assert.equal(r.body.target, 80);
  const second = await post(`/api/sites/${demoSite}/devices/${devs.battery.id}/commands`, {});
  assert.equal(second.body.target, 90);
  assert.equal(second.body.command.verifyStatus, 'verified');
  const explicit = await post(`/api/sites/${demoSite}/devices/${devs.battery.id}/commands`, { targetSocPct: 70 });
  assert.equal(explicit.body.target, 70);
  const detail = (await get(`/api/sites/${demoSite}/devices/${devs.battery.id}`)).body;
  assert.equal(detail.commands.length, 3);
  assert.ok(detail.settings.some((s) => s.value === 70), 'the device reports the new target');
  const plug = await post(`/api/sites/${demoSite}/devices/${devs.smart_plug.id}/commands`, {});
  assert.equal(plug.status, 400); assert.equal(plug.body.code, 'not_controllable');
});

test('error cases carry a message and a code', { skip }, async () => {
  assert.deepEqual([(await get('/api/sites/999/devices/1')).status, (await get('/api/sites/999/devices/1')).body.code], [404, 'not_found']);
  const unknown = await get(`/api/sites/${demoSite}/devices/99999`);
  assert.deepEqual([unknown.status, unknown.body.code], [404, 'unknown_device']);
  assert.equal((await get(`/api/sites/${demoSite}/devices/abc`)).status, 404);
  assert.equal((await get(`/api/sites/${demoSite}/devices/site`)).status, 404, 'the synthetic home has no inverter');
  for (const periods of [0, 13, 1.5, 'x']) {
    const r = await post(`/api/sites/${demoSite}/devices/${devs.smart_plug.id}/simulate`, { periods });
    assert.deepEqual([r.status, r.body.code, r.body.field], [400, 'bad_number', 'periods'], String(periods));
  }
  const bad = await post(`/api/sites/${demoSite}/devices/${devs.battery.id}/commands`, { targetSocPct: 5 });
  assert.deepEqual([bad.status, bad.body.code], [400, 'bad_number']);
  assert.equal((await post(`/api/sites/${demoSite}/devices/424242/simulate`, {})).body.code, 'unknown_device');
  // a device of another home is not found through this one
  const meter = (await get(`/api/sites/${GB}/devices`)).body.find((d) => d.kind === 'meter_import');
  assert.equal((await post(`/api/sites/${demoSite}/devices/${meter.id}/simulate`, {})).status, 404);
});

test('the real home\'s data and devices were not touched by any of this', { skip }, async () => {
  assert.ok(db.prepare('SELECT COUNT(*) n FROM device WHERE site_id = ?').get(GB).n >= 3, 'the real devices are all still there');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM command c JOIN device d ON d.id = c.device_id WHERE d.site_id = ?').get(GB).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM channel_reject WHERE site_id = ? AND reason = 'counter_backwards'").get(GB).n, 0);
});
