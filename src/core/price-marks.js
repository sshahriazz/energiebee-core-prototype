// The marks the write functions leave when a price input changes (see src/db/price-dirty.js, processed by price-queue.js). Kept apart
// from the queue so the layers that write rate rows, windows and agreements can mark without importing the pricing code.
import { db } from '../db/db.js';
import { markPriceDirty } from '../db/price-dirty.js';

export const markTariffDirty = async (tariffId, fromTs, reason) => await markPriceDirty(db, { tariffId }, fromTs, reason);
export const markCountryDirty = async (country, fromTs, reason) => await markPriceDirty(db, { country }, fromTs, reason);
export const markHomeDirty = async (siteId, fromTs, reason) => await markPriceDirty(db, { siteId }, fromTs, reason);

// The tariff's own columns the pricing reads (the stamp of a stored slot holds them too): a change in one of them is a price change from
// the start, like a rate row.
const PRICE_COLUMNS = ['fuel', 'direction', 'structure', 'currency', 'kind', 'taxes_in_price', 'default_register'];
export async function markTariffColumnsDirty(tariffId, changedColumns) {
  const hit = changedColumns.filter((c) => PRICE_COLUMNS.includes(c));
  if (hit.length) await markTariffDirty(tariffId, 0, `tariff details changed (${hit.join(', ')})`);
}
