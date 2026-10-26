# Predbat and PredHeat: coverage of the database design

Plan item B11 of `docs/hardening-and-planning-plan.md`. **Generated** by `scripts/build-coverage-matrix.js` from `docs/coverage-matrix.json`; do not edit by hand (change the hand review `scripts/coverage-review.js` or the schema, then re-run). The catalogue is `docs/predbat-predheat-requirements.md` (416 Predbat items, 54 PredHeat items, 11 planning-design fields in its Appendix A); `test/coverage-matrix.test.js` checks the matrix against a fresh database.

## Result

- **467 of 481 catalogue items are covered, 14 are excluded as not data, 0 are gaps.**
- **100 % covered of verified items:** 456 of the 456 verified Predbat and PredHeat items that are data have a home that exists in a fresh database (13 verified items are not data; listed below).
- **11 unverified items covered per their flagged description** (PB-DIAG-04, PD-01, PD-02, PD-03, PD-04, PD-05, PD-06, PD-07, PD-08, PD-10, PD-11): PB-DIAG-04 is the catalogue's one unverified Predbat row (an assumption about where the History view reads), the PD rows are planning-design fields with no Predbat source. PD-09 excluded as not data.
- **Gaps: 0.** The allow-list `docs/coverage-gaps.md` is empty; a gap that is a missing schema element fails the test.

## Definition of 100 %

An item is COVERED when every piece of data it names has a home in the database as built (a fresh database: schema.sql, every delta, every seed): a table column (or a documented key of a JSON column), a registry row (attribute_def, setting_def, device_kind), a metric for its facts (and a source where the item is a feed), a device_action, a view, or a function of the planner read layer (src/core/planner-read.js) that derives it from stored facts. test/coverage-matrix.test.js checks that every target exists. Home Assistant wiring, presentation, fixed code rules and archived keys are EXCLUDED_NOT_DATA with a reason (catalogue section 5 and the Dir "rule" rows). Secret values are kept out of the database by design; the connection row that records them is the target. 100 % = every verified Predbat and PredHeat item that is data is covered: covered / (items - excluded), with the unverified items (PB-DIAG-04 and the 11 planning-design fields of Appendix A) counted apart.

## By group

| Group | Items | Covered | Excluded (not data) | Gaps | Covered, % of data items |
| --- | --- | --- | --- | --- | --- |
| PB-CAP | 31 | 29 | 2 | 0 | 100 % |
| PB-CAR | 29 | 29 | 0 | 0 | 100 % |
| PB-CTRL | 30 | 27 | 3 | 0 | 100 % |
| PB-DIAG | 15 | 13 | 2 | 0 | 100 % |
| PB-INV | 75 | 75 | 0 | 0 | 100 % |
| PB-LOAD | 42 | 41 | 1 | 0 | 100 % |
| PB-OTHER | 84 | 83 | 1 | 0 | 100 % |
| PB-PLAN-OUT | 41 | 41 | 0 | 0 | 100 % |
| PB-PV | 23 | 23 | 0 | 0 | 100 % |
| PB-RATE | 46 | 46 | 0 | 0 | 100 % |
| PD (Appendix A) | 11 | 10 | 1 | 0 | 100 % |
| PH-CFG | 8 | 7 | 1 | 0 | 100 % |
| PH-CTRL | 1 | 1 | 0 | 0 | 100 % |
| PH-DIAG | 2 | 1 | 1 | 0 | 100 % |
| PH-LINK | 2 | 2 | 0 | 0 | 100 % |
| PH-MOD | 17 | 16 | 1 | 0 | 100 % |
| PH-OUT | 10 | 10 | 0 | 0 | 100 % |
| PH-RATE | 2 | 1 | 1 | 0 | 100 % |
| PH-SEN | 8 | 8 | 0 | 0 | 100 % |
| PH-STATE | 2 | 2 | 0 | 0 | 100 % |
| PH-WX | 2 | 2 | 0 | 0 | 100 % |
| **Predbat (PB-*)** | 416 | 407 | 9 | 0 | 100 % |
| **PredHeat (PH-*)** | 54 | 50 | 4 | 0 | 100 % |
| **All** | 481 | 467 | 14 | 0 | 100 % |

