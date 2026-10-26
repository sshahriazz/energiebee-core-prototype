// The planner read layer (plan item B10, src/core/planner-read.js): resampling rules, the daily
// counter across midnight and clock changes, "as known at" correctness, gaps that stay null, prices
// equal to the build's per slot (GB home snapshot), load history on the local clock across a clock
// change, Predbat's days_previous weighting, the stale-input gate, the planning frame at 15, 30 and
// 60 minutes, and boundedness (ten times the history: same plans, same rows searched).
// Synthetic homes only, with explicit recorded_at stamps and asOf moments, so every result is fixed.
// With data/core.db present the file runs on a snapshot copy of it (the synthetic homes are added to
// the copy) and one more test compares with the build on the GB home; otherwise on an empty database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

useDb({ snapshot: hasLive });
const { db, tx } = await import('../src/db/db.js');
const facts = await import('../src/core/facts.js');
const pr = await import('../src/core/planner-read.js');
const { dayBounds, localDate, addDays, todMinute } = await import('../src/core/time.js');
const { QUALITY } = facts;
const planFrame = await import('../src/core/plans.js').then((m) => m.planFrame).catch(() => null);

const TZ = 'Europe/London';
const T = (iso) => Math.floor(Date.parse(iso) / 1000);
const close = (a, b, msg = '', eps = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
let homes = 0;
function makeSite({ tz = TZ, slotS = 1800, battery = 10, carbon = null } = {}) {
  return Number(db.prepare(`INSERT INTO site (name, created_at, country, market_code, currency, timezone, slot_s, battery_kwh, carbon_region)
    VALUES (?, 1, 'GB', 'GB', 'GBP', ?, ?, ?, ?)`).run(`Planner read ${++homes}`, tz, slotS, battery, carbon).lastInsertRowid);
}
const sid = (siteId, metric, source) => facts.seriesId('site', siteId, metric, source);
// Facts with stated recorded_at (ms; default a minute after the reading), superseding like putReadings.
function putR(series, rows) {
  const sup = db.prepare('UPDATE reading SET superseded_at = ? WHERE series_id = ? AND ts = ? AND superseded_at IS NULL');
  const ins = db.prepare('INSERT INTO reading (series_id, ts, value, quality, recorded_at) VALUES (?, ?, ?, ?, ?)');
  tx(() => { for (const r of rows) { const rec = r.rec ?? (r.ts + 60) * 1000; sup.run(rec, series, r.ts); ins.run(series, r.ts, r.value, r.quality ?? 1, rec); } });
}
function putI(series, rows) {
  const sup = db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
  const ins = db.prepare('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at) VALUES (?, ?, ?, ?, 1, ?)');
  tx(() => { for (const r of rows) { const rec = r.rec ?? (r.end + 60) * 1000; sup.run(rec, series, r.start, r.end); ins.run(series, r.start, r.end, r.value, rec); } });
}
const every5 = (a, b, fn) => { const out = []; for (let t = a; t < b; t += 300) { const v = fn(t); if (v !== undefined) out.push({ ts: t, value: v }); } return out; };

// ───────────── window ─────────────

test('window: plan start, minute offset and first step at 15, 30 and 60 minutes (the slot document example); the index math agrees', () => {
  const now = T('2026-10-23T13:37:20Z');
  const want = { 900: ['2026-10-23T13:30:00Z', 7, 1, 192, 3], 1800: ['2026-10-23T13:30:00Z', 7, 1, 96, 6], 3600: ['2026-10-23T13:00:00Z', 37, 7, 48, 12] };
  for (const slotS of [900, 1800, 3600]) {
    const f = pr.frameFor(TZ, now, { slotS });
    const [start, off, first, nSlots, perSlot] = want[slotS];
    assert.deepEqual([f.planStart, f.minuteOffset, f.firstStep, f.nSlots, f.stepsPerSlot, f.nSteps], [T(start), off, first, nSlots, perSlot, nSlots * perSlot], `slot ${slotS}`);
    if (planFrame) {
      const p = planFrame(TZ, now, slotS, 48);
      assert.deepEqual([f.planStart, f.minuteOffset, f.firstStep, f.nSlots, f.stepsPerSlot], [p.planStart, p.minuteOffset, p.firstStep, p.slots, p.stepsPerSlot], 'same frame as plans.js planFrame');
    }
    for (let i = 0; i < f.nSteps; i++) {
      const j = f.slotOf(i);
      assert.ok(f.stepOf(j) <= i && i < f.stepOf(j + 1));
      assert.equal(f.stepStarts[i], f.timeOfStep(i));
      assert.equal(f.stepAt(f.timeOfStep(i)), i);
      assert.equal(f.stepAt(f.timeOfStep(i) + 299), i);
      assert.equal(f.slotAt(f.timeOfStep(i)), j);
    }
    for (let j = 0; j < f.nSlots; j++) {
      assert.equal(f.slotStarts[j], f.timeOfSlot(j));
      assert.equal(f.slotTodMin[j], todMinute(TZ, f.slotStarts[j]), 'tod_min as site_hh');
    }
    assert.equal(f.stepAt(now), f.firstStep);
    assert.deepEqual([f.stepAt(f.planStart - 1), f.stepAt(f.end), f.slotAt(f.end)], [-1, -1, -1]);
  }
  // A zone half an hour off the hour: 60-minute slots start at :30 UTC (local midnight's grid).
  const darwin = pr.frameFor('Australia/Darwin', now, { slotS: 3600 });
  assert.deepEqual([darwin.planStart, darwin.minuteOffset], [T('2026-10-23T13:30:00Z'), 7]);
  assert.throws(() => pr.frameFor(TZ, now, { slotS: 1000 }), RangeError);
  // window() reads the home's zone and slot length.
  const site = makeSite({ slotS: 900 });
  const w = pr.window(site, now);
  assert.deepEqual([w.siteId, w.slotS, w.planStart, w.nSlots], [site, 900, T('2026-10-23T13:30:00Z'), 192]);
});

test('window: 50 / 46 half-hours on clock-change days at every slot length, local midnights and the time-of-day index', () => {
  for (const [date, counts, long] of [['2026-10-25', { 900: 100, 1800: 50, 3600: 25 }, true], ['2027-03-28', { 900: 92, 1800: 46, 3600: 23 }, false]]) {
    const [a, b] = dayBounds(TZ, date);
    for (const slotS of [900, 1800, 3600]) {
      const f = pr.frameFor(TZ, a, { slotS, horizonH: 72 });
      assert.equal(f.planStart, a);
      assert.equal(f.slotStarts.filter((t) => t >= a && t < b).length, counts[slotS], `${date} at ${slotS}`);
      const midnights = [0, 1, 2, 3].map((k) => dayBounds(TZ, addDays(date, k))[0]).filter((t) => t < f.end);
      assert.deepEqual(f.dayStartSteps.map(f.timeOfStep), midnights, 'counter resets at each local midnight');
      // 01:00-01:55 local: twice on the long day, never on the short one.
      const inDay = f.todIndex.filter((_, i) => f.stepStarts[i] < b);
      for (let k = 12; k < 24; k++) assert.equal(inDay.filter((x) => x === k).length, long ? 2 : 0, `clock index ${k}`);
      assert.equal(inDay.filter((x) => x === 30).length, 1);
    }
  }
});

// ───────────── series ─────────────

test('series: the rule of each metric kind (power mean, level last-held, temperature held, energy split by overlap, mean not split) and gaps stay null', () => {
  const site = makeSite({ carbon: 77 });
  const D0 = T('2026-10-20T10:00:00Z');
  const asOf = (D0 + 7200) * 1000;
  putR(sid(site, 'solar_w', 'sunsynk_5min'), every5(D0, D0 + 3600, (t) => (t === D0 + 1800 ? undefined : 1000 * ((t - D0) / 300 + 1))));
  putR(sid(site, 'solar_w', 'sunsynk_live'), [{ ts: D0 + 1800, value: 7777 }]);
  putR(sid(site, 'battery_soc_pct', 'sunsynk_5min'), every5(D0, D0 + 3600, (t) => 50 + (t - D0) / 300));
  putR(sid(site, 'outdoor_temp_c', 'open_meteo'), [{ ts: D0, value: 8 }, { ts: D0 + 3600, value: 9 }]);
  const dev = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, recorded_at) VALUES (?, 'meter_import', 'octopus', ?, 1)").run(site, `MPAN-${site}`).lastInsertRowid);
  putI(facts.seriesId('device', dev, 'grid_import_kwh', 'octopus_meter'), [{ start: D0, end: D0 + 1800, value: 0.6 }, { start: D0 + 1800, end: D0 + 3600, value: 1.2 }, { start: D0 + 5400, end: D0 + 7200, value: 0.3, rec: asOf }]);
  putI(facts.seriesId('region', 'carbon:77', 'carbon_intensity', 'carbon_regional'), [{ start: D0, end: D0 + 1800, value: 100 }, { start: D0 + 1800, end: D0 + 3600, value: 200 }]);

  // Instant power: mean over each step; the missing 5-minute sample is taken from the live source (FALLBACK).
  const p = pr.series(site, 'solar_w', D0, D0 + 3600, { asOf });
  assert.deepEqual([p.start, p.stepS, p.n, p.origin.rule, p.origin.sources], [D0, 300, 12, 'mean_power_held', ['sunsynk_5min', 'sunsynk_live']]);
  assert.deepEqual(p.values, [1000, 2000, 3000, 4000, 5000, 6000, 7777, 8000, 9000, 10000, 11000, 12000]);
  assert.equal(p.sourceIndex[6], 1);
  assert.ok(p.quality[6] & QUALITY.FALLBACK);
  close(p.energyKwh[0], (1000 * 300) / 3.6e6, 'energy of a step');
  const only = pr.series(site, 'solar_w', D0, D0 + 3600, { asOf, source: 'sunsynk_5min' });
  assert.equal(only.values[6], null, 'a gap is null, never 0');
  assert.equal(only.cover[6], 0);
  const q15 = pr.series(site, 'solar_w', D0, D0 + 3600, { asOf, source: 'sunsynk_5min', stepS: 900 });
  assert.deepEqual(q15.values, [2000, 5000, 8500, 11000]);
  close(q15.cover[2], 2 / 3);
  assert.ok(q15.quality[2] & QUALITY.PARTIAL);
  assert.deepEqual(pr.series(site, 'solar_w', D0, D0 + 3600, { asOf, source: 'sunsynk_5min', stepS: 'slot' }).values, [3500, 10000], 'the mean of what was measured');
  assert.deepEqual(pr.series(site, 'solar_w', D0 + 3600, D0 + 5400, { asOf }).values, new Array(6).fill(null), 'no data after the last sample');

  // Level (SoC, aggregation last): the value held at the end of each step.
  assert.deepEqual(pr.series(site, 'battery_soc_pct', D0, D0 + 3600, { asOf, stepS: 1800 }).values, [55, 61]);
  assert.equal(pr.series(site, 'battery_soc_pct', D0, D0 + 3600, { asOf }).origin.rule, 'last_held');

  // Temperature (instant, mean): an hourly value holds its hour, then nothing.
  const tmp = pr.series(site, 'outdoor_temp_c', D0, D0 + 3 * 3600, { asOf, stepS: 1800 });
  assert.deepEqual(tmp.values, [8, 8, 9, 9, null, null]);
  assert.deepEqual(tmp.origin.holdS, [3600]);

  // Interval energy: split by overlap (a half-hour feeds six 5-minute steps by a sixth each).
  const e = pr.series(site, 'grid_import_kwh', D0, D0 + 7200, { asOf });
  assert.equal(e.origin.rule, 'split_by_overlap');
  for (let k = 0; k < 24; k++) {
    const want = k < 6 ? 0.1 : k < 12 ? 0.2 : k < 18 ? null : 0.05;
    if (want == null) assert.equal(e.values[k], null, `step ${k} is a gap`); else close(e.values[k], want, `step ${k}`);
  }
  const hour = pr.series(site, 'grid_import_kwh', D0, D0 + 7200, { asOf, stepS: 3600 });
  close(hour.values[0], 1.8); close(hour.values[1], 0.3);
  assert.deepEqual([hour.cover[1], (hour.quality[1] & QUALITY.PARTIAL) !== 0], [0.5, true]);

  // Interval mean (carbon intensity, the home's region series): time-weighted, not split.
  assert.deepEqual(pr.series(site, 'carbon_intensity', D0, D0 + 3600, { asOf, stepS: 900 }).values, [100, 100, 200, 200]);
  assert.deepEqual(pr.series(site, 'carbon_intensity', D0, D0 + 3600, { asOf, stepS: 3600 }).values, [150]);
  assert.throws(() => pr.series(site, 'solar_w', D0, D0 + 3600, { asOf: D0 }), /looks like seconds/);
  assert.throws(() => pr.series(site, 'no_such_metric', D0, D0 + 3600, { asOf }), /unknown metric/);
});

