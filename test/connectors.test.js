// The Connectors page and GET /api/connectors (src/core/connectors.js, public/js/connectors-view.js):
// one entry per adapter code, the registry rows of every market merged with the implementations
// registered, and a status word each, derived from the homes' latest syncs. Temp database; nothing
// here syncs, and the fetch below fails any network call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
globalThis.fetch = async (url) => { throw new Error(`no network in tests: ${url}`); };

// Stand-in secrets, set only in this test process and never printed. None of them is complete for
// any provider (no .env home, no Tariffscanner username), so every credentialed step is skipped.
const SECRETS = { OCTOPUS_API_KEY: 'sk_test_connectors_never_1', SUNSYNK_PASSWORD: 'pw_connectors_never_2', TARIFFSCAN_PASSWORD: 'ts_connectors_never_3' };
Object.assign(process.env, SECRETS);
for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_BASE_URL', 'SUNSYNK_USERNAME', 'OCTOPUS_ACCOUNT_NUMBER']) delete process.env[k];
const REF = 'A-CONNREF-0042';   // a connection's non-secret reference: never returned either

const { db } = await import('../src/db/db.js');
const P = await import('../src/core/providers.js');
const { seedProviders } = await import('../src/db/seed/providers.js');
const { createSite } = await import('../src/core/sites.js');
const { app } = await import('../src/server.js');   // registers the real adapters (src/jobs/steps.js)
const C = await import('../src/core/connectors.js');
const V = await import('../public/js/connectors-view.js');

const byAdapter = (r) => Object.fromEntries(r.connectors.map((c) => [c.adapter, c]));
const KEYS = ['adapter', 'label', 'roles', 'markets', 'scope', 'owner', 'auth', 'built', 'enabled', 'licence_confirmed', 'origin', 'note', 'status', 'reason',
  'homes_connected', 'homes_total_in_markets', 'homes_demo', 'last_success_at', 'last_error', 'last_run', 'steps', 'homes'];
const orderOk = (list) => list.every((c, i) => !i || C.CONNECTOR_STATUSES.indexOf(list[i - 1].status) <= C.CONNECTOR_STATUSES.indexOf(c.status));

const gbHome = createSite({ name: 'GB home', postcode: 'BB12 9BY' });
createSite({ name: 'FR demo', country: 'FR', isDemo: true });

