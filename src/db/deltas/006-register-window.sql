-- Delta 006: register windows, calendars and estimated rate rows. Applied after 005 by db.js on
-- every open. Same applying rules as 002-005: statements end with ';' at the end of a line, a
-- trigger ends with 'END;', an ADD COLUMN whose column exists is skipped, and every other
-- statement may be run again.
--
-- A tariff's "when each register applies" is stored as data (register_window), and the rate rows
-- are expanded from it by src/core/tariff-expand.js (src/core/tariffs.js storeWindows). Windows are
-- per tariff, with a meter's own windows (device_id) replacing the tariff's for that meter (French
-- HP/HC: each Linky meter has its own off-peak hours, stated on the bill).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── Calendars (Tempo colours, bank holidays) ─────────────
-- A calendar day starts at day_start_min local time (Tempo: 06:00, so a colour runs 06:00 to 06:00).
CREATE TABLE IF NOT EXISTS calendar (
  code           TEXT PRIMARY KEY,                 -- fr_tempo, gb_bank_holiday, ...
  day_start_min  INTEGER NOT NULL DEFAULT 0 CHECK (day_start_min BETWEEN 0 AND 1439),
  name           TEXT,
  origin         TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  origin_note    TEXT
) WITHOUT ROWID;

-- The type of each day (a Tempo colour), versioned like facts: a correction supersedes the old row.
-- A day with no current row is UNKNOWN (a colour not published yet): it is priced only with a
-- caller's cautious estimate, and every rate row it gives is marked estimated.
CREATE TABLE IF NOT EXISTS calendar_day (
  calendar       TEXT NOT NULL REFERENCES calendar(code),
  local_date     TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  day_type       TEXT NOT NULL CHECK (length(day_type) > 0),
  origin         TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  origin_note    TEXT,
  recorded_at    INTEGER NOT NULL,                 -- ms
  superseded_at  INTEGER,                          -- ms; NULL = current
  PRIMARY KEY (calendar, local_date, recorded_at)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_day_current ON calendar_day (calendar, local_date) WHERE superseded_at IS NULL;

-- ───────────── Register windows ─────────────
-- Wall-clock minutes in the tariff's zone (clock 'local') or UTC: start_min 0-1439, end_min
-- 1-1440, end <= start wraps past midnight. weekdays: bit 0 = Monday ... bit 6 = Sunday, read on
-- the day the window starts. calendar + day_type restrict a window to days of one type.
CREATE TABLE IF NOT EXISTS register_window (
  id             INTEGER PRIMARY KEY,
  tariff_id      INTEGER NOT NULL REFERENCES tariff(id),
  device_id      INTEGER REFERENCES device(id) ON DELETE CASCADE,   -- a meter's own window (replaces the tariff's)
  register       TEXT NOT NULL CHECK (length(register) > 0),
  start_min      INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  weekdays       INTEGER NOT NULL DEFAULT 127 CHECK (weekdays BETWEEN 1 AND 127),
  calendar       TEXT REFERENCES calendar(code),
  day_type       TEXT,
  clock          TEXT NOT NULL DEFAULT 'local' CHECK (clock IN ('local', 'utc')),
  valid_from     INTEGER,                          -- s, inclusive; NULL = always
  valid_to       INTEGER,                          -- s, exclusive; NULL = open-ended
  source_text    TEXT,                             -- the hours as the bill or contract prints them
  origin         TEXT CHECK (origin IS NULL OR origin IN ('sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic')),
  origin_note    TEXT,
  recorded_at    INTEGER NOT NULL,                 -- ms
  superseded_at  INTEGER,                          -- ms; NULL = current
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from),
  CHECK (day_type IS NULL OR calendar IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS register_window_tariff ON register_window (tariff_id, device_id) WHERE superseded_at IS NULL;

-- The register for time no window covers (HP outside the HC hours). NULL: every instant needs a window.
ALTER TABLE tariff ADD COLUMN default_register TEXT;

-- A rate row priced from a cautious default because its day type was not known yet (a Tempo colour
-- beyond tomorrow). Superseded by the real row once the day type is published.
ALTER TABLE rate_interval ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1));

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('006-register-window', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
