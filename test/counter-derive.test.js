// Counters (core/counters.js, channel kind counter): a cumulative reading becomes the energy of each period by difference.
// SYNTHETIC smart plug in an empty database: a constant 1 kW load, so every expected number is worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { ingestObservations, defineChannel } = await import('../src/core/channels.js');
const { seriesId, readIntervals, readReadings, QUALITY } = await import('../src/core/facts.js');
const { classifyStep, deriveCounterPeriods } = await import('../src/core/counters.js');
const { dayBounds } = await import('../src/core/time.js');

const NOW = 2000000000;   // a clock far ahead of every test time, so the future check never fires here
const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('iot', 0)").run().lastInsertRowid);
db.prepare("INSERT INTO source (code, name, contract) VALUES ('plug_vendor', 'Plug vendor (test)', '{}')").run();
let n = 0;
const plug = () => Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'smart_plug', 'test', ?, 'plug', '{}', 0)").run(site, `plug-${++n}`).lastInsertRowid);
const feed = (dev, samples, point = 'energy_total') => ingestObservations(site, 'plug_vendor', samples.map(([ts, value]) => ({ point, ts, value })), null, { deviceId: dev, now: NOW });
const periods = (dev) => readIntervals([seriesId('device', dev, 'plug_kwh', 'plug_vendor')], 0, 3e9).map((r) => [r.start_ts, r.end_ts, r.value, r.quality]);
const raw = (dev) => readReadings([seriesId('device', dev, 'plug_counter_kwh', 'plug_vendor')], 0, 3e9).map((r) => [r.ts, r.value]);
const total = (dev) => periods(dev).reduce((s, p) => s + p[2], 0);
const rejects = () => db.prepare('SELECT point, ts, value, reason FROM channel_reject ORDER BY id').all();
const H = 3600;
const pause = (ms = 5) => { const t = Date.now() + ms; while (Date.now() < t); };   // two versions of one reading need different recorded_at (ms)

test('the pure steps: increase, wrap, reset, backwards', () => {
  assert.deepEqual(classifyStep(10, 12.5, {}), { type: 'increase', energy: 2.5 });
  assert.deepEqual(classifyStep(995, 3, { counter_wrap: 1000 }), { type: 'wrap', energy: 8 });
  assert.deepEqual(classifyStep(50, 2, {}), { type: 'reset', energy: 2 }, 'a drop to under a tenth of the reading is a reset');
  assert.deepEqual(classifyStep(50, 2, { counter_reset_below: 1 }), { type: 'backwards', energy: null }, 'unless the channel says otherwise');
  assert.equal(classifyStep(50, 30, {}).type, 'backwards');
  const { periods: p } = deriveCounterPeriods([{ ts: 20, value: 5 }, { ts: 0, value: 1 }, { ts: 20, value: 6 }, { ts: 10, value: 3 }], {});
  assert.deepEqual(p.map((x) => [x.start, x.end, x.value]), [[0, 10, 2], [10, 20, 3]], 'any order, the later of two with one time wins');
});

for (const [date, hours, label] of [['2026-10-25', 25, 'the 25-hour day (clocks go back)'], ['2027-03-28', 23, 'the 23-hour day (clocks go forward)'], ['2026-10-10', 24, 'a normal day']]) {
  test(`a daily counter that resets at local midnight, ${label}: the day's energy is conserved`, () => {
    const dev = plug();
    const [a, b] = dayBounds('Europe/London', date);
    assert.equal((b - a) / H, hours);
    const at = (t) => (t - a) / H;                                        // 1 kW: the counter is the hours since midnight
    const samples = [];
    for (let t = a; t < b; t += 1800) samples.push([t, at(t)]);
    samples.push([b - 1, at(b - 1)], [b, 0]);                              // the last sample of the day, then the reset
    const out = feed(dev, samples);
    assert.equal(out.rejected, 0);
    const day = periods(dev);
    assert.ok(Math.abs(total(dev) - hours) <= 1 / H + 1e-9, `${total(dev)} kWh vs ${hours}: only the second between the last sample and the reset is lost`);
    const last = day[day.length - 1];
    assert.deepEqual([last[0], last[1], last[2]], [b - 1, b, 0]);
    assert.ok(last[3] & QUALITY.PARTIAL, 'the reset period is flagged partial: what happened before the reset is unknown');
    assert.ok(day.slice(0, -1).every((p) => !(p[3] & QUALITY.PARTIAL)), 'every other period is a clean measurement');
  });
}

