# Resilient, source-agnostic slot engine: root-cause review and fix

Review date 27 Oct 2026, commit `d6ec1a8` plus the untracked `src/adapters/_template.js`. Scope: the engine that turns facts from many sources into the slot timeline (`site_hh`, `site_day`), and the ingest path that feeds it. Every claim cites a file and line, or a synthetic experiment whose output is quoted. Scripts and raw outputs: `/private/tmp/claude-501/-Users-macbookpro-Desktop-energiebee-core-prototype/0e1f9574-1c47-4113-8208-cb61cee75291/scratchpad/engine-review/` (`exp.mjs`, `cost.mjs`, `restart.mjs`, `exp-output.json`, `cost-output.txt`, `restart-output.json`). All experiments ran on throwaway databases (`DB_FILE` in that folder), with `fetch` stubbed, so nothing touched the network or `data/core.db`.

Words used below. A **source** is a provider feed (`sunsynk_5min`, `octopus_meter`). A **channel** is one physical measuring point on one device (inverter A's PV power). A **measurand** is the site-level quantity a slot reports (grid import, solar). A **binding** says which channels feed which measurand of a home. A **policy** says how to choose and combine them.

---

## 1. Executive summary

1. The slot engine is wired to vendors, not to measurands: it asks for `sunsynk_5min`, `octopus_meter` and seven other source codes by name, on a fixed `site` subject (113 such literals in 16 non-adapter files; 18 in `build.js`). A second vendor's correct facts are ignored; a second device of the same adapter overwrites the first.
2. The rules that decide a slot (meter beats clamp, 5-minute hold, daily fit 0.6 to 1.6, coverage 0.8, six fixed nodes) are code. Three separate resamplers exist, so the same 15-minute samples give 0.2 kWh in the build and 0.6 kWh in the planner read, depending only on the source code they are filed under.
3. Missing data becomes zero: a payload with PV but no grid list produces `grid_import 0`, `home 0`, state `final`.
4. Nothing validates facts in a common layer: negative energy, wrong units (kW for W), a 500 MW spike, a reading one week in the future, and two overlapping meter intervals are all stored and served as `final`.
5. Slot state comes from one boolean and the calendar, and "sync step ok" means "did not throw": four providers answering `{}` all became `ok` with a fresh `last_success_at`.
6. Ingest is not durable or idempotent enough for push data: a crash between writing facts and marking them dirty leaves served days wrong for ever (measured: 9.6 kWh served, 21.6 kWh in the facts), and a batch carrying one timestamp twice is rolled back whole.
7. Keep: bitemporal facts, raw receipts with hash dedup, quarantine, per-step failure isolation, per-home slot grid, versioned tariffs and devices, provenance, the revision log, the deterministic dry run, `planner-read`'s per-step source index.
8. Not a problem today: rebuild cost (2 ms for today, about 6 ms per day of history; 547 ms for a correction 85 days back on a 90-day home).
9. The fix: put a binding layer (channels and bindings as data) and a policy (ordered candidates, fallback, fitting, cross-checks, finality as data) between the fact store and one generic engine; make every adapter a pure normaliser that emits one canonical observation envelope; validate envelopes in one shared layer with a dead-letter queue; track source health per channel and let it drive final, provisional and missing.
10. Migrate in stages behind a synthetic golden hash so GB output stays byte-identical until a deliberate `METHOD_VERSION` bump. The current live golden test is red at HEAD (section 7), so stage 0 replaces it.

---

## 2. Root causes, ranked

Severity: **Critical** blocks a second vendor or device outright or serves wrong numbers as final; **High** gives wrong numbers in normal operation of IoT or multi-source homes; **Medium** limits operations or audit.

### RC1 (Critical). No binding layer: the engine addresses inputs by vendor code and a fixed `site` subject

- **Claim.** The build looks up every input by vendor source code on subject `site`, and adapters write inverter data on subject `site`, not per device.
- **Evidence.** `build.js:166` `sid = (metric, source) => seriesId('site', siteId, metric, source)`; `:172-174` power, daily counters and charge level from `sunsynk_5min` / `sunsynk_daily`; `:198,206` meters from `octopus_meter`; `:200` `national_gas_cv`; `:213` `octopus_kraken`; `:215` `carbon_regional`; `:216` `open_meteo`; `:222` `quartz`, `core_forecast`; `:212` "meter expected" only if a connection has `provider = 'octopus'`; `:632` the rebuild range is clamped by `sunsynk_5min` readings. `sunsynk.js:82` writes `seriesId('site', siteId, metric, 'sunsynk_5min')`. The registry claims the opposite ("Everything the core knows about a provider's behaviour lives in its contract here, not in the build engine", `registry.js:2-3`), and the template admits it (`_template.js:137-150`). Literal counts of the ten vendor codes outside adapters and the registry: `planner-read.js` 27, `build.js` 18, `explorer.js` 16, `forecast.js` 14, `explain.js` 9, `trust.js` 8, `server.js` 4, `solar-cases.js` 4, `sync.js` 3, `steps.js` 2, `solar-expected.js` 2, `heat.js` 2, `pricing.js`, `maintenance.js`, `derive.js`, `compare.js` 1 each: 113 in 16 files. Plus `'sunsynk_ct'` as a lineage label (`build.js:346,348,363`, `explain.js:498`, `explorer.js:991`) and `provider = 'sunsynk'` in `trust.js:27`, `derive.js:27,31`, `maintenance.js:38`.
- **Experiments.** Two inverters through the same adapter on one site (inverter A 1000 W, B 500 W, synced alternately A, B, A, B): current mean after each write `1000, 500, 1000, 500`; 36 superseded versions for 12 samples; slot solar 0.25 kWh, truth 0.75. A second PV array from another vendor filed correctly per device under its own source: build solar 0.5, home 0.5 (truth 0.75 each); `planner-read` returns 1000 W (truth 1500), sources `[sunsynk_5min, heating_telemetry]`, source index always 0, because sources are alternatives there, never added (`planner-read.js:281-295`). Two import meters (0.4 + 0.2 kWh per half-hour): build import 0.2, truth 0.6 (`build.js:206` overwrites `meterFacts[m.kind]` per device).
- **Nuance (hypothesis 2 corrected).** For Sunsynk itself the plant day series is already aggregated upstream, so two inverters on one Sunsynk plant do not collide. The collision is real for any per-device stream (hub, MQTT) filed through the `site` subject, and the Sunsynk adapter still drops data: live flow and battery size come from the first inverter only (`sunsynk.js:169-171`), and the "Micro Inverter" curve is skipped (`sunsynk.js:61`). A meter exchange writes every serial of an MPAN into one device series (`octopus.js:241-257`), so overlapping serial histories would overwrite each other.
- **Consequence.** A new inverter or meter vendor produces good facts that no slot ever sees; two devices of one kind give one device's numbers or flip on every sync, and every flip is logged as a provider revision and marks the slot `RESTATED`.

### RC2 (Critical). Reconciliation rules and the sampling model are code, and there are three of them

- **Claim.** Precedence, fallback, fitting, coverage and hold times are constants in code, and three readers implement them differently.
- **Evidence.** `build.js:53-54` forward hold capped at 300 s; `:313` daily fit only if `0.6 < f < 1.6` and the day is closed; `:315` fit check 10 % or 0.2 kWh; `:108` meter used only with full slot cover; `:329` clamp shape needs 80 % cover; `:342-348` meter beats clamp; `:350` partial below 80 %; `:356` balance below -0.02 kWh is suspect; `:553,557` meter vs clamp 5 %. `planner-read.js:73-88` has its own hold table (`sunsynk_5min` 300 s, `open_meteo` 3600 s, `heating_telemetry` 3 h, others 3600 s) and its own source preference lists. `heat.js:52,167` holds 3 h (1 h for Open-Meteo). The solar forecast precedence is opposite in two readers: Quartz first in `build.js:222`, `core_forecast` first in `planner-read.js:85`.
- **Experiments (hypothesis 4, quoted per case; truth 0.6 kWh per half-hour, 1200 W from 12:00 to 13:00 local).**
  (a) 1-minute samples: 0.600 and 0.600, correct; but the last sample holds 300 s, so the next slot gets 0.080 kWh of energy that never flowed, state `final`, flagged `PARTIAL`. Faster sampling is handled except at every gap or end.
  (b) 15-minute samples: 0.200 and 0.200, state `final`. With the inverter's daily counter saying 1.2 kWh, the fit factor 3.0 is refused (outside 0.6 to 1.6), a `warn` check is written, slots stay at 0.200.
  (c) 500 W all day with a 40-minute outage and a true counter of 12.0 kWh: fit 1.0286 is applied to every slot, so a complete night slot reads 0.2571 instead of 0.25 (with home 0.25, creating 0.0071 kWh of false loss), the two outage slots read 0.0857 instead of 0.25, the day total is exactly 12.0 and 0 slots are `missing`. The fit hides the gap and smears it across the day.
  Same 15-minute samples through each reader: build under `sunsynk_5min` 0.2; `planner-read` under `sunsynk_5min` 0.2; `planner-read` under `manual_entry` 0.6; build under `manual_entry` `null` (missing).
- **Consequence.** Deadband reporting, which the platform plans for hub devices (`architecture-v3.md:303,394`: report on change, 1 to 5 minutes), is under-counted by up to the ratio of report interval to 300 s. Two consumers of the same facts disagree. A new market cannot change a rule without changing the engine.

### RC3 (High). Missing is coerced to zero, and coverage is not per node

- **Claim.** A node with no samples counts as 0, and slot coverage is taken from solar or import only.
- **Evidence.** `build.js:320` `(aligned[k].energy.get(slot) || 0)`; `:335` coverage from solar, else import; `:339-341` solar, charge and discharge are 0 (not null) when there is no inverter; `:357` measured load is 0 when the load list is absent.
- **Experiment.** A Sunsynk day answer with the PV curve and no Grid, Load or Battery lists, through the real `normaliseDay`: `solar 0.15`, `grid_import 0`, `home 0`, coverage 1, state `final`. A renamed label at the provider (a schema change) produces the same result, because unknown labels are skipped silently (`sunsynk.js:61`).
- **Consequence.** Partial or reshaped payloads become confident zeros; a home without a supported inverter shows "no solar" rather than "solar unknown".

### RC4 (High). No shared validation; contracts are text; the schema cannot express counters or events

- **Claim (hypothesis 6 confirmed).** Contracts are stored as JSON text and only displayed (`db.js:84-104` seeds them, `server.js:671` shows them); nothing in ingest or build reads them. `checkPriceRows` exists (`contract.js:133`) but no production code calls it. `putReadings` / `putIntervals` (`facts.js:79-116`) check nothing but equality.
- **Experiments.** All accepted and served: negative daily energy; a reading of the interval metric `grid_import_kwh`; a 5e8 W spike (slot import 41,667 kWh, `final`); kW sent where W is expected (0.0006 kWh, `final`); PV stuck at 2500 W at night (1.25 kWh per half-hour at 02:00, `final`, not even `SUSPECT`); a reading dated one week in the future; a meter half-hour re-sent as one hour (both in force, import 1.2 per half-hour, truth 0.6, `final`, `MEASURED`). A cumulative register differenced across a reset: import -1499.7 kWh, `final` (flagged `SUSPECT`). Adding a metric with `time_role = 'counter'` is refused: `CHECK constraint failed: time_role IN ('instant', 'interval')` (`schema.sql:22`).
- **Consequence.** Every adapter must get every edge case right on its own; IoT counters (most smart plugs, CT clamps and meters report lifetime kWh) and on/off events have no representation.

### RC5 (High). State and health: one boolean, the calendar, and "did not throw"

- **Claim (hypothesis 5 confirmed with a correction).** Slot state is `missing` if import is null, else `provisional` if (a meter is expected and absent) or the day is today, else `final` (`build.js:474-476`); "meter expected" is a meter device or an `octopus` connection (`:212`). A source-health model does exist, but only for display: `trust.js:15-55` has per-feed arrival expectations (`dueS` 1 h for Sunsynk, 2 days for meters, samples per slot), vendor-coded and never used by the build. `planner-read.js:70` has freshness limits for the planner's live inputs only. A step is `ok` when it does not throw (`sync.js:112-124`), and adapters return `{ skipped }` instead of throwing on empty answers (`openmeteo.js:31-33`, `quartz.js:23-26`, `carbon.js:31`; Sunsynk accepts an empty `infos` list, `sunsynk.js:56`).
- **Experiments.** Meter expected, inverter data present, no meter data: a day 37 days old is still `provisional` (2 slots) and `missing` (46 slots); there is no deadline. No meter expected: one 5-minute sample in a half-hour (coverage 0.17) is `final`. Late data that arrives after a slot was built as `final` (0.2 kWh, partial) turns it into 0.6 kWh with `RESTATED`: "final" was premature. With every provider stubbed to answer `{}`, the next sync logged every step `ok`; all four connection rows went to `status ok` with `last_success_at` set; two payloads were quarantined. Because `resumeDate` (`steps.js:32-38`) resumes from `last_success_at`, an empty answer moves the resume point forward and the gap is not re-fetched.
- **Consequence.** A flaky or late source is invisible to the timeline; state cannot be trusted as "complete".

### RC6 (High). Ingest durability and idempotency gaps

- **Claim.** The dirty signal is derived, not recorded; the version key can collide; content hash is used as event identity.
- **Evidence.** Rebuild range = facts with `recorded_at >= sinceMs` (the sync's own start, `sync.js:98-109,192`). A tariff-agreement change replaces that minimum with the start of today minus two days (`sync.js:184,192`), so a backdated agreement or a late correction in the same sync is not rebuilt (code reading; not run, it needs a live Octopus account). Facts are keyed by `(series_id, ts, recorded_at ms)` (`schema.sql:205`) and `putReadings` stamps one `Date.now()` per batch (`facts.js:80`). `landRaw` dedups on `sha256(source, status, body)` (`facts.js:24`): two genuine identical payloads (Sunsynk live flow has no timestamp, `sunsynk.js:109-113`) share one receipt and the second arrival is not logged.
- **Experiments.** Crash after writing a correction for day -3 (inverter re-upload 900 W instead of 400 W) and before `markDirty`, then a normal sync: served `9.6` kWh, facts say `21.6` kWh, the sync rebuilt only `2026-10-27`. One batch with the same timestamp twice and two values: `UNIQUE constraint failed: reading.series_id, reading.ts, reading.recorded_at`, 0 rows kept. The same failure hit two writes in one millisecond during the experiments (first run of `exp.mjs`).
- **What works (keep).** Re-sending identical rows writes nothing (12 then 0); an identical raw body is recognised (`duplicate: true`); out-of-order arrival within a series is harmless because reads sort by time (`facts.js:175`); `resumeDate` refills after a real outage; interrupted runs are marked at start-up (`sync.js:237-239`).

### RC7 (Medium). Adapters fuse fetch, parse and write, so stored raw cannot be replayed

- **Evidence (hypothesis 6, second half, confirmed).** `explorer.js:262-266` re-derives only `tariffscanner` and `tounify`; `NOT_PURE` (`explorer.js:222-234`) lists why every other source cannot be: normalisers call `seriesId` and `put*` while parsing, or read the clock or device attributes. 2 of 9 adapter files are re-derivable, and none of the 6 that feed the slot engine.
- **Consequence.** A normaliser bug cannot be fixed retroactively from the raw store, which removes most of the value of keeping raw receipts.

### RC8 (Medium). Single-asset site model

- **Evidence (hypothesis 7 confirmed).** `build.js:40-43` six fixed nodes; one charge-level series (`:174`), one `site.battery_kwh` (`:157`), one first-in-first-out stock (`:281`), one round-trip efficiency (`:265-273`); `site_attribute.attr` CHECK allows one `pv_kwp` and one `battery_kwh` per site (`schema.sql:335`). Predbat itself is multi-inverter (`num_inverters`, per-inverter limits and `soc_max`, `predbat-predheat-requirements.md:85-107`).
- **Consequence.** Two batteries cannot be costed or planned; their charge levels cannot be combined.

### RC9 (Medium). Schema shape (hypothesis 9 confirmed)

`series` is unique on `(subject_kind, subject_id, metric, source)` with no channel, role or priority (`schema.sql:74-81`), so two points of one device with the same metric and source cannot both exist; `subject_kind` is limited to `site`, `device`, `region` by CHECK; `subject_id` is TEXT with no foreign key (`database-review.md` M7); `metric.time_role` has no counter or event (`schema.sql:22`); seconds and milliseconds share the `_at` suffix (M3); there is no device time vs received time on facts; forecasts are stored correctly (bitemporal since delta 040) but the build still selects the solar forecast by provider `issued_at`, not `recorded_at` (`build.js:223`), so an as-of rebuild can see an issue fetched later.

### Not a root cause: rebuild cost (hypothesis 8, mostly refuted)

The sync does not rebuild the whole range: it rebuilds from the earliest changed fact to today (`sync.js:192`, `build.js:643-681`). Measured on a synthetic 90-day GB home (181,524 readings): full build 560 ms (91 days, 4,330 slots); today only 2 ms; two days 6 ms; 60 days 443 ms; one corrected half-hour 85 days back through `markDirty` and `processQueue`: 86 days rebuilt in 547 ms. Dry-run hash identical across two runs. The real issue is structural: the battery stock carries from day to day (`build.js:279-282`), so any change forces a sequential rebuild to today, and the engine mixes per-day energy work with that chain.

### What is good and must be kept

Append-only bitemporal facts with `inForce()` and as-of rebuilds (`facts.js:155-168`); raw receipts written before facts, with hash dedup and quarantine (`facts.js:21-44`); per-step failure isolation and the provider registry with priorities and owners (`sync.js:112-164`, `providers.js`); `resumeDate` back-fill; the per-home slot grid with 23/25-hour days and overlap splitting (`build.js:68-108`); versioned tariffs, agreements, device attributes and site settings; provenance on every price and the `lineage` of every slot; quality bits including `RESTATED`; the day revision log and checks; the explain trace; deterministic dry runs; and `planner-read`'s design of returning a value, cover, quality and source index per step (`planner-read.js:338-379`), which is the right output shape for the generic engine.

### Failure-mode matrix

| Situation | What happens today (evidence) | What should happen |
|---|---|---|
| Source late | Slot built from clamp, `final` if no meter expected; later data restates it (exp. e) | Candidate is `waiting` until its `due_s`; slot `provisional`; final only after arrival or `final_after_s` |
| Source down | Step error recorded; `resumeDate` back-fills on recovery (good). Meter expected: `provisional` for ever (exp. state) | Health `down` after N failures; fallback candidate used, flagged; finalise with fallback at the deadline |
| Source answers empty | Step `ok`, `last_success_at` advances, gap never re-fetched (restart exp.) | `consecutive_empty` counted; resume from last *non-empty* data time; health `stale` |
| Duplicate batch | Identical rows: no write (good). Same timestamp twice in one batch: whole batch rolled back. Same energy at another interval length: counted twice (exp. d) | Dedup by event key; last-wins within a batch; overlapping intervals of different length go to the dead-letter queue |
| Out-of-order data | Harmless for values (sorted reads) | Same, plus the dirty day recorded from the fact's own time |
| Schema change at provider | Some adapters quarantine; Sunsynk skips unknown labels silently, missing lists become zeros (RC3) | Normaliser rejects unknown shape or missing required points to the dead-letter queue; slot stays `missing` |
| Unit change | Stored as is; kW for W gives 1/1000 (exp. bad values). Gas m3/kWh handled specially (good) | Envelope carries the unit; shared layer converts or rejects; range check catches the rest |
| Two devices of the same kind | Overwrite and flip-flop (same adapter), or ignored (other vendor), or last meter wins (RC1) | One channel per device; binding sums them; completeness needs every bound channel |
| New device kind | Needs code in the build | One measurand row, metric rows, a binding; no engine change |
| Different sampling rate | 15-minute samples count one third (exp. b); 1-minute adds phantom energy after gaps (exp. a) | Hold cap from the channel's declared period or heartbeat; property test over cadences |
| Counter reset | No counter kind; naive difference gives -1499.7 kWh `final` (exp. f) | Counter kind; reset detection; energy across gaps conserved and spread, flagged |
| Clock skew | +7 min moves 0.35 kWh of 1.5 into the next half-hour (exp. g); future readings accepted | Device time and received time both kept; per-channel offset applied; future beyond tolerance to the dead-letter queue |
| Flat-lined sensor | Accepted, `final` (exp. bad values) | Flagged `SUSPECT` by a stuck-value rule; policy falls back |
| Partial payload | Present lists used, absent lists become 0, `final` (RC3) | Per-channel coverage; absent channel is null; slot `missing` or fallback |
| Source revised data | New version, old superseded, `RESTATED`, revision log (good) | Keep; also mark the dirty day durably |
| Provider rate-limit | Two retries honouring `Retry-After` up to 30 s, then step error; budget only for Tariffscanner (`http.js:10-55`) | Per-provider token bucket shared by homes; health `throttled`, not `error`; resume from data time |
| Restart mid-sync | Facts kept, dirty signal lost: served 9.6 vs 21.6 kWh (restart exp.) | Dirty day written in the same transaction as the facts |

---

## 3. Target architecture

### 3.1 Layers

```
connector (pull adapter | MQTT hub link | webhook)
  -> raw store (raw_payload + ingest_receipt: every arrival, event key, outcome)
  -> pure normaliser (raw + channel map -> envelopes; no database, no clock)
  -> shared validation (units, ranges, time, overlap, counters, stuck values) -> dead_letter
  -> fact store (reading, interval_fact, forecast_fact; unchanged tables) + dirty_day, same transaction
  -> binding (channel -> site measurand, per candidate, versioned)
  -> policy (ordered candidates, fallback, fit, cross-checks, finality; data)
  -> generic engine: resample per kind -> reconcile -> allocate -> price -> check -> state
  -> site_hh / site_day (unchanged shape) + channel_health -> state
```

The engine never names a vendor. A connector never writes facts. A normaliser never touches the database.

### 3.2 Canonical observation envelope

One shape for pull, push and manual data (it extends the hub telemetry sample of `architecture-v3.md` 5.3):

| Field | Meaning |
|---|---|
| `source` | registry source code |
| `point` | the provider's own opaque point id (`plant:123/PV`, `hub:H/thing:T/power`, an MPAN) |
| `metric` | metric code (`solar_w`, `grid_import_kwh`, `grid_import_register_kwh`) |
| `kind` | `instant` \| `interval` \| `counter` \| `event` \| `forecast` |
| `ts` or `start`,`end` | UTC epoch seconds, as the device stated them |
| `value`, `unit` | the value and the unit as received; validation converts |
| `received_at` | ms, when the core received it |
| `issued_at` | forecasts only, s |
| `event_key` | idempotency key: `(hub, seq, index)`, a provider event id, or `(point, ts)` |
| `q` | quality bits from the device (estimated, substituted) |
| `raw_id` | the receipt it came from |

The normaliser resolves `point` to a channel through a map it is given; an unknown point becomes a dead letter with reason `unknown_point`, never a new series.

### 3.3 Measurand catalogue

| Measurand | Kinds accepted | Canonical unit | Sign | Slot value |
|---|---|---|---|---|
| `grid_import`, `grid_export` | instant W, interval kWh, interval mean W, counter kWh | kWh | non-negative; signed sources split in the normaliser | energy |
| `solar` | same | kWh | non-negative | energy, summed over channels |
| `battery_charge`, `battery_discharge` | same | kWh | non-negative | energy, summed over batteries |
| `load` | same | kWh | non-negative | energy |
| `battery_soc` | instant % or kWh | kWh (via capacity) | non-negative | last in slot, summed over batteries |
| `gas` | interval m3 or kWh, counter | kWh (m3 by calorific value) | non-negative | energy |
| `ev_charge` | interval, counter, instant W | kWh | non-negative | energy |
| `indoor_temp`, `outdoor_temp` | instant | degC | signed | time-weighted mean |
| `heating_on`, `ev_connected` | event / state 0-1 | share | 0 to 1 | share of slot in state |
| `carbon_intensity` | interval | gCO2/kWh | non-negative | time-weighted mean |

### 3.4 New tables (SQLite, additive except one table rebuild)

```sql
CREATE TABLE measurand (
  code TEXT PRIMARY KEY, label TEXT NOT NULL, unit TEXT NOT NULL,
  sign_rule TEXT NOT NULL CHECK (sign_rule IN ('nonneg','signed')),
  slot_rule TEXT NOT NULL CHECK (slot_rule IN ('energy','mean','last','share')));
ALTER TABLE metric ADD COLUMN measurand TEXT REFERENCES measurand(code);
ALTER TABLE metric ADD COLUMN kind TEXT;            -- instant|interval|counter|event|forecast; checked by trigger
ALTER TABLE metric ADD COLUMN min_value REAL;       -- physical bounds per unit of capacity where relevant
ALTER TABLE metric ADD COLUMN max_value REAL;
ALTER TABLE metric ADD COLUMN default_hold_s INTEGER;

-- series is rebuilt once (ids kept, facts untouched): subject_kind gains 'channel'.
CREATE TABLE channel (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  device_id INTEGER REFERENCES device(id) ON DELETE CASCADE,   -- NULL: an upstream aggregate (a plant)
  source_id INTEGER NOT NULL REFERENCES source(id),
  metric_id INTEGER NOT NULL REFERENCES metric(id),
  point TEXT NOT NULL,
  series_id INTEGER NOT NULL UNIQUE REFERENCES series(id),
  period_s INTEGER CHECK (period_s IS NULL OR period_s > 0),     -- nominal cadence; NULL = on change
  max_hold_s INTEGER CHECK (max_hold_s IS NULL OR max_hold_s > 0),-- heartbeat for on-change reporting
  due_s INTEGER NOT NULL DEFAULT 3600 CHECK (due_s >= 0),         -- normal delay after a period ends
  final_after_s INTEGER CHECK (final_after_s IS NULL OR final_after_s > 0), -- NULL = wait for ever
  clock_offset_s INTEGER NOT NULL DEFAULT 0,
  counter_wrap REAL,                                              -- counters: wrap value; NULL = resets to 0
  recorded_at INTEGER NOT NULL, retired_at INTEGER,               -- ms
  UNIQUE (source_id, point, metric_id));

CREATE TABLE binding (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  measurand TEXT NOT NULL REFERENCES measurand(code),
  candidate TEXT NOT NULL,                                        -- a name the policy uses
  channel_id INTEGER NOT NULL REFERENCES channel(id),
  fit_channel_id INTEGER REFERENCES channel(id),                  -- the same device's own daily counter
  valid_from INTEGER NOT NULL, valid_to INTEGER,                  -- s
  recorded_at INTEGER NOT NULL, superseded_at INTEGER,            -- ms
  CHECK (valid_to IS NULL OR valid_to > valid_from));
CREATE UNIQUE INDEX binding_current ON binding (site_id, measurand, candidate, channel_id, valid_from) WHERE superseded_at IS NULL;

CREATE TABLE reconcile_policy (
  code TEXT NOT NULL, version INTEGER NOT NULL, method_version TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)), recorded_at INTEGER NOT NULL,
  PRIMARY KEY (code, version));
CREATE TABLE site_policy (
  site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
  code TEXT NOT NULL, version INTEGER NOT NULL, valid_from INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (site_id, valid_from, recorded_at),
  FOREIGN KEY (code, version) REFERENCES reconcile_policy(code, version));

CREATE TABLE channel_health (
  channel_id INTEGER PRIMARY KEY REFERENCES channel(id) ON DELETE CASCADE,
  last_data_ts INTEGER, last_arrival_at INTEGER, last_attempt_at INTEGER,
  consecutive_empty INTEGER NOT NULL DEFAULT 0, consecutive_errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','ok','late','stale','down','throttled','paused')),
  status_since INTEGER);

CREATE TABLE ingest_receipt (
  id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES source(id),
  event_key TEXT NOT NULL, raw_id INTEGER REFERENCES raw_payload(id), received_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','duplicate','partial','dead_letter','empty')),
  facts INTEGER NOT NULL DEFAULT 0, UNIQUE (source_id, event_key));

CREATE TABLE dead_letter (
  id INTEGER PRIMARY KEY, raw_id INTEGER NOT NULL REFERENCES raw_payload(id),
  channel_id INTEGER REFERENCES channel(id), reason TEXT NOT NULL, detail TEXT,
  envelope TEXT CHECK (envelope IS NULL OR json_valid(envelope)),
  first_seen INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','replayed','discarded')), resolved_at INTEGER);

CREATE TABLE dirty_day (
  site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE, local_date TEXT NOT NULL,
  reason TEXT, marked_at INTEGER NOT NULL, PRIMARY KEY (site_id, local_date)) WITHOUT ROWID;
```

### 3.5 Policy format

A policy is JSON, versioned, shared by many homes. Per measurand: an ordered list of **candidates** (names that bindings fill), each with an acceptance rule; how channels inside a candidate **combine** (sum for energy, so two PV arrays add); an optional **fit** of a channel to its own daily counter; **cross-checks** between candidates; and **finality**. Derived measurands use a small fixed set of named rules (no expression language).

**Worked example 1, GB legacy (Octopus meter + Sunsynk clamp).** This reproduces today exactly, including its quirks, so the golden hash cannot move:

```json
{ "code": "gb_legacy", "version": 1, "method_version": "v3-stock-follows-charge",
  "hold": { "default_cap_s": 300, "from_channel": false },
  "fit": { "window": "local_day", "accept": [0.6, 1.6], "closed_days_only": true,
           "check": { "rel": 0.1, "abs_kwh": 0.2 }, "min_integrated_kwh": 0.05 },
  "measurands": {
    "solar":             { "candidates": [{ "name": "clamp", "fit": true }], "absent": "zero" },
    "battery_charge":    { "candidates": [{ "name": "clamp", "fit": true }], "absent": "zero" },
    "battery_discharge": { "candidates": [{ "name": "clamp", "fit": true }], "absent": "zero" },
    "load":              { "candidates": [{ "name": "clamp", "fit": true }], "absent": "zero" },
    "grid_import": { "candidates": [
        { "name": "meter", "min_cover": 1.0, "shape_from": "clamp", "shape_min_cover": 0.8, "quality": "MEASURED" },
        { "name": "clamp", "fit": true, "min_cover": "any", "quality": "FALLBACK" } ],
      "crosscheck": { "code": "meter_vs_ct", "a": "meter", "b": "clamp", "slot_cover": 0.5, "rel": 0.05 } },
    "grid_export": { "candidates": [
        { "name": "meter", "min_cover": 1.0, "shape_from": "clamp", "shape_min_cover": 0.8 },
        { "name": "clamp", "fit": true, "min_cover": "any", "quality": "FALLBACK_IF_METER_BOUND" } ],
      "crosscheck": { "code": "meter_vs_ct_export", "a": "meter", "b": "clamp", "slot_cover": 0.5, "rel": 0.05, "abs_kwh": 0.2 } } },
  "derive": { "home": "balance_capped_by_load" },
  "state": { "coverage_from": ["solar", "grid_import"], "partial_below": 0.8, "suspect_balance_below": -0.02,
             "provisional_if_absent": ["grid_import.meter"], "expect_meter": "bound_or_connection",
             "final_after_s": null } }
```

Bindings for the live GB home: `solar.clamp` gets the channel (`sunsynk_5min`, `plant:<id>/PV`, `solar_w`) with `fit_channel_id` the (`sunsynk_daily`, `plant:<id>/PV Generation`, `solar_kwh`) channel; `grid_import.meter` gets (`octopus_meter`, `<MPAN>`, `grid_import_kwh`); `grid_import.clamp` gets the Sunsynk grid import channel; and so on for the other four nodes and the charge level. These channels point at the existing series ids, so no fact moves.

**Worked example 2, FR (Linky + two inverter vendors).** Linky import and export come as 30-minute mean power (W) via the meter data hub, a day late; inverter A is a Sunsynk hybrid (PV string 1, battery, grid clamp); inverter B is another vendor (PV string 2 only, a lifetime energy counter every 15 minutes, on-change reporting with a 15-minute heartbeat):

```json
{ "code": "eu_meter_first", "version": 1, "method_version": "v4-bindings",
  "hold": { "from_channel": true, "default_cap_factor": 1.0 },
  "fit": { "window": "local_day", "accept": [0.6, 1.6], "closed_days_only": true, "check": { "rel": 0.1, "abs_kwh": 0.2 } },
  "measurands": {
    "solar": { "candidates": [{ "name": "inverters", "combine": "sum", "require": "all_bound", "fit": true }], "absent": "null" },
    "battery_charge":    { "candidates": [{ "name": "inverters", "combine": "sum", "require": "all_bound", "fit": true }], "absent": "null" },
    "battery_discharge": { "candidates": [{ "name": "inverters", "combine": "sum", "require": "all_bound", "fit": true }], "absent": "null" },
    "grid_import": { "candidates": [
        { "name": "meter", "min_cover": 1.0, "shape_from": "clamp", "shape_min_cover": 0.8, "quality": "MEASURED" },
        { "name": "clamp", "fit": true, "min_cover": 0.8, "quality": "FALLBACK" } ],
      "crosscheck": { "code": "meter_vs_ct", "a": "meter", "b": "clamp", "slot_cover": 0.5, "rel": 0.05 } },
    "grid_export": { "same_as": "grid_import" } },
  "derive": { "home": "balance" },
  "state": { "coverage_from": "per_measurand", "partial_below": 0.8, "provisional_if_waiting": ["grid_import.meter", "grid_export.meter"],
             "final_after_s": 604800 } }
```

Bindings: `solar.inverters` gets A's PV power channel (fit to A's PV daily counter) and B's PV counter channel; the battery measurands get A only; `load` is not bound, because A's load port does not see B's AC-coupled PV, so home is derived by balance. Linky channels carry `due_s` 129600 (36 h). A missing B makes solar `null` (not half), and the slot `missing` or `provisional`, never a confident under-count.

### 3.6 Resampling per kind

- **Instant (power, temperature).** Each sample holds until the next one, capped at `max_hold_s` of the channel (default: its `period_s`; for on-change reporting, the heartbeat). Beyond the cap is a gap, not zero. GB legacy keeps 300 s.
- **Interval energy.** Split by overlap (today's rule); optionally shaped by a finer channel (today's clamp shape). Overlapping intervals of different boundaries in one series are refused at validation, so they cannot be summed twice.
- **Interval mean** (Linky power, carbon). Energy = mean x duration; means are time-weighted.
- **Counter.** Stored as instant readings of a counter metric. Slot energy = difference of the register at the slot edges, interpolated linearly between the readings around each edge. A drop is a reset (new value counts from zero) or a wrap (`counter_wrap - previous + new`), flagged. Across an outage the difference is conserved and spread over the gap by time, or by a shape channel, flagged `INTERPOLATED`: the energy is not lost, unlike the 40-minute gap of experiment (c).
- **Event / state.** Change instants hold until the next change (capped by the heartbeat); the slot value is the share of time in the state; never interpolated.
- **Forecast.** Latest issue recorded before the slot started (`recorded_at`, fixing RC9), split by overlap.

### 3.7 Late data, corrections, idempotency, clock skew

- **Dirty days are written in the fact transaction**: `put*` inserts `(site_id, local_date)` rows for every changed fact's span into `dirty_day`. The build drains it. This replaces "recorded since this sync started" and survives crashes.
- **Rebuild in two passes.** Energy, allocation and price per dirty day are independent and run per day. The battery stock pass then runs sequentially from the earliest dirty day using the stored per-slot flows (no fact reads); at the measured 6 ms per day this is cheap.
- **Corrections** keep today's semantics: a new fact version supersedes the old; a `final` slot that changes gets `RESTATED`; the revision log records it.
- **Idempotency.** Each arrival gets an `ingest_receipt` with an event key: `(hub_id, seq)` for the hub link, the provider's event id for webhooks, and the content hash for pull windows. A duplicate key is logged as `duplicate` and not reprocessed. Within one batch, rows with the same key and time are reduced to the last one before writing; `recorded_at` is made strictly increasing per key (`max(now, previous + 1)`, as `devices.js:45` already does for attributes), which removes the collision of RC6.
- **Clock skew.** Keep device time and `received_at`. The hub reports skew (`architecture-v3.md` 5.5); the channel's `clock_offset_s` is applied in validation and the sample flagged. A timestamp later than `received_at + 120 s`, or before the channel existed, goes to the dead-letter queue.

### 3.8 Validation and the dead-letter queue

One module, run on every envelope, driven by metric and channel rows: unit known and converted; finite value; sign rule; range (`min_value`, `max_value`, scaled by capacity, for example PV power at most 1.3 x kWp per channel); time sanity (above); interval length and alignment; counter monotonic except detected resets; stuck value (no change over N periods where the measurand must vary, or PV above zero with the sun down) flagged `SUSPECT`; spike above the physical bound rejected. Rejected envelopes go to `dead_letter` with the raw id. **Replay**: after a normaliser or binding fix, re-run the pure normaliser on the raw ids of open letters; accepted envelopes become facts and mark days dirty; the letter becomes `replayed`. Retention must never delete a raw payload an open letter points to.

### 3.9 Source health and finality

`channel_health` is updated on every attempt and arrival. Status: `ok` (data within `due_s`), `late` (past `due_s`), `stale` (attempts succeed but return nothing: `consecutive_empty`), `down` (errors), `throttled` (429), `paused`. For each slot and candidate the engine computes **complete** (cover at least the candidate's `min_cover`), **waiting** (not complete and `now < slot_end + due_s` and the channel is not `down`), or **absent**. Then: the slot is `final` when the policy's preferred candidate is complete and not `SUSPECT`, or when every better candidate is absent and `final_after_s` has passed (quality `FALLBACK`); `provisional` while a better candidate is waiting; `missing` when no candidate gives a value. Resume points move by data time (`last_data_ts`), not by "the step did not throw".

### 3.10 Push and pull, backpressure, rate limits

Pull adapters keep their windows and `resumeDate`, but resume from `last_data_ts`. Push (MQTT hub link, webhooks) lands the raw batch and the receipt, acknowledges only after the commit (QoS 1 then redelivers safely, deduplicated by `seq`), and never waits for the build. Normalising runs from an inbox table in batches; if it falls behind, the broker and hub buffers absorb it (the hub decimates telemetry first, `architecture-v3.md` 5.5). Each provider gets a token bucket shared by all homes (generalising the Tariffscanner budget, `steps.js:254-260`), and a 429 sets `throttled` with the server's retry time instead of failing the step.

---

## 4. Staged migration plan

Rule for every stage: the GB dry-run hash is byte-identical before and after, unless the stage says otherwise; each stage is one revertable commit series; no fact row is rewritten. Efforts are **estimates** for one engineer who knows the code.

### Stage 0: a golden that can be trusted (estimate 1 to 2 days)

- **Why.** `test/golden-gb.test.js` reads a snapshot of `data/core.db` and is red at HEAD (`actual 528, expected 1008` slots); two tests in `slot-build.test.js` that also read the live snapshot fail ("some slots have carbon"). A moving live database cannot be the gate.
- **Do.** Add `test/golden-synthetic.test.js` and `test/fixtures/golden-synthetic.json`: build the three homes of `scripts/lib/multi-market.js` plus a 90-day GB home built like `cost.mjs` (deterministic seed, Octopus-style meters, Sunsynk-style daily counters, a DST day), dry-run every home, hash every column except `built_at`, and store per-day totals. Keep `golden-gb` but re-baseline it on purpose, with the owner, and only as a secondary check.
- **Accept.** Hash equal on two runs (measured: equal) and on Node 22 and 24; any one-character change in `build.js` constants flips it.
- **Rollback.** Delete the new test.

### Stage 1: ingest durability, no change to numbers (estimate 3 to 5 days)

- **Files.** `src/core/facts.js` (dirty days in the same transaction; batch reduction by time; strictly increasing `recorded_at`), `src/jobs/sync.js` (drain `dirty_day`; keep `earliestChange` as a second net; on agreement change mark days from the earliest changed agreement), adapters return `{ facts, empty }` and `step` records `consecutive_empty`, `src/db/deltas/070-ingest.sql` (`dirty_day`, `ingest_receipt`, columns on `connection` for `last_data_ts`, `consecutive_empty`).
- **Accept.** `restart.mjs` as a test: after a crash between write and mark, the next sync serves 21.6 kWh for the corrected day. The same-timestamp batch writes one row instead of failing. Four empty answers leave `last_data_ts` unchanged and resume from it. Golden unchanged.
- **Rollback.** Revert the commits; the delta is additive and its tables can stay empty.

### Stage 2: channels, bindings and the legacy policy as data, same numbers (estimate 5 to 8 days)

- **Files.** `src/db/deltas/071-binding.sql` (section 3.4 tables; the `series` rebuild with `channel` subject kind, ids kept), `src/core/bindings.js` (new: `inputsFor(site, asOf)` resolves bindings and policy to series ids), a backfill that creates channels for every existing series of every home and the `gb_legacy` policy row, `src/core/build.js` (replace lines 166-216 lookups with `inputsFor`; lineage labels come from the candidate names, `sunsynk_ct` kept as the clamp label for GB).
- **Accept.** For every synthetic and the live home, `inputsFor` returns exactly the series ids the old code read (unit test); golden byte-identical; a grep test asserts no vendor source literal remains in `build.js`; as-of rebuilds unchanged (`site-version-gb`, `forecast-bitemporal` tests).
- **Rollback.** Revert `build.js`; the tables are inert without it.

### Stage 3: one generic resampler and the policy interpreter, behind the legacy policy (estimate 8 to 12 days)

- **Files.** `src/core/resample.js` (section 3.6, with `gb_legacy` hold 300 s), `src/core/reconcile.js` (policy interpreter: candidates, combine, fit, shape, cross-checks, legacy `absent: zero` and `coverage_from`), `build.js` stages 1 and 2 call them; allocation, price, stock and checks unchanged.
- **Accept.** Golden byte-identical with `gb_legacy`; dual-run of old and new code over all synthetic homes gives zero differences; the RC1 and RC3 scenario tests pass under `eu_meter_first` (two inverters sum to 0.75; two meters to 0.6; partial payload gives `missing`).

### Later stages (each with its own `METHOD_VERSION` bump where numbers change)

4. Health model and finality from `channel_health` (estimate 4 to 6 days); GB moves to a deadline only by a deliberate policy version with a revision-log reason.
5. Shared validation and the dead-letter queue with replay; pure normalisers for Sunsynk and Octopus, so `explorer` can re-derive them (6 to 9 days).
6. Counter and event kinds; push ingest from the hub link with `(hub, seq)` receipts (8 to 12 days).
7. Move `planner-read.js`, `heat.js`, `trust.js` and `forecast.js` onto `resample.js` and bindings; delete `HOLD_S`, `READING_SOURCES` and the opposite forecast orders (4 to 6 days).
8. Two-pass rebuild (per-day energy, sequential stock) and multi-battery stock (5 to 8 days).

---

## 5. Test strategy

- **Golden.** The synthetic golden of stage 0 on every commit; the live golden only as an advisory check.
- **Contract tests per normaliser.** One trimmed real payload per source and endpoint in `test/fixtures/<source>/`, free of personal data (see `database-review.md` C1): `parse(body, channelMap)` equals the expected envelopes; parse is pure (runs twice, same output; no database handle given); unknown or missing required points produce dead letters, never zeros.
- **Scenario tests, one per matrix row.** Built from `exp.mjs`: synthetic multi-source homes (two inverters, two vendors, two meters, Linky-style mean power, a counter with a reset, a 7-minute skew, an outage, a stuck sensor, a partial payload, an empty answer, a crash before marking). Each asserts the "should" column, for example: two PV arrays sum to the truth within 0.1 %; a 40-minute outage with a counter gives the truth in the outage slots and leaves other slots untouched.
- **Property tests.** Energy is conserved across slot lengths (900, 1800, 3600 s: daily totals equal within 1e-9); a constant power sampled at 60, 300 or 900 s with a correctly declared period gives the same energy within 0.1 %; adding a channel bound to nothing changes nothing; permuting the arrival order of facts changes nothing; a counter and the instant power of the same synthetic device agree within 1 %.
- **Replay test.** Wipe the facts of a synthetic home, re-run the pure normalisers over its raw receipts, rebuild: facts and slot rows equal the live ones row for row.
- **Determinism and as-of.** Dry-run twice gives the same hash; an as-of rebuild never reads a fact or forecast recorded after its moment.

---

## 6. Risks and what not to do

- **Do not** change GB numbers silently. Every change of a rule is a new policy version and a `METHOD_VERSION` bump with a revision-log reason.
- **Do not** build an expression language for policies; use named rules and a closed set of options. It is the cheapest way to stay testable.
- **Do not** average or blend sources by default. Candidates are alternatives; channels inside one candidate add. Weighted least squares (`architecture-v3.md` 7.1) can come later as one named rule.
- **Do not** let validation delete anything. It flags or dead-letters; raw stays.
- **Do not** keep the fit as a gap filler. It hides outages (experiment c); with counters, gaps are filled by conservation and flagged.
- **Do not** let the engine read raw payloads or vendor names, or let a normaliser write to the database.
- **Do not** combine this with the move to Postgres; the tables above are plain SQL and move later as they are.
- **Risk:** the `series` table rebuild in stage 2. It is small and ids are kept, but it must run inside the delta transaction with `foreign_key_check` after it (`database-review.md` L2).
- **Risk:** finality deadlines change what users see as final. Ship them per policy, first on new homes.
- **Risk:** Sunsynk's terms forbid scraping (`sunsynk.js:3-5`); a partner API may change shapes, which is exactly what the normaliser contract tests catch.

---

## 7. Verified vs estimated

**Run and measured** (Node v24.22.1, macOS; the project declares Node 22 or later; temporary databases; `fetch` stubbed):

- Every number quoted in RC1 to RC6 and the matrix: `exp.mjs` (output `exp-output.json`) and `restart.mjs` (output `restart-output.json`), against the real `buildSite`, `normaliseDay`, `putReadings`, `putIntervals`, `landRaw`, `planner-read.series` and `syncSite`. Experiment homes have no tariff, so their rows also carry `CHECK_FAILED`; that flag is not part of any finding.
- Rebuild costs and dry-run hash stability: `cost.mjs` on 30- and 90-day synthetic homes (`cost-output.txt`). Times are from one laptop and indicate scale only.
- Literal counts: `grep` of quoted source codes over `src/core`, `src/jobs`, `src/server.js`.
- Test status at HEAD: `golden-gb` 0 of 1 pass (528 vs 1008 slots); `slot-build` 6 of 8; `multi-market` 8 of 8; `planner-read` 11 of 11. Contrary to the brief, `data/core.db` exists; it was opened only read-only by those tests' own snapshot step, and its contents were not inspected.

**Read from code, not run:** the tariff-agreement dirty range (`sync.js:184,192`); the Sunsynk empty `infos` path; first-inverter-only live flow; meter serials sharing a series; rate-limit behaviour of `http.js`; the forecast `issued_at` as-of gap in `build.js:223`.

- The section 3.4 DDL: executed as written on a fresh database created by `db.js` (`ddl.mjs`: all 9 objects created). The `series` rebuild is described, not run.

**Reasoned or estimated:** the target design and the policy format (the policy JSON is not interpreted by any code yet); stage efforts; the effect of deadband reporting on the 300 s hold (follows from experiment b and `architecture-v3.md` 6.3, not measured on a real hub); the Linky and second-vendor details of example 2 (illustrative shapes, not fetched).
