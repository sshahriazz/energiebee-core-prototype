// Market provider registry: which provider fills each role a home needs, per market (rows for the
// market_provider table, delta 008; field names are its column names). The sync job builds every
// home's plan from these rows (src/core/providers.js).
//
// GB lists the providers the core called before the registry, in the same roles, plus the
// Tariffscanner catalogue (a second tariff_catalogue provider, run alongside Octopus's). FR and NL
// list what is planned: weather works today (Open-Meteo is worldwide); the meter readers (Linky,
// P1) and the price sources (tounify, ENTSO-E) are NOT built and are listed disabled, saying why;
// typed-in prices ('manual', origin user) are always allowed. DE, BE and ES have weather only.
// Inverter clouds do not depend on the country: Sunsynk is listed once, for every market ('*').
// Origins follow src/core/provenance.js: 'provider' for live data from a built adapter, 'user' for
// typed-in prices, 'placeholder' for an entry whose adapter does not exist yet.
// owner is 'core' on every row: the core calls each of these providers itself, Tariffscanner
// included (its own credential, its own throttle and budget). 'external' would mark a provider
// whose rate budget another process owns; the core never calls such a row (contract.js assertOwner).

const OPEN_METEO = 'Open-Meteo hourly weather and sunlight for the home\'s coordinates (any country); the free host is for non-commercial use, production needs a paid plan';
const NOT_BUILT = 'adapter not built';
const TOUNIFY = `${NOT_BUILT}: tounify retail tariffs (supplier price, grid fees, taxes); the licence to store its data and serve it to many homes is unconfirmed`;
const ENTSOE = `${NOT_BUILT}: ENTSO-E day-ahead wholesale price per bidding zone (not a retail tariff); needs a registered ENTSO-E token`;
const MANUAL = 'prices typed in by the user or installer (src/core/tariffs.js createTariff, putRateRows with origin user): always allowed, nothing to fetch';
export const TARIFFSCANNER = 'Tariffscanner (FEA) UK domestic tariff catalogue, queried with the core\'s own credential; contract terms not read by us.';

const row = (market_code, role, adapter, scope, origin, note, extra = {}) => ({
  market_code, role, adapter, scope, origin, note, priority: 10, enabled: 1, owner: 'core', needs_credentials: 0, licence_confirmed: 1, ...extra,
});

const euTariffs = (m) => [
  row(m, 'tariff_prices', 'tounify', 'shared', 'placeholder', TOUNIFY, { priority: 10, enabled: 0, licence_confirmed: 0, needs_credentials: 1 }),
  row(m, 'tariff_prices', 'entsoe', 'shared', 'placeholder', ENTSOE, { priority: 20, enabled: 0, needs_credentials: 1 }),
  row(m, 'tariff_prices', 'manual', 'home', 'user', MANUAL, { priority: 90 }),
];

export const PROVIDERS = Object.freeze([
  // Any market.
  row('*', 'inverter', 'sunsynk', 'home', 'provider', 'Sunsynk Connect with the owner\'s own login, read from .env (SUNSYNK_USERNAME, SUNSYNK_PASSWORD); a production system needs a partner key, the consumer app\'s terms forbid automated scraping', { needs_credentials: 1 }),
  // GB: the providers the sync job called before the registry, then the Tariffscanner catalogue.
  row('GB', 'location', 'geo', 'shared', 'provider', 'postcodes.io (coordinates, outcode), the Octopus grid supply point letter and the NESO carbon region, looked up from the home\'s postcode while one of them is missing'),
  row('GB', 'weather', 'open_meteo', 'shared', 'provider', OPEN_METEO),
  row('GB', 'carbon', 'neso', 'shared', 'provider', 'NESO Carbon Intensity API: regional forecast per carbon region (past slots kept as estimated)'),
  row('GB', 'meter', 'octopus', 'home', 'provider', 'Octopus account: meters and tariff agreements, half-hourly consumption, gas units, Kraken dispatches; API key and account number from .env (OCTOPUS_API_KEY, OCTOPUS_ACCOUNT_NUMBER)', { needs_credentials: 1 }),
  row('GB', 'gas_cv', 'national_gas', 'shared', 'provider', 'National Gas Data Portal: daily calorific value per local distribution zone; runs once the home has a gas meter'),
  row('GB', 'tariff_prices', 'octopus', 'shared', 'provider', 'Octopus public tariff rates (no key): the tariffs of the home\'s Octopus account, read in the meter step, or tariff codes given in .env (IMPORT_TARIFF_CODE, EXPORT_TARIFF_CODE)'),
  row('GB', 'tariff_catalogue', 'octopus', 'shared', 'provider', 'Octopus public products list, read by the comparison step to pick the products on sale today'),
  // A second catalogue, run as well as Octopus's (tariff_catalogue is an additive role). The core's
  // own credential from .env (TARIFFSCAN_USERNAME, TARIFFSCAN_PASSWORD); src/adapters/tariffscanner.js.
  row('GB', 'tariff_catalogue', 'tariffscanner', 'shared', 'provider', TARIFFSCANNER, { priority: 20, needs_credentials: 1 }),
  row('GB', 'compare', 'compare', 'shared', 'provider', 'Reference tariffs for the comparison page (Agile import, Agile Outgoing) for the home\'s region, priced from Octopus public rates'),
  row('GB', 'solar_forecast', 'quartz', 'shared', 'provider', 'Open Climate Fix Quartz 48-hour solar forecast; called only when panel size, tilt and direction are known'),
  // FR: weather works; the meter and price sources are planned, not built.
  row('FR', 'weather', 'open_meteo', 'shared', 'provider', OPEN_METEO),
  row('FR', 'meter', 'linky', 'home', 'placeholder', `${NOT_BUILT}: Linky meter data (Enedis with the customer's consent, or a local reader) is planned; nothing is read yet`, { enabled: 0, needs_credentials: 1 }),
  ...euTariffs('FR'),
  // NL: as FR, with a P1 port reader for the meter.
  row('NL', 'weather', 'open_meteo', 'shared', 'provider', OPEN_METEO),
  row('NL', 'meter', 'p1', 'home', 'placeholder', `${NOT_BUILT}: a P1 port reader (DSMR smart meter) through an edge agent is planned; nothing is read yet`, { enabled: 0 }),
  ...euTariffs('NL'),
  // Minimal stand-in markets: weather only.
  ...['DE', 'BE', 'ES'].map((m) => row(m, 'weather', 'open_meteo', 'shared', 'provider', OPEN_METEO)),
].map((r) => Object.freeze(r)));

export const PROVIDER_COLUMNS = Object.freeze(['market_code', 'role', 'adapter', 'priority', 'enabled', 'owner', 'scope', 'needs_credentials', 'licence_confirmed', 'origin', 'note']);
// Refreshed from the seed on every open; enabled and licence_confirmed are written on insert only.
const DESCRIPTIVE = ['priority', 'owner', 'scope', 'needs_credentials', 'origin', 'note'];

// Writes the rows into a database that has delta 008 applied (any node:sqlite DatabaseSync).
export function seedProviders(db, providers = PROVIDERS) {
  const up = db.prepare(`INSERT INTO market_provider (${PROVIDER_COLUMNS.join(', ')}) VALUES (${PROVIDER_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (market_code, role, adapter) DO UPDATE SET ${DESCRIPTIVE.map((c) => `${c} = excluded.${c}`).join(', ')}`);
  for (const p of providers) up.run(...PROVIDER_COLUMNS.map((c) => p[c] ?? null));
}
