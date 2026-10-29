-- Delta 070: Stage 5 - currency on every slot, groups with dated membership, users and grants.
-- Same applying rules as 002-066: statements end with ';' at the end of a line, a trigger ends with a line
-- 'END;', every statement may be run again.
--
--   site_hh.currency   the currency of the slot's money columns, written by the builder from the home as known
--                      then; existing rows take the home's current currency once.
--   column_class       how each site_hh column is combined across homes (data, so a new column cannot be added
--                      without saying how it aggregates; test/groups-classes.test.js checks every column has one).
--   app_user, site_grant      who may see or control a home. GRANT is an SQL keyword, hence site_grant.
--   site_group, site_group_member, group_grant   a named set of homes viewed together. Membership is dated
--                      (valid_from, valid_to: seconds) and kept in transaction time (recorded_at, superseded_at: ms),
--                      so a report as it was recorded can be run again.
-- tenant and tenant_site (delta 060) stay the data controller of a home; they are not access control.

ALTER TABLE site_hh ADD COLUMN currency TEXT REFERENCES currency(code);

UPDATE site_hh SET currency = (SELECT s.currency FROM site s WHERE s.id = site_hh.site_id) WHERE currency IS NULL;

CREATE TABLE IF NOT EXISTS column_class (
  table_name   TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  class        TEXT NOT NULL CHECK (class IN ('key', 'energy', 'forecast', 'flow', 'money', 'carbon', 'price', 'intensity', 'temperature', 'charge_level', 'flag', 'diagnostic', 'lineage', 'unit')),
  weight_by    TEXT,                                 -- price, intensity: the column whose kWh weights it
  note         TEXT,
  PRIMARY KEY (table_name, column_name)
) WITHOUT ROWID;

INSERT OR IGNORE INTO column_class (table_name, column_name, class, weight_by, note) VALUES
  ('site_hh', 'site_id', 'key', NULL, 'group by or carried; never aggregated'),
  ('site_hh', 'slot_start', 'key', NULL, 'group by or carried; never aggregated'),
  ('site_hh', 'local_date', 'key', NULL, 'group by or carried; never aggregated'),
  ('site_hh', 'dur_s', 'key', NULL, 'group by or carried; never aggregated'),
  ('site_hh', 'tod_min', 'key', NULL, 'group by or carried; never aggregated'),
  ('site_hh', 'solar', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'grid_import', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'grid_export', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'battery_charge', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'battery_discharge', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'home', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'loss', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'gas', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'ev', 'energy', NULL, 'sum of members, kWh; exact at any slot length'),
  ('site_hh', 'solar_forecast', 'forecast', NULL, 'sum, only where every member has one'),
  ('site_hh', 'solar_to_home', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'solar_to_battery', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'solar_to_grid', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'battery_to_home', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'battery_to_grid', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'grid_to_home', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'grid_to_battery', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'solar_to_loss', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'battery_to_loss', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'grid_to_loss', 'flow', NULL, 'sum of the members own allocations; never recomputed from coarser buckets (they differ by slot length)'),
  ('site_hh', 'loss_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'grid_to_home_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'grid_to_battery_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'battery_to_home_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'export_credit', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'standing_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'gas_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'total_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'grid_only_cost', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'saving', 'money', NULL, 'sum within one currency only; never converted, never re-priced'),
  ('site_hh', 'carbon_g', 'carbon', NULL, 'sum, g'),
  ('site_hh', 'carbon_saved_g', 'carbon', NULL, 'sum, g'),
  ('site_hh', 'outdoor_temp', 'temperature', NULL, 'time-weighted per home; not combined across homes'),
  ('site_hh', 'soc_end', 'charge_level', NULL, '% of each home battery: converted to kWh with its size, summed, then divided by the summed size'),
  ('site_hh', 'state', 'flag', NULL, 'state: worst of the member slots; quality: bitwise OR; rate_found: count of homes without'),
  ('site_hh', 'quality', 'flag', NULL, 'state: worst of the member slots; quality: bitwise OR; rate_found: count of homes without'),
  ('site_hh', 'rate_found', 'flag', NULL, 'state: worst of the member slots; quality: bitwise OR; rate_found: count of homes without'),
  ('site_hh', 'meter_vs_ct', 'diagnostic', NULL, 'per home only'),
  ('site_hh', 'lineage', 'lineage', NULL, 'per home; method_version mixed in one bucket is flagged; built_at max'),
  ('site_hh', 'method_version', 'lineage', NULL, 'per home; method_version mixed in one bucket is flagged; built_at max'),
  ('site_hh', 'built_at', 'lineage', NULL, 'per home; method_version mixed in one bucket is flagged; built_at max'),
  ('site_hh', 'currency', 'unit', NULL, 'partitions the money sums'),
  ('site_hh', 'import_rate_ex', 'price', 'grid_import', 'weighted mean over the member slots, weighted by the energy it applies to, one per currency; never a plain average'),
  ('site_hh', 'import_vat', 'price', 'grid_import', 'weighted mean over the member slots, weighted by the energy it applies to, one per currency; never a plain average'),
  ('site_hh', 'export_rate', 'price', 'grid_export', 'weighted mean over the member slots, weighted by the energy it applies to, one per currency; never a plain average'),
  ('site_hh', 'gas_rate_ex', 'price', 'gas', 'weighted mean over the member slots, weighted by the energy it applies to, one per currency; never a plain average'),
  ('site_hh', 'gas_vat', 'price', 'gas', 'weighted mean over the member slots, weighted by the energy it applies to, one per currency; never a plain average'),
  ('site_hh', 'carbon_intensity', 'intensity', 'grid_import', 'weighted mean over the member slots, weighted by the energy it applies to; not tied to a currency; never a plain average');

CREATE TABLE IF NOT EXISTS app_user (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) > 0),
  created_at  INTEGER NOT NULL                       -- ms
);

