// Next 48 hours, per slot of the home's own length (site.slot_s: 15, 30 or 60 minutes; the
// text below says half-hour, the default). Every number comes from this home's own last 14 days
// in site_hh or from a provider's forecast. When the data is not enough, that part is
// left out and `model` says why; nothing falls back to a default.
//  - solar: Quartz when the panel angles are known, otherwise this home's learned
//    response to Open-Meteo's forecast of sunlight on flat ground;
//  - house use: median of the same half-hour on the same kind of day (weekday or
//    weekend), scaled for the temperature forecast when heating clearly drives use,
//    plus planned EV charging;
//  - battery: the limits, charge levels and losses this battery has shown, plus the
//    grid charging the home has done at the same time on most recent days;
//  - prices and carbon: published rates and the regional carbon forecast.
// Each half-hour also carries a low and a high case, and `accuracy` scores our own
// stored forecasts (source core_forecast) against what the home then used.
import { db } from '../db/db.js';
import { seriesId, readForecastOfRecord, readReadings, readIntervals } from './facts.js';
import { loadPricing, priceOver } from './pricing.js';
import { SLOT, nowSec, localDate, dayBounds, slotsOfDay, slotLength, slotPhase, slotFloor, slotsPerDay, slotOfDay, slotLabel, todMinute, eachSlotOverlap } from './time.js';

// Reporting choices and decision rules from the brief, not measured quantities.
const HISTORY_DAYS = 14;
const LOW_Q = 0.1; const HIGH_Q = 0.9;
const MIN_DAYS = 3;                                   // a day type, a range or the sunlight fit needs 3 days
const HDD_BASES = Array.from({ length: 21 }, (_, i) => 10 + i * 0.5);   // degC searched for the heating base
const QUARTZ_RATIO = [0.5, 2];                        // actual ÷ Quartz outside this points to wrong panel details
const ACCURACY_LEAD = 12 * 3600;                      // score what a user saw the evening before

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const quantile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p; const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const median = (xs) => quantile(xs, 0.5);
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
// Slot-of-day index k comes from the local clock (time.js slotOfDay); at 30 minutes k = hh*2 + (mm >= 30).
const hourOf = (k, slotS) => Math.floor((k * slotS) / 3600);
// Per-slot energy thresholds are written for a half-hour and scale with the slot length.
const perSlot = (kwhPerHalfHour, slotS) => (kwhPerHalfHour * slotS) / 1800;
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const lineFit = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r2: (sxy * sxy) / (sxx * syy) };
};
// Hourly mean W/m2 facts to kWh/m2 per slot (an hour's mean holds over every part of it), and
// the mean W/m2 of each slot. A slot inside one hour takes that hour's value; a slot spanning
// two hours (60-minute slots in a zone at a half-hour offset) adds its share of each.
export function sunBySlot(facts, slotS = SLOT, phase = 0) {
  const kwh = new Map(); const wm2 = new Map();
  for (const f of facts) {
    if (f.value == null) continue;
    eachSlotOverlap(f, slotS, phase, (s, share, o) => {
      const e = (f.value * o) / 3600 / 1000;
      if (o === slotS) { kwh.set(s, e); wm2.set(s, f.value); return; }
      kwh.set(s, (kwh.get(s) || 0) + e); wm2.set(s, (wm2.get(s) || 0) + (f.value * o) / slotS);
    });
  }
  return { kwh, wm2 };
}

// House use (EV excluded) per half-hour of day. Weekends often look different,
// so each day type uses its own days once there are enough of them.
function learnProfile(hist) {
  const days = { weekday: new Set(), weekend: new Set() };
  const vals = { weekday: new Map(), weekend: new Map(), all: new Map() };
  for (const r of hist) {
    const type = r.weekend ? 'weekend' : 'weekday';
    days[type].add(r.local_date);
    for (const g of [type, 'all']) (vals[g].get(r.k) || vals[g].set(r.k, []).get(r.k)).push(r.base);
  }
  const use = { weekday: days.weekday.size >= MIN_DAYS ? 'weekday' : 'all', weekend: days.weekend.size >= MIN_DAYS ? 'weekend' : 'all' };
  const cache = new Map();
  const at = (weekend, k) => {
    const g = use[weekend ? 'weekend' : 'weekday'];
    const key = `${g}|${k}`;
    if (!cache.has(key)) {
      const xs = vals[g].get(k) || vals.all.get(k) || [];
      cache.set(key, xs.length ? { mid: median(xs), low: quantile(xs, LOW_Q), high: quantile(xs, HIGH_Q) } : null);
    }
    return cache.get(key);
  };
  return { at, weekdayDays: days.weekday.size, weekendDays: days.weekend.size, weekdaysUse: use.weekday, weekendsUse: use.weekend };
}

