// HTTP API and static pages. Every endpoint reads the serving tables (site_hh,
// site_day) or the forecast; none of them talks to a provider directly.
import express from 'express';
import { demoRouter } from './demo.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dataDir, dbFile } from './db/db.js';
import { buildSite, METHOD_VERSION } from './core/build.js';
import { forecastSite } from './core/forecast.js';
import { solarExpected } from './core/solar-expected.js';
import { insightsFor } from './core/insights.js';
import { compareSite } from './core/compare.js';
import { nowSec, localDate, addDays, dayBounds, SLOT, floorTo, zonedParts } from './core/time.js';
import { seriesId, readReadings } from './core/facts.js';
import { loadPricing, priceAt } from './core/pricing.js';
import { ensureEnvSite, syncSite, startScheduler, isSyncing, closeInterruptedRuns } from './jobs/sync.js';
import { runMaintenance } from './core/maintenance.js';
import { trustFor } from './core/trust.js';
import { attributeHistory, attributeAt } from './core/attributes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use('/api', (req, res, next) => {
  if (process.env.DEMO_OFFLINE === '1' && !['GET', 'HEAD'].includes(req.method)) {
    return res.status(405).json({ error: 'This recorded demo is read-only. Live sync and rebuild actions are disabled.' });
  }
  next();
});
app.use('/api/demo', demoRouter);
// This branch serves only the focused demo. The full UI remains on main.
app.use('/img', express.static(path.join(here, '..', 'public', 'img')));
app.use(express.static(path.join(here, '..', 'public', 'demo')));
for (const route of ['/', '/timeline', '/evidence']) {
  app.get(route, (req, res) => res.sendFile(path.join(here, '..', 'public', 'demo', 'index.html')));
}

const IMP = 'import_rate_ex * (1 + import_vat)';
const site = (req) => {
  const s = db.prepare('SELECT * FROM site WHERE id = ?').get(Number(req.params.id));
  if (!s) { const e = new Error('No such home'); e.status = 404; throw e; }
  return s;
};

function periodRange(s, period, from, to) {
  const today = localDate(s.timezone, nowSec());
  if (from && to) return { from, to };
  switch (period) {
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    default: return { from: today, to: today };
  }
}

// ───────────── Homes and sync ─────────────

// Liveness for the supervisor: answers only if the process is responsive and the database
// can be read. Also reports the last sync, so a stuck scheduler is visible.
const startedAt = nowSec();
app.get('/api/status', (req, res) => {
  const last = db.prepare('SELECT started_at, finished_at, status FROM sync_run ORDER BY id DESC LIMIT 1').get();
  res.json({ ok: true, uptimeS: nowSec() - startedAt, method: METHOD_VERSION, lastSync: last ?? null });
});

app.get('/api/sites', (req, res) => {
  const sites = db.prepare('SELECT * FROM site ORDER BY is_demo, id').all();
  res.json(sites.map((s) => ({
    ...s,
    syncing: isSyncing(s.id),
    connections: db.prepare('SELECT provider, external_ref, status, last_success_at, last_error FROM connection WHERE site_id = ? ORDER BY provider').all(s.id),
    lastSync: db.prepare('SELECT * FROM sync_run WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(s.id) || null,
    days: db.prepare('SELECT MIN(local_date) AS first, MAX(local_date) AS last, COUNT(*) AS n FROM site_day WHERE site_id = ?').get(s.id),
  })));
});

app.post('/api/sites/:id/sync', (req, res) => {
  const s = site(req);
  syncSite(s.id).catch((err) => console.error('sync:', err.message));
  res.json({ started: true });
});

// Rebuild every served row from facts. Same facts and method give the same numbers.
app.post('/api/sites/:id/rebuild', (req, res) => {
  const s = site(req);
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(s.id).d;
  if (!first) return res.json({ days: 0 });
  const before = db.prepare('SELECT ROUND(SUM(total_cost), 6) AS c, ROUND(SUM(home), 6) AS h, COUNT(*) AS n FROM site_hh WHERE site_id = ?').get(s.id);
  const t0 = Date.now();
  const r = buildSite(s.id, first, localDate(s.timezone, nowSec()), { reason: 'full rebuild requested' });
  const after = db.prepare('SELECT ROUND(SUM(total_cost), 6) AS c, ROUND(SUM(home), 6) AS h, COUNT(*) AS n FROM site_hh WHERE site_id = ?').get(s.id);
  res.json({ ...r, ms: Date.now() - t0, method: METHOD_VERSION, before, after });
});

// ───────────── Now ─────────────

app.get('/api/sites/:id/now', (req, res) => {
  const s = site(req);
  const now = nowSec();
  const metrics = ['solar_w', 'load_w', 'grid_import_w', 'grid_export_w', 'battery_charge_w', 'battery_discharge_w', 'battery_soc_pct', 'ev_w'];
  let live = null;
  for (const source of ['sunsynk_live', 'sunsynk_5min']) {
    const rows = metrics.map((m) => [m, readReadings([seriesId('site', s.id, m, source)], now - 3 * 3600, now + 60).pop()]);
    const latest = Math.max(0, ...rows.map(([, r]) => r?.ts || 0));
    if (latest) {
      live = { source, ts: latest, ageSeconds: now - latest };
      for (const [m, r] of rows) live[m] = r && r.ts === latest ? r.value : (r ? r.value : null);
      break;
    }
  }
  const slot = floorTo(now, SLOT);
  const pricing = loadPricing(s.id, slot - SLOT, slot + 8 * SLOT);
  const priceRow = (t) => {
    const i = priceAt(pricing, 'meter_import', t); const e = priceAt(pricing, 'meter_export', t);
    return { slot: t, import: i?.unitEx != null ? i.unitEx * (1 + i.vat) : null, export: e?.unitEx != null ? e.unitEx * (1 + e.vat) : null, tariff: i?.tariffCode ?? null };
  };
  const carbon = s.carbon_region != null ? db.prepare(
    `SELECT f.value, f.issued_at FROM forecast_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id
     WHERE se.subject_kind = 'region' AND se.subject_id = ? AND m.code = 'carbon_intensity' AND f.start_ts = ?
     ORDER BY f.issued_at DESC LIMIT 1`).get(`carbon:${s.carbon_region}`, slot) : null;
  const today = db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date = ?').get(s.id, localDate(s.timezone, now));
  res.json({ at: now, live, price: priceRow(slot), next: [1, 2, 3, 4, 5, 6].map((k) => priceRow(slot + k * SLOT)), carbon: carbon?.value ?? null, today: today || null });
});

// ───────────── Timeline and summary ─────────────

const HH_COLS = `slot_start, local_date, state, quality, solar, grid_import, grid_export, battery_charge, battery_discharge, home, loss, gas, ev, soc_end,
  solar_to_home, solar_to_battery, solar_to_grid, battery_to_home, battery_to_grid, grid_to_home, grid_to_battery,
  ${IMP} AS import_rate, export_rate, grid_to_home_cost, grid_to_battery_cost, battery_to_home_cost, export_credit, standing_cost,
  total_cost, grid_only_cost, saving, carbon_intensity, carbon_g, outdoor_temp, solar_forecast, meter_vs_ct`;

app.get('/api/sites/:id/timeline', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period, req.query.from, req.query.to);
  const step = req.query.step || (from === to ? 'hh' : (Date.parse(to) - Date.parse(from)) / 86400000 > 8 ? 'day' : 'hh');
  const rows = step === 'day'
    ? db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date').all(s.id, from, to)
    : db.prepare(`SELECT ${HH_COLS} FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY slot_start`).all(s.id, from, to);
  const [a] = dayBounds(s.timezone, from);
  const [, b] = dayBounds(s.timezone, to);
  res.json({ from, to, step, start: a, end: b, timezone: s.timezone, rows });
});