// ───────────── counterDifferenceSeries ─────────────

test('counterDifferenceSeries: 5-minute power fitted to the daily total, reset at every local midnight, 25- and 23-hour days', () => {
  const site = makeSite();
  const load = sid(site, 'load_w', 'sunsynk_5min');
  const daily = sid(site, 'load_kwh', 'sunsynk_daily');
  const [a24] = dayBounds(TZ, '2026-10-24'); const [a25, b25] = dayBounds(TZ, '2026-10-25'); const [a26, b26] = dayBounds(TZ, '2026-10-26');
  putR(load, every5(a24, b26, () => 1200));                         // 0.1 kWh per 5 minutes
  putI(daily, [{ start: a24, end: a25, value: 31.68 }, { start: a25, end: b25, value: 33 }, { start: a26, end: b26, value: 50, rec: T('2026-10-26T11:00:00Z') * 1000 }]);
  const asOf = T('2026-10-26T12:00:00Z') * 1000;
  const from = T('2026-10-24T18:00:00Z'); const to = T('2026-10-26T12:00:00Z');
  const r = pr.counterDifferenceSeries(site, 'load_today', from, to, { asOf });
  assert.equal(r.metric, 'load_kwh');
  assert.deepEqual(r.days.map((d) => [d.date, d.hours, d.today]), [['2026-10-24', 24, false], ['2026-10-25', 25, false], ['2026-10-26', 24, true]]);
  close(r.days[0].fit, 1.1); close(r.days[1].fit, 1.1);
  assert.deepEqual([r.days[2].fit, r.days[2].fitted], [1, false], 'today is never fitted (the build rule)');
  assert.deepEqual(r.resets, [(a25 - from) / 300, (a26 - from) / 300]);
  assert.equal(r.resets[1] - r.resets[0], 300, '300 five-minute steps on the 25-hour day');
  for (let i = 0; i < r.n; i++) close(r.values[i], i < r.resets[1] ? 0.11 : 0.1, `step ${i}`);
  close(r.cumulative[0], 0.11 * ((from + 300 - a24) / 300), 'the counter counts from local midnight, before the window too');
  close(r.cumulative[r.resets[0] - 1], 31.68, 'the day total just before midnight');
  close(r.cumulative[r.resets[0]], 0.11, 'reset at local midnight');
  close(r.cumulative[r.resets[1] - 1], 33, 'the 25-hour day');
  close(r.cumulative[r.n - 1], 14.4, 'today so far: unfitted');
  // Slot steps: the same counter, six steps at a time.
  const slots = pr.counterDifferenceSeries(site, 'load_kwh', a25, b25, { asOf, stepS: 'slot' });
  assert.equal(slots.n, 50);
  for (const v of slots.values) close(v, 0.66);
  // As known at: a revised daily total changes the fit only from when it was recorded.
  putI(daily, [{ start: a24, end: a25, value: 34.56, rec: T('2026-10-27T09:00:00Z') * 1000 }]);
  close(pr.counterDifferenceSeries(site, 'load_kwh', a24, a25, { asOf }).days[0].fit, 1.1, 'the first version, as known then');
  close(pr.counterDifferenceSeries(site, 'load_kwh', a24, a25, { asOf: T('2026-10-27T10:00:00Z') * 1000 }).days[0].fit, 1.2, 'the revision');

  // Clocks go forward: 23 hours, 276 steps; a gap stays null and the counter stays flat over it;
  // a total outside 0.6-1.6 times the samples is not used to fit (the build rule).
  const [a27, b27] = dayBounds(TZ, '2027-03-27'); const [a28, b28] = dayBounds(TZ, '2027-03-28'); const [, b29] = dayBounds(TZ, '2027-03-29');
  const gapFrom = T('2027-03-29T10:00:00Z');
  putR(load, every5(a27, b29, (t) => (t >= gapFrom && t < gapFrom + 1800 ? undefined : 1200)));
  putI(daily, [{ start: a27, end: b27, value: 57.6 }, { start: a28, end: b28, value: 30.36 }, { start: b28, end: b29, value: (288 - 6) * 0.1 * 1.1 }]);
  const asOf2 = T('2027-03-30T12:00:00Z') * 1000;
  const short = pr.counterDifferenceSeries(site, 'load_kwh', a28, b28, { asOf: asOf2 });
  assert.deepEqual([short.n, short.resets, short.days[0].hours], [276, [0], 23]);
  close(short.cumulative[275], 30.36);
  assert.deepEqual([pr.counterDifferenceSeries(site, 'load_kwh', a27, b27, { asOf: asOf2 }).days[0].fitted], [false]);
  const gap = pr.counterDifferenceSeries(site, 'load_kwh', b28, b29, { asOf: asOf2 });
  const g0 = (gapFrom - b28) / 300;
  assert.deepEqual(gap.values.slice(g0, g0 + 6), new Array(6).fill(null));
  close(gap.cumulative[g0 + 5], gap.cumulative[g0 - 1], 'flat over the gap');
  close(gap.values[0], 0.11);
  assert.throws(() => pr.counterDifferenceSeries(site, 'gas_kwh', a28, b28), /no daily counter/);
});

