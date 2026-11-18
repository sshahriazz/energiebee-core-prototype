// The thing library (plan Phase 1.8; docs/thing-model.md sections 3.1 and 3.2): create, change, retire, place and relate things,
// replace a device, merge two things discovered twice, split one wrongly joined, and read the graph back as it is, or as it
// was known at a past moment. The database holds the rules (src/db/seed/things.js, migrations 20261118110000 and ...01);
// this file holds what needs a decision: time (slot boundaries), value checks, and moving what points at a thing.
//
// Identity. A thing is known by its integer id inside the database and by its uid outside it. Every function takes either
// (a number, a uuid string, or a row with an id). A merged thing keeps its row and its uid: `resolveThing` follows the merge to
// the thing that survived, so the uid a hub still sends for it lands on the right thing.
//
// Time. Valid time is seconds, record time is milliseconds (like every configuration table). A change to a relation takes
// effect at the next slot boundary of the home (R13): `changed_at` keeps the exact moment, `valid_from` is the boundary. The
// boundary comes from the home's slot length and time zone (an explicit option, else the home thing's attributes, else the
// site row until the site is folded into the home thing: `homeClock` is the one place to change then). A relation is never
// edited in place: the old row is superseded and the corrected one is written, so "as known at" any earlier moment still
// shows what was known (the pattern of site_group_member).
//
// Moving what points at a thing (merge, split) is found from the schema: every foreign key to thing(id) is discovered, so a
// table added later (points, links) is covered without a change here. What a table's kind (src/db/table-kinds.js) says
// decides how its rows move: versioned configuration is superseded and written again, working state is updated, and logs,
// facts, registries and secrets are history and stay on the thing they were written for.
import { db, tx, columnsOf } from '../db/db.js';
import { TABLE_KINDS } from '../db/table-kinds.js';
import { THING_ONLY_KEYS } from '../db/seed/things.js';
import { SLOT, SLOT_LENGTHS, dayBounds, localDate, nowSec, recordedNow, slotLength } from './time.js';
import { attributeDef } from './attributes.js';
import { checkValue } from './value-check.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LO = -9_000_000_000;   // the same stand-ins for "no start" and "no end" as the exclusion constraints use
const HI = 9_000_000_000;
const THING_COLS = 'id, uid, site_id, kind, type, name, attrs, std_ref, valid_from, valid_to, recorded_at, superseded_at, merged_into';
const REL_COLS = 'id, site_id, from_id, from_port, rel, to_id, to_port, required, valid_from, valid_to, changed_at, recorded_at, superseded_at';
const inList = (ids) => JSON.stringify(ids.map(String));   // a list of ids as one parameter: id::text IN (SELECT jsonb_array_elements_text(?))

// ───────────── identity ─────────────
function refKey(ref) {
  if (ref && typeof ref === 'object' && 'id' in ref) return { id: Number(ref.id) };
  if (typeof ref === 'number' && Number.isInteger(ref)) return { id: ref };
  if (typeof ref === 'string' && UUID.test(ref)) return { uid: ref.toLowerCase() };
  throw new RangeError(`not a thing reference: ${JSON.stringify(ref)} (an id, a uid, or a row with an id)`);
}

/** The thing row for an id or uid, as it is stored now (a merged thing comes back as it is). Throws 404. */
export async function getThing(ref) {
  const k = refKey(ref);
  const row = k.id != null
    ? await db.prepare(`SELECT ${THING_COLS} FROM thing WHERE id = ?`).get(k.id)
    : await db.prepare(`SELECT ${THING_COLS} FROM thing WHERE uid = ?::uuid`).get(k.uid);
  if (!row) throw fail(404, `no thing ${k.id ?? k.uid}`);
  return row;
}

/** Like getThing, but follows merges: the thing that survived. */
export async function resolveThing(ref) {
  let row = await getThing(ref);
  for (let hops = 0; row.merged_into != null; hops++) {
    if (hops > 50) throw new Error(`merge chain of thing ${row.id} does not end`);
    row = await getThing(row.merged_into);
  }
  return row;
}

// A thing that can be changed: not merged away.
async function liveThing(ref) {
  const row = await getThing(ref);
  if (row.merged_into != null) throw fail(409, `thing ${row.id} (${row.name}) was merged into thing ${row.merged_into}: use that one`);
  return row;
}

// ───────────── time: slot boundaries ─────────────
/** The first slot boundary at or after ts (seconds), on the home's grid: slots start at local midnight and step by slotS. */
export function nextSlotBoundary(ts, { slotS = SLOT, timezone = 'UTC' } = {}) {
  if (!SLOT_LENGTHS.includes(slotS)) throw new RangeError(`slot length ${slotS}: one of ${SLOT_LENGTHS.join(', ')}`);
  if (!Number.isFinite(ts)) throw new RangeError(`not a time: ${ts}`);
  const t = Math.floor(ts);
  const [a, b] = dayBounds(timezone, localDate(timezone, t));
  return Math.min(a + Math.ceil((t - a) / slotS) * slotS, b);   // a day whose length is not a whole number of slots ends on its own midnight
}

/** A home's slot length and time zone: the home thing's attributes, else the site row (until the site is the home thing). */
export async function homeClock(siteId) {
  if (siteId == null) return { slotS: SLOT, timezone: 'UTC' };
  const home = await db.prepare("SELECT attrs FROM thing WHERE site_id = ? AND kind = 'home' AND superseded_at IS NULL").get(siteId);
  const site = await db.prepare('SELECT slot_s, timezone FROM site WHERE id = ?').get(siteId);
  return { slotS: slotLength({ slot_s: home?.attrs?.slot_s ?? site?.slot_s }), timezone: home?.attrs?.timezone ?? site?.timezone ?? 'UTC' };
}

