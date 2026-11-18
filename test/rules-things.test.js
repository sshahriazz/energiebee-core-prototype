// The rules of the thing graph (plan Phase 1.1 and 1.2): things, their attribute versions, the relation rules and the dated
// relations between things, broken on purpose and refused (fix list D1, plan rule 7). See test/rules/lib.js for how an area
// proves its rules and declares them in test/rules/things.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, excluded, checkDeclared } = await harness('things');
const { erase } = await import('../src/core/erasure.js');
const { rolledBack } = await import('../src/db/db.js');
const { THING_TYPES, RELATION_RULES, THING_ONLY_KEYS, thingSeedDiff, seedThings } = await import('../src/db/seed/things.js');
const { DEVICE_KINDS, ATTRIBUTE_DEFS } = await import('../src/db/seed/attributes.js');

const NOW = 1_800_000_000;   // seconds; a fixed moment keeps every case independent of the clock
const D0 = NOW - 8 * 3600;   // local midnight of that day in London (winter, on UTC): the homes below are on a 30-minute grid from it
const SLOT = 1800;
const site = (name) => ins("INSERT INTO site (name, created_at, timezone, currency, country, market_code) VALUES (?, ?, 'Europe/London', 'GBP', 'GB', 'GB')", name, NOW);
const A = await site('A');
const B = await site('B');
const thing = (siteId, kind, type, name, attrs = {}) => ins('INSERT INTO thing (home_id, kind, type, name, attrs) VALUES (?, ?, ?, ?, ?::jsonb)', siteId, kind, type, name, JSON.stringify(attrs));
const context = (type, name) => ins('INSERT INTO thing (kind, type, name) VALUES (?, ?, ?)', 'context', type, name);

