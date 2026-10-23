// GB regions: every one of the 14 resolves from each numbering and back again, and NESO
// carbon regions are never reachable from (or aliased to) a distribution region.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveRegion, aliasesOf, buildRegionIndex, normaliseCode } from '../src/core/regions.js';
import { GB_REGIONS, GB_REGION_ALIASES } from '../src/db/seed/regions-gb.js';

// Independent restatement of the three numberings (eb-auth grid-supply-point.ts,
// tariffscan.regions.ts, and the Tariffscanner probe fixture).
const TABLE = [
  ['10', 'A', '1', 'Eastern', 'Eastern England'],
  ['11', 'B', '2', 'East Midlands', 'East Midlands'],
  ['12', 'C', '3', 'London', 'London'],
  ['13', 'D', '4', 'Manweb', 'Merseyside & North Wales'],
  ['14', 'E', '5', 'Midlands', 'West Midlands'],
  ['15', 'F', '6', 'Northern', 'North East England'],
  ['16', 'G', '7', 'Norweb', 'North West England'],
  ['17', 'P', '8', 'Scottish Hydro', 'North Scotland'],
  ['18', 'N', '9', 'Scottish Power', 'South Scotland'],
  ['19', 'J', '10', 'Seeboard', 'South East England'],
  ['20', 'H', '11', 'Southern', 'Southern England'],
  ['21', 'K', '12', 'Swalec', 'South Wales'],
  ['22', 'L', '13', 'SWEB', 'South West England'],
  ['23', 'M', '14', 'Yorkshire', 'Yorkshire'],
];

