// Demo home: a simulated house with solar panels, a battery and an EV, priced
// on the real Agile Octopus and Outgoing Octopus tariffs for its region and lit
// by the real weather at its postcode.
//
// It writes payloads in each provider's own shape (Sunsynk day/month/flow,
// Octopus consumption, Kraken dispatches) and pushes them through the same
// normalisers as live data, so the build engine cannot tell it apart from a
// real home. Raw payloads are landed under the "demo" source, so lineage always
// shows where the numbers came from.
import { db } from '../db/db.js';
import { landRaw, seriesId, readIntervals, readForecastOfRecord } from '../core/facts.js';
import { normaliseDay, normaliseMonth, normaliseFlow } from './sunsynk.js';
import { normaliseConsumption, normaliseDispatches, normalisePlanned, upsertTariff, syncTariffRates } from './octopus.js';
import { loadPricing, priceAt } from '../core/pricing.js';
import { SLOT, nowSec, floorTo, localDate, dayBounds, daysBetween, addDays, zonedParts, offsetSeconds, isoUtc } from '../core/time.js';

const IMPORT_PRODUCT = 'AGILE-24-10-01';
const EXPORT_PRODUCT = 'OUTGOING-VAR-24-10-26';
const STEP = 300;
const H = STEP / 3600;
const EFF = 0.95;            // each way, so about 90% round trip
const RESERVE = 0.1;
const EV_KW = 7;

// Deterministic noise: the same instant always gives the same value, so a
// re-run produces identical payloads and the fact store skips them.
const rnd = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const bump = (h, centre, width) => Math.exp(-(((h - centre) / width) ** 2));

function ensureDevice(siteId, kind, ref, label) {
  db.prepare(
    `INSERT INTO device (site_id, kind, provider, external_ref, label, attrs) VALUES (?, ?, 'demo', ?, ?, '{}')
     ON CONFLICT(site_id, provider, external_ref) DO NOTHING`).run(siteId, kind, ref, label);
  return db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'demo' AND external_ref = ?").get(siteId, ref);
}

function ensureAgreement(siteId, device, tariff, from) {
  const existing = db.prepare('SELECT 1 FROM tariff_agreement WHERE device_id = ?').get(device.id);
  if (!existing) {
    db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to) VALUES (?, ?, ?, ?, NULL)')
      .run(siteId, device.id, tariff.id, from);
  }
}

