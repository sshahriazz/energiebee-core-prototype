// Grid carbon for France: RTE éCO2mix (src/adapters/rte.js), one national series carbon:FR read by every French
// home (src/core/carbon-series.js), as a second default source of the carbon role (delta 081). No network: every
// RTE answer here is a fake, in the shape the live export endpoint gave (Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const realFetchLocal = globalThis.fetch;   // the platform fetch, for the test server on 127.0.0.1
const asked = [];
let answer = () => [];
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetchLocal(url, opts);
  if (u.host !== 'odre.opendatasoft.com') throw new Error(`no network in tests: ${url}`);
  const dataset = u.pathname.split('/')[6];
  asked.push({ dataset, where: u.searchParams.get('where') });
  return json(answer(dataset, u));
};

const { db } = await import('../src/db/db.js');
const RTE = await import('../src/adapters/rte.js');
const { carbonSeriesOf, carbonSubjectOf } = await import('../src/core/carbon-series.js');
const { bindingsFor } = await import('../src/core/inputs.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildSite } = await import('../src/core/build.js');
const { seriesId, putIntervals, readIntervals } = await import('../src/core/facts.js');
const { dayBounds, isoUtc } = await import('../src/core/time.js');

const TZ = 'Europe/Paris';
const DAY = '2026-11-09';
const [A, B] = dayBounds(TZ, DAY);
const row = (ts, v) => ({ date_heure: isoUtc(ts).replace('Z', '+00:00'), taux_co2: v });
const frSeries = () => seriesId('region', 'carbon:FR', 'carbon_intensity', 'rte_eco2mix');

function frHome(name) {
  const site = createSite({ name, country: 'FR', postcode: '79200', lat: 46.62, lon: -0.21 });
  const dev = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: `PDL-${name}` });
  const t = createTariff({ provider: 'test', tariffCode: `TEST-${name}`, country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', origin: 'user' });
  putRateRows(t.id, [{ component: 'unit', validFrom: A, price: 20 }]);
  agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: A });
  const rows = [];
  for (let s = A; s < B; s += 1800) rows.push({ start: s, end: s + 1800, value: 0.5 });
  putIntervals(seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), rows);
  return site;
}

test('which series a home reads: its NESO region in GB, the national series in France, none elsewhere', () => {
  assert.deepEqual(carbonSeriesOf({ country: 'GB', carbon_region: 3 }), { subject: 'carbon:3', source: 'carbon_regional', provider: 'NESO', scope: 'region 3', forecast: true });
  assert.deepEqual({ ...carbonSeriesOf({ country: 'FR', carbon_region: null }) }, { subject: 'carbon:FR', source: 'rte_eco2mix', provider: 'RTE éCO2mix', scope: 'national', forecast: false });
  assert.equal(carbonSubjectOf({ country: 'NL', carbon_region: null }), null, 'the Netherlands: no carbon source yet');
  assert.equal(carbonSubjectOf({ country: 'GB', carbon_region: null }), null, 'a GB home before its postcode look-up');
});

test('every home binds both carbon sources, NESO first: a new home from binding_default, a GB home still reads NESO', () => {
  const fr = createSite({ name: 'Bindings FR', country: 'FR' });
  const gb = createSite({ name: 'Bindings GB', postcode: 'BB12 9BY', carbonRegion: 3 });
  for (const s of [fr, gb]) assert.deepEqual(bindingsFor(s.id, 'carbon').map((b) => b.source), ['carbon_regional', 'rte_eco2mix'], s.name);
  assert.ok(db.prepare("SELECT 1 FROM schema_delta WHERE name = '081-carbon-rte'").get());
});

test('the export URL asks one dataset for the window, non-null values only, oldest first', () => {
  const u = new URL(RTE.exportUrl('eco2mix-national-tr', A, B));
  assert.equal(u.pathname, '/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/exports/json');
  assert.equal(u.searchParams.get('select'), 'date_heure,taux_co2');
  assert.equal(u.searchParams.get('where'), `date_heure >= '${isoUtc(A)}' and date_heure < '${isoUtc(B)}' and taux_co2 is not null`);
  assert.equal(u.searchParams.get('order_by'), 'date_heure');
});

test('mapping: each value for its own period (15 min real time, 30 min consolidated); nulls skipped; a bad answer is a problem', () => {
  assert.deepEqual(RTE.mapRows([row(A, 68), row(A + 900, null), row(A + 1800, 70)], 900).rows,
    [{ point: 'intensity', start: A, end: A + 900, value: 68 }, { point: 'intensity', start: A + 1800, end: A + 2700, value: 70 }]);
  assert.equal(RTE.mapRows([row(A, 29)], 1800).rows[0].end, A + 1800);
  assert.match(RTE.mapRows({ error: 'x' }, 900).problem, /not a list/);
  assert.match(RTE.mapRows([{ taux_co2: 3 }], 900).problem, /without date_heure/);
  assert.match(RTE.mapRows([row(A, 'n/a')], 900).problem, /unreadable/);
});

