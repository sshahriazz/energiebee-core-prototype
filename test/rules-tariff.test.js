// The rules of the tariff price runs (Phase T.1), broken on purpose and refused (fix list D1): see test/rules/lib.js for how an
// area proves its rules and declares them. Two runs of one tariff, component, register, charge period, payment method and home
// scope never overlap; runs that differ in any of those, or follow each other, are fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { run, get, ins, excluded, checkDeclared } = await harness('tariff');

const site = await ins("INSERT INTO site (name, created_at) VALUES ('A', 0)");
const tariff = (code) => ins("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, currency, country) VALUES ('test', ?, 'electricity', 'import', 'flat', 'GBP', 'GB')", code);
const t1 = await tariff('RUN-1');
const t2 = await tariff('RUN-2');
const insert = "INSERT INTO tariff_price_run (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, price_ex_vat, lineage, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 20, '{\"rate_ids\": [], \"n\": 0}'::jsonb, 0)";
const put = async (tariffId, { siteId = null, component = 'unit', register = 'single', period = null, method = 'ANY', from, to }) => await run(insert, tariffId, siteId, component, register, period, method, from, to);

await test('price runs: runs of one tariff, register and scope never overlap; anything that differs, or follows, is accepted', async () => {
  await put(t1, { from: 100, to: 200 });
  await excluded('price_run_no_overlap', insert, t1, null, 'unit', 'single', null, 'ANY', 150, 250);
  await excluded('price_run_no_overlap', insert, t1, null, 'unit', 'single', null, 'ANY', 50, 101);
  await excluded('price_run_no_overlap', insert, t1, null, 'unit', 'single', null, 'ANY', 0, null);   // an open-ended run overlaps what it covers
  await put(t1, { from: 200, to: 300 });                                // follows: valid_to is exclusive
  await put(t1, { from: 150, to: 250, register: 'night' });             // another register
  await put(t1, { from: 150, to: 250, method: 'DDM' });                 // another payment method
  await put(t1, { from: 150, to: 250, siteId: site });                  // a home's own run
  await put(t1, { from: 150, to: 250, component: 'standing' });         // another component
  await put(t1, { from: 150, to: 250, component: 'fixed', period: 'month' });
  await excluded('price_run_no_overlap', insert, t1, null, 'fixed', 'single', 'month', 'ANY', 200, 400);
  await put(t1, { from: 150, to: 250, component: 'fixed', period: 'year' });   // another charge period
  await put(t2, { from: 150, to: 250 });                                // another tariff
  assert.equal((await get('SELECT COUNT(*) AS n FROM tariff_price_run')).n, 9);
});

await test('price runs: a run must end after it starts, and a fixed charge needs its charge period', async () => {
  await assert.rejects(async () => await put(t2, { from: 500, to: 500 }), /CHECK constraint failed/);
  await assert.rejects(async () => await put(t2, { from: 500, to: 400 }), /CHECK constraint failed/);
  await assert.rejects(async () => await put(t2, { from: 500, to: 600, component: 'fixed' }), /CHECK constraint failed/);
  await assert.rejects(async () => await put(t2, { from: 500, to: 600, period: 'day' }), /CHECK constraint failed/, 'a unit price has no charge period');
});

await test('the cases above are what test/rules/tariff.json declares', () => { checkDeclared(); });
