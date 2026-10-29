# Solution: a provider-agnostic slot engine that survives runtime change

Status: proposal of 27 October 2026, partly built since (see "What is built" below). Sections 1 to 7 describe the target; section 8 is the original plan. It brings together everything found so far and says what to do about it, in what order, and what it will not fix. Detail and evidence live in four earlier documents, which this one points to rather than repeats:

- `docs/resilient-slot-engine.md`: the root-cause review and the target architecture (channels, bindings, policy, observation envelope).
- `docs/slot-engine-stress-test.md`: the design tested against groups, control, planning and scale.
- `docs/database-review.md`: the database review (score 5 out of 10 at the time; part of it fixed since).
- `src/adapters/_template.js`: the processor template (source, processor, slot data).

## What is built (updated after the first build round)

The prototype has no backward-compatibility constraint, so the work went straight to the target design and the golden test was regenerated on purpose. Tests: 621 pass, one skipped. `npm run test:slots` now covers 111 tests at each of 15 and 60 minutes. `npm run test:slots` re-runs the switch, channel, two-device, ingest, control, counter, event and IoT-role tests at 15- and 60-minute slots (111 pass at each). Correction: the first version of this check only changed the home's current slot length, while a build "as known at" a moment reads its settings from `site_version`, so many runs quietly stayed at 30 minutes. The helper now changes both, and a full day builds 96, 48 and 24 slots at 15, 30 and 60 minutes.

| Original stage | State | Where |
|---|---|---|
| 0. A gate we can trust | Done | `scripts/make-fixture.js`, `test/fixtures/gb-home.db` (the real home, identifiers removed); tests start from it. One test (revision-log reconstruction) skips because the fixture has too few sync runs. |
| 0b. Quick fixes | Done | `retireDevice` keeps tariff agreements; source and metric rows reload at runtime; `asWriter` refuses writes into another source's series. |
| 1. Durable ingest | Done, except dirty days in the same transaction | `sinceWatermark` (src/jobs/sync.js) measures new facts from the last sync that reached its build; repeated timestamps in a batch keep the last; `requireData` makes an empty answer an error. A fact written and not yet queued is found by the next sync instead of being queued atomically. |
| Spike and 2. Bindings | Done | `binding` (delta 061), `binding_default` and a trigger for new homes (062), `src/core/inputs.js`. Eight roles: inverter_5min, inverter_daily, meter_energy, gas_cv, carbon, weather_temp, ev_dispatch, solar_forecast. `unbind`, a reason for changes that alter built slots, `previewImpact` (src/core/impact.js). |
| 3. One resampler, shared validation | Partly | The build and the planner read take their sources from the same bindings and agree within 0.1% across a vendor switch (test/runtime-provider.test.js). Hold time comes from `source.traits` (063). Channels (064, 065) convert units and signs and reject out-of-range values for every vendor (src/core/channels.js). The two integrators are still two functions, not one. |
| Second device of a kind | Done for the inverter roles | Delta 066 (`binding.device_id`). Overlapping units are integrated separately and added; charge level is weighted by battery size; the planner read does the same. Test: `test/multi-device.test.js` (the real inverter split 40 / 60 builds the same slots). Not yet: a sum rule for meters, per-device limits. |
| Counter and event kinds, IoT roles | Done, synthetic data only | Delta 072. Counters (reset, wrap, backwards step, gap, duplicates, daily reset on 23 and 25 hour days), events, future-timestamp, stuck-sample and clock-offset checks on a channel, roles `heat_pump_energy`, `heat_output_energy`, `heat_telemetry`, `ev_charger_energy` and `plug_energy`, device-kind channel defaults. The heating build reads the heating roles; nothing reads events, EV charger or plug energy yet. See `docs/counters-events-roles.md` |
| Devices page and a synthetic IoT demo home | Done, synthetic data only | A Devices page lists a home's devices with status, last values and bound roles; a detail view draws each counter next to its derived energy (restarts, gaps and refused readings explained in words), events, temperatures and rejects; "Simulate next period" moves the demo home forward through the real ingest path and shows each step; "Send test command" runs the real control cycle against a simulated device. Everything created is labelled synthetic; simulate and command are refused for real devices. A demo home is added only by a button or `npm run demo:iot`. See `docs/devices-page.md` |
| Providers completion: add a source, binding priority, advanced channel options, source health, replay, retention | Done | New sources from the screen (never overwritten by the registry seed), priority edits as supersede-and-record, health per role (ok, late, silent, never), replay of stored receipts after a mapping is fixed (Sunsynk and pushed receipts only), retention of refusal rows, the push log and replayable receipts. See `docs/provider-health-replay.md` |
| Push ingest | Done, no real device tried | See the open-items table below and `docs/push-ingest.md` |
| Onboarding API and Providers screen | Done | Nine routes and a screen (`public/providers.html`): a timeline per role, channels, rejected values, and an add, change or remove flow with an impact preview, a required reason for past changes and a dry run on every write. It cannot yet add a new source row or edit a binding's priority. See `docs/onboarding-api.md` |
| 4. Control read-back | Done, simulated device only | Delta 067. `state` and `ack` observation kinds (an ack is a receipt, never a fact), `channel.access`, per-device `control_limit`, enqueue gates (placeholder capability, stale inputs, limits, parameter ranges; refusals kept in `command_block`), `runControlCycle` driven by the device's own read-back, late acks kept as `applied_late`, a data-driven effect check (`verified` or `not_verified`), and `canControl` checked for a person acting. See `docs/control-readback.md`. No real vendor driver, no scheduler, no priority ingest lane. |
| 5. Groups and grants | Done | Delta 070. `site_hh.currency`, a `column_class` table (aggregation class per column, as data), dated groups, group views over slot rows (two currency totals, missing is not zero, final only if every member is), `app_user` and `site_grant`, hidden members. See `docs/groups-and-access.md`. No sign-in, no database-level row security, no timing at scale. |

