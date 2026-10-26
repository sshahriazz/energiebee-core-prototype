// The market provider registry (delta 008, src/db/seed/providers.js, src/core/providers.js): the
// seed per market, each home's plan from it with the real step implementations (src/jobs/steps.js),
// the status per role on /api/sites, and POST /api/sites/:id/connections. Temp database; nothing
// here syncs, and the fetch below fails any network call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const calls = [];
globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error(`no network in tests: ${url}`); };

// Stand-in credentials, set only in this test process and never printed.
const SECRETS = { OCTOPUS_API_KEY: 'sk_test_never_stored_1', OCTOPUS_ACCOUNT_NUMBER: 'A-TEST0001', SUNSYNK_USERNAME: 'owner@example.test', SUNSYNK_PASSWORD: 'pw_never_stored_2' };
Object.assign(process.env, SECRETS, { IMPORT_TARIFF_CODE: 'E-1R-AGILE-24-10-01-G', SITE_NAME: 'Env home', SITE_POSTCODE: 'BB12 9BY' });
// The Tariffscanner catalogue has its own tests (tariffscanner.test.js); here it has no credential.
for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD', 'TARIFFSCAN_BASE_URL']) delete process.env[k];

const { db } = await import('../src/db/db.js');
const { ensureEnvSite } = await import('../src/jobs/sync.js');
const P = await import('../src/core/providers.js');
const { PROVIDERS } = await import('../src/db/seed/providers.js');
const { ORIGINS } = await import('../src/core/provenance.js');
const { createSite } = await import('../src/core/sites.js');
const { app } = await import('../src/server.js');

const conn = (siteId, ...providers) => { for (const p of providers) db.prepare('INSERT OR IGNORE INTO connection (site_id, provider) VALUES (?, ?)').run(siteId, p); };
const runSteps = (site) => P.plan(db, site).filter((e) => e.run).map((e) => e.step);
const rowsOf = (market) => db.prepare("SELECT * FROM market_provider WHERE market_code = ? ORDER BY role, priority, adapter").all(market).map((r) => ({ ...r }));

// The steps src/jobs/sync.js called, in this order, before the registry (git e0a43c0): the Octopus
// account first only for a home without a postcode; gas_cv only once a gas meter is known (checked
// when it runs); tariff only with tariff codes in .env.
const TODAY_GB = ['sunsynk', 'geo', 'weather', 'carbon', 'octopus', 'gas_cv', 'tariff', 'compare', 'solar_forecast'];
const TODAY_CONNECTIONS = ['sunsynk', null, 'weather', 'carbon', 'octopus', 'gas_cv', 'tariff', 'compare', 'solar_forecast'];

