// The read model of the Devices page: every device of a home with its channels, last values and status, and the data of one
// device over a time window (raw counter, derived energy per period, instants, events, refused values, commands). Reads only,
// except simulate and sendCommand, which are allowed for SYNTHETIC devices only (core/synthetic-iot.js) and go through the real
// ingest and control paths.
import { db } from '../db/db.js';
import { bindingsFor, ROLES } from './inputs.js';
import { commandLog, getCommand } from './commands.js';
import { nowSec } from './time.js';
import { QUALITY } from './facts.js';
import { DEVICES, SYNTHETIC_NOTE, isSyntheticDevice, isSyntheticSource, simulatePeriods, sendTestCommand, findSyntheticIotSite } from './synthetic-iot.js';

export class DevicesError extends Error {
  constructor(status, code, message, field = null) { super(message); this.status = status; this.code = code; this.field = field; }
}

// How old the newest data of a device may be and still count as "receiving data" (s). A smart meter's data arrives a day late,
// a car's cloud account hours late, a local device every few minutes. Beyond STALE_S the device has no recent data at all.
const FRESH_S = { default: 900, ev: 6 * 3600, meter: 36 * 3600 };
const STALE_S = 7 * 86400;
const freshLimit = (kind) => (String(kind).startsWith('meter_') ? FRESH_S.meter : FRESH_S[kind] ?? FRESH_S.default);

const ICONS = { smart_plug: 'plug', heat_pump: 'heat', ev_charger: 'ev', ev: 'ev', battery: 'battery', temperature_sensor: 'temp', inverter: 'solar', meter_import: 'meter', meter_export: 'meter', meter_gas: 'gas', meter_heat: 'heat' };

export function siteOf(id) {
  const s = db.prepare('SELECT * FROM site WHERE id = ?').get(Number(id));
  if (!s) throw new DevicesError(404, 'not_found', `No home ${id}`);
  return s;
}
export function deviceOf(site, deviceId) {
  const d = db.prepare('SELECT * FROM device WHERE id = ? AND site_id = ?').get(Number(deviceId), site.id);
  if (!d) throw new DevicesError(404, 'unknown_device', `No device ${deviceId} in this home`, 'deviceId');
  return d;
}

// ───────────── Channels and last values of one device ─────────────
const lastReading = db.prepare(`SELECT r.ts, r.value, r.quality FROM reading r WHERE r.series_id = ? AND r.superseded_at IS NULL AND r.value IS NOT NULL ORDER BY r.ts DESC LIMIT 1`);
const lastInterval = db.prepare(`SELECT i.start_ts, i.end_ts, i.value, i.quality FROM interval_fact i WHERE i.series_id = ? AND i.superseded_at IS NULL ORDER BY i.end_ts DESC LIMIT 1`);
const seriesOfMetric = (subjectKind, subjectId, metricId) => db.prepare('SELECT se.id, so.code AS source FROM series se JOIN source so ON so.id = se.source_id WHERE se.subject_kind = ? AND se.subject_id = ? AND se.metric_id = ?').all(subjectKind, String(subjectId), metricId);

function metricRow(id) { return db.prepare('SELECT id, code, label, unit, time_role FROM metric WHERE id = ?').get(id); }

