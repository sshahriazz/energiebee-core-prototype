-- Delta 011: tounify v3 adapter (src/adapters/tounify.js). Applied after 010 by db.js, once. Same applying rules as 002-010: statements end with ';' at the end of a line, an ADD COLUMN
-- whose column exists is skipped, and every other statement may be run again (the registry switch
-- below is guarded by schema_delta: first application only).
--
-- tariff.taxes_in_price (0/1, default 0): 1 = the tariff's prices and fixed charges already hold
-- the per-kWh levies and the per-period credits (tounify's `fees` and its `credit` components), so
-- pricing applies only the PERCENT tax rules (VAT) on top and leaves out every per_kwh and
-- per_period rule of the country (src/core/pricing.js taxesAt). 0 = as before: every tax rule.
-- Every existing tariff gets 0, so no existing price changes.
--
-- The market provider rows of tounify (seed/providers.js) become 'enabled = 1, licence_confirmed
-- = 0': the adapter is built, but its storage and reuse licence is not confirmed, so the plan
-- still skips it ('unlicensed: ...') unless TOUNIFY_DEV=1 with a test token. The seed never flips
-- enabled on a row that exists, so the FR and NL placeholder rows an older seed inserted with
-- enabled = 0 are switched on here, once, and only while they still carry the old 'adapter not
-- built' note (an operator's later switch-off is kept: this never runs again).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE tariff ADD COLUMN taxes_in_price INTEGER NOT NULL DEFAULT 0 CHECK (taxes_in_price IN (0, 1));

UPDATE market_provider SET enabled = 1
  WHERE adapter = 'tounify' AND enabled = 0 AND note LIKE 'adapter not built%'
    AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '011-tounify');

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('011-tounify', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
