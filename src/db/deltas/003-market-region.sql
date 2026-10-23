-- Delta 003: markets and regions. Applied after 002 (market.currency references currency);
-- NOT yet applied by db.js. Same applying rules as 002: statements end with ';' at the end of a
-- line, a trigger ends with 'END;', an ADD COLUMN whose column exists is skipped, and every other
-- statement may be run again (backfills are guarded by schema_delta: first application only).
-- Region and market rows beyond GB come from src/db/seed/regions-gb.js and seed/markets.js.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── Markets ─────────────
-- A country's clock, currency and time grain. The slot length a home is built with is chosen
-- from these (src/core/markets.js defaultSlotFor).
CREATE TABLE IF NOT EXISTS market (
  code              TEXT PRIMARY KEY,                -- GB | FR | NL | DE | BE | ES
  country           TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  timezone          TEXT NOT NULL,                   -- the market's own clock (IANA)
  currency          TEXT NOT NULL REFERENCES currency(code),
  price_interval_s  INTEGER NOT NULL CHECK (price_interval_s > 0 AND price_interval_s % 300 = 0 AND 3600 % price_interval_s = 0),
  meter_interval_s  INTEGER NOT NULL CHECK (meter_interval_s > 0 AND meter_interval_s % 300 = 0 AND 3600 % meter_interval_s = 0),
  default_slot_s    INTEGER NOT NULL CHECK (default_slot_s IN (900, 1800, 3600)),
  bidding_zone      TEXT                             -- ENTSO-E bidding zone (GB, FR, NL, DE-LU, ...)
) WITHOUT ROWID;
-- GB is needed by the backfill below; the same row as seed/markets.js.
INSERT OR IGNORE INTO market (code, country, timezone, currency, price_interval_s, meter_interval_s, default_slot_s, bidding_zone)
  VALUES ('GB', 'GB', 'Europe/London', 'GBP', 1800, 1800, 1800, 'GB');

-- ───────────── Regions ─────────────
-- Every way a country is divided: scheme gb_dno (14 distribution regions, code = MPAN
-- distributor id 10-23), gb_carbon (NESO carbon regions), bzn (bidding zones), ...
CREATE TABLE IF NOT EXISTS region (
  id       INTEGER PRIMARY KEY,
  scheme   TEXT NOT NULL,
  code     TEXT NOT NULL,
  country  TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country))),
  name     TEXT,
  UNIQUE (scheme, code)
);

-- Other numberings of the SAME region: GB has the Octopus GSP letter (octopus_gsp 'G'), the
-- Tariffscanner name and id (tariffscan_name 'Norweb', tariffscan_id '7') for gb_dno '16'.
-- An alias resolves to exactly one region.
CREATE TABLE IF NOT EXISTS region_alias (
  scheme        TEXT NOT NULL,
  code          TEXT NOT NULL,
  alias_scheme  TEXT NOT NULL,
  alias_code    TEXT NOT NULL,
  PRIMARY KEY (alias_scheme, alias_code),
  FOREIGN KEY (scheme, code) REFERENCES region (scheme, code) ON DELETE CASCADE,
  CHECK (alias_scheme <> scheme)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS region_alias_region ON region_alias (scheme, code);

-- Two partitions are never aliased to each other: NESO carbon regions and DNO regions divide GB
-- differently (BB12 and L1 are both GSP 'G' but carbon regions 3 and 6), so no mapping is right.
CREATE TRIGGER IF NOT EXISTS region_alias_not_a_partition
BEFORE INSERT ON region_alias
WHEN NEW.alias_scheme IN ('gb_dno', 'gb_carbon', 'bzn') OR EXISTS (SELECT 1 FROM region WHERE scheme = NEW.alias_scheme)
BEGIN
  SELECT RAISE(ABORT, 'alias scheme is a region scheme of its own: partitions are never aliased');
END;

CREATE TRIGGER IF NOT EXISTS region_alias_not_a_partition_update
BEFORE UPDATE OF alias_scheme ON region_alias
WHEN NEW.alias_scheme IN ('gb_dno', 'gb_carbon', 'bzn') OR EXISTS (SELECT 1 FROM region WHERE scheme = NEW.alias_scheme)
BEGIN
  SELECT RAISE(ABORT, 'alias scheme is a region scheme of its own: partitions are never aliased');
END;

CREATE TRIGGER IF NOT EXISTS region_scheme_not_an_alias
BEFORE INSERT ON region
WHEN EXISTS (SELECT 1 FROM region_alias WHERE alias_scheme = NEW.scheme)
BEGIN
  SELECT RAISE(ABORT, 'region scheme is already used as an alias scheme');
END;

-- The region a home is in, per scheme, versioned like facts: a correction supersedes the old row
-- (kept). (scheme, code) references region, so the scheme cannot disagree with the region.
CREATE TABLE IF NOT EXISTS site_region (
  site_id        INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  scheme         TEXT NOT NULL,
  code           TEXT NOT NULL,
  source         TEXT NOT NULL,                      -- octopus_agreement | postcode_lookup | provider | installer
  recorded_at    INTEGER NOT NULL,                   -- ms
  superseded_at  INTEGER,                            -- ms; NULL = current
  PRIMARY KEY (site_id, scheme, recorded_at),
  FOREIGN KEY (scheme, code) REFERENCES region (scheme, code),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS site_region_current ON site_region (site_id, scheme) WHERE superseded_at IS NULL;

-- ───────────── Where a home and a tariff belong ─────────────
-- Writers must set these for new rows.
ALTER TABLE site ADD COLUMN country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country)));
ALTER TABLE site ADD COLUMN market_code TEXT REFERENCES market(code);
ALTER TABLE tariff ADD COLUMN country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country)));
-- The tariff's own price grain, s: NULL = static (flat, fixed day/night windows); 900/1800/3600 =
-- a price series; 86400 = a daily price (tracker). Feeds the slot length (defaultSlotFor).
ALTER TABLE tariff ADD COLUMN native_period_s INTEGER CHECK (native_period_s IS NULL OR (native_period_s > 0 AND native_period_s % 300 = 0));

-- Backfill, first application only: every home and tariff so far is in the GB market.
UPDATE site SET country = 'GB' WHERE country IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '003-market-region');
UPDATE site SET market_code = 'GB' WHERE market_code IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '003-market-region');
UPDATE tariff SET country = 'GB' WHERE country IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '003-market-region');

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('003-market-region', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