// The channel rows of a device (current ones), plus any series of the device no channel row describes (data written before channels
// existed): those are shown too, with point null, so nothing a device holds is hidden.
function channelsOfDevice(site, device) {
  const rows = db.prepare(`SELECT c.*, so.code AS source FROM channel c JOIN source so ON so.id = c.source_id WHERE c.site_id = ? AND c.device_id = ? AND c.superseded_at IS NULL ORDER BY c.id`).all(site.id, device.id);
  const out = rows.map((c) => {
    const m = metricRow(c.metric_id); const dm = c.derived_metric_id ? metricRow(c.derived_metric_id) : null;
    return { id: c.id, point: c.point, source: c.source, kind: c.kind, access: c.access, scale: c.scale, shift: c.shift, part: c.part, min: c.min_value, max: c.max_value,
      metric: m, derived: dm, enumValues: c.enum_values ? JSON.parse(c.enum_values) : null, hasChannel: true };
  });
  const known = new Set(out.flatMap((c) => [c.metric.id, c.derived?.id].filter(Boolean)));
  for (const s of db.prepare("SELECT DISTINCT se.metric_id, so.code AS source FROM series se JOIN source so ON so.id = se.source_id WHERE se.subject_kind = 'device' AND se.subject_id = ?").all(String(device.id))) {
    if (known.has(s.metric_id)) continue;
    const m = metricRow(s.metric_id);
    out.push({ id: null, point: null, source: s.source, kind: m.time_role === 'interval' ? 'period' : 'value', access: 'read', scale: 1, shift: 0, part: 'all', min: null, max: null, metric: m, derived: null, enumValues: null, hasChannel: false });
  }
  return out;
}

// The newest value of a channel: { ts, value, unit, text } (ts in epoch s), and for a counter also the energy of its last period.
function lastOf(subjectKind, subjectId, ch) {
  const find = (m) => seriesOfMetric(subjectKind, subjectId, m.id).filter((s) => !ch.source || s.source === ch.source || !s.source);
  if (ch.kind === 'counter') {
    const raw = find(ch.metric).map((s) => lastReading.get(s.id)).find(Boolean) ?? null;
    const per = ch.derived ? find(ch.derived).map((s) => lastInterval.get(s.id)).find(Boolean) ?? null : null;
    return { ts: raw?.ts ?? null, value: raw?.value ?? null, unit: ch.metric.unit, period: per ? { start: per.start_ts, end: per.end_ts, value: per.value, unit: ch.derived.unit, partial: (per.quality & QUALITY.PARTIAL) !== 0, estimated: (per.quality & QUALITY.ESTIMATED) !== 0 } : null };
  }
  if (ch.kind === 'event') {
    const e = find(ch.metric).map((s) => db.prepare('SELECT start_ts, end_ts FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL AND value > 0 ORDER BY start_ts DESC LIMIT 1').get(s.id)).find(Boolean);
    return { ts: e?.start_ts ?? null, value: e ? 1 : null, unit: 'event', event: e ? { start: e.start_ts, end: e.end_ts } : null };
  }
  if (ch.metric.time_role === 'interval') {
    const i = find(ch.metric).map((s) => lastInterval.get(s.id)).find(Boolean);
    return { ts: i?.end_ts ?? null, value: i?.value ?? null, unit: ch.metric.unit };
  }
  const r = find(ch.metric).map((s) => lastReading.get(s.id)).find(Boolean);
  return { ts: r?.ts ?? null, value: r?.value ?? null, unit: ch.metric.unit };
}
const wordOf = (ch, v) => (v != null && ch.enumValues ? ch.enumValues[String(v)] ?? null : null);

function rejectCount(siteId, source, point) {
  if (!point) return 0;
  return db.prepare('SELECT COUNT(*) n FROM channel_reject c JOIN source s ON s.id = c.source_id WHERE c.site_id = ? AND s.code = ? AND c.point = ?').get(siteId, source, point).n;
}

function statusOf(kind, newestTs, now) {
  if (newestTs == null) return { status: 'missing', ageS: null, words: 'No data yet' };
  const age = Math.max(0, now - newestTs);
  if (age <= freshLimit(kind)) return { status: 'fresh', ageS: age, words: 'Receiving data' };
  if (age <= STALE_S) return { status: 'stale', ageS: age, words: 'No new data' };
  return { status: 'missing', ageS: age, words: 'No recent data' };
}

// Roles a device fills: a binding that names the device, or a home-level binding of a source the device has data from.
function rolesOf(site, device, now) {
  const sources = new Set(db.prepare("SELECT DISTINCT so.code FROM series se JOIN source so ON so.id = se.source_id WHERE se.subject_kind = 'device' AND se.subject_id = ?").all(String(device.id)).map((r) => r.code));
  const out = [];
  for (const role of ROLES) for (const b of bindingsFor(site.id, role)) {
    if (b.deviceId === device.id || (b.deviceId == null && sources.has(b.source))) out.push({ role, source: b.source, open: b.to === Infinity });
  }
  return out;
}

