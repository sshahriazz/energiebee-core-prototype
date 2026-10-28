// The new IoT roles and device-kind channel defaults. SYNTHETIC heat pump home in an empty database: two sources feed the same
// heat pump electricity; the role decides which one heat.js reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { ROLES, bindingsFor, bind, unbind } = await import('../src/core/inputs.js');
const { ingestObservations, channelsFor } = await import('../src/core/channels.js');
const { seriesId, putIntervals } = await import('../src/core/facts.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { buildHeat } = await import('../src/core/heat.js');
const { dayBounds } = await import('../src/core/time.js');

const NOW = 2000000000;
for (const code of ['stale_vendor', 'hp_vendor']) db.prepare("INSERT INTO source (code, name, contract) VALUES (?, ?, '{}')").run(code, `${code} (test)`);
const site = createSite({ name: 'Heat pump home (synthetic)', slotS: 1800, isDemo: true });
const pump = addDevice({ siteId: site.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'HP-ROLE' });
const [A] = dayBounds('Europe/London', '2026-10-24');
const half = Array.from({ length: 48 }, (_, i) => A + i * 1800);

// An old feed that wrote first (the lower series id) and says 9 kWh a half-hour, and the feed the home means to use: a counter, 0.5 kWh a half-hour.
putIntervals(seriesId('device', pump.id, 'heatpump_elec_kwh', 'stale_vendor'), half.map((t) => ({ start: t, end: t + 1800, value: 9 })));
const counterSamples = [...half, A + 86400].map((ts, i) => ({ point: 'elec_total', ts, value: 100 + i * 0.5 }));
const heatSamples = [...half, A + 86400].map((ts, i) => ({ point: 'heat_total', ts, value: 50 + i * 1.5 }));

test('the new roles exist, and none has a default source', () => {
  for (const r of ['heat_pump_energy', 'heat_output_energy', 'heat_telemetry', 'ev_charger_energy', 'plug_energy']) {
    assert.ok(ROLES.includes(r), r);
    assert.deepEqual(bindingsFor(site.id, r), [], `${r}: no vendor fallback`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM binding_default WHERE role = ?').get(r).n, 0);
  }
  assert.equal(ROLES.length, 13);
});

test('a heat pump device brings its standard channels, for whatever source feeds it', () => {
  const out = ingestObservations(site.id, 'hp_vendor', [...counterSamples, ...heatSamples], null, { deviceId: pump.id, now: NOW });
  assert.equal(out.rejected, 0);
  assert.equal(out.derived, 96);
  const points = channelsFor(site.id, 'hp_vendor', null, pump.id).map((c) => [c.point, c.kind, c.metric, c.derived_metric]).sort();
  assert.deepEqual(points.filter((p) => p[1] === 'counter'), [['elec_total', 'counter', 'heatpump_elec_counter_kwh', 'heatpump_elec_kwh'], ['heat_total', 'counter', 'heat_output_counter_kwh', 'heat_output_kwh']]);
  assert.ok(points.some((p) => p[0] === 'defrost' && p[1] === 'event'));
  assert.ok(points.some((p) => p[0] === 'flow_temp' && p[2] === 'heatpump_flow_temp_c'));
});

const elecOf = () => buildHeat(site.id, '2026-10-24', '2026-10-24', { dryRun: true }).rows.map((r) => r.heating_energy_kwh);

test('heat.js without a binding reads the first heating source it finds (as before)', () => {
  const rows = elecOf();
  assert.equal(rows.length, 48);
  assert.ok(rows.every((v) => v === 9), `unbound: ${rows[0]}`);
});

test('bound to a role, heat.js reads only that source, not the old feed', () => {
  bind(site.id, 'heat_pump_energy', 'hp_vendor', { deviceId: pump.id });
  assert.deepEqual(bindingsFor(site.id, 'heat_pump_energy').map((b) => [b.source, b.deviceId]), [['hp_vendor', pump.id]]);
  const rows = elecOf();
  assert.equal(rows.length, 48);
  assert.ok(rows.every((v) => Math.abs(v - 0.5) < 1e-9), `bound: ${rows[0]} (the counter's 0.5 kWh a half-hour, not the old feed's 9)`);
});

test('a binding that names another device does not read this pump', () => {
  const other = addDevice({ siteId: site.id, kind: 'heat_pump', provider: 'synthetic', externalRef: 'HP-OTHER' });
  unbind(site.id, 'heat_pump_energy', { deviceId: pump.id, at: A, reason: 'test: moved to another pump' });
  bind(site.id, 'heat_pump_energy', 'hp_vendor', { deviceId: other.id, from: A, reason: 'test: moved to another pump' });
  assert.ok(elecOf().every((v) => v == null), 'this pump is no longer the bound device: its electricity is not read (and the stale feed is not a fallback)');
});

test('unbinding the role leaves the home with no heat pump electricity from the window on', () => {
  unbind(site.id, 'heat_pump_energy', { at: A, reason: 'test: provider removed' });
  assert.ok(elecOf().every((v) => v == null));
  assert.equal(bindingsFor(site.id, 'heat_pump_energy').every((b) => b.to <= A), true);
});

test('binding and unbinding the new roles work in an empty home (no built slots, so no reason is needed)', () => {
  assert.equal(bind(site.id, 'plug_energy', 'hp_vendor', { deviceId: pump.id }) > 0, true);
  assert.equal(bind(site.id, 'ev_charger_energy', 'hp_vendor') > 0, true);
  assert.ok(unbind(site.id, 'ev_charger_energy', { at: Math.floor(Date.now() / 1000) + 3600 }) >= 1);
});
