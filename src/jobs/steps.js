// The sync steps of each provider, registered under the adapter codes of the market provider
// registry (src/db/seed/providers.js, src/core/providers.js). Each step wraps the adapter call
// exactly as src/jobs/sync.js made it before the registry: the same windows, the same order (the
// `order` numbers), the same site refreshes. The adapters themselves are unchanged.
//
// ctx (one per home per sync, from syncSite): siteId, site (refreshed by some steps), conns, tz,
// today, firstRun, fromDate, fromTs, cycle (newCycle), agreementsChanged, sinceMs.
import { db } from '../db/db.js';
import { registerAdapter } from '../core/providers.js';
import { siteCredentials } from '../core/secrets.js';
import { nowSec, localDate, addDays, dayBounds, daysBetween } from '../core/time.js';
import { resolveSiteGeo } from '../adapters/geo.js';
import { syncCarbon } from '../adapters/carbon.js';
import { syncWeather } from '../adapters/openmeteo.js';
import { syncQuartz } from '../adapters/quartz.js';
import { syncSunsynk } from '../adapters/sunsynk.js';
import { syncOctopusAccount, syncOctopusConsumption, syncTariffRates, syncKraken, upsertTariff, syncGasUnits } from '../adapters/octopus.js';
import { learnIogWindow } from '../core/pricing.js';
import { syncComparison, octopusRegion } from '../core/compare.js';
import { syncGasCv } from '../adapters/nationalgas.js';
import { measureBatteryCapacity } from '../core/derive.js';
import { retireDevice, supersedeAgreements } from '../core/devices.js';
import { clientFor, credentialsFromEnv, sweepCatalogue, sweepDue, sweepStatus } from '../adapters/tariffscanner.js';
import * as TU from '../adapters/tounify.js';

const env = process.env;
export const INITIAL_DAYS = Math.min(Number(env.INITIAL_DAYS) || 14, 60);

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
const reread = (ctx) => { ctx.site = db.prepare('SELECT * FROM site WHERE id = ?').get(ctx.siteId); };
const lastSuccess = (siteId, provider) => db.prepare('SELECT last_success_at FROM connection WHERE site_id = ? AND provider = ?').get(siteId, provider)?.last_success_at;

// A tariff's public prices are the same for every home on it: within one cycle a window already
// fetched for another home is not fetched again (the rates are in rate_interval, shared). The look-
// ahead end (now + 2 days) moves by seconds between homes, so an hour of it is allowed for. A home's
// own repeated windows are fetched as before. Prices published while the cycle runs arrive next cycle.
const LOOKAHEAD_SLACK_S = 3600;
export async function tariffRates(ctx, tariff, fromTs, toTs) {
  const windows = ctx.cycle.tariffs.get(tariff.id) ?? [];
  const hit = windows.find((w) => w.siteId !== ctx.siteId && w.from <= fromTs && w.to >= toTs - LOOKAHEAD_SLACK_S);
  if (hit) {
    ctx.sinceMs = Math.min(ctx.sinceMs, hit.startedMs);   // its rows were written before this sync began
    ctx.tariffsShared = (ctx.tariffsShared ?? 0) + 1;
    return 0;
  }
  const startedMs = Date.now();
  const n = await syncTariffRates(tariff, fromTs, toTs, ctx.siteId);
  ctx.cycle.tariffs.set(tariff.id, [...windows, { siteId: ctx.siteId, from: fromTs, to: toTs, startedMs }]);
  return n;
}

// ───────────── Inverter: Sunsynk (any market) ─────────────

