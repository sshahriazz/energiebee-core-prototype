// tounify v2 adapter (src/adapters/tounify.js), an EU tariff source (FR and NL, not UK): the mapping of real answers
// captured from the v2 API (test/fixtures/tounify/v2/: suppliers, a supplier's tariffs, the operator of a postal code
// and /dayahead prices for EDF Tarif Bleu HP/HC in Paris, OctoEco Fixe Base in Niort and ANWB's dynamic tariff in
// Rotterdam, Nov 2026; public tariff data with no credential in them) and of the v3 preview's answers a home landed
// before (test/fixtures/tounify/*.json, still read by the Explorer); the client and its allowance guard against a fake
// fetch and a fake clock (no network, no real waiting, no real token: the token below is a stand-in built from the
// published prefix), the idempotent and bitemporal writes, a French home's own off-peak hours, taxes_in_price in
// pricing, the registry gate with and without TOUNIFY_DEV, the sync step and the tariff picker. Temp database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { useDb } from './helpers.js';

useDb();
const stray = [];
// Any request not sent to the fake tounify is refused and recorded; Open-Meteo and RTE answer empty (the
// sync of a French home runs its weather and carbon steps too).
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.host === 'api.open-meteo.com') return new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  // RTE éCO2mix (a French home's carbon step): nothing published.
  if (u.host === 'odre.opendatasoft.com' && u.pathname.includes('/exports/json')) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  stray.push(String(url));
  throw new Error(`no network in tests: ${url}`);
};
for (const k of ['TOUNIFY_API_KEY', 'TOUNIFY_DEV', 'TOUNIFY_MAX_REQUESTS_DAY', 'TOUNIFY_MAX_COMPANIES', 'TOUNIFY_MAX_TARIFFS', 'TOUNIFY_MAX_NEW_PER_ENDPOINT_DAY',
  'OCTOPUS_API_KEY', 'OCTOPUS_ACCOUNT_NUMBER', 'SUNSYNK_USERNAME', 'SUNSYNK_PASSWORD', 'TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD', 'IMPORT_TARIFF_CODE']) delete process.env[k];

const { db, applyDelta } = await import('../src/db/db.js');
const TU = await import('../src/adapters/tounify.js');
const { dayBounds, localDate } = await import('../src/core/time.js');
const P = await import('../src/core/providers.js');
const C = await import('../src/core/connectors.js');
const { syncSite, syncAll } = await import('../src/jobs/sync.js');   // registers the steps
const { createSite, setContractedCapacity } = await import('../src/core/sites.js');
const { createTariff, putRateRows, putWindows, addDevice, agreeTariff } = await import('../src/core/tariffs.js');
const { loadPricing, priceAt, fixedPerDay } = await import('../src/core/pricing.js');
const { PLACEHOLDER_TAX_RULES } = await import('../src/core/tax.js');
const { seedProviders, TOUNIFY: TOUNIFY_NOTE } = await import('../src/db/seed/providers.js');
const { app } = await import('../src/server.js');

// Stand-in tokens: the published prefixes plus words; never a real credential, never printed.
const TEST_TOKEN = `${TU.TEST_PREFIX}stand-in-for-tests-0001`;
const PROD_TOKEN = `${TU.PROD_PREFIX}stand-in-for-tests-0002`;

const FIX = path.join(import.meta.dirname, 'fixtures', 'tounify');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

// One clock for the whole file, only ever moved forward (persisted cooldowns stay coherent).
const clock = { t: Date.UTC(2026, 10, 11, 5, 0), sleeps: [], now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; } };
TU.tounifyPolicy.clock = clock;

// A fake tounify v2 serving the captured answers, with ETags on the listings, per-call overrides and a log of calls.
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const V2 = (f) => load(`v2/${f}.json`);
const DAYAHEAD = { EDFTRVHPHC: 'fr-dayahead-edfhphc', OEFODEFB: 'fr-dayahead-oefodefb', ANWBDE: 'nl-dayahead-anwbde' };
const TARIFFS = { 'FR/EDF': 'fr-edf-tariffs', 'FR/OEF': 'fr-oef-tariffs', 'NL/ANWB': 'nl-anwb-tariffs' };
function fakeApi() {
  const api = { calls: [], etags: true, override: null, mutate: {} };
  const tag = (b) => `"${Buffer.from(JSON.stringify(b)).toString('base64').slice(-24)}"`;
  const reply = (call, body) => {
    const etag = tag(body);
    if (api.etags && call.headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return json(200, body, { ...(api.etags ? { etag } : {}), 'x-request-id': `req-${api.calls.length}` });
  };
  api.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { at: clock.now(), method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    api.calls.push(call);
    if (u.host !== 'api.tounify.io') return json(404, {});
    if (api.override) { const r = api.override(call); if (r) return r; }
    let m;
    if ((m = /^\/v2\/(FR|NL)\/consumption\/companies$/.exec(u.pathname))) return reply(call, V2(`${m[1].toLowerCase()}-companies`));
    if ((m = /^\/v2\/(FR|NL)\/grid\/companies$/.exec(u.pathname))) return reply(call, m[1] === 'FR' ? V2('fr-grid-79200') : [{ id: 'STED', name: 'Stedin', country: 'NL', url: null }]);
    if ((m = /^\/v2\/(FR|NL)\/consumption\/([^/]+)\/tariffs$/.exec(u.pathname))) {
      const f = TARIFFS[`${m[1]}/${decodeURIComponent(m[2])}`];
      return f ? reply(call, V2(f)) : json(400, { statusCode: 400, code: 'unknown_company', message: `unknown company ${m[2]}` });
    }
    if ((m = /^\/v2\/(FR|NL)\/dayahead$/.exec(u.pathname))) {
      const f = DAYAHEAD[call.query.consumption_tariff];
      if (!f) return json(400, { statusCode: 400, code: 'unknown_tariff', message: `unknown tariff ${call.query.consumption_tariff}` });
      const b = V2(f);
      return json(200, api.mutate.prices ? api.mutate.prices(b) : b, { 'x-request-id': `req-${api.calls.length}`, etag: '"not-a-validator"' });
    }
    return json(404, {});
  };
  api.of = (re) => api.calls.filter((c) => re.test(c.path));
  return api;
}
const api = fakeApi();
TU.tounifyPolicy.fetch = api.fetch;

// A clean slate for the provider: no counters, no cooldown, no per-connection state, new clients.
function fresh() {
  db.prepare("DELETE FROM provider_state WHERE provider = 'tounify'").run();
  TU.resetClients();
  api.calls.length = 0;
  api.etags = true;
  api.override = null;
  api.mutate = {};
}
const client = (env = {}, token = TEST_TOKEN) => TU.createClient({ token, env });
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
};
const DEV = { TOUNIFY_API_KEY: TEST_TOKEN, TOUNIFY_DEV: '1' };

// A Paris home on EDF Tarif Bleu HP/HC, 6 kVA, with its meter's own off-peak hours (8 h a day).
const fr = createSite({ name: 'Paris HP/HC', country: 'FR', postcode: '75001' });
setContractedCapacity(fr.id, 6, { origin: 'user', note: 'from the bill' });
const hphc = createTariff({ provider: 'manual', tariffCode: 'TEST-FR-HPHC-WINDOWS', structure: 'windows', kind: 'tou', country: 'FR', currency: 'EUR', origin: 'user' });
const frMeter = addDevice({ siteId: fr.id, kind: 'meter_import', provider: 'manual', externalRef: 'PDL-TEST-1' });
putWindows(hphc.id, [{ device_id: frMeter.id, register: 'hc', start_min: 90, end_min: 450 }, { device_id: frMeter.id, register: 'hc', start_min: 750, end_min: 870 }], { origin: 'user' });
const frSite = () => db.prepare('SELECT * FROM site WHERE id = ?').get(fr.id);
// An Amsterdam home on Frank Energie's dynamic tariff (quarter-hour slots).
const nl = createSite({ name: 'Amsterdam dynamic', country: 'NL', postcode: '1011' });
const nlSite = () => db.prepare('SELECT * FROM site WHERE id = ?').get(nl.id);

