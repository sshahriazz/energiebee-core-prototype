// Controls on every thing (plan 4.1 to 4.4 and 4.6, docs/build/controls.md): what a thing can be asked to do, who asked, which request
// wins, and what became of it.
//
//   actionsOf(thing)                what its capabilities allow, and which the device is confirmed to deliver
//   submitRequest(...)              somebody asks a thing to do something for a while
//   pickWinner(requests, at)        PURE: the highest current request (safety, manual, schedule, optimiser), the newest among equals
//   settle(thing, capability)       the winner becomes the command (through the existing gates: limits, freshness, capability rows)
//   recordExternalChange(...)       the owner changed it somewhere else: a manual request that expires, shown, never reverted before it does
//   groupRequest(place, ...)        one request on a room or a system reaches every capable member, each checked against its own limits
//   scenes                          named sets of requests, and the windows they are asked for
//
// A request never changes: it is cancelled or it runs out. When a winner runs out, the next one returns at the next settle.
import { db, tx } from '../db/db.js';
import { enqueueIfChanged, diffState, normaliseDesired } from './commands.js';
import { canControl } from './access.js';
import { membersOf } from './node-slots.js';
import { dayBounds, localDate, addDays } from './time.js';

export const PRIORITIES = Object.freeze(['optimiser', 'schedule', 'manual', 'safety']);   // weakest first
const RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i + 1]));
const fail = (status, message, code = null) => Object.assign(new Error(message), { status, code });
const COLS = 'id, uid, home_id, thing_id, capability, action, desired, priority, valid_from, valid_until, source, note, external, group_uid, created_at, cancelled_at';
const nowSec = (ms) => Math.floor(ms / 1000);

// ───────────── 4.1 what a thing can do ─────────────
/** What a thing may be asked: the actions of the capabilities of its type, with whether the device is confirmed to deliver each. */
export async function actionsOf(thingId) {
  const t = await db.prepare('SELECT t.id, t.kind, t.type, ty.capabilities FROM thing t JOIN thing_type ty ON ty.type = t.type WHERE t.id = ?').get(thingId);
  if (!t) throw fail(404, 'no such thing');
  const caps = await db.prepare('SELECT code, label, actions FROM capability WHERE code = ANY(?::text[]) ORDER BY code').all(`{${t.capabilities.join(',')}}`);
  const confirmed = new Map((await db.prepare('SELECT action, supported, source FROM device_capability WHERE device_id = ?').all(thingId)).map((r) => [r.action, r]));
  const out = [];
  for (const c of caps) for (const action of c.actions) {
    const row = confirmed.get(action);
    out.push({ capability: c.code, action, confirmed: row?.supported === 1 && row.source !== 'placeholder', source: row?.source ?? null });
  }
  return out;
}

// ───────────── 4.2 requests ─────────────
/** The request in force at `at` (epoch seconds): the highest priority, the newest among equals; null when none is current. PURE. */
export function pickWinner(requests, at) {
  const open = requests.filter((r) => r.cancelled_at == null && r.valid_from <= at && at < r.valid_until);
  open.sort((a, b) => RANK[b.priority] - RANK[a.priority] || b.created_at - a.created_at || b.id - a.id);
  return open[0] ?? null;
}

/** The next time after `at` at which the winner can change: a request starts, or a current one ends. null when none. PURE. */
export function nextChange(requests, at) {
  const times = [];
  for (const r of requests) { if (r.cancelled_at != null) continue; if (r.valid_from > at) times.push(r.valid_from); if (r.valid_until > at && r.valid_from <= at) times.push(r.valid_until); }
  return times.length ? Math.min(...times) : null;
}

const parseReq = (r) => (r ? { ...r, id: Number(r.id), home_id: Number(r.home_id), thing_id: Number(r.thing_id), valid_from: Number(r.valid_from), valid_until: Number(r.valid_until), created_at: Number(r.created_at),
  cancelled_at: r.cancelled_at == null ? null : Number(r.cancelled_at), external: Number(r.external), desired: typeof r.desired === 'string' ? JSON.parse(r.desired) : r.desired } : null);

export async function requestsOf(thingId, capability = null) {
  return (await db.prepare(`SELECT ${COLS} FROM control_request WHERE thing_id = ? AND (?::text IS NULL OR capability = ?) ORDER BY created_at, id`).all(thingId, capability, capability)).map(parseReq);
}

