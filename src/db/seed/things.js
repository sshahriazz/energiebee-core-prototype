// Seed rows for the thing registry (thing_type) and the relation rules (relation_rule): what kinds of things exist, where
// energy and heat enter and leave each type (ports), which attributes it may carry, and which relations may join which things
// (docs/thing-model.md sections 3.1 and 3.2). The rows are owned by the code, like the sources and metrics in registry.js: a
// missing row is inserted and a row that differs is brought back in line at start-up; a row the code does not list (an
// operator's own type or rule) is left alone. A type or rule removed from the code stays until a migration removes it.
//
// Types: the first set of thing-model 3.1, the device kinds of device_kind (every device row has a thing, and every device thing has a device row: the
// energy graph's own devices such as grid_connection and pv_array are device kinds too). `hot_water` is both a device
// kind and a system type of the model: a type name is unique, so it is the system; the device row becomes a system thing.
import { isDeepStrictEqual } from 'node:util';
import { ATTRIBUTE_DEFS, DEVICE_KINDS } from './attributes.js';

export const KINDS = ['home', 'space', 'device', 'system', 'context'];
export const MEDIA = ['ac', 'dc', 'heat', 'gas'];

// port(name, dir, medium): dir is in, out or both (a battery's dc port to its inverter takes and gives, so it is both).
const port = (name, dir, medium) => ({ name, dir, medium });

const attrKeysFor = (kind) => DEVICE_KINDS.find((d) => d.kind === kind) ? JSON.parse(DEVICE_KINDS.find((d) => d.kind === kind).attribute_keys) : [];
const siteKeys = ATTRIBUTE_DEFS.filter((d) => JSON.parse(d.applies_to).includes('site')).map((d) => d.key);

// Keys that are not in attribute_def (the catalogue of planner attributes): the home's own settings and plain descriptions.
const HOME_SETTINGS = ['timezone', 'slot_s', 'currency', 'country', 'market_code', 'postcode', 'gsp_region', 'carbon_region', 'contracted_kva', 'is_demo'];
const DESCRIBE = ['manufacturer', 'model', 'serial_number', 'firmware_version', 'external_controller'];   // external_controller: a service that runs the device (Octopus Intelligent Go for a car)
export const THING_ONLY_KEYS = Object.freeze([...HOME_SETTINGS, ...DESCRIBE, 'mpan', 'mprn', 'level', 'scheme', 'code', 'provider', 'tariff_code']);

// t(kind, type, label, { capabilities, ports, keys, std, description })
function t(kind, type, label, o = {}) {
  const base = kind === 'device' ? [...DESCRIBE, ...attrKeysFor(type)] : [];
  return Object.freeze({
    type, kind, label,
    capabilities: o.capabilities ?? [],
    ports: o.ports ?? [],
    attribute_keys: [...new Set([...base, ...(o.keys ?? [])])].sort(),
    std_ref: o.std ?? null,
    description: o.description ?? null,
  });
}

const SPACE_KEYS = ['floor_area_m2', 'volume_m3', 'insulation_class', 'heat_loss_w_per_k', 'thermal_mass_kwh_per_k', 'internal_gain_w', 'target_temp_c', 'comfort_min_c', 'comfort_max_c', 'setback_temp_c'];
const ELEC = { in: port('ac', 'in', 'ac'), both: port('ac', 'both', 'ac') };

