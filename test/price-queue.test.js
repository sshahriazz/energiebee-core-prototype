// Phase T.5: a changed rate row, window, tax rule or agreement marks what it reaches (price_dirty, written by the write functions, not by
// triggers); processPriceQueue works each shared change off once: a tariff's runs are made again once however many rows changed, and the
// homes on it are queued for a rebuild in batches; prices that lie ahead extend the timeline (the homes' price slots) and rebuild nothing;
// a tax change queues the homes of its country; an agreement change queues its home. Marks survive a failure and are claimed by one worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db, syncGbVat } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, putWindows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { supersedeAgreements } = await import('../src/core/devices.js');
const { markTariffDirty, markCountryDirty, markHomeDirty } = await import('../src/core/price-marks.js');
const { processPriceQueue, HORIZON_S } = await import('../src/core/price-queue.js');
const { processQueue } = await import('../src/core/build.js');
const { withKnownAt } = await import('../src/core/facts.js');
const { dayBounds, nowSec, localDate, addDays } = await import('../src/core/time.js');
const { VAT_RATES } = await import('../src/db/registry.js');

const TZ = 'Europe/London';
const [A] = dayBounds(TZ, '2026-10-20');
let n = 0;
const tariff = async (extra = {}) => await createTariff({ provider: 'test', tariffCode: `PQ-${++n}`, structure: 'flat', kind: 'flat', country: 'GB', currency: 'GBP', origin: 'user', ...extra });
async function homeOn(t, name, { country = 'GB', from = A - 86400 } = {}) {
  const site = await createSite({ name, ...(country === 'GB' ? {} : { country, postcode: '75005' }) });
  const meter = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: `M-${name}` });
  await agreeTariff({ siteId: site.id, deviceId: meter.id, tariffId: t.id, validFrom: from });
  return { site, meter };
}
const dirty = async () => await db.prepare('SELECT scope, tariff_id, country, site_id, from_ts, reason FROM price_dirty ORDER BY id').all();
const clear = async () => { await db.prepare('DELETE FROM price_dirty').run(); await db.prepare('DELETE FROM rebuild_queue').run(); };
const queued = async () => (await db.prepare('SELECT site_id, from_ts, to_ts, reason FROM rebuild_queue ORDER BY site_id, id').all());

await test('the write functions mark what they change; a mark keeps the earliest time; marks are one per tariff, country or home', async () => {
  const t = await tariff();
  await putRateRows(t.id, [{ component: 'unit', validFrom: A + 7200, price: 20 }, { component: 'standing', validFrom: A + 3600, price: 40 }]);
  assert.deepEqual((await dirty()).map((d) => [d.scope, d.tariff_id, d.from_ts]), [['tariff', t.id, A + 3600]], 'the earliest start of the rows written');
  await putRateRows(t.id, [{ component: 'unit', register: 'night', validFrom: A + 100, validTo: A + 200, price: 5 }]);
  assert.deepEqual((await dirty()).map((d) => d.from_ts), [A + 100], 'an earlier change lowers the mark');
  await putRateRows(t.id, [{ component: 'unit', register: 'day', validFrom: A + 999999, price: 5 }]);
  assert.equal((await dirty()).length, 1);
  assert.equal((await dirty())[0].from_ts, A + 100, 'a later one leaves it');
  const { site, meter } = await homeOn(t, 'marks');
  assert.deepEqual((await dirty()).filter((d) => d.scope === 'home').map((d) => [d.site_id, d.from_ts]), [[site.id, A - 86400]], 'an agreement marks its home');
  await supersedeAgreements(site.id, meter.id, [{ tariffId: t.id, from: A - 5 * 86400 }]);
  assert.equal((await dirty()).find((d) => d.scope === 'home').from_ts, A - 5 * 86400, 'a replaced agreement marks from the earliest of old and new');
  await putWindows(t.id, [{ register: 'night', startMin: 0, endMin: 420 }], { origin: 'user' });
  assert.equal((await dirty()).filter((d) => d.scope === 'tariff').length, 1, 'tariff windows mark the tariff');
  await putWindows(t.id, [{ register: 'night', deviceId: meter.id, startMin: 30, endMin: 450 }], { origin: 'user' });
  assert.equal((await dirty()).find((d) => d.scope === 'home').from_ts, 0, 'a meter\'s own windows mark its home from the start');
  await markCountryDirty('GB', 50, 'x'); await markCountryDirty('GB', 40, 'y'); await markHomeDirty(site.id, 3, 'z');
  assert.deepEqual((await dirty()).filter((d) => d.scope === 'country').map((d) => [d.country, d.from_ts]), [['GB', 40]]);
  assert.equal((await dirty()).find((d) => d.scope === 'home').from_ts, 0);
  await assert.rejects(async () => await markTariffDirty(t.id, NaN), /needs the time/);
  await clear();
});

