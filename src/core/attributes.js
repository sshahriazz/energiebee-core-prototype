// The system's physical details (panel size and angles, battery size), versioned per source.
//
// Each source keeps its own current value: the installer's figure from .env, a value measured
// from the home's data, the provider's own figure, or an estimate. A new value supersedes the
// same source's previous one; nothing is deleted. The value the core uses is the highest
// ranked source in force (installer > measured > provider > estimated), cached on `site` for
// everyday reads. attributeAt() answers "what was used at moment T" for as-known-at rebuilds.
//
// Every key is a row of the attribute registry (attribute_def, delta 020, seeded from
// src/db/seed/attributes.js): its unit, type, range and what it applies to (the home, or devices
// of a kind). A key without a row, a key that does not apply to the subject, or a value outside
// the row's rules is refused (RangeError). Every value carries a provenance label (origin,
// src/core/provenance.js): given by the writer, or the one its source implies (SOURCE_ORIGIN).
// The four details above (ATTRS) stay in site_attribute and on `site`, as the build reads them;
// every other key, for a home or a device, is versioned the same way in attribute_value.
import { db, tx } from '../db/db.js';
import { checkOrigin } from './provenance.js';
import { checkValue, parseDef, encodeValue, decodeValue } from './value-check.js';

export const ATTRS = ['pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh'];
export const RANK = { installer: 4, measured: 3, provider: 2, estimated: 1 };
// The provenance label a source implies when the writer gives none.
export const SOURCE_ORIGIN = Object.freeze({ installer: 'user', measured: 'derived', provider: 'provider', estimated: 'placeholder' });

const inForceAt = (ms) => (ms == null ? 'superseded_at IS NULL' : `recorded_at <= ${Math.floor(ms)} AND (superseded_at IS NULL OR superseded_at > ${Math.floor(ms)})`);

// The value in force for one detail, resolved across sources; null if none was known.
export function attributeAt(siteId, attr, atMs = null) {
  if (!ATTRS.includes(attr)) {
    const key = attributeDef(attr)?.alias_of ?? attr;
    if (!ATTRS.includes(key)) return valueAt('site_id', siteId, key, atMs);
    attr = key;
  }
  const rows = db.prepare(`SELECT source, value, detail, origin, recorded_at FROM site_attribute WHERE site_id = ? AND attr = ? AND ${inForceAt(atMs)}`).all(siteId, attr)
    .filter((r) => r.value != null);
  rows.sort((a, b) => RANK[b.source] - RANK[a.source]);
  return rows[0] ?? null;
}

function resolve(siteId, attr) {
  const best = attributeAt(siteId, attr);
  db.prepare(`UPDATE site SET ${attr} = ? WHERE id = ?`).run(best?.value ?? null, siteId);
  return best;
}

