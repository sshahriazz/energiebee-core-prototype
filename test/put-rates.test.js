// putRates: restating a rate must never leave time without a price. A restated row with the
// same start but an earlier end used to drop the rest of the original period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { upsertTariff, putRates } = await import('../src/adapters/octopus.js');

const t = upsertTariff({ tariffCode: 'E-1R-VAR-22-11-01-C', direction: 'import' });
const current = () => db.prepare('SELECT valid_from, valid_to, price_ex_vat FROM rate_interval WHERE tariff_id = ? AND component = ? AND superseded_at IS NULL ORDER BY valid_from').all(t.id, 'unit');

test('same start, earlier end: the tail of the old period keeps its old price', () => {
  putRates(t.id, 'unit', 'single', [{ validFrom: 1000, validTo: 5000, priceExVat: 20 }]);
  putRates(t.id, 'unit', 'single', [{ validFrom: 1000, validTo: 3000, priceExVat: 25 }]);
  const rows = current().map((r) => [r.valid_from, r.valid_to, r.price_ex_vat]);
  assert.deepEqual(rows, [[1000, 3000, 25], [3000, 5000, 20]]);
});

test('same start, open-ended old period, earlier end: the tail stays open-ended', () => {
  putRates(t.id, 'unit', 'single', [{ validFrom: 9000, validTo: null, priceExVat: 10 }]);
  putRates(t.id, 'unit', 'single', [{ validFrom: 9000, validTo: 9500, priceExVat: 12 }]);
  const rows = current().filter((r) => r.valid_from >= 9000).map((r) => [r.valid_from, r.valid_to, r.price_ex_vat]);
  assert.deepEqual(rows, [[9000, 9500, 12], [9500, null, 10]]);
});

test('same start, later end: no gap and no overlap', () => {
  putRates(t.id, 'unit', 'single', [{ validFrom: 20000, validTo: 21000, priceExVat: 8 }]);
  putRates(t.id, 'unit', 'single', [{ validFrom: 20000, validTo: 23000, priceExVat: 9 }]);
  const rows = current().filter((r) => r.valid_from >= 20000 && r.valid_from < 23000).map((r) => [r.valid_from, r.valid_to, r.price_ex_vat]);
  assert.deepEqual(rows, [[20000, 23000, 9]]);
});

test('an identical restatement changes nothing', () => {
  const n = putRates(t.id, 'unit', 'single', [{ validFrom: 20000, validTo: 23000, priceExVat: 9 }]);
  assert.equal(n, 0);
});
