// The rules of the thing graph (plan Phase 1.1 and 1.2): things, their attribute versions, the relation rules and the dated
// relations between things, broken on purpose and refused (fix list D1, plan rule 7). See test/rules/lib.js for how an area
// proves its rules and declares them in test/rules/things.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, excluded, checkDeclared } = await harness('things');
const { erase } = await import('../src/core/erasure.js');
const { THING_TYPES, RELATION_RULES, THING_ONLY_KEYS, thingSeedDiff, seedThings } = await import('../src/db/seed/things.js');
const { DEVICE_KINDS, ATTRIBUTE_DEFS } = await import('../src/db/seed/attributes.js');

const NOW = 1_800_000_000;   // seconds; a fixed moment keeps every case independent of the clock
const site = (name) => ins("INSERT INTO site (name, created_at, timezone, currency, country, market_code) VALUES (?, ?, 'Europe/London', 'GBP', 'GB', 'GB')", name, NOW);
const A = await site('A');
const B = await site('B');
const thing = (siteId, kind, type, name, attrs = {}) => ins('INSERT INTO thing (site_id, kind, type, name, attrs) VALUES (?, ?, ?, ?, ?::jsonb)', siteId, kind, type, name, JSON.stringify(attrs));
const context = (type, name) => ins('INSERT INTO thing (kind, type, name) VALUES (?, ?, ?)', 'context', type, name);

// Home A: the home thing, a floor with two rooms, and the energy devices of a solar and battery home.
const homeA = await thing(A, 'home', 'house', 'Home A', { timezone: 'Europe/London', slot_s: 1800 });
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
const homeB = await thing(B, 'home', 'flat', 'Home B');
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
  await assert.rejects(() => run("INSERT INTO thing (site_id, kind, type, name) VALUES (?, 'space', 'battery', 'x')", A), /thing_type_fk/, 'a type belongs to one kind');
  await assert.rejects(() => run("INSERT INTO relation_rule (rel, from_kind, from_type, to_kind) VALUES ('x', 'space', 'battery', 'space')"), /relation_rule_from_type_fk/);
});

await test('things: a home thing per home, a context thing has no home, everything else has one', async () => {
  await assert.rejects(() => thing(A, 'home', 'house', 'Second home A'), /UNIQUE constraint failed: thing_one_home/);
  await assert.rejects(() => run("INSERT INTO thing (kind, type, name) VALUES ('device', 'inverter', 'Homeless')"), /thing_home_unless_context/);
  await assert.rejects(() => run("INSERT INTO thing (site_id, kind, type, name) VALUES (?, 'context', 'region', 'Homed')", A), /thing_home_unless_context/);
  await assert.rejects(() => thing(A, 'device', 'inverter', '  '), /CHECK constraint failed/);
  await assert.rejects(() => run("INSERT INTO thing (site_id, kind, type, name, attrs) VALUES (?, 'device', 'inverter', 'x', '[]'::jsonb)", A), /CHECK constraint failed/);
  assert.ok(await get('SELECT uid FROM thing WHERE id = ?', homeA));
  assert.equal((await get('SELECT COUNT(*) AS n FROM thing WHERE site_id IS NULL')).n, 1);
});

await test('identity: a thing\'s uid, kind and home never change', async () => {
  await refused('thing_uid_fixed', 'UPDATE thing SET uid = uuidv7() WHERE id = ?', inverter);
  await refused('thing_identity_fixed', "UPDATE thing SET kind = 'system' WHERE id = ?", trv);
  await refused('thing_identity_fixed', 'UPDATE thing SET site_id = ? WHERE id = ?', B, trv);
  await run('UPDATE thing SET uid = uid, site_id = site_id, name = name WHERE id = ?', trv);   // an update that keeps them is fine
  await run("UPDATE thing SET type = 'thermostat' WHERE id = ?", trv);                          // a type may change within its kind
  await run("UPDATE thing SET type = 'trv' WHERE id = ?", trv);
});

