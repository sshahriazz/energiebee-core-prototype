// What one point looks like over one slot (plan 3.1): the rule follows the point's class. PURE: samples in, one record out; the builder
// (point-slots.js) reads the facts and writes the rows.
//
//   measurement  an instant value held until the next sample, or for `holdS` at most: mean (time-weighted over the covered time), min, max, last
//   state        the same, as the share of the covered time in each value, and the value held longest
//   setpoint     a value stays in force until it changes: the same with no limit on the hold
//   total        an amount over a period (a meter half-hour, a derived counter energy): the part of each period inside the slot, added up;
//                a counter's readings: the change between the slot's two ends, none across a reset
//   event        periods in which something happened: how many touch the slot and the share of the slot they cover
//
// Every record has `coverage`: the share of the slot (0 to 1) the data speaks for. A value that is not covered is null, never a guess.
const round = (x) => (x == null ? null : Math.round(x * 1e9) / 1e9);

// The segments [from, to) over which each sample holds, clipped to the slot.
function segments(samples, s, e, holdS) {
  const list = samples.filter((x) => x.value != null).sort((a, b) => a.ts - b.ts);
  const out = [];
  const all = samples.slice().sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < all.length; i++) {
    const x = all[i];
    if (x.value == null) continue;
    const next = all[i + 1]?.ts ?? Infinity;
    const to = Math.min(next, x.ts + holdS, e);
    const from = Math.max(x.ts, s);
    if (to > from) out.push({ from, to, value: x.value });
  }
  return list.length ? out : [];
}

/** measurement, state and setpoint: samples [{ ts, value }] around the slot (those up to holdS before it matter). */
export function aggregateInstants(cls, samples, s, e, { holdS = 300 } = {}) {
  const hold = cls === 'setpoint' ? Infinity : holdS;
  const seg = segments(samples, s, e, hold);
  const covered = seg.reduce((t, g) => t + (g.to - g.from), 0);
  const dur = e - s;
  const base = { mean: null, min: null, max: null, last: null, delta: null, state_shares: null, state: null, coverage: round(Math.min(1, covered / dur)) };
  if (!covered) return base;
  const last = seg.reduce((a, g) => (g.from >= a.from ? g : a), seg[0]).value;
  if (cls === 'state') {
    const shares = new Map();
    for (const g of seg) shares.set(g.value, (shares.get(g.value) ?? 0) + (g.to - g.from));
    const entries = [...shares].map(([v, sec]) => [v, round(sec / covered)]);
    const top = [...shares].sort((a, b) => b[1] - a[1] || (a[0] === last ? -1 : 0))[0][0];
    return { ...base, last, state: top, state_shares: Object.fromEntries(entries.map(([v, f]) => [String(v), f])) };
  }
  return {
    ...base, last,
    mean: round(seg.reduce((t, g) => t + g.value * (g.to - g.from), 0) / covered),
    min: Math.min(...seg.map((g) => g.value)), max: Math.max(...seg.map((g) => g.value)),
  };
}

/** total from periods [{ start, end, value }]: the part of each period inside the slot. A period that overlaps another is counted once as given: the caller supplies one version of each. */
export function aggregatePeriods(periods, s, e) {
  const dur = e - s;
  let delta = 0; let covered = 0;
  for (const p of periods) {
    if (p.value == null || p.end <= p.start) continue;
    const lo = Math.max(p.start, s); const hi = Math.min(p.end, e);
    if (hi <= lo) continue;
    delta += p.value * ((hi - lo) / (p.end - p.start));
    covered += hi - lo;
  }
  const coverage = Math.min(1, covered / dur);
  return { mean: null, min: null, max: null, last: null, delta: covered ? round(delta) : null, state_shares: null, state: null, coverage: round(coverage) };
}

/**
 * total from a counter's readings [{ ts, value }]: the counter's value at each end of the slot, taken on the line between the readings
 * around it, and the change between them. Readings that fall (a reset or a wrap) between the two ends make the change unknown here: the
 * derived periods (core/counters.js) are what carries a counter through a reset, and they come in as periods.
 */
export function aggregateCounter(readings, s, e) {
  const r = readings.filter((x) => x.value != null).sort((a, b) => a.ts - b.ts);
  const at = (t) => {
    const prev = [...r].reverse().find((x) => x.ts <= t); const next = r.find((x) => x.ts >= t);
    if (!prev || !next) return null;
    if (prev.ts === next.ts) return prev.value;
    return prev.value + ((next.value - prev.value) * (t - prev.ts)) / (next.ts - prev.ts);
  };
  const a = at(s); const b = at(e);
  const none = { mean: null, min: null, max: null, last: null, delta: null, state_shares: null, state: null, coverage: 0 };
  if (a == null || b == null) return none;
  const inside = r.filter((x) => x.ts >= s && x.ts <= e);
  const seq = [r.filter((x) => x.ts <= s).pop(), ...inside, r.find((x) => x.ts >= e)].filter(Boolean);
  for (let i = 1; i < seq.length; i++) if (seq[i].value < seq[i - 1].value) return none;
  return { ...none, delta: round(b - a), coverage: 1, last: round(b) };
}

/** event: periods [{ start, end }]: how many touch the slot, and the share of the slot they cover. */
export function aggregateEvents(periods, s, e) {
  const dur = e - s;
  const hits = periods.filter((p) => p.end > s && p.start < e);
  const sorted = hits.map((p) => [Math.max(p.start, s), Math.min(p.end, e)]).sort((a, b) => a[0] - b[0]);
  let covered = 0; let end = -Infinity;
  for (const [lo, hi] of sorted) { if (hi > Math.max(lo, end)) covered += hi - Math.max(lo, end); end = Math.max(end, hi); }
  return { mean: null, min: null, max: null, last: null, delta: hits.length, state_shares: { active: round(covered / dur) }, state: hits.length ? 'active' : null, coverage: 1 };
}

/** Every record of a slot is built the same way whatever the class: pick the aggregator by class and the shape of the data. */
export function aggregateSlot(cls, data, s, e, opts = {}) {
  if (cls === 'event') return aggregateEvents(data.periods ?? [], s, e);
  if (cls === 'total') return data.periods?.length || !data.readings?.length ? aggregatePeriods(data.periods ?? [], s, e) : aggregateCounter(data.readings, s, e);
  return aggregateInstants(cls, data.samples ?? [], s, e, opts);
}
