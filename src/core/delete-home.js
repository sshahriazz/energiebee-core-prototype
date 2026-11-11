// Deleting a home for good: its owner (or an admin) types the home's name, and everything that belongs to the home
// is removed from the database and the raw files. This is the one place the core deletes a user's data instead of
// superseding it: a home the user asked to delete must not be kept.
//
// What belongs to a home is found from the schema itself, so a table added later is covered without a change here:
//   seeds    the site row; its devices (device.site_id); its series (series.subject_kind 'site' or 'device', whose
//            subject_id names the home or one of its devices: no foreign key there); rows of tables with a site_id
//            column and no foreign key (channel_reject)
//   follow   every foreign key, whatever its ON DELETE: a row that references a row being deleted is deleted too
//            (facts of its series, readings, days, agreements, plans, commands, its own tariff rows, logins ...)
//   shared   never followed upward: a tariff, a supplier, a region's series or a group the home was in stays
//   raw      raw_payload rows landed for the home are deleted with their files, except a raw answer that something
//            kept still points at (an RTE carbon answer landed while syncing this home but read by every French
//            home, a catalogue listing): that one stays, with its site_id cleared
//   state    provider_state entries keyed by the home (tounify: eb-site-<id>) are dropped
// One transaction, foreign keys checked at commit (defer_foreign_keys), so a schema change that would leave a dangling
// row fails the delete instead of half-doing it.
import fs from 'node:fs';
import path from 'node:path';
import { db, tx, dataDir } from '../db/db.js';
import { isSyncing } from '../jobs/sync.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Every foreign key of every table: { child, from, parent, to } (to: the parent's primary key when not named).
function foreignKeys() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const pk = (t) => db.prepare(`SELECT name FROM pragma_table_info(?) WHERE pk = 1`).get(t)?.name ?? 'rowid';
  const out = [];
  for (const child of tables) {
    for (const f of db.prepare('SELECT "table" AS parent, "from", "to" FROM pragma_foreign_key_list(?)').all(child)) {
      out.push({ child, from: f.from, parent: f.parent, to: f.to ?? pk(f.parent) });
    }
  }
  return { tables, out };
}

const inJson = (col) => `${q(col)} IN (SELECT value FROM json_each(?))`;

/**
 * What deleting the home would remove: { tables: { name: rows }, raw: { deleted, kept }, files }, and the plan used to
 * delete it. Read only.
 */
