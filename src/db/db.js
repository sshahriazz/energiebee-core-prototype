// Opens the SQLite database, applies the schema and seeds the registry.
// Node's built-in SQLite keeps the prototype free of native dependencies.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, METRICS, VAT_RATES, GB_VAT_NOTE } from './registry.js';
import { todMinute } from '../core/time.js';
import { seedMarkets, seedBiddingZones, marketSeedPending } from './seed/markets.js';
import { seedProviders, providerSeedPending } from './seed/providers.js';
import { seedRegionsGb, regionSeedPending } from './seed/regions-gb.js';
import { seedAttributeDefs, attributeSeedPending } from './seed/attributes.js';
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
// Slot length per home (slot plumbing, Oct 2026): site.slot_s, and serving rows that carry their
// own length and local time of day. The old site_hh only allowed half-hours (CHECK slot_start % 1800);
// a CHECK cannot be altered, so that table is set aside here and recreated by the schema below.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site'").get()
  && !db.prepare("SELECT 1 FROM pragma_table_info('site') WHERE name = 'slot_s'").get()) {
  db.exec('ALTER TABLE site ADD COLUMN slot_s INTEGER NOT NULL DEFAULT 1800 CHECK (slot_s IN (900, 1800, 3600))');
}
const oldServing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'site_hh'").get()
  && !db.prepare("SELECT 1 FROM pragma_table_info('site_hh') WHERE name = 'dur_s'").get();
if (oldServing) {
  db.exec('DROP TABLE IF EXISTS site_hh_v1; DROP INDEX IF EXISTS site_hh_day; ALTER TABLE site_hh RENAME TO site_hh_v1;');
}
const SCHEMA = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
upgradeRates();
db.exec(SCHEMA);
if (oldServing) upgradeServing();

