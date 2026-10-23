-- Delta 005: provenance. Applied after 004 by db.js on every open. Same applying rules as 002-004:
-- statements end with ';' at the end of a line, a trigger ends with 'END;', an ADD COLUMN whose
-- column exists is skipped, and every other statement may be run again.
--
-- Every reference or price row says where its value came from, in one vocabulary
-- (src/core/provenance.js ORIGINS), strongest first:
--   sourced      taken from a named, checkable source (origin_note names it)
--   provider     live data fetched from a provider for a real home (Octopus, Sunsynk)
--   user         typed in by the user or installer
--   derived      computed by us (a computed figure carries its weakest input's label instead)
--   placeholder  a stand-in from memory or an assumption, NOT verified against an official source
--   synthetic    generated test or demo data
-- NULL means "not recorded" (rows written before this delta and not backfilled) and is read as a
-- placeholder. site.is_demo stays the flag of a generated home.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE tax_rule ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE tax_rule ADD COLUMN origin_note TEXT;
ALTER TABLE tariff ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE tariff ADD COLUMN origin_note TEXT;
ALTER TABLE rate_interval ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE rate_interval ADD COLUMN origin_note TEXT;
ALTER TABLE market ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE market ADD COLUMN origin_note TEXT;
ALTER TABLE region ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'));
ALTER TABLE region ADD COLUMN origin_note TEXT;

-- ───────────── Backfill ─────────────
-- Tax rules, on every application (only rows with no label): GB VAT is the registry's table; a rule
-- marked unverified is a placeholder. The same notes as src/core/tax.js and db.js syncGbVat.
UPDATE tax_rule SET origin = 'sourced', origin_note = 'src/db/registry.js VAT_RATES: GB domestic VAT 5 % (HMRC reduced rate for domestic fuel); electricity 0 % from 1 Oct 2026 as observed in Octopus published prices on 16 Oct 2026'
  WHERE origin IS NULL AND country = 'GB' AND code = 'vat' AND unverified = 0;
UPDATE tax_rule SET origin = 'placeholder', origin_note = source WHERE origin IS NULL AND unverified = 1;

-- Tariffs and their rate rows, first application only: until now only the Octopus adapter wrote
-- tariffs for a real home; core code wrote only the generated SYN-/TEST- tariffs of the demo and
-- tests. Rate rows follow their tariff.
UPDATE tariff SET origin = CASE WHEN tariff_code LIKE 'SYN-%' OR tariff_code LIKE 'TEST-%' THEN 'synthetic' ELSE 'provider' END,
    origin_note = CASE WHEN tariff_code LIKE 'SYN-%' OR tariff_code LIKE 'TEST-%' THEN NULL ELSE 'Octopus public API (products and tariff rates)' END
  WHERE origin IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '005-provenance');
UPDATE rate_interval SET origin = (SELECT t.origin FROM tariff t WHERE t.id = rate_interval.tariff_id)
  WHERE origin IS NULL AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '005-provenance');

-- Reference rows the deltas inserted themselves (seed/markets.js and seed/regions-gb.js label every
-- row they write, with these same notes).
UPDATE market SET origin = 'sourced', origin_note = 'GB half-hourly settlement period, Europe/London clock and GBP (Elexon BSC); the same 30-minute grid as the Octopus rate and meter intervals'
  WHERE origin IS NULL AND code = 'GB';
UPDATE region SET origin = 'sourced', origin_note = 'MPAN distributor ids 10-23 with Octopus GSP letters (eb-auth src/lib/grid-supply-point.ts) and Tariffscanner names and ids (eb-auth tariffscan.regions.ts, probe-v1 fixtures)'
  WHERE origin IS NULL AND scheme = 'gb_dno';

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('005-provenance', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
