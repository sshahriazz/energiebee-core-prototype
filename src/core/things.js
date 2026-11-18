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
// effect at the next slot boundary of the home (R13): `changed_at` keeps the exact moment, `valid_from` and a chosen `valid_to`
// are boundaries. The boundary comes from the home's slot length and time zone (an explicit option, else the site row, the home thing's detail row: `homeClock`). A relation is never edited in place: the
// old row is superseded and the corrected one is written, so "as known at" any earlier moment still shows what was known (the
// pattern of site_group_member; the database enforces it, thing_relation_append_only).
//
// One operation, one home, one moment. Every operation that writes takes a lock on its home (`begin`), so two callers on one home
// run one after the other and the second reads what the first wrote; and it names one record time for everything it writes (the
// rows and, through the setting thing.record_ms, the attribute versions the triggers write), so a replace or a merge is a single
// point in record time and an "as known" read never sees half of it.
//
// A thing never changes kind, type or home (a database rule). What was a generic device and turns out to be a thermostat is merged
// into a thermostat thing; its uid keeps resolving.
//
// Moving what points at a thing (merge, split) is found from the schema: every foreign key to thing(id) is discovered, so a
// table added later (points, links) is covered without a change here. What a table's kind (src/db/table-kinds.js) says
// decides how its rows move: versioned configuration is superseded and written again, registries, working state and secrets are
// updated, and only the append-only kinds, facts and logs, stay on the thing they were written for (a reader of such a table
// follows merged_into: resolveThing, or thingHistory for the whole family). A row that cannot move (a rule or a unique key
// refuses it) stops the merge. A foreign key that is not a single column to thing(id) is not understood and stops it too.
//
// Who may change what. Every write takes the home it is for (`siteId`, null for shared context) and refuses a thing of another home
// with the same 404 a read gives, so a route that forgets its own check cannot reach into another home.
//
// Errors. A rule the database refuses (a duplicate, an overlap, a cycle, a missing port) comes out with a status, 409 for a conflict
// with what exists and 400 for a value that is not acceptable, so a route answers with it instead of a 500. An operation that is
// called inside a transaction of the caller runs in a savepoint: it fails whole, the caller's earlier work stays.
import { db, tx, inTx, columnsOf } from '../db/db.js';
import { TABLE_KINDS } from '../db/table-kinds.js';
import { THING_ONLY_KEYS } from '../db/seed/things.js';
import { SLOT, SLOT_LENGTHS, dayBounds, localDate, nowSec, recordedNow, slotLength } from './time.js';
import { attributeDef } from './attributes.js';
import { checkValue } from './value-check.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LO = -9_000_000_000;   // the same stand-ins for "no start" and "no end" as the exclusion constraints use
const HI = 9_000_000_000;
const THING_COLS = 'id, uid, home_id, kind, type, name, attrs, std_ref, valid_from, valid_to, recorded_at, superseded_at, merged_into';
const REL_COLS = 'id, uid, home_id, from_id, from_port, rel, to_id, to_port, required, valid_from, valid_to, changed_at, recorded_at, superseded_at';
const bad = (message) => Object.assign(new RangeError(message), { status: 400 });
// Ids as one parameter for `col = ANY(?::bigint[])` (an index can be used, unlike a cast of the column).
const idArray = (ids) => `{${ids.map((i) => { if (!Number.isSafeInteger(Number(i))) throw bad(`not an id: ${i}`); return Number(i); }).join(',')}}`;
// Valid time is seconds and record time milliseconds: a value of the other unit is refused instead of read as a far-off date.
const SEC_LIMIT = 1e11;
const sec = (v, what) => { if (!Number.isFinite(v) || v < 0 || v >= SEC_LIMIT) throw bad(`${what} is in seconds (got ${v})`); return v; };
const ms = (v, what) => { if (!Number.isFinite(v) || v < SEC_LIMIT || v >= 1e14) throw bad(`${what} is in milliseconds (got ${v})`); return v; };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const flag = (v, what) => { if (v === 1 || v === true) return 1; if (v === 0 || v === false) return 0; throw bad(`${what} is 0 or 1 (got ${JSON.stringify(v)})`); };

// ───────────── identity ─────────────
function refKey(ref) {
  const id = ref && typeof ref === 'object' && 'id' in ref ? Number(ref.id) : ref;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return { id };
  if (typeof id === 'string' && UUID.test(id)) return { uid: id.toLowerCase() };
  throw bad(`not a thing reference: ${JSON.stringify(ref)} (an id, a uid, or a row with an id)`);
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
  if (!SLOT_LENGTHS.includes(slotS)) throw bad(`slot length ${slotS}: one of ${SLOT_LENGTHS.join(', ')}`);
  if (!Number.isFinite(ts)) throw bad(`not a time: ${ts}`);
  const t = Math.floor(ts);
  const day = localDate(timezone, t);
  const [a, b0] = dayBounds(timezone, day);
  let b = b0;
  // Where the clocks jump at local midnight (Cuba, Chile) time.js ends the day an hour early and the last hour falls outside it: the
  // day really ends when the local date changes (zone offsets are whole quarter hours, so look at quarter hours).
  if (b <= t) { b = Math.ceil((t + 1) / 900) * 900; while (localDate(timezone, b) === day) b += 900; }
  return Math.min(a + Math.ceil((t - a) / slotS) * slotS, b);   // a day whose length is not a whole number of slots ends on its own midnight
}

/**
 * A home's slot length and time zone: the site row, the detail row of the home thing (the same id). A home thing that names
 * either in its attributes must name the site's (thing_home_clock).
 */
export async function homeClock(siteId) {
  if (siteId == null) return { slotS: SLOT, timezone: 'UTC' };
  const site = await db.prepare('SELECT slot_s, timezone FROM site WHERE id = ?').get(siteId);
  return { slotS: slotLength(site), timezone: site?.timezone ?? 'UTC' };
}

