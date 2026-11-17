// Copy a SQLite database of the old core (at the final SQLite schema: schema.sql and all 43 deltas) into a
// migrated Postgres database: every table, every row, every column the two have in common.
//
//   node scripts/sqlite-to-postgres.js <file.db> [--replace]        DATABASE_URL from the environment or .env
//
// The target's tables are emptied first (refused when it already holds homes, unless --replace). Triggers are
// switched off during the copy (the rows already carry their versions, default bindings and checks), foreign keys
// are checked once at commit, identity sequences continue after the copied ids, and the row count of every
// table is compared before committing: on any difference nothing is kept.
//
// A SQLite file at an older schema must first be opened once by the old SQLite core (commit f014fce), which
// applies the missing deltas.
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export async function copySqliteToPostgres(file, url, { replace = false, log = () => {} } = {}) {
  const src = new DatabaseSync(file, { readOnly: true });
  const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
  const srcCols = (t) => src.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = (id) => `"${id.replace(/"/g, '""')}"`;
  const counts = {};
  try {
    const tables = (await client.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`)).rows.map((r) => r.table_name);
    if (!replace && tables.includes('site') && Number((await client.query('SELECT COUNT(*) AS n FROM site')).rows[0].n) > 0) {
      throw new Error('the target database already has homes: pass --replace to empty it first');
    }
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`TRUNCATE ${tables.map(q).join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of tables) await client.query(`ALTER TABLE ${q(t)} DISABLE TRIGGER USER`);
    for (const t of tables) {
      if (!srcTables.has(t)) { log(`${t}: not in the SQLite file, left empty`); continue; }
      const pgCols = (await client.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [t])).rows;
      const have = new Set(srcCols(t));
      const cols = pgCols.filter((c) => have.has(c.column_name));
      const missing = pgCols.filter((c) => !have.has(c.column_name)).map((c) => c.column_name);
      if (missing.length) log(`${t}: columns not in the SQLite file, left at their default: ${missing.join(', ')}`);
      const bytea = cols.map((c) => c.data_type === 'bytea');
      const per = Math.max(1, Math.floor(60000 / Math.max(1, cols.length)));   // under Postgres' 65,535 parameters
      const rows = src.prepare(`SELECT ${cols.map((c) => q(c.column_name)).join(', ')} FROM ${q(t)}`).all();
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const params = [];
        const values = chunk.map((r) => `(${cols.map((c, j) => {
          const v = r[c.column_name];
          params.push(bytea[j] && v != null ? Buffer.from(v) : (typeof v === 'bigint' ? v.toString() : v));
          return `$${params.length}`;
        }).join(', ')})`);
        await client.query(`INSERT INTO ${q(t)} (${cols.map((c) => q(c.column_name)).join(', ')}) VALUES ${values.join(', ')}`, params);
      }
      counts[t] = rows.length;
      // Identity columns continue after the copied ids.
      const ident = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND is_identity = 'YES'", [t])).rows;
      for (const { column_name: c } of ident) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${q(c)}) FROM ${q(t)}), 0) + 1, false)`, [t, c]);
      }
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');   // the deferred foreign-key checks run here
    for (const t of tables) await client.query(`ALTER TABLE ${q(t)} ENABLE TRIGGER USER`);
    for (const [t, n] of Object.entries(counts)) {
      const got = Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
      if (got !== n) throw new Error(`${t}: ${n} rows in SQLite, ${got} in Postgres`);
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
    src.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile('.env'); } catch { /* the environment provides DATABASE_URL */ }
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) {
    console.error('usage: node scripts/sqlite-to-postgres.js <file.db> [--replace]   (DATABASE_URL in the environment or .env)');
    process.exit(2);
  }
  const counts = await copySqliteToPostgres(file, process.env.DATABASE_URL, { replace: process.argv.includes('--replace'), log: (m) => console.log(m) });
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(`copied ${total} rows in ${Object.keys(counts).length} tables`);
  for (const [t, n] of Object.entries(counts)) if (n) console.log(`  ${t.padEnd(24)} ${n}`);
}
