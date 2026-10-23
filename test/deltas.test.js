// Deltas 002 (money, tax), 003 (market, region), 004 (tariff kind, ledger currency), 005 (provenance),
// 006 (register windows, estimated rates), 007 (contracted capacity), 008 (market provider registry), 009 (provider
// state: rate-limit cooldown, sweep progress) and 010 (provider owner core / external) applied on top of the
// CURRENT schema.sql in an in-memory database: they apply cleanly, again without change, backfill
// existing homes and tariffs as GB/GBP (and provider / sourced) once, and their CHECKs and
// triggers refuse what they should.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VAT_RATES } from '../src/db/registry.js';
import { GB_VAT_RULES } from '../src/core/tax.js';
import { CURRENCIES } from '../src/core/money.js';
import { MARKETS, MARKET_COLUMNS, seedMarkets } from '../src/db/seed/markets.js';
import { GB_REGIONS, GB_REGION_ALIASES, seedRegionsGb } from '../src/db/seed/regions-gb.js';

const dbDir = path.resolve(import.meta.dirname, '..', 'src', 'db');
const SCHEMA = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
const DELTA_FILES = ['002-money-tax.sql', '003-market-region.sql', '004-tariff-ledger.sql', '005-provenance.sql', '006-register-window.sql', '007-capacity.sql', '008-market-provider.sql', '009-provider-state.sql', '010-provider-owner.sql'];
const DELTAS =DELTA_FILES.map((f) => fs.readFileSync(path.join(dbDir, 'deltas', f), 'utf8'));

// The applying rules stated at the top of each delta: statements end with ';' at the end of a
// line, a trigger ends with 'END;', and an ADD COLUMN whose column exists is skipped.
function statements(sql) {
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
  assert.equal(buf.filter((l) => l.replace(/--.*$/, '').trim()).length, 0, 'unterminated statement');
  return out;
}

