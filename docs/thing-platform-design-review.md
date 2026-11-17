# Design review: problems to fix in the design now

17 November 2026. A review of everything in [the thing platform plan](thing-platform-plan.md) against the code as it stands, looking for parts that are missing and problems that would be expensive to fix later. Each finding says what goes wrong, why it gets worse later, and the change made to the plan.

Findings are in two groups:

- **Fix in the design now (R1–R19):** cheap today, expensive once data and code depend on the current shape. Each one changes the plan.
- **Keep the door open (D1–D10):** not built now, but the design must not block them.

---

## Fix in the design now

### Model

**R1. The energy system is a flow network, not a tree.**
- *Problem:* the plan calls it a tree, but the battery and the grid both take and give energy, and later an EV with vehicle-to-home will too. A tree can't say "battery → home" and "solar → battery" in the same slot. The build's allocation is hard-coded for one topology (solar to home first, then battery, then grid).
- *Gets worse because:* the first AC-coupled battery, second inverter or vehicle-to-home EV gives wrong numbers silently.
- *Fix:* things have **ports** (AC, DC, import, export), and `feeds` edges are directed per port, so a battery has a charge port and a discharge port. Allocation becomes a rule set over the graph. Today's algorithm is the default rule for the "one hybrid inverter" topology. A **topology check** refuses a home whose graph the rules don't cover, instead of building wrong numbers. → Section 2, Phase 1.2, Phase 2.7.

**R2. A device can be replaced, and discovery can be wrong.**
- *Problem:* when the inverter is replaced, is it the same thing? If the same, its history mixes two serial numbers. If new, the "home battery" timeline breaks. Discovery can also create duplicates (the EV through Kraken and through a charger) or join two devices that should be separate.
- *Fix:* a thing is the **physical device**. A replacement is a new thing with a dated `replaces` relationship and the same place in the energy graph, so home and system timelines run on unbroken while each device timeline starts and ends cleanly. Admin operations **merge** and **split** things, with history kept. → Phase 1.2, new 1.8.

**R3. Ids must be stable outside this database.**
- *Problem:* things get integer ids from SQLite. The local hub in `architecture-v3.md` will need to create things while offline, and a move to Postgres or a merge of databases renumbers them.
- *Fix:* every thing, point and connection gets a **`uid`** (a UUIDv7: unique, time-sortable; the hub creates it for the devices it discovers) beside its integer id. The integer is internal. The uid is the identity used by APIs, hubs and exports. → Section 3, Phase 1.1.

**R4. Every row must know its home, even after `site` is folded into the home thing.**
- *Problem:* facts have no home column today (`docs/database.md` lists this as open), and in the thing model a fact's home sits four joins away (fact → series → point → thing → home). That breaks deleting a home, access checks, per-home queries and, later, Postgres partitioning and row-level security.
- *Fix:* **`home_id` is stored on every point, series, slot and raw row**, set once on insert, never derived at read time. → Section 3, Phase 1.3b, Phase 2.2.

**R5. Derived values need to be data, not code.**
- *Problem:* much of the timeline isn't measured. Home use comes from the energy balance, "untracked" is the parent minus its sub-meters, and COP is heat ÷ electricity. Today these are lines inside `build.js` and `heat.js`. With many things and topologies they multiply and hide.
- *Fix:* **derived points** with a stated formula, inputs and order (evaluated as a dependency graph), each value's lineage naming its inputs. → New Phase 2.8.

**R6. Combining sources is fusion, not just priority.**
- *Problem:* the plan says `point_binding` picks a source by priority. The build already does more than pick: it takes the **shape** from 5-minute samples and the **total** from the daily counter or the meter (align and fit, "meter beats CT"). Priority alone loses that and would change today's numbers.
- *Fix:* `point_binding` declares each source's role, which is **shape**, **total** or **fallback**, and a fusion rule per point (scale the shape to the total within a tolerance, else flag it). → Phase 2.3.

### Timelines and engine

**R7. A timeline needs four lanes, not one.**
- *Problem:* the plan builds past slots only. Planning needs the future: solar forecast on each PV array, load forecast, room heating demand, the plan's desired states, and prices. Without them on the same grid, the planner has to rebuild its own timeline.
- *Fix:* every thing's timeline has four lanes on one grid: **actual** (past), **forecast** (future, by issue time), **plan** (desired, from `plan_slot`) and **price** (from Phase T). → New Phase 3.8.

**R8. One dead sensor must not freeze the home.**
- *Problem:* the plan says a group's slot is provisional or missing if any member's is. A broken temperature sensor would keep the whole home provisional for ever.
- *Fix:* each membership is **required** or **optional**. Only required members decide the group's state. An optional member's gap shows in the group's coverage and lineage. → Phase 1.2, Phase 3.3.

