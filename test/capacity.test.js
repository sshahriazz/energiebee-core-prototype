// Capacity charges (rate_interval component 'capacity', delta 007 site.contracted_kva): priced per
// kVA of the home's contracted capacity per charge period, pro-rated by real seconds like any other
// fixed charge, taxed by the home's rules, labelled with the capacity's origin; never guessed when
// the contracted capacity is unknown. A French-style subscription by kVA, in a new, empty database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { createSite, setContractedCapacity } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildSite, processQueue } = await import('../src/core/build.js');
const { seriesId, putIntervals } = await import('../src/core/facts.js');
const { dayBounds } = await import('../src/core/time.js');
const { fixedChargeMicro } = await import('../src/core/tariff-expand.js');
const { PLACEHOLDER_TAX_RULES } = await import('../src/core/tax.js');

const TZ = 'Europe/Paris';
const FROM = '2026-03-28'; const TO = '2026-03-30';   // 29 March is the 23-hour day
const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`);
for (const r of PLACEHOLDER_TAX_RULES.filter((x) => x.country === 'FR')) {
  await ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.currency, r.charge_period, r.seq, r.valid_from, r.valid_to, r.source, r.origin, r.origin_note);
}

async function home(name, capacityRows) {
  const site = await createSite({ name, market: 'FR' });
  const dev = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: `PDL-${name}` });
  const t = await createTariff({ provider: 'test', tariffCode: `TEST-${name}`, country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', origin: 'user' });
  const [a] = dayBounds(TZ, FROM); const [, b] = dayBounds(TZ, TO);
  await putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 20 }, ...capacityRows.map((r) => ({ component: 'capacity', validFrom: a, ...r }))]);
  await agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: a });
  const rows = [];
  for (let s = a; s < b; s += 1800) rows.push({ start: s, end: s + 1800, value: 0.25 });
  await putIntervals(await seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), rows);
  await buildSite(site.id, FROM, TO);
  return site;
}
const days = async (site) => await db.prepare('SELECT local_date, standing_cost FROM site_day WHERE site_id = ? ORDER BY local_date').all(site.id);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

const monthly = await home('kva-month', [{ chargePeriod: 'month', price: 125.5 }]);   // c per kVA per month, ex tax
const daily = await home('kva-day', [{ chargePeriod: 'day', price: 4 }]);            // c per kVA per day, ex tax

await test('without a contracted capacity the charge is left out, flagged on every slot and day, never guessed', async () => {
  for (const d of await days(monthly)) assert.equal(d.standing_cost, 0, d.local_date);
  const lin = (await db.prepare('SELECT lineage FROM site_hh WHERE site_id = ?').all(monthly.id)).map((r) => JSON.parse(r.lineage));
  assert.ok(lin.length === 142 && lin.every((l) => l.capacity_unknown === true));
  const checks = await db.prepare("SELECT local_date, status FROM check_result WHERE site_id = ? AND check_code = 'capacity_charge'").all(monthly.id);
  assert.deepEqual(checks.map((c) => c.status), ['warn', 'warn', 'warn']);
  await assert.rejects(async () => await setContractedCapacity(monthly.id, 0, { origin: 'user' }), /positive/);
  await assert.rejects(async () => await setContractedCapacity(monthly.id, 6, {}), /origin must be one of/);
});

await test('per kVA per month: price x kVA, pro-rated by real seconds (a 23-hour day too), with TVA on top', async () => {
  const r = await setContractedCapacity(monthly.id, 6, { origin: 'user', note: 'bill: puissance souscrite 6 kVA' });
  assert.deepEqual({ ...r }, { contracted_kva: 6, contracted_kva_origin: 'user', contracted_kva_note: 'bill: puissance souscrite 6 kVA' });
  const done = (await processQueue()).find((x) => x.siteId === monthly.id);
  assert.deepEqual([done.from, done.to, done.days], [FROM, TO, 3]);
  for (const d of await days(monthly)) {
    const [a, b] = dayBounds(TZ, d.local_date);
    near(d.standing_cost, (fixedChargeMicro(125.5 * 6, 'month', a, b, TZ) / 1e6) * 1.2, d.local_date);
  }
  // March in Paris has 743 hours, so the 23-hour day carries 23/743 of the month (to the millionth
  // of a cent the running total is rounded to).
  assert.ok(Math.abs((await days(monthly))[1].standing_cost - 125.5 * 6 * (23 / 743) * 1.2) < 2e-6, '29 March');
  // Every slot names its inputs: the capacity row and the contracted capacity (user), the placeholder taxes.
  const lin = JSON.parse((await db.prepare('SELECT lineage FROM site_hh WHERE site_id = ? LIMIT 1').get(monthly.id)).lineage);
  assert.equal(lin.capacity_unknown, undefined);
  assert.equal(lin.origin, 'placeholder');
  // TVA is a sourced rule (EU_VAT_RULES); the accise is still a placeholder, so the slot stays placeholder.
  assert.ok(lin.placeholder_inputs.includes('tax_rule FR/accise [placeholder]'), JSON.stringify(lin.placeholder_inputs));
  assert.ok(!lin.placeholder_inputs.some((x) => /FR\/tva/.test(x)));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM check_result WHERE site_id = ? AND check_code = 'capacity_charge'").get(monthly.id)).n, 0);
});

await test('a synthetic contracted capacity is named as a not-verified input', async () => {
  await setContractedCapacity(monthly.id, 6, { origin: 'synthetic', note: 'test' });
  await processQueue();
  const lin = JSON.parse((await db.prepare('SELECT lineage FROM site_hh WHERE site_id = ? LIMIT 1').get(monthly.id)).lineage);
  assert.equal(lin.origin, 'synthetic');
  assert.ok(lin.placeholder_inputs.includes('contracted capacity [synthetic]'));
});

await test('per kVA per day: price x kVA spread over the day\'s real slots, so every day adds up to one day', async () => {
  await setContractedCapacity(daily.id, 9, { origin: 'user' });
  await processQueue();
  for (const d of await days(daily)) near(d.standing_cost, 4 * 9 * 1.2, d.local_date);
  const slots = await db.prepare("SELECT COUNT(*) n, SUM(standing_cost) s FROM site_hh WHERE site_id = ? AND local_date = '2026-03-29'").get(daily.id);
  assert.equal(slots.n, 46);
  near(slots.s, 43.2, '23-hour day');
});
