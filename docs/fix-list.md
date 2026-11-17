# Fix list

The one place to track the move to Postgres and every fix from [the design review](thing-platform-design-review.md), before the [thing platform](thing-platform-plan.md) is built. Each item is closed in order: docs updated, code changed, verification run, commit noted.

**Status:** ⬜ to do · 🟨 in progress · ✅ done · ⏭ moved (the code lands with a thing platform phase; its design is in the docs now)

**Order:** P (Postgres) first, with the model unchanged, so the numbers can be proven identical to SQLite. Then B (baseline problems), then the R fixes that apply to today's code. R fixes that need things, points or the energy graph are designed in the docs now and built with the phase named.

---

## P: move to PostgreSQL with Prisma

Rule: **same model, same numbers.** The golden test and the fingerprint must match the SQLite results exactly before anything else changes.

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| P1 | Local Postgres for development (Postgres.app 18 on `localhost:5432`, databases `energiebee_dev` and `energiebee_test_*` only); a `postgres` service in `docker-compose.yml`; `DATABASE_URL` in `.env.example` | ⬜ | README, `.env.example` | `docker-compose.yml` | `pg_isready`; app connects | |
| P2 | Prisma 7 set up (`prisma/schema.prisma`, `prisma.config`, `@prisma/adapter-pg`) | ⬜ | `docs/database.md` | `package.json`, `prisma/` | `prisma validate`, `prisma generate` | |
| P3 | Postgres schema: `schema.sql` and its 43 deltas translated into one initial migration. Postgres-native where it is better: exclusion constraints for "no overlapping periods" instead of triggers, `jsonb`, `double precision` for every real number (identical arithmetic), `bigint` for milliseconds, `COLLATE "C"` (same text order as SQLite). Prisma models introspected from it | ⬜ | `docs/database.md` | `prisma/migrations/`, `prisma/schema.prisma` | `prisma migrate deploy` on an empty database; every constraint test passes | |
| P4 | Async data layer replacing `src/db/db.js` (`node:sqlite`): the Prisma client, a parameterised SQL helper, transactions, bigint → number, seeding of the registries | ⬜ | `docs/database.md` | `src/db/` | unit tests | |
| P5 | Every module made async and moved to the Postgres dialect: `src/core`, `src/adapters`, `src/jobs`, `src/routes`, `src/server.js`, `scripts/` | ⬜ | — | 159 files | module tests | |
| P6 | Test harness on Postgres (one database per test file, cloned from a migrated template), and all 106 test files ported | ⬜ | `test/helpers.js` notes | `test/` | full suite and `test:slots` green | |
| P7 | Data copy SQLite → Postgres: the live `data/core.db` and the GB fixture | ⬜ | `docs/database.md` | `scripts/sqlite-to-postgres.js` | row counts per table equal; fact checksums equal | |
| P8 | Proof of same numbers: `golden-gb`, the home 1 fingerprint and every slot of `site_hh`, `site_day` and `site_heat_slot` equal to the SQLite build; rebuild time measured | ⬜ | result recorded here | — | comparison script output | |
| P9 | SQLite removed: `node:sqlite`, `DB_FILE`, `npm run reset`, the Dockerfile and docs updated | ⬜ | README, `docs/database.md`, Dockerfile | — | `grep` finds no `node:sqlite` | |

## B: baseline problems found on 16 November

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| B1 | Live data stale since 28 October; one sync stuck in `running`; 7 rebuild requests unprocessed | ⬜ | — | after P7: sync to today | last slot is today | |
| B2 | 6 tests fail on the frozen GB fixture copy, not the live database (partial vs full rebuild, Quartz scoring ×2, forecast accuracy, 15-minute house use, a fact without a raw link) | ⬜ | cause noted here | fix whatever is real | the 6 tests pass | |
| B3 | 25 October (clocks went back): daily counters 40–45 % above the 5-minute samples; meter vs inverter CT 38 % apart | ⬜ | cause noted here | fix if it is ours | the day's checks pass or the cause is upstream and documented | |

## R: design review fixes

| ID | Item | Status | Docs | Code | Verified by | Commit |
|---|---|---|---|---|---|---|
| R19 | Every configuration table has valid time and record time | ⬜ | review, plan rule 5 | test that lists configuration tables and fails on one without them | the test | |
| D1 | Every rule a trigger or constraint enforces is also checked by a code test | ⬜ | plan rule 7 | tests for every constraint (done as part of P3/P6) | the tests | |
| R3 | Stable `uid` (UUIDv7, created by the hub for devices) beside integer ids: homes, devices, connections now; things and points when they arrive | ⬜ | plan rule 6 | migration + insert paths | uids unique and never change on rebuild or copy | |
| R4 | `home_id` on every series, fact, slot and raw row, set on insert | ⬜ | plan rule 6 | migration + insert paths | no row without a home (shared context excepted) | |
| R9 | Rebuilds stop when they converge (same carried-over battery stock); shared changes (tariff, region) queued once and expanded in batches; method version per layer | ⬜ | plan 3.2, T.5 | `src/core/build.js` `processQueue`, `rebuild_queue` | partial = full rebuild; a converged rebuild touches fewer days | |
| R12 | Fixture homes per topology (no battery, AC-coupled battery, two inverters, export only, EV, heat pump), each with a fingerprint | ⬜ | plan 0.3 | `test/fixtures/`, tests | each fixture's fingerprint test | |
| R14 | Erasure: append-only facts and raw rows, one logged whole-home erasure path; raw files encrypted with a per-home key | ⬜ | plan 1.7 | constraints/triggers, `delete-home.js`, `facts.js` raw landing | update/delete refused; erasure works and is logged; raw unreadable after key destroyed | |
| R17 | Limit sources ranked physical > legal > installer > owner > optimiser; a lower source can only tighten | ⬜ | plan 4.3 | `control_limit` sources, the check before sending | tests: a lower source can't loosen | |
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

## Log

Newest first. One line per closed item: date, ID, what changed, how it was verified.

| Date | ID | Result |
|---|---|---|
