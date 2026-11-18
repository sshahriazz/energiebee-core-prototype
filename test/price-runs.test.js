// Phase T.1 and T.2: price runs and fixed shares. Pure cases (how rows join into runs, how a run is looked up, every kind of price
// the rate-row path knows, each checked slot by slot against it), the table (materialise, read, idempotence, a past moment made
// in memory), the expansion from windows and calendars, and fixed shares adding up on 23, 24 and 25-hour days and in months.
// The homes of the fixture and of the synthetic scenarios are in price-runs-gb.test.js and price-runs-synthetic.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';
import { diffPricing } from './price-runs-lib.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { runsFromRates, runsFromWindows, indexRuns, coveringRuns, runAt, withRunsFromRates, lineageOf } = await import('../src/core/price-runs.js');
const { priceOverRuns, fixedShare } = await import('../src/core/slot-price.js');
const { dispatchAllowance, loadPricing, priceOver } = await import('../src/core/pricing.js');
const { materialiseRuns, materialiseHomeRuns, readRuns, pricingWithStoredRuns } = await import('../src/core/price-run-store.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice, storeWindows } = await import('../src/core/tariffs.js');
const { withKnownAt } = await import('../src/core/facts.js');
const { dayBounds, daysBetween, slotsOfDay, localDate } = await import('../src/core/time.js');
const { PLACEHOLDER_TAX_RULES } = await import('../src/core/tax.js');
const M = await import('../scripts/lib/multi-market.js');
const { deleteHome } = await import('../src/core/delete-home.js');

const TZ = 'Europe/London';
const [D0] = dayBounds(TZ, '2026-10-24');   // 25 October 2026 is the 25-hour day
const H = 3600;
const row = (id, o) => ({ id, tariff_id: 1, site_id: null, component: 'unit', register: 'single', charge_period: null, payment_method: 'ANY', valid_to: null, estimated: 0, origin: 'provider', ...o, price_ex_vat: o.price });

await test('runs: rows that follow each other with the same price, flag and origin are one run; anything else stays apart', () => {
  const runs = runsFromRates([
    row(1, { valid_from: 0, valid_to: 100, price: 10 }), row(2, { valid_from: 100, valid_to: 200, price: 10 }), row(3, { valid_from: 200, valid_to: 300, price: 10 }),
    row(4, { valid_from: 300, valid_to: 400, price: 12 }),                                                // another price
    row(5, { valid_from: 400, valid_to: 500, price: 12, estimated: 1 }),                                 // a cautious default is never hidden in a published run
    row(6, { valid_from: 500, valid_to: 600, price: 12, estimated: 1, origin: 'user' }),                  // another label
    row(7, { valid_from: 700, valid_to: 800, price: 12, estimated: 1, origin: 'user' }),                  // a gap: no price known between
    row(8, { valid_from: 0, valid_to: 100, price: 10, register: 'night' }),                               // another register
    row(9, { valid_from: 0, valid_to: 100, price: 10, site_id: 5 }),                                      // a home's own row
    row(10, { valid_from: 0, valid_to: 100, price: 10, payment_method: 'DDM' }),                           // a payment method
  ]);
  const key = (r) => [r.register, r.site_id ?? 'null', r.payment_method, r.valid_from, r.valid_to, r.price_ex_vat, r.estimated, r.origin, r.rate_ids.join('+')].join('|');
  assert.deepEqual(runs.map(key).sort(), [
    'night|null|ANY|0|100|10|0|provider|8', 'single|5|ANY|0|100|10|0|provider|9', 'single|null|ANY|0|100|10|0|provider|10'.replace('single|null|ANY', 'single|null|DDM'),
    'single|null|ANY|0|300|10|0|provider|1+2+3', 'single|null|ANY|300|400|12|0|provider|4', 'single|null|ANY|400|500|12|1|provider|5',
    'single|null|ANY|500|600|12|1|user|6', 'single|null|ANY|700|800|12|1|user|7',
  ].sort());
  assert.deepEqual(lineageOf(runs.find((r) => r.rate_ids.length === 3)), { rate_ids: [1, 2, 3], n: 3 });
  const many = runsFromRates(Array.from({ length: 50 }, (_, i) => row(i + 1, { valid_from: i * 10, valid_to: i * 10 + 10, price: 7 })));
  assert.equal(many.length, 1, 'fifty daily rows with one price are one run');
  assert.deepEqual([lineageOf(many[0]).rate_ids.length, lineageOf(many[0]).n], [20, 50], 'the lineage keeps the first ids and counts the rest');
  assert.equal(runsFromRates([row(1, { valid_from: 0, valid_to: null, price: 3 }), row(2, { valid_from: 50, valid_to: 90, price: 3 })]).length, 2, 'an open-ended row is never joined to a later one');
});

await test('runs: lookup finds the run covering an instant, home-specific first, then the home\'s payment method, then any method, then methods that agree', () => {
  const p = (rows, payment) => ({ runs: indexRuns(runsFromRates(rows)), payment: new Map(payment ? [[1, payment]] : []) });
  const ddm = row(1, { valid_from: 0, valid_to: 1000, price: 20, payment_method: 'DDM' });
  const cac = row(2, { valid_from: 0, valid_to: 1000, price: 24, payment_method: 'CAC' });
  assert.equal(runAt(p([ddm, cac], 'DDM'), 1, 'unit', 'single', 10).price_ex_vat, 20);
  assert.equal(runAt(p([ddm, cac], 'CAC'), 1, 'unit', 'single', 10).price_ex_vat, 24);
  assert.equal(runAt(p([ddm, cac], null), 1, 'unit', 'single', 10), null, 'two methods that disagree and no method of the home: no price');
  assert.equal(runAt(p([ddm, { ...cac, price_ex_vat: 20, price: 20 }], null), 1, 'unit', 'single', 10).price_ex_vat, 20, 'methods that agree');
  assert.equal(runAt(p([ddm, row(3, { valid_from: 0, valid_to: 1000, price: 22 })], 'CAC'), 1, 'unit', 'single', 10).price_ex_vat, 22, 'a run for any method');
  assert.equal(runAt(p([ddm, row(3, { valid_from: 0, valid_to: 1000, price: 15, site_id: 7 })], 'DDM'), 1, 'unit', 'single', 10).price_ex_vat, 15, 'the home\'s own run wins');
  assert.equal(runAt(p([ddm], 'DDM'), 1, 'unit', 'single', 1000), null, 'a run ends where it ends (valid_to is exclusive)');
  assert.equal(coveringRuns(p([ddm, row(4, { valid_from: 500, valid_to: 700, price: 9 })], null).runs, 1, 'unit', 600).length, 2, 'overlapping runs are all found');
});

// A hand-made pricing context (what loadPricing returns) over the 24-26 October 2026 clock change, one import meter.
function context({ rates, structure = 'flat', ...more }) {
  const dispatches = more.dispatches ?? [];
  return {
    agreements: [{ kind: 'meter_import', device_id: 3, tariff_id: 1, tariff_code: 'TEST', structure, fuel: 'electricity', direction: 'import', currency: 'GBP', taxes_in_price: 0, tariff_origin: 'provider', valid_from: 0, valid_to: null }],
    rates: rates.map((r, i) => (r.id ? r : { ...r, id: i + 1 })), vat: [{ fuel: 'electricity', direction: 'import', rate: 0.05, valid_from: 0, valid_to: null }], taxRules: [],
    country: 'GB', currency: 'GBP', tz: TZ, payment: new Map(), meterWindows: new Map(), dispatches, dispatchAllowed: dispatchAllowance(dispatches, TZ),
    hasFixed: true, capacityKva: null, capacityOrigin: null, shapes: new Map(), iogWindow: null, ...more,
  };
}
const standing = (price = 48) => row(0, { component: 'standing', valid_from: 0, price });
const differ = async (p, label, opts = {}) => await diffPricing(p, { 'in memory': withRunsFromRates(p) }, TZ, '2026-10-24', '2026-10-26', { kinds: ['meter_import', 'meter_export'], label, ...opts });

await test('every kind of price the rate-row path knows is the same from runs, at 15, 30 and 60 minutes across a 25-hour day', async () => {
  // Half-hourly prices cut off the hour (a row starting at :07 makes a slot weighted), with a standing charge.
  const agile = [];
  for (let t = D0 - 3 * H, i = 0; t < D0 + 75 * H; t += 1800, i++) agile.push(row(0, { valid_from: t + (i % 5 === 0 ? 420 : 0), valid_to: t + 1800, price: 10 + ((i * 7) % 13) }));
  agile.forEach((r, i) => { r.id = i + 1; });
  const seen = await differ(context({ rates: [...agile, standing()], structure: 'agile' }), 'agile-like');
  assert.ok(seen.weighted > 0 && seen.priced > 0 && seen.fixed > 0, JSON.stringify(seen));

  // Prices that leave a gap: the slots in it have no price and are never filled.
  const gap = await differ(context({ rates: [row(1, { valid_from: 0, valid_to: D0 + 20 * H, price: 20 }), row(2, { valid_from: D0 + 30 * H, price: 22 }), standing()] }), 'flat with a gap');
  assert.ok(gap.unpriced > 0 && gap.priced > 0, JSON.stringify(gap));

  // A cautious default (estimated) beside a published price: a slot spanning both says so.
  const est = await differ(context({ rates: [row(1, { valid_from: 0, valid_to: D0 + 20 * H + 900, price: 20 }), row(2, { valid_from: D0 + 20 * H + 900, valid_to: D0 + 40 * H, price: 20, estimated: 1 }), row(3, { valid_from: D0 + 40 * H, price: 20 }), standing()] }), 'estimated');
  assert.ok(est.estimated > 0, JSON.stringify(est));

  // Intelligent Octopus: day and night rates, a smart-charge dispatch, and only a time-varying list (no register rows) as the fall-back.
  const dispatches = [{ start_ts: D0 + 14 * H, end_ts: D0 + 15 * H }, { start_ts: D0 + 40 * H + 900, end_ts: D0 + 41 * H + 900 }];
  const window = { start: 23 * 60 + 30, end: 5 * 60 + 30 };
  const iog = await differ(context({ structure: 'iog', dispatches, iogWindow: window, rates: [row(1, { register: 'day', valid_from: 0, price: 30 }), row(2, { register: 'night', valid_from: 0, price: 7 }), standing()] }), 'iog day/night');
  assert.ok(iog.registers['iog/night'] > 0 && iog.registers['iog/day'] > 0 && iog.weighted > 0, JSON.stringify(iog));
  const list = [];
  for (let t = D0 - H, i = 0; t < D0 + 75 * H; t += 1800, i++) list.push(row(0, { valid_from: t, valid_to: t + 1800, price: ((t - D0 + 3 * H) % 86400) < 6 * H ? 7.5 : 28 }));
  list.forEach((r, i) => { r.id = i + 1; });
  const fallback = await differ(context({ structure: 'iog', dispatches, iogWindow: window, rates: [...list, standing()] }), 'iog single list, dispatch takes the cheapest rate of the day');
  assert.ok(fallback.registers['iog/night'] > 0, JSON.stringify(fallback));
  const noWindow = await differ(context({ structure: 'iog', rates: [row(1, { register: 'day', valid_from: 0, price: 30 }), standing()] }), 'iog without a learned window');
  assert.ok(noWindow.unpriced > 0, 'a day with no known off-peak window has no price: it is never guessed');

  // Economy 7 from the meter's own switch times: night 00:30-07:30 on the meter's clock; without windows, no price.
  const e7rates = [row(1, { register: 'day', valid_from: 0, price: 28 }), row(2, { register: 'night', valid_from: 0, price: 11.5 }), standing(55)];
  const meterWindows = new Map([[3, [{ register: 'night', start_min: 30, end_min: 450, weekdays: 127, clock: 'local', valid_from: null, valid_to: null }]]]);
  const e7 = await differ(context({ structure: 'e7', rates: e7rates, meterWindows }), 'e7 with meter windows');
  assert.ok(e7.registers['e7/night'] > 0 && e7.registers['e7/day'] > 0, JSON.stringify(e7));
  assert.ok((await differ(context({ structure: 'e7', rates: e7rates }), 'e7 without windows')).unpriced > 0);

  // Registers read from the rows themselves (windows, expanded to rows by the tariff): the row covering the instant says.
  const hphc = [];
  for (let t = D0 - 3 * H, i = 0; t < D0 + 75 * H; t += 6 * H, i++) hphc.push(row(0, { register: i % 2 ? 'hc' : 'hp', valid_from: t + 420, valid_to: t + 6 * H + 420, price: i % 2 ? 14 : 18 }));
  hphc.forEach((r, i) => { r.id = i + 1; });
  const windows = await differ(context({ structure: 'windows', rates: [...hphc, standing()] }), 'windows');
  assert.ok(windows.registers['windows/hc'] > 0 && windows.registers['windows/hp'] > 0 && windows.weighted > 0, JSON.stringify(windows));

  // Home-specific rows win over the tariff's; rows for a payment method are used only where they fit the home.
  const mine = await differ(context({ rates: [row(1, { valid_from: 0, price: 20 }), row(2, { valid_from: D0 + 10 * H, valid_to: D0 + 30 * H + 900, price: 12, site_id: 9 }), standing()] }), 'home-specific');
  assert.ok(mine.weighted > 0);
  const methods = [row(1, { valid_from: 0, price: 20, payment_method: 'DDM' }), row(2, { valid_from: 0, price: 24, payment_method: 'CAC' }), standing()];
  assert.ok((await differ(context({ rates: methods, payment: new Map([[1, 'CAC']]) }), 'own payment method')).priced > 0);
  assert.ok((await differ(context({ rates: methods }), 'methods that disagree')).unpriced > 0);

  // Rows that overlap (a data error the database refuses, but a hand-fed list can hold) are read the same way.
  assert.ok((await differ(context({ rates: [row(1, { valid_from: 0, valid_to: D0 + 30 * H, price: 20 }), row(2, { valid_from: D0 + 10 * H, valid_to: D0 + 50 * H, price: 21 }), standing()] }), 'overlapping rows')).priced > 0);
});

await test('fixed charges: standing, monthly, yearly and capacity are the same share per slot from runs, with taxes in the price, per-period taxes and an unknown capacity', async () => {
  const fixedRows = [
    standing(60), row(0, { component: 'fixed', register: 'supply', charge_period: 'month', valid_from: 0, price: 599 }),
    row(0, { component: 'fixed', register: 'network', charge_period: 'day', valid_from: 0, price: 120 }),
    row(0, { component: 'fixed', register: 'club', charge_period: 'year', valid_from: 0, valid_to: D0 + 36 * H, price: 2400 }),
    row(0, { component: 'capacity', register: 'single', charge_period: 'month', valid_from: 0, price: 80 }),
    row(0, { component: 'unit', valid_from: 0, price: 20 }),
  ].map((r, i) => ({ ...r, id: i + 1 }));
  const known = await differ(context({ rates: fixedRows, capacityKva: 9, capacityOrigin: 'user' }), 'fixed with capacity');
  assert.ok(known.fixed > 0);
  const p = withRunsFromRates(context({ rates: fixedRows }));
  const unknown = priceOverRuns(p, 'meter_import', D0, 1800);
  assert.equal(unknown.capacityUnknown, true, 'no contracted capacity: the capacity charge is left out and the price says so');
  assert.ok((await differ(context({ rates: fixedRows }), 'fixed, capacity unknown')).fixed > 0);
  // Dutch placeholder rules: VAT and a yearly credit that VAT is charged on; a tariff with its taxes in the price takes VAT only.
  const nl = () => context({ rates: fixedRows, capacityKva: 9, taxRules: PLACEHOLDER_TAX_RULES.filter((r) => r.country === 'NL'), country: 'NL', currency: 'EUR' });
  for (const inPrice of [0, 1]) {
    const c = nl();
    c.agreements[0].taxes_in_price = inPrice; c.agreements[0].currency = 'EUR';
    const s = await differ(c, `NL taxes, taxes_in_price ${inPrice}`);
    assert.ok(s.fixed > 0);
  }
});

await test('fixed shares: the slots of a day add up to the day\'s charge, whatever the slot length and the length of the day (23, 24, 25 hours)', () => {
  const rows = [standing(60), row(0, { component: 'unit', valid_from: 0, price: 20 })].map((r, i) => ({ ...r, id: i + 1 }));
  const p = withRunsFromRates(context({ rates: rows }));
  for (const date of ['2026-03-29', '2026-10-24', '2026-10-25']) {
    for (const slotS of [900, 1800, 3600]) {
      const total = slotsOfDay(TZ, date, slotS).reduce((t, s) => t + fixedShare(priceOverRuns(p, 'meter_import', s, slotS), s, slotS, TZ), 0);
      assert.ok(Math.abs(total - 60 * 1.05) < 1e-9, `${date} at ${slotS} s: ${total}`);
    }
  }
});

await test('fixed shares: the slots of a month add up to the monthly charge on the month with the 23-hour day', () => {
  const tz = 'Europe/Paris';
  const rows = [row(1, { component: 'fixed', register: 'single', charge_period: 'month', valid_from: 0, price: 1523 }), row(2, { component: 'unit', valid_from: 0, price: 20 })];
  const p = withRunsFromRates({ ...context({ rates: rows }), tz });
  for (const slotS of [900, 1800, 3600]) {
    let total = 0;
    for (const date of daysBetween('2026-03-01', '2026-03-31')) for (const s of slotsOfDay(tz, date, slotS)) total += fixedShare(priceOverRuns(p, 'meter_import', s, slotS), s, slotS, tz);
    assert.ok(Math.abs(total - 1523 * 1.05) < 1e-6, `March 2026 at ${slotS} s: ${total}`);
  }
});

// ───────────── The table ─────────────

const CODE = (n) => `RUN-TEST-${n}`;
async function home(name) {
  const site = await createSite({ name });
  const meter = await addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: `M-${name}` });
  return { site, meter };
}
const tariff = async (n, structure = 'flat') => await createTariff({ provider: 'test', tariffCode: CODE(n), structure, kind: structure === 'windows' ? 'tou' : 'flat', country: 'GB', currency: 'GBP', origin: 'user' });
const stored = async (tariffId, siteId) => await readRuns([tariffId], siteId, 0, 9e9);

