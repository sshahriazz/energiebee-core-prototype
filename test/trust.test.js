// Trust features of the core: as-known-at rebuilds, the revision log, versioned system
// details, corrections and the cross-checks. On a private copy of data/core.db; stand-in
// values (meter readings for a provisional day) go into the copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const m = {
  ...(await import('../src/db/db.js')), ...(await import('../src/core/facts.js')), ...(await import('../src/core/build.js')),
  ...(await import('../src/core/attributes.js')), ...(await import('../src/core/maintenance.js')), ...(await import('../src/core/time.js')),
};

const SITE = 1;
const site = async () => await m.db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const firstDay = async () => (await m.db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = ?').get(SITE)).d;
const today = async () => m.localDate((await site()).timezone, m.nowSec());
const fullBuild = async (reason) => await m.buildSite(SITE, await firstDay(), await today(), { reason });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

await test('rebuilding "as known now" reproduces the stored rows exactly', { skip }, async () => {
  await fullBuild('test');
  const dry = await m.buildSite(SITE, await firstDay(), await today(), { asOf: m.nowSec(), dryRun: true });
  const stored = new Map((await m.db.prepare('SELECT * FROM site_hh WHERE site_id = ?').all(SITE)).map((r) => [r.slot_start, r]));
  assert.equal(dry.hhRows.length, stored.size);
  for (const h of dry.hhRows) {
    const s = stored.get(h.slot_start);
    for (const k of ['state', 'home', 'grid_import', 'grid_export', 'solar', 'total_cost', 'battery_to_home_cost', 'solar_forecast', 'gas']) {
      const a = s[k] ?? null; const b = h[k] ?? null;
      assert.ok(a === b || (typeof a === 'number' && Math.abs(a - b) < 1e-9), `${h.slot_start} ${k}: stored ${a}, as-of ${b}`);
    }
  }
});

await test('a day rebuilt as known before its meter readings arrived is provisional; now it is final; the log shows the change', { skip }, async (t) => {
  const imp = await m.db.prepare("SELECT * FROM device WHERE site_id = ? AND kind = 'meter_import'").get(SITE);
  const day = (await m.db.prepare("SELECT local_date FROM site_hh WHERE site_id = ? AND state = 'provisional' AND local_date < ? ORDER BY local_date DESC LIMIT 1").get(SITE, await today()))?.local_date;
  if (!imp || !day) return t.skip('no past provisional day or no import meter');
  await fullBuild('test');
  const rows = await m.db.prepare('SELECT slot_start, grid_import FROM site_hh WHERE site_id = ? AND local_date = ?').all(SITE, day);
  await sleepMs(5);
  const beforeArrival = m.nowSec();
  await sleepMs(1100);   // the as-of moment is in whole seconds
  await m.putIntervals(await m.seriesId('device', imp.id, 'grid_import_kwh', 'octopus_meter'), rows.map((r) => ({ start: r.slot_start, end: r.slot_start + m.SLOT, value: r.grid_import ?? 0 })));
  await m.markDirty(SITE, m.dayBounds((await site()).timezone, day)[0], m.nowSec(), 'test: meter readings arrived');
  await m.processQueue();
  const then = (await m.buildSite(SITE, await firstDay(), await today(), { asOf: beforeArrival, dryRun: true })).dayRows.find((d) => d.local_date === day);
  const nowRow = await m.db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date = ?').get(SITE, day);
  assert.ok(then.slots_provisional > 0, 'provisional as known before');
  assert.equal(nowRow.slots_provisional, 0);
  const rev = await m.db.prepare('SELECT * FROM site_day_revision WHERE site_id = ? AND local_date = ? ORDER BY id DESC LIMIT 1').get(SITE, day);
  assert.match(rev.reason, /meter readings arrived/);
  const changed = JSON.parse(rev.changed).map((c) => c.field);
  assert.ok(changed.includes('slots_final') && changed.includes('slots_provisional'), changed.join(','));
  assert.equal(JSON.parse(rev.inputs).clampSlots, 0);
});

await test('an unchanged rebuild adds no revision', { skip }, async () => {
  await fullBuild('test');
  const n = (await m.db.prepare('SELECT COUNT(*) n FROM site_day_revision').get()).n;
  await fullBuild('test again');
  assert.equal((await m.db.prepare('SELECT COUNT(*) n FROM site_day_revision').get()).n, n);
});

await test('system details keep every version and resolve by source rank', { skip }, async () => {
  const S = SITE; const attr = 'pv_kwp';
  await m.setAttribute(S, attr, 6.5, 'provider', 'test provider');
  await m.setAttribute(S, attr, 5.0, 'estimated', 'test estimate');
  assert.equal((await site()).pv_kwp, 6.5, 'provider outranks estimate');
  await sleepMs(5);
  const beforeInstaller = Date.now();
  await sleepMs(5);
  await m.setAttribute(S, attr, 6.2, 'installer', 'test installer');
  assert.equal((await site()).pv_kwp, 6.2, 'installer outranks provider');
  assert.equal((await m.attributeAt(S, attr, beforeInstaller)).value, 6.5, 'as known before the installer value');
  await m.withdrawAttribute(S, attr, 'installer');
  assert.equal((await site()).pv_kwp, 6.5);
  const hist = (await m.attributeHistory(S)).filter((h) => h.attr === attr && h.source === 'installer');
  assert.equal(hist.length, 1);
  assert.ok(hist[0].superseded_at != null, 'withdrawn, not deleted');
});

await test('derived gas kWh facts are withdrawn once, logged, and the build is unchanged', { skip }, async () => {
  await fullBuild('test');
  const gasBefore = (await m.db.prepare('SELECT ROUND(SUM(gas), 6) g FROM site_hh WHERE site_id = ?').get(SITE)).g;
  const first = await m.withdrawDerivedGas(SITE);
  assert.equal(await m.withdrawDerivedGas(SITE), 0, 'idempotent');
  if (first) assert.ok((await m.db.prepare('SELECT rows FROM fact_correction WHERE site_id = ? ORDER BY id DESC').get(SITE)).rows === first);
  await fullBuild('test');
  assert.equal((await m.db.prepare('SELECT ROUND(SUM(gas), 6) g FROM site_hh WHERE site_id = ?').get(SITE)).g, gasBefore);
});

await test('every inverter counter is cross-checked against the 5-minute samples', { skip }, async () => {
  await fullBuild('test');
  const codes = new Set((await m.db.prepare("SELECT DISTINCT check_code FROM check_result WHERE site_id = ? AND check_code LIKE 'counter_fit_%'").all(SITE)).map((r) => r.check_code));
  for (const c of ['solar', 'load', 'import', 'export', 'charge', 'discharge']) assert.ok(codes.has(`counter_fit_${c}`), c);
});

await test("the energy balance is judged against this home's own typical day", { skip }, async () => {
  await fullBuild('test');
  const rows = await m.db.prepare("SELECT local_date, status, detail FROM check_result WHERE site_id = ? AND check_code = 'energy_balance' ORDER BY local_date").all(SITE);
  assert.ok(rows.length > 0);
  assert.match(rows[0].detail, /not known yet/);
  assert.equal(rows[0].status, 'skip');
  const judged = rows.filter((r) => /typical/.test(r.detail) && !/not known/.test(r.detail));
  if (rows.length > 8) assert.ok(judged.length > 0);
});
