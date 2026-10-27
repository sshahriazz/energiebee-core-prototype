// Registry: the sources (with their data contracts), the canonical metrics and
// the dated VAT table. Everything the core knows about a provider's behaviour
// lives in its contract here, not in the build engine.

// channels (a source's default point -> metric rows, created for a home by ensureChannels in core/channels.js).
// traits (machine-read by the planner read, stored in source.traits): holdS = seconds an instant sample holds;
// live = a realtime feed; forecastOnly = only ever read as a forecast; namedOnly = read only when named (a daily total).
export const SOURCES = [
  {
    code: 'sunsynk_5min', name: 'Sunsynk 5-minute day series',
    traits: { holdS: 300 },
    channels: [
      // The vendor's points as it names them (signed W, % for charge); the sign split and the clamp to >= 0 are channel rows.
      { point: 'PV', metric: 'solar_w', part: 'positive' }, { point: 'Load', metric: 'load_w', part: 'positive' },
      { point: 'Grid', metric: 'grid_import_w', part: 'positive' }, { point: 'Grid', metric: 'grid_export_w', part: 'negative' },
      { point: 'Battery', metric: 'battery_discharge_w', part: 'positive' }, { point: 'Battery', metric: 'battery_charge_w', part: 'negative' },
      { point: 'SOC', metric: 'battery_soc_pct' },
    ],
    contract: {
      timeZone: 'HH:mm on the plant clock; date from the request; zone from plant.timezone.code',
      timeRole: 'instant samples on a 5-minute grid, treated as holding until the next sample',
      signs: 'Grid positive = import. Battery positive = discharging. Split into separate direction metrics.',
      units: 'W; state of charge %',
      missing: 'Empty infos list; code other than 0 is an error',
      revisions: 'None',
      upstreamHistory: '90 days, then deleted by Sunsynk',
    },
  },
  {
    code: 'sunsynk_daily', name: 'Sunsynk daily totals',
    traits: { namedOnly: true },
    channels: [
      { point: 'PV Generation', metric: 'solar_kwh' }, { point: 'Load Power Consumption', metric: 'load_kwh' },
      { point: 'Purchased electricity', metric: 'grid_import_kwh' }, { point: 'Sold electricity', metric: 'grid_export_kwh' },
      { point: 'Charge Energy', metric: 'battery_charge_kwh' }, { point: 'Discharge Energy', metric: 'battery_discharge_kwh' },
    ],
    contract: {
      timeZone: 'YYYY-MM-DD plant-local day', timeRole: 'interval: one local day',
      signs: 'Direction carried by the label (Purchased/Sold, Charge/Discharge)', units: 'kWh to 0.1',
      missing: 'Day absent', revisions: 'Today keeps growing until the day closes', upstreamHistory: 'Unlimited',
    },
  },
  {
    code: 'sunsynk_live', name: 'Sunsynk realtime flow',
    traits: { holdS: 300, live: true },
    channels: [
      { point: 'pv_power', metric: 'solar_w', part: 'positive' }, { point: 'load_power', metric: 'load_w', part: 'positive' },
      { point: 'grid_power', metric: 'grid_import_w', part: 'positive' }, { point: 'grid_power', metric: 'grid_export_w', part: 'negative' },
      { point: 'battery_power', metric: 'battery_discharge_w', part: 'positive' }, { point: 'battery_power', metric: 'battery_charge_w', part: 'negative' },
      { point: 'soc', metric: 'battery_soc_pct' }, { point: 'ev_power', metric: 'ev_w', part: 'positive' },
    ],
    contract: {
      timeZone: 'No timestamp: fetch time floored to 5 minutes (UTC)', timeRole: 'instant',
      signs: 'gridOrMeterPower positive = import; battPower positive = discharging', units: 'W, %',
      missing: 'null, -100 sentinel, empty pv list when offline', revisions: 'None', upstreamHistory: 'Live only',
    },
  },
  {
    code: 'octopus_meter', name: 'Octopus smart meter',
    contract: {
      timeZone: 'interval_start with local offset (+01:00 in summer, Z in winter)', timeRole: 'interval: 30 minutes',
      signs: 'No sign: direction comes from the meter point (import or export MPAN)',
      units: 'kWh to 0.001; gas m3 (SMETS2) or kWh (SMETS1), detected from the annual estimate',
      missing: 'Absent row, never zero', revisions: 'Arrives about a day late; may be revised for a few days',
      upstreamHistory: 'Not verified',
    },
  },
  {
    code: 'octopus_rates', name: 'Octopus tariff rates',
    contract: {
      timeZone: 'valid_from / valid_to in UTC (Z); valid_to null = open-ended', timeRole: 'validity',
      signs: 'Direction from the product (import or export)',
      units: 'p/kWh and p/day; only value_exc_vat is stored because Octopus recalculates value_inc_vat at today\'s VAT rate',
      missing: 'Absent row', revisions: 'VAT-inclusive values recalculated; exclusive values stable', upstreamHistory: 'Full',
    },
  },
  {
    code: 'octopus_kraken', name: 'Octopus Kraken GraphQL',
    contract: {
      timeZone: 'ISO with +00:00', timeRole: 'interval: dispatch window; forecast: planned dispatches',
      signs: 'completedDispatches.delta is negative for import; stored as a positive charge',
      units: 'kWh', missing: 'null delta = unknown', revisions: 'Rolling window, 12 hours behind', upstreamHistory: 'Short',
    },
  },
  {
    code: 'carbon_regional', name: 'Carbon Intensity (regional)',
    channels: [{ point: 'intensity', metric: 'carbon_intensity' }],
    contract: {
      timeZone: 'UTC minute precision (Z)', timeRole: "interval: the API's 30-minute periods (a home's slot takes the time-weighted mean of the periods it overlaps); forward periods are forecasts",
      signs: '-', units: 'gCO2/kWh', missing: 'null',
      revisions: 'Forecast revised in place upstream; every fetch stored as its own issue', upstreamHistory: 'Regional from May 2018',
    },
  },
  {
    code: 'open_meteo', name: 'Open-Meteo weather',
    traits: { holdS: 3600 },
    channels: [
      { point: 'temperature_2m', metric: 'outdoor_temp_c' }, { point: 'cloud_cover', metric: 'cloud_pct' },
      { point: 'global_tilted_irradiance', metric: 'gti_wm2' }, { point: 'shortwave_radiation', metric: 'ghi_wm2' },
      { point: 'relative_humidity_2m', metric: 'humidity_pct' }, { point: 'dew_point_2m', metric: 'dew_point_c' }, { point: 'wind_speed_10m', metric: 'wind_speed_ms' },
    ],
    contract: {
      timeZone: 'Requested as Unix time (UTC) to avoid the fixed-offset clock-change problem',
      timeRole: 'temperature, cloud, humidity, dew point and wind are instants; radiation is the mean of the preceding hour; past hours are facts, future hours one change-only forecast issue per sync',
      signs: '-', units: 'degC, %, W/m2, m/s (wind_speed_unit=ms); tilted irradiance uses azimuth 0 = south', missing: 'null',
      revisions: 'New model runs', upstreamHistory: 'past_days up to 92 on the forecast API',
    },
  },
  {
    code: 'quartz', name: 'Open Climate Fix Quartz solar forecast',
    traits: { forecastOnly: true },
    // kW over a 15-minute step is kWh x 0.25
    channels: [{ point: 'power_kw', metric: 'solar_kwh', scale: 0.25, part: 'positive' }],
    contract: {
      timeZone: 'Zone-less ISO keys, actually UTC; steps start at the request time, so they are snapped to the 15-minute grid', timeRole: 'forecast: 15-minute steps; value = mean kW over the next 15 min',
      signs: '-', units: 'kW, converted to kWh per 15 min (x 0.25 h)', missing: '-',
      revisions: 'Each call is a new issue; response timestamp = issue time', upstreamHistory: '-',
    },
  },
  {
    code: 'core_forecast', name: 'EnergieBee forecast (our own)',
    traits: { forecastOnly: true },
    contract: {
      timeZone: 'UTC epoch seconds', timeRole: "forecast: slots of the home's slot length (site.slot_s: 15, 30 or 60 minutes; 30 by default) for the next 48 hours",
      signs: '-', units: 'kWh per slot; house use includes planned EV charging, grid import includes battery charging',
      missing: 'No row for a slot without history to forecast house use from',
      revisions: 'Each sync stores a new issue, at most one an hour; issue time = time of the run', upstreamHistory: 'Ours: kept like any other fact',
    },
  },
  {
    // Written only by src/core/plans.js savePlan when asked (predictionsTo 'forecast' or 'both'); no planner exists yet.
    code: 'core_plan', name: 'EnergieBee plan predictions (planner output; no planner yet)',
    traits: { forecastOnly: true },
    contract: {
      timeZone: 'UTC epoch seconds', timeRole: "forecast: the plan's own slots (plan_run.slot_s, any multiple of 5 minutes up to 60) over its horizon",
      signs: '-', units: 'kWh per slot (home import, export, solar, use; heat delivered); battery energy stored and indoor temperature at the end of the slot',
      missing: 'No row for a slot the plan made no prediction for (plans are sparse)',
      revisions: 'Each saved plan run is an issue (issue time = plan_run.created_at); a run whose decisions did not change is not saved', upstreamHistory: 'Ours: kept like any other fact',
    },
  },
  {
    code: 'national_gas_cv', name: 'National Gas calorific value',
    channels: [{ point: 'calorific_value', metric: 'gas_cv_mjm3' }],
    contract: {
      timeZone: 'Applicable-for date = gas day, 05:00 to 05:00 GB local time (UNC Modification 0461)',
      timeRole: 'interval: one gas day per local distribution zone (LDZ)', signs: '-', units: 'MJ per standard m3',
      missing: 'The latest gas day is published the next morning (about 10:30)', revisions: 'latestFlag=Y keeps the latest published value',
      upstreamHistory: 'Full history on the National Gas Data Portal (data item "Calorific Value, LDZ(xx)")',
    },
  },
  {
    code: 'tariffscanner', name: 'Tariffscanner (FEA) UK domestic tariff catalogue',
    contract: {
      timeZone: 'Dates (available_from, available_to) are GB local days; rate rows start and end at Europe/London midnight',
      timeRole: 'reference: the prices offered on the query date (today), one record per product x region x payment method x service type x rate type',
      signs: '-',
      units: 'Unit rates p/kWh and standing charges p/day as published (VAT basis not stated by the API); annual_cost in pounds',
      missing: 'A price of 0 means the record has no such component (gas on an electricity-only record), never a free fuel',
      revisions: 'A changed price supersedes the stored row (kept as history); rows are never deleted; withdrawals are not reported (the deleted-ids feed is not used)',
      upstreamHistory: 'query_date returns the catalogue as it was on a past date; only today is swept',
    },
  },
  {
    code: 'tounify', name: 'tounify v3 (preview) per-connection tariff prices and charges',
    contract: {
      timeZone: 'from_utc and next are UNIX seconds (UTC); days and time-of-use hours are read in applied.zone (the connection\'s zone)',
      timeRole: 'interval: each price point holds from from_utc for `resolution` seconds; a leg priced from a published series names its own grain in applied.consumption.settlement_interval',
      signs: 'A feed-in point\'s energy is paid to the producer; a credit component (NL Belastingvermindering) is negative',
      units: 'Major currency per kWh, net of VAT, as energy, grid and fees (levies) separately, vat on its own (stored x 100 as minor units, VAT never stored as a price); /components amounts in major currency per day, month or year, net of VAT',
      missing: 'A point with no grid key and applied.grid_gap = no_tariff is an incomplete price (never summed); pending_from marks where the series stops short of tomorrow',
      revisions: 'A day is priced in today\'s configuration; every read is stored and a changed price supersedes the stored row (kept as history); nothing is deleted',
      upstreamHistory: 'Only historic_days 0-3 before today: every day\'s series is captured on that day and kept',
    },
  },
  {
    code: 'postcodes_io', name: 'postcodes.io',
    contract: { timeZone: '-', timeRole: 'reference', signs: '-', units: 'degrees', missing: '404 for unknown postcodes', revisions: '-', upstreamHistory: '-' },
  },
  {
    code: 'core_solar_cases', name: 'EnergieBee solar cases (pessimistic, median, optimistic; our own, derived)',
    traits: { forecastOnly: true },
    contract: {
      timeZone: 'UTC epoch seconds', timeRole: "forecast: slots of the home's slot length for the next 48 hours; metrics solar_kwh_p10, solar_kwh_p50, solar_kwh_p90",
      signs: '-', units: 'kWh per slot: the central forecast of record (solar_kwh, core_forecast by default) x a quantile of this home\'s own actual / forecast ratios at that local time of day over the last 30 days, capped at the most it made in one slot',
      missing: 'No row for a slot whose time of day has fewer than 10 ratios (insufficient history); no issue at all when no time of day has enough (src/core/solar-cases.js)',
      revisions: 'Each derivation stores a new issue for the slots whose value changed (change-only); issue time = time of the run; origin derived', upstreamHistory: 'Ours: kept like any other fact',
    },
  },
  {
    code: 'core_heat_model', name: 'EnergieBee heating figures (our own, derived)',
    contract: {
      timeZone: 'UTC epoch seconds', timeRole: "derived per slot of the home's slot length in site_heat_slot (src/core/heat.js), not stored as facts; a heating model's predictions (PredHeat-style, not built) are to be its forecast issues of indoor_temp_c, indoor_temp_setpoint_c, heating_on, heatpump_elec_kwh or boiler_gas_kwh and radiator_temp_c",
      signs: '-', units: 'COP = heat delivered / heat pump electricity in the same slot; degree-hours = max(0, 15.5 degC - outdoor) x hours; cost in minor units of the home\'s currency at the import or gas unit price including tax',
      missing: 'null when an input is missing (never a default)', revisions: 'Rebuilt from the facts with site_heat_slot (method_version)', upstreamHistory: '-',
    },
  },
  {
    code: 'heating_telemetry', name: 'Heating device telemetry (generic: no vendor adapter yet)',
    traits: { holdS: 10800, live: true },
    contract: {
      timeZone: 'UTC epoch seconds as the device adapter converts them',
      timeRole: 'temperatures, set-points, valve openings and on/off flags are instants that hold until the next reading (at most 3 hours); heat, heat pump electricity and boiler gas are intervals',
      signs: '-', units: 'degC, %, 0/1, kWh', missing: 'No row; never a zero',
      revisions: 'Not defined until a vendor adapter exists', upstreamHistory: 'No vendor adapter is built: only synthetic test and demo data use this source',
    },
  },
  // Added with the coverage matrix (docs/coverage-matrix.json, plan item B11): homes for catalogue items that had
  // none. Registry rows only; no adapter writes them yet.
  {
    code: 'axle_vpp', name: 'Axle virtual power plant events (no adapter yet)',
    contract: {
      timeZone: 'UTC epoch seconds as the adapter converts them', timeRole: 'interval: one event period; announced events are forecast issues, past ones interval facts',
      signs: '-', units: '0/1 per event type (vpp_export_event, vpp_import_event)', missing: 'No row: no event',
      revisions: 'Not defined until an adapter exists', upstreamHistory: 'No adapter is built (Predbat binary_sensor.predbat_axle_event)',
    },
  },
  {
    code: 'weather_alerts', name: 'Weather alert feed (CAP; no adapter yet)',
    contract: {
      timeZone: 'UTC epoch seconds as the adapter converts them', timeRole: 'interval: the period an alert is in force; each fetch is an issue',
      signs: '-', units: '% of the battery to keep (the alert filter\'s keep level); the alert text, severity, certainty and area stay in the raw payload',
      missing: 'No row: no alert matching the filter', revisions: 'Not defined until an adapter exists', upstreamHistory: 'No adapter is built (Predbat alert_feed, 30-minute checks)',
    },
  },
  {
    code: 'manual_entry', name: 'Values typed in by a person',
    contract: {
      timeZone: 'UTC epoch seconds of the moment the value was typed in', timeRole: 'instant: the value at that moment (a car\'s charge level when the car reports none)',
      signs: '-', units: 'The metric\'s own unit', missing: 'No row', revisions: 'A correction is a new reading; the old one is kept', upstreamHistory: '-',
    },
  },
];

