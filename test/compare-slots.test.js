// T.6: the comparison prices a candidate tariff from slots (the home's slot energy x the candidate's slots, the same supply-price
// code as the home's own bill) and the totals are the ones compare.js gave when it priced on the fly.
// test/fixtures/compare-ref.json.gz was recorded with the code before T.6 (compare.js pricing an alternative with slotPrice and
// fixedPerDay per slot) over: the real GB home with its real Agile and Agile Outgoing prices, the synthetic GB, FR and NL homes with an alternative tariff that has a daily, a monthly and a yearly fixed
// charge. Numbers are compared to 1e-9 relative: a fixed charge is shared per slot now and per day then, so the last bits differ.
// UPDATE_COMPARE_REF=1 re-records from the code as it is: only for a number that is meant to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture (test/fixtures/gb-home.json.gz)';
const REF = path.join(import.meta.dirname, 'fixtures', 'compare-ref.json.gz');
await useDb({ snapshot: hasLive });
const { db } = await import('../src/db/db.js');
const M = await import('../scripts/lib/multi-market.js');
const { createTariff, putRateRows } = await import('../src/core/tariffs.js');
const { compareSite } = await import('../src/core/compare.js');
const { dayBounds, addDays } = await import('../src/core/time.js');

// A deterministic Agile-like price in pence: half-hourly, a morning and an evening peak, one negative stretch, and a
// few half-hours with no price at all (so the comparison skips them like-for-like).
const agile = (ts) => { const h = Math.floor(ts / 1800); return Math.round((12 + 9 * Math.sin(h / 5.3) + 14 * (((h % 48) >= 32 && (h % 48) < 38) ? 1 : 0) - (h % 211 < 3 ? 40 : 0)) * 100) / 100; };
const missing = (ts) => Math.floor(ts / 1800) % 97 === 5;

async function agileTariffs() {
  const mk = async (tariffCode, direction, name) => await db.prepare('SELECT id FROM tariff WHERE tariff_code = ?').get(tariffCode) ?? await createTariff({ provider: 'octopus', tariffCode, direction, structure: direction === 'import' ? 'dynamic' : 'export', kind: 'dynamic', nativePeriodS: 1800, country: 'GB', currency: 'GBP', name, origin: 'provider' });
  return { imp: await mk('E-1R-AGILE-24-10-01-G', 'import', 'Agile Octopus'), out: await mk('E-1R-AGILE-OUTGOING-19-05-13-G', 'export', 'Agile Outgoing') };
}
// Prices for the local days from..to (and two days either side), half-hourly, with the gaps of `missing`.
async function agilePrices({ imp, out }, tz, from, to) {
  const a = dayBounds(tz, addDays(from, -2))[0]; const b = dayBounds(tz, addDays(to, 3))[0];
  const rows = (f) => { const r = []; for (let t = a; t < b; t += 1800) if (!missing(t)) r.push({ component: 'unit', validFrom: t, validTo: t + 1800, price: f(t) }); return r; };
  const standing = await db.prepare("SELECT 1 FROM rate_interval WHERE tariff_id = ? AND component = 'standing' AND superseded_at IS NULL").get(imp.id);
  await putRateRows(imp.id, [...rows(agile), ...(standing ? [] : [{ component: 'standing', validFrom: a, validTo: b, price: 46.36 }])]);
  await putRateRows(out.id, rows((t) => Math.max(0, agile(t) * 0.6)));
}

const homes = await M.buildScenario();
const agileSet = await agileTariffs();
await agilePrices(agileSet, M.GB.tz, M.GB.from, M.GB.to);
// The real home holds the real Agile and Agile Outgoing prices of its fortnight (the fixture); only the products are named here.
const meta = JSON.stringify({ products: { agileImport: 'AGILE-24-10-01', agileExport: 'AGILE-OUTGOING-19-05-13' } });
await db.prepare("INSERT INTO connection (site_id, provider, status, meta) VALUES (?, 'compare', 'ok', ?)").run(homes.gb.site.id, meta);
if (hasLive) await db.prepare("UPDATE connection SET meta = ? WHERE site_id = 1 AND provider = 'compare'").run(meta);

