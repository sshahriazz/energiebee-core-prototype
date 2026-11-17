// Sunsynk gives 5-minute samples as local "HH:mm"; clock changes must not lose or overwrite any.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { normaliseDay } = await import('../src/adapters/sunsynk.js');
for (const id of [1, 2, 3]) await db.prepare("INSERT INTO site (id, name, created_at) VALUES (?, 'dst', 0)").run(id);   // channels belong to a home
const { seriesId, readReadings } = await import('../src/core/facts.js');
const { isoUtc } = await import('../src/core/time.js');

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const day = async (siteId, date, times) => {
  const records = times.map(([h, m], i) => ({ time: hhmm(h, m), value: String(i) }));
  await normaliseDay(siteId, 'Europe/London', date, { code: 0, data: { infos: [{ label: 'PV', records }] } }, null);
  return await readReadings([await seriesId('site', siteId, 'solar_w', 'sunsynk_5min')], 0, 2e9);
};

await test('clocks go back: the repeated hour is kept as BST then GMT', async () => {
  const t = [];
  for (let h = 0; h < 2; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  for (let m = 0; m < 60; m += 5) t.push([1, m]);            // 01:00-01:55 again
  for (let h = 2; h < 24; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  const rows = await day(1, '2026-10-25', t);
  assert.equal(rows.length, 300);
  assert.ok(rows.every((r, i) => i === 0 || r.ts > rows[i - 1].ts), 'in time order, no duplicates');
  const at = (i) => isoUtc(rows.find((r) => r.value === i).ts);
  assert.equal(at(12), '2026-10-25T00:00:00Z');                // first 01:00 = BST
  assert.equal(at(24), '2026-10-25T01:00:00Z');                // second 01:00 = GMT
  assert.equal(at(299), '2026-10-25T23:55:00Z');
});

await test('clocks go back, the hour sent once (as Sunsynk does): it is the later, GMT run', async () => {
  // Sunsynk keys the day by clock time, so the repeat overwrites the first run: 25 October 2026 came as 279 records.
  const t = [];
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  const rows = await day(3, '2026-10-25', t);
  assert.equal(rows.length, 288);
  const at = (i) => isoUtc(rows.find((r) => r.value === i).ts);
  assert.equal(at(11), '2026-10-24T23:55:00Z');                // 00:55 BST
  assert.equal(at(12), '2026-10-25T01:00:00Z');                // the only 01:00 = GMT; the BST run (00:00-00:55 UTC) has no samples
  assert.equal(at(23), '2026-10-25T01:55:00Z');
  assert.equal(at(24), '2026-10-25T02:00:00Z');
});

await test('clocks go forward: times in the missing hour are dropped, not stacked', async () => {
  const t = [];
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 5) t.push([h, m]);
  const rows = await day(2, '2027-03-28', t);
  assert.equal(rows.length, 276);
  assert.equal(new Set(rows.map((r) => r.ts)).size, 276);
});
