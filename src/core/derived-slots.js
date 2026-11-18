// Derived points evaluated into the timeline (plan 2.8, docs/build/points.md): for every slot of a home, the definitions of `derived_def` are worked
// out from the slots of the home's own points (src/core/derived.js, pure) and written as the slots of a derived point of the home thing
// (key `derived_<code>`), with a lineage naming what each value was worked out of. A slot where an input is missing has no row: never a guess.
import { db, tx } from '../db/db.js';
import { evaluateSlot } from './derived.js';
import { dayBounds, nowSec } from './time.js';

const SUM = new Set(['sum']);

/** Work out the derived points of a home for the local days fromDate..toDate and replace their rows of those days. Returns { points, slots }. */
export async function buildDerivedSlots(homeId, fromDate, toDate, { builtAt = nowSec() } = {}) {
  const defs = (await db.prepare('SELECT code, label, metric, formula, inputs FROM derived_def ORDER BY code').all()).map((d) => ({ ...d, inputs: typeof d.inputs === 'string' ? JSON.parse(d.inputs) : d.inputs }));
  if (!defs.length) return { points: 0, slots: 0 };
  const site = await db.prepare('SELECT timezone FROM site WHERE id = ?').get(homeId);
  const [from] = dayBounds(site.timezone, fromDate); const to = dayBounds(site.timezone, toDate)[1];
  // the slots of the home's own points, by metric: the sum over the things that carry it (a total's delta, anything else's mean)
  const rows = await db.prepare(`SELECT m.code AS metric, m.aggregation, s.slot_start, s.dur_s, SUM(COALESCE(s.delta, s.mean)) AS v, COUNT(*) AS n, COUNT(COALESCE(s.delta, s.mean)) AS have
      FROM point_slot s JOIN point p ON p.id = s.point_id JOIN metric m ON m.id = p.metric_id
     WHERE p.home_id = ? AND p.superseded_at IS NULL AND p.key NOT LIKE 'derived\\_%' AND s.slot_start >= ? AND s.slot_start < ? GROUP BY m.code, m.aggregation, s.slot_start, s.dur_s`).all(homeId, from, to);
  const present = new Set((await db.prepare("SELECT DISTINCT m.code FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.home_id = ? AND p.superseded_at IS NULL AND p.key NOT LIKE 'derived\\_%'").all(homeId)).map((r) => r.code));
  const bySlot = new Map();
  for (const r of rows) (bySlot.get(Number(r.slot_start)) ?? bySlot.set(Number(r.slot_start), { dur: Number(r.dur_s), v: {} }).get(Number(r.slot_start))).v[r.metric] = Number(r.have) > 0 ? Number(r.v) : null;
  const out = new Map(defs.map((d) => [d.code, []]));
  for (const [start, { dur, v }] of [...bySlot].sort((a, b) => a[0] - b[0])) {
    const points = {}; for (const m of present) points[m] = v[m] ?? null;
    const done = evaluateSlot(defs, points);
    for (const d of defs) if (done[d.code].value != null && Number.isFinite(done[d.code].value)) out.get(d.code).push({ start, dur, value: done[d.code].value, lineage: done[d.code].lineage });
  }
  let written = 0;
  await tx(async () => {
    for (const d of defs) {
      const mid = Number((await db.prepare('SELECT id FROM metric WHERE code = ?').get(d.metric)).id);
      const key = `derived_${d.code}`;
      await db.prepare(`INSERT INTO point (thing_id, key, metric_id, class, access) VALUES (?, ?, ?, metric_point_class(?), 'read') ON CONFLICT (thing_id, key) WHERE superseded_at IS NULL DO NOTHING`).run(homeId, key, mid, mid);
      const point = await db.prepare('SELECT id, class FROM point WHERE thing_id = ? AND key = ? AND superseded_at IS NULL').get(homeId, key);
      await db.prepare('DELETE FROM point_slot WHERE point_id = ? AND slot_start >= ? AND slot_start < ?').run(point.id, from, to);
      for (const r of out.get(d.code)) {
        const total = point.class === 'total';
        await db.prepare(`INSERT INTO point_slot (point_id, slot_start, dur_s, mean, delta, coverage, lineage, method_version, built_at) VALUES (?, ?, ?, ?, ?, 1, ?::jsonb, 1, ?)`)
          .run(point.id, r.start, r.dur, total ? null : r.value, total ? r.value : null, JSON.stringify({ derived: d.code, formula: d.formula, inputs: r.lineage }), builtAt);
        written++;
      }
    }
  });
  return { points: defs.length, slots: written };
}