PB-OTHER holds the PB-OTH-* ids and PB-PLAN-OUT the PB-PLAN-* ids, as in the catalogue's section names.

## Verified and unverified

| Catalogue status | Items | Covered | Excluded (not data) | Gaps | Covered, % of data items |
| --- | --- | --- | --- | --- | --- |
| verified (Predbat and PredHeat) | 469 | 456 | 13 | 0 | 100 % |
| unverified (PB-DIAG-04 and Appendix A) | 12 | 11 | 1 | 0 | 100 % |

"verified" carries the catalogue's own flag: the item was read in a fetched source (docs, code or both). It includes 3 capability flags found only in code and 2 PredHeat rows that apply only to the archived standalone PredHeat (PH-DIAG-02, PH-RATE-02, both excluded).

## Where the items are kept

1092 targets in all: device_action 22, metric 112, read_function 69, registry_key 358, source 24, table_column 495, view 12. Every one is checked to exist by the test (a column by `PRAGMA table_info`, a registry key, metric, source, device action or view by its row, a read function by the export of `src/core/planner-read.js`).

- **Documented JSON keys** (20 items: PB-CAR-13, PB-CAR-23, PB-CTRL-17, PB-DIAG-05, PB-LOAD-30, PB-OTH-18, PB-OTH-75, PB-PLAN-18, PB-PLAN-25, PB-PLAN-26, PB-PLAN-27, PB-PLAN-29, PB-PLAN-32, PB-PLAN-36, PB-PLAN-38, PB-PLAN-39, PB-RATE-42, PB-RATE-43, PB-RATE-44, PH-STATE-01): plan totals and checkpoints in `plan_run.summary`, state carried between runs in `plan_run.carry_state`, the write count in `command_log.detail`. The keys are listed in `docs/database.md` and the test checks each target against that list; a JSON key is documented, not typed or constrained by the database.
- **Vendor wiring in `connection.meta`** (17 items: PB-CAR-24, PB-CTRL-14, PB-CTRL-23, PB-INV-43, PB-INV-44, PB-INV-45, PB-INV-46, PB-INV-47, PB-LOAD-04, PB-OTH-21, PB-PV-03, PB-PV-05, PB-PV-07, PB-RATE-31, PB-RATE-37, PD-03, PD-04): endpoints, integration switches, poll and refresh settings of an adapter, as JSON keys the vendor adapter names. Secret values (API keys, passwords, tokens) are kept out of the database by design; the connection row records which account they open.
- **Derived on read only** (3 items: PB-INV-74, PB-LOAD-42, PH-SEN-08): covered by a read-layer function over stored facts, nothing extra stored.

## What was added to close the gaps

The first pass found items with no home. Each was added, registry rows first (details in `docs/database.md`, "Coverage matrix: what it added"):

- **21 `attribute_def` rows**: the rest of the inverter capability profile and write path (`control_interfaces`, `control_immediate`, `current_decimal_places`, `opposite_rate_zero_required`, `charge_schedule_enable_supported`, `export_schedule_enable_supported`, `target_soc_sets_export_floor`, `schedule_commit_required`, `work_modes`, `idle_window_supported`, `window_time_format`, `clock_time_format`, `write_retry_max`, `write_backoff_s`, `api_delay_s`, `schedule_step_min`, `apply_delay_s`), `manual_soc_entry`, `pv_calibration`, and the planning design's `deployment_mode` and `service_active`.
- **22 `setting_def` rows**: the manual overrides (`manual_charge`, `manual_export`, `manual_demand`, `manual_freeze_charge`, `manual_freeze_export`, `manual_soc_min`, `manual_soc_max`, `manual_import_rates`, `manual_export_rates`, `manual_load_adjust`), `rates_import_override`, `rates_export_override`, `future_rate_estimate`, `compare_list`, `octopus_slot_low_rate`, `octopus_slot_max`, `intelligent_dispatch_billing`, `saving_session_rate`, `axle_reward_per_kwh`, `axle_control`, `solar_forecast_sources`, `replan_triggers`.
- **7 metrics**: `saving_session_reward`, `saving_session_joined`, `free_session`, `vpp_export_event`, `vpp_import_event`, `weather_alert_keep_pct`, `extra_load_kwh`; **3 sources**: `axle_vpp`, `weather_alerts`, `manual_entry`.
- **Delta 060** (`src/db/deltas/060-coverage.sql`): `plan_slot.import_rate_minor`, `export_rate_minor`, `import_rate_adjusted_minor`, `export_rate_adjusted_minor`, `import_rate_adjust`, `export_rate_adjust`, `clipped_kwh`; tables `tenant` and `tenant_site` (an owner record for PD-01 only: no login, no access rules, which stay in Phase C).

