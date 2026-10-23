// Tariff expansion: from "when each register applies" (register_window rows) and "what each
// register costs" to concrete rate intervals [validFrom, validTo) in UTC epoch seconds, and
// fixed charges (standing charge, subscription) spread over slots. Pure: no database, no
// network, no clock. Callers read the rows and store or use the result.
//
// Windows are wall-clock times in the tariff's zone (clock 'local') or in UTC (clock 'utc'):
//   start_min 0–1439 and end_min 1–1440; end <= start wraps past midnight into the next day.
//   weekdays is a bit mask, bit 0 = Monday … bit 6 = Sunday, read on the day the window STARTS
//   (a Friday-only 23:00–07:00 window runs Friday night into Saturday morning).
//   calendar + day_type restrict a window to days of one type (Tempo colour, bank holiday).
//
// DST: every switch time maps to ONE instant (switchInstant). A time the clocks skip switches
// at the first instant after the gap; a time shown twice when the clocks go back switches the
// first time it is shown, and does not switch back when the hour repeats. Intervals are real
// lengths: off-peak 01:00–07:00 is 5 hours on the spring-forward day and 7 on the autumn one.
//
// Where windows overlap:
//   1. A meter's own windows (device_id) replace the tariff's (tariff_id) for the same calendar,
//      for as long as they are valid. French HP/HC: Enedis gives each meter its own 8 off-peak
//      hours, in 1–3 ranges, which only the bill states; the tariff's 23:00–07:00 is a reference.
//   2. Calendar windows beat plain ones (an all-day bank-holiday off-peak beats the weekday peak).
//   3. Two windows of equal rank with different registers at one instant are a data error and
//      throw; so does time no window covers when there is no defaultRegister. Loud, because a
//      silently wrong register is a wrong price nobody notices.
//
// Calendars (Tempo): a calendar day starts at dayStartMin (Tempo 06:00, so a colour runs 06:00
// to 06:00). A window belongs to the calendar day in force at its start, so the off-peak
// 22:00–06:00 takes the colour of the day that started at 06:00 that morning. A day of unknown
// type (a colour not yet published) is expanded with estimate.dayType's windows, priced with
// estimate.prices where given (a cautious default), and every interval it gives is estimated.
import { localToUtc, localToUtcAll, dayBounds, addDays, daysBetween, zonedParts, localDate, isoUtc } from './time.js';

export const ALL_WEEKDAYS = 127;   // Monday … Sunday
const PERIODS = ['day', 'month', 'year'];

// Weekday of a YYYY-MM-DD label, 0 = Monday … 6 = Sunday (a date label has no zone).
export function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// A wall-clock switch time (minute 0–2880 from the start of dateStr) as one UTC instant; see
// the DST note above. Midnight follows dayBounds, so intervals line up with the site's slots.
export function switchInstant(tz, dateStr, minute, clock = 'local') {
  const date = minute >= 1440 ? addDays(dateStr, Math.floor(minute / 1440)) : dateStr;
  const min = minute % 1440;
  const [y, m, d] = date.split('-').map(Number);
  if (clock === 'utc') return Date.UTC(y, m - 1, d) / 1000 + min * 60;
  if (min === 0) return dayBounds(tz, date)[0];
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  const all = localToUtcAll(tz, y, m, d, hh, mm);
  return all.length ? all[0] : localToUtc(tz, y, m, d, hh, mm);
}

// Off-peak hours as a bill or contract prints them ("HC 02H00-07H00 / 13H00-16H00",
// "de 22h30 à 6h30", "23:00-07:00") to [{ start_min, end_min }]. An end of 00:00 or 24:00 is
// midnight (1440). Keep the text itself as register_window.source_text.
export function parseRanges(text) {
  const re = /(\d{1,2})\s*[h:]\s*(\d{2})?\s*(?:-|–|à|a|to)\s*(\d{1,2})\s*[h:]\s*(\d{2})?/gi;
  const out = [];
  for (const m of String(text ?? '').matchAll(re)) {
    const [h1, m1, h2, m2] = [m[1], m[2] ?? '0', m[3], m[4] ?? '0'].map(Number);
    if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || (h2 === 24 && m2 > 0)) throw new Error(`not a time range: "${m[0]}"`);
    const end = h2 * 60 + m2;
    out.push({ start_min: h1 * 60 + m1, end_min: end === 0 ? 1440 : end });
  }
  return out;
}