**R9. Rebuilds have to be planned as a dependency graph.**
- *Problem, from the code:* `processQueue` rebuilds from the changed day **to today** every time, because the battery's stored-energy cost carries from one day to the next. Rebuild requests are queued per home. In the thing model one change can spread a long way: a tariff change reaches every home on that tariff, a regional carbon change every home in the region, and a device fact reaches the device, then its rooms and systems, then the home.
- *Fix:*
  - Dirty ranges are tracked per layer and node, merged, and processed in dependency order.
  - **A rebuild stops early when it converges:** once a rebuilt day ends with the same carried-over state (battery stock and the like) as the stored one, later days can't change.
  - Shared changes (tariff, region) are queued once and expanded to homes in batches.
  - **Each layer has its own method version**, so changing the L1 method marks L2 and L3 out of date.

  → Phase 3.2, Phase T.5.

**R10. Tariff slots should be stored as runs, not as 15-minute cells.**
- *Problem:* Phase T stores every tariff on a fixed 15-minute grid. That ties the platform to 15 minutes: 5-minute markets exist, and EU day-ahead prices moved to 15 minutes in 2025. It also makes the row count explode (about 800,000 rows a day if every catalogue tariff were stored).
- *Fix:* a tariff's timeline is stored as **price runs**: from, to, register, price, with one row per change. Any grid is then derived exactly. A flat tariff is one row, not 96 a day. The **home price slots** are still materialised at the home's slot length. The 15-minute cell stays only as the sampling rule that reproduces today's numbers. → Phase T rules, T.1.

**R11. A tariff can belong to a sub-meter.**
- *Problem:* the plan prices everything at the main meter. Some tariffs apply to one device's own meter (EV or heat pump tariffs on a separate supply or a metered charge point).
- *Fix:* the **supply point** in `supply_price_slot` can be any meter thing. The energy measured by a sub-meter with its own tariff is priced with that tariff and taken out of the main meter's priced energy, recorded in lineage. → Phase T.3.

**R12. Multi-topology tests and a dual run, not only one fingerprint.**
- *Problem:* the fingerprint covers home 1's topology only (one hybrid inverter, battery, grid meter). The new engine could pass it and still be wrong for a home without a battery, or with two inverters.
- *Fix:*
  - **Fixture homes per topology:** no battery, AC-coupled battery, two inverters, export only, EV, heat pump.
  - Before the old path is dropped, a **dual run**: old and new engines build side by side and every slot is compared, on the live home for at least a week of syncs.

  → Phase 0.3, Phase 2.7, Phase 3.4.

**R13. Membership changes snap to slot boundaries.**
- *Problem:* a plug moved from the garage to the kitchen at 14:10 splits a slot between two rooms. Splitting slots by time makes every roll-up harder and the numbers harder to explain.
- *Fix:* a membership or relationship change **takes effect at the next slot boundary**. The exact time is still stored for history. → Phase 1.2.

### Safety, privacy and control

**R14. Erasure and append-only conflict.**
- *Problem, from the code:* `delete-home.js` deletes a home's facts and raw files. The append-only triggers in Phase 1.7 would block that, while UK GDPR requires erasure on request.
- *Fix:*
  - The triggers allow one **logged erasure path**: a whole home only, recorded in an erasure log.
  - Raw files are **encrypted with a per-home key**, so destroying the key erases the home's raw data even in backups (crypto-shredding).

  → Phase 1.7.

**R15. The UI and control need the current state, fast.**
- *Problem:* there's no "latest value per point". The `reading_current` index was dropped, and live values are read from facts. The pages and the control loop both need desired vs reported state now.
- *Fix:* a **`point_state`** table: the latest reported value, desired value, time and source per point, updated on ingest and on command. It's the device shadow. → New Phase 2.9.

**R16. Someone else may change the device.**
- *Problem:* the owner can change a setting in the Sunsynk app, and Octopus's Intelligent Go already controls the EV's charging. If EnergieBee sees a difference from its desired state and resends, it fights the user or the supplier.
- *Fix:*
  - A reported change that no EnergieBee command explains is treated as an **external manual override** at `manual` priority, with an expiry, and shown to the owner. It's never silently reverted.
  - A thing can name an **external controller** (Octopus for the EV); EnergieBee then only sends what that controller allows, such as a bump charge.

  → Phase 4.2.