// Home A: the home thing, a floor with two rooms, and the energy devices of a solar and battery home.
const homeA = A;   // a site's insert makes its home thing, with the site's id
await run('UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ timezone: 'Europe/London', slot_s: 1800 }), A);
const floor = await thing(A, 'space', 'floor', 'Ground floor');
const living = await thing(A, 'space', 'room', 'Living room');
const kitchen = await thing(A, 'space', 'room', 'Kitchen');
const inverter = await thing(A, 'device', 'inverter', 'Inverter');
const battery = await thing(A, 'device', 'battery', 'Battery');
const pv = await thing(A, 'device', 'pv_array', 'PV south', { pv_kwp: 4.2 });
const supply = await thing(A, 'device', 'home_supply', 'Consumer unit');
const meter = await thing(A, 'device', 'meter_import', 'Import meter');
const trv = await thing(A, 'device', 'trv', 'TRV');
const hub = await thing(A, 'device', 'hub', 'Hub');
const homeB = B;
const inverterB = await thing(B, 'device', 'inverter', 'Inverter B');
const tariff = await context('tariff', 'Flat tariff');

const rel = (from, rel, to, { fp = null, tp = null, vf = null, vt = null } = {}) =>
  run('INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', from, fp, rel, to, tp, vf, vt);
const relId = (...a) => rel(...a).then((r) => Number(r.lastInsertRowid));

await test('the registries: every device kind has a type, every attribute key and rule type is known, seeding is exact and idempotent', async () => {
  const types = new Set((await db.prepare('SELECT type FROM thing_type').all()).map((r) => r.type));
  for (const d of DEVICE_KINDS) assert.ok(types.has(d.kind) || d.kind === 'hot_water', `device kind ${d.kind} has a thing type (hot_water is the system type)`);
  assert.ok(types.has('hot_water'));
  const known = new Set([...ATTRIBUTE_DEFS.map((d) => d.key), ...THING_ONLY_KEYS]);
  for (const t of THING_TYPES) assert.deepEqual(t.attribute_keys.filter((k) => !known.has(k)), [], `${t.type}: attribute keys outside the attribute registry`);
  for (const r of RELATION_RULES) {
    for (const [kind, type] of [[r.from_kind, r.from_type], [r.to_kind, r.to_type]]) if (type) assert.equal(THING_TYPES.find((t) => t.type === type)?.kind, kind, `${r.rel}: ${type} is not a ${kind}`);
  }
  for (const t of THING_TYPES) assert.equal(new Set(t.ports.map((p) => p.name)).size, t.ports.length, `${t.type}: a port name repeats`);
  assert.deepEqual(await thingSeedDiff(db), { types: [], rules: [] }, 'nothing to write once seeded');
  assert.equal((await get('SELECT COUNT(*) AS n FROM thing_type')).n, THING_TYPES.length);
  assert.equal((await get('SELECT COUNT(*) AS n FROM relation_rule')).n, RELATION_RULES.length);
  // A row that differs from the code is brought back in line; a row the code does not list is left alone.
  await run("UPDATE thing_type SET label = 'changed', ports = '[]'::jsonb WHERE type = 'battery'");
  await run("UPDATE relation_rule SET flow = 0 WHERE rel = 'feeds' AND to_kind = 'space'");
  await run("INSERT INTO thing_type (type, kind, label) VALUES ('my_gadget', 'device', 'Own')");
  const diff = await thingSeedDiff(db);
  assert.deepEqual([diff.types.map((t) => t.type), diff.rules.map((r) => r.rel)], [['battery'], ['feeds']]);
  await seedThings(db, diff);
  assert.deepEqual(await thingSeedDiff(db), { types: [], rules: [] });
  assert.equal((await get("SELECT label FROM thing_type WHERE type = 'battery'")).label, 'Battery');
  assert.ok(await get("SELECT 1 AS x FROM thing_type WHERE type = 'my_gadget'"));
});

await test('registry shape: a port has a name, a direction and a medium, and a type keeps its kind', async () => {
  const t = (ports) => run("INSERT INTO thing_type (type, kind, label, ports) VALUES ('bad_type', 'device', 'Bad', ?::jsonb)", JSON.stringify(ports));
  await assert.rejects(() => t([{ name: 'a', dir: 'sideways', medium: 'ac' }]), /thing_type_ports_shape/);
  await assert.rejects(() => t([{ name: 'a', dir: 'in', medium: 'ac' }, { name: 'a', dir: 'out', medium: 'ac' }]), /thing_type_ports_shape/);
  await assert.rejects(() => t([{ name: 'a', dir: 'in' }]), /thing_type_ports_shape/);
  await assert.rejects(() => run("INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'space', 'battery', 'x')", A), /thing_type_fk/, 'a type belongs to one kind');
  await assert.rejects(() => run("INSERT INTO relation_rule (rel, from_kind, from_type, to_kind) VALUES ('x', 'space', 'battery', 'space')"), /relation_rule_from_type_fk/);
});

await test('things: a home thing is its own home, a context thing has no home, everything else has one', async () => {
  await refused('thing_home_rules', "INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'home', 'house', 'Second home A')", A);
  await refused('thing_home_rules', "INSERT INTO thing (kind, type, name) VALUES ('device', 'inverter', 'Homeless')");   // (the rule runs before the table check)
  await assert.rejects(() => run("INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'context', 'region', 'Homed')", A), /thing_home_unless_context/);
  await assert.rejects(() => thing(A, 'device', 'inverter', '  '), /CHECK constraint failed/);
  await assert.rejects(() => run("INSERT INTO thing (home_id, kind, type, name, attrs) VALUES (?, 'device', 'inverter', 'x', '[]'::jsonb)", A), /CHECK constraint failed/);
  assert.ok(await get('SELECT uid FROM thing WHERE id = ?', homeA));
  assert.equal((await get('SELECT COUNT(*) AS n FROM thing WHERE home_id IS NULL')).n, 1);
});

await test('identity: a thing\'s uid, kind, type and home never change; a hub\'s own uid is a UUIDv7', async () => {
  await refused('thing_uid_fixed', 'UPDATE thing SET uid = uuidv7() WHERE id = ?', inverter);
  await refused('thing_identity_fixed', "UPDATE thing SET kind = 'system' WHERE id = ?", trv);
  await refused('thing_identity_fixed', "UPDATE thing SET type = 'thermostat' WHERE id = ?", trv);   // even within its kind: a different type is a different thing
  await refused('thing_identity_fixed', "UPDATE thing SET type = 'generic_device' WHERE id = ?", trv);
  await refused('thing_identity_fixed', 'UPDATE thing SET home_id = ? WHERE id = ?', B, trv);
  await run('UPDATE thing SET uid = uid, home_id = home_id, type = type, kind = kind, name = name WHERE id = ?', trv);   // an update that keeps them is fine
  await assert.rejects(() => run("INSERT INTO thing (uid, home_id, kind, type, name) VALUES ('2f1c1b1e-4c3a-4b8e-9d3f-5a6b7c8d9e0f', ?, 'device', 'hub', 'Version 4')", A), /thing_uid_v7/);
});

await test('home: a thing belongs to a live home thing, and a home thing names its site\'s slot length and time zone', async () => {
  const D = await site('D');   // the site's insert made the home thing D
  await refused('thing_home_rules', "INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'device', 'inverter', 'In a device')", inverter);   // a device is no home
  await refused('thing_home_rules', "INSERT INTO thing (home_id, kind, type, name) VALUES (999999, 'space', 'room', 'Nowhere')");
  await refused('thing_home_rules', 'UPDATE thing SET home_id = ? WHERE id = ?', A, D);   // a home thing stays its own home
  await context('tariff', 'Tariff for D');   // shared context needs no home
  await refused('thing_home_clock', "UPDATE thing SET attrs = '{\"slot_s\": 900}'::jsonb WHERE id = ?", D);
  await refused('thing_home_clock', "UPDATE thing SET attrs = '{\"timezone\": \"Europe/Paris\"}'::jsonb WHERE id = ?", D);
  await run("UPDATE thing SET attrs = '{\"slot_s\": 1800, \"timezone\": \"Europe/London\"}'::jsonb WHERE id = ?", D);   // the site's own values are fine
  await thing(D, 'device', 'inverter', 'First');   // a live home thing takes things
  await run('UPDATE thing SET superseded_at = recorded_at WHERE id = ?', D);   // a superseded home thing is no home thing
  await refused('thing_home_rules', "INSERT INTO thing (home_id, kind, type, name) VALUES (?, 'device', 'inverter', 'Second')", D);
});

await test('attributes: a thing carries only the keys its type lists', async () => {
  await refused('thing_attrs_allowed', "INSERT INTO thing (home_id, kind, type, name, attrs) VALUES (?, 'device', 'battery', 'x', '{\"flux\": 1}'::jsonb)", A);
  await refused('thing_attrs_allowed', 'UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ pv_kwp: 4 }), battery);
  await run('UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ capacity_kwh: 9.5, manufacturer: 'x' }), battery);
});

await test('attribute versions: written by triggers on every change of name or attributes, append-only', async () => {
  const versions = (id) => db.prepare('SELECT name, attrs, valid_from, recorded_at, superseded_at FROM thing_attr_version WHERE thing_id = ? ORDER BY recorded_at').all(id);
  const t = await thing(A, 'device', 'smart_plug', 'Plug', { model: 'P1' });
  let v = await versions(t);
  assert.equal(v.length, 1); maintained('thing_attr_version_on_insert');
  assert.deepEqual([v[0].name, v[0].attrs, v[0].superseded_at], ['Plug', { model: 'P1' }, null]);
  assert.equal((await get('SELECT home_id FROM thing_attr_version WHERE thing_id = ?', t)).home_id, A, 'the home is on the version row');
  await run('UPDATE thing SET name = name, attrs = ?::jsonb WHERE id = ?', JSON.stringify({ model: 'P1' }), t);
  assert.equal((await versions(t)).length, 1, 'an update that changes nothing writes nothing');
  await run('UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ model: 'P2' }), t);
  await run("UPDATE thing SET name = 'Plug 2' WHERE id = ?", t);
  v = await versions(t);
  assert.deepEqual(v.map((r) => [r.name, r.attrs.model, r.superseded_at !== null]), [['Plug', 'P1', true], ['Plug', 'P2', true], ['Plug 2', 'P2', false]]);
  assert.ok(v[1].recorded_at > v[0].recorded_at && v[2].recorded_at > v[1].recorded_at, 'record time moves forward');
  assert.equal(v[0].superseded_at, v[1].recorded_at, 'a version ends when the next one is recorded');
  assert.equal(v[2].valid_from, Math.floor(v[2].recorded_at / 1000));
  maintained('thing_attr_version_on_update');
  const vid = (await get('SELECT id FROM thing_attr_version WHERE thing_id = ? AND superseded_at IS NULL', t)).id;
  await refused('thing_attr_version_append_only', "UPDATE thing_attr_version SET attrs = '{}'::jsonb WHERE id = ?", vid);
  await refused('thing_attr_version_append_only', 'DELETE FROM thing_attr_version WHERE id = ?', vid);
  await refused('thing_attr_version_append_only', 'DELETE FROM thing WHERE id = ?', t);   // its versions go with it, so a thing is not deleted either
  const old = (await get('SELECT id FROM thing_attr_version WHERE thing_id = ? AND superseded_at IS NOT NULL', t)).id;
  await refused('thing_attr_version_append_only', 'UPDATE thing_attr_version SET superseded_at = superseded_at + 1 WHERE id = ?', old);   // superseded once only
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM thing_attr_version WHERE thing_id = ? AND superseded_at IS NULL').get(t)).n, 1, 'one current version');
});

await test('relations: they join things of one home (or shared context), and the home is set from the things', async () => {
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'part_of', ?)", inverterB, battery);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (home_id, from_id, rel, to_id) VALUES (?, ?, 'controls', ?)", B, trv, inverter);
  const id = await relId(meter, 'supplied_on', tariff);
  assert.equal((await get('SELECT home_id FROM thing_relation WHERE id = ?', id)).home_id, A, 'set from the thing that has a home');
  await refused('thing_relation_append_only', 'UPDATE thing_relation SET home_id = ? WHERE id = ?', B, id);   // a relation is never edited
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'controls', ?)", meter, meter), /thing_relation_not_self/);
});

await test('relations are append-only and carry a uid: one supersede, never a change, never a delete', async () => {
  const id = await relId(supply, 'located_in', floor);
  const row = await get('SELECT uid, recorded_at FROM thing_relation WHERE id = ?', id);
  assert.match(row.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-7/, 'a UUIDv7 made by the database');
  await refused('thing_relation_append_only', 'UPDATE thing_relation SET valid_to = 5000000000 WHERE id = ?', id);
  await refused('thing_relation_append_only', "UPDATE thing_relation SET rel = 'part_of' WHERE id = ?", id);
  await refused('thing_relation_append_only', 'UPDATE thing_relation SET superseded_at = recorded_at, valid_from = 1 WHERE id = ?', id);   // supersede, and change something else
  await refused('thing_relation_append_only', 'DELETE FROM thing_relation WHERE id = ?', id);
  // the uid never changes: append-only refuses it first, so the trigger of the uid is reached only inside a logged erasure
  await erase({ kind: 'synthetic', siteId: A, reason: 'rules test: a relation uid under erasure' }, async () => {
    await rolledBack(async () => await refused('thing_relation_uid_fixed', 'UPDATE thing_relation SET uid = uuidv7() WHERE id = ?', id));
  });
  await run('UPDATE thing_relation SET superseded_at = recorded_at + 1 WHERE id = ?', id);
  await refused('thing_relation_append_only', 'UPDATE thing_relation SET superseded_at = superseded_at + 1 WHERE id = ?', id);   // superseded once only
  assert.equal((await get('SELECT uid FROM thing_relation WHERE id = ?', id)).uid, row.uid);
});

await test('relation rules: only what a rule allows, with the ports the rule asks for', async () => {
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'located_in', ?)", battery, inverter);    // no rule: a device is not located in a device
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'sings_to', ?)", battery, inverter);      // no such relation at all
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'supplied_on', ?)", inverter, tariff);   // only meters are supplied on a tariff
  // feeds: ports on both sides, directed, one medium
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id, to_port) VALUES (?, 'feeds', ?, 'pv')", pv, inverter);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id) VALUES (?, 'dc', 'feeds', ?)", pv, inverter);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'sun', 'feeds', ?, 'pv')", pv, inverter);   // PV has no port sun
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'charge', 'feeds', ?, 'battery')", battery, inverter);   // charge only receives
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'battery', 'feeds', ?, 'discharge')", inverter, battery); // discharge only sends
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'dc', 'feeds', ?, 'in')", pv, supply);             // dc into ac
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'dc', 'feeds', ?, 'pv')", pv, supply);             // supply has no port pv
  // no port where the rule takes none
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id) VALUES (?, 'x', 'controls', ?)", trv, inverter);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id, to_port) VALUES (?, 'controls', ?, 'x')", trv, inverter);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port) VALUES (?, 'flow', 'feeds', ?, 'x')", inverter, living);     // a room has no port
  // the energy graph of home A
  await relId(pv, 'feeds', inverter, { fp: 'dc', tp: 'pv' });
  await relId(inverter, 'feeds', battery, { fp: 'battery', tp: 'charge' });
  await relId(battery, 'feeds', inverter, { fp: 'discharge', tp: 'battery' });
  await relId(inverter, 'feeds', supply, { fp: 'ac', tp: 'in' });
  await relId(meter, 'meters', supply, { fp: 'load' });                    // a port is optional on a meter
  await relId(meter, 'meters', supply);
  await relId(trv, 'controls', inverter);
  await relId(trv, 'served_by', hub);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'served_by', ?)", trv, inverter);   // a hub, not any device
  assert.equal((await get("SELECT COUNT(*) AS n FROM thing_relation WHERE rel = 'feeds'")).n, 4);
});