-- role   owner | operator | viewer. scope   all | energy (see data) | control (command only, sees no data).
-- valid_from, valid_to (s): the period of the home's data the grant shows; NULL = no limit.
-- revoked_at (ms): a revoked grant gives no access, history included (access is evaluated now).
CREATE TABLE IF NOT EXISTS site_grant (
  id          INTEGER PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  scope       TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'energy', 'control')),
  valid_from  INTEGER,
  valid_to    INTEGER,
  granted_by  INTEGER REFERENCES app_user(id),
  recorded_at INTEGER NOT NULL,                      -- ms
  revoked_at  INTEGER,                               -- ms
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS site_grant_user ON site_grant (user_id, site_id);
CREATE INDEX IF NOT EXISTS site_grant_site ON site_grant (site_id);

CREATE TABLE IF NOT EXISTS site_group (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) > 0),
  owner_id    INTEGER NOT NULL REFERENCES app_user(id),
  timezone    TEXT NOT NULL CHECK (length(timezone) > 0),   -- the one zone the group's days are cut in
  created_at  INTEGER NOT NULL                              -- ms
);

CREATE TABLE IF NOT EXISTS site_group_member (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES site_group(id) ON DELETE CASCADE,
  site_id       INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  valid_from    INTEGER,                                    -- s; NULL = from the beginning
  valid_to      INTEGER,                                    -- s; NULL = still a member
  recorded_at   INTEGER NOT NULL,                           -- ms
  superseded_at INTEGER,                                    -- ms
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS site_group_member_group ON site_group_member (group_id, site_id);

CREATE TABLE IF NOT EXISTS group_grant (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES site_group(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  recorded_at INTEGER NOT NULL,                             -- ms
  revoked_at  INTEGER                                       -- ms
);
CREATE INDEX IF NOT EXISTS group_grant_user ON group_grant (user_id, group_id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('070-groups', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