await test('materialise: a tariff\'s runs replace its own rows, are left alone when nothing changed, and follow a corrected rate row', async () => {
  const t = await tariff(1);
  const other = await tariff(2);
  await putRateRows(other.id, [{ component: 'unit', validFrom: 0, price: 99 }]);
  await materialiseRuns(other.id);
  const days = Array.from({ length: 10 }, (_, i) => ({ component: 'unit', validFrom: 86400 * i, validTo: 86400 * (i + 1), price: 21.5 }));
  await putRateRows(t.id, [...days, { component: 'unit', validFrom: 86400 * 10, validTo: 86400 * 11, price: 30 }, { component: 'standing', validFrom: 0, price: 50 }]);
  const first = await materialiseRuns(t.id, { builtAt: 1000 });
  assert.deepEqual(first, { runs: 3, unchanged: false });
  assert.deepEqual((await stored(t.id, null)).map((r) => [r.component, r.valid_from, r.valid_to, r.price_ex_vat, r.rate_ids.length]).sort(), [['standing', 0, null, 50, 1], ['unit', 0, 864000, 21.5, 10], ['unit', 864000, 950400, 30, 1]].sort());
  assert.deepEqual(await materialiseRuns(t.id, { builtAt: 2000 }), { runs: 3, unchanged: true });
  assert.equal((await db.prepare('SELECT DISTINCT built_at FROM tariff_price_run WHERE tariff_id = ?').all(t.id)).map((r) => r.built_at).join(), '1000', 'an unchanged tariff is not rewritten');
  // A corrected price: the old row is superseded, the new one current; the run follows.
  await db.prepare("UPDATE rate_interval SET superseded_at = 5 WHERE tariff_id = ? AND component = 'unit' AND valid_from = ?").run(t.id, 86400 * 3);
  await putRateRows(t.id, [{ component: 'unit', validFrom: 86400 * 3, validTo: 86400 * 4, price: 23 }]);
  assert.deepEqual(await materialiseRuns(t.id, { builtAt: 3000 }), { runs: 5, unchanged: false });
  assert.deepEqual((await stored(t.id, null)).filter((r) => r.component === 'unit').map((r) => [r.valid_from / 86400, r.valid_to / 86400, r.price_ex_vat]), [[0, 3, 21.5], [3, 4, 23], [4, 10, 21.5], [10, 11, 30]]);
  assert.equal((await stored(other.id, null)).length, 1, 'another tariff\'s runs are untouched');
  await assert.rejects(async () => await materialiseRuns(999999), /no tariff/);
  await assert.rejects(async () => await withKnownAt(Date.now(), async () => await materialiseRuns(t.id)), /describe now/);
});

