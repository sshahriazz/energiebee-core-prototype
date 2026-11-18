# Work package "things": the thing graph (plan Phase 1.1, 1.2 and 1.8)

Branch `wp/things`, started from `f59ce42`. This file is updated at the end of every step.

| Step | What | State |
|---|---|---|
| A | Schema, registries, triggers, rules tests (1.1, 1.2) | done, described below |
| B | The thing library (`src/core/things.js`: create, change, retire, move with slot snapping, relate, replace, merge, split, as-known graph and tree reads) and the 1.8 operations | done, described in "Step B" below |

This package is the additive half of Phase 1. It adds tables, rules, a registry seed and a library. It does not touch `site`, `site_version`, `device`, the build or the adapters, and nothing outside the package's own tests reads the new tables yet. The fingerprint of home 1 is therefore unchanged (no fixture or golden was touched).

## Step A: what was built

### Files

| File | What |
|---|---|
| `prisma/migrations/20261118110000_things/migration.sql` | the six tables, the functions and triggers below |
| `src/db/seed/things.js` | the thing types and relation rules as code, and their seeding |
| `src/db/db.js` | seeds them at start-up (next to the other registries); two entries in `EXCLUSION_MESSAGES` |
| `src/db/table-kinds.js` | `thing`, `thing_attr_version`, `thing_relation` are `config`; `thing_type`, `relation_rule` are `registry` |
| `test/rules-things.test.js`, `test/rules/things.json` | every trigger and exclusion constraint broken on purpose (D1) |
| `prisma/schema.prisma` | refreshed with `scripts/refresh-prisma.js` (the diff also realigns some existing columns: that is `prisma db pull` formatting) |

### Tables

Time columns follow the other configuration tables: `valid_from` / `valid_to` in seconds, `recorded_at` / `superseded_at` in milliseconds. Flags are `bigint` 0 / 1 like the rest of the schema.

**`thing_type`** (registry). `type` (primary key, unique across kinds), `kind` (`home | space | device | system | context`), `label`, `capabilities` (jsonb list of capability codes from thing-model section 4, defaults only; no capability table yet), `ports` (jsonb list of `{name, dir: in|out|both, medium: ac|dc|heat|gas}`, shape checked by `thing_type_ports_shape`), `attribute_keys` (jsonb list: the attributes the type may carry), `std_ref`, `description`. `UNIQUE (type, kind)` lets `thing` and `relation_rule` point at a type and its kind together, so a thing's kind can never disagree with its type's.

**`relation_rule`** (registry). One row says that relation `rel` may join a thing of `from_kind` (and optionally `from_type`) to a thing of `to_kind` (optionally `to_type`). It also says what a relation under it must carry:

- `from_ports`, `to_ports`: `none` (no port allowed), `optional`, `required`. A port must be one the type declares.
- `flow = 1`: a directed flow. The from port must be able to send (`out` or `both`), the to port to receive (`in` or `both`), and both carry the same medium.
- `same_type = 1`: both things have the same type (a replacement).
- `acyclic = 1`: the relation never forms a cycle.

The most specific matching rule decides (a rule with a type beats a rule with only a kind). Unique on `(rel, from_kind, from_type, to_kind, to_type)` with nulls as empty text.

**`thing`**. `id`, `uid uuid NOT NULL DEFAULT uuidv7() UNIQUE`, `site_id` (foreign key to `site(id)` ON DELETE CASCADE, null only for kind `context`), `kind`, `type`, `name`, `attrs jsonb` (current values), `std_ref`, `valid_from` (began to exist in the home), `valid_to` (left service), `recorded_at` (default: now), `superseded_at` (set by a merge, step B). Constraints: `(type, kind)` foreign key to `thing_type`; `thing_home_unless_context` (`kind = 'context'` exactly when `site_id` is null); one current home thing per site (`thing_one_home`, partial unique index); `attrs` is a JSON object; windows are ordered.

**`thing_attr_version`**. `thing_id`, `site_id`, `name`, `attrs`, `valid_from`, `valid_to`, `recorded_at`, `superseded_at`. One current row per thing (`thing_attr_version_current`). Written only by the triggers.

