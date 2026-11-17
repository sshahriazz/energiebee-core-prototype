// A database to browse in the web pages: the REAL GB home (a copy of the app's database, untouched and still the
// original's data) plus a SYNTHETIC French and a SYNTHETIC Dutch home dated to the last few days, so every page has
// something to show for each market.
//
//   node --disable-warning=ExperimentalWarning scripts/demo-ui.js [database]      default energiebee_ui_demo
//   DATABASE_URL=<that database> PORT=4101 node --disable-warning=ExperimentalWarning src/server.js
//
// Never changes the app's database (DATABASE_URL) and calls no provider: the demo is a separate database on the same
// server, made again on every run. The French and Dutch homes are flagged is_demo, their tariffs and readings are
// labelled synthetic, and their tax values are placeholders: the pages show a banner saying so. The real GB home is
// not flagged and keeps its own labels (provider / sourced).
import os from 'node:os';
import path from 'node:path';
import { loadTables, postgresTables, scriptDatabase } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* the environment provides DATABASE_URL */ }
const live = process.env.DATABASE_URL;
const name = process.argv[2] || 'energiebee_ui_demo';
const demo = await scriptDatabase({ keep: name, dataDir: process.env.DEMO_DATA_DIR || path.join(os.tmpdir(), 'eb-ui-demo') });
await loadTables(demo.url, postgresTables(live));

const m = await import('./lib/multi-market.js');
const { db, closeDb } = await import('../src/db/db.js');
const { buildSite } = await import('../src/core/build.js');
const { localDate, addDays, nowSec } = await import('../src/core/time.js');

const now = nowSec();
// Dates for the synthetic homes: the last four days ending today; the tariff change on the third.
const FRd = localDate(m.FR.tz, now); const NLd = localDate(m.NL.tz, now);
Object.assign(m.FR, { to: FRd, change: addDays(FRd, -2), from: addDays(FRd, -3) });
// A Tempo colour day starts at 06:00, so the day before the first priced day needs a colour too.
m.FR.tempo.colours = Object.fromEntries([addDays(FRd, -2), addDays(FRd, -1), FRd].map((d, i) => [d, ['blue', 'white', 'red'][i]]));
Object.assign(m.NL, { to: NLd, change: addDays(NLd, -1), from: addDays(NLd, -3) });

const fr = await m.frHome();
const nl = await m.nlHome();
// Synthetic readings are generated for whole days; drop what lies in the future so nothing is "live" ahead of now.
for (const id of [fr.site.id, nl.site.id]) {
  const series = (await db.prepare(`SELECT id FROM series WHERE (subject_kind = 'site' AND subject_id = ?) OR (subject_kind = 'device' AND subject_id IN (SELECT CAST(id AS TEXT) FROM device WHERE site_id = ?))`).all(String(id), id)).map((r) => r.id);
  for (const sid of series) {
    await db.prepare('DELETE FROM reading WHERE series_id = ? AND ts > ?').run(sid, now);
    await db.prepare('DELETE FROM interval_fact WHERE series_id = ? AND end_ts > ?').run(sid, now);
  }
}
await buildSite(fr.site.id, m.FR.from, FRd, { reason: 'synthetic ui demo' });
await buildSite(nl.site.id, m.NL.from, NLd, { reason: 'synthetic ui demo' });

const real = await db.prepare('SELECT id, name, currency, slot_s FROM site WHERE id = 1').get();
console.log(`UI demo database: ${demo.name} (DATABASE_URL=${demo.url})`);
console.log(`  site ${real.id}  ${real.name}  ${real.currency}  slot ${real.slot_s}s  REAL data (copy of the app's database)`);
console.log(`  site ${fr.site.id}  Synthetic FR home  EUR  slot 1800s  SYNTHETIC ${m.FR.from}..${FRd}`);
console.log(`  site ${nl.site.id}  Synthetic NL home  EUR  slot 900s   SYNTHETIC ${m.NL.from}..${NLd}`);
await closeDb();
