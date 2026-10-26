// Resolves the price of any slot: agreement in force -> tariff -> rate row
// covering the slot (home-specific rows win) -> taxes for the home's country, fuel, direction and date.
// priceAt prices an instant; priceOver prices a whole slot of any length (15, 30 or 60
// minutes) from 15-minute samples, so a slot that spans two prices pays their time-weighted mean.
//
// Money is in MINOR units of the home's currency (site.currency: pence, cents). A tariff priced in
// another currency is refused (no FX): the database triggers stop the agreement, and loadPricing
// checks again so an older row can never be mixed in.
//
// Taxes come from tax_rule (src/core/tax.js applyTaxes order: per-kWh levies, then percentages on
// price plus every lower-seq tax; per-period amounts pro-rated by slot). Every unit tax is linear
// in the price, so a slot's unit price including tax is always (unitEx) x (1 + vat), where
//   unitEx = the supplier's price + per-kWh levies (supplyEx + levy), before percentage taxes
//   vat    = the percentage taxes on it (compounded when they sit at different seq)
// This keeps the stored pair import_rate_ex / import_vat meaning "rate x (1 + vat) = price paid".
// GB has one rule per fuel and direction (VAT, copied from vat_rate with the same rates and dates),
// so for GB vat is exactly the vat_rate figure and levy is 0: the numbers do not move. Without any
// rule for a GB home, vat_rate is read as before.
//
// A tariff with taxes_in_price = 1 (delta 011; tounify v3) already holds the per-kWh levies and the
// per-period credits in its own prices and fixed charges: only the PERCENT rules (VAT) are applied
// on top, and the country's per_kwh and per_period rules are left out, so nothing is counted twice.
// Every other tariff (taxes_in_price 0, the default) is taxed exactly as before.
//
// Capacity charges (component 'capacity', delta 007) are priced per kW (kVA) of the home's
// contracted capacity (site.contracted_kva) per charge period, spread over slots like any other
// fixed charge. Without a contracted capacity they are left out and the price says capacityUnknown.
//
// Provenance: every price lists its `inputs` ({ what, origin }: the tariff, each rate row, each
// tax rule, the contracted capacity) so the build can record the weakest origin of a slot
// (src/core/provenance.js). A rate row stored as estimated (a Tempo colour not published yet,
// priced with a cautious default) makes the price estimated: true.
import { db } from '../db/db.js';
import { zonedParts, localDate, addDays, floorTo, dayBounds } from './time.js';
import { inForce, spanColumn, knownAtMs } from './facts.js';
import { rulesFor, applyTaxes } from './tax.js';
import { fixedChargePerSlot, fixedChargeMicro, periodBounds } from './tariff-expand.js';
import { tariffFlagsAt } from './versions.js';

// The account API does not say how the customer pays, so a price is only used when
// it does not depend on it: a row for any payment method, or rows that all agree.

// Rate rows that start at the same moment, in the order the reads have always returned them: for
// current rows the rate_current index order (tariff, component, register, id), "as known at" the
// table order (id). Stated, so that an index or new planner statistics cannot reorder them. Every
// price picks among the rows of one tariff, component and register, where both orders are by id,
// so the two orders give the same prices; keeping each one keeps the returned lists identical too.
const rateTies = (a = '') => (knownAtMs() == null ? `${a}tariff_id, ${a}component, ${a}register, ${a}id` : `${a}id`);