test('sync: real-time values land on carbon:FR (raw kept); the part of the window before them comes from the consolidated set', async () => {
  const site = frHome('Sync FR');
  asked.length = 0;
  // Real time from A + 2 h (every 15 min, 60 then 80 gCO2/kWh alternating); consolidated before that (30 min, 40).
  answer = (dataset) => {
    if (dataset === 'eco2mix-national-tr') { const out = []; for (let t = A + 7200; t < B; t += 900) out.push(row(t, ((t - A) / 900) % 2 ? 80 : 60)); return out; }
    const out = []; for (let t = A; t < A + 7200; t += 1800) out.push(row(t, 40)); return out;
  };
  const r = await RTE.syncRteCarbon(site, A, B);
  assert.deepEqual(asked.map((a) => a.dataset), ['eco2mix-national-tr', 'eco2mix-national-cons-def']);
  assert.match(asked[1].where, new RegExp(`date_heure < '${isoUtc(A + 7200)}'`), 'consolidated only up to the first real-time value');
  assert.deepEqual([r.rows, r.consolidated, r.written], [88, 4, 92]);
  const facts = readIntervals([frSeries()], A, B);
  assert.equal(facts.length, 92);
  assert.deepEqual([facts[0].end_ts - facts[0].start_ts, facts.at(-1).end_ts - facts.at(-1).start_ts], [1800, 900]);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM raw_payload p JOIN source s ON s.id = p.source_id WHERE s.code = 'rte_eco2mix' AND p.status = 'accepted'").get().n >= 2);
  // The same answer again changes nothing.
  assert.equal((await RTE.syncRteCarbon(site, A, B)).written, 0);
});

test('a French home is built with carbon from RTE: a half-hour takes the mean of its two quarter-hours', () => {
  const site = db.prepare("SELECT * FROM site WHERE name = 'Sync FR'").get();
  buildSite(site.id, DAY, DAY);
  const at = (ts) => db.prepare('SELECT carbon_intensity, carbon_g, grid_import FROM site_hh WHERE site_id = ? AND slot_start = ?').get(site.id, ts);
  assert.equal(at(A).carbon_intensity, 40, 'consolidated half-hour');
  assert.equal(at(A + 7200).carbon_intensity, 70, '(60 + 80) / 2');
  assert.ok(Math.abs(at(A + 7200).carbon_g - 0.5 * 70) < 1e-9, 'carbon of the imported half-hour: kWh x gCO2/kWh');
  assert.equal(JSON.parse(db.prepare('SELECT lineage FROM site_hh WHERE site_id = ? AND slot_start = ?').get(site.id, A).lineage).carbon !== undefined, true);
});

test('an unexpected answer is quarantined and the step fails, nothing stored', async () => {
  const site = frHome('Bad answer');
  answer = () => ({ error_code: 'ODSQLError', message: 'bad where' });
  const before = readIntervals([frSeries()], 0, 9e9).length;
  await assert.rejects(RTE.syncRteCarbon(site, A, B), /unexpected answer \(not a list\), quarantined/);
  assert.equal(readIntervals([frSeries()], 0, 9e9).length, before);
  assert.ok(db.prepare("SELECT 1 FROM raw_payload p JOIN source s ON s.id = p.source_id WHERE s.code = 'rte_eco2mix' AND p.status = 'quarantined'").get());
});

test('a GB home is untouched: its NESO region series is read, RTE values for France never reach it', () => {
  const gb = createSite({ name: 'GB carbon', postcode: 'BB12 9BY', lat: 53.79, lon: -2.24, gspRegion: 'G', carbonRegion: 3 });
  const [a] = dayBounds('Europe/London', DAY);
  putIntervals(seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional'), [{ start: a, end: a + 1800, value: 123 }]);
  const dev = addDevice({ siteId: gb.id, kind: 'meter_import', provider: 'test', externalRef: 'MPAN-GB' });
  putIntervals(seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), [{ start: a, end: a + 1800, value: 1 }]);
  buildSite(gb.id, DAY, DAY);
  assert.equal(db.prepare('SELECT carbon_intensity FROM site_hh WHERE site_id = ? AND slot_start = ?').get(gb.id, a).carbon_intensity, 123);
});

test('"Grid carbon now" for a French home: RTE has no forecast, so the latest published value, at most an hour old', async () => {
  const { app } = await import('../src/server.js');
  const { nowSec, floorTo } = await import('../src/core/time.js');
  const srv = app.listen(0);
  const site = createSite({ name: 'Now FR', country: 'FR' });
  const get = async () => (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/sites/${site.id}/now`)).json()).carbon;
  try {
    const q = floorTo(nowSec(), 900);
    putIntervals(frSeries(), [{ start: q - 7200, end: q - 6300, value: 90 }]);
    assert.equal(await get(), null, 'two hours old: not shown as "now"');
    putIntervals(frSeries(), [{ start: q - 900, end: q, value: 58 }]);
    assert.equal(await get(), 58, 'the latest quarter-hour, published about 30 minutes behind');
  } finally { srv.close(); }
});

test('new RTE values mark a French home for rebuild from their first period (the sync\'s earliest change)', async () => {
  const { earliestChange } = await import('../src/jobs/sync.js');
  const site = frHome('Changes FR');
  await new Promise((r) => setTimeout(r, 20));   // the home's own meter rows are older than `since`
  const since = Date.now();
  answer = (dataset) => (dataset === 'eco2mix-national-tr' ? [row(A + 3600, 51), row(A + 4500, 52)] : []);
  await RTE.syncRteCarbon(site, A + 3600, B);
  assert.equal(earliestChange(site.id, site, since), A + 3600);
});
