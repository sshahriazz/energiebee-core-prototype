# Wave 2: design of the fold (site and device become things), the energy graph, spaces and the thing API

Status: design, written before any code. Branch feat/thing-platform. This file is the implementation brief for Phase 1.3, 1.3b, 1.4, 1.5 and 1.6 of docs/thing-platform-plan.md. An engineer should be able to execute it without asking questions. Where a number is quoted (counts, ids, row counts) it was read from the dev database or the wave-1 branches on 2026-11-18; the scripts named here recompute every one of them and the migrations assert them, so a stale number stops the work instead of passing silently.

Wave 1 (wp/things, wp/tariff, wp/rawstore) is merged before any step here starts. This design never edits a wave-1 migration (Prisma checksums applied migrations, and the fold works from the catalogue, not from a fixed list).

## 1. Decision

### 1.1 In one paragraph

Fold site into a home thing and device into device things in small steps. Every step except the fold migration itself is green. The order is: (P) seams on the old schema (home.js, devices library, test helpers, hash-neutral sentinels, strict loader); (M1) renumber devices above the homes, alone, on the old schema; (M2) rename site_id to home_id everywhere, alone, on the old schema; (F) one atomic fold migration that creates the things, copies the versions, retargets the foreign keys to thing(id), rewrites the functions, triggers and views, and leaves the old tables behind as a tripwired capsule; then triage to green; (Q1) kind guards on every thing reference; (Q2) drop the capsule; (G) the energy graph, spaces and the API. Home things keep the old site ids, so no fact row is ever updated. Device things keep the (already shifted) device ids. All uids survive.

### 1.2 What was adopted from which design

| Topic | Taken from | Why |
|---|---|---|
| Home thing id = site.id, uid = site.uid | all three | Facts (reading 89,243, interval_fact 12,568, forecast_fact 8,666, raw_payload 467 in dev) are append-only and carry the home id. Keeping the id makes the fold DDL only for them. user_site, tenant_site, site_grant, connection_secret AAD and tounify eb-site-<id> stay valid. |
| Device ids: new = old + G, G = max(max(site.id), max(device.id)) | design 1 | One collision-free UPDATE per column, any row checkable by formula, no map table, no two-phase negative rewrite. The judges split between this and "move only colliding ids"; the formula won on auditability and because it makes any code that confuses a home id with a device id fail early. All device ids change; only dev (9 devices) and the fixture (4) exist, and the push contract identifies devices by external_ref. |
| Device renumbering and the column rename as their own green steps on the old schema (M1, M2) | design 2 and design 3, judge 1 | A schema flip must not share a red window with a 700-line rename. |
| Strangler seams first (home.js, devices library, test helpers, hash-neutral sentinels) | design 1 phase A, design 3 S1 | The fold then changes seam bodies, not 150 call sites. |
| Rehearsal on a pg_dump copy, atomicity run (SELECT 1/0), negative runs, determinism double run, in-transaction pre-flight and post-asserts | design 1 | Best proof harness. |
| Normalise verification by uid, not by id | design 3 | The comparison does not depend on the id mapping. |
| series.thing_id real FK, subject_id a generated column | design 1 | merge, split and delete-home discover FKs; a text subject is invisible to them (hazard H5). |
| Kind guards as data (src/db/ref-guards.js) with a completeness test | design 1 | One list feeds the generator, the rules test and the delete-home column check. Delivered after green (Q1), as judge 2 asked. |
| SQL view `home` / `home_version` plus JS getHome / homeAt, with a door test | design 3 | One typed projection that triggers, views and JS share. Allowed for home settings only; never for devices. |
| No v_device view; devices through a library (devicesOf, deviceById, deviceAttrs, upsertDevice) over thing + thing_link | judge 3 | A device view is a shim Phase 2 must delete and keeps 28 JSON.parse sites and a hidden ms/s conversion. |
| thing_link now (provider, external_ref identity) | design 1 / design 3 | Keeps the upsert key; Phase 2.3 adds connection_id and a validity window. Not interim columns on thing (design 2). |
| Old tables kept as a tripwired capsule until a separate contract migration | design 2 | Rollback window and a loud failure for any missed writer. |
| Ledger merge (site_attribute into attribute_value) and capacity move | design 3 moved to G | Keeps the numbers of the fold localisable. |
| Graph seeder as one idempotent function, uid-only API, 404 not 403 | graph and API design | See section 14. |
| Rejected | design 2's shadow phase (4 sync triggers, home_from_thing, fold_parity, parseAttrs, interim thing.provider/external_ref, shared sequence defaults on dying tables); design 3's thing_type.class column; design 3's TEST_SLOT_S "new version through the library"; design 1's v_device and its floored valid_from | See 1.3. |

### 1.3 Judge blockers and how each is resolved

| Blocker | Resolution |
|---|---|
| D1: DROP COLUMN series.subject_id fails while trigger series_home (UPDATE OF subject_kind, subject_id, site_id) exists (pg_depend deptype n, checked on dev) | The fold drops trigger series_home first (F section 1), adds thing_id and region_ref, drops and re-adds subject_id as a generated column, then creates series_ref. |
| D2: two-phase negative rewrite of series.subject_id fires series_home on a lookup that finds no device | There is no negative rewrite. M1 uses the disjoint range. In M1 the device rows are updated first, then series, with USER triggers on series disabled for that statement, and the migration asserts series.home_id is unchanged afterwards. |
| D1: rename and codemod in the red window | M2 is its own green step on the old schema. |
| D3: TEST_SLOT_S via the library can leave as-of builds at the old slot length | In F4 the helper updates thing_attr_version and thing.attrs in place inside one transaction with thing_attr_version_append_only and thing_attr_version_on_update disabled (section 10). No new version is written. |
| D3: ledger merge, class column, typed casts in the fold | Ledger merge and capacity move are step G. No class column: "controllable" is derived from device_action into thing_type.capabilities. Typed casts of the home view are guarded by jsonb_typeof checks in the home trigger and re-checked by verify-fold. |
| D2: shadow sync triggers drift at ms level | No shadow phase. |
| Wave 1 is provisional | All generated lists come from the catalogue of the merged schema and are asserted by list equality, not only by count. F1 and F2 are re-run after the real merge. |
| First application of wave 1 plus the fold happens on dev | pg_dump backup, rehearsal on a copy first, then dev. |
| v_device hides a unit conversion | No v_device. devicesAt uses ceil on both ends (section 5.3) and verify-fold proves equality at integer seconds. |
| R1 cannot be green under the strict loader because the old dump has site_id | Every schema step converts the fixture by running the real migration over the old dump (section 11). |
| A2 and A3 not disjoint (shared files) | Every shared src file has exactly one owner worker (section 13, P5). |
| Floor of recorded_at/1000 for valid_from | ceil, with a proof (5.3). |
| Lock key home_id modulo 2^31 | Full bigint key (section 5.4). |
| Home type is a guess | All converted homes get type house; thing_identity_fixed is relaxed so a home may change between house and flat (user input, not a fact). |

## 2. Fixed decisions (each can be reversed in one place)

| # | Decision |
|---|---|
| D1 | Home thing: id = site.id, uid = site.uid, home_id = id (self reference), kind home, type house, name = site.name, valid_from = site.created_at (seconds), recorded_at = first site_version.recorded_at (ms). |
| D2 | Device thing: id = device.id after M1 (old id + G), uid = device.uid, kind device (hot_water: kind system, type hot_water), type = device.kind, name = device.label. |
| D3 | thing_id_seq is set to max(id) after the inserts. New homes, spaces and devices take their id from it. |
| D4 | Home settings are keys of thing.attrs (jsonb), versioned by thing_attr_version. Read only through src/core/home.js and the SQL views home_version and home. Written only through setHomeSettings. |
| D5 | The five site CHECKs, two FKs and five triggers become two triggers on home things (home_attrs_valid, home_currency_matches_agreements). |
| D6 | Per-source evidence (site_attribute, attribute_value) is not folded into attrs. In the fold attribute_value gets one thing_id column. site_attribute keeps its rows (column home_id, FK to thing). They merge in G. |
| D7 | Device identity (provider, external_ref) lives in thing_link. Writes only through the devices library. |
| D8 | series gets thing_id (FK) and region_ref; subject_id becomes generated. |
| D9 | device_kind is dropped; its labels, keys and action codes are already in thing_type and device_action; "controllable" is derived from device_action into thing_type.capabilities. |
| D10 | Kind guards (home_id must be a home thing, device_id a device or system thing, same home where the row has one) are generated from one list, delivered in Q1. |
| D11 | Table names containing site (site_hh, site_day, site_heat_slot, user_site, tenant_site, site_grant, site_group*, site_setting, site_region, site_attribute, site_day_revision), JS identifiers siteId, URL paths /api/sites and series.subject_kind 'site' are not renamed in this wave. Naming debt, stated in docs/fix-list.md. |
| D12 | The push contract keeps `site` (integer) and `device`; a numeric device id from before M1 is invalid; external_ref keeps working. |
| D13 | Home-wide devices are `located_in` the home thing itself. |
| D14 | New thing API writes allow spaces, systems, placement and part_of membership only. Devices and energy edges come from integrations and the seeder. |

## 3. Id strategy

### 3.1 Homes

thing.id = site.id (1 and 2 in dev, 1 in the fixture), inserted with an explicit id (thing.id is GENERATED BY DEFAULT). thing.home_id = thing.id. The FK is DEFERRABLE INITIALLY IMMEDIATE and in the fold it still points at site(id) while the rows are inserted (the site row exists), then it is retargeted. Consequences, all asserted:

- reading, interval_fact, forecast_fact, raw_payload: no UPDATE. ALTER TABLE RENAME COLUMN and DROP/ADD FOREIGN KEY fire no row trigger. The append-only triggers stay enabled for the whole fold, so an accidental UPDATE aborts the migration. No erasure window is opened and no erasure_log row is left in the empty template (rules-core:208 and delete-home:102 count rows; erasure_log.kind has no migration value and none is added).
- user_site, tenant_site, site_grant, site_group_member, connection (uid too), connection_secret (AES-GCM AAD connection_secret:<id>:<provider>), home_key, tounify eb-site-<id> (connection.external_ref and provider_state) keep their values. A home keeps working for its owner.
- The 30 test files with `const SITE = 1` and the nine `home 1#0 ...` keys of test/fixtures/price-slots-ref.json stay valid.

### 3.2 Devices (M1)

G = GREATEST(max(site.id), max(device.id), 0). Every device id becomes old + G. Dev: G = 9, devices 1..9 become 10..18. Fixture: G = 4, devices 1..4 become 5..8. The new range is above every old home id and every old device id, so each UPDATE is collision free even on primary keys that contain device_id (plan_run_device, device_capability, plan_slot). The mapping is a formula; verify-fold checks any row as new - old = G. The number differs per database; no test may depend on a device number (verified: tests find devices by kind or provider; the only literals are `/api/sites/999/devices/1` expecting 404, `deviceId: 1, 2` in onboarding-view and `device_id: 7` in tariff-expand, all pure).

Columns rewritten in M1 (15 foreign keys to device(id), the generator lists them and the migration asserts list equality): device_attr_version, device_capability, attribute_value, channel, binding, command, command_block, control_limit, tariff_agreement, register_window, push_log, plan_run_device, plan_slot, plan_score, supply_price_slot. Text copies rewritten in the same migration: series.subject_id where subject_kind = 'device' (33 rows in dev, 3 in the fixture) and supply_price_slot.point 'device:<id>' (0 rows in dev). Not rewritten, asserted: site_hh.lineage / site_heat_slot.lineage sub_meters[].device (pre-flight raises if any row contains 'sub_meters'; home 1 has none), command.idempotency_key (hash with the device id; pre-flight raises if any command is pending or sent; keys of closed commands go stale, which is harmless), plan_input_ref.ref_table (asserted not to name site or device).

device_id_seq is set to max(device.id) so devices created between M1 and the fold stay above G. The fold pre-flight asserts max(site.id) < min(device.id); a home created in that window that reaches the device range stops the fold with a message (create no homes between M1 and the fold on any shared database; test databases are rebuilt from the template anyway).

### 3.3 Sequence, uids, locks

