# The real-world case catalogue (fix list C1)

Written 18 November 2026. `test/cases.test.js` holds the 22 cases of `docs/thing-platform-design-review.md`, each a test on the platform. A case whose part of the design is not built is a **todo** with the reason, so it shows in every run until it is built; none is skipped silently or passed by a weaker test.

| # | Case | State |
|---|---|---|
| 1 | The inverter is replaced by another brand | passes: a new thing in the same place, the old timeline ends at the swap, the home's runs through it |
| 2 | A Zigbee valve re-pairs with a new id | passes: the two things merge, their points merge (the dropped point's feeds move or stay and say where they went), one timeline, the room reads one valve |
| 3 | The hub is offline for two days | passes: the late facts land in the slots of the time they were true; as known during the outage, the gap |
| 4 | The owner changes the reserve in the inverter's app | passes: an external manual request, not reverted before it expires, shown to the owner |
| 5 | Intelligent Octopus charges the car | passes for the controller (no schedule or optimiser request is taken); its off-peak pricing is in the price-run tests |
| 6 | The home switches tariff mid-month | passes |
| 7 | The clocks go back | passes: 50 half-hours in the point layer |
| 8 | The meter and the clamp disagree by 38 % | fusion (R6): `series.fusion_role` shape/total, `setFusion`; the day adds up to the meter, the slots keep the clamp's shape, flagged beyond 5 % |
| 9 | A clamp is installed the wrong way round | passes: one binding change flips the sign |
| 10 | AC-coupled battery or two inverters | passes: supported plants build, an unwired one is refused with a reason |
| 11 | An EV that powers the home | passes: both ways through the charger's and the car's ports; untracked is never negative |
| 12 | A device accepts writes but reports nothing | its action is declared `verification: none`: the command ends `sent_unverified`, never acked, and a safety action is refused (gate `unverifiable`) |
| 13 | The house is sold | occupancy: `handOver` ends the old one, removes its logins, requests and personal answers, and the new owner reads from the handover (`readableFrom`) |
| 14 | The owner asks for their data to be erased | `erasePerson`: the account, their occupancies' personal answers (sealed with the occupancy's key, destroyed) and their groups go; the home keeps its history |
| 15 | A block of flats with communal heating | `thing_share` (dated shares that never add up to more than 1) and `allocateShared`: each flat's timeline gets `shared_*` rows labelled allocated |
| 16 | An EV moves with its owner to a new home | **todo**: the dated home of a thing (R24) |
| 17 | A detached garage on a second hub | passes for the graph (devices of both hubs in one home); marking only one hub's devices offline is not built |
| 18 | One broken temperature sensor in the bedroom | passes: the bedroom is final at half coverage, the dead optional sensor named |
| 19 | Tomorrow's prices are not published yet | passes: the slot has no price, none is estimated |
| 20 | A home with no hub and only cloud devices | passes: cloud links, everything works, no action is offered as confirmed |
| 21 | A plug is moved from the garage to the kitchen at 14:10 | passes: the change is at 14:30, the 14:00 slot is the garage's and the later ones the kitchen's |
| 22 | The slot length changes from 30 to 15 minutes | passes: every layer on one grid, the same energy |

Two things were built for the cases: place slots are rolled up from where things **were** in each slot, not where they are now (case 21), and merging two things merges their points (case 2).
