// Raw-data safety, phase 1.7: where the raw files live (RAW_DIR), the check of each file against its hash, and the retention
// run held against the append-only and erasure rules (fix list R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useDb } from './helpers.js';

await useDb();
const { db, rawDir, rawFilePath } = await import('../src/db/db.js');
const { resolveRawDir, rawFileIn, rawName } = await import('../src/db/raw-dir.js');
const { createSite } = await import('../src/core/sites.js');
const { landRaw, quarantine, readRaw, openRaw, rawHash, seriesId, putReadings } = await import('../src/core/facts.js');
const { verifyRaw, runRawCheck, rawVerifySettings, sliceFor, lastRawCheck, rawCheckSummary } = await import('../src/core/raw-integrity.js');
const { runRetention, runMaintenance } = await import('../src/core/maintenance.js');
const { erase } = await import('../src/core/erasure.js');

const root = path.resolve(import.meta.dirname, '..');
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const homeA = await createSite({ name: 'Raw A' });
const homeB = await createSite({ name: 'Raw B' });
let n = 0;
const land = async (siteId, source = 'sunsynk_5min') => (await landRaw({ source, siteId, request: { url: `https://api.example/v1/${source}?n=${++n}` }, body: { n, v: `value-${n}` } })).rawId;
const row = async (id) => await db.prepare('SELECT p.*, src.code AS source FROM raw_payload p JOIN source src ON src.id = p.source_id WHERE p.id = ?').get(id);
const fileOf = async (id) => rawFilePath((await row(id)).file);

await test('the raw folder: DATA_DIR/raw by default, RAW_DIR when set, and a file name that leaves it is refused', () => {
  assert.equal(resolveRawDir({}, '/app'), '/app/data/raw');
  assert.equal(resolveRawDir({ DATA_DIR: 'state' }, '/app'), '/app/state/raw');
  assert.equal(resolveRawDir({ DATA_DIR: 'state', RAW_DIR: '/mnt/raw' }, '/app'), '/mnt/raw');
  assert.equal(resolveRawDir({ RAW_DIR: 'volumes/raw' }, '/app'), '/app/volumes/raw');
  assert.equal(rawFileIn('/mnt/raw', 'raw/sunsynk/2026-11-18/ab12.json'), '/mnt/raw/sunsynk/2026-11-18/ab12.json', 'the raw/ in the stored name is the folder itself');
  for (const bad of ['redacted-12', 'raw', 'raw/../../etc/passwd', 'raw/a/../../b', '/etc/passwd', '../raw/x', '', null]) assert.equal(rawFileIn('/mnt/raw', bad), null, String(bad));
  assert.equal(rawName('/mnt/raw', '/mnt/raw/a/b.json'), path.join('raw', 'a', 'b.json'));
  assert.equal(rawDir, path.join(process.env.DATA_DIR, 'raw'), 'the tests run with the default');
});

