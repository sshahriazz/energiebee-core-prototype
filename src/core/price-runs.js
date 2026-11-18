// Price runs: what a tariff charges, from when to when, ex tax (Phase T.1, docs/thing-model.md section 8). Pure: no
// database, no network, no clock. A caller reads rate rows, windows and calendars (as they are now, or as they stood at a past
// moment) and gets runs back; the same code serves a build "as known at" a past moment (in memory) and the materialised table
// tariff_price_run (src/core/price-run-store.js), so there is one way to do the maths and two ways to read it.
//
// A run is a rate row that has absorbed the rows after it that say the same thing: one row per price change of a tariff,
// register, component and charge period, however the rows were cut (daily rows, half-hourly rows, one per window). Rows keep
// rate_interval's field names (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to,
// price_ex_vat, estimated, origin), so a run reads like the row it came from. Two rows join only when the second starts exactly
// where the first ends and they agree on price, estimated flag and origin: a run never hides that part of its span was a
// cautious default, or labelled otherwise. A home-specific row (site_id) and a row for one payment method stay their own runs:
// which of them a home pays is decided when its price is taken (slot-price.js), as it is for rate rows.
//
// Never guess: a run exists only where a rate row says so. A span with no row has no run, and a slot there has no price.
import { expandWindows } from './tariff-expand.js';

const OPEN = 9000000000;   // an open-ended span, as the exclusion constraints and loadPricing treat valid_to NULL
const LINEAGE_IDS = 20;    // rate row ids kept in a run's lineage (the rest is only counted)

const groupKey = (r) => [r.tariff_id, r.site_id ?? '', r.component, r.register, r.charge_period ?? '', r.payment_method ?? 'ANY'].join('\u0000');
const idOf = (r) => r.rate_ids?.[0] ?? r.id ?? 0;

// Runs of rate rows (rows as stored; the caller has chosen which rows are in force). Sorted by start, then by the first row.
export function runsFromRates(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = groupKey(r);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.valid_from - b.valid_from || (a.id ?? 0) - (b.id ?? 0));
    let cur = null;
    for (const r of g) {
      const est = r.estimated ? 1 : 0;
      const origin = r.origin ?? null;
      if (cur && cur.valid_to != null && cur.valid_to === r.valid_from && cur.price_ex_vat === r.price_ex_vat && cur.estimated === est && cur.origin === origin) {
        cur.valid_to = r.valid_to ?? null;
        cur.rate_ids.push(r.id ?? null);
        continue;
      }
      cur = {
        tariff_id: r.tariff_id, site_id: r.site_id ?? null, component: r.component, register: r.register, charge_period: r.charge_period ?? null,
        payment_method: r.payment_method ?? 'ANY', valid_from: r.valid_from, valid_to: r.valid_to ?? null, price_ex_vat: r.price_ex_vat,
        estimated: est, origin, rate_ids: [r.id ?? null],
      };
      out.push(cur);
    }
  }
  return out.sort((a, b) => a.valid_from - b.valid_from || idOf(a) - idOf(b));
}

// The lineage a run stores: the rows it was made from (the first ones by id, and how many).
export const lineageOf = (run) => ({ rate_ids: run.rate_ids.filter((x) => x != null).slice(0, LINEAGE_IDS), n: run.rate_ids.length });

// Runs from windows and calendars, for a tariff whose registers are not stored as rate rows yet: the register in force at each
// instant (tariff-expand.js expandWindows: meter windows, calendars, clock changes, an unknown day type priced with the
// caller's cautious estimate) joined to the price of that register. registerPrices: { register: price } or
// [{ register, price, validFrom?, validTo? }]. Same shape and same joining as runsFromRates, as component 'unit'.
export function runsFromWindows({ tariffId, siteId = null, origin = null, paymentMethod = 'ANY', ...expand }) {
  const rows = expandWindows(expand).map((x, i) => ({
    id: i + 1, tariff_id: tariffId, site_id: siteId, component: 'unit', register: x.register, charge_period: null, payment_method: paymentMethod,
    valid_from: x.validFrom, valid_to: x.validTo, price_ex_vat: x.price, estimated: x.estimated ? 1 : 0, origin,
  }));
  return runsFromRates(rows);
}

