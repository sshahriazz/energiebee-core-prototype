// Where raw receipt files live. raw_payload.file stays "raw/<source>/<day>/<hash16>.json" whatever the disk layout is:
// that name is the receipt's identity, the folder it sits in is a deployment choice. By default the folder is
// DATA_DIR/raw; RAW_DIR puts it elsewhere (another disk, a network mount, a backup-friendly volume). No database import
// here, so scripts can find the live folder before they point db.js at a throwaway database.
import path from 'node:path';

export function resolveRawDir(env, root) {
  return path.resolve(root, env.RAW_DIR || path.join(env.DATA_DIR || 'data', 'raw'));
}

// The path of a receipt's file inside rawDir, or null when the name does not belong to the raw store (it does not start
// with raw/, or climbs out of it: a row anonymised by make-fixture names 'redacted-<id>').
export function rawFileIn(rawDir, file) {
  const parts = path.normalize(String(file ?? '')).split(path.sep);
  if (parts.length < 2 || parts[0] !== 'raw') return null;
  const p = path.join(rawDir, ...parts.slice(1));
  return p.startsWith(rawDir + path.sep) ? p : null;
}

// The name a file under rawDir has in raw_payload.file.
export const rawName = (rawDir, full) => path.join('raw', path.relative(rawDir, full));
