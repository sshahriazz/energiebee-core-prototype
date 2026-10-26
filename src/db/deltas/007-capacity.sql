-- Delta 007: contracted capacity. Applied after 006 by db.js, once. Same applying rules as
-- 002-006: statements end with ';' at the end of a line, an ADD COLUMN whose column exists is
-- skipped, and every other statement may be run again.
--
-- rate_interval rows with component 'capacity' are priced per kW (or kVA, as the tariff states)
-- of the home's contracted capacity per charge_period (day, month or year): a French
-- "puissance souscrite" in kVA, a Belgian or Dutch capacity-based fee. The charge of a slot is
-- price x contracted_kva, pro-rated by real seconds over the local day, month or year, like any
-- other fixed charge. Without a contracted capacity the charge is not priced, and the build says so.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE site ADD COLUMN contracted_kva REAL CHECK (contracted_kva IS NULL OR contracted_kva > 0);
ALTER TABLE site ADD COLUMN contracted_kva_origin TEXT CHECK (contracted_kva_origin IS NULL OR contracted_kva_origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE site ADD COLUMN contracted_kva_note TEXT;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('007-capacity', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
