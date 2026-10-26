-- Delta 009: provider state. Applied after 008 by db.js, once. Same applying rules as
-- 002-008: statements end with ';' at the end of a line, an ADD COLUMN whose column exists is
-- skipped, and every other statement may be run again.
--
-- What a rate-limited provider needs to remember across restarts, per provider (one row each):
--   next_allowed_at  ms: no request to the provider before this moment. Written before and after
--                    every request (the minimum gap) and on an HTTP 429 (its Retry-After), so a
--                    restarted server cannot burst past the provider's limit.
--   cooldown_reason  why next_allowed_at is in the future beyond the normal gap ('HTTP 429 ...')
--   state            JSON, the provider's own progress: the sweep cursor (region batch, offset),
--                    the last complete sweep, the last run (the once-a-day gate), the last error.
--                    Never a credential or a token.
-- Used by src/adapters/tariffscanner.js (provider 'tariffscanner').

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS provider_state (
  provider         TEXT PRIMARY KEY,
  next_allowed_at  INTEGER,                     -- ms
  cooldown_reason  TEXT,
  state            TEXT CHECK (state IS NULL OR json_valid(state)),
  updated_at       INTEGER NOT NULL             -- ms
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('009-provider-state', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
