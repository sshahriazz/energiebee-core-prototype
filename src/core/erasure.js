// The one way facts and raw receipts leave the database (fix list R14). They are append-only in the database itself
// (migration 20261117000006_erasure): a fact changes only by being superseded once, a raw receipt never changes, and
// neither is deleted, except inside an erasure opened here. An erasure is logged (erasure_log: what kind, which home, why,
// how many rows of each table), in the same transaction as the deletes, so a removal without its log row cannot exist.
//
//   home        a whole home deleted for good on its owner's request (src/core/delete-home.js); its raw-file key goes too
//   retention   history past its retention period (src/core/maintenance.js)
//   anonymise   a throwaway copy made identifier-free (scripts/make-fixture.js)
//   synthetic   a demo home's generated data replaced (scripts/demo-ui.js)
//   person      a person erased on request, apart from any home: their account and the personal answers of their occupancies (src/core/occupancy.js, R21)
//   handover    a home changed hands: the old occupancy's logins, requests and personal answers removed (src/core/occupancy.js)
import { db, tx } from '../db/db.js';

export const ERASURE_KINDS = ['home', 'retention', 'anonymise', 'synthetic', 'person', 'handover'];

// Run fn inside an open erasure. fn may return { removed: { table: rows, ... } } to be logged; its result is returned.
export async function erase({ kind, siteId = null, siteUid = null, reason }, fn) {
  if (!ERASURE_KINDS.includes(kind)) throw new RangeError(`erasure kind ${kind}: one of ${ERASURE_KINDS.join(', ')}`);
  if (!String(reason ?? '').trim()) throw new Error('an erasure needs a reason');
  return await tx(async () => {
    const id = Number((await db.prepare('INSERT INTO erasure_log (kind, site_id, site_uid, reason, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, siteId, siteUid, reason, Date.now())).lastInsertRowid);
    await db.prepare("SELECT set_config('energiebee.erasure', ?, true)").get(String(id));
    const out = await fn(id);
    await db.prepare('UPDATE erasure_log SET finished_at = ?, removed = ? WHERE id = ?').run(Date.now(), out?.removed ? JSON.stringify(out.removed) : null, id);
    await db.prepare("SELECT set_config('energiebee.erasure', '', true)").get();
    return out;
  });
}
