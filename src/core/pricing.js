// Resolves the price of any half-hour: agreement in force -> tariff -> rate row
// covering the slot (home-specific rows win) -> VAT for the fuel, direction and date.
import { db } from '../db/db.js';
import { zonedParts } from './time.js';

const PM_ORDER = ['DIRECT_DEBIT', 'ANY', 'NON_DIRECT_DEBIT'];   // assumption: customers pay by direct debit

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
  // Intelligent Octopus dispatch windows earn the off-peak price for that home.
  const dispatches = db.prepare(
    `SELECT f.start_ts, f.end_ts FROM interval_fact f JOIN series s ON s.id = f.series_id
     JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
     WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'octopus_kraken' AND m.code = 'ev_charge_kwh'
       AND f.superseded_at IS NULL AND f.end_ts > ? AND f.start_ts < ?`).all(String(siteId), fromTs, toTs);
  return { agreements, rates, vat, dispatches, tz: db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId)?.timezone || 'Europe/London' };
}

function agreementAt(p, kind, ts) {
  return p.agreements.find((a) => a.kind === kind && a.valid_from <= ts && (a.valid_to == null || a.valid_to > ts));
}

function vatAt(p, fuel, direction, ts) {
  const v = p.vat.find((r) => r.fuel === fuel && r.direction === direction && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  return v ? v.rate : 0;
}

// Which register applies. Economy 7 switch times are not published by Octopus;
// we assume 00:30-07:30 GMT. Intelligent Octopus Go: 23:30-05:30 local plus dispatch windows.
function registerAt(p, a, ts) {
  if (a.structure === 'e7') {
    const minutesUtc = Math.floor((ts % 86400) / 60);
    return minutesUtc >= 30 && minutesUtc < 450 ? 'night' : 'day';
  }
  if (a.structure === 'iog') {
    const { hh, mm } = zonedParts(p.tz, ts);
    const mins = hh * 60 + mm;
    const offPeak = mins >= 23 * 60 + 30 || mins < 5 * 60 + 30;
    const dispatched = p.dispatches.some((d) => d.start_ts < ts + 1800 && d.end_ts > ts);
    return offPeak || dispatched ? 'night' : 'day';
  }
  return 'single';
}

function rateRow(p, tariffId, component, register, ts) {
  const covering = p.rates.filter((r) => r.tariff_id === tariffId && r.component === component && r.register === register
    && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts));
  if (!covering.length) return null;
  const homeSpecific = covering.filter((r) => r.site_id != null);
  const pool = homeSpecific.length ? homeSpecific : covering;
  for (const pm of PM_ORDER) {
    const hit = pool.find((r) => r.payment_method === pm);
    if (hit) return hit;
  }
  return pool[0];
}

// Price of a slot for one meter kind: unit price ex VAT, VAT rate, standing charge per day ex VAT.
export function priceAt(p, kind, ts) {
  const a = agreementAt(p, kind, ts);
  if (!a) return null;
  const register = registerAt(p, a, ts);
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
