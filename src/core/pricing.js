// What a slot costs is worked out in two places that share everything: this file loads the inputs of a home (agreements, taxes,
// the meter's windows, dispatches) and the tariffs' price runs, and has the rules that pick a register and the taxes; slot-price.js
// prices an instant and a whole slot of any length (15, 30 or 60 minutes) from runs, so a slot that spans two prices pays their
// time-weighted mean, and takes the fixed charges as a share of the slot. Agreement in force -> tariff -> run covering the slot
// (home-specific runs win) -> taxes for the home's country, fuel, direction and date. A current read takes the runs from
// tariff_price_run (price-run-store.js); a read "as known at" a past moment makes them in memory from the rate rows of that moment
// (price-runs.js): the same code, two ways to read it. A home's slots are kept in supply_price_slot (supply-price.js).
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
// A tariff with taxes_in_price = 1 (delta 011; tounify) already holds the per-kWh levies and the
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
import { inForce, knownAtMs } from './facts.js';
import { rulesFor, applyTaxes } from './tax.js';
import { fixedChargeMicro, periodBounds } from './tariff-expand.js';
import { tariffFlagsAt } from './versions.js';
import { runsFromRates, indexRuns } from './price-runs.js';
import { currentRuns } from './price-run-store.js';

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
// The result carries `runs` (indexed price runs, see the head of this file). The rate rows themselves (`rates`) are read only
// where they are needed: for a read "as known at" a moment (the runs are made from them) and with rateRows, for a caller that
// shows which row a price came from (explain.js, the explorer).
export async function loadPricing(siteId, fromTs, toTs, siteRow = null, { rateRows = false } = {}) {
  // In meter order, then by start: the order the reads always gave (device scan, then
  // agreement_current), stated so that an index or new planner statistics cannot change it.
  const agreements = await db.prepare(
      `SELECT a.*, d.kind, t.tariff_code, t.fuel, t.direction, t.structure, t.name, t.currency, t.kind AS tariff_kind, t.origin AS tariff_origin, t.taxes_in_price
     FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id
     WHERE a.site_id = ? AND ${inForce('a')} AND a.valid_from < ? AND COALESCE(a.valid_to, 9000000000) > ?
     ORDER BY a.device_id, a.valid_from, a.id`).all(siteId, toTs, fromTs);
  if (knownAtMs() != null) for (const a of agreements) Object.assign(a, await tariffFlagsAt(a.tariff_id, knownAtMs()));
  const tariffIds = [...new Set(agreements.map((a) => a.tariff_id))];
  const asOf = knownAtMs() != null;
  const rates = tariffIds.length && (asOf || rateRows) ? await db.prepare(
      `SELECT * FROM rate_interval WHERE tariff_id IN (${tariffIds.map(() => '?').join(',')})
       AND ${inForce()} AND valid_from < ? AND COALESCE(valid_to, 9000000000) > ?
       AND (site_id IS NULL OR site_id = ?)
     ORDER BY valid_from, ${rateTies()}`).all(...tariffIds, toTs, fromTs - 86400 * 2, siteId) : [];
  const vat = await db.prepare('SELECT * FROM vat_rate').all();
  // Smart-charge dispatches, read from a day earlier so the daily allowance counts from its start.
  // The lower bound on start_ts (the series' longest dispatch, series.max_span_s) leaves no row out;
  // without a recorded span there is no bound.
  const dispatches = await db.prepare(
      `SELECT f.start_ts, f.end_ts FROM interval_fact f JOIN series s ON s.id = f.series_id
     JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
     WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'octopus_kraken' AND m.code = 'ev_charge_kwh'
       AND ${inForce('f')} AND f.end_ts > ? AND f.start_ts < ? AND f.start_ts >= ? - COALESCE(s.max_span_s, 9000000000) ORDER BY f.start_ts`)
      .all(String(siteId), fromTs - 86400, toTs, fromTs - 86400);
  const site = siteRow ?? await db.prepare('SELECT timezone, gsp_region, country, currency, is_demo, contracted_kva, contracted_kva_origin FROM site WHERE id = ?').get(siteId);
  const tz = site?.timezone || 'Europe/London';
  const country = site?.country ?? null;
  const currency = site?.currency ?? null;
  for (const a of agreements) {
    if (a.currency && currency && a.currency !== currency) {
      throw new Error(`tariff ${a.tariff_code} is priced in ${a.currency} but home ${siteId} is billed in ${currency}: amounts in two currencies are never combined (no FX)`);
    }
  }
  // Tax rules of the home's country, as known at the moment being built (versioned like facts).
  const taxRules = country ? await db.prepare(`SELECT * FROM tax_rule WHERE country = ? AND ${inForce()}`).all(country) : [];
  // How the home pays each tariff it is on (delta 080): a source that publishes one price per payment
  // method (Tariffscanner) is priced at the home's own method.
  const payment = new Map(agreements.filter((a) => a.payment_method).map((a) => [a.tariff_id, a.payment_method]));
  // A meter's own day / night switch times (register_window rows with device_id), whatever tariff it is on:
  // they price an Economy 7 tariff, whose supplier hours may differ from the meter's.
  const deviceIds = [...new Set(agreements.map((a) => a.device_id))];
  const meterWindows = new Map();
  if (deviceIds.length) {
    for (const w of await db.prepare(`SELECT * FROM register_window WHERE device_id IN (${deviceIds.map(() => '?').join(',')}) AND calendar IS NULL AND ${inForce()}
        ORDER BY device_id, start_min, id`).all(...deviceIds)) {
      (meterWindows.get(w.device_id) ?? meterWindows.set(w.device_id, []).get(w.device_id)).push(w);
    }
  }
  return {
    agreements, rates, runs: asOf ? indexRuns(runsFromRates(rates)) : await currentRuns(tariffIds, siteId, fromTs, toTs),
    vat, taxRules, country, currency, dispatches, tz, payment, meterWindows,
    capacityKva: site?.contracted_kva ?? null, capacityOrigin: site?.contracted_kva_origin ?? null,
    shapes: new Map(),
    iogWindow: await learnIogWindow(site?.gsp_region, tz), dispatchAllowed: dispatchAllowance(dispatches, tz),
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
export async function learnIogWindow(region, tz) {
  if (!region) return null;
  const rows = await db.prepare(`SELECT r.tariff_id, r.valid_from, r.valid_to, r.price_ex_vat, t.tariff_code FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
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

// The agreement of a supply point at ts: a meter kind ('meter_import'), or a device id (a sub-meter with a tariff of its own).
export function agreementAt(p, point, ts) {
  const is = typeof point === 'number' ? (a) => a.device_id === point : (a) => a.kind === point;
  return p.agreements.find((a) => is(a) && a.valid_from <= ts && (a.valid_to == null || a.valid_to > ts));
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
// - Economy 7: priced only from the meter's own switch times (register_window rows with device_id: the hours
//   the user confirmed). Octopus does not publish them, so without them it is not priced.
// - Intelligent Octopus Go: the off-peak window learned from Octopus's time-stamped IOG
//   prices, plus completed smart-charge dispatches reported by Kraken.
// - windows (HP/HC, Tempo, any day/night with known times): the unit rows were expanded from
//   the tariff's register windows (tariff-expand.js), so the row covering the instant says.
export const ANY_REGISTER = '*';
// The register a meter's own windows put an instant in: the window covering it (its register, e.g.
// 'night'), else 'day' when the meter has windows, else null (not known: the slot stays unpriced).
// weekdays: bit 0 = Monday ... bit 6 = Sunday, read on the day the window starts (tariff-expand.js).
export function meterRegister(p, deviceId, ts) {
  const ws = (p.meterWindows?.get(deviceId) ?? []).filter((w) => (w.valid_from == null || w.valid_from <= ts) && (w.valid_to == null || w.valid_to > ts));
  if (!ws.length) return null;
  for (const w of ws) {
    const zone = w.clock === 'utc' ? 'UTC' : p.tz;
    const { y, m, d, hh, mm } = zonedParts(zone, ts);
    const mins = hh * 60 + mm;
    const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const across = w.end_min <= w.start_min;
    let startDay = null;
    if (!across) { if (mins >= w.start_min && mins < w.end_min) startDay = wd; }
    else if (mins >= w.start_min) startDay = wd;
    else if (mins < w.end_min) startDay = (wd + 6) % 7;
    if (startDay != null && ((w.weekdays ?? 127) >> startDay) & 1) return w.register;
  }
  return 'day';
}
export function registerAt(p, a, ts) {
  if (a.structure === 'windows') return ANY_REGISTER;
  if (a.structure === 'e7') return meterRegister(p, a.device_id, ts);
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
// and for fixed charges one charge period. Home-specific rows win; then the home's own payment method
// (its agreement's), else a row for any method, else rows of every method that agree.
export function rateRow(p, tariffId, component, register, ts, period) {
  const covering = p.rates.filter((r) => r.tariff_id === tariffId && r.component === component && (register == null || r.register === register)
    && (period === undefined || r.charge_period === period)
    && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  if (!covering.length) return null;
  const homeSpecific = covering.filter((r) => r.site_id != null);
  const pool = homeSpecific.length ? homeSpecific : covering;
  // The home's own payment method first (its agreement says it, delta 080), then a row for any method.
  const own = p.payment?.get(tariffId);
  if (own) { const mine = pool.find((r) => r.payment_method === own); if (mine) return mine; }
  const any = pool.find((r) => r.payment_method === 'ANY');
  if (any) return any;
  return pool.every((r) => Math.abs(r.price_ex_vat - pool[0].price_ex_vat) < 1e-9) ? pool[0] : null;
}

// The labelled inputs of one price: tariff, rate rows, tax rules, contracted capacity.
export function inputsOf(p, a, tax, fixed, unit) {
  const out = [{ what: `tariff ${a.tariff_code}`, origin: a.tariff_origin }];
  if (unit) out.push({ what: `rate ${a.tariff_code} unit/${unit.register}`, origin: unit.origin });
  for (const r of fixed.rows) out.push({ what: `rate ${a.tariff_code} ${r.component}/${r.register}${r.charge_period ? `/${r.charge_period}` : ''}`, origin: r.origin });
  if (fixed.rows.some((r) => r.component === 'capacity')) out.push({ what: 'contracted capacity', origin: p.capacityOrigin });
  return out.concat(tax.inputs ?? []);
}

export const SAMPLE = 900;

// Period lengths a per-period tax needs (the local day, month or year holding the slot).
export function periodLengths(rules, tz, ts) {
  const out = {};
  const key = { day: 'dayLengthS', month: 'monthLengthS', year: 'yearLengthS' };
  for (const r of rules) {
    if (r.kind !== 'per_period' || out[key[r.charge_period]]) continue;
    const [a, b] = periodBounds(tz, r.charge_period, ts);
    out[key[r.charge_period]] = b - a;
  }
  return out;
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
