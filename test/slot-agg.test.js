// What a point looks like over one slot, by class (plan 3.1, src/core/slot-agg.js). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateInstants, aggregatePeriods, aggregateCounter, aggregateEvents, aggregateSlot } from '../src/core/slot-agg.js';

const S = 1_800_000_000; const E = S + 1800;

await test('a measurement: time-weighted mean over the covered time, min, max, last; a sample holds until the next, or holdS', () => {
  const r = aggregateInstants('measurement', [{ ts: S, value: 100 }, { ts: S + 900, value: 300 }], S, E, { holdS: 900 });
  assert.deepEqual([r.mean, r.min, r.max, r.last, r.coverage], [200, 100, 300, 300, 1]);
  const gap = aggregateInstants('measurement', [{ ts: S, value: 100 }], S, E, { holdS: 600 });
  assert.deepEqual([gap.mean, gap.coverage], [100, 0.333333333], 'held for 600 s, then nothing: a third of the slot');
  const carried = aggregateInstants('measurement', [{ ts: S - 100, value: 50 }, { ts: S + 1000, value: 150 }], S, E, { holdS: 300 });
  assert.equal(carried.min, 50, 'a sample just before the slot holds into it');
  assert.equal(aggregateInstants('measurement', [], S, E).coverage, 0);
  assert.equal(aggregateInstants('measurement', [], S, E).mean, null, 'no data is no value, never zero');
  assert.equal(aggregateInstants('measurement', [{ ts: S, value: null }], S, E).mean, null, 'a missing sample is a gap');
});

await test('a state: the share of the covered time in each value, and the one held longest', () => {
  const r = aggregateInstants('state', [{ ts: S, value: 0 }, { ts: S + 600, value: 1 }], S, E, { holdS: 1200 });
  assert.deepEqual(r.state_shares, { 0: 0.333333333, 1: 0.666666667 });
  assert.equal(r.state, 1);
});

await test('a setpoint stays in force until it changes', () => {
  const r = aggregateInstants('setpoint', [{ ts: S - 86400, value: 18 }, { ts: S + 900, value: 21 }], S, E);
  assert.deepEqual([r.coverage, r.last, r.min, r.max], [1, 21, 18, 21]);
});

await test('a total from periods: the part of each period inside the slot; a gap lowers the coverage', () => {
  const whole = aggregatePeriods([{ start: S, end: E, value: 0.5 }], S, E);
  assert.deepEqual([whole.delta, whole.coverage], [0.5, 1]);
  const hours = aggregatePeriods([{ start: S - 1800, end: S + 1800, value: 2 }], S, E);
  assert.equal(hours.delta, 1, 'half of a one-hour period of 2 kWh');
  const half = aggregatePeriods([{ start: S, end: S + 900, value: 0.2 }], S, E);
  assert.deepEqual([half.delta, half.coverage], [0.2, 0.5]);
  assert.equal(aggregatePeriods([], S, E).delta, null);
});

await test('a total from a counter: the change across the slot on the line between readings; a fall is unknown, not negative', () => {
  const ok = aggregateCounter([{ ts: S - 600, value: 100 }, { ts: S + 600, value: 112 }, { ts: S + 2400, value: 130 }], S, E);
  assert.deepEqual([ok.delta, ok.coverage], [18, 1], '106 at the start of the slot, 124 at its end');
  const reset = aggregateCounter([{ ts: S - 600, value: 100 }, { ts: S + 600, value: 3 }, { ts: S + 2400, value: 20 }], S, E);
  assert.deepEqual([reset.delta, reset.coverage], [null, 0]);
  assert.equal(aggregateCounter([{ ts: S + 100, value: 1 }], S, E).delta, null, 'no reading before the slot: unknown');
});

await test('events: how many touch the slot and the share it is covered', () => {
  const r = aggregateEvents([{ start: S - 100, end: S + 300 }, { start: S + 200, end: S + 500 }, { start: E + 10, end: E + 20 }], S, E);
  assert.deepEqual([r.delta, r.state_shares.active, r.state], [2, 0.277777778, 'active']);
  assert.equal(aggregateEvents([], S, E).state, null);
});

await test('aggregateSlot picks the aggregator by class and by the shape of the data', () => {
  assert.equal(aggregateSlot('total', { periods: [{ start: S, end: E, value: 1 }] }, S, E).delta, 1);
  assert.equal(aggregateSlot('total', { readings: [{ ts: S, value: 5 }, { ts: E, value: 7 }] }, S, E).delta, 2);
  assert.equal(aggregateSlot('measurement', { samples: [{ ts: S, value: 4 }] }, S, E, { holdS: 1800 }).mean, 4);
  assert.equal(aggregateSlot('event', { periods: [] }, S, E).delta, 0);
});
