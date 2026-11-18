# Heating and consumption (Phase 5)

Written 18 November 2026. Code: `src/core/energy-graph.js` (the heating graph), `src/core/node-slots.js` (the lines), `src/db/seed/things.js` (an emitter gives its heat to the room). Tests: `energy-graph-plan`, `node-slots`, `consumption`.

## 5.1 The heating graph

The seeder (`planGraph`) makes the home's **heating system** (type `heating`) when it has a heat source (a heat pump or a boiler), and wires it by what is certain:

- the heat source `flow` port **feeds** the `flow` port of each emitter (only with exactly one heat source: with two, which feeds which emitter is not guessed);
- each emitter's `heat` port feeds the room it is in (an emitter gained an `out` heat port for this);
- a thermostat **controls** the heat source; a radiator valve controls the emitter beside it in its room (when there is exactly one);
- the sources, emitters, thermostats, valves and the hot-water tank are **part of** the heating system; a **heating zone** is a system the caller declares (`declare.zones: [{ name, things }]`).

Idempotent like the rest of the graph (an existing relation, ended or not, is never written again), and tested in `test/energy-graph-plan.test.js` without a database.

## 5.2 Room and system timelines

Place slots (`docs/build/timelines.md`) became a table of **lines** (`LINES` in `src/core/node-slots.js`): which point of a member a node metric comes from, which field of the point's slot, how the members combine. The new ones:

| Place | Line |
|---|---|
| room, floor, home | `temperature_c` (mean of the temperature points in it), `setpoint_c`, `valve_position_pct`, `heating_on_share` |
| heating system | `heat_output_kwh` (sum), `heating_energy_kwh` (heat pump electricity and boiler gas), `heat_pump_energy_kwh`, `flow_temp_c`, `return_temp_c`, `cop` (heat out per electricity in, the heat pump's only, above 1 Wh), `degree_hours` (against the home's outdoor temperature, base 15.5 °C) |

`site_heat_slot` is **not** rebuilt from these: it stays as `heat.js` builds it (the `heat-gb` fingerprint is unchanged), and `test/consumption.test.js` proves the system's heat output and COP equal the build's heating slots on the synthetic home.

## 5.3 Consumption with cost and carbon

Energy goes up through the tree (`energy_kwh`: device, room, floor, home; each kWh once) beside the home's use (`home_kwh`) and the untracked line. Each energy line carries its **cost** (`energy_cost_minor`, `untracked_cost_minor`, `heat_pump_cost_minor`, `home_cost_minor`: the slot's energy at the slot's import unit price, the meter's own price slot, standing charge not included) and its **carbon** (`..._carbon_g`: at the grid's intensity in the slot, read from the region's carbon facts on the home's own grid). A line with no price or no intensity for the slot has no cost or carbon, never a guess.

**Exit:** on the synthetic home the rooms add up to the home's energy slot by slot (`test/consumption.test.js`).

## Not done here

- Emitters, valves and zones are made only when something declares or discovers them: the synthetic home has a heat pump and a temperature sensor but no radiators, so its room heating line is the temperature.
- Prices and intensities come from the facts the build already stores; a day with no stored price slots has no cost lines.