await test('placement: a thing is in one place at a time, a move keeps the old placement, there is no loop', async () => {
  const dayOne = NOW - (NOW % 1800);
  await relId(living, 'located_in', floor);
  await relId(kitchen, 'located_in', floor);
  await relId(floor, 'located_in', homeA);
  const first = await relId(trv, 'located_in', living, { vf: dayOne });
  await excluded('located_in_one_place', "INSERT INTO thing_relation (from_id, rel, to_id, valid_from) VALUES (?, 'located_in', ?, ?)", trv, kitchen, dayOne + 3600);
  // The move supersedes the old row and writes it again with its end at a slot boundary (a superseded row is history: it blocks nothing) ...
  await run('UPDATE thing_relation SET superseded_at = recorded_at WHERE id = ?', first);
  await relId(trv, 'located_in', living, { vf: dayOne, vt: dayOne + 3600 });
  await relId(trv, 'located_in', kitchen, { vf: dayOne + 3600 });                                                                // ... and starts the new placement
  const placed = "SELECT to_id FROM thing_relation WHERE from_id = ? AND rel = 'located_in' AND superseded_at IS NULL ORDER BY valid_from";
  assert.deepEqual((await db.prepare(placed).all(trv)).map((r) => r.to_id), [living, kitchen], 'the old placement stays, with its end');
  assert.equal((await get("SELECT COUNT(*) AS n FROM thing_relation WHERE from_id = ? AND rel = 'located_in'", trv)).n, 3, 'and the row it replaced is still there');
  // No loop: a room on a floor cannot hold that floor, however far round.
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'located_in', ?)", floor, living);
  // Only relations that overlap in time can form a loop: the floor may sit in the room it contained, once that was over.
  const s1 = await thing(A, 'space', 'loft', 'Loft 1');
  const s2 = await thing(A, 'space', 'loft', 'Loft 2');
  await relId(s1, 'located_in', s2, { vf: D0, vt: D0 + 2 * SLOT });
  await relId(s2, 'located_in', s1, { vf: D0 + 4 * SLOT, vt: D0 + 6 * SLOT });
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id, valid_from, valid_to) VALUES (?, 'located_in', ?, ?, ?)", s2, s1, D0 + SLOT, D0 + 5 * SLOT);   // overlaps the first
});