- thing_id_seq: setval(pg_get_serial_sequence('thing','id'), max over thing) after the inserts. site_id_seq and device_id_seq die with their tables in Q2.
- uids are copied verbatim (site.uid, device.uid; connection keeps its table and uid). thing_uid_v7 and thing_uid_fixed apply from the insert. The pre-flight lists every non-v7 uid and aborts before touching anything (dev: all 20 uids are v7; the fixture's too). A uid is an external identity and is never rewritten. thing_link has no uid.
- things.js begin(): advisory lock key becomes pg_advisory_xact_lock(hashtextextended('eb_thing_home:' || home_id::text, 0)), a full bigint key. The old two-int form (home id cast to int) is replaced because homes and devices now share one id space.

## 4. Home settings model

### 4.1 Where each site column goes

| site column | Becomes |
|---|---|
| id, uid | thing.id, thing.uid |
| name | thing.name (and the name of every thing_attr_version row) |
| created_at (seconds) | thing.valid_from |
| (none) | type = house (flat chosen by the owner later) |
| timezone, slot_s, currency, country, market_code, postcode, outcode, gsp_region, carbon_region, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo, pv_kwp, pv_tilt, pv_orientation, battery_kwh, env_key | same key in thing.attrs. Numbers stay numbers (slot_s, carbon_region, is_demo 0/1). A NULL column is an absent key. |
| lat, lon | latitude, longitude (the attribute_def keys that already exist) |

New keys added to the house and flat attribute_keys in src/db/seed/things.js: outcode, env_key, contracted_kva_origin, contracted_kva_note. env_key gets a partial unique expression index: CREATE UNIQUE INDEX thing_home_env_key ON thing ((attrs->>'env_key')) WHERE kind = 'home' AND superseded_at IS NULL AND attrs ? 'env_key'; its message goes into the unique-message map in db.js. pv_kwp, pv_tilt, pv_orientation, battery_kwh stay on the home thing in this step (the build and attributeAt still read them) and move to the PV array and battery things in G.

attribute_def.site_column (6 values) is dropped. attrs keys equal attribute_def keys. A bigint column cached_on_home (0/1) replaces it: UPDATE attribute_def SET cached_on_home = 1 WHERE site_column IS NOT NULL, then DROP COLUMN site_column and the constraint attribute_def_site_column_check. attribute_def.applies_to 'site' becomes 'home' in the seed (53 rows, edited with a regex scoped to appliesTo arrays only; the other 'site' literals, about 25 lines, are series subjects, the plans.js map and the pseudo-device id, and are not touched). The `includes('site')` in the thing_type seed follows.

### 4.2 Versioning

The fold replays site_version one to one into thing_attr_version. For every site_version row, in recorded_at order, one thing_attr_version row: attrs = the 17 versioned columns of that row plus name, postcode, outcode, env_key taken from the current site row (these four were never versioned; every historic version carries today's value, which is exactly what siteAt returned before), valid_from = recorded_at / 1000 (what the wave-1 trigger itself does), recorded_at and superseded_at copied unchanged. Rows are inserted already superseded (the last one current), with thing_attrs_allowed and thing_attr_version_on_insert disabled for the statement block, so no UPDATE ever hits the append-only trigger. The pre-flight asserts that each site row equals its current site_version row on all 17 columns (IS NOT DISTINCT FROM); verified on dev for both homes. Units: created_at is seconds, recorded_at is ms, thing.valid_from is seconds.

After the fold every settings change is a new version through the wave-1 trigger. Unlike site_version (17 columns), name, postcode and outcode changes now version too; harmless, because homeAt overlays only what the version holds.

### 4.3 The read model (one projection, two doors)

SQL, created in the fold:

```sql
CREATE VIEW home_version AS
SELECT v.thing_id AS id, t.uid, v.name, t.type AS home_type, t.valid_from AS created_at,
       v.recorded_at, v.superseded_at,
       v.attrs->>'timezone' AS timezone,
       (v.attrs->>'slot_s')::bigint AS slot_s,
       v.attrs->>'currency' AS currency,
       v.attrs->>'country' AS country,
       v.attrs->>'market_code' AS market_code,
       v.attrs->>'postcode' AS postcode,
       v.attrs->>'outcode' AS outcode,
       v.attrs->>'gsp_region' AS gsp_region,
       (v.attrs->>'carbon_region')::bigint AS carbon_region,
       (v.attrs->>'latitude')::double precision AS latitude,
       (v.attrs->>'longitude')::double precision AS longitude,
       (v.attrs->>'contracted_kva')::double precision AS contracted_kva,
       v.attrs->>'contracted_kva_origin' AS contracted_kva_origin,
       v.attrs->>'contracted_kva_note' AS contracted_kva_note,
       (v.attrs->>'is_demo')::bigint AS is_demo,
       v.attrs->>'env_key' AS env_key,
       (v.attrs->>'pv_kwp')::double precision AS pv_kwp,
       (v.attrs->>'pv_tilt')::double precision AS pv_tilt,
       (v.attrs->>'pv_orientation')::double precision AS pv_orientation,
       (v.attrs->>'battery_kwh')::double precision AS battery_kwh,
       v.attrs AS attrs
FROM thing_attr_version v JOIN thing t ON t.id = v.thing_id AND t.kind = 'home';
CREATE VIEW home AS SELECT * FROM home_version WHERE superseded_at IS NULL;
```

Check the exact SQL types of the old site columns (carbon_region, pv_*, contracted_kva) with \d site and use the same types; the drift test compares the view's column names and types with HOME_COLUMNS in the seed. The typed extraction exists in this one place. The view is the SQL twin of getHome for the places that cannot call JS (triggers, the plan views, price-queue country scope, delete-home, list reads). It is an end-state read model, not a legacy name: it has no old names (latitude, longitude, home_type), and it is removed from the typed list piece by piece as settings move to points (Phase 3). pv_kwp, pv_tilt, pv_orientation and battery_kwh are the transitional columns; G changes their definition to sums over PV array and battery things in this one place.

JS, src/core/home.js (created in P4 on the old tables with the final signatures; bodies swapped in F4):

| Function | Contract |
|---|---|
| getHome(db, homeId) | the settings record or null (the old site-row shape with latitude/longitude, plus uid, home_type). |
| getHomeByUid(db, uid) | same, by uid. |
| listHomes(db, { demo, country, market, envKey }) | homes are few; filters may run in JS. Add an expression index only when measured. |
| homeByEnvKey(db, key), homeExists(db, id) | |
| homeAt(db, homeId, atMs) | replaces versions.js siteAt. Version with recorded_at <= atMs < COALESCE(superseded_at, infinity); before the first version, the first one with approximateSettings = its recorded_at; returns settingsRecordedAt and approximateSettings exactly as siteAt does. The "no version at all" flag (Date.now()) becomes unreachable because every home has at least one version (asserted). planner-read's silent try/catch fallback is deleted. |
| setHomeSettings(db, homeId, patch, { at, reason }) | validates keys and types against HOME_SETTINGS, then one UPDATE thing SET attrs = attrs || patch through the things library (per-home lock, the library's record time). A null value removes the key. Home settings are versioned by record time only, as site_version was; they are not slot-snapped. |
| createHome(db, spec) | one transaction, one INSERT INTO thing (kind home, type house) with the DEFAULT_HOME merge. Defaults (timezone 'Europe/London', slot_s 1800, is_demo 0) live in DEFAULT_HOME in home.js only and are applied at write time; reads never apply defaults; the DB trigger refuses a home without them. createSite is renamed createHome. |

The JS identifier `site` for a home record is left alone. The record keeps the column names the build reads (id, uid, name, timezone, slot_s, currency, country, market_code, postcode, outcode, gsp_region, carbon_region, latitude, longitude, pv_kwp, pv_tilt, pv_orientation, battery_kwh, contracted_kva, contracted_kva_origin, contracted_kva_note, is_demo, env_key, created_at). lat/lon property reads (about 25 lines in quartz, openmeteo, geo, derive, carbon, steps, sunsynk and public pages) are renamed by hand in P5 on the old schema, where home.js aliases site.lat as latitude.

Door test, test/home-door.test.js: greps src, scripts and public; fails when anything outside src/core/home.js, src/core/things.js, the migrations and the seed reads thing_attr_version of a home, reads attrs->> or attrs-> for a home setting, or filters thing on kind = 'home' for settings.

Writers that move to setHomeSettings (all done in P5 on the old schema): sites.js setSlotLength and setContractedCapacity (then markDirty as today), attributes.js resolve() `UPDATE site SET ${attr}` and writeValue `UPDATE site SET ${def.site_column}` (gated on cached_on_home after the fold), adapters/geo.js (postcode, then latitude, longitude, outcode, gsp_region, carbon_region as one patch), octopus:210 postcode, sunsynk:188 timezone/lat/lon (read first, patch only the missing ones, same semantics as COALESCE), jobs/sync:56 name/postcode, make-fixture. DELETE FROM site becomes DELETE FROM thing WHERE id = ? AND kind = 'home' (ON DELETE CASCADE on thing.home_id and every home_id FK keeps the cascade the signup, users and providers tests use).

### 4.4 Database rules that replace site's constraints (D1 rule: a rule is a trigger plus a case)

Trigger home_attrs_valid, BEFORE INSERT OR UPDATE OF attrs ON thing WHEN (NEW.kind = 'home'): timezone present and a known zone; slot_s present and in (900, 1800, 3600); country matches ^[A-Z]{2}$; currency exists in currency and market_code exists in market; country equals the market's country and currency equals the market's currency (the four old *_matches_market triggers); contracted_kva > 0; contracted_kva_origin in the old vocabulary; is_demo in (0, 1); jsonb_typeof checks for every numeric key so the view casts cannot fail. It raises with ERRCODE check_violation and a CONSTRAINT name, so db.js translateError keeps producing /CHECK/ messages and tests asserting that text keep working (integrity:161-167, plan-tables:169, provenance:124, multi-market:99; the quoted constraint names change and the tests are edited and listed in the commit message). Weakness, stated: the currency and market checks are existence checks, not referential integrity (registries never lose rows).

Trigger home_currency_matches_agreements, BEFORE UPDATE OF attrs ON thing WHEN (NEW.kind = 'home'): when currency or market_code changes, every tariff_agreement of the home (home_id = NEW.id) must keep a tariff of that currency (the old site_currency_implied_matches_agreements).

Trigger thing_default_bindings, AFTER INSERT ON thing WHEN (NEW.kind = 'home'): copies binding_default into binding with recorded_at 0, reason 'default for a new home' (the old trg_site_default_bindings). Created last in the fold, after the data is converted, so it does not insert defaults for homes that already have them. src/db/seed/bindings.js: read it; delete its copy of the logic if it only repeats the trigger; if it back-fills homes created before a default existed, keep it and read homes through listHomes.

thing_home_exists and thing_home_clock (wave 1) are dropped: the home is the row the FK points at. homeClock(homeId) in things.js reads getHome (slot_s, timezone).

## 5. Device model

### 5.1 Thing, link and attrs

- thing: kind device (system for hot_water), type = old kind (17 device types plus generic_device; the registry rows exist in the wave-1 seed), name = label (btrim, fallback kind || ' ' || id), attrs = device.attrs parsed as jsonb, valid_from = ceil(recorded_at / 1000.0) (NULL when recorded_at is NULL: devicesAt treats NULL as always existed), valid_to = ceil(retired_at / 1000.0) (NULL when not retired; a NOTICE when rounding), recorded_at = LEAST of device.recorded_at and the first device_attr_version.recorded_at (0 when both are NULL). Pre-flight raises when valid_to <= valid_from after rounding (thing_valid_window); no retired device exists in dev or the fixture.
- Attribute keys stay as they are (serials, annualKwh, profileClass, ldz, exitZone, gasUnit, status, synthetic, emulated, battery_kwh; camelCase kept on purpose so converted attrs equal the old ones byte for byte; renaming is a Phase 2 attribute-as-point decision). Step P3 adds them to the device types in src/db/seed/things.js; the keys are found by a read-only query on dev and the fixture and by grepping every writer of device attrs (setDeviceAttrs, addDevice attrs:, octopus, tounify, steps, synthetic-iot, push-ingest, sunsynk).
- thing_attr_version for devices: one row per device_attr_version row (attrs text to jsonb, recorded_at and superseded_at copied, valid_from = recorded_at / 1000, name = the current label: labels were never versioned); a device without versions gets one row from the device itself.

### 5.2 thing_link

```sql
CREATE TABLE thing_link (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  thing_id bigint NOT NULL REFERENCES thing(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  home_id bigint NOT NULL REFERENCES thing(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  provider text NOT NULL,
  external_ref text NOT NULL,
  recorded_at bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
  superseded_at bigint,
  CONSTRAINT thing_link_record_window CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);
CREATE UNIQUE INDEX thing_link_current ON thing_link (home_id, provider, external_ref) WHERE superseded_at IS NULL;
CREATE INDEX thing_link_thing ON thing_link (thing_id);
```

Trigger thing_link_checks (BEFORE INSERT OR UPDATE): the thing is kind device or system and its home_id equals the row's home_id. Table kind in table-kinds.js: config (versioned: id, recorded_at, superseded_at), so a merge supersedes and re-inserts the link for the survivor and a unique clash is a 409 like any other. One row per converted device (provider, external_ref copied). Phase 2.3 adds connection_id and a validity window. The four ON CONFLICT (site_id, provider, external_ref) upserts (octopus:161 and :363, tariff-picker:319, steps:164) become one library function.

### 5.3 The devices library (src/core/devices.js, created in P4, bodies swapped in F4)

deviceById(db, id), devicesOf(db, homeId, { kinds, atMs, includeRetired, providersIn, providersNotIn }) (ORDER BY id on purpose; build.js:257-292 keeps the last meter of a kind unless an earlier one had readings, so the order must be explicit; home 1 has one meter per kind so no number moves), deviceAttrs(row) (always an object), upsertDevice(db, homeId, { provider, external_ref, kind, label, attrs }), addDevice, setDeviceAttrs, retireDevice, unretireDevice (tounify:694), findDeviceByRef (push-ingest findDevice, replay.js:164), startDevice (devices.js:104 rewrites recorded_at to the first ok time; after the fold it sets thing.valid_from under the home lock), and the fragment `deviceSubjectsSql` for the nine `CAST(id AS TEXT) FROM device WHERE site_id = ?` subqueries (build:783, explorer:135, heat:67, health:59, onboarding:127, signup:204, sync:124, trust:174 and :177) and the three `CAST(d.id AS TEXT)` joins (server:607, planner-read:175, steps:191, by hand): one place that says how a home's device series subjects are selected.

The library hides retired_at: it returns retired_at in ms (valid_to * 1000) so callers do not change. As-of rule, proven in verify-fold: old devicesAt active iff recorded_at IS NULL OR recorded_at <= at*1000, and retired_at IS NULL OR retired_at > at*1000. New: valid_from IS NULL OR valid_from <= at, and valid_to IS NULL OR valid_to > at, with ceil on both. For integer at: ceil(x) <= at iff x <= at, and ceil(y) > at iff y > at. All devicesAt callers pass whole seconds times 1000; verify-fold samples every integer second around every recorded_at and retired_at. Floor is wrong (a device recorded at 1.5 s would count as live at 1 s).

Provider filters (provider NOT IN ('env','picker','tounify') at build.js:257, trust.js:20, explorer.js:878, tariff-picker; provider = 'octopus' etc.) go through devicesOf and join thing_link.

### 5.4 Home and device clocks

homeClock(homeId) = getHome(...) slot_s and timezone. thingReferences() in things.js skips columns named home_id and the own tables (otherwise every merge scans about 40 extra FK columns, hazard H7) but includes series.thing_id and thing_link.thing_id.

## 6. Series

P4 and P5 keep seriesId('site' | 'device' | 'region', ...) and the 49 `subject_kind =` filters unchanged. The fold gives series a real FK:

- thing_id bigint REFERENCES thing(id) (deferrable, NO ACTION like series.home_id; NULL only for region subjects), region_ref text (the old subject_id of region series: 'carbon:3', 'ldz:NW').
- subject_id text GENERATED ALWAYS AS (COALESCE(thing_id::text, region_ref)) STORED, then the same unique key (subject_kind, subject_id, metric_id, source_id) under its original name and CHECKs: (subject_kind = 'region') = (thing_id IS NULL) and (region_ref IS NULL) = (subject_kind <> 'region').
- Backfill: 'site': thing_id = subject_id::bigint (same number); 'device': thing_id = subject_id::bigint (already shifted by M1); 'region': region_ref = subject_id. Dev: 62, 33, 3. Fixture: 34, 3, 2.
- Trigger series_ref replaces series_home: BEFORE INSERT OR UPDATE OF subject_kind, thing_id, home_id: thing exists, kind matches (home thing for 'site', device or system for 'device'), sets series.home_id from the thing; 'region' leaves home_id NULL. It must not read NEW.subject_id (generated columns are computed after BEFORE triggers).
- seriesId() in facts.js is the single insert path and changes (INSERT (subject_kind, thing_id, region_ref, ...)); the cache key is unchanged. loadTables skips GENERATED ALWAYS columns (P1). Moving the column to the end of the table changes `SELECT * FROM series` column order; grep for it (none of the fingerprints read series).
- series stays classified registry in table-kinds: a merge keeps facts' series on the dropped thing (a unique clash on the series key is otherwise unavoidable with append-only facts); reads across a merge follow merged_into. Decision taken for Q5.
- series subject_kind 'site' is renamed 'home' later if wanted (D11).

## 7. Migrations, in order, at DDL level

File names sort after 20261118120000_raw_check (merged order: tariff 100000/100100, things 110000/110001, rawstore 120000). Each file is one script and therefore one implicit transaction (the test helper sends it as one query; prisma migrate deploy likewise). No CREATE INDEX CONCURRENTLY, no ALTER TYPE ADD VALUE. Repetitive parts are generated by scripts/fold-gen.js, which introspects a database with every wave-1 migration applied (pg_constraint, pg_index, pg_trigger, pg_proc, pg_attribute) and prints explicit SQL that is committed and reviewed as static text (never a runtime DO block that rewrites by catalogue). Review the generator and the introspection output printed in the commit message, not 700 lines line by line; the migrations assert list equality against the live catalogue so a table that wave 1 adds or drops fails loudly.

| Migration | Content | Status of suite |
|---|---|---|
| 20261119000000_device_ids_above_homes (M1) | device ids += G | green |
| 20261119010000_home_id (M2) | site_id to home_id everywhere | green |
| 20261119020000_fold_site_device (F) | things, FK retarget, rewrites, capsule | red until F8 |
| 20261119030000_ref_guards (Q1) | kind guards | green |
| 20261119040000_fold_contract (Q2) | drop the capsule | green |
| 20261119050000_energy_attributes (G) | site_attribute into attribute_value | green |

### 7.1 M1: device ids above homes (old schema, data only)

```sql
-- header: a pure identifier remap by the DDL owner inside one transaction. It disables USER triggers
-- on the child tables for the UPDATEs (plan_slot_append_only has no erasure exception, command_desired_fixed
-- forbids a changed device_id, command_log is append-only). Nothing else may rely on this.
CREATE TEMP TABLE fold_k ON COMMIT DROP AS
  SELECT GREATEST((SELECT COALESCE(max(id),0) FROM site), (SELECT COALESCE(max(id),0) FROM device)) AS g;
-- pre-flight (each RAISE names the offending rows)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM command WHERE status IN ('pending','sent')) THEN RAISE EXCEPTION '...'; END IF;
  IF EXISTS (SELECT 1 FROM site_hh WHERE lineage::text LIKE '%sub_meters%')
     OR EXISTS (SELECT 1 FROM site_heat_slot WHERE lineage::text LIKE '%sub_meters%') THEN RAISE EXCEPTION '...'; END IF;
  IF EXISTS (SELECT 1 FROM plan_input_ref WHERE ref_table IN ('site','device')) THEN RAISE EXCEPTION '...'; END IF;
  -- the set of (table, column) with a FK to device(id) equals the 15 listed in 3.2, else RAISE with the difference
END $$;
-- temp copy of the evidence (counts per device table, series.home_id of device series) for the post-asserts
ALTER TABLE <the 15 tables>, series DISABLE TRIGGER USER;            -- generated list
SET CONSTRAINTS ALL DEFERRED;
UPDATE device SET id = id + (SELECT g FROM fold_k);                  -- device first: series trigger and FKs find the new rows
UPDATE <t> SET device_id = device_id + (SELECT g FROM fold_k) WHERE device_id IS NOT NULL;   -- 15 statements, generated
UPDATE series SET subject_id = ((subject_id::bigint) + (SELECT g FROM fold_k))::text WHERE subject_kind = 'device';
UPDATE supply_price_slot SET point = 'device:' || device_id WHERE device_id IS NOT NULL;
ALTER TABLE <the same list> ENABLE TRIGGER USER;                     -- same transaction: a failure rolls the DISABLE back too
SELECT setval('device_id_seq', (SELECT max(id) FROM device)) WHERE EXISTS (SELECT 1 FROM device);
-- post-asserts: row counts per table equal the pre-counts; every moved row satisfies new = old + g
-- (compared through a temp table of (table, pk, old device_id) captured before); series.home_id of every device
-- series equals device.home_id (old name site_id); no row of reading, interval_fact, forecast_fact, raw_payload touched.
```

On an empty database G = 0 and nothing changes. Not rewritten and asserted: see 3.2.

### 7.2 M2: site_id to home_id (old schema, no data)

Generated static SQL, in this order:

1. DO block (or generated statements) over information_schema: every column named site_id in schema public, 44 tables after wave 1 (35 on main plus 9; channel_reject, raw_payload and erasure_log have no FK) is renamed home_id, asserted equal to an explicit expected list. erasure_log.site_uid becomes home_uid. RENAME COLUMN keeps primary keys, unique and exclusion constraints (rate_no_overlap COALESCE(site_id,0), price_run_no_overlap, member_no_overlap, agreement_no_overlap), partial indexes, CHECKs (erasure_log_check, thing_home_unless_context) and trigger column lists, because Postgres tracks them by attnum; column position is unchanged, so SELECT * fingerprints keep their key order. Every old table (site_version, device, device_attr_version, site_attribute) is renamed too, so the fold reads their home_id.
2. Rename every constraint and index whose name contains site_id (about 60) to home_id (rule site_id to home_id, explicit ALTER ... RENAME statements, generated). Names containing only site (site_hh_pkey, site_version_current) stay. Tests that quote constraint names (forecast-bitemporal, translateError messages 'FOREIGN KEY constraint failed: <name>') are edited by the same codemod.
3. plpgsql bodies are not rewritten by RENAME COLUMN. Every function whose prosrc matches \msite_id\M (about 24: trg_fact_home x3 uses, trg_series_home, trg_command_checks, trg_plan_run_*, trg_agreement_*, trg_tariff_currency_implied_matches_agreements, trg_site_*, thing_identity_fixed, thing_merge_checks, thing_relation_checks, thing_op_home) is re-created with CREATE OR REPLACE FUNCTION, text generated at authoring time from pg_get_functiondef with site_id replaced by home_id (still reading tables site and device). Message texts that contained site_id change; tests asserting them are edited in the same commit.
4. Drop and re-create the four views (v_current_plan, v_plan_in_force, v_plan_vs_actual, v_plan_window) with home_id output columns (still joining site and device); output column names do not follow a rename.
5. UPDATE column_class SET column_name = 'home_id' WHERE table_name = 'site_hh' AND column_name = 'site_id' (registry row; groups-classes test).
6. Post-assert: no column named site_id in public; no pg_proc.prosrc matches \msite_id\M; no pg_views definition matches it; FK count to site(id) is 41 and to device(id) is 15.

Foreign keys still point at site(id) and device(id); the column is already named for its destination.

### 7.3 F: the fold (one atomic file; the suite is red from its commit until F8)

Order inside the file. Column names are the post-M2 names (home_id) on the old tables.

**Section 0, pre-flight** (one DO block; each assert names the offending rows) and TEMP evidence tables (ON COMMIT DROP): fold_before(table_name, n) with count(*) of every base table; the uid sets of site, device, connection.
- thing, thing_attr_version, thing_relation, thing_op are empty (wave 1 writes nothing in real databases; if not, abort: the id plan assumes empty).
- every site.uid and device.uid has version 7.
- every site has at least one site_version; every site row equals its current site_version on the 17 columns; at most one current site_version per home.
- every device.attrs parses as jsonb and equals its latest device_attr_version attrs where versions exist.
- every device.kind is in the frozen type list of section 2 (7.3, frozen registry rows).
- env_key unique; slot_s in (900, 1800, 3600); the home_attrs_valid rules hold over the data (run the same logic as a DO block over site).
- max(site.id) < min(device.id).
- ceil(retired_at/1000.0) > ceil(recorded_at/1000.0) for retired devices.
- the set of FKs to site(id) and to device(id) equals the generated expected lists (41 and 15).

**Section 1, drop what blocks.** DROP VIEW v_current_plan, v_plan_in_force, v_plan_vs_actual, v_plan_window. DROP TRIGGER series_home ON series (before the series restructure; judge blocker D1). DROP TRIGGER thing_home_exists, thing_home_clock (+ functions). ALTER TABLE thing DISABLE TRIGGER thing_attrs_allowed, thing_attr_version_on_insert for the conversion (re-enabled in section 15).

**Section 2, frozen registry rows.** INSERT INTO thing_type (type, kind, label, attribute_keys) ... ON CONFLICT (type) DO NOTHING for exactly the types the conversion uses: house, flat (home), the 17 device types and generic_device (device), hot_water (system); attribute_keys '[]'. seedThings at start-up upserts the real lists; the migration converts with the allowed-keys trigger disabled; the seed code owns the registries, the migration owns only the rows it must reference (thing_type_fk). No registry is read from code inside SQL.

**Section 3, homes.**
```sql
CREATE FUNCTION pg_temp.fold_home_attrs(s site, v site_version) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'timezone', v.timezone, 'slot_s', v.slot_s, 'currency', v.currency, 'market_code', v.market_code,
    'country', v.country, 'gsp_region', v.gsp_region, 'carbon_region', v.carbon_region,
    'latitude', v.lat, 'longitude', v.lon, 'pv_kwp', v.pv_kwp, 'pv_tilt', v.pv_tilt,
    'pv_orientation', v.pv_orientation, 'battery_kwh', v.battery_kwh, 'contracted_kva', v.contracted_kva,
    'contracted_kva_origin', v.contracted_kva_origin, 'contracted_kva_note', v.contracted_kva_note,
    'is_demo', v.is_demo, 'postcode', s.postcode, 'outcode', s.outcode, 'env_key', s.env_key)) $$;
INSERT INTO thing (id, uid, home_id, kind, type, name, attrs, valid_from, recorded_at)
SELECT s.id, s.uid, s.id, 'home', 'house', COALESCE(NULLIF(btrim(s.name), ''), 'Home ' || s.id),
       pg_temp.fold_home_attrs(s, cur), s.created_at,
       (SELECT min(v.recorded_at) FROM site_version v WHERE v.home_id = s.id)
FROM site s JOIN site_version cur ON cur.home_id = s.id AND cur.superseded_at IS NULL;
INSERT INTO thing_attr_version (thing_id, home_id, name, attrs, valid_from, recorded_at, superseded_at)
SELECT v.home_id, v.home_id, t.name, pg_temp.fold_home_attrs(s, v), v.recorded_at / 1000, v.recorded_at, v.superseded_at
FROM site_version v JOIN site s ON s.id = v.home_id JOIN thing t ON t.id = s.id ORDER BY v.home_id, v.recorded_at;
```
Assert: per home, count(thing_attr_version) = count(site_version); recorded_at and superseded_at equal pairwise; the current version's attrs equal thing.attrs.

**Section 4, devices.** INSERT INTO thing for every device (id = device.id, uid, home_id, kind/type, name, attrs::jsonb, valid_from and valid_to by ceil as in 5.1, recorded_at as in 5.1); INSERT INTO thing_attr_version from device_attr_version (5.1) and one row for each device without versions; INSERT INTO thing_link (thing_id, home_id, provider, external_ref, recorded_at) after section 11 creates the table. Assert thing.attrs equals the current version for every device.

**Section 5, sequence.** SELECT setval(pg_get_serial_sequence('thing','id'), max(id)) FROM thing.

**Section 6, retarget the foreign keys (generated).** For every FK with confrelid = site(id) except those on the old tables (site_version, device) and attribute_value (section 8): DROP CONSTRAINT <fk>; ADD CONSTRAINT <table>_home_id_fkey FOREIGN KEY (home_id) REFERENCES thing(id) ON DELETE <same action> DEFERRABLE INITIALLY IMMEDIATE (38 on the schema as read: 22 CASCADE and 10 NO ACTION on main plus 9 from wave 1, minus the three excluded). This covers thing, thing_attr_version, thing_relation, thing_op (thing.home_id becomes the self-reference), tariff_price_run, supply_price_slot, price_dirty, raw_check_run and raw_payload_check (which become deferrable, restoring SET CONSTRAINTS ALL DEFERRED in delete-home). Same for FKs to device(id) except device_attr_version and attribute_value: <table>_device_id_fkey, same ON DELETE action (7 NO ACTION, 5 CASCADE plus supply_price_slot CASCADE = 13). The migration asserts list equality with the generator's list. Columns named home_id with no FK (channel_reject, raw_payload, erasure_log) stay without; they are listed in an allow-list that test/home-id-columns.test.js asserts (every column named home_id has an FK to thing(id) or is in the 3-name list and in delete-home's seeds), so a rename can never orphan rows silently (hazard 6).

**Section 7, series** (see section 6 of this design). Order: ADD thing_id, region_ref; backfill; DROP COLUMN subject_id; ADD generated subject_id; re-add unique key under its original name; ADD CHECKs; ADD FOREIGN KEY series_thing_id_fkey; CREATE INDEX series_thing; CREATE trigger series_ref (function trg_series_ref, drop trg_series_home).

**Section 8, attribute_value.** ADD thing_id bigint; UPDATE SET thing_id = COALESCE(home_id, device_id); SET NOT NULL; DROP COLUMN home_id, device_id (drops attribute_value_check, the COALESCE unique index and the two indexes); ADD FOREIGN KEY (thing_id) REFERENCES thing(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE; CREATE UNIQUE INDEX attribute_value_current ON attribute_value (thing_id, key, source) WHERE <the old current predicate>; CREATE INDEX attribute_value_thing.

**Section 9, thing_link** as 5.2, then the INSERT of section 4.

**Section 10, attribute_def.** ADD cached_on_home bigint NOT NULL DEFAULT 0 CHECK (cached_on_home IN (0,1)); UPDATE SET cached_on_home = 1 WHERE site_column IS NOT NULL; DROP COLUMN site_column (and attribute_def_site_column_check). attribute_def_check2 (storage vocabulary) is unchanged until G.

**Section 11, functions and triggers re-created** (CREATE OR REPLACE; hand-written bodies, each listed with its rules case; plpgsql bodies are not rewritten by anything else):

| Function / trigger | Change |
|---|---|
| trg_series_ref (series_ref) | new, replaces trg_series_home |
| agreement_device_same_site_insert / _update (keep names and the check) | `SELECT home_id FROM thing WHERE id = NEW.device_id` |
| agreement_currency_implied_insert / _update, tariff_currency_implied_matches_agreements | read the home currency and market from `home` |
| trg_command_checks | device_capability by device_id; plan_run home against the device thing's home |
| trg_device_capability_known_action (+ _update) | `JOIN thing t ON t.id = NEW.device_id JOIN device_action a ON a.device_kind = t.type` |
| trg_plan_run_device_same_site (rename to plan_run_device_same_home) | thing home against plan_run home |
| trg_plan_slot_checks | `thing t JOIN device_action a ON a.device_kind = t.type` |
| trg_thing_identity_fixed | kind and home_id never change; type may change house <-> flat on a home only |
| trg_thing_merge_checks, trg_thing_relation_checks, trg_thing_op_home | read the home clock and home_id from thing and `home`; exact edits found by the sweep |
| unchanged after M2 | trg_fact_home (reads series only), trg_command_desired_fixed, trg_control_limit_ranked, plan_run_append_only / plan_run_unchanged (home_id in the 30-column list), register_window_no_overlap_* (COALESCE(device_id,0)), thing_uid_fixed |
| new | home_attrs_valid, home_currency_matches_agreements, thing_default_bindings, thing_link_checks |
| dropped | site_version_on_insert / _update, site_default_bindings, site_country_matches_market_insert / _update, site_currency_matches_market_insert / _update, site_currency_implied_matches_agreements, site_uid_fixed, device_uid_fixed, device_kind_known_insert / _update (thing_type_fk (type, kind) replaces them, without the old "only when the registry has rows" tolerance), thing_home_exists, thing_home_clock, series_home |

The generator finds every other function that still names site, device or device_kind (the sweep in section 15 lists them); each is rewritten against thing, home or thing_type. Expected change of test/rules/core.json: minus about 13 triggers, plus about 5; things.json minus two; plus the temporary capsule file test/rules/fold-capsule.json (section 13 of this design, deleted in Q2).

**Section 12, views.** CREATE VIEW home_version and home (4.3). Re-create v_current_plan, v_plan_in_force, v_plan_window (JOIN thing t ON t.id = ps.device_id JOIN device_action a ON a.device_kind = t.type AND a.action = ps.action WHERE a.is_default = 0) and v_plan_vs_actual (battery capacity from JOIN home hm ON hm.id = r.home_id, hm.battery_kwh: today's value, so the same numbers; G changes it to the sum of the home's battery things). All four hold 0 rows today; only the definitions are tested (plan-tables).

**Section 13, the capsule.** DROP TRIGGER for every user trigger on site, device, site_version, device_attr_version (and their functions, except the tripwire). CREATE FUNCTION trg_folded() raising '% was folded into thing: write the thing, not %'. CREATE TRIGGER site_folded, device_folded, site_version_folded, device_attr_version_folded BEFORE INSERT OR UPDATE OR DELETE ... FOR EACH STATEMENT EXECUTE FUNCTION trg_folded() (statement level: a stray writer fails even when it matches no row). The old tables keep their rows as a time capsule until Q2. They have no inbound FKs (asserted). DROP TABLE device_kind (registry; label, keys and action codes are in thing_type and device_action). UPDATE nothing in device_action: device_action.device_kind stays a text column naming a thing type (no FK to a code-seeded registry is possible in a migration); its hot_water rows name the system type.

**Section 14, home triggers** home_attrs_valid, home_currency_matches_agreements, thing_default_bindings, thing_home_env_key index, thing_link_checks (4.4). thing_one_home stays (renamed column already).

**Section 15, re-enable and sweep.** ENABLE TRIGGER thing_attrs_allowed, thing_attr_version_on_insert. Post-asserts (RAISE EXCEPTION on any mismatch):
- every table in fold_before that still exists has the same count except series (same count), attribute_value (same count) and the four capsule tables (unchanged) and device_kind (gone);
- count(thing kind home) = count(site); count(thing kind device or system) = count(device); thing_attr_version rows = site_version rows + device_attr_version rows + devices without versions;
- uid sets equal (before and after) for homes, devices, connections;
- every FK with confrelid = site(id) or device(id) is only on the capsule tables (none inbound);
- every home_id value is a home thing and every device_id value is a device or system thing (set-based queries, one per column from the generated list); every series thing_id resolves with matching kind;
- thing_one_home holds; thing sequence >= max(id);
- no pg_proc.prosrc in public matches \mFROM (site|device|device_kind)\M or \mJOIN (site|device)\M or \msite_id\M or \mdevice_attr_version\M except trg_folded; no pg_views definition matches them;
- the facts' append-only triggers were enabled throughout, so no fact row was touched.

After the migration, at the first start, seedThings brings the registries in line; the allowed-keys re-check (UPDATE thing SET attrs = attrs inside a rolled-back transaction) must pass for every converted home and device. That check is part of verify-fold (section 12) and of the fixture conversion.

Not in the migration (code or later): thing_type and relation_rule contents (seedThings), the energy graph and spaces (G), relations from existing data, tariff_agreement (stays a table; supplied_on arrives with Phase T, moving it now would also drop agreement_no_overlap and its same-home trigger), kind guards (Q1).

### 7.4 Q1: kind guards

Generated from src/db/ref-guards.js, a data list of { table, column, kinds, sameHomeColumn } read by the generator, test/rules-refs.test.js, delete-home and the completeness test. One function trg_ref_guard() with TG_ARGV (column, allowed kinds, same-home column or ''), one BEFORE INSERT OR UPDATE OF <col> trigger per entry named <table>_<col>_guard, WHEN (NEW.<col> IS NOT NULL) so NULL meaning "shared by all" is untouched (rate_interval, tariff_price_run, price_dirty, raw_payload, raw_check_run, raw_payload_check, register_window.device_id, and so on). Rules:
- home_id columns: kind 'home' (about 38 tables, nullable ones allowed NULL).
- device_id columns: kinds device and system (hot_water is a device_action kind and a system type); same home as the row's home_id on channel, binding, push_log, supply_price_slot, thing_link; tariff_agreement and plan_run_device keep their own same-home triggers from F.
- attribute_value.thing_id: any non-context kind, same home through the thing.
- Skipped on purpose: reading, interval_fact, forecast_fact (home derives from series through trg_fact_home and series_ref), thing_* tables (own triggers), series (series_ref).
Messages: 'home_id must reference a home thing', 'device_id must reference a device or system thing', 'device belongs to another home'. About 45 triggers; cost is one primary-key lookup per inserted row on low-volume tables. Alternative rejected: composite FKs with a constant kind column (thingReferences() and delete-home read single-column FKs only) and subtype id tables.

### 7.5 Q2: contract

DROP TABLE device_attr_version, device, site_version, site (without CASCADE; any remaining dependency fails the migration); DROP FUNCTION trg_folded and the leftover site and device functions; their sequences go with them. Remove them from TABLE_KINDS and LEGACY_CONFIG (the table-kinds test is updated on purpose). Run only after the dev database has been accepted (section 12).

### 7.6 G: energy attributes

See section 14.3.

## 8. Codemod rules (no JS parser exists in node_modules; every rule is regex)

Run through scripts/fold-codemod.mjs. Each rule first runs with --dry: it prints matched lines and files and fails if a count differs from the inventory by more than the stated tolerance (2 percent). After each rule: node --check on every changed file; per file the count of test( and assert. calls and the set of test titles before and after (a codemod must not delete or skip a test); `git diff --word-diff=porcelain` reduced to a frequency table of old to new token pairs, anything outside the planned pairs is read by hand. A leftover scan (scripts/fold-leftovers.mjs, allow-list scripts/fold-leftovers.allow with one justified line per exception) ends each phase and exits non-zero on a hit.

### Phase P rules (old schema, each commit green)

| Rule | Pattern | Replacement | Count | False positives and notes |
|---|---|---|---|---|
| C0a | `\bcreateSite\b` | `createHome` | 71 test lines, 9 src/script callers | none |
| C0b | ``db\.prepare\((['"`])SELECT \* FROM site WHERE id = \?\1\)\.get\(`` | `getHome(db, ` | 35 lines in 26 files | the closing parenthesis is reused; check surrounding await and ?? forms in the dry run; seed-homes:56 is a JOIN and is by hand |
| C0c | the 12 column-list reads `SELECT <cols> FROM site WHERE id = ?` | `getHome(db, ` (returns more than asked) | 12 | settings.js:45 becomes homeExists |
| C0d | `JSON\.parse\(\s*([\w.?]+)\.attrs\s*\|\|\s*'\{\}'\s*\)` and the parseJson variants | `deviceAttrs($1)` | 28 lines in 17 files | the 4 inside try/catch (explorer:127, planner-read:168, devices-view:134 and :216) lose the catch by hand; public/js my.js:164 and ev.js:30 stop parsing in the same commit |
| C0e | `CAST(id AS TEXT) FROM device WHERE site_id = ?` | the shared fragment deviceSubjectsSql | 9 lines in 8 files | the 3 `CAST(d.id AS TEXT)` joins by hand |
| C0f | `FROM device WHERE id = ?` ownership checks | `await deviceById(db, id)` (keep the `d.home_id !== site.id` test) | 13 | |
| C0g | `\.lat\b`, `\.lon\b` on home records | `.latitude`, `.longitude` | about 25 | by hand from a grep; the regex hits other objects |

### Phase M2 rule

| Rule | Pattern | Replacement | Count | Notes |
|---|---|---|---|---|
| C1 | `\bsite_id\b` over src, scripts, public, test (not docs/, not prisma/migrations/, not src/db/.erd.json) | `home_id` | 444 + wave 1 lines in src, scripts, public; 313 + 76 in tests | dry-run count must match, any other count stops the run |
| C1b | `\bsite_uid\b` | `home_uid` | erasure only | |

C1 false positives to hand-check from the dry-run list: string literals 'site_id' (delete-home:82 column probe, versions.js META (file changes in F), attributes.js col dispatch); API output keys (homes[].site_id in /api/connectors read by public/js/connectors-view.js:107, explorer meta.site_id, /health rows) are renamed on both sides in the same commit; the push contract parameters `site` and `device` are a different token and docs/push-ingest.md stays; the object keys of built rows (build.js:594, :631, heat.js:285): the INSERT column list follows Object.keys of the row and sameRow compares every key, so the object literal and the table column rename in the same commit (M2 does both). The sentinel exclusion lists are edited in the same commit: golden-gb and site-version-gb exclude the home key (P2 names 'site_id', C1 renames it to 'home_id'); topologies volatile ['built_at','lineage','site_id'] becomes 'home_id'; compatibility.test.js privacy scan lists both names. JS identifiers siteId (813 lines, about 128 functions) stay.

### Phase F rules

| Rule | Pattern | Replacement | Notes |
|---|---|---|---|
| C2 | `\b(FROM\|JOIN)\s+site\b` in lines that contain SELECT, in src, scripts, public | `$1 home` | about 25 list, filter and join reads remain after P (7 JOINs: control:148, explorer:560, tounify:958, server:951, seed/bindings x2, scripts/seed-homes:56); `_` is a word character so site_hh, site_day and similar do not match; prose "from site" in comments is skipped |
| C3 | the 13 `JOIN device` lines by a table: pricing:57, tariff-picker x3, server x3, devices:107, tounify:690, build:303, executor:31, jobs/control:20 | `JOIN thing d`, `d.kind` to `d.type`, `d.label` to `d.name`, add `d.kind IN ('device','system')` where the join could meet a space | by hand with the dry-run list; provider and external_ref come from `JOIN thing_link` |
| C4 | `device_kind` table readers (deviceKind, deviceKinds, checkDeviceKind in devices.js, plans.js, control.js, coverage.js, attributes.js, scripts/build-coverage-matrix) | thing_type | by hand |
| C5 | test hard-codes | delete-home.test.js and erasure.test.js siteCols() filter is home_id after C1 and asserts a non-empty list; row-count keys rows.site / rows.device become rows.thing; uid.test `device_uid_key` becomes `thing_uid_key` | by hand |

Leftover scan after F (fails on): `\bsite_id\b`, `(FROM|JOIN|UPDATE|INTO|DELETE FROM)\s+(site|device)\b`, `site_version`, `device_attr_version`, `device_kind\b` (allow-list: device_action.device_kind, the DEVICE_KINDS constant), `siteAt(`, `subject_id` reads that assume a text-only column. The allow-list names the migrations, home.js capsule comments and the capsule rules file.

## 9. Hand-work list by module

| Module | Work |
|---|---|
| src/core/home.js | new in P4 on old tables; F4 swaps bodies to thing, home, home_version. |
| src/core/versions.js | remove siteAt, siteVersions, columnsOf('site_version') and META site_id; keep the tariff_version path. |
| src/core/things.js | THING_COLS and REL_COLS home_id (C1); homeClock via getHome; begin() full bigint lock key; thingReferences() skips columns named home_id and own tables, includes series.thing_id and thing_link.thing_id; mergeThings and splitThing use home_id in the same-home checks. |
| src/core/facts.js | seriesId(): INSERT with thing_id and region_ref; region kind writes region_ref. |
| src/core/devices.js, tariffs.js, onboarding.js, channels.js, control.js, commands.js, plans.js, tariff-picker.js, synthetic-iot.js, push-ingest.js, replay.js, adapters/octopus.js, tounify.js, sunsynk.js, jobs/steps.js, jobs/sync.js | device writes through the library; control.js joins thing for the timezone via getHome; push-ingest findDevice by thing_link ref or by thing id of a device of that home. |
| src/core/build.js:257-292 | meter selection reads devicesOf with ORDER BY id on purpose; hhRows key home_id (build.js:594, :631, heat.js:285). |
| src/core/sites.js, attributes.js, adapters/geo.js | createHome, setSlotLength, setContractedCapacity on setHomeSettings. attributes.js: subject is { homeId } or { deviceId }, both resolve to one thing_id; writeValue and resolve write home attrs through setHomeSettings when def.cached_on_home; the `col` dispatch is rewritten (no `${col}` SQL). geo.js: the dynamic `SET ${keys}` becomes a patch object. |
| src/core/delete-home.js | seeds `thing WHERE id = ?` (home) and `thing WHERE home_id = ?` (spaces, systems, devices) instead of site and device; the non-FK probe `columns.includes('home_id')` stays, backed by test home-id-columns; hard-coded raw_payload and provider_state eb-site-<id> stay; removed.site and removed.device become removed.thing; the fixed point follows FKs only from referencing child rows to rows being deleted and never walks up from a deleted thing to a context thing (a relation to a context tariff is a child of the deleted device; the tariff is a parent); add a test with a device related to a tariff context thing and a merged_into chain. |
| src/db/db.js | markCountryChanged via listHomes; hasId cache unaffected (thing and thing_link have id; home_key, tenant_site, connection_secret do not, as before); EXCLUSION_MESSAGES unchanged; env_key unique message. |
| price-queue.js, price-dirty.js ('site_id' constant becomes 'home_id'), price-run-store.js, supply-price.js (device ids in point and stamp are thing ids; supplyPoints still assumes one meter per kind, unchanged and in risks), raw-integrity.js (two `EXISTS (SELECT 1 FROM site ...)` guards become `FROM thing WHERE kind = 'home'`), tax markCountryChanged, pricing.js loadPricing (join thing for d.kind; contracted_kva_origin from the record), maintenance.js rawRefs (column name only). |
| src/db/seed | things.js: house/flat gain outcode, env_key, contracted_kva_origin, contracted_kva_note; device types gain the adapter keys of 5.1; 'controllable' capability derived from device_action; attributes.js: device_kind seeding removed, DEVICE_KINDS stays as the source for thing_type, attribute_def seeding writes cached_on_home and applies_to 'home'; bindings.js as 4.4. |
| src/db/table-kinds.js | add thing_link (config); in Q2 remove site, device, site_version, device_attr_version from TABLE_KINDS and LEGACY_CONFIG. device_kind is already gone from TABLE_KINDS in F. |
| coverage | scripts/coverage-review.js and src/core/coverage.js: 19 `col:site.x` and 8 `col:device.x` targets become `thing_attr:home:<key>` and `thing_attr:device:<type>:<key>` verified against thing_type.attribute_keys (a new checker); `col:site_version.timezone` becomes thing_attr:home:timezone; `col:device_attr_version.attrs` becomes thing_attr_version; registry_key:device_kind:* (3) becomes registry_key:thing_type:*; the 22 device_action:* targets stay. Regenerate docs/coverage-matrix.json on purpose and review the diff; the generator reads docs/database.md, so database.md is edited in the same commit; run the check last. |
| scripts | make-fixture.js rewritten for thing tables (anonymise inside erase('anonymise'): thing name and attrs, thing_link external_ref; versions rewritten with the append-only trigger lifted by the erasure window), truncating raw_check_run and raw_payload_check; verify-rebuild.js reads homes through listHomes and compares KEY SETS as well as values (today it compares only keys present in the stored row, so a renamed key would print 0 values differ while comparing less); seed-homes, demo-users, demo-ui (loadTables(postgresTables(live))), demo-multi-market, reconstruct-history, seal-raw, lib/topologies.js, lib/multi-market.js use createHome and addDevice. |
| test/helpers.js | insertHome, insertDevice, setHome, homeRow, GB_HOME (P4, old tables); bodies become createHome and upsertDevice in F4; TEST_SLOT_S block (section 10). |
| test rules | rules/core.json, things.json, tariff.json, rawstore.json edited AFTER the cases are rewritten (UPDATE_RULES=1 only records what cases prove); new test/rules/refs.json with Q1; temporary test/rules/fold-capsule.json (four tripwire triggers) deleted in Q2. |
| other tests by hand | rules-core cases 24-65, 107-121, 173-184; rules-things inserts home things through insertHome; integrity 121-167; plan-tables 169, 225; provenance:124; multi-market:99; planner-config 146-150 and 212-226 (the md5-of-schema test stays self-relative); uid; home-rows (join thing); delete-home; erasure; groups-classes (column_class); compatibility; coverage-matrix; table-kinds. |
| docs | database.md (Storage engine, tables), thing-model.md (sections 3, 4, 11, 13: home_id, valid_to vs retired_at, bigint required, thing_relation uid and home_id, thing_link minimal form, series.thing_id), thing-platform-plan.md statuses, fix-list.md (naming debt of D11), docs/build/tariff.md (T.3 to T.5 are built; fold list), prisma/schema.prisma by scripts/refresh-prisma.js once after F and once after Q2. |

## 10. Test helpers and the slot-length block

P4 helper signatures (old tables underneath, new bodies in F4):

- insertHome(db, { id?, name, ...settings }): applies DEFAULT_HOME; an explicit id also advances the sequence (setval(GREATEST(...)), which fixes the four explicit-id tests facts-same-ms, resume, sunsynk-channels, sunsynk-dst).
- insertDevice(db, homeId, { kind, provider, ref, label, attrs, recordedAt, uid? }).
- setHome(db, id, patch), setHomeAt(db, id, patch, atMs), homeRow(db, id), deleteHome-row helper.
- Raw SQL moves to them: 29 `INSERT INTO site`, 25 `INSERT INTO device`, 29 `UPDATE site SET`, 7 `DELETE FROM site|device`, and the `SELECT * FROM site` reads, in 59 test files. Assertions are not touched. What stays raw: the rules-core cases that test the database rules themselves (allow-listed, rewritten in F6).

TEST_SLOT_S block after F4: inside one transaction on the cloned template, ALTER TABLE thing_attr_version DISABLE TRIGGER thing_attr_version_append_only; ALTER TABLE thing DISABLE TRIGGER thing_attr_version_on_update; UPDATE thing_attr_version SET attrs = jsonb_set(attrs, '{slot_s}', to_jsonb(N)); UPDATE thing SET attrs = jsonb_set(attrs, '{slot_s}', to_jsonb(N)) WHERE kind = 'home'; re-enable both. Not an erasure window (it would leave an erasure_log row that rules-core:208 and delete-home:102 reject), and not a plain UPDATE thing (it would write a new version and the as-of build would still read the old one, so test:slots could pass at the wrong slot length). hasLive stays "the dump exists"; with the strict loader a stale dump fails loudly.

## 11. Fixture and dump conversion

Principle: never regenerate test/fixtures/gb-home.json.gz from the dev database (dev holds 1,745 slots of home 1 to 17 Nov, the fixture 695 to 28 Oct; regeneration moves every golden). The fixture is converted in place, by running the real migration of the step over the old dump, so the fixture proves the same SQL that runs on dev. Four conversions: D1 (M1), D2 (M2), D3 (F), D4 (G, after the graph).

P1 prerequisites (one commit; the template name hashes migrations, the dump and scripts/lib/databases.js, so every edit of those rebuilds all templates in all worktrees once, and P1 does all loader edits together):
1. loadTables strict: a dump column the target lacks, or a dump table the target lacks, is an error unless the caller passes an allow-list; a target column the dump lacks is allowed only if it has a default and is listed, or is generated or identity (no more silent fresh uuidv7() or clock_timestamp()). helpers.js passes no log today.
2. json and jsonb columns: JSON.stringify every non-null value (node-pg turns a JS array into a Postgres array literal '{}', which breaks thing_type.capabilities, ports, attribute_keys, uid.test.js test 3, make-fixture and demo-ui after wave 1).
3. GENERATED ALWAYS columns are skipped on load; writeDump writes them for readability.
4. writeDump orders rows by primary key (all columns when none) so identical databases give identical bytes.
5. applyMigrations(url, { before }) option (stop before a named migration).
6. Round-trip test: dump, load, dump is byte-identical.
7. Delete scripts/sqlite-to-postgres.js, scripts/verify-sqlite-copy.js, package.json db:copy-sqlite, test/fixtures/gb-home.db-shm and -wal.

Conversion script scripts/convert-fixture.js --step m1|m2|fold|graph (throwaway; deleted after F9; G reuses it):
1. Copy the old dump aside (git has it).
2. tempDatabase(); applyMigrations(url, { before: <this step's migration> }); loadTables(url, dumpTables(old)) with an allow-list for tables the old dump lacks (the wave-1 tables stay empty; thing_type and relation_rule are empty because loadTables truncated them, which is why the fold carries its own frozen registry rows).
3. Capture BEFORE evidence with verify-fold snapshot (section 12).
4. Apply the step migration in one query (withClient(url, c => c.query(fs.readFileSync(file)))).
5. Import src/db/db.js against the scratch database so every code-owned registry (thing_type 43+ types, relation_rule, attribute_def with cached_on_home, device_action, column_class if code-owned) is in line BEFORE dumping (otherwise each test database repeats the seeding writes at first import); then the allowed-keys re-check (UPDATE thing SET attrs = attrs in a rolled-back transaction) for the fold step.
6. verify-fold check against the BEFORE file.
7. writeDump(url, new) to test/fixtures/gb-home.json.gz; build a template from it, writeDump again, assert byte equality (idempotence).
8. Run the sentinels on a template built from the new dump with the expected files untouched: golden-gb (hash adcda37c... unchanged), site-version-gb, topologies (7 fingerprints plus heat), price-runs-gb and the 207 price-slot hashes, slot-build, rebuild-converge.

Numbers for this fixture. M1: G = 4; devices 1..4 (meter_export, meter_import, meter_gas, ev) become 5..8; device_attr_version 5, tariff_agreement 16, series 3 device subjects change; binding 10 rows have device_id NULL (untouched). M2: every site_id column in the 19 dump tables that carry a home (38,683 rows) renames; column_class row site_hh/home_id. F: home thing 1 (uid 01a1e8cb-91f3-794a-bbb2-7fdda09bf50c, valid_from = created_at), 9 home versions (ms record times preserved, last current), 4 device things and 5 device versions, thing_link 4 rows (external_refs are already fixture-<id>, not re-derived), series 39 = 34 site subjects thing_id 1, 3 device subjects thing_id 5..7, 2 region subjects region_ref; reading 30,031, interval_fact 3,488 (712 NULL home), forecast_fact 1,004 (97 NULL), raw_payload 67 (14 NULL), rate_interval 3,109 (all NULL), site_hh 695, site_day 15, site_day_revision 14, check_result 161, sync_run 1: column rename only; site_attribute 5 and site_region 1 keep rows; the dump keeps no row for the capsule tables after the fold (loadTables truncates them) and no site, device, site_version, device_attr_version, device_kind rows. D4 adds the graph things and relations (14 things and 25 relations for home 1, section 14).

Other fixtures: golden-gb.json is re-recorded once in P2 (the hash is computed over buildSite(...).hhRows with only built_at, lineage, dur_s, tod_min excluded, so the first key `site_id: 1` is inside the hash). P2 adds the home key to the exclusion list, re-records the hash, and proves perDay totals, slots (722), days (15) and every slot value byte-identical; the explanation is the commit message. This is the only golden change in the whole fold and it happens before the fold. site-version-gb.test.js has its own goldenHash with the same change. topologies.json and price-slots-ref.json (keys 'home 1#0 ...' stay, home id 1 is unchanged; the 207 hashes contain no ids) do not change. docs/coverage-matrix.json is regenerated in F7. test/fixtures/tounify, tariffscanner, push, openmeteo, gb-home-raw are untouched.

## 12. Verification

### 12.1 The script

scripts/verify-fold.js, committed in P7 and deleted after F9. Two commands sharing one canonicalisation:

`node scripts/verify-fold.js snapshot --db <url> --out before.json` (read-only) and `node scripts/verify-fold.js check --db <url> --before before.json --step m1|m2|fold|q1|q2|graph`.

Canonical row: to_jsonb(row) with (a) columns named site_id or home_id read as `home`; (b) every device_id value replaced by the device's uid (looked up in device before, in thing after); (c) series.subject_id for subject_kind 'device' replaced by the uid; (d) supply_price_slot.point 'device:<id>' replaced by 'device:<uid>'; (e) table renames mapped (site to thing kind home; and so on). Row hash: md5(string_agg(canonical::text, E'\n' ORDER BY canonical::text)) per base table. This makes the comparison independent of the id mapping. Content of a snapshot:

1. Per base table (75 on main, 87 after wave 1): row count and canonical hash. Fact tables are hashed in full (reading 89,243, interval_fact 12,568, forecast_fact 8,666, raw_payload 467 on dev: seconds).
2. Identity: sets of (id, uid) for homes, (uid) for devices, (id, uid) for connections; version 7 check.
3. Settings as known: for every home, for every site_version.recorded_at (dev 11 values, fixture 9), for recorded_at - 1 and for now: the JSON of homeAt(db, id, t) restricted to the 17 versioned fields plus id, uid, name, postcode, outcode, env_key, latitude, longitude, settingsRecordedAt, approximateSettings. P4 already routes the old code through homeAt (wrapping siteAt), so the same function is the BEFORE and the AFTER probe. Same for devicesAt(home, t) (ids replaced by uid, attrs parsed) at every integer second around every device recorded_at and retired_at, and deviceAttrsAt for every device_attr_version row.
4. Build numbers: on the fixture, golden-gb's hash, slots, days, perDay; on the dev copy the hash of site_hh and site_heat_slot rows of homes 1 and 2 (built_at excluded) and the meter chosen per kind for each home.
5. pg_stat_user_tables n_tup_upd and n_tup_del for reading, interval_fact, forecast_fact and raw_payload (after pg_stat_force_next_flush()).
6. Schema inventory: counts of FKs to site and device, triggers, functions, exclusion constraints and their names.
7. Access (rehearsal copy only, dev has no user rows): rows of user_site, tenant_site, site_grant, site_group_member, and the answers of users.js canSee, visibleSiteIds and access.js canControl for an owner, another user and an admin.

### 12.2 Pass criteria per step

| Step | Must be equal or true |
|---|---|
| M1 | every table count equal; every canonical hash equal (device ids normalised by uid); every device_id column value is old + G (G read from the snapshot); series.home_id of device series unchanged; the 15 FK columns and no other device_id column exist; fact tables' n_tup_upd and n_tup_del unchanged; device_id_seq >= max(device.id); verify-rebuild prints 0 values differ (781 slots on dev); golden-gb, site-version-gb, topologies, price-runs-gb pass with expected files untouched. |
| M2 | column set of every table equals the old set with site_id and site_uid renamed; canonical hashes equal; no column named site_id; no function body or view definition contains \msite_id\M; rules-all and the rules-* files pass (they fire the rewritten bodies); golden hash and the topology hashes unchanged without editing their expected files; fact counters unchanged. |
| F | home thing count = site count (2 dev, 1 fixture), ids and uids equal, valid_from = created_at; per home the thing_attr_version count = site_version count with recorded_at and superseded_at equal pairwise, the 17 keys equal, current attrs = thing.attrs, the four unversioned keys equal the site row; device things equal the device rows one for one by uid (type, name, attrs jsonb equal, recorded_at ms equal, retired_at to valid_to by ceil, home); thing_link row per device with provider and external_ref equal; device_attr_version replay equal; every thing's attrs keys inside its type's attribute_keys AFTER seedThings; series: ids kept (98 dev, 39 fixture), thing_id resolves, kind matches, same home as series.home_id, region rows have region_ref and no thing_id, facts per series_id unchanged (count and sum(value) per series for reading, interval_fact, forecast_fact); every FK to thing(id) resolves; every home_id value is a home and every device_id value a device or system of the same home (set-based, independent of the migration's own asserts); no inbound FK to site or device; the trigger set equals the union of test/rules/*.json (the rules-all call) plus fold-capsule.json; exclusion constraints keep their names; thing sequence >= max(id); all current thing_attr_version rows equal thing.attrs and thing.name; thing_one_home holds; homeAt (as-known probes, item 3) and devicesAt (integer-second samples) equal; build numbers equal; facts' n_tup_upd and n_tup_del unchanged; access answers equal; the site and device capsule rows are untouched. |
| F, append-only still bites | in a rolled-back transaction: UPDATE reading SET value = value + 1 on one row (by ctid) raises; UPDATE thing_attr_version SET attrs = attrs raises; DELETE FROM raw_payload raises; erasure_log count unchanged. |
| Q1 | every column named home_id or device_id with an FK has a guard or is in the documented skip list; each guard rejects a thing of the wrong kind (rules-refs); no existing row violates a guard (set-based). |
| Q2 | the four tables and trg_folded are gone; no code, test or doc outside the allow-list matches the leftover scan; table count = F count - 4. |
| Whole suite | the set of passing test titles (TAP) after is a superset of the set before; no title disappears; new titles allowed. |

### 12.3 Rehearsal on a copy of dev (before any dev migration)

Never write to energiebee_dev; read-only psql there. The copy is made with pg_dump | psql into energiebee_fold_rehearsal (never CREATE DATABASE ... TEMPLATE on a live database).

- R1 copy. R2 `DATABASE_URL=<copy>` prisma migrate deploy applies the merged wave-1 migrations (dev has none of them). R3 scripts/rehearsal-seed.js adds what dev lacks and what could break: a user and an admin, user_site, tenant_site, site_grant, site_group and member rows for homes 1 and 2; plan_run, plan_run_device and plan_slot rows and a command and command_block for home 2's heat pump and battery (this exercises the trigger disabling of M1); a control_limit; a retired device whose retired_at is not a whole second; a device without any device_attr_version; a tounify connection with external_ref eb-site-1 and a provider_state row; a command left pending (negative run).
- R4 snapshot on the copy (and on the real dev database without writing: snapshot is read-only).
- R5 apply M1, check; apply M2, check; apply F with psql -v ON_ERROR_STOP=1 -1 -f. First with a deliberately failing last statement (SELECT 1/0 appended) and verify the copy is unchanged (atomicity), then the real file. R6 check. R7 import db.js (seedThings, attributes) on the copy and rerun the allowed-keys re-check; start the server against the copy and curl /api/sites, /api/sites/1/devices, /api/sites/1/health; scripts/verify-rebuild.js (781 slots, 183 ms-class timing, 0 values differ) before M1 and after F. R8 run the whole rehearsal twice from fresh copies and diff the two after-snapshots (determinism: same G, same ids).
- Negative runs on throwaway copies, each must abort with the named message and leave the database unchanged: a non-v7 device uid; a site_version current row removed; a lineage with sub_meters; an unknown attrs key; a pending command (M1); a device id inside the home id range (F); a retired device with retired_at <= recorded_at.

### 12.4 Real run on dev

pg_dump -Fc into data/backups/ (documented path); npm run db:migrate (M1, M2, F in order, with the app and sync jobs stopped); verify-fold check at each step; start the app once (seedThings reconciles the registries; assert snapshot equals code); scripts/verify-rebuild.js. A failed migration leaves a failed row in _prisma_migrations; after fixing run `prisma migrate resolve --rolled-back <name>`; the transaction guarantees no data change. Expected dev ids: G = 9, devices 10..18, thing sequence 18. Dev data cannot prove per-user access, plan or command remap; the rehearsal seeds prove them.

## 13. Steps (sequential or parallel; file sets disjoint where parallel)

Rules for all steps: one worker owns a file; a shared file (test/helpers.js, src/core/home.js, src/core/devices.js, src/core/things.js, scripts/lib/databases.js, src/db/table-kinds.js, src/db/db.js, src/server.js) changes only by its owner. At most three workers at once. Test runs follow section 19.

| ID | Title | Mode | Hours | Files | Done when |
|---|---|---|---|---|---|
| P1 | Loader and tooling fixes, sqlite leftovers removed | sequential | 5 | scripts/lib/databases.js, test/uid.test.js, test/loader.test.js (new), package.json, deleted sqlite scripts and shm/wal files | strict loadTables, jsonb stringify, generated-column skip, ordered dump, applyMigrations before-option; round-trip test green; uid.test.js test 3 green on the merged wave-1 tree; suite green (every template rebuilds once, expected) |
| P2 | Hash-neutral sentinels, golden re-recorded once | parallel with P1 and P3 | 3 | test/golden-gb.test.js, test/site-version-gb.test.js, test/topologies.test.js, test/compatibility.test.js, test/fixtures/golden-gb.json | the four files green; diff of golden-gb.json shows only the hash; commit message shows old and new hash and the identical perDay table, slots 722, days 15 |
| P3 | Seed preparation | parallel with P1, P2 | 3 | src/db/seed/things.js, test/things.test.js, scripts/check-allowed-keys.js (new, read-only) | things.test and rules-things green; the check proves the 9 dev device attrs and 2 home settings pass thing_attrs_allowed against the freshly seeded registry (read-only on the dev copy) and the fixture's |
| P4 | home.js, devices.js and test helper seams on the old schema | sequential (one worker) | 8 | src/core/home.js (new), src/core/devices.js, src/core/versions.js (siteAt wrapped by homeAt), test/helpers.js, test/home-lib.test.js (new) | homeAt equals siteAt on every fixture version; suite green |
| P5 | Callers in src onto the seams (rules C0a-C0g) | parallel, 3 workers over 4 file groups | 11 | A core numbers: build, forecast, heat, derive, explain, compare, trust, history, replay, insights, solar-*, impact, pricing, planner-read. B adapters: src/adapters/*, tariffs, tariff-picker, push-ingest. C jobs and bootstrap: src/jobs/*, synthetic-iot, executor, maintenance, users, signup, groups, plans, control, channels, commands, attributes, sites, settings, onboarding, devices-view, raw-integrity, price-queue, price-dirty, db.js. D server.js, src/routes/*, public/js/*, scripts/*, scripts/lib/* | leftover scan: FROM, JOIN, UPDATE, INSERT INTO site and device only inside home.js, devices.js, versions.js capsule, migrations and the allow-list; no JSON.parse of device attrs outside deviceAttrs; suite and npm run test:slots green; golden, topologies, site-version-gb untouched |
| P6 | Test files onto the helpers | parallel with P5, 4 file groups | 12 | the 59 test files with raw site and device SQL, split into four alphabetical blocks of consecutive files; groups-fixtures.js goes with the block that holds the groups-* tests | per-file test( and assert counts and title sets unchanged; no raw site or device DML outside helpers.js and the allow-listed rules-core cases; suite green |
| P7 | Tooling (new files only) | parallel with P4-P6 | 8 | scripts/verify-fold.js, scripts/rehearsal-seed.js, scripts/fold-gen.js, scripts/fold-codemod.mjs, scripts/fold-leftovers.mjs and .allow, scripts/convert-fixture.js | the codemod dry run prints rule counts within 2 percent of the inventory; verify-fold check on an unmigrated database reports every difference as expected (self-test); suite untouched |
| P8 | Before evidence | sequential | 2 | none (evidence files outside the repo or under data/) | snapshot files exist for the fixture-loaded scratch database and for a copy of dev, on the merged, pre-M1 tree |
| M1 | Device ids above homes | sequential | 7 | prisma/migrations/20261119000000_device_ids_above_homes, test/fixtures/gb-home.json.gz (D1) | verify-fold check --step m1 clean on the dev copy (rehearsal seeded) and the fixture; sentinels unchanged; atomicity and negative runs pass |
| M2 | site_id to home_id | sequential | 9 | prisma/migrations/20261119010000_home_id, codemod C1 over src, scripts, public, test, test/rules/*.json name edits, gb-home.json.gz (D2), prisma/schema.prisma | verify-fold check --step m2 clean; rules-all green; the four sentinels and price-slots unchanged without editing expected files; suite and test:slots green |
| F1 | Fold migration on scratch databases | sequential | 14 | prisma/migrations/20261119020000_fold_site_device, scripts/fold-gen.js output, src/db/ref-guards.js (list only) | applies on an empty database, on the D2-loaded fixture scratch and on the rehearsal copy; the injected-failure run leaves the database unchanged; its own asserts pass. THE SUITE IS RED FROM THE COMMIT THAT ADDS THIS FILE and stays red on branch wp/fold until F8; the red commits live on wp/fold only |
| F2 | Rehearsal on the dev copy | sequential | 7 | scripts only | section 12.3 R1-R8 and all negative runs pass; verify-fold check --step fold prints 0 differences; dev untouched |
| F3 | Fixture D3 | sequential | 4 | test/fixtures/gb-home.json.gz | convert-fixture --step fold done; dump idempotent; verify-fold clean on the fixture |
| F4 | Library bodies and seed under the new schema | sequential (one worker, defines the contract) | 10 | src/core/home.js, devices.js, versions.js, things.js, facts.js, delete-home.js, db.js, price-queue.js, price-dirty.js, raw-integrity.js, src/db/seed/*, src/db/table-kinds.js, test/helpers.js bodies and TEST_SLOT_S | things.test, rules-things (inserts through insertHome), home-rows, uid, delete-home and the four sentinels run; the schema and rules group (S1 to S3 buckets, 12.5) is green |
| F5 | Codemod C2 and the leftover scan | sequential | 2 | files with FROM or JOIN site | leftover scan clean except the allow-list; node --check passes; test and assert counts per file equal |
| F6 | Hand modules | parallel, 3 workers over 4 groups | 20 | W1 adapters and jobs (octopus, tounify, sunsynk, steps, sync, push-ingest, replay, tariff-picker); W2 core money and planning (build, pricing, supply-price, tariffs, plans, commands, control, channels, onboarding, planner-read, attributes, sites, explorer, trust, health, groups, coverage); W3 server.js, routes, public/js, scripts (make-fixture, verify-rebuild, seed-homes, demo-*, topologies, multi-market, build-coverage-matrix, coverage-review); W4 tests (rules-core and core.json, rules-things, rules-tariff, rules-rawstore, home-id-columns, home-door, integrity, plan-tables, provenance, multi-market, planner-config, uid, delete-home, erasure, groups-classes, compatibility, coverage-matrix, table-kinds) | each worker's group green on the converted template, in batches of at most four files; git diff --stat per worker disjoint |
| F7 | Rules catalogue, coverage matrix, docs | sequential | 4 | test/rules/*.json (after the cases exist), docs/coverage-matrix.json, docs/predbat-predheat-coverage.md, docs/database.md, docs/thing-platform-plan.md, docs/build/fold.md | rules-all, coverage-matrix, table-kinds, compatibility green; node scripts/build-coverage-matrix.js --check clean |
| F8 | Triage to green | sequential | 10 | any | zero failing files; npm run test:slots; the whole suite once; passing-title set is a superset of the pre-fold set |
| F9 | Real dev migration | sequential | 3 | none | 12.4 done; verify-fold check clean on dev; verify-rebuild 0 values differ; the server starts and home 1 opens |
| Q1 | Kind guards | sequential | 5 | migration 20261119030000_ref_guards, src/db/ref-guards.js, test/rules/refs.json, test/rules-refs.test.js, test/home-id-columns.test.js | each guard rejects the wrong kind; the completeness test over pg_attribute passes; suite green |
| Q2 | Contract | sequential | 2 | migration 20261119040000_fold_contract, table-kinds.js, test/rules/fold-capsule.json (delete), scripts/fold-*.js and verify-fold.js, convert-fixture.js (delete), prisma schema refresh | only after F9 acceptance and a few days on dev; leftover scan with a short allow-list; suite green; table count = F count - 4 |
| G1 | Library gaps and attribute migration | parallel (a, b) | 7 | (a) src/core/things.js, src/core/things-view.js (new), test/things.test.js; (b) migration 20261119050000_energy_attributes, src/db/seed/attributes.js, src/db/seed/things.js, src/db/table-kinds.js, prisma schema | new library tests pass (lock serialises, merge of two batteries keeps the survivor, uid mappings); all 39 wave-1 things tests unchanged; migration applies on an empty database and on the converted dev copy, 8 rows to 8 rows with identical decoded values |
| G2 | energy-graph.js and attributes.js | sequential | 8 | src/core/energy-graph.js (new), src/core/attributes.js, test/energy-graph-plan.test.js | pure planner test green; on the converted GB copy ensureEnergyGraph(1) yields 14 things and 25 relations and a second run writes nothing |
| G3 | Readers, writers, spaces | parallel, 3 workers | 9 | (a) build, groups, planner-read, forecast, explorer, trust, derive; (b) quartz, openmeteo, sunsynk, jobs/sync, signup, maintenance, sites; (c) synthetic-iot, scripts/lib/topologies.js and multi-market.js, scripts/demo-start.js, test/groups-fixtures.js; server.js is changed once after (a) and (b) | golden-gb, site-version-gb, topologies, planner-read, groups, forecast-sources, signup, sunsynk-channels green with expected files untouched; the four values for home 1 are the same before and after |
| G4 | Thing API and docs | parallel | 12 | src/routes/things.js (new), mount line in src/server.js, test/things-api.test.js, test/things-access.test.js; docs/thing-model.md, thing-platform-plan.md, build/things.md, database.md, visual/home-graph.html, scripts/coverage-review.js | API and access tests green; privacy scan finds no integer id keys; node scripts/build-coverage-matrix.js --check passes |
| G5 | Fixture D4, equivalence and dev | sequential | 6 | gb-home.json.gz (D4), test/fixtures/energy-before.json, test/energy-equivalence.test.js | energy-equivalence green against the before file captured at G1 start; every sentinel passes; npm run test:slots; dev: 14 things and 25 relations for home 1, the synthetic home's graph, attribute_value 8 rows, no home-keyed battery or PV row, verify-rebuild 0 values differ, whole suite once |

Total 191 hours (section 17).

### 13.1 Triage method for the red window (F4 to F8)

scripts/triage.js (throwaway): run failing files in batches of at most four with the TAP reporter and bucket failures by message signature. Keep a burn-down table (failing files per bucket per commit) in each WIP commit message. The branch merges only at zero.

| Bucket | Signature | Action |
|---|---|---|
| S1 | `column "site_id" does not exist`, `relation "site"` or `"device" does not exist` | missed rename or table reference: extend the codemod rule, rerun it on all files, never fix one file by hand when the same pattern exists in five |
| S2 | `record "new" has no field "site_id"` or a column error inside a trigger | a plpgsql body not rewritten; the sweep in section 7.3 should have listed it up front, so this bucket should be empty |
| S3 | `attribute X is not carried by type Y` | seed whitelist gap: fix src/db/seed/things.js, rerun P3's check |
| S4 | home or device guard messages | a test or code wrote a wrong id (a hard-coded device id, a site id used as device id): a real bug |
| S5 | FK violation on thing | a row inserted before its home thing: use insertHome |
| S6 | a value mismatch in a sentinel (golden, topology, price slots) | STOP and diff before touching anything; a moved number is a bug, never a golden update |
| S7 | rules catalogue mismatch | update the JSON only after the case exists |

## 14. The energy graph (1.4), spaces (1.5) and the thing API (1.6)

### 14.1 Contract assumed from the fold (checked at the start of G1)

Home thing id equals the old site id; home_id points at thing(id); canSee(user, homeId) and visibleSiteIds read user_site unchanged; getHome(id) returns the settings; attribute_value has one subject column thing_id; device things carry provider and external_ref in thing_link; device attrs that today's types refuse are carried by the P3 seed keys. If any is false, stop and adapt names only.

### 14.2 What 1.4 is

Home 1 has four device things (import meter, export meter, gas meter, BMW ev) and nothing else: the inverter, PV and battery exist only as four numbers (pv_kwp 6.5, pv_tilt 20, pv_orientation 60, battery_kwh 10.9 resolved from eight site_attribute rows) and as site-subject series. 1.4 (a) creates the missing physical things from evidence by an idempotent function, (b) wires them with port-directed feeds, meters and part_of, (c) moves the four attributes onto the PV array and battery things, and (d) puts every reader of those numbers behind two functions that return the same values for one array and one battery, so the build's numbers cannot move. Phase 1's exit sentence "nothing reads the graph yet" becomes "only the roll-up reads it (PV size and angles, battery size) and the equivalence test proves identical values".

Library additions in G1(a) (all small): lockHome(homeId) (begin is private; the seeder must read its facts after taking the lock or two boots create two batteries); homeIdOf(ref) (resolve a uid to its home); thingsByIds(ids) and relationByUid(uid) (getThing, placeChain, tree and reach return integer ids; the API never shows them); a public serializer layer src/core/things-view.js; unrelate by uid; a merge policy for attribute_value current rows (two batteries holding a current provider battery_kwh would clash on attribute_value_current: the survivor's row wins, the other's current row is superseded and kept as history); an attribute read per thing with `known`; thingReferences skipping home_id columns (done in F4).

### 14.3 Attributes move (G migration and code)

Migration 20261119050000_energy_attributes: (1) INSERT INTO attribute_value (thing_id, key, source, value, origin, note, recorded_at, superseded_at) SELECT home_id, attr, source, to_jsonb(value)::text, origin, detail, recorded_at, superseded_at FROM site_attribute WHERE value IS NOT NULL (JSON text equals what encodeValue writes; dev: 8 rows, 7 for home 1 and 1 for home 2). Pre-check the origin vocabulary of the 8 rows: a NULL origin maps to the attribute_value default and any row that violates attribute_value constraints aborts the migration with the list. (2) DROP TABLE site_attribute; remove it from table-kinds and the coverage targets. (3) attribute_def: pv_kwp, pv_tilt, pv_orientation applies_to ["device:pv_array"], battery_kwh ["device:battery"], storage 'attribute_value', cached_on_home 0; delete the rows arrays and number_of_inverters; the storage CHECK loses 'site_attribute'. (4) The seed removes pv_kwp, pv_tilt, pv_orientation, battery_kwh, arrays, number_of_inverters from the house and flat keys and pv_kwp, battery_kwh from solar_battery (sizes are rolled up, never stored twice). The battery capacity lives in the attribute store, not in thing.attrs, which also keeps thing_attrs_allowed out of it. v_plan_vs_actual and the `home` view's four capacity columns are redefined as sums over the home's live battery and PV array things.

Adoption inside the seeder transaction: UPDATE attribute_value SET thing_id = <array> WHERE thing_id = <home> AND key IN ('pv_kwp','pv_tilt','pv_orientation'), and the same for battery_kwh onto the battery. Rows keep recorded_at and superseded_at, so attributeAt(..., asOf) answers exactly as before, including before the thing existed (the reader keys on rows). If a battery device thing already exists (home 2) the rows go to it, and a duplicate battery_kwh the device attrs carry is removed through updateThing only after a test confirms it equals the ranked value; if they differ the seeder stops and reports.

Readers (about 25 sites): build.js:172-174 and :216 (batterySizeAt, batteryKwhOfUnit), groups.js:123, :138, planner-read.js:907-909, server.js:384, :439, :652, :784-787, trust.js:194, forecast.js:380 and :397, explorer.js:1310-1319, quartz.js:15-20, openmeteo.js:18-27, derive.js. Writers: sunsynk.js:189, :211, :221, jobs/sync.js:62, derive.js:36, signup.js:227 (withdraw), maintenance.js seedSiteAttributes and :47-55, synthetic-iot.js:191, sites.js createSite (the pvKwp and batteryKwh parameters are deleted, no shim; callers use addPvArray and addBattery), scripts/lib/topologies.js and multi-market.js.

Two functions in src/core/energy-graph.js. energySystem(homeId, { known }) returns arrays [{ thing, kwp, tilt, orientation }], batteries [{ thing, kwh, source }], pv_kwp (sum or null), pv_tilt and pv_orientation (the value when all arrays agree, else null with mixed: true), battery_kwh (sum or null), battery_source (weakest source among members). homeAttribute(homeId, key, atMs) has the exact shape of today's attributeAt ({ source, value, detail, origin, recorded_at }) with the same fallback ("current value (no earlier record)" when asOf finds no record). batteryKwhOfUnit(deviceThing) replaces build.js:216 capOf: an inverter's capacity is the batteries it feeds (reach, depth 1), a battery's is its own. One size per build, as today; day-by-day use arrives with Phase 2.7. setHomeAttribute(homeId, attr, value, source, detail, { origin }) replaces setAttribute(siteId, ...): it finds the single live target; creates the array or battery only if none ever existed and the value is not null; with two or more live targets it writes nothing and returns { skipped: 'several arrays: the plant total cannot be assigned' } which the caller logs. attributes.js loses ATTRS, resolve(), the `UPDATE site SET ${attr}` path and site_column. /api/sites rows keep pv_kwp and battery_kwh from energySystem written explicitly (public/js does not change); the accidental uid leak through `...s` becomes an explicit uid. Quartz and Open-Meteo: exactly one array gives its kWp, tilt and orientation (same values and same 'panel size, tilt or direction unknown' skip as today); zero gives the same skip; two or more give { skipped: 'several arrays: forecast per array arrives with points (Phase 2.2)' }.

### 14.4 The seeder

ensureEnergyGraph(homeId, { at, declare }) in src/core/energy-graph.js, three parts so it is testable without a database:

1. graphFacts(homeId) (reads only): things of the home by type including retired ones, relation rows including ended ones (relationsAt with at = null, known = null), attribute evidence, connection providers (a provider of class inverter, today sunsynk, from the adapter registry), and whether site-subject series with readings exist for solar_w, solar_kwh, battery_soc_pct (EXISTS ... LIMIT 1).
2. planGraph(facts, declare): a PURE function returning { create, relate, adopt, wired } from a table of type rules (data, no home-specific constant).
3. applyPlan(homeId, plan): one operation: lockHome first, facts re-read inside the lock, then createThing and relate through the library only (the database rules still judge every edge), then adopt, with the home's valid_from as valid time and now as record time. Things get no attrs (capacities live in the attribute store).

Evidence rules. inverter: a connection of an inverter provider, an explicit declare.inverter, or an existing inverter device thing. pv_array: any non-null pv_* value or readings in solar_w/solar_kwh; one array named "PV array"; more arrays only by explicit act. battery: any non-null battery_kwh, readings in battery_soc_pct, or an existing battery device thing (home 2's battery is adopted, not duplicated). grid_connection: at least one meter_import or meter_export thing, an inverter, or declared. home_supply: grid_connection or inverter present. System solar_battery ("Solar and battery"): when pv_array or battery exists; members by part_of: pv_array, inverter, battery. Valid_from of every created thing is the home's valid_from; record time is now, so as-known reads before today correctly do not show the graph. The seeder never guesses: no evidence, no thing; a relation that cannot be known is not written; the result says wired: false.

Wiring rules (only what the types make certain; ports are real and the database refuses a wrong port or medium). Single inverter case (0 or 1 inverters): grid_connection.meter feeds meter_import.grid and meter_export.grid; each meter.load feeds inverter.grid; each meter meters grid_connection; pv_array.dc feeds inverter.pv; inverter.battery feeds battery.charge and battery.discharge feeds inverter.battery (two edges, the loop of the model); inverter.ac feeds home_supply.in. Without an inverter: meter.load feeds home_supply.in. Loads: every device type with exactly one ac port in or both that is not in the spine and not an appliance (ev, ev_charger, heat_pump, smart_plug, immersion, iboost) is fed home_supply.out to <load>.ac; an ev behind an ev_charger is fed by the charger's ev port instead; the gas meter has no consumer thing and gets no feeds. Two or more inverters, or a battery with no inverter: only certain edges are written (a battery named to its inverter by the caller, per-inverter pv and battery pairs); no meter or supply wiring; wired: false. Convention, written into docs/thing-model.md: a feeds edge between two `both` ports is a bidirectional link and its from to to direction is the import reference direction; import versus export is the meter's type, not the edge; the import and export meters (two MPANs of one physical meter) stay two things, both fed from the connection and both feeding the inverter.

Idempotence and no resurrection. Existence is by type among ALL things of the home including retired ones; a relation is skipped when a current row with the same (from, from_port, rel, to, to_port) exists, ended or not. Running twice writes nothing (no new thing, relation, version or record time); a retired or replaced battery is not recreated; an owner who ended a meters relation is not overruled; a lazy attribute write creates an array or battery only when none ever existed.

Where it runs (no one-off script): ensureAllHomes() at server start-up after listen and in scripts/demo-start (about six reads per home); at the end of syncSite; at the end of signup's connect step and disconnect (withdrawn values leave the thing, the thing stays); at the end of createSyntheticIotHome with its declare; in the topology and multi-market helpers through explicit addPvArray, addBattery({ inverter }), addInverter (explicit acts: fixtures say what they are). It is not hooked to each of the seven device INSERT sites.

Expected result for home 1 (asserted exactly in test/fixtures/energy-graph-gb.json): nine new things (grid_connection, home_supply, inverter, pv_array, battery, system solar_battery, spaces Outside wall and Driveway) plus the four device things and the home = 14 things. 25 relations: located_in 11 (two spaces to the home; import, export and gas meters to Outside wall; ev to Driveway; grid_connection, home_supply, inverter, pv_array, battery to the home), part_of 3, feeds 9 (connection to import.grid, connection to export.grid, import.load to inverter.grid, export.load to inverter.grid, pv.dc to inverter.pv, inverter.battery to battery.charge, battery.discharge to inverter.battery, inverter.ac to supply.in, supply.out to ev.charge), meters 2. Expected for the synthetic home (declares its own topology: declare: { inverter: 'Inverter (synthetic)' }): existing plug, heat pump, ev charger, battery, sensor; new grid_connection, home_supply, inverter, system solar_battery (inverter and battery, no PV), three spaces; about 21 relations (located_in 12, part_of 2, feeds 7); its battery attribute (10 kWh, provider) is adopted onto the existing battery thing.

### 14.5 Spaces (1.5)

Same seeder, space rules only, as data: a space exists only where something is placed in it. outside_wall ("Outside wall") when the home has a meter_import, meter_export or meter_gas thing; driveway ("Driveway") when it has an ev or ev_charger. Meters and the gas meter are located_in Outside wall; the EV and a charger located_in Driveway; spaces are located_in the home. Existence is by type including retired ones, so an owner-retired driveway is not made again. A device type outside these rules is located_in the home (D13). HOME_WIDE = inverter, pv_array, battery, home_supply, grid_connection, hub, heat_pump: placed only in the home and never in a room; no step of the seeder or the API requires a room for any device; a move to a room is an optional, dated act. Home 1: Outside wall (three meters) and Driveway (BMW ev); no charger is invented; no rooms. Synthetic home, explicit through declare.rooms (DEVICES in synthetic-iot.js gets a room field, no second mechanism): Living room (plug and temperature sensor), Utility room (type room; heat pump), Driveway (ev charger); battery, inverter, supply and connection are home-wide. The seeder passes at = the home's valid_from; the library snaps the start to the next slot boundary and keeps changed_at as the exact moment. retireThing refuses a space that still holds things (409 names them); the API passes the message through.

### 14.6 The thing API (1.6)

New file src/routes/things.js (default-exported Router, mounted by one line next to the explorer: app.use('/api', thingsRouter), before the global error handler). The routes sit outside the app.use('/api/sites/:id') guard, so each runs its own guard first. Serializers and `at`/`known` parsing live in src/core/things-view.js. A shared helper homeGuard(req, homeId) is used by BOTH the existing /api/sites/:id middleware and the new routes. Access: resolve the uid to the thing, then its home_id, then canSee(req.user, homeId); an unknown uid, a uid that is not a home where a home is required, and a home the user may not see answer the same byte-identical 404 { error: 'No such home', code: 'not_found' }, never 403 (no existence oracle). A context thing (home_id NULL: tariff, region, market) is readable by any caller that passes /api auth, with its relation list filtered to homes the caller can see (visibleSiteIds), and writable by nobody through the API. Writes need the same permission as the existing owner write routes of /api/sites/:id (canSee; site_grant canControl applies to commands only); no new permission model. The guard re-checks the home of the answer (as explorer.js hidden() does), and the library receives the home found by the guard so a thing of another home is a 404 again inside the library. `at` is seconds and `known` is milliseconds, as in the library; ISO-8601 instants are also accepted; the wrong unit answers 400 with the library message. Errors: { error, code: 'not_found' | 'invalid' | 'conflict' | 'read_only_kind' } with 404, 400, 409, 400, derived from the library status, never the SQLSTATE; unexpected errors 500 { error }. Responses are never cached. No response contains an integer id, site_id or home_id key (a test scans for it, like the compatibility privacy scan). /api/sites/:id/... (51 routes) is untouched; the bridge is that /api/sites rows and /api/sites/:id/devices rows gain an explicit uid (and place once placed); a client goes from site id to uid through /api/sites and never needs the reverse. Structure writes exist only in the thing API; device data (channels, bindings, commands) stays in /api/sites until points (Phase 2).

| Method | Path | Access and behaviour |
|---|---|---|
| GET | /api/thing-types?kind= | signed in; the registry for building a form (type, kind, label, attribute_keys, ports, capabilities, std_ref); filter kind=space, system, device. |
| GET | /api/homes/:uid/graph?at=&known= | home guard. { home, at, known, spatial (tree of located_in), energy { nodes, edges, wired, isolated }, systems [{ uid, type, name, members }], rollup { pv_kwp, battery_kwh, arrays, batteries } }. energy = feeds and meters edges with nodes on an edge, shared context nodes with home_uid null. One home is a few dozen rows: no pagination. |
| GET | /api/homes/:uid/things?kind=&type=&at=&known= | home guard; thingsOf through the serializer (uid, kind, type, name, attrs, std_ref, valid_from, valid_to, recorded_at, home_uid, merged_into as uid or null), sorted kind, type, name. |
| POST | /api/homes/:uid/things | home guard. Body { type, name, attrs?, placeIn?: uid, validFrom? }. The type's kind must be space or system, else 400 read_only_kind. A space with no placeIn is placed located_in the home; a system is not placed. Create and placement in ONE transaction, so a refused placement (another home's uid, a cycle, a retired parent) leaves no orphan. 201 { thing, placement }. Name 1 to 120 characters after trim. |
| GET | /api/things/:uid?at=&known= | thing guard. { thing, attributes (from the attribute store, as known at `known`), place (placeChain), relations { out, in }, systems }. A merged uid resolves to the survivor and the answer adds merged_from. `known` honours thingAsKnown; a thing not yet recorded at `known` answers 404. |
| PATCH | /api/things/:uid | thing guard, space or system only. Body { name?, attrs? } (attrs a patch; null removes a key). One change is one attribute version. A device or a home answers 400. |
| POST | /api/things/:uid/retire | thing guard. Body { at? } (seconds). retireThing: next slot boundary, ends its relations. A space or system that still holds things answers 409 naming them. Retiring a device is allowed only for a thing without a thing_link (graph-only); an integration device answers 400 read_only_kind. 200 { thing, changedAt, boundary, relations }. |
| POST | /api/things/:uid/move | thing guard on :uid AND on the destination (same home, both visible). Body { to: uid, at? }. moveThing: the old placement ends and the new one starts at the next slot boundary after `at`. Moving to the current place answers 200 with relation null. A cycle or a retired destination answers 409; a destination of another home 404. 200 { changedAt, boundary, from, to, relation }. |
| GET | /api/things/:uid/tree?rel=located_in&at=&known=&maxDepth= | thing guard; rel one of located_in, part_of, feeds, meters, controls, replaces, served_by, supplied_on else 400; maxDepth 1 to 50. |
| GET | /api/things/:uid/place?at=&known= | placeChain: [thing, room, floor, home]. |
| GET | /api/things/:uid/relations?rel=&direction=in\|out\|both&at=&known= | relationsAt mapped to { uid, from {uid, name, port}, rel, to {uid, name, port}, required, valid_from, valid_to, changed_at, recorded_at, superseded_at }; `known` shows superseded rows as recorded at that moment. |
| GET | /api/things/:uid/reach?rel=feeds&direction=out\|in&maxDepth=&at=&known= | breadth-first, each thing once, with distance. |
| GET | /api/things/:uid/history | thingHistory for home things: attribute versions, every relation row ever written, replace, merge, split operations. Uids only. |
| POST | /api/homes/:uid/relations | home guard, both ends in the home. Body { from, rel: 'part_of', to, at?, validTo? }. WRITABLE_RELS = ['part_of']; any other rel answers 400 read_only_kind ("feeds, meters and controls are set by integrations"). Rules are the database's; refusals are 409 with the trigger message. 201 { relation }. |
| POST | /api/relations/:uid/end | relation guard (relation uid to its home to canSee; unknown and foreign give the same 404). Body { at? }. Only part_of and located_in can be ended through the API (located_in ends by a move). 200 { what, boundary }. |

## 15. Test list

New or changed, with what each proves.

| Test | Proves |
|---|---|
| test/loader.test.js | strict loadTables (unknown column or table is an error unless allow-listed), jsonb stringify, generated column skip, dump-load-dump byte identity |
| test/home-lib.test.js (P4) | homeAt equals siteAt for every fixture version before the fold; same file passes unchanged after F4 (the equality probe) |
| test/home-door.test.js | nothing outside home.js, things.js, migrations and the seed reads attrs of a home or its versions |
| test/home-id-columns.test.js | every table with a home_id column has an FK to thing(id) or is in the 3-name list (channel_reject, raw_payload, erasure_log) and in delete-home's seeds |
| test/rules-core, rules-things, rules-tariff, rules-rawstore, rules-all | every trigger in section 7.3 has a case; the catalogue equals pg_trigger and the exclusion constraints exactly; home_attrs_valid cases reproduce integrity, plan-tables:169, provenance:124, multi-market:99 |
| test/rules-refs.test.js + test/rules/refs.json (Q1) | table-driven over src/db/ref-guards.js: for each (table, column, kinds) an INSERT of one column pointing at a thing of the wrong kind raises the guard message (BEFORE triggers fire before NOT NULL and CHECK, so a one-column insert reaches the guard); a second assertion compares the list with pg_trigger |
| test/delete-home.test.js, erasure.test.js | a home with the full seeded graph (spaces, devices, relations, links, versions, a merged thing, a device related to a context tariff) is erased: no thing, thing_relation, thing_attr_version, thing_op, thing_link or attribute_value row of the home remains; shared context things and other homes' relations survive; the erasure log counts things; siteCols() filter is non-empty |
| test/uid.test.js | thing_uid_key; dump-load-dump of the converted fixture |
| golden-gb, site-version-gb, topologies (7 fingerprints plus heat), price-runs-gb, price-runs-synthetic, price-runs, supply-price, price-queue, slot-build, rebuild-converge, slot-rebuild-range, multi-market, explorer-gb, heat-gb | numbers do not move: run unchanged with unmodified expected files after M1, M2, F, Q1, G |
| npm run test:slots (16 files at 900 and 3600) | slot-length handling through the new TEST_SLOT_S block |
| users, signup, access-s7, groups-s1, groups-s6, groups-missing, devices-api, control-*, commands, history | per-user access and device routes unchanged; plus a constructed-database test (rehearsal seed) for canSee, visibleSiteIds, canControl before and after F |
| test/energy-graph-plan.test.js | pure planGraph: home-1 facts give the 9 new things and 25 relations of test/fixtures/energy-graph-gb.json; bare home gives an empty plan; replanning gives an empty plan; a retired space or replaced battery is not recreated; two inverters give wired false; battery without inverter and no declare gives nothing invented; export-only home; the synthetic declared topology |
| test/energy-graph-gb.test.js | on the GB fixture: 14 things and 25 relations, ports and types, located_in rules, HOME_WIDE things located_in the home, solar_battery members, three runs change nothing (counts and max(recorded_at)), two concurrent calls produce one set of things |
| test/energy-equivalence.test.js | against test/fixtures/energy-before.json captured at the start of G1: for the GB fixture, topology homes, multi-market homes and the synthetic home, energySystem and homeAttribute equal the captured values for every recorded_at of the history and for a time before the first record; home 1 ranks measured 10.9 above provider 10.6 |
| test/attributes.test.js | setHomeAttribute creates the array on first write when none ever existed; second identical write writes nothing; two live arrays write nothing and return the skip; withdraw leaves the thing and nulls the value; as-known history survives adoption; migration test: 8 site_attribute rows give 8 attribute_value rows with identical decoded values |
| test/forecast-sources.test.js | quartz and openmeteo request bodies identical for one array; skip texts unchanged for zero; 'several arrays' skip for two |
| test/spaces-seed.test.js | Outside wall only with a meter, Driveway only with an ev or charger, none for a bare home; synthetic rooms; moving the plug keeps the old placement readable at an earlier `at`; no seeder run places a HOME_WIDE thing in a room; retiring a room that holds a thing is refused |
| test/things-library.test.js (G1) | lockHome serialises; homeIdOf; relationByUid; merge of two batteries with current provider battery_kwh succeeds, survivor kept, other superseded; thingReferences ignores home_id columns and includes series.thing_id and thing_link.thing_id |
| test/things-api.test.js | every route happy path with the exact shapes of 14.6; graph for home 1; as-known end to end (move a meter at T; GET place at T-1h and with known = T-1s); POST things in one transaction; a failing placement leaves no thing; retire of a room holding a thing 409 with names; cycle 409; create a device 400 read_only_kind; POST relations part_of ok and feeds 400; merged uid with merged_from; wrong unit 400; every error body has error and code only |
| test/things-access.test.js | user A owns home 1, user B home 2, admin sees both, anonymous with owned homes sees none; for every route B gets a 404 byte-identical to the 404 of a random uid; B cannot write or move into home 1; a move under a home 2 space is 404; context things readable with filtered relations; no response contains an integer id, site_id or home_id key |
| test/planner-read.test.js, devices-api.test.js | payloads for the GB home identical before and after seeding (devices[] has the same 4 entries; graph-only things are not integration devices; the 'site' pseudo-device is unchanged) |
| table-kinds, coverage-matrix, planner-config, compatibility (privacy list has both home_id and site_id) | classification, regenerated matrix, registry diff by exactly the listed rows, no id leak |

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The fold flips the schema for every test at once; a wrong assumption surfaces late | M1, M2 and phase P are green and prove the pieces first; F1 and F2 are proven on scratch and rehearsal copies before any code changes; F4 gives an early green checkpoint on the schema and rules group; the red branch is private (wp/fold) with a burn-down count per commit; a moved sentinel number is a stop. |
| Remap of device ids hits append-only or fixed tables (plan_slot, command_desired_fixed, command_log) where rows exist | M1 disables USER triggers per table inside the transaction for the single UPDATE (rolled back with the transaction on failure); pending commands abort it; the rehearsal seeds plan and command rows; the sweep proves the guards bite again afterwards; dev has 0 rows. |
| plpgsql bodies still say site_id, FROM site or FROM device after a rename (H3) | M2 and F rewrite them from generated text; two in-migration pg_proc and pg_views sweeps; the same sweep in verify-fold; rules cases fire each trigger; the capsule tables are dropped without CASCADE in Q2. |
| Hash drift in golden-gb, topologies or price slots from a key rename or column order | P2 makes the hash id-neutral and re-records once with a byte-identical per-day proof, before anything moves; RENAME COLUMN keeps column position; home ids unchanged so the nine labels hold. |
| Stale or lossy fixture load (silent NULLs, fresh uuidv7 or now defaults) | strict loader, jsonb stringify, generated-column skip, ordered dump, round-trip test, conversion by migration, verify-fold row hashes. |
| Per-user access cannot be proven on dev data (user_site, tenant_site, site_grant, group member all empty) | home ids unchanged means those tables only get an FK swap; the rehearsal seeds rows and compares canSee, visibleSiteIds, canControl before and after; access tests in F8. |
| Device attrs refused by thing_attrs_allowed (keys written by code paths absent from dev data) | P3 greps every writer and extends the seed; the migration converts with the trigger disabled; the post-seed re-check (UPDATE thing SET attrs = attrs, rolled back) proves it; a test asserts each adapter fixture run writes only allowed keys. |
| Home type 'house' is a guess | thing_identity_fixed allows house <-> flat on homes only; the owner confirms for home 1 before F9. |
| Wave 1 is provisional (wp/things has uncommitted edits to its library, tariff docs stale, rawstore FKs not deferrable) | the fold reads wave-1 schema only through the generator and list assertions; rerun F1 and F2 after the final merge; names used from things.js (makeThing, changeThing, relate, thingReferences, homeClock, begin) are re-checked then. |
| One-transaction migration holds ACCESS EXCLUSIVE locks and scans reading (89,243 rows) to validate new FKs | acceptable for the prototype (seconds on dev; the rehearsal measures it); a production-scale run would use NOT VALID then VALIDATE outside the file. |
| series generated column breaks tools that INSERT into subject_id or Prisma introspection | only seriesId() inserts; loader skips generated columns; refresh-prisma run after F and after Q2; fallback (a plain subject_id plus a consistency trigger) rejected as two sources of truth. |
| Naming debt (siteId 813 lines, site_hh, user_site, /api/sites, subject_kind 'site') | stated, zero behaviour, listed in docs/fix-list.md with the phase that removes each (Phase 2.2 series, Phase 3 timelines, Phase 6 pages and API). The no-shims rule is not bent anywhere else. |
| External push clients that send a numeric device id break | home ids and the `site` parameter are unchanged; docs/push-ingest.md recommends the external ref; check push logs of real senders before F9; findDevice accepts a ref or the thing id of a device of that home. |
| Record-time unit mistakes (created_at seconds, recorded_at and retired_at ms, valid_to seconds) | valid_from = recorded_at/1000 as the wave-1 trigger does; ceil on both device ends; verify-fold probes every integer second; the rehearsal retires a device at a non-whole second. |
| A home created between M1 and F reaches the device id range | the F pre-flight asserts max(site.id) < min(device.id) and names the offender; create no homes on a shared database between M1 and F; test databases are rebuilt from templates. |
| Template rebuild after every migration or fixture edit slows runs; laptop loses power under load | four conversions only; P1 does all loader edits at once; sections 13 and 19. |
| supplyPoints() assumes one meter per kind and supply_price_slot.point is by kind, not by meter thing (wave-1 H20) | not changed by the fold (tariff_agreement stays); recorded as an open item for Phase T; only device ids inside points and stamps change in M1. |
| The seeder fabricates structure that Phase 2.7's topology check later trusts | evidence rules and only certain wiring; two inverters or a battery without inverter give wired: false; graph-only things carry no thing_link so Phase 2 can adopt or merge them; the owner can retire. |
| The seeder resurrects or duplicates things; two boots race | existence by type including retired things; ended relations are not rewritten; lockHome before facts are read; concurrency test. |
| The new routes sit outside the /api/sites/:id guard and could leak another home or reveal that a uid exists | one homeGuard for both route families; byte-identical 404; library re-checks the home; context relations filtered; access matrix incl. admin, owner, other owner, anonymous; privacy scan for integer ids. |
| Multi-array homes get a wrong forecast | quartz and openmeteo refuse with a named skip when there is not exactly one array; arrays beyond one come only from helpers today. |
| Merge of two batteries fails on attribute_value current rows or loses history | G1(a) merge policy (survivor wins, other's current row superseded and kept) with a test. |
| Home 2's battery exists as a device and as a home attribute (10 + 10 kWh) | the existing battery thing is adopted; duplicate removed only after equality is verified; energySystem asserts 10. |

## 17. Effort

| Phase | Hours |
|---|---|
| P1 5, P2 3, P3 3, P4 8, P5 11, P6 12, P7 8, P8 2 | 52 |
| M1 7, M2 9 | 16 |
| F1 14, F2 7, F3 4, F4 10, F5 2, F6 20, F7 4, F8 10, F9 3 | 74 |
| Q1 5, Q2 2 | 7 |
| G1 7, G2 8, G3 9, G4 12, G5 6 | 42 |
| Total | 191 agent hours, plus or minus 30 percent |

Wall clock with at most three workers in P5/P6, F6 and G3/G4: about 75 to 85 hours, dominated by the sequential chain M1, M2, F1 to F4, F8, F9 (about 65 hours).

## 18. Explicitly out of scope

- Renaming site_hh, site_day, site_heat_slot, user_site, tenant_site, site_grant, site_group*, site_setting, site_region, site_attribute (until G), site_day_revision; renaming siteId identifiers, /api/sites paths, ?site=, localStorage eb.site, series.subject_kind 'site'; the push contract.
- Moving tariff_agreement and register_window to supplied_on relations (Phase T); tariff as a context thing; supplyPoints per meter thing.
- channel, binding, connection to thing_link with connection_id (Phase 2.3); the pseudo-device 'site' and NULL device_id meaning "the home itself" (Phase 2.5); series to points (Phase 2.2).
- Per-array forecasts (Phase 2.2), day-by-day battery sizes (Phase 2.7), more than one PV array or battery through the API (helpers only).
- A deployment to anything but the local dev database; production-scale NOT VALID migration.
- A UI for the thing API; editing devices or energy edges through the API (D14).
- Home type questions beyond house or flat; homes becoming flat is a user act through setHomeSettings later.
- Renaming device attribute keys from camelCase.
- Rewriting stored command.idempotency_key values.

## 19. Machine constraint

The laptop has a failing battery and loses power under load.

- At most four test files run at a time (the repository default --test-concurrency=4; use `node --test --test-concurrency=4` or a file list of four), and only one suite run at a time on the machine: workers take a lock (`mkdir /tmp/eb-test.lock`, released on exit) before any test run. At most three workers edit in parallel.
- Never run the whole suite until F8, and then once, after the sentinels. Never run test:slots in parallel with the suite.
- Suite order after each schema step, cheap to expensive: (1) table-kinds, rules-all, rules-core, rules-things, rules-tariff, rules-rawstore, rules-refs; (2) home-rows, uid, integrity, groups-classes, coverage-matrix, compatibility, home-id-columns, home-door; (3) golden-gb, site-version-gb, topologies, price-runs-gb, price-runs-synthetic, price-runs, supply-price, price-queue; (4) slot-build, rebuild-converge, slot-rebuild-range, multi-market, explorer-gb, heat-gb; (5) delete-home, erasure; (6) users, signup, access-s7, devices-api, control-*, commands, history; (7) the rest in batches; (8) npm run test:slots; (9) the whole suite once.
- verify-fold, the migrations and the rehearsal are single-process SQL (about 110,000 fact rows hashed in SQL; seconds). The read-only checks on energiebee_dev use psql (SELECT and \d only).
- Every edit of a migration, the dump or scripts/lib/databases.js rebuilds all templates in all worktrees once; batch such edits into the steps that are listed for them.
- Compare passing test titles (TAP) before and after on the same commit pair, not only "green".
