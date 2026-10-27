// Stage 1: durable ingest. Facts written by a sync that stopped before its build must still be rebuilt by
// the next one, a batch with a repeated timestamp keeps one current row, and an empty answer is an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { seriesId, putReadings } = hasLive ? await import('../src/core/facts.js') : {};
const { sinceWatermark, earliestChange } = hasLive ? await import('../src/jobs/sync.js') : {};
const { defineChannel, ingestObservations } = hasLive ? await import('../src/core/channels.js') : {};

const SITE = 1;

test('a sync that stopped before its build leaves facts the next sync still rebuilds', { skip }, () => {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
  const nowS = Math.floor(Date.now() / 1000);
  const good = db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status) VALUES (?, ?, ?, 'ok')").run(SITE, nowS - 3000, nowS - 2900).lastInsertRowid;
  const crashed = db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status) VALUES (?, ?, ?, 'interrupted')").run(SITE, nowS - 1000, nowS - 1000).lastInsertRowid;
  // The crashed sync wrote a corrected value for an old slot, then stopped: no rebuild was queued.
  const id = seriesId('site', SITE, 'solar_w', 'sunsynk_5min');
  const old = db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND superseded_at IS NULL ORDER BY ts LIMIT 1 OFFSET 500').get(id);
  assert.equal(putReadings(id, [{ ts: old.ts, value: old.value + 123 }]), 1);

  const next = Number(db.prepare("INSERT INTO sync_run (site_id, started_at, status) VALUES (?, ?, 'running')").run(SITE, nowS).lastInsertRowid);
  const startMs = Date.now() + 50;   // this sync starts after the crashed one wrote its fact
  assert.equal(sinceWatermark(SITE, next, startMs), (nowS - 3000) * 1000, 'the watermark is the start of the last sync that reached its build');
  assert.equal(earliestChange(SITE, site, sinceWatermark(SITE, next, startMs)), old.ts, 'the corrected slot is found');
  assert.equal(earliestChange(SITE, site, startMs), null, 'measured from the start of this sync it would be lost');
  void good; void crashed;
});

test('a batch with a repeated timestamp keeps one current row, the last value', { skip }, () => {
  const id = seriesId('site', SITE, 'load_w', 'sunsynk_5min');
  const ts = 1900000000;
  putReadings(id, [{ ts, value: 1 }, { ts, value: 2 }]);
  const cur = db.prepare('SELECT value FROM reading WHERE series_id = ? AND ts = ? AND superseded_at IS NULL').all(id, ts);
  assert.deepEqual(cur.map((r) => r.value), [2]);
});

test('an empty answer is an error when data is required', { skip }, () => {
  db.prepare("INSERT INTO source (code, name, contract) VALUES ('empty_vendor', 'Empty (test)', '{}')").run();
  defineChannel(SITE, 'empty_vendor', 'p', 'solar_w');
  assert.throws(() => ingestObservations(SITE, 'empty_vendor', [], null, { requireData: true }), /empty answer/);
  assert.deepEqual(ingestObservations(SITE, 'empty_vendor', []), { written: 0, forecasts: 0, states: 0, counters: 0, derived: 0, stuck: 0, acks: [], rejected: 0, unmapped: [] }, 'without the option an empty batch is quiet');
});
