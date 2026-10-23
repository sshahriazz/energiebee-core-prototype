// The multi-market demonstration as assertions: three SYNTHETIC homes (GB, FR, NL) in a new,
// empty database, built by the production build engine (scripts/lib/multi-market.js is shared with
// scripts/demo-multi-market.js). Deterministic: seeded data, no live database, no provider calls.
// FR and NL taxes are the unverified placeholder rules of src/core/tax.js (origin 'placeholder');
// everything generated is origin 'synthetic' and the homes are is_demo (test/provenance.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { setSlotLength, createSite, regionsOf } = await import('../src/core/sites.js');
const { createTariff, agreeTariff, putRateRows } = await import('../src/core/tariffs.js');
const { processQueue } = await import('../src/core/build.js');
const { taxesAt, loadPricing } = await import('../src/core/pricing.js');
const { applyTaxes, rulesFor } = await import('../src/core/tax.js');
const { compareSite } = await import('../src/core/compare.js');
const { dayBounds } = await import('../src/core/time.js');
const { fixedChargeMicro } = await import('../src/core/tariff-expand.js');

const homes = m.buildScenario();
const { gb, fr, nl } = homes;
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const reg = (r) => JSON.parse(r.lineage).register;
const slotsOn = (siteId, date) => m.hhRows(siteId, date, date).length;

test('homes carry their market, currency, clock and slot length; regions are assigned; all are demo homes', () => {
  assert.deepEqual([gb, fr, nl].map((h) => m.siteRow(h.site.id).is_demo), [1, 1, 1]);
  assert.deepEqual([gb, fr, nl].map((h) => { const s = m.siteRow(h.site.id); return [s.market_code, s.country, s.currency, s.timezone, s.slot_s]; }), [
    ['GB', 'GB', 'GBP', 'Europe/London', 1800],
    ['FR', 'FR', 'EUR', 'Europe/Paris', 1800],
    ['NL', 'NL', 'EUR', 'Europe/Amsterdam', 900],
  ]);
  assert.deepEqual(regionsOf(gb.site.id).map((r) => [r.scheme, r.code, r.name]), [['bzn', 'GB', 'Great Britain'], ['gb_dno', '16', 'North West England']]);
  assert.deepEqual(regionsOf(fr.site.id).map((r) => [r.scheme, r.code]), [['bzn', 'FR']]);
  // The .env defaults: market GB, pounds, London, half-hours.
  const plain = createSite({ name: 'Defaults' });
  assert.deepEqual([plain.country, plain.market_code, plain.currency, plain.timezone, plain.slot_s], ['GB', 'GB', 'GBP', 'Europe/London', 1800]);
  assert.throws(() => createSite({ name: 'Bad', slotS: 1200 }), /slot length/);
  assert.throws(() => createSite({ name: 'Bad', market: 'NL', currency: 'GBP' }), /billed in EUR/);
});

test('clock-change days: 50 half-hours (GB), 46 half-hours (FR), 100 quarter-hours (NL); every slot priced and final', () => {
  assert.equal(slotsOn(gb.site.id, m.GB.change), 50);
  assert.equal(slotsOn(fr.site.id, m.FR.change), 46);
  assert.equal(slotsOn(nl.site.id, m.NL.change), 100);
  for (const [h, w] of [[gb, m.GB], [fr, m.FR], [nl, m.NL]]) {
    const rows = m.hhRows(h.site.id, w.from, w.to);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.rate_found === 1 && r.state === 'final'), `${w.tz}: all priced and final`);
    const s = m.siteRow(h.site.id);
    assert.ok(m.dayRows(h.site.id, w.from, w.to).every((d) => d.currency === s.currency && d.slot_s === s.slot_s));
  }
});