// ───────────── as known at ─────────────

test('as known at: a fact recorded after asOf is invisible, a superseded one is visible until it was superseded (readings, forecasts, prices)', () => {
  const site = makeSite();
  const t1 = T('2026-09-10T12:00:00Z');
  const R1 = (t1 + 60) * 1000; const R2 = R1 + 3600 * 1000;
  const solar = sid(site, 'solar_w', 'sunsynk_5min');
  putR(solar, [{ ts: t1, value: 100, rec: R1 }]);
  putR(solar, [{ ts: t1, value: 200, rec: R2 }]);
  const at = (asOf) => pr.series(site, 'solar_w', t1, t1 + 300, { asOf }).values[0];
  assert.deepEqual([at(R1 - 1), at(R1), at(R2 - 1), at(R2), pr.series(site, 'solar_w', t1, t1 + 300).values[0]], [null, 100, 100, 200, 200]);

  // Forecasts by when the core RECORDED each issue, with the issue that fed each step.
  const fc = sid(site, 'solar_kwh', 'core_forecast');
  const I1 = t1 - 7200; const I2 = t1 - 3600;
  facts.putForecasts(fc, I1, [{ start: t1, end: t1 + 1800, value: 0.6 }, { start: t1 + 1800, end: t1 + 3600, value: 0.9 }], null, { recordedAt: I1 * 1000 + 5000 });
  facts.putForecasts(fc, I2, [{ start: t1, end: t1 + 1800, value: 1.2 }, { start: t1 + 1800, end: t1 + 3600, value: 0.9 }], null, { recordedAt: I2 * 1000 + 5000 });
  facts.putForecasts(sid(site, 'solar_kwh', 'quartz'), I2, [{ start: t1 + 3600, end: t1 + 4500, value: 0.3 }], null, { recordedAt: I2 * 1000 + 5000 });
  const before = pr.forecast(site, 'solar_kwh', t1, t1 + 3600, { asOf: I1 * 1000 + 4999 });
  assert.deepEqual([before.values.every((v) => v == null), before.segments], [true, []]);
  const first = pr.forecast(site, 'solar_kwh', t1, t1 + 3600, { asOf: I1 * 1000 + 5000 });
  for (let k = 0; k < 12; k++) close(first.values[k], k < 6 ? 0.1 : 0.15);
  assert.ok(first.issuedAt.every((x) => x === I1));
  const second = pr.forecast(site, 'solar_kwh', t1, t1 + 4500, { asOf: I2 * 1000 + 5000 });
  for (let k = 0; k < 15; k++) close(second.values[k], k < 6 ? 0.2 : k < 12 ? 0.15 : 0.1);
  assert.deepEqual(second.segments.map((s) => [s.from, s.to, s.source, s.issuedAt]),
    [[t1, t1 + 1800, 'core_forecast', I2], [t1 + 1800, t1 + 3600, 'core_forecast', I1], [t1 + 3600, t1 + 4500, 'quartz', I2]], 'unchanged periods keep the issue that set them');
  assert.ok(second.quality[12] & QUALITY.FALLBACK, 'Quartz only where our own forecast has nothing');
  // Cases: none kept yet gives nulls and says why; a stored pessimistic case is read like any forecast.
  const p10 = pr.forecast(site, 'solar_kwh', t1, t1 + 1800, { asOf: R2, case: 'p10' });
  assert.deepEqual([p10.values.every((v) => v == null), /no forecast series/.test(p10.missing)], [true, true]);
  facts.putForecasts(sid(site, 'solar_kwh_p10', 'core_solar_cases'), I2, [{ start: t1, end: t1 + 1800, value: 0.6 }], null, { recordedAt: I2 * 1000 + 6000 });
  const pess = pr.forecast(site, 'solar_kwh', t1, t1 + 1800, { asOf: R2, case: 'pessimistic' });
  assert.deepEqual([pess.metric, pess.origin.sources], ['solar_kwh_p10', ['core_solar_cases']]);
  close(pess.values[0], 0.1);
  assert.match(pr.forecast(site, 'load_kwh', t1, t1 + 1800, { asOf: R2, case: 'p90' }).missing, /no p90 case/);

  // Prices: a rate row superseded later is still the price as known before; VAT (5 % in September 2026) applied.
  const dev = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, recorded_at) VALUES (?, 'meter_import', 'octopus', ?, 1)").run(site, `MPAN-${site}`).lastInsertRowid);
  const tariff = Number(db.prepare("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, currency, country) VALUES ('t', ?, 'electricity', 'import', 'flat', 'GBP', 'GB')").run(`T-FLAT-${site}`).lastInsertRowid);
  db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to, recorded_at) VALUES (?, ?, ?, ?, NULL, 1000)').run(site, dev, tariff, T('2026-01-01T00:00:00Z'));
  const rate = db.prepare("INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at) VALUES (?, ?, 'single', ?, NULL, ?, ?)");
  rate.run(tariff, 'unit', T('2026-01-01T00:00:00Z'), 20, 1000);
  rate.run(tariff, 'standing', T('2026-01-01T00:00:00Z'), 50, 1000);
  db.prepare("UPDATE rate_interval SET superseded_at = ? WHERE tariff_id = ? AND component = 'unit'").run(R2, tariff);
  rate.run(tariff, 'unit', T('2026-01-01T00:00:00Z'), 30, R2);
  const old = pr.rates(site, t1, t1 + 3600, { asOf: R2 - 1 });
  const now = pr.rates(site, t1, t1 + 3600, { asOf: R2 });
  close(old.import.values[0], 21); close(now.import.values[0], 31.5);
  assert.deepEqual([old.import.tariff[0], old.import.unpriced[0], old.export.unpriced[0], old.export.values[0]], [`T-FLAT-${site}`, false, true, null], 'no export agreement: unpriced, not 0');
  assert.ok(old.import.quality[0] === 0 && (old.export.quality[0] & QUALITY.CHECK_FAILED));
  close(old.import.standing[0], 52.5 / 288, 'standing by the step\'s share of the day');
  assert.deepEqual(old.standingPerDay.map((d) => [d.date, d.import]), [['2026-09-10', 52.5]]);
  assert.equal(old.currency, 'GBP');
});