registerAdapter('sunsynk', {
  connection: 'sunsynk',
  // The home's stored login (src/core/secrets.js) when it has one, else .env for the .env home.
  credentials: (site) => siteCredentials(site, 'sunsynk', { username: 'SUNSYNK_USERNAME', password: 'SUNSYNK_PASSWORD' }, { plantId: 'SUNSYNK_PLANT_ID' }),
  externalRef: (c) => c.plantId ?? null,
  publicFields: ['plantId'],
  roles: {
    inverter: [{
      // Sunsynk first: its plant record gives the home's coordinates when no postcode is set.
      step: 'sunsynk', order: 10, connection: 'sunsynk',
      // The 5-minute history is kept upstream for 90 days only. An inverter connected after the home
      // was first built (a home added from its postcode, then connected) still needs the full initial window.
      prepare: (ctx) => ({ dates: daysBetween(ctx.firstRun || !lastSuccess(ctx.siteId, 'sunsynk') ? addDays(ctx.today, -Math.min(INITIAL_DAYS, 89)) : resumeDate(ctx.siteId, 'sunsynk', ctx.tz, ctx.today, addDays(ctx.today, -1), 1, 89), ctx.today) }),
      run: (ctx, a, creds) => syncSunsynk(ctx.site, creds, a.dates),
      after: (ctx) => {
        try { measureBatteryCapacity(ctx.siteId); } catch (err) { console.error('battery capacity:', err.message); }
        reread(ctx);
      },
    }],
  },
});

// ───────────── Location: postcode look-ups (GB) ─────────────

registerAdapter('geo', {
  roles: {
    location: [{
      step: 'geo', order: 20, connection: null,
      run: async (ctx) => { ctx.site = await resolveSiteGeo(ctx.site); return { postcode: ctx.site.postcode, region: ctx.site.gsp_region, outcode: ctx.site.outcode }; },
    }],
  },
});

// ───────────── Weather: Open-Meteo ─────────────

registerAdapter('open_meteo', {
  roles: {
    weather: [{
      step: 'weather', order: 30, connection: 'weather', shareResponses: true,
      prepare: (ctx) => {
        // Sunlight history must cover the forecast's 14-day learning window; fetch it all until it does.
        const ghiFrom = db.prepare(`SELECT MIN(f.start_ts) AS t FROM interval_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id
          WHERE se.subject_kind = 'site' AND se.subject_id = ? AND m.code = 'ghi_wm2'`).get(String(ctx.siteId))?.t;
        const sunShort = !ghiFrom || ghiFrom > nowSec() - INITIAL_DAYS * 86400;
        return { days: ctx.firstRun || sunShort ? INITIAL_DAYS + 1 : Math.max(3, daysAgo(ctx.today, resumeDate(ctx.siteId, 'weather', ctx.tz, ctx.today, ctx.today, 1, 92)) + 1) };
      },
      run: (ctx, a) => syncWeather(ctx.site, a.days),
    }],
  },
});

// ───────────── Carbon intensity: NESO (GB), one region series for every home in the region ─────────────

registerAdapter('neso', {
  roles: {
    carbon: [{
      step: 'carbon', order: 40, connection: 'carbon',
      prepare: (ctx) => ({ from: dayBounds(ctx.tz, resumeDate(ctx.siteId, 'carbon', ctx.tz, ctx.today, ctx.fromDate, 1, 60))[0] }),
      share: (ctx, a) => (ctx.site.carbon_region != null && ctx.site.outcode ? { key: `carbon:${ctx.site.carbon_region}`, from: a.from } : null),
      run: (ctx, a) => syncCarbon(ctx.site, a.from, nowSec()),
    }],
  },
});

// ───────────── Octopus (GB): meter account, tariff prices, catalogue ─────────────

// Tariff codes from .env price the home when its Octopus account cannot be read.
// Tariff rates are public, so costs work from the inverter's grid clamp alone.
// As soon as the account syncs, its own meters and agreements replace these.
async function syncEnvTariffs(ctx) {
  const { site, fromTs } = ctx;
  if (db.prepare("SELECT 1 FROM device WHERE site_id = ? AND provider = 'octopus' AND retired_at IS NULL").get(site.id)) {
    // Retired, not deleted: the .env tariffs still priced the half-hours before the account was read.
    for (const d of db.prepare("SELECT id FROM device WHERE site_id = ? AND provider = 'env' AND retired_at IS NULL").all(site.id)) { retireDevice(d.id); supersedeAgreements(site.id, d.id, []); }
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
    rates += await tariffRates(ctx, tariff, fromTs - 86400, nowSec() + 2 * 86400);
    used.push(code);
  }
  return { tariffs: used, rates };
}

