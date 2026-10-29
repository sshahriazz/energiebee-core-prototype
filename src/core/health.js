// Source health: for each role of a home that has a provider in force now, is that provider still delivering?
// The answer is read from the facts the provider's series hold, never from a connection flag: a connection can say "ok" while
// nothing new arrives.
//
// What "new data" means. Facts are stored change-only and stamped with when the core RECEIVED them (recorded_at). The freshest
// series of the bound source for this home (its own series, its device's series, or the region series it reads) decides: the
// source is as alive as its most recently received fact. A source with several series is therefore not blamed for one quiet
// series (a relay that rarely changes). Limit: a forecast that repeats itself unchanged stores nothing, so forecast sources
// should carry a generous expectedEveryS.
//
// Cadence (how often new data should be received), in this order:
//   1 the source's trait expectedEveryS (registry.js SOURCES traits, or set when a source is added on the Providers screen);
//   2 by kind: an instant reading or a counter 300 s, a forecast 3600 s, a period (interval) its own length (the median of its
//     newest periods, 1800 s when unknown).
// A trait irregular: true marks a source that reports only when something happens (smart-charge dispatches): it is never judged
// late or silent, only never (no data at all) or ok.
//
// Status, with `every` the cadence and `age` seconds since the newest fact was received:
//   ok       age <= 2 x every
//   late     age <= max(12 x every, 6 hours)
//   silent   older than that
//   never    the source has no data at all for this home
// A role with no provider in force now has status 'unbound'.
import { db } from '../db/db.js';
import { nowSec } from './time.js';

export const DEFAULT_EVERY_S = Object.freeze({ instant: 300, counter: 300, forecast: 3600, interval: 1800 });
export const LATE_PERIODS = 2;
export const SILENT_PERIODS = 12;
export const SILENT_FLOOR_S = 6 * 3600;
export const REASON_TEXT = {
  out_of_range: 'outside the allowed range', not_a_number: 'not a number', unmapped_point: 'a point nobody mapped', future_timestamp: 'a time in the future',
  counter_backwards: 'a counter going backwards', not_in_enum: 'not one of the allowed values', kind_mismatch: 'the wrong kind of reading for the channel',
  write_only: 'a point that can only be written', counter_without_time: 'a counter with no time', state_without_time: 'a setting with no time', event_without_time: 'an event with no time',
};
const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

// "5 minutes", "3 h", "2 days": for the plain-language reasons.
export function human(s) {
  s = Math.max(0, Math.round(s));
  if (s < 90) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 2 * 86400) return `${Math.round(s / 360) / 10} h`.replace('.0 h', ' h');
  return `${Math.round(s / 8640) / 10} days`.replace('.0 days', ' days');
}

// The series a binding reads for a home: the device's own when the binding names one, otherwise the home's own and the series of
// the regions it reads (carbon intensity and gas calorific value live under a region, shared by homes).
function seriesOf(site, binding) {
  if (binding.deviceId != null) {
    return db.prepare(`SELECT se.id, m.code AS metric, m.time_role AS time_role FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
      WHERE so.code = ? AND se.subject_kind = 'device' AND se.subject_id = ?`).all(binding.source, String(binding.deviceId));
  }
  const ldz = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(site.id).map((d) => parseJson(d.attrs)?.ldz).find(Boolean);
  const regions = [site.carbon_region != null ? `carbon:${site.carbon_region}` : null, ldz ? `ldz:${ldz}` : null].filter(Boolean);
  return db.prepare(`SELECT se.id, m.code AS metric, m.time_role AS time_role FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
    WHERE so.code = ? AND ((se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))
      ${regions.length ? `OR (se.subject_kind = 'region' AND se.subject_id IN (${regions.map(() => '?').join(',')}))` : ''})`)
    .all(binding.source, String(site.id), site.id, ...regions);
}

// Newest received fact of one series: { receivedAt (s), dataUntil (s), kind }.
function newestOf(se) {
  const r = db.prepare('SELECT MAX(recorded_at) AS rec, MAX(ts) AS until FROM reading WHERE series_id = ?').get(se.id);
  const i = db.prepare('SELECT MAX(recorded_at) AS rec, MAX(end_ts) AS until FROM interval_fact WHERE series_id = ?').get(se.id);
  const f = db.prepare('SELECT MAX(recorded_at) AS rec, MAX(end_ts) AS until FROM forecast_fact WHERE series_id = ?').get(se.id);
  const cand = [['instant', r], ['interval', i], ['forecast', f]].filter(([, x]) => x.rec != null).sort((a, b) => b[1].rec - a[1].rec);
  if (!cand.length) return null;
  const [kind, x] = cand[0];
  return { seriesId: se.id, metric: se.metric, kind, receivedAt: Math.floor(x.rec / 1000), dataUntil: x.until };
}

// The period a series reports, from its newest periods (median), for the default cadence of an interval kind.
function periodOf(seriesId) {
  const rows = db.prepare('SELECT end_ts - start_ts AS len FROM interval_fact WHERE series_id = ? ORDER BY end_ts DESC LIMIT 7').all(seriesId).map((x) => x.len).sort((a, b) => a - b);
  return rows.length ? rows[rows.length >> 1] : null;
}

