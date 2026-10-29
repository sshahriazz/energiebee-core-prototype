// The Devices page's "Connect a real device" panel and push log (public/js/devices-view.js) on rows from a real server: the curl example,
// the token note, the formats, the plain-language line of every kind of push, escaping, and no undefined or NaN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { app } = hasLive ? await import('../src/server.js') : {};
const V = hasLive ? await import('../public/js/devices-view.js') : {};
const { runEmulator } = await import('../scripts/push-emulator.mjs');

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => { delete process.env.INGEST_TOKEN; server?.close(); });

const SITE = 1;
const T0 = Math.floor(Date.now() / 1000 / 300) * 300 - 3600;
const bad = (html) => html.match(/.{30}(undefined|NaN|\[object|null\b).{30}/)?.[0];
const get = async (p) => (await fetch(`${base}${p}`)).json();
const post = async (body, query = '') => (await fetch(`${base}/api/ingest${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })).json();

test('the log of a real server renders every kind of push in plain words, escaped, with nothing undefined', { skip }, async () => {
  await runEmulator({ url: base, site: SITE, device: 'view-plug', label: 'view-<b>plug</b>', format: 'native', every: 0, count: 5, log: () => {} });
  await post({ device: 'view-plug', observations: [{ point: 'mystery', ts: T0, value: 1 }, { point: 'power', ts: T0, value: 5 }] });
  await post({ device: 'nobody', points: { power: 1 } });
  await post('{"observations": [');
  await post({ device: 'view-plug', observations: [{ point: 'energy_total', ts: T0 + 100, value: 3 }, { point: 'energy_total', ts: T0 + 400, value: 2.9 }] });
  const { connect, pushes } = await get(`/api/sites/${SITE}/pushes?limit=20`);
  const html = V.pushLogHtml(pushes, 'Europe/London');
  assert.ok(!bad(html), bad(html));
  assert.ok(!html.includes('<b>plug</b>'), 'a hostile device name is escaped');
  assert.match(html, /view-&lt;b&gt;plug&lt;\/b&gt;/);
  assert.match(html, /device registered/);
  assert.match(html, /1 point with no channel \(reported, not stored\)/);
  assert.match(html, /Refused\. No device with that reference/);
  assert.match(html, /Refused\. The body was not valid JSON/);
  assert.match(html, /1 reading refused by the channel rules/, 'the backwards counter');
  assert.match(html, /energy periods? worked out/);
  assert.match(html, /no home/, 'a body that could not be given a home is listed as such');
  assert.ok(!/<table/.test(html), 'a list, so it wraps on a phone');
  assert.ok(html.includes('class="dv-push bad"') && html.includes('class="dv-push warn"'));
  assert.match(html, /nobody <span class="faint">\(not found\)<\/span>/, 'a refused push names the device the sender used');
  assert.ok(V.connectHtml({ connect, origin: 'http://x', siteId: SITE }).includes('http://x/api/ingest'));
});

test('the empty log says how to send the first push', () => {
  const html = V.pushLogHtml([], 'Europe/London');
  assert.match(html, /Nothing has been pushed/);
  assert.match(html, /npm run demo:push/);
});

test('the connect panel: the address, the token note both ways, the formats and the honest note about them', { skip }, async () => {
  const open = (await get(`/api/sites/${SITE}/pushes`)).connect;
  assert.equal(open.tokenRequired, false);
  const a = V.connectHtml({ connect: open, origin: 'http://core:4100', siteId: SITE });
  assert.ok(!bad(a), bad(a));
  assert.match(a, /http:\/\/core:4100\/api\/ingest/);
  assert.match(a, /Not required/); assert.match(a, /is <b>open<\/b>/); assert.match(a, /INGEST_TOKEN/);
  for (const f of ['native', 'shelly_gen2_switch', 'tasmota_sensor', 'homeassistant_state']) assert.ok(a.includes(f), f);
  assert.match(a, /<b>not<\/b> been tried on a real device/);
  assert.match(a, /no MQTT client|has no MQTT client/);
  process.env.INGEST_TOKEN = 'secret';
  const guarded = (await get(`/api/sites/${SITE}/pushes`)).connect;
  assert.equal(guarded.tokenRequired, true);
  const b = V.connectHtml({ connect: guarded, origin: 'http://core:4100', siteId: SITE });
  assert.match(b, /Required/); assert.ok(!/is <b>open<\/b>/.test(b)); assert.match(b, /Authorization: Bearer/);
  assert.ok(!b.includes('secret'), 'the token itself is never shown');
});

test('the curl example: this home, the selected device and its real points; a token header only when one is needed; quotes survive the shell', () => {
  const connect = { endpoint: '/api/ingest', tokenRequired: false, maxObservations: 5000, maxBytes: 1048576, formats: [] };
  const c = V.curlExample({ origin: 'http://core:4100', connect, siteId: 3, device: { ref: 'plug-A', kind: 'smart_plug', label: "Anna's plug" }, points: ['energy_total', 'power', 'relay'], now: 1782000000 });
  assert.match(c, /^curl -X POST 'http:\/\/core:4100\/api\/ingest' \\\n/);
  assert.ok(!/Authorization/.test(c));
  const body = c.slice(c.indexOf("-d '") + 4, c.lastIndexOf("'")).replace(/'\\''/g, "'");
  const j = JSON.parse(body);
  assert.deepEqual([j.site, j.device, j.kind, j.label, j.register], [3, 'plug-A', 'smart_plug', "Anna's plug", true]);
  assert.deepEqual(j.observations.map((o) => o.point), ['energy_total', 'power', 'relay']);
  assert.ok(j.observations.every((o) => o.ts === 1782000000 && Number.isFinite(o.value)));
  assert.match(V.curlExample({ origin: 'http://core', connect: { ...connect, tokenRequired: true }, siteId: 1 }), /Authorization: Bearer YOUR_TOKEN/);
  assert.equal(JSON.parse(V.curlExample({ origin: 'http://core', connect, siteId: 1, device: { ref: 'inv', kind: 'inverter', label: 'Inv' } }).match(/-d '(.*)'$/s)[1]).kind, 'smart_plug', 'a home-level inverter is not offered as a kind to register');
});

test('an emulated device is badged as emulated with its last push; a real one keeps its Real badge', { skip }, async () => {
  const list = await get(`/api/sites/${SITE}/devices`);
  const emu = list.find((d) => d.emulated);
  const real = list.find((d) => d.kind === 'meter_import');
  const e = V.cardHtml(emu, 'Europe/London'); const r = V.cardHtml(real, 'Europe/London');
  assert.match(e, /Emulated/); assert.ok(!/badge good">Real/.test(e)); assert.match(e, /last push/);
  assert.match(r, /badge good">Real/); assert.ok(!/last push/.test(r) && !/Emulated/.test(r));
  assert.ok(!bad(e), bad(e));
  assert.match(V.emulatedLine(), /push emulator/);
});

test('the page script is served and carries the panel', { skip }, async () => {
  const js = await (await fetch(`${base}/js/pages/devices.js`)).text();
  assert.match(js, /Connect a real device/); assert.match(js, /\/pushes\?limit=20/); assert.match(js, /dv-push-reload/);
  const css = await (await fetch(`${base}/css/devices.css`)).text();
  assert.match(css, /\.dv-pushes/);
});