// ───────────── loadHistory and predictLoad ─────────────

test('loadHistory: previous days on one local-clock axis across both clock changes; EV energy left out; holidays flagged', () => {
  const site = makeSite();
  const load = sid(site, 'load_w', 'sunsynk_5min');
  const watts = (t) => 1000 + 100 * Math.floor(todMinute(TZ, t) / 60);  // depends only on the local hour
  for (const [d1, d2] of [['2026-10-23', '2026-10-26'], ['2027-03-26', '2027-03-29']]) putR(load, every5(dayBounds(TZ, d1)[0], dayBounds(TZ, d2)[1], watts));
  putI(sid(site, 'ev_charge_kwh', 'octopus_kraken'), [{ start: T('2026-10-26T02:00:00Z'), end: T('2026-10-26T03:00:00Z'), value: 1.2 }]);
  const expect = (i) => (1000 + 100 * Math.floor(i / 12)) * 300 / 3.6e6;

  const autumn = pr.loadHistory(site, { daysPrevious: 3, asOf: T('2026-10-27T12:00:00Z') * 1000, excludeMetrics: [], holidays: ['2026-10-25'] });
  assert.deepEqual([autumn.axis, autumn.n, autumn.stepS], ['local_time_of_day', 288, 300]);
  assert.deepEqual(autumn.days.map((d) => [d.date, d.daysAgo, d.hours, d.dst, d.missingClock, d.holiday]),
    [['2026-10-26', 1, 24, null, 0, false], ['2026-10-25', 2, 25, 'long', 0, true], ['2026-10-24', 3, 24, null, 0, false]]);
  for (const d of autumn.days) for (let i = 0; i < 288; i++) close(d.values[i], expect(i), `${d.date} ${i}`);
  close(autumn.days[1].totalKwh, [...Array(25)].reduce((s, _, h) => s + (1000 + 100 * (h <= 1 ? h : h - 1)) / 1000, 0), 'the 25-hour day keeps its real energy');

  const spring = pr.loadHistory(site, { daysPrevious: 3, asOf: T('2027-03-30T12:00:00Z') * 1000, excludeMetrics: [] });
  const short = spring.days[1];
  assert.deepEqual([short.date, short.hours, short.dst, short.missingClock], ['2027-03-28', 23, 'short', 12]);
  for (let i = 0; i < 288; i++) {
    if (i >= 12 && i < 24) assert.equal(short.values[i], null, 'the skipped hour is null, not 0'); else close(short.values[i], expect(i), `short day ${i}`);
  }

  // EV dispatches (Predbat car_charging_energy) are taken out by default, clamped at 0.
  const noEv = pr.loadHistory(site, { daysPrevious: 1, asOf: T('2026-10-27T12:00:00Z') * 1000 });
  for (let i = 24; i < 36; i++) close(noEv.days[0].values[i], 0, `02:${String((i - 24) * 5).padStart(2, '0')}`);
  close(noEv.days[0].excludedKwh, 1.2);
  close(noEv.days[0].values[36], expect(36));

  // Predbat's own form: days_previous [1, 3] with days_previous_weight [1, 0.5].
  const pb = pr.loadHistory(site, { daysPrevious: { days: [1, 3], weights: [1, 0.5] }, asOf: T('2026-10-27T12:00:00Z') * 1000, excludeMetrics: [] });
  assert.deepEqual(pb.days.map((d) => [d.date, d.weight]), [['2026-10-26', 1], ['2026-10-24', 0.5]]);
  const p = pr.predictLoad(autumn);
  assert.deepEqual(p.used, ['2026-10-26', '2026-10-24'], 'the holiday is left out');
  close(p.values[100], expect(100));
  // Laid onto a planning window by the local clock.
  const frame = pr.frameFor(TZ, T('2026-10-27T12:02:00Z'), { slotS: 1800, horizonH: 2 });
  const onto = pr.projectProfile(p, frame);
  assert.deepEqual([onto.start, onto.n], [T('2026-10-27T12:00:00Z'), 24]);
  close(onto.values[0], expect(144));
});

