// Sync job: for each home, run the plan the market provider registry gives it (src/core/providers.js
// plan; the steps are in src/jobs/steps.js), in dependency order, then rebuild whatever changed.
// Each step fails on its own; one provider being down never stops the others, and the failure is
// recorded on the connection. A provider the plan cannot use (disabled, unlicensed, owned by another
// process, no credentials) is recorded as 'skipped: <reason>', never as an error.
import { db } from '../db/db.js';
import { markDirty, seriesId, putForecasts } from '../core/facts.js';
import { processQueue } from '../core/build.js';
import { forecastSite } from '../core/forecast.js';
import { nowSec, localDate, addDays, dayBounds, slotLength } from '../core/time.js';
import { assertOwner } from '../adapters/contract.js';
import { shareResponses } from '../core/http.js';
import { setAttribute, withdrawAttribute } from '../core/attributes.js';
import { seedSiteAttributes } from '../core/maintenance.js';
import { createSite } from '../core/sites.js';
import { plan, newCycle, adapterFor, providersFor } from '../core/providers.js';
import { INITIAL_DAYS, resumeDate } from './steps.js';

export { resumeDate };
const env = process.env;
const running = new Set();

function setConnection(siteId, provider, ok, error) {
  db.prepare(
    `UPDATE connection SET status = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ?
     WHERE site_id = ? AND provider = ?`).run(ok ? 'ok' : 'error', ok ? 1 : 0, nowSec(), ok ? null : String(error).slice(0, 300), siteId, provider);
}

// A step the plan skipped (no credentials, provider switched off): not an error, not a success.
function markSkipped(siteId, provider) {
  db.prepare("UPDATE connection SET status = 'skipped' WHERE site_id = ? AND provider = ?").run(siteId, provider);
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
    // Market from SITE_COUNTRY, default GB: country GB, pounds, Europe/London, half-hour slots
    // (createSite's defaults). Another country brings its market's currency, clock and slot length.
    site = createSite({ name: env.SITE_NAME || 'My home', postcode: env.SITE_POSTCODE || null, country: env.SITE_COUNTRY || null, envKey: 'env' });
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
  // Connections only where the registry lists the provider for the home's market: the inverter and
  // the meter when their credentials are in .env, the tariff codes, then every shared step that
  // always runs (weather, carbon, comparison, solar forecast in GB). Steps that run only once they
  // apply (gas calorific value, once a gas meter is known) create their row then.
  const listed = (role, adapter) => providersFor(db, site.market_code ?? 'GB', role).some((r) => r.adapter === adapter && r.enabled && r.licence_confirmed && r.owner === 'core');
  if (hasSunsynk && listed('inverter', 'sunsynk')) ensureConnection(site.id, 'sunsynk');
  if (hasOctopus && listed('meter', 'octopus')) ensureConnection(site.id, 'octopus', env.OCTOPUS_ACCOUNT_NUMBER);
  if ((env.IMPORT_TARIFF_CODE || env.EXPORT_TARIFF_CODE) && listed('tariff_prices', 'octopus')) ensureConnection(site.id, 'tariff');
  for (const e of plan(db, site)) {
    if (e.run && e.scope === 'shared' && e.connection && !e.def.when && !e.def.applies) ensureConnection(site.id, e.connection);
  }
  return site.id;
}

