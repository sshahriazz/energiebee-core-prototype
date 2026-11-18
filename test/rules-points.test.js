// The rules of capabilities, points and the series on them (plan 2.1 and 2.2), broken on purpose and refused (fix list D1). See
// test/rules/lib.js for how an area proves its rules and declares them in test/rules/points.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, checkDeclared } = await harness('points');
const { seriesId } = await import('../src/core/facts.js');
const { pointOf, pointsOf, regionThing } = await import('../src/core/points.js');

const NOW = 1_800_000_000;
const site = (name) => ins('INSERT INTO site (name, created_at) VALUES (?, ?)', name, NOW);
const device = (siteId, kind, ref) => ins("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, ?, 'test', ?)", siteId, kind, ref);
const metric = async (code) => (await get('SELECT id FROM metric WHERE code = ?', code)).id;

await test('a point is on a thing, in the thing\'s home; what it is never changes', async () => {
  const a = await site('Points A'); const b = await site('Points B');
  const bat = await device(a, 'battery', 'p-bat');
  const m = await metric('battery_soc_pct');
  const p = await ins('INSERT INTO point (thing_id, key, metric_id, class) VALUES (?, ?, ?, ?)', bat, 'soc', m, 'measurement');
  assert.equal((await get('SELECT home_id FROM point WHERE id = ?', p)).home_id, a, 'a point takes its thing\'s home');
  maintained('point_home_matches');
  await refused('point_home_matches', 'INSERT INTO point (home_id, thing_id, key, metric_id, class) VALUES (?, ?, ?, ?, ?)', b, bat, 'other', m, 'measurement');
  await refused('point_home_matches', 'UPDATE point SET home_id = ? WHERE id = ?', b, p);
  await refused('point_identity_fixed', "UPDATE point SET key = 'level' WHERE id = ?", p);
  await refused('point_identity_fixed', 'UPDATE point SET thing_id = ? WHERE id = ?', await device(a, 'battery', 'p-bat2'), p);
  await refused('point_identity_fixed', 'UPDATE point SET metric_id = ? WHERE id = ?', await metric('battery_soc_kwh'), p);
  await refused('point_uid_fixed', "UPDATE point SET uid = '01900000-0000-7000-8000-0000000000aa' WHERE id = ?", p);
  await assert.rejects(() => run("INSERT INTO point (thing_id, key, metric_id, class) VALUES (?, 'soc', ?, 'measurement')", bat, m), /point_one_current|duplicate key/, 'one current point per key on a thing');
  await run("UPDATE point SET access = 'readwrite', capability = NULL WHERE id = ?", p);   // what a point allows may change
});

await test('a series follows its point: the home, and the subject the pages still name it by', async () => {
  const h = await site('Series home'); const other = await site('Series other');
  const bat = await device(h, 'battery', 's-bat');
  const homeSeries = await seriesId('site', h, 'load_w', 'sunsynk_5min');
  const devSeries = await seriesId('device', bat, 'battery_soc_pct', 'sunsynk_5min');
  const carbon = await seriesId('region', 'carbon:99', 'carbon_intensity', 'carbon_regional');
  const gas = await seriesId('region', 'ldz:ZZ', 'gas_cv_mjm3', 'national_gas_cv');
  const row = async (id) => get('SELECT s.subject_kind, s.subject_id, s.site_id, p.thing_id, t.kind, t.type FROM series s JOIN point p ON p.id = s.point_id JOIN thing t ON t.id = p.thing_id WHERE s.id = ?', id);
  assert.deepEqual(await row(homeSeries), { subject_kind: 'site', subject_id: String(h), site_id: h, thing_id: h, kind: 'home', type: 'house' });
  assert.deepEqual(await row(devSeries), { subject_kind: 'device', subject_id: String(bat), site_id: h, thing_id: bat, kind: 'device', type: 'battery' });
  const c = await row(carbon);
  assert.deepEqual([c.subject_kind, c.subject_id, c.site_id, c.kind, c.type], ['region', 'carbon:99', null, 'context', 'region']);
  assert.deepEqual([(await row(gas)).type, (await get('SELECT attrs FROM thing WHERE id = ?', (await row(gas)).thing_id)).attrs], ['gas_zone', { code: 'ZZ' }]);
  assert.equal(await seriesId('region', 'carbon:99', 'carbon_intensity', 'carbon_regional'), carbon, 'the same subject, metric and source is the same series');
  assert.equal(await regionThing('carbon:99'), c.thing_id, 'one thing per region');
  await assert.rejects(() => regionThing('nonsense'), /scheme:code/);
  // a point of a home thing is found again, and lists
  assert.equal(await pointOf(h, 'load_w'), (await get('SELECT point_id FROM series WHERE id = ?', homeSeries)).point_id);
  assert.deepEqual((await pointsOf(bat)).map((p) => [p.key, p.metric, p.class, p.access]), [['battery_soc_pct', 'battery_soc_pct', 'measurement', 'read']]);
  // the control metrics are settable points
  const ctl = await pointOf(h, 'ctl_reserve_pct');
  assert.deepEqual(await get('SELECT class, access FROM point WHERE id = ?', ctl), { class: 'setpoint', access: 'readwrite' });
  assert.equal(other > 0, true);
});

await test('a thing type names only capabilities that are registered', async () => {
  await refused('thing_type_capabilities_exist', "INSERT INTO thing_type (type, kind, label, capabilities) VALUES ('rules_points_type', 'device', 'Rules', '[\"no_such_capability\"]')");
  await run("INSERT INTO thing_type (type, kind, label, capabilities) VALUES ('rules_points_ok', 'device', 'Rules', '[\"power_meter\"]')");
});

await test('what the cases above proved is what test/rules/points.json declares', () => { checkDeclared(); });
