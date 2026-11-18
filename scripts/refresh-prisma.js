// Refresh prisma/schema.prisma from the migrations (the SQL is the source of truth; the models are pulled from it): a scratch
// database is migrated, `prisma db pull` reads it, `prisma generate` rebuilds the client. Never touches the app's database.
//   node --disable-warning=ExperimentalWarning scripts/refresh-prisma.js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptDatabase } from './lib/databases.js';

const root = path.resolve(import.meta.dirname, '..');
const scratch = await scriptDatabase({ prefix: 'energiebee_prisma' });   // dropped when this process ends
const url = new URL(scratch.url);
if (!url.username) url.username = os.userInfo().username;   // the Prisma CLI does not default to the OS user
const env = { ...process.env, DATABASE_URL: url.toString() };
for (const args of [['prisma', 'db', 'pull', '--force'], ['prisma', 'generate']]) {
  const r = spawnSync('npx', args, { env, cwd: root, stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  if (args[2] === 'pull') nameRelationsApart();
}

// Prisma names a relation field after the table it points at, and a model that has a column of that name (point_binding.point, and its
// relation to point) is then invalid: a relation field that repeats the name of another field of its model gets a '_ref' suffix.
function nameRelationsApart() {
  const file = path.join(root, 'prisma', 'schema.prisma');
  const out = [];
  let model = null;
  let fields = new Set();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^model (\S+) \{/);
    if (m) { model = m[1]; fields = new Set(); for (let j = i + 1; j < lines.length && !lines[j].startsWith('}'); j++) { const f = lines[j].match(/^\s+(\w+)\s+\S/); if (f && !lines[j].includes('@relation')) fields.add(f[1]); } }
    const rel = model && line.match(/^(\s+)(\w+)(\s+\S+\s+)@relation\(/);
    out.push(rel && fields.has(rel[2]) ? line.replace(rel[0], rel[1] + rel[2] + '_ref' + rel[3] + '@relation(') : line);
  }
  fs.writeFileSync(file, out.join('\n'));
}
