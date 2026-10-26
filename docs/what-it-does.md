# EnergieBee core: what the system does and how

## 1. Purpose

One energy core for any home in any country. It collects meter, inverter, tariff and forecast data, builds a trusted timeline of energy flows and costs on a slot length each site chooses, and keeps everything ready for planning and control. Every number traces back to the provider response it came from.

Four things are settings, not code:

| Setting | Examples | Where it lives |
|---|---|---|
| **Country / market** | GB, FR, NL, DE | `market`, `site.market_code` |
| **Currency** | GBP, EUR | `currency`, `site.currency`, `tariff.currency` |
| **Region** | GB distribution areas, bidding zones, distributors | `region`, `region_alias`, `site_region` |
| **Slot length** | 15, 30 or 60 minutes | `site.slot_s` |

## 2. What the system does

### Collect
- Adapters pull from inverters, meters, tariff catalogues, carbon, weather and solar forecasts. Each response is saved raw first.
- Failed requests are retried. After an outage, each provider's next fetch reaches back to its last successful sync, so gaps fill in.
- Sites never call providers directly. A registry per market says which provider fills each kind of data (section 8). Shared data (prices, carbon, gas calorific value) is fetched once per tariff, region or zone in each sync cycle and shared by every home that uses it.

### Keep the truth
- Every fact is stored with its source, the time it applies to, and the time the system learned it.
- A correction is a new version. Nothing is overwritten, so the system can answer "what did we know at this moment?" and rebuild any day as it stood then.
- Facts keep their natural interval: 5-minute readings, 15 or 30-minute prices, daily meter totals.

### Build the timeline
For each slot of each site:
- Solar, grid import and export, battery charge and discharge, home use.
- Who fed whom: solar to home, solar to battery, battery to home, grid to battery, and so on.
- Cost of each flow, standing charges, export income, saving against buying everything from the grid, carbon.
- A state: **final**, **provisional** (meter data still to come) or **missing**.
- A quality flag if the value was split from a longer reading or estimated.

The build is deterministic: the same facts and method version always give the same rows. The serving tables are disposable and are rebuilt from the facts whenever something changes.

### Check itself
Energy balance, meter against inverter clamp, daily counter fit, price coverage and completeness. Failures are shown with their detail, not hidden.

### Forecast
The next 48 hours per slot, from the home's own recent history. Each forecast is stored as an issue and scored against what happened.

### Explain
- A revision log of every day whose figures changed, and why.
- "As known at" rebuilds.
- A link from any number back to the raw provider payload.

### Show
Web pages and a JSON API for the timeline, tariffs, solar, battery, EV, breakdown, data quality and evidence. The pages speak in the home's own slot length and currency ("per quarter-hour", "0c"), and every figure that is not real or not verified says so (section 15). A Connectors page lists every adapter the core has or needs, across all homes, with a status word each (section 8, *The Connectors page*).

### Compare tariffs
The home's own slots re-priced on other tariffs, with the same engine and the same taxes. In GB the alternatives are the Octopus products on sale (Agile import, Agile + Agile Outgoing) for the home's region letter. Elsewhere they are the other tariffs of the home's market held in the database; no Octopus code is ever built for them, and money is in the home's currency.

## 3. Slot rules

- **Allowed lengths:** 15, 30 and 60 minutes. A length must divide an hour, so slot boundaries always line up with local clock times and tariff changes. 45 minutes is not supported.
- **Anchored to local midnight.** Clock-change days work out exactly: 92, 46 or 23 slots on the short day, and 100, 50 or 25 on the long day.
- **Simulation step is 5 minutes**, whatever the slot length. This is the common unit of inverter data and of the future planner.
- **Default slot length** for a site is the finest price interval of its tariff, within the allowed lengths. UK tariffs price in 30 minutes, most EU spot markets in 15.
- **Changing a site's slot length** deletes and rebuilds that site's serving rows from the facts, from its first day with energy data to its last built or data day (today for a live home). A home with three days of data rebuilds those three days, not every day up to today. No data is lost.
- **Each stored row says how long it is** (`dur_s`) and when it starts in local time (`tod_min`), so it can be read without looking up the site.

### Conversion rules
| Case | Rule |
|---|---|
| A price piece covers the whole slot | Use it as is. |
| A slot spans several price pieces | Time-weighted average of the prices. The slot is flagged. A slot with any unpriced part stays unpriced. |
| A price piece is longer than the slot | The slot uses that price. |
| A fixed charge (daily, monthly, yearly) | Spread by slot length over the real length of the local day, month or year, so the slices add up exactly, even on 23 and 25-hour days. |
| An average value (carbon intensity, temperature) | Time-weighted mean, never split like energy. |
| A 30-minute meter reading in 15-minute slots | Split by the inverter clamp's own shape if the clamp covers at least 80% of the interval. Otherwise split by time. The total stays exact. Every split slot is flagged `allocated`. |
| Missing data | Stays missing. It is never invented. |

Time-weighting is exact for the price, but the cost is only exact if usage is even inside the slot. For that reason the slot should not be longer than the tariff's price interval.

## 4. Money and tax

- **Minor units.** Prices are stored in pence or cents per kWh as decimals, because sub-cent rates exist.
- **Currency on everything.** Every tariff and every site has a currency. A tariff in a different currency from its site is rejected. There is no currency conversion, and totals are always grouped by currency.
- **Tax rules replace the single VAT table.** A rule has a country, a code, the fuel and direction it applies to, what it applies to (unit rate, fixed charge or both), a kind and an order:
  - `percent`, for example VAT.
  - `per_kwh`, for example an energy tax.
  - `per_period`, a fixed amount per day, month or year. It can be negative, such as a yearly tax credit.
- Rules apply in order, so VAT is charged on top of an earlier per-kWh tax.
- Every rule is dated, so a rate change never alters past results.
- French and Dutch rule values are placeholders until checked against official sources. They are marked unverified in the data and labelled `placeholder` (section 15).

## 5. Markets and regions

### Market
One row per country or market:
- Country, timezone, currency.
- Price interval, usual meter interval, default slot length.
- Bidding zone where there is one.

Adding a country is adding rows (and, if needed, one adapter). The core code does not change.

### Regions
- A generic region table keyed by scheme and code.
- **Aliases** link different numberings of the same place. For example, one UK distribution area is Octopus letter `C`, MPAN id `12` and Tariffscanner's own id and name (`London`).
- **Carbon regions are a separate scheme** and are never merged with distribution areas, because they divide the country differently.
- A site's regions are versioned, so a move is a new record, not an edit.

### How regions differ by country
| Country | How price depends on place |
|---|---|
| **UK** | 14 distribution regions change the unit and standing rates of the same tariff. |
| **France** | Energy price is national. Off-peak hours are set per meter. Tempo colours apply nationally. |
| **Netherlands** | Spot-indexed prices per bidding zone. Grid charges have no per-kWh part. |
| **Germany** | Wholesale zone plus a grid tariff that differs by grid area. |

## 6. Tariff shapes

A tariff has a `kind`, and its prices are stored as intervals, so any shape fits the same tables.

| Kind | Example |
|---|---|
| `flat` | One unit rate and a standing charge. |
| `tou` | Day/night windows (Economy 7), expanded into dated intervals. |
| `calendar_tou` | France Tempo: a colour per day, with peak and off-peak hours inside it. A colour day runs 06:00 to 06:00. |
| `dynamic` | Half-hourly or quarter-hourly published prices (Agile-style). |
| `spot_indexed` | A formula on a market price. |
| `dispatch` | Slots moved by the supplier (Intelligent Octopus). |
| `market` | A wholesale price series per bidding zone, stored once and shared. |

Supporting rules:
- **Windows are expanded** into concrete intervals for each local day, using the timezone, so clock changes are handled. Windows can cross midnight, repeat on certain weekdays, and be set per tariff or overridden per meter.
- **Windows are stored as data** (`register_window`, with `calendar` and `calendar_day` for Tempo colours) and the price intervals are expanded from the stored rows. A meter's own windows replace the tariff's for that meter.
- **Charge periods:** per kWh, per day, per month, per year, and capacity charges per kW (or kVA) per day, month or year. A capacity charge is priced on the site's contracted capacity (`site.contracted_kva`, with its origin), spread by slot over the real length of the period like any other fixed charge and taxed with them. Without a contracted capacity it is left out and flagged, never guessed.
- **Unknown future days** (such as a Tempo colour beyond tomorrow) are priced with a cautious default the caller gives (for Tempo, the dearest colour) and stored as `estimated`. A slot priced from them is flagged estimated (quality bit, lineage, a day check, the provenance block). When the real colour is published, storing the day again replaces the estimate; the estimate is kept as history.
- **Home-specific prices** override shared ones. Prices that depend on the payment method are only used when unambiguous.

