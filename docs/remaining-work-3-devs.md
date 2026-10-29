# Remaining work, split for three developers

Written for: three developers picking up the prototype. It turns `docs/remaining-work.md` into three work streams with separate files, separate schema numbers and agreed hand-offs, so the three can work at the same time without stepping on each other.

Status as of 29 October 2026: `main` holds the finished engine (621 tests; `npm run test:slots` runs 111 at 15 and 60 minutes). Every size below is a **guess**: S is under a day, M is two to three days, L is five days or more (S to M is one to three days, M to L three to six). The load row in section 1 adds those ranges up. The optimiser is not counted: it is an L item in phase 3.

---

## 1. The three streams at a glance

| | Dev 1: Engine and data | Dev 2: Product and quality | Dev 3: Devices, control and operations |
|---|---|---|---|
| Theme | What goes into the slot timeline and how it is derived | What a person sees, and proof that it keeps working | Real devices, commands, integrations and running it safely |
| Main files | `src/core/build.js`, `planner-read.js`, `channels.js`, `counters.js`, `heat.js`, `impact.js`, `replay.js`, the adapters in `src/adapters/` | `public/**`, `src/core/synthetic-iot.js`, `src/core/devices-view.js`, `scripts/`, `docs/` build tooling, UI tests | `src/core/push-ingest.js`, `push-formats.js`, `executor.js`, `control.js`, `commands.js`, `src/jobs/control.js`, new driver files, ops files |
| Schema numbers | 076 to 079 | 080 to 083 | 084 to 089 |
| Rough load (guess) | 11 to 22 days | 10 to 20 days | 12 to 21 days for the items that need nothing from outside, plus 13 to 23 days for items that wait on hardware, a vendor or EU data |
| Blocked by outside input | Nothing | Nothing | Hardware, a vendor choice, EU data, tokens |

Dev 3's stream is the heaviest once the items that wait on you or the client arrive (section 6.2), and the least predictable. Until then, Dev 3 has the items in section 6.1 to work through, and if the inputs arrive together, move one or two of Dev 1's smaller items (1.6, 1.7) across.

---

## 2. Rules so three people do not collide

These come from how the last rounds of parallel work went. Each rule closes a collision that actually happened.

1. **One owner per file, as listed in section 1.** A change in someone else's file is a small, named edit in the pull request description, agreed in the team channel first.
2. **Schema numbers by range.** Deltas are applied once and never edited afterwards. Each developer takes numbers only from their own range, and appends the file name to the `DELTAS` list in `src/db/db.js` in the same commit that adds the file. Numbers 068, 069 and 074 are unused gaps; leave them.
3. **Routes live in route files, not in one big file.** `src/server.js` is 829 lines with 51 route lines, and all three streams add routes. **Task 0** (below) moves each group of routes into its own file under `src/routes/` first, so each developer then edits only their own route file.
4. **One new registry entry per source, in one block.** `src/db/registry.js` is shared. Add sources, metrics and channel defaults in a clearly commented block per stream, and re-read the file right before editing.
5. **Test data comes from the frozen fixture or a temporary database.** No test, script or screenshot run touches `data/core.db`. Use `useDb({ snapshot: true })` from `test/helpers.js`, a fresh temporary database per run, and kill your own server process by its PID, not by name.
6. **Definition of done for every item:** `npm test` and `npm run test:slots` are green; the item has tests; a screen change has a screenshot you have looked at; the relevant doc is updated; any diagram passes the real renderer (Mermaid 12 in Chrome, not only the syntax parser).
7. **Branches.** One branch per item, named `dev1/…`, `dev2/…`, `dev3/…`, merged to `main` with its history after the tests pass on a clean checkout.
8. **Add new tests to the slot-length run.** If an item touches slots, its tests go into the `test:slots` list in `package.json`, so they run at 15 and 60 minutes as well.

### Task 0 (day 1, Dev 2, about half a day): split the routes

Move the route groups of `src/server.js` into `src/routes/` (for example `onboarding.js`, `devices.js`, `push.js`, `providers-health.js`), keeping behaviour identical. All 621 tests must still pass without edits. Dev 1 and Dev 3 start on items that touch no routes until this is merged.

---

## 3. Hand-offs between streams

Each hand-off has one published contract so the receiving developer can start before the sender is finished.

