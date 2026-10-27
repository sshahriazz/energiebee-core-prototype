// Carbon Intensity (NESO). Regional values are forecast-only upstream, so past
// slots are stored as interval facts marked "estimated", and forward slots as
// forecast facts with the fetch time as the issue time (the API gives none).
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, QUALITY } from '../core/facts.js';
import { ingestObservations } from '../core/channels.js';
import { isoUtc, nowSec, floorTo, parseIso } from '../core/time.js';

// The API's own grid: half-hours on :00 and :30 UTC, whatever slot length a home uses. Facts
// are stored as published (30-minute periods) and the build spreads them over each home's slots.
const API_STEP = 1800;

const BASE = 'https://api.carbonintensity.org.uk';
const minute = (ts) => isoUtc(ts).slice(0, 16) + 'Z';

function slotsOf(json) {
  const d = json?.data;
  const inner = Array.isArray(d) ? d[0]?.data : d?.data;
  return Array.isArray(inner) ? inner : null;
}

export async function syncCarbon(site, fromTs, toTs) {
  if (!site.outcode || site.carbon_region == null) return { skipped: 'no carbon region' };
  const subject = { kind: 'region', id: `carbon:${site.carbon_region}` };
  let past = 0;
  // History in 7-day chunks (the API documents a 14-day limit per request).
  for (let a = fromTs; a < Math.min(toTs, nowSec()); a += 7 * 86400) {
    const b = Math.min(a + 7 * 86400, nowSec());
    const url = `${BASE}/regional/intensity/${minute(a)}/${minute(b)}/postcode/${site.outcode}`;
    const { json } = await fetchJson(url);
    const slots = slotsOf(json);
    if (!slots) { quarantine({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json, reason: 'unexpected shape' }); continue; }
    const { rawId } = landRaw({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json });
    past += ingestObservations(site.id, 'carbon_regional', slots.filter((s) => s.intensity?.forecast != null).map((s) => ({
      point: 'intensity', start: parseIso(s.from), end: parseIso(s.to), value: s.intensity.forecast, quality: QUALITY.ESTIMATED,
    })), rawId, { subject }).written;
  }
  // Forward 48 hours as a new forecast issue.
  const now = floorTo(nowSec(), API_STEP);
  const url = `${BASE}/regional/intensity/${minute(now)}/fw48h/postcode/${site.outcode}`;
  const { json } = await fetchJson(url);
  const slots = slotsOf(json) || [];
  const { rawId } = landRaw({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json });
  const issuedAt = nowSec();
  const fwd = ingestObservations(site.id, 'carbon_regional', slots.filter((s) => s.intensity?.forecast != null).map((s) => ({
    point: 'intensity', start: parseIso(s.from), end: parseIso(s.to), issuedAt, value: s.intensity.forecast,
  })), rawId, { subject }).forecasts;
  return { past, forecast: fwd };
}
