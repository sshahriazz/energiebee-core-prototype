-- Delta 080: a home picks its own supplier and tariff (src/core/tariff-picker.js), whatever source lists them.
-- Applied after 079 by db.js, once. Same applying rules as 002-079: statements end with ';' at the end of a
-- line, an ADD COLUMN whose column exists is skipped, and every other statement may be run again.
--
-- One shape for every catalogue source (Tariffscanner in GB, tounify in FR / NL, the next country's source):
--   supplier                  one energy supplier of one country, under our own code ('ovo', 'edf')
--   supplier_alias            how each source names it (Tariffscanner 'OVO Energy', tounify 'EDF'), so two
--                             sources naming one supplier meet on one row
--   tariff.supplier_id        the supplier a tariff belongs to (NULL: not known, e.g. an Octopus account tariff
--                             written before this delta)
--   tariff_agreement.payment_method
--                             how the home pays (DDM, PRE, CAC ...). Some sources publish one price per payment
--                             method; with it the build prices the home's own, instead of leaving a half-hour
--                             unpriced where the methods disagree. NULL: not stated (account tariffs).
--   market_question           what onboarding asks the user, per market and per kind of tariff, as rows: a new
--                             country adds rows, not code. when_kind: '*' every tariff, 'two_rate' a tariff with
--                             a day and a cheaper night / off-peak price.
-- A home's own day / night switch times (Economy 7) are register_window rows with device_id set (a meter's own
-- window, already in the schema): the build prices an e7 tariff from them.

CREATE TABLE IF NOT EXISTS supplier (
  id           INTEGER PRIMARY KEY,
  country      TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  code         TEXT NOT NULL CHECK (length(code) > 0),
  name         TEXT NOT NULL CHECK (length(name) > 0),
  recorded_at  INTEGER NOT NULL,
  UNIQUE (country, code)
);

CREATE TABLE IF NOT EXISTS supplier_alias (
  supplier_id  INTEGER NOT NULL REFERENCES supplier(id),
  provider     TEXT NOT NULL,
  country      TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  external_id  TEXT NOT NULL,
  PRIMARY KEY (provider, country, external_id)
) WITHOUT ROWID;

ALTER TABLE tariff ADD COLUMN supplier_id INTEGER REFERENCES supplier(id);
CREATE INDEX IF NOT EXISTS tariff_supplier ON tariff (supplier_id, region);

ALTER TABLE tariff_agreement ADD COLUMN payment_method TEXT;

CREATE TABLE IF NOT EXISTS market_question (
  market_code  TEXT NOT NULL CHECK (market_code = '*' OR (length(market_code) = 2 AND market_code = upper(market_code))),
  when_kind    TEXT NOT NULL DEFAULT '*' CHECK (when_kind IN ('*', 'two_rate')),
  field        TEXT NOT NULL,
  label        TEXT NOT NULL,
  help         TEXT,
  input        TEXT NOT NULL CHECK (input IN ('hours', 'select', 'number')),
  allowed      TEXT,
  required     INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  seq          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market_code, when_kind, field)
) WITHOUT ROWID;

INSERT OR IGNORE INTO market_question (market_code, when_kind, field, label, help, input, allowed, required, seq) VALUES
  ('GB', 'two_rate', 'off_peak_hours', 'When is your cheap night rate?', 'On your bill or your meter. We filled in your supplier''s usual hours.', 'hours', NULL, 1, 10),
  ('FR', '*', 'contracted_kva', 'Subscribed power (kVA)', 'On your bill: "puissance souscrite".', 'select', '[3,6,9,12,15,18,24,30,36]', 1, 10),
  ('FR', 'two_rate', 'off_peak_hours', 'Off-peak hours (heures creuses)', 'Exactly 8 hours a day, on your bill.', 'hours', NULL, 0, 20),
  ('NL', '*', 'fuse', 'Connection size', 'On your meter or bill, for example 3x25A.', 'select', '["1x25A","1x35A","1x40A","3x25A","3x35A","3x40A","3x50A","3x63A","3x80A"]', 1, 10);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('080-tariff-choice', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
