// Step 3 on the frozen real GB home: a vendor with its own units and one signed figure per direction
// ("acme": kW, grid positive = import, battery positive = charging) plugs in as channel rows. Its facts are
// the real inverter's, re-expressed in those units, so the built slots must equal the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { buildSite } = hasLive ? await import('../src/core/build.js') : {};
const { bind } = hasLive ? await import('../src/core/inputs.js') : {};
const { defineChannel, ingestObservations } = hasLive ? await import('../src/core/channels.js') : {};
const { nowSec, dayBounds } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const asOf = () => nowSec() + 1;   // +1: rows written this second are known

function realSeries(source, metric) {
  return db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = ? AND m.code = ? AND s.subject_kind = 'site' AND s.subject_id = ? AND r.superseded_at IS NULL ORDER BY r.ts`).all(source, metric, String(SITE));
}

test('a vendor in kW with signed points plugs in as channel rows and builds the same slots', { skip }, () => {
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const run = () => buildSite(SITE, days[0], days[days.length - 2], { asOf: asOf(), dryRun: true }).hhRows;
  const base = run();

  for (const code of ['acme_kw', 'acme_totals']) db.prepare("INSERT INTO source (code, name, contract) VALUES (?, 'Acme (test)', '{}')").run(code);
  // The vendor's points and how each becomes a canonical metric.
  const kw = { scale: 1000, min: 0, max: 60000 };
  defineChannel(SITE, 'acme_kw', 'pv_kw', 'solar_w', kw);
  defineChannel(SITE, 'acme_kw', 'load_kw', 'load_w', kw);
  defineChannel(SITE, 'acme_kw', 'grid_kw', 'grid_import_w', { ...kw, part: 'positive' });
  defineChannel(SITE, 'acme_kw', 'grid_kw', 'grid_export_w', { ...kw, part: 'negative' });
  defineChannel(SITE, 'acme_kw', 'bat_kw', 'battery_charge_w', { ...kw, part: 'positive' });
  defineChannel(SITE, 'acme_kw', 'bat_kw', 'battery_discharge_w', { ...kw, part: 'negative' });
  defineChannel(SITE, 'acme_kw', 'soc', 'battery_soc_pct', { min: 0, max: 100 });
  const dailyPoints = { solar_kwh: 'pv_today', load_kwh: 'load_today', grid_import_kwh: 'imp_today', grid_export_kwh: 'exp_today', battery_charge_kwh: 'chg_today', battery_discharge_kwh: 'dis_today' };
  for (const [metric, point] of Object.entries(dailyPoints)) defineChannel(SITE, 'acme_totals', point, metric, { min: 0, max: 500 });

  // The real inverter's samples, re-expressed in the vendor's units and signs.
  const series = Object.fromEntries(['solar_w', 'load_w', 'grid_import_w', 'grid_export_w', 'battery_charge_w', 'battery_discharge_w', 'battery_soc_pct'].map((m) => [m, new Map(realSeries('sunsynk_5min', m).map((r) => [r.ts, r.value]))]));
  const at = [...series.solar_w.keys()];
  const obs = [];
  for (const ts of at) {
    const g = (m) => series[m].get(ts) ?? 0;
    obs.push({ point: 'pv_kw', ts, value: g('solar_w') / 1000 }, { point: 'load_kw', ts, value: g('load_w') / 1000 },
      { point: 'grid_kw', ts, value: (g('grid_import_w') - g('grid_export_w')) / 1000 }, { point: 'bat_kw', ts, value: (g('battery_charge_w') - g('battery_discharge_w')) / 1000 });
    if (series.battery_soc_pct.has(ts)) obs.push({ point: 'soc', ts, value: series.battery_soc_pct.get(ts) });
  }
  obs.push({ point: 'firmware_temp', ts: at[0], value: 41 });   // a point nobody mapped
  const out = ingestObservations(SITE, 'acme_kw', obs);
  assert.deepEqual(out.unmapped, ['firmware_temp'], 'an unmapped point is reported, not dropped silently');
  assert.equal(out.rejected, 0);
  assert.ok(out.written > 1000);

  const totals = db.prepare(`SELECT f.start_ts, f.end_ts, f.value, m.code AS metric FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = 'sunsynk_daily' AND s.subject_id = ? AND f.superseded_at IS NULL`).all(String(SITE));
  ingestObservations(SITE, 'acme_totals', totals.map((t) => ({ point: dailyPoints[t.metric], start: t.start_ts, end: t.end_ts, value: t.value })));

  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE);
  const [dStart] = dayBounds(site.timezone, days[Math.floor(days.length / 2)]);
  bind(SITE, 'inverter_5min', 'acme_kw', { from: dStart, reason: 'test: vendor in kW' });
  bind(SITE, 'inverter_daily', 'acme_totals', { from: dStart, reason: 'test: vendor totals' });
  const after = run();
  const b = new Map(base.map((r) => [r.slot_start, r]));
  let compared = 0;
  for (const r of after) {
    if (r.slot_start < dStart) continue;
    const o = b.get(r.slot_start);
    for (const k of ['solar', 'home', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'total_cost']) {
      if (o[k] == null && r[k] == null) continue;
      assert.ok(Math.abs((r[k] ?? 0) - (o[k] ?? 0)) < 1e-6 * Math.max(1, Math.abs(o[k] ?? 0)) + 1e-6, `${r.slot_start} ${k}: ${r[k]} vs ${o[k]}`);
    }
    compared++;
  }
  assert.ok(compared > 100, `${compared} slots after the switch compared`);
  assert.equal(JSON.parse(after.find((r) => r.slot_start >= dStart && r.solar > 0).lineage).solar, 'acme_kw');
});

test('a value outside the channel range is rejected and kept in channel_reject, never written', { skip }, () => {
  const before = db.prepare("SELECT COUNT(*) n FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id WHERE so.code = 'acme_kw'").get().n;
  const ts = 1900000000;
  const out = ingestObservations(SITE, 'acme_kw', [{ point: 'pv_kw', ts, value: 500000 }, { point: 'pv_kw', ts: ts + 300, value: 'abc' }, { point: 'pv_kw', ts: ts + 600, value: 4 }]);
  assert.equal(out.rejected, 2);
  assert.equal(out.written, 1);
  const rows = db.prepare('SELECT reason FROM channel_reject WHERE ts >= ? ORDER BY ts').all(ts).map((r) => r.reason);
  assert.deepEqual(rows, ['out_of_range', 'not_a_number']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id WHERE so.code = 'acme_kw'").get().n, before + 1);
});

test('a vendor that reports every 15 minutes declares its hold in source traits and keeps full coverage', { skip }, () => {
  const { holdSOf } = { holdSOf: (c) => JSON.parse(db.prepare('SELECT traits FROM source WHERE code = ?').get(c).traits || '{}').holdS ?? 300 };
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  // A window after the earlier test's switch, so the new binding follows the open one instead of overlapping it.
  const [a] = dayBounds('Europe/London', days[10]); const [, b] = dayBounds('Europe/London', days[11]);
  const run = () => buildSite(SITE, days[10], days[11], { asOf: asOf(), dryRun: true });
  const solar = (res) => res.hhRows.reduce((t, r) => t + (r.solar || 0), 0);
  const baseKwh = solar(run());
  db.prepare("INSERT INTO source (code, name, contract, traits) VALUES ('acme_slow', 'Acme slow (test)', '{}', '{\"holdS\":900}')").run();
  assert.equal(holdSOf('acme_slow'), 900);
  defineChannel(SITE, 'acme_slow', 'pv_w', 'solar_w', { min: 0, max: 60000 });
  const real = realSeries('sunsynk_5min', 'solar_w').filter((r) => r.ts >= a && r.ts < b && r.ts % 900 === 0);
  ingestObservations(SITE, 'acme_slow', real.map((r) => ({ point: 'pv_w', ts: r.ts, value: r.value })));
  bind(SITE, 'inverter_5min', 'acme_slow', { from: a, reason: 'test: 15-minute vendor' });
  const slow = solar(run());
  assert.ok(baseKwh > 1, 'there is solar that day');
  assert.ok(Math.abs(slow - baseKwh) / baseKwh < 0.1, `15-minute samples held 15 minutes: ${slow.toFixed(2)} vs ${baseKwh.toFixed(2)} kWh`);
});