export const METRICS = [
  // Instant power and state (5-minute and live readings)
  { code: 'solar_w', label: 'Solar power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'solar' },
  { code: 'load_w', label: 'Home load', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'home' },
  { code: 'grid_import_w', label: 'Grid import power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'grid' },
  { code: 'grid_export_w', label: 'Grid export power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'grid' },
  { code: 'battery_charge_w', label: 'Battery charging power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'battery' },
  { code: 'battery_discharge_w', label: 'Battery discharging power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'battery' },
  { code: 'battery_soc_pct', label: 'Battery charge level', unit: '%', timeRole: 'instant', aggregation: 'last', domain: 'battery' },
  { code: 'battery_soc_kwh', label: 'Battery energy stored', unit: 'kWh', timeRole: 'instant', aggregation: 'last', domain: 'battery', description: 'Energy in the battery at an instant; a plan predicts it at the end of each slot (source core_plan).' },
  { code: 'ev_w', label: 'EV charging power', unit: 'W', timeRole: 'instant', aggregation: 'integrate', domain: 'ev' },
  // Energy over a period
  { code: 'solar_kwh', label: 'Solar generated', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'solar' },
  { code: 'load_kwh', label: 'Home use (measured)', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'home' },
  { code: 'grid_import_kwh', label: 'Grid import', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'grid' },
  { code: 'grid_export_kwh', label: 'Grid export', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'grid' },
  { code: 'battery_charge_kwh', label: 'Battery charged', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'battery' },
  { code: 'battery_discharge_kwh', label: 'Battery discharged', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'battery' },
  { code: 'gas_kwh', label: 'Gas used', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'gas' },
  { code: 'gas_m3', label: 'Gas used (volume)', unit: 'm3', timeRole: 'interval', aggregation: 'sum', domain: 'gas' },
  { code: 'gas_cv_mjm3', label: 'Gas calorific value', unit: 'MJ/m3', timeRole: 'interval', aggregation: 'mean', domain: 'gas' },
  { code: 'ev_charge_kwh', label: 'EV charged', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'ev' },
  // Context
  { code: 'carbon_intensity', label: 'Grid carbon intensity', unit: 'gCO2/kWh', timeRole: 'interval', aggregation: 'mean', domain: 'carbon' },
  { code: 'outdoor_temp_c', label: 'Outdoor temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'weather' },
  { code: 'cloud_pct', label: 'Cloud cover', unit: '%', timeRole: 'instant', aggregation: 'mean', domain: 'weather' },
  { code: 'gti_wm2', label: 'Sunlight on the panels', unit: 'W/m2', timeRole: 'interval', aggregation: 'mean', domain: 'weather' },
  { code: 'ghi_wm2', label: 'Sunlight on flat ground', unit: 'W/m2', timeRole: 'interval', aggregation: 'mean', domain: 'weather' },
  // Planning inputs (Phase B, 26 Oct 2026). `description` is code-only (the metric table has no column
  // for it): docs/database.md lists them. A 0/1 flag is an instant aggregated by mean, so a slot's
  // value is the share of it the flag was 1. Not added because an existing code already holds them:
  // an outdoor temperature, cloud or sunlight FORECAST (forecast_fact rows of outdoor_temp_c, cloud_pct
  // and ghi_wm2 / open_meteo), a house-use forecast (load_kwh / core_forecast), a price forecast
  // (rate_interval rows flagged estimated, delta 006).
  // Heating: built into site_heat_slot (src/core/heat.js) only for a home with a 'heating' series.
  { code: 'indoor_temp_c', label: 'Indoor temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Air temperature indoors from a thermostat or room sensor (one series per sensor).' },
  { code: 'indoor_temp_setpoint_c', label: 'Heating set-point', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Indoor temperature the heating control is set to hold; a value holds until the next reading.' },
  { code: 'heating_demand_kwh', label: 'Heating demand', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'heating', description: 'Heat the home needed over the period to hold its set-point: a device or model estimate, not a meter.' },
  { code: 'heat_output_kwh', label: 'Heat delivered', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'heating', description: 'Heat delivered into the heating circuit, from a heat meter or the heat pump or boiler report.' },
  { code: 'heatpump_elec_kwh', label: 'Heat pump electricity', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'heating', description: 'Electricity the heat pump used (sub-meter or its own report); already inside the home\'s grid import.' },
  { code: 'heatpump_flow_temp_c', label: 'Heat pump flow temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Water temperature leaving the heat pump into the heating circuit.' },
  { code: 'heatpump_return_temp_c', label: 'Heat pump return temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Water temperature coming back to the heat pump from the heating circuit.' },
  { code: 'boiler_flow_temp_c', label: 'Boiler flow temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Water temperature leaving the boiler into the heating circuit (OpenTherm or the boiler report).' },
  { code: 'boiler_return_temp_c', label: 'Boiler return temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Water temperature coming back to the boiler; a condensing boiler\'s efficiency depends on it.' },
  { code: 'flow_temp_setpoint_c', label: 'Flow temperature set-point', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Flow temperature the heat source is asked for (fixed, or from its weather compensation curve).' },
  { code: 'radiator_temp_c', label: 'Radiator water temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'Water temperature in the radiators (a sensor on a radiator near the indoor sensor).' },
  { code: 'heatpump_cop', label: 'Heat pump COP', unit: 'ratio', timeRole: 'interval', aggregation: 'mean', domain: 'heating', description: 'Heat delivered per kWh of electricity over a period, as a device reports it; site_heat_slot recomputes it from the two energies when both exist.' },
  { code: 'heating_on', label: 'Heating on', unit: '0/1', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: '1 while the heating calls for heat, 0 when it does not; a slot\'s mean is the share of it spent heating.' },
  { code: 'valve_position_pct', label: 'Valve opening', unit: '%', timeRole: 'instant', aggregation: 'mean', domain: 'heating', description: 'How far a radiator or zone valve is open, 0 to 100 %.' },
  { code: 'boiler_gas_kwh', label: 'Boiler gas', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'heating', description: 'Gas the boiler burnt (sub-meter or its own estimate); already inside the gas meter reading, never added to it.' },
  { code: 'hot_water_temp_c', label: 'Hot water temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'hot_water', description: 'Water temperature in the hot water cylinder (the top sensor where there are several).' },
  { code: 'immersion_on', label: 'Immersion heater on', unit: '0/1', timeRole: 'instant', aggregation: 'mean', domain: 'hot_water', description: '1 while the cylinder\'s immersion heater is switched on; a slot\'s mean is the share of it on.' },
  { code: 'immersion_kwh', label: 'Immersion or diverter energy', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'hot_water', description: 'Electricity the immersion heater or a solar diverter used; already inside the home\'s use, so a load forecast can take it out.' },
  // Weather beyond temperature, cloud and sunlight (Open-Meteo, the same hourly request).
  { code: 'humidity_pct', label: 'Outdoor humidity', unit: '%', timeRole: 'instant', aggregation: 'mean', domain: 'weather', description: 'Relative humidity of the outdoor air at 2 m (weather model); with temperature it sets when a heat pump defrosts.' },
  { code: 'dew_point_c', label: 'Outdoor dew point', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'weather', description: 'Dew point of the outdoor air at 2 m (weather model).' },
  { code: 'wind_speed_ms', label: 'Wind speed', unit: 'm/s', timeRole: 'instant', aggregation: 'mean', domain: 'weather', description: 'Wind speed at 10 m (weather model); wind raises a home\'s heat loss.' },
  // Solar cases: the central forecast is solar_kwh (quartz, core_forecast); these are derived from it.
  { code: 'solar_kwh_p10', label: 'Solar forecast, pessimistic case', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'solar', description: 'Solar energy per period with a 9 in 10 chance of being beaten: a provider\'s own 10th percentile, or core_solar_cases from this home\'s history.' },
  { code: 'solar_kwh_p50', label: 'Solar forecast, median case', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'solar', description: 'Median solar energy per period: a provider\'s own 50th percentile, or core_solar_cases from this home\'s history.' },
  { code: 'solar_kwh_p90', label: 'Solar forecast, optimistic case', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'solar', description: 'Solar energy per period beaten only 1 time in 10: a provider\'s own 90th percentile, or core_solar_cases from this home\'s history.' },
  // Battery and EV state a planner reads.
  { code: 'battery_calibrating', label: 'Battery calibrating', unit: '0/1', timeRole: 'instant', aggregation: 'mean', domain: 'battery', description: '1 while the battery runs a calibration cycle, when its charge level and limits do not follow a plan.' },
  { code: 'battery_temperature_c', label: 'Battery temperature', unit: 'degC', timeRole: 'instant', aggregation: 'mean', domain: 'battery', description: 'Battery cell or pack temperature from the inverter or battery; cold cells charge and discharge more slowly.' },
  { code: 'ev_soc_pct', label: 'EV charge level', unit: '%', timeRole: 'instant', aggregation: 'last', domain: 'ev', description: 'The car\'s battery charge level as the car or charger reports it.' },
  { code: 'ev_charge_limit_pct', label: 'EV charge limit', unit: '%', timeRole: 'instant', aggregation: 'last', domain: 'ev', description: 'Charge level the car or charger stops at (the car\'s own limit, or a supplier\'s target for a smart charge).' },
  { code: 'ev_connected', label: 'EV plugged in', unit: '0/1', timeRole: 'instant', aggregation: 'mean', domain: 'ev', description: '1 while the car is plugged in to the charger; a slot\'s mean is the share of it plugged in.' },
  // Demand flexibility events, weather alerts and an external load forecast (catalogue PB-RATE-26, 31, 32, 38,
  // PB-OTH-73, PB-LOAD-27, PH-LINK-01; added with the coverage matrix, B11). An announced period is a forecast
  // issue (one per fetch, as the planned dispatches are), a past one an interval fact; the event's own id and
  // text stay in its raw payload (raw_id). No adapter writes these yet.
  { code: 'saving_session_reward', label: 'Saving session reward', unit: 'octopoints/kWh', timeRole: 'interval', aggregation: 'mean', domain: 'flex', description: 'Reward per kWh of a supplier saving session (Octopus Power Down) over its period, available or joined.' },
  { code: 'saving_session_joined', label: 'Saving session joined', unit: '0/1', timeRole: 'interval', aggregation: 'mean', domain: 'flex', description: '1 over a saving session the home has joined, 0 over one it has not (available only).' },
  { code: 'free_session', label: 'Free electricity session', unit: '0/1', timeRole: 'interval', aggregation: 'mean', domain: 'flex', description: '1 over an announced free-electricity period (Octopus Power Up, EDF free hours through Kraken).' },
  { code: 'vpp_export_event', label: 'VPP export event', unit: '0/1', timeRole: 'interval', aggregation: 'mean', domain: 'flex', description: '1 over a virtual power plant event that asks the home to export (Axle).' },
  { code: 'vpp_import_event', label: 'VPP import event', unit: '0/1', timeRole: 'interval', aggregation: 'mean', domain: 'flex', description: '1 over a virtual power plant event that asks the home to import (Axle).' },
  { code: 'weather_alert_keep_pct', label: 'Weather alert keep level', unit: '%', timeRole: 'interval', aggregation: 'mean', domain: 'weather', description: 'Share of the battery to keep while a weather alert matching the home\'s filter is in force.' },
  { code: 'extra_load_kwh', label: 'Extra load forecast', unit: 'kWh', timeRole: 'interval', aggregation: 'sum', domain: 'home', description: 'Energy an outside model forecasts on top of the house load (a heating model\'s energy for a battery planner).' },
];

// Dated VAT. Octopus has published domestic electricity at 0% VAT since
// 30 Sep 2026 23:00 UTC (observed live 16 Oct 2026); gas is still 5%, export 0%.
// Provenance (origin 'sourced'): the 5 % is HMRC's reduced rate for domestic fuel and power; the
// 0 % from 1 Oct 2026 was read off Octopus's published inc-VAT prices, not from an HMRC notice.
export const GB_VAT_NOTE = 'src/db/registry.js VAT_RATES: GB domestic VAT 5 % (HMRC reduced rate for domestic fuel); electricity 0 % from 1 Oct 2026 as observed in Octopus published prices on 16 Oct 2026';
const T_2026_10_01 = Date.UTC(2026, 8, 30, 23, 0) / 1000;
export const VAT_RATES = [
  { fuel: 'electricity', direction: 'import', rate: 0.05, validFrom: 0, validTo: T_2026_10_01 },
  { fuel: 'electricity', direction: 'import', rate: 0.0, validFrom: T_2026_10_01, validTo: null },
  { fuel: 'electricity', direction: 'export', rate: 0.0, validFrom: 0, validTo: null },
  { fuel: 'gas', direction: 'import', rate: 0.05, validFrom: 0, validTo: null },
];
