// Plan item B11: the coverage matrix (docs/coverage-matrix.json) maps every item of the requirements
// catalogue (docs/predbat-predheat-requirements.md) to where the database design keeps it. On a fresh
// database opened through db.js (schema, every delta, every seed) this fails when
//   (a) a catalogue id has no matrix entry, (b) a matrix entry is not in the catalogue,
//   (c) a covered item has no target, (d) a target does not exist (a column by PRAGMA table_info, a
//       registry key by its row, a metric, source, device action or view by its row, a read function by
//       the export of src/core/planner-read.js, a JSON key by its list in docs/database.md: the check is
//       src/core/coverage.js, shared with GET /api/compatibility),
//   (e) a gap is not on the allow-list docs/coverage-gaps.md with a reason, or any gap (listed or not)
//       is a missing schema element: only items not storable by design may be allowed,
// and when the file is not what scripts/build-coverage-matrix.js builds now (rebuild it after a change).
// The catalogue ids are read here with a plain pattern, not with the generator's parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const readLayer = await import('../src/core/planner-read.js');
const { schemaContext, buildMatrix, render, renderReport } = await import('../scripts/build-coverage-matrix.js');
const { targetChecker, documentedJsonKeys, targetLabel } = await import('../src/core/coverage.js');

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const catalogueText = read('docs/predbat-predheat-requirements.md');
const databaseMd = read('docs/database.md');
const matrixText = read('docs/coverage-matrix.json');
const matrix = JSON.parse(matrixText);
const items = matrix.items;

// Every row of the catalogue's item tables starts with its id: PB-INV-01, PH-CFG-01, PD-01.
const catalogueIds = [...catalogueText.matchAll(/^\| ((?:PB|PH)-[A-Z]+-\d+|PD-\d+) \|/gm)].map((m) => m[1]);
const STATUSES = ['covered', 'excluded_not_data', 'gap'];

test('the catalogue is read whole: 416 Predbat, 54 PredHeat and 11 planning-design items, each once', () => {
  assert.equal(new Set(catalogueIds).size, catalogueIds.length, 'no id twice');
  assert.equal(catalogueIds.filter((i) => i.startsWith('PB-')).length, 416);
  assert.equal(catalogueIds.filter((i) => i.startsWith('PH-')).length, 54);
  assert.equal(catalogueIds.filter((i) => i.startsWith('PD-')).length, 11);
});

test('(a) every catalogue id has a matrix entry, and (b) every entry is a catalogue id, once, sorted by id', () => {
  const ids = items.map((i) => i.id);
  const inMatrix = new Set(ids);
  const inCatalogue = new Set(catalogueIds);
  assert.deepEqual(catalogueIds.filter((i) => !inMatrix.has(i)), [], 'catalogue ids with no matrix entry');
  assert.deepEqual(ids.filter((i) => !inCatalogue.has(i)), [], 'matrix entries not in the catalogue');
  assert.equal(inMatrix.size, ids.length, 'no entry twice');
  assert.deepEqual(ids, [...ids].sort(), 'sorted by id');
});

test('(c) every entry has a status; a covered one has targets, an excluded one a reason, a gap a kind and a description', () => {
  for (const it of items) {
    assert.ok(STATUSES.includes(it.status), `${it.id}: status ${it.status}`);
    assert.ok(it.name && Array.isArray(it.direction), `${it.id}: name and direction`);
    if (it.status === 'covered') assert.ok(Array.isArray(it.targets) && it.targets.length > 0, `${it.id}: covered with no target`);
    if (it.status === 'excluded_not_data') assert.ok(typeof it.reason === 'string' && it.reason.length > 20, `${it.id}: excluded with no reason`);
    if (it.status === 'gap') assert.ok(it.gap?.kind && it.gap?.description, `${it.id}: a gap states its kind and what is missing`);
  }
});

