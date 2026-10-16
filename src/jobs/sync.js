// Sync job: for each home, call the adapters in dependency order, then rebuild
// whatever changed. Each step fails on its own; one provider being down never
// stops the others, and the failure is recorded on the connection.
import { db } from '../db/db.js';
import { markDirty } from '../core/facts.js';
import { processQueue } from '../core/build.js';
import { nowSec, localDate, addDays, dayBounds, daysBetween } from '../core/time.js';
import { resolveSiteGeo } from '../adapters/geo.js';
import { syncCarbon } from '../adapters/carbon.js';
import { syncWeather } from '../adapters/openmeteo.js';
import { syncQuartz } from '../adapters/quartz.js';
import { syncDemo } from '../adapters/demo.js';
import { syncSunsynk } from '../adapters/sunsynk.js';
import { syncOctopusAccount, syncOctopusConsumption, syncTariffRates, syncKraken, upsertTariff } from '../adapters/octopus.js';

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
    db.prepare(`INSERT INTO site (name, postcode, pv_kwp, pv_tilt, pv_orientation, battery_kwh, env_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'env', ?)`)
      .run(env.SITE_NAME || 'My home', env.SITE_POSTCODE || null, num(env.PV_KWP), num(env.PV_TILT), num(env.PV_ORIENTATION), num(env.BATTERY_KWH), nowSec());
    site = db.prepare("SELECT * FROM site WHERE env_key = 'env'").get();
  } else {
    db.prepare(`UPDATE site SET name = ?, postcode = COALESCE(?, postcode), pv_kwp = COALESCE(?, pv_kwp), pv_tilt = COALESCE(?, pv_tilt),
                pv_orientation = COALESCE(?, pv_orientation), battery_kwh = COALESCE(?, battery_kwh) WHERE id = ?`)
      .run(env.SITE_NAME || site.name, env.SITE_POSTCODE || null, num(env.PV_KWP), num(env.PV_TILT), num(env.PV_ORIENTATION), num(env.BATTERY_KWH), site.id);
  }
  if (hasSunsynk) ensureConnection(site.id, 'sunsynk');
  if (hasOctopus) ensureConnection(site.id, 'octopus', env.OCTOPUS_ACCOUNT_NUMBER);
  if (env.IMPORT_TARIFF_CODE || env.EXPORT_TARIFF_CODE) ensureConnection(site.id, 'tariff');
  for (const p of ['weather', 'carbon', 'solar_forecast']) ensureConnection(site.id, p);
  return site.id;
}

// Tariff codes from .env price the home when its Octopus account cannot be read.
// Tariff rates are public, so costs work from the inverter's grid clamp alone.
// As soon as the account syncs, its own meters and agreements replace these.
async function syncEnvTariffs(site, fromTs) {
  if (db.prepare("SELECT 1 FROM device WHERE site_id = ? AND provider = 'octopus'").get(site.id)) {
    db.prepare("DELETE FROM device WHERE site_id = ? AND provider = 'env'").run(site.id);
    return { skipped: 'using Octopus account agreements' };
  }
  let rates = 0;
  const used = [];
  for (const [kind, code, direction] of [['meter_import', env.IMPORT_TARIFF_CODE, 'import'], ['meter_export', env.EXPORT_TARIFF_CODE, 'export']]) {
    if (!code) continue;
    db.prepare(`INSERT INTO device (site_id, kind, provider, external_ref, label, attrs) VALUES (?, ?, 'env', ?, ?, '{}')
                ON CONFLICT(site_id, provider, external_ref) DO NOTHING`).run(site.id, kind, kind, `${direction === 'import' ? 'Import' : 'Export'} tariff (.env)`);
    const dev = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'env' AND external_ref = ?").get(site.id, kind);
    const tariff = upsertTariff({ tariffCode: code, direction });
    const current = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ?').get(dev.id);
    if (!current || current.tariff_id !== tariff.id || current.valid_from > fromTs) {
      db.prepare('DELETE FROM tariff_agreement WHERE device_id = ?').run(dev.id);
      db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to) VALUES (?, ?, ?, ?, NULL)').run(site.id, dev.id, tariff.id, Math.min(fromTs, current?.valid_from ?? fromTs));
    }
    rates += await syncTariffRates(tariff, fromTs - 86400, nowSec() + 2 * 86400, site.id);
    used.push(code);
  }
  return { tariffs: used, rates };
}

export function createDemoSite() {
  const existing = db.prepare('SELECT id FROM site WHERE is_demo = 1').get();
  if (existing) return existing.id;
  const r = db.prepare(`INSERT INTO site (name, postcode, pv_kwp, pv_tilt, pv_orientation, battery_kwh, is_demo, created_at)
                        VALUES ('Demo home', ?, 5, 35, 180, 10, 1, ?)`).run(env.DEMO_POSTCODE || 'BS1 6QF', nowSec());
  const id = Number(r.lastInsertRowid);
  for (const p of ['demo', 'weather', 'carbon', 'solar_forecast']) ensureConnection(id, p);
  return id;
}

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
      const dates = daysBetween(firstRun ? addDays(today, -Math.min(INITIAL_DAYS, 89)) : addDays(today, -1), today);
      await step(log, siteId, 'sunsynk', () => syncSunsynk(site, { username: env.SUNSYNK_USERNAME, password: env.SUNSYNK_PASSWORD, plantId: env.SUNSYNK_PLANT_ID }, dates));
      site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
    }
    await step(log, siteId, null, async () => { site = await resolveSiteGeo(site); return { postcode: site.postcode, region: site.gsp_region, outcode: site.outcode }; });

    // Weather first: the demo home uses it to make its solar output.
    await step(log, siteId, 'weather', () => syncWeather(site, firstRun ? INITIAL_DAYS + 1 : 3));
    await step(log, siteId, 'carbon', () => syncCarbon(site, fromTs, nowSec()));

    if (conns.has('demo')) await step(log, siteId, 'demo', () => syncDemo(site, INITIAL_DAYS));

    if (conns.has('octopus')) {
      const creds = { apiKey: env.OCTOPUS_API_KEY, accountNumber: env.OCTOPUS_ACCOUNT_NUMBER };
      await step(log, siteId, 'octopus', async () => {
        await syncOctopusAccount(site, creds);
        // Meter data arrives about a day late and can be revised, so always look back a few days.
        const meterFrom = firstRun ? fromTs : dayBounds(tz, addDays(today, -4))[0];
        const consumption = await syncOctopusConsumption(site, creds, meterFrom, nowSec());
        const tariffs = db.prepare('SELECT DISTINCT t.* FROM tariff t JOIN tariff_agreement a ON a.tariff_id = t.id WHERE a.site_id = ?').all(siteId);
        let rates = 0;
        for (const t of tariffs) rates += await syncTariffRates(t, fromTs - 86400, nowSec() + 2 * 86400, siteId);
        let kraken = null;
        try { kraken = await syncKraken(site, creds); } catch (err) { kraken = { error: err.message }; }
        return { consumption, rates, tariffs: tariffs.length, kraken };
      });
    }
    if (conns.has('tariff')) await step(log, siteId, 'tariff', () => syncEnvTariffs(site, fromTs));
    await step(log, siteId, 'solar_forecast', () => syncQuartz(site));

    markDirty(siteId, fromTs, nowSec(), firstRun ? 'initial load' : 'sync');
    const t0 = Date.now();
    const rebuilt = processQueue();
    log.push({ step: 'build', ok: true, ms: Date.now() - t0, rebuilt });
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
