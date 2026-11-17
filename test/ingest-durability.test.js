// Stage 1: durable ingest. Facts written by a sync that stopped before its build must still be rebuilt by
// the next one, a batch with a repeated timestamp keeps one current row, and an empty answer is an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.json.gz (node scripts/make-fixture.js)';
if (hasLive) await useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { seriesId, putReadings } = await import('../src/core/facts.js');
const { sinceWatermark, earliestChange } = await import('../src/jobs/sync.js');
const { defineChannel, ingestObservations } = await import('../src/core/channels.js');

const SITE = 1;

await test('a sync that stopped before its build leaves facts the next sync still rebuilds', { skip }, async () => {
  const site = await db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
  const nowS = Math.floor(Date.now() / 1000);
  const good = (await db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status) VALUES (?, ?, ?, 'ok')").run(SITE, nowS - 3000, nowS - 2900)).lastInsertRowid;
  const crashed = (await db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status) VALUES (?, ?, ?, 'interrupted')").run(SITE, nowS - 1000, nowS - 1000)).lastInsertRowid;
  // The crashed sync wrote a corrected value for an old slot, then stopped: no rebuild was queued.
  const id = await seriesId('site', SITE, 'solar_w', 'sunsynk_5min');
  const old = await db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND superseded_at IS NULL ORDER BY ts LIMIT 1 OFFSET 500').get(id);
  assert.equal(await putReadings(id, [{ ts: old.ts, value: old.value + 123 }]), 1);

  const next = Number((await db.prepare("INSERT INTO sync_run (site_id, started_at, status) VALUES (?, ?, 'running')").run(SITE, nowS)).lastInsertRowid);
  const startMs = Date.now() + 50;   // this sync starts after the crashed one wrote its fact
  assert.equal(await sinceWatermark(SITE, next, startMs), (nowS - 3000) * 1000, 'the watermark is the start of the last sync that reached its build');
  assert.equal(await earliestChange(SITE, site, await sinceWatermark(SITE, next, startMs)), old.ts, 'the corrected slot is found');
  assert.equal(await earliestChange(SITE, site, startMs), null, 'measured from the start of this sync it would be lost');
  void good; void crashed;
});

await test('a batch with a repeated timestamp keeps one current row, the last value', { skip }, async () => {
  const id = await seriesId('site', SITE, 'load_w', 'sunsynk_5min');
  const ts = 1900000000;
  await putReadings(id, [{ ts, value: 1 }, { ts, value: 2 }]);
  const cur = await db.prepare('SELECT value FROM reading WHERE series_id = ? AND ts = ? AND superseded_at IS NULL').all(id, ts);
  assert.deepEqual(cur.map((r) => r.value), [2]);
});

await test('an empty answer is an error when data is required', { skip }, async () => {
  await db.prepare("INSERT INTO source (code, name, contract) VALUES ('empty_vendor', 'Empty (test)', '{}')").run();
  await defineChannel(SITE, 'empty_vendor', 'p', 'solar_w');
  await assert.rejects(async () => await ingestObservations(SITE, 'empty_vendor', [], null, { requireData: true }), /empty answer/);
  assert.deepEqual(await ingestObservations(SITE, 'empty_vendor', []), { written: 0, forecasts: 0, states: 0, counters: 0, derived: 0, stuck: 0, acks: [], rejected: 0, unmapped: [] }, 'without the option an empty batch is quiet');
});