// The snapped time of a change at `at` in a home: { changedAt, boundary, grid }. The grid is the home's own: the database checks every
// relation of the home against the same grid, so a caller cannot choose another one.
async function snap(siteId, at) {
  const grid = await homeClock(siteId);
  const changedAt = Math.floor(sec(at ?? nowSec(), 'at'));
  return { changedAt, boundary: nextSlotBoundary(changedAt, grid), grid };
}

// ───────────── one operation: one home, one moment ─────────────
// Takes the home's lock for the rest of the transaction and fixes the record time of everything the operation writes. A context
// thing (no home) has the lock of key 0.
async function begin(siteId) {
  await db.prepare('SELECT 1 AS x FROM (SELECT pg_advisory_xact_lock(hashtext(?), ?::int)) l').get('eb_thing_home', siteId ?? 0);
  const stamp = recordedNow();
  await db.prepare("SELECT set_config('thing.record_ms', ?, true) AS v").get(String(stamp));
  return stamp;
}
// The home of a thing, read before the lock (a thing's home never changes).
async function siteOf(ref) {
  const k = refKey(ref);
  const row = k.id != null ? await db.prepare('SELECT home_id FROM thing WHERE id = ?').get(k.id) : await db.prepare('SELECT home_id FROM thing WHERE uid = ?::uuid').get(k.uid);
  if (!row) throw fail(404, `no thing ${k.id ?? k.uid}`);
  return row.home_id;
}
// The home a write is for: required (null is shared context), and the thing must be in it. A thing of another home is "not found".
function homeArg(siteId) {
  if (siteId === undefined) throw bad('give siteId: a change stays inside one home (null for shared context)');
  if (siteId !== null && !(Number.isSafeInteger(Number(siteId)) && Number(siteId) > 0)) throw bad(`not a home: ${siteId}`);
  return siteId === null ? null : Number(siteId);
}
const inside = (t, s) => { if (t.home_id !== s) throw fail(404, `no thing ${t.id} in ${s == null ? 'shared context' : `home ${s}`}`); return t; };
async function homeOf(ref, siteId) {
  const s = homeArg(siteId);
  inside({ id: refKey(ref).id ?? refKey(ref).uid, home_id: await siteOf(ref) }, s);
  return s;
}

