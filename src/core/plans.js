// Plans as data: the helpers around plan_run, plan_slot, device_action, device_capability,
// plan_input_ref and plan_score (src/db/deltas/030-plan.sql). TABLES ONLY, NO PLANNER YET: nothing
// in the core calls savePlan on its own, and the build engine never reads these tables.
//
// What a planner would hand savePlan (Predbat's slot record, made device-generic):
//   devices: [{ deviceId, role: 'controlled' | 'aggregate' | 'observed' }]
//   slots:   [{ deviceId, slotStart, action, params?, startOffsetMin?, chargeLimitPct?, exportLimitPct?,
//              targetSocKwh?, powerW?, powerFraction?, setpointC?, predicted?: { socEndKwh, importKwh,
//              exportKwh, pvKwh, loadKwh, costMinor, pv10Kwh, load10Kwh, extraLoadKwh, carKwh, iboostKwh,
//              carbonG, costRunningMinor, heatKwh, heatInputKwh, heatCostMinor, indoorTempCEnd,
//              setpointUsedC, heatingFrac, waterTempCEnd, outdoorTempC, ...extras }, reason?,
//              reasonCode?, reasonParams?, state?, decisionSource? }]
//   inputs:  [inputRef(...)] what it read, for replay
//   run:     settings, socStartKwh, socMaxKwh, reserveKwh, controlMode, recordEnd, metrics { base, best,
//            best10, base10, costPv50, costPv10 }, summary (totals, checkpoints), carryState, debugRawId
// A plan is SPARSE: a slot whose action is the kind's default (battery: demand; other kinds: auto)
// with no parameter, prediction or note is not stored. A plan is stored only when its DECISIONS
// changed (plan_hash; hashPredictions: true also counts the predictions). Predbat's sentinels
// (charge limit 0, export limit 100) are not stored on actions that do not take them.
import crypto from 'node:crypto';
import { db, tx } from '../db/db.js';
import { seriesId, putForecasts } from './facts.js';
import { slotPhase, slotFloor } from './time.js';

export const SCENARIOS = ['live', 'baseline', 'twin', 'what_if', 'shadow'];
export const ROLES = ['controlled', 'aggregate', 'observed'];
export const INPUT_KINDS = ['rates', 'pv', 'load', 'soc', 'settings', 'attributes', 'weather', 'other'];
export const STEP_S = 300;                 // the simulation step: everything is a multiple of 5 minutes
export const PLAN_RETENTION_DAYS = 7;      // after this, only the slots a run was in force for are kept

// Decision fields with a typed column (the rest of an action's parameters live in params JSON).
const DECISION = { startOffsetMin: 'start_offset_min', chargeLimitPct: 'charge_limit_pct', exportLimitPct: 'export_limit_pct', targetSocKwh: 'target_soc_kwh', powerW: 'power_w', powerFraction: 'power_fraction', setpointC: 'setpoint_c' };
// Predicted figures with a typed column (anything else goes to plan_slot.predicted JSON).
// Delta 032 added the pessimistic case, extra load, car, diverter, carbon and running cost (home
// level) and the heating figures PredHeat publishes (device level).
const PREDICTED = {
  socEndKwh: 'soc_end_kwh', importKwh: 'import_kwh', exportKwh: 'export_kwh', pvKwh: 'pv_kwh', loadKwh: 'load_kwh', costMinor: 'cost_minor',
  heatKwh: 'heat_kwh', indoorTempCEnd: 'indoor_temp_c_end', outdoorTempC: 'outdoor_temp_c',
  pv10Kwh: 'pv10_kwh', load10Kwh: 'load10_kwh', extraLoadKwh: 'extra_load_kwh', carKwh: 'car_kwh', iboostKwh: 'iboost_kwh', carbonG: 'carbon_g', costRunningMinor: 'cost_running_minor',
  heatInputKwh: 'heat_input_kwh', heatCostMinor: 'heat_cost_minor', setpointUsedC: 'setpoint_used_c', heatingFrac: 'heating_frac', waterTempCEnd: 'water_temp_c_end',
};
// How a slot was decided (not part of the plan hash): Predbat's status label, the decision's source and its reason template.
const META = { state: 'state', decisionSource: 'decision_source', reasonCode: 'reason_code' };
// Home-level predictions: at most one device row per slot may carry each (so v_plan_vs_actual is unambiguous).
const HOME_LEVEL = ['import_kwh', 'export_kwh', 'pv_kwh', 'load_kwh', 'cost_minor', 'pv10_kwh', 'load10_kwh', 'extra_load_kwh', 'car_kwh', 'iboost_kwh', 'carbon_g', 'cost_running_minor'];
// Predictions written as forecast_fact issues under source 'core_plan': column -> [subject kind, metric].
// A metric missing from the registry is skipped and reported, never invented.
export const PREDICTION_METRICS = {
  import_kwh: ['site', 'grid_import_kwh'], export_kwh: ['site', 'grid_export_kwh'], pv_kwh: ['site', 'solar_kwh'], load_kwh: ['site', 'load_kwh'],
  soc_end_kwh: ['device', 'battery_soc_kwh'], heat_kwh: ['device', 'heat_output_kwh'], indoor_temp_c_end: ['device', 'indoor_temp_c'],
  pv10_kwh: ['site', 'solar_kwh_p10'], car_kwh: ['site', 'ev_charge_kwh'],
};

