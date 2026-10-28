// End to end: the emulator (scripts/push-emulator.mjs, synthetic data) pushes to a real server on a temp database in each format; the stored
// facts, the derived energy and what the Devices API reports are checked. The emulator's code path is the one a person runs with `npm run demo:push`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};
const { runEmulator, heaterWatts, buildPush } = await import('../scripts/push-emulator.mjs');

let server; let url;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); url = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const SITE = 1;
const quiet = () => {};
const devId = (ref) => db.prepare('SELECT id FROM device WHERE site_id = ? AND external_ref = ?').get(SITE, ref)?.id;
const raw = (ref) => db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id JOIN metric m ON m.id = s.metric_id
  WHERE s.subject_kind = 'device' AND s.subject_id = ? AND m.code = 'plug_counter_kwh' AND r.superseded_at IS NULL ORDER BY r.ts`).all(String(devId(ref)));
const periods = (ref) => db.prepare(`SELECT i.start_ts, i.end_ts, i.value, i.quality FROM interval_fact i JOIN series s ON s.id = i.series_id JOIN metric m ON m.id = s.metric_id
  WHERE s.subject_kind = 'device' AND s.subject_id = ? AND m.code = 'plug_kwh' AND i.superseded_at IS NULL ORDER BY i.start_ts`).all(String(devId(ref)));
const get = async (p) => (await fetch(`${url}${p}`)).json();

test('the emulator is deterministic and daily-shaped: nothing at night, load in the morning and evening', () => {
  const day = Date.UTC(2026, 5, 20) / 1000;                                   // 20 June 2026 00:00 UTC (01:00 BST)
  assert.equal(heaterWatts(day + 3 * 3600, 'UTC'), 0, '03:00: off');
  const morning = Array.from({ length: 12 }, (_, i) => heaterWatts(day + 6 * 3600 + i * 900, 'UTC'));
  assert.ok(morning.some((w) => w > 1500) && morning.every((w) => w === 0 || (w > 1700 && w < 1900)));
  assert.deepEqual(morning, Array.from({ length: 12 }, (_, i) => heaterWatts(day + 6 * 3600 + i * 900, 'UTC')), 'same time, same load');
  assert.equal(buildPush({ format: 'native', device: 'd', label: 'l', tz: 'UTC', ts: 1, watts: 1, kwh: 1, on: true }).body.observations.length, 3);
  assert.throws(() => buildPush({ format: 'nope', device: 'd' }), /unknown format/);
});

test('native, simulated time: every push is accepted, the counter is kept, the derived energy is its difference', { skip }, async () => {
  const lines = [];
  const r = await runEmulator({ url, site: SITE, device: 'emu-native', format: 'native', every: 0, step: 300, count: 14, log: (l) => lines.push(l) });
  assert.deepEqual([r.posts, r.ok, r.failed], [14, 14, 0]);
  assert.match(lines[0], /EMULATOR \(synthetic data\)/);
  assert.ok(r.responses[0].created === true && r.responses.slice(1).every((x) => x.created === false), 'registered by the first push only');
  const c = raw('emu-native'); const p = periods('emu-native');
  assert.equal(c.length, 14);
  assert.equal(p.length, 13);
  assert.ok(Math.abs(p.reduce((t, x) => t + x.value, 0) - (c.at(-1).value - c[0].value)) < 1e-6, 'energy = the counter difference');
  const dev = db.prepare("SELECT * FROM device WHERE external_ref = 'emu-native'").get();
  assert.deepEqual([dev.provider, dev.kind, JSON.parse(dev.attrs).emulated], ['push', 'smart_plug', true]);
});

for (const format of ['shelly_gen2_switch', 'tasmota_sensor', 'homeassistant_state']) {
  test(`${format}: the emulator's documented-shape pushes are stored the same way`, { skip }, async () => {
    const ref = `emu-${format}`;
    const r = await runEmulator({ url, site: SITE, device: ref, format, every: 0, step: 300, count: 10, log: quiet });
    assert.deepEqual([r.posts, r.ok, r.failed], [10, 10, 0], JSON.stringify(r.responses.find((x) => !x.ok)));
    assert.ok(r.responses.every((x) => x.format === format && x.source.startsWith('push_')));
    const c = raw(ref); const p = periods(ref);
    assert.equal(c.length, 10);
    assert.equal(p.length, 9);
    assert.ok(Math.abs(p.reduce((t, x) => t + x.value, 0) - (c.at(-1).value - c[0].value)) < 1e-6);
    assert.ok(c.every((x, i) => i === 0 || x.ts - c[i - 1].ts === 300), 'the device times were read back exactly (Wh converted, local time converted, ISO parsed)');
  });
}