**`thing_relation`**. `id`, `site_id`, `from_id`, `from_port`, `rel`, `to_id`, `to_port`, `required` (R8), `valid_from`, `valid_to`, `changed_at`, `recorded_at`, `superseded_at`. The foreign keys to `thing` cascade. Constraints: not self-related; windows ordered; `thing_relation_snapped` (`valid_from >= changed_at`); the two exclusion constraints below.

### Rules in the database

Each has a case in `test/rules-things.test.js`; `test/rules/things.json` records them and `test/rules-all.test.js` compares the union of all areas with the database.

| Rule | Where | Message or name |
|---|---|---|
| a thing's uid never changes | trigger `thing_uid_fixed` (reuses `trg_uid_fixed`) | "uid never changes ..." |
| a thing keeps its kind and its home | trigger `thing_identity_fixed` | "a thing keeps its kind and its home" |
| a thing carries only the keys its type lists | trigger `thing_attrs_allowed` (insert, update of attrs or type) | "attribute % is not carried by type %" |
| every change of name or attributes is a version | triggers `thing_attr_version_on_insert`, `thing_attr_version_on_update` (they write, they do not refuse) | proved by the rows they wrote |
| versions are append-only | trigger `thing_attr_version_append_only`: superseded once, never deleted, except inside a logged erasure (same `erasure_open()` as the facts) | two messages |
| relations join one home or shared context; `site_id` is set from the things | trigger `thing_relation_checks` | "a relation joins things of one home, or shared context"; "relation home differs from the home of its things" |
| only what a rule allows | same trigger | "no % rule allows a % to a %" |
| ports as the rule asks | same trigger | takes no port / needs a port (each side), "type % has no port %", "only receives", "only sends", "carry different media" |
| a replacement has the same type | same trigger | "a % relation joins things of the same type" |
| no loops in `located_in`, `part_of`, `replaces` | same trigger (recursive walk over current relations whose windows overlap the new one) | "a % relation cannot form a cycle" |
| a thing is merged once, into a live thing of its own home and kind (step B) | trigger `thing_merge_checks` | four messages |
| a merged thing takes no new relation (step B) | trigger `thing_relation_alive` | "a merged thing takes no new relation ..." |
| the same edge never overlaps itself | exclusion `relation_no_overlap` on `(from, to, rel, from_port, to_port, window)` where current | "overlapping current relation between these two things" |
| a thing is in one place at a time | exclusion `located_in_one_place` on `(from, window)` where `rel = 'located_in'` and current | "a thing is in one place at a time (overlapping located_in)" |

Order of firing: `BEFORE` triggers run before the table's `CHECK` constraints. The two triggers that look inside a value (`attrs`, the relation window) therefore guard their own input and leave the refusal of a bad value to the `CHECK`.

### Registry seed (`src/db/seed/things.js`)

