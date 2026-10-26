// The slot calculation trace (src/core/explain.js, GET /api/explorer/slot) on the three SYNTHETIC
// homes of scripts/lib/multi-market.js (GB half-hours, FR half-hours, NL quarter-hours) in a temp
// database: the trace is the production build's own values (build.js opts.trace), it equals the
// stored row, its steps reproduce the row's numbers, a corrupted row is caught, and a build with
// no trace is byte-identical to one with a trace (the trace is a no-op on the rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
globalThis.fetch = async (url) => { throw new Error(`no network in tests: ${url}`); };
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { buildSite } = await import('../src/core/build.js');
const { explainSlot, compareRows, qualityBits, efficiencyNote } = await import('../src/core/explain.js');
const { setSlotLength } = await import('../src/core/sites.js');
const { dayBounds } = await import('../src/core/time.js');

const homes = m.buildScenario();
const { gb, fr, nl } = homes;
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs((a ?? 0) - (b ?? 0)) <= eps, `${msg} ${a} vs ${b}`);
const step = (e, id) => e.steps.find((s) => s.id === id);
const val = (list, name) => { const x = list.find((i) => i.name === name); assert.ok(x, `no ${name}`); return x.value; };
const STEPS = ['inputs', 'align', 'reconcile', 'allocate', 'price', 'check'];

test('every slot of a GB clock-change day: the trace equals the stored row and its steps reproduce the row', () => {
  const rows = m.hhRows(gb.site.id, m.GB.change, m.GB.change);
  assert.equal(rows.length, 50);
  for (const row of rows) {
    const e = explainSlot(gb.site.id, row.slot_start);
    assert.equal(e.matches_stored, true, `slot ${row.slot_start}: ${JSON.stringify(e.diffs)}`);
    assert.equal(e.lineage_matches, true);
    assert.deepEqual(e.steps.map((s) => s.id), STEPS);
    for (const s of e.steps) {
      assert.equal(typeof s.title, 'string'); assert.ok(s.plain_explanation.length > 20); assert.equal(typeof s.formula, 'string');
      for (const k of ['inputs', 'intermediates', 'result']) assert.ok(Array.isArray(s[k]), `${s.id}.${k}`);
      for (const i of [...s.inputs, ...s.intermediates, ...s.result]) assert.ok('name' in i && 'value' in i && 'unit' in i);
    }
    // Balance: what came in minus what went out, from the reconcile step's own figures.
    const rec = step(e, 'reconcile');
    near(val(rec.intermediates, 'balance'), row.solar + row.grid_import + row.battery_discharge - row.grid_export - row.battery_charge, 1e-12, 'balance');
    near(val(rec.result, 'home'), row.home, 0, 'home');
    // Allocation: every source's flows add up to what it supplied; the home's flows to its use.
    const out = (from) => e.flows.filter((f) => f.from === from).reduce((s, f) => s + f.kwh, 0);
    near(out('solar'), row.solar, 1e-12, 'solar flows'); near(out('battery'), row.battery_discharge, 1e-12, 'battery flows'); near(out('grid'), row.grid_import, 1e-12, 'grid flows');
    near(e.flows.filter((f) => f.to === 'home').reduce((s, f) => s + f.kwh, 0), row.home, 1e-12, 'home flows');
    for (const f of e.flows) near(f.kwh, row[`${f.from}_to_${f.to}`], 0, `${f.from}_to_${f.to}`);
    // Price x kWh = cost.
    const inc = e.price.import.inc;
    near(inc, row.import_rate_ex * (1 + row.import_vat), 1e-12, 'inc');
    near(e.price.import.unit_ex * (1 + e.price.import.vat), inc, 1e-12);
    const pr = step(e, 'price');
    near(val(pr.result, 'grid_to_home_cost'), row.grid_to_home * inc, 1e-9, 'g>home cost');
    near(val(pr.result, 'total_cost'), (row.grid_to_home + row.grid_to_battery + row.grid_to_loss) * inc + row.standing_cost + (row.gas_cost ?? 0) - (row.solar_to_grid + row.battery_to_grid) * e.price.export.inc, 1e-9, 'total');
    near(val(pr.result, 'total_cost'), row.total_cost, 0, 'stored total');
    near(e.price.standing.per_slot, (e.price.standing.per_day_inc * row.dur_s) / e.price.standing.day_length_s, 1e-9, 'standing share');
    // Inputs carry their source and series; the quality bits name the stored value's bits.
    assert.ok(step(e, 'inputs').inputs.some((i) => i.source === 'sunsynk_5min' && i.series_id != null));
    assert.ok(step(e, 'inputs').inputs.some((i) => i.source === 'octopus_meter'));
    assert.equal(e.quality.bits.reduce((q, b) => q | b.bit, 0), row.quality);
  }
});

