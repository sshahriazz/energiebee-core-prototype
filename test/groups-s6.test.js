// S6: a home leaves a group on day X. Group days before X include it, days from X do not, and the report
// as it was recorded before the change runs again identically (membership is kept in transaction time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { makeHome, fillSlots } = await import('./groups-fixtures.js');
const G = await import('../src/core/groups.js');
const A = await import('../src/core/access.js');
const { dayBounds } = await import('../src/core/time.js');

const LON = 'Europe/London';
const FROM = Date.UTC(2025, 9, 20) / 1000; const TO = Date.UTC(2025, 9, 30) / 1000;
const home = { tz: LON, slotS: 1800, currency: 'GBP', country: 'GB' };
const a = await makeHome(home); const b = await makeHome(home);
await fillSlots(a, { ...home, from: FROM, to: TO });
await fillSlots(b, { ...home, from: FROM, to: TO, shape: (ts, d) => ({ solar: d.solar * 3, grid_import: d.grid_import * 3 }) });
const owner = await A.createUser({ name: 'o' });
const g = await G.createGroup({ name: 'Pair', ownerId: owner, timezone: LON });
await G.addMember(g, a, { now: 1000 }); await G.addMember(g, b, { now: 1000 });

const days = ['2025-10-22', '2025-10-23', '2025-10-24', '2025-10-25', '2025-10-26'];
const report = async (opts = {}) => (await G.groupRange(g, days[0], days[4], opts)).days.map((d) => ({ date: d.date, solar: d.day.values.solar, members: d.sites.length, gbp: d.day.money.GBP?.values.total_cost ?? null }));

await test('S6: leaving on day X keeps the earlier days and drops the later ones', async () => {
  const before = await report();
  const [x] = dayBounds(LON, '2025-10-24');
  assert.equal(await G.endMembership(g, b, x, { now: 2000 }), 1);
  const after = await report();
  const [d0, d1] = [dayBounds(LON, '2025-10-22'), dayBounds(LON, '2025-10-23')];
  void d0; void d1;
  for (const i of [0, 1]) assert.deepEqual(after[i], before[i], `${days[i]} still includes the home that left later`);
  for (const i of [2, 3, 4]) {
    assert.equal(after[i].members, 1, `${days[i]}: one home`);
    assert.ok(after[i].solar < before[i].solar, `${days[i]}: less solar without the home`);
  }
  // The home's three-times larger solar is exactly the difference.
  assert.ok(Math.abs(before[2].solar - after[2].solar - 0.75 * before[2].solar) < 1e-9);
});

await test('S6: the report as recorded before the change runs again identically', async () => {
  const asRecorded = await report({ knownAt: 1500 });   // after both were added, before the home was removed
  const now = await report();
  const first = asRecorded.slice(0, 2); assert.deepEqual(now.slice(0, 2), first);
  assert.equal(asRecorded[3].members, 2, 'as recorded then, the home was still in the group on later days');
  assert.notDeepEqual(asRecorded[3], now[3]);
  assert.deepEqual(await report({ knownAt: 1500 }), asRecorded, 'asking again gives the same report');
});

await test('S6: a home that rejoins later counts again from then on', async () => {
  const [y] = dayBounds(LON, '2025-10-26');
  await G.addMember(g, b, { from: y, now: 3000 });
  const r = await report();
  assert.equal(r[3].members, 1);
  assert.equal(r[4].members, 2);
});
