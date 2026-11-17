# Fix list

The one place to track the move to Postgres and every fix from [the design review](thing-platform-design-review.md), before the [thing platform](thing-platform-plan.md) is built. Each item is closed in order: docs updated, code changed, verification run, commit noted.

**Status:** ⬜ to do · 🟨 in progress · ✅ done · ⏭ moved (the code lands with a thing platform phase; its design is in the docs now)

**Order:** P (Postgres) first, with the model unchanged, so the numbers can be proven identical to SQLite. Then B (baseline problems), then the R fixes that apply to today's code. R fixes that need things, points or the energy graph are designed in the docs now and built with the phase named.

---

## P: move to PostgreSQL with Prisma

Rule: **same model, same numbers.** The golden test and the fingerprint must match the SQLite results exactly before anything else changes.

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| P1 | Local Postgres for development (Postgres.app 18 on `localhost:5432`, databases `energiebee_dev` and `energiebee_test_*` only); a `postgres` service in `docker-compose.yml`; `DATABASE_URL` in `.env.example` | ✅ | README, `.env.example` | `docker-compose.yml` | `pg_isready`; app connects | `66ff901` (Docker image not built: no daemon here) |
| P2 | Prisma 7 set up (`prisma/schema.prisma`, `prisma.config`, `@prisma/adapter-pg`) | ✅ | `docs/database.md` | `package.json`, `prisma/` | `prisma validate`, `prisma generate` | `ab16eee` |
| P3 | Postgres schema: `schema.sql` and its 43 deltas translated into one initial migration. Postgres-native where it is better: exclusion constraints for "no overlapping periods" instead of triggers, `jsonb`, `double precision` for every real number (identical arithmetic), `bigint` for milliseconds, `COLLATE "C"` (same text order as SQLite). Prisma models introspected from it | ✅ | `docs/database.md` | `prisma/migrations/`, `prisma/schema.prisma` | `prisma migrate deploy` on an empty database; every constraint test passes | `ab16eee` |
| P4 | Async data layer replacing `src/db/db.js` (`node:sqlite`): the Prisma client, a parameterised SQL helper, transactions, bigint → number, seeding of the registries | ✅ | `docs/database.md` | `src/db/` | unit tests | `ab16eee`, `20aaa5d` |
| P5 | Every module made async and moved to the Postgres dialect: `src/core`, `src/adapters`, `src/jobs`, `src/routes`, `src/server.js`, `scripts/` | ✅ | — | 159 files | module tests | `f8f0489`…`20aaa5d` |
| P6 | Test harness on Postgres (one database per test file, cloned from a migrated template), and all 106 test files ported | ✅ | `test/helpers.js` notes | `test/` | full suite and `test:slots` green | `81e75ac` |
| P7 | Data copy SQLite → Postgres: the live `data/core.db` and the GB fixture | ✅ | `docs/database.md` | `scripts/sqlite-to-postgres.js` | row counts per table equal; fact checksums equal | `feef533` |
| P8 | Proof of same numbers: `golden-gb`, the home 1 fingerprint and every slot of `site_hh`, `site_day` and `site_heat_slot` equal to the SQLite build; rebuild time measured | ✅ | result recorded here | — | comparison script output | `feef533` |
| P9 | SQLite removed: `node:sqlite`, `DB_FILE`, `npm run reset`, the Dockerfile and docs updated | ✅ | README, `docs/database.md`, Dockerfile | — | `grep` finds no `node:sqlite` | `66ff901` |

## B: baseline problems found on 16 November

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| B1 | Live data stale since 28 October; one sync stuck in `running`; 7 rebuild requests unprocessed | ✅ | — | after P7: sync to today | last slot is today | no code change |
| B2 | 6 tests fail on the frozen GB fixture copy, not the live database (partial vs full rebuild, Quartz scoring ×2, forecast accuracy, 15-minute house use, a fact without a raw link) | ✅ | cause noted here | fix whatever is real | the 6 tests pass | `1ce5d00` |
| B3 | 25 October (clocks went back): daily counters 40–45 % above the 5-minute samples; meter vs inverter CT 38 % apart | ✅ | cause noted here | fix if it is ours | the day's checks pass or the cause is upstream and documented | `1ce5d00` |

