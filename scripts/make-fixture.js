// Builds test/fixtures/gb-home.json.gz: a frozen, identifier-free copy of the real GB home's energy, prices and
// tariffs, so tests use real shapes and cannot drift when the app's database changes.
//   node --disable-warning=ExperimentalWarning scripts/make-fixture.js [out.json.gz]
// Reads the app's database (DATABASE_URL) only: it is copied into a throwaway database, which is cleaned and dumped.
// Removes names, address, account/meter/serial references, raw request text and raw files; coordinates are
// rounded to 1 decimal (about 11 km). The saved copies of public price lists are kept, with their files.
import fs from 'node:fs';
import path from 'node:path';
import { loadTables, postgresTables, scriptDatabase, writeDump } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* the environment provides DATABASE_URL */ }
const live = process.env.DATABASE_URL;
const liveData = path.resolve(root, process.env.DATA_DIR || 'data');
const out = path.resolve(process.argv[2] || path.join(root, 'test', 'fixtures', 'gb-home.json.gz'));   // another path to try it without replacing the fixture

const tmp = await scriptDatabase({ prefix: 'energiebee_fixture' });   // throwaway, dropped at the end
await loadTables(tmp.url, postgresTables(live));
const { db, closeDb } = await import('../src/db/db.js');
const { erase } = await import('../src/core/erasure.js');
// Raw rows are append-only: the copy is anonymised inside one logged erasure.
await erase({ kind: 'anonymise', reason: 'the GB test fixture: identifiers and raw request text removed' }, async () => {

await db.exec(`UPDATE site SET name = 'GB fixture home', postcode = NULL, outcode = NULL,
  lat = ROUND(lat::numeric, 1)::double precision, lon = ROUND(lon::numeric, 1)::double precision, env_key = NULL`);
await db.exec(`UPDATE device SET external_ref = 'fixture-' || id, label = kind, attrs = CASE WHEN attrs IS JSON OBJECT THEN (attrs::jsonb - 'serials')::text ELSE attrs END`);
await db.exec(`UPDATE device_attr_version SET attrs = CASE WHEN attrs IS JSON OBJECT THEN (attrs::jsonb - 'serials')::text ELSE attrs END`);
await db.exec('UPDATE connection SET external_ref = NULL, last_error = NULL, meta = NULL');
// Saved copies of public price lists stay (the explorer compares published prices with them); every other raw receipt is blanked.
const keep = "(SELECT id FROM raw_payload WHERE file LIKE 'raw/octopus_rates/%' AND id IN (SELECT raw_id FROM rate_interval))";
await db.exec(`UPDATE raw_payload SET request = '{}', reason = NULL, file = CASE WHEN id IN ${keep} THEN file ELSE 'redacted-' || id END`);
const rawOut = path.join(path.dirname(out), `${path.basename(out, '.json.gz')}-raw`);   // test/fixtures/gb-home-raw for the fixture
fs.rmSync(rawOut, { recursive: true, force: true });
for (const { file } of await db.prepare(`SELECT file FROM raw_payload WHERE id IN ${keep}`).all()) {
  const to = path.join(rawOut, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(liveData, file), to);
}
// Keep only the tariffs this home was ever on; the rest of the catalogue is not part of its history.
const used = '(SELECT DISTINCT tariff_id FROM tariff_agreement)';
for (const t of ['rate_interval', 'register_window', 'tariff_version']) await db.exec(`DELETE FROM ${t} WHERE tariff_id NOT IN ${used}`);
await db.exec(`DELETE FROM tariff WHERE id NOT IN ${used}`);
await db.exec('UPDATE sync_run SET detail = NULL');
await db.exec('TRUNCATE command_log');   // append-only (its triggers refuse row deletes); a fixture keeps no command history
await db.exec('DELETE FROM home_key');   // the fixture keeps no sealed raw file, so no key
});
await closeDb();

const rows = await writeDump(tmp.url, out);
console.log('wrote', path.relative(root, out), `${rows} rows,`, fs.statSync(out).size, 'bytes');