async function syncOctopusMeters(ctx, a, creds) {
  const { site, siteId, tz, today } = ctx;
  const { octoFirst, octoFrom } = a;
  const meters = await syncOctopusAccount(site, creds);
  ctx.agreementsChanged = !!meters.agreementsChanged;
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
  for (const t of tariffs) rates += await tariffRates(ctx, t, octoFrom - 86400, nowSec() + 2 * 86400);
  // Intelligent Octopus Go tariffs that publish day/night prices give no times. The window
  // is learned from Octopus's time-stamped prices of the home's earlier IOG tariffs, so fetch
  // the last two weeks of those when no such prices are held yet.
  if (tariffs.some((t) => t.structure === 'iog') && !learnIogWindow(site.gsp_region, tz)) {
    const earlier = db.prepare(`SELECT DISTINCT t.*, a.valid_to AS ended FROM tariff t JOIN tariff_agreement a ON a.tariff_id = t.id
      WHERE a.site_id = ? AND a.superseded_at IS NULL AND t.structure = 'iog' AND a.valid_to IS NOT NULL ORDER BY a.valid_to DESC`).all(siteId);
    for (const t of earlier) {
      rates += await tariffRates(ctx, t, t.ended - 14 * 86400, t.ended);
      if (learnIogWindow(site.gsp_region, tz)) break;
    }
  }
  let kraken = null;
  try { kraken = await syncKraken(site, creds); } catch (err) { kraken = { error: err.message }; }
  return { consumption, rates, tariffs: tariffs.length, kraken, gasUnits };
}

registerAdapter('octopus', {
  connection: 'octopus',
  credentials: (site) => siteCredentials(site, 'octopus', { apiKey: 'OCTOPUS_API_KEY', accountNumber: 'OCTOPUS_ACCOUNT_NUMBER' }),
  externalRef: (c) => c.accountNumber ?? null,
  publicFields: ['accountNumber'],
  roles: {
    meter: [
      {
        // No postcode configured: take it from the Octopus supply address first.
        step: 'octopus', order: 5, connection: 'octopus', when: (p) => !p.site.postcode,
        run: async (ctx, a, creds) => {
          await syncOctopusAccount(ctx.site, creds);
          reread(ctx);
          return { postcodeFromAccount: !!ctx.site.postcode };
        },
      },
      {
        step: 'octopus', order: 50, connection: 'octopus',
        prepare: (ctx) => {
          // A provider connected after the home was first built still needs the full initial window.
          const octoFirst = ctx.firstRun || !lastSuccess(ctx.siteId, 'octopus');
          const octoFrom = octoFirst ? dayBounds(ctx.tz, addDays(ctx.today, -INITIAL_DAYS))[0] : dayBounds(ctx.tz, resumeDate(ctx.siteId, 'octopus', ctx.tz, ctx.today, ctx.fromDate, 1, 365))[0];
          return { octoFirst, octoFrom };
        },
        run: syncOctopusMeters,
      },
    ],
    tariff_prices: {
      steps: [{ step: 'tariff', order: 70, connection: 'tariff', when: (p) => p.conns.has('tariff'), run: (ctx) => syncEnvTariffs(ctx) }],
      via: ['octopus'],
      idle: 'priced in the meter step from the home\'s Octopus account, or from tariff codes in .env',
    },
    tariff_catalogue: { steps: [], via: ['compare'], idle: 'read by the comparison step' },
  },
});

// ───────────── Gas calorific value: National Gas (GB), one series per zone ─────────────

