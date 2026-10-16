// Carbon Intensity (NESO). Regional values are forecast-only upstream, so past
// slots are stored as interval facts marked "estimated", and forward slots as
// forecast facts with the fetch time as the issue time (the API gives none).
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putIntervals, putForecasts, QUALITY } from '../core/facts.js';
import { isoUtc, nowSec, floorTo, SLOT, parseIso } from '../core/time.js';

const BASE = 'https://api.carbonintensity.org.uk';
const minute = (ts) => isoUtc(ts).slice(0, 16) + 'Z';

function slotsOf(json) {
  const d = json?.data;
  const inner = Array.isArray(d) ? d[0]?.data : d?.data;
  return Array.isArray(inner) ? inner : null;
}

export async function syncCarbon(site, fromTs, toTs) {
  if (!site.outcode || site.carbon_region == null) return { skipped: 'no carbon region' };
  const series = seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional');
  let past = 0;
  // History in 7-day chunks (the API documents a 14-day limit per request).
  for (let a = fromTs; a < Math.min(toTs, nowSec()); a += 7 * 86400) {
    const b = Math.min(a + 7 * 86400, nowSec());
    const url = `${BASE}/regional/intensity/${minute(a)}/${minute(b)}/postcode/${site.outcode}`;
    const { json } = await fetchJson(url);
    const slots = slotsOf(json);
    if (!slots) { quarantine({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json, reason: 'unexpected shape' }); continue; }
    const { rawId } = landRaw({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json });
    past += putIntervals(series, slots.filter((s) => s.intensity?.forecast != null).map((s) => ({
      start: parseIso(s.from), end: parseIso(s.to), value: s.intensity.forecast, quality: QUALITY.ESTIMATED,
    })), rawId);
  }
  // Forward 48 hours as a new forecast issue.
  const now = floorTo(nowSec(), SLOT);
  const url = `${BASE}/regional/intensity/${minute(now)}/fw48h/postcode/${site.outcode}`;
  const { json } = await fetchJson(url);
  const slots = slotsOf(json) || [];
  const { rawId } = landRaw({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json });
  const fwd = putForecasts(series, nowSec(), slots.filter((s) => s.intensity?.forecast != null).map((s) => ({
    start: parseIso(s.from), end: parseIso(s.to), value: s.intensity.forecast,
  })), rawId);
  return { past, forecast: fwd };
}
