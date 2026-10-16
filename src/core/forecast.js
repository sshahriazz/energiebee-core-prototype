// Next 48 hours, per half-hour: expected solar (latest Quartz issue), expected
// home use (median of the same half-hour over the last 14 days, plus planned EV
// charging), published prices and the carbon forecast. A simple battery rule
// then turns those into expected import, export, cost and saving.
import { db } from '../db/db.js';
import { seriesId, readForecastOfRecord, readReadings } from './facts.js';
import { loadPricing, priceAt } from './pricing.js';
import { SLOT, nowSec, floorTo, zonedParts, localDate } from './time.js';

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function forecastSite(siteId, hours = 48) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const tz = site.timezone;
  const now = nowSec();
  const from = floorTo(now, SLOT);
  const to = from + hours * 3600;
  const sid = (m, s) => seriesId('site', siteId, m, s);

  // Baseline home use (excluding EV) by local half-hour of day.
  const hist = db.prepare('SELECT slot_start, home, ev FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? AND state != ?')
    .all(siteId, from - 14 * 86400, from, 'missing');
  const byHalfHour = new Map();
  for (const r of hist) {
    const { hh, mm } = zonedParts(tz, r.slot_start);
    const k = hh * 2 + (mm >= 30 ? 1 : 0);
    (byHalfHour.get(k) || byHalfHour.set(k, []).get(k)).push(Math.max(0, (r.home || 0) - (r.ev || 0)));
  }

  const solarFc = readForecastOfRecord(sid('solar_kwh', 'quartz'), from, to, now + 60);
  const solarBy = new Map();
  for (const f of solarFc) { const s = floorTo(f.start_ts, SLOT); solarBy.set(s, (solarBy.get(s) || 0) + (f.value || 0)); }
  const solarIssued = solarFc.length ? Math.max(...solarFc.map((f) => f.issued_at)) : null;
  const evFc = readForecastOfRecord(sid('ev_charge_kwh', 'octopus_kraken'), from - 3600, to, now + 60);
  const evAt = (slot) => evFc.reduce((s, f) => {
    const o = Math.min(f.end_ts, slot + SLOT) - Math.max(f.start_ts, slot);
    return o > 0 && f.value != null ? s + (f.value * o) / (f.end_ts - f.start_ts) : s;
  }, 0);
  const carbonFc = site.carbon_region != null
    ? readForecastOfRecord(seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional'), from, to, now + 60) : [];
  const carbonBy = new Map(carbonFc.map((f) => [f.start_ts, f.value]));
  const pricing = loadPricing(siteId, from, to);

  // Battery starts from the latest known charge level.
  const socRow = readReadings([sid('battery_soc_pct', 'sunsynk_live'), sid('battery_soc_pct', 'sunsynk_5min')], now - 3 * 3600, now + 1).pop();
  const cap = site.battery_kwh || 0;
  let stored = cap * ((socRow?.value ?? 50) / 100);
  const maxKwh = Math.min(3.6, cap * 0.5) * 0.5;

  const slots = [];
  for (let t = from; t < to; t += SLOT) {
    const { hh, mm } = zonedParts(tz, t);
    const base = median(byHalfHour.get(hh * 2 + (mm >= 30 ? 1 : 0)) || []);
    const ev = evAt(t);
    const home = base == null ? null : base + ev;
    const solar = solarBy.has(t) ? solarBy.get(t) : null;
    const pi = priceAt(pricing, 'meter_import', t);
    const pe = priceAt(pricing, 'meter_export', t);
    const imp = pi?.unitEx != null ? pi.unitEx * (1 + pi.vat) : null;
    const expRate = pe?.unitEx != null ? pe.unitEx * (1 + pe.vat) : null;
    let row = { slot_start: t, local_date: localDate(tz, t), solar, home, ev, import_rate: imp, export_rate: expRate, carbon_intensity: carbonBy.get(t) ?? null };
    if (home != null && solar != null) {
      let net = solar - home;
      let toBatt = 0; let fromBatt = 0;
      if (cap) {
        if (net > 0) { toBatt = Math.min(net, maxKwh, cap * 0.98 - stored); stored += toBatt * 0.95; net -= toBatt; }
        else if (ev === 0) { fromBatt = Math.min(-net, maxKwh, Math.max(0, stored - cap * 0.1) * 0.95); stored -= fromBatt / 0.95; net += fromBatt; }
      }
      const gridImport = Math.max(0, -net);
      const gridExport = Math.max(0, net);
      row = { ...row, battery_charge: toBatt, battery_discharge: fromBatt, grid_import: gridImport, grid_export: gridExport, soc_end: cap ? (stored / cap) * 100 : null };
      if (imp != null) {
        row.cost = gridImport * imp - gridExport * (expRate || 0);
        row.grid_only_cost = home * imp;
        row.saving = row.grid_only_cost - row.cost;
      }
    }
    slots.push(row);
  }

  // Cheapest and greenest 2-hour windows in the next 24 hours.
  const window = (key, len = 4) => {
    let best = null;
    const day = slots.slice(0, 48);
    for (let i = 0; i + len <= day.length; i++) {
      const vals = day.slice(i, i + len).map((s) => s[key]);
      if (vals.some((v) => v == null)) continue;
      const avg = vals.reduce((a, b) => a + b, 0) / len;
      if (!best || avg < best.avg) best = { start: day[i].slot_start, end: day[i].slot_start + len * SLOT, avg };
    }
    return best;
  };
  const sum = (k, n = slots.length) => slots.slice(0, n).reduce((s, r) => s + (r[k] ?? 0), 0);
  return {
    from, to, solarIssuedAt: solarIssued, baselineDays: 14,
    pricesPublishedUntil: slots.filter((s) => s.import_rate != null).pop()?.slot_start + SLOT || null,
    next24h: {
      solar: sum('solar', 48), home: sum('home', 48), import: sum('grid_import', 48), export: sum('grid_export', 48),
      // Cost and saving cover only the half-hours whose prices are already published.
      cost: sum('cost', 48), saving: sum('saving', 48), gridOnlyCost: sum('grid_only_cost', 48),
      pricedSlots: slots.slice(0, 48).filter((s) => s.cost != null).length,
    },
    cheapestWindow: window('import_rate'), greenestWindow: window('carbon_intensity'),
    slots,
  };
}
