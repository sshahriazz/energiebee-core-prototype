// Points (plan 2.1 and 2.2, docs/build/points.md): one measurable or settable aspect of a thing. A series is the feed of one source
// into a point, and every fact names its series, so a value is always about a thing: a home's own series sit on its home thing (until
// Phase 2.5 moves them onto the plant things), a device's on its device thing, a region's on a shared context thing.
import { db, metricId } from '../db/db.js';

const SUBJECT_KINDS = ['site', 'device', 'region'];

/**
 * The thing a series subject is: a home is its home thing (the same id) or, for a metric the plant carries, its plant thing, a device its device thing (the same id), a region a shared
 * context thing named by the subject text ('carbon:3' is region 3 of the carbon scheme, 'ldz:NW' a gas distribution zone), made on
 * first use.
 */
export async function subjectThing(kind, id, metric = null) {
  if (!SUBJECT_KINDS.includes(kind)) throw new RangeError(`series subject kind ${kind}: one of ${SUBJECT_KINDS.join(', ')}`);
  if (kind === 'region') return await regionThing(String(id));
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`series subject ${kind} ${id}: not an id`);
  // a home's own metric sits on the plant thing of the energy graph that carries it, when the home has one
  if (kind === 'site' && metric != null) return (await plantThing(n, metric)) ?? n;
  return n;
}

const REGION_TYPES = ['region', 'gas_zone'];
/** The shared context thing of a region subject, made once ('ldz:' is a gas zone, any other prefix the scheme of a region). */
export async function regionThing(subject) {
  const find = async () => (await db.prepare("SELECT id FROM thing WHERE kind = 'context' AND type = ANY(?::text[]) AND name = ? AND superseded_at IS NULL ORDER BY id LIMIT 1").get(`{${REGION_TYPES.join(',')}}`, subject))?.id;
  const found = await find();
  if (found != null) return Number(found);
  // 'carbon:3' is region 3 of the carbon scheme, 'ldz:NW' a gas zone, and a plain 'G' a region with a code and no scheme
  const colon = subject.indexOf(':');
  const scheme = colon < 0 ? null : subject.slice(0, colon);
  const code = colon < 0 ? subject : subject.slice(colon + 1);
  if (!subject.trim() || !code || scheme === '') throw new RangeError(`region subject ${JSON.stringify(subject)}: a code, or scheme:code such as carbon:3 or ldz:NW`);
  const { createThing } = await import('./things.js');
  try {
    return (await createThing(scheme === 'ldz' ? { type: 'gas_zone', name: subject, attrs: { code } } : { type: 'region', name: subject, attrs: scheme == null ? { code } : { scheme, code } })).id;
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

// ───────────── a home's own series on the plant things ─────────────
// A home-level metric belongs to a thing of the energy graph: what the PV produces to the PV array, what the battery stores to the
// battery, what crosses the meter to the grid connection, what the home uses to the home supply. Only a plant thing no integration
// is behind (the graph's own: device provider 'thing') takes them, and only when it is the one thing of its type; otherwise the
// series stay on the home thing. Events, weather, the car and heating stay with the home.
export const PLANT_TYPE = Object.freeze({ solar: 'pv_array', battery: 'battery', grid: 'grid_connection', home: 'home_supply' });
const domains = new Map();
const domainOf = async (code) => {
  if (!domains.has(code)) domains.set(code, (await db.prepare('SELECT domain FROM metric WHERE code = ?').get(code))?.domain ?? null);
  return domains.get(code);
};

/** The graph thing that carries a home-level metric of this home, or null (it stays on the home thing). */
export async function plantThing(homeId, metricCode) {
  const type = PLANT_TYPE[await domainOf(metricCode)];
  if (!type || metricCode.startsWith('event_')) return null;
  const things = await db.prepare(`SELECT t.id FROM thing t JOIN device d ON d.id = t.id AND d.provider = 'thing'
    WHERE t.home_id = ? AND t.type = ? AND t.kind = 'device' AND t.superseded_at IS NULL AND t.merged_into IS NULL AND t.valid_to IS NULL`).all(homeId, type);
  return things.length === 1 ? Number(things[0].id) : null;
}

/**
 * Move a home's own series (and the bindings that feed them) from the home thing onto the plant things that carry them. A series keeps
 * its id and its facts: only its point changes, so nothing that reads it sees the move. Idempotent. Returns the series moved.
 */
export async function placePlantPoints(homeId) {
  let moved = 0;
  const own = await db.prepare(`SELECT p.id, p.metric_id, m.code FROM point p JOIN metric m ON m.id = p.metric_id WHERE p.thing_id = ? AND p.superseded_at IS NULL`).all(homeId);
  for (const p of own) {
    const target = await plantThing(homeId, p.code);
    if (target == null) continue;
    const to = await pointOf(target, p.metric_id);
    moved += (await db.prepare(`UPDATE series SET point_id = ? WHERE point_id = ? AND NOT EXISTS
      (SELECT 1 FROM series s2 WHERE s2.point_id = ? AND s2.metric_id = series.metric_id AND s2.source_id = series.source_id)`).run(to, p.id, to)).changes;
    await db.prepare('UPDATE point_binding SET point_id = ? WHERE point_id = ?').run(to, p.id);
    const used = await db.prepare('SELECT (SELECT COUNT(*) FROM series WHERE point_id = ?) + (SELECT COUNT(*) FROM point_binding WHERE point_id = ?) AS n').get(p.id, p.id);
    if (Number(used.n) === 0) await db.prepare('UPDATE point SET superseded_at = GREATEST(recorded_at, ?) WHERE id = ?').run(Date.now(), p.id);
  }
  return moved;
}