await test('relations: the same edge never overlaps itself in time, a window is snapped forward from the exact change and lies on the home\'s grid', async () => {
  const feed = (vf, vt) => ['INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', pv, 'dc', 'feeds', inverter, 'pv', vf, vt];
  await excluded('relation_no_overlap', ...feed(D0, D0 + 6 * SLOT));    // the open feeds edge from above is current
  const open = await get("SELECT id FROM thing_relation WHERE from_id = ? AND rel = 'feeds'", pv);
  await run('UPDATE thing_relation SET superseded_at = recorded_at WHERE id = ?', open.id);
  await run(...feed(D0, D0 + SLOT));
  await run(...feed(D0 + SLOT, D0 + 2 * SLOT));                   // adjacent windows do not overlap
  await excluded('relation_no_overlap', ...feed(D0 + SLOT, D0 + 3 * SLOT));
  // changed_at is the exact moment, valid_from the slot boundary after it: never earlier
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, changed_at) VALUES (?, 'located_in', ?, ?, ?)", meter, floor, D0 + SLOT, D0 + SLOT + 200), /thing_relation_snapped/);
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, valid_to) VALUES (?, 'located_in', ?, ?, ?)", meter, floor, D0 + 2 * SLOT, D0 + SLOT), /thing_relation_valid_window/);
  const ok = await relId(meter, 'located_in', floor, { vf: D0 + SLOT });   // (and it is the placement used by the next case)
  await run('UPDATE thing_relation SET superseded_at = recorded_at WHERE id = ?', ok);
  await run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, changed_at) VALUES (?, 'located_in', ?, ?, ?)", meter, floor, D0 + SLOT, D0 + SLOT - 290);
  // a start or an end off the grid of the home is refused, whoever writes it (the slot grid starts at local midnight)
  const off = (vf, vt) => ['INSERT INTO thing_relation (from_id, rel, to_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)', battery, 'part_of', supply, vf, vt];
  await refused('thing_relation_checks', ...off(D0 + 1234, null));
  await refused('thing_relation_checks', ...off(D0 + 7 * SLOT, D0 + 8 * SLOT + 1));
  await refused('thing_relation_checks', ...off(NOW - 8 * 3600 + 17, D0 + 9 * SLOT));
  await run(...off(D0 + 7 * SLOT, D0 + 8 * SLOT));   // on the grid
  // the 25-hour day of 2027-10-31 in London: the grid counts elapsed time from local midnight, and the next midnight is on it
  const autumn = Date.UTC(2027, 9, 30, 23) / 1000;
  await run(...off(autumn + 24 * 3600 + SLOT, autumn + 25 * 3600));
  await refused('thing_relation_checks', ...off(autumn + 25 * 3600 + 900, null));
});

