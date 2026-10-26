// tounify v3 adapter (src/adapters/tounify.js), an EU tariff source (FR and NL, not UK): the mapping
// of real answers captured from the v3 preview API (test/fixtures/tounify/: connection-properties,
// connections, companies, tariffs, prices and components for a Paris and an Amsterdam connection,
// public tariff data with no credential in them), the client and its allowance guard against a fake
// fetch and a fake clock (no network, no real waiting, no real token: the token below is a stand-in
// built from the published prefix), the idempotent and bitemporal writes, taxes_in_price in
// pricing, the registry gate with and without TOUNIFY_DEV, and the sync step. Temp database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { useDb } from './helpers.js';

useDb();
const stray = [];
// Any request not sent to the fake tounify is refused and recorded; Open-Meteo answers empty (the
// sync of a French home runs its weather step too).
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.host === 'api.open-meteo.com') return new Response(JSON.stringify({ hourly: { time: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  stray.push(String(url));
  throw new Error(`no network in tests: ${url}`);
};
for (const k of ['TOUNIFY_API_KEY', 'TOUNIFY_DEV', 'TOUNIFY_MAX_REQUESTS_DAY', 'TOUNIFY_MAX_COMPANIES', 'TOUNIFY_MAX_TARIFFS', 'TOUNIFY_MAX_NEW_PER_ENDPOINT_DAY',
  'OCTOPUS_API_KEY', 'OCTOPUS_ACCOUNT_NUMBER', 'SUNSYNK_USERNAME', 'SUNSYNK_PASSWORD', 'TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD', 'IMPORT_TARIFF_CODE']) delete process.env[k];

const { db, applyDelta } = await import('../src/db/db.js');
const TU = await import('../src/adapters/tounify.js');
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
const clock = { t: Date.UTC(2026, 9, 26, 5, 0), sleeps: [], now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; } };
TU.tounifyPolicy.clock = clock;

// A fake tounify v3 serving the captured answers, with ETags, per-call overrides and a log of calls.
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeApi() {
  const api = { calls: [], etags: true, override: null, mutate: {} };
  const tag = (b) => `"${Buffer.from(JSON.stringify(b)).toString('base64').slice(-24)}"`;
  const reply = (call, body) => {
    const etag = tag(body);
    if (api.etags && call.headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return json(200, body, { ...(api.etags ? { etag } : {}), 'x-request-id': `req-${api.calls.length}` });
  };
  const connBody = (cc, ref, sent, prior = {}) => ({
    ...load(cc === 'FR' ? 'patch-FR-hphc.json' : 'patch-NL-dyn.json'), ...prior, reference: ref,
    tariffs: { consumption: sent?.tariffs?.consumption ?? null, feedin: sent?.tariffs?.feedin ?? null, grid: null },
    ...(sent?.capacity ? { capacity: sent.capacity } : {}), ...(sent?.metering ? { metering: sent.metering } : {}),
  });
  api.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { at: clock.now(), method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    api.calls.push(call);
    if (u.host !== 'api.tounify.io') return json(404, {});
    if (api.override) { const r = api.override(call); if (r) return r; }
    let m;
    if ((m = /^\/v3\/(FR|NL)\/connection-properties$/.exec(u.pathname))) return reply(call, load(`props-${m[1]}.json`));
    if ((m = /^\/v3\/(FR|NL)\/connections$/.exec(u.pathname)) && init.method === 'POST') return json(201, connBody(m[1], call.body.reference, call.body));
    if ((m = /^\/v3\/(FR|NL)\/connections\/([^/]+)$/.exec(u.pathname))) {
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, connBody(m[1], decodeURIComponent(m[2]), call.body), { etag: '"conn-1"' });
    }
    if ((m = /^\/v3\/(FR|NL)\/connections\/([^/]+)\/prices$/.exec(u.pathname))) {
      const b = { ...load(`prices-${m[1]}.json`), reference: decodeURIComponent(m[2]) };
      return reply(call, api.mutate.prices ? api.mutate.prices(b) : b);
    }
    if ((m = /^\/v3\/(FR|NL)\/connections\/([^/]+)\/components$/.exec(u.pathname))) {
      const b = { ...load(`comps-${m[1]}.json`), reference: decodeURIComponent(m[2]) };
      return reply(call, api.mutate.components ? api.mutate.components(b) : b);
    }
    if ((m = /^\/v3\/(FR|NL)\/connections\/[^/]+\/consumption\/companies$/.exec(u.pathname))) return reply(call, load(`comp-${m[1]}.json`));
    if ((m = /^\/v3\/(FR|NL)\/connections\/[^/]+\/consumption\/([^/]+)\/tariffs$/.exec(u.pathname))) return reply(call, load(`tar-${m[1]}.json`));
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

test('fixtures: real v3 answers, trimmed, with no token or Authorization text in them', () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 14);
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.ok(!text.includes(TU.TEST_PREFIX.slice(0, -1)) && !text.includes(TU.PROD_PREFIX.slice(0, -1)), `${f}: no token`);
    assert.ok(!text.includes('Bearer'), `${f}: no Authorization header`);
    JSON.parse(text);
  }
});

test('prices FR: EDF Tarif Bleu HP/HC, two price levels, (energy + grid + fees) x 100 in cents ex VAT, VAT never stored', () => {
  const body = load('prices-FR.json');
  const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR' });
  assert.equal(m.ok, true, m.problems?.join('; '));
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.structure, m.tariff.currency, m.tariff.nativePeriodS, m.tariff.taxesInPrice], ['TOUNIFY-FR-EDFTRVHPHC', 'tou', 'tou', 'EUR', 1800, 1]);
  assert.equal(m.rows.length, 96, 'one row per half-hour point');
  assert.ok(m.rows.every((r) => r.validTo - r.validFrom === 1800));
  const levels = [...new Set(m.rows.map((r) => r.price))].sort((a, b) => b - a);
  assert.deepEqual(levels, [17.852, 13.242], 'peak 0.1308 + 0.0171 + 0.03062 = 0.17852 EUR; off-peak 0.0898 + 0.012 + 0.03062 = 0.13242 EUR');
  // Every row is the sum of its point's three components, never with its vat.
  body.consumption.forEach((p, i) => {
    near(m.rows[i].price, (p.energy + p.grid + p.fees) * 100, `point ${i}`);
    assert.ok(Math.abs(m.rows[i].price - (p.energy + p.grid + p.fees + p.vat) * 100) > 1, 'vat is not in the price');
  });
  // Off-peak 01:30-07:30 and 12:30-14:30 Paris (CET): 00:30-06:30 and 11:30-13:30 UTC.
  const at = (h, mm) => m.rows.find((r) => r.validFrom === Date.UTC(2026, 9, 26, h, mm) / 1000).price;
  assert.deepEqual([at(0, 0), at(0, 30), at(6, 0), at(6, 30), at(11, 30), at(13, 30)], [17.852, 13.242, 13.242, 17.852, 13.242, 17.852]);
  assert.deepEqual(m.vat, [{ fromUtc: 1792969200, rate: 0.2, source: 'country' }]);
  assert.equal(m.tariff.origin, 'provider');
  assert.match(m.tariff.originNote, /^tounify v3 \(test token\): storage licence unconfirmed; /);
  // With the catalogue's listing the kind's basis is its time_of_use_rates.
  const cat = Object.fromEntries(load('tar-FR.json').map((t) => [t.id, t]));
  const mc = TU.mapPrices(body, { country: 'FR', currency: 'EUR', catalogue: cat });
  assert.equal(mc.tariff.name, 'Tarif Bleu — Option Heures Pleines / Heures Creuses');
  assert.match(mc.tariff.originNote, /time_of_use_rates 2 \(catalogue\)/);
});

