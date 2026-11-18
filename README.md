# EnergieBee core prototype

A working prototype of the EnergieBee unified energy core. It takes data from
each provider, turns it into one trusted half-hour timeline of energy flows and
costs (past, now and forecast), and shows it on ten plain HTML pages. You can
trace every number back to the provider payload it came from.

The stack is Node 22, Express and PostgreSQL through Prisma 7. The schema is SQL in `prisma/migrations`; there is no build step beyond `prisma generate` (run by `npm install`).

## What you need

- **Node.js 22.13 or newer** (22.18 or newer runs the generated Prisma client's TypeScript directly). Check with `node -v`.
- **PostgreSQL 18 or newer** (it makes the UUIDv7 identities, `uuidv7()`): Postgres.app on a Mac, or the `db` service of `docker-compose.yml`.
- **npm** (comes with Node).
- **Internet access** to the providers: Sunsynk, Octopus, National Gas, NESO, Open-Meteo, Quartz and postcodes.io.
- **The home's credentials** in `.env` (see the next section):
  - **Sunsynk:** the Sunsynk Connect login, plus the plant id if the login sees more than one plant.
  - **Octopus:** an API key from the Octopus dashboard (Personal details → API access) and the account number.
- Optional: the installer's panel size, tilt and direction and battery size, if you have them.

The database is PostgreSQL (`DATABASE_URL`); raw provider answers and logs are stored in `data/` (`DATA_DIR`).

## Run

```bash
cd energiebee-core-prototype
nvm use 22                 # or any Node 22.13+
npm install                # installs Express, Prisma and pg, and generates the Prisma client
cp .env.example .env       # then fill in the values (next section), DATABASE_URL first
createdb energiebee        # an empty database (binary text order: --locale-provider=builtin --locale=C.UTF-8)
npm run db:migrate         # applies prisma/migrations
npm start                  # open http://localhost:4100
```

- **First start:** the server creates the home from `.env`, loads 14 days of history and builds the timeline. This takes up to about a minute; until it finishes the pages show a "Loading data from the providers…" banner.
- **After that:** it syncs every 10 minutes (`SYNC_EVERY_MINUTES`). The **Sync** button on any page syncs immediately.
- **`npm run dev`:** restarts the server when a file changes.
- **Starting from scratch:** drop and recreate the database named in `DATABASE_URL`, run `npm run db:migrate`, and empty `data/raw`.
- **Moving an old SQLite `data/core.db` across:** open it once with the last SQLite version (commit `f014fce`) so every delta is applied, then `npm run db:copy-sqlite -- data/core.db` copies every row; `node scripts/verify-sqlite-copy.js data/core.db` checks the copy row by row, and `node scripts/verify-rebuild.js` rebuilds the stored slots and compares them.
- **Port, database and files:** `PORT` (default 4100), `DATABASE_URL` and `DATA_DIR` (default `data`) in `.env`.
- **Raw files elsewhere:** `RAW_DIR` puts the raw provider answers in another folder (default `DATA_DIR/raw`; for example a separate volume). The folder must already exist, otherwise the server refuses to start (so an unmounted volume is not replaced by an empty folder on the system disk). To move a store, stop the app, copy `data/raw` there, set `RAW_DIR`, start, and run `npm run raw:verify`.
- **Raw-file check:** a background check hashes the raw files again and compares them with the stored hash: `RAW_VERIFY=report` (default) or `off`, `RAW_VERIFY_BATCH` (receipts per run, default 500, the least recently checked first) and `RAW_VERIFY_HOURS` (hours between runs, default 6, at most 596). A wrong value refuses the start. The latest result of a home is in `GET /api/sites/:id/health` (`rawCheck`). See `docs/build/rawstore.md`.
- **To stop:** Ctrl+C in the terminal running it.

### Running it unattended

| Command | What it does |
|---|---|
| `npm run serve` | Runs the server under a supervisor (`scripts/supervise.js`). The supervisor restarts the server if it exits (1 s, 2 s, 4 s … up to 60 s apart), and also if it stops answering `/api/status` three minutes in a row. Output goes to `data/logs/server.log`, rotated at 10 MB. |
| `npm run service:install` | macOS only. Installs the supervisor as a login service (launchd), so it starts when you log in and after a reboot. Run `nvm use 22` first; the service uses that Node. |
| `npm run service:status` / `service:uninstall` | Shows whether the service is loaded, with the last log lines / removes it. |
| `npm run history:reconstruct` | One-off: fills the revision log for the time before it was kept by rebuilding each completed day as known at every earlier sync. Writes only to `site_day_revision`; `-- --force` redoes it. |
| `npm run retention` | Shows what retention would delete (raw payloads that feed no fact, old sync runs, superseded old forecast issues, finished queue rows), in counts and bytes; `-- --apply` deletes it. The server runs the same check at every start: a report unless `RETENTION=apply` (`.env.example`; `docs/database.md` section 10.5). Best run with the server stopped. |
| `npm run raw:verify` | Checks every raw file against its stored hash (`-- --site <id>` for one home, `-- --limit <n>` for the n least recently checked). Prints a report and exits 1 on a problem, 2 on a bad argument. Reads only. |

What happens when something fails:
- **A provider is down or slow:** each request is retried twice (after 1 s and 4 s, or as long as the provider's Retry-After asks). Only network errors, timeouts, 429 and 5xx are retried; a 401 (bad key) fails at once. A step that still fails is recorded, and the other providers carry on.
- **The server or a provider was down for a while:** each provider's next fetch reaches back to its last successful sync, less a day of overlap, so the gap is filled in. How far back it reaches: Sunsynk 89 days and Open-Meteo 92 (the most each provider serves), NESO carbon 60 and Octopus 365 (limits set here to keep one catch-up sync reasonable).
- **A sync was cut short:** it is marked `interrupted` at the next start. Facts are saved step by step, and the next sync fetches the same window again.

### Tests

```bash
npm test
```

About 864 tests (4 skipped), about 10 minutes on a laptop at four test files at a time (`--test-concurrency=4`; more can overload a weak machine), using Node's built-in test runner (`npm run test:slots` repeats 112 of them at 15- and 60-minute slots). Each test file uses its own throwaway Postgres database (cloned from a migrated template on the server in `TEST_DATABASE_URL`, default the local one), so the app's database is never changed. Tests never read `.env`.
- **Unit tests:** HTTP retry rules (against a local server), clock changes, Sunsynk's repeated and missing hour, and resuming after an outage.
- **Integration tests** (on a copy of the frozen, identifier-free GB home in `test/fixtures/gb-home.json.gz`):
  - a partial rebuild matches a full rebuild exactly;
  - every half-hour balances, and its bill adds up;
  - the battery stock follows the measured charge level;
  - a provisional day turns final when meter readings arrive;
  - gas waits for its calorific value, then fills in;
  - Quartz is used or refused according to how close it is to actual output;
  - forecast accuracy scoring works;
  - trust features: rebuilding "as known now" reproduces the stored rows; a day known before its meter readings is provisional; revisions, versioned system details, devices and tariff agreements, corrections and the reconstructed history;
  - an old database upgrades in place.

  Where a test needs data the providers haven't sent yet, it writes stand-in values into the copy only.

## Connect a real home

Fill these in `.env` and restart:

| Key | What |
|---|---|
| `SITE_POSTCODE` | Home postcode. Used for the price region, weather, carbon and the solar forecast. |
| `PV_KWP`, `PV_TILT`, `PV_ORIENTATION`, `BATTERY_KWH` | Installer values when known. Empty kWp uses Sunsynk's plant size; empty battery uses the measured kWh per 1% of charge. Tilt and direction can be estimated from the home's output (`estimatePanelAngles` in `src/core/derive.js`); mark them as estimates. |
| `SUNSYNK_PLANT_ID` | The plant to use when the login sees several. |
| `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD` | Sunsynk Connect login. |
| `OCTOPUS_API_KEY`, `OCTOPUS_ACCOUNT_NUMBER` | Octopus dashboard API key and account number (A-XXXXXXXX). |

Each provider is synced on its own. Sunsynk alone gives the energy flows; costs need Octopus, which supplies the tariff and prices.

> Sunsynk's Terms of Use forbid automated scraping of the consumer app. This
> prototype uses the owner's own login at a low rate. A production system needs a
> partner key.

## Your system's details (from the MCS paperwork)

The solar forecast and the battery figures use four details about the system. When the installer's figures aren't entered, the core fills them from the providers or from the home's own data and labels them. **Data & trust → Your system's details** shows each value, where it came from, and whether it is confirmed.

| `.env` setting | What it is | Where to find it | Used now if empty |
|---|---|---|---|
| `PV_KWP` | Panel system size (kWp) | MCS certificate and MCS performance estimate | Sunsynk plant record (6.5 kWp here) |
| `PV_TILT` | Panel tilt from flat (degrees) | MCS performance estimate: inclination | Estimated from the home's output (20° here) |
| `PV_ORIENTATION` | Direction the panels face, as a compass bearing (east 90, south 180, west 270) | MCS performance estimate: orientation. If it is given as degrees away from south, use 180 minus it for east of south, 180 plus it for west of south. | Estimated from the home's output (60° here) |
| `BATTERY_KWH` | Battery usable capacity (kWh) | Battery datasheet or handover pack | Measured from use (kWh per 1% of charge; 11.0 here) |

To replace the estimates:
1. Get the handover pack from the installer. It contains the MCS certificate and the MCS performance estimate; the Data & trust page shows the installer named on the Sunsynk plant record.
2. Put the four figures in `.env`.
3. Restart with `npm start`.

The next sync uses them. The solar forecast switches to Quartz for those panels once its forecasts have been compared with the home's actual output for 2 days.

## No invented data

Every number comes from a provider, from a calculation on that data, or from a cited
public source. Where none applies the value stays empty or the step is skipped; nothing
falls back to a default. See `docs/timeline-forecast-and-data-states.md` for where every
number comes from, how learned values are detected, and what each one affects.

## Pages

| Page | Shows |
|---|---|
| **Home** | Live flow diagram, price now and next 24 h, cost and saving, where the home's energy came from (with the forecast after now), prices, insights |
| **Solar** | Generation split into home, battery and export, the value of solar, forecast against actual, last 30 days |
| **Battery** | Charge level (with forecast), energy in and out by source, stored-energy cost (first in, first out), battery saving, one half-hour costed in full |
| **Grid** | Imports and exports, average price paid against average price, tariffs in force, upcoming prices, smart meter against inverter clamp |
| **EV** | Charging sessions, cost, solar share, smart-charging benefit, planned dispatches |
| **Data & trust** | Why the numbers can be trusted: final share, cross-checks and tracing; how each source arrived for every half-hour; independent measurements compared each day; every kWh accounted for; how each day changed and any day as it was known at an earlier moment; the path of one half-hour from provider response to bill; system details with every version; corrections; connections, syncs, rebuild and source contracts. Every other page links here with a one-line note of what its figures rest on. |

Click any half-hour bar on a chart to open its evidence.

## How it works

```
provider API ─► adapter ─► raw payload ─► facts ─► build engine ─► site_hh / site_day ─► API ─► pages
               (contract)   (kept, hashed)  (append-only,  (align, reconcile,
                                             versioned)     allocate, price, check)
```

- **Adapters** (`src/adapters/`) are the only code that knows about a provider.
  Each one applies that provider's *source contract*: clock and time zone, signs,
  units, missing data and revisions. They split signed values into separate
  direction metrics. For example, Sunsynk battery positive means discharging, and
  Octopus direction comes from the meter point. A payload that breaks its contract
  is quarantined, not loaded.
- **Raw landing**: every payload is stored on disk under `data/raw/` with a
  SHA-256 hash, so a repeated payload is skipped.
- **Facts** (`reading`, `interval_fact`, `forecast_fact`, `rate_interval`) are
  append-only. A changed value becomes a new version and the old row is stamped
  `superseded_at`, so history is never overwritten. Prices are stored *without*
  VAT, and VAT is added from a dated table. This is because Octopus restates
  VAT-inclusive history at today's rate; domestic electricity has been 0% since
  1 Oct 2026.
- **Build engine** (`src/core/build.js`, method `v4-gaps-filled`) runs five steps
  for each UTC half-hour:
  1. **Align**: integrate the 5-minute samples, fill gaps of up to 2 hours on the line between the samples either side (flagged interpolated), and fit them to the inverter's daily counters.
  2. **Reconcile**: the smart meter is used over the clamp when both exist. Home use is calculated from the energy balance.
  3. **Allocate**: split energy into the seven flows (solar to home, battery or grid; battery to home or grid; grid to home or battery).
  4. **Price**: take the rate for each slot, add VAT and the standing charge share, and value battery stock first in, first out.
  5. **Check**: run the balance, meter-against-clamp, counter fit, rate coverage and completeness checks.

  A change is rebuilt from the day it touched and carried forward only while later days still come out differently (the battery's stored energy carries over); the result is always what a full rebuild gives.

  House use is the inverter's measured load. What the sources supplied beyond
  that, exports and charging is the inverter's own conversion and standby loss,
  carried as its own flow (`*_to_loss`, `loss_cost`), so it is in the bill but not
  counted as house use. Gas units come from Octopus (`consumptionUnits`: m³ on
  SMETS2 meters, converted at 39.5 MJ/m³); a usage-based guess is only the fallback.

  Each slot ends up as `final`, `provisional` or `missing`, with a quality
  bitmask and a lineage record. The same facts and method always give the same
  rows; the **Rebuild** button on the Data page proves it.
- **Serving tables** (`site_hh`, `site_day`) are disposable projections. Every
  page reads from them or from the forecast and never calls a provider.
- **Forecast** (`src/core/forecast.js`) covers the next 48 h. It combines the
  latest Quartz issue, a 14-day median of home use, planned EV dispatches,
  published prices and the carbon forecast, then runs a simple battery rule to
  give expected import, export, cost and saving.

Adding a provider means adding one adapter and its contract, plus registry rows
for any new metrics. The schema and the build engine do not change.

## Layout

```
src/
  server.js            Express API and static pages
  db/                  db.js (Prisma, statements, transactions), registry (sources + contracts, metrics, VAT), seed/
prisma/                schema.prisma (models pulled from the database), migrations/ (the schema as SQL)
  core/                time, facts, pricing, build, forecast, insights; price runs and slots (price-runs, price-run-store, slot-price, supply-price, price-marks, price-queue, tariff-slots), things (things.js), raw-integrity
  adapters/            geo, octopus, sunsynk, carbon, openmeteo, quartz
  jobs/sync.js         per-home sync order and scheduler
public/                six pages, app.css, js/ (api, layout, charts, timeline, pages/)
data/                  raw/ and logs/ (git-ignored; DATA_DIR)
docs/build/            build notes of the thing-platform work (docs/thing-platform-plan.md): tariff.md (price runs and slots), things.md (thing graph), rawstore.md (RAW_DIR, raw-file check), sunsynk-writes.md (research on control writes, no code), fold-design.md (design of the next wave)
```

## API

`GET /api/sites` · `POST /api/sites/:id/sync` · `POST /api/sites/:id/rebuild`
`GET /api/sites/:id/` + `now`, `timeline?period=today|yesterday|7d|30d`, `summary?period=`, `forecast`, `solar-expected?period=`,
`insights`, `ev`, `tariffs`, `evidence?slot=<epoch>`, `health`, `system`,
`trust?period=` (coverage, cross-checks, balance, revisions, corrections), `revisions?date=|period=`, `asof?date=YYYY-MM-DD&at=<epoch>` (a day rebuilt as known then; nothing written) · `GET /api/tariffs/:id/slots?from&to&slot_s&site` (a tariff's price in slots, ex tax and with tax; `:id` is the id or the code) · `GET /api/sites/:id/prices?from&to&point` (the home's price timeline per supply point, default today and seven days ahead, at most 62 days; a slot with no price is `known: false`) · the thing graph, by uid (`docs/build/graph.md`): `GET /api/homes/:uid/graph` (places, energy edges, systems), `GET|POST /api/homes/:uid/things`, `GET|PATCH /api/things/:uid`, `…/retire`, `…/move`, `…/tree`, `…/place`, `…/relations`, `…/reach`, `…/history`, `POST /api/homes/:uid/relations`, `POST /api/relations/:uid/end`, `GET /api/thing-types`, `GET /api/things/:uid/points|timeline|events` (a device's points and their state; its timeline slot by slot, with `lanes=actual,forecast,plan,price`; what happened to it) · `GET /api/integrations` (what each integration is, reaches, discovers and reads), `GET /api/homes/:uid/integrations` (a home's connections with health, linked things and last raw answer); pages `/places` and `/integrations` · controls (`docs/build/controls.md`): `GET /api/things/:uid/controls`, `POST /api/things/:uid/requests|group`, `POST /api/requests/:uid/cancel`, scenes `GET|POST /api/homes/:uid/scenes`, `POST /api/scenes/:uid/schedules|apply` · `GET /api/status` · `GET /api/raw/:id` · `GET /api/catalog` · `GET /api/connectors` (every adapter the core has or needs, with a status word each; the Connectors page)

## Known limits (prototype)

- One battery strategy is assumed in the forecast. It does not read the inverter's actual work mode.
- Economy 7 is not priced, because no source gives its switch times.
- The Open-Meteo free tier is for non-commercial use; production needs a paid plan.
- Gas is converted from m³ with National Gas's daily calorific value for the home's LDZ; gas days without a published value wait (check `gas_calorific_value`).
- Panel tilt and direction are estimates until the installer's figures are entered (see "Your system's details" above).
- "As known at" rebuilds read facts, prices, tariff agreements, meters, device details and system details as they were then. Where no version existed yet at that moment (for 10 Acresbrook: device details before 14:28 BST and system details before 13:53 BST on 16 Oct), the earliest recorded one is used and listed with the result. The `.env` tariff used before the first Octopus sync was not kept, so history before 07:49 BST on 16 Oct can't be reconstructed.
- EV charging is measured only through Octopus smart-charge dispatches. For a car whose smart control is not available it is not measured (the EV page says so); it is still inside the house's use.

## Docker (nginx + the app in one container)

```bash
cp .env.example .env        # fill in your credentials
docker compose up -d --build   # then open http://localhost:8080
# or without compose:
docker build -t energiebee-core .
docker run -d --name energiebee -p 8080:80 --env-file .env -e DATABASE_URL=postgresql://... -v energiebee-data:/app/data energiebee-core
```

- **nginx** serves the website (`public/`) and proxies `/api/` to the Node app, which listens only inside the container (port 4100 is not published).
- **The environment is not baked into the image.** `.env` is excluded by `.dockerignore`; pass it with `--env-file` (or `env_file:` in `docker-compose.yml`). Sync and credentials come from it; `docker-compose.yml` sets `DATABASE_URL` to its own Postgres service.
- **Data persists in two volumes:** `energiebee-pg` (the Postgres database) and `energiebee-data` (raw payloads, logs). The entrypoint applies the migrations before the app starts. Remove both volumes to start fresh.
- Health: `docker ps` shows `healthy` once `/api/status` answers; the first sync after a fresh start can take a minute.
