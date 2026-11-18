// Derived points as data (plan 2.8, src/core/derived.js): formulas, their inputs and their order, missing values that stay missing, and the
// first three definitions (home use by energy balance, untracked consumption, COP). Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, evalTree, namesIn, orderDefs, evaluateSlot } from '../src/core/derived.js';
import { DERIVED } from '../src/db/seed/derived.js';

const ev = (text, values = {}) => evalTree(parseFormula(text), values);

await test('the arithmetic: precedence, unary minus, functions; a missing input makes a missing value', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('-a + 5', { a: 2 }), 3);
  assert.equal(ev('max(a, b) - min(a, b)', { a: 2, b: 5 }), 3);
  assert.equal(ev('abs(a)', { a: -4 }), 4);
  assert.equal(ev('a / b', { a: 1, b: 0 }), null, 'a division by zero is missing, not infinite');
  assert.equal(ev('a + b', { a: 1, b: null }), null);
  assert.equal(ev('a + b', { a: 1 }), null, 'an input not given is missing');
  assert.equal(ev('ratio(a, b, 0.001)', { a: 3, b: 0.0005 }), null, 'below the floor there is no ratio');
  assert.equal(ev('ratio(a, b, 0.001)', { a: 3, b: 1 }), 3);
  assert.deepEqual([...namesIn(parseFormula('a * (b + c) - max(a, d)'))].sort(), ['a', 'b', 'c', 'd']);
});

await test('a formula that is wrong is refused with what is wrong', () => {
  assert.throws(() => parseFormula('a + $'), /"\$" does not belong/);
  assert.throws(() => parseFormula('a +'), /ends too soon/);
  assert.throws(() => parseFormula('(a + b'), /expected \)/);
  assert.throws(() => parseFormula('sqrt(a)'), /not a function/);
  assert.throws(() => parseFormula('max(a)'), /takes 2 arguments/);
  assert.throws(() => parseFormula('a b'), /unexpected/);
});

await test('the order: an input is worked out before what uses it; a circle, an undeclared and an unused input are refused', () => {
  const defs = [
    { code: 'c', formula: 'b * 2', inputs: { b: { derived: 'b' } } },
    { code: 'a', formula: 'x + 1', inputs: { x: { metric: 'x' } } },
    { code: 'b', formula: 'a + 1', inputs: { a: { derived: 'a' } } },
  ];
  assert.deepEqual(orderDefs(defs).map((d) => d.code), ['a', 'b', 'c']);
  assert.throws(() => orderDefs([{ code: 'p', formula: 'q', inputs: { q: { derived: 'q' } } }, { code: 'q', formula: 'p', inputs: { p: { derived: 'p' } } }]), /in a circle: p > q > p/);
  assert.throws(() => orderDefs([{ code: 'p', formula: 'x + y', inputs: { x: { metric: 'x' } } }]), /y, which is not an input/);
  assert.throws(() => orderDefs([{ code: 'p', formula: 'x', inputs: { x: { metric: 'x' }, z: { metric: 'z' } } }]), /input z is never used/);
  assert.throws(() => orderDefs([{ code: 'p', formula: 'x', inputs: { x: { derived: 'nope' } } }]), /not defined/);
});

await test('home use by energy balance, untracked consumption and COP, with the lineage of each value', () => {
  const slot = { solar_kwh: 2, grid_import_kwh: 1, grid_export_kwh: 0.5, battery_discharge_kwh: 0.2, battery_charge_kwh: 0.1, plug_kwh: 0.3, heat_output_kwh: 3, heatpump_elec_kwh: 1 };
  const r = evaluateSlot(DERIVED, slot);
  assert.equal(r.home_use_kwh.value, 2.6);
  assert.ok(Math.abs(r.untracked_kwh.value - 1.3) < 1e-9, 'home use less the plug and the heat pump; no car, so none taken');
  assert.equal(r.heatpump_cop.value, 3);
  assert.deepEqual(r.untracked_kwh.lineage.map((l) => [l.name, l.from]), [['home_use', 'derived:home_use_kwh'], ['plug', 'plug_kwh'], ['ev', 'ev_delivered_kwh'], ['heat_pump', 'heatpump_elec_kwh']]);
  assert.deepEqual(r.untracked_kwh.lineage.find((l) => l.name === 'ev'), { name: 'ev', from: 'ev_delivered_kwh', value: 0 }, 'a home with no car: the car is 0');
});

await test('a home without a sun or a battery uses what it imports; a point with no value this slot makes the figure missing, never a guess', () => {
  assert.equal(evaluateSlot(DERIVED, { grid_import_kwh: 1.5 }).home_use_kwh.value, 1.5);
  const missing = evaluateSlot(DERIVED, { solar_kwh: 2, grid_import_kwh: null, grid_export_kwh: 0 });
  assert.equal(missing.home_use_kwh.value, null);
  assert.equal(missing.untracked_kwh.value, null, 'what is worked out of a missing value is missing');
  assert.equal(evaluateSlot(DERIVED, { heat_output_kwh: 3, heatpump_elec_kwh: 0 }).heatpump_cop.value, null);
  assert.equal(evaluateSlot(DERIVED, { grid_import_kwh: 1 }).heatpump_cop.value, null, 'no heat pump: no COP');
});