export const THING_TYPES = Object.freeze([
  // home
  t('home', 'house', 'House', { keys: [...HOME_SETTINGS, ...siteKeys], std: 'brick:Building', description: 'A house; holds the home\'s settings as versioned attributes.' }),
  t('home', 'flat', 'Flat', { keys: [...HOME_SETTINGS, ...siteKeys], std: 'brick:Building', description: 'A flat; holds the home\'s settings as versioned attributes.' }),
  // space: spatial only, optional for home-wide devices
  t('space', 'floor', 'Floor', { keys: ['level', ...SPACE_KEYS], std: 'brick:Floor' }),
  t('space', 'room', 'Room', { keys: SPACE_KEYS, std: 'brick:Room' }),
  t('space', 'garage', 'Garage', { keys: SPACE_KEYS }),
  t('space', 'loft', 'Loft', { keys: SPACE_KEYS }),
  t('space', 'outdoor', 'Outdoor area', { keys: ['floor_area_m2'] }),
  t('space', 'outside_wall', 'Outside wall', { keys: [], description: 'Where the meters are mounted.' }),
  t('space', 'driveway', 'Driveway', { keys: [], description: 'Where the EV and its charger stand.' }),
  // device: a physical device; a replaced device is a new thing
  t('device', 'hub', 'Hub', { description: 'The local hub agent; devices are served_by it.' }),
  t('device', 'grid_connection', 'Grid connection', { capabilities: ['grid_connection'], ports: [port('meter', 'both', 'ac')], keys: ['export_limit_kw', 'import_limit_kw', 'grid_connection_standard'], description: 'The connection to the grid (export limit under G98 / G99).' }),
  t('device', 'meter_import', 'Import meter', { capabilities: ['energy_meter', 'power_meter'], ports: [port('grid', 'both', 'ac'), port('load', 'both', 'ac')], keys: ['mpan'] }),
  t('device', 'meter_export', 'Export meter', { capabilities: ['energy_meter', 'power_meter'], ports: [port('grid', 'both', 'ac'), port('load', 'both', 'ac')], keys: ['mpan'] }),
  t('device', 'meter_gas', 'Gas meter', { capabilities: ['energy_meter'], ports: [port('grid', 'in', 'gas'), port('load', 'out', 'gas')], keys: ['mprn'] }),
  t('device', 'meter_heat', 'Heat meter', { capabilities: ['energy_meter'], ports: [port('in', 'in', 'heat'), port('out', 'out', 'heat')] }),
  t('device', 'home_supply', 'Home supply', { capabilities: ['power_meter'], ports: [port('in', 'both', 'ac'), port('out', 'both', 'ac')], description: 'The consumer unit: where the home\'s loads hang.' }),
  t('device', 'inverter', 'Inverter', { capabilities: ['power_meter', 'energy_meter'], ports: [port('pv', 'in', 'dc'), port('battery', 'both', 'dc'), ELEC.both, port('grid', 'both', 'ac')] }),
  t('device', 'pv_array', 'PV array', { capabilities: ['pv_generation', 'power_meter'], ports: [port('dc', 'out', 'dc')], keys: ['pv_kwp', 'pv_tilt', 'pv_orientation', 'pv_scaling', 'degradation_pct', 'pv_calibration'], description: 'One array with its own angles and forecast.' }),
  t('device', 'battery', 'Battery', { capabilities: ['battery_storage'], ports: [port('charge', 'in', 'dc'), port('discharge', 'out', 'dc')], std: 'brick:Battery' }),
  t('device', 'heat_pump', 'Heat pump', { capabilities: ['heat_source', 'on_off', 'power_meter', 'energy_meter'], ports: [ELEC.in, port('flow', 'out', 'heat')] }),
  t('device', 'boiler', 'Boiler', { capabilities: ['heat_source', 'on_off'], ports: [port('gas', 'in', 'gas'), port('flow', 'out', 'heat')], std: 'brick:Boiler' }),
  t('device', 'emitter', 'Emitter', { ports: [port('flow', 'in', 'heat'), port('heat', 'out', 'heat')], keys: ['emitter_type', 'emitter_output_w_at_dt50'], description: 'A radiator or underfloor loop.' }),
  t('device', 'trv', 'Radiator valve', { capabilities: ['valve', 'thermostat', 'temperature_sensor'] }),
  t('device', 'thermostat', 'Thermostat', { capabilities: ['thermostat', 'temperature_sensor'], std: 'brick:Thermostat' }),
  t('device', 'temperature_sensor', 'Temperature sensor', { capabilities: ['temperature_sensor'], std: 'brick:Temperature_Sensor' }),
  t('device', 'ev_charger', 'EV charger', { capabilities: ['ev_charging', 'power_meter', 'energy_meter', 'on_off'], ports: [ELEC.in, port('ev', 'both', 'ac')] }),
  t('device', 'ev', 'Electric car', { capabilities: ['battery_storage'], ports: [port('charge', 'both', 'ac')] }),
  t('device', 'smart_plug', 'Smart plug', { capabilities: ['on_off', 'power_meter', 'energy_meter'], ports: [port('in', 'in', 'ac'), port('out', 'out', 'ac')] }),
  t('device', 'immersion', 'Immersion heater', { capabilities: ['on_off'], ports: [ELEC.in, port('heat', 'out', 'heat')] }),
  t('device', 'iboost', 'Solar diverter', { capabilities: ['on_off', 'power_meter'], ports: [ELEC.in, port('out', 'out', 'ac')] }),
  t('device', 'hot_water_tank', 'Hot-water tank', { ports: [port('heat', 'in', 'heat')] }),
  t('device', 'appliance', 'Appliance', { ports: [ELEC.in], description: 'A load behind a plug or a circuit (a dishwasher, a freezer).' }),
  t('device', 'generic_device', 'Unknown device', { description: 'What a hub announces when its type has no row yet: read only until a type row is added.' }),
  // system: things that work together; may cross rooms
  t('system', 'solar_battery', 'Solar and battery', { keys: ['pv_kwp', 'battery_kwh', 'export_limit_kw', 'import_limit_kw'] }),
  t('system', 'heating', 'Heating', { keys: ['heating_system', 'flow_temp_design_c', 'heat_loss_w_per_k', 'heat_loss_degrees', 'thermal_mass_kwh_per_k', 'weather_compensation', 'comfort_min_c', 'comfort_max_c', 'setback_temp_c'] }),
  t('system', 'hot_water', 'Hot water', { keys: ['hot_water_tank_litres', 'hot_water_target_c'] }),
  t('system', 'ev_charging', 'EV charging', { keys: ['ready_by_time', 'target_soc_pct', 'car_charging_exclusive'] }),
  t('system', 'heating_zone', 'Heating zone', { keys: ['target_temp_c', 'comfort_min_c', 'comfort_max_c', 'setback_temp_c'] }),
  // context: shared between homes, never deleted with a home
  t('context', 'region', 'Region', { keys: ['scheme', 'code'] }),
  t('context', 'weather_point', 'Weather point', { keys: ['latitude', 'longitude'] }),
  t('context', 'gas_zone', 'Gas zone', { keys: ['code'] }),
  t('context', 'tariff', 'Tariff', { keys: ['provider', 'tariff_code'] }),
  t('context', 'market', 'Market', { keys: ['code'] }),
]);