function applyDelta(db, sql) {
  db.exec('BEGIN');
  try {
    for (const s of statements(sql)) {
      const add = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/im.exec(s.replace(/--.*$/gm, ''));
      if (add && db.prepare(`SELECT 1 FROM pragma_table_info('${add[1]}') WHERE name = ?`).get(add[2])) continue;
      db.exec(s);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// A database as db.js leaves it today, with one GB home on two tariffs.
function existingDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const vat = db.prepare('INSERT OR REPLACE INTO vat_rate (fuel, direction, rate, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)');
  for (const v of VAT_RATES) vat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
  db.exec(`
    INSERT INTO site (id, name, postcode, gsp_region, carbon_region, created_at) VALUES (1, 'Home', 'BB12 9BY', 'G', 3, 1700000000);
    INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure, region) VALUES
      (1, 'octopus', 'E-1R-AGILE-24-10-01-G', 'electricity', 'import', 'agile', 'G'),
      (2, 'octopus', 'G-1R-VAR-22-11-01-G', 'gas', 'import', 'flat', 'G');
    INSERT INTO device (id, site_id, kind, provider, external_ref) VALUES (1, 1, 'meter_import', 'octopus', 'MPAN1'), (2, 1, 'meter_gas', 'octopus', 'MPRN1');
    INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (1, 1, 1, 1700000000, 1), (1, 2, 2, 1700000000, 1);
    INSERT INTO site_day (site_id, local_date, method_version, built_at) VALUES (1, '2026-10-20', 'v3', 1);`);
  return db;
}

const applyAll = (db) => { for (const d of DELTAS) applyDelta(db, d); };
const snapshot = (db) => {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
  const counts = Object.fromEntries(objects.filter((o) => o.type === 'table').map((o) => [o.name, db.prepare(`SELECT COUNT(*) n FROM "${o.name}"`).get().n]));
  return { objects, counts };
};
const cols = (db, t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);

test('the deltas apply cleanly on top of the current schema and backfill GB / GBP', () => {
  const db = existingDb();
  applyAll(db);
  for (const c of ['currency', 'country', 'market_code']) assert.ok(cols(db, 'site').includes(c), `site.${c}`);
  for (const c of ['currency', 'country', 'native_period_s']) assert.ok(cols(db, 'tariff').includes(c), `tariff.${c}`);
  assert.deepEqual({ ...db.prepare('SELECT country, currency, market_code FROM site WHERE id = 1').get() }, { country: 'GB', currency: 'GBP', market_code: 'GB' });
  assert.deepEqual(db.prepare('SELECT DISTINCT country, currency FROM tariff').all().map((r) => ({ ...r })), [{ country: 'GB', currency: 'GBP' }]);
  assert.ok(cols(db, 'site').includes('slot_s'), 'schema.sql slot_s left as it is');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vat_rate').get().n, VAT_RATES.length, 'vat_rate left in place');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(db.prepare('SELECT name FROM schema_delta ORDER BY name').all().map((r) => r.name), DELTA_FILES.map((f) => f.replace(/\.sql$/, '')));
  // 004: tariff kind from the Octopus structure, and the currency of days already built.
  assert.deepEqual(db.prepare('SELECT structure, kind FROM tariff ORDER BY id').all().map((r) => ({ ...r })), [{ structure: 'agile', kind: 'dynamic' }, { structure: 'flat', kind: 'flat' }]);
  assert.equal(db.prepare('SELECT currency FROM site_day WHERE site_id = 1').get().currency, 'GBP');
});

test('delta 004: a home is billed in its market\'s currency, and tariff kinds are the contract\'s', () => {
  const db = existingDb();
  applyAll(db);
  seedMarkets(db);
  assert.throws(() => db.exec("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Paris', 1, 'FR', 'FR', 'GBP')"), /differs from its market currency/);
  assert.doesNotThrow(() => db.exec("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Paris', 1, 'FR', 'FR', 'EUR')"));
  assert.throws(() => db.exec("UPDATE site SET market_code = 'NL' WHERE id = 1"), /differs from its market currency/);
  assert.throws(() => db.exec("UPDATE tariff SET kind = 'hphc' WHERE id = 1"), /CHECK/);
  db.exec("UPDATE tariff SET kind = 'calendar_tou' WHERE id = 1");
});

test('reference rows in the SQL match the JS registries', () => {
  const db = existingDb();
  applyAll(db);
  const sqlCurrencies = db.prepare('SELECT code, minor_exponent, symbol FROM currency ORDER BY code').all().map((r) => ({ ...r }));
  assert.deepEqual(sqlCurrencies, Object.values(CURRENCIES).map((c) => ({ code: c.code, minor_exponent: c.minorExponent, symbol: c.symbol })).sort((a, b) => a.code.localeCompare(b.code)));
  const gb = MARKETS.find((m) => m.code === 'GB');
  assert.deepEqual({ ...db.prepare('SELECT * FROM market WHERE code = ?').get('GB') }, Object.fromEntries(MARKET_COLUMNS.map((c) => [c, gb[c]])));
  // GB VAT copied from vat_rate is the tax.js seed, row for row, labelled sourced with the same note.
  const rules = db.prepare(`SELECT country, code, fuel, direction, customer_class, applies_to, kind, value, currency, charge_period, seq,
      valid_from, valid_to, source, unverified, origin, origin_note FROM tax_rule ORDER BY fuel, direction, valid_from`).all()
    .map((r) => ({ ...r, unverified: r.unverified === 1 }));
  const want = [...GB_VAT_RULES].map((r) => ({ ...r })).sort((a, b) => a.fuel.localeCompare(b.fuel) || a.direction.localeCompare(b.direction) || a.valid_from - b.valid_from);
  assert.deepEqual(rules, want);
});

test('applying again changes nothing, and the backfill runs on the first application only', () => {
  const db = existingDb();
  applyAll(db);
  db.exec("INSERT INTO site (id, name, created_at) VALUES (2, 'New home', 1800000000)");   // written after the delta, no country yet
  const before = snapshot(db);
  applyAll(db);
  applyAll(db);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual({ ...db.prepare('SELECT country, currency, market_code FROM site WHERE id = 2').get() }, { country: null, currency: null, market_code: null });
  // db.js runs schema.sql on every open: still fine after the deltas.
  db.exec(SCHEMA);
  assert.deepEqual(snapshot(db), before);
});

test('GB VAT is copied once vat_rate is seeded, even when the delta ran before the seed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  applyAll(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tax_rule').get().n, 0);
  const vat = db.prepare('INSERT INTO vat_rate (fuel, direction, rate, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)');
  for (const v of VAT_RATES) vat.run(v.fuel, v.direction, v.rate, v.validFrom, v.validTo ?? null);
  applyAll(db);
  applyAll(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country = 'GB' AND code = 'vat'").get().n, VAT_RATES.length);
});