function isoLocal(tz, ts) {
  const off = offsetSeconds(tz, ts);
  const body = new Date((ts + off) * 1000).toISOString().slice(0, 19);
  if (off === 0) return `${body}Z`;
  const sign = off > 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${body}${sign}${String(Math.floor(a / 3600)).padStart(2, '0')}:${String((a % 3600) / 60).padStart(2, '0')}`;
}

export async function syncDemo(site, initialDays) {
  const conn = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'demo'").get(site.id);
  const meta = JSON.parse(conn?.meta || '{}');
  const tz = site.timezone;
  const now = nowSec();
  const today = localDate(tz, now);
  if (!meta.firstDate) {
    meta.firstDate = addDays(today, -initialDays);
    db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'demo'").run(JSON.stringify(meta), site.id);
  }
  const [start] = dayBounds(tz, meta.firstDate);
  if (!site.gsp_region) throw new Error('Demo home needs a grid supply point region (postcode lookup failed)');

  // ── Meters, tariffs and the EV ──
  const imp = ensureDevice(site.id, 'meter_import', 'DEMO-IMPORT', 'Import meter (demo)');
  const exp = ensureDevice(site.id, 'meter_export', 'DEMO-EXPORT', 'Export meter (demo)');
  ensureDevice(site.id, 'ev', 'DEMO-EV', 'Electric car (demo)');
  const impTariff = upsertTariff({ tariffCode: `E-1R-${IMPORT_PRODUCT}-${site.gsp_region}`, direction: 'import', name: 'Agile Octopus' });
  const expTariff = upsertTariff({ tariffCode: `E-1R-${EXPORT_PRODUCT}-${site.gsp_region}`, direction: 'export', name: 'Outgoing Octopus' });
  ensureAgreement(site.id, imp, impTariff, start);
  ensureAgreement(site.id, exp, expTariff, start);

  // Real published prices (no credentials needed).
  const ratesFrom = meta.ratesThrough ? Math.min(meta.ratesThrough, now - 2 * 86400) : start - 86400;
  const rates = (await syncTariffRates(impTariff, ratesFrom, now + 2 * 86400, site.id))
    + (await syncTariffRates(expTariff, ratesFrom, now + 2 * 86400, site.id));
  meta.ratesThrough = now;
  db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'demo'").run(JSON.stringify(meta), site.id);

  // ── Inputs: price and sunlight at any instant ──
  const horizon = now + 2 * 86400;
  const pricing = loadPricing(site.id, start, horizon);
  const priceCache = new Map();
  const priceInc = (slot) => {
    if (!priceCache.has(slot)) {
      const p = priceAt(pricing, 'meter_import', slot);
      priceCache.set(slot, p?.unitEx != null ? p.unitEx * (1 + p.vat) : null);
    }
    return priceCache.get(slot);
  };
  const gtiS = seriesId('site', site.id, 'gti_wm2', 'open_meteo');
  const gti = new Map(readIntervals([gtiS], start - 3600, now + 3600).map((f) => [f.start_ts, f.value]));
  for (const f of readForecastOfRecord(gtiS, floorTo(now, 3600) - 3600, horizon, now + 60)) if (!gti.has(f.start_ts)) gti.set(f.start_ts, f.value);
  const kwp = site.pv_kwp || 5;
  const cap = site.battery_kwh || 10;
  const maxW = Math.min(3600, cap * 1000 * 0.5);

  // Sunlight on the panels, interpolated between hourly means; clear-sky shape if weather is missing.
  const sunAt = (ts) => {
    const h0 = floorTo(ts - 1800, 3600);
    const a = gti.get(h0); const b = gti.get(h0 + 3600);
    if (a != null && b != null) { const f = (ts - (h0 + 1800)) / 3600; return a + (b - a) * f; }
    if (a != null || b != null) return a ?? b;
    const { hh, mm } = zonedParts(tz, ts);
    const h = hh + mm / 60 - (offsetSeconds(tz, ts) / 3600);
    return Math.max(0, Math.sin(((h - 7) / 10) * Math.PI)) * 420 * (0.6 + 0.4 * rnd(Math.floor(ts / 3600)));
  };
  const solarW = (ts) => Math.min(kwp * 1000 * 0.92, Math.max(0, sunAt(ts) * kwp * 0.8 * (0.97 + 0.06 * rnd(ts + 5))));
  const solarKwhOfDay = (date) => {
    const [a, b] = dayBounds(tz, date);
    let s = 0; for (let t = a; t < b; t += 1800) s += solarW(t) * 0.5 / 1000;
    return s;
  };

  const dates = daysBetween(meta.firstDate, addDays(today, 1));
  const dayIndex = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

  // ── EV: plugged in on some evenings, smart-charged in the cheapest half-hours overnight ──
  const evKwh = new Map();
  for (const date of dates) {
    const n = dayIndex(date);
    if (rnd(n * 3 + 1) > 0.5) continue;
    const need = 9 + Math.round(rnd(n * 5 + 2) * 16);
    const [, dayEnd] = dayBounds(tz, date);
    const win = [];
    for (let t = dayEnd - 2 * 3600; t < dayEnd + 7 * 3600; t += SLOT) win.push(t);
    const priced = win.every((t) => priceInc(t) != null);
    const order = priced ? [...win].sort((x, y) => priceInc(x) - priceInc(y) || x - y) : win.slice(4);
    let left = need;
    for (const t of order) {
      if (left <= 0) break;
      const k = Math.min(EV_KW * 0.5, left);
      evKwh.set(t, k); left -= k;
    }
  }

  // ── Battery strategy: store solar; top up from the grid in the cheapest slots; cover the home otherwise ──
  const cheapLimit = new Map();
  for (const date of dates) {
    const [a, b] = dayBounds(tz, date);
    const prices = [];
    for (let t = a; t < b; t += SLOT) if (priceInc(t) != null) prices.push(priceInc(t));
    prices.sort((x, y) => x - y);
    cheapLimit.set(date, prices.length > 20 ? Math.min(prices[Math.floor(prices.length * 0.2)], 16) : null);
  }
  const targetFor = (date) => Math.min(0.95, Math.max(0.35, 0.95 - solarKwhOfDay(addDays(date, 1)) * 0.035));

  const loadW = (ts, date) => {
    const { hh, mm } = zonedParts(tz, ts);
    const h = hh + mm / 60;
    const n = dayIndex(date);
    let w = 170 + 35 * Math.sin(ts / 1700);
    w += bump(h, 7.4, 0.8) * 600 + bump(h, 12.8, 0.6) * 260 + bump(h, 18.6, 1.4) * 950 + bump(h, 21.6, 0.9) * 320;
    if (h > 6.5 && h < 23 && rnd(ts) < 0.022) w += 2600;                               // kettle
    if (h >= 17.5 && h < 18.25 && rnd(n * 7 + 1) < 0.7) w += 1700;                     // oven
    const wash = rnd(n * 13 + 3);
    if (wash < 0.5) { const s = wash < 0.25 ? 10 : 19; if (h >= s && h < s + 1.5) w += 850; } // washing machine
    return w * (0.95 + 0.1 * rnd(ts + 1));
  };

  // ── Simulate every 5 minutes from the first day to now ──
  let soc = cap * 0.5;
  const steps = [];
  const end = floorTo(now, STEP);
  for (let ts = start; ts <= end; ts += STEP) {
    const date = localDate(tz, ts);
    const slot = floorTo(ts, SLOT);
    const ev = (evKwh.get(slot) || 0) > 0 ? (evKwh.get(slot) / 0.5) * 1000 : 0;
    const solar = solarW(ts);
    const load = loadW(ts, date) + ev;
    const p = priceInc(slot);
    const limit = cheapLimit.get(date);
    const { hh } = zonedParts(tz, ts);
    const cheap = limit != null ? p != null && p <= limit : hh >= 1 && hh < 5;
    const room = Math.max(0, cap * 0.98 - soc);
    const avail = Math.max(0, soc - cap * RESERVE);
    let batt = 0;                                   // + discharging, - charging (Sunsynk convention)
    if (cheap && soc < cap * targetFor(date)) batt = -Math.min(maxW, (room / EFF / H) * 1000);
    else if (solar > load) batt = -Math.min(solar - load, maxW, (room / EFF / H) * 1000);
    else if (!cheap && ev === 0) batt = Math.min(load - solar, maxW, ((avail * EFF) / H) * 1000);
    if (batt < 0) soc += (-batt / 1000) * H * EFF; else soc -= (batt / 1000) * H / EFF;
    const grid = load - solar - batt;               // + import, - export
    steps.push({ ts, date, solar, load, batt, grid, soc: (soc / cap) * 100, ev });
  }

  // ── Land provider-shaped payloads ──
  const byDate = new Map();
  for (const s of steps) (byDate.get(s.date) || byDate.set(s.date, []).get(s.date)).push(s);
  const hhmm = (ts) => { const { hh, mm } = zonedParts(tz, ts); return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
  const rec = (rows, f) => rows.map((s) => ({ time: hhmm(s.ts), value: String(Math.round(f(s))) }));
  let facts = 0;
  const daily = [];
  for (const [date, rows] of byDate) {
    const body = {
      code: 0, msg: 'Success', success: true,
      data: { infos: [
        { unit: 'W', label: 'PV', records: rec(rows, (s) => s.solar) },
        { unit: 'W', label: 'Battery', records: rec(rows, (s) => s.batt) },
        { unit: '%', label: 'SOC', records: rec(rows, (s) => s.soc) },
        { unit: 'W', label: 'Load', records: rec(rows, (s) => s.load) },
        { unit: 'W', label: 'Grid', records: rec(rows, (s) => s.grid) },
      ] },
    };
    const { rawId } = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'sunsynk_5min', date }, body });
    facts += normaliseDay(site.id, tz, date, body, rawId).facts || 0;
    const kwh = (f) => rows.reduce((s, r) => s + Math.max(0, f(r)) * H / 1000, 0);
    // Inverter counters measure continuously, so they differ slightly from 5-minute samples.
    const drift = 1 + 0.03 * (rnd(dayIndex(date) * 11) - 0.5);
    daily.push({ date, pv: kwh((s) => s.solar) * drift, load: kwh((s) => s.load), buy: kwh((s) => s.grid), sell: kwh((s) => -s.grid), chg: kwh((s) => -s.batt), dis: kwh((s) => s.batt) });
  }
  for (const month of [...new Set(daily.map((d) => d.date.slice(0, 7)))]) {
    const ds = daily.filter((d) => d.date.startsWith(month));
    const series = (label, f) => ({ unit: 'kWh', label, records: ds.map((d) => ({ time: d.date, value: f(d).toFixed(1) })) });
    const body = { code: 0, msg: 'Success', success: true, data: { infos: [
      series('PV Generation', (d) => d.pv), series('Load Power Consumption', (d) => d.load),
      series('Purchased electricity', (d) => d.buy), series('Sold electricity', (d) => d.sell),
      series('Charge Energy', (d) => d.chg), series('Discharge Energy', (d) => d.dis),
    ] } };
    const { rawId } = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'sunsynk_daily', month }, body });
    facts += normaliseMonth(site.id, tz, body, rawId).facts || 0;
  }
  const last = steps[steps.length - 1];
  if (last) {
    const body = { code: 0, msg: 'Success', data: {
      pv: [{ power: Math.round(last.solar * 0.55) }, { power: Math.round(last.solar * 0.45) }],
      gridOrMeterPower: Math.round(last.grid), loadOrEpsPower: Math.round(last.load), battPower: Math.round(last.batt),
      soc: Math.round(last.soc), chargePilePower: Math.round(last.ev),
    } };
    const { rawId } = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'sunsynk_live', at: last.ts }, body });
    facts += normaliseFlow(site.id, body, rawId).facts || 0;
  }

  // Smart meter: half-hours up to last midnight (Octopus delivers about a day late).
  // The meter reads about 1% above the inverter's clamp, as real installs do.
  const [todayStart] = dayBounds(tz, today);
  const hh = new Map();
  for (const s of steps) {
    if (s.ts >= todayStart) break;
    const slot = floorTo(s.ts, SLOT);
    const v = hh.get(slot) || { imp: 0, exp: 0 };
    v.imp += Math.max(0, s.grid) * H / 1000; v.exp += Math.max(0, -s.grid) * H / 1000;
    hh.set(slot, v);
  }
  for (const [device, key, bias] of [[imp, 'imp', 1.012], [exp, 'exp', 0.992]]) {
    const results = [...hh.entries()].map(([slot, v]) => ({
      consumption: Number((v[key] * (bias + 0.01 * (rnd(slot + bias) - 0.5))).toFixed(3)),
      interval_start: isoLocal(tz, slot), interval_end: isoLocal(tz, slot + SLOT),
    }));
    const body = { count: results.length, next: null, previous: null, results };
    const { rawId } = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'octopus_meter', device: device.external_ref }, body });
    const metric = key === 'imp' ? 'grid_import_kwh' : 'grid_export_kwh';
    facts += normaliseConsumption(seriesId('device', device.id, metric, 'octopus_meter'), results, 1, rawId);
  }

  // EV sessions as Kraken dispatches: finished ones as completed, the rest as planned.
  const evSlots = [...evKwh.entries()].sort((a, b) => a[0] - b[0]);
  const blocks = [];
  for (const [t, k] of evSlots) {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.end === t) { prev.end = t + SLOT; prev.kwh += k; } else blocks.push({ start: t, end: t + SLOT, kwh: k });
  }
  const completed = blocks.filter((b) => b.end <= now).map((b) => ({ start: isoUtc(b.start).replace('Z', '+00:00'), end: isoUtc(b.end).replace('Z', '+00:00'), delta: (-b.kwh).toFixed(4), meta: { source: 'smart-charge', location: 'AT_HOME' } }));
  const planned = blocks.filter((b) => b.end > now && b.start < now + 86400).map((b) => ({ start: isoUtc(b.start), end: isoUtc(b.end), type: 'SMART', energyAddedKwh: Number(b.kwh.toFixed(2)) }));
  {
    const body = { data: { completedDispatches: completed } };
    const { rawId } = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'octopus_kraken', query: 'completedDispatches' }, body });
    facts += normaliseDispatches(site.id, completed, rawId);
    const pBody = { data: { flexPlannedDispatches: planned } };
    const p = landRaw({ source: 'demo', siteId: site.id, request: { imitates: 'octopus_kraken', query: 'flexPlannedDispatches', at: floorTo(now, 1800) }, body: pBody });
    if (!p.duplicate) facts += normalisePlanned(site.id, planned, now, p.rawId);
  }

  if (!site.pv_kwp || !site.battery_kwh) db.prepare('UPDATE site SET pv_kwp = ?, battery_kwh = ? WHERE id = ?').run(kwp, cap, site.id);
  return { facts, rates, days: byDate.size, firstDate: meta.firstDate };
}
