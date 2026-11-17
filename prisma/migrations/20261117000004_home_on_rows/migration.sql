-- Every series and fact knows its home (fix list R4, plan rule 6): site_id is stored on the row, set once on insert, never
-- derived at read time, so deleting a home, access checks, per-home queries and later partitioning and row-level security
-- need no join. Slots (site_hh, site_day, site_heat_slot, check_result) and raw rows (raw_payload) already carry it.
-- A series' home is its subject's: the home itself, or the home of the device. A region's series is shared context: no home.
-- A fact's home is its series'. The column is site_id like every other home column; it becomes home_id with the rest
-- when the site is folded into the home thing (Phase 1.3).
ALTER TABLE series ADD COLUMN site_id bigint REFERENCES site(id) DEFERRABLE;
UPDATE series SET site_id = CASE subject_kind WHEN 'site' THEN subject_id::bigint
  WHEN 'device' THEN (SELECT d.site_id FROM device d WHERE d.id = subject_id::bigint) END;
CREATE INDEX series_site ON series (site_id) WHERE site_id IS NOT NULL;

ALTER TABLE reading ADD COLUMN site_id bigint REFERENCES site(id) DEFERRABLE;
ALTER TABLE interval_fact ADD COLUMN site_id bigint REFERENCES site(id) DEFERRABLE;
ALTER TABLE forecast_fact ADD COLUMN site_id bigint REFERENCES site(id) DEFERRABLE;
UPDATE reading f SET site_id = s.site_id FROM series s WHERE s.id = f.series_id AND s.site_id IS NOT NULL;
UPDATE interval_fact f SET site_id = s.site_id FROM series s WHERE s.id = f.series_id AND s.site_id IS NOT NULL;
UPDATE forecast_fact f SET site_id = s.site_id FROM series s WHERE s.id = f.series_id AND s.site_id IS NOT NULL;
CREATE INDEX reading_site ON reading (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX interval_fact_site ON interval_fact (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX forecast_fact_site ON forecast_fact (site_id) WHERE site_id IS NOT NULL;

CREATE FUNCTION trg_series_home() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE home bigint := CASE NEW.subject_kind WHEN 'site' THEN NEW.subject_id::bigint
  WHEN 'device' THEN (SELECT d.site_id FROM device d WHERE d.id = NEW.subject_id::bigint) END;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.site_id IS NULL THEN NEW.site_id := home; END IF;
  IF NEW.site_id IS DISTINCT FROM home THEN RAISE EXCEPTION 'series home differs from the home of its subject'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER series_home BEFORE INSERT OR UPDATE OF subject_kind, subject_id, site_id ON series FOR EACH ROW EXECUTE FUNCTION trg_series_home();

CREATE FUNCTION trg_fact_home() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE home bigint := (SELECT s.site_id FROM series s WHERE s.id = NEW.series_id);
BEGIN
  IF TG_OP = 'INSERT' AND NEW.site_id IS NULL THEN NEW.site_id := home; END IF;
  IF NEW.site_id IS DISTINCT FROM home THEN RAISE EXCEPTION 'fact home differs from the home of its series'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reading_home BEFORE INSERT OR UPDATE OF series_id, site_id ON reading FOR EACH ROW EXECUTE FUNCTION trg_fact_home();
CREATE TRIGGER interval_fact_home BEFORE INSERT OR UPDATE OF series_id, site_id ON interval_fact FOR EACH ROW EXECUTE FUNCTION trg_fact_home();
CREATE TRIGGER forecast_fact_home BEFORE INSERT OR UPDATE OF series_id, site_id ON forecast_fact FOR EACH ROW EXECUTE FUNCTION trg_fact_home();