test('seeds: Octopus, Sunsynk, National Gas, NESO, Open-Meteo, Quartz, Tariffscanner and tounify are built; Linky, P1 and ENTSO-E are not, with their notes', () => {
  const r = C.connectors(db);
  const by = byAdapter(r);
  for (const a of ['octopus', 'sunsynk', 'national_gas', 'neso', 'open_meteo', 'quartz', 'tariffscanner', 'geo', 'compare', 'manual']) {
    assert.equal(by[a]?.built, true, `${a} built`);
    assert.equal(by[a].origin, a === 'manual' ? 'user' : 'provider', a);
  }
  for (const a of ['linky', 'p1', 'entsoe']) {
    assert.equal(by[a]?.built, false, `${a} not built`);
    assert.equal(by[a].status, 'not_built', a);
    assert.match(by[a].note, /^adapter not built/, a);
    assert.equal(by[a].reason, by[a].note, `${a}: the planned note is the reason`);
    assert.equal(by[a].origin, 'placeholder', a);
    assert.equal(by[a].enabled, false, a);
  }
  assert.match(by.linky.note, /Linky meter data/);
  assert.match(by.p1.note, /P1 port reader/);
  // tounify v3: built, switched on in FR and NL only (an EU tariff source, not UK), its licence unconfirmed: disabled.
  assert.deepEqual([by.tounify.built, by.tounify.status, by.tounify.enabled, by.tounify.licence_confirmed, by.tounify.auth, by.tounify.origin],
    [true, 'disabled', true, false, 'credentials', 'provider']);
  assert.match(by.tounify.reason, /^unlicensed: tounify v3 \(preview API\).*licence not confirmed in writing/);
  assert.equal(by.tounify.label, 'tounify (EU tariffs, v3 preview)');
  assert.deepEqual(by.tounify.markets.map((m) => m.market_code), ['FR', 'NL']);
  assert.deepEqual(by.tounify.roles, ['tariff_prices', 'tariff_catalogue']);
  assert.ok(!('dev_override' in by.tounify), 'no development override without TOUNIFY_DEV');
  assert.deepEqual([by.entsoe.licence_confirmed, by.entsoe.auth], [true, 'credentials']);
  assert.match(by.entsoe.note, /token/);
  // Every adapter code once: the 14 the registry lists (GB 9 codes, '*' sunsynk, FR/NL linky, p1, tounify, entsoe, manual).
  assert.equal(r.connectors.length, new Set(db.prepare('SELECT adapter FROM market_provider').all().map((x) => x.adapter)).size);
  assert.equal(new Set(r.connectors.map((c) => c.adapter)).size, r.connectors.length);
  // Merged across markets and roles.
  assert.deepEqual(by.open_meteo.markets.map((m) => m.market_code), ['BE', 'DE', 'ES', 'FR', 'GB', 'NL']);
  assert.deepEqual(by.sunsynk.markets.map((m) => m.market_code), ['*']);
  assert.deepEqual(by.octopus.roles, ['meter', 'tariff_prices', 'tariff_catalogue']);
  assert.deepEqual([by.octopus.scope, by.octopus.scopes.sort(), by.octopus.auth], ['home', ['home', 'shared'], 'credentials']);
  assert.deepEqual(by.entsoe.markets.map((m) => [m.market_code, m.enabled, m.priority, m.roles[0].note === by.entsoe.note]), [['FR', false, 20, true], ['NL', false, 20, true]]);
  assert.deepEqual([by.neso.scope, by.neso.auth, by.neso.owner], ['shared', 'none', 'core']);
  assert.equal(by.octopus.label, 'Octopus Energy');
  assert.equal(by.tariffscanner.label, 'Tariffscanner (FEA)');
  // Nothing has synced: credentialed ones need credentials, the others are available.
  for (const a of ['sunsynk', 'octopus', 'tariffscanner']) assert.equal(by[a].status, 'needs_credentials', a);
  assert.match(by.tariffscanner.reason, /^no credentials: TARIFFSCAN_USERNAME not set/);
  for (const a of ['geo', 'open_meteo', 'neso', 'compare', 'quartz', 'national_gas', 'manual']) assert.equal(by[a].status, 'available', a);
  assert.match(by.manual.reason, /no home in its markets yet/, 'FR and NL hold only a demo home');
  assert.deepEqual([by.manual.homes_total_in_markets, by.manual.homes_demo], [0, 1]);
  assert.deepEqual([by.sunsynk.homes_total_in_markets, by.sunsynk.homes_demo], [1, 1], 'sunsynk is listed for every market');
  assert.deepEqual(r.summary, { error: 0, needs_credentials: 3, connected: 0, available: 7, disabled: 1, not_built: 3, total: 14 });
  assert.deepEqual(r.homes, { total: 1, demo: 1 });
  assert.ok(orderOk(r.connectors), 'problems first, then connected, available, disabled, not built');
});

// ───────────── The six statuses, from fake adapters and rows ─────────────

const row = (market_code, role, adapter, extra = {}) => ({ market_code, role, adapter, scope: 'shared', origin: 'provider', note: `${adapter}: a test row`,
  priority: 50, enabled: 1, owner: 'core', needs_credentials: 0, licence_confirmed: 1, ...extra });
const step = (name, connection = null) => ({ step: name, connection, run: () => { throw new Error('tests never run a step'); } });
const restore = [];
after(() => { for (const r of restore.reverse()) r(); });

