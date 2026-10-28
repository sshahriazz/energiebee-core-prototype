// Opens the SQLite database, applies the schema and seeds the registry.
// Node's built-in SQLite keeps the prototype free of native dependencies.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, METRICS, VAT_RATES, GB_VAT_NOTE } from './registry.js';
import { seedMarkets, seedBiddingZones, marketSeedPending } from './seed/markets.js';
import { seedProviders, providerSeedPending } from './seed/providers.js';
import { seedRegionsGb, regionSeedPending } from './seed/regions-gb.js';
import { seedAttributeDefs, attributeSeedPending } from './seed/attributes.js';
import { seedBindings, bindingSeedPending } from './seed/bindings.js';
import { seedSettingDefs, settingSeedPending } from './seed/settings.js';
import { resolveRegion } from '../core/regions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const dbFile = path.resolve(root, process.env.DB_FILE || 'data/core.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new DatabaseSync(dbFile);
// busy_timeout first: a second process (a script, a test, a server started during a sync) waits up
// to 5 s for another connection's write instead of failing at once with "database is locked".
// An up-to-date database is opened without writing anything (below), so opening it never waits.
export const BUSY_TIMEOUT_MS = 5000;
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`);
// A database is created by schema.sql and from then on changed only by the deltas (below). One from
// before the deltas is not upgraded: it is refused before anything is written (see predatesSchema).
const SCHEMA = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
if (predatesSchema()) {
  db.close();
  throw new Error('This database predates the current schema; delete data/core.db and start fresh (npm run reset)');
}
db.exec(SCHEMA);

// A database from before the deltas: no schema_delta table, and a table schema.sql defines is there
// without every column schema.sql gives it (for example a tariff_agreement without recorded_at, or
// a site_hh without dur_s). A new, empty file is not, nor is one whose first open stopped after
// schema.sql and before the first delta (its tables already have today's shape).
function predatesSchema() {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_delta'").get()) return false;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  if (!tables.length) return false;
  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec(SCHEMA);
    const cols = (c, t) => c.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name);
    return tables.some((t) => { const have = new Set(cols(db, t)); return cols(fresh, t).some((c) => !have.has(c)); });
  } finally {
    fresh.close();
  }
}

// One transaction around fn. Re-entrant: a tx() inside another joins the outer one (a writer that
// stores windows, calendar days and rate rows together commits or rolls back all of them).
// BEGIN IMMEDIATE takes the write lock at the start, waiting up to busy_timeout for another
// connection's write. A deferred BEGIN would read first and then fail at once (SQLITE_BUSY, no
// wait) if another connection committed in between, when it tried to write.
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) {
    txDepth++;
    try { return fn(); } finally { txDepth--; }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

// Registry rows are data: adding a source or metric never changes the schema.
// These rows are owned by the code (registry.js), not by an operator: a missing row is inserted and
// a row that differs from the code is brought back in line. Only rows that differ are written, so
// an open of an up-to-date database writes nothing (and takes no write lock).
function seedRegistry() {
  // source.traits exists from delta 063; on an older database the first pass skips it and the pass after the deltas writes it.
  const hasTraits = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('source') WHERE name = 'traits'").get());
  const src = new Map(db.prepare(`SELECT code, name, contract, ${hasTraits ? 'traits' : 'NULL AS traits'} FROM source`).all().map((r) => [r.code, r]));
  const met = new Map(db.prepare('SELECT code, label, unit, time_role, aggregation, domain FROM metric').all().map((r) => [r.code, r]));
  const vat = new Map(db.prepare('SELECT fuel, direction, rate, valid_from, valid_to FROM vat_rate').all().map((r) => [`${r.fuel}|${r.direction}|${r.valid_from}`, r]));
  const sources = SOURCES.filter((s) => { const r = src.get(s.code); return !r || r.name !== s.name || r.contract !== JSON.stringify(s.contract) || (hasTraits && (r.traits ?? null) !== (s.traits ? JSON.stringify(s.traits) : null)); });
  const metrics = METRICS.filter((m) => {
    const r = met.get(m.code);
    return !r || r.label !== m.label || r.unit !== m.unit || r.time_role !== m.timeRole || r.aggregation !== m.aggregation || r.domain !== m.domain;
  });
  const rates = VAT_RATES.filter((v) => { const r = vat.get(`${v.fuel}|${v.direction}|${v.validFrom}`); return !r || r.rate !== v.rate || r.valid_to !== (v.validTo ?? null); });
  if (!sources.length && !metrics.length && !rates.length) return;
  const upSource = hasTraits ? db.prepare(
    `INSERT INTO source (code, name, contract, traits) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, contract = excluded.contract, traits = excluded.traits`)
    : db.prepare(`INSERT INTO source (code, name, contract) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, contract = excluded.contract`);
  const upMetric = db.prepare(
    `INSERT INTO metric (code, label, unit, time_role, aggregation, domain) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET label = excluded.label, unit = excluded.unit,
       time_role = excluded.time_role, aggregation = excluded.aggregation, domain = excluded.domain`);
  const upVat = db.prepare(
    `INSERT OR REPLACE INTO vat_rate (fuel, direction, rate, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`);
  tx(() => {
    for (const s of sources) upSource.run(...(hasTraits ? [s.code, s.name, JSON.stringify(s.contract), s.traits ? JSON.stringify(s.traits) : null] : [s.code, s.name, JSON.stringify(s.contract)]));
    for (const m of metrics) upMetric.run(m.code, m.label, m.unit, m.timeRole, m.aggregation, m.domain);
    for (const v of rates) upVat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
  });
}
seedRegistry();

// ───────────── Deltas: money and tax (002), markets and regions (003), tariff kind and ledger currency (004),
// provenance labels (005), register windows and estimated rates (006), contracted capacity (007),
// market provider registry (008), provider state: rate-limit cooldown and sweep progress (009),
// provider owner 'core' or 'external' (010: market_provider rebuilt, same rows), tounify v3:
// tariff.taxes_in_price and the tounify rows switched on, unlicensed (011), overlap guards on UPDATE,
// register-window overlap and consistency checks a NULL cannot bypass (012), indexes for the
// history and "as known at" reads, foreign-key child indexes and series.max_span_s (013) ─────────────
// Applied in order after schema.sql and after vat_rate is seeded (002 copies GB VAT from it into
// tax_rule), each ONCE: a delta whose name is in schema_delta (every delta records itself as its
// last statement) is skipped, so an open of an up-to-date database runs no delta and writes nothing.
// A recorded delta is applied again only when an object it creates is missing (a table, index or
// trigger named in a CREATE ... IF NOT EXISTS, or an ADD COLUMN's column; for example a trigger lost
// with a table rebuilt by hand): deltas stay safe to run again, so this only restores what is missing.
// A change to the schema is therefore a NEW delta file, never an edit of an applied one.
// 010 rebuilds market_provider only while the table still has an older owner CHECK (a table created
// by today's 008 already has 'core'/'external'); otherwise it is recorded without the rebuild.
// The rules each delta states at its top: statements end with ';' at the end of a line, a trigger
// ends with a line 'END;', and an ADD COLUMN whose column exists is skipped (SQLite has no ADD
// COLUMN IF NOT EXISTS). Backfills are also guarded by schema_delta, so homes and tariffs that exist
// the first time a delta runs become GB / GBP / market GB once, and later ones keep their own values.
export const DELTAS = ['002-money-tax.sql', '003-market-region.sql', '004-tariff-ledger.sql', '005-provenance.sql', '006-register-window.sql', '007-capacity.sql', '008-market-provider.sql', '009-provider-state.sql', '010-provider-owner.sql', '011-tounify.sql', '012-integrity.sql', '013-indexes.sql',
  // Phase B configuration (020-029): attribute_def, attribute_value, device_kind and site_attribute.origin (020);
  // setting_def, site_setting (021); site_version, tariff_version and their triggers, "as known at" settings (022);
  // refs (catalogue ids) on attribute_def and setting_def, and the first seed's unused rows replaced (023);
  // 024 adds the site and tariff columns 022 copies to databases from an early schema, so it runs before 022.
  '020-attribute-registry.sql', '021-site-setting.sql', '024-site-tariff-columns.sql', '022-site-version.sql', '023-registry-refs.sql',
  // Phase B plans and commands (030-039), tables only, no planner yet: device_action, device_capability,
  // plan_run, plan_run_device, plan_slot, plan_input_ref, plan_score and their views (030); command, command_log (031);
  // the columns, 'auto' / 'release' actions and window views the requirements catalogue needs (032);
  // those two actions added to the device_kind rows seeded before 032 (033).
  '030-plan.sql', '031-command.sql', '032-plan-requirements.sql', '033-device-kind-actions.sql',
  // Phase B data (040-049): forecast_fact bitemporal, its key with end_ts (040, a table rebuild that keeps
  // every row, index and trigger); site_heat_slot, the heating serving table (041).
  '040-forecast-bitemporal.sql', '041-heat-slot.sql',
  // Phase B planner read layer (050-059): rate rows by tariff, component and register over every version,
  // for "as known at" price reads (050).
  '050-planner-read.sql',
  // Phase B coverage matrix (060-069): the schema elements docs/coverage-matrix.json found missing that registry rows
  // cannot hold: the prices and clipping a plan used per slot, and the planning design's tenant record (060).
  '060-coverage.sql',
  // Bindings (061): which source fills a role for a home, by period.
  '061-binding.sql',
  // Binding defaults (062): the sources a new home starts with, per role; no vendor fallback in code.
  '062-binding-defaults.sql',
  // Source traits (063): machine-read facts about a source, replacing vendor lists in the planner read.
  '063-source-traits.sql',
  // Channels (064): a vendor point -> canonical metric with scale, sign part and range.
  '064-channel.sql',
  // A channel may belong to one device (065).
  '065-channel-device.sql',
  // A binding may name a device: two devices of one kind are added together (066).
  '066-binding-device.sql',
  // Stage 4 control read-back (067) and Stage 5 groups, grants, slot currency (070): reserved, filled by their own work.
  '067-control.sql', '070-groups.sql',
  // channel.part 'abs' (a table rebuild) and no overlapping group membership (071).
  '071-channel-abs-member-overlap.sql',
  // Channel kinds (counter, event) and optional checks (072).
  '072-channel-kinds.sql'];

export function deltaStatements(sql) {
  const out = [];
  let buf = [];
  for (const line of sql.split('\n')) {
    const code = line.replace(/--.*$/, '').trim();
    if (!buf.length && !code) continue;
    buf.push(line);
    const text = buf.join('\n').replace(/--.*$/gm, '').trim();
    const done = /^CREATE\s+TRIGGER/i.test(text) ? /^END;$/i.test(code) : code.endsWith(';');
    if (done) { out.push(buf.join('\n')); buf = []; }
  }
  if (buf.some((l) => l.replace(/--.*$/, '').trim())) throw new Error('delta: unterminated statement');
  return out;
}

export function applyDelta(sql) {
  tx(() => {
    for (const s of deltaStatements(sql)) {
      const add = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/im.exec(s.replace(/--.*$/gm, ''));
      if (add && db.prepare(`SELECT 1 FROM pragma_table_info('${add[1]}') WHERE name = ?`).get(add[2])) continue;
      db.exec(s);
    }
  });
}

// The tables, indexes and triggers a delta creates (CREATE ... IF NOT EXISTS) and the columns it adds.
export function deltaObjects(sql) {
  const code = sql.replace(/--.*$/gm, '');
  const objects = [...code.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(?:main\.)?(\w+)/gi)].map((m) => m[1]);
  const columns = [...code.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)].map((m) => [m[1], m[2]]);
  return { objects, columns };
}

// Whether a delta has to run on this open (see the note above DELTAS).
export function deltaPending(name, sql) {
  const recorded = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_delta'").get()
    && db.prepare('SELECT 1 FROM schema_delta WHERE name = ?').get(name);
  if (!recorded) return true;
  const { objects, columns } = deltaObjects(sql);
  const have = db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?');
  const col = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?');
  return objects.some((o) => !have.get(o)) || columns.some(([t, c]) => !col.get(t, c));
}

// Delta 010's rebuild is needed only while market_provider still has an older owner CHECK.
function marketProviderCurrent() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'market_provider'").get()?.sql;
  return Boolean(sql && /CHECK \(owner IN \('core', 'external'\)\)/.test(sql));
}

export function applyDeltas() {
  for (const f of DELTAS) {
    const name = f.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(here, 'deltas', f), 'utf8');
    if (!deltaPending(name, sql)) continue;
    if (name === '010-provider-owner' && marketProviderCurrent()) {
      tx(() => db.exec(`CREATE INDEX IF NOT EXISTS market_provider_role ON market_provider (role, market_code, priority);
        INSERT OR IGNORE INTO schema_delta (name, applied_at) VALUES ('${name}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);`));
      continue;
    }
    if (name === '040-forecast-bitemporal') { keepTableObjects('forecast_fact', () => applyDelta(sql)); continue; }
    applyDelta(sql);
  }
}

