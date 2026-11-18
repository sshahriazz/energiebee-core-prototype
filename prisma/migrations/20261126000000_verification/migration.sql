-- Devices that cannot report what they did (R23): each action a device can deliver declares how its effect is confirmed.
--   reported  the device reports the state it runs; the executor reads it back and acks (what every device did until now)
--   effect    the device reports nothing; a measured effect (the power of a plug dropping) says whether it worked
--   none      the device reports nothing and nothing else can tell
-- A command on an action that is not 'reported' ends sent_unverified: written, never acked, final. It never counts as the state the
-- device was confirmed to run, and a safety action is never queued for such a device (gate 'unverifiable', control.js).
ALTER TABLE device_capability ADD COLUMN verification text NOT NULL DEFAULT 'reported' CHECK (verification IN ('reported', 'effect', 'none'));

ALTER TABLE command DROP CONSTRAINT command_status_check;
ALTER TABLE command ADD CONSTRAINT command_status_check CHECK (status IN ('pending', 'sent', 'sent_unverified', 'acked', 'failed', 'expired', 'cancelled', 'skipped_unchanged'));
ALTER TABLE command DROP CONSTRAINT command_check2;
ALTER TABLE command ADD CONSTRAINT command_check2 CHECK (status NOT IN ('sent', 'sent_unverified', 'acked') OR sent_at IS NOT NULL);
ALTER TABLE command_log DROP CONSTRAINT command_log_event_check;
ALTER TABLE command_log ADD CONSTRAINT command_log_event_check CHECK (event IN ('enqueued', 'sent', 'sent_unverified', 'acked', 'readback', 'retry', 'failed', 'expired', 'cancelled', 'skipped_unchanged', 'observed'));

CREATE OR REPLACE FUNCTION trg_command_status_flow() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT (NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('sent', 'failed', 'expired', 'cancelled', 'skipped_unchanged')) OR (OLD.status = 'sent' AND NEW.status IN ('acked', 'sent_unverified', 'failed', 'expired', 'cancelled', 'pending')))) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'command: status change not allowed (acked, sent_unverified, failed, expired, cancelled and skipped_unchanged are final)';
  RETURN NEW;
END
$f$;

-- A sent_unverified command can still have its effect checked (verify_status), which is the only thing that changes on it afterwards.

ALTER TABLE command_block DROP CONSTRAINT command_block_gate_check;
ALTER TABLE command_block ADD CONSTRAINT command_block_gate_check CHECK (gate IN ('placeholder_capability', 'stale_inputs', 'limit', 'params', 'unverifiable'));
