# Points, links, integrations and derived values (Phase 2)

Written 18 November 2026, while building Phase 2. Code: `src/db/seed/capabilities.js`, `src/core/points.js`, `src/core/links.js`, `src/core/integration.js`, `src/adapters/discovery-contract.js`, `src/core/manifest.js`, `src/core/topology.js`, `src/core/derived.js`, `src/db/seed/derived.js`, `src/core/point-state.js`; migrations `20261120000000_points`, `20261121000000_point_binding`, `20261122000000_point_state`. Tests: `capabilities`, `rules-points`, `links`, `integration`, `plant-points`, `manifest`, `topology`, `derived`, `point-state`.

## 2.1 and 2.2: capabilities, points, series on points

**A point is one measurable or settable aspect of a thing.** `point(thing_id, key, metric_id, class, access, capability, …)`: the battery's state of charge, an inverter's power, a room's temperature. `class` is `measurement`, `total`, `state`, `setpoint` or `event`; the rule that maps a metric to a class and an access is one SQL function pair (`metric_point_class`, `metric_point_access`) used by the backfill and by the library. A thing has at most one current point per key; what a point is (its thing, key, metric) never changes, so a feed that moves moves by changing its series, not the point.

**A series is the feed of one source into a point.** `series(point_id, metric_id, source_id)`, unique. Facts keep their `series_id`. `seriesId(subjectKind, subjectId, metric, source)` is still the one door: it finds the thing of the subject (a home is its home thing, or the plant thing that carries the metric; a device its device thing; a region a shared context thing named by the subject text, made once: `carbon:3` a `region`, `ldz:NW` a `gas_zone`, a plain `G` a region with a code), the point of that thing for the metric (made on first use, key = metric code), and the series.

**`series.subject_kind` and `subject_id` stay, as a read model the database derives from the point.** The plan said they would be replaced by `point_id`. They are still columns because about 70 queries of the build, the pages and the explorer name a series by its subject (`'site'` for the home and for plant things that have no integration behind them, `'device'` for a device, `'region'` for a context thing), and replacing them would only move the same `CASE` into every one of those queries. The trigger `series_home` writes them from the point and refuses a series whose home is not its point's home, so they cannot disagree with it. Decided 18 November: kept.

**Capabilities** (`capability(code, points, actions)`, seeded from code, eleven of them) say what a kind of thing can do: the points it brings (key, class, access, and the canonical metric on each type that has the capability) and the actions it allows. A thing type may only name registered capabilities (`thing_type_capabilities_exist`).

## 2.3: point bindings and links

`channel` is now **`point_binding`**: the same columns (scale, sign part, limits, counter, event, clock offsets), plus `point_id`, the point it feeds (a binding is in the home and for the metric of its point). `thing_link` is new: a thing, the provider's own name for it (a serial, an MPAN, a hub's device id), its kind (`cloud`, `hub`, `push`, `manual`, `synthetic`), its connection when there is one, and valid time. One open link per (home, provider, name). A device row with an integration behind it gets its link from the database when it is made (`device_make_link`) and loses it when it is retired (`device_end_link`); a graph-only thing (provider `thing`) has none. `src/core/links.js`: `linkFor`, `thingByRef`, `ensureLink` (idempotent; the name of another thing is a 409), `endLink`.

`binding` (which source fills which role, with windows and priorities) stays until the build stops asking for roles. The plan's fusion rule per point (shape from one source, total from another, with a tolerance) is built where it has a reader: the point slots of Phase 3.

## 2.4: integration contract v2

An integration reports devices and readings by the provider's own names (`src/adapters/discovery-contract.js`: `checkDiscovered`, `checkObservations`). `discoverDevices({ siteId, provider, source, devices })` finds each device's thing by its link or makes the device (and so its thing and link), and binds the points its kind brings and the ones the report lists; a second report of the same devices makes nothing. `ingestByRef` resolves readings through the links and the point bindings; a name with no link comes back in `unknown`, never guessed. A fake integration needs no schema change (`test/integration.test.js`).

## 2.5: ports

- **Sunsynk** and the plant: once the energy graph exists, a home's own series move from its home thing onto the plant thing that carries them (solar to the PV array, charge level and battery power to the battery, grid import and export to the grid connection, the home's use to the home supply), when the home has exactly one such graph-only thing; weather, carbon, the car and heating stay with the home. The series keep their id and their facts: only their point changes, and their subject columns do not (`placePlantPoints`, `plantThing`; also applied to a series made afterwards). The inverter is linked to the provider's plant (`ensureLink` from the connection's reference).
- **Push** finds its devices by link first. **Octopus** and the **synthetic** home make devices through the device row, which makes their links.

## 2.6: the integration manifest

`src/core/manifest.js`: one entry per integration (19), what the core knows of it in one place: how it is reached (`access`), how it logs in (`auth`), the sources it feeds, what it discovers, reads and writes, rate limit and history where known; merged at read time with its markets, licence and credentials need (`market_provider`) and its roles (registered steps). `manifestProblems` says what does not add up (an adapter or provider with no entry, a source in two entries or none). `GET /api/integrations`.

## 2.7: the topology check

`src/core/topology.js` reads a home's graph and classes its plant (`no_plant`, `solar_only`, `solar_battery`, `several_inverters`) and refuses a plant the graph does not explain only where something measured would come out wrong: panels or a battery with no inverter, or not wired to one, while home-level solar or battery power was measured. The build asks before it builds and refuses with the reasons. Today's allocation is the rule for every class it covers; the inputs are already read through the graph's points (2.5), so the old subject-based path and the graph agree by construction (`test/plant-points.test.js` proves the series sit where the graph says).

## 2.8: derived points as data

`src/core/derived.js` (pure): a formula language (numbers, input names, `+ - * /`, `max`, `min`, `abs`, `ratio(a, b, floor)`), inputs that name a point of the home or another derived point, an order of evaluation (a circle is refused), and a lineage naming what each value was worked out of. A missing input makes the value missing, never a guess; an optional input is 0 only when the home has no such point at all. `derived_def` holds the definitions (seeded from `src/db/seed/derived.js`): home use by energy balance, untracked consumption, heat pump COP. Evaluated per slot by the point slots of Phase 3, where the values they need are held.

## 2.9: point state

`point_state(point_id, reported_*, desired_*)`: the device shadow. The fact writers (`putReadings`, `putIntervals`) keep the reported value current, only a newer time replaces it; `setDesired` asks a writable point for a value and `clearDesired` withdraws it (commands will call them in Phase 4); `stateOf(thing)` lists a thing's points with both. `GET /api/things/:uid/points`.
