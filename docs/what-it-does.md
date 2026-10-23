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
Web pages and a JSON API for the timeline, tariffs, solar, battery, EV, breakdown, data quality and evidence. The pages speak in the home's own slot length and currency ("per quarter-hour", "0c"), and every figure that is not real or not verified says so (section 15).

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
| `tariff_prices` | Unit rates and standing charges of the home's tariffs | shared | `octopus` (public rates) | `tounify` and `entsoe`: listed, off. `manual` (typed in, per home): on |
| `tariff_catalogue` | The tariffs on sale | shared | `octopus`, read by the comparison step, and `tariffscanner` (the UK catalogue, with the core's own credential, at most once a day; section 9). Both run: catalogues add up | none |
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
- **`licence_confirmed`.** `0` means the right to store and serve the provider's data is unconfirmed, so the provider is skipped even when switched on.
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
  - tounify (retail prices): adapter not built, licence unconfirmed.
  - ENTSO-E (wholesale prices): adapter not built, needs a registered token.

  Location, carbon, gas calorific value, catalogue, comparison and solar forecast show none.
- **DE, BE and ES:** weather only, plus Sunsynk.

### What the registry does not do yet

- **No FR or NL adapters.** The Linky, P1, tounify and ENTSO-E rows are placeholders, so nothing is read or priced from them.
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
| **tounify** | Retail tariffs for EU markets: supplier price, grid fees, taxes | FR and NL, priority 10, `enabled = 0`, `licence_confirmed = 0` | Off. The adapter is not built, and the licence to store its data and serve it to many homes is unconfirmed. It has no standing, fixed or capacity charges, and serves only a few past days. |
| **ENTSO-E** | Wholesale day-ahead prices per bidding zone | FR and NL, priority 20, `enabled = 0`, `needs_credentials = 1` | Off. The adapter is not built. Free, but needs a registered token. |
| **Manual entry** | Any tariff typed in by hand | FR and NL, adapter `manual`, priority 90, `enabled = 1`, origin `user` | Available in any market, as a fallback and for trials (`createTariff` with origin `user`). It never runs as a sync step because there is nothing to fetch. Its status is ok once the home has a typed-in tariff ("tariff typed in"), and skipped before that. No page or API yet. |

Until a source is built, France and Netherlands prices in tests and demos are synthetic.

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

**Not built yet:** the planner, device control, PredHeat-style heating prediction, live P1 and Linky readers, the tounify and ENTSO-E adapters, and a fetcher for published Tempo colours (the calendar is stored and used, but filled by hand or by tests today). The foundation is built so none of them needs a schema redesign.

**Built since the first multi-market pass (23 Oct 2026):** capacity charges are priced on a contracted capacity; register windows and calendars are stored as rows and expanded from them, with estimated Tempo days; Octopus tariffs carry currency, country, kind and price grain; the tariff comparison works per market (Octopus products in GB, the other tariffs of the market elsewhere); the pages use the home's slot length and currency in their words; a slot-length change rebuilds only the days with data; every value carries a provenance label (section 15); and each home's providers are chosen from the market provider registry, with shared steps run once per cycle (section 8).

**Later:** multi-home scale with per-site scoping and a PostgreSQL port.

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
| `provider` | Live data fetched from a provider for a real home | Octopus tariffs and rates, Tariffscanner catalogue tariffs and rates, Sunsynk and Octopus readings of the live home |
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
