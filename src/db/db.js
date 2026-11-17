// Opens the Postgres database through Prisma and seeds the registries.
//
// The schema (tables, constraints, triggers, views) is the SQL in prisma/migrations, applied by
// `npm run db:migrate` (prisma migrate deploy) before the app starts; this module never changes it.
// Prisma is the driver and the typed client (`prisma`); most of the core speaks SQL through `db`,
// which keeps one small, explicit contract:
//
//   db.prepare(sql)            a statement; `?` placeholders, numbered for Postgres on the way out
//     .all(...params)          -> Promise<row[]>
//     .get(...params)          -> Promise<row | undefined>   (the first row)
//     .run(...params)          -> Promise<{ changes, lastInsertRowid }>  (an INSERT into a table with an
//                                 `id` column returns the new id, through RETURNING id)
//   db.exec(sql)               one or more statements without parameters
//   tx(async () => ...)        one transaction around fn. Re-entrant: a tx() inside another joins it.
//                              Every db call inside fn, however deep, runs in that transaction
//                              (AsyncLocalStorage), so callers never pass a transaction handle.
//
// Rows come back with plain JavaScript values: 64-bit integers and numerics as numbers, booleans as
// 0 / 1 (the schema's flags are integers), bytea as Buffer. Postgres errors are reported in one
// vocabulary: "CHECK constraint failed: <name>", "UNIQUE constraint failed: <name>", "FOREIGN KEY
// constraint failed: <name>", "NOT NULL constraint failed: <column>", the readable message of an
// exclusion constraint (EXCLUSION_MESSAGES) and a trigger's own message, with `code` set to the
// Postgres error code.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { SOURCES, METRICS, VAT_RATES, GB_VAT_NOTE } from './registry.js';
import { seedMarkets, seedBiddingZones, marketSeedPending } from './seed/markets.js';
import { seedProviders, providerSeedPending } from './seed/providers.js';
import { seedRegionsGb, regionSeedPending } from './seed/regions-gb.js';
import { seedAttributeDefs, attributeSeedPending } from './seed/attributes.js';
import { seedBindings, bindingSeedPending } from './seed/bindings.js';
import { seedSettingDefs, settingSeedPending } from './seed/settings.js';
import { resolveRegion } from '../core/regions.js';
import { EU_VAT_RULES } from '../core/tax.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

export const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
// Raw payload files, logs and demo data: DATA_DIR, default data/ in the project.
export const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

// ───────────── statements ─────────────
const txStore = new AsyncLocalStorage();
const client = () => txStore.getStore() ?? prisma;

// `?` -> $1, $2 ... outside quoted strings, quoted identifiers, comments and dollar-quoted bodies.
export function numberParams(sql) {
  let out = ''; let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const j = sql.indexOf(c, i + 1);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end + 1); i = end; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end); i = end - 1; continue;
    }
    if (c === '$' && sql[i + 1] === '$') {
      const j = sql.indexOf('$$', i + 2);
      const end = j < 0 ? sql.length : j + 1;
      out += sql.slice(i, end + 1); i = end; continue;
    }
    out += c === '?' ? `$${++n}` : c;
  }
  return out;
}

function plain(v) {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`integer ${v} is outside the safe range`);
    return Number(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v && typeof v === 'object' && typeof v.toNumber === 'function' && typeof v.toFixed === 'function') return v.toNumber();   // Prisma Decimal
  return v;
}
function plainRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = plain(row[k]);
  return out;
}

// Exclusion constraints that replaced SQLite's overlap triggers, with the messages those triggers gave.
export const EXCLUSION_MESSAGES = {
  rate_no_overlap: 'overlapping current rate interval',
  agreement_no_overlap: 'overlapping tariff agreement for this meter',
  member_no_overlap: 'overlapping current membership of this home in the group',
};
function translateError(err, sql) {
  const cause = err?.meta?.driverAdapterError?.cause ?? err?.cause;
  const code = cause?.originalCode ?? cause?.code;
  const msg = cause?.originalMessage ?? cause?.message ?? err?.message ?? String(err);
  if (!code) return err;
  const name = /constraint "([^"]+)"/.exec(msg)?.[1] ?? cause?.constraint?.index ?? '';
  const text = code === '23514' ? `CHECK constraint failed: ${name}`
    : code === '23505' ? `UNIQUE constraint failed: ${name}`
      : code === '23503' ? `FOREIGN KEY constraint failed: ${name}`
        : code === '23502' ? `NOT NULL constraint failed: ${/column "([^"]+)"/.exec(msg)?.[1] ?? ''}`
          : code === '23P01' ? (EXCLUSION_MESSAGES[name] ?? `overlapping rows: ${name}`)
            : code === 'P0001' ? msg
              : `${msg} (Postgres ${code})`;
  const out = new Error(text, { cause: err });
  out.code = code;
  out.sql = sql;
  return out;
}

// Tables with an `id` column: an INSERT into one returns the new id (lastInsertRowid).
let idTables = null;
async function hasId(table) {
  if (!idTables) {
    const rows = await prisma.$queryRawUnsafe("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'");
    idTables = new Set(rows.map((r) => r.table_name));
  }
  return idTables.has(table);
}