function summarise(s, from, to, before = 9000000000) {
  const t = db.prepare(`SELECT COUNT(*) AS slots,
      SUM(state = 'final') AS final, SUM(state = 'provisional') AS provisional, SUM(state = 'missing') AS missing,
      SUM(solar) AS solar, SUM(grid_import) AS grid_import, SUM(grid_export) AS grid_export, SUM(battery_charge) AS battery_charge,
      SUM(battery_discharge) AS battery_discharge, SUM(home) AS home, SUM(ev) AS ev, SUM(gas) AS gas,
      SUM(solar_to_home) AS solar_to_home, SUM(solar_to_battery) AS solar_to_battery, SUM(solar_to_grid) AS solar_to_grid,
      SUM(battery_to_home) AS battery_to_home, SUM(battery_to_grid) AS battery_to_grid, SUM(grid_to_home) AS grid_to_home, SUM(grid_to_battery) AS grid_to_battery,
      SUM(grid_to_home_cost) AS grid_to_home_cost, SUM(grid_to_battery_cost) AS grid_to_battery_cost, SUM(battery_to_home_cost) AS battery_to_home_cost,
      SUM(solar_to_loss) AS solar_to_loss, SUM(battery_to_loss) AS battery_to_loss, SUM(grid_to_loss) AS grid_to_loss, SUM(loss_cost) AS loss_cost,
      SUM(CASE WHEN loss > 0 THEN loss END) AS inverter_loss,
      SUM(export_credit) AS export_credit, SUM(standing_cost) AS standing_cost, SUM(gas_cost) AS gas_cost,
      SUM(total_cost) AS total_cost, SUM(grid_only_cost) AS grid_only_cost, SUM(saving) AS saving, SUM(rate_found = 0) AS unpriced,
      SUM(carbon_g) AS carbon_g, SUM(carbon_saved_g) AS carbon_saved_g,
      SUM(CASE WHEN battery_to_home_cost IS NOT NULL THEN battery_to_home END) AS battery_to_home_costed,
      SUM(solar_to_home * ${IMP}) AS solar_home_value, SUM(solar_to_grid * export_rate) AS solar_export_value,
      SUM(battery_to_home * ${IMP}) AS battery_avoided, SUM(battery_to_grid * export_rate) AS battery_export_value,
      SUM(grid_import * ${IMP}) AS import_paid, AVG(${IMP}) AS avg_import_rate, AVG(export_rate) AS avg_export_rate,
      SUM(CASE WHEN home > 0 THEN ev * (grid_to_home_cost + battery_to_home_cost) / home ELSE 0 END) AS ev_cost,
      SUM(CASE WHEN home > 0 THEN ev * solar_to_home / home ELSE 0 END) AS ev_from_solar,
      MAX(grid_import) * 2 AS peak_import_kw, MIN(soc_end) AS soc_min, MAX(soc_end) AS soc_max,
      SUM(solar_forecast) AS solar_forecast, SUM(CASE WHEN solar_forecast IS NOT NULL THEN solar END) AS solar_with_forecast
    FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND slot_start < ?`).get(s.id, from, to, before);
  const d = (a, b) => (a != null && b ? a / b : null);
  return {
    ...t,
    self_sufficiency: t.home ? 1 - t.grid_to_home / t.home : null,
    self_consumption: t.solar ? (t.solar_to_home + t.solar_to_battery) / t.solar : null,
    // Unknown when some battery energy used has no known stored cost.
    blended_rate: (t.battery_to_home || 0) - (t.battery_to_home_costed || 0) > 0.01 ? null : d(t.grid_to_home_cost + t.battery_to_home_cost, t.home),
    import_rate_paid: d(t.import_paid, t.grid_import),
    export_rate_avg: d(t.export_credit, t.grid_export),
    // Only half-hours whose stored energy has a known cost.
    battery_stored_rate: d(t.battery_to_home_cost, t.battery_to_home_costed),
    battery_value: t.battery_avoided != null ? t.battery_avoided + (t.battery_export_value || 0) - (t.grid_to_battery_cost || 0) : null,
    solar_value: t.solar_home_value != null ? t.solar_home_value + (t.solar_export_value || 0) : null,
    battery_cycles: s.battery_kwh ? t.battery_discharge / s.battery_kwh : null,
    battery_losses: t.battery_charge != null ? t.battery_charge - t.battery_discharge : null,
    ev_rate: d(t.ev_cost, t.ev),
    forecast_accuracy: t.solar_forecast ? t.solar_with_forecast / t.solar_forecast : null,
  };
}

