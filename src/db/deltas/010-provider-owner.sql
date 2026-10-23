-- Delta 010: market_provider owner is 'core' or 'external'. Applied after 009 by db.js on every
-- open. Same applying rules as 002-009: statements end with ';' at the end of a line, an ADD COLUMN
-- whose column exists is skipped, and every other statement may be run again.
--
-- owner names the ONE process allowed to call a provider (src/adapters/contract.js assertOwner):
--   core      this process
--   external  another process owns the provider's rate budget: the core must not call it
-- A table created by an older delta 008 allowed 'core' and one other process's name in its owner
-- CHECK. A CHECK cannot be altered, so the table is rebuilt with SQLite's procedure (rows copied
-- out, table dropped, created again, rows copied back, all in the delta's one transaction) and
-- every owner other than 'core' becomes 'external'. Everything else is as delta 008 makes it: the
-- same columns and defaults, the other CHECKs, PRIMARY KEY (market_code, role, adapter), WITHOUT
-- ROWID and the index market_provider_role. No trigger, view or foreign key refers to the table.
-- SQLite cannot run DDL conditionally, so the rebuild runs on every open; the table holds a few
-- dozen rows and the result is the same each time (same rows, same values, same definition), and
-- seed/providers.js runs after it as before.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

DROP TABLE IF EXISTS temp.market_provider_010;
CREATE TEMP TABLE market_provider_010 AS SELECT * FROM main.market_provider;
DROP TABLE main.market_provider;

CREATE TABLE market_provider (
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

INSERT INTO market_provider (market_code, role, adapter, priority, enabled, owner, scope, needs_credentials, licence_confirmed, origin, note)
  SELECT market_code, role, adapter, priority, enabled, CASE WHEN owner = 'core' THEN 'core' ELSE 'external' END,
    scope, needs_credentials, licence_confirmed, origin, note
  FROM temp.market_provider_010;
DROP TABLE temp.market_provider_010;
CREATE INDEX IF NOT EXISTS market_provider_role ON market_provider (role, market_code, priority);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('010-provider-owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
