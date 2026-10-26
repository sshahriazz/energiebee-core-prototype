// Open-Meteo (src/adapters/openmeteo.js) with humidity, dew point and wind in the SAME request,
// and every variable's future hours stored as change-only forecast issues. A fake fetch answers
// with a SYNTHETIC fixture (test/fixtures/openmeteo/forecast-hourly.synthetic.json: the documented
// response shape, invented values) and a fixed clock; no network call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { syncWeather } = await import('../src/adapters/openmeteo.js');
const { seriesId, readForecastOfRecord, readForecastAsOf, readReadings } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'openmeteo', 'forecast-hourly.synthetic.json'), 'utf8'));
const NOW = Date.UTC(2026, 9, 21, 12, 0) / 1000;   // hour 36 of the fixture: 37 past hours (t <= now), 35 future
const calls = [];
let answer = fixture;
globalThis.fetch = async (url) => {
  calls.push(new URL(String(url)));
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};
const realNow = Date.now;
const at = async (sec, fn) => { Date.now = () => sec * 1000; try { return await fn(); } finally { Date.now = realNow; } };

const site = createSite({ name: 'Weather home', lat: 53.48, lon: -2.24, isDemo: true });
const sid = (metric) => seriesId('site', site.id, metric, 'open_meteo');
const forecastRows = (metric) => db.prepare('SELECT COUNT(*) AS n FROM forecast_fact WHERE series_id = ?').get(sid(metric)).n;
const NEW = ['humidity_pct', 'dew_point_c', 'wind_speed_ms'];

test('one request per sync asks for humidity, dew point and wind in m/s with the existing variables', async () => {
  const r = await at(NOW, () => syncWeather(site, 1));
  assert.equal(calls.length, 1, 'exactly one request');
  const hourly = calls[0].searchParams.get('hourly').split(',');
  for (const v of ['temperature_2m', 'cloud_cover', 'shortwave_radiation', 'relative_humidity_2m', 'dew_point_2m', 'wind_speed_10m']) assert.ok(hourly.includes(v), v);
  assert.equal(calls[0].searchParams.get('wind_speed_unit'), 'ms');
  assert.equal(calls[0].searchParams.get('timeformat'), 'unixtime');
  assert.ok(r.facts > 0 && r.forecasts > 0);
});

test('past hours are facts, future hours forecast issues issued now, for the old and the new variables', () => {
  for (const m of ['outdoor_temp_c', 'cloud_pct', ...NEW]) {
    assert.equal(readReadings([sid(m)], 0, 2e9).length, 37, `${m}: 37 past hours`);
    assert.equal(forecastRows(m), 35, `${m}: 35 future hours`);
  }
  const wind = readForecastOfRecord(sid('wind_speed_ms'), NOW, NOW + 3 * 86400, NOW);
  const i = fixture.hourly.time.indexOf(NOW + 3600);
  assert.equal(wind[0].start_ts, NOW + 3600);
  assert.equal(wind[0].end_ts, NOW + 7200);
  assert.equal(wind[0].value, fixture.hourly.wind_speed_10m[i]);
  assert.equal(wind[0].issued_at, NOW);
  // The outdoor temperature forecast a planner reads: outdoor_temp_c / open_meteo in forecast_fact, hourly.
  const temp = readForecastOfRecord(sid('outdoor_temp_c'), NOW, NOW + 3 * 86400, NOW);
  assert.deepEqual(temp.slice(0, 3).map((f) => f.value), fixture.hourly.temperature_2m.slice(i, i + 3));
});

test('change-only: the same answer again stores nothing; three changed hours store three rows', async () => {
  const again = await at(NOW + 600, () => syncWeather(site, 1));
  assert.equal(calls.length, 2);
  assert.deepEqual([again.facts, again.forecasts], [0, 0]);
  const changed = structuredClone(fixture);
  const i = fixture.hourly.time.indexOf(NOW + 7200);
  for (const k of [i, i + 1, i + 2]) changed.hourly.temperature_2m[k] += 1.5;
  answer = changed;
  const r = await at(NOW + 1200, () => syncWeather(site, 1));
  answer = fixture;
  assert.equal(r.forecasts, 3);
  assert.equal(forecastRows('outdoor_temp_c'), 38);
  for (const m of NEW) assert.equal(forecastRows(m), 35, `${m} unchanged`);
  // Bitemporal: as known before the changed issue was recorded, the old values; after it, the new.
  const s = sid('outdoor_temp_c');
  const ms = db.prepare('SELECT MIN(recorded_at) AS a, MAX(recorded_at) AS b FROM forecast_fact WHERE series_id = ?').get(s);
  assert.ok(ms.b > ms.a, 'the later issue has a later recorded_at');
  const old = readForecastAsOf([s], NOW + 7200, NOW + 7200 + 3 * 3600, ms.a);
  const now = readForecastAsOf([s], NOW + 7200, NOW + 7200 + 3 * 3600, ms.b);
  assert.deepEqual(old.map((f) => f.value), fixture.hourly.temperature_2m.slice(i, i + 3));
  assert.deepEqual(now.map((f) => f.value), changed.hourly.temperature_2m.slice(i, i + 3));
  assert.ok(now.every((f) => f.issued_at === NOW + 1200 && f.recorded_at === (NOW + 1200) * 1000));
});

test('an answer without the new variables stores the old ones and creates no empty series', async () => {
  const other = createSite({ name: 'Old answer home', lat: 51.5, lon: -0.1, isDemo: true });
  const { relative_humidity_2m, dew_point_2m, wind_speed_10m, ...rest } = fixture.hourly;
  answer = { ...fixture, hourly: rest };
  try {
    const r = await at(NOW, () => syncWeather(other, 1));
    assert.ok(r.facts > 0 && r.forecasts > 0);
  } finally { answer = fixture; }
  const made = db.prepare(`SELECT m.code FROM series se JOIN metric m ON m.id = se.metric_id WHERE se.subject_kind = 'site' AND se.subject_id = ?`).all(String(other.id)).map((x) => x.code);
  for (const m of NEW) assert.ok(!made.includes(m), m);
  assert.ok(made.includes('outdoor_temp_c'));
});
