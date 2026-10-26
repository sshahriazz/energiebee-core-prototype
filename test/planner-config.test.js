// Planner configuration (deltas 020-022, B1 B2 B3 H5) in a new, empty database: the attribute,
// device kind and setting registries are seeded complete and unique; values are checked against
// them and carry a provenance label; every value is versioned and read "as known at" a moment; a
// new key or kind is one registry row; home and tariff settings keep their versions (H5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { ORIGINS } = await import('../src/core/provenance.js');
const { ATTRIBUTE_DEFS, DEVICE_KINDS, PREDHEAT_NOTE } = await import('../src/db/seed/attributes.js');
const { SETTING_DEFS } = await import('../src/db/seed/settings.js');
const { checkValue, parseDef, SHAPES } = await import('../src/core/value-check.js');
const attrs = await import('../src/core/attributes.js');
const settings = await import('../src/core/settings.js');
const { checkDeviceKind, deviceKinds } = await import('../src/core/devices.js');
const { siteAt, tariffAt, siteVersions, tariffVersions, tariffFlagsAt } = await import('../src/core/versions.js');
const { createSite, setSlotLength, setContractedCapacity } = await import('../src/core/sites.js');
const { createTariff, addDevice, agreeTariff } = await import('../src/core/tariffs.js');
const { loadPricing } = await import('../src/core/pricing.js');
const { withKnownAt } = await import('../src/core/facts.js');

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// A moment strictly between two writes (versions are in ms).
async function moment() { await sleepMs(3); const t = Date.now(); await sleepMs(3); return t; }
const home = createSite({ name: 'Config home', postcode: null });

// The keys the planning work asked for, by group (docs/hardening-and-planning-plan.md B1, B2).
const WANT_ATTRIBUTES = [
  'capacity_kwh', 'usable_kwh', 'reserve_pct', 'soc_min_pct', 'soc_max_pct', 'max_charge_kw', 'max_discharge_kw', 'charge_curve', 'discharge_curve',
  'efficiency_charge', 'efficiency_discharge', 'round_trip_efficiency', 'inverter_ac_limit_kw', 'inverter_dc_limit_kw', 'export_limit_kw', 'import_limit_kw',
  'grid_connection_standard', 'battery_chemistry', 'number_of_inverters', 'inverter_group_id', 'pause_supported', 'freeze_charge_supported',
  'freeze_export_supported', 'export_supported', 'charge_window_count_max', 'export_window_count_max', 'schedule_write_limit_per_day',
  'charge_from_grid_supported', 'battery_temperature_derate', 'battery_cycle_cost_per_kwh', 'battery_value_per_kwh', 'clock_offset_s',
  'pv_kwp_total', 'arrays', 'pv_scaling', 'degradation_pct',
  'max_kw', 'min_kw', 'connected_to_site', 'ready_by_time', 'target_soc_pct', 'power_kw', 'tank_litres', 'target_temp_c', 'holiday_calendar',
  'heat_loss_w_per_k', 'thermal_mass_kwh_per_k', 'floor_area_m2', 'volume_m3', 'insulation_class', 'setback_temp_c', 'comfort_min_c', 'comfort_max_c',
  'heating_system', 'emitter_type', 'flow_temp_design_c', 'boiler_efficiency', 'heat_pump_cop_curve', 'heat_pump_rated_kw', 'defrost_penalty',
  'min_run_minutes', 'min_off_minutes', 'hot_water_tank_litres', 'hot_water_target_c', 'zones',
  'latitude', 'longitude', 'altitude_m',
  'pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh',
];
const WANT_SETTINGS = [
  'best_soc_keep_kwh', 'best_soc_min_kwh', 'best_soc_max_kwh', 'metric_battery_cycle', 'metric_battery_value_scaling', 'pv_metric10_weight', 'pv_scaling',
  'load_scaling', 'load_scaling10', 'days_previous', 'days_previous_weight', 'forecast_hours', 'plan_interval_min', 'combine_charge_slots',
  'combine_export_slots', 'set_charge_window', 'set_export_window', 'set_soc_enable', 'set_reserve_enable', 'set_export_freeze', 'calculate_best_charge',
  'calculate_best_export', 'calculate_export_oncharge', 'rate_low_threshold', 'rate_high_threshold', 'rate_low_match_export', 'calculate_inday_adjustment',
  'car_charging_plan_smart', 'car_charging_hold', 'iboost_enable', 'iboost_max_energy', 'iboost_max_power', 'iboost_min_power', 'iboost_rate_threshold',
  'battery_loss', 'battery_loss_discharge', 'inverter_loss', 'inverter_hybrid', 'export_limit', 'charge_rate_override', 'set_read_only', 'mode',
  'saving_session_enable', 'saving_session_auto_join',
  'heating_target_c', 'heating_schedule', 'predheat_run_every_min', 'heat_pump_cycle_penalty', 'preheat_hours_max', 'comfort_penalty_per_degree_hour',
  'price_vs_comfort_weight', 'hot_water_schedule',
];
const WANT_KINDS = ['battery', 'inverter', 'meter_import', 'meter_export', 'meter_gas', 'ev', 'ev_charger', 'immersion', 'heat_pump', 'boiler',
  'thermostat', 'trv', 'temperature_sensor', 'hot_water_tank', 'smart_plug'];

