// Seed rows for the attribute registry (attribute_def, delta 020) and the device kind registry
// (device_kind, delta 020): what a home or a device may be described with, in which unit and range,
// so a planner (Predbat-style battery planning, PredHeat-style heating) finds every figure it needs
// under one standard name. Values are stored per source and versioned (src/core/attributes.js).
//
// These are the FIRST rows only: the database rows are what the writers check against, so a new key
// or kind is one more row (INSERT INTO attribute_def ...), never a migration or a code change.
// Seeding inserts only the rows that are missing; a row that exists is never changed.
//
// Cross-checked against the sourced catalogue docs/predbat-predheat-requirements.md (26 Oct 2026):
// `refs` lists the catalogue ids a key covers (PB-INV-.., PB-CAP-.., PH-MOD-.. ...), and the
// description names the Predbat or PredHeat setting. Units are ours: kW where Predbat uses W, °C
// as degC. A key with no catalogue source is our own design and says so; where the catalogue
// found docs and code disagreeing (section 1.4) the description keeps the conflict.
//
// Columns (attribute_def):
//   key, label, unit           minor/kWh = minor units of the home's currency per kWh (pence, cents);
//                              fraction = 0-1
//   value_type                 number | integer | boolean | string | enum | json  (src/core/value-check.js)
//   min_value, max_value, step inclusive bounds; step: a whole multiple of it
//   allowed_values             JSON list (enum)
//   json_shape                 a structure check in src/core/value-check.js SHAPES
//   applies_to                 JSON list of 'site' and/or 'device:<kind>' ('device:*' = any device)
//   origins                    JSON list: the provenance labels a value may carry (src/core/provenance.js)
//   storage                    site_attribute (the four details the build reads, cached on site) or
//                              attribute_value (every other key; site or device)
//   site_column                the site column the resolved value is cached on (pv_kwp, lat ...)
//   alias_of                   another key this one is written and read as (pv_kwp_total = pv_kwp)
//   unverified                 1 when the meaning is not backed by the catalogue (from memory)
//   description, refs
import { ORIGINS } from '../../core/provenance.js';

export const PREDHEAT_NOTE = 'unverified: from memory of PredHeat; check against its docs';
export const OWN_NOTE = 'not in the Predbat / PredHeat catalogue: our own design';
const ALL_ORIGINS = [...ORIGINS];

const BATT = ['device:battery'];
const INV = ['device:inverter'];
const BATT_INV = ['device:battery', 'device:inverter'];
const HEAT_DEVICES = ['device:heat_pump', 'device:boiler'];
const SITE_HEAT = ['site', ...HEAT_DEVICES];

// a(key, label, unit, type, { min, max, step, allowed, shape, appliesTo, refs, unverified, ... }, description)
function a(key, label, unit, value_type, o, description) {
  const note = o.unverified === 'predheat' ? PREDHEAT_NOTE : o.unverified ? OWN_NOTE : null;
  return Object.freeze({
    key, label, unit, value_type,
    min_value: o.min ?? null, max_value: o.max ?? null, step: o.step ?? null,
    allowed_values: o.allowed ? JSON.stringify(o.allowed) : null,
    json_shape: o.shape ?? null,
    applies_to: JSON.stringify(o.appliesTo ?? ['site']),
    origins: JSON.stringify(o.origins ?? ALL_ORIGINS),
    storage: o.storage ?? 'attribute_value',
    site_column: o.siteColumn ?? null,
    alias_of: o.aliasOf ?? null,
    unverified: note ? 1 : 0,
    description: note ? `${description} (${note})` : description,
    refs: JSON.stringify(o.refs ?? []),
  });
}
const LEGACY = { storage: 'site_attribute' };

