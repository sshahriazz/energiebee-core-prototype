-- Stable identity (fix list R3, plan rule 6): homes, devices and connections get a uid beside their integer id. The integer
-- is internal (it changes when data is copied or merged); the uid is the identity for APIs, hubs and exports. A UUIDv7 is
-- unique and sorts by creation time. A hub that discovers a device creates the device's uid and sends it; otherwise the
-- database makes one. A uid never changes. Things and points get theirs when they arrive (Phase 1.1).
ALTER TABLE site ADD COLUMN uid uuid NOT NULL DEFAULT uuidv7();
ALTER TABLE device ADD COLUMN uid uuid NOT NULL DEFAULT uuidv7();
ALTER TABLE connection ADD COLUMN uid uuid NOT NULL DEFAULT uuidv7();
ALTER TABLE site ADD CONSTRAINT site_uid_key UNIQUE (uid);
ALTER TABLE device ADD CONSTRAINT device_uid_key UNIQUE (uid);
ALTER TABLE connection ADD CONSTRAINT connection_uid_key UNIQUE (uid);

CREATE FUNCTION trg_uid_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'uid never changes (it is the identity outside this database)';
END $$;
CREATE TRIGGER site_uid_fixed BEFORE UPDATE OF uid ON site FOR EACH ROW WHEN (NEW.uid IS DISTINCT FROM OLD.uid) EXECUTE FUNCTION trg_uid_fixed();
CREATE TRIGGER device_uid_fixed BEFORE UPDATE OF uid ON device FOR EACH ROW WHEN (NEW.uid IS DISTINCT FROM OLD.uid) EXECUTE FUNCTION trg_uid_fixed();
CREATE TRIGGER connection_uid_fixed BEFORE UPDATE OF uid ON connection FOR EACH ROW WHEN (NEW.uid IS DISTINCT FROM OLD.uid) EXECUTE FUNCTION trg_uid_fixed();
