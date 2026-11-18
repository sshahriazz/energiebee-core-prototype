// Phase T.1 and T.2 on the synthetic homes: the seven topology homes (flat GB prices, standing charge, export) and the three
// multi-market homes (GB flat then day/night, with the clock change; French HP/HC with the meter's own hours and a monthly
// subscription, then Tempo with its calendar, over the 23-hour day; Dutch quarter-hour spot prices with a monthly and a daily
// fixed charge and the placeholder tax rules, over the 25-hour day). For every slot at 15, 30 and 60 minutes, the price taken from
// runs and the fixed share are the recorded ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';
import { diffHome } from './price-runs-lib.js';
import { addDays } from '../src/core/time.js';

await useDb();
const T = await import('../scripts/lib/topologies.js');
const M = await import('../scripts/lib/multi-market.js');

for (const name of Object.keys(T.TOPOLOGIES)) {
  await test(`topology ${name}: slot prices and fixed shares from runs are the recorded ones`, async () => {
    const t = await T.buildTopology(name);
    const seen = await diffHome(t.site.id, addDays(T.FROM, -1), addDays(T.TO, 1), { label: `topology ${name}` });
    assert.ok(seen.priced > 0 && seen.fixed > 0, JSON.stringify(seen));
  });
}

const homes = await M.buildScenario();
for (const [label, home, w, expects] of [
  ['GB flat then day/night', homes.gb, M.GB, (s) => s.registers['windows/night'] > 0 && s.registers['flat/single'] > 0],
  ['FR HP/HC with the meter\'s own hours, then Tempo', homes.fr, M.FR, (s) => s.registers['windows/hc'] > 0 && s.registers['windows/blue_hc'] > 0],
  ['NL quarter-hour spot prices with fixed charges and taxes', homes.nl, M.NL, (s) => s.weighted > 0],
]) {
  await test(`${label}: slot prices and fixed shares from runs are the recorded ones`, async () => {
    const seen = await diffHome(home.site.id, addDays(w.from, -1), addDays(w.to, 1), { label: `market ${label}` });
    assert.ok(seen.priced > 0 && seen.fixed > 0 && expects(seen), JSON.stringify(seen));
  });
}
