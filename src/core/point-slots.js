// A point's timeline: one row per slot of the home's grid (plan 3.1, docs/build/timelines.md). The row says what the point did in the
// slot by its class (src/core/slot-agg.js), how much of the slot the data speaks for (coverage), and which feed it came from. Where
// several sources feed a point, each slot takes the source that covers it best; a tie goes to the source the home ranks first (the
// priority of its bindings), then to the source's name. Rows are serving data: rebuilt from the facts, never edited, and a rebuild of a
// range gives the same rows as a build of a day.
import { db, tx } from '../db/db.js';
import { readReadings, readIntervals } from './facts.js';
import { holdSOf } from './inputs.js';
import { aggregateSlot } from './slot-agg.js';
import { dayBounds, slotsOfDay, slotLength, nowSec, daysBetween } from './time.js';

export const POINT_SLOT_VERSION = 1;
const FIELDS = ['mean', 'min', 'max', 'last', 'delta', 'state_shares', 'state', 'coverage'];

// The sources of a home ranked by the priority of their bindings (lower first); a source with none ranks last.
async function sourceRank(homeId) {
  if (homeId == null) return new Map();
  const rows = await db.prepare(`SELECT so.code, MIN(b.priority) AS p FROM binding b JOIN source so ON so.id = b.source_id WHERE b.site_id = ? AND b.superseded_at IS NULL GROUP BY so.code`).all(homeId);
  return new Map(rows.map((r) => [r.code, Number(r.p)]));
}

/**
 * Build the slots of one point for the local days fromDate..toDate (inclusive): the old rows of those days are replaced by the new, in one
 * transaction. Returns { slots (rows written), days }. A point with no series, or a day with no data, writes nothing for it.
 */
export async function buildPointSlots(pointId, fromDate, toDate, { builtAt = nowSec() } = {}) {
  const p = await db.prepare(`SELECT p.id, p.home_id, p.class, m.time_role, m.aggregation FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.id = ?`).get(pointId);
  if (!p) throw Object.assign(new Error('no such point'), { status: 404 });
  const home = p.home_id == null ? null : await db.prepare('SELECT timezone, slot_s FROM site WHERE id = ?').get(p.home_id);
  const tz = home?.timezone ?? 'UTC';
  const slotS = home ? slotLength(home) : 1800;
  const series = (await db.prepare(`SELECT s.id, so.code AS source, so.traits FROM series s JOIN source so ON so.id = s.source_id WHERE (s.point_id = ? OR s.point_id IN (SELECT m.id FROM point m WHERE m.merged_into = ?)) ORDER BY s.id`).all(pointId, pointId))
    .filter((s) => !JSON.parse(s.traits || '{}').forecastOnly);
  const rank = await sourceRank(p.home_id);
  const [winFrom] = dayBounds(tz, fromDate); const winTo = dayBounds(tz, toDate)[1];
  const rows = [];
  if (series.length) {
    const instant = p.time_role === 'instant';
    const facts = new Map();
    for (const s of series) {
      const hold = await holdSOf(s.source);
      if (instant) facts.set(s.id, { hold, rows: await readReadings([s.id], winFrom - Math.max(hold, 3600), winTo + 3600) });
      else facts.set(s.id, { hold, rows: await readIntervals([s.id], winFrom - 3600, winTo + 3600) });
    }
    for (const date of daysBetween(fromDate, toDate)) {
      for (const start of slotsOfDay(tz, date, slotS)) {
        const end = start + slotS;
        let best = null;
        for (const s of series) {
          const { hold, rows: fr } = facts.get(s.id);
          const data = instant ? { samples: fr.map((r) => ({ ts: r.ts, value: r.value })), readings: p.class === 'total' ? fr.map((r) => ({ ts: r.ts, value: r.value })) : undefined }
            : { periods: fr.map((r) => ({ start: r.start_ts, end: r.end_ts, value: r.value })) };
          const r = aggregateSlot(p.class, data, start, end, { holdS: hold });
          if (!(r.coverage > 0)) continue;
          const key = [-r.coverage, rank.get(s.source) ?? 1e9, s.source];
          if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { key, r, s };
        }
        if (best) rows.push({ slot_start: start, dur_s: slotS, ...best.r, lineage: { series: best.s.id, source: best.s.source, sources: series.length } });
      }
    }
  }
  await tx(async () => {
    await db.prepare('DELETE FROM point_slot WHERE point_id = ? AND slot_start >= ? AND slot_start < ?').run(pointId, winFrom, winTo);
    for (const r of rows) {
      await db.prepare(`INSERT INTO point_slot (point_id, slot_start, dur_s, mean, min, max, last, delta, state_shares, state, coverage, lineage, method_version, built_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?, ?)`).run(pointId, r.slot_start, r.dur_s, r.mean, r.min, r.max, r.last, r.delta,
        r.state_shares == null ? null : JSON.stringify(r.state_shares), r.state == null ? null : String(r.state), r.coverage, JSON.stringify(r.lineage), POINT_SLOT_VERSION, builtAt);
    }
  });
  return { slots: rows.length, days: daysBetween(fromDate, toDate).length };
}

/** Every current point of a home, for the days fromDate..toDate. Returns { points, slots }. */
export async function buildHomePointSlots(siteId, fromDate, toDate, opts = {}) {
  const points = await db.prepare('SELECT id FROM point WHERE home_id = ? AND superseded_at IS NULL ORDER BY id').all(siteId);
  let slots = 0;
  for (const { id } of points) slots += (await buildPointSlots(Number(id), fromDate, toDate, opts)).slots;
  return { points: points.length, slots };
}

/** The slots of a point in [from, to): rows as stored. */
export async function readPointSlots(pointId, from, to) {
  return (await db.prepare(`SELECT slot_start, dur_s, mean, min, max, last, delta, state_shares, state, coverage, lineage, method_version
    FROM point_slot WHERE point_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start`).all(pointId, from, to))
    .map((r) => ({ ...r, state_shares: typeof r.state_shares === 'string' ? JSON.parse(r.state_shares) : r.state_shares, lineage: typeof r.lineage === 'string' ? JSON.parse(r.lineage) : r.lineage }));
}
export { FIELDS as POINT_SLOT_FIELDS };