const T1 = 1790000000;
let deHome; let deDemo; let beDemo;
// Run by the first test that needs them (top-level code runs before any test, so the GB seed test above sees none of this).
function setupFakes() {
  deHome = createSite({ name: 'DE real', country: 'DE' });
  deDemo = createSite({ name: 'DE demo', country: 'DE', isDemo: true });
  beDemo = createSite({ name: 'BE demo', country: 'BE', isDemo: true });
  seedProviders(db, [
    row('DE', 'meter', 'fake_ok', { scope: 'home' }),
    row('DE', 'carbon', 'fake_err'),
    row('DE', 'solar_forecast', 'fake_cred', { needs_credentials: 1 }),
    row('DE', 'gas_cv', 'fake_avail', { scope: 'home' }),
    row('DE', 'location', 'fake_unlic', { licence_confirmed: 0, note: 'the licence to serve its data to many homes is unconfirmed (test)' }),
    row('DE', 'compare', 'fake_off', { enabled: 0, note: 'switched off by the operator (test)' }),
    row('DE', 'tariff_prices', 'fake_planned', { enabled: 0, origin: 'placeholder', note: 'adapter not built: a planned price source (test)' }),
    row('DE', 'tariff_catalogue', 'fake_ext', { owner: 'external', note: 'another process owns its rate budget (test)' }),
    row('BE', 'meter', 'fake_demo', { scope: 'home' }),
  ]);
  restore.push(
    P.registerAdapter('fake_ok', { connection: 'fake_ok_conn', roles: { meter: [step('fake_ok_step', 'fake_ok_conn')] } }),
    P.registerAdapter('fake_err', { roles: { carbon: [step('fake_err_step', 'fake_err_conn')] } }),
    P.registerAdapter('fake_cred', { credentials: () => ({ missing: 'no credentials: FAKE_TOKEN not set (test)' }), roles: { solar_forecast: [step('fake_cred_step', 'fake_cred_conn')] } }),
    P.registerAdapter('fake_avail', { connection: 'fake_avail_conn', roles: { gas_cv: [step('fake_avail_step', 'fake_avail_conn')] } }),
    P.registerAdapter('fake_unlic', { roles: { location: [step('fake_unlic_step')] } }),
    P.registerAdapter('fake_off', { roles: { compare: [step('fake_off_step')] } }),
    P.registerAdapter('fake_ext', { roles: { tariff_catalogue: [step('fake_ext_step')] } }),
    P.registerAdapter('fake_demo', { connection: 'fake_demo_conn', roles: { meter: [step('fake_demo_step', 'fake_demo_conn')] } }),
    P.registerAdapter('fake_unlisted', { roles: { weather: [step('fake_unlisted_step')] } }),
  );
  const conn = (site, provider, status, last, err = null, ref = null) => db.prepare(`INSERT INTO connection (site_id, provider, external_ref, status, last_success_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?)`).run(site.id, provider, ref, status, last, err);
  conn(deHome, 'fake_ok_conn', 'ok', T1, null, REF);
  conn(deHome, 'fake_err_conn', 'error', T1 - 3600, `HTTP 503 upstream down (key ${SECRETS.OCTOPUS_API_KEY})`);
  // Demo homes are never synced; rows written here by hand must still never count as connected.
  conn(deDemo, 'fake_ok_conn', 'ok', T1 + 60);
  conn(beDemo, 'fake_demo_conn', 'ok', T1 + 60);
  const run = (site, at, detail) => db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status, detail) VALUES (?, ?, ?, 'partial', ?)").run(site.id, at, at + 5, JSON.stringify(detail));
  run(deHome, T1 + 100, [
    { step: 'fake_ok_step', ok: true, ms: 4 },
    { step: 'fake_err_step', ok: false, ms: 9, error: `HTTP 503 upstream down (key ${SECRETS.OCTOPUS_API_KEY})` },
    { step: 'fake_cred_step', ok: true, ms: 0, skipped: 'no credentials: FAKE_TOKEN not set (test)' },
    { step: 'build', ok: true, ms: 1 },
  ]);
  run(deDemo, T1 + 200, [{ step: 'fake_ok_step', ok: true, ms: 1 }]);
  run(beDemo, T1 + 200, [{ step: 'fake_demo_step', ok: true, ms: 1 }]);
}

