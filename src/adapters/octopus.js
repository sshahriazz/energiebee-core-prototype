// Octopus Energy adapter: account (meters and tariff agreements), half-hourly
// consumption, tariff rates (stored VAT-exclusive) and Kraken GraphQL
// (Intelligent Octopus dispatches and smart devices).
import { db, tx } from '../db/db.js';
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine, QUALITY } from '../core/facts.js';
import { ingestObservations, setDeviceChannel } from '../core/channels.js';
import { setDeviceAttrs, supersedeAgreements } from '../core/devices.js';
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
  if (/^(INTELLI|IOG)/.test(product)) structure = 'iog';
  else if (registers === '2R') structure = 'e7';
  else if (/^AGILE/.test(product)) structure = 'agile';
  else if (/^(SILVER|TRACKER)/.test(product)) structure = 'tracker';
  else if (/^(GO|COSY|FLUX)/.test(product)) structure = 'tou';
  if (/OUTGOING|EXPORT/.test(product)) structure = /AGILE/.test(product) ? 'agile_export' : 'export';
  return { fuel, registers, region, product, structure };
}

// What a tariff structure is in the words of the adapter contract (tariff.kind, delta 004) and its
// own price grain (tariff.native_period_s, delta 003): Agile prices every half-hour, a tracker once
// a day; flat, day/night, Go-style windows and Intelligent Octopus are static (NULL).
const KIND_OF = { flat: 'flat', export: 'flat', tou: 'tou', e7: 'tou', agile: 'dynamic', agile_export: 'dynamic', tracker: 'dynamic', iog: 'dispatch' };
const PERIOD_OF = { agile: 1800, agile_export: 1800, tracker: 86400 };
export const tariffKindOf = (structure) => KIND_OF[structure] ?? null;
export const nativePeriodOf = (structure) => PERIOD_OF[structure] ?? null;

// Every Octopus tariff is a GB tariff in pounds, fetched from the provider (origin 'provider').
// A row stored before these columns were written gets them filled in, never overwritten.
export function upsertTariff({ provider = 'octopus', tariffCode, direction, name }) {
  const p = parseTariffCode(tariffCode);
  db.prepare(
    `INSERT INTO tariff (provider, product_code, tariff_code, fuel, direction, structure, region, name, currency, country, kind, native_period_s, origin, origin_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'GBP', 'GB', ?, ?, 'provider', ?)
     ON CONFLICT(tariff_code) DO UPDATE SET name = COALESCE(excluded.name, tariff.name), currency = COALESCE(tariff.currency, excluded.currency),
       country = COALESCE(tariff.country, excluded.country), kind = COALESCE(tariff.kind, excluded.kind),
       native_period_s = COALESCE(tariff.native_period_s, excluded.native_period_s), origin = COALESCE(tariff.origin, excluded.origin),
       origin_note = COALESCE(tariff.origin_note, excluded.origin_note)`)
    .run(provider, p.product, tariffCode, p.fuel, direction, p.structure, p.region, name ?? null, tariffKindOf(p.structure), nativePeriodOf(p.structure),
      `Octopus public API: products/${p.product}/${p.fuel === 'gas' ? 'gas' : 'electricity'}-tariffs/${tariffCode}`);
  return db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(tariffCode);
}

// ───────────── Rates (bitemporal) ─────────────

const curRate = db.prepare(
  `SELECT id, valid_to, price_ex_vat, raw_id FROM rate_interval
   WHERE tariff_id = ? AND component = ? AND register = ? AND payment_method = ? AND IFNULL(site_id, 0) = ?
     AND valid_from = ? AND superseded_at IS NULL`);
const supRate = db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?');
const overlapping = db.prepare(
  `SELECT id, valid_from, valid_to, price_ex_vat, raw_id FROM rate_interval
   WHERE superseded_at IS NULL AND tariff_id = ? AND component = ? AND register = ? AND payment_method = ?
     AND IFNULL(site_id, 0) = ? AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?`);
// Rate rows from Octopus are provider data (origin 'provider'); raw_id links each to its payload.
const insRate = db.prepare(
  `INSERT INTO rate_interval (tariff_id, site_id, component, register, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, raw_id, origin)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider')`);

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
      if (cur) {
        supRate.run(now, cur.id);
        // Same start, earlier end: the rest of the old period keeps its old price.
        if (r.validTo != null && (cur.valid_to == null || cur.valid_to > r.validTo)) insRate.run(tariffId, siteId, component, register, pm, r.validTo, cur.valid_to, cur.price_ex_vat, now, cur.raw_id);
      }
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

