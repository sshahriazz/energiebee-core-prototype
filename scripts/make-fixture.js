// Builds test/fixtures/gb-home.db: a frozen, identifier-free copy of the real GB home's energy,
// prices and tariffs, so tests use real shapes and cannot drift when data/core.db changes.
//   node --disable-warning=ExperimentalWarning scripts/make-fixture.js
// Reads data/core.db read-only. Removes names, address, account/meter/serial references, raw
// request text and raw files; coordinates are rounded to 1 decimal (about 11 km).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test', 'fixtures', 'gb-home.db');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-fixture-')), 'copy.db');

const src = new DatabaseSync(path.join(root, 'data', 'core.db'), { readOnly: true });
src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
src.close();

const db = new DatabaseSync(tmp);
db.exec('PRAGMA foreign_keys = OFF');
db.exec(`UPDATE site SET name = 'GB fixture home', postcode = NULL, outcode = NULL,
  lat = ROUND(lat, 1), lon = ROUND(lon, 1), env_key = NULL`);
db.exec(`UPDATE device SET external_ref = 'fixture-' || id, label = kind, attrs = json_remove(attrs, '$.serials')`);
db.exec(`UPDATE device_attr_version SET attrs = json_remove(attrs, '$.serials')`);
db.exec(`UPDATE connection SET external_ref = NULL, last_error = NULL, meta = NULL`);
// Saved copies of public price lists stay (the explorer compares published prices with them); every other raw receipt is blanked.
const keep = "(SELECT id FROM raw_payload WHERE file LIKE 'raw/octopus_rates/%' AND id IN (SELECT raw_id FROM rate_interval))";
db.exec(`UPDATE raw_payload SET request = '{}', reason = NULL, file = CASE WHEN id IN ${keep} THEN file ELSE 'redacted-' || id END`);
const rawOut = path.join(root, 'test', 'fixtures', 'gb-home-raw');
fs.rmSync(rawOut, { recursive: true, force: true });
for (const { file } of db.prepare(`SELECT file FROM raw_payload WHERE id IN ${keep}`).all()) {
  const to = path.join(rawOut, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, 'data', file), to);
}
// Keep only the tariffs this home was ever on; the rest of the catalogue is not part of its history.
const used = '(SELECT DISTINCT tariff_id FROM tariff_agreement)';
for (const t of ['rate_interval', 'register_window', 'tariff_version']) db.exec(`DELETE FROM ${t} WHERE tariff_id NOT IN ${used}`);
db.exec(`DELETE FROM tariff WHERE id NOT IN ${used}`);
db.exec("UPDATE sync_run SET detail = NULL");
db.exec('DELETE FROM command_log');
db.exec('VACUUM');
db.close();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(tmp, out);
fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log('wrote', path.relative(root, out), fs.statSync(out).size, 'bytes');
