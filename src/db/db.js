// Opens the SQLite database, applies the schema and seeds the registry.
// Node's built-in SQLite keeps the prototype free of native dependencies.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, METRICS, VAT_RATES } from './registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const dbFile = path.resolve(root, process.env.DB_FILE || 'data/core.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
// Tariff agreements became versioned (16 Oct 2026). The old table had UNIQUE (device_id, valid_from),
// which a superseded version would break, so it is rebuilt once before the schema is applied.
const agreementCols = db.prepare("SELECT name FROM pragma_table_info('tariff_agreement')").all().map((c) => c.name);
if (agreementCols.length && !agreementCols.includes('recorded_at')) {
  // SQLite's table-rebuild procedure: foreign-key checks off while rows are copied (it cannot be changed inside a transaction).
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN;
    DROP TRIGGER IF EXISTS agreement_no_overlap;
    ALTER TABLE tariff_agreement RENAME TO tariff_agreement_v1;
    CREATE TABLE tariff_agreement (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES site(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, tariff_id INTEGER NOT NULL REFERENCES tariff(id),
      valid_from INTEGER NOT NULL, valid_to INTEGER, recorded_at INTEGER, superseded_at INTEGER,
      CHECK (valid_to IS NULL OR valid_to > valid_from));
    INSERT INTO tariff_agreement (id, site_id, device_id, tariff_id, valid_from, valid_to) SELECT id, site_id, device_id, tariff_id, valid_from, valid_to FROM tariff_agreement_v1;
    DROP TABLE tariff_agreement_v1;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}
// Device columns added with versioning; must exist before the schema's statements run.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'device'").get()) {
  const devCols = new Set(db.prepare("SELECT name FROM pragma_table_info('device')").all().map((c) => c.name));
  for (const c of ['recorded_at', 'retired_at']) if (!devCols.has(c)) db.exec(`ALTER TABLE device ADD COLUMN ${c} INTEGER`);
}
if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'site_day_revision'").get()
  && !db.prepare("SELECT 1 FROM pragma_table_info('site_day_revision') WHERE name = 'kind'").get()) {
  db.exec("ALTER TABLE site_day_revision ADD COLUMN kind TEXT NOT NULL DEFAULT 'recorded'");
}
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Registry rows are data: adding a source or metric never changes the schema.
function seedRegistry() {
  const upSource = db.prepare(
    `INSERT INTO source (code, name, contract) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, contract = excluded.contract`);
  const upMetric = db.prepare(
    `INSERT INTO metric (code, label, unit, time_role, aggregation, domain) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET label = excluded.label, unit = excluded.unit,
       time_role = excluded.time_role, aggregation = excluded.aggregation, domain = excluded.domain`);
  const upVat = db.prepare(
    `INSERT OR REPLACE INTO vat_rate (fuel, direction, rate, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`);
  tx(() => {
    for (const s of SOURCES) upSource.run(s.code, s.name, JSON.stringify(s.contract));
    for (const m of METRICS) upMetric.run(m.code, m.label, m.unit, m.timeRole, m.aggregation, m.domain);
    for (const v of VAT_RATES) upVat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
  });
}
seedRegistry();

// Columns added after a database was created. Serving tables are rebuilt from facts, so adding is safe.
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const c of cols) if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} REAL`);
}
for (const t of ['site_hh', 'site_day']) addColumns(t, ['solar_to_loss', 'battery_to_loss', 'grid_to_loss', 'loss_cost']);
// Battery stock carried from one day to the next, so a rebuild can start at any day.
addColumns('site_day', ['battery_eff']);
if (!db.prepare('PRAGMA table_info(site_day)').all().some((c) => c.name === 'battery_stock')) db.exec('ALTER TABLE site_day ADD COLUMN battery_stock TEXT');
// Devices and agreements from before versioning: when each was first known is taken from the
// sync log (the first sync whose step for that provider succeeded), else now. Never left empty,
// so a rebuild "as known at" a moment always has an answer.
db.exec(`UPDATE device SET recorded_at = COALESCE((SELECT MIN(r.finished_at) * 1000 FROM sync_run r, json_each(r.detail) j
    WHERE r.site_id = device.site_id AND json_valid(r.detail) AND json_extract(j.value, '$.step') = (CASE device.provider WHEN 'env' THEN 'tariff' ELSE 'octopus' END)
      AND json_extract(j.value, '$.ok') = 1), CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE recorded_at IS NULL;
  UPDATE tariff_agreement SET recorded_at = COALESCE((SELECT recorded_at FROM device WHERE device.id = tariff_agreement.device_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    WHERE recorded_at IS NULL;`);
// The primary key (series_id, ts, recorded_at) already serves every reading lookup; this index was never used.
db.exec('DROP INDEX IF EXISTS reading_current');

const sourceIds = new Map(db.prepare('SELECT code, id FROM source').all().map((r) => [r.code, r.id]));
const metricIds = new Map(db.prepare('SELECT code, id FROM metric').all().map((r) => [r.code, r.id]));

export function sourceId(code) {
  const id = sourceIds.get(code);
  if (!id) throw new Error(`unknown source ${code}`);
  return id;
}
export function metricId(code) {
  const id = metricIds.get(code);
  if (!id) throw new Error(`unknown metric ${code}`);
  return id;
}
// Raw payload files live next to the database file, wherever DB_FILE puts it.
export const dataDir = path.dirname(dbFile);