// siteRow: the home as the caller reads it (build.js passes it as known at its asOf, H5); null reads
// today's row. Inside withKnownAt, each tariff's pricing columns are read as known then (tariff_version).
export function loadPricing(siteId, fromTs, toTs, siteRow = null) {
  // In meter order, then by start: the order the reads always gave (device scan, then
  // agreement_current), stated so that an index or new planner statistics cannot change it.
  const agreements = db.prepare(
    `SELECT a.*, d.kind, t.tariff_code, t.fuel, t.direction, t.structure, t.name, t.currency, t.kind AS tariff_kind, t.origin AS tariff_origin, t.taxes_in_price
     FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id
     WHERE a.site_id = ? AND ${inForce('a')} AND a.valid_from < ? AND IFNULL(a.valid_to, 9000000000) > ?
     ORDER BY a.device_id, a.valid_from, a.id`).all(siteId, toTs, fromTs);
  if (knownAtMs() != null) for (const a of agreements) Object.assign(a, tariffFlagsAt(a.tariff_id, knownAtMs()));
  const tariffIds = [...new Set(agreements.map((a) => a.tariff_id))];
  const rates = tariffIds.length ? db.prepare(
    `SELECT * FROM rate_interval WHERE tariff_id IN (${tariffIds.map(() => '?').join(',')})
       AND ${inForce()} AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?
       AND (site_id IS NULL OR site_id = ?)
     ORDER BY valid_from, ${rateTies()}`).all(...tariffIds, toTs, fromTs - 86400 * 2, siteId) : [];
  const vat = db.prepare('SELECT * FROM vat_rate').all();
  // Smart-charge dispatches, read from a day earlier so the daily allowance counts from its start.
  // The lower bound on start_ts (the series' longest dispatch, series.max_span_s) leaves no row out;
  // without a recorded span there is no bound.
  const dispatches = db.prepare(
    `SELECT f.start_ts, f.end_ts FROM interval_fact f JOIN series s ON s.id = f.series_id
     JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
     WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'octopus_kraken' AND m.code = 'ev_charge_kwh'
       AND ${inForce('f')} AND f.end_ts > ? AND f.start_ts < ?${spanColumn() ? ' AND f.start_ts >= ? - IFNULL(s.max_span_s, 9000000000)' : ''} ORDER BY f.start_ts`)
    .all(String(siteId), fromTs - 86400, toTs, ...(spanColumn() ? [fromTs - 86400] : []));
  const site = siteRow ?? db.prepare('SELECT timezone, gsp_region, country, currency, is_demo, contracted_kva, contracted_kva_origin FROM site WHERE id = ?').get(siteId);
  const tz = site?.timezone || 'Europe/London';
  const country = site?.country ?? null;
  const currency = site?.currency ?? null;
  for (const a of agreements) {
    if (a.currency && currency && a.currency !== currency) {
      throw new Error(`tariff ${a.tariff_code} is priced in ${a.currency} but home ${siteId} is billed in ${currency}: amounts in two currencies are never combined (no FX)`);
    }
  }
  // Tax rules of the home's country, as known at the moment being built (versioned like facts).
  const taxRules = country ? db.prepare(`SELECT * FROM tax_rule WHERE country = ? AND ${inForce()}`).all(country) : [];
  return {
    agreements, rates, vat, taxRules, country, currency, dispatches, tz,
    hasFixed: rates.some((r) => r.component === 'fixed' || r.component === 'capacity'),
    capacityKva: site?.contracted_kva ?? null, capacityOrigin: site?.contracted_kva_origin ?? null,
    shapes: new Map(),
    iogWindow: learnIogWindow(site?.gsp_region, tz), dispatchAllowed: dispatchAllowance(dispatches, tz),
  };
}

// Octopus: "Your car gets up to 6 hours of off-peak charging per day (measured midday to
// midday). If we schedule your car to charge outside of the 23:30–05:30 window, your home
// also gets the off-peak rate for that half-hour when it's within your car allowance."
// (octopus.energy/blog/intelligent-octopus-go-charge-limit, 7 May 2026). So the first
// 12 dispatched half-hours of each midday-to-midday period are discounted.
// The allowance is counted in Octopus's own half-hours (on the 1800 s grid, whatever the
// home's slot length) and looked up by the half-hour holding an instant (registerAt).
const ALLOWANCE_HALF_HOURS = 12;
const HALF_HOUR = 1800;
export function dispatchAllowance(dispatches, tz) {
  const allowed = new Set();
  const used = new Map();
  for (const d of dispatches) {
    for (let t = floorTo(d.start_ts, HALF_HOUR); t < d.end_ts; t += HALF_HOUR) {
      if (allowed.has(t)) continue;
      // Allowance period: local midday to the next local midday.
      const { hh } = zonedParts(tz, t);
      const period = hh >= 12 ? localDate(tz, t) : addDays(localDate(tz, t), -1);
      const n = used.get(period) || 0;
      if (n >= ALLOWANCE_HALF_HOURS) continue;
      used.set(period, n + 1);
      allowed.add(t);
    }
  }
  return allowed;
}