// ───────────── The inverter of the home, as a device ─────────────
// A home's inverter is stored against the home, not a device row. It is listed as a pseudo device (id "site") so the page shows
// everything that feeds the home.
function inverterPseudo(site, now) {
  const bound = [...new Set(bindingsFor(site.id, 'inverter_5min').map((b) => b.source))];
  if (!bound.length) return null;
  const rows = db.prepare(`SELECT se.id, se.metric_id, so.code AS source FROM series se JOIN source so ON so.id = se.source_id
    WHERE se.subject_kind = 'site' AND se.subject_id = ? AND so.code IN (${bound.map(() => '?').join(',')})`).all(String(site.id), ...bound);
  const channels = [];
  for (const s of rows) {
    const m = metricRow(s.metric_id);
    if (m.time_role !== 'instant') continue;
    const r = lastReading.get(s.id);
    if (r) channels.push({ id: null, point: null, source: s.source, kind: 'value', access: 'read', metric: m, derived: null, hasChannel: false, last: { ts: r.ts, value: r.value, unit: m.unit }, rejected: 0 });
  }
  if (!channels.length) return null;
  const newest = Math.max(...channels.map((c) => c.last.ts));
  return { id: 'site', kind: 'inverter', label: 'Inverter (reports for the whole home)', provider: bound.join(', '), synthetic: false, status: statusOf('inverter', newest, now), newestTs: newest,
    channels, roles: bound.length ? [{ role: 'inverter_5min', source: bound[0], open: true }] : [], icon: 'solar' };
}

// ───────────── The list ─────────────
export function listDevices(siteId, { now = nowSec() } = {}) {
  const site = siteOf(siteId);
  const out = [];
  for (const d of db.prepare('SELECT * FROM device WHERE site_id = ? AND retired_at IS NULL ORDER BY id').all(site.id)) {
    const chans = channelsOfDevice(site, d).map((c) => ({ ...c, last: lastOf('device', d.id, c), rejected: rejectCount(site.id, c.source, c.point) }));
    const newest = Math.max(0, ...chans.map((c) => c.last.ts ?? 0)) || null;
    const attrs = (() => { try { return JSON.parse(d.attrs || '{}'); } catch { return {}; } })();
    out.push({
      // the fields this route has always returned
      kind: d.kind, provider: d.provider, label: d.label, profileClass: attrs.profileClass ?? null, annualKwh: attrs.annualKwh ?? null, gasUnit: attrs.gasUnit ?? null, state: attrs.status?.currentState ?? null,
      // the new ones
      id: d.id, icon: ICONS[d.kind] ?? 'device', synthetic: isSyntheticDevice(d) || chans.some((c) => isSyntheticSource(c.source)), status: statusOf(d.kind, newest, now), newestTs: newest,
      channelCount: chans.length, controllable: isControllable(d),
      channels: chans.map((c) => ({ point: c.point, source: c.source, kind: c.kind, metric: c.metric.code, label: c.metric.label, unit: c.metric.unit, access: c.access, last: { ...c.last, word: wordOf(c, c.last.value) } })),
      roles: rolesOf(site, d, now),
    });
  }
  const inv = inverterPseudo(site, now);
  if (inv) {
    out.push({ kind: 'inverter', provider: inv.provider, label: inv.label, profileClass: null, annualKwh: null, gasUnit: null, state: null,
      id: inv.id, icon: inv.icon, synthetic: false, status: inv.status, newestTs: inv.newestTs, channelCount: inv.channels.length, controllable: false,
      channels: inv.channels.map((c) => ({ point: null, source: c.source, kind: c.kind, metric: c.metric.code, label: c.metric.label, unit: c.metric.unit, access: 'read', last: c.last })), roles: inv.roles });
  }
  return out;
}

