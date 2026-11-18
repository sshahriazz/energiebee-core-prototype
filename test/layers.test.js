// The layers above the facts (plan 3.2 and 3.7, src/core/layers.js, docs/build/timelines.md): a rebuild of a range builds the home's slots, then
// every point's, then every place's, over the same days; rows built by an older method are rebuilt; one day of home 1 is timed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
const { db } = await import('../src/db/db.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');
const { markDirty } = await import('../src/core/facts.js');
const { processQueue } = await import('../src/core/build.js');
const { buildLayers, staleDays } = await import('../src/core/layers.js');
const { dayBounds } = await import('../src/core/time.js');

const DAY = '2026-10-14';
const [D0, D1] = dayBounds('Europe/London', DAY);

await test('a rebuild of a range builds every layer over the same days, and says so', { skip }, async () => {
  await ensureEnergyGraph(1);
  await markDirty(1, D0, D1, 'layers test');
  const out = await processQueue({ siteId: 1 });
  assert.equal(out.length, 1);
  assert.ok(out[0].layers.pointSlots > 100 && out[0].layers.points > 10, JSON.stringify(out[0].layers));
  assert.ok(out[0].layers.nodeSlots > 0 && out[0].layers.nodes >= 4, 'the home, its two spaces and its system');
  const home = await db.prepare("SELECT COUNT(*) AS n FROM node_slot n JOIN thing t ON t.id = n.thing_id WHERE t.home_id = 1 AND t.kind = 'home' AND n.metric = 'home_kwh'").get();
  assert.ok(home.n > 40, 'the home\'s own use, slot by slot, from the layer below');
  assert.equal(await staleDays(1), null, 'nothing is out of date');
});

await test('rows of an older method are found and rebuilt with the next rebuild', { skip }, async () => {
  await db.prepare('UPDATE point_slot SET method_version = 0 WHERE slot_start >= ? AND slot_start < ?').run(D0, D0 + 3600);
  const stale = await staleDays(1);
  assert.deepEqual(stale, { from: DAY, to: DAY });
  await markDirty(1, D1, D1 + 1800, 'a later request');
  const out = await processQueue({ siteId: 1 });
  assert.equal(await staleDays(1), null, 'the old rows were rebuilt');
  assert.ok(out[0].layers.pointSlots > 0);
});

await test('one day of home 1: every layer is built in a time that is recorded here', { skip }, async () => {
  const t0 = Date.now();
  const r = await buildLayers(1, DAY, DAY);
  const ms = Date.now() - t0;
  console.log(`layers of one day of home 1: ${r.points} points, ${r.pointSlots} point slots, ${r.nodes} places, ${r.nodeSlots} place slots in ${ms} ms`);
  assert.ok(ms < 10_000, `${ms} ms for one day`);
});
