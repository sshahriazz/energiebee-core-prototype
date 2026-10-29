// Counters: a cumulative meter reading (a smart plug's energy total, a heat pump's electricity counter, Predbat style
// *_today sensors) turned into the energy of each period by difference. Provider-agnostic: how a counter behaves is
// data on its channel (kind counter, counter_wrap, counter_reset_below, max_gap_s), never a vendor rule.
//
// What the raw samples can mean between two consecutive readings (t0, v0) and (t1, v1):
//   increase   v1 >= v0: the period [t0, t1) used v1 - v0.
//   wrap       v1 < v0 and v0 was within 10 % of counter_wrap: the meter rolled over; energy = wrap - v0 + v1.
//   reset      v1 < v0 and v1 <= counter_reset_below (default a tenth of v0): a daily counter at local midnight or a restart.
//              The counter restarted at some unknown moment inside the period, so the period carries only what the counter
//              shows after the reset (v1), flagged PARTIAL: the energy between the last sample and the reset is unknown, not invented.
//   backwards  any other drop: not a reset, not a wrap. The sample is rejected at ingest (counter_backwards) and never stored.
// A period longer than max_gap_s keeps the counter's exact total, spread over the gap by the slot builder's overlap rule, and
// is flagged ESTIMATED: the total is real, its timing is not.
import { db } from '../db/db.js';
import { QUALITY } from './facts.js';

export const WRAP_NEAR = 0.9;
export const RESET_DEFAULT_FRACTION = 0.1;

/** What a step from prev to cur is. ch: { counter_wrap, counter_reset_below } (null = not declared). */
export function classifyStep(prev, cur, ch = {}) {
  if (cur >= prev) return { type: 'increase', energy: cur - prev };
  if (ch.counter_wrap != null && prev >= WRAP_NEAR * ch.counter_wrap) return { type: 'wrap', energy: ch.counter_wrap - prev + cur };
  const resetBelow = ch.counter_reset_below ?? RESET_DEFAULT_FRACTION * prev;
  if (cur <= resetBelow) return { type: 'reset', energy: cur };
  return { type: 'backwards', energy: null };
}

/**
 * The periods between consecutive samples (pure). samples: [{ ts, value }] in any order; the later of two with one ts wins.
 * Returns { periods: [{ start, end, value, quality, type, gap }], skipped } - skipped counts steps that went backwards
 * (cannot happen for samples that passed ingest; kept so a change of rules never throws).
 */
export function deriveCounterPeriods(samples, ch = {}) {
  const byTs = new Map();
  for (const s of samples) if (s.value != null && Number.isFinite(s.value)) byTs.set(s.ts, s);
  const list = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const periods = []; let skipped = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]; const b = list[i];
    const step = classifyStep(a.value, b.value, ch);
    if (step.type === 'backwards') { skipped++; continue; }
    const gap = ch.max_gap_s != null && b.ts - a.ts > ch.max_gap_s;
    periods.push({ start: a.ts, end: b.ts, value: step.energy, type: step.type, gap,
      quality: (step.type === 'reset' ? QUALITY.PARTIAL : QUALITY.MEASURED) | (gap ? QUALITY.ESTIMATED : 0) });
  }
  return { periods, skipped };
}

// The stored (current) samples either side of ts.
export function neighbours(seriesId, ts) {
  const prev = db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND ts < ? AND value IS NOT NULL AND superseded_at IS NULL ORDER BY ts DESC LIMIT 1').get(seriesId, ts) ?? null;
  const next = db.prepare('SELECT ts, value FROM reading WHERE series_id = ? AND ts > ? AND value IS NOT NULL AND superseded_at IS NULL ORDER BY ts LIMIT 1').get(seriesId, ts) ?? null;
  return { prev, next };
}

// A late or corrected sample splits or changes periods already derived: the current derived periods inside [from, to] that
// are not in `keep` (a Set of "start|end") are superseded (kept, never deleted) and the correction is logged.
export function withdrawDerived(siteId, derivedSeriesId, from, to, keep, now = Date.now()) {
  const rows = db.prepare('SELECT start_ts, end_ts FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL AND start_ts >= ? AND end_ts <= ?').all(derivedSeriesId, from, to)
    .filter((r) => !keep.has(`${r.start_ts}|${r.end_ts}`));
  if (!rows.length) return 0;
  const up = db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND superseded_at IS NULL');
  for (const r of rows) up.run(now, derivedSeriesId, r.start_ts, r.end_ts);
  db.prepare('INSERT INTO fact_correction (site_id, corrected_at, series_id, rows, reason) VALUES (?, ?, ?, ?, ?)')
    .run(siteId, Math.floor(now / 1000), derivedSeriesId, rows.length, 'a late or corrected counter sample changed the periods derived from the counter; the old periods are superseded');
  return rows.length;
}
