// GET /api/tariffs/:id/slots and GET /api/sites/:id/prices: a tariff as price slots and a home's price timeline (Phase T.7,
// src/core/tariff-slots.js). Mounted by one line in src/server.js. Every answer carries generated_at; bad input is 400 { error },
// an unknown tariff or home (or one the user may not see) 404 { error }. A time is epoch seconds or a local date (YYYY-MM-DD, the
// zone of the home, or of the tariff's market when no home is named).
//
//   GET /api/tariffs/:id/slots?from&to&slot_s&site
//        :id is the tariff's id or its code. Without site: the tariff's own market, the country's taxes, the shared runs. With site
//        (a home the user may see): that home's zone, taxes, own rows of the tariff and contracted capacity, at the home's slot length
//        unless slot_s says another (900, 1800, 3600). Default span: from today to the end of tomorrow.
//   GET /api/sites/:id/prices?from&to&point
//        the home's price slots per supply point (meter_import, meter_export, meter_gas, device:<id>) at its own slot length, past and
//        future, stored ones where the table has them and the rest computed, nothing written. point may repeat. Default span: from
//        today for eight days (today and seven days ahead).
// A tariff nobody may see is not shown: a tariff known only through the private rows or agreements of homes the user cannot see
// answers as one that does not exist, and the shared runs are the only ones read when no home is named.
import express from 'express';
import { db } from '../db/db.js';
import { canSee, visibleSiteIds } from '../core/users.js';
import { MARKETS } from '../db/seed/markets.js';
import { tariffSlots, homePriceTimeline } from '../core/tariff-slots.js';
import { dayBounds, localDate, addDays, slotLength } from '../core/time.js';

const router = express.Router();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// A time as epoch seconds: digits are seconds, a date is local midnight in tz.
function when(value, tz, what) {
  if (/^\d{1,11}$/.test(String(value))) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    if (!tz) throw bad(`${what}: a date needs a zone: name a home (site=) or give epoch seconds`);
    const t = (() => { try { return dayBounds(tz, String(value))[0]; } catch { return NaN; } })();
    if (!Number.isFinite(t) || localDate(tz, t) !== String(value)) throw bad(`${what}: not a date: ${value}`);
    return t;
  }
  throw bad(`${what}: epoch seconds or a date (YYYY-MM-DD), not ${JSON.stringify(value)}`);
}
const span = (q, tz, fromDefault, toDefault) => ({
  from: q.from != null ? when(q.from, tz, 'from') : fromDefault, to: q.to != null ? when(q.to, tz, 'to') : toDefault,
});

// Whether the user may see a tariff: one with a shared rate row is public; one known only through homes' own rows or agreements is
// seen by the users of those homes (and admins); one with neither is a bare catalogue entry.
async function tariffVisible(user, tariffId) {
  const visible = await visibleSiteIds(user);
  if (visible === null) return true;
  if (await db.prepare('SELECT 1 AS x FROM rate_interval WHERE tariff_id = ? AND site_id IS NULL LIMIT 1').get(tariffId)) return true;
  const owners = (await db.prepare(`SELECT site_id FROM rate_interval WHERE tariff_id = ? AND site_id IS NOT NULL UNION SELECT site_id FROM tariff_agreement WHERE tariff_id = ?`).all(tariffId, tariffId)).map((r) => r.site_id);
  return owners.length === 0 || owners.some((id) => visible.has(id));
}

const handle = (fn) => async (req, res) => {
  try {
    res.json({ ...await fn(req), generated_at: Math.floor(Date.now() / 1000) });
  } catch (err) {
    const status = err.status ?? (err instanceof RangeError || err instanceof TypeError ? 400 : 500);
    res.status(status).json({ error: err.message });
  }
};

// The home the user may see, as a site row; 404 otherwise (the same answer as for a home that does not exist).
async function homeOf(req, id) {
  const site = /^\d+$/.test(String(id ?? '')) ? await db.prepare('SELECT * FROM site WHERE id = ?').get(Number(id)) : null;
  if (!site || !await canSee(req.user, site.id)) throw bad('No such home', 404);
  return site;
}

router.get('/tariffs/:id/slots', handle(async (req) => {
  const ref = req.params.id;
  const tariff = /^\d+$/.test(ref) ? await db.prepare('SELECT * FROM tariff WHERE id = ?').get(Number(ref)) : await db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(ref);
  if (!tariff || !await tariffVisible(req.user, tariff.id)) throw bad('No such tariff', 404);
  const site = req.query.site != null ? await homeOf(req, req.query.site) : null;
  const tz = site ? site.timezone || 'Europe/London' : MARKETS.find((m) => m.country === tariff.country)?.timezone ?? null;
  const today = tz ? dayBounds(tz, localDate(tz, Math.floor(Date.now() / 1000)))[0] : Math.floor(Date.now() / 86400000) * 86400;
  const { from, to } = span(req.query, tz, today, tz ? dayBounds(tz, addDays(localDate(tz, today), 2))[0] : today + 2 * 86400);
  const slotS = req.query.slot_s != null ? Number(req.query.slot_s) : site ? slotLength(site) : 1800;
  return await tariffSlots(tariff, { site, from, to, slotS });
}));

router.get('/sites/:id/prices', handle(async (req) => {
  const site = await homeOf(req, req.params.id);
  const tz = site.timezone || 'Europe/London';
  const today = dayBounds(tz, localDate(tz, Math.floor(Date.now() / 1000)))[0];
  const { from, to } = span(req.query, tz, today, dayBounds(tz, addDays(localDate(tz, today), 8))[0]);
  const points = req.query.point == null ? null : [].concat(req.query.point).map(String);
  return await homePriceTimeline(site, { from, to, points });
}));

export default router;
