-- Delta 020: the attribute registry, per-key versioned attribute values for homes and devices, and
-- the device kind registry (B1, B3). Applied after the deltas before it by db.js, once (its name is
-- recorded in schema_delta). Same applying rules as 002-012: statements end with ';' at the end of
-- a line, a trigger ends with a line 'END;', an ADD COLUMN whose column exists is skipped, and
-- every other statement may be run again (CREATE ... IF NOT EXISTS; the backfill only fills NULLs).
-- The registry rows themselves are seeded by src/db/seed/attributes.js (only missing rows).
--
-- attribute_def: what a home or device may be described with (a planner's configuration: battery
--   rates and limits, curves, capabilities, heating physics), with unit, type and allowed range.
--   A new key is a new row, never a migration. src/core/attributes.js refuses a key that has no
--   row, a key that does not apply to the subject, and a value outside the row's rules.
-- attribute_value: every value of every key that is not one of the four the build reads (those stay
--   in site_attribute), for a home (site_id) or a device (device_id), one current row per source
--   (installer, measured, provider, estimated), versioned like facts and resolved by source rank.
--   Each value carries a provenance label (origin, src/core/provenance.js).
-- site_attribute.origin: the same label on the four build details; existing rows get the label
--   their source implies (installer: user, measured: derived, provider: provider, estimated:
--   placeholder).
-- device_kind: the kinds a device may have, passive or controllable, the attribute keys and the
--   action codes (names only) of each. A device of another kind is refused on INSERT or UPDATE once
--   the registry has rows. Existing devices are not judged.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS attribute_def (
  key             TEXT PRIMARY KEY CHECK (length(key) > 0),
  label           TEXT NOT NULL,
  unit            TEXT,
  value_type      TEXT NOT NULL CHECK (value_type IN ('number', 'integer', 'boolean', 'string', 'enum', 'json')),
  min_value       REAL,
  max_value       REAL,
  step            REAL CHECK (step IS NULL OR step > 0),
  allowed_values  TEXT CHECK (allowed_values IS NULL OR (json_valid(allowed_values) AND json_type(allowed_values) = 'array')),
  json_shape      TEXT,                                -- a structure check in src/core/value-check.js
  applies_to      TEXT NOT NULL DEFAULT '["site"]' CHECK (json_valid(applies_to) AND json_type(applies_to) = 'array'),
  origins         TEXT NOT NULL DEFAULT '["sourced","provider","user","derived","placeholder","synthetic"]' CHECK (json_valid(origins) AND json_type(origins) = 'array'),
  storage         TEXT NOT NULL DEFAULT 'attribute_value' CHECK (storage IN ('site_attribute', 'attribute_value')),
  site_column     TEXT CHECK (site_column IS NULL OR site_column IN ('pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh', 'lat', 'lon')),
  alias_of        TEXT REFERENCES attribute_def(key),
  unverified      INTEGER NOT NULL DEFAULT 0 CHECK (unverified IN (0, 1)),
  description     TEXT,
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CHECK (value_type <> 'enum' OR allowed_values IS NOT NULL),
  CHECK (storage <> 'site_attribute' OR key IN ('pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh'))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS attribute_value (
  id             INTEGER PRIMARY KEY,
  site_id        INTEGER REFERENCES site(id) ON DELETE CASCADE,
  device_id      INTEGER REFERENCES device(id) ON DELETE CASCADE,
  key            TEXT NOT NULL REFERENCES attribute_def(key),
  source         TEXT NOT NULL CHECK (source IN ('installer', 'measured', 'provider', 'estimated')),
  value          TEXT NOT NULL CHECK (json_valid(value)),   -- JSON: a number, true/false, text, object or list
  origin         TEXT NOT NULL CHECK (origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  note           TEXT,
  recorded_at    INTEGER NOT NULL,                          -- ms
  superseded_at  INTEGER,                                   -- ms; NULL = current
  CHECK ((site_id IS NULL) <> (device_id IS NULL)),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS attribute_value_current ON attribute_value (IFNULL(site_id, 0), IFNULL(device_id, 0), key, source) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS attribute_value_site ON attribute_value (site_id, key, recorded_at) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attribute_value_device ON attribute_value (device_id, key, recorded_at) WHERE device_id IS NOT NULL;

ALTER TABLE site_attribute ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));

UPDATE site_attribute SET origin = CASE source WHEN 'installer' THEN 'user' WHEN 'measured' THEN 'derived' WHEN 'provider' THEN 'provider' ELSE 'placeholder' END
  WHERE origin IS NULL;

CREATE TABLE IF NOT EXISTS device_kind (
  kind            TEXT PRIMARY KEY CHECK (length(kind) > 0),
  label           TEXT NOT NULL,
  class           TEXT NOT NULL CHECK (class IN ('passive', 'controllable')),
  attribute_keys  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attribute_keys) AND json_type(attribute_keys) = 'array'),
  action_codes    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(action_codes) AND json_type(action_codes) = 'array'),
  description     TEXT
) WITHOUT ROWID;

-- Stand-in for a foreign key device.kind -> device_kind.kind (adding one needs a table rebuild).
-- An empty registry (not seeded yet) refuses nothing.
CREATE TRIGGER IF NOT EXISTS device_kind_known_insert
BEFORE INSERT ON device
WHEN EXISTS (SELECT 1 FROM device_kind) AND NOT EXISTS (SELECT 1 FROM device_kind WHERE kind = NEW.kind)
BEGIN
  SELECT RAISE(ABORT, 'unknown device kind: not in device_kind (add a registry row to extend)');
END;

CREATE TRIGGER IF NOT EXISTS device_kind_known_update
BEFORE UPDATE OF kind ON device
WHEN EXISTS (SELECT 1 FROM device_kind) AND NOT EXISTS (SELECT 1 FROM device_kind WHERE kind = NEW.kind)
BEGIN
  SELECT RAISE(ABORT, 'unknown device kind: not in device_kind (add a registry row to extend)');
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('020-attribute-registry', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