## 7. Onboarding

**A country (once):** a market row, its currency, calendars, tax rules from official sources, region schemes, a spot-price feed, and its `market_provider` rows saying which provider fills each role there (section 8).

**A tariff (when a site selects it):** the catalogue entry is fetched, linked to the site through an agreement, and priced on a daily schedule if it is dynamic. Prices are captured every day because most providers serve only a few days of history.

**Read-through cache:** the build only reads stored prices. If a price is missing, the slot stays unpriced and a fetch is queued. When the price arrives, the affected days rebuild.

## 8. How providers are chosen

Providers are chosen by data, not by code. Which provider fills each kind of data in each market is a row in one table, `market_provider`. The sync job (`src/jobs/sync.js`) keeps no provider list of its own. For each home it builds a plan from those rows (`src/core/providers.js` `plan`) and runs it. Adding a provider to a market takes a row, plus one adapter registered under its code (`src/jobs/steps.js`) if the provider is new. Switching a provider off changes one column.

### Roles a home needs

A home needs up to ten kinds of data, called **roles**. Each role is either **shared** or **per home**:

- A shared role comes from public data. Work that is the same for several homes is done once per sync cycle, however many homes use it.
- A per-home role runs only for a home with its own connection: its supplier account, its inverter.

| Role | What it gives | Usual scope | GB today | FR and NL today |
|---|---|---|---|---|
| `inverter` | Solar, battery and home power from the inverter cloud | per home | `sunsynk` | `sunsynk` (listed once for every market, `'*'`: an inverter does not depend on the country) |
| `location` | Coordinates, outcode and regions from the postcode | shared | `geo` (postcodes.io, Octopus region letter, NESO carbon region) | none |
| `weather` | Hourly weather and sunlight | shared | `open_meteo` | `open_meteo` |
| `carbon` | Grid carbon intensity per carbon region | shared | `neso` | none |
| `meter` | The supplier's meter readings and tariff agreements | per home | `octopus` (the home's account) | `linky` (FR), `p1` (NL): listed, off, adapter not built |
| `gas_cv` | Daily gas calorific value per zone, to turn m³ into kWh | shared | `national_gas`, once the home has a gas meter | none |
| `tariff_prices` | Unit rates and standing charges of the home's tariffs | shared | `octopus` (public rates) | `tounify` (an EU tariff source, not UK; per home, one tounify connection per home): built and switched on, but its licence is unconfirmed, so it is skipped (section 9). `entsoe`: listed, off. `manual` (typed in, per home): on |
| `tariff_catalogue` | The tariffs on sale | shared | `octopus`, read by the comparison step, and `tariffscanner` (the UK catalogue, with the core's own credential, at most once a day; section 9). Both run: catalogues add up | `tounify` (shared, once a week per market): built and switched on, licence unconfirmed, so skipped |
| `compare` | Reference tariffs for the comparison page | shared | `compare` (Agile import and Agile Outgoing for the home's region) | none: the page compares the market's tariffs already held, with nothing to fetch (section 2) |
| `solar_forecast` | 48-hour solar forecast | shared | `quartz`, once panel size, tilt and direction are known | none |

DE, BE and ES list weather only, plus Sunsynk as in every market.

### The registry: `market_provider`

Each row names a market (or `'*'` for every market), a role and an adapter code, with these settings:

- **`priority`.** Lower is tried first. The first usable provider of a role is used, and the others are fallbacks.
- **`enabled`.** `0` means listed but never called, for example when the adapter is not built or a token is missing.
- **`owner`.** The one process allowed to call the provider: `core` or `external`. `external` means another process owns the provider's rate budget, so the core must not call it: the plan skips it with `<adapter> is owned by another process: the core must not call it` (`assertOwner`, which also checks the adapter's own `owner`, so a row cannot override the code). Every seeded row is `core`: the core calls each of its providers itself, Tariffscanner included.
- **`scope`.** `shared` or `home`, as above.
- **`needs_credentials`.** When set, the credentials are checked before the step runs.
- **`licence_confirmed`.** `0` means the right to store and serve the provider's data is unconfirmed, so the provider is skipped even when switched on. One development override exists: with `TOUNIFY_DEV=1` and a tounify **test** token (prefix `tounify_test_sk_`) in `TOUNIFY_API_KEY`, the tounify rows run although unlicensed. The plan entry carries `dev_override`, every row it writes says so in its `origin_note`, and the Connectors card shows it. A production token or any other token never gets the override.
- **`origin`.** The provenance label of what the provider gives (section 15).
- **`note`.** An honest note. It says "adapter not built" wherever that is true.

The rows are seeded from `src/db/seed/providers.js` every time the server starts. The seed refreshes the descriptions. It never changes `enabled` or `licence_confirmed` on a row that already exists, so a switch an operator set stays set. The columns and the full seed list are in `docs/database.md` (*Market provider registry*).

### A home's connections and credentials

The registry says what a market allows. A home's `connection` rows say which per-home providers that home uses, such as its Octopus account or its Sunsynk plant. `POST /api/sites/:id/connections` with `{ provider, role?, credentials? }` adds one. It is refused with HTTP 400 and a readable reason when:

- the home's market does not list the provider;
- the provider is listed but disabled, its licence is unconfirmed, another process owns it, or its adapter is not built;
- the provider is shared or needs no connection;
- the home is a demo home.

For example, connecting `octopus` to a French home gives "octopus is not a provider for market FR; connections allowed for a home in market FR: sunsynk (inverter)".

**tounify registers the home upstream.** `{ provider: "tounify", postal_code?, consumption_tariff, feedin_tariff?, capacity?, metering?, grid_operator? }` goes through the same check (listed for the market in a per-home role, switched on, licensed or on the `TOUNIFY_DEV` override, built, owned by the core), then needs `TOUNIFY_API_KEY` ("no credentials: TOUNIFY_API_KEY not set" otherwise). It then registers (`POST`, or `PATCH` once registered) one tounify connection for the home, with the reference `eb-site-<home id>`. Only the postal code is sent as an address detail. The capacity (`site.contracted_kva`) and the off-peak hours (the meter's own `hc` windows) are taken from the home's data when the market takes those properties. The reply gives the network operator the postal code resolved. The `connection` row keeps the reference and the non-secret applied info (operator id and name, `location_mapped`, tariffs). `removeConnection()` (in `src/adapters/tounify.js`) deletes it upstream, ends the home's tounify agreements at that moment (kept as history) and drops the row; no endpoint calls it yet.

**Credentials stay in the environment, as before the registry.** The core has no secret store yet:

- A connection keeps only the non-secret reference: the Octopus account number or the Sunsynk plant id.
- Keys and passwords are read from `.env` (`OCTOPUS_API_KEY`, `OCTOPUS_ACCOUNT_NUMBER`, `SUNSYNK_USERNAME`, `SUNSYNK_PASSWORD`), and only for the home configured there.
- The reply to a connection request lists the credential fields that were not stored, and never echoes a value.
- Any other home's per-home step is skipped with "no credentials" until a secret store exists.

### What a sync does with it

1. **Plan.** For each role, the core goes through the market's rows and the `'*'` rows by priority. It uses the first provider that is enabled, licensed, owned by the core and built, and, for a per-home role, connected to this home. When the row needs credentials, they must be present.
2. **Shared steps once per key.** The homes of one scheduler tick share one cycle. In that cycle each of these is fetched once:
   - carbon, per carbon region;
   - the calorific value, per gas zone;
   - a tariff's prices, per tariff, when an earlier home's window already covers them;
   - the comparison, per region.

   Weather and solar forecasts are stored for each home separately, but a request identical to one already made in the cycle (same place, same panels) gets the first reply. A shared step that failed is not reused: the next home asks again.
3. **Per-home steps per connection.** The inverter and meter steps run only for a home with that connection.
4. **Each step fails alone.** An error is recorded on its own step and on its connection row. The home's other steps and the other homes still run.
5. **Skipped is not an error.** A provider that is disabled, unlicensed, owned by another process, not built or missing its credentials is recorded in the sync log as skipped, with its reason. For example: `no credentials: OCTOPUS_API_KEY not set (start the server with --env-file=.env)`, or `disabled: adapter not built: …`. Its connection row is marked `skipped`. Before the registry, a sync without the key still called Octopus.

   Three cases are not logged at all: a per-home role the home has no connection for, a fallback that was not needed, and typed-in prices (there is nothing to fetch).

### Empty roles

A role with no provider in a market is valid, not an error. It gets no step in the plan. `/api/sites` reports it as `none`, and the Data & trust page shows "no provider for this market".

For every role, the providers card on that page shows:

- the provider used, and whether it is shared or for this home only;
- the status as a word: ok, error, skipped, disabled or none;
- the origin, and a note with the reason;
- the other providers listed, each with its status.

Tariffs can always be entered by hand (origin `user`), in any market, whether or not a price source exists. Today that is done through the core functions `createTariff` and `putRateRows`, as the demo scripts and tests do. There is no page or API endpoint for typing a tariff in yet.

### What each market gets today

- **GB behaves as before, plus the Tariffscanner catalogue.** It has the same providers, steps and order as before the registry, with one step added:
  1. `sunsynk`
  2. `geo`
  3. `weather`
  4. `carbon`
  5. `octopus`
  6. `gas_cv`, once a gas meter is known
  7. `tariff`, for tariff codes in `.env`
  8. `tariffscanner`, only when `TARIFFSCAN_USERNAME` and `TARIFFSCAN_PASSWORD` are set and a sweep is due (once in a sync cycle, at most once a day; section 9)
  9. `compare`
  10. `solar_forecast`

  The Octopus account is read first only when the home has no postcode. A GB home with no account and no inverter runs only the shared steps. Without the Tariffscanner credential, or when no sweep is due, the `tariffscanner` step is left out and nothing is logged for it (Octopus already serves the role). `test/providers.test.js` and `test/sync-plan.test.js` check this list without that credential, and check that nothing extra appears in the GB home's sync log; `test/tariffscanner.test.js` checks the step with it.
- **FR and NL: weather only.** Weather is the only provider that fetches anything. The Sunsynk inverter can be connected as in any market, though it runs only for the `.env` home until a secret store exists. Prices are typed in (`manual`). These are listed but off:
  - Linky (FR meter) and P1 (NL meter): adapters not built.
  - tounify v3 (retail prices per home, and the catalogue): built and switched on, licence unconfirmed, so skipped and logged as `unlicensed: tounify v3 (preview API): …` (steps `tounify` and `tounify_catalogue`). With `TOUNIFY_DEV=1` and a test token it runs (section 9).
  - ENTSO-E (wholesale prices): adapter not built, needs a registered token.

  Location, carbon, gas calorific value, catalogue, comparison and solar forecast show none.
- **DE, BE and ES:** weather only, plus Sunsynk.

### The Connectors page

`/connectors` (in the navigation as **Connectors**) lists every adapter the core has or needs, one card per adapter code, across all homes and markets. It needs no home and calls no provider: `GET /api/connectors` (`src/core/connectors.js`) works it out at request time from the `market_provider` rows of every market (merged per adapter), the implementations registered (`registerAdapter`) and each home's latest sync. Planned adapters (not built) are listed so gaps are visible; the registry decides what runs.

Each card shows the name and code, what it provides, the markets that list it (a dashed pill when the row is off or unlicensed), shared or per home, whether credentials are needed, built or not, the licence, the origin badge, how many real homes it serves ("1 of 1 connected"), the last success and the last run's steps, the registry note, and two expandable lists: the homes in its markets and its registry rows. The status is always a word on a badge, the first that applies:

| Status | When |
|---|---|
| **Not built** | listed in the registry, no implementation registered; the planned note is the reason (Linky, P1, ENTSO-E) |
| **Disabled** | built, but no row can run: switched off, licence unconfirmed (tounify, labelled "tounify (EU tariffs, v3 preview)", with FR and NL market pills), owned by another process, or listed in no market |
| **Error** | built and switched on, and its latest outcome failed for at least one real home: a failed step in that home's latest sync log, a failing status hook (Tariffscanner's sweep state), or a connection row in error. The error text is shown |
| **Connected** | built and switched on, and its latest outcome is ok for at least one real home (a shared step counts when it ran, or was shared to the home, in its latest sync) |
| **Needs credentials** | built and switched on, needs credentials, and no home has them (no secret store: keys are read from `.env`, for the `.env` home only) |
| **Available** | built and switched on, and nothing has run yet: no home connected, no sync since, or no real home in its markets |

The page orders them problems first (error, needs credentials), then connected, available, disabled and not built. It has summary chips with the count of each status, which also act as a filter, and filters for status, kind of data and market. A connector listed for every market (`'*'`) matches any market. A legend at the bottom explains each word. Demo homes are never synced: each card lists them as "demo" and counts them apart, never as connected. When a connector is connected by its last run but the next sync would skip it, the card says so ("Next sync: no credentials: …"). That happens when the server runs without the credentials in `.env`.

The registry records only whether credentials are needed (yes or no). It does not record what kind (API key, login and password, OAuth, token), so the page does not show one. Nothing on the page or in the API is a credential: no key, password or connection reference is returned, and any secret value from the environment that appears in an error text is replaced by `[redacted]`.

### The Compatibility page

`/compatibility` (in the navigation as **Compatibility**) answers "Is our database ready for Predbat and PredHeat?" with the measured result and the evidence. It needs no home and shows no home's data. `GET /api/compatibility` (`src/core/compatibility.js`) builds it from `docs/coverage-matrix.json` (the 481 catalogue items and the places each maps to), the requirements catalogue (each item's sources and links, the section 1.4 conflicts), `docs/predbat-predheat-coverage.md` (the schema's choice for each conflict) and `docs/database.md` (the documented JSON keys).

- **Checked live.** Every place an item maps to (1,092 of them) and every place and read function of the "how they read" table is looked up in the running database when the API is called: a column by `PRAGMA table_info`, a registry key, metric, source, device action or view by its row, a read function by its module's exports. The check is `src/core/coverage.js`, the same one `test/coverage-matrix.test.js` runs on a fresh database. The result is cached for 60 s. If anything is missing, the headline turns red, says "Live check failed", lists each missing place with its item, and the counts drop (for example "455 of 456"). It also checks that the matrix was built from the catalogue on disk (its SHA-256).
- **What the page shows**, top to bottom: the answer (today "456 of 456 verified data items have a home in the database") with the live-check badge and the limit, "This covers storing and reading the data. The planner itself, device adapters and real heating data are not built."; **how they read data, and where it lives here**: ten ways Predbat and PredHeat read or produce data (daily running totals, prices per slot, solar forecast cases, load history, live sensors, temperatures, settings, the time grid, the plan, commands and read-back), each with the places that hold it, the function that reads it (`planner-read.js` for the facts, `plans.currentPlan` and `commands.lastAcked` for plans and commands) and one sentence on why it fits; **coverage by group** per product, as bars with the counts in words; **explore the evidence**: all 481 items, searchable by id or name and filtered by product, group, status, direction and verified or unverified, 25 per page, each opening to its places (each marked found or missing), its source link, its note and any conflict; the definition of 100 % and the 14 exclusions with their reasons; the 7 conflicts and the 12 unverified items; what is not built; the files behind it.
- **The response**: `generated_at`, `live_check` (`targets_checked`, `targets_missing`, `missing`, `how_missing`, `catalogue_matches_matrix`, `ok`), `definition`, `summary` (`items`, `data_items`, `covered`, `excluded`, `gaps`, `verified_data_items`, `verified_covered`, `unverified_items`, `unverified_covered`, `percent_verified_covered`), `products`, `groups` (id, label in words, product, counts), `items` (id, name, direction, status, `live`, verified, `source`, `source_url`, `targets` each with `exists`, `reason` when excluded, `note`, `conflict`), `how_it_consumes`, `excluded`, `conflicts`, `unverified`, `what_is_not_built`, `source_codes`, `files`, `tests`. No credential and no home's data: the check reads the schema and the registry tables only (`test/compatibility.test.js`).

### What the registry does not do yet

- **No licensed FR or NL adapter.** The Linky, P1 and ENTSO-E rows are placeholders. tounify is built but unlicensed, so nothing is read or priced from it outside the `TOUNIFY_DEV` override.
- **No secret store.** Only the `.env` home has credentials, so another home's account or inverter is listed and connected but skipped.
- **No page or API to change the registry.** Switching a provider on or off, or adding a row, is done in the seed file or in SQL. The only write endpoint is `POST /api/sites/:id/connections`.
- **No page or API for typed-in tariffs** (above).
- **No fallback during a sync.** The fallback is chosen when the plan is built. If the chosen provider fails during a sync, the step is recorded as an error and the next one by priority is not tried. The next sync chooses the same provider again while it stays switched on.

## 9. Price sources and local meters

Each market's price sources are `tariff_prices` rows in the registry (section 8). Adding one takes a row and an adapter, never a change to the sync job. The database is ready for any country's tariffs without choosing a provider, so real EU prices need a source only when they start flowing in.

| Source | What it gives | In the registry | Status |
|---|---|---|---|
| **Octopus public API** | UK half-hourly and window prices, and the list of products on sale | GB `tariff_prices` and `tariff_catalogue`, adapter `octopus`; GB `compare` (reference tariffs priced from the same rates) | In use. Every Octopus tariff is stored as GB, in pounds, with its kind and price grain, labelled `provider`. The home's own tariffs are priced in the meter step (from its Octopus account), or from tariff codes in `.env`. |
| **Tariffscanner (Tariff Tribe)** | UK domestic tariff catalogue (FEA API): unit rates (p/kWh) and standing charges (p/day) per product, region (14), payment method and service type | GB `tariff_catalogue`, adapter `tariffscanner`, priority 20, `needs_credentials = 1`, owner `core`; runs alongside Octopus's catalogue | In use when `TARIFFSCAN_USERNAME` and `TARIFFSCAN_PASSWORD` are set: the core calls it itself (`src/adapters/tariffscanner.js`), at most one sweep per 24 hours, within the 20-requests-a-minute limit (below). Single-rate, day/night and export records are stored; other rate types are skipped and counted. Two things are not verified (below). UK only; no EU version found. |
| **tounify v3 (preview API)** | EU tariff source (not UK): per connection (one per home), the per-kWh series (energy, grid, fees, VAT apart) and every charge that is not per kWh (standing, capacity, metering, credits) | FR and NL only: `tariff_prices` (per home) and `tariff_catalogue` (shared), priority 10, `enabled = 1`, `licence_confirmed = 0`, `needs_credentials = 1`, origin `provider` | **Built, off by default.** The adapter (`src/adapters/tounify.js`) is written and tested against captured answers, but the storage and reuse licence is not confirmed in writing, so the plan skips it. v3 is a preview: field names may change without notice. Billing is per registered connection on a production token. A free test token has tiny limits, which the allowance guard keeps to (below). It serves only a few past days, so each day's series is kept. Not listed for GB (Octopus and Tariffscanner stay the UK sources). Not listed for DE, BE or ES: no answer from them was captured, and whether tounify serves them with data was not checked. |
| **ENTSO-E** | Wholesale day-ahead prices per bidding zone | FR and NL, priority 20, `enabled = 0`, `needs_credentials = 1` | Off. The adapter is not built. Free, but needs a registered token. |
| **Manual entry** | Any tariff typed in by hand | FR and NL, adapter `manual`, priority 90, `enabled = 1`, origin `user` | Available in any market, as a fallback and for trials (`createTariff` with origin `user`). It never runs as a sync step because there is nothing to fetch. Its status is ok once the home has a typed-in tariff ("tariff typed in"), and skipped before that. No page or API yet. |

Until a source is licensed, France and Netherlands prices in the demos are synthetic. The tounify tests price a French and a Dutch home from captured answers.

### tounify v3: how the core calls it (off by default)

The core calls tounify with its own token, `TOUNIFY_API_KEY` in `.env` (`Authorization: Bearer`, base `https://api.tounify.io`). The token is never stored, logged or returned: every error text is cleaned of it. The client:

- **Sends one request at a time, at least 1 s apart.** The earliest next request is persisted in `provider_state.next_allowed_at` (row `tounify`), so a restart cannot burst.
- **Guards a test token's allowance.** A token starting `tounify_test_sk_`, or one with no known prefix, gets defaults of 40 requests a day (UTC), 8 distinct companies, 8 distinct tariffs and 5 new things per endpoint per day. These are set by `TOUNIFY_MAX_REQUESTS_DAY`, `TOUNIFY_MAX_COMPANIES`, `TOUNIFY_MAX_TARIFFS` and `TOUNIFY_MAX_NEW_PER_ENDPOINT_DAY`, and are never above tounify's published 100, 20, 20 and 5. The counters live in `provider_state.state.allowance` and survive restarts. A call that would pass one is refused before it is sent, and the step is skipped with the reason. A production token is not capped unless those variables are set. `tounifyAllowance(db)` and `GET /api/tounify/allowance` show the counters.
- **Stops the run on a 429 or a used-up testing allowance.** A 429 sets the cooldown from `Retry-After` or `rateLimit.resetAt`, at least 60 s. A 429 with neither is a daily limit and lasts until midnight UTC. A 403 with `testingLimit` records the allowance as used up, and new ids are then refused locally. The next homes of the cycle are not called.
- **Reads little.** Each connection gets at most one price read and one components read per UTC day, and never before the answer's `next`. Each market gets one catalogue refresh per 7 days (connection-properties, and under one of the market's connections, the consumption companies and the tariffs of the homes' own companies). Reads send `If-None-Match`, and a 304 is mapped again from the stored raw copy.

**Mapping.** The tariff is `TOUNIFY-<country>-<tariff id>`, provider `tounify`, in the answer's currency. Its kind is `flat` or `tou` for a static tariff (by the catalogue's `time_of_use_rates`, else by the prices in the series) and `dynamic` for a dynamic one. The answer gives no Tempo day colour, so a Tempo series would be stored as a dynamic series. `native_period_s` is `settlement_interval` when given, else the resolution. Prices are asked at the home's slot length with `include=fees,vat` and `historic_days=1`. Each price point becomes a home-specific unit row: **(energy + grid + fees) × 100**, in cents per kWh ex VAT. VAT is never stored as a price. Points that repeat an hourly price at a finer resolution are merged into hourly rows (NL: 96 quarter-hours, 24 rows). Each charge that is not per kWh and has a `resolved` amount becomes a `fixed` row: register `<group>:<kind>` (`grid:capacity`, `consumption:credit`, …), `charge_period` from its interval, **resolved.amount × 100**. Credits stay negative. Capacity is the resolved yearly amount, not the per-kVA rate, with the quantity source in the note. The home's tounify meter is agreed on the tariff, unless another meter already prices it. Rows are labelled `provider`, with the note `tounify v3 (test token): storage licence unconfirmed` for a test token. Writes are idempotent: a change supersedes the stored row, which is kept, and nothing is deleted. Every answer is landed raw. An answer missing an expected field is quarantined (`unexpected shape: …`), and the step fails without stopping the sync.

