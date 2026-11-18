# Phase T: the slotted tariff baseline (build notes)

Branch `wp/tariff`, started from `f59ce42`. This file is written per step; each step says what is done, what is not, and how it was measured. A step's text describes the code at the end of that step; step C (the last) says what changed after it. For the state now, read "Phase T as it stands" at the end.

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
- `processPriceQueue` works each mark once, claimed with `FOR UPDATE SKIP LOCKED` in its own transaction (a failure leaves the mark; two workers never take the same one). A tariff mark makes the tariff's runs again once, however many rows changed, and every home on the tariff is queued, in batches (default 100 homes per INSERT) into `rebuild_queue` from the change time to now (round 1 of the review: the first version queued homes only if the runs came out different, which lost the change whenever a read had made the runs again first; see the end of this file). The part of a change that lies ahead (a new Agile day) rebuilds nothing: `extendTimeline` makes and stores the homes' price slots from now to the last known price (at most 14 days, `HORIZON_S`); a later publication only adds the new day's slots. Slots with no published price are rows with no price, never a guess.
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
5. **A tariff mark re-makes the runs once and queues every home on the tariff** (changed in review round 1: the first version compared the runs with the stored ones and queued nobody when they were equal, but any current read makes the runs again as soon as the rate rows change, so the comparison said "unchanged" for a change nobody had worked off). The writers mark only when a row really changed, and a rebuild stops where the days come out as stored (R9), so a mark that changed nothing costs little.
6. **Marks are not triggers.** As the task says; a test (`price-queue.test.js`) shows each write function leaves its mark.
7. **`processPriceQueue` is called at start-up and in `syncSite`**, not on a timer of its own. A change made while the server runs is worked off at the next sync of any home or at the next start.
8. **`prisma/schema.prisma` is not refreshed** (integrator, as in step A).
9. **`supply_price_slot` differs from the plan's T.3 column list** (plan: home, supply point, slot_start, dur_s, tariff_id, register, unit_ex, tax, unit_inc, export_unit, fixed_share, estimated, origin, lineage). Hub and Phase 1 code must use the names here: no `export_unit`: export is its own supply point, a row with `point = 'meter_export'` (its price is its `unit_ex` / `unit_inc`); no `origin` column: the origin of each input is in `lineage.inputs`, and `tariff-slots.js` `slotView` shows it; `fixed_share` is `fixed_inc` (the share with taxes); `tax` is split into `vat`, `levy`, `tax_source` and `tax_unverified`; extra columns `supply_ex` (the supplier's price before levies), `weighted` (a price weighted over two prices in the slot), `capacity_unknown`, `stamp` and `built_at`. `site_id`, `point`, `dur_s`, `slot_start` are the key.

### What is left (not done)

- T.6: the comparison (`compare.js`) and the tariff picker still price from runs in memory, not from `supply_price_slot`; the planner, forecast, heating, explorer and explanation code use `slotPrice` over the current runs. They give the same numbers, but they do not read the table. (Done in step C for the comparison and the picker; the planner, forecast, heating, explorer and explanation code still price with `slotPrice`, see step C.)
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

## Step C: T.6 comparison and picker, T.7 API, exit criteria

State: done as scoped. The comparison and the tariff picker price from slots; the two endpoints exist with per-user access; the exit criteria are tests. No golden, fingerprint or recorded hash moved; one fixture was added (`test/fixtures/compare-ref.json.gz`).

### What was built

