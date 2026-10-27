// Octopus meter consumption goes through device channels: the meter's kind (and a gas meter's unit) picks the
// metric, the rows land per device under octopus_meter, a re-run writes nothing, a changed unit replaces the channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { normaliseConsumption } = await import('../src/adapters/octopus.js');
const { seriesId, readIntervals, landRaw } = await import('../src/core/facts.js');
const { channelsFor } = await import('../src/core/channels.js');

const site = Number(db.prepare("INSERT INTO site (name, created_at) VALUES ('octopus', 0)").run().lastInsertRowid);
const meter = (kind) => Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, ?, 'octopus', ?, ?, '{}', 0)").run(site, kind, `ref-${kind}`, kind).lastInsertRowid);
const rows = [
  { interval_start: '2026-06-10T00:00:00+01:00', interval_end: '2026-06-10T00:30:00+01:00', consumption: 0.25 },
  { interval_start: '2026-06-10T00:30:00+01:00', interval_end: '2026-06-10T01:00:00+01:00', consumption: 0.5 },
];

test('an electricity meter: rows stored per device, idempotent, with the raw receipt', () => {
  const dev = meter('meter_import');
  const { rawId } = landRaw({ source: 'octopus_meter', siteId: site, request: { url: 'test' }, body: { results: rows } });
  const withRaw = rows.map((r) => ({ ...r, _rawId: rawId }));
  assert.equal(normaliseConsumption(site, dev, 'grid_import_kwh', withRaw, rawId), 2);
  const got = readIntervals([seriesId('device', dev, 'grid_import_kwh', 'octopus_meter')], 0, 2e9);
  assert.deepEqual(got.map((r) => [r.start_ts, r.end_ts, r.value]), [[1781046000, 1781047800, 0.25], [1781047800, 1781049600, 0.5]]);
  assert.ok(got.every((r) => r.raw_id === rawId && r.quality === 1));
  assert.equal(normaliseConsumption(site, dev, 'grid_import_kwh', withRaw, rawId), 0, 'the same rows again write nothing');
});

test('a gas meter that turns out to read m3 replaces its channel, not adds a second', () => {
  const dev = meter('meter_gas');
  assert.equal(normaliseConsumption(site, dev, 'gas_kwh', rows, null), 2);
  assert.equal(normaliseConsumption(site, dev, 'gas_m3', rows, null), 2);
  const ch = channelsFor(site, 'octopus_meter', 'consumption', dev);
  assert.deepEqual(ch.map((c) => c.metric), ['gas_m3']);
  const history = db.prepare('SELECT COUNT(*) n FROM channel WHERE device_id = ?').get(dev).n;
  assert.equal(history, 2, 'the old channel is kept, superseded');
});
