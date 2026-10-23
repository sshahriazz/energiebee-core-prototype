// The same home built in 15 and 60-minute slots against its half-hour build, on a private copy
// of data/core.db (dry runs "as known at" the golden moment, so later data never moves them).
// Energy and money must be the same per day; only how finely they are cut changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { buildSite } = hasLive ? await import('../src/core/build.js') : {};
const { localDate, addDays, todMinute } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function buildAt(slotS) {
  const { asOf } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'golden-gb.json'), 'utf8'));
  db.prepare('UPDATE site SET slot_s = ? WHERE id = ?').run(slotS, SITE);
  try {
    const site = db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
    const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(SITE).d;
    // Whole days only: today's last part-slot depends on the slot length.
    const last = addDays(localDate(site.timezone, asOf), -1);
    return { ...buildSite(SITE, first, last, { asOf, dryRun: true }), tz: site.timezone };
  } finally {
    db.prepare('UPDATE site SET slot_s = 1800 WHERE id = ?').run(SITE);
  }
}
const perDay = (rows, keys) => {
  const out = new Map();
  for (const r of rows) {
    const d = out.get(r.local_date) || out.set(r.local_date, Object.fromEntries(keys.map((k) => [k, 0]))).get(r.local_date);
    for (const k of keys) d[k] += r[k] || 0;
  }
  return out;
};

