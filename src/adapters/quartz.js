// Open Climate Fix Quartz: 48-hour solar forecast in 15-minute steps.
// Each value is mean kW over the next 15 minutes, so energy = kW x 0.25 h.
// Recent inverter output is sent as live_generation, which tightens the forecast.
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putForecasts, readReadings } from '../core/facts.js';
import { nowSec, isoUtc } from '../core/time.js';

export async function syncQuartz(site) {
  if (site.lat == null) return { skipped: 'no coordinates' };
  const kwp = site.pv_kwp || 4;
  const solarW = [seriesId('site', site.id, 'solar_w', 'sunsynk_5min'), seriesId('site', site.id, 'solar_w', 'sunsynk_live')];
  const recent = readReadings(solarW, nowSec() - 3600, nowSec() + 1)
    .filter((r) => r.value != null)
    .map((r) => ({ timestamp: isoUtc(r.ts), generation: r.value / 1000 }));
  // Night-time zeros make Quartz scale the whole forecast down, so only send real daylight output.
  const useLive = recent.some((r) => r.generation > 0.05);
  const site_ = {
    latitude: Number(site.lat.toFixed(3)), longitude: Number(site.lon.toFixed(3)),
    capacity_kwp: kwp, tilt: site.pv_tilt ?? 35, orientation: site.pv_orientation ?? 180,
  };
  const url = 'https://open.quartz.solar/forecast/';
  let json;
  try {
    ({ json } = await fetchJson(url, { method: 'POST', body: useLive ? { site: site_, live_generation: recent } : { site: site_ }, timeoutMs: 45000 }));
  } catch (err) {
    if (!useLive) throw err;
    ({ json } = await fetchJson(url, { method: 'POST', body: { site: site_ }, timeoutMs: 45000 }));
  }
  const power = json?.predictions?.power_kw;
  if (!power || typeof power !== 'object') {
    quarantine({ source: 'quartz', siteId: site.id, request: { url, site: site_ }, body: json, reason: 'no predictions' });
    return { skipped: 'no predictions' };
  }
  const { rawId } = landRaw({ source: 'quartz', siteId: site.id, request: { url, site: site_, liveGeneration: useLive ? recent.length : 0 }, body: json });
  // Keys and the issue timestamp have no zone but are UTC.
  const asUtc = (s) => Math.floor(Date.parse(s.endsWith('Z') ? s : `${s}Z`) / 1000);
  const issued = json.timestamp ? asUtc(json.timestamp) : nowSec();
  // Steps start at the request time, not on a grid. Snap each to the nearest
  // 15 minutes so every issue covers the same periods and the latest issue wins
  // cleanly (otherwise issues never overlap and would be summed).
  const rows = Object.entries(power).map(([k, kw]) => {
    const t = Math.round(asUtc(k) / 900) * 900;
    return { start: t, end: t + 900, value: Math.max(0, Number(kw) || 0) * 0.25 };
  });
  const n = putForecasts(seriesId('site', site.id, 'solar_kwh', 'quartz'), issued, rows, rawId);
  return { forecasts: n, liveGeneration: useLive ? recent.length : 0 };
}
