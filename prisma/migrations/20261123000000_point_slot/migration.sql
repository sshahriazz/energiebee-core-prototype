-- Phase 3.1: a point's timeline (docs/build/timelines.md). One row per slot of the home's grid, by the point's class; serving data,
-- rebuilt from the facts.
CREATE TABLE point_slot (
  point_id bigint NOT NULL REFERENCES point (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  slot_start bigint NOT NULL,                              -- s, on the home's slot grid
  dur_s bigint NOT NULL CHECK (dur_s IN (900, 1800, 3600)),
  mean double precision,                                   -- measurement: time-weighted over the covered time
  min double precision,
  max double precision,
  last double precision,                                   -- the value at the end of the slot, or in force
  delta double precision,                                  -- total: the amount in the slot; event: how many touched it
  state_shares jsonb CHECK (state_shares IS NULL OR jsonb_typeof(state_shares) = 'object'),
  state text,                                              -- state: the value held longest
  coverage double precision NOT NULL CHECK (coverage >= 0 AND coverage <= 1),   -- the share of the slot the data speaks for
  lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),             -- which series (source) the slot came from
  method_version bigint NOT NULL,
  built_at bigint NOT NULL,
  PRIMARY KEY (point_id, slot_start)
);

-- Phase 3.3: a place's timeline. Spaces, systems and the home get slots of their own, rolled up from what is in them.
CREATE TABLE node_slot (
  thing_id bigint NOT NULL REFERENCES thing (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  slot_start bigint NOT NULL,
  dur_s bigint NOT NULL CHECK (dur_s IN (900, 1800, 3600)),
  metric text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]*$'),     -- energy_kwh, temperature_c, home_kwh, untracked_kwh
  value double precision,
  coverage double precision NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
  state text NOT NULL CHECK (state IN ('final', 'partial', 'missing')),     -- only the members a relation marks required decide it
  lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
  method_version bigint NOT NULL,
  built_at bigint NOT NULL,
  PRIMARY KEY (thing_id, slot_start, metric)
);
