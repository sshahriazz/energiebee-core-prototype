// Sync job: for each home, call the adapters in dependency order, then rebuild
// whatever changed. Each step fails on its own; one provider being down never
// stops the others, and the failure is recorded on the connection.
import { db } from '../db/db.js';
import { markDirty, seriesId, putForecasts } from '../core/facts.js';
import { processQueue } from '../core/build.js';
import { forecastSite } from '../core/forecast.js';
import { SLOT, nowSec, localDate, addDays, dayBounds, daysBetween } from '../core/time.js';
import { resolveSiteGeo } from '../adapters/geo.js';
import { syncCarbon } from '../adapters/carbon.js';
import { syncWeather } from '../adapters/openmeteo.js';
import { syncQuartz } from '../adapters/quartz.js';
import { syncSunsynk } from '../adapters/sunsynk.js';
import { syncOctopusAccount, syncOctopusConsumption, syncTariffRates, syncKraken, upsertTariff, syncGasUnits } from '../adapters/octopus.js';
import { learnIogWindow } from '../core/pricing.js';
import { syncComparison } from '../core/compare.js';
import { syncGasCv } from '../adapters/nationalgas.js';
import { measureBatteryCapacity } from '../core/derive.js';
import { setAttribute, withdrawAttribute } from '../core/attributes.js';
import { seedSiteAttributes } from '../core/maintenance.js';
import { retireDevice, supersedeAgreements } from '../core/devices.js';

const env = process.env;
const INITIAL_DAYS = Math.min(Number(env.INITIAL_DAYS) || 14, 60);
const running = new Set();

function setConnection(siteId, provider, ok, error) {
  db.prepare(
    `UPDATE connection SET status = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ?
     WHERE site_id = ? AND provider = ?`).run(ok ? 'ok' : 'error', ok ? 1 : 0, nowSec(), ok ? null : String(error).slice(0, 300), siteId, provider);
}

function ensureConnection(siteId, provider, externalRef = null) {
  db.prepare('INSERT INTO connection (site_id, provider, external_ref) VALUES (?, ?, ?) ON CONFLICT(site_id, provider) DO NOTHING')
    .run(siteId, provider, externalRef);
}

// The home configured in .env, created once and kept in step with the file.
export function ensureEnvSite() {
  const hasSunsynk = !!(env.SUNSYNK_USERNAME && env.SUNSYNK_PASSWORD);
  const hasOctopus = !!(env.OCTOPUS_API_KEY && env.OCTOPUS_ACCOUNT_NUMBER);
  if (!hasSunsynk && !hasOctopus) return null;
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  let site = db.prepare("SELECT * FROM site WHERE env_key = 'env'").get();
  if (!site) {
    db.prepare("INSERT INTO site (name, postcode, env_key, created_at) VALUES (?, ?, 'env', ?)").run(env.SITE_NAME || 'My home', env.SITE_POSTCODE || null, nowSec());
    site = db.prepare("SELECT * FROM site WHERE env_key = 'env'").get();
  } else {
    db.prepare('UPDATE site SET name = ?, postcode = COALESCE(?, postcode) WHERE id = ?').run(env.SITE_NAME || site.name, env.SITE_POSTCODE || null, site.id);
  }
  seedSiteAttributes(site.id);   // first versions for databases created before details were versioned
  // System details from .env are the installer's figures. A tilt or direction equal to the
  // estimate recorded on the Sunsynk connection is that estimate, so it is labelled as one.
  const est = JSON.parse(db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(site.id)?.meta || '{}').panelAnglesEstimate;
  for (const [attr, key, estKey] of [['pv_kwp', 'PV_KWP'], ['pv_tilt', 'PV_TILT', 'tilt'], ['pv_orientation', 'PV_ORIENTATION', 'bearing'], ['battery_kwh', 'BATTERY_KWH']]) {
    const v = num(env[key]);
    if (v == null) { withdrawAttribute(site.id, attr, 'installer'); continue; }
    const isEstimate = estKey && est && est[estKey] === v;
    setAttribute(site.id, attr, v, isEstimate ? 'estimated' : 'installer', isEstimate ? `estimated from this home's output (best fit R² ${est.r2}), via .env ${key}` : `.env ${key}`);
    if (isEstimate) withdrawAttribute(site.id, attr, 'installer');
  }
  if (hasSunsynk) ensureConnection(site.id, 'sunsynk');
  if (hasOctopus) ensureConnection(site.id, 'octopus', env.OCTOPUS_ACCOUNT_NUMBER);
  if (env.IMPORT_TARIFF_CODE || env.EXPORT_TARIFF_CODE) ensureConnection(site.id, 'tariff');
  for (const p of ['weather', 'carbon', 'solar_forecast', 'compare']) ensureConnection(site.id, p);
  return site.id;
}