// What the database refuses on a thing table is a conflict (a duplicate, an overlap, a cycle, a rule) or a value it cannot take.
function withStatus(err) {
  if (err == null || err.status != null || !err.code) return err;
  const code = String(err.code);
  if (['23P01', '23505', '23503', 'P0001'].includes(code)) err.status = 409;
  else if (code === '23514' || code.startsWith('22')) err.status = 400;
  return err;
}
// One operation: a transaction of its own, or a savepoint inside the caller's, so it fails whole either way.
let savepoints = 0;
async function operation(fn) {
  try {
    if (!inTx()) return await tx(fn);
    const sp = `thing_op_${++savepoints}`;
    await db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = await fn();
      await db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (err) {
      await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      await db.exec(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  } catch (err) { throw withStatus(err); }
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
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) throw bad('attrs must be an object');
  const allowed = type.attribute_keys;
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!allowed.includes(key)) throw bad(`attribute ${key} is not carried by type ${type.type}`);
    const def = await attributeDef(key);
    let v;
    if (def) v = checkValue(def, value, `attribute ${key}`);
    else if (THING_ONLY_KEYS.includes(key)) {
      v = value === '' ? null : value;
      if (v != null) {
        const why = THING_KEY_CHECKS[key]?.(v) ?? (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? null : 'a text, number or yes/no');
        if (why) throw bad(`attribute ${key}: must be ${why} (got ${JSON.stringify(value)})`);
      }
    } else throw bad(`attribute ${key} has no definition (attribute_def)`);
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

// The part of the window `win` of relation `r` (re-aimed from `a` to `b`) that is not yet held by the same edge (same relation and
// ports): what is written for a thing that already has some of it, so nothing is counted twice.
async function uncovered(a, b, r, win) {
  const same = (await db.prepare(`SELECT valid_from, valid_to FROM thing_relation WHERE from_id = ? AND to_id = ? AND rel = ? AND superseded_at IS NULL
    AND from_port IS NOT DISTINCT FROM ? AND to_port IS NOT DISTINCT FROM ?`).all(a, b, r.rel, r.from_port, r.to_port)).map((x) => [x.valid_from, x.valid_to]);
  return subtractWindows(win, same);
}

// The end of a relation handed from one thing to another. A relation that stopped only because the old thing's own service ends there
// (it was scheduled to retire, or it is the thing a merge drops) does not stop when the thing that takes it over carries on: it ends
// where the new thing or the thing at its other end ends, or is open.
async function handedEnd(r, fromThing, toThing, otherId, newEnd = toThing.valid_to) {
  if (fromThing.valid_to == null || r.valid_to !== fromThing.valid_to) return r.valid_to;
  const other = await db.prepare('SELECT valid_to FROM thing WHERE id = ?').get(otherId);
  const ends = [newEnd, other?.valid_to].filter((x) => x != null);
  return ends.length ? Math.min(...ends) : null;
}

// Hand some of a thing's current relations to another thing from a boundary on (replace, split). A relation that straddles the
// boundary is cut there: the part before stays, the part from the boundary on moves. One that starts later moves whole. One that
// ended before stays. With boundary null every given relation moves whole, from its own start. What the other thing already has
// (the same edge in the same window) is not written twice. A refusal by the rules stops the whole operation.
async function transferRelations(rows, fromThing, toThing, boundary, changedAt, stamp) {
  const moved = [];
  const [fromId, toId] = [fromThing.id, toThing.id];
  const swap = (x) => (x === fromId ? toId : x);
  for (const r of rows) {
    if (boundary != null && r.valid_to != null && r.valid_to <= boundary) continue;
    const cut = boundary != null && (r.valid_from == null || r.valid_from < boundary);
    await supersedeRelation(r.id, stamp);
    if (cut) await insertRelation({ ...r, valid_to: boundary }, stamp);
    const [a, b] = [swap(r.from_id), swap(r.to_id)];
    const end = await handedEnd(r, fromThing, toThing, r.from_id === fromId ? r.to_id : r.from_id);
    for (const [vf, vt] of await uncovered(a, b, r, [cut ? boundary : r.valid_from, end])) {
      moved.push(await insertRelation({ ...r, from_id: a, to_id: b, valid_from: vf, valid_to: vt, changed_at: cut ? changedAt : r.changed_at }, stamp));
    }
  }
  return moved;
}

// ───────────── what points at a thing ─────────────
// Tables the library handles itself.
const OWN_TABLES = new Set(['thing', 'thing_attr_version', 'thing_relation', 'thing_op']);

/**
 * Every foreign key to thing outside the thing tables: [{ table, column, kind }]. Read from pg_constraint, which (unlike
 * information_schema) lists a key whatever its owner. Only the plain shape is understood: one column that points at thing(id). A key
 * on two columns, or one that points at thing(uid), would be skipped by a merge and leave rows on the dropped thing without a word, so
 * it is an error here: the merge and the split stop until the library learns that shape.
 */
export async function thingReferences() {
  const rows = await db.prepare(`SELECT cl.relname AS child, c.conname AS name, cardinality(c.conkey) AS width, a.attname AS col,
        c.confkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'thing'::regclass AND attname = 'id') AS to_id
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'thing'::regclass AND cl.relnamespace = current_schema()::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisprimary AND i.indnkeyatts = 1 AND i.indkey[0] = c.conkey[1])
     ORDER BY 1, 4`).all();
  const found = rows.filter((r) => !OWN_TABLES.has(r.child));
  const odd = found.find((r) => Number(r.width) !== 1 || !r.to_id);
  if (odd) throw new Error(`${odd.child} (${odd.name}) points at thing in a way merge and split do not understand: use one column that references thing(id)`);
  return found.map((r) => ({ table: r.child, column: r.col, kind: TABLE_KINDS[r.child] ?? 'runtime' }));
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
// Append-only: their rows are never updated, so they stay on the thing they were written for.
const HISTORY_KINDS = new Set(['log', 'fact']);

// Point rows of one table that name `from` at `to`: all of them, or only the ids given. Versioned configuration (valid and record
// time) is superseded and written again, so the earlier knowledge stays; anything else is updated. Returns the rows moved.
async function moveRows(ref, from, to, stamp, ids = null) {
  const cols = await columnsOf(ref.table);
  const pick = ids ? ' AND id = ANY(?::bigint[])' : '';
  const extra = ids ? [idArray(ids)] : [];
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
  return Number((await db.prepare('INSERT INTO thing_op (home_id, op, thing_id, other_id, effective_at, reason, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?)')
    .run(thing.home_id, op, thing.id, other.id, effectiveAt, String(reason).trim(), JSON.stringify(detail), stamp)).lastInsertRowid);
}

// ───────────── create, change, retire ─────────────
/**
 * A new thing. `type` decides the kind; a context thing (a tariff, a region) has no site, every other kind needs one (and the home
 * needs its home thing first). `attrs` is checked against the type's keys and the attribute registry. `uid` (a UUIDv7) is for a hub
 * that made the identity itself.
 */
export async function createThing(o) {
  return await operation(async () => {
    const stamp = await begin(o.siteId ?? null);
    return await makeThing(o, stamp);
  });
}

async function makeThing({ siteId = null, type, name, attrs = {}, uid = null, validFrom = null, stdRef = null }, stamp) {
  const ty = await typeRow(type);
  if (ty.kind === 'home') throw fail(400, 'a home thing is made with its site (createSite)');
  if (ty.kind === 'context' && siteId != null) throw fail(400, `a ${type} is shared context: it has no home`);
  if (ty.kind !== 'context' && siteId == null) throw fail(400, `a ${type} belongs to a home: give siteId`);
  if (uid != null && !(typeof uid === 'string' && UUID_V7.test(uid))) throw bad(`uid ${uid} is not a UUIDv7`);
  if (typeof name !== 'string' || !name.trim()) throw bad('a thing needs a name (text)');
  if (name.includes('\u0000')) throw bad('a name cannot hold a NUL character');
  if (validFrom != null) sec(validFrom, 'validFrom');
  const clean = await checkAttrs(ty, attrs);
  const id = Number((await db.prepare('INSERT INTO thing (uid, home_id, kind, type, name, attrs, std_ref, valid_from, recorded_at) VALUES (COALESCE(?::uuid, uuidv7()), ?, ?, ?, ?, ?::jsonb, ?, ?, ?)')
    .run(uid, siteId, ty.kind, type, name.trim(), JSON.stringify(clean), stdRef, validFrom, stamp)).lastInsertRowid);
  const made = await getThing(id);
  // A device thing has its device row (provider 'thing': the library made it); the row takes the thing's id and uid (device_make_thing adopts them).
  if (ty.kind === 'device') {
    await db.prepare("INSERT INTO device (id, site_id, kind, provider, external_ref, label, uid, recorded_at) VALUES (?, ?, ?, 'thing', ?, ?, ?::uuid, ?)")
      .run(id, siteId, type, made.uid, made.name, made.uid, stamp);
  }
  return made;
}

/** Rename a thing and/or change attributes: `attrs` is a patch (a key set to null is removed). One change is one version. */
export async function updateThing(ref, { siteId, name, attrs } = {}) {
  return await operation(async () => {
    await begin(await homeOf(ref, siteId));
    const t = await liveThing(ref);
    const ty = await typeRow(t.type);
    const next = attrs ? await checkAttrs(ty, { ...t.attrs, ...attrs }) : t.attrs;
    if (name != null && typeof name !== 'string') throw bad('a name is text');
    const nextName = name == null ? t.name : name.trim();
    if (!nextName) throw bad('a thing needs a name');
    if (nextName.includes('\u0000')) throw bad('a name cannot hold a NUL character');
    if (nextName !== t.name || JSON.stringify(sortKeys(next)) !== JSON.stringify(sortKeys(t.attrs))) {
      // The thing first (one change, one version); the detail row then finds its thing already named so (device_sync_thing writes nothing).
      await db.prepare('UPDATE thing SET name = ?, attrs = ?::jsonb WHERE id = ?').run(nextName, JSON.stringify(next), t.id);
      if (nextName !== t.name && t.kind === 'home') await db.prepare('UPDATE site SET name = ? WHERE id = ?').run(nextName, t.id);
      if (nextName !== t.name && await isDeviceRow(t.id)) await db.prepare('UPDATE device SET label = ? WHERE id = ?').run(nextName, t.id);
    }
    return await getThing(t.id);
  });
}
const isDeviceRow = async (id) => Boolean(await db.prepare('SELECT 1 FROM device WHERE id = ?').get(id));
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * The thing leaves service at the next slot boundary after `at`. Its relations end there. A space or system that still holds
 * things is not retired: move them first.
 */
export async function retireThing(ref, { siteId, at = nowSec() } = {}) {
  return await operation(async () => {
    const stamp = await begin(await homeOf(ref, siteId));
    const t = await liveThing(ref);
    const { changedAt, boundary } = await snap(t.home_id, at);
    if (t.valid_to != null && t.valid_to <= boundary) throw fail(409, `${t.name} was retired already (at ${t.valid_to})`);
    if (t.valid_from != null && boundary <= t.valid_from) throw fail(409, `${t.name} began at ${t.valid_from}: it cannot be retired before it began`);
    const holds = await db.prepare(`SELECT f.name FROM thing_relation r JOIN thing f ON f.id = r.from_id
      WHERE r.to_id = ? AND r.rel IN ('located_in', 'part_of') AND r.superseded_at IS NULL AND COALESCE(r.valid_to, ${HI}) > ? AND f.valid_to IS NULL ORDER BY f.name`).all(t.id, boundary);
    if (holds.length) throw fail(409, `${t.name} still holds ${holds.map((h) => h.name).join(', ')}: move them first`);
    const current = await currentRelationsOf(t.id);
    // a date before everything the thing was ever put in would cancel all of it: that is a typo, not a retirement
    if (current.length && current.every((r) => r.valid_from != null && r.valid_from >= boundary)) {
      throw fail(409, `retiring ${t.name} at ${boundary} would cancel every relation it has (the first starts at ${Math.min(...current.map((r) => r.valid_from))}): give a later time`);
    }
    const ended = [];
    for (const r of current) {
      const what = await endRelation(r, boundary, stamp);
      if (what !== 'unchanged') ended.push({ id: r.id, rel: r.rel, what });
    }
    await db.prepare('UPDATE thing SET valid_to = ? WHERE id = ?').run(boundary, t.id);
    if (await isDeviceRow(t.id)) await db.prepare('UPDATE device SET retired_at = ? WHERE id = ? AND retired_at IS NULL').run(boundary * 1000, t.id);
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
 * `at`; the exact moment is kept as changed_at. `validTo` ends it, at the next slot boundary at or after it (the database refuses an
 * end or a start that is off the home's grid, trg_thing_relation_checks); left open it ends where a retired thing's service ends.
 * Returns the relation row.
 */
export async function relate({ siteId, from, rel, to, fromPort = null, toPort = null, at = nowSec(), validTo = null, required = 1 }) {
  return await operation(async () => {
    const req = flag(required, 'required');
    const home = homeArg(siteId);
    const stamp = await begin((await siteOf(from)) ?? (await siteOf(to)));
    const a = await getThing(from);
    const b = await getThing(to);
    for (const t of [a, b]) if (t.home_id != null) inside(t, home);   // (shared context may join a home's things)
    if (home == null && (a.home_id != null || b.home_id != null)) throw fail(404, 'no such relation in shared context');
    const { changedAt, boundary, grid } = await snap(a.home_id ?? b.home_id, at);
    assertAlive(a, boundary);
    assertAlive(b, boundary);
    const chosen = validTo == null ? null : nextSlotBoundary(sec(validTo, 'validTo'), grid);
    if (chosen != null && chosen <= boundary) throw bad(`validTo (${chosen}) must be after the start of the relation (${boundary})`);
    if (chosen != null && [a.valid_to, b.valid_to].some((e) => e != null && e < chosen)) throw fail(409, 'a relation cannot outlast a thing it joins');
    const ends = [chosen, a.valid_to, b.valid_to].filter((x) => x != null);
    const end = ends.length ? Math.min(...ends) : null;
    const id = await insertRelation({ from_id: a.id, from_port: fromPort, rel, to_id: b.id, to_port: toPort, required: req, valid_from: boundary, valid_to: end, changed_at: changedAt }, stamp);
    return await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ?`).get(id);
  });
}

/** A relation stops holding at the next slot boundary after `at`. Returns { what: 'ended' | 'cancelled' | 'unchanged', boundary }. */
export async function unrelate(relationId, { siteId, at = nowSec() } = {}) {
  return await operation(async () => {
    const home = homeArg(siteId);
    const found = await db.prepare('SELECT home_id FROM thing_relation WHERE id = ?').get(relationId);
    if (!found || found.home_id !== home) throw fail(404, `no relation ${relationId}`);
    const stamp = await begin(found.home_id);
    const r = await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ? AND superseded_at IS NULL`).get(relationId);
    if (!r) throw fail(404, `no current relation ${relationId}`);
    const { boundary } = await snap(r.home_id, at);
    return { what: await endRelation(r, boundary, stamp), boundary };
  });
}

/**
 * Move a thing to another place (a room, a floor, the home): its current placement ends at the next slot boundary after `at` and the
 * new one starts there, so no slot is split between two places. A plug moved at 14:10 on a half-hour grid counts in the old room for
 * the 14:00 slot and in the new room from 14:30. Returns { changedAt, boundary, from, relation } (relation null when it is already there).
 */
export async function moveThing(ref, to, { siteId, at = nowSec() } = {}) {
  return await operation(async () => {
    const home = await homeOf(ref, siteId);
    const stamp = await begin(home);
    const t = await liveThing(ref);
    const dest = inside(await getThing(to), home);
    const { changedAt, boundary } = await snap(t.home_id, at);
    const placed = await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE from_id = ? AND rel = 'located_in' AND superseded_at IS NULL
      AND COALESCE(valid_to, ${HI}) > ? ORDER BY COALESCE(valid_from, ${LO})`).all(t.id, boundary);
    const now = placed.find((r) => (r.valid_from ?? LO) <= boundary);
    if (now && now.to_id === dest.id && now.valid_to == null && placed.length === 1) return { changedAt, boundary, from: dest.id, relation: null };
    assertAlive(t, boundary);
    assertAlive(dest, boundary);
    for (const r of placed) await endRelation(r, boundary, stamp);
    const ends = [dest.valid_to, t.valid_to].filter((x) => x != null);
    const id = await insertRelation({ from_id: t.id, rel: 'located_in', to_id: dest.id, valid_from: boundary, changed_at: changedAt, valid_to: ends.length ? Math.min(...ends) : null }, stamp);
    return { changedAt, boundary, from: now?.to_id ?? null, relation: await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE id = ?`).get(id) };
  });
}

// ───────────── replace ─────────────
/**
 * A device is replaced (R2, thing-platform case 1): a new thing of the same type takes the old one's place in the graph from the next
 * slot boundary after `at`. The old thing is retired at that boundary, every current relation of it is cut there and written again for
 * the new thing (same ports, same other end, same window from then on; what the new thing already has is not written twice), and
 * `new replaces old` is recorded. The home's and the systems' timelines run on across the swap while each device's own timeline ends
 * or starts cleanly.
 *   to        a thing that exists already (a hub announced the new device): it must be of the same home and type, live, and not
 *             replace another device. Without it the new thing is made here, with
 *   attrs     the new device's own details; `inherit` lists keys to copy from the old one (nothing is guessed)
 *   uid       for a hub that made the new identity itself
 * An old device that was scheduled to retire later than the swap (valid_to after the boundary) is retired at the boundary instead;
 * relations of it that ended only with that scheduled retirement carry on for the new device, which has its own end (or none).
 * Returns { old, thing, boundary, relations, op }.
 */
export async function replaceThing(ref, { siteId, to = null, name, attrs = {}, inherit = [], uid = null, at = nowSec(), reason } = {}) {
  return await operation(async () => {
    const stamp = await begin(await homeOf(ref, siteId));
    const old = await liveThing(ref);
    if (old.kind !== 'device') throw fail(400, `only a device is replaced (a ${old.kind} is changed, retired or split)`);
    if (!String(reason ?? '').trim()) throw fail(400, 'a replace needs a reason');
    if (await db.prepare("SELECT 1 AS x FROM thing_relation WHERE rel = 'replaces' AND to_id = ? AND superseded_at IS NULL").get(old.id)) {
      throw fail(409, `${old.name} was replaced already: replace the newer device`);
    }
    const { changedAt, boundary } = await snap(old.home_id, at);
    if (old.valid_to != null && old.valid_to <= boundary) throw fail(409, `${old.name} was retired at ${old.valid_to}: it cannot be replaced at ${boundary}`);
    if (old.valid_from != null && boundary <= old.valid_from) throw fail(409, `${old.name} began at ${old.valid_from}: it cannot be replaced before that`);
    let made;
    if (to != null) {
      if (name != null || uid != null || inherit.length || Object.keys(attrs).length) throw bad('a replacement that exists keeps its own name, attributes and uid');
      made = await liveThing(to);
      if (made.id === old.id) throw bad('a device cannot replace itself');
      if (made.home_id !== old.home_id || made.type !== old.type) throw fail(400, `the replacement must be a ${old.type} of the same home (${made.name} is a ${made.type})`);
      if (await db.prepare("SELECT 1 AS x FROM thing_relation WHERE rel = 'replaces' AND from_id = ? AND superseded_at IS NULL").get(made.id)) throw fail(409, `${made.name} replaces a device already`);
      if (made.valid_from != null && made.valid_from > boundary) throw fail(409, `${made.name} began at ${made.valid_from}: after the old device leaves service at ${boundary}`);
      if (made.valid_to != null && made.valid_to <= boundary) throw fail(409, `${made.name} was retired at ${made.valid_to}`);
      if (made.valid_from == null) await db.prepare('UPDATE thing SET valid_from = ? WHERE id = ?').run(boundary, made.id);
    } else {
      const kept = Object.fromEntries(inherit.map((k) => [k, old.attrs[k]]).filter(([, v]) => v !== undefined));
      made = await makeThing({ siteId: old.home_id, type: old.type, name: name ?? `${old.name} (replacement)`, attrs: { ...kept, ...attrs }, uid, validFrom: boundary }, stamp);
    }
    const rows = (await currentRelationsOf(old.id)).filter((r) => r.rel !== 'replaces');
    const moved = await transferRelations(rows, old, made, boundary, changedAt, stamp);
    await db.prepare('UPDATE thing SET valid_to = ? WHERE id = ?').run(boundary, old.id);
    await insertRelation({ from_id: made.id, rel: 'replaces', to_id: old.id, valid_from: boundary, changed_at: changedAt }, stamp);
    const op = await logOp('replace', old, made, boundary, reason, { relations: moved.length, existing: to != null }, stamp);
    return { old: await getThing(old.id), thing: await getThing(made.id), boundary, relations: moved.length, op };
  });
}

// ───────────── merge ─────────────
/**
 * Two things that are one device (a Zigbee TRV that re-paired under a new id, an EV found through two integrations) become one:
 * `keep` survives, `drop` is superseded and points at it (its uid keeps resolving, `resolveThing`). Nothing is deleted.
 *   - both have one type, because a thing never changes type; a generic device found twice is merged into the typed thing (keep the
 *     typed one), and its uid keeps resolving
 *   - the survivor takes the details the dropped thing had and it lacked, and the earlier start of the two (no start is earliest)
 *   - the dropped thing's current relations are written again for the survivor with their own windows; the part of a window the
 *     survivor already has the same edge for is not written twice (each kWh counted once), and a placement is not written over a place
 *     the survivor already had at the time. Both are reported.
 *   - rows of other tables that name the dropped thing (found through the foreign keys) move to the survivor by their table's kind;
 *     a log or fact table is append-only and stays (reported): its readers follow merged_into
 * Anything the database refuses (a rule on a relation, a unique key of another table) stops the merge: nothing is changed, and the
 * message says what could not move.
 * Returns { thing, dropped, relations: { moved, alreadyThere, overridden, between }, tables, attrs, op }.
 */
export async function mergeThings(keepRef, dropRef, { siteId, reason } = {}) {
  return await operation(async () => {
    const home = await homeOf(keepRef, siteId);
    const stamp = await begin(home);
    const keep = await liveThing(keepRef);
    const drop = inside(await liveThing(dropRef), home);
    if (keep.id === drop.id) throw fail(400, 'a thing cannot be merged into itself');
    if (keep.home_id !== drop.home_id || keep.kind !== drop.kind) throw fail(400, 'only two things of one home and kind are merged');
    if (!String(reason ?? '').trim()) throw fail(400, 'a merge needs a reason');
    // a generic device found twice may be dropped into the typed thing it turned out to be; never the other way
    if (keep.type !== drop.type && drop.type !== 'generic_device') {
      if (keep.type === 'generic_device') throw fail(400, `${keep.name} is a generic device and ${drop.name} a ${drop.type}: a thing keeps its type, so keep the ${drop.type} and drop the generic one`);
      throw fail(400, `${keep.name} is a ${keep.type} and ${drop.name} a ${drop.type}: only things of one type are merged (a generic device may be dropped into a typed one)`);
    }
    const ty = await typeRow(keep.type);
    const gained = {};
    for (const [k, v] of Object.entries(drop.attrs)) if (!(k in keep.attrs) && ty.attribute_keys.includes(k)) gained[k] = v;
    // null is "in service since the start of history": the earliest there is, not a missing value
    const from = keep.valid_from == null || drop.valid_from == null ? null : Math.min(keep.valid_from, drop.valid_from);
    const to = keep.valid_to == null || drop.valid_to == null ? null : Math.max(keep.valid_to, drop.valid_to);
    await db.prepare('UPDATE thing SET attrs = ?::jsonb, valid_from = ?, valid_to = ? WHERE id = ?').run(JSON.stringify({ ...keep.attrs, ...gained }), from, to, keep.id);

    // Relations. The dropped thing's rows are superseded first, so its edges do not count in the checks on what is written for the survivor.
    const rows = await currentRelationsOf(drop.id);
    for (const r of rows) await supersedeRelation(r.id, stamp);
    const report = { moved: 0, alreadyThere: 0, overridden: 0, between: 0 };
    for (const r of rows) {
      const a = r.from_id === drop.id ? keep.id : r.from_id;
      const b = r.to_id === drop.id ? keep.id : r.to_id;
      if (a === b) { report.between++; continue; }   // an edge between the two things themselves: it has no meaning on one thing
      const end = await handedEnd(r, drop, { valid_to: to }, r.from_id === drop.id ? r.to_id : r.from_id);   // the survivor's own end, if the dropped thing was scheduled to retire
      let pieces = await uncovered(a, b, r, [r.valid_from, end]);
      if (pieces.length !== 1 || pieces[0][0] !== r.valid_from || pieces[0][1] !== end) report.alreadyThere++;
      if (r.rel === 'located_in' && r.from_id === drop.id) {
        const elsewhere = (await db.prepare("SELECT valid_from, valid_to FROM thing_relation WHERE from_id = ? AND rel = 'located_in' AND superseded_at IS NULL").all(keep.id)).map((x) => [x.valid_from, x.valid_to]);
        const left = pieces.flatMap((p) => subtractWindows(p, elsewhere));
        if (JSON.stringify(left) !== JSON.stringify(pieces)) report.overridden++;
        pieces = left;
      }
      for (const [vf, vt] of pieces) {
        try { await insertRelation({ ...r, from_id: a, to_id: b, valid_from: vf, valid_to: vt }, stamp); }
        catch (err) { throw fail(409, `the merge cannot give ${keep.name} the ${r.rel} relation of ${drop.name}: ${err.message}`); }
        report.moved++;
      }
    }

    // Other tables that name the dropped thing.
    const tables = {};
    for (const ref of await thingReferences()) {
      const key = `${ref.table}.${ref.column}`;
      if (HISTORY_KINDS.has(ref.kind)) {
        tables[key] = { kept: Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${q(ref.table)} WHERE ${q(ref.column)} = ?`).get(drop.id)).n), why: `${ref.kind}: append-only, stays on the thing it was written for (follow merged_into)` };
        continue;
      }
      try { tables[key] = { moved: await moveRows(ref, drop.id, keep.id, stamp) }; }
      catch (err) { throw fail(409, `the merge cannot move the rows of ${key} from ${drop.name} to ${keep.name}: ${err.message}`); }
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
 * log or fact table is append-only and is refused). With `at` a relation that straddles the next slot boundary is cut
 * there (before stays, after moves), and the new thing begins at the boundary; without it a named relation moves whole.
 * The thing as known before the split stays readable: the moved rows are superseded, not erased. Returns { thing, from, boundary, moved, op }.
 */
export async function splitThing(ref, { siteId, name, type = null, attrs = null, uid = null, relations = [], rows = {}, at = null, reason } = {}) {
  return await operation(async () => {
    const stamp = await begin(await homeOf(ref, siteId));
    const src = await liveThing(ref);
    if (!String(reason ?? '').trim()) throw fail(400, 'a split needs a reason');
    const snapped = at == null ? null : await snap(src.home_id, at);
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
      if (HISTORY_KINDS.has(found[0].kind)) throw fail(400, `table ${t} is a ${found[0].kind}: append-only, its rows stay on the thing they were written for`);
    }
    const ty = await typeRow(type ?? src.type);
    if (ty.kind !== src.kind) throw fail(400, `a ${src.kind} cannot be split into a ${ty.kind}`);
    const made = await makeThing({ siteId: src.home_id, type: ty.type, name: name ?? `${src.name} (split)`, attrs: attrs ?? src.attrs, uid, validFrom: boundary }, stamp);
    const moved = await transferRelations(chosen, src, made, boundary, snapped?.changedAt ?? null, stamp);
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
const when = (o = {}) => ({ at: o.at === undefined ? nowSec() : (o.at == null ? null : sec(o.at, 'at')), known: o.known == null ? null : ms(o.known, 'known') });

// The walks (tree, placeChain, reach, thingHistory) stay inside one home: they follow only that home's relations, and they start
// at a thing of that home or at shared context. A route checks the person's access to the home first.
async function inHome(ref, siteId, { strict = false } = {}) {
  if (siteId == null) throw bad('give siteId: a walk stays inside one home');
  const t = await resolveThing(ref);
  if (t.home_id !== Number(siteId) && (strict || t.home_id != null)) throw fail(404, `no thing ${t.id} in home ${siteId}`);
  return t;
}

// A thing's name, attributes and span of life as they were known at `known` (the versions, not the thing row).
async function knownAs(rows, known) {
  if (known == null || !rows.length) return rows;
  const v = await db.prepare(`SELECT thing_id, name, attrs, life_from, life_to FROM thing_attr_version WHERE thing_id = ANY(?::bigint[])
    AND recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)`).all(idArray(rows.map((r) => r.id)), known, known);
  const by = new Map(v.map((x) => [x.thing_id, x]));
  return rows.map((r) => (by.has(r.id) ? { ...r, name: by.get(r.id).name, attrs: by.get(r.id).attrs, valid_from: by.get(r.id).life_from, valid_to: by.get(r.id).life_to } : r));
}

/** The thing as it was known at `known` (ms; null = now): name, attributes and life of that moment; null when it was not recorded yet. */
export async function thingAsKnown(ref, { known = null } = {}) {
  const t = await getThing(ref);
  if (known == null) return t;
  ms(known, 'known');
  if (t.recorded_at > known) return null;
  return (await knownAs([t], known))[0];
}

/** The things of a home that were in service at `at` as known at `known`; optional filters kind, type. */
export async function thingsOf(siteId, { kind = null, type = null, ...o } = {}) {
  const { at, known } = when(o);
  const rec = known == null ? 't.superseded_at IS NULL' : 't.recorded_at <= ? AND (t.superseded_at IS NULL OR t.superseded_at > ?)';
  const rows = await db.prepare(`SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')} FROM thing t WHERE t.home_id = ? AND ${rec}
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
  return await db.prepare(`SELECT r.id, r.home_id, r.from_id, f.uid AS from_uid, r.from_port, r.rel, r.to_id, t.uid AS to_uid, r.to_port, r.required, r.valid_from, r.valid_to, r.changed_at, r.recorded_at, r.superseded_at
      FROM thing_relation r JOIN thing f ON f.id = r.from_id JOIN thing t ON t.id = r.to_id
      WHERE r.home_id IS NOT DISTINCT FROM ?::bigint AND ${v.sql} AND (?::jsonb IS NULL OR r.rel IN (SELECT jsonb_array_elements_text(?::jsonb)))
        AND (?::bigint IS NULL OR r.from_id = ? OR r.to_id = ?)
      ORDER BY r.rel, r.id`).all(siteId, ...v.params, rels && JSON.stringify(rels), rels && JSON.stringify(rels), id, id, id);
}

/**
 * Everything inside a thing by `rel` (default located_in): a nested tree { ...thing, depth, children }, as it held at `at` and was known at
 * `known`. A thing is in one place at a time, so at one instant it is a tree; a loop in other data is cut at the second visit.
 */
export async function tree(ref, { siteId, rel = 'located_in', maxDepth = 20, ...o } = {}) {
  const { at, known } = when(o);
  const root = await inHome(ref, siteId);
  const v = visible('e', { at, known });
  const nodes = await db.prepare(`WITH RECURSIVE down(id, parent, depth, path) AS (
      SELECT ?::bigint, NULL::bigint, 0, ARRAY[?::bigint]
      UNION ALL
      SELECT e.from_id, d.id, d.depth + 1, d.path || e.from_id FROM down d JOIN thing_relation e ON e.to_id = d.id
       WHERE e.rel = ? AND e.home_id = ?::bigint AND ${v.sql} AND NOT e.from_id = ANY(d.path) AND d.depth < ?
    ) SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')}, d.parent, d.depth FROM down d JOIN thing t ON t.id = d.id ORDER BY d.depth, t.name, t.id`).all(root.id, root.id, rel, siteId, ...v.params, maxDepth);
  const named = await knownAs(nodes, known);
  const byId = new Map(named.map((n) => [n.id, { ...n, children: [] }]));
  for (const n of byId.values()) if (n.parent != null) byId.get(n.parent)?.children.push(n);
  return byId.get(root.id);
}

/** Where a thing is, from its own place up: [thing, room, floor, home] (the chain of `rel`, default located_in) at `at` as known at `known`. */
export async function placeChain(ref, { siteId, rel = 'located_in', maxDepth = 20, ...o } = {}) {
  const { at, known } = when(o);
  const start = await inHome(ref, siteId);
  const v = visible('e', { at, known });
  const rows = await db.prepare(`WITH RECURSIVE up(id, depth, path) AS (
      SELECT ?::bigint, 0, ARRAY[?::bigint]
      UNION ALL
      SELECT e.to_id, u.depth + 1, u.path || e.to_id FROM up u JOIN thing_relation e ON e.from_id = u.id
       WHERE e.rel = ? AND e.home_id = ?::bigint AND ${v.sql} AND NOT e.to_id = ANY(u.path) AND u.depth < ?
    ) SELECT ${THING_COLS.split(', ').map((c) => `t.${c}`).join(', ')}, u.depth FROM up u JOIN thing t ON t.id = u.id ORDER BY u.depth`).all(start.id, start.id, rel, siteId, ...v.params, maxDepth);
  return await knownAs(rows, known);
}

/**
 * What can be reached from a thing along `rel` (default feeds): direction 'out' follows the relation from its from side to its to side
 * (downstream in the energy graph), 'in' the other way (upstream). Each thing once, at its shortest distance. A flow network has loops
 * (a battery and its inverter feed each other through different ports): the walk goes level by level and never expands a thing twice,
 * so its cost is the size of the reachable graph, however densely it is connected.
 */
export async function reach(ref, { siteId, rel = 'feeds', direction = 'out', maxDepth = 50, ...o } = {}) {
  if (!['out', 'in'].includes(direction)) throw bad("direction is 'out' or 'in'");
  const { at, known } = when(o);
  const start = await inHome(ref, siteId);
  const v = visible('e', { at, known });
  const [near, far] = direction === 'out' ? ['from_id', 'to_id'] : ['to_id', 'from_id'];
  const depthOf = new Map([[start.id, 0]]);
  let frontier = [start.id];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = await db.prepare(`SELECT DISTINCT e.${far} AS id FROM thing_relation e WHERE e.${near} = ANY(?::bigint[]) AND e.rel = ? AND e.home_id = ?::bigint AND ${v.sql}`)
      .all(idArray(frontier), rel, siteId, ...v.params);
    frontier = next.map((r) => r.id).filter((id) => !depthOf.has(id));
    for (const id of frontier) depthOf.set(id, depth);
  }
  depthOf.delete(start.id);
  if (!depthOf.size) return [];
  const rows = await db.prepare(`SELECT ${THING_COLS} FROM thing WHERE id = ANY(?::bigint[])`).all(idArray([...depthOf.keys()]));
  rows.forEach((r) => { r.depth = depthOf.get(r.id); });
  rows.sort((a, b) => a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
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
    const ctx = await db.prepare(`SELECT ${THING_COLS} FROM thing WHERE home_id IS NULL AND id = ANY(?::bigint[]) ORDER BY id`).all(idArray(extra));
    nodes.push(...await knownAs(ctx, known));
    for (const c of ctx) have.add(c.id);
  }
  // An edge to a thing that is not in the graph at that time (a `replaces` that outlives the thing it replaced) is a relation, not a graph edge.
  return { nodes, edges: found.filter((e) => have.has(e.from_id) && have.has(e.to_id)) };
}

/**
 * Everything recorded about a thing and the things merged into it (one timeline): attribute versions, every relation row ever written
 * (superseded ones included), and the operations (replace, merge, split) that touched it. The thing must belong to the home.
 */
export async function thingHistory(ref, { siteId } = {}) {
  const t = await inHome(ref, siteId, { strict: true });
  const family = (await db.prepare(`WITH RECURSIVE fam(id) AS (SELECT ?::bigint UNION SELECT x.id FROM thing x JOIN fam f ON x.merged_into = f.id) SELECT id FROM fam`).all(t.id)).map((r) => r.id);
  const ids = idArray(family);
  return {
    thing: t,
    family,
    versions: await db.prepare('SELECT thing_id, name, attrs, valid_from, recorded_at, superseded_at FROM thing_attr_version WHERE thing_id = ANY(?::bigint[]) ORDER BY recorded_at, id').all(ids),
    relations: await db.prepare(`SELECT ${REL_COLS} FROM thing_relation WHERE from_id = ANY(?::bigint[]) OR to_id = ANY(?::bigint[]) ORDER BY recorded_at, id`).all(ids, ids),
    ops: await db.prepare('SELECT id, op, thing_id, other_id, effective_at, reason, detail, recorded_at FROM thing_op WHERE thing_id = ANY(?::bigint[]) OR other_id = ANY(?::bigint[]) ORDER BY recorded_at, id').all(ids, ids),
  };
}
