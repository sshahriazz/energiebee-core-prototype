-- EnergieBee unified core: prototype schema (SQLite).
-- Groups: registry, context, tariffs, facts, serving and operations.
-- Times are UTC epoch seconds; recorded_at is epoch milliseconds so two
-- versions written in the same second still get distinct keys.

PRAGMA foreign_keys = ON;

-- ───────────── Registry ─────────────

CREATE TABLE IF NOT EXISTS source (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  contract  TEXT NOT NULL            -- JSON: time zone rule, signs, units, missing data, revisions, history
);

CREATE TABLE IF NOT EXISTS metric (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  unit        TEXT NOT NULL,
  time_role   TEXT NOT NULL CHECK (time_role IN ('instant', 'interval')),
  aggregation TEXT NOT NULL CHECK (aggregation IN ('sum', 'mean', 'last', 'integrate')),
  domain      TEXT NOT NULL
);

-- ───────────── Context ─────────────

CREATE TABLE IF NOT EXISTS site (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  postcode        TEXT,
  outcode         TEXT,
  lat             REAL,
  lon             REAL,
  timezone        TEXT NOT NULL DEFAULT 'Europe/London',
  gsp_region      TEXT,                 -- Octopus grid supply point letter, e.g. C
  carbon_region   INTEGER,              -- NESO region id
  pv_kwp          REAL,
  pv_tilt         REAL,
  pv_orientation  REAL,                 -- compass bearing, 180 = south
  battery_kwh     REAL,
  slot_s          INTEGER NOT NULL DEFAULT 1800 CHECK (slot_s IN (900, 1800, 3600)),   -- slot length, s; slots start at local midnight
  is_demo         INTEGER NOT NULL DEFAULT 0,
  env_key         TEXT UNIQUE,          -- set for the home configured in .env
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connection (
  id              INTEGER PRIMARY KEY,
  site_id         INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,        -- sunsynk, octopus, weather, carbon, ...
  external_ref    TEXT,                 -- plant id, account number
  status          TEXT NOT NULL DEFAULT 'new',
  last_success_at INTEGER,
  last_error      TEXT,
  meta            TEXT,
  UNIQUE (site_id, provider)
);

CREATE TABLE IF NOT EXISTS device (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,          -- inverter, battery, meter_import, meter_export, meter_gas, ev
  provider      TEXT NOT NULL,
  external_ref  TEXT NOT NULL,          -- serial, MPAN, MPRN, device id
  label         TEXT,
  attrs         TEXT,                   -- current details; every version is in device_attr_version
  recorded_at   INTEGER,                -- ms: when the core first knew this device
  retired_at    INTEGER,                -- ms: when it stopped being used (kept, not deleted)
  UNIQUE (site_id, provider, external_ref)
);

CREATE TABLE IF NOT EXISTS series (
  id            INTEGER PRIMARY KEY,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('site', 'device', 'region')),
  subject_id    TEXT NOT NULL,
  metric_id     INTEGER NOT NULL REFERENCES metric(id),
  source_id     INTEGER NOT NULL REFERENCES source(id),
  UNIQUE (subject_kind, subject_id, metric_id, source_id)
);

-- ───────────── Tariffs ─────────────

CREATE TABLE IF NOT EXISTS tariff (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL,
  product_code  TEXT,
  tariff_code   TEXT NOT NULL UNIQUE,
  fuel          TEXT NOT NULL CHECK (fuel IN ('electricity', 'gas')),
  direction     TEXT NOT NULL CHECK (direction IN ('import', 'export')),
  structure     TEXT NOT NULL,          -- flat, tou, agile, e7, iog, tracker, export
  region        TEXT,
  name          TEXT
);

