// Why the timeline can be trusted, computed from the facts themselves: which source fed each
// half-hour and when it arrived, how independent measurements agree, what every day's energy
// balance is, what was corrected, and where every system detail came from. Read-only.
import { db } from '../db/db.js';
import { seriesId } from './facts.js';
import { SLOT, nowSec, dayBounds, slotsOfDay, daysBetween, localDate } from './time.js';
import { ATTRS, attributeAt, attributeHistory } from './attributes.js';

const HOUR = 3600; const DAY = 86400;

// Each feed: where its facts are, how many per half-hour are expected, and how soon after a
// half-hour ends its data normally arrives (later = late; not yet = waiting).
function feedsFor(site) {
  const sid = (metric, source) => seriesId('site', site.id, metric, source);
  const dev = (kind) => db.prepare("SELECT * FROM device WHERE site_id = ? AND kind = ? AND provider != 'env' AND retired_at IS NULL").get(site.id, kind);
  const out = [];
  if (db.prepare("SELECT 1 FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(site.id)) {
    out.push({ key: 'inverter', label: 'Inverter power, every 5 minutes', source: 'Sunsynk', kind: 'reading', series: sid('solar_w', 'sunsynk_5min'), perSlot: 6, dueS: HOUR,
      use: 'Solar, battery, house use and the grid clamp, half-hour by half-hour' });
  }
  const meters = [['meter_import', 'grid_import_kwh', 'Smart meter, import'], ['meter_export', 'grid_export_kwh', 'Smart meter, export'], ['meter_gas', null, 'Smart meter, gas']];
  for (const [kind, metric, label] of meters) {
    const d = dev(kind);
    if (!d) continue;
    const unit = JSON.parse(d.attrs || '{}').gasUnit?.unit;
    const m = metric || (unit === 'm3' ? 'gas_m3' : 'gas_kwh');
    out.push({ key: kind, label, source: 'Octopus', kind: 'interval', series: seriesId('device', d.id, m, 'octopus_meter'), perSlot: 1, dueS: 2 * DAY,
      use: kind === 'meter_gas' ? 'Gas use (m³), converted with the calorific value' : 'Grid import and export for the bill; replaces the clamp when it arrives' });
    if (kind === 'meter_gas' && unit === 'm3') {
      const ldz = JSON.parse(d.attrs || '{}').ldz;
      if (ldz) out.push({ key: 'gas_cv', label: `Gas calorific value (${ldz})`, source: 'National Gas', kind: 'cover', series: seriesId('region', `ldz:${ldz}`, 'gas_cv_mjm3', 'national_gas_cv'), dueS: 2 * DAY,
        use: 'Converts gas m³ to kWh for each gas day' });
    }
  }
  out.push({ key: 'import_price', label: 'Import price', source: 'Octopus tariff', kind: 'served', column: 'import_rate_ex', use: 'Cost of every imported kWh' });
  if (dev('meter_export') || db.prepare("SELECT 1 FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id WHERE a.site_id = ? AND a.superseded_at IS NULL AND t.direction = 'export'").get(site.id)) {
    out.push({ key: 'export_price', label: 'Export price', source: 'Octopus tariff', kind: 'served', column: 'export_rate', use: 'Credit for every exported kWh' });
  }
  if (site.carbon_region != null) out.push({ key: 'carbon', label: 'Grid carbon intensity', source: 'NESO', kind: 'interval', series: seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional'), perSlot: 1, dueS: DAY,
    use: 'Carbon of imported power and carbon avoided' });
  out.push({ key: 'weather', label: 'Sunlight and temperature', source: 'Open-Meteo', kind: 'cover', series: sid('ghi_wm2', 'open_meteo'), dueS: DAY, use: 'Solar forecast learning and the temperature fit' });
  out.push({ key: 'forecast', label: 'Solar forecast made in advance', source: 'Quartz / EnergieBee', kind: 'served', column: 'solar_forecast', startsWithFirst: true,
    use: 'Compares each half-hour with what was forecast before it' });
  return out;
}

// One character per half-hour: o on time · l late · h loaded with the history on first connection ·
// p partial · w waiting (not due yet) · m missing (overdue) · n not expected.
function feedCells(feed, slots, now, served) {
  const first = new Map(); const count = new Map();
  let firstEver = null;
  if (feed.kind === 'reading') {
    for (const r of db.prepare(`SELECT ts - (ts % ${SLOT}) AS s, SUM(superseded_at IS NULL) AS n, MIN(recorded_at) AS t FROM reading
        WHERE series_id = ? AND ts >= ? AND ts < ? GROUP BY s`).all(feed.series, slots[0], slots[slots.length - 1] + SLOT)) { count.set(r.s, r.n); first.set(r.s, r.t); }
    firstEver = db.prepare('SELECT MIN(recorded_at) AS t FROM reading WHERE series_id = ?').get(feed.series)?.t;
  } else if (feed.kind === 'interval' || feed.kind === 'cover') {
    const rows = db.prepare('SELECT start_ts, end_ts, recorded_at, superseded_at FROM interval_fact WHERE series_id = ? AND end_ts > ? AND start_ts < ?')
      .all(feed.series, slots[0], slots[slots.length - 1] + SLOT);
    for (const f of rows) {
      for (let s = f.start_ts - (f.start_ts % SLOT); s < f.end_ts; s += SLOT) {
        if (f.superseded_at == null) count.set(s, (count.get(s) || 0) + 1);
        first.set(s, Math.min(first.get(s) ?? Infinity, f.recorded_at));
      }
    }
    firstEver = db.prepare('SELECT MIN(recorded_at) AS t FROM interval_fact WHERE series_id = ?').get(feed.series)?.t;
  }
  const firstServed = feed.startsWithFirst ? slots.find((s) => served.get(s)?.[feed.column] != null) : null;
  let cells = '';
  const delays = new Map();
  for (const s of slots) {
    const end = s + SLOT;
    if (end > now) { cells += 'n'; continue; }
    if (feed.kind === 'served') {
      const v = served.get(s)?.[feed.column];
      if (v != null) cells += 'o';
      else if (feed.startsWithFirst && (firstServed == null || s < firstServed)) cells += 'n';
      else cells += 'm';
      continue;
    }
    const n = count.get(s) || 0;
    if (!n) { cells += now - end < feed.dueS ? 'w' : 'm'; continue; }
    const delay = first.get(s) / 1000 - end;
    delays.set(s, delay);
    if (firstEver != null && first.get(s) <= firstEver + 15 * 60 * 1000 && end * 1000 < firstEver) cells += 'h';
    else if (feed.perSlot && n < feed.perSlot - 1) cells += 'p';      // one 5-minute sample may fall either side of the boundary
    else cells += delay <= feed.dueS ? 'o' : 'l';
  }
  return { cells, delays };
}

export function trustFor(siteId, fromDate, toDate) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const tz = site.timezone;
  const now = nowSec();
  const dates = daysBetween(fromDate, toDate);
  const slots = dates.flatMap((d) => slotsOfDay(tz, d));
  const [fromTs] = dayBounds(tz, fromDate); const [, toTs] = dayBounds(tz, toDate);
  const hh = db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?').all(siteId, fromTs, toTs);
  const served = new Map(hh.map((r) => [r.slot_start, r]));
  const ldz = db.prepare("SELECT attrs FROM device WHERE site_id = ? AND kind = 'meter_gas'").all(siteId).map((d) => JSON.parse(d.attrs || '{}').ldz).find(Boolean) ?? null;

  // ── Feeds: coverage and arrival ──
  const feeds = feedsFor(site).map((f) => {
    const { cells, delays } = feedCells(f, slots, now, served);
    const byDay = dates.map((d) => {
      const idx = slots.map((s, i) => [s, i]).filter(([s]) => localDate(tz, s) === d);
      const cs = idx.map(([, i]) => cells[i]);
      const ds = idx.map(([s]) => delays.get(s)).filter((v) => v != null).sort((a, b) => a - b);
      const tally = (c) => cs.filter((x) => x === c).length;
      return { date: d, onTime: tally('o'), late: tally('l'), history: tally('h'), partial: tally('p'), waiting: tally('w'), missing: tally('m'), notExpected: tally('n'),
        medianDelayS: ds.length ? Math.round(ds[ds.length >> 1]) : null };
    });
    const { series, ...rest } = f;
    return { ...rest, cells, byDay };
  });

  // ── Cross-checks ──
  const checks = db.prepare('SELECT local_date, check_code, status, measured, tolerance, detail FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date, check_code')
    .all(siteId, fromDate, toDate);

  // ── Daily balance and the two-measurement comparisons ──
  const days = db.prepare('SELECT * FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date').all(siteId, fromDate, toDate);
  const counterS = (metric) => seriesId('site', siteId, metric, 'sunsynk_daily');
  const counters = [['solar', 'solar_kwh', 'Solar'], ['load', 'load_kwh', 'House (inverter load)'], ['import', 'grid_import_kwh', 'Grid import (clamp)'],
    ['export', 'grid_export_kwh', 'Grid export (clamp)'], ['charge', 'battery_charge_kwh', 'Battery charge'], ['discharge', 'battery_discharge_kwh', 'Battery discharge']];
  const balance = days.map((d) => {
    const [a] = dayBounds(tz, d.local_date);
    const rows = hh.filter((r) => r.local_date === d.local_date);
    const meterImp = rows.filter((r) => JSON.parse(r.lineage || '{}').import === 'octopus_meter');
    const meterExp = rows.filter((r) => JSON.parse(r.lineage || '{}').export === 'octopus_meter');
    const ct = (rs, k) => rs.reduce((s, r) => s + (JSON.parse(r.lineage || '{}').ct?.[k] ?? 0), 0);
    const sum = (rs, k) => rs.reduce((s, r) => s + (r[k] || 0), 0);
    return {
      date: d.local_date,
      // Every kWh in goes to exactly one place (the flows are built that way).
      in: { solar: d.solar, grid: d.grid_import, battery: d.battery_discharge },
      to: { home: d.home, grid: (d.solar_to_grid || 0) + (d.battery_to_grid || 0), battery: (d.solar_to_battery || 0) + (d.grid_to_battery || 0),
        inverter: (d.solar_to_loss || 0) + (d.battery_to_loss || 0) + (d.grid_to_loss || 0) },
      // Measured exports and charging that no source covered in the same half-hour: measurement mismatch.
      unmatched: { grid: (d.grid_export || 0) - (d.solar_to_grid || 0) - (d.battery_to_grid || 0), battery: (d.battery_charge || 0) - (d.solar_to_battery || 0) - (d.grid_to_battery || 0) },
      counters: counters.map(([k, metric, label]) => {
        const c = db.prepare('SELECT value FROM interval_fact WHERE series_id = ? AND start_ts = ? AND superseded_at IS NULL').get(counterS(metric), a)?.value ?? null;
        const chk = checks.find((x) => x.local_date === d.local_date && x.check_code === `counter_fit_${k}`);
        return { key: k, label, counterKwh: c, samplesKwh: c != null && chk?.measured ? c / chk.measured : null, status: chk?.status ?? null };
      }),
      meterVsClamp: {
        import: meterImp.length ? { halfHours: meterImp.length, meterKwh: sum(meterImp, 'grid_import'), clampKwh: ct(meterImp, 'imp') } : null,
        export: meterExp.length ? { halfHours: meterExp.length, meterKwh: sum(meterExp, 'grid_export'), clampKwh: ct(meterExp, 'exp') } : null,
      },
    };
  });

  // ── Headline ──
  const state = (st) => hh.filter((r) => r.state === st).length;
  const tallyChecks = (st) => checks.filter((c) => c.status === st).length;
  const factStats = db.prepare(`SELECT COUNT(*) AS n, SUM(raw_id IS NOT NULL) AS linked, COUNT(DISTINCT raw_id) AS payloads FROM (
      SELECT r.raw_id FROM reading r JOIN series se ON se.id = r.series_id WHERE r.superseded_at IS NULL AND r.ts >= ? AND r.ts < ?
        AND ((se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?)))
      UNION ALL
      SELECT f.raw_id FROM interval_fact f JOIN series se ON se.id = f.series_id WHERE f.superseded_at IS NULL AND f.end_ts > ? AND f.start_ts < ?
        AND ((se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))
          OR (se.subject_kind = 'region' AND se.subject_id IN (?, ?))))`)
    .get(fromTs, toTs, String(siteId), siteId, fromTs, toTs, String(siteId), siteId, `carbon:${site.carbon_region}`, `ldz:${ldz ?? ''}`);
  const revisions = db.prepare('SELECT * FROM site_day_revision WHERE site_id = ? AND local_date >= ? AND local_date <= ? ORDER BY local_date, revised_at, id').all(siteId, fromDate, toDate)
    .map((r) => ({ ...r, checks: JSON.parse(r.checks || '{}'), inputs: JSON.parse(r.inputs || '{}'), changed: r.changed ? JSON.parse(r.changed) : null }));
  const headline = {
    from: fromDate, to: toDate, halfHours: hh.length, final: state('final'), provisional: state('provisional'), missing: state('missing'),
    restated: hh.filter((r) => r.quality & 128).length,
    checks: { pass: tallyChecks('pass'), warn: tallyChecks('warn'), fail: tallyChecks('fail'), skip: tallyChecks('skip') },
    facts: factStats.n, factsLinked: factStats.linked, payloads: factStats.payloads,
    revisedDays: new Set(revisions.filter((r) => r.changed).map((r) => r.local_date)).size,
  };

  const corrections = db.prepare(`SELECT c.*, m.code AS metric, so.code AS source FROM fact_correction c LEFT JOIN series se ON se.id = c.series_id
    LEFT JOIN metric m ON m.id = se.metric_id LEFT JOIN source so ON so.id = se.source_id WHERE c.site_id = ? ORDER BY c.corrected_at DESC`).all(siteId);
  const details = ATTRS.map((a) => ({ attr: a, ...(attributeAt(siteId, a) || { value: null, source: null }),
    versions: db.prepare('SELECT COUNT(*) AS n FROM site_attribute WHERE site_id = ? AND attr = ?').get(siteId, a).n }));

  // The result of the build for each half-hour: f final · p provisional · m missing · n not built yet.
  const states = slots.map((sl) => ({ final: 'f', provisional: 'p', missing: 'm' }[served.get(sl)?.state] || 'n')).join('');
  return { timezone: tz, slotStart: slots[0], slotTimes: slots, slots: slots.length, now, headline, feeds, states, checks, balance, revisions, corrections, details, detailHistory: attributeHistory(siteId) };
}
