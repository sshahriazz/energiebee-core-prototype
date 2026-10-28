// Replay: read the stored raw receipts of a source again, through its parser and the channels, so values that were refused or
// unmapped before a mapping was fixed are recovered. The receipt is the proof of what the provider sent; replaying it with a
// corrected channel gives the facts the first read should have written.
//
// Honest limits, by design:
//  - Only sources whose parse is a PURE function of the saved body (and of what the receipt itself records: its request, its
//    fetch time, the home's time zone) can replay. Those are listed in REPLAYABLE. Every other source is listed in NOT_REPLAYABLE
//    with the reason; a replay of one of them is refused, never guessed.
//  - Quarantined receipts (a body of a shape nobody knows) are never replayed: they produced no facts on purpose.
//  - Facts are change-only, so replay is idempotent: a second run writes nothing.
//  - Replay does not add refusal records: the receipts were refused (or not) when first read, and a replay that would refuse
//    again reports it in its own answer instead of piling up duplicate rows in channel_reject.
//  - A receipt whose file is gone (retention) is counted, not an error.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, dataDir } from '../db/db.js';
import { ingestObservations } from './channels.js';
import { forgetSeriesCache } from './facts.js';
import { nowSec } from './time.js';
import { parseDay, parseMonth, parseFlow } from '../adapters/sunsynk.js';

export class ReplayError extends Error {
  constructor(status, code, message, field = null) { super(message); this.status = status; this.code = code; this.field = field; }
}

const DATE_IN_URL = /[?&]date=(\d{4}-\d{2}-\d{2})(?:&|$)/;
const MONTH_IN_URL = /[?&]date=(\d{4}-\d{2})(?:&|$)/;

// parse({ site, request, body, receipt }) -> { observations, error? }. Context comes only from the receipt itself.
export const REPLAYABLE = {
  sunsynk_5min: {
    label: 'Sunsynk 5-minute day series',
    accepts: (receipt, request) => /\/energy\/[^/]+\/day/.test(String(request.url ?? '')),
    parse: ({ site, request, body }) => {
      const date = DATE_IN_URL.exec(String(request.url ?? ''))?.[1];
      if (!date) return { error: 'the receipt\'s request has no date' };
      const r = parseDay(site.timezone, date, body);
      return r.error ? { error: r.error } : { observations: r.obs };
    },
  },
  sunsynk_daily: {
    label: 'Sunsynk daily totals',
    accepts: (receipt, request) => /\/energy\/[^/]+\/month/.test(String(request.url ?? '')),
    parse: ({ site, body }) => {
      const r = parseMonth(site.timezone, body);
      return r.error ? { error: r.error } : { observations: r.obs };
    },
  },
  sunsynk_live: {
    label: 'Sunsynk realtime flow',
    accepts: (receipt, request) => /\/flow(\?|$)/.test(String(request.url ?? '')),   // the same source also holds plant records and battery details: not flows
    parse: ({ body, receipt }) => {
      const r = parseFlow(body, receipt.fetched_at);
      return r.error ? { error: r.error } : { observations: r.obs };
    },
  },
};

// Pushed receipts: the body is the sender's own text, the format and device are in the receipt's request. Their parsers live in
// push-formats.js; loaded when needed so replay still works where that file is absent.
const PUSH_SOURCES = { push_native: 'native', push_shelly_gen2: 'shelly_gen2_switch', push_tasmota: 'tasmota_sensor', push_homeassistant: 'homeassistant_state' };
let pushMod; let pushModTried = false;
async function pushFormats() {
  if (!pushModTried) { pushModTried = true; try { pushMod = await import('./push-formats.js'); } catch { pushMod = null; } }
  return pushMod;
}
export const pushReplayAvailable = async () => Boolean((await pushFormats())?.parsePush);

export const NOT_REPLAYABLE = {
  octopus_meter: 'The meter, its unit (kWh or m3) and the metric are decided from the home\'s devices at fetch time, and the parse is inside the adapter, not a function of the saved body alone.',
  octopus_kraken: 'The dispatch and planned-charge parse is inside the adapter and is not separated from its fetch.',
  carbon_regional: 'The parse is inline in the adapter and depends on the region it was fetched for, which the receipt does not record.',
  national_gas_cv: 'The parse is inline in the adapter and depends on the gas zone it was fetched for.',
  open_meteo: 'The parse is inline in the adapter, and it splits past and future by the clock at fetch time.',
  quartz: 'The parse is inline in the adapter and snaps times in a way the receipt does not record.',
  octopus_rates: 'Tariff prices are a different store (rate_interval), not channel facts.',
  tariffscanner: 'A tariff catalogue, not slot input.',
  tounify: 'A tariff catalogue, not slot input.',
};

