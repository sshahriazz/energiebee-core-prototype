// Homes: created with the market they are in (country, currency, clock, slot length), placed in
// regions, and given a new slot length when asked (which queues a rebuild of every day).
import { db, tx } from '../db/db.js';
import { nowSec, SLOT_LENGTHS, dayBounds, localDate } from './time.js';
import { factSpan } from './build.js';
import { checkOrigin } from './provenance.js';
import { getMarket, defaultSlotFor } from './markets.js';
import { markDirty } from './facts.js';
import { currency as currencyOf } from './money.js';
import { resolveRegion } from './regions.js';

// A market row as stored (seeded from src/db/seed/markets.js), falling back to the seed list.
function marketRow(code) {
  return db.prepare('SELECT * FROM market WHERE code = ?').get(code) ?? getMarket(code);
}

/**
 * Create a home. Defaults are those of the home configured in .env: market GB, so country GB,
 * pounds, Europe/London and half-hour slots. For another market every default follows that
 * market (FR: EUR, Europe/Paris, 1800 s; NL: EUR, Europe/Amsterdam, 900 s).
 * A currency other than the market's, or a slot length other than 900/1800/3600, is refused.
 * @returns the new site row
 */
export function createSite({
  name, postcode = null, country = null, market = null, currency = null, timezone = null, slotS = null,
  envKey = null, isDemo = false, lat = null, lon = null, pvKwp = null, batteryKwh = null, gspRegion = null, carbonRegion = null,
} = {}) {
  if (!name) throw new Error('a home needs a name');
  const m = marketRow(market ?? country ?? 'GB');
  if (country && country !== m.country) throw new Error(`country ${country} is not in market ${m.code} (${m.country})`);
  const cur = currency ?? m.currency;
  currencyOf(cur);
  if (cur !== m.currency) throw new Error(`a home in market ${m.code} is billed in ${m.currency}, not ${cur} (no FX)`);
  const slot = slotS == null ? defaultSlotFor(m) : Number(slotS);
  if (!SLOT_LENGTHS.includes(slot)) throw new Error(`slot length must be one of ${SLOT_LENGTHS.join(', ')} s, not ${slotS}`);
  const tz = timezone ?? m.timezone;
  new Intl.DateTimeFormat('en', { timeZone: tz });   // throws on an unknown zone
  const r = db.prepare(`INSERT INTO site (name, postcode, lat, lon, timezone, gsp_region, carbon_region, pv_kwp, battery_kwh, slot_s,
      is_demo, env_key, created_at, country, market_code, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, postcode, lat, lon, tz, gspRegion, carbonRegion, pvKwp, batteryKwh, slot, isDemo ? 1 : 0, envKey, nowSec(), m.country, m.code, cur);
  return db.prepare('SELECT * FROM site WHERE id = ?').get(Number(r.lastInsertRowid));
}

/**
 * Change a home's slot length (900, 1800 or 3600 s) and queue a rebuild of the days it has: from
 * its first built day (never before its first energy data) to its last built or data day (today
 * for a live home), so the timeline never mixes lengths and no empty days are built. Facts are
 * untouched: only the serving rows are cut differently.
 * @returns {{ slot_s: number, previous: number, queued: boolean }}
 */
export function setSlotLength(siteId, slotS) {
  const s = Number(slotS);
  if (!SLOT_LENGTHS.includes(s)) throw new RangeError(`slot_s must be one of ${SLOT_LENGTHS.join(', ')}, not ${slotS}`);
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  if (site.slot_s === s) return { slot_s: s, previous: s, queued: false };
  const days = db.prepare('SELECT MIN(local_date) AS first, MAX(local_date) AS last FROM site_day WHERE site_id = ?').get(siteId);
  const first = days?.first;
  // The end of the last day with serving rows or energy data, and never past now.
  const span = factSpan(siteId);
  const lastDate = [days?.last, span.last != null ? localDate(site.timezone, span.last) : null].filter(Boolean).sort().pop();
  const end = lastDate ? Math.min(dayBounds(site.timezone, lastDate)[1], nowSec()) : nowSec();
  tx(() => {
    db.prepare('UPDATE site SET slot_s = ? WHERE id = ?').run(s, siteId);
    if (first) markDirty(siteId, dayBounds(site.timezone, first)[0], Math.max(end, dayBounds(site.timezone, first)[0] + 1), `slot length changed from ${site.slot_s} to ${s} s`);
  });
  return { slot_s: s, previous: site.slot_s, queued: !!first };
}

/**
 * The home's contracted capacity (kW or kVA, as its tariff prices it: a French "puissance
 * souscrite", a capacity-based network fee), with where the figure came from. Capacity rate rows
 * are priced per unit of it (src/core/pricing.js). Queues a rebuild of the built days.
 */
export function setContractedCapacity(siteId, kva, { origin, note = null } = {}) {
  if (kva != null && !(Number(kva) > 0)) throw new RangeError(`contracted capacity must be a positive number, not ${kva}`);
  if (kva != null) checkOrigin(origin, 'contracted capacity');
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const days = db.prepare('SELECT MIN(local_date) AS first, MAX(local_date) AS last FROM site_day WHERE site_id = ?').get(siteId);
  tx(() => {
    db.prepare('UPDATE site SET contracted_kva = ?, contracted_kva_origin = ?, contracted_kva_note = ? WHERE id = ?')
      .run(kva == null ? null : Number(kva), kva == null ? null : origin, kva == null ? null : note, siteId);
    if (days?.first) markDirty(siteId, dayBounds(site.timezone, days.first)[0], Math.min(dayBounds(site.timezone, days.last)[1], nowSec()), 'contracted capacity changed');
  });
  return db.prepare('SELECT contracted_kva, contracted_kva_origin, contracted_kva_note FROM site WHERE id = ?').get(siteId);
}

/**
 * Place a home in a region of one scheme (gb_dno, gb_carbon, bzn, ...), versioned: a correction
 * supersedes the current row (kept). The code may be given in any numbering the region is known
 * by (an Octopus letter 'G', a Tariffscanner name), via `alias`.
 */
export function assignRegion(siteId, { scheme, code = null, alias = null, source }) {
  let region = null;
  if (alias) region = resolveRegion(alias.scheme, alias.code);
  const sch = region?.scheme ?? scheme;
  const c = region?.code ?? code;
  if (!sch || c == null) throw new Error(`no region for ${JSON.stringify(alias ?? { scheme, code })}`);
  if (!db.prepare('SELECT 1 FROM region WHERE scheme = ? AND code = ?').get(sch, c)) throw new Error(`unknown region ${sch}/${c}`);
  const now = Math.max(Date.now(), (db.prepare('SELECT MAX(recorded_at) AS t FROM site_region WHERE site_id = ? AND scheme = ?').get(siteId, sch)?.t ?? 0) + 1);
  tx(() => {
    db.prepare('UPDATE site_region SET superseded_at = ? WHERE site_id = ? AND scheme = ? AND superseded_at IS NULL').run(now, siteId, sch);
    db.prepare('INSERT INTO site_region (site_id, scheme, code, source, recorded_at) VALUES (?, ?, ?, ?, ?)').run(siteId, sch, String(c), source, now);
  });
  return db.prepare(`SELECT sr.scheme, sr.code, r.name, r.country FROM site_region sr JOIN region r ON r.scheme = sr.scheme AND r.code = sr.code
    WHERE sr.site_id = ? AND sr.scheme = ? AND sr.superseded_at IS NULL`).get(siteId, sch);
}

// The regions a home is in now, one per scheme, each with the origin of the region row.
export function regionsOf(siteId) {
  return db.prepare(`SELECT sr.scheme, sr.code, r.name, r.country, sr.source, r.origin, r.origin_note FROM site_region sr JOIN region r ON r.scheme = sr.scheme AND r.code = sr.code
    WHERE sr.site_id = ? AND sr.superseded_at IS NULL ORDER BY sr.scheme`).all(siteId);
}
