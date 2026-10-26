// forecast_fact is bitemporal (delta 040, database review M11): recorded_at (ms) says when the core
// stored an issue, readForecastAsOf reads what was recorded by a moment, and end_ts is in the key so
// a period of another length from the same start is kept. Also: the delta rebuilds an old-shape
// table keeping every row and every index and trigger other deltas put on it, and runs once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db, applyDeltas } = await import('../src/db/db.js');
const { seriesId, putForecasts, readForecastOfRecord, readForecastAsOf } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');

const site = createSite({ name: 'Forecast home', isDemo: true });
const sid = (metric, source) => seriesId('site', site.id, metric, source);
const T = 1_800_000_000;   // a period start, s
const rowsOf = (s) => db.prepare('SELECT start_ts, end_ts, issued_at, value, recorded_at FROM forecast_fact WHERE series_id = ? ORDER BY start_ts, end_ts, issued_at').all(s).map((r) => ({ ...r }));

test('the table has recorded_at and end_ts in its key; the indexes and triggers of 013 and 040 are there', () => {
  const cols = db.prepare("SELECT name, pk FROM pragma_table_info('forecast_fact')").all().map((c) => ({ ...c }));
  assert.ok(cols.some((c) => c.name === 'recorded_at'));
  assert.deepEqual(cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name), ['series_id', 'start_ts', 'end_ts', 'issued_at']);
  const objs = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'forecast_fact' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all().map((r) => r.name);
  assert.ok(objs.includes('forecast_recorded'));
});

test('readForecastAsOf uses the time the core recorded an issue, not the provider\'s issue time', () => {
  const s = sid('solar_kwh', 'quartz');
  const p = (i, v) => ({ start: T + i * 900, end: T + (i + 1) * 900, value: v });
  // Issue A: provider time T-3600, fetched (recorded) at R1. Issue B: the provider stamps it EARLIER
  // (T-7200) but the core only fetched it at R2, later: an as-of read at R1 must not see it.
  const R1 = (T - 3000) * 1000; const R2 = (T - 1000) * 1000;
  assert.equal(putForecasts(s, T - 3600, [p(0, 1), p(1, 2), p(2, 3)], null, { recordedAt: R1 }), 3);
  assert.equal(putForecasts(s, T - 7200 + 1, [p(0, 1), p(1, 2.5), p(2, 3)], null, { recordedAt: R2 }), 1, 'change-only: only the changed period');
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, R1).map((f) => f.value), [1, 2, 3]);
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, R2).map((f) => f.value), [1, 2, 3], 'B was issued before A, so A stays the latest issue');
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, R2 - 1).map((f) => f.recorded_at), [R1, R1, R1]);
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, R1 - 1), [], 'nothing recorded yet');
  // readForecastOfRecord keeps its rule (issue time): unchanged.
  assert.deepEqual(readForecastOfRecord(s, T, T + 2700, T).map((f) => f.value), [1, 2, 3]);
  // A later issue that changes a value is the record from when it was recorded.
  putForecasts(s, T - 600, [p(1, 4)], null, { recordedAt: (T - 500) * 1000 });
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, (T - 500) * 1000).map((f) => f.value), [1, 4, 3]);
  assert.deepEqual(readForecastAsOf([s], T, T + 2700, (T - 501) * 1000).map((f) => f.value), [1, 2, 3]);
});

test('same start, another length: both kept (the old key dropped the second without a word)', () => {
  const s = sid('carbon_intensity', 'carbon_regional');
  assert.equal(putForecasts(s, T - 3600, [{ start: T, end: T + 1800, value: 100 }, { start: T, end: T + 900, value: 100 }], null, { recordedAt: (T - 3600) * 1000 }), 2);
  assert.deepEqual(rowsOf(s).map((r) => [r.end_ts - r.start_ts, r.value]), [[900, 100], [1800, 100]]);
  // Change-only per period (start AND end): the same values again store nothing.
  assert.equal(putForecasts(s, T - 1800, [{ start: T, end: T + 1800, value: 100 }, { start: T, end: T + 900, value: 100 }]), 0);
});

