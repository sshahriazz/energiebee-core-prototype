// The demo server (npm run demo:start): the energiebee_demo database (npm run demo:users) on http://localhost:4101,
// with the "Viewing as" switch on and "+ Sign up" next to it. Started without .env's logins, so it holds none of the
// .env home's credentials; a user signed up here connects their own, encrypted with the demo's own SECRET_KEY
// (SECRET_KEY from the environment if set, else data/demo/.secret-key, made on first start).
// DEMO_DATABASE names another demo database on the same server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { databaseExists, urlFor } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
// Only the server to use is taken from .env (DATABASE_URL); nothing else of it reaches the demo.
let server = process.env.DATABASE_URL;
if (!server) { try { server = /^DATABASE_URL=(.+)$/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8'))?.[1]?.trim(); } catch { /* no .env */ } }
if (!server) { console.error('DATABASE_URL is not set: it names the Postgres server the demo database lives on'); process.exit(1); }
const name = process.env.DEMO_DATABASE || 'energiebee_demo';
if (!await databaseExists(name, server)) { console.error(`no demo database ${name}: run npm run demo:users first`); process.exit(1); }
process.env.DATABASE_URL = urlFor(name, server);
process.env.DATA_DIR = path.join(root, 'data', 'demo');
process.env.USER_SWITCHER = '1';
process.env.PORT ||= '4101';
if (!process.env.SECRET_KEY) {
  const keyFile = path.join(process.env.DATA_DIR, '.secret-key');
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  process.env.SECRET_KEY = fs.readFileSync(keyFile, 'utf8').trim();
}
const { start } = await import('../src/server.js');
await start();
