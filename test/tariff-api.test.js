// T.7: GET /api/tariffs/:id/slots and GET /api/sites/:id/prices over HTTP, on a copy of the frozen real GB home (Intelligent Octopus,
// a fixed export, gas, and the real Agile and Agile Outgoing prices of its fortnight) and one extra home of another user: what the
// slots say (the same numbers as the pricing code, 25-hour and 23-hour days, a price known ahead, a missing price is missing),
// what each user may see (a home or a tariff that is not theirs answers as one that does not exist), and every bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
if (hasLive) await useDb({ snapshot: true });
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows } = await import('../src/core/tariffs.js');
const { buildSite } = await import('../src/core/build.js');
const { loadPricing } = await import('../src/core/pricing.js');
const { slotPrice, fixedShare, unitInc } = await import('../src/core/slot-price.js');
const { nowSec } = await import('../src/core/time.js');

const server = app.listen(0);
server.unref();   // never keeps the test process alive (a top-level after() runs too early: helpers.js)
async function get(p, user) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: user != null ? { 'x-user-id': String(user) } : {} });
  return { status: res.status, body: await res.json() };
}

let alice; let bob; let admin; let bobHome; let privateTariff;
if (hasLive) {
  alice = await createUser({ name: 'Alice', role: 'owner' }); await giveHome(alice.id, 1);
  bob = await createUser({ name: 'Bob', role: 'owner' });
  admin = await createUser({ name: 'Admin', role: 'admin' });
  bobHome = await createSite({ name: 'Bob', country: 'GB', gspRegion: 'G' });
  await giveHome(bob.id, bobHome.id);
  // A tariff only Bob's home has rows for (a previewed tariff of his): nobody else may see it exists.
  privateTariff = await createTariff({ provider: 'synthetic', tariffCode: 'SYN-BOB-ONLY', country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', name: 'Bob only', origin: 'synthetic' });
  await putRateRows(privateTariff.id, [{ component: 'unit', validFrom: 0, validTo: null, price: 20 }], { siteId: bobHome.id });
  await buildSite(1, '2026-10-14', '2026-10-15');   // a few days of stored price slots
}
const AGILE = 'E-1R-AGILE-24-10-01-G';
const t = (iso) => Date.parse(iso) / 1000;

await test('home timeline: the stored slots of a built day are returned as they are stored, and equal the pricing code', { skip }, async () => {
  const r = await get('/api/sites/1/prices?from=2026-10-14&to=2026-10-15&point=meter_import', alice.id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.slot_s, r.body.currency, r.body.tz], [1800, 'GBP', 'Europe/London']);
  assert.equal(r.body.computed, 0, 'every slot of a built day is in the table');
  assert.equal(r.body.stored, 48);
  const [imp] = r.body.points;
  assert.deepEqual([imp.point, imp.slots.length, imp.known, imp.unknown], ['meter_import', 48, 48, 0]);
  const from = t('2026-10-13T23:00:00Z');
  const p = await loadPricing(1, from, from + 86400, null, { rateRows: true });
  for (const s of imp.slots) {
    const price = slotPrice(p, 'meter_import', s.slot_start, 1800);
    assert.equal(s.unit_inc, unitInc(price), `unit price of slot ${s.slot_start}`);
    assert.equal(s.fixed_inc, fixedShare(price, s.slot_start, 1800, 'Europe/London'), `fixed share of slot ${s.slot_start}`);
    assert.equal(s.register, price.register);
    assert.equal(s.tariff, price.tariffCode);
  }
  assert.ok(imp.slots.some((s) => s.register === 'night') && imp.slots.some((s) => s.register === 'day'), 'Intelligent Octopus has both registers');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM supply_price_slot WHERE site_id = 1 AND point = ? AND slot_start >= ? AND slot_start < ?').get('meter_import', from, from + 86400)).n, 48);
});

await test('home timeline: seven days ahead are priced (an open-ended tariff is known into the future), nothing is stored by the read', { skip }, async () => {
  const before = (await db.prepare('SELECT COUNT(*) n FROM supply_price_slot').get()).n;
  const r = await get('/api/sites/1/prices', alice.id);   // today and seven days ahead
  assert.equal(r.status, 200);
  const now = nowSec();
  assert.ok(r.body.to - r.body.from >= 8 * 82800 && r.body.from <= now && r.body.to > now + 7 * 86400);
  const byPoint = Object.fromEntries(r.body.points.map((p) => [p.point, p]));
  assert.deepEqual(Object.keys(byPoint).sort(), ['meter_export', 'meter_gas', 'meter_import']);
  for (const k of ['meter_import', 'meter_export']) {
    const p = byPoint[k];
    assert.equal(p.unknown, 0, `${k}: every slot has a price`);
    assert.ok(p.priced_until >= now + 7 * 86400, `${k} is priced at least seven days ahead (until ${new Date(p.priced_until * 1000).toISOString()})`);
    assert.ok(p.slots.every((s) => s.dur_s === 1800 && s.known && s.unit_inc != null));
  }
  assert.ok(r.body.computed > 0 && r.body.stored === 0, 'the future is computed on read');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM supply_price_slot').get()).n, before, 'a read writes nothing');
  // The home's own day by day: 48 slots a day, 46 and 50 on the clock changes.
  const over = await get('/api/sites/1/prices?from=2026-10-25&to=2026-10-26&point=meter_export&point=meter_import', alice.id);
  assert.deepEqual(over.body.points.map((p) => [p.point, p.slots.length]).sort(), [['meter_export', 50], ['meter_import', 50]]);
});

await test('reading a tariff nobody is on stores nothing: its runs are made in memory, the prices are its rate rows', { skip }, async () => {
  const cand = await createTariff({ provider: 'synthetic', tariffCode: 'SYN-CANDIDATE', country: 'GB', currency: 'GBP', structure: 'flat', kind: 'flat', name: 'Candidate', origin: 'synthetic' });
  await putRateRows(cand.id, [{ component: 'unit', validFrom: 0, validTo: null, price: 30 }]);
  const r = await get(`/api/tariffs/${cand.id}/slots?from=2026-10-14&to=2026-10-15`);
  assert.equal(r.status, 200);
  assert.ok(r.body.slots.length === 48 && r.body.slots.every((s) => s.supply_ex === 30), 'priced from its rate rows');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tariff_price_run WHERE tariff_id = ?').get(cand.id)).n, 0, 'no runs stored');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tariff_price_state WHERE tariff_id = ?').get(cand.id)).n, 0, 'no state stored');
  assert.equal((await get(`/api/tariffs/${cand.id}/slots?from=2026-10-14&to=2026-10-15`)).body.slots.length, 48, 'and again');
});

