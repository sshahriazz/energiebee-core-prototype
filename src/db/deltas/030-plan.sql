-- Delta 030: plans as data (docs/hardening-and-planning-plan.md B6, the plan side of B7 and B8).
-- TABLES ONLY, NO PLANNER YET: nothing in the core writes a plan on its own, and the build engine
-- never reads these tables (the GB timeline cannot move). Helpers: src/core/plans.js.
-- Applied after the earlier deltas by db.js. Same applying rules as 002-011: statements end with
-- ';' at the end of a line, a trigger ends with a line 'END;', an ADD COLUMN whose column exists is
-- skipped, and every other statement may be run again (the seed rows are INSERT OR IGNORE).
--
-- Units: *_at columns are ms (like recorded_at); slot and plan times (plan_start, slot_start) are
-- epoch seconds (like site_hh.slot_start); money is minor units of plan_run.currency.
--
-- B8, plan side: a plan has its OWN grid. plan_run.slot_s takes any multiple of 300 s up to 3600
-- (5, 10, 15 ... 60 minutes), whatever the home's ledger slot is. The CHECKs that stay as the one
-- intentional limit of the LEDGER grid are site.slot_s IN (900, 1800, 3600) and site_hh.slot_start
-- % 900 = 0 (schema.sql; not changed here). A plan finer than the ledger is compared with it by
-- summing its slots inside each ledger slot (v_plan_vs_actual).
--
-- PostgreSQL port: bigint epochs (or timestamptz with CHECK (extract(epoch FROM slot_start)::bigint
-- % 300 = 0)); jsonb for the JSON columns (json_valid CHECKs dropped); WITHOUT ROWID tables become
-- ordinary tables with the same primary key; the partial unique indexes port as they are; IFNULL
-- becomes COALESCE; the triggers become BEFORE INSERT / UPDATE plpgsql functions with the same
-- conditions; plan_slot can be partitioned by range of slot_start (monthly) with plan_run_id
-- leading the key; row-level security on site_id for plan_run and, through it, every plan_* table.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- ───────────── What each kind of device can be told to do ─────────────
-- A registry, not code: a new action (or a new device kind) is one row here, and plan_slot, the
-- helpers' parameter checks and device_capability accept it with no schema change.
--   params_schema      JSON {name: {type: number|integer|string|boolean, unit, min, max, enum,
--                      required}}. A name that is a typed plan_slot column (charge_limit_pct,
--                      export_limit_pct, target_soc_kwh, power_w, setpoint_c, start_offset_min) is
--                      read from that column; any other from plan_slot.params.
--   side_effect_class  none        the device follows its own normal mode
--                      energy      shifts or limits the device's energy use, no effect on comfort
--                      grid_export sends energy to the grid (needs the home's export permission)
--                      comfort     changes a temperature people feel or the hot water
--                      safety      can switch heating off: frost protection must be verified
--   is_default         the action of a slot with no row (plans are sparse). A kind with no
--                      default: no row means "no instruction, the device follows its own controls".
CREATE TABLE IF NOT EXISTS device_action (
  device_kind        TEXT NOT NULL CHECK (length(device_kind) > 0),
  action             TEXT NOT NULL CHECK (length(action) > 0),
  label              TEXT NOT NULL,
  params_schema      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_schema)),
  description        TEXT,
  side_effect_class  TEXT NOT NULL CHECK (side_effect_class IN ('none', 'energy', 'grid_export', 'comfort', 'safety')),
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  PRIMARY KEY (device_kind, action)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS device_action_default ON device_action (device_kind) WHERE is_default = 1;

