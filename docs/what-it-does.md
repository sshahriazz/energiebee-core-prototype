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
- Sites never call providers directly. Shared data (prices, carbon) is fetched once per tariff or region and shared by every home that uses it.

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

**A country (once):** a market row, its currency, calendars, tax rules from official sources, region schemes, and a spot-price feed.

**A tariff (when a site selects it):** the catalogue entry is fetched, linked to the site through an agreement, and priced on a daily schedule if it is dynamic. Prices are captured every day because most providers serve only a few days of history.

**Read-through cache:** the build only reads stored prices. If a price is missing, the slot stays unpriced and a fetch is queued. When the price arrives, the affected days rebuild.

## 8. Price sources

The database is ready for any country's tariffs without choosing a provider. Real EU prices need a source only when they start flowing in.

| Source | What it gives | Status |
|---|---|---|
| **Octopus public API** | UK half-hourly and window prices | In use. Every Octopus tariff is stored as GB, in pounds, with its kind and price grain, labelled `provider`. |
| **Tariffscanner (Tariff Tribe)** | UK tariff catalogue: flat rates in pence for 14 regions | UK only. Synced by the eb-auth project, which the core reads so the 20-requests-a-minute limit is not shared. No EU version found. |
| **tounify** | Retail tariffs for EU markets: supplier price, grid fees, taxes | Off. The licence to store its data and serve it to many homes is unconfirmed. It has no standing, fixed or capacity charges, and it serves only a few past days. |
| **ENTSO-E** | Wholesale day-ahead prices per bidding zone | Not connected. Free but needs a registered token. |
| **Manual entry** | Any tariff typed in by hand | Always available as a fallback and for trials. |

Until a source is chosen, France and Netherlands data in tests and demos is synthetic.

## 9. Local meters (future)

Dutch P1 and French Linky readers can stream live readings through an edge agent. They send cumulative index readings, and slot energy is the difference between indexes at slot boundaries. Linky also reports the current tariff period, which fixes French off-peak hours per meter. Consent is recorded per site because live meter data is personal data.

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
- **Country:** add a market row, its tax rules, its region scheme and (if needed) one adapter. No code in the build engine changes.
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

**Built since the first multi-market pass (23 Oct 2026):** capacity charges are priced on a contracted capacity; register windows and calendars are stored as rows and expanded from them, with estimated Tempo days; Octopus tariffs carry currency, country, kind and price grain; the tariff comparison works per market (Octopus products in GB, the other tariffs of the market elsewhere); the pages use the home's slot length and currency in their words; a slot-length change rebuilds only the days with data; and every value carries a provenance label (section 15).

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
5. A background sync runs every 10 minutes. A change to old data queues a rebuild from that day.

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
| `sourced` | Taken from a named, checkable source; the note names it | GB VAT (`src/db/registry.js` `VAT_RATES`: the 5 % domestic rate, and 0 % on electricity from 1 Oct 2026 as observed in Octopus published prices); the GB distribution-region numbering (eb-auth Tariffscanner fixtures and the Octopus / MPAN lists); the GB market row |
| `provider` | Live data fetched from a provider for a real home | Octopus tariffs and rates, Sunsynk and Octopus readings of the live home |
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
