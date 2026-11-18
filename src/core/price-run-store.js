// Price runs in the database (tariff_price_run, Phase T.1): made from a tariff's current rate rows by the pure code of
// price-runs.js, replaced as a whole when a tariff's rows change, and read back for a home's slots.
//   materialiseRuns      one tariff's runs, from its rate rows in force now (idempotent: unchanged runs are left alone)
//   materialiseHomeRuns  the runs of every tariff a home has an agreement on (only tariffs in use are stored)
//   readRuns             a tariff's runs overlapping a span, for a home (shared runs and the home's own)
//   pricingWithStoredRuns  a pricing.js context with the stored runs in place of runs made in memory
// The table describes now. A build "as known at" a past moment does not read it: it makes its runs in memory from the rate rows
// as they stood then (price-runs.js withRunsFromRates), with the same code.
import { db, tx } from '../db/db.js';
import { knownAtMs } from './facts.js';
import { nowSec } from './time.js';
import { runsFromRates, lineageOf, indexRuns } from './price-runs.js';

const COLS = ['tariff_id', 'site_id', 'component', 'register', 'charge_period', 'payment_method', 'valid_from', 'valid_to', 'price_ex_vat', 'estimated', 'origin'];
const CHUNK = 400;   // rows per INSERT: well under the 65535 parameters Postgres takes (14 columns each)

// What a run says, without when it was built: what idempotence compares.
const sig = (r) => JSON.stringify([...COLS.map((c) => r[c] ?? null), r.rate_ids.length]);

// Replace the stored runs of one tariff by the runs of its current rate rows. Returns { runs, unchanged }.
export async function materialiseRuns(tariffId, { builtAt = nowSec() } = {}) {
  if (knownAtMs() != null) throw new Error('price runs in the database describe now: an "as known at" read makes its runs in memory (price-runs.js withRunsFromRates)');
  return await tx(async () => {
    if (!await db.prepare('SELECT 1 AS x FROM tariff WHERE id = ?').get(tariffId)) throw new Error(`no tariff ${tariffId}`);
    const rows = await db.prepare('SELECT * FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NULL ORDER BY valid_from, id').all(tariffId);
    const runs = runsFromRates(rows);
    const stored = (await db.prepare('SELECT * FROM tariff_price_run WHERE tariff_id = ?').all(tariffId)).map(fromRow);
    const key = (r) => `${r.component}\u0000${r.register}\u0000${r.charge_period ?? ''}\u0000${r.payment_method}\u0000${r.site_id ?? ''}\u0000${r.valid_from}`;
    const want = new Map(runs.map((r) => [key(r), sig(r)]));
    const have = new Map(stored.map((r) => [key(r), sig(r)]));
    // The signature holds the number of rate rows a run was made of (the lineage's n), so a changed row count is a change.
    const same = want.size === have.size && [...want].every(([k, v]) => have.get(k) === v);
    if (same) return { runs: runs.length, unchanged: true };
    await db.prepare('DELETE FROM tariff_price_run WHERE tariff_id = ?').run(tariffId);
    for (let i = 0; i < runs.length; i += CHUNK) {
      const part = runs.slice(i, i + CHUNK);
      const cells = '(' + COLS.map(() => '?').join(', ') + ', ?::jsonb, ?)';
      await db.prepare(`INSERT INTO tariff_price_run (${COLS.join(', ')}, lineage, built_at) VALUES ${part.map(() => cells).join(', ')}`)
        .run(...part.flatMap((r) => [...COLS.map((c) => r[c] ?? null), JSON.stringify(lineageOf(r)), builtAt]));
    }
    return { runs: runs.length, unchanged: false };
  });
}

// The runs of every tariff the home has (or had) an agreement on, current agreements only.
export async function materialiseHomeRuns(siteId, opts) {
  const ids = (await db.prepare('SELECT DISTINCT tariff_id FROM tariff_agreement WHERE site_id = ? AND superseded_at IS NULL ORDER BY tariff_id').all(siteId)).map((r) => r.tariff_id);
  const out = {};
  for (const id of ids) out[id] = await materialiseRuns(id, opts);
  return out;
}

// A stored row as a run (the shape of runsFromRates): the lineage's row ids come back as rate_ids, so ties in start order
// are broken by the first row as they were when the runs were made. A run made of more rows than the lineage keeps carries
// as many null ids as are missing: only the count and the first ids matter after that.
function fromRow(r) {
  const lin = typeof r.lineage === 'string' ? JSON.parse(r.lineage) : r.lineage;
  const ids = [...lin.rate_ids];
  while (ids.length < lin.n) ids.push(null);
  return { id: r.id, tariff_id: r.tariff_id, site_id: r.site_id, component: r.component, register: r.register, charge_period: r.charge_period, payment_method: r.payment_method,
    valid_from: r.valid_from, valid_to: r.valid_to, price_ex_vat: r.price_ex_vat, estimated: r.estimated, origin: r.origin, rate_ids: ids, built_at: r.built_at };
}

// Stored runs of some tariffs overlapping [from, to), for one home: the shared runs and the home's own (those of other homes are
// never read). Same window as loadPricing's rate rows, so a slot sees the same neighbours.
export async function readRuns(tariffIds, siteId, from, to) {
  if (!tariffIds.length) return [];
  return (await db.prepare(`SELECT * FROM tariff_price_run WHERE tariff_id IN (${tariffIds.map(() => '?').join(',')}) AND (site_id IS NULL OR site_id = ?)
    AND valid_from < ? AND COALESCE(valid_to, 9000000000) > ? ORDER BY valid_from, id`).all(...tariffIds, siteId, to, from)).map(fromRow);
}

// A pricing.js loadPricing context with `runs` read from the table for the span the context was loaded for.
export async function pricingWithStoredRuns(p, siteId, from, to) {
  const tariffIds = [...new Set(p.agreements.map((a) => a.tariff_id))];
  return { ...p, runs: indexRuns(await readRuns(tariffIds, siteId, from - 86400 * 2, to)) };
}
