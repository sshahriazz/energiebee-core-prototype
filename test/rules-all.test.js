// Every trigger and exclusion constraint in the schema is covered by a rules-<area>.test.js case (fix list D1): the union of
// the declarations in test/rules/*.json is compared with what the database really has. A new rule without a case, a message
// no case produced, or a declaration of a rule that no longer exists fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';
import { rulesDir, triggersOf } from './rules/lib.js';

await useDb();
const { db } = await import('../src/db/db.js');

const declared = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.json')).map((f) => ({ area: path.basename(f, '.json'), ...JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8')) }));

await test('every trigger has a case in some area, and every message it can raise was produced', async () => {
  const have = new Map();
  for (const d of declared) {
    for (const [name, msgs] of Object.entries(d.triggers)) { const set = have.get(name) ?? have.set(name, new Set()).get(name); for (const m of msgs) set.add(m); }
  }
  const missing = [];
  for (const [name, msgs] of await triggersOf(db)) {
    if (!have.has(name)) { missing.push(`${name}: no case in any area`); continue; }
    for (const m of msgs) if (!have.get(name).has(m)) missing.push(`${name}: never refused with "${m}"`);
  }
  assert.deepEqual(missing, []);
  const real = await triggersOf(db);
  assert.deepEqual([...have.keys()].filter((n) => !real.has(n)), [], 'declared triggers that are not in the schema');
});

await test('every exclusion constraint was hit by some area', async () => {
  const real = (await db.prepare("SELECT conname FROM pg_constraint WHERE contype = 'x' AND connamespace = current_schema()::regnamespace").all()).map((r) => r.conname).sort();
  const seen = [...new Set(declared.flatMap((d) => d.exclusions))].sort();
  assert.deepEqual(seen, real);
});
