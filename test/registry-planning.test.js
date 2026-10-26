// The planning metrics and sources (Phase B, src/db/registry.js): seeded as rows, each metric with a
// one-line description and a valid time role and aggregation, each source with a contract in the
// shape every other source has. Registry rows only: no table changed for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { METRICS, SOURCES } = await import('../src/db/registry.js');

const PLANNING = ['indoor_temp_c', 'indoor_temp_setpoint_c', 'heating_demand_kwh', 'heat_output_kwh', 'heatpump_elec_kwh', 'heatpump_flow_temp_c',
  'heatpump_return_temp_c', 'heatpump_cop', 'heating_on', 'valve_position_pct', 'boiler_gas_kwh', 'boiler_flow_temp_c', 'boiler_return_temp_c',
  'flow_temp_setpoint_c', 'radiator_temp_c', 'hot_water_temp_c', 'immersion_on', 'immersion_kwh', 'humidity_pct', 'dew_point_c', 'wind_speed_ms',
  'solar_kwh_p10', 'solar_kwh_p50', 'solar_kwh_p90', 'battery_calibrating', 'battery_temperature_c', 'ev_soc_pct', 'ev_charge_limit_pct', 'ev_connected'];

test('every planning metric is a seeded row with a one-line description', () => {
  assert.equal(new Set(METRICS.map((m) => m.code)).size, METRICS.length, 'codes are unique');
  const rows = new Map(db.prepare('SELECT code, label, unit, time_role, aggregation, domain FROM metric').all().map((r) => [r.code, r]));
  for (const code of PLANNING) {
    const m = METRICS.find((x) => x.code === code);
    assert.ok(m, `${code} in registry.js`);
    assert.ok(typeof m.description === 'string' && m.description.length > 10 && m.description.length <= 200 && !m.description.includes('\n'), `${code}: one-line description`);
    const r = rows.get(code);
    assert.deepEqual([r.label, r.unit, r.time_role, r.aggregation, r.domain], [m.label, m.unit, m.timeRole, m.aggregation, m.domain], code);
    // Energies add up, levels and flags average (a flag's mean is the share of time it was 1).
    if (m.unit === 'kWh') assert.deepEqual([m.timeRole, m.aggregation], ['interval', 'sum'], code);
    if (m.unit === '0/1') assert.deepEqual([m.timeRole, m.aggregation], ['instant', 'mean'], code);
  }
  // The heating serving table is built from the 'heating' domain: boiler gas belongs to it, not to 'gas'.
  assert.equal(METRICS.find((m) => m.code === 'boiler_gas_kwh').domain, 'heating');
  for (const code of ['outdoor_temp_c', 'cloud_pct', 'ghi_wm2', 'load_kwh', 'solar_kwh']) assert.ok(rows.has(code), `${code} kept`);
  for (const alias of ['outdoor_temp_forecast_c', 'cloud_cover_pct', 'solar_irradiance_wm2', 'load_forecast_kwh']) assert.ok(!rows.has(alias), `${alias}: an existing code holds it`);
});

test('the new sources have contracts in the shape of the others', () => {
  const keys = Object.keys(SOURCES.find((s) => s.code === 'quartz').contract).sort();
  for (const code of ['core_solar_cases', 'core_heat_model', 'heating_telemetry']) {
    const s = SOURCES.find((x) => x.code === code);
    assert.deepEqual(Object.keys(s.contract).sort(), keys, code);
    assert.equal(JSON.parse(db.prepare('SELECT contract FROM source WHERE code = ?').get(code).contract).timeZone, s.contract.timeZone);
  }
});
