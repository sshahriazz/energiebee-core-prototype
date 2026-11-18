// planGraph is pure: facts in, a plan out (plan 1.4 and 1.5). The cases name what the evidence shows and what the plan makes of it;
// the same plan on a real database is proved in test/energy-graph-gb.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();   // the module opens the database when it is loaded; the plan itself never reads it
const { planGraph, isEmptyPlan, HOME_WIDE } = await import('../src/core/energy-graph.js');

const HOME = 1;
const dev = (id, type, name = type, o = {}) => ({ id, kind: 'device', type, name, valid_from: 0, retired: false, ...o });
const facts = (things = [], evidence = {}, relations = []) => ({
  home: { id: HOME, valid_from: 0 },
  things, relations,
  evidence: { inverterProvider: false, pv: false, battery: false, pvReadings: false, batteryReadings: false, ...evidence },
});
// Home 1 as it is today: three meters and the car; a Sunsynk connection and the four plant numbers.
const home1 = () => facts([dev(5, 'meter_export'), dev(6, 'meter_import'), dev(7, 'meter_gas'), dev(8, 'ev')], { inverterProvider: true, pv: true, battery: true });

const types = (plan) => plan.create.map((c) => c.type).sort();
const count = (plan, rel) => plan.relate.filter((r) => r.rel === rel).length;
// What the database would hold after the plan: things with ids from 100, the relations as rows.
const after = (f, plan) => {
  const ids = new Map(plan.create.map((c, i) => [c.key, 100 + i]));
  const id = (r) => (typeof r === 'string' ? ids.get(r) : r);
  const kind = (t) => (['floor', 'room', 'garage', 'loft', 'outdoor', 'outside_wall', 'driveway'].includes(t) ? 'space' : t === 'solar_battery' ? 'system' : 'device');
  return {
    ...f,
    things: [...f.things, ...plan.create.map((c) => ({ id: ids.get(c.key), kind: kind(c.type), type: c.type, name: c.name, valid_from: 0, retired: false }))],
    relations: [...f.relations, ...plan.relate.map((r) => ({ from: id(r.from), fromPort: r.fromPort, rel: r.rel, to: id(r.to), toPort: r.toPort }))],
  };
};

await test('home 1: the plant is made from its connection and numbers, wired by ports, with two spaces', () => {
  const plan = planGraph(home1());
  assert.deepEqual(types(plan), ['battery', 'driveway', 'grid_connection', 'home_supply', 'inverter', 'outside_wall', 'pv_array', 'solar_battery']);
  assert.equal(plan.wired, true);
  assert.deepEqual([count(plan, 'located_in'), count(plan, 'part_of'), count(plan, 'feeds'), count(plan, 'meters')], [11, 3, 9, 2]);
  assert.equal(plan.relate.length, 25);
  const feeds = plan.relate.filter((r) => r.rel === 'feeds').map((r) => `${r.from}.${r.fromPort}>${r.to}.${r.toPort}`);
  const key = (type) => plan.create.find((c) => c.type === type).key;
  for (const e of [
    `${key('grid_connection')}.meter>6.grid`, `${key('grid_connection')}.meter>5.grid`,
    `6.load>${key('inverter')}.grid`, `5.load>${key('inverter')}.grid`,
    `${key('pv_array')}.dc>${key('inverter')}.pv`,
    `${key('inverter')}.battery>${key('battery')}.charge`, `${key('battery')}.discharge>${key('inverter')}.battery`,
    `${key('inverter')}.ac>${key('home_supply')}.in`, `${key('home_supply')}.out>8.charge`,
  ]) assert.ok(feeds.includes(e), `feeds ${e}`);
  const placed = new Map(plan.relate.filter((r) => r.rel === 'located_in').map((r) => [r.from, r.to]));
  assert.deepEqual([5, 6, 7].map((m) => placed.get(m)), Array(3).fill(key('outside_wall')), 'the meters hang on the outside wall');
  assert.equal(placed.get(8), key('driveway'), 'the car stands on the driveway');
  for (const type of HOME_WIDE) if (plan.create.some((c) => c.type === type)) assert.equal(placed.get(key(type)), HOME, `${type} is at home level`);
  assert.equal(placed.get(key('outside_wall')), HOME);
  assert.equal(plan.relate.filter((r) => r.rel === 'feeds').some((r) => r.from === 7 || r.to === 7), false, 'the gas meter has no consumer thing');
});

await test('planning again over the result plans nothing', () => {
  const f = home1();
  assert.ok(isEmptyPlan(planGraph(after(f, planGraph(f)))));
});