**R17. Limits have a ranking, and some are legal.**
- *Problem:* the plan treats limits as equal. The export limit set under the network operator's G98/G99 approval is a legal limit, and the device's own maximums are physical. Neither may be loosened by the owner or the optimiser.
- *Fix:* limit sources are ranked **physical > legal > installer > owner > optimiser**. A lower source can only tighten a higher one, never loosen it. This is checked in the core before anything is sent. → Phase 4.3.

**R18. Several PV arrays, batteries and inverters from the start.**
- *Problem:* the home stores one `pv_tilt`, one `pv_orientation` and one `battery_kwh`. East-west arrays have two of each, and the solar forecast depends on each array's angles.
- *Fix:* Phase 1.4 creates **one thing per PV array** (each with its own angles and forecast) and allows any number of batteries and inverters. The build adds them up, as it already does for overlapping inverter units. → Phase 1.4.

**R19. Every new configuration table is versioned like the facts.**
- *Problem:* rebuilding history "as known at" a past moment only works if every input is versioned. The new tables (`thing`, `thing_relation`, `thing_link`, `point`, `point_binding`, capabilities, limits, tariff runs) are easy to add without `recorded_at` / `superseded_at`.
- *Fix:* a rule: **every configuration table has valid time and record time**, plus a test that fails if one doesn't. → Section 3.

---

## Keep the door open (not built now)

| # | What | What the design must allow |
|---|---|---|
| D1 | Moving to Postgres (`architecture-v3.md`) | Every rule enforced by a SQLite trigger is also checked by a test in code, and new SQL avoids SQLite-only features where a portable form exists |
| D2 | The local hub agent | The core owns the graph and hubs cache it. Uids (R3) let a hub create things offline |
| D3 | Alerts per thing (offline, stale data, untracked going negative, command failed) | Alerts are events with a severity on the thing's event timeline. `check_result` and connection health feed them |
| D4 | Onboarding for people who can't describe their wiring | Topology templates (the common UK home: hybrid inverter, battery, grid meter) inferred from discovered devices, plus an installer mode |
| D5 | Storage growth | Retention tiers: 5-minute detail for N days, slots and days for ever. Measured in Phase 3.7 |
| D6 | Fair tariff comparison | Static comparison (same usage) now; optimised comparison (usage shifted by the planner) later, from the same slots |
| D7 | Losing the Sunsynk cloud API | A local Modbus path through the hub. Point binding priority (R6) makes the swap a data change |
| D8 | Money rounding and checking against bills | Money stays in minor units at full precision and is rounded only for display. Checking against the supplier's statements is a later check |
| D9 | Live updates on pages | Streaming from `point_state` (R15) |
| D10 | Access per thing (installer, owner, viewer) | Grants are per home now. Things carry `home_id` (R4), so per-thing grants can be added without reshaping |

---

## Real-world gaps (added 17 November)

A second pass, asking whether the design survives real homes rather than the one home it was drawn for. Five more gaps, each with a fix in the design. They are in [the fix list](fix-list.md) as R20–R24.

**R20. A thing shared by several homes.**
- *Problem:* communal heating in a block of flats, a shared EV charger, a heat network, a shared PV roof. The rule "every row has one `home_id`" (R4) cannot say that one device serves several homes, and erasing one home would delete the shared device's history.
- *Fix:* a thing belongs to one **site** (a home, or a building, a block or a car park: a new `site` kind of thing above homes), and homes are linked to it by dated `serves` relationships with a **share** (fixed fraction, or by a sub-meter per home). Energy and cost of a shared thing are split to homes by share in L3 and labelled as allocated, not measured. Erasing a home ends its relationships and never deletes the shared thing.

**R21. A home changes hands.**
- *Problem:* when a house is sold, its PV, meters and history belong to the house, while the previous owner's account, logins, plans and personal settings belong to them. Today access, erasure and ownership are all tied to the home.
- *Fix:* separate **the home's history** (things, facts, timelines: they stay with the home) from **an occupancy** (who lived there, from when to when: grants, provider logins, preferences, plans). A change of owner ends one occupancy and starts another; the new owner sees the home's physical history from the handover only, unless the previous owner shared more. Erasure on request removes the person's occupancy data and their personal raw payloads (supplier account answers), not the home's device history. The per-home encryption key (R14) becomes per occupancy for personal payloads.

**R22. More than one hub, or none.**
- *Problem:* a large house may need two hubs (radio range, a detached garage), a block of flats may run one hub for several homes, and some homes will never have a hub (cloud-only devices).
- *Fix:* the hub is a thing like any other; `served_by` is per device, so a home can have several hubs and a hub can serve devices of several homes (each device still has its own home or site). A home without a hub is a normal state: its devices have cloud links only (thing-model §5.3), not a transition that must end.

