// Control support (Stage 4, docs/control-readback.md): the gates a command must pass to be queued, the map from a
// desired state to the points a device reports about itself, and the check that a command's effect showed up in
// telemetry. Nothing here names a vendor: the points are channels (channel.access, enum_values), the effect check is a
// column of device_action, the limits are rows of control_limit.
import { db, tx } from '../db/db.js';
import { freshness, series } from './planner-read.js';
import { defineChannel } from './channels.js';
import { localDate, dayBounds, todMinute } from './time.js';

// ───────────── Gates at enqueue ─────────────

const ALIAS = { charge_limit_pct: 'limit_pct', export_limit_pct: 'limit_pct', power_w: 'rate_w' };   // params_schema name -> desired key
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export async function capabilityRow(deviceId, action) {
  return await db.prepare('SELECT supported, source, verification FROM device_capability WHERE device_id = ? AND action = ?').get(deviceId, action) ?? null;
}

// The limits that bind a device: its own and those of every place it is in (a room's comfort range, the home's export limit), each member held
// to them one by one ('each'); a 'sum' limit is checked across the members of a group command (groupRequest), not here.
export async function limitsFor(deviceId, action, nowMs) {
  const places = (await db.prepare(`WITH RECURSIVE up(id, depth) AS (SELECT ?::bigint, 0 UNION SELECT r.to_id, u.depth + 1 FROM up u JOIN thing_relation r ON r.from_id = u.id
      WHERE r.rel = 'located_in' AND r.superseded_at IS NULL AND r.valid_to IS NULL AND u.depth < 20) SELECT id FROM up`).all(deviceId)).map((r) => Number(r.id));
  return await db.prepare(`SELECT * FROM control_limit WHERE device_id = ANY(?::bigint[]) AND superseded_at IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
    AND (action IS NULL OR action = ?) AND aggregate = 'each'`).all(`{${places.join(',')}}`, nowMs, nowMs, action);
}

// Who may set a limit, strongest first (fix list R17). A lower source can only tighten a higher one: the database refuses a
// bound looser than a current one of a higher source (trigger control_limit_ranked), and every current limit applies at once.
export const LIMIT_SOURCES = ['physical', 'legal', 'installer', 'owner', 'optimiser'];

