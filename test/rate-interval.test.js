// rate_interval as the schema (prisma/migrations) defines it, on a new database: the index and the overlap constraint
// (keyed on charge_period too), any non-empty register, and the unit, standing, fixed and capacity
// components with their charge periods. Also GB VAT in tax_rule following registry VAT_RATES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db, syncGbVat } = await import('../src/db/db.js');
const { VAT_RATES } = await import('../src/db/registry.js');

await db.exec(`INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure, region, currency, country) VALUES (1, 'octopus', 'E-1R-AGILE-24-10-01-G', 'electricity', 'import', 'agile', 'G', 'GBP', 'GB');
  INSERT INTO rate_interval (id, tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at) VALUES
    (7, 1, 'unit', 'single', 1000, 2800, 20.5, 1), (8, 1, 'unit', 'single', 2800, 4600, -1.25, 1), (9, 1, 'standing', 'single', 0, NULL, 50.1, 1);`);

await test('GB VAT in tax_rule follows registry VAT_RATES: a change supersedes the old rules, nothing is edited in place', async () => {
  const current = async () => (await db.prepare("SELECT fuel, direction, value, valid_from, valid_to FROM tax_rule WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL ORDER BY fuel, direction, valid_from").all()).map((r) => ({ ...r }));
  const asRules = (rates) => rates.map((v) => ({ fuel: v.fuel, direction: v.direction, value: v.rate, valid_from: v.validFrom, valid_to: v.validTo ?? null }))
    .sort((a, b) => a.fuel.localeCompare(b.fuel) || a.direction.localeCompare(b.direction) || a.valid_from - b.valid_from);
  assert.deepEqual(await current(), asRules(VAT_RATES));
  assert.equal(await syncGbVat(), false, 'in step: nothing to do');
  // A later VAT change: gas to 0 % from 2027.
  const T = Date.UTC(2027, 0, 1) / 1000;
  const changed = [...VAT_RATES.filter((v) => v.fuel !== 'gas'), { fuel: 'gas', direction: 'import', rate: 0.05, validFrom: 0, validTo: T }, { fuel: 'gas', direction: 'import', rate: 0, validFrom: T, validTo: null }];
  assert.equal(await syncGbVat(changed), true);
  assert.deepEqual(await current(), asRules(changed));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country = 'GB' AND superseded_at IS NOT NULL").get()).n, VAT_RATES.length, 'old rules kept, superseded');
});

await test('the index and the overlap trigger are on rate_interval; new components, periods and registers are allowed', async () => {
  assert.ok(await db.prepare("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'rate_current' AND tablename = 'rate_interval'").get());
  assert.match((await db.prepare("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rate_no_overlap' AND conrelid = 'rate_interval'::regclass").get()).def, /charge_period/);
  const ins = db.prepare('INSERT INTO rate_interval (tariff_id, component, register, charge_period, valid_from, valid_to, price_ex_vat, recorded_at) VALUES (1, ?, ?, ?, ?, ?, ?, 2)');
  await assert.rejects(async () => await ins.run('unit', 'single', null, 2000, 3000, 1), /overlapping current rate interval/);
  await assert.doesNotReject(async () => await ins.run('unit', 'hc', null, 2000, 3000, 14.1));
  await assert.doesNotReject(async () => await ins.run('fixed', 'single', 'month', 0, null, 1523));
  await assert.doesNotReject(async () => await ins.run('fixed', 'single', 'day', 0, null, 120));         // another period: no overlap
  await assert.rejects(async () => await ins.run('fixed', 'single', 'month', 100, 200, 1), /overlapping current rate interval/);
  await assert.doesNotReject(async () => await ins.run('capacity', 'single', 'month', 0, null, 3.2));
  await assert.rejects(async () => await ins.run('fixed', 'single', null, 0, null, 1), /CHECK/);
  await assert.rejects(async () => await ins.run('tax', 'single', null, 0, null, 1), /CHECK/);
  await assert.rejects(async () => await ins.run('unit', '', null, 5000, 6000, 1), /CHECK/);
});