const unique = (xs) => new Set(xs).size === xs.length;
const dbKeys = (table, col) => db.prepare(`SELECT ${col} AS k FROM ${table}`).all().map((r) => r.k);

test('registries: seeded complete and unique, every row consistent', () => {
  assert.ok(unique(ATTRIBUTE_DEFS.map((d) => d.key)), 'attribute keys unique');
  assert.ok(unique(SETTING_DEFS.map((d) => d.key)), 'setting keys unique');
  assert.ok(unique(DEVICE_KINDS.map((d) => d.kind)), 'device kinds unique');
  for (const k of WANT_ATTRIBUTES) assert.ok(attrs.attributeDef(k), `attribute ${k}`);
  for (const k of WANT_SETTINGS) assert.ok(settings.settingDef(k), `setting ${k}`);
  for (const k of WANT_KINDS) assert.ok(checkDeviceKind(k), `kind ${k}`);
  assert.deepEqual(new Set(dbKeys('attribute_def', 'key')), new Set(ATTRIBUTE_DEFS.map((d) => d.key)));
  assert.deepEqual(new Set(dbKeys('setting_def', 'key')), new Set(SETTING_DEFS.map((d) => d.key)));
  assert.deepEqual(new Set(dbKeys('device_kind', 'kind')), new Set(DEVICE_KINDS.map((d) => d.kind)));
  const kinds = new Set(DEVICE_KINDS.map((d) => d.kind));
  for (const d of attrs.attributeDefs()) {
    for (const t of d.applies_to) assert.ok(t === 'site' || t === 'device:*' || kinds.has(t.slice(7)), `${d.key} applies to ${t}`);
    for (const o of d.origins) assert.ok(ORIGINS.includes(o), `${d.key} origin ${o}`);
    if (d.alias_of) assert.ok(attrs.attributeDef(d.alias_of) && !attrs.attributeDef(d.alias_of).alias_of, `${d.key} alias`);
    if (d.json_shape) assert.ok(SHAPES[d.json_shape], `${d.key} shape ${d.json_shape}`);
    if (d.unverified && d.description.includes('PredHeat')) assert.ok(d.description.includes(PREDHEAT_NOTE) || d.refs.length === 0, d.key);
  }
  // Every default passes its own rules.
  for (const d of settings.settingDefs()) {
    assert.ok(['predbat', 'predheat'].includes(d.planner), d.key);
    if (d.json_shape) assert.ok(SHAPES[d.json_shape], `${d.key} shape`);
    assert.doesNotThrow(() => checkValue(d, d.default, `setting ${d.key}`), d.key);
  }
  // Each kind's attribute keys exist and apply to it.
  for (const k of deviceKinds()) for (const key of k.attribute_keys) {
    const d = attrs.attributeDef(key);
    assert.ok(d && (d.applies_to.includes(`device:${k.kind}`) || d.applies_to.includes('device:*')), `${k.kind}: ${key}`);
  }
});

