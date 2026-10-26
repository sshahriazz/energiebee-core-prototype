// Start-up corrections and migrations. Each is idempotent (safe on every start) and every
// fact it withdraws is logged in fact_correction with the reason, so nothing changes silently.
// Retention (runRetention, below): what is kept and for how long; a dry-run report unless asked.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, dataDir } from '../db/db.js';
import { seriesId } from './facts.js';
import { nowSec } from './time.js';
import { seedAttributes } from './attributes.js';
import { seedDeviceHistory } from './devices.js';

// Earlier code (before 16 Oct 2026) converted this home's gas readings from m³ to kWh with a
// fixed calorific value as it stored them, and saved the result as Octopus 'gas_kwh' facts.
// Octopus never sent those numbers: it reports m³ for this meter, and the m³ readings are
// stored as 'gas_m3' and converted in the build with the daily calorific value. The build
// already ignores the old 'gas_kwh' rows; withdrawing them keeps the facts truthful.
export function withdrawDerivedGas(siteId) {
  let withdrawn = 0;
  for (const d of db.prepare("SELECT id, attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId)) {
    if (JSON.parse(d.attrs || '{}').gasUnit?.unit !== 'm3') continue;
    const series = seriesId('device', d.id, 'gas_kwh', 'octopus_meter');
    tx(() => {
      const n = db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND superseded_at IS NULL').run(Date.now(), series).changes;
      if (n) {
        db.prepare('INSERT INTO fact_correction (site_id, corrected_at, series_id, rows, reason) VALUES (?, ?, ?, ?, ?)').run(siteId, nowSec(), series, n,
          'Gas kWh values computed by earlier EnergieBee code (m³ × a fixed calorific value) had been stored as if Octopus sent them. '
          + 'Octopus reports m³ for this meter; those readings are kept and converted with National Gas\'s daily calorific value.');
        withdrawn += n;
      }
    });
  }
  return withdrawn;
}

// Record the system details already on `site` as their first versions (databases created
// before details were versioned), with the source they most likely came from.
export function seedSiteAttributes(siteId) {
  const meta = JSON.parse(db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(siteId)?.meta || '{}');
  const env = process.env;
  seedAttributes(siteId, (attr, value) => {
    if (attr === 'battery_kwh') {
      if (env.BATTERY_KWH) return { source: 'installer', detail: '.env BATTERY_KWH' };
      if (meta.batteryMeasured?.kwhPer100 === value) return { source: 'measured', detail: `measured: ${meta.batteryMeasured.energyKwh} kWh discharged over ${meta.batteryMeasured.socPoints} points of charge drop` };
      return { source: 'provider', detail: 'battery reading (Ah × voltage)' };
    }
    if (attr === 'pv_kwp') return env.PV_KWP ? { source: 'installer', detail: '.env PV_KWP' } : { source: 'provider', detail: 'Sunsynk plant record' };
    const est = meta.panelAnglesEstimate;
    const isEst = est && ((attr === 'pv_tilt' && value === est.tilt) || (attr === 'pv_orientation' && value === est.bearing));
    return isEst ? { source: 'estimated', detail: "estimated from this home's output" } : { source: 'installer', detail: `.env ${attr === 'pv_tilt' ? 'PV_TILT' : 'PV_ORIENTATION'}` };
  });
}

// The start-up hook (server.js start). Per home: { gasKwhWithdrawn }. Then retention, in the mode
// RETENTION sets: 'report' (the default: a dry run, nothing deleted), 'apply', or 'off'; its report
// is returned under `retention` (null when off).
export function runMaintenance({ retention = retentionSettings().mode } = {}) {
  const out = {};
  for (const { id } of db.prepare('SELECT id FROM site').all()) {
    seedSiteAttributes(id);
    seedDeviceHistory(id);
    out[id] = { gasKwhWithdrawn: withdrawDerivedGas(id) };
  }
  Object.defineProperty(out, 'retention', { value: retention === 'off' ? null : runRetention({ dryRun: retention !== 'apply' }), enumerable: false });
  return out;
}

// ───────────── Retention (database review H4, L6) ─────────────
// Nothing here touches a fact a build, a price or a score reads. A run is a dry run unless asked:
// the report says what would go, in counts and bytes only (never a payload's contents).
//
// Raw payloads (raw_payload row and its file under data/raw): deleted when ALL of these hold
//   - fetched more than RAW_RETENTION_DAYS ago (default 14);
//   - status 'accepted' (a quarantined payload is evidence of a refused answer: kept);
//   - no fact refers to it: reading, interval_fact, forecast_fact, rate_interval (raw_id, every
//     version, superseded ones included; corrections withdraw facts by superseding them, so the
//     payloads behind a correction stay referenced);
//   - no saved state refers to it: a key naming a raw id (prices_raw, components_raw, rawId ...) in
//     connection.meta or provider_state.state (tounify reuses a stored answer on HTTP 304);
//   - it is not the newest payload of its endpoint (source, home, request URL path): the latest
//     copy of every answer stays readable (/api/sites/:id/system reads the newest Sunsynk plant record).
//   The row is deleted first (in a transaction that checks the references again), then the file;
//   a file left behind by a crash between the two has no row and is cleared as an orphan below.
// Orphan files: a file under data/raw with no raw_payload row, older than the same window.
// sync_run: rows that started more than SYNC_RUN_RETENTION_DAYS ago (default 90) are thinned to the
//   last run of each UTC day per home (its status and step log kept as they were); a 'running'
//   row is never touched. Readers: the timeline shows one sync a day for those days, and history
//   reconstruction (src/core/history.js) has one moment a day there.
// forecast_fact: periods that ENDED more than FORECAST_RETENTION_DAYS ago (default 14, never less
//   than 8: accuracy scoring reads the last 7 days with a 12-hour lead) keep, per period, only the
//   issues a read can still pick: the latest issue made at or before the period started (the build's
//   and Quartz calibration's forecast of record), the latest made 12 hours before it (the scoring
//   lead), and the latest of all (the final forecast; change-only storage compares with it), each per
//   start and per (start, end). Every other issue of those periods is deleted. Builds, the forecast
//   of record and scores stay identical; what is lost is an "as known at" view of an old period
//   between its kept issues, and the timeline's per-issue totals for those periods.
// rebuild_queue: rows with done_at set (left by older code; the queue now deletes what it processed).
export const RETENTION_DEFAULTS = Object.freeze({ rawDays: 14, syncRunDays: 90, forecastDays: 14 });
export const MIN_FORECAST_DAYS = 8;
const RETENTION_MODES = ['off', 'report', 'apply'];

export function retentionSettings(env = process.env) {
  const days = (name, dflt, min = 1) => {
    const v = env[name];
    if (v == null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new RangeError(`${name} must be a number of days >= ${min}, not ${JSON.stringify(v)}`);
    return n;
  };
  const mode = env.RETENTION == null || env.RETENTION === '' ? 'report' : String(env.RETENTION);
  if (!RETENTION_MODES.includes(mode)) throw new RangeError(`RETENTION must be one of ${RETENTION_MODES.join(', ')}, not ${JSON.stringify(mode)}`);
  return {
    mode,
    rawDays: days('RAW_RETENTION_DAYS', RETENTION_DEFAULTS.rawDays),
    syncRunDays: days('SYNC_RUN_RETENTION_DAYS', RETENTION_DEFAULTS.syncRunDays),
    forecastDays: days('FORECAST_RETENTION_DAYS', RETENTION_DEFAULTS.forecastDays, MIN_FORECAST_DAYS),
  };
}

// Raw ids named in saved JSON state: a key containing 'raw' with an integer value (or a list of them).
function rawIdsInState() {
  const ids = new Set();
  const walk = (v, key) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); return; }
    if (key && /raw/i.test(key) && Number.isInteger(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean') ids.add(Number(v));
  };
  for (const sql of ['SELECT meta AS j FROM connection WHERE meta IS NOT NULL', 'SELECT state AS j FROM provider_state WHERE state IS NOT NULL']) {
    let rows = [];
    try { rows = db.prepare(sql).all(); } catch { /* table not there: nothing saved */ }
    for (const r of rows) { try { walk(JSON.parse(r.j)); } catch { /* not JSON: names no payload */ } }
  }
  return ids;
}

// The endpoint a payload answered: host and path of its URL (the query left out), or a POST's path,
// or the start of a GraphQL query. Payloads of one endpoint are versions of the same answer.
export function endpointOf(requestText) {
  let r;
  try { r = JSON.parse(requestText || '{}'); } catch { return String(requestText).slice(0, 200); }
  if (r && typeof r.url === 'string') {
    try { const u = new URL(r.url); return `${u.host}${u.pathname}`; } catch { return r.url.split('?')[0]; }
  }
  if (r && typeof r.path === 'string') return `${r.method ?? ''} ${r.path}`;
  if (r && typeof r.query === 'string') return r.query.slice(0, 120);
  return '';
}

// Every column with a foreign key to raw_payload (reading, interval_fact, forecast_fact,
// rate_interval.raw_id today), read from the schema so a table added later is respected too.
function rawRefs() {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const fk of db.prepare('SELECT "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)').all(name)) if (fk.parent === 'raw_payload') out.push([name, fk.col]);
  }
  return out;
}
const notReferenced = (refs, alias) => refs.map(([t, c]) => `NOT EXISTS (SELECT 1 FROM "${t}" WHERE "${c}" = ${alias}.id)`).join(' AND ') || '1';