// ───────────── Trust ─────────────

// Coverage, arrival, cross-checks, balance, revisions, corrections and system details for a period.
app.get('/api/sites/:id/trust', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period || '7d', req.query.from, req.query.to);
  res.json(trustFor(s.id, from, to));
});

// Every recorded version of a day (or of all days in a period), oldest first.
app.get('/api/sites/:id/revisions', (req, res) => {
  const s = site(req);
  const { from, to } = req.query.date ? { from: req.query.date, to: req.query.date } : periodRange(s, req.query.period || '30d', req.query.from, req.query.to);
  const rows = db.prepare('SELECT * FROM site_day_revision WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date, revised_at, id').all(s.id, from, to)
    .map((r) => ({ ...r, checks: JSON.parse(r.checks || '{}'), inputs: JSON.parse(r.inputs || '{}'), changed: r.changed ? JSON.parse(r.changed) : null }));
  res.json({ from, to, revisions: rows, attributes: attributeHistory(s.id) });
});

// A day rebuilt as the core knew it at `at` (unix seconds), next to how it stands now.
// Nothing is written. Every fact, price and system detail is read as it was at that moment.
app.get('/api/sites/:id/asof', (req, res) => {
  const s = site(req);
  const date = String(req.query.date || '');
  const at = Number(req.query.at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(at)) return res.status(400).json({ error: 'date=YYYY-MM-DD and at=<unix seconds> are required' });
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(s.id).d;
  if (!first || date < first) return res.status(404).json({ error: 'no data for that day' });
  const [dayStart] = dayBounds(s.timezone, date);
  if (at <= dayStart) return res.json({ date, at, known: false, note: 'the day had not started at that moment' });
  const t0 = Date.now();
  const then = buildSite(s.id, first, date, { asOf: Math.min(at, nowSec()), dryRun: true });
  const pick = (r) => ({ slot_start: r.slot_start, state: r.state, solar: r.solar, home: r.home, grid_import: r.grid_import, grid_export: r.grid_export, gas: r.gas, total_cost: r.total_cost, import_source: JSON.parse(r.lineage || '{}').import ?? null });
  res.json({
    date, at, ms: Date.now() - t0, method: METHOD_VERSION, known: true,
    then: { day: then.dayRows.find((d) => d.local_date === date) ?? null, hh: then.hhRows.filter((r) => r.local_date === date).map(pick),
      checks: then.checks.filter((c) => c[0] === date).map(([, code, status, measured, tolerance, detail]) => ({ code, status, measured, tolerance, detail })), inputs: then.inputs[date] ?? null,
      approximations: then.approximations },
    now: { day: db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date = ?').get(s.id, date) ?? null,
      hh: db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND local_date = ? ORDER BY slot_start').all(s.id, date).map(pick),
      checks: db.prepare('SELECT check_code AS code, status, measured, tolerance, detail FROM check_result WHERE site_id = ? AND local_date = ?').all(s.id, date) },
  });
});

app.get('/api/sites/:id/summary', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period, req.query.from, req.query.to);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  res.json({
    from, to, days, battery_kwh: s.battery_kwh, pv_kwp: s.pv_kwp,
    current: summarise(s, from, to),
    // "Today so far" is compared with yesterday up to the same time of day.
    previous: summarise(s, addDays(from, -days), addDays(to, -days), req.query.period === 'today' || (!req.query.period && !req.query.from) ? nowSec() - 86400 : undefined),
    previousLabel: req.query.period === 'today' || (!req.query.period && !req.query.from) ? 'same time yesterday' : 'previous period',
    // What the figures rest on: half-hour states and check results for the same days.
    basis: {
      ...db.prepare(`SELECT COUNT(*) AS halfHours, SUM(state = 'final') AS final, SUM(state = 'provisional') AS provisional, SUM(state = 'missing') AS missing
        FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ?`).get(s.id, from, to),
      checks: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ? GROUP BY status').all(s.id, from, to).map((r) => [r.status, r.n])),
    },
  });
});