Checked against the captured answers (`test/tounify.test.js`):

- **Paris, EDF Tarif Bleu HP/HC.** Peak 0.1308 + 0.0171 + 0.03062 EUR = 17.852 c/kWh, off-peak 13.242. Charges per year: supply 5670.0985 c, capacity 6252 c (6 kVA, 62.52 EUR), management 1712 c, metering 2267 c.
- **Amsterdam, Frank Energie dynamic.** 24 hourly levels with grid 0 and fees 0.09161 EUR. Standing 578.5124 c a month, energy-tax credit −51980 c a year, Liander standing 39508 c a year.

**Taxes are not counted twice.** tounify's levies are inside `fees` and its credits are inside the components, while VAT is apart. Such a tariff gets `taxes_in_price = 1` (delta 011). It is set only when every point carries `fees` and the answer states its VAT. For such a tariff, pricing applies only our percent tax rules (VAT) and leaves out our per-kWh levies and per-period credits. The tested French home pays (energy + grid + fees) × 1.20, and the placeholder accise is not added. Every other tariff has `0` and is taxed exactly as before. The VAT rate tounify states (`applied.vat`) is compared with our VAT rule: a mismatch, or no rule, is a warning in the step result, and our rule is never changed.

**Not verified without live calls:**

- POST and PATCH bodies beyond the captured examples: the off-peak hours taken from meter windows, NL capacity, feed-in, `grid_operator`, and whether a POST answer carries an ETag.
- The Tempo answer's shape.
- The feed-in series: it is mapped as the spec describes (energy − fees, export tariff and meter), but no answer has been seen.
- The `historic_days=1` answer.
- Real 304, 429 and 403 bodies and headers, and the `X-Testing-*` headers.
- The meaning of a component's `valid_to`, which is kept in the note but not used as an end.
- Markets other than FR and NL.

