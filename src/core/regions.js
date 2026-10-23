// Regions: one shape for every way a country is divided (GB distribution regions, NESO carbon
// regions, bidding zones, ...). A region is (scheme, code); each scheme is its own partition of
// the map. Other numberings of the SAME partition (Octopus letters, Tariffscanner ids/names)
// are aliases: (alias_scheme, alias_code) -> one region. Two different partitions are never
// aliased to each other, because they do not line up (GB: BB12 and L1 share GSP 'G' but are in
// different NESO carbon regions), so no lookup could be right.
import { GB_REGIONS, GB_REGION_ALIASES } from '../db/seed/regions-gb.js';

// Schemes that are partitions in their own right: never usable as an alias of another.
export const PARTITION_SCHEMES = Object.freeze(['gb_dno', 'gb_carbon', 'bzn']);

const numeric = (c) => (/^\d+$/.test(c) ? String(Number(c)) : c);
const NORMALISE = {
  octopus_gsp: (c) => c.replace(/^_/, '').toUpperCase(),   // the Octopus API answers '_C'
  tariffscan_id: numeric,
  gb_dno: numeric,
  gb_carbon: numeric,
};

export function normaliseCode(scheme, code) {
  const c = String(code).trim();
  return NORMALISE[scheme] ? NORMALISE[scheme](c) : c;
}

const key = (scheme, code) => `${scheme}\u0000${code}`;

// Builds a lookup from region and alias rows (seed objects or region / region_alias rows).
export function buildRegionIndex({ regions, aliases = [] }) {
  const byKey = new Map();
  const byAlias = new Map();
  const aliasesByRegion = new Map();
  const schemes = new Set(regions.map((r) => r.scheme));
  for (const r of regions) {
    const k = key(r.scheme, normaliseCode(r.scheme, r.code));
    if (byKey.has(k)) throw new Error(`region ${r.scheme}/${r.code} given twice`);
    byKey.set(k, Object.freeze({ scheme: r.scheme, code: r.code, country: r.country ?? null, name: r.name ?? null }));
  }
  for (const a of aliases) {
    if (PARTITION_SCHEMES.includes(a.alias_scheme) || schemes.has(a.alias_scheme)) {
      throw new Error(`${a.alias_scheme} is a region scheme of its own: partitions are never aliased (${a.scheme}/${a.code})`);
    }
    const region = byKey.get(key(a.scheme, normaliseCode(a.scheme, a.code)));
    if (!region) throw new Error(`alias ${a.alias_scheme}/${a.alias_code} points at unknown region ${a.scheme}/${a.code}`);
    const ak = key(a.alias_scheme, normaliseCode(a.alias_scheme, a.alias_code));
    if (byAlias.has(ak) && byAlias.get(ak) !== region) throw new Error(`alias ${a.alias_scheme}/${a.alias_code} points at two regions`);
    byAlias.set(ak, region);
    const list = aliasesByRegion.get(region) ?? [];
    list.push(Object.freeze({ alias_scheme: a.alias_scheme, alias_code: normaliseCode(a.alias_scheme, a.alias_code) }));
    aliasesByRegion.set(region, list);
  }
  return { byKey, byAlias, aliasesByRegion, schemes };
}

const DEFAULT_INDEX = buildRegionIndex({ regions: GB_REGIONS, aliases: GB_REGION_ALIASES });

// The canonical region for a code in any scheme it is known by, or null when unknown.
// A partition scheme (gb_dno, gb_carbon, ...) is looked up only as itself, never via an alias.
export function resolveRegion(scheme, code, index = DEFAULT_INDEX) {
  if (code == null || code === '') return null;
  const c = normaliseCode(scheme, code);
  if (index.schemes.has(scheme) || PARTITION_SCHEMES.includes(scheme)) return index.byKey.get(key(scheme, c)) ?? null;
  return index.byAlias.get(key(scheme, c)) ?? null;
}

// Every other numbering of a region: [{ alias_scheme, alias_code }], sorted by scheme.
export function aliasesOf(region, index = DEFAULT_INDEX) {
  const r = region && index.byKey.get(key(region.scheme, normaliseCode(region.scheme, region.code)));
  if (!r) throw new RangeError(`unknown region ${region?.scheme}/${region?.code}`);
  return [...(index.aliasesByRegion.get(r) ?? [])].sort((a, b) => a.alias_scheme.localeCompare(b.alias_scheme) || a.alias_code.localeCompare(b.alias_code));
}