// ───────────── Windows to intervals ─────────────

const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined) return o[k]; return undefined; };

// register_window rows (snake_case, as stored) or the same fields in camelCase.
function normWindow(w) {
  const out = {
    register: w.register,
    calendar: pick(w, 'calendar') ?? null,
    dayType: pick(w, 'day_type', 'dayType') ?? null,
    weekdays: Number(pick(w, 'weekdays') ?? ALL_WEEKDAYS),
    startMin: Number(pick(w, 'start_min', 'startMin')),
    endMin: Number(pick(w, 'end_min', 'endMin')),
    clock: pick(w, 'clock') ?? 'local',
    validFrom: pick(w, 'valid_from', 'validFrom') ?? -Infinity,
    validTo: pick(w, 'valid_to', 'validTo') ?? Infinity,
    deviceId: pick(w, 'device_id', 'deviceId') ?? null,
    superseded: pick(w, 'superseded_at', 'supersededAt') != null,
  };
  const { startMin: s, endMin: e } = out;
  if (!out.register) throw new Error('register window without a register');
  if (!(Number.isInteger(s) && s >= 0 && s <= 1439 && Number.isInteger(e) && e >= 1 && e <= 1440)) {
    throw new Error(`register window ${out.register}: start_min must be 0-1439 and end_min 1-1440`);
  }
  if (out.clock !== 'local' && out.clock !== 'utc') throw new Error(`register window ${out.register}: clock must be local or utc`);
  return out;
}

// { code, dayStartMin, days: { 'YYYY-MM-DD': type } | Map, defaultDayType } (or an array of them).
// defaultDayType makes an absent day known (a bank-holiday calendar: absent = ordinary day);
// without it an absent day is unknown (a Tempo colour not yet published).
function normCalendars(calendar) {
  const map = new Map();
  for (const c of [calendar].flat().filter(Boolean)) {
    const days = c.days instanceof Map ? c.days : new Map(Object.entries(c.days || {}));
    map.set(c.code, {
      dayStartMin: Number(c.dayStartMin ?? c.day_start_min ?? 0),
      typeOf: (d) => days.get(d) ?? c.defaultDayType ?? null,
    });
  }
  return map;
}

// { register: price } or rate rows [{ register, price, validFrom?, validTo? }]; rows may change
// price mid-range and the intervals are cut there. null: windows only, every price null.
function priceLookup(registerPrices) {
  if (registerPrices == null) return { cuts: [], price: () => null };
  if (Array.isArray(registerPrices)) {
    const rows = registerPrices.map((r) => ({
      register: r.register, price: Number(r.price),
      from: pick(r, 'valid_from', 'validFrom') ?? -Infinity, to: pick(r, 'valid_to', 'validTo') ?? Infinity,
    }));
    return {
      cuts: rows.flatMap((r) => [r.from, r.to]).filter(Number.isFinite),
      price: (reg, t) => {
        let best = null;
        for (const r of rows) if (r.register === reg && r.from <= t && t < r.to && (!best || r.from > best.from)) best = r;
        return best ? best.price : undefined;
      },
    };
  }
  return { cuts: [], price: (reg) => (Object.hasOwn(registerPrices, reg) ? Number(registerPrices[reg]) : undefined) };
}

// [a, b) minus every span in spans, as the pieces left.
function subtract(a, b, spans) {
  let pieces = [[a, b]];
  for (const [s, e] of spans) {
    pieces = pieces.flatMap(([x, y]) => (e <= x || s >= y ? [[x, y]] : [[x, Math.min(y, s)], [Math.max(x, e), y]].filter(([p, q]) => q > p)));
  }
  return pieces;
}

/**
 * Concrete rate intervals for every local day fromDate..toDate (inclusive) in tz.
 * Each local day is tiled exactly: no gaps, no overlaps, nothing crosses local midnight.
 * @returns {{validFrom:number, validTo:number, register:string, price:number|null, estimated:boolean,
 *            localDate:string, dayType:string|null, calendarDay:string|null}[]} sorted by validFrom
 */