// ───────────── Looking runs up ─────────────

// Runs grouped by tariff and component, each group split by register, charge period, payment method and home scope, and each
// of those sorted by start. A group whose runs do not overlap is searched by bisection; one that does (rows read "as known at"
// a moment can never overlap, but a hand-fed list can) is scanned, so a lookup always finds every run covering the instant.
export function indexRuns(runs) {
  const byTariff = new Map();
  const split = new Map();
  for (const r of runs) {
    const k = groupKey(r);
    (split.get(k) ?? split.set(k, []).get(k)).push(r);
  }
  for (const list of split.values()) {
    list.sort((a, b) => a.valid_from - b.valid_from || idOf(a) - idOf(b));
    let disjoint = true;
    for (let i = 1; i < list.length; i++) if ((list[i - 1].valid_to ?? OPEN) > list[i].valid_from) { disjoint = false; break; }
    const head = list[0];
    const key = `${head.tariff_id}\u0000${head.component}`;
    (byTariff.get(key) ?? byTariff.set(key, []).get(key)).push({ register: head.register, period: head.charge_period, list, disjoint });
  }
  return { byTariff, all: runs };
}

function coveringIn(sub, ts) {
  const { list } = sub;
  if (!sub.disjoint) return list.filter((r) => r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  let lo = 0; let hi = list.length - 1; let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].valid_from <= ts) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at >= 0 && (list[at].valid_to == null || list[at].valid_to > ts) ? [list[at]] : [];
}

// Every run of one tariff and component covering ts, in the order the rate rows were read (start, then first row).
// register null: any register; period undefined: any charge period.
export function coveringRuns(index, tariffId, component, ts, register = null, period = undefined) {
  const out = [];
  for (const sub of index.byTariff.get(`${tariffId}\u0000${component}`) ?? []) {
    if (register != null && sub.register !== register) continue;
    if (period !== undefined && sub.period !== period) continue;
    out.push(...coveringIn(sub, ts));
  }
  return out.length > 1 ? out.sort((a, b) => a.valid_from - b.valid_from || idOf(a) - idOf(b)) : out;
}

// The run covering ts that a home pays, chosen exactly as pricing.js rateRow chooses among rate rows: a home-specific run wins;
// then the home's own payment method (its agreement's), else a run for any method, else runs of every method that agree on
// the price. null when none covers ts or the methods disagree.
export function runAt(p, tariffId, component, register, ts, period) {
  const covering = coveringRuns(p.runs, tariffId, component, ts, register, period);
  if (!covering.length) return null;
  const homeSpecific = covering.filter((r) => r.site_id != null);
  const pool = homeSpecific.length ? homeSpecific : covering;
  const own = p.payment?.get(tariffId);
  if (own) { const mine = pool.find((r) => r.payment_method === own); if (mine) return mine; }
  const any = pool.find((r) => r.payment_method === 'ANY');
  if (any) return any;
  return pool.every((r) => Math.abs(r.price_ex_vat - pool[0].price_ex_vat) < 1e-9) ? pool[0] : null;
}

// The runs of a component that overlap [from, to) whatever their register, period, method or scope, in start order.
export function runsOverlapping(index, tariffId, component, from, to, register = null) {
  const out = [];
  for (const sub of index.byTariff.get(`${tariffId}\u0000${component}`) ?? []) {
    if (register != null && sub.register !== register) continue;
    for (const r of sub.list) if (r.valid_from < to && (r.valid_to == null || r.valid_to > from)) out.push(r);
  }
  return out.sort((a, b) => a.valid_from - b.valid_from || idOf(a) - idOf(b));
}

// A pricing context (pricing.js loadPricing) with its runs: the rate rows it read, as runs, in memory. This is the path of a
// build "as known at" a past moment: loadPricing has read the rows as they stood then.
export const withRunsFromRates = (p) => ({ ...p, runs: indexRuns(runsFromRates(p.rates)) });