const gasZone = (siteId) => db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId)
  .map((d) => JSON.parse(d.attrs || '{}')).find((a) => a.gasUnit?.unit === 'm3' && a.ldz)?.ldz ?? null;

registerAdapter('national_gas', {
  roles: {
    gas_cv: {
      steps: [{
        // Daily calorific value for the gas meter's zone, to convert m3 to kWh.
        step: 'gas_cv', order: 60, connection: 'gas_cv', ensure: true,
        applies: (ctx) => !!db.prepare("SELECT 1 FROM device WHERE site_id = ? AND kind = 'meter_gas'").get(ctx.siteId),
        prepare: (ctx) => ({
          from: !lastSuccess(ctx.siteId, 'gas_cv') ? dayBounds(ctx.tz, addDays(ctx.today, -INITIAL_DAYS))[0]
            : dayBounds(ctx.tz, resumeDate(ctx.siteId, 'gas_cv', ctx.tz, ctx.today, ctx.fromDate, 2, 365))[0] - 86400,
        }),
        share: (ctx, a) => { const ldz = gasZone(ctx.siteId); return ldz ? { key: `gas_cv:${ldz}`, from: a.from } : null; },
        run: (ctx, a) => syncGasCv(ctx.site, a.from, nowSec()),
      }],
      idle: 'runs once the home has a gas meter',
    },
  },
});

// ───────────── Tariff catalogue (GB): Tariffscanner, the core's own credential ─────────────

// A catalogue shared by every home: run by whichever GB home's sync comes first, once per cycle
// (TARIFFSCANNER_KEY in the cycle) and once a day at most (provider_state, checked before running,
// so a home that finds it not due logs nothing). Its 20 requests a minute are per credential, and
// anything else using the same credential spends them too: so the sweep is incremental after the
// first, has a hard request budget per run, and stops on a 429 (src/adapters/tariffscanner.js).
// A failure is recorded on the home's 'tariffscanner' connection row and in provider_state; the
// home's other steps still run. forceTariffscannerSweep() (same module) sweeps now, by hand.
const TARIFFSCANNER_KEY = 'tariff_catalogue:tariffscanner';

registerAdapter('tariffscanner', {
  credentials: () => credentialsFromEnv(),
  roles: {
    tariff_catalogue: {
      steps: [{
        step: 'tariffscanner', order: 75, connection: 'tariffscanner', ensure: true,
        applies: (ctx) => !ctx.cycle.shared.has(TARIFFSCANNER_KEY) && sweepDue(),
        run: (ctx, a, creds) => {
          ctx.cycle.shared.set(TARIFFSCANNER_KEY, { siteId: ctx.siteId, from: Infinity, startedMs: Date.now() });
          return sweepCatalogue({ client: clientFor(creds) });
        },
      }],
      status: () => sweepStatus(),
    },
  },
});

// ───────────── tounify v3 (FR, NL; an EU tariff source, not UK): per-home prices, shared catalogue ─────────────

// Listed switched on but unlicensed (src/db/seed/providers.js), so the plan skips both roles with
// 'unlicensed: ...' until the licence is confirmed; TOUNIFY_DEV=1 with a test token overrides that
// for development (licenceOverride; the plan entry and every row it writes say so).
// tariff_prices runs for a home with a tounify connection (registered by POST /api/sites/:id/connections,
// one connection per home), at most once a UTC day and never before tounify's `next`; the catalogue
// runs for the first home of a market each cycle, once a week per market. The core's own token from
// .env (TOUNIFY_API_KEY), with the allowance guard of src/adapters/tounify.js.
const tounifyCatalogueKey = (ctx) => `tariff_catalogue:tounify:${ctx.site.market_code ?? ctx.site.country}`;