// Tariffs in force for each meter, with the latest standing charge and (for flat tariffs) unit price.
app.get('/api/sites/:id/tariffs', (req, res) => {
  const s = site(req);
  const now = nowSec();
  const rows = db.prepare(`SELECT d.kind, d.label, t.tariff_code, t.name, t.structure, t.direction, a.valid_from, a.valid_to
    FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id
    WHERE a.site_id = ? AND a.superseded_at IS NULL ORDER BY d.kind, a.valid_from DESC`).all(s.id);
  const pricing = loadPricing(s.id, now - SLOT, now + SLOT);
  res.json(rows.map((r) => {
    const live = r.valid_from <= now && (r.valid_to == null || r.valid_to > now);
    const p = live ? priceAt(pricing, r.kind, floorTo(now, SLOT)) : null;
    return { ...r, current: live, unitNow: p?.unitEx != null ? p.unitEx * (1 + p.vat) : null, standingPerDay: p ? p.standingEx * (1 + p.vat) : null, vat: p?.vat ?? null };
  }));
});

// Breakdown of a period: every flow with its kWh and money, the saving split by
// cause (it adds up exactly to grid-only minus actual), the average day, imports
// by price band, and a per-day ledger.
app.get('/api/sites/:id/breakdown', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period, req.query.from, req.query.to);
  const t = summarise(s, from, to);
  const x = db.prepare(`SELECT
      SUM(solar_to_grid * export_rate) AS solar_export_credit, SUM(battery_to_grid * export_rate) AS battery_export_credit,
      SUM(CASE WHEN rate_found = 1 THEN grid_only_cost END) AS grid_only, SUM(CASE WHEN rate_found = 1 THEN total_cost END) AS actual,
      SUM(CASE WHEN rate_found = 1 THEN solar_to_home * ${IMP} END) AS solar_direct,
      SUM(CASE WHEN rate_found = 1 THEN battery_to_home * ${IMP} END) AS battery_cover,
      SUM(CASE WHEN rate_found = 1 THEN grid_to_battery_cost END) AS grid_charging,
      SUM(CASE WHEN rate_found = 1 THEN loss_cost END) AS loss_priced,
      SUM(CASE WHEN rate_found = 1 THEN export_credit END) AS export_earned,
      SUM(CASE WHEN rate_found = 1 THEN standing_cost END) AS standing, SUM(CASE WHEN rate_found = 1 THEN gas_cost END) AS gas_cost,
      SUM(CASE WHEN rate_found = 1 THEN home * ${IMP} END) AS home_at_grid_price,
      SUM(home * carbon_intensity) AS carbon_grid_only_g, SUM(grid_export * carbon_intensity) AS carbon_export_displaced_g,
      SUM(CASE WHEN carbon_intensity IS NOT NULL THEN grid_import END) AS import_with_carbon,
      AVG(carbon_intensity) AS carbon_avg, MIN(carbon_intensity) AS carbon_min, MAX(carbon_intensity) AS carbon_max,
      SUM(carbon_intensity IS NULL) AS carbon_missing
    FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ?`).get(s.id, from, to);

  const rows = db.prepare(`SELECT slot_start, solar, home, grid_import, grid_export, solar_to_home, solar_to_battery, solar_to_grid,
      battery_to_home, battery_to_grid, grid_to_home, grid_to_battery, ${IMP} AS import_rate, export_rate, carbon_intensity
    FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND state != 'missing'`).all(s.id, from, to);

  // Average day by local half-hour of day.
  const keys = ['solar', 'home', 'grid_import', 'grid_export', 'solar_to_home', 'solar_to_battery', 'solar_to_grid', 'battery_to_home', 'battery_to_grid', 'grid_to_home', 'grid_to_battery', 'import_rate', 'export_rate'];
  const prof = Array.from({ length: 48 }, (_, i) => ({ index: i, n: 0, nRate: 0, nCarbon: 0, carbon: 0, ...Object.fromEntries(keys.map((k) => [k, 0])) }));
  for (const r of rows) {
    const { hh, mm } = zonedParts(s.timezone, r.slot_start);
    const p = prof[hh * 2 + (mm >= 30 ? 1 : 0)];
    p.n++;
    for (const k of keys) if (k !== 'import_rate' && k !== 'export_rate') p[k] += r[k] || 0;
    if (r.import_rate != null) { p.nRate++; p.import_rate += r.import_rate; p.export_rate += r.export_rate || 0; }
    if (r.carbon_intensity != null) { p.nCarbon++; p.carbon += r.carbon_intensity; }
  }
  const profile = prof.map((p) => ({
    index: p.index, days: p.n,
    ...Object.fromEntries(keys.filter((k) => !k.endsWith('_rate')).map((k) => [k, p.n ? p[k] / p.n : null])),
    import_rate: p.nRate ? p.import_rate / p.nRate : null, export_rate: p.nRate ? p.export_rate / p.nRate : null,
    carbon_intensity: p.nCarbon ? p.carbon / p.nCarbon : null,
  }));

  // Imports grouped by the price paid.
  const bands = [[-Infinity, 0, 'Below 0p (paid to use)'], [0, 10, '0–10p'], [10, 20, '10–20p'], [20, 30, '20–30p'], [30, Infinity, '30p and over']]
    .map(([lo, hi, label]) => ({ label, lo, hi, kwh: 0, cost: 0, slots: 0 }));
  for (const r of rows) {
    if (r.import_rate == null || !r.grid_import) continue;
    const b = bands.find((x) => r.import_rate >= x.lo && r.import_rate < x.hi);
    b.kwh += r.grid_import; b.cost += r.grid_import * r.import_rate; b.slots++;
  }

  // Ledger: the days in the period, or the last 7 days for a single-day view.
  const ledgerFrom = from === to ? addDays(to, -6) : from;
  const ledger = db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date DESC').all(s.id, ledgerFrom, to);

  res.json({ from, to, days: (Date.parse(to) - Date.parse(from)) / 86400000 + 1, totals: { ...t, ...x }, profile, bands: bands.filter((b) => b.kwh > 0 || b.lo >= 0), ledger, ledgerFrom });
});

