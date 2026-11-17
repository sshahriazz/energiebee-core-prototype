// Sample gaps (src/core/build.js integrate): a gap of up to 2 hours between two samples is filled on the straight line between
// them and reported as filled time, not coverage; a longer gap stays empty. Covered time is integrated exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { integrate } = await import('../src/core/build.js');
const SLOT = 1800;
const fl = (t) => t - (t % SLOT);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// 5-minute samples from `from` to `to` (exclusive) at a constant power.
const run = (from, to, w) => { const out = []; for (let t = from; t < to; t += 300) out.push({ ts: t, value: w, hold: 300 }); return out; };

await test('no gap: every slot is covered, nothing is filled, and the energy is power × time', () => {
  const it = integrate(run(0, 3600, 2000), SLOT, fl);
  assert.equal(it.cover.get(0), SLOT); assert.equal(it.cover.get(1800), SLOT);
  assert.equal(it.filled.size, 0);
  assert.ok(near(it.energy.get(0), 1) && near(it.energy.get(1800), 1));   // 2 kW for half an hour
});

await test('a missing hour (the clocks-back hour Sunsynk does not send) is filled on the line between its neighbours', () => {
  // 3 kW until 00:55, nothing 01:00-01:55, 3 kW again from 02:00: the hour is filled at 3 kW, as charging went on.
  const it = integrate([...run(0, 3600, 3000), ...run(7200, 10800, 3000)], SLOT, fl);
  for (const slot of [3600, 5400]) {
    assert.equal(it.cover.get(slot) ?? 0, 0, 'filled time is not measured coverage');
    assert.equal(it.filled.get(slot), SLOT);
    assert.ok(near(it.energy.get(slot), 1.5), `slot ${slot}: ${it.energy.get(slot)}`);
  }
});

await test('the fill follows the line between the two samples, not either one', () => {
  // 1 kW at 00:55, then 4 kW at 02:00: the power rises evenly over the 65 minutes between them.
  const it = integrate([{ ts: 3300, value: 1000, hold: 300 }, { ts: 7200, value: 4000, hold: 300 }], SLOT, fl);
  const p = (t) => 1000 + (3000 * (t - 3300)) / 3900;
  const expect = (a, b) => ((p(a) + p(b)) / 2) * (b - a) / 3.6e6;
  assert.ok(near(it.energy.get(3600), expect(3600, 5400)));
  assert.ok(near(it.energy.get(5400), expect(5400, 7200)));
});

await test('a gap longer than 2 hours stays empty', () => {
  const it = integrate([...run(0, 1800, 1000), ...run(1800 + 3 * 3600, 1800 + 3 * 3600 + 1800, 1000)], SLOT, fl);
  assert.equal(it.filled.size, 0);
  assert.equal(it.energy.get(3600) ?? 0, 0);
});
