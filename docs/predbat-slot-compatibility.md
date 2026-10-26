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
| Stale inputs give a demand-only plan | `freshness()` in the planner read layer marks each live input ok, stale or missing (below); no planner acts on it yet | Partial |
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

## The planner read layer: which function feeds which input

`src/core/planner-read.js` (plan item B10) turns the facts into the arrays Predbat and PredHeat read: one value per 5-minute step or per slot, on an explicit time axis, as known at a given moment, with gaps left empty. The rules are in `docs/what-it-does.md`, "Planner read layer". The ids are those of `docs/predbat-predheat-requirements.md`.

| Function | Feeds (catalogue ids) | Notes |
|---|---|---|
| `window(site, now, { horizonH, slotS })` | PB-PLAN-04 (5-minute steps, slots, 48-hour horizon), PB-OTH-61 (forecast hours), PB-RATE-01 (plan slot length), PH-MOD-17 (5-minute step) | `planStart`, `minuteOffset`, `firstStep` as in Example 1, at 15, 30 or 60-minute slots. `slotOf` and `stepOf` convert between the two indexes. `todIndex` maps each step to the local clock (for load profiles), and `dayStartSteps` marks the counter resets. |
| `rates(site, from, to, { stepS, asOf, direction })` | PB-RATE-03, PB-RATE-04, PB-RATE-05 (import, export, gas rates), PB-RATE-07 (rate including tax), PB-RATE-09 (standing charge per day), PB-RATE-34, PB-RATE-36 (Intelligent Octopus dispatches priced by the allowance), PH-RATE-01 (gas price in gas mode, import in heat-pump mode) | Minor units per kWh including tax, priced as the timeline prices a slot. Each step also gives its tariff, register, weakest origin, and whether it is estimated or missing. On the GB home it equals the timeline's price for every half-hour. |
| `forecast(site, metric, from, to, { case, stepS, asOf })` | PB-PV-02, PB-PV-10 (solar per slot: `central`, `p10`, `p50`, `p90`, source, time issued), PB-PV-17 (provider forecast, Quartz), PB-LOAD-27 (an external load forecast: our own `load_kwh`), PB-LOAD-37, PH-WX-01 (hourly temperature forecast) | The issue of record as the core stored it by `asOf`, with `issuedAt` per step and runs of steps per issue. A case with no stored forecast gives empty steps and says so. |
| `counterDifferenceSeries(site, metric, from, to, { stepS, asOf })` | PB-LOAD-01 (`load_today`), PB-LOAD-02 (`import_today`), PB-LOAD-03 (`export_today`), PB-PV-01 (`pv_today`) | Energy per step and the counter that resets at local midnight (23- and 25-hour days included), fitted to the inverter's daily total as the timeline is. It equals the timeline's solar and battery figures on the GB home. |
| `loadHistory(site, { daysPrevious, stepS, asOf, excludeMetrics, holidays })`, `predictLoad(history, weights, scaling)` | PB-LOAD-09, PB-LOAD-10 (`days_previous`, weights), PB-LOAD-08 (drop the lowest day), PB-LOAD-13 (holiday days left out), PB-LOAD-16, PB-LOAD-17, PB-LOAD-18 (load scaling), PB-LOAD-22, PB-LOAD-25 (car energy removed), PH-LINK-02 (heat-pump energy removed), PH-CFG-05, PH-CFG-06 (PredHeat's `days_previous` and weights) | One local time-of-day axis, so 17:00 lines up on every day. A gap is left out of the mean rather than filled (Predbat's PB-LOAD-05 and PB-LOAD-06 fill it). `projectProfile` lays the result onto a `window`. |
| `series(site, metric, from, to, { stepS, asOf, source })` | PB-INV-56 (battery temperature history), PB-INV-72 (battery power and charge history for curves and capacity), PB-LOAD-34 (5-minute load, solar and temperature for a learned load model), PH-SEN-01, PH-SEN-02, PH-SEN-03 (outside, inside and set-point temperature history; several inside sensors averaged), PH-SEN-04 (heating energy, per step) | Any metric, by its registry rule (power averaged, energy split by overlap, level held). |
| `state(site, asOf)`, `freshness(site, asOf, limits)` | PB-INV-49, PB-INV-50 (charge level in kWh and %), PB-INV-51 (battery power, + discharging), PB-INV-52 (solar power), PB-INV-53 (load power), PB-INV-54 (grid power, − importing), PB-INV-55 (battery temperature), PB-INV-57 (battery calibrating), PB-CAR-04, PB-CAR-08, PB-CAR-09 (car plugged in, charge limit, charge level), PH-SEN-05 (heating on now), PH-SEN-06 (flow set-point reading; the fixed value is the `flow_temp_c` attribute), PH-SEN-07 (radiator water temperature), PD-06 (stale-input gate) | The latest reading of each, with its time, from the freshest source. The gate's default limit is 60 minutes (PD-06, unverified). Devices, attributes and settings as known at `asOf` come with it. |

## What would need building

1. `plan_run` and a device-generic `plan_slot` (device, slot, action, parameters), stored only when the plan changes.
2. The simulator, optimiser and window merge as a pure function of the facts known at a given moment.
3. The command path with expiry and read-back.

See `docs/capabilities-and-roadmap.md` for the full list.
