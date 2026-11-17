// A database to try the prototype's users in (src/core/users.js): the homes of scripts/demo-ui.js (the REAL GB home
// copied from the app's database, a SYNTHETIC French and a SYNTHETIC Dutch home) and one user per scenario, each
// seeing only their own homes.
//
//   npm run demo:users            (or: node --disable-warning=ExperimentalWarning scripts/demo-users.js [database])
//   npm run demo:start            serves it on http://localhost:4101, without .env
//
// Never changes the app's database or data/raw: the demo is a separate database on the same server (energiebee_demo by
// default) and the raw payloads are copied to data/demo/raw (a clone on APFS, so no extra space), so the Data & trust
// page can still open them. Run again to start afresh. The demo server is started without .env, so it holds no
// credential and never syncs the GB home with its providers' logins.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { urlFor } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* the environment provides DATABASE_URL */ }
const name = process.argv[2] || 'energiebee_demo';
const dataDir = path.join(root, 'data', 'demo');

// The homes: demo-ui.js copies the app's database into the demo one and adds the synthetic French and Dutch homes.
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'scripts', 'demo-ui.js'), name], { stdio: 'inherit', env: { ...process.env, DEMO_DATA_DIR: dataDir } });
const rawFrom = path.join(root, process.env.DATA_DIR || 'data', 'raw'); const rawTo = path.join(dataDir, 'raw');
fs.rmSync(rawTo, { recursive: true, force: true });
if (fs.existsSync(rawFrom)) fs.cpSync(rawFrom, rawTo, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });

process.env.DATABASE_URL = urlFor(name, process.env.DATABASE_URL);
process.env.DATA_DIR = dataDir;
const { db, closeDb } = await import('../src/db/db.js');
const { createUser, giveHome, listUsers } = await import('../src/core/users.js');

const home = async (where) => await db.prepare(`SELECT id, name FROM site WHERE ${where} ORDER BY id LIMIT 1`).get();
const gb = await home("is_demo = 0 AND COALESCE(market_code, 'GB') = 'GB'");
const fr = await home("is_demo = 1 AND country = 'FR'");
const nl = await home("is_demo = 1 AND country = 'NL'");
if (!gb || !fr || !nl) { console.error('expected the GB, FR and NL homes of demo-ui.js'); process.exit(1); }

// One user per scenario. Fictional people; no PIN (picked with the switch; scripts/set-pin.js gives one).
const USERS = [
  { name: 'Alice Morgan', username: 'alice', role: 'owner', homes: [gb], note: 'a real GB home with live provider data' },
  { name: 'Pierre Laurent', username: 'pierre', role: 'owner', homes: [fr], note: 'a synthetic French home: euros, Tempo days' },
  { name: 'Sanne de Vries', username: 'sanne', role: 'owner', homes: [nl], note: 'a synthetic Dutch home: euros, quarter-hours' },
  { name: 'Ivan Petrov', username: 'ivan', role: 'installer', homes: [fr, nl], note: 'an installer looking after two homes' },
  { name: 'Nora Newman', username: 'nora', role: 'owner', homes: [], note: 'just signed up: no home yet' },
  { name: 'Admin', username: 'admin', role: 'admin', homes: [], note: 'sees every home' },
];
await db.exec('DELETE FROM user_site; DELETE FROM app_user;');
for (const u of USERS) {
  const row = await createUser(u);
  for (const h of u.homes) await giveHome(row.id, h.id);
}

console.log('\nUsers (switch between them with "Viewing as" in the top bar):');
const names = new Map((await db.prepare('SELECT id, name FROM site').all()).map((s) => [s.id, s.name]));
for (const u of await listUsers()) {
  const homes = (await db.prepare('SELECT site_id FROM user_site WHERE user_id = ? ORDER BY site_id').all(u.id)).map((r) => names.get(r.site_id));
  console.log(`  user ${u.id}  ${u.name.padEnd(15)} ${u.role.padEnd(9)} ${u.role === 'admin' ? 'every home' : homes.join(', ') || '(no home)'}  — ${u.note}`);
}
await closeDb();
console.log(`\nStart it with: npm run demo:start   (http://localhost:4101; database ${name})`);
