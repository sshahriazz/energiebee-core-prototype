// Tariff expansion: windows to UTC rate intervals across clock changes, French HP/HC and Tempo,
// and fixed charges that add up exactly over real day, month and year lengths.
// Prices are illustrative minor units (cents/pence per kWh), not any supplier's real figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWindows, fixedChargePerSlot, fixedChargeMicro, periodBounds, parseRanges, weekdayIndex, switchInstant } from '../src/core/tariff-expand.js';
import { dayBounds, daysBetween, isoUtc, parseIso } from '../src/core/time.js';

const H = 3600;
const len = (r) => r.validTo - r.validFrom;
const sumLen = (rows) => rows.reduce((s, r) => s + len(r), 0);
const of = (rows, register) => rows.filter((r) => r.register === register);
const span = (r) => [isoUtc(r.validFrom), isoUtc(r.validTo)];

// Every local day is tiled exactly by its own intervals: starts at local midnight, each interval
// starts where the last ended, ends at the next local midnight; nothing crosses midnight.
function assertTiles(rows, tz, fromDate, toDate) {
  for (const d of daysBetween(fromDate, toDate)) {
    const [a, b] = dayBounds(tz, d);
    const day = rows.filter((r) => r.localDate === d);
    assert.ok(day.length, `${d}: no intervals`);
    assert.equal(day[0].validFrom, a, `${d}: does not start at local midnight`);
    for (let i = 1; i < day.length; i++) assert.equal(day[i].validFrom, day[i - 1].validTo, `${d}: gap or overlap at ${isoUtc(day[i].validFrom)}`);
    assert.equal(day[day.length - 1].validTo, b, `${d}: does not end at local midnight`);
    for (const r of day) assert.ok(r.validTo > r.validFrom);
  }
  assert.equal(rows.length, daysBetween(fromDate, toDate).reduce((n, d) => n + rows.filter((r) => r.localDate === d).length, 0));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].validFrom >= rows[i - 1].validTo, 'intervals overlap');
}

const hc0107 = [{ register: 'hc', start_min: 60, end_min: 420 }];
const hphc = { hc: 18.5, hp: 24.7 };

test('helpers: weekday index, time ranges as printed on a bill', () => {
  assert.equal(weekdayIndex('2026-10-23'), 4);   // a Friday
  assert.equal(weekdayIndex('2026-10-25'), 6);   // a Sunday
  assert.deepEqual(parseRanges('HC (02H00-07H00 ; 13H00-16H00)'), [{ start_min: 120, end_min: 420 }, { start_min: 780, end_min: 960 }]);
  assert.deepEqual(parseRanges('de 22h30 à 6h30'), [{ start_min: 1350, end_min: 390 }]);
  assert.deepEqual(parseRanges('01:00-05:00 / 12:00-14:00 / 22:00-24:00').map((r) => r.end_min - r.start_min), [240, 120, 120]);
  assert.deepEqual(parseRanges('23:00-00:00'), [{ start_min: 1380, end_min: 1440 }]);
  assert.throws(() => parseRanges('25:00-07:00'), /not a time range/);
});

