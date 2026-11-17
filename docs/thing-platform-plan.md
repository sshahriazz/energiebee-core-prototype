# Plan: from an energy prototype to a thing-based IoT platform

Status 16 November 2026. Scope for now: **one home, its rooms, its devices, their controls, and the home's power, heating and consumption.** Many homes, other countries and scale come later, but nothing here may block them.

**How to read the sizes.** S is about an hour or two, M a day or two, L several days or more. They are rough guesses, not commitments.

---

## 1. Where we are

The prototype has strong foundations, but it models **a home with energy columns**, not **a home made of things**.

| Area | What exists and works | What is missing |
|---|---|---|
| Raw data | Every provider answer is kept as a file plus a `raw_payload` row, deduplicated by hash. All real facts trace to their raw answer. Replay exists for Sunsynk and push. | Only code stops facts and raw rows from being changed (no triggers). Raw files sit on the same volume as the database. |
| Facts | Append-only and versioned (`recorded_at` / `superseded_at`), with a metric registry (units, aggregation) and source contracts. | Facts hang off `series.subject` = site / device / region. The Sunsynk inverter, battery and PV are **site** series, not things. |
| Things | `device` with a kind registry (18 kinds, passive / controllable), versioned details, `channel` mapping, push ingest that registers devices. | No rooms, no systems, no relationships (feeds, meters, controls). Home 1 has only 4 devices (3 meters, EV). |
| Timelines | `site_hh` (power flow, cost, carbon) and `site_heat_slot` (heating), on the home's slot grid, with data states and lineage, rebuildable. | Both are **wide tables with fixed columns**. A device has no timeline on the grid, and a room or system has none at all. |
| Controls | `device_action`, `device_capability`, `control_limit`, `command` with desired / reported / diff, idempotency, read-back, verify; the executor and driver interface. | Only a simulated driver. No priorities, no group commands, no limits on rooms or circuits. 0 commands in the live database. |
| Integrations | Adapter template (fetch → check → raw → pure parse → facts → rebuild), `market_provider` with licence gating, connection secrets, rate limits that survive restarts. | Adapters choose the internal subject themselves. No general discovery. A thing cannot be linked to two integrations. No real adapter can write. |

**The live database** (`data/core.db`) is sound (integrity check `ok`, no foreign-key errors) but stale: last data 28 October, one sync stuck in `running`, 7 unprocessed rebuild requests, and deltas 076–082 not applied.

**Tests on 16 November:** 694 tests, 684 pass, 6 fail, 4 skipped. All 6 failures run on a copy of the frozen GB fixture `test/fixtures/gb-home.db`, not on the live database (`core.test.js` ×4, `trust-view.test.js`, `slot-build.test.js`): a partial rebuild no longer matches a full one, Quartz scoring finds no forecasts, a fact without a raw link, and the 15-minute house-use forecast. Every fixture-based test passes, including `golden-gb`. The fixture is frozen in October while these tests read the real clock, so the likely cause is the date; not yet proven (fix list B2). An earlier note blamed the stale live database: that was wrong.

## 2. Where we want to be

1. **Everything is a thing**: the home, its floors and rooms, its devices, the systems they form (heating, solar + battery, EV charging) and shared context (region, tariff, weather point).
2. **Things are linked by typed, dated relationships**: `located_in`, `part_of`, `feeds`, `meters`, `controls`, `supplied_on`, `replaces`. They form **two separate structures over the same things**:
   - **The spatial tree** (`located_in`): home → floor → room. It says where a thing is. Room timelines come from it.
   - **The energy system graph** (`feeds`, `meters`): grid connection → meter → inverter (with PV and battery) → the home's supply → loads. It says how energy flows. It is a **flow network, not a tree**: the battery and the grid (and later an EV) both take and give energy, so things have ports and `feeds` edges are directed per port (review R1). Energy totals follow this graph only, never the rooms, so nothing is counted twice.
   - **Home-wide devices** (inverter, PV, battery, main meters) belong to the energy graph at home level and **need no room**. Their timeline is the home's power timeline. A physical spot such as "meters: outside wall" is optional and for maintenance only.