await test('read: a home reads the shared runs and its own, never another home\'s; materialiseHomeRuns covers the tariffs it is on', async () => {
  const a = await home('read-a'); const b = await home('read-b');
  const t = await tariff(3);
  await putRateRows(t.id, [{ component: 'unit', validFrom: 0, price: 20 }]);
  await putRateRows(t.id, [{ component: 'unit', validFrom: 1000, validTo: 2000, price: 15 }], { siteId: a.site.id });
  await putRateRows(t.id, [{ component: 'unit', validFrom: 1000, validTo: 2000, price: 10 }], { siteId: b.site.id });
  await agreeTariff({ siteId: a.site.id, deviceId: a.meter.id, tariffId: t.id, validFrom: 0 });
  assert.deepEqual(Object.keys(await materialiseHomeRuns(a.site.id)), [String(t.id)]);
  assert.deepEqual((await readRuns([t.id], a.site.id, 0, 1e9)).map((r) => [r.site_id, r.price_ex_vat]).sort(), [[a.site.id, 15], [null, 20]].sort());
  assert.deepEqual((await readRuns([t.id], b.site.id, 0, 1e9)).map((r) => [r.site_id, r.price_ex_vat]).sort(), [[b.site.id, 10], [null, 20]].sort());
  assert.deepEqual((await readRuns([t.id], a.site.id, 1000, 1001)).length, 2);
  assert.deepEqual((await readRuns([t.id], a.site.id, 2000, 2001)).length, 1, 'a home run ends where its row ends');
  assert.deepEqual(await readRuns([], a.site.id, 0, 1e9), []);
  // The home's own run wins for that home when read through a pricing context.
  const p = await loadPricing(a.site.id, 0, 3000);
  const ctx = await pricingWithStoredRuns(p, a.site.id, 0, 3000);
  assert.equal(runAt(ctx, t.id, 'unit', 'single', 1500).price_ex_vat, 15);
  assert.equal(runAt(ctx, t.id, 'unit', 'single', 2500).price_ex_vat, 20);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tariff_price_run WHERE site_id = ?').get(b.site.id)).n, 1);
  await deleteHome({ id: 1, role: 'admin' }, await db.prepare('SELECT * FROM site WHERE id = ?').get(b.site.id), { confirm: 'read-b' });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tariff_price_run WHERE site_id = ?').get(b.site.id)).n, 0, 'a deleted home takes its runs with it');
});

