// Retention for receipts and refusals (src/core/maintenance.js): channel_reject and push_log older than RECEIPT_RETENTION_DAYS
// (default 90) are removed, replayable raw receipts that no fact refers to are kept until then instead of 14 days, nothing a fact
// reads is deleted, and a dry run counts without deleting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { landRaw, seriesId, putReadings } = await import('../src/core/facts.js');
const M = await import('../src/core/maintenance.js');

const NOW = 1800000000;
const DAY = 86400;
const site = Number(db.prepare("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Home', 1, 'GB', 'GB', 'GBP')").run().lastInsertRowid);
const age = (rawId, days) => db.prepare('UPDATE raw_payload SET fetched_at = ? WHERE id = ?').run(NOW - days * DAY, rawId);
const has = (id) => Boolean(db.prepare('SELECT 1 FROM raw_payload WHERE id = ?').get(id));
let n = 0;
// Receipts of one source share an endpoint path (the query differs), as real ones do: only the newest of an endpoint is kept by that rule.
const land = (source) => landRaw({ source, siteId: site, request: { url: `https://api.example/${source}/endpoint?n=${++n}` }, body: { n } }).rawId;
const srcId = (code) => db.prepare('SELECT id FROM source WHERE code = ?').get(code).id;

test('RECEIPT_RETENTION_DAYS: default 90, an environment value, and refusals', () => {
  assert.equal(M.receiptRetentionDays({}), 90);
  assert.equal(M.receiptRetentionDays({ RECEIPT_RETENTION_DAYS: '30' }), 30);
  assert.throws(() => M.receiptRetentionDays({ RECEIPT_RETENTION_DAYS: 'x' }), /RECEIPT_RETENTION_DAYS/);
  assert.throws(() => M.receiptRetentionDays({ RECEIPT_RETENTION_DAYS: '0' }), /RECEIPT_RETENTION_DAYS/);
  assert.equal(M.retentionSettings({}).rawDays, 14, 'the existing settings are unchanged');
});

test('a replayable receipt no fact refers to is kept past the 14-day raw rule until the receipt window; others go as before', () => {
  const replayable60 = land('sunsynk_5min'); age(replayable60, 60);       // between 14 and 90 days: kept for replay
  const replayable120 = land('sunsynk_5min'); age(replayable120, 120);    // beyond the receipt window: a candidate
  const plain60 = land('open_meteo'); age(plain60, 60);                    // not replayable: a candidate at 14 days
  const freshReplayable = land('sunsynk_5min'); age(freshReplayable, 1);   // the newest of its endpoint: kept by the existing rule, so it is not counted below
  const freshPlain = land('open_meteo'); age(freshPlain, 1);
  const referenced = land('sunsynk_5min'); age(referenced, 200);           // a fact refers to it: kept as evidence
  putReadings(seriesId('site', site, 'solar_w', 'sunsynk_5min'), [{ ts: 1000, value: 1, rawId: referenced }], referenced);

  const dry = M.runRetention({ now: NOW });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.settings.receiptDays, 90);
  assert.equal(dry.raw.keptReplayable, 1, 'only the 60-day replayable one');
  assert.equal(dry.raw.candidates, 2, 'the 120-day replayable one and the 60-day open_meteo one');
  for (const id of [replayable60, replayable120, plain60, freshReplayable, freshPlain, referenced]) assert.ok(has(id), 'a dry run deletes nothing');

  const done = M.runRetention({ now: NOW, dryRun: false });
  assert.ok(has(replayable60), 'kept for replay');
  assert.ok(has(referenced), 'kept: a fact refers to it');
  assert.equal(has(replayable120), false);
  assert.equal(has(plain60), false);
  assert.equal(done.raw.keptReplayable, 1);
  // a shorter receipt window releases the 60-day one
  M.runRetention({ now: NOW, dryRun: false, receiptDays: 30 });
  assert.equal(has(replayable60), false, 'older than a 30-day receipt window');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading').get().n, 1, 'no fact was deleted');
});

test('channel_reject and push_log: rows older than the receipt window are counted, then deleted on apply; newer ones stay', () => {
  const ins = db.prepare('INSERT INTO channel_reject (site_id, source_id, point, ts, value, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const s = srcId('sunsynk_5min');
  for (let i = 0; i < 3; i++) ins.run(site, s, 'PV', 1, 1, 'out_of_range', (NOW - 100 * DAY) * 1000);
  for (let i = 0; i < 2; i++) ins.run(site, s, 'PV', 1, 1, 'out_of_range', (NOW - 10 * DAY) * 1000);
  const hasPush = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'push_log'").get();
  if (hasPush) {
    const p = db.prepare("INSERT INTO push_log (site_id, source, format, received_at, status) VALUES (?, 'push_native', 'native', ?, 'ok')");
    p.run(site, (NOW - 120 * DAY) * 1000); p.run(site, (NOW - 120 * DAY) * 1000); p.run(site, (NOW - 5 * DAY) * 1000);
  }
  const dry = M.runRetention({ now: NOW });
  assert.equal(dry.channelReject.candidates, 3);
  assert.equal(dry.pushLog.present, Boolean(hasPush));
  if (hasPush) assert.equal(dry.pushLog.candidates, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM channel_reject').get().n, 5, 'a dry run deletes nothing');
  const done = M.runRetention({ now: NOW, dryRun: false });
  assert.equal(done.channelReject.deleted, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM channel_reject').get().n, 2);
  if (hasPush) { assert.equal(done.pushLog.deleted, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM push_log').get().n, 1); }
  assert.equal(M.runRetention({ now: NOW, dryRun: false }).channelReject.deleted, 0, 'idempotent');
});

test('the summary line mentions refusal rows and receipts kept for replay, and the existing parts are still there', () => {
  const line = M.retentionSummary(M.runRetention({ now: NOW }));
  assert.match(line, /raw payloads/);
  assert.match(line, /old refusal rows/);
  assert.match(line, /receipts kept for replay/);
});