-- Battery and inverter: Predbat's five slot actions (demand, charge, freeze_charge, export,
-- freeze_export) plus three vendor-level ones. Predbat's sentinels: charge_limit_pct 0 = no charge,
-- export_limit_pct 100 = no export. Its derived states (hold charging, hold exporting) are never
-- planned: the executor logs them in command_log (event 'observed').
INSERT OR IGNORE INTO device_action (device_kind, action, label, params_schema, description, side_effect_class, is_default) VALUES
  ('battery', 'demand', 'Demand (self-consumption)', '{}', 'Covers the home''s load from solar and the battery down to the reserve; surplus solar charges the battery, then exports. The normal mode, and the action of a slot with no row.', 'none', 1),
  ('battery', 'charge', 'Charge', '{"charge_limit_pct":{"type":"number","unit":"%","min":0,"max":100,"required":true},"target_soc_kwh":{"type":"number","unit":"kWh","min":0},"power_w":{"type":"number","unit":"W","min":0}}', 'Charges from the grid (and solar) up to charge_limit_pct; 0 means no charge (Predbat sentinel). power_w NULL = the inverter maximum.', 'energy', 0),
  ('battery', 'freeze_charge', 'Freeze charge', '{}', 'Holds the charge level: the grid covers the load, surplus solar may still charge. Target = the charge level when the slot starts.', 'energy', 0),
  ('battery', 'export', 'Export', '{"export_limit_pct":{"type":"number","unit":"%","min":0,"max":100,"required":true},"start_offset_min":{"type":"integer","unit":"min","min":0,"max":55},"power_w":{"type":"number","unit":"W","min":0}}', 'Force-discharges to the grid down to the floor export_limit_pct (100 means no export). May start start_offset_min into its first slot (a multiple of 5, less than the slot); always ends on a slot boundary.', 'grid_export', 0),
  ('battery', 'freeze_export', 'Freeze export', '{}', 'Demand with charging disabled: the battery covers the load, surplus solar is exported, the charge level is not raised.', 'energy', 0),
  ('battery', 'hold', 'Hold', '{}', 'Neither charges nor discharges (vendor standby or hold mode): solar and grid cover the load. Not the derived hold-charging state, which the executor logs.', 'energy', 0),
  ('battery', 'pause', 'Pause', '{"what":{"type":"string","enum":["charge","discharge","both"],"required":true}}', 'Vendor pause mode: stops charging, discharging or both for the slot.', 'energy', 0),
  ('battery', 'force_discharge', 'Force discharge', '{"power_w":{"type":"number","unit":"W","min":0,"required":true},"export_limit_pct":{"type":"number","unit":"%","min":0,"max":100}}', 'Discharges at power_w whatever the load (vendor forced discharge, for example a grid-service event or a manual override), down to the optional floor. export is the planner''s discharge-to-floor.', 'grid_export', 0),
  ('inverter', 'demand', 'Demand (self-consumption)', '{}', 'As battery demand, for a hybrid inverter planned as the battery it controls.', 'none', 1),
  ('inverter', 'charge', 'Charge', '{"charge_limit_pct":{"type":"number","unit":"%","min":0,"max":100,"required":true},"target_soc_kwh":{"type":"number","unit":"kWh","min":0},"power_w":{"type":"number","unit":"W","min":0}}', 'As battery charge.', 'energy', 0),
  ('inverter', 'freeze_charge', 'Freeze charge', '{}', 'As battery freeze_charge.', 'energy', 0),
  ('inverter', 'export', 'Export', '{"export_limit_pct":{"type":"number","unit":"%","min":0,"max":100,"required":true},"start_offset_min":{"type":"integer","unit":"min","min":0,"max":55},"power_w":{"type":"number","unit":"W","min":0}}', 'As battery export.', 'grid_export', 0),
  ('inverter', 'freeze_export', 'Freeze export', '{}', 'As battery freeze_export.', 'energy', 0),
  ('inverter', 'hold', 'Hold', '{}', 'As battery hold.', 'energy', 0),
  ('inverter', 'pause', 'Pause', '{"what":{"type":"string","enum":["charge","discharge","both"],"required":true}}', 'As battery pause.', 'energy', 0),
  ('inverter', 'force_discharge', 'Force discharge', '{"power_w":{"type":"number","unit":"W","min":0,"required":true},"export_limit_pct":{"type":"number","unit":"%","min":0,"max":100}}', 'As battery force_discharge.', 'grid_export', 0),
  ('ev_charger', 'charge', 'Charge the car', '{"power_w":{"type":"number","unit":"W","min":0},"target_soc_pct":{"type":"number","unit":"%","min":0,"max":100}}', 'Charges the car at power_w (NULL = the charger maximum), optionally up to the car''s target_soc_pct.', 'energy', 0),
  ('ev_charger', 'stop', 'Stop charging', '{}', 'Stops or holds off charging for the slot.', 'energy', 0),
  ('ev_charger', 'set_current', 'Set current', '{"current_a":{"type":"number","unit":"A","min":0,"max":80,"required":true}}', 'Sets the charging current (most AC chargers cannot go below 6 A; the device capability note says its own range).', 'energy', 0),
  ('immersion', 'on', 'Immersion on', '{"power_w":{"type":"number","unit":"W","min":0}}', 'Heats the hot-water cylinder from the grid.', 'energy', 0),
  ('immersion', 'off', 'Immersion off', '{}', 'Off: the cylinder is not heated by the immersion in this slot.', 'comfort', 0),
  ('iboost', 'on', 'Boost on', '{"power_w":{"type":"number","unit":"W","min":0}}', 'Boosts the cylinder from the grid, on top of the solar surplus it diverts.', 'energy', 0),
  ('iboost', 'off', 'Boost off', '{}', 'Diverts only solar surplus (its normal mode).', 'comfort', 0),
  ('heat_pump', 'set_flow_temp', 'Set flow temperature', '{"flow_temp_c":{"type":"number","unit":"degC","min":20,"max":80,"required":true}}', 'Sets the flow temperature of the heating circuit.', 'comfort', 0),
  ('heat_pump', 'set_target_temp', 'Set target temperature', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'Sets the room set-point the heat pump controls to.', 'comfort', 0),
  ('heat_pump', 'heat_on', 'Heating on', '{}', 'Space heating on (its own schedule and set-point).', 'comfort', 0),
  ('heat_pump', 'heat_off', 'Heating off', '{}', 'Space heating off for the slot. Frost protection must stay active (verified when the device is provisioned).', 'safety', 0),
  ('heat_pump', 'boost', 'Boost', '{"minutes":{"type":"integer","unit":"min","min":5,"max":240,"required":true},"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30}}', 'Heats harder for a number of minutes (pre-heating before a peak).', 'comfort', 0),
  ('heat_pump', 'setback', 'Setback', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'Lowers the set-point to setpoint_c (coasting through a peak price).', 'comfort', 0),
  ('boiler', 'set_flow_temp', 'Set flow temperature', '{"flow_temp_c":{"type":"number","unit":"degC","min":20,"max":80,"required":true}}', 'As heat_pump set_flow_temp.', 'comfort', 0),
  ('boiler', 'set_target_temp', 'Set target temperature', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'As heat_pump set_target_temp.', 'comfort', 0),
  ('boiler', 'heat_on', 'Heating on', '{}', 'As heat_pump heat_on.', 'comfort', 0),
  ('boiler', 'heat_off', 'Heating off', '{}', 'As heat_pump heat_off: frost protection must stay active.', 'safety', 0),
  ('boiler', 'boost', 'Boost', '{"minutes":{"type":"integer","unit":"min","min":5,"max":240,"required":true},"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30}}', 'As heat_pump boost.', 'comfort', 0),
  ('boiler', 'setback', 'Setback', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'As heat_pump setback.', 'comfort', 0),
  ('thermostat', 'set_target_temp', 'Set target temperature', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'Sets the room thermostat''s set-point.', 'comfort', 0),
  ('trv', 'set_target_temp', 'Set target temperature', '{"setpoint_c":{"type":"number","unit":"degC","min":5,"max":30,"required":true}}', 'Sets one radiator valve''s set-point.', 'comfort', 0),
  ('hot_water', 'heat_water', 'Heat hot water', '{"setpoint_c":{"type":"number","unit":"degC","min":40,"max":80}}', 'Heats the cylinder (by whatever heats it) to setpoint_c, or its own target.', 'comfort', 0);