export function isControllable(device) {
  return !!db.prepare("SELECT 1 FROM device_capability WHERE device_id = ? AND action = 'charge' AND supported = 1").get(device.id);
}

// ───────────── One device ─────────────
const DOWNSAMPLE = 700;
function thin(points) {
  if (points.length <= DOWNSAMPLE) return points;
  const k = Math.ceil(points.length / DOWNSAMPLE);
  return points.filter((_, i) => i % k === 0 || i === points.length - 1);
}
function gapsOf(points, factor = 3) {
  if (points.length < 4) return [];
  const d = points.slice(1).map((p, i) => p.ts - points[i].ts).sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  const out = [];
  for (let i = 1; i < points.length; i++) if (points[i].ts - points[i - 1].ts > Math.max(factor * med, 600)) out.push({ from: points[i - 1].ts, to: points[i].ts });
  return out;
}

/**
 * One device over a window. hours: how much history (default 36), ending at the device's newest data (or now when it is recent).
 * Returns { device, synthetic, banner, window, status, channels: [{ ...channel, last, rejected, data }], settings, rejects, commands, markers }.
 * data by kind: counter { raw: [{ts, v}], periods: [{start, end, value, kw, type}] }, value { points, gaps }, event { intervals }.
 */
export function deviceDetail(siteId, deviceId, { hours = 36, now = nowSec() } = {}) {
  const site = siteOf(siteId);
  hours = Math.min(Math.max(Number(hours) || 36, 1), 168);
  if (deviceId === 'site') return inverterDetail(site, hours, now);
  const device = deviceOf(site, deviceId);
  const chans = channelsOfDevice(site, device).map((c) => ({ ...c, last: lastOf('device', device.id, c), rejected: rejectCount(site.id, c.source, c.point) }));
  const newest = Math.max(0, ...chans.map((c) => c.last.ts ?? 0)) || null;
  const end = newest == null ? now : (now - newest < 2 * 3600 ? Math.max(now, newest) : newest + 1800);
  const start = end - hours * 3600;
  const synthetic = isSyntheticDevice(device);
  const detail = [];
  const settings = [];
  const markers = { resets: [], gaps: [], estimated: [] };
  for (const c of chans) {
    const base = { point: c.point, source: c.source, kind: c.kind, access: c.access, scale: c.scale, shift: c.shift, part: c.part, min: c.min, max: c.max, metric: c.metric.code, label: c.metric.label, unit: c.metric.unit, derivedMetric: c.derived?.code ?? null,
      derivedUnit: c.derived?.unit ?? null, last: { ...c.last, word: wordOf(c, c.last.value) }, rejected: c.rejected, hasChannel: c.hasChannel };
    if (c.access !== 'read') { settings.push({ point: c.point, label: c.metric.label, unit: c.metric.unit, value: c.last.value, word: wordOf(c, c.last.value), ts: c.last.ts, access: c.access }); continue; }
    base.data = dataOf(device, c, start, end, markers);
    detail.push(base);
  }
  const rejects = db.prepare(`SELECT c.point, c.ts, c.value, c.reason, s.code AS source FROM channel_reject c JOIN source s ON s.id = c.source_id
    WHERE c.site_id = ? AND s.code IN (${[...new Set(chans.map((c) => c.source))].map(() => '?').join(',') || "''"}) AND (c.ts BETWEEN ? AND ? OR c.reason = 'unmapped_point') ORDER BY c.recorded_at DESC LIMIT 40`)
    .all(site.id, ...new Set(chans.map((c) => c.source)), start, end + 3600);
  const cmds = db.prepare('SELECT id FROM command WHERE device_id = ? ORDER BY id DESC LIMIT 8').all(device.id).map((r) => getCommand(r.id));
  return {
    device: { id: device.id, kind: device.kind, label: device.label, provider: device.provider, icon: ICONS[device.kind] ?? 'device' },
    synthetic, banner: synthetic ? SYNTHETIC_NOTE : null, controllable: isControllable(device),
    site: { id: site.id, name: site.name, timezone: site.timezone, demo: !!site.is_demo },
    window: { start, end, hours }, status: statusOf(device.kind, newest, now), newestTs: newest, roles: rolesOf(site, device, now),
    channels: detail, settings, rejects, markers,
    commands: cmds.map((c) => ({ id: c.id, action: c.action, status: c.status, verifyStatus: c.verify_status, requestedAt: c.requested_at, sentAt: c.sent_at, ackedAt: c.acked_at, appliedLateAt: c.applied_late_at, desired: c.desired, reported: c.reported })),
    commandLog: cmds[0] ? commandLog(cmds[0].id) : [],
  };
}