/**
 * Ask a thing to do something for a while. The thing must have the capability and the capability must allow the action; a thing with an
 * external controller (Octopus Intelligent Go for a car) takes only a manual or a safety request, never a schedule or the optimiser's.
 * actorUserId: a person asking needs a control right on the home. Returns the request.
 */
export async function submitRequest({ thingId, capability, action, desired = {}, priority = 'manual', validFrom, validUntil, source, note = null, external = false, groupUid = null, actorUserId = null, now = Date.now() }) {
  if (!PRIORITIES.includes(priority)) throw fail(400, `priority is one of ${PRIORITIES.join(', ')}`);
  if (!(Number.isInteger(validFrom) && Number.isInteger(validUntil) && validUntil > validFrom)) throw fail(400, 'validFrom and validUntil are epoch seconds, validUntil after validFrom');
  if (!String(source ?? '').trim()) throw fail(400, 'a request says who asked (source)');
  if (desired == null || typeof desired !== 'object' || Array.isArray(desired)) throw fail(400, 'desired is an object');
  const t = await db.prepare('SELECT t.id, t.home_id, t.kind, t.type, t.attrs, ty.capabilities FROM thing t JOIN thing_type ty ON ty.type = t.type WHERE t.id = ? AND t.superseded_at IS NULL').get(thingId);
  if (!t || t.home_id == null) throw fail(404, 'no such thing');
  if (!t.capabilities.includes(capability)) throw fail(400, `a ${t.type} has no capability ${capability}`);
  const cap = await db.prepare('SELECT actions FROM capability WHERE code = ?').get(capability);
  if (!cap?.actions.includes(action)) throw fail(400, `${capability} does not allow ${action}`);
  if (actorUserId != null && !await canControl(actorUserId, Number(t.home_id), now)) throw fail(403, `user ${actorUserId} may not control home ${t.home_id}`, 'forbidden');
  const ext = t.attrs?.external_controller;
  if (ext && ['schedule', 'optimiser'].includes(priority) && !external) throw fail(409, `this ${t.type} is run by ${ext}: only what it allows can be sent, and only as a manual request`, 'external_controller');
  const id = Number((await db.prepare(`INSERT INTO control_request (home_id, thing_id, capability, action, desired, priority, valid_from, valid_until, source, note, external, group_uid, created_at)
    VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::uuid, ?)`).run(t.home_id, thingId, capability, action, JSON.stringify(desired), priority, validFrom, validUntil, source, note, external ? 1 : 0, groupUid, now)).lastInsertRowid);
  return parseReq(await db.prepare(`SELECT ${COLS} FROM control_request WHERE id = ?`).get(id));
}

/** A request stops counting now (the next settle lets a lower one return). */
export async function cancelRequest(requestId, { now = Date.now() } = {}) {
  const r = await db.prepare(`SELECT ${COLS} FROM control_request WHERE id = ?`).get(requestId);
  if (!r) throw fail(404, 'no such request');
  if (r.cancelled_at != null) return parseReq(r);
  await db.prepare('UPDATE control_request SET cancelled_at = ? WHERE id = ?').run(now, requestId);
  return parseReq(await db.prepare(`SELECT ${COLS} FROM control_request WHERE id = ?`).get(requestId));
}

/**
 * The winner of a thing's capability at `now` becomes its command, through the gates of the command layer. Returns
 * { winner, written, reason?, command?, blocks?, external? }: nothing is sent for an external winner (the device already runs it); no
 * winner is nothing to do.
 */
export async function settle(thingId, capability, { now = Date.now(), freshnessLimits = null } = {}) {
  const at = nowSec(now);
  const winner = pickWinner(await requestsOf(thingId, capability), at);
  if (!winner) return { winner: null, written: false, reason: 'no_request' };
  if (winner.external) return { winner, written: false, reason: 'external', external: true };
  try {
    const r = await enqueueIfChanged({ deviceId: thingId, desired: { action: winner.action, ...winner.desired }, requestId: winner.id, validFrom: Math.max(winner.valid_from, at), validUntil: winner.valid_until, now, freshnessLimits });
    return { winner, ...r };
  } catch (err) {
    return { winner, written: false, reason: 'not_deliverable', error: err.message };
  }
}

/** Settle every thing and capability that has an open request (what a scheduler runs every tick, and after an expiry). Returns the outcomes. */
export async function settleAll({ now = Date.now() } = {}) {
  const at = nowSec(now);
  const pairs = await db.prepare('SELECT DISTINCT thing_id, capability FROM control_request WHERE cancelled_at IS NULL AND valid_until > ? ORDER BY thing_id, capability').all(at - 86400);
  const out = [];
  for (const p of pairs) out.push({ thingId: Number(p.thing_id), capability: p.capability, ...(await settle(Number(p.thing_id), p.capability, { now })) });
  return out;
}

