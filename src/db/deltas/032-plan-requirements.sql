-- Delta 032: what the requirements catalogue (docs/predbat-predheat-requirements.md, PB-PLAN-OUT,
-- PB-CTRL, PB-DIAG and the PredHeat outputs) needs stored that 030 and 031 had no place for. Still
-- TABLES ONLY, NO PLANNER OR EXECUTOR. A NEW delta because 030 and 031 are applied (a change to the
-- schema is a new delta file, never an edit of an applied one). Same applying rules as 002-031:
-- statements end with ';' at the end of a line, a trigger ends with a line 'END;', an ADD COLUMN
-- whose column exists is skipped, and every other statement may be run again.
--
-- Not stored here, by design: per-day outcomes (actual cost, savings: site_day and the ledger), the
-- planner's settings and the site's control mode (site_setting, delta 021), inverter write limits and
-- read-back timing (device attributes, delta 020), process logs and API health (sync_run,
-- provider_state). Plan-level series per scenario are runs: base = scenario 'baseline', best = 'live',
-- the pessimistic case of either = the same scenario with variant 'pv10' and parent_run_id.
--
-- PostgreSQL port: as 030 and 031 (jsonb, plpgsql triggers; the window view ports as it is).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── plan_run: plan context, bounds, totals (PB-PLAN-02, 03, 18, 23, 25-27, 29, 32, 38, 39; PB-DIAG-06; PH-STATE-01) ─────────────
ALTER TABLE plan_run ADD COLUMN record_end INTEGER;                                   -- s: end of the part of the horizon the metric counts (Predbat end_record)
ALTER TABLE plan_run ADD COLUMN soc_max_kwh REAL CHECK (soc_max_kwh IS NULL OR soc_max_kwh >= 0);
ALTER TABLE plan_run ADD COLUMN reserve_kwh REAL CHECK (reserve_kwh IS NULL OR reserve_kwh >= 0);
ALTER TABLE plan_run ADD COLUMN control_mode TEXT CHECK (control_mode IS NULL OR control_mode IN ('monitor', 'soc_only', 'charge_only', 'charge_export', 'read_only'));
ALTER TABLE plan_run ADD COLUMN metric_base10 REAL;                                   -- metric of doing nothing new, pessimistic case
ALTER TABLE plan_run ADD COLUMN summary TEXT CHECK (summary IS NULL OR json_valid(summary));         -- plan totals and checkpoints (JSON, keys in docs/database.md)
ALTER TABLE plan_run ADD COLUMN carry_state TEXT CHECK (carry_state IS NULL OR json_valid(carry_state)); -- state the next run starts from (PredHeat water temperature, baseline SoC for savings)
ALTER TABLE plan_run ADD COLUMN debug_raw_id INTEGER REFERENCES raw_payload(id);      -- a full debug dump (inputs, settings, outputs) landed as a raw payload

CREATE TRIGGER IF NOT EXISTS plan_run_append_only_032
BEFORE UPDATE ON plan_run
WHEN NEW.record_end IS NOT OLD.record_end OR NEW.soc_max_kwh IS NOT OLD.soc_max_kwh OR NEW.reserve_kwh IS NOT OLD.reserve_kwh
  OR NEW.control_mode IS NOT OLD.control_mode OR NEW.metric_base10 IS NOT OLD.metric_base10 OR NEW.summary IS NOT OLD.summary
  OR NEW.carry_state IS NOT OLD.carry_state OR NEW.debug_raw_id IS NOT OLD.debug_raw_id
BEGIN
  SELECT RAISE(ABORT, 'plan_run: append-only (only status and superseded_at change, when superseded)');
END;

