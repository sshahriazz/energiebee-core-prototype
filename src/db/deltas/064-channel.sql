-- Delta 064: channels. A channel maps one point of a vendor's feed to one canonical metric of a home:
-- how to turn the vendor's number into the canonical unit and sign (value x scale + shift), which
-- part of a signed point it carries, and the range a believable value stays within. A vendor that
-- reports kW, or one signed grid figure, is then a set of rows, not a processor with its own
-- conversions; ingestObservations (src/core/channels.js) applies them to every vendor the same way.
--   point      the vendor's own name for the measurement
--   metric_id  the canonical metric it becomes (metric.unit is the unit the result is in)
--   part       all (the value as is), positive (only values above 0), negative (only values below 0, as a magnitude)
--   min_value, max_value   canonical range; a value outside it is rejected (kept in channel_reject), never written
-- Rows are append-only: a change supersedes the row, and facts already written keep the conversion they were written with.
-- Same applying rules as 002-063.
CREATE TABLE IF NOT EXISTS channel (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES site(id),
  source_id     INTEGER NOT NULL REFERENCES source(id),
  point         TEXT NOT NULL,
  metric_id     INTEGER NOT NULL REFERENCES metric(id),
  scale         REAL NOT NULL DEFAULT 1,
  shift         REAL NOT NULL DEFAULT 0,
  part          TEXT NOT NULL DEFAULT 'all' CHECK (part IN ('all', 'positive', 'negative')),
  min_value     REAL,
  max_value     REAL,
  recorded_at   INTEGER NOT NULL,              -- ms
  superseded_at INTEGER                        -- ms
);
CREATE INDEX IF NOT EXISTS ix_channel_site_source ON channel(site_id, source_id, point);

CREATE TABLE IF NOT EXISTS channel_reject (
  id          INTEGER PRIMARY KEY,
  site_id     INTEGER NOT NULL,
  source_id   INTEGER NOT NULL,
  point       TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  value       REAL,
  reason      TEXT NOT NULL,                  -- out_of_range | not_a_number | unmapped_point
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_channel_reject_site ON channel_reject(site_id, recorded_at);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('064-channel', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