app.get('/api/sites/:id/compare', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period || '7d', req.query.from, req.query.to);
  res.json(compareSite(s.id, from, to));
});

// Everything on one time axis: half-hours (past and forecast), the parts of the
// system with their sources, and events (syncs, data arrivals, tariff changes,
// smart-charge slots, forecast issues, warnings, quarantined payloads).
app.get('/api/sites/:id/everything', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period, req.query.from, req.query.to);
  const [start] = dayBounds(s.timezone, from);
  const [, end] = dayBounds(s.timezone, to);
  const now = nowSec();
  const rows = db.prepare(`SELECT slot_start, local_date, state, quality, solar, grid_import, grid_export, battery_charge, battery_discharge, home, gas, ev, soc_end,
      solar_to_home, battery_to_home, grid_to_home, solar_to_battery, grid_to_battery, solar_to_grid, battery_to_grid, loss, loss_cost,
      ${IMP} AS import_rate, export_rate, total_cost, grid_only_cost, saving, gas_cost, carbon_intensity, outdoor_temp, solar_forecast,
      grid_to_home_cost, battery_to_home_cost, lineage
    FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start`).all(s.id, start, end)
    .map((r) => { const l = JSON.parse(r.lineage || '{}'); delete r.lineage; return { ...r, import_source: l.import, tariff: l.tariff, register: l.register }; });

  // After now: the forecast, so the chart runs past, now and ahead on one axis.
  let forecast = [];
  if (end > now) {
    const f = forecastSite(s.id, 48);
    const last = rows.length ? rows[rows.length - 1].slot_start : 0;
    forecast = f.slots.filter((x) => x.slot_start > last && x.slot_start < Math.max(end, now + 12 * 3600)).map((x) => ({
      slot_start: x.slot_start, local_date: x.local_date, state: 'forecast', solar: x.solar, home: x.home, ev: x.ev, soc_end: x.soc_end,
      grid_import: x.grid_import, grid_export: x.grid_export, battery_charge: x.battery_charge, battery_discharge: x.battery_discharge,
      solar_to_home: x.solar != null && x.home != null ? Math.min(x.solar, x.home) : null, battery_to_home: x.battery_discharge,
      // Forecast import includes grid charging of the battery; only the rest went to the house.
      solar_to_battery: x.solar_to_battery ?? null, grid_to_battery: x.grid_to_battery ?? 0,
      grid_to_home: x.grid_import != null ? Math.max(0, x.grid_import - (x.grid_to_battery ?? 0)) : null,
      import_rate: x.import_rate, export_rate: x.export_rate, total_cost: x.cost, grid_only_cost: x.grid_only_cost, saving: x.saving,
      carbon_intensity: x.carbon_intensity, solar_forecast: x.solar,
    }));
  }
  const tEnd = forecast.length ? forecast[forecast.length - 1].slot_start + SLOT : end;

  const events = [];
  for (const r of db.prepare('SELECT * FROM sync_run WHERE site_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at').all(s.id, start, tEnd)) {
    const steps = JSON.parse(r.detail || '[]');
    const failed = steps.filter((x) => x.ok === false).map((x) => x.step);
    events.push({ ts: r.started_at, kind: 'sync', status: r.status, label: `Sync ${r.status}`, detail: failed.length ? `failed: ${failed.join(', ')}` : `${steps.length} steps ok` });
  }
  // When each day's meter data first arrived (Octopus delivers about a day late).
  const meterSeries = db.prepare(`SELECT se.id, d.kind FROM series se JOIN device d ON se.subject_kind = 'device' AND se.subject_id = CAST(d.id AS TEXT)
    WHERE d.site_id = ? AND d.kind IN ('meter_import','meter_export','meter_gas')`).all(s.id);
  for (const m of meterSeries) {
    const arrivals = new Map();
    for (const f of db.prepare('SELECT start_ts, MIN(recorded_at) AS rec, COUNT(*) AS n FROM interval_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? GROUP BY start_ts').all(m.id, start - 2 * 86400, tEnd)) {
      const day = localDate(s.timezone, f.start_ts);
      const a = arrivals.get(day) || { rec: Infinity, n: 0 };
      a.rec = Math.min(a.rec, f.rec); a.n++;
      arrivals.set(day, a);
    }
    const name = { meter_import: 'Import meter', meter_export: 'Export meter', meter_gas: 'Gas meter' }[m.kind];
    for (const [day, a] of arrivals) {
      const ts = Math.floor(a.rec / 1000);
      if (ts >= start && ts < tEnd) events.push({ ts, kind: 'data', label: `${name} data arrived`, detail: `${a.n} half-hours for ${day} (Octopus)` });
    }
  }
  for (const a of db.prepare(`SELECT a.valid_from, t.tariff_code, d.kind FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id JOIN device d ON d.id = a.device_id
      WHERE a.site_id = ? AND a.superseded_at IS NULL AND a.valid_from >= ? AND a.valid_from < ?`).all(s.id, start, tEnd)) {
    events.push({ ts: a.valid_from, kind: 'tariff', label: 'Tariff change', detail: `${a.kind.replace('meter_', '')}: ${a.tariff_code}` });
  }
  for (const q of db.prepare(`SELECT p.fetched_at, p.reason, src.code FROM raw_payload p JOIN source src ON src.id = p.source_id
      WHERE p.site_id = ? AND p.status = 'quarantined' AND p.fetched_at >= ? AND p.fetched_at < ?`).all(s.id, start, tEnd)) {
    events.push({ ts: q.fetched_at, kind: 'quarantine', label: `Quarantined ${q.code} payload`, detail: q.reason });
  }
  const quartz = seriesId('site', s.id, 'solar_kwh', 'quartz');
  for (const f of db.prepare('SELECT issued_at, SUM(value) AS kwh FROM forecast_fact WHERE series_id = ? AND issued_at >= ? AND issued_at < ? GROUP BY issued_at').all(quartz, start, tEnd)) {
    events.push({ ts: f.issued_at, kind: 'forecast', label: 'Solar forecast issued', detail: `Quartz, ${f.kwh.toFixed(1)} kWh over the next 48 h` });
  }
  for (const c of db.prepare("SELECT * FROM check_result WHERE site_id = ? AND status IN ('warn','fail') AND local_date >= ? AND local_date <= ?").all(s.id, from, to)) {
    events.push({ ts: dayBounds(s.timezone, c.local_date)[0], kind: 'check', status: c.status, label: `Check ${c.status}: ${c.check_code.replace(/_/g, ' ')}`, detail: c.detail });
  }
  const evSeries = seriesId('site', s.id, 'ev_charge_kwh', 'octopus_kraken');
  for (const d of db.prepare('SELECT start_ts, end_ts, value FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL AND end_ts > ? AND start_ts < ?').all(evSeries, start, tEnd)) {
    events.push({ ts: d.start_ts, end: d.end_ts, kind: 'dispatch', label: 'Smart-charge slot', detail: `${d.value != null ? `${d.value.toFixed(2)} kWh` : 'energy unknown'} (Kraken)` });
  }
  events.sort((a, b) => a.ts - b.ts);

  // The parts of the system, with what feeds each one and how fresh it is.
  const conns = Object.fromEntries(db.prepare('SELECT provider, external_ref, status, last_success_at, last_error FROM connection WHERE site_id = ?').all(s.id).map((c) => [c.provider, c]));
  const devices = db.prepare('SELECT kind, provider, external_ref, label, attrs FROM device WHERE site_id = ? AND retired_at IS NULL').all(s.id);
  const mask = (ref) => (ref && ref.length > 6 ? `…${ref.slice(-4)}` : ref);
  res.json({
    from, to, start, end: tEnd, now, timezone: s.timezone, rows, forecast, events,
    site: { name: s.name, postcode: s.postcode, pv_kwp: s.pv_kwp, battery_kwh: s.battery_kwh, region: s.gsp_region, is_demo: s.is_demo },
    connections: conns,
    devices: devices.map((d) => ({ kind: d.kind, provider: d.provider, label: d.label, ref: mask(d.external_ref), state: JSON.parse(d.attrs || '{}').status?.currentState || null })),
  });
});

