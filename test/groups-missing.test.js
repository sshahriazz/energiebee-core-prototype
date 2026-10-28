// A missing member slot is not a zero; a group slot is final only if every member slot is final.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { makeHome, fillSlots } = await import('./groups-fixtures.js');
const G = await import('../src/core/groups.js');
const A = await import('../src/core/access.js');

const LON = 'Europe/London';
const FROM = Date.UTC(2025, 5, 10) / 1000; const TO = Date.UTC(2025, 5, 12) / 1000;
const home = { tz: LON, slotS: 1800, currency: 'GBP', country: 'GB' };
const a = makeHome(home); const b = makeHome(home);
fillSlots(a, { ...home, from: FROM, to: TO }); fillSlots(b, { ...home, from: FROM, to: TO });
const owner = A.createUser({ name: 'o' });
const g = G.createGroup({ name: 'Pair', ownerId: owner, timezone: LON });
G.addMember(g, a); G.addMember(g, b);
const T = Date.UTC(2025, 5, 11, 10) / 1000;   // 10:00 UTC, one hour bucket = two half-hour slots per home
const hour = (t = T) => G.groupSlots(g, t, t + 3600, { bucketS: 3600 }).buckets[0];   // two half-hour slots per home

test('all final: the hour is final, complete and summed', () => {
  const h = hour();
  assert.equal(h.state, 'final');
  assert.equal(h.missing_s, 0);
  assert.ok(h.values.solar > 0 && h.money.GBP.values.total_cost > 0);
  assert.equal(h.coverage, 1);
});

test('one provisional slot makes the hour provisional, with the seconds counted', () => {
  db.prepare("UPDATE site_hh SET state = 'provisional' WHERE site_id = ? AND slot_start = ?").run(b, T + 1800);
  const h = hour();
  assert.equal(h.state, 'provisional');
  assert.equal(h.provisional_s, 1800);
  assert.equal(h.final_s, 3 * 1800);
  assert.ok(h.values.solar > 0, 'a provisional figure is still a figure');
});

test('a missing slot (its zeros are not measurements) and a slot with no row both make the hour incomplete with null totals', () => {
  db.prepare("UPDATE site_hh SET state = 'missing', solar = 0, home = 0, total_cost = 1.5 WHERE site_id = ? AND slot_start = ?").run(b, T + 1800);
  let h = hour();
  assert.equal(h.state, 'incomplete');
  assert.equal(h.missing_s, 1800);
  assert.equal(h.values.solar, null, 'null, not a sum that looks complete');
  assert.equal(h.money.GBP.values.total_cost, null);
  const full = db.prepare('SELECT SUM(solar) s FROM site_hh WHERE site_id IN (?, ?) AND slot_start >= ? AND slot_start < ? AND state != \'missing\'').get(a, b, T, T + 3600).s;
  assert.ok(Math.abs(h.partial.solar - full) < 1e-12, 'partial counts only measured slots: the missing slot\'s zero and its standing-charge-like cost are left out');
  db.prepare('UPDATE site_hh SET state = \'final\' WHERE site_id = ? AND slot_start = ?').run(b, T + 1800);
  db.prepare('DELETE FROM site_hh WHERE site_id = ? AND slot_start = ?').run(b, T + 1800);
  h = hour();
  assert.equal(h.state, 'incomplete');
  assert.equal(h.values.solar, null);
  assert.equal(h.coverage, 3 / 4);
});

test('a day with a missing slot has a null total and a partial one; the state is incomplete', () => {
  const d = G.groupDay(g, '2025-06-11');
  assert.equal(d.day.state, 'incomplete');
  assert.equal(d.day.values.solar, null);
  assert.ok(d.day.partial.solar > 0);
  assert.equal(d.day.ratios.self_sufficiency, null);
});

test('a figure that is null in a present slot makes that column null for the bucket, not the others', () => {
  db.prepare("UPDATE site_hh SET solar_to_battery = NULL WHERE site_id = ? AND slot_start = ?").run(a, T - 3600);
  const h = G.groupSlots(g, T - 3600, T).buckets[0];
  assert.equal(h.values.solar_to_battery, null);
  assert.ok(h.values.solar > 0);
  assert.equal(h.ratios.self_consumption, null, 'a ratio needing the null figure is null too');
});

test('charge level is summed in kWh with each battery\'s size, not averaged in percent', () => {
  const big = makeHome({ ...home, battery: 30 }); const small = makeHome({ ...home, battery: 10 });
  fillSlots(big, { ...home, from: FROM, to: TO, shape: () => ({}) }); fillSlots(small, { ...home, from: FROM, to: TO });
  db.prepare('UPDATE site_hh SET soc_end = 80 WHERE site_id = ?').run(big);
  db.prepare('UPDATE site_hh SET soc_end = 20 WHERE site_id = ?').run(small);
  const g2 = G.createGroup({ name: 'Batteries', ownerId: owner, timezone: LON }); G.addMember(g2, big); G.addMember(g2, small);
  const h = G.groupSlots(g2, T, T + 3600).buckets[0];
  assert.equal(h.soc.kwh, 0.8 * 30 + 0.2 * 10);
  assert.equal(h.soc.capacityKwh, 40);
  assert.equal(h.soc.pct, 65, 'weighted by size: 65 %, not the 50 % mean of the two percentages');
});
