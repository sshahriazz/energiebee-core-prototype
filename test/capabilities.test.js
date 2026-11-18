// The capability registry (plan 2.1): the rows are the code's, every capability a thing type names is registered, every metric a
// capability's points name is a metric of the registry, and every action it allows is an action the core knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db } = await import('../src/db/db.js');
const { CAPABILITIES } = await import('../src/db/seed/capabilities.js');
const { THING_TYPES } = await import('../src/db/seed/things.js');

await test('the registry rows are the code\'s', async () => {
  const rows = await db.prepare('SELECT code, label, points, actions FROM capability ORDER BY code').all();
  assert.deepEqual(rows.map((r) => r.code), CAPABILITIES.map((c) => c.code).sort());
  for (const c of CAPABILITIES) assert.deepEqual(rows.find((r) => r.code === c.code).points, c.points, c.code);
  assert.ok(CAPABILITIES.length >= 11, 'the eleven of the plan');
});

await test('every capability a thing type names is registered', async () => {
  const codes = new Set(CAPABILITIES.map((c) => c.code));
  for (const t of THING_TYPES) for (const c of t.capabilities) assert.ok(codes.has(c), `${t.type} names ${c}`);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM thing_type t, jsonb_array_elements_text(t.capabilities) c WHERE NOT EXISTS (SELECT 1 FROM capability k WHERE k.code = c)").get()).n, 0);
});

await test('every point of a capability is on a metric of the registry, of a type that has the capability', async () => {
  const metrics = new Set((await db.prepare('SELECT code FROM metric').all()).map((m) => m.code));
  const typesWith = (cap) => new Set(THING_TYPES.filter((t) => t.capabilities.includes(cap)).map((t) => t.type));
  for (const c of CAPABILITIES) {
    for (const p of c.points) {
      assert.match(p.key, /^[a-z][a-z0-9_]*$/);
      assert.ok(['measurement', 'total', 'state', 'setpoint', 'event'].includes(p.class), `${c.code}.${p.key}: class`);
      assert.ok(['read', 'write', 'readwrite'].includes(p.access), `${c.code}.${p.key}: access`);
      for (const [type, metric] of Object.entries(p.metrics)) {
        assert.ok(metrics.has(metric), `${c.code}.${p.key}: ${metric} is not a metric`);
        assert.ok(typesWith(c.code).has(type), `${c.code}.${p.key}: ${type} does not have the capability ${c.code}`);
      }
    }
  }
});

await test('every action a capability allows is an action of the registry', async () => {
  const actions = new Set((await db.prepare('SELECT DISTINCT action FROM device_action').all()).map((a) => a.action));
  for (const c of CAPABILITIES) for (const a of c.actions) assert.ok(actions.has(a), `${c.code}: ${a} is not an action`);
});
