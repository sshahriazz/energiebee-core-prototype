// Time helpers. Everything is stored as UTC epoch seconds; local time is only
// used to read provider clocks and to decide which local day a slot belongs to.

export const SLOT = 1800;
export const nowSec = () => Math.floor(Date.now() / 1000);
export const floorTo = (ts, step) => ts - (((ts % step) + step) % step);

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

export function slotsOfDay(tz, dateStr) {
  const [a, b] = dayBounds(tz, dateStr);
  const out = [];
  for (let t = a; t < b; t += SLOT) out.push(t);
  return out;
}

export const isoUtc = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
export const parseIso = (s) => Math.floor(Date.parse(s) / 1000);
