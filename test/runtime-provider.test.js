// Runtime provider change on the frozen real GB home (R1 and R4 of docs/slot-engine-solution.md):
// retiring a meter must not unprice the home or move past slots, and a source row added while the
// process runs must work without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { sourceId } = hasLive ? await import('../src/db/db.js') : {};
const { buildSite } = hasLive ? await import('../src/core/build.js') : {};
const { seriesId, putReadings } = hasLive ? await import('../src/core/facts.js') : {};
const { asWriter } = hasLive ? await import('../src/core/facts.js') : {};
const { retireDevice } = hasLive ? await import('../src/core/devices.js') : {};
const { localDate, addDays, nowSec } = hasLive ? await import('../src/core/time.js') : {};

const SITE = 1;
const slotS = () => db.prepare('SELECT slot_s FROM site WHERE id = ?').get(SITE).slot_s ?? 1800;   // the home's own slot length (TEST_SLOT_S changes it)
const round = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

function snapshot() {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(SITE).d;
  const last = addDays(localDate(site.timezone, nowSec()), -1);
  const res = buildSite(SITE, first, last, { asOf: nowSec(), dryRun: true });
  const volatile = new Set(['built_at', 'lineage']);
  const h = createHash('sha256');
  let cost = 0;
  for (const r of res.hhRows) {
    h.update(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !volatile.has(k)).map(([k, v]) => [k, round(v)]))));
    cost += r.total_cost || 0;
  }
  return { hash: h.digest('hex'), cost: round(cost), slots: res.hhRows.length };
}

// Step 2 (first in the file: later tests retire the import meter of this shared database): the other roles follow the same rule. A second meter vendor and a second carbon source exist only
// as data; each is bound from a date, and slots from that date read it.
test('meter and carbon roles switch vendor from a date, with no engine edit', { skip }, async () => {
  const { bind } = await import('../src/core/inputs.js');
  const { dayBounds } = await import('../src/core/time.js');
  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE);
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const [dStart] = dayBounds(site.timezone, days[Math.floor(days.length / 2)]);
  const run = () => buildSite(SITE, days[0], days[days.length - 2], { asOf: nowSec() + 1, dryRun: true }).hhRows;
  const clone = (from, to) => {
    db.prepare("INSERT INTO source (code, name, contract) VALUES (?, 'Test vendor', '{}')").run(to);
    const target = sourceId(to);
    for (const s of db.prepare('SELECT s.id, s.subject_kind, s.subject_id, s.metric_id FROM series s JOIN source so ON so.id = s.source_id WHERE so.code = ?').all(from)) {
      const id = Number(db.prepare('INSERT INTO series (subject_kind, subject_id, metric_id, source_id) VALUES (?, ?, ?, ?)').run(s.subject_kind, s.subject_id, s.metric_id, target).lastInsertRowid);
      db.prepare('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at) SELECT ?, start_ts, end_ts, value * 2, quality, recorded_at FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL').run(id, s.id);
    }
  };
  const base = run();
  const bMap = new Map(base.map((r) => [r.slot_start, r]));
  clone('octopus_meter', 'acme_meter');
  clone('carbon_regional', 'acme_carbon');
  bind(SITE, 'meter_energy', 'acme_meter', { from: dStart, reason: 'test: meter vendor switch' });
  bind(SITE, 'carbon', 'acme_carbon', { from: dStart, reason: 'test: carbon source switch' });
  const after = run();
  let before = 0; let imp = 0; let impDoubled = 0; let co = 0; let coDoubled = 0;
  for (const r of after) {
    const o = bMap.get(r.slot_start);
    if (r.slot_start < dStart) { assert.equal(r.grid_import, o.grid_import); assert.equal(r.carbon_intensity, o.carbon_intensity); before++; continue; }
    if (JSON.parse(o.lineage).import === 'meter' && o.grid_import > 0.05) { imp++; if (JSON.parse(r.lineage).meter === 'acme_meter' && Math.abs(r.grid_import - 2 * o.grid_import) < 0.02 * o.grid_import + 0.002) impDoubled++; }
    if (o.carbon_intensity > 1) { co++; if (Math.abs(r.carbon_intensity - 2 * o.carbon_intensity) < 0.02 * o.carbon_intensity + 0.01) coDoubled++; }
  }
  assert.ok(before > 100 && imp > 20 && co > 20, `compared ${before} / ${imp} / ${co}`);
  assert.ok(impDoubled / imp > 0.9, `meter: ${impDoubled}/${imp} read the new vendor`);
  assert.ok(coDoubled / co > 0.9, `carbon: ${coDoubled}/${co} read the new source`);
});