| # | From | To | Contract | Needed by |
|---|---|---|---|---|
| H1 | Dev 1 | Dev 2 | The per-device slot table and the function `deviceSlots(siteId, fromTs, toTs)` returning, per device and slot, the energy, the share of home use and its state. Publish the table definition and a fixture of sample rows before the code is finished | Dev 2 starts the sub-metering screens |
| H2 | Dev 1 | Dev 2 | The impact preview accepts a pending channel change, returning the same shape as a binding preview | Dev 2 builds the channel-change preview |
| H3 | Dev 1 | Dev 2 | The adapter list that can replay, from `replay.js` (name, replayable yes or no, reason) | Dev 2 shows replay for the new adapters |
| H4 | Dev 3 | Dev 2 | The list of control actions per device kind, with parameters and effect checks, from `device_action` | Dev 2 shows the new actions on the Devices page |
| H5 | Dev 3 | Dev 1 | When a pushed device is auto-bound to a role, which role it gets, per device kind | Dev 1 consumers of the new roles |
| H6 | Dev 2 | all | The browser test driver and its helper (start a temporary server, drive Chrome, take screenshots) | Dev 1 and Dev 3 add UI checks for their items |

Publish a contract as a short markdown note in `docs/contracts/` (one file per hand-off) plus a sample payload, and tell the receiver. The receiver may build against the sample payload immediately.

---

## 4. Dev 1: Engine and data

Goal: everything that enters a slot is derived consistently, for any provider and any device, and a past slot can be rebuilt or replayed.

| # | Item | Size | Done when | Notes |
|---|---|---|---|---|
| 1.1 | **Per-device energy in slots** (sub-metering rollup) | M | A table of energy per device per slot (counter-derived energy for plugs, heat pumps and EV chargers, event minutes for events) is written by the build or its own step; it matches the counter difference to 1e-6; it works at 15, 30 and 60 minutes; clock-change days correct; the real-home golden is unchanged | Publishes H1. Uses delta 076. Reads `counters.js` output; do not recompute counters |
| 1.2 | **Consumers for the new roles** | M | `ev_charger_energy` and `plug_energy` feed 1.1; events (plugged in, defrost, grid event) are exposed in slot lineage or a slot flag; each has tests with synthetic devices | Needs 1.1. Heat roles already have a consumer in `heat.js` |
| 1.3 | **Replay for the other adapters** | M | The parse of the meter, Octopus dispatches, carbon, National Gas, Open-Meteo and Quartz adapters is split into pure functions of the saved body; each is registered in `replay.js`; a dry run and a real run are idempotent; the receipt's saved request carries what the parse needs (zone, date) | Publishes H3. Do one adapter at a time. Unit tests use saved real bodies with identifiers removed |
| 1.4 | **Channel changes in the impact preview** | S to M | `previewImpact` takes a pending channel change and re-reads the stored raw receipts through it to show what would be recovered or refused; no rows kept | Publishes H2. Builds on 1.3, so start with Sunsynk and pushed receipts, which can already replay |
| 1.5 | **Meter sum rule** | M | Two meters of one kind and direction are added, with the same unit rules as two inverters (units overlap in time and are summed, a slot counts as covered only as far as the least covered meter); a tariff agreement per meter stays correct | Uses the binding `device_id` pattern from the two-inverter work. Test with the real home split into two meters |
| 1.6 | **Heating across a vendor switch** | S to M | `heat.js` merges two sources over the day of a switch instead of picking one series per metric | Test with a synthetic heat pump switching vendor mid-day |
| 1.7 | **Counter derivation timing** | S | Counter derivation on one device by two years of 5-minute samples is timed; if it is over a stated budget, an incremental derivation is added | Report the numbers in `docs/counters-events-roles.md` |
| 1.8 | **Group rollup (only if slow)** | S to M | Group views at 20 homes by one year are timed against a budget (today 3.7 s for the year, linear); add a rollup table only if the budget is missed | Uses delta 077. Skip if the budget is met and say so |

Phase 3 for Dev 1, only after real inputs exist (see section 7): **the optimiser** (simulator, optimiser, window merge), then the plan, command, read-back and score loop with a real planner. Deferred design items (one shared resampler, rules as data, health-based slot status) wait for their triggers in `docs/remaining-work.md` section 3.

Suggested order: 1.1 (publish H1 early), 1.3, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8.

