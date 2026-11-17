// Postgres databases for tests, scripts and demos: create one (empty, migrated, or cloned from a
// template), drop it, apply the migrations, and load rows into it from another database.
//
// The server is the one in TEST_DATABASE_URL (tests) or DATABASE_URL (scripts); the administrative
// connection uses its `postgres` database. Every database made here is UTF-8 with binary text order
// (the builtin C.UTF-8 locale), as the application's own.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..', '..');
export const migrationsDir = path.join(root, 'prisma', 'migrations');
const CREATE = "TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'";
export const quoteId = (s) => `"${String(s).replace(/"/g, '""')}"`;

// The administrative URL of the server a database URL points at.
export function serverUrl(url) { const u = new URL(url); u.pathname = '/postgres'; return u.toString(); }
export function urlFor(name, base) { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); }
export const databaseName = (url) => decodeURIComponent(new URL(url).pathname.slice(1));

export async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

export async function databaseExists(name, base) {
  return withClient(serverUrl(base), async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0);
}
// A new database: empty (template0), or a copy of `template` (which must have no open connection).
export async function createDatabase(name, base, { template = null } = {}) {
  await withClient(serverUrl(base), (c) => c.query(`CREATE DATABASE ${quoteId(name)} ${template ? `TEMPLATE ${quoteId(template)}` : CREATE}`));
  return urlFor(name, base);
}
export async function dropDatabase(name, base) {
  await withClient(serverUrl(base), (c) => c.query(`DROP DATABASE IF EXISTS ${quoteId(name)} WITH (FORCE)`));
}
// The same, synchronously (from a process's exit handler), through a short child process.
export function dropDatabaseSync(name, base) {
  const code = `import pg from 'pg'; const c = new pg.Client({ connectionString: ${JSON.stringify(serverUrl(base))} }); await c.connect();
    await c.query(${JSON.stringify(`DROP DATABASE IF EXISTS ${quoteId(name)} WITH (FORCE)`)}); await c.end();`;
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, stdio: 'ignore' });
}

export const migrations = () => fs.readdirSync(migrationsDir).filter((d) => fs.existsSync(path.join(migrationsDir, d, 'migration.sql'))).sort();
// A hash of the migrations (and any extra files, such as a fixture): it names a template, so a stale one is never used.
export function migrationsHash(extraFiles = []) {
  const h = crypto.createHash('sha256');
  for (const m of migrations()) h.update(m).update(fs.readFileSync(path.join(migrationsDir, m, 'migration.sql')));
  for (const f of extraFiles) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 12);
}
// The migrations, in order, on a database (tests and scripts; the app's own database uses `npm run db:migrate`).
export async function applyMigrations(url) {
  await withClient(url, async (c) => { for (const m of migrations()) await c.query(fs.readFileSync(path.join(migrationsDir, m, 'migration.sql'), 'utf8')); });
}

