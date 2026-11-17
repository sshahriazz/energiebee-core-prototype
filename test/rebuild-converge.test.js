// Rebuilds stop when they converge (fix list R9). A change is rebuilt from the day it touched; the rebuild goes on past the
// last changed day only while days still come out differently from what is stored (the battery's stored energy and the
// balance check's 30-day history carry over). The rows are always the rows a full rebuild gives. Requests stay separate
// ranges, and a home with days built by an older method is queued by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
if (hasLive) await useDb({ snapshot: true });
const { db } = await import('../src/db/db.js');
const { seriesId, putReadings, markDirty } = await import('../src/core/facts.js');
const { buildSite, processQueue, queueStaleMethods, METHOD_VERSION } = await import('../src/core/build.js');
const { dayBounds, localDate, nowSec } = await import('../src/core/time.js');

const SITE = 1;
const site = async () => await db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const days = async () => (await db.prepare('SELECT local_date FROM site_day WHERE site_id = ? ORDER BY local_date').all(SITE)).map((r) => r.local_date);
const today = async () => localDate((await site()).timezone, nowSec());
const fullBuild = async () => await buildSite(SITE, (await days())[0], await today());
const hash = async () => {
  const h = createHash('sha256');
  for (const t of ['site_hh', 'site_day']) for (const r of await db.prepare(`SELECT * FROM ${t} WHERE site_id = ? ORDER BY 2`).all(SITE)) { delete r.built_at; h.update(JSON.stringify(r)); }
  for (const r of await db.prepare("SELECT local_date, check_code, status, measured, detail FROM check_result WHERE site_id = ? AND check_code NOT IN ('battery_stock', 'battery_efficiency') ORDER BY 1, 2").all(SITE)) h.update(JSON.stringify(r));
  return h.digest('hex');
};
const at = async (date, hour) => dayBounds((await site()).timezone, date)[0] + hour * 3600;

await test('a change that moves nothing later stops the next day; the rows are a full rebuild\'s', { skip }, async () => {
  await fullBuild();
  // A corrected outdoor temperature at 14:00 on 14 October: it changes that day's slots and nothing that carries over.
  const temp = await seriesId('site', SITE, 'outdoor_temp_c', 'open_meteo');
  const ts = await at('2026-10-14', 14);
  assert.ok(await putReadings(temp, [{ ts, value: 31.5 }]) >= 1);
  await markDirty(SITE, ts, ts + 1, 'test: a temperature corrected');
  const [r] = await processQueue({ siteId: SITE });
  assert.deepEqual(r.ranges.map((x) => [x.from, x.to, x.converged]), [['2026-10-14', '2026-10-14', '2026-10-15']]);
  assert.equal(r.days, 2, 'two days built instead of every day to today');
  assert.equal((await db.prepare('SELECT outdoor_temp FROM site_hh WHERE site_id = ? AND slot_start = ?').get(SITE, ts)).outdoor_temp, 31.5);
  const partial = await hash();
  await fullBuild();
  assert.equal(await hash(), partial, 'the stopped rebuild left exactly what a full rebuild gives');
});

await test('a change that moves the battery carries on until the stored days agree again, and still equals a full rebuild', { skip }, async () => {
  const chg = await seriesId('site', SITE, 'battery_charge_w', 'sunsynk_5min');
  const ts = await at('2026-10-20', 3);
  const cur = await db.prepare('SELECT value FROM reading WHERE series_id = ? AND ts <= ? AND superseded_at IS NULL ORDER BY ts DESC LIMIT 1').get(chg, ts);
  assert.ok(await putReadings(chg, [{ ts, value: (cur?.value ?? 0) + 2500 }]) >= 1);
  await markDirty(SITE, ts, ts + 1, 'test: a charge sample corrected');
  const [r] = await processQueue({ siteId: SITE });
  assert.equal(r.ranges[0].from, '2026-10-20');
  assert.ok(r.days >= 2, `the change carried over: ${JSON.stringify(r.ranges)}`);
  const partial = await hash();
  await fullBuild();
  assert.equal(await hash(), partial);
});

await test('separate requests stay separate ranges: the days between them are not rebuilt', { skip }, async () => {
  const temp = await seriesId('site', SITE, 'outdoor_temp_c', 'open_meteo');
  const a = await at('2026-10-13', 12); const b = await at('2026-10-24', 12);
  await putReadings(temp, [{ ts: a, value: 29 }, { ts: b, value: 28 }]);
  await markDirty(SITE, a, a + 1, 'test: one'); await markDirty(SITE, b, b + 1, 'test: two');
  const [r] = await processQueue({ siteId: SITE });
  assert.deepEqual(r.ranges.map((x) => [x.from, x.converged]), [['2026-10-13', '2026-10-14'], ['2026-10-24', '2026-10-25']]);
  assert.equal(r.days, 4);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rebuild_queue WHERE site_id = ?').get(SITE)).n, 0, 'the requests are done');
});

await test('days built by an older method queue their home from the first such day', { skip }, async () => {
  assert.deepEqual(await queueStaleMethods(), []);
  await db.prepare("UPDATE site_day SET method_version = 'v0-old' WHERE site_id = ? AND local_date >= '2026-10-22'").run(SITE);
  assert.deepEqual(await queueStaleMethods(), [SITE]);
  const q = await db.prepare('SELECT from_ts, reason FROM rebuild_queue WHERE site_id = ?').get(SITE);
  assert.equal(q.from_ts, await at('2026-10-22', 0));
  assert.match(q.reason, new RegExp(`method changed \\(build v0-old → build ${METHOD_VERSION}`));
  await processQueue({ siteId: SITE });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM site_day WHERE site_id = ? AND method_version <> ?").get(SITE, METHOD_VERSION)).n, 0);
});
