// Octopus Energy adapter: account (meters and tariff agreements), half-hourly
// consumption, tariff rates (stored VAT-exclusive) and Kraken GraphQL
// (Intelligent Octopus dispatches and smart devices).
import { db, tx } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, seriesId, putIntervals, putForecasts, QUALITY } from '../core/facts.js';
import { isoUtc, nowSec, parseIso } from '../core/time.js';

const BASE = 'https://api.octopus.energy/v1';
const GQL = 'https://api.octopus.energy/v1/graphql/';
const auth = (key) => ({ authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` });

// Page through a list endpoint (rate endpoints cap pages at 1,500 rows whatever page_size says).
async function getAll(url, headers, source, siteId) {
  const out = [];
  let next = url;
  let pages = 0;
  while (next && pages < 40) {
    const { json } = await fetchJson(next, { headers });
    if (!json || !Array.isArray(json.results)) {
      quarantine({ source, siteId, request: { url: next }, body: json, reason: 'missing results array' });
      break;
    }
    const { rawId } = landRaw({ source, siteId, request: { url: next }, body: json });
    for (const r of json.results) out.push({ ...r, _rawId: rawId });
    next = json.next;
    pages++;
  }
  return out;
}

// ───────────── Tariff codes ─────────────

export function parseTariffCode(code) {
  const parts = code.split('-');
  const fuel = parts[0] === 'G' ? 'gas' : 'electricity';
  const registers = parts[1];
  const region = parts[parts.length - 1];
  const product = parts.slice(2, -1).join('-');
  let structure = 'flat';
  if (/^INTELLI/.test(product)) structure = 'iog';
  else if (registers === '2R') structure = 'e7';
  else if (/^AGILE/.test(product)) structure = 'agile';
  else if (/^(SILVER|TRACKER)/.test(product)) structure = 'tracker';
  else if (/^(GO|COSY|FLUX)/.test(product)) structure = 'tou';
  if (/OUTGOING|EXPORT/.test(product)) structure = /AGILE/.test(product) ? 'agile_export' : 'export';
  return { fuel, registers, region, product, structure };
}

export function upsertTariff({ provider = 'octopus', tariffCode, direction, name }) {
  const p = parseTariffCode(tariffCode);
  db.prepare(
    `INSERT INTO tariff (provider, product_code, tariff_code, fuel, direction, structure, region, name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tariff_code) DO UPDATE SET name = COALESCE(excluded.name, tariff.name)`)
    .run(provider, p.product, tariffCode, p.fuel, direction, p.structure, p.region, name ?? null);
  return db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(tariffCode);
}

// ───────────── Rates (bitemporal) ─────────────

const curRate = db.prepare(
  `SELECT id, valid_to, price_ex_vat FROM rate_interval
   WHERE tariff_id = ? AND component = ? AND register = ? AND payment_method = ? AND IFNULL(site_id, 0) = ?
     AND valid_from = ? AND superseded_at IS NULL`);
const supRate = db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?');
const overlapping = db.prepare(
  `SELECT id, valid_from, valid_to, price_ex_vat, raw_id FROM rate_interval
   WHERE superseded_at IS NULL AND tariff_id = ? AND component = ? AND register = ? AND payment_method = ?
     AND IFNULL(site_id, 0) = ? AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?`);
const insRate = db.prepare(
  `INSERT INTO rate_interval (tariff_id, site_id, component, register, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, raw_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// Store price rows. Identical rows are skipped; a changed row supersedes the
// old version, so the overlap trigger only ever sees one current row per period.
export function putRates(tariffId, component, register, rows, siteId = null) {
  const now = Date.now();
  let changed = 0;
  const sorted = [...rows].sort((a, b) => a.validFrom - b.validFrom);
  tx(() => {
    for (const r of sorted) {
      const pm = r.paymentMethod || 'ANY';
      const cur = curRate.get(tariffId, component, register, pm, siteId ?? 0, r.validFrom);
      if (cur && (cur.valid_to ?? null) === (r.validTo ?? null) && Math.abs(cur.price_ex_vat - r.priceExVat) < 1e-9) continue;
      if (cur) supRate.run(now, cur.id);
      // A row that now overlaps the new one was replaced upstream. Keep the
      // parts of it outside the new period, so no time is left without a price.
      for (const o of overlapping.all(tariffId, component, register, pm, siteId ?? 0, r.validTo ?? 9000000000, r.validFrom)) {
        supRate.run(now, o.id);
        if (o.valid_from < r.validFrom) insRate.run(tariffId, siteId, component, register, pm, o.valid_from, r.validFrom, o.price_ex_vat, now, o.raw_id);
        if (r.validTo != null && (o.valid_to == null || o.valid_to > r.validTo)) insRate.run(tariffId, siteId, component, register, pm, r.validTo, o.valid_to, o.price_ex_vat, now, o.raw_id);
      }
      insRate.run(tariffId, siteId, component, register, pm, r.validFrom, r.validTo ?? null, r.priceExVat, now, r.rawId ?? null);
      changed++;
    }
  });
  return changed;
}

export async function syncTariffRates(tariff, fromTs, toTs, siteId) {
  const fuelPath = tariff.fuel === 'gas' ? 'gas-tariffs' : 'electricity-tariffs';
  const base = `${BASE}/products/${tariff.product_code}/${fuelPath}/${tariff.tariff_code}`;
  const window = `period_from=${isoUtc(fromTs)}&period_to=${isoUtc(toTs)}&page_size=1500`;
  const toRows = (results) => results.map((r) => ({
    validFrom: parseIso(r.valid_from), validTo: r.valid_to ? parseIso(r.valid_to) : null,
    priceExVat: r.value_exc_vat, paymentMethod: r.payment_method || 'ANY', rawId: r._rawId,
  }));
  let n = 0;
  const reg = parseTariffCode(tariff.tariff_code).registers;
  let fetchedStandard = false;
  if (reg !== '2R') {
    const std = await getAll(`${base}/standard-unit-rates/?${window}`, {}, 'octopus_rates', siteId);
    n += putRates(tariff.id, 'unit', 'single', toRows(std));
    fetchedStandard = std.length > 0;
  }
  // Economy 7 and Intelligent Octopus Go publish day and night rates with no times.
  if (reg === '2R' || (tariff.structure === 'iog' && !fetchedStandard)) {
    for (const register of ['day', 'night']) {
      const rows = await getAll(`${base}/${register}-unit-rates/?${window}`, {}, 'octopus_rates', siteId);
      n += putRates(tariff.id, 'unit', register, toRows(rows));
    }
  }
  if (tariff.direction === 'import') {
    const sc = await getAll(`${base}/standing-charges/?${window}`, {}, 'octopus_rates', siteId);
    n += putRates(tariff.id, 'standing', 'single', toRows(sc));
  }
  return n;
}

// ───────────── Account, meters and agreements ─────────────

function upsertDevice(siteId, kind, ref, label, attrs) {
  db.prepare(
    `INSERT INTO device (site_id, kind, provider, external_ref, label, attrs) VALUES (?, ?, 'octopus', ?, ?, ?)
     ON CONFLICT(site_id, provider, external_ref) DO UPDATE SET kind = excluded.kind, label = excluded.label, attrs = excluded.attrs`)
    .run(siteId, kind, ref, label, JSON.stringify(attrs));
  return db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'octopus' AND external_ref = ?").get(siteId, ref);
}

// Agreements can overlap or be zero-width upstream; clip them into a clean, non-overlapping history.
function replaceAgreements(siteId, deviceId, agreements, direction) {
  const clean = agreements
    .map((a) => ({ code: a.tariff_code, from: parseIso(a.valid_from), to: a.valid_to ? parseIso(a.valid_to) : null }))
    .filter((a) => a.to === null || a.to > a.from)
    .sort((a, b) => a.from - b.from);
  for (let i = 0; i < clean.length - 1; i++) {
    if (clean[i].to === null || clean[i].to > clean[i + 1].from) clean[i].to = clean[i + 1].from;
  }
  const kept = clean.filter((a) => a.to === null || a.to > a.from);
  tx(() => {
    db.prepare('DELETE FROM tariff_agreement WHERE device_id = ?').run(deviceId);
    for (const a of kept) {
      const t = upsertTariff({ tariffCode: a.code, direction });
      db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)')
        .run(siteId, deviceId, t.id, a.from, a.to);
    }
  });
  return kept;
}

export async function syncOctopusAccount(site, { apiKey, accountNumber }) {
  const url = `${BASE}/accounts/${accountNumber}/`;
  const { json } = await fetchJson(url, { headers: auth(apiKey) });
  if (!json?.properties?.length) {
    quarantine({ source: 'octopus_meter', siteId: site.id, request: { url }, body: json, reason: 'no properties' });
    throw new Error('Octopus account has no properties');
  }
  landRaw({ source: 'octopus_meter', siteId: site.id, request: { url }, body: json });
  const prop = [...json.properties].sort((a, b) => (b.moved_in_at || '').localeCompare(a.moved_in_at || '')).find((p) => !p.moved_out_at) || json.properties[0];
  // The supply address is the best source for the home's postcode when none is configured.
  if (!site.postcode && prop.postcode) db.prepare('UPDATE site SET postcode = ? WHERE id = ?').run(prop.postcode, site.id);
  const meters = [];
  for (const mp of prop.electricity_meter_points || []) {
    const kind = mp.is_export ? 'meter_export' : 'meter_import';
    const dev = upsertDevice(site.id, kind, mp.mpan, mp.is_export ? 'Export meter' : 'Import meter', {
      serials: (mp.meters || []).map((m) => m.serial_number), profileClass: mp.profile_class, annualKwh: mp.consumption_standard,
    });
    replaceAgreements(site.id, dev.id, mp.agreements || [], mp.is_export ? 'export' : 'import');
    meters.push(dev);
  }
  for (const gp of prop.gas_meter_points || []) {
    const dev = upsertDevice(site.id, 'meter_gas', gp.mprn, 'Gas meter', {
      serials: (gp.meters || []).map((m) => m.serial_number), annualKwh: gp.consumption_standard,
    });
    replaceAgreements(site.id, dev.id, gp.agreements || [], 'import');
    meters.push(dev);
  }
  return meters;
}

// Gas arrives in m3 on newer (SMETS2) meters and kWh on older ones, with no unit field.
// Compare the yearly rate of what we received with the industry annual estimate.
function gasFactor(values, days, annualKwh) {
  const sum = values.reduce((s, v) => s + v, 0);
  if (!annualKwh || !sum || days < 3) return 11.2;    // default: assume m3 (most meters are SMETS2)
  const yearly = (sum / days) * 365;
  const ratio = annualKwh / yearly;
  return ratio > 5 && ratio < 25 ? 1.02264 * 39.5 / 3.6 : 1;
}

export async function syncOctopusConsumption(site, { apiKey }, fromTs, toTs) {
  const devices = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'octopus'").all(site.id);
  let n = 0;
  for (const dev of devices) {
    const attrs = JSON.parse(dev.attrs || '{}');
    const isGas = dev.kind === 'meter_gas';
    const metric = isGas ? 'gas_kwh' : dev.kind === 'meter_export' ? 'grid_export_kwh' : 'grid_import_kwh';
    const series = seriesId('device', dev.id, metric, 'octopus_meter');
    for (const serial of attrs.serials || []) {
      const path = isGas ? `gas-meter-points/${dev.external_ref}` : `electricity-meter-points/${dev.external_ref}`;
      const url = `${BASE}/${path}/meters/${serial}/consumption/?period_from=${isoUtc(fromTs)}&period_to=${isoUtc(toTs)}&page_size=25000&order_by=period`;
      const rows = await getAll(url, auth(apiKey), 'octopus_meter', site.id);
      if (!rows.length) continue;
      const factor = isGas ? gasFactor(rows.map((r) => r.consumption), (toTs - fromTs) / 86400, attrs.annualKwh) : 1;
      n += normaliseConsumption(series, rows, factor, rows[0]._rawId);
    }
  }
  return n;
}

// Half-hour meter rows. interval_start carries the local offset (+01:00 in
// summer); Date.parse converts it to UTC. Exported for the demo generator.
export function normaliseConsumption(series, rows, factor, rawId) {
  return putIntervals(series, rows.map((r) => ({
    start: parseIso(r.interval_start), end: parseIso(r.interval_end), value: r.consumption * factor, quality: QUALITY.MEASURED, rawId: r._rawId,
  })), rawId);
}

// Completed smart-charge dispatches. delta is negative for import; stored as a positive charge.
export function normaliseDispatches(siteId, list, rawId) {
  const evSeries = seriesId('site', siteId, 'ev_charge_kwh', 'octopus_kraken');
  return putIntervals(evSeries, (list || [])
    .map((d) => ({ start: parseIso(String(d.start).replace(' ', 'T')), end: parseIso(String(d.end).replace(' ', 'T')), value: d.delta == null ? null : Math.abs(Number(d.delta)) }))
    .filter((d) => d.end > d.start), rawId);
}

export function normalisePlanned(siteId, list, issuedAt, rawId) {
  const evSeries = seriesId('site', siteId, 'ev_charge_kwh', 'octopus_kraken');
  return putForecasts(evSeries, issuedAt, (list || [])
    .map((p) => ({ start: parseIso(p.start), end: parseIso(p.end), value: p.energyAddedKwh == null ? null : Number(p.energyAddedKwh) }))
    .filter((p) => p.end > p.start), rawId);
}

// ───────────── Kraken GraphQL ─────────────

async function gql(token, query, variables, siteId, { land = true } = {}) {
  const { json } = await fetchJson(GQL, { method: 'POST', headers: token ? { authorization: `JWT ${token}` } : {}, body: { query, variables } });
  if (json?.errors?.length) {
    // Kraken returns errors inside an HTTP 200 response.
    quarantine({ source: 'octopus_kraken', siteId, request: { query: query.slice(0, 80) }, body: json, reason: json.errors[0].message });
    throw new Error(`Kraken: ${json.errors[0].message}`);
  }
  const rawId = land ? landRaw({ source: 'octopus_kraken', siteId, request: { query: query.slice(0, 120), variables: { ...variables, key: undefined } }, body: json }).rawId : null;
  return { ...json.data, _rawId: rawId };
}

export async function syncKraken(site, { apiKey, accountNumber }) {
  const tokenData = await gql(null, 'mutation($key:String!){obtainKrakenToken(input:{APIKey:$key}){token}}', { key: apiKey }, site.id, { land: false });  // never store the token
  const token = tokenData?.obtainKrakenToken?.token;
  if (!token) throw new Error('No Kraken token');
  const out = { dispatches: 0, planned: 0, devices: 0 };

  const completed = await gql(token, 'query($a:String!){completedDispatches(accountNumber:$a){start end delta meta{source location}}}', { a: accountNumber }, site.id);
  out.dispatches = normaliseDispatches(site.id, completed?.completedDispatches, completed?._rawId);

  try {
    const devs = await gql(token, 'query($a:String!){devices(accountNumber:$a){id name deviceType status{current currentState isSuspended}}}', { a: accountNumber }, site.id);
    for (const d of devs?.devices || []) {
      if (d.deviceType !== 'ELECTRIC_VEHICLES') continue;
      db.prepare(
        `INSERT INTO device (site_id, kind, provider, external_ref, label, attrs) VALUES (?, 'ev', 'octopus_kraken', ?, ?, ?)
         ON CONFLICT(site_id, provider, external_ref) DO UPDATE SET label = excluded.label, attrs = excluded.attrs`)
        .run(site.id, d.id, d.name || 'Electric vehicle', JSON.stringify({ status: d.status }));
      out.devices++;
      const planned = await gql(token, 'query($d:String!){flexPlannedDispatches(deviceId:$d){start end type energyAddedKwh}}', { d: d.id }, site.id);
      out.planned += normalisePlanned(site.id, planned?.flexPlannedDispatches, nowSec(), planned?._rawId);
    }
  } catch (err) {
    out.devicesError = err.message;
  }
  return out;
}
