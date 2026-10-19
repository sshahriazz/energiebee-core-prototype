// A stable local presentation on its own SQLite snapshot, without provider calls.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, process.env.DB_FILE || 'data/core.db');
const dir = path.resolve(root, process.env.DEMO_DATA_DIR || 'data/demo');
const snapshot = path.join(dir, 'core.db');
const port = process.env.DEMO_PORT || '4102';
fs.mkdirSync(dir, { recursive: true });
if (source === snapshot) throw new Error('The demo snapshot must be separate from the source database.');
if (!fs.existsSync(snapshot)) {
  if (fs.existsSync(source)) {
    const db = new DatabaseSync(source, { readOnly: true });
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    db.close();
    fs.writeFileSync(
      path.join(dir, 'snapshot.json'),
      JSON.stringify({ createdAt: new Date().toISOString(), source }, null, 2)
    );
  }
}
const raw = path.join(path.dirname(source), 'raw');
if (fs.existsSync(raw) && !fs.existsSync(path.join(dir, 'raw')))
  fs.symlinkSync(raw, path.join(dir, 'raw'), 'dir');
const metadataFile = path.join(dir, 'snapshot.json');
const capturedAt = fs.existsSync(metadataFile)
  ? JSON.parse(fs.readFileSync(metadataFile, 'utf8')).createdAt
  : null;
const env = {
  ...process.env,
  DB_FILE: snapshot,
  PORT: port,
  DEMO_OFFLINE: '1',
  DEMO_CAPTURED_AT: capturedAt || '',
};
for (const key of [
  'SUNSYNK_USERNAME',
  'SUNSYNK_PASSWORD',
  'SUNSYNK_PLANT_ID',
  'OCTOPUS_API_KEY',
  'OCTOPUS_ACCOUNT_NUMBER',
])
  delete env[key];
console.log(`Energy core demo: http://localhost:${port}`);
console.log(`Recorded snapshot: ${snapshot}. Provider sync is disabled.`);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