// Record a source's value for a home. Unchanged values (same source, value and origin) write
// nothing. `origin` defaults to the label the source implies (SOURCE_ORIGIN).
export function setAttribute(siteId, attr, value, source, detail = null, { origin = null } = {}) {
  if (!(source in RANK)) throw new RangeError(`unknown attribute source ${source}: one of ${Object.keys(RANK).join(', ')}`);
  const def = defFor(attr, {});
  const v = checkValue(def, value, `attribute ${attr}`);
  const label = labelFor(def, origin, source, attr);
  if (def.storage !== 'site_attribute') return writeValue({ col: 'site_id', id: siteId }, def, v, source, label, detail);
  attr = def.key;
  const cur = db.prepare('SELECT value, detail, origin, recorded_at FROM site_attribute WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').get(siteId, attr, source);
  if (cur && cur.value === v && cur.origin === label) {
    if (detail && cur.detail !== detail) db.prepare('UPDATE site_attribute SET detail = ? WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').run(detail, siteId, attr, source);
    return resolve(siteId, attr);
  }
  const now = Math.max(Date.now(), (cur?.recorded_at ?? 0) + 1);   // versions always move forward
  tx(() => {
    db.prepare('UPDATE site_attribute SET superseded_at = ? WHERE site_id = ? AND attr = ? AND source = ? AND superseded_at IS NULL').run(now, siteId, attr, source);
    if (v != null) db.prepare('INSERT INTO site_attribute (site_id, attr, source, value, detail, origin, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(siteId, attr, source, v, detail, label, now);
  });
  return resolve(siteId, attr);
}

// A source no longer gives a value (for example the installer figure was removed from .env).
export const withdrawAttribute = (siteId, attr, source) => setAttribute(siteId, attr, null, source);

export function attributeHistory(siteId) {
  return db.prepare('SELECT attr, source, value, detail, origin, recorded_at, superseded_at FROM site_attribute WHERE site_id = ? ORDER BY attr, recorded_at').all(siteId);
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

// ───────────── The attribute registry and the keys beyond the four build details ─────────────

// A registry row (JSON columns parsed), or null for an unknown key.
export function attributeDef(key) {
  return parseDef(db.prepare('SELECT * FROM attribute_def WHERE key = ?').get(key));
}

// Registry rows, optionally only those that apply to 'site' or to 'device:<kind>'.
export function attributeDefs({ appliesTo = null } = {}) {
  const all = db.prepare('SELECT * FROM attribute_def ORDER BY key').all().map(parseDef);
  if (!appliesTo) return all;
  const kind = appliesTo.startsWith('device:') ? appliesTo.slice(7) : null;
  const listed = kind ? kindKeys(kind) : [];
  return all.filter((d) => d.applies_to.includes(appliesTo) || (kind && (d.applies_to.includes('device:*') || listed.includes(d.key))));
}

const kindKeys = (kind) => JSON.parse(db.prepare('SELECT attribute_keys FROM device_kind WHERE kind = ?').get(kind)?.attribute_keys ?? '[]');

// The registry row a key is checked and stored under (an alias resolves to the key it stands for),
// refusing a key without a row and a key that does not apply to the subject.
function defFor(key, { device = null }) {
  let def = attributeDef(key);
  if (!def) throw new RangeError(`unknown attribute ${key}: no row in attribute_def (a new key is one registry row)`);
  if (def.alias_of) def = attributeDef(def.alias_of);
  const ok = device
    ? def.applies_to.includes(`device:${device.kind}`) || def.applies_to.includes('device:*') || kindKeys(device.kind).includes(def.key)
    : def.applies_to.includes('site');
  if (!ok) throw new RangeError(`attribute ${key} does not apply to ${device ? `a ${device.kind} device` : 'a home'} (it applies to ${def.applies_to.join(', ')})`);
  return def;
}

function labelFor(def, origin, source, what) {
  const label = origin ?? SOURCE_ORIGIN[source];
  checkOrigin(label, `attribute ${what}`);
  if (def.origins && !def.origins.includes(label)) throw new RangeError(`attribute ${what}: origin ${label} is not allowed for this key (allowed: ${def.origins.join(', ')})`);
  return label;
}

// The value in force for one key of a home (col 'site_id') or device ('device_id'), resolved
// across sources like the build details; null if none was known.
function valueAt(col, id, key, atMs = null) {
  const rows = db.prepare(`SELECT source, value, origin, note, recorded_at FROM attribute_value WHERE ${col} = ? AND key = ? AND ${inForceAt(atMs)}`).all(id, key);
  if (!rows.length) return null;
  rows.sort((a, b) => RANK[b.source] - RANK[a.source]);
  const r = rows[0];
  return { key, source: r.source, origin: r.origin, value: decodeValue(r.value), detail: r.note, recorded_at: r.recorded_at };
}

// Versioned write to attribute_value; a key with a site_column has its resolved value cached there
// (latitude -> site.lat), as the build details are on `site`. A withdrawn value leaves the column.
function writeValue(subject, def, v, source, origin, note) {
  const where = `${subject.col} = ? AND key = ? AND source = ? AND superseded_at IS NULL`;
  const cur = db.prepare(`SELECT id, value, origin, note, recorded_at FROM attribute_value WHERE ${where}`).get(subject.id, def.key, source);
  const json = encodeValue(v);
  const unchanged = cur ? cur.value === json && cur.origin === origin : v == null;
  if (unchanged) {
    if (cur && note && cur.note !== note) db.prepare('UPDATE attribute_value SET note = ? WHERE id = ?').run(note, cur.id);
  } else {
    const now = Math.max(Date.now(), (cur?.recorded_at ?? 0) + 1);   // versions always move forward
    tx(() => {
      if (cur) db.prepare('UPDATE attribute_value SET superseded_at = ? WHERE id = ?').run(now, cur.id);
      if (v != null) db.prepare(`INSERT INTO attribute_value (${subject.col}, key, source, value, origin, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(subject.id, def.key, source, json, origin, note, now);
    });
  }
  const best = valueAt(subject.col, subject.id, def.key);
  if (def.site_column && subject.col === 'site_id' && best?.value != null) {
    db.prepare(`UPDATE site SET ${def.site_column} = ? WHERE id = ? AND ${def.site_column} IS NOT ?`).run(best.value, subject.id, best.value);
  }
  return best;
}

/**
 * Record a source's value of one attribute of a device (a battery's reserve, an inverter's export
 * limit, a heat pump's COP curve ...). The key must apply to the device's kind (attribute_def
 * applies_to, or device_kind.attribute_keys). Unchanged values write nothing; null withdraws.
 * @returns the value now in force for the key (all sources), or null
 */
export function setDeviceAttribute(deviceId, key, value, source, { origin = null, note = null } = {}) {
  if (!(source in RANK)) throw new RangeError(`unknown attribute source ${source}: one of ${Object.keys(RANK).join(', ')}`);
  const device = db.prepare('SELECT id, kind FROM device WHERE id = ?').get(deviceId);
  if (!device) throw new RangeError(`no device ${deviceId}`);
  const def = defFor(key, { device });
  const v = checkValue(def, value, `attribute ${key}`);
  return writeValue({ col: 'device_id', id: deviceId }, def, v, source, labelFor(def, origin, source, key), note);
}

// A device attribute as known at atMs (null = now): { key, source, origin, value, detail, recorded_at } or null.
export function deviceAttributeAt(deviceId, key, atMs = null) {
  return valueAt('device_id', deviceId, attributeDef(key)?.alias_of ?? key, atMs);
}

/**
 * Every attribute with a value for a home ({ siteId }) or a device ({ deviceId }) as known at atMs:
 * { key: { source, origin, value, detail, recorded_at } }. A home's four build details are included.
 */
export function attributesAt({ siteId = null, deviceId = null }, atMs = null) {
  const col = siteId != null ? 'site_id' : 'device_id';
  const id = siteId ?? deviceId;
  const keys = db.prepare(`SELECT DISTINCT key FROM attribute_value WHERE ${col} = ? AND recorded_at <= ?`).all(id, atMs ?? Number.MAX_SAFE_INTEGER).map((r) => r.key);
  const out = {};
  if (siteId != null) for (const a of ATTRS) { const r = attributeAt(siteId, a, atMs); if (r) out[a] = { ...r, key: a }; }
  for (const k of keys) { const r = valueAt(col, id, k, atMs); if (r) out[k] = r; }
  return out;
}

// Every version of a home's or device's registry attributes (not the four build details: attributeHistory).
export function attributeValueHistory({ siteId = null, deviceId = null }) {
  const col = siteId != null ? 'site_id' : 'device_id';
  return db.prepare(`SELECT key, source, value, origin, note, recorded_at, superseded_at FROM attribute_value WHERE ${col} = ? ORDER BY key, recorded_at`)
    .all(siteId ?? deviceId).map((r) => ({ ...r, value: decodeValue(r.value) }));
}
