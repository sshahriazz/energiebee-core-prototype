// Provenance labelling (src/core/provenance.js): every reference and price row carries an origin
// from one vocabulary, every priced slot records the weakest origin of what priced it, and the API
// exposes it additively. In a new, empty database; no provider is called.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { createSite, regionsOf, assignRegion } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice } = await import('../src/core/tariffs.js');
const { upsertTariff, putRates } = await import('../src/adapters/octopus.js');
const { buildSite } = await import('../src/core/build.js');
const { seriesId, putIntervals } = await import('../src/core/facts.js');
const { dayBounds, addDays, nowSec, localDate } = await import('../src/core/time.js');
const { PLACEHOLDER_TAX_RULES, GB_VAT_RULES } = await import('../src/core/tax.js');
const { MARKETS } = await import('../src/db/seed/markets.js');
const { GB_REGION_NOTE } = await import('../src/db/seed/regions-gb.js');
const { ORIGINS, weakest, inputsProvenance, periodProvenance, checkOrigin } = await import('../src/core/provenance.js');
const { app } = await import('../src/server.js');

const homes = m.buildScenario();

// Half-hourly import readings (kWh) over local days from..to for a meter.
function meterDays(device, tz, from, to, kwh = 0.4) {
  const [a] = dayBounds(tz, from); const [, b] = dayBounds(tz, to);
  const rows = [];
  for (let t = a; t < b; t += 1800) rows.push({ start: t, end: t + 1800, value: kwh });
  putIntervals(seriesId('device', device.id, 'grid_import_kwh', 'octopus_meter'), rows);
}

