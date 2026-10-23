// Per-home slot length (site.slot_s): the slot grid across clock changes, prices over a whole
// slot, and Intelligent Octopus smart-charge half-hours seen from 15-minute slots. No live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { slotsOfDay, slotOfDay, todMinute, slotLabel, slotLength, slotPhase, SLOT_LENGTHS, localToUtc } = await import('../src/core/time.js');
const { priceAt, priceOver, dispatchAllowance } = await import('../src/core/pricing.js');

test('slots per local day at 15, 30 and 60 minutes: short, long and ordinary days in three zones', () => {
  const expect = { '2026-03-29': [92, 46, 23], '2026-10-25': [100, 50, 25], '2026-10-24': [96, 48, 24] };
  for (const tz of ['Europe/London', 'Europe/Paris', 'Europe/Amsterdam']) {
    for (const [date, counts] of Object.entries(expect)) {
      SLOT_LENGTHS.forEach((slotS, i) => {
        const slots = slotsOfDay(tz, date, slotS);
        assert.equal(slots.length, counts[i], `${tz} ${date} at ${slotS}s`);
        assert.ok(slots.every((s) => s % 900 === 0), `${tz} ${date} at ${slotS}s: starts on the 900 s grid`);
        assert.ok(slots.every((s, j) => j === 0 || s - slots[j - 1] === slotS), 'consecutive');
      });
    }
  }
  // The default is unchanged: half-hours.
  assert.equal(slotsOfDay('Europe/London', '2026-10-24').length, 48);
});

test('slot of the day comes from the local clock, so a time keeps its index across clock changes', () => {
  const tz = 'Europe/London';
  for (const date of ['2026-03-29', '2026-10-24', '2026-10-25']) {
    const [y, m, d] = date.split('-').map(Number);
    const t = localToUtc(tz, y, m, d, 17, 15);
    assert.equal(todMinute(tz, t), 17 * 60 + 15);
    assert.equal(slotOfDay(tz, t, 900), 69);
    assert.equal(slotOfDay(tz, t, 1800), 34);
    assert.equal(slotOfDay(tz, t, 3600), 17);
    assert.equal(slotOfDay(tz, t), 34, 'the default is half-hours: hh*2 + (mm >= 30)');
  }
  assert.equal(slotLabel(47), '23:30');
  assert.equal(slotLabel(48), '00:00');
  assert.equal(slotLabel(69, 900), '17:15');
  assert.equal(slotLength({ slot_s: 900 }), 900);
  assert.equal(slotLength({}), 1800);
  assert.equal(slotLength({ slot_s: 600 }), 1800, 'a length that is not allowed reads as the default');
  assert.equal(slotPhase('Europe/London', 3600, Date.UTC(2026, 6, 1) / 1000), 0);
  assert.equal(slotPhase('Australia/Adelaide', 3600, Date.UTC(2026, 6, 1) / 1000), 1800, 'UTC+9:30: hour slots start on :30 UTC');
});

// A hand-made price list: one import agreement, unit rows as given, 0% VAT.
const T = Date.UTC(2026, 9, 20, 13, 0) / 1000;   // 14:00 London (BST)
function pricing(units, { structure = 'flat', dispatches = [], iogWindow = null } = {}) {
  return {
    agreements: [{ kind: 'meter_import', tariff_id: 1, tariff_code: 'TEST', structure, fuel: 'electricity', direction: 'import', valid_from: 0, valid_to: null }],
    rates: [
      ...units.map(([from, to, price, register = 'single']) => ({ tariff_id: 1, component: 'unit', register, valid_from: from, valid_to: to, price_ex_vat: price, payment_method: 'ANY', site_id: null })),
      { tariff_id: 1, component: 'standing', register: 'single', valid_from: 0, valid_to: null, price_ex_vat: 48, payment_method: 'ANY', site_id: null },
    ],
    vat: [{ fuel: 'electricity', direction: 'import', rate: 0, valid_from: 0, valid_to: null }],
    dispatches, tz: 'Europe/London', iogWindow, dispatchAllowed: dispatchAllowance(dispatches, 'Europe/London'),
  };
}

