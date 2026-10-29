# Slot engine design: stress test against the product's future

Date 27 Oct 2026, commit `d6ec1a8` plus the untracked `docs/resilient-slot-engine.md` (called **the proposal** below) and `src/adapters/_template.js`. The question: does the proposal (channels, bindings, policy as data, observation envelope, pure normalisers, shared validation, source health, one resampler, staged migration) survive (A) many sites per user, shared and grouped; (B) devices that are read and written; (C) continuous Predbat/PredHeat-style planning; (D) scale and tenancy?

Evidence is from three scripts run on throwaway databases (`DB_FILE` in the scratch folder, `fetch` stubbed, `data/core.db` never opened), Node v24.22.1 (the project declares >= 22.13; not re-run on 22). Scripts and raw output: `/private/tmp/claude-501/-Users-macbookpro-Desktop-energiebee-core-prototype/0e1f9574-1c47-4113-8208-cb61cee75291/scratchpad/stress/` (`groups.mjs` -> `groups-output.json`, `control.mjs` -> `control-output.json`, `tenancy.mjs` -> `tenancy-output.txt`, `timing.mjs` -> `timing-output.txt`). Every estimate of effort or scale is labelled **guess**.

---

## 0. Verdict in one table

| Evolution | Verdict | Why, in one line |
|---|---|---|
| A. Many sites, shared, grouped | **Survives with changes** | The slot store is the right base, but groups need a column-class contract, versioned membership, grants (not `tenant_site`) and a currency on every slot row. Nothing in the proposal is wrong for A; it is silent. |
| B. Read and write devices | **Bends; needs new concepts** | The envelope has no `state` kind and no `ack`; command verification uses database belief (`lastAcked`), not device facts; a late ack after expiry is lost; stale-input and capability gates are not enforced at command time (all measured). |
| C. Continuous auto-management | **Breaks on reproducibility unless fixed** | `channel` parameters (hold, due, offset) are mutable columns and `channel_health` is current-state only; replaying a plan with the same facts and a changed hold gives 0.2 instead of 0.6 kWh per half-hour (measured). Bindings and `site_policy` are already bitemporal: keep that, extend it. |
| D. Scale and tenancy | **Survives with changes** | Facts reach a home only through `series.subject_id TEXT`; `tenant_site` allows one owner and no sharing; RLS must key on site visibility, not `tenant_id`. Plain additions, no redesign. |

The five most important changes (detail in section 7): (1) version every channel parameter and record the resolved policy, binding set and channel versions in slot lineage and `plan_run`; (2) add a `state` envelope kind and treat device read-back as facts, with `ack` as a receipt event, so verification diffs against the device, not the database; (3) a written aggregation contract per column class plus `currency` on `site_hh`, and group views that never read `site_day`; (4) `site_group` / `site_group_member` with valid time, and `site_grant` for sharing, with RLS on site visibility; (5) enforce gates at command creation (stale inputs, placeholder capability, per-device limits) and add effect verification after read-back.

---

## 1. Groups (A): measured on six synthetic homes

### 1.1 Set-up

`groups.mjs` builds, with the real `buildSite`, the three homes of `scripts/lib/multi-market.js` plus four more, all over 25 to 27 Oct 2025 (26 Oct is the clock change in London and Amsterdam):

| Name | Zone | Slot | Currency | Notes |
|---|---|---|---|---|
| GB30 | Europe/London | 1800 | GBP | `multi-market` GB home, flat then day/night tariff |
| GB15 | Europe/London | 900 | GBP | **same synthetic samples** as GB30 (seed 11) |
| GB60 | Europe/London | 3600 | GBP | same samples again |
| GBGAP | Europe/London | 1800 | GBP | seed 44, 5 kWh battery; 27 Oct: no data 10:00-13:00 (missing), no meter 18:00-24:00 (provisional) |
| NL15 | Europe/Amsterdam | 900 | EUR | `multi-market` NL home, quarter-hour dynamic price with negative quarters |
| KOL60 | Asia/Kolkata | 3600 | GBP | edge case: a half-hour-offset zone, hourly slots |

### 1.2 What goes wrong with plain SQL

1. **Mixed currencies.** `SUM(total_cost)` over `site_day` for the five-home group gives 903.06 on 26 Oct, a number in no currency (GBP 718.12 + EUR 184.94). Rule: money is summed only inside one currency; a group with two currencies shows two totals. FX is a separate, dated, labelled conversion (not built; `002-money-tax.sql:10` says "There is no FX").
2. **`site_hh` has no currency column.** `site_day` has one (the build writes `site.currency`), `site_hh` does not, so slot money is interpreted with today's `site.currency`, although `site_version` lets the currency change. Add `currency` to `site_hh` (and to any rollup).
3. **Day boundaries differ.** NL's `2025-10-25` runs 22:00 to 22:00 UTC, London's 23:00 to 23:00 UTC; KOL60's `2025-10-26` runs 18:30 to 18:30 UTC. Re-bucketing NL into the group's London day by `slot_start` changes its daily import by +0.503 kWh (24 % of 2.119) on 25 Oct, -0.178 on 26 Oct, -0.325 on 27 Oct. Summing `site_day` by `local_date` mixes different 24- and 25-hour windows and is wrong for any group spanning zones.
4. **Slots that cannot be placed whole.** All 48 KOL60 hourly slots start at :30 UTC (`slot_start % 3600 = 1800`), so none fits a UTC hour; 2 straddle London midnight. Every European zone is whole-hour, so this does not bite GB/FR/NL, but `site_hh.slot_start % 900 = 0` is the only grid guaranteed for all zones. Rule: group buckets must be multiples of every member's slot length and aligned to every member's grid; otherwise pro-rate by time and flag `ESTIMATED`, or refuse the resolution.
5. **Missing is hidden in day totals.** GBGAP on 27 Oct: `slots_missing 6`, `slots_provisional 12`, yet `site_day.grid_import 9.901`, `home 13.141` and `total_cost 219.28` are all non-null. The missing slots carry `grid_import NULL` but `solar 0`, `home 0` (not null) and `total_cost 1.203` (= the standing charge alone), and the day row sums `?? 0` (`build.js:526-529`). A group adding these gets a confident under-count.
6. **State of a group bucket.** Hourly over the four GBP homes, 10:00 to 12:00 UTC on 27 Oct: 14,400 member-seconds, 3,600 of them missing, yet the cost sum (9.63) is identical to the complete hour at 09:00, because the missing home contributes its standing charge and no energy. 18:00 and 19:00 hold 3,600 provisional seconds.