test('GB: the tax_rule path gives exactly the old vat_rate numbers, and every slot adds up by hand', () => {
  const { viaRules, viaVatRate } = m.gbBothPaths(gb.site.id);
  assert.equal(viaRules.hhRows.length, 146);
  assert.equal(m.fingerprint(viaRules.hhRows), m.fingerprint(viaVatRate.hhRows));
  // By hand: flat on 25 Oct, day/night from 26 Oct (night 00:30-07:30 local), 5 % VAT, export 15 p.
  const [d26] = dayBounds(m.GB.tz, m.GB.change);
  for (const r of m.hhRows(gb.site.id, m.GB.from, m.GB.to)) {
    const n = slotsOn(gb.site.id, r.local_date);
    const unit = r.slot_start < d26 ? m.GB.flat.unit : reg(r) === 'night' ? m.GB.e7.night : m.GB.e7.day;
    const standing = (r.slot_start < d26 ? m.GB.flat.standing : m.GB.e7.standing) * 1.05 / n;
    near(m.inc(r), unit * 1.05, 1e-12, 'unit');
    near(r.standing_cost, standing, 1e-12, 'standing');
    near(r.total_cost, r.grid_import * unit * 1.05 + standing - (r.solar_to_grid + r.battery_to_grid) * m.GB.export, 1e-9, `total at ${r.slot_start}`);
  }
  const night = m.hhRows(gb.site.id, m.GB.change, m.GB.change).filter((r) => reg(r) === 'night');
  assert.equal(night.length, 16, '00:30-07:30 is 8 real hours on the 25-hour day');
});

test('FR: the meter\'s own HP/HC hours, Tempo colours, placeholder taxes, and a monthly subscription by real seconds', () => {
  const rows = m.hhRows(fr.site.id, m.FR.from, m.FR.to);
  const hc = (d) => rows.filter((r) => r.local_date === d && reg(r) === 'hc');
  assert.equal(hc(m.FR.from).length, 16);
  assert.equal(hc(m.FR.change).length, 14, '02:00-03:00 does not exist on 29 March');
  near(m.inc(hc(m.FR.change)[0]), (m.FR.hphc.hc + 3.37) * 1.2);
  assert.ok(rows.filter((r) => r.local_date === m.FR.from).every((r) => JSON.parse(r.lineage).taxUnverified === true));
  // Tempo: the night after the blue 29th is blue; 31 March daytime is red.
  const [d30] = dayBounds(m.FR.tz, '2026-03-30');
  assert.deepEqual([...new Set(rows.filter((r) => r.slot_start >= d30 && r.slot_start < d30 + 6 * 3600).map(reg))], ['blue_hc']);
  const red = rows.filter((r) => r.local_date === '2026-03-31' && reg(r) === 'red_hp');
  assert.equal(red.length, 32);
  near(m.inc(red[0]), (64.7 + 3.37) * 1.2);
  for (const d of m.dayRows(fr.site.id, m.FR.from, m.FR.to)) {
    const [a, b] = dayBounds(m.FR.tz, d.local_date);
    const sub = d.local_date < '2026-03-30' ? m.FR.hphc.subscription : m.FR.tempo.subscription;
    near(d.standing_cost, (fixedChargeMicro(sub, 'month', a, b, m.FR.tz) / 1e6) * 1.2, 1e-9, d.local_date);
  }
});

test('FR: a tariff in pounds cannot be agreed for a home billed in euros', () => {
  const t = createTariff({ provider: 'synthetic', tariffCode: 'TEST-FR-GBP', country: 'FR', currency: 'GBP', structure: 'flat', kind: 'flat', origin: 'synthetic' });
  assert.throws(() => agreeTariff({ siteId: fr.site.id, deviceId: fr.devices.imp.id, tariffId: t.id, validFrom: dayBounds(m.FR.tz, '2026-04-01')[0] }), /tariff currency differs from the home currency/);
  assert.throws(() => db.prepare("UPDATE site SET currency = 'GBP' WHERE id = ?").run(fr.site.id), /currency differs/);
});

