-- Delta 024: the site and tariff columns that delta 022 (site_version, tariff_version) copies, for
-- databases created by an early schema that never had them. Listed in db.js BEFORE 022, so 022 can
-- read them on such a database. Same applying rules as 002-023: statements end with ';' at the
-- end of a line, and an ADD COLUMN whose column exists is skipped, so on every database created
-- by the current schema.sql (and on any where 022 already ran) this delta changes nothing.
-- The columns are as in schema.sql, without the NOT NULL / CHECK rules a column added to existing
-- rows cannot take (fuel, direction); a historic home is in Europe/London, as db.js assumes.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE site ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/London';
ALTER TABLE site ADD COLUMN gsp_region TEXT;
ALTER TABLE site ADD COLUMN carbon_region INTEGER;
ALTER TABLE site ADD COLUMN lat REAL;
ALTER TABLE site ADD COLUMN lon REAL;
ALTER TABLE site ADD COLUMN pv_kwp REAL;
ALTER TABLE site ADD COLUMN pv_tilt REAL;
ALTER TABLE site ADD COLUMN pv_orientation REAL;
ALTER TABLE site ADD COLUMN battery_kwh REAL;
ALTER TABLE site ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tariff ADD COLUMN region TEXT;
ALTER TABLE tariff ADD COLUMN fuel TEXT CHECK (fuel IS NULL OR fuel IN ('electricity', 'gas'));
ALTER TABLE tariff ADD COLUMN direction TEXT CHECK (direction IS NULL OR direction IN ('import', 'export'));

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('024-site-tariff-columns', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