// Rate rows for more than GB (Oct 2026): components fixed and capacity with a charge_period, and
// registers beyond single/day/night (hp, hc, blue_hc ...). The old table's CHECKs refuse those and a
// CHECK cannot be altered, so the table is rebuilt once with SQLite's procedure: in one transaction
// with foreign-key checks off, renamed, recreated by schema.sql, every row copied with its id, the
// old table dropped. Rate rows are facts (the only copy), so a failure rolls everything back.
// The overlap trigger is left off while copying (the rows already passed it) and put back by
// schema.sql right after, so the index and trigger are the new ones.
function upgradeRates() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rate_interval'").get()?.sql;
  if (!sql || sql.includes("'capacity'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('DROP TRIGGER IF EXISTS rate_no_overlap; DROP INDEX IF EXISTS rate_current; ALTER TABLE rate_interval RENAME TO rate_interval_v1;');
    db.exec(SCHEMA);
    db.exec('DROP TRIGGER rate_no_overlap');
    const newCols = new Set(db.prepare("SELECT name FROM pragma_table_info('rate_interval')").all().map((c) => c.name));
    const cols = db.prepare("SELECT name FROM pragma_table_info('rate_interval_v1')").all().map((c) => c.name).filter((c) => newCols.has(c)).join(', ');
    db.exec(`INSERT INTO rate_interval (${cols}) SELECT ${cols} FROM rate_interval_v1; DROP TABLE rate_interval_v1;`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Serving tables are rebuilt from facts, so they are disposable. Old rows are all half-hours
// (the old CHECK made sure), so they are carried over as 1800 s slots with their local time of
// day, which keeps the "restated" marks and needs no rebuild. If that copy fails for any reason
// the rows are dropped and a full rebuild is queued for every home; facts are never touched.
function upgradeServing() {
  const newCols = new Set(db.prepare("SELECT name FROM pragma_table_info('site_hh')").all().map((c) => c.name));
  const cols = db.prepare("SELECT name FROM pragma_table_info('site_hh_v1')").all().map((c) => c.name).filter((c) => newCols.has(c) && c !== 'dur_s' && c !== 'tod_min');
  const hasTz = db.prepare("SELECT 1 FROM pragma_table_info('site') WHERE name = 'timezone'").get();
  const tzOf = new Map(db.prepare(`SELECT id, ${hasTz ? 'timezone' : 'NULL AS timezone'} FROM site`).all().map((s) => [s.id, s.timezone || 'Europe/London']));
  db.exec('BEGIN');
  try {
    const ins = db.prepare(`INSERT INTO site_hh (${cols.join(',')}, dur_s, tod_min) VALUES (${cols.map(() => '?').join(',')}, 1800, ?)`);
    for (const r of db.prepare(`SELECT ${cols.join(',')} FROM site_hh_v1`).all()) {
      ins.run(...cols.map((c) => r[c]), todMinute(tzOf.get(r.site_id) || 'Europe/London', r.slot_start));
    }
    db.exec('DROP TABLE site_hh_v1');
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    const now = Math.floor(Date.now() / 1000);
    db.exec('BEGIN');
    try {
      db.exec('DROP TABLE IF EXISTS site_hh_v1; DELETE FROM site_hh; DELETE FROM site_day;');
      const q = db.prepare('INSERT INTO rebuild_queue (site_id, from_ts, to_ts, reason, enqueued_at) VALUES (?, 0, ?, ?, ?)');
      for (const id of tzOf.keys()) q.run(id, now, 'serving tables recreated for per-home slot length', now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
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
  const src = new Map(db.prepare('SELECT code, name, contract FROM source').all().map((r) => [r.code, r]));
  const met = new Map(db.prepare('SELECT code, label, unit, time_role, aggregation, domain FROM metric').all().map((r) => [r.code, r]));
  const vat = new Map(db.prepare('SELECT fuel, direction, rate, valid_from, valid_to FROM vat_rate').all().map((r) => [`${r.fuel}|${r.direction}|${r.valid_from}`, r]));
  const sources = SOURCES.filter((s) => { const r = src.get(s.code); return !r || r.name !== s.name || r.contract !== JSON.stringify(s.contract); });
  const metrics = METRICS.filter((m) => {
    const r = met.get(m.code);
    return !r || r.label !== m.label || r.unit !== m.unit || r.time_role !== m.timeRole || r.aggregation !== m.aggregation || r.domain !== m.domain;
  });
  const rates = VAT_RATES.filter((v) => { const r = vat.get(`${v.fuel}|${v.direction}|${v.validFrom}`); return !r || r.rate !== v.rate || r.valid_to !== (v.validTo ?? null); });
  if (!sources.length && !metrics.length && !rates.length) return;
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
    for (const s of sources) upSource.run(s.code, s.name, JSON.stringify(s.contract));
    for (const m of metrics) upMetric.run(m.code, m.label, m.unit, m.timeRole, m.aggregation, m.domain);
    for (const v of rates) upVat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
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
// The slot length each day was built with; days built before it was recorded were half-hours.
if (!db.prepare('PRAGMA table_info(site_day)').all().some((c) => c.name === 'slot_s')) {
  db.exec('ALTER TABLE site_day ADD COLUMN slot_s INTEGER; UPDATE site_day SET slot_s = 1800;');
}
// Devices and agreements from before versioning: when each was first known is taken from the
// sync log (the first sync whose step for that provider succeeded), else now. Never left empty,
// so a rebuild "as known at" a moment always has an answer. Checked first, so an up-to-date open
// runs no UPDATE (an UPDATE takes the write lock even when it changes no row).
if (db.prepare('SELECT 1 FROM device WHERE recorded_at IS NULL UNION ALL SELECT 1 FROM tariff_agreement WHERE recorded_at IS NULL LIMIT 1').get()) db.exec(`UPDATE device SET recorded_at = COALESCE((SELECT MIN(r.finished_at) * 1000 FROM sync_run r, json_each(r.detail) j
    WHERE r.site_id = device.site_id AND json_valid(r.detail) AND json_extract(j.value, '$.step') = (CASE device.provider WHEN 'env' THEN 'tariff' ELSE 'octopus' END)
      AND json_extract(j.value, '$.ok') = 1), CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE recorded_at IS NULL;
  UPDATE tariff_agreement SET recorded_at = COALESCE((SELECT recorded_at FROM device WHERE device.id = tariff_agreement.device_id), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    WHERE recorded_at IS NULL;`);
// The primary key (series_id, ts, recorded_at) already serves every reading lookup; this index was never used.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'reading_current'").get()) db.exec('DROP INDEX reading_current');

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
// with a table that db.js rebuilt): deltas stay safe to run again, so this only restores what is missing.
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
  // Prototype users (070): who is looking, and which homes each one may see (src/core/users.js);
  // sign-up, sessions and each home's encrypted provider logins (071).
  '070-users.sql', '071-auth.sql'];

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
