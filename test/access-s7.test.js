// S7: a home shared between U1 (owner) and U2 (viewer, energy scope). U2 sees energy and cost but cannot
// command; revoking U2 removes the home from U2's groups, history included. Also: a group shared with someone
// who has no grant on one member hides that member; a grant can limit the period shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { makeHome, fillSlots } = await import('./groups-fixtures.js');
const G = await import('../src/core/groups.js');
const A = await import('../src/core/access.js');
const { dayBounds } = await import('../src/core/time.js');

const LON = 'Europe/London';
const FROM = Date.UTC(2025, 9, 20) / 1000; const TO = Date.UTC(2025, 9, 30) / 1000;
const home = { tz: LON, slotS: 1800, currency: 'GBP', country: 'GB' };
const mine = makeHome(home); const other = makeHome(home);
fillSlots(mine, { ...home, from: FROM, to: TO }); fillSlots(other, { ...home, from: FROM, to: TO, shape: (ts, d) => ({ solar: d.solar * 2 }) });
const u1 = A.createUser({ name: 'u1' }); const u2 = A.createUser({ name: 'u2' });
A.grantSite({ siteId: mine, userId: u1, role: 'owner', scope: 'all', now: 100 });
A.grantSite({ siteId: other, userId: u1, role: 'owner', scope: 'all', now: 100 });
const g = G.createGroup({ name: 'U1 group', ownerId: u1, timezone: LON });
G.addMember(g, mine); G.addMember(g, other);
G.shareGroup({ groupId: g, userId: u2, role: 'viewer', now: 200 });

test('S7: a viewer with energy scope sees energy and cost but cannot command', () => {
  A.grantSite({ siteId: mine, userId: u2, role: 'viewer', scope: 'energy', now: 300 });
  assert.equal(A.canView(u2, mine), true);
  assert.equal(A.canControl(u2, mine), false, 'a viewer never commands');
  assert.equal(A.canControl(u1, mine), true);
  assert.equal(A.canControl(u2, other), false);
  const d = G.groupDay(g, '2025-10-24', { viewer: u2 });
  assert.deepEqual(d.sites, [mine], 'only the home the viewer may read');
  assert.ok(d.day.values.solar > 0 && d.day.money.GBP.values.total_cost > 0, 'energy and cost are visible');
});

test('S7: a group shared with someone who has no grant on one member hides that member, with no trace', () => {
  const solo = G.groupDay(G.createGroup({ name: 'mine only', ownerId: u1, timezone: LON }), '2025-10-24');   // empty group, for the shape
  void solo;
  const viaGroup = G.groupDay(g, '2025-10-24', { viewer: u2 });
  const both = G.groupDay(g, '2025-10-24', { viewer: u1 });
  assert.equal(both.sites.length, 2);
  assert.equal(viaGroup.sites.length, 1);
  // Nothing in the viewer's result depends on the hidden home: the figures equal the visible home alone.
  const [a, b] = dayBounds(LON, '2025-10-24');
  const alone = G.createGroup({ name: 'alone', ownerId: u1, timezone: LON }); G.addMember(alone, mine);
  assert.deepEqual(viaGroup.day.values, G.groupDay(alone, '2025-10-24').day.values);
  assert.ok(Math.abs(both.day.values.solar - viaGroup.day.values.solar) > 1e-6);
  assert.ok(!JSON.stringify(viaGroup).includes(`"${other}"`), 'the hidden home\'s id appears nowhere');
  void a; void b;
});

test('S7: someone with no access to the group is refused', () => {
  const u3 = A.createUser({ name: 'u3' });
  assert.throws(() => G.groupDay(g, '2025-10-24', { viewer: u3 }), /no access/);
  assert.equal(G.canViewGroup(u3, g), false);
});

test('S7: revoking removes the home from the viewer\'s group, history included', () => {
  assert.equal(A.revokeSite({ siteId: mine, userId: u2, now: 400 }), 1);
  assert.equal(A.canView(u2, mine), false);
  for (const day of ['2025-10-22', '2025-10-24', '2025-10-27']) {
    const d = G.groupDay(g, day, { viewer: u2 });
    assert.deepEqual(d.sites, [], `${day}: no home left`);
    assert.equal(d.buckets.every((x) => x.members === 0), true);
  }
  // The owner still sees everything, and the as-of evaluation of a past moment still sees the grant that existed then.
  assert.equal(G.groupDay(g, '2025-10-24', { viewer: u1 }).sites.length, 2);
  assert.equal(A.canView(u2, mine, 350), true, 'the grant existed at 350');
});

test('S7: a grant limited to a period shows only that period', () => {
  const u4 = A.createUser({ name: 'u4' });
  const [from] = dayBounds(LON, '2025-10-24'); const [, to] = dayBounds(LON, '2025-10-25');
  A.grantSite({ siteId: mine, userId: u4, role: 'viewer', scope: 'energy', validFrom: from, validTo: to, now: 500 });
  G.shareGroup({ groupId: g, userId: u4, now: 500 });
  assert.deepEqual(G.groupDay(g, '2025-10-23', { viewer: u4 }).sites, []);
  assert.deepEqual(G.groupDay(g, '2025-10-24', { viewer: u4 }).sites, [mine]);
  assert.deepEqual(G.groupDay(g, '2025-10-26', { viewer: u4 }).sites, []);
});

test('a control-only grant commands but reads nothing; an operator with energy scope reads but cannot command', () => {
  const u5 = A.createUser({ name: 'u5' }); const u6 = A.createUser({ name: 'u6' });
  A.grantSite({ siteId: mine, userId: u5, role: 'operator', scope: 'control', now: 600 });
  A.grantSite({ siteId: mine, userId: u6, role: 'operator', scope: 'energy', now: 600 });
  assert.deepEqual([A.canView(u5, mine), A.canControl(u5, mine)], [false, true]);
  assert.deepEqual([A.canView(u6, mine), A.canControl(u6, mine)], [true, false]);
  assert.deepEqual(A.visibleSites(u6), [mine]);
});