test('registry seed: GB lists exactly the providers synced before, FR and NL the planned ones, honestly', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider').get().n, PROVIDERS.length);
  for (const r of db.prepare('SELECT * FROM market_provider').all()) {
    assert.ok(ORIGINS.includes(r.origin), `${r.market_code}/${r.role}/${r.adapter} origin`);
    assert.ok(r.note, `${r.market_code}/${r.role}/${r.adapter} has a note`);
  }
  const gb = rowsOf('GB').map((r) => [r.role, r.adapter, r.scope, r.enabled, r.needs_credentials]);
  assert.deepEqual(gb, [
    ['carbon', 'neso', 'shared', 1, 0], ['compare', 'compare', 'shared', 1, 0], ['gas_cv', 'national_gas', 'shared', 1, 0],
    ['location', 'geo', 'shared', 1, 0], ['meter', 'octopus', 'home', 1, 1], ['solar_forecast', 'quartz', 'shared', 1, 0],
    ['tariff_catalogue', 'octopus', 'shared', 1, 0], ['tariff_catalogue', 'tariffscanner', 'shared', 1, 1],
    ['tariff_prices', 'octopus', 'shared', 1, 0], ['weather', 'open_meteo', 'shared', 1, 0],
  ]);
  assert.ok(rowsOf('GB').every((r) => r.origin === 'provider' && r.owner === 'core' && r.licence_confirmed === 1));
  // Inverters do not depend on the country.
  assert.deepEqual(rowsOf('*').map((r) => [r.role, r.adapter, r.scope, r.enabled, r.needs_credentials]), [['inverter', 'sunsynk', 'home', 1, 1]]);
  for (const [m, meter] of [['FR', 'linky'], ['NL', 'p1']]) {
    const by = Object.fromEntries(rowsOf(m).map((r) => [`${r.role}/${r.adapter}`, r]));
    assert.deepEqual(Object.keys(by).sort(), ['meter/' + meter, 'tariff_catalogue/tounify', 'tariff_prices/entsoe', 'tariff_prices/manual', 'tariff_prices/tounify', 'weather/open_meteo'].sort(), m);
    assert.equal(by['weather/open_meteo'].enabled, 1);
    assert.equal(by[`meter/${meter}`].enabled, 0);
    assert.match(by[`meter/${meter}`].note, /^adapter not built/);
    assert.equal(by[`meter/${meter}`].origin, 'placeholder');
    // tounify v3 is built (src/adapters/tounify.js): switched on, its licence unconfirmed, prices per home, catalogue shared.
    for (const [role, scope] of [['tariff_prices', 'home'], ['tariff_catalogue', 'shared']]) {
      const t = by[`${role}/tounify`];
      assert.deepEqual([t.enabled, t.licence_confirmed, t.needs_credentials, t.scope, t.origin], [1, 0, 1, scope, 'provider'], `${m} ${role}`);
      assert.match(t.note, /licence not confirmed in writing/);
    }
    assert.deepEqual([by['tariff_prices/entsoe'].enabled, by['tariff_prices/entsoe'].needs_credentials], [0, 1]);
    assert.match(by['tariff_prices/entsoe'].note, /token/);
    assert.deepEqual([by['tariff_prices/manual'].enabled, by['tariff_prices/manual'].origin], [1, 'user']);
    assert.equal(P.providersFor(db, m, 'carbon').length, 0, `${m}: no carbon provider`);
  }
  for (const m of ['DE', 'BE', 'ES']) assert.deepEqual(rowsOf(m).map((r) => [r.role, r.adapter, r.enabled]), [['weather', 'open_meteo', 1]], m);
  // providersFor: the market's own rows and the '*' ones, in priority order.
  assert.deepEqual(P.providersFor(db, 'FR', 'tariff_prices').map((r) => r.adapter), ['tounify', 'entsoe', 'manual']);
  assert.deepEqual(P.providersFor(db, 'NL', 'inverter').map((r) => [r.market_code, r.adapter]), [['*', 'sunsynk']]);
});

test('the seed keeps an operator\'s switches and refreshes the descriptions', async () => {
  const { seedProviders } = await import('../src/db/seed/providers.js');
  db.prepare("UPDATE market_provider SET enabled = 0, note = 'edited' WHERE market_code = 'GB' AND role = 'carbon'").run();
  seedProviders(db);
  const r = db.prepare("SELECT enabled, note FROM market_provider WHERE market_code = 'GB' AND role = 'carbon'").get();
  assert.equal(r.enabled, 0, 'switch kept');
  assert.match(r.note, /^NESO/, 'note refreshed');
  db.prepare("UPDATE market_provider SET enabled = 1 WHERE market_code = 'GB' AND role = 'carbon'").run();
});

let envHome;
test('the .env home is created as before, with the same connections, and its plan is today\'s step list', () => {
  const id = ensureEnvSite();
  envHome = db.prepare('SELECT * FROM site WHERE id = ?').get(id);
  assert.deepEqual([envHome.env_key, envHome.market_code, envHome.country, envHome.currency, envHome.slot_s], ['env', 'GB', 'GB', 'GBP', 1800]);
  const providers = db.prepare('SELECT provider, external_ref FROM connection WHERE site_id = ? ORDER BY provider').all(id).map((c) => [c.provider, c.external_ref]);
  assert.deepEqual(providers, [['carbon', null], ['compare', null], ['octopus', SECRETS.OCTOPUS_ACCOUNT_NUMBER], ['solar_forecast', null], ['sunsynk', null], ['tariff', null], ['weather', null]]);
  const p = P.plan(db, envHome);
  assert.deepEqual(p.filter((e) => e.run).map((e) => e.step), TODAY_GB);
  assert.deepEqual(p.filter((e) => e.run).map((e) => e.connection), TODAY_CONNECTIONS);
  assert.deepEqual(p.filter((e) => !e.run && e.log), [], 'nothing extra in the sync log of the GB home');
  // Without a postcode the Octopus account is read first, for the supply address.
  assert.deepEqual(runSteps({ ...envHome, postcode: null }), ['octopus', ...TODAY_GB]);
  // The credentials go to the steps, never into the plan's printable fields.
  assert.ok(!JSON.stringify(p).includes(SECRETS.OCTOPUS_API_KEY) && !JSON.stringify(p).includes(SECRETS.SUNSYNK_PASSWORD));
  assert.equal(p.find((e) => e.step === 'octopus').creds.apiKey, SECRETS.OCTOPUS_API_KEY);
});