test('registries: catalogue references exist in docs/predbat-predheat-requirements.md, and device_action matches the kinds', (t) => {
  const file = path.resolve(import.meta.dirname, '..', 'docs', 'predbat-predheat-requirements.md');
  const refs = [...ATTRIBUTE_DEFS, ...SETTING_DEFS].flatMap((d) => JSON.parse(d.refs));
  for (const r of refs) assert.match(r, /^(PB|PH)-[A-Z]+-\d+$/);
  if (fs.existsSync(file)) {
    const doc = fs.readFileSync(file, 'utf8');
    for (const r of new Set(refs)) assert.ok(doc.includes(`| ${r} |`), `${r} is in the catalogue`);
  } else t.diagnostic('catalogue not present: ids checked for form only');
  // The plan tables' action registry (delta 030), when present: every kind it names is registered and
  // reads its actions, and the seeded lists already hold them (so the merge in deviceKind is a safety net).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'device_action'").get()) {
    const seeded = new Map(DEVICE_KINDS.map((k) => [k.kind, JSON.parse(k.action_codes)]));
    for (const a of db.prepare('SELECT device_kind, action FROM device_action').all()) {
      assert.ok(checkDeviceKind(a.device_kind).action_codes.includes(a.action), `${a.device_kind} reads ${a.action}`);
      if (!seeded.get(a.device_kind)?.includes(a.action)) t.diagnostic(`seed list of ${a.device_kind} lacks ${a.action} (device_action adds it)`);
    }
  }
});

test('validation: unknown keys, wrong subjects and out-of-range values are refused with a clear error', () => {
  const S = home.id;
  assert.throws(() => attrs.setAttribute(S, 'no_such_key', 1, 'installer'), /unknown attribute no_such_key/);
  assert.throws(() => attrs.setAttribute(S, 'heat_loss_w_per_k', 5000, 'installer'), /heat_loss_w_per_k: must be at most 2000 W\/K/);
  assert.throws(() => attrs.setAttribute(S, 'heat_loss_w_per_k', 'abc', 'installer'), /must be a number/);
  assert.throws(() => attrs.setAttribute(S, 'heat_loss_w_per_k', 150, 'guess'), /unknown attribute source guess/);
  assert.throws(() => attrs.setAttribute(S, 'reserve_pct', 4, 'installer'), /reserve_pct does not apply to a home/);
  assert.throws(() => attrs.setAttribute(S, 'heating_system', 'nuclear', 'installer'), /must be one of gas_boiler/);
  assert.throws(() => attrs.setAttribute(S, 'number_of_inverters', 1.5, 'installer'), /whole number/);
  assert.throws(() => attrs.setAttribute(S, 'arrays', [{ kwp: 4, tilt: 120, azimuth: 180 }], 'installer'), /tilt must be 0-90/);
  assert.throws(() => attrs.setAttribute(S, 'weather_compensation', { 0: 45, 20: 30 }, 'installer'), /must include -20 and 20/);
  assert.throws(() => attrs.setAttribute(S, 'pv_kwp', -1, 'installer'), /pv_kwp: must be at least 0/);
  assert.throws(() => attrs.setAttribute(S, 'heat_loss_w_per_k', 150, 'installer', null, { origin: 'rumour' }), /origin must be one of/);
  assert.equal(attrs.setAttribute(S, 'heating_system', 'heat_pump_ashp', 'installer').value, 'heat_pump_ashp');
  assert.deepEqual(attrs.setAttribute(S, 'arrays', JSON.stringify([{ kwp: 4.2, tilt: 35, azimuth: 180 }, { kwp: 2, tilt: 30, azimuth: 270, shading: 0.1 }]), 'installer').value[1].azimuth, 270);
  // Devices: the key must apply to the device's kind.
  const batt = addDevice({ siteId: S, kind: 'battery', provider: 'test', externalRef: 'BATT-1' });
  const meter = addDevice({ siteId: S, kind: 'meter_import', provider: 'test', externalRef: 'MPAN-1' });
  assert.equal(attrs.setDeviceAttribute(batt.id, 'reserve_pct', '4', 'installer').value, 4);
  assert.equal(attrs.setDeviceAttribute(batt.id, 'pause_supported', 'true', 'provider').value, true);
  assert.throws(() => attrs.setDeviceAttribute(meter.id, 'reserve_pct', 4, 'installer'), /does not apply to a meter_import device/);
  assert.throws(() => attrs.setDeviceAttribute(batt.id, 'charge_curve', { 120: 1 }, 'installer'), /key "120" is not a number in 0..100/);
  assert.deepEqual(attrs.setDeviceAttribute(batt.id, 'charge_curve', { 0: 1, 90: 0.6, 100: 0.2 }, 'measured').value, { 0: 1, 90: 0.6, 100: 0.2 });
  // Settings.
  assert.throws(() => settings.setSetting(S, 'no_such_setting', 1, { origin: 'user' }), /unknown setting no_such_setting/);
  assert.throws(() => settings.setSetting(S, 'plan_interval_min', 7, { origin: 'user' }), /must be a multiple of 5/);
  assert.throws(() => settings.setSetting(S, 'mode', 'yolo', { origin: 'user' }), /must be one of monitor/);
  assert.throws(() => settings.setSetting(S, 'days_previous', [0], { origin: 'user' }), /whole number 1-28/);
  assert.throws(() => settings.setSetting(S, 'load_scaling', 1.1, {}), /origin must be one of/);
  assert.equal(settings.setSetting(S, 'plan_interval_min', 15, { origin: 'user' }).value, 15);
  assert.equal(settings.setSetting(S, 'set_read_only', 'true', { origin: 'user' }).value, true);
});

