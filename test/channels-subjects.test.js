// Channels for region subjects (carbon, gas calorific value) and forecast observations (carbon forward, Quartz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { ingestObservations } = await import('../src/core/channels.js');
const { seriesId, readIntervals, QUALITY } = await import('../src/core/facts.js');

const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('subjects', 0)").run().lastInsertRowid);
const queue = () => db.prepare('SELECT COUNT(*) n FROM rebuild_queue WHERE site_id = ?').get(site).n;
const NOW = Math.floor(Date.now() / 1000);

test('a region subject: carbon periods are stored under the region with their quality, and mark a rebuild', () => {
  const subject = { kind: 'region', id: 'carbon:3' };
  const out = ingestObservations(site, 'carbon_regional', [
    { point: 'intensity', start: NOW - 7200, end: NOW - 5400, value: 120, quality: QUALITY.ESTIMATED },
    { point: 'intensity', start: NOW - 5400, end: NOW - 3600, value: 140, quality: QUALITY.ESTIMATED }], null, { subject });
  assert.equal(out.written, 2);
  const rows = readIntervals([seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional')], 0, 2e9);
  assert.deepEqual(rows.map((r) => [r.value, r.quality]), [[120, QUALITY.ESTIMATED], [140, QUALITY.ESTIMATED]]);
  assert.ok(queue() > 0, 'facts about the past queue a rebuild');
});

test('forecast observations: stored as an issue, counted apart, and they queue no rebuild', () => {
  const before = queue();
  const out = ingestObservations(site, 'carbon_regional', [
    { point: 'intensity', start: NOW, end: NOW + 1800, issuedAt: NOW, value: 99 }], null, { subject: { kind: 'region', id: 'carbon:3' } });
  assert.deepEqual([out.written, out.forecasts], [0, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM forecast_fact WHERE series_id = ?').get(seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional')).n, 1);
  assert.equal(queue(), before);
});

test('Quartz: kW over a 15-minute step becomes kWh by the channel, a negative power becomes 0', () => {
  const out = ingestObservations(site, 'quartz', [
    { point: 'power_kw', start: NOW, end: NOW + 900, issuedAt: NOW, value: 2 }, { point: 'power_kw', start: NOW + 900, end: NOW + 1800, issuedAt: NOW, value: -0.4 }], null);
  assert.equal(out.forecasts, 2);
  const rows = db.prepare('SELECT value FROM forecast_fact WHERE series_id = ? ORDER BY start_ts').all(seriesId('site', site, 'solar_kwh', 'quartz')).map((r) => r.value);
  assert.deepEqual(rows, [0.5, 0]);
});

test('gas calorific value: a day period under the region of its zone', () => {
  const out = ingestObservations(site, 'national_gas_cv', [{ point: 'calorific_value', start: NOW - 86400, end: NOW, value: 39.2, quality: QUALITY.MEASURED }], null, { subject: { kind: 'region', id: 'ldz:NW' } });
  assert.equal(out.written, 1);
  assert.equal(readIntervals([seriesId('region', 'ldz:NW', 'gas_cv_mjm3', 'national_gas_cv')], 0, 2e9)[0].value, 39.2);
});
