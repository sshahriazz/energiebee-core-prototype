// Changing a home's slot length rebuilds the days it has, not every day up to today: from its first
// real data day to its last built (or data) day. A home with three days of data rebuilds exactly
// those three days; a home whose data reaches today still rebuilds through today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { createSite, setSlotLength } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { buildSite, processQueue, factSpan } = await import('../src/core/build.js');
const { seriesId, putIntervals } = await import('../src/core/facts.js');
const { dayBounds, localDate, nowSec, addDays } = await import('../src/core/time.js');

const TZ = 'Europe/London';
function home(name, from, toTs) {
  const site = createSite({ name });
  const dev = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: name });
  const t = createTariff({ provider: 'test', tariffCode: `TEST-${name}`, country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', origin: 'synthetic' });
  const [a] = dayBounds(TZ, from);
  putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 24 }]);
  agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: a });
  const rows = [];
  for (let s = a; s + 1800 <= toTs; s += 1800) rows.push({ start: s, end: s + 1800, value: 0.3 });
  putIntervals(seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), rows);
  buildSite(site.id, from, localDate(TZ, toTs - 1));
  return site;
}
const builtDays = (id) => db.prepare('SELECT local_date FROM site_day WHERE site_id = ? ORDER BY local_date').all(id).map((r) => r.local_date);

test('a home with three days of data rebuilds exactly those three days in the new length', () => {
  const site = home('three-days', '2025-06-10', dayBounds(TZ, '2025-06-12')[1]);
  assert.deepEqual(builtDays(site.id), ['2025-06-10', '2025-06-11', '2025-06-12']);
  assert.equal(localDate(TZ, factSpan(site.id).last), '2025-06-12');
  for (const slotS of [900, 3600]) {
    const r = setSlotLength(site.id, slotS);
    assert.equal(r.queued, true);
    const done = processQueue().find((x) => x.siteId === site.id);
    assert.deepEqual([done.from, done.to, done.days], ['2025-06-10', '2025-06-12', 3]);
    assert.deepEqual(builtDays(site.id), ['2025-06-10', '2025-06-11', '2025-06-12'], 'no empty days up to today');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM site_hh WHERE site_id = ?').get(site.id).n, (3 * 86400) / slotS);
    assert.ok(db.prepare('SELECT dur_s FROM site_hh WHERE site_id = ?').all(site.id).every((x) => x.dur_s === slotS));
  }
});

test('a home whose data reaches today rebuilds through today', () => {
  const now = nowSec();
  const today = localDate(TZ, now);
  const first = addDays(today, -2);
  const site = home('to-today', first, now - (now % 1800));
  assert.equal(builtDays(site.id).at(-1), today);
  setSlotLength(site.id, 900);
  const done = processQueue().find((x) => x.siteId === site.id);
  assert.deepEqual([done.from, done.to], [first, today]);
});

test('the sync\'s own requests still build up to today', () => {
  const site = home('sync-style', '2025-06-10', dayBounds(TZ, '2025-06-11')[1]);
  db.prepare('INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES (?, ?, ?, ?, ?)').run(site.id, dayBounds(TZ, '2025-06-11')[0], nowSec(), 'facts changed', nowSec());
  const done = processQueue().find((x) => x.siteId === site.id);
  assert.equal(done.to, localDate(TZ, nowSec()));
});
