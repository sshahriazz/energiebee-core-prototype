// Rule-based insights. Each one reads only the serving tables and the forecast,
// and says which numbers it used, so it can be traced like everything else.
import { db } from '../db/db.js';
import { forecastSite } from './forecast.js';
import { nowSec, localDate, addDays, zonedParts } from './time.js';

const gbp = (p) => `£${(p / 100).toFixed(2)}`;
const kwh = (v) => `${v.toFixed(1)} kWh`;

export function insightsFor(siteId) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const tz = site.timezone;
  const today = localDate(tz, nowSec());
  const days = db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? ORDER BY local_date').all(siteId, addDays(today, -30));
  const t = days.find((d) => d.local_date === today);
  const y = days.find((d) => d.local_date === addDays(today, -1));
  const week = days.filter((d) => d.local_date >= addDays(today, -7) && d.local_date < today);
  const out = [];
  const add = (kind, tone, title, detail, uses) => out.push({ kind, tone, title, detail, uses });

  if (t && t.saving != null && t.saving < 0) {
    add('saving', 'info', `${gbp(-t.saving)} more than grid-only so far today`,
      `Energy bought cheaply to charge the battery is counted when it is bought; it pays back when the battery covers the dearer hours later today.`, ['site_day.saving', 'site_day.grid_to_battery_cost']);
  } else if (t && t.saving != null) {
    add('saving', 'good', `Saved ${gbp(t.saving)} so far today`,
      `Without solar and the battery today would have cost ${gbp(t.grid_only_cost)}; it has cost ${gbp(t.total_cost)}.`, ['site_day.saving', 'site_day.grid_only_cost', 'site_day.total_cost']);
  }
  if (week.length >= 3) {
    const s = week.reduce((a, d) => a + (d.saving || 0), 0);
    const c = week.reduce((a, d) => a + (d.total_cost || 0), 0);
    add('week', 'info', `Last ${week.length} days: ${gbp(c)} spent, ${gbp(s)} saved`,
      `About ${gbp((s / week.length) * 365)} a year at this rate.`, ['site_day.saving', 'site_day.total_cost']);
  }
  if (y && y.grid_export > 0.5 && y.home > 0) {
    const hh = db.prepare('SELECT AVG(import_rate_ex * (1 + import_vat)) AS imp, AVG(export_rate) AS exp FROM site_hh WHERE site_id = ? AND local_date = ? AND solar_to_grid > 0.01')
      .get(siteId, y.local_date);
    if (hh?.imp != null && hh?.exp != null && hh.imp > hh.exp) {
      add('export', 'tip', `${kwh(y.grid_export)} exported yesterday at ${hh.exp.toFixed(1)}p`,
        `Using it at home instead was worth ${hh.imp.toFixed(1)}p/kWh at those times. Running the washing machine or dishwasher in sunny hours keeps more of that value.`,
        ['site_hh.solar_to_grid', 'site_hh.export_rate', 'site_hh.import_rate_ex']);
    }
  }
  if (t && t.battery_to_home > 0.2 && t.battery_to_home_cost != null) {
    const paid = t.battery_to_home_cost / t.battery_to_home;
    const avoided = db.prepare('SELECT SUM(battery_to_home * import_rate_ex * (1 + import_vat)) AS v FROM site_hh WHERE site_id = ? AND local_date = ?').get(siteId, today).v;
    if (avoided != null) {
      add('battery', 'good', `Battery covered ${kwh(t.battery_to_home)} today`,
        `That energy cost ${paid.toFixed(1)}p/kWh to store (first in, first out) and replaced grid power worth ${gbp(avoided)}.`,
        ['site_hh.battery_to_home', 'site_hh.battery_to_home_cost', 'site_hh.import_rate_ex']);
    }
  }
  if (week.length >= 3) {
    const base = week.map((d) => d.base_load_kw).filter((v) => v != null);
    if (base.length) {
      const kw = Math.min(...base);
      const rate = db.prepare('SELECT AVG(import_rate_ex * (1 + import_vat)) AS r FROM site_hh WHERE site_id = ? AND local_date >= ?').get(siteId, addDays(today, -7)).r;
      if (rate) add('baseload', 'info', `Always-on use is about ${Math.round(kw * 1000)} W`,
        `Overnight minimum; that is ${Math.round(kw * 8760)} kWh and about ${gbp(kw * 8760 * rate)} a year.`, ['site_day.base_load_kw', 'site_hh.import_rate_ex']);
    }
  }
  try {
    const f = forecastSite(siteId, 48);
    if (f.cheapestWindow) {
      const s = zonedParts(tz, f.cheapestWindow.start);
      const e = zonedParts(tz, f.cheapestWindow.end);
      add('cheapest', 'tip', `Cheapest power: ${String(s.hh).padStart(2, '0')}:${String(s.mm).padStart(2, '0')}–${String(e.hh).padStart(2, '0')}:${String(e.mm).padStart(2, '0')}`,
        `Average ${f.cheapestWindow.avg.toFixed(1)}p/kWh over two hours. A good time for the car, dishwasher or a battery top-up.`, ['rate_interval']);
    }
    if (f.next24h.solar > 0) {
      const ySolar = y?.solar;
      add('solar_forecast', 'info', `${kwh(f.next24h.solar)} of solar expected in the next 24 hours`,
        ySolar != null ? `Yesterday the panels made ${kwh(ySolar)}.` : 'From the latest Quartz forecast.', ['forecast_fact (quartz)']);
    }
    if (f.greenestWindow) {
      const s = zonedParts(tz, f.greenestWindow.start);
      add('carbon', 'info', `Greenest grid from ${String(s.hh).padStart(2, '0')}:${String(s.mm).padStart(2, '0')}`,
        `About ${Math.round(f.greenestWindow.avg)} gCO2/kWh for two hours.`, ['forecast_fact (carbon_regional)']);
    }
  } catch { /* forecast needs history */ }
  const prov = days.filter((d) => d.slots_provisional > 0 && d.local_date < today);
  if (prov.length) {
    add('data', 'warn', `${prov.length} past day(s) still provisional`,
      'Smart meter readings have not arrived yet, so the inverter clamp is used for now. These days will be rebuilt when they do.', ['site_day.slots_provisional']);
  }
  const warn = db.prepare("SELECT check_code, COUNT(*) AS n FROM check_result WHERE site_id = ? AND status IN ('warn','fail') AND local_date >= ? GROUP BY check_code").all(siteId, addDays(today, -7));
  for (const w of warn) {
    if (w.check_code === 'rate_coverage') add('data', 'warn', `Prices missing on ${w.n} day(s)`, 'Some half-hours have no tariff price, so their cost is unknown.', ['check_result']);
    if (w.check_code === 'meter_vs_ct') add('data', 'warn', `Meter and inverter disagree on ${w.n} day(s)`, 'The smart meter is used for cost; the inverter clamp may need checking.', ['check_result']);
  }
  return out;
}