function upsertDevice(siteId, kind, ref, label, fresh) {
  // Keep what the core learned about the device (e.g. the gas unit) when the account is re-read.
  const old = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND provider = 'octopus' AND external_ref = ?").get(siteId, ref);
  const attrs = { ...JSON.parse(old?.attrs || '{}'), ...fresh };
  db.prepare(
    `INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, ?, 'octopus', ?, ?, '{}', ?)
     ON CONFLICT(site_id, provider, external_ref) DO UPDATE SET kind = excluded.kind, label = excluded.label, retired_at = NULL`)
    .run(siteId, kind, ref, label, Date.now());
  const dev = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'octopus' AND external_ref = ?").get(siteId, ref);
  setDeviceAttrs(dev.id, attrs);
  return { ...dev, attrs: JSON.stringify(attrs) };
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
  // Unchanged history is left alone (no delete and re-insert on every sync).
  const current = db.prepare('SELECT t.tariff_code AS code, a.valid_from AS "from", a.valid_to AS "to" FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id WHERE a.device_id = ? AND a.superseded_at IS NULL ORDER BY a.valid_from').all(deviceId);
  const key = (list) => list.map((a) => `${a.code}|${a.from}|${a.to ?? ''}`).join(',');
  if (key(current) === key(kept)) return { kept, changed: false };
  // The previous history is superseded, not deleted, so earlier moments can still be priced as they were.
  supersedeAgreements(siteId, deviceId, kept.map((a) => ({ tariffId: upsertTariff({ tariffCode: a.code, direction }).id, from: a.from, to: a.to })));
  return { kept, changed: true };
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
  let agreementsChanged = false;
  const meters = [];
  for (const mp of prop.electricity_meter_points || []) {
    const kind = mp.is_export ? 'meter_export' : 'meter_import';
    const dev = upsertDevice(site.id, kind, mp.mpan, mp.is_export ? 'Export meter' : 'Import meter', {
      serials: (mp.meters || []).map((m) => m.serial_number), profileClass: mp.profile_class, annualKwh: mp.consumption_standard,
    });
    if (replaceAgreements(site.id, dev.id, mp.agreements || [], mp.is_export ? 'export' : 'import').changed) agreementsChanged = true;
    meters.push(dev);
  }
  for (const gp of prop.gas_meter_points || []) {
    const dev = upsertDevice(site.id, 'meter_gas', gp.mprn, 'Gas meter', {
      serials: (gp.meters || []).map((m) => m.serial_number), annualKwh: gp.consumption_standard,
    });
    if (replaceAgreements(site.id, dev.id, gp.agreements || [], 'import').changed) agreementsChanged = true;
    meters.push(dev);
  }
  meters.agreementsChanged = agreementsChanged;
  return meters;
}

// Gas arrives in m3 on some meters and kWh on others, with no unit field in the
// readings. Octopus states the unit per meter in Kraken (syncGasUnits), which is
// the source used. Only if Kraken gives none is it inferred from the readings:
// 1. A half-hour above 2.5 can only be kWh (as m3 it would exceed any home boiler).
// 2. Otherwise compare the yearly rate with the meter's annual estimate (kWh):
//    m3 sits near 1/11 of it; kWh near 1. Without data, the unit stays unknown.
// Readings are stored exactly as delivered; m3 is converted to kWh in the build
// with National Gas's published calorific value for each gas day.
function gasUnit(values, days, annualKwh) {
  const max = Math.max(0, ...values);
  if (max > 2.5) return { unit: 'kWh', reason: `largest half-hour ${max.toFixed(2)}; as m3 it would exceed any home boiler`, source: 'readings' };
  const sum = values.reduce((s, v) => s + v, 0);
  if (!annualKwh || !sum || days < 3) return null;
  const ratio = annualKwh / ((sum / days) * 365);
  return { unit: ratio > 6 ? 'm3' : 'kWh', reason: `yearly rate is 1/${ratio.toFixed(1)} of the ${annualKwh} kWh estimate`, source: 'readings' };
}

export async function syncOctopusConsumption(site, { apiKey }, fromTs, toTs, { gasFrom } = {}) {
  const devices = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'octopus'").all(site.id);
  let n = 0;
  for (const dev of devices) {
    const attrs = JSON.parse(dev.attrs || '{}');
    const isGas = dev.kind === 'meter_gas';
    const from = isGas && gasFrom != null ? Math.min(gasFrom, fromTs) : fromTs;
    for (const serial of attrs.serials || []) {
      const path = isGas ? `gas-meter-points/${dev.external_ref}` : `electricity-meter-points/${dev.external_ref}`;
      const url = `${BASE}/${path}/meters/${serial}/consumption/?period_from=${isoUtc(from)}&period_to=${isoUtc(toTs)}&page_size=25000&order_by=period`;
      const rows = await getAll(url, auth(apiKey), 'octopus_meter', site.id);
      if (!rows.length) continue;
      let metric = dev.kind === 'meter_export' ? 'grid_export_kwh' : 'grid_import_kwh';
      if (isGas) {
        // Decide once on a good sample, then keep it so the unit never flips between syncs.
        const u = attrs.gasUnit || gasUnit(rows.map((r) => r.consumption), (toTs - from) / 86400, attrs.annualKwh);
        if (!u) continue;   // unit unknown: not stored rather than guessed
        if (!attrs.gasUnit && rows.length >= 96) {
          attrs.gasUnit = u;
          setDeviceAttrs(dev.id, attrs);
        }
        metric = u.unit === 'm3' ? 'gas_m3' : 'gas_kwh';
      }
      n += normaliseConsumption(site.id, dev.id, metric, rows, rows[0]._rawId);
    }
  }
  return n;
}

