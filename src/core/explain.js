// The calculation trace of one slot, for the Data Explorer (GET /api/explorer/slot): how every
// number of a site_hh row was made, step by step, from the facts it read.
//
// There is no second copy of the build's maths here. The containing day is rebuilt as a dry run by
// the production engine (build.js buildSite, { dryRun, trace: { slot } }); the build fills the trace
// with the values it computed for exactly that slot (samples, fit factors, meter vs clamp, balance,
// flows, prices, battery stock), and this file only arranges them into steps with plain words.
// The rebuilt row is compared with the stored one (matches_stored): a difference means the stored
// timeline is stale (facts or method changed since it was built) or was altered.
//
// Read-only: a dry run writes nothing (as the /asof endpoint, it may create an empty series row
// the build expects, exactly as buildSite always has).
import { db } from '../db/db.js';
import { buildSite, METHOD_VERSION } from './build.js';
import { QUALITY, withKnownAt, inForce } from './facts.js';
import { priceAt, rateRow, fixedPerDay } from './pricing.js';
import { slotLength, slotPhase, slotFloor, localDate, zonedParts, slotNoun, isoUtc, offsetSeconds } from './time.js';

export class ExplainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const QUALITY_BITS = [
  { name: 'MEASURED', meaning: 'the grid import is the smart meter\'s reading' },
  { name: 'FALLBACK', meaning: 'the smart meter reading was not there, so the inverter\'s own sensor on the grid cable (its "clamp") was used' },
  { name: 'INTERPOLATED', meaning: 'a gap between readings was filled in' },
  { name: 'ESTIMATED', meaning: 'a price or a battery cost had to be estimated' },
  { name: 'PARTIAL', meaning: 'the inverter sent readings for less than 80% of the time' },
  { name: 'SUSPECT', meaning: 'more energy went out than came in (by over 0.02 kWh): the measurements disagree' },
  { name: 'CHECK_FAILED', meaning: 'no import price was found, so it is not costed' },
  { name: 'RESTATED', meaning: 'the figures changed after they were first final' },
].map((b) => ({ bit: QUALITY[b.name], ...b }));

export const qualityBits = (q) => QUALITY_BITS.filter((b) => (q & b.bit) !== 0).map((b) => ({ ...b }));

// Fields of a site_hh row that are not compared (when it was built is not a number of the slot).
const VOLATILE = new Set(['built_at', 'site_id']);
const NODE_LABEL = { solar: 'solar', load: 'house load (inverter)', imp: 'grid import (clamp)', exp: 'grid export (clamp)', chg: 'battery charge', dis: 'battery discharge' };
const NODE_METRIC = { solar: 'solar_w', load: 'load_w', imp: 'grid_import_w', exp: 'grid_export_w', chg: 'battery_charge_w', dis: 'battery_discharge_w', soc: 'battery_soc_pct' };
const COUNTER_METRIC = { solar: 'solar_kwh', load: 'load_kwh', imp: 'grid_import_kwh', exp: 'grid_export_kwh', chg: 'battery_charge_kwh', dis: 'battery_discharge_kwh' };

