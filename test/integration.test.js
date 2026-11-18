// Integration contract v2 (plan 2.4): an integration reports devices and readings by the provider's own names, the core resolves
// them through links and point bindings, and a new integration needs no schema change. A fake integration, in a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { discoverDevices, ingestByRef } = await import('../src/core/integration.js');
const { thingByRef } = await import('../src/core/links.js');
const { checkDiscovered, checkObservations } = await import('../src/adapters/discovery-contract.js');

const NOW = 1_800_000_000;
await db.prepare("INSERT INTO source (code, name, contract) VALUES ('fake_hub', 'A fake hub (test)', '{}')").run();

await test('the contract: a good report passes, every way it can be wrong is named', () => {
  assert.deepEqual(checkDiscovered([{ externalRef: 'a1', kind: 'temperature_sensor', points: [{ point: 't', metric: 'indoor_temp_c' }] }]), []);
  const errs = checkDiscovered([{ externalRef: '', kind: 'Bad Kind' }, { externalRef: 'x', kind: 'plug', points: [{ point: 'p', metric: 'm', part: 'sideways', scale: 'big' }] }, { externalRef: 'x', kind: 'plug' }]);
  assert.ok(errs.some((e) => /externalRef is the provider/.test(e)) && errs.some((e) => /kind is a device kind/.test(e)) && errs.some((e) => /part is one of/.test(e))
    && errs.some((e) => /scale is a number/.test(e)) && errs.some((e) => /appears twice/.test(e)), errs.join('\n'));
  assert.deepEqual(checkObservations([{ externalRef: 'a', point: 'p', ts: NOW, value: 1 }, { externalRef: 'a', point: 'p', start: NOW, end: NOW + 300, value: 2 }, { externalRef: 'a', kind: 'ack' }]), []);
  assert.equal(checkObservations([{ externalRef: 'a', point: 'p', ts: NOW * 1000, value: 1 }, { point: 'p' }, { externalRef: 'a', point: 'p', ts: NOW, value: 'hot' }]).length, 3);
});

await test('discovery makes a device, its link and its points once; twice makes nothing new', async () => {
  const home = await createSite({ name: 'Fake hub home' });
  const report = [
    { externalRef: 'sensor-1', kind: 'temperature_sensor', label: 'Hall sensor', points: [{ point: 'humidity', metric: 'humidity_pct' }] },
    { externalRef: 'mystery-9', kind: 'a_kind_nobody_registered', label: 'Mystery' },
  ];
  const first = await discoverDevices({ siteId: home.id, provider: 'fake_hub', source: 'fake_hub', devices: report });
  assert.deepEqual([first.created, first.found], [2, 0]);
  assert.ok(first.bindings >= 2, 'the kind\'s own point and the listed one');
  const things = await db.prepare("SELECT t.type, t.name FROM thing t WHERE t.home_id = ? AND t.kind = 'device' ORDER BY t.id").all(home.id);
  assert.deepEqual(things, [{ type: 'temperature_sensor', name: 'Hall sensor' }, { type: 'generic_device', name: 'Mystery' }], 'a kind with no row is a generic device');
  assert.equal(await thingByRef(home.id, 'fake_hub', 'sensor-1'), first.devices[0].thingId);
  const count = async () => ({
    things: (await db.prepare('SELECT COUNT(*) AS n FROM thing WHERE home_id = ?').get(home.id)).n,
    links: (await db.prepare('SELECT COUNT(*) AS n FROM thing_link WHERE home_id = ?').get(home.id)).n,
    bindings: (await db.prepare('SELECT COUNT(*) AS n FROM point_binding WHERE site_id = ?').get(home.id)).n,
    points: (await db.prepare('SELECT COUNT(*) AS n FROM point WHERE home_id = ?').get(home.id)).n,
  });
  const before = await count();
  const again = await discoverDevices({ siteId: home.id, provider: 'fake_hub', source: 'fake_hub', devices: report });
  assert.deepEqual([again.created, again.found, again.bindings], [0, 2, 0]);
  assert.deepEqual(await count(), before, 'nothing new: no thing, link, binding or point');
  await assert.rejects(() => discoverDevices({ siteId: home.id, provider: 'fake_hub', source: 'fake_hub', devices: [{ externalRef: '', kind: 'x' }] }), /discovery report/);
});

await test('readings by the provider\'s name land on the point of the thing its link names; an unknown name is reported, not guessed', async () => {
  const home = await createSite({ name: 'Fake hub home 2' });
  const { devices } = await discoverDevices({ siteId: home.id, provider: 'fake_hub', source: 'fake_hub',
    devices: [{ externalRef: 'sensor-7', kind: 'temperature_sensor', points: [{ point: 'humidity', metric: 'humidity_pct' }] }] });
  const thing = devices[0].thingId;
  const r = await ingestByRef(home.id, { provider: 'fake_hub', source: 'fake_hub', now: NOW + 10, observations: [
    { externalRef: 'sensor-7', point: 'temperature', ts: NOW, value: 21.5 }, { externalRef: 'sensor-7', point: 'humidity', ts: NOW, value: 48 },
    { externalRef: 'sensor-7', point: 'mystery_field', ts: NOW, value: 1 }, { externalRef: 'ghost-1', point: 'temperature', ts: NOW, value: 5 }] });
  assert.equal(r.written, 2);
  assert.deepEqual(r.unknown, ['ghost-1']);
  const stored = await db.prepare(`SELECT m.code AS metric, r.value, p.thing_id FROM reading r JOIN series se ON se.id = r.series_id JOIN point p ON p.id = se.point_id
    JOIN metric m ON m.id = se.metric_id WHERE se.site_id = ? ORDER BY m.code`).all(home.id);
  assert.deepEqual(stored.map((s) => [s.metric, s.value, Number(s.thing_id)]), [['humidity_pct', 48, thing], ['indoor_temp_c', 21.5, thing]], 'on the thing the link names');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM channel_reject WHERE site_id = ? AND point = 'mystery_field' AND reason = 'unmapped_point'").get(home.id)).n, 1, 'an unmapped field is rejected with its reason');
});
