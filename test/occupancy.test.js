// R21 and R14 (cases 13 and 14): a home changes hands, a person asks to be erased. The home's history stays; what is personal goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useDb } from './helpers.js';

await useDb();
process.env.USER_SWITCHER = '1';
const { db } = await import('../src/db/db.js');
const { rawFilePath } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { addDevice } = await import('../src/core/tariffs.js');
const F = await import('../src/core/facts.js');
const O = await import('../src/core/occupancy.js');
const { createUser, giveHome, userById } = await import('../src/core/users.js');
const { viewWindows } = await import('../src/core/access.js');
const { getThing } = await import('../src/core/things.js');
const { buildHomePointSlots } = await import('../src/core/point-slots.js');
const { dayBounds } = await import('../src/core/time.js');
const C = await import('../src/core/controls.js');

const T0 = Date.UTC(2026, 8, 14) / 1000; const DAY = '2026-09-16'; const [D0] = dayBounds('Europe/London', DAY);
const home = async (name) => Number((await db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES (?, ?, 'GB', 'GB', 'GBP')").run(name, T0)).lastInsertRowid);
const person = async (name) => await createUser({ name, username: name.toLowerCase().replace(/\W/g, ''), role: 'owner' });
const get = async (path, user) => { const srv = app.listen(0); try { const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { headers: user ? { 'x-user-id': String(user.id) } : {} }); return { status: r.status, body: await r.json().catch(() => null) }; } finally { srv.close(); } };
const stamp = async (name) => { await db.exec("INSERT INTO source (code, name, contract, traits) VALUES ('octopus_kraken', 'Kraken', '{}', '{\"personal\":true}') ON CONFLICT (code) DO UPDATE SET traits = excluded.traits"); };
await stamp();

await test('giveHome opens an occupancy; a second give is the same occupancy', async () => {
  const h = await home('Opens'); const a = await person('Ada Opens');
  await giveHome(a.id, h); await giveHome(a.id, h);
  const rows = await O.occupanciesOf(h);
  assert.deepEqual(rows.map((r) => [Number(r.user_id), r.role, r.valid_to]), [[a.id, 'owner', null]]);
  assert.equal(await O.readableFrom(a.id, h), null, 'the first owner reads all of it');
});

await test('a handover ends the old occupancy, removes what was personal, and the new owner reads from the handover only', async () => {
  const h = await home('Sold'); const old = await person('Old Owner'); const next = await person('New Owner'); await giveHome(old.id, h);
  const meter = await addDevice({ siteId: h, kind: 'meter_import', provider: 'push', externalRef: 'm-sold', recordedAt: (T0 + 3600) * 1000 });
  const s = await F.seriesId('device', meter.id, 'grid_import_w', 'push_native');
  await F.asWriter('push_native', async () => { await F.putReadings(s, Array.from({ length: 40 }, (_, i) => ({ ts: D0 + i * 1800, value: 500 }))); });
  await db.prepare("INSERT INTO connection (site_id, provider, status) VALUES (?, 'octopus', 'ok')").run(h);
  await db.prepare("INSERT INTO connection_secret (site_id, provider, iv, tag, ciphertext, recorded_at) VALUES (?, 'octopus', ?, ?, ?, ?)").run(h, Buffer.alloc(12), Buffer.alloc(16), Buffer.from('x'), T0);
  const answer = await F.landRaw({ source: 'octopus_kraken', siteId: h, request: { q: 'account' }, body: { account: 'A-1', name: 'Old Owner', address: '10 Sold Road' } });
  const raw = await db.prepare('SELECT * FROM raw_payload WHERE id = ?').get(answer.rawId);
  assert.ok(raw.occupancy_id != null, 'the supplier answer is sealed with the occupancy\'s key');
  assert.match(fs.readFileSync(rawFilePath(raw.file)).subarray(0, 6).toString(), /EBRAW2/);
  assert.equal((await F.openRaw(raw)).state, 'ok');
  await buildHomePointSlots(h, DAY, DAY);
  const open = (await get(`/api/things/${(await getThing(meter.id)).uid}/timeline?from=${D0}&to=${D0 + 86400}`, old));
  assert.equal(open.status, 200);
  assert.ok(open.body.lines.length, 'the old owner reads everything');

  const at = D0 + 12 * 3600;
  const r = await O.handOver({ homeId: h, fromUserId: old.id, toUserId: next.id, at });
  assert.deepEqual([r.ended.valid_to == null ? null : Number(r.ended.valid_to), Number(r.opened.valid_from), Number(r.opened.sees_from)], [at, at, at]);
  assert.equal(r.removed.handover.logins, 1);
  assert.equal(r.removed.handover.receipts, 1);
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM connection_secret WHERE site_id = ?').get(h).then((x) => Number(x.n)), 0, 'the old owner\'s login is gone');
  assert.equal(await db.prepare('SELECT status FROM connection WHERE site_id = ?').get(h).then((x) => x.status), 'disabled');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM raw_payload WHERE id = ?').get(answer.rawId).then((x) => Number(x.n)), 0, 'the supplier account answer is gone');
  assert.equal(fs.existsSync(rawFilePath(raw.file)), false, 'with its file');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM occupancy_key WHERE occupancy_id = ?').get(raw.occupancy_id).then((x) => Number(x.n)), 0, 'and its key');
  assert.deepEqual(await viewWindows(old.id, h), [], 'the old owner may read nothing');
  assert.deepEqual(await viewWindows(next.id, h), [{ from: at, to: null }]);
  assert.equal((await get(`/api/things/${(await getThing(h)).uid}/timeline?from=${D0}&to=${D0 + 86400}`, old)).status, 404, 'the home is no longer theirs');

  // the home's history stayed: the new owner sees it from the handover
  const t = await get(`/api/things/${(await getThing(meter.id)).uid}/timeline?from=${D0}&to=${D0 + 86400}`, next);
  assert.equal(t.status, 200);
  const starts = t.body.lines.flatMap((l) => l.slots.map((x) => x.slot_start));
  assert.ok(starts.length > 0 && starts.every((x) => x >= at), 'from the handover only');
  assert.equal(t.body.from, at, 'the window says so');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) n FROM reading WHERE series_id = ?').get(s)).n), 40, 'every reading is still there');
});

