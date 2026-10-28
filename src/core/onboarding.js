// Provider onboarding: the read model and the writes behind the Providers screen and its API.
// Bindings (which source fills a role for a home, from when), channels (how a source's points become standard
// measurements) and the impact preview (what a change would do to slots already built) all exist in the core
// (inputs.js, channels.js, impact.js); this file only validates input, reads them together and calls them.
//
// Rules this file keeps:
//  - every write validates strictly and fails with an OnboardingError: a status (400, 404 or 409), a machine
//    code (unknown_role, unknown_source, unknown_metric, unknown_device, bad_part, bad_number, bad_date,
//    missing_field, reason_required) and a plain message;
//  - every write takes { dryRun: true }: it runs the change inside a savepoint that is rolled back and returns
//    what would happen (the bindings or channel that would result, and for a binding the impact on slots);
//  - a preview never keeps anything, and never needs a reason (nothing is recorded);
//  - the roles are read from inputs.js at call time, never copied here.
import { db, tx } from '../db/db.js';
import * as inputs from './inputs.js';
import { previewImpact } from './impact.js';
import { defineChannel } from './channels.js';
import { markDirty } from './facts.js';
import { processQueue } from './build.js';
import { nowSec, localDate, dayBounds } from './time.js';
import { SOURCES } from '../db/registry.js';

export class OnboardingError extends Error {
  constructor(status, code, message, field = null) { super(message); this.status = status; this.code = code; this.field = field; }
}
const bad = (code, message, field = null) => new OnboardingError(400, code, message, field);

export const PARTS = ['all', 'positive', 'negative', 'abs'];
export const ACCESS = ['read', 'write', 'readwrite'];

// What each role means in plain words, and the standard measurements it is made of (hints for the screen:
// a role missing here, such as one added later, still works; it is shown by its code with no hint).
export const ROLE_INFO = {
  inverter_5min: { label: 'Inverter, every 5 minutes', help: 'Power readings from the inverter: solar, house use, grid, battery.', metrics: ['solar_w', 'load_w', 'grid_import_w', 'grid_export_w', 'battery_charge_w', 'battery_discharge_w', 'battery_soc_pct'] },
  inverter_daily: { label: 'Inverter, daily totals', help: 'The inverter\'s own daily energy counters, used to correct the slot figures.', metrics: ['solar_kwh', 'load_kwh', 'grid_import_kwh', 'grid_export_kwh', 'battery_charge_kwh', 'battery_discharge_kwh'] },
  meter_energy: { label: 'Smart meter', help: 'The supplier\'s official import, export and gas energy per period.', metrics: ['grid_import_kwh', 'grid_export_kwh', 'gas_kwh', 'gas_m3'] },
  gas_cv: { label: 'Gas calorific value', help: 'Turns gas volume into energy.', metrics: ['gas_cv_mjm3'] },
  carbon: { label: 'Grid carbon intensity', help: 'Grams of carbon per kWh of grid electricity.', metrics: ['carbon_intensity'] },
  weather_temp: { label: 'Outdoor temperature', help: 'Used for heating and forecasts.', metrics: ['outdoor_temp_c', 'cloud_pct', 'gti_wm2', 'ghi_wm2'] },
  ev_dispatch: { label: 'EV charging periods', help: 'Smart-charge periods and the energy delivered.', metrics: ['ev_charge_kwh'] },
  solar_forecast: { label: 'Solar forecast', help: 'The forecast of record for the slots. Several sources can be listed; the first with a value wins.', metrics: ['solar_kwh'] },
};

const rolesNow = () => [...inputs.ROLES];
// A role with no entry above (one added later) is shown by its code made readable: heat_pump_energy -> Heat pump energy.
const labelOf = (role) => ROLE_INFO[role]?.label ?? role.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ───────────── Small helpers ─────────────

