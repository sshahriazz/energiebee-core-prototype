// The trust view (src/core/trust.js) on a copy of the frozen GB fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
if (hasLive) await useDb({ snapshot: true });
const m = { ...(await import('../src/db/db.js')), ...(await import('../src/core/build.js')), ...(await import('../src/core/time.js')) };
const SITE = 1;
const site = async () => await m.db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const firstDay = async () => (await m.db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = ?').get(SITE)).d;
const today = async () => m.localDate((await site()).timezone, m.nowSec());
const fullBuild = async (reason) => await m.buildSite(SITE, await firstDay(), await today(), { reason });
await test('trust view: one cell per half-hour per feed, states add up, and every day balances', { skip }, async () => {
  const { trustFor } = await import('../src/core/trust.js');
  await fullBuild('test');
  // The last week of the fixture's data: the fixture is frozen while the clock moves on.
  const end = (await m.db.prepare("SELECT MAX(local_date) AS d FROM site_hh WHERE site_id = ? AND state != 'missing'").get(SITE)).d;
  const to = end; const from = m.addDays(to, -6);
  const t = await trustFor(SITE, from, to);
  for (const f of t.feeds) assert.equal(f.cells.length, t.slots, f.key);
  const h = t.headline;
  assert.equal(h.final + h.provisional + h.missing, h.halfHours);
  assert.equal(h.factsLinked, h.facts, 'every provider fact links to its raw payload');
  for (const b of t.balance) {
    const inn = b.in.solar + b.in.grid + b.in.battery;
    const out = b.to.home + b.to.grid + b.to.battery + b.to.inverter;
    assert.ok(Math.abs(inn - out) < 1e-6, `${b.date}: in ${inn} vs out ${out}`);
  }
});
