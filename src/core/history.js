// Reconstruct the revision log for the time before it was kept.
//
// The log (site_day_revision) records changes from the moment it was added. Earlier states are
// not lost: facts, prices, agreements and device details are all kept with when they became
// known, so each day can be rebuilt as it stood at every earlier sync. Each reconstructed
// version is stored with kind = 'reconstructed', the moment, and what it rested on.
//
// What a reconstruction is, and is not:
//   - It uses today's build method on the facts known then. What the pages showed at the time
//     may have differed, because the method itself changed during development.
//   - It starts at the first sync whose tariff agreements were recorded. Before that the
//     agreements came from .env and were not kept, so a bill could not be reproduced.
//   - Inputs not versioned at that moment (device details, system details before 16 Oct 2026)
//     are listed with each version.
import { db, tx } from '../db/db.js';
import { buildSite, dayChanges, METHOD_VERSION } from './build.js';
import { localDate } from './time.js';

export function reconstructHistory(siteId, { force = false } = {}) {
  const site = db.prepare('SELECT * FROM site WHERE id = ?').get(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const tz = site.timezone;
  const existing = db.prepare("SELECT COUNT(*) AS n FROM site_day_revision WHERE site_id = ? AND kind = 'reconstructed'").get(siteId).n;
  if (existing && !force) return { skipped: `${existing} reconstructed versions already stored (pass force to redo)` };
  const firstDay = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(siteId).d;
  const agreementsFrom = db.prepare('SELECT MIN(recorded_at) AS t FROM tariff_agreement WHERE site_id = ?').get(siteId).t;
  if (!firstDay || agreementsFrom == null) return { skipped: 'no built days or no recorded tariff agreements' };

  // Each day's first live record: reconstruction fills in only the time before it.
  const firstRecorded = new Map(db.prepare("SELECT local_date, MIN(revised_at) AS t FROM site_day_revision WHERE site_id = ? AND kind = 'recorded' GROUP BY local_date").all(siteId).map((r) => [r.local_date, r.t]));
  const logStart = Math.min(...firstRecorded.values(), Infinity);
  const moments = [...new Set(db.prepare('SELECT finished_at FROM sync_run WHERE site_id = ? AND finished_at IS NOT NULL ORDER BY finished_at').all(siteId)
    .map((r) => r.finished_at).filter((t) => t * 1000 >= agreementsFrom && t < logStart))];

  const prev = new Map();
  const rows = [];
  for (const T of moments) {
    const today = localDate(tz, T);
    if (today <= firstDay) continue;
    const r = buildSite(siteId, firstDay, today, { asOf: T, dryRun: true });
    const checksBy = new Map();
    for (const [d, code, status] of r.checks) checksBy.set(d, { ...(checksBy.get(d) || {}), [code]: status });
    for (const d of r.dayRows) {
      if (d.local_date >= today) continue;                                  // still filling in at T
      const fr = firstRecorded.get(d.local_date);
      if (fr != null && T >= fr) continue;                                  // the live log covers it
      const checks = checksBy.get(d.local_date) || {};
      const before = prev.get(d.local_date);
      const changed = before ? dayChanges(before.row, before.checks, d, checks) : null;
      prev.set(d.local_date, { row: d, checks });
      if (before && !changed.length) continue;
      rows.push([siteId, d.local_date, T, METHOD_VERSION, `reconstructed from the facts known at this sync (method ${METHOD_VERSION})`,
        d.slots_final, d.slots_provisional, d.slots_missing, d.solar, d.home, d.grid_import, d.grid_export, d.gas, d.total_cost, d.saving,
        JSON.stringify(checks), JSON.stringify({ ...(r.inputs[d.local_date] || {}), approximations: r.approximations }), changed ? JSON.stringify(changed) : null]);
    }
  }

  let linked = 0;
  tx(() => {
    if (force) db.prepare("DELETE FROM site_day_revision WHERE site_id = ? AND kind = 'reconstructed'").run(siteId);
    const ins = db.prepare(`INSERT INTO site_day_revision (site_id, local_date, revised_at, method_version, reason, slots_final, slots_provisional, slots_missing,
      solar, home, grid_import, grid_export, gas, total_cost, saving, checks, inputs, changed, kind) VALUES (${Array(18).fill('?').join(',')}, 'reconstructed')`);
    for (const row of rows) ins.run(...row);
    // Each day's first live record now follows a reconstructed version: say what changed since it.
    for (const [date, t] of firstRecorded) {
      const last = prev.get(date);
      if (!last) continue;
      const rec = db.prepare("SELECT * FROM site_day_revision WHERE site_id = ? AND local_date = ? AND kind = 'recorded' AND revised_at = ? ORDER BY id LIMIT 1").get(siteId, date, t);
      if (!rec) continue;
      const changed = dayChanges(last.row, last.checks, rec, JSON.parse(rec.checks || '{}'));
      db.prepare('UPDATE site_day_revision SET changed = ?, reason = ? WHERE id = ?')
        .run(JSON.stringify(changed), String(rec.reason || '').replace(' (first record of this day)', ''), rec.id);
      linked++;
    }
  });
  return { moments: moments.length, versions: rows.length, days: new Set(rows.map((r) => r[1])).size, linked };
}
