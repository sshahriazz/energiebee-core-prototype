// Phase T exit criteria (docs/thing-platform-plan.md, Phase T):
//   - every tariff in use produces slots with no gaps inside its validity, for the real GB home and the synthetic homes (the seven
//     topologies; the GB, FR and NL homes of multi-market), at 15, 30 and 60 minutes and across the clock changes;
//   - the real GB home has a price timeline at least seven days ahead where prices are known, as slots the planner reads;
//   - a comparison gives the same totals as before (test/compare-slots.test.js) and the home's numbers did not move (golden-gb,
//     site-version-gb, topologies, multi-market, price-runs*).
// "Validity" of a tariff is where it has price runs: a tariff with no rate rows at all (the fixture holds several, held only by old
// agreements) has no validity to be gapless in, and is counted as such; a hole between two blocks of runs is not inside a block.
// Inside a block every slot that lies wholly in it, within an agreement of the home, must have a price.
// The blocks are made of the runs themselves, so a hole in the runs (a missing expansion) could never show there. The last test of
// this file therefore also checks the runs against the agreements alone, with no block in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
await useDb({ snapshot: hasLive });
const { db } = await import('../src/db/db.js');
const T = await import('../scripts/lib/topologies.js');
const M = await import('../scripts/lib/multi-market.js');
const { loadPricing } = await import('../src/core/pricing.js');
const { supplyPricer } = await import('../src/core/supply-price.js');
const { ensureRuns } = await import('../src/core/price-run-store.js');
const { homePriceTimeline } = await import('../src/core/tariff-slots.js');
const { processPriceQueue } = await import('../src/core/price-queue.js');
const { nowSec, slotLength, slotsOfDay, localDate, daysBetween } = await import('../src/core/time.js');

for (const name of Object.keys(T.TOPOLOGIES)) await T.buildTopology(name);
await M.buildScenario();

const DAY = 86400;
const LOOKBACK = 60 * DAY;   // a block is checked over its last 60 days: the days of data a home has
const AHEAD = 8 * DAY;       // and as far ahead as the timeline test asks

// The contiguous blocks of a tariff's unit runs (a home's own rows count for that home): [from, to) with to = null for open-ended.
async function blocks(tariffId, siteId) {
  await ensureRuns([tariffId]);   // the fixture was dumped before the table existed: its runs are made on first read
  const runs = await db.prepare(`SELECT valid_from, valid_to FROM tariff_price_run WHERE tariff_id = ? AND component = 'unit' AND (site_id IS NULL OR site_id = ?) ORDER BY valid_from`).all(tariffId, siteId);
  const out = [];
  for (const r of runs) {
    const last = out.at(-1);
    if (last && last.to != null && r.valid_from <= last.to) last.to = r.valid_to == null ? null : Math.max(last.to, r.valid_to);
    else if (!last || last.to != null) out.push({ from: r.valid_from, to: r.valid_to });
  }
  return out;
}

const seen = { homes: 0, agreements: 0, noRates: 0, blocks: 0, slots: 0, priced: 0 };

// The slots with no price inside the blocks of every agreement of a home: [{ tariff, point, slotS, gaps, of }] for each check that found some.
async function findGaps(site) {
  const tz = site.timezone || 'Europe/London';
  const last = (await db.prepare('SELECT MAX(slot_start) AS t FROM site_hh WHERE site_id = ?').get(site.id)).t;
  const end = Math.max(last ?? 0, nowSec()) + AHEAD;
  const agreements = await db.prepare('SELECT a.*, d.kind, t.tariff_code FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id WHERE a.site_id = ? AND a.superseded_at IS NULL ORDER BY a.id').all(site.id);
  const found = [];
  seen.homes++;
  for (const a of agreements) {
    seen.agreements++;
    const bs = await blocks(a.tariff_id, site.id);
    if (!bs.length) { seen.noRates++; continue; }
    for (const b of bs) {
      const hi = Math.min(a.valid_to ?? Infinity, b.to ?? Infinity, end);
      const lo = Math.max(a.valid_from, b.from, hi - LOOKBACK);
      if (!(hi > lo)) continue;
      seen.blocks++;
      for (const slotS of [900, 1800, 3600]) {
        const p = await loadPricing(site.id, lo, hi, site);
        const pricer = await supplyPricer({ siteId: site.id, p, slotS, tz, materialise: false });
        const slots = daysBetween(localDate(tz, lo), localDate(tz, hi - 1)).flatMap((d) => slotsOfDay(tz, d, slotS)).filter((s) => s >= lo && s + slotS <= hi);
        const gaps = slots.filter((s) => pricer.get(a.kind, s).price?.unitEx == null);
        seen.slots += slots.length; seen.priced += slots.length - gaps.length;
        if (gaps.length) found.push({ tariff: a.tariff_code, point: a.kind, slotS, gaps: gaps.length, of: slots.length, first: new Date(gaps[0] * 1000).toISOString() });
      }
    }
  }
  return found;
}