// A real-style French home (not a demo) on a tariff typed in by its user, taxed by the placeholder
// FR rules: its prices are only as good as the placeholder taxes.
function placeholderTaxedHome() {
  const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`);
  for (const r of PLACEHOLDER_TAX_RULES.filter((x) => x.country === 'FR')) {
    if (!db.prepare("SELECT 1 FROM tax_rule WHERE country = 'FR' AND code = ? AND superseded_at IS NULL").get(r.code)) {
      ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.currency, r.charge_period, r.seq, r.valid_from, r.valid_to, r.source, r.origin, r.origin_note);
    }
  }
  const site = createSite({ name: 'Real-style FR home', market: 'FR' });
  const dev = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'test', externalRef: 'PDL-1' });
  const t = createTariff({ provider: 'manual', tariffCode: 'USER-FR-BASE', country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', origin: 'user', originNote: 'typed in from the contract' });
  const [a] = dayBounds('Europe/Paris', '2026-01-10');
  putRateRows(t.id, [{ component: 'unit', validFrom: a, price: 20.16 }, { component: 'standing', validFrom: a, price: 40 }]);
  agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: a });
  meterDays(dev, 'Europe/Paris', '2026-01-10', '2026-01-11');
  buildSite(site.id, '2026-01-10', '2026-01-11');
  return site;
}

// A GB home priced as the live one is: an Octopus tariff and rates (provider), GB VAT (sourced).
function liveStyleGbHome() {
  const site = createSite({ name: 'Live-style GB home', market: 'GB', gspRegion: 'C' });
  assignRegion(site.id, { alias: { scheme: 'octopus_gsp', code: 'C' }, source: 'postcode_lookup' });
  const dev = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'octopus', externalRef: 'MPAN-1' });
  const t = upsertTariff({ tariffCode: 'E-1R-VAR-22-11-01-C', direction: 'import' });
  const [a] = dayBounds('Europe/London', '2026-02-01');
  putRates(t.id, 'unit', 'single', [{ validFrom: a, validTo: null, priceExVat: 24.1 }]);
  putRates(t.id, 'standing', 'single', [{ validFrom: a, validTo: null, priceExVat: 51.2 }]);
  agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: t.id, validFrom: a });
  meterDays(dev, 'Europe/London', '2026-02-01', '2026-02-02');
  buildSite(site.id, '2026-02-01', '2026-02-02');
  return site;
}

const frHome = placeholderTaxedHome();
const gbHome = liveStyleGbHome();
const lineages = (siteId) => db.prepare('SELECT lineage FROM site_hh WHERE site_id = ?').all(siteId).map((r) => JSON.parse(r.lineage));

test('the vocabulary: six words, strongest first; the weakest wins; a missing label counts as a placeholder', () => {
  assert.deepEqual(ORIGINS, ['sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic']);
  assert.equal(weakest(['sourced', 'provider', 'sourced']), 'provider');
  assert.equal(weakest(['provider', 'placeholder', 'user']), 'placeholder');
  assert.equal(weakest(['placeholder', 'synthetic']), 'synthetic');
  assert.equal(weakest(['sourced', null]), 'placeholder');
  assert.throws(() => checkOrigin('official'), /origin must be one of/);
  const p = inputsProvenance([{ what: 'tariff X', origin: 'provider' }, { what: 'tax_rule FR/tva', origin: 'placeholder' }, { what: 'tariff X', origin: 'provider' }]);
  assert.deepEqual(p, { origin: 'placeholder', placeholder_inputs: ['tax_rule FR/tva [placeholder]'] });
});

test('seeds carry the right origins: FR/NL/DE/BE/ES placeholder, GB VAT and GB regions sourced', () => {
  const markets = Object.fromEntries(db.prepare('SELECT code, origin FROM market').all().map((r) => [r.code, r.origin]));
  assert.deepEqual(markets, { GB: 'sourced', FR: 'placeholder', NL: 'placeholder', DE: 'placeholder', BE: 'placeholder', ES: 'placeholder' });
  for (const mk of MARKETS) assert.equal(mk.origin, markets[mk.code], mk.code);
  assert.ok(PLACEHOLDER_TAX_RULES.every((r) => r.origin === 'placeholder' && r.unverified === true && r.origin_note === r.source));
  assert.ok(GB_VAT_RULES.every((r) => r.origin === 'sourced' && /registry\.js VAT_RATES/.test(r.origin_note)));
  // In the database: GB VAT (copied by delta 002, labelled by 005) is sourced and names its source.
  const gbVat = db.prepare("SELECT origin, origin_note FROM tax_rule WHERE country = 'GB' AND code = 'vat'").all();
  assert.equal(gbVat.length, GB_VAT_RULES.length);
  assert.ok(gbVat.every((r) => r.origin === 'sourced' && /HMRC/.test(r.origin_note) && /Octopus published prices/.test(r.origin_note)));
  // The FR and NL rules the scenario wrote are placeholders.
  assert.deepEqual(db.prepare("SELECT DISTINCT origin FROM tax_rule WHERE country IN ('FR', 'NL')").all().map((r) => r.origin), ['placeholder']);
  // GB distribution regions: sourced, with the files named; bidding zones follow their market.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM region WHERE scheme = 'gb_dno' AND origin = 'sourced' AND origin_note = ?").get(GB_REGION_NOTE).n, 14);
  assert.match(GB_REGION_NOTE, /Octopus GSP letters/);
  assert.match(GB_REGION_NOTE, /MPAN distributor ids/);
  assert.match(GB_REGION_NOTE, /test\/fixtures\/tariffscanner/);
  const zones = Object.fromEntries(db.prepare("SELECT code, origin FROM region WHERE scheme = 'bzn'").all().map((r) => [r.code, r.origin]));
  assert.deepEqual(zones, { GB: 'sourced', FR: 'placeholder', NL: 'placeholder', 'DE-LU': 'placeholder', BE: 'placeholder', ES: 'placeholder' });
  assert.deepEqual(regionsOf(homes.gb.site.id).map((r) => [r.scheme, r.origin]), [['bzn', 'sourced'], ['gb_dno', 'sourced']]);
});

test('the demo\'s homes are demo homes, and everything the scenario generated is synthetic', () => {
  for (const h of [homes.gb, homes.fr, homes.nl]) assert.equal(m.siteRow(h.site.id).is_demo, 1, h.site.name);
  assert.deepEqual(db.prepare("SELECT DISTINCT origin FROM tariff WHERE tariff_code LIKE 'SYN-%'").all().map((r) => r.origin), ['synthetic']);
  assert.deepEqual(db.prepare("SELECT DISTINCT r.origin FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.tariff_code LIKE 'SYN-%'").all().map((r) => r.origin), ['synthetic']);
  assert.deepEqual(db.prepare('SELECT DISTINCT origin FROM register_window').all().map((r) => r.origin), ['synthetic']);
  assert.deepEqual(db.prepare('SELECT DISTINCT origin FROM calendar_day').all().map((r) => r.origin), ['synthetic']);
  // Every slot of a demo home says its data and its prices are synthetic.
  for (const h of [homes.gb, homes.fr, homes.nl]) {
    const L = lineages(h.site.id);
    assert.ok(L.length > 0 && L.every((l) => l.data_origin === 'synthetic' && l.origin === 'synthetic'), h.site.name);
  }
});

test('CHECK refuses an origin outside the vocabulary, and the writers refuse it before the database does', () => {
  for (const [table, where] of [['tariff', 'id = 1'], ['rate_interval', 'id = 1'], ['tax_rule', 'id = 1'], ['market', "code = 'GB'"], ['region', 'id = 1'], ['register_window', 'id = 1'], ['calendar_day', "calendar = 'fr_tempo'"]]) {
    assert.throws(() => db.exec(`UPDATE ${table} SET origin = 'official' WHERE ${where}`), /CHECK/, table);
  }
  assert.throws(() => db.exec(`UPDATE site SET contracted_kva = 6, contracted_kva_origin = 'bill' WHERE id = ${frHome.id}`), /CHECK/);
  assert.throws(() => createTariff({ provider: 'x', tariffCode: 'NO-ORIGIN', country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat' }), /origin must be one of/);
  assert.throws(() => createTariff({ provider: 'x', tariffCode: 'BAD-ORIGIN', country: 'FR', currency: 'EUR', structure: 'flat', kind: 'flat', origin: 'real' }), /origin must be one of/);
});

test('a slot priced with a placeholder tax rule has lineage origin placeholder and names the rule', () => {
  const L = lineages(frHome.id);
  assert.equal(L.length, 96);
  for (const l of L) {
    assert.equal(l.origin, 'placeholder');
    assert.equal(l.data_origin, 'provider');
    assert.ok(l.placeholder_inputs.includes('tax_rule FR/accise [placeholder]'), JSON.stringify(l.placeholder_inputs));
    assert.ok(l.placeholder_inputs.includes('tax_rule FR/tva [placeholder]'));
    assert.ok(!l.placeholder_inputs.some((x) => /USER-FR-BASE/.test(x)), 'the user-typed tariff is not a placeholder');
  }
  // Numbers are untouched by the labels: (20.16 + 3.37) x 1.2 per kWh.
  const r = db.prepare('SELECT import_rate_ex, import_vat FROM site_hh WHERE site_id = ? LIMIT 1').get(frHome.id);
  assert.ok(Math.abs(r.import_rate_ex * (1 + r.import_vat) - (20.16 + 3.37) * 1.2) < 1e-9);
});

test('a GB live-style slot stays provider (Octopus prices) with sourced VAT, and names nothing', () => {
  const t = db.prepare("SELECT * FROM tariff WHERE tariff_code = 'E-1R-VAR-22-11-01-C'").get();
  assert.deepEqual([t.origin, t.currency, t.country, t.kind], ['provider', 'GBP', 'GB', 'flat']);
  assert.match(t.origin_note, /Octopus public API/);
  const L = lineages(gbHome.id);
  assert.equal(L.length, 96);
  assert.ok(L.every((l) => l.origin === 'provider' && l.data_origin === 'provider' && l.placeholder_inputs.length === 0 && l.tax === 'tax_rule'));
  const p = periodProvenance(db, gbHome, '2026-02-01', '2026-02-02');
  assert.equal(p.worst, 'provider');
  assert.deepEqual(p.placeholders, []);
  assert.equal(p.verified, true);
});

test('slots built before origins were recorded are labelled from the inputs in force', () => {
  db.exec(`UPDATE site_hh SET lineage = json_remove(lineage, '$.origin', '$.placeholder_inputs') WHERE site_id = ${frHome.id}`);
  const tz = 'Europe/Paris';
  const p = periodProvenance(db, frHome, '2026-01-10', '2026-01-11', [dayBounds(tz, '2026-01-10')[0], dayBounds(tz, '2026-01-11')[1]]);
  assert.equal(p.unlabelled_slots, 96);
  assert.equal(p.worst, 'placeholder');
  assert.ok(p.placeholders.includes('tax_rule FR/accise [placeholder]'));
  buildSite(frHome.id, '2026-01-10', '2026-01-11');
});

// ───────────── API: additive ─────────────
const server = app.listen(0);
after(() => server.close());
const get = async (p) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`); assert.equal(res.status, 200, p); return res.json(); };