// The snapped time of a change at `at` in a home: { changedAt, boundary }. Options slotS and timezone override the home's.
async function snap(siteId, at, o = {}) {
  const clock = await homeClock(siteId);
  const changedAt = Math.floor(at ?? nowSec());
  return { changedAt, boundary: nextSlotBoundary(changedAt, { slotS: o.slotS ?? clock.slotS, timezone: o.timezone ?? clock.timezone }) };
}

// ───────────── value checks ─────────────
// A key of attribute_def is checked by its registry row (the same rules as every other attribute); the few keys that are only
// on things (a home's own settings, plain descriptions) are checked here.
const THING_KEY_CHECKS = {
  slot_s: (v) => (SLOT_LENGTHS.includes(v) ? null : `one of ${SLOT_LENGTHS.join(', ')}`),
  timezone: (v) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: v }); return typeof v === 'string' ? null : 'a time zone name'; } catch { return 'a time zone name'; } },
  currency: (v) => (/^[A-Z]{3}$/.test(v) ? null : 'a three-letter currency code'),
  country: (v) => (/^[A-Z]{2}$/.test(v) ? null : 'a two-letter country code'),
  contracted_kva: (v) => (typeof v === 'number' && v > 0 ? null : 'a number above 0'),
  is_demo: (v) => (v === 0 || v === 1 || typeof v === 'boolean' ? null : 'true or false'),
};

async function checkAttrs(type, attrs) {
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) throw new RangeError('attrs must be an object');
  const allowed = type.attribute_keys;
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!allowed.includes(key)) throw new RangeError(`attribute ${key} is not carried by type ${type.type}`);
    const def = await attributeDef(key);
    let v;
    if (def) v = checkValue(def, value, `attribute ${key}`);
    else if (THING_ONLY_KEYS.includes(key)) {
      v = value === '' ? null : value;
      if (v != null) {
        const why = THING_KEY_CHECKS[key]?.(v) ?? (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? null : 'a text, number or yes/no');
        if (why) throw new RangeError(`attribute ${key}: must be ${why} (got ${JSON.stringify(value)})`);
      }
    } else throw new RangeError(`attribute ${key} has no definition (attribute_def)`);
    if (v != null) out[key] = v;   // null is "no value": the key is left out
  }
  return out;
}

const typeRow = async (type) => {
  const t = await db.prepare('SELECT type, kind, attribute_keys FROM thing_type WHERE type = ?').get(type);
  if (!t) throw fail(400, `unknown thing type ${type}`);
  return t;
};

