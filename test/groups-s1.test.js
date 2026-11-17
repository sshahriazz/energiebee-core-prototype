// S1 (docs/slot-engine-stress-test.md): a group of GB30, GB15, NL15 and GB60 viewed in London time.
// Two money totals, never one; the Dutch home re-bucketed by slot start into London days; a bucket shorter
// than a member's slot refused; ratios recomputed from sums; the group's peak is not the sum of the peaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';
import { mapAsync } from "../src/core/async.js";

useDb();
const { db } = await import('../src/db/db.js');
const { makeHome, fillSlots } = await import('./groups-fixtures.js');
const G = await import('../src/core/groups.js');
const A = await import('../src/core/access.js');
const { dayBounds } = await import('../src/core/time.js');

const LON = 'Europe/London'; const AMS = 'Europe/Amsterdam';
const FROM = Date.UTC(2025, 9, 24, 12) / 1000; const TO = Date.UTC(2025, 9, 28, 12) / 1000;   // 26 Oct 2025: clocks go back in both zones
const homes = {
  gb30: { tz: LON, slotS: 1800, currency: 'GBP', country: 'GB' }, gb15: { tz: LON, slotS: 900, currency: 'GBP', country: 'GB' },
  nl15: { tz: AMS, slotS: 900, currency: 'EUR', country: 'NL' }, gb60: { tz: LON, slotS: 3600, currency: 'GBP', country: 'GB' },
};
const id = {};
for (const [k, h] of Object.entries(homes)) {
  id[k] = await makeHome(h);
  const shape = k === 'nl15' ? (ts) => ({ grid_import: 0.125 + 0.0004 * ((ts - FROM) / 900), grid_to_home: 0.125, home: 0.25, cost: 7, solar: 0.1 })   // import grows with time, so the hour a cut moves differs
    : k === 'gb60' ? (ts, d) => ({ grid_to_home: d.home * 0.9 })                                                                                        // a home that leans on the grid
      : () => ({});
  await fillSlots(id[k], { ...h, from: FROM, to: TO, shape });
}
const owner = await A.createUser({ name: 'owner' });
const group = await G.createGroup({ name: 'Everything', ownerId: owner, timezone: LON });
for (const k of Object.keys(homes)) await G.addMember(group, id[k]);

const sql = async (cols, ids, a, b) => await db.prepare(`SELECT ${cols} FROM site_hh WHERE site_id IN (${ids.join(',')}) AND slot_start >= ? AND slot_start < ?`).get(a, b);

await test('S1: two money totals (GBP and EUR), never one, each equal to its own homes\' slot costs', async () => {
  const [a, b] = dayBounds(LON, '2025-10-25');
  const d = await G.groupDay(group, '2025-10-25');
  assert.deepEqual(d.currencies, ['EUR', 'GBP']);
  assert.ok(!('total_cost' in d.day.values), 'no combined money figure');
  const gbp = (await sql('SUM(total_cost) s', [id.gb30, id.gb15, id.gb60], a, b)).s; const eur = (await sql('SUM(total_cost) s', [id.nl15], a, b)).s;
  assert.ok(Math.abs(d.day.money.GBP.values.total_cost - gbp) < 1e-9);
  assert.ok(Math.abs(d.day.money.EUR.values.total_cost - eur) < 1e-9);
  assert.ok(d.day.money.GBP.values.total_cost !== d.day.money.EUR.values.total_cost);
});

await test('S1: energy is summed over slot rows by slot start in the group\'s zone, flows equal the homes\' own sums', async () => {
  const [a, b] = dayBounds(LON, '2025-10-26');   // a 25-hour day
  assert.equal((b - a) / 3600, 25);
  const d = await G.groupDay(group, '2025-10-26');
  const all = Object.values(id);
  for (const c of ['solar', 'grid_import', 'home', 'solar_to_home', 'grid_to_home']) {
    assert.ok(Math.abs(d.day.values[c] - (await sql(`SUM(${c}) s`, all, a, b)).s) < 1e-9, c);
  }
  assert.equal(d.buckets.length, 25, 'hourly buckets on the 25-hour day (the longest member slot is one hour)');
  assert.equal(d.bucketS, 3600);
  assert.equal(d.day.state, 'final');
});

