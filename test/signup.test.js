// Sign-up and the steps after it (src/core/users.js, src/core/onboarding.js, src/core/secrets.js) over
// HTTP in a temp database: an account from an email and a password (scrypt, a session cookie), a home
// from a postcode, the providers its market lists, and connecting one with the user's own login:
// checked first, stored encrypted and bound to its home, never sent back, read by the sync steps. The
// provider checks, the postcode look-up and the sync start are fakes (onboarding hooks); the Sunsynk
// token test runs the real adapter against a fake Sunsynk. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useDb } from './helpers.js';

useDb();
process.env.SECRET_KEY = 'test-secret-key-0123456789abcdef-0123456789';
delete process.env.USER_SWITCHER;
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { hooks } = await import('../src/core/onboarding.js');
const { siteCredentials } = await import('../src/core/secrets.js');
const { plan } = await import('../src/core/providers.js');
const { checkSunsynkLogin } = await import('../src/adapters/sunsynk.js');

// Fakes: a login is accepted when its password / key is 'good...'; the sync start is recorded.
const synced = [];
hooks.verify.octopus = async (c) => { if (!c.apiKey.startsWith('good')) throw new Error('HTTP 401'); return { accountNumber: c.accountNumber, properties: 1, postcode: 'BB12 9BY' }; };
hooks.verify.sunsynk = async (c) => { if (!c.password.startsWith('good')) throw new Error('Sunsynk login failed: wrong password'); return { plantId: c.plantId || '4242', plantName: 'Roof', plants: 1 }; };
hooks.plants.sunsynk = async (c) => { if (!c.password.startsWith('good')) throw new Error('Sunsynk login failed: wrong password'); return [{ id: '4242', name: 'Roof', address: '1 Test St' }, { id: '4343', name: 'Barn', address: null }]; };
hooks.geo = async (site) => { db.prepare("UPDATE site SET gsp_region = 'G', carbon_region = 3, outcode = 'BB12', lat = 53.8, lon = -2.3 WHERE id = ?").run(site.id); return db.prepare('SELECT * FROM site WHERE id = ?').get(site.id); };
hooks.startSync = async (id) => { synced.push(id); };

