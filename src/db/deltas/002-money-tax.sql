-- Delta 002: money and tax. Applied on top of schema.sql by db.js, once (recorded in schema_delta;
-- applied again only if an object it creates is missing).
--
-- Applying it: statements end with ';' at the end of a line; a CREATE TRIGGER ends with a line
-- 'END;'. SQLite has no ADD COLUMN IF NOT EXISTS, so the applier skips an
-- 'ALTER TABLE <t> ADD COLUMN <c>' whose column is already there (the rule db.js already follows
-- for its own added columns). Every other statement is safe to run again: IF NOT EXISTS,
-- INSERT OR IGNORE, or a backfill guarded by schema_delta so it runs on the first application only.
--
-- Amounts are in MINOR units (pence, cents) of a stated currency, as REAL. There is no FX: a
-- tariff in one currency is never agreed for a home in another (triggers below).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── Currency ─────────────

CREATE TABLE IF NOT EXISTS currency (
  code            TEXT PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),   -- ISO 4217
  minor_exponent  INTEGER NOT NULL CHECK (minor_exponent BETWEEN 0 AND 3),            -- 2: pence, cents
  symbol          TEXT
) WITHOUT ROWID;
INSERT OR IGNORE INTO currency (code, minor_exponent, symbol) VALUES ('GBP', 2, '£'), ('EUR', 2, '€');

-- The currency a home is billed in and a tariff is priced in. Writers must set both for new rows.
ALTER TABLE site ADD COLUMN currency TEXT REFERENCES currency(code);
ALTER TABLE tariff ADD COLUMN currency TEXT REFERENCES currency(code);

-- Backfill, first application only: every home and tariff so far is British, priced in pounds.
UPDATE site SET currency = 'GBP' WHERE currency IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '002-money-tax');
UPDATE tariff SET currency = 'GBP' WHERE currency IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '002-money-tax');

-- No mixed currencies: a tariff agreement needs the tariff's currency to be the home's. A NULL on
-- either side (a row written before its currency was known) is not judged.
CREATE TRIGGER IF NOT EXISTS agreement_same_currency_insert
BEFORE INSERT ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE (SELECT currency FROM tariff WHERE id = NEW.tariff_id) <> (SELECT currency FROM site WHERE id = NEW.site_id);
END;

CREATE TRIGGER IF NOT EXISTS agreement_same_currency_update
BEFORE UPDATE OF site_id, tariff_id ON tariff_agreement
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE (SELECT currency FROM tariff WHERE id = NEW.tariff_id) <> (SELECT currency FROM site WHERE id = NEW.site_id);
END;

CREATE TRIGGER IF NOT EXISTS site_currency_matches_agreements
BEFORE UPDATE OF currency ON site
WHEN NEW.currency IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE EXISTS (SELECT 1 FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id
                WHERE a.site_id = NEW.id AND t.currency <> NEW.currency);
END;

CREATE TRIGGER IF NOT EXISTS tariff_currency_matches_agreements
BEFORE UPDATE OF currency ON tariff
WHEN NEW.currency IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tariff currency differs from the home currency')
  WHERE EXISTS (SELECT 1 FROM tariff_agreement a JOIN site s ON s.id = a.site_id
                WHERE a.tariff_id = NEW.id AND s.currency <> NEW.currency);
END;

-- ───────────── Taxes and levies ─────────────
-- Takes over from vat_rate (left in place for now; pricing.js still reads it). Applied in seq
-- order by src/core/tax.js applyTaxes: a percent applies to the price plus every tax with a lower
-- seq (energy tax, then VAT on top); rules with the same seq share one base.
--   percent     value = fraction (0.05 = 5 %); no currency
--   per_kwh     value = minor units of currency per kWh; on the unit charge
--   per_period  value = minor units of currency per charge_period (day, month, year), signed
--               (a yearly credit is negative); pro-rated by slot over the local period length
CREATE TABLE IF NOT EXISTS tax_rule (
  id              INTEGER PRIMARY KEY,
  country         TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  code            TEXT NOT NULL,                     -- vat | btw | tva | energiebelasting | heffingskorting | accise
  fuel            TEXT NOT NULL CHECK (fuel IN ('electricity', 'gas')),
  direction       TEXT NOT NULL CHECK (direction IN ('import', 'export')),
  customer_class  TEXT NOT NULL DEFAULT 'domestic',
  applies_to      TEXT NOT NULL CHECK (applies_to IN ('unit', 'fixed', 'all')),
  kind            TEXT NOT NULL CHECK (kind IN ('percent', 'per_kwh', 'per_period')),
  value           REAL NOT NULL,
  currency        TEXT REFERENCES currency(code),
  charge_period   TEXT CHECK (charge_period IN ('day', 'month', 'year')),
  seq             INTEGER NOT NULL DEFAULT 0,
  valid_from      INTEGER NOT NULL,                  -- s, inclusive
  valid_to        INTEGER,                           -- s, exclusive; NULL = open-ended
  source          TEXT NOT NULL,                     -- where the value comes from (official table)
  unverified      INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0, 1)),   -- 1 = placeholder, not to be relied on
  recorded_at     INTEGER NOT NULL,                  -- ms
  superseded_at   INTEGER,                           -- ms; NULL = current
  CHECK ((kind = 'percent') = (currency IS NULL)),
  CHECK ((kind = 'per_period') = (charge_period IS NOT NULL)),
  CHECK (kind <> 'percent' OR (value >= 0 AND value <= 1)),
  CHECK (kind <> 'per_kwh' OR applies_to = 'unit'),
  CHECK (kind <> 'per_period' OR applies_to = 'fixed'),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS tax_rule_lookup ON tax_rule (country, fuel, direction, valid_from) WHERE superseded_at IS NULL;

-- The same tax may not be charged twice on the same charge at the same moment ('all' overlaps
-- both 'unit' and 'fixed'). Consumption bands (NL energiebelasting) would need a band column first.
CREATE TRIGGER IF NOT EXISTS tax_rule_no_overlap
BEFORE INSERT ON tax_rule
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current tax rule')
  WHERE EXISTS (
    SELECT 1 FROM tax_rule t
    WHERE t.superseded_at IS NULL
      AND t.country = NEW.country AND t.code = NEW.code AND t.fuel = NEW.fuel
      AND t.direction = NEW.direction AND t.customer_class = NEW.customer_class
      AND (t.applies_to = NEW.applies_to OR t.applies_to = 'all' OR NEW.applies_to = 'all')
      AND t.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(t.valid_to, 9000000000) > NEW.valid_from
  );
END;

-- GB VAT, copied from vat_rate while tax_rule has no GB VAT (so a database whose vat_rate is
-- seeded only after this delta still gets it on the next application). recorded_at 0: vat_rate
-- kept no recorded time, so the rates count as known for every replay, as they were before.
INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period,
                      seq, valid_from, valid_to, source, unverified, recorded_at)
  SELECT 'GB', 'vat', v.fuel, v.direction, 'domestic', 'all', 'percent', v.rate, NULL, NULL,
         100, v.valid_from, v.valid_to, 'vat_rate (registry.js VAT_RATES)', 0, 0
  FROM vat_rate v
  WHERE NOT EXISTS (SELECT 1 FROM tax_rule WHERE country = 'GB' AND code = 'vat')
  ORDER BY v.fuel, v.direction, v.valid_from;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('002-money-tax', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
