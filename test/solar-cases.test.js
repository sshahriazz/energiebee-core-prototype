// Pessimistic, median and optimistic solar (src/core/solar-cases.js) from SYNTHETIC history: 20 days
// of half-hours 10:00-14:00 where the central forecast of record was 1.0 kWh and the home made
// 0.50, 0.55 ... 1.45 kWh (one ratio per day). The quantiles are then known by hand (linear
// interpolation over 20 sorted ratios): p10 0.595, p50 0.975, p90 1.355.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { seriesId, putForecasts, readForecastOfRecord } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');
const { deriveSolarCases, SOLAR_CASES_SOURCE } = await import('../src/core/solar-cases.js');
const { dayBounds, addDays, localToUtc, localDate, todMinute } = await import('../src/core/time.js');

const TZ = 'Europe/London';
const site = createSite({ name: 'Solar cases home', isDemo: true });
const central = seriesId('site', site.id, 'solar_kwh', 'core_forecast');
const FIRST = '2026-09-01';
const DAYS = 20;
const at = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return localToUtc(TZ, y, m, d, hh, mm); };
const insHh = db.prepare(`INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, solar, method_version, built_at)
  VALUES (?, ?, ?, 1800, ?, 'final', 1, ?, 'test', 0)`);
for (let d = 0; d < DAYS; d++) {
  const date = addDays(FIRST, d);
  const ratio = 0.5 + 0.05 * d;
  const slots = Array.from({ length: 8 }, (_, k) => at(date, 10) + k * 1800);
  putForecasts(central, at(date, 9), slots.map((s) => ({ start: s, end: s + 1800, value: 1.0 })), null, { recordedAt: at(date, 9) * 1000 });
  for (const s of slots) insHh.run(site.id, s, localDate(TZ, s), todMinute(TZ, s), Math.round(ratio * 1e6) / 1e6);
}
const DAY = addDays(FIRST, DAYS);                      // 2026-09-21, the day forecast
const NOW = at(DAY, 0, 10);
// Tomorrow's central forecast: 0.8 kWh in the half-hours with history, 0 at night, 0.5 at 15:00
// (no history at that time of day), 0.01 at 16:00 (below the 0.05 kWh threshold).
const fut = [
  ...Array.from({ length: 8 }, (_, k) => ({ start: at(DAY, 10) + k * 1800, value: 0.8 })),
  { start: at(DAY, 2), value: 0 }, { start: at(DAY, 15), value: 0.5 }, { start: at(DAY, 16), value: 0.01 },
].map((r) => ({ ...r, end: r.start + 1800 }));
putForecasts(central, NOW - 600, fut, null, { recordedAt: (NOW - 600) * 1000 });

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const caseRows = (metric) => readForecastOfRecord(seriesId('site', site.id, metric, SOLAR_CASES_SOURCE), dayBounds(TZ, DAY)[0], dayBounds(TZ, DAY)[1] + 86400, NOW + 1e6);

test('below the sample guard nothing is stored and the reason says insufficient history', () => {
  const r = deriveSolarCases(site.id, NOW, { minSamples: DAYS + 1 });
  assert.match(r.reason, /^insufficient history/);
  assert.equal(r.cases.length, 0);
  assert.deepEqual(r.stored, { solar_kwh_p10: 0, solar_kwh_p50: 0, solar_kwh_p90: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM forecast_fact WHERE series_id IN (SELECT id FROM series WHERE source_id = (SELECT id FROM source WHERE code = ?))').get(SOLAR_CASES_SOURCE).n, 0);
});

test('cases = central x the home\'s own ratio quantiles per time of day, labelled derived, stored as issues of core_solar_cases', () => {
  const dry = deriveSolarCases(site.id, NOW, { dryRun: true });
  assert.equal(caseRows('solar_kwh_p10').length, 0, 'a dry run stores nothing');
  const r = deriveSolarCases(site.id, NOW);
  assert.deepEqual(r.cases, dry.cases);
  assert.equal(r.origin, 'derived');
  assert.equal(r.reason, null);
  assert.deepEqual(r.central, { metric: 'solar_kwh', source: 'core_forecast', issued_at: NOW - 600 });
  assert.equal(r.samples, DAYS * 8);
  assert.deepEqual(r.buckets, { usable: 8, short: 0 });
  assert.equal(r.insufficient, 1, 'the 15:00 half-hour has no history at that time of day');
  const by = new Map(r.cases.map((c) => [c.slot_start, c]));
  for (let k = 0; k < 8; k++) {
    const c = by.get(at(DAY, 10) + k * 1800);
    near(c.p10, 0.8 * 0.595); near(c.p50, 0.8 * 0.975); near(c.p90, 0.8 * 1.355);
  }
  assert.deepEqual(by.get(at(DAY, 2)), { slot_start: at(DAY, 2), central: 0, p10: 0, p50: 0, p90: 0 });
  assert.equal(by.has(at(DAY, 15)), false);
  assert.deepEqual([by.get(at(DAY, 16)).p10, by.get(at(DAY, 16)).p90], [0.01, 0.01], 'below the threshold the central value is used');
  for (const c of r.cases) assert.ok(c.p10 <= c.p50 && c.p50 <= c.p90);
  assert.deepEqual(r.stored, { solar_kwh_p10: 10, solar_kwh_p50: 10, solar_kwh_p90: 10 });
  const p10 = caseRows('solar_kwh_p10');
  assert.equal(p10.length, 10);
  assert.ok(p10.every((f) => f.issued_at === NOW && f.end_ts - f.start_ts === 1800));
  near(p10.find((f) => f.start_ts === at(DAY, 10)).value, 0.476);
});

test('change-only: the same inputs an hour later store nothing new; a changed central stores only what moved', () => {
  const again = deriveSolarCases(site.id, NOW + 3600);
  assert.deepEqual(again.stored, { solar_kwh_p10: 0, solar_kwh_p50: 0, solar_kwh_p90: 0 });
  putForecasts(central, NOW + 3600, [{ start: at(DAY, 11), end: at(DAY, 11) + 1800, value: 1.0 }], null, { recordedAt: (NOW + 3600) * 1000 });
  const moved = deriveSolarCases(site.id, NOW + 7200);
  assert.deepEqual(moved.stored, { solar_kwh_p10: 1, solar_kwh_p50: 1, solar_kwh_p90: 1 });
  near(caseRows('solar_kwh_p90').find((f) => f.start_ts === at(DAY, 11)).value, 1.355);
});

test('the optimistic case never exceeds the most the home made in one slot', () => {
  putForecasts(central, NOW + 9000, [{ start: at(DAY, 12), end: at(DAY, 12) + 1800, value: 2.0 }], null, { recordedAt: (NOW + 9000) * 1000 });
  const r = deriveSolarCases(site.id, NOW + 9600, { dryRun: true });
  const c = r.cases.find((x) => x.slot_start === at(DAY, 12));
  near(c.p10, 2.0 * 0.595);
  near(c.p50, 1.45, 1e-9);
  near(c.p90, 1.45, 1e-9);
});

test('a home without history or forecast says why and stores nothing', () => {
  const bare = createSite({ name: 'No data', isDemo: true });
  const r = deriveSolarCases(bare.id, NOW);
  assert.match(r.reason, /^insufficient history/);
  assert.throws(() => deriveSolarCases(bare.id, NOW, { central: 'solcast' }), /central must be one of/);
});
