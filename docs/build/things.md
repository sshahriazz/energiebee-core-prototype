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
| `prisma/migrations/20261118110000_things/migration.sql` | the five tables of step A (`thing_type`, `relation_rule`, `thing`, `thing_attr_version`, `thing_relation`; `thing_op` is in the second migration), the functions and triggers below |
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

**`thing_relation`**. `id`, `uid` (step B: names the row as written; ending or moving a relation writes a new row with a new uid), `site_id`, `from_id`, `from_port`, `rel`, `to_id`, `to_port`, `required` (R8), `valid_from`, `valid_to`, `changed_at`, `recorded_at`, `superseded_at`. The foreign keys to `thing` cascade. Constraints: not self-related; windows ordered; `thing_relation_snapped` (`valid_from >= changed_at`); the two exclusion constraints below.

### Rules in the database

Each has a case in `test/rules-things.test.js`; `test/rules/things.json` records them and `test/rules-all.test.js` compares the union of all areas with the database.

| Rule | Where | Message or name |
|---|---|---|
| a thing's uid never changes | trigger `thing_uid_fixed` (reuses `trg_uid_fixed`) | "uid never changes ..." |
| a thing keeps its kind, its type and its home (step B: the type was added; a different type is a different thing, merged into the typed one) | trigger `thing_identity_fixed` | "a thing keeps its kind, its type and its home" |
| a hub that makes a thing's identity makes a UUIDv7, like the database | check `thing_uid_v7` | constraint name |
| nothing but a home thing (and shared context) is put in a home that has no live home thing (step B) | trigger `thing_home_exists` | "a home needs its home thing before anything else is put in it" |
| a home thing that names `slot_s` or `timezone` names its site's, until the site is folded into it (step B) | trigger `thing_home_clock` | two messages |
| a thing carries only the keys its type lists | trigger `thing_attrs_allowed` (insert, update of attrs; the type never changes) | "attribute % is not carried by type %" |
| every change of name, attributes or span of life is a version | triggers `thing_attr_version_on_insert`, `thing_attr_version_on_update` (they write, they do not refuse) | proved by the rows they wrote |
| versions are append-only | trigger `thing_attr_version_append_only`: superseded once, never deleted, except inside a logged erasure (same `erasure_open()` as the facts) | two messages |
| relations join one home or shared context; `site_id` is set from the things | trigger `thing_relation_checks` | "a relation joins things of one home, or shared context"; "relation home differs from the home of its things" |
| only what a rule allows | same trigger | "no % rule allows a % to a %" |
| ports as the rule asks | same trigger | takes no port / needs a port (each side), "type % has no port %", "only receives", "only sends", "carry different media" |
| a replacement has the same type | same trigger | "a % relation joins things of the same type" |
| a relation of a home starts and ends on a slot boundary of that home (round 1) | same trigger, with `thing_off_grid` (reads the site's `slot_s` and `timezone`; slots count elapsed time from local midnight, the next midnight is on the grid) | "a relation starts and ends on a slot boundary of its home" |
| no loops in `located_in`, `part_of`, `replaces` | same trigger (recursive walk over current relations whose windows overlap the new one, made under the home's advisory lock, round 1) | "a % relation cannot form a cycle" |
| a thing is merged once, into a live thing of its own home and kind (step B) | trigger `thing_merge_checks` | four messages |
| a merged thing takes no new relation (step B) | trigger `thing_relation_alive` | "a merged thing takes no new relation ..." |
| a relation is never edited: superseded once, never deleted, except inside a logged erasure (step B) | trigger `thing_relation_append_only` | two messages |
| a relation's uid never changes (step B) | trigger `thing_relation_uid_fixed` | "uid never changes ..." (reached only inside an erasure, where append-only steps aside) |
| the operation log is append-only (step B) | trigger `thing_op_append_only` | "append-only: a thing operation is never changed ..." |
| an operation joins two things of one home and takes its home from them (step B) | trigger `thing_op_home` | two messages |
| the same edge never overlaps itself | exclusion `relation_no_overlap` on `(from, to, rel, from_port, to_port, window)` where current | "overlapping current relation between these two things" |
| a thing is in one place at a time | exclusion `located_in_one_place` on `(from, window)` where `rel = 'located_in'` and current | "a thing is in one place at a time (overlapping located_in)" |

Order of firing: `BEFORE` triggers run before the table's `CHECK` constraints. The two triggers that look inside a value (`attrs`, the relation window) therefore guard their own input and leave the refusal of a bad value to the `CHECK`. `thing_relation_checks` and `thing_relation_alive` run on insert only, because a relation is never updated except to supersede it.

### Registry seed (`src/db/seed/things.js`)

Owned by the code, like `registry.js`: at start-up `thingSeedDiff` reads the tables, and only missing or differing rows are written, in one transaction. A row the code does not list (an operator's own type or rule) is left alone. A type or rule dropped from the code stays until a migration removes it. Starting an up-to-date database writes nothing (checked by the first case of the test).

Now: **43 types, 29 rules**.

- Types: the first set of thing-model 3.1, plus the 18 device kinds of `device_kind` (so every device row has a type to become a thing of), plus `grid_connection`, `home_supply`, `appliance`, `generic_device`. The device types take their attribute keys from the existing attribute registry (`DEVICE_KINDS`), plus manufacturer, model, serial number and firmware. Every key a type lists is checked to exist in `attribute_def` or in a short list of thing-only keys (`THING_ONLY_KEYS`).
- Ports: a port is where energy or heat enters or leaves a type. A battery has `charge` (in) and `discharge` (out); an inverter has `pv`, `battery`, `ac`, `grid`. Where a connection carries energy both ways (the battery port of the inverter, the grid side of a meter) the port is `both`.
- Rules: `located_in` (device or space to space or home), `part_of`, `feeds` (device to device with ports on both sides, device to space with a port on the from side only), `meters` (from meters, smart plugs and chargers; ports optional), `controls`, `supplied_on` (meters to a tariff context thing), `replaces` (same type), `served_by` (to a hub).

### The slot-snapping contract (R13)

A relation change takes effect at the next slot boundary, so a timeline never splits a slot. The database stores both: `changed_at` is the exact moment (seconds), `valid_from` is the boundary, and `thing_relation_snapped` forbids a `valid_from` before `changed_at`. Since review round 1 the database also refuses a `valid_from` or `valid_to` that is not a boundary of the home's grid (`thing_relation_checks`, using the site row, which the earlier text wrongly said the database could not know). It still does not compute the boundary: the library does:

```
validFrom = ceil(changedAt / slotS) * slotS     (a change exactly on a boundary stays on it)
```

The slot grid is anchored to local midnight (src/core/time.js), so the boundary is computed on the day of the change: `ceil((changedAt - dayStart) / slotS) * slotS + dayStart`, never later than the end of that local day (23 and 25 hour days, zones at +5:30 with hourly slots). The home's slot length and time zone come from the `site` row (`homeClock`), because until homes are things the site row is the only place a real home keeps them (a home thing that names `slot_s` or `timezone` must name the site's: `thing_home_clock`). Round 1 removed the per-call `{ slotS, timezone }` options: a caller could write a relation off the home's grid with them. `nextSlotBoundary(ts, { slotS, timezone })` stays as a pure function. A relation between two shared context things has no home and no grid; nothing is checked. An example: a plug moved at 14:10 on a 30-minute grid has `changed_at` 14:10 and `valid_from` 14:30; the 14:00 slot counts in the old room and 14:30 in the new one (catalogue case 21, test "relate: a change takes effect at the next slot boundary"). The same rule applies to the end of the old placement (`valid_to` of the old row equals `valid_from` of the new one).

## Decisions and deviations from the plan

1. **`site_id`, not `home_id`, and the home thing.** As the work package says (rule 3: "use site_id now"), `thing.site_id` references `site(id)` for now. Review round 1 asked for `home_id -> thing(id)` now, with "a home thing has `home_id` = its own id" and "every other thing except context has `home_id` pointing at a kind-home thing". Not done, on purpose: it would be a second home column next to `site_id`, kept in step with it, thrown away by the fold. What stands in for the two rules today: one live home thing per site (`thing_one_home`), no thing before its home thing (`thing_home_exists`), kind and home never change (`thing_identity_fixed`), a relation joins things of one home. **The two rules as worded are deferred to the fold (1.3b), which must add them as triggers with D1 cases** (listed in the fold notes below). A home thing is a thing of kind `home` with the `site_id` of its site (one per site). When the site is folded into the home thing, the conversion creates the home things from the site rows (keeping `site.uid` as `thing.uid`) and replaces `site_id` by `home_id` -> `thing(id)`, which for a home thing is its own id. Nothing in the library should assume more than "the home of a thing".
2. **`retired_at` is `valid_to`.** thing-model 3.1 has `recorded_at, superseded_at, retired_at`. R19 asks every configuration table for `valid_from, valid_to, recorded_at, superseded_at`, and a thing leaving service is the end of its valid time. `superseded_at` is kept for a merge (1.8): the thing that lost a merge is superseded, not deleted.
3. **Kinds are checked through `(type, kind)` foreign keys**, not a trigger.
4. **Attribute versions are written by triggers, record-time ordered.** Like `site_version`: a change supersedes the current version and inserts the next one; `valid_from` of the new version is the change time in seconds (the record time for the first version too, since round 1: it was the thing's own start before, which could put the first version after the second; the thing's own span is `life_from` / `life_to`), `valid_to` stays null while it is current. A back-dated correction (valid time earlier than record time) has no entry point yet: it would be an insert of a version by the library, which the append-only trigger allows (it only restricts update and delete). Not built, not needed yet.
5. **Name is versioned with the attributes** (`thing_attr_version.name`), because a rename is as much a change of what was known as an attribute change.
6. **`required` is a 0/1 integer**, not a boolean, to match every other flag in the schema and the data layer's `0 / 1` convention (a boolean column would reject a JS `1`).
7. **Extra relation columns:** `changed_at` (the exact time, R13), and in the rule table `flow`, `same_type`, `acyclic`, so those properties are data and not code in the trigger. Two things stay in SQL by name: the exclusion `located_in_one_place` names the relation `located_in` (the plan names it too), and the type of rule shape (`none`, `optional`, `required`).
8. **Extra types:** `grid_connection`, `home_supply` (both in the plan's energy graph but not in the list of types), `appliance` (what a metered plug feeds), `generic_device` (what a hub announces when a type is unknown). The `meter_heat`, `immersion`, `iboost`, `hot_water_tank` types exist because `device_kind` has them.
9. **`hot_water` is one name for two things.** `device_kind` has a device `hot_water` ("the hot water planned as one") and the model has a system type `hot_water`. A type name is unique, so `thing_type` holds the system; the conversion step must turn that device row into a system thing.
10. **`thing_attr_version` has no `uid`; `thing_relation` got one in step B.** R3 names things, points and connections. A relation row is written, never edited, so its uid names that written row (and a hub can quote it); the version rows are internal.
11. **`std_ref` is set for only eight types** (Brick `Building`, `Floor`, `Room`, `Battery`, `Boiler`, `Thermostat`, `Temperature_Sensor`). The class names are from memory of the Brick schema and have not been checked against it. Everything else is null until checked. No Matter or SAREF reference is set.
12. **Cycle check is conservative.** (Since round 1 the walk runs under the home's advisory lock, the one the library takes, so two writers that bypass the library cannot each add half of a loop: the second waits for the first to commit. Case "no loop even when two writers each add half of one", two connections.) It follows the current relations of the same kind whose window overlaps the new relation's window, without requiring that the edges of the path overlap each other. A loop made of edges that never coexist is refused wrongly in a contrived case; none appears in the cases tested.
13. **A relation to a retired thing** is refused by the library (`relate`, step B). A changed `thing.type` is not allowed at all: step B made the type fixed (`thing_identity_fixed`) and a generic device that turns out to be a thermostat is merged into a thermostat thing.
14. **`thing_relation` is append-only (step B).** A change is a supersede plus an insert by the library, the pattern of `site_group_member`; in step A nothing enforced it, now `thing_relation_append_only` does.

## Step B: the thing library and the 1.8 operations

### Files

| File | What |
|---|---|
| `src/core/things.js` | the library (all functions async; everything that writes runs in one `tx()`) |
| `prisma/migrations/20261118110001_thing_ops/migration.sql` | `thing.merged_into`, `thing_op`, `thing_attr_version.life_from/life_to`, the merge and alive triggers, the operation log's triggers |
| `prisma/migrations/20261118110000_things/migration.sql` | edited in place in step B (a prototype: no second migration for a table made the step before): `thing_relation.uid` and append-only, fixed type, `thing_home_exists`, `thing_home_clock`, `thing_uid_v7`, deferrable keys |
| `src/db/table-kinds.js` | `thing_op` is a `log` |
| `test/things.test.js` | 30 cases on synthetic homes (library behaviour, catalogue cases 1, 2, 21, 22; races, one record time, input checks) |
| `test/rules-things.test.js`, `test/rules/things.json` | every trigger added in step B broken on purpose (D1) |

### Schema added

- `thing.merged_into` (foreign key to `thing`). Set once, together with `superseded_at` (`thing_merged_is_superseded`). A merged thing keeps its row and its uid.
- Trigger `thing_merge_checks`: a thing is merged once, into a live thing of its own home and kind, and is never created merged (four messages).
- Trigger `thing_relation_alive`: a current relation cannot be written to a merged thing. Superseded rows (history) can still be written.
- `thing_op` (log): `op` (`replace`, `merge`, `split`), `thing_id` (the old, dropped or split thing), `other_id` (the new, surviving or new-from-split thing), `effective_at`, `reason` (required), `detail` jsonb (what moved, what was already there, what the rules refused), `recorded_at`. Cascades with the home. Append-only (`thing_op_append_only`), and its `site_id` is taken from the two things (`thing_op_home`).
- `thing_attr_version.life_from / life_to`: the thing's `valid_from` / `valid_to` as of that version. A change of the span of life is now a version too (the version triggers fire on `valid_from` and `valid_to`). Without it, retiring a thing would rewrite what an "as known" read shows: in step A the span of life changed in place.

### The library

Every function takes a thing as an id, a uid string or a row with an id. Time arguments are seconds (`at`) and milliseconds (`known`). Every write names its home with `siteId` (null for shared context) and a thing of another home is a 404, as in the reads; a missing `siteId` is a 400.

| Function | What it does |
|---|---|
| `getThing`, `resolveThing` | the row; `resolveThing` follows `merged_into`, so the uid a hub still sends for a merged thing lands on the survivor |
| `createThing({ siteId, type, name, attrs, uid, validFrom, stdRef })` | the type gives the kind; a context type has no site and every other kind needs one; `attrs` are checked (below); `uid` is for a hub that made the identity and must be a UUIDv7 |
| `updateThing(ref, { siteId, name, attrs })` | `attrs` is a patch, null removes a key; one call is one version; nothing changed writes nothing |
| `retireThing(ref, { siteId, at })` | `valid_to` at the next slot boundary; relations end there; refused while a space or system still holds things, and refused when the date would cancel every relation the thing has (a date before all of them is a typo) |
| `relate({ siteId, from, rel, to, fromPort, toPort, at, validTo, required })` | slot snapping; refuses a thing that began later, was retired, or was merged; an open relation to a retired thing is clipped at its retirement |
| `unrelate(id, { siteId, at })`, `moveThing(ref, to, { siteId, at })` | end a relation at a boundary; move a thing to another place (old placement ends and the new one starts on the same boundary; moving to where it is writes nothing; a placement made ahead of time and not yet in force is cancelled) |
| `replaceThing(ref, { siteId, to, name, attrs, inherit, uid, at, reason })` | a device only. With `to`, a thing the hub announced first (same home and type, live, not replacing another device) takes the place; without it a new thing of the same type is made, `valid_from` at the boundary (`to` brings its own name, attributes and uid; if it has no start yet it begins at the boundary). The old one is retired at the boundary; every current relation of the old one (except `replaces`) is cut at the boundary and written again for the new one with the same ports and other end; `new replaces old` is written. `inherit` lists attribute keys to copy; nothing else is copied. Replacing a device that was replaced already is refused (replace the newer one) |
| `mergeThings(keep, drop, { siteId, reason })` | see below |
| `splitThing(ref, { siteId, relations, rows, at, name, type, attrs, uid, reason })` | see below |
| `nextSlotBoundary(ts, { slotS, timezone })`, `homeClock(siteId)` | the snapping (a pure function); the home's grid |
| `thingReferences()` | every foreign key to `thing` outside the thing tables, with the table's kind; read from `pg_constraint`; a key that is not one column to `thing(id)` (two columns, or `thing(uid)`) throws, so merge and split stop instead of skipping it |

Reads, all "as known": `at` is valid time (default now; `null` reads every window), `known` is record time in ms (default: what is known now). A relation is visible when `recorded_at <= known` and it was not superseded by then.

| Function | What it returns |
|---|---|
| `thingAsKnown(ref, { known })`, `thingsOf(siteId, { kind, type, at, known })` | name, attributes and span of life as of `known` |
| `relationsAt(siteId, { rels, thing, at, known })` | relation rows with the uid of both ends |
| `tree(ref, { rel = 'located_in', at, known })` | recursive CTE, nested `{ ...thing, depth, children }` |
| `placeChain(ref, { at, known })` | the thing, its room, floor, home |
| `reach(ref, { rel = 'feeds', direction: 'out' or 'in', at, known })` | downstream or upstream things, each once at its shortest distance; a level-by-level walk that never expands a thing twice, so the loops of a flow network (battery and inverter) end and a dense network costs its size, not its number of paths |
| `graph(siteId, { rels, at, known })` | `{ nodes, edges }`; shared context things the edges reach are nodes; an edge whose end is not a node at that time (a `replaces` that outlives the thing it replaced) is left out (`relationsAt` lists it) |
| `thingHistory(ref)` | attribute versions, every relation row ever written, and the operations, for the thing and every thing merged into it (one timeline) |

### Rules of the operations

**Relations are never edited in place.** A change supersedes the old row and writes the new one with the same stamp (`recorded_at` of the new row equals `superseded_at` of the old one), so `known` just before the stamp sees the old graph and `known` at the stamp sees the new one.

**Values.** A key of `attribute_def` is checked by `checkValue` with its registry row (type, range, step, allowed values, shape). The keys only things have (`THING_ONLY_KEYS`) are checked here: `slot_s` is one of 900, 1800, 3600, `timezone` a real zone, `currency` and `country` codes, others a plain value. A key outside the type's list is refused before the database trigger.

**One home, one moment.** Every operation that writes takes an advisory lock on its home (`begin`), so two callers on one home run one after the other and the second reads what the first wrote (a device is replaced once, a room is not retired under a new placement, a patch is not lost). The operation also fixes one record time for all it writes: the rows get it as `recorded_at`, and the attribute-version triggers read it from the transaction setting `thing.record_ms`. A replace or merge is therefore one point in record time: a read `known` just before it sees none of it and `known` at it sees all of it (test "one operation is one moment in record time"). A plain `UPDATE` outside the library has no such setting and uses the statement's time.

**Merge** (two things discovered twice; thing-platform case 2). Both must be live, of one home and kind. They must also be of one type, because a thing never changes type; the one exception is a `generic_device` dropped into the typed thing it turned out to be (the other way round is refused with the instruction to swap them). The uid of the dropped thing keeps resolving to the survivor. Then:
- the survivor takes the attribute keys it lacked (only those its type carries) and the earlier start of the two lives (`valid_to` stays open if either is open);
- the dropped thing's current relations are superseded and written again for the survivor with their own windows. The part of a window for which the survivor already has the same edge (same relation, ports and other end) is not written again, so nothing is counted twice. A `located_in` is not written over a period in which the survivor already has a place: the survivor's place stands. An edge between the two things themselves is dropped. The report is `{ moved, alreadyThere, overridden, between }` and is stored in `thing_op.detail`. A relation the rules refuse (a cycle, a missing port) stops the merge with status 409 and nothing is changed;
- every table with a foreign key to `thing(id)` is found from the schema. By the table's kind: versioned configuration (valid and record time, with `id`) is superseded and written again for the survivor; `registry`, `serving`, `secret`, `runtime` and unclassified tables are updated; only the append-only kinds, `log` and `fact`, stay on the dropped thing (the count is reported in `tables`). Round 1 moved `registry` and `secret` out of the "stays" group: `series` is a registry, and a survivor that lost its dropped twin's series would lose data. **Whoever reads a log or fact table that points at a thing must follow `merged_into`** (`resolveThing` for one thing, the family walk of `thingHistory` for the whole timeline). A table whose update is refused (a unique key the survivor already holds) stops the merge with status 409 and nothing is changed;
- the survivor's start is the earlier of the two, and no start (null, in service since the start of history) counts as the earliest, so the survivor does not vanish from the graph before the dropped thing's date (round 1). A relation of the dropped thing that ended only because the dropped thing was scheduled to retire (its `valid_to` equals the thing's) ends at the survivor's own end instead, or stays open;
- the dropped thing is superseded with `merged_into`; its attribute versions and relation rows stay, and `thingHistory` of the survivor includes them.

**Split** (one thing was two). The caller names what moves: `relations` (current relation ids) and `rows` (`{ table: [ids] }` for tables that point at the thing; a log or fact table is refused). The new thing has the same kind (default same type, name `<name> (split)`, a copy of the attributes unless `attrs` is given). With `at`, a named relation that straddles the boundary is cut there: the part before stays, the part from the boundary on moves, and the new thing begins at the boundary. A relation that starts later moves whole, one that ended earlier stays. A moved relation that ended only with the split thing's scheduled retirement is open or ends with the new thing's own end. Without `at`, a named relation moves whole from its own start. Nothing is erased: the moved rows are superseded, and a read "as known" before the split still shows the joined thing.

**Atomic.** Every operation is one transaction, or, when the caller is inside a transaction already, a savepoint, so it fails whole either way: a caller that catches the refusal and carries on keeps its own earlier work and none of the half-done operation (test "the operations are atomic", which uses a trigger that refuses `thing_op` inserts to refuse after all the work was done). A refusal anywhere, including the log row at the end, leaves nothing behind.

**Slot grid.** `homeClock` reads the site row (`slot_s`, `timezone`) until the site is folded into the home thing; `thing_home_clock` stops a home thing from naming other values. The grid is the home's: there is no per-call override any more, and the database refuses a relation off the grid. In zones whose clocks jump at local midnight (Havana, Santiago) `src/core/time.js` ends the day an hour early; `nextSlotBoundary` finds the real end of the day itself (case "a zone whose clocks jump at local midnight"), so a boundary is never before the change. Every `at`, `validTo` and the end written for a cut relation lands on a boundary of that grid, on 23 and 25 hour days too, at 900, 1800 and 3600 seconds (test "every change lands on a slot boundary of its home").

**Units and input.** `at`, `validFrom`, `validTo` are seconds and `known` is milliseconds; a value of the other unit is refused with status 400 instead of read as a far date. Ids and uids are checked (400), a missing thing is 404, a business refusal (merged, retired, outlasting) is 409. What the database refuses on the thing tables is given a status by the library (round 1): a duplicate, an overlap, a rule or a cycle is 409; a check or a value the database cannot take (a NUL in a name) is 400. A `validTo` that is not after the start of the relation is refused up front (400). A hub that announces a uid that exists gets 409 (there is no idempotent announce yet). `required` is 0 or 1. Every walk (`tree`, `placeChain`, `reach`, `thingHistory`) takes a `siteId` and stays inside that home (shared context may be the start); a route must check the person's access to the home first.

**Walks.** `tree` and `placeChain` are recursive CTEs that cut a loop at the second visit. `reach` is a breadth-first walk done level by level in the library, never expanding a thing twice, because a flow network has loops and the number of paths in a dense one is exponential (36 meters in 18 layers: 2^17 paths, walked in a few milliseconds).

### Decisions and deviations (step B)

1. **`merged_into` and `thing_op` are new, not in the plan.** The plan says "merge and split with history kept". A merge needs a durable pointer so the uid keeps resolving (R3), and an operation log so an admin can see what was done and why. Both are additive.
2. **`life_from / life_to` on the versions** (above). The plan's `retired_at` was already turned into `valid_to` in step A; this makes the change of it known "as of".
3. **Reading the clock from the site row** (`homeClock`). The step A document said a call with neither a parameter nor a home thing uses 1800. It now falls back to the site row first (slot length and time zone), because every real home has one and 1800 would be wrong for a 15-minute home. The site row is read in one function; the fold replaces that one query.
4. **Merge, split and replace all fail whole** when the rules refuse something (status 409, nothing changed). An earlier draft of step B reported a refused relation and went on; that could leave a merged thing with a lost edge, so it was removed. What a merge does not write because the survivor has it already is not a refusal and is reported.
5. **`thing_attr_version.valid_from` is still the time of the change.** A back-dated attribute correction has no entry point yet (step A, decision 4).
6. **A relation is never a hard delete.** `unrelate` ends it; cancelling one that had not started supersedes it.
7. **Not done:** an HTTP API (next wave, it needs homes to be things for access control); checking that `std_ref` values exist in Brick (unchanged from step A); coalescing adjacent identical relation rows after a merge (two rows with touching windows are valid and read as one).
8. **The type never changes.** A change of type would have to be versioned and every relation re-checked; a merge into the typed thing does the same job with history kept (a generic device found again as a thermostat). `thing_identity_fixed` refuses it, and the library has no `changeType`. This replaces the earlier draft in which `changeType` existed and the type was not versioned.
9. **Relations are append-only and carry a uid** (`thing_relation_append_only`, `thing_relation_uid_fixed`), so the history that "as known" reads depend on cannot be edited by hand. The log `thing_op` is append-only too and takes its home from its things.
10. **The home thing is required in the database for now** (`thing_home_exists`): nothing is put in a home before its home thing, as it will be once `home_id` is a foreign key to the home thing. Until then it is a trigger, and the fold removes it.
11. **Migrations edited in place.** The step A migration and the step B migration were changed after being committed (prototype rule: no second migration for a table made one step earlier). A development database that applied the earlier text has to be rebuilt; the integrator applies the migrations fresh.
12. **Deferrable foreign keys** (`DEFERRABLE INITIALLY IMMEDIATE` on the keys of the thing tables) so the fold can insert a home thing and its rows in one transaction in any order.

## Review round 1: what was changed and what was not

| Finding | Action |
|---|---|
| `home_id` missing (twice) | Not changed: the work package says to use `site_id` until the fold. The two rules are deferred to the fold, which must add them with D1 cases (decision 1 and fold item 2). |
| merge and split skip log, fact, registry, secret tables | Changed: only `log` and `fact` (append-only, cannot be updated) stay; `registry` and `secret` move. The fold notes say readers of fact and log tables follow `merged_into`. Test: a registry table moves in the merge case. |
| `thingReferences` reads `pg_constraint`, single column only | Kept on `pg_constraint` (it lists every key whatever its owner) and said so; a key of another shape (two columns, or to `thing(uid)`) now throws, so merge and split stop. Test: both shapes. |
| relation `valid_from`, `valid_to` alignment only in the library (three findings) | Changed: the database refuses an off-grid start or end of a relation of a home (trigger `thing_relation_checks`, `thing_off_grid`), with a case for each side and for the 25-hour day. The per-call `slotS` and `timezone` overrides were removed. Relations between shared context things have no grid. |
| cycle check races (two findings) | Changed: the walk takes the home's advisory lock first. Test with two connections; the test fails without the lock. |
| database errors have no status | Changed: the library gives 409 (23P01, 23505, 23503, P0001) or 400 (23514, class 22); `validTo` not after the start is a 400 up front; a NUL in a name is a 400. Test: eight refusals. A duplicate uid is a 409, not an idempotent announce (not built). |
| doc says "six tables" | Fixed. |
| weak assertions | Fixed: the retire refusal uses `refused`, the `changeType` and `Unknown gadget` leftovers are gone, each merge refusal has one message. |
| wall-clock assertions | Fixed: the timing assertion is gone; `known` comes from `recordedNow()` instead of the clock and a sleep. |
| attribute version `valid_from` inconsistent | Changed: the first version also starts at its record time; the thing's own span is `life_from`. Test. |
| replace and scheduled retirement | Changed: a relation that ended only with the old thing's scheduled `valid_to` continues for the new thing up to its own end (or open); the same for merge (survivor's end) and split (new thing's end). Tests for replace and merge; both fail without the change. |
| merge with a null start | Changed: null is the earliest. Test. |
| writes took no home | Changed: every write has a required `siteId` and gives the 404 a read gives. Test: every write function with a foreign home. |
| `nextSlotBoundary` in Havana and Santiago | Changed in the library (`time.js` is untouched): the day end is found by the local date. Test over every minute of the affected hour at 900, 1800 and 3600. |
| `graph` edge filter | Changed to a set. |
| nested transaction does not fail whole | Changed: inside a caller's transaction the operation runs in a savepoint. Test: the caller catches the refusal and keeps its own work. |
| retire with no sanity bound | Changed in part: a date that would cancel every relation of the thing is refused (409). A retirement before `recorded_at` stays possible: back-dating a retirement is legitimate. |

## Review round 2: what was changed and what was not

| Finding | Action |
|---|---|
| `home_id` and the two home rules (minor, open since round 1) | Not changed, same reason as in round 1 (decision 1): the work package says `site_id` until the fold, and a second home column kept in step with it would be thrown away by the fold. This is the integrator's call: if the stand-in and the deferral are accepted, the two triggers with D1 cases are fold item 2; if not, the column has to be asked for explicitly and is a small change to the migration, the library and the rule cases. |
| `test/uid.test.js` copy test fails with `invalid input syntax for type json` (twice: one finding from the review, one from the regression run) | Fixed, and it was a defect of this branch: the seeded `thing_type` rows hold jsonb arrays (`capabilities`, `ports`, `attribute_keys`), node-pg sends a JS array as a Postgres array literal, so `loadTables` in `scripts/lib/databases.js` could not copy any database that holds thing rows. `loadTables` now reads `data_type` per column (it already did, for bytea) and sends an array or object bound for a `json` or `jsonb` column as JSON text. Every caller (`test/helpers.js`, `scripts/make-fixture.js`, `scripts/demo-ui.js`, `scripts/sqlite-to-postgres.js`) goes through that one function. The copy test now also creates a home thing and a device thing and checks that `thing_type` (arrays and objects) and the thing row (uid) arrive in the copy; it fails with the original error without the fix and passes with it. |

## What the fold of `site` and `device` into things must do with these tables

The next wave converts every `site` row to a home thing and every `device` row to a device thing. With the tables as they are:

1. **Home things.** Insert one `thing` of kind `home` per site (type `house` or `flat`), `uid = site.uid` (keep it: it is the identity outside), `valid_from = site.created_at`. Move the home's settings into attributes: `timezone`, `slot_s`, `currency`, `country`, `market_code`, `postcode`, `gsp_region`, `carbon_region`, `contracted_kva`, `is_demo`, and the planner details already in `site_attribute` (`pv_kwp`, `pv_tilt`, `pv_orientation`, `battery_kwh` and the rest of `attribute_def` with `applies_to` site) using the key names of `attribute_def`. Write `site_version` history as `thing_attr_version` rows with the same record times (the trigger writes versions on update; a conversion that wants the history inserts versions directly with the older `recorded_at`, then lets the trigger continue from the newest). The `thing` rows' `attrs` must be the newest version.
2. **`site_id` becomes `home_id`.** Replace `site_id` in `thing`, `thing_attr_version`, `thing_relation` and `thing_op` by `home_id -> thing(id)`. A home thing's `home_id` is its own id (insert, then update, or `home_id` deferrable). `thing_one_home`, `thing_identity_fixed` (kind and home never change), `thing_home_unless_context`, `thing_relation_checks` ("one home or shared context"), `thing_merge_checks`, `thing_op_home` and `homeClock` name `site_id` and must be rewritten with it. The two rules of the acceptance list that the stand-in only approximates must be added then, each as a trigger with a D1 case: "a home thing has `home_id` = its own id" and "every other thing except context has `home_id` pointing at a thing of kind home" (of the same home). `thing_home_exists` and `thing_home_clock` exist only because the home thing and the site row are two things: after the fold they are dropped (the home thing is then the row a `home_id` points at, and holds `slot_s` and `timezone` itself). `thing_uid_v7` stays; a home thing made from a site keeps `site.uid`, which must then be a UUIDv7 (check this before converting). `ON DELETE CASCADE` to `site(id)` becomes cascade from the home thing, and `delete-home.js` must delete by `home_id` (its foreign-key discovery already follows `thing`).
3. **Device things.** One `thing` of kind `device` per device row, `uid = device.uid`, type from `device.kind` (the 18 kinds all have types; `hot_water` has none: that row becomes a system thing of type `hot_water`), attributes from `device_attr_version` / `attribute_value` (keys of `attribute_def`, carried by the type), `valid_from` from the device's first recorded time. Do not give a device a `located_in` it never had: a device without a room is `located_in` the home thing (rule exists: device to home). A device's `thing.type` can never be changed afterwards (`thing_identity_fixed`): a device whose `kind` was wrong in the old data is converted with the right type, or, if it is found later, merged into the right thing.
4. **Repoint every reference** to `device(id)` and `site(id)` (found through the foreign keys: `series`, `channel`, `binding`, `control_limit`, `command`, `device_capability`, grants, groups ...) to `thing(id)`. Tables that point at a thing fall in the kinds the merge and split handle: `thingReferences()` lists them and the merge test shows what each kind does. A merge moves versioned configuration, registry, serving, secret and runtime rows to the survivor (so `series` and `channel` follow), and leaves `fact` and `log` rows on the dropped thing because they are append-only: every reader of a fact or log table with a thing key (points, readings, commands, events) must resolve the key through `merged_into` (`resolveThing`, or the family walk of `thingHistory`) to see one timeline. Foreign keys must be one column to `thing(id)`: another shape makes merge and split throw. Drop `device`, `device_attr_version`, `site_version` and the `site` columns that moved, and remove `device` and `site_version` from `LEGACY_CONFIG` in `table-kinds.js`.
5. **Relations to create from existing data:** `meters` from `device.role` and the channel bindings (meter to home supply, plug to appliance); `feeds` from the inverter topology the build assumes (PV to inverter, inverter to battery and supply, grid to meter), with the ports in `thing_type`; `part_of` into systems; `served_by` from the connection that owns a device; `supplied_on` from `tariff_agreement` (a tariff becomes a `context` thing of type `tariff`). `required` follows the group membership rules (R8). A conversion writes `valid_from` as the agreement's or device's own date and `changed_at` as the recorded time. Insert them with `relate`-style rows through the library (one record time, slot boundaries), not by hand: a relation row cannot be edited afterwards, only superseded.
6. **Context things** (regions, tariffs, markets, weather points) have `site_id` null today and `home_id` null after; nothing else changes.
7. **`slot_s` and `timezone`:** after the fold `homeClock` reads only the home thing's attributes. Change one query. The slot-length runs (`npm run test:slots`) should then be run: slot snapping of relations changes with the grid.
8. **Registry:** `seedThings` writes `thing_type` and `relation_rule` at start-up; the conversion needs those rows before it runs, so the migration that converts must be followed by a start (or call `seedThings` first).
9. **Facts keep their own `site_id`** (R4); nothing in these tables changes that.
10. **Merge and replace after the fold:** `mergeThings` moves `series.subject_id`-style references only if they become foreign keys to `thing(id)` (a column without a foreign key is not found, and silently stays). Make every reference a real foreign key, one column, to `id`. After the fold `begin()`'s lock key and the lock in `trg_thing_relation_checks` (`hashtext('eb_thing_home')`, the site id) must follow the home id together.

## Measured

- Seed: 43 types and 29 rules; nothing written on a second start.
- Round 1 did not repeat the timings below; only the cases were re-run. The edge filter of `graph` now uses a set (it was a scan of all nodes per edge: 2.4 s for 20,501 things in the reviewer's measurement; not re-measured here).
- A synthetic home of 1013 things (4 floors, 48 rooms, 960 plugs) and 1012 relations on the local database, one run, wall clock through the data layer (Prisma round trips included): building it through `createThing` and `relate` took 6.3 s (each call is its own transaction with the home lock and a record-time setting); `tree` of the whole home 8 ms, `graph` 19 ms, `placeChain` 1 ms, `moveThing` 20 moves in 82 ms, `replaceThing` 9 ms, `mergeThings` 15 ms, `splitThing` 7 ms, `reach` 1 ms. Foreign-key discovery for merge and split reads `pg_constraint` on every call (not cached: a test creates tables at run time). The throwaway script that measured this was removed; it is not in the repository.
- A dense `feeds` network of 36 things in 18 layers (2^17 paths) is walked by `reach` in a few milliseconds (the test allows 2 s).
- `test/things.test.js`: 30 cases, about 13 s with the database creation (the test database is built from all migrations). `test/rules-things.test.js`: 17 cases.

## How to run

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/things
TEST_DB_PREFIX=wp_things node --test --disable-warning=ExperimentalWarning test/things.test.js test/rules-things.test.js test/rules-all.test.js
TEST_DB_PREFIX=wp_things node --test --disable-warning=ExperimentalWarning test/table-kinds.test.js test/delete-home.test.js test/erasure.test.js
# after a change to the rule cases: UPDATE_RULES=1 re-records test/rules/things.json
```

Run at the end of review round 2 and passing: `test/uid.test.js`, `test/rules-all.test.js` and `test/table-kinds.test.js` together (9 cases). Run at the end of review round 1 and passing (this checkout, database prefix `wp_things`): `test/things.test.js`, `test/rules-things.test.js` and `test/rules-all.test.js` together (49 cases), `test/table-kinds.test.js`, `test/delete-home.test.js` and `test/erasure.test.js` (12). `prisma/schema.prisma` was refreshed again (`scripts/refresh-prisma.js`). Not run: the whole suite and `npm run db:migrate` on the development database (the integrator does both; the development database needs both new migrations before start-up reads `thing_type`).

## What is left

- The conversion of `site` and `device` into things, repointing every reference, and the HTTP API (next wave; list above).
- A per-home topology check for the energy graph (Phase 2.7) reads this graph; nothing does yet.
- A back-dated attribute correction (valid time earlier than record time) has no entry point.
- The `site` kind of thing for shared things (R20) needs one more value in the kind checks, by migration.
- Values of the `std_ref` column are unchecked (step A, decision 11).