// Alternatives with every kind of fixed charge, for the non-GB homes.
const frFrom = dayBounds(M.FR.tz, M.FR.from)[0]; const frTo = dayBounds(M.FR.tz, addDays(M.FR.to, 2))[0];
const fr = await createTariff({ provider: 'synthetic', tariffCode: 'SYN-FR-BASE', country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', name: 'Synthetic FR base', origin: 'synthetic' });
await putRateRows(fr.id, [{ component: 'unit', validFrom: frFrom, validTo: frTo, price: 19.5 }, { component: 'standing', validFrom: frFrom, validTo: frTo, price: 41 },
  { component: 'fixed', chargePeriod: 'month', validFrom: frFrom, validTo: frTo, price: 310 }]);
const nlFrom = dayBounds(M.NL.tz, M.NL.from)[0]; const nlTo = dayBounds(M.NL.tz, addDays(M.NL.to, 2))[0];
const nl1 = await createTariff({ provider: 'synthetic', tariffCode: 'SYN-NL-FLAT', country: 'NL', currency: 'EUR', structure: 'flat', kind: 'flat', name: 'Synthetic NL flat', origin: 'synthetic' });
await putRateRows(nl1.id, [{ component: 'unit', validFrom: nlFrom, validTo: nlTo, price: 25 }]);
const nl2 = await createTariff({ provider: 'synthetic', tariffCode: 'SYN-NL-FIXED', country: 'NL', currency: 'EUR', structure: 'flat', kind: 'flat', name: 'Synthetic NL fixed charges', origin: 'synthetic' });
await putRateRows(nl2.id, [{ component: 'unit', validFrom: nlFrom, validTo: nlTo, price: 21 }, { component: 'standing', validFrom: nlFrom, validTo: nlTo, price: 33 },
  { component: 'fixed', chargePeriod: 'month', validFrom: nlFrom, validTo: nlTo, price: 450 }, { component: 'fixed', chargePeriod: 'year', validFrom: nlFrom, validTo: nlTo, price: 1800 }]);

const sig = (x) => (typeof x === 'number' ? Number(x.toPrecision(13)) : x);
// What the comparison says, as numbers: every scenario's totals, each day, the average day, the windows, every slot.
function digest(c) {
  if (!c.ready) return { ready: false, reason: c.reason };
  const nums = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' || v === null).map(([k, v]) => [k, sig(v)]));
  return {
    head: nums(c), scenarios: c.scenarios.map((s) => ({ key: s.key, ...nums(s), origin: s.origin })), daily: c.daily.map((d) => ({ ...nums(d), date: d.date })),
    profile: c.profile.map(nums), windows: Object.fromEntries(Object.entries(c.windows).map(([k, v]) => [k, nums(v)])),
    insights: c.insights.map((i) => `${i.tone}|${i.title}|${i.detail}`), provenance: c.provenance,
    slots: c.slots.map((s) => [s.slot_start, ...['import', 'export', 'current', 'agile', 'current_export', 'agile_export'].map((k) => sig(s[k]))]),
  };
}

const RUNS = [
  ['GB real home with Agile and Agile Outgoing', () => 1, '2026-10-12', '2026-10-26', !hasLive],
  ['GB synthetic home with Agile and Agile Outgoing', () => homes.gb.site.id, M.GB.from, M.GB.to, false],
  ['FR synthetic home with a flat tariff, standing and monthly charge', () => homes.fr.site.id, M.FR.from, M.FR.to, false],
  ['NL synthetic home with two alternatives (flat; daily, monthly and yearly charges)', () => homes.nl.site.id, M.NL.from, M.NL.to, false],
];
const got = {};
for (const [name, id, from, to, off] of RUNS) {
  await test(`${name}: the comparison is ready and covers every slot`, { skip: off ? skip : false }, async () => {
    const c = await compareSite(id(), from, to);
    assert.equal(c.ready, true, c.reason);
    assert.ok(c.slots.length > 100);
    got[name] = digest(c);
  });
}

function close(a, b, at) {
  if (typeof a === 'number' && typeof b === 'number') return assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${at}: ${a} vs ${b}`);
  if (Array.isArray(a) && Array.isArray(b)) { assert.equal(a.length, b.length, `${at}: length`); return a.forEach((x, i) => close(x, b[i], `${at}[${i}]`)); }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a), Object.keys(b), `${at}: keys`);
    return Object.keys(a).forEach((k) => close(a[k], b[k], `${at}.${k}`));
  }
  assert.deepStrictEqual(a, b, at);
}

if (process.env.UPDATE_COMPARE_REF === '1') {
  fs.writeFileSync(REF, zlib.gzipSync(JSON.stringify(got)));
} else {
  const ref = JSON.parse(zlib.gunzipSync(fs.readFileSync(REF)));
  for (const [name, , , , off] of RUNS) {
    await test(`${name}: totals, days, profile, windows, insights and every slot equal the recorded ones`, { skip: off ? skip : false }, async () => {
      close(got[name], ref[name], name);
    });
  }
}

// ───────────── one code path, two ways to read it ─────────────
const { withKnownAt } = await import('../src/core/facts.js');
const { tariffSlots, slotMoney } = await import('../src/core/tariff-slots.js');

await test('the comparison reads the home\'s stored slots and writes nothing', { skip }, async () => {
  const count = async () => (await db.prepare('SELECT COUNT(*) n FROM supply_price_slot').get()).n;
  await compareSite(1, '2026-10-12', '2026-10-26');   // makes sure the first read has happened
  const before = await count();
  const c = await compareSite(1, '2026-10-12', '2026-10-26');
  assert.equal(c.ready, true);
  assert.equal(await count(), before, 'a comparison stores no slot');
  // What it shows for the home's own tariff is what the table holds: change one stored price (same stamp) and the comparison shows it.
  const { buildSite } = await import('../src/core/build.js');
  await buildSite(1, '2026-10-14', '2026-10-14');
  const row = await db.prepare("SELECT slot_start, unit_ex, vat FROM supply_price_slot WHERE site_id = 1 AND point = 'meter_import' AND slot_start IN (SELECT slot_start FROM site_hh WHERE site_id = 1 AND state != 'missing') ORDER BY slot_start LIMIT 1").get();
  assert.ok(row, 'the build stored a slot');
  const was = c.slots.find((s) => s.slot_start === row.slot_start).current;
  assert.equal(was, row.unit_ex * (1 + row.vat));
  await db.prepare("UPDATE supply_price_slot SET unit_ex = unit_ex + 1 WHERE site_id = 1 AND point = 'meter_import' AND slot_start = ?").run(row.slot_start);
  const changed = (await compareSite(1, '2026-10-12', '2026-10-26')).slots.find((s) => s.slot_start === row.slot_start).current;
  await db.prepare("UPDATE supply_price_slot SET unit_ex = unit_ex - 1 WHERE site_id = 1 AND point = 'meter_import' AND slot_start = ?").run(row.slot_start);
  assert.equal(changed, (row.unit_ex + 1) * (1 + row.vat));
});

await test('a candidate\'s slots made in memory from the rate rows of a moment equal the ones made from the stored runs', { skip }, async () => {
  const tariff = await db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get('E-1R-AGILE-24-10-01-G');
  const site = await db.prepare('SELECT * FROM site WHERE id = 1').get();
  const from = Date.parse('2026-10-24T00:00:00Z') / 1000;
  const now = await tariffSlots(tariff, { site, from, to: from + 3 * 86400, slotS: 3600 });
  const asOf = await withKnownAt(Date.now(), async () => await tariffSlots(tariff, { site, from, to: from + 3 * 86400, slotS: 3600 }));
  assert.ok(now.known > 60 && now.slots.some((s) => s.weighted));
  assert.deepEqual(asOf, now);
});

await test('the money of a slot is the energy times the slot\'s prices, its share of the fixed charges added; no price is no money', () => {
  const slot = (unitEx, vat, fixedInc) => ({ price: { unitEx, vat }, fixedInc });
  assert.deepEqual(slotMoney(2, 0.5, slot(10, 0.2, 3), slot(4, 0, 0)), { importCost: 24, exportCredit: 2, fixed: 3 });
  assert.deepEqual(slotMoney(2, 0.5, slot(null, 0.2, 3), slot(4, 0, 0)), { importCost: null, exportCredit: 2, fixed: 3 });
  assert.deepEqual(slotMoney(2, 0.5, { price: null, fixedInc: 0 }, { price: null, fixedInc: 0 }), { importCost: null, exportCredit: null, fixed: 0 });
});
