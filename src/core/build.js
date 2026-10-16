// Stage 5: the build engine. Turns facts into the half-hour timeline.
//   1 Align      5-min power -> half-hour energy; fit each day to the daily totals
//   2 Reconcile  one value per node (meter beats CT); home use by energy balance
//   3 Allocate   who fed whom (solar first to home, then battery, then grid)
//   4 Price      rate per slot, VAT, cost per flow, battery stock valued first in, first out
//   5 Check      balance, meter vs CT, counter fit, rate coverage; state per slot
// Deterministic: the same facts and METHOD_VERSION always give the same rows.
import { db, tx } from '../db/db.js';
import { seriesId, readReadings, readIntervals, readForecastOfRecord, QUALITY } from './facts.js';
import { loadPricing, priceAt } from './pricing.js';
import { SLOT, nowSec, localDate, dayBounds, slotsOfDay, daysBetween, zonedParts, floorTo, addDays } from './time.js';

export const METHOD_VERSION = 'v3-stock-follows-charge';

const NODES = {
  solar: ['solar_w', 'solar_kwh'], load: ['load_w', 'load_kwh'], imp: ['grid_import_w', 'grid_import_kwh'],
  exp: ['grid_export_w', 'grid_export_kwh'], chg: ['battery_charge_w', 'battery_charge_kwh'], dis: ['battery_discharge_w', 'battery_discharge_kwh'],
};

// Forward-hold integration: each sample holds for up to 5 minutes. Energy is split at slot boundaries.
function integrate(readings) {
  const energy = new Map();
  const cover = new Map();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (r.value == null) continue;
    const next = readings[i + 1]?.ts ?? r.ts + 300;
    const end = r.ts + Math.min(next - r.ts, 300);
    for (let s = r.ts; s < end;) {
      const slot = floorTo(s, SLOT);
      const e = Math.min(end, slot + SLOT);
      energy.set(slot, (energy.get(slot) || 0) + (r.value * (e - s)) / 3.6e6);
      cover.set(slot, (cover.get(slot) || 0) + (e - s));
      s = e;
    }
  }
  return { energy, cover };
}

const groupBy = (rows, key) => rows.reduce((m, r) => (m.get(r[key]) ? m.get(r[key]).push(r) : m.set(r[key], [r]), m), new Map());

function slotSum(intervals, slot) {
  let v = null;
  for (const f of intervals) {
    if (f.end_ts <= slot || f.start_ts >= slot + SLOT || f.value == null) continue;
    const overlap = Math.min(f.end_ts, slot + SLOT) - Math.max(f.start_ts, slot);
    v = (v || 0) + (f.value * overlap) / (f.end_ts - f.start_ts);
  }
  return v;
}