test('device kinds: an unknown kind is refused by the writer check and by the database; existing kinds stay valid', () => {
  assert.throws(() => checkDeviceKind('toaster'), /unknown device kind toaster/);
  assert.throws(() => addDevice({ siteId: home.id, kind: 'toaster', provider: 'test', externalRef: 'T-1' }), /unknown device kind/);
  const d = addDevice({ siteId: home.id, kind: 'meter_gas', provider: 'test', externalRef: 'MPRN-1' });
  assert.throws(() => db.prepare('UPDATE device SET kind = ? WHERE id = ?').run('toaster', d.id), /unknown device kind/);
  for (const k of ['meter_import', 'meter_export', 'meter_gas', 'ev', 'inverter', 'battery']) assert.equal(checkDeviceKind(k).kind, k);
  assert.equal(checkDeviceKind('heat_pump').class, 'controllable');
  assert.equal(checkDeviceKind('temperature_sensor').class, 'passive');
});

test('versioned reads: attributes and settings as known at several moments; unchanged values write nothing', async () => {
  const S = home.id;
  const t0 = await moment();
  attrs.setAttribute(S, 'heat_loss_w_per_k', 120, 'estimated');
  const t1 = await moment();
  attrs.setAttribute(S, 'heat_loss_w_per_k', 140, 'provider');
  const t2 = await moment();
  attrs.setAttribute(S, 'heat_loss_w_per_k', 150, 'installer', 'heat-loss survey');
  const t3 = await moment();
  attrs.withdrawAttribute(S, 'heat_loss_w_per_k', 'installer');
  const t4 = await moment();
  const at = (t) => attrs.attributeAt(S, 'heat_loss_w_per_k', t)?.value ?? null;
  assert.deepEqual([at(t0), at(t1), at(t2), at(t3), at(t4), at(null)], [null, 120, 140, 150, 140, 140]);
  const n = db.prepare('SELECT COUNT(*) n FROM attribute_value').get().n;
  attrs.setAttribute(S, 'heat_loss_w_per_k', 140, 'provider');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attribute_value').get().n, n, 'unchanged value: no new version');

  const s0 = await moment();
  settings.setSetting(S, 'load_scaling', 1.2, { origin: 'user' });
  const s1 = await moment();
  settings.setSetting(S, 'load_scaling', 1.3, { origin: 'derived', note: 'measured over 30 days' });
  const s2 = await moment();
  settings.clearSetting(S, 'load_scaling');
  const s3 = await moment();
  const v = (t) => settings.settingAt(S, 'load_scaling', t);
  assert.deepEqual([v(s0).value, v(s1).value, v(s2).value, v(s3).value], [1.05, 1.2, 1.3, 1.05]);
  assert.deepEqual([v(s0).isDefault, v(s1).isDefault, v(s3).isDefault], [true, false, true]);
  assert.equal(v(s0).origin, 'sourced', 'a catalogue-backed default');
  assert.equal(settings.settingAt(S, 'heat_pump_cycle_penalty').origin, 'placeholder', 'an unverified default');
  assert.equal(v(s2).origin, 'derived');
  const all = settings.settingsAt(S, s2);
  assert.equal(Object.keys(all).length, SETTING_DEFS.length);
  assert.equal(all.load_scaling.value, 1.3);
  assert.equal(settings.settingsAt(S, s2, { planner: 'predheat' }).load_scaling, undefined);
  assert.equal(settings.settingHistory(S, 'load_scaling').length, 2);
});

