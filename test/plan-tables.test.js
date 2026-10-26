// Plans as data (src/db/deltas/030-plan.sql, src/core/plans.js): tables only, no planner. A new,
// empty database with the three SYNTHETIC homes of scripts/lib/multi-market.js built by the real
// engine, so plans can be compared with a real ledger. No live data, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const plans = await import('../src/core/plans.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createSite } = await import('../src/core/sites.js');
const { seriesId, putReadings, readReadings, withKnownAt } = await import('../src/core/facts.js');
const { buildSite } = await import('../src/core/build.js');
const { dayBounds } = await import('../src/core/time.js');

const homes = m.buildScenario();
const gb = homes.gb.site.id;
const nl = homes.nl.site.id;
const dev = (siteId, kind, ref) => addDevice({ siteId, kind, provider: 'synthetic', externalRef: ref, label: `${kind} (synthetic)` }).id;
const battery = dev(gb, 'battery', 'SYN-GB-BATTERY');
const heatPump = dev(gb, 'heat_pump', 'SYN-GB-HEATPUMP');
const nlBattery = dev(nl, 'battery', 'SYN-NL-BATTERY');
const [day0] = dayBounds(m.GB.tz, m.GB.from);           // 2025-10-25 00:00 London (23:00 UTC the day before)
const H = 3600;
const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const base = (over = {}) => ({ siteId: gb, planStart: day0, slotS: 1800, horizonH: 24, methodVersion: 'test-v1', devices: [{ deviceId: battery }], ...over });
// A day of battery slots: demand everywhere (the default, not stored) except a charge window and one export.
function daySlots({ limit = 80, predicted = null } = {}) {
  const out = [];
  for (let k = 0; k < 48; k++) {
    const slotStart = day0 + k * 1800;
    const s = { deviceId: battery, slotStart, action: 'demand' };
    if (k >= 2 && k < 6) Object.assign(s, { action: 'charge', chargeLimitPct: limit, powerW: 2500, reason: 'low-rate window' });
    if (k === 40) Object.assign(s, { action: 'export', exportLimitPct: 30, startOffsetMin: 20 });
    if (predicted) s.predicted = predicted(k);
    out.push(s);
  }
  return out;
}

test('the registry: Predbat battery actions, heating, EV, immersion; one default per kind; side-effect classes', () => {
  const kinds = Object.fromEntries(db.prepare('SELECT device_kind, group_concat(action) AS a FROM (SELECT * FROM device_action ORDER BY action) GROUP BY device_kind').all().map((r) => [r.device_kind, r.a.split(',').sort()]));
  const batteryActions = ['charge', 'demand', 'export', 'force_discharge', 'freeze_charge', 'freeze_export', 'hold', 'pause', 'release'];
  assert.deepEqual(kinds.battery, batteryActions);
  assert.deepEqual(kinds.inverter, batteryActions);
  assert.deepEqual(kinds.ev_charger, ['auto', 'charge', 'set_current', 'stop']);
  assert.deepEqual([kinds.immersion, kinds.iboost], [['auto', 'off', 'on'], ['auto', 'off', 'on']]);
  for (const k of ['heat_pump', 'boiler']) assert.deepEqual(kinds[k], ['auto', 'boost', 'heat_off', 'heat_on', 'set_flow_temp', 'set_target_temp', 'setback']);
  assert.deepEqual([kinds.thermostat, kinds.trv, kinds.hot_water], [['auto', 'set_target_temp'], ['auto', 'set_target_temp'], ['auto', 'heat_water']]);
  const defaults = Object.fromEntries(db.prepare('SELECT device_kind, action FROM device_action WHERE is_default = 1').all().map((r) => [r.device_kind, r.action]));
  assert.deepEqual(defaults, { battery: 'demand', inverter: 'demand', ev_charger: 'auto', immersion: 'auto', iboost: 'auto', heat_pump: 'auto', boiler: 'auto', thermostat: 'auto', trv: 'auto', hot_water: 'auto' });
  assert.equal(plans.defaultAction('heat_pump'), 'auto', 'no row means no instruction: the device follows its own controls');
  assert.equal(plans.defaultAction('ev'), null, 'a kind with no actions at all');
  assert.ok(JSON.parse(db.prepare("SELECT params_schema FROM device_action WHERE device_kind = 'battery' AND action = 'export'").get().params_schema).power_fraction, 'Predbat reduced-power fraction (delta 032)');
  assert.equal(db.prepare("SELECT side_effect_class AS c FROM device_action WHERE device_kind = 'heat_pump' AND action = 'heat_off'").get().c, 'safety');
  assert.equal(db.prepare("SELECT side_effect_class AS c FROM device_action WHERE device_kind = 'battery' AND action = 'export'").get().c, 'grid_export');
  for (const a of db.prepare('SELECT params_schema FROM device_action').all()) assert.equal(typeof JSON.parse(a.params_schema), 'object');
  assert.throws(() => db.prepare("INSERT INTO device_action (device_kind, action, label, side_effect_class, is_default) VALUES ('battery', 'idle', 'Idle', 'none', 1)").run(), /UNIQUE/, 'a second default for a kind');
  assert.throws(() => db.prepare("INSERT INTO device_action (device_kind, action, label, side_effect_class) VALUES ('battery', 'x', 'X', 'dangerous')").run(), /CHECK/);
});

