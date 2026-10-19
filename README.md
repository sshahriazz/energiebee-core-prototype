For a fresh installation that fetches real Sunsynk and Octopus data, follow [the demo setup guide](docs/DEMO-SETUP.md). Use `npm start` for provider sync; `npm run demo` below is the separate frozen-snapshot option.

The demo also includes `/how-it-works`, a plain-language guide to the recorded-data process. Timeline intervals include sources, coverage, expanded calculations, allocations, method and evidence links.

# Focused energy demo (`demo/core-energy`)

This branch presents three screens: **Overview → Timeline → Evidence**. It keeps
one selected home and date throughout the journey. Forecasts, prices, savings,
EV-specific views and operational controls are outside the visible demo.
The original ten-screen UI remains in `public/` and on `main`; this branch serves
only `public/demo/`.

```bash
npm run demo
# Open http://localhost:4102
```

The first run makes a consistent snapshot of `data/core.db` in `data/demo/core.db`.
It reuses that snapshot on later runs and links the original immutable raw-payload
files for evidence inspection. No provider credentials or live sync are used by
this command. Keep the source raw files available. With no source database, the
app opens in a genuine empty state; it does not invent demo readings.

For a fresh snapshot, stop the demo and choose a new directory:

```bash
DEMO_DATA_DIR=/tmp/energiebee-new-demo npm run demo
```

`DEMO_PORT` changes the preview port. `DB_FILE` chooses a different source database.
`npm start` still uses `.env` and the normal provider scheduler, but serves the
three-screen UI on this branch. Avoid starting it on a port already in use.

The default date is the most recent closed day with all expected half-hours final,
falling back to the most recent completed day and then the latest available day.
A local day can contain 46, 48 or 50 slots. The date picker can select provisional
and current days. Finality is separate from energy-check results.

Demo values use the stored core calculations, with current five-minute source
coverage checked before display. Unobserved measurements stay null; observed
zeros remain zero. Missing required inputs withhold dependent allocations.
Partial totals sum only available values and say so. The snapshot capture time
is shown, and the snapshot clock is fixed so elapsed-slot coverage is repeatable. Elapsed slots missing from
the build are explicitly represented as missing. All three screens use the same
presentation rows. This is a focused prototype, not a certified meter or a new
thermal/HEM implementation.

The demo uses native semantic controls, tables and dialogs in the existing plain
HTML/JS stack. Official shadcn registry/docs were consulted for those primitives;
React components were not introduced into this no-build application. Existing
EnergieBee palette and Technext attribution are retained. The design-taste skill
excludes dashboards from its marketing-page workflow; rendered review covers
this application at desktop, tablet and phone widths instead.

Run `npm test` for the existing core tests and demo regressions. The regression
suite covers missing-vs-zero readings, dependent allocations, default dates,
partial totals, sensor coverage, and daylight-saving days.

Browser regression checks (with `npm run demo` running in another terminal):

```bash
python3 -m venv /tmp/energiebee-demo-tools
/tmp/energiebee-demo-tools/bin/pip install playwright
/tmp/energiebee-demo-tools/bin/python scripts/check-demo.py
```

The browser check uses installed Google Chrome on macOS; override `CHROME_BIN`
for another location and `DEMO_URL` for a different port. It expects a populated
snapshot with a completed day and a provisional day. It checks all three screens
at 1440, 768 and 390 pixels, date preservation, chart-to-evidence navigation,
raw-response dialogs, per-day totals, excluded routes, read-only API behavior,
empty states, and recovery after API errors. It writes review screenshots to
`/tmp/energiebee-demo-review`. Browser response overrides only simulate failures
in that test browser; they do not modify the server's recorded data.

---

# EnergieBee core prototype

A working prototype of the EnergieBee unified energy core. It takes data from
each provider, turns it into one trusted half-hour timeline of energy flows and
costs (past, now and forecast), and shows it on ten plain HTML pages. You can
trace every number back to the provider payload it came from.

