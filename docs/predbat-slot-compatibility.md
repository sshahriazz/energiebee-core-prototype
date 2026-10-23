# Compatibility with the Predbat slot model

How the core's time model lines up with Predbat's step, slot, window and horizon. Source for the Predbat side: the "Predbat and the Slot Model" document. Predbat itself is not built in the core: only the time grid, prices and facts it needs are.

## Verdict

| Predbat idea | In the core | Status |
|---|---|---|
| 5-minute **step** | 5-minute inverter readings; the build integrates them into slots | Compatible |
| **Slot** (default 30 min, configurable) | `site.slot_s` = 900, 1800 or 3600; each ledger row stores `slot_start`, `dur_s`, `tod_min` | Compatible |
| Slots keyed by UTC epoch start | Same: `slot_start` is epoch seconds, aligned to the slot length | Compatible |
| 46 / 50 slots on clock-change days | Tested for London, Paris and Amsterdam at 15, 30 and 60 min | Compatible |
| Local tariff windows resolved to UTC per date | `localToUtc` and the window expander, clock-change safe | Compatible |
| Price array per slot | `rate_interval` rows with `priceOver` (time-weighted when a slot spans prices) | Compatible |
| Dispatch slots (Intelligent Octopus) | Counted against the daily allowance; slots starting at :15 or :45 are covered | Compatible |
| 48-hour **horizon** | Forecast for 48 hours exists; no plan over it | Partial |
| **Windows** (merged slots) | Tariff windows only; plan windows not built | Missing |
| Five **actions** per slot | No plan table | Missing |
| Export start offset (0 to 25 min) | Not built. Rule for other slot lengths: offset is a multiple of 5 min and less than the slot | Missing |
| Write only on change, read back | No device control | Missing |
| Stale inputs give a demand-only plan | Data states exist (final, provisional, missing); no planner gate | Missing |
| Two inverters planned as one battery | Not handled | Missing |

## Example 1: the grid

A home in London at 14:37:20 local time on 23 October 2026 (13:37:20 UTC, clocks still on summer time).

| Predbat quantity | At 30-min slots |
|---|---|
| `now` | 2026-10-23T13:37:20Z |
| `plan_start` (rounded down to the slot) | 2026-10-23T13:30:00Z |
| `minute_offset` into slot 0 | 7 minutes |
| First simulation step | step 1 (the step that starts at :35) |

Slots per day in London, from the core's own time code:

| Slot length | Normal day | 25 October 2026 (clocks go back) | 28 March 2027 (clocks go forward) |
|---|---|---|---|
| 15 min | 96 | 100 | 92 |
| 30 min | 48 | 50 | 46 |
| 60 min | 24 | 25 | 23 |

Steps per slot are `slot_s / 300`: 3 at 15 minutes, 6 at 30, 12 at 60. Predbat's formulas stay the same, with that one number changed.

## Example 2: an off-peak window

Predbat's "off-peak 23:30 to 05:30" starting the evening of 23 October 2026, London.

| | Value |
|---|---|
| Start, local | 23:30 |
| End, local | 05:30 on 24 October |
| In UTC | 2026-10-23T22:30:00Z to 2026-10-24T04:30:00Z |
| Slots at 30 min | 12 |
| Slots at 15 min | 24 |

The core resolves the window per date with the home's time zone, as the Predbat document requires. On the night of 24 to 25 October the same window is 7 real hours long, not 6, because the clocks go back.

## Example 3: a price over a slot

A 30-minute slot with two 15-minute prices (illustrative numbers, not real tariffs):

| Quarter | Price | Import |
|---|---|---|
| 10:00 to 10:15 | 10 c/kWh | 0.1 kWh |
| 10:15 to 10:30 | 30 c/kWh | 0.5 kWh |

- At 15-minute slots the cost is exact: 0.1×10 + 0.5×30 = 16 c.
- At a 30-minute slot the core uses the time-weighted price, 20 c/kWh, so 0.6 kWh costs 12 c.
- The 4 c difference is the price of a longer slot than the price interval. The default slot is therefore the finest price interval of the tariff.

## Where Predbat's tables would attach

| Predbat input | In the core today |
|---|---|
| Rates per slot | `rate_interval` joined to `tariff_agreement` |
| PV forecast (central and pessimistic) | `forecast_fact` issues (central only today) |
| Load history | `site_hh` and 5-minute `reading` rows |
| Live telemetry | `reading` |
| Plan, plan slots | Not built (`plan_run`, `plan_slot` are designed in the roadmap) |

A plan slot would join to what actually happened on the same key: `plan_slot.slot_start = site_hh.slot_start`.

## What would need building

1. `plan_run` and a device-generic `plan_slot` (device, slot, action, parameters), stored only when the plan changes.
2. The simulator, optimiser and window merge as a pure function of the facts known at a given moment.
3. The command path with expiry and read-back.

See `docs/capabilities-and-roadmap.md` for the full list.