## R: design review fixes

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| R19 | Every configuration table has valid time and record time | ✅ | review, plan rule 5 | test that lists configuration tables and fails on one without them | the test | see log |
| D1 | Every rule a trigger or constraint enforces is also checked by a code test | ✅ | plan rule 7 | tests for every constraint (done as part of P3/P6) | the tests | see log |
| R3 | Stable `uid` (UUIDv7, created by the hub for devices) beside integer ids: homes, devices, connections now; things and points when they arrive | ✅ | plan rule 6 | migration + insert paths | uids unique and never change on rebuild or copy | see log |
| R4 | `home_id` on every series, fact, slot and raw row, set on insert | ✅ | plan rule 6 | migration + insert paths | no row without a home (shared context excepted) | see log |
| R9 | Rebuilds stop when they converge (same carried-over battery stock); shared changes (tariff, region) queued once and expanded in batches; method version per layer | ⬜ | plan 3.2, T.5 | `src/core/build.js` `processQueue`, `rebuild_queue` | partial = full rebuild; a converged rebuild touches fewer days | |
| R12 | Fixture homes per topology (no battery, AC-coupled battery, two inverters, export only, EV, heat pump), each with a fingerprint | ⬜ | plan 0.3 | `test/fixtures/`, tests | each fixture's fingerprint test | |
| R14 | Erasure: append-only facts and raw rows, one logged whole-home erasure path; raw files encrypted with a per-home key | ✅ | plan 1.7 | constraints/triggers, `delete-home.js`, `facts.js` raw landing | update/delete refused; erasure works and is logged; raw unreadable after key destroyed | see log |
| R17 | Limit sources ranked physical > legal > installer > owner > optimiser; a lower source can only tighten | ✅ | plan 4.3 | `control_limit` sources, the check before sending | tests: a lower source can't loosen | see log |
| R1 | Energy system as a flow network with ports; allocation as rules; topology check | ⏭ Phase 1.2, 2.7 | review, plan | — | — | |
| R2 | Replacement (`replaces`), merge and split of things | ⏭ Phase 1.2, 1.8 | review, plan | — | — | |
| R5 | Derived points as data | ⏭ Phase 2.8 | review, plan | — | — | |
| R6 | Fusion (shape / total / fallback) in point bindings | ⏭ Phase 2.3 | review, plan | — | — | |
| R7 | Four timeline lanes: actual, forecast, plan, price | ⏭ Phase 3.8 | review, plan | — | — | |
| R8 | Required vs optional members decide a group's data state | ⏭ Phase 1.2, 3.3 | review, plan | — | — | |
| R10 | Tariffs stored as price runs | ⏭ Phase T.1 | review, plan | — | — | |
| R11 | Tariffs on sub-meters | ⏭ Phase T.3 | review, plan | — | — | |
| R13 | Relationship changes take effect at the next slot boundary | ⏭ Phase 1.2 | review, plan | — | — | |
| R15 | `point_state` (device shadow) | ⏭ Phase 2.9 | review, plan | — | — | |
| R16 | External changes become manual overrides; external controllers respected | ⏭ Phase 4.2 | review, plan | — | — | |
| R18 | One thing per PV array; any number of batteries and inverters | ⏭ Phase 1.4 | review, plan | — | — | |
| R20 | A thing shared by several homes: sites above homes, `serves` with shares | ⏭ Phase 1.2, 3.4 | review | — | — | |
| R21 | A home changes hands: the home's history vs an occupancy (grants, logins, plans, personal payloads) | ⏭ Phase 1.3b, 1.7 | review | — | — | |
| R22 | Several hubs per home, a hub for several homes, a home with no hub as a normal state | ⏭ Phase 2.3 | review, thing-model §5 | — | — | |
| R23 | Writable points declare their verification (reported, effect, none); unverifiable commands end `sent_unverified` | ⏭ Phase 4.1, 4.5 | review | — | — | |
| R24 | A device moving to another home: a dated home of a thing | ⏭ Phase 1.1 | review | — | — | |
| C1 | The real-world case catalogue (22 cases), each a test | ⏭ with each phase | review | a test per case | the 22 tests | |

## Log

Newest first. One line per closed item: date, ID, what changed, how it was verified.