class Statement {
  constructor(sql) {
    this.sql = numberParams(sql);
    const ins = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(sql);
    this.insertTable = ins && !/\bRETURNING\b/i.test(sql) ? ins[1] : null;
  }

  async all(...params) {
    try {
      const rows = await client().$queryRawUnsafe(this.sql, ...params);
      return rows.map(plainRow);
    } catch (err) { throw translateError(err, this.sql); }
  }

  async get(...params) {
    return (await this.all(...params))[0];
  }

  async run(...params) {
    try {
      if (this.insertTable && await hasId(this.insertTable)) {
        const rows = await client().$queryRawUnsafe(`${this.sql.replace(/;\s*$/, '')} RETURNING id`, ...params);
        return { changes: rows.length, lastInsertRowid: rows.length ? plain(rows[rows.length - 1].id) : undefined };
      }
      return { changes: await client().$executeRawUnsafe(this.sql, ...params) };
    } catch (err) { throw translateError(err, this.sql); }
  }
}

// Split SQL into statements on `;` outside strings, comments and dollar-quoted bodies.
export function splitSql(sql) {
  const out = []; let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') { const j = sql.indexOf(c, i + 1); const end = j < 0 ? sql.length : j; cur += sql.slice(i, end + 1); i = end; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const end = j < 0 ? sql.length : j; i = end - 1; continue; }
    if (c === '$' && sql[i + 1] === '$') { const j = sql.indexOf('$$', i + 2); const end = j < 0 ? sql.length : j + 1; cur += sql.slice(i, end + 1); i = end; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const db = {
  prepare: (sql) => new Statement(sql),
  async exec(sql) {
    for (const s of splitSql(sql)) {
      try { await client().$executeRawUnsafe(s); } catch (err) { throw translateError(err, s); }
    }
  },
};

export async function tx(fn) {
  if (txStore.getStore()) return fn();
  return prisma.$transaction((t) => txStore.run(t, fn), { maxWait: 60_000, timeout: 30 * 60_000 });
}
export const inTx = () => Boolean(txStore.getStore());

// ───────────── registries ─────────────
// Registry rows are data: adding a source or metric never changes the schema. These rows are owned by
// the code (registry.js), not by an operator: a missing row is inserted and a row that differs from the
// code is brought back in line. Only rows that differ are written.
async function seedRegistry() {
  const src = new Map((await db.prepare('SELECT code, name, contract, traits FROM source').all()).map((r) => [r.code, r]));
  const met = new Map((await db.prepare('SELECT code, label, unit, time_role, aggregation, domain FROM metric').all()).map((r) => [r.code, r]));
  const vat = new Map((await db.prepare('SELECT fuel, direction, rate, valid_from, valid_to FROM vat_rate').all()).map((r) => [`${r.fuel}|${r.direction}|${r.valid_from}`, r]));
  const sources = SOURCES.filter((s) => { const r = src.get(s.code); return !r || r.name !== s.name || r.contract !== JSON.stringify(s.contract) || (r.traits ?? null) !== (s.traits ? JSON.stringify(s.traits) : null); });
  const metrics = METRICS.filter((m) => {
    const r = met.get(m.code);
    return !r || r.label !== m.label || r.unit !== m.unit || r.time_role !== m.timeRole || r.aggregation !== m.aggregation || r.domain !== m.domain;
  });
  const rates = VAT_RATES.filter((v) => { const r = vat.get(`${v.fuel}|${v.direction}|${v.validFrom}`); return !r || r.rate !== v.rate || r.valid_to !== (v.validTo ?? null); });
  if (!sources.length && !metrics.length && !rates.length) return;
  const upSource = db.prepare(`INSERT INTO source (code, name, contract, traits) VALUES (?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, contract = excluded.contract, traits = excluded.traits`);
  const upMetric = db.prepare(`INSERT INTO metric (code, label, unit, time_role, aggregation, domain) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET label = excluded.label, unit = excluded.unit,
       time_role = excluded.time_role, aggregation = excluded.aggregation, domain = excluded.domain`);
  const upVat = db.prepare(`INSERT INTO vat_rate (fuel, direction, rate, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (fuel, direction, valid_from) DO UPDATE SET rate = excluded.rate, valid_to = excluded.valid_to`);
  await tx(async () => {
    for (const s of sources) await upSource.run(s.code, s.name, JSON.stringify(s.contract), s.traits ? JSON.stringify(s.traits) : null);
    for (const m of metrics) await upMetric.run(m.code, m.label, m.unit, m.timeRole, m.aggregation, m.domain);
    for (const v of rates) await upVat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
  });
}

// GB VAT has one source, VAT_RATES in registry.js, kept in tax_rule: when VAT_RATES changes, the current
// GB VAT rules are superseded (kept, so an "as known at" rebuild still sees what was known then) and the
// new set is recorded now. Returns true when it changed anything.
export async function syncGbVat(rates = VAT_RATES) {
  const key = (r) => [r.fuel, r.direction, r.rate ?? r.value, r.validFrom ?? r.valid_from, r.validTo ?? r.valid_to ?? null].join('|');
  const want = rates.map(key).sort();
  const have = (await db.prepare("SELECT fuel, direction, value, valid_from, valid_to FROM tax_rule WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL").all()).map(key).sort();
  if (JSON.stringify(want) === JSON.stringify(have)) return false;
  const now = Date.now();
  await tx(async () => {
    await db.prepare("UPDATE tax_rule SET superseded_at = ? WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL").run(now);
    const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
      VALUES ('GB', 'vat', ?, ?, 'domestic', 'all', 'percent', ?, NULL, NULL, 100, ?, ?, 'vat_rate (registry.js VAT_RATES)', 0, ?, 'sourced', ?)`);
    for (const v of rates) await ins.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null, now, GB_VAT_NOTE);
  });
  return true;
}

// FR and NL VAT (EU_VAT_RULES in core/tax.js), kept in tax_rule the same way: per country and code, when
// the current rows differ from the list they are superseded and the list is recorded now. Returns the
// countries changed; a home already built with no VAT rule is rebuilt by the caller (server start-up).
export async function syncVatRules(rules = EU_VAT_RULES) {
  const key = (r) => [r.applies_to, r.value, r.valid_from, r.valid_to ?? null, r.source].join('|');
  const groups = new Map();
  for (const r of rules) {
    const k = `${r.country}/${r.code}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const changed = [];
  const now = Date.now();
  for (const [k, list] of groups) {
    const [country, code] = k.split('/');
    const have = (await db.prepare("SELECT applies_to, value, valid_from, valid_to, source FROM tax_rule WHERE country = ? AND code = ? AND fuel = 'electricity' AND direction = 'import' AND superseded_at IS NULL").all(country, code)).map(key).sort();
    if (JSON.stringify(list.map(key).sort()) === JSON.stringify(have)) continue;
    await tx(async () => {
      await db.prepare("UPDATE tax_rule SET superseded_at = ? WHERE country = ? AND code = ? AND fuel = 'electricity' AND direction = 'import' AND superseded_at IS NULL").run(now, country, code);
      const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq, valid_from, valid_to, source, unverified, recorded_at, origin, origin_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, ?, ?, ?)`);
      for (const r of list) await ins.run(r.country, r.code, r.fuel, r.direction, r.customer_class, r.applies_to, r.kind, r.value, r.seq, r.valid_from, r.valid_to ?? null, r.source, now, r.origin, r.origin_note);
    });
    changed.push(country);
  }
  return changed;
}

// Start-up seeding: the code-owned registries, VAT, the reference rows of each market (markets, bidding
// zones, the 14 GB regions with their aliases, the providers of each role), default bindings, the planner
// registries, and a GB home's distribution region from its postcode lookup. Each step writes only what is
// missing or differs, so starting against an up-to-date database writes nothing.
await seedRegistry();
await syncGbVat();
export const vatRulesChanged = await syncVatRules();
if (await marketSeedPending(db) || await regionSeedPending(db) || await providerSeedPending(db)) {
  await tx(async () => { await seedMarkets(db); await seedBiddingZones(db); await seedRegionsGb(db); await seedProviders(db); });
}
if (await bindingSeedPending(db)) await tx(() => seedBindings(db));
if (await attributeSeedPending(db) || await settingSeedPending(db)) await tx(async () => { await seedAttributeDefs(db); await seedSettingDefs(db); });
{
  // A row already there (an installer's correction) is never overwritten.
  const put = db.prepare("INSERT INTO site_region (site_id, scheme, code, source, recorded_at) VALUES (?, 'gb_dno', ?, 'postcode_lookup', ?) ON CONFLICT DO NOTHING");
  for (const s of await db.prepare(`SELECT id, gsp_region, created_at FROM site WHERE gsp_region IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM site_region r WHERE r.site_id = site.id AND r.scheme = 'gb_dno' AND r.superseded_at IS NULL)`).all()) {
    const region = resolveRegion('octopus_gsp', s.gsp_region);
    if (region) await put.run(s.id, region.code, (s.created_at ?? 0) * 1000);
  }
}

// Code to id maps. A code that is not cached is looked up again, so a source or metric row added while
// the process runs works without a restart.
const sourceIds = new Map();
const metricIds = new Map();
async function lookup(cache, table, code, what) {
  let id = cache.get(code);
  if (!id) {
    id = (await db.prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code))?.id;
    if (!id) throw new Error(`unknown ${what} ${code}`);
    cache.set(code, id);
  }
  return id;
}
export const sourceId = (code) => lookup(sourceIds, 'source', code, 'source');
export const metricId = (code) => lookup(metricIds, 'metric', code, 'metric');

// Planner statistics: ANALYZE after a rebuild (build.js processQueue, the rebuild endpoint) so the planner
// keeps choosing the indexes as the tables grow. Best effort.
export async function optimizeDb() {
  try { await prisma.$executeRawUnsafe('ANALYZE'); return true; } catch { return false; }
}
export async function closeDb() {
  await prisma.$disconnect();
}