**Combination rule (proposed).** Per bucket and per measurand: `value` = sum of members' non-null values; `expected_s` = sum over members of the bucket seconds inside their membership; `final_s`, `provisional_s`, `missing_s` from member slot states; `state` = `incomplete` if `missing_s > 0`, else `provisional` if `provisional_s > 0`, else `final`; show `coverage = (final_s + provisional_s) / expected_s` and "n of m homes". Never zero-fill. Requires the proposal's own fix that absent nodes are `null`, not 0 (its RC3), applied to `solar`, `home` and the costs too.

### 1.3 The claim "summing each site's own priced slot costs is exact; re-pricing at a coarser slot is not"

**Confirmed, with two refinements.**

- NL15, 26 Oct (100 quarter-hours): sum of quarter energy costs 234.764 c; the same hours re-priced as hourly import x time-mean price 240.331 c (+2.4 %). Worst hour 11:00 UTC: quarter prices 13.50, 7.45, 1.40, -3.44 c with imports 0, 0.343, 0.333, 0.335 kWh: exact 1.865 c, re-priced 4.776 c. Import-weighted mean price reproduces the exact figure (it is the same sum).
- The engine itself rebuilding NL at 3600 s (dry run) instead of 900: day cost 190.509 vs 184.942 (+3.0 %), `battery_to_home_cost` 10.528 vs 3.804, `loss_cost` 17.03 vs 15.36, `peak_import_kw` 1.216 vs 1.604; energy totals equal.
- **Refinement 1: total cost is exact at any slot no longer than the price period.** Same GB samples at 15, 30 and 60 min, 26 Oct: `total_cost` 183.8536, 183.8536, 183.8969. 15 and 30 agree because prices change on half-hours; 60 differs because the night window starts at 00:30.
- **Refinement 2: allocated flows and their costs are resolution-dependent even when energy and prices are not.** Same day: `solar_to_home` 3.0904 / 3.1363 / 3.2174 kWh; `grid_to_home_cost` 36.08 / 35.78 / 34.66; `loss_cost` 4.13 / 4.42 / 5.59; `blended_cost` 8.17 / 8.13 / 7.96; `self_sufficiency` 0.8379 / 0.8385 / 0.8410. Netting inside a slot is a model choice. Consequence: a group sums each member's flows at that member's own resolution and **never re-allocates** from coarser buckets; mixed-resolution groups show flows labelled with the members' slot lengths.

### 1.4 Classification of every `site_hh` column (52) and `site_day` column (53)

