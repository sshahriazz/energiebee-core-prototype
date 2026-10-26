// Delta 013 and the bounded reads: series.max_span_s is kept by triggers, every read bounded below by
// it returns exactly the rows the unbounded read returns (current and "as known at"), the new indexes
// are the ones the planner uses, and PRAGMA optimize runs on close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db, optimizeDb } = await import('../src/db/db.js');
const { seriesId, putIntervals, putForecasts, readIntervals, readForecastOfRecord, spanOf, withKnownAt, inForce } = await import('../src/core/facts.js');

const siteId = Number(db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Home', 1, 'GB', 'GB', 'GBP')").run().lastInsertRowid);
const plan = (sql, ...a) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join('; ');

test('series.max_span_s follows the longest fact of a series and never shrinks', () => {
  const s = seriesId('site', siteId, 'gas_kwh', 'octopus_meter');
  assert.equal(spanOf([s]), null, 'no fact yet: no bound');
  putIntervals(s, [{ start: 1000, end: 2800, value: 1 }]);
  assert.equal(spanOf([s]), 1800);
  putIntervals(s, [{ start: 5000, end: 5000 + 90000, value: 2 }]);
  assert.equal(spanOf([s]), 90000, 'a 25-hour day (clocks go back)');
  putIntervals(s, [{ start: 200000, end: 201800, value: 3 }]);
  assert.equal(spanOf([s]), 90000);
  const f = seriesId('site', siteId, 'solar_kwh', 'quartz');
  putForecasts(f, 100, [{ start: 1000, end: 1900, value: 1 }]);
  assert.equal(spanOf([f]), 900);
  assert.equal(spanOf([s, f]), 90000, 'several series: the longest');
  assert.equal(spanOf([s, seriesId('site', siteId, 'ev_charge_kwh', 'octopus_kraken')]), null, 'one series without facts: no bound at all');
});

test('readIntervals bounded below gives exactly the rows of the unbounded read (random facts, current and as known at)', () => {
  const s = seriesId('site', siteId, 'solar_kwh', 'sunsynk_daily');
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  // Versions written directly, each recorded 1 ms after the last (putIntervals stamps Date.now()).
  const sup = db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
  const ins = db.prepare('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at) VALUES (?, ?, ?, ?, 1, ?)');
  for (let i = 0; i < 300; i++) {
    const start = 1700000000 + rnd(40) * 1800;
    const len = [1800, 3600, 86400, 90000, 82800][rnd(5)];
    sup.run(1000 + i, s, start, start + len);
    ins.run(s, start, start + len, rnd(100), 1000 + i);
  }
  assert.equal(spanOf([s]), 90000, 'kept by the trigger for rows written by any writer');
  const unbounded = (from, to) => db.prepare(`SELECT series_id, start_ts, end_ts, value, quality, raw_id FROM interval_fact
    WHERE series_id IN (?) AND end_ts > ? AND start_ts < ? AND ${inForce()} ORDER BY start_ts`).all(s, from, to);
  const asOf = db.prepare('SELECT MAX(recorded_at) AS t FROM interval_fact WHERE series_id = ?').get(s).t - 1;
  for (let k = 0; k < 120; k++) {
    const from = 1700000000 - 90000 + rnd(200) * 900;
    const to = from + 1 + rnd(4) * 3600;
    assert.deepEqual(readIntervals([s], from, to), unbounded(from, to), `[${from}, ${to})`);
    withKnownAt(asOf, () => assert.deepEqual(readIntervals([s], from, to), unbounded(from, to), `as known at, [${from}, ${to})`));
  }
  assert.match(plan(`SELECT * FROM interval_fact WHERE series_id IN (?) AND end_ts > ? AND start_ts < ? AND start_ts >= ? AND superseded_at IS NULL ORDER BY start_ts`, s, 1, 2, 0),
    /\(series_id=\? AND start_ts>\? AND start_ts<\?\)/, 'a range on the key, not the whole history');
});

test('readForecastOfRecord: the outer read is bounded too and gives the same rows', () => {
  const f = seriesId('site', siteId, 'carbon_intensity', 'carbon_regional');
  for (let iss = 0; iss < 5; iss++) putForecasts(f, 1700000000 + iss * 600, Array.from({ length: 96 }, (_, i) => ({ start: 1700000000 + i * 1800, end: 1700001800 + i * 1800, value: (i * 7 + iss) % 13 })));
  const unbounded = (from, to, asOf) => db.prepare(`SELECT f.start_ts, f.end_ts, f.value, f.issued_at FROM forecast_fact f
     JOIN (SELECT start_ts, MAX(issued_at) AS iss FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= ? GROUP BY start_ts) last
       ON last.start_ts = f.start_ts AND last.iss = f.issued_at WHERE f.series_id = ? ORDER BY f.start_ts`).all(f, from, to, asOf, f);
  for (const [from, to, asOf] of [[1700000000, 1700086400, 1700003000], [1700036000, 1700090000, 1700001000], [1699990000, 1700200000, 1800000000]]) {
    assert.deepEqual(readForecastOfRecord(f, from, to, asOf), unbounded(from, to, asOf));
  }
});

test('the reads use the new indexes', () => {
  const t = Number(db.prepare("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, region, currency, country) VALUES ('t', 'T-IDX', 'electricity', 'import', 'iog', 'G', 'GBP', 'GB')").run().lastInsertRowid);
  const asOf = withKnownAt(5, () => inForce());
  assert.match(plan(`SELECT * FROM rate_interval WHERE tariff_id IN (?) AND ${asOf} AND valid_from < ? ORDER BY valid_from`, t, 1), /USING INDEX rate_asof/, 'rates as known at: no scan');
  assert.match(plan(`SELECT * FROM tariff_agreement a WHERE a.site_id = ? AND ${withKnownAt(5, () => inForce('a'))} AND a.valid_from < ?`, siteId, 1), /USING INDEX agreement_site_asof/);
  assert.match(plan("SELECT r.id FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.structure = 'iog' AND t.region = ? AND r.component = 'unit' AND r.register = 'single' AND r.superseded_at IS NULL", 'G'), /tariff_structure_region/);
  assert.match(plan('SELECT MAX(issued_at) FROM forecast_fact WHERE series_id = ?', 1), /forecast_issued/);
  assert.match(plan('SELECT * FROM sync_run WHERE site_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at', 1, 0, 1), /sync_run_site_started/);
  assert.match(plan("SELECT * FROM raw_payload WHERE site_id = ? AND status = 'quarantined' AND fetched_at >= ?", 1, 0), /raw_payload_site_status/);
  for (const [table, index] of [['reading', 'reading_raw'], ['interval_fact', 'interval_fact_raw'], ['forecast_fact', 'forecast_fact_raw'], ['rate_interval', 'rate_interval_raw']]) {
    assert.match(plan(`SELECT 1 FROM ${table} WHERE raw_id = ?`, 1), new RegExp(index), `${table}.raw_id`);
  }
});

test('the /now carbon read and the loadPricing dispatches find a fact longer than the window', async () => {
  const { loadPricing } = await import('../src/core/pricing.js');
  const ev = seriesId('site', siteId, 'ev_charge_kwh', 'octopus_kraken');
  putIntervals(ev, [{ start: 1760000000, end: 1760000000 + 6 * 3600, value: 7 }]);
  // The window starts 5 hours into the dispatch: read from a day earlier, it is found either way.
  const p = loadPricing(siteId, 1760000000 + 5 * 3600 + 86400, 1760000000 + 6 * 3600 + 86400);
  assert.deepEqual(p.dispatches.map((d) => [d.start_ts, d.end_ts]), [[1760000000, 1760000000 + 6 * 3600]]);
  db.prepare("UPDATE site SET carbon_region = 3 WHERE id = ?").run(siteId);
  const c = seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional');
  putForecasts(c, 1, [{ start: 1760000000, end: 1760000000 + 4 * 3600, value: 123 }]);
  const row = db.prepare(`SELECT f.value FROM forecast_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id
     WHERE se.subject_kind = 'region' AND se.subject_id = ? AND m.code = 'carbon_intensity' AND f.start_ts <= ? AND f.end_ts > ?
       AND f.start_ts >= ? - IFNULL(se.max_span_s, 9000000000) ORDER BY f.issued_at DESC, f.start_ts DESC LIMIT 1`).get('carbon:3', 1760000000 + 3 * 3600, 1760000000 + 3 * 3600, 1760000000 + 3 * 3600);
  assert.equal(row?.value, 123, 'a 4-hour period still covers the slot 3 hours in');
});

test('PRAGMA optimize: optimizeDb runs and leaves planner statistics', () => {
  db.exec('ANALYZE sqlite_schema');   // make sure sqlite_stat1 exists, as on a database that has been optimised before
  assert.equal(optimizeDb(), true);
  db.exec('PRAGMA optimize = 0x10002');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get().n === 1);
});
