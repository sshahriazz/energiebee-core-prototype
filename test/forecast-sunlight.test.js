// learnSunlight on a home whose solar output never varies (no panels reported, or every reading 0):
// it used to answer ok with r2 null, and the forecast's method text then threw on r2.toFixed, so
// /forecast and /ev answered 500 for that home. Now that history is not fitted, with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { learnSunlight } = await import('../src/core/forecast.js');

function history(solarOf) {
  const hist = []; const sun = new Map(); const whole = new Set();
  for (let d = 0; d < 10; d++) {
    const date = `2026-10-${10 + d}`; whole.add(date);
    for (let k = 16; k < 32; k++) {
      const t = 1_793_000_000 + d * 86400 + k * 1800;
      hist.push({ slot_start: t, k, solar: solarOf(k), local_date: date });
      sun.set(t, 0.2 + (k % 5) / 10);
    }
  }
  return { hist, sun, whole };
}

test('solar that is always 0 is not fitted: ok false with a reason, no null r2', () => {
  const { hist, sun, whole } = history(() => 0);
  const r = learnSunlight(hist, sun, whole);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no solar recorded/);
});

test('solar that follows the sunlight is fitted with a numeric r2', () => {
  const { hist, sun, whole } = history((k) => 0.1 + (k % 5) / 20);
  const r = learnSunlight(hist, sun, whole);
  assert.equal(r.ok, true);
  assert.equal(typeof r.r2, 'number');
});
