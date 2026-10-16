// The trust view (src/core/trust.js) on an untouched copy of data/core.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const m = hasLive ? { ...(await import('../src/db/db.js')), ...(await import('../src/core/build.js')), ...(await import('../src/core/time.js')) } : {};
const SITE = 1;
const site = () => m.db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const firstDay = () => m.db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = ?').get(SITE).d;
const today = () => m.localDate(site().timezone, m.nowSec());
const fullBuild = (reason) => m.buildSite(SITE, firstDay(), today(), { reason });
test('trust view: one cell per half-hour per feed, states add up, and every day balances', { skip }, async () => {
  const { trustFor } = await import('../src/core/trust.js');
  fullBuild('test');
  const to = today(); const from = m.addDays(to, -6);
  const t = trustFor(SITE, from, to);
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
