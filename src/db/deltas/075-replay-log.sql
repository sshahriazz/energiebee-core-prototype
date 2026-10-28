-- Delta 075: replay_log, one row per replay of stored raw receipts (core/replay.js): after a channel mapping is fixed, the
-- receipts a source delivered are read again through its parser and the channels so values that were refused or unmapped are
-- recovered. A log for the Providers screen and for audit, not a fact table: the recovered facts carry the raw receipt they came
-- from (raw_id), exactly as the first time. Only real runs are logged; a dry run keeps nothing.
--   receipts     raw receipts read      observations  points they held after parsing
--   written      facts written (readings, periods, derived counter energy; change-only, so a second run writes 0)
--   forecasts    forecast issues written    rejected  values the channels still refuse    unmapped  points still nobody maps
--   parse_errors receipts that could not be read or parsed (kept, never replayed into facts)
-- Same applying rules as 002-073.
CREATE TABLE IF NOT EXISTS replay_log (
  id           INTEGER PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES site(id),
  source       TEXT,                                   -- NULL = every replayable source
  started_at   INTEGER NOT NULL,                       -- ms
  days         INTEGER,                                -- the look-back window asked for
  receipts     INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  written      INTEGER NOT NULL DEFAULT 0,
  forecasts    INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  unmapped     INTEGER NOT NULL DEFAULT 0,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS ix_replay_log_site ON replay_log(site_id, started_at DESC);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('075-replay-log', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
