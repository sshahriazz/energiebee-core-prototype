// The price-provider adapter contract: shape checks for adapters and the price rows they return.
// The adapters here are in-memory stand-ins (synthetic); nothing calls a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAdapter, assertAdapter, assertOwner, checkPriceRows, PRICE_COMPONENTS } from '../src/adapters/contract.js';
import { dayBounds } from '../src/core/time.js';

// A 'market' adapter in the ENTSO-E shape: one series per bidding zone, no catalogue.
const market = {
  code: 'fake_market', countries: ['FR'], role: 'market', owner: 'core',
  regionOf: (site) => (site.country === 'FR' ? { scheme: 'bzn', code: '10YFR-RTE------C' } : null),
  async priceDays(ref, variant, dates, resolutionS) {
    const rows = [];
    for (const d of dates) {
      const [a, b] = dayBounds('Europe/Paris', d);
      for (let t = a, i = 0; t < b; t += resolutionS, i++) {
        rows.push({ fromUtc: t, toUtc: t + resolutionS, component: 'energy', minorPerKwh: i % 7 === 3 ? -0.42 : 8.5, currency: 'EUR', estimated: false });
      }
    }
    return { rows, nextPollAt: null };
  },
};

const catalogue = {
  code: 'fake_catalogue', countries: ['GB'], role: 'catalogue', owner: 'external',
  regionOf: () => ({ scheme: 'gb_dno', code: '12' }),
  listTariffs: async () => ({ status: 'not_modified', etag: 'W/"1"' }),
  versions: async () => ({ status: 'ok', etag: null, versions: [{ versionDate: '20261001', available: true }] }),
};

test('a well-formed market adapter and catalogue adapter pass', () => {
  assert.deepEqual(checkAdapter(market), []);
  assert.deepEqual(checkAdapter(catalogue), []);
  assert.equal(assertAdapter(market), market);
});

test('missing or malformed fields are each reported', () => {
  const { versions, ...noVersions } = catalogue;
  assert.ok(versions);
  assert.deepEqual(checkAdapter(noVersions), ['fake_catalogue: versions() is required for role catalogue']);
  const bad = checkAdapter({ code: 'Bad-Code', countries: ['FRA'], role: 'seller', owner: 'someone', priceDays: 'x' });
  assert.equal(bad.length, 6);
  for (const re of [/code/, /countries/, /role/, /owner/, /regionOf/, /priceDays must be a function/]) assert.ok(bad.some((e) => re.test(e)), String(re));
  assert.deepEqual(checkAdapter({ ...market, role: 'both' }).sort(), ['fake_market: listTariffs() is required for role both', 'fake_market: versions() is required for role both']);
  assert.deepEqual(checkAdapter(null), ['adapter is not an object']);
  assert.throws(() => assertAdapter({ ...market, owner: 'nobody' }), /adapter contract broken: fake_market: owner/);
});

test('only the owning process may call a provider', () => {
  assert.throws(() => assertOwner(catalogue), /fake_catalogue is owned by another process: the core must not call it \(one rate budget, one caller\)/);
  assert.equal(assertOwner(catalogue, 'external'), catalogue);
  assert.equal(assertOwner(market), market);
  assert.deepEqual(checkAdapter({ ...catalogue, owner: 'core' }), []);
  assert.throws(() => assertAdapter({ ...catalogue, owner: 'someone_else' }), /owner must be one of core, external/);
});

test('price rows from an adapter pass, negative prices and a 23-hour day included', async () => {
  const { rows } = await market.priceDays({ provider: 'fake_market', externalId: 'FR', country: 'FR' }, '', ['2026-03-29'], 900);
  assert.equal(rows.length, 92);   // 23 hours of quarter-hours
  assert.ok(rows.some((r) => r.minorPerKwh < 0));
  assert.deepEqual(checkPriceRows(rows, { currency: 'EUR', resolutionS: 900 }), []);
  // Components of one slot sit side by side without overlapping each other.
  const slot = PRICE_COMPONENTS.map((component) => ({ ...rows[0], component }));
  assert.deepEqual(checkPriceRows(slot), []);
});

test('broken price rows are each reported', () => {
  const ok = { fromUtc: 1792800000, toUtc: 1792801800, component: 'energy', minorPerKwh: 9.1, currency: 'GBP', estimated: false };
  const msgs = (rows, opts) => checkPriceRows(rows, opts).join(' | ');
  assert.match(msgs([{ ...ok, fromUtc: ok.fromUtc * 1000, toUtc: ok.toUtc * 1000 }]), /milliseconds/);
  assert.match(msgs([{ ...ok, toUtc: ok.fromUtc }]), /after fromUtc/);
  assert.match(msgs([{ ...ok, fromUtc: ok.fromUtc + 7 }]), /5-minute grid/);
  assert.match(msgs([{ ...ok, fromUtc: 1.5 }]), /whole epoch seconds/);
  assert.match(msgs([{ ...ok, component: 'vat' }]), /component must be one of energy, grid, fees, tax/);
  assert.match(msgs([{ ...ok, minorPerKwh: Number.NaN }]), /finite number/);
  assert.match(msgs([{ ...ok, minorPerKwh: '9.1' }]), /finite number/);
  assert.match(msgs([{ ...ok, currency: 'gbp' }]), /ISO 4217/);
  assert.match(msgs([{ ...ok, estimated: 0 }]), /true or false/);
  assert.match(msgs([ok, { ...ok, fromUtc: ok.fromUtc + 900, toUtc: ok.toUtc + 900 }]), /row 1: energy overlaps row 0/);
  assert.match(msgs([ok, { ...ok, fromUtc: ok.toUtc, toUtc: ok.toUtc + 1800, currency: 'EUR' }]), /mix currencies/);
  assert.match(msgs([ok], { currency: 'EUR' }), /expected EUR/);
  assert.match(msgs([ok], { resolutionS: 900 }), /expected 900 s/);
  assert.deepEqual(checkPriceRows('nope'), ['rows is not an array']);
  const many = Array.from({ length: 50 }, () => ({ ...ok, component: 'x' }));
  assert.equal(checkPriceRows(many, { limit: 5 }).length, 5);
});
