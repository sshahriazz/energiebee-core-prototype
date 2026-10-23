# Prototype scorecard: where the core stands and how to reach 10/10

This is an honest rating of the core as a **prototype**. A 10/10 prototype is not a finished product. It proves every claim made about the system with real data and no unverified stand-ins.

Scores are the author's judgement from the code, the tests and the demos at the time of writing. They are not measurements. The scores should be re-done after each batch of work below.

## What the core does, in steps

The core turns raw readings and prices from a home into a trusted record of what happened and what it cost.

1. **Connect.** Each home has a market (country) and a set of providers: an inverter, a meter or supplier account, and shared feeds such as weather and carbon. The provider registry says which providers apply in that market.
2. **Fetch.** A sync runs every 10 minutes. It asks each provider for new data. Shared data such as prices and carbon is fetched once for all homes. A provider that fails or has no credentials is skipped with a reason, and the others carry on.
3. **Save the original.** Every response is stored as received, so any number can be traced back to it.
4. **Record facts.** The data becomes facts: readings at an instant, and amounts or prices over a period. Each fact keeps its source and when it was learned. A correction is a new version, never an overwrite.
5. **Build the timeline.** For each slot (15, 30 or 60 minutes, chosen per home) the core lines up solar, grid, battery and home use. It works out who supplied whom, using the meter first and the inverter as a fallback.
6. **Price it.** Each slot is priced from the home's tariff: rates, tax, standing and fixed charges, and off-peak windows. The result is the cost, the saving against buying everything from the grid, and the carbon.
7. **Check it.** Built-in checks compare the meter with the inverter, test the energy balance, and look for missing prices. Each slot is marked final, provisional or missing.
8. **Label it.** Every figure carries where it came from: sourced, provider, user, placeholder or synthetic.
9. **Show it.** Web pages and a JSON API show the timeline, tariffs, solar, battery, EV, breakdown and data quality. Any day can be rebuilt as the core knew it at an earlier moment.

What it does not do yet: plan or control anything, or serve many homes at once.

## 1. Overall

| View | Score |
|---|---|
| As a prototype foundation | **6.5 / 10** |
| As a product | **3 / 10** |

## 2. Score by area

| Area | Score | Why |
|---|---|---|
| Data model | 8.5 | Versioned facts with provenance, disposable serving tables, and a database ready for any slot length, country, currency, region and common tariff shape. The strongest part. |
| Correctness for the UK home | 8 | Deterministic build, balance and meter checks, a golden regression test and a large test suite. Proven on one home only. |
| Honesty and traceability | 8.5 | Provenance labels on every figure, a revision log, "as known at" rebuilds, and a trace to the raw provider payload. |
| Multi-country | 5 | The schema is ready, but France and the Netherlands run on synthetic data and unverified placeholder taxes. No real source or meter reader. |
| Provider flexibility | 5.5 | The provider registry makes adding a provider a contained job. Only Sunsynk, Octopus, the Tariffscanner UK catalogue and public UK feeds have adapters. |
| Auth and security | 2 | No user identity, no secret store, no OAuth or OIDC, no consent record. Credentials live in `.env` for one home. |
| Scale | 2.5 | One home at a time, SQLite, a serial sync. The scale design exists on paper only. |
| Planning and control | 0.5 | Not built. The system is read-only. |
| Operations | 4 | A supervisor, retries and gap-fill exist. There is no monitoring, backup or multi-environment setup. |

## 3. Strengths and risks

**Strengths**
- The data foundation and the discipline around testing it.
- Honest labelling: sourced, provider, user, placeholder, synthetic and derived.
- A provider registry, so unsupported things are visible rather than silently missing.

**Biggest risks**
- **Single-home proof.** Most of the generality is verified on synthetic data. A second real home, especially outside the UK, will find defects.
- **No identity layer.** Everything involving users, tokens and consent depends on it.
- **Unverified claims.** French and Dutch tax values, the GB 0% electricity VAT from 1 October 2026, the VAT basis of the Tariffscanner prices (assumed to exclude VAT; the API does not say), and the PredHeat description all need checking against sources. The size of the first full Tariffscanner sweep has not been measured.
- **Speed of change.** A lot of code arrived quickly. The tests are good, but a human review would catch design drift, especially in pricing, the build engine and the registry.

## 4. What 10/10 looks like

A GB home and a French or Dutch home, both real, each connected by its own user. Both are priced from verified rules and checked by the same engine. The planner is scored against reality, and every number on the page says where it came from.

## 5. Work to reach 10/10

### Must do

| # | Work | Done when | Effort |
|---|---|---|---|
| 1 | **A real non-UK home end to end:** a French or Dutch home with a real meter reader (Linky or P1) and a real price source | The same pages show real data labelled `provider`, with the checks passing | 2–4 weeks, gated by a licence or token |
| 2 | **Verified tax rules** for the prototype countries, plus the GB 0% VAT check | Each rule cites an official source, and no `unverified` flag remains for FR or NL | Days |
| 3 | **Identity and credentials:** sign-in for the app's users, an encrypted secret store, a consent log, and a connect and disconnect flow for API-key and password providers | A second user connects their own Sunsynk or Octopus account, and a disconnect deletes the stored secrets | 2–3 weeks |
| 4 | **One OAuth or OIDC provider** end to end, with token refresh and a "needs re-authorisation" state | A connected home survives a token expiry | 1–2 weeks, depends on the provider |
| 5 | **Manual tariff entry** page and API, since it is the only price source for FR and NL today | A tariff typed in by a user prices a real home, labelled `user` | 3–5 days |
| 6 | **Planner in shadow mode** on the real GB home, with plan scoring | Two weeks of plans beat a do-nothing baseline by a number that can be shown | 3 weeks to build, plus 2 weeks of data |
| 7 | **Human code review** of the pricing, build and registry paths | A written list of defects, all fixed | 2–3 days |
| 8 | **A second GB home** with a different inverter or supplier, to prove the generality | It builds with the checks passing and no code changes outside an adapter | 1–2 weeks |

