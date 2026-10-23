// A database whose rate_interval still has the old CHECKs (unit/standing only; single/day/night
// only) is rebuilt once on open: every row kept with its id, the index and the overlap trigger
// back in place, and the new components, charge periods and registers allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useDb } from './helpers.js';

const file = useDb();
const old = new DatabaseSync(file);
old.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE tariff (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, product_code TEXT, tariff_code TEXT NOT NULL UNIQUE, fuel TEXT NOT NULL, direction TEXT NOT NULL,
    structure TEXT NOT NULL, region TEXT, name TEXT);
  CREATE TABLE rate_interval (
    id INTEGER PRIMARY KEY, tariff_id INTEGER NOT NULL REFERENCES tariff(id), site_id INTEGER REFERENCES site(id),
    component TEXT NOT NULL CHECK (component IN ('unit', 'standing')),
    register TEXT NOT NULL DEFAULT 'single' CHECK (register IN ('single', 'day', 'night')),
    payment_method TEXT NOT NULL DEFAULT 'ANY', valid_from INTEGER NOT NULL, valid_to INTEGER, price_ex_vat REAL NOT NULL,
    recorded_at INTEGER NOT NULL, superseded_at INTEGER, raw_id INTEGER, CHECK (valid_to IS NULL OR valid_to > valid_from));
  CREATE INDEX rate_current ON rate_interval (tariff_id, component, register, valid_from) WHERE superseded_at IS NULL;
  CREATE TRIGGER rate_no_overlap BEFORE INSERT ON rate_interval WHEN NEW.superseded_at IS NULL BEGIN
    SELECT RAISE(ABORT, 'overlapping current rate interval') WHERE EXISTS (SELECT 1 FROM rate_interval r WHERE r.superseded_at IS NULL
      AND r.tariff_id = NEW.tariff_id AND r.component = NEW.component AND r.register = NEW.register AND r.payment_method = NEW.payment_method
      AND IFNULL(r.site_id, 0) = IFNULL(NEW.site_id, 0) AND r.valid_from < IFNULL(NEW.valid_to, 9000000000) AND IFNULL(r.valid_to, 9000000000) > NEW.valid_from); END;
  INSERT INTO site VALUES (1, 'Home', 0);
  INSERT INTO tariff (id, provider, tariff_code, fuel, direction, structure, region) VALUES (1, 'octopus', 'E-1R-AGILE-24-10-01-G', 'electricity', 'import', 'agile', 'G');
  INSERT INTO rate_interval (id, tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at) VALUES
    (7, 1, 'unit', 'single', 1000, 2800, 20.5, 1), (8, 1, 'unit', 'single', 2800, 4600, -1.25, 1), (9, 1, 'standing', 'single', 0, NULL, 50.1, 1);
  INSERT INTO rate_interval (id, tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at, superseded_at) VALUES (10, 1, 'unit', 'single', 1000, 2800, 19, 0, 1);`);
old.close();
const { db } = await import('../src/db/db.js');

test('every rate row is kept, with its id, values and versions', () => {
  assert.deepEqual(db.prepare('SELECT id, component, register, charge_period, valid_from, valid_to, price_ex_vat, superseded_at FROM rate_interval ORDER BY id').all().map((r) => ({ ...r })), [
    { id: 7, component: 'unit', register: 'single', charge_period: null, valid_from: 1000, valid_to: 2800, price_ex_vat: 20.5, superseded_at: null },
    { id: 8, component: 'unit', register: 'single', charge_period: null, valid_from: 2800, valid_to: 4600, price_ex_vat: -1.25, superseded_at: null },
    { id: 9, component: 'standing', register: 'single', charge_period: null, valid_from: 0, valid_to: null, price_ex_vat: 50.1, superseded_at: null },
    { id: 10, component: 'unit', register: 'single', charge_period: null, valid_from: 1000, valid_to: 2800, price_ex_vat: 19, superseded_at: 1 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'rate_interval_v1'").get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // The tariff became GB / GBP, kind dynamic (deltas 002-004).
  assert.deepEqual({ ...db.prepare('SELECT currency, country, kind FROM tariff WHERE id = 1').get() }, { currency: 'GBP', country: 'GB', kind: 'dynamic' });
});

test('GB VAT in tax_rule follows registry VAT_RATES: a change supersedes the old rules, nothing is edited in place', async () => {
  const { syncGbVat } = await import('../src/db/db.js');
  const { VAT_RATES } = await import('../src/db/registry.js');
  const current = () => db.prepare("SELECT fuel, direction, value, valid_from, valid_to FROM tax_rule WHERE country = 'GB' AND code = 'vat' AND superseded_at IS NULL ORDER BY fuel, direction, valid_from").all().map((r) => ({ ...r }));
  const asRules = (rates) => rates.map((v) => ({ fuel: v.fuel, direction: v.direction, value: v.rate, valid_from: v.validFrom, valid_to: v.validTo ?? null }))
    .sort((a, b) => a.fuel.localeCompare(b.fuel) || a.direction.localeCompare(b.direction) || a.valid_from - b.valid_from);
  assert.deepEqual(current(), asRules(VAT_RATES));
  assert.equal(syncGbVat(), false, 'in step: nothing to do');
  // A later VAT change: gas to 0 % from 2027.
  const T = Date.UTC(2027, 0, 1) / 1000;
  const changed = [...VAT_RATES.filter((v) => v.fuel !== 'gas'), { fuel: 'gas', direction: 'import', rate: 0.05, validFrom: 0, validTo: T }, { fuel: 'gas', direction: 'import', rate: 0, validFrom: T, validTo: null }];
  assert.equal(syncGbVat(changed), true);
  assert.deepEqual(current(), asRules(changed));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country = 'GB' AND superseded_at IS NOT NULL").get().n, VAT_RATES.length, 'old rules kept, superseded');
});

test('the index and the overlap trigger are on the new table; new components, periods and registers are allowed', () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'rate_current' AND tbl_name = 'rate_interval'").get());
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'rate_no_overlap'").get().sql, /charge_period/);
  const ins = db.prepare('INSERT INTO rate_interval (tariff_id, component, register, charge_period, valid_from, valid_to, price_ex_vat, recorded_at) VALUES (1, ?, ?, ?, ?, ?, ?, 2)');
  assert.throws(() => ins.run('unit', 'single', null, 2000, 3000, 1), /overlapping current rate interval/);
  assert.doesNotThrow(() => ins.run('unit', 'hc', null, 2000, 3000, 14.1));
  assert.doesNotThrow(() => ins.run('fixed', 'single', 'month', 0, null, 1523));
  assert.doesNotThrow(() => ins.run('fixed', 'single', 'day', 0, null, 120));         // another period: no overlap
  assert.throws(() => ins.run('fixed', 'single', 'month', 100, 200, 1), /overlapping current rate interval/);
  assert.doesNotThrow(() => ins.run('capacity', 'single', 'month', 0, null, 3.2));
  assert.throws(() => ins.run('fixed', 'single', null, 0, null, 1), /CHECK/);
  assert.throws(() => ins.run('tax', 'single', null, 0, null, 1), /CHECK/);
  assert.throws(() => ins.run('unit', '', null, 5000, 6000, 1), /CHECK/);
});
