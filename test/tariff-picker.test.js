// The tariff picker (src/core/tariff-picker.js, delta 080): a home chooses its own supplier and tariff from the
// list its country's source holds, and the build prices it like any other home. GB is tested here with real
// Tariffscanner records (test/fixtures/tariffscanner) stored through the adapter; FR / NL (tounify) in
// test/tounify.test.js, against its fake API. What is checked:
//   - suppliers are rows of their own, linked from each source's name for them
//   - the lists of a region, in one shape (one price / two rate, payment methods, the supplier's night hours)
//   - a choice prices the home: at its own payment method (where the methods' prices differ, which priced
//     nothing before), and a day / night tariff from the meter's own hours (never priced before)
//   - the start day, changing the tariff (history kept), an Octopus account taking over, and the HTTP API
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { useDb } from './helpers.js';

useDb();
for (const k of ['TOUNIFY_API_KEY', 'TOUNIFY_DEV', 'OCTOPUS_API_KEY', 'TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`no network in tests: ${url}`); };

const { db } = await import('../src/db/db.js');
const TS = await import('../src/adapters/tariffscanner.js');
await import('../src/jobs/sync.js');   // registers the adapters
const PK = await import('../src/core/tariff-picker.js');
const { supplierCode, ensureSupplier, backfillSuppliers } = await import('../src/core/suppliers.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, addDevice, agreeTariff, putRateRows } = await import('../src/core/tariffs.js');
const { loadPricing, priceAt, meterRegister } = await import('../src/core/pricing.js');
const { app } = await import('../src/server.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'tariffscanner');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const RECORDS = [...load('page-1.json').data, ...load('page-2.json').data, ...load('page-day-night.json').data];
const rec = (pid, patch = {}) => ({ ...structuredClone(RECORDS.find((r) => r.product_id === pid)), ...patch });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// South Wales (Tariffscanner region 12 'Swalec' = gb_dno 21 = Octopus K):
//   Sainsbury's Fix and Reward, one price, paid by cheque (28.53p) or, here, by direct debit (27.00p)
//   Octopus 12M Fixed, one price, direct debit only
//   OVO 2 Year Fixed, day / night (31.56p / 20.75p), moved here from region 1, night 23:00-07:00
const SWALEC = { dno_region_id: 12, dno_region: 'Swalec' };
const mapped = TS.mapRecords([
  rec(330336),
  rec(330336, { payment_method: 'DDM', elec_import_unit_rate: 27.0, elec_standing_charge: 60.0 }),
  rec(330112),
  rec(330472, SWALEC),
  rec(3097),   // Southern: another region, never listed for this home
]);
TS.storeMapped(mapped);

const home = createSite({ name: 'Cardiff', country: 'GB', postcode: 'CF10 1AA', gspRegion: 'K' });
const siteRow = () => db.prepare('SELECT * FROM site WHERE id = ?').get(home.id);
const T = (code) => db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(code);
const at = (iso) => Date.parse(iso) / 1000;
const price = (ts, siteId = home.id) => priceAt(loadPricing(siteId, ts - 86400, ts + 86400), 'meter_import', ts);

const server = app.listen(0);
after(() => server.close());
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('delta 080: supplier tables, payment method on agreements and the onboarding questions', () => {
  for (const t of ['supplier', 'supplier_alias', 'market_question']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('tariff') WHERE name = 'supplier_id'").get());
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('tariff_agreement') WHERE name = 'payment_method'").get());
  assert.deepEqual(PK.questionsFor('GB', 'one_price'), []);
  assert.deepEqual(PK.questionsFor('GB', 'two_rate').map((q) => [q.field, q.required]), [['off_peak_hours', true]]);
  assert.deepEqual(PK.questionsFor('FR', 'two_rate').map((q) => q.field), ['contracted_kva', 'off_peak_hours']);
  assert.deepEqual(PK.questionsFor('FR', 'one_price').find((q) => q.field === 'contracted_kva').allowed, [3, 6, 9, 12, 15, 18, 24, 30, 36]);
  assert.deepEqual(PK.questionsFor('NL', 'dynamic'), [], 'the NL connection size 080 asked is gone (delta 082: it priced nothing)');
});

test('suppliers: our own code, one row per supplier and country, the source\'s name as an alias', () => {
  assert.equal(supplierCode("Sainsbury's Energy"), 'sainsburys-energy');
  assert.equal(supplierCode('E.ON Next'), 'eon-next');
  assert.equal(supplierCode('E'), 'e');
  assert.equal(supplierCode('Électricité de France'), 'electricite-de-france');
  // The adapter linked every tariff it stored.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tariff WHERE provider = 'tariffscanner' AND supplier_id IS NULL").get().n, 0);
  const sb = db.prepare("SELECT s.* FROM tariff t JOIN supplier s ON s.id = t.supplier_id WHERE t.tariff_code LIKE 'TS-330336-%'").get();
  assert.deepEqual([sb.country, sb.code, sb.name], ['GB', 'sainsburys-energy', "Sainsbury's Energy"]);
  // Two sources naming one supplier meet on one row; a second country is another supplier.
  const a = ensureSupplier({ provider: 'tariffscanner', country: 'GB', externalId: 'EDF Energy' });
  const b = ensureSupplier({ provider: 'octopus', country: 'GB', externalId: 'EDF-ENERGY', name: 'EDF Energy' });
  const fr = ensureSupplier({ provider: 'tounify', country: 'FR', externalId: 'EDF' });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, fr.id);
  // Tariffs written before the delta are linked from their name.
  const n = db.prepare("SELECT COUNT(*) AS n FROM tariff WHERE provider = 'tariffscanner'").get().n;
  db.prepare("UPDATE tariff SET supplier_id = NULL WHERE provider = 'tariffscanner'").run();
  assert.equal(backfillSuppliers(), n);
  assert.equal(backfillSuppliers(), 0);
});

test('lists: the suppliers and tariffs on offer in the home\'s region, in one shape', async () => {
  const s = await PK.listSuppliers(siteRow());
  assert.equal(s.source, 'tariffscanner');
  assert.deepEqual(s.suppliers.map((x) => [x.code, x.tariffs]), [['octopus-energy', 1], ['ovo-energy', 1], ['sainsburys-energy', 1]]);
  const sb = (await PK.listTariffs(siteRow(), 'sainsburys-energy')).tariffs;
  assert.equal(sb.length, 1);
  assert.equal(sb[0].kind, 'one_price');
  assert.equal(sb[0].name, 'Sainsburys Fix and Reward Fixed 24m v54');
  assert.deepEqual(sb[0].options.map((o) => [o.payment_method, o.unit[0].price, o.standing.price]), [['CAC', 28.53, 63.93], ['DDM', 27, 60]]);
  assert.equal(sb[0].default_payment_method, 'DDM');
  assert.deepEqual(sb[0].questions, []);
  const ovo = (await PK.listTariffs(siteRow(), 'ovo-energy')).tariffs[0];
  assert.equal(ovo.kind, 'two_rate');
  assert.deepEqual(ovo.options[0].unit.map((u) => [u.register, u.price]), [['day', 31.559999999999995], ['night', 20.749999999999996]]);
  assert.deepEqual([ovo.hours.from, ovo.hours.to], ['23:00', '07:00']);
  assert.equal(ovo.questions[0].field, 'off_peak_hours');
  await assert.rejects(PK.listTariffs(siteRow(), 'no-such'), (e) => e.status === 404);
});

test('payment methods that disagree: unpriced without the home\'s method, priced at it with the choice', async () => {
  const t = T('TS-330336-E-constant-E-21');
  const meter = addDevice({ siteId: home.id, kind: 'meter_import', provider: 'manual', externalRef: 'test-no-method' });
  agreeTariff({ siteId: home.id, deviceId: meter.id, tariffId: t.id, validFrom: at('2026-10-24T00:00:00Z') });
  assert.equal(price(at('2026-10-30T12:00:00Z')).unitEx, null, 'CAC 28.53 and DDM 27.00 disagree: no price without the method');
  db.prepare('DELETE FROM tariff_agreement WHERE device_id = ?').run(meter.id);
  db.prepare('DELETE FROM device WHERE id = ?').run(meter.id);

  const r = await PK.chooseTariff(siteRow(), { supplier: 'sainsburys-energy', tariff: t.tariff_code, since: '2026-10-24' });
  assert.equal(r.payment_method, 'DDM');
  assert.equal(r.from, '2026-10-24');
  const p = price(at('2026-10-30T12:00:00Z'));
  near(p.unitEx, 27, 'the direct-debit price');
  near(p.standingEx, 60, 'the direct-debit standing charge');
  // Paying by cheque instead prices at the cheque rate.
  await PK.chooseTariff(siteRow(), { supplier: 'sainsburys-energy', tariff: t.tariff_code, since: '2026-10-24', payment_method: 'CAC' });
  near(price(at('2026-10-30T12:00:00Z')).unitEx, 28.53, 'the cheque price');
  await assert.rejects(PK.chooseTariff(siteRow(), { supplier: 'sainsburys-energy', tariff: t.tariff_code, payment_method: 'PRE' }), /payment_method must be one of CAC, DDM/);
});

test('day / night: priced from the meter\'s own hours; without them the half-hour stays unpriced', async () => {
  const t = T('TS-330472-E-day_night-E-21');
  const r = await PK.chooseTariff(siteRow(), { supplier: 'ovo-energy', tariff: t.tariff_code, since: '2026-10-26', hours: { from: '00:30', to: '07:30' } });
  assert.deepEqual(r.hours, { from: '00:30', to: '07:30' });
  // GMT from 25 Oct: local = UTC.
  near(price(at('2026-10-30T03:00:00Z')).unitEx, 20.749999999999996, 'night inside the meter\'s window');
  near(price(at('2026-10-30T00:00:00Z')).unitEx, 31.559999999999995, '00:00 is before this meter\'s 00:30 switch: day');
  near(price(at('2026-10-30T12:00:00Z')).unitEx, 31.559999999999995, 'day');
  // The supplier's usual hours are taken when the user keeps them.
  const r2 = await PK.chooseTariff(siteRow(), { supplier: 'ovo-energy', tariff: t.tariff_code, since: '2026-10-26' });
  assert.deepEqual(r2.hours, { from: '23:00', to: '07:00' });
  near(price(at('2026-10-30T23:30:00Z')).unitEx, 20.749999999999996, 'a window across midnight');
  near(price(at('2026-10-30T07:00:00Z')).unitEx, 31.559999999999995, 'the window ends at 07:00');
  // Without a meter's own hours an e7 tariff is not priced (as before), and windows of a weekday mask are read on their start day.
  const p = { tz: 'Europe/London', meterWindows: new Map([[1, [{ register: 'night', start_min: 1380, end_min: 420, weekdays: 0b0000001, clock: 'local' }]]]) };
  assert.equal(meterRegister({ ...p, meterWindows: new Map() }, 1, at('2026-11-02T01:00:00Z')), null);
  assert.equal(meterRegister(p, 1, at('2026-11-02T23:30:00Z')), 'night', 'Monday 23:30, a Monday window');
  assert.equal(meterRegister(p, 1, at('2026-11-03T01:00:00Z')), 'night', 'Tuesday 01:00, the Monday window still');
  assert.equal(meterRegister(p, 1, at('2026-11-03T23:30:00Z')), 'day', 'Tuesday 23:30: not a Tuesday window');
  await assert.rejects(PK.chooseTariff(siteRow(), { supplier: 'ovo-energy', tariff: t.tariff_code, hours: { from: '25:00', to: '07:00' } }), /hours must be/);
});

test('start day and changes: never before the first known price; a change keeps the earlier tariff as history', async () => {
  const oct = T('TS-330112-E-constant-E-21');
  const r = await PK.chooseTariff(siteRow(), { supplier: 'octopus-energy', tariff: oct.tariff_code, since: '2026-09-01' });
  const first = db.prepare("SELECT MIN(valid_from) AS t FROM rate_interval WHERE tariff_id = ? AND component = 'unit'").get(oct.id).t;
  assert.equal(r.from, new Date((first + 3600) * 1000).toISOString().slice(0, 10), 'the first priced day (BST midnight)');
  assert.ok(r.from > '2026-09-01');
  assert.match(r.notes[0], /first day this tariff's price is known/);
  // A later change: the Octopus tariff runs to the new start, the OVO one from it.
  const ovo = T('TS-330472-E-day_night-E-21');
  await PK.chooseTariff(siteRow(), { supplier: 'ovo-energy', tariff: ovo.tariff_code, since: '2026-11-01' });
  const rows = db.prepare(`SELECT t.tariff_code, a.valid_from, a.valid_to, a.payment_method FROM tariff_agreement a JOIN tariff t ON t.id = a.tariff_id JOIN device d ON d.id = a.device_id
    WHERE d.site_id = ? AND d.provider = 'picker' AND a.superseded_at IS NULL ORDER BY a.valid_from`).all(home.id);
  assert.deepEqual(rows.map((x) => [x.tariff_code, x.valid_to == null ? null : 'ends', x.payment_method]), [[oct.tariff_code, 'ends', 'DDM'], [ovo.tariff_code, null, 'DDM']]);
  assert.equal(rows[0].valid_to, rows[1].valid_from);
  near(price(at('2026-10-30T12:00:00Z')).unitEx, 30.93, 'October: the Octopus fixed price');
  near(price(at('2026-11-02T12:00:00Z')).unitEx, 31.559999999999995, 'November: OVO day');
  const c = PK.tariffChoice(siteRow());
  assert.equal(c.current.tariff, ovo.tariff_code);
  assert.equal(c.current.supplier.code, 'ovo-energy');
  assert.deepEqual(c.current.hours, [{ from: '23:00', to: '07:00' }]);
  // The rebuild is queued from the new start.
  assert.ok(db.prepare("SELECT 1 FROM rebuild_queue WHERE site_id = ? AND reason = 'tariff chosen by the user'").get(home.id));
});

test('an Octopus account takes over: the chosen tariff ends where the account\'s begin, and no list choice is taken', async () => {
  const acc = createTariff({ provider: 'octopus', tariffCode: 'E-1R-TEST-ACCOUNT-K', structure: 'flat', kind: 'flat', country: 'GB', currency: 'GBP', origin: 'provider', region: '21' });
  putRateRows(acc.id, [{ component: 'unit', validFrom: at('2026-10-01T00:00:00Z'), price: 24 }]);
  const meter = addDevice({ siteId: home.id, kind: 'meter_import', provider: 'octopus', externalRef: '2100000000000' });
  agreeTariff({ siteId: home.id, deviceId: meter.id, tariffId: acc.id, validFrom: at('2026-11-02T00:00:00Z') });
  assert.equal(PK.retirePickedMeters(home.id), 1);
  assert.ok(db.prepare("SELECT retired_at FROM device WHERE site_id = ? AND provider = 'picker'").get(home.id).retired_at);
  near(price(at('2026-11-01T12:00:00Z')).unitEx, 31.559999999999995, 'the day before the account: the chosen tariff still');
  near(price(at('2026-11-03T12:00:00Z')).unitEx, 24, 'from the account\'s start: the account tariff');
  await assert.rejects(PK.chooseTariff(siteRow(), { supplier: 'ovo-energy', tariff: 'TS-330472-E-day_night-E-21' }), (e) => e.status === 409 && /octopus account/.test(e.message));
  assert.equal(PK.tariffChoice(siteRow()).available, false);
  assert.equal(PK.retirePickedMeters(home.id), 0, 'idempotent');
});

test('HTTP: lists, choice and errors through the API', async () => {
  const h2 = createSite({ name: 'Swansea', country: 'GB', postcode: 'SA1 1AA', gspRegion: 'K' });
  const s = await call('GET', `/api/sites/${h2.id}/suppliers`);
  assert.equal(s.status, 200);
  assert.equal(s.body.suppliers.length, 3);
  const t = await call('GET', `/api/sites/${h2.id}/suppliers/sainsburys-energy/tariffs`);
  assert.equal(t.body.tariffs[0].id, 'TS-330336-E-constant-E-21');
  const bad = await call('POST', `/api/sites/${h2.id}/tariff`, { supplier: 'ovo-energy', tariff: 'TS-330472-E-day_night-E-21', hours: { from: 'x', to: '07:00' } });
  assert.equal(bad.status, 400);
  const ok = await call('POST', `/api/sites/${h2.id}/tariff`, { supplier: 'sainsburys-energy', tariff: 'TS-330336-E-constant-E-21', since: '2026-10-24' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.payment_method, 'DDM');
  assert.equal(ok.body.choice.current.tariff, 'TS-330336-E-constant-E-21');
  // A home with no data yet (the tariff is asked for before the inverter loads its history): not "today", but far
  // enough back for the days the inverter's first sync loads, never before the tariff's first price.
  const h3 = createSite({ name: 'Newport', country: 'GB', postcode: 'NP10 8AA', gspRegion: 'K' });
  const early = await call('POST', `/api/sites/${h3.id}/tariff`, { supplier: 'sainsburys-energy', tariff: 'TS-330336-E-constant-E-21' });
  assert.ok(early.body.from < new Date().toISOString().slice(0, 10), early.body.from);
  const c = await call('GET', `/api/sites/${h2.id}/tariff-choice`);
  assert.equal(c.body.source, 'tariffscanner');
  assert.equal(c.body.current.chosen, true);
  // A French home without tounify switched on: the list is not available, said plainly.
  const fr = createSite({ name: 'Lyon', country: 'FR', postcode: '69001' });
  const f = await call('GET', `/api/sites/${fr.id}/suppliers`);
  assert.equal(f.status, 503);
  assert.match(f.body.error, /tounify tariff list is not available/);
  // A home in a region the catalogue does not hold.
  const none = createSite({ name: 'Nowhere', country: 'GB', postcode: 'ZZ1 1ZZ' });
  assert.equal((await call('GET', `/api/sites/${none.id}/suppliers`)).status, 503);
});