for (const [tz, start, end] of [
  ['Europe/Paris', '2026-03-29T00:00:00Z', '2026-03-29T05:00:00Z'],    // 01:00 CET .. 07:00 CEST
  ['Europe/London', '2026-03-29T01:00:00Z', '2026-03-29T06:00:00Z'],   // 01:00 is skipped: from 02:00 BST
]) {
  test(`${tz}: off-peak 01:00-07:00 on 29 March 2026 (clocks forward) is 5 real hours`, () => {
    const rows = expandWindows({ windows: hc0107, registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-03-29', toDate: '2026-03-29' });
    assert.deepEqual(of(rows, 'hc').map(span), [[start, end]]);
    assert.equal(sumLen(of(rows, 'hc')), 5 * H);
    assert.equal(sumLen(rows), 23 * H);
    assert.equal(sumLen(of(rows, 'hp')), 18 * H);
    assertTiles(rows, tz, '2026-03-29', '2026-03-29');
  });
}

for (const [tz, start, end] of [
  ['Europe/Paris', '2026-10-24T23:00:00Z', '2026-10-25T06:00:00Z'],    // 01:00 CEST .. 07:00 CET
  ['Europe/London', '2026-10-25T00:00:00Z', '2026-10-25T07:00:00Z'],   // first 01:00 (BST) .. 07:00 GMT
]) {
  test(`${tz}: off-peak 01:00-07:00 on 25 October 2026 (clocks back) is 7 real hours`, () => {
    const rows = expandWindows({ windows: hc0107, registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-10-24', toDate: '2026-10-26' });
    const day = rows.filter((r) => r.localDate === '2026-10-25');
    assert.deepEqual(of(day, 'hc').map(span), [[start, end]]);
    assert.equal(sumLen(day), 25 * H);
    assert.equal(sumLen(of(day, 'hp')), 18 * H);
    assert.equal(sumLen(of(rows.filter((r) => r.localDate === '2026-10-24'), 'hc')), 6 * H);
    assertTiles(rows, tz, '2026-10-24', '2026-10-26');
  });
}

test('a switch inside the repeated hour happens once, the first time the clock shows it', () => {
  const tz = 'Europe/Paris';
  const rows = expandWindows({ windows: [{ register: 'hc', start_min: 150, end_min: 420 }], registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-10-25', toDate: '2026-10-25' });
  // 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET): off-peak starts at the first and stays.
  assert.equal(switchInstant(tz, '2026-10-25', 150), parseIso('2026-10-25T00:30:00Z'));
  assert.deepEqual(rows.map((r) => [r.register, ...span(r)]), [
    ['hp', '2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z'],
    ['hc', '2026-10-25T00:30:00Z', '2026-10-25T06:00:00Z'],
    ['hp', '2026-10-25T06:00:00Z', '2026-10-25T23:00:00Z'],
  ]);
  // Two windows meeting at 02:30 meet at one instant: no gap, no overlap.
  const two = expandWindows({ windows: [{ register: 'a', start_min: 0, end_min: 150 }, { register: 'b', start_min: 150, end_min: 1440 }], tz, fromDate: '2026-10-25', toDate: '2026-10-25' });
  assert.deepEqual(two.map((r) => [r.register, len(r) / H]), [['a', 2.5], ['b', 22.5]]);
  assertTiles(two, tz, '2026-10-25', '2026-10-25');
});

test('a window crossing midnight follows the weekday it starts on', () => {
  const tz = 'Europe/London';
  const rows = expandWindows({
    windows: [{ register: 'night', weekdays: 1 << 4, start_min: 1380, end_min: 420 }],   // Friday nights only
    registerPrices: { night: 9, day: 27 }, defaultRegister: 'day', tz, fromDate: '2026-10-19', toDate: '2026-10-25',
  });
  const night = of(rows, 'night');
  assert.deepEqual(night.map((r) => [r.localDate, ...span(r)]), [
    ['2026-10-23', '2026-10-23T22:00:00Z', '2026-10-23T23:00:00Z'],
    ['2026-10-24', '2026-10-23T23:00:00Z', '2026-10-24T06:00:00Z'],
  ]);
  assert.equal(night.every((r) => r.price === 9), true);
  assertTiles(rows, tz, '2026-10-19', '2026-10-25');
});

test('French HP/HC: the meter\'s own 8 off-peak hours replace the tariff\'s reference window', () => {
  const tz = 'Europe/Paris';
  const tariff = [{ tariff_id: 1, register: 'hc', start_min: 1380, end_min: 420, source: 'provider' }];
  const meter = parseRanges('HC (02H00-07H00 ; 13H00-16H00)').map((r) => ({ ...r, device_id: 7, register: 'hc', source: 'linky_tic' }));
  const rows = expandWindows({ windows: [...tariff, ...meter], registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-10-23', toDate: '2026-10-23' });
  assert.deepEqual(of(rows, 'hc').map(span), [
    ['2026-10-23T00:00:00Z', '2026-10-23T05:00:00Z'],
    ['2026-10-23T11:00:00Z', '2026-10-23T14:00:00Z'],
  ]);
  assert.equal(sumLen(of(rows, 'hc')), 8 * H);
  assertTiles(rows, tz, '2026-10-23', '2026-10-23');

  // Three ranges, one ending at midnight.
  const three = parseRanges('01:00-05:00 / 12:00-14:00 / 22:00-24:00').map((r) => ({ ...r, device_id: 7, register: 'hc' }));
  const r3 = expandWindows({ windows: [...tariff, ...three], registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-10-22', toDate: '2026-10-23' });
  assert.equal(sumLen(of(r3.filter((r) => r.localDate === '2026-10-23'), 'hc')), 8 * H);
  assertTiles(r3, tz, '2026-10-22', '2026-10-23');

  // Meter windows known only from 24 October: before that the tariff's window still applies.
  const from24 = parseIso('2026-10-23T22:00:00Z');   // 24 Oct 00:00 Paris
  const later = meter.map((w) => ({ ...w, valid_from: from24 }));
  const r2 = expandWindows({ windows: [...tariff, ...later], registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-10-23', toDate: '2026-10-24' });
  assert.deepEqual(of(r2, 'hc').map((r) => [r.localDate, ...span(r)]), [
    ['2026-10-23', '2026-10-22T22:00:00Z', '2026-10-23T05:00:00Z'],   // tariff 23:00-07:00 from the 22nd
    ['2026-10-23', '2026-10-23T21:00:00Z', '2026-10-23T22:00:00Z'],   // tariff 23:00, cut at midnight when the meter's windows start
    ['2026-10-24', '2026-10-24T00:00:00Z', '2026-10-24T05:00:00Z'],   // meter 02:00-07:00
    ['2026-10-24', '2026-10-24T11:00:00Z', '2026-10-24T14:00:00Z'],   // meter 13:00-16:00
  ]);
  assertTiles(r2, tz, '2026-10-23', '2026-10-24');
});

test('every day of a year tiles exactly, in Paris and London, with three off-peak ranges', () => {
  const windows = parseRanges('01:30-06:30, 12:00-14:00, 23:30-00:30').map((r) => ({ ...r, register: 'hc' }));
  for (const tz of ['Europe/Paris', 'Europe/London']) {
    const rows = expandWindows({ windows, registerPrices: hphc, defaultRegister: 'hp', tz, fromDate: '2026-01-01', toDate: '2026-12-31' });
    assertTiles(rows, tz, '2026-01-01', '2026-12-31');
    for (const d of daysBetween('2026-01-01', '2026-12-31')) {
      const [a, b] = dayBounds(tz, d);
      if (b - a === 24 * H) assert.equal(sumLen(of(rows.filter((r) => r.localDate === d), 'hc')), 8 * H, `${tz} ${d}`);
    }
  }
});

// ───────────── Tempo ─────────────

const tempoWindows = ['blue', 'white', 'red'].flatMap((c) => [
  { register: `${c}_hp`, calendar: 'fr_tempo', day_type: c, start_min: 360, end_min: 1320 },
  { register: `${c}_hc`, calendar: 'fr_tempo', day_type: c, start_min: 1320, end_min: 360 },
]);
const tempoPrices = { blue_hc: 12.3, blue_hp: 14.9, white_hc: 13.9, white_hp: 17.3, red_hc: 14.6, red_hp: 64.7 };
const tempo = (days) => ({ code: 'fr_tempo', dayStartMin: 360, days });

test('Tempo: the colour switches at 06:00 and the night takes the colour of the day it started in', () => {
  const tz = 'Europe/Paris';
  const rows = expandWindows({ windows: tempoWindows, registerPrices: tempoPrices, tz, fromDate: '2026-01-15', toDate: '2026-01-15', calendar: tempo({ '2026-01-14': 'blue', '2026-01-15': 'red' }) });
  assert.deepEqual(rows.map((r) => [r.register, r.price, r.calendarDay, ...span(r)]), [
    ['blue_hc', 12.3, '2026-01-14', '2026-01-14T23:00:00Z', '2026-01-15T05:00:00Z'],
    ['red_hp', 64.7, '2026-01-15', '2026-01-15T05:00:00Z', '2026-01-15T21:00:00Z'],
    ['red_hc', 14.6, '2026-01-15', '2026-01-15T21:00:00Z', '2026-01-15T23:00:00Z'],
  ]);
  assert.equal(rows.every((r) => r.estimated === false), true);
  assertTiles(rows, tz, '2026-01-15', '2026-01-15');
});

test('Tempo: an unknown colour is estimated with a cautious price, and refused without one', () => {
  const tz = 'Europe/Paris';
  const calendar = tempo({ '2026-01-14': 'blue', '2026-01-15': 'red' });
  const estimate = { dayType: 'white', prices: { white_hp: 64.7, white_hc: 14.6 } };   // white shape, red prices
  const rows = expandWindows({ windows: tempoWindows, registerPrices: tempoPrices, tz, fromDate: '2026-01-15', toDate: '2026-01-16', calendar, estimate });
  const d16 = rows.filter((r) => r.localDate === '2026-01-16');
  assert.deepEqual(d16.map((r) => [r.register, r.price, r.estimated, r.dayType]), [
    ['red_hc', 14.6, false, 'red'],      // 00:00-06:00 belongs to the red day of the 15th, which is known
    ['white_hp', 64.7, true, 'white'],
    ['white_hc', 14.6, true, 'white'],
  ]);
  assertTiles(rows, tz, '2026-01-15', '2026-01-16');
  assert.throws(() => expandWindows({ windows: tempoWindows, registerPrices: tempoPrices, tz, fromDate: '2026-01-16', toDate: '2026-01-16', calendar }), /unknown and no estimate/);
});

test('Tempo on the spring-forward day: the night of the 28th is 5 real hours', () => {
  const tz = 'Europe/Paris';
  const rows = expandWindows({ windows: tempoWindows, registerPrices: tempoPrices, tz, fromDate: '2026-03-29', toDate: '2026-03-29', calendar: tempo({ '2026-03-28': 'blue', '2026-03-29': 'white' }) });
  assert.deepEqual(rows.map((r) => [r.register, len(r) / H]), [['blue_hc', 5], ['white_hp', 16], ['white_hc', 2]]);
  assertTiles(rows, tz, '2026-03-29', '2026-03-29');
});

// ───────────── Errors and prices ─────────────

test('overlapping windows, uncovered time and missing prices fail loudly', () => {
  const tz = 'Europe/Paris';
  const base = { tz, fromDate: '2026-10-23', toDate: '2026-10-23' };
  assert.throws(() => expandWindows({ ...base, windows: [{ register: 'hc', start_min: 1320, end_min: 360 }, { register: 'hp', start_min: 300, end_min: 1380 }] }), /overlap/);
  assert.throws(() => expandWindows({ ...base, windows: hc0107 }), /no register window covers/);
  assert.throws(() => expandWindows({ ...base, windows: hc0107, defaultRegister: 'hp', registerPrices: { hc: 18 } }), /no price for register "hp"/);
  assert.throws(() => expandWindows({ ...base, windows: [{ register: 'x', start_min: 0, end_min: 0 }] }), /end_min/);
  // Without prices the windows still expand, priced null.
  assert.equal(expandWindows({ ...base, windows: hc0107, defaultRegister: 'hp' }).every((r) => r.price === null), true);
});

test('a price change inside the range cuts the interval; a superseded window is ignored', () => {
  const tz = 'Europe/Paris';
  const change = parseIso('2026-08-01T01:00:00Z');   // 03:00 Paris
  const rows = expandWindows({
    windows: [...hc0107, { register: 'hc', start_min: 0, end_min: 1440, superseded_at: 1 }],
    registerPrices: [{ register: 'hc', price: 18, valid_to: change }, { register: 'hc', price: 19, valid_from: change }, { register: 'hp', price: 25 }],
    defaultRegister: 'hp', tz, fromDate: '2026-08-01', toDate: '2026-08-01',
  });
  assert.deepEqual(of(rows, 'hc').map((r) => [r.price, ...span(r)]), [
    [18, '2026-07-31T23:00:00Z', '2026-08-01T01:00:00Z'],
    [19, '2026-08-01T01:00:00Z', '2026-08-01T05:00:00Z'],
  ]);
  assertTiles(rows, tz, '2026-08-01', '2026-08-01');
});

test('a UTC-clock window keeps its UTC instant all year', () => {
  const tz = 'Europe/London';
  const w = [{ register: 'cheap', start_min: 0, end_min: 360, clock: 'utc' }];
  for (const d of ['2026-01-15', '2026-07-15']) {
    const rows = expandWindows({ windows: w, defaultRegister: 'normal', tz, fromDate: d, toDate: d });
    assert.deepEqual(of(rows, 'cheap').map(span), [[`${d}T00:00:00Z`, `${d}T06:00:00Z`]]);
    assertTiles(rows, tz, d, d);
  }
});

// ───────────── Fixed charges ─────────────

// Slices of every slot of a period, in integer micro-minor units read back from the per-slot API.
function slices(amount, period, tz, p0, p1, slotS) {
  const out = [];
  for (let t = p0; t < p1; t += slotS) out.push(Math.round(fixedChargePerSlot(amount, period, t, slotS, tz) * 1e6));
  return out;
}
const total = (xs) => xs.reduce((s, x) => s + x, 0);

test('a monthly subscription adds up exactly over a month with a clock change', () => {
  for (const [tz, at, hours, slotS] of [
    ['Europe/Paris', '2026-10-15T12:00:00Z', 745, 1800],
    ['Europe/London', '2026-10-15T12:00:00Z', 745, 900],
    ['Europe/Paris', '2026-03-15T12:00:00Z', 743, 1800],
    ['Europe/London', '2026-03-15T12:00:00Z', 743, 3600],
  ]) {
    const [p0, p1] = periodBounds(tz, 'month', parseIso(at));
    assert.equal(p1 - p0, hours * H, `${tz} ${at}`);
    const xs = slices(1523.37, 'month', tz, p0, p1, slotS);
    assert.equal(xs.length, (hours * H) / slotS);
    assert.equal(total(xs), 1523370000, `${tz} ${at}`);
    assert.ok(Math.abs(xs[0] / 1e6 - (1523.37 * slotS) / (hours * H)) < 2e-6);
  }
  // A credit (negative) adds up exactly too, and so does a call spanning two months.
  const [o0, o1] = periodBounds('Europe/Paris', 'month', parseIso('2026-10-15T12:00:00Z'));
  assert.equal(total(slices(-500, 'month', 'Europe/Paris', o0, o1, 1800)), -500000000);
  const [, n1] = periodBounds('Europe/Paris', 'month', o1);
  assert.equal(fixedChargeMicro(1523.37, 'month', o0, n1, 'Europe/Paris'), 2 * 1523370000);
});

test('a daily standing charge is spread over 46, 48 or 50 half-hours and adds up exactly', () => {
  const tz = 'Europe/London';
  for (const [d, n] of [['2026-03-29', 46], ['2026-10-23', 48], ['2026-10-25', 50]]) {
    const [a, b] = dayBounds(tz, d);
    const xs = slices(62.74, 'day', tz, a, b, 1800);
    assert.equal(xs.length, n);
    assert.equal(total(xs), 62740000, d);
    assert.ok(Math.abs(xs[0] / 1e6 - 62.74 / n) < 2e-6, d);
  }
});

test('a yearly charge adds up exactly over a common and a leap year', () => {
  for (const [at, hours] of [['2026-06-01T00:00:00Z', 8760], ['2028-06-01T00:00:00Z', 8784]]) {
    const [p0, p1] = periodBounds('Europe/Paris', 'year', parseIso(at));
    assert.equal(p1 - p0, hours * H);
    assert.equal(total(slices(15000.5, 'year', 'Europe/Paris', p0, p1, 3600)), 15000500000);
  }
  assert.throws(() => fixedChargePerSlot(1, 'week', 0, 1800, 'Europe/Paris'), /charge period/);
});
