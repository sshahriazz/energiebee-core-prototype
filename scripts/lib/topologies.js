// SYNTHETIC homes, one per energy-system topology (fix list R12), built by the real engine: a hybrid inverter with a
// battery (the shape of the real GB home), no battery, export only (no import meter), two inverters, an AC-coupled battery
// on its own inverter, an EV charged overnight, and a heat pump. test/topologies.test.js fingerprints each one and checks
// the build against the synthetic truth it was made from, so an engine change that breaks one topology shows up even when
// the GB fixture still passes.
//
// Everything is made up and deterministic (seeded, multi-market.js synthesise): two November days in London without a
// clock change, flat GB prices. Samples go in through the Sunsynk channels (ingestObservations), meters as half-hour
// readings of import and export meters, as the engine reads them today.
//
// Import only after DATABASE_URL points at a throwaway database.
import { db } from '../../src/db/db.js';
import { createSite } from '../../src/core/sites.js';
import { createTariff, putRateRows, agreeTariff, addDevice } from '../../src/core/tariffs.js';
import { seriesId, putIntervals, putReadings } from '../../src/core/facts.js';
import { ingestObservations } from '../../src/core/channels.js';
import { bind, unbind } from '../../src/core/inputs.js';
import { buildSite } from '../../src/core/build.js';
import { buildHeat } from '../../src/core/heat.js';
import { dayBounds, addDays, zonedParts } from '../../src/core/time.js';
import { synthesise } from './multi-market.js';

export const TZ = 'Europe/London';
export const FROM = '2025-11-03';
export const TO = '2025-11-04';
const SYN = { provider: 'synthetic', country: 'GB', currency: 'GBP', origin: 'synthetic', originNote: 'scripts/lib/topologies.js (seeded): not real data' };
const kwh = (w) => (w * 300) / 3.6e6;   // a 5-minute sample's energy
const [T0] = dayBounds(TZ, FROM);
const [, T1] = dayBounds(TZ, TO);

