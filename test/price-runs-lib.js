// The differential check behind Phase T.1 and T.2 (docs/build/tariff.md): for every slot of a home, the price taken from price
// runs equals the price the rate-row path (pricing.js priceOver) gives, and the fixed share equals fixedOver. Runs are taken both
// ways the code reads them: made in memory from the rows loadPricing read (the "as known at" path) and read back from
// tariff_price_run (materialised first). Exact equality: the same object, the same floating-point numbers.
import assert from 'node:assert/strict';

export const KINDS = ['meter_import', 'meter_export', 'meter_gas'];

// Returns what was compared, so a test can show it was not vacuous.
export async function diffHome(siteId, fromDate, toDate, slotLengths = [900, 1800, 3600]) {
  const { db } = await import('../src/db/db.js');
  const { loadPricing, priceOver, fixedOver } = await import('../src/core/pricing.js');
  const { withRunsFromRates } = await import('../src/core/price-runs.js');
  const { priceOverRuns, fixedShare } = await import('../src/core/slot-price.js');
  const { materialiseHomeRuns, pricingWithStoredRuns } = await import('../src/core/price-run-store.js');
  const { dayBounds, daysBetween, slotsOfDay } = await import('../src/core/time.js');

  const site = await db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  const tz = site.timezone;
  const from = dayBounds(tz, fromDate)[0];
  const to = dayBounds(tz, toDate)[1];
  await materialiseHomeRuns(siteId);
  const p = await loadPricing(siteId, from, to);
  const mem = withRunsFromRates(p);
  const stored = await pricingWithStoredRuns(p, siteId, from, to);
  const seen = { slots: 0, priced: 0, unpriced: 0, weighted: 0, estimated: 0, fixed: 0, mixed: 0, registers: {} };
  for (const slotS of slotLengths) {
    for (const date of daysBetween(fromDate, toDate)) {
      const [dayStart, dayEnd] = dayBounds(tz, date);
      const nSlotsDay = (dayEnd - dayStart) / slotS;
      for (const slot of slotsOfDay(tz, date, slotS)) {
        for (const kind of KINDS) {
          const want = priceOver(p, kind, slot, slotS);
          const label = `home ${siteId} ${kind} ${date} slot ${slot} (${slotS} s)`;
          for (const [how, ctx] of [['in memory', mem], ['stored', stored]]) {
            assert.deepStrictEqual(priceOverRuns(ctx, kind, slot, slotS), want, `${label}: price from runs (${how})`);
            assert.strictEqual(fixedShare(priceOverRuns(ctx, kind, slot, slotS), slot, slotS, tz), want ? fixedOver(want, slot, slotS, nSlotsDay, tz) : 0, `${label}: fixed share (${how})`);
          }
          seen.slots++;
          if (want?.unitEx != null) seen.priced++; else seen.unpriced++;
          if (want?.weighted) seen.weighted++;
          if (want?.estimated) seen.estimated++;
          if (want?.register === 'mixed') seen.mixed++;
          if (want) seen.registers[`${want.structure}/${want.register}`] = (seen.registers[`${want.structure}/${want.register}`] ?? 0) + 1;
          if (want && fixedOver(want, slot, slotS, nSlotsDay, tz) !== 0) seen.fixed++;
        }
      }
    }
  }
  return seen;
}
