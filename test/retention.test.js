// Retention (src/core/maintenance.js runRetention): a dry run first, then deleting only raw payloads
// that feed no fact and no saved state (never a quarantined one, never the newest of an endpoint),
// thinning old sync runs to one a day and old forecast issues to the ones a read can pick, and
// removing finished queue rows. Builds, the forecast of record and scores are not changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
const { db, dataDir } = await import('../src/db/db.js');
const { landRaw, quarantine, seriesId, putReadings, putIntervals, readForecastOfRecord } = await import('../src/core/facts.js');
const { runRetention, retentionSettings, runMaintenance, endpointOf, MIN_FORECAST_DAYS } = await import('../src/core/maintenance.js');

const NOW = 1800000000;
const DAY = 86400;
const site = Number(db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Home', 1, 'GB', 'GB', 'GBP')").run().lastInsertRowid);
const age = (rawId, days) => db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(NOW - days * DAY, rawId);
const row = (id) => db.prepare('SELECT id, file FROM raw_payload WHERE id = ?').get(id);
const fileOf = (id) => path.join(dataDir, db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(id).file);
let n = 0;
const land = (extra = {}) => landRaw({ source: 'open_meteo', siteId: site, request: { url: `https://api.example/v1/forecast/${extra.endpoint ?? 'a'}?n=${++n}` }, body: { n, ...extra.body } }).rawId;

test('settings: defaults, environment, and refusals', () => {
  assert.deepEqual(retentionSettings({}), { mode: 'report', rawDays: 14, syncRunDays: 90, forecastDays: 14 });
  assert.deepEqual(retentionSettings({ RETENTION: 'apply', RAW_RETENTION_DAYS: '30', SYNC_RUN_RETENTION_DAYS: '60', FORECAST_RETENTION_DAYS: '10' }), { mode: 'apply', rawDays: 30, syncRunDays: 60, forecastDays: 10 });
  assert.throws(() => retentionSettings({ RETENTION: 'yes' }), /RETENTION must be one of off, report, apply/);
  assert.throws(() => retentionSettings({ RAW_RETENTION_DAYS: 'x' }), /RAW_RETENTION_DAYS/);
  assert.throws(() => retentionSettings({ FORECAST_RETENTION_DAYS: '3' }), new RegExp(`>= ${MIN_FORECAST_DAYS}`), 'scoring reads 7 days back');
  assert.equal(endpointOf(JSON.stringify({ url: 'https://api.sunsynk.net/api/v1/plant/123?lan=en&id=123' })), 'api.sunsynk.net/api/v1/plant/123');
  assert.equal(endpointOf(JSON.stringify({ method: 'POST', path: '/domestic', query: { offset: 50 } })), 'POST /domestic');
});

test('raw payloads: a dry run deletes nothing; apply deletes only old payloads that feed nothing', () => {
  const s = seriesId('site', site, 'solar_w', 'sunsynk_live');
  const iv = seriesId('site', site, 'ghi_wm2', 'open_meteo');
  const free = land();                                                   // old, unreferenced: goes
  const reading = land(); putReadings(s, [{ ts: NOW - 20 * DAY, value: 1 }], reading);
  const superseded = land(); putIntervals(iv, [{ start: NOW - 20 * DAY, end: NOW - 20 * DAY + 3600, value: 1 }], superseded);
  db.prepare('UPDATE interval_fact SET superseded_at = 1 WHERE raw_id = ?').run(superseded);   // withdrawn, still evidence
  const tariff = Number(db.prepare("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, currency, country) VALUES ('t', 'T1', 'electricity', 'import', 'flat', 'GBP', 'GB')").run().lastInsertRowid);
  const rate = land();
  db.prepare("INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at, raw_id) VALUES (?, 'unit', 'single', 0, 10, 1, 1, ?)").run(tariff, rate);
  const forecast = land();
  db.prepare('INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, raw_id) VALUES (?, 1, 2, 1, 1, ?)').run(seriesId('site', site, 'solar_kwh', 'quartz'), forecast);
  const saved = land();
  db.prepare("INSERT INTO connection (site_id, provider, meta) VALUES (?, 'tounify', ?)").run(site, JSON.stringify({ prices_etag: 'x', prices_raw: saved, nested: { battery: { rawId: 999999 } } }));
  const quarantined = quarantine({ source: 'open_meteo', siteId: site, request: { url: 'https://api.example/v1/forecast/q' }, body: { bad: 1 }, reason: 'test' }).rawId;
  const recent = land();
  const newestOld = land({ endpoint: 'only' });                          // the newest (and only) answer of its endpoint
  const missingFile = land();
  for (const id of [free, reading, superseded, rate, forecast, saved, quarantined, newestOld, missingFile]) age(id, 20);
  age(recent, 2);
  fs.rmSync(fileOf(missingFile));
  // An orphan file (no row) older than the window, and a fresh one.
  const orphanOld = path.join(dataDir, 'raw', 'open_meteo', '2020-01-01', 'orphan.json');
  const orphanNew = path.join(dataDir, 'raw', 'open_meteo', '2020-01-01', 'fresh.json');
  fs.mkdirSync(path.dirname(orphanOld), { recursive: true });
  fs.writeFileSync(orphanOld, '{}'); fs.writeFileSync(orphanNew, '{}');
  fs.utimesSync(orphanOld, (NOW - 30 * DAY), (NOW - 30 * DAY));
  fs.utimesSync(orphanNew, NOW, NOW);

  const filesBefore = [free, reading].map(fileOf);
  const dry = runRetention({ now: NOW });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.raw.candidates, 2, 'the free payload and the one whose file is already gone');
  assert.deepEqual([dry.raw.keptReferenced, dry.raw.keptInState, dry.raw.quarantinedKept], [4, 1, 1]);
  assert.ok(dry.raw.keptNewestOfEndpoint >= 1);
  assert.equal(dry.raw.filesMissing, 1);
  assert.equal(dry.orphanFiles.found, 1);
  assert.ok(row(free) && fs.existsSync(filesBefore[0]) && fs.existsSync(orphanOld), 'a dry run deletes nothing');

  const done = runRetention({ now: NOW, dryRun: false });
  assert.deepEqual([done.raw.deleted, done.raw.filesDeleted, done.orphanFiles.deleted], [2, 1, 1]);
  assert.equal(row(free), undefined);
  assert.equal(fs.existsSync(filesBefore[0]), false, 'its file too');
  for (const id of [reading, superseded, rate, forecast, saved, quarantined, recent, newestOld]) assert.ok(row(id), `payload ${id} kept`);
  assert.ok(fs.existsSync(filesBefore[1]));
  assert.equal(fs.existsSync(orphanOld), false);
  assert.ok(fs.existsSync(orphanNew), 'a fresh file without a row is left alone (it may be landing now)');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const again = runRetention({ now: NOW, dryRun: false });
  assert.deepEqual([again.raw.deleted, again.orphanFiles.deleted], [0, 0], 'idempotent');
  // A payload deleted by retention is landed again when the same answer comes back.
  assert.equal(landRaw({ source: 'open_meteo', siteId: site, request: { url: 'https://api.example/v1/forecast/a?n=1' }, body: { n: 1 } }).duplicate, false);
});

