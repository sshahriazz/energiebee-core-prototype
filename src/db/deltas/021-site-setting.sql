-- Delta 021: planner tunables per home (B2). Applied after 020 by db.js, once (its name is recorded
-- in schema_delta). Same applying rules as 002-020: statements end with ';' at the end of a line,
-- and every statement may be run again (CREATE ... IF NOT EXISTS only). The registry rows are
-- seeded by src/db/seed/settings.js (only missing rows).
--
-- setting_def: every tunable a Predbat-style battery planner or a PredHeat-style heating planner is
--   run with (thresholds, losses, switches, schedules), with type, range and default. A new
--   tunable is a new row. src/core/settings.js refuses a key without a row and a value outside it.
-- site_setting: a home's own values, versioned like facts (a change supersedes the current row,
--   kept), each with its provenance label. "As known at T" reads the row in force at T, and the
--   default from setting_def when the home had not set the key.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS setting_def (
  key             TEXT PRIMARY KEY CHECK (length(key) > 0),
  label           TEXT NOT NULL,
  unit            TEXT,
  value_type      TEXT NOT NULL CHECK (value_type IN ('number', 'integer', 'boolean', 'string', 'enum', 'json')),
  default_value   TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(default_value)),   -- JSON; null = none
  min_value       REAL,
  max_value       REAL,
  step            REAL CHECK (step IS NULL OR step > 0),
  allowed_values  TEXT CHECK (allowed_values IS NULL OR (json_valid(allowed_values) AND json_type(allowed_values) = 'array')),
  json_shape      TEXT,
  planner         TEXT NOT NULL CHECK (planner IN ('predbat', 'predheat', 'any')),
  applies_to      TEXT NOT NULL,                   -- the part of the plan it tunes: battery, solar, load, car, iboost, heating ...
  unverified      INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0, 1)),
  description     TEXT,
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CHECK (value_type <> 'enum' OR allowed_values IS NOT NULL)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS site_setting (
  site_id        INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  key            TEXT NOT NULL REFERENCES setting_def(key),
  value          TEXT NOT NULL CHECK (json_valid(value)),
  origin         TEXT NOT NULL CHECK (origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  note           TEXT,
  recorded_at    INTEGER NOT NULL,                 -- ms
  superseded_at  INTEGER,                          -- ms; NULL = current
  PRIMARY KEY (site_id, key, recorded_at),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS site_setting_current ON site_setting (site_id, key) WHERE superseded_at IS NULL;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('021-site-setting', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
