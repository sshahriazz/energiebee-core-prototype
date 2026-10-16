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
export const dataDir = path.join(root, 'data');
