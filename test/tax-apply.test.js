// Tax rules: stacking order, a negative per-period credit, pro-rating over 23 h and 25 h days,
// and the guards against double taxes and mixed currencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTaxes, rulesFor, PLACEHOLDER_TAX_RULES, SEED_TAX_RULES, GB_VAT_RULES } from '../src/core/tax.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} != ${b}`);
const NL = { country: 'NL', fuel: 'electricity', direction: 'import', customer_class: 'domestic', valid_from: 0, valid_to: null };
const energyTax = { ...NL, code: 'energiebelasting', applies_to: 'unit', kind: 'per_kwh', value: 10, currency: 'EUR', seq: 10 };
const credit = { ...NL, code: 'heffingskorting', applies_to: 'fixed', kind: 'per_period', value: -60000, currency: 'EUR', charge_period: 'year', seq: 20 };
const btw = { ...NL, code: 'btw', applies_to: 'all', kind: 'percent', value: 0.21, currency: null, seq: 100 };
const dailyLevy = { ...NL, code: 'daily_levy', applies_to: 'fixed', kind: 'per_period', value: 120, currency: 'EUR', charge_period: 'day', seq: 20 };

const YEAR_2025 = 365 * 86400;   // local Amsterdam year: the spring and autumn hours cancel
const localHM = (tz, s) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s * 1000));

test('a per-kWh energy tax is applied first, then VAT on price plus energy tax', () => {
  const r = applyTaxes([btw, energyTax], { currency: 'EUR', unitEx: 25, kwh: 2 });   // input order does not matter
  near(r.ex.unit, 50);
  assert.deepEqual(r.lines.map((l) => l.code), ['energiebelasting', 'btw']);
  near(r.lines[0].unit, 20);
  near(r.lines[1].unit, 0.21 * 70);
  near(r.inc.unit, 84.7);
  // With VAT ordered before the energy tax the energy tax would escape VAT: seq decides.
  const swapped = applyTaxes([btw, { ...energyTax, seq: 200 }], { currency: 'EUR', unitEx: 25, kwh: 2 });
  near(swapped.inc.unit, 50 * 1.21 + 20);
});

test('percent rules with the same seq share one base (no tax on each other)', () => {
  const a = { ...btw, code: 'a', applies_to: 'unit', value: 0.1 };
  const b = { ...btw, code: 'b', applies_to: 'unit', value: 0.2 };
  const r = applyTaxes([a, b], { unitEx: 100, kwh: 1 });
  near(r.tax.unit, 30);
  near(r.inc.total, 130);
});

test('applies_to keeps unit and fixed charges apart', () => {
  const unitOnly = { ...btw, code: 'vat_unit', applies_to: 'unit', value: 0.2 };
  const fixedOnly = { ...btw, code: 'vat_fixed', applies_to: 'fixed', value: 0.055 };
  const r = applyTaxes([unitOnly, fixedOnly], { unitEx: 20, kwh: 1, fixedEx: 40 });
  near(r.tax.unit, 4);
  near(r.tax.fixed, 2.2);
  near(r.inc.total, 66.2);
});

test('a negative yearly credit is pro-rated to the slot and VAT applies to it', () => {
  const r = applyTaxes([energyTax, credit, btw], { currency: 'EUR', unitEx: 25, kwh: 0.5, fixedEx: 0, slotS: 1800, yearLengthS: YEAR_2025 });
  const share = -60000 * 1800 / YEAR_2025;
  near(r.lines.find((l) => l.code === 'heffingskorting').fixed, share);
  near(r.tax.fixed, share * 1.21);
  assert.ok(r.inc.fixed < 0);
  near(r.inc.unit, (12.5 + 5) * 1.21);
  near(r.inc.total, (12.5 + 5) * 1.21 + share * 1.21);
});

for (const [label, start, end, slots] of [
  ['23 h day (Amsterdam, 30 Mar 2025)', Date.UTC(2025, 2, 29, 23) / 1000, Date.UTC(2025, 2, 30, 22) / 1000, 46],
  ['25 h day (Amsterdam, 26 Oct 2025)', Date.UTC(2025, 9, 25, 22) / 1000, Date.UTC(2025, 9, 26, 23) / 1000, 50],
  ['24 h day (Amsterdam, 1 Jun 2025)', Date.UTC(2025, 4, 31, 22) / 1000, Date.UTC(2025, 5, 1, 22) / 1000, 48],
]) {
  test(`per-period amounts add up exactly over a ${label}`, () => {
    assert.equal(localHM('Europe/Amsterdam', start), '00:00');
    assert.equal(localHM('Europe/Amsterdam', end), '00:00');
    const dayLengthS = end - start;
    assert.equal(dayLengthS / 1800, slots);
    let daily = 0;
    let yearly = 0;
    for (let t = start; t < end; t += 1800) {
      daily += applyTaxes([dailyLevy], { currency: 'EUR', fixedEx: 0, slotS: 1800, dayLengthS }).tax.fixed;
      yearly += applyTaxes([credit], { currency: 'EUR', slotS: 1800, yearLengthS: YEAR_2025 }).tax.fixed;
    }
    near(daily, 120, 'one whole day of the daily levy');
    near(yearly, -60000 * dayLengthS / YEAR_2025, 'the day\'s share of the yearly credit');
    // 15-minute slots give the same day total.
    let q = 0;
    for (let t = start; t < end; t += 900) q += applyTaxes([dailyLevy], { currency: 'EUR', slotS: 900, dayLengthS }).tax.fixed;
    near(q, 120);
  });
}

