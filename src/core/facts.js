// Stages 2 and 4 of the pipeline: raw landing and bitemporal facts.
// Facts are append-only. A changed value becomes a new version and the old
// row is stamped superseded_at; nothing is ever updated in place.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, sourceId, metricId, rawDir, rawFilePath } from '../db/db.js';
import { nowSec } from './time.js';
import { subjectThing, pointOf } from './points.js';

// ───────────── Raw landing ─────────────

const findRaw = db.prepare('SELECT id, file, site_id FROM raw_payload WHERE hash = ?');
const insertRaw = db.prepare(
  `INSERT INTO raw_payload (source_id, site_id, request, fetched_at, hash, file, status, reason)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

// A home's raw files are encrypted with the home's own key (AES-256-GCM; home_key, fix list R14): deleting the home
// deletes the key, so its files cannot be read again, in backups too. Public data (a source with traits.public: price
// lists, grid data) and receipts with no home are stored as sent. A sealed file starts with MAGIC, then the 12-byte IV and
// the 16-byte tag.
const MAGIC = Buffer.from('EBRAW1');
const publicSource = new Map();
async function isPublic(source) {
  if (!publicSource.has(source)) {
    let t = {}; try { t = JSON.parse((await db.prepare('SELECT traits FROM source WHERE code = ?').get(source))?.traits || '{}'); } catch { /* none */ }
    publicSource.set(source, Boolean(t.public));
  }
  return publicSource.get(source);
}
async function homeKey(siteId, { create = false } = {}) {
  if (create) await db.prepare('INSERT INTO home_key (site_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT (site_id) DO NOTHING').run(siteId, crypto.randomBytes(32), Date.now());
  return (await db.prepare('SELECT key FROM home_key WHERE site_id = ?').get(siteId))?.key ?? null;
}
export const isSealed = (buf) => buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
export async function seal(siteId, text) {
  const key = await homeKey(siteId, { create: true });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
// Open a raw receipt ({ file, site_id }): { state: 'ok', text, bytes } or the reason there is no text:
//   missing      the file is not in the raw store (retention, a copied database, a store that is not mounted)
//   unreadable   the file is there and cannot be read (permissions, a failing disk)
//   key_gone     a sealed file whose home's key is gone (an erased home: its files are meant to stay unreadable)
//   corrupt      a sealed file that does not decrypt: it was changed or cut short
export async function openRaw(row) {
  const file = rawFilePath(row.file);
  if (!file) return { state: 'missing' };
  let buf;
  try { buf = fs.readFileSync(file); } catch (err) { return { state: err.code === 'ENOENT' ? 'missing' : 'unreadable', error: err }; }
  if (!isSealed(buf)) return { state: 'ok', text: buf.toString('utf8'), bytes: buf.length, sealed: false };
  const key = row.site_id == null ? null : await homeKey(row.site_id);
  if (!key) return { state: 'key_gone', bytes: buf.length };
  try {
    const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return { state: 'ok', text: Buffer.concat([d.update(buf.subarray(MAGIC.length + 28)), d.final()]).toString('utf8'), bytes: buf.length, sealed: true };
  } catch (err) { return { state: 'corrupt', error: err, bytes: buf.length }; }
}
// The text of a raw receipt, or null when the file or its home's key is gone (an erased home). A sealed file that was
// changed throws: that is damage, not absence.
export async function readRaw(row) {
  const r = await openRaw(row);
  if (r.state === 'corrupt') throw r.error;
  return r.state === 'ok' ? r.text : null;
}
// The hash a receipt is stored under (raw_payload.hash): its source, status and text.
export const rawHash = (source, status, text) => crypto.createHash('sha256').update(`${source}\n${status}\n${text}`).digest('hex');
// Does this receipt's file have to be sealed? (a home's, and not public data)
export async function sealsRaw(source, siteId) { return siteId != null && !await isPublic(source); }

// The whole file or none of it, on disk before the row that names it exists (a crash or a power cut cannot leave a row
// pointing at half a file, or at a file whose rename was lost). The calls are synchronous: on a slow or network volume each
// landing blocks the event loop for the length of the write. The temporary name is an orphan if the process dies in between;
// retention clears it.
function writeFileDurably(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* not created */ } throw err; } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');   // the rename itself is only durable once the folder is on disk
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

// Make the folder of a receipt's file. Only below the raw store: if the store itself is gone (a volume detached while the
// server runs) it is not recreated, because the files would silently go to the system disk (db.js refuses that at start-up).
function folderFor(file) {
  if (!fs.statSync(rawDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the raw store ${rawDir} is not there (is the volume mounted?)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// The same body again: nothing new to store, but a file that was lost is written back (same hash, so the same text; sealed
// with the key of the row's home when it is one).
async function restoreRaw(existing, source, text) {
  const file = rawFilePath(existing.file);
  if (!file || fs.existsSync(file)) return;
  folderFor(file);
  writeFileDurably(file, await sealsRaw(source, existing.site_id) ? await seal(existing.site_id, text) : text);
}

// Identity is the source and the body, not the request: requests carry the current
// time (period_to=now, nonces), so the same data fetched again would otherwise be
// stored again. The file is written first and the row after (raw rows are append-only);
// a file left without its row by a failure is an orphan that retention removes.
export async function landRaw({ source, siteId, request, body, status = 'accepted', reason = null }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const reqText = JSON.stringify(request ?? {});
  const hash = rawHash(source, status, text);
  const existing = await findRaw.get(hash);
  if (existing) { await restoreRaw(existing, source, text); return { rawId: existing.id, duplicate: true }; }
  const fetchedAt = nowSec();
  const day = new Date(fetchedAt * 1000).toISOString().slice(0, 10);
  const rel = path.join('raw', source, day, `${hash.slice(0, 16)}.json`);
  const file = rawFilePath(rel);
  folderFor(file);
  writeFileDurably(file, await sealsRaw(source, siteId) ? await seal(siteId, text) : text);
  try {
    const r = await insertRaw.run(await sourceId(source), siteId ?? null, reqText, fetchedAt, hash, rel, status, reason);
    return { rawId: Number(r.lastInsertRowid), duplicate: false };
  } catch (err) {
    const raced = await findRaw.get(hash).catch(() => null);   // the same body landed at the same moment: its file is this one
    if (raced) return { rawId: raced.id, duplicate: true };
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    throw err;
  }
}

export async function quarantine({ source, siteId, request, body, reason }) {
  return await landRaw({ source, siteId, request, body, status: 'quarantined', reason });
}

// ───────────── Series ─────────────

const findSeries = db.prepare('SELECT id FROM series WHERE point_id = ? AND metric_id = ? AND source_id = ?');
const insertSeries = db.prepare('INSERT INTO series (point_id, metric_id, source_id) VALUES (?, ?, ?)');
const seriesCache = new Map();
// Forget the cached series ids: a dry run or a failed transaction that created series rows and was rolled back leaves ids that no longer exist.
export const forgetSeriesCache = () => seriesCache.clear();

export async function seriesId(subjectKind, subjectId, metric, source) {
  const key = `${subjectKind}|${subjectId}|${metric}|${source}`;
  if (seriesCache.has(key)) return seriesCache.get(key);
  // The series is the feed of a source into the point of the subject's thing for this metric (made on first use).
  const mid = await metricId(metric);
  const args = [await pointOf(await subjectThing(subjectKind, subjectId), mid), mid, await sourceId(source)];
  let row = await findSeries.get(...args);
  if (!row) row = { id: Number((await insertSeries.run(...args)).lastInsertRowid) };
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
// under its name. Outside asWriter nothing is checked. The writer follows the async call chain
// (AsyncLocalStorage), so two processors writing at once never see each other's source.
const writerStore = new AsyncLocalStorage();
export async function asWriter(source, fn) {
  return writerStore.run(await sourceId(source), fn);
}
async function checkWriter(series) {
  const writerSource = writerStore.getStore();
  if (writerSource == null) return;
  const sid = (await db.prepare('SELECT source_id FROM series WHERE id = ?').get(series))?.source_id;
  if (sid !== writerSource) throw new Error(`series ${series} belongs to another source than the one writing`);
}

// A batch may name the same period twice (a feed that repeats a row, an overlap between two pages). The
// last one wins and the others are dropped before writing: two versions with one recorded_at would break
// the unique key and abort the whole batch.
const lastPerKey = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];

const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

// Returns how many facts were new or changed, so callers know what to rebuild.
export async function putReadings(series, rows, rawId) {
  await checkWriter(series);
  const recordedAt = Date.now();
  let changed = 0;
  await tx(async () => {
        for (const r of lastPerKey(rows, (x) => x.ts)) {
          const value = r.value === undefined ? null : r.value;
          const cur = await curReading.get(series, r.ts);
          if (cur && same(cur.value, value)) continue;
          // A correction in the same millisecond as the version it replaces would repeat (series, ts, recorded_at):
          // the new version is stamped one millisecond after the old one instead of failing the batch.
          const at = cur && cur.recorded_at >= recordedAt ? cur.recorded_at + 1 : recordedAt;
          if (cur) await supReading.run(at, series, r.ts);
          await insReading.run(series, r.ts, value, r.quality ?? QUALITY.MEASURED, at, r.rawId ?? rawId ?? null);
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

export async function putIntervals(series, rows, rawId) {
  await checkWriter(series);
  const recordedAt = Date.now();
  let changed = 0;
  await tx(async () => {
        for (const r of lastPerKey(rows, (x) => `${x.start}|${x.end}`)) {
          const value = r.value === undefined ? null : r.value;
          const cur = await curInterval.get(series, r.start, r.end);
          if (cur && same(cur.value, value)) continue;
          const at = cur && cur.recorded_at >= recordedAt ? cur.recorded_at + 1 : recordedAt;   // see putReadings
          if (cur) await supInterval.run(at, series, r.start, r.end);
          await insInterval.run(series, r.start, r.end, value, r.quality ?? QUALITY.MEASURED, at, r.rawId ?? rawId ?? null);
          changed++;
        }
      });
  return changed;
}

const insForecast = db.prepare(
  'INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, raw_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
const latestForecast = db.prepare('SELECT value FROM forecast_fact WHERE series_id = ? AND start_ts = ? AND end_ts = ? ORDER BY issued_at DESC LIMIT 1');

// A new issue is stored only for periods whose value changed since the latest issue.
// The forecast of record for a period is then still "the latest issue made before a
// time", but repeated identical issues (every 10-minute sync) are not stored again.
// A period is its start AND end (delta 040): one of another length from the same start is a new
// period, compared with its own latest issue and stored, never dropped. recorded_at (ms) is when
// the core stored the issue (readForecastAsOf); issuedAt (s) stays the provider's issue time.
export async function putForecasts(series, issuedAt, rows, rawId, { recordedAt = Date.now() } = {}) {
  await checkWriter(series);
  let n = 0;
  await tx(async () => {
        for (const r of lastPerKey(rows, (x) => `${x.start}|${x.end}`)) {
          const value = r.value === undefined ? null : r.value;
          const last = await latestForecast.get(series, r.start, r.end);
          if (last && same(last.value, value)) continue;
          n += Number((await insForecast.run(series, r.start, r.end, issuedAt, value, rawId ?? null, recordedAt)).changes);
        }
      });
  return n;
}

// ───────────── Rebuild queue ─────────────

const insDirty = db.prepare(
  'INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES (?, ?, ?, ?, ?)');

export async function markDirty(siteId, fromTs, toTs, reason) {
  if (!(toTs > fromTs)) return;
  await insDirty.run(siteId, fromTs, toTs, reason, nowSec());
}

// "As known at": while set (ms), every fact read returns the version that was in force at
// that moment instead of the current one. Facts are never overwritten (a new version supersedes
// the old one), so this reproduces exactly what the core could see then. Used to rebuild a day
// as it stood at an earlier time; null (normal running) reads current versions. The moment follows
// the async call chain (AsyncLocalStorage), so a request rebuilding "as known at" never changes what
// another request running at the same time reads.
const knownAtStore = new AsyncLocalStorage();
export function withKnownAt(ms, fn) {
  return knownAtStore.run({ ms: ms == null ? null : Math.floor(Number(ms)) }, fn);
}
export const knownAtMs = () => knownAtStore.getStore()?.ms ?? null;
// SQL condition for "the version in force" on a fact table with recorded_at / superseded_at (ms).
// The moment is inlined as an integer, never user text.
export function inForce(alias = '') {
  const a = alias ? `${alias}.` : '';
  const knownAt = knownAtMs();
  if (knownAt == null || !Number.isFinite(knownAt)) return `${a}superseded_at IS NULL`;
  return `${a}recorded_at <= ${knownAt} AND (${a}superseded_at IS NULL OR ${a}superseded_at > ${knownAt})`;
}

// Readings, intervals and forecasts for a set of series over a window (versions in force).
export async function readReadings(seriesIds, from, to) {
  if (!seriesIds.length) return [];
  const q = `SELECT series_id, ts, value, quality, raw_id FROM reading
             WHERE series_id IN (${seriesIds.map(() => '?').join(',')}) AND ts >= ? AND ts < ? AND ${inForce()}
             ORDER BY ts`;
  return await db.prepare(q).all(...seriesIds, from, to);
}

// The longest fact (end_ts - start_ts, s) of a set of series, from series.max_span_s (delta 013:
// kept by triggers on every interval and forecast fact, never shrinking), or null when any of them
// has none recorded. A fact that overlaps [from, to) (end_ts > from) then starts at or after
// from - span, so that bound can be added to a read without leaving any row out, and the primary
// key (series_id, start_ts, ...) is searched as a range instead of the series' whole history.
// null: no bound (a series without facts).
export async function spanOf(seriesIds) {
  if (!seriesIds.length) return null;
  const r = await db.prepare(`SELECT MAX(max_span_s) AS span, COUNT(max_span_s) AS known, COUNT(*) AS n FROM series WHERE id IN (${seriesIds.map(() => '?').join(',')})`).get(...seriesIds);
  return r && r.known === r.n && r.span != null ? r.span : null;
}

export async function readIntervals(seriesIds, from, to) {
  if (!seriesIds.length) return [];
  const span = await spanOf(seriesIds);
  const q = `SELECT series_id, start_ts, end_ts, value, quality, raw_id FROM interval_fact
             WHERE series_id IN (${seriesIds.map(() => '?').join(',')}) AND end_ts > ? AND start_ts < ?${span == null ? '' : ' AND start_ts >= ?'} AND ${inForce()}
             ORDER BY start_ts`;
  return await db.prepare(q).all(...seriesIds, from, to, ...(span == null ? [] : [from - span]));
}

// Forecast of record: for each target slot, the latest issue made before `asOf`. The outer read is
// bounded to the same [from, to) as the inner one (it joins on start_ts, so this changes nothing
// but the rows searched).
export async function readForecastOfRecord(seriesId, from, to, asOf) {
  return await db.prepare(
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
export async function readForecastAsOf(seriesIds, from, to, asOfMs) {
  if (!seriesIds.length) return [];
  const asOf = Math.floor(Number(asOfMs));
  if (!Number.isFinite(asOf)) throw new TypeError(`readForecastAsOf: asOfMs must be a number of ms, not ${asOfMs}`);
  const list = seriesIds.map(() => '?').join(',');
  const span = await spanOf(seriesIds);
  const bound = span == null ? '' : ' AND start_ts >= ?';
  const rows = await db.prepare(
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
