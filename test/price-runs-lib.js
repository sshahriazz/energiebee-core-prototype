// The differential check behind Phase T.1 and T.2 (docs/build/tariff.md): for every slot, the price taken from price runs equals
// the price the rate-row path (pricing.js priceOver) gives, and the fixed share equals fixedOver. Exact equality: the same
// object, the same floating-point numbers. Runs are taken the ways the code reads them: made in memory from the rows loadPricing
// read (the "as known at" path), and read back from tariff_price_run (materialised first) for a home in the database.
import assert from 'node:assert/strict';

export const KINDS = ['meter_import', 'meter_export', 'meter_gas'];

const tally = () => ({ slots: 0, priced: 0, unpriced: 0, weighted: 0, estimated: 0, fixed: 0, mixed: 0, registers: {} });

// Every slot of the local days fromDate..toDate at each slot length, for each meter kind, against each context in `contexts`
// ({ name: pricing context with runs }). `base` is the same context without runs, read by the rate-row path.
export async function diffPricing(base, contexts, tz, fromDate, toDate, { slotLengths = [900, 1800, 3600], kinds = KINDS, label = 'pricing' } = {}) {
  const { priceOver, fixedOver } = await import('../src/core/pricing.js');
  const { priceOverRuns, fixedShare } = await import('../src/core/slot-price.js');
  const { dayBounds, daysBetween, slotsOfDay } = await import('../src/core/time.js');
  const seen = tally();
  for (const slotS of slotLengths) {
    for (const date of daysBetween(fromDate, toDate)) {
      const [dayStart, dayEnd] = dayBounds(tz, date);
      const nSlotsDay = (dayEnd - dayStart) / slotS;
      for (const slot of slotsOfDay(tz, date, slotS)) {
        for (const kind of kinds) {
          const want = priceOver(base, kind, slot, slotS);
          const wantFixed = want ? fixedOver(want, slot, slotS, nSlotsDay, tz) : 0;
          const at = `${label} ${kind} ${date} slot ${slot} (${slotS} s)`;
          for (const [how, ctx] of Object.entries(contexts)) {
            const got = priceOverRuns(ctx, kind, slot, slotS);
            assert.deepStrictEqual(got, want, `${at}: price from runs (${how})`);
            assert.strictEqual(fixedShare(got, slot, slotS, tz), wantFixed, `${at}: fixed share (${how})`);
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
  return seen;
}

// A home in the database over local days fromDate..toDate: runs made in memory and runs read back from the table.
export async function diffHome(siteId, fromDate, toDate, opts = {}) {
  const { db } = await import('../src/db/db.js');
  const { loadPricing } = await import('../src/core/pricing.js');
  const { withRunsFromRates } = await import('../src/core/price-runs.js');
  const { materialiseHomeRuns, pricingWithStoredRuns } = await import('../src/core/price-run-store.js');
  const { dayBounds } = await import('../src/core/time.js');
  const tz = (await db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId)).timezone;
  const from = dayBounds(tz, fromDate)[0];
  const to = dayBounds(tz, toDate)[1];
  await materialiseHomeRuns(siteId);
  const p = await loadPricing(siteId, from, to);
  return await diffPricing(p, { 'in memory': withRunsFromRates(p), stored: await pricingWithStoredRuns(p, siteId, from, to) }, tz, fromDate, toDate, { label: `home ${siteId}`, ...opts });
}
