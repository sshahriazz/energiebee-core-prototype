// Two devices of one kind on one home (two inverters, two batteries): their figures are added. The real
// home's inverter is split 40 / 60 into two devices of the same vendor; the slots built from the two
// must equal the slots built from the one, in the builder and in the planner read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { buildSite } = hasLive ? await import('../src/core/build.js') : {};
const { bind, unbind } = hasLive ? await import('../src/core/inputs.js') : {};
const { ingestObservations } = hasLive ? await import('../src/core/channels.js') : {};
const { counterDifferenceSeries } = hasLive ? await import('../src/core/planner-read.js') : {};
const { nowSec, dayBounds } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const slotS = () => db.prepare('SELECT slot_s FROM site WHERE id = ?').get(SITE).slot_s ?? 1800;   // the home's own slot length (TEST_SLOT_S changes it)

test('two inverters on one home are added: same slots as the single inverter, in the builder and the planner read', { skip }, () => {
  const site = db.prepare('SELECT timezone, battery_kwh FROM site WHERE id = ?').get(SITE);
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const first = days[0]; const last = days[days.length - 2];
  const asOf = () => nowSec() + 1;   // +1: rows written this second are known
  const run = () => buildSite(SITE, first, last, { asOf: asOf(), dryRun: true }).hhRows;
  const base = run();

  const dev = (label, kwh) => Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'inverter', 'sunsynk', ?, ?, ?, 0)").run(SITE, label, label, JSON.stringify({ battery_kwh: kwh })).lastInsertRowid);
  const parts = [[dev('inverter-a', site.battery_kwh * 0.4), 0.4], [dev('inverter-b', site.battery_kwh * 0.6), 0.6]];

  const read = (metric) => new Map(db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = 'sunsynk_5min' AND m.code = ? AND s.subject_kind = 'site' AND s.subject_id = ? AND r.superseded_at IS NULL`).all(metric, String(SITE)).map((r) => [r.ts, r.value]));
  const m = Object.fromEntries(['solar_w', 'load_w', 'grid_import_w', 'grid_export_w', 'battery_charge_w', 'battery_discharge_w', 'battery_soc_pct'].map((k) => [k, read(k)]));
  const totals = db.prepare(`SELECT f.start_ts, f.end_ts, f.value, m.code AS metric FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = 'sunsynk_daily' AND s.subject_kind = 'site' AND s.subject_id = ? AND f.superseded_at IS NULL`).all(String(SITE));
  const label = { solar_kwh: 'PV Generation', load_kwh: 'Load Power Consumption', grid_import_kwh: 'Purchased electricity', grid_export_kwh: 'Sold electricity', battery_charge_kwh: 'Charge Energy', battery_discharge_kwh: 'Discharge Energy' };

  for (const [deviceId, share] of parts) {
    const g = (k, ts) => (m[k].get(ts) ?? 0) * share;
    const obs = [];
    for (const ts of m.solar_w.keys()) {
      obs.push({ point: 'PV', ts, value: g('solar_w', ts) }, { point: 'Load', ts, value: g('load_w', ts) },
        { point: 'Grid', ts, value: g('grid_import_w', ts) - g('grid_export_w', ts) }, { point: 'Battery', ts, value: g('battery_discharge_w', ts) - g('battery_charge_w', ts) });
      if (m.battery_soc_pct.has(ts)) obs.push({ point: 'SOC', ts, value: m.battery_soc_pct.get(ts) });   // a percentage: each battery reports its own level
    }
    ingestObservations(SITE, 'sunsynk_5min', obs, null, { deviceId });
    ingestObservations(SITE, 'sunsynk_daily', totals.map((t) => ({ point: label[t.metric], start: t.start_ts, end: t.end_ts, value: t.value * share })), null, { deviceId });
  }

  const [dStart] = dayBounds(site.timezone, days[Math.floor(days.length / 2)]);
  // The home's own binding ends where the two devices begin; the second device is added beside the first.
  for (const role of ['inverter_5min', 'inverter_daily']) unbind(SITE, role, { at: dStart, deviceId: null, reason: 'test: two inverters' });
  for (const [deviceId] of parts) {
    bind(SITE, 'inverter_5min', 'sunsynk_5min', { from: dStart, deviceId, reason: 'test: two inverters' });
    bind(SITE, 'inverter_daily', 'sunsynk_daily', { from: dStart, deviceId, reason: 'test: two inverters' });
  }

  const after = run();
  const b = new Map(base.map((r) => [r.slot_start, r]));
  let compared = 0; let withSoc = 0;
  for (const r of after) {
    const o = b.get(r.slot_start);
    if (r.slot_start < dStart) { assert.equal(r.solar, o.solar); continue; }
    for (const k of ['solar', 'home', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'total_cost']) {
      assert.ok(Math.abs((r[k] ?? 0) - (o[k] ?? 0)) < 1e-6 * Math.max(1, Math.abs(o[k] ?? 0)) + 1e-6, `${r.slot_start} ${k}: ${r[k]} vs ${o[k]}`);
    }
    if (o.soc_end != null) { withSoc++; assert.ok(Math.abs(r.soc_end - o.soc_end) < 1e-6, `${r.slot_start} soc_end ${r.soc_end} vs ${o.soc_end}`); }
    compared++;
  }
  assert.ok(compared > 100, `${compared} slots compared`);
  assert.ok(withSoc > 50, 'the combined charge level was compared');

  // The planner read adds the same devices.
  const [from] = dayBounds(site.timezone, first); const [, to] = dayBounds(site.timezone, last);
  const pr = counterDifferenceSeries(SITE, 'solar_kwh', from, to, { stepS: slotS(), asOf: Date.now() + 1000 });
  let sb = 0; let sp = 0;
  for (const h of after) { sb += h.solar || 0; sp += pr.values[(h.slot_start - pr.start) / slotS()] ?? 0; }
  assert.ok(Math.abs(sp - sb) / sb < 0.001, `planner ${sp} vs builder ${sb}`);

  // Control: with the second device unbound only the first one's 40% is left, so the sum above was real.
  unbind(SITE, 'inverter_5min', { at: dStart, deviceId: parts[1][0], reason: 'test: control' });
  const only = run().find((r) => r.slot_start >= dStart && b.get(r.slot_start).solar > 0.2);
  assert.ok(Math.abs(only.solar - 0.4 * b.get(only.slot_start).solar) < 0.02 * b.get(only.slot_start).solar + 1e-3, `one device: ${only.solar} vs 0.4 x ${b.get(only.slot_start).solar}`);
});