app.get('/api/sites/:id/forecast', (req, res) => res.json(forecastSite(site(req).id, Math.min(Number(req.query.hours) || 48, 48))));
// Solar expected for the weather that happened (stored Open-Meteo sunlight × this home's own
// response, fitted leaving each day out), per past half-hour and day, against actual output.
app.get('/api/sites/:id/solar-expected', (req, res) => {
  const s = site(req);
  const { from, to } = periodRange(s, req.query.period, req.query.from, req.query.to);
  res.json(solarExpected(s.id, from, to));
});
app.get('/api/sites/:id/insights', (req, res) => res.json(insightsFor(site(req).id)));

// EV sessions: consecutive half-hours with EV charging, priced at the home's cost of energy in each slot.
app.get('/api/sites/:id/ev', (req, res) => {
  const s = site(req);
  const devices = db.prepare("SELECT id, label, provider, attrs FROM device WHERE site_id = ? AND kind = 'ev'").all(s.id);
  const { from, to } = periodRange(s, req.query.period || '30d');
  const rows = db.prepare(`SELECT slot_start, ev, home, solar_to_home, grid_to_home_cost, battery_to_home_cost, ${IMP} AS import_rate
    FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ? AND ev > 0.001 ORDER BY slot_start`).all(s.id, from, to);
  const sessions = [];
  for (const r of rows) {
    const cost = r.home > 0 ? (r.ev * ((r.grid_to_home_cost || 0) + (r.battery_to_home_cost || 0))) / r.home : 0;
    const solar = r.home > 0 ? (r.ev * r.solar_to_home) / r.home : 0;
    const last = sessions[sessions.length - 1];
    if (last && r.slot_start - last.end <= SLOT) {
      last.end = r.slot_start + SLOT; last.kwh += r.ev; last.cost += cost; last.solar += solar; last.peakRate = Math.max(last.peakRate, r.import_rate ?? 0); last.slots.push(r.slot_start);
    } else sessions.push({ start: r.slot_start, end: r.slot_start + SLOT, kwh: r.ev, cost, solar, peakRate: r.import_rate ?? 0, slots: [r.slot_start] });
  }
  const avgRate = db.prepare(`SELECT AVG(${IMP}) AS r FROM site_hh WHERE site_id = ? AND local_date >= ? AND local_date <= ?`).get(s.id, from, to).r;
  const fc = forecastSite(s.id, 24).slots.filter((x) => x.ev > 0).map((x) => ({ slot: x.slot_start, kwh: x.ev, rate: x.import_rate }));
  res.json({ from, to, devices, sessions: sessions.reverse(), averageImportRate: avgRate, planned: fc });
});

