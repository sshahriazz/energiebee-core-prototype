# Capabilities and roadmap

What the system supports today, what it does not, and the work that remains, including the Predbat and PredHeat-style planning we discussed.

Status labels used below: **Done** (built and tested), **Foundation** (the database and rules are ready, the adapters or logic are not), **Not started**, **Needs a decision**.

## 1. The honest summary

The database and build engine are ready for any country, currency, region, slot length and the common tariff shapes. That is not the same as supporting any provider, home or country.

- A **provider** is supported only when its adapter is written and tested.
- A **country** works only when it has a market row, verified tax rules and at least one price source.
- A **home** works at scale only after per-site scoping and a PostgreSQL port.

Today one setup is proven with real data: a UK home with a Sunsynk inverter and an Octopus account. France and the Netherlands exist only as synthetic demo homes.

## 2. What works today

| Area | Status | Notes |
|---|---|---|
| Per-site slot length (15, 30, 60 minutes) | Done | GB output is identical at 30 minutes (golden test). 45 minutes is deliberately not supported. |
| Currency in minor units (pence, cents) with a currency on every tariff and site | Done | Mixed currencies are rejected. No conversion. |
| Markets, regions, region aliases | Done | 14 GB distribution regions in three numberings. Other countries are placeholders. |
| Ordered tax rules, including per-period and negative amounts | Done | GB VAT is sourced. FR and NL values are unverified placeholders. |
| Tariff shapes: flat, time-of-use windows, dynamic, French HP/HC and Tempo, monthly and yearly fixed charges, capacity charges | Done | Tested on clock-change days. |
| Estimated Tempo days and per-meter off-peak windows | Done | Estimated days are flagged. |
| Provenance labels (sourced, provider, user, placeholder, synthetic, derived) | Done | In the database, lineage, API and pages. |
| Build engine, checks, forecast, revision log, "as known at" rebuilds | Done | Single home, UK providers. |
| Provider registry per market, driven sync | In progress | At the time of writing, being built and not yet verified. |
| Synthetic multi-market demo | Done | `scripts/demo-multi-market.js` and `scripts/demo-ui.js`. |

## 3. What does not work yet

### Providers
| Gap | Why | Work |
|---|---|---|
| Other inverters (Solis, Fox, Huawei, SolarEdge, GivEnergy and so on) | Only Sunsynk has an adapter | One adapter and test set per vendor |
| UK suppliers other than Octopus | Meter and tariff data come through Octopus's API | Adapter per supplier, if it offers an API |
| French Linky meter reader | Design only | Local reader on an edge agent, cumulative index handling, consent per site |
| Dutch P1 meter reader | Design only | Same pattern as Linky |
| EU tariff and price source | No licensed source connected | Choose and license one, then write its adapter |
| UK carbon outside GB | NESO covers GB only | EU carbon source per country |

### Countries
| Gap | Work |
|---|---|
| Verified French and Dutch tax rules | Check each value against official sources and clear the `unverified` flag. Dutch energy tax has usage bands. France splits VAT between subscription and energy. |
| Other countries (DE, BE, ES, and so on) | Market row, tax rules, region scheme, price source, calendars |
| Dutch net metering | Runs until 1 January 2027, so per-slot export prices are wrong for the Netherlands in 2026. Model annual netting, or start NL on 2027 rules. |
| Tempo colours beyond tomorrow | Currently priced cautiously and flagged estimated. Needs a colour feed. |

### Tariffs
Unusual structures (seasonal demand ratchets, block tariffs, supplier-specific bundles) each need a new tariff kind and pricing rules.

### Scale
The core is built for one home at a time. Many homes need per-site scoping on the fact tables, monthly partitions, a PostgreSQL port, parallel sync workers and retention rules per table.

## 4. Price sources and open decisions

| Source | What it gives | Blocker | Decision needed |
|---|---|---|---|
| **Octopus public API** | UK prices and meter data | None | In use |
| **Tariffscanner (Tariff Tribe)** | UK tariff catalogue only, 14 regions, flat rates | UK only. Synced by the eb-auth project, which owns the 20-requests-a-minute limit | Confirm with the Tariffscanner team whether an EU product exists |
| **tounify** | EU retail tariffs: supplier price, grid fees, taxes | Storage and reuse licence is unconfirmed. No standing, fixed or capacity charges. Serves only a few past days, so daily capture is mandatory | Get the licence terms in writing before building daily capture |
| **ENTSO-E** | Wholesale day-ahead prices per bidding zone | Needs a registered token | Register for a token |
| **Manual entry** | Any tariff typed by hand | None | Always available as a fallback |

Rules for any new source: every adapter converts to minor units on the way in, records its origin, and writes into the existing tables. The schema does not change.

## 5. Planning and control (Predbat and PredHeat)

None of this is built. The foundation is designed so none of it needs a schema redesign.