// Daily house use against heating degree days, with the base temperature found in
// the data. Applied only when heating clearly drives use; otherwise a few warm or
// cold days would just move the forecast at random.
function fitTemperature(hist, wholeDays) {
  const byDay = new Map();
  for (const r of hist) {
    if (!wholeDays.has(r.local_date)) continue;
    const d = byDay.get(r.local_date) || byDay.set(r.local_date, { n: 0, use: 0, temps: [] }).get(r.local_date);
    d.n++; d.use += r.base;
    if (r.outdoor_temp != null) d.temps.push(r.outdoor_temp);
  }
  // A day's mean temperature only when every half-hour has one.
  const pts = [...byDay.values()].filter((d) => d.temps.length === d.n).map((d) => ({ use: d.use, t: mean(d.temps) }));
  const fit = { days: pts.length, baseC: null, intercept: null, slope: null, r2: null, typicalKwh: null, applied: false, reason: null };
  if (pts.length < 7) return { ...fit, reason: `${pts.length} whole days with temperatures; needs 7` };
  // Only a base where use rises as it gets colder can be applied, so the search keeps those.
  let best = null;
  for (const base of HDD_BASES) {
    const f = lineFit(pts.map((p) => Math.max(0, base - p.t)), pts.map((p) => p.use));
    if (f && f.slope > 0 && (!best || f.r2 > best.r2)) best = { ...f, base };
  }
  if (!best) return { ...fit, reason: `use does not rise in colder weather at any base from ${HDD_BASES[0]} to ${HDD_BASES[HDD_BASES.length - 1]} °C` };
  const applied = best.r2 >= 0.3;
  // The regression passes through the mean, so the typical day is the mean daily use.
  return {
    ...fit, baseC: best.base, intercept: best.intercept, slope: best.slope, r2: best.r2, typicalKwh: mean(pts.map((p) => p.use)), applied,
    reason: applied ? null : `best fit (base ${best.base} °C) has R² ${best.r2.toFixed(2)}, below 0.3`,
  };
}

// Quartz's forecast of record for past half-hours: for each, the latest issue made before
// it started. Read from Quartz's own series, so our stored forecast never counts as Quartz.
function quartzOfRecord(seriesKey, from, to, slotS, phase) {
  const rows = db.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts')
    .all(seriesKey, from, to);
  const best = new Map();
  for (const f of rows) if (!best.has(f.start_ts) || f.issued_at > best.get(f.start_ts).issued_at) best.set(f.start_ts, f);
  return energyBySlot(best.values(), slotS, phase);
}

// Energy forecasts (kWh per period) to kWh per slot, split by overlap.
function energyBySlot(facts, slotS, phase) {
  const bySlot = new Map();
  for (const f of facts) eachSlotOverlap(f, slotS, phase, (s, share) => bySlot.set(s, (bySlot.get(s) || 0) + (f.value || 0) * share));
  return bySlot;
}

// How this home's panels compare with Quartz: shading, soiling, clipping and
// inverter limits that a forecast for the location cannot know. A ratio far from 1
// is not scaled away: it means Quartz was given the wrong panels.
function calibrateQuartz(hist, wholeDays, quartzBySlot) {
  const days = new Map();
  for (const r of hist) {
    const q = quartzBySlot.get(r.slot_start);
    if (r.solar == null || q == null || !(r.solar > 0 || q > 0)) continue;   // night
    const d = days.get(r.local_date) || days.set(r.local_date, { actual: 0, forecast: 0 }).get(r.local_date);
    d.actual += r.solar; d.forecast += q;
  }
  const actual = [...days.values()].reduce((s, d) => s + d.actual, 0);
  const forecast = [...days.values()].reduce((s, d) => s + d.forecast, 0);
  const ratio = forecast > 0 ? actual / forecast : null;
  const enough = days.size >= 2 && forecast >= 2;
  const plausible = ratio != null && ratio >= QUARTZ_RATIO[0] && ratio <= QUARTZ_RATIO[1];
  const applied = enough && plausible;
  const factor = applied ? ratio : 1;
  // Spread from whole days only: a part day (today so far) is mostly morning.
  const ratios = [...days].filter(([date, d]) => wholeDays.has(date) && d.forecast > 0).map(([, d]) => d.actual / d.forecast);
  return {
    applied, factor, ratio, days: days.size, forecastKwh: forecast, actualKwh: actual,
    reason: applied ? null : !enough
      ? `${days.size} day(s) and ${forecast.toFixed(1)} kWh of forecast to compare; needs 2 days and 2 kWh`
      : `this home made ${ratio.toFixed(2)}× Quartz's forecast over ${days.size} days; outside ${QUARTZ_RATIO[0]}–${QUARTZ_RATIO[1]}×, which points to wrong panel details (check them against the MCS paperwork)`,
    range: ratios.length >= MIN_DAYS ? { basis: 'daily actual/Quartz ratios', days: ratios.length, low: Math.min(factor, quantile(ratios, LOW_Q)), high: Math.max(factor, quantile(ratios, HIGH_Q)) } : null,
    rangeReason: ratios.length >= MIN_DAYS ? null : `${ratios.length} whole day(s) of actual-vs-forecast history; needs ${MIN_DAYS}`,
  };
}