// Numbers are given at full precision (so a step's figures reproduce the row exactly); a value that
// is not a finite number is null.
const r6 = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : v ?? null);
const f = (v, d = 3) => (v == null || !Number.isFinite(v) ? 'unknown' : Number(v).toFixed(d));
const hhmm = (tz, ts) => { const p = zonedParts(tz, ts); return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`; };
const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);
const item = (name, value, unit, extra = {}) => ({ name, value: r6(value), unit, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) });

// Local wall-clock time of an instant with its UTC offset: 2026-10-25T01:30+01:00.
export function localTime(tz, ts) {
  const p = zonedParts(tz, ts);
  const off = offsetSeconds(tz, ts);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}${sign}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
}

// The series metadata (metric, source, subject) of a list of ids, read-only.
export function seriesMeta(ids) {
  const list = [...new Set(ids.filter((x) => x != null))];
  if (!list.length) return new Map();
  return new Map(db.prepare(`SELECT se.id, se.subject_kind, se.subject_id, m.code AS metric, m.unit, so.code AS source FROM series se
      JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id WHERE se.id IN (${list.map(() => '?').join(',')})`).all(...list).map((r) => [r.id, r]));
}

// A site-level series id by metric and source, never created (a read must not write).
export function findSeries(subjectKind, subjectId, metric, source) {
  return db.prepare(`SELECT se.id FROM series se JOIN metric m ON m.id = se.metric_id JOIN source so ON so.id = se.source_id
    WHERE se.subject_kind = ? AND se.subject_id = ? AND m.code = ? AND so.code = ?`).get(subjectKind, String(subjectId), metric, source)?.id ?? null;
}

// Compare a rebuilt row with the stored one: every column but when it was built. Numbers within
// 1e-6 absolute (plus 1e-9 relative): kWh, minor units and prices are all far coarser than that.
// The lineage (where the numbers came from) is compared key by key apart: a row built before a
// lineage key existed has the same numbers, so it still matches; lineage_diffs names the keys.
export function compareRows(stored, rebuilt) {
  const diffs = [];
  if (!stored || !rebuilt) return { matches: false, diffs: [{ field: '*', stored: stored ? 'row' : null, recomputed: rebuilt ? 'row' : null, tolerance: null }], lineage_diffs: [], lineage_matches: false };
  for (const k of new Set([...Object.keys(stored), ...Object.keys(rebuilt)])) {
    if (VOLATILE.has(k) || k === 'lineage') continue;
    const a = stored[k] ?? null; const b = rebuilt[k] ?? null;
    if (typeof a === 'number' && typeof b === 'number') {
      const tol = 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) > tol) diffs.push({ field: k, stored: a, recomputed: b, diff: b - a, tolerance: tol });
    } else if (a !== b) diffs.push({ field: k, stored: a, recomputed: b, tolerance: null });
  }
  const parse = (x) => { if (x == null) return {}; if (typeof x !== 'string') return x; try { return JSON.parse(x); } catch { return { _text: x }; } };
  const la = parse(stored.lineage); const lb = parse(rebuilt.lineage);
  const lineage = [];
  for (const k of new Set([...Object.keys(la), ...Object.keys(lb)])) {
    if (JSON.stringify(la[k] ?? null) !== JSON.stringify(lb[k] ?? null)) lineage.push({ key: k, stored: la[k] ?? null, recomputed: lb[k] ?? null });
  }
  return { matches: diffs.length === 0, diffs, lineage_diffs: lineage, lineage_matches: lineage.length === 0 };
}

// The site, the slot checked against the home's grid, and the stored row.
export function slotContext(siteId, slot) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new ExplainError(`no home ${siteId}`, 404);
  const slotS = slotLength(site);
  if (!Number.isInteger(slot)) throw new ExplainError('slot must be the epoch seconds of a slot start');
  const start = slotFloor(slot, slotS, slotPhase(site.timezone, slotS, slot));
  if (start !== slot) throw new ExplainError(`${slot} is not the start of a ${slotNoun(slotS)} of this home: the slot holding it starts at ${start}`);
  const stored = db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND slot_start = ?').get(siteId, slot) ?? null;
  return { site, slotS, tz: site.timezone, date: localDate(site.timezone, slot), stored };
}

// Rebuild the slot's day as a dry run with the trace. As known at asOfMs, the rebuild starts at the
// home's first day (an as-of rebuild never continues from a stored battery stock, build.js), so it
// costs a whole-history dry run. The moment is passed to the build to the millisecond (asOf in
// fractional seconds), so a fact recorded later in the same second stays invisible.
export function traceSlot(siteId, slot, { asOfMs = null } = {}) {
  const ctx = slotContext(siteId, slot);
  const trace = { slot };
  let first = ctx.date;
  if (asOfMs != null) first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(siteId)?.d ?? ctx.date;
  if (first > ctx.date) first = ctx.date;
  const t0 = Date.now();
  const built = buildSite(siteId, first, ctx.date, { dryRun: true, trace, ...(asOfMs != null ? { asOf: asOfMs / 1000 } : {}) });
  return { ...ctx, trace, built, ms: Date.now() - t0, asOfMs };
}

// recorded_at of the readings and interval facts the slot used (the version in force, or as known at).
function recordedAtOf(readings, intervals, asOfMs) {
  return withKnownAt(asOfMs, () => {
    const out = new Map();
    const bySeries = new Map();
    for (const r of readings) (bySeries.get(r.series_id) || bySeries.set(r.series_id, []).get(r.series_id)).push(r.ts);
    for (const [id, ts] of bySeries) {
      const q = db.prepare(`SELECT ts, recorded_at FROM reading WHERE series_id = ? AND ts >= ? AND ts <= ? AND ${inForce()}`);
      for (const r of q.all(id, Math.min(...ts), Math.max(...ts))) out.set(`r|${id}|${r.ts}`, r.recorded_at);
    }
    const qi = db.prepare(`SELECT recorded_at FROM interval_fact WHERE series_id = ? AND start_ts = ? AND end_ts = ? AND ${inForce()}`);
    for (const x of intervals) out.set(`i|${x.series_id}|${x.start_ts}|${x.end_ts}`, qi.get(x.series_id, x.start_ts, x.end_ts)?.recorded_at ?? null);
    return out;
  });
}

// The unit rate row a price sample used: the agreement in force, then the row covering ts with the
// sample's register and supplier price (an Intelligent Octopus dispatch uses the day's lowest row).
function unitRowOf(p, kind, ts, sample) {
  if (!p || !sample || sample.supplyEx == null) return null;
  const a = p.agreements.find((x) => x.kind === kind && x.valid_from <= ts && (x.valid_to == null || x.valid_to > ts));
  if (!a) return null;
  const same = (r) => Math.abs(r.price_ex_vat - sample.supplyEx) < 1e-9;
  const direct = rateRow(p, a.tariff_id, 'unit', sample.register ?? null, ts) ?? rateRow(p, a.tariff_id, 'unit', 'single', ts);
  if (direct && same(direct)) return { row: direct, tariff: a };
  const near = p.rates.find((r) => r.tariff_id === a.tariff_id && r.component === 'unit' && same(r) && r.valid_from < ts + 86400 && (r.valid_to == null || r.valid_to > ts - 86400));
  return { row: near ?? direct ?? null, tariff: a };
}

const rowRef = (r) => (r ? { rate_id: r.id ?? null, raw_id: r.raw_id ?? null, valid_from: r.valid_from, valid_to: r.valid_to ?? null, price_ex: r.price_ex_vat, register: r.register, payment_method: r.payment_method ?? null, origin: r.origin ?? null, recorded_at: r.recorded_at ?? null, estimated: r.estimated === 1 } : null);

// Tax lines of one price: each rule (or the GB vat_rate figure) in plain fields.
function taxLines(price) {
  const t = price?.tax;
  if (!t) return [];
  if (t.source === 'vat_rate') return [{ code: 'VAT', kind: 'percent', value: t.vat, applies_to: 'all', source: 'vat_rate', origin: 'sourced' }];
  if (t.source === 'none') return [{ code: 'none', kind: 'percent', value: 0, applies_to: 'all', source: 'none', origin: 'placeholder', note: 'no tax rule for this country: taxes taken as 0' }];
  return t.rules.map((r) => ({ id: r.id ?? null, code: r.code, kind: r.kind, value: r.value, applies_to: r.applies_to, seq: r.seq, charge_period: r.charge_period ?? null, source: 'tax_rule', origin: r.origin ?? null, unverified: r.unverified === 1 || r.unverified === true }));
}

// The 15-minute price samples of a slot (priceOver's own sampling, pricing.js), merged where equal.
export function pricePieces(p, kind, slot, slotS) {
  const pieces = [];
  for (let t = slot; t < slot + slotS; t += 900) {
    const s = priceAt(p, kind, t);
    const inc = s?.unitEx != null ? s.unitEx * (1 + s.vat) : null;
    const u = unitRowOf(p, kind, t, s);
    const last = pieces[pieces.length - 1];
    const ref = rowRef(u?.row);
    if (last && last.price === inc && last.register === (s?.register ?? null) && (last.rate?.rate_id ?? null) === (ref?.rate_id ?? null)) { last.to = Math.min(t + 900, slot + slotS); continue; }
    pieces.push({ from: t, to: Math.min(t + 900, slot + slotS), price: r6(inc), unit_ex: r6(s?.unitEx ?? null), supply_ex: r6(s?.supplyEx ?? null), vat: s?.vat ?? null, register: s?.register ?? null, tariff: s?.tariffCode ?? null, rate: ref });
  }
  return pieces;
}

function priceBlock(p, kind, price, slot, slotS, { received = false } = {}) {
  if (!price) return null;
  const inc = price.unitEx != null ? price.unitEx * (1 + price.vat) : null;
  return {
    tariff: price.tariffCode ?? null, register: price.register ?? null, structure: price.structure ?? null,
    unit_ex: r6(price.unitEx), supply_ex: r6(price.supplyEx), levy: r6(price.levy ?? 0), vat: price.vat ?? null,
    tax_source: price.tax?.source ?? null, tax_lines: taxLines(price), tax_unverified: !!price.tax?.unverified,
    inc: r6(inc), weighted: !!price.weighted, estimated: !!price.estimated,
    meaning: received ? 'price received per exported kWh: unit_ex x (1 + vat)' : 'price paid per kWh: unit_ex x (1 + vat)',
    pieces: pricePieces(p, kind, slot, slotS),
  };
}

const NODE_RESULT = { solar: 'solar', chg: 'battery_charge', dis: 'battery_discharge', imp: 'clamp import', exp: 'clamp export', load: 'measured load' };

/**
 * The calculation trace of one slot (GET /api/explorer/slot): { slot, local_time, dur_s, state,
 * quality, row, recomputed, matches_stored, diffs, steps, flows, price, battery, checks, lineage }.
 */
export function explainSlot(siteId, slot, { asOfMs = null } = {}) {
  const t = traceSlot(siteId, slot, { asOfMs });
  const { site, slotS, tz, date, stored, trace: T, built } = t;
  const TS = T.slotTrace; const TD = T.day;
  if (!stored && (!TS || TS.row.state === 'missing')) throw new ExplainError(`no ${slotNoun(slotS)} at ${slot}: not built (it has not ended, or the home has no data then)`, 404);
  const noun = slotNoun(slotS);
  const currency = site.currency ?? 'GBP';
  const rebuilt = TS?.row ?? null;
  const cmp = compareRows(stored, rebuilt);
  const parse = (r) => (r ? { ...r, lineage: r.lineage ? JSON.parse(r.lineage) : null } : null);
  const row = rebuilt ?? stored;
  const out = {
    slot, local_time: localTime(tz, slot), local_date: date, timezone: tz, dur_s: row?.dur_s ?? slotS, currency,
    state: stored?.state ?? rebuilt?.state ?? null,
    quality: { value: stored?.quality ?? rebuilt?.quality ?? 0, bits: [] },
    row: parse(stored), recomputed: parse(rebuilt),
    matches_stored: cmp.matches, diffs: cmp.diffs, lineage_matches: cmp.lineage_matches, lineage_diffs: cmp.lineage_diffs,
    method_version: { stored: stored?.method_version ?? null, current: METHOD_VERSION },
    rebuild: { from: built.days ? (built.dayRows[0]?.local_date ?? date) : date, to: date, ms: t.ms, as_of_ms: asOfMs, approximations: built.approximations ?? [] },
    steps: [], flows: [], price: { import: null, export: null, standing: null, gas: null }, battery: null,
    checks: (built.checks || []).filter((c) => c[0] === date).map(([, code, status, measured, tolerance, detail]) => ({ code, status, measured, tolerance, detail })),
    lineage: row?.lineage ? JSON.parse(row.lineage) : null,
  };
  if (!stored) out.notes = ['There is no saved row for this time yet: these are freshly calculated figures.'];
  else if (cmp.matches && !cmp.lineage_matches) out.notes = [`Every number matches the saved row. Only the saved note of where the numbers came from is older (it lacks ${cmp.lineage_diffs.map((d) => d.key).join(', ')}); recalculating the day would refresh it.`];
  else if (!cmp.matches) {
    out.notes = [stored.method_version !== METHOD_VERSION
      ? `The saved figures were made with an older method (${stored.method_version}); today's method is ${METHOD_VERSION}.`
      : asOfMs != null ? 'These figures are worked out as the data stood at an earlier moment, so they can differ from the saved (latest) ones.'
        : 'The saved figures differ from a fresh calculation: the saved timeline is out of date (data arrived or changed after it was built) or was edited.'];
  }
  if (!TS) { out.notes = [...(out.notes || []), 'A fresh calculation does not produce this time (it is outside the days our data covers now).']; return out; }

  const R = TS.reconcile; const A = TS.allocate; const P = TS.price; const C = TS.costs; const X = TS.context; const S = TS.stock;
  const q = rebuilt.quality;
  out.quality.bits = qualityBits(out.quality.value).map((b) => ({ ...b, why: whyBit(b.name, TS, T, noun) }));
  if (stored && stored.quality !== q) out.quality.recomputed = q;

  // ── inputs ──
  const meta = seriesMeta([...Object.values(T.ids.power), T.ids.soc, T.ids.daily ? Object.values(T.ids.daily) : [],
    ...['import', 'export', 'gas', 'ev'].flatMap((k) => (TS.meter[k] || []).map((x) => x.series_id)), TS.meter.gasCv?.series_id, ...X.carbon.map((x) => x.series_id)].flat());
  const samples = Object.entries(TS.samples).flatMap(([k, rows]) => rows.map((r) => ({ ...r, node: k })));
  const intervals = [...['import', 'export', 'gas', 'ev'].flatMap((k) => TS.meter[k] || []), ...X.carbon, ...(TS.meter.gasCv ? [TS.meter.gasCv] : []),
    ...Object.values(TD.align).map((a) => a.counter).filter(Boolean)];
  const rec = recordedAtOf(samples, intervals, asOfMs);
  const inputs = [];
  for (const s of samples) {
    inputs.push(item(`${NODE_METRIC[s.node]} at ${hhmm(tz, s.ts)}`, s.value, s.node === 'soc' ? '%' : 'W', {
      source: meta.get(s.series_id)?.source ?? 'sunsynk_5min', series_id: s.series_id, raw_id: s.raw_id ?? null, recorded_at: rec.get(`r|${s.series_id}|${s.ts}`) ?? null, ts: s.ts,
      note: s.ts < slot ? 'sample before the slot: its hold (up to 5 minutes) reaches into the slot' : undefined,
    }));
  }
  const factItem = (x, name, unit, note) => item(name, x.value, unit, { source: meta.get(x.series_id)?.source ?? null, series_id: x.series_id, raw_id: x.raw_id ?? null,
    recorded_at: rec.get(`i|${x.series_id}|${x.start_ts}|${x.end_ts}`) ?? null, start_ts: x.start_ts, end_ts: x.end_ts, note });
  const span = (x) => `${hhmm(tz, x.start_ts)}-${hhmm(tz, x.end_ts)}`;
  const shareNote = (x) => (x.share != null ? `this ${noun} took ${f(x.share * 100, 1)}% of it, by the clamp's own profile` : x.overlap < x.end_ts - x.start_ts ? `this ${noun} took ${f((x.overlap / (x.end_ts - x.start_ts)) * 100, 1)}% of it by time` : undefined);
  for (const x of TS.meter.import || []) inputs.push(factItem(x, `smart meter import ${span(x)}`, 'kWh', shareNote(x)));
  for (const x of TS.meter.export || []) inputs.push(factItem(x, `smart meter export ${span(x)}`, 'kWh', shareNote(x)));
  for (const x of TS.meter.gas || []) inputs.push(factItem(x, `gas meter ${span(x)}`, T.gasM3 ? 'm3' : 'kWh', shareNote(x)));
  if (TS.meter.gasCv) inputs.push(factItem(TS.meter.gasCv, `gas calorific value (${T.gasLdz}) for the gas day`, 'MJ/m3'));
  for (const x of TS.meter.ev || []) inputs.push(factItem(x, `EV smart-charge dispatch ${span(x)}`, 'kWh', shareNote(x)));
  for (const [k, a] of Object.entries(TD.align)) if (a.counter) inputs.push(factItem(a.counter, `inverter daily counter ${COUNTER_METRIC[k]} for ${date}`, 'kWh'));
  for (const x of X.carbon) inputs.push(factItem(x, `grid carbon intensity ${span(x)}`, 'gCO2/kWh'));
  if (X.temp != null) inputs.push(item(`outdoor temperature at ${hhmm(tz, X.tempHour)}`, X.temp, 'degC', { source: 'open_meteo', series_id: findSeries('site', site.id, 'outdoor_temp_c', 'open_meteo'), ts: X.tempHour }));
  for (const fc of X.forecast) {
    inputs.push(item(`solar forecast ${span(fc)} (issued ${isoUtc(fc.issued_at)})`, fc.value, 'kWh', { source: fc.source, series_id: fc.source ? findSeries('site', site.id, 'solar_kwh', fc.source) : null, start_ts: fc.start_ts, end_ts: fc.end_ts,
      note: 'the latest issue made before the period started (forecast of record)' }));
  }
  out.price.import = priceBlock(T.pricing, 'meter_import', P.pi, slot, slotS);
  out.price.export = priceBlock(T.pricing, 'meter_export', P.pe, slot, slotS, { received: true });
  out.price.gas = P.pg ? priceBlock(T.pricing, 'meter_gas', P.pg, slot, slotS) : null;
  for (const [dir, block] of [['import', out.price.import], ['export', out.price.export], ['gas', out.price.gas]]) {
    for (const pc of block?.pieces ?? []) if (pc.rate) inputs.push(item(`${dir} unit rate ${pc.tariff} ${pc.register ?? ''} ${hhmm(tz, pc.from)}-${hhmm(tz, pc.to)}`.replace(/\s+/g, ' '), pc.rate.price_ex, 'minor/kWh',
      { source: 'rate_interval', raw_id: pc.rate.raw_id, recorded_at: pc.rate.recorded_at, note: `rate row ${pc.rate.rate_id}, valid ${isoUtc(pc.rate.valid_from)} to ${pc.rate.valid_to ? isoUtc(pc.rate.valid_to) : 'open'}, ex tax` }));
  }
  const standingRow = P.pi && T.pricing.agreements.find((a) => a.kind === 'meter_import' && a.valid_from <= slot && (a.valid_to == null || a.valid_to > slot));
  const sRow = standingRow ? rateRow(T.pricing, standingRow.tariff_id, 'standing', 'single', slot) : null;
  if (sRow) inputs.push(item(`standing charge ${P.pi.tariffCode} per day`, sRow.price_ex_vat, 'minor/day', { source: 'rate_interval', raw_id: sRow.raw_id ?? null, recorded_at: sRow.recorded_at, note: `rate row ${sRow.id}, ex tax` }));
  out.steps.push({
    id: 'inputs', title: '', plain_explanation: '',
    formula: asOfMs != null ? `version in force at as_of: recorded_at <= ${asOfMs} < superseded_at` : 'version in force: superseded_at IS NULL',
    inputs, intermediates: [item('inverter coverage of the slot', TS.coverage, 'fraction')], result: [item('facts read', inputs.length, 'count')],
  });

  // ── align ──
  const nodes = Object.keys(TS.nodes);
  out.steps.push({
    id: 'align', title: '', plain_explanation: '',
    formula: 'kWh = sum(W x held seconds) / 3,600,000;  fit = daily counter / sum of the day\'s kWh (1 when no counter, today, or outside 0.6-1.6);  fitted = kWh x fit',
    inputs: nodes.flatMap((k) => [item(`${NODE_LABEL[k]}: daily counter`, TD.align[k].counter?.value ?? null, 'kWh', { series_id: TD.align[k].counter?.series_id, raw_id: TD.align[k].counter?.raw_id ?? null }),
      item(`${NODE_LABEL[k]}: day's samples integrated`, TD.align[k].integratedDay, 'kWh')]),
    intermediates: nodes.flatMap((k) => [item(`${NODE_LABEL[k]}: integrated in this ${noun}`, TS.nodes[k].integrated ?? 0, 'kWh'), item(`${NODE_LABEL[k]}: seconds covered`, TS.nodes[k].coverS, 's'), item(`${NODE_LABEL[k]}: fit factor`, TS.nodes[k].fit, 'factor')]),
    result: nodes.map((k) => item(NODE_RESULT[k], TS.nodes[k].fitted, 'kWh')),
  });

  // ── reconcile ──
  out.steps.push({
    id: 'reconcile', title: '', plain_explanation: '',
    formula: 'balance = solar + import + discharge - export - charge;  home = min(load, max(0, balance));  loss = balance - load;  meter_vs_ct = meter import - clamp import' + (T.gasM3 ? ';  gas kWh = m3 x 1.02264 x CV / 3.6' : ''),
    inputs: [item('smart meter import', R.mImp, 'kWh', { source: R.meterSource }), item('clamp import (fitted)', TS.nodes.imp.fitted, 'kWh', { source: 'sunsynk_5min' }),
      item('smart meter export', R.mExp, 'kWh', { source: R.meterSource }), item('clamp export (fitted)', TS.nodes.exp.fitted, 'kWh', { source: 'sunsynk_5min' }),
      item('solar', R.solar, 'kWh'), item('battery charge', R.chg, 'kWh'), item('battery discharge', R.dis, 'kWh'), item('measured load', R.measuredLoad, 'kWh'),
      ...(T.gasM3 ? [item('gas volume', R.gasRaw, 'm3'), item('calorific value', R.cv, 'MJ/m3'), item('volume correction', TS.meter.volumeCorrection, 'factor')] : [])],
    intermediates: [item('import source', null, null, { note: R.impSrc ?? 'none' }), item('export source', null, null, { note: R.expSrc ?? 'none' }), item('balance', R.balance, 'kWh')],
    result: [item('grid_import', R.imp, 'kWh'), item('grid_export', R.exp, 'kWh'), item('home', R.home, 'kWh'), item('loss', R.loss, 'kWh'), item('meter_vs_ct', R.meterVsCt, 'kWh'), item('gas', R.gas, 'kWh'), item('ev', R.ev, 'kWh')],
  });

  // ── allocate ──
  out.flows = [['solar', 'home', A.sToHome], ['solar', 'battery', A.sToBatt], ['solar', 'grid', A.sToGrid], ['solar', 'loss', A.sToLoss],
    ['battery', 'home', A.bToHome], ['battery', 'grid', A.bToGrid], ['battery', 'loss', A.bToLoss],
    ['grid', 'home', A.gToHome], ['grid', 'battery', A.gToBatt], ['grid', 'loss', A.gToLoss]].map(([from, to, kwh]) => ({ from, to, kwh: r6(kwh) }));
  out.steps.push({
    id: 'allocate', title: '', plain_explanation: '',
    formula: 's>home = min(solar, home); s>batt = min(solar - s>home, charge); s>grid = min(rest, export); b>home = min(discharge, home - s>home); b>grid = min(discharge - b>home, export - s>grid); g>home = min(home - s>home - b>home, import); g>batt = min(charge - s>batt, import - g>home); x>loss = what each source supplied beyond its flows',
    inputs: [item('solar', R.solar, 'kWh'), item('home', R.home, 'kWh'), item('battery charge', R.chg, 'kWh'), item('battery discharge', R.dis, 'kWh'), item('grid import', R.imp, 'kWh'), item('grid export', R.exp, 'kWh')],
    intermediates: [item('solar left after the home', A.sLeft, 'kWh')],
    result: out.flows.map((x) => item(`${x.from}_to_${x.to}`, x.kwh, 'kWh')),
  });

  // ── price ──
  out.price.standing = P.pi ? {
    tariff: P.pi.tariffCode, per_day_ex: r6(P.pi.standingEx), fixed_periods: P.pi.fixed ?? [], vat: P.pi.vat, per_day_inc: r6(fixedPerDay(P.pi, slot, tz)),
    gas_per_day_inc: P.pg ? r6(fixedPerDay(P.pg, slot, tz)) : null, n_slots_day: TD.nSlotsDay, day_length_s: TD.dayEnd - TD.dayStart, per_slot: r6(C.standing),
    rate: rowRef(sRow), formula: 'per slot = day amount incl. tax x slot length / day length (monthly and yearly charges by real seconds)',
  } : null;
  const stockKwh = (l) => r6(sum((l || []).map((x) => x.kwh)));
  out.battery = {
    efficiency: TD.eff, efficiency_note: efficiencyNote(TD.effNote), capacity_kwh: T.batteryKwh, capacity_source: T.batterySource,
    stock_before: (S.before || []).map((l) => ({ kwh: r6(l.kwh), price: r6(l.p) })), stock_after: (S.after || []).map((l) => ({ kwh: r6(l.kwh), price: r6(l.p) })),
    drawn_kwh: r6(R.dis - S.notCovered), draw_cost: r6(S.drawCost), from_unknown_kwh: r6(S.fromUnknown), not_covered_kwh: r6(S.notCovered), unknown_cost: S.unknownDraw,
    soc_end: S.soc ? r6(S.soc.socEnd) : rebuilt.soc_end, held_kwh: S.soc ? r6(S.soc.held) : null, stock_before_scale_kwh: S.soc ? r6(S.soc.total) : null, stock_total_after_kwh: stockKwh(S.after),
  };
  out.steps.push({
    id: 'price', title: '', plain_explanation: '',
    formula: 'inc = unit_ex x (1 + vat);  total = (g>home + g>batt + g>loss) x inc + standing + gas - (s>grid + b>grid) x export_rate;  grid_only = home x inc + standing + gas;  saving = grid_only - total;  b>home cost = cost of the stock drawn x b>home / discharge',
    inputs: [item('import unit ex tax', P.pi?.unitEx ?? null, 'minor/kWh'), item('import tax (vat)', P.pi?.vat ?? null, 'fraction'), item('export unit ex tax', P.pe?.unitEx ?? null, 'minor/kWh'), item('export tax (vat)', P.pe?.vat ?? null, 'fraction'),
      item('standing per day incl. tax', out.price.standing?.per_day_inc ?? null, 'minor/day'), item(`${noun}s in the day`, TD.nSlotsDay, 'count'),
      ...(P.pg ? [item('gas unit ex tax', P.pg.unitEx, 'minor/kWh'), item('gas tax (vat)', P.pg.vat, 'fraction')] : []),
      item('battery stock before', stockKwh(S.before), 'kWh', { note: (S.before || []).map((l) => `${f(l.kwh)} kWh at ${l.p == null ? 'unknown cost' : f(l.p, 4)}`).join('; ') || 'empty' })],
    intermediates: [item('import price incl. tax', P.impInc, 'minor/kWh'), item('export price received', P.expRate, 'minor/kWh'), item('battery energy drawn', R.dis - S.notCovered, 'kWh'),
      item('cost of the stock drawn', S.drawCost, 'minor'), item('drawn from stock of unknown cost', S.fromUnknown, 'kWh')],
    result: [item('grid_to_home_cost', C.gToHomeCost, 'minor'), item('grid_to_battery_cost', C.gToBattCost, 'minor'), item('loss_cost', C.lossCost, 'minor'), item('battery_to_home_cost', C.bToHomeCost, 'minor'),
      item('standing_cost', C.standing, 'minor'), item('gas_cost', C.gasCost, 'minor'), item('export_credit', C.exportCredit, 'minor'), item('total_cost', C.totalCost, 'minor'), item('grid_only_cost', C.gridOnly, 'minor'),
      item('saving', rebuilt.saving, 'minor')],
  });

  // ── check ──
  const st = TS.state;
  out.steps.push({
    id: 'check', title: '', plain_explanation: '',
    formula: 'state = missing (no import) | provisional (meter expected but not in, or today) | final;  carbon_g = import x intensity;  carbon_saved_g = home x intensity - carbon_g;  solar_forecast = sum of the forecast of record over the slot',
    inputs: [item('inverter coverage', TS.coverage, 'fraction'), item('balance', R.balance, 'kWh'), item('import price found', P.impInc != null ? 1 : 0, 'flag'),
      item('stored state before this rebuild', null, null, { note: st.prev ? `${st.prev.state}, quality ${st.prev.quality}` : 'none' })],
    intermediates: [item('carbon intensity', X.ci, 'gCO2/kWh'), item('forecast parts', X.forecastParts.length, 'count')],
    result: [item('state', null, null, { note: st.state }), item('quality', q, 'bits'), item('carbon_intensity', X.ci, 'gCO2/kWh'), item('carbon_g', X.carbonG, 'gCO2'),
      item('carbon_saved_g', X.carbonSaved, 'gCO2'), item('outdoor_temp', X.temp, 'degC'), item('solar_forecast', X.solarForecast, 'kWh')],
  });
  const W = plainSteps({ out, T, TS, TD, tz, date, slot, slotS, noun, cur: minorOf(currency), samples, asOfMs, rebuilt });
  for (const st of out.steps) Object.assign(st, W[st.id]);
  return out;
}