3. **Every thing exposes points**: measurements, totals (counters), states, setpoints and events, grouped into capabilities (power meter, battery storage, thermostat, heat source, on/off, EV charging).
4. **Every thing has a timeline on the same grid**: device → room → floor → system → home, all with the same slot boundaries, so any of them can be overlaid. Power flow, cost and heating become views built from those timelines.
5. **Every thing has controls**: desired vs reported state, priority (safety > manual > schedule > optimiser), limits on any thing (device, room, circuit, home), and commands on a group that split into commands for its members.
6. **All devices talk through a local hub** (decided 17 Nov; architecture v3 section 5). The hub discovers devices and creates their identities; the core links them to things. Cloud adapters remain for cloud sources (tariffs, weather, carbon, gas CV, solar forecast, supplier meter data) and stand in for a device until its home has a hub. The full design is [docs/thing-model.md](thing-model.md).
7. **Raw data is kept safe**: append-only in the database itself, stored apart from the database, and checked for integrity.
8. **The slotted tariff is the baseline for all money (decided 17 Nov).** Whatever its type, every tariff is converted into a price per slot, past and future, and every cost, saving, comparison and plan is energy per slot × price per slot. A tariff is a context thing whose timeline is its slotted price; a meter is `supplied_on` a tariff for a dated period.

```
SPATIAL TREE (where)                      ENERGY SYSTEM GRAPH (how energy flows)
Home 1                                    Grid connection
├── Outside wall: meters (optional)         └─ Import / export meter ── supplied_on ─► tariff
├── Driveway: EV charger, EV (optional)          └─ Inverter ◄── PV array
├── Living room: thermostat, sensor                    │      └── Battery
└── (more rooms as devices arrive)                     └─ Home supply
                                                            ├── EV charger ─► EV
Context: region G, weather point, gas zone                  ├── heat pump ─feeds─► radiators ─► rooms
Systems: solar + battery, heating, EV charging              └── untracked loads
```

## 3. Rules for every phase

1. **The power timeline must not change by accident.** Before Phase 2, `site_hh` and `site_heat_slot` for home 1 are fingerprinted. Phases 2–3 must reproduce them exactly. A change is allowed only on purpose, with the reason written next to the regenerated golden.
2. **No compatibility shims** (prototype). A table that is replaced is migrated and dropped, not kept beside its replacement.
3. **Every new piece is data, not code**: a new device type, capability, relationship or integration is a registry row and an adapter, never a schema change.
4. **Each phase ends green**: the full test suite, the slot-length run (`npm run test:slots`, at 15 and 60 minutes), and the phase's own exit checks.
5. **Every configuration table is versioned like the facts** (valid time and record time), so any past moment can be rebuilt "as known then". A test fails if a new configuration table lacks them (review R19).
6. **Stable ids and a home on every row.** Things, points and connections have a `uid` (UUIDv7, created by the hub for devices) beside the internal integer id, for APIs, hubs and exports (R3). Every point, series, slot and raw row stores its `home_id`, set on insert (R4).
7. **Rules live in tests as well as triggers.** Every invariant a SQLite trigger enforces is also checked in code tests, so a move to Postgres keeps them (D1).

The problems these rules and the phase changes below prevent are in [the design review](thing-platform-design-review.md) (R1–R19, D1–D10).

---

## Phase 0: baseline (S to M)

Get a clean, current starting point and a fixed reference to compare against.

| # | Work | Size |
|---|---|---|
| 0.1 | Back up `data/core.db` and `data/raw/`. Start the app so deltas 076–082 apply. Close the stuck sync and process the rebuild queue. Sync to today. Find why the 6 tests fail on the GB fixture (fix list B2); any that is not the date is a real bug, and "a partial rebuild gives exactly the rows of a full rebuild" must pass before 0.3, because the fingerprint depends on it. | S to M |
| 0.2 | Look into the warnings on 25 October (the day the clocks went back): daily counters 40–45 % above the 5-minute samples and meter vs inverter CT 38 % apart. Fix it **before** fingerprinting, or the fingerprint keeps the bug. | S to M |
| 0.3 | Fingerprint `site_hh`, `site_day` and `site_heat_slot` for home 1 and the GB fixture. Add a test that compares a rebuild to the fingerprint. Add **fixture homes per topology** (no battery, AC-coupled battery, two inverters, export only, EV, heat pump), each with its own fingerprint, because home 1 covers only one topology (R12). | M |
| 0.4 | ✅ `docs/thing-model.md`: the target design (things, relationships, points, capabilities, the local hub, cloud sources, timelines, money, controls, storage). Written 17 Nov. | M |