// Half-hour meter rows. interval_start carries the local offset (+01:00 in
// summer); Date.parse converts it to UTC.
// The meter's one point, 'consumption', becomes the metric its kind (and, for gas, its unit) says; the
// device channel records that choice, and the write goes through the same channel path as every vendor.
export function normaliseConsumption(siteId, deviceId, metric, rows, rawId) {
  setDeviceChannel(siteId, 'octopus_meter', deviceId, 'consumption', metric);
  const obs = rows.map((r) => ({ point: 'consumption', start: parseIso(r.interval_start), end: parseIso(r.interval_end), value: r.consumption, quality: QUALITY.MEASURED, rawId: r._rawId }));
  return ingestObservations(siteId, 'octopus_meter', obs, rawId, { deviceId }).written;
}

// Completed smart-charge dispatches. delta is negative for import; the channel (part abs) stores the amount charged.
export function normaliseDispatches(siteId, list, rawId) {
  const obs = (list || [])
    .map((d) => ({ point: 'dispatch', start: parseIso(String(d.start).replace(' ', 'T')), end: parseIso(String(d.end).replace(' ', 'T')), value: d.delta == null ? null : Number(d.delta) }))
    .filter((d) => d.end > d.start);
  return ingestObservations(siteId, 'octopus_kraken', obs, rawId).written;
}

// Planned dispatches: a forecast issue made at issuedAt.
export function normalisePlanned(siteId, list, issuedAt, rawId) {
  const obs = (list || [])
    .map((p) => ({ point: 'planned', start: parseIso(p.start), end: parseIso(p.end), issuedAt, value: p.energyAddedKwh == null ? null : Number(p.energyAddedKwh) }))
    .filter((p) => p.end > p.start);
  return ingestObservations(siteId, 'octopus_kraken', obs, rawId).forecasts;
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

// Octopus states each gas meter's units in Kraken (m³ on SMETS2, kWh on SMETS1).
// That is the source of truth; the guess in gasUnit() is only a fallback.
// Returns true when the unit changed, so the caller can re-read the gas history.
export async function syncGasUnits(site, { apiKey, accountNumber }) {
  const gasDevices = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'octopus' AND kind = 'meter_gas'").all(site.id);
  if (!gasDevices.length) return { changed: false };
  const tokenData = await gql(null, 'mutation($key:String!){obtainKrakenToken(input:{APIKey:$key}){token}}', { key: apiKey }, site.id, { land: false });
  const token = tokenData?.obtainKrakenToken?.token;
  // The meter's local distribution zone (LDZ) picks National Gas's calorific value series.
  const data = await gql(token, 'query($a:String!){account(accountNumber:$a){properties{gasMeterPoints{mprn ldz exitZone meters{serialNumber consumptionUnits}}}}}', { a: accountNumber }, site.id);
  let changed = false;
  for (const p of data?.account?.properties || []) {
    for (const gp of p.gasMeterPoints || []) {
      const dev = gasDevices.find((d) => d.external_ref === gp.mprn);
      const units = (gp.meters || []).map((m) => m.consumptionUnits).find(Boolean);
      if (!dev || !units) continue;
      const isM3 = /m/.test(units) && !/kwh/i.test(units);
      const attrs = JSON.parse(dev.attrs || '{}');
      const unit = { unit: isM3 ? 'm3' : 'kWh', reason: `Octopus reports ${units} for this meter`, source: 'octopus_kraken' };
      if (!attrs.gasUnit || attrs.gasUnit.unit !== unit.unit || attrs.gasUnit.source !== 'octopus_kraken' || 'factor' in attrs.gasUnit || attrs.ldz !== gp.ldz) {
        changed = changed || !attrs.gasUnit || attrs.gasUnit.unit !== unit.unit || 'factor' in attrs.gasUnit;
        attrs.gasUnit = unit;
        attrs.ldz = gp.ldz ?? null;
        attrs.exitZone = gp.exitZone ?? null;
        setDeviceAttrs(dev.id, attrs);
      }
    }
  }
  return { changed };
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
        `INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'ev', 'octopus_kraken', ?, ?, '{}', ?)
         ON CONFLICT(site_id, provider, external_ref) DO UPDATE SET label = excluded.label, retired_at = NULL`)
        .run(site.id, d.id, d.name || 'Electric vehicle', Date.now());
      setDeviceAttrs(db.prepare("SELECT id FROM device WHERE site_id = ? AND provider = 'octopus_kraken' AND external_ref = ?").get(site.id, d.id).id, { status: d.status });
      out.devices++;
      const planned = await gql(token, 'query($d:String!){flexPlannedDispatches(deviceId:$d){start end type energyAddedKwh}}', { d: d.id }, site.id);
      out.planned += normalisePlanned(site.id, planned?.flexPlannedDispatches, nowSec(), planned?._rawId);
    }
  } catch (err) {
    out.devicesError = err.message;
  }
  return out;
}