The stack is Node 22, Express and SQLite (Node's built-in `node:sqlite`). Express is the only dependency, and there is no build step.

## What you need

- **Node.js 22.13 or newer** (it uses Node's built-in SQLite, `node:sqlite`). Check with `node -v`.
- **npm** (comes with Node).
- **Internet access** to the providers: Sunsynk, Octopus, National Gas, NESO, Open-Meteo, Quartz and postcodes.io.
- **The home's credentials** in `.env` (see the next section):
  - **Sunsynk:** the Sunsynk Connect login, plus the plant id if the login sees more than one plant.
  - **Octopus:** an API key from the Octopus dashboard (Personal details → API access) and the account number.
- Optional: the installer's panel size, tilt and direction and battery size, if you have them.

No other database or service is needed; everything is stored in `data/`.

## Run

```bash
cd energiebee-core-prototype
nvm use 22                 # or any Node 22.13+
npm install                # installs Express, the only dependency
cp .env.example .env       # then fill in the values (next section)
npm start                  # open http://localhost:4100
```

- **First start:** the server creates the home from `.env`, loads 14 days of history and builds the timeline. This takes up to about a minute; until it finishes the pages show a "Loading data from the providers…" banner.
- **After that:** it syncs every 10 minutes (`SYNC_EVERY_MINUTES`). The **Sync** button on any page syncs immediately.
- **`npm run dev`:** restarts the server when a file changes.
- **`npm run reset`:** deletes the database and the stored raw payloads, so the next start begins from scratch.
- **Port and file location:** `PORT` (default 4100) and `DB_FILE` (default `data/core.db`) in `.env`.
- **To stop:** Ctrl+C in the terminal running it.

### Running it unattended

| Command | What it does |
|---|---|
| `npm run serve` | Runs the server under a supervisor (`scripts/supervise.js`). The supervisor restarts the server if it exits (1 s, 2 s, 4 s … up to 60 s apart), and also if it stops answering `/api/status` three minutes in a row. Output goes to `data/logs/server.log`, rotated at 10 MB. |
| `npm run service:install` | macOS only. Installs the supervisor as a login service (launchd), so it starts when you log in and after a reboot. Run `nvm use 22` first; the service uses that Node. |
| `npm run service:status` / `service:uninstall` | Shows whether the service is loaded, with the last log lines / removes it. |
| `npm run history:reconstruct` | One-off: fills the revision log for the time before it was kept by rebuilding each completed day as known at every earlier sync. Writes only to `site_day_revision`; `-- --force` redoes it. |

What happens when something fails:
- **A provider is down or slow:** each request is retried twice (after 1 s and 4 s, or as long as the provider's Retry-After asks). Only network errors, timeouts, 429 and 5xx are retried; a 401 (bad key) fails at once. A step that still fails is recorded, and the other providers carry on.
- **The server or a provider was down for a while:** each provider's next fetch reaches back to its last successful sync, less a day of overlap, so the gap is filled in. How far back it reaches: Sunsynk 89 days and Open-Meteo 92 (the most each provider serves), NESO carbon 60 and Octopus 365 (limits set here to keep one catch-up sync reasonable).
- **A sync was cut short:** it is marked `interrupted` at the next start. Facts are saved step by step, and the next sync fetches the same window again.

### Tests

```bash
npm test
```

44 tests, about 2 seconds, using Node's built-in test runner. Each test file uses its own throwaway database, so `data/core.db` is never changed.
- **Unit tests:** HTTP retry rules (against a local server), clock changes, Sunsynk's repeated and missing hour, and resuming after an outage.
- **Integration tests** (on a copy of `data/core.db`; skipped if there is none):
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
- **Build engine** (`src/core/build.js`, method `v3-stock-follows-charge`) runs five steps
  for each UTC half-hour:
  1. **Align**: integrate the 5-minute samples and fit them to the inverter's daily counters.
  2. **Reconcile**: the smart meter is used over the clamp when both exist. Home use is calculated from the energy balance.
  3. **Allocate**: split energy into the seven flows (solar to home, battery or grid; battery to home or grid; grid to home or battery).
  4. **Price**: take the rate for each slot, add VAT and the standing charge share, and value battery stock first in, first out.
  5. **Check**: run the balance, meter-against-clamp, counter fit, rate coverage and completeness checks.

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
  db/                  schema.sql, registry (sources + contracts, metrics, VAT), db.js
  core/                time, facts, pricing, build, forecast, insights
  adapters/            geo, octopus, sunsynk, carbon, openmeteo, quartz
  jobs/sync.js         per-home sync order and scheduler
public/                six pages, app.css, js/ (api, layout, charts, timeline, pages/)
data/                  core.db and raw/ (git-ignored)
```

## API

`GET /api/sites` · `POST /api/sites/:id/sync` · `POST /api/sites/:id/rebuild`
`GET /api/sites/:id/` + `now`, `timeline?period=today|yesterday|7d|30d`, `summary?period=`, `forecast`, `solar-expected?period=`,
`insights`, `ev`, `tariffs`, `evidence?slot=<epoch>`, `health`, `system`,
`trust?period=` (coverage, cross-checks, balance, revisions, corrections), `revisions?date=|period=`, `asof?date=YYYY-MM-DD&at=<epoch>` (a day rebuilt as known then; nothing written) · `GET /api/status` · `GET /api/raw/:id` · `GET /api/catalog`

## Known limits (prototype)

- One battery strategy is assumed in the forecast. It does not read the inverter's actual work mode.
- Economy 7 is not priced, because no source gives its switch times.
- The Open-Meteo free tier is for non-commercial use; production needs a paid plan.
- Gas is converted from m³ with National Gas's daily calorific value for the home's LDZ; gas days without a published value wait (check `gas_calorific_value`).
- Panel tilt and direction are estimates until the installer's figures are entered (see "Your system's details" above).
- "As known at" rebuilds read facts, prices, tariff agreements, meters, device details and system details as they were then. Where no version existed yet at that moment (for 10 Acresbrook: device details before 14:28 BST and system details before 13:53 BST on 16 Oct), the earliest recorded one is used and listed with the result. The `.env` tariff used before the first Octopus sync was not kept, so history before 07:49 BST on 16 Oct can't be reconstructed.
- EV charging is measured only through Octopus smart-charge dispatches. For a car whose smart control is not available it is not measured (the EV page says so); it is still inside the house's use.
