-- Delta 031: the control path as data (docs/hardening-and-planning-plan.md B7). TABLES ONLY, NO
-- EXECUTOR YET: nothing in the core sends a command to a device. Helpers: src/core/commands.js.
-- Applied after 030 (it refers to device_capability and plan_run). Same applying rules as 002-030:
-- statements end with ';' at the end of a line, a trigger ends with a line 'END;', and every
-- statement may be run again.
--
-- A command is the desired state of ONE device for a period, in vendor-neutral terms. The executor
-- (not built) sends it only when it differs from the last state the device confirmed, drops it
-- once valid_until has passed (a late command is never applied), and marks it acked only when the
-- device's read-back matches. Units: *_at ms; valid_from, valid_until, window_start, window_end s.
--
-- PostgreSQL port: jsonb for desired, reported and diff; the partial unique index command_open
-- ports as it is; the triggers become plpgsql BEFORE INSERT / UPDATE functions (the status flow as
-- a CASE on OLD.status); command_log append-only by REVOKE UPDATE, DELETE plus the same triggers;
-- command partitioned by requested_at if it grows; row-level security through device.site_id.

CREATE TABLE IF NOT EXISTS schema_delta (
  name        TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL                 -- ms
) WITHOUT ROWID;

-- desired     the whole neutral desired state (canonical JSON, keys sorted); the typed columns are
--             copies of its main fields for querying: action, window_start / window_end (the
--             charge or export window), target_soc_pct, limit_pct (an export floor, a current
--             limit), rate_w, setpoint_c, mode
-- status      pending -> sent -> acked; a pending or sent one can fail (failed, or back to pending
--             for a retry), expire (valid_until passed), be cancelled (superseded by a newer
--             desired state), or be skipped_unchanged (the device already runs it: nothing written)
-- acked_at    when the device was confirmed to run the desired state (acked or skipped_unchanged)
-- reported    what the device says it runs (its read-back), readback_raw_id the raw payload of it
-- diff        desired minus reported: {field: {desired, reported}} for each field that differs
CREATE TABLE IF NOT EXISTS command (
  id                     INTEGER PRIMARY KEY,
  plan_run_id            INTEGER REFERENCES plan_run(id) ON DELETE SET NULL,
  device_id              INTEGER NOT NULL REFERENCES device(id),
  requested_at           INTEGER NOT NULL,                  -- ms
  valid_from             INTEGER NOT NULL,                  -- s
  valid_until            INTEGER NOT NULL,                  -- s: never sent after this
  action                 TEXT NOT NULL,
  window_start           INTEGER CHECK (window_start IS NULL OR window_start % 60 = 0),
  window_end             INTEGER CHECK (window_end IS NULL OR window_end % 60 = 0),
  target_soc_pct         REAL CHECK (target_soc_pct IS NULL OR target_soc_pct BETWEEN 0 AND 100),
  limit_pct              REAL CHECK (limit_pct IS NULL OR limit_pct BETWEEN 0 AND 100),
  rate_w                 REAL CHECK (rate_w IS NULL OR rate_w >= 0),
  setpoint_c             REAL CHECK (setpoint_c IS NULL OR setpoint_c BETWEEN 0 AND 95),
  mode                   TEXT,
  desired                TEXT NOT NULL CHECK (json_valid(desired)),
  desired_hash           TEXT NOT NULL CHECK (length(desired_hash) > 0),
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'acked', 'failed', 'expired', 'cancelled', 'skipped_unchanged')),
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error             TEXT,
  sent_at                INTEGER,                           -- ms
  acked_at               INTEGER,                           -- ms
  readback_raw_id        INTEGER REFERENCES raw_payload(id),
  reported               TEXT CHECK (reported IS NULL OR json_valid(reported)),
  diff                   TEXT CHECK (diff IS NULL OR json_valid(diff)),
  idempotency_key        TEXT NOT NULL UNIQUE,
  supersedes_command_id  INTEGER REFERENCES command(id),
  CHECK (valid_until > valid_from),
  CHECK (window_start IS NULL OR window_end IS NULL OR window_end > window_start),
  CHECK (status NOT IN ('sent', 'acked') OR sent_at IS NOT NULL),
  CHECK (status NOT IN ('acked', 'skipped_unchanged') OR acked_at IS NOT NULL)
);
-- At most one open (pending or sent) command per device: a newer desired state cancels the old one.
CREATE UNIQUE INDEX IF NOT EXISTS command_open ON command (device_id) WHERE status IN ('pending', 'sent');
CREATE INDEX IF NOT EXISTS command_device_acked ON command (device_id, acked_at) WHERE status IN ('acked', 'skipped_unchanged');
CREATE INDEX IF NOT EXISTS command_expiry ON command (valid_until) WHERE status IN ('pending', 'sent');
CREATE INDEX IF NOT EXISTS command_plan_run ON command (plan_run_id) WHERE plan_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS command_supersedes ON command (supersedes_command_id) WHERE supersedes_command_id IS NOT NULL;