export function homeFootprint(siteId) {
  const { tables, out: fks } = foreignKeys();
  // keys[table][column] = Set of values whose rows go; conds[table] = [{ col, vals }].
  const keys = new Map();
  const conds = new Map();
  const add = (t, col, vals) => {
    if (!vals.length) return false;
    const byCol = keys.get(t) ?? keys.set(t, new Map()).get(t);
    const set = byCol.get(col) ?? byCol.set(col, new Set()).get(col);
    let grew = false;
    for (const v of vals) if (v != null && !set.has(v)) { set.add(v); grew = true; }
    return grew;
  };
  const refCols = new Map();   // table -> columns other tables reference
  for (const f of fks) (refCols.get(f.parent) ?? refCols.set(f.parent, new Set()).get(f.parent)).add(f.to);
  // Rows of a table chosen by a condition: delete them, and collect the values other tables reference.
  const take = (t, col, vals) => {
    if (!vals.length) return false;
    (conds.get(t) ?? conds.set(t, []).get(t)).push({ col, vals });
    let grew = false;
    for (const rc of refCols.get(t) ?? []) {
      const got = db.prepare(`SELECT DISTINCT ${q(rc)} AS v FROM ${q(t)} WHERE ${inJson(col)}`).all(JSON.stringify(vals)).map((r) => r.v);
      grew = add(t, rc, got) || grew;
    }
    return grew;
  };

  // Seeds.
  const id = Number(siteId);
  take('site', 'id', [id]);
  const devices = db.prepare('SELECT id FROM device WHERE site_id = ?').all(id).map((r) => r.id);
  take('device', 'id', devices);
  const series = db.prepare(`SELECT id FROM series WHERE (subject_kind = 'site' AND subject_id = ?)
    OR (subject_kind = 'device' AND subject_id IN (SELECT value FROM json_each(?)))`).all(String(id), JSON.stringify(devices.map(String))).map((r) => r.id);
  take('series', 'id', series);
  for (const t of tables) {
    if (t === 'raw_payload' || t === 'site' || t === 'device') continue;
    const hasCol = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'site_id'").get(t);
    const fk = fks.some((f) => f.child === t && f.from === 'site_id');
    if (hasCol && !fk) take(t, 'site_id', [id]);
  }

  // Follow the foreign keys to a fixed point (raw_payload is decided after: it can be shared).
  for (let grew = true; grew;) {
    grew = false;
    for (const f of fks) {
      if (f.child === 'raw_payload') continue;
      const vals = keys.get(f.parent)?.get(f.to);
      if (!vals?.size) continue;
      const seen = new Set((conds.get(f.child) ?? []).filter((c) => c.col === f.from).flatMap((c) => c.vals));
      const fresh = [...vals].filter((v) => !seen.has(v));
      if (fresh.length) grew = take(f.child, f.from, fresh) || grew;
    }
  }

  const where = (t) => conds.get(t).map((c) => inJson(c.col)).join(' OR ');
  const params = (t) => conds.get(t).map((c) => JSON.stringify(c.vals));
  const counts = {};
  for (const t of conds.keys()) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${where(t)}`).get(...params(t)).n;
    if (n) counts[t] = n;
  }
  // Raw answers landed for the home: kept only where a row that stays still points at one.
  const raws = db.prepare('SELECT id, file FROM raw_payload WHERE site_id = ?').all(id);
  const rawRefs = fks.filter((f) => f.parent === 'raw_payload');
  const keptRaw = new Set();
  for (const f of rawRefs) {
    const going = conds.get(f.child);
    const sql = `SELECT DISTINCT ${q(f.from)} AS v FROM ${q(f.child)} WHERE ${q(f.from)} IN (SELECT id FROM raw_payload WHERE site_id = ?)${going ? ` AND NOT COALESCE((${where(f.child)}), 0)` : ''}`;   // NULL site_id (a shared row) stays
    for (const r of db.prepare(sql).all(id, ...(going ? params(f.child) : []))) keptRaw.add(r.v);
  }
  return {
    counts,
    raw: { deleted: raws.filter((r) => !keptRaw.has(r.id)), kept: [...keptRaw] },
    plan: { conds, where, params },
  };
}

/**
 * Delete a home: { confirm } must be the home's name, exactly (surrounding spaces ignored). Refused for a home the
 * user does not own (an admin may delete any), the home configured in .env (it is made again on every start) and a
 * home that is syncing now. Returns { deleted: { id, name }, rows: { table: n }, raw: { deleted, kept }, files }.
 */
export function deleteHome(user, site, { confirm } = {}) {
  if (!user) throw fail(401, 'Sign in first');
  if (!site) throw fail(404, 'Home not found');
  const owns = user.role === 'admin' || !!db.prepare('SELECT 1 FROM user_site WHERE user_id = ? AND site_id = ?').get(user.id, site.id);
  if (!owns) throw fail(403, 'Only the owner of this home can delete it');
  if (site.env_key) throw fail(400, 'This home is configured in .env and is made again on every start: remove it from .env instead');
  if (String(confirm ?? '').trim() !== site.name.trim()) throw fail(400, `To delete this home, type its name exactly: ${site.name}`);
  if (isSyncing(site.id)) throw fail(409, 'This home is syncing now: try again in a minute');

  const f = homeFootprint(site.id);
  const { conds, where, params } = f.plan;
  const removed = {};
  tx(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    // Children first is not needed with deferred checks; the site row last keeps ON DELETE CASCADE from doing it twice.
    for (const t of [...conds.keys()].filter((x) => x !== 'site')) {
      const n = db.prepare(`DELETE FROM ${q(t)} WHERE ${where(t)}`).run(...params(t)).changes;
      if (n) removed[t] = n;
    }
    const kept = JSON.stringify(f.raw.kept);
    db.prepare('UPDATE raw_payload SET site_id = NULL WHERE site_id = ? AND id IN (SELECT value FROM json_each(?))').run(site.id, kept);
    const rawGone = db.prepare('DELETE FROM raw_payload WHERE site_id = ?').run(site.id).changes;
    if (rawGone) removed.raw_payload = rawGone;
    removed.site = db.prepare('DELETE FROM site WHERE id = ?').run(site.id).changes;
    // tounify keeps per-home read state under the home's local reference.
    const st = db.prepare("SELECT state FROM provider_state WHERE provider = 'tounify'").get();
    if (st?.state) {
      try {
        const s = JSON.parse(st.state);
        if (s.connections?.[`eb-site-${site.id}`]) {
          delete s.connections[`eb-site-${site.id}`];
          db.prepare("UPDATE provider_state SET state = ? WHERE provider = 'tounify'").run(JSON.stringify(s));
        }
      } catch { /* an unreadable state is left as it is */ }
    }
  });
  // The raw files, after the commit: a file whose row is gone is only a leftover.
  let files = 0;
  for (const r of f.raw.deleted) {
    try { fs.unlinkSync(path.join(dataDir, r.file)); files++; } catch { /* already gone */ }
  }
  return { deleted: { id: site.id, name: site.name }, rows: removed, raw: { deleted: f.raw.deleted.length, kept: f.raw.kept.length }, files };
}