test('a sparse plan round trip: only the slots that say something are stored; decisions and predictions come back', () => {
  const res = plans.savePlan(base({ slots: daySlots(), settings: { best_soc_keep: 2 }, socStartKwh: 4.75, metrics: { base: 310, best: 250.5, best10: 270 }, now: day0 * 1000 }));
  assert.equal(res.written, true);
  assert.equal(res.slots, 5, '4 charge slots + 1 export; 43 demand slots are the default and not stored');
  const run = db.prepare('SELECT * FROM plan_run WHERE id = ?').get(res.runId);
  assert.deepEqual([run.status, run.scenario, run.variant, run.slot_s, run.horizon_h, run.step_s, run.currency, run.metric_best, run.soc_start_kwh], ['ok', 'live', '', 1800, 24, 300, 'GBP', 250.5, 4.75]);
  assert.deepEqual(JSON.parse(run.settings_snapshot), { best_soc_keep: 2 });
  const back = plans.planSlots(res.runId);
  assert.deepEqual(back.map((s) => [(s.slot_start - day0) / 1800, s.action, s.charge_limit_pct, s.export_limit_pct, s.start_offset_min, s.power_w]), [
    [2, 'charge', 80, null, 0, 2500], [3, 'charge', 80, null, 0, 2500], [4, 'charge', 80, null, 0, 2500], [5, 'charge', 80, null, 0, 2500], [40, 'export', null, 30, 20, null]]);
  assert.equal(back[0].reason, 'low-rate window');
  assert.deepEqual(db.prepare('SELECT device_id, role FROM plan_run_device WHERE plan_run_id = ?').all(res.runId).map((r) => [r.device_id, r.role]), [[battery, 'controlled']]);
  assert.equal(plans.currentPlan(gb).id, res.runId);
  // With predictions every slot says something, so every slot is stored; the plan hash is the same.
  const shadow = plans.savePlan(base({ scenario: 'shadow', slots: daySlots({ predicted: (k) => ({ importKwh: 0.2 + k / 100, socEndKwh: 5, costMinor: 3.1, flexKwh: 0.5 }) }), now: day0 * 1000 }));
  assert.equal(shadow.slots, 48);
  assert.equal(shadow.planHash, res.planHash, 'predictions are not part of the plan hash');
  const s7 = plans.planSlots(shadow.runId)[7];
  assert.deepEqual([s7.action, s7.import_kwh, s7.soc_end_kwh, s7.cost_minor, s7.predicted], ['demand', 0.27, 5, 3.1, { flexKwh: 0.5 }]);
  db.exec(`DELETE FROM plan_run WHERE id IN (${res.runId}, ${shadow.runId})`);
  assert.equal(count('SELECT COUNT(*) AS n FROM plan_slot WHERE plan_run_id IN (?, ?)', res.runId, shadow.runId), 0, 'slots cascade with their run');
});

