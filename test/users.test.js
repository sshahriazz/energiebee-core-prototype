// Prototype users (src/core/users.js, delta 070) over HTTP, on the three SYNTHETIC homes of
// scripts/lib/multi-market.js (GB, FR, NL) in a temp database, with the demo "Viewing as" switch on
// (USER_SWITCHER=1): with no X-User-Id header only the homes no user owns are seen (every home of a
// database without users, as before users existed); with one, each user sees only their own homes, everywhere a
// home can be reached (the home list, every /api/sites/:id route, raw payloads, the Data Explorer),
// and another user's home answers as one that does not exist. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useDb } from './helpers.js';

useDb();
process.env.USER_SWITCHER = '1';
const m = await import('../scripts/lib/multi-market.js');
const { db, DELTAS, applyDelta } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { landRaw } = await import('../src/core/facts.js');
const { createUser, giveHome, canSee, visibleSiteIds } = await import('../src/core/users.js');

const { gb, fr, nl } = m.buildScenario();
const alice = createUser({ name: 'Alice', role: 'owner' }); giveHome(alice.id, gb.site.id);
const pierre = createUser({ name: 'Pierre', role: 'owner' }); giveHome(pierre.id, fr.site.id);
const ivan = createUser({ name: 'Ivan', role: 'installer' }); giveHome(ivan.id, fr.site.id); giveHome(ivan.id, nl.site.id);
const nora = createUser({ name: 'Nora', role: 'owner' });
const admin = createUser({ name: 'Admin', role: 'admin' });
const ALL = [gb.site.id, fr.site.id, nl.site.id].sort((a, b) => a - b);

const server = app.listen(0);
after(() => server.close());
async function call(p, user, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(user != null ? { 'x-user-id': String(user) } : {}) };
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers, ...opts });
  return { status: res.status, body: await res.json() };
}
const siteIds = async (user) => {
  const r = await call('/api/sites', user);
  assert.equal(r.status, 200);
  return r.body.map((s) => s.id).sort((a, b) => a - b);
};

test('no user header: only the homes no user owns (all of them before any home is owned)', async () => {
  // Every home here is owned, so nobody signed in sees none of them...
  assert.deepEqual(await siteIds(null), []);
  for (const id of ALL) assert.equal((await call(`/api/sites/${id}/summary?period=7d`)).status, 404);
  assert.equal(canSee(null, fr.site.id), false);
  // ...and a home nobody owns (the .env home) is seen as before.
  const loose = db.prepare("INSERT INTO site (name, created_at) VALUES ('nobody owns this', 0) RETURNING id").get().id;
  assert.deepEqual(await siteIds(null), [loose]);
  assert.equal((await call(`/api/sites/${loose}/now`)).status, 200);
  assert.equal((await call(`/api/sites/${loose}/now`, alice.id)).status, 404, 'a user sees only their own homes');
  db.prepare('DELETE FROM site WHERE id = ?').run(loose);
  assert.equal(visibleSiteIds(admin), null);
});

test('the switch only works where USER_SWITCHER=1; elsewhere the header is refused and no user is listed', async () => {
  delete process.env.USER_SWITCHER;
  try {
    const r = await call('/api/sites', alice.id);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /sign in/i);
    assert.deepEqual((await call('/api/users')).body, []);
  } finally { process.env.USER_SWITCHER = '1'; }
});

test('each user sees only their own homes in the list', async () => {
  assert.deepEqual(await siteIds(alice.id), [gb.site.id]);
  assert.deepEqual(await siteIds(pierre.id), [fr.site.id]);
  assert.deepEqual(await siteIds(ivan.id), [fr.site.id, nl.site.id].sort((a, b) => a - b));
  assert.deepEqual(await siteIds(nora.id), []);
  assert.deepEqual(await siteIds(admin.id), ALL);
});

test("another user's home answers 404 on every home route, the same as a home that does not exist", async () => {
  const routes = ['summary?period=7d', 'now', 'timeline?period=7d', 'tariffs', 'breakdown?period=7d', 'trust?period=7d', 'health', 'system', 'devices', 'insights', 'forecast'];
  for (const r of routes) {
    const own = await call(`/api/sites/${gb.site.id}/${r}`, alice.id);
    assert.notEqual(own.status, 404, `own home ${r}: ${JSON.stringify(own.body).slice(0, 200)}`);
    const other = await call(`/api/sites/${fr.site.id}/${r}`, alice.id);
    assert.equal(other.status, 404, `other home ${r}`);
    assert.deepEqual(other.body, (await call(`/api/sites/999999/${r}`, alice.id)).body, `${r}: hidden and missing look the same`);
  }
  // Writes too: nobody syncs or rebuilds a home that is not theirs.
  assert.equal((await call(`/api/sites/${gb.site.id}/sync`, pierre.id, { method: 'POST' })).status, 404);
  assert.equal((await call(`/api/sites/${gb.site.id}/rebuild`, pierre.id, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await call(`/api/sites/${gb.site.id}/slot`, pierre.id, { method: 'POST', body: JSON.stringify({ slot_s: 900 }) })).status, 404);
  assert.equal((await call(`/api/sites/${gb.site.id}/now`, admin.id)).status, 200, 'an admin sees every home');
});

test('an unknown or malformed user is refused, not shown every home', async () => {
  for (const u of ['999999', 'abc', '1; DROP TABLE site']) {
    const r = await call('/api/sites', u);
    assert.equal(r.status, 401, u);
    assert.equal(r.body.error, 'Unknown user');
  }
  assert.equal((await call(`/api/sites/${gb.site.id}/now`, '999999')).status, 401);
});

test('the user list names each user with the number of homes they see', async () => {
  const r = await call('/api/users');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.map((u) => [u.name, u]));
  assert.equal(by.Alice.homes, 1); assert.equal(by.Ivan.homes, 2); assert.equal(by.Nora.homes, 0);
  assert.equal(by.Admin.role, 'admin');
  assert.ok(r.body.every((u) => !('password' in u)));
});