-- Created only pending, only for an action the device is known to deliver (device_capability
-- supported = 1), only for a plan of the same home, and never already expired.
CREATE TRIGGER IF NOT EXISTS command_checks
BEFORE INSERT ON command
BEGIN
  SELECT RAISE(ABORT, 'command: the device cannot deliver this action (no device_capability row with supported = 1)')
  WHERE NOT EXISTS (SELECT 1 FROM device_capability c WHERE c.device_id = NEW.device_id AND c.action = NEW.action AND c.supported = 1);
  SELECT RAISE(ABORT, 'command: the plan run belongs to another home')
  WHERE NEW.plan_run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plan_run r JOIN device d ON d.site_id = r.site_id WHERE r.id = NEW.plan_run_id AND d.id = NEW.device_id);
  SELECT RAISE(ABORT, 'command: a new command starts pending')
  WHERE NEW.status <> 'pending';
  SELECT RAISE(ABORT, 'command: already expired when requested (valid_until passed)')
  WHERE NEW.valid_until * 1000 <= NEW.requested_at;
END;

CREATE TRIGGER IF NOT EXISTS command_desired_fixed
BEFORE UPDATE ON command
WHEN NEW.device_id IS NOT OLD.device_id OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_until IS NOT OLD.valid_until OR NEW.action IS NOT OLD.action
  OR NEW.window_start IS NOT OLD.window_start OR NEW.window_end IS NOT OLD.window_end
  OR NEW.target_soc_pct IS NOT OLD.target_soc_pct OR NEW.limit_pct IS NOT OLD.limit_pct OR NEW.rate_w IS NOT OLD.rate_w
  OR NEW.setpoint_c IS NOT OLD.setpoint_c OR NEW.mode IS NOT OLD.mode OR NEW.desired IS NOT OLD.desired
  OR NEW.desired_hash IS NOT OLD.desired_hash OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.supersedes_command_id IS NOT OLD.supersedes_command_id
BEGIN
  SELECT RAISE(ABORT, 'command: the desired state is fixed (a changed state is a new command)');
END;

CREATE TRIGGER IF NOT EXISTS command_status_flow
BEFORE UPDATE OF status ON command
WHEN NEW.status <> OLD.status
  AND NOT ((OLD.status = 'pending' AND NEW.status IN ('sent', 'failed', 'expired', 'cancelled', 'skipped_unchanged'))
        OR (OLD.status = 'sent' AND NEW.status IN ('acked', 'failed', 'expired', 'cancelled', 'pending')))
BEGIN
  SELECT RAISE(ABORT, 'command: status change not allowed (acked, failed, expired, cancelled and skipped_unchanged are final)');
END;

CREATE TRIGGER IF NOT EXISTS command_never_late
BEFORE UPDATE OF status ON command
WHEN NEW.status = 'sent' AND OLD.status <> 'sent' AND (NEW.sent_at IS NULL OR NEW.sent_at > NEW.valid_until * 1000)
BEGIN
  SELECT RAISE(ABORT, 'command: past valid_until, dropped (a late command is never sent)');
END;

-- Every step of every command, append-only. Also where the executor writes what it observes
-- (event 'observed': Predbat's derived states such as hold charging), which are never planned.
CREATE TABLE IF NOT EXISTS command_log (
  id          INTEGER PRIMARY KEY,
  command_id  INTEGER NOT NULL REFERENCES command(id),
  at          INTEGER NOT NULL,                       -- ms
  event       TEXT NOT NULL CHECK (event IN ('enqueued', 'sent', 'acked', 'readback', 'retry', 'failed', 'expired', 'cancelled', 'skipped_unchanged', 'observed')),
  detail      TEXT CHECK (detail IS NULL OR json_valid(detail))
);
CREATE INDEX IF NOT EXISTS command_log_command ON command_log (command_id, at);

CREATE TRIGGER IF NOT EXISTS command_log_no_update
BEFORE UPDATE ON command_log
BEGIN
  SELECT RAISE(ABORT, 'command_log: append-only');
END;

CREATE TRIGGER IF NOT EXISTS command_log_no_delete
BEFORE DELETE ON command_log
BEGIN
  SELECT RAISE(ABORT, 'command_log: append-only');
END;

INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('031-command', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