// rule(rel, from, to, flags): `from` and `to` are 'kind' or 'kind:type'.
const side = (s) => { const [kind, type = null] = s.split(':'); return { kind, type }; };
function rule(rel, from, to, o = {}) {
  const f = side(from); const g = side(to);
  return Object.freeze({
    rel, from_kind: f.kind, from_type: f.type, to_kind: g.kind, to_type: g.type,
    from_ports: o.ports?.[0] ?? 'none', to_ports: o.ports?.[1] ?? 'none',
    flow: o.flow ? 1 : 0, same_type: o.sameType ? 1 : 0, acyclic: o.acyclic ? 1 : 0, description: o.description ?? null,
  });
}
const METERS = ['meter_import', 'meter_export', 'meter_gas', 'meter_heat', 'smart_plug', 'ev_charger'];
const SUPPLY_METERS = ['meter_import', 'meter_export', 'meter_gas', 'meter_heat'];

export const RELATION_RULES = Object.freeze([
  // where a thing is: at most one current place per thing, no cycles
  rule('located_in', 'device', 'space', { acyclic: true, description: 'a device is in a room, a garage or outdoors' }),
  rule('located_in', 'device', 'home', { acyclic: true, description: 'a home-wide device sits at home level' }),
  rule('located_in', 'space', 'space', { acyclic: true, description: 'a room is on a floor' }),
  rule('located_in', 'space', 'home', { acyclic: true }),
  // what belongs to what
  rule('part_of', 'device', 'system', { acyclic: true, description: 'a device may be part of several systems' }),
  rule('part_of', 'system', 'system', { acyclic: true }),
  rule('part_of', 'device', 'device', { acyclic: true, description: 'a battery module is part of a battery' }),
  // energy and heat flow: directed per port
  rule('feeds', 'device', 'device', { ports: ['required', 'required'], flow: true, description: 'the energy graph: a flow network through ports, not a tree' }),
  rule('feeds', 'device', 'space', { ports: ['required', 'none'], flow: true, description: 'an emitter heats a room' }),
  // what is measured by what: each kWh counted once
  ...METERS.flatMap((m) => [
    rule('meters', `device:${m}`, 'device', { ports: ['optional', 'optional'] }),
    rule('meters', `device:${m}`, 'system'),
  ]),
  rule('controls', 'device', 'device'),
  rule('controls', 'device', 'system'),
  ...SUPPLY_METERS.map((m) => rule('supplied_on', `device:${m}`, 'context:tariff', { description: 'dated: replaces tariff_agreement' })),
  rule('replaces', 'device', 'device', { sameType: true, acyclic: true, description: 'a new device replaces an old one of the same type' }),
  rule('served_by', 'device', 'device:hub', { description: 'which hub a device talks through' }),
]);

