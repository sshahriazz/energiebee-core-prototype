// The demo server (npm run demo:start): data/demo/core.db (npm run demo:users) on http://localhost:4101,
// with the "Viewing as" switch on and "+ Sign up" next to it. Started without .env, so it holds none of
// the .env home's logins; a user signed up here connects their own, encrypted with the demo's own
// SECRET_KEY (SECRET_KEY from the environment if set, else data/demo/.secret-key, made on first start).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
process.env.USER_SWITCHER = '1';
process.env.DB_FILE ||= path.join(root, 'data', 'demo', 'core.db');
process.env.PORT ||= '4101';
if (!fs.existsSync(process.env.DB_FILE)) { console.error(`no demo database at ${process.env.DB_FILE}: run npm run demo:users first`); process.exit(1); }
if (!process.env.SECRET_KEY) {
  const keyFile = path.join(path.dirname(process.env.DB_FILE), '.secret-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  process.env.SECRET_KEY = fs.readFileSync(keyFile, 'utf8').trim();
}
const { start } = await import('../src/server.js');
start();