// ───────────── Trust: evidence, health, catalog ─────────────

app.get('/api/sites/:id/evidence', (req, res) => {
  const s = site(req);
  const slot = Number(req.query.slot);
  const row = db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND slot_start = ?').get(s.id, slot);
  if (!row) return res.status(404).json({ error: 'No half-hour at that time' });
  const pad = 600;
  const facts = db.prepare(`
    SELECT 'reading' AS kind, se.subject_kind, se.subject_id, m.code AS metric, m.unit, src.code AS source, r.ts AS start_ts, NULL AS end_ts,
           r.value, r.quality, r.recorded_at, r.superseded_at, r.raw_id
      FROM reading r JOIN series se ON se.id = r.series_id JOIN metric m ON m.id = se.metric_id JOIN source src ON src.id = se.source_id
     WHERE ((se.subject_kind = 'site' AND se.subject_id = ?) OR se.subject_kind = 'device') AND r.ts >= ? AND r.ts < ?
    UNION ALL
    SELECT 'interval', se.subject_kind, se.subject_id, m.code, m.unit, src.code, f.start_ts, f.end_ts, f.value, f.quality, f.recorded_at, f.superseded_at, f.raw_id
      FROM interval_fact f JOIN series se ON se.id = f.series_id JOIN metric m ON m.id = se.metric_id JOIN source src ON src.id = se.source_id
     WHERE (se.subject_kind = 'site' AND se.subject_id = ? OR se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?)
            OR se.subject_kind = 'region' AND se.subject_id = ?)
       AND f.start_ts < ? AND f.end_ts > ? AND (f.end_ts - f.start_ts <= 7200 OR src.code = 'sunsynk_daily')
    ORDER BY metric, start_ts, recorded_at`).all(String(s.id), slot - pad, slot + SLOT, String(s.id), s.id, `carbon:${s.carbon_region}`, slot + SLOT, slot)
    .filter((f) => f.subject_kind !== 'device' || f.kind === 'interval');
  const rates = db.prepare(`SELECT t.tariff_code, t.direction, r.component, r.register, r.payment_method, r.valid_from, r.valid_to, r.price_ex_vat, r.recorded_at, r.superseded_at, r.raw_id
    FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id JOIN tariff_agreement a ON a.tariff_id = t.id AND a.site_id = ? AND a.superseded_at IS NULL
    WHERE r.valid_from <= ? AND IFNULL(r.valid_to, 9000000000) > ? AND a.valid_from <= ? AND IFNULL(a.valid_to, 9000000000) > ?
    ORDER BY t.direction, r.component, r.superseded_at IS NOT NULL, r.recorded_at DESC`).all(s.id, slot, slot, slot, slot);
  const vat = db.prepare('SELECT * FROM vat_rate WHERE valid_from <= ? AND IFNULL(valid_to, 9000000000) > ?').all(slot, slot);
  const rawIds = [...new Set([...facts, ...rates].map((f) => f.raw_id).filter(Boolean))];
  const raws = rawIds.length ? db.prepare(`SELECT p.id, src.code AS source, p.request, p.fetched_at, p.status, p.file FROM raw_payload p JOIN source src ON src.id = p.source_id WHERE p.id IN (${rawIds.map(() => '?').join(',')})`).all(...rawIds) : [];
  const checks = db.prepare('SELECT check_code, status, measured, tolerance, detail FROM check_result WHERE site_id = ? AND local_date = ? ORDER BY check_code').all(s.id, row.local_date);
  const revisions = db.prepare('SELECT COUNT(*) AS n, MAX(revised_at) AS last FROM site_day_revision WHERE site_id = ? AND local_date = ?').get(s.id, row.local_date);
  res.json({ row: { ...row, lineage: JSON.parse(row.lineage || '{}') }, facts, rates, vat, raws, checks, revisions, timezone: s.timezone });
});

app.get('/api/raw/:rawId', (req, res) => {
  const r = db.prepare('SELECT p.*, src.code AS source FROM raw_payload p JOIN source src ON src.id = p.source_id WHERE p.id = ?').get(Number(req.params.rawId));
  if (!r) return res.status(404).json({ error: 'not found' });
  let body = fs.readFileSync(path.join(dataDir, r.file), 'utf8');
  const size = body.length;
  if (body.length > 200000) body = `${body.slice(0, 200000)}…`;
  res.json({ ...r, size, body });
});