await test('a tariff\'s slots without a home: its market\'s zone and taxes, 50 half-hours on the 25-hour day, 46 on the 23-hour day, the shared runs only', { skip }, async () => {
  const day = await get(`/api/tariffs/${AGILE}/slots?from=2026-10-25&to=2026-10-26`);
  assert.equal(day.status, 200);
  assert.deepEqual([day.body.tariff, day.body.point, day.body.tz, day.body.slot_s, day.body.priced_for], [AGILE, 'meter_import', 'Europe/London', 1800, { market: 'GB' }]);
  assert.deepEqual([day.body.slots.length, day.body.known, day.body.unknown], [50, 50, 0]);
  assert.ok(day.body.slots.every((s, i) => s.slot_start === day.body.from + i * 1800));
  // Prices equal the rate rows (Agile has one row per half-hour); tax from the country's rules.
  const rows = await db.prepare(`SELECT r.valid_from, r.price_ex_vat FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.tariff_code = ? AND r.component = 'unit'
    AND r.superseded_at IS NULL AND r.valid_from >= ? AND r.valid_from < ? ORDER BY r.valid_from`).all(AGILE, day.body.from, day.body.to);
  assert.equal(rows.length, 50);
  rows.forEach((r, i) => { assert.equal(day.body.slots[i].supply_ex, r.price_ex_vat); assert.equal(day.body.slots[i].unit_inc, r.price_ex_vat * (1 + day.body.slots[i].vat)); });
  // The same tariff at 15 and 60 minutes: the hour is the time-weighted mean of its two half-hours.
  const hour = await get(`/api/tariffs/${AGILE}/slots?from=2026-10-25&to=2026-10-26&slot_s=3600`);
  assert.equal(hour.body.slots.length, 25);
  const k = hour.body.slots.findIndex((s) => s.weighted);
  assert.ok(k >= 0 && hour.body.slots.every((s) => s.dur_s === 3600));
  const a = day.body.slots.find((s) => s.slot_start === hour.body.slots[k].slot_start); const b = day.body.slots.find((s) => s.slot_start === hour.body.slots[k].slot_start + 1800);
  assert.ok(Math.abs(hour.body.slots[k].unit_ex - (a.unit_ex + b.unit_ex) / 2) < 1e-9);
  assert.equal((await get(`/api/tariffs/${AGILE}/slots?from=2026-10-25&to=2026-10-26&slot_s=900`)).body.slots.length, 100);
  // By id as by code; the 23-hour day on a tariff open since March (the export tariff).
  const exportT = await db.prepare("SELECT id FROM tariff WHERE tariff_code = 'E-1R-OUTGOING-VAR-24-10-26-G'").get();
  const spring = await get(`/api/tariffs/${exportT.id}/slots?from=2026-03-29&to=2026-03-30`);
  assert.deepEqual([spring.body.point, spring.body.slots.length, spring.body.known], ['meter_export', 46, 46]);
});

await test('a missing price is missing: a slot with no published price has no price, never a guess', { skip }, async () => {
  const r = await get(`/api/tariffs/${AGILE}/slots?from=2026-11-20&to=2026-11-21`);   // after the last published Agile day
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.slots.length, r.body.known, r.body.unknown, r.body.priced_until], [48, 0, 48, null]);
  for (const s of r.body.slots) assert.deepEqual([s.known, s.unit_ex, s.unit_inc, s.supply_ex], [false, null, null, null]);
});

