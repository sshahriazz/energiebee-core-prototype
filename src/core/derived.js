// Derived points as data (plan 2.8, R5): a value that is not read from anywhere but worked out of other points by a formula, with
// its inputs named and its place in an order of evaluation, so a figure such as "the home's use by energy balance" is one definition
// that every reader shares, not code in each of them. PURE: no database, no clock. The definitions are rows (src/db/seed/derived.js);
// the values they work on come from the caller (a slot of point values, once the point slots of Phase 3 hold them).
//
//   formula   text in a small arithmetic: numbers, input names, + - * /, parentheses, unary minus, and the functions
//             max(a, b), min(a, b), abs(a) and ratio(a, b, floor)   (a / b, or missing when b is not above floor)
//   inputs    { name: { metric, optional? } } or { name: { derived: 'code' } }: a point of the home (summed over the things that carry
//             it) or another derived point. An optional input is 0 when the home has no such point at all; a point that exists
//             but has no value in the slot is missing, and missing makes the whole value missing (never a guess).
//   order     the definitions in the order they can be worked out (an input is worked out before what uses it); a cycle is refused.

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y;

/** Parse a formula to a tree. Throws a RangeError naming the character or word that does not belong. */
export function parseFormula(text) {
  const toks = [];
  TOKEN.lastIndex = 0;
  for (let m; TOKEN.lastIndex < text.length && (m = TOKEN.exec(text));) {
    if (m[1] != null) toks.push({ num: Number(m[1]) });
    else if (m[2] != null) toks.push({ id: m[2] });
    else if ('+-*/(),'.includes(m[3])) toks.push({ op: m[3] });
    else if (m[3].trim() !== '') throw new RangeError(`formula ${JSON.stringify(text)}: ${JSON.stringify(m[3])} does not belong`);
  }
  let i = 0;
  const peek = () => toks[i];
  const eat = (op) => { if (peek()?.op === op) { i++; return true; } return false; };
  const need = (op) => { if (!eat(op)) throw new RangeError(`formula ${JSON.stringify(text)}: expected ${op}`); };
  const FNS = { max: 2, min: 2, abs: 1, ratio: 3 };
  function atom() {
    const t = toks[i++];
    if (!t) throw new RangeError(`formula ${JSON.stringify(text)}: ends too soon`);
    if (t.num != null) return { n: t.num };
    if (t.op === '(') { const e = sum(); need(')'); return e; }
    if (t.op === '-') return { neg: atom() };
    if (t.id != null) {
      if (eat('(')) {
        if (!(t.id in FNS)) throw new RangeError(`formula ${JSON.stringify(text)}: ${t.id}() is not a function (one of ${Object.keys(FNS).join(', ')})`);
        const args = [];
        if (!eat(')')) { do args.push(sum()); while (eat(',')); need(')'); }
        if (args.length !== FNS[t.id]) throw new RangeError(`formula ${JSON.stringify(text)}: ${t.id}() takes ${FNS[t.id]} arguments`);
        return { fn: t.id, args };
      }
      return { ref: t.id };
    }
    throw new RangeError(`formula ${JSON.stringify(text)}: unexpected ${t.op}`);
  }
  function product() { let l = atom(); for (;;) { if (eat('*')) l = { op: '*', l, r: atom() }; else if (eat('/')) l = { op: '/', l, r: atom() }; else return l; } }
  function sum() { let l = product(); for (;;) { if (eat('+')) l = { op: '+', l, r: product() }; else if (eat('-')) l = { op: '-', l, r: product() }; else return l; } }
  const tree = sum();
  if (i < toks.length) throw new RangeError(`formula ${JSON.stringify(text)}: unexpected ${toks[i].op ?? toks[i].id ?? toks[i].num}`);
  return tree;
}

/** The input names a parsed formula uses. */
export function namesIn(tree, out = new Set()) {
  if (tree.ref != null) out.add(tree.ref);
  for (const k of ['l', 'r', 'neg']) if (tree[k]) namesIn(tree[k], out);
  for (const a of tree.args ?? []) namesIn(a, out);
  return out;
}

/** The value of a tree for named values; a missing input (null) makes the result missing (null). */
export function evalTree(tree, values) {
  const go = (t) => {
    if (t.n != null) return t.n;
    if (t.ref != null) { const v = values[t.ref]; return v == null ? null : v; }
    if (t.neg) { const v = go(t.neg); return v == null ? null : -v; }
    if (t.fn) {
      const a = t.args.map(go);
      if (a.some((v) => v == null)) return null;
      if (t.fn === 'max') return Math.max(a[0], a[1]);
      if (t.fn === 'min') return Math.min(a[0], a[1]);
      if (t.fn === 'abs') return Math.abs(a[0]);
      return a[1] > a[2] ? a[0] / a[1] : null;   // ratio(a, b, floor)
    }
    const l = go(t.l); const r = go(t.r);
    if (l == null || r == null) return null;
    return t.op === '+' ? l + r : t.op === '-' ? l - r : t.op === '*' ? l * r : (r === 0 ? null : l / r);
  };
  return go(tree);
}

/**
 * The definitions in the order they can be worked out. A definition is { code, formula, inputs }. Throws on a cycle, on an input a
 * formula uses that is not declared, and on a declared input the formula never uses.
 */
export function orderDefs(defs) {
  const byCode = new Map(defs.map((d) => [d.code, d]));
  for (const d of defs) {
    const names = namesIn(parseFormula(d.formula));
    for (const n of names) if (!(n in d.inputs)) throw new RangeError(`${d.code}: the formula uses ${n}, which is not an input`);
    for (const n of Object.keys(d.inputs)) if (!names.has(n)) throw new RangeError(`${d.code}: input ${n} is never used by the formula`);
    for (const [n, spec] of Object.entries(d.inputs)) if (spec.derived != null && !byCode.has(spec.derived)) throw new RangeError(`${d.code}: input ${n} is derived point ${spec.derived}, which is not defined`);
  }
  const out = []; const state = new Map();
  const visit = (d, path) => {
    if (state.get(d.code) === 2) return;
    if (state.get(d.code) === 1) throw new RangeError(`derived points depend on each other in a circle: ${[...path, d.code].join(' > ')}`);
    state.set(d.code, 1);
    for (const spec of Object.values(d.inputs)) if (spec.derived != null) visit(byCode.get(spec.derived), [...path, d.code]);
    state.set(d.code, 2); out.push(d);
  };
  for (const d of [...defs].sort((a, b) => (a.code < b.code ? -1 : 1))) visit(d, []);
  return out;
}

/**
 * Work out every definition for one slot. `points` gives, by metric code, the slot's value summed over the things of the home that carry
 * it: a number, null (the point exists and has no value this slot), or undefined (the home has no such point). Returns
 * { [code]: { value, lineage: [{ name, from, value }] } }, each value's lineage naming what it was worked out of.
 */
export function evaluateSlot(defs, points) {
  const done = {};
  for (const d of orderDefs(defs)) {
    const values = {}; const lineage = [];
    for (const [name, spec] of Object.entries(d.inputs)) {
      if (spec.derived != null) { values[name] = done[spec.derived].value; lineage.push({ name, from: `derived:${spec.derived}`, value: values[name] }); continue; }
      const v = points[spec.metric];
      values[name] = v === undefined ? (spec.optional ? 0 : null) : v;
      lineage.push({ name, from: spec.metric, value: v === undefined ? (spec.optional ? 0 : null) : v });
    }
    done[d.code] = { value: evalTree(parseFormula(d.formula), values), lineage };
  }
  return done;
}