test('prices NL: Frank Energie dynamic, 96 quarter-hours holding 24 hourly prices become 24 hourly rows; grid 0, fees 0.09161 inside', () => {
  const body = load('prices-NL.json');
  const m = TU.mapPrices(body, { country: 'NL', currency: 'EUR' });
  assert.equal(m.ok, true, m.problems?.join('; '));
  assert.equal(body.consumption.length, 96);
  assert.deepEqual([m.tariff.tariffCode, m.tariff.kind, m.tariff.nativePeriodS, m.resolutionS, m.settlementS, m.taxesInPrice], ['TOUNIFY-NL-FRENS', 'dynamic', 3600, 900, 3600, 1]);
  assert.equal(m.rows.length, 24, 'merged to the settlement interval');
  assert.equal(new Set(m.rows.map((r) => r.price)).size, 24, '24 hourly levels');
  m.rows.forEach((r, h) => {
    assert.equal(r.validTo - r.validFrom, 3600);
    for (const p of body.consumption.slice(h * 4, h * 4 + 4)) {
      assert.equal(p.grid, 0);
      assert.equal(p.fees, 0.09161);
      near(r.price, (p.energy + p.fees) * 100, `hour ${h}`);
    }
  });
  assert.equal(m.rows[0].price, 14.82575, '0.0566475 + 0 + 0.09161 EUR');
  assert.equal(m.pendingFrom, 1793055600);
});

test('components FR and NL: resolved amounts x 100 per period, signs kept, capacity as its yearly amount with its quantity source', () => {
  const fr = TU.mapComponents(load('comps-FR.json'), { currency: 'EUR', zone: 'Europe/Paris', captureDayStart: 1792969200 });
  assert.equal(fr.ok, true);
  assert.deepEqual(fr.rows.map((r) => [r.register, r.chargePeriod, r.price]), [
    ['consumption:standing', 'year', 5670.0985],   // supply abonnement 56.700985 EUR/yr
    ['grid:capacity', 'year', 6252],                // 6 kVA x 10.42 = 62.52 EUR/yr, NOT the 10.42 per-kVA rate
    ['grid:standing', 'year', 1712],                // management 17.12 EUR/yr
    ['grid:metering', 'year', 2267],                // metering 22.67 EUR/yr
  ]);
  const cap = fr.rows.find((r) => r.register === 'grid:capacity');
  assert.equal(cap.quantitySource, 'contracted');
  assert.match(cap.originNote, /quantity contracted \(the resolved amount, not the per-unit rate\)/);
  assert.equal(cap.validFrom, Date.UTC(2026, 6, 31, 22) / 1000, 'valid_from 2026-08-01, Paris midnight');
  assert.match(cap.originNote, /upstream valid_to 2027-07-31 not used as an end/);
  assert.equal(fr.rows[0].validFrom, 1792969200, 'no valid_from: the capture day');
  const nl = TU.mapComponents(load('comps-NL.json'), { currency: 'EUR', zone: 'Europe/Amsterdam', captureDayStart: 1792969200 });
  assert.deepEqual(nl.rows.map((r) => [r.register, r.chargePeriod, r.price]), [
    ['consumption:standing', 'month', 578.5124],    // 5.785124 EUR/month
    ['consumption:credit', 'year', -51980],         // Belastingvermindering -519.8 EUR/yr, negative
    ['grid:standing', 'year', 39508],               // Liander 395.08 EUR/yr
  ]);
  // A charge with no resolved amount is not stored; it is named with what it needs.
  const body = load('comps-FR.json');
  delete body.grid[0].resolved;
  body.grid[0].quantity.requires = ['contracted_kva'];
  const un = TU.mapComponents(body, { currency: 'EUR', zone: 'Europe/Paris', captureDayStart: 1792969200 });
  assert.deepEqual(un.unsized.map((u) => [u.group, u.kind, u.requires]), [['grid', 'capacity', ['contracted_kva']]]);
  assert.equal(un.rows.length, 3);
});

