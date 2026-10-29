// Editing a binding's priority: never in place (the row is superseded and re-recorded), a reason only when built slots would
// change, and a build "as known before" still sees the old order. On a copy of the frozen real GB home (solar_forecast has two
// sources by priority: core_forecast 0, quartz 1).
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

const SITE = 1;
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const current = (source) => db.prepare(`SELECT b.* FROM binding b JOIN source so ON so.id = b.source_id WHERE b.site_id = ? AND b.role = 'solar_forecast' AND so.code = ? AND b.superseded_at IS NULL`).get(SITE, source);
const asKnown = (source, atMs) => db.prepare(`SELECT b.priority FROM binding b JOIN source so ON so.id = b.source_id WHERE b.site_id = ? AND b.role = 'solar_forecast' AND so.code = ? AND b.recorded_at <= ? AND (b.superseded_at IS NULL OR b.superseded_at > ?)`).get(SITE, source, atMs, atMs)?.priority;
const rows = () => db.prepare('SELECT COUNT(*) n FROM binding').get().n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the priority is re-recorded, not edited: the old row is kept superseded and a build as known before sees the old order', { skip }, async () => {
  const quartz = current('quartz');
  assert.equal(quartz.priority, 1);
  const t0 = Date.now(); await sleep(15);
  const r = await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: 5, reason: 'try a lower rank' });
  await sleep(15);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.from, r.body.to, r.body.source], [1, 5, 'quartz']);
  const old = db.prepare('SELECT * FROM binding WHERE id = ?').get(quartz.id);
  assert.ok(old.superseded_at != null && old.priority === 1, 'the old row is kept, superseded, with its old priority');
  const now = current('quartz');
  assert.notEqual(now.id, quartz.id);
  assert.deepEqual([now.priority, now.role, now.valid_from, now.valid_to, now.device_id], [5, 'solar_forecast', quartz.valid_from, quartz.valid_to, quartz.device_id]);
  assert.equal(asKnown('quartz', t0), 1, 'as known before the change: the old priority');
  assert.equal(asKnown('quartz', Date.now()), 5, 'as known now: the new one');
  // put it back for the next tests
  await sleep(5);
  assert.equal((await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: now.id, priority: 1, reason: 'back' })).status, 200);
});

test('a dry run keeps nothing, and says whether built slots would change and so whether a reason is needed', { skip }, async () => {
  const core = current('core_forecast');
  const before = rows();
  const r = await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: core.id, priority: 7, dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.deepEqual([r.body.from, r.body.to, r.body.role], [0, 7, 'solar_forecast']);
  assert.equal(typeof r.body.needsReason, 'boolean');
  assert.equal(r.body.needsReason, r.body.impact.changed > 0);
  assert.ok(r.body.impact.slots > 0);
  assert.ok(r.body.would.some((b) => b.source === 'core_forecast' && b.priority === 7), 'the bindings that would result');
  assert.equal(rows(), before, 'nothing was recorded');
  assert.equal(current('core_forecast').priority, 0);
});

test('swapping the forecast order changes built slots: a reason is required, nothing is written without it, and the forecast column is in the impact', { skip }, async () => {
  const core = current('core_forecast');
  const prev = await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: core.id, priority: 3, dryRun: true });
  if (!prev.body.needsReason) return;   // the fixture's two forecasts agree everywhere: nothing to require (checked above)
  assert.ok(prev.body.impact.byField.solar_forecast, 'solar_forecast is a field the preview compares');
  const before = rows();
  const refused = await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: core.id, priority: 3 });
  assert.deepEqual([refused.status, refused.body.code, refused.body.field], [409, 'reason_required', 'reason']);
  assert.equal(rows(), before, 'a refused change writes nothing');
  const done = await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: core.id, priority: 3, reason: 'prefer Quartz this month' });
  assert.equal(done.status, 200);
  assert.ok(done.body.queued?.fromDate, 'the affected days are queued for a rebuild');
  assert.equal(current('core_forecast').reason, 'prefer Quartz this month');
});

test('errors: no change, an unknown or already replaced binding, a bad number', { skip }, async () => {
  const quartz = current('quartz');
  const ok = (r, status, code, field) => assert.deepEqual([r.status, r.body.code, r.body.field], [status, code, field]);
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: quartz.priority }), 400, 'no_change', 'priority');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: 999999, priority: 4 }), 404, 'not_found', 'bindingId');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { priority: 4 }), 400, 'missing_field', 'bindingId');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id }), 400, 'missing_field', 'priority');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: -1 }), 400, 'bad_number', 'priority');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: 100 }), 400, 'bad_number', 'priority');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: 2.5 }), 400, 'bad_number', 'priority');
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: quartz.id, priority: 'x' }), 400, 'bad_number', 'priority');
  const replaced = db.prepare('SELECT id FROM binding WHERE site_id = ? AND superseded_at IS NOT NULL LIMIT 1').get(SITE);
  ok(await post(`/api/sites/${SITE}/bindings/priority`, { bindingId: replaced.id, priority: 4 }), 404, 'not_found', 'bindingId');
  ok(await post('/api/sites/999/bindings/priority', { bindingId: 1, priority: 4 }), 404, 'not_found', undefined);
});
