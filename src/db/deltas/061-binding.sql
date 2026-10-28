-- Delta 061: bindings. A binding says which source fills a role for a home during a period, so the
-- slot builder asks for "the inverter's 5-minute samples" and is told the source, instead of
-- naming a vendor. A home without binding rows keeps the legacy sources (sunsynk_5min,
-- sunsynk_daily), so nothing moves until a row is added. Rows are append-only: a change
-- supersedes the old row and a build "as known at" a time reads the rows in force then.
--   role        inverter_5min (power and charge level samples), inverter_daily (daily totals)
--   valid_from, valid_to   UTC epoch seconds the source applies for; NULL = open
-- Same applying rules as 002-060.
CREATE TABLE IF NOT EXISTS binding (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES site(id),
  role          TEXT NOT NULL,
  source_id     INTEGER NOT NULL REFERENCES source(id),
  valid_from    INTEGER,
  valid_to      INTEGER,
  recorded_at   INTEGER NOT NULL,              -- ms
  superseded_at INTEGER,                       -- ms
  reason        TEXT
);
CREATE INDEX IF NOT EXISTS ix_binding_site_role ON binding(site_id, role);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('061-binding', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
