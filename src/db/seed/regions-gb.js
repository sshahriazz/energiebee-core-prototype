// The 14 GB electricity distribution regions (GSP groups), with every numbering the core meets.
//
// Canonical: scheme 'gb_dno', code = MPAN distributor id 10-23 (the industry numbering: the first
// two digits of an MPAN core). Aliases, each its own alias_scheme:
//   octopus_gsp       Octopus GSP group letter A-P (I and O are never issued). The Octopus API
//                     returns it with a leading underscore ('_C'); regions.js strips it.
//   tariffscan_name   Tariffscanner dno_region: the legacy DNO brand names (Norweb, Seeboard, ...)
//   tariffscan_id     Tariffscanner dno_region_id 1-14, NOT the MPAN numbering. Undocumented
//                     upstream; the ids run in alphabetical order of the names (ignoring case and
//                     spaces). The saved live samples in test/fixtures/tariffscanner/*.json show 10
//                     of the 14 id/name pairs (ids 1, 4, 5, 6, 7, 9, 11, 12, 13, 14), each checked
//                     by test/regions-gb.test.js; 2 East Midlands, 3 London, 8 Scottish Hydro and
//                     10 Seeboard are not in a saved sample. The adapter matches by name first and
//                     skips a record whose name and id disagree, so a wrong id is refused, not used.
// Sources: the Octopus GSP letters, the MPAN distributor ids, and the Tariffscanner region ids and
// names as captured in test/fixtures/tariffscanner/ (origin 'sourced').
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

// Provenance: 'sourced', from the sources named above (delta 005 uses the same note).
export const GB_REGION_NOTE = 'MPAN distributor ids 10-23 with the Octopus GSP letters A-P, and the Tariffscanner dno_region_id 1-14 and dno_region names as captured in test/fixtures/tariffscanner/ (saved live samples; 10 of the 14 id/name pairs observed there)';
export const GB_REGIONS = Object.freeze(GB_DNO.map(([code, , , , name]) => Object.freeze({ scheme: 'gb_dno', code, country: 'GB', name, origin: 'sourced', origin_note: GB_REGION_NOTE })));

export const GB_REGION_ALIASES = Object.freeze(GB_DNO.flatMap(([code, letter, tsId, tsName]) => [
  { scheme: 'gb_dno', code, alias_scheme: 'octopus_gsp', alias_code: letter },
  { scheme: 'gb_dno', code, alias_scheme: 'tariffscan_id', alias_code: String(tsId) },
  { scheme: 'gb_dno', code, alias_scheme: 'tariffscan_name', alias_code: tsName },
].map((a) => Object.freeze(a))));

// Writes the rows into a database that has delta 003 applied (any node:sqlite DatabaseSync).
// Inserts only the regions and aliases that are missing. An existing row is never changed: a
// region's name, or the region an alias points to, stays as an operator set it (an alias is never
// moved to another region silently). Returns the number of rows written.
export function seedRegionsGb(db) {
  const region = db.prepare(`INSERT INTO region (scheme, code, country, name, origin, origin_note) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (scheme, code) DO NOTHING`);
  const alias = db.prepare(`INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES (?, ?, ?, ?)
    ON CONFLICT (alias_scheme, alias_code) DO NOTHING`);
  const { regions, aliases } = missingGb(db);
  let n = 0;
  for (const r of regions) n += Number(region.run(r.scheme, r.code, r.country, r.name, r.origin, r.origin_note).changes);
  for (const a of aliases) n += Number(alias.run(a.scheme, a.code, a.alias_scheme, a.alias_code).changes);
  return n;
}
function missingGb(db) {
  const haveRegion = new Set(db.prepare("SELECT code FROM region WHERE scheme = 'gb_dno'").all().map((r) => r.code));
  const haveAlias = new Set(db.prepare('SELECT alias_scheme, alias_code FROM region_alias').all().map((r) => `${r.alias_scheme}|${r.alias_code}`));
  return { regions: GB_REGIONS.filter((r) => !haveRegion.has(r.code)), aliases: GB_REGION_ALIASES.filter((a) => !haveAlias.has(`${a.alias_scheme}|${a.alias_code}`)) };
}
// True when seedRegionsGb would write a row (read only).
export function regionSeedPending(db) {
  const { regions, aliases } = missingGb(db);
  return regions.length > 0 || aliases.length > 0;
}