// ───────────── relation rows ─────────────
async function insertRelation(r, stamp) {
  return Number((await db.prepare(`INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port, required, valid_from, valid_to, changed_at, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.from_id, r.from_port ?? null, r.rel, r.to_id, r.to_port ?? null, r.required ?? 1, r.valid_from ?? null, r.valid_to ?? null, r.changed_at ?? null, stamp)).lastInsertRowid);
}
const supersedeRelation = async (id, stamp) =>
  await db.prepare('UPDATE thing_relation SET superseded_at = GREATEST(?::bigint, recorded_at) WHERE id = ? AND superseded_at IS NULL').run(stamp, id);

// The relation stops holding at `at` (a slot boundary): a row that started earlier is superseded and written again with its end,
// one that had not started yet is cancelled, one that ended already stays. Returns what happened.
async function endRelation(row, at, stamp) {
  if (row.valid_to != null && row.valid_to <= at) return 'unchanged';
  await supersedeRelation(row.id, stamp);
  if (row.valid_from != null && row.valid_from >= at) return 'cancelled';
  await insertRelation({ ...row, valid_to: at }, stamp);
  return 'ended';
}

const currentRelationsOf = async (id) =>
  await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE (from_id = ? OR to_id = ?) AND superseded_at IS NULL ORDER BY id`).all(id, id);

// Run fn in a savepoint: { ok: true, value } or, when the database refuses it, { ok: false, error } with its writes undone.
let savepoints = 0;
async function attempt(fn) {
  const sp = `things_${++savepoints}`;
  await db.exec(`SAVEPOINT ${sp}`);
  try {
    const value = await fn();
    await db.exec(`RELEASE SAVEPOINT ${sp}`);
    return { ok: true, value };
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    await db.exec(`RELEASE SAVEPOINT ${sp}`);
    return { ok: false, error };
  }
}

// Window arithmetic on [from, to) with null for open ends.
function subtractWindows(win, covers) {
  let pieces = [[win[0] ?? LO, win[1] ?? HI]];
  for (const [ca, cb] of covers.map((c) => [c[0] ?? LO, c[1] ?? HI])) {
    pieces = pieces.flatMap(([a, b]) => {
      if (cb <= a || ca >= b) return [[a, b]];
      return [...(ca > a ? [[a, ca]] : []), ...(cb < b ? [[cb, b]] : [])];
    });
  }
  return pieces.filter(([a, b]) => b > a).map(([a, b]) => [a === LO ? null : a, b === HI ? null : b]);
}

// Hand some of a thing's current relations to another thing from a boundary on (replace, split). A relation that straddles the
// boundary is cut there: the part before stays, the part from the boundary on moves. One that starts later moves whole. One that
// ended before stays. With boundary null every given relation moves whole, from its own start. Not tried in a savepoint: a
// refusal by the rules stops the whole operation.
async function transferRelations(rows, fromId, toId, boundary, changedAt, stamp) {
  const moved = [];
  for (const r of rows) {
    if (boundary != null && r.valid_to != null && r.valid_to <= boundary) continue;
    const cut = boundary != null && (r.valid_from == null || r.valid_from < boundary);
    await supersedeRelation(r.id, stamp);
    if (cut) await insertRelation({ ...r, valid_to: boundary }, stamp);
    const swap = (x) => (x === fromId ? toId : x);
    moved.push(await insertRelation({
      ...r, from_id: swap(r.from_id), to_id: swap(r.to_id),
      valid_from: cut ? boundary : r.valid_from, changed_at: cut ? changedAt : r.changed_at,
    }, stamp));
  }
  return moved;
}

// ───────────── what points at a thing ─────────────
// Tables the library handles itself.
const OWN_TABLES = new Set(['thing', 'thing_attr_version', 'thing_relation', 'thing_op']);

/** Every single-column foreign key to thing(id) outside the thing tables: [{ table, column, kind }]. */
export async function thingReferences() {
  const rows = await db.prepare(`SELECT kcu.table_name AS child, kcu.column_name AS col
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
     WHERE rc.constraint_schema = current_schema() AND ccu.table_name = 'thing' AND ccu.column_name = 'id'
       AND (SELECT COUNT(*) FROM information_schema.key_column_usage k WHERE k.constraint_name = rc.constraint_name AND k.constraint_schema = rc.constraint_schema) = 1
     ORDER BY 1, 2`).all();
  return rows.filter((r) => !OWN_TABLES.has(r.child)).map((r) => ({ table: r.child, column: r.col, kind: TABLE_KINDS[r.child] ?? 'runtime' }));
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const HISTORY_KINDS = new Set(['log', 'fact', 'registry', 'secret']);

// Point rows of one table that name `from` at `to`: all of them, or only the ids given. Versioned configuration (valid and record
// time) is superseded and written again, so the earlier knowledge stays; anything else is updated. Returns the rows moved.
async function moveRows(ref, from, to, stamp, ids = null) {
  const cols = await columnsOf(ref.table);
  const pick = ids ? ` AND id::text IN (SELECT jsonb_array_elements_text(?::jsonb))` : '';
  const extra = ids ? [inList(ids)] : [];
  const versioned = ref.kind === 'config' && cols.includes('superseded_at') && cols.includes('recorded_at') && cols.includes('id');
  if (!versioned) return (await db.prepare(`UPDATE ${q(ref.table)} SET ${q(ref.column)} = ? WHERE ${q(ref.column)} = ?${pick}`).run(to, from, ...extra)).changes;
  const copyCols = cols.filter((c) => !['id', 'uid', 'superseded_at', 'recorded_at'].includes(c));
  const list = copyCols.map(q).join(', ');
  const sel = copyCols.map((c) => (c === ref.column ? '?::bigint' : q(c))).join(', ');
  const open = await db.prepare(`SELECT id FROM ${q(ref.table)} WHERE ${q(ref.column)} = ? AND superseded_at IS NULL${pick} ORDER BY id`).all(from, ...extra);
  for (const r of open) {
    await db.prepare(`UPDATE ${q(ref.table)} SET superseded_at = GREATEST(?::bigint, recorded_at) WHERE id = ?`).run(stamp, r.id);
    await db.prepare(`INSERT INTO ${q(ref.table)} (${list}, recorded_at) SELECT ${sel}, ?::bigint FROM ${q(ref.table)} WHERE id = ?`).run(to, stamp, r.id);
  }
  return open.length;
}

// ───────────── the operation log ─────────────
async function logOp(op, thing, other, effectiveAt, reason, detail, stamp) {
  if (!String(reason ?? '').trim()) throw fail(400, `a ${op} needs a reason`);
  return Number((await db.prepare('INSERT INTO thing_op (site_id, op, thing_id, other_id, effective_at, reason, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)')
    .run(thing.site_id, op, thing.id, other.id, effectiveAt, String(reason).trim(), JSON.stringify(detail), stamp)).lastInsertRowid);
}

// ───────────── create, change, retire ─────────────
/**
 * A new thing. `type` decides the kind; a context thing (a tariff, a region) has no site, every other kind needs one. `attrs` is
 * checked against the type's keys and the attribute registry. `uid` is for a hub that made the identity itself.
 */
export async function createThing({ siteId = null, type, name, attrs = {}, uid = null, validFrom = null, stdRef = null }) {
  return await tx(async () => {
    const ty = await typeRow(type);
    if (ty.kind === 'context' && siteId != null) throw fail(400, `a ${type} is shared context: it has no home`);
    if (ty.kind !== 'context' && siteId == null) throw fail(400, `a ${type} belongs to a home: give siteId`);
    if (uid != null && !UUID.test(uid)) throw new RangeError(`uid ${uid} is not a uuid`);
    if (!String(name ?? '').trim()) throw new RangeError('a thing needs a name');
    const clean = await checkAttrs(ty, attrs);
    const id = Number((await db.prepare('INSERT INTO thing (uid, site_id, kind, type, name, attrs, std_ref, valid_from) VALUES (COALESCE(?::uuid, uuidv7()), ?, ?, ?, ?, ?::jsonb, ?, ?)')
      .run(uid, siteId, ty.kind, type, String(name).trim(), JSON.stringify(clean), stdRef, validFrom)).lastInsertRowid);
    return await getThing(id);
  });
}

/** Rename a thing and/or change attributes: `attrs` is a patch (a key set to null is removed). One change is one version. */
export async function updateThing(ref, { name, attrs } = {}) {
  return await tx(async () => {
    const t = await liveThing(ref);
    const ty = await typeRow(t.type);
    const next = attrs ? await checkAttrs(ty, { ...t.attrs, ...attrs }) : t.attrs;
    const nextName = name == null ? t.name : String(name).trim();
    if (!nextName) throw new RangeError('a thing needs a name');
    if (nextName !== t.name || JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(t.attrs))) {
      await db.prepare('UPDATE thing SET name = ?, attrs = ?::jsonb WHERE id = ?').run(nextName, JSON.stringify(next), t.id);
    }
    return await getThing(t.id);
  });
}
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Change a thing's type within its kind (a generic device becomes a smart plug). Its attributes and every current relation are
 * checked against the new type: a refusal leaves nothing changed.
 */
export async function changeType(ref, type) {
  return await tx(async () => {
    const t = await liveThing(ref);
    const ty = await typeRow(type);
    if (ty.kind !== t.kind) throw fail(400, `a ${t.kind} thing cannot become a ${ty.kind} (${type})`);
    if (ty.type === t.type) return t;
    await db.prepare('UPDATE thing SET type = ? WHERE id = ?').run(type, t.id);
    // The relation trigger runs again for every current relation of the thing (an update that names the column fires it).
    await db.prepare('UPDATE thing_relation SET from_id = from_id WHERE (from_id = ? OR to_id = ?) AND superseded_at IS NULL').run(t.id, t.id);
    return await getThing(t.id);
  });
}

/**
 * The thing leaves service at the next slot boundary after `at`. Its relations end there. A space or system that still holds
 * things is not retired: move them first.
 */
export async function retireThing(ref, { at = nowSec(), slotS, timezone } = {}) {
  return await tx(async () => {
    const t = await liveThing(ref);
    const { changedAt, boundary } = await snap(t.site_id, at, { slotS, timezone });
    if (t.valid_to != null && t.valid_to <= boundary) throw fail(409, `${t.name} was retired already (at ${t.valid_to})`);
    if (t.valid_from != null && boundary <= t.valid_from) throw fail(409, `${t.name} began at ${t.valid_from}: it cannot be retired before it began`);
    const holds = await db.prepare(`SELECT f.name FROM thing_relation r JOIN thing f ON f.id = r.from_id
      WHERE r.to_id = ? AND r.rel IN ('located_in', 'part_of') AND r.superseded_at IS NULL AND COALESCE(r.valid_to, ${HI}) > ? AND f.valid_to IS NULL ORDER BY f.name`).all(t.id, boundary);
    if (holds.length) throw fail(409, `${t.name} still holds ${holds.map((h) => h.name).join(', ')}: move them first`);
    const stamp = recordedNow();
    const ended = [];
    for (const r of await currentRelationsOf(t.id)) {
      const what = await endRelation(r, boundary, stamp);
      if (what !== 'unchanged') ended.push({ id: r.id, rel: r.rel, what });
    }
    await db.prepare('UPDATE thing SET valid_to = ? WHERE id = ?').run(boundary, t.id);
    return { thing: await getThing(t.id), changedAt, boundary, relations: ended };
  });
}

// A thing can take a relation from `start` on: it is not merged away, has begun and was not retired before.
function assertAlive(t, start) {
  if (t.merged_into != null) throw fail(409, `thing ${t.id} (${t.name}) was merged into thing ${t.merged_into}: use that one`);
  if (t.valid_from != null && start < t.valid_from) throw fail(409, `${t.name} began at ${t.valid_from}: a relation cannot start at ${start}`);
  if (t.valid_to != null && start >= t.valid_to) throw fail(409, `${t.name} was retired at ${t.valid_to}: a relation cannot start at ${start}`);
}

/**
 * A relation from `from` to `to` (rel and ports as the rules of relation_rule allow), taking effect at the next slot boundary after
 * `at`; the exact moment is kept as changed_at. `validTo` ends it (a boundary you choose); left open it ends where a retired thing's
 * service ends. Returns the relation row.
 */
export async function relate({ from, rel, to, fromPort = null, toPort = null, at = nowSec(), validTo = null, required = 1, slotS, timezone }) {
  return await tx(async () => {
    const a = await getThing(from);
    const b = await getThing(to);
    const { changedAt, boundary } = await snap(a.site_id ?? b.site_id, at, { slotS, timezone });
    assertAlive(a, boundary);
    assertAlive(b, boundary);
    const ends = [validTo, a.valid_to, b.valid_to].filter((x) => x != null);
    if (validTo != null && ends.some((e) => e < validTo)) throw fail(409, 'a relation cannot outlast a thing it joins');
    const end = ends.length ? Math.min(...ends) : null;
    const id = await insertRelation({ from_id: a.id, from_port: fromPort, rel, to_id: b.id, to_port: toPort, required, valid_from: boundary, valid_to: end, changed_at: changedAt }, recordedNow());
    return await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ?`).get(id);
  });
}

/** A relation stops holding at the next slot boundary after `at`. Returns { what: 'ended' | 'cancelled' | 'unchanged', boundary }. */
export async function unrelate(relationId, { at = nowSec(), slotS, timezone } = {}) {
  return await tx(async () => {
    const r = await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ? AND superseded_at IS NULL`).get(relationId);
    if (!r) throw fail(404, `no current relation ${relationId}`);
    const { boundary } = await snap(r.site_id, at, { slotS, timezone });
    return { what: await endRelation(r, boundary, recordedNow()), boundary };
  });
}

/**
 * Move a thing to another place (a room, a floor, the home): its current placement ends at the next slot boundary after `at` and the
 * new one starts there, so no slot is split between two places. A plug moved at 14:10 on a half-hour grid counts in the old room for
 * the 14:00 slot and in the new room from 14:30. Returns { changedAt, boundary, from, relation } (relation null when it is already there).
 */
export async function moveThing(ref, to, { at = nowSec(), slotS, timezone } = {}) {
  return await tx(async () => {
    const t = await liveThing(ref);
    const dest = await getThing(to);
    const { changedAt, boundary } = await snap(t.site_id, at, { slotS, timezone });
    const placed = await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE from_id = ? AND rel = 'located_in' AND superseded_at IS NULL
      AND COALESCE(valid_to, ${HI}) > ? ORDER BY COALESCE(valid_from, ${LO})`).all(t.id, boundary);
    const now = placed.find((r) => (r.valid_from ?? LO) <= boundary);
    if (now && now.to_id === dest.id && now.valid_to == null && placed.length === 1) return { changedAt, boundary, from: dest.id, relation: null };
    const stamp = recordedNow();
    for (const r of placed) await endRelation(r, boundary, stamp);
    assertAlive(dest, boundary);
    const id = await insertRelation({ from_id: t.id, rel: 'located_in', to_id: dest.id, valid_from: boundary, changed_at: changedAt, valid_to: dest.valid_to ?? null }, stamp);
    return { changedAt, boundary, from: now?.to_id ?? null, relation: await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ?`).get(id) };
  });
}