test('a GB home with no account or inverter runs only the shared steps, as before', () => {
  const s = createSite({ name: 'GB shared only', postcode: 'L1 8JQ' });
  assert.deepEqual(runSteps(s), ['geo', 'weather', 'carbon', 'gas_cv', 'compare', 'solar_forecast']);
});

test('a French home: weather only, with the unbuilt and unlicensed providers listed as skipped', () => {
  const fr = createSite({ name: 'Maison', country: 'FR', lat: 48.85, lon: 2.35 });
  const p = P.plan(db, fr);
  assert.deepEqual(p.filter((e) => e.run).map((e) => e.step), ['weather']);
  const logged = Object.fromEntries(p.filter((e) => !e.run && e.log).map((e) => [e.step, e.skipped]));
  assert.deepEqual(Object.keys(logged).sort(), ['meter:linky', 'tariff_prices:entsoe', 'tounify', 'tounify_catalogue']);
  assert.match(logged['meter:linky'], /^disabled: adapter not built/);
  // tounify is built and switched on, but its licence is unconfirmed: skipped, prices and catalogue alike.
  assert.match(logged.tounify, /^unlicensed: tounify v3 \(preview API\)/);
  assert.match(logged.tounify_catalogue, /^unlicensed: tounify v3 \(preview API\)/);
  assert.match(logged['tariff_prices:entsoe'], /^disabled: adapter not built.*token/);
  const quiet = p.filter((e) => !e.run && !e.log).map((e) => [e.step, e.skipped]);
  assert.deepEqual(quiet, [['sunsynk', 'not connected for this home'], ['tariff_prices:manual', 'typed in by the user or installer: nothing to fetch']]);
  // A licence that is still unconfirmed skips the provider although it is switched on.
  assert.match(P.plan(db, fr).find((e) => e.adapter === 'tounify').skipped, /^unlicensed: /);
});

test('a disabled provider is skipped with its reason and the next one by priority is used', () => {
  const restore = P.registerAdapter('better_weather', { roles: { weather: [{ step: 'weather', order: 30, connection: 'weather', run: async () => ({}) }] } });
  db.prepare("INSERT INTO market_provider (market_code, role, adapter, priority, enabled, scope, origin, note) VALUES ('GB', 'weather', 'better_weather', 1, 0, 'shared', 'provider', 'switched off for a test')").run();
  const p = P.plan(db, envHome).filter((e) => e.role === 'weather');
  assert.deepEqual(p.map((e) => [e.adapter, e.run, e.skipped ?? null]), [['better_weather', false, 'disabled: switched off for a test'], ['open_meteo', true, null]]);
  db.prepare("UPDATE market_provider SET enabled = 1 WHERE adapter = 'better_weather'").run();
  const q = P.plan(db, envHome).filter((e) => e.role === 'weather');
  assert.deepEqual(q.map((e) => [e.adapter, e.run, e.skipped ?? null]), [['better_weather', true, null], ['open_meteo', false, 'fallback: better_weather is used']]);
  db.prepare("DELETE FROM market_provider WHERE adapter = 'better_weather'").run();
  restore();
});

test('assertOwner still stops the core calling a provider another process owns', () => {
  let called = 0;
  const restore = P.registerAdapter('remote_catalogue', { owner: 'external', roles: { tariff_catalogue: [{ step: 'remote_catalogue', run: async () => { called++; return {}; } }] } });
  db.prepare("INSERT INTO market_provider (market_code, role, adapter, priority, owner, scope, origin, note) VALUES ('GB', 'tariff_catalogue', 'remote_catalogue', 1, 'external', 'shared', 'provider', 'a catalogue another process syncs')").run();
  let e = P.plan(db, envHome).find((x) => x.adapter === 'remote_catalogue');
  assert.equal(e.run, false);
  assert.equal(e.log, true);
  assert.match(e.skipped, /^remote_catalogue is owned by another process: the core must not call it/);
  // The registry row cannot override the implementation's owner either.
  db.prepare("UPDATE market_provider SET owner = 'core' WHERE adapter = 'remote_catalogue'").run();
  e = P.plan(db, envHome).find((x) => x.adapter === 'remote_catalogue');
  assert.match(e.skipped, /owned by another process/);
  // Only the two owner values are accepted (delta 010).
  assert.throws(() => db.prepare("UPDATE market_provider SET owner = 'someone_else' WHERE adapter = 'remote_catalogue'").run(), /CHECK/);
  assert.equal(called, 0);
  db.prepare("DELETE FROM market_provider WHERE adapter = 'remote_catalogue'").run();
  restore();
});