const server = app.listen(0);
after(() => server.close());
function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${server.address().port}${p}`, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// ───────────── Fixtures and mapping ─────────────

// The captured v2 window: 10 to 12 Nov 2026 (FR; NL 10 and 11), Paris and Amsterdam both UTC+1; at9(min) is a minute
// of the window's first local day, 10 Nov.
const D9 = Date.UTC(2026, 10, 9, 23) / 1000;
const at9 = (min) => D9 + min * 60;

test('fixtures: real v2 answers (and the v3 preview\'s, landed before), with no token or Authorization text in them', () => {
  const v3 = fs.readdirSync(FIX).filter((f) => f.endsWith('.json'));
  const v2 = fs.readdirSync(path.join(FIX, 'v2')).filter((f) => f.endsWith('.json'));
  assert.deepEqual([v3.length, v2.length], [14, 9]);
  for (const f of [...v3, ...v2.map((x) => `v2/${x}`)]) {
    const text = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.ok(!text.includes(TU.TEST_PREFIX.slice(0, -1)) && !text.includes(TU.PROD_PREFIX.slice(0, -1)), `${f}: no token`);
    assert.ok(!text.includes('Bearer'), `${f}: no Authorization header`);
    JSON.parse(text);
  }
});

test('v2 prices FR, OctoEco Fixe Base at 79200: one price all day, (energy + grid + fees) x 100 = 18.708333c ex VAT, VAT 20 % read per point', () => {
  const body = V2('fr-dayahead-oefodefb');
  const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR', company: 'OEF' });
  assert.equal(m.ok, true, m.problems?.join('; '));
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.currency, m.tariff.nativePeriodS, m.tariff.taxesInPrice, m.company, m.zone],
    ['TOUNIFY-FR-OEFODEFB', 'flat', 'EUR', 1800, 1, 'OEF', 'Europe/Paris']);
  assert.equal(m.rows.length, 144, 'three days of half-hours');
  assert.deepEqual([...new Set(m.rows.map((r) => r.price))], [18.708333], '0.11556333 + 0.0409 + 0.03062 EUR');
  body.consumption.forEach((p, i) => assert.ok(Math.abs(m.rows[i].price - (p.energy + p.grid + p.fees + p.vat) * 100) > 1, 'vat is not in the price'));
  assert.deepEqual(m.vat, [{ fromUtc: D9, rate: 0.2, source: 'per point (vat / ex-VAT sum)' }]);
  assert.deepEqual(m.grid, { id: 'ENEDCU4', source: 'the postal code' });
  assert.match(m.tariff.originNote, /^tounify v2 \(test token\): storage licence unconfirmed; tariff OEFODEFB of OEF, static, one price in the series; prices \(energy \+ grid \+ fees\) at the home's postal code, VAT stated apart$/);
});

test('v2 prices FR, EDF HP/HC: two prices on the reference window 23:00-07:00; a home\'s own off-peak hours move them, each day', () => {
  const body = V2('fr-dayahead-edfhphc');
  const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR' });
  assert.deepEqual([m.tariff.kind, m.rows.length, m.offPeak], ['tou', 144, null]);
  const price = (rows, min) => rows.find((r) => r.validFrom === at9(min)).price;
  // As served: off-peak 0.0609 + 0.0409 + 0.03062, peak 0.0707 + 0.0772 + 0.03062 EUR (the grid part differs too).
  assert.deepEqual([0, 6 * 60 + 30, 7 * 60, 22 * 60 + 30, 23 * 60].map((x) => price(m.rows, x)), [13.242, 13.242, 17.852, 17.852, 13.242]);
  // The meter's own hours, 01:30-07:30 and 12:30-14:30 (8 h): those half-hours take the off-peak price, every other one the peak.
  const own = TU.mapPrices(body, { country: 'FR', currency: 'EUR', offPeak: { windows: [{ from: '01:30', to: '07:30' }, { from: '12:30', to: '14:30' }] } });
  assert.equal(own.offPeak, '01:30-07:30, 12:30-14:30');
  assert.deepEqual([0, 60, 90, 7 * 60, 7 * 60 + 30, 12 * 60 + 30, 14 * 60, 14 * 60 + 30, 23 * 60].map((x) => price(own.rows, x)),
    [17.852, 17.852, 13.242, 13.242, 17.852, 13.242, 13.242, 17.852, 17.852]);
  assert.equal(own.rows.filter((r) => r.price === 13.242).length, 3 * 16, '8 h a day off-peak, three days');
  // The reference window itself changes nothing; a window across midnight works.
  assert.equal(TU.mapPrices(body, { country: 'FR', currency: 'EUR', offPeak: { windows: [{ from: '23:00', to: '07:00' }] } }).offPeak, null);
  const late = TU.mapPrices(body, { country: 'FR', currency: 'EUR', offPeak: { windows: [{ from: '22:00', to: '06:00' }] } });
  assert.deepEqual([21 * 60 + 30, 22 * 60, 5 * 60 + 30, 6 * 60].map((x) => price(late.rows, x)), [17.852, 13.242, 13.242, 17.852]);
  // A day that is not one price inside the window and one outside: left as served, with the reason.
  const odd = { ...body, consumption: body.consumption.map((p, i) => (i === 3 ? { ...p, energy: 0.5 } : p)) };
  const o = TU.mapPrices(odd, { country: 'FR', currency: 'EUR', offPeak: { windows: [{ from: '22:00', to: '06:00' }] } });
  assert.equal(o.offPeak, null);
  assert.match(o.warnings.join('\n'), /off-peak hours not applied: 2026-11-10 holds 2 price\(s\) inside the reference window/);
  // Never on a one-price tariff, nor outside France.
  assert.equal(TU.mapPrices(V2('fr-dayahead-oefodefb'), { country: 'FR', currency: 'EUR', offPeak: { windows: [{ from: '22:00', to: '06:00' }] } }).offPeak, null);
});

test('v2 prices NL, ANWB dynamic at 3071: 192 quarter-hours, grid 0 (the Dutch network charge is yearly), energy tax in fees, VAT 21 %', () => {
  const body = V2('nl-dayahead-anwbde');
  const m = TU.mapPrices(body, { country: 'NL', currency: 'EUR', company: 'ANWB' });
  assert.equal(m.ok, true, m.problems?.join('; '));
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.nativePeriodS, m.rows.length, m.zone], ['TOUNIFY-NL-ANWBDE', 'dynamic', 900, 192, 'Europe/Amsterdam']);
  assert.ok(body.consumption.every((p) => p.grid === 0 && p.fees === 0.09161));
  near(m.rows[0].price, (0.2500085330578512 + 0.09161) * 100, 'first quarter-hour');
  assert.deepEqual(m.vat.map((v) => v.rate), [0.21]);
  assert.equal(m.grid.id, 'STEDC2');
});

test('v3 answers landed before still map (the Explorer replays them): FR HP/HC two levels, VAT from applied.vat', () => {
  const body = load('prices-FR.json');
  const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR' });
  assert.equal(m.ok, true, m.problems?.join('; '));
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.structure, m.tariff.currency, m.tariff.nativePeriodS, m.tariff.taxesInPrice], ['TOUNIFY-FR-EDFTRVHPHC', 'tou', 'tou', 'EUR', 1800, 1]);
  assert.equal(m.rows.length, 96, 'one row per half-hour point');
  assert.deepEqual([...new Set(m.rows.map((r) => r.price))].sort((a, b) => b - a), [17.852, 13.242]);
  body.consumption.forEach((p, i) => near(m.rows[i].price, (p.energy + p.grid + p.fees) * 100, `point ${i}`));
  assert.deepEqual(m.vat, [{ fromUtc: 1792969200, rate: 0.2, source: 'country' }]);
  assert.match(m.tariff.originNote, /^tounify v2 \(test token\): storage licence unconfirmed; .*per connection \(v3\)/);
  const cat = Object.fromEntries(load('tar-FR.json').map((t) => [t.id, t]));
  const mc = TU.mapPrices(body, { country: 'FR', currency: 'EUR', catalogue: cat });
  assert.equal(mc.tariff.name, 'Tarif Bleu — Option Heures Pleines / Heures Creuses');
  assert.match(mc.tariff.originNote, /time_of_use_rates 2 \(catalogue\)/);
});

test('v3 prices NL: 96 quarter-hours holding 24 hourly prices become 24 hourly rows (its settlement interval)', () => {
  const body = load('prices-NL.json');
  const m = TU.mapPrices(body, { country: 'NL', currency: 'EUR' });
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.nativePeriodS, m.resolutionS, m.settlementS, m.taxesInPrice], ['TOUNIFY-NL-FRENS', 'dynamic', 3600, 900, 3600, 1]);
  assert.equal(m.rows.length, 24);
  assert.equal(m.rows[0].price, 14.82575, '0.0566475 + 0 + 0.09161 EUR');
});

test('v3 components FR and NL (landed before; v2 serves none): resolved amounts x 100 per period, signs kept', () => {
  const fr = TU.mapComponents(load('comps-FR.json'), { currency: 'EUR', zone: 'Europe/Paris', captureDayStart: 1792969200 });
  assert.deepEqual(fr.rows.map((r) => [r.register, r.chargePeriod, r.price]), [
    ['consumption:standing', 'year', 5670.0985], ['grid:capacity', 'year', 6252], ['grid:standing', 'year', 1712], ['grid:metering', 'year', 2267],
  ]);
  const nl = TU.mapComponents(load('comps-NL.json'), { currency: 'EUR', zone: 'Europe/Amsterdam', captureDayStart: 1792969200 });
  assert.deepEqual(nl.rows.map((r) => [r.register, r.price]), [['consumption:standing', 578.5124], ['consumption:credit', -51980], ['grid:standing', 39508]]);
  assert.equal(TU.mapComponents({ consumption: [] }, { currency: 'EUR' }).ok, false, 'components without grid / feedin arrays');
});

test('feed-in (SYNTHETIC points: no feed-in answer was captured): paid energy less the producer\'s fees, an export tariff, as the spec states it', () => {
  const body = { ...V2('nl-dayahead-anwbde'), feedin_tariff: { id: 'TEST-FEEDIN', type: 'dynamic', available: true },
    feedin: [{ from_utc: D9, energy: 0.05, fees: 0.01 }, { from_utc: D9 + 900, energy: -0.02 }] };
  const m = TU.mapPrices(body, { country: 'NL', currency: 'EUR' });
  assert.deepEqual([m.feedin.tariff.tariffCode, m.feedin.tariff.direction, m.feedin.tariff.kind], ['TOUNIFY-NL-TEST-FEEDIN', 'export', 'dynamic']);
  assert.deepEqual(m.feedin.rows.map((r) => [r.validFrom, r.validTo - r.validFrom, r.price]), [[D9, 900, 4], [D9 + 900, 900, -2]], 'negative export prices are kept');
});

test('mapping: unknown fields are ignored; a missing expected field (or a v3 grid gap) is a problem, never a guess', () => {
  const b = V2('fr-dayahead-edfhphc');
  assert.equal(TU.mapPrices({ ...b, brand_new_field: { x: 1 }, consumption: b.consumption.map((p) => ({ ...p, extra: 'x' })) }, { country: 'FR', currency: 'EUR' }).ok, true);
  const v3 = load('prices-FR.json');
  for (const [what, body, re] of [
    ['no next', { ...b, next: undefined }, /no next/],
    ['no resolution', { ...b, resolution: undefined }, /resolution/],
    ['no currency', { ...b, currency: undefined }, /no currency/],
    ['another currency', { ...b, currency: 'GBP' }, /home is billed in EUR/],
    ['no tariff id', { ...b, consumption_tariff: undefined }, /no consumption tariff id/],
    ['a country with no zone known', { ...b, country: 'XX' }, /country XX, expected FR|no time zone known/],
    ['a point without energy', { ...b, consumption: [{ from_utc: D9, grid: 0.01 }] }, /no energy/],
    ['a point whose vat is not a number', { ...b, consumption: [{ from_utc: D9, energy: 0.1, vat: 'x' }] }, /vat is not a number/],
    ['v3 grid gap', { ...v3, applied: { ...v3.applied, grid_gap: 'no_tariff' } }, /grid_gap/],
    ['not an object', [1, 2], /not an object/],
  ]) {
    const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR' });
    assert.equal(m.ok, false, what);
    assert.match(m.problems.join('; '), re, what);
  }
  // Without a postal code the answer has no grid: priced, with the warning (the home's prices would be short).
  const noGrid = TU.mapPrices({ ...b, consumption: b.consumption.map(({ grid, ...p }) => p) }, { country: 'FR', currency: 'EUR' });
  assert.match(noGrid.warnings.join('\n'), /points without grid/);
});

// ───────────── Token, allowance guard, client ─────────────

test('test-token detection and the allowance defaults: 40 requests a day, 8 companies, 8 tariffs, 5 new per endpoint; env overrides, never above the published test limits', () => {
  assert.deepEqual([TU.tokenKind(TEST_TOKEN), TU.tokenKind(PROD_TOKEN), TU.tokenKind('legacy-bare-id'), TU.tokenKind('')], ['test', 'prod', 'unknown', null]);
  assert.deepEqual(TU.limitsFor('test', {}), { requestsPerDay: 40, companies: 8, tariffs: 8, newPerEndpointDay: 5 });
  assert.deepEqual(TU.limitsFor('unknown', {}), TU.limitsFor('test', {}), 'a token without a known prefix is guarded as a test token');
  assert.deepEqual(TU.limitsFor('prod', {}), { requestsPerDay: null, companies: null, tariffs: null, newPerEndpointDay: null });
  assert.deepEqual(TU.limitsFor('test', { TOUNIFY_MAX_REQUESTS_DAY: '12', TOUNIFY_MAX_COMPANIES: '3', TOUNIFY_MAX_TARIFFS: '500' }), { requestsPerDay: 12, companies: 3, tariffs: 20, newPerEndpointDay: 5 });
  assert.equal(TU.limitsFor('prod', { TOUNIFY_MAX_REQUESTS_DAY: '7' }).requestsPerDay, 7);
  assert.deepEqual(TU.credentialsFromEnv({}), { missing: 'no credentials: TOUNIFY_API_KEY not set' });
  assert.equal(TU.devOverrideLabel({ TOUNIFY_DEV: '1', TOUNIFY_API_KEY: TEST_TOKEN }), TU.DEV_LABEL);
  assert.equal(TU.devOverrideLabel({ TOUNIFY_DEV: '1', TOUNIFY_API_KEY: PROD_TOKEN }), null, 'never with a production token');
  assert.equal(TU.devOverrideLabel({ TOUNIFY_DEV: '1', TOUNIFY_API_KEY: 'legacy-bare-id' }), null, 'nor one without the test prefix');
  assert.equal(TU.devOverrideLabel({ TOUNIFY_API_KEY: TEST_TOKEN }), null);
});

test('client: Bearer token, at least 1 s between calls, the request cap refuses the call before it is sent, and the counters survive a restart', async () => {
  fresh();
  const c = client({ TOUNIFY_MAX_REQUESTS_DAY: '3' });
  for (let i = 0; i < 3; i++) await c.request('GET', '/v2/FR/consumption/companies', { scope: { endpoint: 'GET companies', thing: 'FR' } });
  assert.equal(api.calls.length, 3);
  assert.equal(api.calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.ok(api.calls.slice(1).every((x, i) => x.at - api.calls[i].at >= 1000), 'one request at a time, 1 s apart');
  await assert.rejects(c.request('GET', '/v2/FR/consumption/companies'), (e) => e.kind === 'allowance' && /3 of 3 requests used today/.test(e.message));
  assert.equal(api.calls.length, 3, 'no call when over budget');
  // A "restart": a new client reads the same persisted counters.
  TU.resetClients();
  const c2 = client({ TOUNIFY_MAX_REQUESTS_DAY: '3' });
  await assert.rejects(c2.request('GET', '/v2/NL/consumption/companies'), /3 of 3 requests used today/);
  assert.equal(api.calls.length, 3);
  const a = TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN, TOUNIFY_MAX_REQUESTS_DAY: '3' } });
  assert.deepEqual([a.token_kind, a.requests_today, a.max_requests_day, a.guarded], ['test', 3, 3, true]);
  assert.ok(!JSON.stringify(a).includes(TEST_TOKEN), 'the allowance never shows the token');
  // The day count resets at midnight UTC; the totals of companies and tariffs never do.
  clock.t = Date.UTC(2026, 10, 12, 0, 5);
  await c2.request('GET', '/v2/FR/consumption/companies');
  assert.equal(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).requests_today, 1);
  // A production token is not capped unless asked.
  await client({}, PROD_TOKEN).request('GET', '/v2/NL/consumption/companies');
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM provider_state WHERE provider = 'tounify'").get()).includes(TU.TEST_PREFIX), 'no token in provider_state');
});

test('allowance: pricing a new tariff past the distinct-tariff cap is refused before the call; a tariff already priced stays usable', async () => {
  fresh();
  const c = client({ TOUNIFY_MAX_TARIFFS: '1' });
  const s1 = createSite({ name: 'cap 1', country: 'FR', postcode: '75002' });
  const s2 = createSite({ name: 'cap 2', country: 'FR', postcode: '79200' });
  await TU.registerConnection(s1, { consumption_tariff: 'EDFTRVHPHC' }, { client: c });
  await TU.registerConnection(s2, { consumption_tariff: 'OEFODEFB' }, { client: c });
  assert.equal(api.of(/\/dayahead$/).length, 0, 'recording a tariff calls no price');
  assert.equal((await TU.syncTounifyHome({ site: s1, client: c })).tariff, 'TOUNIFY-FR-EDFTRVHPHC');
  assert.match((await TU.syncTounifyHome({ site: s2, client: c })).skipped, /1 of 1 distinct tariffs already named.*OEFODEFB/);
  assert.equal(api.of(/\/dayahead$/).length, 1, 'the refused read was never sent');
  assert.deepEqual(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN, TOUNIFY_MAX_TARIFFS: '1' } }).tariffs, { used: 1, max: 1, ids: ['EDFTRVHPHC'] });
  // A second home on the tariff already priced: allowed.
  const s3 = createSite({ name: 'cap 3', country: 'FR', postcode: '75003' });
  await TU.registerConnection(s3, { consumption_tariff: 'EDFTRVHPHC' }, { client: c });
  assert.equal((await TU.syncTounifyHome({ site: s3, client: c })).tariff, 'TOUNIFY-FR-EDFTRVHPHC');
  for (const s of [s1, s2, s3]) await TU.removeConnection(s, { client: c });
  assert.equal(count("SELECT COUNT(*) n FROM connection WHERE provider = 'tounify' AND site_id IN (?, ?, ?)", s1.id, s2.id, s3.id), 0, 'rows dropped');
  assert.ok(api.calls.every((x) => x.method === 'GET'), 'v2: nothing is ever posted, patched or deleted upstream');
});

test('a 429 stops the run and honours Retry-After (persisted); a 403 testingLimit marks the allowance used up', async () => {
  fresh();
  const c = client();
  api.override = (x) => (x.path.endsWith('/companies') ? json(429, { statusCode: 429, error: 'Too Many Requests', message: 'Daily testing limit', code: 'daily_scope_limit', rateLimit: { limit: 5, remaining: 0, resetAt: new Date(clock.now() + 3600e3).toISOString() } }, { 'retry-after': '120' }) : null);
  await assert.rejects(c.request('GET', '/v2/FR/consumption/companies'), (e) => e.kind === 'rate_limited' && /HTTP 429 \(daily_scope_limit\): run stopped/.test(e.message));
  const st = db.prepare("SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = 'tounify'").get();
  assert.equal(st.next_allowed_at, clock.now() + 3600e3, 'until rateLimit.resetAt, the later of it and Retry-After');
  assert.match(st.cooldown_reason, /^HTTP 429 daily_scope_limit/);
  api.override = null;
  const before = api.calls.length;
  TU.resetClients();
  await assert.rejects(client().request('GET', '/v2/NL/consumption/companies'), (e) => e.kind === 'cooldown');
  assert.equal(api.calls.length, before, 'nothing is sent while cooling down, even by a new client');
  assert.match(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).cooldown.reason, /HTTP 429/);
  // A 429 with neither Retry-After nor rateLimit is a daily limit: until midnight UTC.
  fresh();
  api.override = () => json(429, { statusCode: 429, error: 'Too Many Requests', message: 'daily', code: 'daily_request_limit' });
  await assert.rejects(client().request('GET', '/v2/FR/consumption/companies'), /daily_request_limit/);
  assert.equal(db.prepare("SELECT next_allowed_at FROM provider_state WHERE provider = 'tounify'").get().next_allowed_at, Date.UTC(2026, 10, 13));
  // 403 testingLimit on a price read: the tariffs allowance is used up; a new tariff is then refused here, without a call.
  fresh();
  api.override = (x) => (x.path.endsWith('/dayahead') ? json(403, { statusCode: 403, message: 'max 20 tariffs', code: 'testing_allowance_exhausted', testingLimit: { kind: 'tariffs', limit: 20, used: 20, remaining: 0, blocked: ['EDFZO'] } }) : null);
  await assert.rejects(TU.getPrices(client(), 'FR', TU.dayaheadQuery({ consumption: 'EDFZO', postalCode: '75004', resolution: 1800 })), (e) => e.kind === 'allowance_exhausted' && /blocked: EDFZO/.test(e.message));
  api.override = null;
  const n = api.calls.length;
  await assert.rejects(TU.getPrices(client(), 'FR', TU.dayaheadQuery({ consumption: 'EDFVLR', postalCode: '75004', resolution: 1800 })), (e) => e.kind === 'allowance' && /refused new tariffs/.test(e.message));
  assert.equal(api.calls.length, n);
  assert.deepEqual(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).exhausted.tariffs.blocked, ['EDFZO']);
});

// ───────────── A home's tariff (kept here: v2 has no connection) ─────────────

test('recording a home\'s tariff: no registration upstream; the postal code, tariff and off-peak hours kept; the grid operator looked up once', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 13, 5, 0);   // after the daily cooldown set above
  const { meta, warnings } = TU.connectionBody(frSite(), { consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate' } });
  assert.deepEqual(meta, {
    country: 'FR', postal_code: '75001', tariffs: { consumption: 'EDFTRVHPHC', feedin: null }, company: null,
    off_peak_hours: [{ from: '01:30', to: '07:30' }, { from: '12:30', to: '14:30' }], capacity: { contracted_kva: 6 }, api: 'v2',
  }, 'the meter\'s own off-peak windows, the contracted kVA kept for display');
  assert.deepEqual(warnings, ['metering: tounify v2 takes no connection details; kept here only where it prices (off-peak hours)']);
  assert.deepEqual(TU.connectionBody(frSite(), { consumption_tariff: 'EDFTRVHPHC', off_peak_hours: [{ from: '22:00', to: '06:00' }] }).meta.off_peak_hours, [{ from: '22:00', to: '06:00' }], 'hours given win');
  assert.throws(() => TU.connectionBody(nlSite(), {}), /consumption_tariff is required/);
  assert.throws(() => TU.connectionBody({ ...nlSite(), postcode: null }, { consumption_tariff: 'ANWBDE' }), /postal_code is required/);

  const r = await TU.registerConnection(frSite(), { consumption_tariff: 'EDFTRVHPHC' }, { client: client() });
  assert.deepEqual([r.created, r.reference, r.country, r.grid_resolution.operator.id, r.connection.status], [true, `eb-site-${fr.id}`, 'FR', 'GDS', 'recorded']);
  assert.deepEqual(api.calls.map((x) => [x.method, x.path, x.query.postal_code]), [['GET', '/v2/FR/grid/companies', '75001']], 'one listing call: the operator of the postal code');
  const row = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'tounify'").get(fr.id);
  assert.equal(row.external_ref, `eb-site-${fr.id}`);
  const m = JSON.parse(row.meta);
  assert.deepEqual([m.country, m.postal_code, m.grid_operator, m.tariffs.consumption, m.api], ['FR', '75001', { id: 'GDS', name: 'Gérédis Deux-Sèvres' }, 'EDFTRVHPHC', 'v2']);
  // Again, same postal code: nothing is called.
  const again = await TU.registerConnection(frSite(), { consumption_tariff: 'EDFTRVHPHC' }, { client: client() });
  assert.equal(again.created, false);
  assert.equal(api.calls.length, 1);
  // Without a client (no token at hand) the tariff is still recorded, without the operator.
  const nr = await TU.registerConnection(nlSite(), { consumption_tariff: 'ANWBDE' });
  assert.deepEqual([nr.created, nr.grid_resolution], [true, null]);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM connection').all()).includes(TU.TEST_PREFIX), 'no token in a connection row');
});

// ───────────── Daily read, idempotency, cadence ─────────────

let frTariff;
test('daily read FR: /dayahead at the postal code, on the meter\'s own off-peak hours; stored once, the home agreed, no fixed charge; again changes nothing', async () => {
  fresh();
  const c = client();
  const r = await TU.syncTounifyHome({ site: frSite(), client: c });
  assert.equal(r.failed, undefined, r.error);
  assert.deepEqual([r.tariff, r.kind, r.taxes_in_price, r.unit_rows, r.agreed, r.off_peak_hours, r.grid_tariff], ['TOUNIFY-FR-EDFTRVHPHC', 'tou', 1, 144, true, '01:30-07:30, 12:30-14:30', 'ENEDCU4']);
  assert.match(r.fixed, /^none: tounify v2 serves per-kWh prices only/);
  assert.deepEqual(api.calls.map((x) => x.path), ['/v2/FR/dayahead'], 'one call: no components in v2');
  assert.deepEqual(api.calls[0].query, { consumption_tariff: 'EDFTRVHPHC', postal_code: '75001', include: 'fees,vat', resolution: '1800', historic_days: '1' });
  assert.equal(api.calls[0].headers['if-none-match'], undefined, 'the /dayahead ETag is never sent back');
  frTariff = db.prepare("SELECT * FROM tariff WHERE tariff_code = 'TOUNIFY-FR-EDFTRVHPHC'").get();
  assert.deepEqual([frTariff.provider, frTariff.country, frTariff.currency, frTariff.native_period_s, frTariff.taxes_in_price, frTariff.origin], ['tounify', 'FR', 'EUR', 1800, 1, 'provider']);
  const rows = db.prepare("SELECT * FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND superseded_at IS NULL").all(frTariff.id, fr.id);
  assert.equal(rows.length, 144);
  assert.ok(rows.every((x) => x.origin === 'provider' && x.origin_note === `${TU.ORIGIN_NOTE_TEST}; off-peak prices on the home's own hours 01:30-07:30, 12:30-14:30` && x.raw_id != null));
  const price = (min) => rows.find((x) => x.valid_from === at9(min)).price_ex_vat;
  assert.deepEqual([price(0), price(90), price(7 * 60 + 30), price(13 * 60)], [17.852, 13.242, 17.852, 13.242]);
  assert.equal(count("SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'fixed'", frTariff.id, fr.id), 0, 'no fixed charge written');
  const ag = db.prepare("SELECT a.*, d.kind FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND d.provider = 'tounify' AND a.superseded_at IS NULL").all(fr.id);
  assert.deepEqual(ag.map((a) => [a.kind, a.tariff_id, a.valid_from, a.valid_to]), [['meter_import', frTariff.id, D9, null]]);
  // Landed raw (an identical answer landed earlier for another home is the same raw payload): every row points at it.
  const raw = db.prepare('SELECT status, request FROM raw_payload WHERE id = ?').get(rows[0].raw_id);
  assert.deepEqual([raw.status, JSON.parse(raw.request).path, JSON.parse(raw.request).query.consumption_tariff], ['accepted', '/v2/FR/dayahead', 'EDFTRVHPHC']);
  assert.equal(new Set(rows.map((x) => x.raw_id)).size, 1);
  assert.deepEqual(r.vat_check.map((v) => [v.tounify, v.ours, v.rules, v.match]), [[0.2, 0.2, ['FR/tva'], true]], 'the sourced FR VAT rule agrees');
  assert.ok(!(r.warnings ?? []).some((w) => /VAT/.test(w)));
  // Same answer again (forced, same day): nothing written.
  const again = await TU.syncTounifyHome({ site: frSite(), client: c, force: true });
  assert.deepEqual([again.unit_rows, again.agreements_changed, again.tariff_created], [0, false, 0]);
  assert.equal(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NOT NULL', frTariff.id), 0);
});

