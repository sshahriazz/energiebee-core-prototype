// Sunsynk Connect adapter: login, plant selection, 5-minute series, daily totals and live flow.
//
// Note: Sunsynk's Terms of Use (1 Nov 2025) forbid automated scraping of the
// consumer app. This prototype uses the owner's own login at a low rate; a
// production system needs a partner key for the official API.
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine } from '../core/facts.js';
import { ingestObservations } from '../core/channels.js';
import { localToUtcAll, dayBounds, floorTo, nowSec } from '../core/time.js';
import { setAttribute } from '../core/attributes.js';

const BASE = 'https://api.sunsynk.net';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
// Tokens by login (a hash of username and password): every home has its own Sunsynk account, so one
// home's token is never used for another's, and a changed password is a new login.
const tokens = new Map();
const loginKey = (username, password) => crypto.createHash('sha256').update(`${username}\0${password}`).digest('hex');

// Connect login: per-request RSA key, MD5-signed nonce, RSA-encrypted password.
async function login(username, password) {
  const key = loginKey(username, password);
  const cached = tokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
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
  tokens.set(key, { token, until: Date.now() + ttl - 60000 });
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

// A login checked before it is stored (src/core/signup.js): signs in and lists the plants it sees,
// landing nothing. Returns the plant to use: the one asked for, or the only one; several and none
// asked for, or none at all, is an error naming them.
// The plants a Sunsynk login sees: [{ id, name, address }], for the user to pick theirs. Throws when
// the login is refused or sees none.
export async function listSunsynkPlants({ username, password }) {
  const token = await login(username, password);
  const { json } = await fetchJson(`${BASE}/api/v1/plants?page=1&limit=50`, { headers: { authorization: `Bearer ${token}` } });
  if (json?.code !== 0) throw new Error(`Sunsynk plants: code ${json?.code} ${json?.msg || ''}`.trim());
  const plants = (json.data?.infos || []).map((p) => ({ id: String(p.id), name: String(p.name || '').trim(), address: typeof p.address === 'string' ? p.address.trim() || null : null }));
  if (!plants.length) throw new Error('This Sunsynk login has no plant');
  return plants;
}

export async function checkSunsynkLogin({ username, password, plantId = null }) {
  const plants = await listSunsynkPlants({ username, password });
  const hit = plantId ? plants.find((p) => p.id === String(plantId)) : plants.length === 1 ? plants[0] : null;
  if (!hit) {
    const names = plants.map((p) => `${p.id} "${p.name}"`).join(', ');
    throw new Error(plantId ? `Plant ${plantId} is not on this Sunsynk login (found ${names})` : `This login sees several plants: pick yours (${names})`);
  }
  return { plantId: hit.id, plantName: hit.name, plants: plants.length };
}

// ───────────── Normalisers ─────────────

const DAY_LABELS = { PV: 'solar', Battery: 'battery', SOC: 'soc', Load: 'load', Grid: 'grid' };

// Day series: "HH:mm" on the plant clock; battery positive = discharging; grid positive = import.
// parseDay is pure: it returns the vendor's own points with their signed values (W, %). The sign split
// and the clamp to >= 0 are the channel rows (registry.js SOURCES sunsynk_5min channels).
export function parseDay(tz, date, json) {
  const infos = json?.data?.infos;
  if (!Array.isArray(infos)) return { error: 'infos missing' };
  const [y, m, d] = date.split('-').map(Number);
  const obs = [];
  for (const info of infos) {
    if (!DAY_LABELS[info.label]) continue;     // e.g. "Micro Inverter" is not modelled yet
    // Records come in time order on the plant's clock. When clocks go back, 01:00-01:59
    // appears twice: the first run is the earlier instant (BST), the repeat the later (GMT).
    // Each record takes the first instant after the previous record's.
    let prev = -Infinity;
    for (const rec of info.records || []) {
      const [hh, mm] = String(rec.time).split(':').map(Number);
      const ts = localToUtcAll(tz, y, m, d, hh, mm).find((t) => t > prev);
      if (ts == null) continue;                // a time that does not exist (clocks went forward) or out of order
      prev = ts;
      const v = rec.value === null || rec.value === '' ? null : Number(rec.value);
      if (v === null || Number.isNaN(v)) continue;
      obs.push({ point: info.label, ts, value: v });
    }
  }
  return { obs };
}

export function normaliseDay(siteId, tz, date, json, rawId) {
  const { obs, error } = parseDay(tz, date, json);
  if (error) return { error };
  return { facts: ingestObservations(siteId, 'sunsynk_5min', obs, rawId).written };
}

const MONTH_LABELS = ['PV Generation', 'Load Power Consumption', 'Purchased electricity', 'Sold electricity', 'Charge Energy', 'Discharge Energy'];

// Month series: one total per plant-local day; the label carries the direction.
export function parseMonth(tz, json) {
  const infos = json?.data?.infos;
  if (!Array.isArray(infos)) return { error: 'infos missing' };
  const obs = [];
  for (const info of infos) {
    if (!MONTH_LABELS.includes(info.label)) continue;
    for (const rec of info.records || []) {
      const [a, b] = dayBounds(tz, rec.time);
      const value = Number(rec.value);
      if (!Number.isNaN(value)) obs.push({ point: info.label, start: a, end: b, value });
    }
  }
  return { obs };
}

export function normaliseMonth(siteId, tz, json, rawId) {
  const { obs, error } = parseMonth(tz, json);
  if (error) return { error };
  return { facts: ingestObservations(siteId, 'sunsynk_daily', obs, rawId).written };
}

// Realtime flow has no timestamp: the contract stamps it with the fetch time floored to 5 minutes.
// A figure the plant did not send is absent, not 0.
export function parseFlow(json, at = nowSec()) {
  const d = json?.data;
  if (!d) return { error: 'no data' };
  const ts = floorTo(at, 300);
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const pv = Array.isArray(d.pv) ? d.pv.reduce((s, x) => s + (Number(x.power) || 0), 0) : null;
  const points = { pv_power: pv, load_power: num(d.loadOrEpsPower), grid_power: num(d.gridOrMeterPower), battery_power: num(d.battPower), soc: num(d.soc), ev_power: num(d.chargePilePower) };
  return { obs: Object.entries(points).filter(([, value]) => value !== null).map(([point, value]) => ({ point, ts, value })) };
}

export function normaliseFlow(siteId, json, rawId) {
  const { obs, error } = parseFlow(json);
  if (error) return { error };
  return { facts: ingestObservations(siteId, 'sunsynk_live', obs, rawId).written };
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
  db.prepare('UPDATE site SET timezone = ?, lat = COALESCE(lat, ?), lon = COALESCE(lon, ?) WHERE id = ?').run(tz, lat, lon, site.id);
  if (kwp) setAttribute(site.id, 'pv_kwp', kwp, 'provider', `Sunsynk plant ${plantId} record (totalPower)`);

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
        // Usable capacity = the battery's reported capacity (Ah) × its voltage at that moment.
        // The payload is kept and the inputs recorded, so the figure can be traced.
        const b = await api(token, `/v1/inverter/battery/${sn}/realtime?sn=${sn}&lan=en`, site.id);
        const { rawId } = landRaw({ source: 'sunsynk_live', siteId: site.id, request: { url: b.url }, body: b.json });
        const ah = Number(b.json.data?.correctCap) || Number(b.json.data?.capacity) || 0;
        const volts = Number(b.json.data?.voltage) || 0;
        if (ah > 0 && volts > 0) {
          const kwh = Math.round((ah * volts) / 100) / 10;
          setAttribute(site.id, 'battery_kwh', kwh, 'provider', `battery reading: ${ah} Ah × ${volts} V`);
          const meta = JSON.parse(conn?.meta || '{}');
          meta.batteryCapacity = { kwh, ah, volts, field: Number(b.json.data?.correctCap) ? 'correctCap' : 'capacity', rawId, at: nowSec() };
          db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'sunsynk'").run(JSON.stringify(meta), site.id);
        }
      } catch { /* battery details are optional */ }
    }
  }
  return out;
}
