// Point state (plan 2.9, R15): the latest reported value of every point, and the value asked of it. This is the device shadow the pages and
// the control loop read: what a thing is doing now and what it was told to do, without scanning facts. It is working state, not history:
// the facts are the history, and a state can always be rebuilt from them.
//
// Reported: kept up to date by the fact writers (putReadings, putIntervals) as they store; only a newer time replaces it, so a replayed
// or backfilled old reading never makes a point look older than it is. Desired: set when something asks a point to take a value (a
// command, a schedule), cleared when the point reports it or the request lapses.
import { db } from '../db/db.js';
import { pointsOf } from './points.js';

const UPSERT_REPORTED = `INSERT INTO point_state (point_id, reported_value, reported_ts, reported_source_id, reported_at, updated_at)
  SELECT s.point_id, ?, ?, s.source_id, ?, ? FROM series s WHERE s.id = ?
  ON CONFLICT (point_id) DO UPDATE SET reported_value = excluded.reported_value, reported_ts = excluded.reported_ts,
    reported_source_id = excluded.reported_source_id, reported_at = excluded.reported_at, updated_at = excluded.updated_at
  WHERE point_state.reported_ts IS NULL OR excluded.reported_ts > point_state.reported_ts
     OR (excluded.reported_ts = point_state.reported_ts AND excluded.reported_at >= point_state.reported_at)`;

/** A value was stored for a series: ts is when it was true (epoch seconds), at when the core stored it (ms). Called by the fact writers. */
export async function touchReported(seriesId, { ts, value, at = Date.now() }) {
  await db.prepare(UPSERT_REPORTED).run(value ?? null, ts, at, at, seriesId);
}

/** Something asks a point to take a value. `by` says who (a command id, 'schedule', 'manual'); `at` is when it was asked (epoch seconds). */
export async function setDesired(pointId, value, { by = null, commandId = null, at = Math.floor(Date.now() / 1000) } = {}) {
  if (value != null && !Number.isFinite(Number(value))) throw new RangeError(`desired value ${value}: a number`);
  const p = await db.prepare('SELECT id, access FROM point WHERE id = ? AND superseded_at IS NULL').get(pointId);
  if (!p) throw Object.assign(new Error('no such point'), { status: 404 });
  if (p.access === 'read') throw Object.assign(new RangeError('this point is read only: nothing can be asked of it'), { status: 400 });
  const now = Date.now();
  await db.prepare(`INSERT INTO point_state (point_id, desired_value, desired_ts, desired_by, desired_command_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (point_id) DO UPDATE SET desired_value = excluded.desired_value, desired_ts = excluded.desired_ts, desired_by = excluded.desired_by,
      desired_command_id = excluded.desired_command_id, updated_at = excluded.updated_at`).run(pointId, value == null ? null : Number(value), at, by, commandId, now);
}

/** The request lapsed or was met: nothing is asked of the point any more. */
export async function clearDesired(pointId) {
  await db.prepare(`UPDATE point_state SET desired_value = NULL, desired_ts = NULL, desired_by = NULL, desired_command_id = NULL, updated_at = ? WHERE point_id = ?`).run(Date.now(), pointId);
}

/** The shadow of a thing: each of its points with the value last reported and the value asked, if any. */
export async function stateOf(thingId) {
  const state = new Map((await db.prepare(`SELECT st.point_id, st.reported_value, st.reported_ts, st.reported_at, so.code AS reported_source, st.desired_value, st.desired_ts, st.desired_by, st.desired_command_id
    FROM point_state st JOIN point p ON p.id = st.point_id LEFT JOIN source so ON so.id = st.reported_source_id WHERE p.thing_id = ?`).all(thingId)).map((r) => [Number(r.point_id), r]));
  return (await pointsOf(thingId)).map((p) => {
    const s = state.get(Number(p.id));
    return {
      id: Number(p.id), uid: p.uid, key: p.key, metric: p.metric, unit: p.unit, class: p.class, access: p.access,
      reported: s?.reported_ts == null ? null : { value: s.reported_value, ts: s.reported_ts, source: s.reported_source, recorded_at: s.reported_at },
      desired: s?.desired_ts == null ? null : { value: s.desired_value, ts: s.desired_ts, by: s.desired_by, commandId: s.desired_command_id },
    };
  });
}