test('savePlan writes nothing when the decisions are unchanged; a change supersedes; the database refuses an unchanged insert', () => {
  const v = 'unchanged-test';
  const a = plans.savePlan(base({ variant: v, slots: daySlots(), now: day0 * 1000 }));
  assert.equal(a.written, true);
  // Same decisions, new predictions, five minutes later and one slot later: nothing written.
  const same = plans.savePlan(base({ variant: v, slots: daySlots({ predicted: () => ({ importKwh: 1 }) }), now: day0 * 1000 + 300000 }));
  assert.deepEqual([same.written, same.reason, same.runId], [false, 'unchanged', a.runId]);
  const later = plans.savePlan(base({ variant: v, planStart: day0 + 1800, slots: daySlots().slice(1), now: day0 * 1000 + 1800000 }));
  assert.deepEqual([later.written, later.runId], [false, a.runId], 'plan_start is not in the hash: the same window from a later slot is the same plan');
  assert.equal(count('SELECT COUNT(*) AS n FROM plan_run WHERE variant = ?', v), 1);
  // A changed decision is a new run; the old one is superseded (kept).
  const b = plans.savePlan(base({ variant: v, slots: daySlots({ limit: 90 }), now: day0 * 1000 + 600000 }));
  assert.deepEqual([b.written, b.superseded], [true, a.runId]);
  const old = db.prepare('SELECT status, superseded_at FROM plan_run WHERE id = ?').get(a.runId);
  assert.deepEqual([old.status, old.superseded_at], ['superseded', day0 * 1000 + 600000]);
  // Changing back is a new run too (the uniqueness is against the CURRENT run, not every run).
  const c = plans.savePlan(base({ variant: v, slots: daySlots(), now: day0 * 1000 + 900000 }));
  assert.deepEqual([c.written, c.planHash], [true, a.planHash]);
  assert.equal(count("SELECT COUNT(*) AS n FROM v_current_plan WHERE site_id = ? AND variant = ?", gb, v), 1);
  // The database itself: the same hash and status as the current run, or a second current run, is refused.
  const insert = (status, hash) => db.prepare(`INSERT INTO plan_run (site_id, scenario, variant, created_at, plan_start, slot_s, facts_as_of, method_version, plan_hash, status, error)
    VALUES (?, 'live', ?, ?, ?, 1800, ?, 'raw', ?, ?, ?)`).run(gb, v, day0 * 1000 + 1e6, day0, day0 * 1000, hash, status, status === 'ok' ? null : 'x');
  assert.throws(() => insert('ok', c.planHash), /unchanged plan/);
  assert.throws(() => insert('ok', 'another-hash'), /UNIQUE/, 'one current run per site, scenario and variant');
  assert.throws(() => db.prepare('UPDATE plan_run SET plan_hash = ? WHERE id = ?').run('x', c.runId), /append-only/);
  assert.throws(() => db.prepare("UPDATE plan_run SET status = 'ok', superseded_at = NULL WHERE id = ?").run(a.runId), /only a current run/);
  // Stale inputs: the demand-only fallback supersedes the plan; an error run leaves no current plan.
  const stale = plans.savePlan(base({ variant: v, status: 'stale_inputs', error: 'rates older than 60 min', slots: [], now: day0 * 1000 + 1200000 }));
  assert.deepEqual([stale.written, stale.superseded, plans.currentPlan(gb, { variant: v }).status], [true, c.runId, 'stale_inputs']);
  assert.equal(plans.savePlan(base({ variant: v, status: 'stale_inputs', error: 'still stale', slots: [], now: day0 * 1000 + 1500000 })).written, false, 'the same fallback is not written again');
  const err = plans.savePlan(base({ variant: v, status: 'error', error: 'solver failed', devices: [], now: day0 * 1000 + 1800000 }));
  assert.equal(err.written, true);
  assert.equal(plans.currentPlan(gb, { variant: v }), null, 'after an error nothing old runs on');
  assert.throws(() => plans.savePlan(base({ variant: v, status: 'stale_inputs', slots: [] })), /needs its reason/);
});

test('an action the device kind does not have, bad parameters and a known-unsupported action are refused (helper and trigger)', () => {
  const run = plans.savePlan(base({ variant: 'refusals', slots: daySlots(), now: day0 * 1000 })).runId;
  const one = (s) => plans.savePlan(base({ variant: 'refusals-x', slots: [{ deviceId: battery, slotStart: day0, ...s }] }));
  assert.throws(() => one({ action: 'heat_on' }), /not defined for device kind battery/);
  assert.throws(() => one({ action: 'charge' }), /charge_limit_pct is required/);
  assert.throws(() => one({ action: 'charge', chargeLimitPct: 120 }), /outside 0 to 100/);
  assert.throws(() => one({ action: 'demand', setpointC: 21 }), /setpoint_c is not a parameter/);
  assert.throws(() => one({ action: 'pause', params: { what: 'sideways' } }), /must be one of charge, discharge, both/);
  assert.throws(() => one({ action: 'export', exportLimitPct: 10, startOffsetMin: 7 }), /multiple of 5/);
  const raw = (action, extra = '') => db.prepare(`INSERT INTO plan_slot (plan_run_id, device_id, slot_start, action${extra ? ', charge_limit_pct' : ''}) VALUES (?, ?, ?, ?${extra ? ', ?' : ''})`)
    .run(run, battery, day0 + 1800 * 30, action, ...(extra ? [extra] : []));
  assert.throws(() => raw('heat_on'), /action not defined in device_action/);
  assert.throws(() => raw('charge', 101), /CHECK/);
  // Known unsupported: the plan refuses it (a vendor without freeze export).
  plans.setCapability(battery, 'freeze_export', false, { source: 'vendor_doc', note: 'this inverter has no freeze-export mode' });
  assert.throws(() => one({ action: 'freeze_export' }), /cannot deliver freeze_export/);
  assert.throws(() => raw('freeze_export'), /cannot deliver this action/);
  assert.throws(() => plans.setCapability(battery, 'heat_on', true), /not defined in device_action/);
  db.prepare("DELETE FROM device_capability WHERE device_id = ? AND action = 'freeze_export'").run(battery);
  // A device the run does not plan, or plans as observed only.
  assert.throws(() => db.prepare('INSERT INTO plan_slot (plan_run_id, device_id, slot_start, action) VALUES (?, ?, ?, ?)').run(run, heatPump, day0, 'heat_on'), /not planned by this run/);
  assert.throws(() => plans.savePlan(base({ variant: 'refusals-y', devices: [{ deviceId: battery }, { deviceId: heatPump, role: 'observed' }], slots: [{ deviceId: heatPump, slotStart: day0, action: 'heat_on' }] })), /observed only/);
  assert.throws(() => plans.savePlan(base({ variant: 'refusals-z', devices: [{ deviceId: nlBattery }] })), /not a device of home/);
  assert.throws(() => db.prepare('UPDATE plan_slot SET charge_limit_pct = 10 WHERE plan_run_id = ?').run(run), /append-only/);
});