// This home's response to sunlight, for when Quartz cannot be used: per local hour of
// day, a least-squares fit through the origin of actual solar against horizontal
// sunlight energy. Bright half-hours weigh most, so dawn and dusk need no cut-off.
// Also used by solar-expected.js for what the panels should have made in past weather.
export function learnSunlight(hist, sun, wholeDays, slotS = SLOT) {
  const pairs = hist.filter((r) => r.solar != null && sun.get(r.slot_start) > 0)
    .map((r) => ({ h: hourOf(r.k, slotS), a: r.solar, g: sun.get(r.slot_start), date: r.local_date }));
  const days = new Set(pairs.map((p) => p.date)).size;
  const out = { ok: false, days, halfHours: pairs.length, ratios: new Map(), r2: null, maeKwh: null, range: null, rangeReason: null, reason: null };
  if (days < MIN_DAYS) return { ...out, reason: `${days} day(s) of solar and sunlight history; needs ${MIN_DAYS}` };
  const sums = new Map();
  for (const p of pairs) { const s = sums.get(p.h) || sums.set(p.h, { ag: 0, gg: 0 }).get(p.h); s.ag += p.a * p.g; s.gg += p.g * p.g; }
  for (const [h, s] of sums) out.ratios.set(h, s.ag / s.gg);
  const fitted = pairs.map((p) => out.ratios.get(p.h) * p.g);
  const ma = mean(pairs.map((p) => p.a));
  const ssTot = pairs.reduce((s, p) => s + (p.a - ma) ** 2, 0);
  const ssRes = pairs.reduce((s, p, i) => s + (p.a - fitted[i]) ** 2, 0);
  // Daily spread around the fit, whole days only. It is in-sample: it shows how this
  // home's output varies under the same sunlight, not errors in the sunlight forecast.
  const byDay = new Map();
  pairs.forEach((p, i) => { if (!wholeDays.has(p.date)) return; const d = byDay.get(p.date) || byDay.set(p.date, { a: 0, f: 0 }).get(p.date); d.a += p.a; d.f += fitted[i]; });
  const ratios = [...byDay.values()].filter((d) => d.f > 0).map((d) => d.a / d.f);
  return {
    ...out, ok: true, r2: ssTot > 0 ? 1 - ssRes / ssTot : null, maeKwh: mean(pairs.map((p, i) => Math.abs(p.a - fitted[i]))),
    range: ratios.length >= MIN_DAYS ? { basis: 'daily actual/fitted ratios on the history (in-sample)', days: ratios.length, low: Math.min(1, quantile(ratios, LOW_Q)), high: Math.max(1, quantile(ratios, HIGH_Q)) } : null,
    rangeReason: ratios.length >= MIN_DAYS ? null : `${ratios.length} whole day(s) of solar and sunlight history; needs ${MIN_DAYS}`,
  };
}

// Grid charging the home actually does: half-hours of the day when the battery took
// more than 0.05 kWh from the grid on at least half of recent days. It reads the
// outcome, not the inverter settings, so it works for any inverter or tariff.
function learnGridCharging(hist, cap, slotS = SLOT) {
  const nDays = new Set(hist.map((r) => r.local_date)).size;
  const n = slotsPerDay(slotS);
  const label = (k) => slotLabel(k, slotS);
  const threshold = perSlot(0.05, slotS);
  const slots = new Map();
  const out = { days: nDays, thresholdKwh: threshold, minShare: 0.5, windows: [], skipped: [], slots, reason: null };
  const at = new Map();
  for (const r of hist) {
    const a = at.get(r.k) || at.set(r.k, { days: 0, charged: [], soc: [] }).get(r.k);
    a.days++;
    if ((r.grid_to_battery ?? 0) > threshold) a.charged.push(r.grid_to_battery);
    if (r.soc_end != null) a.soc.push(r.soc_end);
  }
  const inWindow = (k) => { const a = at.get(k); return !!a && a.charged.length / a.days >= 0.5; };
  for (let k = 0; k < n; k++) {
    // A window starts where the slot before it (wrapping past midnight) is not in one.
    if (!inWindow(k) || inWindow((k + n - 1) % n)) continue;
    const run = [];
    for (let j = k; inWindow(j) && run.length < n; j = (j + 1) % n) run.push(j);
    const span = `${label(run[0])}–${label(run[run.length - 1] + 1)}`;
    const targetPct = median(at.get(run[run.length - 1]).soc);
    if (targetPct == null) { out.skipped.push(`${span}: no charge level recorded at its end`); continue; }
    for (const j of run) slots.set(j, { kwh: median(at.get(j).charged), targetKwh: (cap * targetPct) / 100 });
    out.windows.push({
      from: label(run[0]), to: label(run[run.length - 1] + 1), targetSocPct: round(targetPct, 0),
      halfHours: run.map((j) => ({ time: label(j), share: round(at.get(j).charged.length / at.get(j).days), kwh: round(median(at.get(j).charged)) })),
    });
  }
  if (!out.windows.length) out.reason = out.skipped.length ? out.skipped.join('; ') : 'the battery did not charge from the grid at the same time on most days';
  return out;
}

// When the battery holds its charge on purpose: half-hours of the day when, on at
// least half of recent days, the house drew from the grid (over 0.05 kWh) while the
// battery had charge above its lowest level and did not discharge (under 0.05 kWh).
// Like the charge window, it reads what the inverter did, not its settings.
function learnHold(hist, minSocPct, chargeSlots, slotS = SLOT) {
  const n = slotsPerDay(slotS);
  const threshold = perSlot(0.05, slotS);
  const at = new Map();
  for (const r of hist) {
    if (r.soc_end == null) continue;
    const a = at.get(r.k) || at.set(r.k, { days: 0, held: 0 }).get(r.k);
    a.days++;
    if ((r.grid_to_home ?? 0) > threshold && (r.battery_discharge ?? 0) <= threshold && r.soc_end > minSocPct) a.held++;
  }
  const slots = new Set();
  for (const [k, a] of at) if (!chargeSlots.has(k) && a.days && a.held / a.days >= 0.5) slots.add(k);
  const keys = [...slots].sort((x, y) => x - y);
  const windows = [];
  for (const k of keys) {
    if (slots.has((k + n - 1) % n) && keys.length < n) continue;
    let j = k; const run = [];
    while (slots.has(j) && run.length < n) { run.push(j); j = (j + 1) % n; }
    windows.push({ from: slotLabel(run[0], slotS), to: slotLabel(run[run.length - 1] + 1, slotS), halfHours: run.length });
  }
  return { slots, windows, thresholdKwh: threshold, minShare: 0.5 };
}

