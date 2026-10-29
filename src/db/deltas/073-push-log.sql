-- Delta 073: push_log, one row per body received by POST /api/ingest (core/push-ingest.js): what arrived, what the core did with
-- it, and why it was refused when it was. It is a log for the Devices page and for debugging, not a fact table: the facts are
-- in reading and interval_fact, the body itself is the raw receipt (raw_id).
--   status     ok | rejected | error   (rejected: the body or the device was refused, nothing stored; error: a failure inside the core)
--   warnings   JSON list of plain-language notes (a millisecond timestamp read as milliseconds, a repeated body, points not used)
--   device_id  NULL when the push is about the home itself, or when the device could not be found
-- Same applying rules as 002-072.
CREATE TABLE IF NOT EXISTS push_log (
  id           INTEGER PRIMARY KEY,
  site_id      INTEGER REFERENCES site(id),
  device_id    INTEGER REFERENCES device(id),
  source       TEXT,
  format       TEXT,
  received_at  INTEGER NOT NULL,                 -- ms
  observations INTEGER NOT NULL DEFAULT 0,
  written      INTEGER NOT NULL DEFAULT 0,
  forecasts    INTEGER NOT NULL DEFAULT 0,
  derived      INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  unmapped     INTEGER NOT NULL DEFAULT 0,
  warnings     TEXT CHECK (warnings IS NULL OR json_valid(warnings)),
  raw_id       INTEGER REFERENCES raw_payload(id),
  status       TEXT NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
  error        TEXT,
  error_code   TEXT
);
CREATE INDEX IF NOT EXISTS ix_push_log_site ON push_log(site_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ix_push_log_device ON push_log(device_id, received_at DESC) WHERE device_id IS NOT NULL;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('073-push-log', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
