// Phase T.1 and T.2 on the frozen real GB home: the slot price taken from price runs and the fixed share equal the rate-row
// path (priceOver, fixedOver) for every slot at 15, 30 and 60 minutes, across the clock change on 25 October 2026 (a
// 25-hour day). The agreements of the fixture are Intelligent Octopus (day, night, dispatches), a fixed export tariff and gas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';
import { diffHome } from './price-runs-lib.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
if (hasLive) await useDb({ snapshot: true });

await test('GB home: every slot at 15, 30 and 60 minutes prices and charges the same from runs as from rate rows', { skip }, async () => {
  // From early August: a tariff with no rate rows (no price), the change to Intelligent Octopus, then the data's own fortnight.
  const seen = await diffHome(1, '2026-08-05', '2026-10-27');
  assert.ok(seen.priced > 10000 && seen.unpriced > 100 && seen.weighted > 0 && seen.mixed > 0 && seen.fixed > 10000, JSON.stringify(seen));
});
