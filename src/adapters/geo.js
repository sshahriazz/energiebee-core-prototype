// Site keys from a postcode: coordinates (postcodes.io), Octopus grid supply
// point letter (prices) and NESO carbon region. The keys do not convert into
// each other, so each comes from the source that owns it.
import { db } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw } from '../core/facts.js';

export async function resolveSiteGeo(site) {
  if (!site.postcode && site.lat != null) {
    // Nearest postcode to the inverter's registered location.
    const url = `https://api.postcodes.io/postcodes?lon=${site.lon}&lat=${site.lat}&limit=1&radius=2000`;
    const { json } = await fetchJson(url);
    landRaw({ source: 'postcodes_io', siteId: site.id, request: { url }, body: json });
    const pc = json.result?.[0]?.postcode;
    if (pc) { db.prepare('UPDATE site SET postcode = ? WHERE id = ?').run(pc, site.id); site = { ...site, postcode: pc }; }
  }
  if (!site.postcode) throw new Error('No postcode set for this home (SITE_POSTCODE in .env)');
  const pc = site.postcode.replace(/\s+/g, '').toUpperCase();
  const updates = {};

  if (site.lat == null || !site.outcode) {
    const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`;
    const { json } = await fetchJson(url);
    landRaw({ source: 'postcodes_io', siteId: site.id, request: { url }, body: json });
    updates.lat = json.result.latitude;
    updates.lon = json.result.longitude;
    updates.outcode = json.result.outcode;
  }
  if (!site.gsp_region) {
    const url = `https://api.octopus.energy/v1/industry/grid-supply-points/?postcode=${encodeURIComponent(pc)}`;
    const { json } = await fetchJson(url);
    landRaw({ source: 'octopus_rates', siteId: site.id, request: { url }, body: json });
    // count 1 = resolved; 0 = unknown; 14 = every region (blank postcode)
    if (json.count === 1) updates.gsp_region = json.results[0].group_id.replace(/^_/, '');
  }
  if (site.carbon_region == null) {
    const outcode = updates.outcode || site.outcode;
    const url = `https://api.carbonintensity.org.uk/regional/postcode/${encodeURIComponent(outcode)}`;
    const { json } = await fetchJson(url);
    landRaw({ source: 'carbon_regional', siteId: site.id, request: { url }, body: json });
    updates.carbon_region = json.data?.[0]?.regionid ?? null;
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE site SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), site.id);
  }
  return db.prepare('SELECT * FROM site WHERE id = ?').get(site.id);
}
