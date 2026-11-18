// Check raw files against their hashes (src/core/raw-integrity.js): never changes a file or a receipt row, prints counts and the
// ids of the receipts with a problem (never a payload). It records the run (raw_check_run) and each receipt's state
// (raw_payload_check), like the server's own runs. Exit code 1 when there is a problem, so cron can alert.
//   npm run raw:verify [-- --site <id>] [-- --limit <n>]
// By default every receipt; --limit 200 takes the 200 checked longest ago, as the server's runs do.
import { rawCheckSummary, verifyRaw } from '../src/core/raw-integrity.js';
import { closeDb } from '../src/db/db.js';

// --name value or --name=value; anything else is refused (a mistyped scope would otherwise check the whole store).
const fail = (msg) => { console.error(`${msg}\nusage: npm run raw:verify [-- --site <id>] [-- --limit <n>]`); process.exit(2); };
const given = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m || !['site', 'limit'].includes(m[1])) fail(`unknown argument ${JSON.stringify(argv[i])}`);
  if (m[1] in given) fail(`--${m[1]} given twice`);
  given[m[1]] = m[2] ?? argv[++i];
}
const whole = (name) => {
  const v = given[name];
  if (v == null) return name in given ? fail(`--${name} needs a value`) : null;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1) fail(`--${name} takes a whole number >= 1, not ${JSON.stringify(v)}`);
  return n;
};
const report = await verifyRaw({ siteId: whole('site'), limit: whole('limit'), trigger: 'cli' });
console.log(JSON.stringify(report, null, 1));
console.log(rawCheckSummary(report));
await closeDb();
process.exit(report.problems.length || report.truncated ? 1 : 0);