await test('RAW_DIR: receipts land in that folder, read back, verify, and the app refuses a folder that is not there', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-rawstore-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-rawdata-'));
  const script = `
    const { landRaw, readRaw } = await import(${JSON.stringify(path.join(root, 'src/core/facts.js'))});
    const { verifyRaw } = await import(${JSON.stringify(path.join(root, 'src/core/raw-integrity.js'))});
    const { db, closeDb } = await import(${JSON.stringify(path.join(root, 'src/db/db.js'))});
    const site = Number((await db.prepare("INSERT INTO site (name, created_at) VALUES ('Elsewhere', 1)").run()).lastInsertRowid);
    const mine = await landRaw({ source: 'sunsynk_5min', siteId: site, request: {}, body: { secret: 'home' } });
    const pub = await landRaw({ source: 'octopus_rates', siteId: site, request: {}, body: { rates: 1 } });
    const files = await db.prepare('SELECT id, file, site_id FROM raw_payload ORDER BY id').all();
    const text = await readRaw(files[0]);
    const report = await verifyRaw();
    console.log(JSON.stringify({ files, text, checked: report.checked, ok: report.ok, problems: report.problems }));
    // the test database is shared with the rest of this file: take this child's receipts out again (a logged erasure)
    const { erase } = await import(${JSON.stringify(path.join(root, 'src/core/erasure.js'))});
    await erase({ kind: 'synthetic', reason: 'test: receipts of a child process in another raw store' }, async () => await db.prepare('DELETE FROM raw_payload WHERE site_id = ?').run(site));
    await closeDb();`;
  const env = { ...process.env, DATA_DIR: data, RAW_DIR: store };
  const run = (e) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: e, encoding: 'utf8', cwd: root });
  const out = run(env);
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(r.files.length, 2);
  for (const f of r.files) {
    assert.ok(f.file.startsWith('raw/'), 'the stored name keeps its raw/ prefix');
    assert.ok(fs.existsSync(path.join(store, f.file.slice(4))), `${f.file} is under RAW_DIR`);
  }
  assert.ok(!fs.existsSync(path.join(data, 'raw')), 'nothing was written under DATA_DIR/raw');
  assert.deepEqual([r.text, r.checked, r.ok, r.problems.length], ['{"secret":"home"}', 2, 2, 0]);
  const gone = run({ ...env, RAW_DIR: path.join(store, 'not-mounted') });
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /RAW_DIR .* is not an existing directory/);
  assert.ok(!fs.existsSync(path.join(store, 'not-mounted')), 'the missing folder was not created');
  fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
});

await test('verifyRaw: untouched files all match; a plain file, a sealed file and a quarantined one', async () => {
  const sealed = await land(homeA.id);
  const pub = await land(homeA.id, 'octopus_rates');
  const q = (await quarantine({ source: 'sunsynk_5min', siteId: homeA.id, request: {}, body: { bad: 1 }, reason: 'test' })).rawId;
  const noHome = await land(null, 'open_meteo');
  assert.ok((await fs.promises.readFile(await fileOf(sealed))).subarray(0, 6).toString() === 'EBRAW1');
  const r = await verifyRaw({ batch: 2 });   // pages of 2: the keyset paging reaches every row
  assert.deepEqual([r.checked, r.ok, r.problems.length, r.unsealed, r.unverifiable], [4, 4, 0, 0, 0]);
  assert.ok(r.bytes > 0 && Number.isFinite(r.ms));
  assert.equal((await openRaw(await row(sealed))).state, 'ok');
  assert.equal(rawHash('sunsynk_5min', 'quarantined', '{"bad":1}'), (await row(q)).hash, 'the hash covers source, status and text');
  assert.ok(pub && noHome);
  assert.match(rawCheckSummary(r), /4 receipts.*4 match their hash; no problems/);
});

