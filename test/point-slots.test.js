// A point's timeline (plan 3.1, src/core/point-slots.js): rows by the point's class on the home's grid, the best-covering source per slot,
// idempotent rebuilds, and the 23- and 25-hour days. A temp database; facts written through the fact writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { seriesId, putReadings, putIntervals, asWriter } = await import('../src/core/facts.js');
const { buildPointSlots, buildHomePointSlots, readPointSlots } = await import('../src/core/point-slots.js');
const { pointOf } = await import('../src/core/points.js');
const { dayBounds } = await import('../src/core/time.js');

const home = await createSite({ name: 'Slot home', timezone: 'Europe/London', country: 'GB' });
const DAY = '2026-06-10';
const [D0] = dayBounds('Europe/London', DAY);
const bat = await addDevice({ siteId: home.id, kind: 'battery', provider: 'test', externalRef: 'slot-bat' });
const meter = await addDevice({ siteId: home.id, kind: 'meter_import', provider: 'test', externalRef: 'slot-meter' });
const slotsOf = async (thing, metric) => await readPointSlots(await pointOf(thing, metric), D0, D0 + 86400);

await test('a measurement point: the mean over a slot from 5-minute samples, with the coverage of what was sampled', async () => {
  const s = await seriesId('device', bat.id, 'battery_soc_pct', 'sunsynk_5min');
  const rows = [];
  for (let t = D0; t < D0 + 3600; t += 300) rows.push({ ts: t, value: 50 + (t - D0) / 300 });   // 50, 51, ... 61: two slots
  await asWriter('sunsynk_5min', async () => { await putReadings(s, rows); });
  const r = await buildPointSlots(await pointOf(bat.id, 'battery_soc_pct'), DAY, DAY);
  assert.equal(r.slots, 2 + 0, 'the hour sampled makes two half-hour slots');
  const [a, b] = await slotsOf(bat.id, 'battery_soc_pct');
  assert.deepEqual([a.slot_start, a.dur_s, a.coverage, a.min, a.max, a.last], [D0, 1800, 1, 50, 55, 55]);
  assert.equal(a.mean, 52.5);
  assert.deepEqual(b.lineage, { series: s, source: 'sunsynk_5min', sources: 1 });
  assert.equal(b.method_version, 1);
});

await test('a total point: the amount in each slot from meter periods; a day with no data writes nothing', async () => {
  const s = await seriesId('device', meter.id, 'grid_import_kwh', 'octopus_meter');
  await asWriter('octopus_meter', async () => { await putIntervals(s, [{ start: D0, end: D0 + 1800, value: 0.4 }, { start: D0 + 1800, end: D0 + 3600, value: 0.6 }]); });
  await buildPointSlots(await pointOf(meter.id, 'grid_import_kwh'), DAY, DAY);
  assert.deepEqual((await slotsOf(meter.id, 'grid_import_kwh')).map((r) => [r.delta, r.coverage]), [[0.4, 1], [0.6, 1]]);
  const empty = await buildPointSlots(await pointOf(meter.id, 'grid_import_kwh'), '2026-06-11', '2026-06-11');
  assert.equal(empty.slots, 0);
});

await test('two sources for one point: each slot takes the one that covers it best', async () => {
  const live = await seriesId('device', bat.id, 'battery_soc_pct', 'sunsynk_live');
  await asWriter('sunsynk_live', async () => { await putReadings(live, [{ ts: D0 + 5400, value: 70 }, { ts: D0 + 5500, value: 71 }, { ts: D0 + 5700, value: 72 }, { ts: D0 + 5900, value: 73 }]); });
  await buildPointSlots(await pointOf(bat.id, 'battery_soc_pct'), DAY, DAY);
  const rows = await slotsOf(bat.id, 'battery_soc_pct');
  assert.equal(rows.find((r) => r.slot_start === D0 + 5400).lineage.source, 'sunsynk_live', 'the only source with data in that slot');
  assert.equal(rows.find((r) => r.slot_start === D0).lineage.source, 'sunsynk_5min');
  assert.equal(rows.find((r) => r.slot_start === D0).lineage.sources, 2);
});

await test('a rebuild gives the same rows, and the rows of a day are replaced, not added to', async () => {
  const id = await pointOf(bat.id, 'battery_soc_pct');
  const before = await readPointSlots(id, D0, D0 + 86400);
  await buildPointSlots(id, DAY, DAY, { builtAt: 1 });
  const after = await readPointSlots(id, D0, D0 + 86400);
  assert.deepEqual(after.map(({ slot_start, mean, coverage }) => [slot_start, mean, coverage]), before.map(({ slot_start, mean, coverage }) => [slot_start, mean, coverage]));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM point_slot WHERE point_id = ?').get(id)).n, before.length);
});

await test('the clock-change days have 46 and 50 half-hour slots, and a home builds all its points', async () => {
  const spring = '2026-03-29'; const autumn = '2026-10-25';
  const s = await seriesId('device', bat.id, 'battery_charge_w', 'sunsynk_5min');
  const rows = [];
  for (const day of [spring, autumn]) { const [a, b] = dayBounds('Europe/London', day); for (let t = a; t < b; t += 1800) rows.push({ ts: t, value: 100 }); }
  await asWriter('sunsynk_5min', async () => { await putReadings(s, rows); });
  const id = await pointOf(bat.id, 'battery_charge_w');
  assert.equal((await buildPointSlots(id, spring, spring)).slots, 46);
  assert.equal((await buildPointSlots(id, autumn, autumn)).slots, 50);
  const all = await buildHomePointSlots(home.id, DAY, DAY);
  assert.ok(all.points >= 3 && all.slots >= 4);
});