### Should do

- **Operations:** a health check, alerts on failed syncs, a backup and restore test, and a one-command setup.
- **Known quality gaps:** fetch carbon once per region, add origin to raw readings, version the contracted capacity, add per-kW charge periods, and rename remaining "half-hour" API keys.
- **A rebuild benchmark** for a year of data at 15 minutes, so "a slot change is cheap" is measured.
- **A decision log** recording the choices made: no 45-minute slots, no stored 15-minute grain for UK sites, and the provider registry.

### Out of scope for a prototype

Multi-home scale, a PostgreSQL port, live device control, heating and EV optimisation. Document them as designed and not built. Claiming them would lower the score.

## 6. Order and timeline

1. Items 2, 5 and 7 first. They are cheap and remove the biggest unverified claims.
2. Item 3, then item 4, because everything user-facing depends on identity.
3. Item 1 in parallel with item 3, since its blockers are licences and tokens, not code.
4. Item 6 once item 1 is underway, so the two-week data clock starts early.
5. Item 8 last, as the proof of generality.

Realistic timeline: about **8–10 weeks** with one developer plus AI help. The coding is closer to 5–6 weeks. The rest is waiting for licences, tokens and planner data. These are estimates, not measurements.

## 7. Expected score after each step

These are rough projections to help plan, not promises.

| After | Projected prototype score |
|---|---|
| Items 2, 5, 7 | 7.0 |
| + item 3 (and item 4 once a provider is chosen) | 7.8 |
| + item 1 | 8.8 |
| + item 6 | 9.3 |
| + item 8 and the "should do" list | 10 |

## 8. Related documents

- `docs/what-it-does.md`: what the system does and how providers are chosen.
- `docs/capabilities-and-roadmap.md`: what is supported, what is not, and the Predbat and PredHeat work.
- `docs/database.md`: the schema.

## 9. Planned and upcoming

### Built, not yet merged
- **Tariffscanner adapter** (`src/adapters/tariffscanner.js`): the core calls the UK tariff catalogue itself, with its own credential, as a second GB `tariff_catalogue` provider beside Octopus's. At most one sweep per 24 hours, at least 3 s between requests, the cooldown kept in `provider_state` across restarts, at most 60 requests per run (then it stops at a saved cursor), and an HTTP 429 aborts the run. `forceTariffscannerSweep()` sweeps by hand; `/api/catalog?tariffs=tariffscanner` lists what is held. Tested against a fake API and clock, mapping the saved live samples in `test/fixtures/tariffscanner/`. Two items are unverified: the prices are assumed to exclude VAT (the API does not say; some sample values look like a VAT-inclusive price divided by 1.05), and the size of the first full sweep is unknown.

### In progress now
- **Clean-up and merge of the provider registry:** removing stray references, checking the Providers panel against real data, then merging.

### Next (the must-do list in section 5)
1. Verify the French and Dutch tax rules and the GB 0% VAT claim against official sources.
2. Manual tariff entry (page and API), the only price source for France and the Netherlands today.
3. Human code review of the pricing, build and registry paths.
4. Identity, an encrypted secret store and a consent log, with a connect and disconnect flow for API-key and password providers.
5. One OAuth or OIDC provider end to end, with token refresh and a "needs re-authorisation" state.
6. A real non-UK home: a Linky or P1 meter reader and a licensed price source (tounify once its storage licence is confirmed, or ENTSO-E with a token).

### Then (planning)
- **Planner in shadow mode** on the real GB home. Predbat-style: a fixed 5-minute step, a decision per slot, windows merged for the device, and plans stored only when they change. It is scored against what actually happened. At least two weeks of data are needed before judging it.
- **Load prediction and a pessimistic solar case** feeding the planner.
- **Vendor capability flags,** so the planner never plans an action a device cannot deliver.

### Later
- **Control path:** a desired state per device, a diff against the reported state, writes only on change, read-back, and an expiry on every command so a stale plan never runs.
- **Heating (PredHeat-style):** heat demand prediction and a thermal state, only through manufacturer-sanctioned interfaces and after real heat-pump data exists. The PredHeat description needs checking against its source first.
- **EV charging** with smart-charge slots treated as unconfirmed until the car is charging.
- **More inverters and suppliers,** one adapter each, driven by real customers.
- **More countries:** a market row, verified taxes, a region scheme and a price source each.
- **Multi-home scale:** per-site scoping, a PostgreSQL port, parallel sync and retention rules.
- **Operations:** monitoring, alerts, backup and restore, and one-command setup.

### Decisions needed
- **tounify licence:** get the storage and reuse terms in writing before building daily capture.
- **ENTSO-E token:** register for one.
- **Dutch trial timing:** model annual net metering for 2026, or start on 2027 rules.
- **First OAuth or OIDC provider:** which one decides the flow details.
- **Tariffscanner:** confirm with its team whether its prices include VAT, and whether an EU product exists.
