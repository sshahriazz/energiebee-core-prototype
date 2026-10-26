-- Delta 022: "as known at" for the home and tariff settings that change results (H5 in
-- docs/database-review.md). Applied after 021 by db.js, once (its name is recorded in schema_delta).
-- Same applying rules as 002-021: statements end with ';' at the end of a line, a trigger ends with
-- a line 'END;', and every statement may be run again (CREATE ... IF NOT EXISTS; the backfills
-- insert only for homes and tariffs that have no version yet).
--
-- These columns used to be overwritten in place (a Sunsynk sync rewrites site.timezone, a new slot
-- length or contracted capacity is a plain UPDATE, a tariff catalogue sweep rewrites a tariff's
-- structure, kind, currency or default register), so a day rebuilt "as known at" an earlier moment
-- used today's values. Now every change is kept:
--   site_version    the columns of `site` the build and pricing read: zone, slot length, currency,
--                   market, country, regions, location, system sizes, contracted capacity, demo flag
--   tariff_version  the columns of `tariff` that change a price: structure, region, kind, currency,
--                   country, native period, taxes_in_price, default register, fuel, direction, origin
-- One row per version (recorded_at, superseded_at in ms, like site_attribute). The `site` and
-- `tariff` rows stay the current values, so every everyday read is unchanged.
--
-- Written by TRIGGERS, so every writer is covered (sites.js, sunsynk.js, tariffscanner.js,
-- tounify.js, tariffs.js, an operator's UPDATE): a new home or tariff gets its first version, and an
-- UPDATE that really changes one of these columns closes the current version and opens a new one.
-- An UPDATE that writes the same values (a Sunsynk sync with an unchanged zone) writes nothing.
-- Version times move forward: never before the previous version (+1 ms), so two changes in one
-- millisecond still get distinct keys. A home's first version is stamped with site.created_at.
--
-- Backfill (first application): one version per existing home at the time it was created
-- (created_at), and one per existing tariff at the time it was first known (its first rate row or
-- agreement recorded, else now), with today's values: earlier values were not kept and cannot be
-- recovered. Before a row's first version, readers use that first version and say so
-- (src/core/versions.js siteAt, tariffAt).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS site_version (
  site_id                INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  recorded_at            INTEGER NOT NULL,     -- ms
  superseded_at          INTEGER,              -- ms; NULL = current
  timezone               TEXT,
  slot_s                 INTEGER,
  currency               TEXT,
  market_code            TEXT,
  country                TEXT,
  gsp_region             TEXT,
  carbon_region          INTEGER,
  lat                    REAL,
  lon                    REAL,
  pv_kwp                 REAL,
  pv_tilt                REAL,
  pv_orientation         REAL,
  battery_kwh            REAL,
  contracted_kva         REAL,
  contracted_kva_origin  TEXT,
  contracted_kva_note    TEXT,
  is_demo                INTEGER,
  PRIMARY KEY (site_id, recorded_at),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS site_version_current ON site_version (site_id) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS tariff_version (
  tariff_id         INTEGER NOT NULL REFERENCES tariff(id) ON DELETE CASCADE,
  recorded_at       INTEGER NOT NULL,          -- ms
  superseded_at     INTEGER,                   -- ms; NULL = current
  structure         TEXT,
  region            TEXT,
  kind              TEXT,
  currency          TEXT,
  country           TEXT,
  native_period_s   INTEGER,
  taxes_in_price    INTEGER,
  default_register  TEXT,
  fuel              TEXT,
  direction         TEXT,
  origin            TEXT,
  PRIMARY KEY (tariff_id, recorded_at),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS tariff_version_current ON tariff_version (tariff_id) WHERE superseded_at IS NULL;

-- Backfill: homes, at their creation.
INSERT INTO site_version (site_id, recorded_at, timezone, slot_s, currency, market_code, country, gsp_region, carbon_region, lat, lon,
    pv_kwp, pv_tilt, pv_orientation, battery_kwh, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo)
  SELECT id, created_at * 1000, timezone, slot_s, currency, market_code, country, gsp_region, carbon_region, lat, lon,
    pv_kwp, pv_tilt, pv_orientation, battery_kwh, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo
  FROM site WHERE NOT EXISTS (SELECT 1 FROM site_version v WHERE v.site_id = site.id);

-- Backfill: tariffs, when first known (first rate row or agreement recorded), else now.
INSERT INTO tariff_version (tariff_id, recorded_at, structure, region, kind, currency, country, native_period_s, taxes_in_price, default_register, fuel, direction, origin)
  SELECT t.id, IFNULL(k.first, CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)), t.structure, t.region, t.kind, t.currency, t.country,
    t.native_period_s, t.taxes_in_price, t.default_register, t.fuel, t.direction, t.origin
  FROM tariff t LEFT JOIN (SELECT tariff_id, MIN(recorded_at) AS first FROM (
      SELECT tariff_id, recorded_at FROM rate_interval UNION ALL SELECT tariff_id, recorded_at FROM tariff_agreement WHERE recorded_at IS NOT NULL)
    GROUP BY tariff_id) k ON k.tariff_id = t.id
  WHERE NOT EXISTS (SELECT 1 FROM tariff_version v WHERE v.tariff_id = t.id);

CREATE TRIGGER IF NOT EXISTS site_version_on_insert
AFTER INSERT ON site
BEGIN
  UPDATE site_version SET superseded_at = MAX(NEW.created_at * 1000, (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM site_version WHERE site_id = NEW.id))
    WHERE site_id = NEW.id AND superseded_at IS NULL;
  INSERT INTO site_version (site_id, recorded_at, timezone, slot_s, currency, market_code, country, gsp_region, carbon_region, lat, lon,
      pv_kwp, pv_tilt, pv_orientation, battery_kwh, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo)
    VALUES (NEW.id, MAX(NEW.created_at * 1000, (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM site_version WHERE site_id = NEW.id)),
      NEW.timezone, NEW.slot_s, NEW.currency, NEW.market_code, NEW.country, NEW.gsp_region, NEW.carbon_region, NEW.lat, NEW.lon,
      NEW.pv_kwp, NEW.pv_tilt, NEW.pv_orientation, NEW.battery_kwh, NEW.contracted_kva, NEW.contracted_kva_origin, NEW.contracted_kva_note, NEW.is_demo);
END;

CREATE TRIGGER IF NOT EXISTS site_version_on_update
AFTER UPDATE OF timezone, slot_s, currency, market_code, country, gsp_region, carbon_region, lat, lon, pv_kwp, pv_tilt, pv_orientation, battery_kwh,
  contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo ON site
WHEN OLD.timezone IS NOT NEW.timezone OR OLD.slot_s IS NOT NEW.slot_s OR OLD.currency IS NOT NEW.currency OR OLD.market_code IS NOT NEW.market_code
  OR OLD.country IS NOT NEW.country OR OLD.gsp_region IS NOT NEW.gsp_region OR OLD.carbon_region IS NOT NEW.carbon_region
  OR OLD.lat IS NOT NEW.lat OR OLD.lon IS NOT NEW.lon OR OLD.pv_kwp IS NOT NEW.pv_kwp OR OLD.pv_tilt IS NOT NEW.pv_tilt
  OR OLD.pv_orientation IS NOT NEW.pv_orientation OR OLD.battery_kwh IS NOT NEW.battery_kwh OR OLD.contracted_kva IS NOT NEW.contracted_kva
  OR OLD.contracted_kva_origin IS NOT NEW.contracted_kva_origin OR OLD.contracted_kva_note IS NOT NEW.contracted_kva_note OR OLD.is_demo IS NOT NEW.is_demo
BEGIN
  UPDATE site_version SET superseded_at = MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
      (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM site_version WHERE site_id = NEW.id))
    WHERE site_id = NEW.id AND superseded_at IS NULL;
  INSERT INTO site_version (site_id, recorded_at, timezone, slot_s, currency, market_code, country, gsp_region, carbon_region, lat, lon,
      pv_kwp, pv_tilt, pv_orientation, battery_kwh, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo)
    VALUES (NEW.id, MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER), (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM site_version WHERE site_id = NEW.id)),
      NEW.timezone, NEW.slot_s, NEW.currency, NEW.market_code, NEW.country, NEW.gsp_region, NEW.carbon_region, NEW.lat, NEW.lon,
      NEW.pv_kwp, NEW.pv_tilt, NEW.pv_orientation, NEW.battery_kwh, NEW.contracted_kva, NEW.contracted_kva_origin, NEW.contracted_kva_note, NEW.is_demo);
