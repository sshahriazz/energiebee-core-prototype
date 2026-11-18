// A home's own series move onto the plant things of its energy graph (plan 2.5): the PV's power to the PV array, the charge level to
// the battery, what crosses the meter to the grid connection. The series keep their ids and their facts, and the pages and the build
// still find them by the home (series.subject_kind and subject_id are derived from the point).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
const { db } = await import('../src/db/db.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');
const { seriesId } = await import('../src/core/facts.js');
const { plantThing } = await import('../src/core/points.js');
const { createThing } = await import('../src/core/things.js');
const { createSite } = await import('../src/core/sites.js');

const where = async (metric, home = 1) => (await db.prepare(`SELECT DISTINCT t.type, s.subject_kind, s.subject_id FROM series s JOIN point p ON p.id = s.point_id JOIN thing t ON t.id = p.thing_id
  JOIN metric m ON m.id = s.metric_id WHERE s.site_id = ? AND m.code = ? ORDER BY 1`).all(home, metric));

await test('before the graph a home\'s series are on its home thing; after it, on the plant things, with their facts and ids', { skip }, async () => {
  assert.deepEqual((await where('solar_w')).map((r) => r.type), ['house']);
  const ids = (await db.prepare("SELECT s.id FROM series s JOIN metric m ON m.id = s.metric_id WHERE s.site_id = 1 AND m.code IN ('solar_w', 'battery_soc_pct', 'grid_import_w', 'load_w') ORDER BY s.id").all()).map((r) => r.id);
  const facts = async () => (await db.prepare('SELECT (SELECT COUNT(*) FROM reading) AS r, (SELECT COUNT(*) FROM interval_fact) AS i').get());
  const before = await facts();
  await ensureEnergyGraph(1);
  assert.deepEqual(await facts(), before, 'no fact moved or was made');
  assert.deepEqual((await db.prepare("SELECT s.id FROM series s JOIN metric m ON m.id = s.metric_id WHERE s.site_id = 1 AND m.code IN ('solar_w', 'battery_soc_pct', 'grid_import_w', 'load_w') ORDER BY s.id").all()).map((r) => r.id), ids, 'the same series');
  for (const [metric, type] of [['solar_w', 'pv_array'], ['solar_kwh', 'pv_array'], ['battery_soc_pct', 'battery'], ['battery_charge_w', 'battery'], ['grid_import_w', 'grid_connection'], ['grid_export_kwh', 'grid_connection'], ['load_w', 'home_supply']]) {
    const rows = await where(metric);
    if (!rows.length) continue;
    assert.ok(rows.every((r) => r.type === type), `${metric} is on the ${type}: ${JSON.stringify(rows)}`);
    assert.ok(rows.every((r) => r.subject_kind === 'site' && r.subject_id === '1'), `${metric} is still the home's by its subject`);
  }
  assert.ok((await where('ghi_wm2')).every((r) => r.type === 'house'), 'weather stays with the home');
  assert.deepEqual((await where('ev_charge_kwh')).map((r) => r.type).filter((t) => t !== 'house'), [], 'the car stays with the home');
});

await test('running again moves nothing; a series made afterwards lands on the plant thing; bindings follow', { skip }, async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM point').get());
  await ensureEnergyGraph(1);
  assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM point').get(), before);
  const id = await seriesId('site', 1, 'solar_w', 'a_new_source');
  assert.equal((await db.prepare('SELECT t.type FROM series s JOIN point p ON p.id = s.point_id JOIN thing t ON t.id = p.thing_id WHERE s.id = ?').get(id)).type, 'pv_array');
  const orphans = await db.prepare(`SELECT COUNT(*) AS n FROM point_binding b JOIN point p ON p.id = b.point_id WHERE b.site_id = 1 AND b.device_id IS NULL AND p.thing_id = 1 AND p.superseded_at IS NULL
    AND EXISTS (SELECT 1 FROM metric m WHERE m.id = b.metric_id AND m.domain IN ('solar', 'battery', 'grid', 'home') AND m.code NOT LIKE 'event\\_%')`).get();
  assert.equal(orphans.n, 0, 'no plant binding is left on the home thing');
});

await test('two arrays, or a plant thing with an integration behind it: the series stay with the home', async () => {
  const home = await createSite({ name: 'Two arrays' });
  await createThing({ siteId: home.id, type: 'pv_array', name: 'North' });
  assert.equal(await plantThing(home.id, 'solar_w'), (await db.prepare("SELECT id FROM thing WHERE home_id = ? AND type = 'pv_array'").get(home.id)).id, 'one array carries it');
  await createThing({ siteId: home.id, type: 'pv_array', name: 'South' });
  assert.equal(await plantThing(home.id, 'solar_w'), null, 'two arrays: which one? none');
  const id = await seriesId('site', home.id, 'solar_w', 'sunsynk_5min');
  assert.equal((await db.prepare('SELECT t.type FROM series s JOIN point p ON p.id = s.point_id JOIN thing t ON t.id = p.thing_id WHERE s.id = ?').get(id)).type, 'house');
  const other = await createSite({ name: 'Real battery' });
  await db.prepare("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'battery', 'octopus', 'b1')").run(other.id);
  assert.equal(await plantThing(other.id, 'battery_soc_pct'), null, 'a battery with an integration behind it is a device, not the plant');
});