// The same samples without a battery: what the battery took or gave goes to or comes from the grid.
function withoutBattery(samples) {
  return samples.map((x) => {
    const net = x.load + 40 + 0 - x.solar;
    return { ...x, chg: 0, dis: 0, socPct: null, imp: Math.max(0, net), exp: Math.max(0, -net) };
  });
}
// Extra load (an EV, a heat pump) over the samples, taken from the grid.
function plusLoad(samples, wAt) {
  return samples.map((x) => { const w = wAt(x.ts); return w ? { ...x, load: x.load + w, imp: x.imp + Math.max(0, w - x.exp), exp: Math.max(0, x.exp - w) } : x; });
}
// What the samples say happened, per day: the truth a build is checked against.
export function truth(samples) {
  const out = {};
  for (const x of samples) {
    const d = out[dayOf(x.ts)] ??= { solar: 0, home: 0, grid_import: 0, grid_export: 0, battery_charge: 0, battery_discharge: 0 };
    d.solar += kwh(x.solar); d.home += kwh(x.load); d.grid_import += kwh(x.imp); d.grid_export += kwh(x.exp); d.battery_charge += kwh(x.chg); d.battery_discharge += kwh(x.dis);
  }
  return out;
}
const dayOf = (ts) => { const p = zonedParts(TZ, ts); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

// Sunsynk points of a unit: what it measures (`has`: pv, load, grid, battery).
function observations(samples, has) {
  const obs = [];
  for (const x of samples) {
    if (has.pv) obs.push({ point: 'PV', ts: x.ts, value: x.solar });
    if (has.load) obs.push({ point: 'Load', ts: x.ts, value: x.load });
    if (has.grid) obs.push({ point: 'Grid', ts: x.ts, value: x.imp - x.exp });
    if (has.battery) { obs.push({ point: 'Battery', ts: x.ts, value: x.dis - x.chg }); if (x.socPct != null) obs.push({ point: 'SOC', ts: x.ts, value: x.socPct }); }
  }
  return obs;
}
async function meters(site, samples, { importMeter = true, exportMeter = true } = {}) {
  const half = (key) => { const b = new Map(); for (const x of samples) { const s = x.ts - (x.ts % 1800); b.set(s, (b.get(s) || 0) + kwh(x[key])); } return [...b].map(([start, v]) => ({ start, end: start + 1800, value: Math.round(v * 1000) / 1000 })); };
  const out = {};
  if (importMeter) {
    out.imp = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: `${site.name}-IMPORT` });
    await putIntervals(await seriesId('device', out.imp.id, 'grid_import_kwh', 'octopus_meter'), half('imp'));
  }
  if (exportMeter) {
    out.exp = await addDevice({ siteId: site.id, kind: 'meter_export', provider: 'synthetic', externalRef: `${site.name}-EXPORT` });
    await putIntervals(await seriesId('device', out.exp.id, 'grid_export_kwh', 'octopus_meter'), half('exp'));
  }
  // Flat prices: 24.5 p/kWh and 60 p/day in, 15 p/kWh out.
  const b = dayBounds(TZ, addDays(TO, 1))[0];
  const priced = async (dev, code, direction, rows) => {
    const t = await createTariff({ ...SYN, tariffCode: `${code}-${site.id}`, structure: direction === 'export' ? 'export' : 'flat', kind: 'flat', direction, name: code });
    await putRateRows(t.id, rows);
    await agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: T0, validTo: b });
  };
  const anyImport = out.imp ?? await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: `${site.name}-IMPORT-UNREAD` });
  await priced(anyImport, 'SYN-TOPO-FLAT', 'import', [{ component: 'unit', validFrom: T0, validTo: b, price: 24.5 }, { component: 'standing', validFrom: T0, validTo: b, price: 60 }]);
  if (out.exp) await priced(out.exp, 'SYN-TOPO-EXPORT', 'export', [{ component: 'unit', validFrom: T0, validTo: b, price: 15 }]);
  return out;
}
// Inverter units as devices of their own: the home-level binding ends before the data, each unit is bound.
async function units(site, parts) {
  await unbind(site.id, 'inverter_5min', { at: 0, reason: 'units are devices of their own' });
  for (const p of parts) {
    const dev = await addDevice({ siteId: site.id, kind: 'inverter', provider: 'synthetic', externalRef: `${site.name}-${p.ref}`, attrs: p.batteryKwh ? { battery_kwh: p.batteryKwh } : {} });
    await bind(site.id, 'inverter_5min', 'sunsynk_5min', { from: null, deviceId: dev.id, reason: 'a unit of this home' });
    await ingestObservations(site.id, 'sunsynk_5min', observations(p.samples, p.has), null, { deviceId: dev.id });
  }
}
const home = async (name, extra = {}) => await createSite({ name, market: 'GB', postcode: 'M1 1AE', gspRegion: 'G', pvKwp: 4, isDemo: true, ...extra });
const base = (seed, batteryKwh = 9.5, pvPeakW = 2600) => synthesise({ tz: TZ, fromDate: FROM, toDate: TO, seed, pvPeakW, batteryKwh, sunrise: 7.5, sunset: 16.5 });
const ALL = { pv: true, load: true, grid: true, battery: true };

