// Money: minor units, rounding, display, and no mixing of currencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENCIES, currency, toMinor, toMajor, roundMinor, format, assertSameCurrency, sumByCurrency } from '../src/core/money.js';

const nbsp = (s) => s.replace(/[  ]/g, ' ');

test('the registry knows GBP and EUR with two minor digits, and nothing else', () => {
  assert.deepEqual(Object.keys(CURRENCIES).sort(), ['EUR', 'GBP']);
  assert.equal(currency('GBP').minorExponent, 2);
  assert.equal(currency('EUR').minorExponent, 2);
  assert.throws(() => currency('USD'), /unknown currency/);
  assert.throws(() => currency(undefined), /unknown currency/);
});

test('major <-> minor without binary noise', () => {
  assert.equal(toMinor(0.1 + 0.2, 'GBP'), 30);
  assert.equal(toMinor(12.34, 'EUR'), 1234);
  assert.equal(toMinor(1.005, 'GBP'), 100.5);          // fractions of a penny are kept
  assert.equal(toMinor(-0.07, 'GBP'), -7);
  assert.equal(toMajor(1234, 'GBP'), 12.34);
  assert.equal(toMajor(24.567, 'GBP'), 0.24567);
  assert.equal(toMajor(toMinor(98.76, 'EUR'), 'EUR'), 98.76);
  assert.throws(() => toMinor(NaN, 'GBP'), /finite/);
  assert.throws(() => toMinor(1, 'XYZ'), /unknown currency/);
});

test('rounding is to whole minor units, half away from zero, and survives float noise', () => {
  assert.equal(roundMinor(100.5), 101);
  assert.equal(roundMinor(-100.5), -101);
  assert.equal(roundMinor(100.49), 100);
  assert.equal(roundMinor(1.005 * 100), 101);          // 100.49999999999999 in binary
  assert.equal(roundMinor(-0.4), 0);
  assert.ok(Object.is(roundMinor(-0.4), 0));           // never -0
  assert.equal(roundMinor(0.5), 1);
});

test('format rounds to the minor unit in the reader locale', () => {
  assert.equal(format(12345.6, 'GBP', 'en-GB'), '£123.46');
  assert.equal(format(100.5, 'GBP'), '£1.01');
  assert.equal(format(-250, 'GBP'), '-£2.50');
  assert.equal(nbsp(format(12345.6, 'EUR', 'nl-NL')), '€ 123,46');
  assert.equal(nbsp(format(12345.6, 'EUR', 'fr-FR')), '123,46 €');
});

test('mixed currencies throw; the same currency passes', () => {
  assert.equal(assertSameCurrency('GBP', { currency: 'GBP' }), 'GBP');
  assert.throws(() => assertSameCurrency('GBP', 'EUR'), /mixed currencies: GBP and EUR/);
  assert.throws(() => assertSameCurrency({ currency: 'EUR' }, { currency: 'GBP' }), /mixed currencies/);
  assert.throws(() => assertSameCurrency('GBP', {}), /currency missing/);
  assert.throws(() => assertSameCurrency('GBP', 'USD'), /unknown currency/);
});

test('sums are kept per currency and never across', () => {
  const rows = [
    { currency: 'GBP', amount: 0.1 }, { currency: 'GBP', amount: 0.2 },
    { currency: 'EUR', amount: 500 }, { currency: 'EUR', amount: -120.25 },
  ];
  assert.deepEqual(sumByCurrency(rows), { GBP: 0.3, EUR: 379.75 });
  assert.deepEqual(sumByCurrency([{ currency: 'GBP', cost: 5 }], 'cost'), { GBP: 5 });
  assert.deepEqual(sumByCurrency([]), {});
  assert.throws(() => sumByCurrency([{ currency: 'GBP', amount: null }]), /not a finite number/);
  assert.throws(() => sumByCurrency([{ amount: 1 }]), /unknown currency/);
});
