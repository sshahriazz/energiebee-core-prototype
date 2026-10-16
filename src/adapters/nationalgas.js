// National Gas Data Portal: daily calorific value (CV) for the gas meter's local
// distribution zone (LDZ). GB gas is billed on volume × CV, so m3 readings are
// converted to kWh with the CV published for each gas day, never a fixed figure.
// The LDZ comes from Octopus (Kraken gasMeterPoints.ldz); the data item id is
// looked up by its published name, "Calorific Value, LDZ(xx)".
import { db } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putIntervals, QUALITY } from '../core/facts.js';
import { localDate, localToUtc, addDays } from '../core/time.js';

const BASE = 'https://data.nationalgas.com/api';
const itemIds = new Map();   // LDZ → data item id, cached for the process

async function itemIdFor(ldz, siteId) {
  if (itemIds.has(ldz)) return itemIds.get(ldz);
  const conn = db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'gas_cv'").get(siteId);
  const meta = JSON.parse(conn?.meta || '{}');
  if (meta.ldz === ldz && meta.itemId) { itemIds.set(ldz, meta.itemId); return meta.itemId; }
  // The folder list is large (several MB), so it is read once and the id kept on the connection.
  const { json } = await fetchJson(`${BASE}/find-gas-data-folders`, { timeoutMs: 60000 });
  const name = `Calorific Value, LDZ(${ldz})`;
  let found = null;
  const walk = (n) => {
    if (found || !n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.name === name && /PUBOB\d+/.test(n.description || '')) found = n.description.match(/PUBOB\d+/)[0];
    if (n.children) walk(n.children);
  };
  walk(json?.data);
  if (!found) throw new Error(`National Gas has no data item named "${name}"`);
  db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'gas_cv'").run(JSON.stringify({ ...meta, ldz, itemId: found, itemName: name }), siteId);
  itemIds.set(ldz, found);
  return found;
}

// Gas day D runs 05:00 local on D to 05:00 local on D + 1 (UNC Modification 0461).
const gasDayBounds = (tz, d) => {
  const [y, m, day] = d.split('-').map(Number);
  const n = addDays(d, 1).split('-').map(Number);
  return [localToUtc(tz, y, m, day, 5, 0), localToUtc(tz, n[0], n[1], n[2], 5, 0)];
};

export async function syncGasCv(site, fromTs, toTs) {
  const gas = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(site.id)
    .map((d) => JSON.parse(d.attrs || '{}')).find((a) => a.gasUnit?.unit === 'm3' && a.ldz);
  if (!gas) return { skipped: 'no gas meter in m3 with a known LDZ' };
  const ldz = gas.ldz;
  const id = await itemIdFor(ldz, site.id);
  // From the gas day before the window (a half-hour before 05:00 belongs to the previous gas day).
  const from = addDays(localDate(site.timezone, fromTs), -1);
  const to = localDate(site.timezone, toTs);
  const url = `${BASE}/find-gas-data-download?applicableFor=Y&dateFrom=${from}&dateTo=${to}&dateType=GASDAY&latestFlag=Y&ids=${id}&type=CSV`;
  const res = await fetch(url, { headers: { 'user-agent': 'EnergieBee core prototype' } });
  const text = await res.text();
  if (!res.ok || !text.startsWith('Applicable At')) {
    quarantine({ source: 'national_gas_cv', siteId: site.id, request: { url }, body: text.slice(0, 2000), reason: `HTTP ${res.status} or unexpected format` });
    throw new Error(`National Gas CV download failed (HTTP ${res.status})`);
  }
  const { rawId } = landRaw({ source: 'national_gas_cv', siteId: site.id, request: { url, ldz, itemId: id }, body: text });
  // CSV: Applicable At, Applicable For (DD/MM/YYYY = gas day), Data Item, Value, Generated Time, Quality Indicator
  const rows = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const cells = line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const [, applicableFor, , value] = cells;
    const v = Number(value);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(applicableFor || '');
    if (!m || !Number.isFinite(v)) continue;
    const [a, b] = gasDayBounds(site.timezone, `${m[3]}-${m[2]}-${m[1]}`);
    rows.push({ start: a, end: b, value: v, quality: QUALITY.MEASURED });
  }
  const n = putIntervals(seriesId('region', `ldz:${ldz}`, 'gas_cv_mjm3', 'national_gas_cv'), rows, rawId);
  return { ldz, itemId: id, days: rows.length, facts: n };
}
