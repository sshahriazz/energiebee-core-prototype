// Erasure (fix list R14): facts and raw receipts are append-only, and the one way a home's data leaves is a logged erasure.
// A home's raw files are sealed with the home's own key; deleting the home destroys the key, so a copy of a file kept
// anywhere (a backup) cannot be read again. Public data (price lists) is stored as sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useDb } from './helpers.js';

await useDb();
const { db, dataDir } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { landRaw, readRaw, isSealed, seriesId, putReadings } = await import('../src/core/facts.js');
const { createUser, giveHome } = await import('../src/core/users.js');
const { deleteHome } = await import('../src/core/delete-home.js');
const { erase } = await import('../src/core/erasure.js');

const home = await createSite({ name: 'to be erased' });
const owner = await createUser({ name: 'owner' });
await giveHome(owner.id, home.id);
const body = { data: { infos: [{ label: 'PV', records: [{ time: '10:00', value: '1200' }] }] }, serial: 'SN-PRIVATE-123' };
const personal = await landRaw({ source: 'sunsynk_5min', siteId: home.id, request: { url: 'https://api.example/day' }, body });
const prices = await landRaw({ source: 'octopus_rates', siteId: home.id, request: { url: 'https://api.example/rates' }, body: { results: [{ value_exc_vat: 20 }] } });
const rowOf = async (id) => await db.prepare('SELECT id, site_id, file FROM raw_payload WHERE id = ?').get(id);

await test('a home\'s raw file is sealed on disk and reads back through readRaw; public data is stored as sent', async () => {
  const p = await rowOf(personal.rawId);
  const onDisk = fs.readFileSync(path.join(dataDir, p.file));
  assert.ok(isSealed(onDisk));
  assert.ok(!onDisk.toString('latin1').includes('SN-PRIVATE-123'), 'nothing of the body is readable on disk');
  assert.deepEqual(JSON.parse(await readRaw(p)), body);
  const pub = await rowOf(prices.rawId);
  assert.ok(!isSealed(fs.readFileSync(path.join(dataDir, pub.file))));
  assert.equal(JSON.parse(await readRaw(pub)).results[0].value_exc_vat, 20);
  assert.ok(await db.prepare('SELECT 1 FROM home_key WHERE site_id = ?').get(home.id), 'the home has its own key');
});

await test('an erasure needs a known kind and a reason', async () => {
  await assert.rejects(async () => await erase({ kind: 'whim', reason: 'x' }, async () => {}), /erasure kind whim/);
  await assert.rejects(async () => await erase({ kind: 'retention', reason: ' ' }, async () => {}), /needs a reason/);
});

await test('deleting the home is one logged erasure: its rows go, its key goes, and a kept copy of its raw file cannot be read', async () => {
  await putReadings(await seriesId('site', home.id, 'solar_w', 'sunsynk_5min'), [{ ts: 1_800_000_000, value: 5 }], personal.rawId);
  const p = await rowOf(personal.rawId);
  const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-backup-')), 'copy.json');
  fs.copyFileSync(path.join(dataDir, p.file), backup);            // a file backup taken before the erasure
  const out = await deleteHome(owner, await db.prepare('SELECT * FROM site WHERE id = ?').get(home.id), { confirm: 'to be erased' });
  assert.equal(out.rows.site, 1);
  const log = await db.prepare("SELECT kind, site_id, site_uid, reason, removed, finished_at FROM erasure_log WHERE kind = 'home'").get();
  assert.deepEqual([log.kind, log.site_id, log.site_uid, log.finished_at > 0], ['home', home.id, home.uid ?? log.site_uid, true]);
  const removed = JSON.parse(log.removed);
  assert.ok(removed.reading >= 1 && removed.home_key === 1 && removed.raw_payload >= 1, log.removed);
  assert.equal(await db.prepare('SELECT 1 FROM home_key WHERE site_id = ?').get(home.id) ?? null, null);
  assert.equal(await readRaw({ file: path.relative(dataDir, backup), site_id: home.id }), null, 'without the key the backup copy is unreadable');
  assert.ok(isSealed(fs.readFileSync(backup)) && !fs.readFileSync(backup, 'latin1').includes('SN-PRIVATE-123'));
});
