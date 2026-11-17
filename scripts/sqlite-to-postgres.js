// Copy a SQLite database of the old core (at the final SQLite schema: schema.sql and all 43 deltas) into a
// migrated Postgres database: every table, every row, every column the two have in common.
//
//   node scripts/sqlite-to-postgres.js <file.db> [--replace]        DATABASE_URL from the environment or .env
//
// The target's tables are emptied first (refused when it already holds homes, unless --replace). Triggers are
// switched off during the copy (the rows already carry their versions, default bindings and checks), foreign keys
// are checked once at commit, identity sequences continue after the copied ids, and the row count of every
// table is compared before committing: on any difference nothing is kept (scripts/lib/databases.js loadTables).
//
// A SQLite file at an older schema must first be opened once by the old SQLite core (commit f014fce), which
// applies the missing deltas.
import { DatabaseSync } from 'node:sqlite';
import { loadTables, withClient } from './lib/databases.js';

// Every table of a SQLite file as a source for loadTables.
function* sqliteTables(file) {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    for (const { name } of src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_delta' ORDER BY name").all()) {
      const columns = src.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((r) => r.name);
      yield { table: name, columns, rows: src.prepare(`SELECT * FROM "${name}"`).all() };
    }
  } finally { src.close(); }
}

export async function copySqliteToPostgres(file, url, { replace = false, log = () => {} } = {}) {
  if (!replace) {
    const homes = await withClient(url, async (c) => Number((await c.query('SELECT COUNT(*) AS n FROM site')).rows[0].n));
    if (homes > 0) throw new Error('the target database already has homes: pass --replace to empty it first');
  }
  return loadTables(url, sqliteTables(file), { log });
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