test('priceOver: two prices in a slot give their time-weighted mean', () => {
  const p = pricing([[T, T + 1800, 10], [T + 1800, T + 3600, 20]]);
  const hour = priceOver(p, 'meter_import', T, 3600);
  assert.equal(hour.unitEx, 15);
  assert.equal(hour.weighted, true);
  assert.equal(hour.standingEx, 48);
  // Three quarters at 10p and one at 20p.
  const q = pricing([[T, T + 2700, 10], [T + 2700, T + 3600, 20]]);
  assert.equal(priceOver(q, 'meter_import', T, 3600).unitEx, 12.5);
});

test('priceOver: one unpriced moment leaves the slot unpriced', () => {
  const p = pricing([[T, T + 1800, 10]]);
  const hour = priceOver(p, 'meter_import', T, 3600);
  assert.equal(hour.unitEx, null);
  assert.equal(hour.standingEx, 48, 'the standing charge is still known');
});

test('priceOver: equal prices across the slot return exactly what priceAt gives (half-hours unchanged)', () => {
  const p = pricing([[T, T + 1800, 10.123456789], [T + 1800, T + 3600, 20]]);
  assert.deepEqual(priceOver(p, 'meter_import', T, 1800), priceAt(p, 'meter_import', T));
  assert.deepEqual(priceOver(p, 'meter_import', T + 1800, 1800), priceAt(p, 'meter_import', T + 1800));
  assert.equal(priceOver(p, 'meter_import', T, 1800).weighted, undefined);
  assert.deepEqual(priceOver(p, 'meter_import', T + 900, 900), priceAt(p, 'meter_import', T + 900));
});

test('Intelligent Octopus: a smart-charge half-hour discounts the 15-minute slots inside it, :15 and :45 included', () => {
  const units = [[0, null, 30, 'day'], [0, null, 7, 'night']];
  const p = pricing(units, { structure: 'iog', iogWindow: { start: 23 * 60 + 30, end: 5 * 60 + 30 }, dispatches: [{ start_ts: T, end_ts: T + 1800 }] });
  for (const s of [T, T + 900]) {
    const q = priceOver(p, 'meter_import', s, 900);
    assert.equal(q.register, 'night', `slot at +${s - T}s`);
    assert.equal(q.unitEx, 7);
  }
  assert.equal(priceOver(p, 'meter_import', T, 1800).unitEx, 7, 'the half-hour itself, as before');
  assert.equal(priceOver(p, 'meter_import', T + 1800, 900).unitEx, 30, 'after the dispatch: day rate');
  // A dispatch from :15 to :45 counts its two half-hours (Octopus's grid), so 14:15 and 14:45 are both discounted.
  const p2 = pricing(units, { structure: 'iog', iogWindow: { start: 23 * 60 + 30, end: 5 * 60 + 30 }, dispatches: [{ start_ts: T + 900, end_ts: T + 2700 }] });
  assert.equal(priceOver(p2, 'meter_import', T + 900, 900).unitEx, 7);
  assert.equal(priceOver(p2, 'meter_import', T + 2700, 900).unitEx, 7);
  // An hour slot half inside a discounted half-hour pays the mean of night and day.
  const p3 = pricing(units, { structure: 'iog', iogWindow: { start: 23 * 60 + 30, end: 5 * 60 + 30 }, dispatches: [{ start_ts: T, end_ts: T + 1800 }] });
  assert.equal(priceOver(p3, 'meter_import', T, 3600).unitEx, 18.5);
});

test('a new slot length is recorded once as slot_s, not as a change in slot counts', async () => {
  const { dayChanges } = await import('../src/core/build.js');
  const day = { slots_final: 48, slots_provisional: 0, slots_missing: 0, solar: 5, home: 10, grid_import: 6, grid_export: 1, gas: null, total_cost: 100, saving: 20, method_version: 'v' };
  assert.deepEqual(dayChanges({ ...day, slot_s: 1800 }, {}, { ...day, slots_final: 96, slot_s: 900 }, {}), [{ field: 'slot_s', from: 1800, to: 900 }]);
  // A day stored before slot_s was recorded was half-hours.
  assert.deepEqual(dayChanges(day, {}, { ...day, slot_s: 1800 }, {}), []);
  assert.deepEqual(dayChanges({ ...day, slot_s: 1800 }, {}, { ...day, slots_final: 47, slots_missing: 1, slot_s: 1800 }, {}).map((c) => c.field), ['slots_final', 'slots_missing']);
  assert.deepEqual(dayChanges({ ...day, slot_s: 1800 }, {}, { ...day, slots_final: 24, home: 11, slot_s: 3600 }, {}).map((c) => c.field), ['slot_s', 'home']);
});