/**
 * The owner (or anything else) changed a thing somewhere EnergieBee does not control (the manufacturer's app): a manual request, marked
 * external, that lasts `forS` seconds. Nothing is sent for it and nothing reverts it before it expires; the owner sees it.
 */
export async function recordExternalChange({ thingId, capability, action, desired = {}, forS = 6 * 3600, source = 'external', note = 'changed outside EnergieBee', now = Date.now() }) {
  return await submitRequest({ thingId, capability, action, desired, priority: 'manual', validFrom: nowSec(now), validUntil: nowSec(now) + forS, source, note, external: true, now });
}

/**
 * Compare what a thing reports with what it should be doing. When it reports something no command of ours explains (no open command, the
 * last one older than graceS), the difference is an external change and is recorded as one. Returns the request, or null.
 */
export async function noticeExternalChange({ thingId, capability, reported, graceS = 300, now = Date.now(), forS = 6 * 3600 }) {
  const winner = pickWinner(await requestsOf(thingId, capability), nowSec(now));
  if (!winner || winner.external) return null;
  const want = normaliseDesired({ action: winner.action, ...winner.desired });
  const diff = diffState(Object.fromEntries(Object.entries(want).filter(([k]) => reported?.[k] !== undefined)), reported);
  if (!Object.keys(diff).length) return null;
  const open = await db.prepare("SELECT 1 AS x FROM command WHERE device_id = ? AND status IN ('pending', 'sent') LIMIT 1").get(thingId);
  const last = await db.prepare('SELECT MAX(COALESCE(acked_at, sent_at, requested_at)) AS at FROM command WHERE device_id = ?').get(thingId);
  if (open || (last?.at != null && now - Number(last.at) < graceS * 1000)) return null;
  const action = reported.action ?? winner.action;
  return await recordExternalChange({ thingId, capability, action, desired: Object.fromEntries(Object.entries(reported).filter(([k]) => k !== 'action')), forS, now });
}

// ───────────── 4.4 a request on a place ─────────────
/** The things in a place that can take the capability's action: its devices (and itself, if it is one). */
export async function capableMembers(placeId, capability, action) {
  const t = await db.prepare('SELECT id, home_id, kind FROM thing WHERE id = ?').get(placeId);
  if (!t || t.home_id == null) throw fail(404, 'no such thing');
  let ids = [Number(placeId)];
  if (['home', 'space', 'system'].includes(t.kind)) {
    const edges = (await db.prepare(`SELECT from_id, to_id, required FROM thing_relation WHERE home_id = ? AND rel IN ('located_in', 'part_of') AND superseded_at IS NULL AND valid_to IS NULL`).all(t.home_id))
      .map((r) => ({ from: Number(r.from_id), to: Number(r.to_id), required: Number(r.required) }));
    ids = membersOf(Number(placeId), edges).map((m) => m.id);
  }
  const rows = await db.prepare(`SELECT t.id, t.name, t.type FROM thing t JOIN thing_type ty ON ty.type = t.type JOIN capability c ON c.code = ?
    WHERE t.id = ANY(?::bigint[]) AND t.kind = 'device' AND t.valid_to IS NULL AND ? = ANY(SELECT jsonb_array_elements_text(ty.capabilities)) AND ? = ANY(SELECT jsonb_array_elements_text(c.actions)) ORDER BY t.id`)
    .all(capability, `{${ids.join(',')}}`, capability, action);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, type: r.type }));
}

/** The places a thing is in, nearest first (its rooms, then the home). */
async function placesOf(thingId) {
  return (await db.prepare(`WITH RECURSIVE up(id, depth) AS (SELECT ?::bigint, 0 UNION SELECT r.to_id, u.depth + 1 FROM up u JOIN thing_relation r ON r.from_id = u.id
      WHERE r.rel = 'located_in' AND r.superseded_at IS NULL AND r.valid_to IS NULL AND u.depth < 20) SELECT id FROM up WHERE id <> ? ORDER BY depth`).all(thingId, thingId)).map((r) => Number(r.id));
}