// The sources that can replay, with the receipts to read. push sources only when push-formats.js is there.
export function replayableSources() { return [...Object.keys(REPLAYABLE), ...Object.keys(PUSH_SOURCES)]; }
export const canReplay = (source) => source in REPLAYABLE || source in PUSH_SOURCES;
export const whyNot = (source) => NOT_REPLAYABLE[source] ?? 'No parser for this source has been separated from its fetch yet.';

const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
function readReceipt(file) {
  try { return fs.readFileSync(path.join(dataDir, file), 'utf8'); } catch { return null; }
}

function rolledBack(fn) {
  db.exec('SAVEPOINT replay_dry');
  try { return fn(); } finally { db.exec('ROLLBACK TO replay_dry'); db.exec('RELEASE replay_dry'); }
}

// Receipts of a home that a replay would read: accepted (never quarantined), of a replayable source, within `days`.
function receiptsOf(siteId, { source = null, days = 30, ids = null, limit = 2000, now = nowSec() } = {}) {
  const codes = source ? [source] : replayableSources();
  const q = codes.map(() => '?').join(',');
  const idFilter = ids ? ` AND rp.id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT rp.id, rp.request, rp.file, rp.fetched_at, so.code AS source FROM raw_payload rp JOIN source so ON so.id = rp.source_id
    WHERE rp.site_id = ? AND rp.status = 'accepted' AND so.code IN (${q}) AND rp.fetched_at >= ?${idFilter} ORDER BY rp.id LIMIT ?`)
    .all(siteId, ...codes, Math.floor(now - days * 86400), ...(ids ?? []), limit + 1);
  const capped = rows.length > limit;
  const kept = rows.slice(0, limit).filter((r) => {
    const rq = parseJson(r.request) ?? {};
    return r.source in REPLAYABLE ? REPLAYABLE[r.source].accepts(r, rq) : true;
  });
  return { receipts: kept, capped };
}

/**
 * What a replay could recover: for each source that has refused or unmapped values in the window, how many receipts it could
 * read again, or why it cannot. Nothing is changed. { sources: [...], total (receipts), canReplay }.
 */
export function replayCandidates(siteId, { days = 30, now = nowSec() } = {}) {
  const since = (now - days * 86400) * 1000;
  const bySource = db.prepare(`SELECT so.code AS source, r.reason, COUNT(*) AS n FROM channel_reject r JOIN source so ON so.id = r.source_id
    WHERE r.site_id = ? AND r.recorded_at >= ? GROUP BY so.code, r.reason`).all(siteId, since);
  const sources = new Map();
  for (const x of bySource) {
    const s = sources.get(x.source) ?? { source: x.source, refused: 0, unmapped: 0 };
    if (x.reason === 'unmapped_point') s.unmapped += x.n; else s.refused += x.n;
    sources.set(x.source, s);
  }
  const list = [...sources.values()].map((s) => {
    const can = canReplay(s.source);
    const receipts = can ? receiptsOf(siteId, { source: s.source, days, now }).receipts.length : 0;
    return { ...s, canReplay: can, receipts, why: can ? null : whyNot(s.source) };
  });
  return { siteId, days, sources: list, total: list.reduce((t, s) => t + s.receipts, 0), lastRuns: lastRuns(siteId) };
}

export function lastRuns(siteId, limit = 5) {
  return db.prepare('SELECT * FROM replay_log WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(siteId, limit).map((r) => ({
    id: r.id, source: r.source, startedAt: r.started_at, days: r.days, receipts: r.receipts, observations: r.observations, written: r.written, forecasts: r.forecasts,
    rejected: r.rejected, unmapped: r.unmapped, parseErrors: r.parse_errors, note: r.note,
  }));
}

async function parseReceipt(site, r) {
  const text = readReceipt(r.file);
  if (text == null) return { missing: true };
  const request = parseJson(r.request) ?? {};
  let body;
  if (r.source in PUSH_SOURCES) {
    const mod = await pushFormats();
    if (!mod?.parsePush) return { error: 'push receipts are not available in this build' };
    try { body = JSON.parse(text); } catch { return { error: 'the saved body is not JSON' }; }
    try {
      const res = mod.parsePush(request.format ?? PUSH_SOURCES[r.source], body, { now: r.fetched_at, tz: site.timezone });
      // an ack is a receipt of a command, never a fact: replay does not record it again
      return { observations: (res.observations ?? []).filter((o) => o.kind !== 'ack'), deviceRef: request.device ?? res.deviceHint ?? null };
    } catch (e) { return { error: e.message }; }
  }
  try { body = JSON.parse(text); } catch { return { error: 'the saved body is not JSON' }; }
  const res = REPLAYABLE[r.source].parse({ site, request, body, receipt: r });
  return res.error ? { error: res.error } : { observations: res.observations };
}

