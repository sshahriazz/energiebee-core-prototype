-- Limits have a ranking (fix list R17, plan 4.3): who set a limit decides whether it can be loosened.
--   physical   the device's own maximums (from its adapter or vendor documents)
--   legal      what the law or the network operator allows (the export limit of a G98/G99 approval)
--   installer  what the installer set for this installation
--   owner      what the owner chose
--   optimiser  what the optimiser holds itself to
-- A lower source can only tighten: a bound it states that is looser than a current one of a higher source, for the same device, parameter
-- and action, at an overlapping time, is refused. All current limits apply at once (core: control.js effectiveLimit).
-- source was the evidence (adapter, vendor_doc, installer, user); the evidence is now `basis`.
ALTER TABLE control_limit DROP CONSTRAINT control_limit_source_check;
ALTER TABLE control_limit ADD COLUMN basis text;
UPDATE control_limit SET basis = source, source = CASE source WHEN 'adapter' THEN 'physical' WHEN 'vendor_doc' THEN 'physical' WHEN 'user' THEN 'owner' ELSE source END;
ALTER TABLE control_limit ADD CONSTRAINT control_limit_source_check CHECK (source IN ('physical', 'legal', 'installer', 'owner', 'optimiser'));
ALTER TABLE control_limit ADD CONSTRAINT control_limit_basis_check CHECK (basis IS NULL OR length(basis) > 0);

CREATE FUNCTION limit_rank(source text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE source WHEN 'physical' THEN 1 WHEN 'legal' THEN 2 WHEN 'installer' THEN 3 WHEN 'owner' THEN 4 WHEN 'optimiser' THEN 5 END
$$;

CREATE FUNCTION trg_control_limit_ranked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.superseded_at IS NOT NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM control_limit h
      WHERE h.device_id = NEW.device_id AND h.param = NEW.param AND h.id IS DISTINCT FROM NEW.id AND h.superseded_at IS NULL
        AND (h.action IS NULL OR NEW.action IS NULL OR h.action = NEW.action)
        AND limit_rank(h.source) < limit_rank(NEW.source)
        AND h.valid_from < COALESCE(NEW.valid_to, 9000000000000) AND COALESCE(h.valid_to, 9000000000000) > NEW.valid_from
        AND ((h.max_value IS NOT NULL AND NEW.max_value > h.max_value) OR (h.min_value IS NOT NULL AND NEW.min_value < h.min_value))) THEN
    RAISE EXCEPTION 'control_limit: a lower source can only tighten a higher one (physical > legal > installer > owner > optimiser)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER control_limit_ranked BEFORE INSERT OR UPDATE OF min_value, max_value, source, valid_from, valid_to, superseded_at, action, param, device_id
  ON control_limit FOR EACH ROW EXECUTE FUNCTION trg_control_limit_ranked();