// A limit on a command parameter for one device, from one source. It replaces only that source's current limit of the same
// parameter and action: an owner cannot replace (and so loosen) an installer's. basis: the evidence (adapter, vendor_doc,
// dno_approval, ...).
export async function setControlLimit(deviceId, { action = null, param, min = null, max = null, source = 'installer', basis = null, now = Date.now() }) {
  if (!LIMIT_SOURCES.includes(source)) throw new RangeError(`limit source ${source}: one of ${LIMIT_SOURCES.join(', ')}`);
  return await tx(async () => {
    await db.prepare('UPDATE control_limit SET superseded_at = ? WHERE device_id = ? AND param = ? AND action IS NOT DISTINCT FROM ? AND source = ? AND superseded_at IS NULL').run(now, deviceId, param, action, source);
    return Number((await db.prepare('INSERT INTO control_limit (device_id, action, param, min_value, max_value, source, basis, valid_from, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(deviceId, action, param, min, max, source, basis, now, now)).lastInsertRowid);
  });
}

// The bounds in force for one parameter of one action: the tightest of every current limit, each bound with the source that
// sets it. conflict: the bounds leave no value (a minimum above a maximum), so nothing may be sent.
export async function effectiveLimit(deviceId, action, param, nowMs = Date.now()) {
  const rows = (await limitsFor(deviceId, action, nowMs)).filter((l) => l.param === param);
  const out = { param, min: null, max: null, minSource: null, maxSource: null, conflict: false, limits: rows.length };
  for (const l of rows) {
    if (l.min_value != null && (out.min == null || l.min_value > out.min)) { out.min = l.min_value; out.minSource = l.source; }
    if (l.max_value != null && (out.max == null || l.max_value < out.max)) { out.max = l.max_value; out.maxSource = l.source; }
  }
  out.conflict = out.min != null && out.max != null && out.min > out.max;
  return out;
}

/**
 * The reasons a command may not be queued: [{ gate, detail }], empty = clear.
 *  placeholder_capability  the device's capability for the action is only a placeholder (never confirmed)
 *  stale_inputs            the plan it comes from ran on stale inputs, or (freshnessLimits given) the home's live inputs are
 *                          stale now, and the action is not a plain demand action
 *  limit                   a value outside the tightest current limit of all sources (control_limit, effectiveLimit),
 *                          or limits that leave no value at all (conflict)
 *  params                  a value outside the range the action itself allows (device_action.params_schema)
 *  unverifiable            a safety action for a device that cannot report or show what it did (verification effect or none, R23)
 */
export async function checkGates({ deviceId, desired, planRunId = null, now = Date.now(), freshnessLimits = null }) {
  const blocks = [];
  const dev = await db.prepare('SELECT id, kind, site_id FROM device WHERE id = ?').get(deviceId);
  const cap = await capabilityRow(deviceId, desired.action);
  if (cap?.source === 'placeholder') blocks.push({ gate: 'placeholder_capability', detail: { action: desired.action, note: 'the capability was stated without a source (placeholder); confirm it (adapter, vendor_doc, probe, installer or user) before a command can be sent' } });
  const act = await db.prepare('SELECT params_schema, side_effect_class FROM device_action WHERE device_kind = ? AND action = ?').get(dev.kind, desired.action);
  if (act?.side_effect_class === 'safety' && cap && cap.verification !== 'reported') blocks.push({ gate: 'unverifiable', detail: { action: desired.action, verification: cap.verification, note: 'a safety action is never sent to a device that cannot confirm it' } });
  if (act && act.side_effect_class !== 'none') {
    const run = planRunId == null ? null : await db.prepare('SELECT status, error FROM plan_run WHERE id = ?').get(planRunId);
    if (run?.status === 'stale_inputs') blocks.push({ gate: 'stale_inputs', detail: { planRunId, reason: run.error ?? 'the plan ran on stale inputs' } });
    else if (freshnessLimits) {
      const f = await freshness(dev.site_id, now, freshnessLimits === true ? {} : freshnessLimits);
      if (!f.ok) blocks.push({ gate: 'stale_inputs', detail: { reason: f.reason, stale: f.stale, missing: f.missing } });
    }
  }
  for (const param of new Set((await limitsFor(deviceId, desired.action, now)).map((l) => l.param))) {
    const v = desired[param];
    if (!num(v)) continue;
    const e = await effectiveLimit(deviceId, desired.action, param, now);
    if (e.conflict || (e.min != null && v < e.min) || (e.max != null && v > e.max)) {
      blocks.push({ gate: 'limit', detail: { param, value: v, min: e.min, max: e.max, source: e.max != null && v > e.max ? e.maxSource : e.minSource, ...(e.conflict ? { conflict: true } : {}) } });
    }
  }
  if (act) {
    let schema = {}; try { schema = JSON.parse(act.params_schema || '{}'); } catch { /* none */ }
    for (const [name, def] of Object.entries(schema)) {
      const key = desired[name] !== undefined ? name : ALIAS[name];
      const v = key ? desired[key] : undefined;
      if (!num(v)) continue;
      if ((def.min != null && v < def.min) || (def.max != null && v > def.max)) blocks.push({ gate: 'params', detail: { param: key, value: v, min: def.min ?? null, max: def.max ?? null } });
    }
  }
  return blocks;
}

export async function recordBlocks(deviceId, planRunId, action, blocks, now = Date.now()) {
  const ins = db.prepare('INSERT INTO command_block (device_id, plan_run_id, action, gate, detail, at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const b of blocks) await ins.run(deviceId, planRunId, action, b.gate, JSON.stringify(b.detail), now);
}

// ───────────── The device's own settings, as state points ─────────────

// Which state metric reports each key of a desired state (per action where the same key means two things).
export function stateMetricFor(key, action) {
  switch (key) {
    case 'action': return 'ctl_work_mode';
    case 'target_soc_pct': return 'ctl_charge_target_soc_pct';
    case 'reserve_pct': return 'ctl_reserve_pct';
    case 'limit_pct': return action === 'export' ? 'ctl_export_floor_pct' : 'ctl_charge_target_soc_pct';
    case 'rate_w': return action === 'export' || action === 'force_discharge' ? 'ctl_discharge_rate_w' : 'ctl_charge_rate_w';
    case 'charge_rate_w': return 'ctl_charge_rate_w';
    case 'discharge_rate_w': return 'ctl_discharge_rate_w';
    case 'setpoint_c': return 'ctl_setpoint_c';
    case 'window_start': return 'ctl_charge_window_start_min';
    case 'window_end': return 'ctl_charge_window_end_min';
    default: return null;
  }
}

// The standard point set of a controllable battery or inverter, as channels of one device. A vendor adapter would
// ship its own point names; the rest of the control path only sees the state metrics. modes: { code: action }.
export const STANDARD_POINTS = [
  ['work_mode', 'ctl_work_mode'], ['charge_target_soc', 'ctl_charge_target_soc_pct'], ['reserve', 'ctl_reserve_pct'], ['export_floor', 'ctl_export_floor_pct'],
  ['charge_window_start_min', 'ctl_charge_window_start_min'], ['charge_window_end_min', 'ctl_charge_window_end_min'],
  ['charge_rate_w', 'ctl_charge_rate_w'], ['discharge_rate_w', 'ctl_discharge_rate_w'], ['setpoint', 'ctl_setpoint_c'],
];
export const DEFAULT_MODES = { 0: 'demand', 1: 'charge', 2: 'export', 3: 'freeze_charge', 4: 'freeze_export', 5: 'hold' };
export async function ensureControlChannels(siteId, source, deviceId, { modes = DEFAULT_MODES } = {}) {
  const have = db.prepare('SELECT 1 FROM point_binding c JOIN source s ON s.id = c.source_id WHERE c.site_id = ? AND s.code = ? AND c.device_id = ? AND c.point = ? AND c.superseded_at IS NULL');
  let made = 0;
  for (const [point, metric] of STANDARD_POINTS) {
    if (await have.get(siteId, source, deviceId, point)) continue;
    await defineChannel(siteId, source, point, metric, { deviceId, access: 'readwrite', enumValues: metric === 'ctl_work_mode' ? modes : null, ...(metric.endsWith('_pct') ? { min: 0, max: 100 } : {}) });
    made++;
  }
  return made;
}

const latestState = db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id JOIN metric m ON m.id = s.metric_id
  WHERE s.subject_kind = 'device' AND s.subject_id = ? AND m.code = ? AND r.ts <= ? AND r.superseded_at IS NULL ORDER BY r.ts DESC LIMIT 1`);

/**
 * What the device itself says it runs, for the keys of a desired state, from its state facts at `atMs`.
 * Returns { reported, compared: [keys], unverifiable: [keys no state point reports], missing: [keys with no reading yet] }.
 * Window times come back as minute of day on the device; they are placed on the day of the desired window so the two compare.
 */
export async function readReported(deviceId, desired, atMs) {
  const dev = await db.prepare('SELECT d.id, s.timezone AS tz FROM device d JOIN site s ON s.id = d.site_id WHERE d.id = ?').get(deviceId);
  const at = Math.floor(atMs / 1000);
  const reported = {}; const compared = []; const unverifiable = []; const missing = [];
  for (const key of Object.keys(desired)) {
    const metric = stateMetricFor(key, desired.action);
    if (!metric) { unverifiable.push(key); continue; }
    const row = await latestState.get(String(deviceId), metric, at);
    compared.push(key);
    if (!row) { missing.push(key); continue; }
    if (key === 'action') {
      const ch = await db.prepare(`SELECT c.enum_values FROM point_binding c JOIN metric m ON m.id = c.metric_id WHERE c.device_id = ? AND m.code = ? AND c.superseded_at IS NULL ORDER BY c.id DESC LIMIT 1`).get(deviceId, metric);
      const words = ch?.enum_values ? JSON.parse(ch.enum_values) : null;
      reported.action = words ? words[String(row.value)] ?? `code ${row.value}` : row.value;
    } else if (key === 'window_start' || key === 'window_end') {
      const day = dayBounds(dev.tz, localDate(dev.tz, desired[key]))[0];
      reported[key] = todMinute(dev.tz, desired[key]) === row.value ? desired[key] : day + row.value * 60;
    } else reported[key] = row.value;
  }
  return { reported, compared, unverifiable, missing };
}

// ───────────── Effect check ─────────────

/**
 * Did the command's effect show in telemetry? The check is the action's effect_check (device_action): the mean of a
 * metric over [window start + afterS, + windowS] must reach min. Returns { status: 'verified' | 'not_verified' | 'wait' | 'none', evidence }.
 * 'wait': the period has not ended yet, or its telemetry has not arrived (it is given 10 minutes). 'none': the action has no check.
 */
export async function checkEffect(command, nowMs) {
  const dev = await db.prepare('SELECT d.kind, d.site_id FROM device d WHERE d.id = ?').get(command.device_id);
  const row = await db.prepare('SELECT effect_check FROM device_action WHERE device_kind = ? AND action = ?').get(dev.kind, command.action);
  if (!row?.effect_check || command.window_start == null) return { status: 'none', evidence: null };
  const chk = JSON.parse(row.effect_check);
  // Already there: a charge whose target the battery had reached before the window draws no power, and that is correct.
  // The evidence says so; there was nothing to verify (status stays verified, never a false not_verified).
  if (chk.already && nowMs >= command.window_start * 1000) {
    const target = chk.already.targetKeys.map((k) => command[k]).find((v) => v != null);
    if (target != null) {
      const before = (await series(dev.site_id, chk.already.metric, command.window_start - 900, command.window_start, { stepS: 300, asOf: nowMs })).values.filter((v) => v != null);
      const level = before.length ? before[before.length - 1] : null;
      if (level != null && level >= target) return { status: 'verified', evidence: { reason: 'already_at_target', metric: chk.already.metric, level, target } };
    }
  }
  const from = command.window_start + (chk.afterS ?? 0);
  const to = Math.min(from + (chk.windowS ?? 300), command.window_end ?? Infinity);
  if (nowMs < to * 1000) return { status: 'wait', evidence: { reason: 'the check period has not ended', until: to } };
  const s = await series(dev.site_id, chk.metric, from, to, { stepS: 300, asOf: nowMs });
  const vals = s.values.filter((v) => v != null);
  const evidence = { metric: chk.metric, min: chk.min, from, to, steps: vals.length };
  if (!vals.length) return nowMs < (to + 600) * 1000 ? { status: 'wait', evidence: { ...evidence, reason: 'no telemetry yet' } } : { status: 'not_verified', evidence: { ...evidence, reason: 'no telemetry for the period' } };
  const mean = vals.reduce((t, v) => t + v, 0) / vals.length;
  return { status: mean >= chk.min ? 'verified' : 'not_verified', evidence: { ...evidence, mean } };
}