// Resolve a pushed receipt's device (by external ref) to a device id of the home; null = the home itself.
function deviceFor(site, ref) {
  if (ref == null || ref === '') return { id: null };
  const d = db.prepare('SELECT id FROM device WHERE site_id = ? AND external_ref = ?').get(site.id, String(ref));
  return d ? { id: d.id } : { missing: true };
}

/**
 * Replay receipts of a home. opts: source (one source, or every replayable one), days (look-back, default 30), ids (only these
 * receipts), limit (default 2000 receipts), dryRun (default true: nothing kept), now (s).
 * Returns { dryRun, receipts, observations, written, forecasts, derived, rejected, unmapped: [point], stillRejected: [{ source, point,
 * reason, count }], parseErrors, missingFiles, deviceMissing, capped, bySource: {...}, logId }.
 */
export async function replay(siteId, { source = null, days = 30, ids = null, limit = 2000, dryRun = true, now = nowSec() } = {}) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(Number(siteId));
  if (!site) throw new ReplayError(404, 'not_found', 'No such home');
  if (source != null && !canReplay(source)) throw new ReplayError(400, 'not_replayable', `${source} cannot be replayed: ${whyNot(source)}`, 'source');
  if (source != null && source in PUSH_SOURCES && !(await pushReplayAvailable())) throw new ReplayError(400, 'not_replayable', 'Pushed receipts cannot be replayed: the push formats are not available in this build', 'source');
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0 || d > 3650) throw new ReplayError(400, 'bad_number', 'days must be between 1 and 3650', 'days');
  const { receipts, capped } = receiptsOf(site.id, { source, days: d, ids, limit, now });
  const out = { dryRun, source, days: d, receipts: receipts.length, observations: 0, written: 0, forecasts: 0, derived: 0, rejected: 0, unmapped: [], stillRejected: [], parseErrors: 0, missingFiles: 0, deviceMissing: 0, capped, bySource: {} };

  // Parse first (outside any transaction: file reads and dynamic imports), then ingest all in one transaction.
  const parsed = [];
  for (const r of receipts) {
    const bs = out.bySource[r.source] ??= { receipts: 0, observations: 0, written: 0, rejected: 0 };
    bs.receipts++;
    const p = await parseReceipt(site, r);
    if (p.missing) { out.missingFiles++; continue; }
    if (p.error) { out.parseErrors++; continue; }
    let device = { id: null };
    if (r.source in PUSH_SOURCES) { device = deviceFor(site, p.deviceRef); if (device.missing) { out.deviceMissing++; continue; } }
    out.observations += p.observations.length; bs.observations += p.observations.length;
    parsed.push({ r, obs: p.observations, deviceId: device.id });
  }

  const run = () => {
    const maxReject = db.prepare('SELECT IFNULL(MAX(id), 0) AS m FROM channel_reject').get().m;
    const unmapped = new Set();
    for (const { r, obs, deviceId } of parsed) {
      const res = ingestObservations(site.id, r.source, obs, r.id, { deviceId, now: r.fetched_at });
      out.written += res.written; out.forecasts += res.forecasts; out.derived += res.derived; out.rejected += res.rejected;
      out.bySource[r.source].written += res.written; out.bySource[r.source].rejected += res.rejected;
      for (const p of res.unmapped) unmapped.add(`${r.source}:${p}`);
    }
    // What this run would refuse again, from the refusal rows ingest just wrote; those rows are then removed (see the header).
    out.stillRejected = db.prepare(`SELECT so.code AS source, r.point, r.reason, COUNT(*) AS count FROM channel_reject r JOIN source so ON so.id = r.source_id
      WHERE r.id > ? AND r.reason <> 'unmapped_point' GROUP BY so.code, r.point, r.reason ORDER BY count DESC LIMIT 50`).all(maxReject).map((x) => ({ ...x }));
    db.prepare('DELETE FROM channel_reject WHERE id > ?').run(maxReject);
    out.unmapped = [...unmapped].map((x) => { const i = x.indexOf(':'); return { source: x.slice(0, i), point: x.slice(i + 1) }; });
  };
  // tx() first: the fact writers open their own transactions, which nest inside it (a bare SAVEPOINT would start one SQLite then refuses to nest)
  if (dryRun) { try { tx(() => rolledBack(run)); } finally { forgetSeriesCache(); } }   // a rolled-back run may have created series rows whose ids are cached
  else {
    try {
    tx(() => {
      run();
      out.logId = Number(db.prepare('INSERT INTO replay_log (site_id, source, started_at, days, receipts, observations, written, forecasts, rejected, unmapped, parse_errors, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(site.id, source, Date.now(), Math.floor(d), out.receipts, out.observations, out.written, out.forecasts, out.rejected, out.unmapped.length, out.parseErrors,
          out.capped ? `capped at ${limit} receipts` : null).lastInsertRowid);
    });
    } catch (e) { forgetSeriesCache(); throw e; }
  }
  return out;
}