await test('a tariff priced for a home: its zone, its taxes and its slot length; a currency that is not the home\'s is refused', { skip }, async () => {
  const r = await get(`/api/tariffs/${AGILE}/slots?from=2026-10-14&to=2026-10-15&site=1`, alice.id);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.priced_for, r.body.slots.length], [{ site: 1 }, 48]);
  const bare = await get(`/api/tariffs/${AGILE}/slots?from=2026-10-14&to=2026-10-15`);
  assert.deepEqual(r.body.slots.map((s) => s.unit_inc), bare.body.slots.map((s) => s.unit_inc), 'the same Agile prices and the same GB taxes');
  await createTariff({ provider: 'synthetic', tariffCode: 'SYN-EUR', country: 'GB', currency: 'EUR', structure: 'flat', kind: 'flat', name: 'EUR tariff', origin: 'synthetic' });
  const eur = await get('/api/tariffs/SYN-EUR/slots?from=2026-10-14&to=2026-10-15&site=1', alice.id);
  assert.equal(eur.status, 400); assert.match(eur.body.error, /two currencies/);
});

await test('access: a home that is not yours is a home that does not exist, on both endpoints; an admin sees every home', { skip }, async () => {
  for (const p of ['/api/sites/1/prices', `/api/tariffs/${AGILE}/slots?site=1`]) {
    assert.equal((await get(p, alice.id)).status, 200, p);
    assert.equal((await get(p, admin.id)).status, 200, p);
    const other = await get(p, bob.id); assert.equal(other.status, 404, p);
    assert.deepEqual(other.body, { error: 'No such home' });
  }
  assert.equal((await get('/api/sites/1/prices')).status, 404, 'nobody signed in: only homes no user owns');
  assert.equal((await get(`/api/sites/${bobHome.id}/prices`, alice.id)).status, 404);
  assert.equal((await get('/api/sites/999999/prices', admin.id)).status, 404);
});

await test('access: a tariff known only through one home\'s own rows is that home\'s: others get "no such tariff"; shared tariffs are everyone\'s', { skip }, async () => {
  const code = 'SYN-BOB-ONLY';
  assert.equal((await get(`/api/tariffs/${code}/slots?from=2026-10-14&to=2026-10-15`, bob.id)).status, 200);
  assert.equal((await get(`/api/tariffs/${code}/slots?from=2026-10-14&to=2026-10-15`, admin.id)).status, 200);
  const hidden = await get(`/api/tariffs/${code}/slots?from=2026-10-14&to=2026-10-15`, alice.id);
  assert.deepEqual([hidden.status, hidden.body.error], [404, 'No such tariff']);
  assert.deepEqual((await get('/api/tariffs/NO-SUCH-TARIFF/slots', alice.id)).body.error, 'No such tariff', 'the same words for a tariff that does not exist');
  assert.equal((await get(`/api/tariffs/${AGILE}/slots?from=2026-10-14&to=2026-10-15`, bob.id)).status, 200);
  // Without a home only the shared runs are read: Bob's own price of his tariff is not in an answer about no home; with his home it is.
  const bare = await get(`/api/tariffs/${code}/slots?from=2026-10-14&to=2026-10-15`, bob.id);
  assert.equal(bare.body.known, 0, 'no shared price: nothing priced without a home');
  const own = await get(`/api/tariffs/${code}/slots?from=2026-10-14&to=2026-10-15&site=${bobHome.id}`, bob.id);
  assert.deepEqual([own.body.known, own.body.slots[0].supply_ex], [48, 20]);
});

await test('bad input is 400 with a reason: spans, dates, slot lengths, a date with no zone', { skip }, async () => {
  const bad = async (p, re, user = alice.id) => { const r = await get(p, user); assert.equal(r.status, 400, p); assert.match(r.body.error, re, p); };
  await bad('/api/sites/1/prices?from=2026-10-15&to=2026-10-14', /from must be before to/);
  await bad('/api/sites/1/prices?from=2026-01-01&to=2026-06-01', /at most 62 days/);
  await bad('/api/sites/1/prices?from=yesterday', /from: epoch seconds or a date/);
  await bad('/api/sites/1/prices?from=2026-02-30&to=2026-03-02', /not a date/);
  await bad(`/api/tariffs/${AGILE}/slots?slot_s=7`, /slot_s must be one of 900, 1800, 3600/);
  await bad(`/api/tariffs/${AGILE}/slots?slot_s=abc`, /slot_s must be one of/);
  await db.prepare("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, country, currency, kind, origin) VALUES ('synthetic', 'SYN-ZZ', 'electricity', 'import', 'flat', 'ZZ', 'GBP', 'flat', 'synthetic')").run();
  await bad('/api/tariffs/SYN-ZZ/slots?from=2026-10-14&to=2026-10-15', /a date needs a zone/);
  await bad('/api/tariffs/SYN-ZZ/slots?from=1790000000&to=1790003600', /no market with a known zone/);
});
