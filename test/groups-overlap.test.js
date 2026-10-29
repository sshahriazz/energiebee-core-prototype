// A home cannot be in one group twice at the same time (delta 071); a later period or another group is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');

const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('m', 0)").run().lastInsertRowid);
const owner = Number(db.prepare("INSERT INTO app_user (name, created_at) VALUES ('o', 0)").run().lastInsertRowid);
const group = (name) => Number(db.prepare("INSERT INTO site_group (name, owner_id, timezone, created_at) VALUES (?, ?, 'Europe/London', 0)").run(name, owner).lastInsertRowid);
const add = (g, from, to) => db.prepare('INSERT INTO site_group_member (group_id, site_id, valid_from, valid_to, recorded_at) VALUES (?, ?, ?, ?, 0)').run(g, site, from, to);

test('overlapping current membership is refused; a later period, another group, and a superseded row are allowed', () => {
  const g = group('a');
  add(g, 100, 200);
  assert.throws(() => add(g, 150, 250), /overlapping current membership/);
  assert.throws(() => add(g, null, null), /overlapping current membership/);
  assert.doesNotThrow(() => add(g, 200, 300), 'starts where the other ends');
  assert.doesNotThrow(() => add(group('b'), 100, 200), 'another group');
  db.prepare('UPDATE site_group_member SET superseded_at = 1 WHERE group_id = ? AND valid_from = 100').run(g);
  assert.doesNotThrow(() => add(g, 100, 200), 'a superseded row no longer counts');
  assert.throws(() => db.prepare('UPDATE site_group_member SET valid_to = 250 WHERE group_id = ? AND valid_from = 100 AND superseded_at IS NULL').run(g), /overlapping/, 'widening a row into another is refused too');
});