test('sync_run: older than the window, one run a day per home is kept (the last); running and recent rows are not touched', () => {
  const ins = db.prepare('INSERT INTO sync_run (site_id, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?)');
  const ids = [];
  for (let d = 100; d < 103; d++) for (let h = 0; h < 4; h++) ids.push(Number(ins.run(site, NOW - d * DAY + h * 3600 - (NOW % DAY), NOW - d * DAY + h * 3600 + 60 - (NOW % DAY), 'ok', '[]').lastInsertRowid));
  const running = Number(ins.run(site, NOW - 120 * DAY, null, 'running', null).lastInsertRowid);
  const recent = Number(ins.run(site, NOW - DAY, NOW - DAY + 60, 'ok', '[]').lastInsertRowid);
  const dry = runRetention({ now: NOW });
  assert.deepEqual([dry.syncRun.olderThanWindow, dry.syncRun.candidates, dry.syncRun.keptOnePerDay], [12, 9, 3]);
  runRetention({ now: NOW, dryRun: false });
  const left = new Set(db.prepare('SELECT id FROM sync_run').all().map((r) => r.id));
  assert.deepEqual(ids.filter((id) => left.has(id)), [ids[3], ids[7], ids[11]], 'the last run of each of the 3 days');
  assert.ok(left.has(running) && left.has(recent));
});