// Our own forecast is stored as an issue like any provider's, so it can later be
// scored against what the home actually did. Once an hour is enough to score it.
function recordForecast(siteId) {
  const now = nowSec();
  const homeS = seriesId('site', siteId, 'load_kwh', 'core_forecast');
  const last = db.prepare('SELECT MAX(issued_at) AS t FROM forecast_fact WHERE series_id = ?').get(homeS)?.t;
  if (last != null && now - last < 3600) return { skipped: 'issued within the last hour' };
  const fc = forecastSite(siteId, 48);
  // Stored in the home's own slot length; scoring and the build match them to slots by overlap.
  const slotS = slotLength(db.prepare('SELECT slot_s FROM site WHERE id = ?').get(siteId));
  const rows = (k) => fc.slots.filter((s) => s[k] != null).map((s) => ({ start: s.slot_start, end: s.slot_start + slotS, value: s[k] }));
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

// One step: its result, or its error, in the run's log and on its connection row (none for 'geo').
async function step(log, siteId, name, connection, fn) {
  const t0 = Date.now();
  try {
    const res = await fn();
    if (connection) setConnection(siteId, connection, true);
    log.push({ step: name, ok: true, ms: Date.now() - t0, ...res });
    return { ok: true, res };
  } catch (err) {
    if (connection) setConnection(siteId, connection, false, err.message);
    log.push({ step: name, ok: false, ms: Date.now() - t0, error: err.message });
    return { ok: false, error: err.message };
  }
}

// One plan entry. Skips the plan recorded are logged as such; a shared step another home already
// ran in this cycle (same key, a window at least as long) is reused instead of calling again.
export async function runEntry(ctx, e, log) {
  if (!e.run) {
    if (e.log) {
      log.push({ step: e.step, ok: true, ms: 0, skipped: e.skipped });
      if (e.connection) markSkipped(ctx.siteId, e.connection);
    }
    return;
  }
  const def = e.def;
  if (def.applies && !def.applies(ctx)) return;   // nothing to do for this home yet: not run, not logged
  if (def.ensure && e.connection) ensureConnection(ctx.siteId, e.connection);
  let args;
  try {
    args = def.prepare ? def.prepare(ctx) : {};
  } catch (err) {
    await step(log, ctx.siteId, e.step, e.connection, () => { throw err; });
    if (def.after) def.after(ctx);
    return;
  }
  const share = def.share ? def.share(ctx, args) : null;
  const hit = share ? ctx.cycle.shared.get(share.key) : null;
  if (hit && hit.siteId !== ctx.siteId && (hit.from ?? -Infinity) <= (share.from ?? -Infinity)) {
    if (e.connection) setConnection(ctx.siteId, e.connection, true);
    def.onShared?.(ctx, hit);
    ctx.sinceMs = Math.min(ctx.sinceMs, hit.startedMs);   // its facts were written before this sync began
    log.push({ step: e.step, ok: true, ms: 0, shared: `fetched for home ${hit.siteId} earlier in this cycle (${share.key})` });
  } else {
    const startedMs = Date.now();
    // Only the owning process may call a provider (the plan already left out any other).
    const call = () => { assertOwner(adapterFor(e.adapter) ?? { code: e.adapter, owner: 'core' }); return def.run(ctx, args, e.creds); };
    const r = await step(log, ctx.siteId, e.step, e.connection, def.shareResponses ? () => shareResponses(ctx.cycle.responses, call) : call);
    if (share && r.ok && !r.res?.skipped && (!hit || (share.from ?? -Infinity) < (hit.from ?? -Infinity))) {
      ctx.cycle.shared.set(share.key, { siteId: ctx.siteId, from: share.from, startedMs });
    }
  }
  if (def.after) def.after(ctx);
}

/**
 * Sync one home: its plan from the registry, step by step, then the rebuild and the forecast record.
 * `cycle` (newCycle) is shared by the homes of one scheduler tick, so shared work runs once; a home
 * synced on its own gets a fresh one.
 */
export async function syncSite(siteId, { cycle = newCycle() } = {}) {
  if (running.has(siteId)) return { skipped: 'already running' };
  running.add(siteId);
  const runId = Number(db.prepare("INSERT INTO sync_run (site_id, started_at, status) VALUES (?, ?, 'running')").run(siteId, nowSec()).lastInsertRowid);
  const syncStartMs = Date.now();
  const log = [];
  try {
    const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
    const conns = new Set(db.prepare('SELECT provider FROM connection WHERE site_id = ?').all(siteId).map((c) => c.provider));
    const built = db.prepare('SELECT MAX(local_date) AS d FROM site_day WHERE site_id = ?').get(siteId).d;
    const tz = site.timezone;
    const today = localDate(tz, nowSec());
    const firstRun = !built;
    const fromDate = firstRun ? addDays(today, -INITIAL_DAYS) : addDays(today, -2);
    const [fromTs] = dayBounds(tz, fromDate);
    const ctx = { siteId, site, conns, tz, today, firstRun, fromDate, fromTs, cycle, agreementsChanged: false, sinceMs: syncStartMs };

    for (const e of plan(db, site, { conns })) await runEntry(ctx, e, log);

    // Rebuild only from the earliest slot whose facts changed in this sync (always including
    // today, which is still being filled in). A changed tariff history rebuilds all.
    const dirtyFrom = firstRun || ctx.agreementsChanged ? fromTs : Math.min(dayBounds(tz, today)[0], earliestChange(siteId, ctx.site, ctx.sinceMs) ?? Infinity);
    markDirty(siteId, dirtyFrom, nowSec(), firstRun ? 'initial load' : ctx.agreementsChanged ? 'tariff agreements changed' : 'facts changed');
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

// Every home that is not a demo, one after another, in one cycle (shared steps once per key).
// onSite(siteId, result, error) is called after each; a home that throws never stops the next.
export async function syncAll(siteIds = null, { onSite = null } = {}) {
  const ids = siteIds ?? db.prepare('SELECT id FROM site WHERE is_demo = 0').all().map((r) => r.id);
  const cycle = newCycle();
  const out = [];
  for (const id of ids) {
    try {
      const r = await syncSite(id, { cycle });
      out.push({ siteId: id, ...r });
      onSite?.(id, r, null);
    } catch (err) {
      out.push({ siteId: id, ok: false, error: err.message });
      if (onSite) onSite(id, null, err); else console.error(`sync site ${id}:`, err.message);
    }
  }
  return out;
}

// A sync cut short by a crash or a restart stays 'running' in sync_run; mark it at startup
// so the Data & trust page shows what happened. Its facts were committed step by step, and
// the next sync fetches the same window again.
export function closeInterruptedRuns() {
  return db.prepare("UPDATE sync_run SET status = 'interrupted', finished_at = COALESCE(finished_at, started_at) WHERE status = 'running'").run().changes;
}

export function startScheduler() {
  const minutes = Math.max(Number(env.SYNC_EVERY_MINUTES) || 10, 2);
  // Demo homes (is_demo) hold generated data and have no providers: they are never synced.
  const tick = () => syncAll().catch((err) => console.error('sync:', err.message));
  setInterval(tick, minutes * 60 * 1000).unref();
  return minutes;
}

export const isSyncing = (siteId) => running.has(siteId);