// ───────────── seeding ─────────────
const TYPE_COLS = ['kind', 'label', 'capabilities', 'ports', 'attribute_keys', 'std_ref', 'description'];
const RULE_COLS = ['from_ports', 'to_ports', 'flow', 'same_type', 'acyclic', 'description'];
const ruleKey = (r) => [r.rel, r.from_kind, r.from_type ?? '', r.to_kind, r.to_type ?? ''].join('|');

// The registry rows that are missing or differ from the code (read only: an up-to-date database is opened without writing).
export async function thingSeedDiff(db) {
  const have = new Map((await db.prepare('SELECT type, kind, label, capabilities, ports, attribute_keys, std_ref, description FROM thing_type').all()).map((r) => [r.type, r]));
  const rules = new Map((await db.prepare('SELECT rel, from_kind, from_type, to_kind, to_type, from_ports, to_ports, flow, same_type, acyclic, description FROM relation_rule').all()).map((r) => [ruleKey(r), r]));
  return {
    types: THING_TYPES.filter((x) => { const r = have.get(x.type); return !r || TYPE_COLS.some((c) => !isDeepStrictEqual(r[c] ?? null, x[c] ?? null)); }),
    rules: RELATION_RULES.filter((x) => { const r = rules.get(ruleKey(x)); return !r || RULE_COLS.some((c) => (r[c] ?? null) !== (x[c] ?? null)); }),
  };
}

// Writes what thingSeedDiff found. Types first: a rule's types are foreign keys.
export async function seedThings(db, diff) {
  const upType = db.prepare(`INSERT INTO thing_type (type, kind, label, capabilities, ports, attribute_keys, std_ref, description) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?)
    ON CONFLICT (type) DO UPDATE SET kind = excluded.kind, label = excluded.label, capabilities = excluded.capabilities, ports = excluded.ports,
      attribute_keys = excluded.attribute_keys, std_ref = excluded.std_ref, description = excluded.description`);
  for (const x of diff.types) await upType.run(x.type, x.kind, x.label, JSON.stringify(x.capabilities), JSON.stringify(x.ports), JSON.stringify(x.attribute_keys), x.std_ref, x.description);
  const upRule = db.prepare(`INSERT INTO relation_rule (rel, from_kind, from_type, to_kind, to_type, from_ports, to_ports, flow, same_type, acyclic, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (rel, from_kind, (COALESCE(from_type, '')), to_kind, (COALESCE(to_type, ''))) DO UPDATE SET from_ports = excluded.from_ports, to_ports = excluded.to_ports,
      flow = excluded.flow, same_type = excluded.same_type, acyclic = excluded.acyclic, description = excluded.description`);
  for (const x of diff.rules) await upRule.run(x.rel, x.from_kind, x.from_type, x.to_kind, x.to_type, x.from_ports, x.to_ports, x.flow, x.same_type, x.acyclic, x.description);
  return diff.types.length + diff.rules.length;
}