// Intelligent Octopus Go tariffs that publish day/night prices give no times. Octopus's
// time-stamped IOG price lists for the same region do: the cheaper rows mark the off-peak
// window (local time). It is read from those rows, never assumed.
export function learnIogWindow(region, tz) {
  if (!region) return null;
  const rows = db.prepare(`SELECT r.tariff_id, r.valid_from, r.valid_to, r.price_ex_vat, t.tariff_code FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
    WHERE t.structure = 'iog' AND t.region = ? AND r.component = 'unit' AND r.register = 'single'
      AND ${inForce('r')} AND r.valid_to IS NOT NULL ORDER BY r.valid_from DESC, ${rateTies('r.')} LIMIT 500`).all(region);
  if (!rows.length) return null;
  const minByTariff = new Map();
  for (const r of rows) minByTariff.set(r.tariff_id, Math.min(minByTariff.get(r.tariff_id) ?? Infinity, r.price_ex_vat));
  const counts = new Map();
  for (const r of rows) {
    if (r.price_ex_vat !== minByTariff.get(r.tariff_id)) continue;
    const a = zonedParts(tz, r.valid_from); const b = zonedParts(tz, r.valid_to);
    const key = `${a.hh * 60 + a.mm}-${b.hh * 60 + b.mm}`;
    const c = counts.get(key) || { n: 0, code: r.tariff_code };
    c.n++; counts.set(key, c);
  }
  const [key, best] = [...counts.entries()].sort((x, y) => y[1].n - x[1].n)[0] || [];
  if (!key) return null;
  const [start, end] = key.split('-').map(Number);
  return { start, end, source: best.code, rows: best.n };
}

function agreementAt(p, kind, ts) {
  return p.agreements.find((a) => a.kind === kind && a.valid_from <= ts && (a.valid_to == null || a.valid_to > ts));
}

