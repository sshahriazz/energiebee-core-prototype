// forecast_fact is bitemporal (delta 040, database review M11): recorded_at (ms) says when the core
// stored an issue, readForecastAsOf reads what was recorded by a moment, and end_ts is in the key so
// a period of another length from the same start is kept. Also: the delta rebuilds an old-shape
// table keeping every row and every index and trigger other deltas put on it, and runs once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db, columnsOf, primaryKey } = await import('../src/db/db.js');
const { seriesId, putForecasts, readForecastOfRecord, readForecastAsOf } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');

const site = await createSite({ name: 'Forecast home', isDemo: true });
const sid = async (metric, source) => await seriesId('site', site.id, metric, source);
const T = 1_800_000_000;   // a period start, s
const rowsOf = async (s) => (await db.prepare('SELECT start_ts, end_ts, issued_at, value, recorded_at FROM forecast_fact WHERE series_id = ? ORDER BY start_ts, end_ts, issued_at').all(s)).map((r) => ({ ...r }));

await test('the table has recorded_at and end_ts in its key; its indexes and span triggers are there', async () => {
  assert.ok((await columnsOf('forecast_fact')).includes('recorded_at'));
  assert.deepEqual(await primaryKey('forecast_fact'), ['series_id', 'start_ts', 'end_ts', 'issued_at']);
  const idx = (await db.prepare("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'forecast_fact'").all()).map((r) => r.name);
  for (const i of ['forecast_recorded', 'forecast_issued', 'forecast_fact_raw']) assert.ok(idx.includes(i), i);
  const trg = (await db.prepare("SELECT tgname AS name FROM pg_trigger WHERE tgrelid = 'forecast_fact'::regclass AND NOT tgisinternal").all()).map((r) => r.name);
  assert.deepEqual(trg.sort(), ['forecast_fact_span_insert', 'forecast_fact_span_update']);
});

await test('readForecastAsOf uses the time the core recorded an issue, not the provider\'s issue time', async () => {
  const s = await sid('solar_kwh', 'quartz');
  const p = (i, v) => ({ start: T + i * 900, end: T + (i + 1) * 900, value: v });
  // Issue A: provider time T-3600, fetched (recorded) at R1. Issue B: the provider stamps it EARLIER
  // (T-7200) but the core only fetched it at R2, later: an as-of read at R1 must not see it.
  const R1 = (T - 3000) * 1000; const R2 = (T - 1000) * 1000;
  assert.equal(await putForecasts(s, T - 3600, [p(0, 1), p(1, 2), p(2, 3)], null, { recordedAt: R1 }), 3);
  assert.equal(await putForecasts(s, T - 7200 + 1, [p(0, 1), p(1, 2.5), p(2, 3)], null, { recordedAt: R2 }), 1, 'change-only: only the changed period');
  assert.deepEqual((await readForecastAsOf([s], T, T + 2700, R1)).map((f) => f.value), [1, 2, 3]);
  assert.deepEqual((await readForecastAsOf([s], T, T + 2700, R2)).map((f) => f.value), [1, 2, 3], 'B was issued before A, so A stays the latest issue');
  assert.deepEqual((await readForecastAsOf([s], T, T + 2700, R2 - 1)).map((f) => f.recorded_at), [R1, R1, R1]);
  assert.deepEqual(await readForecastAsOf([s], T, T + 2700, R1 - 1), [], 'nothing recorded yet');
  // readForecastOfRecord keeps its rule (issue time): unchanged.
  assert.deepEqual((await readForecastOfRecord(s, T, T + 2700, T)).map((f) => f.value), [1, 2, 3]);
  // A later issue that changes a value is the record from when it was recorded.
  await putForecasts(s, T - 600, [p(1, 4)], null, { recordedAt: (T - 500) * 1000 });
  assert.deepEqual((await readForecastAsOf([s], T, T + 2700, (T - 500) * 1000)).map((f) => f.value), [1, 4, 3]);
  assert.deepEqual((await readForecastAsOf([s], T, T + 2700, (T - 501) * 1000)).map((f) => f.value), [1, 2, 3]);
});

await test('same start, another length: both kept (the old key dropped the second without a word)', async () => {
  const s = await sid('carbon_intensity', 'carbon_regional');
  assert.equal(await putForecasts(s, T - 3600, [{ start: T, end: T + 1800, value: 100 }, { start: T, end: T + 900, value: 100 }], null, { recordedAt: (T - 3600) * 1000 }), 2);
  assert.deepEqual((await rowsOf(s)).map((r) => [r.end_ts - r.start_ts, r.value]), [[900, 100], [1800, 100]]);
  // Change-only per period (start AND end): the same values again store nothing.
  assert.equal(await putForecasts(s, T - 1800, [{ start: T, end: T + 1800, value: 100 }, { start: T, end: T + 900, value: 100 }]), 0);
});

await test('a provider that moves from 30 to 15-minute periods: the later issue is the record for that time', async () => {
  const s = await sid('load_kwh', 'core_forecast');
  await putForecasts(s, T - 7200, [{ start: T, end: T + 1800, value: 1 }, { start: T + 1800, end: T + 3600, value: 1 }], null, { recordedAt: (T - 7200) * 1000 });
  await putForecasts(s, T - 3600, [{ start: T, end: T + 900, value: 0.4 }, { start: T + 900, end: T + 1800, value: 0.6 }], null, { recordedAt: (T - 3600) * 1000 });
  const now = await readForecastAsOf([s], T, T + 3600, T * 1000);
  assert.deepEqual(now.map((f) => [f.start_ts - T, f.end_ts - T, f.value]), [[0, 900, 0.4], [900, 1800, 0.6], [1800, 3600, 1]]);
  const before = await readForecastAsOf([s], T, T + 3600, (T - 3601) * 1000);
  assert.deepEqual(before.map((f) => [f.start_ts - T, f.end_ts - T, f.value]), [[0, 1800, 1], [1800, 3600, 1]]);
});

