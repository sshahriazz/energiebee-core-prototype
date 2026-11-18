// A tariff as slots, for anyone who is not the home's bill (Phase T.6 and T.7): the comparison and the tariff picker price a candidate
// tariff from slots, and the API shows a tariff's slots and a home's price timeline. Money is always slot energy x slot price, and
// a slot is made by supply-price.js (slotPrice and fixedShare over price runs): a candidate is priced by the same code as the
// home's own tariff, so the two can never disagree.
//   candidatePricing   a pricing context in which a home (or nobody) is on other tariffs for all time: the candidates' runs, the home's
//                      taxes, zone and settings; the home's own agreements stay out of it
//   candidatePricer    the slots of a candidate, in memory (the table holds the home's own tariffs only; a candidate is expanded on
//                      demand from its price runs, which are shared and kept for the tariffs in use)
//   slotMoney          the money of one slot: energy x slot price, and the slot's share of the fixed charges
//   dayPrices          a tariff's supplier prices over a local day in 15-minute slots (the tariff picker's preview)
//   tariffSlots        a tariff's slots over a span, priced for a home or for the tariff's own market (no home)
//   homePriceTimeline  a home's price slots over a span, past and future: the stored ones where there are some, else computed
// A current read takes the runs from tariff_price_run; a read "as known at" a past moment makes them in memory from the rate rows
// of that moment (the same two ways loadPricing reads them).
import { db } from '../db/db.js';
import { knownAtMs, inForce } from './facts.js';
import { currentRuns } from './price-run-store.js';
import { runsFromRates, indexRuns } from './price-runs.js';
import { supplyPricer, supplyPoints } from './supply-price.js';
import { loadPricing, learnIogWindow } from './pricing.js';
import { unitInc } from './slot-price.js';
import { inputsProvenance } from './provenance.js';
import { MARKETS } from '../db/seed/markets.js';
import { SLOT_LENGTHS_S } from './markets.js';
import { daysBetween, slotsOfDay, localDate, slotLength, dayBounds } from './time.js';

const HORIZON_MAX_S = 62 * 86400;   // the longest span one read covers (62 days)

// The supply point a tariff is priced as: the meter kind of its fuel and direction.
export const pointOf = (t) => (t.fuel === 'gas' ? 'meter_gas' : t.direction === 'export' ? 'meter_export' : 'meter_import');

// An agreement that puts a home on a candidate tariff for all time, as loadPricing's agreements look.
export const standIn = (t, deviceId = null) => ({
  kind: pointOf(t), device_id: deviceId, tariff_id: t.id, tariff_code: t.tariff_code, fuel: t.fuel, direction: t.direction, structure: t.structure, name: t.name,
  currency: t.currency, tariff_kind: t.kind, tariff_origin: t.origin, taxes_in_price: t.taxes_in_price ?? 0, valid_from: 0, valid_to: null,
});

// The price runs of some tariffs for a home (or, with no home, the shared ones), over a span with the two days before it that every
// read of rates takes, so a slot sees the same neighbours.
async function runsOf(tariffIds, siteId, from, to) {
  if (!tariffIds.length) return indexRuns([]);
  if (knownAtMs() == null) return await currentRuns(tariffIds, siteId, from, to);
  const rates = await db.prepare(`SELECT * FROM rate_interval WHERE tariff_id IN (${tariffIds.map(() => '?').join(',')}) AND ${inForce()}
    AND valid_from < ? AND COALESCE(valid_to, 9000000000) > ? AND (site_id IS NULL OR site_id = ?) ORDER BY valid_from, id`).all(...tariffIds, to, from - 86400 * 2, siteId);
  return indexRuns(runsFromRates(rates));
}

// `base` is a pricing.js context (a home's, or bareContext's): the candidates replace its agreements and runs. Each candidate is
// { tariff, deviceId? } (deviceId: the home's meter that is on this tariff, so the meter's own windows apply to it).
// `runs` (from candidateRuns) lets several contexts over the same tariffs share one read.
export const candidateRuns = async (tariffs, siteId, from, to) => await runsOf([...new Set(tariffs.map((t) => t.id))], siteId, from, to);
export async function candidatePricing(base, candidates, siteId, from, to, runs = null) {
  return { ...base, agreements: candidates.map((c) => standIn(c.tariff, c.deviceId ?? null)), rates: [], payment: new Map(), runs: runs ?? await candidateRuns(candidates.map((c) => c.tariff), siteId, from, to), shapes: new Map() };
}