test('guards: mixed currency, missing period length, double tax, mixed scope, bad shapes', () => {
  assert.throws(() => applyTaxes([energyTax], { currency: 'GBP', unitEx: 25, kwh: 1 }), /mixed currencies: EUR and GBP/);
  assert.throws(() => applyTaxes([energyTax], { unitEx: 25, kwh: 1 }), /input.currency is required/);
  assert.throws(() => applyTaxes([credit], { currency: 'EUR', slotS: 1800 }), /yearLengthS is required/);
  assert.throws(() => applyTaxes([credit], { currency: 'EUR', yearLengthS: YEAR_2025 }), /slotS is required/);
  assert.throws(() => applyTaxes([btw, { ...btw, applies_to: 'unit' }], { unitEx: 1, kwh: 1 }), /given twice/);
  assert.throws(() => applyTaxes([btw, { ...energyTax, country: 'FR' }], { currency: 'EUR', unitEx: 1, kwh: 1 }), /more than one country/);
  assert.throws(() => applyTaxes([{ ...energyTax, applies_to: 'fixed' }], { currency: 'EUR' }), /per_kwh applies to unit/);
  assert.throws(() => applyTaxes([{ ...btw, currency: 'EUR' }], {}), /percent has no currency/);
  assert.throws(() => applyTaxes([{ ...credit, charge_period: 'week' }], { currency: 'EUR' }), /charge_period/);
  assert.throws(() => applyTaxes([], { unitEx: NaN }), /finite/);
});

test('rulesFor picks the rules in force, current only, in seq order', () => {
  const old = { ...btw, value: 0.19, valid_from: 0, valid_to: 1000 };
  const now = { ...btw, valid_from: 1000, valid_to: null };
  const gone = { ...energyTax, superseded_at: 5 };
  const rules = [now, energyTax, old, gone, { ...energyTax, country: 'BE' }];
  assert.deepEqual(rulesFor(rules, { country: 'NL', fuel: 'electricity', direction: 'import', ts: 999 }), [energyTax, old]);
  assert.deepEqual(rulesFor(rules, { country: 'NL', fuel: 'electricity', direction: 'import', ts: 1000 }), [energyTax, now]);
  assert.deepEqual(rulesFor(rules, { country: 'NL', fuel: 'gas', direction: 'import', ts: 1000 }), []);
});

test('FR and NL seed values are placeholders, flagged unverified, and say so in their result', () => {
  assert.ok(PLACEHOLDER_TAX_RULES.length > 0);
  for (const r of SEED_TAX_RULES.filter((x) => x.country !== 'GB')) {
    assert.equal(r.unverified, true, `${r.country} ${r.code}`);
    assert.match(r.source, /^UNVERIFIED placeholder/);
  }
  for (const r of GB_VAT_RULES) assert.equal(r.unverified, false);
  const ts = Date.UTC(2025, 5, 1) / 1000;
  const nl = rulesFor(SEED_TAX_RULES, { country: 'NL', fuel: 'electricity', direction: 'import', ts });
  assert.deepEqual(nl.map((r) => r.code), ['energiebelasting', 'heffingskorting', 'btw']);
  const r = applyTaxes(nl, { currency: 'EUR', unitEx: 25, kwh: 1, slotS: 900, yearLengthS: YEAR_2025 });
  assert.equal(r.unverified, true);
  assert.ok(r.lines.every((l) => l.unverified));
  const fr = rulesFor(SEED_TAX_RULES, { country: 'FR', fuel: 'electricity', direction: 'import', ts: Date.UTC(2026, 0, 15) / 1000 });
  assert.deepEqual(fr.map((x) => x.code), ['accise', 'tva']);
  assert.equal(applyTaxes(fr, { currency: 'EUR', unitEx: 20, kwh: 1 }).unverified, true);
});