test('status: each of the six derived from rows, implementations and the latest syncs', () => {
  setupFakes();
  const r = C.connectors(db);
  const by = byAdapter(r);
  // connected: built, switched on, the latest run worked for a real home.
  assert.deepEqual([by.fake_ok.status, by.fake_ok.homes_connected, by.fake_ok.homes_total_in_markets, by.fake_ok.homes_demo], ['connected', 1, 1, 1]);
  assert.equal(by.fake_ok.last_success_at, T1 + 100, 'the latest successful run');
  assert.deepEqual(by.fake_ok.last_run, { site_id: deHome.id, at: T1 + 100, steps: [{ step: 'fake_ok_step', ok: true }] });
  assert.deepEqual(by.fake_ok.homes.map((h) => [h.name, h.status, h.is_demo]), [['DE real', 'connected', false], ['DE demo', 'demo', true]]);
  assert.deepEqual([by.fake_ok.scope, by.fake_ok.auth, by.fake_ok.steps], ['home', 'none', ['fake_ok_step']]);
  // error: the latest step failed; the text is kept, the secret in it is not.
  assert.equal(by.fake_err.status, 'error');
  assert.equal(by.fake_err.last_error, 'HTTP 503 upstream down (key [redacted])');
  assert.equal(by.fake_err.reason, by.fake_err.last_error);
  assert.deepEqual([by.fake_err.homes_error, by.fake_err.homes_connected, by.fake_err.last_error_at], [1, 0, T1 + 100]);
  assert.equal(by.fake_err.last_run.steps[0].error, 'HTTP 503 upstream down (key [redacted])');
  // needs_credentials: built, switched on, needs credentials, no home has them.
  assert.deepEqual([by.fake_cred.status, by.fake_cred.auth, by.fake_cred.reason], ['needs_credentials', 'credentials', 'no credentials: FAKE_TOKEN not set (test)']);
  assert.deepEqual(by.fake_cred.homes.filter((h) => !h.is_demo).map((h) => h.status), ['needs_credentials']);
  // available: built, switched on, per home, no home connected yet.
  assert.deepEqual([by.fake_avail.status, by.fake_avail.homes_connected], ['available', 0]);
  assert.match(by.fake_avail.reason, /no home is connected yet/);
  assert.equal(by.fake_avail.homes.find((h) => !h.is_demo).status, 'not_connected');
  // disabled: built, but unlicensed, switched off, owned by another process, or listed nowhere.
  assert.deepEqual([by.fake_unlic.status, by.fake_unlic.licence_confirmed, by.fake_unlic.enabled], ['disabled', false, true]);
  assert.equal(by.fake_unlic.reason, 'unlicensed: the licence to serve its data to many homes is unconfirmed (test)');
  assert.deepEqual([by.fake_off.status, by.fake_off.reason, by.fake_off.enabled], ['disabled', 'disabled: switched off by the operator (test)', false]);
  assert.deepEqual([by.fake_ext.status, by.fake_ext.owner], ['disabled', 'external']);
  assert.match(by.fake_ext.reason, /^fake_ext is owned by another process: the core must not call it/);
  assert.deepEqual([by.fake_unlisted.status, by.fake_unlisted.reason, by.fake_unlisted.roles, by.fake_unlisted.markets], ['disabled', 'not listed in any market: the registry never runs it', ['weather'], []]);
  // not_built: a registry row with no implementation, its planned note as the reason.
  assert.deepEqual([by.fake_planned.status, by.fake_planned.built, by.fake_planned.reason], ['not_built', false, 'adapter not built: a planned price source (test)']);
  // Every status of the six is reached; the summary counts them.
  for (const s of C.CONNECTOR_STATUSES) assert.ok(r.connectors.some((c) => c.status === s), s);
  for (const s of C.CONNECTOR_STATUSES) assert.equal(r.summary[s], r.connectors.filter((c) => c.status === s).length, s);
  assert.equal(r.summary.total, r.connectors.length);
  assert.ok(orderOk(r.connectors));
  for (const c of r.connectors) for (const k of KEYS) assert.ok(k in c, `${c.adapter}.${k}`);
});

