// Price changes and the homes they reach (Phase T.5). The write functions mark what changed (src/db/price-dirty.js); this file works
// the marks off, each shared change once:
//   tariff  a rate row, window or calendar changed: the tariff's runs are made again (materialiseRuns, once however many rows
//           changed) and every home on the tariff is queued for a rebuild from the earliest time the change reaches, in batches. The
//           mark alone says what changed: the runs are not compared with the stored ones, because any current read (a build, the API)
//           makes the runs again as soon as the rate rows change, long before this runs. A change that lies wholly ahead (a new Agile
//           day) queues nothing, the rebuild range [from, now) is empty; it extends the timeline instead, the homes' price slots for
//           the known future (up to the horizon), made after the mark is worked off. A mark that changed nothing costs a rebuild that
//           stops where the days come out as stored (R9).
//   country a tax rule changed: the homes in the country are queued from the rule's date, in batches.
//   home    an agreement or a meter's windows changed: that home is queued.
// A home queued here is rebuilt by build.js processQueue like any other request (its ranges are merged, a rebuild stops where it converges).
// A mark whose work fails is counted (attempts) and tried again behind the others; after MAX_ATTEMPTS it is parked until a new change.
import { db, tx } from '../db/db.js';
import { nowSec, slotLength, slotsOfDay, localDate, daysBetween, dayBounds } from './time.js';
import { factSpan } from './build.js';
import { materialiseRuns } from './price-run-store.js';
import { loadPricing } from './pricing.js';
import { supplyPricer } from './supply-price.js';

export const HORIZON_S = 14 * 86400;   // how far ahead known prices are kept as slots
const BATCH = 100;                     // homes queued per statement-group

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

// The earliest time each home has anything built or measured: its first built day or its first energy fact. A price change reaches no
// further back (the rebuild queue itself never starts before the first data), and a home with neither has nothing to rebuild yet: its
// first build prices from the start. The built days and zones of all the homes come in two statements, the fact spans one per home.
async function homeFloors(siteIds) {
  const out = new Map();
  if (!siteIds.length) return out;
  const marks = siteIds.map(() => '?').join(',');
  const sites = await db.prepare(`SELECT s.id, s.timezone, (SELECT MIN(local_date) FROM site_day d WHERE d.site_id = s.id) AS day FROM site s WHERE s.id IN (${marks})`).all(...siteIds);
  for (const site of sites) {
    const first = (await factSpan(site.id)).first;
    const times = [site.day ? dayBounds(site.timezone, site.day)[0] : null, first].filter((t) => t != null);
    out.set(site.id, times.length ? Math.min(...times) : null);
  }
  return out;
}

// Queue homes for a rebuild of [from, now): one request per home, a batch of homes in one statement. A home's request starts no
// earlier than its first data; a home with none is not queued.
async function queueHomes(siteIds, from, now, reason, batch) {
  if (!(now > from)) return 0;
  const floors = await homeFloors(siteIds);
  const requests = siteIds.filter((id) => floors.get(id) != null && now > Math.max(from, floors.get(id))).map((id) => [id, Math.max(from, floors.get(id))]);
  for (const part of chunks(requests, batch)) {
    await db.prepare(`INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
      .run(...part.flatMap(([id, f]) => [id, f, now, reason, now]));
  }
  return requests.length;
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

export const MAX_ATTEMPTS = 3;

// Work off the queue. maxMarks: at most that many marks per scope (all by default); batch: homes per group. Returns what was done and
// what failed: a failing mark never stops the others, it is counted on its row and parked after MAX_ATTEMPTS.
export async function processPriceQueue({ maxMarks = Infinity, batch = BATCH, now = nowSec() } = {}) {
  const out = { tariffs: [], countries: [], homes: [], queued: 0, extended: 0, failed: [] };
  const claim = async (scope, work, after = async () => {}) => {
    const failedHere = [];
    for (let n = 0; n < maxMarks; n++) {
      let current = null;
      try {
        // One mark at a time, locked while it is worked on: a change that lands meanwhile makes a new mark, and a failure leaves it.
        const result = await tx(async () => {
          const m = await db.prepare(`SELECT * FROM price_dirty WHERE scope = ? AND attempts < ? AND id NOT IN (${[0, ...failedHere].map(() => '?').join(',')})
            ORDER BY attempts, marked_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`).get(scope, MAX_ATTEMPTS, ...[0, ...failedHere]);
          if (!m) return null;
          current = m;
          const r = await work(m);
          await db.prepare('DELETE FROM price_dirty WHERE id = ?').run(m.id);
          return r;
        });
        if (!result) break;
        await after(result);
      } catch (err) {
        if (!current) throw err;
        failedHere.push(current.id);
        await db.prepare('UPDATE price_dirty SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(err.message).slice(0, 500), current.id);
        out.failed.push({ scope, id: current.id, tariffId: current.tariff_id, country: current.country, siteId: current.site_id, error: err.message });
      }
    }
  };
  await claim('tariff', async (m) => {
    const t = await db.prepare('SELECT tariff_code FROM tariff WHERE id = ?').get(m.tariff_id);
    const runs = await materialiseRuns(m.tariff_id);
    const ids = (await db.prepare(`SELECT DISTINCT site_id FROM tariff_agreement WHERE tariff_id = ? AND superseded_at IS NULL AND COALESCE(valid_to, 9000000000) > ? ORDER BY site_id`)
      .all(m.tariff_id, m.from_ts)).map((r) => r.site_id);
    const queued = await queueHomes(ids, m.from_ts, now, `price change: tariff ${t?.tariff_code ?? m.tariff_id}${m.reason ? ` (${m.reason})` : ''}`, batch);
    return { tariffId: m.tariff_id, from: m.from_ts, runs: runs.runs, homes: ids, queued };
  }, async (r) => {
    // The known future is made after the mark is gone: it is a head start (a read makes any slot it finds missing), so a failure here
    // must not undo the queued rebuilds or park the mark.
    let extended = 0;
    for (const id of r.homes) {
      try { extended += await extendTimeline(id, r.tariffId, r.from, now); } catch (err) { out.failed.push({ scope: 'timeline', siteId: id, tariffId: r.tariffId, error: err.message }); }
    }
    out.tariffs.push({ tariffId: r.tariffId, runs: r.runs, homes: r.homes.length, queued: r.queued, extended });
    out.queued += r.queued; out.extended += extended;
  });
  await claim('country', async (m) => {
    const ids = (await db.prepare('SELECT id FROM site WHERE country = ? ORDER BY id').all(m.country)).map((r) => r.id);
    return { country: m.country, homes: ids.length, queued: await queueHomes(ids, m.from_ts, now, `tax rules changed for ${m.country}${m.reason ? ` (${m.reason})` : ''}`, batch) };
  }, async (r) => { out.countries.push(r); out.queued += r.queued; });
  await claim('home', async (m) => ({ siteId: m.site_id, queued: await queueHomes([m.site_id], m.from_ts, now, m.reason ?? 'tariff agreement changed', batch) }),
    async (r) => { out.homes.push(r); out.queued += r.queued; });
  return out;
}
