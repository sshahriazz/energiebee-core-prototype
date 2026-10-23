// The tariff comparison (src/core/compare.js) outside GB: no Octopus tariff code or region letter
// is built, the alternatives are the other tariffs of the home's market, priced by the same engine
// (quarter-hour slots, the home's currency, its country's taxes), and nothing is fetched.
// Synthetic homes in a new, empty database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { createTariff, putRateRows } = await import('../src/core/tariffs.js');
const { compareSite, syncComparison, octopusRegion } = await import('../src/core/compare.js');
const { dayBounds, addDays } = await import('../src/core/time.js');
const { fixedChargeMicro } = await import('../src/core/tariff-expand.js');

const homes = m.buildScenario();
const nlSite = m.siteRow(homes.nl.site.id);
const frSite = m.siteRow(homes.fr.site.id);
const gbSite = m.siteRow(homes.gb.site.id);
// An alternative Dutch tariff: a flat 25 c/kWh with no fixed fee (synthetic).
const flat = createTariff({ provider: 'synthetic', tariffCode: 'SYN-NL-FLAT', country: 'NL', currency: 'EUR', structure: 'flat', kind: 'flat', name: 'Synthetic NL flat', origin: 'synthetic' });
putRateRows(flat.id, [{ component: 'unit', validFrom: dayBounds(m.NL.tz, m.NL.from)[0], validTo: dayBounds(m.NL.tz, addDays(m.NL.to, 1))[0], price: 25 }]);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('NL: the other tariff of the market is compared in euros, on quarter-hours, with the home\'s taxes', () => {
  const c = compareSite(nlSite.id, m.NL.from, m.NL.to);
  assert.equal(c.ready, true);
  assert.deepEqual([c.currency, c.slot_s, c.market, c.primaryKey, c.primaryName], ['EUR', 900, 'NL', 'alt:SYN-NL-FLAT', 'Synthetic NL flat']);
  assert.deepEqual(c.scenarios.map((x) => [x.key, x.import]), [['current', 'SYN-NL-DYNAMIC'], ['alt:SYN-NL-FLAT', 'SYN-NL-FLAT']]);
  assert.ok(!JSON.stringify(c.scenarios).includes('E-1R-'), 'no Octopus tariff code anywhere');
  const rows = m.hhRows(nlSite.id, m.NL.from, m.NL.to);
  assert.equal(c.slots.length, rows.length);
  assert.equal(c.profile.length, 96, '96 quarter-hours in the average day');
  // Every quarter-hour on the flat tariff: (25 + energy tax 10.154) x 1.21 (placeholder taxes).
  for (const s of c.slots) near(s.agile, (25 + 10.154) * 1.21, 1e-9, `slot ${s.slot_start}`);
  // ... and the home's own price is what the build charged.
  const byStart = new Map(rows.map((r) => [r.slot_start, r]));
  for (const s of c.slots) near(s.current, m.inc(byStart.get(s.slot_start)), 1e-9, 'current');
  const alt = c.scenarios[1];
  near(alt.importCost, rows.reduce((t, r) => t + r.grid_import * (25 + 10.154) * 1.21, 0), 1e-6, 'import cost');
  // No fixed fee on the flat tariff: only the yearly tax credit, with BTW, by each day's real length.
  const credit = m.dayRows(nlSite.id, m.NL.from, m.NL.to).reduce((t, d) => { const [a, b] = dayBounds(m.NL.tz, d.local_date); return t - 63519 * ((b - a) / (365 * 86400)) * 1.21; }, 0);
  near(alt.standing, credit, 1e-6, 'fixed');
  near(c.scenarios[0].standing, m.dayRows(nlSite.id, m.NL.from, m.NL.to).reduce((t, d) => t + d.standing_cost, 0), 1e-6, 'own fixed charges');
  assert.equal(c.daily.length, 3);
  assert.ok(c.daily.every((d) => d.agile === d['alt:SYN-NL-FLAT']));
  // Money in the insights is in euros and cents, and slots are quarter-hours.
  assert.ok(c.insights.some((i) => /€/.test(i.title)));
  assert.ok(!c.insights.some((i) => /£|\bp\/kWh|Agile/.test(`${i.title} ${i.detail}`)));
  assert.match(c.insights.at(-1).detail, /quarter-hour/);
  // Provenance of each scenario: synthetic prices, placeholder taxes.
  assert.deepEqual(c.scenarios.map((x) => x.origin), ['synthetic', 'synthetic']);
  assert.ok(c.provenance.placeholders.includes('tax_rule NL/energiebelasting [placeholder]'));
});

test('FR: with no other tariff of the market held, the comparison says so (no Octopus fallback)', () => {
  const c = compareSite(frSite.id, m.FR.from, m.FR.to);
  assert.deepEqual([c.ready, c.currency, c.slot_s], [false, 'EUR', 1800]);
  assert.match(c.reason, /No other tariffs of market FR/);
});

test('outside GB there is no Octopus region and nothing is fetched', async () => {
  assert.equal(octopusRegion(nlSite), null);
  assert.equal(octopusRegion(frSite), null);
  assert.deepEqual(await syncComparison(nlSite, 0, 1), { skipped: 'no reference catalogue for market NL' });
  // GB: the letter comes from the home (or its distribution region's alias), and without fetched
  // products the GB comparison is not ready, as before.
  assert.equal(octopusRegion(gbSite), 'G');
  assert.equal(octopusRegion({ ...gbSite, gsp_region: null }), 'G', 'from gb_dno 16 -> octopus_gsp G');
  const c = compareSite(gbSite.id, m.GB.from, m.GB.to);
  assert.deepEqual([c.ready, c.reason], [false, 'Comparison prices have not been fetched yet. Press Sync.']);
});