---

## 5. Dev 2: Product and quality

Goal: every capability can be seen and tried on screen, and regressions are caught without a person clicking.

| # | Item | Size | Done when | Notes |
|---|---|---|---|---|
| 2.0 | **Task 0: split the routes** | S | See section 2. All existing tests pass unchanged | Do this first, day 1 |
| 2.1 | **Housekeeping** | S | `docs/.DS_Store` is ignored and untracked; the stray `pnpm-lock.yaml` is removed (the project uses `package-lock.json`); `.gitignore` is updated | Ask the team before deleting the lock file |
| 2.2 | **Docs build in the repository** | S to M | `npm run docs` builds every doc's diagrams to PNG (Mermaid 12 in Chrome) and every PDF (pandoc then Chrome), with the pandoc binary fetched or documented, and no tool left in a temporary folder | The scripts used so far lived in a scratch folder and are gone after a session. Capture them as `scripts/docs/` |
| 2.3 | **Browser test driver** | M | `npm run test:ui` starts a temporary server on a fresh database, drives Chrome, and checks: the Providers priority input keeps typed text, the add-provider flow reaches the preview, Devices simulate and command show their steps, the Connect panel shows a push, mobile width has no sideways overflow | Publishes H6. Use `playwright-core` with the installed Chrome; add it as a dev dependency only |
| 2.4 | **Full synthetic demo home** | M | A demo home also has a synthetic inverter, meter and tariff written through the real ingest path, so the build produces slots and Timeline, Breakdown, Home and Tariffs show it; labelled synthetic everywhere | Extend `synthetic-iot.js`. Keep deterministic seeds |
| 2.5 | **Remove the demo** | S | A confirmed button and a route delete the synthetic home and everything generated for it; it refuses anything not marked synthetic; the real GB home is never deletable from the page | Test that a non-synthetic home returns a clear refusal and nothing is removed |
| 2.6 | **Sub-metering screens** | M | The timeline and breakdown can show per-device energy beside the home's load (sourced from `deviceSlots`); empty and error states; 15, 30 and 60 minute slots | Needs H1. Start on the sample fixture |
| 2.7 | **Channel-change preview and replay for new adapters, in the Providers screen** | S to M | The mapping flow shows what a channel change would recover or refuse; replay shows each adapter with its reason when it cannot replay | Needs H2 and H3 |
| 2.8 | **Show the new control actions** | S | The Devices page lists each device's actions from `device_action` and sends a test command for any of them on a synthetic device | Needs H4 |
| 2.9 | **Accessibility and mobile pass** | S | Keyboard path and a 390 px width checked on Providers, Devices and the Connect panel; findings fixed | Use screenshots you have looked at |

Suggested order: 2.0, 2.1, 2.3 (publish H6), 2.2, 2.4, 2.5, then 2.6 to 2.8 as the contracts arrive, 2.9 last.

---

## 6. Dev 3: Devices, control and operations

Goal: the system works with real devices and real vendors, commands are safe, and it can be run and recovered.

### 6.1 Can start now, nothing outside is needed

| # | Item | Size | Done when | Notes |
|---|---|---|---|---|
| 3.1 | **Operations runbook and backup** | M | `npm run backup` takes a consistent copy of `data/core.db` (and the raw folder) with a restore check; a written runbook says what the first open applies (deltas 061 to 075), how to rehearse it on a copy, and how to roll back from the backup; the existing test that a copy of the live database opens cleanly is part of the check | Do this before anyone opens the real database with the new code |
| 3.2 | **Continuous integration** | S | A workflow runs `npm test` and `npm run test:slots` on every pull request, on Node 22 and Node 24, and fails on a skipped-test increase | There is no CI today |
| 3.3 | **Push hardening** | M | Per-device keys stored hashed; a rate limit per device; key rotation; a refusal log with no flooding; the optional shared token still works; documented limits for TLS (terminate it in front) | Uses delta 084 |
| 3.4 | **Auto-bind a pushed device** | S | A device registered by its first push is bound to the role that fits its kind (plug energy, heat pump energy, EV charger energy), from its first reading, with a recorded reason | Publishes H5. Operator can still change it on the Providers screen |
| 3.5 | **MQTT bridge example** | S | A compose file with a broker and a small forwarder that posts to `/api/ingest`, with a worked Shelly and Tasmota example; no MQTT client inside the core | Docs plus a script; test with the emulator |
| 3.6 | **More control actions** | M | Plug on and off, heat pump set-point and EV charge start and stop exist as `device_action` rows with parameter ranges, capabilities with a source, and effect checks; each has tests with the simulated driver | Publishes H4. Uses delta 085 |
| 3.7 | **Control arbitration and multi-window schedules** | M to L | Several controllers on one device have a fixed order of priority and a recorded winner; a schedule of several windows is flattened into per-register commands and read back; tests with the simulated driver, including a late acknowledgement and an expired command | Follow the flattening rule in `docs/slot-engine-stress-test.md` section 3 |
| 3.8 | **Raw data redaction and the open raw endpoint** | M | Saved raw bodies and the raw endpoint redact account numbers, meter serials and coordinates (fail closed); an option keeps the original for replay inside the data folder only | Coordinate with Dev 1's replay (1.3): a replay reads the original, never the redacted copy |

