// What happened to a thing, and to the things in a place (plan 3.5, docs/build/timelines.md): the commands sent to a device and what came
// of them, the events its sensors reported (a defrost, a plug, a door), and the changes of its state points (a plug on and off). For a
// room, a floor, a system or the home it is the same list over everything in it, each entry saying which thing it was. Built on read from
// command_log and the facts; nothing is stored twice.
import { db } from '../db/db.js';
import { membersOf } from './node-slots.js';

const MAX = 500;
const secs = (ms) => Math.floor(Number(ms) / 1000);

/**
 * The events of a thing (and everything in it) in [from, to), oldest first, at most `limit` (the newest are kept). Each entry:
 * { ts, kind: 'command' | 'event' | 'state', thing: { id, name, type }, what, detail }.
 */
export async function eventsOf(thingId, from, to, { limit = MAX } = {}) {
  const t = await db.prepare('SELECT id, home_id, kind FROM thing WHERE id = ?').get(thingId);
  if (!t) throw Object.assign(new Error('no such thing'), { status: 404 });
  let ids = [Number(thingId)];
  if (t.home_id != null && ['home', 'space', 'system'].includes(t.kind)) {
    const edges = (await db.prepare(`SELECT from_id, to_id, required FROM thing_relation WHERE home_id = ? AND rel IN ('located_in', 'part_of') AND superseded_at IS NULL AND valid_to IS NULL`).all(t.home_id))
      .map((r) => ({ from: Number(r.from_id), to: Number(r.to_id), required: Number(r.required) }));
    ids = [Number(thingId), ...membersOf(Number(thingId), edges).map((m) => m.id)];
  }
  const idList = `{${ids.join(',')}}`;
  const things = new Map((await db.prepare('SELECT id, name, type FROM thing WHERE id = ANY(?::bigint[])').all(idList)).map((x) => [Number(x.id), { id: Number(x.id), name: x.name, type: x.type }]));
  const out = [];
  // commands and what came of them
  for (const r of await db.prepare(`SELECT c.device_id, c.action, c.status, l.at, l.event, l.detail FROM command c JOIN command_log l ON l.command_id = c.id
      WHERE c.device_id = ANY(?::bigint[]) AND l.at >= ? AND l.at < ? ORDER BY l.at, l.id`).all(idList, from * 1000, to * 1000)) {
    out.push({ ts: secs(r.at), kind: 'command', thing: things.get(Number(r.device_id)), what: `${r.action} ${r.event}`, detail: r.detail ? JSON.parse(r.detail) : null });
  }
  // events the points of these things reported (class event), and the changes of their state points
  const points = await db.prepare(`SELECT p.id, p.thing_id, p.key, p.class, m.code AS metric FROM point p JOIN metric m ON m.id = p.metric_id
    WHERE p.thing_id = ANY(?::bigint[]) AND p.class IN ('event', 'state') AND p.superseded_at IS NULL`).all(idList);
  for (const p of points) {
    const series = (await db.prepare('SELECT id FROM series WHERE point_id = ?').all(p.id)).map((s) => Number(s.id));
    if (!series.length) continue;
    const list = `{${series.join(',')}}`;
    if (p.class === 'event') {
      for (const f of await db.prepare(`SELECT start_ts, end_ts FROM interval_fact WHERE series_id = ANY(?::bigint[]) AND superseded_at IS NULL AND value IS NOT NULL AND value <> 0 AND end_ts > ? AND start_ts < ? ORDER BY start_ts`).all(list, from, to)) {
        out.push({ ts: Number(f.start_ts), kind: 'event', thing: things.get(Number(p.thing_id)), what: p.metric, detail: { until: Number(f.end_ts) } });
      }
    } else {
      let prev = (await db.prepare('SELECT value FROM reading WHERE series_id = ANY(?::bigint[]) AND superseded_at IS NULL AND ts < ? AND value IS NOT NULL ORDER BY ts DESC LIMIT 1').get(list, from))?.value ?? null;
      for (const r of await db.prepare('SELECT ts, value FROM reading WHERE series_id = ANY(?::bigint[]) AND superseded_at IS NULL AND ts >= ? AND ts < ? AND value IS NOT NULL ORDER BY ts').all(list, from, to)) {
        if (prev !== null && r.value !== prev) out.push({ ts: Number(r.ts), kind: 'state', thing: things.get(Number(p.thing_id)), what: p.metric, detail: { from: prev, to: r.value } });
        prev = r.value;
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts || (a.kind < b.kind ? -1 : 1));
  return out.slice(-limit);
}