test('a tariff in another currency cannot be agreed for a home (trigger)', () => {
  const db = existingDb();
  applyAll(db);
  db.exec(`INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure, currency, country) VALUES (3, 'tibber', 'NL-DYN', 'electricity', 'import', 'dynamic', 'EUR', 'NL');
    INSERT INTO device (id, site_id, kind, provider, external_ref) VALUES (3, 1, 'meter_export', 'octopus', 'MPAN2');`);
  const agree = db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (1, 3, ?, 1700000000, 2)');
  assert.throws(() => agree.run(3), /tariff currency differs from the home currency/);
  assert.throws(() => db.exec('UPDATE tariff_agreement SET tariff_id = 3 WHERE device_id = 1'), /currency differs/);
  assert.throws(() => db.exec("UPDATE site SET currency = 'EUR' WHERE id = 1"), /currency differs/);
  assert.throws(() => db.exec("UPDATE tariff SET currency = 'EUR' WHERE id = 1"), /currency differs/);
  db.exec("INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure, currency, country) VALUES (4, 'octopus', 'E-1R-OUTGOING', 'electricity', 'export', 'export', 'GBP', 'GB')");
  assert.doesNotThrow(() => agree.run(4));
  db.exec("INSERT INTO site (id, name, currency, created_at) VALUES (2, 'No agreements yet', 'GBP', 1800000000)");
  assert.throws(() => db.exec("UPDATE site SET currency = 'USD' WHERE id = 2"), /FOREIGN KEY/);
  assert.doesNotThrow(() => db.exec("UPDATE site SET currency = 'EUR' WHERE id = 2"));
});