// ───────────── Hashes ─────────────

// JSON with sorted keys and no undefined, so equal content always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashOf = (v) => sha256(canonical(v));

// ───────────── Time frame ─────────────

// Predbat's three reference points on the home's LOCAL slot grid (slots start at local midnight,
// so a 60-minute grid sits at :30 UTC in a UTC+9:30 zone): planStart = now rounded down to the
// slot, minuteOffset = minutes gone in slot 0, firstStep = the first simulation step.
export function planFrame(tz, nowS, slotS, horizonH = 48, stepS = STEP_S) {
  checkSlotLength(slotS);
  const planStart = slotFloor(nowS, slotS, slotPhase(tz, slotS, nowS));
  return { planStart, minuteOffset: Math.floor((nowS - planStart) / 60), firstStep: Math.floor((nowS - planStart) / stepS), slots: Math.ceil((horizonH * 3600) / slotS), stepsPerSlot: slotS / stepS };
}

// B8, plan side: any multiple of 5 minutes up to an hour (the ledger keeps 900, 1800 or 3600).
export function checkSlotLength(slotS) {
  if (!(Number.isInteger(slotS) && slotS >= 300 && slotS <= 3600 && slotS % 300 === 0)) throw new RangeError(`plan slot length must be a multiple of 300 s up to 3600, not ${slotS}`);
}

export const onLocalGrid = (tz, ts, slotS) => slotFloor(ts, slotS, slotPhase(tz, slotS, ts)) === ts;

// ───────────── Device actions and capabilities ─────────────

const actionRow = db.prepare('SELECT * FROM device_action WHERE device_kind = ? AND action = ?');
export function actionsFor(kind) {
  return db.prepare('SELECT * FROM device_action WHERE device_kind = ? ORDER BY is_default DESC, action').all(kind).map((a) => ({ ...a, params_schema: JSON.parse(a.params_schema) }));
}
export const defaultAction = (kind) => db.prepare('SELECT action FROM device_action WHERE device_kind = ? AND is_default = 1').get(kind)?.action ?? null;

// Record what one device can do. supported false = known not to (plans refuse it); true = known to
// (the only state a command accepts). source: adapter, vendor_doc, probe, installer, user, placeholder.
export function setCapability(deviceId, action, supported, { source = 'adapter', note = null, now = Date.now() } = {}) {
  db.prepare(`INSERT INTO device_capability (device_id, action, supported, source, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (device_id, action) DO UPDATE SET supported = excluded.supported, source = excluded.source, note = excluded.note, recorded_at = excluded.recorded_at`)
    .run(deviceId, action, supported ? 1 : 0, source, note, now);
}
// true (known yes), false (known no) or null (not known).
export function capability(deviceId, action) {
  const r = db.prepare('SELECT supported FROM device_capability WHERE device_id = ? AND action = ?').get(deviceId, action);
  return r ? r.supported === 1 : null;
}