Owned by the code, like `registry.js`: at start-up `thingSeedDiff` reads the tables, and only missing or differing rows are written, in one transaction. A row the code does not list (an operator's own type or rule) is left alone. A type or rule dropped from the code stays until a migration removes it. Starting an up-to-date database writes nothing (checked by the first case of the test).

Now: **43 types, 29 rules**.

- Types: the first set of thing-model 3.1, plus the 18 device kinds of `device_kind` (so every device row has a type to become a thing of), plus `grid_connection`, `home_supply`, `appliance`, `generic_device`. The device types take their attribute keys from the existing attribute registry (`DEVICE_KINDS`), plus manufacturer, model, serial number and firmware. Every key a type lists is checked to exist in `attribute_def` or in a short list of thing-only keys (`THING_ONLY_KEYS`).
- Ports: a port is where energy or heat enters or leaves a type. A battery has `charge` (in) and `discharge` (out); an inverter has `pv`, `battery`, `ac`, `grid`. Where a connection carries energy both ways (the battery port of the inverter, the grid side of a meter) the port is `both`.
- Rules: `located_in` (device or space to space or home), `part_of`, `feeds` (device to device with ports on both sides, device to space with a port on the from side only), `meters` (from meters, smart plugs and chargers; ports optional), `controls`, `supplied_on` (meters to a tariff context thing), `replaces` (same type), `served_by` (to a hub).

### The slot-snapping contract (R13)

A relation change takes effect at the next slot boundary, so a timeline never splits a slot. The database stores both: `changed_at` is the exact moment (seconds), `valid_from` is the boundary, and `thing_relation_snapped` forbids a `valid_from` before `changed_at`. The database does not compute the boundary, because the slot length belongs to the home. The library (step B) does:

```
validFrom = ceil(changedAt / slotS) * slotS     (a change exactly on a boundary stays on it)
```

The slot grid is anchored to local midnight (src/core/time.js), so the boundary is computed on the day of the change: `ceil((changedAt - dayStart) / slotS) * slotS + dayStart`, never later than the end of that local day (23 and 25 hour days, zones at +5:30 with hourly slots). The home's slot length and time zone come from an option of the library call (`{ slotS, timezone }`), else from the home thing's attributes `slot_s` and `timezone`, else from the `site` row (`homeClock`), because until homes are things the site row is the only place a real home keeps them. An example: a plug moved at 14:10 on a 30-minute grid has `changed_at` 14:10 and `valid_from` 14:30; the 14:00 slot counts in the old room and 14:30 in the new one (catalogue case 21, test "relate: a change takes effect at the next slot boundary"). The same rule applies to the end of the old placement (`valid_to` of the old row equals `valid_from` of the new one).

## Decisions and deviations from the plan

1. **`site_id`, not `home_id`, and the home thing.** As the work package says, `thing.site_id` references `site(id)` for now. A home thing is a thing of kind `home` with the `site_id` of its site (one per site). When the site is folded into the home thing, the conversion creates the home things from the site rows (keeping `site.uid` as `thing.uid`) and replaces `site_id` by `home_id` -> `thing(id)`, which for a home thing is its own id. Nothing in the library should assume more than "the home of a thing".
2. **`retired_at` is `valid_to`.** thing-model 3.1 has `recorded_at, superseded_at, retired_at`. R19 asks every configuration table for `valid_from, valid_to, recorded_at, superseded_at`, and a thing leaving service is the end of its valid time. `superseded_at` is kept for a merge (1.8): the thing that lost a merge is superseded, not deleted.
3. **Kinds are checked through `(type, kind)` foreign keys**, not a trigger.
4. **Attribute versions are written by triggers, record-time ordered.** Like `site_version`: a change supersedes the current version and inserts the next one; `valid_from` of the new version is the change time in seconds, `valid_to` stays null while it is current. A back-dated correction (valid time earlier than record time) has no entry point yet: it would be an insert of a version by the library, which the append-only trigger allows (it only restricts update and delete). Not built, not needed yet.
5. **Name is versioned with the attributes** (`thing_attr_version.name`), because a rename is as much a change of what was known as an attribute change.
6. **`required` is a 0/1 integer**, not a boolean, to match every other flag in the schema and the data layer's `0 / 1` convention (a boolean column would reject a JS `1`).
7. **Extra relation columns:** `changed_at` (the exact time, R13), and in the rule table `flow`, `same_type`, `acyclic`, so those properties are data and not code in the trigger. Two things stay in SQL by name: the exclusion `located_in_one_place` names the relation `located_in` (the plan names it too), and the type of rule shape (`none`, `optional`, `required`).
8. **Extra types:** `grid_connection`, `home_supply` (both in the plan's energy graph but not in the list of types), `appliance` (what a metered plug feeds), `generic_device` (what a hub announces when a type is unknown). The `meter_heat`, `immersion`, `iboost`, `hot_water_tank` types exist because `device_kind` has them.
9. **`hot_water` is one name for two things.** `device_kind` has a device `hot_water` ("the hot water planned as one") and the model has a system type `hot_water`. A type name is unique, so `thing_type` holds the system; the conversion step must turn that device row into a system thing.
10. **No `uid` on `thing_relation` and `thing_attr_version`.** R3 names things, points and connections.
11. **`std_ref` is set for only eight types** (Brick `Building`, `Floor`, `Room`, `Battery`, `Boiler`, `Thermostat`, `Temperature_Sensor`). The class names are from memory of the Brick schema and have not been checked against it. Everything else is null until checked. No Matter or SAREF reference is set.
12. **Cycle check is conservative.** It follows the current relations of the same kind whose window overlaps the new relation's window, without requiring that the edges of the path overlap each other. A loop made of edges that never coexist is refused wrongly in a contrived case; none appears in the cases tested.
13. **A relation to a retired thing, and a changed `thing.type`** are library work, done in step B (`relate`, `changeType`).
14. **`thing_relation` is not append-only.** A change is a supersede plus an insert by the library, the pattern of `site_group_member`; nothing enforces it in the database yet.

## Step B: the thing library and the 1.8 operations

### Files

| File | What |
|---|---|
| `src/core/things.js` | the library (all functions async; everything that writes runs in one `tx()`) |
| `prisma/migrations/20261118110001_thing_ops/migration.sql` | `thing.merged_into`, `thing_op`, `thing_attr_version.life_from/life_to`, two triggers |
| `src/db/table-kinds.js` | `thing_op` is a `log` |
| `test/things.test.js` | 14 cases on synthetic homes (library behaviour, catalogue cases 1, 2, 21, 22) |
| `test/rules-things.test.js`, `test/rules/things.json` | two more triggers broken on purpose (D1) |

### Schema added

- `thing.merged_into` (foreign key to `thing`). Set once, together with `superseded_at` (`thing_merged_is_superseded`). A merged thing keeps its row and its uid.
- Trigger `thing_merge_checks`: a thing is merged once, into a live thing of its own home and kind, and is never created merged (four messages).
- Trigger `thing_relation_alive`: a current relation cannot be written to a merged thing. Superseded rows (history) can still be written.
- `thing_op` (log): `op` (`replace`, `merge`, `split`), `thing_id` (the old, dropped or split thing), `other_id` (the new, surviving or new-from-split thing), `effective_at`, `reason` (required), `detail` jsonb (what moved, what was already there, what the rules refused), `recorded_at`. Cascades with the home.
- `thing_attr_version.life_from / life_to`: the thing's `valid_from` / `valid_to` as of that version. A change of the span of life is now a version too (the version triggers fire on `valid_from` and `valid_to`). Without it, retiring a thing would rewrite what an "as known" read shows: in step A the span of life changed in place.

### The library

Every function takes a thing as an id, a uid string or a row with an id. Time arguments are seconds (`at`) and milliseconds (`known`).

| Function | What it does |
|---|---|
| `getThing`, `resolveThing` | the row; `resolveThing` follows `merged_into`, so the uid a hub still sends for a merged thing lands on the survivor |
| `createThing({ siteId, type, name, attrs, uid, validFrom, stdRef })` | the type gives the kind; a context type has no site and every other kind needs one; `attrs` are checked (below); `uid` is for a hub that made the identity |
| `updateThing(ref, { name, attrs })` | `attrs` is a patch, null removes a key; one call is one version; nothing changed writes nothing |
| `changeType(ref, type)` | within the kind; attributes and every current relation are checked again (the relation trigger is run by touching the relation); a refusal changes nothing |
| `retireThing(ref, { at })` | `valid_to` at the next slot boundary; relations end there; refused while a space or system still holds things |
| `relate({ from, rel, to, fromPort, toPort, at, validTo, required })` | slot snapping; refuses a thing that began later, was retired, or was merged; an open relation to a retired thing is clipped at its retirement |
| `unrelate(id, { at })`, `moveThing(ref, to, { at })` | end a relation at a boundary; move a thing to another place (old placement ends and the new one starts on the same boundary; moving to where it is writes nothing; a placement made ahead of time and not yet in force is cancelled) |
| `replaceThing(ref, { name, attrs, inherit, uid, at, reason })` | a device only. New thing of the same type, `valid_from` at the boundary; the old one is retired there; every current relation of the old one (except `replaces`) is cut at the boundary and written again for the new one with the same ports and other end; `new replaces old` is written. `inherit` lists attribute keys to copy; nothing else is copied. Replacing a device that was replaced already is refused (replace the newer one) |
| `mergeThings(keep, drop, { reason })` | see below |
| `splitThing(ref, { relations, rows, at, name, type, attrs, uid, reason })` | see below |
| `nextSlotBoundary(ts, { slotS, timezone })`, `homeClock(siteId)` | the snapping; the home's grid |
| `thingReferences()` | every single-column foreign key to `thing(id)` outside the thing tables, with the table's kind |

Reads, all "as known": `at` is valid time (default now; `null` reads every window), `known` is record time in ms (default: what is known now). A relation is visible when `recorded_at <= known` and it was not superseded by then.

| Function | What it returns |
|---|---|
| `thingAsKnown(ref, { known })`, `thingsOf(siteId, { kind, type, at, known })` | name, attributes and span of life as of `known` |
| `relationsAt(siteId, { rels, thing, at, known })` | relation rows with the uid of both ends |
| `tree(ref, { rel = 'located_in', at, known })` | recursive CTE, nested `{ ...thing, depth, children }` |
| `placeChain(ref, { at, known })` | the thing, its room, floor, home |
| `reach(ref, { rel = 'feeds', direction: 'out' or 'in', at, known })` | downstream or upstream things, each once at its shortest distance; the walk stops at a thing already on its path, so the loops of a flow network (battery and inverter) end |
| `graph(siteId, { rels, at, known })` | `{ nodes, edges }`; shared context things the edges reach are nodes; an edge whose end is not a node at that time (a `replaces` that outlives the thing it replaced) is left out (`relationsAt` lists it) |
| `thingHistory(ref)` | attribute versions, every relation row ever written, and the operations, for the thing and every thing merged into it (one timeline) |

### Rules of the operations

**Relations are never edited in place.** A change supersedes the old row and writes the new one with the same stamp (`recorded_at` of the new row equals `superseded_at` of the old one), so `known` just before the stamp sees the old graph and `known` at the stamp sees the new one.

**Values.** A key of `attribute_def` is checked by `checkValue` with its registry row (type, range, step, allowed values, shape). The keys only things have (`THING_ONLY_KEYS`) are checked here: `slot_s` is one of 900, 1800, 3600, `timezone` a real zone, `currency` and `country` codes, others a plain value. A key outside the type's list is refused before the database trigger.

**Merge** (two things discovered twice; thing-platform case 2). Both must be live, of one home and kind, and of one type, except that a `generic_device` gives way to the real type (the survivor changes type, which re-checks its relations). Then:
- the survivor takes attribute keys it lacked and the earlier start of the two lives (`valid_to` stays open if either is open);
- the dropped thing's current relations are superseded and written again for the survivor with their own windows. The part of a window for which the survivor already has the same edge (same relation, ports and other end) is not written again, so nothing is counted twice. A `located_in` is not written over a period in which the survivor already has a place: the survivor's place stands. An edge between the two things themselves is dropped. Anything the rules refuse (a cycle, a missing port rule) is not written and is reported. The report is `{ moved, alreadyThere, overridden, between, refused: [...] }` and is stored in `thing_op.detail`;
- every table with a foreign key to `thing(id)` is found from the schema. By the table's kind: versioned configuration (valid and record time, with `id`) is superseded and written again for the survivor; `serving`, `runtime` and unclassified tables are updated; `log`, `fact`, `registry` and `secret` tables are history and stay on the dropped thing (the count is reported). A table whose update is refused (a unique key the survivor already holds) is left as it was, in a savepoint, and reported;
- the dropped thing is superseded with `merged_into`; its attribute versions and relation rows stay, and `thingHistory` of the survivor includes them.

**Split** (one thing was two). The caller names what moves: `relations` (current relation ids) and `rows` (`{ table: [ids] }` for tables that point at the thing; a log, fact, registry or secret table is refused). The new thing has the same kind (default same type, name `<name> (split)`, a copy of the attributes unless `attrs` is given). With `at`, a named relation that straddles the boundary is cut there: the part before stays, the part from the boundary on moves, and the new thing begins at the boundary. A relation that starts later moves whole, one that ended earlier stays. Without `at`, a named relation moves whole from its own start. Nothing is erased: the moved rows are superseded, and a read "as known" before the split still shows the joined thing.

**Atomic.** Every operation is one transaction. A refusal anywhere, including the log row at the end, leaves nothing behind (case "the operations are atomic": a trigger that refuses `thing_op` inserts is used to refuse after all the work was done).

### Decisions and deviations (step B)

1. **`merged_into` and `thing_op` are new, not in the plan.** The plan says "merge and split with history kept". A merge needs a durable pointer so the uid keeps resolving (R3), and an operation log so an admin can see what was done and why. Both are additive.
2. **`life_from / life_to` on the versions** (above). The plan's `retired_at` was already turned into `valid_to` in step A; this makes the change of it known "as of".
3. **Reading the clock from the site row** (`homeClock`). The step A document said a call with neither a parameter nor a home thing uses 1800. It now falls back to the site row first (slot length and time zone), because every real home has one and 1800 would be wrong for a 15-minute home. The site row is read in one function; the fold replaces that one query.
4. **Merge reports instead of failing** when part of a relation cannot move; split and replace fail, because there the caller chose what moves. A merge that must not lose anything can be checked from `relations.refused` and `tables`, and rolled back by throwing in the caller's transaction.
5. **`thing_attr_version.valid_from` is still the time of the change.** A back-dated attribute correction has no entry point yet (step A, decision 4).
6. **A relation is never a hard delete.** `unrelate` ends it; cancelling one that had not started supersedes it.
7. **Not done:** an HTTP API (next wave, it needs homes to be things for access control); checking that `std_ref` values exist in Brick (unchanged from step A); coalescing adjacent identical relation rows after a merge (two rows with touching windows are valid and read as one).
8. **A change of `type` is not versioned.** The version rows carry name, attributes and span of life only. A type changes rarely (a generic device learns what it is) and `changeType` re-checks attributes and relations when it is made, but "as known" reads show the current type.

## What the fold of `site` and `device` into things must do with these tables

The next wave converts every `site` row to a home thing and every `device` row to a device thing. With the tables as they are:

1. **Home things.** Insert one `thing` of kind `home` per site (type `house` or `flat`), `uid = site.uid` (keep it: it is the identity outside), `valid_from = site.created_at`. Move the home's settings into attributes: `timezone`, `slot_s`, `currency`, `country`, `market_code`, `postcode`, `gsp_region`, `carbon_region`, `contracted_kva`, `is_demo`, and the planner details already in `site_attribute` (`pv_kwp`, `pv_tilt`, `pv_orientation`, `battery_kwh` and the rest of `attribute_def` with `applies_to` site) using the key names of `attribute_def`. Write `site_version` history as `thing_attr_version` rows with the same record times (the trigger writes versions on update; a conversion that wants the history inserts versions directly with the older `recorded_at`, then lets the trigger continue from the newest). The `thing` rows' `attrs` must be the newest version.
2. **`site_id` becomes `home_id`.** Replace `site_id` in `thing`, `thing_attr_version`, `thing_relation` and `thing_op` by `home_id -> thing(id)`. A home thing's `home_id` is its own id (insert, then update, or `home_id` deferrable). `thing_one_home`, `thing_identity_fixed` (kind and home never change), `thing_home_unless_context`, `thing_relation_checks` ("one home or shared context"), `thing_merge_checks` and `homeClock` name `site_id` and must be rewritten with it. `ON DELETE CASCADE` to `site(id)` becomes cascade from the home thing, and `delete-home.js` must delete by `home_id` (its foreign-key discovery already follows `thing`).
3. **Device things.** One `thing` of kind `device` per device row, `uid = device.uid`, type from `device.kind` (the 18 kinds all have types; `hot_water` has none: that row becomes a system thing of type `hot_water`), attributes from `device_attr_version` / `attribute_value` (keys of `attribute_def`, carried by the type), `valid_from` from the device's first recorded time. Do not give a device a `located_in` it never had: a device without a room is `located_in` the home thing (rule exists: device to home).
4. **Repoint every reference** to `device(id)` and `site(id)` (found through the foreign keys: `series`, `channel`, `binding`, `control_limit`, `command`, `device_capability`, grants, groups ...) to `thing(id)`. Tables that point at a thing fall in the kinds the merge and split handle: `thingReferences()` lists them and the merge test shows what each kind does. Drop `device`, `device_attr_version`, `site_version` and the `site` columns that moved, and remove `device` and `site_version` from `LEGACY_CONFIG` in `table-kinds.js`.
5. **Relations to create from existing data:** `meters` from `device.role` and the channel bindings (meter to home supply, plug to appliance); `feeds` from the inverter topology the build assumes (PV to inverter, inverter to battery and supply, grid to meter), with the ports in `thing_type`; `part_of` into systems; `served_by` from the connection that owns a device; `supplied_on` from `tariff_agreement` (a tariff becomes a `context` thing of type `tariff`). `required` follows the group membership rules (R8). A conversion writes `valid_from` as the agreement's or device's own date and `changed_at` as the recorded time.
6. **Context things** (regions, tariffs, markets, weather points) have `site_id` null today and `home_id` null after; nothing else changes.
7. **`slot_s` and `timezone`:** after the fold `homeClock` reads only the home thing's attributes. Change one query. The slot-length runs (`npm run test:slots`) should then be run: slot snapping of relations changes with the grid.
8. **Registry:** `seedThings` writes `thing_type` and `relation_rule` at start-up; the conversion needs those rows before it runs, so the migration that converts must be followed by a start (or call `seedThings` first).
9. **Facts keep their own `site_id`** (R4); nothing in these tables changes that.
10. **Merge and replace after the fold:** `mergeThings` moves `series.subject_id`-style references only if they become foreign keys to `thing(id)` (a column without a foreign key is not found). Make every reference a real foreign key.

## Measured

- Seed: 43 types and 29 rules; nothing written on a second start.
- A synthetic home of 1013 things (4 floors, 48 rooms, 960 plugs) and 1012 relations on the local database (one run, wall clock through the data layer, includes the Prisma round trips): `tree` of the whole home 5 ms, `graph` 15 ms, `placeChain` 1 ms, `moveThing` 3 ms each (20 in 66 ms), `replaceThing` 10 ms, `mergeThings` 95 ms and `splitThing` 95 ms (most of both is the foreign-key discovery from `information_schema`, run on every call; it is not cached because a test creates tables at run time). Building the 2025 rows through `createThing` and `relate` took 3.0 s (1.5 ms per call, each its own transaction).
- `test/things.test.js`: 14 cases, about 1.5 s after the database is created. `test/rules-things.test.js`: 14 cases (about 15 seconds on a warm template, most of it creating the test database).

## How to run

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/things
TEST_DB_PREFIX=wp_things node --test --disable-warning=ExperimentalWarning test/things.test.js test/rules-things.test.js test/rules-all.test.js
TEST_DB_PREFIX=wp_things node --test --disable-warning=ExperimentalWarning test/table-kinds.test.js test/delete-home.test.js test/erasure.test.js
# after a change to the rule cases: UPDATE_RULES=1 re-records test/rules/things.json
```

Run in step B and passing: the six files above (step A also ran `test/home-rows.test.js` and `test/rules-core.test.js`). `prisma/schema.prisma` was refreshed again (`scripts/refresh-prisma.js`). Not run: the whole suite and `npm run db:migrate` on the development database (the integrator does both; the development database needs both new migrations before start-up reads `thing_type`).

## What is left

- The conversion of `site` and `device` into things, repointing every reference, and the HTTP API (next wave; list above).
- A per-home topology check for the energy graph (Phase 2.7) reads this graph; nothing does yet.
- A back-dated attribute correction (valid time earlier than record time) has no entry point.
- The `site` kind of thing for shared things (R20) needs one more value in the kind checks, by migration.
- Values of the `std_ref` column are unchecked (step A, decision 11).
