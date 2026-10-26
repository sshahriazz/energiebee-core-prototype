// Opening the database (src/db/db.js): a busy timeout, each delta applied once, seeds that insert
// only what is missing, and an up-to-date database opened without writing anything, so a second
// process never fails with "database is locked". Each open runs in a child process (db.js opens
// DB_FILE once, on import); the test process holds its own plain connection to the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { hasLive, liveDb } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-open-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const newFile = () => path.join(dir, `core-${++n}.db`);

// Imports db.js in a child process on `file`, runs `body` (with db and tx in scope) and prints what
// the open did: the rows it changed (total_changes) and the schema version after it.
function openInChild(file, body = '') {
  const code = `const { db, tx, DELTAS } = await import(${JSON.stringify(path.join(root, 'src', 'db', 'db.js'))});
    const opened = { changes: db.prepare('SELECT total_changes() AS n').get().n, schema: db.prepare('PRAGMA schema_version').get().schema_version, busy: db.prepare('PRAGMA busy_timeout').get().timeout, deltas: DELTAS };
    ${body}
    console.log(JSON.stringify(opened));`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env: { ...process.env, DB_FILE: file } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => resolve({ status, err, ...(status === 0 ? JSON.parse(out.trim().split('\n').pop()) : {}) }));
  });
}
const schemaVersion = (file) => { const c = new DatabaseSync(file); const v = c.prepare('PRAGMA schema_version').get().schema_version; c.close(); return v; };
const withDb = (file, fn) => { const c = new DatabaseSync(file); try { return fn(c); } finally { c.close(); } };

test('an up-to-date database is opened without writing: no row changed, no schema change, every delta recorded once', async () => {
  const file = newFile();
  const first = await openInChild(file);
  assert.equal(first.status, 0, first.err);
  assert.ok(first.changes > 0, 'the first open creates the schema and the seed rows');
  assert.equal(first.busy, 5000, 'busy_timeout 5 s');
  const v = schemaVersion(file);
  for (let i = 0; i < 2; i++) {
    const again = await openInChild(file);
    assert.equal(again.status, 0, again.err);
    assert.equal(again.changes, 0, 'a second open changes no row');
    assert.equal(again.schema, v, 'and does not change the schema (delta 010 no longer rebuilds market_provider)');
  }
  const names = withDb(file, (c) => c.prepare('SELECT name FROM schema_delta ORDER BY name').all().map((r) => r.name));
  assert.deepEqual(names, first.deltas.map((f) => f.replace(/\.sql$/, '')).sort(), 'every delta of db.js DELTAS recorded, once');
});

test('a copy of the live database: the second open writes nothing either', { skip: hasLive ? false : 'no data/core.db' }, async () => {
  const file = newFile();
  const src = new DatabaseSync(liveDb, { readOnly: true });
  src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  src.close();
  const first = await openInChild(file);
  assert.equal(first.status, 0, first.err);
  const v = schemaVersion(file);
  const again = await openInChild(file);
  assert.equal(again.status, 0, again.err);
  assert.deepEqual([again.changes, again.schema], [0, v]);
});

test('delta 010 rebuilds market_provider only while it has an older owner CHECK', async () => {
  const file = newFile();
  assert.equal((await openInChild(file)).status, 0);
  const rows = (c) => c.prepare('SELECT * FROM market_provider ORDER BY market_code, role, adapter').all().map((r) => ({ ...r }));
  // Not recorded, but the table is already the current one: recorded again, no rebuild.
  const before = withDb(file, (c) => { c.exec("DELETE FROM schema_delta WHERE name = '010-provider-owner'"); return rows(c); });
  const v = schemaVersion(file);
  const r1 = await openInChild(file);
  assert.equal(r1.status, 0, r1.err);
  assert.equal(r1.schema, v, 'no table rebuilt');
  withDb(file, (c) => {
    assert.ok(c.prepare("SELECT 1 FROM schema_delta WHERE name = '010-provider-owner'").get());
    assert.deepEqual(rows(c), before);
  });
  // A table from before 010 (another second owner in its CHECK): rebuilt once, that owner becomes 'external'.
  withDb(file, (c) => {
    const sql = c.prepare("SELECT sql FROM sqlite_master WHERE name = 'market_provider'").get().sql.replace("CHECK (owner IN ('core', 'external'))", "CHECK (owner IN ('core', 'old_owner'))");
    c.exec(`BEGIN; CREATE TEMP TABLE mp AS SELECT * FROM market_provider; DROP TABLE market_provider; ${sql};
      INSERT INTO market_provider SELECT * FROM temp.mp; DROP TABLE temp.mp;
      CREATE INDEX market_provider_role ON market_provider (role, market_code, priority);
      INSERT INTO market_provider (market_code, role, adapter, priority, owner, scope, origin, note) VALUES ('GB', 'tariff_catalogue', 'remote', 5, 'old_owner', 'shared', 'provider', 'synced elsewhere');
      DELETE FROM schema_delta WHERE name = '010-provider-owner'; COMMIT;`);
  });
  const r2 = await openInChild(file);
  assert.equal(r2.status, 0, r2.err);
  withDb(file, (c) => {
    assert.match(c.prepare("SELECT sql FROM sqlite_master WHERE name = 'market_provider'").get().sql, /CHECK \(owner IN \('core', 'external'\)\)/);
    assert.equal(c.prepare("SELECT owner FROM market_provider WHERE adapter = 'remote'").get().owner, 'external');
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM market_provider').get().n, before.length + 1);
  });
});

