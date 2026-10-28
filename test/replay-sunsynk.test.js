// Replay (src/core/replay.js) on Sunsynk receipts built with the adapter's own functions on a copy of the frozen real GB home:
// a mapping deliberately wrong (the PV channel allows at most 500 W) refuses its values at first; after the mapping is fixed, a dry run says what a replay would
// recover and keeps nothing, a real run recovers it, and a second run writes nothing. Quarantined bodies and receipts whose file
// is gone are never replayed; a source that cannot replay is refused with its reason. Also through the routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
if (hasLive) useDb({ snapshot: true });
const { db, dataDir } = hasLive ? await import('../src/db/db.js') : {};
const R = hasLive ? await import('../src/core/replay.js') : {};
const { landRaw, quarantine, seriesId } = hasLive ? await import('../src/core/facts.js') : {};
const { normaliseDay, normaliseMonth } = hasLive ? await import('../src/adapters/sunsynk.js') : {};
const { defineChannel } = hasLive ? await import('../src/core/channels.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const SITE = 1;
const DATE = '2026-06-10';   // a day the fixture has no data for
const dayUrl = (date) => `https://api.sunsynk.net/api/v1/plant/energy/777/day?date=${date}&id=777&lan=en`;
const body = () => ({ code: 0, data: { infos: [
  { label: 'PV', records: ['10:00', '10:05', '10:10', '10:15'].map((time, i) => ({ time, value: String(1000 + i * 100) })) },
  { label: 'Load', records: ['10:00', '10:05', '10:10', '10:15'].map((time) => ({ time, value: '400' })) },
  { label: 'Grid', records: ['10:00', '10:05', '10:10', '10:15'].map((time, i) => ({ time, value: String(i % 2 ? -300 : 200) })) }] } });
const post = async (p, b) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const facts = (metric, source = 'sunsynk_5min') => db.prepare(`SELECT r.ts, r.value, r.raw_id FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
  WHERE so.code = ? AND m.code = ? AND s.subject_kind = 'site' AND s.subject_id = ? AND r.ts >= 1781000000 AND r.ts < 1781200000 AND r.superseded_at IS NULL ORDER BY r.ts`).all(source, metric, String(SITE));   // 10 June 2026 only: the fixture's own data is in October
const nRejects = () => db.prepare('SELECT COUNT(*) n FROM channel_reject').get().n;
const nLog = () => db.prepare('SELECT COUNT(*) n FROM replay_log').get().n;
let rawId;

test('setup: the receipt is read once with a wrong PV mapping (at most 500 W), so solar is refused and everything else is stored', { skip }, () => {
  defineChannel(SITE, 'sunsynk_5min', 'PV', 'solar_w', { part: 'positive', max: 500 });
  const b = body();
  rawId = landRaw({ source: 'sunsynk_5min', siteId: SITE, request: { url: dayUrl(DATE) }, body: b }).rawId;
  const out = normaliseDay(SITE, 'Europe/London', DATE, b, rawId);
  assert.ok(out.facts > 0);
  assert.deepEqual(facts('solar_w'), [], 'every PV value is above 500 W: nothing stored for it');
  assert.equal(facts('load_w').length, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM channel_reject WHERE point = 'PV' AND reason = 'out_of_range'").get().n, 4, 'the refusals are recorded');
});

test('candidates: the source that has refusals, how many receipts a replay could read, and the run history', { skip }, async () => {
  const c = R.replayCandidates(SITE, { days: 30 });
  const s = c.sources.find((x) => x.source === 'sunsynk_5min');
  assert.ok(s.refused >= 4 && s.canReplay && s.receipts >= 1 && s.why === null);
  assert.equal(c.total, c.sources.reduce((t, x) => t + x.receipts, 0));
  assert.deepEqual(c.lastRuns, []);
  const api = await get(`/api/sites/${SITE}/replay?days=30`);
  assert.equal(api.status, 200);
  assert.ok(api.body.sources.some((x) => x.source === 'sunsynk_5min' && x.receipts >= 1));
});

test('a dry run with the mapping still wrong: it writes nothing new, reports PV as still refused, and keeps nothing', { skip }, async () => {
  const rejects = nRejects();
  const dry = await R.replay(SITE, { source: 'sunsynk_5min', days: 30 });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.receipts >= 1, true);
  assert.equal(dry.written, 0, 'the other points were already stored (change-only)');
  assert.deepEqual(dry.stillRejected, [{ source: 'sunsynk_5min', point: 'PV', reason: 'out_of_range', count: 4 }]);
  assert.equal(dry.rejected, 4);
  assert.equal(nRejects(), rejects, 'a dry run adds no refusal rows');
  assert.equal(nLog(), 0, 'and no log row');
});

test('after the mapping is fixed: a dry run says what would be recovered and keeps nothing; the real run recovers it with its receipt; the second run writes nothing', { skip }, async () => {
  defineChannel(SITE, 'sunsynk_5min', 'PV', 'solar_w', { part: 'positive' });   // the range fixed
  const rejects = nRejects();
  const dry = await R.replay(SITE, { source: 'sunsynk_5min', days: 30 });
  assert.deepEqual([dry.dryRun, dry.written, dry.rejected, dry.parseErrors], [true, 4, 0, 0], 'four solar readings would be recovered');
  assert.deepEqual(dry.stillRejected, []);
  assert.deepEqual(facts('solar_w'), [], 'a dry run keeps nothing');
  assert.equal(nLog(), 0);

  const real = await R.replay(SITE, { source: 'sunsynk_5min', days: 30, dryRun: false });
  assert.deepEqual([real.dryRun, real.written, real.rejected], [false, 4, 0]);
  assert.ok(real.logId > 0);
  const solar = facts('solar_w');
  assert.deepEqual(solar.map((r) => r.value), [1000, 1100, 1200, 1300]);
  assert.ok(solar.every((r) => r.raw_id === rawId), 'each recovered fact carries the receipt it came from');
  assert.equal(nRejects(), rejects, 'replay adds no refusal rows');
  const log = db.prepare('SELECT * FROM replay_log WHERE id = ?').get(real.logId);
  assert.deepEqual([log.site_id, log.source, log.written, log.rejected, log.unmapped], [SITE, 'sunsynk_5min', 4, 0, 0]);
  assert.equal(nRejects(), rejects, 'the earlier refusal rows are left as the record of what happened');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM rebuild_queue WHERE site_id = ?').get(SITE).n >= 1, 'the recovered days are queued for a rebuild');

  const again = await R.replay(SITE, { source: 'sunsynk_5min', days: 30, dryRun: false });
  assert.equal(again.written, 0, 'idempotent: facts are change-only');
  assert.equal(facts('solar_w').length, 4);
  assert.equal(R.lastRuns(SITE).length, 2);
});

test('a corrected value is a new version, not a duplicate: replaying after the channel scale changes', { skip }, async () => {
  defineChannel(SITE, 'sunsynk_5min', 'PV', 'solar_w', { part: 'positive', scale: 0.5 });
  const real = await R.replay(SITE, { source: 'sunsynk_5min', days: 30, dryRun: false });
  assert.equal(real.written, 4);
  assert.deepEqual(facts('solar_w').map((r) => r.value), [500, 550, 600, 650]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reading r JOIN series s ON s.id = r.series_id JOIN metric m ON m.id = s.metric_id WHERE m.code = 'solar_w' AND r.ts >= 1781000000 AND r.ts < 1781200000 AND r.superseded_at IS NOT NULL").get().n, 4, 'the first versions are kept, superseded');
  defineChannel(SITE, 'sunsynk_5min', 'PV', 'solar_w', { part: 'positive' });
});

test('daily totals and the realtime flow replay too, with the date from the receipt\'s request and the time from its fetch time', { skip }, async () => {
  const month = { code: 0, data: { infos: [{ label: 'PV Generation', records: [{ time: '2026-06-10', value: '12.5' }] }] } };
  landRaw({ source: 'sunsynk_daily', siteId: SITE, request: { url: 'https://api.sunsynk.net/api/v1/plant/energy/777/month?date=2026-06&id=777&lan=en' }, body: month });
  const flow = { code: 0, data: { pv: [{ power: 700 }], gridOrMeterPower: -250, battPower: 100, loadOrEpsPower: 450, soc: 61 } };
  const live = landRaw({ source: 'sunsynk_live', siteId: SITE, request: { url: 'https://api.sunsynk.net/api/v1/inverter/SN1/flow' }, body: flow }).rawId;
  // other sunsynk_live receipts (the plant record) are not flows and are skipped
  landRaw({ source: 'sunsynk_live', siteId: SITE, request: { url: 'https://api.sunsynk.net/api/v1/plant/777?id=777&lan=en' }, body: { code: 0, data: { name: 'x' } } });
  const real = await R.replay(SITE, { days: 30, dryRun: false });
  assert.ok(real.bySource.sunsynk_daily.written >= 1);
  const at = db.prepare('SELECT fetched_at FROM raw_payload WHERE id = ?').get(live).fetched_at;
  const liveSolar = db.prepare(`SELECT r.ts, r.value FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = 'sunsynk_live' AND m.code = 'solar_w' AND r.raw_id = ?`).get(live);
  assert.deepEqual([liveSolar.ts, liveSolar.value], [at - (at % 300), 700]);
  const daily = db.prepare(`SELECT f.value FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE so.code = 'sunsynk_daily' AND m.code = 'solar_kwh' AND f.start_ts >= 1781000000 AND f.start_ts < 1781200000 AND f.superseded_at IS NULL`).all();
  assert.deepEqual(daily.map((x) => x.value), [12.5]);
  assert.equal(real.bySource.sunsynk_live.receipts, 1, 'only the flow receipt, not the plant record');
  void normaliseMonth; void seriesId;
});

test('quarantined bodies are never replayed, and a receipt whose file is gone is counted, not an error', { skip }, async () => {
  const q = quarantine({ source: 'sunsynk_5min', siteId: SITE, request: { url: dayUrl('2026-06-11') }, body: body(), reason: 'unexpected shape' }).rawId;
  const before = (await R.replay(SITE, { source: 'sunsynk_5min', days: 30 })).receipts;
  assert.equal((await R.replay(SITE, { source: 'sunsynk_5min', days: 30, ids: [q] })).receipts, 0, 'asking for it by id does not replay it');
  const other = body(); other.data.infos[1].records[0].value = '555';   // a different body: identical bodies are one receipt
  const gone = landRaw({ source: 'sunsynk_5min', siteId: SITE, request: { url: dayUrl('2026-06-12') }, body: other }).rawId;
  fs.rmSync(path.join(dataDir, db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(gone).file));
  const r = await R.replay(SITE, { source: 'sunsynk_5min', days: 30, ids: [gone] });
  assert.deepEqual([r.receipts, r.missingFiles, r.written, r.parseErrors], [1, 1, 0, 0]);
  assert.equal((await R.replay(SITE, { source: 'sunsynk_5min', days: 30 })).receipts, before + 1, 'the quarantined one is still not among them');
});

test('a body that is not the expected shape is a parse error: kept, never turned into facts', { skip }, async () => {
  const odd = landRaw({ source: 'sunsynk_5min', siteId: SITE, request: { url: dayUrl('2026-06-13') }, body: { code: 0, data: { nothing: true } } }).rawId;
  const r = await R.replay(SITE, { source: 'sunsynk_5min', days: 30, ids: [odd], dryRun: false });
  assert.deepEqual([r.receipts, r.parseErrors, r.written], [1, 1, 0]);
});

test('sources that cannot replay are refused with their reason; the routes default to a dry run', { skip }, async () => {
  await assert.rejects(R.replay(SITE, { source: 'octopus_meter' }), (e) => e.code === 'not_replayable' && /the meter, its unit/i.test(e.message));
  await assert.rejects(R.replay(SITE, { source: 'made_up' }), (e) => e.code === 'not_replayable');
  assert.equal((await post(`/api/sites/${SITE}/replay`, { source: 'octopus_meter' })).status, 400);
  assert.equal((await post(`/api/sites/${SITE}/replay`, { source: 'octopus_meter' })).body.code, 'not_replayable');
  assert.equal((await post('/api/sites/999/replay', {})).status, 404);
  assert.equal((await post(`/api/sites/${SITE}/replay`, { days: -3 })).body.code, 'bad_number');
  const logs = nLog();
  const r = await post(`/api/sites/${SITE}/replay`, { source: 'sunsynk_5min' });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true, 'no dryRun in the body: a dry run');
  assert.equal(nLog(), logs);
  const real = await post(`/api/sites/${SITE}/replay`, { source: 'sunsynk_5min', dryRun: false });
  assert.equal(real.body.dryRun, false);
  assert.equal(nLog(), logs + 1);
  assert.ok(R.NOT_REPLAYABLE.octopus_meter && R.canReplay('sunsynk_live') && !R.canReplay('open_meteo') && R.whyNot('open_meteo').length > 10);
});
