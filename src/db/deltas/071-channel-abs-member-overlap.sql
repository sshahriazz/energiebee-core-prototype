-- Delta 071: (1) channel.part gains 'abs' (the magnitude of a value of either sign: a supplier that reports
-- a charge as a negative number, or either direction, stores a positive amount). A CHECK cannot be altered, so
-- the table is rebuilt and its rows copied back unchanged. (2) A home cannot be in the same group twice at
-- once: overlapping current membership rows are refused, on insert and on update.
-- Same applying rules as 002-070.
CREATE TABLE channel_rebuilt (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES site(id),
  source_id     INTEGER NOT NULL REFERENCES source(id),
  point         TEXT NOT NULL,
  metric_id     INTEGER NOT NULL REFERENCES metric(id),
  scale         REAL NOT NULL DEFAULT 1,
  shift         REAL NOT NULL DEFAULT 0,
  part          TEXT NOT NULL DEFAULT 'all' CHECK (part IN ('all', 'positive', 'negative', 'abs')),
  min_value     REAL,
  max_value     REAL,
  recorded_at   INTEGER NOT NULL,
  superseded_at INTEGER,
  device_id     INTEGER REFERENCES device(id),
  access        TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write', 'readwrite')),
  enum_values   TEXT CHECK (enum_values IS NULL OR json_valid(enum_values))
);
INSERT INTO channel_rebuilt (id, site_id, source_id, point, metric_id, scale, shift, part, min_value, max_value, recorded_at, superseded_at, device_id, access, enum_values)
  SELECT id, site_id, source_id, point, metric_id, scale, shift, part, min_value, max_value, recorded_at, superseded_at, device_id, access, enum_values FROM channel;
DROP TABLE channel;
ALTER TABLE channel_rebuilt RENAME TO channel;
CREATE INDEX IF NOT EXISTS ix_channel_site_source ON channel(site_id, source_id, point);

CREATE TRIGGER IF NOT EXISTS member_no_overlap_insert
BEFORE INSERT ON site_group_member
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current membership of this home in the group')
  WHERE EXISTS (
    SELECT 1 FROM site_group_member m
    WHERE m.group_id = NEW.group_id AND m.site_id = NEW.site_id AND m.superseded_at IS NULL
      AND IFNULL(m.valid_from, -9000000000) < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(m.valid_to, 9000000000) > IFNULL(NEW.valid_from, -9000000000));
END;

CREATE TRIGGER IF NOT EXISTS member_no_overlap_update
BEFORE UPDATE OF group_id, site_id, valid_from, valid_to, superseded_at ON site_group_member
WHEN NEW.superseded_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'overlapping current membership of this home in the group')
  WHERE EXISTS (
    SELECT 1 FROM site_group_member m
    WHERE m.id <> OLD.id AND m.group_id = NEW.group_id AND m.site_id = NEW.site_id AND m.superseded_at IS NULL
      AND IFNULL(m.valid_from, -9000000000) < IFNULL(NEW.valid_to, 9000000000)
      AND IFNULL(m.valid_to, 9000000000) > IFNULL(NEW.valid_from, -9000000000));
END;

-- (3) The charge effect check knows when there is nothing to verify: a battery already at the target draws no
-- power. already = {metric, targetKeys}: the level before the window, against the first target key the command has.
UPDATE device_action SET effect_check = json_set(effect_check, '$.already', json('{"metric":"battery_soc_pct","targetKeys":["target_soc_pct","limit_pct"]}'))
  WHERE action = 'charge' AND device_kind IN ('battery', 'inverter') AND effect_check IS NOT NULL AND json_extract(effect_check, '$.already') IS NULL;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('071-channel-abs-member-overlap', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