// Tariff codes from .env price the home when its Octopus account cannot be read.
// Tariff rates are public, so costs work from the inverter's grid clamp alone.
// As soon as the account syncs, its own meters and agreements replace these.
async function syncEnvTariffs(site, fromTs) {
  if (db.prepare("SELECT 1 FROM device WHERE site_id = ? AND provider = 'octopus' AND retired_at IS NULL").get(site.id)) {
    // Retired, not deleted: the .env tariffs still priced the half-hours before the account was read.
    for (const d of db.prepare("SELECT id FROM device WHERE site_id = ? AND provider = 'env' AND retired_at IS NULL").all(site.id)) retireDevice(d.id);
    return { skipped: 'using Octopus account agreements' };
  }
  let rates = 0;
  const used = [];
  for (const [kind, code, direction] of [['meter_import', env.IMPORT_TARIFF_CODE, 'import'], ['meter_export', env.EXPORT_TARIFF_CODE, 'export']]) {
    if (!code) continue;
    db.prepare(`INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, ?, 'env', ?, ?, '{}', ?)
                ON CONFLICT(site_id, provider, external_ref) DO UPDATE SET retired_at = NULL`).run(site.id, kind, kind, `${direction === 'import' ? 'Import' : 'Export'} tariff (.env)`, Date.now());
    const dev = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'env' AND external_ref = ?").get(site.id, kind);
    const tariff = upsertTariff({ tariffCode: code, direction });
    const current = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').get(dev.id);
    if (!current || current.tariff_id !== tariff.id || current.valid_from > fromTs) {
      supersedeAgreements(site.id, dev.id, [{ tariffId: tariff.id, from: Math.min(fromTs, current?.valid_from ?? fromTs), to: null }]);
    }
    rates += await syncTariffRates(tariff, fromTs - 86400, nowSec() + 2 * 86400, site.id);
    used.push(code);
  }
  return { tariffs: used, rates };
}

// Our own forecast is stored as an issue like any provider's, so it can later be
// scored against what the home actually did. Once an hour is enough to score it.
function recordForecast(siteId) {
  const now = nowSec();
  const homeS = seriesId('site', siteId, 'load_kwh', 'core_forecast');
  const last = db.prepare('SELECT MAX(issued_at) AS t FROM forecast_fact WHERE series_id = ?').get(homeS)?.t;
  if (last != null && now - last < 3600) return { skipped: 'issued within the last hour' };
  const fc = forecastSite(siteId, 48);
  const rows = (k) => fc.slots.filter((s) => s[k] != null).map((s) => ({ start: s.slot_start, end: s.slot_start + SLOT, value: s[k] }));
  const forecasts = putForecasts(homeS, now, rows('home'))
    + putForecasts(seriesId('site', siteId, 'grid_import_kwh', 'core_forecast'), now, rows('grid_import'))
    // Solar too, so the build can show what was forecast for each half-hour before it happened.
    + putForecasts(seriesId('site', siteId, 'solar_kwh', 'core_forecast'), now, rows('solar'));
  return { forecasts };
}

// Earliest time touched by facts recorded since `sinceMs`: this home's readings and
// intervals (its own, its meters' and its regions'), and prices of its tariffs.
function earliestChange(siteId, site, sinceMs) {
  const gas = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId).map((d) => JSON.parse(d.attrs || '{}').ldz).find(Boolean);
  const regions = [site.carbon_region != null ? `carbon:${site.carbon_region}` : null, gas ? `ldz:${gas}` : null].filter(Boolean);
  const ours = `(se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))
    ${regions.length ? `OR (se.subject_kind = 'region' AND se.subject_id IN (${regions.map(() => '?').join(',')}))` : ''}`;
  const args = [String(siteId), siteId, ...regions];
  const r = db.prepare(`SELECT MIN(r.ts) AS t FROM reading r JOIN series se ON se.id = r.series_id WHERE r.recorded_at >= ? AND (${ours})`).get(sinceMs, ...args)?.t;
  const f = db.prepare(`SELECT MIN(f.start_ts) AS t FROM interval_fact f JOIN series se ON se.id = f.series_id WHERE f.recorded_at >= ? AND (${ours})`).get(sinceMs, ...args)?.t;
  const p = db.prepare(`SELECT MIN(r.valid_from) AS t FROM rate_interval r WHERE r.recorded_at >= ? AND r.tariff_id IN (SELECT tariff_id FROM tariff_agreement WHERE site_id = ? AND superseded_at IS NULL)`).get(sinceMs, siteId)?.t;
  const ts = [r, f, p].filter((v) => v != null);
  return ts.length ? Math.min(...ts) : null;
}