const base = hasLive ? buildAt(1800) : null;
const ENERGY = ['solar', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge'];
// Every kWh supplied (solar, import, battery) ends in exactly one place.
const DESTINATIONS = ['home', 'solar_to_battery', 'grid_to_battery', 'solar_to_grid', 'battery_to_grid', 'solar_to_loss', 'battery_to_loss', 'grid_to_loss'];
// The house's measured use (inverter load): what came in less what went out, less the inverter's own loss.
const withLoad = (rows) => rows.map((r) => {
  const balance = (r.solar || 0) + (r.grid_import || 0) + (r.battery_discharge || 0) - (r.grid_export || 0) - (r.battery_charge || 0);
  const load = r.loss != null ? balance - r.loss : r.home;
  return { ...r, load, capped: load - r.home, placed: DESTINATIONS.reduce((s, k) => s + (r[k] || 0), 0) };
});

for (const slotS of [900, 3600]) {
  test(`${slotS / 60}-minute slots: the same energy per day as half-hours`, { skip }, () => {
    const b = buildAt(slotS);
    assert.equal(b.days, base.days);
    assert.equal(b.slots, (base.slots * 1800) / slotS, 'slot count scales with the length');
    const a = perDay(withLoad(base.hhRows), [...ENERGY, 'load', 'placed', 'home', 'capped']);
    const c = perDay(withLoad(b.hhRows), [...ENERGY, 'load', 'placed', 'home', 'capped']);
    for (const [date, d] of a) {
      const x = c.get(date);
      for (const k of [...ENERGY, 'load', 'placed']) assert.ok(near(x[k], d[k]), `${date} ${k}: ${x[k]} vs ${d[k]} at 30 minutes`);
      // Home use is the measured load, except in a slot where the sources supplied less than it
      // (meter and clamp disagree): there it is capped at what was supplied. The cap is applied per
      // slot, so it is not additive: an hour nets two half-hours, a quarter-hour can be short where
      // its half-hour was not. Home therefore differs by at most the capped amount at either length.
      assert.ok(Math.abs(x.home - d.home) <= Math.max(x.capped, d.capped) + 1e-6, `${date} home: ${x.home} vs ${d.home}; capped ${x.capped} / ${d.capped}`);
    }
  });

  test(`${slotS / 60}-minute slots: rows carry their length and local time; standing charge adds up to the same day`, { skip }, () => {
    const b = buildAt(slotS);
    for (const r of b.hhRows) {
      assert.equal(r.dur_s, slotS);
      assert.equal(r.slot_start % 900, 0);
      assert.equal(r.tod_min, todMinute(b.tz, r.slot_start));
    }
    for (const d of b.dayRows) assert.equal(d.slot_s, slotS);
    const a = perDay(base.hhRows, ['standing_cost']); const c = perDay(b.hhRows, ['standing_cost']);
    for (const [date, d] of a) assert.ok(near(c.get(date).standing_cost, d.standing_cost), `${date}: standing ${c.get(date).standing_cost} vs ${d.standing_cost}`);
  });

  test(`${slotS / 60}-minute slots: carbon intensity is averaged, not split; kW = kWh × 3600 / slot`, { skip }, () => {
    const b = buildAt(slotS);
    const half = new Map(base.hhRows.map((r) => [r.slot_start, r]));
    let compared = 0;
    for (const r of b.hhRows) {
      if (r.carbon_intensity == null) continue;
      // A quarter-hour takes its half-hour's intensity; an hour the mean of its two half-hours.
      const parts = slotS === 900 ? [half.get(r.slot_start - (r.slot_start % 1800))] : [half.get(r.slot_start), half.get(r.slot_start + 1800)];
      if (parts.some((p) => p?.carbon_intensity == null)) continue;
      const expect = parts.reduce((s, p) => s + p.carbon_intensity, 0) / parts.length;
      assert.ok(near(r.carbon_intensity, expect, 1e-9), `${r.slot_start}: ${r.carbon_intensity} vs ${expect}`);
      compared++;
    }
    assert.ok(compared > 0, 'some slots have carbon');
    const mean = (rows) => { const xs = rows.map((r) => r.carbon_intensity).filter((v) => v != null); return xs.reduce((s, v) => s + v, 0) / xs.length; };
    assert.ok(near(mean(b.hhRows), mean(base.hhRows), 1), `mean intensity ${mean(b.hhRows)} vs ${mean(base.hhRows)}: not halved or doubled`);
    // kW from kWh: the day's peak is the largest slot import × 3600 / slot length.
    for (const d of b.dayRows) {
      const rows = b.hhRows.filter((r) => r.local_date === d.local_date);
      assert.ok(near(d.peak_import_kw, Math.max(0, ...rows.map((r) => (r.grid_import ?? 0) * (3600 / slotS)))), d.local_date);
      const half30 = base.dayRows.find((x) => x.local_date === d.local_date);
      // Finer slots see sharper peaks; coarser ones smooth them.
      if (slotS < 1800) assert.ok(d.peak_import_kw >= half30.peak_import_kw - 1e-9, `${d.local_date}: ${d.peak_import_kw} < ${half30.peak_import_kw}`);
      else assert.ok(d.peak_import_kw <= half30.peak_import_kw + 1e-9, `${d.local_date}: ${d.peak_import_kw} > ${half30.peak_import_kw}`);
    }
  });
}

test('half-hours by default: rows carry dur_s 1800 and days slot_s 1800 (the golden test checks the values)', { skip }, () => {
  for (const r of base.hhRows) {
    assert.equal(r.dur_s, 1800);
    assert.equal(r.slot_start % 1800, 0);
  }
  for (const d of base.dayRows) assert.equal(d.slot_s, 1800);
});

// Last: this one rebuilds the copy's serving rows in 15-minute slots for real.
test('a home switched to 15-minute slots: forecast, trust, comparison and solar views run in its slots', { skip }, async () => {
  const { forecastSite } = await import('../src/core/forecast.js');
  const { trustFor } = await import('../src/core/trust.js');
  const { solarExpected } = await import('../src/core/solar-expected.js');
  const { compareSite } = await import('../src/core/compare.js');
  const { nowSec, slotsOfDay } = await import('../src/core/time.js');
  const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE).timezone;
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(SITE).d;
  const today = localDate(tz, nowSec());
  db.prepare('UPDATE site SET slot_s = 900 WHERE id = ?').run(SITE);
  try {
    buildSite(SITE, first, today, { reason: 'test: 15-minute slots' });
    assert.deepEqual(db.prepare('SELECT DISTINCT dur_s FROM site_hh WHERE site_id = ?').all(SITE).map((r) => r.dur_s), [900]);
    // A new slot length is not a data revision: the log records slot_s, never the slot counts.
    const revs = db.prepare("SELECT changed FROM site_day_revision WHERE site_id = ? AND reason = 'test: 15-minute slots' AND changed IS NOT NULL").all(SITE).map((r) => JSON.parse(r.changed));
    assert.ok(revs.length > 0, 'resized days are logged');
    for (const c of revs) {
      assert.ok(c.some((x) => x.field === 'slot_s' && x.from === 1800 && x.to === 900));
      assert.ok(!c.some((x) => x.field.startsWith('slots_')), JSON.stringify(c));
    }
    const f = forecastSite(SITE, 24);
    assert.equal(f.slots.length, 96);
    assert.ok(f.slots.every((x, i) => x.slot_start % 900 === 0 && (i === 0 || x.slot_start - f.slots[i - 1].slot_start === 900)));
    assert.ok(f.next24h.home > 0, 'house use is forecast from the 15-minute history');
    if (f.cheapestWindow) assert.equal(f.cheapestWindow.end - f.cheapestWindow.start, 7200);
    const t = trustFor(SITE, today, today);
    assert.equal(t.slots, slotsOfDay(tz, today, 900).length);
    for (const feed of t.feeds) assert.equal(feed.cells.length, t.slots, feed.key);
    const se = solarExpected(SITE, today, today);
    assert.ok(se.slots.every((x) => x.slot_start % 900 === 0));
    const cmp = compareSite(SITE, first, today);
    if (cmp.ready) assert.equal(cmp.profile.length, 96);
  } finally {
    db.prepare('UPDATE site SET slot_s = 1800 WHERE id = ?').run(SITE);
  }
});
