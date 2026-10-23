// Markets: the seed rows and the slot length chosen for a home in each market and tariff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS } from '../src/db/seed/markets.js';
import { getMarket, defaultSlotFor, SLOT_LENGTHS_S } from '../src/core/markets.js';
import { CURRENCIES } from '../src/core/money.js';

test('every market is well formed', () => {
  assert.deepEqual(MARKETS.map((m) => m.code), ['GB', 'FR', 'NL', 'DE', 'BE', 'ES']);
  for (const m of MARKETS) {
    assert.ok(CURRENCIES[m.currency], `${m.code} currency`);
    assert.ok(SLOT_LENGTHS_S.includes(m.default_slot_s), `${m.code} slot`);
    assert.equal(3600 % m.price_interval_s, 0);
    assert.equal(3600 % m.meter_interval_s, 0);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: m.timezone }));
    assert.equal(defaultSlotFor(m), m.default_slot_s, `${m.code} default slot follows its own prices`);
  }
  const { origin, origin_note: note, ...gb } = getMarket('GB');
  assert.deepEqual(gb, {
    code: 'GB', country: 'GB', timezone: 'Europe/London', currency: 'GBP',
    price_interval_s: 1800, meter_interval_s: 1800, default_slot_s: 1800, bidding_zone: 'GB',
  });
  // Provenance: GB names its source; every other market row is a stand-in, not verified.
  assert.equal(origin, 'sourced');
  assert.match(note, /Elexon BSC/);
  for (const m of MARKETS.filter((x) => x.code !== 'GB')) assert.equal(m.origin, 'placeholder', m.code);
  assert.throws(() => getMarket('US'), /unknown market/);
});

test('slot length: the market default, made finer only by a finer tariff', () => {
  const cases = [
    ['GB', null, 1800],
    ['GB', { native_period_s: null }, 1800],     // flat tariff
    ['GB', { native_period_s: 1800 }, 1800],     // Agile
    ['GB', { native_period_s: 86400 }, 1800],    // Tracker: daily price
    ['GB', { native_period_s: 900 }, 900],       // quarter-hour prices
    ['GB', { native_period_s: 3600 }, 1800],
    ['GB', { native_period_s: 2700 }, 900],      // 45 min: only 900 keeps price changes on boundaries
    ['GB', { native_period_s: 300 }, 900],       // finer than any slot: the slot pays the mean
    ['NL', null, 900],
    ['NL', { native_period_s: 3600 }, 900],
    ['FR', null, 1800],
    ['FR', { native_period_s: null }, 1800],     // HP/HC or Tempo: windows on half-hours
    ['FR', { native_period_s: 900 }, 900],       // spot-indexed offer
    ['ES', null, 3600],
    ['ES', { native_period_s: 900 }, 900],
    ['DE', null, 900],
    ['BE', null, 900],
  ];
  for (const [code, tariff, want] of cases) {
    assert.equal(defaultSlotFor(code, tariff ?? undefined), want, `${code} ${JSON.stringify(tariff)}`);
    assert.equal(defaultSlotFor(getMarket(code), tariff ?? undefined), want);
  }
  assert.throws(() => defaultSlotFor('GB', { native_period_s: 0 }), /positive/);
});
