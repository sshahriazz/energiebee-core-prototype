// Seed rows for the planner tunables registry (setting_def, delta 021): the knobs a Predbat-style
// battery planner and a PredHeat-style heating planner are run with, per home, each with a type,
// range and default. A home's own values are versioned in site_setting (src/core/settings.js); a
// key the home never set reads as its default here.
//
// Cross-checked against the sourced catalogue docs/predbat-predheat-requirements.md (26 Oct 2026):
// `refs` lists the catalogue ids a key covers, and defaults and ranges are the catalogue's (Predbat
// CONFIG_ITEMS / docs; PredHeat code). Names are Predbat's input_number / switch / apps.yaml names
// without the predbat_ prefix, with the unit added where ours differs (kW where Predbat uses W,
// best_soc_keep -> best_soc_keep_kwh). A key with no catalogue source is unverified = 1 and says
// so; where docs and code disagree (catalogue section 1.4) the description keeps the conflict.
//
// These are the FIRST rows only: a new tunable is one more row (INSERT INTO setting_def ...), never
// a migration. Seeding inserts only the rows that are missing; a row that exists is never changed,
// and a default should not be changed in place (an "as known at" read of a home that never set
// the key would change with it): record explicit values for the homes first.
//
// Columns (setting_def):
//   key, label, unit, value_type (number | integer | boolean | string | enum | json),
//   default_value (JSON text; 'null' = none), min_value, max_value, step, allowed_values (JSON list),
//   json_shape (src/core/value-check.js SHAPES), planner (predbat | predheat),
//   applies_to (the part of the plan it tunes), unverified, description, refs
export const PREDBAT_NOTE = 'unverified: from memory of Predbat; check against its docs';
export const PREDHEAT_NOTE = 'unverified: from memory of PredHeat; check against its docs';

function s(planner, appliesTo, key, label, unit, value_type, def, o, description) {
  const note = o.unverified ? (planner === 'predheat' ? PREDHEAT_NOTE : PREDBAT_NOTE) : null;
  return Object.freeze({
    key, label, unit, value_type, default_value: JSON.stringify(def ?? null),
    min_value: o.min ?? null, max_value: o.max ?? null, step: o.step ?? null,
    allowed_values: o.allowed ? JSON.stringify(o.allowed) : null, json_shape: o.shape ?? null,
    planner, applies_to: appliesTo, unverified: note ? 1 : 0,
    description: note ? `${description} (${note})` : description,
    refs: JSON.stringify(o.refs ?? []),
  });
}
const pb = (...x) => s('predbat', ...x);
const ph = (...x) => s('predheat', ...x);
// A Predbat on/off switch: bool(appliesTo, key, label, default, refs, description[, unverified])
const bool = (applies, key, label, def, refs, description, unverified = false) => pb(applies, key, label, null, 'boolean', def, { refs, unverified }, description);
const NOT_IN_CATALOGUE = 'not found in the sourced catalogue (perhaps an older Predbat name)';

