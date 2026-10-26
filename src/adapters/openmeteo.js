// Open-Meteo hourly weather. Requested as Unix time so a forecast that crosses
// a clock change is not shifted by a fixed offset. Temperature and cloud are
// instants; irradiance is the mean of the preceding hour.
// Horizontal sunlight needs no panel details, so it is always fetched. Sunlight
// on the panels is fetched only when the real tilt and direction are known.
// Humidity, dew point and wind (m/s) come in the same request (no extra call): instants like
// temperature, for heating and heat-pump planning. Every variable's past hours are stored as
// facts and its future hours as one change-only forecast issue (forecast_fact, issued now): the
// outdoor temperature forecast a planner reads is outdoor_temp_c / open_meteo in forecast_fact.
// Note: the free host is for non-commercial use; production needs a paid plan.
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putReadings, putIntervals, putForecasts } from '../core/facts.js';
import { nowSec } from '../core/time.js';

export async function syncWeather(site, pastDays) {
  if (site.lat == null) return { skipped: 'no coordinates' };
  const angles = site.pv_tilt != null && site.pv_orientation != null;
  const params = new URLSearchParams({
    latitude: site.lat.toFixed(3), longitude: site.lon.toFixed(3),
    hourly: `temperature_2m,cloud_cover,shortwave_radiation,relative_humidity_2m,dew_point_2m,wind_speed_10m${angles ? ',global_tilted_irradiance' : ''}`,
    past_days: String(Math.min(Math.max(pastDays, 1), 92)), forecast_days: '3', timeformat: 'unixtime', timezone: 'GMT', wind_speed_unit: 'ms',
  });
  if (angles) {
    // Open-Meteo azimuth: 0 = south, -90 = east, +90 = west. Sites store a compass bearing.
    params.set('tilt', String(site.pv_tilt));
    params.set('azimuth', String(site.pv_orientation - 180));
  }
  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const { json } = await fetchJson(url);
  const h = json?.hourly;
  if (!h?.time?.length) {
    quarantine({ source: 'open_meteo', siteId: site.id, request: { url }, body: json, reason: 'no hourly data' });
    return { skipped: 'no hourly data' };
  }
  const { rawId } = landRaw({ source: 'open_meteo', siteId: site.id, request: { url }, body: json });
  const now = nowSec();
  const tempS = seriesId('site', site.id, 'outdoor_temp_c', 'open_meteo');
  const cloudS = seriesId('site', site.id, 'cloud_pct', 'open_meteo');
  const gtiS = seriesId('site', site.id, 'gti_wm2', 'open_meteo');
  const ghiS = seriesId('site', site.id, 'ghi_wm2', 'open_meteo');
  const past = { temp: [], cloud: [], gti: [], ghi: [] };
  const fut = { temp: [], cloud: [], gti: [], ghi: [] };
  h.time.forEach((t, i) => {
    const bucket = t <= now ? past : fut;
    if (h.temperature_2m[i] != null) bucket.temp.push({ ts: t, start: t, end: t + 3600, value: h.temperature_2m[i] });
    if (h.cloud_cover[i] != null) bucket.cloud.push({ ts: t, start: t, end: t + 3600, value: h.cloud_cover[i] });
    // Preceding-hour mean: the value at t covers [t - 1h, t).
    const g = h.global_tilted_irradiance?.[i];
    if (g != null) (t <= now ? past : fut).gti.push({ start: t - 3600, end: t, value: g });
    const s = h.shortwave_radiation?.[i];
    if (s != null) (t <= now ? past : fut).ghi.push({ start: t - 3600, end: t, value: s });
  });
  let n = putReadings(tempS, past.temp, rawId) + putReadings(cloudS, past.cloud, rawId)
    + putIntervals(gtiS, past.gti, rawId) + putIntervals(ghiS, past.ghi, rawId);
  const issued = now;
  let f = putForecasts(tempS, issued, fut.temp, rawId) + putForecasts(cloudS, issued, fut.cloud, rawId)
    + putForecasts(gtiS, issued, fut.gti, rawId) + putForecasts(ghiS, issued, fut.ghi, rawId);
  // Instants added for heating (Phase B); a variable the answer lacks stores nothing.
  for (const [key, metric] of [['relative_humidity_2m', 'humidity_pct'], ['dew_point_2m', 'dew_point_c'], ['wind_speed_10m', 'wind_speed_ms']]) {
    const vals = h[key];
    if (!Array.isArray(vals)) continue;
    const rows = { past: [], fut: [] };
    h.time.forEach((t, i) => { if (vals[i] != null) rows[t <= now ? 'past' : 'fut'].push({ ts: t, start: t, end: t + 3600, value: vals[i] }); });
    if (!rows.past.length && !rows.fut.length) continue;
    const s = seriesId('site', site.id, metric, 'open_meteo');
    n += putReadings(s, rows.past, rawId);
    f += putForecasts(s, issued, rows.fut, rawId);
  }
  return { facts: n, forecasts: f };
}
