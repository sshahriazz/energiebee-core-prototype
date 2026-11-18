-- Things are the identity of homes and devices (plan Phase 1.3 and 1.3b, in their lean form).
--
-- Every home and every device is a row of `thing` with the same id: a home thing has the id of its site row, a device thing the id
-- of its device row. `site` and `device` stay as the typed detail tables of those things (class-table inheritance): the home's
-- settings and their versions, the device's provider, external reference, attributes. Creating a site or a device creates its
-- thing (a trigger), so no insert path changes; deleting a site or a device deletes its thing. One id space, one uid per entity,
-- relations, spaces and systems can name any of them, and every table that names a device now references the device THING.
--
-- Nothing old is kept (owner decision of 18 November): the data conversion below is the plain minimum. Device ids move up by G
-- (the largest site or device id) so they cannot meet a home id; every table that names a device follows. Facts are not touched
-- (they name the home, which keeps its id). thing and its family name the home as home_id (a thing), not as site_id.

-- ───────────── 0. the thing family is empty before the conversion ─────────────
TRUNCATE thing_op, thing_relation, thing_attr_version, thing;

-- ───────────── 1. the thing family names its home as home_id, a thing ─────────────
ALTER TABLE thing DROP CONSTRAINT thing_site_id_fkey;
ALTER TABLE thing_attr_version DROP CONSTRAINT thing_attr_version_site_id_fkey;
ALTER TABLE thing_relation DROP CONSTRAINT thing_relation_site_id_fkey;
ALTER TABLE thing_op DROP CONSTRAINT thing_op_site_id_fkey;
ALTER TABLE thing RENAME COLUMN site_id TO home_id;
ALTER TABLE thing_attr_version RENAME COLUMN site_id TO home_id;
ALTER TABLE thing_relation RENAME COLUMN site_id TO home_id;
ALTER TABLE thing_op RENAME COLUMN site_id TO home_id;
-- (one home thing per home is now a fact of the key: a home thing is its own home, thing_home_rules)
DROP INDEX thing_one_home;
ALTER INDEX thing_site RENAME TO thing_home;
ALTER INDEX thing_attr_version_site RENAME TO thing_attr_version_home;
ALTER INDEX thing_relation_site RENAME TO thing_relation_home;
ALTER INDEX thing_op_site RENAME TO thing_op_home;
ALTER TABLE thing ADD CONSTRAINT thing_home_id_fkey FOREIGN KEY (home_id) REFERENCES thing (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE thing_attr_version ADD CONSTRAINT thing_attr_version_home_id_fkey FOREIGN KEY (home_id) REFERENCES thing (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE thing_relation ADD CONSTRAINT thing_relation_home_id_fkey FOREIGN KEY (home_id) REFERENCES thing (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE thing_op ADD CONSTRAINT thing_op_home_id_fkey FOREIGN KEY (home_id) REFERENCES thing (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- The functions of the family name the same column: the bodies are rewritten from their own definitions (every site_id in them is
-- a column of a thing table; the site row they read is the home thing's detail row, the same id).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['trg_thing_attr_version_on_insert', 'trg_thing_attr_version_on_update', 'trg_thing_relation_checks', 'trg_thing_merge_checks', 'trg_thing_op_home'] LOOP
    EXECUTE replace((SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = f AND pronamespace = 'public'::regnamespace), 'site_id', 'home_id');
  END LOOP;
END $$;

-- A home thing is its own home; every other thing except shared context belongs to a live home thing. (Replaces thing_home_exists.)
DROP TRIGGER thing_home_exists ON thing;
DROP FUNCTION trg_thing_home_exists();
CREATE FUNCTION trg_thing_home_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'home' THEN
    IF NEW.home_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'a home thing is its own home: home_id equals its id'; END IF;
  ELSIF NEW.kind <> 'context' THEN
    IF NOT EXISTS (SELECT 1 FROM thing h WHERE h.id = NEW.home_id AND h.kind = 'home' AND h.superseded_at IS NULL) THEN
      RAISE EXCEPTION 'a thing belongs to a live home thing: home_id must name a thing of kind home';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER thing_home_rules BEFORE INSERT OR UPDATE OF home_id, kind ON thing FOR EACH ROW EXECUTE FUNCTION trg_thing_home_rules();

-- The home's clock is the site row's (its detail row): a home thing that names either must name the site's.
CREATE OR REPLACE FUNCTION trg_thing_home_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s site%ROWTYPE;
BEGIN
  SELECT * INTO s FROM site WHERE id = NEW.home_id;
  IF NEW.attrs->'slot_s' IS NOT NULL AND NEW.attrs->'slot_s' IS DISTINCT FROM to_jsonb(s.slot_s) THEN
    RAISE EXCEPTION 'the slot length of a home thing is the slot length of its site (change it on the site)';
  END IF;
  IF NEW.attrs->'timezone' IS NOT NULL AND NEW.attrs->'timezone' IS DISTINCT FROM to_jsonb(s.timezone) THEN
    RAISE EXCEPTION 'the time zone of a home thing is the time zone of its site (change it on the site)';
  END IF;
  RETURN NEW;
END $$;

-- ───────────── 2. device ids above home ids ─────────────
-- Tables that name a device point at the device THING from here on; their keys are dropped now and put back on thing(id) at the end.
CREATE TEMP TABLE fold_device_keys ON COMMIT DROP AS
  SELECT c.conrelid::regclass::text AS tbl, c.conname, a.attname AS col, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.confrelid = 'device'::regclass;

DO $$
DECLARE r record; g bigint;
BEGIN
  FOR r IN SELECT * FROM fold_device_keys LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
  g := GREATEST(COALESCE((SELECT MAX(id) FROM site), 0), COALESCE((SELECT MAX(id) FROM device), 0));
  IF g > 0 THEN
    -- rows of these tables are rewritten in place: their append-only and fixed-field triggers stand aside for this statement only
    FOR r IN SELECT DISTINCT tbl FROM fold_device_keys UNION SELECT 'device' UNION SELECT 'series' LOOP
      EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', r.tbl);
    END LOOP;
    FOR r IN SELECT * FROM fold_device_keys LOOP
      EXECUTE format('UPDATE %s SET %I = %I + %s WHERE %I IS NOT NULL', r.tbl, r.col, r.col, g, r.col);
    END LOOP;
    UPDATE device SET id = id + g;
    UPDATE series SET subject_id = (subject_id::bigint + g)::text WHERE subject_kind = 'device';
    FOR r IN SELECT DISTINCT tbl FROM fold_device_keys UNION SELECT 'device' UNION SELECT 'series' LOOP
      EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', r.tbl);
    END LOOP;
  END IF;
END $$;

-- ───────────── 3. the things ─────────────
-- Types the conversion needs (the start-up seed brings labels, ports and attribute keys in line; a hot water device is a system).
INSERT INTO thing_type (type, kind, label) VALUES ('house', 'home', 'House') ON CONFLICT (type) DO NOTHING;
INSERT INTO thing_type (type, kind, label)
  SELECT dk.kind, CASE WHEN dk.kind = 'hot_water' THEN 'system' ELSE 'device' END, initcap(replace(dk.kind, '_', ' ')) FROM device_kind dk ON CONFLICT (type) DO NOTHING;

INSERT INTO thing (id, uid, home_id, kind, type, name, valid_from, recorded_at)
  SELECT s.id, s.uid, s.id, 'home', 'house', COALESCE(NULLIF(btrim(s.name), ''), 'Home'), s.created_at, s.created_at * 1000 FROM site s ORDER BY s.id;
INSERT INTO thing (id, uid, home_id, kind, type, name, valid_from, valid_to, recorded_at)
  SELECT d.id, d.uid, d.site_id, ty.kind, d.kind, COALESCE(NULLIF(btrim(d.label), ''), d.kind),
         d.recorded_at / 1000,
         CASE WHEN d.retired_at IS NULL THEN NULL ELSE GREATEST(d.retired_at / 1000, COALESCE(d.recorded_at, 0) / 1000 + 1) END,
         COALESCE(d.recorded_at, 0)
    FROM device d JOIN thing_type ty ON ty.type = d.kind ORDER BY d.id;
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM device) <> (SELECT COUNT(*) FROM thing WHERE kind IN ('device', 'system')) THEN
    RAISE EXCEPTION 'a device has no thing type: every device kind needs a thing_type row';
  END IF;
END $$;
SELECT setval(pg_get_serial_sequence('thing', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM thing), 0) + 1, 1), false);

-- ───────────── 4. site and device are the detail rows of their things ─────────────
ALTER TABLE site ALTER COLUMN id DROP IDENTITY IF EXISTS;
ALTER TABLE device ALTER COLUMN id DROP IDENTITY IF EXISTS;
ALTER TABLE site ADD CONSTRAINT site_id_thing_fkey FOREIGN KEY (id) REFERENCES thing (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE device ADD CONSTRAINT device_id_thing_fkey FOREIGN KEY (id) REFERENCES thing (id) DEFERRABLE INITIALLY IMMEDIATE;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM fold_device_keys LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, replace(r.def, 'REFERENCES device(id)', 'REFERENCES thing(id)'));
  END LOOP;
END $$;

-- A new id is the next of the one sequence, skipping an id someone gave explicitly.
CREATE FUNCTION thing_next_id() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  LOOP
    n := nextval(pg_get_serial_sequence('thing', 'id'));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM thing WHERE id = n);
  END LOOP;
  RETURN n;
END $$;

-- Creating a site creates its home thing; creating a device creates its device (or system) thing. The detail row's uid is the
-- thing's uid; the thing's name is the site's name or the device's label (its kind when it has none).
CREATE FUNCTION trg_site_make_thing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS NULL THEN NEW.id := thing_next_id(); END IF;
  INSERT INTO thing (id, uid, home_id, kind, type, name, valid_from)
    VALUES (NEW.id, NEW.uid, NEW.id, 'home', 'house', COALESCE(NULLIF(btrim(NEW.name), ''), 'Home'), NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER site_make_thing BEFORE INSERT ON site FOR EACH ROW EXECUTE FUNCTION trg_site_make_thing();

CREATE FUNCTION trg_device_make_thing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  -- a device row whose thing already exists is that thing's detail row (the library makes the thing first, with everything it needs)
  IF NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM thing WHERE id = NEW.id) THEN RETURN NEW; END IF;
  IF NEW.id IS NULL THEN NEW.id := thing_next_id(); END IF;
  -- a device kind added by one registry row has its thing type made from that row (the start-up seed brings the label, the ports and
  -- the attribute keys in line); a kind that is not registered at all is refused by the device row's own key
  INSERT INTO thing_type (type, kind, label) SELECT dk.kind, 'device', dk.label FROM device_kind dk WHERE dk.kind = NEW.kind ON CONFLICT (type) DO NOTHING;
  SELECT kind INTO k FROM thing_type WHERE type = NEW.kind;
  k := COALESCE(k, 'device');
  INSERT INTO thing (id, uid, home_id, kind, type, name, valid_from, valid_to, recorded_at)
    VALUES (NEW.id, NEW.uid, NEW.site_id, k, NEW.kind, COALESCE(NULLIF(btrim(NEW.label), ''), NEW.kind),
            NEW.recorded_at / 1000,
            CASE WHEN NEW.retired_at IS NULL THEN NULL ELSE GREATEST(NEW.retired_at / 1000, COALESCE(NEW.recorded_at, 0) / 1000 + 1) END,
            COALESCE(NEW.recorded_at, (extract(epoch FROM clock_timestamp()) * 1000)::bigint));
  RETURN NEW;
END $$;
CREATE TRIGGER device_make_thing BEFORE INSERT ON device FOR EACH ROW EXECUTE FUNCTION trg_device_make_thing();

-- A rename or a retirement of the detail row is the thing's too (the thing's own change of either is the library's, which writes
-- the detail row as well; a change that is already there writes nothing).
CREATE FUNCTION trg_site_sync_thing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE thing SET name = COALESCE(NULLIF(btrim(NEW.name), ''), 'Home') WHERE id = NEW.id AND name IS DISTINCT FROM COALESCE(NULLIF(btrim(NEW.name), ''), 'Home');
  RETURN NULL;
