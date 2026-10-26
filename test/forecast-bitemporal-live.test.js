// Delta 040 on a private copy of data/core.db: the forecast reads give the same rows after the table
// rebuild as before it. "Before" is read with plain SQL from the copy before src/db/db.js opens it
// (db.js applies the delta on import); "after" with the same SQL and with readForecastOfRecord. The
// SQL is the selection each reader makes: the build's solar forecast of record (quartz, then
// core_forecast; issued before the period started), scoreAccuracy's (issued 12 h before the end),
// Quartz's history (forecast.js quartzOfRecord) and the forecast of record at a moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
const file = hasLive ? useDb({ snapshot: true }) : null;
const SITE = 1;
const asOf = hasLive ? JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'golden-gb.json'), 'utf8')).asOf : 0;
const LEAD = 12 * 3600;

const seriesSql = `SELECT se.id, m.code AS metric, so.code AS source FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
  WHERE se.id IN (SELECT DISTINCT series_id FROM forecast_fact) ORDER BY se.id`;
const hash = (rows) => createHash('sha256').update(JSON.stringify(rows.map((r) => ({ ...r })))).digest('hex');

function reads(c) {
  const out = {};
  const series = c.prepare(seriesSql).all();
  out.series = series.length;
  out.content = hash(c.prepare('SELECT series_id, start_ts, end_ts, issued_at, value, raw_id FROM forecast_fact ORDER BY series_id, start_ts, end_ts, issued_at').all());
  out.count = c.prepare('SELECT COUNT(*) AS n FROM forecast_fact').get().n;
  const solar = (source) => series.find((s) => s.metric === 'solar_kwh' && s.source === source);
  for (const source of ['quartz', 'core_forecast']) {
    const s = solar(source);
    if (!s) continue;
    // build.js solarFc (window: all time, now = the golden moment) and forecast.js quartzOfRecord.
    out[`build_${source}`] = hash(c.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts AND issued_at <= ?').all(s.id, 0, 4e9, asOf));
    out[`history_${source}`] = hash(c.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts').all(s.id, 0, 4e9));
  }
  const load = series.find((s) => s.metric === 'load_kwh' && s.source === 'core_forecast');
  if (load) out.score = hash(c.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND issued_at <= end_ts - ? ORDER BY start_ts').all(load.id, 0, 4e9, LEAD));
  // The forecast of record of every series at the golden moment (readForecastOfRecord's SQL).
  out.record = Object.fromEntries(series.map((s) => [s.id, hash(c.prepare(`SELECT f.start_ts, f.end_ts, f.value, f.issued_at FROM forecast_fact f
     JOIN (SELECT start_ts, MAX(issued_at) AS iss FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= ? GROUP BY start_ts) last
       ON last.start_ts = f.start_ts AND last.iss = f.issued_at
     WHERE f.series_id = ? AND f.start_ts >= ? AND f.start_ts < ? ORDER BY f.start_ts`).all(s.id, 0, 4e9, asOf, s.id, 0, 4e9))]));
  return out;
}

let before = null;
if (hasLive) {
  const c = new DatabaseSync(file, { readOnly: true });
  before = { ...reads(c), oldShape: !c.prepare("SELECT 1 FROM pragma_table_info('forecast_fact') WHERE name = 'recorded_at'").get() };
  c.close();
}
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { readForecastOfRecord } = hasLive ? await import('../src/core/facts.js') : {};

test('every forecast read gives the same rows after delta 040 as before it', { skip }, () => {
  const after = reads(db);
  const { oldShape, ...b } = before;
  assert.deepEqual(after, b);
  assert.ok(b.count > 0, 'the copy holds forecasts');
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('forecast_fact') WHERE name = 'recorded_at'").get());
  if (oldShape) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM forecast_fact WHERE recorded_at != issued_at * 1000').get().n, 0, 'backfilled from issued_at');
  // The exported reader agrees with its SQL on every series.
  for (const s of db.prepare(seriesSql).all()) {
    assert.equal(hash(readForecastOfRecord(s.id, 0, 4e9, asOf)), after.record[s.id], `series ${s.id} (${s.metric}/${s.source})`);
  }
});

test('the GB home has no heating series: site_heat_slot stays empty', { skip }, async () => {
  const { hasHeatingSeries } = await import('../src/core/heat.js');
  assert.equal(hasHeatingSeries(SITE), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_heat_slot').get().n, 0);
});