test('loadHistory: a day without inverter samples falls back to the ledger, only from rows built by asOf', () => {
  const site = makeSite();
  const [a, b] = dayBounds(TZ, '2026-10-21');
  const ins = db.prepare(`INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, home, method_version, built_at)
    VALUES (?, ?, '2026-10-21', 1800, ?, 'final', 1, 0.6, 'test', ?)`);
  for (let t = a; t < b; t += 1800) ins.run(site, t, todMinute(TZ, t), t < a + 3600 ? T('2026-10-25T00:00:00Z') : T('2026-10-22T01:00:00Z'));
  const h = pr.loadHistory(site, { daysPrevious: 1, asOf: T('2026-10-22T12:00:00Z') * 1000, excludeMetrics: [] });
  const d = h.days[0];
  assert.equal(d.source, 'site_hh');
  assert.deepEqual(d.values.slice(0, 12), new Array(12).fill(null), 'rows rebuilt after asOf are not what was known then');
  close(d.values[12], 0.1);
  assert.ok(d.quality[12] & QUALITY.INTERPOLATED, 'spread evenly over the slot: flagged');
});

test('predictLoad: Predbat days_previous weighting, gaps left out of the mean, scaling, drop the lowest day', () => {
  const h = { axis: 'local_time_of_day', stepS: 300, n: 4, days: [
    { date: 'a', weight: 1, holiday: false, values: [1, 2, null, 4] },
    { date: 'b', weight: 3, holiday: false, values: [3, 2, 2, null] },
    { date: 'c', weight: 1, holiday: true, values: [9, 9, 9, 9] },
  ] };
  assert.deepEqual(pr.predictLoad(h).values, [2.5, 2, 2, 4]);
  assert.deepEqual(pr.predictLoad(h, [1, 0, 0]).values, [1, 2, null, 4], 'a weight of 0 leaves the day out');
  assert.deepEqual(pr.predictLoad(h, null, 2).values, [5, 4, 4, 8], 'load_scaling');
  assert.deepEqual(pr.predictLoad(h, null, 1, { includeHolidays: true }).values, [19 / 5, 17 / 5, 15 / 4, 13 / 2]);
  const dropped = pr.predictLoad(h, null, 1, { dropLowest: true });
  assert.deepEqual([dropped.used, dropped.values], [['b'], [3, 2, 2, null]], 'load_filter_modal: the lowest day (a, 7 kWh) goes');
  assert.throws(() => pr.predictLoad(h, [1, 2]), RangeError);
});