// name -> { site, samples (the whole home's truth), note }
export const TOPOLOGIES = {
  async hybrid() {
    const site = await home('Topology: hybrid inverter and battery', { batteryKwh: 9.5 });
    const samples = base(31);
    await ingestObservations(site.id, 'sunsynk_5min', observations(samples, ALL), null);
    await meters(site, samples);
    return { site, samples };
  },
  async no_battery() {
    const site = await home('Topology: no battery');
    const samples = withoutBattery(base(32, 0.001));
    await ingestObservations(site.id, 'sunsynk_5min', observations(samples, { pv: true, load: true, grid: true }), null);
    await meters(site, samples);
    return { site, samples };
  },
  async export_only() {
    const site = await home('Topology: export meter only');
    const samples = withoutBattery(base(33, 0.001));
    await ingestObservations(site.id, 'sunsynk_5min', observations(samples, { pv: true, load: true, grid: true }), null);
    await meters(site, samples, { importMeter: false });
    return { site, samples };
  },
  async two_inverters() {
    const site = await home('Topology: two inverters', { batteryKwh: 15 });
    const a = base(34, 9.5, 2600); const b = base(35, 5.5, 1600);
    const samples = a.map((x, i) => { const y = b[i]; return { ts: x.ts, solar: x.solar + y.solar, load: x.load + y.load, imp: x.imp + y.imp, exp: x.exp + y.exp, chg: x.chg + y.chg, dis: x.dis + y.dis }; });
    await units(site, [{ ref: 'A', samples: a, has: ALL, batteryKwh: 9.5 }, { ref: 'B', samples: b, has: ALL, batteryKwh: 5.5 }]);
    await meters(site, samples);
    return { site, samples };
  },
  async ac_coupled() {
    const site = await home('Topology: AC-coupled battery', { batteryKwh: 9.5 });
    const samples = base(36);
    // The PV inverter reports only its output; the battery inverter holds the grid clamp, the house and the battery.
    await units(site, [{ ref: 'PV', samples, has: { pv: true } }, { ref: 'BATTERY', samples, has: { load: true, grid: true, battery: true }, batteryKwh: 9.5 }]);
    await meters(site, samples);
    return { site, samples, note: 'R1: units that each measure part of the system are not combined yet (the coverage of a slot is the least covered unit\'s, and a unit that does not measure solar covers none): built from the thing graph in Phase 2.7' };
  },
  async ev() {
    const site = await home('Topology: EV charged overnight', { batteryKwh: 9.5 });
    const evW = (ts) => { const { hh } = zonedParts(TZ, ts); return hh >= 1 && hh < 4 ? 7000 : 0; };
    const samples = plusLoad(base(37), evW);
    await ingestObservations(site.id, 'sunsynk_5min', observations(samples, ALL), null);
    await meters(site, samples);
    const ev = await addDevice({ siteId: site.id, kind: 'ev', provider: 'synthetic', externalRef: 'EV' });
    const sessions = [];
    for (const d of [FROM, TO]) { const [s] = dayBounds(TZ, d); sessions.push({ start: s + 3600, end: s + 4 * 3600, value: 21 }); }
    await putIntervals(await seriesId('site', site.id, 'ev_charge_kwh', 'octopus_kraken'), sessions);
    void ev;
    return { site, samples };
  },
  async heat_pump() {
    const site = await home('Topology: heat pump', { batteryKwh: 9.5 });
    const hpW = (ts) => { const { hh } = zonedParts(TZ, ts); return (hh >= 5 && hh < 9) || (hh >= 16 && hh < 22) ? 1500 : 300; };
    const samples = plusLoad(base(38), hpW);
    await ingestObservations(site.id, 'sunsynk_5min', observations(samples, ALL), null);
    await meters(site, samples);
    const pump = await addDevice({ siteId: site.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'HP' });
    const stat = await addDevice({ siteId: site.id, kind: 'thermostat', provider: 'synthetic', externalRef: 'TH' });
    const steps = (s) => { const o = []; for (let t = T0; t < T1; t += s) o.push(t); return o; };
    const halfKwh = (t) => { let e = 0; for (let x = t; x < t + 1800; x += 300) e += kwh(hpW(x)); return Math.round(e * 1000) / 1000; };
    await putIntervals(await seriesId('device', pump.id, 'heatpump_elec_kwh', 'heating_telemetry'), steps(1800).map((t) => ({ start: t, end: t + 1800, value: halfKwh(t) })));
    await putIntervals(await seriesId('device', pump.id, 'heat_output_kwh', 'heating_telemetry'), steps(1800).map((t) => ({ start: t, end: t + 1800, value: Math.round(halfKwh(t) * 3.2 * 1000) / 1000 })));
    await putReadings(await seriesId('device', stat.id, 'indoor_temp_c', 'heating_telemetry'), steps(300).map((ts) => ({ ts, value: 19 + (zonedParts(TZ, ts).hh >= 7 && zonedParts(TZ, ts).hh < 22 ? 1.5 : 0) })));
    await putReadings(await seriesId('site', site.id, 'outdoor_temp_c', 'open_meteo'), steps(3600).map((ts) => ({ ts, value: 6 })));
    return { site, samples };
  },
};

// Build one topology's home over its days (slots, days, checks; heating rows for the heat pump).
export async function buildTopology(name) {
  const t = await TOPOLOGIES[name]();
  await buildSite(t.site.id, FROM, TO, { reason: `topology ${name}` });
  if (name === 'heat_pump') await buildHeat(t.site.id, FROM, TO);
  return t;
}
