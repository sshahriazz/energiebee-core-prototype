// Proof that a copy made by scripts/sqlite-to-postgres.js is exact: for the fact, tariff and serving tables, a hash
// of every row (every column, in key order) in the SQLite file and in the Postgres database. Exit code 1 on any
// difference.
//
//   node scripts/verify-sqlite-copy.js <file.db> [DATABASE_URL]
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import pg from 'pg';
try { process.loadEnvFile('.env'); } catch { /* the environment provides DATABASE_URL */ }
const [file, url = process.env.DATABASE_URL] = process.argv.slice(2);
const sq = new DatabaseSync(file, { readOnly: true });
const c = new pg.Client({ connectionString: url, types: { getTypeParser: (oid, f) => (oid === 20 ? (v) => Number(v) : pg.types.getTypeParser(oid, f)) } });
await c.connect();
const TABLES = { reading: 'series_id, ts, recorded_at', interval_fact: 'series_id, start_ts, end_ts, recorded_at', forecast_fact: 'series_id, start_ts, end_ts, issued_at',
  rate_interval: 'id', site_hh: 'site_id, slot_start', site_day: 'site_id, local_date', raw_payload: 'id', tariff: 'id', tariff_agreement: 'id', series: 'id', device: 'id', site: 'id', check_result: 'site_id, local_date, check_code', site_heat_slot: 'site_id, slot_start' };
const norm = (v) => (v == null ? null : typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
let bad = 0;
for (const [t, order] of Object.entries(TABLES)) {
  const cols = sq.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  const h1 = crypto.createHash('sha256'); const h2 = crypto.createHash('sha256');
  for (const r of sq.prepare(`SELECT ${cols.map((x) => `"${x}"`).join(',')} FROM "${t}" ORDER BY ${order}`).all()) h1.update(JSON.stringify(cols.map((k) => norm(r[k]))));
  for (const r of (await c.query(`SELECT ${cols.map((x) => `"${x}"`).join(',')} FROM "${t}" ORDER BY ${order}`)).rows) h2.update(JSON.stringify(cols.map((k) => norm(r[k]))));
  const a = h1.digest('hex').slice(0, 16); const b = h2.digest('hex').slice(0, 16);
  if (a !== b) bad++;
  console.log(`${t.padEnd(18)} ${a === b ? 'equal ' : 'DIFFER'} ${a} ${b}`);
}
await c.end();
process.exit(bad ? 1 : 0);