// The battery as it has actually behaved: largest half-hour charge and discharge,
// lowest and highest charge level, and round-trip efficiency measured as
// discharge ÷ (charge − change in stored energy).
function learnBattery(hist, cap, start, slotS = SLOT) {
  const out = { usable: false, reason: null, capacityKwh: cap || null, efficiency: null, efficiencyReason: null };
  if (!cap) return { ...out, reason: 'no battery capacity is configured for this home' };
  const soc = hist.filter((r) => r.soc_end != null).map((r) => r.soc_end);
  if (!soc.length) return { ...out, reason: 'no charge-level history' };
  if (!start) return { ...out, reason: 'no charge-level reading to start from' };
  const maxCharge = Math.max(0, ...hist.map((r) => r.battery_charge || 0));
  const maxDischarge = Math.max(0, ...hist.map((r) => r.battery_discharge || 0));
  if (!maxCharge && !maxDischarge) return { ...out, reason: 'the battery did not charge or discharge in the history' };
  // Only pairs of consecutive half-hours, so a gap never drops energy from the sums.
  let charge = 0; let discharge = 0; let stored = 0;
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1]; const b = hist[i];
    if (b.slot_start - a.slot_start !== slotS || a.soc_end == null || b.soc_end == null) continue;
    charge += b.battery_charge || 0; discharge += b.battery_discharge || 0; stored += ((b.soc_end - a.soc_end) / 100) * cap;
  }
  const eff = charge - stored > 0 ? discharge / (charge - stored) : null;
  // Above 100% is impossible: the charge level and the energy counters disagree.
  const measured = eff != null && eff > 0 && eff <= 1;
  return {
    ...out, usable: true,
    minSocPct: Math.min(...soc), maxSocPct: Math.max(...soc), maxChargeKwh: maxCharge, maxDischargeKwh: maxDischarge,
    efficiency: measured ? eff : null, measuredOver: { chargeKwh: charge, dischargeKwh: discharge, storedChangeKwh: stored },
    efficiencyReason: measured ? null : eff == null ? 'no unbroken run of half-hours with charge levels' : `measured ${eff.toFixed(3)}, which is not possible`,
    startSocPct: start.pct, startAt: start.at,
  };
}

// One run of the battery. `homeKey` and `solarKey` pick the case (expected, low or high).
// Losses are taken on the way out, which is exactly what the efficiency measures.
function simulate(slots, wins, holds, b, homeKey, solarKey) {
  const eff = b.efficiency ?? 1;
  const minKwh = b.usable ? (b.capacityKwh * b.minSocPct) / 100 : 0;
  const maxKwh = b.usable ? (b.capacityKwh * b.maxSocPct) / 100 : 0;
  let stored = b.usable ? (b.capacityKwh * b.startSocPct) / 100 : 0;
  return slots.map((r, i) => {
    const home = r[homeKey]; const solar = r[solarKey];
    if (home == null || solar == null) return null;
    let net = solar - home;
    let solarIn = 0; let gridIn = 0; let out = 0;
    if (b.usable) {
      if (net > 0) { solarIn = Math.max(0, Math.min(net, b.maxChargeKwh, maxKwh - stored)); stored += solarIn; net -= solarIn; }
      if (wins[i]) {
        // Inside a learned window the inverter charges from the grid up to the target
        // and holds the charge rather than spending it on the house.
        if (stored < wins[i].targetKwh) { gridIn = Math.max(0, Math.min(wins[i].kwh, b.maxChargeKwh - solarIn, wins[i].targetKwh - stored)); stored += gridIn; }
      } else if (net < 0 && r.ev === 0 && !holds[i]) {
        out = Math.min(-net, b.maxDischargeKwh, Math.max(0, stored - minKwh) * eff); stored -= out / eff; net += out;
      }
    }
    return { solarIn, gridIn, out, imp: Math.max(0, -net) + gridIn, exp: Math.max(0, net), soc: b.usable ? (stored / b.capacityKwh) * 100 : null };
  });
}

// How our own stored forecasts did: each finished slot of the last 7 days against the
// latest forecast issued at least 12 hours before it. Forecast periods are matched to the slot
// by overlap (a forecast stored in half-hours scores 15-minute or hourly slots by its share).
function scoreAccuracy(siteId, tz, now, slotS = SLOT) {
  const fcS = seriesId('site', siteId, 'load_kwh', 'core_forecast');
  const hh = db.prepare(`SELECT slot_start, local_date, home FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start + dur_s <= ? AND dur_s = ?
      AND state != 'missing' AND home IS NOT NULL ORDER BY slot_start`).all(siteId, now - 7 * 86400, now, slotS);
  const facts = hh.length ? db.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ? AND issued_at <= end_ts - ? ORDER BY start_ts')
    .all(fcS, hh[0].slot_start, hh[hh.length - 1].slot_start + slotS, ACCURACY_LEAD) : [];
  const rows = [];
  let lo = 0;
  for (const h of hh) {
    const end = h.slot_start + slotS;
    // Our forecast periods are slots, never longer than an hour.
    while (lo < facts.length && facts[lo].start_ts + 3600 <= h.slot_start) lo++;
    const over = [];
    for (let i = lo; i < facts.length && facts[i].start_ts < end; i++) {
      const f = facts[i];
      if (f.end_ts > h.slot_start && f.issued_at <= h.slot_start - ACCURACY_LEAD) over.push(f);
    }
    if (!over.length) continue;
    const issue = Math.max(...over.map((f) => f.issued_at));
    const used = over.filter((f) => f.issued_at === issue);
    if (used.some((f) => f.value == null)) continue;
    let value = 0;
    for (const f of used) {
      const o = Math.min(f.end_ts, end) - Math.max(f.start_ts, h.slot_start);
      value += o === f.end_ts - f.start_ts ? f.value : (f.value * o) / (f.end_ts - f.start_ts);
    }
    rows.push({ ...h, value });
  }
  const days = new Map();
  for (const r of rows) {
    const d = days.get(r.local_date) || days.set(r.local_date, { date: r.local_date, n: 0, actual: 0, forecast: 0 }).get(r.local_date);
    d.n++; d.actual += r.home; d.forecast += r.value;
  }
  // Nothing until a whole day has been scored: part days say more about luck than method.
  const whole = [...days.values()].filter((d) => d.n === slotsOfDay(tz, d.date, slotS).length);
  if (!whole.length) return null;
  const actual = whole.reduce((s, d) => s + d.actual, 0);
  return {
    leadHours: ACCURACY_LEAD / 3600, windowDays: 7, samples: rows.length, days: whole.length,
    maeKwh: round(mean(rows.map((r) => Math.abs(r.value - r.home))), 3),
    dailyErrorPct: actual > 0 ? round((whole.reduce((s, d) => s + Math.abs(d.forecast - d.actual), 0) / actual) * 100, 1) : null,
  };
}

