// The topology check (plan 2.7, R1, src/core/topology.js): the plant is read from the energy graph, classed, and a plant the graph does not
// explain is refused only where something measured would come out wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
const { topologyOf, plantOf, homeTopology } = await import('../src/core/topology.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');

const th = (id, type, valid_to = null) => ({ id, type, valid_to });
const feeds = (from, to) => ({ from, to, rel: 'feeds', valid_to: null });

await test('classes: no plant, solar only, solar and battery, several inverters', () => {
  assert.equal(topologyOf({ things: [th(1, 'meter_import')], relations: [] }).class, 'no_plant');
  const solar = topologyOf({ things: [th(1, 'inverter'), th(2, 'pv_array')], relations: [feeds(2, 1)] });
  assert.deepEqual([solar.class, solar.supported], ['solar_only', true]);
  const hybrid = topologyOf({ things: [th(1, 'inverter'), th(2, 'pv_array'), th(3, 'battery')], relations: [feeds(2, 1), feeds(1, 3), feeds(3, 1)], evidence: { flows: { solar: true, battery: true } } });
  assert.deepEqual([hybrid.class, hybrid.supported, hybrid.reasons], ['solar_battery', true, []]);
  assert.equal(topologyOf({ things: [th(1, 'inverter'), th(2, 'inverter')], relations: [] }).class, 'several_inverters');
  assert.deepEqual(plantOf({ things: [th(1, 'inverter'), th(2, 'pv_array')], relations: [feeds(2, 1)] }).arrayInverter, { 2: 1 });
});

await test('a retired thing is no part of the plant', () => {
  const t = topologyOf({ things: [th(1, 'inverter', 100), th(2, 'pv_array', 100)], relations: [] });
  assert.equal(t.class, 'no_plant');
});

await test('refused only where something measured would be wrong: panels or a battery with no inverter, or not wired to one', () => {
  const noInv = topologyOf({ things: [th(2, 'pv_array')], relations: [], evidence: { flows: { solar: true } } });
  assert.deepEqual([noInv.supported, noInv.reasons.length], [false, 1]);
  assert.match(noInv.reasons[0], /no inverter/);
  assert.equal(topologyOf({ things: [th(2, 'pv_array')], relations: [], evidence: { flows: {} } }).supported, true, 'nothing measured: nothing wrong');
  const unwired = topologyOf({ things: [th(1, 'inverter'), th(2, 'pv_array'), th(3, 'battery')], relations: [feeds(2, 1)], evidence: { flows: { solar: true, battery: true } } });
  assert.deepEqual(unwired.reasons, ['a battery is not wired to an inverter']);
});

await test('home 1: the graph from its evidence is a supported solar and battery plant', { skip }, async () => {
  await ensureEnergyGraph(1);
  const t = await homeTopology(1);
  assert.deepEqual([t.class, t.supported, t.reasons], ['solar_battery', true, []]);
  assert.equal(t.plant.inverters.length, 1);
  assert.deepEqual([t.plant.arrays.length, t.plant.batteries.length, t.plant.meters.length], [1, 1, 2]);
});