### 6.2 Waiting on you or the client (start when the input arrives)

| # | Item | Size | Needs | Done when |
|---|---|---|---|---|
| 3.9 | **First real device on the push endpoint** | S to M | One or two metered smart plugs | Real payloads are saved as fixtures named `.real.json`, the parsers are corrected where they differed from the documented shape, the "not verified on a real device" notes are removed, and the plug runs through a day including a restart |
| 3.10 | **First real control driver** | L | A vendor, its API documentation and a test device or account (a metered smart plug is the safest) | The driver registers itself with `registerControlDriver`; a command is acknowledged only by the device's own read-back; a late acknowledgement and an effect check work on the real device; an unplug test is recorded |
| 3.11 | **A real second inverter or battery brand** | M | A test account or a sample export | A processor, channel rows and a binding put a second brand next to Sunsynk; slots before the switch date are unchanged; any vendor rule the engine cannot express is written up (that is the trigger for rules as data) |
| 3.12 | **A non-UK home with real meter data** | M to L | An NL or FR home: smart meter access or 2 to 4 weeks of readings, plus the tariff | A real EU meter feed through a processor, channels and bindings; 15-minute slots in EUR on the real clock-change day; a group with the UK home shows two currency totals |
| 3.13 | **EU facts and licences** | M | tounify licence, an ENTSO-E token, and a source for FR and NL taxes | French and Dutch tax rules entered with their source; the one UK VAT rate and the Tariffscanner VAT basis checked; tounify and ENTSO-E adapters run on real answers; every figure carries its origin |

Suggested order: 3.1, 3.2 (both protect the other two streams), 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, then 6.2 items as inputs arrive. If an input is late, take the next item from 6.1.

---

## 7. Phases

| Phase | What happens | Exit condition |
|---|---|---|
| 0, day 1 | Task 0 (route split, Dev 2); contracts H1 to H5 agreed in outline; schema ranges and branch names agreed; Dev 3 starts 3.1 and 3.2 | Routes split and merged; CI green; backup tested on a copy |
| 1, about a week | Each developer works their own stream. Contracts H1 and H6 are published first | H1 and H6 published; items 1.1, 1.3, 2.3, 2.4, 3.3, 3.4 merged |
| 2, about a week | Hand-offs consumed: Dev 2 builds 2.6 to 2.8 on the contracts; Dev 1 finishes 1.2 to 1.6; Dev 3 finishes 3.5 to 3.8 | All items in 6.1, 4 and 5 merged; docs and PDFs rebuilt with `npm run docs` |
| 3, when inputs arrive | Real hardware and data (items 3.9 to 3.13); then the optimiser (Dev 1), using real inputs, with Dev 3 on the command loop | A day of a real plug and a real command; one real non-UK home in a group |

The optimiser stays in phase 3 on purpose: it needs real inputs, and building it earlier on synthetic inputs would only prove the synthetic data.

---

## 8. Open decisions for you

1. **The test fixture in git history.** It is your home's de-identified energy data (coordinates rounded to about 11 km). Decide before pushing to the GitHub remote.
2. **Who owns which stream.** The split is by file area, so any of the three can take any stream; Dev 3's stream suits whoever is closest to hardware and the client.
3. **Whether to add CI and a browser test driver.** Both add a dev dependency or a workflow file; they are the recommended way to keep three streams from breaking each other.
