# Phase T: the slotted tariff baseline (build notes)

Branch `wp/tariff`, started from `f59ce42`. This file is written per step; each step says what is done, what is not, and how it was measured.

## Step A: T.1 price runs and T.2 fixed-charge shares

State: done as scoped for this step (pure layer, table, store, differential tests). The build still prices with `priceAt` / `priceOver` / `fixedOver`; nothing in production code calls the new code yet. The old pricing code is not removed in this step.

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
