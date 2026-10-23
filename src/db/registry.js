// Registry: the sources (with their data contracts), the canonical metrics and
// the dated VAT table. Everything the core knows about a provider's behaviour
// lives in its contract here, not in the build engine.

export const SOURCES = [
  {
    code: 'sunsynk_5min', name: 'Sunsynk 5-minute day series',
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
    contract: {
      timeZone: 'YYYY-MM-DD plant-local day', timeRole: 'interval: one local day',
      signs: 'Direction carried by the label (Purchased/Sold, Charge/Discharge)', units: 'kWh to 0.1',
      missing: 'Day absent', revisions: 'Today keeps growing until the day closes', upstreamHistory: 'Unlimited',
    },
  },
  {
    code: 'sunsynk_live', name: 'Sunsynk realtime flow',
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
    contract: {
      timeZone: 'UTC minute precision (Z)', timeRole: "interval: the API's 30-minute periods (a home's slot takes the time-weighted mean of the periods it overlaps); forward periods are forecasts",
      signs: '-', units: 'gCO2/kWh', missing: 'null',
      revisions: 'Forecast revised in place upstream; every fetch stored as its own issue', upstreamHistory: 'Regional from May 2018',
    },
  },
  {
    code: 'open_meteo', name: 'Open-Meteo weather',
    contract: {
      timeZone: 'Requested as Unix time (UTC) to avoid the fixed-offset clock-change problem',
      timeRole: 'temperature and cloud are instants; radiation is the mean of the preceding hour',
      signs: '-', units: 'degC, %, W/m2; tilted irradiance uses azimuth 0 = south', missing: 'null',
      revisions: 'New model runs', upstreamHistory: 'past_days up to 92 on the forecast API',
    },
  },
  {
    code: 'quartz', name: 'Open Climate Fix Quartz solar forecast',
    contract: {
      timeZone: 'Zone-less ISO keys, actually UTC; steps start at the request time, so they are snapped to the 15-minute grid', timeRole: 'forecast: 15-minute steps; value = mean kW over the next 15 min',
      signs: '-', units: 'kW, converted to kWh per 15 min (x 0.25 h)', missing: '-',
      revisions: 'Each call is a new issue; response timestamp = issue time', upstreamHistory: '-',
    },
  },
  {
    code: 'core_forecast', name: 'EnergieBee forecast (our own)',
    contract: {
      timeZone: 'UTC epoch seconds', timeRole: "forecast: slots of the home's slot length (site.slot_s: 15, 30 or 60 minutes; 30 by default) for the next 48 hours",
      signs: '-', units: 'kWh per slot; house use includes planned EV charging, grid import includes battery charging',
      missing: 'No row for a slot without history to forecast house use from',
      revisions: 'Each sync stores a new issue, at most one an hour; issue time = time of the run', upstreamHistory: 'Ours: kept like any other fact',
    },
  },
  {
    code: 'national_gas_cv', name: 'National Gas calorific value',
    contract: {
      timeZone: 'Applicable-for date = gas day, 05:00 to 05:00 GB local time (UNC Modification 0461)',
      timeRole: 'interval: one gas day per local distribution zone (LDZ)', signs: '-', units: 'MJ per standard m3',
      missing: 'The latest gas day is published the next morning (about 10:30)', revisions: 'latestFlag=Y keeps the latest published value',
      upstreamHistory: 'Full history on the National Gas Data Portal (data item "Calorific Value, LDZ(xx)")',
    },
  },
  {
    code: 'postcodes_io', name: 'postcodes.io',
    contract: { timeZone: '-', timeRole: 'reference', signs: '-', units: 'degrees', missing: '404 for unknown postcodes', revisions: '-', upstreamHistory: '-' },
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
