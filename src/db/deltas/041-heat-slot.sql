-- Delta 041: site_heat_slot, the heating serving table (plan item B9). Applied after 040 by db.js,
-- once (its name is recorded in schema_delta). Same applying rules as 002-040: statements end with
-- ';' at the end of a line, and every statement may be run again (CREATE ... IF NOT EXISTS only).
--
-- One row per slot of the home's slot length, on the same key as site_hh (site_id, slot_start), built
-- by src/core/heat.js buildHeat from the home's heating series (metric domain 'heating') and only for
-- a home that has one: site_hh and site_day gain no column, so the battery timeline cannot move.
-- Disposable like site_hh: rebuilt from facts, never the only copy of anything.
-- Slot starts and lengths are on the 300 s grid (the 5-minute step), so a later 5-minute slot length
-- (plan item B8) needs no rebuild of this table; today's slots are 900, 1800 or 3600 s.
-- Money in minor units of the home's currency (site.currency), at the unit price including tax.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS site_heat_slot (
  site_id              INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  slot_start           INTEGER NOT NULL CHECK (slot_start % 300 = 0),
  dur_s                INTEGER NOT NULL CHECK (dur_s > 0 AND dur_s % 300 = 0),   -- slot length, s (the home's slot_s when built)
  local_date           TEXT NOT NULL,
  tod_min              INTEGER NOT NULL,          -- local wall-clock minute of the day the slot starts
  state                TEXT NOT NULL CHECK (state IN ('provisional', 'final', 'missing')),
  quality              INTEGER NOT NULL,          -- QUALITY bits of src/core/facts.js
  indoor_temp_c        REAL,                      -- time-weighted mean of the indoor sensors
  setpoint_c           REAL,                      -- time-weighted mean set-point
  outdoor_temp_c       REAL,                      -- a sensor at the home, else Open-Meteo
  flow_temp_c          REAL,                      -- heat source flow (heat pump or boiler), time-weighted mean
  return_temp_c        REAL,                      -- heat source return (a condensing boiler's efficiency depends on it)
  radiator_temp_c      REAL,                      -- radiator water temperature
  heating_demand_kwh   REAL,                      -- as a device or model reported it (never estimated here)
  heat_output_kwh      REAL,                      -- heat delivered
  heating_energy_kwh   REAL,                      -- heat pump electricity + boiler gas
  heating_fuel         TEXT CHECK (heating_fuel IS NULL OR heating_fuel IN ('electricity', 'gas', 'electricity+gas')),
  cop                  REAL,                      -- heat delivered / heat pump electricity (heat pumps only)
  degree_hours         REAL,                      -- max(0, base - outdoor) x hours (base in lineage)
  heating_on_fraction  REAL,                      -- share of the slot the heating called for heat
  cost_minor           REAL,                      -- heating energy x unit price incl. tax, minor units
  currency             TEXT,
  lineage              TEXT,                      -- JSON: series and sources used, prices, coverage, provenance
  method_version       TEXT NOT NULL,
  built_at             INTEGER NOT NULL,          -- s
  PRIMARY KEY (site_id, slot_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS site_heat_slot_day ON site_heat_slot (site_id, local_date);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('041-heat-slot', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
