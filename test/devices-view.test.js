// The Devices page's HTML and SVG builders (public/js/devices-view.js) on the real read model: every card, chart and panel renders,
// nothing prints "undefined" or "NaN", a hostile device name is escaped, the synthetic banner has its exact words, and the page is served.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const DV = hasLive ? await import('../src/core/devices-view.js') : {};
const G = hasLive ? await import('../src/core/synthetic-iot.js') : {};
const V = hasLive ? await import('../public/js/devices-view.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};

let server; let base; let demo;
before(async () => {
  if (!hasLive) return;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  demo = (await G.createSyntheticIotHome()).site;
});
after(() => server?.close());
const bad = (html) => html.match(/.{30}(undefined|NaN|\[object|null\b).{30}/)?.[0];

test('every device card and every chart of the synthetic home renders, with no undefined or NaN', { skip }, () => {
  const tz = demo.timezone;
  const list = DV.listDevices(demo.id);
  const cards = list.map((d) => V.cardHtml(d, tz)).join('');
  assert.ok(cards.length > 2000);
  assert.ok(!bad(cards), bad(cards));
  assert.equal((cards.match(/origin-synthetic/g) || []).length, 5, 'every card says Synthetic');
  assert.ok(cards.includes('Receiving data') || cards.includes('No new data'));
  for (const d of list) {
    const detail = DV.deviceDetail(demo.id, d.id, { hours: 72 });
    const html = V.chartsHtml(detail, tz) + V.explanationsHtml(detail, tz) + V.channelsTable(detail, tz) + V.rejectsPanel(detail, tz) + V.settingsHtml(detail) + V.commandsTable(detail, tz);
    assert.ok(!bad(html), `${d.label}: ${bad(html)}`);
    assert.ok(html.includes('<svg') || detail.channels.length === 0, d.label);
  }
});

test('the plug\'s chart marks the restart and explains it; the heat pump\'s marks the gap; an event lane draws', { skip }, () => {
  const tz = demo.timezone;
  const list = DV.listDevices(demo.id);
  const plug = DV.deviceDetail(demo.id, list.find((d) => d.kind === 'smart_plug').id, { hours: 72 });
  const html = V.chartsHtml(plug, tz);
  assert.ok(html.includes('class="dv-reset"') && html.includes('The counter restarted at'), 'a restart line');
  assert.ok(html.includes('dv-bar reset'), 'the period around a restart is drawn differently');
  assert.ok(html.includes('dv-cross'), 'the refused reading is marked');
  const words = V.explanationsHtml(plug, tz);
  assert.match(words, /restarted at/); assert.match(words, /only what the counter shows after the restart/); assert.match(words, /was refused/);
  const hp = DV.deviceDetail(demo.id, list.find((d) => d.kind === 'heat_pump').id, { hours: 72 });
  assert.ok(V.chartsHtml(hp, tz).includes('class="dv-gap"'), 'the gap band');
  assert.match(V.explanationsHtml(hp, tz), /No readings from/);
  assert.ok(V.chartsHtml(hp, tz).includes('class="dv-event"'), 'the defrost events');
});

test('a hostile device name is escaped everywhere it is printed', { skip }, () => {
  const evil = '<img src=x onerror=alert(1)>';
  const d = { ...DV.listDevices(demo.id)[0], label: evil };
  const html = V.cardHtml(d, demo.timezone);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('the banner has its exact words; the real home shows no synthetic badge', { skip }, () => {
  assert.ok(V.bannerHtml().includes('Synthetic demo data</b>: generated for this page, not from a real device'));
  assert.equal(V.SYNTHETIC_BANNER, 'Synthetic demo data: generated for this page, not from a real device');
  const real = DV.listDevices(1).map((d) => V.cardHtml(d, 'Europe/London')).join('');
  assert.ok(!real.includes('origin-synthetic') && real.includes('badge good'));
  assert.ok(!bad(real), bad(real));
});

test('the pipeline and command panels render from a simulate and a command result', { skip }, async () => {
  const dev = G.devicesOf(demo.id);
  const sim = DV.simulate(demo.id, dev.heatpump.id, { periods: 1 });
  const html = V.pipelineHtml(sim, demo.timezone);
  assert.ok(html.includes('1 Received') && html.includes('4 Energy derived') && html.includes('elec_total'));
  assert.ok(!bad(html), bad(html));
  const caught = V.pipelineHtml({ steps: [], added: 0, note: 'Nothing added: caught up' }, demo.timezone);
  assert.ok(caught.includes('caught up'));
  const cmd = await DV.sendCommand(demo.id, dev.battery.id, {});
  const path = V.commandPathHtml(cmd);
  assert.equal((path.match(/class="done"/g) || []).length, 5, 'all five steps done');
  assert.ok(!bad(path), bad(path));
  assert.ok(V.commandPathHtml({ written: false, reason: 'unchanged', blocks: [] }).includes('No command was queued'));
});

test('the page, its script, its builders and its stylesheet are served, and the nav has Devices', { skip }, async () => {
  const page = await fetch(`${base}/devices`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/js/pages/devices.js') && html.includes('/css/devices.css'));
  for (const f of ['/js/pages/devices.js', '/js/devices-view.js', '/css/devices.css']) assert.equal((await fetch(`${base}${f}`)).status, 200, f);
  const layout = await (await fetch(`${base}/js/layout.js`)).text();
  assert.ok(layout.includes("['devices', 'Devices', '/devices']"));
  void db;
});
