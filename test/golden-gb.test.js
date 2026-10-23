// Safety net for the slot/currency/region work: the GB home's numbers must not move.
// The golden file holds a hash and totals of a dry-run build "as known at" a fixed moment, so later
// data never changes the answer. Regenerate only on purpose: UPDATE_GOLDEN=1 npm test -- test/golden-gb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { buildSite } = hasLive ? await import('../src/core/build.js') : {};
const { localDate, addDays, nowSec } = hasLive ? await import('../src/core/time.js') : {};

const file = path.join(import.meta.dirname, 'fixtures', 'golden-gb.json');
const SITE = 1;
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

function snapshot(asOf) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(SITE).d;
  const last = addDays(localDate(site.timezone, asOf), -1);
  const res = buildSite(SITE, first, last, { asOf, dryRun: true });
  // dur_s and tod_min were added with per-home slot length; the hash keeps comparing the original columns.
  const volatile = new Set(['built_at', 'lineage', 'dur_s', 'tod_min']);
  const h = createHash('sha256');
  const perDay = {};
  for (const r of res.hhRows) {
    const o = Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.has(k)).map(([k, v]) => [k, round(v)]));
    h.update(JSON.stringify(o));
    const d = (perDay[r.local_date] ||= { slots: 0, import: 0, export: 0, solar: 0, home: 0, cost: 0 });
    d.slots++; d.import += r.grid_import || 0; d.export += r.grid_export || 0; d.solar += r.solar || 0; d.home += r.home || 0; d.cost += r.total_cost || 0;
  }
  for (const d of Object.values(perDay)) for (const k of Object.keys(d)) d[k] = round(d[k]);
  return { first, last, slots: res.slots, days: res.days, hash: h.digest('hex'), perDay };
}

test('GB home: a dry-run build as known at a fixed moment is unchanged', { skip }, () => {
  if (process.env.UPDATE_GOLDEN === '1') {
    const asOf = nowSec();
    fs.writeFileSync(file, JSON.stringify({ asOf, ...snapshot(asOf) }, null, 1));
    return;
  }
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = snapshot(g.asOf);
  assert.equal(now.slots, g.slots, 'slot count');
  assert.deepEqual(now.perDay, g.perDay, 'per-day totals');
  assert.equal(now.hash, g.hash, 'row-for-row hash');
});