test('forecast_fact: old periods keep the issues a read can pick; the forecast of record, the build read and recent periods are unchanged', () => {
  const s = seriesId('site', site, 'solar_kwh', 'core_forecast');
  const ins = db.prepare('INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value) VALUES (?, ?, ?, ?, ?)');
  const old = NOW - 20 * DAY; const fresh = NOW - 3 * DAY;
  for (const start of [old, old + 1800, fresh]) {
    for (const lead of [48, 30, 13, 11, 6, 1]) ins.run(s, start, start + 1800, start - lead * 3600, lead);   // issued before the period
    ins.run(s, start, start + 1800, start + 600, 99);                                                       // and one after it began
  }
  const ofRecord = (from, to) => readForecastOfRecord(s, from, to, NOW);
  const buildRead = (from, to) => db.prepare('SELECT start_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts')
    .all(s, from, to).reduce((m, f) => (!m.has(f.start_ts) || f.issued_at > m.get(f.start_ts).issued_at ? m.set(f.start_ts, f) : m), new Map());
  const before = { rec: ofRecord(old - DAY, NOW), build: [...buildRead(old - DAY, NOW).values()], fresh: db.prepare('SELECT * FROM forecast_fact WHERE start_ts = ?').all(fresh) };
  const dry = runRetention({ now: NOW, forecastDays: 3 });
  assert.equal(dry.settings.forecastDays, MIN_FORECAST_DAYS, 'never less than 8 days');
  assert.equal(dry.forecast.candidates, 2 * 4, 'per old period: 7 issues, 3 kept (latest before start, latest 12 h before, latest of all)');
  runRetention({ now: NOW, dryRun: false });
  assert.deepEqual(db.prepare('SELECT issued_at - start_ts AS rel FROM forecast_fact WHERE series_id = ? AND start_ts = ? ORDER BY issued_at').all(s, old).map((r) => r.rel), [-13 * 3600, -3600, 600]);
  assert.deepEqual(ofRecord(old - DAY, NOW), before.rec, 'forecast of record (the latest issue) unchanged');
  assert.deepEqual([...buildRead(old - DAY, NOW).values()], before.build, 'the build\'s forecast of record (latest before the period) unchanged');
  assert.deepEqual(db.prepare('SELECT * FROM forecast_fact WHERE start_ts = ?').all(fresh), before.fresh, 'a period inside the window keeps every issue');
});

test('rebuild_queue: finished rows go, pending ones stay', () => {
  const ins = db.prepare('INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at, done_at) VALUES (?, 0, 1, ?, 1, ?)');
  ins.run(site, 'done', 5); ins.run(site, 'done', 6); ins.run(site, 'pending', null);
  assert.equal(runRetention({ now: NOW }).rebuildQueue.candidates, 2);
  runRetention({ now: NOW, dryRun: false });
  assert.deepEqual(db.prepare('SELECT reason FROM rebuild_queue').all().map((r) => r.reason), ['pending']);
});

test('the start-up hook reports by default and deletes nothing; RETENTION=apply deletes', () => {
  const id = land(); age(id, 400);
  const report = runMaintenance();
  assert.equal(report.retention.dryRun, true);
  assert.ok(report.retention.raw.candidates >= 1);
  assert.ok(row(id), 'nothing deleted in report mode');
  assert.deepEqual(Object.keys(report), [String(site)], 'the per-home results keep their shape');
  assert.equal(runMaintenance({ retention: 'off' }).retention, null);
  assert.equal(runMaintenance({ retention: 'apply' }).retention.dryRun, false);
  assert.equal(row(id), undefined);
});