// ───────────── Plain words ─────────────
// Every step's title and explanation in short sentences for a reader who is not an engineer, with
// the slot's own numbers in them. Words only: every figure is one the build computed (the trace).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
// The minor unit's short name: p (pence) or c (cents).
export const minorOf = (currency) => (currency === 'EUR' ? 'c' : 'p');
// '24 Oct' for a local date.
export const dayWords = (date) => { const [, m, d] = String(date).split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
// '16:00 to 16:30 on 12 Oct' for a slot, in the home's local time.
export function slotWords(tz, slot, slotS) {
  const a = zonedParts(tz, slot); const b = zonedParts(tz, slot + slotS);
  return `${p2(a.hh)}:${p2(a.mm)} to ${p2(b.hh)}:${p2(b.mm)} on ${a.d} ${MONTHS[a.m - 1]}`;
}
// A percentage without trailing zeros: 0.05 -> '5%'.
export const pctWords = (v) => `${+((v ?? 0) * 100).toFixed(2)}%`;
// The build's battery efficiency note, with a negative change in stored energy said plainly
// ('209.8 kWh in − -5.5 kWh' read as a double sign).
export const efficiencyNote = (note) => (note == null ? null : String(note).replace(/− -(\d+(?:\.\d+)?) kWh change in stored energy/, '+ $1 kWh the battery gave up from what it held at the start'));

const NODE_WORDS = { solar: 'solar', load: 'the house', imp: 'grid import', exp: 'grid export', chg: 'battery charging', dis: 'battery discharging' };
const ORDINAL = ['first', 'second', 'third', 'fourth'];

function plainSteps(o) {
  const { out, T, TS, TD, tz, date, slot, slotS, noun, cur, samples, asOfMs, rebuilt } = o;
  const R = TS.reconcile; const A = TS.allocate; const P = TS.price; const C = TS.costs; const X = TS.context; const S = TS.stock;
  const k = (v) => `${f(v ?? 0, 3)} kWh`;
  const m = (v) => `${f(v ?? 0, 2)} ${cur}`;
  const day = dayWords(date);
  const nz = (v) => (v ?? 0) >= 0.0005;   // what shows as 0.000 kWh (or 0.00 p) is left out of the words
  const W = {};

  // What was read.
  const power = samples.filter((x) => x.node !== 'soc');
  const early = power.filter((x) => x.ts < slot).length;
  const meterReads = ['import', 'export', 'gas'].reduce((n, key) => n + (TS.meter[key] || []).length, 0);
  W.inputs = { title: 'What we read', plain_explanation: [
    power.length ? `We used ${power.length} power readings that the inverter takes every five minutes${early ? ` (${early} of them from just before this ${noun}: each reading counts until the next one)` : ''}.` : `The inverter sent no readings for this ${noun}.`,
    meterReads ? `We also used ${meterReads} reading${meterReads > 1 ? 's' : ''} from the smart meter${meterReads > 1 ? 's' : ''}, the inverter's own totals for ${day} and the prices in force.` : `There is no smart meter reading for it; we also used the inverter's own totals for ${day} and the prices in force.`,
    asOfMs != null ? `Everything is read as it was known at ${new Date(asOfMs).toISOString().slice(11, 16)} UTC on ${dayWords(new Date(asOfMs).toISOString().slice(0, 10))}.` : 'Each figure is the latest version we hold.',
    'Each item in the list says where it came from.',
  ].join(' ') };

  // From power to energy, and the correction factor.
  const nd = TS.nodes;
  if (!T.hasInverter) W.align = { title: 'From power readings to energy', plain_explanation: 'This home sends no inverter readings, so only the smart meter is used.' };
  else {
    const sol = TD.align.solar;
    const others = ['load', 'imp', 'exp', 'chg', 'dis'].filter((x) => Math.abs(TD.align[x].fit - 1) > 1e-9).map((x) => `${NODE_WORDS[x]} x${f(TD.align[x].fit, 3)}`);
    const anyFit = Math.abs(sol.fit - 1) > 1e-9 || others.length;
    const corr = Math.abs(sol.fit - 1) > 1e-9
      ? `Over the whole of ${day} the five-minute readings add up to ${f(sol.integratedDay, 2)} kWh of solar, but the inverter's own daily total says ${f(sol.counter?.value, 1)} kWh. So every solar figure that day is multiplied by ${f(sol.fit, 3)}: we call this the correction factor, and it makes the five-minute readings agree with the inverter's own total.${others.length ? ` The other flows get their own factor (${others.join(', ')}).` : ''}`
      : anyFit ? `Each flow is multiplied by a correction factor so the five-minute readings agree with the inverter's own total for ${day} (${others.join(', ')}); solar already agreed.`
        : TD.date >= TD.today ? `The day is not over yet, so the readings are not yet corrected against the inverter's own daily totals.`
          : `The readings already agree with the inverter's own daily totals for ${day} (or the amounts are too small to compare), so nothing is corrected.`;
    W.align = { title: 'From power readings to energy', plain_explanation: `The inverter reports power every five minutes and each reading counts until the next one. Added up, this ${noun} had ${k(nd.solar.integrated)} of solar, ${k(nd.chg.integrated)} of battery charging and ${k(nd.dis.integrated)} of battery discharging. ${corr} After that: solar ${k(nd.solar.fitted)}, battery charging ${k(nd.chg.fitted)}, battery discharging ${k(nd.dis.fitted)}.` };
  }

  // Which figure is used, and the house's use.
  const clampWord = 'the inverter\'s own sensor on the grid cable (its "clamp")';
  const impText = R.imp == null ? `No grid import was measured for this ${noun} (no meter reading and no inverter readings), so it is marked missing.`
    : R.impSrc === 'meter' ? `The smart meter measured ${k(R.mImp)} bought from the grid this ${noun}; ${clampWord} measured ${k(nd.imp.fitted)}. We use the meter because it is the supplier's official reading.`
      : T.hasImportMeter ? `No smart meter reading covers this ${noun} yet, so we use ${clampWord}: ${k(R.imp)} bought from the grid. The meter's reading replaces it when it arrives.`
        : `This home has no smart meter reading, so grid import is ${clampWord}: ${k(R.imp)}.`;
  const expText = R.exp == null ? '' : nz(R.exp) ? ` ${k(R.exp)} was sent to the grid (${R.expSrc === 'meter' ? 'measured by the export meter' : 'measured by the clamp'}).` : ' Nothing was sent to the grid.';
  const inSum = (R.solar ?? 0) + (R.imp ?? 0) + (R.dis ?? 0);
  const homeText = R.imp == null ? '' : ` Energy in (solar ${f(R.solar)} + grid ${f(R.imp)} + battery ${f(R.dis)} = ${k(inSum)}) minus energy out (export ${f(R.exp)} + battery charging ${f(R.chg)}) leaves ${k(R.balance)}. ${
    R.measuredLoad == null ? 'With no house reading from the inverter, that is what the house used.'
      : R.balance >= R.measuredLoad ? `The inverter measured the house using ${k(R.measuredLoad)}, so that is the house's use; the other ${k(R.loss)} was used or lost by the inverter itself (it needs some power to run).`
        : `That is a little less than the ${k(R.measuredLoad)} the inverter says the house used, so we count the house at ${k(R.home)} (it cannot use more than came in); the ${k(-R.loss)} gap is a small disagreement between the measurements.`}`;
  const gasText = R.gasRaw == null ? '' : !nz(R.gasRaw) && !nz(R.gas) ? ' No gas was used.' : T.gasM3
    ? (R.cv != null ? ` The gas meter read ${f(R.gasRaw)} m3. Gas is billed in kWh: ${f(R.gasRaw)} m3 x 1.02264 (a standard correction for temperature and pressure) x ${f(R.cv, 1)} MJ/m3 (the energy in the gas that day, published by National Gas) / 3.6 = ${k(R.gas)}.` : ` The gas meter read ${f(R.gasRaw)} m3, but National Gas has not yet published the energy in the gas for that day, so it is not turned into kWh yet.`)
    : ` The gas meter read ${k(R.gas)}.`;
  W.reconcile = { title: 'Choosing the right numbers', plain_explanation: `${impText}${expText}${homeText}${gasText}` };

  // Where each kWh went.
  const list = (parts) => parts.filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' and $1');
  const solarSteps = [nz(A.sToHome) ? `first it covers the house (${k(A.sToHome)})` : null, nz(A.sToBatt) ? `${nz(A.sToHome) ? 'then it' : 'it'} charges the battery (${k(A.sToBatt)})` : null,
    nz(A.sToGrid) ? `what is left (${k(A.sToGrid)}) is exported` : null, nz(A.sToLoss) ? `${k(A.sToLoss)} was lost in the inverter` : null].filter(Boolean);
  const solarText = nz(R.solar) ? `Solar made ${k(R.solar)}. ${solarSteps.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : 'There was no solar.';
  const battText = nz(R.dis) ? ` The battery gave ${k(R.dis)}: ${list([nz(A.bToHome) ? `${k(A.bToHome)} to the house` : null, nz(A.bToGrid) ? `${k(A.bToGrid)} exported` : null, nz(A.bToLoss) ? `${k(A.bToLoss)} lost in the inverter` : null]) || 'none of it reached the house'}.` : '';
  const gridText = nz(R.imp) ? ` From the grid came ${k(R.imp)}: ${list([nz(A.gToHome) ? `${k(A.gToHome)} for the house` : null, nz(A.gToBatt) ? `${k(A.gToBatt)} into the battery` : null, nz(A.gToLoss) ? `${k(A.gToLoss)} used by the inverter` : null])}.` : ' Nothing came from the grid.';
  const unmatched = (R.chg ?? 0) - A.sToBatt - A.gToBatt;
  W.allocate = { title: 'Where each kWh went', plain_explanation: `${solarText}${battText}${gridText}${unmatched > 1e-3 ? ` The battery took in ${k(R.chg)}, but only ${k(A.sToBatt + A.gToBatt)} of that is matched by solar or grid in this ${noun}: the measurements disagree slightly.` : ''}` };

  // What it cost.
  const imp = out.price.import;
  if (P.impInc == null) W.price = { title: 'What it cost', plain_explanation: `No import price was found for this ${noun}, so it is not costed.` };
  else {
    const pieces = imp.pieces.filter((x) => x.unit_ex != null);
    const varies = new Set(pieces.map((x) => x.unit_ex)).size > 1;
    const quarterly = pieces.every((x) => x.to - x.from === 900) && pieces.length <= 4;
    const priceText = varies
      ? (quarterly ? `Price: ${list(pieces.map((x, i) => `${m(x.unit_ex)} for the ${ORDINAL[i]}${i ? '' : ' quarter-hour'}`))}, so the ${noun} counts as the average ${m(imp.unit_ex)} before VAT.`
        : `Price: ${list(pieces.map((x) => `${m(x.unit_ex)} from ${hhmm(tz, x.from)} to ${hhmm(tz, x.to)}`))}, so the ${noun} counts as the time-weighted average ${m(imp.unit_ex)} before VAT.`)
      : `The price was ${m(imp.unit_ex)} per kWh before VAT (tariff ${imp.tariff}${imp.register && imp.register !== 'single' ? `, ${imp.register} rate` : ''}).`;
    const levyText = nz(imp.levy) ? ` That includes ${m(imp.levy)} per kWh of energy tax on top of the supplier's ${m(imp.supply_ex)}.` : '';
    const vatText = nz(imp.vat) ? ` With ${pctWords(imp.vat)} VAT you pay ${m(imp.inc)} per kWh.` : ` No VAT applies (0%), so you pay ${m(imp.inc)} per kWh.`;
    const gridKwh = A.gToHome + A.gToBatt + A.gToLoss;
    const gridCost = (C.gToHomeCost ?? 0) + (C.gToBattCost ?? 0) + (C.lossCost ?? 0);
    const buyText = nz(gridKwh) ? ` The ${k(gridKwh)} from the grid${nz(A.gToLoss) ? ' (including what the inverter used)' : ''} cost ${m(gridCost)}.` : '';
    const sd = out.price.standing;
    const perDay = (sd?.per_day_inc ?? 0) + (sd?.gas_per_day_inc ?? 0);
    const standText = !sd ? '' : perDay < 0
      ? ` The daily fixed charges, after the yearly tax credit, come to a credit of ${m(-perDay)} a day, shared over the ${+f(sd.n_slots_day, 0)} ${noun}s of ${day}: a credit of ${m(-C.standing)} for this one.`
      : ` The standing charge${sd.gas_per_day_inc != null ? 's' : ''} of ${m(perDay)} a day ${sd.gas_per_day_inc != null ? `(electricity ${m(sd.per_day_inc)}, gas ${m(sd.gas_per_day_inc)}) are` : 'is'} shared over the ${+f(sd.n_slots_day, 0)} ${noun}s of ${day}: ${m(C.standing)} for this one.`;
    const pg = P.pg;
    const gasText2 = nz(R.gas) && pg?.unitEx != null ? ` Gas: ${k(R.gas)} at ${m(pg.unitEx * (1 + pg.vat))} per kWh (VAT ${pctWords(pg.vat)} included) = ${m(C.gasCost)}.` : '';
    const expKwh = A.sToGrid + A.bToGrid;
    const expText2 = nz(expKwh) ? ` Exporting ${k(expKwh)} earned ${m(C.exportCredit)} (${m(P.expRate)} per kWh).` : '';
    const battCost = nz(A.bToHome) ? (C.bToHomeCost != null
      ? ` The ${k(A.bToHome)} the battery gave the house had cost ${m(C.bToHomeCost)} to store. We treat the battery like a queue: energy that went in first comes out first, each kWh keeping the price it was charged at (solar charging is free).`
      : ' Some of the battery energy the house used was already in the battery when our records start, so its cost is unknown.') : '';
    const totalText = C.totalCost != null ? ` Total for the ${noun}: ${C.totalCost < 0 ? `a credit of ${m(-C.totalCost)}` : m(C.totalCost)}. On grid power alone it would have cost ${m(C.gridOnly)}, so ${rebuilt.saving >= 0 ? `solar and the battery saved ${m(rebuilt.saving)}` : `it cost ${m(-rebuilt.saving)} more than grid power alone would have`}.` : '';
    W.price = { title: 'What it cost', plain_explanation: `${priceText}${levyText}${vatText}${buyText}${standText}${gasText2}${expText2}${battCost}${totalText}` };
  }

  // Status and context.
  const st = TS.state;
  const stateText = st.state === 'missing' ? `This ${noun} is missing: no grid import was measured.`
    : st.state === 'provisional' ? (st.date >= st.today ? `This ${noun} is provisional: the day is not over, so its figures can still change.` : `This ${noun} is provisional: the smart meter reading has not arrived yet (it usually comes about a day later), so the inverter's figures are used for now.`)
      : `This ${noun} is final: ${T.hasImportMeter ? 'the smart meter reading is in and every figure is measured' : 'every figure is measured'}.`;
  const noted = out.quality.bits.filter((b) => b.name !== 'MEASURED');
  const bits = noted.length ? ` Notes: ${noted.map((b) => b.why ?? b.meaning).join('; ')}.` : '';
  const carbon = X.ci != null ? ` The grid's carbon intensity was ${f(X.ci, 0)} g CO2 per kWh, so the ${k(R.imp)} bought carries ${f(X.carbonG, 1)} g CO2.` : '';
  const fc = X.solarForecast != null ? ` Before this ${noun} started we forecast ${k(X.solarForecast)} of solar; the panels made ${k(R.solar)}.` : '';
  const temp = X.temp != null ? ` Outside it was ${f(X.temp, 1)} °C.` : '';
  W.check = { title: 'Checks and status', plain_explanation: `${stateText}${bits}${carbon}${fc}${temp}` };
  return W;
}

// Why a quality bit is set, from the trace's values (words only, no new figures).
function whyBit(name, TS, T, noun) {
  const R = TS.reconcile;
  switch (name) {
    case 'MEASURED': return `the smart meter measured ${f(R.mImp)} kWh`;
    case 'FALLBACK': return R.impSrc === 'clamp' ? `no smart meter reading covers the whole ${noun} yet, so the inverter's clamp figure (${f(R.imp)} kWh) is used` : `the export meter did not cover the whole ${noun}, so the inverter's clamp figure (${f(R.exp)} kWh) is used`;
    case 'PARTIAL': return `the inverter's readings cover ${f(TS.coverage * 100, 0)}% of the ${noun}`;
    case 'SUSPECT': return `${f(-R.balance)} kWh more went out (export and battery charging) than came in`;
    case 'CHECK_FAILED': return `no import price covers this ${noun}`;
    case 'ESTIMATED': return TS.price.priceEstimated ? 'the price for that kind of day was not published yet, so a cautious estimate was used' : 'some battery energy was already stored before our records start, so its cost is unknown';
    case 'RESTATED': return TS.state.prev ? `the saved ${noun} was ${TS.state.prev.state}${(TS.state.prev.quality & QUALITY.RESTATED) ? ' and had already been revised' : ' and its house use or cost has changed since'}` : 'it was revised earlier';
    default: return null;
  }
}