// First local date a provider's fetch must cover. Normally a short look-back (`normalDate`).
// After an outage of the server or the provider, it reaches back to that provider's last
// successful sync, less `overlapDays` for data that arrives late or is revised, so the gap
// is filled on the next good sync. Never further back than `maxDays`, what the provider keeps.
export function resumeDate(siteId, provider, tz, today, normalDate, overlapDays, maxDays) {
  const last = db.prepare('SELECT last_success_at FROM connection WHERE site_id = ? AND provider = ?').get(siteId, provider)?.last_success_at;
  let d = normalDate;
  if (last != null) { const r = addDays(localDate(tz, last), -overlapDays); if (r < d) d = r; }
  const floor = addDays(today, -maxDays);
  return d < floor ? floor : d;
}
const daysAgo = (today, date) => daysBetween(date, today).length - 1;

async function step(log, siteId, provider, fn) {
  const t0 = Date.now();
  try {
    const res = await fn();
    if (provider) setConnection(siteId, provider, true);
    log.push({ step: provider || 'geo', ok: true, ms: Date.now() - t0, ...res });
    return res;
  } catch (err) {
    if (provider) setConnection(siteId, provider, false, err.message);
    log.push({ step: provider || 'geo', ok: false, ms: Date.now() - t0, error: err.message });
    return null;
  }
}

