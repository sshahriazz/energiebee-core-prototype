// Versioned tariff agreements and device details, and the reconstructed revision log.
// On a private copy of data/core.db; stand-in changes go into the copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) await useDb({ snapshot: true });
const m = {
  ...(await import('../src/db/db.js')), ...(await import('../src/core/build.js')), ...(await import('../src/core/devices.js')),
  ...(await import('../src/core/history.js')), ...(await import('../src/core/maintenance.js')), ...(await import('../src/core/time.js')),
};
const SITE = 1;
const site = async () => await m.db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
const firstDay = async () => (await m.db.prepare('SELECT MIN(local_date) d FROM site_day WHERE site_id = ?').get(SITE)).d;
const today = async () => m.localDate((await site()).timezone, m.nowSec());
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
if (hasLive) await m.runMaintenance();

await test('every device and agreement has a recorded time, and every device a details version', { skip }, async () => {
  assert.equal((await m.db.prepare('SELECT COUNT(*) n FROM device WHERE site_id = ? AND recorded_at IS NULL').get(SITE)).n, 0);
  assert.equal((await m.db.prepare('SELECT COUNT(*) n FROM tariff_agreement WHERE site_id = ? AND recorded_at IS NULL').get(SITE)).n, 0);
  assert.equal((await m.db.prepare('SELECT COUNT(*) n FROM device d WHERE site_id = ? AND NOT EXISTS (SELECT 1 FROM device_attr_version v WHERE v.device_id = d.id)').get(SITE)).n, 0);
});

await test('device details keep every version, and are read as they were', { skip }, async () => {
  const gas = await m.db.prepare("SELECT * FROM device WHERE site_id = ? AND kind = 'meter_gas'").get(SITE);
  if (!gas) return;
  const before = JSON.parse(gas.attrs);
  await sleepMs(5); const t1 = Date.now(); await sleepMs(5);
  await m.setDeviceAttrs(gas.id, { ...before, ldz: 'XX' });
  assert.equal((await m.deviceAttrsAt(gas.id, t1)).attrs.ldz, before.ldz, 'as known before the change');
  assert.equal((await m.deviceAttrsAt(gas.id)).attrs.ldz, 'XX', 'now');
  assert.equal(await m.setDeviceAttrs(gas.id, { ...before, ldz: 'XX' }), false, 'unchanged details write nothing');
  await m.setDeviceAttrs(gas.id, before);
});

await test('a changed tariff history supersedes the old agreements; a rebuild as known before still uses them', { skip }, async (t) => {
  const imp = await m.db.prepare("SELECT * FROM device WHERE site_id = ? AND kind = 'meter_import' AND provider != 'env' AND retired_at IS NULL").get(SITE);
  const cur = imp && await m.db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from DESC').get(imp.id);
  if (!cur) return t.skip('no current import agreement');
  const other = await m.db.prepare('SELECT id, tariff_code FROM tariff WHERE id != ? AND direction = ? LIMIT 1').get(cur.tariff_id, 'import');
  if (!other) return t.skip('no other import tariff to switch to');
  await m.buildSite(SITE, await firstDay(), await today(), { reason: 'test' });
  await sleepMs(5); const before = m.nowSec(); await sleepMs(1100);
  const all = await m.db.prepare('SELECT tariff_id AS "tariffId", valid_from AS "from", valid_to AS "to" FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').all(imp.id);
  await m.supersedeAgreements(SITE, imp.id, all.map((a) => (a.from === cur.valid_from ? { ...a, tariffId: other.id } : a)));
  assert.ok((await m.db.prepare('SELECT COUNT(*) n FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NOT NULL').get(imp.id)).n >= all.length, 'old rows kept');
  const day = await today();
  const then = (await m.buildSite(SITE, await firstDay(), day, { asOf: before, dryRun: true })).hhRows.filter((r) => r.local_date === day && r.slot_start >= cur.valid_from);
  const nowRows = (await m.buildSite(SITE, await firstDay(), day, { asOf: m.nowSec() + 1, dryRun: true })).hhRows.filter((r) => r.local_date === day && r.slot_start >= cur.valid_from);
  if (!then.length) return t.skip('agreement starts after today');
  const tariffOf = (rows) => new Set(rows.map((r) => JSON.parse(r.lineage).tariff).filter(Boolean));
  assert.ok(![...tariffOf(then)].includes(other.tariff_code), 'as known before: the old tariff');
  assert.ok([...tariffOf(nowRows)].every((c) => c === other.tariff_code), 'now: the new tariff');
});

await test('a retired device keeps its row and agreements, but is no longer used', { skip }, async () => {
  const r = await m.db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'meter_import', 'env', 'test-retire', 'test', '{}', ?)").run(SITE, Date.now() - 10000);
  const id = Number(r.lastInsertRowid);
  await m.retireDevice(id);
  const d = await m.db.prepare('SELECT retired_at FROM device WHERE id = ?').get(id);
  assert.ok(d.retired_at != null);
  assert.ok(!(await m.devicesAt(SITE, "provider = 'env'")).some((x) => x.id === id), 'not in use now');
  assert.ok((await m.devicesAt(SITE, "provider = 'env'", d.retired_at - 1)).some((x) => x.id === id), 'in use just before');
});

await test('the revision log is reconstructed for the time before it was kept, once', { skip }, async (t) => {
  await m.buildSite(SITE, await firstDay(), await today(), { reason: 'test: start the live log' });
  const r = await m.reconstructHistory(SITE, { force: true });
  if (r.skipped) return t.skip(r.skipped);
  // Reconstruction needs sync runs from before the live log; the frozen fixture has too few of them.
  if (!r.versions) return t.skip('the fixture has no earlier sync runs to rebuild from');
  assert.match((await m.reconstructHistory(SITE)).skipped, /already stored/);
  // Reconstructed versions all precede each day's first live record, and each has its moment's inputs.
  const bad = (await m.db.prepare(`SELECT COUNT(*) n FROM site_day_revision x WHERE x.site_id = ? AND x.kind = 'reconstructed'
    AND x.revised_at >= (SELECT MIN(revised_at) FROM site_day_revision y WHERE y.site_id = x.site_id AND y.local_date = x.local_date AND y.kind = 'recorded')`).get(SITE)).n;
  assert.equal(bad, 0);
  const rec = await m.db.prepare("SELECT inputs, changed FROM site_day_revision WHERE site_id = ? AND kind = 'reconstructed' AND changed IS NOT NULL LIMIT 1").get(SITE);
  if (rec) { assert.ok(Array.isArray(JSON.parse(rec.inputs).approximations)); assert.ok(JSON.parse(rec.changed).length > 0, 'only versions that differ are stored'); }
});
