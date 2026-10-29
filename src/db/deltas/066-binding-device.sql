-- Delta 066: a binding may name one device, so two devices of one kind (two inverters, two batteries) are
-- two bindings of the same role at the same time and their figures are added. NULL = the home itself
-- (one inverter that reports as the home). Same applying rules as 002-065.
ALTER TABLE binding ADD COLUMN device_id INTEGER REFERENCES device(id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('066-binding-device', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
