# How the core handles many countries, regions and currencies

Nothing in the core knows which country it is in. Everything country-shaped is a row in a table, and everything time-shaped is a setting on the home.

## The pieces

| Piece | Table | What it holds |
|---|---|---|
| Market | `market` | Country, time zone, currency, price interval, meter interval, default slot length, bidding zone |
| Currency | `currency`, `site.currency`, `tariff.currency` | GBP and EUR in minor units (pence, cents). A tariff in a different currency from its home is rejected. |
| Regions | `region`, `region_alias`, `site_region` | Every way a country is divided, with aliases between numberings, versioned per home |
| Taxes | `tax_rule` | Ordered rules per country: percent, per kWh, or per period (can be negative) |
| Tariffs | `tariff`, `rate_interval`, windows, calendars | Flat, time-of-use, dynamic, French off-peak and Tempo, fixed and capacity charges |
| Providers | `market_provider` | Which adapter fills which role in which market |
| Slot length | `site.slot_s` | 15, 30 or 60 minutes per home |
| Labels | `origin` columns | sourced, provider, user, placeholder or synthetic |

## Example: three homes, same code

| | UK home | French home | Dutch home |
|---|---|---|---|
| Market | GB | FR | NL |
| Currency | GBP (pence) | EUR (cents) | EUR (cents) |
| Region | One of 14 distribution areas | National, plus the meter's own off-peak hours | Bidding zone |
| Tariff shape | Flat, day/night, half-hourly dynamic | Off-peak windows, Tempo colour days, monthly fee | 15-minute spot-indexed, yearly credit |
| Default slot | 30 min | 30 min | 15 min |
| Slots on the short clock-change day | 46 | 46 | 92 |
| Tax | VAT (sourced) | Placeholder values | Placeholder values |
| Real data source today | Octopus, Sunsynk, Tariffscanner | None, synthetic demo only | None, synthetic demo only |

## Example: one place, several codes

Regions are not one list. A place can carry a code in each scheme, and the core links them with aliases.

| Postcode | Octopus letter | MPAN distributor id | Region name |
|---|---|---|---|
| BB12 | G | 16 | North West England |

- The 14 GB distribution areas exist in three numberings: Octopus letters, MPAN ids and Tariffscanner ids and names. Tariffscanner's numbering is 1 to 14 and is not the MPAN numbering, so it is never assumed equal.
- NESO carbon regions are a separate scheme and are never aliased to distribution areas, because they divide the country differently. The same postcode is in distribution area G and carbon region 3.
- France prices energy nationally, so a French home needs a market and a per-meter off-peak window, not a region price.

## Example: taxes stacked in order

Rules apply in order, so a percent rule is charged on top of earlier ones. Illustrative, with placeholder values:

| Order | Rule | Kind | Effect |
|---|---|---|---|
| 1 | Energy tax | per kWh | Added to the unit price |
| 2 | VAT | percent | Charged on the price including the energy tax |
| 3 | Yearly credit | per period, negative | Spread by slot length over the year |

French and Dutch values are placeholders until checked against official sources. A home with no tax rules for its country is taxed at 0 and labelled placeholder.

## How a home is processed

1. The home's market sets the clock, currency, default slot and bidding zone.
2. The registry lists the providers for that market. Roles with no provider are shown as empty.
3. Fetched data is stored as facts with their original units, then converted to minor units.
4. The build prices each slot with the tariff in force and the market's tax rules, in the home's currency.
5. Every figure carries its origin, so placeholder and synthetic values are always visible.

## Adding a country

1. Add a `market` row: time zone, currency, price and meter intervals, default slot, bidding zone.
2. Add its tax rules from official sources, with dates.
3. Add its region schemes and aliases.
4. Add its calendars if the tariffs need them (for example French Tempo colours).
5. Add `market_provider` rows for each role, switched on only when the adapter exists and the licence is confirmed.
6. Write adapters for what is missing: a price source, a meter reader, a carbon feed.

Steps 1 to 5 are data. Only step 6 is code, and each adapter is a contained job that writes into the existing tables.

## What is not done

- No real data source for France or the Netherlands yet. Linky, P1, ENTSO-E and tounify are listed but off.
- French and Dutch taxes are unverified placeholders.
- Only GB has regions and a catalogue in the database. Other countries are stand-in rows.
- Dutch net metering ends on 1 January 2027, so per-slot export prices for 2026 are not modelled.

See `docs/what-it-does.md` for how providers are chosen and `docs/capabilities-and-roadmap.md` for the remaining work.