await test('a build "as known at" a past moment makes its runs in memory from the rows of that moment, with the same result as the rate-row path; the table only describes now', async () => {
  const h = await home('as-of');
  const t = await tariff(4);
  const [a] = dayBounds(TZ, '2026-10-20'); const [, b] = dayBounds(TZ, '2026-10-21');
  const t0 = Date.now() + 100000;   // after the tariff itself was recorded
  await putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 20 }, { component: 'standing', validFrom: a, price: 50 }], { recordedAt: t0 });
  await agreeTariff({ siteId: h.site.id, deviceId: h.meter.id, tariffId: t.id, validFrom: a, recordedAt: t0 });
  // The price is corrected five seconds later: the first row is superseded, a new one starts where it said.
  await db.prepare("UPDATE rate_interval SET superseded_at = ? WHERE tariff_id = ? AND component = 'unit'").run(t0 + 5000, t.id);
  await putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 26 }], { recordedAt: t0 + 5000 });
  await materialiseHomeRuns(h.site.id);
  const priceAtMoment = async (ms) => await withKnownAt(ms, async () => {
    const p = await loadPricing(h.site.id, a, b);
    const mem = withRunsFromRates(p);
    const seen = await diffPricing(p, { 'in memory': mem }, TZ, '2026-10-20', '2026-10-20', { kinds: ['meter_import'], label: `as known at ${ms}` });
    assert.ok(seen.priced > 0);
    return priceOverRuns(mem, 'meter_import', a, 1800).supplyEx;
  });
  assert.equal(await priceAtMoment(t0 + 3000), 20, 'as known before the correction');
  assert.equal(await priceAtMoment(t0 + 6000), 26, 'as known after it');
  const p = await loadPricing(h.site.id, a, b);
  assert.equal(priceOverRuns(await pricingWithStoredRuns(p, h.site.id, a, b), 'meter_import', a, 1800).supplyEx, 26, 'the table describes now');
  assert.equal(priceOver(p, 'meter_import', a, 1800).supplyEx, 26);
});

