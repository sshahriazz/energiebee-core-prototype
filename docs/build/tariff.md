# Phase T: the slotted tariff baseline (build notes)

Branch `wp/tariff`, started from `f59ce42`. This file is written per step; each step says what is done, what is not, and how it was measured.

## Step A: T.1 price runs and T.2 fixed-charge shares

State at the end of step A: pure layer, table, store and differential tests done; the build still priced with `priceAt` / `priceOver` / `fixedOver`. Step B (below) switched the build to the new code and removed the old paths, so the sentences in this step about the build, the old functions and "what is left" describe step A's moment, not the code now.

### What was built

**Table `tariff_price_run`** (migration `20261118100000_tariff_price_run`, kind `serving`). One row per price change of a tariff, register, component and charge period, ex tax.

| Column | Meaning |
|---|---|
| `tariff_id` | the tariff (FK, ON DELETE CASCADE) |
| `site_id` | set only for the runs of a home-specific rate row (FK to `site`, ON DELETE CASCADE, R4); null = shared by every home on the tariff |
| `component`, `register`, `charge_period` | as in `rate_interval`: `unit`, `standing`, `fixed`, `capacity`; fixed charges are runs too |
| `payment_method` | as in `rate_interval`; the method a home pays is chosen when a price is read |
| `valid_from`, `valid_to` | seconds, `valid_to` null = open-ended, exclusive end |
| `price_ex_vat` | minor units per kWh (unit), per local day (standing), per period (fixed), per kW per period (capacity); ex tax |
| `estimated` | 1 = a cautious default by a stated rule (Tempo colour not published), 0 otherwise |
| `origin` | the origin of the rate rows (provenance vocabulary) |
| `lineage` | jsonb `{"rate_ids": [first 20 ids], "n": rows the run was made of}` |
| `built_at` | seconds |

Rules: CHECKs as on `rate_interval` (component, charge period required exactly for fixed and capacity, `valid_to > valid_from`, origin vocabulary); exclusion constraint `price_run_no_overlap` (tariff, component, register, charge period, payment method, home scope, `int8range(valid_from, valid_to)`); message registered in `EXCLUSION_MESSAGES` (`src/db/db.js`). No trigger. Indexes: `(tariff_id, valid_from)` and `site_id` where not null. Classified `serving` in `src/db/table-kinds.js`.

