// Price changes and the homes they reach (Phase T.5). The write functions mark what changed (src/db/price-dirty.js); this file works
// the marks off, each shared change once:
//   tariff  a rate row, window or calendar changed: the tariff's runs are made again (materialiseRuns, once however many rows
//           changed), and only if the runs came out different the homes on the tariff are queued for a rebuild from the change, in
//           batches. The part of the change that lies ahead (a new Agile day, published tomorrow's prices) does not rebuild anything: it
//           extends the timeline, the homes' price slots for the known future (up to the horizon) are made.
//   country a tax rule changed: the homes in the country are queued from the rule's date, in batches.
//   home    an agreement or a meter's windows changed: that home is queued.
// A home queued here is rebuilt by build.js processQueue like any other request (its ranges are merged, a rebuild stops where it converges).
import { db, tx } from '../db/db.js';
import { nowSec, slotLength, slotsOfDay, localDate, daysBetween } from './time.js';
import { materialiseRuns } from './price-run-store.js';
import { loadPricing } from './pricing.js';
import { supplyPricer } from './supply-price.js';

export const HORIZON_S = 14 * 86400;   // how far ahead known prices are kept as slots
const BATCH = 100;                     // homes queued per statement-group

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

// Queue homes for a rebuild of [from, now): one request per home, a batch of homes in one statement.
async function queueHomes(siteIds, from, now, reason, batch) {
  if (!(now > from)) return 0;
  for (const part of chunks(siteIds, batch)) {
    await db.prepare(`INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
      .run(...part.flatMap((id) => [id, from, now, reason, now]));
  }
  return siteIds.length;
}

// The known future of a tariff for a home: its price slots from now to the horizon or to the last price the tariff knows, whichever
// comes first, made and stored (a slot with no published price is a row with no price, never a guess).
async function extendTimeline(siteId, tariffId, from, now) {
  const site = await db.prepare('SELECT timezone, slot_s FROM site WHERE id = ?').get(siteId);
  if (!site) return 0;
  const slotS = slotLength(site);
  const known = await db.prepare(`SELECT MAX(COALESCE(valid_to, ?)) AS to_ts FROM tariff_price_run WHERE tariff_id = ? AND component = 'unit'`).get(now + HORIZON_S, tariffId);
  const end = Math.min(now + HORIZON_S, known?.to_ts ?? 0);
  const start = Math.max(from, now);
  if (!(end > start)) return 0;
  const slots = daysBetween(localDate(site.timezone, start), localDate(site.timezone, end - 1)).flatMap((d) => slotsOfDay(site.timezone, d, slotS)).filter((t) => t + slotS > start && t < end);
  const first = slots[0] ?? start;
  const p = await loadPricing(siteId, first, end);
  const pricer = await supplyPricer({ siteId, p, slotS, tz: site.timezone, materialise: true });
  await pricer.load(slots);
  return pricer.stats.made;
}

// Work off the queue. maxMarks: at most that many marks (all by default); batch: homes per group. Returns what was done.
export async function processPriceQueue({ maxMarks = Infinity, batch = BATCH, now = nowSec() } = {}) {
  const out = { tariffs: [], countries: [], homes: [], queued: 0, extended: 0 };
  const claim = async (scope, work) => {
    for (let n = 0; n < maxMarks; n++) {
      // One mark at a time, locked while it is worked on: a change that lands meanwhile makes a new mark, and a failure leaves it.
      const done = await tx(async () => {
        const m = await db.prepare(`SELECT * FROM price_dirty WHERE scope = ? ORDER BY marked_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`).get(scope);
        if (!m) return false;
        await work(m);
        await db.prepare('DELETE FROM price_dirty WHERE id = ?').run(m.id);
        return true;
      });
      if (!done) break;
    }
  };
  await claim('tariff', async (m) => {
    const t = await db.prepare('SELECT tariff_code FROM tariff WHERE id = ?').get(m.tariff_id);
    const runs = await materialiseRuns(m.tariff_id);
    const homes = runs.unchanged ? [] : (await db.prepare(`SELECT DISTINCT site_id FROM tariff_agreement WHERE tariff_id = ? AND superseded_at IS NULL AND COALESCE(valid_to, 9000000000) > ? ORDER BY site_id`)
      .all(m.tariff_id, m.from_ts)).map((r) => r.site_id);
    const ids = homes.length ? await db.prepare(`SELECT id FROM site WHERE id IN (${homes.map(() => '?').join(',')}) ORDER BY id`).all(...homes) : [];
    const queued = await queueHomes(ids.map((r) => r.id), m.from_ts, now, `price change: tariff ${t?.tariff_code ?? m.tariff_id}${m.reason ? ` (${m.reason})` : ''}`, batch);
    let extended = 0;
    if (!runs.unchanged) for (const r of ids) extended += await extendTimeline(r.id, m.tariff_id, m.from_ts, now);
    out.tariffs.push({ tariffId: m.tariff_id, runs: runs.runs, unchanged: runs.unchanged, homes: ids.length, queued, extended });
    out.queued += queued; out.extended += extended;
  });
  await claim('country', async (m) => {
    const ids = (await db.prepare('SELECT id FROM site WHERE country = ? ORDER BY id').all(m.country)).map((r) => r.id);
    const queued = await queueHomes(ids, m.from_ts, now, `tax rules changed for ${m.country}${m.reason ? ` (${m.reason})` : ''}`, batch);
    out.countries.push({ country: m.country, homes: ids.length, queued });
    out.queued += queued;
  });
  await claim('home', async (m) => {
    const queued = await queueHomes([m.site_id], m.from_ts, now, m.reason ?? 'tariff agreement changed', batch);
    out.homes.push({ siteId: m.site_id, queued });
    out.queued += queued;
  });
  return out;
}
