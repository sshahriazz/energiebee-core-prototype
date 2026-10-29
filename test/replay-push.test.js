// Replay of pushed receipts (core/push-ingest.js lands each body as a receipt with its format and device in the request): a point
// nobody mapped is refused at first as unmapped; after a channel is added, replay recovers it from the saved body. Guarded: it
// needs push-formats.js and the push sources, which another piece of work provides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const R = hasLive ? await import('../src/core/replay.js') : {};
const { landRaw } = hasLive ? await import('../src/core/facts.js') : {};
const { ingestObservations, defineChannel } = hasLive ? await import('../src/core/channels.js') : {};
const available = hasLive && (await R.pushReplayAvailable()) && Boolean(db.prepare("SELECT 1 FROM source WHERE code = 'push_native'").get());
const skip = available ? false : 'push-formats.js or the push sources are not available';

const SITE = 1;
const T = 1781049600;
const text = JSON.stringify({ observations: [{ point: 'ambient', ts: T, value: 18.5 }, { point: 'ambient', ts: T + 300, value: 19 }, { kind: 'ack', commandId: 1, ref: 'r1', ts: T }] });
const facts = () => db.prepare(`SELECT r.ts, r.value, r.raw_id FROM reading r JOIN series s ON s.id = r.series_id JOIN source so ON so.id = s.source_id JOIN metric m ON m.id = s.metric_id
  WHERE so.code = 'push_native' AND m.code = 'outdoor_temp_c' AND s.subject_kind = 'site' AND s.subject_id = ? ORDER BY r.ts`).all(String(SITE));
let rawId;

test('a point nobody mapped is refused as unmapped, then recovered from the saved body after a channel is added', { skip }, async () => {
  rawId = landRaw({ source: 'push_native', siteId: SITE, request: { path: '/api/ingest', format: 'native', device: null }, body: text }).rawId;
  const first = ingestObservations(SITE, 'push_native', [{ point: 'ambient', ts: T, value: 18.5 }, { point: 'ambient', ts: T + 300, value: 19 }], rawId);
  assert.deepEqual(first.unmapped, ['ambient']);
  assert.deepEqual(facts(), []);

  const still = await R.replay(SITE, { source: 'push_native', days: 30 });
  assert.deepEqual([still.receipts, still.written], [1, 0]);
  assert.deepEqual(still.unmapped, [{ source: 'push_native', point: 'ambient' }], 'still nobody maps it');

  defineChannel(SITE, 'push_native', 'ambient', 'outdoor_temp_c');
  const dry = await R.replay(SITE, { source: 'push_native', days: 30 });
  assert.deepEqual([dry.written, dry.unmapped.length], [2, 0]);
  assert.deepEqual(facts(), [], 'a dry run keeps nothing');
  const real = await R.replay(SITE, { source: 'push_native', days: 30, dryRun: false });
  assert.equal(real.written, 2);
  assert.deepEqual(facts().map((r) => [r.ts, r.value, r.raw_id]), [[T, 18.5, rawId], [T + 300, 19, rawId]]);
  assert.equal((await R.replay(SITE, { source: 'push_native', days: 30, dryRun: false })).written, 0, 'idempotent');
});

test('an ack in a saved body is never replayed (a receipt of a command is not a fact), and a receipt naming a device the home does not have is counted', { skip }, async () => {
  assert.equal(db.prepare("SELECT COUNT(*) n FROM command_log WHERE detail LIKE '%r1%'").get().n, 0, 'no ack was recorded by the replays above');
  landRaw({ source: 'push_native', siteId: SITE, request: { path: '/api/ingest', format: 'native', device: 'no-such-device' }, body: JSON.stringify({ observations: [{ point: 'ambient', ts: T + 900, value: 20 }] }) });
  const r = await R.replay(SITE, { source: 'push_native', days: 30 });
  assert.equal(r.deviceMissing, 1);
});