const homes = await db.prepare('SELECT * FROM site ORDER BY id').all();
for (const site of homes) {
  await test(`home ${site.id} (${site.name}): every agreement's tariff is priced in every slot of every block of its runs, at 15, 30 and 60 minutes`, async () => {
    assert.deepEqual(await findGaps(site), []);
  });
}

await test('the checks looked at something: homes, agreements, blocks and slots, and tariffs with no rate rows are counted, not skipped silently', (t) => {
  t.diagnostic(`checked ${JSON.stringify(seen)}`);
  assert.ok(seen.homes >= 10 && seen.agreements >= 12 && seen.blocks >= 10 && seen.priced > 5000 && seen.priced === seen.slots, JSON.stringify(seen));
  if (hasLive) assert.ok(seen.noRates > 0, 'the fixture holds agreements of tariffs that have no rate rows');
});

await test('the check finds a gap when there is one: a day/night tariff whose meter has no switch times prices nothing (never a guess)', async () => {
  const { createSite } = await import('../src/core/sites.js');
  const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
  const site = await createSite({ name: 'Gap check', country: 'GB' });
  const meter = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: 'GAP-M' });
  const e7 = await createTariff({ provider: 'test', tariffCode: 'GAP-E7', structure: 'e7', kind: 'tou', country: 'GB', currency: 'GBP', origin: 'user' });
  const from = nowSec() - 3 * DAY;
  await putRateRows(e7.id, [{ component: 'unit', register: 'day', validFrom: from, price: 30 }, { component: 'unit', register: 'night', validFrom: from, price: 10 }]);
  await agreeTariff({ siteId: site.id, deviceId: meter.id, tariffId: e7.id, validFrom: from });
  const gaps = await findGaps(await db.prepare('SELECT * FROM site WHERE id = ?').get(site.id));
  assert.ok(gaps.length === 3 && gaps.every((g) => g.gaps === g.of && g.tariff === 'GAP-E7'), JSON.stringify(gaps));
});

await test('the real GB home: a price timeline at least seven days ahead, every slot with a price, equal day to day where the tariff is flat', { skip }, async () => {
  const site = await db.prepare('SELECT * FROM site WHERE id = 1').get();
  const now = nowSec();
  const tl = await homePriceTimeline(site, { from: now, to: now + 9 * DAY });
  assert.equal(slotLength(site), tl.slot_s);
  for (const k of ['meter_import', 'meter_export']) {
    const p = tl.points.find((x) => x.point === k);
    assert.ok(p, k);
    assert.ok(p.priced_until >= now + 7 * DAY, `${k} priced until ${new Date(p.priced_until * 1000).toISOString()}`);
    assert.equal(p.unknown, 0, `${k}: no slot without a price`);
  }
  // Intelligent Octopus has two prices a day, so the days repeat: the slot a day later costs the same (this fixture has no clock change ahead).
  const imp = tl.points.find((x) => x.point === 'meter_import').slots;
  const n = 86400 / tl.slot_s;
  for (let i = 0; i + n < imp.length - n; i += 17) assert.equal(imp[i].unit_inc, imp[i + n].unit_inc);
});