// A delta that rebuilds a table (a key or a CHECK cannot be altered) drops the indexes and triggers
// other changes put on it (013's forecast_issued, forecast_fact_raw and max_span_s triggers on
// forecast_fact): each is created again from its stored SQL in the same transaction, after the rows
// are copied back, so the rebuild loses none and a later open has nothing to restore.
function keepTableObjects(table, fn) {
  tx(() => {
    const kept = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table);
    fn();
    const has = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?');
    for (const o of kept) if (!has.get(o.type, o.name)) db.exec(o.sql);
  });
}
applyDeltas();
seedRegistry();   // again: delta 063 added source.traits

// GB VAT has one source, VAT_RATES in registry.js: vat_rate is kept in line with it on every open
// (seedRegistry, above; written only where it differs) and delta 002 copies it into tax_rule once. When VAT_RATES changes later, the current GB
// VAT rules are superseded (kept, so an "as known at" rebuild still sees what was known then) and
// the new set is recorded now. Returns true when it changed anything.
export function syncGbVat(rates = VAT_RATES) {
  const key = (r) => [r.fuel, r.direction, r.rate ?? r.value, r.validFrom ?? r.valid_from, r.validTo ?? r.valid_to ?? null].join('|');
  const want = rates.map(key).sort();
  const have = db.prepare("SELECT fuel, direction, value, valid_from, valid_to FROM tax_rule WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL").all().map(key).sort();
  if (JSON.stringify(want) === JSON.stringify(have)) return false;
  const now = Date.now();
  tx(() => {
    db.prepare("UPDATE tax_rule SET superseded_at = ? WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL").run(now);
    const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
      VALUES ('GB', 'vat', ?, ?, 'domestic', 'all', 'percent', ?, NULL, NULL, 100, ?, ?, 'vat_rate (registry.js VAT_RATES)', 0, ?, 'sourced', ?)`);
    for (const v of rates) ins.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null, now, GB_VAT_NOTE);
  });
  return true;
}
syncGbVat();
// Reference rows: markets (FR, NL and the unverified stand-ins), one bidding-zone region per market,
// the 14 GB distribution regions with their Octopus, Tariffscanner id and name aliases, and the
// providers of each market's roles (seed/providers.js). Only missing rows are inserted, so an
// operator's edit (a market's intervals, a region's name, an alias, a provider's priority or switches)
// is never overwritten. The one exception: the descriptive columns of a provider row (owner, scope,
// needs_credentials, origin, note) follow the adapter code, written only where they differ. The
// transaction is opened only when something is missing, so an up-to-date open takes no write lock.
if (marketSeedPending(db) || regionSeedPending(db) || providerSeedPending(db)) {
  tx(() => { seedMarkets(db); seedBiddingZones(db); seedRegionsGb(db); seedProviders(db); });
}
// Default bindings per role and a backfill for homes without them (seed/bindings.js, delta 062).
if (bindingSeedPending(db)) tx(() => seedBindings(db));
// Planner configuration registries (attribute_def, device_kind, setting_def: seed/attributes.js,
// seed/settings.js): only missing rows are inserted, and only when one is missing.
if (attributeSeedPending(db) || settingSeedPending(db)) tx(() => { seedAttributeDefs(db); seedSettingDefs(db); });
// A GB home's distribution region, from the Octopus GSP letter that geo.js stored on the site
// (from the postcode lookup): recorded once in site_region when the home has no current gb_dno
// row. A row already there (an installer's correction) is never overwritten.
if (db.prepare("SELECT 1 FROM pragma_table_info('site') WHERE name = 'gsp_region'").get()) {
  const put = db.prepare("INSERT OR IGNORE INTO site_region (site_id, scheme, code, source, recorded_at) VALUES (?, 'gb_dno', ?, 'postcode_lookup', ?)");
  for (const s of db.prepare(`SELECT id, gsp_region, created_at FROM site WHERE gsp_region IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM site_region r WHERE r.site_id = site.id AND r.scheme = 'gb_dno' AND r.superseded_at IS NULL)`).all()) {
    const region = resolveRegion('octopus_gsp', s.gsp_region);
    if (region) put.run(s.id, region.code, (s.created_at ?? 0) * 1000);
  }
}

// Code to id maps. A code that is not cached is looked up again, so a source or metric row added
// while the process runs works without a restart.
const sourceIds = new Map();
const metricIds = new Map();
function lookup(cache, table, code, what) {
  let id = cache.get(code);
  if (!id) {
    id = db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code)?.id;
    if (!id) throw new Error(`unknown ${what} ${code}`);
    cache.set(code, id);
  }
  return id;
}
export const sourceId = (code) => lookup(sourceIds, 'source', code, 'source');
export const metricId = (code) => lookup(metricIds, 'metric', code, 'metric');
// Raw payload files live next to the database file, wherever DB_FILE puts it.
export const dataDir = path.dirname(dbFile);

// Planner statistics (sqlite_stat1). PRAGMA optimize runs ANALYZE only on the tables whose
// statistics are missing or out of date (cheap when none are), so the planner keeps choosing the
// indexes as the tables grow. Run after a rebuild (build.js processQueue, the rebuild endpoint) and
// when the connection is closed (closeDb). Best effort: a failure (a lock held past busy_timeout)
// is left for the next run.
export function optimizeDb() {
  try { db.exec('PRAGMA optimize'); return true; } catch { return false; }
}
export function closeDb() {
  optimizeDb();
  db.close();
}
