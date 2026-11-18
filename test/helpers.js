// Each test file runs in its own process with its own Postgres database, so tests never touch the
// development database. Call `await useDb()` before importing anything from src/ (db.js connects to
// DATABASE_URL on import).
//
// A database is cloned from a template, built once per set of migrations: `energiebee_tpl_<hash>_empty`
// (the migrations only) or `_fixture` (the migrations with the frozen, identifier-free GB home of
// test/fixtures/gb-home.json.gz loaded after them, scripts/lib/databases.js). The first test process
// that needs a template builds it under an advisory lock; the others wait for it. Test databases are
// dropped when their process ends; `npm test` also drops any left by an interrupted run (pretest).
//
// No top-level after() in a test file: node:test runs it as soon as the tests registered so far have finished, so with an
// await between two top-level tests (every database call) it runs after the first test. A test server is unref()'d instead
// (it never keeps the process alive), and in-process state needs no undoing (each file is its own process).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigrations, createDatabase, dropDatabaseSync, dumpTables, loadTables, migrationsHash, quoteId, urlFor, withClient } from '../scripts/lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
// Tests never read .env (its credentials and tariff codes would leak into them): only TEST_DATABASE_URL is taken from it.
if (!process.env.TEST_DATABASE_URL) {
  try { process.env.TEST_DATABASE_URL = /^TEST_DATABASE_URL=(.+)$/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'))?.[1]?.trim() || ''; } catch { /* no .env */ }
}

// The server to create test databases on: TEST_DATABASE_URL (any database on it; default the local
// server's postgres database). Test databases take its user, password, host and port.
export const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/postgres';

// Databases made here are named <prefix>_tpl_<hash>_<kind> (templates) and <prefix>_t_<pid>_<random> (a test file's own). The
// prefix is `energiebee` unless TEST_DB_PREFIX names another: separate checkouts (git worktrees) that run tests at the same
// time each set their own, so one run's template cleanup and leftover cleanup never touch another's databases.
const PREFIX = process.env.TEST_DB_PREFIX || 'energiebee';
if (!/^[a-z][a-z0-9_]{0,20}$/.test(PREFIX)) throw new Error(`TEST_DB_PREFIX ${PREFIX}: lower-case letters, digits and underscores, at most 21`);
const like = (s) => s.replace(/[\\_%]/g, (c) => `\\${c}`);   // a name as a LIKE pattern, underscores literal

// The frozen, identifier-free real GB home (scripts/make-fixture.js). Tests that need real shapes start
// from it, so a repopulated development database cannot turn them red.
export const fixtureDb = path.join(root, 'test', 'fixtures', 'gb-home.json.gz');
export const hasLive = fs.existsSync(fixtureDb);

// The template's name changes with every migration and with the fixture, so a stale template is never used.
const templateHash = () => migrationsHash([...(hasLive ? [fixtureDb] : []), path.join(root, 'scripts', 'lib', 'databases.js')]);

async function ensureTemplate(kind) {
  const name = `${PREFIX}_tpl_${templateHash()}_${kind}`;
  await withClient(adminUrl, async (c) => {
    const exists = async () => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
    if (await exists()) return;
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
    try {
      if (await exists()) return;
      // Older templates go: their migrations or fixture changed.
      for (const r of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname NOT LIKE $2", [`${like(PREFIX)}\\_tpl\\_%`, `${like(PREFIX)}\\_tpl\\_${templateHash()}\\_%`])).rows) {
        await c.query(`DROP DATABASE IF EXISTS ${quoteId(r.datname)} WITH (FORCE)`);
      }
      const building = `${name}_building`;
      await c.query(`DROP DATABASE IF EXISTS ${quoteId(building)} WITH (FORCE)`);
      await createDatabase(building, adminUrl);
      await applyMigrations(urlFor(building, adminUrl));
      if (kind === 'fixture') await loadTables(urlFor(building, adminUrl), dumpTables(fixtureDb));
      await c.query(`ALTER DATABASE ${quoteId(building)} RENAME TO ${quoteId(name)}`);
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
    }
  });
  return name;
}

let created = null;
// An empty database, or (snapshot) a copy of the frozen GB home fixture. Stand-in values written by a
// test go only into this copy, which is dropped when the test process ends. Raw files go to a temporary
// DATA_DIR. Returns the database URL.
export async function useDb({ snapshot = false } = {}) {
  const template = await ensureTemplate(snapshot ? 'fixture' : 'empty');
  const name = `${PREFIX}_t_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const url = await createDatabase(name, adminUrl, { template });
  created = name;
  process.env.DATABASE_URL = url;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
  process.env.DATA_DIR = dir;
  delete process.env.RAW_DIR;   // a test's raw files go to its own DATA_DIR/raw, never to a real raw store
  // Sign-in is required on the main app; tests that read homes without a user turn it off (test/signup.test.js turns it on).
  process.env.REQUIRE_LOGIN ??= '0';
  // TEST_SLOT_S=900|3600 runs a snapshot test at another slot length (npm run test:slots). Stored slot rows stay as they are; dry-run builds follow the new length.
  if (snapshot && process.env.TEST_SLOT_S) {
    // A build "as known at" a moment reads the home's settings from site_version, so both are changed.
    await withClient(url, async (c) => {
      await c.query('UPDATE site SET slot_s = $1', [Number(process.env.TEST_SLOT_S)]);
      await c.query('UPDATE site_version SET slot_s = $1', [Number(process.env.TEST_SLOT_S)]);
    });
  }
  process.on('exit', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    dropDatabaseSync(name, adminUrl);
  });
  return url;
}


// Drop the test databases an interrupted run left behind (npm pretest).
export async function dropLeftovers() {
  await withClient(adminUrl, async (c) => {
    for (const r of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${like(PREFIX)}\\_t\\_%`])).rows) {
      await c.query(`DROP DATABASE IF EXISTS ${quoteId(r.datname)} WITH (FORCE)`);
    }
  });
}
export const testDatabase = () => created;
