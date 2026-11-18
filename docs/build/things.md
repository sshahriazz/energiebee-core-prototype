# Work package "things": the thing graph (plan Phase 1.1, 1.2 and 1.8)

Branch `wp/things`, started from `f59ce42`. This file is updated at the end of every step.

| Step | What | State |
|---|---|---|
| A | Schema, registries, triggers, rules tests (1.1, 1.2) | done, described below |
| B | The thing library (`src/core/things.js`: create, rename, retire, move, relate, replace, merge, split) (1.8) | not started |

This package is the additive half of Phase 1. It adds tables, rules and a registry seed. It does not touch `site`, `site_version`, `device`, the build or the adapters, and nothing reads the new tables yet. The fingerprint of home 1 is therefore unchanged (no fixture or golden was touched).

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

`slotS` comes from a parameter of the library function (`{ slotS }`). When it is not given, the library reads the `slot_s` attribute of the home thing (`thing_attr_version` as known now). Until homes are things (Phase 1.3b) there is no home thing for a real home, so a caller that has a `site` row passes `site.slot_s`; a thing library call with neither a parameter nor a home thing with `slot_s` uses 1800. An example: a plug moved at 14:10 on a 30-minute grid has `changed_at` 14:10 and `valid_from` 14:30; the 14:00 slot counts in the old room and 14:30 in the new one (case 21 of the catalogue). The same rule applies to the end of the old placement (`valid_to` of the old row equals `valid_from` of the new one).

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
13. **A relation to a retired thing is not refused**, and a changed `thing.type` is not re-checked against its existing relations. Both are library work (step B).
14. **`thing_relation` is not append-only.** A change is a supersede plus an insert by the library, the pattern of `site_group_member`; nothing enforces it in the database yet.

## Measured

- Seed: 43 types and 29 rules; nothing written on a second start.
- `test/rules-things.test.js`: 13 cases (about 15 seconds on a warm template, most of it creating the test database).

## How to run

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/things
TEST_DB_PREFIX=wp_things node --test --disable-warning=ExperimentalWarning test/rules-things.test.js test/rules-all.test.js test/table-kinds.test.js
# after a change to the cases: UPDATE_RULES=1 re-records test/rules/things.json
```

Run in step A and passing: those three files, plus `test/delete-home.test.js`, `test/home-rows.test.js`, `test/erasure.test.js`, `test/rules-core.test.js`. Not run: the whole suite (the integrator runs it) and `npm run db:migrate` on the development database (the migration has to be applied there before the app starts, because start-up now reads `thing_type`).

## What is left

- Step B: the library (create, rename, retire, move with snapping, relate, replace, merge, split, the tree and the graph reads), tests on synthetic homes (including catalogue cases 1, 2, 18, 21), and a value check of attributes against `attribute_def`.
- The conversion of `site` and `device` into things, repointing every reference, and the HTTP API (next wave).
- A per-home topology check for the energy graph (Phase 2.7) reads this graph; nothing does yet.
- The `site` kind of thing for shared things (R20) needs one more value in the kind checks, by migration.
