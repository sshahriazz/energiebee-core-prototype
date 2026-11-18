// Marks a price change in the queue (table price_dirty, Phase T.5). The data layer owns the SQL so the write functions of every layer
// (tariffs.js, the adapters, the tax rules seeded in db.js, the agreements) mark in one way; src/core/price-queue.js processes the
// marks. Not a trigger on purpose: what a change reaches (as-known-at reads, which rows count as current) is decided in code.
//   { tariffId }  a rate row, a tariff's window or its calendar changed: the tariff's runs are made again, once, and the homes on it queued
//   { country }   a tax rule changed: the homes in the country are queued
//   { siteId }    a home's agreement or its meter's windows changed: that home is queued
// fromTs: the earliest time the change reaches (s). A mark already queued keeps the earlier of the two times.
export async function markPriceDirty(d, { tariffId = null, country = null, siteId = null }, fromTs, reason = null, at = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(fromTs)) throw new TypeError(`a price change needs the time it reaches, not ${fromTs}`);
  const [scope, col, key] = tariffId != null ? ['tariff', 'tariff_id', tariffId] : country != null ? ['country', 'country', country] : ['home', 'site_id', siteId];
  if (key == null) throw new TypeError('a price change names a tariff, a country or a home');
  await d.prepare(`INSERT INTO price_dirty (scope, ${col}, from_ts, reason, marked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (${col}) WHERE scope = '${scope}' DO UPDATE SET from_ts = LEAST(price_dirty.from_ts, excluded.from_ts), reason = excluded.reason, marked_at = excluded.marked_at`)
    .run(scope, key, Math.floor(fromTs), reason, at);
}
