// Consumption and heating on the synthetic home (plan 5.1 to 5.3, docs/build/heating.md): its heating graph is made from its devices, each
// room has its own energy and heating, the rooms add up to the home (each kWh once), and the heating system's heat output is the
// build's own heating slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const G = await import('../src/core/synthetic-iot.js');
const { buildLayers } = await import('../src/core/layers.js');
const { buildHeat } = await import('../src/core/heat.js');
const { localDate, addDays, dayBounds, nowSec } = await import('../src/core/time.js');
const { readNodeSlots } = await import('../src/core/node-slots.js');

const { site } = await G.createSyntheticIotHome({ days: 3 });
const to = localDate(site.timezone, nowSec()); const from = addDays(to, -3);
const [W0] = dayBounds(site.timezone, from); const [, W1] = dayBounds(site.timezone, to);
await buildHeat(site.id, from, to);
await buildLayers(site.id, from, to);
const thing = async (type) => Number((await db.prepare("SELECT id FROM thing WHERE home_id = ? AND type = ? AND superseded_at IS NULL ORDER BY id LIMIT 1").get(site.id, type)).id);
const byMetric = async (id, metric) => new Map((await readNodeSlots(id, W0, W1, [metric])).map((r) => [Number(r.slot_start), r.value]));

await test('the heating graph of the synthetic home: its heat pump is part of its heating system', async () => {
  const sys = await thing('heating');
  const members = await db.prepare(`SELECT t.type FROM thing_relation r JOIN thing t ON t.id = r.from_id WHERE r.to_id = ? AND r.rel = 'part_of' AND r.superseded_at IS NULL`).all(sys);
  assert.deepEqual(members.map((m) => m.type), ['heat_pump']);
});

await test('the rooms add up to the home: each kWh once, whichever way it is added', async () => {
  const home = await byMetric(site.id, 'energy_kwh');
  assert.ok(home.size > 20, `${home.size} slots`);
  const rooms = await db.prepare("SELECT id, name FROM thing WHERE home_id = ? AND kind = 'space' AND superseded_at IS NULL ORDER BY id").all(site.id);
  assert.deepEqual(rooms.map((r) => r.name).sort(), ['Driveway', 'Living room', 'Utility room']);
  const sum = new Map();
  for (const r of rooms) for (const [start, v] of await byMetric(Number(r.id), 'energy_kwh')) sum.set(start, (sum.get(start) ?? 0) + v);
  let compared = 0;
  for (const [start, v] of home) { if (!sum.has(start)) continue; compared++; assert.ok(Math.abs(sum.get(start) - v) < 1e-6, `slot ${start}: rooms ${sum.get(start)} against home ${v}`); }
  assert.ok(compared > 20, `${compared} slots compared`);
});

await test('the heating system\'s heat out and energy in are the build\'s own heating slots', async () => {
  const sys = await thing('heating');
  const out = await byMetric(sys, 'heat_output_kwh'); const inn = await byMetric(sys, 'heat_pump_energy_kwh');
  const heat = await db.prepare('SELECT slot_start, heat_output_kwh, cop, heating_energy_kwh FROM site_heat_slot WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND heat_output_kwh IS NOT NULL').all(site.id, W0, W1);
  assert.ok(heat.length > 20);
  let compared = 0;
  for (const h of heat) {
    if (!out.has(Number(h.slot_start))) continue;
    compared++;
    assert.ok(Math.abs(out.get(Number(h.slot_start)) - h.heat_output_kwh) < 1e-6, `heat out of slot ${h.slot_start}: ${out.get(Number(h.slot_start))} against ${h.heat_output_kwh}`);
    if (inn.has(Number(h.slot_start)) && h.cop != null) assert.ok(Math.abs(out.get(Number(h.slot_start)) / inn.get(Number(h.slot_start)) - h.cop) < 1e-6, 'the same COP');
  }
  assert.ok(compared > 10, `${compared} slots compared`);
});

await test('the room and the system have their lines of temperature, state of heating and cost-free consumption', async () => {
  const living = Number((await db.prepare("SELECT id FROM thing WHERE home_id = ? AND name = 'Living room'").get(site.id)).id);
  assert.ok((await byMetric(living, 'temperature_c')).size > 10, 'the living room has the temperature its sensor reports');
  const lines = new Set((await readNodeSlots(Number(await thing('heating')), W0, W1)).map((r) => r.metric));
  for (const m of ['heat_output_kwh', 'heat_pump_energy_kwh', 'cop']) assert.ok(lines.has(m), m);
});
