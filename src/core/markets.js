// Markets: per-country clock, currency and time grain (seed: src/db/seed/markets.js), and the
// slot length a home is built with.
import { MARKETS } from '../db/seed/markets.js';

export const SLOT_LENGTHS_S = Object.freeze([900, 1800, 3600]);

export function getMarket(code, markets = MARKETS) {
  const m = markets.find((x) => x.code === code);
  if (!m) throw new RangeError(`unknown market: ${code}`);
  return m;
}

// The slot length for a home in this market on this tariff: the longest allowed length
// (900/1800/3600) that is no longer than the market's default slot and that divides the price
// interval, so every price change falls on a slot boundary. The price interval is the tariff's
// own (tariff.native_period_s) when it has one, else the market's; a tariff with no interval
// (flat, or a static day/night) keeps the market default. A tracker's daily price (86400) stays
// on the market default; a GB tariff with quarter-hour prices gets 900; prices finer than
// 15 minutes still get 900 (the slot then pays their time-weighted mean).
export function defaultSlotFor(market, tariff) {
  const m = typeof market === 'string' ? getMarket(market) : market;
  const interval = tariff?.native_period_s ?? m.price_interval_s;
  if (!(interval > 0)) throw new RangeError(`price interval must be a positive number of seconds: ${interval}`);
  for (const s of [...SLOT_LENGTHS_S].reverse()) {
    if (s <= m.default_slot_s && s <= interval && interval % s === 0) return s;
  }
  return SLOT_LENGTHS_S[0];
}
