// Links (plan 2.3, docs/build/points.md): the name a provider has for a thing. A device found again by its serial, its MPAN or its hub
// id is the same thing, never a second one; the link says which. A device row that has an integration behind it gets its link
// from the database; the library makes the others (a discovered device, a thing given a name by hand) and ends them.
import { db } from '../db/db.js';

const KINDS = ['cloud', 'hub', 'push', 'manual', 'synthetic'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const COLS = 'id, uid, home_id, thing_id, kind, provider, connection_id, external_ref, valid_from, valid_to, recorded_at, superseded_at';

/** The open link of a provider's name in a home: { id, uid, thing_id, … }, or null. */
export async function linkFor(homeId, provider, externalRef) {
  return await db.prepare(`SELECT ${COLS} FROM thing_link WHERE home_id = ? AND provider = ? AND external_ref = ? AND valid_to IS NULL AND superseded_at IS NULL`).get(homeId, provider, String(externalRef)) ?? null;
}

/** The thing a provider's name stands for in a home (its id), or null. */
export async function thingByRef(homeId, provider, externalRef) {
  const l = await linkFor(homeId, provider, externalRef);
  return l ? Number(l.thing_id) : null;
}

/** The links of a thing, newest first (ended ones too). */
export async function linksOf(thingId) {
  return await db.prepare(`SELECT ${COLS} FROM thing_link WHERE thing_id = ? AND superseded_at IS NULL ORDER BY COALESCE(valid_from, 0) DESC, id DESC`).all(thingId);
}

/**
 * Tie a provider's name to a thing. Idempotent: the same name for the same thing is the link it already has; the name of another
 * thing is refused (409), so a second discovery never makes a second thing. `kind` defaults from the provider like the database's
 * own links; `connectionId` is the home's connection, when there is one.
 */
export async function ensureLink({ homeId, thingId, provider, externalRef, kind = null, connectionId = null, validFrom = null }) {
  if (!provider || externalRef == null || String(externalRef) === '') throw fail(400, 'a link needs a provider and the provider\'s name for the thing');
  if (kind != null && !KINDS.includes(kind)) throw fail(400, `link kind ${kind}: one of ${KINDS.join(', ')}`);
  const have = await linkFor(homeId, provider, externalRef);
  if (have) {
    if (Number(have.thing_id) !== Number(thingId)) throw fail(409, `${provider} ${externalRef} is already linked to another thing of this home`);
    return have;
  }
  const id = Number((await db.prepare(`INSERT INTO thing_link (home_id, thing_id, kind, provider, connection_id, external_ref, valid_from)
    VALUES (?, ?, COALESCE(?, thing_link_kind(?)), ?, ?, ?, ?)`).run(homeId, thingId, kind, provider, provider, connectionId, String(externalRef), validFrom)).lastInsertRowid);
  return await db.prepare(`SELECT ${COLS} FROM thing_link WHERE id = ?`).get(id);
}

/** A link stops at `at` (epoch seconds, after it began); the thing and its points stay. Returns the link. */
export async function endLink(linkId, at) {
  const l = await db.prepare(`SELECT ${COLS} FROM thing_link WHERE id = ? AND superseded_at IS NULL`).get(linkId);
  if (!l) throw fail(404, 'no such link');
  if (l.valid_to != null) return l;
  const end = Math.max(Math.floor(at), (l.valid_from ?? 0) + 1);
  await db.prepare('UPDATE thing_link SET valid_to = ? WHERE id = ?').run(end, linkId);
  return await db.prepare(`SELECT ${COLS} FROM thing_link WHERE id = ?`).get(linkId);
}