test('slot alignment: the run\'s own grid from plan_start (trigger), 5-minute plan grids allowed, the ledger keeps its CHECK', () => {
  const run = plans.savePlan(base({ variant: 'grid', slots: daySlots(), now: day0 * 1000 })).runId;
  const raw = (t, offset = 0) => db.prepare("INSERT INTO plan_slot (plan_run_id, device_id, slot_start, action, export_limit_pct, start_offset_min) VALUES (?, ?, ?, 'export', 20, ?)").run(run, battery, t, offset);
  assert.throws(() => raw(day0 + 900), /not on the run's slot grid/, 'a quarter-hour start in a half-hour plan');
  assert.throws(() => raw(day0 + 24 * H), /outside its horizon/);
  assert.throws(() => raw(day0 - 1800), /slot grid/);
  assert.throws(() => raw(day0 + 1801), /slot grid/, 'not even on the 5-minute grid (the trigger runs before the CHECK)');
  assert.throws(() => raw(day0 + 1800 * 20, 30), /start_offset_min must be less than the slot/);
  raw(day0 + 1800 * 20, 25);
  assert.throws(() => plans.savePlan(base({ variant: 'grid-x', planStart: day0 + 900 })), /not on the home's 1800 s slot grid/);
  assert.throws(() => plans.savePlan(base({ variant: 'grid-x', slots: [{ deviceId: battery, slotStart: day0 + 600, action: 'hold' }] })), /not on the run's 1800 s grid/);
  // B8: the plan grid is the plan's own. A 5-minute plan for a half-hour home, and a 10-minute one.
  for (const slotS of [300, 600]) {
    const r = plans.savePlan(base({ variant: `grid-${slotS}`, slotS, horizonH: 2, slots: [{ deviceId: battery, slotStart: day0 + slotS * 3, action: 'charge', chargeLimitPct: 50 }], now: day0 * 1000 }));
    assert.equal(r.written, true);
    assert.equal(db.prepare('SELECT slot_s FROM plan_run WHERE id = ?').get(r.runId).slot_s, slotS);
  }
  for (const bad of [200, 1000, 4500, 7200]) assert.throws(() => plans.savePlan(base({ variant: 'grid-bad', slotS: bad })), /multiple of 300 s up to 3600/);
  assert.throws(() => db.prepare(`INSERT INTO plan_run (site_id, created_at, plan_start, slot_s, facts_as_of, method_version, plan_hash, status) VALUES (?, 1, 0, 1000, 1, 'raw', 'h', 'ok')`).run(gb), /CHECK/);
  assert.throws(() => db.prepare("UPDATE site SET slot_s = 300 WHERE id = ?").run(gb), /CHECK/, 'the ledger grid keeps site.slot_s IN (900, 1800, 3600)');
  // The frame: plan_start on the home's local grid, Predbat's minute offset and first step.
  const f = plans.planFrame('Europe/London', Date.UTC(2026, 9, 23, 13, 37, 20) / 1000, 1800);
  assert.deepEqual([new Date(f.planStart * 1000).toISOString(), f.minuteOffset, f.firstStep, f.slots, f.stepsPerSlot], ['2026-10-23T13:30:00.000Z', 7, 1, 96, 6]);
  const ist = plans.planFrame('Asia/Kolkata', Date.UTC(2026, 9, 23, 13, 37, 20) / 1000, 3600);
  assert.equal(new Date(ist.planStart * 1000).toISOString(), '2026-10-23T13:30:00.000Z', 'hour slots from local midnight at UTC+5:30');
});

test('one run plans a heat pump and a battery together; home figures are carried by one device row per slot', () => {
  const devices = [{ deviceId: battery }, { deviceId: heatPump }];
  const slots = [
    { deviceId: battery, slotStart: day0 + 1800 * 2, action: 'charge', chargeLimitPct: 100, predicted: { importKwh: 1.4, socEndKwh: 6 } },
    { deviceId: heatPump, slotStart: day0 + 1800 * 2, action: 'set_target_temp', setpointC: 21.5, predicted: { heatKwh: 2.2, indoorTempCEnd: 20.8, outdoorTempC: 6 } },
    { deviceId: heatPump, slotStart: day0 + 1800 * 3, action: 'boost', params: { minutes: 30 }, setpointC: 22 },
    { deviceId: heatPump, slotStart: day0 + 1800 * 6, action: 'setback', setpointC: 17 },
  ];
  const r = plans.savePlan(base({ variant: 'heat', devices, slots, now: day0 * 1000 }));
  assert.equal(r.slots, 4);
  const back = plans.planSlots(r.runId);
  assert.deepEqual(back.map((s) => [s.device_id, (s.slot_start - day0) / 1800, s.action]), [[battery, 2, 'charge'], [heatPump, 2, 'set_target_temp'], [heatPump, 3, 'boost'], [heatPump, 6, 'setback']]);
  const hp = back[1];
  assert.deepEqual([hp.setpoint_c, hp.heat_kwh, hp.indoor_temp_c_end, hp.outdoor_temp_c, hp.import_kwh], [21.5, 2.2, 20.8, 6, null]);
  assert.deepEqual(back[2].params, { minutes: 30 });
  assert.throws(() => plans.savePlan(base({ variant: 'heat-x', devices, slots: [slots[0], { ...slots[1], predicted: { importKwh: 0.7 } }] })), /home figure and already carried by device/);
  assert.throws(() => plans.savePlan(base({ variant: 'heat-x', devices, slots: [{ deviceId: heatPump, slotStart: day0, action: 'set_target_temp', setpointC: 40 }] })), /outside 5 to 30 degC/);
});

test('extension by a registry row only: a new action for a new kind is planned and gated with no code change', () => {
  const ev = dev(gb, 'ev', 'SYN-GB-CAR');
  const slot = { deviceId: ev, slotStart: day0 + 1800 * 4, action: 'smart_charge', params: { ready_by_min: 450, target_soc_pct: 80 } };
  const save = () => plans.savePlan(base({ variant: 'ev', devices: [{ deviceId: ev }], slots: [slot], now: day0 * 1000 }));
  assert.throws(save, /not defined for device kind ev/);
  assert.throws(() => plans.setCapability(ev, 'smart_charge', true), /not defined/);
  db.prepare(`INSERT INTO device_action (device_kind, action, label, params_schema, description, side_effect_class) VALUES ('ev', 'smart_charge', 'Smart charge',
    '{"ready_by_min":{"type":"integer","unit":"min","min":0,"max":1439,"required":true},"target_soc_pct":{"type":"number","unit":"%","min":0,"max":100}}', 'Supplier smart charging to a ready-by time.', 'energy')`).run();
  const r = save();
  assert.equal(r.written, true);
  assert.deepEqual(plans.planSlots(r.runId)[0].params, { ready_by_min: 450, target_soc_pct: 80 });
  assert.throws(() => plans.savePlan(base({ variant: 'ev-2', devices: [{ deviceId: ev }], slots: [{ ...slot, params: { ready_by_min: 2000 } }] })), /ready_by_min = 2000/);
  plans.setCapability(ev, 'smart_charge', true, { source: 'adapter' });
  assert.equal(plans.capability(ev, 'smart_charge'), true);
});

test('v_plan_vs_actual: predictions against the built ledger, at the ledger grain and from a 5-minute plan; scorePlan fills plan_score', () => {
  const ledger = m.hhRows(gb, m.GB.from, m.GB.from).slice(0, 4);
  assert.equal(ledger.length, 4);
  assert.ok(ledger.every((r) => r.state === 'final' && r.grid_import != null && r.total_cost != null && r.soc_end != null));
  const cap = m.siteRow(gb).battery_kwh;
  const actualCost = (r) => r.total_cost - r.standing_cost - (r.gas_cost || 0);
  // Half-hour plan: import +0.1, export -0.05 (floored at 0), solar +0.2, use exact, cost +5, charge level +10 points.
  const slots = ledger.map((r) => ({ deviceId: battery, slotStart: r.slot_start, action: 'demand',
    predicted: { importKwh: r.grid_import + 0.1, exportKwh: r.grid_export + 0.05, pvKwh: r.solar + 0.2, loadKwh: r.home, costMinor: actualCost(r) + 5, socEndKwh: ((r.soc_end + 10) / 100) * cap } }));
  const run = plans.savePlan(base({ scenario: 'shadow', variant: 'score', slots, now: day0 * 1000 - 60000 }));
  const rows = db.prepare('SELECT * FROM v_plan_vs_actual WHERE plan_run_id = ? ORDER BY slot_start').all(run.runId);
  assert.equal(rows.length, 4);
  for (const v of rows) {
    assert.deepEqual([v.site_id, v.device_id, v.dur_s, v.plan_slot_s, v.plan_slots, v.state, v.in_force], [gb, battery, 1800, 1800, 1, 'final', 1]);
    near(v.import_kwh_err, 0.1, 'import'); near(v.export_kwh_err, 0.05, 'export'); near(v.pv_kwh_err, 0.2, 'solar');
    near(v.load_kwh_err, 0, 'use'); near(v.cost_minor_err, 5, 'cost'); near(v.soc_end_pct_err, 10, 'charge level');
  }
  // A 5-minute plan over the first two ledger slots: summed into each; a slot missing one 5-minute figure gets none.
  const fine = [];
  for (const [i, r] of ledger.slice(0, 2).entries()) {
    for (let j = 0; j < 6; j++) {
      if (i === 1 && j === 3) { fine.push({ deviceId: battery, slotStart: r.slot_start + j * 300, action: 'demand', predicted: { loadKwh: 0.1 } }); continue; }
      fine.push({ deviceId: battery, slotStart: r.slot_start + j * 300, action: 'demand', predicted: { importKwh: r.grid_import / 6 + 0.01, loadKwh: 0.1, socEndKwh: j === 5 ? (r.soc_end / 100) * cap : 1 } });
    }
  }
  const run5 = plans.savePlan(base({ scenario: 'shadow', variant: 'score-5min', slotS: 300, horizonH: 2, slots: fine, now: day0 * 1000 - 60000 }));
  const [a, b] = db.prepare('SELECT * FROM v_plan_vs_actual WHERE plan_run_id = ? ORDER BY slot_start').all(run5.runId);
  assert.deepEqual([a.plan_slots, a.plan_slot_s, a.dur_s], [6, 300, 1800]);
  near(a.import_kwh_err, 0.06, '6 x 0.01');
  near(a.soc_end_pct_err, 0, 'charge level from the last 5-minute slot');
  assert.equal(b.import_kwh_pred, null, 'one 5-minute import missing: no figure for that ledger slot');
  near(b.load_kwh_pred, 0.6, 'use present in all six');
  // A run made after the slots ran was never in force for them.
  const after = plans.savePlan(base({ scenario: 'what_if', variant: 'after', slots: slots.slice(0, 1) }));
  assert.equal(db.prepare('SELECT in_force FROM v_plan_vs_actual WHERE plan_run_id = ?').get(after.runId).in_force, 0);
  // plan_score: one row per figure, replaced (not duplicated) when scored again.
  assert.equal(plans.scorePlan(run.runId), 4 * 6);
  assert.equal(plans.scorePlan(run.runId), 4 * 6);
  assert.equal(count('SELECT COUNT(*) AS n FROM plan_score WHERE plan_run_id = ?', run.runId), 24);
  const s = db.prepare("SELECT * FROM plan_score WHERE plan_run_id = ? AND metric = 'cost_minor' ORDER BY slot_start LIMIT 1").get(run.runId);
  near(s.error, 5, 'scored cost error'); near(s.predicted - s.actual, s.error, 'error = predicted - actual');
  assert.equal(s.device_id, battery);
});

test('plan_input_ref: a plan records what it read, and the same read as known then gives the same hash after the facts change', async () => {
  const series = seriesId('site', gb, 'outdoor_temp_c', 'open_meteo');
  const from = day0; const to = day0 + 4 * H;
  putReadings(series, [0, 1, 2, 3].map((h) => ({ ts: from + h * H, value: 8 + h })));
  const asOf = Date.now();
  while (Date.now() <= asOf) await new Promise((r) => setTimeout(r, 1));
  const ref = withKnownAt(asOf, () => plans.inputRef({ kind: 'weather', refTable: 'reading', refKey: `series:${series}`, rows: readReadings([series], from, to).map((r) => [r.ts, r.value]), asOf, fromTs: from, toTs: to }));
  const run = plans.savePlan(base({ variant: 'inputs', slots: daySlots(), inputs: [ref], factsAsOf: asOf, now: asOf + 10 }));
  putReadings(series, [{ ts: from + H, value: 12.5 }]);   // a corrected value supersedes the one the plan used
  const stored = db.prepare('SELECT * FROM plan_input_ref WHERE plan_run_id = ?').get(run.runId);
  assert.deepEqual([stored.kind, stored.ref_table, stored.ref_key, stored.row_count, stored.as_of, stored.from_ts, stored.to_ts], ['weather', 'reading', `series:${series}`, 4, asOf, from, to]);
  const read = () => readReadings([series], from, to).map((r) => [r.ts, r.value]);
  assert.equal(plans.verifyInput(stored, withKnownAt(stored.as_of, read)), true, 'replayed as known at the plan: same inputs');
  assert.equal(plans.verifyInput(stored, read()), false, 'read now: the corrected value differs');
  const r = db.prepare('SELECT inputs_hash, facts_as_of FROM plan_run WHERE id = ?').get(run.runId);
  assert.deepEqual([r.facts_as_of, r.inputs_hash], [asOf, plans.hashOf([['weather', 'reading', `series:${series}`, ref.refHash, asOf]])]);
  assert.throws(() => db.prepare("INSERT INTO plan_input_ref (plan_run_id, kind, ref_table, as_of) VALUES (?, 'gossip', 'x', 1)").run(run.runId), /CHECK/);
});

test('predictions as forecast issues under source core_plan; the build never reads plans', () => {
  const before = m.fingerprint(buildSite(gb, m.GB.from, m.GB.to, { dryRun: true }).hhRows);
  const slots = [0, 1, 2].map((k) => ({ deviceId: battery, slotStart: day0 + k * 1800, action: 'demand', predicted: { importKwh: 0.3 + k, socEndKwh: 4 + k, pvKwh: 0.5 } }));
  slots.push({ deviceId: heatPump, slotStart: day0, action: 'heat_on', predicted: { heatKwh: 1.5, indoorTempCEnd: 20 } });
  const r = plans.savePlan(base({ variant: 'forecast', devices: [{ deviceId: battery }, { deviceId: heatPump }], slots, predictionsTo: 'forecast', now: day0 * 1000 }));
  assert.equal(r.slots, 1, 'only the heat_on decision is stored; the default slots carried only predictions');
  assert.equal(r.forecasts, 3 + 3 + 3 + 1 + 1);
  assert.deepEqual(r.skippedMetrics, []);
  const issued = db.prepare(`SELECT se.subject_kind AS k, m.code AS metric, COUNT(*) AS n, MIN(f.issued_at) AS iss FROM forecast_fact f JOIN series se ON se.id = f.series_id
    JOIN source so ON so.id = se.source_id JOIN metric m ON m.id = se.metric_id WHERE so.code = 'core_plan' GROUP BY 1, 2 ORDER BY 2`).all();
  assert.deepEqual(issued.map((x) => [x.k, x.metric, x.n]), [['device', 'battery_soc_kwh', 3], ['site', 'grid_import_kwh', 3], ['device', 'heat_output_kwh', 1], ['device', 'indoor_temp_c', 1], ['site', 'solar_kwh', 3]]);
  assert.ok(issued.every((x) => x.iss === day0));
  assert.equal(plans.planSlots(r.runId)[0].heat_kwh, null, 'predictionsTo forecast keeps decisions only in plan_slot');
  assert.equal(m.fingerprint(buildSite(gb, m.GB.from, m.GB.to, { dryRun: true }).hhRows), before, 'same timeline with plans and core_plan issues stored');
});

test('retention: slots a run was in force for are kept forever, the rest of runs older than 7 days are deleted (dry run first)', () => {
  const site = createSite({ name: 'Retention home', isDemo: true });
  const bat = dev(site.id, 'battery', 'SYN-RET-BATTERY');
  const now = Date.UTC(2026, 9, 26, 12) / 1000 * 1000;
  const [start] = dayBounds('Europe/London', '2026-10-15');      // eleven days before
  const slotsFrom = (t0) => Array.from({ length: 48 }, (_, k) => ({ deviceId: bat, slotStart: t0 + k * 1800, action: 'charge', chargeLimitPct: 50 + (t0 === start ? 0 : 1) }));
  const a = plans.savePlan({ siteId: site.id, planStart: start, slotS: 1800, horizonH: 24, methodVersion: 't', devices: [{ deviceId: bat }], slots: slotsFrom(start), now: start * 1000 });
  // Superseded 1 h 10 min later: in force for 00:00, 00:30 and 01:00 (it was current for part of 01:00).
  const b = plans.savePlan({ siteId: site.id, planStart: start + 3600, slotS: 1800, horizonH: 24, methodVersion: 't', devices: [{ deviceId: bat }], slots: slotsFrom(start + 3600), now: (start + 4200) * 1000 });
  const recent = plans.savePlan({ siteId: site.id, scenario: 'shadow', planStart: start, slotS: 1800, horizonH: 24, methodVersion: 't', devices: [{ deviceId: bat }], slots: slotsFrom(start), now: now - 3600000 });
  const dry = plans.prunePlanSlots({ now, siteId: site.id });
  const mine = (id) => count('SELECT COUNT(*) AS n FROM plan_slot WHERE plan_run_id = ?', id);
  assert.deepEqual([dry.dryRun, dry.slotsToDelete, dry.runs, dry.deleted, mine(a.runId)], [true, 45, 1, 0, 48], 'dry run: counts only');
  assert.ok(dry.slotsKept >= 3 + 48);
  const real = plans.prunePlanSlots({ now, siteId: site.id, dryRun: false });
  assert.equal(real.deleted, 45);
  assert.deepEqual(db.prepare('SELECT slot_start FROM plan_slot WHERE plan_run_id = ? ORDER BY slot_start').all(a.runId).map((r) => (r.slot_start - start) / 1800), [0, 1, 2]);
  assert.deepEqual([mine(b.runId), mine(recent.runId)], [48, 48], 'the current run and a recent run keep every slot');
  assert.equal(plans.prunePlanSlots({ now, siteId: site.id }).slotsToDelete, 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM plan_run WHERE site_id = ?', site.id), 3, 'runs are kept');
});

test('delta 032 (requirements catalogue): plan context and totals, slot labels and reasons, the pessimistic case, PredHeat outputs, windows and in-force slots', () => {
  const devices = [{ deviceId: battery }, { deviceId: heatPump }];
  const slots = [];
  for (let k = 0; k < 8; k++) {
    const t = day0 + k * 1800;
    const s = { deviceId: battery, slotStart: t, action: 'demand', predicted: { importKwh: 0.4, pv10Kwh: 0.1, load10Kwh: 0.6, extraLoadKwh: 0.05, carKwh: 0, carbonG: 80, costRunningMinor: 10 * (k + 1) } };
    if (k >= 1 && k < 4) Object.assign(s, { action: 'charge', chargeLimitPct: 90, powerFraction: 0.5, state: 'Charging', decisionSource: 'optimiser', reasonCode: 'charge_low_rate', reasonParams: { target_percent: 90, rate: 7.5 } });
    if (k === 6) Object.assign(s, { action: 'export', exportLimitPct: 40, startOffsetMin: 20, state: 'Exporting', reasonCode: 'export_high_rate' });
    slots.push(s);
    // PredHeat publishes predictions and issues no command: 'auto' rows carry them.
    slots.push({ deviceId: heatPump, slotStart: t, action: 'auto', predicted: { heatKwh: 2, heatInputKwh: 0.6, heatCostMinor: 15, indoorTempCEnd: 19.5 + k / 10, setpointUsedC: 20, heatingFrac: 0.75, waterTempCEnd: 38, outdoorTempC: 5 } });
  }
  const r = plans.savePlan(base({ variant: 'catalogue', devices, slots, now: day0 * 1000 - 60000, socStartKwh: 3, socMaxKwh: 9.5, reserveKwh: 0.4, controlMode: 'charge_export',
    recordEnd: day0 + 20 * H, metrics: { base: 300, best: 250, best10: 280, base10: 330 }, summary: { soc_min_kwh: 0.9, soc_h1_kwh: 3.5, clipped_kwh: 0, battery_cycle_kwh: 4.2 }, carryState: { water_temp_c: 37.5 } }));
  assert.equal(r.slots, 16, 'every slot carries predictions');
  const run = db.prepare('SELECT * FROM plan_run WHERE id = ?').get(r.runId);
  assert.deepEqual([run.soc_max_kwh, run.reserve_kwh, run.control_mode, run.record_end, run.metric_base10], [9.5, 0.4, 'charge_export', day0 + 20 * H, 330]);
  assert.deepEqual([JSON.parse(run.summary).soc_min_kwh, JSON.parse(run.carry_state).water_temp_c], [0.9, 37.5]);
  assert.throws(() => db.prepare("UPDATE plan_run SET summary = '{}' WHERE id = ?").run(r.runId), /append-only/);
  assert.throws(() => db.prepare("INSERT INTO plan_run (site_id, created_at, plan_start, slot_s, facts_as_of, method_version, plan_hash, status, control_mode) VALUES (?, 1, 0, 1800, 1, 'raw', 'h', 'what_if', 'party')").run(gb), /CHECK/);
  const back = plans.planSlots(r.runId);
  const c1 = back.find((s) => s.device_id === battery && s.slot_start === day0 + 1800);
  assert.deepEqual([c1.state, c1.decision_source, c1.reason_code, JSON.parse(c1.reason_params).target_percent, c1.power_fraction, c1.pv10_kwh, c1.load10_kwh, c1.carbon_g, c1.cost_running_minor],
    ['Charging', 'optimiser', 'charge_low_rate', 90, 0.5, 0.1, 0.6, 80, 20]);
  const h0 = back.find((s) => s.device_id === heatPump && s.slot_start === day0);
  assert.deepEqual([h0.action, h0.heat_kwh, h0.heat_input_kwh, h0.heat_cost_minor, h0.setpoint_used_c, h0.heating_frac, h0.water_temp_c_end, h0.import_kwh], ['auto', 2, 0.6, 15, 20, 0.75, 38, null]);
  assert.throws(() => plans.savePlan(base({ variant: 'catalogue-x', slots: [{ deviceId: battery, slotStart: day0, action: 'charge', chargeLimitPct: 50, powerFraction: 1.5 }] })), /power_fraction = 1.5/);
  // Windows: the three charge slots merge; the export window starts 20 minutes into its slot.
  const w = db.prepare('SELECT * FROM v_plan_window WHERE plan_run_id = ? ORDER BY window_start').all(r.runId);
  assert.deepEqual(w.map((x) => [x.device_id, x.action, x.slots, (x.window_start - day0) / 60, (x.window_end - day0) / 60]), [[battery, 'charge', 3, 30, 120], [battery, 'export', 1, 200, 210]]);
  // In force: made a minute before its first slot and still current, so all its slots.
  assert.equal(count('SELECT COUNT(*) AS n FROM v_plan_in_force WHERE plan_run_id = ?', r.runId), 16);
  // Without predictions the heat pump's auto rows are the default: not stored (sparse).
  const sparse = plans.savePlan(base({ variant: 'catalogue-sparse', devices, slots: slots.map(({ predicted, ...s }) => s), now: day0 * 1000 }));
  assert.equal(sparse.slots, 4, 'three charge slots and the export');
  // hashPredictions: a caller that wants refreshed predictions stored counts them in the hash.
  const p1 = plans.savePlan(base({ variant: 'catalogue-hash', slots: slots.filter((s) => s.deviceId === battery), hashPredictions: true, now: day0 * 1000 }));
  const p2 = plans.savePlan(base({ variant: 'catalogue-hash', hashPredictions: true, now: day0 * 1000 + 300000,
    slots: slots.filter((s) => s.deviceId === battery).map((s) => ({ ...s, predicted: { ...s.predicted, importKwh: 0.45 } })) }));
  assert.deepEqual([p1.written, p2.written, p2.superseded], [true, true, p1.runId]);
});
