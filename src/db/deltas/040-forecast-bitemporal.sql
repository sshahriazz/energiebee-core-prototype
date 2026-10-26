-- Delta 040: forecasts become bitemporal (database review M11). Applied after the earlier deltas by
-- db.js, once (its name is recorded in schema_delta). Same applying rules as 002-012: statements end
-- with ';' at the end of a line, an ADD COLUMN whose column exists is skipped, and every statement
-- may be run again with the same result.
--
-- forecast_fact.recorded_at (ms): when the core stored the issue, so a read "as known at T"
-- (src/core/facts.js readForecastAsOf) never sees an issue fetched after T. Until now only issued_at
-- existed, and a provider's issued_at (Quartz's response timestamp) is not when the core knew it.
-- Rows stored before this delta get issued_at x 1000, the best known stand-in; new rows get the time
-- of the write (putForecasts).
--
-- The primary key gains end_ts: (series_id, start_ts, end_ts, issued_at). The old key left it out, so
-- a period with the same start but another length in the same issue was dropped by INSERT OR IGNORE
-- without a word. A key cannot be altered, so the table is rebuilt with SQLite's procedure: every row
-- copied out to a temporary table, the table dropped and created again, every row copied back (all
-- in the delta's one transaction; nothing refers to forecast_fact, and its own foreign keys to
-- series and raw_payload are checked on the way back in). Rows are copied unchanged: the new key is
-- a superset of the old one, so no two old rows can clash. db.js creates again any index another
-- change had put on the table (an index is dropped with its table).
--
-- Every existing read gives the same rows: readForecastOfRecord, the build's solar forecast of
-- record, scoreAccuracy and the Quartz reads select on series, start, issue time and value only
-- (checked row for row on a copy of data/core.db, docs/database.md section 4, forecast_fact).
-- On a run again (only when an object below is missing) recorded_at is already filled and is
-- copied as it is.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE forecast_fact ADD COLUMN recorded_at INTEGER;
UPDATE forecast_fact SET recorded_at = issued_at * 1000 WHERE recorded_at IS NULL;

DROP TABLE IF EXISTS temp.forecast_fact_040;
CREATE TEMP TABLE forecast_fact_040 AS SELECT series_id, start_ts, end_ts, issued_at, value, raw_id, recorded_at FROM main.forecast_fact;
DROP TABLE main.forecast_fact;

CREATE TABLE forecast_fact (
  series_id    INTEGER NOT NULL REFERENCES series(id),
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  issued_at    INTEGER NOT NULL,
  value        REAL,
  raw_id       INTEGER REFERENCES raw_payload(id),
  recorded_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),   -- ms: when the core stored it
  PRIMARY KEY (series_id, start_ts, end_ts, issued_at),
  CHECK (end_ts > start_ts)
) WITHOUT ROWID;

INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, raw_id, recorded_at)
  SELECT series_id, start_ts, end_ts, issued_at, value, raw_id, recorded_at FROM temp.forecast_fact_040;
DROP TABLE temp.forecast_fact_040;

-- "As known at" reads: the issues a series had recorded by a moment.
CREATE INDEX IF NOT EXISTS forecast_recorded ON forecast_fact (series_id, recorded_at);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('040-forecast-bitemporal', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