**R23. Devices that cannot report their state.**
- *Problem:* control is confirmed by read-back (R16, thing-model §9.3), but some devices accept a write and report nothing (an IR blaster, some relays, some cloud APIs that answer only "accepted").
- *Fix:* each writable point declares its **verification**: `reported` (read-back of the state), `effect` (confirmed by a measured effect, such as the power of a plug dropping), or `none`. A command on an unverifiable point ends as `sent_unverified`, never `acked`; the planner treats such a device as uncertain, and safety-class actions are never sent to it.

**R24. A device moves to another home.**
- *Problem:* an EV leaves with its owner; a portable battery or a plug moves house. Its history in the old home must stay there, and the new home must not inherit it.
- *Fix:* a move is a dated change of the thing's home (a version of `home_id`, recorded like any other attribute) and of its links. Facts carry the `home_id` in force when they were recorded (R4), so each home's timelines keep exactly the energy that happened there.

## Real-world case catalogue

Every case is a test to write with the thing platform (fix list C1). "Covered" names the part of the design that handles it; a gap points at its fix.

| # | Case | Covered by | Test |
|---|---|---|---|
| 1 | The inverter is replaced by another brand | `replaces`, a new thing in the same place in the energy graph (R2) | home and system timelines unbroken across the day of the swap; the old inverter's timeline ends |
| 2 | A Zigbee TRV is reset and re-pairs with a new id | merge of two things (R2, plan 1.8) | after the merge, one thing with one timeline; no double counting in the room |
| 3 | The hub is offline for two days | store and forward; late facts are bitemporal (thing-model §6) | replayed data lands in the right slots; "as known at" the outage still shows the gap |
| 4 | The owner changes the battery reserve in the inverter's own app | external change becomes a manual request (R16) | the optimiser does not revert it before its expiry; the owner is told |
| 5 | Intelligent Octopus charges the EV at night | external controller (R16) plus dispatch price overlay (thing-model §8) | no conflicting EnergieBee command; those slots priced off-peak for this home only |
| 6 | The home switches tariff mid-month | dated `supplied_on` plus price runs (thing-model §8) | slots before the switch keep the old price; after it, the new one |
| 7 | The clocks go back (a 25-hour day) | slot grid from local midnight (existing) | 50 half-hours; daily totals and counter fit hold (the 25 October warnings must be explained first, fix list B3) |
| 8 | The meter and the inverter clamp disagree by 38 % | fusion with tolerance (R6) | the slot is flagged, the meter total wins, the shape comes from the clamp; the disagreement shows on the check |
| 9 | A clamp is installed the wrong way round | point binding sign mapping (thing-model §4) | detected by the balance check (import while exporting); fixed by one binding change and a rebuild |
| 10 | AC-coupled battery or two inverters | allocation rules per topology (R1) | supported topologies build; others are refused with a reason, never built wrong |
| 11 | An EV that powers the home (vehicle-to-home) | ports on the EV and the charger (R1) | energy flows both ways through the charger; untracked never goes negative |
| 12 | A device that accepts writes but reports nothing | verification `effect` or `none` (R23) | commands end `sent_unverified`; no safety action is sent |
| 13 | The house is sold | occupancy (R21) | the new owner sees device history from the handover only; the old owner's logins and plans are gone |
| 14 | The owner asks for their data to be erased | erasure path (R14) and occupancy (R21) | the person's data and personal raw payloads are gone; the home's device history stays |
| 15 | A block of flats with communal heating | shared thing on a site with shares (R20) | each flat's heating cost is its share, labelled allocated |
| 16 | An EV moves with its owner to a new home | dated home of a thing (R24) | the old home keeps its EV history; the new home starts empty |
| 17 | A detached garage on a second hub | several hubs per home (R22) | devices on both hubs in one home graph; one hub offline marks only its devices |
| 18 | One broken temperature sensor in the bedroom | required vs optional members (R8) | the home stays final; the bedroom shows lower coverage |
| 19 | Agile prices for tomorrow are not published yet | never guess (thing-model §8) | tomorrow's slots are missing, not estimated; the planner says so |
| 20 | A home with no hub and only cloud devices | cloud links as a normal state (R22) | everything works without a hub; control limited to what the cloud APIs allow |
| 21 | A plug is moved from the garage to the kitchen at 14:10 | relationship changes at the next slot boundary (R13) | the 14:00 slot counts in the garage, 14:30 in the kitchen; no slot split |
| 22 | The home's slot length changes from 30 to 15 minutes | rebuild at the new length (existing, R9) | every layer rebuilt on one grid; the money totals are unchanged |
