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
const { verifyRaw, runRawCheck, rawVerifySettings, rawCheckOfHome, rawCheckSummary } = await import('../src/core/raw-integrity.js');
const { app } = await import('../src/server.js');
const { runRetention, runMaintenance } = await import('../src/core/maintenance.js');
const { erase } = await import('../src/core/erasure.js');

const root = path.resolve(import.meta.dirname, '..');
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const homeA = await createSite({ name: 'Raw A' });
const homeB = await createSite({ name: 'Raw B' });
let n = 0;
const land = async (siteId, source = 'sunsynk_5min') => (await landRaw({ source, siteId, request: { url: `https://api.example/v1/${source}?n=${++n}` }, body: { n, v: `value-${n}` } })).rawId;
let base;
const row = async (id) => await db.prepare('SELECT p.*, src.code AS source FROM raw_payload p JOIN source src ON src.id = p.source_id WHERE p.id = ?').get(id);
const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); sv.unref(); });
base = `http://127.0.0.1:${server.address().port}`;
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

await test('RAW_DIR outside DATA_DIR: files are written, read, sealed, retained and erased there, and the app refuses a folder that is not there', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-rawstore-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-rawdata-'));
  const day = 86400;
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawnSync } from 'node:child_process';
    const { landRaw, readRaw } = await import(${JSON.stringify(path.join(root, 'src/core/facts.js'))});
    const { verifyRaw } = await import(${JSON.stringify(path.join(root, 'src/core/raw-integrity.js'))});
    const { runRetention } = await import(${JSON.stringify(path.join(root, 'src/core/maintenance.js'))});
    const { deleteHome } = await import(${JSON.stringify(path.join(root, 'src/core/delete-home.js'))});
    const { createSite } = await import(${JSON.stringify(path.join(root, 'src/core/sites.js'))});
    const { erase } = await import(${JSON.stringify(path.join(root, 'src/core/erasure.js'))});
    const { db, closeDb, rawFilePath } = await import(${JSON.stringify(path.join(root, 'src/db/db.js'))});
    const store = process.env.RAW_DIR;
    const magic = (f) => fs.readFileSync(f).subarray(0, 6).toString();
    const made = await createSite({ name: 'Elsewhere' });
    const site = await db.prepare('SELECT * FROM site WHERE id = ?').get(made.id);
    // written
    const mine = await landRaw({ source: 'sunsynk_5min', siteId: site.id, request: {}, body: { secret: 'home' } });
    const pub = await landRaw({ source: 'octopus_rates', siteId: site.id, request: {}, body: { rates: 1 } });
    const files = await db.prepare('SELECT id, file, site_id FROM raw_payload ORDER BY id').all();
    // read, sealed, checked
    const text = await readRaw(files[0]);
    const sealedMagic = magic(rawFilePath(files[0].file));
    const report = await verifyRaw();
    const { rawOne } = await import(${JSON.stringify(path.join(root, 'src/core/explorer.js'))});
    const viewed = await rawOne(mine.rawId, {});
    // a file written before sealing existed: the seal script finds it in RAW_DIR, a dry run leaves it, apply seals it
    const old = await landRaw({ source: 'sunsynk_5min', siteId: site.id, request: {}, body: { old: 1 } });
    const oldFile = rawFilePath((await db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(old.rawId)).file);
    fs.writeFileSync(oldFile, JSON.stringify({ old: 1 }));
    const seal = (...args) => JSON.parse(spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ${JSON.stringify(path.join(root, 'scripts/seal-raw.js'))}, ...args], { env: process.env, encoding: 'utf8', cwd: ${JSON.stringify(root)} }).stdout);
    const dry = seal();
    const dryMagic = magic(oldFile);
    const applied = seal('--apply');
    const appliedMagic = magic(oldFile);
    // retained: an old receipt (the newest of its endpoint stays), an orphan in the store's layout, and files that are not the store's
    const first = await landRaw({ source: 'open_meteo', siteId: null, request: {}, body: { a: 1 } });
    const second = await landRaw({ source: 'open_meteo', siteId: null, request: {}, body: { b: 1 } });
    const firstFile = rawFilePath((await db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(first.rawId)).file);
    const old40 = Math.floor(Date.now() / 1000) - 40 * ${day};
    await erase({ kind: 'synthetic', reason: 'test: a receipt aged' }, async () => await db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(old40, first.rawId));
    const age = (f) => fs.utimesSync(f, old40, old40);
    const orphan = path.join(store, 'open_meteo', '2020-01-01', 'orphan.json');
    const notes = path.join(store, 'notes-from-ops.txt');
    const lost = path.join(store, 'lost+found', 'x');
    for (const f of [orphan, notes, lost]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); age(f); }
    const dryRetention = await runRetention({ dryRun: true });
    const afterDry = [firstFile, orphan, notes, lost].map((f) => fs.existsSync(f));
    const retention = await runRetention({ dryRun: false });
    const afterRetention = { first: fs.existsSync(firstFile), orphan: fs.existsSync(orphan), notes: fs.existsSync(notes), lost: fs.existsSync(lost), second: fs.existsSync(rawFilePath((await db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(second.rawId)).file)) };
    // erased with the home
    const homeFiles = (await db.prepare('SELECT file FROM raw_payload WHERE site_id = ?').all(site.id)).map((r) => rawFilePath(r.file));
    const before = homeFiles.map((f) => fs.existsSync(f));
    const own = () => db.prepare('SELECT (SELECT COUNT(*) FROM raw_check_run WHERE site_id = ?) + (SELECT COUNT(*) FROM raw_payload_check WHERE site_id = ?) AS n').get(site.id, site.id).then((x) => Number(x.n));
    const recordsBefore = await own();
    const deleted = await deleteHome({ role: 'admin', id: 1 }, site, { confirm: site.name });
    const afterDelete = homeFiles.map((f) => fs.existsSync(f));
    const recordsAfter = await own();
    console.log(JSON.stringify({ files, text, viewed: [viewed.meta.file_found, viewed.body], sealedMagic, checked: report.checked, ok: report.ok, problems: report.problems, dry, dryMagic, applied, appliedMagic, dryRetention: { raw: dryRetention.raw.candidates, orphanFiles: dryRetention.orphanFiles }, afterDry, retention: { raw: retention.raw, orphanFiles: retention.orphanFiles }, afterRetention, before, afterDelete, deleted: deleted.files, recordsBefore, recordsAfter }));
    await erase({ kind: 'synthetic', reason: 'test: receipts of a child process in another raw store' }, async () => await db.prepare('DELETE FROM raw_payload WHERE id = ?').run(second.rawId));
    await closeDb();`;
  const env = { ...process.env, DATA_DIR: data, RAW_DIR: store };
  const run = (e) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: e, encoding: 'utf8', cwd: root });
  const out = run(env);
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(r.files.length, 2);
  for (const f of r.files) assert.ok(f.file.startsWith('raw/'), 'the stored name keeps its raw/ prefix');
  assert.ok(!fs.existsSync(path.join(data, 'raw')), 'nothing was written under DATA_DIR/raw');
  assert.deepEqual([r.text, r.sealedMagic, r.checked, r.ok, r.problems.length], ['{"secret":"home"}', 'EBRAW1', 2, 2, 0], 'written there, read back, sealed on disk, every file matches its hash');
  assert.deepEqual(r.viewed, [true, '{"secret":"[redacted]"}'], 'the explorer found and read the receipt in RAW_DIR (its secrets scrubbed)');
  assert.deepEqual([r.dry.sealed, r.dry.apply, r.dryMagic], [1, false, '{"old"'], 'the seal script found the plain file in RAW_DIR and a dry run left it');
  assert.deepEqual([r.applied.sealed, r.applied.apply, r.appliedMagic], [1, true, 'EBRAW1'], 'apply sealed it where it is');
  assert.deepEqual(r.dryRetention, { raw: 1, orphanFiles: { found: 1, bytes: 1, deleted: 0 } }, 'a dry run counts the old receipt and the orphan in the store layout, not the foreign files');
  assert.deepEqual(r.afterDry, [true, true, true, true], 'and removes nothing');
  assert.deepEqual([r.retention.raw.deleted, r.retention.raw.filesDeleted, r.retention.orphanFiles.deleted], [1, 1, 1]);
  assert.deepEqual(r.afterRetention, { first: false, orphan: false, notes: true, lost: true, second: true }, 'the old receipt and the orphan left RAW_DIR; files that are not the store\'s, and the newest answer, stayed');
  assert.deepEqual([r.before.every(Boolean), r.afterDelete.some(Boolean), r.deleted], [true, false, 3], 'deleting the home removed its three files from RAW_DIR');
  assert.ok(r.recordsBefore >= 3 && r.recordsAfter === 0, 'the home\'s check records (raw_check_run, raw_payload_check) left with it');
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
  assert.deepEqual([r.checked, r.ok, r.problems.length, r.unsealed, r.erased], [4, 4, 0, 0, 0]);
  const sizes = await Promise.all([sealed, pub, q, noHome].map(async (id) => fs.statSync(await fileOf(id)).size));
  assert.equal(r.bytes, sizes.reduce((a, b) => a + b, 0), 'the bytes read are the four files');
  assert.equal((await openRaw(await row(sealed))).state, 'ok');
  assert.equal(rawHash('sunsynk_5min', 'quarantined', '{"bad":1}'), (await row(q)).hash, 'the hash covers source, status and text');
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
  assert.equal(before.erased, 0);
  assert.equal(stateOf(r, keyLost), undefined, 'a sealed file whose home key is gone is erased, not a problem');
  assert.equal((await db.prepare('SELECT state FROM raw_payload_check WHERE payload_id = ?').get(keyLost)).state, 'erased');
  assert.ok(r.erased >= 3, 'every sealed file of home A, none of home B');
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

await test('a sealed file whose home key is gone is erased: it cannot be checked, and that is not a problem', async () => {
  const erasedBefore = (await verifyRaw()).erased;
  const id = await land(homeB.id);
  const p = await row(id);
  // the shape delete-home leaves for a receipt kept as shared evidence: no home, a file sealed with a key that no longer exists
  const copy = 'raw/sunsynk_5min/erased/copy.json';
  fs.mkdirSync(path.dirname(rawFilePath(copy)), { recursive: true });
  fs.copyFileSync(rawFilePath(p.file), rawFilePath(copy));
  const sourceId = p.source_id;
  await db.prepare('INSERT INTO raw_payload (source_id, site_id, request, fetched_at, hash, file, status) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(sourceId, '{}', NOW, 'erased-home-hash', copy, 'accepted');
  const r = await verifyRaw();
  assert.equal(r.erased - erasedBefore, 1);
  assert.ok(!r.problems.some((x) => x.file === copy));
  assert.equal((await db.prepare('SELECT state FROM raw_payload_check WHERE payload_id = (SELECT id FROM raw_payload WHERE file = ?)').get(copy)).state, 'erased');
  assert.match(rawCheckSummary(r), new RegExp(`${r.erased} sealed files of erased homes cannot be checked`));
  assert.equal(await readRaw({ file: copy, site_id: null }), null);
});

const checkedSince = async (t) => (await db.prepare('SELECT payload_id FROM raw_payload_check WHERE checked_at >= ? ORDER BY payload_id').all(t)).map((x) => x.payload_id);

await test('the rolling check takes the N least recently checked receipts, never-checked first, and records each run', async () => {
  const ids = (await db.prepare('SELECT id FROM raw_payload ORDER BY id').all()).map((x) => x.id);
  assert.ok(ids.length >= 8);
  await verifyRaw();   // everything has a state now
  await db.prepare('UPDATE raw_payload_check SET checked_at = 1000 + payload_id').run();   // the order they were last checked in: by id
  const env = { RAW_VERIFY_BATCH: '3' };
  const runs = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM raw_check_run').get()).n);
  const before = await runs();
  const homeRowsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM raw_check_run WHERE site_id IS NOT NULL').get()).n;
  const one = await runRawCheck({ env, trigger: 'timer' });
  assert.deepEqual([one.checked, one.scope.limit], [3, 3]);
  assert.deepEqual(await checkedSince(1_000_000_000), ids.slice(0, 3), 'the three checked longest ago');
  await runRawCheck({ env });
  assert.deepEqual(await checkedSince(1_000_000_000), ids.slice(0, 6), 'the next run takes the next three, not the same ones');
  // a receipt that landed after the last run has never been checked: it goes first, whatever the others' age
  const fresh = await land(homeA.id, 'open_meteo');
  await runRawCheck({ env: { RAW_VERIFY_BATCH: '1' } });
  assert.ok((await checkedSince(1_000_000_000)).includes(fresh), 'never-checked first');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM raw_payload_check WHERE checked_at >= 1000000000').get()).n, 7);
  // the log: a row per run for the store, a row per home in it
  assert.equal(await runs() - before, 3 + (await db.prepare('SELECT COUNT(*) AS n FROM raw_check_run WHERE site_id IS NOT NULL').get()).n - homeRowsBefore, 'a store row per run, a home row per home in it');
  const last = await db.prepare("SELECT * FROM raw_check_run WHERE site_id IS NULL ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([last.checked, last.trigger], [1, 'timer']);
  const homeRow = await db.prepare('SELECT * FROM raw_check_run WHERE site_id IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([homeRow.site_id, homeRow.checked, homeRow.ran_at], [homeA.id, 1, last.ran_at], 'the home that had the receipt');
  // a run that overlaps one still going is skipped
  const [a, b] = await Promise.all([runRawCheck({ env }), runRawCheck({ env })]);
  assert.deepEqual([a == null, b == null].sort(), [false, true]);
  // one home only
  const onlyB = await verifyRaw({ siteId: homeB.id, limit: 2 });
  assert.equal(onlyB.checked, 2);
  assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM raw_payload_check c WHERE c.site_id = ? AND c.checked_at >= 1000000000').get(homeB.id)).n >= 2);
  await assert.rejects(async () => await verifyRaw({ limit: 0 }), /limit is/);
});

await test('a receipt\'s recorded state is one of the known states', async () => {
  await assert.rejects(async () => await db.prepare("UPDATE raw_payload_check SET state = 'fine' WHERE payload_id = (SELECT MIN(payload_id) FROM raw_payload_check)").run(), /CHECK constraint failed: raw_payload_check_state_check/);
  await assert.rejects(async () => await db.prepare("INSERT INTO raw_check_run (ran_at, trigger, checked, ok, mismatch, corrupt, missing, unreadable, erased, unsealed, bytes, ms) VALUES (1, 'whim', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)").run(), /CHECK constraint failed/);
});

await test('health shows the latest known state of a home\'s files, which stays until a later check finds them fine', async () => {
  const solo = await createSite({ name: 'Raw health' });
  const good = await land(solo.id);
  const bad = await land(solo.id);
  const get = async () => await (await fetch(`${base}/api/sites/${solo.id}/health`)).json();
  assert.equal((await get()).rawCheck, null, 'no check has covered this home yet');
  await verifyRaw({ siteId: solo.id });
  let h = (await get()).rawCheck;
  assert.deepEqual([h.problems, h.receipts, h.covered, h.checkedInRun, h.trigger], [0, 2, 2, 2, 'cli']);
  // damage a file: the check finds it, and later runs that take other receipts do not make the problem disappear
  const copy = fs.readFileSync(await fileOf(bad));
  fs.truncateSync(await fileOf(bad), 20);
  await verifyRaw({ siteId: solo.id });
  h = (await get()).rawCheck;
  assert.equal(h.problems, 1);
  assert.deepEqual(h.problemList.map((p) => [p.id, p.source, p.state]), [[bad, 'sunsynk_5min', 'corrupt']]);
  await verifyRaw({ siteId: homeB.id, limit: 3 });   // another home's run
  await verifyRaw({ siteId: solo.id, limit: 1 });     // a run of this home that takes one other receipt (the damaged one was checked last)
  h = (await get()).rawCheck;
  assert.deepEqual([h.problems, h.problemList.map((p) => p.id), h.checkedInRun], [1, [bad], 1], 'the problem stays until a later check finds the file fine');
  fs.writeFileSync(await fileOf(bad), copy);
  await verifyRaw({ siteId: solo.id });
  h = (await get()).rawCheck;
  assert.deepEqual([h.problems, h.problemList.length, await row(good).then((x) => !!x)], [0, 0, true]);
  assert.equal((await fetch(`${base}/api/sites/999999/health`)).status, 404);
});

await test('npm run raw:verify: validates its arguments, records the run, exits 1 on a problem', async () => {
  const cli = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'scripts/verify-raw.js'), ...args], { env: process.env, encoding: 'utf8', cwd: root });
  for (const bad of [['--limit', 'abc'], ['--limit', '0'], ['--site', 'x'], ['--site=x'], ['--limit=1.5'], ['--limit=']]) {
    const r = cli(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /takes a whole number/);
    assert.equal(r.stdout, '', 'nothing was checked');
  }
  for (const bad of [['--limt', '10'], ['--site5'], ['5'], ['--site', '1', '--site', '2'], ['--limit']]) {
    const r = cli(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /unknown argument|given twice|needs a value/);
    assert.equal(r.stdout, '', 'a mistyped scope checks nothing instead of the whole store');
  }
  const home = await createSite({ name: 'Raw cli' });
  const id = await land(home.id);
  const clean = cli(`--site=${home.id}`);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /1 receipts.*no problems/);
  assert.equal((await db.prepare('SELECT trigger FROM raw_check_run WHERE site_id = ?').get(home.id)).trigger, 'cli');
  fs.truncateSync(await fileOf(id), 20);
  const bad = cli('--site', String(home.id), '--limit', '5');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /PROBLEMS 1: 0 changed, 1 corrupt/);
});

await test('settings', async () => {
  assert.deepEqual(rawVerifySettings({}), { mode: 'report', batch: 500, hours: 6 });
  assert.deepEqual(rawVerifySettings({ RAW_VERIFY: 'off', RAW_VERIFY_BATCH: '20', RAW_VERIFY_HOURS: '1' }), { mode: 'off', batch: 20, hours: 1 });
  assert.equal(rawVerifySettings({ RAW_VERIFY_HOURS: '596' }).hours, 596);
  assert.throws(() => rawVerifySettings({ RAW_VERIFY_HOURS: '597' }), /RAW_VERIFY_HOURS must be a whole number from 1 to 596/, 'a longer interval overflows the 32-bit timer and would re-run every millisecond');
  assert.throws(() => rawVerifySettings({ RAW_VERIFY: 'yes' }), /RAW_VERIFY must be one of off, report/);
  for (const bad of ['0', '1.5', 'x']) { assert.throws(() => rawVerifySettings({ RAW_VERIFY_BATCH: bad }), /RAW_VERIFY_BATCH/); assert.throws(() => rawVerifySettings({ RAW_VERIFY_HOURS: bad }), /RAW_VERIFY_HOURS/); }
  assert.equal(await runRawCheck({ env: { RAW_VERIFY: 'off' } }), null);
  assert.equal(rawCheckSummary(null), 'raw file check: off or already running');
  assert.deepEqual(Object.keys(await runMaintenance({ retention: 'off' })).filter((k) => !/^\d+$/.test(k)), [], 'maintenance no longer runs the check: the server starts it after it listens');
});

await test('a wrong RAW_VERIFY setting refuses the start before the server listens', () => {
  const script = `
    const { start } = await import(${JSON.stringify(path.join(root, 'src/server.js'))});
    try { await start(); console.log('STARTED'); } catch (err) { console.log('REFUSED ' + err.message); }
    process.exit(0);`;
  for (const [name, value] of [['RAW_VERIFY', 'yes'], ['RAW_VERIFY_BATCH', '0'], ['RAW_VERIFY_HOURS', '720']]) {
    const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, [name]: value, PORT: '48123' }, encoding: 'utf8', cwd: root });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout.trim().split('\n').pop(), new RegExp(`^REFUSED ${name} must be`), `${name}=${value}`);
    assert.doesNotMatch(out.stdout, /EnergieBee core prototype on/, 'the port was never opened');
  }
});

await test('landing: a lost file is written back when the same body lands again; a raw store that is gone is not recreated', async () => {
  const body = { lost: 'and found' };
  for (const [siteId, source] of [[homeA.id, 'sunsynk_5min'], [null, 'open_meteo']]) {
    const first = await landRaw({ source, siteId, request: {}, body });
    const file = rawFilePath((await row(first.rawId)).file);
    const hashBefore = rawHash(source, 'accepted', await readRaw(await row(first.rawId)));
    fs.rmSync(file);
    assert.equal((await verifyRaw({ limit: 1000 })).problems.find((p) => p.id === first.rawId)?.state, 'missing');
    const again = await landRaw({ source, siteId, request: {}, body });
    assert.deepEqual([again.rawId, again.duplicate, fs.existsSync(file)], [first.rawId, true, true], 'same receipt, file back');
    assert.equal(rawHash(source, 'accepted', await readRaw(await row(first.rawId))), hashBefore, 'with the same text');
    assert.equal(fs.readFileSync(file).subarray(0, 6).toString() === 'EBRAW1', siteId != null, 'sealed when it is a home\'s');
    assert.ok(!(await verifyRaw({ limit: 1000 })).problems.some((p) => p.id === first.rawId), 'and the next check finds it fine');
  }
  // the store itself vanishes while the process runs: landing fails and creates nothing
  const gone = `${rawDir}.detached`;
  fs.renameSync(rawDir, gone);
  try {
    await assert.rejects(async () => await landRaw({ source: 'open_meteo', siteId: null, request: {}, body: { while: 'detached' } }), /the raw store .* is not there/);
    assert.ok(!fs.existsSync(rawDir), 'RAW_DIR was not created again');
  } finally { fs.renameSync(gone, rawDir); }
});

await test('the check skips the names a fixture redacted, and counts them nowhere', async () => {
  const solo = await createSite({ name: 'Raw redacted' });
  const id = await land(solo.id);
  await erase({ kind: 'synthetic', reason: 'test: a fixture-style file name' }, async () => await db.prepare("UPDATE raw_payload SET file = 'redacted-' || id WHERE id = ?").run(id));
  const r = await verifyRaw({ siteId: solo.id });
  assert.deepEqual([r.checked, r.missing, r.problems.length], [0, 0, 0]);
  assert.equal((await verifyRaw({ siteId: solo.id, limit: 5 })).checked, 0);
  assert.equal(await db.prepare('SELECT 1 FROM raw_payload_check WHERE payload_id = ?').get(id), undefined);
  // a name outside the store that is not the fixture's is a finding
  await erase({ kind: 'synthetic', reason: 'test: a name outside the store' }, async () => await db.prepare("UPDATE raw_payload SET file = '../escape.json' WHERE id = ?").run(id));
  assert.equal((await verifyRaw({ siteId: solo.id })).problems[0]?.state, 'missing');
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
  const half = path.join(rawDir, 'sunsynk_5min', '2026-11-18', 'half-written.json.1234.tmp');
  fs.mkdirSync(path.dirname(half), { recursive: true });
  fs.writeFileSync(half, 'partial');
  fs.utimesSync(half, NOW - 30 * DAY, NOW - 30 * DAY);

  const doomedFiles = [await fileOf(free[0]), await fileOf(free[1]), await fileOf(freeSealed)];
  assert.ok(doomedFiles.every((f) => fs.existsSync(f)));
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
  assert.deepEqual(doomedFiles.map((f) => fs.existsSync(f)), [false, false, false], 'the files of the deleted receipts are gone from disk');
  assert.equal(fs.existsSync(half), false, 'a half-written temporary file is an orphan');
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
  const ids = [await land(homeA.id, 'open_meteo'), await land(homeA.id, 'open_meteo'), await land(homeA.id, 'open_meteo')];   // the newest of the endpoint stays
  for (const id of ids) await erase({ kind: 'synthetic', reason: 'test: a receipt aged' }, async () => await db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(NOW - 30 * DAY, id));
  const files = await Promise.all(ids.map(fileOf));
  const log = await logCount();
  // the second delete of the run fails (a trigger that only this test creates)
  await db.exec(`CREATE FUNCTION test_fail_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
    CREATE TRIGGER test_fail_retention BEFORE DELETE ON raw_payload FOR EACH ROW WHEN (OLD.id = ${ids[1]}) EXECUTE FUNCTION test_fail_retention()`);
  try {
    const dry = await runRetention({ now: NOW });
    assert.ok(dry.raw.candidates >= 2, 'the aged receipts are candidates');
    await assert.rejects(async () => await runRetention({ now: NOW, dryRun: false }), /boom/);
    for (const id of ids) assert.ok(await row(id), `payload ${id} stays`);
    assert.ok(files.every((f) => fs.existsSync(f)), 'no file was removed');
    assert.equal(await logCount(), log, 'no log row without its deletes, no deletes without their log row');
    assert.equal(await db.prepare("SELECT current_setting('energiebee.erasure', true) AS v").get().then((x) => x.v || ''), '', 'the erasure is not left open');
  } finally {
    await db.exec('DROP TRIGGER test_fail_retention ON raw_payload; DROP FUNCTION test_fail_retention()');
  }
  assert.ok((await runRetention({ now: NOW, dryRun: false })).raw.deleted >= 2, 'without the failure the same run goes through');
  assert.equal(await row(ids[1]), undefined);
});
