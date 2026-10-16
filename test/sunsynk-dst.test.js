// Sunsynk gives 5-minute samples as local "HH:mm"; clock changes must not lose or overwrite any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { normaliseDay } = await import('../src/adapters/sunsynk.js');
const { seriesId, readReadings } = await import('../src/core/facts.js');
const { isoUtc } = await import('../src/core/time.js');

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const day = (siteId, date, times) => {
  const records = times.map(([h, m], i) => ({ time: hhmm(h, m), value: String(i) }));
  normaliseDay(siteId, 'Europe/London', date, { code: 0, data: { infos: [{ label: 'PV', records }] } }, null);
  return readReadings([seriesId('site', siteId, 'solar_w', 'sunsynk_5min')], 0, 2e9);
};

test('clocks go back: the repeated hour is kept as BST then GMT', () => {
  const t = [];
  for (let h = 0; h < 2; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  for (let m = 0; m < 60; m += 5) t.push([1, m]);            // 01:00-01:55 again
  for (let h = 2; h < 24; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  const rows = day(1, '2026-10-25', t);
  assert.equal(rows.length, 300);
  assert.ok(rows.every((r, i) => i === 0 || r.ts > rows[i - 1].ts), 'in time order, no duplicates');
  const at = (i) => isoUtc(rows.find((r) => r.value === i).ts);
  assert.equal(at(12), '2026-10-25T00:00:00Z');                // first 01:00 = BST
  assert.equal(at(24), '2026-10-25T01:00:00Z');                // second 01:00 = GMT
  assert.equal(at(299), '2026-10-25T23:55:00Z');
});

test('clocks go forward: times in the missing hour are dropped, not stacked', () => {
  const t = [];
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  const rows = day(2, '2027-03-28', t);
  assert.equal(rows.length, 276);
  assert.equal(new Set(rows.map((r) => r.ts)).size, 276);
});