END;

CREATE TRIGGER IF NOT EXISTS tariff_version_on_insert
AFTER INSERT ON tariff
BEGIN
  UPDATE tariff_version SET superseded_at = MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
      (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM tariff_version WHERE tariff_id = NEW.id))
    WHERE tariff_id = NEW.id AND superseded_at IS NULL;
  INSERT INTO tariff_version (tariff_id, recorded_at, structure, region, kind, currency, country, native_period_s, taxes_in_price, default_register, fuel, direction, origin)
    VALUES (NEW.id, MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER), (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM tariff_version WHERE tariff_id = NEW.id)),
      NEW.structure, NEW.region, NEW.kind, NEW.currency, NEW.country, NEW.native_period_s, NEW.taxes_in_price, NEW.default_register, NEW.fuel, NEW.direction, NEW.origin);
END;

CREATE TRIGGER IF NOT EXISTS tariff_version_on_update
AFTER UPDATE OF structure, region, kind, currency, country, native_period_s, taxes_in_price, default_register, fuel, direction, origin ON tariff
WHEN OLD.structure IS NOT NEW.structure OR OLD.region IS NOT NEW.region OR OLD.kind IS NOT NEW.kind OR OLD.currency IS NOT NEW.currency
  OR OLD.country IS NOT NEW.country OR OLD.native_period_s IS NOT NEW.native_period_s OR OLD.taxes_in_price IS NOT NEW.taxes_in_price
  OR OLD.default_register IS NOT NEW.default_register OR OLD.fuel IS NOT NEW.fuel OR OLD.direction IS NOT NEW.direction OR OLD.origin IS NOT NEW.origin
BEGIN
  UPDATE tariff_version SET superseded_at = MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
      (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM tariff_version WHERE tariff_id = NEW.id))
    WHERE tariff_id = NEW.id AND superseded_at IS NULL;
  INSERT INTO tariff_version (tariff_id, recorded_at, structure, region, kind, currency, country, native_period_s, taxes_in_price, default_register, fuel, direction, origin)
    VALUES (NEW.id, MAX(CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER), (SELECT IFNULL(MAX(recorded_at), 0) + 1 FROM tariff_version WHERE tariff_id = NEW.id)),
      NEW.structure, NEW.region, NEW.kind, NEW.currency, NEW.country, NEW.native_period_s, NEW.taxes_in_price, NEW.default_register, NEW.fuel, NEW.direction, NEW.origin);
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('022-site-version', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
