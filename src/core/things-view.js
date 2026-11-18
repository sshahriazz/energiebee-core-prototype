// What the thing API shows (plan 1.6): things and relations as they leave the system. Integer ids never do: a thing is its uid, a
// relation is its uid, and a home is the uid of its home thing. Valid time is epoch seconds, record time epoch milliseconds (the
// library's own units); `at` and `known` come in the same units, or as ISO-8601 instants.
import { db } from '../db/db.js';

const bad = (message) => Object.assign(new RangeError(message), { status: 400 });

// An instant of valid time (seconds) from a query or body value: digits are seconds, otherwise an ISO-8601 instant.
export function parseAt(value, what = 'at') {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const s = String(value);
  if (/^\d{1,11}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(t)) return Math.floor(t / 1000);
  throw bad(`${what}: epoch seconds or an ISO-8601 time, not ${JSON.stringify(value)}`);
}
// An instant of record time (milliseconds).
export function parseKnown(value, what = 'known') {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const s = String(value);
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(t)) return t;
  throw bad(`${what}: epoch milliseconds or an ISO-8601 time, not ${JSON.stringify(value)}`);
}

const list = (ids) => `{${[...new Set(ids.filter((i) => i != null).map(Number))].join(',')}}`;

/** uid and name by id, for the ids given. */
export async function lookup(ids) {
  const set = [...new Set(ids.filter((i) => i != null).map(Number))];
  if (!set.length) return new Map();
  const rows = await db.prepare('SELECT id, uid, name, type, kind FROM thing WHERE id = ANY(?::bigint[])').all(list(set));
  return new Map(rows.map((r) => [Number(r.id), r]));
}

const shapeThing = (t, by) => ({
  uid: t.uid, kind: t.kind, type: t.type, name: t.name, attrs: t.attrs ?? {}, std_ref: t.std_ref ?? null,
  valid_from: t.valid_from ?? null, valid_to: t.valid_to ?? null, recorded_at: t.recorded_at ?? null,
  home_uid: t.home_id == null ? null : by.get(Number(t.home_id))?.uid ?? null,
  merged_into: t.merged_into == null ? null : by.get(Number(t.merged_into))?.uid ?? null,
});

/** Thing rows as the API shows them. */
export async function viewThings(rows) {
  const by = await lookup(rows.flatMap((t) => [t.home_id, t.merged_into]));
  return rows.map((t) => shapeThing(t, by));
}
export async function viewThing(row) { return (await viewThings([row]))[0]; }

const shapeRelation = (r, by) => ({
  uid: r.uid,
  from: { uid: by.get(Number(r.from_id))?.uid ?? null, name: by.get(Number(r.from_id))?.name ?? null, port: r.from_port ?? null },
  rel: r.rel,
  to: { uid: by.get(Number(r.to_id))?.uid ?? null, name: by.get(Number(r.to_id))?.name ?? null, port: r.to_port ?? null },
  required: r.required === 1 || r.required === true,
  valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null, changed_at: r.changed_at ?? null,
  recorded_at: r.recorded_at ?? null, superseded_at: r.superseded_at ?? null,
});

/** Relation rows (as the library returns them: uid, from_id, to_id) as the API shows them; the ends are named by uid and name. */
export async function viewRelations(rows) {
  const by = await lookup(rows.flatMap((r) => [r.from_id, r.to_id]));
  return rows.map((r) => shapeRelation(r, by));
}

/** A tree from the library (nodes with children) as uids; one lookup for the whole tree. */
export async function viewTree(root) {
  const nodes = [];
  (function walk(n) { nodes.push(n); n.children.forEach(walk); })(root);
  const by = await lookup(nodes.flatMap((n) => [n.home_id, n.merged_into]));
  const shape = (n) => ({ ...shapeThing(n, by), children: n.children.map(shape) });
  return shape(root);
}

/** What thingHistory found, with every id turned into a uid. */
export async function viewHistory(h) {
  const by = await lookup([h.thing.id, ...h.family, ...h.versions.map((v) => v.thing_id), ...h.ops.flatMap((o) => [o.thing_id, o.other_id]), ...h.relations.flatMap((r) => [r.from_id, r.to_id]), h.thing.home_id]);
  const uid = (id) => (id == null ? null : by.get(Number(id))?.uid ?? null);
  return {
    thing: shapeThing(h.thing, by),
    family: h.family.map(uid),
    versions: h.versions.map((v) => ({ thing: uid(v.thing_id), name: v.name, attrs: v.attrs, valid_from: v.valid_from, recorded_at: v.recorded_at, superseded_at: v.superseded_at })),
    relations: h.relations.map((r) => shapeRelation(r, by)),
    ops: h.ops.map((o) => ({ op: o.op, thing: uid(o.thing_id), other: uid(o.other_id), effective_at: o.effective_at, reason: o.reason, detail: o.detail, recorded_at: o.recorded_at })),
  };
}

// Messages from the library name things by id ("thing 12 was merged into thing 15"): the API never shows an id.
export const scrub = (message) => String(message ?? '').replace(/\b(thing|relation|home) \d+\b/g, '$1');
