// The rules that tie a site to its home thing and a device to its device thing (plan Phase 1.3 and 1.3b, migration
// 20261119000000_things_are_identity), broken on purpose and refused (fix list D1). A site and a device are the detail rows of
// their things: the same id and uid, made together, renamed together, deleted together. See test/rules/lib.js for how an area
// proves its rules and declares them in test/rules/fold.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, checkDeclared } = await harness('fold');
const { erase } = await import('../src/core/erasure.js');

const NOW = 1_800_000_000;
const site = (name) => ins('INSERT INTO site (name, created_at) VALUES (?, ?)', name, NOW);
const device = (siteId, kind, ref, label = null) => ins("INSERT INTO device (site_id, kind, provider, external_ref, label) VALUES (?, ?, 'test', ?, ?)", siteId, kind, ref, label);
const thing = (id) => get('SELECT id, uid, home_id, kind, type, name, valid_from, valid_to FROM thing WHERE id = ?', id);
// With the trigger that makes the thing off, a detail row can name any thing: what the guards are for.
const without = async (table, trigger, fn) => {
  await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try { return await fn(); } finally { await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
};

await test('a site makes its home thing: the same id and uid, its own home, named like the site', async () => {
  const s = await site('Fold home');
  const t = await thing(s);
  assert.deepEqual([t.id, t.home_id, t.kind, t.type, t.name, t.valid_from], [s, s, 'home', 'house', 'Fold home', NOW]);
  assert.equal(t.uid, (await get('SELECT uid FROM site WHERE id = ?', s)).uid);
  maintained('site_make_thing');
  const blank = await ins("INSERT INTO site (name, created_at) VALUES ('   ', ?)", NOW);
  assert.equal((await thing(blank)).name, 'Home', 'a blank name gets a plain one');
  // an explicit id (a test, an import) is the thing's id too; the next implicit id skips it
  await run("INSERT INTO site (id, name, created_at) VALUES (4242, 'Explicit', ?)", NOW);
  assert.equal((await thing(4242)).home_id, 4242);
  const next = await site('After explicit');
  assert.notEqual(next, 4242);
});

await test('a device makes its device thing: a device or a system thing of its home and kind, named like its label or its kind', async () => {
  const s = await site('Device home');
  const bat = await device(s, 'battery', 'b1', 'House battery');
  const plain = await device(s, 'inverter', 'i1');
  const water = await device(s, 'hot_water', 'w1', 'Hot water');
  assert.deepEqual(Object.values(await thing(bat)).slice(2, 6), [s, 'device', 'battery', 'House battery']);
  assert.equal((await thing(plain)).name, 'inverter', 'no label: its kind');
  assert.deepEqual([(await thing(water)).kind, (await thing(water)).type], ['system', 'hot_water'], 'a hot water device is a system');
  assert.equal((await thing(bat)).uid, (await get('SELECT uid FROM device WHERE id = ?', bat)).uid);
  maintained('device_make_thing');
  // a device row that names a thing that exists is that thing's detail row: the library makes the thing first
  const made = await ins("INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'device', 'smart_plug', 'Library plug')", s);
  const uid = (await thing(made)).uid;
  await run("INSERT INTO device (id, site_id, kind, provider, external_ref, label, uid) VALUES (?, ?, 'smart_plug', 'thing', ?, 'Library plug', ?::uuid)", made, s, uid, uid);
  assert.equal((await get('SELECT COUNT(*) AS n FROM thing WHERE id = ?', made)).n, 1, 'no second thing');
  // a device kind added by one registry row has its thing type made from that row
  await run("INSERT INTO device_kind (kind, label, class, attribute_keys, action_codes) VALUES ('rules_heat_battery', 'Heat battery', 'controllable', '[]', '[]')");
  const hb = await device(s, 'rules_heat_battery', 'hb1');
  assert.deepEqual([(await thing(hb)).kind, (await thing(hb)).type], ['device', 'rules_heat_battery']);
  assert.equal((await get("SELECT label FROM thing_type WHERE type = 'rules_heat_battery'")).label, 'Heat battery');
});

await test('a rename of the site or the device is its thing\'s, and a retirement of the device ends the thing', async () => {
  const s = await site('Before');
  const d = await device(s, 'battery', 'b2', 'Old label');
  await run("UPDATE site SET name = 'After' WHERE id = ?", s);
  assert.equal((await thing(s)).name, 'After');
  maintained('site_sync_thing');
  await run("UPDATE device SET label = 'New label' WHERE id = ?", d);
  assert.equal((await thing(d)).name, 'New label');
  await run('UPDATE device SET retired_at = ? WHERE id = ?', (NOW + 7200) * 1000, d);
  assert.equal((await thing(d)).valid_to, NOW + 7200);
  maintained('device_sync_thing');
  assert.equal((await get('SELECT COUNT(*) AS n FROM thing_attr_version WHERE thing_id = ?', d)).n, 3, 'each change is one version of the thing');
});

await test('the detail row and its thing agree: a site is a home thing\'s detail, a device a device thing\'s of its home and kind', async () => {
  const s = await site('Guard home');
  const d = await device(s, 'battery', 'b3');
  const other = await site('Other home');
  await without('site', 'site_make_thing', async () => {
    await refused('site_is_home', "INSERT INTO site (id, name, created_at) VALUES (?, 'Not a home', ?)", d, NOW);   // the id of a device thing
  });
  await without('device', 'device_make_thing', async () => {
    const t = await ins("INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'device', 'inverter', 'An inverter')", s);
    await refused('device_is_thing', "INSERT INTO device (id, site_id, kind, provider, external_ref) VALUES (?, ?, 'battery', 'p', 'wrong-kind')", t, s);    // another kind
    await refused('device_is_thing', "INSERT INTO device (id, site_id, kind, provider, external_ref) VALUES (?, ?, 'inverter', 'p', 'wrong-home')", t, other);   // another home
    await refused('device_is_thing', "INSERT INTO device (id, site_id, kind, provider, external_ref) VALUES (?, ?, 'battery', 'p', 'a-home')", s, s);   // the id of a home thing
  });
});

await test('deleting the site or the device deletes its thing, and a home\'s things with it, inside a logged erasure', async () => {
  const s = await site('Delete home');
  const d = await device(s, 'battery', 'b4');
  const space = await ins("INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'space', 'room', 'A room')", s);
  await run('DELETE FROM binding WHERE site_id = ?', s);
  await assert.rejects(() => run('DELETE FROM device WHERE id = ?', d), /append-only/, 'the versions of its thing are append-only: only an erasure removes them');
  await erase({ kind: 'synthetic', siteId: s, reason: 'rules test: a device and a home deleted' }, async () => {
    await run('DELETE FROM device WHERE id = ?', d);
    assert.equal(await thing(d), undefined, 'the device thing went with its device');
    maintained('device_delete_thing');
    await run('DELETE FROM site WHERE id = ?', s);
  });
  maintained('site_delete_thing');
  for (const id of [s, d, space]) assert.equal(await thing(id), undefined, `thing ${id}`);
});

await test('what the cases above proved is what test/rules/fold.json declares (test/rules-all.test.js checks every area against the database)', () => { checkDeclared(); });