test('14 regions, 14 Octopus letters (no I or O), 42 aliases', () => {
  assert.equal(GB_REGIONS.length, 14);
  assert.equal(GB_REGION_ALIASES.length, 42);
  const letters = GB_REGION_ALIASES.filter((a) => a.alias_scheme === 'octopus_gsp').map((a) => a.alias_code).sort();
  assert.deepEqual(letters, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P']);
});

for (const [mpan, letter, tsId, tsName, name] of TABLE) {
  test(`round trip ${mpan} / ${letter} / Tariffscanner ${tsId} ${tsName}`, () => {
    const viaMpan = resolveRegion('gb_dno', mpan);
    assert.deepEqual(viaMpan, { scheme: 'gb_dno', code: mpan, country: 'GB', name });
    for (const [scheme, code] of [['octopus_gsp', letter], ['tariffscan_id', tsId], ['tariffscan_name', tsName]]) {
      assert.equal(resolveRegion(scheme, code), viaMpan, `${scheme} ${code}`);
    }
    assert.deepEqual(aliasesOf(viaMpan), [
      { alias_scheme: 'octopus_gsp', alias_code: letter },
      { alias_scheme: 'tariffscan_id', alias_code: tsId },
      { alias_scheme: 'tariffscan_name', alias_code: tsName },
    ]);
    // ... and back: each alias of the region resolves to the same region.
    for (const a of aliasesOf(viaMpan)) assert.equal(resolveRegion(a.alias_scheme, a.alias_code), viaMpan);
  });
}

test('BB12 is Octopus G: North West England, MPAN 16, Tariffscanner Norweb (7)', () => {
  // eb-auth carbon.regions.ts: "postcode BB12 -> carbon region 3 ... Octopus assigns GSP letter G".
  const g = resolveRegion('octopus_gsp', 'G');
  assert.equal(g.code, '16');
  assert.equal(g.name, 'North West England');
  assert.equal(resolveRegion('tariffscan_name', 'Norweb'), g);
  assert.equal(resolveRegion('tariffscan_id', 7), g);
});

test('codes are normalised the way upstream sends them', () => {
  assert.equal(resolveRegion('octopus_gsp', '_g').code, '16');         // Octopus API: "_G"
  assert.equal(resolveRegion('octopus_gsp', ' c ').code, '12');
  assert.equal(resolveRegion('tariffscan_id', '07').code, '16');
  assert.equal(resolveRegion('tariffscan_name', ' Norweb ').code, '16');
  assert.equal(resolveRegion('gb_dno', 16).code, '16');
  assert.equal(normaliseCode('octopus_gsp', '_j'), 'J');
});

test('unknown codes resolve to nothing, never to a guess', () => {
  assert.equal(resolveRegion('octopus_gsp', 'I'), null);
  assert.equal(resolveRegion('octopus_gsp', 'O'), null);
  assert.equal(resolveRegion('gb_dno', '24'), null);
  assert.equal(resolveRegion('tariffscan_id', '15'), null);
  assert.equal(resolveRegion('tariffscan_name', 'Seaboard'), null);
  assert.equal(resolveRegion('octopus_gsp', null), null);
  assert.throws(() => aliasesOf({ scheme: 'gb_dno', code: '99' }), /unknown region/);
});

test('NESO carbon regions are a separate scheme, never aliased to distribution regions', () => {
  // BB12 is carbon region 3 and GSP G; L1 is carbon region 6 and also GSP G: not a function.
  assert.equal(resolveRegion('gb_carbon', '3'), null);
  assert.equal(resolveRegion('gb_carbon', '16'), null);   // a DNO id is not a carbon id
  for (const r of GB_REGIONS) {
    assert.ok(aliasesOf(r).every((a) => !['gb_carbon', 'gb_dno', 'bzn'].includes(a.alias_scheme)));
  }
  const carbon = [{ scheme: 'gb_carbon', code: '3', country: 'GB', name: 'North West England' }];
  assert.throws(() => buildRegionIndex({
    regions: [...GB_REGIONS, ...carbon],
    aliases: [...GB_REGION_ALIASES, { scheme: 'gb_dno', code: '16', alias_scheme: 'gb_carbon', alias_code: '3' }],
  }), /partitions are never aliased/);
  assert.throws(() => buildRegionIndex({
    regions: [...GB_REGIONS, ...carbon],
    aliases: [{ scheme: 'gb_carbon', code: '3', alias_scheme: 'gb_dno', alias_code: '16' }],
  }), /partitions are never aliased/);
  // Even with carbon regions loaded, a carbon code resolves only within its own scheme.
  const idx = buildRegionIndex({ regions: [...GB_REGIONS, ...carbon], aliases: GB_REGION_ALIASES });
  assert.equal(resolveRegion('gb_carbon', '3', idx).scheme, 'gb_carbon');
  assert.equal(resolveRegion('gb_dno', '3', idx), null);
});

test('an alias that points at two regions, or at none, is refused', () => {
  assert.throws(() => buildRegionIndex({
    regions: GB_REGIONS,
    aliases: [...GB_REGION_ALIASES, { scheme: 'gb_dno', code: '12', alias_scheme: 'octopus_gsp', alias_code: 'G' }],
  }), /points at two regions/);
  assert.throws(() => buildRegionIndex({
    regions: GB_REGIONS, aliases: [{ scheme: 'gb_dno', code: '99', alias_scheme: 'octopus_gsp', alias_code: 'Z' }],
  }), /unknown region/);
});

// The Tariffscanner id/name pairs, checked against eb-auth's fixtures when that checkout is
// present (read only). Skipped elsewhere.
const FIXTURE_DIR = '/Users/macbookpro/Desktop/projects/eb-auth/src/modules/tariffscan/data';
const fixtures = ['probe-v1-domestic.json', 'probe-v1-single-product.json'].map((f) => `${FIXTURE_DIR}/${f}`).filter((f) => fs.existsSync(f));
test('Tariffscanner dno_region_id and dno_region agree with the eb-auth fixtures', { skip: fixtures.length ? false : 'eb-auth fixtures not present' }, () => {
  let seen = 0;
  for (const f of fixtures) {
    for (const row of JSON.parse(fs.readFileSync(f, 'utf8')).data ?? []) {
      if (row.dno_region_id == null) continue;
      const byId = resolveRegion('tariffscan_id', row.dno_region_id);
      assert.ok(byId, `id ${row.dno_region_id}`);
      assert.equal(resolveRegion('tariffscan_name', row.dno_region), byId, `${row.dno_region_id} ${row.dno_region}`);
      seen++;
    }
  }
  assert.ok(seen > 0);
});
