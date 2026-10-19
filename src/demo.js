import express from 'express';
import { db } from './db/db.js';
import { dayBounds, localDate, nowSec, slotsOfDay } from './core/time.js';
import { defaultDay, validDate, sensorCoverage, dayView, ENERGY_CHECKS, POWER } from './core/demo.js';

export const demoRouter = express.Router();
const capture = Date.parse(process.env.DEMO_CAPTURED_AT || '');
const capturedAt =
  process.env.DEMO_OFFLINE === '1' && Number.isFinite(capture) ? Math.floor(capture / 1000) : null;
const presentationNow = () => capturedAt ?? nowSec();
function getSite(req) {
  const site = db.prepare('SELECT id, name, timezone FROM site WHERE id = ?').get(Number(req.params.id));
  if (!site) throw Object.assign(new Error('This home is not available.'), { status: 404 });
  return site;
}

demoRouter.get('/sites/:id/days', (req, res) => {
  const site = getSite(req);
  const days = db
    .prepare(
      'SELECT local_date, slots, slots_final, slots_provisional, slots_missing FROM site_day WHERE site_id = ? ORDER BY local_date DESC'
    )
    .all(site.id)
    .map((d) => ({ ...d, expectedSlots: slotsOfDay(site.timezone, d.local_date).length }));
  res.json({
    site,
    days,
    defaultDate: defaultDay(days, localDate(site.timezone, presentationNow())),
    capturedAt,
  });
});

demoRouter.get('/sites/:id/day', (req, res) => {
  const site = getSite(req);
  const date = req.query.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Choose a valid date in YYYY-MM-DD format.' });
  const stored = db
    .prepare('SELECT * FROM site_hh WHERE site_id = ? AND local_date = ? ORDER BY slot_start')
    .all(site.id, date);
  if (!stored.length)
    return res
      .status(404)
      .json({ error: 'There are no recorded half-hours for this day. Choose another recorded day.' });
  const [start, end] = dayBounds(site.timezone, date);
  const readings = db
    .prepare(
      `SELECT m.code AS metric, r.ts, r.value FROM reading r
    JOIN series s ON s.id = r.series_id JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'sunsynk_5min'
    AND r.superseded_at IS NULL AND r.ts >= ? AND r.ts < ? ORDER BY r.ts`
    )
    .all(String(site.id), start - 300, end + 300)
    .filter((r) => Object.values(POWER).includes(r.metric));
  const checks = db
    .prepare(
      'SELECT check_code, status, measured, tolerance, detail FROM check_result WHERE site_id = ? AND local_date = ? ORDER BY check_code'
    )
    .all(site.id, date)
    .filter((c) => ENERGY_CHECKS.has(c.check_code));
  const connections = db
    .prepare(
      "SELECT provider, status, last_success_at FROM connection WHERE site_id = ? AND provider IN ('sunsynk', 'octopus') ORDER BY provider"
    )
    .all(site.id);
  res.json({
    site,
    ...dayView(stored, sensorCoverage(readings), date, site.timezone, presentationNow()),
    capturedAt,
    checks,
    connections,
    revisions: db
      .prepare(
        'SELECT COUNT(*) AS count, MAX(revised_at) AS latest FROM site_day_revision WHERE site_id = ? AND local_date = ?'
      )
      .get(site.id, date),
  });
});
