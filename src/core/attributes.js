// The system's physical details (panel size and angles, battery size), versioned per source.
//
// Each source keeps its own current value: the installer's figure from .env, a value measured
// from the home's data, the provider's own figure, or an estimate. A new value supersedes the
// same source's previous one; nothing is deleted. The value the core uses is the highest
// ranked source in force (installer > measured > provider > estimated), cached on `site` for
// everyday reads. attributeAt() answers "what was used at moment T" for as-known-at rebuilds.
import { db, tx } from '../db/db.js';

export const ATTRS = ['pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh'];
export const RANK = { installer: 4, measured: 3, provider: 2, estimated: 1 };

const inForceAt = (ms) => (ms == null ? 'superseded_at IS NULL' : `recorded_at <= ${Math.floor(ms)} AND (superseded_at IS NULL OR superseded_at > ${Math.floor(ms)})`);

// The value in force for one detail, resolved across sources; null if none was known.
export function attributeAt(siteId, attr, atMs = null) {
  const rows = db.prepare(`SELECT source, value, detail, recorded_at FROM site_attribute WHERE site_id = ? AND attr = ? AND ${inForceAt(atMs)}`).all(siteId, attr)
    .filter((r) => r.value != null);
  rows.sort((a, b) => RANK[b.source] - RANK[a.source]);
  return rows[0] ?? null;
}

function resolve(siteId, attr) {
  const best = attributeAt(siteId, attr);
  db.prepare(`UPDATE site SET ${attr} = ? WHERE id = ?`).run(best?.value ?? null, siteId);
  return best;
}

// Record a source's value. Unchanged values (same source, same value) write nothing.
export function setAttribute(siteId, attr, value, source, detail = null) {
  if (!ATTRS.includes(attr) || !(source in RANK)) throw new Error(`unknown attribute ${attr}/${source}`);
  const v = value == null || value === '' ? null : Number(value);
  const cur = db.prepare('SELECT value, detail FROM site_attribute WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').get(siteId, attr, source);
  if (cur && cur.value === v) {
    if (detail && cur.detail !== detail) db.prepare('UPDATE site_attribute SET detail = ? WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').run(detail, siteId, attr, source);
    return resolve(siteId, attr);
  }
  const now = Date.now();
  tx(() => {
    db.prepare('UPDATE site_attribute SET superseded_at = ? WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').run(now, siteId, attr, source);
    if (v != null) db.prepare('INSERT INTO site_attribute (site_id, attr, source, value, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(siteId, attr, source, v, detail, now);
  });
  return resolve(siteId, attr);
}

// A source no longer gives a value (for example the installer figure was removed from .env).
export const withdrawAttribute = (siteId, attr, source) => setAttribute(siteId, attr, null, source);

export function attributeHistory(siteId) {
  return db.prepare('SELECT attr, source, value, detail, recorded_at, superseded_at FROM site_attribute WHERE site_id = ? ORDER BY attr, recorded_at').all(siteId);
}

// Databases created before versioning hold only the current value on `site`. Record it once,
// with the source it most likely came from, so history starts from here; earlier values
// were not kept and cannot be recovered.
export function seedAttributes(siteId, guessSource) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  for (const attr of ATTRS) {
    if (site[attr] == null) continue;
    if (db.prepare('SELECT 1 FROM site_attribute WHERE site_id = ? AND attr = ?').get(siteId, attr)) continue;
    const { source, detail } = guessSource(attr, site[attr]);
    setAttribute(siteId, attr, site[attr], source, `${detail}; recorded when versioning started (earlier values were not kept)`);
  }
}