### Tariffscanner: how the core calls it

The core queries Tariffscanner with its own credential (`TARIFFSCAN_USERNAME`, `TARIFFSCAN_PASSWORD` in `.env`), read whichever GB home's sync runs the step. Its limit, 20 requests a minute and at least 3 s between two requests, is per credential: anything else using the same credential spends the same budget. So the client:

- **Throttles.** Every request, the token request included, goes through one queue, at least 3 s after the previous one, which also keeps it to 20 a minute at most (`TARIFFSCAN_MIN_REQUEST_INTERVAL_MS` can make the gap longer, never shorter).
- **Keeps its cooldown across restarts.** The earliest moment of the next request is written to `provider_state.next_allowed_at` (row `tariffscanner`) before and after every request, so a restarted server cannot burst. A wait of more than 15 s is never slept inside a sync: a sweep that would have to wait that long is skipped (or, once running, stopped with the error recorded).
- **Stops on a 429.** An HTTP 429 aborts the run and sets the cooldown from its `Retry-After`, at least 60 s.
- **Has a budget.** At most 60 requests per run (`TARIFFSCAN_REQUEST_BUDGET`), the token request counted. Reaching it stops the sweep cleanly at a cursor saved in `provider_state.state`; the next run goes on from there.
- **Sweeps at most once per 24 hours** unless forced. The first sweep reads every active tariff, one Tariffscanner region (id 1 to 14) at a time, in pages of up to 1,000 records. Once a full sweep has completed, later sweeps ask only for what changed since the day before the last complete sweep started (`last_updated_min`).