test('missing credentials skip the step in the plan, with the variables named and no value', () => {
  const saved = { key: process.env.OCTOPUS_API_KEY, pw: process.env.SUNSYNK_PASSWORD };
  delete process.env.OCTOPUS_API_KEY;
  delete process.env.SUNSYNK_PASSWORD;
  const p = P.plan(db, envHome);
  const skip = Object.fromEntries(p.filter((e) => !e.run && e.log).map((e) => [e.step, e.skipped]));
  assert.equal(skip.octopus, 'no credentials: OCTOPUS_API_KEY not set (start the server with --env-file=.env)');
  assert.equal(skip.sunsynk, 'no credentials: SUNSYNK_PASSWORD not set (start the server with --env-file=.env)');
  assert.ok(!p.some((e) => e.run && ['octopus', 'sunsynk'].includes(e.step)));
  process.env.OCTOPUS_API_KEY = saved.key;
  process.env.SUNSYNK_PASSWORD = saved.pw;
  // Another home never reads the .env secrets: there is no secret store for it.
  const other = createSite({ name: 'Second GB home', postcode: 'M1 1AE' });
  conn(other.id, 'octopus');
  assert.match(P.plan(db, other).find((e) => e.step === 'octopus').skipped, /^no credentials: secrets are read from \.env for the \.env home only/);
});