test('NL: quarter-hour prices with a negative quarter, per-kWh tax, a yearly credit and VAT on top', () => {
  const rows = m.hhRows(nl.site.id, m.NL.from, m.NL.to);
  const neg = rows.find((r) => r.slot_start === Date.parse(m.NL.negativeAt) / 1000);
  near(neg.import_rate_ex, -16 + 10.154);
  near(m.inc(neg), (-16 + 10.154) * 1.21);
  assert.ok(neg.grid_import > 0 && neg.total_cost - neg.standing_cost < 0, 'paid to import');
  for (const d of m.dayRows(nl.site.id, m.NL.from, m.NL.to)) {
    const [a, b] = dayBounds(m.NL.tz, d.local_date);
    const want = (fixedChargeMicro(m.NL.monthlyFee, 'month', a, b, m.NL.tz) / 1e6 + m.NL.dailyNetwork - 63519 * ((b - a) / (365 * 86400))) * 1.21;
    near(d.standing_cost, want, 1e-9, d.local_date);
  }
  // The price paid is (unitEx + levy) x (1 + vat) for any supplier price: what applyTaxes gives.
  const p = loadPricing(nl.site.id, ...dayBounds(m.NL.tz, m.NL.change));
  const t = taxesAt(p, 'electricity', 'import', neg.slot_start);
  const rules = rulesFor(p.taxRules, { country: 'NL', fuel: 'electricity', direction: 'import', ts: neg.slot_start });
  for (const u of [-40, -16, 0, 3.3, 25]) near((u + t.levy) * (1 + t.vat), applyTaxes(rules, { currency: 'EUR', unitEx: u, kwh: 1, slotS: 900, yearLengthS: 365 * 86400 }).inc.unit, 1e-9, `u=${u}`);
  assert.equal(t.unverified, true);
  // Money from the comparison page is labelled with the home's currency.
  assert.equal(compareSite(nl.site.id, m.NL.from, m.NL.to).currency, 'EUR');
});

test('a fixed charge needs a charge period, and registers beyond single/day/night are stored', () => {
  assert.throws(() => putRateRows(nl.tariffs.dyn.id, [{ component: 'fixed', validFrom: 0, validTo: 10, price: 1 }]), /CHECK/);
  assert.throws(() => putRateRows(nl.tariffs.dyn.id, [{ component: 'unit', chargePeriod: 'day', validFrom: 0, validTo: 10, price: 1 }]), /CHECK/);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM rate_interval WHERE register IN ('hp', 'hc', 'blue_hc', 'red_hp')").get().n > 0);
  // The overlap guard still holds for the new components.
  const [a] = dayBounds(m.NL.tz, m.NL.from);
  assert.throws(() => putRateRows(nl.tariffs.dyn.id, [{ component: 'fixed', register: 'supply', chargePeriod: 'month', validFrom: a, validTo: a + 3600, price: 1 }]), /overlapping current rate interval/);
});

// Last: rebuilds the NL home's serving rows in 30 and 60-minute slots through the queue.
test('NL: switching to 30 and 60-minute slots keeps every kWh and fixed charge; cost follows the time-weighted price', () => {
  const fine = m.hhRows(nl.site.id, m.NL.from, m.NL.to);
  assert.throws(() => setSlotLength(nl.site.id, 1200), /slot_s must be one of/);
  for (const slotS of [1800, 3600]) {
    const r = setSlotLength(nl.site.id, slotS);
    assert.equal(r.queued, true);
    const done = processQueue().find((x) => x.siteId === nl.site.id);
    assert.equal(done.from, m.NL.from);
    // Only the days with data, not every day from the first one to today.
    assert.deepEqual([done.to, done.days], [m.NL.to, 3]);
    const coarse = m.hhRows(nl.site.id, m.NL.from, m.NL.to);
    assert.ok(coarse.every((x) => x.dur_s === slotS));
    assert.equal(coarse.filter((x) => x.local_date === m.NL.change).length, (25 * 3600) / slotS);
    const A = m.perDay(fine, [...m.ENERGY, 'standing_cost', 'total_cost']); const B = m.perDay(coarse, [...m.ENERGY, 'standing_cost', 'total_cost']);
    for (const [d, x] of A) {
      for (const k of m.ENERGY) near(B.get(d)[k], x[k], 1e-9, `${slotS} ${d} ${k}`);
      near(B.get(d).standing_cost, x.standing_cost, 1e-9, `${slotS} ${d} fixed`);
    }
    const expect = m.expectedCoarseCost(fine, slotS, (t) => t - (t % slotS));
    for (const c of coarse) near(c.total_cost, expect.get(c.slot_start), 1e-9, `${slotS} slot ${c.slot_start}`);
    // Not identical: the negative-price hour moves the cost on 26 October.
    assert.ok(Math.abs(B.get(m.NL.change).total_cost - A.get(m.NL.change).total_cost) > 0.01);
  }
});