await test('the real GB home: the known future is kept as slots (the table), the planner and the API read the same numbers', { skip }, async () => {
  const site = await db.prepare('SELECT * FROM site WHERE id = 1').get();
  const now = nowSec();
  const slotS = slotLength(site);
  const slots = Array.from({ length: Math.ceil((8 * DAY) / slotS) }, (_, i) => Math.floor(now / slotS) * slotS + i * slotS);
  const p = await loadPricing(1, slots[0], slots.at(-1) + slotS, site);
  const pricer = await supplyPricer({ siteId: 1, p, slotS, tz: site.timezone, materialise: true });
  await pricer.load(slots);
  const stored = await db.prepare("SELECT COUNT(*) n, MIN(slot_start) a, MAX(slot_start) b FROM supply_price_slot WHERE site_id = 1 AND point = 'meter_import' AND dur_s = ? AND slot_start >= ? AND unit_ex IS NOT NULL").get(slotS, slots[0]);
  assert.equal(stored.n, slots.length);
  assert.ok(stored.b >= now + 7 * DAY);
  const tl = await homePriceTimeline(site, { from: slots[0], to: slots.at(-1) + slotS, points: ['meter_import'] });
  assert.equal(tl.computed, 0, 'now every slot is read from the table');
  assert.equal(tl.stored, slots.length);
  await processPriceQueue();   // nothing marked: nothing to do, and no error on a home with slots stored ahead
});

// Independent of the blocks above: every second of a current agreement of the real GB home, from its start to its end (or nine days ahead),
// is covered by a unit run of every register the tariff has. The tariffs below have a hole at the start of an agreement because the frozen
// fixture holds no price rows for those first days or months (they were fetched later than the agreement began): the data is absent and
// nothing is guessed. They must still have a hole, so the list cannot go stale. Agreements on tariffs with no rate rows at all have no
// registers and are not in this count (the first test of this file counts them).
const DATA_ABSENT = new Set(['E-1R-AGILE-OUTGOING-19-05-13-G', 'E-1R-AGILE-24-10-01-G', 'E-1R-OUTGOING-VAR-24-10-26-G', 'E-1R-INTELLI-FIX-12M-26-06-13-G']);

await test('the real GB home: the runs cover every agreement second by second, apart from the days the fixture holds no prices for', { skip }, async () => {
  const now = nowSec();
  const agreements = await db.prepare('SELECT a.*, t.tariff_code FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id WHERE a.site_id = 1 AND a.superseded_at IS NULL ORDER BY a.valid_from, a.id').all();
  const holes = new Map();
  let covered = 0;
  for (const a of agreements) {
    await ensureRuns([a.tariff_id]);
    const runs = await db.prepare("SELECT register, valid_from, valid_to FROM tariff_price_run WHERE tariff_id = ? AND component = 'unit' AND (site_id IS NULL OR site_id = ?) ORDER BY register, valid_from").all(a.tariff_id, a.site_id);
    const hi = Math.min(a.valid_to ?? Infinity, now + 9 * DAY);
    const byRegister = Map.groupBy(runs, (r) => r.register);
    for (const [register, rs] of byRegister) {
      let at = a.valid_from;
      let missing = 0;
      for (const r of rs) {
        if (r.valid_from > at) missing += Math.max(0, Math.min(r.valid_from, hi) - at);
        at = Math.max(at, r.valid_to ?? Infinity);
      }
      if (at < hi) missing += hi - at;
      if (missing > 0) holes.set(`${a.tariff_code} ${register}`, (holes.get(`${a.tariff_code} ${register}`) ?? 0) + missing);
      else covered++;
    }
  }
  assert.deepEqual([...holes.keys()].filter((k) => !DATA_ABSENT.has(k.split(' ')[0])), [], 'a hole in the runs of a tariff whose prices are in the fixture');
  assert.deepEqual([...DATA_ABSENT].filter((c) => ![...holes.keys()].some((k) => k.startsWith(`${c} `))), [], 'a tariff on the list of absent data has no hole any more: take it off');
  assert.ok(covered >= 3, `registers checked and gapless: ${covered}`);   // IOG day and night, the 18-month gas fix
});