await test('no loop even when two writers each add half of one at the same moment', async () => {
  const { tx } = await import('../src/db/db.js');
  const r1 = await thing(A, 'space', 'loft', 'Race loft 1');
  const r2 = await thing(A, 'space', 'loft', 'Race loft 2');
  const edge = (a, b) => run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from) VALUES (?, 'located_in', ?, ?)", a, b, D0);
  let inserted; const firstIn = new Promise((resolve) => { inserted = resolve; });
  const first = tx(async () => {
    await edge(r1, r2);
    inserted();
    await new Promise((resolve) => setTimeout(resolve, 400));   // still open while the second writer inserts the other half
  });
  const second = firstIn.then(() => tx(async () => { await edge(r2, r1); }));
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(settled.map((x) => x.status), ['fulfilled', 'rejected'], 'the second writer waited for the first and saw its half');
  assert.match(settled[1].reason.message, /cannot form a cycle/);
});

await test('replacement: a new device replaces an old one of the same type, never in a loop', async () => {
  const inv2 = await thing(A, 'device', 'inverter', 'New inverter');
  const inv3 = await thing(A, 'device', 'inverter', 'Newer inverter');
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'replaces', ?)", battery, inverter);   // a battery does not replace an inverter
  await relId(inv2, 'replaces', inverter);
  await relId(inv3, 'replaces', inv2);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'replaces', ?)", inverter, inv3);
  await relId(battery, 'part_of', inverter);
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'part_of', ?)", inverter, battery);
});

