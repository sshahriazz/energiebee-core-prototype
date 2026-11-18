// The shared half of the rules catalogue (fix list D1). A rules-<area>.test.js file breaks the rules of one area on purpose,
// each case through `refused` (a trigger), `excluded` (an exclusion constraint) or `maintained` (a trigger that writes
// instead of refusing, proved by what it wrote). What an area proved is declared in test/rules/<area>.json, which the area's
// own last test checks (UPDATE_RULES=1 re-records it), and test/rules-all.test.js checks the union of every declaration
// against the triggers and exclusion constraints in the database: a rule without a case, or a message no case produced,
// fails there. New areas add their own two files and never touch another area's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from '../helpers.js';

export const rulesDir = import.meta.dirname;

export async function harness(area) {
  await useDb();
  const { db, EXCLUSION_MESSAGES } = await import('../../src/db/db.js');
  const proved = new Map();        // trigger name -> messages it was seen refusing with ('' for a maintenance trigger)
  const seenExclusions = new Set();
  const run = async (sql, ...p) => await db.prepare(sql).run(...p);
  const get = async (sql, ...p) => await db.prepare(sql).get(...p);
  const ins = async (sql, ...p) => Number((await run(sql, ...p)).lastInsertRowid);
  const triggerMessages = await triggersOf(db);

  // The statement is refused by `trigger`, with one of that trigger's own messages.
  async function refused(trigger, sql, ...params) {
    const own = triggerMessages.get(trigger);
    assert.ok(own, `no trigger ${trigger}`);
    let err = null;
    try { await run(sql, ...params); } catch (e) { err = e; }
    assert.ok(err, `${trigger}: the statement was accepted`);
    // A message with a % placeholder (RAISE ... '%', value) matches with any text in its place.
    const msg = own.find((m) => m.split('%').every((part) => err.message.includes(part)));
    assert.ok(msg, `${trigger}: refused with another message: ${err.message}`);
    (proved.get(trigger) ?? proved.set(trigger, new Set()).get(trigger)).add(msg);
  }
  const maintained = (trigger) => { assert.ok(triggerMessages.has(trigger), `no trigger ${trigger}`); if (!proved.has(trigger)) proved.set(trigger, new Set()); };
  async function excluded(constraint, sql, ...params) {
    await assert.rejects(async () => await run(sql, ...params), (e) => e.message.includes(EXCLUSION_MESSAGES[constraint] ?? constraint));
    seenExclusions.add(constraint);
  }
  // The last test of an area: what it proved is what test/rules/<area>.json declares.
  function checkDeclared() {
    const snapshot = { triggers: Object.fromEntries([...proved].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].filter(Boolean).sort()])), exclusions: [...seenExclusions].sort() };
    const file = path.join(rulesDir, `${area}.json`);
    if (process.env.UPDATE_RULES === '1') { fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`); return; }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), snapshot, `${area}: what the cases proved differs from test/rules/${area}.json (UPDATE_RULES=1 re-records it)`);
  }
  return { db, run, get, ins, refused, maintained, excluded, checkDeclared, triggerMessages };
}

// Every trigger of the schema with the messages its function can raise.
export async function triggersOf(db) {
  return new Map((await db.prepare(`SELECT t.tgname AS name, p.prosrc AS src FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal`).all())
    .map((r) => [r.name, [...r.src.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))]));
}
