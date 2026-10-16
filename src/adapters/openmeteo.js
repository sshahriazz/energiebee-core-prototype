// Open-Meteo hourly weather. Requested as Unix time so a forecast that crosses
// a clock change is not shifted by a fixed offset. Temperature and cloud are
// instants; tilted irradiance is the mean of the preceding hour.
// Note: the free host is for non-commercial use; production needs a paid plan.
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putReadings, putIntervals, putForecasts } from '../core/facts.js';
import { nowSec } from '../core/time.js';

export async function syncWeather(site, pastDays) {
  if (site.lat == null) return { skipped: 'no coordinates' };
  const tilt = site.pv_tilt ?? 35;
  // Open-Meteo azimuth: 0 = south, -90 = east, +90 = west. Our sites store a compass bearing.
  const azimuth = (site.pv_orientation ?? 180) - 180;
  const params = new URLSearchParams({
    latitude: site.lat.toFixed(3), longitude: site.lon.toFixed(3),
    hourly: 'temperature_2m,cloud_cover,global_tilted_irradiance',
    tilt: String(tilt), azimuth: String(azimuth),
    past_days: String(Math.min(Math.max(pastDays, 1), 92)), forecast_days: '3', timeformat: 'unixtime', timezone: 'GMT',
  });
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
  const past = { temp: [], cloud: [], gti: [] };
  const fut = { temp: [], cloud: [], gti: [] };
  h.time.forEach((t, i) => {
    const bucket = t <= now ? past : fut;
    if (h.temperature_2m[i] != null) bucket.temp.push({ ts: t, start: t, end: t + 3600, value: h.temperature_2m[i] });
    if (h.cloud_cover[i] != null) bucket.cloud.push({ ts: t, start: t, end: t + 3600, value: h.cloud_cover[i] });
    // Preceding-hour mean: the value at t covers [t - 1h, t).
    const g = h.global_tilted_irradiance?.[i];
    if (g != null) (t <= now ? past : fut).gti.push({ start: t - 3600, end: t, value: g });
  });
  const n = putReadings(tempS, past.temp, rawId) + putReadings(cloudS, past.cloud, rawId) + putIntervals(gtiS, past.gti, rawId);
  const issued = now;
  const f = putForecasts(tempS, issued, fut.temp, rawId) + putForecasts(cloudS, issued, fut.cloud, rawId) + putForecasts(gtiS, issued, fut.gti, rawId);
  return { facts: n, forecasts: f };
}
