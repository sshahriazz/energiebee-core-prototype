// The Data Explorer on a snapshot of the real GB home (data/core.db, copied; skipped without it). The
// raw payload files are read in place (a link to data/raw beside the copy; nothing is written there).
// The answers keep their shapes on real data, the slot trace reproduces its own numbers, the stored
// facts equal the values published in their payloads, every published rate row behind a slot is the
// one used, and a 7-day range stays well within its time budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive, liveDb } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) {
  const file = useDb({ snapshot: true });
  const raw = path.join(path.dirname(liveDb), 'raw');
  if (fs.existsSync(raw)) fs.symlinkSync(raw, path.join(path.dirname(file), 'raw'));
}
const { db } = hasLive ? await import('../src/db/db.js') : {};
const X = hasLive ? await import('../src/core/explorer.js') : {};
const { addDays } = hasLive ? await import('../src/core/time.js') : {};
const SITE = 1;

test('GB snapshot: overview, a slot trace that reproduces itself, published values and rates, a 7-day range in time', { skip }, () => {
  const o = X.overview({ site: String(SITE) });
  assert.equal(o.slot_s, 1800); assert.equal(o.currency, 'GBP');
  assert.ok(o.sources.some((s) => s.code === 'sunsynk_5min' && s.facts > 0));
  const last = db.prepare("SELECT MAX(local_date) AS d FROM site_day WHERE site_id = ? AND slots_final = slots").get(SITE).d;
  if (!last) return;
  const row = db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND local_date = ? ORDER BY slot_start LIMIT 1 OFFSET 26').get(SITE, last);
  const e = X.slot({ site: String(SITE), slot: String(row.slot_start) });
  assert.equal(typeof e.matches_stored, 'boolean');
  const r = e.recomputed;
  const out = (from) => e.flows.filter((f) => f.from === from).reduce((s, f) => s + f.kwh, 0);
  assert.ok(Math.abs(out('solar') - r.solar) < 1e-9 && Math.abs(out('grid') - (r.grid_import ?? 0)) < 1e-9 && Math.abs(out('battery') - r.battery_discharge) < 1e-9);
  const v = X.validate({ site: String(SITE), slot: String(row.slot_start) });
  for (const c of v.checks.filter((x) => x.id.startsWith('source_lookup') || x.id.startsWith('rate_published') || ['cost_arithmetic', 'standing_share', 'tax_rule', 'carbon_used'].includes(x.id))) {
    assert.notEqual(c.status, 'fail', `${c.id}: ${c.explanation}`);
  }
  const from = addDays(last, -6);
  const t0 = Date.now();
  const tl = X.timeline({ site: String(SITE), from, to: last });
  const vr = X.validate({ site: String(SITE), from, to: last });
  const co = X.correlate({ site: String(SITE), x: 'outdoor_temp', y: 'home', from, to: last });
  const hm = X.heatmap({ site: String(SITE), var: 'import_rate', from, to: last });
  const ms = Date.now() - t0;
  assert.ok(tl.rows.length >= 7 * 46 && vr.checks.length > 50 && co.n > 100 && hm.rows.length === 7);
  assert.ok(ms < 5000, `four 7-day reads took ${ms} ms`);
  // No credential in the raw payload requests.
  const list = X.rawList({ site: String(SITE), limit: '200' });
  for (const x of list.rows) assert.equal(/"(password|token|api_?key|authorization)":"(?!\[redacted\])/i.test(JSON.stringify(x.request)), false);
});