-- ───────────── plan_slot: what Predbat and PredHeat show per slot ─────────────
-- Decision: power_fraction (Predbat's reduced-power export or charge, 0-1 of the maximum; PB-PLAN-07, 09).
-- How it was decided: state (the status label shown for the slot, derived ones included: Hold
-- charging, No Charge, Hold for car, a mixed slot; PB-PLAN-06, PB-DIAG-02), decision_source
-- (optimiser, manual override, rule, fallback), reason_code and reason_params (Predbat's reason
-- templates, PB-PLAN-10; reason keeps the words).
-- Predicted, home level: pv10_kwh and load10_kwh (the pessimistic case, PB-PLAN-11, 12),
-- extra_load_kwh (PB-PLAN-13), car_kwh, iboost_kwh, carbon_g (PB-PLAN-16, 33) and
-- cost_running_minor (running total since local midnight incl. standing charges, PB-PLAN-15).
-- Predicted, heating device: heat_input_kwh (fuel or electricity the heating uses; heat_kwh is the
-- heat delivered), heat_cost_minor (cost of the heating alone), setpoint_used_c (incl. pre-heat),
-- heating_frac (share of the slot spent heating), water_temp_c_end (radiator water; PH-OUT-01..09).
ALTER TABLE plan_slot ADD COLUMN power_fraction REAL CHECK (power_fraction IS NULL OR power_fraction BETWEEN 0 AND 1);
ALTER TABLE plan_slot ADD COLUMN state TEXT;
ALTER TABLE plan_slot ADD COLUMN decision_source TEXT CHECK (decision_source IS NULL OR decision_source IN ('optimiser', 'manual', 'rule', 'fallback'));
ALTER TABLE plan_slot ADD COLUMN reason_code TEXT;
ALTER TABLE plan_slot ADD COLUMN reason_params TEXT CHECK (reason_params IS NULL OR json_valid(reason_params));
ALTER TABLE plan_slot ADD COLUMN pv10_kwh REAL CHECK (pv10_kwh IS NULL OR pv10_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN load10_kwh REAL CHECK (load10_kwh IS NULL OR load10_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN extra_load_kwh REAL CHECK (extra_load_kwh IS NULL OR extra_load_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN car_kwh REAL CHECK (car_kwh IS NULL OR car_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN iboost_kwh REAL CHECK (iboost_kwh IS NULL OR iboost_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN carbon_g REAL;
ALTER TABLE plan_slot ADD COLUMN cost_running_minor REAL;
ALTER TABLE plan_slot ADD COLUMN heat_input_kwh REAL CHECK (heat_input_kwh IS NULL OR heat_input_kwh >= 0);
ALTER TABLE plan_slot ADD COLUMN heat_cost_minor REAL;
ALTER TABLE plan_slot ADD COLUMN setpoint_used_c REAL;
ALTER TABLE plan_slot ADD COLUMN heating_frac REAL CHECK (heating_frac IS NULL OR heating_frac BETWEEN 0 AND 1);
ALTER TABLE plan_slot ADD COLUMN water_temp_c_end REAL;

-- ───────────── command: the rest of an inverter's desired state (PB-CTRL-03..08, 11) ─────────────
-- window_start / window_end are the charge window (or the window of a one-window action);
-- export_start / export_end the export window, so one command holds a whole schedule.
ALTER TABLE command ADD COLUMN reserve_pct REAL CHECK (reserve_pct IS NULL OR reserve_pct BETWEEN 0 AND 100);
ALTER TABLE command ADD COLUMN charge_rate_w REAL CHECK (charge_rate_w IS NULL OR charge_rate_w >= 0);
ALTER TABLE command ADD COLUMN discharge_rate_w REAL CHECK (discharge_rate_w IS NULL OR discharge_rate_w >= 0);
ALTER TABLE command ADD COLUMN current_a REAL CHECK (current_a IS NULL OR current_a >= 0);
ALTER TABLE command ADD COLUMN export_start INTEGER CHECK (export_start IS NULL OR export_start % 60 = 0);
ALTER TABLE command ADD COLUMN export_end INTEGER CHECK (export_end IS NULL OR export_end % 60 = 0);

CREATE TRIGGER IF NOT EXISTS command_desired_fixed_032
BEFORE UPDATE ON command
WHEN NEW.reserve_pct IS NOT OLD.reserve_pct OR NEW.charge_rate_w IS NOT OLD.charge_rate_w OR NEW.discharge_rate_w IS NOT OLD.discharge_rate_w
  OR NEW.current_a IS NOT OLD.current_a OR NEW.export_start IS NOT OLD.export_start OR NEW.export_end IS NOT OLD.export_end
BEGIN
  SELECT RAISE(ABORT, 'command: the desired state is fixed (a changed state is a new command)');
END;

CREATE TRIGGER IF NOT EXISTS command_export_window
BEFORE INSERT ON command
WHEN NEW.export_start IS NOT NULL AND NEW.export_end IS NOT NULL AND NEW.export_end <= NEW.export_start
BEGIN
  SELECT RAISE(ABORT, 'command: export_end must be after export_start');
END;

-- ───────────── Registry rows ─────────────
-- 'auto': the default of every kind that had none, so a predictions-only row (PredHeat, which issues
-- no commands, PH-CTRL-01) and "no row" both mean "no instruction: the device follows its own controls".
INSERT OR IGNORE INTO device_action (device_kind, action, label, params_schema, description, side_effect_class, is_default) VALUES
  ('ev_charger', 'auto', 'Own schedule', '{}', 'No instruction: the charger follows its own schedule or the car''s.', 'none', 1),
  ('immersion', 'auto', 'Own schedule', '{}', 'No instruction: the immersion follows its own timer or thermostat.', 'none', 1),
  ('iboost', 'auto', 'Own mode', '{}', 'No instruction: the diverter sends surplus solar to the cylinder as it normally does.', 'none', 1),
  ('heat_pump', 'auto', 'Own controls', '{}', 'No instruction: the heat pump follows its own schedule, set-point and weather compensation.', 'none', 1),
  ('boiler', 'auto', 'Own controls', '{}', 'No instruction: the boiler follows its own schedule and set-point.', 'none', 1),
  ('thermostat', 'auto', 'Own schedule', '{}', 'No instruction: the thermostat follows its own schedule.', 'none', 1),
  ('trv', 'auto', 'Own schedule', '{}', 'No instruction: the valve follows its own schedule.', 'none', 1),
  ('hot_water', 'auto', 'Own schedule', '{}', 'No instruction: the hot water follows its own timer.', 'none', 1),
  ('battery', 'release', 'Hand back', '{}', 'Hands the battery back (read-only mode or leaving the service): charge and export windows cleared, full rates, default reserve, confirmed by read-back (PB-CTRL-02).', 'none', 0),
  ('inverter', 'release', 'Hand back', '{}', 'As battery release.', 'none', 0);

-- Predbat's reduced-power fraction as a parameter of the battery actions that move energy at a rate.
UPDATE device_action SET params_schema = json_set(params_schema, '$.power_fraction', json('{"type":"number","min":0,"max":1}'))
  WHERE device_kind IN ('battery', 'inverter') AND action IN ('charge', 'export', 'force_discharge')
    AND json_extract(params_schema, '$.power_fraction') IS NULL;

-- ───────────── Views ─────────────
-- The slots each run was in force for: what ran (or, for a shadow or what-if run, what would have);
-- Predbat's History view of past slots (PB-DIAG-03). The same rule keeps them past retention.
CREATE VIEW IF NOT EXISTS v_plan_in_force AS
SELECT r.site_id, r.scenario, r.variant, r.status AS run_status, r.created_at AS run_created_at, r.superseded_at AS run_superseded_at, ps.*
FROM plan_slot ps JOIN plan_run r ON r.id = ps.plan_run_id
WHERE r.status <> 'error' AND (ps.slot_start + r.slot_s) * 1000 > r.created_at
  AND ps.slot_start * 1000 < IFNULL(r.superseded_at, 9000000000000000);

-- Windows: contiguous slots of one device with the same action and parameters merged, default
-- actions left out (Predbat's best charge and export windows, PB-PLAN-19, 20). window_start includes
-- the first slot's start offset; a window always ends on a slot boundary.
CREATE VIEW IF NOT EXISTS v_plan_window AS
SELECT plan_run_id, device_id, action, params, charge_limit_pct, export_limit_pct, target_soc_kwh, power_w, power_fraction, setpoint_c,
       MIN(slot_start + start_offset_min * 60) AS window_start, MAX(slot_start) + slot_s AS window_end, COUNT(*) AS slots
FROM (
  SELECT ps.plan_run_id, ps.device_id, ps.action, ps.params, ps.charge_limit_pct, ps.export_limit_pct, ps.target_soc_kwh, ps.power_w,
         ps.power_fraction, ps.setpoint_c, ps.slot_start, ps.start_offset_min, r.slot_s,
         ps.slot_start - r.slot_s * ROW_NUMBER() OVER (
           PARTITION BY ps.plan_run_id, ps.device_id, ps.action, ps.params, ps.charge_limit_pct, ps.export_limit_pct, ps.target_soc_kwh,
                        ps.power_w, ps.power_fraction, ps.setpoint_c
           ORDER BY ps.slot_start) AS grp
  FROM plan_slot ps
  JOIN plan_run r ON r.id = ps.plan_run_id
  JOIN device d ON d.id = ps.device_id
  JOIN device_action a ON a.device_kind = d.kind AND a.action = ps.action
  WHERE a.is_default = 0
) w
GROUP BY plan_run_id, device_id, action, params, charge_limit_pct, export_limit_pct, target_soc_kwh, power_w, power_fraction, setpoint_c, grp;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('032-plan-requirements', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
