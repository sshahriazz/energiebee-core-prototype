// Phase T.3 and T.4: the home's price slots (supply_price_slot) and build stage 4 reading them. A current build reads the stored
// slots and stores what is missing; a build "as known at" a moment and a dry run never write; a slot is read only while the inputs it
// was made from are the ones now (any write that bypassed the write functions included); a slot with no agreement is a known fact; a
// sub-meter with its own tariff is billed at it and taken out of the main meter's priced energy (R11). The numbers of the real GB
// home and of the synthetic homes through this path are checked by golden-gb, topologies, multi-market and price-runs-*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db, syncGbVat } = await import('../src/db/db.js');
const { seriesId, putIntervals, withKnownAt } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildSite } = await import('../src/core/build.js');
const { loadPricing } = await import('../src/core/pricing.js');
const { supplyPricer, inputsStamp, supplyPoints, dropStaleSlots } = await import('../src/core/supply-price.js');
const { slotPrice, fixedShare } = await import('../src/core/slot-price.js');
const { dayBounds, slotsOfDay } = await import('../src/core/time.js');
const { deleteHome } = await import('../src/core/delete-home.js');

const TZ = 'Europe/London';
const DAY = '2026-10-20';   // GB electricity VAT is 0 % from 1 October 2026 (registry VAT_RATES)
const [A, B] = dayBounds(TZ, DAY);
let n = 0;
const tariff = async (code, extra = {}) => await createTariff({ provider: 'test', tariffCode: `SPS-${code}-${++n}`, structure: 'flat', kind: 'flat', country: 'GB', currency: 'GBP', origin: 'user', ...extra });
const rows = async (siteId, point = 'meter_import') => await db.prepare('SELECT * FROM supply_price_slot WHERE site_id = ? AND point = ? ORDER BY slot_start').all(siteId, point);

// A home with an import meter on a flat tariff (30 per kWh, standing 48 per day) and one kWh imported in every half-hour of DAY.
async function meterHome(name, { unit = 30, standing = 48, from = A - 86400 } = {}) {
  const site = await createSite({ name });
  const meter = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: `M-${name}` });
  const t = await tariff('MAIN');
  await putRateRows(t.id, [{ component: 'unit', validFrom: from, price: unit }, { component: 'standing', validFrom: from, price: standing }]);
  await agreeTariff({ siteId: site.id, deviceId: meter.id, tariffId: t.id, validFrom: from });
  const imp = await seriesId('device', meter.id, 'grid_import_kwh', 'octopus_meter');
  const facts = [];
  for (let s = A; s < B; s += 1800) facts.push({ start: s, end: s + 1800, value: 1 });
  await putIntervals(imp, facts);
  return { site, meter, tariff: t };
}
const asOfNow = () => Math.ceil(Date.now() / 1000) + 1;
const hh = async (siteId) => await db.prepare('SELECT * FROM site_hh WHERE site_id = ? ORDER BY slot_start').all(siteId);

await test('a current build stores the home\'s slots; a second build reads them and stores nothing; a dry run and an as-of build write nothing', async () => {
  const h = await meterHome('store');
  await buildSite(h.site.id, DAY, DAY, { dryRun: true });
  assert.equal((await rows(h.site.id)).length, 0, 'a dry run writes nothing');
  await buildSite(h.site.id, DAY, DAY, { asOf: asOfNow() });
  assert.equal((await rows(h.site.id)).length, 0, 'a build as known at a moment writes nothing');
  await buildSite(h.site.id, DAY, DAY);
  const stored = await rows(h.site.id);
  assert.equal(stored.length, 48);
  assert.deepEqual([stored[0].unit_ex, stored[0].vat, stored[0].unit_inc, stored[0].register, stored[0].tax_source, stored[0].device_id, stored[0].tariff_id], [30, 0, 30, 'single', 'tax_rule', h.meter.id, h.tariff.id]);
  assert.equal(stored[0].fixed_inc, 1, 'standing 48 per day over 48 half-hours');
  assert.ok(stored.every((r) => r.dur_s === 1800 && r.stamp === stored[0].stamp));
  // The stored slots are exactly what the pure code gives.
  const p = await loadPricing(h.site.id, A, B);
  for (const r of stored) {
    const price = slotPrice(p, 'meter_import', r.slot_start, 1800);
    assert.deepEqual([r.unit_ex, r.supply_ex, r.vat, r.levy, r.register], [price.unitEx, price.supplyEx, price.vat, price.levy, price.register]);
    assert.equal(r.fixed_inc, fixedShare(price, r.slot_start, 1800, TZ));
    assert.deepEqual(JSON.parse(JSON.stringify(r.lineage.inputs)), JSON.parse(JSON.stringify(price.inputs)));
  }
  // A second pricer finds every slot stored and makes none.
  const slots = slotsOfDay(TZ, DAY, 1800);
  const pricer = await supplyPricer({ siteId: h.site.id, p, slotS: 1800, tz: TZ, materialise: true });
  await pricer.load(slots);
  assert.deepEqual(pricer.stats, { read: 48, made: 0, stored: 0 }, 'slots in the table are read, not made again');
  const got = pricer.get('meter_import', slots[5]);
  assert.equal(got.price.unitEx, 30);
  assert.equal(got.fixedInc, 1);
  // The build's rows carry the stored price: 1 kWh at 30, standing 48 per day.
  const day = await hh(h.site.id);
  assert.equal(day.length, 48);
  assert.ok(day.every((r) => r.import_rate_ex === 30 && r.import_vat === 0 && r.standing_cost === 1 && r.rate_found === 1));
});

