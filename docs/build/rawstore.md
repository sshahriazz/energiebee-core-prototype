# Raw store: RAW_DIR, the file integrity check, retention against the erasure rules

Work package "rawstore", phase 1.7 leftovers (docs/thing-platform-plan.md). Branch `wp/rawstore`, from f59ce42.
Three items: (a) raw files can live on separate storage, (b) a job checks each raw file against its hash, (c) the
retention dry run is checked against the append-only and erasure rules.

State: all three are done and tested. No migration, no table, no trigger, no new HTTP route.

## What was built

### (a) RAW_DIR

- `src/db/raw-dir.js` (no database import, so scripts can use it before they point db.js at a throwaway database):
  - `resolveRawDir(env, root)`: `RAW_DIR` if set (relative values resolve against the project root, like `DATA_DIR`),
    else `DATA_DIR/raw`.
  - `rawFileIn(rawDir, file)`: the path of a receipt's file, or `null` when the stored name is not in the raw store.
  - `rawName(rawDir, full)`: the reverse, the name a file has in `raw_payload.file`.
- `src/db/db.js` exports `rawDir` and `rawFilePath(file)`. With `RAW_DIR` set, the folder must already exist, otherwise
  the process refuses to start (`RAW_DIR ... is not an existing directory (is the volume mounted?)`). Without `RAW_DIR`
  the default folder is created, as before.
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
- `.env.example` documents `RAW_DIR`, `RAW_VERIFY`, `RAW_VERIFY_DAYS`.
- Moving an existing store: stop the app, copy `DATA_DIR/raw` to the new folder (same layout below it), set `RAW_DIR`,
  start. `npm run raw:verify` then confirms every file arrived intact.

Also changed in `landRaw`: the file is written to a temporary name, fsynced and renamed, and only then is the row inserted.
Before, a crash or power cut could leave a row that names half a file, which the new check would report as a mismatch.
A crash in between leaves a `*.tmp` file with no row, which the orphan walk removes after the retention window like any
other orphan. Measured cost on this machine: 0.9 ms per 13 KB file without fsync, 4.3 ms with it (1000 files each).

### (b) The file check

`src/core/raw-integrity.js`:

