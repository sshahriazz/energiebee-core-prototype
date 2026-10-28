// Channels: one point of a vendor's feed -> one canonical metric (delta 064). ingestObservations is the
// one place conversion, sign handling and range checks happen, for every vendor, so a vendor with its own
// units or one signed figure is rows in `channel`, not code. Values that cannot be trusted are kept in
// channel_reject and never written as facts (the build then sees the input as missing, not as zero).
import { db, sourceId, metricId } from '../db/db.js';
import { seriesId, putReadings, putIntervals, putForecasts, readReadings, markDirty, asWriter, QUALITY } from './facts.js';
import { classifyStep, deriveCounterPeriods, neighbours, withdrawDerived } from './counters.js';
import { nowSec } from './time.js';
import { SOURCES, DEVICE_KIND_CHANNELS } from '../db/registry.js';

const insertChannel = 'INSERT INTO channel (site_id, source_id, point, metric_id, scale, shift, part, min_value, max_value, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Define a channel. Replaces the current channel of the same point and metric (the old row is superseded, not deleted).
// deviceId: the channel belongs to that device (null = the home itself).
// access: read | write | readwrite (a point the core may write to a device). enumValues: { code: word } for a state that
// is a mode code; a state value outside it is rejected.
// kind: value (default) | counter | event (delta 072). A counter stores its raw reading under `metric` and the energy of each period
// under `derived` (a metric code); counterWrap, counterResetBelow and maxGapS describe how it behaves. maxStuckSamples flags a run
// of identical samples, clockOffsetS corrects a device clock, futureToleranceS rejects a timestamp too far ahead. All optional.
export function defineChannel(siteId, source, point, metric, { scale = 1, shift = 0, part = 'all', min = null, max = null, deviceId = null, access = 'read', enumValues = null,
  kind = 'value', derived = null, counterWrap = null, counterResetBelow = null, maxGapS = null, maxStuckSamples = null, clockOffsetS = 0, futureToleranceS = null } = {}) {
  const now = Date.now();
  const src = sourceId(source); const met = metricId(metric);
  db.prepare('UPDATE channel SET superseded_at = ? WHERE site_id = ? AND source_id = ? AND point = ? AND metric_id = ? AND device_id IS ? AND superseded_at IS NULL').run(now, siteId, src, point, met, deviceId);
  return Number(db.prepare(`INSERT INTO channel (site_id, source_id, device_id, point, metric_id, scale, shift, part, min_value, max_value, access, enum_values, recorded_at,
      kind, derived_metric_id, counter_wrap, counter_reset_below, max_gap_s, max_stuck_samples, clock_offset_s, future_tolerance_s)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(siteId, src, deviceId, point, met, scale, shift, part, min, max, access, enumValues ? JSON.stringify(enumValues) : null, now,
      kind, derived ? metricId(derived) : null, counterWrap, counterResetBelow, maxGapS, maxStuckSamples, clockOffsetS, futureToleranceS).lastInsertRowid);
}

// Create a home's (or a device's) channels from the defaults where it has none for that point and metric: the source's own
// (registry.js SOURCES channels) and, for a device, those its KIND brings whatever source feeds it (registry.js DEVICE_KIND_CHANNELS:
// a heat pump, an EV charger and a smart plug each have standard points). Existing rows (an installer's change) are left alone.
// Cheap when nothing is missing.
export function ensureChannels(siteId, source, deviceId = null) {
  const defs = [...(SOURCES.find((s) => s.code === source)?.channels ?? [])];
  if (deviceId != null) {
    const kind = db.prepare('SELECT kind FROM device WHERE id = ?').get(deviceId)?.kind;
    for (const d of DEVICE_KIND_CHANNELS[kind] ?? []) if (!defs.some((x) => x.point === d.point && x.metric === d.metric)) defs.push(d);
  }
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
  return db.prepare(`SELECT c.*, m.code AS metric, m.time_role, dm.code AS derived_metric FROM channel c JOIN metric m ON m.id = c.metric_id LEFT JOIN metric dm ON dm.id = c.derived_metric_id
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

// A run of identical samples on a channel that declares max_stuck_samples: from the Nth identical sample on, the row is
// stored with the suspect flag (a sensor that stopped updating), and counted. Looks back at the stored samples before the batch.
function flagStuck(id, rows, n) {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return { rows, stuck: 0 };
  const tail = db.prepare('SELECT value FROM reading WHERE series_id = ? AND ts < ? AND superseded_at IS NULL ORDER BY ts DESC LIMIT ?').all(id, sorted[0].ts, n - 1).map((r) => r.value).reverse();
  let run = 0; let last = null; let stuck = 0;
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  for (const v of tail) { run = same(v, last) ? run + 1 : 1; last = v; }
  for (const r of sorted) {
    run = same(r.value, last) ? run + 1 : 1; last = r.value;
    if (run >= n) { r.quality = (r.quality ?? QUALITY.MEASURED) | QUALITY.SUSPECT; stuck++; }
  }
  return { rows: sorted, stuck };
}

/**
 * Write a vendor's observations through its channels.
 * @param observations each has { point, value } (an event needs no value) and optionally { quality, rawId, kind }. The shape says what it is,
 *   and the point's channel kind (value | counter | event, delta 072) says how it is stored:
 *   an instant   { ts }
 *   a period     { start, end }
 *   a forecast   { start, end, issuedAt }   (a prediction made at issuedAt, seconds)
 *   a state      { kind: 'state', ts }      what a device says its own setting is (target level, mode code, window start
 *                as minute of day): checked against the channel's range and enum, stored as a reading, held until it changes,
 *                and it never queues a rebuild
 *   an ack       { kind: 'ack', ref, commandId, ts }   a receipt that a write was applied. NOT a fact: it is returned in
 *                `acks` for the executor and never written to a fact table
 *   a counter    { ts, value } on a channel of kind counter: a cumulative reading. The raw value is stored as a reading and the
 *                energy of each period is derived by difference (core/counters.js); a drop that is not a reset or a wrap is rejected
 *   an event     { ts } or { start, end } on a channel of kind event: stored as a 0/1 period (an instant is one second), never integrated
 *                or averaged; a value of 0 means no event and stores nothing
 * Optional per channel: clock_offset_s is added to every timestamp, future_tolerance_s rejects a timestamp too far ahead
 * (future_timestamp), max_stuck_samples flags a run of identical samples as suspect.
 * @param opts { requireData: true } - an answer with no observations at all is an error, not a quiet success
 *   { deviceId } - the observations belong to that device (its own channels, series stored per device)
 *   { subject: { kind, id } } - the series subject when it is neither the home nor a device (a region)
 *   { now } - the clock in seconds for the future check (default the real clock)
 * @returns { written (facts about the past or present, derived counter energy included), forecasts (predictions), states, counters (raw counter
 *   readings stored), derived (counter periods stored), stuck (samples flagged), acks: [{ ref, commandId, ts }], rejected, unmapped: [point] }
 *   - unmapped points are reported, never dropped silently
 */
export function ingestObservations(siteId, source, observations, rawId = null, { requireData = false, deviceId = null, subject = null, now = nowSec() } = {}) {
  if (requireData && !observations.length) throw new Error(`${source}: the answer had no observations (an empty answer is not a success)`);
  ensureChannels(siteId, source, deviceId);
  const src = sourceId(source);
  const channels = new Map();
  for (const c of channelsFor(siteId, source, null, deviceId)) (channels.get(c.point) || channels.set(c.point, []).get(c.point)).push(c);
  const groups = new Map();   // kind|metric|issuedAt -> { kind, metric, issuedAt, rows, stuckN }
  const counterGroups = new Map();   // channel id -> { c, rows }
  const unmapped = new Set(); let rejected = 0; const acks = [];
  for (const o of observations) {
    if (o.kind === 'ack') { acks.push({ ref: o.ref ?? null, commandId: o.commandId ?? null, ts: o.ts ?? nowSec() }); continue; }
    const list = channels.get(o.point);
    if (!list) { unmapped.add(o.point); continue; }
    const isState = o.kind === 'state';
    for (const c of list) {
      const off = c.clock_offset_s || 0;
      const ts = o.ts != null ? o.ts + off : null; const start = o.start != null ? o.start + off : null; const end = o.end != null ? o.end + off : null;
      const issuedAt = o.issuedAt != null ? o.issuedAt + off : null;
      if ((o.kind === 'counter' && c.kind !== 'counter') || (o.kind === 'event' && c.kind !== 'event') || (c.kind !== 'value' && (isState || issuedAt != null))) {
        reject(siteId, src, o.point, ts ?? start ?? nowSec(), Number(o.value), 'kind_mismatch'); rejected++; continue;
      }
      const kind = c.kind === 'counter' ? 'counter' : c.kind === 'event' ? 'event' : isState ? 'state' : issuedAt != null ? 'forecast' : ts != null ? 'reading' : 'interval';
      if ((isState || kind === 'counter') && ts == null) { reject(siteId, src, o.point, nowSec(), null, isState ? 'state_without_time' : 'counter_without_time'); rejected++; continue; }
      if (kind === 'event' && ts == null && start == null) { reject(siteId, src, o.point, nowSec(), null, 'event_without_time'); rejected++; continue; }
      const at = ts ?? start;
      if (c.future_tolerance_s != null && kind !== 'forecast' && (ts ?? end ?? start) > now + c.future_tolerance_s) { reject(siteId, src, o.point, at, Number(o.value), 'future_timestamp'); rejected++; continue; }
      if (kind === 'event') {
        if (o.value === 0 || o.value === false) continue;         // an explicit "no event" is not an event
        const g = groups.get(`event|${c.metric}`) || groups.set(`event|${c.metric}`, { kind: 'interval', metric: c.metric, issuedAt: null, rows: [] }).get(`event|${c.metric}`);
        g.rows.push({ start: ts ?? start, end: end ?? (ts ?? start) + 1, value: 1, quality: o.quality, rawId: o.rawId });
        continue;
      }
      const v = o.value == null ? null : Number(o.value);
      if (v != null && !Number.isFinite(v)) { reject(siteId, src, o.point, at, null, 'not_a_number'); rejected++; continue; }
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
      if (kind === 'counter') {
        if (x == null) continue;                                    // a counter with no reading says nothing
        (counterGroups.get(c.id) || counterGroups.set(c.id, { c, rows: [] }).get(c.id)).rows.push({ ts, value: x, rawId: o.rawId });
        continue;
      }
      const key = `${kind}|${c.metric}|${issuedAt ?? ''}`;
      const g = groups.get(key) || groups.set(key, { kind, metric: c.metric, issuedAt, rows: [], stuckN: 0 }).get(key);
      if (kind === 'reading' && c.max_stuck_samples) g.stuckN = Math.max(g.stuckN, c.max_stuck_samples);
      g.rows.push(kind === 'reading' || kind === 'state' ? { ts, value: x, quality: o.quality, rawId: o.rawId } : { start, end, value: x, quality: o.quality, rawId: o.rawId });
    }
  }
  for (const p of unmapped) reject(siteId, src, p, nowSec(), null, 'unmapped_point');
  let written = 0; let forecasts = 0; let states = 0; let counters = 0; let derived = 0; let stuck = 0; let earliest = Infinity;
  const seriesOf = (metric) => (subject ? seriesId(subject.kind, String(subject.id), metric, source)
    : deviceId == null ? seriesId('site', siteId, metric, source) : seriesId('device', deviceId, metric, source));
  asWriter(source, () => {
    for (const { kind, metric, issuedAt, rows: all, stuckN } of groups.values()) {
      const id = seriesOf(metric);
      let rows = all;
      if (kind === 'reading' && stuckN) { const f = flagStuck(id, all, stuckN); rows = f.rows; stuck += f.stuck; }
      const n = kind === 'reading' || kind === 'state' ? putReadings(id, rows, rawId) : kind === 'interval' ? putIntervals(id, rows, rawId) : putForecasts(id, issuedAt, rows, rawId);
      // Forecasts of the future change nothing already built; only facts about the past or present mark a rebuild.
      if (kind === 'forecast') forecasts += n;
      else if (kind === 'state') states += n;
      else if (n) { written += n; earliest = Math.min(earliest, ...rows.map((r) => r.ts ?? r.start)); }
    }
    for (const { c, rows } of counterGroups.values()) {
      const r = storeCounter(siteId, source, c, rows, seriesOf, rawId, (point, at, value, reason) => { reject(siteId, src, point, at, value, reason); rejected++; });
      counters += r.raw; derived += r.derived; written += r.derived;
      if (r.earliest != null) earliest = Math.min(earliest, r.earliest);
    }
  });
  if (earliest < Infinity) markDirty(siteId, earliest, nowSec(), `new ${source} data`);
  return { written, forecasts, states, counters, derived, stuck, acks, rejected, unmapped: [...unmapped] };
}

// One counter channel: check each sample against its stored neighbours (a drop that is neither reset nor wrap is rejected), store
// the raw readings, then derive the periods around the changed samples again from everything stored (so a late sample splits the
// period it falls in instead of double counting it).
function storeCounter(siteId, source, c, rows, seriesOf, rawId, rejectFn) {
  const rawSeries = seriesOf(c.metric);
  const byTs = new Map(); for (const r of rows) byTs.set(r.ts, r);            // the same time twice: the later one wins
  const sorted = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const accepted = []; let lastAcc = null;
  for (const r of sorted) {
    const { prev: dbPrev, next: dbNext } = neighbours(rawSeries, r.ts);
    const prev = lastAcc && (!dbPrev || lastAcc.ts > dbPrev.ts) ? lastAcc : dbPrev;
    const backwards = (prev && classifyStep(prev.value, r.value, c).type === 'backwards') || (dbNext && classifyStep(r.value, dbNext.value, c).type === 'backwards');
    if (backwards) { rejectFn(c.point, r.ts, r.value, 'counter_backwards'); continue; }
    accepted.push(r); lastAcc = r;
  }
  if (!accepted.length) return { raw: 0, derived: 0, earliest: null };
  const raw = putReadings(rawSeries, accepted.map((r) => ({ ts: r.ts, value: r.value, quality: QUALITY.MEASURED, rawId: r.rawId })), rawId);
  if (!c.derived_metric) return { raw, derived: 0, earliest: raw ? accepted[0].ts : null };
  const lo = neighbours(rawSeries, accepted[0].ts).prev?.ts ?? accepted[0].ts;
  const hi = neighbours(rawSeries, accepted[accepted.length - 1].ts).next?.ts ?? accepted[accepted.length - 1].ts;
  const samples = readReadings([rawSeries], lo, hi + 1);
  const { periods } = deriveCounterPeriods(samples, c);
  const derivedSeries = seriesOf(c.derived_metric);
  withdrawDerived(siteId, derivedSeries, lo, hi, new Set(periods.map((p) => `${p.start}|${p.end}`)));
  const derived = putIntervals(derivedSeries, periods.map((p) => ({ start: p.start, end: p.end, value: p.value, quality: p.quality })), rawId);
  return { raw, derived, earliest: raw || derived ? lo : null };
}
