// The rules of control requests and what they rest on (plan 4.2 to 4.4), broken on purpose and refused (fix list D1). See test/rules/lib.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, checkDeclared } = await harness('controls');

const NOW = 1_800_000_000;
const site = (name) => ins('INSERT INTO site (name, created_at) VALUES (?, ?)', name, NOW);
const device = (siteId, kind, ref) => ins("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, ?, 'test', ?)", siteId, kind, ref);
const req = 'INSERT INTO control_request (home_id, thing_id, capability, action, desired, priority, valid_from, valid_until, source, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)';

await test('a control request is in the home of its thing, and never changes: it is cancelled once, or runs out', async () => {
  const a = await site('Requests A'); const b = await site('Requests B');
  const plug = await device(a, 'smart_plug', 'r-plug');
  await refused('control_request_home_matches', req, b, plug, 'on_off', 'on', '{}', 'manual', NOW, NOW + 60, 'test', NOW * 1000);
  const id = await ins(req, a, plug, 'on_off', 'on', '{}', 'manual', NOW, NOW + 60, 'test', NOW * 1000);
  maintained('control_request_home_matches');
  await refused('control_request_fixed', "UPDATE control_request SET priority = 'safety' WHERE id = ?", id);
  await refused('control_request_fixed', "UPDATE control_request SET desired = '{\"x\": 1}'::jsonb WHERE id = ?", id);
  await refused('control_request_uid_fixed', "UPDATE control_request SET uid = '01900000-0000-7000-8000-0000000000cc' WHERE id = ?", id);
  await run('UPDATE control_request SET cancelled_at = ? WHERE id = ?', NOW * 1000 + 5, id);
  await refused('control_request_fixed', 'UPDATE control_request SET cancelled_at = NULL WHERE id = ?', id);
  await assert.rejects(() => run(req, a, plug, 'on_off', 'on', '{}', 'whenever', NOW, NOW + 60, 'test', 1), /control_request_priority_check|violates check/);
  await assert.rejects(() => run(req, a, plug, 'on_off', 'on', '{}', 'manual', NOW + 60, NOW, 'test', 1), /control_request_window|violates check/);
  assert.equal((await get('SELECT COUNT(*) AS n FROM control_request WHERE thing_id = ?', plug)).n, 1);
});

await test('a device may be confirmed for an action its capabilities allow, though the kind\'s own list never named it', async () => {
  const a = await site('Capability A');
  const plug = await device(a, 'smart_plug', 'cap-plug');
  await run("INSERT INTO device_capability (device_id, action, supported, source, recorded_at) VALUES (?, 'on', 1, 'adapter', 0)", plug);
  await refused('device_capability_known_action', "INSERT INTO device_capability (device_id, action, supported, source, recorded_at) VALUES (?, 'melt', 1, 'adapter', 0)", plug);
});

await test('a scene keeps its uid', async () => {
  const a = await site('Scene A');
  const id = await ins("INSERT INTO scene (home_id, name, created_at, updated_at) VALUES (?, 'Evening', 0, 0)", a);
  await refused('scene_uid_fixed', "UPDATE scene SET uid = '01900000-0000-7000-8000-0000000000dd' WHERE id = ?", id);
});

await test('what the cases above proved is what test/rules/controls.json declares', () => { checkDeclared(); });