None of these touches the build engine, `site_hh` or `site_day`: the golden GB test is unchanged.

## How the review went

The script proposed targets for 299 items (registry `refs`, Predbat names matched to registry keys, the metric table in `docs/database.md`, the catalogue's PD column) and none for 182. Every item was then reviewed by hand against its catalogue row: 212 kept the proposals as they were, 70 kept them and gained targets, 17 had a proposal rejected, 182 were mapped by hand from nothing. The rejected proposals:

| ID | Rejected proposal | Why |
| --- | --- | --- |
| PB-CTRL-05 | attribute_def:reserve_pct | the value written and its cap; the configured minimum (the reserve_pct attribute the name match proposed) is PB-INV-38 |
| PB-INV-21 | attribute_def:soc_max_pct | Predbat soc_max is a capacity in kWh (usable_kwh), not the % ceiling soc_max_pct the name match proposed; 0 = auto-detect is a version with source measured |
| PB-INV-59 | setting_def:mode | the mode written is command.mode, the mode read back command.reported; not the planner mode setting the name match proposed |
| PB-INV-60 | attribute_def:reserve_pct | the reserve register as written and read back; the reserve_pct attribute proposed is the configured minimum (PB-INV-38) |
| PB-PLAN-03 | attribute_def:reserve_pct, attribute_def:soc_max_pct, setting_def:mode | the run's own copies (soc_max_kwh, reserve_kwh, control_mode) rather than the attributes and mode setting the name match proposed; iBoost and carbon on are settings as of the run (settings_snapshot); num_cars = the chargers the run planned |
| PB-PLAN-13 | metric:extra_load_kwh | the plan's output; the input feed it comes from is PB-LOAD-27 (the metric the name match proposed) |
| PB-PLAN-21 | attribute_def:export_limit_kw, setting_def:export_limit | what the inverter is set to now: the last acked command and its read-back (not the export limit the name match proposed) |
| PB-PLAN-26 | setting_def:best_soc_min_kwh | the plan's result, not the best_soc_min setting the name match proposed |
| PB-PV-11 | attribute_def:pv_scaling | the planner's forecast scaling; the pv_scaling attribute the name match proposed is a property of the installation |
| PH-CFG-02 | setting_def:mode | default conflict code pump vs template gas (catalogue 1.4): the registry keeps the code default; not the planner mode setting the name match proposed |
| PH-CFG-05 | setting_def:days_previous | PredHeat's own list, not Predbat's days_previous that the name match proposed |
| PH-CFG-06 | setting_def:days_previous_weight | PredHeat's own weights, not Predbat's |
| PH-MOD-05 | metric:heat_output_kwh | configuration, not the heat_output_kwh metric the name match proposed |
| PH-MOD-09 | metric:heatpump_cop | key conflict docs heating_cop vs code heat_cop (catalogue 1.4): the registry follows the code; configuration, not the heatpump_cop metric (docs/database.md says so in the row that misled the proposal) |
| PH-MOD-15 | metric:boiler_flow_temp_c, metric:boiler_return_temp_c | the curve is configuration; the boiler return temperature it is read at is a metric (an input, not this item) |
| PH-OUT-03 | attribute_def:target_temp_c | the set-point used incl. pre-heat; not the target_temp_c attribute the name match proposed |
| PH-STATE-01 | metric:radiator_temp_c | the carried estimate; a measured radiator temperature is PH-SEN-07 |

## Excluded: not data

| ID | Item | Reason |
| --- | --- | --- |
| PB-CAP-21 | has_time_window: Not currently used | Predbat defines the flag but nothing reads it (the catalogue's meaning column: "Not currently used"): no planner consumes it, so there is no value to keep. If it is used later its home is the charge_window_count_max attribute (0 = no time window). |
| PB-CAP-24 | charge_time_entity_is_option: Time entities are selects vs numbers | Whether Home Assistant exposes the time settings as select or number entities: Home Assistant plumbing (catalogue section 5: "HA connection: plumbing to Home Assistant"; "Regex auto-discovery and template notation: how HA entity names are found, not data"). EnergieBee adapters write the vendor API, whose time format is window_time_format (PB-CAP-23). |
| PB-CTRL-20 | Failure rule | Check 5 min into a slot, under 25 % of the requested rate or over 200 W the wrong way, 3 readings in a row: a fixed rule of the code (catalogue Dir "rule"): code constants, not stored data. Its inputs (the requested rate, the battery power readings) and its outcome (PB-CTRL-19) are covered. |
| PB-CTRL-21 | Balance writes | A balancing rate change only if at least 5 % of the maximum: a fixed rule of the code (catalogue Dir "rule"): code constants, not stored data. The balancing settings themselves are PB-OTH-68 to 71. |
| PB-CTRL-27 | Auto-restart commands | Restarting the Predbat app (shell commands or Home Assistant service calls): software lifecycle (catalogue section 5: "Software update ... software lifecycle"), not planning data. EnergieBee restarts its own process with scripts/supervise.js. |
| PB-DIAG-12 | Last start time | When the Predbat process last started: software lifecycle (catalogue section 5: "Software update ... software lifecycle"), not planning data. |
| PB-DIAG-15 | Log redaction list | Which strings to mask in Predbat's log: log plumbing (like section 5's notifications and start-up plumbing); no planner reads it. EnergieBee masks secret environment values in every reply itself (src/core/connectors.js). |
| PB-LOAD-12 | HA history retention | Home Assistant's own recorder retention (purge_keep_days): Home Assistant plumbing (catalogue section 5: "HA connection: plumbing to Home Assistant"; "Regex auto-discovery and template notation: how HA entity names are found, not data"). EnergieBee keeps its own facts; the history depth available is PB-LOAD-42. |
| PB-OTH-67 | Expert and performance gating | Which settings the UI shows (expert mode) and a speed switch that pins hidden settings to their defaults: UI and speed only (catalogue section 5: "Web port, web interface views ... UI"; "Threads and C++ kernel: speed only"). A home that never set a hidden key already reads its default (setting_def.default_value). |
| PD-09 | MQTT topic tree eb/{tenant}/{site}/{device}/… | A transport naming convention (MQTT topic tree eb/{tenant}/{site}/{device}/...), not data: plumbing like Home Assistant entity naming (catalogue section 5). The ids it carries are tenant.id, site.id and device.id. |
| PH-CFG-07 | Entity prefix | Catalogue section 5, word for word: "Entity prefix, template: true guard: Home Assistant naming and a 'not configured yet' switch". |
| PH-DIAG-02 | Standalone status entity (archived only) | Archived only (catalogue status "verified (archived)"): the standalone PredHeat status entity. The integrated PredHeat reports through Predbat (PH-DIAG-01). |
| PH-MOD-17 | Model constants | 5-minute step, 1.16 Wh per litre per degC, maximum increment 100: physics constants and a solver limit in PredHeat's code; a fixed rule of the code (catalogue Dir "rule"): code constants, not stored data. The 5-minute step of a plan is plan_run.step_s. |
| PH-RATE-02 | Standalone rate keys (archived only) | archived only (catalogue status "verified (archived)"): a key of the standalone PredHeat repo (archived 12 Oct 2024) that the integrated PredHeat no longer reads. The price the integrated PredHeat reads is PH-RATE-01. |

## Gaps

None. No schema gap remains, and no item needed the allow-list.

## Catalogue conflicts (section 1.4): what the schema chose

| # | Conflict | Schema choice |
| --- | --- | --- |
| 1 | PredHeat COP key: docs `heating_cop`, code `heat_cop` | attribute `heat_cop` (the code), the conflict kept in its description |
| 2 | PredHeat defaults: `mode` pump (code) vs gas (template); `flow_difference_target` 20 / 5 (code) vs 40 (template, docs) | setting `predheat_mode` defaults to `pump` (the code); attribute `flow_difference_target_c` has no default (an attribute is a measured or stated value), both conflicts in the descriptions |
| 3 | `volume_temp` read from the top level of apps.yaml, not the predheat block | metric `radiator_temp_c`, like every other PredHeat sensor (where Predbat reads it from is wiring) |
| 4 | Export encoding: current 3-tuple (mode, target %, power fraction) vs the legacy single number (99 freeze, 100 off) | the tuple: `plan_slot.action` (`export`, `freeze_export`, `demand` for idle), `export_limit_pct`, `power_fraction`; the legacy numbers are not used |
| 5 | Freeze charge: a limit equal to the reserve (optimiser) vs "target = current SoC" (planning document) | its own action `freeze_charge` (no limit encoding at all) |
| 6 | Default Predbat mode: "Control charge & discharge" (CONFIG_ITEMS) vs Monitor (docs, a new install) | setting `mode` defaults to `monitor` (the docs), the conflict in its description |
| 7 | `charge_low_power_margin` range 0-60 (code) vs 0-30 (docs) | setting `charge_low_power_margin_min` allows 0-60 (the code) |

## Known limits

- **Vendor entity names are not catalogued** (catalogue section 1.3): the per-vendor sections of the inverter and component docs and the 30 vendor templates were only partly read. Where an item is a vendor entity (a commit button, a Home Assistant service, an MQTT topic), its data is covered and the entity name is noted as wiring; vendor-specific wiring is JSON keys of `connection.meta`, not typed columns.
- **Docs pages not opened** (catalogue section 1.3): `install`, `annual-prediction` (What-If), `discovery-catalogue`, `hub-live-display`, `developing`, `plugins`, `rest_api`, `random-scenarios`, the FAQ beyond its headings, images and videos; GitHub issues and PRs; third-party integration docs. Anything only they define is not in the catalogue, so not in this matrix.
- **Covered means a home exists, not that anything fills it.** There is no planner, executor or event adapter yet: the plan, command, event and override homes are tables and registry rows that nothing writes today, exactly as plan items B6 and B7 intended.
- **JSON keys are documented, not enforced**: the database checks that `plan_run.summary`, `plan_run.carry_state` and `command_log.detail` are valid JSON, not which keys they hold.
- **By design, not stored**: secret values (kept in the environment); the Load ML model files (a cache rebuilt by training from the stored history); retention knobs (environment, `scripts/retention.js`).
- **Unverified items**: PB-DIAG-04 rests on an assumption the catalogue could not check; the Appendix A fields are planning-design ideas with no Predbat source, covered as described there (PD-01 by a minimal `tenant` table, PD-02 by our own attributes).
- **Excluded items are a judgement**: each reason cites the catalogue (section 5, the Dir "rule" rows, the archived status); a reader who disagrees with one can turn it into a gap in `scripts/coverage-review.js` and the test will demand a home for it.

## Re-run

```sh
node scripts/build-coverage-matrix.js && npm test
```

`node scripts/build-coverage-matrix.js --draft` prints the automatic proposals of every item (for reviewing a new catalogue row); `--check` exits 1 when the matrix or this report is out of date. The script opens a fresh temporary database (never `data/core.db`).