- `verifyRaw({ siteId, slice, batch, maxProblems })` opens every receipt the way a reader does (`openRaw` in facts.js:
  unseal with the home's key if the file is sealed), rebuilds `sha256("source\nstatus\ntext")` and compares it with
  `raw_payload.hash`. It reads only. It never prints or returns a payload: ids, source names, file names, states, counts.
  Rows are read in pages by id (`batch`, default 500), with a yield to the event loop between pages.
- Per receipt, the states:

  | state | meaning | problem? |
  |---|---|---|
  | ok | text hashes to the stored hash | no |
  | mismatch | file opens, text is not what landed (edited, replaced) | yes |
  | corrupt | sealed file does not decrypt (changed or cut short; the GCM tag fails) | yes |
  | missing | no file in the raw store (store not mounted, file lost, or the row names something outside the store) | yes |
  | unreadable | file exists, the disk refuses it (permissions, I/O error) | yes |
  | keyLost | sealed file of a home that still exists, whose key row is gone | yes |
  | unverifiable | sealed file with no home: its home was erased and the row kept as shared evidence; nobody can open it by design | no (counted) |
  | unsealed | a home's non-public file stored as clear text (still counted as ok if the hash matches); `scripts/seal-raw.js --apply` fixes it | yes |

- The report: `{ at, scope, checked, ok, mismatch, corrupt, missing, unreadable, keyLost, unverifiable, unsealed, bytes,
  problems: [{ id, siteId, source, file, state }], problemsBySite, truncated, ms }`. The problem list is capped
  (`maxProblems`, default 200, `truncated` says so); the counts are not.
- `openRaw(row)` in facts.js is the new single reader behind `readRaw`. `readRaw` behaves as before: `null` when the file
  or the home's key is gone, and it still throws on a sealed file that was changed. `rawHash(source, status, text)` is the
  one definition of the hash, used by `landRaw` and the check.
- The job:
  - **Start-up hook**: `runMaintenance` (maintenance.js) runs `runRawCheck()` before retention and returns the report as the
    non-enumerable `rawCheck` (like `retention`, so the per-home result keys keep their shape). `server.js start()` logs one
    line (`rawCheckSummary`, counts only).
  - **Daily**: `startRawCheckSchedule()` runs it every 24 hours while the server stays up (`setInterval(...).unref()`;
    a failure is logged and swallowed).
  - **Slices**: a full read of a large store at every start would delay the server, so each run takes the slice of
    receipts due that day: ids with `id % RAW_VERIFY_DAYS = (epoch day) % RAW_VERIFY_DAYS`. With the default of 7, every
    receipt is checked once a week and a run reads about a seventh of the files. Settings: `RAW_VERIFY=report|off`
    (default `report`), `RAW_VERIFY_DAYS` (default 7).
  - **By hand**: `npm run raw:verify [-- --site <id>] [-- --slice <index>/<of>]` checks the whole store by default, prints
    the JSON report and the summary line, exits 1 when there is a problem (for cron).
  - **Health**: `GET /api/sites/:id/health` has a new field `rawCheck` (null before the first run in this process, else
    `{ at, slice, checked, problems, problemList: [{ id, source, state }] }` for that home only). Access is the existing
    home access of that route; no new route.
- Measured (this machine, a scratch database, 3000 receipts of about 13 KB, half sealed): 2.7 s for all 3000
  (39.7 MB, about 0.9 ms per receipt); a 1/7 slice of 429 receipts took 0.43 s. Landing 3000 receipts took 22 s
  (7.3 ms each, including the database insert and the fsync).

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
  - every surviving file verifies as it did before retention ran.

## Tests

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
TEST_DB_PREFIX=<prefix> node --test --disable-warning=ExperimentalWarning test/raw-store.test.js
```

`test/raw-store.test.js` (10 tests, about 17 s) covers: the path resolution and its refusals; a child process with
`RAW_DIR` set (files land there and nothing under `DATA_DIR/raw`, read back, verify; a `RAW_DIR` that does not exist stops
the process and is not created); verify on plain, sealed, quarantined and home-less receipts with page size 2; each damage
state (changed plain file, bit flip in a sealed file, truncated sealed file, deleted file, chmod 000 file, deleted home key,
clear-text file of a home); the unverifiable case; slices cover every receipt exactly once; settings and the hook; and the
retention cases above.

Run and passing in this checkout: raw-store (10), retention (6), delete-home (5), erasure (3), explorer (12), explorer-gb (1),
replay-sunsynk (10), replay-retention (4), tounify (33), table-kinds (4), rules-all (2), home-rows (4), push-api (23).
The whole suite was not run (the integrator does that).

## Decisions and deviations

- **No migration, no rules test.** The plan item needs no schema: the hash is already in `raw_payload.hash`, and the
  result of a check is a report, not stored data. So the brief's `test/rules-rawstore.test.js` and `test/rules/rawstore.json`
  do not exist: I added no trigger and no exclusion constraint. The check result is not persisted; the health field and the
  log line show the latest run of the current process only. If the integrator wants a history of checks, it would be a
  `log` table (`raw_check`: at, slice, counts, problem ids); I left it out because nothing reads it yet.
- **The stored name keeps `raw/`.** Changing `raw_payload.file` to a name relative to `RAW_DIR` would need a data migration
  and would touch the fixture. Keeping it means a RAW_DIR move is a file copy.
- **A missing `RAW_DIR` is a refusal**, not a folder to create (see above).
- **Weekly slices by id, by default**, instead of a full check at each start. A by-hand run is always complete.
- **`readRaw` unchanged in behaviour**, but it now sits on `openRaw`. `rawFilePath` also confines names to the raw store:
  before, the explorer accepted any name under `DATA_DIR`; now only `raw/...`.
- **Test changed on purpose: `test/erasure.test.js`.** It kept a backup copy of a sealed file in a temp folder and read it
  back with `path.relative(dataDir, backup)`; that name now resolves to `null` (outside the raw store), so the test would
  have passed without proving that the missing key is what blocks the read. The backup is now restored into the raw store
  (`raw/backup-copy.json`), so the assertion tests the key. Expectations are the same.
- Other tests that join `dataDir` with a stored file name (`retention`, `delete-home`, `replay-sunsynk`, `tounify`) still
  work because the default raw folder is `DATA_DIR/raw`; they were not edited.
- Not done: the daily timer is in-process only. A server that is killed often only checks at start. Cron with
  `npm run raw:verify` covers a full check on a schedule.

## What is left

- Persist check results (a `log` table) if a history or an alert on a rising count is wanted.
- `RAW_DIR` on a network or object store: only a local path works; the code uses synchronous file calls. A real object store
  is a different `openRaw`/`landRaw` pair.
- Production key handling (the per-home keys are still rows in `home_key`; the plan says a key management service).
- `scripts/seal-raw.js` fixes `unsealed` findings but is not run by the job; it stays a manual step.