await test('a tax rule changed by the registry marks the homes\' country, and only where the country has a home', async () => {
  await clear();
  const changed = VAT_RATES.map((v) => ({ ...v, rate: v.rate + 0.01 }));
  assert.equal(await syncGbVat(changed), true);
  assert.deepEqual((await dirty()).filter((d) => d.scope === 'country').length, 1, 'a GB home exists in this database');
  const first = (await dirty())[0];
  assert.equal(first.country, 'GB');
  assert.equal(first.from_ts, Math.min(...VAT_RATES.map((v) => v.validFrom)), 'from the first rule that differs');
  await syncGbVat();
  await clear();
});

await test('a changed tariff is worked off once: its runs are made again, the homes on it are queued from the change in batches, and a mark that changed nothing queues nobody', async () => {
  await clear();
  const t = await tariff();
  const other = await tariff();
  const homes = [await homeOn(t, 'q1'), await homeOn(t, 'q2'), await homeOn(t, 'q3')];
  const away = await homeOn(other, 'q4');
  await putRateRows(t.id, [{ component: 'unit', validFrom: A - 86400, price: 20 }, { component: 'standing', validFrom: A - 86400, price: 50 }]);
  await putRateRows(other.id, [{ component: 'unit', validFrom: A - 86400, price: 21 }]);
  await db.prepare("DELETE FROM price_dirty WHERE scope = 'home'").run();
  const now = nowSec();
  const r = await processPriceQueue({ batch: 2, now });
  assert.deepEqual(r.tariffs.map((x) => [x.tariffId, x.runs, x.unchanged, x.homes, x.queued]).sort(), [[t.id, 2, false, 3, 3], [other.id, 1, false, 1, 1]].sort());
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM price_dirty').get()).n, 0, 'the marks are gone');
  assert.deepEqual((await queued()).map((q) => [q.site_id, q.from_ts, q.to_ts]).sort((a, b) => a[0] - b[0]),
    [...homes.map((h) => [h.site.id, A - 86400, now]), [away.site.id, A - 86400, now]].sort((a, b) => a[0] - b[0]));
  assert.match((await queued())[0].reason, /price change: tariff PQ-/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tariff_price_run WHERE tariff_id = ?').get(t.id)).n, 2);
  // Marked again with nothing changed: the runs come out the same, so no home is queued.
  await db.prepare('DELETE FROM rebuild_queue').run();
  await markTariffDirty(t.id, A - 86400, 'nothing really changed');
  const again = await processPriceQueue({ now });
  assert.deepEqual(again.tariffs.map((x) => [x.unchanged, x.queued]), [[true, 0]]);
  assert.equal((await queued()).length, 0);
  // A price changes: one mark for any number of rows, one queue entry per home, and the home's rebuild shows the new price.
  const cur = await db.prepare("SELECT id FROM rate_interval WHERE tariff_id = ? AND component = 'unit' AND superseded_at IS NULL").get(t.id);
  await db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?').run(Date.now(), cur.id);
  await putRateRows(t.id, [{ component: 'unit', validFrom: A - 86400, validTo: A, price: 22 }, { component: 'unit', validFrom: A, price: 23 }]);
  assert.equal((await dirty()).length, 1);
  const third = await processPriceQueue({ now });
  assert.equal(third.queued, 3);
  const h = homes[0].site;
  await processQueue({ siteId: h.id });
  const day = await db.prepare('SELECT import_rate_ex FROM site_hh WHERE site_id = ? AND slot_start = ?').get(h.id, A + 3600);
  assert.equal(day?.import_rate_ex, 23, 'the queued rebuild priced the slot with the new row');
});

await test('prices that lie ahead extend the timeline: no home is rebuilt, the homes\' price slots for the known future are made, and a later extension adds to them', async () => {
  await clear();
  const t = await tariff({ kind: 'dynamic' });
  const h1 = await homeOn(t, 'f1', { from: A }); const h2 = await homeOn(t, 'f2', { from: A });
  const now = nowSec();
  const tomorrow = dayBounds(TZ, addDays(localDate(TZ, now), 1))[0];
  const rows = (from, k) => Array.from({ length: k }, (_, i) => ({ component: 'unit', validFrom: from + i * 1800, validTo: from + (i + 1) * 1800, price: 10 + (i % 7) }));
  await putRateRows(t.id, rows(tomorrow, 48));
  await db.prepare("DELETE FROM price_dirty WHERE scope = 'home'").run();
  const r = await processPriceQueue({ now });
  assert.equal(r.queued, 0, 'nothing built is affected');
  assert.equal((await queued()).length, 0);
  assert.equal(r.extended, 96, '48 slots for each of the two homes');
  const slots = await db.prepare("SELECT slot_start, unit_ex, register FROM supply_price_slot WHERE site_id = ? AND point = 'meter_import' ORDER BY slot_start").all(h1.site.id);
  assert.equal(slots.length, 48);
  assert.ok(slots.every((s) => s.unit_ex != null && s.slot_start >= tomorrow && s.slot_start < tomorrow + 86400));
  assert.deepEqual(slots.slice(0, 3).map((s) => s.unit_ex), [10, 11, 12]);
  // The next day's prices are published: the timeline grows, the day before is not made again.
  const built = (await db.prepare("SELECT MIN(built_at) AS b FROM supply_price_slot WHERE site_id = ?").get(h1.site.id)).b;
  await putRateRows(t.id, rows(tomorrow + 86400, 48));
  const r2 = await processPriceQueue({ now: now + 5 });
  assert.equal(r2.queued, 0);
  assert.equal(r2.extended, 96, 'only the new day\'s slots were made');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM supply_price_slot WHERE site_id = ? AND point = 'meter_import'").get(h2.site.id)).n, 96);
  assert.equal((await db.prepare("SELECT MIN(built_at) AS b FROM supply_price_slot WHERE site_id = ?").get(h1.site.id)).b, built, 'the first day\'s rows were not rewritten');
  assert.ok(HORIZON_S >= 14 * 86400);
});

await test('a tax change queues the homes of its country and no others; an agreement change queues its home', async () => {
  await clear();
  const t = await tariff();
  const gb = await homeOn(t, 'c1');
  const fr = await createSite({ name: 'c2', country: 'FR', postcode: '75005' });
  await clear();
  await markCountryDirty('GB', A, 'test');
  const r = await processPriceQueue({ now: A + 7 * 86400 });
  assert.deepEqual(r.countries.map((c) => [c.country, c.homes, c.queued]), [['GB', (await db.prepare("SELECT COUNT(*) AS n FROM site WHERE country = 'GB'").get()).n, (await db.prepare("SELECT COUNT(*) AS n FROM site WHERE country = 'GB'").get()).n]]);
  const q = await queued();
  assert.ok(q.some((x) => x.site_id === gb.site.id) && !q.some((x) => x.site_id === fr.id));
  assert.ok(q.every((x) => x.from_ts === A && x.to_ts === A + 7 * 86400 && /tax rules changed for GB/.test(x.reason)));
  await clear();
  await markHomeDirty(gb.site.id, A, 'agreement test');
  const h = await processPriceQueue({ now: A + 86400 });
  assert.deepEqual(h.homes, [{ siteId: gb.site.id, queued: 1 }]);
  assert.deepEqual((await queued()).map((x) => [x.site_id, x.reason]), [[gb.site.id, 'agreement test']]);
});

await test('each mark is worked once by one worker, and a mark that failed is still there', async () => {
  await clear();
  const ts = [await tariff(), await tariff(), await tariff()];
  for (const t of ts) { await putRateRows(t.id, [{ component: 'unit', validFrom: A, price: 20 }]); await homeOn(t, `p${t.id}`); }
  await db.prepare("DELETE FROM price_dirty WHERE scope = 'home'").run();
  const [a, b] = await Promise.all([processPriceQueue({ now: nowSec() }), processPriceQueue({ now: nowSec() })]);
  assert.deepEqual([...a.tariffs, ...b.tariffs].map((x) => x.tariffId).sort(), ts.map((t) => t.id).sort(), 'every tariff exactly once, whichever worker took it');
  await clear();
  await markTariffDirty(ts[0].id, A, 'will fail');
  await assert.rejects(async () => await withKnownAt(Date.now(), async () => await processPriceQueue()), /describe now/);
  assert.equal((await dirty()).length, 1, 'the mark stays when the work fails');
  assert.equal((await processPriceQueue({ now: nowSec() })).tariffs.length, 1);
  assert.equal((await dirty()).length, 0);
});
