// Point state (plan 2.9, src/core/point-state.js): the device shadow. The latest reported value of a point follows the facts stored for it,
// never goes back to an older time, and the value asked of a point is kept beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { seriesId, putReadings, putIntervals, putForecasts, asWriter } = await import('../src/core/facts.js');
const { stateOf, setDesired, clearDesired } = await import('../src/core/point-state.js');
const { pointOf } = await import('../src/core/points.js');

const NOW = 1_800_000_000;
const home = await createSite({ name: 'State home' });
const bat = await addDevice({ siteId: home.id, kind: 'battery', provider: 'test', externalRef: 'state-bat' });
const shadow = async (key) => (await stateOf(bat.id)).find((p) => p.key === key);
const write = (source, fn) => asWriter(source, fn);

await test('the latest reading is the state; an older one stored later does not take it back', async () => {
  const s = await seriesId('device', bat.id, 'battery_soc_pct', 'sunsynk_5min');
  await write('sunsynk_5min', async () => { await putReadings(s, [{ ts: NOW, value: 50 }, { ts: NOW + 300, value: 55 }]); });
  assert.deepEqual((await shadow('battery_soc_pct')).reported, { value: 55, ts: NOW + 300, source: 'sunsynk_5min', recorded_at: (await shadow('battery_soc_pct')).reported.recorded_at });
  await write('sunsynk_5min', async () => { await putReadings(s, [{ ts: NOW - 600, value: 10 }]); });
  assert.equal((await shadow('battery_soc_pct')).reported.value, 55, 'a backfill of older time leaves the state alone');
  await write('sunsynk_5min', async () => { await putReadings(s, [{ ts: NOW + 600, value: 60 }]); });
  assert.deepEqual([(await shadow('battery_soc_pct')).reported.value, (await shadow('battery_soc_pct')).reported.ts], [60, NOW + 600]);
  await write('sunsynk_5min', async () => { await putReadings(s, [{ ts: NOW + 600, value: 61 }]); });
  assert.equal((await shadow('battery_soc_pct')).reported.value, 61, 'a correction of the latest reading is the state');
});

await test('another source for the same point: the newer time wins, and the source is named', async () => {
  const other = await seriesId('device', bat.id, 'battery_soc_pct', 'sunsynk_live');
  await write('sunsynk_live', async () => { await putReadings(other, [{ ts: NOW + 900, value: 70 }]); });
  const r = (await shadow('battery_soc_pct')).reported;
  assert.deepEqual([r.value, r.source], [70, 'sunsynk_live']);
});

await test('a period is reported at its end; a forecast is not a report', async () => {
  const e = await seriesId('device', bat.id, 'battery_charge_kwh', 'sunsynk_daily');
  await write('sunsynk_daily', async () => { await putIntervals(e, [{ start: NOW, end: NOW + 1800, value: 0.4 }]); });
  assert.deepEqual([(await shadow('battery_charge_kwh')).reported.value, (await shadow('battery_charge_kwh')).reported.ts], [0.4, NOW + 1800]);
  const f = await seriesId('device', bat.id, 'battery_discharge_kwh', 'core_forecast');
  await write('core_forecast', async () => { await putForecasts(f, NOW, [{ start: NOW + 3600, end: NOW + 5400, value: 1 }]); });
  assert.equal((await shadow('battery_discharge_kwh')).reported, null, 'a prediction says nothing of what the point is doing');
});

await test('what is asked of a point is kept beside what it reports; a read-only point cannot be asked', async () => {
  await assert.rejects(() => setDesired(Number((await shadow('battery_soc_pct')).id), 80), /read only/);
  const reserve = await pointOf(bat.id, 'ctl_reserve_pct');
  await setDesired(reserve, 30, { by: 'manual', commandId: 7, at: NOW });
  const d = (await shadow('ctl_reserve_pct')).desired;
  assert.deepEqual(d, { value: 30, ts: NOW, by: 'manual', commandId: 7 });
  assert.equal((await shadow('ctl_reserve_pct')).reported, null, 'asked is not reported');
  await clearDesired(reserve);
  assert.equal((await shadow('ctl_reserve_pct')).desired, null);
  await assert.rejects(() => setDesired(reserve, 'x'), /a number/);
  await assert.rejects(() => setDesired(999999, 1), /no such point/);
});