END $$;
CREATE TRIGGER site_sync_thing AFTER UPDATE OF name ON site FOR EACH ROW EXECUTE FUNCTION trg_site_sync_thing();

CREATE FUNCTION trg_device_sync_thing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nm text := COALESCE(NULLIF(btrim(NEW.label), ''), NEW.kind);
        vt bigint := CASE WHEN NEW.retired_at IS NULL THEN NULL ELSE GREATEST(NEW.retired_at / 1000, COALESCE(NEW.recorded_at, 0) / 1000 + 1) END;
BEGIN
  UPDATE thing SET name = nm, valid_to = COALESCE(vt, valid_to)
   WHERE id = NEW.id AND (name IS DISTINCT FROM nm OR (vt IS NOT NULL AND valid_to IS DISTINCT FROM vt));
  RETURN NULL;
END $$;
CREATE TRIGGER device_sync_thing AFTER UPDATE OF label, retired_at ON device FOR EACH ROW EXECUTE FUNCTION trg_device_sync_thing();

-- Deleting the detail row deletes the thing (and, for a home, every thing of the home: home_id cascades).
CREATE FUNCTION trg_detail_delete_thing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM thing WHERE id = OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER site_delete_thing AFTER DELETE ON site FOR EACH ROW EXECUTE FUNCTION trg_detail_delete_thing();
CREATE TRIGGER device_delete_thing AFTER DELETE ON device FOR EACH ROW EXECUTE FUNCTION trg_detail_delete_thing();

-- The detail row and its thing agree: the same id and uid, a home thing for a site; for a device a device or system thing of the
-- device's own home and kind.
CREATE FUNCTION trg_site_is_home() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM thing WHERE id = NEW.id AND uid = NEW.uid AND kind = 'home') THEN
    RAISE EXCEPTION 'a site is the detail of a home thing: the same id and uid';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER site_is_home AFTER INSERT OR UPDATE OF id, uid ON site DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION trg_site_is_home();

CREATE FUNCTION trg_device_is_thing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM thing WHERE id = NEW.id AND uid = NEW.uid AND kind IN ('device', 'system') AND type = NEW.kind AND home_id = NEW.site_id) THEN
    RAISE EXCEPTION 'a device is the detail of a device thing of its own home and kind: the same id and uid';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER device_is_thing AFTER INSERT OR UPDATE OF id, uid, kind, site_id ON device DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION trg_device_is_thing();