test("raw payloads: another user's home is not found; shared payloads (no home) are for everyone", async () => {
  const mine = landRaw({ source: 'octopus_meter', siteId: gb.site.id, request: { url: 'https://example.test/a' }, body: { results: [1] } }).rawId;
  const shared = landRaw({ source: 'tariffscanner', siteId: null, request: { url: 'https://example.test/b' }, body: { results: [2] } }).rawId;
  assert.equal((await call(`/api/raw/${mine}`, alice.id)).status, 200);
  assert.equal((await call(`/api/raw/${mine}`, pierre.id)).status, 404);
  assert.equal((await call(`/api/raw/${mine}`)).status, 404, 'nobody signed in: an owned home is hidden');
  assert.equal((await call(`/api/raw/${shared}`, pierre.id)).status, 200);
  assert.equal((await call(`/api/explorer/raw/${mine}`, pierre.id)).status, 404, 'explorer: asked by id alone');
  assert.equal((await call(`/api/explorer/raw/${mine}`, alice.id)).status, 200);
});

test("Data Explorer: another user's home is not found, by ?site= or by a series id", async () => {
  assert.equal((await call(`/api/explorer/overview?site=${gb.site.id}`, alice.id)).status, 200);
  assert.equal((await call(`/api/explorer/overview?site=${fr.site.id}`, alice.id)).status, 404);
  assert.equal((await call(`/api/explorer/series?site=${fr.site.id}`, alice.id)).status, 404);
  assert.equal((await call(`/api/explorer/overview?site=${fr.site.id}`)).status, 404, 'nobody signed in: an owned home is hidden');
  const frSeries = db.prepare("SELECT id FROM series WHERE subject_kind = 'site' AND subject_id = ? ORDER BY id LIMIT 1").get(String(fr.site.id))
    ?? db.prepare("SELECT id FROM series WHERE subject_kind = 'device' AND subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?) ORDER BY id LIMIT 1").get(fr.site.id);
  assert.ok(frSeries, 'the French home has a series');
  assert.equal((await call(`/api/explorer/facts?series=${frSeries.id}`, pierre.id)).status, 200);
  assert.equal((await call(`/api/explorer/facts?series=${frSeries.id}`, alice.id)).status, 404);
});

test('a home added while a user is picked is theirs, and only theirs', async () => {
  const r = await call('/api/sites', nora.id, { method: 'POST', body: JSON.stringify({ name: 'Nora home' }) });
  assert.equal(r.status, 201);
  assert.deepEqual(await siteIds(nora.id), [r.body.id]);
  assert.equal((await call(`/api/sites/${r.body.id}/now`, alice.id)).status, 404);
  assert.ok((await siteIds(admin.id)).includes(r.body.id));
  assert.ok(!(await siteIds(null)).includes(r.body.id), 'nobody signed in does not see it');
});

test('delta 070 is listed, runs again without change, and deleting a home drops its links', () => {
  assert.ok(DELTAS.indexOf('070-users.sql') > DELTAS.indexOf('060-coverage.sql'));
  const before = db.prepare('SELECT COUNT(*) AS n FROM user_site').get().n;
  applyDelta(fs.readFileSync(new URL('../src/db/deltas/070-users.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_site').get().n, before);
  const tmp = db.prepare("INSERT INTO site (name, created_at) VALUES ('tmp', 0) RETURNING id").get().id;
  giveHome(nora.id, tmp);
  db.prepare('DELETE FROM site WHERE id = ?').run(tmp);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_site WHERE site_id = ?').get(tmp).n, 0);
});

test('demo server: "+ Sign up" makes a user the dropdown picks (no cookie), who adds a home and then appears in the list', async () => {
  const s = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo-new@example.com', password: 'demo password', name: 'Dee' }) });
  assert.equal(s.status, 201);
  assert.equal(s.headers.get('set-cookie'), null, 'no session cookie on the demo server: it would sign the main app out');
  const dee = (await s.json()).user;
  assert.deepEqual(await siteIds(dee.id), []);
  const h = await call('/api/onboarding/home', dee.id, { method: 'POST', body: JSON.stringify({ country: 'FR', postcode: '75001', name: 'Dee home' }) });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.deepEqual(await siteIds(dee.id), [h.body.site.id]);
  assert.equal((await call(`/api/sites/${h.body.site.id}/providers`, dee.id)).status, 200);
  assert.equal((await call(`/api/sites/${h.body.site.id}/now`, alice.id)).status, 404, 'other users do not see it');
  const listed = (await call('/api/users')).body.find((u) => u.id === dee.id);
  assert.equal(listed.homes, 1);
});

test('demo server: the dropdown wins over a session cookie, so switching always works', async () => {
  const { startSession } = await import('../src/core/users.js');
  const cookie = `eb_session=${startSession(alice.id)}`;
  const get = (user) => fetch(`http://127.0.0.1:${server.address().port}/api/sites`, { headers: { cookie, ...(user ? { 'x-user-id': String(user) } : {}) } }).then((r) => r.json());
  assert.deepEqual((await get(pierre.id)).map((x) => x.id), [fr.site.id]);
  assert.deepEqual((await get(null)).map((x) => x.id), [gb.site.id], 'no dropdown pick: the cookie');
});