// ───────────── From windows and calendars ─────────────

const key = (r) => [r.component, r.register, r.site_id, r.valid_from, r.valid_to, r.price_ex_vat, r.estimated, r.origin].join('|');

await test('windows and calendars expanded on demand give the runs of the unit rows the tariff stores (HP/HC with the meter\'s own hours, Tempo)', async () => {
  const fr = await M.frHome();
  const tz = M.FR.tz;
  for (const [tariff, prices, deviceId, siteId] of [[fr.tariffs.hphc, { hp: M.FR.hphc.hp, hc: M.FR.hphc.hc }, fr.devices.imp.id, fr.site.id], [fr.tariffs.hphc, { hp: M.FR.hphc.hp, hc: M.FR.hphc.hc }, null, null], [fr.tariffs.tempo, M.FR.tempo.prices, null, null]]) {
    const windows = await db.prepare('SELECT * FROM register_window WHERE tariff_id = ? AND superseded_at IS NULL AND (device_id IS NULL OR device_id = ?) ORDER BY id').all(tariff.id, deviceId ?? -1);
    const calendar = await Promise.all((await db.prepare('SELECT * FROM calendar WHERE code IN (SELECT calendar FROM register_window WHERE tariff_id = ? AND calendar IS NOT NULL)').all(tariff.id)).map(async (c) => ({
      code: c.code, dayStartMin: c.day_start_min, days: Object.fromEntries((await db.prepare('SELECT local_date, day_type FROM calendar_day WHERE calendar = ? AND superseded_at IS NULL').all(c.code)).map((d) => [d.local_date, d.day_type])),
    })));
    const t = await db.prepare('SELECT default_register, origin FROM tariff WHERE id = ?').get(tariff.id);
    const rowsOf = await db.prepare("SELECT * FROM rate_interval WHERE tariff_id = ? AND component = 'unit' AND superseded_at IS NULL AND COALESCE(site_id, 0) = ? ORDER BY valid_from, id").all(tariff.id, siteId ?? 0);
    assert.ok(rowsOf.length > 0);
    const [from, to] = [Math.min(...rowsOf.map((r) => r.valid_from)), Math.max(...rowsOf.map((r) => r.valid_to))];
    const fromDate = localDate(tz, from); const toDate = localDate(tz, to - 1);
    const expanded = runsFromWindows({ tariffId: tariff.id, siteId, origin: t.origin, windows, registerPrices: prices, calendar, tz, fromDate, toDate, defaultRegister: t.default_register, deviceId });
    assert.deepEqual(expanded.map(key), runsFromRates(rowsOf).map(key), `${tariff.tariff_code}${deviceId ? ' (meter windows)' : ''}`);
  }
});