await test('verifyRaw finds a file that changed, was cut short, vanished, is unreadable, lost its key or was never sealed', async () => {
  const changedPlain = await land(homeA.id, 'octopus_rates');
  const changedSealed = await land(homeB.id);
  const cutShort = await land(homeB.id);
  const vanished = await land(homeB.id);
  const locked = await land(homeB.id, 'open_meteo');
  const keyLost = await land(homeA.id);
  // 1. a plain file edited: the text no longer hashes to the stored hash
  fs.writeFileSync(await fileOf(changedPlain), '{"results":[{"value_exc_vat":999}]}');
  // 2. a sealed file with one byte flipped in its body: the GCM tag fails
  const f = await fileOf(changedSealed); const buf = fs.readFileSync(f); buf[buf.length - 2] ^= 1; fs.writeFileSync(f, buf);
  // 3. a sealed file cut short
  fs.truncateSync(await fileOf(cutShort), 30);
  // 4. a file gone
  fs.rmSync(await fileOf(vanished));
  // 5. a file the disk refuses (not as root: root reads anything)
  const canLock = process.getuid?.() !== 0;
  if (canLock) fs.chmodSync(await fileOf(locked), 0);
  // 6. the key of a home that still exists is gone: its sealed files cannot be opened
  const before = await verifyRaw();
  await db.prepare('DELETE FROM home_key WHERE site_id = ?').run(homeA.id);
  const r = await verifyRaw();
  if (canLock) fs.chmodSync(await fileOf(locked), 0o600);

  const stateOf = (rep, id) => rep.problems.find((p) => p.id === id)?.state;
  assert.equal(stateOf(before, changedPlain), 'mismatch');
  assert.equal(stateOf(before, changedSealed), 'corrupt');
  assert.equal(stateOf(before, cutShort), 'corrupt');
  assert.equal(stateOf(before, vanished), 'missing');
  if (canLock) assert.equal(stateOf(before, locked), 'unreadable');
  assert.equal(before.keyLost, 0);
  assert.equal(stateOf(r, keyLost), 'keyLost');
  assert.ok(r.keyLost >= 3, 'every sealed file of home A, none of home B');
  assert.deepEqual(r.problemsBySite[homeB.id], before.problemsBySite[homeB.id], 'home B has the same problems with or without home A key');
  // only one home
  const onlyB = await verifyRaw({ siteId: homeB.id });
  assert.ok(onlyB.problems.length > 0 && onlyB.problems.every((p) => p.siteId === homeB.id));
  assert.match(rawCheckSummary(r), /PROBLEMS/);
  // the problem list is bounded, the counts are not
  const capped = await verifyRaw({ maxProblems: 2 });
  assert.deepEqual([capped.problems.length, capped.truncated], [2, true]);
  // reads only: nothing was rewritten
  assert.equal(fs.readFileSync(await fileOf(changedPlain), 'utf8'), '{"results":[{"value_exc_vat":999}]}');
  // a home's file stored in clear text with the right text: it matches its hash, and is reported as not sealed
  const body = { clear: 'text' };
  const clear = (await landRaw({ source: 'sunsynk_5min', siteId: homeB.id, request: {}, body })).rawId;
  fs.writeFileSync(await fileOf(clear), JSON.stringify(body));
  const after = await verifyRaw({ siteId: homeB.id });
  assert.equal(stateOf(after, clear), 'unsealed');
  assert.ok(after.unsealed >= 1 && after.ok >= 1);
});

