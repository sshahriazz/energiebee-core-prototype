# Remaining work

Status as of 28 October 2026. The prototype is feature-complete for the provider-agnostic slot engine, its screens and its backend (621 tests pass; the slot-length run covers 111 tests at 15 and 60 minutes). This page lists what is left, grouped by what stands in the way.

**How to read the sizes.** S is about an hour or two of work, M is a day or two, L is several days or more. They are rough guesses, not commitments.

---

## 1. Blocked on you or the client

These cannot be finished without something from outside the code.

| Item | Why it matters | What is needed |
|---|---|---|
| A real vendor control driver | Control runs only against a simulated device. A real driver is the proof that a command is confirmed by a real device's own read-back | A chosen vendor, its API documentation, and a test device or account. A metered smart plug is the safest first device |
| A real IoT device on the push endpoint | The Shelly, Tasmota and Home Assistant shapes were written from the vendors' documentation and have never met a real device | One or two metered smart plugs (or any device with a local API) |
| A second real inverter or battery brand | The design is proven with a vendor built as test data from your real figures, not with a live second vendor | A test account or a sample data export |
| A home outside the UK with meter data | Country-agnostic behaviour is proven with synthetic homes and real weather only. A real EU meter feed has never been used | An NL or FR home: smart meter access (API, P1 or Linky) or 2 to 4 weeks of readings, plus the tariff |
| Licences and tokens | The EU price path is unfinished | tounify licence confirmation (only a test key today); a free ENTSO-E token |
| Unverified tax and tariff facts | Wrong figures would price slots wrongly | French and Dutch tax rules, one UK VAT rate, the PredHeat details, and the VAT basis assumed for Tariffscanner prices, all need checking against their sources |
| A decision about the test fixture | It is your home's de-identified energy data (coordinates rounded to about 11 km) and is now in `main`'s history | Decide whether that is acceptable before pushing to the GitHub remote |

The WhatsApp message to the client covers the first five rows.

---

## 2. Ready to build (no outside input needed)

| Item | What it adds | Size |
|---|---|---|
| Per-device energy in slots | A per-device slot rollup, so the plug, EV charger and heat pump appear in the timeline beside the home's load (sub-metering), not only on the Devices page | M |
| A full synthetic demo home | A synthetic inverter, meter and tariff so Timeline, Breakdown and the other pages work for the demo home, a remove button, and more control actions than "charge" | M |
| Consumers for the new roles | Nothing reads events, `ev_charger_energy` or `plug_energy` yet. They can be defined and bound only | M |
| Replay for more adapters | Only Sunsynk and pushed receipts can replay. The meter, Octopus dispatches, carbon, National Gas, Open-Meteo and Quartz parse inline in their adapters. Each needs its parse split out as a pure function | M |
| Channel changes in the impact preview | A channel change alters how data is read from now on, so the preview shows nothing for it. A preview of the effect on a re-read would help | S to M |
| Bind a pushed device to a role automatically | A pushed device is registered but not bound; the operator binds it by hand | S |
| Heating across a vendor switch | The heating build picks one series per metric, so a vendor switch in the middle of a day is not merged | S to M |
| Meter sum rule | Meters stay one per fuel and direction; two meters of one kind are not added | M |
| Control refinements | Multi-window schedules, an order of priority between several controllers on one device, more actions (plug on and off, heat pump set-point), and what to do when a battery is already at target (the check now says so, but nothing acts on it) | M to L |
| Time and scale checks | Counter derivation on years of samples, and group views at 20 homes by a year (3.7 s for the year today, linear), have not been optimised. A pre-aggregated table is the fix if it ever matters | S to M |
| A browser test driver | The suite has no DOM driver, so screen behaviour (for example the Providers screen's priority input) is checked by hand in a browser | M |

---

## 3. Engine design work deferred on purpose

Each of these was left out deliberately, with a trigger for when to do it.

| Item | Why it was deferred | Do it when |
|---|---|---|
| One resampler for build and planner | They agree within 0.1%, but they are two integrators | A change to one must reach the other, or they drift |
| Rules as data | "Meter beats clamp", the daily fit range and the hold rules are still code. A general policy interpreter now would be guessing | A second vendor needs a different rule |
| Health-based slot status | A slot's state comes from the calendar and a meter flag, not from how healthy each source is | A source outage must change what the user sees |
| A measurand catalogue | `metric` plays this role without declared valid ranges | Ranges need to be shared across channels |
| Channel history at read time | A conversion that changes later only affects new data; old facts keep the conversion they were written with | A past conversion is found wrong and must be re-read |
| Wider validation | Range, stuck-sample, future-timestamp and clock-offset checks exist. Spike detection does not | Real devices show the need |

---

## 4. Planning and auto-management

| Item | State |
|---|---|
| The optimiser (simulator, optimiser, window merge) | Not built. The tables (plan runs, slots, commands, scores) and the read layer for Predbat and PredHeat exist |
| The whole loop with a real planner | Plan, command, device read-back and score has never run end to end with a real planner |
| PredHeat details | Unverified against PredHeat's own source |

This is the largest remaining piece. It should wait until real inputs exist (sections 1 and 2).

---

## 5. Security, scale and operations

| Item | Note |
|---|---|
| Sign-in and row-level security | Out of scope by decision for the prototype. The "may this person control this home" check exists and is enforced when a person acts, but not on the Providers routes or the ingest endpoint |
| Per-device keys, TLS and rate limits on push | The endpoint has an optional shared token and size limits only |
| MQTT client and websocket | Not built. Put a bridge in front (mosquitto, Home Assistant or Node-RED posting to the endpoint) |
| Raw data redaction and the open raw endpoint | The raw endpoint is open and serves unredacted bodies |
| A secret store | Credentials live in the environment |
| PostgreSQL port | Row-level security, partitioning and a scheduler for thousands of homes are designed, not built |
| A hub for edge devices | Designed in the architecture notes, not built |
| A runbook for your live database | The new code applies deltas 061 to 075 the first time it opens `data/core.db`. Back it up first |
| Continuous integration | None is set up |

---

## 6. Known small issues

- A Tasmota local time inside the repeated autumn hour is a nearest-instant guess.
- One Tasmota test can fail on the single day a year when the emulator's window crosses a spring clock change.
- The Providers health view judges the freshest series per source, and cannot see a forecast that repeats itself unchanged.
- A replay reads at most 2000 receipts per run, and cannot recover a receipt that retention already deleted.
- The demo home cannot be removed from the page yet (see section 2).

---

## 7. Housekeeping

- `main` is 22 commits ahead of `origin/main` and is not pushed.
- `pnpm-lock.yaml` is an untracked file in the working tree that this work did not create. The project uses `package-lock.json`.
- `docs/.DS_Store` is tracked and keeps changing; it should be ignored.
- Work continues on the branch `provider-agnostic-slot-engine`; each round is merged into `main` with its history.

---

## Suggested order

1. Send the client request (section 1) so real devices and a non-UK home start moving.
2. Per-device energy in slots and the full demo home (section 2), so the screens look complete.
3. Replay for the remaining adapters and the new-role consumers (section 2).
4. A real control driver and a real device test, as soon as hardware or a vendor choice arrives.
5. The optimiser (section 4), only once real inputs exist.
