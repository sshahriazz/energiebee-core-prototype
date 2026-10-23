// Solar expected for the weather that happened (src/core/solar-expected.js), on a private copy
// of data/core.db. Changes made to test it (scaled output, a withdrawn sunlight hour) are rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const m = hasLive ? {
  ...(await import('../src/db/db.js')), ...(await import('../src/core/facts.js')),
  ...(await import('../src/core/solar-expected.js')), ...(await import('../src/core/time.js')),
} : {};

const SITE = 1;
const tz = () => m.db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE).timezone;
const today = () => m.localDate(tz(), m.nowSec());
const near = (a, b, eps = 1e-6) => a != null && b != null && Math.abs(a - b) <= eps;
// The last whole day with daylight half-hours that have an expected value.
const comparedDay = (r) => [...r.days].reverse().find((d) => d.whole && d.compared > 0 && d.expected > 0);
// Inside a transaction that is always rolled back, so later tests see the copy unchanged.
function rolledBack(fn) {
  m.db.exec('BEGIN');
  try { return fn(); } finally { m.db.exec('ROLLBACK'); }
}

test('each half-hour: Open-Meteo sunlight × this home\'s response at that hour, fitted on the other days only', { skip }, (t) => {
  const from = m.addDays(today(), 1 - m.FIT_DAYS);
  const r = m.solarExpected(SITE, from, today());
  const day = comparedDay(r);
  if (!day) return t.skip('no whole day with expected solar in the copy');
  const zone = tz();
  const hour = (ts) => m.zonedParts(zone, ts).hh;
  const sun = new Map(r.slots.map((s) => [s.slot_start, s.ghi_wm2]));
  const rows = m.db.prepare("SELECT slot_start, local_date, solar FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND state != 'missing'")
    .all(SITE, from, today());
  const slot = r.slots.find((s) => m.localDate(zone, s.slot_start) === day.date && s.ghi_wm2 > 0 && s.expected > 0);
  // Least squares through the origin for that hour of day, written out again here.
  let ag = 0; let gg = 0; const fitDates = new Set();
  for (const x of rows) {
    const g = (sun.get(x.slot_start) ?? 0) * 1800 / 3600 / 1000;
    if (x.local_date === day.date || x.solar == null || !(g > 0)) continue;
    fitDates.add(x.local_date);
    if (hour(x.slot_start) === hour(slot.slot_start)) { ag += x.solar * g; gg += g * g; }
  }
  const g = (slot.ghi_wm2 * 1800) / 3600 / 1000;
  assert.ok(near(slot.expected, (ag / gg) * g, 1e-4), `expected ${slot.expected}, refit ${(ag / gg) * g}`);
  assert.ok(near(slot.ratio, ag / gg, 1e-3));
  assert.equal(day.fit.days, fitDates.size, 'the fit uses the other days of the window, not the day itself');
});

test('a day\'s own output never changes its expected value (leave one day out)', { skip }, (t) => {
  const from = m.addDays(today(), -6);
  const before = m.solarExpected(SITE, from, today());
  const day = comparedDay(before);
  if (!day) return t.skip('no whole day with expected solar in the copy');
  const other = before.days.find((d) => d.date !== day.date && d.expected > 0);
  const after = rolledBack(() => {
    m.db.prepare('UPDATE site_hh SET solar = solar * 3 WHERE site_id = ? AND local_date = ?').run(SITE, day.date);
    return m.solarExpected(SITE, from, today());
  });
  const of = (res, date) => res.days.find((d) => d.date === date);
  assert.equal(of(after, day.date).expected, day.expected, 'expected for the scaled day is unchanged');
  assert.ok(near(of(after, day.date).actual, day.actual * 3, 0.01), 'its actual output did change');
  assert.ok(of(after, other.date).expected > other.expected, 'other days, whose fits include it, expect more');
});