| Class | `site_hh` columns | `site_day` columns | Aggregation rule (time within a site, and across sites) |
|---|---|---|---|
| Key / time | `site_id`, `slot_start`, `local_date`, `dur_s`, `tod_min` (5) | `site_id`, `local_date` (2) | Group by. `dur_s` sums to covered seconds. Re-bucket by `slot_start` in the group's zone, never by member `local_date`. |
| Additive energy, measured or reconciled (kWh) | `solar`, `grid_import`, `grid_export`, `battery_charge`, `battery_discharge`, `home`, `loss`, `gas`, `ev` (9) | same 9 | Sum non-null; carry coverage. Exact across sites and slot lengths (equal at 15/30/60 min, measured). |
| Additive forecast (kWh) | `solar_forecast` (1) | `solar_forecast` (1) | Sum only where every member has one; else partial with coverage. |
| Additive allocated flows (kWh) | `solar_to_home`, `solar_to_battery`, `solar_to_grid`, `battery_to_home`, `battery_to_grid`, `grid_to_home`, `grid_to_battery`, `solar_to_loss`, `battery_to_loss`, `grid_to_loss` (10) | same 10 | Sum at members' own resolution; never recompute from coarser buckets (differ by slot length, measured). |
| Additive money (minor units, one currency) | `loss_cost`, `grid_to_home_cost`, `grid_to_battery_cost`, `battery_to_home_cost`, `export_credit`, `standing_cost`, `gas_cost`, `total_cost`, `grid_only_cost`, `saving` (10) | same 10 | Sum within currency only; never re-price. Allocation-based costs (`battery_to_home_cost`, `loss_cost`, `saving`) are model outputs, labelled. |
| Additive carbon (g) | `carbon_g`, `carbon_saved_g` (2) | same 2 | Sum. |
| Intensive, energy-weighted | `import_rate_ex`, `import_vat`, `export_rate`, `gas_rate_ex`, `gas_vat`, `carbon_intensity` (6) | none | Never average. Effective value = sum of the matching cost (or `carbon_g`) / sum of the matching kWh, per currency. |
| Intensive, time-weighted | `outdoor_temp` (1) | none | Time-weighted mean per site; across sites only per site or per region (a group mean temperature is not meaningful). |
| State at an instant | `soc_end` (% of that home's battery) (1) | `soc_min`, `soc_max` (2) | Within a site: last in bucket (`soc_end`), min/max of the series. Across sites: convert to kWh with `battery_kwh` **as known at the slot**, then sum at a common instant (unweighted mean of % 85.2 vs capacity-weighted 85.64 %, measured on 4 homes). Group min/max from the summed kWh series, not min of mins. |
| Non-additive derived (recompute from sums) | none | `self_consumption`, `self_sufficiency`, `blended_cost`, `battery_cycles`, `integrity` (5) | Ratio of sums (`self_sufficiency`: mean of ratios 0.7919 vs ratio of sums 0.7940, measured); `battery_cycles` = sum discharge / sum capacity; `integrity` weighted by seconds. |
| Extremes, resolution-dependent | none | `peak_import_kw`, `base_load_kw` (2) | Recompute on the group's summed series at a stated resolution. Coincident hourly group peak 11.31 kW vs sum of site peaks 12.50 vs max site 3.50; the same home's peak is 3.498 / 3.170 / 2.997 kW at 15 / 30 / 60 min. |
| Flags and state | `state`, `quality`, `rate_found` (3) | `slots`, `slots_final`, `slots_provisional`, `slots_missing` (4) | `state`: seconds per state, worst-of (section 1.2); `quality`: bitwise OR plus counts per bit; slot counts converted to seconds (slot lengths differ). |
| Diagnostic per site | `meter_vs_ct` (1) | none | Per site only; group shows count of homes with a failing check. |
| Parameters and carried state | none | `slot_s`, `battery_eff`, `battery_stock` (3) | Never aggregate; per site. |
| Units and lineage | `lineage`, `method_version`, `built_at` (3) | `currency`, `method_version`, `built_at` (3) | `currency` partitions sums; mixed `method_version` in one bucket is flagged; `built_at` max. |

Counts: `site_hh` 5+9+1+10+10+2+6+1+1+3+1+3 = 52; `site_day` 2+9+1+10+10+2+2+5+2+4+3+3 = 53.

### 1.5 Where group views live, and the schema

- **Not `site_day`.** It mixes day windows, zero-fills missing slots and stores ratios. Group views read slot rows.
- **Now: a query over `site_hh`.** A group of 20 homes for a year is about 20 x 365 x 48 to 96 = 0.35 to 0.7 M rows (**guess** for typical membership); with `(site_id, slot_start)` keys this is a range scan per member. Not timed at that size here.
- **Later: a per-site bucket rollup written by the build**, `site_bucket(site_id, bucket_start, bucket_s, currency, <additive columns>, final_s, provisional_s, missing_s, method_version)`, with `bucket_s` = 3600 on the UTC hour grid for whole-hour zones (900 otherwise), in the same transaction as `site_hh`. This is the Home Assistant pattern (hourly long-term statistics: mean/min/max for measurements, sum for totals). Trigger: the p95 group query exceeds 300 ms (the ladder in `architecture-v3.md` 6.4). A group's day is then a sum of buckets inside the group-zone day.
- **Schema additions (A):**

```sql
ALTER TABLE site_hh ADD COLUMN currency TEXT REFERENCES currency(code);
CREATE TABLE principal (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('user','service','installer')),
  tenant_id INTEGER REFERENCES tenant(id), external_subject TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE site_grant (site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  principal_id INTEGER NOT NULL REFERENCES principal(id), role TEXT NOT NULL CHECK (role IN ('owner','manager','viewer','installer')),
  scope TEXT NOT NULL DEFAULT 'all',                 -- all | energy | control: sharing data without control rights
  valid_from INTEGER NOT NULL, valid_to INTEGER,     -- s: what period of the home's data the grant covers
  granted_by INTEGER REFERENCES principal(id), recorded_at INTEGER NOT NULL, revoked_at INTEGER,   -- ms
  PRIMARY KEY (site_id, principal_id, role, recorded_at));
CREATE TABLE site_group (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES principal(id),
  name TEXT NOT NULL, timezone TEXT NOT NULL, created_at INTEGER NOT NULL);   -- no currency: one total per member currency
CREATE TABLE site_group_member (group_id INTEGER NOT NULL REFERENCES site_group(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  valid_from INTEGER NOT NULL, valid_to INTEGER,      -- s, valid time: when the home counts in the group
  recorded_at INTEGER NOT NULL, superseded_at INTEGER, -- ms, transaction time: so a past report can be re-run
  CHECK (valid_to IS NULL OR valid_to > valid_from), PRIMARY KEY (group_id, site_id, valid_from, recorded_at));
CREATE TABLE site_group_grant (group_id INTEGER NOT NULL REFERENCES site_group(id) ON DELETE CASCADE,
  principal_id INTEGER NOT NULL REFERENCES principal(id), role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  recorded_at INTEGER NOT NULL, revoked_at INTEGER, PRIMARY KEY (group_id, principal_id, recorded_at));
```

Rules: a member counts in a bucket only for the intersection of its membership validity and the **viewer's** current grant on that home (a group can be shared with someone who has no grant on one member: that member is then hidden, not leaked). Revoking a grant removes access to history too (access is evaluated now; membership is valid time). `tenant_site` stays as the data controller of a home, not as access control.

---

## 2. Tenancy and scale (A, D)

**Measured scoping (`tenancy-output.txt`, fresh database with all deltas):** tables with `site_id` and a foreign key: 19. Reaching a home only through a parent: `reading`, `interval_fact`, `forecast_fact` (via `series.subject_id TEXT`, no FK), `command`, `command_log`, `plan_slot`, `plan_input_ref`, `plan_score`, `plan_run_device`, `device_capability`, `device_attr_version`, `register_window`. `raw_payload.site_id` has no FK and is NULL for shared feeds. Views `v_plan_vs_actual`, `v_plan_in_force` expose `site_id` without RLS of their own. User or access tables: none, apart from `tenant` and `tenant_site` (delta 060: "An owner record only: no login, no access rules"; one tenant per home).

**What the binding layer must carry.** `channel.site_id` (the proposal has it) and `series.site_id` (new, nullable; NULL = shared region or catalogue series such as carbon, gas CV, public tariff prices). Facts stay keyed by `series_id` only: in PostgreSQL they are read through the security-definer `read_series(site_id, ...)` of `architecture-v3.md` ADR-3, which checks the caller's site against `site_grant`. Denormalise `site_id` onto `command`, `command_log`, `plan_slot`, `plan_score`, `ingest_receipt`, `dead_letter`, `dirty_day` (all have hot per-home queries and are RLS targets). A device moved to another home is retired and gets new channels (channel identity is per home); do not version `channel.site_id`.

**RLS predicate.** `site_id IN (SELECT site_id FROM site_grant WHERE principal_id = current_principal() AND revoked_at IS NULL)`, not `tenant_id = current_tenant()`: sharing crosses tenants, so `tenant_id` (still useful for partitions and cell splits, `architecture-v3.md` 6.5) cannot be the access key. Shared rows (region series, tariff catalogue, `metric`, `measurand`, policies) are readable by all.

**Policy templates and inheritance, so thousands of homes are not hand-configured.** The proposal's `site_policy (site_id, code, version, valid_from, ...)` would need one row per home. Replace it with `policy_assignment(scope_kind IN ('market','tenant','device_model','site'), scope_id, measurand NULL, code, version, valid_from, recorded_at, superseded_at)`; resolution is most specific wins (site > device model > tenant > market), per measurand where given. Likewise `channel_template(device_kind, vendor_model, metric, point_pattern, period_s, max_hold_s, due_s, ...)` instantiated from the hub's `up/announce` (`architecture-v3.md` 5.3), the role OpenEMS Natures and Home Assistant device classes play. Danger: editing a template rewrites thousands of homes' history on the next rebuild. Rule: templates and policies are immutable versions; an assignment change takes effect from `valid_from = now` unless an explicit restatement job is run, and the resolved `(policy code, version, template versions)` is written into each slot's `lineage` and into `plan_run`.

**PostgreSQL.** `site_hh`, `plan_slot`, `reading`, `interval_fact` partitioned by month of time, `site_id` leading in the key; `EXCLUDE USING gist` replaces the overlap triggers for `binding`, `site_group_member` and `site_grant`. Not tested here: no PostgreSQL was run.

---

## 3. Control (B)

### 3.1 One command, end to end, through the existing tables (`control.mjs`, measured)

Worked example "charge the battery 02:00-05:00" on a home with telemetry every 5 minutes until 00:40 local:

1. **Plan, 00:45.** `freshnessOf(state(site, 00:45))` ok (all inputs 300 s old). `savePlan` writes run 1 with six 30-minute `charge` slots, `chargeLimitPct 90`, and a `plan_input_ref` hash of the SoC read.
2. **Window.** `v_plan_window` merges them: `charge`, 02:00 to 05:00 UTC, 6 slots.
3. **Command.** `enqueueIfChanged({action: charge, window 02:00-05:00, target 90}, valid until 05:00)` writes command 1, `pending`, idempotency key = hash(device, desired, valid_from, valid_until). A re-plan 5 minutes later with the same decisions writes nothing (`pending_same`).
4. **Send and read-back.** `markSent`; a read-back of target 89 % gives `acked: false`, diff `{target_soc_pct: 90 vs 89}`, status stays `sent`, log event `readback`; with tolerance 1 it is `acked`. `command_log`: `enqueued`, `sent`, `readback`, `acked`.
5. **Read-back is not a fact.** It is stored as JSON in `command.reported`; no metric exists for a window start, a target or a reserve (only `ev_charge_limit_pct`). The planner (`planner-read.state`) and the build cannot see what the device is programmed to do.
6. **Slots.** 02:00 to 05:00 in `site_hh` get `grid_to_battery` from the build; nothing links a slot to the command in force, so accounted savings ("this charge happened in a cheap slot", ADR-9) cannot cite the command.

Gaps found on the way (all measured):

- **Stale input does not block control.** At 02:10 the inputs are 5,400 s old, `freshnessOf` says `stale_inputs`; `savePlan` still accepts a `stale_inputs` run containing a `charge` slot (a "demand-only fallback" with a non-demand action), and `enqueueIfChanged` writes a `pending` charge command from it.
- **Placeholder capability passes.** `setCapability(..., source 'placeholder', note 'assumed')` satisfies the command trigger's `supported = 1`.
- **Late ack after expiry is lost.** Command sent at 02:12, hub offline, `expireStale` at 05:01 expires it; the hub reconnects at 05:20 and replays `applied`: `markAcked` throws "command 2 is expired, not sent", status stays `expired`. The device did apply it; the record says it did not, and the next `enqueueIfChanged` compares against `lastAcked` (database belief), not the device.

### 3.2 Does read-back fit the proposed envelope?

No: the envelope's `kind` is `instant | interval | counter | event | forecast`. Add:

- **`state`**: the value of a readable or writable control point at an instant (target %, reserve %, window start as minute of day, work-mode code, set-point). Stored as a `reading`; resampled last-held, never integrated or interpolated, held until the next change capped by the channel heartbeat; validated against the point's limits and enum. Structured values (a schedule of N windows) are flattened into one channel per register, as OpenEMS and Predbat do (charge window, target SoC, reserve and export window are separate writes and read-backs, catalogue PB-CTRL-03 to 07, PB-INV-64 to 68). If a second vendor's schedule cannot be flattened, that is a kill criterion (section 6).
- **`ack`**: not a fact. A receipt event `{intent_id, outcome received|applied|rejected, device_ts, reason}` routed to `command_log` regardless of the command's status, so an ack after expiry is recorded (`applied_late`) and the next diff uses the device's `state` facts.

**One concept: channel with direction.** Yes. `channel.access IN ('read','write','read_write')` (OpenEMS: "access-mode (read-only, read-write, write-only)"), plus `write_metric`/limits for writable ones. A device action (`device_action`) compiles to writes on named channels (per device model: `charge` -> `charge_window_start`, `charge_window_end`, `target_soc`, `charge_enable`). The read-back of a written channel arrives through the same normaliser as `state` envelopes; the executor diffs desired against the latest `state` facts, and `command.reported` becomes a cache.

### 3.3 Where each control concern sits

| Concern | Where | Status |
|---|---|---|
| Idempotency | `command.idempotency_key` (cloud), HLP `intent_id` + idempotency key (hub, `architecture-v3.md` 5.3), `ingest_receipt (hub, seq)` for acks | exists / proposed; add `intent_id = command.id:attempt` |
| Expiry | `valid_until`, `command_never_late` trigger, hub TTL then safe default (ADR-11) | exists; add `applied_late` path |
| Safety limits | static: `device_action.params_schema`; missing: per-device installer limits | add `control_limit(device_id, channel_id, min, max, source, valid_from, recorded_at)`, checked at enqueue and pushed to the hub |
| Capability gate | `device_capability` | require `source IN ('probe','adapter','vendor_doc','installer')` for commands |
| Stale-input gate | `freshnessOf` in the planner only | enforce at enqueue: refuse a non-default action from a `stale_inputs` run; executor re-checks the read-back channels' freshness before sending |
| Effect verification | none (ack = read-back only) | `command.verified_at`, `verify_status`: PB-CTRL-20 rule (5 min into the slot, < 25 % of requested rate, 3 readings) on telemetry; a 7-minute device clock skew passes read-back but fails effect |
| Arbitration | `command_open`: one open command per device | needs the arbiter of `architecture-v3.md` 7.2 before manual overrides and planner run together |

### 3.4 Latency and the fast path

Control needs seconds to a minute: Predbat reads back after a short poll delay (GivEnergy 10 s, PB-CTRL-15) and checks the effect 5 minutes into a slot (PB-CTRL-20). The 10-minute pull sync and the build are far too slow. The fast path already exists: `planner-read.state()` reads the latest facts directly (4.45 ms per call on a 3-day synthetic home, `timing-output.txt`). Requirements on the proposal: (1) push ingest normalises `state`, `event` and `ack` in a priority lane with a stated latency target (proposed 10 s, **guess**), separate from telemetry backfill, matching the hub's own buffer priority (events and acks first, `architecture-v3.md` 5.5); (2) control and the planner never read `site_hh` for current state; (3) `planner-read` moves onto the same resampler and bindings (the proposal's stage 7), or the two disagree (the proposal's RC2 measured 0.2 vs 0.6 kWh).

**Store-and-forward edge.** Ordering: facts are order-independent (reads sort by device `ts`; measured in the proposal); state and acks are not: "latest" must mean latest device `ts`, never latest arrival. Duplicates: `(hub, seq)` receipts. Clock skew: keep device and received time (proposal 3.7); additionally a skewed device clock shifts the executed schedule, which only effect verification catches. Replay: a buffered hour arriving late is correct under "as known at" (it was not known earlier), and marks yesterday dirty through `dirty_day`.

---

## 4. Auto-management (C)

### 4.1 What the planner needs, and what is versioned

| Input | Versioned today? | In the proposal? |
|---|---|---|
| Facts, forecasts, prices as known at T | yes (`recorded_at`, delta 040, `rate_interval.superseded_at`) | kept |
| Home settings, attributes, devices | yes, transaction time (`site_version`, `site_setting`, `device_attr_version`) | kept |
| Bindings | n/a | **bitemporal** (`valid_from/to` + `recorded_at/superseded_at`): good |
| Policy assignment | n/a | bitemporal (`site_policy`); policy bodies immutable `(code, version)`: good |
| Channel parameters (`period_s`, `max_hold_s`, `due_s`, `final_after_s`, `clock_offset_s`, `counter_wrap`) | n/a | **mutable columns: not versioned** |
| Source health (`channel_health`) | n/a | **current state only** |
| Group membership | n/a | absent |

### 4.2 Replay scenario, measured

Same PV samples every 15 minutes (1,200 W from 12:00 to 13:00), same `asOf`, read with `planner-read.series(..., stepS 1800)` under a 300 s hold and under a 3,600 s hold (the hold is chosen by source today; in the proposal it is `channel.max_hold_s` or the policy's `hold`): energy 0.2 vs 0.6 kWh per half-hour, cover 0.333 vs 1. **The plan's input hash over `values` (mean W of the covered part) is identical (`a1f597b40600`) in both cases**; only a hash over energy and cover detects the change (`511bfb033d83` vs `3f31a32ca987`). So: a plan made at T0 with `max_hold_s = 900`, followed by an operator `UPDATE channel SET max_hold_s = 300`, cannot be replayed (PV history one third, load by balance 0.4 kWh per half-hour higher, a different charge decision), and `plan_input_ref` as used today may not even notice. Fix: version channel parameters (`channel_version(channel_id, recorded_at, superseded_at, period_s, max_hold_s, ...)`, same pattern as `site_version`), resolve them as known at T, and hash the resampled output including `cover` and `energyKwh`.

**Health.** Finality in the proposal depends on `now`, `due_s` and `channel_health.status`. A replay must not read today's health. Derive health as known at T from `ingest_receipt` (arrivals with `received_at`) and facts, rather than storing a mutable status as the only record; keep `channel_health` as a cache. Note that slot state already depends on the wall clock today (`date >= today`, `build.js:476`); inject `now` into the build so a dry run is reproducible.

**Must group membership be bitemporal?** Valid time is required (S6: a home leaving a group stays in the group's earlier history). Transaction time is cheap with the existing pattern and makes "the March report as sent" re-runnable; included in section 1.5. Grants: transaction time only (revocation is immediate).

**Scoring.** `plan_score` compares with `site_hh` as built when scored; `site_hh` is restated later (`RESTATED`). Record the actual's `state`, `method_version` and `built_at` in `plan_score`, and rescore when the slot is restated. `v_plan_vs_actual` converts SoC with today's `site.battery_kwh`, not the size as known at the plan.

### 4.3 Cadence and worker model

10,000 homes x one plan per 5 minutes = 33 plans per second (**guess** of fleet size from `architecture-v3.md` 6.3). Reads per plan measured on one laptop: `state` 4.45 ms, `series` (2 days) 0.68 ms, `rates` 9.83 ms, `loadHistory` 4.23 ms: roughly 20 ms of reads, so about 0.7 CPU-seconds per second for reads alone; the optimiser's cost is unknown (Predbat's is not measured here). Model: a per-home job keyed by `site_id` in the Postgres queue (`SKIP LOCKED`, ADR-6), coalesced (one pending plan per home), triggered by the 5-minute timer, a new price issue, a `state` change on a watched channel (Predbat `watch_list`, PB-CTRL-28), or a command outcome. Ingest, build and planning are separate workers; the planner reads facts, never waits for a build.

**What in the proposal blocks this:** (1) unversioned channel parameters and health (above); (2) a single SQLite writer shared by push ingest, the build and plan writes (the proposal rightly defers Postgres, but continuous planning for more than a pilot needs it); (3) the batch normaliser inbox has no latency target or priority lane; (4) `channel_health` updated on every arrival is a write per sample on the hot path. Not a blocker: the per-day rebuild (2 ms for today in the proposal; 5.58 ms for a one-day dry run here).

---

## 5. Comparison with established patterns

Sources opened: Home Assistant sensor entity and statistics docs (https://contributors.home-assistant.io/core/entities/sensor/, https://contributors.home-assistant.io/data/reference/statistics/; the `developers.home-assistant.io` and `data.home-assistant.io` URLs redirect there); OpenEMS core concepts and edge architecture (https://openems.github.io/openems.io/openems/latest/coreconcepts.html, https://openems.github.io/openems.io/openems/latest/edge/architecture.html); openHAB things and items (https://www.openhab.org/docs/concepts/things.html, https://www.openhab.org/docs/concepts/items.html); FlexMeasures data model (https://flexmeasures.readthedocs.io/stable/_sources/concepts/data-model.rst.txt) and search results pointing to its time-series API (https://flexmeasures.readthedocs.io/v0.16/_autosummary/flexmeasures.data.models.time_series.html, not opened); Predbat apps.yaml (https://springfall2008.github.io/batpred/apps-yaml/, first half only, truncated). **Could not open:** `openems .../edge/nature.html` (404), `flexmeasures .../en/latest/concepts/data-model.html` (404). Predbat inputs otherwise come from `docs/predbat-predheat-requirements.md` (fetched 26 Oct by its author).

| Pattern | What it does (sourced) | Copy | Do not copy |
|---|---|---|---|
| OpenEMS channels | A channel is "a single piece of information about a component", addressed `Component-ID/Channel-ID` (`ess0/Soc`), with "access-mode (read-only, read-write, write-only)"; Natures are sets of channels a component must provide; each cycle copies `nextValue` to `value` ("At, and only at, Switch Process Image"); controllers run in scheduler order so later ones cannot overwrite earlier writes; a Sum service sums "the entire energy system". | Channel with direction; Natures as device-kind channel templates; fixed controller priority as the arbiter. | The synchronous process image: it is an edge control loop, not a cloud fact store. Unverified (memory): `WriteChannel.setNextWriteValue` and `_sum/EssSoc` naming. |
| Home Assistant statistics | `state_class` `measurement` (mean/min/max per period), `total`, `total_increasing` (running `sum`; "A drop of less than 10% is treated as noise, not as a reset"); short-term statistics every 5 minutes, long-term hourly "never purged"; keyed by `statistic_id` and `source`. | Column classes (section 1.4) are exactly this split; the hourly rollup kept forever; the counter kind with explicit `last_reset`. | The 10 % noise heuristic for resets (prefer explicit wrap/reset rules per channel); hourly only (we need 15-minute for NL). |
| openHAB | Things provide Channels; "Channels are linked to Items ... the glue between the virtual and the physical layer"; Group Items "derive their own state from their member Items" recursively. | Link (binding) as a separate, editable object between a device channel and a home-level quantity; groups as derived state. | Unverified (memory): group functions SUM/AVG/MIN/MAX and link profiles (offset, follow); averaging intensive values across members is exactly the error of section 1.2. |
| FlexMeasures | "Accounts own assets, and data of these assets are protected against anyone from a different account"; assets nest (parent/child); each sensor has unit, timezone and resolution; each data point is a belief with event time, belief time (horizon) and a source; schedules are beliefs with a `scheduler` source. | Plans and their predictions as beliefs with a source and belief time (already close: `forecast_fact` + `core_plan`, `plan_run.facts_as_of`); per-sensor resolution; account-owned assets plus "consult" for sharing. | Free-form source types; probabilistic beliefs are not needed yet (unverified: `cumulative_probability` field name). |
| Predbat inputs | `load_today`, `import_today`, `export_today`, `pv_today` "must be energy sensors" that "must increase during the day and not have any gaps or reduce in value (other than at midnight)"; `num_inverters` multiplies every inverter entity; write controls (reserve, target SoC, rates, charge) via MQTT or entities. | Daily counters as the counter kind with local-midnight reset; per-inverter channels summed by binding; control registers as `state` channels. | Counters without gaps as a precondition: our resampler must tolerate gaps (the proposal's counter rule does). |

Net: the proposal's channel/binding/measurand split matches OpenEMS + openHAB; its bitemporal facts and plans-as-records match FlexMeasures beliefs; what is missing compared with all four is the **write direction** and an explicit **aggregation class per quantity**, which Home Assistant makes a first-class field.

---

## 6. Over-engineering check and the minimum slice

**Premature before three real vendors** (defer, keep the table shapes in the design): the general JSON policy interpreter with `crosscheck`, `shape_from`, `same_as`, `require` options (one vendor plus Octopus fits named code paths keyed by policy code); `final_after_s` deadlines and the full health state machine (`late`, `stale`, `throttled`, `paused`); dead-letter replay tooling (keep raw + quarantine, which exist); per-provider token buckets; the `event` kind; the two-pass rebuild and multi-battery stock; `policy_assignment` inheritance beyond market + site.

**Not premature:** `dirty_day` in the fact transaction (a real data-loss bug, measured in the proposal); channel + binding with versioned parameters; one resampler shared by build and planner; the `counter` kind (every IoT plug and Predbat's `*_today` sensors); the `state` kind (control is in the "Now" tier of `architecture-v3.md`).

**Minimum slice that proves the abstraction:** channels and bindings for the existing GB sources (series ids unchanged); `inputsFor(site, asOf)` resolving bindings **and channel versions** as known at a time; one resampler with per-channel hold and sum-within-candidate; `build.js` **and** `planner-read.js` both on it (two consumers agreeing is the proof; one consumer proves only a refactor); `counter` and `state` kinds; GB byte-identical. **It differs from the proposal's stages 2 and 3**: it pulls stage 7 (planner on the resampler) and part of stage 6 (counter, plus the new `state` kind) forward, and pushes the policy interpreter, health finality and dead letters back.

---

## 7. Verdict detail and revised plan

### 7.1 Exact additions per evolution

- **A:** `site_hh.currency`; `principal`, `site_grant`, `site_group`, `site_group_member` (bitemporal), `site_group_grant`; a documented column-class contract (section 1.4) as data (`measurand.slot_rule` already hints: extend to `aggregate_rule IN ('sum','sum_currency','energy_weighted','time_weighted','last','ratio_of_sums','resolution_extreme','state','none')` on a `serving_column` registry); null, not zero, for absent nodes in all energy and money columns; later `site_bucket`.
- **B:** envelope kinds `state` and `ack`; `channel.access`; device-model action-to-channel map; `control_limit`; `command.verified_at`, `verify_status`, `applied_late` handling; enqueue-time stale-input and capability-source gates; command in force recorded in slot lineage; priority ingest lane.
- **C:** `channel_version`; health derived from receipts as known at T; resolved policy/template/binding/channel versions in `lineage` and `plan_run`; output hash over energy and cover; injected `now` in the build; `plan_score` records actual state and version, rescoring on restatement.
- **D:** `series.site_id`; `site_id` denormalised onto command, plan and ingest tables; RLS on grant-visible sites; `read_series` security definer; `policy_assignment` and `channel_template`.

### 7.2 Revised stages (GB output byte-identical throughout until a deliberate `METHOD_VERSION` bump; all efforts **guesses** for one engineer)

1. **Stage 0, synthetic golden** (as proposed, 1 to 2 days): include GB15/GB60 and NL15 from `groups.mjs`.
2. **Stage 1, ingest durability** (as proposed, 3 to 5 days) plus `ingest_receipt.received_at` kept as the health record.
3. **Stage 2, channels and bindings with versions** (6 to 9 days): proposal stage 2 plus `channel_version`, `series.site_id`, lineage of resolved versions.
4. **Stage 3, one resampler, two consumers** (8 to 12 days): `resample.js` with per-channel hold and counter; `build.js` and `planner-read.js` on it; legacy policy as named code, not the interpreter.
5. **Stage 4, control read-back** (5 to 8 days): `state`/`ack` kinds, `channel.access`, executor diff on facts, enqueue gates, `control_limit`, effect verification.
6. **Stage 5, groups and grants** (4 to 6 days): section 1.5 tables, group query over `site_hh`, `site_hh.currency`, null-not-zero (a `METHOD_VERSION` bump).
7. **Later, on triggers:** policy interpreter (second vendor needs a rule the named paths lack), health finality, dead letters, `site_bucket` (p95 > 300 ms), Postgres with RLS (more than one writer process or more than a pilot).

### 7.3 Acceptance scenarios

| # | Scenario | Pass when |
|---|---|---|
| S1 | Group of GB30, GB15, NL15 and GB60 across currencies and slot lengths, viewed in London time | Two totals (GBP, EUR), never one; NL re-bucketed by `slot_start` into London days; hourly view refused or flagged below 60 min for GB60; flows equal the members' own sums; peak and ratios recomputed from sums |
| S2 | Mixed-vendor home: inverter A (5-min power), inverter B (15-min lifetime counter), Octopus meter | Solar = A + B within 0.1 % of truth; build and planner-read agree within 0.1 %; B absent makes solar `null`, slot not `final` |
| S3 | IoT plug with a counter, a 40-minute outage and a late batch | Outage slots carry the conserved energy flagged `INTERPOLATED`; other slots unchanged; late batch marks the day dirty in the same transaction; as-of T before the batch reproduces the earlier rows |
| S4 | Command with read-back and a stale-input block | Read-back arrives as `state` facts and acks by diff on facts; inputs older than the limit refuse a non-default command at enqueue; an ack after expiry is logged `applied_late` and the next diff uses the device state; effect check flags a skewed device |
| S5 | Plan replay after a policy or channel change | Re-running the plan of T0 after changing `max_hold_s` and the policy version gives the same input hash (energy + cover) and the same `plan_hash` |
| S6 | A home leaves a group on day X | Group days before X include it, after X exclude it; the report as recorded before the change re-runs identically |
| S7 | Home shared between user U1 (owner) and U2 (viewer, energy scope) | U2 sees energy and cost, cannot enqueue a command; revoking U2 removes the home from U2's groups, including history; RLS test with two principals in PostgreSQL |

### 7.4 Spike (1 to 2 days, **guess**) and kill criteria

Spike: on a copy of the synthetic golden, implement `channel`, `channel_version`, `binding`, `inputsFor(site, asOf)` and a hold-aware resampler for the six GB power nodes plus one counter channel; run `build.js` stage 1 and `planner-read.series` through it; run S2, S5 and the S1 query.

Stop and redesign if: (1) `inputsFor` cannot return exactly the series ids the current build reads for every synthetic home; (2) the golden hash moves under the legacy rules and the cause is a rule that cannot be expressed as a channel parameter or named rule within the spike; (3) build and planner-read on the shared resampler differ by more than 0.1 % on any synthetic home; (4) S5 cannot be made reproducible without snapshotting whole tables per plan; (5) the S1 group query over one synthetic year for 20 homes exceeds 300 ms on SQLite (then materialise first); (6) the second vendor (below) needs an expression rather than a closed option, for more than one measurand.

**Verify with a second real vendor:** payload shapes and unknown-label behaviour; cadence, on-change reporting and heartbeat; counter semantics (lifetime or daily, reset time, wrap); device clock and zone; per-device or plant-aggregate reporting; sign conventions; how its schedule is represented (number of windows, 15-minute snapping, apply lag, PB-CTRL-16) and whether it flattens into scalar `state` channels; read-back latency; write rate limits; quality flags.

---

## 8. What was verified, and what was not

**Run and measured:** every number in sections 1, 3.1, 4.2 and 4.3 (scripts above, real `buildSite`, `planner-read`, `savePlan`, `enqueueIfChanged`, `markAcked`, `expireStale` on temporary databases); the table scoping list (`tenancy-output.txt`); the 52 and 53 column counts (`pragma_table_info`).

**Not tested:** PostgreSQL, RLS and partitions (no server run); group query time at a year x 20 homes; any real vendor, hub, MQTT or HLP message; Node 22 (ran on 24.22.1); the proposal's tables (not built; findings about `channel` mutability and `channel_health` are from its DDL text); the optimiser's own cost; FX.

**Reasoned, not measured:** the RLS predicate, the inheritance rules, the latency target of 10 s, fleet size and plan rate, and every effort figure (all **guesses**).

**From memory, unverified:** openHAB group functions and link profiles; OpenEMS `setNextWriteValue` and `_sum` channel names; FlexMeasures `cumulative_probability`; the second half of the Predbat apps.yaml page (truncated at 100,000 of 200,333 characters).
