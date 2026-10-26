-- Delta 008: market provider registry. Applied after 007 by db.js, once. Same applying rules
-- as 002-007: statements end with ';' at the end of a line, an ADD COLUMN whose column exists is
-- skipped, and every other statement may be run again.
--
-- Which provider fills each role a home needs, per market. The sync job builds each home's plan from
-- these rows (src/core/providers.js plan) instead of calling a fixed list of providers.
--   role               location (postcode to coordinates and regions), inverter, meter, weather,
--                      carbon, solar_forecast, gas_cv, tariff_catalogue, tariff_prices, compare.
--                      Checked in code (src/core/providers.js ROLES), not by a CHECK, so a new role
--                      is a new row, never a table rebuild.
--   market_code        a market code, or '*' for a provider that does not depend on the country
--                      (inverter clouds such as Sunsynk). No foreign key, because of '*'.
--   adapter            the code an implementation is registered under (registerAdapter); a row
--                      whose adapter is not built yet is listed with enabled = 0 and says so
--   priority           lower first: the first usable provider of a role is the one used, the
--                      others are fallbacks
--   enabled            0 = listed but never called (not built, waiting for a token, ...)
--   owner              the ONE process allowed to call the provider (adapters/contract.js
--                      assertOwner): 'core', or 'external' when another process owns the
--                      provider's rate budget and the core must not call it. Delta 010 rebuilds a
--                      table created with an older owner CHECK.
--   scope              shared: runs for every home of the market from public data, once per
--                      tariff / region / zone / location per sync cycle; home: runs only for a home
--                      with its own connection row (its account, its device)
--   needs_credentials  1 = the home's credentials are checked before the step runs; missing ones
--                      skip the step ('no credentials'), never an error
--   licence_confirmed  0 = the right to store and serve the provider's data is unconfirmed: skipped
--   origin, note       provenance (src/core/provenance.js) of what the provider gives, and an
--                      honest note ('adapter not built' where it is not)
-- Rows are seeded from src/db/seed/providers.js by db.js. The seed inserts missing rows and keeps
-- owner, scope, needs_credentials, origin and note in line with the adapter code (written only where
-- they differ); it never changes priority, enabled or licence_confirmed on a row that exists, so
-- an operator's order of fallbacks and switches stay.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS market_provider (
  market_code        TEXT NOT NULL CHECK (market_code = '*' OR (length(market_code) = 2 AND market_code = upper(market_code))),
  role               TEXT NOT NULL,
  adapter            TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 100,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner              TEXT NOT NULL DEFAULT 'core' CHECK (owner IN ('core', 'external')),
  scope              TEXT NOT NULL CHECK (scope IN ('shared', 'home')),
  needs_credentials  INTEGER NOT NULL DEFAULT 0 CHECK (needs_credentials IN (0, 1)),
  licence_confirmed  INTEGER NOT NULL DEFAULT 1 CHECK (licence_confirmed IN (0, 1)),
  origin             TEXT NOT NULL CHECK (origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  note               TEXT,
  PRIMARY KEY (market_code, role, adapter)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS market_provider_role ON market_provider (role, market_code, priority);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('008-market-provider', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
