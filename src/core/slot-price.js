// A slot's price from price runs (Phase T.1 and T.2): the one place where an instant, a slot and the fixed charges of a slot are
// priced. The context is a pricing.js loadPricing result, whose `runs` are made in memory from the rate rows of a past moment (the
// "as known at" path) or read from tariff_price_run (price-run-store.js, a current read). The register rules (windows, the meter's
// own windows, Intelligent Octopus dispatches) and the taxes are pricing.js's; here a unit price, a standing or fixed charge is
// looked up in the runs, and a slot is sampled and its fixed charges shared.
// A supply point is a meter kind ('meter_import', 'meter_export', 'meter_gas') or a device id (a sub-meter with its own tariff).
//
// A slot [start, start + durS) is priced from 15-minute samples (the 15-minute sampling rule): one price when every sample agrees, else the
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

// The price at one instant: { tariffCode, structure, currency, tariffId, deviceId, unitEx, supplyEx, vat, levy, standingEx, fixed,
// tax, register, inputs, estimated }. unitEx is the unit price before percentage taxes (the supplier's price plus per-kWh levies),
// null when no price is known; the price paid is unitEx x (1 + vat).
export function instantPrice(p, point, ts) {
  const a = agreementAt(p, point, ts);
  if (!a) return null;
  const tax = taxesAt(p, a.fuel, a.direction, ts, { inPrice: a.taxes_in_price === 1 });
  const fixed = fixedAtRuns(p, a.tariff_id, ts);
  const base = {
    tariffCode: a.tariff_code, tariffId: a.tariff_id, deviceId: a.device_id, structure: a.structure, currency: a.currency ?? p.currency ?? null,
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
export function slotPrice(p, point, start, durS) {
  const samples = [];
  for (let t = start; t < start + durS; t += SAMPLE) samples.push([t, Math.min(SAMPLE, start + durS - t), instantPrice(p, point, t)]);
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
// price: slotPrice of the slot. The shares of a day's slots add up to the day's charge.
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