// A pricing context with no agreements: the inputs a tariff is priced by when no home's own are involved (no meter windows, no
// dispatches, no contracted capacity: a capacity charge then says capacityUnknown). Taxes are those given (none: ex-tax prices only).
const emptyContext = ({ tz, country, currency, taxRules = [], vat = [] }) => ({
  agreements: [], rates: [], runs: indexRuns([]), vat, taxRules, country, currency, dispatches: [], tz, payment: new Map(), meterWindows: new Map(),
  capacityKva: null, capacityOrigin: null, shapes: new Map(), iogWindow: null, dispatchAllowed: new Set(),
});

// What a tariff is priced by when no home is named: its own market (zone) and the country's taxes.
async function bareContext(tariff) {
  const market = MARKETS.find((m) => m.country === tariff.country);
  if (!market) throw Object.assign(new Error(`tariff ${tariff.tariff_code} has no market with a known zone: name a home (site=)`), { status: 400 });
  return emptyContext({ tz: market.timezone, country: tariff.country, currency: tariff.currency ?? market.currency, vat: await db.prepare('SELECT * FROM vat_rate').all(),
    taxRules: await db.prepare(`SELECT * FROM tax_rule WHERE country = ? AND ${inForce()}`).all(tariff.country) });
}

// The supplier's price per kWh before any tax, in each 15-minute slot of the local day `date` in the home's zone, for a tariff the
// home holds prices for (the tariff picker's preview shows these): the home's own runs and the shared ones, the same slot code as
// every other price. A slot with no price is { supply_ex: null }.
export async function dayPrices(site, tariff, date) {
  const tz = site.timezone || 'Europe/London';
  const [a, b] = dayBounds(tz, date);
  const pricing = await candidatePricing(emptyContext({ tz, country: site.country ?? null, currency: tariff.currency ?? site.currency ?? null }), [{ tariff }], site.id, a, b);
  const pricer = await candidatePricer({ siteId: site.id, pricing, slotS: 900, tz });
  const point = pointOf(tariff);
  return slotsOfDay(tz, date, 900).map((s) => ({ slot_start: s, supply_ex: pricer.get(point, s).price?.supplyEx ?? null }));
}

// The priced slots of candidates in memory: get(key, slot) gives { price, fixedInc } as supplyPricer does for the home's own
// tariffs. Candidates are keyed by their point, so a context holds at most one import, one export and one gas tariff.
export async function candidatePricer({ siteId, pricing, slotS, tz }) {
  return await supplyPricer({ siteId, p: pricing, slotS, tz, materialise: false });
}

// The money of one slot: the energy times the slot's prices. imp and exp in kWh; the slots are what pricer.get returns for the
// import and the export point (null price: no agreement or no price; the caller decides what that means). The export credit
// is paid per kWh at the export price including tax; fixed is the import slot's share of the fixed charges.
export function slotMoney(imp, exp, importSlot, exportSlot) {
  const ip = unitInc(importSlot?.price); const ep = unitInc(exportSlot?.price);
  return { importCost: ip == null ? null : imp * ip, exportCredit: ep == null ? null : exp * ep, fixed: importSlot?.price ? importSlot.fixedInc : 0 };
}

// A slot as the API shows it: the columns of supply_price_slot, with the weakest origin of its inputs.
export function slotView(slot, slotS, price, fixedInc) {
  const known = price?.unitEx != null;
  return {
    slot_start: slot, dur_s: slotS, tariff: price?.tariffCode ?? null, register: price?.register ?? null,
    unit_ex: price?.unitEx ?? null, supply_ex: price?.supplyEx ?? null, vat: price?.vat ?? null, levy: price?.levy ?? null, unit_inc: known ? unitInc(price) : null,
    fixed_inc: price ? fixedInc : 0, known, weighted: !!price?.weighted, estimated: !!price?.estimated, capacity_unknown: !!price?.capacityUnknown,
    tax_source: price?.tax?.source ?? null, tax_unverified: !!price?.tax?.unverified, origin: price ? inputsProvenance(price.inputs ?? [])?.origin ?? null : null,
  };
}