// A throwaway database for a script, migrated (or cloned from `template`), dropped when the process ends.
export async function tempDatabase(base, { prefix = 'energiebee_tmp', template = null } = {}) {
  const name = `${prefix}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const url = await createDatabase(name, base, { template });
  if (!template) await applyMigrations(url);
  process.on('exit', () => dropDatabaseSync(name, base));
  return { name, url };
}

// ───────────── loading rows ─────────────
// Load tables into a migrated database: `source` yields { table, columns, rows } (rows as objects keyed by
// column). Every target table is emptied first; triggers are switched off during the load (the rows already
// carry their versions and checks), foreign keys are checked once before commit, identity sequences continue
// after the loaded ids, and every table's row count is compared before committing. Columns the target lacks
// are refused; columns the source lacks are left at their default (reported through `log`).
export async function loadTables(url, source, { log = () => {} } = {}) {
  const counts = {};
  await withClient(url, async (client) => {
    const tables = (await client.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`)).rows.map((r) => r.table_name);
    const target = new Set(tables);
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`TRUNCATE ${tables.map(quoteId).join(', ')} RESTART IDENTITY CASCADE`);
      for (const t of tables) await client.query(`ALTER TABLE ${quoteId(t)} DISABLE TRIGGER USER`);
      for await (const { table, columns: srcCols, rows } of source) {
        if (!target.has(table)) { log(`${table}: not in the target schema, skipped`); continue; }
        const pgCols = (await client.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table])).rows;
        const have = new Set(srcCols);
        const cols = pgCols.filter((c) => have.has(c.column_name));
        const missing = pgCols.filter((c) => !have.has(c.column_name)).map((c) => c.column_name);
        if (missing.length) log(`${table}: columns not in the source, left at their default: ${missing.join(', ')}`);
        const bytea = cols.map((c) => c.data_type === 'bytea');
        const per = Math.max(1, Math.floor(60000 / Math.max(1, cols.length)));   // under Postgres' 65,535 parameters
        for (let i = 0; i < rows.length; i += per) {
          const params = [];
          const values = rows.slice(i, i + per).map((r) => `(${cols.map((c, j) => {
            const v = r[c.column_name];
            params.push(bytea[j] && v != null ? Buffer.from(v) : (typeof v === 'bigint' ? v.toString() : v));
            return `$${params.length}`;
          }).join(', ')})`);
          await client.query(`INSERT INTO ${quoteId(table)} (${cols.map((c) => quoteId(c.column_name)).join(', ')}) VALUES ${values.join(', ')}`, params);
        }
        counts[table] = rows.length;
        for (const { column_name: c } of (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND is_identity = 'YES'", [table])).rows) {
          await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quoteId(c)}) FROM ${quoteId(table)}), 0) + 1, false)`, [table, c]);
        }
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');   // the deferred foreign-key checks run here
      for (const t of tables) await client.query(`ALTER TABLE ${quoteId(t)} ENABLE TRIGGER USER`);
      for (const [t, n] of Object.entries(counts)) {
        const got = Number((await client.query(`SELECT COUNT(*) AS n FROM ${quoteId(t)}`)).rows[0].n);
        if (got !== n) throw new Error(`${t}: ${n} rows in the source, ${got} loaded`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
  return counts;
}

// Every table of a Postgres database as a source for loadTables.
export async function* postgresTables(url) {
  const c = new pg.Client({ connectionString: url, types: { getTypeParser: (oid, format) => (oid === 20 ? (v) => v : pg.types.getTypeParser(oid, format)) } });
  await c.connect();
  try {
    const tables = (await c.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`)).rows.map((r) => r.table_name);
    for (const table of tables) {
      const res = await c.query(`SELECT * FROM ${quoteId(table)}`);
      yield { table, columns: res.fields.map((f) => f.name), rows: res.rows };
    }
  } finally { await c.end(); }
}

// ───────────── a database for a script ─────────────
// A fresh, migrated database for a script on the server of DATABASE_URL (.env): dropped when the script ends,
// or kept under `keep` (a database name, emptied and migrated again). Sets DATABASE_URL (and DATA_DIR, a
// temporary folder unless given) before src/db/db.js is imported. Returns { name, url, dataDir }.
export async function scriptDatabase({ prefix = 'energiebee_tmp', keep = null, dataDir = null } = {}) {
  if (!process.env.DATABASE_URL) { try { process.loadEnvFile(path.join(root, '.env')); } catch { /* the environment provides it */ } }
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set (see .env.example): it names the Postgres server to use');
  let db;
  if (keep) {
    if (keep === databaseName(base)) throw new Error(`refusing to replace ${keep}: it is the database DATABASE_URL names (the app's own)`);
    await dropDatabase(keep, base);
    db = { name: keep, url: await createDatabase(keep, base) };
    await applyMigrations(db.url);
  } else db = await tempDatabase(base, { prefix });
  process.env.DATABASE_URL = db.url;
  const dir = dataDir ?? fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), `${prefix}-`));
  fs.mkdirSync(dir, { recursive: true });
  process.env.DATA_DIR = dir;
  if (!dataDir) process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...db, dataDir: dir };
}

// ───────────── dumps (the test fixture) ─────────────
// A dump is gzipped JSON: { format: 1, tables: [{ table, columns, rows: [[values in column order]] }] }. Integers come back
// as numbers (all within 2^53), bytea as { $bytes: base64 }. Only tables with rows are written.
const enc = (v) => (Buffer.isBuffer(v) ? { $bytes: v.toString('base64') } : v);
const dec = (v) => (v && typeof v === 'object' && typeof v.$bytes === 'string' ? Buffer.from(v.$bytes, 'base64') : v);

export async function writeDump(url, file) {
  const tables = [];
  for await (const t of postgresTables(url)) {
    if (!t.rows.length) continue;
    const ints = new Set(await withClient(url, async (c) => (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND data_type = 'bigint'", [t.table])).rows.map((r) => r.column_name)));
    tables.push({ table: t.table, columns: t.columns, rows: t.rows.map((r) => t.columns.map((c) => (ints.has(c) && r[c] != null ? Number(r[c]) : enc(r[c])))) });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 1, tables }), { level: 9 }));
  return tables.reduce((n, t) => n + t.rows.length, 0);
}

// The tables of a dump as a source for loadTables.
export function* dumpTables(file) {
  const { format, tables } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (format !== 1) throw new Error(`${file}: unknown dump format ${format}`);
  for (const t of tables) yield { table: t.table, columns: t.columns, rows: t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, dec(r[i])]))) };
}
