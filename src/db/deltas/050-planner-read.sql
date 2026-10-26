-- Delta 050: an index for "as known at" price reads (plan item B10, the planner read layer,
-- src/core/planner-read.js). Applied after 041 by db.js, once (its name is recorded in schema_delta).
-- Same applying rules as 002-041: statements end with ';' at the end of a line, and every statement
-- may be run again (CREATE ... IF NOT EXISTS only).
--
-- rate_register_asof: rate rows by tariff, component and register over EVERY version. rate_current
-- (schema.sql) holds only current rows (WHERE superseded_at IS NULL), so a read as known at an earlier
-- moment cannot use it: pricing.js learnIogWindow then scanned the whole rate_interval table (30 677
-- rows on the GB snapshot of 26 Oct 2026, 2.7 ms, growing with every price list kept, of every
-- tariff). With this index it searches the unit rows of the region's IOG tariffs (0.03 ms). Used by
-- the read layer's rates() with an asOf and by every as-of rebuild (build.js buildSite { asOf }).
-- An index changes no result: every rate read states its full ORDER BY (pricing.js rateTies).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS rate_register_asof ON rate_interval (tariff_id, component, register, valid_from);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('050-planner-read', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
