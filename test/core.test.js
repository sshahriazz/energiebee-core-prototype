// The build engine, checks and forecast, on a private copy of this home's real database.
// Where a test needs data the providers haven't sent yet (meter readings for a provisional
// day, Quartz forecasts), it writes stand-in values into the copy only. Skipped without data/core.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { seriesId, putIntervals, putForecasts, markDirty } = hasLive ? await import('../src/core/facts.js') : {};
const { buildSite, processQueue } = hasLive ? await import('../src/core/build.js') : {};
const { forecastSite } = hasLive ? await import('../src/core/forecast.js') : {};
const { dayBounds, localDate, nowSec, SLOT } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const site = () => db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const days = () => db.prepare('SELECT local_date FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.local_date);
const today = () => localDate(site().timezone, nowSec());
const fullBuild = () => buildSite(SITE, days()[0], today());
const hh = (date) => db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND local_date = ? ORDER BY slot_start').all(SITE, date);
const dev = (kind) => db.prepare('SELECT * FROM device WHERE site_id = ? AND kind = ?').get(SITE, kind);
const check = (date, code) => db.prepare('SELECT status, detail FROM check_result WHERE site_id = ? AND local_date = ? AND check_code = ?').get(SITE, date, code);
const rebuildFrom = (date, why) => { markDirty(SITE, dayBounds(site().timezone, date)[0], nowSec(), why); return processQueue(); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('a partial rebuild gives exactly the rows of a full rebuild', { skip }, () => {
  const hash = () => {
    const h = createHash('sha256');
    for (const t of ['site_hh', 'site_day']) for (const r of db.prepare(`SELECT * FROM ${t} WHERE site_id = ? ORDER BY 2`).all(SITE)) { delete r.built_at; h.update(JSON.stringify(r)); }
    return h.digest('hex');
  };
  fullBuild();
  const full = hash();
  const d = days();
  rebuildFrom(d[Math.floor(d.length / 2)], 'test');
  assert.equal(hash(), full);
});

test('every half-hour balances: energy in = energy out, and the bill adds up', { skip }, () => {
  const rows = db.prepare('SELECT * FROM site_hh WHERE site_id = ?').all(SITE);
  let n = 0;
  for (const r of rows) {
    if (r.state === 'missing') continue;
    n++;
    const z = (v) => v || 0;
    assert.ok(near(z(r.home), z(r.solar_to_home) + z(r.battery_to_home) + z(r.grid_to_home)), `home split at ${r.slot_start}`);
    assert.ok(near(z(r.grid_import), z(r.grid_to_home) + z(r.grid_to_battery) + z(r.grid_to_loss)), `import split at ${r.slot_start}`);
    if (r.total_cost != null) {
      const bill = z(r.grid_to_home_cost) + z(r.grid_to_battery_cost) + z(r.loss_cost) + z(r.standing_cost) + z(r.gas_cost) - z(r.export_credit);
      assert.ok(near(r.total_cost, bill, 1e-6), `bill at ${r.slot_start}`);
    }
  }
  assert.ok(n > 0);
});

test('the battery stock follows the measured charge level every day', { skip }, () => {
  const cap = site().battery_kwh;
  for (const d of db.prepare('SELECT local_date, battery_stock FROM site_day WHERE site_id = ? AND battery_stock IS NOT NULL').all(SITE)) {
    const last = hh(d.local_date).filter((r) => r.soc_end != null).pop();
    if (!last) continue;
    const held = JSON.parse(d.battery_stock).reduce((s, [kwh]) => s + kwh, 0);
    assert.ok(near(held, (last.soc_end / 100) * cap, 0.01), `${d.local_date}: stock ${held.toFixed(3)} vs ${(last.soc_end / 100 * cap).toFixed(3)} kWh`);
  }
});

test('battery energy has a known cost after the opening stock is used', { skip }, () => {
  const first = days()[0];
  const unknown = db.prepare(`SELECT local_date, COUNT(*) n FROM site_hh WHERE site_id = ? AND battery_to_home > 0 AND battery_to_home_cost IS NULL
    AND local_date > date(?, '+1 day') GROUP BY local_date`).all(SITE, first);
  assert.deepEqual(unknown, []);
});

test('a provisional day becomes final when the smart-meter readings arrive', { skip }, (t) => {
  const imp = dev('meter_import'); const exp = dev('meter_export');
  const day = db.prepare("SELECT local_date FROM site_hh WHERE site_id = ? AND state = 'provisional' AND local_date < ? ORDER BY local_date DESC LIMIT 1").get(SITE, today())?.local_date;
  if (!imp || !day) return t.skip('no past provisional day or no import meter');
  const rows = hh(day);
  // Stand-in meter readings equal to the clamp's values.
  putIntervals(seriesId('device', imp.id, 'grid_import_kwh', 'octopus_meter'), rows.map((r) => ({ start: r.slot_start, end: r.slot_start + SLOT, value: r.grid_import ?? 0 })));
  if (exp) putIntervals(seriesId('device', exp.id, 'grid_export_kwh', 'octopus_meter'), rows.map((r) => ({ start: r.slot_start, end: r.slot_start + SLOT, value: r.grid_export ?? 0 })));
  rebuildFrom(day, 'test: meter arrival');
  assert.deepEqual([...new Set(hh(day).map((r) => r.state))], ['final']);
});

test('gas waits for its calorific value, then fills in when it is published', { skip }, (t) => {
  const gas = dev('meter_gas'); const ldz = gas && JSON.parse(gas.attrs || '{}').ldz;
  if (!ldz) return t.skip('no gas meter with a known LDZ');
  const cvS = seriesId('region', `ldz:${ldz}`, 'gas_cv_mjm3', 'national_gas_cv');
  // The latest gas day with a published value and gas use in it.
  const cv = db.prepare(`SELECT f.* FROM interval_fact f WHERE f.series_id = ? AND f.superseded_at IS NULL
    AND EXISTS (SELECT 1 FROM site_hh h WHERE h.site_id = ? AND h.slot_start >= f.start_ts AND h.slot_start < f.end_ts AND h.gas > 0)
    ORDER BY f.start_ts DESC LIMIT 1`).get(cvS, SITE);
  if (!cv) return t.skip('no gas day with both gas and a calorific value');
  const date = localDate(site().timezone, cv.start_ts + 12 * 3600);
  const waiting = () => db.prepare("SELECT COUNT(*) n FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND gas IS NULL AND json_extract(lineage, '$.gasM3') IS NOT NULL").get(SITE, cv.start_ts, cv.end_ts).n;
  db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND start_ts = ? AND superseded_at IS NULL').run(nowSec(), cvS, cv.start_ts);
  rebuildFrom(localDate(site().timezone, cv.start_ts), 'test: value withdrawn');
  assert.ok(waiting() > 0, 'half-hours wait for the value');
  assert.equal(check(date, 'gas_calorific_value').status, 'warn');
  putIntervals(cvS, [{ start: cv.start_ts, end: cv.end_ts, value: cv.value }]);
  rebuildFrom(localDate(site().timezone, cv.start_ts), 'test: value published');
  assert.equal(waiting(), 0);
  assert.equal(check(date, 'gas_calorific_value').status, 'pass');
});

// Quartz forecasts for the last two whole days at `ratio` × what the panels made (stand-ins), plus one future issue.
function quartzAt(ratio) {
  const s = site();
  if (s.pv_tilt == null || s.pv_orientation == null) db.prepare('UPDATE site SET pv_tilt = 20, pv_orientation = 180 WHERE id = ?').run(SITE);
  const qS = seriesId('site', SITE, 'solar_kwh', 'quartz');
  db.prepare('DELETE FROM forecast_fact WHERE series_id = ?').run(qS);
  let made = 0;
  for (const d of days().filter((x) => x < today()).slice(-2)) {
    const rows = hh(d);
    made += rows.reduce((a, r) => a + (r.solar || 0), 0);
    putForecasts(qS, rows[0].slot_start - 6 * 3600, rows.map((r) => ({ start: r.slot_start, end: r.slot_start + SLOT, value: (r.solar || 0) / ratio })));
  }
  const now = nowSec(); const s0 = now - (now % SLOT);
  putForecasts(qS, now, Array.from({ length: 96 }, (_, i) => ({ start: s0 + i * SLOT, end: s0 + (i + 1) * SLOT, value: 0.2 })));
  return made;
}

test('Quartz is calibrated when it is close to what the panels make', { skip }, (t) => {
  if (quartzAt(0.8) < 2) return t.skip('not enough solar in the last two days');
  const q = forecastSite(SITE, 48).model.solar;
  assert.equal(q.path, 'quartz');
  assert.equal(q.quartz.calibration.applied, true);
  assert.ok(near(q.quartz.calibration.factor, 0.8, 0.01));
});

test('Quartz is not used when it is far from what the panels make', { skip }, (t) => {
  // 3× off is outside 0.5–2×; the stand-in forecast (made ÷ 3) must itself reach the 2 kWh needed to compare.
  if (quartzAt(3) < 6) return t.skip('not enough solar in the last two days');
  const q = forecastSite(SITE, 48).model.solar;
  assert.equal(q.quartz.calibration.applied, false);
  assert.match(q.quartz.calibration.reason, /outside 0\.5–2/);
  assert.notEqual(q.path, 'quartz');
});

test('forecast accuracy is scored from forecasts made at least 12 hours ahead', { skip }, (t) => {
  const homeS = seriesId('site', SITE, 'load_kwh', 'core_forecast');
  db.prepare('DELETE FROM forecast_fact WHERE series_id = ?').run(homeS);
  const scored = days().filter((x) => x < today()).slice(-3);
  if (scored.length < 1) return t.skip('no whole day yet');
  for (const d of scored) {
    const rows = hh(d);
    putForecasts(homeS, rows[0].slot_start - 13 * 3600, rows.map((r) => ({ start: r.slot_start, end: r.slot_start + SLOT, value: (r.home || 0) * 1.1 })));
  }
  const a = forecastSite(SITE, 48).accuracy;
  assert.ok(a && a.samples > 0, 'scored');
  assert.ok(near(a.dailyErrorPct, 10, 1), `daily error ${a.dailyErrorPct}% for a forecast 10% high`);
});
