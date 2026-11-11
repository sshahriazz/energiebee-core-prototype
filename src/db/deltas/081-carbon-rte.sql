-- Delta 081: grid carbon for France, RTE éCO2mix (src/adapters/rte.js, source rte_eco2mix, one national series
-- carbon:FR). Applied after 080 by db.js, once. Same applying rules as 002-080: statements end with ';' at the end
-- of a line, and every statement may be run again.
--
-- The 'carbon' role gets a second default source, after NESO (priority 1): several sources of a role apply together
-- and the first with a value for a period wins (delta 062). A GB home's series (its NESO region) has no RTE values,
-- so it keeps reading NESO exactly as before; a French home's national series has no NESO values, so it reads RTE.
-- New homes take both from binding_default (the 062 trigger); homes that exist and already have a carbon source get
-- the RTE binding here, recorded at 0 like every default (known from the start, so a build "as known at" any moment
-- reads the same sources). A home with no carbon binding at all is left to db.js seedBindings, which gives it every
-- default of the role (NESO and RTE): binding it to RTE here would make it look bound and keep NESO from it.
-- The source row is written by db.js seedRegistry before the deltas run.

INSERT OR IGNORE INTO binding_default (role, source_id, priority)
  SELECT 'carbon', id, 1 FROM source WHERE code = 'rte_eco2mix';

INSERT INTO binding (site_id, role, source_id, valid_from, valid_to, recorded_at, priority, reason)
  SELECT s.id, 'carbon', so.id, NULL, NULL, 0, 1, 'default: national grid carbon where no regional source covers the home (RTE éCO2mix for France)'
  FROM site s JOIN source so ON so.code = 'rte_eco2mix'
  WHERE EXISTS (SELECT 1 FROM binding b WHERE b.site_id = s.id AND b.role = 'carbon')
    AND NOT EXISTS (SELECT 1 FROM binding b WHERE b.site_id = s.id AND b.role = 'carbon' AND b.source_id = so.id);

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('081-carbon-rte', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