// ───────────── API ─────────────
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const realFetch = (await import('node:http')).default;
// The test's fetch refuses the network, so the API is called with node:http.
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = realFetch.request(`${base()}${path}`, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('/api/sites: every home lists a provider per role with a status word, and no credential', async () => {
  db.prepare("INSERT INTO sync_run (site_id, started_at, finished_at, status, detail) VALUES (?, 1, 2, 'partial', ?)").run(envHome.id, JSON.stringify([
    { step: 'sunsynk', ok: true, ms: 5 }, { step: 'geo', ok: true }, { step: 'weather', ok: true }, { step: 'carbon', ok: false, error: 'HTTP 503' },
    { step: 'octopus', ok: true, ms: 0, skipped: 'no credentials: OCTOPUS_API_KEY not set' }, { step: 'tariff', ok: true, skipped: 'using Octopus account agreements' },
    { step: 'compare', ok: true, shared: 'fetched for home 9 earlier in this cycle (compare:GB:G)' }, { step: 'solar_forecast', ok: true, skipped: 'panel size, tilt or direction unknown' },
  ]));
  const r = await call('GET', '/api/sites');
  assert.equal(r.status, 200);
  for (const v of Object.values(SECRETS).filter((x) => x !== SECRETS.OCTOPUS_ACCOUNT_NUMBER)) assert.ok(!r.text.includes(v), 'no secret in /api/sites');
  for (const s of r.json) {
    assert.deepEqual(s.providers.map((x) => x.role), P.ROLE_CODES, s.name);
    for (const x of s.providers) {
      assert.ok(P.STATUSES.includes(x.status), `${s.name} ${x.role} ${x.status}`);
      for (const k of ['role', 'adapter', 'status', 'origin', 'note', 'scope']) assert.ok(k in x, `${x.role}.${k}`);
    }
  }
  const env = Object.fromEntries(r.json.find((s) => s.id === envHome.id).providers.map((x) => [x.role, [x.adapter, x.status, x.reason]]));
  assert.deepEqual(env.inverter, ['sunsynk', 'ok', null]);
  assert.deepEqual(env.carbon, ['neso', 'error', 'HTTP 503']);
  assert.deepEqual(env.meter, ['octopus', 'skipped', 'no credentials: OCTOPUS_API_KEY not set']);
  assert.deepEqual(env.tariff_prices, ['octopus', 'skipped', 'using Octopus account agreements']);
  assert.deepEqual(env.tariff_catalogue, ['octopus', 'ok', 'fetched for home 9 earlier in this cycle (compare:GB:G)']);
  assert.deepEqual(env.gas_cv, ['national_gas', 'skipped', 'runs once the home has a gas meter']);
  assert.deepEqual(env.solar_forecast, ['quartz', 'skipped', 'panel size, tilt or direction unknown']);
  const fr = Object.fromEntries(r.json.find((s) => s.name === 'Maison').providers.map((x) => [x.role, x]));
  assert.deepEqual([fr.carbon.status, fr.carbon.adapter, fr.carbon.note], ['none', null, P.NO_PROVIDER]);
  assert.deepEqual([fr.meter.status, fr.meter.adapter], ['disabled', 'linky']);
  assert.deepEqual([fr.tariff_prices.adapter, fr.tariff_prices.status, fr.tariff_prices.origin], ['manual', 'skipped', 'user']);
  assert.deepEqual(fr.tariff_prices.alternatives.map((a) => [a.adapter, a.status]), [['tounify', 'disabled'], ['entsoe', 'disabled']]);
  assert.deepEqual([fr.inverter.status, fr.inverter.reason], ['skipped', 'not connected for this home']);
});

test('POST connections: allowed for the market, stored without secrets; refused otherwise with a clear message', async () => {
  const gb = createSite({ name: 'GB to connect', postcode: 'SW1A 1AA' });
  const fr = db.prepare("SELECT * FROM site WHERE name = 'Maison'").get();
  let r = await call('POST', `/api/sites/${gb.id}/connections`, { provider: 'octopus', credentials: { accountNumber: 'A-ABC123', apiKey: 'sk_live_must_not_be_kept' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.role, r.json.connection.provider, r.json.connection.external_ref, r.json.secrets_stored], ['meter', 'octopus', 'A-ABC123', false]);
  assert.deepEqual(r.json.not_stored, ['apiKey']);
  assert.match(r.json.credentials_note, /no secret store/);
  assert.ok(!r.text.includes('sk_live_must_not_be_kept'));
  const row = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'octopus'").get(gb.id);
  assert.ok(!JSON.stringify(row).includes('sk_live_must_not_be_kept'), 'the secret is not in the database');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM market_provider').all()).includes('sk_live'), 'nor in the registry');
  r = await call('POST', `/api/sites/${gb.id}/connections`, { provider: 'octopus' });
  assert.equal(r.status, 200);
  assert.equal(r.json.connection.external_ref, 'A-ABC123', 'a second call keeps the reference');
  // The home's plan now has the meter, skipped for want of credentials (it is not the .env home).
  assert.match(P.plan(db, gb).find((e) => e.step === 'octopus').skipped, /^no credentials/);
  // Inverters connect in any market.
  r = await call('POST', `/api/sites/${fr.id}/connections`, { provider: 'sunsynk', credentials: { plantId: '12345', password: 'x' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.role, r.json.connection.external_ref, r.json.not_stored], ['inverter', '12345', ['password']]);
  for (const [site, body, re] of [
    [fr, { provider: 'octopus' }, /^octopus is not a provider for market FR; connections allowed for a home in market FR: sunsynk \(inverter\)$/],
    [fr, { provider: 'linky' }, /^linky is listed for meter in market FR but disabled: adapter not built/],
    [gb, { provider: 'open_meteo' }, /^open_meteo serves weather in market GB, a shared role: it runs for every home of the market and needs no connection$/],
    [fr, { provider: 'manual' }, /^manual needs no connection/],
    [gb, { provider: 'octopus', role: 'inverter' }, /^octopus is not a provider for market GB in role inverter/],
    [gb, {}, /^provider is required/],
  ]) {
    r = await call('POST', `/api/sites/${site.id}/connections`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
  const demo = createSite({ name: 'Demo', isDemo: true });
  r = await call('POST', `/api/sites/${demo.id}/connections`, { provider: 'sunsynk' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^demo home/);
  r = await call('POST', '/api/sites/99999/connections', { provider: 'sunsynk' });
  assert.equal(r.status, 404);
});

test('the .env home takes its market from SITE_COUNTRY and only the connections that market allows', () => {
  db.prepare("DELETE FROM site WHERE env_key = 'env'").run();
  process.env.SITE_COUNTRY = 'FR';
  const id = ensureEnvSite();
  delete process.env.SITE_COUNTRY;
  const s = db.prepare('SELECT * FROM site WHERE id = ?').get(id);
  assert.deepEqual([s.market_code, s.currency, s.timezone], ['FR', 'EUR', 'Europe/Paris']);
  assert.deepEqual(db.prepare('SELECT provider FROM connection WHERE site_id = ? ORDER BY provider').all(id).map((c) => c.provider), ['sunsynk', 'weather']);
  assert.deepEqual(calls, [], 'no network call anywhere in this file');
});
