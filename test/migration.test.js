// A database from before tariff agreements were versioned is upgraded in place on open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useDb } from './helpers.js';

const file = useDb();
const old = new DatabaseSync(file);
// tariff.structure has been in every schema since the first one (delta 004 reads it for tariff.kind).
old.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE tariff (id INTEGER PRIMARY KEY, tariff_code TEXT, structure TEXT);
  CREATE TABLE device (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, external_ref TEXT NOT NULL, label TEXT, attrs TEXT, UNIQUE (site_id, provider, external_ref));
  CREATE TABLE tariff_agreement (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, device_id INTEGER NOT NULL, tariff_id INTEGER NOT NULL,
    valid_from INTEGER NOT NULL, valid_to INTEGER, CHECK (valid_to IS NULL OR valid_to > valid_from), UNIQUE (device_id, valid_from));
  INSERT INTO device VALUES (1, 1, 'meter_import', 'octopus', 'M1', 'Import', '{}');
  INSERT INTO tariff_agreement VALUES (1, 1, 1, 7, 1000, NULL);
  INSERT INTO site VALUES (1, 'Home', 0);
  CREATE TABLE site_hh (site_id INTEGER NOT NULL, slot_start INTEGER NOT NULL CHECK (slot_start % 1800 = 0), local_date TEXT NOT NULL,
    state TEXT NOT NULL, quality INTEGER NOT NULL, home REAL, method_version TEXT NOT NULL, built_at INTEGER NOT NULL, PRIMARY KEY (site_id, slot_start)) WITHOUT ROWID;
  CREATE INDEX site_hh_day ON site_hh (site_id, local_date);
  INSERT INTO site_hh VALUES (1, 1792479600, '2026-10-20', 'final', 128, 0.42, 'v3', 1);
  CREATE TABLE site_day (site_id INTEGER NOT NULL, local_date TEXT NOT NULL, slots INTEGER, method_version TEXT NOT NULL, built_at INTEGER NOT NULL, PRIMARY KEY (site_id, local_date)) WITHOUT ROWID;
  INSERT INTO site_day VALUES (1, '2026-10-20', 48, 'v3', 1);`);
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

test('half-hour serving rows from before per-home slot length are carried over as 1800 s slots', () => {
  assert.equal(db.prepare('SELECT slot_s FROM site WHERE id = 1').get().slot_s, 1800);
  const r = db.prepare('SELECT * FROM site_hh').get();
  // 1792479600 = 2026-10-20 07:00 UTC = 08:00 in London (BST).
  assert.deepEqual({ slot: r.slot_start, dur: r.dur_s, tod: r.tod_min, home: r.home, quality: r.quality }, { slot: 1792479600, dur: 1800, tod: 480, home: 0.42, quality: 128 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'site_hh_v1'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'site_hh_day' AND tbl_name = 'site_hh'").get(), 'index on the new table');
  assert.equal(db.prepare('SELECT slot_s FROM site_day').get().slot_s, 1800);
  // 15-minute starts are now allowed; off-grid starts are not.
  db.prepare("INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, method_version, built_at) VALUES (1, 1792479600 + 900, '2026-10-20', 900, 495, 'final', 0, 'v', 1)").run();
  assert.throws(() => db.prepare("INSERT INTO site_hh (site_id, slot_start, local_date, dur_s, tod_min, state, quality, method_version, built_at) VALUES (1, 1792479600 + 300, '2026-10-20', 900, 485, 'final', 0, 'v', 1)").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE site SET slot_s = 600 WHERE id = 1').run(), /CHECK/);
});
