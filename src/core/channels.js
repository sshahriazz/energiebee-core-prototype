// Channels: one point of a vendor's feed -> one canonical metric (delta 064). ingestObservations is the
// one place conversion, sign handling and range checks happen, for every vendor, so a vendor with its own
// units or one signed figure is rows in `channel`, not code. Values that cannot be trusted are kept in
// channel_reject and never written as facts (the build then sees the input as missing, not as zero).
import { db, sourceId, metricId } from '../db/db.js';
import { seriesId, putReadings, putIntervals, putForecasts, markDirty, asWriter } from './facts.js';
import { nowSec } from './time.js';
import { SOURCES } from '../db/registry.js';

const insertChannel = 'INSERT INTO channel (site_id, source_id, point, metric_id, scale, shift, part, min_value, max_value, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Define a channel. Replaces the current channel of the same point and metric (the old row is superseded, not deleted).
// deviceId: the channel belongs to that device (null = the home itself).
// access: read | write | readwrite (a point the core may write to a device). enumValues: { code: word } for a state that
// is a mode code; a state value outside it is rejected.
export function defineChannel(siteId, source, point, metric, { scale = 1, shift = 0, part = 'all', min = null, max = null, deviceId = null, access = 'read', enumValues = null } = {}) {
  const now = Date.now();
  const src = sourceId(source); const met = metricId(metric);
  db.prepare('UPDATE channel SET superseded_at = ? WHERE site_id = ? AND source_id = ? AND point = ? AND metric_id = ? AND device_id IS ? AND superseded_at IS NULL').run(now, siteId, src, point, met, deviceId);
  return Number(db.prepare('INSERT INTO channel (site_id, source_id, device_id, point, metric_id, scale, shift, part, min_value, max_value, access, enum_values, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(siteId, src, deviceId, point, met, scale, shift, part, min, max, access, enumValues ? JSON.stringify(enumValues) : null, now).lastInsertRowid);
}

// Create a home's (or a device's) channels from the source's defaults (registry.js SOURCES channels) where it has
// none for that point and metric. Existing rows (an installer's change) are left alone. Cheap when nothing is missing.
export function ensureChannels(siteId, source, deviceId = null) {
  const defs = SOURCES.find((s) => s.code === source)?.channels ?? [];
  if (!defs.length) return 0;
  const src = sourceId(source);
  const has = db.prepare('SELECT 1 FROM channel WHERE site_id = ? AND source_id = ? AND point = ? AND metric_id = ? AND device_id IS ? AND superseded_at IS NULL');
  let made = 0;
  for (const d of defs) {
    if (has.get(siteId, src, d.point, metricId(d.metric), deviceId)) continue;
    defineChannel(siteId, source, d.point, d.metric, { ...d, deviceId });
    made++;
  }
  return made;
}

// deviceId: the channels of that device; omitted or null: the home's own.
export function channelsFor(siteId, source, point = null, deviceId = null) {
  return db.prepare(`SELECT c.*, m.code AS metric, m.time_role FROM channel c JOIN metric m ON m.id = c.metric_id
    WHERE c.site_id = ? AND c.source_id = ? AND c.superseded_at IS NULL AND c.device_id IS ?${point == null ? '' : ' AND c.point = ?'}`).all(siteId, sourceId(source), deviceId, ...(point == null ? [] : [point]));
}

// A device's single channel for a point: any current channel of that point on that device is replaced
// (a meter that turns out to read m3 instead of kWh changes its metric, it does not write both).
export function setDeviceChannel(siteId, source, deviceId, point, metric, opts = {}) {
  const src = sourceId(source);
  const cur = db.prepare('SELECT c.id, c.metric_id, c.scale, c.shift, c.part FROM channel c WHERE c.site_id = ? AND c.source_id = ? AND c.device_id = ? AND c.point = ? AND c.superseded_at IS NULL').all(siteId, src, deviceId, point);
  if (cur.length === 1 && cur[0].metric_id === metricId(metric) && cur[0].scale === (opts.scale ?? 1) && cur[0].shift === (opts.shift ?? 0) && cur[0].part === (opts.part ?? 'all')) return cur[0].id;
  const now = Date.now();
  db.prepare('UPDATE channel SET superseded_at = ? WHERE site_id = ? AND source_id = ? AND device_id = ? AND point = ? AND superseded_at IS NULL').run(now, siteId, src, deviceId, point);
  return Number(db.prepare('INSERT INTO channel (site_id, source_id, device_id, point, metric_id, scale, shift, part, min_value, max_value, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(siteId, src, deviceId, point, metricId(metric), opts.scale ?? 1, opts.shift ?? 0, opts.part ?? 'all', opts.min ?? null, opts.max ?? null, now).lastInsertRowid);
}

const reject = (siteId, src, point, ts, value, reason) =>
  db.prepare('INSERT INTO channel_reject (site_id, source_id, point, ts, value, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(siteId, src, point, ts, Number.isFinite(value) ? value : null, reason, Date.now());

/**
 * Write a vendor's observations through its channels.
 * @param observations one of three shapes, each with { point, value } and optionally { quality, rawId }:
 *   an instant   { ts }
 *   a period     { start, end }
 *   a forecast   { start, end, issuedAt }   (a prediction made at issuedAt, seconds)
 *   a state      { kind: 'state', ts }      what a device says its own setting is (target level, mode code, window start
 *                as minute of day): checked against the channel's range and enum, stored as a reading, held until it changes,
 *                and it never queues a rebuild
 *   an ack       { kind: 'ack', ref, commandId, ts }   a receipt that a write was applied. NOT a fact: it is returned in
 *                `acks` for the executor and never written to a fact table
 * @param opts { requireData: true } - an answer with no observations at all is an error, not a quiet success
 *   { deviceId } - the observations belong to that device (its own channels, series stored per device)
 *   { subject: { kind, id } } - the series subject when it is neither the home nor a device (a region)
 * @returns { written (facts about the past or present), forecasts (predictions), states, acks: [{ ref, commandId, ts }], rejected, unmapped: [point] } - unmapped points are reported, never dropped silently
 */
export function ingestObservations(siteId, source, observations, rawId = null, { requireData = false, deviceId = null, subject = null } = {}) {
  if (requireData && !observations.length) throw new Error(`${source}: the answer had no observations (an empty answer is not a success)`);
  ensureChannels(siteId, source, deviceId);
  const src = sourceId(source);
  const channels = new Map();
  for (const c of channelsFor(siteId, source, null, deviceId)) (channels.get(c.point) || channels.set(c.point, []).get(c.point)).push(c);
  const groups = new Map();   // kind|metric|issuedAt -> { kind, metric, issuedAt, rows }
  const unmapped = new Set(); let rejected = 0; const acks = [];
  for (const o of observations) {
    if (o.kind === 'ack') { acks.push({ ref: o.ref ?? null, commandId: o.commandId ?? null, ts: o.ts ?? nowSec() }); continue; }
    const list = channels.get(o.point);
    if (!list) { unmapped.add(o.point); continue; }
    const isState = o.kind === 'state';
    const kind = isState ? 'state' : o.issuedAt != null ? 'forecast' : o.ts != null ? 'reading' : 'interval';
    if (isState && o.ts == null) { reject(siteId, src, o.point, nowSec(), null, 'state_without_time'); rejected++; continue; }
    const at = o.ts ?? o.start;
    const v = o.value == null ? null : Number(o.value);
    if (v != null && !Number.isFinite(v)) { reject(siteId, src, o.point, at, null, 'not_a_number'); rejected++; continue; }
    for (const c of list) {
      if (isState && c.access === 'write') { reject(siteId, src, o.point, at, v, 'write_only'); rejected++; continue; }
      let x = v;
      if (x != null) {
        if (c.part === 'positive') x = x > 0 ? x : 0;
        else if (c.part === 'negative') x = x < 0 ? -x : 0;
        else if (c.part === 'abs') x = Math.abs(x);
        x = x * c.scale + c.shift;
        if ((c.min_value != null && x < c.min_value) || (c.max_value != null && x > c.max_value)) { reject(siteId, src, o.point, at, x, 'out_of_range'); rejected++; continue; }
        if (isState && c.enum_values && !(String(x) in JSON.parse(c.enum_values))) { reject(siteId, src, o.point, at, x, 'not_in_enum'); rejected++; continue; }
      }
      const key = `${kind}|${c.metric}|${o.issuedAt ?? ''}`;
      const g = groups.get(key) || groups.set(key, { kind, metric: c.metric, issuedAt: o.issuedAt, rows: [] }).get(key);
      g.rows.push(kind === 'reading' || kind === 'state' ? { ts: o.ts, value: x, quality: o.quality, rawId: o.rawId } : { start: o.start, end: o.end, value: x, quality: o.quality, rawId: o.rawId });
    }
  }
  for (const p of unmapped) reject(siteId, src, p, nowSec(), null, 'unmapped_point');
  let written = 0; let forecasts = 0; let states = 0; let earliest = Infinity;
  asWriter(source, () => {
    for (const { kind, metric, issuedAt, rows } of groups.values()) {
      const id = subject ? seriesId(subject.kind, String(subject.id), metric, source)
        : deviceId == null ? seriesId('site', siteId, metric, source) : seriesId('device', deviceId, metric, source);
      const n = kind === 'reading' || kind === 'state' ? putReadings(id, rows, rawId) : kind === 'interval' ? putIntervals(id, rows, rawId) : putForecasts(id, issuedAt, rows, rawId);
      // Forecasts of the future change nothing already built; only facts about the past or present mark a rebuild.
      if (kind === 'forecast') forecasts += n;
      else if (kind === 'state') states += n;
      else if (n) { written += n; earliest = Math.min(earliest, ...rows.map((r) => r.ts ?? r.start)); }
    }
  });
  if (earliest < Infinity) markDirty(siteId, earliest, nowSec(), `new ${source} data`);
  return { written, forecasts, states, acks, rejected, unmapped: [...unmapped] };
}