test('fixed charges a home already holds (from the v3 preview) are kept as they are: v2 neither ends nor rewrites them', async () => {
  const ins = db.prepare(`INSERT INTO rate_interval (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, origin, origin_note, estimated)
    VALUES (?, ?, 'fixed', 'consumption:standing', 'year', 'ANY', ?, NULL, 5670.0985, 0, 'provider', 'tounify v3 (test token): storage licence unconfirmed', 0)`);
  ins.run(frTariff.id, fr.id, D9 - 86400);
  const r = await TU.syncTounifyHome({ site: frSite(), client: client(), force: true });
  assert.equal(r.fixed, '1 fixed charge(s) held from before, kept (tounify v2 serves none)');
  const f = db.prepare("SELECT valid_to, superseded_at FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'fixed'").all(frTariff.id, fr.id);
  assert.deepEqual(f.map((x) => [x.valid_to, x.superseded_at]), [[null, null]]);
  db.prepare("DELETE FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'fixed'").run(frTariff.id, fr.id);
});

test('a changed price supersedes the stored row (kept), the parts around it keep their old price; nothing is deleted', async () => {
  const total = count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id);
  api.mutate.prices = (b) => ({ ...b, consumption: b.consumption.map((p, i) => (i === 5 ? { ...p, energy: 0.2 } : p)) });
  const r = await TU.syncTounifyHome({ site: frSite(), client: client(), force: true });
  // The changed point breaks 10 Nov's two-price day: the off-peak hours are not applied that run (said in a warning),
  // so that day is stored as served: every one of its 48 half-hours whose price differs from the home's hours changes.
  assert.match(r.warnings.join('\n'), /off-peak hours not applied: 2026-11-10/);
  assert.ok(r.unit_rows > 1);
  const t5 = D9 + 5 * 1800;
  const hist = db.prepare("SELECT price_ex_vat, superseded_at FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND valid_from = ? ORDER BY id").all(frTariff.id, fr.id, t5);
  assert.deepEqual(hist.map((h) => [h.price_ex_vat, h.superseded_at != null]), [[13.242, true], [27.152, false]], '0.2 + 0.0409 + 0.03062 EUR');
  assert.ok(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id) > total, 'rows added, none removed');
  // Back to the captured answer: the home's own hours apply again, history kept.
  api.mutate = {};
  await TU.syncTounifyHome({ site: frSite(), client: client(), force: true });
  assert.equal(db.prepare("SELECT price_ex_vat FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND valid_from = ? AND component = 'unit' AND superseded_at IS NULL").get(frTariff.id, fr.id, t5).price_ex_vat, 13.242);
  assert.equal(db.prepare("SELECT price_ex_vat FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND valid_from = ? AND component = 'unit' AND superseded_at IS NULL").get(frTariff.id, fr.id, D9).price_ex_vat, 17.852);
});