test('NL quarter-hours: per-kWh levy and VAT lines, inc = unit_ex x (1 + vat); FR: standing by the slot\'s share of the day', () => {
  const neg = Date.parse(m.NL.negativeAt) / 1000;
  const e = explainSlot(nl.site.id, neg);
  assert.equal(e.matches_stored, true, JSON.stringify(e.diffs));
  assert.equal(e.dur_s, 900);
  const p = e.price.import;
  assert.ok(p.tax_lines.length >= 2 && p.tax_lines.some((l) => l.kind === 'per_kwh') && p.tax_lines.some((l) => l.kind === 'percent'));
  near(p.unit_ex, p.supply_ex + p.levy, 1e-9, 'unit_ex = supplier + levy');
  near(p.inc, p.unit_ex * (1 + p.vat), 1e-12);
  assert.equal(p.pieces.length, 1);
  near(p.pieces[0].price, p.inc, 1e-12);
  assert.ok(p.inc < 0, 'a negative quarter');
  const fr1 = m.hhRows(fr.site.id, m.FR.change, m.FR.change)[30];
  const f = explainSlot(fr.site.id, fr1.slot_start);
  assert.equal(f.matches_stored, true);
  const [a, b] = dayBounds(m.FR.tz, m.FR.change);
  // A monthly charge is spread by real seconds in micro-units (tariff-expand.js), so within 1e-6.
  near(f.price.standing.per_slot, (f.price.standing.per_day_inc * 1800) / (b - a), 1e-6, 'FR standing');
  assert.equal(b - a, 23 * 3600);
});

test('as known now, a trace rebuilt from the first day still equals the stored row', () => {
  const row = m.hhRows(gb.site.id, m.GB.to, m.GB.to)[20];
  const e = explainSlot(gb.site.id, row.slot_start, { asOfMs: Date.now() });
  assert.equal(e.rebuild.as_of_ms > 0, true);
  assert.equal(e.rebuild.from, m.GB.from);
  assert.equal(e.matches_stored, true, JSON.stringify(e.diffs));
});

test('a corrupted stored row: matches_stored false, the column named', () => {
  const row = m.hhRows(gb.site.id, m.GB.from, m.GB.from)[16];
  db.prepare('UPDATE site_hh SET total_cost = total_cost + 7, home = home + 0.5 WHERE site_id = ? AND slot_start = ?').run(gb.site.id, row.slot_start);
  try {
    const e = explainSlot(gb.site.id, row.slot_start);
    assert.equal(e.matches_stored, false);
    // The rebuild reads the altered row as the version before it, so it also marks the slot restated.
    assert.deepEqual(e.diffs.map((d) => d.field).sort(), ['home', 'quality', 'total_cost']);
    near(e.diffs.find((d) => d.field === 'total_cost').diff, -7, 1e-9);
    assert.match(e.notes.join(' '), /out of date|edited/);
  } finally {
    db.prepare('UPDATE site_hh SET total_cost = ?, home = ? WHERE site_id = ? AND slot_start = ?').run(row.total_cost, row.home, gb.site.id, row.slot_start);
  }
  assert.equal(explainSlot(gb.site.id, row.slot_start).matches_stored, true);
});

test('the trace is a no-op on the rows: a build with and without it is byte-identical (all columns)', () => {
  const all = (res) => JSON.stringify([res.hhRows.map(({ built_at, ...r }) => r), res.dayRows.map(({ built_at, ...r }) => r), res.checks]);
  for (const [h, w] of [[gb, m.GB], [fr, m.FR], [nl, m.NL]]) {
    const plain = buildSite(h.site.id, w.from, w.to, { dryRun: true });
    const slot = plain.hhRows[Math.floor(plain.hhRows.length / 2)].slot_start;
    const trace = { slot };
    const traced = buildSite(h.site.id, w.from, w.to, { dryRun: true, trace });
    assert.equal(all(traced), all(plain), `${w.tz}`);
    assert.ok(trace.slotTrace?.row, 'the trace was filled');
    assert.equal(trace.slotTrace.row.slot_start, slot);
    // An explicit undefined trace is the same as none.
    assert.equal(all(buildSite(h.site.id, w.from, w.to, { dryRun: true, trace: undefined })), all(plain));
    assert.equal(m.fingerprint(traced.hhRows), m.fingerprint(plain.hhRows));
  }
});

test('bad slots: not on the home\'s grid is 400, an unbuilt one 404; quality bits and compareRows', () => {
  const row = m.hhRows(gb.site.id, m.GB.from, m.GB.from)[0];
  assert.throws(() => explainSlot(gb.site.id, row.slot_start + 60), (e) => e.status === 400 && /not the start/.test(e.message));
  assert.throws(() => explainSlot(gb.site.id, row.slot_start - 30 * 86400), (e) => e.status === 404);
  assert.throws(() => explainSlot(999, row.slot_start), (e) => e.status === 404);
  assert.deepEqual(qualityBits(1 | 32).map((b) => b.name), ['MEASURED', 'SUSPECT']);
  const r = compareRows({ a: 1, lineage: '{"x":1}' }, { a: 1 + 1e-8, lineage: '{"x":1,"y":2}' });
  assert.equal(r.matches, true); assert.equal(r.lineage_matches, false); assert.deepEqual(r.lineage_diffs.map((d) => d.key), ['y']);
});

