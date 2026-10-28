// A database to try the prototype's users in (src/core/users.js, delta 070): the homes of
// scripts/demo-ui.js (the REAL GB home copied from data/core.db, a SYNTHETIC French and a SYNTHETIC
// Dutch home) and one user per scenario, each seeing only their own homes.
//
//   npm run demo:users            (or: node --disable-warning=ExperimentalWarning scripts/demo-users.js [out.db])
//   npm run demo:start            serves it on http://localhost:4101, without .env
//
// Never changes data/core.db or data/raw: the database is a copy (data/demo/core.db by default) and the
// raw payloads are copied next to it (a clone on APFS, so no extra space), so the Data & trust page can
// still open them. Run again to start afresh. The demo server is started without .env, so it holds no
// credential and never syncs the GB home with its providers' logins.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'data', 'demo', 'core.db'));
const live = path.join(root, 'data', 'core.db');
if (out === live) { console.error('refusing to write the demo users into data/core.db'); process.exit(1); }

// The homes: demo-ui.js copies the live database and adds the synthetic French and Dutch homes.
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'scripts', 'demo-ui.js'), out], { stdio: 'inherit' });
const rawFrom = path.join(root, 'data', 'raw'); const rawTo = path.join(path.dirname(out), 'raw');
fs.rmSync(rawTo, { recursive: true, force: true });
if (fs.existsSync(rawFrom)) fs.cpSync(rawFrom, rawTo, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });

process.env.DB_FILE = out;
const { db, closeDb } = await import('../src/db/db.js');
const { createUser, giveHome, listUsers } = await import('../src/core/users.js');

const home = (where) => db.prepare(`SELECT id, name FROM site WHERE ${where} ORDER BY id LIMIT 1`).get();
const gb = home("is_demo = 0 AND IFNULL(market_code, 'GB') = 'GB'");
const fr = home("is_demo = 1 AND country = 'FR'");
const nl = home("is_demo = 1 AND country = 'NL'");
if (!gb || !fr || !nl) { console.error('expected the GB, FR and NL homes of demo-ui.js'); process.exit(1); }

// One user per scenario. Fictional people; example.com addresses.
const USERS = [
  { name: 'Alice Morgan', email: 'alice@example.com', role: 'owner', homes: [gb], note: 'a real GB home with live provider data' },
  { name: 'Pierre Laurent', email: 'pierre@example.com', role: 'owner', homes: [fr], note: 'a synthetic French home: euros, Tempo days' },
  { name: 'Sanne de Vries', email: 'sanne@example.com', role: 'owner', homes: [nl], note: 'a synthetic Dutch home: euros, quarter-hours' },
  { name: 'Ivan Petrov', email: 'ivan@example.com', role: 'installer', homes: [fr, nl], note: 'an installer looking after two homes' },
  { name: 'Nora Newman', email: 'nora@example.com', role: 'owner', homes: [], note: 'just signed up: no home yet' },
  { name: 'Admin', email: 'admin@example.com', role: 'admin', homes: [], note: 'sees every home' },
];
db.exec('DELETE FROM user_site; DELETE FROM app_user;');
for (const u of USERS) {
  const row = createUser(u);
  for (const h of u.homes) giveHome(row.id, h.id);
}

console.log('\nUsers (switch between them with "Viewing as" in the top bar):');
const names = new Map(db.prepare('SELECT id, name FROM site').all().map((s) => [s.id, s.name]));
for (const u of listUsers()) {
  const homes = db.prepare('SELECT site_id FROM user_site WHERE user_id = ? ORDER BY site_id').all(u.id).map((r) => names.get(r.site_id));
  console.log(`  user ${u.id}  ${u.name.padEnd(15)} ${u.role.padEnd(9)} ${u.role === 'admin' ? 'every home' : homes.join(', ') || '(no home)'}  — ${u.note}`);
}
closeDb();
console.log(`\nStart it with: npm run demo:start   (http://localhost:4101; DB_FILE=${path.relative(root, out)})`);
