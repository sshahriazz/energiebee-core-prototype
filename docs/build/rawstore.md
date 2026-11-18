# Raw store: RAW_DIR, the file integrity check, retention against the erasure rules

Work package "rawstore", phase 1.7 leftovers (docs/thing-platform-plan.md). Branch `wp/rawstore`, from f59ce42.
Three items: (a) raw files can live on separate storage, (b) a job checks each raw file against its hash, (c) the
retention dry run is checked against the append-only and erasure rules.

State: all three are done and tested. One migration (`20261118120000_raw_check`: two tables, one trigger), no new HTTP route
(the health route has a new field). Round 1 of the review changed (b) from a fixed daily slice to a rolling check of the least
recently checked receipts with its results stored; the sections below describe the result.

## What was built

### (a) RAW_DIR

- `src/db/raw-dir.js` (no database import, so scripts can use it before they point db.js at a throwaway database):
  - `resolveRawDir(env, root)`: `RAW_DIR` if set (relative values resolve against the project root, like `DATA_DIR`),
    else `DATA_DIR/raw`.
  - `rawFileIn(rawDir, file)`: the path of a receipt's file, or `null` when the stored name is not in the raw store.
  - `rawName(rawDir, full)`: the reverse, the name a file has in `raw_payload.file`.
- `src/db/db.js` exports `rawDir` and `rawFilePath(file)`. With `RAW_DIR` set, the folder must already exist, otherwise
  the process refuses to start (`RAW_DIR ... is not an existing directory (is the volume mounted?)`). Without `RAW_DIR`
  the default folder is created, as before. The guard is weaker than it sounds: an unmounted volume usually leaves its empty
  mount-point folder behind, and that passes. A missing folder is caught; an empty mount point is not, and `landRaw` would then
  write to the system disk (the check reports those files as missing once the volume is back). A marker file written at set-up
  would close this; it is not built (see What is left). RAW_DIR must be dedicated to the app (see the orphan walk below).
- `raw_payload.file` is unchanged: it stays `raw/<source>/<day>/<hash16>.json`. The name is the receipt's identity;
  the folder is a deployment choice. The `raw/` in the name is the raw folder itself, so with `RAW_DIR=/mnt/raw` the file
  `raw/sunsynk_5min/2026-11-18/ab12.json` is `/mnt/raw/sunsynk_5min/2026-11-18/ab12.json`. No data migration, no change
  to fixtures or goldens.
- Every reader and writer now resolves through `rawFilePath`: `landRaw`/`readRaw` (src/core/facts.js), the explorer
  (src/core/explorer.js), the raw route in server.js (through `readRaw`), `delete-home.js`, retention and the orphan walk
  in `maintenance.js`, `scripts/seal-raw.js`, `scripts/make-fixture.js` (reads the live store from `RAW_DIR`), and
  `scripts/demo-users.js` (copies the live store). Unused `dataDir` imports in replay.js and tounify.js were removed.
- Throwaway runs never touch the live store: `scriptDatabase` (scripts/lib/databases.js), `demo-start.js`,
  `demo-users.js`, `build-coverage-matrix.js` and the test helper `useDb` clear `RAW_DIR` before db.js is imported.
- `.env.example` documents `RAW_DIR`, `RAW_VERIFY`, `RAW_VERIFY_BATCH`, `RAW_VERIFY_HOURS`.
- Moving an existing store: stop the app, copy `DATA_DIR/raw` to the new folder (same layout below it), set `RAW_DIR`,
  start. `npm run raw:verify` then confirms every file arrived intact.

Also changed in `landRaw`: the file is written to a temporary name, fsynced, renamed, and the folder is fsynced; only then is
the row inserted. Before, a crash or power cut could leave a row that names half a file, which the check would report as a
mismatch. A crash in between leaves a `*.tmp` file with no row, which the orphan walk removes after the retention window. The
parent of a newly created day folder is not fsynced, so a power cut can still lose a whole new folder together with its first
file; the row then names a missing file and the check reports it. The calls are synchronous: on a slow or network volume each
landing blocks the event loop for the length of the write (the push ingest path lands raw on every request). Measured on this
machine, a local disk only: 0.9 ms per 13 KB file without fsync, 4.3 ms with the file fsync (1000 files each); the folder fsync
was added afterwards and not measured separately.

The orphan walk (retention) removes only files in the layout the store writes: `<source>/<day>/<name>.json` and its
`.<pid>.tmp` / `.sealing` forms. With `RAW_DIR` a volume that holds other things (a mount's `lost+found`, an operator's notes) is
never touched. Before this change it deleted any unreferenced file older than the window under `data/raw`.

