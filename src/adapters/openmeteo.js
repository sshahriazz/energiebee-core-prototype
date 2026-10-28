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
import { landRaw, quarantine } from '../core/facts.js';
import { ingestObservations } from '../core/channels.js';
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
  // Points as Open-Meteo names them. Instant variables become readings (past) or forecast issues (future);
  // the two irradiance means cover the hour before their timestamp, so they are periods.
  const INSTANT = ['temperature_2m', 'cloud_cover', 'relative_humidity_2m', 'dew_point_2m', 'wind_speed_10m'];
  const MEAN_BEFORE = ['global_tilted_irradiance', 'shortwave_radiation'];
  const past = []; const fut = [];
  h.time.forEach((t, i) => {
    for (const point of INSTANT) {
      const v = h[point]?.[i];
      if (v == null) continue;
      if (t <= now) past.push({ point, ts: t, value: v }); else fut.push({ point, start: t, end: t + 3600, issuedAt: now, value: v });
    }
    for (const point of MEAN_BEFORE) {
      const v = h[point]?.[i];
      if (v == null) continue;
      // Preceding-hour mean: the value at t covers [t - 1h, t).
      if (t <= now) past.push({ point, start: t - 3600, end: t, value: v }); else fut.push({ point, start: t - 3600, end: t, issuedAt: now, value: v });
    }
  });
  const out = ingestObservations(site.id, 'open_meteo', [...past, ...fut], rawId);
  const n = out.written; const f = out.forecasts;
  return { facts: n, forecasts: f };
}