test('feed-in (SYNTHETIC points: no feed-in answer was captured): paid energy less the producer\'s fees, an export tariff, as the spec states it', () => {
  const body = { ...load('prices-NL.json'), feedin_tariff: { id: 'TEST-FEEDIN', type: 'dynamic', available: true },
    feedin: [{ from_utc: 1792969200, energy: 0.05, fees: 0.01 }, { from_utc: 1792970100, energy: -0.02 }] };
  const m = TU.mapPrices(body, { country: 'NL', currency: 'EUR' });
  assert.deepEqual([m.feedin.tariff.tariffCode, m.feedin.tariff.direction, m.feedin.tariff.kind], ['TOUNIFY-NL-TEST-FEEDIN', 'export', 'dynamic']);
  assert.deepEqual(m.feedin.rows.map((r) => [r.validFrom, r.validTo - r.validFrom, r.price]), [[1792969200, 900, 4], [1792970100, 900, -2]], 'negative export prices are kept');
});

test('mapping: unknown fields are ignored; a missing expected field or a grid gap is a problem, never a guess', () => {
  const b = load('prices-FR.json');
  assert.equal(TU.mapPrices({ ...b, brand_new_field: { x: 1 }, consumption: b.consumption.map((p) => ({ ...p, extra: 'x' })) }, { country: 'FR', currency: 'EUR' }).ok, true);
  for (const [what, body, re] of [
    ['no next', { ...b, next: undefined }, /no next/],
    ['no resolution', { ...b, resolution: undefined }, /resolution/],
    ['no currency', { ...b, currency: undefined }, /no currency/],
    ['another currency', { ...b, currency: 'GBP' }, /home is billed in EUR/],
    ['a point without energy', { ...b, consumption: [{ from_utc: 1792969200, grid: 0.01 }] }, /no energy/],
    ['grid gap', { ...b, applied: { ...b.applied, grid_gap: 'no_tariff' } }, /grid_gap/],
    ['not an object', [1, 2], /not an object/],
  ]) {
    const m = TU.mapPrices(body, { country: 'FR', currency: 'EUR' });
    assert.equal(m.ok, false, what);
    assert.match(m.problems.join('; '), re, what);
  }
  assert.equal(TU.mapComponents({ consumption: [] }, { currency: 'EUR' }).ok, false, 'components without grid / feedin arrays');
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
  for (let i = 0; i < 3; i++) await c.request('GET', '/v3/FR/connection-properties', { scope: { endpoint: 'GET connection-properties', thing: 'FR' } });
  assert.equal(api.calls.length, 3);
  assert.equal(api.calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.ok(api.calls.slice(1).every((x, i) => x.at - api.calls[i].at >= 1000), 'one request at a time, 1 s apart');
  await assert.rejects(c.request('GET', '/v3/FR/connection-properties'), (e) => e.kind === 'allowance' && /3 of 3 requests used today/.test(e.message));
  assert.equal(api.calls.length, 3, 'no call when over budget');
  // A "restart": a new client reads the same persisted counters.
  TU.resetClients();
  const c2 = client({ TOUNIFY_MAX_REQUESTS_DAY: '3' });
  await assert.rejects(c2.request('GET', '/v3/NL/connection-properties'), /3 of 3 requests used today/);
  assert.equal(api.calls.length, 3);
  const a = TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN, TOUNIFY_MAX_REQUESTS_DAY: '3' } });
  assert.deepEqual([a.token_kind, a.requests_today, a.max_requests_day, a.guarded], ['test', 3, 3, true]);
  assert.ok(!JSON.stringify(a).includes(TEST_TOKEN), 'the allowance never shows the token');
  // The day count resets at midnight UTC; the totals of companies and tariffs never do.
  clock.t = Date.UTC(2026, 9, 27, 0, 5);
  await c2.request('GET', '/v3/FR/connection-properties');
  assert.equal(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).requests_today, 1);
  // A production token is not capped unless asked.
  await client({}, PROD_TOKEN).request('GET', '/v3/NL/connection-properties');
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM provider_state WHERE provider = 'tounify'").get()).includes(TU.TEST_PREFIX), 'no token in provider_state');
});

