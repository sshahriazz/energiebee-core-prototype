// What the panels should have made in the weather that actually happened, for each past
// half-hour, and how the home's real output compares with it.
//  - Sunlight: Open-Meteo's horizontal sunlight for each past hour at the home's location
//    (interval facts ghi_wm2 / open_meteo). These are Open-Meteo's model values for past
//    hours, not a sensor at the home.
//  - Response: this home's solar per unit of that sunlight for each local hour of the day,
//    fitted exactly as the forecast fits it (learnSunlight: least squares through the origin).
//  - Leave one day out: the fit for day D uses the other days of the window, never D, so a
//    day's own output cannot shape what it is compared with.
// A half-hour without a sunlight fact, or at an hour of day when the other days never had
// sun, has no expected value (null), never 0. Zero sunlight gives 0.
import { db } from '../db/db.js';
import { seriesId, readIntervals } from './facts.js';
import { learnSunlight } from './forecast.js';
import { SLOT, nowSec, zonedParts, localDate, addDays, dayBounds, daysBetween, slotsOfDay } from './time.js';

// Reporting choice: the Solar page's longest view. The window always ends today, so a day
// gets the same expected value whichever period it is viewed in.
export const FIT_DAYS = 30;

const round = (v, d = 3) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const total = (xs, get) => xs.reduce((s, x) => s + get(x), 0);

// Hourly mean W/m² to kWh/m² per half-hour, as the forecast does (an hour's mean holds for both halves).
function sunByHalfHour(facts) {
  const kwh = new Map(); const wm2 = new Map();
  for (const f of facts) {
    if (f.value == null) continue;
    for (let s = f.start_ts; s < f.end_ts; s += SLOT) { kwh.set(s, (f.value * SLOT) / 3600 / 1000); wm2.set(s, f.value); }
  }
  return { kwh, wm2 };
}

// Actual against expected over the half-hours that have both, so a missing hour of sunlight
// or of inverter data never counts as zero on one side only.
function compare(list) {
  const both = list.filter((x) => x.expected != null && x.r.solar != null && x.r.state !== 'missing');
  const actual = total(both, (x) => x.r.solar);
  const expected = total(both, (x) => x.expected);
  return { halfHours: both.length, actual: both.length ? actual : null, expected: both.length ? expected : null, performance: expected > 0 ? actual / expected : null };
}

