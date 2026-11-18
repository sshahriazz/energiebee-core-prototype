// A slot's price read from price runs (Phase T.1 and T.2): the same numbers pricing.js priceAt / priceOver / fixedOver give from
// rate rows, taken from runs (price-runs.js) instead. The context is a pricing.js loadPricing result with `runs` added, either
// built in memory from the rows it read (withRunsFromRates, the "as known at" path) or read from tariff_price_run
// (price-run-store.js). What differs from the rate-row path is only where a unit price, a standing or fixed charge is looked
// up; the register rules (windows, the meter's own windows, Intelligent Octopus dispatches), the taxes and the sampling are
// pricing.js's own, so a number cannot move because it was read from a run.
//
// A slot [start, start + durS) is priced from 15-minute samples (priceOver's rule): one price when every sample agrees, else the
// time-weighted mean; a sample with no unit price makes the slot's price unknown. Fixed charges are the share of the slot, by
// the slot's part of its local day, month or year (fixedShare).
import { localDate, dayBounds } from './time.js';
import { applyTaxes } from './tax.js';
import { fixedChargePerSlot } from './tariff-expand.js';
import { taxesAt, agreementAt, registerAt, inputsOf, ANY_REGISTER, SAMPLE, periodLengths } from './pricing.js';
import { runAt, coveringRuns, runsOverlapping } from './price-runs.js';

// Fixed charges in force at ts, ex tax: the standing charge per local day, and 'fixed' and 'capacity' runs per day, month or
// year, one entry per register. A capacity run is priced per kW (kVA) of the home's contracted capacity; without one it is left
// out (capacityUnknown), never guessed.
function fixedAtRuns(p, tariffId, ts) {
  const standing = runAt(p, tariffId, 'standing', 'single', ts);
  let day = standing ? standing.price_ex_vat : 0;
  const periods = [];
  const rows = standing ? [standing] : [];
  let capacityUnknown = false;
  for (const component of ['fixed', 'capacity']) {
    const keys = new Set(coveringRuns(p.runs, tariffId, component, ts).map((r) => `${r.register}\u0000${r.charge_period}`));
    for (const k of [...keys].sort()) {
      const [register, period] = k.split('\u0000');
      const run = runAt(p, tariffId, component, register, ts, period);
      if (!run) continue;
      let amount = run.price_ex_vat;
      if (component === 'capacity') {
        if (!(p.capacityKva > 0)) { capacityUnknown = true; continue; }
        amount *= p.capacityKva;
      }
      rows.push(run);
      if (period === 'day') day += amount;
      else periods.push({ register: component === 'capacity' ? `capacity:${register}` : register, period, amount });
    }
  }
  return { day, periods, rows, capacityUnknown };
}

// The price at one instant, in the shape pricing.js priceAt returns (unitEx, supplyEx, vat, levy, standingEx, fixed, tax,
// register, inputs, estimated).
export function priceAtRuns(p, kind, ts) {
  const a = agreementAt(p, kind, ts);
  if (!a) return null;
  const tax = taxesAt(p, a.fuel, a.direction, ts, { inPrice: a.taxes_in_price === 1 });
  const fixed = fixedAtRuns(p, a.tariff_id, ts);
  const base = {
    tariffCode: a.tariff_code, structure: a.structure, currency: a.currency ?? p.currency ?? null,
    standingEx: fixed.day, fixed: fixed.periods, vat: tax.vat, levy: tax.levy, tax,
    ...(fixed.capacityUnknown ? { capacityUnknown: true } : {}),
  };
  let register = registerAt(p, a, ts);
  if (register == null) return { ...base, register: null, unitEx: null, supplyEx: null, inputs: inputsOf(p, a, tax, fixed, null) };
  let unit;
  if (register === ANY_REGISTER) {
    unit = runAt(p, a.tariff_id, 'unit', null, ts);
    register = unit?.register ?? null;
  } else {
    unit = runAt(p, a.tariff_id, 'unit', register, ts);
    if (!unit && register !== 'single') {
      // Intelligent Octopus publishes one time-varying rate list. Inside a smart-charge dispatch the whole home pays the
      // off-peak price: the lowest rate within a day either side.
      unit = runAt(p, a.tariff_id, 'unit', 'single', ts);
      if (unit && a.structure === 'iog' && register === 'night') {
        const offPeak = runsOverlapping(p.runs, a.tariff_id, 'unit', ts - 86400, ts + 86400, 'single')
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

// The price of a whole slot from 15-minute samples (see the head of this file): the first sample's price when all agree
// (marked estimated when another part of the slot was), else the time-weighted mean of the unit prices, weighted: true. Taxes,
// fixed charges and tariff are the first sample's, except where a sample has no price: that sample's price stands for the slot.
export function priceOverRuns(p, kind, start, durS) {
  const samples = [];
  for (let t = start; t < start + durS; t += SAMPLE) samples.push([t, Math.min(SAMPLE, start + durS - t), priceAtRuns(p, kind, t)]);
  const first = samples[0]?.[2] ?? null;
  if (samples.length <= 1) return first;
  if (samples.every(([, , s]) => s == null)) return null;
  const unpriced = samples.find(([, , s]) => s == null || s.unitEx == null);
  if (unpriced) return unpriced[2] ?? { ...(first || samples.find(([, , s]) => s)[2]), register: null, unitEx: null, supplyEx: null };
  if (samples.every(([, , s]) => s.unitEx === first.unitEx)) {
    return samples.some(([, , s]) => s.estimated) && !first.estimated ? { ...first, estimated: true, inputs: samples.flatMap(([, , s]) => s.inputs ?? []) } : first;
  }
  let num = 0; let den = 0; let sup = 0;
  for (const [, w, s] of samples) { num += s.unitEx * w; sup += s.supplyEx * w; den += w; }
  const register = samples.every(([, , s]) => s.register === first.register) ? first.register : 'mixed';
  const inputs = samples.flatMap(([, , s]) => s.inputs ?? []);
  const estimated = samples.some(([, , s]) => s.estimated);
  return { ...first, register, unitEx: num / den, supplyEx: sup / den, weighted: true, inputs, ...(estimated ? { estimated: true } : {}) };
}

// The fixed charges of one slot including tax, in minor units: the daily charge by the slot's share of its local day (46, 48 or
// 50 half-hours, or 92, 96, 100 quarter-hours: the day is cut into slots of this length), monthly and yearly charges and
// capacity by real seconds over the real length of their period (fixedChargePerSlot, which adds up to the period's amount
// exactly), then the home's taxes: one percentage on everything (every GB tariff) is a plain factor, anything else (a
// per-period credit such as the Dutch yearly one) goes through applyTaxes so VAT is charged on it as the rules order it.
// price: priceOverRuns of the slot. The shares of a day's slots add up to the day's charge.
export function fixedShare(price, slot, slotS, tz) {
  if (!price) return 0;
  const [dayStart, dayEnd] = dayBounds(tz, localDate(tz, slot));
  const nSlotsDay = (dayEnd - dayStart) / slotS;
  if (price.tax.simple && !price.fixed.length) return (price.standingEx * (1 + price.vat)) / nSlotsDay;
  let fixedEx = price.standingEx / nSlotsDay;
  for (const f of price.fixed) fixedEx += fixedChargePerSlot(f.amount, f.period, slot, slotS, tz);
  if (!price.tax.rules.length) return fixedEx * (1 + price.vat);
  return applyTaxes(price.tax.rules, { currency: price.currency, fixedEx, slotS, ...periodLengths(price.tax.rules, tz, slot) }).inc.fixed;
}
