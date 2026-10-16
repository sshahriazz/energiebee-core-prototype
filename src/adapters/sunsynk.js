// Sunsynk Connect adapter. The normalisers are exported separately so the demo
// generator can feed provider-shaped payloads through exactly the same path.
//
// Note: Sunsynk's Terms of Use (1 Nov 2025) forbid automated scraping of the
// consumer app. This prototype uses the owner's own login at a low rate; a
// production system needs a partner key for the official API.
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putReadings, putIntervals, QUALITY } from '../core/facts.js';
import { localToUtc, dayBounds, floorTo, nowSec } from '../core/time.js';

const BASE = 'https://api.sunsynk.net';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
let cachedToken = null;

// Connect login: per-request RSA key, MD5-signed nonce, RSA-encrypted password.
async function login(username, password) {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.token;
  const nonce = Date.now();
  const infix = `nonce=${nonce}&source=sunsynk`;
  const pk = await fetchJson(`${BASE}/anonymous/publicKey?nonce=${nonce}&source=sunsynk&sign=${md5(`${infix}POWER_VIEW`)}`);
  const publicKey = pk.json?.data;
  if (!publicKey) throw new Error('Sunsynk login: no public key');
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
  const encrypted = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString('base64');
  const { json } = await fetchJson(`${BASE}/oauth/token/new`, {
    method: 'POST',
    body: { sign: md5(`${infix}${publicKey.slice(0, 10)}`), nonce, source: 'sunsynk', username, password: encrypted, grant_type: 'password', client_id: 'csp-web' },
  });
  const token = json?.data?.access_token ?? json?.access_token;
  if (!token) throw new Error(`Sunsynk login failed: ${json?.msg || 'no token'}`);
  const ttl = (json?.data?.expires_in ?? json?.expires_in ?? 3600) * 1000;
  cachedToken = { token, until: Date.now() + ttl - 60000 };
  return token;
}

// Sunsynk returns errors inside HTTP 200 with a non-zero code.
async function api(token, pathAndQuery, siteId) {
  const url = `${BASE}/api${pathAndQuery}`;
  const { json } = await fetchJson(url, { headers: { authorization: `Bearer ${token}` } });
  if (json?.code !== 0) {
    quarantine({ source: 'sunsynk_5min', siteId, request: { url }, body: json, reason: `code ${json?.code}: ${json?.msg}` });
    throw new Error(`Sunsynk ${pathAndQuery.split('?')[0]}: code ${json?.code} ${json?.msg || ''}`);
  }
  return { json, url };
}

// ───────────── Normalisers (shared with the demo generator) ─────────────

const DAY_LABELS = { PV: 'solar', Battery: 'battery', SOC: 'soc', Load: 'load', Grid: 'grid' };

// Day series: "HH:mm" on the plant clock; battery positive = discharging; grid positive = import.
export function normaliseDay(siteId, tz, date, json, rawId) {
  const infos = json?.data?.infos;
  if (!Array.isArray(infos)) return { error: 'infos missing' };
  const [y, m, d] = date.split('-').map(Number);
  const out = { solar_w: [], load_w: [], grid_import_w: [], grid_export_w: [], battery_charge_w: [], battery_discharge_w: [], battery_soc_pct: [] };
  for (const info of infos) {
    const kind = DAY_LABELS[info.label];
    if (!kind) continue;                       // e.g. "Micro Inverter" is not modelled yet
    for (const rec of info.records || []) {
      const [hh, mm] = String(rec.time).split(':').map(Number);
      const ts = localToUtc(tz, y, m, d, hh, mm);
      const v = rec.value === null || rec.value === '' ? null : Number(rec.value);
      if (v === null || Number.isNaN(v)) continue;
      if (kind === 'solar') out.solar_w.push({ ts, value: Math.max(0, v) });
      if (kind === 'load') out.load_w.push({ ts, value: Math.max(0, v) });
      if (kind === 'soc') out.battery_soc_pct.push({ ts, value: v });
      if (kind === 'grid') { out.grid_import_w.push({ ts, value: Math.max(0, v) }); out.grid_export_w.push({ ts, value: Math.max(0, -v) }); }
      if (kind === 'battery') { out.battery_discharge_w.push({ ts, value: Math.max(0, v) }); out.battery_charge_w.push({ ts, value: Math.max(0, -v) }); }
    }
  }
  let n = 0;
  for (const [metric, rows] of Object.entries(out)) {
    if (rows.length) n += putReadings(seriesId('site', siteId, metric, 'sunsynk_5min'), rows, rawId);
  }
  return { facts: n };
}

const MONTH_LABELS = {
  'PV Generation': 'solar_kwh', 'Load Power Consumption': 'load_kwh', 'Purchased electricity': 'grid_import_kwh',
  'Sold electricity': 'grid_export_kwh', 'Charge Energy': 'battery_charge_kwh', 'Discharge Energy': 'battery_discharge_kwh',
};

// Month series: one total per plant-local day; the label carries the direction.
export function normaliseMonth(siteId, tz, json, rawId) {
  const infos = json?.data?.infos;
  if (!Array.isArray(infos)) return { error: 'infos missing' };
  let n = 0;
  for (const info of infos) {
    const metric = MONTH_LABELS[info.label];
    if (!metric) continue;
    const rows = (info.records || []).map((rec) => {
      const [a, b] = dayBounds(tz, rec.time);
      return { start: a, end: b, value: Number(rec.value) };
    }).filter((r) => !Number.isNaN(r.value));
    n += putIntervals(seriesId('site', siteId, metric, 'sunsynk_daily'), rows, rawId);
  }
  return { facts: n };
}