test('plain words: each step says what happened, with the slot\'s own numbers and no jargon', () => {
  const rows = m.hhRows(gb.site.id, m.GB.change, m.GB.change);
  const row = rows.find((r) => r.solar_to_home > 0.05 && r.state === 'final');
  assert.ok(row, 'a sunny slot');
  const e = explainSlot(gb.site.id, row.slot_start);
  assert.deepEqual(e.steps.map((s) => s.title), ['What we read', 'From power readings to energy', 'Choosing the right numbers', 'Where each kWh went', 'What it cost', 'Checks and status']);
  const text = (id) => step(e, id).plain_explanation;
  const k3 = (v) => `${v.toFixed(3)} kWh`; const p2 = (v) => `${v.toFixed(2)} p`;
  assert.ok(text('reconcile').includes(`The smart meter measured ${k3(row.grid_import)} bought from the grid this half-hour`), text('reconcile'));
  assert.ok(text('reconcile').includes('We use the meter because it is the supplier\'s official reading.'));
  assert.ok(text('reconcile').includes('(its "clamp")'), 'the clamp is explained where it appears');
  assert.ok(text('allocate').startsWith(`Solar made ${k3(row.solar)}. First it covers the house (${k3(row.solar_to_home)})`), text('allocate'));
  assert.ok(text('price').includes(`The price was ${p2(row.import_rate_ex)} per kWh before VAT`), text('price'));
  assert.ok(text('price').includes(`With 5% VAT you pay ${p2(row.import_rate_ex * 1.05)} per kWh.`));
  assert.ok(text('price').includes(`${p2(row.standing_cost)} for this one`));
  assert.ok(text('price').includes(row.total_cost >= 0 ? `Total for the half-hour: ${p2(row.total_cost)}.` : `a credit of ${p2(-row.total_cost)}`));
  assert.match(text('align'), /every five minutes/);
  assert.match(text('check'), /^This half-hour is final/);
  for (const s of e.steps) {
    assert.doesNotMatch(s.plain_explanation, /FIFO|\bCT\b|fit factor|lineage|unit_ex|site_hh|\bslot\b/, `${s.id}: ${s.plain_explanation}`);
    assert.ok(s.formula.length > 0, 'the formula text is kept');
  }
  // The battery, where it fed the house, is explained as a queue.
  const batt = m.hhRows(gb.site.id, m.GB.to, m.GB.to).find((r) => r.battery_to_home > 0.05 && r.battery_to_home_cost != null);
  if (batt) {
    const b = step(explainSlot(gb.site.id, batt.slot_start), 'price').plain_explanation;
    assert.ok(b.includes(`The ${k3(batt.battery_to_home)} the battery gave the house had cost ${p2(batt.battery_to_home_cost)} to store.`), b);
    assert.match(b, /like a queue: energy that went in first comes out first/);
  }
  // The build's efficiency note reads without a double sign.
  const note = efficiencyNote('203.5 kWh out ÷ (209.8 kWh in − -5.5 kWh change in stored energy), inverter counters, 30 days to 2026-10-24');
  assert.equal(note.includes('− -'), false);
  assert.match(note, /209\.8 kWh in \+ 5\.5 kWh the battery gave up/);
  assert.equal(efficiencyNote('10.0 kWh out ÷ (11.0 kWh in − 0.5 kWh change in stored energy)'), '10.0 kWh out ÷ (11.0 kWh in − 0.5 kWh change in stored energy)');
});

test('plain words: two quarter-hour prices in a half-hour are named and averaged (NL rebuilt at 30 minutes)', () => {
  setSlotLength(nl.site.id, 1800);
  buildSite(nl.site.id, m.NL.from, m.NL.to, { reason: 'explain test' });
  const rows = m.hhRows(nl.site.id, m.NL.from, m.NL.from);
  assert.ok(rows.every((r) => r.dur_s === 1800));
  let found = 0;
  for (const row of rows) {
    const e = explainSlot(nl.site.id, row.slot_start);
    assert.equal(e.matches_stored, true);
    const pc = e.price.import.pieces;
    if (pc.length !== 2 || pc[0].unit_ex === pc[1].unit_ex) continue;
    found++;
    const c2 = (v) => `${v.toFixed(2)} c`;
    const want = `Price: ${c2(pc[0].unit_ex)} for the first quarter-hour and ${c2(pc[1].unit_ex)} for the second, so the half-hour counts as the average ${c2(row.import_rate_ex)} before VAT.`;
    assert.ok(step(e, 'price').plain_explanation.startsWith(want), `${step(e, 'price').plain_explanation} / ${want}`);
    near(row.import_rate_ex, (pc[0].unit_ex + pc[1].unit_ex) / 2, 1e-9, 'the average');
    assert.match(step(e, 'price').plain_explanation, /c per kWh of energy tax on top of the supplier's/);
  }
  assert.ok(found > 10, `half-hours with two quarter prices: ${found}`);
});
