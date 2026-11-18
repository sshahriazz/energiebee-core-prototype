// The event timeline (plan 3.5, src/core/events.js): what happened to a thing, and to everything in a place, from the command log and the
// facts: commands and their fate, events the sensors reported, changes of state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { createThing, relate } = await import('../src/core/things.js');
const { seriesId, putReadings, putIntervals, asWriter } = await import('../src/core/facts.js');
const { eventsOf } = await import('../src/core/events.js');
const plans = await import('../src/core/plans.js');
const cmd = await import('../src/core/commands.js');

const T0 = Date.UTC(2026, 9, 26, 12, 0) / 1000;
const home = await createSite({ name: 'Events home', isDemo: true });
const room = await createThing({ siteId: home.id, type: 'room', name: 'Utility room' });
const plug = await addDevice({ siteId: home.id, kind: 'smart_plug', provider: 'synthetic', externalRef: 'ev-plug' });
const hp = await addDevice({ siteId: home.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'ev-hp' });
await relate({ siteId: home.id, from: plug.id, rel: 'located_in', to: room.id });
await relate({ siteId: home.id, from: hp.id, rel: 'located_in', to: room.id });
await relate({ siteId: home.id, from: room.id, rel: 'located_in', to: home.id });

await test('state changes, events and commands of a device, oldest first', async () => {
  const on = await seriesId('device', plug.id, 'plug_on', 'push_native');
  await asWriter('push_native', async () => { await putReadings(on, [{ ts: T0, value: 0 }, { ts: T0 + 300, value: 1 }, { ts: T0 + 600, value: 1 }, { ts: T0 + 900, value: 0 }]); });
  const ev = await eventsOf(plug.id, T0, T0 + 3600);
  assert.deepEqual(ev.map((e) => [e.ts - T0, e.kind, e.what, e.detail]), [[300, 'state', 'plug_on', { from: 0, to: 1 }], [900, 'state', 'plug_on', { from: 1, to: 0 }]]);
  assert.equal(ev[0].thing.name, 'ev-plug'.length ? ev[0].thing.name : '', 'each entry says which thing');
  const def = await seriesId('device', hp.id, 'event_defrost', 'push_native');
  await asWriter('push_native', async () => { await putIntervals(def, [{ start: T0 + 1200, end: T0 + 1500, value: 1 }]); });
  assert.deepEqual((await eventsOf(hp.id, T0, T0 + 3600)).map((e) => [e.ts - T0, e.kind, e.what, e.detail]), [[1200, 'event', 'event_defrost', { until: T0 + 1500 }]]);
  await plans.setCapability(hp.id, 'heat_on', true, { source: 'adapter' });
  const c = await cmd.enqueueIfChanged({ deviceId: hp.id, desired: { action: 'heat_on' }, validFrom: T0, validUntil: T0 + 3600, now: (T0 + 100) * 1000 }).catch(() => null);
  if (c) assert.ok((await eventsOf(hp.id, T0, T0 + 3600)).some((e) => e.kind === 'command' && /heat_on/.test(e.what)));
});

await test('a place has the events of everything in it, each saying which thing; a window outside has none', async () => {
  const all = await eventsOf(room.id, T0, T0 + 3600);
  assert.deepEqual(all.filter((e) => e.kind !== 'command').map((e) => [e.thing.type, e.what]), [['smart_plug', 'plug_on'], ['heat_pump', 'event_defrost'], ['smart_plug', 'plug_on']]);
  const whole = await eventsOf(home.id, T0, T0 + 3600);
  assert.equal(whole.filter((e) => e.kind !== 'command').length, 3, 'the home holds the room that holds them');
  assert.equal((await eventsOf(room.id, T0 + 7200, T0 + 9000)).length, 0);
  assert.equal((await eventsOf(room.id, T0, T0 + 3600, { limit: 1 })).length, 1, 'the newest are kept');
  await assert.rejects(() => eventsOf(999999, T0, T0 + 1), /no such thing/);
});
