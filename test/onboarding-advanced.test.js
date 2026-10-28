// The Advanced channel options of the mapping table (delta 072 and the access and allowed values of delta 067): they round trip
// through the API, every combination that makes no sense is refused with the field at fault, and a counter channel defined here
// works end to end through ingest. On a copy of the frozen real GB home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};
const { ingestObservations } = hasLive ? await import('../src/core/channels.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const SITE = 1;
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const plug = hasLive ? Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'smart_plug', 'push', 'adv-plug', 'Test plug', '{}', 0)").run(SITE).lastInsertRowid) : null;
const ch = (o) => post(`/api/sites/${SITE}/channels`, { source: 'push_native', metric: 'plug_counter_kwh', point: 'total', deviceId: plug, ...o });

test('every advanced field round trips: kind, derived measurement, wrap, reset, gap, stuck, clock offset, future tolerance, access, allowed values', { skip }, async () => {
  const c = await ch({ kind: 'counter', derived: 'plug_kwh', counterWrap: 99999.9, counterResetBelow: 0.5, maxGapS: 7200, clockOffsetS: -30, futureToleranceS: 120, min: 0 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const row = (await get(`/api/sites/${SITE}/channels?source=push_native`)).body.channels.find((x) => x.id === c.body.id);
  assert.deepEqual([row.kind, row.derived, row.counterWrap, row.counterResetBelow, row.maxGapS, row.clockOffsetS, row.futureToleranceS, row.maxStuckSamples, row.access],
    ['counter', 'plug_kwh', 99999.9, 0.5, 7200, -30, 120, null, 'read']);
  const v = await post(`/api/sites/${SITE}/channels`, { source: 'push_native', point: 'target', metric: 'plug_w', deviceId: plug, access: 'readwrite', enumValues: 'eco, comfort\nboost, eco', maxStuckSamples: 12 });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const vr = (await get(`/api/sites/${SITE}/channels?source=push_native`)).body.channels.find((x) => x.id === v.body.id);
  assert.deepEqual([vr.access, vr.enumValues, vr.maxStuckSamples, vr.kind, vr.derived], ['readwrite', ['eco', 'comfort', 'boost'], 12, 'value', null], 'allowed values split, trimmed and de-duplicated');
  const e = await post(`/api/sites/${SITE}/channels`, { source: 'push_native', point: 'door', metric: 'event_defrost', deviceId: plug, kind: 'event' });
  assert.equal(e.status, 201, JSON.stringify(e.body));
});

test('replacing a channel with different advanced options supersedes the old row (kept)', { skip }, async () => {
  const a = await ch({ point: 'repl', kind: 'counter', derived: 'plug_kwh', maxGapS: 600 });
  const b = await ch({ point: 'repl', kind: 'counter', derived: 'plug_kwh', maxGapS: 900 });
  assert.deepEqual(b.body.replaces, [a.body.id]);
  const all = (await get(`/api/sites/${SITE}/channels?source=push_native&all=1`)).body.channels.filter((x) => x.point === 'repl');
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.id === a.body.id).supersededAt != null, true);
  assert.equal(all.find((x) => x.id === b.body.id).maxGapS, 900);
});

test('combinations that make no sense are refused with the field at fault, and write nothing', { skip }, async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM channel').get().n;
  const cases = [
    [{ kind: 'counter' }, 400, 'missing_field', 'derived'],
    [{ kind: 'counter', derived: 'plug_counter_kwh' }, 400, 'bad_value', 'derived'],
    [{ kind: 'counter', derived: 'no_such_metric' }, 400, 'unknown_metric', 'metric'],
    [{ kind: 'wobbly' }, 400, 'bad_value', 'kind'],
    [{ derived: 'plug_kwh' }, 400, 'not_applicable', 'derived'],
    [{ counterWrap: 100 }, 400, 'not_applicable', 'counterWrap'],
    [{ counterResetBelow: 1 }, 400, 'not_applicable', 'counterResetBelow'],
    [{ maxGapS: 60 }, 400, 'not_applicable', 'maxGapS'],
    [{ kind: 'counter', derived: 'plug_kwh', counterWrap: 0 }, 400, 'bad_number', 'counterWrap'],
    [{ kind: 'counter', derived: 'plug_kwh', counterWrap: -1 }, 400, 'bad_number', 'counterWrap'],
    [{ kind: 'counter', derived: 'plug_kwh', maxGapS: 0 }, 400, 'bad_number', 'maxGapS'],
    [{ kind: 'counter', derived: 'plug_kwh', maxGapS: 1.5 }, 400, 'bad_number', 'maxGapS'],
    [{ kind: 'counter', derived: 'plug_kwh', maxStuckSamples: 5 }, 400, 'not_applicable', 'maxStuckSamples'],
    [{ kind: 'counter', derived: 'plug_kwh', enumValues: 'a,b' }, 400, 'not_applicable', 'enumValues'],
    [{ maxStuckSamples: 1 }, 400, 'bad_number', 'maxStuckSamples'],
    [{ clockOffsetS: 99999999 }, 400, 'bad_number', 'clockOffsetS'],
    [{ clockOffsetS: 'x' }, 400, 'bad_number', 'clockOffsetS'],
    [{ futureToleranceS: -1 }, 400, 'bad_number', 'futureToleranceS'],
    [{ access: 'sometimes' }, 400, 'bad_number', 'access'],
    [{ enumValues: Array.from({ length: 51 }, (_, i) => `v${i}`) }, 400, 'bad_value', 'enumValues'],
    [{ enumValues: 'x'.repeat(61) }, 400, 'bad_value', 'enumValues'],
  ];
  for (const [o, status, code, field] of cases) {
    const r = await ch({ point: 'bad', ...o });
    assert.deepEqual([r.status, r.body.code, r.body.field], [status, code, field], JSON.stringify(o).slice(0, 80));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM channel').get().n, before);
});

test('a dry run of an advanced channel validates it and keeps nothing', { skip }, async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM channel').get().n;
  const r = await ch({ point: 'dry', kind: 'counter', derived: 'plug_kwh', dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.channel.kind, 'counter');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM channel').get().n, before);
  assert.equal((await ch({ point: 'dry', kind: 'counter', dryRun: true })).status, 400, 'a dry run validates too');
});

test('a counter channel defined through the API works end to end: ingest derives the energy of each period', { skip }, async () => {
  const c = await ch({ point: 'e2e', kind: 'counter', derived: 'plug_kwh', min: 0, maxGapS: 7200 });
  assert.equal(c.status, 201);
  const t = 1_800_000_000 - (1_800_000_000 % 300);
  const res = ingestObservations(SITE, 'push_native', [{ point: 'e2e', ts: t, value: 10 }, { point: 'e2e', ts: t + 300, value: 10.5 }, { point: 'e2e', ts: t + 600, value: 11.25 }], null, { deviceId: plug, now: t + 900 });
  assert.equal(res.rejected, 0);
  assert.equal(res.counters, 3);
  const e = db.prepare(`SELECT f.start_ts, f.value FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN metric m ON m.id = s.metric_id
    WHERE m.code = 'plug_kwh' AND s.subject_kind = 'device' AND s.subject_id = ? AND f.start_ts >= ? AND f.superseded_at IS NULL ORDER BY f.start_ts`).all(String(plug), t);
  assert.deepEqual(e.map((x) => x.value), [0.5, 0.75], 'the counter difference of each period');
});