// ───────────── state and freshness ─────────────

test('state and the stale-input gate: freshest source wins, Predbat signs, a stale or missing input means a demand-only plan', () => {
  const site = makeSite({ battery: 10 });
  const asOf = T('2026-10-22T12:00:00Z') * 1000; const at = asOf / 1000;
  putR(sid(site, 'battery_soc_pct', 'sunsynk_live'), [{ ts: at - 300, value: 80 }, { ts: at - 100, value: 79, rec: asOf + 1000 }]);
  putR(sid(site, 'battery_soc_pct', 'sunsynk_5min'), [{ ts: at - 600, value: 70 }]);
  putR(sid(site, 'battery_discharge_w', 'sunsynk_live'), [{ ts: at - 300, value: 500 }]);
  putR(sid(site, 'battery_charge_w', 'sunsynk_live'), [{ ts: at - 300, value: 0 }]);
  putR(sid(site, 'solar_w', 'sunsynk_live'), [{ ts: at - 300, value: 1500 }]);
  putR(sid(site, 'grid_import_w', 'sunsynk_live'), [{ ts: at - 4000, value: 800 }]);
  putR(sid(site, 'grid_export_w', 'sunsynk_live'), [{ ts: at - 4000, value: 0 }]);
  const st = pr.state(site, asOf);
  assert.deepEqual([st.inputs.soc_pct.value, st.inputs.soc_pct.ageS, st.inputs.soc_pct.source], [80, 300, 'sunsynk_live'], 'a reading recorded after asOf is not seen');
  assert.deepEqual([st.inputs.battery_w.value, st.inputs.grid_w.value, st.inputs.pv_w.value, st.inputs.soc_kwh.value], [500, -800, 1500, 8]);
  assert.equal(st.inputs.load_w, undefined);
  const f = pr.freshness(site, asOf);
  assert.deepEqual([f.ok, f.demandOnly, f.status, f.stale, f.missing], [false, true, 'stale_inputs', ['grid_w'], ['load_w']]);
  assert.deepEqual(f.inputs.grid_w, { status: 'stale', ageS: 4000, limitS: 3600, ts: at - 4000, source: 'sunsynk_live' });
  assert.equal(f.reason, 'grid_w 4000 s old (limit 3600 s); load_w missing', 'what plan_run.error records');
  const relaxed = pr.freshness(site, asOf, { grid_w: 7200, load_w: null });
  assert.deepEqual([relaxed.ok, relaxed.status, relaxed.reason], [true, 'ok', null]);
  assert.deepEqual(pr.freshness(site, asOf, { grid_w: 7200, load_w: null, outdoor_temp_c: 3600 }).missing, ['outdoor_temp_c']);
  assert.equal(pr.freshness(site, asOf, { soc_pct: 200 }).inputs.soc_pct.status, 'stale', 'a tighter limit');
  assert.equal(pr.state(site, asOf + 1000).inputs.soc_pct.value, 79, 'seen once recorded');
  // Several indoor sensors (PredHeat averages them): the mean, now and per step; as old as the oldest.
  const rooms = [20, 22].map((v, i) => {
    const d = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, recorded_at) VALUES (?, 'thermostat', 'test', ?, 1)").run(site, `room-${site}-${i}`).lastInsertRowid);
    putR(facts.seriesId('device', d, 'indoor_temp_c', 'heating_telemetry'), [{ ts: at - 1800 + i * 900, value: v }]);
    return d;
  });
  const heat = pr.state(site, asOf).inputs.indoor_temp_c;
  assert.deepEqual([heat.value, heat.ageS, heat.source, heat.seriesIds.length], [21, 1800, 'heating_telemetry', rooms.length]);
  assert.deepEqual(pr.series(site, 'indoor_temp_c', at - 1800, at, { asOf, stepS: 900 }).values, [20, 21], 'one sensor, then both');
});