await test('a sealed file of an erased home cannot be checked, and that is not a problem', async () => {
  const id = await land(homeB.id);
  const p = await row(id);
  // the shape delete-home leaves for a receipt kept as shared evidence: no home, a file sealed with a key that no longer exists
  const copy = 'raw/sunsynk_5min/erased/copy.json';
  fs.mkdirSync(path.dirname(rawFilePath(copy)), { recursive: true });
  fs.copyFileSync(rawFilePath(p.file), rawFilePath(copy));
  const sourceId = p.source_id;
  await db.prepare('INSERT INTO raw_payload (source_id, site_id, request, fetched_at, hash, file, status) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(sourceId, '{}', NOW, 'erased-home-hash', copy, 'accepted');
  const r = await verifyRaw();
  assert.equal(r.unverifiable, 1);
  assert.ok(!r.problems.some((x) => x.file === copy));
  assert.match(rawCheckSummary(r), /1 sealed files of erased homes cannot be checked/);
  assert.equal(await readRaw({ file: copy, site_id: null }), null);
});

await test('slices: the days of a cycle together cover every receipt once', async () => {
  const all = await verifyRaw();
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(await verifyRaw({ slice: { index: i, of: 3 } }));
  assert.equal(parts.reduce((a, p) => a + p.checked, 0), all.checked);
  assert.ok(parts.every((p) => p.checked > 0), 'ids spread over the slices');
  assert.deepEqual(sliceFor(0, 7), { index: 0, of: 7 });
  assert.deepEqual(sliceFor(3 * 86400000 + 5, 7), { index: 3, of: 7 });
  assert.deepEqual(sliceFor(10 * 86400000, 7), { index: 3, of: 7 });
  await assert.rejects(async () => await verifyRaw({ slice: { index: 3, of: 3 } }), /slice is/);
});

await test('settings and the start-up hook', async () => {
  assert.deepEqual(rawVerifySettings({}), { mode: 'report', days: 7 });
  assert.deepEqual(rawVerifySettings({ RAW_VERIFY: 'off', RAW_VERIFY_DAYS: '30' }), { mode: 'off', days: 30 });
  assert.throws(() => rawVerifySettings({ RAW_VERIFY: 'yes' }), /RAW_VERIFY must be one of off, report/);
  assert.throws(() => rawVerifySettings({ RAW_VERIFY_DAYS: '0' }), /RAW_VERIFY_DAYS/);
  assert.throws(() => rawVerifySettings({ RAW_VERIFY_DAYS: '1.5' }), /RAW_VERIFY_DAYS/);
  assert.equal(await runRawCheck({ env: { RAW_VERIFY: 'off' } }), null);
  const m = await runMaintenance({ retention: 'off' });
  assert.ok(m.rawCheck.checked > 0 && m.rawCheck === lastRawCheck(), 'the hook runs the day\'s slice and keeps it for the health page');
  assert.deepEqual(Object.keys(m), Object.keys(m).filter((k) => /^\d+$/.test(k)), 'the per-home results keep their shape');
  assert.equal((await runMaintenance({ retention: 'off', rawCheck: false })).rawCheck, null);
  assert.equal(rawCheckSummary(null), 'raw file check: off');
});

// ───────────── retention against the append-only and erasure rules ─────────────
const logCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM erasure_log').get()).n;
const rawCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM raw_payload').get()).n;
const factCount = async () => (await db.prepare('SELECT (SELECT COUNT(*) FROM reading) + (SELECT COUNT(*) FROM interval_fact) + (SELECT COUNT(*) FROM forecast_fact) AS n').get()).n;
const tmpFiles = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } }; walk(rawDir); return out; };

await test('raw_payload and facts refuse a delete or an update outside a logged erasure', async () => {
  const id = await land(homeA.id, 'open_meteo');
  await assert.rejects(async () => await db.prepare('DELETE FROM raw_payload WHERE id = ?').run(id), /append-only: raw_payload rows never change/);
  await assert.rejects(async () => await db.prepare('UPDATE raw_payload SET fetched_at = 1 WHERE id = ?').run(id), /append-only: raw_payload rows never change/);
  assert.ok(await row(id));
});