/**
 * One request on a room, a floor, a system or the home: every member with the capability gets it, each checked against its own limits (and
 * the limits of the places it is in); a 'sum' limit on a place holds the members' values together, and when they pass it nobody under that
 * place is sent anything. Returns { group, members: [{ thingId, name, type, status, ... }] }: status is 'enqueued', 'unchanged' (already
 * so), 'blocked' (a gate or a sum limit said no, with the reasons) or 'not_deliverable'.
 */
export async function groupRequest({ placeId, capability, action, desired = {}, priority = 'manual', validFrom, validUntil, source, note = null, actorUserId = null, now = Date.now(), freshnessLimits = null }) {
  const members = await capableMembers(placeId, capability, action);
  const groupUid = (await db.prepare('SELECT uuidv7() AS u').get()).u;
  const results = [];
  const over = new Map();   // member id -> the sum limits it breaks
  const probe = normaliseDesired({ action, ...desired });   // the keys the limits are written in (current_a)
  const limitRows = [];
  for (const m of members) for (const p of [m.id, ...await placesOf(m.id)]) limitRows.push({ member: m.id, place: p });
  const places = [...new Set(limitRows.map((r) => r.place))];
  const sums = places.length ? await db.prepare(`SELECT device_id AS place, action, param, max_value, source FROM control_limit WHERE device_id = ANY(?::bigint[]) AND aggregate = 'sum'
    AND superseded_at IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND (action IS NULL OR action = ?) AND max_value IS NOT NULL`).all(`{${places.join(',')}}`, now, now, action) : [];
  for (const s of sums) {
    const v = probe[s.param];
    if (typeof v !== 'number') continue;
    const under = [...new Set(limitRows.filter((r) => r.place === Number(s.place)).map((r) => r.member))];
    const total = v * under.length;
    if (total > s.max_value) for (const id of under) (over.get(id) ?? over.set(id, []).get(id)).push({ gate: 'sum_limit', detail: { param: s.param, place: Number(s.place), members: under.length, each: v, total, max: s.max_value, source: s.source } });
  }
  for (const m of members) {
    const row = { thingId: m.id, name: m.name, type: m.type };
    if (over.has(m.id)) { results.push({ ...row, status: 'blocked', blocks: over.get(m.id) }); continue; }
    try {
      const req = await submitRequest({ thingId: m.id, capability, action, desired, priority, validFrom, validUntil, source, note, groupUid, actorUserId, now });
      const s = await settle(m.id, capability, { now, freshnessLimits });
      results.push({ ...row, requestId: req.id, status: s.written ? 'enqueued' : s.reason === 'blocked' ? 'blocked' : s.reason === 'not_deliverable' ? 'not_deliverable' : s.reason === 'external' ? 'external' : 'unchanged',
        ...(s.blocks ? { blocks: s.blocks } : {}), ...(s.error ? { error: s.error } : {}), ...(s.reason && !s.written ? { reason: s.reason } : {}) });
    } catch (err) {
      if (err.code === 'forbidden') throw err;
      results.push({ ...row, status: 'not_deliverable', error: err.message });
    }
  }
  return { group: groupUid, members: results };
}

// ───────────── 4.6 scenes and schedules ─────────────
const sceneRow = async (id) => await db.prepare('SELECT id, uid, home_id, name, created_at, updated_at FROM scene WHERE id = ?').get(id);