-- Prices in MINOR units of the tariff's currency (tariff.currency), excluding taxes (tax_rule).
--   unit      per kWh, for one register: single, day, night, or a tariff's own register names
--             (hp, hc, blue_hc ...: rows expanded from its windows by src/core/tariff-expand.js)
--   standing  per local day (the GB standing charge; charge_period NULL or 'day')
--   fixed     per charge_period (a subscription per month, a fee per year), spread over slots
--             by real seconds (tariff-expand.js fixedChargePerSlot)
--   capacity  per kW per charge_period (stored; not priced yet)
-- Databases from before Oct 2026 had CHECKs allowing only unit/standing and single/day/night;
-- db.js rebuilds that table once, copying every row.
CREATE TABLE IF NOT EXISTS rate_interval (
  id              INTEGER PRIMARY KEY,
  tariff_id       INTEGER NOT NULL REFERENCES tariff(id),
  site_id         INTEGER REFERENCES site(id),   -- set only for home-specific rows
  component       TEXT NOT NULL CHECK (component IN ('unit', 'standing', 'fixed', 'capacity')),
  register        TEXT NOT NULL DEFAULT 'single' CHECK (length(register) > 0),
  charge_period   TEXT CHECK (charge_period IN ('day', 'month', 'year')),
  payment_method  TEXT NOT NULL DEFAULT 'ANY',
  valid_from      INTEGER NOT NULL,
  valid_to        INTEGER,                        -- NULL = open-ended
  price_ex_vat    REAL NOT NULL,                  -- minor units per kWh (unit) or per period, excluding taxes
  recorded_at     INTEGER NOT NULL,
  superseded_at   INTEGER,
  raw_id          INTEGER REFERENCES raw_payload(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (CASE component WHEN 'unit' THEN charge_period IS NULL
                        WHEN 'standing' THEN charge_period IS NULL OR charge_period = 'day'
                        ELSE charge_period IS NOT NULL END)
);
CREATE INDEX IF NOT EXISTS rate_current
  ON rate_interval (tariff_id, component, register, valid_from) WHERE superseded_at IS NULL;

-- Stand-in for a PostgreSQL exclusion constraint: current rows for the same
-- tariff, home, component, register, charge period and payment method may never overlap.
CREATE TRIGGER IF NOT EXISTS rate_no_overlap
BEFORE INSERT ON rate_interval
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current rate interval')
  WHERE EXISTS (
    SELECT 1 FROM rate_interval r
    WHERE r.superseded_at IS NULL
      AND r.tariff_id = NEW.tariff_id
      AND r.component = NEW.component
      AND r.register = NEW.register
      AND IFNULL(r.charge_period, '') = IFNULL(NEW.charge_period, '')
      AND r.payment_method = NEW.payment_method
      AND IFNULL(r.site_id, 0) = IFNULL(NEW.site_id, 0)
      AND r.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(r.valid_to, 9000000000) > NEW.valid_from
  );
END;

-- Versioned like facts: a changed account history supersedes the old rows (kept) and adds new ones.
CREATE TABLE IF NOT EXISTS tariff_agreement (
  id             INTEGER PRIMARY KEY,
  site_id        INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  device_id      INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  tariff_id      INTEGER NOT NULL REFERENCES tariff(id),
  valid_from     INTEGER NOT NULL,
  valid_to       INTEGER,
  recorded_at    INTEGER,               -- ms
  superseded_at  INTEGER,               -- ms; NULL = current
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS agreement_current ON tariff_agreement (device_id, valid_from) WHERE superseded_at IS NULL;

CREATE TRIGGER IF NOT EXISTS agreement_no_overlap_current
BEFORE INSERT ON tariff_agreement
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping tariff agreement for this meter')
  WHERE EXISTS (
    SELECT 1 FROM tariff_agreement a
    WHERE a.device_id = NEW.device_id AND a.superseded_at IS NULL
      AND a.valid_from < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(a.valid_to, 9000000000) > NEW.valid_from
  );
END;

CREATE TABLE IF NOT EXISTS vat_rate (
  fuel        TEXT NOT NULL,
  direction   TEXT NOT NULL,
  rate        REAL NOT NULL,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER,
  PRIMARY KEY (fuel, direction, valid_from)
);

-- ───────────── Facts (the truth) ─────────────

CREATE TABLE IF NOT EXISTS raw_payload (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES source(id),
  site_id     INTEGER,
  request     TEXT,
  fetched_at  INTEGER NOT NULL,
  hash        TEXT NOT NULL UNIQUE,
  file        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'quarantined')),
  reason      TEXT
);