// The values of an action's parameters, from the typed columns and params JSON, checked against
// device_action.params_schema. Returns the decision values (column or param name -> value).
export function checkParams(kind, action, schemaJson, slot) {
  const schema = typeof schemaJson === 'string' ? JSON.parse(schemaJson) : schemaJson;
  const values = {};
  for (const [js, col] of Object.entries(DECISION)) {
    const v = slot[js];
    if (v == null || (col === 'start_offset_min' && v === 0)) continue;
    values[col] = v;
  }
  for (const [k, v] of Object.entries(slot.params || {})) {
    if (Object.values(DECISION).includes(k)) throw new Error(`${kind} ${action}: ${k} is a typed column, not a params entry`);
    if (v != null) values[k] = v;
  }
  for (const [k, v] of Object.entries(values)) {
    const p = schema[k];
    if (!p) throw new Error(`${kind} ${action}: ${k} is not a parameter of this action (device_action.params_schema)`);
    if (p.type === 'number' || p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (p.type === 'integer' && !Number.isInteger(v))) throw new Error(`${kind} ${action}: ${k} must be a ${p.type}`);
      if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) throw new RangeError(`${kind} ${action}: ${k} = ${v} is outside ${p.min ?? '-inf'} to ${p.max ?? 'inf'} ${p.unit ?? ''}`.trim());
    } else if (p.type === 'string' && typeof v !== 'string') throw new Error(`${kind} ${action}: ${k} must be a string`);
    else if (p.type === 'boolean' && typeof v !== 'boolean') throw new Error(`${kind} ${action}: ${k} must be true or false`);
    if (p.enum && !p.enum.includes(v)) throw new Error(`${kind} ${action}: ${k} must be one of ${p.enum.join(', ')}`);
  }
  for (const [k, p] of Object.entries(schema)) if (p.required && values[k] == null) throw new Error(`${kind} ${action}: ${k} is required`);
  return values;
}

// ───────────── Saving a plan ─────────────

export function currentPlan(siteId, { scenario = 'live', variant = '' } = {}) {
  return db.prepare("SELECT * FROM plan_run WHERE site_id = ? AND scenario = ? AND variant = ? AND status IN ('ok', 'stale_inputs')").get(siteId, scenario, variant) ?? null;
}

// A reference to what a plan read, with the hash of the rows (re-read them as known at asOf and
// the hash is the same: plans.js verifyInput).
export function inputRef({ kind, refTable, refKey = '', rows, asOf, fromTs = null, toTs = null }) {
  if (!INPUT_KINDS.includes(kind)) throw new Error(`input kind must be one of ${INPUT_KINDS.join(', ')}`);
  return { kind, refTable, refKey: String(refKey), refHash: rows ? hashOf(rows) : null, asOf, fromTs, toTs, rowCount: rows ? rows.length : null };
}
export const verifyInput = (ref, rows) => ref.ref_hash === hashOf(rows);

/**
 * Save one plan run, only when its decisions changed. In one transaction: the current run of the
 * same (site, scenario, variant) is superseded and the new run, its device scope, its slots and its
 * input references are written. A run with the same plan_hash and status as the current one writes
 * nothing. status 'stale_inputs' (a demand-only fallback, with the stale input in `error`) and
 * 'error' (no slots) also supersede the current run, so an old plan never runs on.
 * predictionsTo: 'slot' (plan_slot columns), 'forecast' (forecast_fact issues under core_plan, and
 * plan_slot keeps only decisions) or 'both'.
 * @returns {{ written: boolean, reason?: string, runId: number, planHash: string, slots?: number, superseded?: number|null, forecasts?: number, skippedMetrics?: string[] }}
 */
