// Loads the half-hour (or daily) timeline for the chosen period. For "Today" it
// appends the forecast after now, so past, now and forecast sit on one axis.
import { api } from './api.js';

const fromForecast = (s) => ({
  slot_start: s.slot_start, local_date: s.local_date, _fc: true,
  solar: s.solar, home: s.home, ev: s.ev, soc_end: s.soc_end,
  solar_to_home: s.solar != null && s.home != null ? Math.min(s.solar, s.home) : null,
  // Grid import in the forecast includes grid charging of the battery; split it the same way the build does.
  solar_to_battery: s.solar_to_battery ?? null, solar_to_grid: s.grid_export,
  battery_to_home: s.battery_discharge, grid_to_battery: s.grid_to_battery ?? 0, battery_to_grid: 0,
  grid_to_home: s.grid_import != null ? Math.max(0, s.grid_import - (s.grid_to_battery ?? 0)) : null,
  grid_import: s.grid_import, grid_export: s.grid_export, battery_charge: s.battery_charge, battery_discharge: s.battery_discharge,
  import_rate: s.import_rate, export_rate: s.export_rate, carbon_intensity: s.carbon_intensity,
  total_cost: s.cost, grid_only_cost: s.grid_only_cost, saving: s.saving, solar_forecast: s.solar,
});

export async function loadTimeline(state, { forecastHours = 24 } = {}) {
  const id = state.site.id;
  const t = await api(`/api/sites/${id}/timeline?period=${state.period}`);
  let rows = t.rows;
  let nowIndex = null;
  let forecast = null;
  if (t.step === 'hh' && state.period === 'today' && forecastHours) {
    forecast = await api(`/api/sites/${id}/forecast?hours=48`);
    const last = rows.length ? rows[rows.length - 1].slot_start : 0;
    const now = Date.now() / 1000;
    const extra = forecast.slots.filter((s) => s.slot_start > last && s.slot_start < now + forecastHours * 3600).map(fromForecast);
    nowIndex = rows.length + Math.min(1, Math.max(0, (now - (extra[0]?.slot_start ?? now)) / 1800));
    rows = rows.concat(extra);
  }
  return { ...t, rows, nowIndex, forecast };
}

export const isFc = (r) => !!r._fc;
