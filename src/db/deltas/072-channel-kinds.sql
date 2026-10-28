-- Delta 072: channel kinds and optional checks. A channel can be a plain value (the default), a COUNTER (a cumulative
-- meter reading: the raw counter is stored as a reading and the energy of each period is derived from it by difference)
-- or an EVENT (a discrete happening, stored as a 0/1 period). The checks below are all optional (NULL = off), so
-- existing channels behave as before. Same applying rules as 002-071.
--   kind                'value' | 'counter' | 'event'
--   derived_metric_id   counter: the interval metric the derived energy is stored under (the channel's own metric is the raw counter)
--   counter_wrap        counter: the value at which the meter rolls over to zero (energy across a roll-over is counted)
--   counter_reset_below counter: a drop to at most this value is a reset (daily counter, restart); default is a tenth of the previous reading
--   max_gap_s           counter: a period longer than this is flagged estimated (the total is the counter's, its timing is not)
--   max_stuck_samples   value: this many identical samples in a row are stored with the suspect flag
--   clock_offset_s      added to every timestamp of the channel (a device whose clock is off)
--   future_tolerance_s  a timestamp further ahead than this is rejected (future_timestamp)
-- A drop that is neither a reset nor a wrap is a counter going backwards: the sample is rejected and recorded (counter_backwards).
ALTER TABLE channel ADD COLUMN kind TEXT NOT NULL DEFAULT 'value' CHECK (kind IN ('value', 'counter', 'event'));
ALTER TABLE channel ADD COLUMN derived_metric_id INTEGER REFERENCES metric(id);
ALTER TABLE channel ADD COLUMN counter_wrap REAL;
ALTER TABLE channel ADD COLUMN counter_reset_below REAL;
ALTER TABLE channel ADD COLUMN max_gap_s INTEGER;
ALTER TABLE channel ADD COLUMN max_stuck_samples INTEGER;
ALTER TABLE channel ADD COLUMN clock_offset_s INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel ADD COLUMN future_tolerance_s INTEGER;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('072-channel-kinds', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
