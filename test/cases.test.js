// The real-world case catalogue (fix list C1, docs/thing-platform-design-review.md): twenty-two things that happen in homes, each a test on the
// platform. A case whose part of the design is not built is a todo with the reason, never a pass: it shows in every run until it is built.
// The facts sit on a fixed past day (the clocks of 2026 on the London calendar); the home started a few days before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { addDevice, createTariff, putRateRows, agreeTariff } = await import('../src/core/tariffs.js');
const T = await import('../src/core/things.js');
const F = await import('../src/core/facts.js');
const { pointOf } = await import('../src/core/points.js');
const { buildPointSlots, buildHomePointSlots, readPointSlots } = await import('../src/core/point-slots.js');
const { buildNodeSlots, buildHomeNodeSlots, readNodeSlots, untracked } = await import('../src/core/node-slots.js');
const { buildLayers } = await import('../src/core/layers.js');
const { dayBounds } = await import('../src/core/time.js');
const C = await import('../src/core/controls.js');
const plans = await import('../src/core/plans.js');
const { topologyOf } = await import('../src/core/topology.js');
const { channelsFor, ingestObservations, defineChannel } = await import('../src/core/channels.js');
const { loadPricing } = await import('../src/core/pricing.js');
const { slotPrice, unitInc } = await import('../src/core/slot-price.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { setSlotLength } = await import('../src/core/sites.js');

const T0 = Date.UTC(2026, 8, 14) / 1000;                 // 14 September 2026: the homes began here
const DAY = '2026-09-16';
const [D0] = dayBounds('Europe/London', DAY);              // local midnight (BST): 23:00 UTC the day before
let nHome = 0;
const home = async (name) => Number((await db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES (?, ?, 'GB', 'GB', 'GBP')").run(`${name} ${++nHome}`, T0)).lastInsertRowid);
const device = async (siteId, kind, ref, label = null) => await addDevice({ siteId, kind, provider: 'push', externalRef: ref, label, recordedAt: (T0 + 3600) * 1000 });
const place = async (siteId, id, to, required = 1) => await T.relate({ siteId, from: id, rel: 'located_in', to, at: T0 + 86400, required });
const space = async (siteId, type, name) => { const s = await T.createThing({ siteId, type, name, validFrom: T0 + 3600 }); await place(siteId, s.id, siteId); return s; };
const write = async (source, fn) => await F.asWriter(source, fn);
const series = async (kind, id, metric, source) => await F.seriesId(kind, id, metric, source);
const inSlot = async (thing, metric, day = DAY) => await readPointSlots(await pointOf(thing, metric), dayBounds('Europe/London', day)[0], dayBounds('Europe/London', day)[1]);

await test('case 1: the inverter is replaced by another brand: the swap is a new thing in the same place, the old timeline ends, the home\'s does not break', async () => {
  const h = await home('Swap');
  const old = await device(h, 'inverter', 'inv-old', 'Old inverter'); await place(h, old.id, h);
  const noon = D0 + 12 * 3600;
  const oldS = await series('device', old.id, 'load_w', 'sunsynk_5min'); const homeS = await series('site', h, 'outdoor_temp_c', 'open_meteo');
  await write('sunsynk_5min', async () => { await F.putReadings(oldS, Array.from({ length: 12 }, (_, i) => ({ ts: D0 + 6 * 3600 + i * 1800, value: 300 }))); });
  await write('open_meteo', async () => { await F.putReadings(homeS, Array.from({ length: 40 }, (_, i) => ({ ts: D0 + 4 * 3600 + i * 1800, value: 200 }))); });
  const swap = await T.replaceThing(old.id, { siteId: h, name: 'New inverter', reason: 'case 1', at: noon });
  assert.equal(swap.old.valid_to, swap.boundary, 'the old inverter\'s life ends at the swap');
  assert.equal(swap.thing.valid_from, swap.boundary, 'the new one begins at it');
  const where = await T.relationsAt(h, { rels: ['located_in', 'replaces'], at: swap.boundary + 1800 });
  assert.ok(where.some((r) => r.rel === 'located_in' && Number(r.from_id) === swap.thing.id && Number(r.to_id) === h), 'the new inverter is in the same place');
  assert.ok(where.some((r) => r.rel === 'replaces' && Number(r.from_id) === swap.thing.id && Number(r.to_id) === old.id));
  const newS = await series('device', swap.thing.id, 'load_w', 'sunsynk_5min');
  await write('sunsynk_5min', async () => { await F.putReadings(newS, Array.from({ length: 12 }, (_, i) => ({ ts: swap.boundary + i * 1800, value: 400 }))); });
  await buildHomePointSlots(h, DAY, DAY);
  const before = await inSlot(old.id, 'load_w'); const after = await inSlot(swap.thing.id, 'load_w'); const homeSlots = await inSlot(h, 'outdoor_temp_c');
  assert.ok(before.length && before.every((s) => s.slot_start < swap.boundary), 'the old inverter\'s timeline stops at the swap');
  assert.ok(after.length && after.every((s) => s.slot_start >= swap.boundary), 'the new one\'s begins there');
  assert.ok(homeSlots.some((s) => s.slot_start < swap.boundary) && homeSlots.some((s) => s.slot_start >= swap.boundary), 'the home\'s own timeline runs through the day of the swap');
});

await test('case 2: a Zigbee valve is reset and re-pairs with a new id: merged, one thing with one timeline, no double counting in the room', async () => {
  const h = await home('Repair'); const room = await space(h, 'room', 'Bedroom');
  const a = await device(h, 'trv', 'trv-old'); const b = await device(h, 'trv', 'trv-new');
  await place(h, a.id, room.id); await place(h, b.id, room.id);
  const sa = await series('device', a.id, 'indoor_temp_c', 'push_native'); const sb = await series('device', b.id, 'indoor_temp_c', 'push_native');
  await write('push_native', async () => {
    await F.putReadings(sa, Array.from({ length: 6 }, (_, i) => ({ ts: D0 + 6 * 3600 + i * 600, value: 18 })));
    await F.putReadings(sb, Array.from({ length: 6 }, (_, i) => ({ ts: D0 + 14 * 3600 + i * 600, value: 21 })));
  });
  const merged = await T.mergeThings(b.id, a.id, { siteId: h, reason: 'case 2: the same valve, re-paired' });
  assert.equal(merged.dropped.merged_into, b.id);
  await buildHomePointSlots(h, DAY, DAY); await buildNodeSlots(room.id, DAY, DAY);
  const line = await inSlot(b.id, 'indoor_temp_c');
  assert.ok(line.some((s) => s.mean === 18) && line.some((s) => s.mean === 21), 'one timeline holds what both said');
  const roomT = (await readNodeSlots(room.id, D0, D0 + 86400, ['temperature_c'])).map((r) => r.value);
  assert.ok(roomT.includes(18) && roomT.includes(21) && !roomT.some((v) => v === 19.5), 'the room reads one valve, never the mean of two');
});

await test('case 3: the hub is offline for two days: the late facts land in the right slots, and as known at the outage the gap is still there', async () => {
  const h = await home('Offline'); const t = await device(h, 'temperature_sensor', 'hub-sensor');
  const s = await series('device', t.id, 'indoor_temp_c', 'push_native');
  const outageKnown = Date.now() - 5;
  await new Promise((r) => setTimeout(r, 10));
  await write('push_native', async () => { await F.putReadings(s, Array.from({ length: 6 }, (_, i) => ({ ts: D0 + 3600 * (3 + i), value: 20 + i }))); });   // two days late
  await buildPointSlots(await pointOf(t.id, 'indoor_temp_c'), DAY, DAY);
  const slots = await inSlot(t.id, 'indoor_temp_c');
  assert.deepEqual(slots.map((x) => x.slot_start), Array.from({ length: 6 }, (_, i) => D0 + 3600 * (3 + i)), 'each reading in the slot of the time it was true, not the day it arrived');
  assert.equal((await F.withKnownAt(outageKnown, async () => await F.readReadings([s], D0, D0 + 86400))).length, 0, 'as known during the outage: nothing, the gap');
  assert.equal((await F.readReadings([s], D0, D0 + 86400)).length, 6);
});

await test('case 4: the owner changes the battery reserve in the inverter\'s own app: a manual request that is not reverted before it expires, and the owner can see it', async () => {
  const h = await home('Reserve'); const bat = await device(h, 'battery', 'bat-4'); await place(h, bat.id, h);
  for (const a of ['charge', 'demand']) await plans.setCapability(bat.id, a, true, { source: 'adapter' });
  const now = Date.now(); const at = Math.floor(now / 1000);
  const optimiser = await C.submitRequest({ thingId: bat.id, capability: 'battery_storage', action: 'charge', priority: 'optimiser', validFrom: at - 60, validUntil: at + 7200, source: 'optimiser', now });
  const external = await C.recordExternalChange({ thingId: bat.id, capability: 'battery_storage', action: 'demand', forS: 1800, now });
  const during = await C.settle(bat.id, 'battery_storage', { now: now + 60_000 });
  assert.deepEqual([during.winner.id, during.external, during.written], [external.id, true, false], 'the optimiser does not revert it');
  const after = await C.settle(bat.id, 'battery_storage', { now: now + 1900_000 });
  assert.equal(after.winner.id, optimiser.id, 'after its expiry the optimiser acts again');
  const owner = await createUser({ name: 'Owner 4', role: 'owner' }); await giveHome(owner.id, h);
  const uid = (await db.prepare('SELECT uid FROM thing WHERE id = ?').get(bat.id)).uid;
  const server = app.listen(0); server.unref();
  const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/things/${uid}/controls`, { headers: { 'x-user-id': String(owner.id) } })).json();
  assert.ok(r.requests.some((q) => q.external === true && q.priority === 'manual'), 'the owner is shown the change made elsewhere');
});

await test('case 5: Intelligent Octopus charges the car at night: an external controller takes no schedule or optimiser request (its off-peak pricing is in the price-run tests)', async () => {
  const h = await home('Car'); const ev = await device(h, 'ev_charger', 'evc-5'); await place(h, ev.id, h);
  await T.updateThing(ev.id, { siteId: h, attrs: { external_controller: 'Octopus Intelligent Go' } });
  await assert.rejects(() => C.submitRequest({ thingId: ev.id, capability: 'ev_charging', action: 'boost', priority: 'optimiser', validFrom: T0, validUntil: T0 + 600, source: 'optimiser' }), /run by Octopus Intelligent Go/);
  assert.ok(await C.submitRequest({ thingId: ev.id, capability: 'ev_charging', action: 'boost', priority: 'manual', validFrom: T0, validUntil: T0 + 600, source: 'user:1' }), 'a person still may');
});

await test('case 6: the home switches tariff mid-month: slots before the switch keep the old price, after it the new one', async () => {
  const h = await home('Switch'); const meter = await addDevice({ siteId: h, kind: 'meter_import', provider: 'octopus', externalRef: 'mpan-6', recordedAt: (T0 + 3600) * 1000 });
  const mk = async (code, p) => { const t = await createTariff({ provider: 'synthetic', tariffCode: code, country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', name: code, origin: 'synthetic' }); await putRateRows(t.id, [{ component: 'unit', validFrom: 0, validTo: null, price: p }]); return t; };
  const [a, b] = [await mk('CASE6-OLD', 10), await mk('CASE6-NEW', 20)];
  const switchAt = D0 + 12 * 3600;
  await agreeTariff({ siteId: h, deviceId: meter.id, tariffId: a.id, validFrom: T0, validTo: switchAt });
  await agreeTariff({ siteId: h, deviceId: meter.id, tariffId: b.id, validFrom: switchAt });
  const p = await loadPricing(h, D0, D0 + 86400, null, { rateRows: true });
  const at = (ts) => unitInc(slotPrice(p, 'meter_import', ts, 1800));
  const [x, y] = [at(switchAt - 1800), at(switchAt)];
  assert.ok(y > x * 1.9 && y < x * 2.1, `the slot before the switch is ${x}, the one after ${y}: the new price is twice the old`);
});

await test('case 7: the clocks go back: a 25-hour day has 50 half-hours in every layer', async () => {
  const h = await home('Autumn'); const t = await device(h, 'temperature_sensor', 'sensor-7');
  const [A0, A1] = dayBounds('Europe/London', '2026-10-25');
  const s = await series('device', t.id, 'indoor_temp_c', 'push_native');
  await write('push_native', async () => { await F.putReadings(s, Array.from({ length: 50 }, (_, i) => ({ ts: A0 + i * 1800, value: 20 }))); });
  assert.equal(A1 - A0, 25 * 3600);
  assert.equal((await buildPointSlots(await pointOf(t.id, 'indoor_temp_c'), '2026-10-25', '2026-10-25')).slots, 50);
});

await test('case 8: the meter and the inverter clamp disagree by 38 %: the meter total wins, the shape comes from the clamp', async () => {
  const { setFusion, buildPointSlots: build } = await import('../src/core/point-slots.js');
  const h = await home('Fusion'); const m = await device(h, 'meter_import', 'm-8');
  const meterS = await series('device', m.id, 'grid_import_kwh', 'octopus_meter'); const clampS = await series('device', m.id, 'grid_import_kwh', 'sunsynk_5min');
  const half = (i) => ({ start: D0 + i * 1800, end: D0 + (i + 1) * 1800 });
  await write('octopus_meter', async () => { await F.putIntervals(meterS, Array.from({ length: 48 }, (_, i) => ({ ...half(i), value: 0.3625 }))); });          // 17.4 kWh: the meter
  await write('sunsynk_5min', async () => { await F.putIntervals(clampS, Array.from({ length: 48 }, (_, i) => ({ ...half(i), value: i < 24 ? 0.2 : 0.8 }))); });   // 24 kWh: the clamp, 38 % high
  const p = await pointOf(m.id, 'grid_import_kwh');
  await setFusion(p, { shape: 'sunsynk_5min', total: 'octopus_meter' });
  const r = await build(p, DAY, DAY);
  assert.deepEqual([r.fusion.length, r.fusion[0].flagged, Math.round(r.fusion[0].disagreement * 100)], [1, true, 38], 'the disagreement is found and reported');
  const slots = await inSlot(m.id, 'grid_import_kwh');
  assert.ok(Math.abs(slots.reduce((t, x) => t + x.delta, 0) - 17.4) < 1e-6, 'the day adds up to the meter');
  assert.ok(Math.abs(slots[40].delta / slots[10].delta - 4) < 1e-6, 'the shape is the clamp\'s: the evening is four times the night');
  assert.equal(slots[0].lineage.fusion.flagged, true, 'and each slot says it was fused and flagged');
});

await test('case 9: a clamp is installed the wrong way round: one binding change flips the sign', async () => {
  const h = await home('Clamp'); const m = await device(h, 'meter_import', 'clamp-9');
  await db.exec("INSERT INTO source (code, name, contract) VALUES ('clamp_vendor', 'Clamp vendor (test)', '{}') ON CONFLICT DO NOTHING");
  await defineChannel(h, 'clamp_vendor', 'power', 'grid_import_w', { deviceId: m.id, part: 'positive' });
  const obs = (v) => [{ point: 'power', ts: D0, value: v }];
  const read = async () => (await F.readReadings([await series('device', m.id, 'grid_import_w', 'clamp_vendor')], D0 - 10, D0 + 10)).filter((r) => r.superseded_at == null).map((r) => r.value);
  await ingestObservations(h, 'clamp_vendor', obs(-500), null, { deviceId: m.id, now: D0 + 5 });
  assert.deepEqual(await read(), [0], 'wired backwards, the home seems to export: nothing imported');
  await defineChannel(h, 'clamp_vendor', 'power', 'grid_import_w', { deviceId: m.id, part: 'negative' });
  await ingestObservations(h, 'clamp_vendor', obs(-500), null, { deviceId: m.id, now: D0 + 5 });
  assert.deepEqual(await read(), [500], 'one binding change, and the same reading is the import it was');
});

await test('case 10: an AC-coupled battery or two inverters: supported plants build, an unwired one is refused with a reason', () => {
  const th = (id, type) => ({ id, type, valid_to: null });
  const feeds = (from, to) => ({ from, to, rel: 'feeds', valid_to: null });
  const spine = [th(90, 'grid_connection'), th(91, 'home_supply')];
  assert.equal(topologyOf({ things: [...spine, th(1, 'inverter'), th(2, 'inverter'), th(3, 'battery')], relations: [], evidence: { flows: { battery: true } } }).supported, true, 'two inverters: each a unit of the build');
  assert.equal(topologyOf({ things: [...spine, th(1, 'inverter'), th(2, 'pv_array'), th(3, 'battery')], relations: [feeds(2, 1), feeds(1, 3)], evidence: { flows: { solar: true, battery: true } } }).supported, true);
  const refused = topologyOf({ things: [...spine, th(1, 'inverter'), th(2, 'pv_array'), th(3, 'battery')], relations: [feeds(2, 1)], evidence: { flows: { solar: true, battery: true } } });
  assert.deepEqual([refused.supported, refused.reasons], [false, ['a battery is not wired to the inverter']], 'refused with a reason, not built wrong');
});

await test('case 11: an EV that powers the home: the charger and the car both ways, and untracked never goes negative', async () => {
  const h = await home('V2H'); const charger = await device(h, 'ev_charger', 'evc-11'); const car = await device(h, 'ev', 'car-11');
  await T.relate({ siteId: h, from: charger.id, fromPort: 'ev', rel: 'feeds', to: car.id, toPort: 'charge', at: T0 + 86400 });
  await T.relate({ siteId: h, from: car.id, fromPort: 'charge', rel: 'feeds', to: charger.id, toPort: 'ev', at: T0 + 86400 });
  assert.equal((await T.relationsAt(h, { rels: ['feeds'], at: null })).length, 2, 'energy may flow either way through the pair');
  assert.equal(untracked(1.0, 1.2), null, 'the car gave the home more than it used: nothing negative is claimed');
  assert.equal(untracked(1.0, 1.003), 0);
});

await test('case 12: a device accepts writes but reports nothing: its commands end sent_unverified and no safety action is sent', async () => {
  const h = await home('Mute'); const b = await device(h, 'boiler', 'ir-12');
  const plansM = await import('../src/core/plans.js'); const cmd = await import('../src/core/commands.js'); const { runControlCycle } = await import('../src/core/executor.js');
  for (const a of ['heat_on', 'heat_off']) await plansM.setCapability(b.id, a, true, { source: 'installer', verification: 'none' });
  const now = Date.now(); const from = Math.ceil(now / 1000) + 3600; const writes = [];
  const driver = { source: 'push_native', read: async () => [], send: async (_d, desired) => { writes.push(desired.action); return { accepted: true }; } };
  const comfort = await cmd.enqueueIfChanged({ deviceId: b.id, desired: { action: 'heat_on' }, validFrom: from, validUntil: from + 3600, now });
  await runControlCycle(h, { driver, now: (from + 60) * 1000, devices: [b.id] });
  assert.deepEqual([(await cmd.getCommand(comfort.command.id)).status, writes], ['sent_unverified', ['heat_on']], 'written once, never acked');
  const safety = await cmd.enqueueIfChanged({ deviceId: b.id, desired: { action: 'heat_off' }, validFrom: from, validUntil: from + 3600, now });
  assert.deepEqual([safety.written, safety.blocks.map((x) => x.gate)], [false, ['unverifiable']], 'no safety action is sent to a device that cannot confirm it');
});
await test('case 13: the house is sold: the new owner sees device history from the handover only', async () => {
  const O = await import('../src/core/occupancy.js');
  const h = await home('Sold'); const old = await createUser({ name: 'Seller', username: 'seller13' }); const next = await createUser({ name: 'Buyer', username: 'buyer13' }); await giveHome(old.id, h);
  const m = await device(h, 'meter_import', 'm-13'); const sid = await series('device', m.id, 'grid_import_w', 'push_native');
  await write('push_native', async () => { await F.putReadings(sid, Array.from({ length: 40 }, (_, i) => ({ ts: D0 + i * 1800, value: 400 }))); });
  await db.prepare("INSERT INTO connection (site_id, provider, status) VALUES (?, 'octopus', 'ok')").run(h);
  await db.prepare("INSERT INTO connection_secret (site_id, provider, iv, tag, ciphertext, recorded_at) VALUES (?, 'octopus', ?, ?, ?, ?)").run(h, Buffer.alloc(12), Buffer.alloc(16), Buffer.from('x'), T0);
  const at = D0 + 12 * 3600;
  const r = await O.handOver({ homeId: h, fromUserId: old.id, toUserId: next.id, at });
  assert.deepEqual([await O.readableFrom(next.id, h), r.removed.handover.logins], [at, 1], 'the buyer reads from the handover; the seller\'s login is gone');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM reading WHERE series_id = ?').get(sid)).n, 40, 'the home\'s history is all still there');
  assert.equal(await db.prepare('SELECT 1 FROM user_site WHERE user_id = ? AND site_id = ?').get(old.id, h), undefined, 'the seller no longer sees the home');
});
await test('case 14: the owner asks for their data to be erased: the person\'s data and personal raw payloads go, the home\'s device history stays', async () => {
  const O = await import('../src/core/occupancy.js');
  const h = await home('Erase'); const p = await createUser({ name: 'Leaver', username: 'leaver14' }); await giveHome(p.id, h);
  const m = await device(h, 'meter_import', 'm-14'); const sid = await series('device', m.id, 'grid_import_w', 'push_native');
  await write('push_native', async () => { await F.putReadings(sid, Array.from({ length: 10 }, (_, i) => ({ ts: D0 + i * 1800, value: 400 }))); });
  await db.exec("INSERT INTO source (code, name, contract, traits) VALUES ('octopus_kraken', 'Kraken', '{}', '{\"personal\":true}') ON CONFLICT (code) DO UPDATE SET traits = excluded.traits");
  const answer = await F.landRaw({ source: 'octopus_kraken', siteId: h, request: {}, body: { name: 'Leaver', address: '14 Case Street' } });
  const r = await O.erasePerson(p.id, { reason: 'case 14' });
  assert.deepEqual([r.removed.person.account, r.removed.person.receipts], [1, 1]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM raw_payload WHERE id = ?').get(answer.rawId)).n, 0, 'the personal raw answer is gone');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM reading WHERE series_id = ?').get(sid)).n, 10, 'the home\'s device history stays');
});
await test('case 15: a block of flats with communal heating: each flat\'s heating cost is its share, labelled allocated', { todo: 'shared things with shares (R20) are not built' }, () => { assert.fail('not built'); });
await test('case 16: an EV moves with its owner to a new home: the old home keeps its history, the new one starts empty', { todo: 'the dated home of a thing (R24) is not built' }, () => { assert.fail('not built'); });

await test('case 17: a detached garage on a second hub: devices of both hubs in one home graph (the offline marking per hub is not built)', async () => {
  const h = await home('Hubs'); const hub1 = await T.createThing({ siteId: h, type: 'hub', name: 'House hub', validFrom: T0 + 3600 }); const hub2 = await T.createThing({ siteId: h, type: 'hub', name: 'Garage hub', validFrom: T0 + 3600 });
  const a = await device(h, 'smart_plug', 'p-house'); const b = await device(h, 'smart_plug', 'p-garage');
  await T.relate({ siteId: h, from: a.id, rel: 'served_by', to: hub1.id, at: T0 + 86400 }); await T.relate({ siteId: h, from: b.id, rel: 'served_by', to: hub2.id, at: T0 + 86400 });
  const served = await T.relationsAt(h, { rels: ['served_by'], at: null });
  assert.deepEqual(served.map((r) => Number(r.to_id)).sort(), [hub1.id, hub2.id].sort(), 'both hubs in one home graph');
});

await test('case 18: one broken temperature sensor in the bedroom: the home stays final, the bedroom shows lower coverage', async () => {
  const h = await home('Broken'); const room = await space(h, 'room', 'Bedroom');
  const good = await device(h, 'temperature_sensor', 's-good'); const dead = await device(h, 'temperature_sensor', 's-dead');
  await place(h, good.id, room.id); await place(h, dead.id, room.id, 0);   // the second sensor is a nice-to-have
  const s = await series('device', good.id, 'indoor_temp_c', 'push_native'); await series('device', dead.id, 'indoor_temp_c', 'push_native');
  await write('push_native', async () => { await F.putReadings(s, [{ ts: D0 + 36000, value: 19 }, { ts: D0 + 36300, value: 19 }]); });
  await buildHomePointSlots(h, DAY, DAY); await buildHomeNodeSlots(h, DAY, DAY);
  const r = (await readNodeSlots(room.id, D0, D0 + 86400, ['temperature_c']))[0];
  assert.deepEqual([r.state, r.coverage, r.lineage.optional_missing.length], ['final', 0.5, 1], 'the bedroom: final, half the members, the dead one named');
});

await test('case 19: tomorrow\'s prices are not published yet: the slots are missing, not estimated', async () => {
  const h = await home('Agile'); const meter = await addDevice({ siteId: h, kind: 'meter_import', provider: 'octopus', externalRef: 'mpan-19', recordedAt: (T0 + 3600) * 1000 });
  const t = await createTariff({ provider: 'synthetic', tariffCode: 'CASE19-AGILE', country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', name: 'Agile', origin: 'synthetic' });
  await putRateRows(t.id, [{ component: 'unit', validFrom: D0, validTo: D0 + 86400, price: 15 }]);   // published to the end of today only
  await agreeTariff({ siteId: h, deviceId: meter.id, tariffId: t.id, validFrom: T0 });
  const p = await loadPricing(h, D0, D0 + 2 * 86400, null, { rateRows: true });
  assert.equal(unitInc(slotPrice(p, 'meter_import', D0 + 3600, 1800)) > 0, true);
  const tomorrow = slotPrice(p, 'meter_import', D0 + 86400 + 3600, 1800);
  assert.equal(tomorrow?.unitEx ?? null, null, 'no price for a slot nobody has published');
});

await test('case 20: a home with no hub and only cloud devices: everything but control works, and control shows only what the cloud allows', async () => {
  const h = await home('Cloud'); const bat = await addDevice({ siteId: h, kind: 'battery', provider: 'sunsynk', externalRef: 'cloud-bat', recordedAt: (T0 + 3600) * 1000 }); await place(h, bat.id, h);
  assert.equal((await db.prepare("SELECT kind FROM thing_link WHERE thing_id = ?").get(bat.id)).kind, 'cloud', 'its link is a cloud link');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM thing WHERE home_id = ? AND type = 'hub'").get(h)).n, 0, 'no hub anywhere');
  const s = await series('device', bat.id, 'battery_soc_pct', 'sunsynk_5min');
  await write('sunsynk_5min', async () => { await F.putReadings(s, [{ ts: D0 + 3600, value: 55 }]); });
  assert.ok((await buildPointSlots(await pointOf(bat.id, 'battery_soc_pct'), DAY, DAY)).slots >= 1, 'its timeline works');
  assert.ok((await C.actionsOf(bat.id)).every((a) => a.confirmed === false), 'no action is offered as confirmed until the cloud API is known to deliver it');
});

await test('case 21: a plug is moved from the garage to the kitchen at 14:10: the 14:00 slot counts in the garage, 14:30 in the kitchen, no slot split', async () => {
  const h = await home('Move'); const garage = await space(h, 'garage', 'Garage'); const kitchen = await space(h, 'room', 'Kitchen');
  const plug = await device(h, 'smart_plug', 'plug-21'); await place(h, plug.id, garage.id);
  const s = await series('device', plug.id, 'plug_kwh', 'push_native');
  await write('push_native', async () => { await F.putIntervals(s, [D0 + 14 * 3600, D0 + 14 * 3600 + 1800, D0 + 15 * 3600].map((start) => ({ start, end: start + 1800, value: 1 }))); });
  const moved = await T.moveThing(plug.id, kitchen.id, { siteId: h, at: D0 + 14 * 3600 + 600 });
  assert.equal(moved.boundary, D0 + 14 * 3600 + 1800, 'the change takes effect at the next slot boundary');
  await buildHomePointSlots(h, DAY, DAY); await buildNodeSlots(garage.id, DAY, DAY); await buildNodeSlots(kitchen.id, DAY, DAY);
  const e = async (place) => (await readNodeSlots(place.id, D0, D0 + 86400, ['energy_kwh'])).map((r) => r.slot_start - D0);
  assert.deepEqual(await e(garage), [14 * 3600], 'the 14:00 slot is the garage\'s');
  assert.deepEqual(await e(kitchen), [14 * 3600 + 1800, 15 * 3600], 'from 14:30 on it is the kitchen\'s');
});

await test('case 22: the slot length changes from 30 to 15 minutes: every layer is rebuilt on one grid and the totals do not change', async () => {
  const h = await home('Quarter'); const plug = await device(h, 'smart_plug', 'plug-22'); const room = await space(h, 'room', 'Den'); await place(h, plug.id, room.id);
  const s = await series('device', plug.id, 'plug_kwh', 'push_native');
  await write('push_native', async () => { await F.putIntervals(s, Array.from({ length: 6 }, (_, i) => ({ start: D0 + 8 * 3600 + i * 1800, end: D0 + 8 * 3600 + (i + 1) * 1800, value: 0.4 }))); });
  await buildLayers(h, DAY, DAY);
  const total = async () => Number((await db.prepare('SELECT COALESCE(SUM(delta), 0) AS t FROM point_slot WHERE point_id = ?').get(await pointOf(plug.id, 'plug_kwh'))).t);
  const half = await total();
  assert.ok(Math.abs(half - 2.4) < 1e-9);
  await setSlotLength(h, 900);
  await buildLayers(h, DAY, DAY);
  assert.deepEqual([...new Set((await db.prepare('SELECT dur_s FROM point_slot WHERE point_id = ?').all(await pointOf(plug.id, 'plug_kwh'))).map((r) => Number(r.dur_s)))], [900], 'one grid: no half-hour row is left');
  assert.ok(Math.abs((await total()) - half) < 1e-9, 'the same energy');
  assert.deepEqual([...new Set((await db.prepare('SELECT dur_s FROM node_slot WHERE thing_id = ?').all(room.id)).map((r) => Number(r.dur_s)))], [900], 'and the places above it');
});
