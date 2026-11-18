// Refresh prisma/schema.prisma from the migrations (the SQL is the source of truth; the models are pulled from it): a scratch
// database is migrated, `prisma db pull` reads it, `prisma generate` rebuilds the client. Never touches the app's database.
//   node --disable-warning=ExperimentalWarning scripts/refresh-prisma.js
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scriptDatabase } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
const scratch = await scriptDatabase({ prefix: 'energiebee_prisma' });   // dropped when this process ends
const url = new URL(scratch.url);
if (!url.username) url.username = os.userInfo().username;   // the Prisma CLI does not default to the OS user
const env = { ...process.env, DATABASE_URL: url.toString() };
for (const args of [['prisma', 'db', 'pull'], ['prisma', 'generate']]) {
  const r = spawnSync('npx', args, { env, cwd: root, stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}
