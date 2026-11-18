// The Places and Integrations pages (plan 6.1 to 6.3): the pages and their scripts are served and well formed, the navigation lists them,
// and GET /api/homes/:uid/integrations says what each connection is doing, which things it names and the last answer it landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no GB fixture';
if (hasLive) await useDb({ snapshot: true }); else await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { ensureEnergyGraph } = await import('../src/core/energy-graph.js');

const root = path.resolve(import.meta.dirname, '..');
const server = app.listen(0); server.unref();
const get = async (p, user) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { headers: user ? { 'x-user-id': String(user.id) } : {} }); const t = await r.text(); return { status: r.status, text: t, json: () => JSON.parse(t) }; };

await test('both pages and their scripts are served, the scripts are valid modules, the navigation lists them', async () => {
  for (const [page, script] of [['/places', '/js/pages/places.js'], ['/integrations', '/js/pages/integrations.js']]) {
    const h = await get(page);
    assert.equal(h.status, 200, page);
    assert.ok(h.text.includes(`src="${script}"`) && h.text.includes('<div id="content">'), `${page} loads ${script}`);
    assert.equal((await get(script)).status, 200, script);
    const check = spawnSync(process.execPath, ['--check', path.join(root, 'public', script)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${script}: ${check.stderr}`);
  }
  assert.equal((await get('/css/places.css')).status, 200);
  const layout = (await get('/js/layout.js')).text;
  assert.ok(layout.includes("['places', 'Places', '/places']") && layout.includes("['integrations', 'Integrations', '/integrations']"));
});

await test('the places page asks only for things the API serves', async () => {
  const src = (await get('/js/pages/places.js')).text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');   // the code, not the comments
  const used = [...src.matchAll(/\/api\/(?:homes|things|requests)\/[^`'"]*/g)].map((m) => m[0].replace(/\$\{[^}]*\}/g, ':x').replace(/\?.*$/, ''));
  const wanted = new Set(used.map((u) => u.replace(/\/:x\/?$/, '/:x')));
  for (const w of wanted) assert.ok(/^\/api\/(homes\/:x(\/graph|\/things)?|things\/:x(\/timeline|\/events|\/controls|\/requests|\/move)?|requests\/:x\/cancel|requests\/\$\{b\.dataset\.cancel\}\/cancel)$/.test(w) || w.includes('dataset'), `an API path the server does not have: ${w}`);
});

await test('what each connection of home 1 is doing, the things it names, its last raw answer', { skip }, async () => {
  const alice = await createUser({ name: 'Alice', role: 'owner' }); await giveHome(alice.id, 1);
  const bob = await createUser({ name: 'Bob', role: 'owner' });
  await db.prepare("UPDATE connection SET status = 'ok', last_success_at = ? WHERE site_id = 1 AND provider = 'sunsynk'").run(Math.floor(Date.now() / 1000) - 600);
  await db.prepare("UPDATE connection SET external_ref = 'PLANT-292543' WHERE site_id = 1 AND provider = 'sunsynk'").run();   // the fixture keeps no plant id
  await ensureEnergyGraph(1);
  const uid = (await db.prepare('SELECT uid FROM thing WHERE id = 1').get()).uid;
  const r = await get(`/api/homes/${uid}/integrations`, alice);
  assert.equal(r.status, 200);
  const body = r.json();
  assert.ok(!JSON.stringify(body).includes('"id"'), 'no integer id');
  const sun = body.connections.find((c) => c.provider === 'sunsynk');
  assert.deepEqual([sun.name, sun.access, sun.status, sun.implemented], ['Sunsynk Connect', 'cloud_pull', 'ok', true]);
  assert.ok(sun.things.some((t) => t.type === 'inverter' && /^[0-9a-f-]{36}$/.test(t.uid)), `the inverter is named by the plant: ${JSON.stringify(sun)}`);
  assert.ok(!sun.reference || sun.reference.length <= 6 || sun.reference.startsWith('…'), 'a reference is masked');
  const octopus = body.connections.find((c) => c.provider === 'octopus');
  assert.ok(octopus.things.length >= 1, 'the meters are named by their MPANs');
  assert.ok(body.connections.some((c) => c.last_raw?.url?.startsWith('/api/raw/')), 'a last raw answer is offered');
  assert.equal((await get(`/api/homes/${uid}/integrations`, bob)).status, 404, 'another user: the same 404');
});
