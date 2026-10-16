// Each test file runs in its own process with its own database, so tests never touch
// data/core.db. Call useDb() before importing anything from src/ (db.js opens DB_FILE on import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
export const liveDb = path.join(root, 'data', 'core.db');
export const hasLive = fs.existsSync(liveDb);

// An empty database, or (snapshot) a consistent copy of the live one. Stand-in values written
// by a test go only into this copy, which is deleted when the test process ends.
export function useDb({ snapshot = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
  const file = path.join(dir, 'core.db');
  if (snapshot) {
    const src = new DatabaseSync(liveDb, { readOnly: true });
    src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    src.close();
  }
  process.env.DB_FILE = file;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}
