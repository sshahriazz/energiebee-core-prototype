// Seed rows for the capability registry (plan 2.1, docs/thing-model.md section 4): what a kind of thing can do, the points it brings
// and the actions it allows. A thing type names its capabilities (thing_type.capabilities); a point of a thing is made from them.
// Like the thing types, the rows belong to the code: a missing row is inserted and a row that differs is brought back in line at
// start-up; a capability an operator added is left alone.
//
// A point entry: { key, class, access, metrics }. `metrics` says which canonical metric (the metric registry) the point is on each
// type that has the capability; a type missing from it has no standard point of that key yet. Keys are the names a person and the
// API use ('power', 'soc'); until an adapter or a type names them, a point's key is its metric's code.
import { isDeepStrictEqual } from 'node:util';

const pt = (key, cls, access, metrics) => Object.freeze({ key, class: cls, access, metrics: Object.freeze(metrics) });
const cap = (code, label, { points = [], actions = [], description = null } = {}) => Object.freeze({ code, label, points: Object.freeze(points), actions: Object.freeze(actions), description });

export const CAPABILITIES = Object.freeze([
  cap('power_meter', 'Power meter', { description: 'Reports the power passing through it.',
    points: [pt('power', 'measurement', 'read', { smart_plug: 'plug_w', ev_charger: 'ev_w', pv_array: 'solar_w', home_supply: 'load_w' })] }),
  cap('energy_meter', 'Energy meter', { description: 'Counts the energy passing through it.',
    points: [pt('energy_total', 'total', 'read', { smart_plug: 'plug_counter_kwh', ev_charger: 'ev_delivered_counter_kwh', heat_pump: 'heatpump_elec_counter_kwh', meter_heat: 'heat_output_counter_kwh', meter_import: 'grid_import_kwh', meter_export: 'grid_export_kwh', meter_gas: 'gas_kwh' })] }),
  cap('battery_storage', 'Battery storage', { description: 'Stores energy: a charge level, and a charge and discharge rate.',
    points: [pt('soc', 'measurement', 'read', { battery: 'battery_soc_pct', ev: 'ev_soc_pct' }),
      pt('charge_power', 'measurement', 'read', { battery: 'battery_charge_w' }), pt('discharge_power', 'measurement', 'read', { battery: 'battery_discharge_w' })],
    actions: ['charge', 'demand', 'export', 'force_discharge', 'freeze_charge', 'freeze_export', 'hold', 'release'] }),
  cap('pv_generation', 'PV generation', { description: 'Generates electricity from sunlight.',
    points: [pt('power', 'measurement', 'read', { pv_array: 'solar_w' }), pt('energy', 'total', 'read', { pv_array: 'solar_kwh' })] }),
  cap('grid_connection', 'Grid connection', { description: 'The point where the home meets the grid: what it imports and exports.',
    points: [pt('import_power', 'measurement', 'read', { grid_connection: 'grid_import_w' }), pt('export_power', 'measurement', 'read', { grid_connection: 'grid_export_w' })] }),
  cap('thermostat', 'Thermostat', { description: 'Measures a temperature and holds a target.',
    points: [pt('temperature', 'measurement', 'read', { thermostat: 'indoor_temp_c', trv: 'indoor_temp_c' }), pt('setpoint', 'setpoint', 'readwrite', { thermostat: 'indoor_temp_setpoint_c', trv: 'indoor_temp_setpoint_c' })],
    actions: ['set_target_temp', 'setback'] }),
  cap('heat_source', 'Heat source', { description: 'Puts heat into a heating circuit.',
    points: [pt('flow_temp', 'measurement', 'read', { heat_pump: 'heatpump_flow_temp_c', boiler: 'boiler_flow_temp_c' }), pt('return_temp', 'measurement', 'read', { heat_pump: 'heatpump_return_temp_c', boiler: 'boiler_return_temp_c' })],
    actions: ['heat_on', 'heat_off', 'heat_water', 'set_flow_temp', 'setback'] }),
  cap('valve', 'Valve', { description: 'Opens and closes a flow, such as a radiator valve.', points: [pt('position', 'measurement', 'read', { trv: 'valve_position_pct' })] }),
  cap('on_off', 'On and off', { description: 'Can be switched on and off.',
    points: [pt('state', 'state', 'readwrite', { smart_plug: 'plug_on', immersion: 'immersion_on', heat_pump: 'heating_on', boiler: 'heating_on' })], actions: ['on', 'off'] }),
  cap('ev_charging', 'EV charging', { description: 'Charges a car.',
    points: [pt('connected', 'state', 'read', { ev_charger: 'ev_connected' }), pt('power', 'measurement', 'read', { ev_charger: 'ev_w' })],
    actions: ['boost', 'pause', 'stop', 'set_current'] }),
  cap('temperature_sensor', 'Temperature sensor', { description: 'Reports a temperature.',
    points: [pt('temperature', 'measurement', 'read', { temperature_sensor: 'indoor_temp_c', thermostat: 'indoor_temp_c', trv: 'indoor_temp_c' })] }),
]);

const COLS = ['label', 'points', 'actions', 'description'];
// The registry rows that are missing or differ from the code (read only: an up-to-date database is opened without writing).
export async function capabilitySeedDiff(db) {
  const have = new Map((await db.prepare('SELECT code, label, points, actions, description FROM capability').all()).map((r) => [r.code, r]));
  return CAPABILITIES.filter((c) => { const r = have.get(c.code); return !r || COLS.some((k) => !isDeepStrictEqual(r[k] ?? null, c[k] ?? null)); });
}
export async function seedCapabilities(db, diff) {
  const up = db.prepare(`INSERT INTO capability (code, label, points, actions, description) VALUES (?, ?, ?::jsonb, ?::jsonb, ?)
    ON CONFLICT (code) DO UPDATE SET label = excluded.label, points = excluded.points, actions = excluded.actions, description = excluded.description`);
  for (const c of diff) await up.run(c.code, c.label, JSON.stringify(c.points), JSON.stringify(c.actions), c.description);
  return diff.length;
}
