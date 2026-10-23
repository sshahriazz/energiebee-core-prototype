-- Delta 004: tariff kind and ledger currency. Applied after 003 (it reads market and currency)
-- by db.js on every open. Same applying rules as 002 and 003: statements end with ';' at the end
-- of a line, a trigger ends with 'END;', an ADD COLUMN whose column exists is skipped, and every
-- other statement may be run again (backfills are guarded by schema_delta: first application only).
--
-- The rate_interval changes that go with this (components fixed and capacity, charge_period,
-- registers beyond single/day/night) cannot be made by ALTER TABLE, because they relax CHECK
-- constraints: schema.sql has the new table and db.js rebuilds an old one once, copying every row.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── Tariff kind ─────────────
-- What kind of price the tariff has, in the words of the adapter contract
-- (src/adapters/contract.js TariffListing.kind). tariff.structure stays the pricing method the
-- build follows: flat, tou, agile, e7, iog, tracker, export, agile_export (Octopus), windows (unit
-- rows expanded from register windows: the row covering an instant gives its register), dynamic.
ALTER TABLE tariff ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('flat', 'tou', 'calendar_tou', 'dynamic', 'spot_indexed', 'dispatch', 'market'));

-- Backfill, first application only: the Octopus structures so far.
UPDATE tariff SET kind = CASE structure
    WHEN 'flat' THEN 'flat' WHEN 'export' THEN 'flat'
    WHEN 'tou' THEN 'tou' WHEN 'e7' THEN 'tou'
    WHEN 'agile' THEN 'dynamic' WHEN 'agile_export' THEN 'dynamic' WHEN 'tracker' THEN 'dynamic'
    WHEN 'iog' THEN 'dispatch' END
  WHERE kind IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '004-tariff-ledger');

-- ───────────── Ledger currency ─────────────
-- The currency of a day's money (site_day costs, credits and savings, and the site_hh rows of
-- that day): the home's currency when the day was built. Minor units, as everywhere.
ALTER TABLE site_day ADD COLUMN currency TEXT REFERENCES currency(code);

-- Backfill, first application only: days built before this were in the home's currency.
UPDATE site_day SET currency = (SELECT currency FROM site WHERE site.id = site_day.site_id)
  WHERE currency IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '004-tariff-ledger');

-- A home is billed in its market's currency (NL and FR in euros, GB in pounds). A NULL on
-- either side (a row written before it was known) is not judged.
CREATE TRIGGER IF NOT EXISTS site_currency_matches_market_insert
BEFORE INSERT ON site
WHEN NEW.market_code IS NOT NULL AND NEW.currency IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'home currency differs from its market currency')
  WHERE (SELECT currency FROM market WHERE code = NEW.market_code) <> NEW.currency;
END;

CREATE TRIGGER IF NOT EXISTS site_currency_matches_market_update
BEFORE UPDATE OF currency, market_code ON site
WHEN NEW.market_code IS NOT NULL AND NEW.currency IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'home currency differs from its market currency')
  WHERE (SELECT currency FROM market WHERE code = NEW.market_code) <> NEW.currency;
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('004-tariff-ledger', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