await test('the previous owner may share more: an earlier sees_from', async () => {
  const h = await home('Shared'); const old = await person('Gives More'); const next = await person('Gets More'); await giveHome(old.id, h);
  const at = D0 + 6 * 3600;
  await O.handOver({ homeId: h, fromUserId: old.id, toUserId: next.id, at, seesFrom: at - 86400 });
  assert.equal(await O.readableFrom(next.id, h), at - 86400);
  await assert.rejects(O.handOver({ homeId: h, fromUserId: old.id, toUserId: next.id, at: at + 10 }), /not living/);
});

await test('open requests of the old occupancy end with the handover', async () => {
  const h = await home('Requests'); const old = await person('Asker'); const next = await person('Taker'); await giveHome(old.id, h);
  const plug = await addDevice({ siteId: h, kind: 'smart_plug', provider: 'push', externalRef: 'plug-r', recordedAt: (T0 + 3600) * 1000 });
  const now = Date.now(); const from = Math.floor(now / 1000) - 60;
  const req = await C.submitRequest({ thingId: plug.id, capability: 'on_off', action: 'off', priority: 'manual', validFrom: from, validUntil: from + 86400, source: 'old owner', now });
  const r = await O.handOver({ homeId: h, fromUserId: old.id, toUserId: next.id, at: from + 120, now });
  assert.equal(r.removed.handover.requests_cancelled, 1);
  assert.notEqual((await C.requestsOf(plug.id, 'on_off')).find((x) => x.id === req.id).cancelled_at, null);
});

await test('erasing a person removes the account, their answers and their groups; the home keeps its history and its occupancy dates', async () => {
  const h = await home('Erased'); const p = await person('Eve Erased'); await giveHome(p.id, h);
  const meter = await addDevice({ siteId: h, kind: 'meter_import', provider: 'push', externalRef: 'm-erased', recordedAt: (T0 + 3600) * 1000 });
  const s = await F.seriesId('device', meter.id, 'grid_import_w', 'push_native');
  await F.asWriter('push_native', async () => { await F.putReadings(s, Array.from({ length: 10 }, (_, i) => ({ ts: D0 + i * 1800, value: 300 }))); });
  await db.prepare("INSERT INTO connection (site_id, provider, status) VALUES (?, 'octopus', 'ok')").run(h);
  await db.prepare("INSERT INTO connection_secret (site_id, provider, iv, tag, ciphertext, recorded_at) VALUES (?, 'octopus', ?, ?, ?, ?)").run(h, Buffer.alloc(12), Buffer.alloc(16), Buffer.from('x'), T0);
  const answer = await F.landRaw({ source: 'octopus_kraken', siteId: h, request: { q: 'account' }, body: { name: 'Eve Erased', address: '1 Erased Lane' } });
  const device = await F.landRaw({ source: 'push_native', siteId: h, request: { q: 'push' }, body: { w: 300 } });
  await db.prepare("INSERT INTO site_group (name, owner_id, timezone, created_at) VALUES ('Eve group', ?, 'Europe/London', ?)").run(p.id, T0);
  await db.prepare("INSERT INTO user_session (token_hash, user_id, created_at, expires_at) VALUES ('tok-eve', ?, ?, ?)").run(p.id, T0 * 1000, (T0 + 86400) * 1000).catch(() => null);

  const r = await O.erasePerson(p.id, { reason: 'asked by the person (test)' });
  assert.equal(r.removed.person.account, 1);
  assert.equal(r.removed.person.receipts, 1);
  assert.equal(await userById(p.id), null, 'the account is gone');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM raw_payload WHERE id = ?').get(answer.rawId).then((x) => Number(x.n)), 0, 'the personal answer is gone');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM raw_payload WHERE id = ?').get(device.rawId).then((x) => Number(x.n)), 1, 'the device\'s own raw receipt stays');
  assert.equal(await db.prepare('SELECT COUNT(*) n FROM connection_secret WHERE site_id = ?').get(h).then((x) => Number(x.n)), 0, 'the supplier login is gone');
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM site_group WHERE name = 'Eve group'").get().then((x) => Number(x.n)), 0);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) n FROM reading WHERE series_id = ?').get(s)).n), 10, 'the home\'s device history stays');
  const occ = await O.occupanciesOf(h);
  assert.deepEqual(occ.map((o) => [o.user_id, o.erased_at != null]), [[null, true]], 'the home still knows it was lived in, not by whom');
  const log = await db.prepare("SELECT kind, site_id, finished_at FROM erasure_log WHERE kind = 'person' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([log.kind, log.site_id, log.finished_at != null], ['person', null, true], 'the erasure is logged');
  await assert.rejects(O.erasePerson(p.id), /no user/);
});
