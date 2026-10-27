// Impact preview: what a change to the inputs would do to the slots already built, before it is made.
// The change runs inside a savepoint that is rolled back, so nothing is kept; the builder's dry run
// is compared before and after. Used for provider changes (bind, unbind) and any other input change.
import { db } from '../db/db.js';
import { buildSite } from './build.js';
import { nowSec, localDate, addDays } from './time.js';

const FIELDS = ['solar', 'home', 'grid_import', 'grid_export', 'total_cost', 'state'];

// apply: a function that makes the change (for example () => bind(...)). Returns
// { slots, changed, byField: { field: { slots, sum } }, firstChanged, lastChanged, days }.
export function previewImpact(siteId, apply) {
  const site = db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId);
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(siteId)?.d;
  if (!first) return { slots: 0, changed: 0, byField: {}, firstChanged: null, lastChanged: null, days: [] };
  const last = addDays(localDate(site.timezone, nowSec()), -1);
  const read = () => buildSite(siteId, first, last, { asOf: nowSec() + 1, dryRun: true }).hhRows; // +1: rows written this second are known
  const before = new Map(read().map((r) => [r.slot_start, r]));
  db.exec('SAVEPOINT impact_preview');
  let after;
  try { apply(); after = read(); } finally { db.exec('ROLLBACK TO impact_preview'); db.exec('RELEASE impact_preview'); }
  const byField = {}; const days = new Set(); let changed = 0; let firstChanged = null; let lastChanged = null;
  for (const r of after) {
    const o = before.get(r.slot_start);
    let diff = false;
    for (const f of FIELDS) {
      const a = o?.[f] ?? null; const b = r[f] ?? null;
      const moved = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-9 : a !== b;
      if (!moved) continue;
      diff = true;
      const x = (byField[f] ||= { slots: 0, sum: 0 });
      x.slots++; if (typeof a === 'number' && typeof b === 'number') x.sum += b - a;
    }
    if (diff) { changed++; days.add(r.local_date); firstChanged ??= r.slot_start; lastChanged = r.slot_start; }
  }
  return { slots: after.length, changed, byField, firstChanged, lastChanged, days: [...days].sort() };
}