test('CHECK constraints and triggers refuse bad rows', () => {
  const db = existingDb();
  applyAll(db);
  const tax = (over) => {
    const r = { country: 'NL', code: 'btw', fuel: 'electricity', direction: 'import', applies_to: 'all', kind: 'percent', value: 0.21, currency: null, charge_period: null, seq: 100, valid_from: 0, valid_to: null, source: 'test', recorded_at: 1, ...over };
    const k = Object.keys(r);
    db.prepare(`INSERT INTO tax_rule (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).run(...Object.values(r));
  };
  assert.throws(() => tax({ currency: 'EUR' }), /CHECK/);                                   // percent has no currency
  assert.throws(() => tax({ value: 21 }), /CHECK/);                                         // a percent is a fraction
  assert.throws(() => tax({ kind: 'per_period', currency: 'EUR', applies_to: 'fixed' }), /CHECK/);   // needs charge_period
  assert.throws(() => tax({ kind: 'per_kwh', currency: 'EUR', applies_to: 'all' }), /CHECK/);
  assert.throws(() => tax({ valid_from: 10, valid_to: 10 }), /CHECK/);
  assert.throws(() => tax({ country: 'nl' }), /CHECK/);
  tax({});
  assert.throws(() => tax({ applies_to: 'unit', valid_from: 100 }), /overlapping current tax rule/);
  assert.doesNotThrow(() => tax({ code: 'heffingskorting', kind: 'per_period', value: -63519, currency: 'EUR', applies_to: 'fixed', charge_period: 'year', seq: 20 }));
  assert.doesNotThrow(() => tax({ superseded_at: 2, value: 0.19 }));                       // history may overlap
  // The copied GB gas VAT is open-ended: a second current rate must close it first.
  assert.throws(() => tax({ country: 'GB', code: 'vat', fuel: 'gas', value: 0.2, valid_from: 4000000000 }), /overlapping current tax rule/);
});

test('market, region and site_region constraints', () => {
  const db = existingDb();
  applyAll(db);
  seedMarkets(db);
  seedRegionsGb(db);
  seedMarkets(db);
  seedRegionsGb(db);   // seeds are re-runnable
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market').get().n, MARKETS.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM region').get().n, GB_REGIONS.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM region_alias').get().n, GB_REGION_ALIASES.length);
  const market = db.prepare(`INSERT INTO market (code, country, timezone, currency, price_interval_s, meter_interval_s, default_slot_s) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  assert.throws(() => market.run('XX', 'XX', 'UTC', 'EUR', 900, 900, 1200), /CHECK/);
  assert.throws(() => market.run('XX', 'XX', 'UTC', 'EUR', 1000, 900, 900), /CHECK/);
  assert.throws(() => market.run('XX', 'XX', 'UTC', 'USD', 900, 900, 900), /FOREIGN KEY/);
  assert.throws(() => db.exec("UPDATE site SET market_code = 'XX' WHERE id = 1"), /FOREIGN KEY/);
  assert.throws(() => db.exec("UPDATE site SET country = 'GBR' WHERE id = 1"), /CHECK/);
  assert.throws(() => db.exec('UPDATE tariff SET native_period_s = 1000 WHERE id = 1'), /CHECK/);
  db.exec('UPDATE tariff SET native_period_s = 1800 WHERE id = 1');

  // Carbon regions are their own scheme; aliasing them to DNO regions is refused both ways.
  db.exec("INSERT INTO region (scheme, code, country, name) VALUES ('gb_carbon', '3', 'GB', 'North West England')");
  assert.throws(() => db.exec("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '16', 'gb_carbon', '3')"), /partitions are never aliased/);
  assert.throws(() => db.exec("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_carbon', '3', 'gb_dno', '16')"), /partitions are never aliased/);
  assert.throws(() => db.exec("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '16', 'neso_new', '3'); INSERT INTO region (scheme, code) VALUES ('neso_new', '3')"), /already used as an alias scheme/);
  assert.throws(() => db.exec("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '12', 'octopus_gsp', 'G')"), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => db.exec("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '99', 'octopus_gsp', 'Z')"), /FOREIGN KEY/);

  // site_region: versioned, one current row per scheme, and only real regions.
  const put = db.prepare('INSERT INTO site_region (site_id, scheme, code, source, recorded_at, superseded_at) VALUES (1, ?, ?, ?, ?, ?)');
  put.run('gb_dno', '16', 'octopus_agreement', 1000, null);
  put.run('gb_carbon', '3', 'postcode_lookup', 1000, null);
  assert.throws(() => put.run('gb_dno', '12', 'installer', 2000, null), /UNIQUE/);
  assert.throws(() => put.run('gb_dno', '3', 'installer', 2000, 2500), /FOREIGN KEY/);      // a carbon code is not a DNO code
  assert.throws(() => put.run('gb_dno', '12', 'installer', 2000, 1500), /CHECK/);
  db.exec("UPDATE site_region SET superseded_at = 2000 WHERE site_id = 1 AND scheme = 'gb_dno' AND superseded_at IS NULL");
  put.run('gb_dno', '12', 'installer', 2000, null);
  assert.equal(db.prepare("SELECT code FROM site_region WHERE site_id = 1 AND scheme = 'gb_dno' AND superseded_at IS NULL").get().code, '12');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('region aliases round-trip in SQL for all 14 GB regions in three numberings', () => {
  const db = existingDb();
  applyAll(db);
  seedRegionsGb(db);
  const resolve = db.prepare(`SELECT r.scheme, r.code, r.name FROM region_alias a JOIN region r ON r.scheme = a.scheme AND r.code = a.code
    WHERE a.alias_scheme = ? AND a.alias_code = ?`);
  const back = db.prepare('SELECT alias_scheme, alias_code FROM region_alias WHERE scheme = ? AND code = ? ORDER BY alias_scheme');
  for (const r of GB_REGIONS) {
    const aliases = back.all(r.scheme, r.code).map((a) => ({ ...a }));
    assert.deepEqual(aliases.map((a) => a.alias_scheme), ['octopus_gsp', 'tariffscan_id', 'tariffscan_name'], r.code);
    for (const a of aliases) assert.deepEqual({ ...resolve.get(a.alias_scheme, a.alias_code) }, { scheme: r.scheme, code: r.code, name: r.name });
  }
  // The home's Octopus letter, from the site table, finds its distribution region (BB12 -> G -> 16).
  const row = db.prepare(`SELECT r.code, r.name FROM site s JOIN region_alias a ON a.alias_scheme = 'octopus_gsp' AND a.alias_code = s.gsp_region
    JOIN region r ON r.scheme = a.scheme AND r.code = a.code WHERE s.id = 1`).get();
  assert.deepEqual({ ...row }, { code: '16', name: 'North West England' });
});

test('delta 005: every reference and price row carries an origin in the vocabulary', () => {
  const db = existingDb();
  db.exec(`INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at) VALUES (1, 'unit', 'single', 1700000000, 1700001800, 21.3, 1)`);
  applyAll(db);
  for (const t of ['tax_rule', 'tariff', 'rate_interval', 'market', 'region']) {
    assert.ok(cols(db, t).includes('origin') && cols(db, t).includes('origin_note'), `${t}.origin`);
  }
  // Backfill: tariffs and rates already held were fetched from Octopus; GB VAT and the GB market are sourced.
  assert.deepEqual(db.prepare('SELECT DISTINCT origin FROM tariff').all().map((r) => r.origin), ['provider']);
  assert.equal(db.prepare('SELECT origin FROM rate_interval').get().origin, 'provider');
  assert.deepEqual(db.prepare("SELECT DISTINCT origin FROM tax_rule WHERE country = 'GB'").all().map((r) => r.origin), ['sourced']);
  assert.equal(db.prepare("SELECT origin FROM market WHERE code = 'GB'").get().origin, 'sourced');
  // The seeds label FR/NL/DE/BE/ES as placeholders and the 14 GB regions as sourced.
  seedMarkets(db);
  seedRegionsGb(db);
  assert.deepEqual(db.prepare("SELECT code FROM market WHERE origin = 'placeholder' ORDER BY code").all().map((r) => r.code), ['BE', 'DE', 'ES', 'FR', 'NL']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM region WHERE scheme = 'gb_dno' AND origin = 'sourced'").get().n, 14);
  // CHECK: an origin outside the vocabulary is refused on every table.
  assert.throws(() => db.exec("UPDATE tariff SET origin = 'guess' WHERE id = 1"), /CHECK/);
  assert.throws(() => db.exec("UPDATE tax_rule SET origin = 'official' WHERE country = 'GB'"), /CHECK/);
  assert.throws(() => db.exec("UPDATE rate_interval SET origin = 'Synthetic'"), /CHECK/);
  assert.throws(() => db.exec("UPDATE market SET origin = 'real' WHERE code = 'GB'"), /CHECK/);
  assert.throws(() => db.exec("UPDATE region SET origin = 'x' WHERE scheme = 'gb_dno'"), /CHECK/);
  // A tariff written after the delta is NOT backfilled (first application only): its writer labels it.
  db.exec("INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure) VALUES (9, 'octopus', 'E-1R-LATER-G', 'electricity', 'import', 'flat')");
  applyAll(db);
  assert.equal(db.prepare('SELECT origin FROM tariff WHERE id = 9').get().origin, null);
});

test('delta 006: register windows, calendars and estimated rate rows', () => {
  const db = existingDb();
  applyAll(db);
  db.exec("INSERT INTO calendar (code, day_start_min, origin) VALUES ('fr_tempo', 360, 'synthetic')");
  const win = db.prepare(`INSERT INTO register_window (tariff_id, device_id, register, start_min, end_min, weekdays, calendar, day_type, clock, recorded_at, origin)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synthetic')`);
  win.run(null, 'hc', 1320, 360, 127, null, null, 'local');
  win.run(1, 'hc', 120, 420, 127, null, null, 'local');                   // the meter's own window
  win.run(null, 'red_hp', 360, 1320, 127, 'fr_tempo', 'red', 'local');
  assert.throws(() => win.run(null, 'hc', 1440, 360, 127, null, null, 'local'), /CHECK/);   // start 0-1439
  assert.throws(() => win.run(null, 'hc', 0, 0, 127, null, null, 'local'), /CHECK/);        // end 1-1440
  assert.throws(() => win.run(null, 'hc', 0, 60, 0, null, null, 'local'), /CHECK/);         // no weekday
  assert.throws(() => win.run(null, 'hc', 0, 60, 127, null, 'red', 'local'), /CHECK/);      // a day type needs a calendar
  assert.throws(() => win.run(null, 'hc', 0, 60, 127, null, null, 'solar'), /CHECK/);       // clock local | utc
  assert.throws(() => win.run(null, 'hc', 0, 60, 127, 'nope', 'red', 'local'), /FOREIGN KEY/);
  const day = db.prepare("INSERT INTO calendar_day (calendar, local_date, day_type, origin, recorded_at, superseded_at) VALUES ('fr_tempo', ?, ?, 'synthetic', ?, ?)");
  day.run('2026-03-29', 'blue', 1, null);
  assert.throws(() => day.run('2026-03-29', 'red', 2, null), /UNIQUE/);   // one current type per day
  day.run('2026-03-29', 'red', 3, 2);
  assert.throws(() => day.run('29/03/2026', 'red', 4, null), /CHECK/);
  assert.ok(cols(db, 'tariff').includes('default_register'));
  assert.equal(db.prepare('SELECT estimated FROM rate_interval LIMIT 1').get()?.estimated ?? 0, 0);
  db.exec("INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at, estimated) VALUES (1, 'unit', 'red_hp', 10, 20, 64.7, 1, 1)");
  assert.throws(() => db.exec("INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at, estimated) VALUES (1, 'unit', 'x', 10, 20, 1, 1, 2)"), /CHECK/);
});

test('delta 007: a contracted capacity is positive and labelled', () => {
  const db = existingDb();
  applyAll(db);
  db.exec("UPDATE site SET contracted_kva = 6, contracted_kva_origin = 'user', contracted_kva_note = 'bill: puissance souscrite 6 kVA' WHERE id = 1");
  assert.throws(() => db.exec('UPDATE site SET contracted_kva = 0 WHERE id = 1'), /CHECK/);
  assert.throws(() => db.exec("UPDATE site SET contracted_kva_origin = 'bill' WHERE id = 1"), /CHECK/);
});

test('delta 008: the market provider registry takes its seed and refuses what it should', async () => {
  const { PROVIDERS, seedProviders } = await import('../src/db/seed/providers.js');
  const db = existingDb();
  applyAll(db);
  seedProviders(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider').get().n, PROVIDERS.length);
  const before = snapshot(db);
  seedProviders(db);
  applyAll(db);
  assert.deepEqual(snapshot(db), before, 'seed and delta again change nothing');
  const ins = (vals) => db.exec(`INSERT INTO market_provider (market_code, role, adapter, scope, origin, enabled) VALUES (${vals})`);
  assert.throws(() => ins("'GB', 'weather', 'x1', 'everyone', 'provider', 1"), /CHECK/);
  assert.throws(() => ins("'GB', 'weather', 'x2', 'shared', 'guess', 1"), /CHECK/);
  assert.throws(() => ins("'gb', 'weather', 'x3', 'shared', 'provider', 1"), /CHECK/);
  assert.throws(() => ins("'GB', 'weather', 'x4', 'shared', 'provider', 2"), /CHECK/);
  assert.throws(() => ins("'GB', 'weather', 'open_meteo', 'shared', 'provider', 1"), /UNIQUE|PRIMARY/);
  ins("'*', 'inverter', 'x5', 'home', 'placeholder', 0");
});

test('delta 009: one provider_state row per provider, its state JSON only', () => {
  const db = existingDb();
  applyAll(db);
  const before = snapshot(db);
  applyAll(db);
  assert.deepEqual(snapshot(db), before, 'applying again changes nothing');
  db.exec("INSERT INTO provider_state (provider, next_allowed_at, state, updated_at) VALUES ('tariffscanner', 1, '{\"last_run_at\":1}', 1)");
  assert.throws(() => db.exec("INSERT INTO provider_state (provider, updated_at) VALUES ('tariffscanner', 2)"), /UNIQUE|PRIMARY/);
  assert.throws(() => db.exec("INSERT INTO provider_state (provider, state, updated_at) VALUES ('other', 'not json', 2)"), /CHECK/);
});

test('delta 010: a market_provider made with an older owner CHECK is rebuilt, its other owner becoming external', async () => {
  const { PROVIDERS, seedProviders } = await import('../src/db/seed/providers.js');
  const db = existingDb();
  // A database from before 010: deltas up to 007, then 008's table with another second owner value.
  for (const d of DELTAS.slice(0, DELTA_FILES.indexOf('008-market-provider.sql'))) applyDelta(db, d);
  const d008 = DELTAS[DELTA_FILES.indexOf('008-market-provider.sql')];
  assert.match(d008, /CHECK \(owner IN \('core', 'external'\)\)/);
  applyDelta(db, d008.replace("CHECK (owner IN ('core', 'external'))", "CHECK (owner IN ('core', 'old_owner'))"));
  seedProviders(db);
  db.exec("UPDATE market_provider SET enabled = 0, note = 'set by an operator' WHERE market_code = 'GB' AND role = 'carbon'");
  db.exec("INSERT INTO market_provider (market_code, role, adapter, priority, owner, scope, origin, note) VALUES ('GB', 'tariff_catalogue', 'remote', 5, 'old_owner', 'shared', 'provider', 'synced elsewhere')");
  assert.throws(() => db.exec("UPDATE market_provider SET owner = 'external' WHERE adapter = 'remote'"), /CHECK/);
  const rows = (x) => x.prepare('SELECT * FROM market_provider ORDER BY market_code, role, adapter').all().map((r) => ({ ...r }));
  const before = rows(db);
  applyAll(db);
  // Every row kept as it was, the other owner now 'external'.
  assert.deepEqual(rows(db), before.map((r) => ({ ...r, owner: r.owner === 'core' ? 'core' : 'external' })));
  assert.equal(db.prepare("SELECT owner FROM market_provider WHERE adapter = 'remote'").get().owner, 'external');
  assert.deepEqual({ ...db.prepare("SELECT enabled, note FROM market_provider WHERE market_code = 'GB' AND role = 'carbon'").get() }, { enabled: 0, note: 'set by an operator' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider').get().n, PROVIDERS.length + 1);
  // The same table as a fresh 008 + 010 gives: CHECKs, primary key, WITHOUT ROWID, the index.
  const fresh = existingDb();
  applyAll(fresh);
  const def = (x) => x.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'market_provider' ORDER BY type, name").all().map((r) => ({ ...r }));
  assert.deepEqual(def(db), def(fresh));
  assert.deepEqual(def(db).map((o) => [o.type, o.name]), [['index', 'market_provider_role'], ['table', 'market_provider']]);
  assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('market_provider') WHERE pk > 0 ORDER BY pk").all().map((c) => c.name), ['market_code', 'role', 'adapter']);
  assert.match(def(db).find((o) => o.type === 'table').sql, /CHECK \(owner IN \('core', 'external'\)\)[\s\S]*PRIMARY KEY \(market_code, role, adapter\)\s*\) WITHOUT ROWID$/);
  assert.throws(() => db.exec("UPDATE market_provider SET owner = 'old_owner' WHERE adapter = 'remote'"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO market_provider (market_code, role, adapter, scope, origin) VALUES ('GB', 'carbon', 'neso', 'shared', 'provider')"), /UNIQUE|PRIMARY/);
  assert.throws(() => db.exec("INSERT INTO market_provider (market_code, role, adapter, scope, origin) VALUES ('GB', 'weather', 'x', 'everyone', 'provider')"), /CHECK/);
  db.exec("INSERT INTO market_provider (market_code, role, adapter, scope, origin) VALUES ('GB', 'weather', 'x', 'shared', 'provider')");
  assert.deepEqual({ ...db.prepare("SELECT priority, enabled, owner, needs_credentials, licence_confirmed FROM market_provider WHERE adapter = 'x'").get() },
    { priority: 100, enabled: 1, owner: 'core', needs_credentials: 0, licence_confirmed: 1 }, 'defaults kept');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'market_provider%'").get(), undefined, 'no temporary copy left');
  // Applying again changes nothing, and the seed still upserts into the rebuilt table.
  db.exec("DELETE FROM market_provider WHERE adapter = 'x'");
  seedProviders(db);   // refreshes the descriptive columns (the note), keeps enabled
  assert.equal(db.prepare("SELECT enabled FROM market_provider WHERE market_code = 'GB' AND role = 'carbon'").get().enabled, 0);
  const snap = snapshot(db);
  const keep = rows(db);
  applyAll(db);
  seedProviders(db);
  assert.deepEqual(snapshot(db), snap);
  assert.deepEqual(rows(db), keep);
  assert.ok(db.prepare("SELECT 1 FROM schema_delta WHERE name = '010-provider-owner'").get());
});
