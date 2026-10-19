import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDay,
  dayView,
  energyRow,
  sensorCoverage,
  validDate,
  POWER,
  ENERGY,
  FLOWS,
} from '../src/core/demo.js';
import { slotsOfDay } from '../src/core/time.js';

const tz = 'Europe/London';
const date = '2026-10-17';
const slots = slotsOfDay(tz, date);
const row = (slot = slots[0]) => ({
  slot_start: slot,
  state: 'final',
  quality: 1,
  home: 1,
  solar: 0.5,
  grid_import: 0.2,
  grid_export: 0,
  battery_charge: 0,
  battery_discharge: 0.3,
  solar_to_home: 0.5,
  battery_to_home: 0.3,
  grid_to_home: 0.2,
  lineage: JSON.stringify({
    import: 'octopus_meter',
    export: 'octopus_meter',
    solar: 'sunsynk_5min',
    coverage: 1,
  }),
});
const coverage = (slot = slots[0]) => new Map(Object.values(POWER).map((k) => [`${k}:${slot}`, 1]));

test('demo chooses the newest closed fully final day, not yesterday or a partial day', () => {
  const days = [
    { local_date: '2026-10-19', slots: 12, slots_final: 12, expectedSlots: 48 },
    { local_date: '2026-10-18', slots: 48, slots_final: 2, expectedSlots: 48 },
    { local_date: '2026-10-17', slots: 48, slots_final: 48, expectedSlots: 48 },
  ];
  assert.equal(defaultDay(days, '2026-10-19'), '2026-10-17');
  assert.equal(defaultDay(days.slice(0, 2), '2026-10-19'), '2026-10-18');
  assert.equal(defaultDay(days.slice(0, 1), '2026-10-19'), '2026-10-19');
  assert.equal(defaultDay([], '2026-10-19'), null);
});

test('demo date validation rejects overflow dates and malformed input', () => {
  for (const d of ['2026-02-30', '2026-13-01', 'yesterday', '2026-1-01', null, {}, ['2026-10-17']])
    assert.equal(validDate(d), false);
  assert.equal(validDate('2024-02-29'), true);
});

test('missing solar samples are unavailable even when the core stored zero', () => {
  const r = row();
  r.solar = 0;
  const cov = coverage();
  cov.delete(`solar_w:${r.slot_start}`);
  const result = energyRow(r, cov);
  assert.equal(result.solar, null);
  assert.equal(result.grid_import, 0.2);
  assert.equal(result.home, null);
  assert.equal(result.solar_to_home, null);
  assert.equal(result.partial, true);
});

test('observed zero remains zero and is distinct from unavailable', () => {
  const r = row();
  r.solar = 0;
  const result = energyRow(r, coverage());
  assert.equal(result.solar, 0);
  assert.equal(result.grid_export, 0);
  assert.equal(result.partial, false);
});

test('coverage splits a sample at the half-hour boundary and caps its hold at five minutes', () => {
  const start = slots[0];
  const c = sensorCoverage([
    { metric: 'solar_w', ts: start + 1740, value: 10 },
    { metric: 'solar_w', ts: start + 6000, value: 20 },
  ]);
  assert.equal(c.get(`solar_w:${start}`), 60 / 1800);
  assert.equal(c.get(`solar_w:${start + 1800}`), 240 / 1800);
  assert.equal(c.has(`solar_w:${start + 3600}`), false);
});

test('null samples are gaps, and the next sample terminates the previous hold', () => {
  const start = slots[0];
  const c = sensorCoverage([
    { metric: 'load_w', ts: start, value: 10 },
    { metric: 'load_w', ts: start + 60, value: null },
  ]);
  assert.equal(c.get(`load_w:${start}`), 60 / 1800);
});

test('unbuilt elapsed slots are visible as missing and never summed as zero', () => {
  const result = dayView([row()], coverage(), date, tz, slots[47] + 1800);
  assert.equal(result.rows.length, 48);
  assert.equal(result.states.missing, 47);
  assert.equal(result.totals.solar.value, 0.5);
  assert.equal(result.totals.solar.knownSlots, 1);
  assert.equal(result.totals.solar.complete, false);
  for (const key of ENERGY) assert.equal(result.rows[1][key], null);
});

test('an entirely missing day has null totals, not zero totals', () => {
  const result = dayView([], new Map(), date, tz, slots[47] + 1800);
  for (const key of [...ENERGY, ...FLOWS]) assert.equal(result.totals[key].value, null);
});

test('demo handles 46 and 50 slot DST days and excludes future slots today', () => {
  const autumn = dayView([], new Map(), '2026-10-25', tz, Date.parse('2026-10-27') / 1000);
  const spring = dayView([], new Map(), '2027-03-28', tz, Date.parse('2027-03-30') / 1000);
  assert.equal(autumn.rows.length, 50);
  assert.equal(spring.rows.length, 46);
  const current = dayView([], new Map(), date, tz, slots[2] + 30);
  assert.equal(current.rows.length, 3);
  assert.equal(current.closed, false);
});

test('day totals are sums of the exact rows used by the timeline and evidence', () => {
  const cov = new Map([...coverage(slots[0]), ...coverage(slots[1])]);
  const d = dayView([row(slots[0]), row(slots[1])], cov, date, tz, slots[1] + 30);
  assert.equal(d.totals.home.value, 2);
  assert.equal(d.totals.home.complete, true);
  assert.equal(
    d.totals.solar.value,
    d.rows.reduce((s, r) => s + r.solar, 0)
  );
});
