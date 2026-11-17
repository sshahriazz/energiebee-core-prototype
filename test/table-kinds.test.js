// Every table is classified (src/db/table-kinds.js), and every configuration table carries valid time and record time
// (fix list R19): a build "as known at" a past moment needs every input versioned. A new table fails here until it is
// classified; a new configuration table fails until it has valid_from, valid_to, recorded_at and superseded_at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { db, tableNames, columnsOf } = await import('../src/db/db.js');
const { TABLE_KINDS, LEGACY_CONFIG, RECORD_TIME, VALID_TIME } = await import('../src/db/table-kinds.js');
const tables = await tableNames();

await test('every table has a kind, and every listed table exists', () => {
  assert.deepEqual(tables.filter((t) => !TABLE_KINDS[t]), [], 'classify these in src/db/table-kinds.js');
  assert.deepEqual(Object.keys(TABLE_KINDS).filter((t) => !tables.includes(t)), [], 'listed but not in the schema');
});

await test('a configuration table has valid time and record time, unless it is a listed table from before the rule', async () => {
  const missing = [];
  for (const t of tables.filter((x) => TABLE_KINDS[x] === 'config' && !LEGACY_CONFIG[x])) {
    const cols = new Set(await columnsOf(t));
    const lack = [...VALID_TIME, ...RECORD_TIME].filter((c) => !cols.has(c));
    if (lack.length) missing.push(`${t}: ${lack.join(', ')}`);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(LEGACY_CONFIG).filter((t) => TABLE_KINDS[t] !== 'config'), [], 'the legacy list holds configuration tables only');
});

await test('a legacy configuration table is listed only while it lacks the rule: one that gains it leaves the list', async () => {
  const complete = [];
  for (const t of Object.keys(LEGACY_CONFIG)) {
    const cols = new Set(await columnsOf(t));
    if ([...VALID_TIME, ...RECORD_TIME].every((c) => cols.has(c))) complete.push(t);
  }
  assert.deepEqual(complete, []);
});

await test('a fact table has record time', async () => {
  for (const t of tables.filter((x) => TABLE_KINDS[x] === 'fact')) {
    const cols = new Set(await columnsOf(t));
    assert.ok(cols.has('recorded_at') || cols.has('fetched_at'), `${t} has no record time`);
  }
});