**`src/core/price-runs.js`** (pure: no database, no clock)
- `runsFromRates(rows)`: rate rows in force become runs. Two rows join only when the second starts exactly where the first ends and they agree on price, estimated flag and origin; other register, component, charge period, payment method or home scope never join. A gap stays a gap: no row, no run, no price (never guess).
- `runsFromWindows({ tariffId, ... expandWindows arguments })`: runs from register windows, the meter's own windows, calendars and register prices over a range, on demand (an unknown Tempo day is priced with the caller's cautious `estimate` and comes back `estimated`; without an estimate it throws, as before). Same shape and same joining as `runsFromRates`.
- `indexRuns`, `coveringRuns`, `runAt`, `runsOverlapping`: lookup. `runAt` chooses among the runs covering an instant exactly as `rateRow` chooses among rate rows (home-specific first, then the home's payment method, then any method, then methods that agree).
- `withRunsFromRates(p)`: a `loadPricing` context plus `runs`, made in memory. This is the path of a build "as known at" a past moment (trap 1): `loadPricing` has already read the rate rows as they stood then (`inForce`), and the same code makes the runs from them.

**`src/core/slot-price.js`**
- `priceAtRuns`, `priceOverRuns`: the price of an instant and of a whole slot from runs, returning the same object `priceAt` / `priceOver` return (unitEx, supplyEx, vat, levy, standingEx, fixed, tax, register, inputs, estimated, weighted). The register rules (windows, the meter's own windows, Intelligent Octopus dispatches), the taxes and the 15-minute sampling are pricing.js's own functions, so a number cannot move because it was read from a run; what changes is where unit, standing, fixed and capacity prices are looked up.
- `fixedShare(price, slot, slotS, tz)`: the fixed charges of one slot including tax (T.2): daily by the slot's share of its real local day (the number of slots in the day is worked out from the zone, so 23 and 25-hour days are exact), monthly and yearly and capacity by real seconds (`fixedChargePerSlot`), then the home's taxes (a plain factor for one percentage on everything, `applyTaxes` for anything else, such as the Dutch yearly credit). Same arithmetic order as `fixedOver`, so the result is the same floating-point number.

**`src/core/price-run-store.js`** (database)
- `materialiseRuns(tariffId)`: replaces the tariff's stored runs by the runs of its current rate rows (shared and home-specific). Idempotent: when the runs equal the stored ones nothing is written (`{ unchanged: true }`, `built_at` stays). Refuses inside `withKnownAt`: the table describes now.
- `materialiseHomeRuns(siteId)`: every tariff the home has a current agreement on (only tariffs in use are stored).
- `readRuns(tariffIds, siteId, from, to)`: the shared runs and the home's own overlapping a span, never another home's.
- `pricingWithStoredRuns(p, siteId, from, to)`: a `loadPricing` context with the stored runs, same window as the rate rows `loadPricing` read.

`src/core/pricing.js`: only `export` added to `ANY_REGISTER`, `agreementAt`, `registerAt`, `inputsOf`, `SAMPLE`, `periodLengths` so `slot-price.js` reuses them. No behaviour changed.

### Differential proof (trap 2)

`test/price-runs-lib.js` compares, for every slot, every meter kind (import, export, gas) and each slot length (900, 1800, 3600 s): `priceOverRuns` against `priceOver` with `deepStrictEqual` (every field, including `inputs` and `tax`), and `fixedShare` against `fixedOver` with `===`. Runs are taken both ways: in memory from the rows `loadPricing` read, and read back from `tariff_price_run` after `materialiseHomeRuns`. Result: equal everywhere, no tolerance.

| Test file | What it covers | Slot x kind comparisons (each against both run sources) |
|---|---|---|
| `price-runs-gb.test.js` | the frozen GB home, 5 Aug to 27 Oct 2026: a tariff with no rate rows (no price), Intelligent Octopus day/night and its 15 to 60-minute weighted slots, fixed export, gas, standing charges, the 25 October clock change | 42,357 (33,120 priced, 9,237 unpriced, 142 weighted) |
| `price-runs-synthetic.test.js` | the seven topology homes (flat GB, standing, export), and the three multi-market homes: GB flat then day/night (clock change, 50 half-hours), FR HP/HC with the meter's own hours (home-specific runs) then Tempo with its calendar and a monthly subscription (23-hour day), NL quarter-hour spot prices with monthly and daily fixed charges and the placeholder tax rules (25-hour day) | topologies 7 x 2,016 = 14,112; GB 2,541; FR 3,003; NL 2,541 |
| `price-runs.test.js` | hand-made contexts for what the homes do not hold: rows cut off the 15-minute grid, gaps, estimated rows beside published ones, Intelligent Octopus with dispatches (day/night rows, and a single time-varying list where a dispatch takes the cheapest rate of the day, and no learned window), Economy 7 from the meter's windows and without, windows-structure rows, home-specific rows, payment methods (own, any, agreeing, disagreeing), overlapping rows, standing + monthly + daily + yearly + capacity charges with a known and unknown contracted capacity, Dutch per-period taxes, `taxes_in_price` 0 and 1 | 25-hour day at three slot lengths for each case |

A negative check was run once by hand: making `runAt` ignore home-specific runs fails `price-runs.test.js` (tests 2 and 3).

Other tests in `price-runs.test.js`: how rows join into runs (price, estimated flag, origin, register, scope, gaps, open-ended rows), the lookup order, lineage (first 20 ids and the count), the table (replace, idempotent, follows a corrected row, other tariffs untouched, refuses inside `withKnownAt`, a home reads shared and own runs only, a deleted home takes its runs), fixed shares adding up (a day's slots add up to the day's charge on 23, 24 and 25-hour days at all three slot lengths; a month's slots add up to the monthly charge in March 2026 in Paris), expansion from windows and calendars equal to the unit rows `storeWindows` stored (FR HP/HC with the meter's own hours, FR HP/HC reference hours, Tempo; and an unknown Tempo day with a cautious default giving estimated runs), and the as-of build: runs made in memory from the rows as known before and after a price correction equal the rate-row path, while the table holds the corrected price.

`test/rules-tariff.test.js` breaks `price_run_no_overlap` on purpose (overlap, partial overlap, open-ended overlap, overlap of a fixed charge) and shows what is accepted (adjacent, other register, payment method, home scope, component, charge period, other tariff); it records `test/rules/tariff.json` (no triggers, one exclusion). `rules-all` and `table-kinds` pass with it.

### Measured

- GB fixture home: 3,109 current rate rows become 3,013 runs (half-hourly Agile prices change almost every slot, so little joins: 1,537 rows to 1,492 and 1,536 to 1,485). Synthetic multi-market homes: 328 rows to 324 runs (a day/night tariff 7 to 6, HP/HC 17 to 15, Tempo 7 to 6). A flat tariff cut into daily rows is one run (tested with 50 rows).
- Materialising every tariff of the fixture (14 tariffs): 348 ms first time, 79 ms when nothing changed. Synthetic homes: 77 ms and 19 ms.
- Test run times (one process each, 11-core machine shared): `price-runs-gb` 16 s, `price-runs` 15 s, `price-runs-synthetic` about 100 s (building the seven topology homes and the scenario dominates; the comparisons themselves take a few seconds per home).
- Regression suites run after the change and passing: `golden-gb`, `topologies`, `multi-market`, `site-version-gb`, `slots`, `delete-home`, `integrity`, `home-rows`, `put-rates`, `erasure`, `tounify`, `provenance`, `table-kinds`, `rules-all`, `rules-tariff`. The whole suite was not run (the integrator does that).

### Decisions and deviations from the plan

1. **Column name `price_ex_vat`, not `unit_ex`.** The table also holds standing, fixed and capacity prices, and the column means the same as in `rate_interval`, so a run reads like the row it came from and the pricing helpers (`inputsOf`, the origin labels) take either. It is ex every tax, as before.
2. **Extra columns** beyond the plan's list: `site_id`, `component`, `charge_period`, `payment_method`, `estimated` as 0/1 like `rate_interval`.
3. **No "current/superseded" on runs.** The plan asked for an exclusion constraint against overlapping current runs. The table is serving data replaced as a whole, so there is no history in it and the constraint covers every row. History stays in `rate_interval` (and the as-of path makes runs from it in memory).
4. **Home-specific rows and payment methods are runs of their own**, chosen when a price is read (`runAt`), as `rateRow` chooses among rows. The plan puts "home-specific rows and the meter's own windows" at the home layer (T.3); that is still where the choice is made, and the shared runs are not polluted by one home's rows. The meter's own windows, dispatches and taxes are not in the runs at all (home layer).
5. **Runs are made from the stored rate rows, not re-expanded from windows at materialisation.** A tariff of structure `windows` already stores its expanded unit rows (`storeWindows` writes them), so those rows are the runs. `runsFromWindows` is the on-demand expansion for catalogue tariffs not stored (plan rule 4) and a test proves it gives the same runs as the stored rows. Tempo estimates are stored as rate rows with `estimated = 1` by `storeWindows` and become estimated runs.
6. **`priceOverRuns` is a port of `priceOver`'s sampling and joining, and `fixedShare` of `fixedOver`**, not a call into them. They are kept as separate code on purpose, so the differential test compares two implementations; when the old path is removed (a later step) only the new one stays. `agreementAt`, `registerAt`, `taxesAt`, `inputsOf` and `periodLengths` are still pricing.js's and are reused by import until then.
7. **Order of runs that cover one instant.** When several runs cover an instant (rows of different payment methods or homes) they are ordered by start, then by the first rate row id of the run; the old code orders the rows by their own start and id. The two can differ only when rows of different keys start at different seconds inside one run's span and the choice then falls to "methods that agree" with different origins. No data in the tests has that, and the price chosen is the same in any case (the methods agree); only the origin label could differ.
8. **Prisma models not refreshed.** `prisma/schema.prisma` is pulled from the migrations (`scripts/refresh-prisma.js`); it is left to the integrator to avoid merge conflicts between branches. Nothing at runtime reads the Prisma models (raw SQL only).
9. **The new code is not called by the build, the queue or any route yet.** `materialiseRuns` is called only by tests. No rebuild hook (T.5), no `supply_price_slot` (T.3), no change to stage 4 (T.4).

### What the differential does not cover

- The fixture's Intelligent Octopus dispatch facts: the GB home test prices register `night` 3,464 times from the learned off-peak window and whatever dispatches the data holds (not counted separately); the dispatch overlay itself (a dispatch pulling a day slot to the night rate, from :15 and :45 starts, and the cheapest-of-the-day fall-back) is covered by the hand-made cases in `price-runs.test.js`.
- Estimated slots: none of the three real or synthetic home ranges has an estimated rate row. Estimated joining and the weakening of a slot that spans an estimated and a published price are covered by the hand-made case and by the Tempo expansion test.
- Real tounify or Tariffscanner data: `taxes_in_price` and payment methods are covered by hand-made contexts, not by those fixtures; their own tests were not touched.

### What is left (not done)

- T.3 `supply_price_slot` (per home and supply point, at the home's slot length, with taxes, dispatch overlays, fixed share and lineage), its table and builder, and sub-meter tariffs.
- T.4 stage 4 of `build.js` reading the slots; then removal of `priceAt`, `priceOver`, `fixedOver`, `fixedPerDay` and their callers (`build.js`, `server.js`, `heat.js`, `forecast.js`, `explorer.js`, `explain.js`, `compare.js`) with no fallback. The differential tests of this step are the proof to run before that removal; they stop being possible once the old path is gone, so they become the golden-based tests (`golden-gb`, `topologies`, `site-version-gb`) plus slot-level assertions.
- T.5 dirty marking: a changed rate row, window, tax rule or agreement marks the tariff's runs dirty, queued once per tariff (`rebuild_queue`), calling `materialiseRuns`; new Agile prices extend the timeline.
- T.6 comparison and the tariff picker reading the same slots.
- Future horizon (14 days of known prices) and the hub download of future slots.
- Consumption-dependent charges (tiers, peak demand): not present in the data; runs carry rates only.
- `prisma/schema.prisma` refresh and the integrator's edits to `docs/fix-list.md`, `docs/database.md`, `README.md` and the plan.

### How to run the tests

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/tariff
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/price-runs.test.js
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/price-runs-gb.test.js
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/price-runs-synthetic.test.js
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/rules-tariff.test.js test/rules-all.test.js test/table-kinds.test.js
# re-record the rule catalogue of this area after changing the table's rules:
UPDATE_RULES=1 TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/rules-tariff.test.js
```

## Step B: T.3 supply price slots, T.4 the build reads them, T.5 the dirty queue

State: done as scoped. The build prices every slot through `src/core/supply-price.js`; `priceAt`, `priceOver`, `fixedOver` and the rate-row fallbacks are gone from `src/` (the names remain only in historic docs). Not done: T.6 (comparison and the tariff picker reading the slots), see the end.

### What was built

**Table `supply_price_slot`** (migration `20261118100100_supply_price_slot`, kind `serving`). One row per home (`site_id`), supply point (`point`), slot length (`dur_s`) and slot (`slot_start`), unique on those four. `point` is the meter kind (`meter_import`, `meter_export`, `meter_gas`) or `device:<id>` for a sub-meter with a tariff of its own. Columns: `device_id` (the meter the agreement is on, to be repointed to the meter thing in Phase 1.3) and `tariff_id`, `register`, `unit_ex`, `supply_ex`, `vat`, `levy`, `unit_inc`, `fixed_inc` (the slot's share of the fixed charges, taxes included), `weighted`, `estimated`, `capacity_unknown`, `tax_source`, `tax_unverified`, `lineage` (jsonb: tariff code and the inputs with their origin), `stamp`, `built_at`. A slot with no price known has a row with `unit_ex` NULL; a slot with no agreement has a row with `device_id` and `tariff_id` NULL (checked), so both are known and not made again. Foreign keys to `site`, `device` and `tariff` are `ON DELETE CASCADE`. It has no triggers and no exclusion constraint (CHECKs and one unique key), so `test/rules-tariff.test.js` is unchanged; its CHECKs are exercised in `test/supply-price.test.js`.

**Table `tariff_price_state`** (kind `serving`): the fingerprint of the rate rows a tariff's runs were made from. **Table `price_dirty`** (kind `runtime`): the marks of T.5 (below). Both are in `src/db/table-kinds.js`.

**`src/core/supply-price.js`**
- `supplyPricer({ siteId, p, slotS, tz, materialise, persist })`: `load(slots)` then `get(point, slot)` returns `{ price, fixedInc }`. The slot is made by `slotPrice` and `fixedShare` from `slot-price.js` (the same maths as step A): agreement, runs, home-specific rows, meter windows, taxes, dispatch overlays, fixed share, lineage.
- `materialise: true` (a current build) reads the home's stored slots and makes and stores only the missing ones; `false` (a build as known at a moment, the trace of one slot) computes every slot in memory and writes nothing. A dry run reads but does not store.
- Each row carries `stamp`, a sha1 of every input that does not depend on the span: the home's current agreements, each tariff's columns and its rate rows' own fingerprint (`rateStamps`), the meters' windows, the country's tax rules and the VAT table, the smart-charge dispatches, the learned off-peak window, capacity, zone, slot length and the method (`PRICE_METHOD`). A row of another stamp is never read. So a change made by anything that bypasses the write functions (a test, psql) is never served stale; the marks only decide when homes are rebuilt, not what is true.
- Sub-meters (R11): `supplyPoints` finds each device with an agreement that is not a main meter kind; `readSubMeterFacts` reads its energy (`heatpump_elec_kwh`, `ev_charge_kwh`, `immersion_kwh`). In the build the sub-meter's energy, bounded by what the home drew from the grid for itself (`min(kWh, gToHome)`), is priced at the sub-meter's tariff and the difference to the main import price is added to `grid_to_home` cost and to `grid_only_cost`; its fixed share is added to the standing charge; its lineage (`sub_meters`) names device, tariff, energy and both prices. A slot where the sub-meter's price is unknown keeps the main price and says `unpriced`.
- `dropOtherLengths`: a changed slot length drops the home's rows of the old length.

**T.4, `build.js` stage 4** takes `{ price, fixedInc }` from `pricer.get` in place of `priceOver` and `fixedOver`; everything after it (costs, battery stock, lineage, quality) is unchanged. `loadPricing` reads runs from `tariff_price_run` for a current read (made fresh first by `ensureRuns` if the rate rows' fingerprint changed) and builds them in memory from the rate rows of the moment for an "as known at" read; it reads the rate rows themselves only for those reads and for `explain.js` and the explorer (`{ rateRows: true }`). `heat.js`, `forecast.js`, `planner-read.js`, `explain.js`, `explorer.js`, `signup.js`, `server.js` call `slotPrice` / `instantPrice` / `fixedShare` from `slot-price.js`; `compare.js` prices its alternative tariffs with `withRunsFromRates`. `priceAt` is now `instantPrice`, `priceOver` is `slotPrice`, `fixedOver` is `fixedShare` (the old bodies are deleted, not wrapped).

**T.5, `src/db/price-dirty.js`, `src/core/price-marks.js`, `src/core/price-queue.js`.** Marks are written by the write functions, not by triggers, so "as known at" decisions stay in code:
- `putRateRows`, `storeWindows` (when rows are superseded), `putWindows` of a tariff, the Octopus and tounify `putRates` mark the tariff (`price_dirty` scope `tariff`, from the earliest start written).
- `putWindows` for a meter's own windows, `agreeTariff`, `supersedeAgreements`, and ending a connection (`devices.js`) mark the home (scope `home`).
- `syncGbVat` and `syncVatRules` (tax rules, `db.js`) mark the country (scope `country`, from the first rule that differs), only if the country has a home.
- One mark per tariff, country or home; a later mark keeps the earlier time (`LEAST`).
- `processPriceQueue` works each mark once, claimed with `FOR UPDATE SKIP LOCKED` in its own transaction (a failure leaves the mark; two workers never take the same one). A tariff mark makes the tariff's runs again once, however many rows changed; only if the runs came out different are the homes on the tariff queued, in batches (default 100 homes per INSERT) into `rebuild_queue` from the change time to now. The part of a change that lies ahead (a new Agile day) rebuilds nothing: `extendTimeline` makes and stores the homes' price slots from now to the last known price (at most 14 days, `HORIZON_S`); a later publication only adds the new day's slots. Slots with no published price are rows with no price, never a guess.
- It runs at server start (replacing the old `vatRulesChanged` block in `server.js`) and in `syncSite` before the home's rebuild, so the home's own rebuild covers what changed in its prices since its last sync.
- A home is queued from the change time but no earlier than its first data (first built day or first energy fact); a home with neither is not queued, because its first build prices from the start and a request from 1970 would build every day since. This was found by `test/tounify.test.js` hanging (a request from time 0 for a home with no facts built 20,000 days); `test/price-queue.test.js` has a test for it.

### Proof that the numbers did not move (trap 2)

1. Before the old code was removed, its output was recorded as hashes in `test/fixtures/price-slots-ref.json` (step A's differential tests were run against it). In this step I checked the hashes independently: a checkout of step A's last commit (`02906db`, old code still in place) priced every slot of the GB fixture home (5 Aug to 27 Oct 2026, including the 25-hour day on 25 Oct) with `priceOver` and `fixedOver` at 900, 1800 and 3600 s for import, export and gas (42,357 slot-kind comparisons) and the nine hashes equal the recorded ones. The new code produces the same hashes (`test/price-runs-gb.test.js`, `price-runs-synthetic.test.js`, `price-runs.test.js`: the topology homes, the GB, FR and NL multi-market homes and the hand-made cases), from runs made in memory and from the table, whole price object and fixed share compared.
2. `golden-gb`, `site-version-gb`, `topologies` (fingerprints), `multi-market`, `slot-build` and the other suites listed below pass with no change to any golden or fingerprint. The only fixture added is `price-slots-ref.json`; `test/fixtures/gb-home.json.gz`, `golden-gb.json` and the topology fingerprints are untouched.
3. `test/supply-price.test.js`: a current build and a build as known at a later moment give the same rows; a second build reads the stored slots and stores nothing; a dry run and an as-of build write nothing; a stale row (rate row, tax rule or agreement changed behind the write functions) is never read; 15-minute homes store 96 slots a day; the 25-hour day has 50 slots whose fixed shares add up to the standing charge, from the table as from the code.

### Tests changed on purpose

- `test/slots.test.js`, `tounify.test.js`, `tariff-picker.test.js`, `price-runs*.test.js`: they called `priceAt` / `priceOver`; they call `instantPrice` / `slotPrice` (same objects) and a pricing context now carries `runs` instead of rate rows alone. Expectations are unchanged.
- `test/price-runs-lib.js` no longer calls the old functions: it compares against the recorded hashes (see above).

### Measured

GB fixture home, 37 days / 1,778 slots, process CPU time in ms (user + system, minimum of 7 runs; the machine was shared and loaded, so wall times varied by a factor of two and these are only indicative; step A's checkout `02906db` against this one, two rounds each):

| | before (old path) | after |
|---|---|---|
| dry-run build now, computed in memory | 529 / 538 | 752 / 816 |
| dry-run build as known at a moment (15 days) | 333 / 366 | 390 / 400 |
| stored build, first (cold, slots made and stored) | 2,284 / 2,947 | 2,495 / 3,132 |
| stored build again (slots read) | 1,706 / 1,703 | 1,626 / 1,789 |

So the full rebuild is not faster: the stored rebuild is about the same, the in-memory path costs about 15 to 45 percent more (a price object and a fixed share are made for every point of every slot, including slots the old stage 4 priced lazily). A first profile showed the zone arithmetic of `dayBounds` taking most of the extra time; it is now remembered per zone and date (`time.js`), which brought the as-known-at path close to the old one. The gain of the table is for reads that do not build: future prices, the planner, comparison; those are T.6.

### Decisions and deviations from the plan

1. **A stamp on every row instead of trusting the marks.** The plan makes the marks the only way a slot becomes stale. Here a row is read only while its stamp equals the current one, so a change that bypassed the write functions cannot be served stale; the marks (T.5) queue the rebuilds. Cost: one aggregate per input table per build (about ten small queries).
2. **No-agreement slots are rows** (with NULL device and tariff) so they are known and not recomputed.
3. **Slots are made only for what is read**: a current build makes the days it builds; `extendTimeline` makes the known future (up to 14 days) when prices are published. There is no job that fills the whole horizon for every home.
4. **Sub-meter energy is bounded by the grid draw for the home** (`min(kWh, grid_to_home)`), so energy the sun or the battery supplied is never counted as bought. The plan does not say; this is the cautious choice.
5. **A tariff mark re-makes the runs once; homes are queued only if the runs changed.** A rate row rewritten with the same price queues nobody.
6. **Marks are not triggers.** As the task says; a test (`price-queue.test.js`) shows each write function leaves its mark.
7. **`processPriceQueue` is called at start-up and in `syncSite`**, not on a timer of its own. A change made while the server runs is worked off at the next sync of any home or at the next start.
8. **`prisma/schema.prisma` is not refreshed** (integrator, as in step A).

### What is left (not done)

- T.6: the comparison (`compare.js`) and the tariff picker still price from runs in memory, not from `supply_price_slot`; the planner, forecast, heating, explorer and explanation code use `slotPrice` over the current runs. They give the same numbers, but they do not read the table.
- A scheduled job that fills the 14-day horizon for every home (today only a published price extends it) and the hub download of future slots.
- Consumption-dependent charges (tiers, peak demand): not in the data.
- Whole-suite run: not done (the integrator runs it).

### Tests run in this checkout (all passing, each seen to pass)

`supply-price` (10), `price-queue` (7), `price-runs` (11), `price-runs-gb`, `price-runs-synthetic` (10), `rules-tariff`, `rules-all`, `table-kinds`, `golden-gb`, `site-version-gb`, `topologies` (8), `multi-market` (8), `core` (9), `slots` (7), `slot-build` (8), `slot-rebuild-range`, `rebuild-converge`, `compare-market`, `tax-apply`, `tax-eu-vat`, `tax-gb-vat`, `tariff-picker`, `tounify` (33), `tariffscanner` (15), `put-rates`, `explain`, `explorer`, `explorer-gb`, `heat`, `heat-gb`, `forecast-bitemporal`, `planner-read`, `signup`, `delete-home`, `integrity`, `home-rows`, `erasure`, `provenance`, `multi-device`, `rate-interval`, `octopus-tariff`, `sync-plan`, `tariff-expand`, `register-window`, `time`, `http`.

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/tariff
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/supply-price.test.js
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/price-queue.test.js
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/golden-gb.test.js test/site-version-gb.test.js test/topologies.test.js
```
