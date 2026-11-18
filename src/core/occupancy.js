// Occupancy (fix list R21): the home's history belongs to the home, a person's time in it belongs to an occupancy.
//
//   openOccupancy(...)   a person starts living in (or owning) a home; giveHome opens one
//   handOver(...)        the home changes hands: the old occupancy ends, what was personal to it goes, the new one starts
//   erasePerson(...)     a person asks to be erased (R14): their account, their occupancies' personal data, their raw answers; the homes keep their history
//   readableFrom(...)    the earliest moment of a home's history a person may read (null: all of it)
//
// What is personal to an occupancy and goes at a handover: the provider logins (connection_secret; the connections stay, disabled, so the
// devices keep their links and history), the supplier agreements (they end at the handover), the requests still open (plans), the grants,
// and the raw answers of the supplier account (a source with traits.personal), sealed with the occupancy's own key: the key is destroyed,
// then the receipts and their files. What stays: things, relations, points, series, facts, slots, events: the home.
import fs from 'node:fs';
import { db, tx, rawFilePath } from '../db/db.js';
import { erase } from './erasure.js';
import { grantSite, revokeSite } from './access.js';
import { cancelRequest } from './controls.js';

const fail = (status, message, code = null) => Object.assign(new Error(message), { status, code });
const nowSec = (ms) => Math.floor(ms / 1000);