export async function syncSite(siteId) {
  if (running.has(siteId)) return { skipped: 'already running' };
  running.add(siteId);
  const runId = Number(db.prepare("INSERT INTO sync_run (site_id, started_at, status) VALUES (?, ?, 'running')").run(siteId, nowSec()).lastInsertRowid);
  const syncStartMs = Date.now();
  let agreementsChanged = false;
  const log = [];
  try {
    let site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
    const conns = new Set(db.prepare('SELECT provider FROM connection WHERE site_id = ?').all(siteId).map((c) => c.provider));
    const built = db.prepare('SELECT MAX(local_date) AS d FROM site_day WHERE site_id = ?').get(siteId).d;
    const tz = site.timezone;
    const today = localDate(tz, nowSec());
    const firstRun = !built;
    const fromDate = firstRun ? addDays(today, -INITIAL_DAYS) : addDays(today, -2);
    const [fromTs] = dayBounds(tz, fromDate);

    // No postcode configured: take it from the Octopus supply address first.
    if (!site.postcode && conns.has('octopus')) {
      await step(log, siteId, 'octopus', async () => {
        await syncOctopusAccount(site, { apiKey: env.OCTOPUS_API_KEY, accountNumber: env.OCTOPUS_ACCOUNT_NUMBER });
        site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
        return { postcodeFromAccount: !!site.postcode };
      });
    }
    // Sunsynk first: its plant record gives the home's coordinates when no postcode is set.
    if (conns.has('sunsynk')) {
      // The 5-minute history is kept upstream for 90 days only.
      const dates = daysBetween(firstRun ? addDays(today, -Math.min(INITIAL_DAYS, 89)) : resumeDate(siteId, 'sunsynk', tz, today, addDays(today, -1), 1, 89), today);
      await step(log, siteId, 'sunsynk', () => syncSunsynk(site, { username: env.SUNSYNK_USERNAME, password: env.SUNSYNK_PASSWORD, plantId: env.SUNSYNK_PLANT_ID }, dates));
      try { measureBatteryCapacity(siteId); } catch (err) { console.error('battery capacity:', err.message); }
      site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
    }
    await step(log, siteId, null, async () => { site = await resolveSiteGeo(site); return { postcode: site.postcode, region: site.gsp_region, outcode: site.outcode }; });

    // Sunlight history must cover the forecast's 14-day learning window; fetch it all until it does.
    const ghiFrom = db.prepare(`SELECT MIN(f.start_ts) AS t FROM interval_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id
      WHERE se.subject_kind = 'site' AND se.subject_id = ? AND m.code = 'ghi_wm2'`).get(String(siteId))?.t;
    const sunShort = !ghiFrom || ghiFrom > nowSec() - INITIAL_DAYS * 86400;
    const weatherDays = firstRun || sunShort ? INITIAL_DAYS + 1 : Math.max(3, daysAgo(today, resumeDate(siteId, 'weather', tz, today, today, 1, 92)) + 1);
    await step(log, siteId, 'weather', () => syncWeather(site, weatherDays));
    await step(log, siteId, 'carbon', () => syncCarbon(site, dayBounds(tz, resumeDate(siteId, 'carbon', tz, today, fromDate, 1, 60))[0], nowSec()));

    if (conns.has('octopus')) {
      const creds = { apiKey: env.OCTOPUS_API_KEY, accountNumber: env.OCTOPUS_ACCOUNT_NUMBER };
      // A provider connected after the home was first built still needs the full initial window.
      const octoFirst = firstRun || !db.prepare("SELECT last_success_at FROM connection WHERE site_id = ? AND provider = 'octopus'").get(siteId)?.last_success_at;
      const octoFrom = octoFirst ? dayBounds(tz, addDays(today, -INITIAL_DAYS))[0] : dayBounds(tz, resumeDate(siteId, 'octopus', tz, today, fromDate, 1, 365))[0];
      await step(log, siteId, 'octopus', async () => {
        const meters = await syncOctopusAccount(site, creds);
        agreementsChanged = !!meters.agreementsChanged;
        // Gas units straight from Octopus; if they changed, re-read the whole gas history.
        let gasUnits = null;
        try { gasUnits = await syncGasUnits(site, creds); } catch (err) { gasUnits = { error: err.message }; }
        // Meter data arrives about a day late and can be revised, so always look back a few days.
        const meterFrom = octoFirst ? octoFrom : dayBounds(tz, resumeDate(siteId, 'octopus', tz, today, addDays(today, -4), 4, 365))[0];
        // Re-read the whole gas history when the unit changed, or when m3 readings are not stored yet.
        const noGasM3 = !db.prepare(`SELECT 1 FROM interval_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id
          JOIN device d ON se.subject_kind = 'device' AND se.subject_id = CAST(d.id AS TEXT) WHERE d.site_id = ? AND m.code = 'gas_m3' LIMIT 1`).get(siteId);
        const gasFrom = gasUnits?.changed || noGasM3 ? dayBounds(tz, addDays(today, -INITIAL_DAYS))[0] : undefined;
        const consumption = await syncOctopusConsumption(site, creds, meterFrom, nowSec(), { gasFrom });
        // Only tariffs in force somewhere in the window; the account history goes back years.
        const tariffs = db.prepare(`SELECT DISTINCT t.* FROM tariff t JOIN tariff_agreement a ON a.tariff_id = t.id
                                    WHERE a.site_id = ? AND a.superseded_at IS NULL AND a.valid_from < ? AND IFNULL(a.valid_to, 9000000000) > ?`).all(siteId, nowSec() + 2 * 86400, octoFrom - 86400);
        let rates = 0;
        for (const t of tariffs) rates += await syncTariffRates(t, octoFrom - 86400, nowSec() + 2 * 86400, siteId);
        // Intelligent Octopus Go tariffs that publish day/night prices give no times. The window
        // is learned from Octopus's time-stamped prices of the home's earlier IOG tariffs, so fetch
        // the last two weeks of those when no such prices are held yet.
        if (tariffs.some((t) => t.structure === 'iog') && !learnIogWindow(site.gsp_region, tz)) {
          const earlier = db.prepare(`SELECT DISTINCT t.*, a.valid_to AS ended FROM tariff t JOIN tariff_agreement a ON a.tariff_id = t.id
            WHERE a.site_id = ? AND a.superseded_at IS NULL AND t.structure = 'iog' AND a.valid_to IS NOT NULL ORDER BY a.valid_to DESC`).all(siteId);
          for (const t of earlier) {
            rates += await syncTariffRates(t, t.ended - 14 * 86400, t.ended, siteId);
            if (learnIogWindow(site.gsp_region, tz)) break;
          }
        }
        let kraken = null;
        try { kraken = await syncKraken(site, creds); } catch (err) { kraken = { error: err.message }; }
        return { consumption, rates, tariffs: tariffs.length, kraken, gasUnits };
      });
    }
    // Daily calorific value for the gas meter's zone, to convert m3 to kWh.
    if (db.prepare("SELECT 1 FROM device WHERE site_id = ? AND kind = 'meter_gas'").get(siteId)) {
      ensureConnection(siteId, 'gas_cv');
      const cvFirst = !db.prepare("SELECT last_success_at FROM connection WHERE site_id = ? AND provider = 'gas_cv'").get(siteId)?.last_success_at;
      await step(log, siteId, 'gas_cv', () => syncGasCv(site, cvFirst ? dayBounds(tz, addDays(today, -INITIAL_DAYS))[0] : dayBounds(tz, resumeDate(siteId, 'gas_cv', tz, today, fromDate, 2, 365))[0] - 86400, nowSec()));
    }
    if (conns.has('tariff')) await step(log, siteId, 'tariff', () => syncEnvTariffs(site, fromTs));
    // Reference tariffs for the comparison page (public prices).
    ensureConnection(siteId, 'compare');
    const cmpFirst = !db.prepare("SELECT last_success_at FROM connection WHERE site_id = ? AND provider = 'compare'").get(siteId)?.last_success_at;
    const cmpFrom = cmpFirst ? dayBounds(tz, addDays(today, -Math.max(INITIAL_DAYS, 30)))[0] : dayBounds(tz, resumeDate(siteId, 'compare', tz, today, fromDate, 1, 365))[0];
    await step(log, siteId, 'compare', () => syncComparison(site, cmpFrom - 86400, nowSec() + 2 * 86400));
    await step(log, siteId, 'solar_forecast', () => syncQuartz(site));

    // Rebuild only from the earliest half-hour whose facts changed in this sync (always
    // including today, which is still being filled in). A changed tariff history rebuilds all.
    const dirtyFrom = firstRun || agreementsChanged ? fromTs : Math.min(dayBounds(tz, today)[0], earliestChange(siteId, site, syncStartMs) ?? Infinity);
    markDirty(siteId, dirtyFrom, nowSec(), firstRun ? 'initial load' : agreementsChanged ? 'tariff agreements changed' : 'facts changed');
    const t0 = Date.now();
    const rebuilt = processQueue();
    log.push({ step: 'build', ok: true, ms: Date.now() - t0, rebuilt });
    const t1 = Date.now();
    try {
      const res = recordForecast(siteId);
      log.push({ step: 'forecast', ok: true, ms: Date.now() - t1, ...res });
    } catch (err) {
      log.push({ step: 'forecast', ok: false, ms: Date.now() - t1, error: err.message });
    }
    const ok = log.every((l) => l.ok);
    db.prepare('UPDATE sync_run SET finished_at = ?, status = ?, detail = ? WHERE id = ?').run(nowSec(), ok ? 'ok' : 'partial', JSON.stringify(log), runId);
    return { ok, log };
  } catch (err) {
    db.prepare('UPDATE sync_run SET finished_at = ?, status = ?, detail = ? WHERE id = ?').run(nowSec(), 'error', JSON.stringify([...log, { error: err.message }]), runId);
    throw err;
  } finally {
    running.delete(siteId);
  }
}

// A sync cut short by a crash or a restart stays 'running' in sync_run; mark it at startup
// so the Data & trust page shows what happened. Its facts were committed step by step, and
// the next sync fetches the same window again.
export function closeInterruptedRuns() {
  return db.prepare("UPDATE sync_run SET status = 'interrupted', finished_at = COALESCE(finished_at, started_at) WHERE status = 'running'").run().changes;
}

export function startScheduler() {
  const minutes = Math.max(Number(env.SYNC_EVERY_MINUTES) || 10, 2);
  const tick = async () => {
    for (const { id } of db.prepare('SELECT id FROM site').all()) {
      try { await syncSite(id); } catch (err) { console.error(`sync site ${id}:`, err.message); }
    }
  };
  setInterval(tick, minutes * 60 * 1000).unref();
  return minutes;
}

export const isSyncing = (siteId) => running.has(siteId);
