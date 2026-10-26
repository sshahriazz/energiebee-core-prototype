// Retention, run by hand: what would be deleted (a dry run, the default) or, with --apply, deleting
// it. Counts and bytes only, never a payload's contents. The same rules and windows as the start-up
// hook (src/core/maintenance.js runRetention; RAW_RETENTION_DAYS, SYNC_RUN_RETENTION_DAYS,
// FORECAST_RETENTION_DAYS). Opens DB_FILE like the server: npm run retention [-- --apply].
// Best run while the server is stopped: a payload deleted here while a sync is landing the same
// answer would make that sync step fail (it would be landed again on the next sync).
import { runRetention, retentionSummary } from '../src/core/maintenance.js';

const apply = process.argv.includes('--apply');
const report = runRetention({ dryRun: !apply });
console.log(JSON.stringify(report, null, 1));
console.log(retentionSummary(report));
