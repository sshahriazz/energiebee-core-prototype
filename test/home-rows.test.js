// Every series, fact, slot and raw row of a home carries the home (fix list R4): set on insert, never derived at read time.
// Shared context (a region's carbon series, the tariff catalogue's receipts) has none. Checked on the frozen GB home and on
// what the app's own write paths store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
if (hasLive) await useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { seriesId, putReadings, putIntervals, putForecasts } = await import('../src/core/facts.js');
const count = async (sql, ...p) => Number((await db.prepare(sql).get(...p)).n);

await test('series: a home\'s or a device\'s series has that home; only shared subjects have none', { skip }, async () => {
  assert.equal(await count("SELECT COUNT(*) AS n FROM series WHERE subject_kind IN ('site', 'device') AND site_id IS NULL"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM series WHERE subject_kind NOT IN ('site', 'device') AND site_id IS NOT NULL"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM series s JOIN device d ON d.id = s.subject_id::bigint WHERE s.subject_kind = 'device' AND s.site_id <> d.site_id"), 0);
});

await test('facts: every reading, interval and forecast has its series\' home', { skip }, async () => {
  for (const t of ['reading', 'interval_fact', 'forecast_fact']) {
    assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} f JOIN series s ON s.id = f.series_id WHERE f.site_id IS DISTINCT FROM s.site_id`), 0, t);
    assert.ok(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id IS NOT NULL`) > 0, `${t} has home rows`);
  }
});

await test('slots and raw rows: every slot row has its home; a raw row without one is shared context', { skip }, async () => {
  for (const t of ['site_hh', 'site_day', 'check_result']) assert.equal(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id IS NULL`), 0, t);
  const homeless = await db.prepare('SELECT DISTINCT so.code FROM raw_payload r JOIN source so ON so.id = r.source_id WHERE r.site_id IS NULL').all();
  assert.deepEqual(homeless.map((r) => r.code).filter((c) => !['tariffscanner', 'octopus_rates', 'carbon_regional', 'rte_eco2mix', 'national_gas_cv'].includes(c)), []);
});

await test('the write paths: facts written through facts.js take their home from the series', { skip }, async () => {
  const r = await seriesId('site', 1, 'solar_w', 'sunsynk_5min');
  await putReadings(r, [{ ts: 1_900_000_000, value: 5 }]);
  const i = await seriesId('site', 1, 'solar_kwh', 'quartz');
  await putIntervals(i, [{ start: 1_900_000_000, end: 1_900_001_800, value: 1 }]);
  await putForecasts(i, 1_899_000_000, [{ start: 1_900_000_000, end: 1_900_001_800, value: 1 }]);
  const region = await seriesId('region', 'G', 'carbon_intensity', 'carbon_regional');
  await putIntervals(region, [{ start: 1_900_000_000, end: 1_900_001_800, value: 100 }]);
  assert.equal((await db.prepare('SELECT site_id FROM reading WHERE series_id = ? AND ts = 1900000000').get(r)).site_id, 1);
  assert.equal((await db.prepare('SELECT site_id FROM interval_fact WHERE series_id = ? AND start_ts = 1900000000').get(i)).site_id, 1);
  assert.equal((await db.prepare('SELECT site_id FROM forecast_fact WHERE series_id = ? AND start_ts = 1900000000').get(i)).site_id, 1);
  assert.equal((await db.prepare('SELECT site_id FROM interval_fact WHERE series_id = ? AND start_ts = 1900000000').get(region)).site_id, null, 'shared context has no home');
});