function fileSize(rel) {
  try { return fs.statSync(path.join(dataDir, rel)).size; } catch { return null; }
}

function rawRetention(cutoff, dryRun, batch) {
  const inState = rawIdsInState();
  const refs = rawRefs();
  // In fetch order (then id), so the last one seen per endpoint is its newest answer.
  const rows = db.prepare("SELECT id, source_id, site_id, request, file, fetched_at FROM raw_payload WHERE status = 'accepted' ORDER BY fetched_at, id").all();
  const newest = new Map();
  for (const r of rows) newest.set(`${r.source_id}|${r.site_id ?? ''}|${endpointOf(r.request)}`, r.id);
  const referenced = db.prepare(`SELECT NOT (${notReferenced(refs, 'p')}) AS ref FROM (SELECT ? AS id) p`);
  const out = { olderThanWindow: 0, keptReferenced: 0, keptInState: 0, keptNewestOfEndpoint: 0, quarantinedKept: 0, candidates: 0, bytes: 0, deleted: 0, filesDeleted: 0, filesMissing: 0 };
  out.quarantinedKept = db.prepare("SELECT COUNT(*) AS n FROM raw_payload WHERE status = 'quarantined' AND fetched_at < ?").get(cutoff).n;
  const doomed = [];
  for (const r of rows) {
    if (r.fetched_at >= cutoff) continue;
    out.olderThanWindow++;
    if (referenced.get(r.id).ref) { out.keptReferenced++; continue; }
    if (inState.has(r.id)) { out.keptInState++; continue; }
    if (newest.get(`${r.source_id}|${r.site_id ?? ''}|${endpointOf(r.request)}`) === r.id) { out.keptNewestOfEndpoint++; continue; }
    doomed.push(r);
    const size = fileSize(r.file);
    if (size == null) out.filesMissing++; else out.bytes += size;
  }
  out.candidates = doomed.length;
  if (dryRun) return out;
  const del = db.prepare(`DELETE FROM raw_payload WHERE id = ? AND status = 'accepted' AND ${notReferenced(refs, 'raw_payload')}`);
  for (let i = 0; i < doomed.length; i += batch) {
    const chunk = doomed.slice(i, i + batch);
    const gone = tx(() => chunk.filter((r) => !inState.has(r.id) && del.run(r.id).changes === 1));
    out.deleted += gone.length;
    for (const r of gone) {
      try { fs.unlinkSync(path.join(dataDir, r.file)); out.filesDeleted++; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  return out;
}

// Files under data/raw that no raw_payload row names, last written before the cutoff.
function orphanFiles(cutoff, dryRun) {
  const out = { found: 0, bytes: 0, deleted: 0 };
  const rawDir = path.join(dataDir, 'raw');
  if (!fs.existsSync(rawDir)) return out;
  const known = new Set(db.prepare('SELECT file FROM raw_payload').all().map((r) => path.normalize(r.file)));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;
      const rel = path.normalize(path.relative(dataDir, full));
      if (known.has(rel)) continue;
      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoff * 1000) continue;
      out.found++; out.bytes += st.size;
      if (!dryRun) { fs.unlinkSync(full); out.deleted++; }
    }
  };
  walk(rawDir);
  return out;
}