test('a device restart mid-day: the counter drops to nearly zero, only what the counter shows after it is counted, flagged partial', () => {
  const dev = plug();
  feed(dev, [[0, 10], [1800, 12], [3600, 15], [5400, 0.2], [7200, 0.7]]);
  assert.deepEqual(periods(dev).map((p) => [p[0], Math.round(p[2] * 1e9) / 1e9]), [[0, 2], [1800, 3], [3600, 0.2], [5400, 0.5]]);
  assert.ok(periods(dev)[2][3] & QUALITY.PARTIAL);
});

test('a wrap at the maximum counts the energy across the roll-over', () => {
  const dev = plug();
  defineChannel(site, 'plug_vendor', 'rollover', 'plug_counter_kwh', { kind: 'counter', derived: 'plug_kwh', counterWrap: 1000, min: 0, max: 1000, deviceId: dev });
  feed(dev, [[0, 990], [1800, 995], [3600, 3], [5400, 10]], 'rollover');
  assert.deepEqual(periods(dev).map((p) => p[2]), [5, 8, 7]);
  assert.ok(periods(dev).every((p) => !(p[3] & QUALITY.PARTIAL)));
});

test('a counter going backwards is rejected and recorded, never stored, and the energy around it is still right', () => {
  const dev = plug();
  const before = rejects().length;
  const out = feed(dev, [[0, 100], [1800, 110], [3600, 105], [5400, 120]]);
  assert.equal(out.rejected, 1);
  const r = rejects().slice(before);
  assert.deepEqual(r.map((x) => [x.point, x.ts, x.value, x.reason]), [['energy_total', 3600, 105, 'counter_backwards']]);
  assert.deepEqual(raw(dev).map((x) => x[1]), [100, 110, 120], '105 is not in the stored readings');
  assert.deepEqual(periods(dev).map((p) => p[2]), [10, 10]);
});

test('a negative or out-of-range counter is rejected by the channel range, not stored', () => {
  const dev = plug();
  const out = feed(dev, [[0, 5], [1800, -1]]);
  assert.equal(out.rejected, 1);
  assert.deepEqual(raw(dev).map((x) => x[1]), [5]);
});

test('a gap keeps the counter total, spread over the gap and flagged estimated, never invented', () => {
  const dev = plug();
  feed(dev, [[0, 0], [1800, 0.5], [1800 + 5 * H, 5.5]]);
  const p = periods(dev);
  assert.deepEqual(p.map((x) => [x[0], x[1], x[2]]), [[0, 1800, 0.5], [1800, 1800 + 5 * H, 5]]);
  assert.ok(p[1][3] & QUALITY.ESTIMATED, 'the five-hour period is flagged estimated');
  assert.ok(!(p[0][3] & QUALITY.ESTIMATED));
  assert.equal(total(dev), 5.5, 'the counter difference, exactly');
});

test('duplicate and late samples: the same data again writes nothing, a late sample splits the period it falls in, nothing is counted twice', () => {
  const dev = plug();
  feed(dev, [[0, 0], [2 * H, 10]]);
  assert.deepEqual(periods(dev).map((p) => p[2]), [10]);
  const again = feed(dev, [[0, 0], [2 * H, 10], [2 * H, 10]]);
  assert.deepEqual([again.counters, again.derived], [0, 0], 'identical samples, even twice in one batch: nothing new');

  const corrections = db.prepare('SELECT COUNT(*) n FROM fact_correction').get().n;
  pause();
  feed(dev, [[H, 4]]);                                                    // arrives late, between the two
  assert.deepEqual(periods(dev).map((p) => [p[0], p[1], p[2]]), [[0, H, 4], [H, 2 * H, 6]]);
  assert.equal(total(dev), 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fact_correction').get().n, corrections + 1, 'the superseded period is logged');
  const old = db.prepare("SELECT COUNT(*) n FROM interval_fact WHERE series_id = ? AND start_ts = 0 AND end_ts = ? AND superseded_at IS NOT NULL").get(seriesId('device', dev, 'plug_kwh', 'plug_vendor'), 2 * H).n;
  assert.equal(old, 1, 'the old period is kept, superseded');

  pause();
  feed(dev, [[H, 5]]);                                                    // the same time with a corrected value: a new version
  assert.deepEqual(periods(dev).map((p) => p[2]), [5, 5]);
  assert.equal(total(dev), 10);
});

test('a late sample that would make the counter go backwards is rejected against its stored neighbours', () => {
  const dev = plug();
  feed(dev, [[0, 0], [2 * H, 10]]);
  const out = feed(dev, [[H, 12]]);                                       // higher than the reading after it
  assert.equal(out.rejected, 1);
  assert.deepEqual(raw(dev).map((x) => x[1]), [0, 10]);
});
