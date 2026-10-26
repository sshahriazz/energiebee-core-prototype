// "As known at" for the home and tariff settings that change results (H5): the versions kept in
// site_version and tariff_version (delta 022, written by triggers on every change). The site and
// tariff rows stay the current values; these answer "what were they at moment T".
//
// Before a row's first version (a moment earlier than the home's creation, or than when the core
// first knew a tariff) the first version is used and flagged `approximate` (its recorded_at): the
// values before it were not kept. Without any version (a database where delta 022 has not run) the
// current row is used, flagged the same way.
import { db } from '../db/db.js';

const atClause = (ms) => `recorded_at <= ${Math.floor(ms)} AND (superseded_at IS NULL OR superseded_at > ${Math.floor(ms)})`;
const META = new Set(['site_id', 'tariff_id', 'recorded_at', 'superseded_at']);
const columnsOf = (table) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name).filter((c) => !META.has(c));

// The version of one row in force at atMs, else its first one (flagged), else null.
function versionAt(table, idCol, id, atMs) {
  const v = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND ${atClause(atMs)}`).get(id);
  if (v) return { v, approximate: null };
  const first = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? ORDER BY recorded_at LIMIT 1`).get(id);
  return first ? { v: first, approximate: first.recorded_at } : null;
}
const pick = (v, cols) => Object.fromEntries(cols.map((c) => [c, v[c]]));

/**
 * The home's row as known at atMs (ms; null = now): today's row with every versioned column
 * (zone, slot length, currency, market, regions, location, sizes, contracted capacity) as it stood
 * then. Extra fields: settingsRecordedAt (the version used) and approximateSettings (null, or the
 * time of the first version when atMs is earlier than every kept version).
 */
export function siteAt(siteId, atMs = null) {
  const cur = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!cur) return null;
  if (atMs == null) return { ...cur, settingsRecordedAt: null, approximateSettings: null };
  const hit = versionAt('site_version', 'site_id', siteId, atMs);
  if (!hit) return { ...cur, settingsRecordedAt: null, approximateSettings: Date.now() };
  return { ...cur, ...pick(hit.v, columnsOf('site_version')), settingsRecordedAt: hit.v.recorded_at, approximateSettings: hit.approximate };
}

/**
 * A tariff's pricing columns as known at atMs (structure, region, kind, currency, country,
 * native_period_s, taxes_in_price, default_register, fuel, direction, origin), with recorded_at and
 * approximate as above; null for an unknown tariff.
 */
export function tariffAt(tariffId, atMs = null) {
  const cur = db.prepare('SELECT * FROM tariff WHERE id = ?').get(tariffId);
  if (!cur) return null;
  const cols = columnsOf('tariff_version');
  if (atMs == null) return { ...pick(cur, cols), recordedAt: null, approximate: null };
  const hit = versionAt('tariff_version', 'tariff_id', tariffId, atMs);
  if (!hit) return { ...pick(cur, cols), recordedAt: null, approximate: Date.now() };
  return { ...pick(hit.v, cols), recordedAt: hit.v.recorded_at, approximate: hit.approximate };
}

// The fields of a pricing agreement row (pricing.js loadPricing) that come from the tariff, as
// known at atMs. Agreement rows alias tariff.kind as tariff_kind and tariff.origin as tariff_origin.
export function tariffFlagsAt(tariffId, atMs) {
  const t = tariffAt(tariffId, atMs);
  if (!t) return {};
  return { structure: t.structure, currency: t.currency, tariff_kind: t.kind, tariff_origin: t.origin, taxes_in_price: t.taxes_in_price, fuel: t.fuel, direction: t.direction };
}

// Every kept version, oldest first.
export const siteVersions = (siteId) => db.prepare('SELECT * FROM site_version WHERE site_id = ? ORDER BY recorded_at').all(siteId);
export const tariffVersions = (tariffId) => db.prepare('SELECT * FROM tariff_version WHERE tariff_id = ? ORDER BY recorded_at').all(tariffId);