test('API: /api/sites gives every home an origin, keeping every existing key', async () => {
  const sites = await get('/api/sites');
  const by = Object.fromEntries(sites.map((s) => [s.name, s]));
  for (const s of sites) {
    for (const k of ['id', 'name', 'is_demo', 'currency', 'slot_s', 'market_code', 'connections', 'days', 'regions', 'syncing']) assert.ok(k in s, `${s.name}.${k}`);
    assert.ok(ORIGINS.includes(s.origin), s.name);
    assert.ok(s.origin_note);
  }
  assert.equal(by['Synthetic GB home'].origin, 'synthetic');
  assert.equal(by['Synthetic NL home'].is_demo, 1);
  assert.equal(by['Real-style FR home'].origin, 'user');
  assert.equal(by['Synthetic FR home'].market_origin, 'placeholder');
  assert.deepEqual(by['Live-style GB home'].regions.map((r) => [r.scheme, r.code, r.origin]), [['gb_dno', '12', 'sourced']]);
});

test('API: tariffs carry the tariff\'s, the rates\' and each tax\'s origin', async () => {
  const fr = await get(`/api/sites/${frHome.id}/tariffs`);
  assert.equal(fr.length, 1);
  const t = fr[0];
  for (const k of ['kind', 'tariff_code', 'structure', 'currency', 'current', 'unitNow', 'standingPerDay', 'vat']) assert.ok(k in t, k);
  assert.equal(t.current, true);
  assert.deepEqual([t.origin, t.origin_note, t.rate_origin, t.tax_origin], ['user', 'typed in from the contract', 'user', 'placeholder']);
  assert.deepEqual(t.taxes.map((x) => [x.code, x.origin, x.unverified]), [['accise', 'placeholder', true], ['tva', 'placeholder', true]]);
  assert.equal(t.provenance.worst, 'placeholder');
  assert.ok(Math.abs(t.unitNow - (20.16 + 3.37) * 1.2) < 1e-9);
  const gb = (await get(`/api/sites/${gbHome.id}/tariffs`))[0];
  assert.deepEqual([gb.origin, gb.rate_origin, gb.tax_origin, gb.provenance.worst], ['provider', 'provider', 'sourced', 'provider']);
  assert.deepEqual(gb.taxes.map((x) => [x.code, x.origin]), [['vat', 'sourced']]);
});