test('R1: retiring the import meter keeps the tariff agreements, so the home stays priced', { skip }, () => {
  const base = snapshot();
  assert.ok(base.cost > 0, 'the fixture home is priced');
  const agreements = () => db.prepare('SELECT COUNT(*) n FROM tariff_agreement WHERE superseded_at IS NULL').get().n;
  const before = agreements();
  const imp = db.prepare("SELECT id FROM device WHERE site_id = ? AND kind = 'meter_import' AND retired_at IS NULL").get(SITE);
  retireDevice(imp.id);
  assert.equal(agreements(), before, 'no agreement is superseded by retiring a device');
  const after = snapshot();
  assert.equal(after.slots, base.slots);
  assert.ok(after.cost > 0, 'still priced after the meter is retired');
});

test('R3 (part): a source row added while the process runs is found without a restart', { skip }, () => {
  assert.throws(() => sourceId('vendor_added_later'), /unknown source/);
  db.prepare("INSERT INTO source (code, name, contract) VALUES ('vendor_added_later', 'Added at runtime', '{}')").run();
  const id = sourceId('vendor_added_later');
  assert.ok(id > 0);
  assert.equal(sourceId('vendor_added_later'), id, 'cached afterwards');
});

test('R1 (re-add): a meter added again after retiring leaves the home priced and the slot count unchanged', { skip }, () => {
  const base = snapshot();
  db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'meter_import', 'octopus', 'fixture-readd', 'meter_import', '{}', ?)").run(SITE, Date.now());
  const again = snapshot();
  assert.equal(again.slots, base.slots);
  assert.ok(again.cost > 0, 'priced after the meter is added again');
});

test('R4: a writer cannot file facts under another source, and its real readings are untouched', { skip }, () => {
  const real = db.prepare(`SELECT s.id, s.subject_kind AS k, s.subject_id AS sid, m.code AS metric, so.code AS source
    FROM series s JOIN metric m ON m.id = s.metric_id JOIN source so ON so.id = s.source_id WHERE so.code = 'sunsynk_5min' LIMIT 1`).get();
  assert.ok(real, 'fixture has inverter readings');
  const count = () => db.prepare('SELECT COUNT(*) n FROM reading WHERE series_id = ? AND superseded_at IS NULL').get(real.id).n;
  const before = count();
  assert.throws(() => asWriter('open_meteo', () => putReadings(real.id, [{ ts: 1, value: 1 }])), /another source/);
  assert.equal(count(), before);
  asWriter('sunsynk_5min', () => putReadings(real.id, [])); // its own series is accepted
});

// R3 / R2 on the frozen home: a second inverter vendor "acme" exists only as data (source rows, series,
// facts) and a binding. Its facts are the real inverter's, doubled, so the effect of the binding is easy
// to see. Nothing in src/ names it.
test('R2 and R3: a new vendor bound from a date changes slots from that date only, with no engine edit', { skip }, async () => {
  const { bind } = await import('../src/core/inputs.js');
  const { dayBounds } = await import('../src/core/time.js');
  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE);
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const D = days[Math.floor(days.length / 2)];
  const [dStart] = dayBounds(site.timezone, D);

  const run = () => {
    const first = days[0]; const last = days[days.length - 2];
    return buildSite(SITE, first, last, { asOf: nowSec() + 1, dryRun: true }).hhRows; // +1: rows written this second are known
  };
  const base = run();
  const beforeBind = nowSec() + 1;
  await new Promise((r) => setTimeout(r, 1100));

  for (const [legacy, code] of [['sunsynk_5min', 'acme_5min'], ['sunsynk_daily', 'acme_daily']]) {
    db.prepare("INSERT INTO source (code, name, contract) VALUES (?, 'Acme inverter (test)', '{}')").run(code);
    const acme = sourceId(code);
    for (const s of db.prepare('SELECT s.id, s.metric_id FROM series s JOIN source so ON so.id = s.source_id WHERE so.code = ? AND s.subject_kind = ? AND s.subject_id = ?').all(legacy, 'site', String(SITE))) {
      const id = Number(db.prepare('INSERT INTO series (subject_kind, subject_id, metric_id, source_id) VALUES (?, ?, ?, ?)').run('site', String(SITE), s.metric_id, acme).lastInsertRowid);
      db.prepare('INSERT INTO reading (series_id, ts, value, quality, recorded_at) SELECT ?, ts, value * 2, quality, recorded_at FROM reading WHERE series_id = ? AND superseded_at IS NULL').run(id, s.id);
      db.prepare('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, quality, recorded_at) SELECT ?, start_ts, end_ts, value * 2, quality, recorded_at FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL').run(id, s.id);
    }
  }

  const unbound = run();
  assert.equal(JSON.stringify(unbound.map((r) => [r.slot_start, r.solar])), JSON.stringify(base.map((r) => [r.slot_start, r.solar])), 'new facts without a binding change nothing');

  bind(SITE, 'inverter_5min', 'acme_5min', { from: dStart, reason: 'test: vendor switch' });
  bind(SITE, 'inverter_daily', 'acme_daily', { from: dStart, reason: 'test: vendor switch' });
  const after = run();
  const key = (rows, pick) => new Map(rows.map((r) => [r.slot_start, r]));
  const b = key(base); let beforeSame = 0; let afterDoubled = 0; let afterSlots = 0;
  for (const r of after) {
    const o = b.get(r.slot_start);
    if (r.slot_start < dStart) { assert.equal(r.solar, o.solar, `slot ${r.slot_start} before the switch is unchanged`); beforeSame++; } else if (o.solar > 0.05) { afterSlots++; if (Math.abs(r.solar - 2 * o.solar) < 0.02 * o.solar + 0.002) afterDoubled++; }
  }
  assert.ok(beforeSame > 100, 'slots before the switch were compared');
  assert.ok(afterSlots > 20, 'slots after the switch with solar were compared');
  assert.ok(afterDoubled / afterSlots > 0.9, `after the switch the slots read the new vendor (${afterDoubled}/${afterSlots})`);
  // Replay: a build as known before the binding was recorded still reads the old source.
  const replay = buildSite(SITE, days[0], days[days.length - 2], { asOf: beforeBind, dryRun: true }).hhRows;
  assert.equal(JSON.stringify(replay.map((r) => [r.slot_start, r.solar])), JSON.stringify(base.map((r) => [r.slot_start, r.solar])), 'as known before the binding: unchanged');
  const lin = JSON.parse(after.find((r) => r.slot_start >= dStart && r.solar > 0).lineage);
  assert.equal(lin.solar, 'acme_5min', 'lineage names the source in force');
});