export const ATTRIBUTE_DEFS = Object.freeze([
  // ── The four details the build engine reads today (site_attribute, cached on site) ──
  a('pv_kwp', 'PV peak power, all arrays', 'kWp', 'number', { ...LEGACY, min: 0, max: 1000, siteColumn: 'pv_kwp', refs: ['PB-PV-09'] }, 'Total DC peak power of every PV array of the home (Predbat pv_array_kwp).'),
  a('pv_tilt', 'PV tilt', 'degrees', 'number', { ...LEGACY, min: 0, max: 90, siteColumn: 'pv_tilt', refs: ['PB-PV-04', 'PB-PV-06'] }, 'Panel tilt from horizontal (Predbat declination), one array; several arrays: see arrays.'),
  a('pv_orientation', 'PV orientation', 'degrees', 'number', { ...LEGACY, min: 0, max: 360, siteColumn: 'pv_orientation', refs: ['PB-PV-04', 'PB-PV-06'] }, 'Compass bearing the panels face, 180 = south (Forecast.solar counts azimuth from north = 0 unless azimuth_zero_south), one array.'),
  a('battery_kwh', 'Battery capacity, all batteries', 'kWh', 'number', { ...LEGACY, min: 0, max: 1000, siteColumn: 'battery_kwh', refs: ['PB-INV-21'] }, 'Usable capacity of all the home\'s batteries together, used by the build for charge levels and losses (Predbat soc_max summed over inverters).'),

  // ── Inverter and battery (Predbat apps.yaml, per inverter) ──
  a('inverter_type', 'Inverter type', null, 'string', { appliesTo: INV, refs: ['PB-INV-02'] }, 'Predbat inverter_type code (GE, SK, SA, FoxESS, SolisCloud ...) or a custom code: decides the capability profile.'),
  a('number_of_inverters', 'Number of inverters', null, 'integer', { min: 1, max: 20, refs: ['PB-INV-01'] }, 'Inverters the planner controls together (Predbat num_inverters).'),
  a('capacity_kwh', 'Battery capacity (nominal)', 'kWh', 'number', { min: 0.1, max: 1000, appliesTo: BATT, refs: ['PB-INV-22'] }, 'Nameplate capacity of one battery (used instead of the usable figure when Predbat battery_capacity_nominal is on).'),
  a('usable_kwh', 'Battery usable capacity', 'kWh', 'number', { min: 0.1, max: 1000, appliesTo: BATT_INV, refs: ['PB-INV-21'] }, 'Energy that can be taken out, per inverter (Predbat soc_max; 0 there = learn it from history: leave unset).'),
  a('battery_scaling', 'Battery size scaling', 'factor', 'number', { min: 0.1, max: 2, appliesTo: BATT_INV, refs: ['PB-INV-23'] }, 'Factor applied to the stated capacity (Predbat battery_scaling, 1.0).'),
  a('depth_of_discharge', 'Depth of discharge', 'fraction', 'number', { min: 0.5, max: 1, appliesTo: BATT, refs: ['PB-INV-25'] }, 'Share of the capacity the battery allows to be used (Predbat givtcp_battery_dod).'),
  a('state_of_health_pct', 'State of health', '%', 'number', { min: 0, max: 110, appliesTo: BATT, refs: ['PB-INV-25'] }, 'Remaining capacity against new, as reported or measured (Predbat publishes battery_soh).'),
  a('battery_voltage_v', 'Nominal battery voltage', 'V', 'number', { min: 12, max: 1000, appliesTo: BATT_INV, refs: ['PB-INV-20'] }, 'Converts power to current for inverters controlled in amps (Predbat battery_voltage).'),
  a('reserve_pct', 'Reserve', '%', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-INV-38'] }, 'Lowest charge level kept for backup (Predbat set_reserve_min, default 4 %).'),
  a('reserve_max_pct', 'Highest reserve accepted', '%', 'number', { min: 0, max: 100, appliesTo: INV, refs: ['PB-INV-15'] }, 'Highest reserve the inverter accepts (Predbat inverter_reserve_max; template 98, docs give 100 and 98).'),
  a('soc_min_pct', 'Lowest charge target accepted', '%', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-INV-16'] }, 'Lowest target charge level the inverter accepts (Predbat battery_min_soc).'),
  a('soc_max_pct', 'Highest charge level', '%', 'number', { min: 0, max: 100, appliesTo: BATT, unverified: true }, 'Highest charge level a plan may charge this battery to (Predbat\'s nearest is the home setting best_soc_max, in kWh).'),
  a('max_charge_kw', 'Maximum charge rate', 'kW', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-INV-13', 'PB-INV-08'] }, 'Highest charging power: of the battery (Predbat battery_rate_max) or a cap set on the inverter (inverter_limit_charge).'),
  a('max_discharge_kw', 'Maximum discharge rate', 'kW', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-INV-13', 'PB-INV-09'] }, 'Highest discharging power: of the battery (battery_rate_max) or an inverter cap (inverter_limit_discharge).'),
  a('max_export_kw', 'Maximum forced-export rate', 'kW', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-INV-10'] }, 'Highest power when force-exporting (Predbat inverter_limit_export; defaults to the discharge cap).'),
  a('battery_rate_min_kw', 'Leak rate at zero', 'kW', 'number', { min: 0, max: 10, appliesTo: INV, refs: ['PB-INV-14'] }, 'Power the battery still moves when its rate is set to zero (Predbat inverter_battery_rate_min).'),
  a('charge_curve', 'Charge curve', 'fraction of max rate', 'json', { shape: 'soc_curve', appliesTo: BATT_INV, refs: ['PB-INV-32'] }, 'Charge rate accepted at each charge level as a fraction of the maximum (Predbat battery_charge_power_curve; its value auto = learn from history: leave unset).'),
  a('discharge_curve', 'Discharge curve', 'fraction of max rate', 'json', { shape: 'soc_curve', appliesTo: BATT_INV, refs: ['PB-INV-33'] }, 'Discharge rate at each charge level as a fraction of the maximum (Predbat battery_discharge_power_curve).'),
  a('charge_curve_default', 'Fallback charge curve', 'fraction of max rate', 'json', { shape: 'soc_curve', appliesTo: BATT_INV, refs: ['PB-INV-34'] }, 'Used when the charge curve cannot be learned (Predbat battery_charge_power_curve_default).'),
  a('discharge_curve_default', 'Fallback discharge curve', 'fraction of max rate', 'json', { shape: 'soc_curve', appliesTo: BATT_INV, refs: ['PB-INV-35'] }, 'Used when the discharge curve cannot be learned (Predbat battery_discharge_power_curve_default).'),
  a('battery_temperature_charge_curve', 'Charge rate by temperature', 'C-rate', 'json', { shape: 'crate_curve', appliesTo: BATT_INV, refs: ['PB-INV-36'] }, 'Highest charge C-rate at each battery temperature (Predbat battery_temperature_charge_curve).'),
  a('battery_temperature_discharge_curve', 'Discharge rate by temperature', 'C-rate', 'json', { shape: 'crate_curve', appliesTo: BATT_INV, refs: ['PB-INV-37'] }, 'Highest discharge C-rate at each battery temperature (Predbat battery_temperature_discharge_curve).'),
  a('battery_temperature_derate', 'Temperature derating', 'fraction of max rate', 'json', { shape: 'temp_curve', appliesTo: BATT, unverified: true }, 'One factor per temperature for both directions; Predbat states two C-rate curves instead (battery_temperature_charge_curve, battery_temperature_discharge_curve).'),
  a('efficiency_charge', 'Charging efficiency', 'fraction', 'number', { min: 0.5, max: 1, appliesTo: BATT_INV, refs: ['PB-INV-26'] }, 'Share of the energy put in that is stored: 1 - Predbat battery_loss (a home setting there, 0.03).'),
  a('efficiency_discharge', 'Discharging efficiency', 'fraction', 'number', { min: 0.5, max: 1, appliesTo: BATT_INV, refs: ['PB-INV-27'] }, 'Share of the stored energy that comes out: 1 - Predbat battery_loss_discharge (0.03).'),
  a('round_trip_efficiency', 'Round-trip efficiency', 'fraction', 'number', { min: 0.5, max: 1, appliesTo: BATT_INV, unverified: true }, 'Energy out over energy in for a full cycle; the build measures it from the inverter counters (site_day.battery_eff).'),
  a('battery_chemistry', 'Battery chemistry', null, 'enum', { allowed: ['lfp', 'nmc', 'lead_acid', 'other'], appliesTo: BATT, unverified: true }, 'Cell chemistry: the usual limits and wear.'),
  a('battery_cycle_cost_per_kwh', 'Battery wear cost', 'minor/kWh', 'number', { min: 0, max: 100, appliesTo: BATT, refs: ['PB-OTH-24'] }, 'Wear cost per kWh cycled through this battery (Predbat has one home figure, metric_battery_cycle, default 0).'),
  a('battery_value_per_kwh', 'Value of stored energy', 'minor/kWh', 'number', { min: 0, max: 200, appliesTo: BATT, unverified: true }, 'What a kWh left in this battery at the end of a plan is worth (Predbat derives it from rates and metric_battery_value_scaling).'),
  a('inverter_ac_limit_kw', 'Inverter AC limit', 'kW', 'number', { min: 0, max: 100, appliesTo: INV, refs: ['PB-INV-05'] }, 'Highest AC power the inverter delivers or takes (Predbat inverter_limit, in W there).'),
  a('inverter_dc_limit_kw', 'Inverter DC limit', 'kW', 'number', { min: 0, max: 100, appliesTo: INV, unverified: true }, 'Highest DC power from panels and battery the inverter can handle (clipping above it); see dc_charge_limit_kw for Predbat\'s DC charge ceiling.'),
  a('dc_charge_limit_kw', 'DC solar charge ceiling', 'kW', 'number', { min: 0, max: 100, appliesTo: INV, refs: ['PB-INV-11'] }, 'Highest solar power a hybrid inverter puts into the battery on the DC side (Predbat inverter_limit_charge_dc).'),
  a('pv_ac_limit_kw', 'PV AC output limit', 'kW', 'number', { min: 0, max: 100, appliesTo: INV, refs: ['PB-INV-06'] }, 'AC output limit of an AC-coupled PV inverter (Predbat pv_ac_limit).'),
  a('export_limit_kw', 'Export limit', 'kW', 'number', { min: 0, max: 100, appliesTo: ['site', 'device:inverter'], refs: ['PB-INV-07'] }, 'Highest power the home or inverter may send to the grid, as approved (G98/G99; Predbat export_limit, per inverter, in W).'),
  a('import_limit_kw', 'Import limit', 'kW', 'number', { min: 0, max: 100, appliesTo: ['site', 'device:inverter'], unverified: true }, 'Highest power the home may draw from the grid (main fuse, or a limit set on the inverter).'),
  a('grid_connection_standard', 'Grid connection standard', null, 'enum', { allowed: ['G98', 'G99', 'G100', 'other'], refs: ['PB-INV-07'] }, 'The connection rule the generation was approved under (GB: G98 small, G99 larger, G100 export limitation); other for anything else.'),
  a('inverter_group_id', 'Inverter group', null, 'string', { appliesTo: INV, unverified: true }, 'Inverters with the same group id are controlled as one (a master and its followers).'),
  a('import_export_scaling', 'Import and export data scaling', 'factor', 'number', { min: 0.1, max: 10, refs: ['PB-INV-41'] }, 'Correction factor for the home\'s import and export data (Predbat import_export_scaling, 1.0).'),
  // Capability profile (Predbat INVERTER_DEF / the inverter: block): what the device can be told to do.
  a('target_soc_supported', 'Stops at a target charge level', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-10'] }, 'The inverter stops charging at the target itself (Predbat has_target_soc).'),
  a('reserve_supported', 'Has a reserve setting', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-12'] }, 'The inverter has a reserve register (Predbat has_reserve_soc).'),
  a('pause_supported', 'Can pause charge or discharge', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-13'] }, 'Pause mode with a start and end (Predbat has_timed_pause).'),
  a('freeze_charge_supported', 'Can hold the charge level', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-15'] }, 'Can hold the charge level while the house runs from the grid (Predbat support_charge_freeze).'),
  a('freeze_export_supported', 'Can block charging (freeze export)', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-16'] }, 'Can stop the battery charging so solar is exported (Predbat support_discharge_freeze).'),
  a('feedin_first_supported', 'Has a real feed-in-first mode', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-17'] }, 'Freeze export is a feed-in-first mode: solar above the export limit still charges the battery (Predbat support_feedin_first).'),
  a('export_supported', 'Can force export', null, 'boolean', { appliesTo: BATT_INV, unverified: true }, 'Can discharge the battery to the grid on command.'),
  a('charge_during_export_supported', 'Charges from solar while exporting', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-INV-17'] }, 'The battery can still charge from PV during a forced export (Predbat inverter_can_charge_during_export, true).'),
  a('freeze_export_leak_kw', 'Leak during freeze export', 'kW', 'number', { min: 0, max: 10, appliesTo: BATT_INV, refs: ['PB-INV-18'] }, 'Battery discharge that still happens in freeze export (Predbat inverter_freeze_export_discharge_rate; 0 = none).'),
  a('window_span_midnight_supported', 'Windows may cross midnight', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-25', 'PB-INV-71'] }, 'One charge or export window may run past midnight (Predbat can_span_midnight).'),
  a('rate_control_unit', 'Rates written in', null, 'enum', { allowed: ['power', 'current', 'none'], appliesTo: BATT_INV, refs: ['PB-CAP-04'] }, 'Whether charge and discharge rates are written as power (W), current (A, via battery_voltage_v) or not at all (Predbat output_charge_control).'),
  a('rate_step_pct', 'Rate step', '% of capacity', 'number', { min: 0, max: 100, appliesTo: BATT_INV, refs: ['PB-CAP-30', 'PB-CTRL-15'] }, 'Rates are stored in steps of this share of capacity: the tolerance when reading a written rate back (Predbat rate_step_percent_of_capacity).'),
  a('write_readback_delay_s', 'Read-back delay', 's', 'number', { min: 0, max: 600, appliesTo: ['device:*'], refs: ['PB-CAP-29', 'PB-CTRL-15'] }, 'Wait after a write before reading it back (Predbat write_and_poll_sleep; GivEnergy 10 s).'),
  a('min_write_interval_s', 'Shortest time between writes', 's', 'integer', { min: 0, max: 86400, appliesTo: ['device:*'], refs: ['PB-CTRL-16'] }, 'Cloud write limit: no new write sooner than this (Predbat alphaess_min_write_interval 300, hanchu_min_write_interval).'),
  a('schedule_write_limit_per_day', 'Schedule writes per day', null, 'integer', { min: 0, max: 100000, appliesTo: BATT_INV, refs: ['PB-CTRL-16'] }, 'How many schedule changes the device or its cloud accepts per day (some cloud endpoints allow 1 per 24 h).'),
  a('charge_window_count_max', 'Charge windows', null, 'integer', { min: 0, max: 48, appliesTo: BATT_INV, unverified: true }, 'How many timed charge windows the device holds at once.'),
  a('export_window_count_max', 'Export windows', null, 'integer', { min: 0, max: 48, appliesTo: BATT_INV, unverified: true }, 'How many timed export windows the device holds at once.'),
  a('charge_from_grid_supported', 'Can charge from the grid', null, 'boolean', { appliesTo: BATT_INV, unverified: true }, 'The battery may be charged from the grid (some installations allow solar charging only).'),
  a('clock_offset_s', 'Clock offset', 's', 'integer', { min: -86400, max: 86400, appliesTo: ['device:*'], refs: ['PB-CTRL-26'] }, 'Device clock minus true time, as measured (Predbat warns at 5 and stops at 30 minutes of skew).'),
  a('clock_skew_start_min', 'Charge start skew', 'min', 'integer', { min: -60, max: 60, appliesTo: INV, refs: ['PB-INV-39'] }, 'Minutes added to a written charge start (Predbat inverter_clock_skew_start).'),
  a('clock_skew_end_min', 'Charge end skew', 'min', 'integer', { min: -60, max: 60, appliesTo: INV, refs: ['PB-INV-39'] }, 'Minutes added to a written charge end (inverter_clock_skew_end).'),
  a('clock_skew_discharge_start_min', 'Export start skew', 'min', 'integer', { min: -60, max: 60, appliesTo: INV, refs: ['PB-INV-39'] }, 'Minutes added to a written export start (inverter_clock_skew_discharge_start).'),
  a('clock_skew_discharge_end_min', 'Export end skew', 'min', 'integer', { min: -60, max: 60, appliesTo: INV, refs: ['PB-INV-39'] }, 'Minutes added to a written export end (inverter_clock_skew_discharge_end).'),

  // ── Capability profile and write path (the rest of Predbat's INVERTER_DEF flags and the cloud write limits;
  //    added with the coverage matrix, docs/coverage-matrix.json, plan item B11) ──
  a('control_interfaces', 'Control interfaces', null, 'json', { appliesTo: ['device:*'], refs: ['PB-CAP-01', 'PB-CAP-02', 'PB-CAP-03', 'PB-CAP-22'] }, 'How the device is read and controlled, a list of: rest (GivTCP REST, Predbat has_rest_api), mqtt (MQTT topics, has_mqtt_api), service (start / stop / freeze calls, has_service_api), solis_energy_control (Solis energy-control registers, has_solis_energy_control), cloud (a vendor cloud API).'),
  a('control_immediate', 'Controlled by rate, not windows', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-05', 'PB-CTRL-11'] }, 'The rate or current is set directly each cycle instead of writing timed windows (Predbat charge_control_immediate).'),
  a('current_decimal_places', 'Current decimal places', null, 'integer', { min: 0, max: 3, appliesTo: BATT_INV, refs: ['PB-CAP-06'] }, 'Decimal places a current (A) is written with (Predbat current_dp, 0 or 1).'),
  a('opposite_rate_zero_required', 'Other direction must be zero', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-07'] }, 'Charging needs the discharge rate set to 0, and the other way round (Predbat charge_discharge_with_rate).'),
  a('charge_schedule_enable_supported', 'Has a charge schedule switch', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-08', 'PB-INV-65'] }, 'A charge window takes effect only while its enable switch is on (Predbat has_charge_enable_time, scheduled_charge_enable).'),
  a('export_schedule_enable_supported', 'Has an export schedule switch', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-09', 'PB-INV-67'] }, 'An export window takes effect only while its enable switch is on (Predbat has_discharge_enable_time, scheduled_discharge_enable).'),
  a('target_soc_sets_export_floor', 'Target also sets the export floor', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-11'] }, 'The charge target is also the level a forced export stops at (Predbat target_soc_used_for_discharge).'),
  a('schedule_commit_required', 'Schedule needs a commit', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-14', 'PB-CTRL-12'] }, 'Written windows take effect only after a commit, a button press or an update call (Predbat time_button_press and its *_update_button settings).'),
  a('work_modes', 'Work modes', null, 'json', { appliesTo: BATT_INV, refs: ['PB-CAP-18', 'PB-CAP-19', 'PB-INV-59'] }, 'A list of the vendor work modes the device accepts, written in command.mode (GivEnergy eco, timed_demand, timed_export: Predbat has_ge_inverter_mode; an eco on/off switch is listed as eco_toggle: has_ge_eco_toggle).'),
  a('idle_window_supported', 'Has an idle window', null, 'boolean', { appliesTo: BATT_INV, refs: ['PB-CAP-20', 'PB-INV-70'] }, 'The device has idle (eco) start and end settings (Predbat has_idle_time; GivEnergy EMS).'),
  a('window_time_format', 'Window time format', null, 'enum', { allowed: ['HH:MM:SS', 'H M', 'H:M-H:M', 'S'], appliesTo: BATT_INV, refs: ['PB-CAP-23', 'PB-INV-64'] }, 'How window start and end times are written: one time, hour and minute apart, one "H:M-H:M" range, or seconds (Predbat charge_time_format).'),
  a('clock_time_format', 'Clock format', null, 'string', { appliesTo: ['device:*'], refs: ['PB-CAP-26', 'PB-INV-58'] }, 'strftime format the device reports its clock in, read to measure clock_offset_s (Predbat clock_time_format).'),
  a('write_retry_max', 'Write retries', null, 'integer', { min: 0, max: 20, appliesTo: ['device:*'], refs: ['PB-CAP-31', 'PB-CTRL-15'] }, 'How many times a write that does not read back is tried again (Predbat write_max_retry).'),
  a('write_backoff_s', 'Wait before a retry', 's', 'number', { min: 0, max: 3600, appliesTo: ['device:*'], refs: ['PB-CAP-31', 'PB-CTRL-15'] }, 'Wait before a write is tried again (Predbat write_backoff).'),
  a('api_delay_s', 'Wait between API calls', 's', 'number', { min: 0, max: 600, appliesTo: ['device:*'], refs: ['PB-CTRL-16'] }, 'Pause between two calls to the vendor API (Predbat alphaess_api_delay, hanchu_api_delay).'),
  a('schedule_step_min', 'Schedule time step', 'min', 'integer', { min: 1, max: 60, appliesTo: ['device:*'], refs: ['PB-CTRL-16'] }, 'Window times are rounded to this grid by the device or its cloud (AlphaESS: 15 minutes).'),
  a('apply_delay_s', 'Delay before a write acts', 's', 'number', { min: 0, max: 3600, appliesTo: ['device:*'], refs: ['PB-CTRL-16'] }, 'Time between a write and the device acting on it (AlphaESS cloud: 1 to 5 minutes).'),

  // ── Solar ──
  a('pv_kwp_total', 'PV peak power, all arrays', 'kWp', 'number', { min: 0, max: 1000, aliasOf: 'pv_kwp', refs: ['PB-PV-09'] }, 'The Predbat name (pv_array_kwp) for pv_kwp: written and read as pv_kwp.'),
  a('arrays', 'PV arrays', null, 'json', { shape: 'pv_arrays', refs: ['PB-PV-04', 'PB-PV-06'] }, 'Each array: peak power, tilt (declination), azimuth (180 = south), efficiency, shading and the inverter it feeds (Predbat forecast_solar / open_meteo_forecast lists).'),
  a('pv_scaling', 'PV performance factor', 'fraction', 'number', { min: 0, max: 2, unverified: true }, 'A property of the installation: output against a clean forecast for its size (shading, soiling). The planner setting pv_scaling (Predbat) scales the forecast on top.'),
  a('degradation_pct', 'PV degradation', '%/year', 'number', { min: 0, max: 5, unverified: true }, 'Yearly loss of panel output.'),
  a('pv_calibration', 'PV calibration factors', null, 'json', { refs: ['PB-PV-20'] }, 'Factors from comparing the provider forecast with what the panels made over the last days, {worst_day, best_day, total} (Predbat Metrics view "PV Calibration Scaling"); written with source measured.'),

  // ── Car and charger ──
  a('max_kw', 'Maximum charging power', 'kW', 'number', { min: 0, max: 50, appliesTo: ['device:ev_charger', 'device:ev'], refs: ['PB-CAR-10'] }, 'Highest charging power (Predbat car_charging_rate per car, 7.4 kW, 0.1-24).'),
  a('min_kw', 'Minimum charging power', 'kW', 'number', { min: 0, max: 50, appliesTo: ['device:ev_charger'], unverified: true }, 'Lowest power the charger can run at (6 A on one phase is about 1.4 kW).'),
  a('connected_to_site', 'Inside the home\'s meter', null, 'boolean', { appliesTo: ['device:ev_charger'], refs: ['PB-LOAD-26'] }, 'The charger is behind the home\'s import meter and CT clamp, so its energy is in the home\'s load (Predbat car_energy_reported_load, on).'),
  a('ready_by_time', 'Ready by', 'HH:MM', 'string', { shape: 'time_hhmm', appliesTo: ['device:ev_charger', 'device:ev'], refs: ['PB-CAR-14'] }, 'Local time this car must be charged by (Predbat car_charging_plan_time, 07:00; the home default is that setting).'),
  a('target_soc_pct', 'Target charge level', '%', 'number', { min: 0, max: 100, appliesTo: ['device:ev_charger', 'device:ev'], refs: ['PB-CAR-08'] }, 'Usual charge level the car should reach (Predbat car_charging_limit, 100 if unset; the live limit is a reading).'),
  a('car_battery_kwh', 'Car battery size', 'kWh', 'number', { min: 1, max: 250, appliesTo: ['device:ev', 'device:ev_charger'], refs: ['PB-CAR-07'] }, 'Capacity of the car battery (Predbat car_charging_battery_size, 100 if unset).'),
  a('car_charging_loss', 'Car charging loss', 'fraction', 'number', { min: 0, max: 0.5, appliesTo: ['device:ev', 'device:ev_charger'], refs: ['PB-CAR-11'] }, 'Share of the energy drawn that does not reach the car battery (Predbat car_charging_loss, 0.08).'),
  a('car_charging_exclusive', 'Shares a charger', null, 'boolean', { appliesTo: ['device:ev'], refs: ['PB-CAR-02'] }, 'This car shares one charger with other cars: only one charges at a time (Predbat car_charging_exclusive).'),
  a('manual_soc_entry', 'Charge level typed in', null, 'boolean', { appliesTo: ['device:ev'], refs: ['PB-CAR-12'] }, 'The car reports no charge level: it is typed in (readings of ev_soc_pct from source manual_entry) and tracked by the planner from then on (Predbat car_charging_manual_soc, per car).'),

  // ── Immersion, diverter and other loads ──
  a('power_kw', 'Rated power', 'kW', 'number', { min: 0, max: 50, appliesTo: ['device:immersion', 'device:iboost', 'device:smart_plug'], unverified: true }, 'Electrical power when on (an immersion element, a diverter at full power, an appliance on a plug); the planner\'s limits are the iboost_* settings.'),
  a('tank_litres', 'Tank volume', 'L', 'number', { min: 10, max: 2000, appliesTo: ['device:immersion', 'device:iboost', 'device:hot_water_tank', 'device:hot_water'], unverified: true }, 'Volume of the hot-water tank the immersion heats.'),
  a('target_temp_c', 'Target temperature', 'degC', 'number', { min: 5, max: 90, appliesTo: ['site', 'device:thermostat', 'device:trv', 'device:immersion', 'device:iboost', 'device:hot_water_tank'], refs: ['PH-SEN-03'] }, 'A room set-point for a home, thermostat or radiator valve (PredHeat target_temperature, 20 degC when no history), or the water temperature an immersion heats a tank to.'),
  a('holiday_calendar', 'Holiday calendar', null, 'string', { shape: 'code', unverified: true }, 'Code of the calendar (table calendar, e.g. gb_bank_holiday) whose days the load forecast treats as holidays; Predbat itself counts holiday_days_left down instead.'),

  // ── Heating (PredHeat predheat: block, PH-MOD) ──
  a('heat_loss_w_per_k', 'Heat loss', 'W/K', 'number', { min: 10, max: 2000, refs: ['PH-MOD-01'] }, 'Heat the building loses per degree between inside and outside (PredHeat heat_loss_watts, W per degC; code 100, template 120).'),
  a('heat_loss_degrees', 'Cooling rate', 'degC/h per degC', 'number', { min: 0.001, max: 0.5, refs: ['PH-MOD-02'] }, 'How fast the inside cools per hour per degree of inside-outside difference (PredHeat heat_loss_degrees; code 0.02, template 0.03).'),
  a('thermal_mass_kwh_per_k', 'Thermal capacity', 'kWh/K', 'number', { min: 0.1, max: 100, refs: ['PH-MOD-03'] }, 'Energy that raises the building by one degree. PredHeat derives it (heat_loss_watts / heat_loss_degrees, Wh per degC) rather than taking it as an input: store it only when measured otherwise.'),
  a('internal_gain_w', 'Static heat gain', 'W', 'number', { min: 0, max: 5000, refs: ['PH-MOD-04'] }, 'Steady heat from people and appliances (PredHeat heat_gain_static; code 0, template 200).'),
  a('emitter_output_w_at_dt50', 'Radiator output at delta-T 50', 'W', 'number', { min: 100, max: 100000, refs: ['PH-MOD-05'] }, 'Total rated radiator output at a 50 K water-to-air difference (PredHeat heat_output; code 7000, template 17000).'),
  a('system_water_volume_l', 'Heating water volume', 'L', 'number', { min: 10, max: 2000, refs: ['PH-MOD-06'] }, 'Water in the radiators and pipes (PredHeat heat_volume; code 200, template 75).'),
  a('heat_max_kw', 'Heat source maximum output', 'kW', 'number', { min: 0.5, max: 100, appliesTo: SITE_HEAT, refs: ['PH-MOD-07'] }, 'Highest heat output of the boiler or heat pump (PredHeat heat_max_power, 30000 W).'),
  a('heat_min_kw', 'Heat source minimum output', 'kW', 'number', { min: 0, max: 100, appliesTo: SITE_HEAT, refs: ['PH-MOD-08'] }, 'Lowest output before the unit cycles (PredHeat heat_min_power, 7000 W).'),
  a('heat_cop', 'Nominal COP or efficiency', 'factor', 'number', { min: 0.3, max: 8, appliesTo: SITE_HEAT, refs: ['PH-MOD-09'] }, 'Heat out per energy in: about 1.0 for gas, about 4 for a heat pump (PredHeat heat_cop, code default 0.9; its docs call it heating_cop, the code reads heat_cop: conflict, catalogue 1.4).'),
  a('flow_temp_c', 'Flow temperature set-point', 'degC', 'number', { min: 20, max: 80, appliesTo: SITE_HEAT, refs: ['PH-SEN-06'] }, 'Flow temperature when no sensor gives it (PredHeat flow_temp, default 40).'),
  a('flow_difference_target_c', 'Flow difference for full power', 'K', 'number', { min: 1, max: 60, appliesTo: SITE_HEAT, refs: ['PH-MOD-10'] }, 'Flow-to-target difference at which the source runs flat out (PredHeat flow_difference_target; code 20 gas / 5 pump, template and docs 40: conflict, catalogue 1.4).'),
  a('weather_compensation', 'Weather compensation', 'degC', 'json', { shape: 'wc_curve', appliesTo: SITE_HEAT, refs: ['PH-WX-02'] }, 'Flow temperature by outdoor temperature; must include -20 and 20 (PredHeat weather_compensation).'),
  a('delta_correction', 'Delta-T correction', 'factor', 'json', { shape: 'delta_t_curve', refs: ['PH-MOD-14'] }, 'Radiator output factor by water-to-air difference (PredHeat delta_correction, 16 default points).'),
  a('gas_efficiency_curve', 'Boiler efficiency by return temperature', 'fraction', 'json', { shape: 'efficiency_curve', appliesTo: ['site', 'device:boiler'], refs: ['PH-MOD-15'] }, 'Condensing boiler efficiency by return water temperature (PredHeat gas_efficiency, 11 default points).'),
  a('heat_pump_efficiency_curve', 'Heat pump COP by outdoor temperature', 'COP', 'json', { shape: 'cop_curve', appliesTo: ['site', 'device:heat_pump'], refs: ['PH-MOD-16'] }, 'COP by outdoor temperature (PredHeat heat_pump_efficiency, 21 default points -20..20).'),
  a('heat_pump_cop_curve', 'Heat pump COP by outdoor and flow temperature', 'COP', 'json', { shape: 'cop_grid', appliesTo: ['site', 'device:heat_pump'], unverified: 'predheat' }, 'COP by outdoor and flow temperature; PredHeat itself uses the one-dimensional heat_pump_efficiency_curve.'),
  a('hysteresis_on_c', 'Thermostat hysteresis (on)', 'K', 'number', { min: 0, max: 5, appliesTo: ['site', 'device:thermostat'], refs: ['PH-MOD-11'] }, 'Degrees below the set-point before heating starts (PredHeat hysteresis, 0.5).'),
  a('hysteresis_off_c', 'Thermostat hysteresis (off)', 'K', 'number', { min: 0, max: 5, appliesTo: ['site', 'device:thermostat'], refs: ['PH-MOD-11'] }, 'Degrees above the set-point before heating stops (PredHeat hysteresis_off, 0.1).'),
  a('heating_system', 'Heating system', null, 'enum', { allowed: ['gas_boiler', 'heat_pump_ashp', 'heat_pump_gshp', 'electric_resistive', 'district', 'other'], refs: ['PH-CFG-02'] }, 'What heats the home; PredHeat knows only gas or pump (its mode setting, predheat_mode).'),
  a('floor_area_m2', 'Heated floor area', 'm2', 'number', { min: 5, max: 2000, unverified: true }, 'Floor area of the heated rooms.'),
  a('volume_m3', 'Heated volume', 'm3', 'number', { min: 10, max: 10000, unverified: true }, 'Air volume of the heated rooms.'),
  a('insulation_class', 'Insulation', null, 'enum', { allowed: ['poor', 'below_average', 'average', 'good', 'very_good', 'passive_house'], unverified: true }, 'A rough class to estimate heat loss when it has not been measured.'),
  a('setback_temp_c', 'Set-back temperature', 'degC', 'number', { min: 5, max: 25, appliesTo: ['site', 'device:thermostat', 'device:trv'], unverified: true }, 'Lower set-point used at night or when away.'),
  a('comfort_min_c', 'Comfort minimum', 'degC', 'number', { min: 5, max: 30, unverified: 'predheat' }, 'Lowest indoor temperature accepted while occupied before a comfort penalty applies; not a PredHeat input (catalogue section 3).'),
  a('comfort_max_c', 'Comfort maximum', 'degC', 'number', { min: 10, max: 35, unverified: 'predheat' }, 'Highest indoor temperature accepted (pre-heating above it is not wanted); not a PredHeat input.'),
  a('emitter_type', 'Emitters', null, 'enum', { allowed: ['radiators', 'underfloor', 'fan_coil', 'mixed', 'other'], unverified: true }, 'How heat reaches the rooms; decides the flow temperature needed.'),
  a('flow_temp_design_c', 'Design flow temperature', 'degC', 'number', { min: 25, max: 80, appliesTo: SITE_HEAT, unverified: true }, 'Flow temperature the system was sized for at the design outdoor temperature.'),
  a('boiler_efficiency', 'Boiler efficiency', 'fraction', 'number', { min: 0.5, max: 1.1, appliesTo: ['site', 'device:boiler'], unverified: true }, 'One seasonal figure (gross calorific value); PredHeat uses gas_efficiency_curve instead.'),
  a('boiler_rated_kw', 'Boiler output', 'kW', 'number', { min: 1, max: 100, appliesTo: ['device:boiler'], unverified: true }, 'Rated heat output of the boiler (PredHeat\'s nearest: heat_max_kw).'),
  a('heat_pump_rated_kw', 'Heat pump output', 'kW', 'number', { min: 1, max: 50, appliesTo: ['device:heat_pump', 'site'], unverified: true }, 'Rated heat output of the heat pump (PredHeat\'s nearest: heat_max_kw).'),
  a('defrost_penalty', 'Defrost penalty', 'fraction', 'number', { min: 0, max: 0.5, appliesTo: ['device:heat_pump'], unverified: 'predheat' }, 'Share of output lost to defrost cycles in cold, damp weather; not a PredHeat input.'),
  a('min_run_minutes', 'Minimum run time', 'min', 'integer', { min: 0, max: 240, appliesTo: HEAT_DEVICES, unverified: true }, 'Shortest time the unit should run once started.'),
  a('min_off_minutes', 'Minimum off time', 'min', 'integer', { min: 0, max: 240, appliesTo: HEAT_DEVICES, unverified: true }, 'Shortest time the unit should stay off before starting again.'),
  a('hot_water_tank_litres', 'Hot-water cylinder volume', 'L', 'number', { min: 10, max: 2000, appliesTo: ['site', 'device:hot_water_tank', 'device:hot_water'], unverified: true }, 'Volume of the cylinder the heating system heats (PredHeat does not model hot water).'),
  a('hot_water_target_c', 'Hot-water temperature', 'degC', 'number', { min: 35, max: 80, appliesTo: ['site', 'device:hot_water_tank', 'device:hot_water', ...HEAT_DEVICES], unverified: true }, 'Temperature the cylinder is heated to (PredHeat does not model hot water).'),
  a('zones', 'Heating zones', null, 'json', { shape: 'zones', unverified: 'predheat' }, 'Rooms or areas heated and controlled separately, each with its own set-point; PredHeat models one zone (inside sensors averaged).'),

  // ── Site ──
  a('latitude', 'Latitude', 'degrees', 'number', { min: -90, max: 90, siteColumn: 'lat', refs: ['PB-OTH-84'] }, 'Where the home is (solar position, weather, alerts); cached on site.lat.'),
  a('longitude', 'Longitude', 'degrees', 'number', { min: -180, max: 180, siteColumn: 'lon', refs: ['PB-OTH-84'] }, 'Where the home is; cached on site.lon.'),
  a('altitude_m', 'Altitude', 'm', 'number', { min: -500, max: 9000, unverified: true }, 'Height above sea level (air density, temperature forecast).'),
  // The planning design's site fields (catalogue Appendix A, PD-02: no Predbat source, so our own design).
  a('deployment_mode', 'Where the planner runs', null, 'enum', { allowed: ['edge', 'cloud', 'hybrid'], unverified: true }, 'On a device in the home (edge), in the service (cloud) or both (hybrid); the planning design\'s site.deployment_mode.'),
  a('service_active', 'Home is served', null, 'boolean', { unverified: true }, 'Plans and syncs run for this home; false pauses them without deleting anything (the planning design\'s site.is_active).'),
]);

// ── Device kinds ──
// class: passive (measured only) or controllable (the planner may send it commands).
// Action codes are the device_action names of delta 030 (the plan tables), so a plan slot's action
// is one its device's kind lists. Kinds without device_action rows yet (smart_plug) use the same
// on / off words as the immersion rows. Delta 032 added 'release' (hand back) to the battery kinds and
// 'auto' (no instruction: the default of every other controllable kind with device_action rows).
const keysFor = (kind) => ATTRIBUTE_DEFS.filter((d) => JSON.parse(d.applies_to).some((t) => t === `device:${kind}` || t === 'device:*')).map((d) => d.key);
function k(kind, label, cls, actions, description) {
  return Object.freeze({ kind, label, class: cls, attribute_keys: JSON.stringify(keysFor(kind)), action_codes: JSON.stringify(actions), description });
}
const BATTERY_ACTIONS = ['demand', 'charge', 'freeze_charge', 'export', 'freeze_export', 'hold', 'pause', 'force_discharge', 'release'];
const HEATING_ACTIONS = ['auto', 'set_flow_temp', 'set_target_temp', 'heat_on', 'heat_off', 'boost', 'setback'];
export const DEVICE_KINDS = Object.freeze([
  k('battery', 'Battery', 'controllable', BATTERY_ACTIONS, 'A home battery; controlled directly (AC battery) or through its inverter.'),
  k('inverter', 'Inverter', 'controllable', BATTERY_ACTIONS, 'A hybrid or battery inverter: the control point for its batteries and panels.'),
  k('meter_import', 'Import meter', 'passive', [], 'Electricity import meter (MPAN, PDL, EAN).'),
  k('meter_export', 'Export meter', 'passive', [], 'Electricity export meter.'),
  k('meter_gas', 'Gas meter', 'passive', [], 'Gas meter (MPRN).'),
  k('meter_heat', 'Heat meter', 'passive', [], 'Heat meter on a heat pump or district heating supply.'),
  k('ev', 'Electric car', 'passive', [], 'A car (a supplier account\'s smart-charge dispatches, its charge level); charged through a charger.'),
  k('ev_charger', 'EV charger', 'controllable', ['auto', 'charge', 'stop', 'set_current'], 'A car charger the planner can start, stop and limit.'),
  k('immersion', 'Immersion heater', 'controllable', ['auto', 'on', 'off'], 'An immersion element heating a hot-water tank from the grid.'),
  k('iboost', 'Solar diverter', 'controllable', ['auto', 'on', 'off'], 'A solar diverter (iBoost, Eddi) sending surplus solar to an immersion; boost from the grid on command.'),
  k('heat_pump', 'Heat pump', 'controllable', HEATING_ACTIONS, 'Air- or ground-source heat pump for space heating and hot water.'),
  k('boiler', 'Boiler', 'controllable', HEATING_ACTIONS, 'Gas, oil or electric boiler.'),
  k('thermostat', 'Thermostat', 'controllable', ['auto', 'set_target_temp'], 'Room or zone thermostat.'),
  k('trv', 'Radiator valve', 'controllable', ['auto', 'set_target_temp'], 'Thermostatic radiator valve with a set-point.'),
  k('temperature_sensor', 'Temperature sensor', 'passive', [], 'Indoor, outdoor or water temperature sensor.'),
  k('hot_water_tank', 'Hot-water tank', 'passive', [], 'A hot-water cylinder as a physical store: heated by an immersion, boiler or heat pump.'),
  k('hot_water', 'Hot-water service', 'controllable', ['auto', 'heat_water'], 'The hot water planned as one (the cylinder and whatever heats it): the device kind of the device_action heat_water.'),
  k('smart_plug', 'Smart plug', 'controllable', ['on', 'off'], 'A switched socket (an appliance the planner may time).'),
]);

export const ATTRIBUTE_DEF_COLUMNS = Object.freeze(['key', 'label', 'unit', 'value_type', 'min_value', 'max_value', 'step', 'allowed_values', 'json_shape',
  'applies_to', 'origins', 'storage', 'site_column', 'alias_of', 'unverified', 'description', 'refs']);
export const DEVICE_KIND_COLUMNS = Object.freeze(['kind', 'label', 'class', 'attribute_keys', 'action_codes', 'description']);

// Rows missing from the database (read only: an up-to-date database is opened without writing).
const missing = (db, table, keyCol, rows) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
  const have = new Set(db.prepare(`SELECT ${keyCol} AS k FROM ${table}`).all().map((r) => r.k));
  return rows.filter((r) => !have.has(r[keyCol]));
};
export const attributeSeedPending = (db) => missing(db, 'attribute_def', 'key', ATTRIBUTE_DEFS).length > 0 || missing(db, 'device_kind', 'kind', DEVICE_KINDS).length > 0;

// Inserts the registry rows that are missing; an existing row (an operator's correction) is kept.
// Returns the number of rows written.
export function seedAttributeDefs(db) {
  let n = 0;
  const ins = (table, cols, rows) => {
    const st = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`);
    for (const r of rows) n += Number(st.run(...cols.map((c) => r[c] ?? null)).changes);
  };
  // Aliases point at another key, so the keys they name go in first.
  const defs = missing(db, 'attribute_def', 'key', ATTRIBUTE_DEFS);
  ins('attribute_def', ATTRIBUTE_DEF_COLUMNS, [...defs.filter((d) => !d.alias_of), ...defs.filter((d) => d.alias_of)]);
  ins('device_kind', DEVICE_KIND_COLUMNS, missing(db, 'device_kind', 'kind', DEVICE_KINDS));
  return n;
}
