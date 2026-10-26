-- Delta 023: catalogue references on the planner registries, and the rows of their first seed
-- brought up to date. Applied after 022 by db.js, once (its name is recorded in schema_delta).
-- Same applying rules as 002-022: statements end with ';' at the end of a line, an ADD COLUMN whose
-- column exists is skipped, and every other statement may be run again (the deletes are guarded
-- by schema_delta: first application only).
--
-- refs (attribute_def, setting_def): a JSON list of the ids in docs/predbat-predheat-requirements.md
--   that a key covers (PB-INV-13, PH-MOD-01 ...), so the coverage check can map catalogue items to
--   registry keys. NULL on rows added by hand.
--
-- The first seed of these registries (deltas 020 and 021, the same day) was written before the
-- sourced catalogue existed: several defaults, ranges, kinds and names were from memory and are
-- now corrected in src/db/seed/attributes.js and src/db/seed/settings.js. Seeds never change an
-- existing row, so on its first application this delta removes the rows of that first seed that
-- nothing uses yet (no value recorded under the key, no home setting), and db.js's seed inserts the
-- current rows right after. A row with values keeps its first-seed text. device_kind rows are
-- replaced the same way (a device's kind is checked only when a device is written).

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

ALTER TABLE attribute_def ADD COLUMN refs TEXT CHECK (refs IS NULL OR (json_valid(refs) AND json_type(refs) = 'array'));
ALTER TABLE setting_def ADD COLUMN refs TEXT CHECK (refs IS NULL OR (json_valid(refs) AND json_type(refs) = 'array'));

DELETE FROM attribute_def
  WHERE refs IS NULL AND NOT EXISTS (SELECT 1 FROM attribute_value v WHERE v.key = attribute_def.key)
    AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '023-registry-refs');

DELETE FROM setting_def
  WHERE refs IS NULL AND NOT EXISTS (SELECT 1 FROM site_setting s WHERE s.key = setting_def.key)
    AND NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '023-registry-refs');

DELETE FROM device_kind
  WHERE NOT EXISTS (SELECT 1 FROM schema_delta WHERE name = '023-registry-refs');

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('023-registry-refs', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
