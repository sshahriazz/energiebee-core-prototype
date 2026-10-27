-- Delta 062: every role is bound, none falls back to a vendor named in code. binding_default holds the
-- sources a new home starts with (rows seeded by src/db/seed/bindings.js; an operator can edit them);
-- the trigger copies them to each new home (recorded_at 0: a default is known from the start, so a build
-- "as known at" any moment sees it), and the seed fills homes that have none. priority orders
-- several sources of one role that apply together (the first that has a value for a period wins).
-- Same applying rules as 002-061.
ALTER TABLE binding ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS binding_default (
  role      TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES source(id),
  priority  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, source_id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS site_default_bindings
AFTER INSERT ON site
BEGIN
  INSERT INTO binding (site_id, role, source_id, valid_from, valid_to, recorded_at, priority, reason)
  SELECT NEW.id, d.role, d.source_id, NULL, NULL, 0, d.priority, 'default for a new home'
  FROM binding_default d;
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('062-binding-defaults', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