export function solarExpected(siteId, from, to) {
  const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId).timezone;
  const today = localDate(tz, nowSec());
  const winFrom = addDays(today, 1 - FIT_DAYS);
  const [start] = dayBounds(tz, from < winFrom ? from : winFrom);
  const [, end] = dayBounds(tz, to > today ? to : today);
  const rows = db.prepare('SELECT slot_start, local_date, state, solar, solar_forecast FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start')
    .all(siteId, start, end)
    .map((r) => { const p = zonedParts(tz, r.slot_start); return { ...r, k: p.hh * 2 + (p.mm >= 30 ? 1 : 0) }; });
  const ghiS = seriesId('site', siteId, 'ghi_wm2', 'open_meteo');
  const sun = sunByHalfHour(readIntervals([ghiS], start, end));

  // The window's built half-hours, filtered as the forecast filters its history.
  const hist = rows.filter((r) => r.local_date >= winFrom && r.local_date <= today && r.state !== 'missing');
  const perDay = new Map();
  for (const r of hist) perDay.set(r.local_date, (perDay.get(r.local_date) || 0) + 1);
  const wholeDays = new Set([...perDay].filter(([d, n]) => n === slotsOfDay(tz, d).length).map(([d]) => d));
  const fits = new Map();
  const fitFor = (date) => {
    if (!fits.has(date)) fits.set(date, learnSunlight(hist.filter((r) => r.local_date !== date), sun.kwh, new Set([...wholeDays].filter((d) => d !== date))));
    return fits.get(date);
  };
  const expectedAt = (r) => {
    const g = sun.kwh.get(r.slot_start);
    const fit = fitFor(r.local_date);
    if (g == null || !fit.ok) return { r, expected: null, ratio: null };
    if (g === 0) return { r, expected: 0, ratio: null };
    const ratio = fit.ratios.get(r.k >> 1);
    return { r, expected: ratio == null ? null : ratio * g, ratio: ratio ?? null };
  };

  // Out-of-sample check over the window: each daylight half-hour against the fit made without its day.
  const oos = hist.filter((r) => r.solar != null && sun.kwh.get(r.slot_start) > 0).map(expectedAt).filter((x) => x.expected != null);
  const meanA = oos.length ? total(oos, (x) => x.r.solar) / oos.length : null;
  const ssTot = total(oos, (x) => (x.r.solar - meanA) ** 2);
  const ssRes = total(oos, (x) => (x.r.solar - x.expected) ** 2);

  const period = rows.filter((r) => r.local_date >= from && r.local_date <= to).map(expectedAt);
  const days = daysBetween(from, to).map((date) => {
    const list = period.filter((x) => x.r.local_date === date);
    const fit = fitFor(date);
    const c = compare(list);
    // Forecast of record (site_hh.solar_forecast) against actual over the half-hours that had one.
    const fc = list.filter((x) => x.r.solar_forecast != null && x.r.solar != null && x.r.state !== 'missing');
    return {
      date, halfHours: list.length, whole: list.length === slotsOfDay(tz, date).length && date < today,
      compared: c.halfHours, actual: round(c.actual), expected: round(c.expected), performance: round(c.performance, 4),
      expectedComplete: list.length > 0 && c.halfHours === list.length,
      fit: { ok: fit.ok, days: fit.days, halfHours: fit.halfHours, reason: fit.reason },
      forecastHalfHours: fc.length,
      forecast: fc.length ? round(total(fc, (x) => x.r.solar_forecast)) : null,
      forecastActual: fc.length ? round(total(fc, (x) => x.r.solar)) : null,
      // A day's forecast total is comparable with its output only when every built half-hour had one.
      forecastComplete: list.length > 0 && fc.length === list.length,
    };
  });
  const all = compare(period);
  const closed = days.filter((d) => d.whole && d.performance != null).map((d) => d.performance);
  const stored = db.prepare('SELECT MIN(start_ts) AS a, MAX(end_ts) AS b, COUNT(*) AS n FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL AND value IS NOT NULL').get(ghiS);

  return {
    from, to, timezone: tz,
    method: {
      text: `For each past half-hour: Open-Meteo's horizontal sunlight for that hour × what this home's panels made per unit of that sunlight at the same hour of day on the other days of the last ${FIT_DAYS} (least squares through the origin, leaving the day itself out). An expectation, not a measurement. Half-hours without a sunlight fact have no expected value.`,
      sunlight: { metric: 'ghi_wm2', source: 'open_meteo', note: "Open-Meteo's model values for past hours at the home's location, not a measurement at the home" },
      fit: 'learnSunlight (src/core/forecast.js): per local hour of day, Σ(solar × sunlight) ÷ Σ(sunlight²) over half-hours with sunlight above zero',
      leaveOneDayOut: true,
      window: { from: winFrom, to: today, days: FIT_DAYS, daysWithData: perDay.size },
      forecastOfRecord: 'site_hh.solar_forecast: the latest forecast issued before each half-hour started, kept from 16 Oct 2026',
    },
    sunlight: { from: stored.a, to: stored.b, hours: stored.n },
    check: {
      basis: 'each daylight half-hour of the window against the fit made without its own day (out of sample)',
      halfHours: oos.length, r2: ssTot > 0 ? round(1 - ssRes / ssTot) : null,
      maeKwh: oos.length ? round(total(oos, (x) => Math.abs(x.r.solar - x.expected)) / oos.length) : null,
    },
    totals: {
      compared: all.halfHours, actual: round(all.actual), expected: round(all.expected), performance: round(all.performance, 4),
      wholeDays: { days: closed.length, low: closed.length ? Math.min(...closed) : null, high: closed.length ? Math.max(...closed) : null },
    },
    days,
    slots: period.map((x) => ({ slot_start: x.r.slot_start, expected: round(x.expected, 4), ghi_wm2: sun.wm2.get(x.r.slot_start) ?? null, ratio: round(x.ratio) })),
  };
}