test('demo homes are never counted as connected, even with an ok connection row and log', () => {
  const by = byAdapter(C.connectors(db));
  assert.deepEqual([by.fake_demo.status, by.fake_demo.homes_connected, by.fake_demo.homes_total_in_markets, by.fake_demo.homes_demo], ['available', 0, 0, 1]);
  assert.equal(by.fake_demo.last_success_at, null);
  assert.equal(by.fake_demo.last_run, null);
  assert.deepEqual(by.fake_demo.homes.map((h) => [h.site_id, h.status, h.reason]), [[beDemo.id, 'demo', C.DEMO_REASON]]);
  // The DE demo home's ok row and log leave fake_ok at one home connected, the real one.
  assert.equal(by.fake_ok.homes_connected, 1);
  assert.equal(by.fake_ok.last_success_at, T1 + 100, 'not the demo home\'s later success');
});

test('a connector served by the core\'s own status hook (Tariffscanner\'s sweep) is connected from its state, or failing from it', () => {
  const put = (state) => db.prepare(`INSERT INTO provider_state (provider, state, updated_at) VALUES ('tariffscanner', ?, 1)
    ON CONFLICT (provider) DO UPDATE SET state = excluded.state`).run(JSON.stringify(state));
  put({ last_ok_at: (T1 + 50) * 1000, last_run_at: (T1 + 40) * 1000, last_summary: 'complete full sweep' });
  let ts = byAdapter(C.connectors(db)).tariffscanner;
  assert.deepEqual([ts.status, ts.homes_connected, ts.homes_total_in_markets], ['connected', 1, 1]);
  assert.match(ts.warning, /^the next sync skips it for 1 of 1 home: no credentials: TARIFFSCAN_USERNAME not set/);
  assert.match(ts.homes[0].next, /^no credentials/);
  put({ last_ok_at: (T1 + 50) * 1000, last_error: 'HTTP 401 (auth failed)', last_error_at: (T1 + 90) * 1000 });
  ts = byAdapter(C.connectors(db)).tariffscanner;
  assert.deepEqual([ts.status, ts.last_error], ['error', 'HTTP 401 (auth failed)']);
  db.prepare("DELETE FROM provider_state WHERE provider = 'tariffscanner'").run();
  assert.equal(byAdapter(C.connectors(db)).tariffscanner.status, 'needs_credentials');
});

// ───────────── API ─────────────

const server = app.listen(0);
after(() => server.close());
const http = (await import('node:http')).default;
// The test's fetch refuses the network, so the API is called with node:http.
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${server.address().port}${p}`, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
  }).on('error', reject);
});

test('GET /api/connectors: no home needed, every connector with a status word, summary counts, and no credential anywhere', async () => {
  const r = await get('/api/connectors');
  assert.equal(r.status, 200);
  for (const v of [...Object.values(SECRETS), REF]) assert.ok(!r.text.includes(v), 'no secret or connection reference in /api/connectors');
  assert.ok(!r.text.includes('external_ref'));
  assert.ok(r.text.includes('[redacted]'), 'the secret inside an error text was cleaned');
  assert.deepEqual(Object.keys(r.json).sort(), ['connectors', 'generated_at', 'homes', 'statuses', 'summary']);
  assert.deepEqual(r.json.statuses, [...C.CONNECTOR_STATUSES]);
  assert.equal(r.json.summary.total, r.json.connectors.length);
  for (const s of C.CONNECTOR_STATUSES) assert.equal(r.json.summary[s], r.json.connectors.filter((c) => c.status === s).length, s);
  assert.ok(orderOk(r.json.connectors));
  for (const c of r.json.connectors) {
    assert.ok(C.CONNECTOR_STATUSES.includes(c.status), `${c.adapter} ${c.status}`);
    assert.ok(['none', 'credentials'].includes(c.auth), c.adapter);
    assert.ok(!('auth_note' in c), 'the registry records no auth text');
  }
  assert.deepEqual(r.json.homes, { total: 2, demo: 3 });
  // Existing endpoints are unchanged by it.
  const sites = await get('/api/sites');
  assert.equal(sites.status, 200);
  assert.ok(sites.json.every((s) => Array.isArray(s.providers) && !('connectors' in s)));
});

// ───────────── Page ─────────────

test('page: linked in the navigation as Connectors, served at /connectors, its script present', async () => {
  const root = path.resolve(import.meta.dirname, '..', 'public');
  assert.match(fs.readFileSync(path.join(root, 'js', 'layout.js'), 'utf8'), /\['connectors', 'Connectors', '\/connectors'\]/);
  assert.match(fs.readFileSync(path.join(root, 'connectors.html'), 'utf8'), /<script type="module" src="\/js\/pages\/connectors\.js"><\/script>/);
  assert.ok(fs.existsSync(path.join(root, 'js', 'pages', 'connectors.js')));
  const page = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/connectors`, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, t }));
  }).on('error', reject));
  assert.equal(page.status, 200);
  assert.match(page.t, /<title>EnergieBee Connectors<\/title>/);
});