// ───────────── replace ─────────────
/**
 * A device is replaced (R2, thing-platform case 1): a new thing of the same type takes the old one's place in the graph from the next
 * slot boundary after `at`. The old thing is retired at that boundary, every current relation of it is cut there and written again for
 * the new thing (same ports, same other end, same window from then on), and `new replaces old` is recorded. The home's and the systems'
 * timelines run on across the swap while each device's own timeline ends or starts cleanly.
 *   attrs     the new device's own details; `inherit` lists keys to copy from the old one (nothing is guessed)
 *   uid       for a hub that made the new identity itself
 * Returns { old, thing, boundary, relations, op }.
 */
export async function replaceThing(ref, { name, attrs = {}, inherit = [], uid = null, at = nowSec(), reason, slotS, timezone } = {}) {
  return await tx(async () => {
    const old = await liveThing(ref);
    if (old.kind !== 'device') throw fail(400, `only a device is replaced (a ${old.kind} is changed, retired or split)`);
    if (!String(reason ?? '').trim()) throw fail(400, 'a replace needs a reason');
    if (await db.prepare("SELECT 1 AS x FROM thing_relation WHERE rel = 'replaces' AND to_id = ? AND superseded_at IS NULL").get(old.id)) {
      throw fail(409, `${old.name} was replaced already: replace the newer device`);
    }
    const { changedAt, boundary } = await snap(old.site_id, at, { slotS, timezone });
    if (old.valid_to != null && old.valid_to <= boundary) throw fail(409, `${old.name} was retired at ${old.valid_to}: it cannot be replaced at ${boundary}`);
    if (old.valid_from != null && boundary <= old.valid_from) throw fail(409, `${old.name} began at ${old.valid_from}: it cannot be replaced before that`);
    const stamp = recordedNow();
    const kept = Object.fromEntries(inherit.map((k) => [k, old.attrs[k]]).filter(([, v]) => v !== undefined));
    const made = await createThing({ siteId: old.site_id, type: old.type, name: name ?? `${old.name} (replacement)`, attrs: { ...kept, ...attrs }, uid, validFrom: boundary });
    const rows = (await currentRelationsOf(old.id)).filter((r) => r.rel !== 'replaces');
    const moved = await transferRelations(rows, old.id, made.id, boundary, changedAt, stamp);
    await db.prepare('UPDATE thing SET valid_to = ? WHERE id = ?').run(boundary, old.id);
    await insertRelation({ from_id: made.id, rel: 'replaces', to_id: old.id, valid_from: boundary, changed_at: changedAt }, stamp);
    const op = await logOp('replace', old, made, boundary, reason, { relations: moved.length }, stamp);
    return { old: await getThing(old.id), thing: made, boundary, relations: moved.length, op };
  });
}