await test('erasure: a home\'s things, versions and relations go with it inside a logged erasure, and only there', async () => {
  const { homeFootprint } = await import('../src/core/delete-home.js');
  const plan = await homeFootprint(B);   // home B has a home thing and an inverter
  assert.deepEqual(['thing', 'thing_attr_version'].filter((t) => !(t in plan.counts)), [], 'the home footprint finds the thing tables through the foreign keys');
  const s = await ins("INSERT INTO site (name, created_at, timezone, currency, country, market_code) VALUES ('C', ?, 'Europe/London', 'GBP', 'GB', 'GB')", NOW);
  const d1 = await thing(s, 'device', 'inverter', 'I');
  const d2 = await thing(s, 'device', 'battery', 'B');
  await relId(d2, 'part_of', d1);
  await run('DELETE FROM binding WHERE site_id = ?', s);   // the home's own default bindings first: the site row cannot go while they name it
  await assert.rejects(() => run('DELETE FROM site WHERE id = ?', s), /append-only/);   // the home thing goes with its site, and the cascade reaches the versions and the relation
  await erase({ kind: 'synthetic', siteId: s, reason: 'rules test: a home with things' }, async () => await run('DELETE FROM site WHERE id = ?', s));
  for (const t of ['thing', 'thing_attr_version', 'thing_relation']) assert.equal((await get(`SELECT COUNT(*) AS n FROM ${t} WHERE home_id = ?`, s)).n, 0, t);
  assert.ok(await get('SELECT 1 AS x FROM thing WHERE id = ?', tariff), 'shared context stays');
});

