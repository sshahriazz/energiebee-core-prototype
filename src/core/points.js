// Points (plan 2.1 and 2.2, docs/build/points.md): one measurable or settable aspect of a thing. A series is the feed of one source
// into a point, and every fact names its series, so a value is always about a thing: a home's own series sit on its home thing (until
// Phase 2.5 moves them onto the plant things), a device's on its device thing, a region's on a shared context thing.
import { db, metricId } from '../db/db.js';

const SUBJECT_KINDS = ['site', 'device', 'region'];

/**
 * The thing a series subject is: a home is its home thing (the same id), a device its device thing (the same id), a region a shared
 * context thing named by the subject text ('carbon:3' is region 3 of the carbon scheme, 'ldz:NW' a gas distribution zone), made on
 * first use.
 */
export async function subjectThing(kind, id) {
  if (!SUBJECT_KINDS.includes(kind)) throw new RangeError(`series subject kind ${kind}: one of ${SUBJECT_KINDS.join(', ')}`);
  if (kind === 'region') return await regionThing(String(id));
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`series subject ${kind} ${id}: not an id`);
  return n;
}

const REGION_TYPES = ['region', 'gas_zone'];
/** The shared context thing of a region subject, made once ('ldz:' is a gas zone, any other prefix the scheme of a region). */
export async function regionThing(subject) {
  const find = async () => (await db.prepare("SELECT id FROM thing WHERE kind = 'context' AND type = ANY(?::text[]) AND name = ? AND superseded_at IS NULL ORDER BY id LIMIT 1").get(`{${REGION_TYPES.join(',')}}`, subject))?.id;
  const found = await find();
  if (found != null) return Number(found);
  const [scheme, ...rest] = subject.split(':');
  const code = rest.join(':');
  if (!scheme || !code) throw new RangeError(`region subject ${JSON.stringify(subject)}: scheme:code, such as carbon:3 or ldz:NW`);
  const { createThing } = await import('./things.js');
  try {
    return (await createThing(scheme === 'ldz' ? { type: 'gas_zone', name: subject, attrs: { code } } : { type: 'region', name: subject, attrs: { scheme, code } })).id;
  } catch (err) {
    const again = await find();   // another writer made it first (the unique index on a region's name)
    if (again != null) return Number(again);
    throw err;
  }
}

/** The point of a thing for a metric (its key is the metric's code until a capability names it), made on first use. Returns its id. */
export async function pointOf(thingId, metric) {
  const mid = typeof metric === 'number' ? metric : await metricId(metric);
  const key = typeof metric === 'number' ? (await db.prepare('SELECT code FROM metric WHERE id = ?').get(mid)).code : metric;
  const find = async () => (await db.prepare('SELECT id FROM point WHERE thing_id = ? AND key = ? AND superseded_at IS NULL').get(thingId, key))?.id;
  const found = await find();
  if (found != null) return Number(found);
  await db.prepare(`INSERT INTO point (thing_id, key, metric_id, class, access) VALUES (?, ?, ?, metric_point_class(?), metric_point_access(?))
    ON CONFLICT (thing_id, key) WHERE superseded_at IS NULL DO NOTHING`).run(thingId, key, mid, mid, mid);
  return Number(await find());
}

/** The points of a thing, current ones, in key order. */
export async function pointsOf(thingId) {
  return await db.prepare(`SELECT p.id, p.uid, p.key, p.capability, m.code AS metric, m.unit, p.class, p.access, p.valid_from, p.valid_to
    FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND p.superseded_at IS NULL ORDER BY p.key`).all(thingId);
}