test('a provider that moves from 30 to 15-minute periods: the later issue is the record for that time', () => {
  const s = sid('load_kwh', 'core_forecast');
  putForecasts(s, T - 7200, [{ start: T, end: T + 1800, value: 1 }, { start: T + 1800, end: T + 3600, value: 1 }], null, { recordedAt: (T - 7200) * 1000 });
  putForecasts(s, T - 3600, [{ start: T, end: T + 900, value: 0.4 }, { start: T + 900, end: T + 1800, value: 0.6 }], null, { recordedAt: (T - 3600) * 1000 });
  const now = readForecastAsOf([s], T, T + 3600, T * 1000);
  assert.deepEqual(now.map((f) => [f.start_ts - T, f.end_ts - T, f.value]), [[0, 900, 0.4], [900, 1800, 0.6], [1800, 3600, 1]]);
  const before = readForecastAsOf([s], T, T + 3600, (T - 3601) * 1000);
  assert.deepEqual(before.map((f) => [f.start_ts - T, f.end_ts - T, f.value]), [[0, 1800, 1], [1800, 3600, 1]]);
});

test('delta 040 rebuilds an old-shape table: every row kept, recorded_at = issued_at x 1000, indexes and triggers restored, once', () => {
  const s = sid('solar_kwh', 'core_forecast');
  putForecasts(s, T - 100, [{ start: T, end: T + 900, value: 0.5 }, { start: T + 900, end: T + 1800, value: null }]);
  // Two lengths from one start (the test above) could never exist under the old key.
  db.prepare('DELETE FROM forecast_fact WHERE series_id = ?').run(sid('carbon_intensity', 'carbon_regional'));
  const keep = db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'forecast_fact' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all().map((r) => `${r.type}:${r.name}`);
  const before = db.prepare('SELECT series_id, start_ts, end_ts, issued_at, value, raw_id FROM forecast_fact ORDER BY 1, 2, 3, 4').all().map((r) => ({ ...r }));
  // Put the table back as it was before 040 (old key, no recorded_at), with the other deltas' objects.
  const others = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'forecast_fact' AND type IN ('index', 'trigger') AND sql IS NOT NULL AND name != 'forecast_recorded'").all().map((r) => r.sql);
  db.exec(`BEGIN; CREATE TEMP TABLE ff AS SELECT series_id, start_ts, end_ts, issued_at, value, raw_id FROM forecast_fact; DROP TABLE forecast_fact;
    CREATE TABLE forecast_fact (series_id INTEGER NOT NULL REFERENCES series(id), start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, issued_at INTEGER NOT NULL,
      value REAL, raw_id INTEGER REFERENCES raw_payload(id), PRIMARY KEY (series_id, start_ts, issued_at), CHECK (end_ts > start_ts)) WITHOUT ROWID;
    INSERT INTO forecast_fact SELECT * FROM temp.ff; DROP TABLE temp.ff; ${others.map((x) => `${x};`).join('\n')}
    DELETE FROM schema_delta WHERE name = '040-forecast-bitemporal'; COMMIT;`);
  assert.ok(!db.prepare("SELECT 1 FROM pragma_table_info('forecast_fact') WHERE name = 'recorded_at'").get());
  applyDeltas();
  const after = db.prepare('SELECT series_id, start_ts, end_ts, issued_at, value, raw_id FROM forecast_fact ORDER BY 1, 2, 3, 4').all().map((r) => ({ ...r }));
  assert.deepEqual(after, before, 'every row, unchanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM forecast_fact WHERE recorded_at != issued_at * 1000').get().n, 0, 'recorded_at backfilled from issued_at');
  assert.deepEqual(db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'forecast_fact' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all().map((r) => `${r.type}:${r.name}`), keep);
  assert.ok(db.prepare("SELECT 1 FROM schema_delta WHERE name = '040-forecast-bitemporal'").get());
  // Recorded, with every object present: a second pass changes nothing.
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const v = db.prepare('PRAGMA schema_version').get().schema_version;
  applyDeltas();
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(db.prepare('PRAGMA schema_version').get().schema_version, v);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check(forecast_fact)').all(), []);
});
