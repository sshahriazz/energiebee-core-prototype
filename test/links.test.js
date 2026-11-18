// Links (plan 2.3, src/core/links.js): a provider's name for a thing is found again, never made twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createThing } = await import('../src/core/things.js');
const L = await import('../src/core/links.js');

await test('a device with an integration behind it is found by its provider\'s name', async () => {
  const home = await createSite({ name: 'Link home' });
  const meter = await addDevice({ siteId: home.id, kind: 'meter_import', provider: 'octopus', externalRef: '1200012345678' });
  assert.equal(await L.thingByRef(home.id, 'octopus', '1200012345678'), meter.id);
  assert.equal(await L.thingByRef(home.id, 'octopus', 'other'), null);
  assert.equal((await L.linksOf(meter.id)).length, 1);
});

await test('ensureLink is idempotent, refuses a name that is another thing\'s, and a link can end', async () => {
  const home = await createSite({ name: 'Link home 2' });
  const plant = await createThing({ siteId: home.id, type: 'pv_array', name: 'Roof array' });
  const first = await L.ensureLink({ homeId: home.id, thingId: plant.id, provider: 'sunsynk', externalRef: 'SN-1001' });
  assert.equal(first.kind, 'cloud');
  const again = await L.ensureLink({ homeId: home.id, thingId: plant.id, provider: 'sunsynk', externalRef: 'SN-1001' });
  assert.equal(again.id, first.id, 'the same name for the same thing is the link it has');
  const other = await createThing({ siteId: home.id, type: 'pv_array', name: 'Garage array' });
  await assert.rejects(() => L.ensureLink({ homeId: home.id, thingId: other.id, provider: 'sunsynk', externalRef: 'SN-1001' }), /already linked/);
  await assert.rejects(() => L.ensureLink({ homeId: home.id, thingId: other.id, provider: '', externalRef: 'x' }), /needs a provider/);
  assert.equal(await L.thingByRef(home.id, 'sunsynk', 'SN-1001'), plant.id);
  const ended = await L.endLink(first.id, Math.floor(Date.now() / 1000) + 10);
  assert.ok(ended.valid_to > 0);
  assert.equal(await L.thingByRef(home.id, 'sunsynk', 'SN-1001'), null, 'an ended link names nothing');
  const moved = await L.ensureLink({ homeId: home.id, thingId: other.id, provider: 'sunsynk', externalRef: 'SN-1001' });
  assert.notEqual(moved.id, first.id, 'the name can be linked to another thing once the first link has ended');
  assert.equal((await L.linksOf(plant.id)).length, 1, 'history is kept');
});