const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
// A browser: keeps the session cookie between calls.
function browser() {
  let cookie = null;
  return async (p, { method = 'GET', body } = {}) => {
    const res = await globalThis.fetch(`${base()}${p}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text, setCookie: set };
  };
}

test('sign-up makes an account, signs it in, and keeps only a scrypt hash of the password', async () => {
  const b = browser();
  const r = await b('/api/auth/signup', { method: 'POST', body: { email: '  Bob@Example.com ', password: 'correct horse', name: 'Bob' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['email', 'id', 'name', 'role']);
  assert.equal(r.body.user.email, 'bob@example.com');
  assert.match(r.setCookie, /^eb_session=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const me = await b('/api/auth/me');
  assert.equal(me.body.user.email, 'bob@example.com');
  assert.equal(me.body.switcher, false);
  const row = db.prepare('SELECT password_hash FROM app_user WHERE email = ?').get('bob@example.com');
  assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!row.password_hash.includes('correct horse'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_session').get().n, 1);
  assert.ok(!db.prepare('SELECT token_hash FROM user_session').get().token_hash.includes(r.setCookie.split(';')[0].split('=')[1]), 'only a hash of the token is stored');
});

test('sign-up refuses a bad email, a short password and an email already used (any case)', async () => {
  const b = browser();
  assert.equal((await b('/api/auth/signup', { method: 'POST', body: { email: 'not-an-email', password: 'long enough' } })).status, 400);
  assert.equal((await b('/api/auth/signup', { method: 'POST', body: { email: 'eve@example.com', password: 'short' } })).status, 400);
  const dup = await b('/api/auth/signup', { method: 'POST', body: { email: 'BOB@example.com', password: 'another one' } });
  assert.equal(dup.status, 409);
  assert.equal((await b('/api/auth/me')).body.user, null, 'a refused sign-up signs nobody in');
});

test('sign-in: a wrong password and an unknown email get the same answer; sign-out ends the session', async () => {
  const b = browser();
  const wrong = await b('/api/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'wrong password' } });
  const unknown = await b('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong password' } });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  const ok = await b('/api/auth/login', { method: 'POST', body: { email: 'BOB@example.com', password: 'correct horse' } });
  assert.equal(ok.status, 200);
  const stolen = ok.setCookie.split(';')[0];
  assert.equal((await b('/api/auth/me')).body.user.name, 'Bob');
  const out = await b('/api/auth/logout', { method: 'POST' });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await b('/api/auth/me')).body.user, null);
  const replay = await globalThis.fetch(`${base()}/api/auth/me`, { headers: { cookie: stolen } }).then((r) => r.json());
  assert.equal(replay.user, null, 'the old cookie no longer works');
});

test('the demo switch header is refused on the main app, so nobody can become someone else', async () => {
  const bob = db.prepare('SELECT id FROM app_user WHERE email = ?').get('bob@example.com').id;
  const r = await globalThis.fetch(`${base()}/api/sites`, { headers: { 'x-user-id': String(bob) } });
  assert.equal(r.status, 403);
  assert.deepEqual(await (await globalThis.fetch(`${base()}/api/users`)).json(), []);
});

let gbHome; let bobB;
test('step 1: a postcode makes a home for the signed-in user only (GB looked up at once)', async () => {
  const anon = browser();
  assert.equal((await anon('/api/onboarding/home', { method: 'POST', body: { country: 'GB', postcode: 'BB12 9BY' } })).status, 401);
  bobB = browser();
  await bobB('/api/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'correct horse' } });
  for (const [country, postcode] of [['GB', '12345'], ['FR', 'BB12 9BY'], ['NL', '1012'], ['XX', '1']]) {
    assert.equal((await bobB('/api/onboarding/home', { method: 'POST', body: { country, postcode } })).status, 400, `${country} ${postcode}`);
  }
  const r = await bobB('/api/onboarding/home', { method: 'POST', body: { country: 'GB', postcode: 'bb129by' } });
  assert.equal(r.status, 201, r.text);
  gbHome = r.body.site;
  assert.equal(gbHome.postcode, 'BB12 9BY');
  assert.equal(gbHome.gsp_region, 'G'); assert.equal(gbHome.carbon_region, 3);
  assert.equal(gbHome.currency, 'GBP');
  assert.deepEqual((await bobB('/api/sites')).body.map((s) => s.id), [gbHome.id]);
  // Nobody signed in, and another account, do not see it.
  assert.equal((await anon(`/api/sites/${gbHome.id}/now`)).status, 404);
  const carol = browser();
  await carol('/api/auth/signup', { method: 'POST', body: { email: 'carol@example.com', password: 'carol password' } });
  assert.deepEqual((await carol('/api/sites')).body, []);
  assert.equal((await carol(`/api/sites/${gbHome.id}/providers`)).status, 404);
  // The shared steps that always run have their connection rows, as the .env home has.
  const conns = db.prepare('SELECT provider FROM connection WHERE site_id = ?').all(gbHome.id).map((c) => c.provider);
  for (const p of ['weather', 'carbon']) assert.ok(conns.includes(p), `${p} in ${conns}`);
});

test('step 2: the providers its market lists, with the login each asks for and no values', async () => {
  const r = await bobB(`/api/sites/${gbHome.id}/providers`);
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.connect.map((c) => [c.adapter, c]));
  assert.equal(by.sunsynk.role, 'inverter'); assert.equal(by.octopus.role, 'meter');
  for (const c of [by.sunsynk, by.octopus]) { assert.equal(c.available, true); assert.equal(c.connected, false); }
  assert.deepEqual(by.octopus.fields.map((f) => f.key), ['apiKey', 'accountNumber']);
  assert.ok(by.octopus.fields.find((f) => f.key === 'apiKey').secret);
  assert.ok(r.body.automatic.some((a) => a.role === 'weather'));
  assert.equal(r.body.secrets_ready, true);
  // A French home: Sunsynk can connect, the French meter is not switched on yet.
  const fr = await bobB('/api/onboarding/home', { method: 'POST', body: { country: 'FR', postcode: '75001' } });
  assert.equal(fr.status, 201, fr.text);
  const frp = (await bobB(`/api/sites/${fr.body.site.id}/providers`)).body.connect;
  assert.equal(frp.find((c) => c.adapter === 'sunsynk').available, true);
  const linky = frp.find((c) => c.adapter === 'linky');
  assert.equal(linky.available, false); assert.match(linky.reason, /coming soon/i); assert.deepEqual(linky.fields, []);
  assert.equal((await bobB(`/api/sites/${fr.body.site.id}/providers/linky`, { method: 'POST', body: { credentials: {} } })).status, 400);
});

test('connect: a wrong or incomplete login is refused and nothing is stored', async () => {
  const post = (provider, credentials) => bobB(`/api/sites/${gbHome.id}/providers/${provider}`, { method: 'POST', body: { credentials } });
  assert.equal((await post('octopus', { accountNumber: 'A-1234ABCD' })).status, 400, 'no API key');
  assert.equal((await post('octopus', { apiKey: 'good-key', accountNumber: '12345' })).status, 400, 'account number shape');
  const bad = await post('octopus', { apiKey: 'bad-key', accountNumber: 'A-1234ABCD' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Octopus Energy did not accept this login/);
  assert.equal((await post('nope', {})).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_secret').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection WHERE site_id = ? AND provider = 'octopus'").get(gbHome.id).n, 0);
  assert.deepEqual(synced, []);
  // Nobody signed in may not connect even a home nobody owns.
  const loose = db.prepare("INSERT INTO site (name, created_at) VALUES ('loose', 0) RETURNING id").get().id;
  assert.equal((await browser()(`/api/sites/${loose}/providers/octopus`, { method: 'POST', body: { credentials: { apiKey: 'good', accountNumber: 'A-1234ABCD' } } })).status, 401);
  db.prepare('DELETE FROM site WHERE id = ?').run(loose);
});

test('connect: SECRET_KEY missing -> 503, nothing stored', async () => {
  const k = process.env.SECRET_KEY; delete process.env.SECRET_KEY;
  try {
    const r = await bobB(`/api/sites/${gbHome.id}/providers/octopus`, { method: 'POST', body: { credentials: { apiKey: 'good-key', accountNumber: 'A-1234ABCD' } } });
    assert.equal(r.status, 503); assert.match(r.body.error, /SECRET_KEY/);
    assert.equal((await bobB(`/api/sites/${gbHome.id}/providers`)).body.secrets_ready, false);
  } finally { process.env.SECRET_KEY = k; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_secret').get().n, 0);
});

test('connect: a good login is stored encrypted, never sent back, read by the sync steps, and the first sync starts', async () => {
  const KEY = 'good-sk_live_ABCDEF0123456789'; const PW = 'good-sunsynk-pw-987';
  const o = await bobB(`/api/sites/${gbHome.id}/providers/octopus`, { method: 'POST', body: { credentials: { apiKey: KEY, accountNumber: 'a-1234abcd' } } });
  assert.equal(o.status, 201, o.text);
  const s = await bobB(`/api/sites/${gbHome.id}/providers/sunsynk`, { method: 'POST', body: { credentials: { username: 'bob@example.com', password: PW } } });
  assert.equal(s.status, 201, s.text);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(synced, [gbHome.id, gbHome.id]);
  // The connection rows keep the non-secret reference only.
  const conn = Object.fromEntries(db.prepare('SELECT provider, external_ref FROM connection WHERE site_id = ?').all(gbHome.id).map((c) => [c.provider, c.external_ref]));
  assert.equal(conn.octopus, 'A-1234ABCD'); assert.equal(conn.sunsynk, '4242');
  // Encrypted at rest: neither secret appears in the stored bytes.
  for (const r of db.prepare('SELECT ciphertext FROM connection_secret WHERE site_id = ?').all(gbHome.id)) {
    const bytes = Buffer.from(r.ciphertext).toString('latin1');
    assert.ok(!bytes.includes(KEY) && !bytes.includes(PW) && !bytes.includes('A-1234ABCD'));
  }
  // Never sent back, by any answer about the home.
  const providers = await bobB(`/api/sites/${gbHome.id}/providers`);
  for (const t of [o.text, s.text, providers.text, (await bobB('/api/sites')).text, (await bobB(`/api/sites/${gbHome.id}/health`)).text]) {
    assert.ok(!t.includes(KEY) && !t.includes(PW), t.slice(0, 200));
  }
  const by = Object.fromEntries(providers.body.connect.map((c) => [c.adapter, c]));
  assert.equal(by.octopus.connected, true, JSON.stringify(by.octopus)); assert.equal(by.octopus.login, 'stored'); assert.equal(by.sunsynk.connected, true, JSON.stringify(by.sunsynk));
  // The sync steps read them: the home's plan runs both, with no "no credentials" skip.
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(gbHome.id);
  assert.deepEqual(siteCredentials(site, 'octopus', { apiKey: 'X', accountNumber: 'Y' }).creds, { apiKey: KEY, accountNumber: 'A-1234ABCD' });
  assert.equal(siteCredentials(site, 'sunsynk', { username: 'X', password: 'Y' }, { plantId: 'Z' }).creds.plantId, '4242');
  const run = plan(db, site).filter((e) => e.run).map((e) => e.adapter);
  assert.ok(run.includes('octopus') && run.includes('sunsynk'), run.join(','));
  const noCreds = plan(db, site).filter((e) => ['octopus', 'sunsynk'].includes(e.adapter) && /no credentials/.test(e.skipped ?? ''));
  assert.deepEqual(noCreds.map((e) => `${e.adapter}: ${e.skipped}`), []);
});

test('a stored login is bound to its home and key: copied to another home, or read with another key, it does not decrypt', () => {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(gbHome.id);
  const other = db.prepare("INSERT INTO site (name, created_at) VALUES ('other', 0) RETURNING *").get();
  db.prepare("INSERT INTO connection_secret (site_id, provider, iv, tag, ciphertext, recorded_at) SELECT ?, provider, iv, tag, ciphertext, recorded_at FROM connection_secret WHERE site_id = ? AND provider = 'octopus'").run(other.id, site.id);
  assert.match(siteCredentials(other, 'octopus', { apiKey: 'X', accountNumber: 'Y' }).missing, /cannot be read/);
  const k = process.env.SECRET_KEY; process.env.SECRET_KEY = 'a-different-key-that-is-long-enough-0000';
  try { assert.match(siteCredentials(site, 'octopus', { apiKey: 'X', accountNumber: 'Y' }).missing, /SECRET_KEY has changed/); } finally { process.env.SECRET_KEY = k; }
  db.prepare('DELETE FROM site WHERE id = ?').run(other.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_secret WHERE site_id = ?').get(other.id).n, 0, 'deleting a home deletes its logins');
});

test('the .env home still reads .env, as before', () => {
  const env = { id: 999, env_key: 'env' };
  process.env.OCTOPUS_API_KEY = 'env-key'; process.env.OCTOPUS_ACCOUNT_NUMBER = 'A-0000AAAA';
  try { assert.deepEqual(siteCredentials(env, 'octopus', { apiKey: 'OCTOPUS_API_KEY', accountNumber: 'OCTOPUS_ACCOUNT_NUMBER' }).creds, { apiKey: 'env-key', accountNumber: 'A-0000AAAA' }); } finally {
    delete process.env.OCTOPUS_API_KEY; delete process.env.OCTOPUS_ACCOUNT_NUMBER;
  }
  assert.match(siteCredentials({ id: 998, env_key: null }, 'octopus', { apiKey: 'OCTOPUS_API_KEY' }).missing, /no credentials/);
});

test('Sunsynk: each login gets its own token and sees its own plant (no token shared between homes)', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pk = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/anonymous/publicKey') return json({ code: 0, data: pk });
    if (u.pathname === '/oauth/token/new') return json({ code: 0, data: { access_token: `token-of-${JSON.parse(init.body).username}`, expires_in: 3600 } });
    if (u.pathname === '/api/v1/plants') {
      const who = String(init.headers?.authorization ?? '').replace('Bearer token-of-', '');
      return json({ code: 0, data: { infos: [{ id: who === 'a@example.com' ? 111 : 222, name: `plant of ${who}` }] } });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const a = await checkSunsynkLogin({ username: 'a@example.com', password: 'pa' });
    const b = await checkSunsynkLogin({ username: 'b@example.com', password: 'pb' });
    const a2 = await checkSunsynkLogin({ username: 'a@example.com', password: 'pa' });
    assert.equal(a.plantId, '111'); assert.equal(b.plantId, '222'); assert.equal(a2.plantId, '111');
  } finally { globalThis.fetch = real; }
});

test('postcodes: spaces anywhere are ignored, then written the one way', async () => {
  const { normalisePostcode } = await import('../src/core/onboarding.js');
  for (const p of ['BB 12 9BY', 'bb129by', ' BB12  9BY ', 'B B12 9BY']) assert.equal(normalisePostcode('GB', p), 'BB12 9BY', p);
  assert.equal(normalisePostcode('NL', '1012ab'), '1012 AB');
  assert.equal(normalisePostcode('FR', '75 001'), '75001');
  assert.throws(() => normalisePostcode('GB', 'BB12 9B'), /not a United Kingdom postcode/);
});

test('a connected provider shows its account; disconnecting forgets the login and withdraws only its data; another account replaces the old one', async () => {
  const { seriesId, putReadings, putIntervals } = await import('../src/core/facts.js');
  const { setAttribute } = await import('../src/core/attributes.js');
  const id = gbHome.id;
  // The account each card shows: the login and plant, the account and its supply postcode; no secret.
  let p = (await bobB(`/api/sites/${id}/providers`)).body;
  const card = (a) => p.connect.find((c) => c.adapter === a);
  assert.deepEqual(card('sunsynk').account, { login: 'bob@example.com', plantId: '4242', plantName: 'Roof' });
  assert.deepEqual(card('octopus').account, { accountNumber: 'A-1234ABCD', postcode: 'BB12 9BY' });
  assert.equal(card('sunsynk').can_disconnect, true);
  // Data each provider brought, and a shared provider's (weather), which must stay.
  const t = 1790000000;
  const solar = seriesId('site', id, 'solar_w', 'sunsynk_5min');
  const weather = seriesId('site', id, 'outdoor_temp_c', 'open_meteo');
  putReadings(solar, [{ ts: t, value: 1200 }, { ts: t + 300, value: 1300 }]);
  putReadings(weather, [{ ts: t, value: 11 }]);
  const meter = db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'meter_import', 'octopus', 'MPAN-1', 'Import', '{}', ?) RETURNING id").get(id, Date.now()).id;
  const imp = seriesId('device', meter, 'grid_import_kwh', 'octopus_meter');
  putIntervals(imp, [{ start: t, end: t + 1800, value: 0.4 }]);
  setAttribute(id, 'pv_kwp', 6.5, 'provider', 'Sunsynk plant 4242 record');
  const live = (s) => db.prepare('SELECT COUNT(*) AS n FROM reading WHERE series_id = ? AND superseded_at IS NULL').get(s).n
    + db.prepare('SELECT COUNT(*) AS n FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL').get(s).n;

  // Someone else cannot disconnect it; the owner can.
  const eve = browser();
  await eve('/api/auth/signup', { method: 'POST', body: { email: 'eve@example.com', password: 'eve password' } });
  assert.equal((await eve(`/api/sites/${id}/providers/sunsynk`, { method: 'DELETE' })).status, 404);
  const d = await bobB(`/api/sites/${id}/providers/sunsynk`, { method: 'DELETE' });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.withdrawn, 2);
  assert.equal(live(solar), 0, 'the inverter readings are withdrawn');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reading WHERE series_id = ?').get(solar).n, 2, '... but kept in the history');
  assert.equal(live(weather), 1, 'weather is not the inverter\'s: it stays');
  assert.equal(live(imp), 1, 'the meter is another provider: it stays');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection_secret WHERE site_id = ? AND provider = 'sunsynk'").get(id).n, 0, 'the login is forgotten');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(id).n, 0);
  assert.match(db.prepare('SELECT reason FROM fact_correction WHERE site_id = ? AND series_id = ?').get(id, solar).reason, /Sunsynk was disconnected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM site_attribute WHERE site_id = ? AND attr = 'pv_kwp' AND source = 'provider' AND superseded_at IS NULL").get(id).n, 0, 'the panel size it gave is withdrawn');
  p = (await bobB(`/api/sites/${id}/providers`)).body;
  assert.equal(card('sunsynk').connected, false);
  assert.ok(card('sunsynk').fields.length, 'the form is back, to connect again');
  assert.equal((await bobB(`/api/sites/${id}/providers/sunsynk`, { method: 'DELETE' })).status, 400, 'not connected any more');
  // Connected again: a new provider to the sync (full first window), the account shown again.
  assert.equal((await bobB(`/api/sites/${id}/providers/sunsynk`, { method: 'POST', body: { credentials: { username: 'bob@example.com', password: 'good-pw-2' } } })).status, 201);
  p = (await bobB(`/api/sites/${id}/providers`)).body;
  assert.equal(card('sunsynk').connected, true);

  // Octopus: the same account again (a new key) keeps the data; another account replaces it.
  let r = await bobB(`/api/sites/${id}/providers/octopus`, { method: 'POST', body: { credentials: { apiKey: 'good-key-2', accountNumber: 'A-1234ABCD' } } });
  assert.equal(r.status, 201, r.text); assert.equal(r.body.replaced, null); assert.equal(live(imp), 1);
  r = await bobB(`/api/sites/${id}/providers/octopus`, { method: 'POST', body: { credentials: { apiKey: 'good-key-3', accountNumber: 'A-9999FFFF' } } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.replaced, { withdrawn: 1 });
  assert.equal(live(imp), 0, 'the old account\'s meter readings are withdrawn');
  assert.ok(db.prepare('SELECT retired_at FROM device WHERE id = ?').get(meter).retired_at, 'and its meter retired');
  p = (await bobB(`/api/sites/${id}/providers`)).body;
  assert.equal(card('octopus').account.accountNumber, 'A-9999FFFF');
  assert.equal(db.prepare("SELECT external_ref FROM connection WHERE site_id = ? AND provider = 'octopus'").get(id).external_ref, 'A-9999FFFF');
});

test('Sunsynk: the login lists its plants to pick from (nothing stored), and the picked one is connected', async () => {
  const id = gbHome.id;
  const card = (await bobB(`/api/sites/${id}/providers`)).body.connect.find((c) => c.adapter === 'sunsynk');
  assert.deepEqual(card.fields.find((f) => f.key === 'plantId'), { key: 'plantId', label: 'Plant', type: 'text', required: false, pick: true }, 'picked, not typed');
  const before = db.prepare('SELECT COUNT(*) AS n FROM connection_secret').get().n;
  assert.equal((await bobB(`/api/sites/${id}/providers/sunsynk/plants`, { method: 'POST', body: { credentials: { username: 'bob@example.com', password: 'wrong' } } })).status, 400);
  assert.equal((await bobB(`/api/sites/${id}/providers/sunsynk/plants`, { method: 'POST', body: { credentials: { username: 'bob@example.com' } } })).status, 400, 'the password is needed');
  const r = await bobB(`/api/sites/${id}/providers/sunsynk/plants`, { method: 'POST', body: { credentials: { username: 'bob@example.com', password: 'good-pw' } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.plants.map((x) => x.name), ['Roof', 'Barn']);
  assert.ok(!r.text.includes('good-pw'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connection_secret').get().n, before, 'listing stores nothing');
  assert.equal((await bobB(`/api/sites/${id}/providers/octopus/plants`, { method: 'POST', body: { credentials: {} } })).status, 400, 'Octopus has no plants');
  const eve = browser();
  await eve('/api/auth/signup', { method: 'POST', body: { email: 'eve2@example.com', password: 'eve password' } });
  assert.equal((await eve(`/api/sites/${id}/providers/sunsynk/plants`, { method: 'POST', body: { credentials: { username: 'x', password: 'good' } } })).status, 404, 'not her home');
  const c = await bobB(`/api/sites/${id}/providers/sunsynk`, { method: 'POST', body: { credentials: { username: 'bob@example.com', password: 'good-pw', plantId: '4343' } } });
  assert.equal(c.status, 201, c.text);
  assert.equal(db.prepare("SELECT external_ref FROM connection WHERE site_id = ? AND provider = 'sunsynk'").get(id).external_ref, '4343');
});