await test('merge: a thing is merged once, into a live thing of its own home and kind, and a merged thing takes no new relation', async () => {
  const a = await thing(A, 'device', 'smart_plug', 'Plug a');
  const b = await thing(A, 'device', 'smart_plug', 'Plug b');
  const c = await thing(A, 'device', 'smart_plug', 'Plug c');
  const space = await thing(A, 'space', 'room', 'Room m');
  const other = await thing(B, 'device', 'smart_plug', 'Plug of B');
  await assert.rejects(() => run("UPDATE thing SET merged_into = ? WHERE id = ?", b, a), /thing_merged_is_superseded/);   // merged and superseded together
  await refused('thing_merge_checks', 'UPDATE thing SET merged_into = ?, superseded_at = recorded_at WHERE id = ?', space, a);   // another kind
  await refused('thing_merge_checks', 'UPDATE thing SET merged_into = ?, superseded_at = recorded_at WHERE id = ?', other, a);   // another home
  await refused('thing_merge_checks', "INSERT INTO thing (home_id, kind, type, name, merged_into, superseded_at, recorded_at) VALUES (?, 'device', 'smart_plug', 'Born merged', ?, 5, 1)", A, b);
  await run('UPDATE thing SET merged_into = ?, superseded_at = recorded_at WHERE id = ?', b, a);
  await refused('thing_merge_checks', 'UPDATE thing SET merged_into = ?, superseded_at = recorded_at WHERE id = ?', c, a);          // merged once
  await refused('thing_merge_checks', 'UPDATE thing SET merged_into = ?, superseded_at = recorded_at WHERE id = ?', a, c);          // into a live thing: a is merged away
  await assert.rejects(() => run('UPDATE thing SET merged_into = id WHERE id = ?', c), /thing_merged_is_superseded|thing_merge_checks|merges into/);
  await refused('thing_relation_alive', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'located_in', ?)", a, space);
  await refused('thing_relation_alive', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'meters', ?)", c, a);
  await run("INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'located_in', ?)", b, space);                                // the survivor takes it
  const old = await run("INSERT INTO thing_relation (from_id, rel, to_id, superseded_at, recorded_at) VALUES (?, 'located_in', ?, 20, 10)", a, space);   // history rows of the merged thing stay writable
  assert.ok(old.lastInsertRowid);
  const op = (n, x, y) => run("INSERT INTO thing_op (home_id, op, thing_id, other_id, reason) VALUES (?, ?, ?, ?, ?)", A, n, x, y, 'because');
  await assert.rejects(() => op('shuffle', a, b), /CHECK constraint failed/);
  await assert.rejects(() => op('merge', a, a), /thing_op_two_things/);
  await refused('thing_op_home', "INSERT INTO thing_op (home_id, op, thing_id, other_id, reason) VALUES (?, 'merge', ?, ?, 'x')", B, a, b);        // another home than its things'
  await refused('thing_op_home', "INSERT INTO thing_op (home_id, op, thing_id, other_id, reason) VALUES (?, 'merge', ?, ?, 'x')", A, a, other);    // two homes
  await assert.rejects(() => run("INSERT INTO thing_op (home_id, op, thing_id, other_id, reason) VALUES (?, 'merge', ?, ?, ' ')", A, a, b), /CHECK constraint failed/);
  await op('merge', a, b);
  const logged = await get("SELECT id FROM thing_op WHERE thing_id = ? AND other_id = ?", a, b);
  assert.equal((await get('SELECT home_id FROM thing_op WHERE id = ?', logged.id)).home_id, A);
  await run("INSERT INTO thing_op (op, thing_id, other_id, reason) VALUES ('split', ?, ?, 'home taken from the things')", a, c);
  assert.equal((await get("SELECT home_id FROM thing_op WHERE reason = 'home taken from the things'")).home_id, A);
  await refused('thing_op_append_only', "UPDATE thing_op SET reason = 'rewritten' WHERE id = ?", logged.id);
  await refused('thing_op_append_only', 'DELETE FROM thing_op WHERE id = ?', logged.id);
});

await test('what the cases above proved is what test/rules/things.json declares (test/rules-all.test.js checks every area against the database)', () => { checkDeclared(); });
