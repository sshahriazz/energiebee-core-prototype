-- Phase 2.8 and 2.9: derived point definitions, and the state of each point (docs/build/points.md).

-- The derived points the core knows: a formula over points of the home (src/core/derived.js); rows come from src/db/seed/derived.js.
CREATE TABLE derived_def (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL CHECK (length(label) > 0),
  metric text NOT NULL,                                                     -- the metric its values are stored as
  formula text NOT NULL CHECK (length(btrim(formula)) > 0),
  inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),            -- { name: { metric, optional? } | { derived: code } }
  description text
);

-- The state of a point: what it last reported, and what was asked of it. Working state, rebuilt from the facts when it is lost.
CREATE TABLE point_state (
  point_id bigint PRIMARY KEY REFERENCES point (id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  reported_value double precision,
  reported_ts bigint,                                                       -- when the value was true (s)
  reported_source_id bigint REFERENCES source (id) DEFERRABLE INITIALLY IMMEDIATE,
  reported_at bigint,                                                       -- when the core stored it (ms)
  desired_value double precision,
  desired_ts bigint,                                                        -- when it was asked (s)
  desired_by text,                                                          -- a command, a schedule, a person
  desired_command_id bigint,
  updated_at bigint NOT NULL,
  CONSTRAINT point_state_desired_asked CHECK (desired_ts IS NOT NULL OR (desired_value IS NULL AND desired_by IS NULL AND desired_command_id IS NULL))
);
