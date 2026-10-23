// Electricity markets: the clock, currency and time grain of each country's prices and meters.
// Rows for the market table (delta 003); field names are its column names.
//   price_interval_s   grain of the prices a home pays (GB half-hours; NL day-ahead quarter-hours;
//                      FR regulated HP/HC windows and Tempo days, which sit on half-hours)
//   meter_interval_s   usual grain of settlement meter data
//   default_slot_s     slot length a new home in this market is built with (900, 1800 or 3600)
//   bidding_zone       ENTSO-E bidding zone of the wholesale price
// GB is what the core runs on today (delta 003 also inserts it, for the backfill). FR and NL
// follow the slot design. DE, BE and ES are minimal stand-ins marked unverified: check the
// market operator's and network operators' rules before any home there is priced.
// Provenance (src/core/provenance.js): GB is 'sourced' (the note names the source; delta 005 uses
// the same note). Every other row was written from memory and is a 'placeholder': FR and NL too,
// although the demo prices homes there. Verify the intervals and zones before relying on them.
const GB_NOTE = 'GB half-hourly settlement period, Europe/London clock and GBP (Elexon BSC); the same 30-minute grid as the Octopus rate and meter intervals';
const PLACEHOLDER_NOTE = 'written from memory, not verified against the market operator (ENTSO-E / TSO rules): check before pricing any home there';
export const MARKETS = Object.freeze([
  { code: 'GB', country: 'GB', timezone: 'Europe/London', currency: 'GBP', price_interval_s: 1800, meter_interval_s: 1800, default_slot_s: 1800, bidding_zone: 'GB', origin: 'sourced', origin_note: GB_NOTE },
  { code: 'FR', country: 'FR', timezone: 'Europe/Paris', currency: 'EUR', price_interval_s: 1800, meter_interval_s: 1800, default_slot_s: 1800, bidding_zone: 'FR', origin: 'placeholder', origin_note: PLACEHOLDER_NOTE },
  { code: 'NL', country: 'NL', timezone: 'Europe/Amsterdam', currency: 'EUR', price_interval_s: 900, meter_interval_s: 900, default_slot_s: 900, bidding_zone: 'NL', origin: 'placeholder', origin_note: PLACEHOLDER_NOTE },
  { code: 'DE', country: 'DE', timezone: 'Europe/Berlin', currency: 'EUR', price_interval_s: 900, meter_interval_s: 900, default_slot_s: 900, bidding_zone: 'DE-LU', unverified: true, origin: 'placeholder', origin_note: PLACEHOLDER_NOTE },
  { code: 'BE', country: 'BE', timezone: 'Europe/Brussels', currency: 'EUR', price_interval_s: 900, meter_interval_s: 900, default_slot_s: 900, bidding_zone: 'BE', unverified: true, origin: 'placeholder', origin_note: PLACEHOLDER_NOTE },
  { code: 'ES', country: 'ES', timezone: 'Europe/Madrid', currency: 'EUR', price_interval_s: 3600, meter_interval_s: 3600, default_slot_s: 3600, bidding_zone: 'ES', unverified: true, origin: 'placeholder', origin_note: PLACEHOLDER_NOTE },
].map((m) => Object.freeze(m)));

export const MARKET_COLUMNS = Object.freeze(['code', 'country', 'timezone', 'currency', 'price_interval_s', 'meter_interval_s', 'default_slot_s', 'bidding_zone', 'origin', 'origin_note']);

// Writes the rows into a database that has delta 003 applied (any node:sqlite DatabaseSync).
export function seedMarkets(db, markets = MARKETS) {
  const set = MARKET_COLUMNS.filter((c) => c !== 'code').map((c) => `${c} = excluded.${c}`).join(', ');
  const up = db.prepare(`INSERT INTO market (${MARKET_COLUMNS.join(', ')}) VALUES (${MARKET_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (code) DO UPDATE SET ${set}`);
  for (const m of markets) up.run(...MARKET_COLUMNS.map((c) => m[c] ?? null));
}

// One region per bidding zone (scheme 'bzn', code = the ENTSO-E zone): the whole-country region
// of a market with one zone (FR, NL, GB), so a home can be placed "nationally" in the same
// site_region table as a GB distribution region. A partition of its own: never aliased.
// Each zone row is derived from its market row and so carries that row's origin (GB sourced, the
// others placeholders), with a note saying so.
const ZONE_NAMES = { GB: 'Great Britain', FR: 'France', NL: 'Netherlands', 'DE-LU': 'Germany and Luxembourg', BE: 'Belgium', ES: 'Spain' };
export function seedBiddingZones(db, markets = MARKETS) {
  const up = db.prepare(`INSERT INTO region (scheme, code, country, name, origin, origin_note) VALUES ('bzn', ?, ?, ?, ?, ?)
    ON CONFLICT (scheme, code) DO UPDATE SET country = excluded.country, name = excluded.name, origin = excluded.origin, origin_note = excluded.origin_note`);
  for (const m of markets) {
    if (m.bidding_zone) up.run(m.bidding_zone, m.country, ZONE_NAMES[m.bidding_zone] ?? m.bidding_zone, m.origin ?? null, m.origin_note ? `derived from market ${m.code} (bidding_zone '${m.bidding_zone}'), whose row is ${m.origin}: ${m.origin_note}` : null);
  }
}