await test('no evidence, no thing: a bare home plans nothing, and a home with a battery and no inverter invents none', () => {
  assert.ok(isEmptyPlan(planGraph(facts())));
  const plan = planGraph(facts([dev(9, 'battery')]));
  assert.deepEqual(types(plan), ['solar_battery'], 'the battery is part of a system, nothing else is made');
  assert.equal(plan.relate.filter((r) => r.rel === 'feeds').length, 0, 'a battery with no inverter is not wired');
});

await test('a retired battery is not made again, and a relation that is missing is written alone', () => {
  const f = home1();
  const plan = planGraph(f);
  const made = after(f, plan);
  const battery = made.things.find((t) => t.type === 'battery');
  battery.retired = true;
  assert.ok(isEmptyPlan(planGraph(made)), 'nothing comes back');
  const owner = after(f, plan);
  const meters = owner.relations.filter((r) => r.rel === 'meters');
  owner.relations = owner.relations.filter((r) => r !== meters[0]);
  assert.equal(planGraph(owner).relate.length, 1, 'only the relation that is missing');
  assert.ok(isEmptyPlan(planGraph(after(f, plan))), 'a row that is there, ended or not, is not written again');
});

await test('an export-only home gets its connection and supply and wires the meter to the supply', () => {
  const plan = planGraph(facts([dev(2, 'meter_export')]));
  assert.deepEqual(types(plan), ['grid_connection', 'home_supply', 'outside_wall']);
  const feeds = plan.relate.filter((r) => r.rel === 'feeds');
  assert.equal(feeds.length, 2, 'connection to the meter, the meter to the supply');
  assert.equal(feeds.find((r) => r.from === 2).toPort, 'in');
});

await test('two inverters: only what is certain is written, and the plan says it is not wired', () => {
  const plan = planGraph(facts([dev(2, 'inverter', 'A'), dev(3, 'inverter', 'B'), dev(4, 'meter_import')], {}));
  assert.equal(plan.wired, false);
  const feeds = plan.relate.filter((r) => r.rel === 'feeds');
  assert.equal(feeds.length, 1, 'only the connection to the meter is certain');
  assert.deepEqual([feeds[0].fromPort, feeds[0].to, feeds[0].toPort], ['meter', 4, 'grid']);
});

await test('a declared topology: the synthetic home names its inverter and its rooms', () => {
  const f = facts([dev(2, 'smart_plug'), dev(3, 'heat_pump'), dev(4, 'ev_charger'), dev(5, 'battery'), dev(6, 'temperature_sensor')], { battery: true });
  const plan = planGraph(f, { inverter: 'Inverter (synthetic)', rooms: [{ name: 'Living room', things: [2, 6] }, { name: 'Utility room', things: [3] }] });
  assert.deepEqual(types(plan), ['driveway', 'grid_connection', 'home_supply', 'inverter', 'room', 'room', 'solar_battery']);
  assert.equal(plan.create.find((c) => c.type === 'inverter').name, 'Inverter (synthetic)');
  const placed = new Map(plan.relate.filter((r) => r.rel === 'located_in').map((r) => [r.from, r.to]));
  const room = (name) => plan.create.find((c) => c.name === name).key;
  assert.equal(placed.get(2), room('Living room'));
  assert.equal(placed.get(6), room('Living room'));
  assert.equal(placed.get(3), room('Utility room'), 'a heat pump may be in a room when the caller says so');
  assert.equal(placed.get(4), plan.create.find((c) => c.type === 'driveway').key);
  assert.equal(placed.get(5), HOME, 'the battery has no room');
  const asked = planGraph(facts([dev(2, 'battery')], { battery: true }), { rooms: [{ name: 'Cupboard', things: [2] }] });
  assert.equal(asked.relate.find((r) => r.from === 2 && r.rel === 'located_in').to, HOME, 'a home-wide device is refused a room even when asked');
  const feeds = plan.relate.filter((r) => r.rel === 'feeds').map((r) => `${r.fromPort}>${r.to}.${r.toPort}`);
  assert.ok(feeds.includes('out>2.in') && feeds.includes('out>3.ac') && feeds.includes('out>4.ac'), 'the supply feeds the plug, the heat pump and the charger');
  assert.ok(isEmptyPlan(planGraph(after(f, plan), { inverter: 'Inverter (synthetic)', rooms: [{ name: 'Living room', things: [2, 6] }, { name: 'Utility room', things: [3] }] })), 'idempotent with the same declaration');
});

await test('a car behind a charger is fed by the charger, not by the supply', () => {
  const plan = planGraph(facts([dev(2, 'ev_charger'), dev(3, 'ev'), dev(4, 'meter_import')]));
  const feeds = plan.relate.filter((r) => r.rel === 'feeds').map((r) => `${r.from}.${r.fromPort}>${r.to}.${r.toPort}`);
  assert.ok(feeds.includes('2.ev>3.charge'));
  assert.equal(feeds.filter((e) => e.endsWith('>3.charge')).length, 1);
});