// The slot starts in [from, to) on a zone's grid at slotS (a day's own number of slots, 46 or 50 at 30 minutes on a clock change).
export function slotStarts(tz, from, to, slotS) {
  return daysBetween(localDate(tz, from), localDate(tz, to - 1)).flatMap((d) => slotsOfDay(tz, d, slotS)).filter((t) => t >= from && t < to);
}

function checkSpan(from, to, slotS) {
  if (!SLOT_LENGTHS_S.includes(slotS)) throw Object.assign(new RangeError(`slot_s must be one of ${SLOT_LENGTHS_S.join(', ')}`), { status: 400 });
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw Object.assign(new RangeError('from must be before to'), { status: 400 });
  if (to - from > HORIZON_MAX_S) throw Object.assign(new RangeError(`a read covers at most ${HORIZON_MAX_S / 86400} days`), { status: 400 });
}

// What the slots of a view say about the span: how many have a price, and how far the prices reach.
function summary(slots) {
  const known = slots.filter((s) => s.known);
  return { slots: slots.length, known: known.length, unknown: slots.length - known.length, priced_until: known.length ? known.at(-1).slot_start + known.at(-1).dur_s : null };
}

// A tariff's slots over [from, to) at slotS. With a home (a site row the caller may see): the home's zone and taxes, its contracted
// capacity, the home's own rows of the tariff, and the meter windows of the meter that is on this tariff. Without one: the tariff's
// market, the country's taxes and the shared runs. Never a guess: a slot with no price is known: false.
export async function tariffSlots(tariff, { site = null, from, to, slotS = 1800 }) {
  checkSpan(from, to, slotS);
  const point = pointOf(tariff);
  let base; let siteId = null; let deviceId = null; let tz;
  if (site) {
    if (site.currency && tariff.currency && site.currency !== tariff.currency) {
      throw Object.assign(new RangeError(`tariff ${tariff.tariff_code} is priced in ${tariff.currency} but home ${site.id} is billed in ${site.currency}: amounts in two currencies are never combined (no FX)`), { status: 400 });
    }
    base = await loadPricing(site.id, from, to, site); siteId = site.id; tz = site.timezone || 'Europe/London';
    deviceId = base.agreements.find((a) => a.tariff_id === tariff.id)?.device_id ?? null;
  } else {
    base = await bareContext(tariff); tz = base.tz;
  }
  const pricing = await candidatePricing(base, [{ tariff, deviceId }], siteId, from, to);
  const pricer = await candidatePricer({ siteId, pricing, slotS, tz });
  const out = slotStarts(tz, from, to, slotS).map((s) => { const { price, fixedInc } = pricer.get(point, s); return slotView(s, slotS, price, fixedInc); });
  return { tariff: tariff.tariff_code, tariff_id: tariff.id, point, currency: tariff.currency ?? base.currency, country: tariff.country, tz, slot_s: slotS, from, to, priced_for: site ? { site: site.id } : { market: tariff.country }, ...summary(out), slots: out };
}

// A home's price timeline over [from, to): for each supply point the home has an agreement on in the span, the slots at the
// home's own length: the stored ones where the table has them (made by the build or by extending the timeline), the rest computed
// in memory by the same code, none stored (a read changes nothing). A point with no agreement at a slot has a slot with no
// tariff. `from` and `to` may lie in the future: a price known ahead (an open-ended rate, a published Agile day) is a slot with a price.
export async function homePriceTimeline(site, { from, to, points = null }) {
  const slotS = slotLength(site);
  checkSpan(from, to, slotS);
  const tz = site.timezone || 'Europe/London';
  const p = await loadPricing(site.id, from, to, site);
  const pricer = await supplyPricer({ siteId: site.id, p, slotS, tz, materialise: true, persist: false });
  const wanted = points ? pricer.points.filter((k) => points.includes(k)) : pricer.points;
  const slots = slotStarts(tz, from, to, slotS);
  await pricer.load(slots, wanted);
  const subs = new Map(supplyPoints(p).map((pt) => [pt.key, pt]));
  const out = wanted.map((key) => {
    const view = slots.map((s) => { const { price, fixedInc } = pricer.get(key, s); return slotView(s, slotS, price, fixedInc); });
    return { point: key, kind: subs.get(key).kind, device_id: subs.get(key).deviceId, ...summary(view), slots: view };
  });
  return { site: site.id, currency: site.currency ?? 'GBP', tz, slot_s: slotS, from, to, stored: pricer.stats.read, computed: pricer.stats.made, points: out };
}
