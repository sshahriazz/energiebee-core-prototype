// The rules of the raw-file check's tables (raw_check_run, raw_payload_check), broken on purpose and refused (fix list D1): see
// test/rules/lib.js. The check's behaviour is in test/raw-store.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { run, get, ins, refused, checkDeclared } = await harness('rawstore');

await test('a raw check run is a log row: it is never edited', async () => {
  const id = await ins("INSERT INTO raw_check_run (ran_at, trigger, checked, ok, mismatch, corrupt, missing, unreadable, erased, unsealed, bytes, ms) VALUES (1, 'cli', 2, 2, 0, 0, 0, 0, 0, 0, 10, 1)");
  await refused('raw_check_run_fixed', 'UPDATE raw_check_run SET checked = 0 WHERE id = ?', id);
  assert.equal((await get('SELECT checked FROM raw_check_run WHERE id = ?', id)).checked, 2);
  await run('DELETE FROM raw_check_run WHERE id = ?', id);   // a home's rows leave with the home: delete is not refused
});

await test('the rules declared for the rawstore area are the rules proved', () => checkDeclared());