function dataOf(device, c, start, end, markers) {
  const seriesIds = (m) => seriesOfMetric('device', device.id, m.id).filter((s) => !c.source || s.source === c.source).map((s) => s.id);
  if (c.kind === 'counter') {
    const raw = [];
    for (const id of seriesIds(c.metric)) raw.push(...db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND ts BETWEEN ? AND ? AND superseded_at IS NULL AND value IS NOT NULL ORDER BY ts').all(id, start - 3600, end));
    const periods = [];
    if (c.derived) for (const id of seriesIds(c.derived)) for (const p of db.prepare('SELECT start_ts, end_ts, value, quality FROM interval_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND superseded_at IS NULL ORDER BY start_ts').all(id, start, end)) {
      const dt = p.end_ts - p.start_ts;
      const partial = (p.quality & QUALITY.PARTIAL) !== 0; const estimated = (p.quality & QUALITY.ESTIMATED) !== 0;
      const type = partial ? 'reset' : estimated ? 'gap' : 'ok';
      periods.push({ start: p.start_ts, end: p.end_ts, value: p.value, kw: dt > 0 ? (p.value * 3600) / dt : null, type });
      if (partial) markers.resets.push({ ts: p.end_ts, point: c.point, unit: c.derived?.unit });
      if (estimated) markers.gaps.push({ from: p.start_ts, to: p.end_ts, point: c.point });
    }
    return { raw: thin(raw.map((r) => ({ ts: r.ts, v: r.value }))), periods };
  }
  if (c.kind === 'event') {
    const intervals = [];
    for (const id of seriesIds(c.metric)) intervals.push(...db.prepare('SELECT start_ts, end_ts FROM interval_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND superseded_at IS NULL AND value > 0 ORDER BY start_ts').all(id, start, end).map((r) => ({ start: r.start_ts, end: r.end_ts })));
    return { intervals };
  }
  const points = [];
  if (c.metric.time_role === 'interval') {
    for (const id of seriesIds(c.metric)) points.push(...db.prepare('SELECT start_ts AS ts, value FROM interval_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND superseded_at IS NULL ORDER BY start_ts').all(id, start, end));
  } else {
    for (const id of seriesIds(c.metric)) points.push(...db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND ts BETWEEN ? AND ? AND superseded_at IS NULL AND value IS NOT NULL ORDER BY ts').all(id, start, end));
  }
  points.sort((a, b) => a.ts - b.ts);
  const gaps = gapsOf(points);
  for (const g of gaps) markers.gaps.push({ ...g, point: c.point ?? c.metric.code });
  return { points: thin(points.map((p) => ({ ts: p.ts, v: p.value }))), gaps };
}

function inverterDetail(site, hours, now) {
  const inv = inverterPseudo(site, now);
  if (!inv) throw new DevicesError(404, 'unknown_device', 'This home has no inverter data', 'deviceId');
  const end = now - inv.newestTs < 2 * 3600 ? Math.max(now, inv.newestTs) : inv.newestTs + 1800;
  const start = end - hours * 3600;
  const markers = { resets: [], gaps: [], estimated: [] };
  const channels = inv.channels.slice(0, 8).map((c) => {
    const ids = seriesOfMetric('site', site.id, c.metric.id).filter((s) => s.source === c.source).map((s) => s.id);
    const pts = [];
    for (const id of ids) pts.push(...db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND ts BETWEEN ? AND ? AND superseded_at IS NULL AND value IS NOT NULL ORDER BY ts').all(id, start, end));
    const gaps = gapsOf(pts);
    return { point: null, source: c.source, kind: 'value', access: 'read', metric: c.metric.code, label: c.metric.label, unit: c.metric.unit, last: c.last, rejected: 0, hasChannel: false, data: { points: thin(pts.map((p) => ({ ts: p.ts, v: p.value }))), gaps } };
  });
  return { device: { id: 'site', kind: 'inverter', label: inv.label, provider: inv.provider, icon: 'solar' }, synthetic: false, banner: null, controllable: false,
    site: { id: site.id, name: site.name, timezone: site.timezone, demo: !!site.is_demo }, window: { start, end, hours }, status: inv.status, newestTs: inv.newestTs, roles: inv.roles,
    channels, settings: [], rejects: [], markers, commands: [], commandLog: [] };
}

// ───────────── Synthetic only: simulate and command ─────────────
function requireSynthetic(site, device) {
  if (!site.is_demo || !isSyntheticDevice(device)) throw new DevicesError(400, 'not_synthetic', 'This action only works on a synthetic demo device. A real device is never driven from this page.', 'deviceId');
}

export function simulate(siteId, deviceId, body = {}, { now = nowSec() } = {}) {
  const site = siteOf(siteId);
  const device = deviceOf(site, deviceId);
  requireSynthetic(site, device);
  const periods = body.periods == null ? 1 : Number(body.periods);
  if (!Number.isInteger(periods) || periods < 1 || periods > 12) throw new DevicesError(400, 'bad_number', 'periods is a whole number from 1 to 12', 'periods');
  const r = simulatePeriods(site.id, { periods, now });
  const key = DEVICES.find((d) => d.ref === device.external_ref)?.key;
  return {
    deviceId: device.id, added: r.added, caughtUp: r.caughtUp, from: r.from, to: r.to, requested: periods,
    note: r.caughtUp ? (r.added ? `Added ${r.added} of ${periods} periods: the demo home has caught up with the clock.` : 'Nothing added: the demo home has already caught up with the clock. A reading ahead of the clock would be refused.') : null,
    steps: r.steps.filter((s) => s.deviceKey === key),
  };
}

export async function sendCommand(siteId, deviceId, body = {}) {
  const site = siteOf(siteId);
  const device = deviceOf(site, deviceId);
  requireSynthetic(site, device);
  if (!isControllable(device)) throw new DevicesError(400, 'not_controllable', 'This device cannot be told what to do: it has no control capability.', 'deviceId');
  let target = null;
  if (body.targetSocPct != null) {
    target = Number(body.targetSocPct);
    if (!Number.isFinite(target) || target < 10 || target > 100) throw new DevicesError(400, 'bad_number', 'targetSocPct is a number from 10 to 100', 'targetSocPct');
  }
  const r = await sendTestCommand(site.id, device.id, { targetSocPct: target });
  const c = r.command;
  const path = c ? [
    { key: 'enqueued', label: 'Queued', done: true, at: c.requested_at },
    { key: 'sent', label: 'Sent to the device', done: c.sent_at != null, at: c.sent_at },
    { key: 'read_back', label: 'Read back from the device', done: c.reported != null, at: c.acked_at },
    { key: 'acked', label: 'Confirmed by the device itself', done: c.status === 'acked', at: c.acked_at },
    { key: 'verified', label: 'Effect seen in the readings', done: c.verify_status === 'verified', failed: c.verify_status === 'not_verified', at: null },
  ] : [];
  return { written: r.written, reason: r.reason ?? null, blocks: r.blocks ?? [], target: r.target, window: r.window, path, cycles: r.cycles,
    command: c ? { id: c.id, action: c.action, status: c.status, verifyStatus: c.verify_status, desired: c.desired, reported: c.reported, diff: c.diff } : null, log: r.log };
}

export function demoStatus() {
  const s = findSyntheticIotSite();
  return { exists: !!s, siteId: s?.id ?? null, name: s?.name ?? null };
}
