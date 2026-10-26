// The sync job driven by the market provider registry: the real steps (src/jobs/steps.js) run
// against a canned fetch (no network: every request is answered here or refused and recorded), and
// fake adapters stand in where a provider must fail or must not be called. Temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const calls = [];
const unexpected = [];
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push({ host: u.host, path: u.pathname, url: String(url) });
  if (u.host === 'api.carbonintensity.org.uk' && u.pathname.startsWith('/regional/intensity/')) return json({ data: [{ regionid: 3, data: [] }] });
  if (u.host === 'api.open-meteo.com') return json({ hourly: { time: [] } });
  if (u.host === 'api.octopus.energy' && u.pathname === '/v1/products/') return json({ results: [] });
  if (u.host === 'api.octopus.energy' && /\/(standard-unit-rates|standing-charges|day-unit-rates|night-unit-rates)\/$/.test(u.pathname)) return json({ results: [], next: null });
  unexpected.push(String(url));
  return new Response('{}', { status: 418 });   // refused at once (not retried)
};
process.env.IMPORT_TARIFF_CODE = 'E-1R-AGILE-24-10-01-G';
for (const k of ['OCTOPUS_API_KEY', 'OCTOPUS_ACCOUNT_NUMBER', 'SUNSYNK_USERNAME', 'SUNSYNK_PASSWORD', 'TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD']) delete process.env[k];

const { db } = await import('../src/db/db.js');
const { syncSite, syncAll } = await import('../src/jobs/sync.js');
const P = await import('../src/core/providers.js');
const { createSite } = await import('../src/core/sites.js');

const conn = (siteId, ...providers) => { for (const p of providers) db.prepare('INSERT OR IGNORE INTO connection (site_id, provider) VALUES (?, ?)').run(siteId, p); };
// A GB home whose location keys are known (so the postcode look-ups make no call), on the .env
// tariff codes, at one location and in one carbon and price region unless told otherwise.
function gbHome(name, { carbon = 3, gsp = 'G' } = {}) {
  const s = createSite({ name, postcode: 'BB12 9BY', lat: 53.79, lon: -2.24, gspRegion: gsp, carbonRegion: carbon });
  db.prepare("UPDATE site SET outcode = 'BB12' WHERE id = ?").run(s.id);
  conn(s.id, 'tariff', 'weather', 'carbon', 'solar_forecast', 'compare');
  return s.id;
}
const kind = (c) => (c.host === 'api.carbonintensity.org.uk' ? 'carbon' : c.host === 'api.open-meteo.com' ? 'weather'
  : c.path === '/v1/products/' ? 'catalogue' : c.host === 'api.octopus.energy' ? 'rates' : c.host);