test('allowance: a new tariff past the distinct-tariff cap is refused before the call; tariffs already named stay usable', async () => {
  fresh();
  const c = client({ TOUNIFY_MAX_TARIFFS: '1' });
  const s1 = createSite({ name: 'cap 1', country: 'FR', postcode: '75002' });
  const s2 = createSite({ name: 'cap 2', country: 'FR', postcode: '75003' });
  const r1 = await TU.registerConnection(s1, { consumption_tariff: 'EDFTRVHPHC' }, { client: c });
  assert.equal(r1.created, true);
  await assert.rejects(TU.registerConnection(s2, { consumption_tariff: 'EDFTRVBASE' }, { client: c }), (e) => e.kind === 'allowance' && /1 of 1 distinct tariffs already named.*EDFTRVBASE/.test(e.message));
  assert.equal(api.of(/connections$/).length, 1, 'the refused registration was never sent');
  const r2 = await TU.registerConnection(s2, { consumption_tariff: 'EDFTRVHPHC' }, { client: c });
  assert.equal(r2.reference, `eb-site-${s2.id}`);
  assert.deepEqual(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN, TOUNIFY_MAX_TARIFFS: '1' } }).tariffs, { used: 1, max: 1, ids: ['EDFTRVHPHC'] });
  for (const s of [s1, s2]) await TU.removeConnection(s, { client: c });
  assert.equal(count("SELECT COUNT(*) n FROM connection WHERE provider = 'tounify' AND site_id IN (?, ?)", s1.id, s2.id), 0, 'rows dropped');
  assert.equal(api.of(/connections\/eb-site-/).filter((x) => x.method === 'DELETE').length, 2);
});

test('a 429 stops the run and honours Retry-After (persisted); a 403 testingLimit marks the allowance used up', async () => {
  fresh();
  const c = client();
  api.override = (x) => (x.path.endsWith('/connection-properties') ? json(429, { statusCode: 429, error: 'Too Many Requests', message: 'Daily testing limit', code: 'daily_scope_limit', rateLimit: { limit: 5, remaining: 0, resetAt: new Date(clock.now() + 3600e3).toISOString() } }, { 'retry-after': '120' }) : null);
  await assert.rejects(c.request('GET', '/v3/FR/connection-properties'), (e) => e.kind === 'rate_limited' && /HTTP 429 \(daily_scope_limit\): run stopped/.test(e.message));
  const st = db.prepare("SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = 'tounify'").get();
  assert.equal(st.next_allowed_at, clock.now() + 3600e3, 'until rateLimit.resetAt, the later of it and Retry-After');
  assert.match(st.cooldown_reason, /^HTTP 429 daily_scope_limit/);
  api.override = null;
  const before = api.calls.length;
  TU.resetClients();
  await assert.rejects(client().request('GET', '/v3/NL/connection-properties'), (e) => e.kind === 'cooldown');
  assert.equal(api.calls.length, before, 'nothing is sent while cooling down, even by a new client');
  assert.match(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).cooldown.reason, /HTTP 429/);
  // A 429 with neither Retry-After nor rateLimit is a daily limit: until midnight UTC.
  fresh();
  api.override = () => json(429, { statusCode: 429, error: 'Too Many Requests', message: 'daily', code: 'daily_request_limit' });
  await assert.rejects(client().request('GET', '/v3/FR/connection-properties'), /daily_request_limit/);
  assert.equal(db.prepare("SELECT next_allowed_at FROM provider_state WHERE provider = 'tounify'").get().next_allowed_at, Date.UTC(2026, 9, 28));
  // 403 testingLimit: the tariffs allowance is used up; a new tariff is then refused here, without a call.
  fresh();
  api.override = (x) => (x.method === 'POST' ? json(403, { statusCode: 403, message: 'max 20 tariffs', code: 'testing_allowance_exhausted', testingLimit: { kind: 'tariffs', limit: 20, used: 20, remaining: 0, blocked: ['EDFZO'] } }) : null);
  const s = createSite({ name: 'blocked', country: 'FR', postcode: '75004' });
  await assert.rejects(TU.registerConnection(s, { consumption_tariff: 'EDFZO' }, { client: client() }), (e) => e.kind === 'allowance_exhausted' && /blocked: EDFZO/.test(e.message));
  api.override = null;
  const n = api.calls.length;
  await assert.rejects(TU.registerConnection(s, { consumption_tariff: 'EDFVLR' }, { client: client() }), (e) => e.kind === 'allowance' && /refused new tariffs/.test(e.message));
  assert.equal(api.calls.length, n);
  assert.deepEqual(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).exhausted.tariffs.blocked, ['EDFZO']);
});

// ───────────── Registration ─────────────

