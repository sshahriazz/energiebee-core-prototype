// A database from before tariff agreements were versioned is upgraded in place on open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useDb } from './helpers.js';

const file = useDb();
const old = new DatabaseSync(file);
old.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE tariff (id INTEGER PRIMARY KEY, tariff_code TEXT);
  CREATE TABLE device (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, external_ref TEXT NOT NULL, label TEXT, attrs TEXT, UNIQUE (site_id, provider, external_ref));
  CREATE TABLE tariff_agreement (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, device_id INTEGER NOT NULL, tariff_id INTEGER NOT NULL,
    valid_from INTEGER NOT NULL, valid_to INTEGER, CHECK (valid_to IS NULL OR valid_to > valid_from), UNIQUE (device_id, valid_from));
  INSERT INTO device VALUES (1, 1, 'meter_import', 'octopus', 'M1', 'Import', '{}');
  INSERT INTO tariff_agreement VALUES (1, 1, 1, 7, 1000, NULL);`);
old.close();
const { db } = await import('../src/db/db.js');

test('old agreements survive the upgrade and gain version columns', () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('tariff_agreement')").all().map((c) => c.name);
  assert.ok(cols.includes('recorded_at') && cols.includes('superseded_at'));
  assert.deepEqual({ ...db.prepare('SELECT id, device_id, tariff_id, valid_from FROM tariff_agreement').get() }, { id: 1, device_id: 1, tariff_id: 7, valid_from: 1000 });
  assert.ok(db.prepare("SELECT name FROM pragma_table_info('device')").all().some((c) => c.name === 'retired_at'));
});

test('a superseded agreement may share its start with the current one; two current ones may not overlap', () => {
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE tariff_agreement SET superseded_at = 5 WHERE id = 1').run();
  db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (1, 1, 8, 1000, 6)').run();
  assert.throws(() => db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (1, 1, 9, 2000, 7)').run(), /overlapping/);
});
