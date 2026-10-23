// Time helpers. Everything is stored as UTC epoch seconds; local time is only
// used to read provider clocks and to decide which local day a slot belongs to.
//
// Slots: each home has its own slot length, site.slot_s (15, 30 or 60 minutes; 30 by
// default). Slots are anchored to local midnight and step in whole slot lengths of real
// time, so a short (23 h) or long (25 h) day simply has fewer or more of them. Every real
// zone's offset is a multiple of 15 minutes, so slot starts always fall on the 900 s grid.
// The engine's own step stays 5 minutes (the inverter samples).

export const SLOT = 1800;                        // the default slot length, s (GB settlement half-hour)
export const SLOT_LENGTHS = [900, 1800, 3600];   // allowed values of site.slot_s
export const nowSec = () => Math.floor(Date.now() / 1000);
// A recorded_at stamp (ms) that never repeats and never goes back within this process: two
// versioned writes in the same millisecond get different stamps, so a correction made right after
// a row is always recorded later than it, and a key that includes recorded_at (calendar_day:
// calendar, local_date, recorded_at) cannot clash. At most a millisecond ahead per call in a burst.
let lastStampMs = 0;
export function recordedNow() {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return lastStampMs;
}
export const floorTo = (ts, step) => ts - (((ts % step) + step) % step);
// A home's slot length; anything missing or not allowed reads as the default.
export const slotLength = (site) => (SLOT_LENGTHS.includes(Number(site?.slot_s)) ? Number(site.slot_s) : SLOT);
// Nominal slots in a 24-hour day (48 at 30 minutes).
export const slotsPerDay = (slotS = SLOT) => 86400 / slotS;
// The slot's name in plain words, for messages ("half-hour" at the default).
export const slotNoun = (slotS = SLOT) => ({ 900: 'quarter-hour', 1800: 'half-hour', 3600: 'hour' }[slotS] || 'slot');

const partsFmt = new Map();
function fmt(tz) {
  if (!partsFmt.has(tz)) {
    partsFmt.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsFmt.get(tz);
}

export function zonedParts(tz, ts) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

// Offset of a time zone from UTC at an instant, in seconds (e.g. 3600 in summer for London).
export function offsetSeconds(tz, ts) {
  const p = zonedParts(tz, ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) / 1000 - ts;
}

// Wall-clock time in a zone to UTC. A time inside the spring-forward gap maps
// to the instant after the gap; a repeated autumn time maps to the later one.
export function localToUtc(tz, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  let t = guess - offsetSeconds(tz, guess);
  const off2 = offsetSeconds(tz, t);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

// Every UTC instant that shows as this local wall-clock time: one normally, two in the
// hour repeated when clocks go back, none in the hour skipped when they go forward.
export function localToUtcAll(tz, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  const out = new Set();
  for (const probe of [guess - 43200, guess + 43200]) {
    const t = guess - offsetSeconds(tz, probe);
    const p = zonedParts(tz, t);
    if (p.y === y && p.m === m && p.d === d && p.hh === hh && p.mm === mm) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

export function localDate(tz, ts) {
  const p = zonedParts(tz, ts);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// [start, end) of a local calendar day, in UTC seconds: 23, 24 or 25 hours long.
export function dayBounds(tz, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = addDays(dateStr, 1).split('-').map(Number);
  return [localToUtc(tz, y, m, d), localToUtc(tz, next[0], next[1], next[2])];
}

export function daysBetween(fromDate, toDate) {
  const out = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) out.push(d);
  return out;
}

// Slot starts of a local day: from local midnight in steps of slotS (46/48/50 at 30 minutes).
export function slotsOfDay(tz, dateStr, slotS = SLOT) {
  const [a, b] = dayBounds(tz, dateStr);
  const out = [];
  for (let t = a; t < b; t += slotS) out.push(t);
  return out;
}

// Local wall-clock minute of the day (0–1439) at an instant. On the day clocks go back the
// repeated hour repeats its minutes; on the day they go forward the skipped hour never appears.
export function todMinute(tz, ts) {
  const { hh, mm } = zonedParts(tz, ts);
  return hh * 60 + mm;
}

// Slot-of-day index from the local wall-clock time (0 … 86400/slotS − 1), for time-of-day
// profiles. At 30 minutes this is hh*2 + (mm >= 30). DST-safe: it reads the clock, not the
// count of slots since midnight, so 17:00 is the same index on a 23, 24 or 25-hour day.
export function slotOfDay(tz, ts, slotS = SLOT) {
  return Math.floor(todMinute(tz, ts) / (slotS / 60));
}

// "HH:MM" for a slot-of-day index (index 86400/slotS wraps to "00:00").
export function slotLabel(k, slotS = SLOT) {
  const m = (k * slotS) / 60;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Where the slot grid sits against the epoch grid: local midnight is not always on a
// multiple of slotS (e.g. 60-minute slots in a zone at UTC+9:30). 0 for every whole-hour zone.
export function slotPhase(tz, slotS = SLOT, ts = nowSec()) {
  const [a] = dayBounds(tz, localDate(tz, ts));
  return ((a % slotS) + slotS) % slotS;
}

// Start of the slot holding ts, on a grid of slotS shifted by phase (see slotPhase).
export const slotFloor = (ts, slotS = SLOT, phase = 0) => floorTo(ts - phase, slotS) + phase;

// A period [start_ts, end_ts) over the slots it overlaps: fn(slotStart, share, overlapS), where
// share is the part of the period inside that slot (exactly 1 when it lies wholly inside, so a
// value × share is then the value itself).
export function eachSlotOverlap(f, slotS, phase, fn) {
  const len = f.end_ts - f.start_ts;
  for (let s = slotFloor(f.start_ts, slotS, phase); s < f.end_ts; s += slotS) {
    const o = Math.min(f.end_ts, s + slotS) - Math.max(f.start_ts, s);
    fn(s, o === len ? 1 : o / len, o);
  }
}

export const isoUtc = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
export const parseIso = (s) => Math.floor(Date.parse(s) / 1000);
