# The energy graph, spaces and the thing API (Phase 1.4, 1.5, 1.6)

Written 18 November 2026. Code: `src/core/energy-graph.js`, `src/core/things-view.js`, `src/routes/things.js`. Tests: `test/energy-graph-plan.test.js`, `test/energy-graph-gb.test.js`, `test/things-api.test.js`.

## What it is

A home has devices that bring facts (meters, a car) and a plant that, until now, showed only as four numbers and a provider's connection: an inverter, PV panels, a battery. The energy graph makes those things, wires them with port-directed relations, and puts things in spaces. It is made from evidence by one idempotent function and read through an API.

## The seeder

`ensureEnergyGraph(homeId, { declare })` has three parts, so the middle one is testable without a database:

1. `graphFacts(homeId)` reads only: the things of the home (retired ones too), every current relation row (ended ones too), and the evidence: a connection of a provider whose role is `inverter` (today Sunsynk), a non-null `pv_kwp`, `pv_tilt`, `pv_orientation` or `battery_kwh`, measured readings in `solar_w`, `solar_kwh` or `battery_soc_pct`.
2. `planGraph(facts, declare)` is pure: it returns what to create and what to relate, from a table of rules in the module.
3. `applyPlan` writes through `createThing` and `relate` of the thing library only, so the database rules judge every edge (ports, media, types, slot boundaries, cycles).

`ensureEnergyGraph` plans once without a lock; when the plan is empty it returns (a few reads per home). Otherwise it takes the home's lock (`lockHome`), reads the facts again, plans again and applies, in one transaction, so two callers make one set of things.

### What the evidence makes

| Thing | When (and no thing of that type was ever made) |
|---|---|
| inverter | a connection of an inverter provider, or `declare.inverter` |
| pv array | a PV size or angle, or solar readings, or `declare.pvArray` (one array; more only by an explicit act) |
| battery | `battery_kwh`, or battery state-of-charge readings, or `declare.battery` (an existing battery device is adopted, not duplicated) |
| grid connection | a meter (import or export), an inverter, or `declare.gridConnection` |
| home supply | a grid connection or an inverter |
| system `solar_battery` | a PV array or a battery |
| space `outside_wall` | a meter (import, export or gas) |
| space `driveway` | an ev or an ev charger |
| rooms | only what the caller declares (`declare.rooms`), for a home that knows its rooms |

The seeder never guesses: no evidence, no thing; a relation that cannot be known is not written and the result says `wired: false` (two or more inverters: only the certain edges are written).

### Wiring (one inverter, or none)

`feeds` follows ports: connection `meter` to each import and export meter `grid`; each meter `load` to the inverter `grid` (without an inverter, to the supply `in`); PV `dc` to inverter `pv`; inverter `battery` to battery `charge` and battery `discharge` to inverter `battery` (the loop of the model); inverter `ac` to supply `in`; supply `out` to every load through its one ac port (an ev behind a charger is fed by the charger's `ev` port). The gas meter has no consumer thing and gets no feeds. `meters`: each import and export meter meters the connection. `part_of`: PV array, inverter and battery are part of `solar_battery`. A `feeds` edge between two `both` ports is a bidirectional link; its direction is the import reference direction, and import versus export is the meter's type, not the edge.

### Places

Spaces are located in the home. Meters are located in the outside wall, the car and its charger on the driveway; a device with no rule is located in the home; `HOME_WIDE` (inverter, PV array, battery, supply, connection, hub) is only ever at home level, even when a caller asks for a room. A thing that has ever had a place (a `located_in` row in any state) is not placed again, so a move or an end by an owner is never put back.

### Idempotence and no resurrection

Existence is by type among all things of the home including retired ones; a relation is skipped when a current row with the same ends and ports exists, ended or not. Running twice writes nothing (no thing, relation, version or record time). A retired battery is not made again.

### Where it runs

At the end of the provider steps of `syncSite` (a sync may have found a size or a device), at server start (`ensureAllHomes`, a failure of one home is logged and the others go on), and when the synthetic IoT home is made, which declares its inverter and its rooms (Living room: plug and sensor; Utility room: heat pump; the driveway comes from the charger).

### Not done here

The sizes (`pv_kwp`, `pv_tilt`, `pv_orientation`, `battery_kwh`) stay at home level, not on the array and battery things. Nothing reads a size per array yet, and moving them would change about 25 readers twice; they move with Phase 2.7 (the build reading its inputs through points and relationships). Graph-only things (provider `thing`) are left out of the integration device lists (`/api/sites/:id`, the devices screen, onboarding, the planner payload).

## The API

Every thing, relation and home is addressed by uid; no integer id is ever shown. `at` is epoch seconds (or ISO-8601), `known` epoch milliseconds (or ISO-8601); a value in the other unit is a 400. Every error body is `{ error, code }` with `code` one of `bad_request`, `not_found`, `conflict`, `read_only_kind`.

| Method | Path | What |
|---|---|---|
| GET | `/api/thing-types?kind=` | the registry, for building a form |
| GET | `/api/homes/:uid/graph` | `{ home, spatial (tree of located_in), energy { nodes, edges, wired, isolated }, systems, rollup }` |
| GET | `/api/homes/:uid/things?kind=&type=` | the home's things, sorted by kind, type, name |
| POST | `/api/homes/:uid/things` | make a space or a system `{ type, name, attrs?, placeIn?, validFrom? }`, placed in one transaction (a refused placement leaves nothing); devices come from integrations (`read_only_kind`) |
| GET | `/api/things/:uid` | `{ thing, place, relations { out, in }, systems }`; a merged uid answers as the survivor with `merged_from` |
| PATCH | `/api/things/:uid` | rename or change attributes of a space or a system |
| POST | `/api/things/:uid/retire` | next slot boundary; a space that holds things is a 409 naming them; a device of an integration is `read_only_kind` |
| POST | `/api/things/:uid/move` | `{ to, at? }`: a dated `located_in`; moving to where it is writes nothing; a cycle is a 409 |
| GET | `/api/things/:uid/tree`, `/place`, `/relations`, `/reach`, `/history` | walks of the graph, as of `at` and as known at `known` |
| POST | `/api/homes/:uid/relations` | only `part_of` can be written (feeds, meters, controls are set by integrations and the seeder) |
| POST | `/api/relations/:uid/end` | only `part_of` and `located_in` |

Access: an unknown uid, a uid that is not a home where a home is wanted, and a thing or home of another owner give the same 404 (no existence oracle). Writes need what the owner's other routes need (the user can see the home). Shared context (a tariff, a region) is readable by anyone signed in, its relations are limited to the homes the reader can see, and nobody can change it through the API.
