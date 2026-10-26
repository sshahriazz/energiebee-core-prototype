-- Delta 013: indexes for the history-scanning and "as known at" reads, foreign-key child indexes,
-- and series.max_span_s for exact lower time bounds. Applied after 012 by db.js, once (its name is
-- recorded in schema_delta). Same applying rules as 002-012: statements end with ';' at the end of
-- a line, a trigger ends with a line 'END;', an ADD COLUMN whose column exists is skipped, and
-- every other statement may be run again. No row of any fact changes.
--
-- series.max_span_s: the longest (end_ts - start_ts) of any interval or forecast fact of the series,
-- s, every version counted; NULL = no such fact. Kept by the triggers below (never shrinks). A read
-- of "facts that overlap [from, to)" (end_ts > from AND start_ts < to) can then also say
-- start_ts >= from - max_span_s and so use the primary key as a range, not the whole history: no
-- fact of the series is longer than max_span_s, so the extra bound can never leave a row out
-- (src/core/facts.js spanOf, readIntervals; forecast.js scoreAccuracy; server.js /now carbon;
-- pricing.js loadPricing dispatches). A NULL is read as "no bound".

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE series ADD COLUMN max_span_s INTEGER CHECK (max_span_s IS NULL OR max_span_s > 0);

UPDATE series SET max_span_s = (
    SELECT MAX(s) FROM (
      SELECT MAX(end_ts - start_ts) AS s FROM interval_fact WHERE series_id = series.id
      UNION ALL SELECT MAX(end_ts - start_ts) FROM forecast_fact WHERE series_id = series.id))
  WHERE max_span_s IS NULL;

CREATE TRIGGER IF NOT EXISTS interval_fact_span_insert
AFTER INSERT ON interval_fact
WHEN NEW.end_ts - NEW.start_ts > IFNULL((SELECT max_span_s FROM series WHERE id = NEW.series_id), 0)
BEGIN
  UPDATE series SET max_span_s = NEW.end_ts - NEW.start_ts WHERE id = NEW.series_id;
END;

CREATE TRIGGER IF NOT EXISTS interval_fact_span_update
AFTER UPDATE OF series_id, start_ts, end_ts ON interval_fact
WHEN NEW.end_ts - NEW.start_ts > IFNULL((SELECT max_span_s FROM series WHERE id = NEW.series_id), 0)
BEGIN
  UPDATE series SET max_span_s = NEW.end_ts - NEW.start_ts WHERE id = NEW.series_id;
END;

CREATE TRIGGER IF NOT EXISTS forecast_fact_span_insert
AFTER INSERT ON forecast_fact
WHEN NEW.end_ts - NEW.start_ts > IFNULL((SELECT max_span_s FROM series WHERE id = NEW.series_id), 0)
BEGIN
  UPDATE series SET max_span_s = NEW.end_ts - NEW.start_ts WHERE id = NEW.series_id;
END;

CREATE TRIGGER IF NOT EXISTS forecast_fact_span_update
AFTER UPDATE OF series_id, start_ts, end_ts ON forecast_fact
WHEN NEW.end_ts - NEW.start_ts > IFNULL((SELECT max_span_s FROM series WHERE id = NEW.series_id), 0)
BEGIN
  UPDATE series SET max_span_s = NEW.end_ts - NEW.start_ts WHERE id = NEW.series_id;
END;

-- ───────────── Reads (review H2, H3, M10) ─────────────
-- The latest issue of a forecast series (sync.js recordForecast MAX(issued_at)) and the issues
-- made in a period (the timeline's forecast events).
CREATE INDEX IF NOT EXISTS forecast_issued ON forecast_fact (series_id, issued_at);
-- Rate rows of a tariff by start, every version: loadPricing and the "as known at" reads, which
-- cannot use the partial rate_current (WHERE superseded_at IS NULL). Also rate_interval(tariff_id).
CREATE INDEX IF NOT EXISTS rate_asof ON rate_interval (tariff_id, valid_from, recorded_at);
-- Agreements by home and by meter, every version (loadPricing "as known at", the evidence page).
-- Also the child indexes of tariff_agreement(site_id), (device_id) and (tariff_id).
CREATE INDEX IF NOT EXISTS agreement_site_asof ON tariff_agreement (site_id, valid_from, recorded_at);
CREATE INDEX IF NOT EXISTS agreement_device_asof ON tariff_agreement (device_id, valid_from, recorded_at);
CREATE INDEX IF NOT EXISTS agreement_tariff ON tariff_agreement (tariff_id);
-- The catalogue by pricing method and region (pricing.js learnIogWindow). tariff.region is in
-- schema.sql; a database from before it (the oldest schemas) gets the column first, empty.
ALTER TABLE tariff ADD COLUMN region TEXT;
CREATE INDEX IF NOT EXISTS tariff_structure_region ON tariff (structure, region);

-- ───────────── Operations (review M8) ─────────────
-- A home's syncs by time (timeline events, health) and its payloads by status and time
-- (quarantined payloads); also the child indexes of sync_run(site_id).
CREATE INDEX IF NOT EXISTS sync_run_site_started ON sync_run (site_id, started_at);
CREATE INDEX IF NOT EXISTS raw_payload_site_status ON raw_payload (site_id, status, fetched_at);

-- ───────────── Foreign-key child indexes (review M8) ─────────────
-- Which facts a raw payload fed: needed to delete a payload (retention, src/core/maintenance.js)
-- without scanning four fact tables per payload.
CREATE INDEX IF NOT EXISTS reading_raw ON reading (raw_id);
CREATE INDEX IF NOT EXISTS interval_fact_raw ON interval_fact (raw_id);
CREATE INDEX IF NOT EXISTS forecast_fact_raw ON forecast_fact (raw_id);
CREATE INDEX IF NOT EXISTS rate_interval_raw ON rate_interval (raw_id);
-- Home-specific rate rows (most rows are the shared catalogue: site_id NULL).
CREATE INDEX IF NOT EXISTS rate_interval_site ON rate_interval (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rebuild_queue_site ON rebuild_queue (site_id);
CREATE INDEX IF NOT EXISTS site_region_region ON site_region (scheme, code);
CREATE INDEX IF NOT EXISTS site_market ON site (market_code);
-- Not indexed on purpose: references to code-owned registry rows that are never deleted
-- (series.source_id / metric_id, raw_payload.source_id, every *.currency, market.currency), the
-- small register_window(device_id, calendar) and fact_correction references, and register_window
-- (tariff_id), which the partial register_window_tariff serves for every read.

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('013-indexes', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
