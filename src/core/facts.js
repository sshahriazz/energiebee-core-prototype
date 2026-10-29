// Stages 2 and 4 of the pipeline: raw landing and bitemporal facts.
// Facts are append-only. A changed value becomes a new version and the old
// row is stamped superseded_at; nothing is ever updated in place.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, sourceId, metricId, dataDir } from '../db/db.js';
import { nowSec } from './time.js';

// ───────────── Raw landing ─────────────

const findRaw = db.prepare('SELECT id FROM raw_payload WHERE hash = ?');
const insertRaw = db.prepare(
  `INSERT INTO raw_payload (source_id, site_id, request, fetched_at, hash, file, status, reason)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

// Identity is the source and the body, not the request: requests carry the current
// time (period_to=now, nonces), so the same data fetched again would otherwise be
// stored again. The row is written first and removed if the file cannot be, so a
// file never exists without its row.
export function landRaw({ source, siteId, request, body, status = 'accepted', reason = null }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const reqText = JSON.stringify(request ?? {});
  const hash = crypto.createHash('sha256').update(`${source}\n${status}\n${text}`).digest('hex');
  const existing = findRaw.get(hash);
  if (existing) return { rawId: existing.id, duplicate: true };
  const fetchedAt = nowSec();
  const day = new Date(fetchedAt * 1000).toISOString().slice(0, 10);
  const rel = path.join('raw', source, day, `${hash.slice(0, 16)}.json`);
  const r = insertRaw.run(sourceId(source), siteId ?? null, reqText, fetchedAt, hash, rel, status, reason);
  const rawId = Number(r.lastInsertRowid);
  try {
    fs.mkdirSync(path.join(dataDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), text);
  } catch (err) {
    db.prepare('DELETE FROM raw_payload WHERE id = ?').run(rawId);
    throw err;
  }
  return { rawId, duplicate: false };
}

export function quarantine({ source, siteId, request, body, reason }) {
  return landRaw({ source, siteId, request, body, status: 'quarantined', reason });
}

// ───────────── Series ─────────────

const findSeries = db.prepare(
  'SELECT id FROM series WHERE subject_kind = ? AND subject_id = ? AND metric_id = ? AND source_id = ?');
const insertSeries = db.prepare(
  'INSERT INTO series (subject_kind, subject_id, metric_id, source_id) VALUES (?, ?, ?, ?)');
const seriesCache = new Map();
// Forget the cached series ids: a dry run or a failed transaction that created series rows and was rolled back leaves ids that no longer exist.
export const forgetSeriesCache = () => seriesCache.clear();

export function seriesId(subjectKind, subjectId, metric, source) {
  const key = `${subjectKind}|${subjectId}|${metric}|${source}`;
  if (seriesCache.has(key)) return seriesCache.get(key);
  const args = [subjectKind, String(subjectId), metricId(metric), sourceId(source)];
  let row = findSeries.get(...args);
  if (!row) row = { id: Number(insertSeries.run(...args).lastInsertRowid) };
  seriesCache.set(key, row.id);
  return row.id;
}

// ───────────── Facts ─────────────

const QUALITY = { MEASURED: 1, FALLBACK: 2, INTERPOLATED: 4, ESTIMATED: 8, PARTIAL: 16, SUSPECT: 32, CHECK_FAILED: 64, RESTATED: 128 };
export { QUALITY };

const curReading = db.prepare(
  'SELECT value, recorded_at FROM reading WHERE series_id = ? AND ts = ? AND superseded_at IS NULL');
const supReading = db.prepare(
  'UPDATE reading SET superseded_at = ? WHERE series_id = ? AND ts = ? AND superseded_at IS NULL');
const insReading = db.prepare(
  'INSERT INTO reading (series_id, ts, value, quality, recorded_at, raw_id) VALUES (?, ?, ?, ?, ?, ?)');

// A processor declares its source for the duration of its writes (asWriter); a series of any other
// source is then refused, so a new vendor cannot overwrite another source's readings by filing
// under its name. Outside asWriter nothing is checked.
let writerSource = null;
export function asWriter(source, fn) {
  const prev = writerSource;
  writerSource = sourceId(source);
  try { return fn(); } finally { writerSource = prev; }
}
function checkWriter(series) {
  if (writerSource == null) return;
  const sid = db.prepare('SELECT source_id FROM series WHERE id = ?').get(series)?.source_id;
  if (sid !== writerSource) throw new Error(`series ${series} belongs to another source than the one writing`);
}

// A batch may name the same period twice (a feed that repeats a row, an overlap between two pages). The
// last one wins and the others are dropped before writing: two versions with one recorded_at would break
// the unique key and abort the whole batch.
const lastPerKey = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];

const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

// Returns how many facts were new or changed, so callers know what to rebuild.
export function putReadings(series, rows, rawId) {
  checkWriter(series);
  const recordedAt = Date.now();
  let changed = 0;
  tx(() => {
    for (const r of lastPerKey(rows, (x) => x.ts)) {
      const value = r.value === undefined ? null : r.value;
      const cur = curReading.get(series, r.ts);
      if (cur && same(cur.value, value)) continue;
      // A correction in the same millisecond as the version it replaces would repeat (series, ts, recorded_at):
      // the new version is stamped one millisecond after the old one instead of failing the batch.
      const at = cur && cur.recorded_at >= recordedAt ? cur.recorded_at + 1 : recordedAt;
      if (cur) supReading.run(at, series, r.ts);
      insReading.run(series, r.ts, value, r.quality ?? QUALITY.MEASURED, at, r.rawId ?? rawId ?? null);
      changed++;
    }
  });
  return changed;
}

const curInterval = db.prepare(
  'SELECT value, recorded_at FROM interval_fact WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
const supInterval = db.prepare(
  'UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
const insInterval = db.prepare(
  'INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at, raw_id) VALUES (?, ?, ?, ?, ?, ?, ?)');

export function putIntervals(series, rows, rawId) {
  checkWriter(series);
  const recordedAt = Date.now();
  let changed = 0;
  tx(() => {
    for (const r of lastPerKey(rows, (x) => `${x.start}|${x.end}`)) {
      const value = r.value === undefined ? null : r.value;
      const cur = curInterval.get(series, r.start, r.end);
      if (cur && same(cur.value, value)) continue;
      const at = cur && cur.recorded_at >= recordedAt ? cur.recorded_at + 1 : recordedAt;   // see putReadings
      if (cur) supInterval.run(at, series, r.start, r.end);
      insInterval.run(series, r.start, r.end, value, r.quality ?? QUALITY.MEASURED, at, r.rawId ?? rawId ?? null);
      changed++;
    }
  });
  return changed;
}

const insForecast = db.prepare(
  'INSERT OR IGNORE INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, raw_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const latestForecast = db.prepare('SELECT value FROM forecast_fact WHERE series_id = ? AND start_ts = ? AND end_ts = ? ORDER BY issued_at DESC LIMIT 1');

// A new issue is stored only for periods whose value changed since the latest issue.
// The forecast of record for a period is then still "the latest issue made before a
// time", but repeated identical issues (every 10-minute sync) are not stored again.
// A period is its start AND end (delta 040): one of another length from the same start is a new
// period, compared with its own latest issue and stored, never dropped. recorded_at (ms) is when
// the core stored the issue (readForecastAsOf); issuedAt (s) stays the provider's issue time.
export function putForecasts(series, issuedAt, rows, rawId, { recordedAt = Date.now() } = {}) {
  checkWriter(series);
  let n = 0;
  tx(() => {
    for (const r of lastPerKey(rows, (x) => `${x.start}|${x.end}`)) {
      const value = r.value === undefined ? null : r.value;
      const last = latestForecast.get(series, r.start, r.end);
      if (last && same(last.value, value)) continue;
      n += Number(insForecast.run(series, r.start, r.end, issuedAt, value, rawId ?? null, recordedAt).changes);
    }
  });
  return n;
}

// ───────────── Rebuild queue ─────────────

const insDirty = db.prepare(
  'INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES (?, ?, ?, ?, ?)');

export function markDirty(siteId, fromTs, toTs, reason) {
  if (!(toTs > fromTs)) return;
  insDirty.run(siteId, fromTs, toTs, reason, nowSec());
}

// "As known at": while set (ms), every fact read returns the version that was in force at
// that moment instead of the current one. Facts are never overwritten (a new version supersedes
// the old one), so this reproduces exactly what the core could see then. Used to rebuild a day
// as it stood at an earlier time; null (normal running) reads current versions.
let knownAt = null;
export function withKnownAt(ms, fn) {
  const prev = knownAt;
  knownAt = ms == null ? null : Math.floor(Number(ms));
  try { return fn(); } finally { knownAt = prev; }
}
export const knownAtMs = () => knownAt;
// SQL condition for "the version in force" on a fact table with recorded_at / superseded_at (ms).
// The moment is inlined as an integer, never user text.
export function inForce(alias = '') {
  const a = alias ? `${alias}.` : '';
  if (knownAt == null || !Number.isFinite(knownAt)) return `${a}superseded_at IS NULL`;
  return `${a}recorded_at <= ${knownAt} AND (${a}superseded_at IS NULL OR ${a}superseded_at > ${knownAt})`;
}

// Readings, intervals and forecasts for a set of series over a window (versions in force).
export function readReadings(seriesIds, from, to) {
  if (!seriesIds.length) return [];
  const q = `SELECT series_id, ts, value, quality, raw_id FROM reading
             WHERE series_id IN (${seriesIds.map(() => '?').join(',')}) AND ts >= ? AND ts < ? AND ${inForce()}
             ORDER BY ts`;
  return db.prepare(q).all(...seriesIds, from, to);
}

// The longest fact (end_ts - start_ts, s) of a set of series, from series.max_span_s (delta 013:
// kept by triggers on every interval and forecast fact, never shrinking), or null when any of them
// has none recorded. A fact that overlaps [from, to) (end_ts > from) then starts at or after
// from - span, so that bound can be added to a read without leaving any row out, and the primary
// key (series_id, start_ts, ...) is searched as a range instead of the series' whole history.
// null: no bound (a series without facts, or a database without the column).
let hasSpan = null;
export function spanColumn() {
  hasSpan ??= Boolean(db.prepare("SELECT 1 FROM pragma_table_info('series') WHERE name = 'max_span_s'").get());
  return hasSpan;
}
export function spanOf(seriesIds) {
  if (!seriesIds.length || !spanColumn()) return null;
  const r = db.prepare(`SELECT MAX(max_span_s) AS span, COUNT(max_span_s) AS known, COUNT(*) AS n FROM series WHERE id IN (${seriesIds.map(() => '?').join(',')})`).get(...seriesIds);
  return r && r.known === r.n && r.span != null ? r.span : null;
}

export function readIntervals(seriesIds, from, to) {
  if (!seriesIds.length) return [];
  const span = spanOf(seriesIds);
  const q = `SELECT series_id, start_ts, end_ts, value, quality, raw_id FROM interval_fact
             WHERE series_id IN (${seriesIds.map(() => '?').join(',')}) AND end_ts > ? AND start_ts < ?${span == null ? '' : ' AND start_ts >= ?'} AND ${inForce()}
             ORDER BY start_ts`;
  return db.prepare(q).all(...seriesIds, from, to, ...(span == null ? [] : [from - span]));
}

// Forecast of record: for each target slot, the latest issue made before `asOf`. The outer read is
// bounded to the same [from, to) as the inner one (it joins on start_ts, so this changes nothing
// but the rows searched).
export function readForecastOfRecord(seriesId, from, to, asOf) {
  return db.prepare(
    `SELECT f.start_ts, f.end_ts, f.value, f.issued_at FROM forecast_fact f
     JOIN (SELECT start_ts, MAX(issued_at) AS iss FROM forecast_fact
           WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= ? GROUP BY start_ts) last
       ON last.start_ts = f.start_ts AND last.iss = f.issued_at
     WHERE f.series_id = ? AND f.start_ts >= ? AND f.start_ts < ? ORDER BY f.start_ts`).all(seriesId, from, to, asOf, seriesId, from, to);
}

// Forecasts as the core knew them at asOfMs (bitemporal, delta 040): for each series and period
// overlapping [from, to), the latest issue the core had RECORDED by then (recorded_at <= asOfMs), so
// a replay never sees an issue fetched later, whatever the provider's own issue time says. Storage
// is change-only, so an unchanged period's record is the earlier issue that last set it. A period
// overlapped by a period of a later issue (the provider changed its period length) is left out:
// the later issue is the record for that time. Ordered by series, start, end. The lower bound
// start_ts >= from - max_span_s (series.max_span_s, delta 013) only narrows the rows searched.
export function readForecastAsOf(seriesIds, from, to, asOfMs) {
  if (!seriesIds.length) return [];
  const asOf = Math.floor(Number(asOfMs));
  if (!Number.isFinite(asOf)) throw new TypeError(`readForecastAsOf: asOfMs must be a number of ms, not ${asOfMs}`);
  const list = seriesIds.map(() => '?').join(',');
  const span = spanOf(seriesIds);
  const bound = span == null ? '' : ' AND start_ts >= ?';
  const rows = db.prepare(
    `SELECT f.series_id, f.start_ts, f.end_ts, f.issued_at, f.recorded_at, f.value FROM forecast_fact f
     JOIN (SELECT series_id, start_ts, end_ts, MAX(issued_at) AS iss FROM forecast_fact
           WHERE series_id IN (${list}) AND end_ts > ? AND start_ts < ?${bound} AND recorded_at <= ?
           GROUP BY series_id, start_ts, end_ts) last
       ON last.series_id = f.series_id AND last.start_ts = f.start_ts AND last.end_ts = f.end_ts AND last.iss = f.issued_at
     ORDER BY f.series_id, f.start_ts, f.end_ts`).all(...seriesIds, from, to, ...(span == null ? [] : [from - span]), asOf);
  // Within one series, drop a period that a later-issued period of another length overlaps.
  const out = [];
  for (let i = 0, j = 0; i < rows.length; i = j) {
    for (j = i; j < rows.length && rows[j].series_id === rows[i].series_id; j++);
    const s = rows.slice(i, j);
    const mixed = s.some((r) => r.end_ts - r.start_ts !== s[0].end_ts - s[0].start_ts);
    for (const r of s) {
      if (mixed && s.some((o) => o !== r && o.issued_at > r.issued_at && o.start_ts < r.end_ts && o.end_ts > r.start_ts)) continue;
      out.push(r);
    }
  }
  return out;
}
