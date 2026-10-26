// The GB battery home has no heating series, so the heating pass costs it one existence query and
// writes nothing (src/core/heat.js; processQueue in src/core/build.js). Run on a private copy of
// data/core.db: every statement prepared during a rebuild is recorded and inspected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no data/core.db (run the server once first)';
if (hasLive) useDb({ snapshot: true });
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { markDirty } = hasLive ? await import('../src/core/facts.js') : {};
const { processQueue } = hasLive ? await import('../src/core/build.js') : {};
const { hasHeatingSeries } = hasLive ? await import('../src/core/heat.js') : {};
const { dayBounds, localDate, addDays, nowSec } = hasLive ? await import('../src/core/time.js') : {};
const SITE = 1;

test('GB home: a rebuild runs one heating existence query, touches no heating table and returns no heat entry', { skip }, () => {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(SITE);
  const today = localDate(site.timezone, nowSec());
  db.prepare('DELETE FROM rebuild_queue').run();
  markDirty(SITE, dayBounds(site.timezone, addDays(today, -2))[0], nowSec(), 'test');
  const seen = [];
  const prepare = db.prepare;
  db.prepare = function (sql) { seen.push(sql); return prepare.call(this, sql); };
  let out;
  try { out = processQueue(); } finally { delete db.prepare; }
  assert.equal(db.prepare, prepare);
  const heating = seen.filter((s) => /domain = 'heating'|site_heat_slot|heating_telemetry/.test(s));
  assert.equal(heating.length, 1, 'only the existence check');
  assert.match(heating[0], /^SELECT 1 FROM series se JOIN metric m ON m.id = se.metric_id WHERE m.domain = 'heating'/);
  const mine = out.find((o) => o.siteId === SITE);
  assert.ok(mine && mine.slots > 0, 'the timeline was rebuilt');
  assert.equal('heat' in mine, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_heat_slot').get().n, 0);
});

test('GB home: the existence check is cheap (indexed: well under a millisecond)', { skip }, () => {
  assert.equal(hasHeatingSeries(SITE), false);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM series se JOIN metric m ON m.id = se.metric_id WHERE m.domain = 'heating'
    AND ((se.subject_kind = 'site' AND se.subject_id = ?) OR (se.subject_kind = 'device' AND se.subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))) LIMIT 1`)
    .all('1', 1).map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan, /SCAN se\b/, plan);
  const n = 2000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) hasHeatingSeries(SITE);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  assert.ok(ms < 0.5, `${ms.toFixed(4)} ms per check`);
});
