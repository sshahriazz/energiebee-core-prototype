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
  'SELECT value FROM reading WHERE series_id = ? AND ts = ? AND superseded_at IS NULL');
const supReading = db.prepare(
  'UPDATE reading SET superseded_at = ? WHERE series_id = ? AND ts = ? AND superseded_at IS NULL');
const insReading = db.prepare(
  'INSERT INTO reading (series_id, ts, value, quality, recorded_at, raw_id) VALUES (?, ?, ?, ?, ?, ?)');

const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

// Returns how many facts were new or changed, so callers know what to rebuild.
export function putReadings(series, rows, rawId) {
  const recordedAt = Date.now();
  let changed = 0;
  tx(() => {
    for (const r of rows) {
      const value = r.value === undefined ? null : r.value;
      const cur = curReading.get(series, r.ts);
      if (cur && same(cur.value, value)) continue;
      if (cur) supReading.run(recordedAt, series, r.ts);
      insReading.run(series, r.ts, value, r.quality ?? QUALITY.MEASURED, recordedAt, r.rawId ?? rawId ?? null);
      changed++;
    }
  });
  return changed;
}

const curInterval = db.prepare(
  'SELECT value FROM interval_fact WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
const supInterval = db.prepare(
  'UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
const insInterval = db.prepare(
  'INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at, raw_id) VALUES (?, ?, ?, ?, ?, ?, ?)');

export function putIntervals(series, rows, rawId) {
  const recordedAt = Date.now();
  let changed = 0;
  tx(() => {
    for (const r of rows) {
      const value = r.value === undefined ? null : r.value;
      const cur = curInterval.get(series, r.start, r.end);
      if (cur && same(cur.value, value)) continue;
      if (cur) supInterval.run(recordedAt, series, r.start, r.end);
      insInterval.run(series, r.start, r.end, value, r.quality ?? QUALITY.MEASURED, recordedAt, r.rawId ?? rawId ?? null);
      changed++;
    }
  });
  return changed;
}

const insForecast = db.prepare(
  'INSERT OR IGNORE INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, raw_id) VALUES (?, ?, ?, ?, ?, ?)');
const latestForecast = db.prepare('SELECT value FROM forecast_fact WHERE series_id = ? AND start_ts = ? ORDER BY issued_at DESC LIMIT 1');

// A new issue is stored only for periods whose value changed since the latest issue.
// The forecast of record for a period is then still "the latest issue made before a
// time", but repeated identical issues (every 10-minute sync) are not stored again.
export function putForecasts(series, issuedAt, rows, rawId) {
  let n = 0;
  tx(() => {
    for (const r of rows) {
      const value = r.value === undefined ? null : r.value;
      const last = latestForecast.get(series, r.start);
      if (last && same(last.value, value)) continue;
      n += Number(insForecast.run(series, r.start, r.end, issuedAt, value, rawId ?? null).changes);
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

export function readIntervals(seriesIds, from, to) {
  if (!seriesIds.length) return [];
  const q = `SELECT series_id, start_ts, end_ts, value, quality, raw_id FROM interval_fact
             WHERE series_id IN (${seriesIds.map(() => '?').join(',')}) AND end_ts > ? AND start_ts < ? AND ${inForce()}
             ORDER BY start_ts`;
  return db.prepare(q).all(...seriesIds, from, to);
}

// Forecast of record: for each target slot, the latest issue made before `asOf`.
export function readForecastOfRecord(seriesId, from, to, asOf) {
  return db.prepare(
    `SELECT f.start_ts, f.end_ts, f.value, f.issued_at FROM forecast_fact f
     JOIN (SELECT start_ts, MAX(issued_at) AS iss FROM forecast_fact
           WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= ? GROUP BY start_ts) last
       ON last.start_ts = f.start_ts AND last.iss = f.issued_at
     WHERE f.series_id = ? ORDER BY f.start_ts`).all(seriesId, from, to, asOf, seriesId);
}