// ───────────── merge ─────────────
/**
 * Two things that are one device (a Zigbee TRV that re-paired under a new id, an EV found through two integrations) become one:
 * `keep` survives, `drop` is superseded and points at it (its uid keeps resolving, `resolveThing`). Nothing is deleted.
 *   - the survivor takes the details the dropped thing had and it lacked, and the earlier start of the two
 *   - the dropped thing's current relations are written again for the survivor with their own windows; the part of a window the
 *     survivor already has the same edge for is not written twice (each kWh counted once), and a placement is not written over a place
 *     the survivor already had at the time. Both are reported, as is anything the rules refused.
 *   - rows of other tables that name the dropped thing (found through the foreign keys) move to the survivor by their table's kind
 * Returns { thing, dropped, relations: { moved, alreadyThere, overridden, refused: [...] }, tables, attrs, op }.
 */
export async function mergeThings(keepRef, dropRef, { reason } = {}) {
  return await tx(async () => {
    const keep = await liveThing(keepRef);
    const drop = await liveThing(dropRef);
    if (keep.id === drop.id) throw fail(400, 'a thing cannot be merged into itself');
    if (keep.site_id !== drop.site_id || keep.kind !== drop.kind) throw fail(400, 'only two things of one home and kind are merged');
    if (!String(reason ?? '').trim()) throw fail(400, 'a merge needs a reason');
    // One type: a hub's unknown device (generic_device) gives way to the type the other one has.
    let type = keep.type;
    if (keep.type !== drop.type) {
      if (drop.type === 'generic_device') type = keep.type;
      else if (keep.type === 'generic_device') type = drop.type;
      else throw fail(400, `${keep.name} is a ${keep.type} and ${drop.name} a ${drop.type}: only things of one type are merged`);
    }
    const stamp = recordedNow();
    if (type !== keep.type) await changeType(keep.id, type);
    const ty = await typeRow(type);
    const gained = {};
    for (const [k, v] of Object.entries(drop.attrs)) if (!(k in keep.attrs) && ty.attribute_keys.includes(k)) gained[k] = v;
    const from = keep.valid_from == null || drop.valid_from == null ? (keep.valid_from ?? drop.valid_from) : Math.min(keep.valid_from, drop.valid_from);
    const to = keep.valid_to == null || drop.valid_to == null ? null : Math.max(keep.valid_to, drop.valid_to);
    await db.prepare('UPDATE thing SET attrs = ?::jsonb, valid_from = ?, valid_to = ? WHERE id = ?').run(JSON.stringify({ ...keep.attrs, ...gained }), from, to, keep.id);

    // Relations. The dropped thing's rows are superseded first, so its edges do not count in the checks on what is written for the survivor.
    const rows = await currentRelationsOf(drop.id);
    for (const r of rows) await supersedeRelation(r.id, stamp);
    const report = { moved: 0, alreadyThere: 0, overridden: 0, between: 0, refused: [] };
    for (const r of rows) {
      const a = r.from_id === drop.id ? keep.id : r.from_id;
      const b = r.to_id === drop.id ? keep.id : r.to_id;
      if (a === b) { report.between++; continue; }   // an edge between the two things themselves: it has no meaning on one thing
      const same = (await db.prepare(`SELECT valid_from, valid_to FROM thing_relation WHERE from_id = ? AND to_id = ? AND rel = ? AND superseded_at IS NULL
        AND from_port IS NOT DISTINCT FROM ? AND to_port IS NOT DISTINCT FROM ?`).all(a, b, r.rel, r.from_port, r.to_port)).map((x) => [x.valid_from, x.valid_to]);
      let pieces = subtractWindows([r.valid_from, r.valid_to], same);
      if (pieces.length !== 1 || pieces[0][0] !== r.valid_from || pieces[0][1] !== r.valid_to) report.alreadyThere++;
      if (r.rel === 'located_in' && r.from_id === drop.id) {
        const elsewhere = (await db.prepare("SELECT valid_from, valid_to FROM thing_relation WHERE from_id = ? AND rel = 'located_in' AND superseded_at IS NULL").all(keep.id)).map((x) => [x.valid_from, x.valid_to]);
        const left = pieces.flatMap((p) => subtractWindows(p, elsewhere));
        if (JSON.stringify(left) !== JSON.stringify(pieces)) report.overridden++;
        pieces = left;
      }
      for (const [vf, vt] of pieces) {
        const out = await attempt(() => insertRelation({ ...r, from_id: a, to_id: b, valid_from: vf, valid_to: vt }, stamp));
        if (out.ok) report.moved++;
        else report.refused.push({ relation: r.id, rel: r.rel, message: out.error.message });
      }
    }

    // Other tables that name the dropped thing.
    const tables = {};
    for (const ref of await thingReferences()) {
      const key = `${ref.table}.${ref.column}`;
      if (HISTORY_KINDS.has(ref.kind)) {
        tables[key] = { kept: Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${q(ref.table)} WHERE ${q(ref.column)} = ?`).get(drop.id)).n), why: `${ref.kind}: history stays on the thing it was written for` };
        continue;
      }
      const out = await attempt(() => moveRows(ref, drop.id, keep.id, stamp));
      tables[key] = out.ok ? { moved: out.value } : { refused: out.error.message };
    }

    await db.prepare('UPDATE thing SET superseded_at = GREATEST(?::bigint, recorded_at), merged_into = ? WHERE id = ?').run(stamp, keep.id, drop.id);
    const op = await logOp('merge', drop, keep, null, reason, { relations: report, tables, attrs: Object.keys(gained) }, stamp);
    return { thing: await getThing(keep.id), dropped: await getThing(drop.id), relations: report, tables, attrs: Object.keys(gained), op };
  });
}

// ───────────── split ─────────────
/**
 * One thing was two (discovery joined two devices): a new thing of the same kind is made and takes what belongs to it. The caller names
 * what moves: `relations` (ids of current relations of the thing) and `rows` ({ table: [ids] } of other tables that name the thing; a
 * log, fact, registry or secret table is history and is refused). With `at` a relation that straddles the next slot boundary is cut
 * there (before stays, after moves), and the new thing begins at the boundary; without it a named relation moves whole.
 * The thing as known before the split stays readable: the moved rows are superseded, not erased. Returns { thing, from, boundary, moved, op }.
 */
export async function splitThing(ref, { name, type = null, attrs = null, uid = null, relations = [], rows = {}, at = null, reason, slotS, timezone } = {}) {
  return await tx(async () => {
    const src = await liveThing(ref);
    if (!String(reason ?? '').trim()) throw fail(400, 'a split needs a reason');
    const snapped = at == null ? null : await snap(src.site_id, at, { slotS, timezone });
    const boundary = snapped?.boundary ?? null;
    const theirs = await currentRelationsOf(src.id);
    const chosen = relations.map((id) => {
      const r = theirs.find((x) => x.id === Number(id));
      if (!r) throw fail(400, `relation ${id} is not a current relation of ${src.name}`);
      return r;
    });
    const refs = await thingReferences();
    for (const t of Object.keys(rows)) {
      const found = refs.filter((r) => r.table === t);
      if (!found.length) throw fail(400, `table ${t} has no foreign key to thing`);
      if (HISTORY_KINDS.has(found[0].kind)) throw fail(400, `table ${t} is a ${found[0].kind}: history stays on the thing it was written for`);
    }
    const stamp = recordedNow();
    const ty = await typeRow(type ?? src.type);
    if (ty.kind !== src.kind) throw fail(400, `a ${src.kind} cannot be split into a ${ty.kind}`);
    const made = await createThing({ siteId: src.site_id, type: ty.type, name: name ?? `${src.name} (split)`, attrs: attrs ?? src.attrs, uid, validFrom: boundary });
    const moved = await transferRelations(chosen, src.id, made.id, boundary, snapped?.changedAt ?? null, stamp);
    const tables = {};
    for (const [t, ids] of Object.entries(rows)) {
      tables[t] = 0;
      for (const ref of refs.filter((r) => r.table === t)) tables[t] += await moveRows(ref, src.id, made.id, stamp, ids);
    }
    const op = await logOp('split', src, made, boundary, reason, { relations: moved.length, tables }, stamp);
    return { thing: made, from: await getThing(src.id), boundary, moved: { relations: moved.length, tables }, op };
  });
}

// ───────────── reading: as known at a moment ─────────────
// `at` is a valid-time instant (seconds, default now; null reads every window). `known` is a record-time instant (ms): the graph as
// it was recorded then; null is what is known now (superseded rows are left out).
function visible(alias, { at, known }) {
  const parts = []; const params = [];
  if (at != null) { parts.push(`COALESCE(${alias}.valid_from, ${LO}) <= ? AND COALESCE(${alias}.valid_to, ${HI}) > ?`); params.push(at, at); }
  if (known == null) parts.push(`${alias}.superseded_at IS NULL`);
  else { parts.push(`${alias}.recorded_at <= ? AND (${alias}.superseded_at IS NULL OR ${alias}.superseded_at > ?)`); params.push(known, known); }
  return { sql: parts.join(' AND '), params };
}
const when = (o = {}) => ({ at: o.at === undefined ? nowSec() : o.at, known: o.known ?? null });

// A thing's name, attributes and span of life as they were known at `known` (the versions, not the thing row).
async function knownAs(rows, known) {
  if (known == null || !rows.length) return rows;
  const v = await db.prepare(`SELECT thing_id, name, attrs, life_from, life_to FROM thing_attr_version WHERE thing_id::text IN (SELECT jsonb_array_elements_text(?::jsonb))
    AND recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)`).all(inList(rows.map((r) => r.id)), known, known);
  const by = new Map(v.map((x) => [x.thing_id, x]));
  return rows.map((r) => (by.has(r.id) ? { ...r, name: by.get(r.id).name, attrs: by.get(r.id).attrs, valid_from: by.get(r.id).life_from, valid_to: by.get(r.id).life_to } : r));
}

/** The thing as it was known at `known` (ms; null = now): name, attributes and life of that moment; null when it was not recorded yet. */
export async function thingAsKnown(ref, { known = null } = {}) {
  const t = await getThing(ref);
  if (known == null) return t;
  if (t.recorded_at > known) return null;
  return (await knownAs([t], known))[0];
}

/** The things of a home that were in service at `at` as known at `known`; optional filters kind, type. */
export async function thingsOf(siteId, { kind = null, type = null, ...o } = {}) {
  const { at, known } = when(o);
  const rec = known == null ? 't.superseded_at IS NULL' : 't.recorded_at <= ? AND (t.superseded_at IS NULL OR t.superseded_at > ?)';
  const rows = await db.prepare(`SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')} FROM thing t WHERE t.site_id = ? AND ${rec}
    AND (?::text IS NULL OR t.kind = ?) AND (?::text IS NULL OR t.type = ?) ORDER BY t.kind, t.type, t.name, t.id`)
    .all(siteId, ...(known == null ? [] : [known, known]), kind, kind, type, type);
  // the span of life is read from the versions as known, so a retirement made after `known` is not seen
  return (await knownAs(rows, known)).filter((t) => (at == null || ((t.valid_from ?? LO) <= at && (t.valid_to ?? HI) > at)));
}

/** The relations that hold at `at` as known at `known`, with the uid and name of both ends. Filters: rels (a list), thing (either end). */
export async function relationsAt(siteId, { rels = null, thing = null, ...o } = {}) {
  const { at, known } = when(o);
  const v = visible('r', { at, known });
  const id = thing == null ? null : (await getThing(thing)).id;
  return await db.prepare(`SELECT r.id, r.site_id, r.from_id, f.uid AS from_uid, r.from_port, r.rel, r.to_id, t.uid AS to_uid, r.to_port, r.required, r.valid_from, r.valid_to, r.changed_at, r.recorded_at, r.superseded_at
      FROM thing_relation r JOIN thing f ON f.id = r.from_id JOIN thing t ON t.id = r.to_id
      WHERE r.site_id IS NOT DISTINCT FROM ?::bigint AND ${v.sql} AND (?::jsonb IS NULL OR r.rel IN (SELECT jsonb_array_elements_text(?::jsonb)))
        AND (?::bigint IS NULL OR r.from_id = ? OR r.to_id = ?)
      ORDER BY r.rel, r.id`).all(siteId, ...v.params, rels && JSON.stringify(rels), rels && JSON.stringify(rels), id, id, id);
}

/**
 * Everything inside a thing by `rel` (default located_in): a nested tree { ...thing, depth, children }, as it held at `at` and was known at
 * `known`. A thing is in one place at a time, so at one instant it is a tree; a loop in other data is cut at the second visit.
 */
export async function tree(ref, { rel = 'located_in', maxDepth = 20, ...o } = {}) {
  const { at, known } = when(o);
  const root = await resolveThing(ref);
  const v = visible('e', { at, known });
  const nodes = await db.prepare(`WITH RECURSIVE down(id, parent, depth, path) AS (
      SELECT ?::bigint, NULL::bigint, 0, ARRAY[?::bigint]
      UNION ALL
      SELECT e.from_id, d.id, d.depth + 1, d.path || e.from_id FROM down d JOIN thing_relation e ON e.to_id = d.id
       WHERE e.rel = ? AND ${v.sql} AND NOT e.from_id = ANY(d.path) AND d.depth < ?
    ) SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')}, d.parent, d.depth FROM down d JOIN thing t ON t.id = d.id ORDER BY d.depth, t.name, t.id`).all(root.id, root.id, rel, ...v.params, maxDepth);
  const named = await knownAs(nodes, known);
  const byId = new Map(named.map((n) => [n.id, { ...n, children: [] }]));
  for (const n of byId.values()) if (n.parent != null) byId.get(n.parent)?.children.push(n);
  return byId.get(root.id);
}

/** Where a thing is, from its own place up: [thing, room, floor, home] (the chain of `rel`, default located_in) at `at` as known at `known`. */
export async function placeChain(ref, { rel = 'located_in', maxDepth = 20, ...o } = {}) {
  const { at, known } = when(o);
  const start = await resolveThing(ref);
  const v = visible('e', { at, known });
  const rows = await db.prepare(`WITH RECURSIVE up(id, depth, path) AS (
      SELECT ?::bigint, 0, ARRAY[?::bigint]
      UNION ALL
      SELECT e.to_id, u.depth + 1, u.path || e.to_id FROM up u JOIN thing_relation e ON e.from_id = u.id
       WHERE e.rel = ? AND ${v.sql} AND NOT e.to_id = ANY(u.path) AND u.depth < ?
    ) SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')}, u.depth FROM up u JOIN thing t ON t.id = u.id ORDER BY u.depth`).all(start.id, start.id, rel, ...v.params, maxDepth);
  return await knownAs(rows, known);
}

/**
 * What can be reached from a thing along `rel` (default feeds): direction 'out' follows the relation from its from side to its to side
 * (downstream in the energy graph), 'in' the other way (upstream). Each thing once, at its shortest distance. A flow network has loops
 * (a battery and its inverter feed each other through different ports), so the walk stops at things already on its path.
 */
export async function reach(ref, { rel = 'feeds', direction = 'out', maxDepth = 50, ...o } = {}) {
  if (!['out', 'in'].includes(direction)) throw new RangeError("direction is 'out' or 'in'");
  const { at, known } = when(o);
  const start = await resolveThing(ref);
  const v = visible('e', { at, known });
  const [near, far] = direction === 'out' ? ['from_id', 'to_id'] : ['to_id', 'from_id'];
  const rows = await db.prepare(`WITH RECURSIVE walk(id, depth, path) AS (
      SELECT ?::bigint, 0, ARRAY[?::bigint]
      UNION ALL
      SELECT e.${far}, w.depth + 1, w.path || e.${far} FROM walk w JOIN thing_relation e ON e.${near} = w.id
       WHERE e.rel = ? AND ${v.sql} AND NOT e.${far} = ANY(w.path) AND w.depth < ?
    ) SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')}, MIN(w.depth) AS depth FROM walk w JOIN thing t ON t.id = w.id
      WHERE w.depth > 0 GROUP BY t.id ORDER BY MIN(w.depth), t.name, t.id`).all(start.id, start.id, rel, ...v.params, maxDepth);
  return await knownAs(rows, known);
}

/**
 * The graph of a home at `at` as known at `known`: { nodes, edges }. Shared context things the edges reach are nodes too; an edge whose end
 * is not a node at that time is left out (`relationsAt` lists it).
 */
export async function graph(siteId, { rels = null, ...o } = {}) {
  const { at, known } = when(o);
  const found = await relationsAt(siteId, { rels, at, known });
  const nodes = await thingsOf(siteId, { at, known });
  const have = new Set(nodes.map((n) => n.id));
  const extra = [...new Set(found.flatMap((e) => [e.from_id, e.to_id]))].filter((id) => !have.has(id));
  if (extra.length) {
    const ctx = await db.prepare(`SELECT ${THING_COLS} FROM thing WHERE site_id IS NULL AND id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY id`).all(inList(extra));
    nodes.push(...await knownAs(ctx, known));
    for (const c of ctx) have.add(c.id);
  }
  // An edge to a thing that is not in the graph at that time (a `replaces` that outlives the thing it replaced) is a relation, not a graph edge.
  return { nodes, edges: found.filter((e) => nodes.some((n) => n.id === e.from_id) && nodes.some((n) => n.id === e.to_id)) };
}

/**
 * Everything recorded about a thing and the things merged into it (one timeline): attribute versions, every relation row ever written
 * (superseded ones included), and the operations (replace, merge, split) that touched it.
 */
export async function thingHistory(ref) {
  const t = await resolveThing(ref);
  const family = (await db.prepare(`WITH RECURSIVE fam(id) AS (SELECT ?::bigint UNION SELECT x.id FROM thing x JOIN fam f ON x.merged_into = f.id) SELECT id FROM fam`).all(t.id)).map((r) => r.id);
  const ids = inList(family);
  return {
    thing: t,
    family,
    versions: await db.prepare('SELECT thing_id, name, attrs, valid_from, recorded_at, superseded_at FROM thing_attr_version WHERE thing_id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY recorded_at, id').all(ids),
    relations: await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE from_id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) OR to_id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY recorded_at, id`).all(ids, ids),
    ops: await db.prepare('SELECT id, op, thing_id, other_id, effective_at, reason, detail, recorded_at FROM thing_op WHERE thing_id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) OR other_id::text IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY recorded_at, id').all(ids, ids),
  };
}
