// The proof behind Phase T.1 to T.4 (docs/build/tariff.md): for every slot of a home or a hand-made context, at 15, 30 and 60
// minutes and for each meter kind, the price and the fixed share are the numbers the first pricing code (priceAt / priceOver /
// fixedOver, removed in step B) gave. That code was run once over the same slots and a hash of every price and share was recorded in
// test/fixtures/price-slots-ref.json; a slot that comes out differently changes its hash. The price from runs made in memory (the
// "as known at" path) and from the runs read back from the table (the current path) must be identical, whole object.
// UPDATE_PRICE_REF=1 rewrites the entries a run touches, from the code as it is now: only for a number that is meant to change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const KINDS = ['meter_import', 'meter_export', 'meter_gas'];

const REF_FILE = path.join(import.meta.dirname, 'fixtures', 'price-slots-ref.json');
const ref = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
// The fields of a price that are numbers, labels and lineage: what a slot's price is, without the time its rows were written.
const stable = (price, fixed) => (price == null ? [null, fixed] : [price.tariffCode, price.structure, price.currency, price.standingEx, price.fixed, price.vat, price.levy, price.tax?.source ?? null, price.tax?.unverified ?? null,
  price.register, price.unitEx, price.supplyEx, price.weighted ?? null, price.estimated ?? null, price.capacityUnknown ?? null, (price.inputs ?? []).map((i) => [i.what, i.origin]), fixed]);
const seenKeys = new Map();
const recorded = {};
if (process.env.UPDATE_PRICE_REF === '1') {
  process.on('exit', () => {
    const now = fs.existsSync(REF_FILE) ? JSON.parse(fs.readFileSync(REF_FILE, 'utf8')) : {};
    fs.writeFileSync(REF_FILE, JSON.stringify(Object.fromEntries(Object.entries({ ...now, ...recorded }).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1) + '\n');
  });
}

const tally = () => ({ slots: 0, priced: 0, unpriced: 0, weighted: 0, estimated: 0, fixed: 0, mixed: 0, registers: {} });

// Every slot of the local days fromDate..toDate at each slot length, for each meter kind, in each context of `contexts` ({ name:
// pricing context with runs }). The contexts must agree exactly; their hash must be the recorded one.
export async function diffPricing(contexts, tz, fromDate, toDate, { slotLengths = [900, 1800, 3600], kinds = KINDS, label = 'pricing' } = {}) {
  const { slotPrice, fixedShare } = await import('../src/core/slot-price.js');
  const { daysBetween, slotsOfDay } = await import('../src/core/time.js');
  const seen = tally();
  const n = seenKeys.get(label) ?? 0; seenKeys.set(label, n + 1);
  const hashes = new Map();
  const [[firstName, first], ...others] = Object.entries(contexts);
  for (const slotS of slotLengths) {
    for (const date of daysBetween(fromDate, toDate)) {
      for (const slot of slotsOfDay(tz, date, slotS)) {
        for (const kind of kinds) {
          const want = slotPrice(first, kind, slot, slotS);
          const wantFixed = want ? fixedShare(want, slot, slotS, tz) : 0;
          const hk = `${label}#${n} ${slotS} ${kind}`;
          (hashes.get(hk) ?? hashes.set(hk, createHash('sha1')).get(hk)).update(JSON.stringify(stable(want, wantFixed)));
          const at = `${label} ${kind} ${date} slot ${slot} (${slotS} s)`;
          for (const [how, ctx] of others) {
            const got = slotPrice(ctx, kind, slot, slotS);
            assert.deepStrictEqual(got, want, `${at}: price from ${how} differs from ${firstName}`);
            assert.strictEqual(fixedShare(got, slot, slotS, tz), wantFixed, `${at}: fixed share from ${how} differs from ${firstName}`);
          }
          seen.slots++;
          if (want?.unitEx != null) seen.priced++; else seen.unpriced++;
          if (want?.weighted) seen.weighted++;
          if (want?.estimated) seen.estimated++;
          if (want?.register === 'mixed') seen.mixed++;
          if (wantFixed !== 0) seen.fixed++;
          if (want) { const k = `${want.structure}/${want.register}`; seen.registers[k] = (seen.registers[k] ?? 0) + 1; }
        }
      }
    }
  }
  for (const [k, h] of hashes) {
    recorded[k] = h.digest('hex');
    if (process.env.UPDATE_PRICE_REF !== '1') assert.strictEqual(recorded[k], ref[k], `${k}: the slot prices and fixed shares are not the recorded ones (test/fixtures/price-slots-ref.json)`);
  }
  return seen;
}

// A home in the database over local days fromDate..toDate: the runs made in memory from its rate rows (the "as known at" path)
// and the runs read back from the table (the current path).
export async function diffHome(siteId, fromDate, toDate, opts = {}) {
  const { db } = await import('../src/db/db.js');
  const { loadPricing } = await import('../src/core/pricing.js');
  const { withRunsFromRates } = await import('../src/core/price-runs.js');
  const { dayBounds } = await import('../src/core/time.js');
  const tz = (await db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId)).timezone;
  const from = dayBounds(tz, fromDate)[0];
  const to = dayBounds(tz, toDate)[1];
  const p = await loadPricing(siteId, from, to, null, { rateRows: true });
  return await diffPricing({ stored: p, 'in memory': withRunsFromRates(p) }, tz, fromDate, toDate, { label: `home ${siteId}`, ...opts });
}
