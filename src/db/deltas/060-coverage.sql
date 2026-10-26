-- Delta 060: the schema elements the coverage matrix (docs/coverage-matrix.json, plan item B11) found
-- missing and that registry rows cannot hold. Everything else it found missing was added as registry
-- rows (attribute_def, setting_def: src/db/seed/*.js; metric, source: src/db/registry.js). TABLES AND
-- COLUMNS ONLY: nothing writes them yet, and the build engine never reads them (site_hh and site_day are
-- not touched, so the GB timeline cannot move). Applied after 050 by db.js, once (its name is recorded
-- in schema_delta). Same applying rules as 002-050: statements end with ';' at the end of a line, an
-- ADD COLUMN whose column exists is skipped, and every other statement may be run again.
--
-- PostgreSQL port: as 030 (the CHECKs port as they are; tenant_site keeps site_id as its key).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── plan_slot: the prices a plan used (PB-RATE-40, 41; PB-PV-23; PB-CAR-29) ─────────────
-- Predbat's plan shows per slot the import and export price it planned with, where each came from, the
-- price after losses and battery cycle cost, and the solar it expects to clip. In minor units of
-- plan_run.currency per kWh, including tax (as the read layer's rates()). On a car charger's row the
-- import price is the price its energy is charged at (Predbat car_rate).
--   *_rate_adjust   how the price differs from the published one: future_offset (an offset added to a
--                   price not yet published), future_estimate (an estimated price), override (= a set
--                   price), increment (+/- a shift), event (a saving session or VPP event), previous_day
--                   (yesterday's price copied); NULL = the published price
ALTER TABLE plan_slot ADD COLUMN import_rate_minor REAL;
ALTER TABLE plan_slot ADD COLUMN export_rate_minor REAL;
ALTER TABLE plan_slot ADD COLUMN import_rate_adjusted_minor REAL;
ALTER TABLE plan_slot ADD COLUMN export_rate_adjusted_minor REAL;
ALTER TABLE plan_slot ADD COLUMN import_rate_adjust TEXT CHECK (import_rate_adjust IS NULL OR import_rate_adjust IN ('future_offset', 'future_estimate', 'override', 'increment', 'event', 'previous_day'));
ALTER TABLE plan_slot ADD COLUMN export_rate_adjust TEXT CHECK (export_rate_adjust IS NULL OR export_rate_adjust IN ('future_offset', 'future_estimate', 'override', 'increment', 'event', 'previous_day'));
ALTER TABLE plan_slot ADD COLUMN clipped_kwh REAL CHECK (clipped_kwh IS NULL OR clipped_kwh >= 0);

-- ───────────── tenant: who a home belongs to (planning design PD-01, catalogue Appendix A) ─────────────
-- An owner record only: no login, no access rules and no erasure path here (those are Phase C of
-- docs/hardening-and-planning-plan.md). A home belongs to at most one tenant (tenant_site keyed by site).
--   plan_tier   the service level the tenant pays for (free text: the planning design names no values)
CREATE TABLE IF NOT EXISTS tenant (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) > 0),
  name        TEXT NOT NULL,
  plan_tier   TEXT,
  created_at  INTEGER NOT NULL                 -- ms
);

CREATE TABLE IF NOT EXISTS tenant_site (
  site_id      INTEGER PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  tenant_id    INTEGER NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  recorded_at  INTEGER NOT NULL                -- ms
);
CREATE INDEX IF NOT EXISTS tenant_site_tenant ON tenant_site (tenant_id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('060-coverage', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
