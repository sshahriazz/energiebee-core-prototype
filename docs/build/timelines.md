# Timelines at every level (Phase 3)

Written 18 November 2026, while building Phase 3. Code: `src/core/slot-agg.js`, `src/core/point-slots.js`, `src/core/node-slots.js`, `src/routes/things.js` (timeline); migration `20261123000000_point_slot` (`point_slot`, `node_slot`). Tests: `slot-agg`, `point-slots`, `node-slots`, `things-api`.

## 3.1 Point slots

`point_slot(point_id, slot_start, dur_s, mean, min, max, last, delta, state_shares, state, coverage, lineage, method_version)`: one row per slot of the home's grid (its slot length, local midnight, 46 or 50 slots on a clock-change day), for every point that has facts. What a row holds follows the point's class (`src/core/slot-agg.js`, pure):

| Class | Data | The row |
|---|---|---|
| measurement | instant samples, each held until the next or for the source's hold (`source.traits.holdS`) | `mean` time-weighted over the covered time, `min`, `max`, `last` |
| measurement | periods that each hold a mean (carbon intensity, irradiance) | the same over the periods |
| total | periods (a meter half-hour, a derived counter energy) | `delta`: the part of each period inside the slot, added up |
| total | a counter's readings | `delta`: the change across the slot on the line between readings; a fall is unknown, never negative |
| state | instant samples | `state_shares` (the share of the covered time in each value), `state` (held longest) |
| setpoint | instant samples, held until they change | the value in force: `last`, with `min` and `max` |
| event | periods | `delta`: how many touch the slot, and `state_shares.active`: the share of the slot they cover |

`coverage` (0 to 1) is the share of the slot the data speaks for; a value that is not covered is null, never zero and never a guess. Where several sources feed a point, each slot takes the one that covers it best; a tie goes to the source the home's bindings rank first, then to the source's name; `lineage` names the series, its source and how many there were. Forecast-only sources are not actual data and are left out. `buildPointSlots(point, fromDate, toDate)` replaces the rows of those days in one transaction, so a rebuild of a range gives the rows a build of each day gives.

## 3.3 Place slots

`node_slot(thing_id, slot_start, dur_s, metric, value, coverage, state, lineage, method_version)` for the home, its spaces and its systems. A place holds what is in it by `located_in` and `part_of` (its subtree; a thing is in one place at a time, so each kWh is counted once):

- `energy_kwh`: what the tracked devices in the place used (a plug, a charger, a heat pump, an immersion), added up from their consumption points;
- `temperature_c`: the mean of the temperatures its members report;
- for the home: `home_kwh` (what the home used, from the build's own slots) and `untracked_kwh` (that less what the tracked devices did). A shortfall inside the meters' tolerance (5 Wh) is zero; a larger one is a meter problem and the line says nothing, so untracked consumption is never negative.

**Only the members a relation marks `required` decide the place's state** (R8): when one of them has no data the slot is `partial`, when none has any it is `missing`. A gap of an optional member lowers the coverage and is named in `lineage.optional_missing`, so one dead sensor does not hold the home provisional.

## 3.2 The layers and their rebuild

`src/core/layers.js`: a rebuild of a range (`processQueue`) builds the home's slots (`build.js`), then every point's, then every place's, over the same days, bottom to top, so no layer is built from one below it that is older. Each layer carries its own method version (`point_slot.method_version`, `node_slot.method_version`); rows built by an older method are found (`staleDays`) and rebuilt with the next rebuild, and because the layers above are rebuilt with the one below, a change in a lower layer reaches every layer above it. The rebuild already stops when the days converge (the build's own convergence). Shared changes (tariff, region) were queued once and expanded to homes in batches in Phase T; the point layer reads facts, which they do not touch.

## 3.5 Events

`src/core/events.js`: what happened to a thing, and to everything in a place, built on read from `command_log` (commands and what came of them: enqueued, sent, acked, failed) and from the facts: the events its points report (class event: a defrost, a plug-in) and the changes of its state points (a plug on and off). Oldest first, at most 500 (the newest are kept); each entry names its thing. `GET /api/things/:uid/events?from&to&limit`.

## 3.6 The API

`GET /api/things/:uid/timeline?from&to&res`: a device's points slot by slot, or a place's metrics. `from` and `to` are epoch seconds or local dates (default: today; at most 31 days); `res=day` adds one row per local day to each line (totals and events add up; anything else is the mean weighted by coverage with the day's lowest and highest). `lanes=actual,forecast,plan,price` adds the four lanes of a device (3.8). `GET /api/things/:uid/points`: a thing's points with their reported and desired state.

## 3.7 Timing

One day of home 1 (the GB fixture): 25 points, 1,104 point slots, 4 places and 48 place slots built in about 260 ms on the development laptop (`test/layers.test.js` prints it, and fails beyond 10 s). The plan's 50 ms was for the home's own slots (`site_hh`), which this does not change.

## 3.8 The four lanes

`src/core/lanes.js`, all on the home's one grid: **actual** (the point slots), **forecast** (the forecast of record for each slot, the latest issue the core had recorded, added up on the grid: solar per PV array, the home's load), **plan** (the desired states of the plan in force for the device, `v_plan_in_force`) and **price** (the price slots of a supply point, `supply_price_slot`). A lane that does not apply to a thing (a room has no price) is empty.

## Not done here

- Day-resolution rows are computed on read (`res=day`), not stored; a year of point slots per home is measured, not yet recorded.
- `site_hh` and `site_heat_slot` are not yet built from the point and place slots (3.4): the home's slots still come from the build's own inputs; the place layer reads the home's use from them.
- Place slots follow the current `located_in` and `part_of` relations (the tree as it is now), not as it was on the day.
