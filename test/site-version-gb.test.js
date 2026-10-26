// H5 on a private copy of data/core.db: the GB home's settings now have versions (site_version,
// tariff_version, delta 022), and a dry-run build "as known at" the golden moment reads them. It is
// row for row the build that read today's site row (nothing changed since), its hash is the golden
// one, and changing the home's slot length or zone afterwards does not move it.
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
const { siteAt, siteVersions, tariffAt } = hasLive ? await import('../src/core/versions.js') : {};
const { localDate, addDays } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'golden-gb.json'), 'utf8'));
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
const window = () => {
  const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE).timezone;
  return [db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(SITE).d, addDays(localDate(tz, golden.asOf), -1)];
};
// The golden test's hash (same columns, same rounding).
function goldenHash(rows) {
  const volatile = new Set(['built_at', 'lineage', 'dur_s', 'tod_min']);
  const h = createHash('sha256');
  for (const r of rows) h.update(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.has(k)).map(([k, v]) => [k, round(v)]))));
  return h.digest('hex');
}
const full = (rows) => rows.map((r) => JSON.stringify({ ...r, built_at: null }));

test('every home and tariff has a current version equal to its row', { skip }, () => {
  for (const s of db.prepare('SELECT * FROM site').all()) {
    const vs = siteVersions(s.id);
    assert.ok(vs.length >= 1, `site ${s.id}`);
    const cur = vs.find((v) => v.superseded_at == null);
    for (const c of ['timezone', 'slot_s', 'currency', 'market_code', 'country', 'battery_kwh', 'pv_kwp', 'contracted_kva', 'gsp_region', 'carbon_region']) assert.equal(cur[c], s[c], `site ${s.id} ${c}`);
  }
  const missing = db.prepare('SELECT COUNT(*) n FROM tariff t WHERE NOT EXISTS (SELECT 1 FROM tariff_version v WHERE v.tariff_id = t.id AND v.superseded_at IS NULL)').get().n;
  assert.equal(missing, 0, 'every tariff has a current version');
  const t = db.prepare('SELECT * FROM tariff ORDER BY id LIMIT 1').get();
  if (t) assert.deepEqual([tariffAt(t.id).structure, tariffAt(t.id).currency], [t.structure, t.currency]);
});

test('GB: the as-of build with versioned settings is row for row the build with today\'s settings, and the golden one', { skip }, () => {
  const [first, last] = window();
  const versioned = buildSite(SITE, first, last, { asOf: golden.asOf, dryRun: true });
  const current = buildSite(SITE, first, last, { asOf: golden.asOf, dryRun: true, currentSettings: true });
  assert.equal(siteAt(SITE, golden.asOf * 1000).approximateSettings, null, 'a version was in force at the golden moment');
  assert.deepEqual(full(versioned.hhRows), full(current.hhRows), 'slots, lineage included');
  assert.deepEqual(full(versioned.dayRows), full(current.dayRows), 'days');
  assert.deepEqual(versioned.checks, current.checks);
  assert.equal(versioned.slots, golden.slots);
  assert.equal(goldenHash(versioned.hhRows), golden.hash, 'the golden hash');
});

test('GB: a later slot length or zone change does not move the as-of build; today\'s-settings build follows it', { skip }, () => {
  const [first, last] = window();
  const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE).timezone;
  try {
    db.prepare('UPDATE site SET slot_s = 900 WHERE id = ?').run(SITE);
    db.prepare("UPDATE site SET timezone = 'Europe/Paris' WHERE id = ?").run(SITE);   // as a provider's zone rewrite would
    const v = buildSite(SITE, first, last, { asOf: golden.asOf, dryRun: true });
    assert.equal(goldenHash(v.hhRows), golden.hash, 'as known at the golden moment: unchanged');
    assert.equal(v.slots, golden.slots);
    const c = buildSite(SITE, first, last, { asOf: golden.asOf, dryRun: true, currentSettings: true });
    assert.ok(c.hhRows.every((r) => r.dur_s === 900), 'today\'s settings: 15-minute slots');
  } finally {
    db.prepare('UPDATE site SET slot_s = 1800, timezone = ? WHERE id = ?').run(tz, SITE);
  }
  assert.equal(siteAt(SITE).slot_s, 1800);
  assert.ok(siteVersions(SITE).length >= 3, 'each change kept as a version');
});
