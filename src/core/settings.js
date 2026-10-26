// Planner tunables per home (site_setting, delta 021): the knobs a Predbat-style battery planner and a
// PredHeat-style heating planner run with, versioned like facts. Each key is a row of setting_def
// (seeded from src/db/seed/settings.js) with its type, range and default; a key without a row or a
// value outside the row's rules is refused (RangeError), and every value written carries a
// provenance label (origin, src/core/provenance.js), which the writer must give.
//
// A change supersedes the home's current value (kept); clearing a key supersedes it with nothing,
// so the default applies again. settingAt() answers "what was in force at moment T": the home's own
// value then, or the registry default when it had none (isDefault true; origin 'sourced' when the
// requirements catalogue backs the default, else 'placeholder').
import { db, tx } from '../db/db.js';
import { checkOrigin } from './provenance.js';
import { checkValue, parseDef, encodeValue, decodeValue } from './value-check.js';

const inForceAt = (ms) => (ms == null ? 'superseded_at IS NULL' : `recorded_at <= ${Math.floor(ms)} AND (superseded_at IS NULL OR superseded_at > ${Math.floor(ms)})`);

// A registry row (JSON columns parsed, default decoded), or null for an unknown key.
export function settingDef(key) {
  const d = parseDef(db.prepare('SELECT * FROM setting_def WHERE key = ?').get(key));
  return d && { ...d, default: decodeValue(d.default_value) };
}

// Registry rows, optionally of one planner (predbat, predheat).
export function settingDefs({ planner = null } = {}) {
  const rows = planner ? db.prepare('SELECT * FROM setting_def WHERE planner = ? ORDER BY key').all(planner) : db.prepare('SELECT * FROM setting_def ORDER BY key').all();
  return rows.map((r) => { const d = parseDef(r); return { ...d, default: decodeValue(d.default_value) }; });
}

function defOf(key) {
  const def = settingDef(key);
  if (!def) throw new RangeError(`unknown setting ${key}: no row in setting_def (a new tunable is one registry row)`);
  return def;
}

/**
 * Record a home's value of one tunable. `origin` is required (user for a value typed in, derived for
 * one the core worked out, ...). null or '' clears the key (the default applies again). An unchanged
 * value and origin write nothing.
 * @returns the setting now in force (settingAt)
 */
export function setSetting(siteId, key, value, { origin, note = null } = {}) {
  const def = defOf(key);
  const v = checkValue(def, value, `setting ${key}`);
  if (v != null) checkOrigin(origin, `setting ${key}`);
  if (!db.prepare('SELECT 1 FROM site WHERE id = ?').get(siteId)) throw new RangeError(`no site ${siteId}`);
  const cur = db.prepare('SELECT value, origin, note, recorded_at FROM site_setting WHERE site_id = ? AND key = ? AND superseded_at IS NULL').get(siteId, key);
  const json = encodeValue(v);
  const unchanged = cur ? cur.value === json && cur.origin === origin : v == null;
  if (unchanged) {
    if (cur && note && cur.note !== note) db.prepare('UPDATE site_setting SET note = ? WHERE site_id = ? AND key = ? AND superseded_at IS NULL').run(note, siteId, key);
    return settingAt(siteId, key);
  }
  const now = Math.max(Date.now(), (cur?.recorded_at ?? 0) + 1);   // versions always move forward
  tx(() => {
    db.prepare('UPDATE site_setting SET superseded_at = ? WHERE site_id = ? AND key = ? AND superseded_at IS NULL').run(now, siteId, key);
    if (v != null) db.prepare('INSERT INTO site_setting (site_id, key, value, origin, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(siteId, key, json, origin, note, now);
  });
  return settingAt(siteId, key);
}

// The home no longer sets this key: the default applies from now (the old value is kept).
export const clearSetting = (siteId, key) => setSetting(siteId, key, null);

/**
 * One tunable of a home as known at atMs (ms; null = now):
 * { key, value, origin, note, recorded_at, isDefault }. Unset: the registry default (origin
 * 'sourced' when backed by the catalogue, else 'placeholder'), recorded_at null.
 */
export function settingAt(siteId, key, atMs = null) {
  const def = defOf(key);
  const r = db.prepare(`SELECT value, origin, note, recorded_at FROM site_setting WHERE site_id = ? AND key = ? AND ${inForceAt(atMs)}`).get(siteId, key);
  if (r) return { key, value: decodeValue(r.value), origin: r.origin, note: r.note, recorded_at: r.recorded_at, isDefault: false };
  return defaultOf(def);
}

// An unset key: the registry default, labelled sourced when the catalogue backs it (refs, not
// unverified), else placeholder.
function defaultOf(def) {
  const sourced = !def.unverified && def.refs?.length > 0;
  return { key: def.key, value: def.default, origin: sourced ? 'sourced' : 'placeholder',
    note: sourced ? `registry default (docs/predbat-predheat-requirements.md ${def.refs.join(', ')})` : 'registry default (unverified)', recorded_at: null, isDefault: true };
}

// Every tunable (optionally of one planner) as known at atMs: { key: settingAt(...) }.
export function settingsAt(siteId, atMs = null, { planner = null } = {}) {
  const own = new Map(db.prepare(`SELECT key, value, origin, note, recorded_at FROM site_setting WHERE site_id = ? AND ${inForceAt(atMs)}`).all(siteId).map((r) => [r.key, r]));
  const out = {};
  for (const d of settingDefs({ planner })) {
    const r = own.get(d.key);
    out[d.key] = r ? { key: d.key, value: decodeValue(r.value), origin: r.origin, note: r.note, recorded_at: r.recorded_at, isDefault: false } : defaultOf(d);
  }
  return out;
}

// Every version a home recorded (optionally of one key), oldest first.
export function settingHistory(siteId, key = null) {
  const rows = key ? db.prepare('SELECT * FROM site_setting WHERE site_id = ? AND key = ? ORDER BY recorded_at').all(siteId, key)
    : db.prepare('SELECT * FROM site_setting WHERE site_id = ? ORDER BY key, recorded_at').all(siteId);
  return rows.map((r) => ({ ...r, value: decodeValue(r.value) }));
}