// Step 1b: the planner read follows the same bindings as the build, across the switch.
test('build and planner read agree within 0.1% across a vendor switch', { skip }, async () => {
  const { counterDifferenceSeries } = await import('../src/core/planner-read.js');
  const { dayBounds } = await import('../src/core/time.js');
  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE);
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const first = days[0]; const last = days[days.length - 2];
  const asOfMs = Date.now() + 1000;
  const rows = buildSite(SITE, first, last, { asOf: Math.ceil(asOfMs / 1000), dryRun: true }).hhRows;
  const [from] = dayBounds(site.timezone, first); const [, to] = dayBounds(site.timezone, last);
  const r = counterDifferenceSeries(SITE, 'solar_kwh', from, to, { stepS: slotS(), asOf: asOfMs });
  const [dStart] = dayBounds(site.timezone, days[Math.floor(days.length / 2)]);
  assert.deepEqual(r.origin.power.sources.slice().sort(), ['acme_5min', 'sunsynk_5min'], 'the planner read uses both bound sources');
  let build = 0; let planner = 0; let worst = 0;
  for (const h of rows) {
    const k = (h.slot_start - r.start) / slotS();
    const p = r.values[k] ?? 0;
    build += h.solar || 0; planner += p;
    worst = Math.max(worst, Math.abs((h.solar || 0) - p));
  }
  assert.ok(build > 10, 'there is solar to compare');
  assert.ok(Math.abs(planner - build) / build < 0.001, `totals ${planner} vs ${build}`);
  assert.ok(worst < 0.01, `worst slot difference ${worst} kWh`);
  assert.ok(rows.some((h) => h.slot_start >= dStart && h.solar > 0), 'the compared range includes slots after the switch');
});

// Step 1a: unbind, the reason rule for past changes, and the impact preview.
test('unbind ends a role at a date; a past change needs a reason; the preview shows the impact and changes nothing', { skip }, async () => {
  const { bind, unbind, bindingsFor } = await import('../src/core/inputs.js');
  const { previewImpact } = await import('../src/core/impact.js');
  const { dayBounds } = await import('../src/core/time.js');
  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(SITE);
  const days = db.prepare('SELECT local_date d FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE).map((r) => r.d);
  const [dStart] = dayBounds(site.timezone, days[Math.floor(days.length / 2)]);

  const rowsBefore = db.prepare('SELECT COUNT(*) n FROM binding').get().n;
  assert.throws(() => unbind(SITE, 'inverter_5min', { at: dStart }), /say why/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM binding').get().n, rowsBefore, 'a refused change writes nothing');

  const imp = previewImpact(SITE, () => unbind(SITE, 'inverter_5min', { at: dStart, reason: 'preview' }));
  assert.ok(imp.changed > 0, 'ending the inverter source removes its slots\' solar');
  assert.ok(imp.byField.solar, 'solar is among the fields that move');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM binding').get().n, rowsBefore, 'the preview kept nothing');

  unbind(SITE, 'inverter_5min', { at: dStart, reason: 'test: provider removed' });
  const b = bindingsFor(SITE, 'inverter_5min');
  assert.ok(b.length && b.every((x) => x.to <= dStart), 'the role has no source from the end date on');
  assert.equal(b.some((x) => x.to === Infinity), false);
});
