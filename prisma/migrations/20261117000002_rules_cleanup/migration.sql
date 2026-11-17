-- Rules cleanup (fix list D1): one trigger per rule.
-- The currency checks that compared explicit currencies only are subsumed by the *_implied_* triggers, which make the same
-- comparison and also cover a currency implied by the market; the pairs split across two deltas (the 032 columns) become one.
DROP TRIGGER agreement_same_currency_insert ON tariff_agreement;
DROP TRIGGER agreement_same_currency_update ON tariff_agreement;
DROP TRIGGER site_currency_matches_agreements ON site;
DROP TRIGGER tariff_currency_matches_agreements ON tariff;
DROP FUNCTION trg_agreement_same_currency_insert();
DROP FUNCTION trg_agreement_same_currency_update();
DROP FUNCTION trg_site_currency_matches_agreements();
DROP FUNCTION trg_tariff_currency_matches_agreements();

CREATE OR REPLACE FUNCTION trg_command_desired_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.action IS DISTINCT FROM OLD.action OR NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.window_end IS DISTINCT FROM OLD.window_end OR NEW.target_soc_pct IS DISTINCT FROM OLD.target_soc_pct OR NEW.limit_pct IS DISTINCT FROM OLD.limit_pct OR NEW.rate_w IS DISTINCT FROM OLD.rate_w OR NEW.setpoint_c IS DISTINCT FROM OLD.setpoint_c OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.desired IS DISTINCT FROM OLD.desired OR NEW.desired_hash IS DISTINCT FROM OLD.desired_hash OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.supersedes_command_id IS DISTINCT FROM OLD.supersedes_command_id OR NEW.reserve_pct IS DISTINCT FROM OLD.reserve_pct OR NEW.charge_rate_w IS DISTINCT FROM OLD.charge_rate_w OR NEW.discharge_rate_w IS DISTINCT FROM OLD.discharge_rate_w OR NEW.current_a IS DISTINCT FROM OLD.current_a OR NEW.export_start IS DISTINCT FROM OLD.export_start OR NEW.export_end IS DISTINCT FROM OLD.export_end) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'command: the desired state is fixed (a changed state is a new command)';
END $$;
DROP TRIGGER command_desired_fixed_032 ON command;
DROP FUNCTION trg_command_desired_fixed_032();

CREATE OR REPLACE FUNCTION trg_plan_run_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.scenario IS DISTINCT FROM OLD.scenario OR NEW.variant IS DISTINCT FROM OLD.variant OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.plan_start IS DISTINCT FROM OLD.plan_start OR NEW.slot_s IS DISTINCT FROM OLD.slot_s OR NEW.horizon_h IS DISTINCT FROM OLD.horizon_h OR NEW.step_s IS DISTINCT FROM OLD.step_s OR NEW.facts_as_of IS DISTINCT FROM OLD.facts_as_of OR NEW.method_version IS DISTINCT FROM OLD.method_version OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR NEW.settings_snapshot IS DISTINCT FROM OLD.settings_snapshot OR NEW.inputs_hash IS DISTINCT FROM OLD.inputs_hash OR NEW.soc_start_kwh IS DISTINCT FROM OLD.soc_start_kwh OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.metric_base IS DISTINCT FROM OLD.metric_base OR NEW.metric_best IS DISTINCT FROM OLD.metric_best OR NEW.metric_best10 IS DISTINCT FROM OLD.metric_best10 OR NEW.cost_pv50 IS DISTINCT FROM OLD.cost_pv50 OR NEW.cost_pv10 IS DISTINCT FROM OLD.cost_pv10 OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms OR NEW.error IS DISTINCT FROM OLD.error OR NEW.record_end IS DISTINCT FROM OLD.record_end OR NEW.soc_max_kwh IS DISTINCT FROM OLD.soc_max_kwh OR NEW.reserve_kwh IS DISTINCT FROM OLD.reserve_kwh OR NEW.control_mode IS DISTINCT FROM OLD.control_mode OR NEW.metric_base10 IS DISTINCT FROM OLD.metric_base10 OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.carry_state IS DISTINCT FROM OLD.carry_state OR NEW.debug_raw_id IS DISTINCT FROM OLD.debug_raw_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'plan_run: append-only (only status and superseded_at change, when superseded)';
END $$;
DROP TRIGGER plan_run_append_only_032 ON plan_run;
DROP FUNCTION trg_plan_run_append_only_032();
