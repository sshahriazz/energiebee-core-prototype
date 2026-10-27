// Each test file runs in its own process with its own database, so tests never touch
// data/core.db. Call useDb() before importing anything from src/ (db.js opens DB_FILE on import).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
export const liveDb = path.join(root, 'data', 'core.db');
export const hasRealLive = fs.existsSync(liveDb);
// The frozen, identifier-free real GB home (scripts/make-fixture.js). Tests that need real shapes
// start from it, never from data/core.db, so a repopulated live database cannot turn them red.
export const fixtureDb = path.join(root, 'test', 'fixtures', 'gb-home.db');
export const hasLive = fs.existsSync(fixtureDb);

// An empty database, or (snapshot) a consistent copy of the frozen GB home fixture. Stand-in values written
// by a test go only into this copy, which is deleted when the test process ends.
export function useDb({ snapshot = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
  const file = path.join(dir, 'core.db');
  if (snapshot) {
    const src = new DatabaseSync(fixtureDb, { readOnly: true });
    src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    src.close();
  }
  process.env.DB_FILE = file;
  // TEST_SLOT_S=900|3600 runs a snapshot test at another slot length (npm run test:slots). Stored slot rows stay as they are; dry-run builds follow the new length.
  if (snapshot && process.env.TEST_SLOT_S) {
    const c = new DatabaseSync(file);
    // A build "as known at" a moment reads the home's settings from site_version, so both are changed.
    c.prepare('UPDATE site SET slot_s = ?').run(Number(process.env.TEST_SLOT_S));
    c.prepare('UPDATE site_version SET slot_s = ?').run(Number(process.env.TEST_SLOT_S));
    c.close();
  }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}