export function siteCheck(siteId) { return siteOf(siteId); }   // 404 when there is no such home
function siteOf(siteId) {
  const s = db.prepare('SELECT * FROM site WHERE id = ?').get(Number(siteId));
  if (!s) throw new OnboardingError(404, 'not_found', 'No such home');
  return s;
}
function roleOf(role) {
  if (!rolesNow().includes(role)) throw bad('unknown_role', `Unknown role "${role}". Roles: ${rolesNow().join(', ')}`, 'role');
  return role;
}
function sourceRow(code) {
  const r = db.prepare('SELECT id, code, name FROM source WHERE code = ?').get(String(code ?? ''));
  if (!r) throw bad('unknown_source', `Unknown source "${code ?? ''}". Add the source first (a source row), then bind it`, 'source');
  return r;
}
function metricRow(code) {
  const r = db.prepare('SELECT id, code, unit FROM metric WHERE code = ?').get(String(code ?? ''));
  if (!r) throw bad('unknown_metric', `Unknown measurement "${code ?? ''}"`, 'metric');
  return r;
}
function deviceOf(site, deviceId) {
  if (deviceId == null || deviceId === '') return null;
  const id = Number(deviceId);
  const d = Number.isInteger(id) && db.prepare('SELECT id, site_id FROM device WHERE id = ?').get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown_device', `Device ${deviceId} is not a device of this home`, 'deviceId');
  return id;
}
function num(v, field, { required = false, min = -Infinity, max = Infinity, nonZero = false } = {}) {
  if (v == null || v === '') { if (required) throw bad('missing_field', `${field} is required`, field); return null; }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad('bad_number', `${field} must be a number`, field);
  if (n < min || n > max) throw bad('bad_number', `${field} must be between ${min} and ${max}`, field);
  if (nonZero && n === 0) throw bad('bad_number', `${field} cannot be 0: every value would become 0`, field);
  return n;
}

// A date the user typed: a local date (2026-10-12) in the home's zone, epoch seconds, or the word now. Empty = from the beginning.
export function toTs(site, v, field = 'from') {
  if (v == null || v === '') return null;
  if (v === 'now') return nowSec();                      // "from now on": no built slot is touched, so no reason is needed
  if (typeof v === 'number' || /^\d{9,}$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw bad('bad_date', `${field} must be a date like 2026-10-12 or epoch seconds`, field);
    return n;
  }
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw bad('bad_date', `${field} must be a date like 2026-10-12 (local to the home) or epoch seconds`, field);
  return dayBounds(site.timezone, s)[0];
}
const dateOf = (site, ts) => (ts == null ? null : localDate(site.timezone, ts));

// Run fn inside a savepoint that is always rolled back: a dry run or a preview keeps nothing.
function rolledBack(fn) {
  db.exec('SAVEPOINT onboarding_dry');
  try { return fn(); } finally { db.exec('ROLLBACK TO onboarding_dry'); db.exec('RELEASE onboarding_dry'); }
}

// ───────────── Read model ─────────────

const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

function bindingRow(site, r) {
  return {
    id: r.id, role: r.role, source: r.source, sourceName: r.source_name, deviceId: r.device_id, priority: r.priority,
    from: r.valid_from, to: r.valid_to, fromDate: dateOf(site, r.valid_from), toDate: dateOf(site, r.valid_to),
    recordedAt: r.recorded_at, supersededAt: r.superseded_at, reason: r.reason,
  };
}
const BINDING_SQL = `SELECT b.*, so.code AS source, so.name AS source_name FROM binding b JOIN source so ON so.id = b.source_id`;

