// Derived points evaluated into point slots (plan 2.8): home use by energy balance, untracked consumption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const F = await import('../src/core/facts.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { buildHomePointSlots, readPointSlots } = await import('../src/core/point-slots.js');
const { dayBounds } = await import('../src/core/time.js');

const T0 = Date.UTC(2026, 8, 14) / 1000; const DAY = '2026-09-16'; const [D0] = dayBounds('Europe/London', DAY);
const h = Number((await db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Derived', ?, 'GB', 'GB', 'GBP')").run(T0)).lastInsertRowid);
const meter = await addDevice({ siteId: h, kind: 'meter_import', provider: 'push', externalRef: 'm-d', recordedAt: (T0 + 3600) * 1000 });
const plug = await addDevice({ siteId: h, kind: 'smart_plug', provider: 'push', externalRef: 'p-d', recordedAt: (T0 + 3600) * 1000 });
const half = (i) => ({ start: D0 + i * 1800, end: D0 + (i + 1) * 1800 });

await test('home use and untracked consumption are worked out per slot from the home\'s points, with their lineage', async () => {
  const imp = await F.seriesId('device', meter.id, 'grid_import_kwh', 'octopus_meter'); const pl = await F.seriesId('device', plug.id, 'plug_kwh', 'push_native');
  await F.asWriter('octopus_meter', async () => { await F.putIntervals(imp, Array.from({ length: 4 }, (_, i) => ({ ...half(i), value: 1.0 }))); });
  await F.asWriter('push_native', async () => { await F.putIntervals(pl, Array.from({ length: 4 }, (_, i) => ({ ...half(i), value: i < 2 ? 0.3 : 1.5 }))); });
  const r = await buildHomePointSlots(h, DAY, DAY);
  assert.ok(r.derived > 0, 'derived slots were written');
  const point = async (key) => Number((await db.prepare('SELECT id FROM point WHERE thing_id = ? AND key = ?').get(h, key)).id);
  const use = await readPointSlots(await point('derived_home_use_kwh'), D0, D0 + 86400);
  assert.deepEqual(use.map((s) => s.delta), [1, 1, 1, 1], 'import only: the home used what came in');
  assert.deepEqual(use[0].lineage.inputs.find((x) => x.name === 'grid_import'), { name: 'grid_import', from: 'grid_import_kwh', value: 1 }, 'the lineage names the input and its value');
  const untracked = await readPointSlots(await point('derived_untracked_kwh'), D0, D0 + 86400);
  assert.deepEqual(untracked.map((s) => Math.round(s.delta * 100) / 100), [0.7, 0.7, 0, 0], 'untracked is what no device accounts for, never negative');
});

await test('a slot with a missing required input has no derived row, and a rebuild gives the same rows', async () => {
  const before = await db.prepare("SELECT COUNT(*) n FROM point_slot s JOIN point p ON p.id = s.point_id WHERE p.thing_id = ? AND p.key LIKE 'derived\\_%'").get(h);
  await buildHomePointSlots(h, DAY, DAY);
  const after = await db.prepare("SELECT COUNT(*) n FROM point_slot s JOIN point p ON p.id = s.point_id WHERE p.thing_id = ? AND p.key LIKE 'derived\\_%'").get(h);
  assert.equal(after.n, before.n);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM point_slot s JOIN point p ON p.id = s.point_id WHERE p.thing_id = ? AND p.key = 'derived_heatpump_cop'").get(h)).n, 0, 'no heat pump: no COP');
});