`forceTariffscannerSweep()` (same module) sweeps now, whatever the daily gate says; the cooldown and the budget still hold, and the registry row must be enabled, licensed and owned by the core. It is a function only: no endpoint or page calls it yet. `GET /api/catalog?tariffs=tariffscanner` (with optional `region`, `limit`, `offset`) lists the tariffs held, with the rate rows in force now; without the parameter `/api/catalog` is unchanged. `scripts/tariffscanner-smoke.js` is a live check outside `npm test`: at most 3 requests (the token, one page of 5), nothing written to `data/core.db`.

Each tariff is one product, service type, rate type, part (electricity import, gas, electricity export) and region, coded `TS-<product_id>-<service>-<rate_type>-<part>-<MPAN id>`, with one rate row per payment method. The region is found from Tariffscanner's region name and id through the region aliases (section 5); a record whose name and id disagree is skipped. For day/night tariffs the stated night hours are stored as register windows but not used for pricing, because a meter's own switch times may differ. A changed price supersedes the stored row (kept as history); nothing is deleted, and a withdrawn tariff is not detected.

**Not verified:**

- **The VAT basis.** The API does not state it. The prices are stored as published, in `price_ex_vat`: they are assumed to exclude VAT, and the core adds VAT from its tax rules. Some values in the saved samples look like a VAT-inclusive price divided by 1.05 (product 329260 in `test/fixtures/tariffscanner/page-2.json`: standing charge 69.49295238095237 = 72.9676 / 1.05, unit rate 29.323999999999998 = 30.7902 / 1.05), which supports the assumption, but Tariffscanner has not confirmed it. If the prices included VAT, the core would add VAT a second time wherever its GB VAT rule is not 0 %.
- **The size of the first sweep.** No full sweep has been measured. The saved samples are three pages of 5 records and the smoke script asks for one page of 5, so how many pages, and so how many runs of 60 requests, the first sweep needs is not known.

### Local meters (planned, not built)

Dutch P1 and French Linky readers would stream live readings through an edge agent. They send cumulative index readings, and slot energy is the difference between indexes at slot boundaries. Linky also reports the current tariff period, which fixes French off-peak hours per meter. Consent will need to be recorded per site, because live meter data is personal data.

Both are listed in the registry as the `meter` provider of their market (`linky` for FR, `p1` for NL), with `enabled = 0`, origin `placeholder` and the note "adapter not built". Neither adapter exists yet, so nothing is read. A request to connect one is refused with that reason, and a French home's sync log records `meter:linky` as skipped: `disabled: adapter not built: …`.

## 10. Dynamic by design: slot, country, currency, region

Nothing in the core knows which country it is in. Everything country-shaped is a row in a table, and everything time-shaped is a setting on the site.

**One home, three markets, same code**

| | UK home | French home | Dutch home |
|---|---|---|---|
| Market | GB | FR | NL |
| Currency | GBP (pence) | EUR (cents) | EUR (cents) |
| Tariff | Agile or Intelligent Octopus, half-hourly prices | HP/HC off-peak windows or Tempo colour days | 15-minute spot-indexed |
| Region | one of 14 distribution areas | national, with a per-meter off-peak window | bidding zone |
| Meter interval | 30 min | 30 min (Linky) | 15 min (P1) |
| Default slot | 30 min | 30 min | 15 min |
| Slots on a clock-change day | 46 or 50 | 46 or 50 | 92 or 100 |

The build engine, the checks, the timeline and the pages run the same way for all three. Only the rows in `market`, `region`, `tax_rule` and `tariff` differ.

**What "dynamic" means in practice**
- **Slot:** change `site.slot_s` and the site's serving rows are rebuilt. Prices, meter data and forecasts of other lengths are converted by the rules in section 3.
- **Country:** add a market row, its tax rules, its region scheme, its provider rows and (if needed) one adapter. No code in the build engine or the sync job changes.
- **Currency:** a tariff and a site carry their currency. Mixed currencies are rejected, never converted.
- **Region:** aliases let one place carry several codes, so a UK area can be matched across Octopus, MPAN and Tariffscanner.
- **Tariff:** a new shape is a new `kind` and some windows or price intervals. The price table is the same.

## 11. Predbat and PredHeat: how they fit

Predbat is an open-source battery planner. It predicts the next 48 hours, simulates the battery under candidate plans, keeps the cheapest, programs the inverter for the window it is in now, and throws the plan away five minutes later to rebuild it from fresh data. PredHeat is the sibling idea for heating: predict heat demand and plan when to heat. The PredHeat description here is from memory and should be checked against its source before building on it.

**The shared pattern** is what makes the dynamic slot matter:

| Level | Size | What lives there |
|---|---|---|
| **Step** | 5 minutes, fixed | Simulation, telemetry, load history, solar forecast |
| **Slot** | the site's `slot_s` (Predbat's default is 30) | Prices, decisions, costs, the timeline |
| **Window** | one or more contiguous slots | What an inverter or heat pump is actually programmed with |
| **Horizon** | 48 hours | One plan |

- A decision is made per slot because energy is priced per slot. Physics runs per 5-minute step because a battery can reach its target part-way through a slot and solar and load move inside it.
- Because the planner only needs "steps per slot" (`slot_s / 300`), a 15, 30 or 60-minute slot all work with the same planner. A 15-minute site just has twice as many slots to search.
- Adjacent slots with the same action merge into one window, because devices accept a few windows, not 96 slots.

**Actions per slot (battery):** `demand`, `charge` (to a target level), `freeze_charge`, `export` (down to a floor, optionally starting part-way into the first slot, always ending on a slot boundary) and `freeze_export`. Switching an action off is a value change, not a structural one.

**What the planner would do each cycle**
1. Take the facts as known now: prices per slot, solar forecast with a pessimistic case, load prediction, live battery charge.
2. Find cheap and expensive windows from the prices, then tune each window's level by re-simulating the horizon.
3. Score each plan as cost, plus a weight on the pessimistic solar case, minus the value of charge left at the end, plus a penalty for dropping below a keep level.
4. Prune slots that do not help, so the device is not programmed needlessly.
5. Send only the current or next window as a desired state, with an expiry, and read the device back to confirm.

**PredHeat in the same frame:** the same step, slot and window levels, with room temperature and the building's heat loss as state instead of battery charge, and heating schedule or set-point actions instead of charge and export.

**How our design supports this without redesign**
- The timeline slot is the same grid the planner plans on, so a plan's predictions can be scored against what the timeline later recorded.
- Facts are versioned, so any plan can be reproduced from the facts known when it was made.
- Plans are stored per device with an action and parameters, so a battery, an EV charger and a heat pump use one table.
- Plans are stored only when they change, and only the executed slot is kept long term.
- Prices are slot-agnostic and country-agnostic, so the same planner optimises a UK Agile tariff, a French Tempo day or a Dutch spot tariff.

### Planner configuration

Everything a battery or heating planner is configured with has one standard name, unit and range, and keeps its history (deltas 020 to 024; `src/core/attributes.js`, `settings.js`, `versions.js`).