test('registration: reference eb-site-<id>, postal code only, capacity and off-peak hours from the home\'s own data, only what the market takes', async () => {
  fresh();
  clock.t = Date.UTC(2026, 9, 26, 5, 0) + 3 * 86400e3;   // after the daily cooldown set above
  const { body, warnings } = TU.connectionBody(frSite(), { consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate', communication: 'remote', wires: 3 } });
  assert.deepEqual(body, {
    reference: `eb-site-${fr.id}`, postal_code: '75001', tariffs: { consumption: 'EDFTRVHPHC' }, capacity: { contracted_kva: 6 },
    metering: { type: 'dual_rate', communication: 'remote', off_peak_hours: { all_year: [{ from: '01:30', to: '07:30' }, { from: '12:30', to: '14:30' }] } },
  });
  assert.deepEqual(warnings, ['metering.wires is not a property FR takes: not sent']);
  // NL takes no kVA: a contracted kVA is never sent there.
  const n = TU.connectionBody({ ...nlSite(), contracted_kva: 10 }, { consumption_tariff: 'FRENS', capacity: { contracted_kva: 10, phases: 3 } });
  assert.deepEqual(n.body, { reference: `eb-site-${nl.id}`, postal_code: '1011', tariffs: { consumption: 'FRENS' }, capacity: { phases: 3 } });
  assert.throws(() => TU.connectionBody(nlSite(), {}), /consumption_tariff is required/);
  assert.throws(() => TU.connectionBody({ ...nlSite(), postcode: null }, { consumption_tariff: 'FRENS' }), /postal_code is required/);

  const r = await TU.registerConnection(frSite(), { consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate', communication: 'remote' } }, { client: client() });
  assert.deepEqual([r.created, r.reference, r.country, r.grid_resolution.operator.id, r.grid_resolution.location_mapped], [true, `eb-site-${fr.id}`, 'FR', 'ENED', true]);
  const sent = api.of(/^\/v3\/FR\/connections$/)[0];
  assert.equal(sent.method, 'POST');
  assert.deepEqual(Object.keys(sent.body).sort(), ['capacity', 'metering', 'postal_code', 'reference', 'tariffs']);
  const row = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'tounify'").get(fr.id);
  assert.equal(row.external_ref, `eb-site-${fr.id}`);
  const meta = JSON.parse(row.meta);
  assert.deepEqual([meta.country, meta.grid_operator, meta.location_mapped, meta.tariffs.consumption], ['FR', { id: 'ENED', name: 'Enedis' }, true, 'EDFTRVHPHC']);
  // Registering again is a PATCH of the whole profile (no reference in the body); once a PATCH has
  // answered its ETag, the next one sends it back in If-Match.
  const again = await TU.registerConnection(frSite(), { consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate', communication: 'remote' } }, { client: client() });
  let patch = api.calls.at(-1);
  assert.deepEqual([patch.method, 'reference' in patch.body, patch.body.tariffs], ['PATCH', false, { consumption: 'EDFTRVHPHC', feedin: null }]);
  assert.equal(again.created, false);
  await TU.registerConnection(frSite(), { consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate', communication: 'remote' } }, { client: client() });
  patch = api.calls.at(-1);
  assert.deepEqual([patch.method, patch.headers['if-match']], ['PATCH', '"conn-1"']);
  const nr = await TU.registerConnection(nlSite(), { consumption_tariff: 'FRENS' }, { client: client() });
  assert.equal(nr.grid_resolution.operator.name, 'Liander');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM connection').all()).includes(TU.TEST_PREFIX), 'no token in a connection row');
});

// ───────────── Daily read, idempotency, ETag, cadence ─────────────

let frTariff;
test('daily read FR: prices and components stored once, the home agreed on the tariff, the same answer again changes nothing', async () => {
  fresh();
  api.etags = false;
  const c = client();
  const r = await TU.syncTounifyHome({ site: frSite(), client: c });
  assert.equal(r.failed, undefined, r.error);
  assert.deepEqual([r.tariff, r.kind, r.taxes_in_price, r.unit_rows, r.fixed_rows, r.agreed], ['TOUNIFY-FR-EDFTRVHPHC', 'tou', 1, 96, 4, true]);
  const q = api.of(/\/prices$/)[0].query;
  assert.deepEqual(q, { include: 'fees,vat', resolution: '1800', historic_days: '1' }, 'the home\'s slot length, fees and vat, yesterday kept');
  assert.deepEqual(api.of(/\/components$/)[0].query, { use_defaults: 'true' });
  frTariff = db.prepare("SELECT * FROM tariff WHERE tariff_code = 'TOUNIFY-FR-EDFTRVHPHC'").get();
  assert.deepEqual([frTariff.provider, frTariff.country, frTariff.currency, frTariff.native_period_s, frTariff.taxes_in_price, frTariff.origin], ['tounify', 'FR', 'EUR', 1800, 1, 'provider']);
  const rows = db.prepare("SELECT * FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND superseded_at IS NULL").all(frTariff.id, fr.id);
  assert.equal(rows.length, 96);
  assert.ok(rows.every((x) => x.origin === 'provider' && x.origin_note === TU.ORIGIN_NOTE_TEST && x.raw_id != null));
  assert.equal(TU.ORIGIN_NOTE_TEST, 'tounify v3 (test token): storage licence unconfirmed');
  const fixed = db.prepare("SELECT register, charge_period, price_ex_vat FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'fixed' AND superseded_at IS NULL ORDER BY register").all(frTariff.id, fr.id).map((x) => ({ ...x }));
  assert.deepEqual(fixed, [
    { register: 'consumption:standing', charge_period: 'year', price_ex_vat: 5670.0985 }, { register: 'grid:capacity', charge_period: 'year', price_ex_vat: 6252 },
    { register: 'grid:metering', charge_period: 'year', price_ex_vat: 2267 }, { register: 'grid:standing', charge_period: 'year', price_ex_vat: 1712 },
  ]);
  const ag = db.prepare("SELECT a.*, d.kind FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND d.provider = 'tounify' AND a.superseded_at IS NULL").all(fr.id);
  assert.deepEqual(ag.map((a) => [a.kind, a.tariff_id, a.valid_from, a.valid_to]), [['meter_import', frTariff.id, 1792969200, null]]);
  for (const what of ['prices', 'components']) {
    assert.equal(count(`SELECT COUNT(*) n FROM raw_payload p JOIN source s ON s.id = p.source_id WHERE s.code = 'tounify' AND p.site_id = ? AND p.status = 'accepted'
      AND json_extract(p.request, '$.path') = ?`, fr.id, `/v3/FR/connections/eb-site-${fr.id}/${what}`), 1, `${what} landed raw`);
  }
  assert.deepEqual(r.vat_check, [{ from_utc: 1792969200, tounify: 0.2, ours: null, rules: [], match: false }], 'no FR VAT rule held in this database yet');
  // Same answer again (forced, same day): nothing written.
  const again = await TU.syncTounifyHome({ site: frSite(), client: c, force: true });
  assert.deepEqual([again.unit_rows, again.fixed_rows, again.agreements_changed, again.tariff_created], [0, 0, false, 0]);
  assert.equal(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NOT NULL', frTariff.id), 0);
});

test('a changed price supersedes the stored row (kept), the parts around it keep their old price; a changed charge likewise; nothing is deleted', async () => {
  api.etags = false;
  const total = count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id);
  api.mutate.prices = (b) => ({ ...b, consumption: b.consumption.map((p, i) => (i === 5 ? { ...p, energy: 0.2 } : p)) });
  api.mutate.components = (b) => ({ ...b, grid: b.grid.map((g) => (g.kind === 'metering' ? { ...g, resolved: { ...g.resolved, amount: 23.5 } } : g)) });
  const r = await TU.syncTounifyHome({ site: frSite(), client: client(), force: true });
  assert.deepEqual([r.unit_rows, r.fixed_rows], [1, 1]);
  const t5 = 1792969200 + 5 * 1800;
  const hist = db.prepare("SELECT price_ex_vat, superseded_at FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND valid_from = ? ORDER BY id").all(frTariff.id, fr.id, t5);
  assert.deepEqual(hist.map((h) => [h.price_ex_vat, h.superseded_at != null]), [[13.242, true], [24.262, false]], '0.2 + 0.012 + 0.03062 EUR');
  const met = db.prepare("SELECT price_ex_vat, superseded_at FROM rate_interval WHERE tariff_id = ? AND register = 'grid:metering' ORDER BY id").all(frTariff.id);
  assert.deepEqual(met.map((h) => [h.price_ex_vat, h.superseded_at != null]), [[2267, true], [2350, false]]);
  assert.equal(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id), total + 2, 'two rows added, none removed');
  // Back to the captured answer: the captured prices are current again, history kept.
  api.mutate = {};
  await TU.syncTounifyHome({ site: frSite(), client: client(), force: true });
  assert.equal(db.prepare("SELECT price_ex_vat FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND valid_from = ? AND component = 'unit' AND superseded_at IS NULL").get(frTariff.id, fr.id, t5).price_ex_vat, 13.242);
});

test('at most one price read per connection a day, never before `next`; a 304 reuses the stored copy and changes nothing', async () => {
  fresh();
  api.etags = true;
  clock.t = Date.UTC(2026, 9, 30, 5, 0);
  const c = client();
  const first = await TU.syncTounifyHome({ site: frSite(), client: c });
  assert.equal(first.failed, undefined);
  const n = api.calls.length;
  // Later the same UTC day: not due (and the step's applies() says so, so the sync does not even log it).
  clock.t += 6 * 3600e3;
  assert.match((await TU.syncTounifyHome({ site: frSite(), client: c })).skipped, /^not due: one price read a day per connection/);
  assert.equal(TU.priceReadDue(fr.id).due, false);
  assert.equal(api.calls.length, n, 'no call');
  // Next UTC day: due again; the answer is unchanged, so 304s, the stored copies are mapped, nothing written.
  clock.t = Date.UTC(2026, 9, 31, 1, 0);
  assert.equal(TU.priceReadDue(fr.id).due, true);
  const second = await TU.syncTounifyHome({ site: frSite(), client: c });
  assert.deepEqual(second.not_modified, ['prices']);
  assert.deepEqual([second.unit_rows, second.fixed_rows], [0, 0]);
  const two = api.calls.slice(n);
  assert.deepEqual(two.map((x) => x.path.split('/').pop()), ['prices', 'components']);
  assert.ok(two.every((x) => x.headers['if-none-match']), 'If-None-Match sent');
  assert.equal(TU.tounifyAllowance(db, { env: { TOUNIFY_API_KEY: TEST_TOKEN } }).requests_today, 2, 'a 304 is still a request');
  // An answer whose `next` lies days ahead: no read before it, even on a new UTC day.
  fresh();
  api.etags = false;
  api.mutate.prices = (b) => ({ ...b, next: Math.floor(Date.UTC(2026, 10, 3, 6) / 1000) });
  await TU.syncTounifyHome({ site: frSite(), client: client() });
  clock.t = Date.UTC(2026, 10, 1, 9, 0);
  assert.match((await TU.syncTounifyHome({ site: frSite(), client: client() })).skipped, /^not due: tounify advises the next read after 2026-11-03T06:00:00Z/);
  api.mutate = {};
});

test('daily read NL: 24 hourly rows ex VAT, the credit negative, and the VAT cross-check warns on a different rule without touching it', async () => {
  fresh();
  api.etags = false;
  clock.t = Date.UTC(2026, 10, 4, 5, 0);
  const r = await TU.syncTounifyHome({ site: nlSite(), client: client() });
  assert.deepEqual([r.tariff, r.kind, r.unit_rows, r.fixed_rows, r.settlement_interval, r.resolution], ['TOUNIFY-NL-FRENS', 'dynamic', 24, 3, 3600, 900]);
  assert.equal(api.of(/\/prices$/).at(-1).query.resolution, '900', 'the home\'s quarter-hour slots');
  assert.match(r.warnings.join('\n'), /VAT: tounify states 21 % from 2026-10-25T23:00:00Z; we hold no VAT rule for NL then/);
  const t = db.prepare("SELECT id FROM tariff WHERE tariff_code = 'TOUNIFY-NL-FRENS'").get();
  assert.equal(db.prepare("SELECT price_ex_vat FROM rate_interval WHERE tariff_id = ? AND register = 'consumption:credit' AND superseded_at IS NULL").get(t.id).price_ex_vat, -51980);
  // Our NL VAT rule says 9 %: tounify's 21 % is reported, our rule is kept as it is.
  db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES ('NL', 'btw', 'electricity', 'import', 'domestic', 'all', 'percent', 0.09, NULL, NULL, 100, ?, NULL, 'test rule', 1, 0, 'placeholder', 'test rule')`).run(Date.UTC(2025, 11, 31, 23) / 1000);
  const again = await TU.syncTounifyHome({ site: nlSite(), client: client(), force: true });
  assert.match(again.warnings.join('\n'), /VAT mismatch: tounify states 21 % from 2026-10-25T23:00:00Z, our NL\/btw says 9 % \(a placeholder\): our rule is kept, check it/);
  assert.deepEqual(again.vat_check.map((v) => [v.tounify, v.ours, v.match]), [[0.21, 0.09, false]]);
  assert.equal(db.prepare("SELECT value FROM tax_rule WHERE country = 'NL' AND code = 'btw' AND superseded_at IS NULL").get().value, 0.09, 'never silently overridden');
  db.prepare("DELETE FROM tax_rule WHERE country = 'NL' AND source = 'test rule'").run();
});

test('an answer of an unexpected shape is quarantined: the step fails soft, nothing is mapped from it, the sync goes on', async () => {
  fresh();
  api.etags = false;
  clock.t = Date.UTC(2026, 10, 5, 5, 0);
  const before = count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id);
  api.mutate.prices = (b) => { const x = { ...b }; delete x.resolution; delete x.next; return x; };
  const r = await TU.syncTounifyHome({ site: frSite(), client: client() });
  assert.equal(r.failed, true);
  assert.match(r.error, /unexpected shape: resolution missing is not 900, 1800 or 3600; no next/);
  const q = db.prepare('SELECT status, reason FROM raw_payload WHERE id = ?').get(r.quarantined);
  assert.deepEqual([q.status, /^unexpected shape: /.test(q.reason)], ['quarantined', true]);
  assert.equal(count('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ?', frTariff.id), before, 'nothing written');
  // Components of an odd shape: the prices still stand, the step reports the failure.
  fresh();
  api.mutate = { components: (b) => ({ ...b, grid: 'not a list' }) };
  const r2 = await TU.syncTounifyHome({ site: frSite(), client: client() });
  assert.equal(r2.failed, true);
  assert.match(r2.error, /components .*unexpected shape: no grid array/);
  assert.equal(r2.unit_rows, 0, 'the prices were read and are unchanged');
  api.mutate = {};
});

// ───────────── Pricing: taxes_in_price ─────────────

test('taxes_in_price: a French home priced from tounify pays (energy + grid + fees) x 1.20; the placeholder accise is not added on top; default 0 is taxed as before', () => {
  const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`);
  for (const r of PLACEHOLDER_TAX_RULES.filter((x) => x.country === 'FR')) {
    ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.currency, r.charge_period, r.seq, r.valid_from, r.valid_to, r.source, r.origin, r.origin_note);
  }
  const peak = 1792969200; const off = 1792974600;
  const p = loadPricing(fr.id, peak, peak + 86400);
  const at = (ts) => priceAt(p, 'meter_import', ts);
  const pk = at(peak);
  assert.deepEqual([pk.tariffCode, pk.supplyEx, pk.unitEx, pk.levy, pk.vat], ['TOUNIFY-FR-EDFTRVHPHC', 17.852, 17.852, 0, 0.2]);
  near(pk.unitEx * (1 + pk.vat), (0.1308 + 0.0171 + 0.03062) * 1.2 * 100, 'peak paid per kWh');
  near(at(off).unitEx * (1 + at(off).vat), (0.0898 + 0.012 + 0.03062) * 1.2 * 100, 'off-peak paid per kWh');
  assert.deepEqual(pk.tax.rules.map((r) => r.code), ['tva'], 'only the percent rule: the accise is inside fees already');
  assert.ok(!pk.inputs.some((i) => /accise/.test(i.what)));
  // Fixed charges: the yearly amounts per local day (all four in force from the capture day), with VAT only.
  const later = Date.UTC(2026, 9, 30, 12) / 1000;
  const pl = priceAt(loadPricing(fr.id, later, later + 3600), 'meter_import', later);
  assert.deepEqual(pl.fixed.map((f) => [f.register, f.period, f.amount]).sort(), [['consumption:standing', 'year', 5670.0985], ['grid:capacity', 'year', 6252], ['grid:metering', 'year', 2267], ['grid:standing', 'year', 1712]]);
  assert.ok(Math.abs(fixedPerDay(pl, later, 'Europe/Paris') - ((5670.0985 + 6252 + 1712 + 2267) / 365) * 1.2) < 1e-5, 'fixed per day inc VAT');
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
      assert.ok(p.every((e) => /^unlicensed: tounify v3 \(preview API\)/.test(e.skipped)));
      const r = await call('POST', `/api/sites/${fr.id}/connections`, { provider: 'tounify', consumption_tariff: 'EDFTRVHPHC' });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /^tounify is listed for tariff_prices in market FR but its licence is unconfirmed: tounify v3/);
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

test('TOUNIFY_DEV=1 with a test token: the plan runs tounify (labelled), POST registers a home, the sync reads and prices it, Connectors shows the override', async () => {
  fresh();
  api.etags = false;
  clock.t = Date.UTC(2026, 10, 10, 5, 0);
  await withEnv(DEV, async () => {
    const home = createSite({ name: 'FR dev home', country: 'FR', postcode: '75008' });
    // Not registered yet: the per-home role waits for its connection (quiet); the shared catalogue may run.
    let p = P.plan(db, home).filter((e) => e.adapter === 'tounify');
    assert.deepEqual(p.map((e) => [e.role, e.run, e.skipped ?? null]), [['tariff_prices', false, 'not connected for this home'], ['tariff_catalogue', true, null]]);
    const reg = await call('POST', `/api/sites/${home.id}/connections`, { provider: 'tounify', consumption_tariff: 'EDFTRVHPHC', metering: { type: 'dual_rate', communication: 'remote' } });
    assert.equal(reg.status, 201, reg.text);
    assert.deepEqual([reg.json.reference, reg.json.role, reg.json.secrets_stored, reg.json.dev_override, reg.json.grid_resolution.operator.id], [`eb-site-${home.id}`, 'tariff_prices', false, TU.DEV_LABEL, 'ENED']);
    assert.ok(!reg.text.includes(TEST_TOKEN));
    p = P.plan(db, home).filter((e) => e.adapter === 'tounify');
    assert.deepEqual(p.map((e) => [e.step, e.run, e.dev_override]), [['tounify', true, TU.DEV_LABEL], ['tounify_catalogue', true, TU.DEV_LABEL]]);
    assert.ok(!JSON.stringify(p).includes(TEST_TOKEN), 'the token is never in a printable plan field');
    // The sync: the daily read, then the weekly catalogue, once each.
    const r = await syncSite(home.id);
    const step = r.log.find((l) => l.step === 'tounify');
    assert.equal(step.ok, true, step.error);
    assert.deepEqual([step.tariff, step.unit_rows, step.fixed_rows, step.agreed], ['TOUNIFY-FR-EDFTRVHPHC', 96, 4, true]);
    const cat = r.log.find((l) => l.step === 'tounify_catalogue');
    assert.equal(cat.ok, true, cat.error);
    assert.deepEqual([cat.properties, cat.companies, cat.tariffs], [10, 7, { EDF: 8 }], 'properties, companies, and the tariffs of the home\'s company');
    assert.deepEqual(TU.tounifyAllowance(db).companies.ids, ['EDF'], 'listing EDF\'s tariffs spent one company');
    assert.match(TU.catalogueStatus('FR').reason, /^FR: 10 properties, 7 companies/);
    // Rows first written on the override say so.
    const note = db.prepare("SELECT origin_note FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'unit' AND superseded_at IS NULL LIMIT 1").get(frTariff.id, home.id).origin_note;
    assert.equal(note, `${TU.ORIGIN_NOTE_TEST}; ${TU.DEV_LABEL}`);
    // The home's days were priced from it.
    assert.ok(count("SELECT COUNT(*) n FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND d.provider = 'tounify' AND a.superseded_at IS NULL", home.id) === 1);
    // A second sync the same day calls nothing (one read a day, one catalogue a week).
    const n = api.calls.length;
    const r2 = await syncSite(home.id);
    assert.ok(!r2.log.some((l) => l.step === 'tounify' || l.step === 'tounify_catalogue'), 'not due: not run, not logged');
    assert.equal(api.calls.length, n);
    const t = C.connectors(db).connectors.find((x) => x.adapter === 'tounify');
    assert.deepEqual([t.status, t.dev_override], ['connected', TU.DEV_LABEL]);
    // The home read today is connected; the other French homes are too through the shared catalogue's
    // status (as every GB home is through Tariffscanner's sweep); the Dutch ones have no catalogue yet.
    assert.equal(t.homes.find((h) => h.site_id === home.id).status, 'connected');
    assert.ok(t.homes.filter((h) => h.market_code === 'NL' && !h.is_demo).every((h) => h.status !== 'connected'));
    assert.deepEqual(t.markets.map((m) => m.market_code), ['FR', 'NL']);
    const allowance = await call('GET', '/api/tounify/allowance');
    assert.deepEqual([allowance.status, allowance.json.token_kind, allowance.json.dev_override], [200, 'test', TU.DEV_LABEL]);
    assert.ok(!allowance.text.includes(TEST_TOKEN));
  });
});

test('a 429 during a cycle stops the run: the next home of the cycle is not called', async () => {
  fresh();
  api.etags = false;
  clock.t = Date.UTC(2026, 10, 12, 5, 0);
  await withEnv(DEV, async () => {
    const b = createSite({ name: 'FR second', country: 'FR', postcode: '75007' });
    await TU.registerConnection(b, { consumption_tariff: 'EDFTRVHPHC' }, { client: TU.clientFor({ token: TEST_TOKEN }) });
    api.calls.length = 0;
    api.override = (x) => (x.path.endsWith('/prices') ? json(429, { statusCode: 429, error: 'Too Many Requests', message: 'limit', code: 'daily_request_limit' }, { 'retry-after': '300' }) : null);
    const [ra, rb] = await syncAll([fr.id, b.id]);
    const sa = ra.log.find((l) => l.step === 'tounify');
    assert.equal(sa.ok, false);
    assert.match(sa.error, /HTTP 429 \(daily_request_limit\): run stopped/);
    assert.ok(!rb.log.some((l) => l.step === 'tounify'), 'the second home is not run while cooling down');
    assert.deepEqual(api.calls.map((x) => x.path.split('/').pop()), ['prices'], 'one call, the one refused');
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