### What Predbat is
Predbat is an open-source battery planner. Every five minutes it predicts the next 48 hours, simulates the battery under candidate plans, keeps the cheapest, programs the inverter for the window it is in now, and discards the plan to rebuild it from fresh data. PredHeat is the sibling idea for heating. The PredHeat description here is from memory and must be checked against its source before building on it.

### The shared model
| Level | Size | What lives there |
|---|---|---|
| Step | 5 minutes, fixed | Simulation, telemetry, load history, solar forecast |
| Slot | The site's `slot_s` | Prices, decisions, costs, the timeline |
| Window | One or more contiguous slots | What an inverter or heat pump is programmed with |
| Horizon | 48 hours | One plan |

### Remaining work
| Item | Status | What it involves |
|---|---|---|
| Plan tables: `plan_run`, device-generic `plan_slot` (device, slot, action, params), sparse and written only on change | Foundation | Tables and the freshness gate. Record the facts cut-off time and method version so a plan can be replayed. |
| Simulator: 5-minute battery physics for demand, charge, freeze charge, export, freeze export, with efficiency, reserve, rate limits and export limits | Not started | A pure function with no database access. |
| Optimiser: threshold windows from prices, tune levels, export start offsets, freezes, prune dead slots | Not started | Deterministic and bounded. Metric: cost, plus a weight on the pessimistic solar case, minus the value of charge left at the horizon, plus a keep-level penalty. |
| Load prediction | Not started | History-based, same weekday and season, bounded windows only. |
| Solar forecast with pessimistic and central cases | Foundation | Forecast issues are stored. The pessimistic case needs a source. |
| Scoring: store each plan's predictions as a forecast source and compare with the timeline | Foundation | The existing accuracy scoring would do the comparison. |
| Shadow mode | Not started | Plan and score for at least two weeks with no commands sent. This is what proves it beats doing nothing. |
| Command path: desired state, diff against reported state, write only on change, read-back, expiry on every command | Not started | A stale command is dropped, never applied late. |
| Vendor capability flags: freeze, export and write limits per device | Not started | Never plan an action a device cannot deliver. |
| PredHeat-style heating: heat demand prediction, thermal state, set-point or schedule actions | Not started | Needs real heat-pump data first. Only manufacturer-sanctioned interfaces. Frost protection verified at provisioning. |
| EV charging and smart-charge slots | Not started | Treat dispatch slots as unconfirmed until the car is actually charging. |

### Why the slot design matters for the planner
- The planner needs only steps per slot (`slot_s / 300`), so 15, 30 and 60-minute slots all work with the same code.
- Prices are slot-agnostic and country-agnostic, so the same planner can optimise a UK Agile tariff, a French Tempo day or a Dutch spot tariff.
- A slot longer than the tariff's price interval makes decisions coarser than price changes. The default slot is therefore the finest price interval.

## 6. Quality gaps in what already exists

| Item | Note |
|---|---|
| GB VAT at 0% for electricity from 1 October 2026 was read off Octopus prices, not HMRC | Labelled sourced with a note saying how it was obtained. Verify. |
| Carbon is fetched once per site, not once per region | Wasteful for many homes. |
| `compare.js` covers Octopus tariffs only | It is market-aware in structure but has only GB data. |
| Raw readings have no origin column | Their label comes from the site's demo flag. |
| Contracted capacity is not versioned | A change is not kept as history. |
| Capacity charges reuse day, month and year periods | New per-kW periods are not added. |
| Several UI strings and API key names still say "half-hour" | Names are kept so responses keep their shape. |

## 7. Suggested order

1. **Verify before relying:** check the FR and NL tax values, the GB 0% VAT claim, the tounify licence and the PredHeat description.
2. **Choose and license one EU price source,** then write its adapter.
3. **Write the first non-UK meter reader** (Linky or P1), with consent per site.
4. **Add inverters on demand,** one adapter per vendor, driven by real customers.
5. **Build the planner in shadow mode** and run it for at least two weeks on real data.
6. **Add the command path** once the shadow results justify it.
7. **Heating and EV** after real data exists for them.
8. **Multi-home scale** when the number of homes needs it.

## 8. Rough effort

These are estimates, not measurements. Real-world blockers (licences, tokens, device access, and the weeks of data the planner needs) matter more than coding time.

| Piece | Estimate |
|---|---|
| Verify tax values and licences | Days, mostly waiting on others |
| One EU price adapter | About 1 week once a source is licensed |
| One meter reader (Linky or P1) | 1–2 weeks |
| One inverter adapter | 3–5 days each |
| Planner in shadow mode | 2–3 weeks to build, plus at least 2 weeks of real data to judge |
| Command path and control | 3–6 weeks, plus device testing |
| Heating | 1–2 months, and only once real heat-pump data exists |
| Multi-home scale | 3–6 weeks |