export const SETTING_DEFS = Object.freeze([
  // ── Mode, run and horizon ──
  pb('planner', 'mode', 'Planner mode', null, 'enum', 'monitor', { allowed: ['monitor', 'control_soc_only', 'control_charge', 'control_charge_export', 'read_only'], refs: ['PB-OTH-66', 'PB-CTRL-01'] }, 'monitor: plan only; control_soc_only: write the target only; control_charge: no export windows; control_charge_export: everything (Predbat select.predbat_mode). read_only is ours for set_read_only. Default conflict: Predbat CONFIG_ITEMS says Control charge & discharge, its docs say a new install starts in Monitor (catalogue 1.4).'),
  bool('planner', 'set_read_only', 'Read only', false, ['PB-CTRL-02'], 'Never write to the inverter; switching it hands the inverter back (charge and discharge off, full rates, default reserve).'),
  pb('planner', 'plan_interval_min', 'Plan slot length', 'min', 'integer', 30, { min: 5, max: 60, step: 5, refs: ['PB-RATE-01'] }, 'Length of one plan slot, a multiple of 5 minutes (Predbat plan_interval_minutes: 30, or 15 in 15-minute markets).'),
  pb('planner', 'calculate_plan_every_min', 'Re-plan interval', 'min', 'integer', 10, { min: 5, max: 60, refs: ['PB-OTH-58'] }, 'How often a new plan is made (Predbat calculate_plan_every).'),
  pb('planner', 'forecast_hours', 'Plan horizon', 'h', 'integer', 48, { min: 12, max: 96, refs: ['PB-OTH-61'] }, 'How far ahead each plan looks (Predbat forecast_hours).'),
  pb('planner', 'forecast_plan_hours', 'Minimum plan length after the first charge', 'h', 'integer', 24, { min: 8, max: 96, refs: ['PB-OTH-62'] }, 'Predbat forecast_plan_hours.'),
  bool('planner', 'enable_coarse_fine_levels', 'Coarse then fine search', true, ['PB-OTH-63'], 'Search charge levels coarsely first, then finely (Predbat enable_coarse_fine_levels).'),
  pb('planner', 'plan_random_delay_s', 'Random re-plan delay', 's', 'integer', 0, { min: 0, max: 3600, refs: ['PB-OTH-64'] }, 'Random wait before each plan, to spread load on shared services (Predbat plan_random_delay).'),
  pb('planner', 'calculate_savings_max_charge_slots', 'Savings baseline charge slots', null, 'integer', 1, { min: 0, max: 48, refs: ['PB-OTH-65'] }, 'Charge slots in the baseline that savings are counted against; 0 = Demand baseline (Predbat calculate_savings_max_charge_slots).'),
  pb('planner', 'clock_skew_min', 'Host clock skew', 'min', 'integer', 0, { min: -60, max: 60, refs: ['PB-INV-40'] }, 'Correction for the planner host clock (Predbat clock_skew).'),
  pb('planner', 'holiday_days_left', 'Holiday days left', 'days', 'integer', 0, { min: 0, max: 28, refs: ['PB-LOAD-13'] }, 'Days the home is away; counts down at midnight, and the load forecast uses holiday scaling until 0.'),
  pb('load', 'holiday_load_scaling', 'Holiday load scaling', 'factor', 'number', 0.7, { min: 0.1, max: 1, refs: ['PB-LOAD-14'] }, 'Scales the load forecast while on holiday.'),

  // ── Battery plan ──
  pb('battery', 'best_soc_keep_kwh', 'Keep in the battery', 'kWh', 'number', 0, { min: 0, max: 100, refs: ['PB-OTH-31'] }, 'Soft floor the plan tries to keep, ignored in the first 4 hours (Predbat best_soc_keep).'),
  pb('battery', 'best_soc_keep_weight', 'Keep weighting', 'factor', 'number', 0.5, { min: 0.1, max: 5, refs: ['PB-OTH-32'] }, 'How strongly the keep floor counts (Predbat best_soc_keep_weight).'),
  pb('battery', 'best_soc_min_kwh', 'Lowest charge target', 'kWh', 'number', 0, { min: 0, max: 100, refs: ['PB-OTH-33'] }, 'Hard floor for charge and export targets (Predbat best_soc_min).'),
  pb('battery', 'best_soc_max_kwh', 'Highest charge target', 'kWh', 'number', 0, { min: 0, max: 1000, refs: ['PB-OTH-34'] }, 'Charge ceiling; 0 = off (Predbat best_soc_max).'),
  pb('battery', 'metric_battery_cycle', 'Battery wear cost', 'minor/kWh', 'number', 0, { min: 0, max: 50, refs: ['PB-OTH-24'] }, 'Cost per kWh cycled, added to the plan\'s cost.'),
  pb('battery', 'metric_battery_value_scaling', 'Value of stored energy', 'factor', 'number', 1, { min: 0, max: 2, refs: ['PB-OTH-22'] }, 'Scales what energy left in the battery at the end of the plan is worth.'),
  pb('battery', 'metric_battery_value_export_scaling', 'Value when export is worthless', 'factor', 'number', 0.8, { min: 0, max: 1, refs: ['PB-OTH-23'] }, 'Battery value scaling when export earns nothing.'),
  pb('battery', 'metric_self_sufficiency', 'Self-sufficiency bias', 'minor/kWh', 'number', 0, { min: 0, max: 100, refs: ['PB-OTH-25'] }, 'Extra cost per kWh imported, to prefer self-sufficiency.'),
  pb('battery', 'metric_min_improvement', 'Smallest saving to charge less', 'minor units', 'number', 0, { min: -50, max: 250, refs: ['PB-OTH-26'] }, 'Predbat metric_min_improvement.'),
  pb('battery', 'metric_min_improvement_export', 'Smallest saving to export', 'minor units per slot', 'number', 0.1, { min: -50, max: 250, refs: ['PB-OTH-27'] }, 'Predbat metric_min_improvement_export.'),
  pb('battery', 'metric_min_improvement_export_freeze', 'Smallest saving to freeze export', 'minor units per slot', 'number', 0.1, { min: -50, max: 250, refs: ['PB-OTH-28'] }, 'Predbat metric_min_improvement_export_freeze.'),
  pb('battery', 'metric_min_improvement_swap', 'Smallest saving to move export later', 'minor units', 'number', -0.25, { min: -50, max: 250, refs: ['PB-OTH-29'] }, 'Predbat metric_min_improvement_swap.'),
  pb('battery', 'metric_min_improvement_plan', 'Smallest saving to replace the plan', 'minor units', 'number', 2, { min: -50, max: 250, refs: ['PB-OTH-30'] }, 'A new plan replaces the current one only if it saves this much (Predbat metric_min_improvement_plan; in its code, not its docs).'),
  pb('battery', 'battery_loss', 'Charging loss', 'fraction', 'number', 0.03, { min: 0, max: 0.5, refs: ['PB-INV-26'] }, 'Share of the energy lost when charging.'),
  pb('battery', 'battery_loss_discharge', 'Discharging loss', 'fraction', 'number', 0.03, { min: 0, max: 0.5, refs: ['PB-INV-27'] }, 'Share of the energy lost when discharging.'),
  pb('battery', 'inverter_loss', 'Inverter loss', 'fraction', 'number', 0.04, { min: 0, max: 0.5, refs: ['PB-INV-28'] }, 'Share lost converting between AC and DC.'),
  bool('battery', 'inverter_hybrid', 'Hybrid inverter', true, ['PB-INV-19'], 'Panels and battery share one inverter (DC-coupled); off for an AC-coupled battery.'),
  pb('battery', 'battery_rate_max_scaling', 'Charge rate scaling', 'factor', 'number', 1, { min: 0, max: 2, refs: ['PB-INV-29'] }, 'Scales the maximum charge rate in the plan.'),
  pb('battery', 'battery_rate_max_scaling_discharge', 'Discharge rate scaling', 'factor', 'number', 1.05, { min: 0, max: 2, refs: ['PB-INV-30'] }, 'Scales the maximum discharge rate in the plan.'),
  pb('battery', 'charge_scaling10', 'Charge rate scaling, pessimistic case', 'factor', 'number', 0.8, { min: 0.1, max: 1, refs: ['PB-INV-31'] }, 'Charge rate scaling used with the PV10 forecast.'),
  bool('battery', 'battery_capacity_nominal', 'Use nominal capacity', false, ['PB-INV-22'], 'Plan with the nameplate capacity instead of the usable one.'),
  bool('battery', 'battery_scaling_auto', 'Learn the battery size', false, ['PB-INV-24'], 'Measure the capacity daily (7-day trimmed mean, clamped 0.8-1.0 of stated). Default not stated in the catalogue.'),
  pb('battery', 'inverter_limit_override', 'Rate cap override', 'kW', 'number', 0, { min: 0, max: 50, refs: ['PB-INV-12'] }, 'Runtime cap on the inverter rate; 0 = none (Predbat inverter_limit_override, in W there).'),
  pb('battery', 'charge_rate_override', 'Charge rate override', 'kW', 'number', null, { min: 0, max: 100, unverified: true }, `Charge at this rate instead of the device maximum; null = none (${NOT_IN_CATALOGUE}; nearest: inverter_limit_override).`),
  pb('grid', 'export_limit', 'Export limit (planner)', 'kW', 'number', null, { min: 0, max: 100, refs: ['PB-INV-07'] }, 'Export limit the plan respects; null = the installation\'s export_limit_kw attribute (Predbat export_limit, which can also be changed at runtime).'),

  // ── Control switches ──
  bool('control', 'set_charge_window', 'Write charge windows', true, [], `Write the planned charge windows to the inverter (${NOT_IN_CATALOGUE}).`, true),
  bool('control', 'set_export_window', 'Write export windows', true, [], `Write the planned export windows to the inverter (${NOT_IN_CATALOGUE}).`, true),
  bool('control', 'set_soc_enable', 'Write charge targets', true, [], `Write the planned charge targets (${NOT_IN_CATALOGUE}).`, true),
  bool('control', 'set_reserve_enable', 'Use the reserve to hold charge', true, ['PB-OTH-47'], 'Raise the reserve to stop the battery discharging when the plan holds it.'),
  bool('control', 'set_charge_freeze', 'Allow freeze charge', true, ['PB-OTH-38'], 'Hold the charge level (house from the grid) when cheaper than charging (expert setting).'),
  bool('control', 'set_charge_freeze_only', 'Freeze charge only', false, ['PB-OTH-39'], 'Never charge from the grid, only freeze.'),
  bool('control', 'set_export_freeze', 'Allow freeze export', true, ['PB-OTH-40'], 'Export solar while holding the battery when that pays.'),
  bool('control', 'set_export_freeze_only', 'Freeze export only', false, ['PB-OTH-41'], 'Never force-export, only freeze export.'),
  bool('control', 'set_charge_low_power', 'Low-power charging', false, ['PB-OTH-42'], 'Charge as slowly as the window allows.'),
  pb('control', 'charge_low_power_margin_min', 'Low-power finish margin', 'min', 'integer', 10, { min: 0, max: 60, refs: ['PB-OTH-43'] }, 'Finish low-power charging this long before the window ends (code allows 0-60, its docs say 0-30: catalogue 1.4).'),
  pb('control', 'low_power_pv_threshold_kw', 'Low-power PV threshold', 'kW', 'number', 0.15, { min: 0, max: 2, refs: ['PB-OTH-44'] }, 'Solar above this counts as solar for low-power charging (Predbat low_power_pv_threshold_w, 150 W).'),
  bool('control', 'set_charge_low_power_solar_full_rate', 'Full rate when sunny', true, ['PB-OTH-45'], 'Charge at full rate while there is solar.'),
  bool('control', 'set_export_low_power', 'Low-power export', false, ['PB-OTH-46'], 'Export as slowly as the window allows.'),
  bool('control', 'set_discharge_during_charge', 'Discharge during charge windows', true, ['PB-OTH-48'], 'Let the battery cover the house inside a charge window once the target is reached.'),
  bool('control', 'set_freeze_export_during_demand', 'Freeze export instead of Demand', false, ['PB-OTH-49'], 'Use freeze export where the plan would use Demand.'),
  bool('control', 'inverter_soc_reset', 'Reset the target outside charge', true, ['PB-OTH-50'], 'Put the target back to 100 % outside charge windows.'),
  bool('control', 'inverter_set_charge_before', 'Write charge windows early', true, ['PB-OTH-51'], 'Program a charge window before it starts.'),
  bool('control', 'combine_charge_slots', 'Combine charge slots', false, ['PB-OTH-59'], 'Join neighbouring charge slots into one window.'),
  bool('control', 'combine_export_slots', 'Combine export slots', false, ['PB-OTH-60'], 'Join neighbouring export slots into one window.'),
  pb('control', 'combine_rate_threshold', 'Combine within', 'minor/kWh', 'number', 0, { min: 0, max: 20, refs: ['PB-RATE-21'] }, 'Slots whose prices differ by no more than this may be combined; 0 = off.'),
  bool('planner', 'calculate_best_charge', 'Plan charging', true, [], `Work out the best charge windows and targets (${NOT_IN_CATALOGUE}).`, true),
  bool('planner', 'calculate_best_export', 'Plan exporting', true, [], `Work out the best export windows (${NOT_IN_CATALOGUE}).`, true),
  bool('planner', 'calculate_export_oncharge', 'Export inside charge slots', false, ['PB-OTH-53'], 'Allow export in a slot that is also a charge slot.'),
  bool('planner', 'calculate_export_on_pv', 'Export during solar production', true, ['PB-OTH-54'], 'Allow forced export while the panels produce.'),
  bool('planner', 'calculate_second_pass', 'Second pass', true, ['PB-OTH-55'], 'Run the optimisation twice.'),
  bool('planner', 'calculate_import_low_export', 'Sort equal import slots by export price', true, ['PB-OTH-56'], 'Predbat calculate_import_low_export.'),
  bool('planner', 'calculate_export_high_import', 'Sort equal export slots by import price', true, ['PB-OTH-57'], 'Predbat calculate_export_high_import.'),
  bool('planner', 'export_more_solar', 'Export more solar', false, ['PB-OTH-52'], 'Prefer exporting solar when export pays at least export_more_solar_threshold.'),
  pb('planner', 'export_more_solar_threshold', 'Export more solar threshold', 'minor/kWh', 'number', 1, { min: 0, max: 100, refs: ['PB-OTH-52'] }, 'Predbat export_more_solar_threshold.'),
  bool('battery', 'balance_inverters_enable', 'Balance inverters', false, ['PB-OTH-68'], 'Keep several inverters\' batteries at similar charge levels.'),
  bool('battery', 'balance_inverters_crosscharge', 'Stop cross-charging', true, ['PB-OTH-69'], 'Stop one inverter charging from another.'),
  bool('battery', 'balance_inverters_charge', 'Balance while charging', false, ['PB-OTH-70'], 'Predbat balance_inverters_charge.'),
  bool('battery', 'balance_inverters_discharge', 'Balance while discharging', false, ['PB-OTH-70'], 'Predbat balance_inverters_discharge.'),
  pb('battery', 'balance_inverters_threshold_charge', 'Balance threshold, charging', '%', 'number', 1, { min: 1, max: 20, refs: ['PB-OTH-71'] }, 'Charge-level difference that triggers balancing.'),
  pb('battery', 'balance_inverters_threshold_discharge', 'Balance threshold, discharging', '%', 'number', 1, { min: 1, max: 20, refs: ['PB-OTH-71'] }, 'Charge-level difference that triggers balancing.'),
  pb('planner', 'export_triggers', 'Export triggers', null, 'json', [], { shape: 'export_triggers', refs: ['PB-OTH-74'] }, 'Named flags that turn on when the plan exports at least energy kWh within minutes (Predbat export_triggers).'),
  pb('planner', 'weather_alert_filter', 'Weather alert filter', null, 'json', null, { refs: ['PB-OTH-72'] }, 'Which weather alerts raise the keep floor: {url, event (regex), severity, certainty, keep %, latitude, longitude} (Predbat alerts).'),
  pb('planner', 'replan_triggers', 'Re-plan when these change', null, 'json', [], { refs: ['PB-CTRL-28'] }, 'Inputs whose change starts a new plan at once: metric codes (ev_connected, ev_w ...) or keys of the read layer\'s state() (Predbat watch_list; it polls car_charging_now every 15 s).'),

  // ── Manual overrides (Predbat Manual Control): per home and versioned like every setting. A slot list
  //    holds slot start times (epoch s); a map holds {"<slot start, epoch s>": value}. A slot that has
  //    passed is ignored (Predbat removes it once used); at most 48 h ahead. Added with the coverage matrix (B11). ──
  pb('control', 'manual_charge', 'Force charge in', null, 'json', [], { refs: ['PB-OTH-76'] }, 'Slots the plan must charge in (Predbat select.predbat_manual_charge).'),
  pb('control', 'manual_export', 'Force export in', null, 'json', [], { refs: ['PB-OTH-77'] }, 'Slots the plan must export in (Predbat select.predbat_manual_export).'),
  pb('control', 'manual_demand', 'Force Demand in', null, 'json', [], { refs: ['PB-OTH-78'] }, 'Slots the plan must leave in Demand (Predbat select.predbat_manual_demand).'),
  pb('control', 'manual_freeze_charge', 'Freeze charge in', null, 'json', [], { refs: ['PB-OTH-79'] }, 'Slots the plan must hold the charge level in (Predbat select.predbat_manual_freeze_charge).'),
  pb('control', 'manual_freeze_export', 'Freeze export in', null, 'json', [], { refs: ['PB-OTH-80'] }, 'Slots the plan must freeze export in (Predbat select.predbat_manual_freeze_export).'),
  pb('control', 'manual_soc_min', 'Charge level floor at a time', null, 'json', {}, { refs: ['PB-OTH-81'] }, 'Map of slot to the lowest charge level (%) the battery must hold from then (Predbat select.predbat_manual_soc with manual_soc_value, 100).'),
  pb('control', 'manual_soc_max', 'Charge level ceiling at a time', null, 'json', {}, { refs: ['PB-OTH-82'] }, 'Map of slot to the highest charge level (%) the plan may charge to (Predbat select.predbat_manual_soc_max with manual_soc_max_value, 0).'),
  pb('tariff', 'manual_import_rates', 'Import price for a slot', null, 'json', {}, { refs: ['PB-RATE-17'] }, 'Map of slot to the import price (minor/kWh, -50 to 1000) the plan uses instead of the tariff (Predbat manual_import_rates with manual_import_value).'),
  pb('tariff', 'manual_export_rates', 'Export price for a slot', null, 'json', {}, { refs: ['PB-RATE-18'] }, 'Map of slot to the export price (minor/kWh) the plan uses instead of the tariff (Predbat manual_export_rates with manual_export_value).'),
  pb('load', 'manual_load_adjust', 'Load added in a slot', null, 'json', {}, { refs: ['PB-LOAD-21'] }, 'Map of slot to kWh added to the load forecast (-10 to 10; Predbat manual_load_adjust with manual_load_value, 0.5).'),

  // ── Tariff ──
  pb('tariff', 'rate_low_threshold', 'Cheap rate threshold', 'factor', 'number', 0, { min: 0, max: 2, refs: ['PB-RATE-19'] }, 'A rate below this times the future average counts as cheap; 0 = automatic.'),
  pb('tariff', 'rate_high_threshold', 'Export rate threshold', 'factor', 'number', 0, { min: 0, max: 2, refs: ['PB-RATE-20'] }, 'An export rate above this times the average is worth exporting at; 0 = automatic.'),
  bool('tariff', 'rate_low_match_export', 'Match cheap rates to export', false, [], `Count a rate as cheap only if below the export rates that follow (${NOT_IN_CATALOGUE}).`, true),
  pb('tariff', 'metric_future_rate_offset_import', 'Unpublished import price offset', 'minor/kWh', 'number', 0, { min: -50, max: 50, refs: ['PB-RATE-22'] }, 'Added to import prices not yet published.'),
  pb('tariff', 'metric_future_rate_offset_export', 'Unpublished export price offset', 'minor/kWh', 'number', 0, { min: -50, max: 50, refs: ['PB-RATE-23'] }, 'Added to export prices not yet published.'),
  bool('tariff', 'carbon_enable', 'Carbon tracking', false, ['PB-OTH-35'], 'Track grid carbon intensity in the plan.'),
  pb('tariff', 'carbon_metric', 'Carbon weight', 'minor units per kg CO2', 'number', 0, { min: 0, max: 500, refs: ['PB-OTH-36'] }, 'Cost given to each kg of CO2 imported.'),
  pb('tariff', 'rates_import_override', 'Import price overrides', null, 'json', [], { refs: ['PB-RATE-15', 'PB-CTRL-30'] }, 'Periods whose import price is set or shifted: a list of {date (optional), start "HH:MM", end "HH:MM", rate (= a price, minor/kWh) or rate_increment (added), load_scaling} (Predbat rates_import_override).'),
  pb('tariff', 'rates_export_override', 'Export price overrides', null, 'json', [], { refs: ['PB-RATE-16', 'PB-CTRL-30'] }, 'The same for export prices (Predbat rates_export_override).'),
  pb('tariff', 'future_rate_estimate', 'Estimated future prices', null, 'json', null, { refs: ['PB-RATE-24', 'PB-RATE-25'] }, 'How prices not yet published are estimated: {method nordpool | agilepredict, url, region, adjust_import, adjust_export, adjust_auto, peak_start, peak_end, peak_premium_import, peak_premium_export} (Predbat futurerate_* and futurerate_agilepredict_*); the estimates are rate rows marked estimated. null = no estimate.'),
  pb('tariff', 'octopus_slot_low_rate', 'Dispatched slots at the low rate', null, 'boolean', null, { refs: ['PB-RATE-36'] }, 'Price a smart-charge dispatch slot at the off-peak rate (Predbat octopus_slot_low_rate; default not stated in the catalogue).'),
  pb('tariff', 'octopus_slot_max', 'Dispatched half-hours priced low per day', null, 'integer', null, { min: 0, max: 48, refs: ['PB-RATE-36'] }, 'How many dispatched half-hours per 24 h get the off-peak price; null = automatic, 12 or 48 by tariff (Predbat octopus_slot_max).'),
  pb('tariff', 'compare_list', 'Tariffs to compare', null, 'json', [], { refs: ['PB-RATE-45'] }, 'The tariffs the home\'s plan is replayed on for comparison: a list of {id, name, tariff_code or rates, config (setting overrides), override_soc_max_kwh, override_battery_rate_max_charge_kw, override_battery_rate_max_discharge_kw, override_battery_rate_max_export_kw, override_inverter_limit_kw} (Predbat compare_list); each result is a what_if plan run with variant = id.'),
  pb('tariff', 'intelligent_dispatch_billing', 'How dispatches are billed', null, 'enum', 'auto', { allowed: ['auto', 'octopus', 'window'], refs: ['PB-RATE-36'] }, 'auto, octopus (the supplier\'s dispatch list) or window (the fixed off-peak window) (Predbat intelligent_dispatch_billing).'),

  // ── Solar forecast ──
  pb('solar', 'pv_scaling', 'Solar forecast scaling', 'factor', 'number', 1, { min: 0, max: 2, refs: ['PB-PV-11'] }, 'Scales the solar forecast.'),
  pb('solar', 'pv_metric10_weight', 'Weight of the PV10 forecast', 'fraction', 'number', 0.15, { min: 0, max: 1, refs: ['PB-PV-12'] }, 'How much the pessimistic (10th percentile) forecast counts in the plan\'s cost.'),
  pb('solar', 'solar_forecast_sources', 'Solar forecast sources, in order', null, 'json', null, { refs: ['PB-PV-08'] }, 'Source codes the solar forecast is read from, first choice first (the read layer\'s forecast() source option); null = the market\'s provider priority (Predbat forecast_solar_open_meteo_backup, forecast_solar_open_meteo_first).'),
  pb('solar', 'pv_metric90_weight', 'Weight of the PV90 forecast', 'fraction', 'number', 0.15, { min: 0, max: 1, refs: ['PB-PV-13'] }, 'How much the optimistic (90th percentile) forecast counts (expert).'),
  bool('solar', 'calculate_pv90_plan', 'Simulate the PV90 plan', true, ['PB-PV-14'], 'Also simulate the plan with the optimistic forecast.'),
  bool('solar', 'metric_pv_calibration_enable', 'PV calibration', true, ['PB-PV-15'], 'Calibrate the forecast against the home\'s own output (needs 7 days).'),
  bool('solar', 'metric_cloud_enable', 'Cloud model', true, ['PB-PV-16'], 'Model cloud variation within the forecast.'),

  // ── Load forecast ──
  pb('load', 'load_scaling', 'Load scaling', 'factor', 'number', 1.05, { min: 0, max: 2, refs: ['PB-LOAD-16'] }, 'Scales the load forecast.'),
  pb('load', 'load_scaling10', 'Load scaling, PV10 case', 'factor', 'number', 1.1, { min: 0, max: 2, refs: ['PB-LOAD-17'] }, 'Scales the load used with the pessimistic solar forecast.'),
  pb('load', 'load_scaling90', 'Load scaling, PV90 case', 'factor', 'number', 0.9, { min: 0, max: 2, refs: ['PB-LOAD-18'] }, 'Scales the load used with the optimistic solar forecast (clamped so PV90 <= central <= PV10).'),
  pb('load', 'load_scaling_saving', 'Load scaling in saving sessions', 'factor', 'number', 1, { min: 0, max: 2, refs: ['PB-LOAD-19'] }, 'Scales the load during a saving session or an Axle export event.'),
  pb('load', 'load_scaling_free', 'Load scaling in free sessions', 'factor', 'number', 1.2, { min: 0, max: 2, refs: ['PB-LOAD-20'] }, 'Scales the load during a free-electricity session or an Axle import event.'),
  pb('load', 'days_previous', 'Load history days', 'days back', 'json', [7], { shape: 'days_list', refs: ['PB-LOAD-09'] }, 'Which earlier days the load forecast is built from (7 = the same day last week).'),
  pb('load', 'days_previous_weight', 'Load history weights', null, 'json', [1], { shape: 'weights', refs: ['PB-LOAD-10'] }, 'Weight of each day in days_previous, in the same order.'),
  bool('load', 'days_previous_auto', 'Weighted-bucket forecast', true, ['PB-LOAD-11'], 'Weight history by weekday and age over max(days_previous) days (Predbat days_previous_auto).'),
  bool('load', 'load_filter_modal', 'Drop the lowest day', true, ['PB-LOAD-08'], 'Leave the lowest history day out of the load forecast.'),
  bool('load', 'load_power_fill_enable', 'Fill gaps from load power', true, ['PB-LOAD-05'], 'Fill missing load energy from the load power readings.'),
  bool('load', 'load_history_fill_enable', 'Fill gaps from own history', true, ['PB-LOAD-06'], 'Fill missing load energy from Predbat\'s own load history.'),
  pb('load', 'load_filter_threshold_min', 'Zero-load gap threshold', 'min', 'integer', 30, { min: 0, max: 1440, refs: ['PB-LOAD-07'] }, 'A run of zero load this long is a gap, not real; 1440 = off.'),
  pb('load', 'base_load_kw', 'Base load floor', 'kW', 'number', 0.1, { min: 0, max: 5, refs: ['PB-LOAD-15'] }, 'The load forecast never goes below this (Predbat base_load, 100 W).'),
  bool('load', 'load_forecast_only', 'External load forecast only', false, ['PB-LOAD-28'], 'Use only an external load forecast (for example PredHeat\'s heating energy).'),
  bool('load', 'calculate_inday_adjustment', 'In-day adjustment', true, ['PB-LOAD-29'], 'Correct today\'s load forecast from what the home has used so far.'),
  pb('load', 'metric_inday_adjust_damping', 'In-day adjustment damping', 'factor', 'number', 0.95, { min: 0.5, max: 2, refs: ['PB-LOAD-29'] }, 'Damps the in-day correction.'),
  bool('load', 'metric_dynamic_load_adjust', 'Dynamic load adjust', false, ['PB-LOAD-31'], 'Adjust the next slots from the last period\'s load.'),
  bool('load', 'metric_load_divergence_enable', 'Load divergence model', true, ['PB-LOAD-32'], 'Model load uncertainty from the next 4 hours\' spread.'),
  bool('load', 'load_ml_enable', 'Learned load model', false, ['PB-LOAD-33'], 'Train a load model on 5-minute history (default not stated in the catalogue).'),
  bool('load', 'load_ml_source', 'Plan with the learned load model', false, ['PB-LOAD-33'], 'Use the learned model\'s forecast for planning (default not stated in the catalogue).'),
  pb('load', 'load_ml_max_days_history', 'Learned model history', 'days', 'integer', 28, { min: 1, max: 365, refs: ['PB-LOAD-33'] }, 'Days of history the model trains on.'),
  pb('load', 'load_ml_database_days', 'Learned model storage', 'days', 'integer', 90, { min: 1, max: 3650, refs: ['PB-LOAD-33'] }, 'Days of history kept for the model.'),
  pb('load', 'load_ml_retrain_interval_hours', 'Learned model retrain interval', 'h', 'integer', 2, { min: 1, max: 48, refs: ['PB-LOAD-33'] }, 'How often the model is retrained.'),

  // ── Car ──
  bool('car', 'car_charging_hold', 'Remove car load from history', true, ['PB-LOAD-25'], 'Take car charging out of the house load history.'),
  pb('car', 'car_charging_threshold', 'Car detection threshold', 'kW', 'number', 6, { min: 4, max: 24, refs: ['PB-LOAD-24'] }, 'Without a car energy sensor, load above this is taken to be the car.'),
  pb('car', 'car_charging_energy_scale', 'Car energy scaling', 'factor', 'number', 1, { min: 0, max: 1, refs: ['PB-LOAD-23'] }, 'Scales the car energy sensor before it is removed from the load.'),
  bool('car', 'car_charging_plan_smart', 'Cheapest-slot car planning', true, ['PB-CAR-15'], 'Plan car charging in the cheapest slots before the ready-by time.'),
  pb('car', 'car_charging_plan_max_price', 'Highest car charging price', 'minor/kWh', 'number', 0, { min: 0, max: 200, refs: ['PB-CAR-16'] }, 'Do not plan car charging above this price; 0 = off.'),
  pb('car', 'car_charging_plan_time', 'Car ready by (home default)', 'HH:MM', 'string', '07:00', { shape: 'time_hhmm', refs: ['PB-CAR-14'] }, 'Default ready-by time; a car\'s own ready_by_time attribute wins.'),
  bool('car', 'car_charging_from_battery', 'Car may drain the home battery', false, ['PB-CAR-17'], 'Allow the home battery to charge the car.'),
  bool('car', 'octopus_intelligent_charging', 'Supplier-led car planning', true, ['PB-CAR-18'], 'The supplier schedules the car (Intelligent Octopus): its dispatches are the car plan.'),
  bool('car', 'octopus_intelligent_ignore_unplugged', 'Ignore unplugged state', false, ['PB-CAR-21'], 'Predbat octopus_intelligent_ignore_unplugged.'),
  bool('car', 'octopus_intelligent_consider_full', 'Consider the car full', false, ['PB-CAR-21'], 'Predbat octopus_intelligent_consider_full.'),
  bool('car', 'octopus_intelligent_dynamic', 'Dynamic dispatch check', true, ['PB-CAR-21'], 'Predbat octopus_intelligent_dynamic.'),
  bool('car', 'octopus_intelligent_trust_slots', 'Trust dispatch slots', true, ['PB-CAR-21'], 'Predbat octopus_intelligent_trust_slots.'),
  bool('car', 'octopus_intelligent_charger_follows_car', 'Drive the charger to the dispatches', false, ['PB-CAR-21'], 'Predbat octopus_intelligent_charger_follows_car.'),

  // ── iBoost (solar diverter / immersion) ──
  bool('iboost', 'iboost_enable', 'iBoost model', false, ['PB-OTH-01'], 'Model and plan the immersion diverter.'),
  bool('iboost', 'iboost_solar', 'Divert solar', true, ['PB-OTH-02'], 'Heat water with surplus solar.'),
  bool('iboost', 'iboost_solar_excess', 'Only solar that would be exported', false, ['PB-OTH-03'], 'Divert only solar the battery would not take.'),
  bool('iboost', 'iboost_charging', 'Run while the battery charges', false, ['PB-OTH-04'], 'Predbat iboost_charging.'),
  bool('iboost', 'iboost_smart', 'Cheapest slots to the energy target', false, ['PB-OTH-05'], 'Heat from the grid in the cheapest slots to reach iboost_max_energy.'),
  pb('iboost', 'iboost_smart_min_length_min', 'Smart minimum slot length', 'min', 'integer', 30, { min: 30, max: 120, refs: ['PB-OTH-06'] }, 'Shortest smart iBoost run.'),
  bool('iboost', 'iboost_on_export', 'iBoost during forced export', false, ['PB-OTH-07'], 'Allow iBoost while the battery force-exports.'),
  bool('iboost', 'iboost_prevent_discharge', 'Hold the battery during iBoost', false, ['PB-OTH-08'], 'Stop the battery discharging into the immersion.'),
  bool('iboost', 'iboost_gas', 'Compare import with gas', false, ['PB-OTH-09'], 'Heat with electricity only when cheaper than gas.'),
  bool('iboost', 'iboost_gas_export', 'Compare export with gas', false, ['PB-OTH-09'], 'Divert solar only when its export value is below gas.'),
  pb('iboost', 'iboost_gas_scale', 'Gas price scaling', 'factor', 'number', 1, { min: 0, max: 2, refs: ['PB-OTH-10'] }, 'Scales the gas price iBoost is compared with (1 / boiler efficiency).'),
  pb('iboost', 'iboost_rate_threshold', 'Highest import price to boost', 'minor/kWh', 'number', 100, { min: 0, max: 200, refs: ['PB-OTH-11'] }, 'Heat from the grid only below this price.'),
  pb('iboost', 'iboost_rate_threshold_export', 'Highest export price to divert', 'minor/kWh', 'number', 100, { min: 0, max: 200, refs: ['PB-OTH-11'] }, 'Divert solar only when the export price is below this.'),
  pb('iboost', 'iboost_max_energy', 'Diverter energy per day', 'kWh', 'number', 3, { min: 0, max: 50, refs: ['PB-OTH-12'] }, 'Energy the tank takes in a day.'),
  pb('iboost', 'iboost_max_power', 'Diverter maximum power', 'kW', 'number', 2.4, { min: 0, max: 10, refs: ['PB-OTH-13'] }, 'Highest power to the immersion (Predbat 2400 W).'),
  pb('iboost', 'iboost_min_power', 'Diverter minimum power', 'kW', 'number', 0.5, { min: 0, max: 10, refs: ['PB-OTH-13'] }, 'Surplus below this does not start the diverter (Predbat 500 W).'),
  pb('iboost', 'iboost_min_soc', 'iBoost from this charge level', '%', 'number', 0, { min: 0, max: 100, refs: ['PB-OTH-14'] }, 'iBoost only when the home battery is at least this full.'),
  pb('iboost', 'iboost_value_scaling', 'Value of diverted energy', 'factor', 'number', 0.75, { min: 0, max: 2, refs: ['PB-OTH-15'] }, 'Diverted energy is worth this times the lowest future import rate.'),
  bool('iboost', 'iboost_energy_subtract', 'Subtract diverter energy from load', true, ['PB-OTH-16'], 'Take diverter energy out of the load history.'),
  pb('iboost', 'iboost_energy_scaling', 'Diverter energy sensor scaling', 'factor', 'number', 1, { min: 0, max: 10, refs: ['PB-OTH-17'] }, 'Scales the diverter energy readings.'),

  // ── Saving sessions (demand flexibility events) ──
  bool('saving_session', 'saving_session_enable', 'Saving sessions', false, [], `Plan around demand flexibility events (our switch; ${NOT_IN_CATALOGUE}).`, true),
  bool('saving_session', 'saving_session_auto_join', 'Join saving sessions', true, ['PB-RATE-29'], 'Join announced sessions automatically (Predbat octopus_saving_auto_join).'),
  pb('saving_session', 'saving_session_auto_join_lead_hours', 'Join lead time', 'h', 'number', 0, { min: 0, max: 12, refs: ['PB-RATE-29'] }, 'Join only sessions at least this far ahead (default not stated in the catalogue).'),
  pb('saving_session', 'saving_session_min_octopoints_per_kwh', 'Smallest reward to join', 'octopoints/kWh', 'number', 0, { min: 0, refs: ['PB-RATE-28'] }, 'Predbat octopus_saving_session_min_octopoints_per_kwh.'),
  pb('saving_session', 'saving_session_octopoints_per_penny', 'Octopoints per penny', null, 'integer', 8, { min: 1, max: 1000, refs: ['PB-RATE-27'] }, 'Predbat octopus_saving_session_octopoints_per_penny.'),
  pb('saving_session', 'saving_session_rate', 'Fixed saving-session price', 'minor/kWh', 'number', null, { min: 0, max: 1000, refs: ['PB-RATE-30'] }, 'Price paid per kWh in a saving session instead of its octopoints; null = from the octopoints (Predbat octopus_saving_session_rate, in its code, not its docs).'),
  pb('saving_session', 'axle_reward_per_kwh', 'Axle event reward', 'minor/kWh', 'number', 100, { min: 0, max: 1000, refs: ['PB-RATE-33'] }, 'Added to the export price during an Axle VPP export event (Predbat axle_pence_per_kwh, 100).'),
  pb('saving_session', 'axle_control', 'Stand aside for Axle events', null, 'boolean', null, { refs: ['PB-RATE-33', 'PB-CTRL-24'] }, 'During an Axle event the planner writes nothing (read-only for the event) (Predbat axle_control; default not stated in the catalogue).'),

  // ── PredHeat (predheat: block) ──
  ph('heating', 'predheat_enable', 'PredHeat on', null, 'boolean', false, { refs: ['PH-CFG-01'] }, 'Run the heating model (Predbat switch predheat_enable). PredHeat predicts; it issues no commands.'),
  ph('heating', 'predheat_mode', 'Heat source type', null, 'enum', 'pump', { allowed: ['gas', 'pump'], refs: ['PH-CFG-02'] }, 'gas or pump (PredHeat mode; code default pump, template gas: conflict, catalogue 1.4).'),
  ph('heating', 'predheat_forecast_days', 'Heating forecast length', 'days', 'integer', 2, { min: 1, max: 7, refs: ['PH-CFG-03'] }, 'PredHeat forecast_days.'),
  ph('heating', 'predheat_run_every_min', 'Heating model interval', 'min', 'integer', 5, { min: 5, max: 60, step: 5, refs: ['PH-CFG-04'] }, 'How often the heating model runs (PredHeat run_every).'),
  ph('heating', 'predheat_days_previous', 'Heating history days', 'days back', 'json', [7], { shape: 'days_list', refs: ['PH-CFG-05'] }, 'Days whose set-points and energy are replayed (PredHeat days_previous).'),
  ph('heating', 'predheat_days_previous_weight', 'Heating history weights', null, 'json', [1], { shape: 'weights', refs: ['PH-CFG-06'] }, 'PredHeat days_previous_weight.'),
  ph('heating', 'heating_energy_scaling', 'Heating energy scaling', 'factor', 'number', 1, { min: 0.1, max: 5, refs: ['PH-SEN-04'] }, 'Scales the heating energy readings (PredHeat heating_energy_scaling; code 1.0, template 1.4).'),
  ph('heating', 'smart_thermostat', 'Smart thermostat (pre-heat)', null, 'boolean', false, { refs: ['PH-MOD-12'] }, 'The thermostat pre-heats to reach the set-point on time (PredHeat smart_thermostat; code off, template on).'),
  ph('heating', 'preheat_hours_max', 'Longest pre-heat', 'h', 'number', null, { min: 0, max: 24, refs: ['PH-MOD-13'] }, 'Cap on how early pre-heating starts; null = no cap (PredHeat smart_thermostat_max_minutes, in minutes there).'),
  ph('heating', 'heating_target_c', 'Heating target', 'degC', 'number', 20, { min: 5, max: 30, refs: ['PH-SEN-03'] }, 'Set-point when there is no set-point history (PredHeat replays target_temperature from days_previous, 20 degC by default).'),
  ph('heating', 'heating_schedule', 'Heating schedule', null, 'json', [], { shape: 'schedule', unverified: true }, 'Set-points by time of day; empty = heating_target_c all day. PredHeat has no explicit schedule: it replays the set-point history (catalogue section 3).'),
  ph('heating', 'heat_pump_cycle_penalty', 'Heat pump start cost', 'minor units', 'number', 0, { min: 0, max: 100, unverified: true }, 'Cost charged in a heating plan for every start (planning design; not in PredHeat).'),
  ph('heating', 'comfort_penalty_per_degree_hour', 'Comfort penalty', 'minor/degC-h', 'number', 10, { min: 0, max: 1000, unverified: true }, 'Cost charged for each degree-hour below the set-point (planning design; not in PredHeat).'),
  ph('heating', 'price_vs_comfort_weight', 'Price versus comfort', 'fraction', 'number', 0.5, { min: 0, max: 1, unverified: true }, '0 = comfort only, 1 = price only (planning design; not in PredHeat).'),
  ph('hot_water', 'hot_water_schedule', 'Hot-water schedule', null, 'json', [], { shape: 'schedule', unverified: true }, 'When the cylinder must be hot; empty = always at hot_water_target_c (PredHeat does not model hot water).'),
]);

export const SETTING_DEF_COLUMNS = Object.freeze(['key', 'label', 'unit', 'value_type', 'default_value', 'min_value', 'max_value', 'step', 'allowed_values',
  'json_shape', 'planner', 'applies_to', 'unverified', 'description', 'refs']);

const missingDefs = (db) => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'setting_def'").get()) return [];
  const have = new Set(db.prepare('SELECT key FROM setting_def').all().map((r) => r.key));
  return SETTING_DEFS.filter((d) => !have.has(d.key));
};
// True when seedSettingDefs would write (read only).
export const settingSeedPending = (db) => missingDefs(db).length > 0;

// Inserts the rows that are missing; an existing row is never changed. Returns rows written.
export function seedSettingDefs(db) {
  const st = db.prepare(`INSERT INTO setting_def (${SETTING_DEF_COLUMNS.join(', ')}) VALUES (${SETTING_DEF_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`);
  let n = 0;
  for (const d of missingDefs(db)) n += Number(st.run(...SETTING_DEF_COLUMNS.map((c) => d[c] ?? null)).changes);
  return n;
}
