// S7: a home shared between U1 (owner) and U2 (viewer, energy scope). U2 sees energy and cost but cannot
// command; revoking U2 removes the home from U2's groups, history included. Also: a group shared with someone
// who has no grant on one member hides that member; a grant can limit the period shown.
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
const mine = await makeHome(home); const other = await makeHome(home);
await fillSlots(mine, { ...home, from: FROM, to: TO }); await fillSlots(other, { ...home, from: FROM, to: TO, shape: (ts, d) => ({ solar: d.solar * 2 }) });
const u1 = await A.createUser({ name: 'u1' }); const u2 = await A.createUser({ name: 'u2' });
await A.grantSite({ siteId: mine, userId: u1, role: 'owner', scope: 'all', now: 100 });
await A.grantSite({ siteId: other, userId: u1, role: 'owner', scope: 'all', now: 100 });
const g = await G.createGroup({ name: 'U1 group', ownerId: u1, timezone: LON });
await G.addMember(g, mine); await G.addMember(g, other);
await G.shareGroup({ groupId: g, userId: u2, role: 'viewer', now: 200 });

await test('S7: a viewer with energy scope sees energy and cost but cannot command', async () => {
  await A.grantSite({ siteId: mine, userId: u2, role: 'viewer', scope: 'energy', now: 300 });
  assert.equal(await A.canView(u2, mine), true);
  assert.equal(await A.canControl(u2, mine), false, 'a viewer never commands');
  assert.equal(await A.canControl(u1, mine), true);
  assert.equal(await A.canControl(u2, other), false);
  const d = await G.groupDay(g, '2025-10-24', { viewer: u2 });
  assert.deepEqual(d.sites, [mine], 'only the home the viewer may read');
  assert.ok(d.day.values.solar > 0 && d.day.money.GBP.values.total_cost > 0, 'energy and cost are visible');
});

await test('S7: a group shared with someone who has no grant on one member hides that member, with no trace', async () => {
  const solo = await G.groupDay(await G.createGroup({ name: 'mine only', ownerId: u1, timezone: LON }), '2025-10-24');   // empty group, for the shape
  void solo;
  const viaGroup = await G.groupDay(g, '2025-10-24', { viewer: u2 });
  const both = await G.groupDay(g, '2025-10-24', { viewer: u1 });
  assert.equal(both.sites.length, 2);
  assert.equal(viaGroup.sites.length, 1);
  // Nothing in the viewer's result depends on the hidden home: the figures equal the visible home alone.
  const [a, b] = dayBounds(LON, '2025-10-24');
  const alone = await G.createGroup({ name: 'alone', ownerId: u1, timezone: LON }); await G.addMember(alone, mine);
  assert.deepEqual(viaGroup.day.values, (await G.groupDay(alone, '2025-10-24')).day.values);
  assert.ok(Math.abs(both.day.values.solar - viaGroup.day.values.solar) > 1e-6);
  assert.ok(!JSON.stringify(viaGroup).includes(`"${other}"`), 'the hidden home\'s id appears nowhere');
  void a; void b;
});

await test('S7: someone with no access to the group is refused', async () => {
  const u3 = await A.createUser({ name: 'u3' });
  await assert.rejects(async () => await G.groupDay(g, '2025-10-24', { viewer: u3 }), /no access/);
  assert.equal(await G.canViewGroup(u3, g), false);
});

await test('S7: revoking removes the home from the viewer\'s group, history included', async () => {
  assert.equal(await A.revokeSite({ siteId: mine, userId: u2, now: 400 }), 1);
  assert.equal(await A.canView(u2, mine), false);
  for (const day of ['2025-10-22', '2025-10-24', '2025-10-27']) {
    const d = await G.groupDay(g, day, { viewer: u2 });
    assert.deepEqual(d.sites, [], `${day}: no home left`);
    assert.equal(d.buckets.every((x) => x.members === 0), true);
  }
  // The owner still sees everything, and the as-of evaluation of a past moment still sees the grant that existed then.
  assert.equal((await G.groupDay(g, '2025-10-24', { viewer: u1 })).sites.length, 2);
  assert.equal(await A.canView(u2, mine, 350), true, 'the grant existed at 350');
});

await test('S7: a grant limited to a period shows only that period', async () => {
  const u4 = await A.createUser({ name: 'u4' });
  const [from] = dayBounds(LON, '2025-10-24'); const [, to] = dayBounds(LON, '2025-10-25');
  await A.grantSite({ siteId: mine, userId: u4, role: 'viewer', scope: 'energy', validFrom: from, validTo: to, now: 500 });
  await G.shareGroup({ groupId: g, userId: u4, now: 500 });
  assert.deepEqual((await G.groupDay(g, '2025-10-23', { viewer: u4 })).sites, []);
  assert.deepEqual((await G.groupDay(g, '2025-10-24', { viewer: u4 })).sites, [mine]);
  assert.deepEqual((await G.groupDay(g, '2025-10-26', { viewer: u4 })).sites, []);
});

await test('a control-only grant commands but reads nothing; an operator with energy scope reads but cannot command', async () => {
  const u5 = await A.createUser({ name: 'u5' }); const u6 = await A.createUser({ name: 'u6' });
  await A.grantSite({ siteId: mine, userId: u5, role: 'operator', scope: 'control', now: 600 });
  await A.grantSite({ siteId: mine, userId: u6, role: 'operator', scope: 'energy', now: 600 });
  assert.deepEqual([await A.canView(u5, mine), await A.canControl(u5, mine)], [false, true]);
  assert.deepEqual([await A.canView(u6, mine), await A.canControl(u6, mine)], [true, false]);
  assert.deepEqual(await A.visibleSites(u6), [mine]);
});