export function expandWindows({
  windows, registerPrices = null, tz, fromDate, toDate, calendar = null,
  defaultRegister = null, deviceId = null, estimate = null,
}) {
  if (!tz) throw new Error('expandWindows: tz is required');
  if (fromDate > toDate) return [];
  const all = (windows || []).map(normWindow)
    .filter((w) => !w.superseded && (deviceId == null || w.deviceId == null || w.deviceId === deviceId));
  const calendars = normCalendars(calendar);
  const prices = priceLookup(registerPrices);
  const scope = (w) => w.calendar ?? '';
  const meterSpans = new Map();   // calendar -> validity spans of the meter's own windows
  for (const w of all) {
    if (w.deviceId == null) continue;
    if (!meterSpans.has(scope(w))) meterSpans.set(scope(w), []);
    meterSpans.get(scope(w)).push([w.validFrom, w.validTo]);
  }

  const dates = daysBetween(fromDate, toDate);
  const edges = [...dates.map((d) => switchInstant(tz, d, 0)), switchInstant(tz, addDays(toDate, 1), 0)];
  const r0 = edges[0];
  const r1 = edges[edges.length - 1];

  // 1. Every window occurrence that can touch the range, as a UTC span. A day either side is
  //    included: yesterday's night window runs into the first day, and a UTC-clock window's
  //    date can sit a day off the local one.
  const occ = [];
  for (const d of daysBetween(addDays(fromDate, -1), addDays(toDate, 1))) {
    const wd = weekdayIndex(d);
    for (const w of all) {
      if (!((w.weekdays >> wd) & 1)) continue;
      const a = Math.max(switchInstant(tz, d, w.startMin, w.clock), w.validFrom, r0);
      const b = Math.min(switchInstant(tz, d, w.endMin <= w.startMin ? w.endMin + 1440 : w.endMin, w.clock), w.validTo, r1);
      if (b <= a) continue;
      let dayType = null; let calendarDay = null; let estimated = false;
      if (w.calendar) {
        const cal = calendars.get(w.calendar);
        if (!cal) throw new Error(`register window ${w.register} needs calendar "${w.calendar}", which was not given`);
        calendarDay = w.startMin >= cal.dayStartMin ? d : addDays(d, -1);
        const known = cal.typeOf(calendarDay);
        if (known == null) {
          if (!estimate?.dayType) throw new Error(`${w.calendar}: the day type of ${calendarDay} is unknown and no estimate was given`);
          if (w.dayType !== estimate.dayType) continue;
          estimated = true;
        } else if (w.dayType != null && w.dayType !== known) continue;
        dayType = known ?? estimate.dayType;
      }
      const pieces = w.deviceId == null && meterSpans.has(scope(w)) ? subtract(a, b, meterSpans.get(scope(w))) : [[a, b]];
      for (const [pa, pb] of pieces) occ.push({ a: pa, b: pb, register: w.register, rank: w.calendar ? 1 : 0, dayType, calendarDay, estimated });
    }
  }

  // 2. Cut the range at every boundary (windows, local midnights, price changes), then give each
  //    piece the register of the highest-ranked occurrence covering it.
  const cuts = [...new Set([...edges, ...occ.flatMap((o) => [o.a, o.b]), ...prices.cuts.filter((t) => t > r0 && t < r1)])]
    .sort((x, y) => x - y);
  occ.sort((x, y) => x.a - y.a);
  const out = [];
  let active = [];
  let next = 0;
  let day = 0;
  for (let k = 0; k < cuts.length - 1; k++) {
    const p = cuts[k];
    const q = cuts[k + 1];
    while (day < dates.length - 1 && p >= edges[day + 1]) day++;
    while (next < occ.length && occ[next].a <= p) active.push(occ[next++]);
    active = active.filter((o) => o.b > p);
    let hit;
    if (active.length) {
      const top = Math.max(...active.map((o) => o.rank));
      const best = active.filter((o) => o.rank === top);
      const regs = [...new Set(best.map((o) => o.register))];
      if (regs.length > 1) throw new Error(`register windows ${regs.join(' and ')} overlap at ${isoUtc(p)} (local day ${dates[day]})`);
      hit = best.find((o) => !o.estimated) ?? best[0];
    } else if (defaultRegister) {
      hit = { register: defaultRegister, dayType: null, calendarDay: null, estimated: false };
    } else {
      throw new Error(`no register window covers ${isoUtc(p)} (local day ${dates[day]}) and no defaultRegister was given`);
    }
    const cautious = hit.estimated && estimate?.prices && Object.hasOwn(estimate.prices, hit.register);
    const price = cautious ? Number(estimate.prices[hit.register]) : prices.price(hit.register, p);
    if (price === undefined) throw new Error(`no price for register "${hit.register}" at ${isoUtc(p)}`);
    const row = {
      validFrom: p, validTo: q, register: hit.register, price, estimated: hit.estimated,
      localDate: dates[day], dayType: hit.dayType, calendarDay: hit.calendarDay,
    };
    const last = out[out.length - 1];
    const same = last && last.validTo === p && ['localDate', 'register', 'price', 'estimated', 'dayType', 'calendarDay'].every((f) => last[f] === row[f]);
    if (same) last.validTo = q;
    else out.push(row);
  }
  return out;
}

