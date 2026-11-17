// Deleting a home (src/core/delete-home.js, DELETE /api/sites/:id): on the frozen real GB home (every table a synced
// home fills: devices, readings, facts, days, slots, forecasts, plans, agreements ...) plus a second home that must stay
// exactly as it was. Checked: who may delete and the typed name; then no row anywhere still belongs to the deleted
// home, the raw files are gone, a raw answer another home still uses is kept, the foreign keys still hold.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

await useDb({ snapshot: true });
process.env.SECRET_KEY = 'delete-home-test-key-0123456789abcdef';
const skip = !hasLive && 'no fixture database';

const { db, dataDir } = await import('../src/db/db.js');
const { deleteHome, homeFootprint } = await import('../src/core/delete-home.js');
const { createSite } = await import('../src/core/sites.js');
const { addDevice } = await import('../src/core/tariffs.js');
const { seriesId, putIntervals, landRaw } = await import('../src/core/facts.js');
const { createUser, giveHome, startSession } = await import('../src/core/users.js');
const { putSecret } = await import('../src/core/secrets.js');
const { app } = await import('../src/server.js');

const q = (n) => `"${n}"`;
const tables = async () => (await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'").all()).map((r) => r.name);
const siteCols = async (t) => (await db.prepare('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(t)).map((r) => r.name).filter((c) => c === 'site_id');
// Every row of every table that names the home, as a count per table.
async function rowsOf(siteId) {
  const out = {};
  for (const t of await tables()) {
    for (const c of await siteCols(t)) {
      const n = (await db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${q(c)} = ?`).get(siteId)).n;
      if (n) out[t] = n;
    }
  }
  const dev = (await db.prepare('SELECT id FROM device WHERE site_id = ?').all(siteId)).map((r) => String(r.id));
  out.series = (await db.prepare(`SELECT COUNT(*) AS n FROM series WHERE (subject_kind = 'site' AND subject_id = ?) OR (subject_kind = 'device' AND subject_id IN (SELECT jsonb_array_elements_text(?::jsonb)))`)
      .get(String(siteId), JSON.stringify(dev))).n;
  out.interval_fact = (await db.prepare(`SELECT COUNT(*) AS n FROM interval_fact f JOIN series s ON s.id = f.series_id WHERE (s.subject_kind = 'site' AND s.subject_id = ?)
    OR (s.subject_kind = 'device' AND s.subject_id IN (SELECT jsonb_array_elements_text(?::jsonb)))`).get(String(siteId), JSON.stringify(dev))).n;
  return out;
}
// A fingerprint of everything a home owns, to show it did not change.
async function fingerprint(siteId) {
  const parts = [];
  for (const t of await tables()) for (const c of await siteCols(t)) parts.push([t, await db.prepare(`SELECT * FROM ${q(t)} WHERE ${q(c)} = ? ORDER BY 1, 2`).all(siteId)]);
  return JSON.stringify(parts);
}

let A; let B; let owner; let other; let sharedRaw; let ownRaw; let ownFile;
await test('setup: the real home A (owned), a second home B with its own data, a login, a raw answer of its own and one another home reads', { skip }, async () => {
  A = await db.prepare('SELECT * FROM site ORDER BY id LIMIT 1').get();
  owner = await createUser({ name: 'Owner', username: 'owner' });
  other = await createUser({ name: 'Other', username: 'other' });
  await giveHome(owner.id, A.id);
  B = await createSite({ name: 'Second home', postcode: 'BB12 9BY', carbonRegion: 3 });
  await giveHome(owner.id, B.id);
  const dev = await addDevice({ siteId: B.id, kind: 'meter_import', provider: 'test', externalRef: 'B-METER' });
  await putIntervals(await seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), [{ start: 1792969200, end: 1792971000, value: 0.4 }]);
  await putSecret(A.id, 'sunsynk', { username: 'u', password: 'p' });
  await db.prepare("INSERT INTO connection (site_id, provider, external_ref) VALUES (?, 'sunsynk', 'plant-1') ON CONFLICT DO NOTHING").run(A.id);
  // A raw answer only A uses, and a carbon answer landed while syncing A that a region series (every home) reads.
  ownRaw = (await landRaw({ source: 'octopus_meter', siteId: A.id, request: { path: '/a-only' }, body: { only: 'A' } })).rawId;
  ownFile = path.join(dataDir, (await db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(ownRaw)).file);
  sharedRaw = (await landRaw({ source: 'carbon_regional', siteId: A.id, request: { path: '/region' }, body: { shared: 'carbon' } })).rawId;
  await db.prepare(`INSERT INTO interval_fact (series_id, start_ts, end_ts, value, recorded_at, raw_id) VALUES (?, 1792969200, 1792971000, 123, 0, ?)`)
        .run(await seriesId('region', 'carbon:3', 'carbon_intensity', 'carbon_regional'), sharedRaw);
  assert.ok(fs.existsSync(ownFile));
  const a = await rowsOf(A.id);
  assert.ok(a.site_day > 0 && a.site_hh > 0 && a.device > 0 && a.series > 0 && a.interval_fact > 0, `the real home holds data: ${JSON.stringify(a)}`);
});

await test('refused: nobody signed in, someone else\'s home, the name not typed exactly, the .env home', { skip }, async () => {
  await assert.rejects(async () => await deleteHome(null, A, { confirm: A.name }), (e) => e.status === 401);
  await assert.rejects(async () => await deleteHome(other, A, { confirm: A.name }), (e) => e.status === 403 && /Only the owner/.test(e.message));
  for (const confirm of [undefined, '', 'yes', A.name.toUpperCase() === A.name ? `${A.name}x` : A.name.toUpperCase()]) {
    await assert.rejects(async () => await deleteHome(owner, A, { confirm }), (e) => e.status === 400 && e.message.includes(A.name), String(confirm));
  }
  await assert.rejects(async () => await deleteHome(owner, { ...A, env_key: 'env' }, { confirm: A.name }), /configured in \.env/);
  assert.ok(await db.prepare('SELECT 1 FROM site WHERE id = ?').get(A.id), 'still there');
});

await test('the preview counts what would go, and changes nothing', { skip }, async () => {
  const before = await fingerprint(A.id);
  const f = await homeFootprint(A.id);
  assert.ok(f.counts.site_day > 0 && f.counts.device > 0 && f.counts.connection_secret === 1);
  // Kept: the carbon answer the region reads, and the real home's catalogue answers its shared tariff rows point at.
  assert.ok(f.raw.kept.includes(sharedRaw) && !f.raw.kept.includes(ownRaw));
  assert.ok(f.raw.deleted.some((r) => r.id === ownRaw));
  const sharedRates = (await db.prepare('SELECT COUNT(*) AS n FROM rate_interval WHERE site_id IS NULL AND raw_id::text IN (SELECT jsonb_array_elements_text(?::jsonb))').get(JSON.stringify(f.raw.kept))).n;
  assert.ok(sharedRates > 0, 'catalogue tariff rows (no home) point at some of them');
  assert.equal(await fingerprint(A.id), before);
});

await test('deleting A removes every row that belongs to it and its raw files; B, the shared answer and the foreign keys are untouched', { skip }, async () => {
  const bBefore = await fingerprint(B.id);
  const r = await deleteHome(owner, A, { confirm: `  ${A.name} ` });
  assert.deepEqual(r.deleted, { id: A.id, name: A.name });
  assert.ok(r.rows.site === 1 && r.rows.site_day > 0 && r.rows.interval_fact > 0, JSON.stringify(r.rows));
  // Nothing anywhere still names A, except the record that it was erased (ids and counts only).
  const left = await rowsOf(A.id);
  assert.equal(left.erasure_log, 1, 'the erasure is logged');
  delete left.erasure_log;
  assert.deepEqual(Object.entries(left).filter(([, n]) => n), [], `rows left: ${JSON.stringify(left)}`);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM connection_secret WHERE site_id = ?').get(A.id)).n, 0, 'the stored login is gone');
  // Raw: A's own answer and its file are gone; the shared one stays, no longer naming A, with the fact that reads it.
  assert.equal(await db.prepare('SELECT 1 FROM raw_payload WHERE id = ?').get(ownRaw), undefined);
  assert.equal(fs.existsSync(ownFile), false);
  assert.deepEqual({ ...await db.prepare('SELECT site_id FROM raw_payload WHERE id = ?').get(sharedRaw) }, { site_id: null });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM interval_fact WHERE raw_id = ?').get(sharedRaw)).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rate_interval r LEFT JOIN raw_payload p ON p.id = r.raw_id WHERE r.raw_id IS NOT NULL AND p.id IS NULL').get()).n, 0, 'every shared tariff row keeps its raw answer');
  // B is exactly as it was; the database is consistent.
  assert.equal(await fingerprint(B.id), bBefore);
  // Foreign keys are checked by Postgres when the deletion commits: a dangling row would have failed it.
});

await test('over HTTP: the preview, then DELETE /api/sites/:id with the typed name; the home is gone for its owner', { skip }, async () => {
  const srv = app.listen(0);
  srv.unref();
  const tok = await startSession(owner.id);
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method, headers: { cookie: `eb_session=${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const pv = await call('GET', `/api/sites/${B.id}/delete-preview`);
  assert.deepEqual([pv.status, pv.json.name, pv.json.devices, pv.json.env_home], [200, 'Second home', 1, false]);
  assert.deepEqual(pv.json.accounts, [], 'no account connected by the user (automatic feeds are not listed)');
  const no = await call('DELETE', `/api/sites/${B.id}`, { confirm: 'second home' });
  assert.equal(no.status, 400);
  const ok = await call('DELETE', `/api/sites/${B.id}`, { confirm: 'Second home' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.rows.site, 1);
  assert.equal((await call('GET', `/api/sites/${B.id}/delete-preview`)).status, 404, 'gone');
  assert.ok(!(await call('GET', '/api/sites')).json.some?.((s) => s.id === B.id));
});
