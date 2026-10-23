// The Octopus adapter's tariff writer (src/adapters/octopus.js upsertTariff, putRates): every
// tariff it writes is GB, in pounds, with the contract's kind and its own price grain from the
// structure, labelled provider; rows written before these columns existed are filled in, never
// overwritten. No network: only the writers are called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { upsertTariff, putRates, parseTariffCode, tariffKindOf, nativePeriodOf } = await import('../src/adapters/octopus.js');

const CASES = [
  // code, direction, structure, kind, native_period_s
  ['E-1R-VAR-22-11-01-C', 'import', 'flat', 'flat', null],
  ['E-1R-AGILE-24-10-01-G', 'import', 'agile', 'dynamic', 1800],
  ['E-1R-AGILE-OUTGOING-19-05-13-G', 'export', 'agile_export', 'dynamic', 1800],
  ['E-1R-OUTGOING-FIX-12M-19-05-13-G', 'export', 'export', 'flat', null],
  ['E-2R-VAR-22-11-01-C', 'import', 'e7', 'tou', null],
  ['E-1R-GO-VAR-22-10-14-C', 'import', 'tou', 'tou', null],
  ['E-1R-INTELLI-VAR-22-10-14-G', 'import', 'iog', 'dispatch', null],
  ['E-1R-SILVER-24-04-03-G', 'import', 'tracker', 'dynamic', 86400],
  ['G-1R-VAR-22-11-01-G', 'import', 'flat', 'flat', null],
];

test('every Octopus tariff is GB, GBP, provider-labelled, with kind and price grain from its structure', () => {
  for (const [code, direction, structure, kind, period] of CASES) {
    const t = upsertTariff({ tariffCode: code, direction });
    assert.equal(parseTariffCode(code).structure, structure, code);
    assert.deepEqual([t.structure, t.kind, t.native_period_s, t.currency, t.country, t.origin], [structure, kind, period, 'GBP', 'GB', 'provider'], code);
    assert.equal(tariffKindOf(structure), kind);
    assert.equal(nativePeriodOf(structure), period);
    assert.match(t.origin_note, new RegExp(`Octopus public API: products/${parseTariffCode(code).product}/`));
  }
  assert.equal(db.prepare("SELECT fuel FROM tariff WHERE tariff_code = 'G-1R-VAR-22-11-01-G'").get().fuel, 'gas');
});

test('a tariff stored before these columns were written gets them filled in; set values are never overwritten', () => {
  db.exec("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, region) VALUES ('octopus', 'E-1R-AGILE-23-12-06-A', 'electricity', 'import', 'agile', 'A')");
  const t = upsertTariff({ tariffCode: 'E-1R-AGILE-23-12-06-A', direction: 'import', name: 'Agile Octopus' });
  assert.deepEqual([t.currency, t.country, t.kind, t.native_period_s, t.origin, t.name], ['GBP', 'GB', 'dynamic', 1800, 'provider', 'Agile Octopus']);
  db.exec("UPDATE tariff SET origin = 'user', origin_note = 'checked by hand' WHERE tariff_code = 'E-1R-AGILE-23-12-06-A'");
  assert.equal(upsertTariff({ tariffCode: 'E-1R-AGILE-23-12-06-A', direction: 'import' }).origin, 'user');
});

test('rate rows from Octopus are provider rows', () => {
  const t = upsertTariff({ tariffCode: 'E-1R-AGILE-24-10-01-G', direction: 'import' });
  assert.equal(putRates(t.id, 'unit', 'single', [{ validFrom: 1790000000, validTo: 1790001800, priceExVat: 18.2 }, { validFrom: 1790001800, validTo: 1790003600, priceExVat: -1.1 }]), 2);
  // A restated part supersedes the old row; the part kept before it stays a provider row too.
  putRates(t.id, 'unit', 'single', [{ validFrom: 1790000900, validTo: 1790001800, priceExVat: 17 }]);
  assert.deepEqual(db.prepare('SELECT DISTINCT origin FROM rate_interval WHERE tariff_id = ?').all(t.id).map((r) => r.origin), ['provider']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NULL').get(t.id).n, 3);
});