test('at most one price read per home a day, never before `next`', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 14, 5, 0);
  const c = client();
  const first = await TU.syncTounifyHome({ site: frSite(), client: c });
  assert.equal(first.failed, undefined);
  const n = api.calls.length;
  // Later the same UTC day: not due (and the step's applies() says so, so the sync does not even log it).
  clock.t += 6 * 3600e3;
  assert.match((await TU.syncTounifyHome({ site: frSite(), client: c })).skipped, /^not due: one price read a day per connection/);
  assert.equal(TU.priceReadDue(fr.id).due, false);
  assert.equal(api.calls.length, n, 'no call');
  // Next UTC day, past the answer's `next` (captured on 11 Nov): due again.
  clock.t = Date.UTC(2026, 10, 15, 1, 0);
  assert.equal(TU.priceReadDue(fr.id).due, true);
  assert.equal((await TU.syncTounifyHome({ site: frSite(), client: c })).unit_rows, 0, 'same prices: nothing written');
  // An answer whose `next` lies days ahead: no read before it, even on a new UTC day.
  fresh();
  api.mutate.prices = (b) => ({ ...b, next: Math.floor(Date.UTC(2026, 10, 18, 6) / 1000) });
  await TU.syncTounifyHome({ site: frSite(), client: client() });
  clock.t = Date.UTC(2026, 10, 16, 9, 0);
  assert.match((await TU.syncTounifyHome({ site: frSite(), client: client() })).skipped, /^not due: tounify advises the next read after 2026-11-18T06:00:00Z/);
  api.mutate = {};
  // A home with no tariff recorded, or one recorded without a tariff yet: nothing to read, said so.
  const bare = createSite({ name: 'no tariff', country: 'FR', postcode: '75010' });
  assert.match((await TU.syncTounifyHome({ site: bare, client: client() })).skipped, /no tounify tariff recorded/);
  await TU.registerConnection(bare, { no_tariff_yet: true });
  assert.match((await TU.syncTounifyHome({ site: bare, client: client() })).skipped, /no tounify tariff chosen yet/);
  assert.equal(TU.priceReadDue(bare.id).due, false);
});

