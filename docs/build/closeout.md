# Closing the open items (R6, R14, R20 to R24, 2.4 to 2.8, 6.1)

Written 18 November 2026. Code: `src/core/point-slots.js` (fusion), `src/core/commands.js`, `src/core/executor.js`, `src/core/control.js` (verification), `src/core/occupancy.js`, `src/core/shared.js`, `src/core/hubs.js`, `src/core/derived-slots.js`, `src/core/push-ingest.js`; migrations `20261126000000_verification`, `20261127000000_occupancy`, `20261128000000_fusion_moves_shares`. Tests: `verification`, `occupancy`, `derived-slots`, `cases` (all 22 cases pass, none is a todo).

## What was built

| Item | What it is |
|---|---|
| R23 verification | `device_capability.verification` is `reported`, `effect` or `none`. A command on an action that is not `reported` is written once and ends `sent_unverified`: final, never acked, and it never counts as the state the device was confirmed to run (the same ask goes out again). A safety action is refused for such a device (gate `unverifiable`, in `command_block`). `actionsOf` shows the verification. A device whose effect can be measured may still get `verify_status` from the effect check. |
| R21 occupancy | `occupancy` (a person's time at a home), `giveHome` opens one. `handOver` ends the old occupancy and removes what was personal to it (grants, supplier login `connection_secret`, supplier agreements ended, open requests cancelled, personal raw answers); the new owner reads the home's history from the handover (`occupancy.sees_from`, `readableFrom`), or earlier when the previous owner shared more. The things API (timeline, events) applies it. |
| R14 erasure of a person | `erasePerson` removes the account and everything personal to the person's occupancies, logged as an erasure (`kind person`; a handover is `kind handover`). The occupancy rows stay with no person on them, so the home still knows when it was lived in. The home's things, facts and timelines are untouched. |
| Raw answers per occupancy | A source with `traits.personal` (the Octopus account answers) is sealed with the key of the occupancy it was fetched in (`EBRAW2`, `occupancy_key`): destroying the key makes the files unreadable even where a copy survives. Everything else stays sealed with the home key. |
| R6 fusion | `series.fusion_role` (`shape` or `total`), `setFusion(point, { shape, total, tolerance })`. A total point's day is the shape's slots scaled to add up to the total; a day further than 5 % (or the point's `fusion_tolerance`) from it is flagged in each slot's lineage and returned by `buildPointSlots` (`fusion`). |
| R24 move | `rehomeThing`: the old thing ends in the old home with all its history; a successor begins in the new home, empty, with the same kind, provider and reference; `thing_rehome` ties them (`movesOf`). |
| R20 shared thing | `thing_share`: dated shares of a thing for several homes (never more than 1 in total at any time); `allocateShared` writes each home's share of the thing's energy (and cost, given a unit price) into the home's own timeline (`shared_*` node slots), labelled `allocated` with the share and its basis. Erasing a home removes its shares only. |
| R22 hubs | `hubStatus`: a hub whose devices have all been silent for 30 minutes is offline and so are its devices; the devices of another hub are not. |
| 2.4, 2.5 push | A push that registers a device is a discovery report (`discoverDevices`): the same call every integration makes. |
| 2.8 derived | `buildDerivedSlots`: the derived points (home use, untracked, COP) are worked out per slot from the home's point slots and written as the slots of `derived_<code>` points on the home thing, with a lineage; `buildHomePointSlots` runs it after the measured slots. |
| 6.1 | The Devices page links to Places. |

## What stays open, and why

- **4.5 the Sunsynk driver is not built.** The owner's rule: writes off by default, no driver before an explicit go-ahead. The research is in `docs/build/sunsynk-writes.md`.
- **2.7 the dual-run harness is not built.** The build reads its inputs through the graph's points only; the old subject path no longer exists to run beside it. The equivalence is held by the golden rules catalogue (`test/rules-all.test.js`) and `test/plant-points.test.js`.
- **3.2 layers follow the home's rebuild range**, not a separate trigger of their own: a rebuild of a day rebuilds its point and place slots with it. **3.4** `site_hh` and `site_heat_slot` stay as the build's own output, proven equal to the slots by the equivalence tests rather than rebuilt from them.
- **The occupancy read window** applies to the things API (timeline and events). The older pages (explorer, data, the original per-home APIs) still read a home's whole history for whoever may see the home; a new owner of a home that is not fresh should be given a new home id until they are covered.
- **The personal key per occupancy** protects the supplier account answers only. The rest of a home's raw answers stay under the home key.
- **A fusion disagreement shows in each slot's lineage and in the build's return value**; it is not yet a row of the data-trust checks.
- **Planner uncertainty (R23)**: the planner may still plan an action for a `none` device; what changes is that the command is never counted as confirmed. The planner does not yet down-weight such a device.
- **Rooms and onboarding (6.2)**: a device is placed in a room from the Places page; onboarding does not ask for rooms.