/** Make (or replace the items of) a named scene: items are [{ thingId, capability, action, desired }]. */
export async function saveScene({ homeId, name, items = [], now = Date.now() }) {
  if (!String(name ?? '').trim()) throw fail(400, 'a scene has a name');
  for (const it of items) {
    const t = await db.prepare('SELECT home_id FROM thing WHERE id = ?').get(it.thingId);
    if (!t || Number(t.home_id) !== Number(homeId)) throw fail(404, 'a scene holds things of its own home');
    const cap = await db.prepare('SELECT actions FROM capability WHERE code = ?').get(it.capability);
    if (!cap?.actions.includes(it.action)) throw fail(400, `${it.capability} does not allow ${it.action}`);
  }
  return await tx(async () => {
    const have = await db.prepare('SELECT id FROM scene WHERE home_id = ? AND name = ?').get(homeId, name.trim());
    const id = have ? Number(have.id) : Number((await db.prepare('INSERT INTO scene (home_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(homeId, name.trim(), now, now)).lastInsertRowid);
    if (have) { await db.prepare('UPDATE scene SET updated_at = ? WHERE id = ?').run(now, id); await db.prepare('DELETE FROM scene_item WHERE scene_id = ?').run(id); }
    for (const it of items) await db.prepare('INSERT INTO scene_item (scene_id, thing_id, capability, action, desired) VALUES (?, ?, ?, ?, ?::jsonb)').run(id, it.thingId, it.capability, it.action, JSON.stringify(it.desired ?? {}));
    return await getScene(id);
  });
}
export async function getScene(id) {
  const s = await sceneRow(id);
  if (!s) throw fail(404, 'no such scene');
  return { ...s, id: Number(s.id), home_id: Number(s.home_id),
    items: (await db.prepare('SELECT thing_id, capability, action, desired FROM scene_item WHERE scene_id = ? ORDER BY id').all(id)).map((i) => ({ thingId: Number(i.thing_id), capability: i.capability, action: i.action, desired: i.desired })),
    schedules: (await db.prepare('SELECT id, weekdays, from_min, until_min FROM scene_schedule WHERE scene_id = ? ORDER BY id').all(id)).map((x) => ({ id: Number(x.id), weekdays: x.weekdays.split(',').map(Number), fromMin: Number(x.from_min), untilMin: Number(x.until_min) })) };
}
export async function scheduleScene(sceneId, { weekdays, fromMin, untilMin }) {
  await db.prepare('INSERT INTO scene_schedule (scene_id, weekdays, from_min, until_min) VALUES (?, ?, ?, ?)').run(sceneId, [...new Set(weekdays)].sort().join(','), fromMin, untilMin);
  return await getScene(sceneId);
}

/** Ask for a scene: every item becomes a request of priority `schedule` (or the one given) and is settled; a place item reaches every capable member. */
export async function applyScene(sceneId, { validFrom, validUntil, priority = 'schedule', actorUserId = null, now = Date.now(), source = null } = {}) {
  const scene = await getScene(sceneId);
  const out = [];
  for (const it of scene.items) {
    const kind = (await db.prepare('SELECT kind FROM thing WHERE id = ?').get(it.thingId))?.kind;
    const src = source ?? `scene:${scene.id}`;
    if (kind === 'device') {
      try { const req = await submitRequest({ ...it, priority, validFrom, validUntil, source: src, actorUserId, now }); out.push({ thingId: it.thingId, requestId: req.id, ...(await settle(it.thingId, it.capability, { now })) }); }
      catch (err) { if (err.code === 'forbidden') throw err; out.push({ thingId: it.thingId, written: false, reason: 'not_deliverable', error: err.message }); }
    } else out.push({ thingId: it.thingId, group: await groupRequest({ placeId: it.thingId, capability: it.capability, action: it.action, desired: it.desired, priority, validFrom, validUntil, source: src, actorUserId, now }) });
  }
  return { scene: { id: scene.id, name: scene.name }, items: out };
}

/** The windows of a schedule on local days fromDate..toDate: [{ from, until }] in epoch seconds. PURE given the zone. */
export function scheduleWindows(schedule, tz, fromDate, toDate) {
  const out = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const [start] = dayBounds(tz, d);
    const iso = ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;   // ISO weekday of the local date
    if (!schedule.weekdays.includes(iso)) continue;
    out.push({ from: start + schedule.fromMin * 60, until: start + schedule.untilMin * 60, date: d });
  }
  return out;
}

/** Ask for every scene whose schedule starts inside [now, now + horizonS) and has not been asked for yet (one request set per window). Returns what was applied. */
export async function applyDueSchedules({ now = Date.now(), horizonS = 3600 } = {}) {
  const at = nowSec(now); const out = [];
  for (const s of await db.prepare('SELECT s.id AS scene_id, s.home_id, sc.id AS sched_id, sc.weekdays, sc.from_min, sc.until_min FROM scene s JOIN scene_schedule sc ON sc.scene_id = s.id ORDER BY s.id, sc.id').all()) {
    const tz = (await db.prepare('SELECT timezone FROM site WHERE id = ?').get(s.home_id))?.timezone ?? 'UTC';
    const sched = { weekdays: s.weekdays.split(',').map(Number), fromMin: Number(s.from_min), untilMin: Number(s.until_min) };
    const today = localDate(tz, at);
    for (const w of scheduleWindows(sched, tz, today, addDays(today, 1))) {
      if (w.from < at || w.from >= at + horizonS) continue;
      const source = `scene:${s.scene_id}:${w.from}`;
      if (await db.prepare('SELECT 1 AS x FROM control_request WHERE source = ? LIMIT 1').get(source)) continue;
      out.push(await applyScene(Number(s.scene_id), { validFrom: w.from, validUntil: w.until, now, source }));
    }
  }
  return out;
}
