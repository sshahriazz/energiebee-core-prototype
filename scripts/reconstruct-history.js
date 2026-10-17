// Fill the revision log for the time before it was kept (npm run history:reconstruct).
// Rebuilds each completed day as it stood at every earlier sync, from the facts known then,
// and stores the versions that differ as 'reconstructed'. Writes only to site_day_revision.
// Pass --force to redo it.
import { db } from '../src/db/db.js';
import { reconstructHistory } from '../src/core/history.js';

const force = process.argv.includes('--force');
for (const { id, name } of db.prepare('SELECT id, name FROM site').all()) {
  const t0 = Date.now();
  const r = reconstructHistory(id, { force });
  console.log(`${name}: ${JSON.stringify(r)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
