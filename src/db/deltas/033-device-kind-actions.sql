-- Delta 033: keep the device kind registry (device_kind.action_codes, delta 020) in line with the
-- actions delta 032 added to device_action: 'release' for the battery kinds and 'auto' (no
-- instruction, the default) for the other controllable kinds. A new database gets them from
-- src/db/seed/attributes.js (seeded after the deltas, so these statements change no row there);
-- a database whose kinds were seeded before 032 gets them here, once. Appended only where missing.
-- Same applying rules as 002-032: statements end with ';' at the end of a line, and every
-- statement may be run again.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

UPDATE device_kind SET action_codes = json_insert(action_codes, '$[#]', 'release')
  WHERE kind IN ('battery', 'inverter')
    AND NOT EXISTS (SELECT 1 FROM json_each(device_kind.action_codes) j WHERE j.value = 'release');

UPDATE device_kind SET action_codes = json_insert(action_codes, '$[#]', 'auto')
  WHERE kind IN ('ev_charger', 'immersion', 'iboost', 'heat_pump', 'boiler', 'thermostat', 'trv', 'hot_water')
    AND NOT EXISTS (SELECT 1 FROM json_each(device_kind.action_codes) j WHERE j.value = 'auto');

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('033-device-kind-actions', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