test('daily read NL: 192 quarter-hours ex VAT at the home\'s slots, VAT agrees with ours, and a different rule is warned about without touching it', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 17, 5, 0);
  const r = await TU.syncTounifyHome({ site: nlSite(), client: client() });
  assert.deepEqual([r.tariff, r.kind, r.unit_rows, r.resolution], ['TOUNIFY-NL-ANWBDE', 'dynamic', 192, 900]);
  assert.equal(api.of(/\/dayahead$/).at(-1).query.resolution, '900', 'the home\'s quarter-hour slots');
  assert.equal(api.of(/\/dayahead$/).at(-1).query.postal_code, '1011');
  assert.deepEqual(r.vat_check.map((v) => [v.tounify, v.ours, v.match]), [[0.21, 0.21, true]], 'the sourced NL VAT rule agrees');
  assert.ok(!(r.warnings ?? []).some((w) => /VAT/.test(w)));
  // Our NL VAT rule says 9 %: tounify's 21 % is reported, our rule is kept as it is. (The sourced rule is set
  // aside for this, so the test rule does not overlap it, and put back after.)
  db.prepare("UPDATE tax_rule SET superseded_at = -1 WHERE country = 'NL' AND code = 'btw' AND superseded_at IS NULL").run();
  db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES ('NL', 'btw', 'electricity', 'import', 'domestic', 'all', 'percent', 0.09, NULL, NULL, 100, ?, NULL, 'test rule', 1, 0, 'placeholder', 'test rule')`).run(Date.UTC(2025, 11, 31, 23) / 1000);
  const again = await TU.syncTounifyHome({ site: nlSite(), client: client(), force: true });
  assert.match(again.warnings.join('\n'), /VAT mismatch: tounify states 21 % from 2026-11-09T23:00:00Z, our NL\/btw says 9 % \(a placeholder\): our rule is kept, check it/);
  assert.equal(db.prepare("SELECT value FROM tax_rule WHERE country = 'NL' AND code = 'btw' AND superseded_at IS NULL").get().value, 0.09, 'never silently overridden');
  db.prepare("DELETE FROM tax_rule WHERE country = 'NL' AND source = 'test rule'").run();
  db.prepare("UPDATE tax_rule SET superseded_at = NULL WHERE country = 'NL' AND code = 'btw' AND superseded_at = -1").run();
});

test('an answer of an unexpected shape is quarantined: the step fails soft, nothing is mapped from it, the sync goes on', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 18, 7, 0);
  const before = count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id);
  api.mutate.prices = (b) => { const x = { ...b }; delete x.resolution; delete x.next; return x; };
  const r = await TU.syncTounifyHome({ site: frSite(), client: client() });
  assert.equal(r.failed, true);
  assert.match(r.error, /unexpected shape: resolution missing is not 900, 1800 or 3600; no next/);
  const q = db.prepare('SELECT status, reason FROM raw_payload WHERE id = ?').get(r.quarantined);
  assert.deepEqual([q.status, /^unexpected shape: /.test(q.reason)], ['quarantined', true]);
  assert.equal(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id), before, 'nothing written');
  api.mutate = {};
});

// ───────────── Pricing: taxes_in_price ─────────────

test('taxes_in_price: a French home priced from tounify pays (energy + grid + fees) x 1.20; the placeholder accise is not added on top; default 0 is taxed as before', () => {
  const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`);
  for (const r of PLACEHOLDER_TAX_RULES.filter((x) => x.country === 'FR')) {
    ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.currency, r.charge_period, r.seq, r.valid_from, r.valid_to, r.source, r.origin, r.origin_note);
  }
  // 11 Nov, 10:00 Paris (peak on the meter's hours) and 02:00 (off-peak).
  const peak = at9(1440 + 600); const off = at9(1440 + 120);
  const p = loadPricing(fr.id, D9, D9 + 3 * 86400);
  const at = (ts) => priceAt(p, 'meter_import', ts);
  const pk = at(peak);
  assert.deepEqual([pk.tariffCode, pk.supplyEx, pk.unitEx, pk.levy, pk.vat], ['TOUNIFY-FR-EDFTRVHPHC', 17.852, 17.852, 0, 0.2]);
  near(pk.unitEx * (1 + pk.vat), (0.0707 + 0.0772 + 0.03062) * 1.2 * 100, 'peak paid per kWh');
  near(at(off).unitEx * (1 + at(off).vat), (0.0609 + 0.0409 + 0.03062) * 1.2 * 100, 'off-peak paid per kWh');
  assert.deepEqual(pk.tax.rules.map((r) => r.code), ['tva'], 'only the percent rule: the accise is inside fees already');
  assert.ok(!pk.inputs.some((i) => /accise/.test(i.what)));
  // v2 serves no fixed charge: none is priced from it (a subscription has to come from elsewhere).
  assert.deepEqual(pk.fixed ?? [], []);
  assert.equal(fixedPerDay(pk, peak, 'Europe/Paris'), 0);
  // The same price on an ordinary tariff (taxes_in_price 0): the accise is added, then VAT, as before.
  const home = createSite({ name: 'control FR', country: 'FR', postcode: '75005' });
  const t = createTariff({ provider: 'manual', tariffCode: 'TEST-CONTROL-FR', structure: 'flat', kind: 'flat', country: 'FR', currency: 'EUR', origin: 'user' });
  assert.equal(t.taxes_in_price, 0, 'default 0');
  putRateRows(t.id, [{ component: 'unit', validFrom: peak - 86400, price: 17.852 }]);
  const dev = addDevice({ siteId: home.id, kind: 'meter_import', provider: 'manual', externalRef: 'CTRL' });
  agreeTariff({ siteId: home.id, deviceId: dev.id, tariffId: t.id, validFrom: peak - 86400 });
  const q = priceAt(loadPricing(home.id, peak, peak + 3600), 'meter_import', peak);
  assert.deepEqual([q.supplyEx, q.vat], [17.852, 0.2]);
  near(q.levy, 3.37, 'the placeholder accise');
  near(q.unitEx * (1 + q.vat), (17.852 + 3.37) * 1.2, 'ordinary tariff: accise then VAT');
  assert.deepEqual(q.tax.rules.map((r) => r.code), ['accise', 'tva']);
  db.prepare("DELETE FROM tax_rule WHERE country = 'FR'").run();
});

