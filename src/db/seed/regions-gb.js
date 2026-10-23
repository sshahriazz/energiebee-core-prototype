// The 14 GB electricity distribution regions (GSP groups), with every numbering the core meets.
//
// Canonical: scheme 'gb_dno', code = MPAN distributor id 10-23 (the industry numbering, and the
// region id eb-auth stores). Aliases, each its own alias_scheme:
//   octopus_gsp       Octopus GSP group letter A-P (I and O are never issued). The Octopus API
//                     returns it with a leading underscore ('_C'); regions.js strips it.
//   tariffscan_name   Tariffscanner dno_region: the legacy DNO brand names (Norweb, Seeboard, ...)
//   tariffscan_id     Tariffscanner dno_region_id 1-14. Undocumented upstream: taken from the
//                     probe fixtures, where all 14 id/name pairs are observed (alphabetical by
//                     name). Match by name first, as eb-auth does.
// Sources (read only): eb-auth src/lib/grid-supply-point.ts (letter -> id),
// src/modules/tariffs/tariffs.schema.ts REGION_NAMES (names),
// src/modules/tariffscan/tariffscan.regions.ts (Tariffscanner name -> id) and
// src/modules/tariffscan/data/probe-v1-*.json (Tariffscanner id <-> name).
//
// NESO carbon regions (Carbon Intensity API ids 1-17, scheme 'gb_carbon') divide the country
// differently: postcodes BB12 and L1 are both GSP 'G' but carbon regions 3 and 6. They are a
// separate scheme and are NEVER aliased to these regions (regions.js and delta 003 refuse it).

//  MPAN  letter  Tariffscanner id, name    name
const GB_DNO = [
  ['10', 'A', 1, 'Eastern', 'Eastern England'],
  ['11', 'B', 2, 'East Midlands', 'East Midlands'],
  ['12', 'C', 3, 'London', 'London'],
  ['13', 'D', 4, 'Manweb', 'Merseyside & North Wales'],
  ['14', 'E', 5, 'Midlands', 'West Midlands'],
  ['15', 'F', 6, 'Northern', 'North East England'],
  ['16', 'G', 7, 'Norweb', 'North West England'],
  ['17', 'P', 8, 'Scottish Hydro', 'North Scotland'],
  ['18', 'N', 9, 'Scottish Power', 'South Scotland'],
  ['19', 'J', 10, 'Seeboard', 'South East England'],
  ['20', 'H', 11, 'Southern', 'Southern England'],
  ['21', 'K', 12, 'Swalec', 'South Wales'],
  ['22', 'L', 13, 'SWEB', 'South West England'],
  ['23', 'M', 14, 'Yorkshire', 'Yorkshire'],
];

// Provenance: 'sourced', from the files named above (delta 005 uses the same note).
export const GB_REGION_NOTE = 'MPAN distributor ids 10-23 with Octopus GSP letters (eb-auth src/lib/grid-supply-point.ts) and Tariffscanner names and ids (eb-auth tariffscan.regions.ts, probe-v1 fixtures)';
export const GB_REGIONS = Object.freeze(GB_DNO.map(([code, , , , name]) => Object.freeze({ scheme: 'gb_dno', code, country: 'GB', name, origin: 'sourced', origin_note: GB_REGION_NOTE })));

export const GB_REGION_ALIASES = Object.freeze(GB_DNO.flatMap(([code, letter, tsId, tsName]) => [
  { scheme: 'gb_dno', code, alias_scheme: 'octopus_gsp', alias_code: letter },
  { scheme: 'gb_dno', code, alias_scheme: 'tariffscan_id', alias_code: String(tsId) },
  { scheme: 'gb_dno', code, alias_scheme: 'tariffscan_name', alias_code: tsName },
].map((a) => Object.freeze(a))));

// Writes the rows into a database that has delta 003 applied (any node:sqlite DatabaseSync).
export function seedRegionsGb(db) {
  const region = db.prepare(`INSERT INTO region (scheme, code, country, name, origin, origin_note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (scheme, code) DO UPDATE SET country = excluded.country, name = excluded.name, origin = excluded.origin, origin_note = excluded.origin_note`);
  const alias = db.prepare(`INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES (?, ?, ?, ?)
    ON CONFLICT (alias_scheme, alias_code) DO UPDATE SET scheme = excluded.scheme, code = excluded.code`);
  for (const r of GB_REGIONS) region.run(r.scheme, r.code, r.country, r.name, r.origin, r.origin_note);
  for (const a of GB_REGION_ALIASES) alias.run(a.scheme, a.code, a.alias_scheme, a.alias_code);
}