test('API: day and summary responses carry a provenance block', async () => {
  const sum = await get(`/api/sites/${homes.fr.site.id}/summary?from=${m.FR.from}&to=${m.FR.to}`);
  for (const k of ['current', 'previous', 'basis', 'currency', 'slot_s']) assert.ok(k in sum, k);
  assert.equal(sum.provenance.worst, 'synthetic');
  assert.equal(sum.provenance.demo, true);
  assert.ok(sum.provenance.placeholders.includes('tax_rule FR/accise [placeholder]'));
  assert.ok(sum.provenance.placeholders.includes('tariff SYN-FR-HPHC [synthetic]'));
  const tl = await get(`/api/sites/${frHome.id}/timeline?from=2026-01-10&to=2026-01-10`);
  assert.ok(tl.rows.length === 48 && 'currency' in tl);
  assert.deepEqual([tl.provenance.worst, tl.provenance.demo, tl.provenance.verified], ['placeholder', false, false]);
  const gb = await get(`/api/sites/${gbHome.id}/breakdown?from=2026-02-01&to=2026-02-02`);
  assert.ok('totals' in gb && 'ledger' in gb);
  assert.deepEqual([gb.provenance.worst, gb.provenance.placeholders], ['provider', []]);
  const ev = await get(`/api/sites/${homes.nl.site.id}/evidence?slot=${dayBounds(m.NL.tz, m.NL.from)[0]}`);
  assert.equal(ev.row.lineage.origin, 'synthetic');
  assert.ok(ev.rates.every((r) => r.origin === 'synthetic'));
  assert.ok(ev.taxRules.every((r) => r.origin === 'placeholder'));
});

test('a demo home is never synced: the API says there is nothing to fetch', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sites/${homes.gb.site.id}/sync`, { method: 'POST' });
  assert.deepEqual(await res.json(), { started: false, reason: 'demo home: its data is synthetic, there is nothing to sync' });
  assert.ok(localDate('Europe/London', nowSec()) > addDays(m.GB.to, 1));
});
