// What each table is, and the time it must carry (fix list R19, plan rule 5). test/table-kinds.test.js fails when a
// table is not listed here, or when a table breaks its kind's rule, so a new table has to be classified on purpose.
//
//   config    what the home, its devices, tariffs and access ARE: valid time (valid_from, valid_to) and record time
//             (recorded_at, superseded_at), so a build "as known at" a past moment sees the configuration as it stood
//   fact      what a source said: record time (recorded_at, or fetched_at for a raw receipt); a correction supersedes
//   serving   rebuilt from facts and configuration (slots, days, checks): no time columns of its own beyond the build's
//   log       append-only history of what happened (syncs, commands, revisions, refusals)
//   registry  vocabulary seeded from code (metrics, sources, markets, kinds): changed by a migration or a code release
//   runtime   working state (queues, sessions, provider state): not history
//   secret    keys: a home's raw-file key (home_key) is destroyed with the home, so it is never versioned
//
// LEGACY_CONFIG: configuration tables from before the rule, with the record time they have and the thing platform phase
// that replaces them (docs/thing-platform-plan.md). The list can only shrink: a table leaves it when its replacement lands.
export const TABLE_KINDS = {
  // configuration, bitemporal
  binding: 'config', control_limit: 'config', rate_interval: 'config', register_window: 'config',
  site_group_member: 'config', tariff_agreement: 'config', tax_rule: 'config',
  thing: 'config', thing_attr_version: 'config', thing_relation: 'config',
  // configuration, before the rule (LEGACY_CONFIG)
  attribute_value: 'config', calendar_day: 'config', channel: 'config', connection: 'config', connection_secret: 'config',
  device: 'config', device_attr_version: 'config', device_capability: 'config', group_grant: 'config', site: 'config',
  site_attribute: 'config', site_grant: 'config', site_group: 'config', site_region: 'config', site_setting: 'config',
  site_version: 'config', supplier: 'config', tariff: 'config', tariff_version: 'config', tenant_site: 'config', user_site: 'config',
  vat_rate: 'config', app_user: 'config', tenant: 'config', supplier_alias: 'config', region_alias: 'config', calendar: 'config',
  // facts
  reading: 'fact', interval_fact: 'fact', forecast_fact: 'fact', raw_payload: 'fact',
  // serving
  site_hh: 'serving', site_day: 'serving', site_heat_slot: 'serving', check_result: 'serving',
  tariff_price_run: 'serving', supply_price_slot: 'serving', tariff_price_state: 'serving', plan_run: 'serving', plan_slot: 'serving', plan_score: 'serving', plan_input_ref: 'serving', plan_run_device: 'serving',
  // logs
  sync_run: 'log', command: 'log', command_log: 'log', site_day_revision: 'log', channel_reject: 'log', push_log: 'log', replay_log: 'log', fact_correction: 'log', erasure_log: 'log', raw_check_run: 'log', thing_op: 'log',
  // registries
  attribute_def: 'registry', setting_def: 'registry', binding_default: 'registry', column_class: 'registry', currency: 'registry',
  device_kind: 'registry', device_action: 'registry', market: 'registry', market_provider: 'registry', market_question: 'registry',
  metric: 'registry', region: 'registry', source: 'registry', series: 'registry', thing_type: 'registry', relation_rule: 'registry',
  // runtime
  home_key: 'secret',
  rebuild_queue: 'runtime', raw_payload_check: 'runtime', price_dirty: 'runtime', provider_state: 'runtime', user_session: 'runtime', command_block: 'runtime',
};

// Configuration tables from before the rule: the record time they have today, and what replaces them.
export const LEGACY_CONFIG = {
  attribute_value: 'record time only; Phase 1.1 (thing attributes, bitemporal)',
  calendar_day: 'valid time is the day itself; record time only',
  calendar: 'a named calendar; its days are versioned (calendar_day)',
  channel: 'record time only; Phase 2.3 (point_binding)',
  connection: 'no time columns; Phase 2.1 (integrations as things with links)',
  connection_secret: 'recorded_at only; Phase 2.1',
  device: 'the detail row of a device thing (same id); recorded_at only; versions in device_attr_version; Phase 2 (points and links)',
  device_attr_version: 'record time only; Phase 1.1 (thing attributes, bitemporal)',
  device_capability: 'recorded_at only; Phase 4.1 (capabilities on points)',
  group_grant: 'recorded_at only; Phase 1.3b (grants with valid time)',
  site: 'the detail row of a home thing (same id); its settings are versioned in site_version',
  site_attribute: 'record time only; Phase 1.3 (home thing attributes)',
  site_grant: 'valid time and recorded_at, no superseded_at; Phase 1.3b',
  site_group: 'created_at only; Phase 1.2 (groups as things)',
  site_region: 'record time only; Phase 1.3',
  site_setting: 'record time only; Phase 1.3',
  site_version: 'record time only; Phase 1.3',
  supplier: 'recorded_at only; Phase T.1',
  supplier_alias: 'names of a supplier; Phase T.1',
  region_alias: 'names of a region; registry-like',
  tariff: 'identity of a tariff; its terms are versioned in tariff_version and rate_interval; Phase T.1',
  tariff_version: 'record time only; Phase T.1 (price runs)',
  tenant_site: 'recorded_at only; Phase 1.3b',
  user_site: 'recorded_at only; Phase 1.3b',
  vat_rate: 'valid time only; replaced by tax_rule (bitemporal) for every market',
  app_user: 'an account; created_at only',
  tenant: 'an organisation; created_at only',
};

export const RECORD_TIME = ['recorded_at', 'superseded_at'];
export const VALID_TIME = ['valid_from', 'valid_to'];