-- What ONE device can actually deliver ("never plan an action a device cannot deliver" as data).
-- supported = 0 is a known no: plan_slot refuses it. A command needs supported = 1 (command
-- trigger). No row = not known yet: a plan may still hold it (shadow mode), a command may not.
--   source  adapter      the vendor adapter declares it
--           vendor_doc   the vendor's documentation says so
--           probe        tried on the device: written and read back matching
--           installer | user   stated by a person
--           placeholder  assumed, not checked
CREATE TABLE IF NOT EXISTS device_capability (
  device_id    INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  supported    INTEGER NOT NULL CHECK (supported IN (0, 1)),
  source       TEXT NOT NULL CHECK (source IN ('adapter', 'vendor_doc', 'probe', 'installer', 'user', 'placeholder')),
  note         TEXT,
  recorded_at  INTEGER NOT NULL,                 -- ms, when this was last stated
  PRIMARY KEY (device_id, action)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS device_capability_known_action
BEFORE INSERT ON device_capability
BEGIN
  SELECT RAISE(ABORT, 'device_capability: action not defined in device_action for this device kind')
  WHERE NOT EXISTS (SELECT 1 FROM device d JOIN device_action a ON a.device_kind = d.kind AND a.action = NEW.action WHERE d.id = NEW.device_id);
END;

CREATE TRIGGER IF NOT EXISTS device_capability_known_action_update
BEFORE UPDATE OF device_id, action ON device_capability
BEGIN
  SELECT RAISE(ABORT, 'device_capability: action not defined in device_action for this device kind')
  WHERE NOT EXISTS (SELECT 1 FROM device d JOIN device_action a ON a.device_kind = d.kind AND a.action = NEW.action WHERE d.id = NEW.device_id);
END;

-- ───────────── Plan runs ─────────────
-- One row per saved plan. Append-only: a run is never changed except to be superseded (status and
-- superseded_at). The CURRENT run of a (site, scenario, variant) is the one with status ok or
-- stale_inputs; there is at most one (index plan_run_current), and saving a new run supersedes it.
-- A stale_inputs run is the demand-only fallback, and an error run (no slots) also supersedes the
-- current one: a plan is never left running on stale inputs.
--   scenario      live (the executor follows it), shadow (planned, never executed: scored),
--                 baseline (do nothing), twin (a replay on a copy of the home), what_if (other settings)
--   variant       free label separating parallel runs of one scenario ('battery 13.5 kWh')
--   plan_start    the plan's slot 0 (s), on the home's local slot grid (src/core/plans.js planFrame)
--   facts_as_of   ms: the "as known at" cut of every fact the plan read (src/core/facts.js withKnownAt)
--   plan_hash     hash of the decisions only (devices, slot, action, parameters): not of the
--                 predictions and not of plan_start, so an unchanged plan writes nothing
--   error         the failure (error) or the input that was stale (stale_inputs); kept when superseded
CREATE TABLE IF NOT EXISTS plan_run (
  id                 INTEGER PRIMARY KEY,
  site_id            INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  scenario           TEXT NOT NULL DEFAULT 'live' CHECK (scenario IN ('live', 'baseline', 'twin', 'what_if', 'shadow')),
  variant            TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,                 -- ms
  plan_start         INTEGER NOT NULL CHECK (plan_start % 300 = 0),
  slot_s             INTEGER NOT NULL CHECK (slot_s % 300 = 0 AND slot_s BETWEEN 300 AND 3600),
  horizon_h          INTEGER NOT NULL DEFAULT 48 CHECK (horizon_h BETWEEN 1 AND 168),
  step_s             INTEGER NOT NULL DEFAULT 300 CHECK (step_s > 0 AND step_s % 60 = 0 AND slot_s % step_s = 0),
  facts_as_of        INTEGER NOT NULL,                 -- ms
  method_version     TEXT NOT NULL CHECK (length(method_version) > 0),
  plan_hash          TEXT NOT NULL CHECK (length(plan_hash) > 0),
  settings_snapshot  TEXT CHECK (settings_snapshot IS NULL OR json_valid(settings_snapshot)),
  inputs_hash        TEXT,
  soc_start_kwh      REAL CHECK (soc_start_kwh IS NULL OR soc_start_kwh >= 0),
  currency           TEXT REFERENCES currency(code),  -- of every money figure below (minor units)
  metric_base        REAL,                             -- metric of doing nothing new
  metric_best        REAL,                             -- metric of the chosen plan
  metric_best10      REAL,                             -- the chosen plan under the pessimistic case
  cost_pv50          REAL,
  cost_pv10          REAL,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  status             TEXT NOT NULL CHECK (status IN ('ok', 'stale_inputs', 'error', 'superseded')),
  error              TEXT,
  superseded_at      INTEGER,                          -- ms
  parent_run_id      INTEGER REFERENCES plan_run(id) ON DELETE SET NULL,
  CHECK (facts_as_of <= created_at),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at),
  CHECK (status NOT IN ('error', 'stale_inputs') OR error IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_run_current ON plan_run (site_id, scenario, variant) WHERE status IN ('ok', 'stale_inputs');
CREATE INDEX IF NOT EXISTS plan_run_site ON plan_run (site_id, scenario, variant, created_at);
CREATE INDEX IF NOT EXISTS plan_run_parent ON plan_run (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- "UNIQUE (site_id, scenario, plan_hash)" as it is meant: the same decisions as the CURRENT run
-- are never written again (a plan that changes and later changes back is a new run).
CREATE TRIGGER IF NOT EXISTS plan_run_unchanged
BEFORE INSERT ON plan_run
WHEN NEW.status IN ('ok', 'stale_inputs')
BEGIN
  SELECT RAISE(ABORT, 'plan_run: unchanged plan (same plan_hash and status as the current run of this scenario)')
  WHERE EXISTS (SELECT 1 FROM plan_run c WHERE c.site_id = NEW.site_id AND c.scenario = NEW.scenario AND c.variant = NEW.variant
                  AND c.status = NEW.status AND c.plan_hash = NEW.plan_hash);
END;

CREATE TRIGGER IF NOT EXISTS plan_run_append_only
BEFORE UPDATE ON plan_run
WHEN NEW.site_id IS NOT OLD.site_id OR NEW.scenario IS NOT OLD.scenario OR NEW.variant IS NOT OLD.variant
  OR NEW.created_at IS NOT OLD.created_at OR NEW.plan_start IS NOT OLD.plan_start OR NEW.slot_s IS NOT OLD.slot_s
  OR NEW.horizon_h IS NOT OLD.horizon_h OR NEW.step_s IS NOT OLD.step_s OR NEW.facts_as_of IS NOT OLD.facts_as_of
  OR NEW.method_version IS NOT OLD.method_version OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.settings_snapshot IS NOT OLD.settings_snapshot OR NEW.inputs_hash IS NOT OLD.inputs_hash
  OR NEW.soc_start_kwh IS NOT OLD.soc_start_kwh OR NEW.currency IS NOT OLD.currency
  OR NEW.metric_base IS NOT OLD.metric_base OR NEW.metric_best IS NOT OLD.metric_best OR NEW.metric_best10 IS NOT OLD.metric_best10
  OR NEW.cost_pv50 IS NOT OLD.cost_pv50 OR NEW.cost_pv10 IS NOT OLD.cost_pv10 OR NEW.duration_ms IS NOT OLD.duration_ms
  OR NEW.error IS NOT OLD.error
BEGIN
  SELECT RAISE(ABORT, 'plan_run: append-only (only status and superseded_at change, when superseded)');
END;

CREATE TRIGGER IF NOT EXISTS plan_run_status_flow
BEFORE UPDATE OF status ON plan_run
WHEN NEW.status <> OLD.status AND NOT (OLD.status IN ('ok', 'stale_inputs') AND NEW.status = 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'plan_run: only a current run (ok or stale_inputs) can become superseded');
END;

-- Which devices a run planned. controlled: the planner decides its actions; aggregate: planned
-- together with others as one (two inverters as one battery; targets split at execution);
-- observed: modelled for the predictions only, never given an action.
CREATE TABLE IF NOT EXISTS plan_run_device (
  plan_run_id  INTEGER NOT NULL REFERENCES plan_run(id) ON DELETE CASCADE,
  device_id    INTEGER NOT NULL REFERENCES device(id),
  role         TEXT NOT NULL DEFAULT 'controlled' CHECK (role IN ('controlled', 'aggregate', 'observed')),
  PRIMARY KEY (plan_run_id, device_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS plan_run_device_device ON plan_run_device (device_id);

CREATE TRIGGER IF NOT EXISTS plan_run_device_same_site
BEFORE INSERT ON plan_run_device
BEGIN
  SELECT RAISE(ABORT, 'plan_run_device: the device belongs to another home')
  WHERE NOT EXISTS (SELECT 1 FROM plan_run r JOIN device d ON d.site_id = r.site_id WHERE r.id = NEW.plan_run_id AND d.id = NEW.device_id);
END;

-- ───────────── Plan slots: device-generic and sparse ─────────────
-- One row per (run, device, slot) that says something: a non-default action, a parameter, or a
-- prediction. No row = the kind's default action (battery: demand), or no instruction.
-- Decisions: action, params (JSON extras declared in device_action.params_schema), and the typed
-- start_offset_min (export start inside the first slot: a multiple of 5, less than the slot),
-- charge_limit_pct (0 = no charge), export_limit_pct (100 = no export), target_soc_kwh, power_w
-- (NULL = the device maximum), setpoint_c.
-- Predictions (filled by the simulator; NULL = not predicted): soc_end_kwh at the end of the slot;
-- import_kwh, export_kwh, pv_kwh, load_kwh and cost_minor for the HOME over the slot (carried by
-- one device row per slot, src/core/plans.js checks it); heat_kwh, indoor_temp_c_end; and the
-- outdoor_temp_c the plan assumed. Extra figures in predicted (JSON).
-- Predicted vs actual: joined to the ledger on (site_id, slot_start) = site_hh (site_id,
-- slot_start), plan_run giving site_id (view v_plan_vs_actual).
CREATE TABLE IF NOT EXISTS plan_slot (
  plan_run_id        INTEGER NOT NULL REFERENCES plan_run(id) ON DELETE CASCADE,
  device_id          INTEGER NOT NULL REFERENCES device(id),
  slot_start         INTEGER NOT NULL CHECK (slot_start % 300 = 0),   -- exact grid: trigger below
  action             TEXT NOT NULL,
  params             TEXT CHECK (params IS NULL OR json_valid(params)),
  start_offset_min   INTEGER NOT NULL DEFAULT 0 CHECK (start_offset_min >= 0 AND start_offset_min % 5 = 0),
  charge_limit_pct   REAL CHECK (charge_limit_pct IS NULL OR charge_limit_pct BETWEEN 0 AND 100),
  export_limit_pct   REAL CHECK (export_limit_pct IS NULL OR export_limit_pct BETWEEN 0 AND 100),
  target_soc_kwh     REAL CHECK (target_soc_kwh IS NULL OR target_soc_kwh >= 0),
  power_w            REAL CHECK (power_w IS NULL OR power_w >= 0),
  setpoint_c         REAL,
  soc_end_kwh        REAL CHECK (soc_end_kwh IS NULL OR soc_end_kwh >= 0),
  import_kwh         REAL CHECK (import_kwh IS NULL OR import_kwh >= 0),
  export_kwh         REAL CHECK (export_kwh IS NULL OR export_kwh >= 0),
  pv_kwh             REAL CHECK (pv_kwh IS NULL OR pv_kwh >= 0),
  load_kwh           REAL CHECK (load_kwh IS NULL OR load_kwh >= 0),
  cost_minor         REAL,
  heat_kwh           REAL CHECK (heat_kwh IS NULL OR heat_kwh >= 0),
  indoor_temp_c_end  REAL,
  outdoor_temp_c     REAL,
  predicted          TEXT CHECK (predicted IS NULL OR json_valid(predicted)),
  reason             TEXT,
  PRIMARY KEY (plan_run_id, device_id, slot_start)
) WITHOUT ROWID;

-- The checks a CHECK cannot make (they need the run and the device): the slot is on the run's own
-- grid and inside its horizon, the start offset is inside the slot, the device is planned by the
-- run, the action is defined for the device's kind, and the device is not known to be unable to do it.
CREATE TRIGGER IF NOT EXISTS plan_slot_checks
BEFORE INSERT ON plan_slot
BEGIN
  SELECT RAISE(ABORT, 'plan_slot: slot_start is not on the run''s slot grid or is outside its horizon')
  WHERE NOT EXISTS (SELECT 1 FROM plan_run r WHERE r.id = NEW.plan_run_id
                      AND NEW.slot_start >= r.plan_start AND (NEW.slot_start - r.plan_start) % r.slot_s = 0
                      AND NEW.slot_start < r.plan_start + r.horizon_h * 3600);
  SELECT RAISE(ABORT, 'plan_slot: start_offset_min must be less than the slot')
  WHERE EXISTS (SELECT 1 FROM plan_run r WHERE r.id = NEW.plan_run_id AND NEW.start_offset_min * 60 >= r.slot_s);
  SELECT RAISE(ABORT, 'plan_slot: device not planned by this run (plan_run_device role controlled or aggregate)')
  WHERE NOT EXISTS (SELECT 1 FROM plan_run_device p WHERE p.plan_run_id = NEW.plan_run_id AND p.device_id = NEW.device_id AND p.role IN ('controlled', 'aggregate'));
  SELECT RAISE(ABORT, 'plan_slot: action not defined in device_action for this device kind')
  WHERE NOT EXISTS (SELECT 1 FROM device d JOIN device_action a ON a.device_kind = d.kind AND a.action = NEW.action WHERE d.id = NEW.device_id);
  SELECT RAISE(ABORT, 'plan_slot: the device cannot deliver this action (device_capability supported = 0)')
  WHERE EXISTS (SELECT 1 FROM device_capability c WHERE c.device_id = NEW.device_id AND c.action = NEW.action AND c.supported = 0);
END;

-- Plans are append-only: a changed plan is a new run. Old rows are only ever deleted (retention).
CREATE TRIGGER IF NOT EXISTS plan_slot_append_only
BEFORE UPDATE ON plan_slot
BEGIN
  SELECT RAISE(ABORT, 'plan_slot: append-only (a changed plan is a new plan_run)');
END;

-- ───────────── What a run read (reproducibility) ─────────────
-- One row per input: which table and key (a series, a tariff, a settings version), the hash of the
-- values read, and the "as known at" moment (ms) they were read at. Re-reading the same key with
-- facts.js withKnownAt(as_of) gives the same hash, however the facts changed since.
CREATE TABLE IF NOT EXISTS plan_input_ref (
  plan_run_id  INTEGER NOT NULL REFERENCES plan_run(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('rates', 'pv', 'load', 'soc', 'settings', 'attributes', 'weather', 'other')),
  ref_table    TEXT NOT NULL CHECK (length(ref_table) > 0),    -- rate_interval, forecast_fact, reading, interval_fact, site_attribute ...
  ref_key      TEXT NOT NULL DEFAULT '',                       -- 'series:12', 'tariff:3', a forecast issue
  ref_hash     TEXT,                                           -- sha256 of the canonical rows read
  as_of        INTEGER NOT NULL,                               -- ms
  from_ts      INTEGER,                                        -- s: the period read
  to_ts        INTEGER,
  row_count    INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  PRIMARY KEY (plan_run_id, kind, ref_table, ref_key)
) WITHOUT ROWID;

-- ───────────── Scores: predicted against what happened ─────────────
-- Filled later (src/core/plans.js scorePlan) from v_plan_vs_actual once the ledger slot exists;
-- heat figures will come from the heating serving table when it is built. error = predicted - actual.
CREATE TABLE IF NOT EXISTS plan_score (
  id             INTEGER PRIMARY KEY,
  plan_run_id    INTEGER NOT NULL REFERENCES plan_run(id) ON DELETE CASCADE,
  slot_start     INTEGER NOT NULL CHECK (slot_start % 300 = 0),   -- the LEDGER slot scored
  device_id      INTEGER REFERENCES device(id),                   -- the device row that predicted it; NULL = the home
  metric         TEXT NOT NULL CHECK (length(metric) > 0),         -- import_kwh, export_kwh, pv_kwh, load_kwh, cost_minor, soc_end_pct ...
  predicted      REAL,
  actual         REAL,
  error          REAL,
  actual_source  TEXT NOT NULL DEFAULT 'site_hh',
  scored_at      INTEGER NOT NULL,                                -- ms
  CHECK (error IS NULL OR (predicted IS NOT NULL AND actual IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_score_key ON plan_score (plan_run_id, slot_start, IFNULL(device_id, 0), metric);

-- ───────────── Views ─────────────
-- The plan each scenario follows now.
CREATE VIEW IF NOT EXISTS v_current_plan AS
SELECT * FROM plan_run WHERE status IN ('ok', 'stale_inputs');

-- Each run's predictions against the ledger, per device row and LEDGER slot. A plan slot belongs to
-- the ledger slot it starts in; a plan finer than the ledger (5-minute plan, 30-minute ledger) is
-- summed over the ledger slot, and a figure is given only when every plan slot inside it carries
-- it (else NULL); a plan coarser than the ledger is not compared. soc is compared in % of the
-- home's battery (site_hh.soc_end is a charge level in %). Actual cost = the electricity bill of the
-- slot: total_cost without standing charges and gas (Predbat's cost has neither).
-- in_force: the run was the current plan for part of the slot (what ran, or would have).
CREATE VIEW IF NOT EXISTS v_plan_vs_actual AS
SELECT g.plan_run_id, g.site_id, g.scenario, g.variant, g.device_id, g.slot_start, g.dur_s, g.plan_slot_s, g.plan_slots, g.state,
       (g.slot_start + g.dur_s) * 1000 > g.created_at AND g.slot_start * 1000 < IFNULL(g.superseded_at, 9000000000000000) AND g.run_status <> 'error' AS in_force,
       g.import_kwh_pred, g.import_kwh_actual, g.import_kwh_pred - g.import_kwh_actual AS import_kwh_err,
       g.export_kwh_pred, g.export_kwh_actual, g.export_kwh_pred - g.export_kwh_actual AS export_kwh_err,
       g.pv_kwh_pred, g.pv_kwh_actual, g.pv_kwh_pred - g.pv_kwh_actual AS pv_kwh_err,
       g.load_kwh_pred, g.load_kwh_actual, g.load_kwh_pred - g.load_kwh_actual AS load_kwh_err,
       g.cost_minor_pred, g.cost_minor_actual, g.cost_minor_pred - g.cost_minor_actual AS cost_minor_err,
       g.soc_end_pct_pred, g.soc_end_pct_actual, g.soc_end_pct_pred - g.soc_end_pct_actual AS soc_end_pct_err
FROM (
  SELECT r.id AS plan_run_id, r.site_id, r.scenario, r.variant, r.status AS run_status, r.created_at, r.superseded_at,
         r.slot_s AS plan_slot_s, ps.device_id, h.slot_start, h.dur_s, h.state, COUNT(*) AS plan_slots,
         CASE WHEN COUNT(ps.import_kwh) * r.slot_s = h.dur_s THEN SUM(ps.import_kwh) END AS import_kwh_pred,
         h.grid_import AS import_kwh_actual,
         CASE WHEN COUNT(ps.export_kwh) * r.slot_s = h.dur_s THEN SUM(ps.export_kwh) END AS export_kwh_pred,
         h.grid_export AS export_kwh_actual,
         CASE WHEN COUNT(ps.pv_kwh) * r.slot_s = h.dur_s THEN SUM(ps.pv_kwh) END AS pv_kwh_pred,
         h.solar AS pv_kwh_actual,
         CASE WHEN COUNT(ps.load_kwh) * r.slot_s = h.dur_s THEN SUM(ps.load_kwh) END AS load_kwh_pred,
         h.home AS load_kwh_actual,
         CASE WHEN COUNT(ps.cost_minor) * r.slot_s = h.dur_s THEN SUM(ps.cost_minor) END AS cost_minor_pred,
         h.total_cost - IFNULL(h.standing_cost, 0) - IFNULL(h.gas_cost, 0) AS cost_minor_actual,
         100.0 * (SELECT x.soc_end_kwh FROM plan_slot x
                  WHERE x.plan_run_id = r.id AND x.device_id = ps.device_id AND x.slot_start = h.slot_start + h.dur_s - r.slot_s) / NULLIF(s.battery_kwh, 0) AS soc_end_pct_pred,
         h.soc_end AS soc_end_pct_actual
  FROM plan_slot ps
  JOIN plan_run r ON r.id = ps.plan_run_id
  JOIN site s ON s.id = r.site_id
  JOIN site_hh h ON h.site_id = r.site_id AND h.slot_start <= ps.slot_start AND h.slot_start > ps.slot_start - 3600
                AND ps.slot_start < h.slot_start + h.dur_s
  WHERE r.slot_s <= h.dur_s
  GROUP BY r.id, ps.device_id, h.site_id, h.slot_start
) g;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('030-plan', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
