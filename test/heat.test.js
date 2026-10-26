// The heating serving table (site_heat_slot, src/core/heat.js) on SYNTHETIC homes in an empty database:
//  - a heat pump home on 15-minute slots: heat pump electricity in 30-minute facts (split in two), heat
//    delivered in 15-minute facts, a thermostat's indoor temperature, set-point and heating on/off,
//    Open-Meteo's outdoor temperature, a flat import tariff; with a 6-hour gap in every series and a
//    2-hour gap in the electricity only;
//  - a gas boiler home on 30-minute slots: boiler gas, indoor temperature, heating on/off and the
//    return temperature on the home itself, a flat gas tariff;
// over the October clock change (25 h: 100 quarter-hours, 50 half-hours) and the March one (23 h).
// Every expected number is worked out by hand below. GB electricity VAT is 0 % from 1 Oct 2026 and
// gas 5 % (registry.js VAT_RATES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { seriesId, putReadings, putIntervals, markDirty, QUALITY } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildHeat, hasHeatingSeries, HEAT_METHOD_VERSION } = await import('../src/core/heat.js');
const { processQueue } = await import('../src/core/build.js');
const { dayBounds, localToUtc } = await import('../src/core/time.js');

const TZ = 'Europe/London';
const at = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return localToUtc(TZ, y, m, d, hh, mm); };
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const SYN = { origin: 'synthetic', provider: 'synthetic', country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat' };
const inGap = (t, gaps) => gaps.some(([a, b]) => t >= a && t < b);
const tele = (subjectKind, subjectId, metric) => seriesId(subjectKind, subjectId, metric, 'heating_telemetry');
// 5-minute thermostat pattern: 20 °C for the first 10 minutes of each quarter-hour, 21 °C for the last 5
// (time-weighted mean 20.333...), heating on for the first 10 minutes (share 2/3).
const tempAt = (t) => (Math.floor(t / 60) % 15 < 10 ? 20 : 21);
const onAt = (t) => (Math.floor(t / 60) % 15 < 10 ? 1 : 0);
const steps = (a, b, s) => { const out = []; for (let t = a; t < b; t += s) out.push(t); return out; };

function priceHome(site, kind, fuel, code, unit, a, b) {
  const meter = addDevice({ siteId: site.id, kind, provider: 'synthetic', externalRef: `${code}-METER` });
  const t = createTariff({ ...SYN, tariffCode: code, fuel, name: `Synthetic ${fuel}` });
  putRateRows(t.id, [{ component: 'unit', validFrom: a, validTo: b, price: unit }]);
  agreeTariff({ siteId: site.id, deviceId: meter.id, tariffId: t.id, validFrom: a, validTo: b });
}
function outdoor(site, a, b) {
  putReadings(seriesId('site', site.id, 'outdoor_temp_c', 'open_meteo'), steps(a - 3600, b, 3600).map((ts) => ({ ts, value: 5.5 })));
}

// ── Heat pump home, 15-minute slots ──
const hp = createSite({ name: 'Heat pump home', slotS: 900, isDemo: true });
const pump = addDevice({ siteId: hp.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'HP-1' });
const stat = addDevice({ siteId: hp.id, kind: 'thermostat', provider: 'synthetic', externalRef: 'TH-1' });
const [A] = dayBounds(TZ, '2026-10-24'); const [B] = dayBounds(TZ, '2026-10-26');
const G_ALL = [at('2026-10-24', 2), at('2026-10-24', 8)];      // every heating series silent for 6 hours
const G_ELEC = [at('2026-10-24', 10), at('2026-10-24', 12)];   // only the electricity missing
priceHome(hp, 'meter_import', 'electricity', 'TEST-HEAT-ELEC', 24, A, B);
outdoor(hp, A, B);
putIntervals(tele('device', pump.id, 'heatpump_elec_kwh'), steps(A, B, 1800).filter((t) => !inGap(t, [G_ALL, G_ELEC])).map((t) => ({ start: t, end: t + 1800, value: 0.5 })));
putIntervals(tele('device', pump.id, 'heat_output_kwh'), steps(A, B, 900).filter((t) => !inGap(t, [G_ALL])).map((t) => ({ start: t, end: t + 900, value: 0.9 })));
putReadings(tele('device', stat.id, 'indoor_temp_c'), steps(A, B, 300).filter((t) => !inGap(t, [G_ALL])).map((ts) => ({ ts, value: tempAt(ts) })));
putReadings(tele('device', stat.id, 'heating_on'), steps(A, B, 300).filter((t) => !inGap(t, [G_ALL])).map((ts) => ({ ts, value: onAt(ts) })));
putReadings(tele('device', stat.id, 'indoor_temp_setpoint_c'), steps(A, B, 7200).filter((t) => !inGap(t, [G_ALL])).map((ts) => ({ ts, value: 21 })));

// ── Gas boiler home, 30-minute slots, series on the home itself ──
const bg = createSite({ name: 'Boiler home', slotS: 1800, isDemo: true });
const windows = [[dayBounds(TZ, '2026-03-28')[0], dayBounds(TZ, '2026-03-30')[0]], [A, B]];
priceHome(bg, 'meter_gas', 'gas', 'TEST-HEAT-GAS', 6, windows[0][0], B);
for (const [a, b] of windows) {
  outdoor(bg, a, b);
  putIntervals(tele('site', bg.id, 'boiler_gas_kwh'), steps(a, b, 1800).map((t) => ({ start: t, end: t + 1800, value: 1.2 })));
  putReadings(tele('site', bg.id, 'indoor_temp_c'), steps(a, b, 300).map((ts) => ({ ts, value: tempAt(ts) })));
  putReadings(tele('site', bg.id, 'heating_on'), steps(a, b, 300).map((ts) => ({ ts, value: onAt(ts) })));
  putReadings(tele('site', bg.id, 'boiler_return_temp_c'), steps(a, b, 300).map((ts) => ({ ts, value: 45 })));
}
const T1 = Date.now();

const rowsOf = (siteId, from = 0, to = 4e9) => db.prepare('SELECT * FROM site_heat_slot WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start').all(siteId, from, to).map((r) => ({ ...r }));
const row = (siteId, ts) => db.prepare('SELECT * FROM site_heat_slot WHERE site_id = ? AND slot_start = ?').get(siteId, ts);
const noBuiltAt = (rows) => rows.map(({ built_at, ...r }) => r);

test('only homes with a heating series have one', () => {
  assert.equal(hasHeatingSeries(hp.id), true);
  assert.equal(hasHeatingSeries(bg.id), true);
  const plain = createSite({ name: 'Battery home', isDemo: true });
  putReadings(seriesId('site', plain.id, 'outdoor_temp_c', 'open_meteo'), [{ ts: A, value: 5 }]);
  assert.equal(hasHeatingSeries(plain.id), false, 'weather alone is not heating');
  assert.deepEqual(buildHeat(plain.id, '2026-10-24', '2026-10-25'), { days: 0, slots: 0, skipped: 'no heating series' });
});

test('heat pump home, 15-minute slots: a normal quarter-hour worked out by hand', () => {
  const r = buildHeat(hp.id, '2026-10-24', '2026-10-25');
  assert.deepEqual(r, { days: 2, slots: 96 + 100 });
  const s = row(hp.id, at('2026-10-24', 14));
  assert.equal(s.dur_s, 900);
  assert.equal(s.tod_min, 14 * 60);
  assert.equal(s.state, 'final');
  assert.equal(s.quality, QUALITY.MEASURED);
  near(s.heating_energy_kwh, 0.25, 1e-12, 'half of a 0.5 kWh half-hour');
  near(s.heat_output_kwh, 0.9);
  near(s.cop, 3.6, 1e-12);
  assert.equal(s.heating_fuel, 'electricity');
  near(s.cost_minor, 0.25 * 24, 1e-9, 'pence at 24 p/kWh, 0 % VAT');
  assert.equal(s.currency, 'GBP');
  near(s.indoor_temp_c, (20 * 600 + 21 * 300) / 900, 1e-9);
  near(s.setpoint_c, 21);
  near(s.heating_on_fraction, 2 / 3, 1e-12);
  near(s.outdoor_temp_c, 5.5);
  near(s.degree_hours, (15.5 - 5.5) * 0.25, 1e-12);
  assert.equal(s.heating_demand_kwh, null, 'no demand series: never estimated');
  assert.equal(s.method_version, HEAT_METHOD_VERSION);
  const lin = JSON.parse(s.lineage);
  assert.deepEqual(lin.series.heatpump_elec_kwh, ['heating_telemetry']);
  assert.equal(lin.outdoor, 'open_meteo');
  assert.equal(lin.import.tariff, 'TEST-HEAT-ELEC');
  assert.equal(lin.cop, 'heat_output_kwh / heatpump_elec_kwh');
  assert.equal(lin.origin, 'synthetic');
  assert.equal(lin.data_origin, 'synthetic');
  assert.equal(lin.base_temp_c, 15.5);
});

test('clock change: 100 quarter-hours on 25 Oct, the repeated hour twice with its own instants', () => {
  const day = rowsOf(hp.id, ...dayBounds(TZ, '2026-10-25'));
  assert.equal(day.length, 100);
  assert.equal(new Set(day.map((r) => r.slot_start)).size, 100);
  for (const m of [60, 75, 90, 105]) assert.equal(day.filter((r) => r.tod_min === m).length, 2, `01:${String(m - 60).padStart(2, '0')} twice`);
  assert.ok(day.every((r) => r.state === 'final'));
  near(day.reduce((s, r) => s + r.heating_energy_kwh, 0), 25 * 4 * 0.25, 1e-9, '25 hours of electricity');
  near(day.reduce((s, r) => s + r.cost_minor, 0), 25 * 4 * 0.25 * 24, 1e-6);
});

test('missing data: nothing at all is missing; a series that stops short makes the slot provisional and partial', () => {
  const oct24 = rowsOf(hp.id, ...dayBounds(TZ, '2026-10-24'));
  // 05:00-08:00: the last thermostat readings (01:55) hold 3 hours at most, so nothing covers these.
  const missing = oct24.filter((r) => r.state === 'missing');
  assert.deepEqual(missing.map((r) => r.slot_start), steps(at('2026-10-24', 5), at('2026-10-24', 8), 900));
  for (const r of missing) {
    assert.equal(r.quality, 0);
    assert.deepEqual([r.heating_energy_kwh, r.indoor_temp_c, r.cost_minor, r.cop], [null, null, null, null]);
    near(r.outdoor_temp_c, 5.5, 1e-12, 'weather is still known');
  }
  // 02:00-05:00: indoor temperature held from 01:55, no energy: provisional, partial, no cost.
  const held = row(hp.id, at('2026-10-24', 3));
  assert.equal(held.state, 'provisional');
  assert.equal(held.quality, QUALITY.MEASURED | QUALITY.PARTIAL);
  assert.deepEqual([held.heating_energy_kwh, held.heat_output_kwh, held.cost_minor], [null, null, null]);
  near(held.indoor_temp_c, 21, 1e-12, 'the 01:55 reading (21 °C) holding');
  // 10:00-12:00: only the electricity is missing.
  const noElec = row(hp.id, at('2026-10-24', 10, 30));
  assert.equal(noElec.state, 'provisional');
  assert.ok(noElec.quality & QUALITY.PARTIAL);
  assert.deepEqual([noElec.heating_energy_kwh, noElec.cop, noElec.cost_minor], [null, null, null]);
  near(noElec.heat_output_kwh, 0.9);
  assert.deepEqual(JSON.parse(noElec.lineage).incomplete, ['heatpump_elec_kwh']);
  assert.equal(oct24.filter((r) => r.state === 'final').length, 96 - 6 * 4 - 2 * 4);
});

test('gas boiler home, 30-minute slots: gas priced with 5 % VAT, no COP, return temperature, both clock changes', () => {
  assert.deepEqual(buildHeat(bg.id, '2026-10-24', '2026-10-25'), { days: 2, slots: 48 + 50 });
  assert.deepEqual(buildHeat(bg.id, '2026-03-28', '2026-03-29'), { days: 2, slots: 48 + 46 });
  const s = row(bg.id, at('2026-10-24', 14));
  assert.equal(s.dur_s, 1800);
  assert.equal(s.state, 'final');
  near(s.heating_energy_kwh, 1.2);
  assert.equal(s.heating_fuel, 'gas');
  assert.equal(s.cop, null);
  assert.equal(s.heat_output_kwh, null);
  near(s.cost_minor, 1.2 * 6 * 1.05, 1e-9);
  near(s.degree_hours, (15.5 - 5.5) * 0.5, 1e-12);
  near(s.indoor_temp_c, (20 * 600 + 21 * 300) / 900, 1e-9);
  near(s.heating_on_fraction, 2 / 3, 1e-12);
  near(s.return_temp_c, 45);
  assert.equal(s.flow_temp_c, null);
  assert.equal(JSON.parse(s.lineage).gas.tariff, 'TEST-HEAT-GAS');
  assert.equal(rowsOf(bg.id, ...dayBounds(TZ, '2026-10-25')).length, 50);
  const spring = rowsOf(bg.id, ...dayBounds(TZ, '2026-03-29'));
  assert.equal(spring.length, 46);
  assert.ok(!spring.some((r) => r.tod_min === 60 || r.tod_min === 90), '01:00-02:00 does not exist that day');
  assert.ok(spring.every((r) => r.state === 'final'));
});

test('idempotent rebuild, dry run writes nothing, and "as known at" reads the facts known then', () => {
  const first = noBuiltAt(rowsOf(bg.id));
  buildHeat(bg.id, '2026-10-24', '2026-10-25');
  buildHeat(bg.id, '2026-03-28', '2026-03-29');
  assert.deepEqual(noBuiltAt(rowsOf(bg.id)), first, 'the same rows again');
  const dry = buildHeat(bg.id, '2026-10-24', '2026-10-25', { dryRun: true });
  assert.equal(dry.rows.length, 98);
  assert.deepEqual(noBuiltAt(dry.rows), noBuiltAt(rowsOf(bg.id, A, B)));
  // A correction recorded a day later: an as-of build before it still sees 1.2 kWh.
  const slot = at('2026-10-24', 14);
  const real = Date.now;
  Date.now = () => T1 + 86400000;
  try { putIntervals(tele('site', bg.id, 'boiler_gas_kwh'), [{ start: slot, end: slot + 1800, value: 2.0 }]); } finally { Date.now = real; }
  const then = buildHeat(bg.id, '2026-10-24', '2026-10-25', { dryRun: true, asOf: Math.ceil(T1 / 1000) + 1 });
  near(then.rows.find((r) => r.slot_start === slot).heating_energy_kwh, 1.2);
  const nowRows = buildHeat(bg.id, '2026-10-24', '2026-10-25', { dryRun: true });
  near(nowRows.rows.find((r) => r.slot_start === slot).heating_energy_kwh, 2.0);
  near(nowRows.rows.find((r) => r.slot_start === slot).cost_minor, 2.0 * 6 * 1.05, 1e-9);
  assert.equal(row(bg.id, slot).heating_energy_kwh, 1.2, 'dry runs wrote nothing');
});

test('processQueue builds the heating rows after the timeline, for a heating home only', () => {
  db.prepare('DELETE FROM site_heat_slot WHERE site_id = ?').run(bg.id);
  markDirty(bg.id, A, B, 'test');
  const out = processQueue().find((o) => o.siteId === bg.id);
  assert.deepEqual(out.heat, { days: 2, slots: 98 });
  near(row(bg.id, at('2026-10-24', 14)).heating_energy_kwh, 2.0, 1e-12, 'the correction is in');
  const plain = createSite({ name: 'Battery home 2', isDemo: true });
  markDirty(plain.id, A, B, 'test');
  const p = processQueue().find((o) => o.siteId === plain.id);
  assert.equal('heat' in p, false);
  assert.equal(rowsOf(plain.id).length, 0);
});
