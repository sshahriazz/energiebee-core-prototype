// Every site_hh column has a stated aggregation class (column_class, delta 070): a column added later cannot
// reach a group view without saying how it combines. And the builder writes the currency of each slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { loadClasses } = await import('../src/core/groups.js');
const { buildSite } = await import('../src/core/build.js');
const { nowSec, localDate, addDays } = await import('../src/core/time.js');

await test('every site_hh column has an aggregation class, and every class row names a real column', { skip }, async () => {
  const cols = (await db.prepare("SELECT name FROM pragma_table_info('site_hh')").all()).map((c) => c.name);
  const classes = await loadClasses();
  assert.deepEqual(cols.filter((c) => !classes.has(c)), [], 'columns without a class');
  assert.deepEqual([...classes.keys()].filter((c) => !cols.includes(c)), [], 'classes for columns that do not exist');
  for (const [name, { cls, weightBy }] of classes) {
    if (cls === 'price' || cls === 'intensity') assert.ok(weightBy && classes.get(weightBy)?.cls === 'energy', `${name} is weighted by an energy column`);
  }
});

await test('the builder writes the currency of each slot, and the stored rows were backfilled', { skip }, async () => {
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM site_hh WHERE currency IS NULL').get()).n, 0, 'no stored slot without a currency');
  const site = await db.prepare('SELECT id, timezone, currency FROM site WHERE id = 1').get();
  const first = (await db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = 1').get()).d;
  const res = await buildSite(1, first, addDays(localDate(site.timezone, nowSec()), -1), { asOf: nowSec() + 1, dryRun: true });
  assert.ok(res.hhRows.length > 100);
  assert.ok(res.hhRows.every((r) => r.currency === site.currency), 'every built slot carries the home\'s currency');
});