/** A person starts at a home. Idempotent: an open occupancy of the same person is returned. seesFrom: the earliest moment of the home's history they may read. */
export async function openOccupancy({ homeId, userId, role = 'owner', from = null, seesFrom = null, now = Date.now() }) {
  const open = await db.prepare('SELECT * FROM occupancy WHERE home_id = ? AND user_id = ? AND valid_to IS NULL').get(homeId, userId);
  if (open) return open;
  const id = Number((await db.prepare('INSERT INTO occupancy (home_id, user_id, role, valid_from, sees_from, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(homeId, userId, role, from, seesFrom, now)).lastInsertRowid);
  return await db.prepare('SELECT * FROM occupancy WHERE id = ?').get(id);
}

export const occupanciesOf = async (homeId) => await db.prepare('SELECT * FROM occupancy WHERE home_id = ? ORDER BY valid_from NULLS FIRST, id').all(homeId);

/** The earliest moment (epoch s) of the home's history this person may read, from their open occupancy; null when nothing limits them. */
export async function readableFrom(userId, homeId) {
  if (userId == null) return null;
  const o = await db.prepare('SELECT sees_from FROM occupancy WHERE home_id = ? AND user_id = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1').get(homeId, userId);
  return o?.sees_from == null ? null : Number(o.sees_from);
}

// Receipts of an occupancy's personal answers: the key goes first (they cannot be read after that), then the files and the rows. A receipt that
// a fact still points at keeps its row (and is unreadable); the count says how many.
async function shredPersonalAnswers(occupancyIds) {
  if (!occupancyIds.length) return { receipts: 0, kept: 0 };
  const list = `{${occupancyIds.join(',')}}`;
  await db.prepare('DELETE FROM occupancy_key WHERE occupancy_id = ANY(?::bigint[])').run(list);
  const refs = await db.prepare(`SELECT kcu.table_name AS t, kcu.column_name AS c FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
     WHERE rc.constraint_schema = current_schema() AND ccu.table_name = 'raw_payload' AND ccu.column_name = 'id' AND rc.delete_rule <> 'CASCADE'`).all();
  const unused = refs.map((r) => `NOT EXISTS (SELECT 1 FROM "${r.t}" x WHERE x."${r.c}" = raw_payload.id)`).join(' AND ') || 'TRUE';
  const gone = await db.prepare(`SELECT id, file FROM raw_payload WHERE occupancy_id = ANY(?::bigint[]) AND ${unused}`).all(list);
  for (const g of gone) { const f = rawFilePath(g.file); if (f) try { fs.unlinkSync(f); } catch { /* already gone */ } }
  if (gone.length) await db.prepare('DELETE FROM raw_payload WHERE id = ANY(?::bigint[])').run(`{${gone.map((g) => g.id).join(',')}}`);
  const kept = Number((await db.prepare('SELECT COUNT(*) n FROM raw_payload WHERE occupancy_id = ANY(?::bigint[])').get(list)).n);
  return { receipts: gone.length, kept };
}

/**
 * The home changes hands at `at` (epoch s): the old owner's occupancy ends, what was personal to it is removed, and the new owner's begins. The
 * new owner reads the home's history from `seesFrom` (default: the handover) unless the previous owner shared more (an earlier seesFrom, null for all).
 * Returns { ended, opened, removed }.
 */
export async function handOver({ homeId, fromUserId, toUserId, at = nowSec(Date.now()), seesFrom = at, reason = 'the home was sold', now = Date.now() }) {
  if (fromUserId === toUserId) throw fail(400, 'a home is handed to another person');
  const old = await db.prepare('SELECT * FROM occupancy WHERE home_id = ? AND user_id = ? AND valid_to IS NULL').get(homeId, fromUserId);
  if (!old) throw fail(409, `user ${fromUserId} is not living in home ${homeId}`, 'not_occupant');
  if (old.valid_from != null && at <= Number(old.valid_from)) throw fail(400, 'the handover is after the occupancy began');
  if (!await db.prepare('SELECT 1 FROM app_user WHERE id = ?').get(toUserId)) throw fail(404, `no user ${toUserId}`);
  return await erase({ kind: 'handover', siteId: homeId, reason }, async () => {
    const removed = {};
    await db.prepare('UPDATE occupancy SET valid_to = ? WHERE id = ?').run(at, old.id);
    removed.grants = await revokeSite({ siteId: homeId, userId: fromUserId, now });
    removed.user_site = Number((await db.prepare('DELETE FROM user_site WHERE user_id = ? AND site_id = ?').run(fromUserId, homeId)).changes);
    removed.logins = Number((await db.prepare('DELETE FROM connection_secret WHERE site_id = ?').run(homeId)).changes);
    await db.prepare("UPDATE connection SET status = 'disabled', last_error = ? WHERE site_id = ?").run('the home changed hands: the new owner connects their own account', homeId);
    removed.agreements_ended = Number((await db.prepare('UPDATE tariff_agreement SET valid_to = ? WHERE site_id = ? AND superseded_at IS NULL AND valid_to IS NULL AND valid_from < ?').run(at, homeId, at)).changes);
    let cancelled = 0;
    for (const r of await db.prepare('SELECT id FROM control_request WHERE home_id = ? AND cancelled_at IS NULL AND valid_until > ?').all(homeId, at)) { await cancelRequest(Number(r.id), { now }); cancelled++; }
    removed.requests_cancelled = cancelled;
    Object.assign(removed, await shredPersonalAnswers([Number(old.id)]));
    const opened = await openOccupancy({ homeId, userId: toUserId, role: 'owner', from: at, seesFrom, now });
    await db.prepare('INSERT INTO user_site (user_id, site_id, recorded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(toUserId, homeId, now);
    await grantSite({ siteId: homeId, userId: toUserId, role: 'owner', scope: 'all', validFrom: seesFrom, grantedBy: null, now });
    return { ended: await db.prepare('SELECT * FROM occupancy WHERE id = ?').get(old.id), opened, removed: { handover: removed } };
  });
}

/**
 * A person asks for their data to be erased (R14 with R21): their account and everything personal to their occupancies go; the occupancy rows stay,
 * with no person on them, so each home still knows when it was lived in. No home loses a thing, a fact or a timeline. A group they own is deleted with
 * its memberships. Returns { removed }.
 */
export async function erasePerson(userId, { reason = 'the person asked for their data to be erased', now = Date.now() } = {}) {
  const u = await db.prepare('SELECT id, role FROM app_user WHERE id = ?').get(userId);
  if (!u) throw fail(404, `no user ${userId}`);
  return await erase({ kind: 'person', reason }, async () => {
    const removed = {};
    const occupancies = await db.prepare('SELECT id, home_id FROM occupancy WHERE user_id = ?').all(userId);
    const ids = occupancies.map((o) => Number(o.id));
    Object.assign(removed, await shredPersonalAnswers(ids));
    const homes = [...new Set(occupancies.map((o) => Number(o.home_id)))];
    // The logins of a home they were the only occupant of are theirs.
    let logins = 0;
    for (const h of homes) {
      if (await db.prepare("SELECT 1 FROM occupancy WHERE home_id = ? AND user_id <> ? AND valid_to IS NULL AND role = 'owner'").get(h, userId)) continue;
      if (!await db.prepare('SELECT 1 FROM occupancy WHERE home_id = ? AND user_id = ? AND valid_to IS NULL').get(h, userId)) continue;
      logins += Number((await db.prepare('DELETE FROM connection_secret WHERE site_id = ?').run(h)).changes);
      await db.prepare("UPDATE connection SET status = 'disabled', last_error = ? WHERE site_id = ?").run('the owner was erased', h);
    }
    removed.logins = logins;
    removed.occupancies_anonymised = Number((await db.prepare('UPDATE occupancy SET user_id = NULL, erased_at = ?, valid_to = COALESCE(valid_to, ?) WHERE user_id = ?').run(now, nowSec(now), userId)).changes);
    removed.groups = Number((await db.prepare('DELETE FROM site_group WHERE owner_id = ?').run(userId)).changes);
    await db.prepare('UPDATE site_grant SET granted_by = NULL WHERE granted_by = ?').run(userId);
    removed.account = Number((await db.prepare('DELETE FROM app_user WHERE id = ?').run(userId)).changes);   // sessions, grants, ownership: cascade
    return { removed: { person: removed } };
  });
}
