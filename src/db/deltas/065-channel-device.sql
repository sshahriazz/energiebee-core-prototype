-- Delta 065: a channel may belong to one device (a meter's consumption point -> that meter's metric), so a
-- vendor whose facts are stored per device goes through the same channel rows. NULL = the home itself.
-- Same applying rules as 002-064.
ALTER TABLE channel ADD COLUMN device_id INTEGER REFERENCES device(id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('065-channel-device', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
