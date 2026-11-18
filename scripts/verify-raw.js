// Check raw files against their hashes (src/core/raw-integrity.js): never changes a file or a receipt row, prints counts and the
// ids of the receipts with a problem (never a payload). It records the run (raw_check_run) and each receipt's state
// (raw_payload_check), like the server's own runs. Exit code 1 when there is a problem, so cron can alert.
//   npm run raw:verify [-- --site <id>] [-- --limit <n>]
// By default every receipt; --limit 200 takes the 200 checked longest ago, as the server's runs do.
import { rawCheckSummary, verifyRaw } from '../src/core/raw-integrity.js';
import { closeDb } from '../src/db/db.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const whole = (name) => {
  const v = arg(name);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) { console.error(`--${name} takes a whole number >= 1, not ${JSON.stringify(v)}`); process.exit(2); }
  return n;
};
const report = await verifyRaw({ siteId: whole('site'), limit: whole('limit'), trigger: 'cli' });
console.log(JSON.stringify(report, null, 1));
console.log(rawCheckSummary(report));
await closeDb();
process.exit(report.problems.length || report.truncated ? 1 : 0);
