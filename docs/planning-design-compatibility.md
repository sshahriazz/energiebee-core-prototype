# Compatibility with the planning design

How the core fits the "Predbat in Node.js + SQL" planning design and the comparison document that framed the two systems as a ledger of the past and a controller of the future. The core is the ledger. The planner and executor are not built.

## Verdict

| Part of the planning design | In the core | Status |
|---|---|---|
| Time grid: 5-minute steps, slots keyed by UTC start | Same, with a per-site `slot_s` | Compatible |
| Input tables replaced by the ledger (rates, PV forecast, load history, telemetry) | Covered by `rate_interval`, `forecast_fact`, `site_hh`, `reading` | Compatible |
| Versioned facts with provenance | Append-only facts with a source, a learned-at time and a raw payload | Compatible (better than the design) |
| Data quality gate | Slot states and quality flags | Partial: no gate yet |
| `site` with timezone and plan interval | `site` with timezone, market, currency and `slot_s` | Compatible |
| Device registry (inverter, battery, meters) | `device` plus ranked `site_attribute` | Partial |
| `site_setting` tunables (keep level, solar weight) | Not present | Missing |
| `tenant`, `credential` | Not present | Missing |
| `plan_run`, `plan_slot`, `current_plan` | Not present | Missing |
| `inverter_command` and executor with read-back | Not present | Missing |
| `event_log` | `sync_run` and the revision log (not the same) | Partial |
| Scheduler with SKIP LOCKED and worker pool | Single serial sync | Missing |
| Edge agent, MQTT topics, hybrid mode | Not present | Missing |
| Planner as a pure function | Not built | Missing |

## Example 1: replacing the design's input tables

The design's `tariff_rate` copies a price per site per slot. The core stores each price once and joins it.

| Design table | Replaced by | Why |
|---|---|---|
| `tariff_rate` (site, direction, slot, p/kWh) | `rate_interval` + `tariff_agreement` | Prices are shared by every home on a tariff |
| `pv_forecast` (one row per slot) | `forecast_fact` | Every forecast issue is kept and scored |
| `load_history` (5-minute buckets) | `reading` and `site_hh` | Already stored and checked |
| `telemetry` (wide row per inverter) | `reading` (narrow, one metric per row) | A new metric needs no migration |

## Example 2: a slot, side by side

The planner's `plan_slot` and the core's ledger row share one key. A plan for the slot starting 2026-10-24T00:00:00Z would line up like this (illustrative values):

| Key | `plan_slot` (planned) | `site_hh` (what happened) |
|---|---|---|
| `slot_start` | 1792800000 | 1792800000 |
| Action | charge, limit 100% | n/a |
| Import | 1.20 kWh predicted | measured from the meter |
| Cost | predicted | priced from the tariff in force |

The design proposes storing each plan's predictions as a forecast source so the existing accuracy scoring grades the planner. The core's forecast scoring already does this for its own forecasts.

## Example 3: a command

The design's `inverter_command` carries a desired state, a status and a read-back link. In the core's terms it would be one more kind of fact:

| Field | Example |
|---|---|
| Device | the home's inverter |
| Desired | charge window 23:30 to 05:30, target 100% |
| Valid until | 05:30 (a late command is dropped, never applied stale) |
| Status | pending, sent, acked or failed |
| Read-back | the schedule read from the inverter, kept as a raw payload |

Nothing here exists yet. The core already has the raw-payload store and the idea of a checked read.

## What the core adds that the design lacks

- Provenance on every figure, and labels for sourced, provider, user, placeholder and synthetic data.
- Prices shared per tariff, not copied per home.
- Bitemporal "as known at" rebuilds, so a plan can be reproduced from the facts it used.
- Country, currency and region handling, and tariff shapes the design never covered (French off-peak, Tempo, fixed charges).

## What the design adds that the core lacks

- A control path to the device.
- Multi-tenancy, a scheduler and a worker pool.
- An edge agent, MQTT topics and store-and-forward.
- Tunable settings per site.

## Suggested order to close the gaps

1. `plan_run` and `plan_slot`, written only on change.
2. The planner as a pure function, run in shadow mode and scored.
3. `site_setting` for the planner's tunables.
4. The command path with expiry and read-back.
5. Tenant scoping and the scheduler when more than one home needs it.
6. The edge agent last.

See `docs/capabilities-and-roadmap.md` for effort and `docs/predbat-slot-compatibility.md` for the slot detail.
