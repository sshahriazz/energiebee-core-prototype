// Each test file runs in its own process with its own Postgres database, so tests never touch the
// development database. Call `await useDb()` before importing anything from src/ (db.js connects to
// DATABASE_URL on import).
//
// A database is cloned from a template, built once per set of migrations: `energiebee_tpl_<hash>_empty`
// (the migrations only) or `_fixture` (the migrations with the frozen, identifier-free GB home of
// test/fixtures/gb-home.db copied in after them, scripts/sqlite-to-postgres.js). The first test process
// that needs a template builds it under an advisory lock; the others wait for it. Test databases are
// dropped when their process ends; `npm test` also drops any left by an interrupted run (pretest).
//
// No top-level after() in a test file: node:test runs it as soon as the tests registered so far have finished, so with an
// await between two top-level tests (every database call) it runs after the first test. A test server is unref()'d instead
// (it never keeps the process alive), and in-process state needs no undoing (each file is its own process).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { copySqliteToPostgres } from '../scripts/sqlite-to-postgres.js';

const root = path.resolve(import.meta.dirname, '..');
// Tests never read .env (its credentials and tariff codes would leak into them): only TEST_DATABASE_URL is taken from it.
if (!process.env.TEST_DATABASE_URL) {
  try { process.env.TEST_DATABASE_URL = /^TEST_DATABASE_URL=(.+)$/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'))?.[1]?.trim() || ''; } catch { /* no .env */ }
}

// The server to create test databases on: TEST_DATABASE_URL (any database on it; default the local
// server's postgres database). Test databases take its user, password, host and port.
export const adminUrl = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/postgres';
const urlFor = (name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };

// The frozen, identifier-free real GB home (scripts/make-fixture.js). Tests that need real shapes start
// from it, so a repopulated development database cannot turn them red.
export const fixtureDb = path.join(root, 'test', 'fixtures', 'gb-home.db');
export const hasLive = fs.existsSync(fixtureDb);

const migrationsDir = path.join(root, 'prisma', 'migrations');
const migrations = () => fs.readdirSync(migrationsDir).filter((d) => fs.existsSync(path.join(migrationsDir, d, 'migration.sql'))).sort();
// The template's name changes with every migration and with the fixture, so a stale template is never used.
const templateHash = () => {
  const h = crypto.createHash('sha256');
  for (const m of migrations()) h.update(m).update(fs.readFileSync(path.join(migrationsDir, m, 'migration.sql')));
  if (hasLive) h.update(fs.readFileSync(fixtureDb));
  h.update(fs.readFileSync(path.join(root, 'scripts', 'sqlite-to-postgres.js')));
  return h.digest('hex').slice(0, 12);
};
const quoteId = (s) => `"${s.replace(/"/g, '""')}"`;
const CREATE = "TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'";

async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function applyMigrations(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { for (const m of migrations()) await c.query(fs.readFileSync(path.join(migrationsDir, m, 'migration.sql'), 'utf8')); } finally { await c.end(); }
}

async function ensureTemplate(kind) {
  const name = `energiebee_tpl_${templateHash()}_${kind}`;
  await withAdmin(async (c) => {
    const exists = async () => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
    if (await exists()) return;
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
    try {
      if (await exists()) return;
      // Older templates go: their migrations or fixture changed.
      for (const r of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'energiebee_tpl_%' AND datname NOT LIKE $1", [`energiebee_tpl_${templateHash()}_%`])).rows) {
        await c.query(`DROP DATABASE IF EXISTS ${quoteId(r.datname)} WITH (FORCE)`);
      }
      const building = `${name}_building`;
      await c.query(`DROP DATABASE IF EXISTS ${quoteId(building)} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${quoteId(building)} ${CREATE}`);
      await applyMigrations(urlFor(building));
      if (kind === 'fixture') await copySqliteToPostgres(fixtureDb, urlFor(building));
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
  const name = `energiebee_t_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  await withAdmin((c) => c.query(`CREATE DATABASE ${quoteId(name)} TEMPLATE ${quoteId(template)}`));
  created = name;
  const url = urlFor(name);
  process.env.DATABASE_URL = url;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
  process.env.DATA_DIR = dir;
  // Sign-in is required on the main app; tests that read homes without a user turn it off (test/signup.test.js turns it on).
  process.env.REQUIRE_LOGIN ??= '0';
  // TEST_SLOT_S=900|3600 runs a snapshot test at another slot length (npm run test:slots). Stored slot rows stay as they are; dry-run builds follow the new length.
  if (snapshot && process.env.TEST_SLOT_S) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    // A build "as known at" a moment reads the home's settings from site_version, so both are changed.
    await c.query('UPDATE site SET slot_s = $1', [Number(process.env.TEST_SLOT_S)]);
    await c.query('UPDATE site_version SET slot_s = $1', [Number(process.env.TEST_SLOT_S)]);
    await c.end();
  }
  process.on('exit', () => {
    fs.rmSync(dir, { recursive: true, force: true });
    dropDatabase(name);
  });
  return url;
}

// Synchronous (it runs from the process's exit handler): a short child process drops the database.
function dropDatabase(name) {
  const code = `import pg from 'pg'; const c = new pg.Client({ connectionString: ${JSON.stringify(adminUrl)} }); await c.connect();
    await c.query('DROP DATABASE IF EXISTS ${quoteId(name).replace(/'/g, "''")} WITH (FORCE)'); await c.end();`;
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, stdio: 'ignore' });
}

// Drop the test databases an interrupted run left behind (npm pretest).
export async function dropLeftovers() {
  await withAdmin(async (c) => {
    for (const r of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'energiebee_t\\_%'")).rows) {
      await c.query(`DROP DATABASE IF EXISTS ${quoteId(r.datname)} WITH (FORCE)`);
    }
  });
}
export const testDatabase = () => created;