### (b) The file check

`src/core/raw-integrity.js`:

- `verifyRaw({ siteId, limit, trigger, batch, maxProblems })` opens each receipt the way a reader does (`openRaw` in facts.js:
  unseal with the home's key if the file is sealed), rebuilds `sha256("source\nstatus\ntext")` and compares it with
  `raw_payload.hash`. It never changes a file or a `raw_payload` row; it writes its own records (below). It never prints or
  returns a payload: ids, source names, file names, states, counts. Receipts are read in pages (`batch`, default 500), with a
  yield to the event loop between pages. Without `limit` it takes every receipt in id order; with `limit`, the least recently checked.
- Per receipt, the states (stored in `raw_payload_check.state`):

  | state | meaning | problem? |
  |---|---|---|
  | ok | text hashes to the stored hash | no |
  | mismatch | file opens, text is not what landed (edited, replaced) | yes |
  | corrupt | sealed file does not decrypt (changed or cut short; the GCM tag fails) | yes |
  | missing | no file in the raw store (store not mounted, file lost, or the row names something outside the store) | yes |
  | unreadable | file exists, the disk refuses it (permissions, I/O error) | yes |
  | erased | sealed file whose home key is gone (the home was deleted, its key with it): nobody can open it, by design | no (counted) |
  | unsealed | the hash matches but a home's non-public file is stored as clear text; `scripts/seal-raw.js --apply` fixes it | yes |

  `erased` follows the brief: a missing key is not corruption. It replaces the earlier `unverifiable` (home-less rows only) and
  `keyLost` (key gone, home still there, a problem). Deliberate consequence: a key row lost by accident from a live home is now
  also reported as `erased`, not as a problem. Nothing in the code deletes a key except deleting its home, so I judged the
  accidental case not worth a state of its own; if it matters, count `erased` receipts of homes that still exist.
- The report: `{ at, scope, checked, ok, mismatch, corrupt, missing, unreadable, erased, unsealed, bytes, problems: [{ id,
  siteId, source, file, state }], problemsBySite, truncated, ms }`. The problem list is capped (`maxProblems`, default 200,
  `truncated` says so); the counts are not. `ok` no longer includes `unsealed` (they are separate counts).
- `openRaw(row)` in facts.js is the single reader behind `readRaw`. `readRaw` behaves as before: `null` when the file or the
  home's key is gone, and it still throws on a sealed file that was changed. `rawHash(source, status, text)` is the one
  definition of the hash, used by `landRaw` and the check.
- **Tables (migration `20261118120000_raw_check`)**:
  - `raw_check_run` (kind `log`): one row per run for the whole store (`site_id` NULL) and one per home that had receipts in the
    run. Columns: `ran_at` (unix seconds), `trigger` (`start`, `timer`, `cli`), `checked`, `ok`, `mismatch`, `corrupt`, `missing`,
    `unreadable`, `erased`, `unsealed`, `bytes`, `ms`. `site_id` has a foreign key to `site` ON DELETE CASCADE, so a deleted
    home's rows leave with it (the generic delete-home follows the key). Trigger `raw_check_run_fixed`: a row is never updated.
  - `raw_payload_check` (kind `runtime`): one row per receipt, the latest result: `payload_id` (primary key, foreign key to
    `raw_payload` ON DELETE CASCADE), `site_id` (the receipt's home when checked, foreign key to `site` ON DELETE CASCADE),
    `checked_at`, `state` (CHECK on the list above). It exists because `raw_payload` is append-only and cannot hold a check
    time. Retention's "is this receipt used" test ignores foreign keys with ON DELETE CASCADE (`rawRefs` in maintenance.js);
    without that, every checked receipt would have looked referenced and retention would have deleted nothing.
  - Both are classified in `src/db/table-kinds.js`. The trigger is broken on purpose in `test/rules-rawstore.test.js`,
    recorded in `test/rules/rawstore.json`.
- **The job** (settings: `RAW_VERIFY=report|off`, default `report`; `RAW_VERIFY_BATCH`, default 500; `RAW_VERIFY_HOURS`, default 6):
  - A run takes the `RAW_VERIFY_BATCH` receipts checked longest ago: never-checked receipts first (by id), then the oldest
    `checked_at`. Both picks use an index, so a run costs the same on a large store. Each page of 500 is recorded as it is
    read (upsert into `raw_payload_check`), then one log row per run and per home is written. A server that was down, a
    restart, or a timer that drifts changes nothing: the next run takes whatever is oldest. A new receipt is checked at the next
    run, before older ones.
  - `startRawCheckSchedule()` (called when the server starts listening, so it no longer delays start-up): a first run on the
    next tick, then one every `RAW_VERIFY_HOURS`, `setInterval(...).unref()`. It is a deliberate background task (nothing awaits
    it; a failure is logged). A run that would overlap one still going is skipped. `runMaintenance` no longer runs the check.
    The earlier id-modulo slice (`RAW_VERIFY_DAYS`, `sliceFor`, `--slice`) is gone.
  - **By hand**: `npm run raw:verify [-- --site <id>] [-- --limit <n>]` checks every receipt (or the `n` least recently checked),
    records the run with trigger `cli`, prints the JSON report and the summary line, exits 1 on a problem, 2 on a bad argument.
  - **Health**: `GET /api/sites/:id/health` has the field `rawCheck` (null until a run has covered the home), from
    `rawCheckOfHome(siteId)`: `{ at, trigger, checkedInRun, receipts, covered, problems, problemList: [{ id, source, state,
    checkedAt }] }`. `problems` and `problemList` are the latest known state of each of the home's receipts (not only the last
    run), so a damaged file stays listed until a later check finds it fine; the list shows at most 50. Access is the existing home
    access of that route; no new route.
- Measured (this machine, a scratch database, 2000 receipts of about 13 KB, half sealed, local disk): the first 500 (never
  checked) took 413 ms, the next 500 (oldest first) 367 ms, all 2000 2.5 s (26 MB). So a default run is about 0.4 s, whatever the
  store size, and a 1M-receipt store is covered in 2000 runs (500 days at the default, 6 hourly): operators of large stores
  raise `RAW_VERIFY_BATCH` or run `npm run raw:verify` from cron. The earlier landing measurement (7.3 ms per receipt including
  the insert) was not repeated.

### (c) Retention against the append-only and erasure rules

Reading `rawRetention` and `erase()` against migration 20261117000006_erasure showed the design already conforms:
the dry run executes no write, and apply deletes rows only inside `erase({ kind: 'retention' })`, in the same transaction as
the log row; files are unlinked after the commit. What was missing was a test that holds it to that, and one defect:

- Defect fixed: a `raw_payload` row whose file name is not in the raw store (a row anonymised by make-fixture,
  `redacted-<id>`) would have made apply throw (`unlink(null)`) after its rows were already deleted. Retention now skips the
  unlink for such a row (`rawFilePath` is `null`). A dry run counts it as a candidate with a missing file.
- `test/raw-store.test.js` proves:
  - `DELETE` and `UPDATE` on `raw_payload` outside an erasure are refused (`append-only: raw_payload rows never change ...`);
  - a dry run changes no row, no fact, no file and adds no `erasure_log` row;
  - apply deletes exactly the candidates the dry run listed, in one `erasure_log` row of kind `retention`, with
    `removed.raw_payload` equal to the rows deleted, `finished_at` set and no home;
  - receipts that feed a fact, quarantined receipts and fresh receipts stay; no fact row is removed;
  - after apply the rule is closed again (a plain `DELETE` is refused), a second run deletes and logs nothing;
  - an erasure that fails half way leaves rows, files and the log as they were, and does not leave the erasure open;
  - a half-written `*.tmp` file is cleaned as an orphan;
  - every surviving file verifies as it did before retention ran;
  - a failure inside the real retention run (a trigger that raises on one of its deletes, created only by the test) leaves every
    row and file, adds no `erasure_log` row and does not leave the erasure open; without the failure the same run goes through;
  - after apply the files of the deleted receipts are gone from disk (also under a `RAW_DIR` outside `DATA_DIR`).

## Tests

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
TEST_DB_PREFIX=<prefix> node --test --disable-warning=ExperimentalWarning test/raw-store.test.js test/rules-rawstore.test.js
```

`test/raw-store.test.js` (13 tests, about 30 s) covers: the path resolution and its refusals; one child process with `RAW_DIR`
outside `DATA_DIR`: files land there and nothing under `DATA_DIR/raw`, read back, sealed on disk (magic bytes `EBRAW1`),
verified, `scripts/seal-raw.js` finds and seals a plain file there (dry run leaves it), retention (dry run removes nothing,
apply removes the old receipt's file and the orphan in the store layout and leaves foreign files and the newest answer), delete-home
removes the home's files from `RAW_DIR` and its check records, and a `RAW_DIR` that does not exist stops the process; verify on
plain, sealed, quarantined and home-less receipts with page size 2 and exact byte totals; each damage state (changed plain file, bit
flip in a sealed file, truncated sealed file, deleted file, chmod 000 file, deleted home key = erased, clear-text file of a home)
and the state stored per receipt; the rolling selection (least recently checked first, never-checked first, no repeats, a log row per
run and per home, overlap skipped, one home only); the CLI (bad arguments exit 2, a problem exits 1, the run is logged); health
for a home (null before a check, then the counts, a damaged file stays listed across other runs, clears after a good check, 404 for
an unknown home); settings; and the retention cases above. `test/rules-rawstore.test.js` breaks `raw_check_run_fixed` on purpose.

Run and passing in this checkout, after the round 1 changes: raw-store (13), rules-rawstore (2), rules-all (2), table-kinds (4),
retention (6), delete-home (5), erasure (3), explorer (12), replay-sunsynk (10), tounify (33). The whole suite was not run (the
integrator does that). Not covered by a test: the start-up call (`startRawCheckSchedule` is a timer), the explorer reading under
`RAW_DIR` (it uses the same `rawFilePath` as `readRaw`, which is covered), `scripts/make-fixture.js` and `scripts/demo-users.js`
under `RAW_DIR` (they need the app's database; `node --check` passes and the `rawTo` declaration swallowed into a comment by an
earlier edit in demo-users.js is restored, but I did not run `npm run demo:users`, because it copies the app's database).

## Decisions and deviations

- **A log table and a state table were built** after the review (the first version stored nothing: that was a miss against the
  brief, not a choice). `schema.prisma` was not regenerated (`scripts/refresh-prisma.js` writes it from the migrations; the
  integrator can run it once for all packages).
- **No exclusion constraint**, so no `EXCLUSION_MESSAGES` entry.
- **Rolling check instead of id slices.** N least recently checked, N = `RAW_VERIFY_BATCH` (default 500). The unit of the
  interval is hours (`RAW_VERIFY_HOURS`, default 6), not days. The first run is not awaited at start-up.
- **`erased` for every missing key** (see the state table above), including a live home whose key row was lost.
- **Orphan walk restricted to the store's layout**; RAW_DIR must be dedicated to the app. A stray file in the layout
  (`<source>/<day>/x.json` with no row) older than the window is still removed.
- **The stored name keeps `raw/`.** Changing `raw_payload.file` to a name relative to `RAW_DIR` would need a data migration
  and would touch the fixture. Keeping it means a RAW_DIR move is a file copy.
- **A missing `RAW_DIR` is a refusal**, not a folder to create. It does not detect an unmounted volume whose mount point is
  still there.
- **`readRaw` unchanged in behaviour**, but it now sits on `openRaw`. `rawFilePath` also confines names to the raw store:
  before, the explorer accepted any name under `DATA_DIR`; now only `raw/...`.
- **Test changed on purpose: `test/erasure.test.js`.** It kept a backup copy of a sealed file in a temp folder and read it
  back with `path.relative(dataDir, backup)`; that name now resolves to `null` (outside the raw store), so the test would
  have passed without proving that the missing key is what blocks the read. The backup is now restored into the raw store
  (`raw/backup-copy.json`), so the assertion tests the key. Expectations are the same.
- Other tests that join `dataDir` with a stored file name (`retention`, `delete-home`, `replay-sunsynk`, `tounify`) still
  work because the default raw folder is `DATA_DIR/raw`; they were not edited. `test/retention.test.js` keeps its orphan
  `open_meteo/2020-01-01/orphan.json`, which matches the store layout.
- delete-home skips the unlink of a receipt whose stored name is not in the raw store (as retention does); before, the
  `unlink(null)` was swallowed by an empty catch and the file count came out one short.

## What is left

- A marker file in `RAW_DIR` (written at set-up, checked at start and before a write) so an unmounted volume with its mount
  point left in place is detected. Not built.
- `RAW_DIR` on a network or object store: only a local path works; the code uses synchronous file calls. A real object store
  is a different `openRaw`/`landRaw` pair.
- Production key handling (the per-home keys are still rows in `home_key`; the plan says a key management service).
- `scripts/seal-raw.js` fixes `unsealed` findings but is not run by the job; it stays a manual step.
- No alert on a rising problem count: the log table has the history, nothing reads it besides the health field.
- `raw_check_run` has no retention of its own: about 6 rows a day plus one per home per run at the defaults.
