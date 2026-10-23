// GB VAT as tax rules gives exactly the rate pricing.js vatAt gives today, for every fuel,
// direction and sample date (either side of the 1 Oct 2026 electricity change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';
import { GB_VAT_RULES, rulesFor, applyTaxes } from '../src/core/tax.js';
import { VAT_RATES } from '../src/db/registry.js';

useDb();
const { db } = await import('../src/db/db.js');
const { vatAt } = await import('../src/core/pricing.js');

test('the GB VAT seed rules are the registry VAT_RATES, field for field', () => {
  const asRules = GB_VAT_RULES.map((r) => ({ fuel: r.fuel, direction: r.direction, rate: r.value, validFrom: r.valid_from, validTo: r.valid_to }));
  assert.deepEqual(asRules, VAT_RATES.map((v) => ({ ...v, validTo: v.validTo ?? null })));
  for (const r of GB_VAT_RULES) {
    assert.equal(r.country, 'GB');
    assert.equal(r.kind, 'percent');
    assert.equal(r.applies_to, 'all');   // build.js puts VAT on unit and standing charges alike
  }
});

const CHANGE = Date.UTC(2026, 8, 30, 23, 0) / 1000;
const SAMPLES = [
  Date.UTC(2019, 0, 1) / 1000,
  Date.UTC(2024, 6, 15, 12) / 1000,
  CHANGE - 1,
  CHANGE,
  CHANGE + 1800,
  Date.UTC(2026, 9, 23, 9) / 1000,
  Date.UTC(2031, 2, 30, 1) / 1000,
];

test('applyTaxes with the GB rules gives vatAt\'s rate at every sample date', () => {
  const p = { vat: db.prepare('SELECT * FROM vat_rate').all() };
  assert.ok(p.vat.length >= 4);
  for (const [fuel, direction] of [['electricity', 'import'], ['electricity', 'export'], ['gas', 'import']]) {
    for (const ts of SAMPLES) {
      const rate = vatAt(p, fuel, direction, ts);
      const rules = rulesFor(GB_VAT_RULES, { country: 'GB', fuel, direction, ts });
      const r = applyTaxes(rules, { currency: 'GBP', unitEx: 24.5, kwh: 1, fixedEx: 50 });
      const label = `${fuel} ${direction} ${new Date(ts * 1000).toISOString()}`;
      assert.equal(r.tax.unit, 24.5 * rate, label);
      assert.equal(r.tax.fixed, 50 * rate, label);
      assert.equal(rules.length, 1, label);
      assert.equal(rules[0].value, rate, label);
      assert.equal(r.unverified, false);
    }
  }
  assert.equal(vatAt(p, 'electricity', 'import', CHANGE - 1), 0.05);
  assert.equal(vatAt(p, 'electricity', 'import', CHANGE), 0);
});