export function buildSite(siteId, fromDate, toDate) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const tz = site.timezone;
  const now = nowSec();
  const today = localDate(tz, now);
  if (toDate > today) toDate = today;
  if (fromDate > toDate) return { days: 0 };
  const [winStart] = dayBounds(tz, fromDate);
  const [, winEnd] = dayBounds(tz, toDate);
  const sid = (metric, source) => seriesId('site', siteId, metric, source);

  // ── Facts for the whole window ──
  const powerIds = Object.fromEntries(Object.entries(NODES).map(([k, [w]]) => [k, sid(w, 'sunsynk_5min')]));
  const dailyIds = Object.fromEntries(Object.entries(NODES).map(([k, [, kwh]]) => [k, sid(kwh, 'sunsynk_daily')]));
  const socId = sid('battery_soc_pct', 'sunsynk_5min');
  const readings = groupBy(readReadings([...Object.values(powerIds), socId], winStart - 600, winEnd), 'series_id');
  const aligned = Object.fromEntries(Object.entries(powerIds).map(([k, id]) => [k, integrate(readings.get(id) || [])]));
  const socBySlot = new Map((readings.get(socId) || []).map((r) => [floorTo(r.ts, SLOT), r.value]));
  const daily = groupBy(readIntervals(Object.values(dailyIds), winStart, winEnd), 'series_id');
  const hasInverter = (readings.get(powerIds.solar) || []).length > 0 || (readings.get(powerIds.imp) || []).length > 0;

  const meters = db.prepare("SELECT * FROM device WHERE site_id = ? AND kind IN ('meter_import','meter_export','meter_gas') AND provider != 'env'").all(siteId);
  const meterFacts = {};
  // Gas in m3 is converted per gas day with National Gas's calorific value for the meter's zone:
  // kWh = m3 × 1.02264 (volume correction) × CV (MJ/m3) ÷ 3.6. Without a published CV the
  // half-hour's gas stays unknown rather than converted with a typical value.
  let gasM3 = null; let gasCv = []; let gasLdz = null;
  for (const m of meters) {
    if (m.kind === 'meter_gas') {
      const attrs = JSON.parse(m.attrs || '{}');
      if (attrs.gasUnit?.unit === 'm3') {
        gasM3 = readIntervals([seriesId('device', m.id, 'gas_m3', 'octopus_meter')], winStart, winEnd);
        gasLdz = attrs.ldz || null;
        gasCv = gasLdz ? readIntervals([seriesId('region', `ldz:${gasLdz}`, 'gas_cv_mjm3', 'national_gas_cv')], winStart - 86400, winEnd + 86400) : [];
        meterFacts.meter_gas = gasM3;
        continue;
      }
    }
    const metric = m.kind === 'meter_gas' ? 'gas_kwh' : m.kind === 'meter_export' ? 'grid_export_kwh' : 'grid_import_kwh';
    meterFacts[m.kind] = readIntervals([seriesId('device', m.id, metric, 'octopus_meter')], winStart, winEnd);
  }
  const cvAt = (slot) => gasCv.find((f) => f.start_ts <= slot && f.end_ts > slot)?.value ?? null;
  const VOLUME_CORRECTION = 1.02264;   // Gas (Calculation of Thermal Energy) Regulations 1996
  const hasImportMeter = !!meterFacts.meter_import;
  // A configured supplier account means meter data is expected, even before its meters are known.
  const expectMeter = hasImportMeter || !!db.prepare("SELECT 1 FROM connection WHERE site_id = ? AND provider = 'octopus'").get(siteId);
  const evFacts = readIntervals([sid('ev_charge_kwh', 'octopus_kraken')], winStart, winEnd);
  const carbonFacts = site.carbon_region != null
    ? readIntervals([seriesId('region', `carbon:${site.carbon_region}`, 'carbon_intensity', 'carbon_regional')], winStart, winEnd) : [];
  const tempByHour = new Map(readReadings([sid('outdoor_temp_c', 'open_meteo')], winStart - 3600, winEnd).map((r) => [r.ts, r.value]));
  // Solar forecast of record: for each period, the latest issue made before it started,
  // so a past half-hour is compared only with what was known in advance. Quartz when it
  // was used (panel angles known), otherwise our own stored forecast.
  const solarFc = [];
  for (const source of ['quartz', 'core_forecast']) {
    const rows = db.prepare('SELECT start_ts, end_ts, issued_at, value FROM forecast_fact WHERE series_id = ? AND start_ts >= ? AND start_ts < ? AND issued_at <= start_ts')
      .all(sid('solar_kwh', source), winStart, winEnd);
    const best = new Map();
    for (const f of rows) if (!best.has(f.start_ts) || f.issued_at > best.get(f.start_ts).issued_at) best.set(f.start_ts, f);
    const covered = new Set(solarFc.map((f) => floorTo(f.start_ts, SLOT)));
    for (const f of best.values()) if (!covered.has(floorTo(f.start_ts, SLOT))) solarFc.push(f);
  }
  const pricing = loadPricing(siteId, winStart, winEnd);

  const previous = new Map(db.prepare('SELECT slot_start, state, quality, home, total_cost FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?')
    .all(siteId, winStart, winEnd).map((r) => [r.slot_start, r]));

  // Battery round trip for each day, measured from the inverter's own daily counters over
  // the 30 days ending that day: energy out ÷ (energy in − change in stored energy).
  // It depends only on facts up to that day, so a day gets the same value whether it is
  // rebuilt alone or as part of a full rebuild. Without enough data no loss is applied (1.0).
  const counterSum = db.prepare('SELECT SUM(value) AS v FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL AND start_ts >= ? AND start_ts < ?');
  const firstSoc = db.prepare('SELECT value FROM reading WHERE series_id = ? AND superseded_at IS NULL AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1');
  const lastSoc = db.prepare('SELECT value FROM reading WHERE series_id = ? AND superseded_at IS NULL AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1');
  const efficiencyFor = (date) => {
    const [a] = dayBounds(tz, addDays(date, -29)); const [, b] = dayBounds(tz, date);
    const inKwh = counterSum.get(dailyIds.chg, a, b)?.v || 0; const outKwh = counterSum.get(dailyIds.dis, a, b)?.v || 0;
    const s0 = firstSoc.get(socId, a, b)?.value; const s1 = lastSoc.get(socId, a, b)?.value;
    if (!site.battery_kwh || s0 == null || s1 == null || inKwh <= 5) return { eff: 1, note: 'not enough battery data to measure; no loss applied' };
    const stored = ((s1 - s0) / 100) * site.battery_kwh; const net = inKwh - stored; const r = net > 0 ? outKwh / net : null;
    if (r == null || r <= 0.5 || r > 1.02) return { eff: 1, note: `measured ${r?.toFixed(3) ?? '–'}, outside what is possible; no loss applied` };
    return { eff: Math.min(1, r), note: `${outKwh.toFixed(1)} kWh out ÷ (${inKwh.toFixed(1)} kWh in − ${stored.toFixed(1)} kWh change in stored energy), inverter counters, 30 days to ${date}` };
  };
  // Battery energy layers, first in first out: { kwh, p } (p = pence per stored kWh).
  // A rebuild that starts after the first day continues from the stock saved at the end
  // of the day before. On the first day the energy already in the battery at the first
  // charge-level reading is the opening layer; its cost is unknown (p = null).
  const prevDay = db.prepare('SELECT battery_stock FROM site_day WHERE site_id = ? AND local_date = ?').get(siteId, addDays(fromDate, -1));
  const socSeries = readings.get(socId) || [];
  const stock = prevDay?.battery_stock ? JSON.parse(prevDay.battery_stock).map(([kwh, p]) => ({ kwh, p })) : [];
  if (!prevDay?.battery_stock && site.battery_kwh && socSeries.length) stock.push({ kwh: (socSeries[0].value / 100) * site.battery_kwh, p: null });
  // Adjacent layers at the same price are one layer; first in first out is unchanged.
  const addLayer = (kwh, p) => { const last = stock[stock.length - 1]; if (last && last.p === p) last.kwh += kwh; else stock.push({ kwh, p }); };
  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  let unknownStock = false; let lastEff = null;
  const hhRows = [];
  const dayRows = [];
  const checks = [];

  for (const date of daysBetween(fromDate, toDate)) {
    const slots = slotsOfDay(tz, date).filter((s) => s + SLOT <= now);
    if (!slots.length) continue;
    const nSlotsDay = slotsOfDay(tz, date).length;
    const { eff, note: effNote } = efficiencyFor(date);
    lastEff = { date, eff, note: effNote };

    // ── 1 Align: fit each node's half-hours to the inverter's daily total ──
    const fit = {};
    for (const k of Object.keys(NODES)) {
      const totalRow = (daily.get(dailyIds[k]) || []).find((f) => f.start_ts === dayBounds(tz, date)[0]);
      const sum = slotsOfDay(tz, date).reduce((s, sl) => s + (aligned[k].energy.get(sl) || 0), 0);
      fit[k] = 1;
      if (totalRow && sum > 0.05 && totalRow.value > 0) {
        const f = totalRow.value / sum;
        if (f > 0.6 && f < 1.6 && date < today) fit[k] = f;
        if (k === 'solar') checks.push([date, 'counter_fit_solar', Math.abs(f - 1) <= 0.1 ? 'pass' : 'warn', f, 0.1, `daily total ${totalRow.value} kWh vs integrated ${sum.toFixed(2)} kWh`]);
      }
    }
    const e = (k, slot) => (aligned[k].energy.get(slot) || 0) * fit[k];

    const day = { rows: [], mImp: 0, ctImpBoth: 0, home: 0, loss: 0, lossN: 0, rated: 0, gasNoCv: 0 };
    for (const slot of slots) {
      let q = 0;
      const coverage = hasInverter ? (aligned.solar.cover.get(slot) || aligned.imp.cover.get(slot) || 0) / SLOT : 0;

      // ── 2 Reconcile ──
      const solar = hasInverter ? e('solar', slot) : 0;
      const chg = hasInverter ? e('chg', slot) : 0;
      const dis = hasInverter ? e('dis', slot) : 0;
      const mImp = hasImportMeter ? slotSum(meterFacts.meter_import, slot) : null;
      const mExp = meterFacts.meter_export ? slotSum(meterFacts.meter_export, slot) : null;
      let imp = null; let exp = null; let impSrc = null; let expSrc = null;
      if (mImp != null) { imp = mImp; impSrc = 'octopus_meter'; q |= QUALITY.MEASURED; }
      else if (hasInverter && coverage > 0) { imp = e('imp', slot); impSrc = 'sunsynk_ct'; q |= QUALITY.FALLBACK; }
      if (mExp != null) { exp = mExp; expSrc = 'octopus_meter'; }
      else if (hasInverter && coverage > 0) { exp = e('exp', slot); expSrc = 'sunsynk_ct'; if (meterFacts.meter_export) q |= QUALITY.FALLBACK; }
      const missing = imp == null;
      if (hasInverter && coverage < 0.8) q |= QUALITY.PARTIAL;

      // What the sources supplied beyond exports and charging. The house used the
      // inverter's measured load; the rest is the inverter's own conversion and
      // standby loss. Without a load reading the balance is all we have.
      const balance = solar + (imp || 0) + dis - (exp || 0) - chg;
      if (balance < -0.02) q |= QUALITY.SUSPECT;
      const measuredLoad = hasInverter && coverage > 0 ? e('load', slot) : null;
      const home = measuredLoad != null ? Math.min(measuredLoad, Math.max(0, balance)) : Math.max(0, balance);
      const loss = measuredLoad != null ? balance - measuredLoad : null;
      const meterVsCt = mImp != null && hasInverter && coverage > 0.5 ? mImp - e('imp', slot) : null;
      if (meterVsCt != null) { day.mImp += mImp; day.ctImpBoth += e('imp', slot); }
      const gasRaw = meterFacts.meter_gas ? slotSum(meterFacts.meter_gas, slot) : null;
      const cv = gasM3 && gasRaw != null ? cvAt(slot) : null;
      const gas = gasRaw == null ? null : gasM3 ? (cv != null ? (gasRaw * VOLUME_CORRECTION * cv) / 3.6 : null) : gasRaw;
      if (gasM3 && gasRaw != null && cv == null) day.gasNoCv++;
      const ev = slotSum(evFacts, slot);

      // ── 3 Allocate (slot-level priority) ──
      const sToHome = Math.min(solar, home);
      const sLeft = solar - sToHome;
      const sToBatt = Math.min(sLeft, chg);
      const sToGrid = Math.min(Math.max(0, sLeft - sToBatt), exp || 0);
      const bToHome = Math.min(dis, Math.max(0, home - sToHome));
      const bToGrid = Math.min(Math.max(0, dis - bToHome), Math.max(0, (exp || 0) - sToGrid));
      const gToHome = Math.min(Math.max(0, home - sToHome - bToHome), imp || 0);
      // Grid charging is bounded by what was imported. Any charge left over came
      // from the battery itself (charge and discharge in the same half-hour).
      const gToBatt = Math.min(Math.max(0, chg - sToBatt), Math.max(0, (imp || 0) - gToHome));
      // Whatever each source supplied beyond those flows went into losses.
      const sToLoss = Math.max(0, solar - sToHome - sToBatt - sToGrid);
      const bToLoss = Math.max(0, dis - bToHome - bToGrid);
      const gToLoss = Math.max(0, (imp || 0) - gToHome - gToBatt);

      // ── 4 Price ──
      const pi = priceAt(pricing, 'meter_import', slot);
      const pe = priceAt(pricing, 'meter_export', slot);
      const pg = gas != null ? priceAt(pricing, 'meter_gas', slot) : null;
      const impInc = pi?.unitEx != null ? pi.unitEx * (1 + pi.vat) : null;
      const expRate = pe?.unitEx != null ? pe.unitEx * (1 + pe.vat) : 0;
      if (impInc != null) { day.rated++; } else q |= QUALITY.CHECK_FAILED;

      // Battery stock, first in, first out: draw what was discharged, then add what was charged.
      let draw = dis; let drawCost = 0; let fromUnknown = 0;
      while (draw > 1e-9 && stock.length) {
        const l = stock[0]; const take = Math.min(draw, l.kwh);
        if (l.p == null) fromUnknown += take; else drawCost += take * l.p;
        l.kwh -= take; draw -= take;
        if (l.kwh <= 1e-9) stock.shift();
      }
      // Unknown when energy comes from the opening layer, or more is drawn than the records hold.
      const unknownDraw = fromUnknown > 1e-6 || draw > 1e-6;
      if (unknownDraw) { unknownStock = true; q |= QUALITY.ESTIMATED; }
      if (gToBatt > 0) addLayer(gToBatt * eff, (impInc ?? 0) / eff);
      if (sToBatt > 0) addLayer(sToBatt * eff, 0);   // solar has no fuel cost
      // The stock follows the measured charge level. Energy in × efficiency − energy out drifts
      // from what the battery holds (efficiency and capacity are measured, not exact); left alone
      // it ran dry while the battery still held 20%. All layers are scaled together, so their
      // price mix is kept. Stock with no records behind it (only possible before any charge) has unknown cost.
      const socEnd = socBySlot.get(slot);
      if (socEnd != null && site.battery_kwh) {
        const held = (socEnd / 100) * site.battery_kwh;
        const total = stock.reduce((t, l) => t + l.kwh, 0);
        if (total > 1e-6) { const k = held / total; for (const l of stock) l.kwh *= k; } else if (held > 1e-6) stock.push({ kwh: held, p: null });
      }

      const standing = pi ? (pi.standingEx * (1 + pi.vat)) / nSlotsDay + (pg ? (pg.standingEx * (1 + pg.vat)) / nSlotsDay : 0) : 0;
      const gasCost = gas != null && pg?.unitEx != null ? gas * pg.unitEx * (1 + pg.vat) : (gas != null ? null : 0);
      const gToHomeCost = impInc != null ? gToHome * impInc : null;
      const gToBattCost = impInc != null ? gToBatt * impInc : null;
      const lossCost = impInc != null ? gToLoss * impInc : null;
      // Unknown when any of the energy drawn was stored before the data starts.
      const bToHomeCost = dis > 0 ? (unknownDraw ? null : drawCost * (bToHome / dis)) : 0;
      const exportCredit = (sToGrid + bToGrid) * expRate;
      // The bill is every imported kWh at its price (including what the inverter lost), plus standing and gas, minus export.
      const totalCost = impInc != null ? gToHomeCost + gToBattCost + lossCost + standing + (gasCost || 0) - exportCredit : null;
      const gridOnly = impInc != null ? home * impInc + standing + (gasCost || 0) : null;
      const ci = slotSum(carbonFacts, slot) ?? null;
      const carbonG = ci != null && imp != null ? imp * ci : null;
      const carbonSaved = ci != null ? home * ci - (carbonG || 0) : null;
      const temp = tempByHour.get(floorTo(slot, 3600)) ?? null;
      const fcRows = solarFc.filter((f) => f.start_ts >= slot && f.start_ts < slot + SLOT);
      const solarForecast = fcRows.length ? fcRows.reduce((s, f) => s + (f.value || 0), 0) : null;

      // ── 5 Check and state ──
      let state = 'final';
      if (missing) state = 'missing';
      else if ((expectMeter && mImp == null) || date >= today) state = 'provisional';
      const prev = previous.get(slot);
      // Once revised, always marked: the flag survives later rebuilds.
      if (prev && ((prev.quality & QUALITY.RESTATED) || (prev.state === 'final' && (Math.abs((prev.home ?? 0) - home) > 0.001 || Math.abs((prev.total_cost ?? 0) - (totalCost ?? 0)) > 0.01)))) q |= QUALITY.RESTATED;

      const row = {
        site_id: siteId, slot_start: slot, local_date: date, state, quality: q,
        solar, grid_import: imp, grid_export: exp, battery_charge: chg, battery_discharge: dis, home, loss, gas, ev,
        soc_end: socBySlot.get(slot) ?? null,
        solar_to_home: sToHome, solar_to_battery: sToBatt, solar_to_grid: sToGrid, battery_to_home: bToHome,
        battery_to_grid: bToGrid, grid_to_home: gToHome, grid_to_battery: gToBatt,
        solar_to_loss: sToLoss, battery_to_loss: bToLoss, grid_to_loss: gToLoss, loss_cost: lossCost,
        import_rate_ex: pi?.unitEx ?? null, import_vat: pi?.vat ?? null, export_rate: pe?.unitEx ?? null,
        gas_rate_ex: pg?.unitEx ?? null, gas_vat: pg?.vat ?? null,
        grid_to_home_cost: gToHomeCost, grid_to_battery_cost: gToBattCost, battery_to_home_cost: bToHomeCost,
        export_credit: exportCredit, standing_cost: standing, gas_cost: gasCost, total_cost: totalCost,
        grid_only_cost: gridOnly, saving: gridOnly != null ? gridOnly - totalCost : null,
        carbon_intensity: ci, carbon_g: carbonG, carbon_saved_g: carbonSaved, outdoor_temp: temp, solar_forecast: solarForecast,
        meter_vs_ct: meterVsCt, rate_found: impInc != null ? 1 : 0,
        lineage: JSON.stringify({ import: impSrc, export: expSrc, solar: hasInverter ? 'sunsynk_5min' : null, fit, tariff: pi?.tariffCode ?? null, register: pi?.register ?? null, carbon: ci != null ? 'carbon_regional' : null, coverage: Math.round(coverage * 100) / 100, ...(gasM3 && gasRaw != null ? { gasM3: Math.round(gasRaw * 1000) / 1000, gasCv: cv, gasLdz, gasCvSource: cv != null ? 'national_gas_cv' : 'not published yet' } : {}) }),
        method_version: METHOD_VERSION, built_at: now,
      };
      day.rows.push(row);
      day.home += home;
      if (loss != null) { day.loss += loss; day.lossN++; }
    }
    hhRows.push(...day.rows);

    // ── Day row and checks ──
    const R = day.rows;
    const sum = (k) => R.reduce((s, r) => s + (r[k] ?? 0), 0);
    const anyNull = (k) => R.some((r) => r[k] == null);
    const solarSum = sum('solar');
    const homeSum = sum('home');
    const nightHome = R.filter((r) => { const h = zonedParts(tz, r.slot_start).hh; return h >= 1 && h < 5; }).map((r) => r.home * 2);
    const socs = R.map((r) => r.soc_end).filter((v) => v != null);
    const dayRow = {
      site_id: siteId, local_date: date, slots: R.length,
      slots_final: R.filter((r) => r.state === 'final').length, slots_provisional: R.filter((r) => r.state === 'provisional').length,
      slots_missing: R.filter((r) => r.state === 'missing').length,
      ...Object.fromEntries(['solar', 'grid_import', 'grid_export', 'battery_charge', 'battery_discharge', 'home', 'loss', 'gas', 'ev',
        'solar_to_home', 'solar_to_battery', 'solar_to_grid', 'battery_to_home', 'battery_to_grid', 'grid_to_home', 'grid_to_battery',
        'solar_to_loss', 'battery_to_loss', 'grid_to_loss', 'loss_cost',
        'grid_to_home_cost', 'grid_to_battery_cost', 'battery_to_home_cost', 'export_credit', 'standing_cost', 'gas_cost',
        'total_cost', 'grid_only_cost', 'saving', 'carbon_g', 'carbon_saved_g'].map((k) => [k, anyNull(k) && ['total_cost', 'grid_only_cost', 'saving'].includes(k) ? null : sum(k)])),
      solar_forecast: R.some((r) => r.solar_forecast != null) ? sum('solar_forecast') : null,
      self_consumption: solarSum > 0.01 ? (sum('solar_to_home') + sum('solar_to_battery')) / solarSum : null,
      self_sufficiency: homeSum > 0.01 ? 1 - sum('grid_to_home') / homeSum : null,
      blended_cost: homeSum > 0.01 && !anyNull('grid_to_home_cost') && !R.some((r) => r.battery_to_home > 0 && r.battery_to_home_cost == null) ? (sum('grid_to_home_cost') + sum('battery_to_home_cost')) / homeSum : null,
      peak_import_kw: Math.max(0, ...R.map((r) => (r.grid_import ?? 0) * 2)),
      base_load_kw: nightHome.length ? Math.min(...nightHome) : null,
      soc_min: socs.length ? Math.min(...socs) : null, soc_max: socs.length ? Math.max(...socs) : null,
      battery_cycles: site.battery_kwh ? sum('battery_discharge') / site.battery_kwh : null,
      // Share of half-hours that are present, priced and pass the balance; finality is reported separately by state.
      integrity: R.length ? R.filter((r) => r.state !== 'missing' && !(r.quality & (QUALITY.SUSPECT | QUALITY.CHECK_FAILED))).length / R.length : null,
      battery_eff: eff,
      // Rounded at every day end (whether rebuilt alone or in a full rebuild), so both give the same numbers.
      battery_stock: (() => {
        for (let i = stock.length - 1; i >= 0; i--) { stock[i].kwh = round6(stock[i].kwh); if (stock[i].p != null) stock[i].p = round6(stock[i].p); if (stock[i].kwh <= 0) stock.splice(i, 1); }
        return JSON.stringify(stock.map((l) => [l.kwh, l.p]));
      })(),
      method_version: METHOD_VERSION, built_at: now,
    };
    dayRows.push(dayRow);
    if (day.mImp > 0.1) {
      const diff = (day.mImp - day.ctImpBoth) / day.mImp;
      checks.push([date, 'meter_vs_ct', Math.abs(diff) <= 0.05 ? 'pass' : 'warn', diff, 0.05, `meter ${day.mImp.toFixed(2)} kWh vs inverter CT ${day.ctImpBoth.toFixed(2)} kWh`]);
    }
    if (day.lossN && day.home > 0.1) {
      const share = day.loss / day.home;
      checks.push([date, 'energy_balance', Math.abs(share) <= 0.1 ? 'pass' : 'warn', share, 0.1, `losses and measurement error ${(share * 100).toFixed(1)}% of home use`]);
    }
    checks.push([date, 'rate_coverage', day.rated === R.length ? 'pass' : (day.rated === 0 ? 'fail' : 'warn'), R.length ? day.rated / R.length : 0, 1, `${day.rated} of ${R.length} half-hours priced`]);
    if (gasM3) checks.push([date, 'gas_calorific_value', day.gasNoCv ? 'warn' : 'pass', day.gasNoCv, 0, day.gasNoCv ? `${day.gasNoCv} half-hours of gas wait for National Gas's calorific value for ${gasLdz}` : `converted with National Gas's calorific value for ${gasLdz}`]);
    checks.push([date, 'completeness', dayRow.slots_missing === 0 ? 'pass' : 'warn', R.length ? 1 - dayRow.slots_missing / R.length : 0, 1, `${dayRow.slots_final} final, ${dayRow.slots_provisional} provisional, ${dayRow.slots_missing} missing`]);
  }
  if (unknownStock && checks.length) checks.push([fromDate, 'battery_stock', 'warn', null, null, 'Energy already in the battery when the data starts has unknown cost; those half-hours show no stored cost']);
  if (lastEff) checks.push([lastEff.date, 'battery_efficiency', lastEff.eff < 1 ? 'pass' : 'skip', lastEff.eff, null, lastEff.eff < 1 ? `measured round trip ${(lastEff.eff * 100).toFixed(1)}%: ${lastEff.note}` : lastEff.note]);

  // ── Write serving rows (replace the window) ──
  tx(() => {
    db.prepare('DELETE FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ?').run(siteId, winStart, winEnd);
    db.prepare('DELETE FROM site_day WHERE site_id = ? AND local_date >= ? AND local_date <= ?').run(siteId, fromDate, toDate);
    db.prepare('DELETE FROM check_result WHERE site_id = ? AND local_date >= ? AND local_date <= ?').run(siteId, fromDate, toDate);
    if (hhRows.length) {
      const cols = Object.keys(hhRows[0]);
      const ins = db.prepare(`INSERT INTO site_hh (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of hhRows) ins.run(...cols.map((c) => r[c] ?? null));
    }
    if (dayRows.length) {
      const cols = Object.keys(dayRows[0]);
      const ins = db.prepare(`INSERT INTO site_day (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of dayRows) ins.run(...cols.map((c) => (typeof r[c] === 'number' && !Number.isFinite(r[c]) ? null : r[c] ?? null)));
    }
    const insC = db.prepare('INSERT OR REPLACE INTO check_result (site_id, local_date, check_code, status, measured, tolerance, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of checks) insC.run(siteId, ...c);
  });
  return { days: dayRows.length, slots: hhRows.length };
}

// Rebuild from the earliest day a change touched to today. Each day saves its battery
// stock, so the rebuild continues from the day before; it falls back to the first day
// only when that saved stock is missing (for example rows built before it was saved).
export function processQueue() {
  const pending = db.prepare('SELECT site_id, MIN(from_ts) AS from_ts FROM rebuild_queue WHERE done_at IS NULL GROUP BY site_id').all();
  const out = [];
  for (const p of pending) {
    const site = db.prepare('SELECT * FROM site WHERE id = ?').get(p.site_id);
    if (!site) continue;
    const firstDay = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(p.site_id)?.d;
    let from = localDate(site.timezone, p.from_ts);
    // Never before the home's own first energy data (inverter or meter readings): a change
    // elsewhere (a price list starting months earlier, weather history) must not create empty half-hours.
    const firstFact = db.prepare(`SELECT MIN(t) AS t FROM (
        SELECT MIN(r.ts) AS t FROM reading r JOIN series se ON se.id = r.series_id JOIN source so ON so.id = se.source_id
          WHERE se.subject_kind = 'site' AND se.subject_id = ? AND so.code = 'sunsynk_5min'
        UNION ALL SELECT MIN(f.start_ts) FROM interval_fact f JOIN series se ON se.id = f.series_id
          WHERE se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))`).get(String(p.site_id), p.site_id)?.t;
    if (firstFact != null && from < localDate(site.timezone, firstFact)) from = localDate(site.timezone, firstFact);
    if (firstDay && from > firstDay) {
      const prev = db.prepare('SELECT battery_stock FROM site_day WHERE site_id = ? AND local_date = ?').get(p.site_id, addDays(from, -1));
      if (!prev?.battery_stock) from = firstDay;
    }
    const t0 = Date.now();
    const res = buildSite(p.site_id, from, localDate(site.timezone, nowSec()));
    // Processed requests are removed; the sync run records what was rebuilt.
    db.prepare('DELETE FROM rebuild_queue WHERE site_id = ? AND done_at IS NULL').run(p.site_id);
    out.push({ siteId: p.site_id, from, ms: Date.now() - t0, ...res });
  }
  return out;
}