await test('S1: the Dutch home moved into a London day shifts by the hour between the zones (measured)', async () => {
  const nl = await G.createGroup({ name: 'NL in London', ownerId: owner, timezone: LON }); await G.addMember(nl, id.nl15);
  const own = await G.createGroup({ name: 'NL in Amsterdam', ownerId: owner, timezone: AMS }); await G.addMember(own, id.nl15);
  const inLondon = (await G.groupDay(nl, '2025-10-25')).day.values.grid_import;
  const inAmsterdam = (await G.groupDay(own, '2025-10-25')).day.values.grid_import;
  // Same slots, a different cut: Amsterdam's day starts at 22:00Z, London's at 23:00Z. The shift is one hour of import.
  const hourOfImport = (await sql('SUM(grid_import) s', [id.nl15], Date.UTC(2025, 9, 24, 22) / 1000, Date.UTC(2025, 9, 24, 23) / 1000)).s
    - (await sql('SUM(grid_import) s', [id.nl15], Date.UTC(2025, 9, 25, 22) / 1000, Date.UTC(2025, 9, 25, 23) / 1000)).s;
  assert.ok(Math.abs((inAmsterdam - inLondon) - hourOfImport) < 1e-9, `shift ${inAmsterdam - inLondon} = the first hour out, the last hour in`);
  console.log(`# NL15 2025-10-25 grid_import: ${inAmsterdam.toFixed(4)} kWh in Amsterdam's day, ${inLondon.toFixed(4)} kWh in London's day`);
});

await test('S1: a bucket shorter than a member\'s slot is refused; a slot is never split', async () => {
  const [a, b] = dayBounds(LON, '2025-10-25');
  await assert.rejects(async () => await G.groupSlots(group, a, b, { bucketS: 1800 }), /never split/);
  const withoutHourly = await G.createGroup({ name: 'no hourly', ownerId: owner, timezone: LON });
  for (const k of ['gb30', 'gb15', 'nl15']) await G.addMember(withoutHourly, id[k]);
  const r = await G.groupSlots(withoutHourly, a, b, { bucketS: 1800 });
  assert.equal(r.bucketS, 1800);
  assert.equal(r.buckets.length, (b - a) / 1800);
});

await test('S1: ratios are recomputed from the sums, not averaged; the group peak is not the sum of the homes\' peaks', async () => {
  const d = await G.groupDay(group, '2025-10-25');
  const [a, b] = dayBounds(LON, '2025-10-25');
  const v = d.day.values;
  assert.ok(Math.abs(d.day.ratios.self_sufficiency - (1 - v.grid_to_home / v.home)) < 1e-12);
  const perHome = await mapAsync(Object.values(id), async (h) => { const s = await sql('SUM(grid_to_home) g, SUM(home) h', [h], a, b); return 1 - s.g / s.h; });
  const meanOfRatios = perHome.reduce((t, x) => t + x, 0) / perHome.length;
  assert.ok(Math.abs(d.day.ratios.self_sufficiency - meanOfRatios) > 1e-4, 'the ratio of sums differs from the mean of ratios here');
  // Peak: the largest hourly summed import over the day, in kW; each home's own peak is at a different resolution.
  const hourly = d.buckets.map((x) => x.partial.grid_import);
  assert.ok(Math.abs(d.day.peak_import_kw - Math.max(...hourly)) < 1e-12);
  const sumOfPeaks = (await mapAsync(Object.values(id), async (h) => (await db.prepare('SELECT MAX(grid_import * 3600.0 / dur_s) m FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?').get(h, a, b)).m)).reduce((t, x) => t + x, 0);
  assert.ok(d.day.peak_import_kw < sumOfPeaks, `${d.day.peak_import_kw} < ${sumOfPeaks}`);
});

await test('S1: prices are weighted by the energy they apply to, per currency', async () => {
  await db.prepare('UPDATE site_hh SET import_rate_ex = 10 WHERE site_id IN (?, ?)').run(id.gb30, id.gb15);
  await db.prepare('UPDATE site_hh SET import_rate_ex = 40 WHERE site_id = ?').run(id.gb60);
  const [a, b] = dayBounds(LON, '2025-10-25');
  const d = await G.groupDay(group, '2025-10-25');
  const rows = await db.prepare('SELECT import_rate_ex r, grid_import w FROM site_hh WHERE site_id IN (?, ?, ?) AND slot_start >= ? AND slot_start < ?').all(id.gb30, id.gb15, id.gb60, a, b);
  const num = rows.reduce((t, x) => t + x.r * x.w, 0); const den = rows.reduce((t, x) => t + x.w, 0);
  const slotMean = (await G.groupSlots(group, a, b)).buckets[5].prices.GBP.import_rate_ex;
  const rowsOneHour = await db.prepare('SELECT import_rate_ex r, grid_import w FROM site_hh WHERE site_id IN (?, ?, ?) AND slot_start >= ? AND slot_start < ?').all(id.gb30, id.gb15, id.gb60, a + 5 * 3600, a + 6 * 3600);
  const exp = rowsOneHour.reduce((t, x) => t + x.r * x.w, 0) / rowsOneHour.reduce((t, x) => t + x.w, 0);
  assert.ok(Math.abs(slotMean - exp) < 1e-9);
  assert.ok(num / den > 10 && num / den < 40);
  assert.equal(d.buckets[5].prices.EUR.import_rate_ex, 10, 'the EUR price comes from the EUR home only');
});