await test('a slot is read only while its inputs are the ones it was made from: a rate row, a tax rule or an agreement changed behind the write functions is never served stale', async () => {
  const h = await meterHome('stale');
  await buildSite(h.site.id, DAY, DAY);
  const before = (await rows(h.site.id))[0].stamp;
  // A correction written straight to the table: the price from 10:00 is 40.
  const noon = A + 12 * 3600;
  const t0 = Date.now();
  const cur = await db.prepare("SELECT id, valid_from FROM rate_interval WHERE tariff_id = ? AND component = 'unit' AND superseded_at IS NULL").get(h.tariff.id);
  await db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?').run(t0, cur.id);
  await db.prepare("INSERT INTO rate_interval (tariff_id, component, register, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, origin) VALUES (?, 'unit', 'single', 'ANY', ?, ?, 30, ?, 'user')").run(h.tariff.id, cur.valid_from, noon, t0);
  await db.prepare("INSERT INTO rate_interval (tariff_id, component, register, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, origin) VALUES (?, 'unit', 'single', 'ANY', ?, NULL, 40, ?, 'user')").run(h.tariff.id, noon, t0);
  await buildSite(h.site.id, DAY, DAY);
  const after = await hh(h.site.id);
  assert.deepEqual([after[0].import_rate_ex, after[24].import_rate_ex, after[47].import_rate_ex], [30, 40, 40], 'the new rows price the slots after noon');
  assert.notEqual((await rows(h.site.id))[0].stamp, before, 'the stored slots were made again with the new inputs');
  assert.equal((await rows(h.site.id)).length, 48, 'one row per slot, replaced in place');
  // The registry's VAT is put back in force whatever fails below, for the tests that follow.
  try {
    // A tax rule: 20 % VAT from the start of the day, written straight to tax_rule.
    await db.prepare("UPDATE tax_rule SET superseded_at = ? WHERE country = 'GB' AND code = 'vat' AND fuel = 'electricity' AND direction = 'import' AND superseded_at IS NULL").run(t0 + 1);
    await db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, seq, valid_from, source, unverified, recorded_at, origin)
      VALUES ('GB', 'vat', 'electricity', 'import', 'domestic', 'all', 'percent', 0.2, 100, 0, 'test', 0, ?, 'sourced')`).run(t0 + 1);
    await buildSite(h.site.id, DAY, DAY);
    const taxed = await hh(h.site.id);
    assert.equal(taxed[0].import_vat, 0.2);
    assert.equal(taxed[0].standing_cost, 1.2, 'the fixed share is taxed too');
    assert.equal((await rows(h.site.id))[0].vat, 0.2);
    // An agreement ended (superseded) behind the write functions: no slot has a price.
    await db.prepare('UPDATE tariff_agreement SET superseded_at = ? WHERE site_id = ? AND superseded_at IS NULL').run(Date.now(), h.site.id);
    await buildSite(h.site.id, DAY, DAY);
    assert.ok((await hh(h.site.id)).every((r) => r.rate_found === 0 && r.import_rate_ex == null), 'no agreement, no price: never guessed');
  } finally {
    await syncGbVat();
  }
});

await test('a slot with no agreement is stored as exactly that, and is not made again', async () => {
  const h = await meterHome('noagr', { from: A + 12 * 3600 });
  await buildSite(h.site.id, DAY, DAY);
  const r = await rows(h.site.id);
  assert.equal(r.length, 48);
  assert.ok(r.slice(0, 24).every((x) => x.device_id == null && x.tariff_id == null && x.unit_ex == null && x.vat == null && x.fixed_inc === 0), 'before the agreement: no device, no tariff, no price');
  assert.ok(r.slice(24).every((x) => x.device_id === h.meter.id && x.unit_ex === 30));
  const pricer = await supplyPricer({ siteId: h.site.id, p: await loadPricing(h.site.id, A, B), slotS: 1800, tz: TZ, materialise: true });
  await pricer.load(slotsOfDay(TZ, DAY, 1800));
  assert.deepEqual(pricer.stats, { read: 48, made: 0, stored: 0 });
  assert.equal(pricer.get('meter_import', A).price, null);
  const day = await hh(h.site.id);
  assert.ok(day.slice(0, 24).every((x) => x.rate_found === 0 && x.standing_cost === 0));
});

await test('a slot with no price published is a row with no price, and an estimated price is flagged: both come back from the table as they were made', async () => {
  const h = await meterHome('gap', { unit: 30 });
  // Prices known for the morning only, then a Tempo-like estimate for the afternoon, then nothing.
  await db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE tariff_id = ? AND component = ?').run(Date.now(), h.tariff.id, 'unit');
  await putRateRows(h.tariff.id, [
    { component: 'unit', validFrom: A - 86400, validTo: A + 6 * 3600, price: 30 },
    { component: 'unit', validFrom: A + 12 * 3600, validTo: A + 18 * 3600, price: 35, estimated: true },
  ]);
  await buildSite(h.site.id, DAY, DAY);
  const r = await rows(h.site.id);
  assert.deepEqual([r[0].unit_ex, r[0].estimated], [30, 0]);
  assert.deepEqual([r[12].unit_ex, r[12].estimated, r[12].fixed_inc], [null, 0, 1], 'a gap has no price; the standing charge is still known');
  assert.deepEqual([r[24].unit_ex, r[24].estimated], [35, 1]);
  assert.equal(r[40].unit_ex, null);
  const day = await hh(h.site.id);
  assert.equal(day[12].rate_found, 0);
  assert.equal(day[24].rate_found, 1);
  assert.ok(JSON.parse(day[24].lineage).estimated, 'the slot says it was priced with an estimate');
  // Again from the table: the same rows.
  await buildSite(h.site.id, DAY, DAY);
  const again = await hh(h.site.id);
  assert.deepEqual(again.map((x) => [x.import_rate_ex, x.rate_found, x.quality]), day.map((x) => [x.import_rate_ex, x.rate_found, x.quality]));
});

await test('a current build and a build as known at a later moment give the same rows (one code path, two ways to read it)', async () => {
  const h = await meterHome('same');
  const live = await buildSite(h.site.id, DAY, DAY, { dryRun: true });
  await buildSite(h.site.id, DAY, DAY);
  const stored = await buildSite(h.site.id, DAY, DAY, { dryRun: true });
  const asOf = await buildSite(h.site.id, DAY, DAY, { dryRun: true, asOf: asOfNow() });
  const key = (res) => res.hhRows.map((r) => [r.slot_start, r.import_rate_ex, r.import_vat, r.export_rate, r.standing_cost, r.total_cost, r.rate_found]);
  assert.deepEqual(key(stored), key(live), 'computed, then read from the table');
  assert.deepEqual(key(asOf), key(live), 'as known at a moment: computed in memory');
});

await test('slot lengths: a home on 15-minute slots stores 96 slots a day, its fixed shares add up to the day\'s charge, and a change of length drops the old rows', async () => {
  const h = await meterHome('quarter');
  await db.prepare('UPDATE site SET slot_s = 900 WHERE id = ?').run(h.site.id);
  await buildSite(h.site.id, DAY, DAY);
  const q = await db.prepare("SELECT * FROM supply_price_slot WHERE site_id = ? AND point = 'meter_import' AND dur_s = 900 ORDER BY slot_start").all(h.site.id);
  assert.equal(q.length, 96);
  assert.ok(Math.abs(q.reduce((s, r) => s + r.fixed_inc, 0) - 48) < 1e-9, 'a day\'s slots add up to the standing charge');
  await db.prepare('UPDATE site SET slot_s = 3600 WHERE id = ?').run(h.site.id);
  await buildSite(h.site.id, DAY, DAY);
  assert.deepEqual((await db.prepare('SELECT DISTINCT dur_s FROM supply_price_slot WHERE site_id = ?').all(h.site.id)).map((r) => r.dur_s), [3600], 'rows of the earlier length are dropped');
});

await test('the 25-hour day has 50 slots whose fixed shares add up to the standing charge, from the table as from the code', async () => {
  const h = await meterHome('long', { from: 0 });
  const [a, b] = dayBounds(TZ, '2026-10-25');
  assert.equal((b - a) / 3600, 25);
  await buildSite(h.site.id, '2026-10-25', '2026-10-25');
  const r = (await rows(h.site.id)).filter((x) => x.slot_start >= a && x.slot_start < b);
  assert.equal(r.length, 50);
  assert.ok(Math.abs(r.reduce((s, x) => s + x.fixed_inc, 0) - 48) < 1e-9);
});

await test('a sub-meter with its own tariff is billed at it and taken out of the main meter\'s priced energy; the build says so in its lineage', async () => {
  const h = await meterHome('sub');   // 30 per kWh, standing 48; 1 kWh imported every half-hour
  const pump = await addDevice({ siteId: h.site.id, kind: 'heat_pump', provider: 'test', externalRef: 'HP-sub' });
  const heat = await tariff('HEAT');
  await putRateRows(heat.id, [{ component: 'unit', validFrom: A - 86400, price: 10 }, { component: 'standing', validFrom: A - 86400, price: 24 }]);
  await agreeTariff({ siteId: h.site.id, deviceId: pump.id, tariffId: heat.id, validFrom: A - 86400 });
  // The heat pump used 0.4 kWh in each half-hour of the night and 3 kWh (more than the home drew from the grid) after 06:00.
  const sub = await seriesId('device', pump.id, 'heatpump_elec_kwh', 'heating_telemetry');
  await putIntervals(sub, Array.from({ length: 48 }, (_, i) => ({ start: A + i * 1800, end: A + (i + 1) * 1800, value: i < 12 ? 0.4 : 3 })));
  await buildSite(h.site.id, DAY, DAY);
  const day = await hh(h.site.id);
  // Night: 0.6 kWh at 30 and 0.4 at 10; standing 48/48 + 24/48.
  assert.equal(day[0].grid_to_home_cost, 0.6 * 30 + 0.4 * 10);
  assert.equal(day[0].standing_cost, 1.5);
  assert.equal(day[0].total_cost, 22 + 1.5);
  assert.deepEqual(JSON.parse(day[0].lineage).sub_meters, [{ device: pump.id, tariff: heat.tariff_code, kwh: 0.4, unit_inc: 10, main_unit_inc: 30, delta: 0.4 * (10 - 30) }]);
  // Day: bounded by what the grid supplied (1 kWh), so all of it moves to the sub-meter's tariff.
  assert.equal(day[20].grid_to_home_cost, 10);
  assert.equal(JSON.parse(day[20].lineage).sub_meters[0].kwh, 1);
  assert.equal(day[0].grid_only_cost, 1 * 30 + 0.4 * (10 - 30) + 1.5, 'the grid-only baseline prices the sub-meter\'s share at its tariff too');
  // The main meter's stored slots are untouched; the sub-meter's are stored as their own supply point.
  assert.equal((await rows(h.site.id)).length, 48);
  const subRows = await rows(h.site.id, `device:${pump.id}`);
  assert.equal(subRows.length, 48);
  assert.deepEqual([subRows[0].unit_ex, subRows[0].fixed_inc, subRows[0].device_id], [10, 0.5, pump.id]);
  // The energy is the sub-meter's own series; a build as known at a later moment gives the same rows.
  const asOf = await buildSite(h.site.id, DAY, DAY, { dryRun: true, asOf: asOfNow() });
  assert.deepEqual(asOf.hhRows.map((r) => r.total_cost), day.map((r) => r.total_cost));
  // Where the sub-meter's own price is unknown, the main meter's price stays and the lineage says why.
  await db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE tariff_id = ? AND component = ?').run(Date.now(), heat.id, 'unit');
  await buildSite(h.site.id, DAY, DAY);
  const unpriced = await hh(h.site.id);
  assert.equal(unpriced[0].grid_to_home_cost, 30);
  assert.deepEqual(JSON.parse(unpriced[0].lineage).sub_meters, [{ device: pump.id, tariff: heat.tariff_code, kwh: 0.4, unpriced: true }]);
});

await test('supply_price_slot: a priced row needs a device and a tariff, a row with no agreement has neither; a deleted home takes its slots', async () => {
  const h = await meterHome('rules');
  await buildSite(h.site.id, DAY, DAY);
  const ins = (device, tariffId, unit) => db.prepare(`INSERT INTO supply_price_slot (site_id, point, device_id, tariff_id, slot_start, dur_s, unit_ex, fixed_inc, lineage, stamp, built_at)
    VALUES (?, 'meter_export', ?, ?, 5, 1800, ?, 0, '{}'::jsonb, 'x', 0)`).run(h.site.id, device, tariffId, unit);
  await assert.rejects(async () => await ins(h.meter.id, null, 1), /CHECK constraint/);
  await assert.rejects(async () => await ins(null, null, 1), /CHECK constraint/);
  await assert.rejects(async () => await db.prepare(`INSERT INTO supply_price_slot (site_id, point, slot_start, dur_s, lineage, stamp, built_at) VALUES (?, 'meter_import', ?, 1800, '{}'::jsonb, 'x', 0)`).run(h.site.id, A), /unique|duplicate|constraint/i, 'one row per home, point, length and slot');
  assert.ok((await rows(h.site.id)).length > 0);
  await deleteHome({ id: 1, role: 'admin' }, await db.prepare('SELECT * FROM site WHERE id = ?').get(h.site.id), { confirm: 'rules' });
  assert.equal((await rows(h.site.id)).length, 0);
});

await test('supplyPoints names the meter kinds with an agreement and each other device with one; the stamp changes with every input and is the same when nothing changed', async () => {
  const h = await meterHome('points');
  const p = await loadPricing(h.site.id, A, B);
  assert.deepEqual(supplyPoints(p).map((x) => x.key), ['meter_import']);
  const s1 = await inputsStamp(h.site.id, p, 1800);
  assert.equal(await inputsStamp(h.site.id, p, 1800), s1);
  assert.notEqual(await inputsStamp(h.site.id, p, 900), s1, 'the slot length');
  await putRateRows(h.tariff.id, [{ component: 'unit', validFrom: A + 20 * 3600, validTo: A + 21 * 3600, price: 99, register: 'night' }]);
  assert.notEqual(await inputsStamp(h.site.id, p, 1800), s1, 'a rate row');
  const s2 = await inputsStamp(h.site.id, p, 1800);
  await db.prepare('UPDATE site SET contracted_kva = 7 WHERE id = ?').run(h.site.id);
  assert.notEqual(await inputsStamp(h.site.id, await loadPricing(h.site.id, A, B), 1800), s2, 'the contracted capacity');
});

await test('a read "as known at" a moment never reads or writes the table, and a build removes the rows of earlier states of the home\'s inputs', async () => {
  const h = await meterHome('asof2');
  await buildSite(h.site.id, DAY, DAY);
  // A price corrected from 30 to 40 (written straight, so no queue is involved): the stored rows are of the old state.
  const t0 = Date.now();
  const cur = await db.prepare("SELECT id, valid_from FROM rate_interval WHERE tariff_id = ? AND component = 'unit' AND superseded_at IS NULL").get(h.tariff.id);
  await db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?').run(t0, cur.id);
  await db.prepare("INSERT INTO rate_interval (tariff_id, component, register, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, origin) VALUES (?, 'unit', 'single', 'ANY', ?, NULL, 40, ?, 'user')").run(h.tariff.id, cur.valid_from, t0 + 1);
  const slots = slotsOfDay(TZ, DAY, 1800);
  const asOfPrice = await withKnownAt(t0 - 1, async () => {
    const pricer = await supplyPricer({ siteId: h.site.id, p: await loadPricing(h.site.id, A, B), slotS: 1800, tz: TZ, materialise: true });
    await pricer.load(slots);
    return [pricer.get('meter_import', slots[0]).price.unitEx, pricer.stats];
  });
  assert.deepEqual(asOfPrice, [30, { read: 0, made: 48, stored: 0 }], 'computed in memory from the rows of that moment, nothing read, nothing stored');
  assert.ok((await rows(h.site.id)).every((r) => r.unit_ex === 30), 'the table is as it was');
  // A current build makes the range again under the new stamp and drops what the old stamp left (here: a day the build does not touch).
  const old = (await rows(h.site.id))[0].stamp;
  await db.prepare("INSERT INTO supply_price_slot (site_id, point, device_id, tariff_id, slot_start, dur_s, register, unit_ex, supply_ex, vat, levy, unit_inc, fixed_inc, weighted, estimated, capacity_unknown, tax_source, tax_unverified, lineage, stamp, built_at) SELECT site_id, point, device_id, tariff_id, slot_start - 86400, dur_s, register, unit_ex, supply_ex, vat, levy, unit_inc, fixed_inc, weighted, estimated, capacity_unknown, tax_source, tax_unverified, lineage, stamp, built_at FROM supply_price_slot WHERE site_id = ? AND slot_start = ?").run(h.site.id, A);
  await buildSite(h.site.id, DAY, DAY);
  const after = await rows(h.site.id);
  assert.equal(after.length, 48, 'the day before, made under the old stamp, is gone');
  assert.ok(after.every((r) => r.unit_ex === 40 && r.stamp !== old));
  assert.equal(await dropStaleSlots(h.site.id, after[0].stamp), 0);
});
