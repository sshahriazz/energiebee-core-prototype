// Delta 023 on a database where 020-022 already ran with the FIRST seed of the planner registries
// (no refs column; some defaults, names and action lists from memory), as on a server that opened
// the database in between: the open adds refs, replaces the unused first-seed rows with the current
// seed, keeps a row that already has values, and a second open writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { useDb } from './helpers.js';

const dbDir = path.resolve(import.meta.dirname, '..', 'src', 'db');
const BEFORE_023 = ['002-money-tax.sql', '003-market-region.sql', '004-tariff-ledger.sql', '005-provenance.sql', '006-register-window.sql', '007-capacity.sql',
  '008-market-provider.sql', '009-provider-state.sql', '010-provider-owner.sql', '011-tounify.sql', '012-integrity.sql', '013-indexes.sql',
  '020-attribute-registry.sql', '021-site-setting.sql', '022-site-version.sql'];

// The applying rules stated at the top of each delta (as db.js applies them).
function statements(sql) {
  const out = []; let buf = [];
  for (const line of sql.split('\n')) {
    const code = line.replace(/--.*$/, '').trim();
    if (!buf.length && !code) continue;
    buf.push(line);
    const text = buf.join('\n').replace(/--.*$/gm, '').trim();
    if (/^CREATE\s+TRIGGER/i.test(text) ? /^END;$/i.test(code) : code.endsWith(';')) { out.push(buf.join('\n')); buf = []; }
  }
  return out;
}

const file = useDb();
const raw = new DatabaseSync(file);
raw.exec('PRAGMA foreign_keys = ON');
raw.exec(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
for (const f of BEFORE_023) {
  for (const s of statements(fs.readFileSync(path.join(dbDir, 'deltas', f), 'utf8'))) {
    const add = /^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/im.exec(s.replace(/--.*$/gm, ''));
    if (add && raw.prepare(`SELECT 1 FROM pragma_table_info('${add[1]}') WHERE name = ?`).get(add[2])) continue;
    raw.exec(s);
  }
}
// The first seed (abridged): stale text, a key the current seed dropped, a stale default, an old action list.
raw.exec(`INSERT INTO attribute_def (key, label, unit, value_type, min_value, max_value, applies_to, unverified, description) VALUES
    ('heat_loss_w_per_k', 'Heat loss', 'W/K', 'number', 10, 2000, '["site"]', 1, 'old text'),
    ('min_output_kw', 'Minimum output', 'kW', 'number', 0, 50, '["site"]', 1, 'old key, dropped later'),
    ('heating_zone_count', 'Zones', null, 'integer', 1, 20, '["site"]', 1, 'old key with a value');
  INSERT INTO setting_def (key, label, value_type, default_value, min_value, max_value, step, allowed_values, planner, applies_to, unverified, description) VALUES
    ('plan_interval_min', 'Planning step', 'integer', '5', 5, 60, 5, null, 'predbat', 'planner', 1, 'old default'),
    ('heating_mode', 'Heating planner mode', 'enum', '"monitor"', null, null, null, '["off","monitor","control"]', 'predheat', 'heating', 1, 'old key');
  INSERT INTO device_kind (kind, label, class, attribute_keys, action_codes) VALUES ('battery', 'Battery', 'controllable', '[]', '["set_charge_window"]');
  INSERT INTO site (id, name, created_at) VALUES (1, 'Home', 1760000000);
  INSERT INTO attribute_value (site_id, key, source, value, origin, recorded_at) VALUES (1, 'heating_zone_count', 'installer', '2', 'user', 1760000000000);`);
raw.close();

const { db } = await import('../src/db/db.js');
const { attributeDef } = await import('../src/core/attributes.js');
const { settingDef } = await import('../src/core/settings.js');
const { deviceKind } = await import('../src/core/devices.js');

test('023 adds refs and replaces the unused first-seed rows with the current seed', () => {
  for (const t of ['attribute_def', 'setting_def']) assert.ok(db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'refs'`).get(), `${t}.refs`);
  const hl = attributeDef('heat_loss_w_per_k');
  assert.deepEqual([hl.unverified, hl.refs], [0, ['PH-MOD-01']]);
  assert.equal(attributeDef('min_output_kw'), null, 'a dropped first-seed key is gone');
  assert.equal(attributeDef('heating_zone_count').description, 'old key with a value', 'a key with values is kept as it was');
  assert.equal(settingDef('plan_interval_min').default, 30);
  assert.equal(settingDef('heating_mode'), null);
  assert.ok(deviceKind('battery').action_codes.includes('charge'));
  assert.ok(deviceKind('heat_pump'), 'every current kind is seeded');
  assert.ok(db.prepare("SELECT 1 FROM schema_delta WHERE name = '023-registry-refs'").get());
});

test('a later row without refs (an operator\'s) is never removed: the deletes ran once', async () => {
  db.prepare(`INSERT INTO setting_def (key, label, value_type, default_value, planner, applies_to) VALUES ('my_knob', 'Mine', 'number', '1', 'predbat', 'planner')`).run();
  const { applyDelta } = await import('../src/db/db.js');
  applyDelta(fs.readFileSync(path.join(dbDir, 'deltas', '023-registry-refs.sql'), 'utf8'));
  assert.ok(settingDef('my_knob'));
  assert.ok(deviceKind('battery'));
});