export function forecastSite(siteId, hours = 48) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const tz = site.timezone;
  const now = nowSec();
  // The home's slot grid; slots per nominal day (48 at 30 minutes) for "next 24 hours".
  const slotS = slotLength(site);
  const phase = slotPhase(tz, slotS, now);
  const nDay = slotsPerDay(slotS);
  const from = slotFloor(now, slotS, phase);
  const to = from + hours * 3600;
  const sid = (m, s) => seriesId('site', siteId, m, s);
  const cap = site.battery_kwh || 0;
  const histFrom = from - HISTORY_DAYS * 86400;

  // The home's own recent slots (of its current length): everything below is learned from these.
  const hist = db.prepare(
    `SELECT slot_start, local_date, tod_min, home, ev, solar, solar_forecast, battery_charge, battery_discharge, grid_to_battery, grid_to_home, soc_end, outdoor_temp
     FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND state != ? AND dur_s = ? ORDER BY slot_start`)
    .all(siteId, histFrom, from, 'missing', slotS)
    .map((r) => ({ ...r, k: Math.floor(r.tod_min / (slotS / 60)), weekend: isWeekend(r.local_date), base: Math.max(0, (r.home || 0) - (r.ev || 0)) }));
  const perDay = new Map();
  for (const r of hist) perDay.set(r.local_date, (perDay.get(r.local_date) || 0) + 1);
  const wholeDays = new Set([...perDay].filter(([date, n]) => n === slotsOfDay(tz, date, slotS).length).map(([date]) => date));
  const profile = learnProfile(hist);
  const temperature = fitTemperature(hist, wholeDays);
  const charging = learnGridCharging(hist, cap, slotS);

  // Solar: Quartz needs the panel angles; without them, the home's learned response to sunlight.
  const anglesKnown = site.pv_tilt != null && site.pv_orientation != null;
  const quartzFc = anglesKnown ? readForecastOfRecord(sid('solar_kwh', 'quartz'), from, to, now + 60) : [];
  const ghiS = sid('ghi_wm2', 'open_meteo');
  const sunFc = readForecastOfRecord(ghiS, from - 3600, to, now + 60);
  const quartzCal = calibrateQuartz(hist, wholeDays, anglesKnown ? quartzOfRecord(sid('solar_kwh', 'quartz'), histFrom, from, slotS, phase) : new Map());
  const sunlight = learnSunlight(hist, sunBySlot(readIntervals([ghiS], histFrom - 3600, from), slotS, phase).kwh, wholeDays, slotS);
  // Quartz is used once it has been checked against this home's output (calibrated). Until then the
  // forecast learned from this home's own output and sunlight is used, because uncalibrated Quartz
  // was seen to miss this home badly (e.g. a 2.0 kW peak forecast while the panels made 3.9 kW).
  const solarPath = quartzFc.length && quartzCal.applied ? 'quartz' : sunlight.ok && sunFc.length ? 'sunlight' : quartzFc.length ? 'quartz' : null;
  // No half-hour is forecast above the most this home has ever produced in one.
  const solarCeiling = hist.reduce((m, r) => Math.max(m, r.solar || 0), 0) || null;
  const ceil = (v) => (v == null ? null : solarCeiling ? Math.min(v, solarCeiling) : v);
  // Raw solar per half-hour from the path in use; the expected value and the range
  // are multiples of it (the sunlight fit is already this home's own, so its factor is 1).
  const rawBy = new Map();
  let solarIssued = null; let solarFactor = null; let solarRange = null; let solarRangeReason = null;
  if (solarPath === 'quartz') {
    for (const [s, v] of energyBySlot(quartzFc, slotS, phase)) rawBy.set(s, v);
    solarIssued = Math.max(...quartzFc.map((f) => f.issued_at));
    solarFactor = quartzCal.factor; solarRange = quartzCal.range; solarRangeReason = quartzCal.rangeReason;
  } else if (solarPath === 'sunlight') {
    // An hour with forecast sun but no history at that hour of day stays unknown.
    for (const [s, g] of sunBySlot(sunFc, slotS, phase).kwh) {
      const ratio = sunlight.ratios.get(Math.floor(todMinute(tz, s) / 60));
      if (g === 0) rawBy.set(s, 0);
      else if (ratio != null) rawBy.set(s, ratio * g);
    }
    solarIssued = Math.max(...sunFc.map((f) => f.issued_at));
    solarFactor = 1; solarRange = sunlight.range; solarRangeReason = sunlight.rangeReason;
  }

  const evFc = readForecastOfRecord(sid('ev_charge_kwh', 'octopus_kraken'), from - 3600, to, now + 60);
  const evAt = (slot) => evFc.reduce((s, f) => {
    const o = Math.min(f.end_ts, slot + slotS) - Math.max(f.start_ts, slot);
    return o > 0 && f.value != null ? s + (f.value * o) / (f.end_ts - f.start_ts) : s;
  }, 0);
  // Carbon intensity is a mean: a slot takes the time-weighted mean of the periods it overlaps
  // (one half-hour period covers a 15 or 30-minute slot; two make an hour). Read from an hour
  // earlier, so a period that started before the first slot still counts.
  const carbonFc = site.carbon_region != null
    ? readForecastOfRecord(seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional'), from - 3600, to, now + 60) : [];
  const carbonAt = (slot) => {
    const over = carbonFc.filter((f) => f.value != null && f.end_ts > slot && f.start_ts < slot + slotS);
    if (over.length === 1) return over[0].value;
    let num = 0; let den = 0;
    for (const f of over) { const o = Math.min(f.end_ts, slot + slotS) - Math.max(f.start_ts, slot); num += f.value * o; den += o; }
    return den ? num / den : null;
  };
  const pricing = loadPricing(siteId, from, to);

  // Each forecast day's mean temperature from Open-Meteo (today's past hours as
  // recorded, the rest from the latest forecast) and, when the fit applies, its use scale.
  const tempS = sid('outdoor_temp_c', 'open_meteo');
  const fcDays = new Map();
  const dayOf = (date) => {
    if (fcDays.has(date)) return fcDays.get(date);
    const [a, b] = dayBounds(tz, date);
    const temps = new Map(readForecastOfRecord(tempS, a, b, now + 60).map((f) => [f.start_ts, f.value]));
    for (const r of readReadings([tempS], a, b)) temps.set(r.ts, r.value);
    const vals = [...temps.values()].filter((v) => v != null);
    // A day's mean only when every hour of it has a temperature.
    const t = vals.length === (b - a) / 3600 ? mean(vals) : null;
    const d = { date, meanTempC: round(t, 1), predictedKwh: null, scale: 1 };
    if (temperature.applied && t != null && temperature.typicalKwh > 0) {
      const predicted = Math.max(0, temperature.intercept + temperature.slope * Math.max(0, temperature.baseC - t));
      Object.assign(d, { predictedKwh: round(predicted, 1), scale: round(predicted / temperature.typicalKwh, 3) });
    }
    fcDays.set(date, d);
    return d;
  };

  // Battery starts from the latest known charge level: a reading, or the last built half-hour.
  const socRow = readReadings([sid('battery_soc_pct', 'sunsynk_live'), sid('battery_soc_pct', 'sunsynk_5min')], histFrom, now + 1).pop();
  const lastHh = [...hist].reverse().find((r) => r.soc_end != null);
  const start = socRow && (!lastHh || socRow.ts >= lastHh.slot_start + slotS) ? { pct: socRow.value, at: socRow.ts }
    : lastHh ? { pct: lastHh.soc_end, at: lastHh.slot_start + slotS } : null;
  const battery = learnBattery(hist, cap, start, slotS);

  const hold = battery.usable ? learnHold(hist, battery.minSocPct, charging.slots, slotS) : { slots: new Set(), windows: [] };
  const slots = [];
  const wins = [];
  const holds = [];
  for (let t = from; t < to; t += slotS) {
    const k = slotOfDay(tz, t, slotS);
    const date = localDate(tz, t);
    const use = profile.at(isWeekend(date), k);
    const scale = dayOf(date).scale;
    const ev = evAt(t);
    const raw = rawBy.has(t) ? rawBy.get(t) : null;
    const pi = priceOver(pricing, 'meter_import', t, slotS);
    const pe = priceOver(pricing, 'meter_export', t, slotS);
    const imp = pi?.unitEx != null ? pi.unitEx * (1 + pi.vat) : null;
    const expRate = pe?.unitEx != null ? pe.unitEx * (1 + pe.vat) : null;
    slots.push({
      slot_start: t, local_date: date, solar: raw == null ? null : ceil(raw * solarFactor), home: use ? use.mid * scale + ev : null, ev,
      import_rate: imp, export_rate: expRate, carbon_intensity: carbonAt(t),
      solar_low: raw != null && solarRange ? ceil(raw * solarRange.low) : null, solar_high: raw != null && solarRange ? ceil(raw * solarRange.high) : null,
      home_low: use ? use.low * scale + ev : null, home_high: use ? use.high * scale + ev : null,
    });
    wins.push(battery.usable ? charging.slots.get(k) || null : null);
    holds.push(hold.slots.has(k));
  }

  // Three runs of the battery: expected; low (low use, high solar); high (high use, low solar).
  // Without a solar range the low and high cases carry the house-use spread only.
  for (const s of slots) { s._solarLow = s.solar_low ?? s.solar; s._solarHigh = s.solar_high ?? s.solar; }
  const mid = simulate(slots, wins, holds, battery, 'home', 'solar');
  const low = simulate(slots, wins, holds, battery, 'home_low', '_solarHigh');
  const high = simulate(slots, wins, holds, battery, 'home_high', '_solarLow');
  slots.forEach((row, i) => {
    delete row._solarLow; delete row._solarHigh;
    const m = mid[i];
    if (!m) return;
    Object.assign(row, {
      battery_charge: m.solarIn + m.gridIn, battery_discharge: m.out, grid_import: m.imp, grid_export: m.exp, soc_end: m.soc,
      solar_to_battery: m.solarIn, grid_to_battery: m.gridIn, grid_import_low: low[i].imp, grid_import_high: high[i].imp,
    });
    if (row.import_rate != null) {
      const cost = (r) => r.imp * row.import_rate - r.exp * (row.export_rate || 0);
      row.cost = cost(m);
      row.grid_only_cost = row.home * row.import_rate;
      row.saving = row.grid_only_cost - row.cost;
      // With negative prices, using less can cost more, so the range is the spread of the three runs.
      const costs = [cost(low[i]), row.cost, cost(high[i])];
      row.cost_low = Math.min(...costs);
      row.cost_high = Math.max(...costs);
    }
  });

  // Cheapest and greenest 2-hour windows in the next 24 hours (nDay slots).
  const window = (key, len = 7200 / slotS) => {
    let best = null;
    const day = slots.slice(0, nDay);
    for (let i = 0; i + len <= day.length; i++) {
      const vals = day.slice(i, i + len).map((s) => s[key]);
      if (vals.some((v) => v == null)) continue;
      const avg = vals.reduce((a, b) => a + b, 0) / len;
      if (!best || avg < best.avg) best = { start: day[i].slot_start, end: day[i].slot_start + len * slotS, avg };
    }
    return best;
  };
  const sum = (k, n = slots.length) => slots.slice(0, n).reduce((s, r) => s + (r[k] ?? 0), 0);
  // A range total exists only where the half-hours have one; 0 would read as a real value.
  const sumRange = (k) => (slots.slice(0, nDay).some((s) => s[k] != null) ? sum(k, nDay) : null);
  const pricesPublishedUntil = slots.filter((s) => s.import_rate != null).pop()?.slot_start + slotS || null;

  // Plain-language method with the learned parameters, for the page and the method doc.
  const pct = (v) => `${Math.round(v)}%`;
  const winText = charging.windows.map((w) => `${w.from}–${w.to} up to about ${w.targetSocPct}%`).join(' and ');
  const noSolar = [anglesKnown ? 'no current Quartz forecast' : 'Quartz needs the panel tilt and direction, which are unknown',
    !sunlight.ok ? `the sunlight fit cannot be made (${sunlight.reason})` : !sunFc.length ? 'there is no sunlight forecast from Open-Meteo' : null].filter(Boolean).join('; ');
  const model = {
    version: 3, historyDays: HISTORY_DAYS,
    solar: {
      path: solarPath,
      method: solarPath === 'quartz'
        ? `Latest Quartz forecast for the panels${quartzCal.applied ? `, multiplied by ${quartzCal.factor.toFixed(2)} to match how this home's output compared with Quartz over the last ${HISTORY_DAYS} days` : `, used as issued (not calibrated: ${quartzCal.reason})`}.`
        : solarPath === 'sunlight'
          ? `Open-Meteo's forecast of sunlight on flat ground, multiplied for each hour of the day by how much solar this home made per unit of that sunlight over the last ${HISTORY_DAYS} days (R² ${sunlight.r2.toFixed(2)}).`
          : `No solar forecast: ${noSolar}.`,
      issuedAt: solarIssued,
      quartz: {
        anglesKnown, used: solarPath === 'quartz',
        calibration: {
          applied: quartzCal.applied, factor: round(quartzCal.factor, 3), observedRatio: round(quartzCal.ratio, 3),
          days: quartzCal.days, forecastKwh: round(quartzCal.forecastKwh, 1), actualKwh: round(quartzCal.actualKwh, 1), reason: quartzCal.reason,
        },
      },
      sunlight: {
        used: solarPath === 'sunlight', days: sunlight.days, halfHours: sunlight.halfHours, r2: round(sunlight.r2, 3), maeKwhPerHalfHour: round(sunlight.maeKwh, 3),
        // kWh of solar per kWh/m2 of horizontal sunlight, by local hour of day.
        perHour: [...sunlight.ratios].sort((a, b) => a[0] - b[0]).map(([h, r]) => ({ hour: slotLabel(h * (3600 / slotS), slotS), ratio: round(r, 2) })),
        reason: sunlight.reason,
      },
      range: solarRange ? { basis: solarRange.basis, days: solarRange.days, lowFactor: round(solarRange.low, 3), highFactor: round(solarRange.high, 3) } : null,
      rangeReason: solarPath ? solarRangeReason : 'no solar forecast',
    },
    houseUse: {
      method: `Median house use for each half-hour of the day over the last ${HISTORY_DAYS} days, from days of the same kind (weekday or weekend)${temperature.applied ? ', scaled for each day\'s forecast temperature' : ''}, plus planned EV charging.`,
      dayType: { weekdayDays: profile.weekdayDays, weekendDays: profile.weekendDays, weekdaysUse: profile.weekdaysUse, weekendsUse: profile.weekendsUse, minDays: MIN_DAYS },
      temperature: {
        applied: temperature.applied, days: temperature.days, baseC: temperature.baseC, basesSearchedC: [HDD_BASES[0], HDD_BASES[HDD_BASES.length - 1]],
        interceptKwh: round(temperature.intercept, 2), slopeKwhPerDegreeDay: round(temperature.slope, 3), r2: round(temperature.r2, 3),
        typicalKwh: round(temperature.typicalKwh, 1), reason: temperature.reason, forecastDays: [...fcDays.values()],
      },
    },
    battery: {
      method: !cap ? 'No battery.'
        : !battery.usable ? `Left out (${battery.reason}), so the grid covers every shortfall.`
          : `Starts at the latest charge level (${pct(battery.startSocPct)}), stores spare solar and covers shortfalls within the charge levels (${pct(battery.minSocPct)}–${pct(battery.maxSocPct)}) and half-hour limits (${battery.maxChargeKwh.toFixed(2)} kWh in, ${battery.maxDischargeKwh.toFixed(2)} kWh out) this battery has shown, ${battery.efficiency != null ? `with its measured round-trip efficiency of ${pct(battery.efficiency * 100)}` : 'without losses (efficiency: not measured)'}${charging.windows.length
            ? `, and charges from the grid ${winText} without discharging in that window, as on most of the last ${HISTORY_DAYS} days.`
            : `; no grid charging, because ${charging.reason}.`}${hold.windows.length
            ? ` It also holds its charge ${hold.windows.map((w) => `${w.from}–${w.to}`).join(' and ')}, when on most days the house used the grid while the battery stayed idle.`
            : ''}`,
      hold: { windows: hold.windows, thresholdKwh: hold.thresholdKwh ?? perSlot(0.05, slotS), minShare: hold.minShare ?? 0.5 },
      capacityKwh: battery.capacityKwh, usable: battery.usable, reason: battery.reason,
      startSocPct: round(battery.startSocPct, 0), startAt: battery.startAt ?? null,
      minSocPct: battery.minSocPct ?? null, maxSocPct: battery.maxSocPct ?? null,
      maxChargeKwhPerHalfHour: round(battery.maxChargeKwh, 2), maxDischargeKwhPerHalfHour: round(battery.maxDischargeKwh, 2),
      efficiency: battery.efficiency != null ? round(battery.efficiency, 3) : 'not measured', efficiencyReason: battery.efficiencyReason,
      efficiencyMeasuredOver: battery.measuredOver ? Object.fromEntries(Object.entries(battery.measuredOver).map(([k, v]) => [k, round(v, 1)])) : null,
      gridCharge: { days: charging.days, thresholdKwh: charging.thresholdKwh, minShare: charging.minShare, windows: charging.windows, reason: charging.reason },
    },
    prices: {
      method: 'Published import and export rates for the home\'s tariff agreements, with VAT; half-hours beyond the published prices have no cost.',
      publishedUntil: pricesPublishedUntil,
    },
    carbon: {
      method: site.carbon_region != null ? `Regional grid carbon intensity forecast from the Carbon Intensity API (region ${site.carbon_region}).` : 'No carbon forecast: the home has no grid region yet.',
      region: site.carbon_region ?? null,
    },
    ranges: {
      method: `Low and high cases take the 10th and 90th percentile of house use at each half-hour${solarRange ? ` and of the solar ${solarRange.basis}` : `; solar has no range (${solarPath ? solarRangeReason : 'no solar forecast'})`}, each run through the same battery rule; 24-hour totals add the half-hour bounds, so they are wider than a typical day's spread.`,
    },
    // Fixed choices that are not measurements, for the method doc.
    choices: [
      `History: the last ${HISTORY_DAYS} days of half-hours; whole days are days with every half-hour built.`,
      `Ranges: 10th and 90th percentiles; a day type, a solar range or the sunlight fit needs ${MIN_DAYS} days.`,
      `Temperature: applied with at least 7 whole days, use rising in the cold and R² of at least 0.3; base searched from ${HDD_BASES[0]} to ${HDD_BASES[HDD_BASES.length - 1]} °C in 0.5 °C steps.`,
      `Quartz calibration: needs 2 days and 2 kWh of forecast to compare, and actual ÷ Quartz between ${QUARTZ_RATIO[0]} and ${QUARTZ_RATIO[1]}; outside that Quartz is not used.`,
      'Grid charging: a half-hour counts when the battery took over 0.05 kWh from the grid on at least half of the days.',
      'Accuracy: forecasts issued at least 12 hours ahead, over the last 7 days; shown once a whole day has been scored.',
      'Cheapest and greenest windows: 2 hours within the next 24.',
    ],
  };

  return {
    from, to, solarIssuedAt: solarIssued, baselineDays: HISTORY_DAYS, pricesPublishedUntil,
    next24h: {
      solar: sum('solar', nDay), home: sum('home', nDay), import: sum('grid_import', nDay), export: sum('grid_export', nDay),
      // Cost and saving cover only the slots whose prices are already published.
      cost: sum('cost', nDay), saving: sum('saving', nDay), gridOnlyCost: sum('grid_only_cost', nDay),
      pricedSlots: slots.slice(0, nDay).filter((s) => s.cost != null).length,
      gridToBattery: sum('grid_to_battery', nDay),
      solar_low: sumRange('solar_low'), solar_high: sumRange('solar_high'), home_low: sumRange('home_low'), home_high: sumRange('home_high'),
      import_low: sumRange('grid_import_low'), import_high: sumRange('grid_import_high'), cost_low: sumRange('cost_low'), cost_high: sumRange('cost_high'),
    },
    cheapestWindow: window('import_rate'), greenestWindow: window('carbon_intensity'),
    accuracy: scoreAccuracy(siteId, tz, now, slotS),
    model,
    slots,
  };
}
