# Combined plan: database hardening and the Predbat / PredHeat foundation

One plan for two sets of work, because they touch the same files (`db.js`, the schema deltas, `server.js`, the fact reads) and the planner's tables should be built on a hardened base, not beside a leaking one.

- **Source 1:** the database review (`docs/database-review.md`, 27 findings, score 5/10).
- **Source 2:** the planning gaps: what Predbat (battery) and PredHeat (heating, described from memory and unverified) need that the data structure lacks.

Rule for both: **the GB timeline must not change.** `test/golden-gb.test.js` is never regenerated, and the build engine's rows stay identical.

## Phase A: make the base safe and fast (do first)

| ID | From | Work | Effect on the timeline engine |
|---|---|---|---|
| ~~A1~~ | C1 | **Dropped by decision (prototype scope: no auth or security work).** The server still listens on every interface and `/api/raw/:id` still serves saved responses unredacted, which can include personal data. Revisit before any shared or real-customer use. | None |
| A2 | H1 | Add a busy timeout. Apply a delta once, not on every open. Make delta 010 conditional. Seeds insert only what is missing. | None |
| A3 | M1 | Add UPDATE-time overlap triggers for `rate_interval`, `tariff_agreement` and `tax_rule`, and an overlap check for `register_window`. | None |
| A4 | H2, H3, M8, M10 | Bound the history-scanning reads with a lower time limit. Add the missing indexes (an "as known at" index for rates and agreements, forecast, raw and sync indexes, and foreign-key indexes). Run `PRAGMA optimize`. | Same results, faster reads. Verified row for row. |
| A5 | H4, L6 | Retention: delete raw files that feed no fact, thin old forecast issues, trim `sync_run`, delete finished `rebuild_queue` rows. A dry-run report comes first. | None: the facts stay |
| A6 | M13 | Correct the false claims in `docs/database.md`. | None |

## Phase B: fix the planning and heating gaps, on the hardened base

| ID | From | Work | Effect on the timeline engine |
|---|---|---|---|
| B1 | Gap 1, 2 | `attribute_def` registry (key, unit, type, allowed range, applies to) and a standard key list on the existing versioned `site_attribute` and `device.attrs`: battery max charge and discharge rate, reserve, export limit, charge curve, supported actions; heating: heat loss, thermal mass, floor area, heat-pump efficiency curve. Every value carries an origin label. | None |
| B2 | Gap 3 | `site_setting`: versioned planner tunables per home, with defaults. | None |
| B3 | Gap 4 | Metrics for indoor temperature, set-point, heating energy, heat output and heat-pump electricity. Device kinds `heat_pump` and `thermostat`. | None: the build reads only the metrics it names |
| B4 | Gap 5, M11 | Store an outdoor-temperature forecast as change-only forecast issues. Add `recorded_at` to `forecast_fact` and `end_ts` to its key, so forecasts are bitemporal. | None for GB: the build reads only the solar forecast, and issue times are unchanged |
| B5 | Gap 6 | A derived pessimistic solar series from the home's own forecast scoring, labelled `derived`. | None |
| B6 | Gap 7 | `plan_run` (scenario tag, facts cut-off, method version, plan hash) and a sparse device-generic `plan_slot`, written only on change. | None: the build never reads them |
| B7 | Gap 8 | `command` (device, desired state, valid-until, status, read-back link) and a `device_action` registry of what each device kind can do. | None |
| B8 | M12 | Relax the slot CHECKs to a 5-minute grid, and allow more subject kinds on a series, so a planner and many devices are not blocked. | None: 15, 30 and 60 minutes still work |
| B9 | Heating | `site_heat_slot`: a separate serving table on the same slot key, built only for homes that have heating series. | None: `site_hh` and `site_day` gain no columns, so the golden hash cannot move |

| B10 | Access shape | A planner read layer in the database design, because Predbat and PredHeat consume resampled arrays, not raw rows. One documented function (and the SQL or view behind it): `series(site, metric, from, to, step, as_of)` returning the facts known at `as_of`, resampled to a 5-minute step or the home's slot, with a stated rule per metric kind (power is averaged, energy is split by overlap, a daily counter is differenced into buckets with the midnight reset handled, a price is held across its interval). Companions: `rates(site, from, to, step, as_of)` for import, export and standing; `forecast(site, metric, case, from, to, as_of)` returning the issue of record for the central, low and high cases; `load_history(site, days_previous, step, as_of)`. Each is bounded by an index and tested on the GB home against a hand-computed result. | None: read-only functions, not used by the build |
| B11 | 100% coverage | The coverage matrix: one machine-readable file mapping every item in `docs/predbat-predheat-requirements.md` to a table, column, registry key or read function, and a test that fails when a target does not exist or an item has no mapping. Items that are not data are excluded with a stated reason. | None |

## Phase C: later, before a second home

Authentication and a tenant model; `site_id` on facts and a tested erasure path; version the site and tariff settings that are overwritten today (H5); STRICT tables, range checks and one time unit per column suffix (M2, M3, M4); region keys on tariffs and a payment-method vocabulary (M5, M6); and the PostgreSQL port with partitions and object storage for raw files.

## Order and gates

1. **Phase A first.** Gate: the full test suite passes, the golden test is untouched, and the GB build output is identical before and after (a dry-run hash).
2. **Phase B on top.** Gate: the same checks, plus tests for each new table, registry and the heating pass.
3. **Phase C** is planned, not started.

Out of scope here: the planner itself, device control and any new data source. Phase B only makes room for them.

## Risks

- A retention job that deletes the wrong data. Mitigation: dry-run first, and delete only raw payloads that feed no fact.
- A new index or bound changing a result. Mitigation: row-for-row comparison on a snapshot.
- Many new tables and attributes growing without limit. Mitigation: registries that reject unknown keys.
- Unverified PredHeat details. Mitigation: the heating attributes are placeholders until checked against its source.