Adapters on channels: Sunsynk (5-minute, daily, live), Octopus (meter consumption, dispatches, planned charges), carbon, National Gas calorific value, Open-Meteo and Quartz. Channels cover a home, a device or a region as the subject, and instants, periods and forecast issues; `part` is all, positive, negative or abs.

### Open items: closed, and what is deliberately left

| Item | State |
|---|---|
| New tests only run at 30 minutes | Closed. `TEST_SLOT_S` runs them at 15 and 60 minutes. Two hard-coded 1800 s values in tests were the only failures |
| Octopus dispatches and planned charges on channels | Closed (delta 071 adds the `abs` part) |
| Overlapping group membership | Closed (delta 071 triggers on insert and update) |
| A battery already at target read as `not_verified` | Closed: verified with the reason `already_at_target`; below target and no power is still `not_verified` |
| Command in force in slot lineage | Closed: `lineage.control` lists acknowledged commands whose window overlaps the slot |
| No control scheduler | Closed: `src/jobs/control.js` registers drivers and ticks only for homes with a command to act on. It is idle until a driver is registered |
| Group views not timed | Measured (`scripts/bench-groups.mjs`): 20 homes by one year (394,200 slot rows) is 17 ms per day, 0.35 s for 30 days, 3.7 s for the year. Linear. A pre-aggregated table is the fix if it ever matters |
| A push endpoint for devices | **Closed.** `POST /api/ingest` takes the native shape, a shorthand and the Shelly Gen2, Tasmota and Home Assistant shapes (taken from the vendors' documentation, not verified on a real device), with an optional shared token, a push log, device registration and an emulator. No MQTT client, per-device keys or TLS. See `docs/push-ingest.md` |
| A real vendor control driver | **Open, needs input.** A driver must speak one vendor's real control API and be tested on a real device; the interface and a simulated device exist. Needs a chosen vendor, its API documentation and a test device or account |
| Tariff rates, Tariffscanner, tounify | **Not slot inputs.** They fill the tariff catalogue and rate store (`rate_interval`), which the builder prices from. They are not part of the provider-to-slot path, so channels do not apply |
| Sign-in and database-level row security | **Out of scope by decision** (prototype: "we don't care about auth"). The access check exists and is enforced when a person acts |
| Rules as data (meter beats clamp, daily fit range) | **Deferred on purpose** until a second vendor needs a different rule. A general policy interpreter now would be guessing |

Decisions taken: our own forecast before Quartz (`solar_forecast` priority); lineage records `meter` or `clamp` plus the actual source, not a vendor name.

Still open: rules as data (meter beats clamp, daily fit range) stay code until a second vendor needs a different rule; channel history is not consulted at read time (facts keep the conversion they were written with).

## 1. The goal, in one paragraph

Build a slot-based timeline for a home from many sources at once: official meters, inverters, external APIs and IoT devices. A provider can be added, replaced, removed or go silent while the system runs. No provider requires an edit to the engine or the timeline builder. The same timeline then serves many homes per user, groups of homes with combined usage and cost, devices that are read **and** written, and continuous Predbat and PredHeat style management, and any past plan or report can be reproduced as it was known at the time.

## 2. Where we stand: what is solved, and what is not

### Already solved (built and tested)
- A slot length that is a per-home setting (15, 30, 60 minutes), clock-change days, time-weighted prices.
- Currency in minor units, markets, regions, ordered taxes, many tariff shapes, provenance labels on every figure.
- A provider registry per market, driven sync, a Connectors page, a Data Explorer that explains one slot step by step.
- A processor template (`_template.js`), a planner read layer, a coverage matrix showing the schema has a place for all the data Predbat and PredHeat need (100% of the verified items; see `docs/coverage-gaps.md`).
- Database hardening: busy timeout, update-time overlap checks, indexes, retention (report-only by default), versioned site and tariff settings.

### Not solved: the problem register

| # | Problem | Evidence | Fixed by |
|---|---|---|---|
| P1 | The engine asks for facts by **vendor name** on a fixed `site` subject (113 literals in 16 non-adapter files, 18 in `build.js`). A new vendor's good data is never seen. | Review RC1; real-home test E5: solar unchanged at 131.2 kWh | Section 4 (bindings) |
| P2 | The rules (meter beats clamp, 5-minute hold, daily fit 0.6 to 1.6) are code, in three separate resamplers. The same 15-minute samples give 0.2 kWh in the build and 0.6 kWh in the planner read. | Review RC2 | Section 4 (one resampler) |
| P3 | **Missing data becomes zero** and is served as final. | Review RC3 | Section 4, stage 5 |
| P4 | No shared validation: negative energy, kW sent as W, a 5e8 W spike, a future timestamp all reach a final slot. Counters and events cannot be stored. | Review RC4 | Stage 3 and later |
| P5 | Slot state comes from one true/false guess and the calendar. A step that returns nothing still counts as ok. | Review RC5 | Health model (later stage) |
| P6 | Ingest is not crash-safe: after a crash a corrected day stays wrong for ever (9.6 kWh served, 21.6 kWh in the facts). | Review RC6 | Stage 1 |
| P7 | Only 2 of 9 adapters can re-run their parsing from the saved raw file. | Review RC7 | Pure processors (template) |
| P8 | One inverter and one battery per home. | Review RC8 | Bindings, multi-battery stock |
| **P9** | **A runtime provider change rewrites history and loses pricing.** On a copy of the real home: retiring the import meter turned all 694 slots into "waiting", made the home unpriced (cost 9,411 p to 0), changed import in 610 of 733 slots, and ended 7 tariff agreements. Adding the meter back restored import but **not** the pricing. | Real-data experiment B and C | Section 5 |
| **P10** | **A new provider is not a runtime action.** A new source needs a registry row and a restart (the id map is read once at start-up), then its facts are still ignored. Filing them under an existing source name made solar jump from 131.2 to 459.1 kWh and superseded 835 real inverter readings. | Real-data experiment E4 to E6 | Section 5 |
| P11 | Groups of homes: money cannot be summed across currencies; a day starts at different instants in different time zones (the Dutch home moved 0.503 kWh, 24%, when re-bucketed into a London day); `site_day` fills missing slots with 0; `site_hh` has no currency column. | Stress test section 1 | Section 6 |
| P12 | Tenancy and sharing: facts reach a home only through a text subject id; each home has one owner; no grants. | Stress test section 2 | Section 6 |
| P13 | Control: the observation format cannot carry device read-back; an acknowledgement that arrives after expiry is lost; stale-input and capability checks are not enforced when a command is queued; nothing verifies the device actually did it. | Stress test section 3 | Section 7 |
| P14 | Replay: bindings, policy and channel settings change over time. If they are not versioned, replaying an old plan with the same facts gives a different answer (0.2 against 0.6 kWh per half-hour). | Stress test section 4 | Section 7 |
| P15 | **The tests cannot be trusted as a gate.** The golden test reads whatever `data/core.db` holds; after the database was repopulated, 6 tests are red (528 slots against an expected 1,008). | Test run, 27 October | Stage 0 |
| P16 | Remaining database items: facts have no `site_id`; time units mix seconds and milliseconds under one suffix; JSON in text columns; tables are not STRICT. | Database review | Stage 2 onwards |
| P17 | Open items outside the engine, not fixed here: no sign-in or secret store, saved raw files and the raw endpoint are unredacted and open, no real EU data source (tounify licence unconfirmed, ENTSO-E token), French and Dutch taxes unverified, one GB VAT rate unverified, PredHeat details unverified, Tariffscanner VAT basis assumed. | Scorecard and earlier sessions | Section 9 |

## 3. Design principles

1. **Measurands, not vendors.** The engine asks for "grid import for this home at this time", never for a vendor.
2. **Everything that can change at runtime is an effective-dated row.** Bindings, policy, channel settings, group membership, grants. History is never rewritten by a change; a past slot is rebuilt with what applied **then**.
3. **A provider change never edits the engine.** A new provider is: a pure processor, a source row, a channel, a binding.
4. **Missing is never zero.** A slot built from absent data says so.
5. **Read and write are one pipeline.** A device's read-back and settings come back as observations through the same processors and the same validation.
6. **Prove before committing.** Every stage keeps the GB output byte-identical until a deliberate method-version bump, and the first real step is a spike with kill criteria.

## 4. The architecture, condensed (full detail in the two reviews)

```
connector (pull API | push webhook | MQTT hub)
  -> raw store (receipt; every arrival recorded)                         [exists]
  -> pure processor (raw + channel map -> observations)                  [template exists]
  -> shared validation (units, ranges, time, overlap, counters, stuck)   -> dead letter
  -> fact store (reading / interval / forecast; bitemporal)              [exists] + site_id
  -> binding (home measurand -> channel, effective-dated, versioned)     [new]
  -> policy (ordered candidates, fallback, fit, cross-checks, finality)  [new; GB rules first]
  -> one resampler per kind -> reconcile -> allocate -> price -> check   [refactor]
  -> site_hh / site_day (+ currency) and channel health -> state
```

- **Channel.** One measuring point on one device, with a direction (read, write or both), a nominal cadence, a hold time, a delivery delay, and a clock offset. A device can have many channels, so two inverters or batteries no longer share a series.
- **Observation kinds.** `instant`, `interval`, `counter`, `event`, `forecast`, and two new ones from the stress test: **`state`** (a readable or writable value such as a target charge level or a work mode) and **`ack`** (a receipt, not a fact).
- **Binding.** "For this home, grid import comes from channel X from date D". More than one binding can be active; the policy says whether they add (two solar arrays) or one takes precedence (meter before clamp).
- **Policy.** Data, shared by many homes through templates (per market and per device kind) with a per-home override. The GB rules (meter beats clamp, 5-minute hold, daily fit) become the first policy, `gb_legacy`, which reproduces today's output exactly. A general policy interpreter is deliberately deferred (section 8).

## 5. Runtime provider change: the rules that fix P9 and P10

Each case below failed on the real-home copy today. The fix is a rule, and each rule has a test (section 8).

| Case | What happens today (measured) | Rule |
|---|---|---|
| **Add a provider** | Needs a registry row and a restart; its facts are then ignored | A source row is data, reloadable at runtime (a lookup that misses re-reads the table). The new provider gets a channel and a binding **from a date**. Slots before that date never change. A backfill is a binding dated earlier and is shown as a revision with a reason. |
| **Remove a provider** | Retiring the meter rewrote 610 slots and unpriced the home | Removal ends a binding at a date. Slots before that date are untouched. **Tariff agreements belong to the supply point, not to the device lifecycle:** retiring a device never supersedes them. |
| **Add it back** | Import restored, pricing not | Adding back is a new binding. Pricing was never touched, so nothing needs restoring. |
| **Switch vendor on day D** | Impossible without editing the engine, or a workaround that destroys data | Two bindings, one ending and one starting at D. Overlapping data is stored but only the bound channel counts, so nothing is counted twice. A counter channel carries its own offset at the seam. Each slot's lineage records the binding versions used. |
| **Provider goes silent** | Slots become "waiting" and import falls back to the clamp (reasonable) | An outage is health, not a binding change. The slot is "waiting" with a reason, the policy's fallback applies, and the slot is finalised when the data arrives or a deadline passes. |
| **Second device of the same kind** | Overwrites the first | A second channel and a second binding, combined by the policy (sum). |
| **Impersonation** | Filing a new vendor under `sunsynk_5min` superseded 835 real readings | **A writer may only write series of the source it declares.** The fact writer checks it, so a processor cannot overwrite another source's data. |
| **Operator safety** | A change silently rebuilds history | Every provider change shows an **impact preview** first (the engine already supports a dry run): which slots change, by how much, and why. A change that alters a past slot needs a recorded reason in the revision log. |

## 6. Many homes, groups and users (P11, P12)

- **Group views read the slot rows, never `site_day`.** `site_day` fills missing slots with zero, so a day with six missing slots looks complete. A group's day is built from its members' slot rows.
- **Money is summed only within one currency.** A group with pounds and euros shows two totals. There is no exchange rate.
- **Every column has an aggregation rule,** recorded as data: energy, flows, money (within a currency) and carbon add up; prices are energy-weighted; temperature is time-weighted; battery charge is converted to kWh before it is summed; ratios and peaks are recomputed from sums. Summing each home's own priced slots is exact; re-pricing at a coarser slot is not (2.4% higher for the Dutch home).
- **A group day uses one time zone,** chosen for the group. A group slot is final only if every member slot is final.
- **Tables:** `site_hh.currency`, groups with **dated membership** (a home that leaves on day X is included before X and excluded after), users, a **grant** table (a home can be shared, with roles such as owner and viewer), and `site_id` on the facts. Isolation is keyed on which homes a user may see, not on a tenant id.

## 7. Control and auto-management (P13, P14)

- **A device's readable channels and writable control points are one concept** (a channel with a direction). A device action compiles to writes on named channels.
- **Read-back comes back as `state` observations** through the same pipeline. A command is checked against what the **device** reports, not against the database's belief. An `ack` is a receipt; one that arrives after expiry is recorded as applied late.
- **Gates at queue time, not only in the planner:** stale inputs, capability sources (a placeholder capability cannot send a command), per-device installer limits, and, after sending, an effect check (did the battery actually charge?).
- **Latency:** control needs seconds. It reads the latest facts directly (`planner-read.state()`), not the ten-minute build.
- **Versioned everything for replay:** channel settings, bindings and policy are effective-dated, and each slot and each plan records the versions it used. Replaying a plan with the facts known at its time then gives the same input fingerprint and the same plan.
- **Not solved here:** the planner and optimiser themselves, device vendor adapters with real read-back, a scheduler for thousands of homes, and the edge hub. The design keeps room for them and does not build them.

## 8. Staged plan

Rule for every stage: the GB output must be byte-identical before and after unless a stage names a deliberate method-version bump; each stage is a revertable set of commits; no fact row is rewritten. **All efforts are guesses** for one engineer who knows the code.

| Stage | What | Accept when | Estimate |
|---|---|---|---|
| **0. A gate we can trust** | Replace the live-database golden test with a synthetic one **and** a frozen real-home fixture (energy, prices and tariffs from your real home, with every identifier removed), so the gate uses real shapes and cannot drift. Fix the 6 red tests. | Hash equal on two runs and on Node 22 and 24; any change to a build constant flips it | 1 to 2 days |
| **0b. Quick fixes in today's engine** (independent, low risk) | Retiring a device must not supersede tariff agreements and must not rewrite the past; the source list reloads at runtime; the fact writer checks the writer's declared source. | On the frozen real fixture: retire then re-add leaves cost and every slot identical to the baseline; a new source row works without a restart; filing under another source is refused | 1 to 2 days |
| **1. Durable ingest** | Dirty days written in the same transaction as the facts; a batch with a repeated timestamp keeps one row; empty answers are not "ok". | A crash between write and mark still serves the corrected day; golden unchanged | 3 to 5 days |
| **Spike** | Channel, channel versions, binding, `inputsFor(site, asOf)`, and a hold-aware resampler for the six GB power nodes plus one counter channel. Run the build **and** the planner read through it. | See kill criteria below | 1 to 2 days |
| **2. Bindings and versions** | The spike's tables in full, effective-dated; `series.site_id`; resolved versions recorded in slot lineage; `gb_legacy` as the first policy. | `inputsFor` returns exactly the series the old code read; golden identical; no vendor name left in `build.js` | 6 to 9 days |
| **3. One resampler, two consumers** | `resample.js` with per-channel hold and the counter kind; the build and the planner read both use it; the shared validation gate. | Both consumers agree within 0.1%; the "missing becomes zero" and "two inverters sum" scenarios pass | 8 to 12 days |
| **4. Control read-back** | `state` and `ack` kinds, channel direction, queue-time gates, effect check. | Scenario S4 | 5 to 8 days |
| **5. Groups and grants** | The section 6 tables, group views over slot rows, null instead of zero (a method-version bump). | Scenarios S1, S6, S7 | 4 to 6 days |
| **Later, on a trigger** | Policy interpreter (when a second vendor needs a rule the named paths lack), health-based finality, dead-letter replay, per-slot health, PostgreSQL with row-level security. | Triggers named in the stress test | n/a |

**Spike kill criteria** (stop and redesign if any holds): `inputsFor` cannot return exactly the series the current build reads for every test home; the golden hash moves and the cause is a rule that cannot be expressed as a channel setting or named rule; the build and the planner read differ by more than 0.1% on a shared resampler; a plan replay cannot be made reproducible without snapshotting whole databases.

## 9. Acceptance scenarios

| # | Scenario | Passes when |
|---|---|---|
| R1 | Retire the import meter, then add it back (real-home fixture) | Cost, pricing and every slot equal the baseline; no revision rows |
| R2 | End a binding at date D | Slots before D are byte-identical; slots after D use the next candidate with the reason recorded |
| R3 | A new vendor's processor fixture is added at runtime, no engine edit | Solar changes only from D; the engine source has no new vendor name |
| R4 | A writer tries to file facts under another source | Refused, and the real readings are untouched |
| R5 | A provider change would alter past slots | The impact preview lists them; applying needs a reason; the revision log records it |
| S1 | Group of GB30, GB15, NL15, GB60 across currencies and time zones | Two totals (GBP, EUR), never one; Dutch days re-bucketed by slot start; ratios recomputed from sums |
| S2 | Mixed-vendor home: inverter A (5-minute power), inverter B (15-minute counter), meter | Solar is A plus B within 0.1%; build and planner agree; B absent gives "missing", not final |
| S3 | An IoT plug with a counter, a 40-minute outage, a late batch | Energy conserved and flagged; the late batch marks the day dirty in the same transaction; an earlier as-of reproduces earlier rows |
| S4 | A command with read-back and a stale-input block | Stale inputs refuse the command; a late ack is recorded as applied late; the effect check flags a skewed device |
| S5 | Plan replay after a policy or channel change | Same input fingerprint and same plan |
| S6 | A home leaves a group on day X | Days before X include it, after X exclude it; the earlier report re-runs identically |
| S7 | A home shared between two users | The viewer sees energy and cost but cannot queue a command; revoking removes it, including history |

## 10. What this does not solve, and what is still open

- **Not part of the engine** and still open: sign-in and secret storage, redaction of saved raw files (the raw endpoint is open and serves unredacted bodies), a licensed EU price source, verified French, Dutch and one GB tax value, PredHeat details checked against its source, and the Tariffscanner VAT assumption.
- **Not built here:** the planner and optimiser, real vendor adapters (Linky, P1, a second inverter), a scheduler at scale, an edge hub, and the PostgreSQL port.
- **Unproven:** the whole design on a real second vendor. The spike and the first real second processor are the test. The effort estimates are guesses.

## 11. Risks and what not to do

- **Do not write more provider adapters on the current engine.** Each one adds work to undo, or the destructive workaround.
- **Do not build the general policy interpreter first.** Named code paths per policy code are enough until a second vendor needs a rule they cannot express.
- **Do not change the GB output by accident.** Every stage runs against the byte-identical gate, and a deliberate change gets a method-version bump with a revision-log reason.
- **Do not let the live database be the gate.** That is how six tests turned red without any code regression.
- **Risk: an abstraction built on one vendor.** The kill criteria and the second-vendor check are there to catch it early.

## 12. Decisions needed

1. **Go ahead with Stage 0 and 0b now?** Both are low risk and pay off whatever else is decided.
2. **Spike go or no-go,** with the kill criteria above?
3. **Where bindings live.** Per home with market defaults (recommended, because homes in one country can differ).
4. **Group rules.** Accept one chosen time zone per group and two currency totals instead of one converted total.
5. **A frozen real-home fixture.** It holds only energy, prices and tariff structure with every identifier stripped. Approve using your real home's data for it.
6. **Order of the open items** in section 10, in particular whether sign-in and raw-data redaction come before any second home.
