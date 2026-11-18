// Check every raw file against its hash (src/core/raw-integrity.js): reads only, never changes a file or a row, prints counts
// and the ids of the receipts with a problem (never a payload). Exit code 1 when there is a problem, so cron can alert.
//   npm run raw:verify [-- --site <id>] [-- --slice <index>/<of>]
// By default the whole raw store (RAW_DIR, else DATA_DIR/raw); --slice 3/7 checks the part the server's daily run checks on day 3 of 7.
import { rawCheckSummary, verifyRaw } from '../src/core/raw-integrity.js';
import { closeDb } from '../src/db/db.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const site = arg('site');
const [index, of] = (arg('slice') ?? '').split('/').map(Number);
const report = await verifyRaw({ siteId: site == null ? null : Number(site), slice: arg('slice') ? { index, of } : null });
console.log(JSON.stringify(report, null, 1));
console.log(rawCheckSummary(report));
await closeDb();
process.exit(report.problems.length || report.truncated ? 1 : 0);