function syncRunRetention(cutoff, dryRun) {
  const where = `started_at < ? AND status <> 'running'
    AND id NOT IN (SELECT MAX(id) FROM sync_run WHERE started_at < ? AND status <> 'running' GROUP BY site_id, started_at / 86400)`;
  const out = { olderThanWindow: db.prepare("SELECT COUNT(*) AS n FROM sync_run WHERE started_at < ? AND status <> 'running'").get(cutoff).n, candidates: 0, deleted: 0 };
  out.candidates = db.prepare(`SELECT COUNT(*) AS n FROM sync_run WHERE ${where}`).get(cutoff, cutoff).n;
  out.keptOnePerDay = out.olderThanWindow - out.candidates;
  if (!dryRun && out.candidates) out.deleted = Number(tx(() => db.prepare(`DELETE FROM sync_run WHERE ${where}`).run(cutoff, cutoff).changes));
  return out;
}

// The issues of one old period that a read can still pick (see the note above RETENTION_DEFAULTS).
const LEAD_S = 12 * 3600;
function keptIssues(t) {
  const max = (cond) => `(SELECT IFNULL(MAX(g.issued_at), -1) FROM forecast_fact g WHERE g.series_id = ${t}.series_id AND g.start_ts = ${t}.start_ts${cond})`;
  return [max(''), max(` AND g.issued_at <= ${t}.start_ts`), max(` AND g.issued_at <= ${t}.start_ts - ${LEAD_S}`),
    max(` AND g.end_ts = ${t}.end_ts`), max(` AND g.end_ts = ${t}.end_ts AND g.issued_at <= ${t}.start_ts`), max(` AND g.end_ts = ${t}.end_ts AND g.issued_at <= ${t}.start_ts - ${LEAD_S}`)].join(', ');
}
function forecastRetention(cutoff, dryRun) {
  const out = { periodsOlderThanWindow: 0, candidates: 0, deleted: 0 };
  out.periodsOlderThanWindow = db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT series_id, start_ts, end_ts FROM forecast_fact WHERE end_ts <= ?)').get(cutoff).n;
  out.candidates = db.prepare(`SELECT COUNT(*) AS n FROM forecast_fact f WHERE f.end_ts <= ? AND f.issued_at NOT IN (${keptIssues('f')})`).get(cutoff).n;
  if (!dryRun && out.candidates) out.deleted = Number(tx(() => db.prepare(`DELETE FROM forecast_fact WHERE end_ts <= ? AND issued_at NOT IN (${keptIssues('forecast_fact')})`).run(cutoff).changes));
  return out;
}