// The dated GB VAT table (vat_rate). Still the fallback for a GB home with no tax rule.
export function vatAt(p, fuel, direction, ts) {
  const v = p.vat.find((r) => r.fuel === fuel && r.direction === direction && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  return v ? v.rate : 0;
}

// The unit taxes of a set of rules as (levy, vat): price paid per kWh = (u + levy) x (1 + vat)
// for every supplier price u, the same as applyTaxes gives (it is linear in u). One group of
// percentages keeps its rate exactly as stored; several are compounded. `simple` = every rule
// is one percentage on unit and fixed charges alike (GB VAT), so fixed charges take vat too.
function taxShape(rules, currency) {
  const onUnit = rules.filter((r) => r.applies_to !== 'fixed');
  const pct = new Map();
  for (const r of onUnit) if (r.kind === 'percent') pct.set(r.seq, (pct.get(r.seq) ?? 0) + r.value);
  const groups = [...pct.values()];
  const vat = groups.length <= 1 ? (groups[0] ?? 0) : groups.reduce((m, v) => m * (1 + v), 1) - 1;
  const levy = onUnit.some((r) => r.kind === 'per_kwh') ? applyTaxes(onUnit, { currency, unitEx: 0, kwh: 1 }).inc.unit / (1 + vat) : 0;
  return {
    vat, levy,
    simple: groups.length <= 1 && rules.every((r) => r.kind === 'percent' && r.applies_to === 'all'),
    unverified: rules.some((r) => r.unverified === 1 || r.unverified === true),
    inputs: rules.map((r) => ({ what: `tax_rule ${r.country}/${r.code}`, origin: r.origin })),
  };
}

// The registry's GB VAT table (vat_rate), when no tax_rule applies: sourced, as VAT_RATES is.
const VAT_RATE_INPUTS = Object.freeze([Object.freeze({ what: 'vat_rate GB', origin: 'sourced' })]);

// Taxes on one fuel and direction at an instant: from tax_rule for the home's country; for a GB
// home (or one with no country) with no rule, from vat_rate as before; otherwise none.
// inPrice (the tariff's taxes_in_price): the levies are already in the price, so only the percent
// rules (VAT) are kept.
export function taxesAt(p, fuel, direction, ts, { inPrice = false } = {}) {
  let rules = p.taxRules?.length ? rulesFor(p.taxRules, { country: p.country, fuel, direction, ts }) : [];
  if (inPrice) rules = rules.filter((r) => r.kind === 'percent');
  if (rules.length) {
    const key = rules.map((r) => r.id ?? `${r.code}/${r.valid_from}`).join(',');
    let shape = p.shapes?.get(key);
    if (!shape) { shape = taxShape(rules, p.currency); p.shapes?.set(key, shape); }
    return { source: 'tax_rule', rules, ...shape };
  }
  if (p.country == null || p.country === 'GB') return { source: 'vat_rate', rules: [], vat: vatAt(p, fuel, direction, ts), levy: 0, simple: true, unverified: false, inputs: VAT_RATE_INPUTS };
  // No rule for this country: taxes are taken as zero, which is an assumption, not a fact.
  return { source: 'none', rules: [], vat: 0, levy: 0, simple: true, unverified: false, inputs: [{ what: `no tax rule for ${p.country} (taxes taken as 0)`, origin: 'placeholder' }] };
}

// Which register applies. Returns null when no source says, so the half-hour stays unpriced
// (and fails the rate-coverage check) rather than being priced on a guess.
// - Economy 7: Octopus does not publish each meter's switch times, so it is not priced.
// - Intelligent Octopus Go: the off-peak window learned from Octopus's time-stamped IOG
//   prices, plus completed smart-charge dispatches reported by Kraken.
// - windows (HP/HC, Tempo, any day/night with known times): the unit rows were expanded from
//   the tariff's register windows (tariff-expand.js), so the row covering the instant says.
const ANY_REGISTER = '*';
function registerAt(p, a, ts) {
  if (a.structure === 'windows') return ANY_REGISTER;
  if (a.structure === 'e7') return null;
  if (a.structure === 'iog') {
    if (p.dispatchAllowed.has(floorTo(ts, HALF_HOUR))) return 'night';
    if (!p.iogWindow) return null;
    const { hh, mm } = zonedParts(p.tz, ts);
    const mins = hh * 60 + mm;
    const { start, end } = p.iogWindow;
    const offPeak = start > end ? mins >= start || mins < end : mins >= start && mins < end;
    return offPeak ? 'night' : 'day';
  }
  return 'single';
}

// The row covering ts for one tariff, component and register (null register: any register),
// and for fixed charges one charge period. Home-specific rows win; payment methods must agree.
export function rateRow(p, tariffId, component, register, ts, period) {
  const covering = p.rates.filter((r) => r.tariff_id === tariffId && r.component === component && (register == null || r.register === register)
    && (period === undefined || r.charge_period === period)
    && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  if (!covering.length) return null;
  const homeSpecific = covering.filter((r) => r.site_id != null);
  const pool = homeSpecific.length ? homeSpecific : covering;
  const any = pool.find((r) => r.payment_method === 'ANY');
  if (any) return any;
  return pool.every((r) => Math.abs(r.price_ex_vat - pool[0].price_ex_vat) < 1e-9) ? pool[0] : null;
}

// Fixed charges in force at ts, ex tax: per local day (the GB standing charge, or 'fixed' rows
// with charge_period day), and per month or year (a subscription), one entry per register.
// Capacity rows: price per kW (kVA) per period x the home's contracted capacity; without a
// contracted capacity they are not priced (capacityUnknown). rows: the rate rows used.
function fixedAt(p, tariffId, ts) {
  const standing = rateRow(p, tariffId, 'standing', 'single', ts);
  let day = standing ? standing.price_ex_vat : 0;
  const periods = [];
  const rows = standing ? [standing] : [];
  let capacityUnknown = false;
  if (!p.hasFixed) return { day, periods, rows, capacityUnknown };
  for (const component of ['fixed', 'capacity']) {
    const keys = new Set(p.rates.filter((r) => r.tariff_id === tariffId && r.component === component && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts))
      .map((r) => `${r.register}\u0000${r.charge_period}`));
    for (const k of [...keys].sort()) {
      const [register, period] = k.split('\u0000');
      const row = rateRow(p, tariffId, component, register, ts, period);
      if (!row) continue;
      let amount = row.price_ex_vat;
      if (component === 'capacity') {
        if (!(p.capacityKva > 0)) { capacityUnknown = true; continue; }
        amount *= p.capacityKva;
      }
      rows.push(row);
      if (period === 'day') day += amount;
      else periods.push({ register: component === 'capacity' ? `capacity:${register}` : register, period, amount });
    }
  }
  return { day, periods, rows, capacityUnknown };
}

// The labelled inputs of one price: tariff, rate rows, tax rules, contracted capacity.
function inputsOf(p, a, tax, fixed, unit) {
  const out = [{ what: `tariff ${a.tariff_code}`, origin: a.tariff_origin }];
  if (unit) out.push({ what: `rate ${a.tariff_code} unit/${unit.register}`, origin: unit.origin });
  for (const r of fixed.rows) out.push({ what: `rate ${a.tariff_code} ${r.component}/${r.register}${r.charge_period ? `/${r.charge_period}` : ''}`, origin: r.origin });
  if (fixed.rows.some((r) => r.component === 'capacity')) out.push({ what: 'contracted capacity', origin: p.capacityOrigin });
  return out.concat(tax.inputs ?? []);
}

// Price of a slot for one meter kind:
//   unitEx      unit price before percentage taxes (supplier price + per-kWh levies), minor/kWh
//   supplyEx    the supplier's own unit price, ex every tax
//   vat         percentage taxes on unitEx: price paid = unitEx x (1 + vat)
//   standingEx  fixed charge per local day, ex tax; fixed: per month / year charges, ex tax
//   tax         where the taxes came from (tax_rule | vat_rate | none) and the rules
export function priceAt(p, kind, ts) {
  const a = agreementAt(p, kind, ts);
  if (!a) return null;
  const tax = taxesAt(p, a.fuel, a.direction, ts, { inPrice: a.taxes_in_price === 1 });
  const fixed = fixedAt(p, a.tariff_id, ts);
  const base = {
    tariffCode: a.tariff_code, structure: a.structure, currency: a.currency ?? p.currency ?? null,
    standingEx: fixed.day, fixed: fixed.periods, vat: tax.vat, levy: tax.levy, tax,
    ...(fixed.capacityUnknown ? { capacityUnknown: true } : {}),
  };
  let register = registerAt(p, a, ts);
  if (register == null) return { ...base, register: null, unitEx: null, supplyEx: null, inputs: inputsOf(p, a, tax, fixed, null) };
  let unit;
  if (register === ANY_REGISTER) {
    unit = rateRow(p, a.tariff_id, 'unit', null, ts);
    register = unit?.register ?? null;
  } else {
    unit = rateRow(p, a.tariff_id, 'unit', register, ts);
    if (!unit && register !== 'single') {
      // Intelligent Octopus publishes one time-varying rate list. Inside a smart-charge
      // dispatch the whole home pays the off-peak price: the lowest rate within a day.
      unit = rateRow(p, a.tariff_id, 'unit', 'single', ts);
      if (unit && a.structure === 'iog' && register === 'night') {
        const offPeak = p.rates.filter((r) => r.tariff_id === a.tariff_id && r.component === 'unit' && r.register === 'single'
          && r.valid_from < ts + 86400 && (r.valid_to == null || r.valid_to > ts - 86400))
          .reduce((m, r) => (!m || r.price_ex_vat < m.price_ex_vat ? r : m), null);
        if (offPeak && offPeak.price_ex_vat < unit.price_ex_vat) unit = offPeak;
      }
    }
  }
  const supplyEx = unit ? unit.price_ex_vat : null;
  return {
    ...base, register, supplyEx, unitEx: supplyEx == null ? null : (tax.levy ? supplyEx + tax.levy : supplyEx),
    inputs: inputsOf(p, a, tax, fixed, unit), ...(unit?.estimated === 1 ? { estimated: true } : {}),
  };
}

// Price of a whole slot [start, start + durS): priceAt sampled every 15 minutes. When every
// sample has the same unit price the first sample is returned unchanged (always the case for a
// half-hour slot on GB half-hourly prices). If any sample has no unit price the slot has none
// (unitEx null), as one unpriced moment means the slot's cost is not known. Otherwise the unit
// price is the time-weighted mean of the samples, marked weighted: true; taxes, fixed charges
// and tariff are the first sample's.
const SAMPLE = 900;
export function priceOver(p, kind, start, durS) {
  const samples = [];
  for (let t = start; t < start + durS; t += SAMPLE) samples.push([t, Math.min(SAMPLE, start + durS - t), priceAt(p, kind, t)]);
  const first = samples[0]?.[2] ?? null;
  if (samples.length <= 1) return first;
  if (samples.every(([, , s]) => s == null)) return null;
  const unpriced = samples.find(([, , s]) => s == null || s.unitEx == null);
  if (unpriced) return unpriced[2] ?? { ...(first || samples.find(([, , s]) => s)[2]), register: null, unitEx: null, supplyEx: null };
  if (samples.every(([, , s]) => s.unitEx === first.unitEx)) {
    // Same price throughout: the first sample, unless another part of the slot was estimated.
    return samples.some(([, , s]) => s.estimated) && !first.estimated ? { ...first, estimated: true, inputs: samples.flatMap(([, , s]) => s.inputs ?? []) } : first;
  }
  let num = 0; let den = 0; let sup = 0;
  for (const [, w, s] of samples) { num += s.unitEx * w; sup += s.supplyEx * w; den += w; }
  const register = samples.every(([, , s]) => s.register === first.register) ? first.register : 'mixed';
  // Every sample's inputs count: a slot that spans an estimated or placeholder price says so.
  const inputs = samples.flatMap(([, , s]) => s.inputs ?? []);
  const estimated = samples.some(([, , s]) => s.estimated);
  return { ...first, register, unitEx: num / den, supplyEx: sup / den, weighted: true, inputs, ...(estimated ? { estimated: true } : {}) };
}

// Period lengths a per-period tax needs (the local day, month or year holding the slot).
function periodLengths(rules, tz, ts) {
  const out = {};
  const key = { day: 'dayLengthS', month: 'monthLengthS', year: 'yearLengthS' };
  for (const r of rules) {
    if (r.kind !== 'per_period' || out[key[r.charge_period]]) continue;
    const [a, b] = periodBounds(tz, r.charge_period, ts);
    out[key[r.charge_period]] = b - a;
  }
  return out;
}

// Fixed charges of one slot including tax, in minor units: the daily charge by the slot's share
// of its local day (nSlotsDay slots: 46, 48 or 50 half-hours), monthly and yearly charges by real
// seconds (fixedChargePerSlot), and per-period taxes (a yearly credit) through applyTaxes, so VAT
// is charged on the credit as the rules order it. With only a daily charge and one VAT rate on
// everything (every GB tariff), this is the arithmetic the build always used.
export function fixedOver(p, slot, slotS, nSlotsDay, tz) {
  if (!p) return 0;
  if (p.tax.simple && !p.fixed.length) return (p.standingEx * (1 + p.vat)) / nSlotsDay;
  let fixedEx = p.standingEx / nSlotsDay;
  for (const f of p.fixed) fixedEx += fixedChargePerSlot(f.amount, f.period, slot, slotS, tz);
  if (!p.tax.rules.length) return fixedEx * (1 + p.vat);
  return applyTaxes(p.tax.rules, { currency: p.currency, fixedEx, slotS, ...periodLengths(p.tax.rules, tz, slot) }).inc.fixed;
}

// The same over the whole local day holding ts (for "standing charge per day" in the API).
export function fixedPerDay(p, ts, tz) {
  if (!p) return null;
  if (p.tax.simple && !p.fixed.length) return p.standingEx * (1 + p.vat);
  const [a, b] = dayBounds(tz, localDate(tz, ts));
  let fixedEx = p.standingEx;
  for (const f of p.fixed) fixedEx += fixedChargeMicro(f.amount, f.period, a, b, tz) / 1e6;
  if (!p.tax.rules.length) return fixedEx * (1 + p.vat);
  return applyTaxes(p.tax.rules, { currency: p.currency, fixedEx, slotS: b - a, ...periodLengths(p.tax.rules, tz, a) }).inc.fixed;
}