test('a restart and a gap: the restart period is partial, the gap period estimated, energy is still conserved', { skip }, async () => {
  const ref = 'emu-trouble';
  const r = await runEmulator({ url, site: SITE, device: ref, format: 'native', every: 0, step: 300, count: 30, restartAfter: 6, gapAfter: 10, gap: 14, log: quiet });
  assert.deepEqual([r.posts, r.ok, r.failed], [16, 16, 0], '14 pushes were never sent');
  const c = raw(ref); const p = periods(ref);
  assert.equal(c.length, 16);
  assert.equal(p.filter((x) => x.quality & 16).length, 1, `one partial period: the restart (qualities ${p.map((x) => x.quality)})`);
  assert.equal(p.filter((x) => x.quality & 8).length, 1, `one estimated period: it spans the gap (qualities ${p.map((x) => x.quality)})`);
  let expect = 0;
  for (let i = 1; i < c.length; i++) expect += c[i].value >= c[i - 1].value ? c[i].value - c[i - 1].value : c[i].value;   // a restart: only what the counter shows after it
  assert.ok(Math.abs(p.reduce((t, x) => t + x.value, 0) - expect) < 1e-6, `conserved: ${p.reduce((t, x) => t + x.value, 0)} vs ${expect}`);
  const gapPeriod = p.find((x) => x.quality & 8);
  assert.ok(gapPeriod.end_ts - gapPeriod.start_ts >= 4200, 'the estimated period is the silent stretch');
  // what the Devices page is shown
  const d = await get(`/api/sites/${SITE}/devices/${devId(ref)}?hours=4`);
  assert.equal(d.emulated, true);
  assert.equal(d.markers.resets.length, 1, `resets ${JSON.stringify(d.markers.resets)}`);
  assert.equal(d.markers.gaps.filter((g) => g.point === 'energy_total').length, 1, `the counter has one gap marker: ${JSON.stringify(d.markers.gaps)}`);
  assert.deepEqual([...new Set(d.markers.gaps.map((g) => g.point))].sort(), ['energy_total', 'power', 'relay'], 'every channel that went quiet shows the same stretch');
  assert.ok(d.pushes.length === 5 && d.pushes.every((x) => x.status === 'ok'), 'the detail carries the five newest pushes');
  const list = await get(`/api/sites/${SITE}/devices`);
  const card = list.find((x) => x.id === devId(ref));
  assert.ok(card.emulated && card.lastPushAt > Date.now() - 60000, 'the card knows when it last pushed');
});

test('the same emulator run twice stores nothing new', { skip }, async () => {
  const opts = { url, site: SITE, device: 'emu-repeat', format: 'native', every: 0, step: 300, start: '2026-10-28T06:00:00Z', count: 4, log: quiet };
  const a = await runEmulator(opts);
  const facts = db.prepare('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) AS n').get().n;
  const b = await runEmulator(opts);
  assert.deepEqual([a.failed, b.failed], [0, 0]);
  assert.ok(b.responses.every((x) => x.written === 0 && x.duplicate === true));
  assert.equal(db.prepare('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) AS n').get().n, facts);
});

test('a refused push is reported, not thrown: a token the core requires', { skip }, async () => {
  process.env.INGEST_TOKEN = 'emu-token';
  try {
    const lines = [];
    const none = await runEmulator({ url, site: SITE, device: 'emu-token', format: 'native', every: 0, count: 2, token: '', log: (l) => lines.push(l) });
    assert.deepEqual([none.ok, none.failed], [0, 2]);
    assert.ok(lines.some((l) => /401 token_required/.test(l)));
    const good = await runEmulator({ url, site: SITE, device: 'emu-token', format: 'native', every: 0, count: 2, token: 'emu-token', log: quiet });
    assert.deepEqual([good.ok, good.failed], [2, 0]);
  } finally { delete process.env.INGEST_TOKEN; }
  const down = await runEmulator({ url: 'http://127.0.0.1:1', site: SITE, device: 'emu-down', format: 'native', every: 0, count: 1, log: quiet });
  assert.deepEqual([down.ok, down.failed], [0, 1], 'an unreachable core is a failed push, not a crash');
});

test('a device that pushed in two formats does not get an empty twin chart, and the channel table says which source each row is', { skip }, async () => {
  const ref = 'emu-two-formats';
  await runEmulator({ url, site: SITE, device: ref, format: 'shelly_gen2_switch', every: 0, step: 300, count: 6, log: quiet });
  const early = await get(`/api/sites/${SITE}/devices/${devId(ref)}?hours=6`);
  assert.equal(early.channels.filter((c) => c.point === 'energy_total').length, 1);
  await runEmulator({ url, site: SITE, device: ref, format: 'native', every: 0, step: 300, count: 4, start: new Date((Math.floor(Date.now() / 1000) - 4 * 3600) * 1000).toISOString(), log: quiet });
  const d = await get(`/api/sites/${SITE}/devices/${devId(ref)}?hours=1`);       // a window where only the newer source has data
  const sources = [...new Set(db.prepare("SELECT so.code FROM channel c JOIN source so ON so.id = c.source_id WHERE c.device_id = ? AND c.superseded_at IS NULL").all(devId(ref)).map((r) => r.code))].sort();
  assert.deepEqual(sources, ['push_native', 'push_shelly_gen2'], 'one device, channels under two sources');
  for (const point of ['energy_total', 'power', 'relay']) assert.equal(d.channels.filter((c) => c.point === point).length, 1, `${point} is drawn once`);
  const V = await import('../public/js/devices-view.js');
  const table = V.channelsTable(d, 'Europe/London');
  assert.match(table, /via push_native/);
  assert.ok(!/via push_shelly/.test(V.channelsTable(early, 'Europe/London')), 'a device with one source needs no source note');
});