registerAdapter('tounify', {
  connection: 'tounify',
  label: TU.LABEL,
  registers: 'POST /api/sites/:id/connections with { provider: "tounify", postal_code, consumption_tariff, feedin_tariff?, capacity?, metering?, grid_operator? }',
  credentials: () => TU.credentialsFromEnv(),
  licenceOverride: (row, e) => (row.adapter === 'tounify' ? TU.devOverrideLabel(e) : null),
  roles: {
    tariff_prices: {
      steps: [{
        step: 'tounify', order: 70, connection: 'tounify',
        applies: (ctx) => TU.priceReadDue(ctx.siteId).due,
        run: async (ctx, a, creds) => {
          const r = await TU.syncTounifyHome({ site: ctx.site, client: TU.clientFor(creds), dev: creds?.dev ?? null });
          if (r.agreements_changed) ctx.agreementsChanged = true;
          if (r.failed) throw new Error(r.error);   // soft: the step fails, the sync goes on
          return r;
        },
      }],
      status: (d, site) => TU.homeStatus(site),
    },
    tariff_catalogue: {
      steps: [{
        step: 'tounify_catalogue', order: 75, connection: null,
        applies: (ctx) => !ctx.cycle.shared.has(tounifyCatalogueKey(ctx)) && TU.catalogueDue(ctx.site.market_code ?? ctx.site.country),
        run: (ctx, a, creds) => {
          ctx.cycle.shared.set(tounifyCatalogueKey(ctx), { siteId: ctx.siteId, from: Infinity, startedMs: Date.now() });
          return TU.refreshCatalogue({ country: ctx.site.market_code ?? ctx.site.country, client: TU.clientFor(creds) });
        },
      }],
      status: (d, site) => TU.catalogueStatus(site.market_code ?? site.country),
    },
  },
});

// ───────────── Comparison tariffs (GB): Octopus reference products and their public rates ─────────────

registerAdapter('compare', {
  roles: {
    compare: [{
      step: 'compare', order: 80, connection: 'compare', ensure: true,
      prepare: (ctx) => {
        const cmpFirst = !lastSuccess(ctx.siteId, 'compare');
        const cmpFrom = cmpFirst ? dayBounds(ctx.tz, addDays(ctx.today, -Math.max(INITIAL_DAYS, 30)))[0] : dayBounds(ctx.tz, resumeDate(ctx.siteId, 'compare', ctx.tz, ctx.today, ctx.fromDate, 1, 365))[0];
        return { from: cmpFrom - 86400 };
      },
      // One set of reference tariffs per region: a later home in the region takes the product
      // codes the first one found (connection meta) and the prices already stored.
      share: (ctx, a) => { const region = octopusRegion(ctx.site); return region ? { key: `compare:${ctx.site.market_code ?? 'GB'}:${region}`, from: a.from } : null; },
      onShared: (ctx, hit) => db.prepare(`UPDATE connection SET meta = (SELECT meta FROM connection WHERE site_id = ? AND provider = 'compare')
        WHERE site_id = ? AND provider = 'compare'`).run(hit.siteId, ctx.siteId),
      run: (ctx, a) => syncComparison(ctx.site, a.from, nowSec() + 2 * 86400),
    }],
  },
});

// ───────────── Solar forecast: Quartz ─────────────

registerAdapter('quartz', {
  roles: {
    solar_forecast: [{ step: 'solar_forecast', order: 90, connection: 'solar_forecast', shareResponses: true, run: (ctx) => syncQuartz(ctx.site) }],
  },
});

// ───────────── Manual entry: prices typed in (any market that lists it) ─────────────

registerAdapter('manual', {
  connection: null,
  roles: {
    tariff_prices: {
      steps: [],
      idle: 'typed in by the user or installer: nothing to fetch',
      status: (d, site) => (d.prepare(`SELECT 1 FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id
          WHERE a.site_id = ? AND a.superseded_at IS NULL AND t.origin = 'user' LIMIT 1`).get(site.id)
        ? { status: 'ok', reason: 'tariff typed in' } : { status: 'skipped', reason: 'no tariff typed in yet' }),
    },
  },
});
