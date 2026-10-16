// Resolves the price of any half-hour: agreement in force -> tariff -> rate row
// covering the slot (home-specific rows win) -> VAT for the fuel, direction and date.
import { db } from '../db/db.js';
import { zonedParts, localDate, addDays } from './time.js';

// The account API does not say how the customer pays, so a price is only used when
// it does not depend on it: a row for any payment method, or rows that all agree.

export function loadPricing(siteId, fromTs, toTs) {
  const agreements = db.prepare(
    `SELECT a.*, d.kind, t.tariff_code, t.fuel, t.direction, t.structure, t.name
     FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id
     WHERE a.site_id = ? AND a.valid_from < ? AND IFNULL(a.valid_to, 9000000000) > ?`).all(siteId, toTs, fromTs);
  const tariffIds = [...new Set(agreements.map((a) => a.tariff_id))];
  const rates = tariffIds.length ? db.prepare(
    `SELECT * FROM rate_interval WHERE tariff_id IN (${tariffIds.map(() => '?').join(',')})
       AND superseded_at IS NULL AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?
       AND (site_id IS NULL OR site_id = ?)
     ORDER BY valid_from`).all(...tariffIds, toTs, fromTs - 86400 * 2, siteId) : [];
  const vat = db.prepare('SELECT * FROM vat_rate').all();
  // Smart-charge dispatches, read from a day earlier so the daily allowance counts from its start.
  const dispatches = db.prepare(
    `SELECT f.start_ts, f.end_ts FROM interval_fact f JOIN series s ON s.id = f.series_id
     JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
     WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'octopus_kraken' AND m.code = 'ev_charge_kwh'
       AND f.superseded_at IS NULL AND f.end_ts > ? AND f.start_ts < ? ORDER BY f.start_ts`).all(String(siteId), fromTs - 86400, toTs);
  const site = db.prepare('SELECT timezone, gsp_region FROM site WHERE id = ?').get(siteId);
  const tz = site?.timezone || 'Europe/London';
  return { agreements, rates, vat, dispatches, tz, iogWindow: learnIogWindow(site?.gsp_region, tz), dispatchAllowed: dispatchAllowance(dispatches, tz) };
}

// Octopus: "Your car gets up to 6 hours of off-peak charging per day (measured midday to
// midday). If we schedule your car to charge outside of the 23:30–05:30 window, your home
// also gets the off-peak rate for that half-hour when it's within your car allowance."
// (octopus.energy/blog/intelligent-octopus-go-charge-limit, 7 May 2026). So the first
// 12 dispatched half-hours of each midday-to-midday period are discounted.
const ALLOWANCE_HALF_HOURS = 12;
function dispatchAllowance(dispatches, tz) {
  const allowed = new Set();
  const used = new Map();
  for (const d of dispatches) {
    for (let t = d.start_ts - (d.start_ts % 1800); t < d.end_ts; t += 1800) {
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
      AND r.superseded_at IS NULL AND r.valid_to IS NOT NULL ORDER BY r.valid_from DESC LIMIT 500`).all(region);
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

export function vatAt(p, fuel, direction, ts) {
  const v = p.vat.find((r) => r.fuel === fuel && r.direction === direction && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  return v ? v.rate : 0;
}

// Which register applies. Returns null when no source says, so the half-hour stays unpriced
// (and fails the rate-coverage check) rather than being priced on a guess.
// - Economy 7: Octopus does not publish each meter's switch times, so it is not priced.
// - Intelligent Octopus Go: the off-peak window learned from Octopus's time-stamped IOG
//   prices, plus completed smart-charge dispatches reported by Kraken.
function registerAt(p, a, ts) {
  if (a.structure === 'e7') return null;
  if (a.structure === 'iog') {
    if (p.dispatchAllowed.has(ts)) return 'night';
    if (!p.iogWindow) return null;
    const { hh, mm } = zonedParts(p.tz, ts);
    const mins = hh * 60 + mm;
    const { start, end } = p.iogWindow;
    const offPeak = start > end ? mins >= start || mins < end : mins >= start && mins < end;
    return offPeak ? 'night' : 'day';
  }
  return 'single';
}

export function rateRow(p, tariffId, component, register, ts) {
  const covering = p.rates.filter((r) => r.tariff_id === tariffId && r.component === component && r.register === register
    && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  if (!covering.length) return null;
  const homeSpecific = covering.filter((r) => r.site_id != null);
  const pool = homeSpecific.length ? homeSpecific : covering;
  const any = pool.find((r) => r.payment_method === 'ANY');
  if (any) return any;
  return pool.every((r) => Math.abs(r.price_ex_vat - pool[0].price_ex_vat) < 1e-9) ? pool[0] : null;
}

// Price of a slot for one meter kind: unit price ex VAT, VAT rate, standing charge per day ex VAT.
export function priceAt(p, kind, ts) {
  const a = agreementAt(p, kind, ts);
  if (!a) return null;
  const register = registerAt(p, a, ts);
  if (register == null) {
    const standing = rateRow(p, a.tariff_id, 'standing', 'single', ts);
    return { tariffCode: a.tariff_code, structure: a.structure, register: null, unitEx: null, standingEx: standing ? standing.price_ex_vat : 0, vat: vatAt(p, a.fuel, a.direction, ts) };
  }
  let unit = rateRow(p, a.tariff_id, 'unit', register, ts);
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
  const standing = rateRow(p, a.tariff_id, 'standing', 'single', ts);
  return {
    tariffCode: a.tariff_code, structure: a.structure, register,
    unitEx: unit ? unit.price_ex_vat : null,
    standingEx: standing ? standing.price_ex_vat : 0,
    vat: vatAt(p, a.fuel, a.direction, ts),
  };
}