// ───────────── boundedness ─────────────

// Every statement a call prepares, with its arguments (db.prepare wrapped for the call).
function capture(fn) {
  const orig = db.prepare;
  const seen = [];
  db.prepare = function prepare(sql) {
    const st = orig.call(db, sql);
    const wrap = (m) => (...a) => { seen.push({ sql, args: a, m }); return st[m](...a); };
    return { all: wrap('all'), get: wrap('get'), run: wrap('run'), iterate: wrap('iterate') };
  };
  try { return { out: fn(), seen }; } finally { db.prepare = orig; }
}
const explain = (s) => db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args).map((r) => r.detail);
const FACT_TABLE = /\b(reading|interval_fact|forecast_fact|rate_interval|site_hh)\b/;
const FULL_SCAN = /^SCAN (reading|interval_fact|forecast_fact|rate_interval|site_hh|f|r|a)\b/;
const COUNT = {
  reading: 'SELECT COUNT(*) AS n FROM reading WHERE series_id = ? AND ts >= ? AND ts < ?',
  interval_fact: 'SELECT COUNT(*) AS n FROM interval_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ?',
  forecast_fact: 'SELECT COUNT(*) AS n FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ?',
};

test('bounded: with ten times the history every call makes the same plans and searches the same rows (no full-history scan)', () => {
  const END = dayBounds(TZ, '2026-10-22')[0];
  const asOf = (END + 6 * 3600) * 1000;
  const make = (days) => {
    const site = makeSite();
    const first = END - days * 86400;
    putR(sid(site, 'load_w', 'sunsynk_5min'), every5(first, END + 6 * 3600, () => 900));
    putR(sid(site, 'solar_w', 'sunsynk_5min'), every5(first, END + 6 * 3600, () => 300));
    const totals = []; const ev = [];
    for (let d = localDate(TZ, first); d < localDate(TZ, END); d = addDays(d, 1)) {
      const [a, b] = dayBounds(TZ, d);
      totals.push({ start: a, end: b, value: ((b - a) / 300) * 0.075 * 1.05 });
      ev.push({ start: a + 3600, end: a + 7200, value: 0.5 });
    }
    putI(sid(site, 'load_kwh', 'sunsynk_daily'), totals);
    putI(sid(site, 'ev_charge_kwh', 'octopus_kraken'), ev);
    const fc = sid(site, 'solar_kwh', 'core_forecast');
    for (let t = first; t <= END; t += 86400) {
      facts.putForecasts(fc, t, Array.from({ length: 96 }, (_, i) => ({ start: t + i * 1800, end: t + (i + 1) * 1800, value: ((i * 7 + t / 86400) % 11) / 10 })), null, { recordedAt: t * 1000 });
    }
    return site;
  };
  const small = make(10); const large = make(100);
  const calls = {
    series: (s) => pr.series(s, 'load_w', END - 48 * 3600, END, { asOf }),
    counter: (s) => pr.counterDifferenceSeries(s, 'load_kwh', END - 48 * 3600, END, { asOf }),
    forecast: (s) => pr.forecast(s, 'solar_kwh', END, END + 48 * 3600, { asOf }),
    loadHistory: (s) => pr.loadHistory(s, { daysPrevious: 7, asOf }),
    state: (s) => pr.state(s, asOf),
    rates: (s) => pr.rates(s, END, END + 48 * 3600, { asOf }),
    seriesNow: (s) => pr.series(s, 'solar_w', END - 3600, END),
  };
  for (const [name, call] of Object.entries(calls)) {
    const a = capture(() => call(small)); const b = capture(() => call(large));
    assert.equal(a.seen.filter((s) => s.m === 'run' || /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s.sql)).length, 0, `${name}: reads only`);
    const plans = (c) => c.seen.filter((s) => FACT_TABLE.test(s.sql)).map((s) => explain(s).join(' | '));
    assert.deepEqual(plans(a), plans(b), `${name}: the same plans`);
    for (const p of plans(a)) assert.ok(!p.split(' | ').some((line) => FULL_SCAN.test(line)), `${name}: no full scan in ${p}`);
    // The time bounds of every fact read, relative to the call, and the index rows inside them.
    const shape = (r) => (r.bounds || []).map(({ table, from, to, empty }) => [table, from, to, !!empty]);
    assert.deepEqual(shape(a.out), shape(b.out), `${name}: the same bounds`);
    for (const [i, bound] of (a.out.bounds || []).entries()) {
      if (!COUNT[bound.table] || bound.empty) continue;
      assert.ok(Number.isFinite(bound.from) && Number.isFinite(bound.to), `${name}: ${bound.table} bounded on both sides`);
      const rows = (r) => r.bounds[i].seriesIds.reduce((n, id) => n + db.prepare(COUNT[bound.table]).get(id, bound.from, bound.to).n, 0);
      assert.equal(rows(a.out), rows(b.out), `${name}: ${bound.table} rows in [${bound.from}, ${bound.to})`);
    }
  }
});

