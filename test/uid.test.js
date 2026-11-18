// Stable identity (fix list R3): homes, devices and connections carry a UUIDv7 uid beside the integer id. It is made once
// (by the database, or by the hub that discovered a device), sorts by creation time, and survives a copy to another
// database, where the integer ids may be renumbered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useDb, adminUrl } from './helpers.js';
import { applyMigrations, createDatabase, dropDatabase, loadTables, postgresTables, withClient } from '../scripts/lib/databases.js';

const url = await useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

await test('every home, device and connection gets a UUIDv7, unique and in creation order', async () => {
  const a = await createSite({ name: 'first' });
  const b = await createSite({ name: 'second' });
  const ua = (await db.prepare('SELECT uid FROM site WHERE id = ?').get(a.id)).uid;
  const ub = (await db.prepare('SELECT uid FROM site WHERE id = ?').get(b.id)).uid;
  assert.match(ua, V7); assert.match(ub, V7);
  assert.ok(ua < ub, 'a later home sorts after an earlier one');
  const d = await addDevice({ siteId: a.id, kind: 'battery', provider: 'test', externalRef: 'b1' });
  assert.match(d.uid, V7);
  await db.prepare("INSERT INTO connection (site_id, provider, external_ref) VALUES (?, 'test', 'x')").run(a.id);
  assert.match((await db.prepare('SELECT uid FROM connection WHERE site_id = ?').get(a.id)).uid, V7);
});

await test('a hub that discovered a device gives its uid, and it is kept; the same uid twice is refused', async () => {
  const s = await createSite({ name: 'hub home' });
  const uid = '01900000-0000-7000-8000-000000000001';
  assert.equal((await addDevice({ siteId: s.id, kind: 'battery', provider: 'hub', externalRef: 'h1', uid })).uid, uid);
  await assert.rejects(async () => await addDevice({ siteId: s.id, kind: 'battery', provider: 'hub', externalRef: 'h2', uid }), /UNIQUE constraint failed: thing_uid_key/);
});

await test('a copy to another database keeps every uid, whatever happens to the integer ids', async () => {
  // Things and the seeded thing types hold jsonb arrays and objects: the copy must send them as JSON text, not as Postgres arrays.
  const { createThing } = await import('../src/core/things.js');
  const home = await createSite({ name: 'thing copy home' });
  const t = await createThing({ siteId: home.id, type: 'inverter', name: 'copied inverter' });
  const before = await db.prepare('SELECT id, uid FROM device ORDER BY id').all();
  const typesBefore = await db.prepare('SELECT type, capabilities, ports, attribute_keys FROM thing_type ORDER BY type').all();
  const name = `energiebee_t_uidcopy_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const copy = await createDatabase(name, adminUrl);
  try {
    await applyMigrations(copy);
    await loadTables(copy, postgresTables(url));
    const after = await withClient(copy, async (c) => (await c.query('SELECT id::int AS id, uid::text AS uid FROM device ORDER BY id')).rows);
    assert.deepEqual(after, before);
    const typesAfter = await withClient(copy, async (c) => (await c.query('SELECT type, capabilities, ports, attribute_keys FROM thing_type ORDER BY type')).rows);
    assert.ok(typesAfter.length > 0 && Array.isArray(typesAfter[0].capabilities));
    assert.deepEqual(typesAfter, typesBefore);
    const thingAfter = await withClient(copy, async (c) => (await c.query('SELECT uid::text AS uid, name FROM thing WHERE name = $1', ['copied inverter'])).rows);
    assert.deepEqual(thingAfter, [{ uid: t.uid, name: 'copied inverter' }]);
  } finally { await dropDatabase(name, adminUrl); }
});
