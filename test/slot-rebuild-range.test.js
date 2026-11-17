// Changing a home's slot length rebuilds the days it has, not every day up to today: from its first
// real data day to its last built (or data) day. A home with three days of data rebuilds exactly
// those three days; a home whose data reaches today still rebuilds through today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { createSite, setSlotLength } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildSite, processQueue, factSpan } = await import('../src/core/build.js');
const { seriesId, putIntervals } = await import('../src/core/facts.js');
const { dayBounds, localDate, nowSec, addDays } = await import('../src/core/time.js');

const TZ = 'Europe/London';
async function home(name, from, toTs) {
  const site = await createSite({ name });
  const dev = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: name });
  const t = await createTariff({ provider: 'test', tariffCode: `TEST-${name}`, country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', origin: 'synthetic' });
  const [a] = dayBounds(TZ, from);
  await putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 24 }]);
  await agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: a });
  const rows = [];
  for (let s = a; s + 1800 <= toTs; s += 1800) rows.push({ start: s, end: s + 1800, value: 0.3 });
  await putIntervals(await seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), rows);
  await buildSite(site.id, from, localDate(TZ, toTs - 1));
  return site;
}
const builtDays = async (id) => (await db.prepare('SELECT local_date FROM site_day WHERE site_id = ? ORDER BY local_date').all(id)).map((r) => r.local_date);

await test('a home with three days of data rebuilds exactly those three days in the new length', async () => {
  const site = await home('three-days', '2025-06-10', dayBounds(TZ, '2025-06-12')[1]);
  assert.deepEqual(await builtDays(site.id), ['2025-06-10', '2025-06-11', '2025-06-12']);
  assert.equal(localDate(TZ, (await factSpan(site.id)).last), '2025-06-12');
  for (const slotS of [900, 3600]) {
    const r = await setSlotLength(site.id, slotS);
    assert.equal(r.queued, true);
    const done = (await processQueue()).find((x) => x.siteId === site.id);
    assert.deepEqual([done.from, done.to, done.days], ['2025-06-10', '2025-06-12', 3]);
    assert.deepEqual(await builtDays(site.id), ['2025-06-10', '2025-06-11', '2025-06-12'], 'no empty days up to today');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM site_hh WHERE site_id = ?').get(site.id)).n, (3 * 86400) / slotS);
    assert.ok((await db.prepare('SELECT dur_s FROM site_hh WHERE site_id = ?').all(site.id)).every((x) => x.dur_s === slotS));
  }
});

await test('a home whose data reaches today rebuilds through today', async () => {
  const now = nowSec();
  const today = localDate(TZ, now);
  const first = addDays(today, -2);
  const site = await home('to-today', first, now - (now % 1800));
  assert.equal((await builtDays(site.id)).at(-1), today);
  await setSlotLength(site.id, 900);
  const done = (await processQueue()).find((x) => x.siteId === site.id);
  assert.deepEqual([done.from, done.to], [first, today]);
});

await test('the sync\'s own requests still build up to today', async () => {
  const site = await home('sync-style', '2025-06-10', dayBounds(TZ, '2025-06-11')[1]);
  await db.prepare('INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES (?, ?, ?, ?, ?)').run(site.id, dayBounds(TZ, '2025-06-11')[0], nowSec(), 'facts changed', nowSec());
  const done = (await processQueue()).find((x) => x.siteId === site.id);
  assert.equal(done.to, localDate(TZ, nowSec()));
});