test('no sunlight fact: no expected value (null, never 0) and the half-hour is left out of both sides', { skip }, (t) => {
  const from = m.addDays(today(), -6);
  const before = m.solarExpected(SITE, from, today());
  const day = comparedDay(before);
  if (!day) return t.skip('no whole day with expected solar in the copy');
  const zone = tz();
  const lit = before.slots.filter((s) => m.localDate(zone, s.slot_start) === day.date && s.expected > 0);
  const ghi = m.seriesId('site', SITE, 'ghi_wm2', 'open_meteo');
  const fact = m.db.prepare('SELECT start_ts, end_ts FROM interval_fact WHERE series_id = ? AND start_ts <= ? AND end_ts > ? AND superseded_at IS NULL').get(ghi, lit[0].slot_start, lit[0].slot_start);
  const after = rolledBack(() => {
    m.db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND superseded_at IS NULL').run(m.nowSec(), ghi, fact.start_ts);
    return m.solarExpected(SITE, from, today());
  });
  const gone = after.slots.filter((s) => s.slot_start >= fact.start_ts && s.slot_start < fact.end_ts);
  assert.equal(gone.length, (fact.end_ts - fact.start_ts) / 1800);
  for (const s of gone) { assert.equal(s.expected, null); assert.equal(s.ghi_wm2, null); }
  const d = after.days.find((x) => x.date === day.date);
  const solar = new Map(m.db.prepare("SELECT slot_start, solar FROM site_hh WHERE site_id = ? AND local_date = ? AND state != 'missing'").all(SITE, day.date).map((x) => [x.slot_start, x.solar]));
  // Half-hours that were compared before the sunlight was withdrawn.
  const was = before.slots.filter((s) => gone.some((g) => g.slot_start === s.slot_start) && s.expected != null && solar.get(s.slot_start) != null);
  assert.ok(was.length > 0);
  assert.equal(d.compared, day.compared - was.length);
  assert.equal(d.expectedComplete, false);
  const goneSolar = was.reduce((s, x) => s + solar.get(x.slot_start), 0);
  const goneExpected = was.reduce((s, x) => s + x.expected, 0);
  assert.ok(near(d.actual, day.actual - goneSolar, 0.002), 'actual drops by the output of those half-hours');
  assert.ok(near(d.expected, day.expected - goneExpected, 0.002), 'expected drops by their expected value');
});

test('night gives 0 expected; days and totals add up from the half-hours', { skip }, (t) => {
  const r = m.solarExpected(SITE, m.addDays(today(), -6), today());
  if (!r.days.some((d) => d.compared)) return t.skip('nothing to compare in the copy');
  const night = r.slots.filter((s) => s.ghi_wm2 === 0);
  assert.ok(night.length > 0 && night.every((s) => s.expected === 0));
  assert.equal(r.days.reduce((s, d) => s + d.compared, 0), r.totals.compared);
  assert.ok(near(r.days.reduce((s, d) => s + (d.expected ?? 0), 0), r.totals.expected, 0.01));
  assert.ok(near(r.totals.performance, r.totals.actual / r.totals.expected, 1e-3));
  // actual and expected are shown to 3 decimals and performance is worked out before rounding, so
  // their ratio may differ by the rounding (large on a small part-day such as this morning's).
  const roundingSlack = (d) => 1e-3 + 0.0005 * (1 + d.actual / d.expected) / (d.expected - 0.0005);
  for (const d of r.days) if (d.performance != null) assert.ok(near(d.performance, d.actual / d.expected, roundingSlack(d)), d.date);
  assert.ok(r.check.halfHours > 0 && r.check.r2 <= 1, 'out-of-sample check reported');
  // A day gets the same expected value in every view, because the fit window always ends today.
  const month = m.solarExpected(SITE, m.addDays(today(), 1 - m.FIT_DAYS), today());
  for (const d of r.days) assert.equal(month.days.find((x) => x.date === d.date).expected, d.expected, d.date);
});