// Realtime flow has no timestamp: the contract stamps it with the fetch time floored to 5 minutes.
export function normaliseFlow(siteId, json, rawId) {
  const d = json?.data;
  if (!d) return { error: 'no data' };
  const ts = floorTo(nowSec(), 300);
  const pv = Array.isArray(d.pv) ? d.pv.reduce((s, x) => s + (Number(x.power) || 0), 0) : 0;
  const grid = Number(d.gridOrMeterPower) || 0;
  const batt = Number(d.battPower) || 0;
  const rows = {
    solar_w: pv, load_w: Math.max(0, Number(d.loadOrEpsPower) || 0),
    grid_import_w: Math.max(0, grid), grid_export_w: Math.max(0, -grid),
    battery_discharge_w: Math.max(0, batt), battery_charge_w: Math.max(0, -batt),
    battery_soc_pct: Number(d.soc) || 0, ev_w: Math.max(0, Number(d.chargePilePower) || 0),
  };
  let n = 0;
  for (const [metric, value] of Object.entries(rows)) n += putReadings(seriesId('site', siteId, metric, 'sunsynk_live'), [{ ts, value, quality: QUALITY.MEASURED }], rawId);
  return { facts: n };
}

// ───────────── Sync ─────────────

export async function syncSunsynk(site, { username, password, plantId: wanted }, dates) {
  const token = await login(username, password);
  const conn = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(site.id);
  let plantId = wanted || conn?.external_ref;
  if (!plantId || plantId !== conn?.external_ref) {
    // One login can see several plants (installers often share accounts), so the plant must be named.
    const list = await api(token, '/v1/plants?page=1&limit=50', site.id);
    landRaw({ source: 'sunsynk_live', siteId: site.id, request: { url: list.url }, body: list.json });
    const plants = list.json.data?.infos || [];
    const hit = wanted ? plants.find((p) => String(p.id) === String(wanted)) : plants.length === 1 ? plants[0] : null;
    if (!hit) {
      const names = plants.map((p) => `${p.id} "${String(p.name || '').trim()}"`).join(', ');
      throw new Error(wanted ? `Plant ${wanted} is not on this Sunsynk account (found ${names || 'none'})` : `Several plants on this account; set SUNSYNK_PLANT_ID to one of: ${names}`);
    }
    plantId = String(hit.id);
    db.prepare("UPDATE connection SET external_ref = ? WHERE site_id = ? AND provider = 'sunsynk'").run(plantId, site.id);
  }
  const plant = await api(token, `/v1/plant/${plantId}?id=${plantId}&lan=en`, site.id);
  landRaw({ source: 'sunsynk_live', siteId: site.id, request: { url: plant.url }, body: plant.json });
  const tz = plant.json.data?.timezone?.code || site.timezone;
  const kwp = Number(plant.json.data?.totalPower) || null;
  const lat = Number(plant.json.data?.lat) || null;
  const lon = Number(plant.json.data?.lon) || null;
  db.prepare('UPDATE site SET timezone = ?, pv_kwp = COALESCE(pv_kwp, ?), lat = COALESCE(lat, ?), lon = COALESCE(lon, ?) WHERE id = ?').run(tz, kwp, lat, lon, site.id);

  const out = { plantId, days: 0, months: 0, live: 0 };
  for (const date of dates) {
    const r = await api(token, `/v1/plant/energy/${plantId}/day?date=${date}&id=${plantId}&lan=en`, site.id);
    const { rawId } = landRaw({ source: 'sunsynk_5min', siteId: site.id, request: { url: r.url }, body: r.json });
    const res = normaliseDay(site.id, tz, date, r.json, rawId);
    if (res.error) quarantine({ source: 'sunsynk_5min', siteId: site.id, request: { url: r.url }, body: r.json, reason: res.error });
    else out.days += res.facts;
  }
  for (const month of [...new Set(dates.map((d) => d.slice(0, 7)))]) {
    const r = await api(token, `/v1/plant/energy/${plantId}/month?date=${month}&id=${plantId}&lan=en`, site.id);
    const { rawId } = landRaw({ source: 'sunsynk_daily', siteId: site.id, request: { url: r.url }, body: r.json });
    out.months += normaliseMonth(site.id, tz, r.json, rawId).facts || 0;
  }
  // Live flow and battery size from the first inverter.
  const inv = await api(token, `/v1/plant/${plantId}/inverters?page=1&limit=20&status=-1&type=-1`, site.id);
  const sn = inv.json.data?.infos?.[0]?.sn;
  if (sn) {
    const flow = await api(token, `/v1/inverter/${sn}/flow`, site.id);
    const { rawId } = landRaw({ source: 'sunsynk_live', siteId: site.id, request: { url: flow.url }, body: flow.json });
    out.live = normaliseFlow(site.id, flow.json, rawId).facts || 0;
    if (!site.battery_kwh) {
      try {
        const b = await api(token, `/v1/inverter/battery/${sn}/realtime?sn=${sn}&lan=en`, site.id);
        const ah = Number(b.json.data?.correctCap) || Number(b.json.data?.capacity) || 0;
        const volts = Number(b.json.data?.voltage) || 0;
        if (ah > 0 && volts > 0) db.prepare('UPDATE site SET battery_kwh = ? WHERE id = ?').run(Math.round((ah * volts) / 100) / 10, site.id);
      } catch { /* battery details are optional */ }
    }
  }
  return out;
}