**Exit:** database current; full suite green; the fingerprint test in place.

## Phase T: the slotted tariff baseline (L, runs alongside Phase 1)

Every tariff becomes a price per slot. Today the build works out a slot's price on the fly (`priceOver` samples every 15 minutes, `fixedOver` spreads fixed charges) and stores it only inside `site_hh`, only for past slots and only for the home's own tariff. Phase T makes the slotted price a timeline of its own, past and future, that everything reads.

**Two layers:**

```
rate rows + windows + calendars ──► TARIFF PRICE RUNS   shared, one row per price change, per tariff and register
  (rate_interval, register_window)   tariff_price_run    "what this tariff charges, from when to when" (any grid derived exactly)
                                         │
agreement + home taxes + home rows ──► HOME PRICE SLOTS   per home and supply point, at the home's slot length
  + meter's own windows + dispatches    supply_price_slot "what this home pays per kWh in this slot, and its fixed share"
                                         │
                                         ▼
                            cost = slot energy × slot price  (build, compare, planner, per device and room)
```

**How each tariff type becomes slots:**

| Tariff type (in the database today) | Conversion |
|---|---|
| Flat (6,279) | One unit price in every slot while the rate row is valid |
| Economy 7 / day-night (1,986), time of use | `register_window` decides each slot's register (day, night, peak); the register's rate row gives the price. Clock changes: real lengths (`tariff-expand.js` already handles this) |
| Intelligent Octopus Go (3) | Windows as above, plus the home's smart-charge dispatches as an overlay: those slots are priced off-peak for that home only |
| Agile, Tracker, export Agile (3) | Native intervals (30 min, or daily for Tracker) cut onto the 15-minute grid. Future slots exist only once prices are published |
| Day-type calendars (Tempo) | Calendar windows; a day whose colour is not published yet is priced with the stated cautious default and marked estimated |
| tounify day-ahead (FR/NL) | Native 15/30/60-minute points cut onto the grid; taxes already in the price, so only VAT is added |
| Fixed export (178) | One export price per slot |
| Gas | One unit price per slot; m³ → kWh conversion stays in the energy layer |
| Standing, subscription, capacity charges | Not per kWh: spread as a fixed share of each slot (daily by the day's real slot count, monthly and yearly by real seconds, capacity by contracted kVA), so every money figure adds up slot by slot |

**Rules:**

1. **Never guess.** A slot whose price is not known yet (Agile beyond its publication) is missing. It is marked estimated only when a stated rule gives a cautious default (Tempo).
2. **Future horizon:** known prices are slotted ahead to the agreement's end or a horizon (14 days to start), so the planner can read them.
3. **Tariffs are stored as price runs, not grid cells** (review R10): one row per price change (a flat tariff is one row, not 96 a day), so no grid is fixed into the data and 5-minute or 15-minute markets fit. The home price slots are materialised at the home's slot length. To reproduce today's numbers exactly, a home slot's price is the time-weighted mean over 15-minute samples, as `priceOver` does now.
4. **Only tariffs in use are stored** (homes' agreements and chosen comparison references). The other ~8,400 catalogue tariffs are expanded on demand by the same pure function.
5. **Consumption-dependent charges** (tiered blocks, peak-demand charges on a monthly peak) can't be priced before consumption is known. The slots carry the rate, and the home's energy layer adds the dependent part once the energy is known, recorded in lineage. None are in the current GB data; the model just must not block them.

| # | Work | Size |
|---|---|---|
| T.1 | `tariff_price_run(tariff_id, register, valid_from, valid_to, unit_ex, estimated, origin, lineage, built_at)`, one row per price change, built by a pure expansion from rate rows, windows and calendars (extends `tariff-expand.js`), for every tariff structure above. | L |
| T.2 | Fixed charges as slot shares (standing, monthly, yearly, capacity). | M |
| T.3 | `supply_price_slot(home, supply point, slot_start, dur_s, tariff_id, register, unit_ex, tax, unit_inc, export_unit, fixed_share, estimated, origin, lineage)` at the home's slot length: agreement in force → tariff price runs → home-specific rows and the meter's own windows → the home's taxes → dispatch overlays → roll-up. After Phase 1 it is the timeline of the supply point (meter) thing. **A supply point can be a sub-meter with its own tariff** (an EV or heat pump tariff): its energy is priced with that tariff and taken out of the main meter's priced energy, recorded in lineage (R11). | L |
| T.4 | Build stage 4 (price) reads `supply_price_slot` instead of calling `priceAt` / `priceOver` / `fixedOver` per slot. | M |
| T.5 | Rebuild: a changed rate row, window, tax rule or agreement marks the tariff's runs dirty from the change, queued **once** for the tariff and then expanded to the homes on it in batches (R9). New Agile prices extend the timeline. | M |
| T.6 | Comparison and the tariff picker: a candidate's cost = the home's slot energy × the candidate's slots, the same code as the home's own bill. | M |
| T.7 | API: `GET /api/tariffs/:id/slots?from&to` and the home's price timeline, past and future. | S |

**Exit:** every tariff in use produces slots with no gaps inside its validity; the fingerprint matches exactly (prices, costs, savings); home 1 has a price timeline at least 7 days ahead where prices are known; a comparison gives the same totals as today's `compare.js`.

## Phase 1: the thing graph (L)

Make the home, rooms, devices and systems real things.

| # | Work | Size |
|---|---|---|
| 1.1 | Delta `thing`: `thing(id, uid, home_id, kind home/space/device/system/context, type, name, attrs, external_std_ref, recorded_at, retired_at)`; `uid` is a UUIDv7, `home_id` is null only for shared context things (R3, R4). `thing_type` registry replaces `device_kind` (type → kind, default capabilities, ports, a Brick / Matter reference). | M |
| 1.2 | Delta `thing_relation(from_id, from_port, rel, to_id, to_port, required, valid_from, valid_to, recorded_at, superseded_at)` with the same overlap triggers as `site_group_member`. Rules in triggers and code tests: at most one current `located_in` per thing, no `located_in` cycles, `meters` and `feeds` only between allowed types and ports. **Ports** make energy edges directed (a battery has charge and discharge ports, R1). **`required`** says whether a member decides its group's data state (R8). **`replaces`** links a replacement device to the one it replaced (R2). A change takes effect at the **next slot boundary**; the exact time is kept for history (R13). | M |
| 1.3 | Move `device` into `thing` (kind `device`) and repoint every reference: `channel`, `binding`, `command`, `device_capability`, `control_limit`, `device_attr_version`, `plan_run_device`. Drop `device`. | M to L |
| 1.3b | **Fold `site` into the `home` thing (decided 16 Nov).** The home's settings (time zone, slot length, currency, location, postcode, region, market) become versioned attributes of the home thing, replacing `site` and `site_version`. Every `site_id` becomes `home_id` → `thing(id)` with a check that the thing's kind is `home`: `site_hh`, `site_day`, `site_heat_slot`, `connection`, `check_result`, `rebuild_queue`, `sync_run`, `raw_payload`, grants, groups, settings, tariffs, plans. Settings the build reads are fetched through one function, so the build doesn't read attribute rows directly. | L |
| 1.4 | Home 1's energy system graph: grid connection, import / export / gas meters, inverter, PV array, battery, with port-directed `feeds` and `meters` relationships, and battery and PV `part_of` the solar + battery system. Move `pv_kwp`, `pv_tilt`, `pv_orientation` and `battery_kwh` onto the PV array and battery things. **One thing per PV array** (each with its own angles and forecast), and any number of batteries and inverters (R18). These home-wide devices get **no room**. | M |
| 1.5 | Spaces for home 1: `Outside wall` (meters) and `Driveway` (EV, and a charger if one is added), as optional placements. Rooms are added as room-level devices arrive. The synthetic home gets rooms for its plug, heat pump and sensor, and its own energy graph. | S |
| 1.6 | API: thing tree, create / rename / retire a space or system, move a thing (a dated `located_in`), list relationships. | M |
| 1.7 | **Raw-data safety (can run in parallel):** triggers that make facts and `raw_payload` append-only (only `superseded_at` may be set, once), **except one logged erasure path** that deletes a whole home and records it in an erasure log (`delete-home.js` and UK GDPR erasure need it, R14); raw files **encrypted with a per-home key**, so destroying the key erases the home's raw data even in backups; `RAW_DIR` so raw files can live on separate storage; a job that checks each file against its hash; the retention dry run checked against the new rules. | M to L |
| 1.8 | Replacing, merging and splitting things: a replacement device is a new thing with `replaces` and the same place in the energy graph; admin operations merge two things discovered twice, or split one wrongly joined, with history kept (R2). | M |

**Exit:** home 1's graph exists with its inverter, battery and PV; moving a device between rooms keeps the old placement in history; nothing reads the graph yet, so the fingerprint is unchanged.

## Phase 2: points and integrations on things (L)

Attach every value to a point on a thing, and make adapters report external identities instead of internal subjects.

| # | Work | Size |
|---|---|---|
| 2.1 | `capability` registry (code, points it brings, actions it allows) and `thing_type_capability`. Start with: power_meter, energy_meter, battery_storage, pv_generation, grid_connection, thermostat, heat_source, valve, on_off, ev_charging, temperature_sensor. | M |
| 2.2 | `point(id, thing_id, capability, key, metric_id, class measurement/total/state/setpoint/event, access read/write/readwrite)`. `series` becomes the per-source feed of a point: `subject_kind` / `subject_id` are replaced by `point_id`, and facts keep their `series_id`. | L |
| 2.3 | `thing_link(thing_id, connection_id, external_ref, valid_from, valid_to)` and `point_binding(point_id, connection_id, external_point, mapping, role shape/total/fallback, priority)`. `point_binding` merges `channel` (scale, sign, counter, limits) and `binding` (priority). Drop both. **Fusion, not only priority** (R6): a point can take its shape from one source (5-minute samples) and its total from another (daily counter, meter), as the build's align, fit and "meter beats CT" steps do today; the fusion rule per point says how, with a tolerance. | L |
| 2.4 | Adapter contract v2: `discover(connection)` returns external devices and points; `parse()` emits `{ external_ref, point, rows }`; the core resolves them through `thing_link` and `point_binding` (the `asWriter` guard stays). Update `_template.js` and `adapters-contract.test.js`. | M |
| 2.5 | Port the adapters in this order: **Sunsynk** (plant → inverter, battery, PV / MPPT, grid and load ports), **Octopus** (meters by MPAN / MPRN, Kraken EV), **push** (Shelly, Tasmota, Home Assistant), **synthetic**. Move home 1's Sunsynk series from the site onto the inverter, battery and PV points. | L |
| 2.6 | Integration manifest: merge what `source`, `market_provider` and `registerAdapter` say into one entry per integration (access mode, auth, markets, licence, rate limits, what it `discovers`, `reads`, `writes`). | M |
| 2.7 | `build.js` and `heat.js` read their inputs through points and relationships ("the PV points that feed this home") instead of site series. The allocation becomes a rule over the energy graph, with today's algorithm as the rule for the "one hybrid inverter" topology; a **topology check** refuses a home the rules don't cover instead of building wrong numbers (R1). Before the old input path is removed, both run side by side and every slot is compared (**dual run**, R12). | L |
| 2.8 | **Derived points** as data: a formula, its inputs and its order (a dependency graph), with each value's lineage naming its inputs. First: home use by energy balance, untracked consumption, COP (R5). | M |
| 2.9 | **`point_state`**: the latest reported value, desired value, time and source per point, updated on ingest and on command. It is the device shadow the pages and the control loop read (R15). | M |

**Exit:** the fingerprint matches exactly; running discovery twice creates nothing new; replaying Sunsynk and push raw files gives the same facts; a fake integration added in a test needs no schema change.

## Phase 3: timelines at every level (L)

Give every thing its own timeline on the shared grid, and roll them up.

| # | Work | Size |
|---|---|---|
| 3.1 | `point_slot(point_id, slot_start, dur_s, mean, min, max, last, delta, state_shares, state, coverage, lineage, method_version)` at the home's slot length and per day. The rule follows the point class: measurement → mean / min / max / last; total → change over the slot, handling resets; state → share of time in each state; setpoint → value in force. | L |
| 3.2 | Rebuilds as a **dependency graph** (R9): dirty ranges per layer and node, merged, processed in order (point → group → home). A rebuild **stops when it converges**: once a day ends with the same carried-over state (battery stock and the like) as the stored build, later days can't change. (Today `processQueue` always rebuilds to today.) Shared changes (tariff, region) are queued once and expanded to homes in batches. Each layer has its own method version, so a change in a lower layer marks the layers above out of date. | L |
| 3.3 | `node_slot(thing_id, slot_start, metric, value, state, lineage)` for spaces, systems and the home. Energy adds up through `meters` (each kWh counted once), plus an **untracked** line (parent meter minus the sum of its sub-meters). Temperatures average through `located_in`. **Only required members decide a node's data state**; an optional member's gap lowers the node's coverage and is named in its lineage, so one dead sensor can't hold the home provisional (R8). | L |
| 3.4 | `site_hh` and `site_heat_slot` are built from point and node slots. The power-flow and cost solver in `build.js` stays, but reads the new tables. | M to L |
| 3.5 | Event timeline per thing (commands, state changes, faults, overrides), rolled up to rooms and the home. Built from `command_log`, facts of the event class and the push log. | M |
| 3.6 | API: `GET /api/things/:id/timeline?from&to&res` and `/events` for any thing (device, room, system, home). | M |
| 3.7 | Benchmarks: rebuilding one day for home 1 stays under 50 ms; a year of point slots per home is measured and recorded. | S |
| 3.8 | **Four lanes on every timeline** (R7): **actual** (past slots), **forecast** (future, by issue time: solar per PV array, home load, room heating demand), **plan** (desired states from `plan_slot`) and **price** (Phase T), all on the same grid, so the planner reads one timeline instead of building its own. | L |

**Exit:** the fingerprint matches; the synthetic home's garage and living room have their own timelines; untracked consumption is shown and never negative beyond meter tolerance.

## Phase 4: controls on every thing (L)

| # | Work | Size |
|---|---|---|
| 4.1 | Actions belong to capabilities (`device_action` → `capability_action`); a thing can do what its capabilities allow, confirmed by its links. | M |
| 4.2 | `control_request(thing_id, capability, desired, priority safety/manual/schedule/optimiser, valid_from, valid_until, source)`: the highest current request wins, and a lower one returns when it expires. The winner becomes the `command`, as today. **External changes** (R16): a reported change no EnergieBee command explains (the owner used the Sunsynk app) becomes a `manual` request with an expiry and is shown to the owner, never silently reverted. A thing can name an **external controller** (Octopus Intelligent Go for the EV); EnergieBee then sends only what that controller allows. | L |
| 4.3 | `control_limit` on any thing: a device (battery reserve), a room (comfort 18–22 °C), a circuit or space (garage ≤ 32 A across its members), the home (export limit). Sum limits are checked across members. **Limit sources are ranked physical > legal > installer > owner > optimiser** (R17): a lower source can only tighten a higher one. The export limit under the network operator's G98/G99 approval is legal and can never be loosened. | M |
| 4.4 | Group commands: a command on a room or system splits into one command per member with the capability, each checked against its own limits, linked by `parent_command_id`. The result shows each member's outcome. | M |
| 4.5 | `execute()` / `readback()` on adapters whose manifest lists write actions. **The first real driver is the Sunsynk inverter (decided 16 Nov: it is the only controllable device the owner has).** Steps: (a) read the current settings only, as state points, for a week; (b) battery reserve %, within installer limits, confirmed by read-back; (c) charge and discharge windows. Every change has a manual revert and expires. Before (b), check whether the Sunsynk login may be used for automated writes: the provider note says a production system needs a partner key. Fallback if Sunsynk writes are not allowed: the BMW 530e already discovered through Octopus Kraken, if it charges on Intelligent Octopus (bump charge, target level). Check this only when Phase 4 starts. | L |
| 4.6 | Scenes and schedules: named sets of desired states, sent through `control_request` with priority `schedule`. | M |

**Exit:** a manual override beats the optimiser and expires correctly; a group command on the garage reaches every capable member; one real device completes send → read-back → verified.

## Phase 5: heating and consumption domains (M to L)

| # | Work | Size |
|---|---|---|
| 5.1 | Heating graph: heat source `feeds` emitters, which `feeds` rooms; thermostat and TRVs `control` the source and emitters; a heating zone is a system. | M |
| 5.2 | Per-room heating timeline: indoor temperature, setpoint, valve opening, demand, time heating was on. Heating system timeline: flow / return temperature, heat output, energy in, COP, degree-hours. `site_heat_slot` built from it; `heat-gb` test unchanged. | M to L |
| 5.3 | Consumption: per device → room → floor → home, plus untracked, with cost (from the meter's tariff) and carbon on each line. | M |

**Exit:** for the synthetic home, room heating and consumption add up to the home's totals within meter tolerance.

## Phase 6: pages (M to L)

| # | Work | Size |
|---|---|---|
| 6.1 | Home → Floor → Room → Device navigation. Each level shows its timeline, its events and its controls. It replaces the Devices page. | L |
| 6.2 | Onboarding: after a provider is connected, show the discovered devices and ask the owner to place each one in a room. | M |
| 6.3 | Integration page: each connection with its health, linked things and last raw answer. | M |

**Exit:** an owner can find any device by room, see its timeline beside its room's, and control it.

---

## 4. Order and what can run in parallel

```
Phase 0 ─┬─► Phase 1 ─► Phase 2 ─► Phase 3 ─┬─► Phase 5 ─► Phase 6
         │      └─ 1.7 raw-data safety       └─► Phase 4
         └─► Phase T (slotted tariffs) ──────────┘ (T.3 joins the supply point thing after Phase 1)
```

Phases 0–3 are the foundation and must go in order. Phase T needs only Phase 0 and runs alongside Phases 1–2; it must be done before Phase 3.4, because the home timeline prices from it. Phase 4 can start once Phase 3's timelines exist. The first real driver (4.5) is the Sunsynk inverter, so check early whether its login may be used for automated writes. Phase 6 can start screen by screen as the APIs arrive.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Rewriting the build's inputs (2.7, 3.4) changes the power timeline without anyone noticing | Fingerprint test from 0.3, fixture homes per topology, and a dual run of old and new engines before the old path is removed; every changed slot explained before a golden is regenerated |
| One change rebuilds far too much (a tariff reaches every home on it; the battery stock carries every rebuild to today) | Rebuilds as a dependency graph that stops when it converges, with shared changes queued once and batched (3.2, T.5) |
| EnergieBee fights the owner or Octopus over a device | Unexplained reported changes become manual overrides; external controllers are respected (4.2) |
| Too many rows in `point_slot` | Measure in 3.7. Home 1 has about 60 points, so about 1 million slot rows a year. That is fine for SQLite; at many homes, the Postgres path in `docs/architecture-v3.md` takes over |
| Mapping external devices to things wrongly (duplicates, the wrong battery) | Identity from the provider's stable ids only; discovery is idempotent and tested; the owner confirms placement |
| A real control command does harm | The first real device is the home's own inverter, so: read-only for a week first, then the lowest-risk setting (battery reserve) within installer limits; limits and priority checked in the core before anything is sent; every change confirmed by read-back, expiring, and revertible by hand |
| Folding `site` into the home thing touches most tables | Done as one delta with a row-count and fingerprint check before and after; the build reads home settings through one function |
| Scope grows into multi-home and multi-country work | Out of scope until Phase 6 is done; only the rule "do not block it" applies |

## 6. Decisions

Made by the owner on 16 November 2026:

| Decision | Answer | Where it lands |
|---|---|---|
| Inverter, PV, battery, main meters | Home-wide, not in a room: they sit in the energy system graph at home level | Section 2, Phase 1.4 |
| Where the meters and the EV are | Meters on an outside wall; EV on the driveway | Phase 1.5 |
| First real device to control | The Sunsynk inverter (the only controllable device the owner has) | Phase 4.5 |
| Devices (17 Nov) | All devices talk through a local hub; cloud adapters for cloud sources and as stand-ins | Section 2, thing-model.md §5 |
| Money baseline (17 Nov) | Every tariff is converted to a slotted tariff; all costs are energy per slot × price per slot | Section 2, Phase T |
| `site` vs the home thing | Fold `site` into the home thing | Phase 1.3b |

Nothing is open that blocks Phases 0–3.