function rebuildQueueRetention(dryRun) {
  const out = { candidates: db.prepare('SELECT COUNT(*) AS n FROM rebuild_queue WHERE done_at IS NOT NULL').get().n, deleted: 0 };
  if (!dryRun && out.candidates) out.deleted = Number(tx(() => db.prepare('DELETE FROM rebuild_queue WHERE done_at IS NOT NULL').run().changes));
  return out;
}

// One retention run. dryRun (the default): counts what would be deleted, deletes nothing.
// The windows come from the environment (retentionSettings) unless given; now is in seconds.
export function runRetention({ dryRun = true, now = nowSec(), rawDays, syncRunDays, forecastDays, batch = 500 } = {}) {
  const env = retentionSettings();
  const s = { rawDays: rawDays ?? env.rawDays, syncRunDays: syncRunDays ?? env.syncRunDays, forecastDays: Math.max(forecastDays ?? env.forecastDays, MIN_FORECAST_DAYS) };
  const cut = (d) => Math.floor(now - d * 86400);
  const report = { dryRun, at: now, settings: s };
  report.raw = rawRetention(cut(s.rawDays), dryRun, batch);
  report.orphanFiles = orphanFiles(cut(s.rawDays), dryRun);
  report.syncRun = syncRunRetention(cut(s.syncRunDays), dryRun);
  report.forecast = forecastRetention(cut(s.forecastDays), dryRun);
  report.rebuildQueue = rebuildQueueRetention(dryRun);
  return report;
}

// One line for a log: counts only.
export function retentionSummary(r) {
  if (!r) return 'retention: off';
  const verb = r.dryRun ? 'would delete' : 'deleted';
  const n = (o) => (r.dryRun ? o.candidates : o.deleted);
  return `retention (${r.dryRun ? 'dry run; RETENTION=apply to delete' : 'applied'}): ${verb} ${n(r.raw)} raw payloads (${(r.raw.bytes / 1e6).toFixed(1)} MB; `
    + `${r.raw.keptReferenced} kept as evidence of facts), ${r.dryRun ? r.orphanFiles.found : r.orphanFiles.deleted} orphan raw files, ${n(r.syncRun)} sync runs, `
    + `${n(r.forecast)} superseded forecast issues, ${n(r.rebuildQueue)} finished queue rows`;
}