test('(d) every target exists in a fresh database and the read layer', () => {
  // The check is src/core/coverage.js, the same one GET /api/compatibility runs against the live database.
  // Read functions are planner-read exports only; JSON keys are those docs/database.md lists.
  const exists = targetChecker(db, { readModules: { 'planner-read': readLayer }, jsonKeys: documentedJsonKeys(databaseMd) });
  const missing = [];
  let n = 0;
  for (const it of items.filter((i) => i.status === 'covered')) {
    for (const t of it.targets) {
      n++;
      if (!exists(t)) missing.push(`${it.id}: ${t.kind} ${targetLabel(t)}`);
    }
  }
  assert.ok(n > 1000, `targets checked: ${n}`);
  assert.deepEqual(missing, [], 'targets that do not exist');
});

test('(e) gaps: every one is on the allow-list with a reason, none is a missing schema element, no stale rows', (t) => {
  const allow = new Map();
  for (const m of read('docs/coverage-gaps.md').matchAll(/^\| ((?:PB|PH)-[A-Z]+-\d+|PD-\d+) \| ([^|]+) \| ([^|]+) \|/gm)) {
    allow.set(m[1], { kind: m[2].trim(), reason: m[3].trim() });
  }
  const gaps = items.filter((i) => i.status === 'gap');
  t.diagnostic(`gaps: ${gaps.length}${gaps.length ? ` (${gaps.map((g) => g.id).join(', ')})` : ''}; allow-list rows: ${allow.size}`);
  const schemaGaps = gaps.filter((g) => g.gap.kind !== 'not_storable_by_design');
  assert.deepEqual(schemaGaps.map((g) => `${g.id}: ${g.gap.kind}: ${g.gap.description}`), [], 'a missing schema element must be added, never allowed');
  for (const g of gaps) {
    const row = allow.get(g.id);
    assert.ok(row, `${g.id} is a gap but not on docs/coverage-gaps.md`);
    assert.equal(row.kind, 'not_storable_by_design', `${g.id}: only items not storable by design may be allowed`);
    assert.ok(row.reason.length > 20, `${g.id}: the allow-list states why`);
  }
  for (const [id, row] of allow) {
    assert.equal(row.kind, 'not_storable_by_design', `${id}: the allow-list holds only items not storable by design`);
    assert.ok(gaps.some((g) => g.id === id), `${id} is on the allow-list but is not a gap (remove the row)`);
  }
});

test('the counts agree with the entries, and every verified Predbat / PredHeat item that is data is covered', (t) => {
  const count = (xs) => Object.fromEntries(STATUSES.map((s) => [s, xs.filter((x) => x.status === s).length]));
  assert.deepEqual(count(items), { covered: matrix.counts.all.covered, excluded_not_data: matrix.counts.all.excluded_not_data, gap: matrix.counts.all.gap });
  const verified = items.filter((i) => i.verified && !i.id.startsWith('PD-'));
  const data = verified.filter((i) => i.status !== 'excluded_not_data');
  t.diagnostic(`verified data items: ${data.length}, covered ${data.filter((i) => i.status === 'covered').length}; excluded as not data: ${items.filter((i) => i.status === 'excluded_not_data').map((i) => i.id).join(', ')}`);
  assert.deepEqual(data.filter((i) => i.status !== 'covered').map((i) => i.id), [], 'verified data items not covered');
});

test('the matrix and its report are what scripts/build-coverage-matrix.js builds now (stable, sorted, no timestamps)', () => {
  const build = () => buildMatrix({ ctx: schemaContext(db), catalogueText, databaseMd, readFunctions: new Set(Object.keys(readLayer)) });
  const built = build();
  assert.equal(render(built), render(build()), 'the same inputs build the same bytes');
  assert.ok(render(built) === matrixText, 'docs/coverage-matrix.json is out of date: run node scripts/build-coverage-matrix.js');
  assert.ok(renderReport(built) === read('docs/predbat-predheat-coverage.md'), 'docs/predbat-predheat-coverage.md is out of date: run node scripts/build-coverage-matrix.js');
});