await test('retention: the dry run changes nothing and logs nothing; apply is one logged erasure that matches the dry run, and keeps what facts need', async () => {
  const age = async (id, days) => await erase({ kind: 'synthetic', reason: 'test: a receipt aged' }, async () => await db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(NOW - days * DAY, id));
  const free = [await land(homeA.id, 'open_meteo'), await land(homeA.id, 'open_meteo'), await land(homeA.id, 'octopus_rates')];   // old and unreferenced: go
  const freeSealed = await land(homeB.id, 'open_meteo');                                                        // a home's sealed file: goes too
  const fed = await land(homeA.id, 'open_meteo');                                                  // feeds a fact: stays
  await putReadings(await seriesId('site', homeA.id, 'solar_w', 'sunsynk_live'), [{ ts: NOW - 20 * DAY, value: 1 }], fed);
  const quarantined = (await quarantine({ source: 'open_meteo', siteId: homeA.id, request: { url: 'https://api.example/q' }, body: { bad: 1 }, reason: 'test' })).rawId;
  const fresh = await land(homeA.id, 'open_meteo');
  for (const id of [...free, freeSealed, fed, quarantined]) await age(id, 20);
  await age(fresh, 1);
  // a row whose name is not in the raw store at all (an anonymised copy): retention must neither fail on it nor touch anything else
  await erase({ kind: 'synthetic', reason: 'test: a receipt outside the store' }, async () => await db.prepare("UPDATE raw_payload SET file = 'redacted-1' WHERE id = ?").run(free[2]));
  fs.writeFileSync(path.join(rawDir, 'sunsynk_5min', 'half-written.json.1234.tmp'), 'partial');
  fs.utimesSync(path.join(rawDir, 'sunsynk_5min', 'half-written.json.1234.tmp'), NOW - 30 * DAY, NOW - 30 * DAY);

  const before = { raws: await rawCount(), facts: await factCount(), log: await logCount(), files: tmpFiles().sort() };
  const problemsBefore = new Set((await verifyRaw()).problems.map((p) => p.id));   // the files damaged by the tests above stay damaged
  const dry = await runRetention({ now: NOW });
  assert.deepEqual([await rawCount(), await factCount(), await logCount(), tmpFiles().sort()], [before.raws, before.facts, before.log, before.files], 'a dry run changes no row, no file and no log');
  assert.equal(dry.raw.candidates, 4, 'two sealed and one plain receipt of home A, one sealed of home B (one of them with a name outside the store)');
  assert.ok(dry.raw.keptReferenced >= 1 && dry.raw.quarantinedKept >= 1);

  const done = await runRetention({ now: NOW, dryRun: false });
  assert.equal(done.raw.deleted, dry.raw.candidates, 'apply removes what the dry run listed');
  assert.equal(await logCount(), before.log + 1, 'one erasure for the raw batch');
  const log = await db.prepare("SELECT * FROM erasure_log WHERE kind = 'retention' ORDER BY id DESC LIMIT 1").get();
  assert.ok(log.finished_at >= log.started_at && log.reason.length > 0 && log.site_id === null);
  assert.equal(JSON.parse(log.removed).raw_payload, done.raw.deleted);
  assert.equal(await rawCount(), before.raws - done.raw.deleted);
  assert.equal(await factCount(), before.facts, 'retention of raw receipts removes no fact');
  for (const id of [fed, quarantined, fresh]) assert.ok(await row(id), `payload ${id} kept`);
  for (const id of [free[0], free[1], freeSealed]) assert.equal(await row(id), undefined);
  assert.equal(await row(free[2]), undefined, 'a row outside the store goes too, without an error');
  assert.equal(fs.existsSync(path.join(rawDir, 'sunsynk_5min', 'half-written.json.1234.tmp')), false, 'a half-written temporary file is an orphan');
  // the erasure is closed: the append-only rule is back
  await assert.rejects(async () => await db.prepare('DELETE FROM raw_payload WHERE id = ?').run(fed), /append-only/);
  // what is left verifies, and a second run does nothing
  const after = await verifyRaw();
  assert.ok(after.problems.every((p) => problemsBefore.has(p.id)), 'retention created no problem: every surviving file is as it was');
  assert.ok(!after.problems.some((p) => [free[0], free[1], free[2], freeSealed].includes(p.id)));
  assert.equal((await runRetention({ now: NOW, dryRun: false })).raw.deleted, 0);
  assert.equal(await logCount(), before.log + 1, 'nothing to delete, nothing logged');
});

await test('retention that fails inside its erasure removes nothing: rows stay, files stay, the log row rolls back', async () => {
  const id = await land(homeA.id, 'open_meteo');
  await erase({ kind: 'synthetic', reason: 'test: a receipt aged' }, async () => await db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(NOW - 30 * DAY, id));
  const log = await logCount();
  const file = await fileOf(id);
  await assert.rejects(async () => await erase({ kind: 'retention', reason: 'test: fails half way' }, async () => {
    await db.prepare('DELETE FROM raw_payload WHERE id = ?').run(id);
    throw new Error('boom');
  }), /boom/);
  assert.ok(await row(id) && fs.existsSync(file));
  assert.equal(await logCount(), log, 'no log row without its deletes, no deletes without their log row');
  assert.equal(await db.prepare("SELECT current_setting('energiebee.erasure', true) AS v").get().then((x) => x.v || ''), '', 'the erasure is not left open');
});