test('origin labels: every stored value carries one, from the writer or from its source', () => {
  const S = home.id;
  attrs.setAttribute(S, 'pv_kwp', 4.2, 'installer');
  assert.equal(attrs.attributeAt(S, 'pv_kwp').origin, 'user', 'installer -> user');
  assert.equal(attrs.attributeAt(S, 'pv_kwp_total').value, 4.2, 'the alias reads the same value');
  attrs.setAttribute(S, 'pv_kwp_total', 4.4, 'provider', 'plant record');
  assert.equal(db.prepare("SELECT origin FROM site_attribute WHERE site_id = ? AND attr = 'pv_kwp' AND source = 'provider' AND superseded_at IS NULL").get(S).origin, 'provider');
  attrs.setAttribute(S, 'altitude_m', 120, 'installer', 'Ordnance Survey', { origin: 'sourced' });
  assert.equal(attrs.attributeAt(S, 'altitude_m').origin, 'sourced');
  assert.equal(attrs.setAttribute(S, 'latitude', 53.8, 'installer').value, 53.8);
  assert.equal(db.prepare('SELECT lat FROM site WHERE id = ?').get(S).lat, 53.8, 'cached on site.lat');
  for (const t of ['attribute_value', 'site_setting']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE origin IS NULL`).get().n, 0, t);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM site_attribute WHERE origin IS NULL').get().n, 0);
  assert.ok(attrs.attributeHistory(S).every((h) => ORIGINS.includes(h.origin)));
  const all = attrs.attributesAt({ siteId: S });
  assert.equal(all.pv_kwp.value, 4.2, 'installer outranks provider');
  assert.equal(all.altitude_m.origin, 'sourced');
});

test('extension: one registry row adds a key, a tunable or a device kind, with no schema change', () => {
  const v = db.prepare('PRAGMA schema_version').get().schema_version;
  db.prepare(`INSERT INTO attribute_def (key, label, unit, value_type, min_value, max_value, applies_to, description)
    VALUES ('ceiling_height_m', 'Ceiling height', 'm', 'number', 1.8, 6, '["site"]', 'test row')`).run();
  assert.equal(attrs.setAttribute(home.id, 'ceiling_height_m', 2.4, 'installer').value, 2.4);
  assert.throws(() => attrs.setAttribute(home.id, 'ceiling_height_m', 9, 'installer'), /at most 6 m/);
  db.prepare(`INSERT INTO setting_def (key, label, value_type, default_value, allowed_values, planner, applies_to, description)
    VALUES ('night_quiet', 'Quiet at night', 'enum', '"off"', '["off","on"]', 'predbat', 'planner', 'test row')`).run();
  assert.equal(settings.settingAt(home.id, 'night_quiet').value, 'off');
  assert.equal(settings.setSetting(home.id, 'night_quiet', 'on', { origin: 'user' }).value, 'on');
  db.prepare(`INSERT INTO device_kind (kind, label, class, attribute_keys, action_codes) VALUES ('heat_battery', 'Heat battery', 'controllable', '["tank_litres"]', '["on","off"]')`).run();
  const hb = addDevice({ siteId: home.id, kind: 'heat_battery', provider: 'test', externalRef: 'HB-1' });
  assert.equal(attrs.setDeviceAttribute(hb.id, 'tank_litres', 200, 'installer').value, 200, 'granted by the kind row');
  assert.throws(() => attrs.setDeviceAttribute(hb.id, 'reserve_pct', 5, 'installer'), /does not apply to a heat_battery device/);
  assert.equal(db.prepare('PRAGMA schema_version').get().schema_version, v, 'no schema change');
});

test('H5: home settings keep their versions (created, slot length, capacity, zone) and siteAt reads them', async () => {
  const s = createSite({ name: 'Versioned home', market: 'FR' });
  const v0 = siteVersions(s.id);
  assert.equal(v0.length, 1);
  assert.equal(v0[0].recorded_at, s.created_at * 1000, 'first version at creation');
  const a = await moment();
  setSlotLength(s.id, 900);
  const b = await moment();
  setContractedCapacity(s.id, 6, { origin: 'user', note: 'bill' });
  const c = await moment();
  db.prepare("UPDATE site SET timezone = 'Europe/Brussels', lat = COALESCE(lat, 50.8) WHERE id = ?").run(s.id);   // a provider's zone rewrite
  const d = await moment();
  const n = siteVersions(s.id).length;
  db.prepare("UPDATE site SET timezone = 'Europe/Brussels', lat = COALESCE(lat, 50.8) WHERE id = ?").run(s.id);   // the same values again
  db.prepare("UPDATE site SET name = 'Renamed' WHERE id = ?").run(s.id);                                             // not a versioned column
  assert.equal(siteVersions(s.id).length, n, 'unchanged versioned values write nothing');
  const pick = (r) => [r.slot_s, r.contracted_kva, r.timezone, r.lat];
  assert.deepEqual(pick(siteAt(s.id, a)), [1800, null, 'Europe/Paris', null]);
  assert.deepEqual(pick(siteAt(s.id, b)), [900, null, 'Europe/Paris', null]);
  assert.deepEqual(pick(siteAt(s.id, c)), [900, 6, 'Europe/Paris', null]);
  assert.deepEqual(pick(siteAt(s.id, d)), [900, 6, 'Europe/Brussels', 50.8]);
  assert.equal(siteAt(s.id, d).name, 'Renamed', 'unversioned columns are today\'s');
  assert.equal(siteAt(s.id, a).approximateSettings, null);
  const early = siteAt(s.id, (s.created_at - 3600) * 1000);
  assert.equal(early.slot_s, 1800);
  assert.equal(early.approximateSettings, s.created_at * 1000, 'before the first version: the first, flagged');
  const vs = siteVersions(s.id);
  for (let i = 1; i < vs.length; i++) assert.equal(vs[i - 1].superseded_at, vs[i].recorded_at, 'versions chain without gaps');
  assert.equal(vs.filter((x) => x.superseded_at == null).length, 1);
});

test('H5: tariff pricing columns keep their versions, and pricing reads them as known at a moment', async () => {
  const s = createSite({ name: 'Tariff home', market: 'FR' });
  const t = createTariff({ provider: 'test', tariffCode: 'TEST-H5', country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', origin: 'user' });
  const dev = addDevice({ siteId: s.id, kind: 'meter_import', provider: 'test', externalRef: 'PDL-H5' });
  agreeTariff({ siteId: s.id, deviceId: dev.id, tariffId: t.id, validFrom: 1700000000, recordedAt: Date.now() - 60000 });
  assert.equal(tariffVersions(t.id).length, 1);
  const a = await moment();
  db.prepare('UPDATE tariff SET taxes_in_price = 1, kind = ? WHERE id = ?').run('tou', t.id);
  const b = await moment();
  db.prepare('UPDATE tariff SET name = ? WHERE id = ?').run('renamed', t.id);
  assert.equal(tariffVersions(t.id).length, 2, 'a name change is not a pricing change');
  assert.deepEqual([tariffAt(t.id, a).taxes_in_price, tariffAt(t.id, a).kind], [0, 'flat']);
  assert.deepEqual([tariffAt(t.id, b).taxes_in_price, tariffAt(t.id, b).kind], [1, 'tou']);
  assert.deepEqual(tariffFlagsAt(t.id, a).tariff_kind, 'flat');
  const flags = (ms) => withKnownAt(ms, () => loadPricing(s.id, 1700000000, 1700086400).agreements.map((x) => [x.taxes_in_price, x.tariff_kind]));
  assert.deepEqual(flags(a), [[0, 'flat']], 'as known before the change');
  assert.deepEqual(flags(b), [[1, 'tou']]);
  assert.deepEqual(loadPricing(s.id, 1700000000, 1700086400).agreements.map((x) => [x.taxes_in_price, x.tariff_kind]), [[1, 'tou']], 'today: the current row');
});

test('the registry rows parse: JSON columns become lists', () => {
  const d = parseDef(db.prepare("SELECT * FROM attribute_def WHERE key = 'reserve_pct'").get());
  assert.deepEqual(d.applies_to, ['device:battery', 'device:inverter']);
  assert.deepEqual(d.refs, ['PB-INV-38']);
  assert.deepEqual(settings.settingDef('days_previous').default, [7]);
});
