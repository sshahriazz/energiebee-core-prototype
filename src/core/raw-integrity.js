// Are the raw files still what they were when they landed? (plan phase 1.7)
// A receipt's row holds the hash of its source, status and text (landRaw); the file holds the text, sealed with the home's
// key unless it is public data. The check opens every file the way a reader does, hashes the text and compares. It reads
// only: it never changes a file or a row, and it never prints a payload (ids, names and counts).
//
// What it finds, per receipt:
//   ok           the text hashes to the stored hash
//   mismatch     the file opens and its text is not the text that landed (a file replaced, edited or written by something else)
//   corrupt      a sealed file that does not decrypt (changed, or cut short; the GCM tag fails)
//   missing      no file in the raw store (a store that is not mounted, a file lost, or removed outside retention)
//   unreadable   the file is there and the disk refuses it
//   keyLost      a sealed file of a home that still exists, whose key is gone: nothing can open it again
//   unverifiable a sealed file with no home (its home was erased and the row was kept as shared evidence): by design nobody
//                can open it, so its hash cannot be checked
//   unsealed     (also counted as ok) a home's file stored as plain text although its source is not public: scripts/seal-raw.js seals it
// Everything except ok and unverifiable is a problem and is listed.
import { db } from '../db/db.js';
import { openRaw, rawHash, sealsRaw } from './facts.js';

const DAY_MS = 86400000;
const MODES = ['off', 'report'];

// RAW_VERIFY (off | report, default report): the check at start-up and once a day. RAW_VERIFY_DAYS (default 7): over how many days
// every receipt is checked once, each run taking the slice of ids that is due that day, so a large store is never read in one go.
export function rawVerifySettings(env = process.env) {
  const mode = env.RAW_VERIFY == null || env.RAW_VERIFY === '' ? 'report' : String(env.RAW_VERIFY);
  if (!MODES.includes(mode)) throw new RangeError(`RAW_VERIFY must be one of ${MODES.join(', ')}, not ${JSON.stringify(mode)}`);
  const v = env.RAW_VERIFY_DAYS;
  const days = v == null || v === '' ? 7 : Number(v);
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`RAW_VERIFY_DAYS must be a whole number of days >= 1, not ${JSON.stringify(v)}`);
  return { mode, days };
}
// The slice of receipts due on a day: ids whose remainder modulo `of` is the day number modulo `of`.
export const sliceFor = (now, of) => ({ index: Math.floor(now / DAY_MS) % of, of });

let last = null;
// The report of the latest run in this process (null before the first).
export const lastRawCheck = () => last;

export async function verifyRaw({ siteId = null, slice = null, batch = 500, maxProblems = 200, now = Date.now() } = {}) {
  if (slice && !(Number.isInteger(slice.of) && slice.of >= 1 && Number.isInteger(slice.index) && slice.index >= 0 && slice.index < slice.of)) throw new RangeError('slice is { index, of } with 0 <= index < of');
  const out = { at: now, scope: { siteId, slice }, checked: 0, ok: 0, mismatch: 0, corrupt: 0, missing: 0, unreadable: 0, keyLost: 0, unverifiable: 0, unsealed: 0, bytes: 0, problems: [], problemsBySite: {}, truncated: false, ms: 0 };
  const where = [siteId != null ? 'p.site_id = ?::bigint' : null, slice && slice.of > 1 ? 'p.id % ?::bigint = ?::bigint' : null].filter(Boolean);
  const args = [...(siteId != null ? [siteId] : []), ...(slice && slice.of > 1 ? [slice.of, slice.index] : [])];
  const page = db.prepare(`SELECT p.id, p.site_id, p.hash, p.file, p.status, src.code AS source FROM raw_payload p JOIN source src ON src.id = p.source_id
    WHERE p.id > ?::bigint${where.map((w) => ` AND ${w}`).join('')} ORDER BY p.id LIMIT ?::bigint`);
  const flag = (r, state) => {
    out.problemsBySite[r.site_id ?? 'none'] = (out.problemsBySite[r.site_id ?? 'none'] ?? 0) + 1;
    if (out.problems.length < maxProblems) out.problems.push({ id: r.id, siteId: r.site_id, source: r.source, file: r.file, state });
    else out.truncated = true;
  };
  const t0 = performance.now();
  let after = 0;
  for (;;) {
    const rows = await page.all(after, ...args, batch);
    if (!rows.length) break;
    for (const r of rows) {
      out.checked++;
      const o = await openRaw(r);
      out.bytes += o.bytes ?? 0;
      if (o.state === 'ok') {
        if (rawHash(r.source, r.status, o.text) === r.hash) {
          out.ok++;
          if (!o.sealed && await sealsRaw(r.source, r.site_id)) { out.unsealed++; flag(r, 'unsealed'); }
        } else { out.mismatch++; flag(r, 'mismatch'); }
      } else if (o.state === 'key_gone') {
        if (r.site_id == null) out.unverifiable++; else { out.keyLost++; flag(r, 'keyLost'); }
      } else { out[o.state]++; flag(r, o.state); }
    }
    after = rows[rows.length - 1].id;
    await new Promise((resolve) => setImmediate(resolve));   // the server answers requests between batches
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

// The run the start-up hook and the daily timer do: the slice due today, remembered for the health page.
export async function runRawCheck({ now = Date.now(), env = process.env } = {}) {
  const s = rawVerifySettings(env);
  if (s.mode === 'off') return null;
  last = await verifyRaw({ slice: sliceFor(now, s.days), now });
  return last;
}

// Once a day while the server runs (the start-up run covers the day it starts); a failure is logged, never thrown.
export function startRawCheckSchedule() {
  if (rawVerifySettings().mode === 'off') return;
  setInterval(async () => {
    try { console.log(rawCheckSummary(await runRawCheck())); } catch (err) { console.error('raw check:', err.message); }
  }, DAY_MS).unref();
}

// One line for a log: counts only.
export function rawCheckSummary(r) {
  if (!r) return 'raw file check: off';
  const bad = r.mismatch + r.corrupt + r.missing + r.unreadable + r.keyLost + r.unsealed;
  const part = r.scope.slice && r.scope.slice.of > 1 ? ` (day ${r.scope.slice.index + 1} of ${r.scope.slice.of})` : '';
  return `raw file check${part}: ${r.checked} receipts, ${(r.bytes / 1e6).toFixed(1)} MB read in ${r.ms} ms, ${r.ok} match their hash`
    + (bad ? `; PROBLEMS ${bad}: ${r.mismatch} changed, ${r.corrupt} corrupt, ${r.missing} missing, ${r.unreadable} unreadable, ${r.keyLost} without key, ${r.unsealed} not sealed` : '; no problems')
    + (r.unverifiable ? `; ${r.unverifiable} sealed files of erased homes cannot be checked` : '');
}