// ───────────── Fixed charges ─────────────

// [start, end) of the local day, month or year holding ts, in UTC seconds: real lengths
// (23/24/25-hour days, 28–31-day months with a clock change, 365/366-day years).
export function periodBounds(tz, period, ts) {
  const pad = (n) => String(n).padStart(2, '0');
  const { y, m } = zonedParts(tz, ts);
  if (period === 'day') return dayBounds(tz, localDate(tz, ts));
  if (period === 'month') {
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    return [dayBounds(tz, `${y}-${pad(m)}-01`)[0], dayBounds(tz, next)[0]];
  }
  if (period === 'year') return [dayBounds(tz, `${y}-01-01`)[0], dayBounds(tz, `${y + 1}-01-01`)[0]];
  throw new Error(`charge period must be one of ${PERIODS.join(', ')}, not "${period}"`);
}

// Share (integer micro-minor units) of a period's amount charged from the period start to t,
// rounded half away from zero. BigInt: amount x seconds overflows 2^53 for a year's charge.
function cumMicro(totalMicro, p0, p1, t) {
  const len = BigInt(p1 - p0);
  const el = BigInt(Math.min(Math.max(t - p0, 0), p1 - p0));
  const neg = totalMicro < 0n;
  const v = ((neg ? -totalMicro : totalMicro) * el * 2n + len) / (2n * len);
  return neg ? -v : v;
}

/**
 * A fixed charge of amountMinor per local `period` (day | month | year), charged on [fromUtc, toUtc),
 * in integer micro-minor units (1e-6 of a penny/cent). Pro-rated by real seconds over the real
 * length of each period it touches. Shares are differences of one rounded running total, so the
 * slices of any period add up to exactly amountMinor x 1e6, whatever the day or month length.
 */
export function fixedChargeMicro(amountMinor, period, fromUtc, toUtc, tz) {
  if (!PERIODS.includes(period)) throw new Error(`charge period must be one of ${PERIODS.join(', ')}, not "${period}"`);
  const total = BigInt(Math.round(Number(amountMinor) * 1e6));
  let sum = 0n;
  for (let t = fromUtc; t < toUtc;) {
    const [p0, p1] = periodBounds(tz, period, t);
    const end = Math.min(toUtc, p1);
    sum += cumMicro(total, p0, p1, end) - cumMicro(total, p0, p1, t);
    t = end;
  }
  return Number(sum);
}

// The same for one slot, in minor units (6 decimal places): a monthly subscription of 1523 cents
// costs 1523 x 1800 / (745 x 3600) per half-hour in October 2026 in Paris (a 745-hour month).
export function fixedChargePerSlot(amountMinor, period, slotStartUtc, slotS, tz) {
  return fixedChargeMicro(amountMinor, period, slotStartUtc, slotStartUtc + slotS, tz) / 1e6;
}