// ───────────── Registry gate, plan, sync, Connectors, API ─────────────

test('registry: tounify is listed for FR and NL only (an EU tariff source, not UK), switched on, unlicensed; delta 011 switches the old rows on once', () => {
  const rows = db.prepare("SELECT market_code, role, scope, enabled, licence_confirmed, needs_credentials, origin FROM market_provider WHERE adapter = 'tounify' ORDER BY market_code, role").all().map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => [r.market_code, r.role, r.scope, r.enabled, r.licence_confirmed, r.needs_credentials, r.origin]), [
    ['FR', 'tariff_catalogue', 'shared', 1, 0, 1, 'provider'], ['FR', 'tariff_prices', 'home', 1, 0, 1, 'provider'],
    ['NL', 'tariff_catalogue', 'shared', 1, 0, 1, 'provider'], ['NL', 'tariff_prices', 'home', 1, 0, 1, 'provider'],
  ]);
  assert.equal(count("SELECT COUNT(*) n FROM market_provider WHERE adapter = 'tounify' AND market_code NOT IN ('FR', 'NL')"), 0, 'no GB (nor DE, BE, ES) row');
  // Delta 011 on a database an older seed wrote: the placeholder rows are switched on, once; an operator's later switch-off is kept.
  const delta = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'db', 'deltas', '011-tounify.sql'), 'utf8');
  db.prepare("UPDATE market_provider SET enabled = 0, note = 'adapter not built: tounify retail tariffs' WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").run();
  db.prepare("DELETE FROM schema_delta WHERE name = '011-tounify'").run();
  applyDelta(delta);
  assert.equal(db.prepare("SELECT enabled FROM market_provider WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").get().enabled, 1);
  db.prepare("UPDATE market_provider SET enabled = 0 WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").run();
  applyDelta(delta);
  assert.equal(db.prepare("SELECT enabled FROM market_provider WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").get().enabled, 0, 'never again');
  db.prepare("UPDATE market_provider SET enabled = 1 WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").run();
  seedProviders(db);   // what every open does next: the note refreshed, the switches kept
  assert.equal(db.prepare("SELECT note FROM market_provider WHERE adapter = 'tounify' AND market_code = 'FR' AND role = 'tariff_prices'").get().note, TOUNIFY_NOTE);
  assert.equal(count("SELECT COUNT(*) n FROM pragma_table_info('tariff') WHERE name = 'taxes_in_price' AND dflt_value = '0'"), 1);
});

test('gate: without TOUNIFY_DEV the plan skips tounify as unlicensed and POST connections refuses it; TOUNIFY_DEV with a production token changes nothing', async () => {
  fresh();
  for (const env of [{ TOUNIFY_API_KEY: TEST_TOKEN }, { TOUNIFY_API_KEY: PROD_TOKEN, TOUNIFY_DEV: '1' }, { TOUNIFY_DEV: '1' }]) {
    await withEnv(env, async () => {
      const p = P.plan(db, frSite()).filter((e) => e.adapter === 'tounify');
      assert.deepEqual(p.map((e) => [e.role, e.run, e.status]), [['tariff_prices', false, 'disabled'], ['tariff_catalogue', false, 'disabled']], JSON.stringify(env));
      assert.ok(p.every((e) => /^unlicensed: tounify v2: per-kWh prices/.test(e.skipped)));
      const r = await call('POST', `/api/sites/${fr.id}/connections`, { provider: 'tounify', consumption_tariff: 'EDFTRVHPHC' });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /^tounify is listed for tariff_prices in market FR but its licence is unconfirmed: tounify v2/);
      assert.equal(C.connectors(db).connectors.find((x) => x.adapter === 'tounify').status, 'disabled');
    });
  }
  assert.equal(api.calls.length, 0, 'never called');
});

test('missing token: a licensed row skips the step with "no credentials: TOUNIFY_API_KEY not set", with no call', async () => {
  fresh();
  db.prepare("UPDATE market_provider SET licence_confirmed = 1 WHERE adapter = 'tounify' AND market_code = 'FR'").run();
  try {
    const e = P.plan(db, frSite()).find((x) => x.adapter === 'tounify' && x.role === 'tariff_prices');
    assert.deepEqual([e.run, e.skipped], [false, 'no credentials: TOUNIFY_API_KEY not set']);
    const r = await syncSite(fr.id);
    assert.deepEqual(r.log.find((l) => l.step === 'tounify'), { step: 'tounify', ok: true, ms: 0, skipped: 'no credentials: TOUNIFY_API_KEY not set' });
    const post = await call('POST', `/api/sites/${fr.id}/connections`, { provider: 'tounify', consumption_tariff: 'EDFTRVHPHC' });
    assert.deepEqual([post.status, post.json.error], [400, 'no credentials: TOUNIFY_API_KEY not set']);
    assert.equal(api.calls.length, 0);
  } finally {
    db.prepare("UPDATE market_provider SET licence_confirmed = 0 WHERE adapter = 'tounify' AND market_code = 'FR'").run();
  }
});