function counterKind(siteId, binding, metric) {
  return Boolean(db.prepare(`SELECT 1 FROM channel c JOIN metric m ON m.id = c.metric_id JOIN source so ON so.id = c.source_id
    WHERE c.site_id = ? AND so.code = ? AND m.code = ? AND c.kind = 'counter' AND c.superseded_at IS NULL`).get(siteId, binding.source, metric));
}

/** Health of one binding at `now`. Pure of everything but the database. */
export function bindingHealth(site, binding, traits, now = nowSec()) {
  const cands = seriesOf(site, binding).map(newestOf).filter(Boolean).sort((a, b) => b.receivedAt - a.receivedAt);
  const top = cands[0] ?? null;
  const out = { bindingId: binding.id, role: binding.role, source: binding.source, deviceId: binding.deviceId ?? null, series: cands.length };
  if (!top) return { ...out, status: 'never', kind: null, expectedEveryS: null, lastReceivedAt: null, dataUntil: null, ageS: null, reason: `No data has arrived from ${binding.source} for this home yet.` };
  let kind = top.kind;
  if (kind === 'instant' && counterKind(site.id, binding, top.metric)) kind = 'counter';
  const every = traits.expectedEveryS ?? (kind === 'interval' ? (periodOf(top.seriesId) ?? DEFAULT_EVERY_S.interval) : DEFAULT_EVERY_S[kind]);
  const age = Math.max(0, now - top.receivedAt);
  let status;
  if (traits.irregular) status = 'ok';
  else if (age <= LATE_PERIODS * every) status = 'ok';
  else if (age <= Math.max(SILENT_PERIODS * every, SILENT_FLOOR_S)) status = 'late';
  else status = 'silent';
  const normally = traits.irregular ? 'it reports only when something happens' : `it normally sends every ${human(every)}`;
  const reason = traits.irregular ? `Last data ${human(age)} ago; ${normally}.`
    : status === 'ok' ? `Newest data arrived ${human(age)} ago; ${normally}.`
      : `No new data for ${human(age)}; ${normally}.`;
  return { ...out, status, kind, expectedEveryS: traits.irregular ? null : every, lastReceivedAt: top.receivedAt, dataUntil: top.dataUntil, ageS: age, reason };
}

const rank = { silent: 3, late: 2, never: 2, ok: 0 };

/**
 * Health of every role of a home. For each role with a provider in force now: its bindings' health, and the worst of them.
 * Also, per source, the values the channels refused in the last 24 hours (top reasons) and, when the push log exists, when the
 * last push arrived. Returns { siteId, now, roles: [{ role, status, bindings: [...] }], summary: { ok, late, silent, never, unbound } }.
 */
export function health(siteId, { now = nowSec() } = {}) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new RangeError(`no home ${siteId}`);
  const rows = db.prepare(`SELECT b.id, b.role, b.device_id AS deviceId, b.valid_from AS valFrom, b.valid_to AS valTo, b.priority, so.code AS source, so.traits
    FROM binding b JOIN source so ON so.id = b.source_id WHERE b.site_id = ? AND b.superseded_at IS NULL ORDER BY b.role, b.valid_from IS NOT NULL, b.valid_from, b.priority, b.id`).all(siteId);
  const hasPush = tableExists('push_log');
  const sinceMs = (now - 86400) * 1000;
  const refused = (code) => {
    const rs = db.prepare(`SELECT r.reason, COUNT(*) AS n FROM channel_reject r JOIN source so ON so.id = r.source_id WHERE r.site_id = ? AND so.code = ? AND r.recorded_at >= ? GROUP BY r.reason ORDER BY n DESC`).all(siteId, code, sinceMs);
    return { total: rs.reduce((t, x) => t + x.n, 0), top: rs.slice(0, 3).map((x) => ({ reason: x.reason, text: REASON_TEXT[x.reason] ?? x.reason.replace(/_/g, ' '), count: x.n })) };
  };
  const roles = new Map();
  for (const b of rows) {
    const inForce = (b.valFrom == null || b.valFrom <= now) && (b.valTo == null || b.valTo > now);
    if (!inForce) continue;
    const traits = parseJson(b.traits) ?? {};
    const h = bindingHealth(site, { id: b.id, role: b.role, source: b.source, deviceId: b.deviceId }, traits, now);
    h.rejected24h = refused(b.source);
    h.lastPushAt = hasPush ? (db.prepare("SELECT MAX(received_at) AS t FROM push_log WHERE site_id = ? AND source = ? AND status = 'ok'").get(siteId, b.source)?.t ?? null) : null;
    if (!roles.has(b.role)) roles.set(b.role, []);
    roles.get(b.role).push(h);
  }
  const out = [...roles].map(([role, bindings]) => ({ role, status: bindings.reduce((w, x) => (rank[x.status] > rank[w] ? x.status : w), 'ok'), bindings }));
  const summary = { ok: 0, late: 0, silent: 0, never: 0 };
  for (const r of out) summary[r.status]++;
  return { siteId, now, roles: out, summary };
}