// ───────────── the GB home ─────────────

test('GB home snapshot: prices per slot and the inverter counters equal the build (as known at the golden moment); timings', { skip: hasLive ? false : 'no data/core.db' }, (t) => {
  const { asOf: asOfS } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'golden-gb.json'), 'utf8'));
  const SITE = 1;
  const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE).timezone;
  const d2 = addDays(localDate(tz, asOfS), -1); const d1 = addDays(d2, -2);
  const [a] = dayBounds(tz, d1); const [, e] = dayBounds(tz, d2);
  return import('../src/core/build.js').then(({ buildSite }) => {
    const b = buildSite(SITE, d1, d2, { asOf: asOfS, dryRun: true });
    assert.ok(b.hhRows.length >= 140);
    const r = pr.rates(SITE, a, e, { asOf: asOfS * 1000, stepS: 'slot', direction: ['import', 'export', 'gas'] });
    const counters = Object.fromEntries(['solar_kwh', 'battery_charge_kwh', 'battery_discharge_kwh'].map((m) => [m, pr.counterDifferenceSeries(SITE, m, a, e, { asOf: asOfS * 1000, stepS: 'slot' })]));
    const fine = pr.counterDifferenceSeries(SITE, 'solar_kwh', a, e, { asOf: asOfS * 1000 });
    for (const h of b.hhRows) {
      const i = (h.slot_start - r.start) / r.stepS;
      const imp = h.import_rate_ex != null ? h.import_rate_ex * (1 + h.import_vat) : null;
      assert.equal(r.import.values[i], imp, `import ${h.slot_start}`);
      assert.equal(r.export.values[i], h.export_rate, `export ${h.slot_start}`);
      close(r.import.standing[i] + (h.gas != null ? r.gas.standing[i] ?? 0 : 0), h.standing_cost, `standing ${h.slot_start}`, 1e-12);
      assert.equal(r.import.tariff[i], JSON.parse(h.lineage).tariff);
      for (const [m, col] of [['solar_kwh', 'solar'], ['battery_charge_kwh', 'battery_charge'], ['battery_discharge_kwh', 'battery_discharge']]) {
        close(counters[m].values[i] ?? 0, h[col], `${m} ${h.slot_start}`, 1e-12);
      }
      const k = (h.slot_start - fine.start) / 300;
      close(fine.values.slice(k, k + 6).reduce((s, v) => s + (v ?? 0), 0), h.solar, `5-minute solar summed ${h.slot_start}`);
    }
    // Every function on a 48-hour horizon at 5-minute steps (the budget is 50 ms a call; a loose
    // bound here so a slow machine does not fail the suite).
    const now = asOfS;
    const H = 48 * 3600;
    for (const [name, fn] of Object.entries({
      series: () => pr.series(SITE, 'solar_w', now - H, now, { asOf: now * 1000 }),
      counter: () => pr.counterDifferenceSeries(SITE, 'load_kwh', now - H, now, { asOf: now * 1000 }),
      rates: () => pr.rates(SITE, now, now + H, { asOf: now * 1000 }),
      forecast: () => pr.forecast(SITE, 'solar_kwh', now, now + H, { asOf: now * 1000 }),
      loadHistory: () => pr.loadHistory(SITE, { daysPrevious: 7, asOf: now * 1000 }),
      state: () => pr.state(SITE, now * 1000),
      window: () => pr.window(SITE, now),
    })) {
      fn();
      const t0 = performance.now(); const out = fn(); const ms = performance.now() - t0;
      t.diagnostic(`${name}: ${ms.toFixed(1)} ms`);
      assert.ok(ms < 500, `${name} took ${ms} ms`);
      if (out.n != null) assert.equal(out.stepS, 300);
    }
  });
});
