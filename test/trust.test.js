// Trust features of the core: as-known-at rebuilds, the revision log, versioned system
// details, corrections and the cross-checks. On a private copy of data/core.db; stand-in
// values (meter readings for a provisional day) go into the copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const m = hasLive ? {
  ...(await import('../src/db/db.js')), ...(await import('../src/core/facts.js')), ...(await import('../src/core/build.js')),
  ...(await import('../src/core/attributes.js')), ...(await import('../src/core/maintenance.js')), ...(await import('../src/core/time.js')),
} : {};

const SITE = 1;
const site = () => m.db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const firstDay = () => m.db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = ?').get(SITE).d;
const today = () => m.localDate(site().timezone, m.nowSec());
const fullBuild = (reason) => m.buildSite(SITE, firstDay(), today(), { reason });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('rebuilding "as known now" reproduces the stored rows exactly', { skip }, () => {
  fullBuild('test');
  const dry = m.buildSite(SITE, firstDay(), today(), { asOf: m.nowSec(), dryRun: true });
  const stored = new Map(m.db.prepare('SELECT * FROM site_hh WHERE site_id = ?').all(SITE).map((r) => [r.slot_start, r]));
  assert.equal(dry.hhRows.length, stored.size);
  for (const h of dry.hhRows) {
    const s = stored.get(h.slot_start);
    for (const k of ['state', 'home', 'grid_import', 'grid_export', 'solar', 'total_cost', 'battery_to_home_cost', 'solar_forecast', 'gas']) {
      const a = s[k] ?? null; const b = h[k] ?? null;
      assert.ok(a === b || (typeof a === 'number' && Math.abs(a - b) < 1e-9), `${h.slot_start} ${k}: stored ${a}, as-of ${b}`);
    }
  }
});

test('a day rebuilt as known before its meter readings arrived is provisional; now it is final; the log shows the change', { skip }, async (t) => {
  const imp = m.db.prepare("SELECT * FROM device WHERE site_id = ? AND kind = 'meter_import'").get(SITE);
  const day = m.db.prepare("SELECT local_date FROM site_hh WHERE site_id = ? AND state = 'provisional' AND local_date < ? ORDER BY local_date DESC LIMIT 1").get(SITE, today())?.local_date;
  if (!imp || !day) return t.skip('no past provisional day or no import meter');
  fullBuild('test');
  const rows = m.db.prepare('SELECT slot_start, grid_import FROM site_hh WHERE site_id = ? AND local_date = ?').all(SITE, day);
  await sleepMs(5);
  const beforeArrival = m.nowSec();
  await sleepMs(1100);   // the as-of moment is in whole seconds
  m.putIntervals(m.seriesId('device', imp.id, 'grid_import_kwh', 'octopus_meter'), rows.map((r) => ({ start: r.slot_start, end: r.slot_start + m.SLOT, value: r.grid_import ?? 0 })));
  m.markDirty(SITE, m.dayBounds(site().timezone, day)[0], m.nowSec(), 'test: meter readings arrived');
  m.processQueue();
  const then = m.buildSite(SITE, firstDay(), today(), { asOf: beforeArrival, dryRun: true }).dayRows.find((d) => d.local_date === day);
  const nowRow = m.db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date = ?').get(SITE, day);
  assert.ok(then.slots_provisional > 0, 'provisional as known before');
  assert.equal(nowRow.slots_provisional, 0);
  const rev = m.db.prepare('SELECT * FROM site_day_revision WHERE site_id = ? AND local_date = ? ORDER BY id DESC LIMIT 1').get(SITE, day);
  assert.match(rev.reason, /meter readings arrived/);
  const changed = JSON.parse(rev.changed).map((c) => c.field);
  assert.ok(changed.includes('slots_final') && changed.includes('slots_provisional'), changed.join(','));
  assert.equal(JSON.parse(rev.inputs).clampSlots, 0);
});

test('an unchanged rebuild adds no revision', { skip }, () => {
  fullBuild('test');
  const n = m.db.prepare('SELECT COUNT(*) n FROM site_day_revision').get().n;
  fullBuild('test again');
  assert.equal(m.db.prepare('SELECT COUNT(*) n FROM site_day_revision').get().n, n);
});

test('system details keep every version and resolve by source rank', { skip }, async () => {
  const S = SITE; const attr = 'pv_kwp';
  m.setAttribute(S, attr, 6.5, 'provider', 'test provider');
  m.setAttribute(S, attr, 5.0, 'estimated', 'test estimate');
  assert.equal(site().pv_kwp, 6.5, 'provider outranks estimate');
  await sleepMs(5);
  const beforeInstaller = Date.now();
  await sleepMs(5);
  m.setAttribute(S, attr, 6.2, 'installer', 'test installer');
  assert.equal(site().pv_kwp, 6.2, 'installer outranks provider');
  assert.equal(m.attributeAt(S, attr, beforeInstaller).value, 6.5, 'as known before the installer value');
  m.withdrawAttribute(S, attr, 'installer');
  assert.equal(site().pv_kwp, 6.5);
  const hist = m.attributeHistory(S).filter((h) => h.attr === attr && h.source === 'installer');
  assert.equal(hist.length, 1);
  assert.ok(hist[0].superseded_at != null, 'withdrawn, not deleted');
});

test('derived gas kWh facts are withdrawn once, logged, and the build is unchanged', { skip }, () => {
  fullBuild('test');
  const gasBefore = m.db.prepare('SELECT ROUND(SUM(gas), 6) g FROM site_hh WHERE site_id = ?').get(SITE).g;
  const first = m.withdrawDerivedGas(SITE);
  assert.equal(m.withdrawDerivedGas(SITE), 0, 'idempotent');
  if (first) assert.ok(m.db.prepare('SELECT rows FROM fact_correction WHERE site_id = ? ORDER BY id DESC').get(SITE).rows === first);
  fullBuild('test');
  assert.equal(m.db.prepare('SELECT ROUND(SUM(gas), 6) g FROM site_hh WHERE site_id = ?').get(SITE).g, gasBefore);
});

test('every inverter counter is cross-checked against the 5-minute samples', { skip }, () => {
  fullBuild('test');
  const codes = new Set(m.db.prepare("SELECT DISTINCT check_code FROM check_result WHERE site_id = ? AND check_code LIKE 'counter_fit_%'").all(SITE).map((r) => r.check_code));
  for (const c of ['solar', 'load', 'import', 'export', 'charge', 'discharge']) assert.ok(codes.has(`counter_fit_${c}`), c);
});

test("the energy balance is judged against this home's own typical day", { skip }, () => {
  fullBuild('test');
  const rows = m.db.prepare("SELECT local_date, status, detail FROM check_result WHERE site_id = ? AND check_code = 'energy_balance' ORDER BY local_date").all(SITE);
  assert.ok(rows.length > 0);
  assert.match(rows[0].detail, /not known yet/);
  assert.equal(rows[0].status, 'skip');
  const judged = rows.filter((r) => /typical/.test(r.detail) && !/not known/.test(r.detail));
  if (rows.length > 8) assert.ok(judged.length > 0);
});
