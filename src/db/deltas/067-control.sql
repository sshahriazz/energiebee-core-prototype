-- Delta 067: control read-back (Stage 4, docs/control-readback.md). The command tables (031-033) hold what
-- should be done; this adds what the DEVICE says it did.
--   command.verify_status / verified_at   whether the effect showed in telemetry some minutes into the window
--   command.applied_late_at               the device ran a command that had already expired (an ack that came
--                                         late); the status stays expired (final), the truth is kept here
--   command.ack_ref                       the vendor's receipt reference for the write
--   channel.access / enum_values          a channel may be written (write, readwrite); enum_values maps the
--                                         device's codes to words (a work mode) so a state is checked against it
--   device_action.effect_check            JSON {metric, min, afterS, windowS}: the mean of the metric over
--                                         [window start + afterS, + windowS] must reach min for the effect to count
--   control_limit                         per-device installer limits on a command parameter (checked at enqueue)
--   command_block                         every command that was refused at enqueue, and why
-- State metrics (domain control) are what a device reports about its own settings. command_log.event has a
-- CHECK that cannot be widened without rebuilding the table, so the new events are logged as 'observed' with
-- detail.state = applied_late | verified | not_verified | blocked.
-- Same applying rules as 002-066.

ALTER TABLE command ADD COLUMN verify_status TEXT CHECK (verify_status IS NULL OR verify_status IN ('verified', 'not_verified'));
ALTER TABLE command ADD COLUMN verified_at INTEGER;
ALTER TABLE command ADD COLUMN applied_late_at INTEGER;
ALTER TABLE command ADD COLUMN ack_ref TEXT;

ALTER TABLE channel ADD COLUMN access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write', 'readwrite'));
ALTER TABLE channel ADD COLUMN enum_values TEXT CHECK (enum_values IS NULL OR json_valid(enum_values));

ALTER TABLE device_action ADD COLUMN effect_check TEXT CHECK (effect_check IS NULL OR json_valid(effect_check));

UPDATE device_action SET effect_check = '{"metric":"battery_charge_w","min":100,"afterS":300,"windowS":300}'
  WHERE action = 'charge' AND device_kind IN ('battery', 'inverter') AND effect_check IS NULL;
UPDATE device_action SET effect_check = '{"metric":"grid_export_w","min":100,"afterS":300,"windowS":300}'
  WHERE action IN ('export', 'force_discharge') AND device_kind IN ('battery', 'inverter') AND effect_check IS NULL;

CREATE TABLE IF NOT EXISTS control_limit (
  id            INTEGER PRIMARY KEY,
  device_id     INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  action        TEXT,                                  -- NULL = every action of the device
  param         TEXT NOT NULL,                         -- a desired-state key: target_soc_pct, rate_w, limit_pct, setpoint_c, ...
  min_value     REAL,
  max_value     REAL,
  source        TEXT NOT NULL CHECK (source IN ('installer', 'vendor_doc', 'user', 'adapter')),
  valid_from    INTEGER NOT NULL,                      -- ms
  valid_to      INTEGER,                               -- ms, NULL = open
  recorded_at   INTEGER NOT NULL,                      -- ms
  superseded_at INTEGER,                               -- ms
  CHECK (min_value IS NOT NULL OR max_value IS NOT NULL),
  CHECK (min_value IS NULL OR max_value IS NULL OR max_value >= min_value)
);
CREATE INDEX IF NOT EXISTS control_limit_device ON control_limit (device_id, param) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS command_block (
  id          INTEGER PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  plan_run_id INTEGER REFERENCES plan_run(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  gate        TEXT NOT NULL CHECK (gate IN ('placeholder_capability', 'stale_inputs', 'limit', 'params')),
  detail      TEXT NOT NULL CHECK (json_valid(detail)),
  at          INTEGER NOT NULL                         -- ms
);
CREATE INDEX IF NOT EXISTS command_block_device ON command_block (device_id, at);

INSERT OR IGNORE INTO metric (code, label, unit, time_role, aggregation, domain) VALUES
  ('ctl_work_mode', 'Work mode (device code)', 'code', 'instant', 'last', 'control'),
  ('ctl_charge_target_soc_pct', 'Charge target level', '%', 'instant', 'last', 'control'),
  ('ctl_reserve_pct', 'Reserve level', '%', 'instant', 'last', 'control'),
  ('ctl_export_floor_pct', 'Export floor level', '%', 'instant', 'last', 'control'),
  ('ctl_charge_window_start_min', 'Charge window start (minute of day)', 'min', 'instant', 'last', 'control'),
  ('ctl_charge_window_end_min', 'Charge window end (minute of day)', 'min', 'instant', 'last', 'control'),
  ('ctl_charge_rate_w', 'Charge rate limit', 'W', 'instant', 'last', 'control'),
  ('ctl_discharge_rate_w', 'Discharge rate limit', 'W', 'instant', 'last', 'control'),
  ('ctl_setpoint_c', 'Temperature set-point', 'degC', 'instant', 'last', 'control');

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('067-control', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