await test('attributes: a thing carries only the keys its type lists', async () => {
  await refused('thing_attrs_allowed', "INSERT INTO thing (site_id, kind, type, name, attrs) VALUES (?, 'device', 'battery', 'x', '{\"flux\": 1}'::jsonb)", A);
  await refused('thing_attrs_allowed', 'UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ pv_kwp: 4 }), battery);
  await refused('thing_attrs_allowed', "UPDATE thing SET type = 'battery', attrs = attrs WHERE id = ?", pv);   // the keys must suit the new type too
  await run('UPDATE thing SET attrs = ?::jsonb WHERE id = ?', JSON.stringify({ capacity_kwh: 9.5, manufacturer: 'x' }), battery);
});

await test('attribute versions: written by triggers on every change of name or attributes, append-only', async () => {
  const versions = (id) => db.prepare('SELECT name, attrs, valid_from, recorded_at, superseded_at FROM thing_attr_version WHERE thing_id = ? ORDER BY recorded_at').all(id);
  const t = await thing(A, 'device', 'smart_plug', 'Plug', { model: 'P1' });
  let v = await versions(t);
  assert.equal(v.length, 1); maintained('thing_attr_version_on_insert');
  assert.deepEqual([v[0].name, v[0].attrs, v[0].superseded_at], ['Plug', { model: 'P1' }, null]);
  assert.equal((await get('SELECT site_id FROM thing_attr_version WHERE thing_id = ?', t)).site_id, A, 'the home is on the version row');
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
  await refused('thing_relation_checks', "INSERT INTO thing_relation (site_id, from_id, rel, to_id) VALUES (?, ?, 'controls', ?)", B, trv, inverter);
  const id = await relId(meter, 'supplied_on', tariff);
  assert.equal((await get('SELECT site_id FROM thing_relation WHERE id = ?', id)).site_id, A, 'set from the thing that has a home');
  await refused('thing_relation_checks', 'UPDATE thing_relation SET site_id = ? WHERE id = ?', B, id);
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'controls', ?)", meter, meter), /thing_relation_not_self/);
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
  await run('UPDATE thing_relation SET valid_to = ? WHERE id = ?', dayOne + 3600, first);                                       // the move ends the old placement at a slot boundary ...
  await relId(trv, 'located_in', kitchen, { vf: dayOne + 3600 });                                                                // ... and starts the new one
  assert.deepEqual((await db.prepare("SELECT to_id FROM thing_relation WHERE from_id = ? AND rel = 'located_in' ORDER BY valid_from").all(trv)).map((r) => r.to_id), [living, kitchen], 'the old placement stays in history');
  // Superseded rows are history: they do not block a current one.
  await run('UPDATE thing_relation SET superseded_at = recorded_at + 1 WHERE id = ?', first);
  await relId(trv, 'located_in', living, { vf: dayOne, vt: dayOne + 1800 });
  // No loop: a room on a floor cannot hold that floor, however far round.
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id) VALUES (?, 'located_in', ?)", floor, living);
  await refused('thing_relation_checks', 'UPDATE thing_relation SET to_id = ? WHERE from_id = ? AND to_id = ?', kitchen, floor, homeA);   // kitchen -> floor -> kitchen, by an update
  // Only relations that overlap in time can form a loop: the floor may sit in the room it contained, once that was over.
  const s1 = await thing(A, 'space', 'loft', 'Loft 1');
  const s2 = await thing(A, 'space', 'loft', 'Loft 2');
  await relId(s1, 'located_in', s2, { vf: 100, vt: 200 });
  await relId(s2, 'located_in', s1, { vf: 300, vt: 400 });
  await refused('thing_relation_checks', "INSERT INTO thing_relation (from_id, rel, to_id, valid_from, valid_to) VALUES (?, 'located_in', ?, 150, 250)", s2, s1);   // overlaps the first
});

await test('relations: the same edge never overlaps itself in time, and a window is snapped forward from the exact change', async () => {
  const feed = (vf, vt) => ['INSERT INTO thing_relation (from_id, from_port, rel, to_id, to_port, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', pv, 'dc', 'feeds', inverter, 'pv', vf, vt];
  await excluded('relation_no_overlap', ...feed(0, 10_000));    // the open feeds edge from above is current
  const open = await get("SELECT id FROM thing_relation WHERE from_id = ? AND rel = 'feeds'", pv);
  await run('UPDATE thing_relation SET superseded_at = recorded_at WHERE id = ?', open.id);
  await run(...feed(0, 100));
  await run(...feed(100, 200));                                   // adjacent windows do not overlap
  await excluded('relation_no_overlap', ...feed(150, 250));
  // changed_at is the exact moment, valid_from the slot boundary after it: never earlier
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, changed_at) VALUES (?, 'located_in', ?, 1800, 2000)", meter, floor), /thing_relation_snapped/);
  await assert.rejects(() => run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, valid_to) VALUES (?, 'located_in', ?, 20, 10)", meter, floor), /thing_relation_valid_window/);
  await run("INSERT INTO thing_relation (from_id, rel, to_id, valid_from, changed_at) VALUES (?, 'located_in', ?, 1800, 1510)", meter, floor);
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
  await thing(s, 'home', 'house', 'Home C');
  const d1 = await thing(s, 'device', 'inverter', 'I');
  const d2 = await thing(s, 'device', 'battery', 'B');
  await relId(d2, 'part_of', d1);
  await refused('thing_attr_version_append_only', 'DELETE FROM thing WHERE site_id = ?', s);   // the cascade reaches the versions
  await erase({ kind: 'synthetic', siteId: s, reason: 'rules test: a home with things' }, async () => await run('DELETE FROM thing WHERE site_id = ?', s));
  for (const t of ['thing', 'thing_attr_version', 'thing_relation']) assert.equal((await get(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, s)).n, 0, t);
  assert.ok(await get('SELECT 1 AS x FROM thing WHERE id = ?', tariff), 'shared context stays');
});

await test('what the cases above proved is what test/rules/things.json declares (test/rules-all.test.js checks every area against the database)', () => { checkDeclared(); });
