// After an outage, each provider's fetch reaches back to its last successful sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { resumeDate } = await import('../src/jobs/sync.js');
const { dayBounds } = await import('../src/core/time.js');

const tz = 'Europe/London';
const today = '2026-10-16';
db.prepare("INSERT INTO site (id, name, created_at) VALUES (1, 'test', 0)").run();
const lastSuccess = (date) => db.prepare(`INSERT INTO connection (site_id, provider, last_success_at) VALUES (1, 'sunsynk', ?)
  ON CONFLICT(site_id, provider) DO UPDATE SET last_success_at = excluded.last_success_at`).run(date ? dayBounds(tz, date)[0] + 12 * 3600 : null);
const resume = () => resumeDate(1, 'sunsynk', tz, today, '2026-10-15', 1, 89);

test('normal running: the short look-back', () => {
  lastSuccess('2026-10-16');
  assert.equal(resume(), '2026-10-15');
});

test('never synced: the short look-back (the first run has its own window)', () => {
  lastSuccess(null);
  assert.equal(resume(), '2026-10-15');
});

test('down for 10 days: back to the last success, less the overlap', () => {
  lastSuccess('2026-10-06');
  assert.equal(resume(), '2026-10-05');
});

test('down longer than the provider keeps data: only as far as it keeps', () => {
  lastSuccess('2026-01-01');
  assert.equal(resume(), '2026-07-19');
});