test('views: every API text is escaped, every status is a word, the planned line and legend are there', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const c = {
    adapter: 'x<y', label: `Bad ${evil}`, roles: ['meter', `r${evil}`], scope: 'home', scopes: ['home'], auth: 'credentials', built: true, enabled: true,
    licence_confirmed: true, origin: 'provider', note: `note ${evil}`, status: 'error', reason: `boom ${evil}`, last_error: `boom ${evil}`,
    homes_connected: 0, homes_error: 1, homes_total_in_markets: 1, homes_demo: 1, last_success_at: 1790000000, last_run: { steps: [{ step: `s${evil}` }] },
    markets: [{ market_code: `G${evil}`, enabled: true, licence_confirmed: true, priority: 10, roles: [{ role: 'meter', priority: 10, enabled: true, licence_confirmed: true, needs_credentials: true, scope: 'home', note: `row ${evil}` }] }],
    homes: [{ site_id: 1, name: `Home ${evil}`, market_code: 'GB', is_demo: false, status: 'error', reason: `why ${evil}`, next: `next ${evil}` },
      { site_id: 2, name: 'Demo', market_code: 'FR', is_demo: true, status: 'demo', reason: 'demo home' }],
  };
  const html = V.groupsHtml([c]) + V.filtersHtml([c], {}) + V.summaryChips({ error: 1, total: 1 }, 'error') + V.legendHtml([c]);
  assert.ok(!html.includes('<img'), 'no raw markup from the API');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // Escaped text may say "onerror=" inside a quoted title; no tag may carry it as an attribute.
  assert.ok(!/<[a-z]+[^>]*\sonerror=/i.test(html.replace(/"[^"]*"/g, '""')), 'no live handler attribute');
  for (const s of V.STATUS_ORDER) {
    const card = V.connectorCard({ ...c, label: 'L', status: s, warning: null });
    assert.ok(card.includes(`>${V.CONNECTOR_STATUS[s][1]}</span>`), `${s}: the status word is on the badge`);
  }
  assert.ok(V.legendHtml([c]).includes(V.PLANNED_LINE));
  assert.equal(V.PLANNED_LINE, 'Planned adapters (not built) are listed so gaps are visible; the registry decides what runs.');
  assert.ok(V.homesNote({ total: 1, demo: 2 }).includes('2 demo homes'));
  // Filters: a connector listed for every market ('*') matches any market.
  const list = [{ status: 'connected', roles: ['inverter'], markets: [{ market_code: '*' }] }, { status: 'not_built', roles: ['meter'], markets: [{ market_code: 'FR' }] }];
  assert.equal(V.applyFilters(list, { market: 'NL' }).length, 1);
  assert.equal(V.applyFilters(list, { market: 'FR' }).length, 2);
  assert.equal(V.applyFilters(list, { status: 'not_built', role: 'meter' }).length, 1);
  assert.deepEqual(V.filterOptions(list), { roles: ['inverter', 'meter'], markets: ['FR'] });
});
