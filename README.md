# EnergieBee core prototype

A working prototype of the EnergieBee unified energy core. It takes data from
each provider, turns it into one trusted half-hour timeline of energy flows and
costs (past, now and forecast), and shows it on six plain HTML pages. You can
trace every number back to the provider payload it came from.

The stack is Node 22, Express and SQLite (Node's built-in `node:sqlite`). Express is the only dependency, and there is no build step.

## Run

```bash
nvm use 22            # Node 22.13 or newer
npm install
npm start             # http://localhost:4100
```

On first start the server creates a **demo home** (unless real credentials are
set), loads 14 days, builds the timeline and then syncs every 10 minutes.
`npm run dev` restarts on file changes. `npm run reset` deletes the database and
the raw payloads.

## Connect a real home

Fill these in `.env` and restart:

| Key | What |
|---|---|
| `SITE_POSTCODE` | Home postcode. Used for the price region, weather, carbon and the solar forecast. |
| `PV_KWP`, `PV_TILT`, `PV_ORIENTATION`, `BATTERY_KWH` | System size. Sunsynk fills `PV_KWP` and battery size if they are left empty. |
| `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD` | Sunsynk Connect login. |
| `OCTOPUS_API_KEY`, `OCTOPUS_ACCOUNT_NUMBER` | Octopus dashboard API key and account number (A-XXXXXXXX). |

The home from `.env` then appears next to the demo home in the home picker.
Each provider is synced on its own. Sunsynk alone gives the energy flows; costs need Octopus, which supplies the tariff and prices.

> Sunsynk's Terms of Use forbid automated scraping of the consumer app. This
> prototype uses the owner's own login at a low rate. A production system needs a
> partner key.

## The demo home

The demo is a simulated house in `DEMO_POSTCODE` (Bristol by default) with 5 kWp of
solar, a 10 kWh battery and an EV. **Prices are the real Agile Octopus and
Outgoing Octopus rates for the region, and sunlight is the real weather there**
(Open-Meteo). Carbon and the Quartz solar forecast are live too.

The generator writes payloads in each provider's own format: Sunsynk day, month
and flow, Octopus half-hourly consumption, and Kraken dispatches. These pass
through the same normalisers as live data. Meter data arrives a day late, as it
does from Octopus, and reads about 1% above the inverter clamp, as real
installations do.

## Pages

| Page | Shows |
|---|---|
| **Home** | Live flow diagram, price now and next 24 h, cost and saving, where the home's energy came from (with the forecast after now), prices, insights |
| **Solar** | Generation split into home, battery and export, the value of solar, forecast against actual, last 30 days |
| **Battery** | Charge level (with forecast), energy in and out by source, stored-energy cost (first in, first out), battery saving, one half-hour costed in full |
| **Grid** | Imports and exports, average price paid against average price, tariffs in force, upcoming prices, smart meter against inverter clamp |
| **EV** | Charging sessions, cost, solar share, smart-charging benefit, planned dispatches |
| **Data & trust** | Connections, sync runs, daily states and checks, evidence for any half-hour (facts, versions, prices, raw payloads), rebuild, source contracts |

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
- **Build engine** (`src/core/build.js`, method `v1-slot-priority`) runs five steps
  for each UTC half-hour:
  1. **Align**: integrate the 5-minute samples and fit them to the inverter's daily counters.
  2. **Reconcile**: the smart meter is used over the clamp when both exist. Home use is calculated from the energy balance.
  3. **Allocate**: split energy into the seven flows (solar to home, battery or grid; battery to home or grid; grid to home or battery).
  4. **Price**: take the rate for each slot, add VAT and the standing charge share, and value battery stock first in, first out.
  5. **Check**: run the balance, meter-against-clamp, counter fit, rate coverage and completeness checks.

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
  adapters/            geo, octopus, sunsynk, carbon, openmeteo, quartz, demo
  jobs/sync.js         per-home sync order and scheduler
public/                six pages, app.css, js/ (api, layout, charts, timeline, pages/)
data/                  core.db and raw/ (git-ignored)
```

## API

`GET /api/sites` · `POST /api/demo` · `POST /api/sites/:id/sync` · `POST /api/sites/:id/rebuild`
`GET /api/sites/:id/` + `now`, `timeline?period=today|yesterday|7d|30d`, `summary?period=`, `forecast`,
`insights`, `ev`, `tariffs`, `evidence?slot=<epoch>`, `health` · `GET /api/raw/:id` · `GET /api/catalog`

## Known limits (prototype)

- One battery strategy is assumed in the forecast. It does not read the inverter's actual work mode.
- Economy 7 switch times are assumed to be 00:30–07:30 GMT, because Octopus does not publish them.
- The Open-Meteo free tier is for non-commercial use; production needs a paid plan.
- Gas is supported in the schema and the build engine, but the demo home has no gas meter.