const counts = () => calls.reduce((o, c) => ({ ...o, [kind(c)]: (o[kind(c)] ?? 0) + 1 }), {});
const steps = (log) => log.map((l) => l.step);
const entry = (log, name) => log.find((l) => l.step === name);
const lastLog = (siteId) => JSON.parse(db.prepare('SELECT detail FROM sync_run WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId).detail);

let single;
test('one home on its own: today\'s steps in today\'s order, nothing shared', async () => {
  const id = gbHome('Single');
  calls.length = 0;
  const [r] = await syncAll([id]);
  single = counts();
  assert.deepEqual(steps(r.log), ['geo', 'weather', 'carbon', 'tariff', 'compare', 'solar_forecast', 'build', 'forecast']);
  assert.ok(r.log.every((l) => !('shared' in l)), 'a single home shares nothing');
  assert.ok(single.carbon >= 2 && single.weather === 1 && single.catalogue === 1 && single.rates === 2, JSON.stringify(single));
  assert.deepEqual(entry(r.log, 'tariff').tariffs, ['E-1R-AGILE-24-10-01-G']);
  assert.deepEqual(unexpected, []);
});

test('two homes on the same tariff, region and location: each shared provider is called once', async () => {
  const a = gbHome('A');
  const b = gbHome('B');
  calls.length = 0;
  const [ra, rb] = await syncAll([a, b]);
  assert.deepEqual(counts(), single, 'the same calls as one home alone');
  assert.ok(ra.log.every((l) => !('shared' in l)));
  assert.match(entry(rb.log, 'carbon').shared, new RegExp(`^fetched for home ${a} earlier in this cycle \\(carbon:3\\)$`));
  assert.match(entry(rb.log, 'compare').shared, /\(compare:GB:G\)$/);
  assert.equal(entry(rb.log, 'tariff').rates, 0, 'the tariff\'s prices were already fetched for A');
  // Weather and solar facts are stored per home, so B's steps ran, on A's answer.
  assert.equal(entry(rb.log, 'weather').ok, true);
  assert.ok(!('shared' in entry(rb.log, 'weather')));
  // B's connections are up to date, and it has A's comparison product codes.
  for (const p of ['carbon', 'compare', 'tariff', 'weather']) {
    assert.equal(db.prepare('SELECT status FROM connection WHERE site_id = ? AND provider = ?').get(b, p).status, 'ok', p);
  }
  const meta = (id) => db.prepare("SELECT meta FROM connection WHERE site_id = ? AND provider = 'compare'").get(id).meta;
  assert.equal(meta(b), meta(a));
  assert.deepEqual(unexpected, []);
});

test('homes in different carbon regions each fetch their region; the tariff is still shared', async () => {
  const e = gbHome('E', { carbon: 5 });
  const f = gbHome('F', { carbon: 3 });
  calls.length = 0;
  const [, rf] = await syncAll([e, f]);
  const c = counts();
  assert.equal(c.carbon, 2 * single.carbon);
  assert.deepEqual([c.weather, c.catalogue, c.rates], [1, 1, 2]);
  assert.ok(!('shared' in entry(rf.log, 'carbon')));
  assert.ok('shared' in entry(rf.log, 'compare'));
});

test('missing credentials: the step is skipped with a reason, no call is made, the rest runs', async () => {
  // The .env home with its account and inverter connected, the server started without --env-file.
  const env = createSite({ name: 'Env home, no .env', postcode: 'BB12 9BY', envKey: 'env', lat: 53.79, lon: -2.24, gspRegion: 'G', carbonRegion: 3 });
  db.prepare("UPDATE site SET outcode = 'BB12' WHERE id = ?").run(env.id);
  conn(env.id, 'octopus', 'sunsynk', 'weather', 'carbon', 'compare', 'solar_forecast');
  db.prepare("UPDATE connection SET external_ref = 'A-OLD', status = 'ok' WHERE site_id = ? AND provider = 'octopus'").run(env.id);
  calls.length = 0;
  const r = await syncSite(env.id);
  assert.deepEqual(entry(r.log, 'octopus'), { step: 'octopus', ok: true, ms: 0, skipped: 'no credentials: OCTOPUS_API_KEY, OCTOPUS_ACCOUNT_NUMBER not set (start the server with --env-file=.env)' });
  assert.deepEqual(entry(r.log, 'sunsynk'), { step: 'sunsynk', ok: true, ms: 0, skipped: 'no credentials: SUNSYNK_USERNAME, SUNSYNK_PASSWORD not set (start the server with --env-file=.env)' });
  assert.equal(r.log.filter((l) => l.step === 'octopus').length, 1, 'one skip for the provider, not one per step');
  assert.ok(!calls.some((c) => /accounts|graphql/.test(c.url) || c.host === 'api.sunsynk.net'), 'no call to Octopus accounts, Kraken or Sunsynk');
  assert.ok(!calls.some((c) => c.url.includes('undefined')), 'no request built from an undefined value');
  assert.deepEqual(steps(r.log).filter((s) => !['octopus', 'sunsynk'].includes(s)), ['geo', 'weather', 'carbon', 'compare', 'solar_forecast', 'build', 'forecast']);
  const status = Object.fromEntries(db.prepare('SELECT provider, status FROM connection WHERE site_id = ?').all(env.id).map((c) => [c.provider, c.status]));
  assert.deepEqual([status.octopus, status.sunsynk, status.weather], ['skipped', 'skipped', 'ok']);
  const meter = P.providerStatus(db, db.prepare('SELECT * FROM site WHERE id = ?').get(env.id)).find((p) => p.role === 'meter');
  assert.deepEqual([meter.status, meter.reason], ['skipped', entry(r.log, 'octopus').skipped]);
  // Any other home with an account connected is skipped the same way: there is no secret store.
  const other = gbHome('Other');
  conn(other, 'octopus');
  const ro = await syncSite(other);
  assert.match(entry(ro.log, 'octopus').skipped, /^no credentials: secrets are read from \.env for the \.env home only/);
  assert.deepEqual(unexpected, []);
});

test('a French home: weather runs; the unbuilt and unlicensed providers (tounify) are skipped, never called', async () => {
  const fr = createSite({ name: 'Maison', country: 'FR', lat: 48.85, lon: 2.35 }).id;
  calls.length = 0;
  let r = await syncSite(fr);
  assert.deepEqual(r.log.filter((l) => !['build', 'forecast'].includes(l.step)).map((l) => [l.step, l.ok, l.skipped ?? null]), [
    ['weather', true, 'no hourly data'],
    ['meter:linky', true, 'disabled: adapter not built: Linky meter data (Enedis with the customer\'s consent, or a local reader) is planned; nothing is read yet'],
    ['tounify', true, 'unlicensed: tounify v3 (preview API): per-connection billing; storage and reuse licence not confirmed in writing; free test token has tiny limits'],
    ['tariff_prices:entsoe', true, 'disabled: adapter not built: ENTSO-E day-ahead wholesale price per bidding zone (not a retail tariff); needs a registered ENTSO-E token'],
    ['tounify_catalogue', true, 'unlicensed: tounify v3 (preview API): per-connection billing; storage and reuse licence not confirmed in writing; free test token has tiny limits'],
  ]);
  assert.deepEqual(calls.map(kind), ['weather'], 'only Open-Meteo is asked');
  // Switched on but still unlicensed: skipped, its implementation never called.
  let called = 0;
  const restore = P.registerAdapter('tounify', { roles: { tariff_prices: [{ step: 'tounify', order: 70, run: async () => { called++; return {}; } }] } });
  r = await syncSite(fr);
  assert.match(entry(r.log, 'tounify').skipped, /^unlicensed: /);
  assert.equal(entry(r.log, 'tounify').ok, true);
  assert.equal(called, 0);
  restore();
});

test('assertOwner: a provider another process owns is never called by the core\'s sync', async () => {
  const id = gbHome('Owner check');
  let called = 0;
  const restore = P.registerAdapter('remote_catalogue', { owner: 'external', roles: { tariff_catalogue: [{ step: 'remote_catalogue', order: 75, run: async () => { called++; return {}; } }] } });
  db.prepare("INSERT INTO market_provider (market_code, role, adapter, priority, owner, scope, origin, note) VALUES ('GB', 'tariff_catalogue', 'remote_catalogue', 1, 'external', 'shared', 'provider', 'a catalogue another process syncs')").run();
  const r = await syncSite(id);
  assert.equal(called, 0);
  assert.match(entry(r.log, 'remote_catalogue').skipped, /^remote_catalogue is owned by another process: the core must not call it/);
  db.prepare("DELETE FROM market_provider WHERE adapter = 'remote_catalogue'").run();
  restore();
});

test('a failing adapter fails only its own step: the home\'s other steps and the next home still run', async () => {
  const x = gbHome('X fails');
  const y = gbHome('Y');
  const seen = [];
  const restore = P.registerAdapter('neso', {
    roles: {
      carbon: [{
        step: 'carbon', order: 40, connection: 'carbon',
        share: (ctx) => ({ key: `carbon:${ctx.site.carbon_region}`, from: 0 }),
        run: async (ctx) => { seen.push(ctx.siteId); if (ctx.siteId === x) throw new Error('NESO answered HTTP 503'); return { past: 1, forecast: 1 }; },
      }],
    },
  });
  const [rx, ry] = await syncAll([x, y]);
  restore();
  assert.deepEqual(entry(rx.log, 'carbon').error, 'NESO answered HTTP 503');
  assert.equal(rx.ok, false);
  for (const s of ['geo', 'weather', 'tariff', 'compare', 'solar_forecast', 'build']) assert.equal(entry(rx.log, s)?.ok, true, `X ${s}`);
  assert.equal(db.prepare("SELECT status, last_error FROM connection WHERE site_id = ? AND provider = 'carbon'").get(x).last_error, 'NESO answered HTTP 503');
  // A failure is not shared: Y asked again, and succeeded.
  assert.deepEqual(seen, [x, y]);
  assert.deepEqual([entry(ry.log, 'carbon').ok, 'shared' in entry(ry.log, 'carbon')], [true, false]);
  assert.equal(lastLog(y).find((l) => l.step === 'carbon').past, 1);
  assert.deepEqual(unexpected, []);
});