test('a recorded delta is applied again only when an object it creates is missing', async () => {
  const file = newFile();
  assert.equal((await openInChild(file)).status, 0);
  withDb(file, (c) => c.exec('DROP TRIGGER agreement_same_currency_insert'));
  const r = await openInChild(file);
  assert.equal(r.status, 0, r.err);
  withDb(file, (c) => assert.ok(c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'agreement_same_currency_insert'").get(), 'delta 002 restored its trigger'));
  const again = await openInChild(file);
  assert.equal(again.changes, 0);
});

test('seeds insert only missing rows: an operator\'s market, region, alias and provider priority edits are kept', async () => {
  const file = newFile();
  assert.equal((await openInChild(file)).status, 0);
  withDb(file, (c) => c.exec(`
    UPDATE market SET price_interval_s = 900, origin_note = 'checked by an operator' WHERE code = 'FR';
    UPDATE region SET name = 'North West (edited)' WHERE scheme = 'gb_dno' AND code = '16';
    UPDATE region SET name = 'France (edited)' WHERE scheme = 'bzn' AND code = 'FR';
    UPDATE region_alias SET code = '12' WHERE alias_scheme = 'tariffscan_name' AND alias_code = 'Norweb';
    UPDATE market_provider SET priority = 55, enabled = 0, note = 'edited' WHERE market_code = 'GB' AND role = 'weather';
    DELETE FROM market WHERE code = 'ES';
    DELETE FROM region_alias WHERE alias_scheme = 'octopus_gsp' AND alias_code = 'A';
    DELETE FROM market_provider WHERE market_code = 'DE';
    UPDATE metric SET label = 'edited' WHERE code = 'solar_w';`));
  const r = await openInChild(file);
  assert.equal(r.status, 0, r.err);
  withDb(file, (c) => {
    const get = (sql) => ({ ...c.prepare(sql).get() });
    assert.deepEqual(get("SELECT price_interval_s, origin_note FROM market WHERE code = 'FR'"), { price_interval_s: 900, origin_note: 'checked by an operator' });
    assert.equal(get("SELECT name FROM region WHERE scheme = 'gb_dno' AND code = '16'").name, 'North West (edited)');
    assert.equal(get("SELECT name FROM region WHERE scheme = 'bzn' AND code = 'FR'").name, 'France (edited)');
    assert.equal(get("SELECT code FROM region_alias WHERE alias_scheme = 'tariffscan_name' AND alias_code = 'Norweb'").code, '12', 'an alias is never moved back silently');
    const p = get("SELECT priority, enabled, note FROM market_provider WHERE market_code = 'GB' AND role = 'weather'");
    assert.deepEqual([p.priority, p.enabled], [55, 0], 'priority and switch kept');
    assert.match(p.note, /^Open-Meteo/, 'the descriptive note follows the code (documented exception)');
    // Missing rows come back.
    assert.ok(get("SELECT COUNT(*) AS n FROM market WHERE code = 'ES'").n === 1);
    assert.equal(get("SELECT code FROM region_alias WHERE alias_scheme = 'octopus_gsp' AND alias_code = 'A'").code, '10');
    assert.ok(get("SELECT COUNT(*) AS n FROM market_provider WHERE market_code = 'DE'").n > 0);
    // Registry rows are the code's (documented exception): put back in line.
    assert.notEqual(get("SELECT label FROM metric WHERE code = 'solar_w'").label, 'edited');
  });
  const again = await openInChild(file);
  assert.deepEqual([again.status, again.changes], [0, 0], 'and the open after that writes nothing');
});

test('a second connection holding a write: an up-to-date open does not wait or fail, one that must write waits for it', async () => {
  const file = newFile();
  assert.equal((await openInChild(file)).status, 0);
  const holder = new DatabaseSync(file);
  holder.exec("BEGIN IMMEDIATE; INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) SELECT id, 0, 1, 'held', 0 FROM site LIMIT 0; UPDATE market SET origin_note = origin_note WHERE code = 'GB';");
  try {
    const t0 = Date.now();
    const r = await openInChild(file);
    assert.equal(r.status, 0, `open while another connection holds a write: ${r.err}`);
    assert.equal(r.changes, 0);
    assert.ok(Date.now() - t0 < 4000, 'did not wait for the lock');
  } finally {
    holder.exec('COMMIT');
  }
  // This open has a seed row to insert, and a tx() to run: both wait for the holder (1.5 s), then succeed.
  holder.exec("DELETE FROM market WHERE code = 'ES'");
  holder.exec("BEGIN IMMEDIATE; UPDATE market SET origin_note = origin_note WHERE code = 'GB';");
  const released = new Promise((resolve) => setTimeout(() => { holder.exec('COMMIT'); resolve(); }, 1500));
  const t0 = Date.now();
  const r = await openInChild(file, "tx(() => db.prepare(\"UPDATE market SET origin_note = origin_note WHERE code = 'FR'\").run());");
  await released;
  assert.equal(r.status, 0, `an open that must write waits for the lock instead of failing: ${r.err}`);
  assert.ok(Date.now() - t0 >= 1400, 'it waited for the other connection');
  assert.equal(holder.prepare("SELECT COUNT(*) AS n FROM market WHERE code = 'ES'").get().n, 1);
  holder.close();
});
