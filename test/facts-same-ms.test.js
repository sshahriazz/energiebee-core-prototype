// Two versions of one reading (or interval) written in the same millisecond used to collide on the unique key
// (series, ts, recorded_at) and abort the write; the later version is now stamped one millisecond after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { seriesId, putReadings, putIntervals, readReadings } = await import('../src/core/facts.js');
db.prepare("INSERT INTO site (id, name, created_at) VALUES (1, 'ms', 0)").run();

test('a correction in the same millisecond is kept as the next version, not an error', () => {
  const realNow = Date.now; Date.now = () => 1900000000000;   // a frozen clock: every write is in the same millisecond
  try {
    const id = seriesId('site', 1, 'solar_w', 'sunsynk_5min');
    assert.equal(putReadings(id, [{ ts: 1000, value: 1 }]), 1);
    assert.equal(putReadings(id, [{ ts: 1000, value: 2 }]), 1, 'the same instant, a new value: written');
    assert.equal(putReadings(id, [{ ts: 1000, value: 3 }]), 1);
    const versions = db.prepare('SELECT value, recorded_at, superseded_at FROM reading WHERE series_id = ? AND ts = 1000 ORDER BY recorded_at').all(id);
    assert.deepEqual(versions.map((v) => v.value), [1, 2, 3]);
    assert.deepEqual(versions.map((v) => v.recorded_at), [1900000000000, 1900000000001, 1900000000002]);
    assert.equal(versions.filter((v) => v.superseded_at == null).length, 1, 'one current version');
    assert.equal(readReadings([id], 0, 2000)[0].value, 3);

    const iv = seriesId('site', 1, 'solar_kwh', 'sunsynk_daily');
    putIntervals(iv, [{ start: 0, end: 100, value: 1 }]);
    assert.equal(putIntervals(iv, [{ start: 0, end: 100, value: 2 }]), 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM interval_fact WHERE series_id = ? AND superseded_at IS NULL').get(iv).n, 1);
  } finally { Date.now = realNow; }
});