// How much data a source has for a home: facts under the home's own series and its devices' series.
function dataOf(site, sourceCode) {
  const siteId = site.id;
  // The home's own series, its devices' series and the series of its regions (carbon and gas calorific value live under a region).
  const ldz = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId).map((d) => parseJson(d.attrs)?.ldz).find(Boolean);
  const regions = [site.carbon_region != null ? `carbon:${site.carbon_region}` : null, ldz ? `ldz:${ldz}` : null].filter(Boolean);
  const ids = db.prepare(`SELECT se.id FROM series se JOIN source so ON so.id = se.source_id
    WHERE so.code = ? AND ((se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))
      ${regions.length ? `OR (se.subject_kind = 'region' AND se.subject_id IN (${regions.map(() => '?').join(',')}))` : ''})`)
    .all(sourceCode, String(siteId), siteId, ...regions).map((r) => r.id);
  if (!ids.length) return { series: 0, first: null, last: null };
  const q = ids.map(() => '?').join(',');
  const a = db.prepare(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM reading WHERE series_id IN (${q}) AND superseded_at IS NULL`).get(...ids);
  const b = db.prepare(`SELECT MIN(start_ts) AS first, MAX(end_ts) AS last FROM interval_fact WHERE series_id IN (${q}) AND superseded_at IS NULL`).get(...ids);
  const c = db.prepare(`SELECT MIN(start_ts) AS first, MAX(end_ts) AS last FROM forecast_fact WHERE series_id IN (${q})`).get(...ids);
  const first = [a.first, b.first, c.first].filter((v) => v != null);
  const last = [a.last, b.last, c.last].filter((v) => v != null);
  return { series: ids.length, first: first.length ? Math.min(...first) : null, last: last.length ? Math.max(...last) : null };
}

// The channels the registry gives a source (created for a home the first time the source delivers data).
const defaultsOf = (code) => (SOURCES.find((x) => x.code === code)?.channels ?? []).map((d) => ({ point: d.point, metric: d.metric, scale: d.scale ?? 1, shift: d.shift ?? 0, part: d.part ?? 'all', min: d.min ?? null, max: d.max ?? null }));

export function channelRows(siteId, { source = null, all = false } = {}) {
  const rows = db.prepare(`SELECT c.*, m.code AS metric, m.unit, so.code AS source FROM channel c JOIN metric m ON m.id = c.metric_id JOIN source so ON so.id = c.source_id
    WHERE c.site_id = ?${source ? ' AND so.code = ?' : ''}${all ? '' : ' AND c.superseded_at IS NULL'} ORDER BY so.code, c.device_id IS NOT NULL, c.device_id, c.point, m.code, c.id`)
    .all(siteId, ...(source ? [source] : []));
  return rows.map((r) => ({
    id: r.id, source: r.source, deviceId: r.device_id, point: r.point, metric: r.metric, unit: r.unit, scale: r.scale, shift: r.shift, part: r.part,
    min: r.min_value, max: r.max_value, access: r.access ?? 'read', enumValues: parseJson(r.enum_values), recordedAt: r.recorded_at, supersededAt: r.superseded_at,
  }));
}

export function rejects(siteId, { days = 7, source = null, recent = 20 } = {}) {
  const since = Date.now() - Math.max(Number(days) || 7, 0) * 86400000;
  const where = `r.site_id = ? AND r.recorded_at >= ?${source ? ' AND so.code = ?' : ''}`;
  const args = [siteId, since, ...(source ? [source] : [])];
  const base = `FROM channel_reject r JOIN source so ON so.id = r.source_id WHERE ${where}`;
  const byReason = Object.fromEntries(db.prepare(`SELECT r.reason, COUNT(*) n ${base} GROUP BY r.reason`).all(...args).map((x) => [x.reason, x.n]));
  const byPoint = db.prepare(`SELECT so.code AS source, r.point, r.reason, COUNT(*) n, MAX(r.recorded_at) last_at, MIN(r.value) min_value, MAX(r.value) max_value ${base} GROUP BY so.code, r.point, r.reason ORDER BY n DESC, last_at DESC LIMIT 50`).all(...args)
    .map((x) => ({ source: x.source, point: x.point, reason: x.reason, count: x.n, lastAt: x.last_at, minValue: x.min_value, maxValue: x.max_value }));
  const latest = db.prepare(`SELECT so.code AS source, r.point, r.ts, r.value, r.reason, r.recorded_at ${base} ORDER BY r.id DESC LIMIT ?`).all(...args, Number(recent) || 20)
    .map((x) => ({ source: x.source, point: x.point, ts: x.ts, value: x.value, reason: x.reason, recordedAt: x.recorded_at }));
  const total = Object.values(byReason).reduce((t, n) => t + n, 0);
  return { siteId, days: Number(days) || 7, total, byReason, unmapped: byPoint.filter((x) => x.reason === 'unmapped_point'), byPoint, recent: latest };
}

// The sources a home can bind: code, name, the contract in words, traits, the default channels the registry gives
// the source, and the roles whose standard measurements those defaults can fill (a hint, not a limit).
export function sourcesList() {
  const roles = rolesNow();
  const sources = db.prepare('SELECT code, name, contract, traits FROM source ORDER BY code').all().map((s) => {
    const def = defaultsOf(s.code);
    const metrics = new Set(def.map((d) => d.metric));
    const suggestedRoles = roles.filter((r) => (ROLE_INFO[r]?.metrics ?? []).some((m) => metrics.has(m)));
    return { code: s.code, name: s.name, contract: parseJson(s.contract) ?? {}, traits: parseJson(s.traits) ?? {}, defaultChannels: def, suggestedRoles };
  });
  const metrics = db.prepare('SELECT code, label, unit, time_role AS timeRole, domain FROM metric ORDER BY domain, code').all();
  return { sources, metrics, roles: roles.map((r) => ({ role: r, label: labelOf(r), help: ROLE_INFO[r]?.help ?? '', metrics: ROLE_INFO[r]?.metrics ?? [] })), parts: PARTS, access: ACCESS };
}

// Everything the Providers screen shows for one home.
export function onboarding(siteId) {
  const site = siteOf(siteId);
  const all = db.prepare(`${BINDING_SQL} WHERE b.site_id = ? ORDER BY b.recorded_at DESC, b.id DESC LIMIT 500`).all(site.id).map((r) => bindingRow(site, r));
  const current = all.filter((b) => b.supersededAt == null);
  const dataCache = new Map();
  const dataFor = (code) => { if (!dataCache.has(code)) dataCache.set(code, dataOf(site, code)); return dataCache.get(code); };
  const roles = rolesNow().map((role) => ({
    role, label: labelOf(role), help: ROLE_INFO[role]?.help ?? '', metrics: ROLE_INFO[role]?.metrics ?? [],
    bindings: current.filter((b) => b.role === role).sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity) || a.priority - b.priority || a.id - b.id)
      .map((b) => ({ ...b, data: dataFor(b.source), defaultChannels: defaultsOf(b.source) })),
  }));
  const channels = channelRows(site.id);
  const devices = db.prepare('SELECT id, kind, provider, label, retired_at AS retiredAt FROM device WHERE site_id = ? ORDER BY id').all(site.id);
  const rj = rejects(site.id, { days: 7 });
  return {
    site: { id: site.id, name: site.name, timezone: site.timezone, slot_s: site.slot_s ?? 1800, currency: site.currency ?? 'GBP' },
    now: nowSec(), roles, history: all.slice(0, 100), channels, devices,
    rejects: { days: rj.days, total: rj.total, byReason: rj.byReason, unmapped: rj.unmapped, byPoint: rj.byPoint.slice(0, 10), recent: rj.recent.slice(0, 8) },
  };
}

// ───────────── Writes: bindings ─────────────

function bindingArgs(site, body, action) {
  const role = roleOf(body.role);
  // deviceId: a device id = that device's binding; "home" = the home's own binding only; omitted = every open binding of the role.
  const scoped = body.deviceId !== undefined && body.deviceId !== null && body.deviceId !== '';
  const out = { role, scoped, deviceId: scoped ? (body.deviceId === 'home' ? null : deviceOf(site, body.deviceId)) : undefined };
  if (action === 'bind') {
    out.source = sourceRow(body.source).code;
    out.from = toTs(site, body.from, 'from');
    out.priority = num(body.priority ?? 0, 'priority', { min: 0, max: 99 }) ?? 0;
    out.keep = body.keep === true || body.keep === 'true';
  } else {
    out.at = body.at == null || body.at === '' ? nowSec() : toTs(site, body.at, 'at');
  }
  out.reason = body.reason == null ? null : String(body.reason).trim() || null;
  return out;
}

function runBinding(siteId, a, action, reason) {
  return action === 'bind'
    ? inputs.bind(siteId, a.role, a.source, { from: a.from, reason, priority: a.priority, keep: a.keep, ...(a.scoped ? { deviceId: a.deviceId } : {}) })
    : inputs.unbind(siteId, a.role, { at: a.at, reason, ...(a.scoped ? { deviceId: a.deviceId } : {}) });
}
const currentOf = (site, role) => db.prepare(`${BINDING_SQL} WHERE b.site_id = ? AND b.role = ? AND b.superseded_at IS NULL ORDER BY b.valid_from IS NOT NULL, b.valid_from, b.priority, b.id`).all(site.id, role).map((r) => bindingRow(site, r));

function warningsFor(site, a, action) {
  const w = [];
  if (action === 'bind') {
    const d = dataOf(site, a.source);
    if (!d.series) w.push(`"${a.source}" has no data for this home yet. Slots from the start date will show this input as missing until the source delivers data.`);
    if (!db.prepare('SELECT 1 FROM channel c JOIN source so ON so.id = c.source_id WHERE c.site_id = ? AND so.code = ? AND c.superseded_at IS NULL').get(site.id, a.source)
      && !(SOURCES.find((x) => x.code === a.source)?.channels?.length)) w.push(`"${a.source}" has no channels on this home: its points are not mapped to standard measurements, so nothing it sends can be used.`);
  } else if (!db.prepare('SELECT 1 FROM binding WHERE site_id = ? AND role = ? AND superseded_at IS NULL AND valid_to IS NULL').get(site.id, a.role)) {
    w.push('This role has no open binding: there is nothing to end.');
  }
  return w;
}

// What a binding or unbinding would do: the bindings that would result, whether a reason is needed, and the effect on
// the slots already built. Nothing is kept.
export function previewBinding(siteId, body, action = 'bind') {
  const site = siteOf(siteId);
  const a = bindingArgs(site, body, action);
  let needsReason = false;
  rolledBack(() => { try { runBinding(site.id, a, action, null); } catch (e) { if (/say why/.test(e.message)) needsReason = true; else throw e; } });
  const would = rolledBack(() => { runBinding(site.id, a, action, a.reason ?? 'preview'); return currentOf(site, a.role); });
  const impact = previewImpact(site.id, () => runBinding(site.id, a, action, a.reason ?? 'preview'));
  const first = impact.firstChanged, last = impact.lastChanged;
  return {
    action, role: a.role, source: a.source ?? null, from: a.from ?? a.at ?? null, fromDate: dateOf(site, a.from ?? a.at ?? null),
    needsReason, reasonGiven: Boolean(a.reason), warnings: warningsFor(site, a, action), would,
    impact: { ...impact, firstChangedDate: dateOf(site, first), lastChangedDate: dateOf(site, last), currency: site.currency ?? 'GBP' },
  };
}

// Make the change. { dryRun: true } returns the preview instead. rebuild: rebuild the affected days now.
export function applyBinding(siteId, body, action = 'bind', { dryRun = false, rebuild = false } = {}) {
  if (dryRun) return { dryRun: true, ...previewBinding(siteId, body, action) };
  const site = siteOf(siteId);
  const a = bindingArgs(site, body, action);
  let result;
  try {
    const r = tx(() => runBinding(site.id, a, action, a.reason));
    result = action === 'bind' ? { id: r, role: a.role } : { ended: r, role: a.role };   // bind returns the new row, unbind how many it ended
  } catch (e) {
    if (/say why/.test(e.message)) throw new OnboardingError(409, 'reason_required', 'This change alters slots that are already built: say why (a reason is required)', 'reason');
    throw e;
  }
  // The built slots follow the new binding: queue a rebuild from the start date (from the first built slot when there is none).
  const startTs = a.from ?? a.at ?? null;
  const firstBuilt = db.prepare('SELECT MIN(slot_start) AS t FROM site_hh WHERE site_id = ?').get(site.id).t;
  const fromTs = startTs ?? firstBuilt;
  let queued = null;
  if (fromTs != null && firstBuilt != null && Math.max(fromTs, firstBuilt) < nowSec()) {   // a start date still ahead changes no built slot yet
    markDirty(site.id, Math.max(fromTs, firstBuilt), nowSec(), `${action} ${a.role}${a.source ? ` ${a.source}` : ''}`);
    queued = { from: Math.max(fromTs, firstBuilt), fromDate: dateOf(site, Math.max(fromTs, firstBuilt)) };
  }
  const rebuilt = rebuild && queued ? processQueue().filter((x) => x.siteId === site.id) : [];
  return { dryRun: false, ...result, action, bindings: currentOf(site, a.role), queued, rebuilt };
}

// ───────────── Writes: channels ─────────────

function channelArgs(site, body) {
  const source = sourceRow(body.source).code;
  const metric = metricRow(body.metric).code;
  const point = String(body.point ?? '').trim();
  if (!point) throw bad('missing_field', 'point is required: the provider\'s own name for the measurement', 'point');
  const part = body.part == null || body.part === '' ? 'all' : String(body.part);
  if (!PARTS.includes(part)) throw bad('bad_part', `part must be one of ${PARTS.join(', ')}`, 'part');
  const access = body.access == null || body.access === '' ? 'read' : String(body.access);
  if (!ACCESS.includes(access)) throw bad('bad_number', `access must be one of ${ACCESS.join(', ')}`, 'access');
  const scale = num(body.scale ?? 1, 'scale', { nonZero: true }) ?? 1;
  const shift = num(body.shift ?? 0, 'shift') ?? 0;
  const min = num(body.min, 'min'); const max = num(body.max, 'max');
  if (min != null && max != null && min > max) throw bad('bad_number', 'min cannot be above max', 'min');
  return { source, point, metric, scale, shift, part, min, max, access, deviceId: body.deviceId === 'home' ? null : deviceOf(site, body.deviceId) };
}

// Define (or replace) the channel of a point and measurement.
export function applyChannel(siteId, body, { dryRun = false } = {}) {
  const site = siteOf(siteId);
  const a = channelArgs(site, body);
  const make = () => {
    const id = defineChannel(site.id, a.source, a.point, a.metric, { scale: a.scale, shift: a.shift, part: a.part, min: a.min, max: a.max, deviceId: a.deviceId, access: a.access });
    return { id, channel: channelRows(site.id, { source: a.source }).find((c) => c.id === id) };
  };
  const replaces = channelRows(site.id, { source: a.source }).filter((c) => c.point === a.point && c.metric === a.metric && c.deviceId === a.deviceId).map((c) => c.id);
  if (dryRun) return { dryRun: true, replaces, ...rolledBack(make) };
  return { dryRun: false, replaces, ...tx(make) };
}

// Stop using a channel (kept, superseded): the point it mapped is reported as unmapped from now on.
export function retireChannel(siteId, body, { dryRun = false } = {}) {
  const site = siteOf(siteId);
  const id = num(body.id, 'id', { required: true });
  const row = db.prepare('SELECT id FROM channel WHERE id = ? AND site_id = ? AND superseded_at IS NULL').get(id, site.id);
  if (!row) throw new OnboardingError(404, 'not_found', `No current channel ${id} on this home`, 'id');
  const go = () => { db.prepare('UPDATE channel SET superseded_at = ? WHERE id = ?').run(Date.now(), id); return { id }; };
  return dryRun ? { dryRun: true, ...rolledBack(go) } : { dryRun: false, ...tx(go) };
}