**`src/core/tariff-slots.js`** (new). A candidate tariff, or a tariff as such, as slots, made by the same code as the home's own bill (`supplyPricer` over `slotPrice` and `fixedShare`).
- `candidatePricing(base, candidates, siteId, from, to, runs?)`: a pricing context in which a stand-in agreement puts the home on each candidate tariff for all time (`standIn`: `valid_from` 0, no end, the candidate's own columns); the home's taxes, zone, contracted capacity and dispatches stay, its own agreements are out. `candidateRuns` reads the candidates' runs once: current runs from `tariff_price_run` (made fresh by `ensureRuns` if the rate rows changed) for a current read, or made in memory from the rate rows of the moment inside `withKnownAt` (the same two ways `loadPricing` reads them), so one read can be shared by several scenarios.
- `candidatePricer({ siteId, pricing, slotS, tz })`: `supplyPricer` with `materialise: false`: the candidate's slots computed in memory, nothing stored. Only tariffs in use have stored runs (plan rule 4); a candidate's runs are made on demand by the same pure function and kept in `tariff_price_run` like any other tariff's. There is no `supply_price_slot` row for a candidate, because that table is "this home on its own tariffs" and a candidate is not.
- `slotMoney(imp, exp, importSlot, exportSlot)`: the money of one slot, energy times the slot's price including tax, plus the import slot's share of the fixed charges. `unitInc(price)` (in `slot-price.js`) is the one expression `unitEx * (1 + vat)`; the build, the comparison and the API use it. (The build's gas cost line keeps its own product on purpose: `gas * unitEx * (1 + vat)` is not the same float as `gas * (unitEx * (1 + vat))`, and the goldens hash the bits.)
- `tariffSlots(tariff, { site, from, to, slotS })`: a tariff's slots over a span, for a home (zone, taxes, own rows, contracted capacity, the meter windows of the home's meter that is on that tariff, the home's slot length by default) or, with no home, for the tariff's own market (zone from `src/db/seed/markets.js`, the country's tax rules, shared runs only). A tariff in a currency other than the home's is refused (no FX).
- `homePriceTimeline(site, { from, to, points })`: the home's price slots per supply point over a span, past and future: the stored ones where `supply_price_slot` has them with a valid stamp, the rest computed in memory by the same code; a read stores nothing. `supplyPricer.load(slots, only)` takes an optional list of points so a one-point read does not load the others.
- `dayPrices(site, tariff, date)`: the supplier's price before tax in each 15-minute slot of a local day, for the tariff picker's preview.
- `slotView`: a slot as the API shows it (the columns of `supply_price_slot`, `known`, and the weakest origin of its inputs).

**Comparison (`compare.js`).** The home's own scenario reads its slots with `supplyPricer({ materialise: true, persist: false })` (the stored slots, computed where missing, nothing written); each alternative is a `candidatePricer` over the candidate's runs. Every scenario's cost of a slot is `slotMoney(import kWh, export kWh, importSlot, exportSlot)`. The old per-slot `fixedPerDay(...) * share-of-day` is gone: the fixed charge is the slot's own `fixedInc` (`fixedShare`), the same figure the build books. The scenarios, insights and the "like-for-like" rule (a slot counts only if every tariff has a price) are unchanged.

**Tariff picker (`tariff-picker.js`).** `priceSummary` (the price preview and the list of previewed tounify tariffs) reads `dayPrices`: 96 slots of 15 minutes of the day, one price, a peak and an off-peak price, or the day's lowest, highest and time-weighted mean. The choice of day (today, else the latest day the home has runs for) reads `tariff_price_run`. `tsOption` (the Tariffscanner catalogue listing, rate rows by payment method with their labels) is not a slot view and is left as it was.

**API (`src/routes/prices.js`, mounted by one line in `src/server.js`).**
- `GET /api/tariffs/:id/slots?from&to&slot_s&site`. `:id` is the tariff id or its code. Times are epoch seconds or `YYYY-MM-DD` (local midnight in the home's zone, or the tariff's market zone when no home is named; a date with no zone is a 400). Default: today and tomorrow, at the home's slot length (30 minutes with no home). Answer: `{ tariff, tariff_id, point, currency, country, tz, slot_s, from, to, priced_for: { site } | { market }, known, unknown, priced_until, generated_at, slots: [{ slot_start, dur_s, tariff, register, unit_ex, supply_ex, vat, levy, unit_inc, fixed_inc, known, weighted, estimated, capacity_unknown, tax_source, tax_unverified, origin }] }`. A slot with no price has `known: false` and null prices, never a guess.
- `GET /api/sites/:id/prices?from&to&point`. The home's slots per supply point (`meter_import`, `meter_export`, `meter_gas`, `device:<id>`; `point` may repeat). Default: today and seven days ahead. Answer: `{ site, currency, tz, slot_s, from, to, stored, computed, points: [{ point, kind, device_id, slots, known, unknown, priced_until, slots: [...] }] }`; `stored` is the number of slots read from the table, `computed` the number made on the spot.
- A read covers at most 62 days; `slot_s` is 900, 1800 or 3600; every bad input is a 400 with the reason.
- Access: `/api/sites/:id/prices` is under the existing home guard (`canSee`) and checks again; a home the user may not see is `404 No such home`, as for any home route. `/api/tariffs/:id/slots` with `site=` checks the home the same way. A tariff is visible if it has a shared rate row, or if it is known only through home-specific rows or agreements and the user may see one of those homes (admins see all); otherwise `404 No such tariff`, the same words as for a tariff that does not exist. With no home named only the shared runs are read, so one home's own prices of a tariff are never in an answer about no home.

### How as-of builds work (trap 1)

One code path for the maths, two ways to read it:
1. **Current**: the tables serve it. `loadPricing` reads runs from `tariff_price_run` (made fresh by `ensureRuns` when a tariff's rate-row fingerprint changed), the build and the comparison read the home's slots from `supply_price_slot` (each row valid only while its `stamp` equals the stamp of the inputs now), and compute and store the slots that are missing.
2. **As known at a moment** (`buildSite(..., { asOf })`, or any read inside `withKnownAt`): `loadPricing` reads the rate rows, windows, tax rules and tariff columns as they stood then (`recorded_at` / `superseded_at`), makes the runs in memory with `runsFromRates` (the very function that fills the table), and the build's `supplyPricer` has `materialise: false`: every slot is computed in memory by `slotPrice` and `fixedShare` from that context. Nothing is read from or written to `supply_price_slot` or `tariff_price_run`, so the past is never mixed with the table, which describes now. `candidateRuns` follows the same rule for candidates; a dry run (`opts.dryRun`) computes the same and writes nothing.
3. Proof: `test/supply-price.test.js` (a current build and an as-of build at a later moment give the same rows; an as-of build writes nothing), `test/compare-slots.test.js` (a candidate's slots from rate rows of a moment equal those from the stored runs, whole answer), `golden-gb` and `site-version-gb` (the as-of builds of the real home, unchanged).

### Proof that the comparison did not move (trap 2)

`test/fixtures/compare-ref.json.gz` was recorded with the code of the commit before this step changed `compare.js` (`bca6110`, which priced an alternative with `slotPrice` and the home's own tariff with `slotPrice` and `fixedPerDay` per slot): for each of four homes, every scenario's totals (`importCost`, `exportCredit`, `standing`, `net`, averages, per-year), every day, the average-day profile, the windows, the insights text and every slot's seven numbers:

| Home | Alternatives | Slots | Skipped |
|---|---|---|---|
| real GB home, 12 to 26 Oct 2026 (the real Agile and Agile Outgoing prices, the 25-hour day) | Agile, Agile + Agile Outgoing | 693 | 0 |
| synthetic GB home, 3 days over the clock change | Agile, Agile + Agile Outgoing (synthetic half-hours with a gap and a negative price) | 144 | 2 |
| synthetic FR home (HP/HC, Tempo; 23-hour day) | a flat tariff with standing and a monthly charge | 190 | 0 |
| synthetic NL home (quarter-hour spot, placeholder taxes; 25-hour day) | a flat tariff; a tariff with daily, monthly and yearly charges | 292 | 0 |

The new code is compared with the recorded numbers to 1e-9 relative (`near`); everything else (keys, text, counts, origins) must be identical. It passes. The only differences are in the last bits of the fixed charge, which is now shared per slot instead of per day. `compare-market`, `multi-market`, `tariff-picker`, `tounify`, `tariffscanner` pass with their expectations unchanged.

### Exit criteria, as tests

- **`test/price-exit.test.js`, no gaps inside validity.** For every home in the database (the real GB home, the seven topologies, the synthetic GB, FR and NL homes) and every current agreement, the tariff's unit runs are cut into contiguous blocks; inside each block, within the agreement and over its last 60 days (to 8 days ahead), every slot at 15, 30 and 60 minutes, across the clock changes, has a price. Measured: 11 homes, 36 agreements, 24 blocks, 39,488 slots, all priced. 9 agreements are of tariffs with no rate row at all (the fixture holds old agreements of tariffs it has no prices for): they have no validity, are counted, and are not skipped silently. A home whose day/night tariff has no switch times for its meter prices nothing, and the check finds it (negative test). Those 9 agreements have no price source: this is not "gapless", it is "nothing to be gapless" (some of them overlap the fixture's data period: Intelligent Octopus fix to 2026-08-15, gas variable to 2026-09-15; their slots have no price and are not guessed). The block check cannot see a hole in the runs themselves (a block is made of the runs), so a second, independent test (round 1 of the review) checks the runs against the agreements second by second, see the end of this file.
- **A price timeline at least seven days ahead.** The real GB home's `homePriceTimeline` from now to nine days ahead: import (Intelligent Octopus: day and night registers from the learned window) and export have a price in every slot and are priced until at least `now + 7 days`; the day repeats; after a `supplyPricer` with `materialise: true` has loaded the slots, the table holds 8 days of slots ahead and the API reads them all from the table. Over HTTP (`tariff-api.test.js`): the default read of `/api/sites/1/prices` is priced 7 days ahead for import and export, with nothing stored by the read.
- **A comparison gives the same totals**: above.

### Tests added

`test/compare-slots.test.js` (11 tests: the four homes' comparison against the recorded numbers; the comparison reads the stored slot and writes nothing, shown by changing a stored price and seeing the comparison follow; as-of candidate slots equal current; `slotMoney`), `test/tariff-api.test.js` (8: stored slots equal the pricing code, seven days ahead, 25-hour and 23-hour days, missing means missing, hour slots are the weighted mean of two half-hours, 404 for another user's home and tariff, admin sees all, every 400), `test/price-exit.test.js` (15: one test per home, the tally, the negative test, the timeline, the table). The rules tests are unchanged: this step adds no table, trigger or constraint.

### Measured

Process CPU time, minimum of 7 runs after one warm-up, shared and loaded machine (indicative):

| | before (`bca6110`) | after |
|---|---|---|
| `compareSite`, real GB home, 15 days, 693 slots, 3 scenarios | 40 / 58 ms | 85 / 104 ms |
| `homePriceTimeline`, 8 days ahead, 3 points, 30 minutes (computed on the spot) | n/a | 24 ms |
| same, import only | n/a | 14 ms |
| `tariffSlots`, Agile, 2 days, no home | n/a | 6 ms |
| `tariffSlots`, Agile, 31 days, home, 15 minutes (2,976 slots) | n/a | 57 ms |

The comparison costs about twice as much CPU as before (about 45 ms more for 15 days): it now reads the home's 1,386 stored rows (parsing each row's lineage), takes the stamp of the home's inputs (about ten small queries) and reads the candidates' runs through the table. The absolute figure is small; I did not tune it.

### Decisions and deviations from the plan

1. **A candidate is not stored in `supply_price_slot`.** The plan says a candidate's cost is "the home's slot energy x the candidate's slots, the same code". The candidate's slots are made by the same `supplyPricer` code in memory from its price runs; the table keeps only the home's own supply points. Storing every candidate for every home would multiply the table by the catalogue (about 8,400 tariffs) for a read that is cheap to compute (6 ms for two days).
2. **The home's own scenario reads the table but never writes it** (`persist: false`): a comparison is a read. The build, `extendTimeline` and nothing else fill the table.
3. **The comparison's fixed charge is the slot's `fixedShare` (the build's number), not `fixedPerDay` spread by day**, so the comparison's "current" scenario now books exactly what the home's bill booked, including monthly and yearly charges by real seconds. For the recorded homes the totals agree to 1e-9; they differ from the old code only in the last bits.
4. **The picker's preview is read at 15-minute slots**, whatever the home's length, so a price that changes inside an hour or half-hour is still seen as two prices (the old code read the rate rows). It reads the supplier's price (`supplyEx`), before tax and levies, like the old rows. A price with no known register (a day/night tariff with no meter windows) is not shown, where the old code listed every register's row.
5. **The tariff API without a home reads only shared runs**, so one home's private prices never appear in a tariff answer about no home; this means a tariff known only through one home's rows has no price in the no-home answer (`known: 0`) and needs `site=`.
6. **A day/night tariff needs a meter's switch times**: `GET /api/tariffs/:id/slots?site=` uses the windows of the home's meter that is on that tariff; with no home, or no such meter, its day/night slots are unpriced (never a guess). A tariff whose windows are its own (France, Tempo, any `windows` structure) is priced either way.
7. **The default span** of `/api/sites/:id/prices` is today and the next seven days; a read is capped at 62 days. `extendTimeline` still keeps at most 14 days stored ahead.
8. **`prisma/schema.prisma` and the shared docs are not touched** (integrator).

### What is left (not done)

- The planner, forecast, heating, explorer and explanation code still price with `slotPrice` over the current runs (same maths, same numbers), not from `supply_price_slot`. The home timeline in Phase 3.4 should read `supply_price_slot` or `homePriceTimeline`.
- No scheduled job fills the 14-day horizon for every home (only a published price extends it, `processPriceQueue`), and nothing sends future slots to the hub (`down/data`).
- Consumption-dependent charges (tiers, peak demand) are not in the data.
- The comparison's CPU time is about twice the old; no tuning was done.
- The whole suite was not run (the integrator runs it). Tests run here: see the end.

### Phase 1.3: tables and columns to repoint from device to thing

The supply point is the meter device today. When devices become things, these must follow (names stay plain until then):

| Table / place | Column | Today | Phase 1.3 |
|---|---|---|---|
| `supply_price_slot` (this work, migration `20261118100100`) | `device_id` (FK to `device`, ON DELETE CASCADE, index `supply_price_slot_device`) | the meter device the agreement is on; null with no agreement (CHECK `(device_id IS NULL) = (tariff_id IS NULL)`) | the meter thing's id (and its FK) |
| `supply_price_slot` | `point` | the meter kind (`meter_import`, `meter_export`, `meter_gas`) or `device:<id>` for a sub-meter | `thing:<id>` for a sub-meter (rows of the old key are stale by stamp and rebuilt; `PRICE_METHOD` should be bumped with the change) |
| `tariff_agreement` (existing; read by `loadPricing`, `inputsStamp`, `supplyPoints`) | `device_id` (FK to `device`) | which meter a tariff is on | the meter thing; `agreementAt(p, point, ts)` takes a numeric point as a device id |
| `register_window` (existing) | `device_id` (FK to `device`) | a meter's own switch times (`meterRegister`, `p.meterWindows` keyed by device id) | the meter thing |
| `series` / `interval_fact` (existing) | `subject_kind = 'device'`, `subject_id` | a sub-meter's energy (`readSubMeterFacts`: `heatpump_elec_kwh`, `ev_charge_kwh`, `immersion_kwh`) | subject kind `thing` |
| `device.kind` | joined in `loadPricing` | the agreement's `kind` is the meter kind that names the point | the meter thing's type |
| `tariff_price_run`, `tariff_price_state`, `price_dirty` | none | keyed by tariff, home (`site_id`) or country | nothing to repoint (`site_id` becomes `home_id` with the site fold) |

In code: `supply-price.js` (`supplyPoints`, `subMeterPoint`, `slotRow`, `priceOfRow`, `inputsStamp`, `readSubMeterFacts`), `pricing.js` (the agreements join, `agreementAt`, `meterRegister`, `meterWindows`), `slot-price.js` (`deviceId` in the price object), `tariff-slots.js` (`standIn.device_id`, the `device_id` field of `/api/sites/:id/prices`), `price-queue.js` (none), `tariffs.js` (`agreeTariff`, `putWindows`), `devices.js` (`supersedeAgreements`), and the picker's meter (`chooseOnPickerMeter`, provider `picker`).

### Phase T as it stands

| Item | State |
|---|---|
| T.1 `tariff_price_run`, pure expansion | done (step A) |
| T.2 fixed charges as slot shares | done (step A) |
| T.3 `supply_price_slot`, sub-meters | done (step B) |
| T.4 the build reads the slots; the old price functions removed | done (step B) |
| T.5 marks, queue, extending the timeline | done (step B) |
| T.6 comparison and picker price from slots | done (this step); planner, forecast, heating, explorer, explanation not moved to the table |
| T.7 API | done (this step) |
| Exit: no gaps inside validity | test, this step |
| Exit: timeline at least 7 days ahead | test, this step |
| Exit: same totals as before | test, this step (`compare-ref.json.gz`) |

### Tests run in this checkout (all passing, each seen to pass in this step)

`compare-slots` (11), `tariff-api` (8), `price-exit` (15), `compare-market`, `tariff-picker`, `tounify`, `tariffscanner` (56 together), `golden-gb`, `site-version-gb`, `topologies` (12 together), `multi-market`, `slot-build`, `core` (25 together), `rules-tariff`, `rules-all`, `table-kinds` (9), `supply-price`, `price-queue`, `price-runs` (28), `price-runs-gb`, `price-runs-synthetic` (14 with `compare-market`), `tax-apply`, `tax-eu-vat`, `tax-gb-vat` (16), `put-rates`, `users`, `signup` (34), `explain`, `explorer`, `slots` (27).

```
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
cd /Users/macbookpro/eb-wt/tariff
TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/compare-slots.test.js test/tariff-api.test.js test/price-exit.test.js
# re-record the comparison reference (only for a number that is meant to change):
UPDATE_COMPARE_REF=1 TEST_DB_PREFIX=wp_tariff node --test --disable-warning=ExperimentalWarning test/compare-slots.test.js
```

## Review round 1: what was fixed

Findings of the first review and what was done. Tests named were run in this checkout and passed (list at the end of this section).

**T.5 expansion lost when a read came first (two blockers, one major).** `processPriceQueue` decided "changed" by comparing the runs with the stored ones, but `loadPricing` -> `currentRuns` -> `ensureRuns` makes the runs again as soon as the rate rows change, in any reader's transaction, so by the time the mark was worked off the runs were equal and no home was queued; the mark was then deleted. Reproduced with a script before the change. Now the mark alone decides: a tariff mark makes the runs (idempotent) and queues every home on the tariff from `from_ts` (no earlier than the home's first data); a change wholly ahead gives an empty range and queues nobody. `unchanged` is gone from the queue's answer (`materialiseRuns` still returns it for its own tests). Test: `price-queue.test.js` "a read between the write and the queue run loses nothing".

**The mark starts at the first row that changed.** `putRates` of Octopus, tounify and Tariffscanner marked from the earliest row passed in, so an Agile sync that overlapped known days reached back two days for every home. They now keep the earliest `validFrom` of the rows actually written (`firstChanged`). Test: "only the rows that changed set the mark" (3 days known plus a new day: mark = the new day's start, nothing queued, 96 slots made for 2 homes). `putRateRows` (the caller's own rows, all written) is unchanged.

**A change to a tariff's own columns marks the tariff from 0.** `markTariffColumnsDirty` (price-marks.js) is called after the `UPDATE tariff` of tounify and Tariffscanner and when `storeWindows` changes `default_register`; only `fuel`, `direction`, `structure`, `currency`, `kind`, `taxes_in_price`, `default_register` count. Test in `price-queue.test.js`.

**A failing mark no longer blocks.** Migration `20261118100200_price_dirty_attempts` adds `attempts` and `last_error` to `price_dirty` (kind runtime, no trigger). The claim loop takes `ORDER BY attempts, marked_at, id`, skips marks with 3 or more attempts, and on a failure counts it and goes on to the next mark; `processPriceQueue` returns `failed` instead of throwing. A new change to the same tariff, country or home sets `attempts` back to 0. `syncSite` calls it with `maxMarks: 20` per scope inside its own try/catch and logs a `prices` step (`ok: false` with the errors), and `start()` in `server.js` catches too, so neither sync nor start depends on it. Test: "a mark that fails is counted and kept...".

**Scale of the tariff claim.** The first floor of each home is now read in two statements for all homes (`homeFloors`) plus one fact-span query per home, where it was three queries per home. `extendTimeline` runs after the mark's transaction has committed (so the row lock and the advisory lock are held for the runs and the queue inserts only), once per home, each in its own try/catch (a failure is in `failed` with scope `timeline`; a read makes any missing slot anyway). Not done: extending the timeline as a separate job, or in parallel; 14 days of slots for a home still cost about 150 ms, so a daily Agile publication costs that per home on the tariff, one after another, in whichever sync or start works it off. Not measured again for thousands of homes.

**Reads inside `withKnownAt`.** `supplyPricer` now sets `materialise` and `persist` to false when `knownAtMs()` is set (as `materialiseRuns` refuses), so an as-of read never serves the current table and never stores as-of prices under the current stamp. Test: `supply-price.test.js` "a read as known at a moment never reads or writes the table".

**Stale rows.** The stamp of a stored slot covers every rate row of the home's tariffs, so a new Agile day makes all stored rows of the home unreadable, and the benefit of the table for a dynamic tariff is only between two publications. I did not change that: a stamp per span or per tariff means a stamp per `load` range or per point, and a row made for a range would have to be found again with exactly the stamp of the range, which needs an index of the rate rows by time. Instead the cost is bounded and stated: `dropStaleSlots(siteId, stamp)` runs in a current build after the pricer is made and deletes the home's rows of any other stamp (they can never be read again), so the table does not keep every earlier state. Test in `supply-price.test.js`. A tariff with a fixed price (flat, windows, a calendar's known days) keeps its stamp when nothing changes, so only dynamic tariffs rebuild their stored days at every publication; `extendTimeline` makes the known future again after each publication.

**A GET can write `tariff_price_run`.** `currentRuns` calls `ensureRuns`, which makes the runs again when the rate rows' fingerprint changed, in a transaction with an advisory lock. The statement "reads write nothing" holds for `supply_price_slot` only (comparison, `homePriceTimeline`, `GET /api/sites/:id/prices` use `persist: false`), not for the runs: a read after a rate change stores the new runs once. This is intended (it is what makes a reader safe against a write that bypassed the marks) and is now stated. `GET /api/tariffs/:id/slots` and the home prices read the runs the same way.

**Exit test that could not find a hole.** `price-exit.test.js` has a second check that does not use blocks: for the current agreements of the real GB home, every unit run register must cover the agreement from its start to its end (or nine days ahead) with no hole. Measured: IOG day, IOG night and the 18-month gas fix are gapless (3 registers); four tariffs have a hole at the start of an agreement because the frozen fixture has no price rows for those days (`E-1R-AGILE-OUTGOING-19-05-13-G`, `E-1R-AGILE-24-10-01-G`, `E-1R-OUTGOING-VAR-24-10-26-G`, `E-1R-INTELLI-FIX-12M-26-06-13-G`); they are an explicit list and the test fails if one of them has no hole any more. There is no hole inside a run sequence anywhere in the fixture. Agreements on the 9 tariffs with no rate rows have no registers and are not counted.

**Tests restore the VAT in `finally`.** `price-queue.test.js` and `supply-price.test.js` put the registry's VAT back in a `finally` block. (The writes straight to `tax_rule` with `Date.now()` stay: the test is about writes that bypass the write functions.)

**Not changed, as the plan and review agree.** The future horizon is not maintained by a job and the planner, forecast, heating, explorer and explanation code still use `slotPrice` on the fly; the exit (7 days ahead where known) is met by computing on read. Tracked for Phase 3.4 and 3.8 (they must read `supply_price_slot`) and for a scheduled horizon fill. The comparison's totals equal today's to 1e-9 relative, not exactly (step C, decision 3); the column differences of `supply_price_slot` are listed in step B, decision 9.

### Tests run for this round (all passing, each seen to pass)

`price-queue` (11), `supply-price` (11), `price-exit` (16), `rules-all`, `rules-tariff`, `table-kinds` (9 together), `octopus-tariff`, `tariffscanner`, `tounify` (51 together), `tariff-expand`, `tariff-api`, `compare-slots` (37 together), `golden-gb`, `resume`, `providers` (16 together).