app.get('/api/sites/:id/health', (req, res) => {
  const s = site(req);
  const today = localDate(s.timezone, nowSec());
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  res.json({
    site: s,
    connections: db.prepare('SELECT * FROM connection WHERE site_id = ? ORDER BY provider').all(s.id),
    runs: db.prepare('SELECT * FROM sync_run WHERE site_id = ? ORDER BY id DESC LIMIT 8').all(s.id).map((r) => ({ ...r, detail: JSON.parse(r.detail || '[]') })),
    days: db.prepare('SELECT local_date, slots, slots_final, slots_provisional, slots_missing, integrity, solar, home, total_cost FROM site_day WHERE site_id = ? ORDER BY local_date DESC LIMIT 31').all(s.id),
    checks: db.prepare('SELECT * FROM check_result WHERE site_id = ? AND local_date >= ? ORDER BY local_date DESC, check_code').all(s.id, addDays(today, -31)),
    quarantined: db.prepare('SELECT p.id, src.code AS source, p.request, p.fetched_at, p.reason FROM raw_payload p JOIN source src ON src.id = p.source_id WHERE p.site_id = ? AND p.status = ? ORDER BY p.id DESC LIMIT 20').all(s.id, 'quarantined'),
    restated: count('SELECT COUNT(*) AS n FROM site_hh WHERE site_id = ? AND quality & 128', s.id),
    storage: {
      dbBytes: fs.statSync(dbFile).size,
      raw: count('SELECT COUNT(*) AS n FROM raw_payload WHERE site_id = ?', s.id),
      readings: count('SELECT COUNT(*) AS n FROM reading r JOIN series se ON se.id = r.series_id WHERE se.subject_kind = ? AND se.subject_id = ?', 'site', String(s.id)),
      superseded: count('SELECT COUNT(*) AS n FROM reading r JOIN series se ON se.id = r.series_id WHERE se.subject_kind = ? AND se.subject_id = ? AND r.superseded_at IS NOT NULL', 'site', String(s.id)),
      intervals: count('SELECT COUNT(*) AS n FROM interval_fact'),
      forecasts: count('SELECT COUNT(*) AS n FROM forecast_fact'),
      rates: count('SELECT COUNT(*) AS n FROM rate_interval'),
      halfHours: count('SELECT COUNT(*) AS n FROM site_hh WHERE site_id = ?', s.id),
    },
    method: METHOD_VERSION,
  });
});

// The system's physical details, each with where its value comes from, so the UI can show
// which are confirmed and which are estimates waiting for the installer's figures.
app.get('/api/sites/:id/system', (req, res) => {
  const s = site(req);
  const plant = db.prepare("SELECT external_ref FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(s.id)?.external_ref;
  // Installer as recorded on the Sunsynk plant (latest stored plant payload).
  const plantRaw = plant ? db.prepare("SELECT file FROM raw_payload WHERE site_id = ? AND request LIKE ? ORDER BY id DESC LIMIT 1").get(s.id, `%/v1/plant/${plant}?%`) : null;
  let installer = null;
  try { installer = plantRaw ? JSON.parse(fs.readFileSync(path.join(dataDir, plantRaw.file), 'utf8'))?.data?.installer || null : null; } catch { /* payload unreadable: leave unknown */ }
  // Each detail as resolved from its versions (installer > measured > provider > estimated).
  const item = (key, attr, label, unit, mcs) => {
    const a = attributeAt(s.id, attr);
    return { key, label, value: a?.value ?? null, unit, mcs, status: a?.source ?? 'unknown', source: a?.detail ?? 'Not known' };
  };
  res.json({
    installer, installerSource: installer ? 'Sunsynk plant record' : null,
    items: [
      item('PV_KWP', 'pv_kwp', 'Panel size', 'kWp', 'System size (kWp) on the MCS certificate and performance estimate'),
      item('PV_TILT', 'pv_tilt', 'Panel tilt', '°', 'Inclination (roof pitch) in the MCS performance estimate'),
      item('PV_ORIENTATION', 'pv_orientation', 'Panel direction', '° (compass)', 'Orientation in the MCS performance estimate'),
      item('BATTERY_KWH', 'battery_kwh', 'Battery size', 'kWh', 'Usable capacity on the battery datasheet or in the handover pack'),
    ],
  });
});

// Devices the providers report for this home (meters, EV), with the attributes they gave.
app.get('/api/sites/:id/devices', (req, res) => {
  const s = site(req);
  res.json(db.prepare('SELECT kind, provider, label, attrs FROM device WHERE site_id = ? AND retired_at IS NULL').all(s.id)
    .map((d) => { const a = JSON.parse(d.attrs || '{}'); return { kind: d.kind, provider: d.provider, label: d.label, profileClass: a.profileClass ?? null, annualKwh: a.annualKwh ?? null, gasUnit: a.gasUnit ?? null, state: a.status?.currentState ?? null }; }));
});

app.get('/api/catalog', (req, res) => {
  res.json({
    sources: db.prepare('SELECT code, name, contract FROM source ORDER BY id').all().map((s) => ({ ...s, contract: JSON.parse(s.contract) })),
    metrics: db.prepare('SELECT code, label, unit, time_role, aggregation, domain FROM metric ORDER BY domain, code').all(),
    vat: db.prepare('SELECT * FROM vat_rate ORDER BY fuel, direction, valid_from').all(),
  });
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

// ───────────── Start ─────────────

closeInterruptedRuns();
const envSite = ensureEnvSite();
const maintenance = runMaintenance();
if (Object.values(maintenance).some((m) => m.gasKwhWithdrawn)) console.log('maintenance:', JSON.stringify(maintenance));
const port = Number(process.env.PORT) || 4100;
const server = app.listen(port, () => {
  const minutes = process.env.DEMO_OFFLINE === '1' ? null : startScheduler();
  console.log(`EnergieBee core demo on http://localhost:${port} (${minutes == null ? 'recorded snapshot; provider sync disabled' : `sync every ${minutes} min`})`);
  for (const { id, name } of (process.env.DEMO_OFFLINE === '1' ? [] : db.prepare('SELECT id, name FROM site').all())) {
    syncSite(id).then((r) => console.log(`synced ${name}: ${r.ok ? 'ok' : 'partial'}`)).catch((err) => console.error(`sync ${name}:`, err.message));
  }
});

// Stop cleanly when asked (Ctrl+C, the supervisor, launchd): stop taking requests and close
// the database. SQLite's write-ahead log keeps it consistent even if a write was cut short.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}
