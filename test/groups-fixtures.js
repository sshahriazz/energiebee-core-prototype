// Synthetic homes for the group tests: slot rows written straight into site_hh with simple deterministic
// shapes (nothing here is real data). Import the db first: useDb() must have run.
import { db } from '../src/db/db.js';
import { localDate, todMinute } from '../src/core/time.js';

let n = 0;
export function makeHome({ tz = 'Europe/London', slotS = 1800, currency = 'GBP', country = 'GB', battery = 10 } = {}) {
  const market = country;
  return Number(db.prepare(`INSERT INTO site (name, created_at, country, market_code, currency, timezone, slot_s, battery_kwh) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(`Synthetic group home ${++n}`, country, market, currency, tz, slotS, battery).lastInsertRowid);
}

// Rows from `from` to `to` (epoch s, multiples of slotS). shape(ts, defaults) -> overrides of the default figures.
export function fillSlots(siteId, { tz, slotS, currency, from, to, shape = () => ({}), state = 'final' }) {
  const ins = db.prepare(`INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, currency, solar, grid_import, grid_export, battery_charge, battery_discharge, home,
    solar_to_home, solar_to_battery, grid_to_home, grid_to_battery, battery_to_home, grid_to_home_cost, battery_to_home_cost, standing_cost, total_cost, import_rate_ex, import_vat, carbon_intensity, carbon_g, soc_end, outdoor_temp, method_version, built_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, 0, 0, ?, 0, 0, ?, ?, 0.2, 100, ?, 50, 10, 'test', 1)`);
  for (let ts = from; ts < to; ts += slotS) {
    const h = slotS / 3600;
    const k = 1 + ((ts / 900) % 4);                                   // 1..4, repeats every hour
    const d = { solar: 0.4 * h * k, grid_import: 0.3 * h * k, home: 0.6 * h * k, solar_to_home: 0.3 * h * k, grid_to_home: 0.3 * h * k, cost: 3 * h * k, rate: 10, state };
    Object.assign(d, shape(ts, d));
    ins.run(siteId, ts, localDate(tz, ts), slotS, todMinute(tz, ts), d.state, currency, d.solar, d.grid_import, d.home, d.solar_to_home, d.grid_to_home, d.cost, d.cost, d.rate, 30 * h * k * 0.3 * 1000 / 1000);
  }
}
