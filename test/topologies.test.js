// One synthetic home per energy-system topology (fix list R12, scripts/lib/topologies.js), built by the real engine. Each
// is checked three ways: its fingerprint (a hash of every slot and the day totals) against test/fixtures/topologies.json,
// every slot balancing, and the build against the synthetic truth it was made from. A topology the engine does not
// handle yet carries a note (the fix list item that will) and must still miss its truth: the day it starts to pass, the
// note is removed on purpose. Regenerate the fingerprints only on purpose: UPDATE_GOLDEN=1 node --test test/topologies.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const T = await import('../scripts/lib/topologies.js');

const file = path.join(import.meta.dirname, 'fixtures', 'topologies.json');
const update = process.env.UPDATE_GOLDEN === '1';
const golden = update || !fs.existsSync(file) ? {} : JSON.parse(fs.readFileSync(file, 'utf8'));
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
const KEYS = ['solar', 'home', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge'];
const near = (a, b, eps = 1e-6) => Math.abs((a || 0) - (b || 0)) <= eps;

function fingerprint(rows, volatile = ['built_at', 'lineage', 'site_id']) {
  const h = createHash('sha256');
  for (const r of rows) h.update(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.includes(k)).map(([k, v]) => [k, round(v)]))));
  return h.digest('hex');
}
// How far the build is from the truth, per day and quantity: [] when every one is within 3 % or 0.15 kWh.
function misses(rows, truth) {
  const built = {};
  for (const r of rows) { const d = built[r.local_date] ??= Object.fromEntries(KEYS.map((k) => [k, 0])); for (const k of KEYS) d[k] += r[k] || 0; }
  const out = [];
  for (const [date, want] of Object.entries(truth)) {
    for (const k of KEYS) {
      const got = built[date]?.[k] ?? 0;
      if (Math.abs(got - want[k]) > Math.max(0.15, 0.03 * Math.abs(want[k]))) out.push(`${date} ${k}: built ${got.toFixed(2)}, truth ${want[k].toFixed(2)} kWh`);
    }
  }
  return out;
}

const results = {};
for (const name of Object.keys(T.TOPOLOGIES)) {
  await test(`topology ${name}: fingerprint, balanced slots, and the truth it was made from`, async () => {
    const t = await T.buildTopology(name);
    const rows = await db.prepare('SELECT * FROM site_hh WHERE site_id = ? ORDER BY slot_start').all(t.site.id);
    assert.equal(rows.length, 96, 'two days of half-hours');
    for (const r of rows) {
      const z = (v) => v || 0;
      assert.ok(near(z(r.home), z(r.solar_to_home) + z(r.battery_to_home) + z(r.grid_to_home)), `${name}: home split at ${r.slot_start}`);
      assert.ok(near(z(r.grid_import), z(r.grid_to_home) + z(r.grid_to_battery) + z(r.grid_to_loss)), `${name}: import split at ${r.slot_start}`);
      if (r.total_cost != null) assert.ok(near(r.total_cost, z(r.grid_to_home_cost) + z(r.grid_to_battery_cost) + z(r.loss_cost) + z(r.standing_cost) + z(r.gas_cost) - z(r.export_credit)), `${name}: bill at ${r.slot_start}`);
    }
    const off = misses(rows, T.truth(t.samples));
    if (t.note) assert.ok(off.length > 0, `${name} now matches its truth: remove its note (${t.note})`);
    else assert.deepEqual(off, [], `${name} differs from its truth`);
    const days = await db.prepare('SELECT local_date, solar, home, grid_import, grid_export, total_cost FROM site_day WHERE site_id = ? ORDER BY local_date').all(t.site.id);
    const heat = name === 'heat_pump' ? await db.prepare('SELECT * FROM site_heat_slot WHERE site_id = ? ORDER BY slot_start').all(t.site.id) : null;
    if (heat) assert.equal(heat.length, 96, 'heating rows for every slot');
    const got = { hash: fingerprint(rows), days: days.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v)]))), ...(heat ? { heat: fingerprint(heat) } : {}), ...(t.note ? { note: t.note } : {}) };
    results[name] = got;
    if (!update) assert.deepEqual(got, golden[name], `${name}: the fingerprint moved (UPDATE_GOLDEN=1 re-records it, on purpose)`);
  });
}

await test('every topology has a recorded fingerprint, and nothing else is recorded', () => {
  if (update) { fs.writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`); return; }
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(T.TOPOLOGIES).sort());
});