test('TOUNIFY_DEV=1 with a test token: the plan runs tounify (labelled), POST records a home\'s tariff, the sync reads and prices it, Connectors shows the override', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 19, 5, 0);
  await withEnv(DEV, async () => {
    const home = createSite({ name: 'FR dev home', country: 'FR', postcode: '75008' });
    // No tariff recorded yet: the per-home role waits for it (quiet); the shared catalogue may run.
    let p = P.plan(db, home).filter((e) => e.adapter === 'tounify');
    assert.deepEqual(p.map((e) => [e.role, e.run, e.skipped ?? null]), [['tariff_prices', false, 'not connected for this home'], ['tariff_catalogue', true, null]]);
    const reg = await call('POST', `/api/sites/${home.id}/connections`, { provider: 'tounify', consumption_tariff: 'EDFTRVHPHC', company: 'EDF' });
    assert.equal(reg.status, 201, reg.text);
    assert.deepEqual([reg.json.reference, reg.json.role, reg.json.secrets_stored, reg.json.dev_override, reg.json.grid_resolution.operator.id, reg.json.connection.status],
      [`eb-site-${home.id}`, 'tariff_prices', false, TU.DEV_LABEL, 'GDS', 'recorded']);
    assert.ok(!reg.text.includes(TEST_TOKEN));
    p = P.plan(db, home).filter((e) => e.adapter === 'tounify');
    assert.deepEqual(p.map((e) => [e.step, e.run, e.dev_override]), [['tounify', true, TU.DEV_LABEL], ['tounify_catalogue', true, TU.DEV_LABEL]]);
    assert.ok(!JSON.stringify(p).includes(TEST_TOKEN), 'the token is never in a printable plan field');
    // The sync: the daily read, then the weekly catalogue, once each.
    const r = await syncSite(home.id);
    const step = r.log.find((l) => l.step === 'tounify');
    assert.equal(step.ok, true, step.error);
    assert.deepEqual([step.tariff, step.unit_rows, step.agreed], ['TOUNIFY-FR-EDFTRVHPHC', 144, true]);
    const cat = r.log.find((l) => l.step === 'tounify_catalogue');
    assert.equal(cat.ok, true, cat.error);
    assert.equal(cat.companies, 13, 'the national list of French suppliers');
    assert.deepEqual(cat.tariffs, { EDF: 10 }, 'and the tariffs of the suppliers our homes are on');
    assert.deepEqual(TU.tounifyAllowance(db).companies.ids, ['EDF'], 'listing EDF\'s tariffs spent one company');
    assert.match(TU.catalogueStatus('FR').reason, /^FR: 13 suppliers, the tariffs of EDF, refreshed /);
    // The supplier is linked, named as the catalogue lists it.
    assert.match(db.prepare("SELECT s.name FROM tariff t JOIN supplier s ON s.id = t.supplier_id WHERE t.tariff_code = 'TOUNIFY-FR-EDFTRVHPHC'").get().name, /Electricite de France|EDF/);
    // Rows first written on the override say so.
    const note = db.prepare("SELECT origin_note FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND superseded_at IS NULL LIMIT 1").get(frTariff.id, home.id).origin_note;
    assert.equal(note, `${TU.ORIGIN_NOTE_TEST}; ${TU.DEV_LABEL}`);
    assert.ok(count("SELECT COUNT(*) n FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND d.provider = 'tounify' AND a.superseded_at IS NULL", home.id) === 1);
    // A second sync the same day calls nothing (one read a day, one catalogue a week).
    const n = api.calls.length;
    const r2 = await syncSite(home.id);
    assert.ok(!r2.log.some((l) => l.step === 'tounify' || l.step === 'tounify_catalogue'), 'not due: not run, not logged');
    assert.equal(api.calls.length, n);
    const t = C.connectors(db).connectors.find((x) => x.adapter === 'tounify');
    assert.deepEqual([t.status, t.dev_override, t.label], ['connected', TU.DEV_LABEL, 'tounify (EU tariffs, v2)']);
    assert.equal(t.homes.find((h) => h.site_id === home.id).status, 'connected');
    assert.deepEqual(t.markets.map((m) => m.market_code), ['FR', 'NL']);
    const allowance = await call('GET', '/api/tounify/allowance');
    assert.deepEqual([allowance.status, allowance.json.token_kind, allowance.json.dev_override], [200, 'test', TU.DEV_LABEL]);
    assert.ok(!allowance.text.includes(TEST_TOKEN));
    assert.ok(api.calls.every((x) => x.method === 'GET' && x.path.startsWith('/v2/')), 'v2 only, reads only');
  });
});

test('a 429 during a cycle stops the run: the next home of the cycle is not called', async () => {
  fresh();
  api.etags = false;
  clock.t = Date.UTC(2026, 10, 21, 5, 0);
  await withEnv(DEV, async () => {
    const b = createSite({ name: 'FR second', country: 'FR', postcode: '75007' });
    await TU.registerConnection(b, { consumption_tariff: 'EDFTRVHPHC' }, { client: TU.clientFor({ token: TEST_TOKEN }) });
    api.calls.length = 0;
    api.override = (x) => (x.path.endsWith('/dayahead') ? json(429, { statusCode: 429, error: 'Too Many Requests', message: 'limit', code: 'daily_request_limit' }, { 'retry-after': '300' }) : null);
    const [ra, rb] = await syncAll([fr.id, b.id]);
    const sa = ra.log.find((l) => l.step === 'tounify');
    assert.equal(sa.ok, false);
    assert.match(sa.error, /HTTP 429 \(daily_request_limit\): run stopped/);
    assert.ok(!rb.log.some((l) => l.step === 'tounify'), 'the second home is not run while cooling down');
    assert.deepEqual(api.calls.map((x) => x.path.split('/').pop()), ['dayahead'], 'one call, the one refused');
    api.override = null;
  });
});