export function savePlan(p) {
  const now = p.now ?? Date.now();
  const site = db.prepare('SELECT id, timezone, currency FROM site WHERE id = ?').get(p.siteId);
  if (!site) throw new Error(`no home ${p.siteId}`);
  const scenario = p.scenario ?? 'live';
  if (!SCENARIOS.includes(scenario)) throw new Error(`scenario must be one of ${SCENARIOS.join(', ')}`);
  const variant = p.variant ?? '';
  const slotS = Number(p.slotS);
  checkSlotLength(slotS);
  const horizonH = p.horizonH ?? 48;
  const stepS = p.stepS ?? STEP_S;
  const planStart = Number(p.planStart);
  if (!onLocalGrid(site.timezone, planStart, slotS)) throw new RangeError(`plan_start ${planStart} is not on the home's ${slotS} s slot grid (${site.timezone})`);
  const status = p.status ?? 'ok';
  if (!['ok', 'stale_inputs', 'error'].includes(status)) throw new Error('a new run is ok, stale_inputs or error');
  if (status !== 'ok' && !p.error) throw new Error(`a ${status} run needs its reason in error`);
  const predictionsTo = p.predictionsTo ?? 'slot';
  if (!['slot', 'forecast', 'both'].includes(predictionsTo)) throw new Error("predictionsTo must be 'slot', 'forecast' or 'both'");

  // Device scope: every device of the home named explicitly.
  const scope = new Map();
  for (const d of p.devices || []) {
    const role = d.role ?? 'controlled';
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    const dev = db.prepare('SELECT id, site_id, kind FROM device WHERE id = ?').get(d.deviceId);
    if (!dev || dev.site_id !== site.id) throw new Error(`device ${d.deviceId} is not a device of home ${site.id}`);
    scope.set(dev.id, { role, kind: dev.kind, default: defaultAction(dev.kind) });
  }
  const slots = p.slots || [];
  if (status === 'error' && slots.length) throw new Error('an error run has no slots');

  const rows = []; const decisions = []; const homeLevel = new Map(); const forecastRows = [];
  const horizonEnd = planStart + horizonH * 3600;
  for (const s of slots) {
    const dev = scope.get(s.deviceId);
    if (!dev) throw new Error(`device ${s.deviceId} is not in this run's device scope`);
    if (dev.role === 'observed') throw new Error(`device ${s.deviceId} is observed only: it gets no action`);
    const t = Number(s.slotStart);
    if (!(t >= planStart && t < horizonEnd && (t - planStart) % slotS === 0)) throw new RangeError(`slot ${t} is not on the run's ${slotS} s grid from ${planStart} within ${horizonH} h`);
    const a = actionRow.get(dev.kind, s.action);
    if (!a) throw new Error(`action ${s.action} is not defined for device kind ${dev.kind} (device_action)`);
    if (capability(s.deviceId, s.action) === false) throw new Error(`device ${s.deviceId} cannot deliver ${s.action} (device_capability)`);
    const values = checkParams(dev.kind, s.action, a.params_schema, s);
    if ((s.startOffsetMin ?? 0) % 5 !== 0 || (s.startOffsetMin ?? 0) * 60 >= slotS) throw new RangeError(`start_offset_min ${s.startOffsetMin} must be a multiple of 5 and less than the slot`);
    const pred = {}; const extra = {};
    for (const [k, v] of Object.entries(s.predicted || {})) {
      if (v == null) continue;
      if (PREDICTED[k]) pred[PREDICTED[k]] = v; else extra[k] = v;
    }
    for (const col of HOME_LEVEL) {
      if (pred[col] == null) continue;
      const key = `${t}|${col}`;
      if (homeLevel.has(key)) throw new Error(`slot ${t}: ${col} is a home figure and already carried by device ${homeLevel.get(key)}`);
      homeLevel.set(key, s.deviceId);
    }
    for (const [col, v] of Object.entries(pred)) if (PREDICTION_METRICS[col]) forecastRows.push({ col, deviceId: s.deviceId, start: t, value: v });
    const keepPred = predictionsTo !== 'forecast';
    const hasPred = keepPred && (Object.keys(pred).length > 0 || Object.keys(extra).length > 0);
    const isDefault = s.action === dev.default && Object.keys(values).length === 0;
    if (!isDefault) decisions.push([s.deviceId, t, s.action, values]);
    if (p.hashPredictions && hasPred) decisions.push([s.deviceId, t, 'predicted', { ...pred, ...extra }]);
    const meta = Object.fromEntries(Object.entries(META).map(([js, col]) => [col, s[js] ?? null]));
    const said = Object.values(meta).some((v) => v != null) || s.reason || s.reasonParams;
    if (isDefault && !hasPred && !said) continue;    // sparse: no row means the default action
    const params = Object.fromEntries(Object.entries(s.params || {}).filter(([, v]) => v != null));
    rows.push({
      device_id: s.deviceId, slot_start: t, action: s.action, params: Object.keys(params).length ? canonical(params) : null,
      start_offset_min: s.startOffsetMin ?? 0, charge_limit_pct: s.chargeLimitPct ?? null, export_limit_pct: s.exportLimitPct ?? null,
      target_soc_kwh: s.targetSocKwh ?? null, power_w: s.powerW ?? null, power_fraction: s.powerFraction ?? null, setpoint_c: s.setpointC ?? null,
      ...Object.fromEntries(Object.values(PREDICTED).map((c) => [c, keepPred ? pred[c] ?? null : null])),
      predicted: keepPred && Object.keys(extra).length ? canonical(extra) : null, reason: s.reason ?? null,
      ...meta, reason_params: s.reasonParams == null ? null : canonical(s.reasonParams),
    });
  }
  decisions.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const planHash = p.planHash ?? hashOf({ slotS, horizonH, stepS, devices: [...scope].map(([id, d]) => [id, d.role]).sort((x, y) => x[0] - y[0]), decisions });
  const inputs = (p.inputs || []).map((r) => ({ ...r, refKey: String(r.refKey ?? '') }));
  const inputsHash = p.inputsHash ?? (inputs.length ? hashOf(inputs.map((r) => [r.kind, r.refTable, r.refKey, r.refHash ?? null, r.asOf]).sort()) : null);

  return tx(() => {
    const cur = currentPlan(site.id, { scenario, variant });
    if (cur && status !== 'error' && cur.status === status && cur.plan_hash === planHash) return { written: false, reason: 'unchanged', runId: cur.id, planHash };
    if (cur) db.prepare("UPDATE plan_run SET status = 'superseded', superseded_at = ? WHERE id = ?").run(now, cur.id);
    const m = p.metrics || {};
    const json = (v) => (v == null ? null : canonical(v));
    const runId = Number(db.prepare(`INSERT INTO plan_run (site_id, scenario, variant, created_at, plan_start, slot_s, horizon_h, step_s, facts_as_of, method_version,
        plan_hash, settings_snapshot, inputs_hash, soc_start_kwh, currency, metric_base, metric_best, metric_best10, cost_pv50, cost_pv10, duration_ms, status, error, parent_run_id,
        record_end, soc_max_kwh, reserve_kwh, control_mode, metric_base10, summary, carry_state, debug_raw_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      site.id, scenario, variant, now, planStart, slotS, horizonH, stepS, p.factsAsOf ?? now, p.methodVersion,
      planHash, json(p.settings), inputsHash, p.socStartKwh ?? null, p.currency ?? site.currency ?? null,
      m.base ?? null, m.best ?? null, m.best10 ?? null, m.costPv50 ?? null, m.costPv10 ?? null, p.durationMs ?? null, status, p.error ?? null, p.parentRunId ?? null,
      p.recordEnd ?? null, p.socMaxKwh ?? null, p.reserveKwh ?? null, p.controlMode ?? null, m.base10 ?? null, json(p.summary), json(p.carryState), p.debugRawId ?? null,
    ).lastInsertRowid);
    const insDev = db.prepare('INSERT INTO plan_run_device (plan_run_id, device_id, role) VALUES (?, ?, ?)');
    for (const [id, d] of scope) insDev.run(runId, id, d.role);
    const cols = Object.keys(rows[0] || {});
    if (rows.length) {
      const ins = db.prepare(`INSERT INTO plan_slot (plan_run_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
      for (const r of rows) ins.run(runId, ...cols.map((c) => r[c]));
    }
    const insRef = db.prepare('INSERT INTO plan_input_ref (plan_run_id, kind, ref_table, ref_key, ref_hash, as_of, from_ts, to_ts, row_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of inputs) insRef.run(runId, r.kind, r.refTable, r.refKey, r.refHash ?? null, r.asOf, r.fromTs ?? null, r.toTs ?? null, r.rowCount ?? null);
    const out = { written: true, runId, planHash, slots: rows.length, superseded: cur?.id ?? null };
    if (predictionsTo !== 'slot') Object.assign(out, writePredictions(site.id, slotS, Math.floor(now / 1000), forecastRows));
    return out;
  });
}

// Plan predictions as forecast issues (source core_plan), so they can be scored like any forecast.
function writePredictions(siteId, slotS, issuedAt, items) {
  const known = new Set(db.prepare('SELECT code FROM metric').all().map((r) => r.code));
  const groups = new Map(); const skipped = new Set();
  for (const it of items) {
    const [subject, metric] = PREDICTION_METRICS[it.col];
    if (!known.has(metric)) { skipped.add(metric); continue; }
    const key = `${subject}|${subject === 'site' ? siteId : it.deviceId}|${metric}`;
    (groups.get(key) || groups.set(key, []).get(key)).push({ start: it.start, end: it.start + slotS, value: it.value });
  }
  let forecasts = 0;
  for (const [key, rows] of groups) {
    const [subject, id, metric] = key.split('|');
    forecasts += putForecasts(seriesId(subject, id, metric, 'core_plan'), issuedAt, rows);
  }
  return { forecasts, skippedMetrics: [...skipped] };
}

// A run's slots as stored (params and predicted parsed).
export function planSlots(runId) {
  return db.prepare('SELECT * FROM plan_slot WHERE plan_run_id = ? ORDER BY slot_start, device_id').all(runId)
    .map((r) => ({ ...r, params: r.params ? JSON.parse(r.params) : null, predicted: r.predicted ? JSON.parse(r.predicted) : null }));
}

// ───────────── Scoring ─────────────

const SCORED = ['import_kwh', 'export_kwh', 'pv_kwh', 'load_kwh', 'cost_minor', 'soc_end_pct'];

// Fill plan_score from v_plan_vs_actual for one run: every figure the plan predicted for a ledger
// slot that exists (final ledger slots only unless finalOnly is false). Run again after the ledger
// is rebuilt: a score is replaced, never duplicated. Returns the number of scores written.
export function scorePlan(runId, { finalOnly = true, now = Date.now() } = {}) {
  const rows = db.prepare(`SELECT * FROM v_plan_vs_actual WHERE plan_run_id = ? ${finalOnly ? "AND state = 'final'" : ''}`).all(runId);
  const ins = db.prepare(`INSERT OR REPLACE INTO plan_score (plan_run_id, slot_start, device_id, metric, predicted, actual, error, actual_source, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'site_hh', ?)`);
  let n = 0;
  tx(() => {
    for (const r of rows) {
      for (const m of SCORED) {
        const pred = r[`${m}_pred`];
        if (pred == null) continue;
        ins.run(runId, r.slot_start, r.device_id, m, pred, r[`${m}_actual`], r[`${m}_err`], now);
        n++;
      }
    }
  });
  return n;
}

// ───────────── Retention ─────────────

// A slot is IN FORCE when its run was the current plan for part of it (what ran; for a shadow or
// what-if run, what would have run): the slot ends after the run was made and starts before it
// was superseded. Kept forever. Every other slot of a run older than keepDays is deleted.
const IN_FORCE = `r.status <> 'error' AND (ps.slot_start + r.slot_s) * 1000 > r.created_at
  AND ps.slot_start * 1000 < IFNULL(r.superseded_at, 9000000000000000)`;

/**
 * Thin old plan slots: keep the in-force slots of every run forever, delete the other slots of
 * runs made more than keepDays ago. Runs, their device scope, input references and scores are
 * kept. dryRun (the default) only counts.
 * @returns {{ dryRun: boolean, cutoff: number, runs: number, slotsToDelete: number, slotsKept: number, deleted: number }}
 */
export function prunePlanSlots({ now = Date.now(), keepDays = PLAN_RETENTION_DAYS, dryRun = true, siteId = null } = {}) {
  const cutoff = now - keepDays * 86400000;
  const site = siteId == null ? '' : ` AND r.site_id = ${Math.floor(Number(siteId))}`;
  const old = `FROM plan_slot ps JOIN plan_run r ON r.id = ps.plan_run_id WHERE r.created_at < ?${site}`;
  const toDelete = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT ps.plan_run_id) AS runs ${old} AND NOT (${IN_FORCE})`).get(cutoff);
  const kept = db.prepare(`SELECT COUNT(*) AS n ${old} AND ${IN_FORCE}`).get(cutoff).n;
  const out = { dryRun, cutoff, runs: toDelete.runs, slotsToDelete: toDelete.n, slotsKept: kept, deleted: 0 };
  if (dryRun || !toDelete.n) return out;
  out.deleted = tx(() => Number(db.prepare(`DELETE FROM plan_slot AS ps WHERE EXISTS (
      SELECT 1 FROM plan_run r WHERE r.id = ps.plan_run_id AND r.created_at < ?${site} AND NOT (${IN_FORCE}))`).run(cutoff).changes));
  return out;
}
