// Open Climate Fix Quartz: 48-hour solar forecast in 15-minute steps.
// Each value is mean kW over the next 15 minutes, so energy = kW x 0.25 h.
// Recent inverter output is NOT sent: with it, Quartz scaled this home's forecast to a
// 6.25 kW peak for 5 kWp of panels (16 Oct 2026). The forecast is instead checked against
// this home's actual output and scaled by the observed ratio (src/core/forecast.js).
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine } from '../core/facts.js';
import { ingestObservations } from '../core/channels.js';
import { nowSec } from '../core/time.js';

export async function syncQuartz(site) {
  if (site.lat == null) return { skipped: 'no coordinates' };
  // Quartz needs the system's size, tilt and direction. Without the real values it is not called;
  // the forecast then learns this home's response to sunlight from its own history instead.
  if (!site.pv_kwp || site.pv_tilt == null || site.pv_orientation == null) return { skipped: 'panel size, tilt or direction unknown' };
  const kwp = site.pv_kwp;
  const site_ = {
    latitude: Number(site.lat.toFixed(3)), longitude: Number(site.lon.toFixed(3)),
    capacity_kwp: kwp, tilt: site.pv_tilt, orientation: site.pv_orientation,
  };
  const url = 'https://open.quartz.solar/forecast/';
  const { json } = await fetchJson(url, { method: 'POST', body: { site: site_ }, timeoutMs: 45000 });
  const power = json?.predictions?.power_kw;
  if (!power || typeof power !== 'object') {
    quarantine({ source: 'quartz', siteId: site.id, request: { url, site: site_ }, body: json, reason: 'no predictions' });
    return { skipped: 'no predictions' };
  }
  const { rawId } = landRaw({ source: 'quartz', siteId: site.id, request: { url, site: site_ }, body: json });
  // Keys and the issue timestamp have no zone but are UTC.
  const asUtc = (s) => Math.floor(Date.parse(s.endsWith('Z') ? s : `${s}Z`) / 1000);
  const issued = json.timestamp ? asUtc(json.timestamp) : nowSec();
  // Steps start at the request time, not on a grid. Snap each to the nearest
  // 15 minutes so every issue covers the same periods and the latest issue wins
  // cleanly (otherwise issues never overlap and would be summed).
  const rows = Object.entries(power).map(([k, kw]) => {
    const t = Math.round(asUtc(k) / 900) * 900;
    return { point: 'power_kw', start: t, end: t + 900, issuedAt: issued, value: kw };
  });
  const n = ingestObservations(site.id, 'quartz', rows, rawId).forecasts;
  return { forecasts: n };
}