| What | Where | Rule |
|---|---|---|
| The installation's figures, for the home or one device | `attribute_def` (141 keys; 21 added by the coverage matrix, `docs/predbat-predheat-coverage.md`), values in `attribute_value` (the four the timeline already reads stay in `site_attribute`) | Battery and inverter (capacity, reserve, charge and discharge limits and curves, losses, export limit, G98/G99, what the inverter can be told to do, write limits, clock skew), solar (arrays with tilt and azimuth), car and charger, immersion, heating (PredHeat's heat loss, cooling rate, static gains, radiator output, water volume, heat source limits, COP and efficiency curves, weather compensation), location. One value per source (installer, measured, provider, estimated); the highest-ranked wins. |
| The planner's tunables for the home | `setting_def` (185: 170 Predbat, 15 PredHeat; 22 added by the coverage matrix), values in `site_setting` | Thresholds, weights, losses, switches, car and iBoost options, schedules, mode. A home that never set a key gets the default, which reads as `sourced` when the requirements catalogue backs it. |
| The kinds of device | `device_kind` (18) | Battery, inverter, meters, car, charger, immersion, diverter, heat pump, boiler, thermostat, radiator valve, sensors, hot water, smart plug: passive or controllable, with their keys and actions. A device of an unknown kind is refused. |
| The home's and tariffs' settings over time | `site_version`, `tariff_version` | Kept by the database on every change (zone, slot length, currency, sizes, capacity; a tariff's structure, kind, currency, taxes-included flag). A day rebuilt "as known at" a moment uses the settings of that moment. |

- **Checked on the way in.** A key with no registry row, a key that does not belong to the home or that kind of device, or a value outside its type, range, list or shape is refused with a message naming the key, the rule and the value.
- **Labelled.** Every value carries a provenance label (section 15): given by whoever writes it, or the one its source implies (an installer's figure is `user`).
- **As known at any moment.** Every change supersedes the previous value, which is kept, so a planner's inputs and a rebuilt day can be reproduced as they stood.
- **Extended by data.** A new key, tunable or kind is one registry row: no migration, no code.
- **Sourced where possible.** Each row names the items of `docs/predbat-predheat-requirements.md` it covers (`refs`). Rows the catalogue does not back are marked unverified and say so, and where Predbat's or PredHeat's docs and code disagree the description keeps both.
- **The GB timeline does not move.** A rebuild "as known at" a moment reads the settings of that moment; for the GB home nothing changed since the golden moment, so its rows are identical (and stay so when its slot length or zone changes later).

### Plans and commands (tables only, no planner yet)

The tables a planner and an executor would write exist (deltas 030 to 032, helpers `src/core/plans.js` and `src/core/commands.js`). Nothing in the core writes to them on its own, and the timeline build never reads them, so the GB timeline is unchanged.

| What | Where | Rule |
|---|---|---|
| What a device kind can be told to do | `device_action` | One row per action, with its parameters and side-effect class. Battery: Predbat's five actions plus `hold`, `pause`, `force_discharge`, `release`. Heating, EV, immersion and hot water have their own. A new action is one row, no code change. |
| What one device can deliver | `device_capability` | A known "no" stops a plan using the action. A command needs a known "yes". |
| A plan | `plan_run` | Scenario (`live`, `shadow`, `baseline`, `twin`, `what_if`), facts cut-off, method version, settings snapshot, metrics. Saved only when its decisions change. A new run, a stale-inputs fallback or an error replaces the current plan, so an old plan never runs on. |
| Its slots | `plan_slot` | Device, slot, action, parameters and predictions. Sparse: a slot on the default action with nothing to say is not stored. The plan has its own grid, any multiple of 5 minutes up to an hour, so a 5-minute plan works for a half-hour home. |
| What it read | `plan_input_ref` | Table, key, hash and "as known at" moment of each input, so the plan can be replayed. |
| How it did | `v_plan_vs_actual`, `plan_score` | Predictions against the timeline, joined on (home, slot start). |
| A command | `command`, `command_log` | Desired state for one device, with an expiry. Written only when it differs from the last state the device confirmed, never sent late, acked only when the read-back matches. Every step is logged and the log cannot be changed. |

Old plan slots: after 7 days only the slots a plan was in force for are kept (`prunePlanSlots`, dry run by default). The ledger's own grid keeps its limit: a home's timeline slot is still 15, 30 or 60 minutes.

**Not built yet:** the planner, device control, PredHeat-style heating prediction, live P1 and Linky readers, the ENTSO-E adapter (tounify v3 is built but unlicensed, so off by default), and a fetcher for published Tempo colours (the calendar is stored and used, but filled by hand or by tests today). The foundation is built so none of them needs a schema redesign.

**Built since the first multi-market pass (23 Oct 2026):** capacity charges are priced on a contracted capacity; register windows and calendars are stored as rows and expanded from them, with estimated Tempo days; Octopus tariffs carry currency, country, kind and price grain; the tariff comparison works per market (Octopus products in GB, the other tariffs of the market elsewhere); the pages use the home's slot length and currency in their words; a slot-length change rebuilds only the days with data; every value carries a provenance label (section 15); and each home's providers are chosen from the market provider registry, with shared steps run once per cycle (section 8).

**Later:** multi-home scale with per-site scoping and a PostgreSQL port.

### Heating data

What the core keeps for heating, so a heating planner has its inputs when one is built. Nothing here controls a heat pump or boiler, and no heating adapter exists yet: the only heating data so far is synthetic (tests), under the generic source `heating_telemetry`.

- **What is measured.** Indoor temperature, set-point, heating on or off, valve opening, heat delivered, heat-pump electricity, boiler gas, flow and return temperatures of a heat pump or a boiler, the flow set-point, radiator water temperature, hot water temperature, the immersion heater (on or off, and its energy). Each is a metric in the registry with its unit and a one-line description; readings belong to the home or to one of its devices (a thermostat, a heat pump), so several sensors or several heat pumps fit without a new column.
- **Weather.** Open-Meteo's single request per sync now also brings humidity, dew point and wind, stored like temperature: the past as facts, the next days as one forecast issue per sync, written only for the hours whose value changed. The outdoor temperature forecast a planner reads was already stored that way.
- **Forecasts as they were known.** Every forecast row now records when the core stored it, besides the provider's own issue time. A plan can be replayed with only the forecasts the core had at that moment, even when a provider's timestamp says otherwise.
- **Solar cases.** Beside the central solar forecast, a pessimistic, a median and an optimistic case for the next 48 hours, from this home's own record of how its output compared with the forecast at each time of day over the last 30 days. Too little history (fewer than 10 comparisons at a time of day) gives no case for that time rather than a guess. Labelled derived. The function exists; the sync does not call it yet.
- **The heating timeline.** `site_heat_slot`: one row per slot of the home's own length (15, 30 or 60 minutes, clock-change days included), built after the battery timeline and only for a home that has heating data. It holds the indoor, set-point and outdoor temperatures, the heating energy and its fuel, heat delivered and the heat pump's COP, heating degree-hours, the share of the slot the heating was on, and the cost of the heating energy at the home's own tariff with its taxes. A slot with no heating data is `missing`; one where a series stops short is `provisional`; it can be rebuilt "as known at" an earlier moment like the battery timeline. The battery timeline is not changed in any way: its table gains no column, and a home without heating data costs one quick check per rebuild.
- **PredHeat.** Its inputs are listed from its source in `docs/predbat-predheat-requirements.md` (PH-*). Still **unverified (from memory)**: that a heating planner would read the heating timeline per slot as laid out here (PredHeat itself reads 5-minute sensor history), and the 15.5 °C degree-hour base, a UK convention that PredHeat does not use.

### Planner read layer

Predbat and PredHeat read arrays (one number per 5-minute step or per slot), not rows. `src/core/planner-read.js` (plan item B10) is the one place a planner reads the facts that way. It only reads: it writes nothing, creates no series, and the timeline build never calls it, so the GB timeline cannot move.

| Function | Returns |
|---|---|
| `series(site, metric, from, to, { stepS, asOf, source, kind })` | One metric resampled to 5-minute steps (or the home's slot with `stepS: 'slot'`) |
| `counterDifferenceSeries(site, metric, from, to, { stepS, asOf })` | Predbat's "today" counters (`load_today`, `pv_today`, `import_today`, `export_today`, battery charge and discharge): energy per step and the counter itself, reset at every local midnight |
| `rates(site, from, to, { stepS, asOf, direction })` | Import, export and gas price per step in minor units including tax, the fixed charges per step and per day, and per step the tariff, register, origin and whether the price is estimated or missing |
| `forecast(site, metric, from, to, { case, stepS, asOf })` | The forecast of record (central, p10, p50 or p90) with the issue that fed each step |
| `loadHistory(site, { daysPrevious, stepS, asOf, excludeMetrics, holidays })`, `predictLoad(history, weights, scaling)` | Each previous day's home use on one local time-of-day axis, then Predbat's `days_previous` weighted mean |
| `state(site, asOf)`, `freshness(site, asOf, limits)` | The latest live inputs with their reading times, and the stale-input gate |
| `window(site, now, { horizonH, slotS })` | The planning frame: plan start, minute offset, first step, the slot and step arrays and the index sums between them |

**How each kind of metric is resampled** (the rule comes from the metric registry, so a new metric needs no code):

| Metric kind | Example | Value of a step |
|---|---|---|
| Power at an instant | solar, load, grid, battery W | Mean power over the part of the step the samples cover. A sample holds until the next one, for at most 5 minutes, which is the timeline's rule. The step's energy is given too. |
| Level at an instant | battery charge %, kWh | The last value whose hold reaches into the step: the level at its end |
| Other instants | temperatures, a 0/1 flag | Time-weighted mean of the held samples. Hourly weather holds for an hour, heating sensors for up to 3 hours. A flag's mean is the share of the step it was on. |
| Energy over a period | meter half-hours, EV dispatches | Split by overlap: a half-hour reading feeds six 5-minute steps a sixth each |
| Mean over a period | carbon intensity, sunlight | Time-weighted, never split |
| Price | unit rates | The price in force is held across the step, time-weighted if the step spans two prices (the timeline's rule) |
| Daily counter | the inverter's daily totals | 5-minute power per step, scaled to the day's total exactly as the timeline does it, with the running total reset at local midnight. 25-hour and 23-hour days included. |

- **As known at any moment.** Every function takes `asOf` (milliseconds) and returns only what the core had recorded by then: a fact stored later is invisible, and one replaced later still shows. Forecasts count from when the core stored each issue. Without `asOf` they read the current versions.
- **Gaps stay empty.** A step no fact covers is `null`, never 0. A partly covered step says how much was covered and is flagged partial. A step taken from a second source (the live reading where the 5-minute series has not arrived yet) is flagged fallback.
- **Load history on the local clock.** Day *n* back is laid out by local clock time, so 17:00 lines up on every day. When the clocks go back, the repeated hour keeps the mean of its two real hours. When they go forward, the missing hour is empty that day. EV dispatches are taken out by default, as Predbat's `car_charging_energy` does, and a heat pump's own meter can be taken out the same way. Holidays can be flagged and left out.
- **Stale-input gate.** `freshness` marks each required input (charge level, battery, grid, solar and load power) as ok, stale or missing. The default limit is 60 minutes, the planning design's figure (catalogue PD-06, unverified: Predbat itself gives none), and a caller can set its own. If any input is not ok, the planner should make a demand-only plan and save it with status `stale_inputs`, with the reason `freshness` gives.
- **Same answers as the timeline.** On the GB home, prices per half-hour equal the timeline's prices exactly, and solar, battery charge and discharge per half-hour equal its figures (tested against a rebuild as known at the golden moment).
- **Bounded and fast.** Every fact read has a lower and an upper time limit from the request, so its cost does not grow with the history. A test with ten times the history shows the same query plans and the same rows read. Delta 050 adds one index so a price read "as known at" an earlier moment no longer scans every rate row; it changes no result. On the GB home, each call for a 48-hour horizon at 5-minute steps takes 0.3 to 9 ms. The slowest is `rates`, which prices each step one at a time, as the timeline does.
- **Not done here.** The planner itself. Predbat's gap filling from load power, its in-day adjustment and its ML load forecast are out of scope. The price read in `loadPricing` (shared with the timeline) is limited only from above (`valid_from < to`), because a price row can be open-ended, so a tariff with years of half-hourly prices reads all of them up to the window.

## 12. How it works

```
Providers -> Adapters -> Facts -> Build engine -> Timeline -> (Planner -> Commands)
 (per market)  raw first   append-only,   per-site slot       scored against the
                           versioned                         timeline
```

1. Adapters fetch from each source and save the raw response.
2. Facts are written as readings (instants) or intervals (energy or prices over a period), each with its source and the time it was learned.
3. The build engine aligns inverter power to the site's slots, reconciles sources, allocates flows, prices them and checks the result.
4. Serving tables hold the timeline for display. They can always be rebuilt.
5. A background sync runs every 10 minutes. Each home runs the plan its market's provider registry gives it (section 8). A change to old data queues a rebuild from that day.

## 13. Stack

Node.js 22, Express and SQLite via `node:sqlite`. No build step and no other dependencies. A PostgreSQL port is planned for multi-home. Run it with `npm start`. Data lives in `data/`. See `docs/architecture-v3.md` for the wider design.

## 14. How to see it work

```sh
node --disable-warning=ExperimentalWarning scripts/demo-multi-market.js
```

The demo builds three **synthetic** homes (all flagged `is_demo`) in a throwaway database (a temp file, deleted at the end). It does not touch `data/core.db` or `.env` and calls no provider. It runs the production build engine on each home and prints the results, with a PASS or FAIL next to each check. It starts with a PROVENANCE section, tags every figure it prints with where it came from (for example `GB night rate 11.5 p x 1.05 [synthetic prices, sourced VAT]`), and ends with a table of every input with its origin and source, and the line "Nothing in this demo is real market data. FR/NL tax values are placeholders." It takes about a second.

| Home | What it shows |
|---|---|
| **GB** (London clock, pounds, 30-minute slots) | Placed in distribution region 16 from its Octopus letter G (also Tariffscanner 7 "Norweb"). Flat tariff on day 1, then day/night. The clocks-back day has 50 half-hours. The 00:30–07:30 night window lasts 8 real hours that day. Standing charge still adds up to one day (57.75 p). Built twice, with taxes from `tax_rule` and from the old `vat_rate` path: the two match row for row. |
| **FR** (Paris clock, euros, 30-minute slots) | HP/HC using the meter's own off-peak hours (02:00–07:00 and 13:00–16:00). The spring-forward day has 46 half-hours and 7 off-peak hours. Then Tempo: the night after a blue day stays blue, and a red day costs 81.68 c/kWh. A monthly subscription is spread by real seconds. A tariff priced in pounds is refused for this home. |
| **NL** (Amsterdam clock, euros, 15-minute slots) | Quarter-hour spot prices, including a negative quarter where the home is paid to import (−7.07 c/kWh). A per-kWh energy tax, a yearly tax credit (fixed charges per day come out negative), and BTW on top. The clocks-back day has 100 quarter-hours. The home is then switched to 30 and 60-minute slots through the real rebuild queue. Every kWh and every fixed charge stays the same. Cost moves only where price and use vary inside a slot, because a longer slot pays the time-weighted mean price. |

It also shows a capacity charge on the French home (flagged while the contracted capacity is unknown, then priced per kVA by real seconds), and Tempo days with no colour yet priced as estimated, then replaced by the published colour.

The FR and NL taxes are **unverified placeholders** from `src/core/tax.js`, not real rates. The tests `test/multi-market.test.js`, `test/provenance.test.js`, `test/capacity.test.js`, `test/register-window.test.js` and `test/compare-market.test.js` run the same checks as assertions, so `npm test` covers the demo.

## 15. Data provenance

Nobody should mistake a stand-in or a generated number for a sourced one. Every value that enters the core carries one label from one vocabulary (`src/core/provenance.js`), the same in the data, the API, the pages, the demo and these docs. Strongest first:

| Label | Meaning | Examples today |
|---|---|---|
| `sourced` | Taken from a named, checkable source; the note names it | GB VAT (`src/db/registry.js` `VAT_RATES`: the 5 % domestic rate, and 0 % on electricity from 1 Oct 2026 as observed in Octopus published prices); the GB distribution-region numbering (the Octopus GSP letters, the MPAN distributor ids, and the Tariffscanner region ids and names as captured in the saved live samples `test/fixtures/tariffscanner/`, which show 10 of the 14 id/name pairs); the GB market row |
| `provider` | Live data fetched from a provider for a real home | Octopus tariffs and rates, Tariffscanner catalogue tariffs and rates, Sunsynk and Octopus readings of the live home; tounify v3 tariffs and rates (note `tounify v3 (test token): storage licence unconfirmed`, plus the `TOUNIFY_DEV` override when used) |
| `user` | Typed in by the user or installer | A tariff entered by hand, a contracted capacity from the bill |
| `derived` | Computed by the core from the above | Every cost and total. A computed figure carries its **weakest** input's label, so this word rarely appears on its own |
| `placeholder` | A stand-in from memory or an assumption, **not verified** against an official source | FR and NL tax values; the FR, NL, DE, BE and ES market rows; "no tax rule for this country, taxes taken as 0"; anything marked `unverified` |
| `synthetic` | Generated test or demo data | Everything the demo and tests generate: readings, spot prices, tariffs, the Tempo calendar, meter hours, capacities |

A value with no recorded label is read as a `placeholder`: nobody vouched for it.

**Where the labels live and appear**
- **Data:** an `origin` (and `origin_note`) column, checked against the vocabulary, on `tax_rule`, `tariff`, `rate_interval`, `market`, `region`, `register_window`, `calendar`, `calendar_day`, and the contracted capacity on `site`. `site.is_demo` marks a generated home: its energy data is `synthetic` and it is never synced.
- **Every priced slot:** its lineage records the weakest origin of the tariff, rate rows, tax rules and capacity that priced it (`origin`), names each placeholder or synthetic input (`placeholder_inputs`, e.g. `tax_rule FR/accise [placeholder]`), and says where its energy data came from (`data_origin`). Labels never change a number.
- **API (additive):** `origin` on homes, tariffs, rates and taxes; a `provenance` block (`worst`, `placeholders`, `demo`, ...) on the summary, timeline, breakdown and timeline-of-everything responses, and per scenario on the comparison.
- **Pages:** a banner on every page for a demo home ("Demo data: values below are synthetic") or a period priced with placeholder inputs ("Contains placeholder values that are not verified"), with the list of inputs; small badges with the word itself (sourced, provider, user, placeholder, synthetic; placeholder and synthetic dashed and marked ⚠) next to tariff names, rates, VAT and taxes on the Tariffs, Grid, Home and Data & trust pages; and a legend of the labels.
- **Demo:** a PROVENANCE section first, a tag on every figure, a closing table of inputs with origin and source.

Today nothing outside GB is verified: every FR or NL figure rests on placeholder taxes, and every demo figure on synthetic data.

## 16. API: Data Explorer

Read-only JSON under `/api/explorer/*` (`src/routes/explorer.js`, mounted by one line in `src/server.js`; logic in `src/core/explorer.js` and `src/core/explain.js`) for exploring every layer of the core: the raw payloads a provider sent, the bitemporal facts, the slot timeline, validation against the sources, how any slot's numbers were calculated, and correlations. All `GET`; `site` is the home id; times are epoch seconds UTC unless named `*_ms`; dates are the home's local `YYYY-MM-DD`. Every answer carries `site` and `generated_at` (the series list, an array, carries them on each item). Bad input is `400 { error }`, an unknown home, slot, series or payload `404 { error }`. Nothing is written, no series is created, and no credential leaves in an answer: request and body keys such as `token`, `password`, `api_key` and URL parameters of those names are replaced by `[redacted]`, and as a last guard no value of a credential held in the environment can appear.

| Endpoint | Answer |
|---|---|
| `overview?site=` | `range {first_date, last_date}`, `slot_s`, `currency`, `series_count`, `sources [{code, series, facts, first_ts, last_ts}]`, `raw {count, bytes, by_source [{source, count, bytes, first_at, last_at, unlinked}]}` (unlinked: payloads no fact or rate row cites, often a re-fetch of values already held), `timeline {slots, final, provisional, missing}`, `checks {pass, warn, fail, skip}` |
| `raw?site=&source=&from=&to=&status=&limit=&cursor=` | `rows [{id, source, fetched_at, status, size, hash, request, facts_linked}]`, `next` (keyset by id, newest first; limit up to 200, default 50; from/to epoch seconds or dates of `fetched_at`) |
| `raw/:id?site=` | `meta`, `body` (text, cut at 200,000 characters with `truncated`), `json_ok`, `facts` (forward lineage: every reading, interval fact, forecast and rate row citing the payload, up to 200, with `total`), `rederive {supported, ok, rederived_count, stored_count, diffs [{key, stored, rederived}]}` |
| `series?site=&q=&source=&metric=` | `[{series_id, subject_kind, subject_id, metric, label, unit, time_role, aggregation, source, first_ts, last_ts, count, superseded_count}]` |
| `facts?series=&from=&to=&as_of_ms=&include_superseded=0\|1&limit=` | `series`, `points [{ts \| start_ts, end_ts, value, quality, recorded_at, superseded_at, raw_id}]`, `stats {n, min, max, mean, gaps, versions}`, `as_of_ms`. Without a window, the latest points; `as_of_ms` shows each fact as the core knew it then (a version recorded later is hidden); forecasts give the latest issue per period |
| `timeline?site=&from=&to=&cols=&limit=` | `slot_s`, `currency`, `cols [{name, unit, kind}]` (kind: energy, money, price, percent, temp, flag, carbon), `rows [{slot_start, local_date, tod_min, state, quality, ...cols}]`, `days` (site_day rows). Default: the last 7 built days |
| `slot?site=&slot=&as_of_ms=` | The calculation trace: `local_time`, `dur_s`, `state`, `quality {value, bits [{bit, name, meaning, why}]}`, `row` (stored), `recomputed`, `matches_stored`, `diffs`, `steps` (inputs, align, reconcile, allocate, price, check: each with `plain_explanation`, `formula`, `inputs`, `intermediates`, `result`), `flows [{from, to, kwh}]`, `price {import, export, standing, gas}` (tariff, register, unit_ex, vat, tax_lines, inc, weighted, pieces), `battery`, `lineage` |
| `validate?site=&slot=` or `&from=&to=` | `checks [{id, group, title, how, source_value, our_value, unit, diff, tolerance, status, evidence {raw_id, series_id, ts, table}, explanation}]`, `summary {pass, warn, fail, skip}`. A range (at most 31 days) aggregates the per-slot checks per day: worst status, counts per status, the worst slot as evidence |
| `correlate?site=&x=&y=&from=&to=&step=slot\|hour\|day&lag=&group=none\|hour\|weekday&limit_points=` | `x`, `y` (`name`, `unit`, `label`), `n`, `pearson`, `r2`, `spearman` (ties share their mean rank), `slope`, `intercept`, `lag`, `points [{t, x, y}]` (evenly downsampled), `by_group [{key, n, pearson}]`, `notes`. Fewer than 8 pairs: `{n, error: 'too few points'}` |
| `heatmap?site=&var=&from=&to=&agg=mean\|sum` | `var`, `unit`, `rows [{date, cells}]` (one cell per local time-of-day slot; the repeated hour when clocks go back adds into its cell), `tod_labels`, `min`, `max` |
| `variables?site=` | The variables `correlate`, `heatmap` and `timeline` take: every site_hh column above (`source: 'timeline'`) and `series:<id>` for each of the home's fact series (`source: 'series'`, resampled by the planner read layer, `src/core/planner-read.js`, as known now) |

**How the slot trace avoids a second copy of the maths.** `buildSite` takes an optional `trace: { slot }` (`src/core/build.js`): a plain object the build fills, for exactly that slot, with the values it computed anyway (the five-minute samples, each node's integrated energy, cover and fit factor, the meter facts and the share of each the slot took, meter vs clamp, balance, measured load, the allocation terms, the price objects, the battery stock before and after the draw, the costs, carbon and forecast). Every trace line only reads; absent, each is skipped. The proof is in the tests: a build with and without a trace is byte-identical on all three synthetic homes (`test/explain.test.js`), the GB golden hash is unchanged (`test/golden-gb.test.js`), and a full dry-run build of the snapshot hashes the same before and after the change. `explain.js` rebuilds the slot's day as a dry run with the trace (from the battery stock stored the day before, as the build does; with `as_of_ms`, from the first day, as every as-of rebuild) and arranges the values into steps. `matches_stored` compares the rebuild with the stored row column by column (numbers within 1e-6; the lineage apart, key by key), so a stale or altered stored timeline shows.

**Validation.** Each check says what it compared and how, with both values and its evidence:
- *source*: `rederive`: the adapter's pure normaliser re-run on the payloads behind the slot (Tariffscanner `mapRecords`, tounify `mapPrices` and `mapComponents`); the other adapters write as they parse (`sunsynk.js` `normaliseDay`, `octopus.js` `normaliseConsumption`, the inline mappings of carbon, Open-Meteo, Quartz and National Gas), so nothing is refactored and they are `skip` with the reason. `source_lookup:<source>`: each fact compared with the value its own payload published, read independently of the adapter by the source contract (Sunsynk day and month series, Octopus consumption, Carbon Intensity periods, Open-Meteo hours, National Gas CSV). `carbon_used` (the intensity stored = the facts for the period), `completeness` (five-minute readings per power series, one fewer allowed at a boundary; seconds of the slot the meter covers).
- *consistency*: `stored_vs_rebuild`, `meter_vs_ct` (slot) and the build's day check, `counter_fit_*` (the inverter's daily counters against the integrated samples, with the counter checked against its payload), `balance_slot` and `balance_day` (in = out + loss), `gas_conversion` (m³ x 1.02264 x calorific value / 3.6), `unit_sanity` (no negative energy; within panel kWp, a 100 A supply and the battery's size).
- *price*: `rate_published` (each rate row the slot used followed through `rate_interval.raw_id` to its payload: price and validity), `rate_used` (the stored rate = its rate rows over the slot, time-weighted, plus per-kWh levies), `tax_rule` (the percentage in force read from `tax_rule` or `vat_rate`), `standing_share` (the day's fixed charges x slot length / day length), `cost_arithmetic`, and the export rate likewise.
- *forecast*: `solar_forecast_record` (the stored forecast = the latest issue made before each period started), `solar_forecast_error` (forecast against the measured solar: a quality figure, not a data fault), `temperature`.

A range opens at most 2.5 MB of payload files not read before per request (payloads are immutable and kept in memory, so asking again goes on); a single slot opens all of its payloads.

**Reads and indexes.** Every read is bounded by the request: site_hh and site_day by their primary keys (home, slot or date range); readings, interval facts and forecasts by `(series_id, time)` primary-key ranges, intervals and forecasts also bounded below by the series' longest fact (`series.max_span_s`); forward lineage and `unlinked` by the `raw_id` indexes of reading, interval_fact, forecast_fact and rate_interval; raw pages by `raw_payload`'s rowid and `raw_payload_site_status`. On a snapshot of the GB home (25 days), each endpoint answers a 7-day range in under 200 ms once warm (validation of 7 days: about 130 to 150 ms; the first range validation after a start reads its payloads from disk and takes about 250 ms); a single slot's trace or validation takes about 15 to 25 ms.