| Date | ID | Result |
|---|---|---|
| 2026-11-17 | R14 | Migration `20261117000006_erasure`: facts are append-only in the database (a reading or interval changes only by being superseded once; a forecast issue and a raw receipt never change; none is deleted) except inside an erasure: a row of `erasure_log` opened in the same transaction by `src/core/erasure.js` (kinds home, retention, anonymise, synthetic; reason and rows removed per table). Delete-home, retention, the fixture anonymiser and the demo reset go through it; `landRaw` writes the file first, then the row. The record of a home\x27s erasure outlives the home. A home\x27s raw files are sealed with its own key (AES-256-GCM, `home_key`) unless the source is public data (price lists, grid data: `traits.public`); every reader uses `readRaw`; deleting the home deletes the key. Dev data: 372 raw files sealed by `scripts/seal-raw.js` (backup first), all 467 read back identically. Tests: `test/erasure.test.js` (sealed on disk, a backup copy unreadable after the home is deleted, the erasure logged) and the D1 catalogue (4 new triggers). Test setups that aged or back-dated facts now do it inside a synthetic erasure. Suite: 698 of 703 pass, 0 fail after the trigger-list update (4 skipped) |
| 2026-11-17 | R17 | Migration `20261117000005_limit_ranks`: `control_limit.source` is now the rank (physical, legal, installer, owner, optimiser; old rows: adapter and vendor_doc → physical, user → owner) and the evidence moved to `basis`. Trigger `control_limit_ranked` refuses a bound looser than a current, overlapping one of a higher source (in the D1 catalogue). `setControlLimit` replaces only its own source\x27s limit (an owner could replace, and so loosen, an installer\x27s before). `effectiveLimit` gives the tightest bounds and the source that sets each; `checkGates` blocks a value outside them, or every value when they leave none. `test/limit-ranks.test.js` |
| 2026-11-17 | R4 | Migration `20261117000004_home_on_rows`: `series`, `reading`, `interval_fact` and `forecast_fact` get `site_id` (foreign key, partial index), backfilled; triggers set it on insert (a series from its subject: the home, or the device\x27s home; a fact from its series) and refuse a row naming another home (in the D1 catalogue). Region series and their facts are shared context: no home. Slots and raw rows already had it. `delete-home.js` no longer looks series up by subject: it follows `site_id` like any foreign key. The fixture dump was carried to the new columns (same 39,389 rows). `test/home-rows.test.js`: no home row without its home in the fixture or from the write paths. Named `site_id` like every home column; renamed with the rest when the site folds into the home thing |
| 2026-11-17 | R3 | Migration `20261117000003_uid`: `site`, `device` and `connection` get `uid uuid NOT NULL DEFAULT uuidv7()`, unique, and a trigger refuses any change (in the D1 catalogue). `addDevice({ uid })` keeps a uid made by the hub that discovered the device. `test/uid.test.js`: UUIDv7 shape, creation order, a hub uid kept and a duplicate refused, and a copy to another database keeps every uid. PostgreSQL 18 is now required (`uuidv7()`). Things and points get theirs in Phase 1.1 |
| 2026-11-17 | D1 | `test/rules.test.js` breaks every rule on purpose: all 43 triggers (every message of each, e.g. the five of `plan_slot_checks`) and the 3 exclusion constraints; maintenance triggers (versions, default bindings, fact spans) are proved by what they write. Its last test reads the triggers and their `RAISE` messages from the database and fails on any trigger or message with no case, so a new rule cannot land untested. Migration `20261117000002_rules_cleanup`: 4 currency triggers dropped (the `*_implied_*` ones make the same comparison and more), and two rules split across deltas merged (`command_desired_fixed`, `plan_run_append_only`): 49 → 43 triggers. 145 tests of the files touching these rules pass |
| 2026-11-17 | R19 | `src/db/table-kinds.js` classifies all 73 tables (config, fact, serving, log, registry, runtime). `test/table-kinds.test.js` fails on an unclassified table, on a configuration table without `valid_from`, `valid_to`, `recorded_at` and `superseded_at`, and on a fact table without record time. The 27 configuration tables from before the rule are listed with what replaces them (Phase 1.1, 1.3, 2.1, 2.3, T.1, …); a listed table that gains the four columns must leave the list, so it only shrinks |
| 2026-11-17 | B3 | **Ours, two bugs.** (1) Sunsynk keys its day series by clock time, so on 25 October it sent one 01:xx run (279 records for a 25-hour day), the later (GMT) hour; `parseDay` gave it the earlier (BST) instant, an hour early. A time sent once on a clocks-back day is now the later instant (test: `sunsynk-dst`). (2) The real missing hour (00:00–01:00 UTC) got no energy, and the daily counter fit then inflated every other charging slot by 45 %. Gaps of up to 2 hours are now filled on the line between the samples either side, flagged interpolated (`integrate`, test: `integrate-gaps`); method `v4-gaps-filled`. Replay now withdraws readings a receipt no longer gives (test: `replay-sunsynk`); the dev database's 64 Sunsynk day receipts were replayed: 84 readings moved (12 instants × 7 series), nothing else. 25 October now passes every check: charge counter 10.8 vs samples 10.54 kWh (was 7.47), import 12.2 vs 12.26 (was 8.70), meter vs CT 8.61 vs 8.71. Golden file re-recorded at the same moment: house use 357.13 → 359.97 kWh over 14 days, cost £94.01 → £93.93, solar unchanged; 49 slots on 22 days are filled. The frozen fixture keeps 25 October as first read (its raw Sunsynk files are redacted, so it cannot be replayed) |
| 2026-11-17 | B2 | Five of the six were tests whose answer depended on today's date: the forecast learns from the days before "now", and the frozen fixture ends on 28 October. `forecastSite` takes `{ at }` (a forecast as made at a moment; scored forecasts are also limited to those issued by then), and the forecast, 15-minute and trust tests run as at the fixture's last data. The sixth was a real engine bug: `hasInverter` was true only when the build window held inverter readings, so an empty day was built differently by a partial and a full rebuild (partial coverage flag and solar lineage). It is now "the inverter has ever reported, as known at the build". Suite: 661 of 665 pass, 0 fail (4 skipped) |
| 2026-11-17 | B1 | App started on Postgres (dev database backed up first, `data/backups/`): the stuck run 52 closed as interrupted; one sync (74 s, all 12 steps ok) brought home 1 to today: 1,745 slots, 12 October to 17 November, none missing; the 7 queued rebuilds done. Every check from 29 October passes but one `meter_vs_ct_export` warning |
| 2026-11-17 | P9 | `schema.sql`, `schema-prototype.sql` and the 43 deltas deleted (they live on as `prisma/migrations/20261117000000_init`); `DB_FILE` and `npm run reset` gone; Dockerfile runs `prisma generate`, the entrypoint `prisma migrate deploy`; compose has a `postgres:18-alpine` service; README and `docs/database.md` (new storage section) updated. `git grep node:sqlite` finds only the two scripts that read old SQLite files, and dated reviews |
| 2026-11-17 | P1 | Postgres.app 18 on localhost:5432; `energiebee_dev` holds the live data; compose `db` service with the builtin C.UTF-8 locale. The Docker image was not built (no Docker daemon on this machine): to check on first use |
| 2026-11-17 | P8 | `scripts/verify-rebuild.js`: home 1's 781 stored half-hours (12–28 Oct) rebuilt on Postgres as known at each build: 0 values differ, 183 ms (125 ms on SQLite). `golden-gb` and `site-version-gb` pass |
| 2026-11-17 | P7 | `scripts/sqlite-to-postgres.js`: the live `core.db` (first upgraded by the SQLite core at `f014fce`) copied, 118,453 rows in 73 tables, 3 s; `scripts/verify-sqlite-copy.js`: row hashes of 14 fact, tariff and serving tables equal. The GB fixture is now a dump (`test/fixtures/gb-home.json.gz`, `scripts/make-fixture.js`) |
| 2026-11-17 | P6 | One database per test file, cloned from a template named by the migrations' hash; tests never read `.env`. Full suite 655 of 665 pass: the 6 failures are the B2 ones that failed on SQLite too (4 skipped). `test:slots` 111 of 111 at 15 and 60 minutes |
| 2026-11-17 | P5 | Every module async; SQLite dialect rewritten (COALESCE, ON CONFLICT, IS NOT DISTINCT FROM, jsonb, GREATEST/LEAST, strict GROUP BY). Array callbacks through `src/core/async.js`; promise queues and single-flight tokens kept deliberately unawaited |
| 2026-11-17 | P4 | `src/db/db.js`: Prisma client with `@prisma/adapter-pg`; `prepare().get/all/run` as Promises; `tx()` and `rolledBack()` through AsyncLocalStorage; errors in SQLite-like wording; registries seeded at start |
| 2026-11-17 | P3 | One initial migration plus a reference-data migration: 73 tables, 99 foreign keys (deferrable), 49 triggers, 3 exclusion constraints replacing the overlap triggers. Every constraint test passes |
| 2026-11-17 | P2 | Prisma 7.10 (`prisma-client` generator to `src/generated/prisma`, `prisma.config.js`); `prisma validate` and `generate` run in `postinstall` |
