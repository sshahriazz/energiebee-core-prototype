// The Sunsynk adapter parses to the vendor's own signed points; the channel rows split the signs. The
// stored facts must be what the adapter wrote before channels: clamped non-negative, one direction each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { normaliseDay, normaliseFlow, parseFlow } = await import('../src/adapters/sunsynk.js');
const { seriesId, readReadings } = await import('../src/core/facts.js');
db.prepare("INSERT INTO site (id, name, created_at) VALUES (1, 'sunsynk', 0)").run();

const rec = (values) => values.map((value, i) => ({ time: `0${i}:00`, value }));
const read = (metric) => readReadings([seriesId('site', 1, metric, 'sunsynk_5min')], 0, 2e9).map((r) => r.value);

test('grid and battery signs are split by channels: import/export and discharge/charge, never negative', () => {
  normaliseDay(1, 'Europe/London', '2026-06-10', { code: 0, data: { infos: [
    { label: 'Grid', records: rec([500, -300, 0]) }, { label: 'Battery', records: rec([-200, 400, 0]) },
    { label: 'PV', records: rec([-5, 1000, '']) }, { label: 'SOC', records: rec([50, 51, 52]) }] } }, null);
  assert.deepEqual(read('grid_import_w'), [500, 0, 0]);
  assert.deepEqual(read('grid_export_w'), [0, 300, 0]);
  assert.deepEqual(read('battery_discharge_w'), [0, 400, 0]);
  assert.deepEqual(read('battery_charge_w'), [200, 0, 0]);
  assert.deepEqual(read('solar_w'), [0, 1000], 'a negative PV reading is clamped to 0, an empty one is skipped');
  assert.deepEqual(read('battery_soc_pct'), [50, 51, 52]);
});

test('realtime flow: a figure the plant did not send is absent, not 0', () => {
  const { obs } = parseFlow({ data: { pv: [{ power: 100 }, { power: 50 }], gridOrMeterPower: -200, battPower: 30, loadOrEpsPower: 400 } }, 1900000000);
  const by = Object.fromEntries(obs.map((o) => [o.point, o.value]));
  assert.deepEqual(by, { pv_power: 150, load_power: 400, grid_power: -200, battery_power: 30 }, 'no soc and no ev point when not sent');
  normaliseFlow(1, { data: { pv: [{ power: 100 }], gridOrMeterPower: -200, battPower: 30, loadOrEpsPower: 400 } }, null);
  const live = (m) => readReadings([seriesId('site', 1, m, 'sunsynk_live')], 0, 2e9).map((r) => r.value);
  assert.deepEqual(live('grid_export_w'), [200]);
  assert.deepEqual(live('battery_soc_pct'), [], 'no charge level was sent, none is stored');
});