test('GB: tounify has no row there, and a GB home\'s plan, providers and alternatives never mention it, TOUNIFY_DEV or not', async () => {
  const gb = createSite({ name: 'GB home', postcode: 'BB12 9BY' });
  for (const env of [{}, DEV]) {
    await withEnv(env, async () => {
      assert.deepEqual(P.providersFor(db, 'GB', 'tariff_prices').map((r) => r.adapter), ['octopus']);
      assert.deepEqual(P.providersFor(db, 'GB', 'tariff_catalogue').map((r) => r.adapter), ['octopus', 'tariffscanner']);
      assert.ok(!P.plan(db, gb).some((e) => e.adapter === 'tounify'));
      assert.ok(!JSON.stringify(P.providerStatus(db, gb)).includes('tounify'), 'not in the Providers panel or its alternatives');
      const t = C.connectors(db).connectors.find((x) => x.adapter === 'tounify');
      assert.deepEqual(t.markets.map((m) => m.market_code), ['FR', 'NL'], 'EU market pills only');
      assert.ok(!t.homes.some((h) => h.market_code === 'GB'));
    });
  }
  const r = await call('POST', `/api/sites/${gb.id}/connections`, { provider: 'tounify', consumption_tariff: 'X' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^tounify is not a provider for market GB/);
});

test('nothing in this file reached the network, and no token was written to the database or the raw files', () => {
  assert.deepEqual(stray, []);
  const dump = JSON.stringify([
    db.prepare('SELECT * FROM provider_state').all(), db.prepare('SELECT * FROM connection').all(), db.prepare('SELECT request, reason FROM raw_payload').all(),
    db.prepare('SELECT origin_note FROM rate_interval').all(), db.prepare('SELECT detail FROM sync_run').all(),
  ]);
  for (const t of [TEST_TOKEN, PROD_TOKEN]) assert.ok(!dump.includes(t), 'no token in the database');
  const rawDir = path.join(path.dirname(process.env.DB_FILE), 'raw', 'tounify');
  for (const day of fs.readdirSync(rawDir)) {
    for (const f of fs.readdirSync(path.join(rawDir, day))) assert.ok(!fs.readFileSync(path.join(rawDir, day, f), 'utf8').includes(TU.TEST_PREFIX.slice(0, -1)), f);
  }
});

// ───────────── The tariff picker on tounify (src/core/tariff-picker.js): the same interface as GB ─────────────

test('tariff picker, France: suppliers and tariffs from v2 (kept a week), the choice kept here, priced at once on the home\'s own off-peak hours', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 23, 5, 0);
  const PK = await import('../src/core/tariff-picker.js');
  const s = createSite({ name: 'Paris picker', country: 'FR', postcode: '75008' });
  const row = () => db.prepare('SELECT * FROM site WHERE id = ?').get(s.id);
  // Not switched on (no TOUNIFY_DEV, no token): said plainly, nothing called.
  await assert.rejects(PK.listSuppliers(row()), (e) => e.status === 503 && /licence is unconfirmed|TOUNIFY_API_KEY/.test(e.message));
  assert.equal(api.calls.length, 0);
  await withEnv(DEV, async () => {
    const sup = await PK.listSuppliers(row());
    assert.equal(sup.source, 'tounify');
    // The national list, with no registration first.
    assert.deepEqual(api.calls.map((x) => x.path), ['/v2/FR/consumption/companies']);
    assert.equal(sup.suppliers.length, 13);
    const edf = sup.suppliers.find((x) => /Electricite de France/.test(x.name));
    assert.ok(edf, 'EDF listed under its catalogue name');
    assert.equal(db.prepare("SELECT 1 FROM connection WHERE site_id = ? AND provider = 'tounify'").get(s.id), undefined, 'listing records nothing for the home');
    const t1 = await PK.listTariffs(row(), edf.code);
    assert.deepEqual(t1.tariffs.map((t) => [t.id, t.kind]), [
      ['EDFTRVBASE', 'one_price'], ['EDFTRVBASE9', 'one_price'], ['EDFTRVHPHC', 'two_rate'], ['EDFTRVTEMPO', 'dynamic'], ['EDFVLA', 'one_price'],
      ['EDFVLOB', 'one_price'], ['EDFVLOHC', 'two_rate'], ['EDFVLR', 'two_rate'], ['EDFZFOB', 'one_price'], ['EDFZO', 'two_rate'],
    ], 'the kind from the name: Heures Creuses two-rate, Option Base one price, Tempo as the market');
    const hphc = t1.tariffs.find((t) => t.id === 'EDFTRVHPHC');
    assert.equal(hphc.prices_known, false, 'pricing a tariff spends the allowance: shown once the home is on it');
    assert.deepEqual(hphc.questions.map((q) => q.field), ['contracted_kva', 'off_peak_hours']);
    assert.deepEqual([hphc.hours.from, hphc.hours.to], ['23:00', '07:00'], 'the reference window, to be changed to the bill\'s');
    assert.match(hphc.link, /^https?:\/\//);
    const base = t1.tariffs.find((t) => t.id === 'EDFTRVBASE');
    assert.deepEqual([base.kind, base.hours, base.questions.map((q) => q.field)], ['one_price', null, ['contracted_kva']]);
    // Asked again within the week: from our copy, no call.
    const before = api.calls.length;
    await PK.listSuppliers(row());
    await PK.listTariffs(row(), edf.code);
    assert.equal(api.calls.length, before);
    // The subscribed power is required for France.
    await assert.rejects(PK.chooseTariff(row(), { supplier: edf.code, tariff: 'EDFTRVHPHC' }), /Subscribed power \(kVA\): an answer is required/);
    await assert.rejects(PK.chooseTariff(row(), { supplier: edf.code, tariff: 'EDFTRVHPHC', contracted_kva: 7 }), /must be one of 3, 6, 9/);
    // Off-peak hours that are not exactly 8 a day (France) are refused here, before anything is called.
    const sent = api.calls.length;
    await assert.rejects(PK.chooseTariff(row(), { supplier: edf.code, tariff: 'EDFTRVHPHC', contracted_kva: 6, hours: { from: '04:43', to: '11:55' } }),
      (e) => e.status === 400 && /exactly 8 hours a day, as on your bill: 04:43 to 11:55 is 7 h 12 min/.test(e.message));
    await assert.rejects(PK.chooseTariff(row(), { supplier: edf.code, tariff: 'EDFTRVHPHC', contracted_kva: 6, hours: { from: '22:00', to: '' } }), /HH:MM/);
    assert.equal(api.calls.length, sent, 'nothing called');
    assert.deepEqual([PK.windowMinutes('22:00', '06:00'), PK.windowMinutes('01:30', '09:30'), PK.windowMinutes('12:00', '12:00'), PK.windowMinutes('9:00', '17:00')], [480, 480, 1440, null]);
    const r = await PK.chooseTariff(row(), { supplier: edf.code, tariff: 'EDFTRVHPHC', contracted_kva: 6, hours: { from: '22:00', to: '06:00' } });
    assert.equal(r.source, 'tounify');
    assert.equal(r.tariff, 'TOUNIFY-FR-EDFTRVHPHC');
    // Kept here: the tariff, its supplier, the off-peak hours; then the prices read at the home's postal code.
    const m = JSON.parse(db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'tounify'").get(s.id).meta);
    assert.deepEqual([m.tariffs.consumption, m.company, m.off_peak_hours, m.postal_code], ['EDFTRVHPHC', 'EDF', [{ from: '22:00', to: '06:00' }], '75008']);
    assert.equal(api.of(/\/dayahead$/).at(-1).query.postal_code, '75008');
    assert.equal(r.prices.unit_rows, 144);
    assert.equal(r.prices.off_peak_hours, '22:00-06:00');
    assert.equal(row().contracted_kva, 6);
    const price = (min) => db.prepare("SELECT r.price_ex_vat FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.tariff_code = 'TOUNIFY-FR-EDFTRVHPHC' AND r.site_id = ? AND r.component = 'unit' AND r.superseded_at IS NULL AND r.valid_from = ?").get(s.id, at9(min)).price_ex_vat;
    assert.deepEqual([price(21 * 60 + 30), price(22 * 60), price(5 * 60 + 30), price(6 * 60)], [17.852, 13.242, 13.242, 17.852], 'priced on 22:00-06:00, not the reference 23:00-07:00');
    // Stored the same way as a GB choice: supplier on the tariff, the meter on it, the meter's own hours.
    const t = db.prepare("SELECT t.*, sp.name AS supplier FROM tariff t JOIN supplier sp ON sp.id = t.supplier_id WHERE t.tariff_code = 'TOUNIFY-FR-EDFTRVHPHC'").get();
    assert.match(t.supplier, /Electricite de France/);
    const c = PK.tariffChoice(row());
    assert.deepEqual([c.current.tariff, c.current.via, c.current.chosen, c.current.hours], ['TOUNIFY-FR-EDFTRVHPHC', 'tounify', true, [{ from: '22:00', to: '06:00' }]]);
    // Now that the home holds them, the list shows this tariff's prices.
    const shown = (await PK.listTariffs(row(), edf.code)).tariffs.find((x) => x.id === 'EDFTRVHPHC');
    assert.equal(shown.prices_known, true);
    assert.deepEqual(shown.options[0].unit.map((u) => [u.label, u.price]), [['Peak', 17.852], ['Off-peak', 13.242]]);
    assert.ok(api.calls.every((x) => x.method === 'GET' && x.path.startsWith('/v2/')), 'v2 only, reads only');
  });
});

test('catalogue status of a market whose supplier lists were read for the picker, before any weekly refresh: waiting, not a crash', () => {
  const before = db.prepare("SELECT state FROM provider_state WHERE provider = 'tounify'").get()?.state ?? '{}';
  const s = JSON.parse(before);
  s.catalogue ??= {};
  const kept = s.catalogue.NL;
  // What the picker's supplier list leaves: companies and listed_at, no refreshed_at (a Dutch home, Nov 2026).
  s.catalogue.NL = { companies: [{ id: 'ANWB', name: 'ANWB Energie' }], listed_at: { companies: Date.now() } };
  db.prepare("UPDATE provider_state SET state = ? WHERE provider = 'tounify'").run(JSON.stringify(s));
  try {
    const st = TU.catalogueStatus('NL');
    assert.equal(st.status, 'skipped');
    assert.match(st.reason, /no tounify catalogue refresh for NL yet/);
  } finally {
    if (kept === undefined) delete s.catalogue.NL; else s.catalogue.NL = kept;
    db.prepare("UPDATE provider_state SET state = ? WHERE provider = 'tounify'").run(before);
  }
});

test('lists and a catalogue read from the v3 preview (no api mark) are read again from v2 at once, then kept a week', async () => {
  fresh();
  clock.t = Date.UTC(2026, 10, 25, 5, 0);
  // What a v3 database holds: FR's supplier list narrowed by a connection (2 of them), refreshed yesterday.
  db.prepare("INSERT INTO provider_state (provider, state, updated_at) VALUES ('tounify', ?, 0)").run(JSON.stringify({ catalogue: { FR: {
    companies: [{ id: 'EDF', name: 'EDF' }, { id: 'OEF', name: 'Octopus' }], properties: [{ property: 'capacity.contracted_kva' }],
    refreshed_at: clock.t - 86400e3, listed_at: { companies: clock.t - 86400e3 },
  } } }));
  const s = createSite({ name: 'v3 cache', country: 'FR', postcode: '79200' });
  assert.equal(TU.catalogueDue('FR'), true, 'a v3 catalogue is due');
  const l = await TU.listCompanies(s, { client: client() });
  assert.deepEqual([l.cached, l.list.length], [false, 13], 'the national v2 list, not the narrowed v3 one');
  assert.deepEqual((await TU.listCompanies(s, { client: client() })).cached, true, 'then kept');
  const r = await TU.refreshCatalogue({ country: 'FR', client: client() });
  assert.equal(r.companies, 13);
  const cat = TU.readState().catalogue.FR;
  assert.deepEqual([cat.api, 'properties' in cat], ['v2', false]);
  assert.equal(TU.catalogueDue('FR'), false, 'refreshed from v2: not due for a week');
});

test('the Dutch picker asks no connection size: delta 082 removed the question (its answer priced nothing)', async () => {
  const PK = await import('../src/core/tariff-picker.js');
  assert.deepEqual(PK.questionsFor('NL', 'dynamic').map((q) => q.field), []);
  assert.deepEqual(PK.questionsFor('FR', 'two_rate').map((q) => q.field), ['contracted_kva', 'off_peak_hours'], 'France unchanged');
  assert.ok(db.prepare("SELECT 1 FROM schema_delta WHERE name = '082-nl-fuse-question'").get());
});
