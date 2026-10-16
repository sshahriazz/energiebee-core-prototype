// Local days and clock changes (Europe/London).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotsOfDay, localToUtcAll, isoUtc } from '../src/core/time.js';

const tz = 'Europe/London';

test('a local day has 48 half-hours, 50 when clocks go back, 46 when they go forward', () => {
  assert.equal(slotsOfDay(tz, '2026-10-24').length, 48);
  assert.equal(slotsOfDay(tz, '2026-10-25').length, 50);
  assert.equal(slotsOfDay(tz, '2027-03-28').length, 46);
});

test('01:30 on the day clocks go back happens twice', () => {
  assert.deepEqual(localToUtcAll(tz, 2026, 10, 25, 1, 30).map(isoUtc), ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']);
});

test('01:30 on the day clocks go forward does not exist', () => {
  assert.deepEqual(localToUtcAll(tz, 2027, 3, 28, 1, 30), []);
});

test('an ordinary time maps to one instant', () => {
  assert.deepEqual(localToUtcAll(tz, 2026, 10, 16, 12, 0).map(isoUtc), ['2026-10-16T11:00:00Z']);
});
