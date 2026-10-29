// Who may see or control a home (delta 070: app_user, site_grant). Access is evaluated NOW: a revoked
// grant gives nothing, history included. A grant may also limit which period of the home's data it shows
// (valid_from, valid_to: seconds). Prototype scope: users are named rows, there is no sign-in here.
//
//   role    owner (everything the scope allows, can share) | operator (can control within the scope) | viewer (reads)
//   scope   all | energy (reads energy and cost, no control) | control (may command, reads nothing)
//
// canView: an active grant whose scope is all or energy. canControl: an active grant whose role is owner or
// operator and whose scope is all or control (a viewer never controls, whatever the scope). tenant and
// tenant_site (delta 060) stay the data controller of a home; nothing here reads them.
import { db } from '../db/db.js';

const ROLES = ['owner', 'operator', 'viewer'];
const SCOPES = ['all', 'energy', 'control'];

export function createUser({ name, now = Date.now() }) {
  if (!String(name ?? '').trim()) throw new Error('a user needs a name');
  return Number(db.prepare('INSERT INTO app_user (name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid);
}

export function grantSite({ siteId, userId, role = 'viewer', scope = 'all', validFrom = null, validTo = null, grantedBy = null, now = Date.now() }) {
  if (!ROLES.includes(role)) throw new RangeError(`role is one of ${ROLES.join(', ')}`);
  if (!SCOPES.includes(scope)) throw new RangeError(`scope is one of ${SCOPES.join(', ')}`);
  return Number(db.prepare('INSERT INTO site_grant (site_id, user_id, role, scope, valid_from, valid_to, granted_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(siteId, userId, role, scope, validFrom, validTo, grantedBy, now).lastInsertRowid);
}

// Revoke every current grant of a user on a home. Returns how many.
export function revokeSite({ siteId, userId, now = Date.now() }) {
  return Number(db.prepare('UPDATE site_grant SET revoked_at = ? WHERE site_id = ? AND user_id = ? AND revoked_at IS NULL').run(now, siteId, userId).changes);
}

export function activeGrants(userId, siteId, now = Date.now()) {
  return db.prepare('SELECT * FROM site_grant WHERE user_id = ? AND site_id = ? AND recorded_at <= ? AND (revoked_at IS NULL OR revoked_at > ?)').all(userId, siteId, now, now);
}

export const canView = (userId, siteId, now = Date.now()) => activeGrants(userId, siteId, now).some((g) => g.scope === 'all' || g.scope === 'energy');
// The check the control path calls before it queues a command for a device of this home.
export const canControl = (userId, siteId, now = Date.now()) => activeGrants(userId, siteId, now).some((g) => g.role !== 'viewer' && (g.scope === 'all' || g.scope === 'control'));

// The periods of the home's data the user may read, as [{ from, to }] in seconds (null = open); [] = none.
// One unlimited grant makes the whole history readable.
export function viewWindows(userId, siteId, now = Date.now()) {
  const g = activeGrants(userId, siteId, now).filter((x) => x.scope === 'all' || x.scope === 'energy');
  if (g.some((x) => x.valid_from == null && x.valid_to == null)) return [{ from: null, to: null }];
  return g.map((x) => ({ from: x.valid_from, to: x.valid_to }));
}

// Homes the user may read now.
export function visibleSites(userId, now = Date.now()) {
  return db.prepare('SELECT DISTINCT site_id FROM site_grant WHERE user_id = ?').all(userId).map((r) => r.site_id).filter((id) => canView(userId, id, now));
}
