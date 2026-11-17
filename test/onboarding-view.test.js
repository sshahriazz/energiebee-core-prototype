// The Providers screen's HTML builders (public/js/onboarding-view.js) on the real home's read model: every role renders,
// nothing prints "undefined" or "NaN", a hostile source name is escaped, and the pages are served.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) await useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { onboarding } = await import('../src/core/onboarding.js');
const V = await import('../public/js/onboarding-view.js');
const { app } = await import('../src/server.js');

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); server.unref(); }); base = `http://127.0.0.1:${server?.address().port}`; });

await test('every role card renders from the real model, with no undefined or NaN', { skip }, async () => {
  const model = await onboarding(1);
  const colors = new Map(); for (const r of model.roles) for (const b of r.bindings) if (!colors.has(b.source)) colors.set(b.source, colors.size);
  const html = model.roles.map((r) => V.roleCard(r, model, 'Europe/London', colors)).join('') + V.rejectsCard(model, 'Europe/London') + V.historyCard(model, 'Europe/London') + V.explainerHtml();
  assert.ok(html.length > 5000);
  assert.ok(!/undefined|NaN|\[object/.test(html), html.match(/.{30}(undefined|NaN|\[object).{30}/)?.[0]);
  assert.ok(html.includes('Inverter, every 5 minutes') && html.includes('sunsynk_5min'));
  assert.ok(html.includes('No provider fills this role'), 'a role with no binding says so');
  assert.equal((html.match(/<section class="card"/g) ?? []).length, model.roles.length + 2);
});

await test('two bindings that overlap in time go on separate lanes, and a gap is named', { skip }, async () => {
  const model = await onboarding(1);
  const role = { role: 'x', label: 'X', help: '', metrics: [], bindings: [
    { id: 1, source: 'a', deviceId: 1, from: model.now - 20 * 86400, to: null, fromDate: '2026-10-07', toDate: null, priority: 0, data: {} },
    { id: 2, source: 'b', deviceId: 2, from: model.now - 10 * 86400, to: model.now - 5 * 86400, fromDate: '2026-10-17', toDate: '2026-10-22', priority: 0, data: {} },
    { id: 3, source: 'c', deviceId: null, from: model.now - 40 * 86400, to: model.now - 30 * 86400, fromDate: '2026-09-17', toDate: '2026-09-27', priority: 0, data: {} }] };
  const html = V.timelineHtml(role, 'Europe/London', model.now, new Map([['a', 0], ['b', 1], ['c', 2]]));
  assert.equal((html.match(/class="ob-lane"/g) ?? []).length, 2, 'a and b overlap: two lanes (c ended before a began and shares the first lane)');
  assert.ok(/No provider from/.test(html), 'the gap between c and a is named');
});

await test('a hostile source or point name is escaped', { skip }, async () => {
  const model = await onboarding(1);
  await db.prepare("INSERT INTO source (code, name, contract) VALUES ('<img src=x onerror=alert(1)>', '<b>bad</b>', '{}')").run();
  const evil = { ...model, rejects: { ...model.rejects, total: 1, byReason: { unmapped_point: 1 }, byPoint: [{ source: '<img src=x onerror=alert(1)>', point: '"><script>x</script>', reason: 'unmapped_point', count: 1, lastAt: Date.now(), minValue: null, maxValue: null }] } };
  const html = V.rejectsCard(evil, 'Europe/London');
  assert.ok(!html.includes('<script>') && !html.includes('<img '), html);
  assert.ok(html.includes('&lt;img') && html.includes('&lt;script&gt;'));
});

await test('the Providers page and its script are served, and the nav links to it', { skip }, async () => {
  const page = await (await fetch(`${base}/providers`)).text();
  assert.ok(page.includes('/js/pages/providers.js') && page.includes('/css/onboarding.css'));
  for (const f of ['/js/pages/providers.js', '/js/onboarding-view.js', '/css/onboarding.css']) assert.equal((await fetch(`${base}${f}`)).status, 200, f);
  assert.ok((await (await fetch(`${base}/js/layout.js`)).text()).includes("['providers', 'Providers', '/providers']"));
});