await test('an unknown Tempo colour is expanded with the caller\'s cautious default and comes back as estimated runs, like the stored rows', async () => {
  const t = await tariff(5, 'windows');
  const tz = 'Europe/Paris';
  const WINDOWS = ['white', 'red'].flatMap((c) => [{ register: `${c}_hp`, calendar: 'run_tempo', day_type: c, start_min: 360, end_min: 1320 }, { register: `${c}_hc`, calendar: 'run_tempo', day_type: c, start_min: 1320, end_min: 360 }]);
  const PRICES = { white_hp: 17.3, white_hc: 13.9, red_hp: 64.7, red_hc: 14.6 };
  const calendar = { code: 'run_tempo', dayStartMin: 360, days: { '2026-01-12': 'white' } };
  await storeWindows(t.id, { windows: WINDOWS, registerPrices: PRICES, tz, fromDate: '2026-01-12', toDate: '2026-01-13', calendar, estimate: { dayType: 'red' } });
  const rowsOf = await db.prepare("SELECT * FROM rate_interval WHERE tariff_id = ? AND component = 'unit' AND superseded_at IS NULL ORDER BY valid_from, id").all(t.id);
  assert.ok(rowsOf.some((r) => r.estimated === 1) && rowsOf.some((r) => r.estimated === 0));
  const expanded = runsFromWindows({ tariffId: t.id, origin: 'user', windows: WINDOWS, registerPrices: PRICES, calendar, tz, fromDate: '2026-01-12', toDate: '2026-01-13', estimate: { dayType: 'red' } });
  assert.deepEqual(expanded.map(key), runsFromRates(rowsOf).map(key));
  assert.ok(expanded.filter((r) => r.estimated).every((r) => r.register.startsWith('red_')), 'the estimate is the day type the caller named');
  assert.throws(() => runsFromWindows({ tariffId: t.id, windows: WINDOWS, registerPrices: PRICES, calendar, tz, fromDate: '2026-01-12', toDate: '2026-01-13' }), /unknown and no estimate/, 'without an estimate an unknown day is refused, never guessed');
});