CREATE TABLE IF NOT EXISTS reading (
  series_id     INTEGER NOT NULL REFERENCES series(id),
  ts            INTEGER NOT NULL,
  value         REAL,
  quality       INTEGER NOT NULL DEFAULT 1,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER,
  raw_id        INTEGER REFERENCES raw_payload(id),
  PRIMARY KEY (series_id, ts, recorded_at)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS interval_fact (
  series_id     INTEGER NOT NULL REFERENCES series(id),
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  value         REAL,
  quality       INTEGER NOT NULL DEFAULT 1,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER,
  raw_id        INTEGER REFERENCES raw_payload(id),
  PRIMARY KEY (series_id, start_ts, end_ts, recorded_at),
  CHECK (end_ts > start_ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS interval_current ON interval_fact (series_id, start_ts) WHERE superseded_at IS NULL;

-- Bitemporal since delta 040: issued_at (s) is the provider's issue time, recorded_at (ms) when the
-- core stored it; end_ts is in the key, so periods of two lengths from one start are both kept.
-- A database from before 040 is rebuilt to this shape by the delta (every row copied).
CREATE TABLE IF NOT EXISTS forecast_fact (
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

-- ───────────── Serving (rebuilt from facts) ─────────────

-- One row per slot of the home's slot length (site.slot_s). Every real zone's offset is a
-- multiple of 15 minutes, so a slot always starts on the 900 s grid.
CREATE TABLE IF NOT EXISTS site_hh (
  site_id               INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  slot_start            INTEGER NOT NULL CHECK (slot_start % 900 = 0),
  local_date            TEXT NOT NULL,
  dur_s                 INTEGER NOT NULL,        -- slot length, s (the home's slot_s when built)
  tod_min               INTEGER NOT NULL,        -- local wall-clock minute of the day the slot starts
  state                 TEXT NOT NULL CHECK (state IN ('provisional', 'final', 'missing')),
  quality               INTEGER NOT NULL,
  solar                 REAL, grid_import REAL, grid_export REAL,
  battery_charge        REAL, battery_discharge REAL, home REAL, loss REAL,
  gas                   REAL, ev REAL, soc_end REAL,
  solar_to_home         REAL, solar_to_battery REAL, solar_to_grid REAL,
  battery_to_home       REAL, battery_to_grid REAL,
  grid_to_home          REAL, grid_to_battery REAL,
  solar_to_loss         REAL, battery_to_loss REAL, grid_to_loss REAL, loss_cost REAL,
  import_rate_ex        REAL, import_vat REAL, export_rate REAL,
  gas_rate_ex           REAL, gas_vat REAL,
  grid_to_home_cost     REAL, grid_to_battery_cost REAL, battery_to_home_cost REAL,
  export_credit         REAL, standing_cost REAL, gas_cost REAL,
  total_cost            REAL, grid_only_cost REAL, saving REAL,
  carbon_intensity      REAL, carbon_g REAL, carbon_saved_g REAL,
  outdoor_temp          REAL, solar_forecast REAL,
  meter_vs_ct           REAL, rate_found INTEGER,
  lineage               TEXT,
  method_version        TEXT NOT NULL,
  built_at              INTEGER NOT NULL,
  PRIMARY KEY (site_id, slot_start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS site_hh_day ON site_hh (site_id, local_date);

CREATE TABLE IF NOT EXISTS site_day (
  site_id             INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  local_date          TEXT NOT NULL,
  slots               INTEGER, slots_final INTEGER, slots_provisional INTEGER, slots_missing INTEGER,
  slot_s              INTEGER,      -- slot length the day was built with, s (NULL = built before it was recorded: 1800)
  solar REAL, grid_import REAL, grid_export REAL, battery_charge REAL, battery_discharge REAL,
  home REAL, loss REAL, gas REAL, ev REAL,
  solar_to_home REAL, solar_to_battery REAL, solar_to_grid REAL,
  battery_to_home REAL, battery_to_grid REAL, grid_to_home REAL, grid_to_battery REAL,
  solar_to_loss REAL, battery_to_loss REAL, grid_to_loss REAL, loss_cost REAL,
  grid_to_home_cost REAL, grid_to_battery_cost REAL, battery_to_home_cost REAL,
  export_credit REAL, standing_cost REAL, gas_cost REAL, total_cost REAL,
  grid_only_cost REAL, saving REAL, carbon_g REAL, carbon_saved_g REAL,
  solar_forecast REAL,
  self_consumption REAL, self_sufficiency REAL, blended_cost REAL,
  peak_import_kw REAL, base_load_kw REAL, soc_min REAL, soc_max REAL, battery_cycles REAL,
  integrity REAL,
  battery_eff REAL,                 -- round-trip efficiency used for this day's charging
  battery_stock TEXT,               -- battery layers at the end of the day (JSON), so a rebuild can start the next day
  method_version TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, local_date)
) WITHOUT ROWID;

-- ───────────── Operations ─────────────

CREATE TABLE IF NOT EXISTS check_result (
  site_id     INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  local_date  TEXT NOT NULL,
  check_code  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail', 'skip')),
  measured    REAL,
  tolerance   REAL,
  detail      TEXT,
  PRIMARY KEY (site_id, local_date, check_code)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rebuild_queue (
  id          INTEGER PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  from_ts     INTEGER NOT NULL,
  to_ts       INTEGER NOT NULL,
  reason      TEXT,
  enqueued_at INTEGER NOT NULL,
  done_at     INTEGER
);

CREATE TABLE IF NOT EXISTS sync_run (
  id           INTEGER PRIMARY KEY,
  site_id      INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL,
  detail       TEXT
);

-- ───────────── Trust: history the serving tables do not keep ─────────────

-- The system's physical details (panel size and angles, battery size), versioned like facts:
-- one row per value per source, kept when replaced. The site table holds the resolved current
-- value (installer > measured > provider > estimated); this table says where it came from and
-- what was known at any earlier moment, so a day can be rebuilt as it stood then.
CREATE TABLE IF NOT EXISTS site_attribute (
  site_id        INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  attr           TEXT NOT NULL CHECK (attr IN ('pv_kwp', 'pv_tilt', 'pv_orientation', 'battery_kwh')),
  source         TEXT NOT NULL CHECK (source IN ('installer', 'measured', 'provider', 'estimated')),
  value          REAL,
  detail         TEXT,
  recorded_at    INTEGER NOT NULL,          -- ms
  superseded_at  INTEGER,                   -- ms; NULL = current
  PRIMARY KEY (site_id, attr, source, recorded_at)
) WITHOUT ROWID;

-- One row each time a completed day's figures, state or checks change in a rebuild:
-- site_day keeps only the latest version, this keeps how it got there.
CREATE TABLE IF NOT EXISTS site_day_revision (
  id                 INTEGER PRIMARY KEY,
  site_id            INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  local_date         TEXT NOT NULL,
  revised_at         INTEGER NOT NULL,      -- s
  method_version     TEXT NOT NULL,
  reason             TEXT,
  slots_final        INTEGER,
  slots_provisional  INTEGER,
  slots_missing      INTEGER,
  solar              REAL,
  home               REAL,
  grid_import        REAL,
  grid_export        REAL,
  gas                REAL,
  total_cost         REAL,
  saving             REAL,
  checks             TEXT,                  -- JSON {check_code: status}
  inputs             TEXT,                  -- JSON: system details used, meter vs clamp half-hours
  changed            TEXT,                  -- JSON [{field, from, to}]; NULL for the first record
  kind               TEXT NOT NULL DEFAULT 'recorded'   -- recorded (by a live rebuild) or reconstructed (from the facts known then)
);
CREATE INDEX IF NOT EXISTS site_day_revision_day ON site_day_revision (site_id, local_date, revised_at);

-- Facts withdrawn by the core itself (not by a provider), with the reason, so a correction
-- is visible rather than silent.
CREATE TABLE IF NOT EXISTS fact_correction (
  id           INTEGER PRIMARY KEY,
  site_id      INTEGER REFERENCES site(id) ON DELETE CASCADE,
  corrected_at INTEGER NOT NULL,            -- s
  series_id    INTEGER REFERENCES series(id),
  rows         INTEGER NOT NULL,
  reason       TEXT NOT NULL
);

-- Every version of a device's details (gas unit, gas zone, EV status …): device.attrs holds the
-- current one. Lets a rebuild read a meter as it was described at an earlier moment.
CREATE TABLE IF NOT EXISTS device_attr_version (
  device_id      INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  attrs          TEXT NOT NULL,
  recorded_at    INTEGER NOT NULL,      -- ms
  superseded_at  INTEGER,               -- ms; NULL = current
  PRIMARY KEY (device_id, recorded_at)
) WITHOUT ROWID;
