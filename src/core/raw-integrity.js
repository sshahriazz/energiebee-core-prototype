// Are the raw files still what they were when they landed? (plan phase 1.7)
// A receipt's row holds the hash of its source, status and text (landRaw); the file holds the text, sealed with the home's
// key unless it is public data. The check opens a file the way a reader does, hashes the text and compares. It never changes
// a file or a raw_payload row and never prints a payload (ids, names and counts). Its own records: raw_payload_check (when each
// receipt was last checked, and the state it was found in) and raw_check_run (a log: one row per run, one per home in it).
//
// What it finds, per receipt:
//   ok         the text hashes to the stored hash
//   mismatch   the file opens and its text is not the text that landed (a file replaced, edited or written by something else)
//   corrupt    a sealed file that does not decrypt (changed, or cut short; the GCM tag fails)
//   missing    no file in the raw store (a store that is not mounted, a file lost, or removed outside retention)
//   unreadable the file is there and the disk refuses it
//   erased     a sealed file whose home key is gone: nothing can open it again, by design (the home was deleted, its key with
//              it). Not a problem
//   unsealed   the hash matches, but a home's file is stored as plain text although its source is not public:
//              scripts/seal-raw.js seals it
// Everything except ok and erased is a problem and is listed.
//
// Not checked at all: a row whose name is 'redacted-<id>' (scripts/make-fixture.js anonymises the file names of a fixture, so
// no file exists for it by design). Any other name that is not in the raw store is 'missing'.
//
// Which receipts: a run takes the N checked longest ago (never-checked first), N = RAW_VERIFY_BATCH, so a store is covered in
// turn however often the server restarts or is down, and the work of one run does not grow with the store. A by-hand run
// (npm run raw:verify) takes everything unless it is given a limit.
import { db } from '../db/db.js';
import { nowSec } from './time.js';
import { openRaw, rawHash, sealsRaw } from './facts.js';

const MODES = ['off', 'report'];
const PROBLEM_STATES = ['mismatch', 'corrupt', 'missing', 'unreadable', 'unsealed'];

// RAW_VERIFY (off | report, default report): the check after start-up and then every RAW_VERIFY_HOURS (default 6).
// RAW_VERIFY_BATCH (default 500): how many receipts one run opens, the least recently checked first.
// RAW_VERIFY_HOURS is at most 596: a timer longer than 2^31-1 ms (596.5 h) does not fit Node's 32-bit timer, which then fires
// every millisecond. A longer interval is a job of cron: npm run raw:verify.
const MAX_HOURS = 596;
export function rawVerifySettings(env = process.env) {
  const mode = env.RAW_VERIFY == null || env.RAW_VERIFY === '' ? 'report' : String(env.RAW_VERIFY);
  if (!MODES.includes(mode)) throw new RangeError(`RAW_VERIFY must be one of ${MODES.join(', ')}, not ${JSON.stringify(mode)}`);
  const whole = (name, dflt, max = Infinity) => {
    const v = env[name];
    const n = v == null || v === '' ? dflt : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${name} must be a whole number from 1${max < Infinity ? ` to ${max}` : ''}, not ${JSON.stringify(v)}`);
    return n;
  };
  return { mode, batch: whole('RAW_VERIFY_BATCH', 500), hours: whole('RAW_VERIFY_HOURS', 6, MAX_HOURS) };
}

const emptyCounts = () => ({ checked: 0, ok: 0, mismatch: 0, corrupt: 0, missing: 0, unreadable: 0, erased: 0, unsealed: 0, bytes: 0 });

// The receipts the check covers (see the header: names the fixture redacted are not).
const CHECKED = "p.file NOT LIKE 'redacted-%'";

// The receipts a run takes: ids never checked, then the ones checked longest ago.
async function pickIds(siteId, limit) {
  const site = siteId != null ? ' AND p.site_id = ?::bigint' : '';
  const args = siteId != null ? [siteId] : [];
  const fresh = (await db.prepare(`SELECT p.id FROM raw_payload p WHERE ${CHECKED} AND NOT EXISTS (SELECT 1 FROM raw_payload_check c WHERE c.payload_id = p.id)${site} ORDER BY p.id LIMIT ?::bigint`)
    .all(...args, limit)).map((r) => r.id);
  if (fresh.length >= limit) return fresh;
  const old = (await db.prepare(`SELECT c.payload_id AS id FROM raw_payload_check c JOIN raw_payload p ON p.id = c.payload_id WHERE ${CHECKED}${site} ORDER BY c.checked_at, c.payload_id LIMIT ?::bigint`)
    .all(...args, limit - fresh.length)).map((r) => r.id);
  return [...fresh, ...old];
}

const ROW = 'SELECT p.id, p.site_id, p.hash, p.file, p.status, src.code AS source FROM raw_payload p JOIN source src ON src.id = p.source_id';

// Check receipts and record what was found. { siteId } limits it to one home; { limit } takes that many of the least recently
// checked (default: all of them, in id order); { trigger } is what the log row says started it.
export async function verifyRaw({ siteId = null, limit = null, trigger = 'cli', batch = 500, maxProblems = 200 } = {}) {
  if (limit != null && !(Number.isInteger(limit) && limit >= 1)) throw new RangeError('limit is a whole number >= 1');
  if (siteId != null && !Number.isInteger(siteId)) throw new RangeError('siteId is a whole number');
  const at = nowSec();
  const out = { at, scope: { siteId, limit }, ...emptyCounts(), problems: [], problemsBySite: {}, truncated: false, ms: 0 };
  const bySite = new Map();   // site id -> counts of this run (null: receipts of no home)
  const t0 = performance.now();
  const picked = limit != null ? await pickIds(siteId, limit) : null;

  const flag = (r, state) => {
    out.problemsBySite[r.site_id ?? 'none'] = (out.problemsBySite[r.site_id ?? 'none'] ?? 0) + 1;
    if (out.problems.length < maxProblems) out.problems.push({ id: r.id, siteId: r.site_id, source: r.source, file: r.file, state });
    else out.truncated = true;
  };
  const stateOf = async (r) => {
    const o = await openRaw(r);
    out.bytes += o.bytes ?? 0;
    const home = bySite.get(r.site_id) ?? bySite.set(r.site_id, emptyCounts()).get(r.site_id);
    home.bytes += o.bytes ?? 0;
    if (o.state === 'key_gone') return 'erased';
    if (o.state !== 'ok') return o.state;
    if (rawHash(r.source, r.status, o.text) !== r.hash) return 'mismatch';
    return !o.sealed && await sealsRaw(r.source, r.site_id) ? 'unsealed' : 'ok';
  };

  let after = 0;
  for (let from = 0; ; from += batch) {
    let rows;
    if (picked) {
      const ids = picked.slice(from, from + batch);
      if (!ids.length) break;
      rows = await db.prepare(`${ROW} WHERE p.id IN (SELECT value::bigint FROM jsonb_array_elements_text(?::jsonb)) ORDER BY p.id`).all(JSON.stringify(ids));
    } else {
      rows = await db.prepare(`${ROW} WHERE ${CHECKED} AND p.id > ?::bigint${siteId != null ? ' AND p.site_id = ?::bigint' : ''} ORDER BY p.id LIMIT ?::bigint`)
        .all(after, ...(siteId != null ? [siteId] : []), batch);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
    }
    const results = [];
    for (const r of rows) {
      let state = await stateOf(r);
      // A file that is gone because retention or an erasure just deleted its receipt is not a finding.
      if (state === 'missing' && !await db.prepare('SELECT 1 AS x FROM raw_payload WHERE id = ?').get(r.id)) continue;
      out.checked++; out[state]++;
      const home = bySite.get(r.site_id);
      home.checked++; home[state]++;
      if (PROBLEM_STATES.includes(state)) flag(r, state);
      results.push({ id: r.id, site: r.site_id, state });
    }
    // A receipt or home erased while the run was reading is not recorded.
    await db.prepare(`INSERT INTO raw_payload_check (payload_id, site_id, checked_at, state)
      SELECT (e->>'id')::bigint, (e->>'site')::bigint, ?::bigint, e->>'state' FROM jsonb_array_elements(?::jsonb) e
       WHERE EXISTS (SELECT 1 FROM raw_payload WHERE id = (e->>'id')::bigint)
         AND ((e->>'site') IS NULL OR EXISTS (SELECT 1 FROM site WHERE id = (e->>'site')::bigint))
      ON CONFLICT (payload_id) DO UPDATE SET site_id = EXCLUDED.site_id, checked_at = EXCLUDED.checked_at, state = EXCLUDED.state`)
      .run(at, JSON.stringify(results));
    await new Promise((resolve) => setImmediate(resolve));   // the server answers requests between batches
  }
  out.ms = Math.round(performance.now() - t0);
  await logRun(out, bySite, trigger);
  return out;
}

// One log row for the run and one for each home that had receipts in it.
async function logRun(out, bySite, trigger) {
  const insert = db.prepare(`INSERT INTO raw_check_run (site_id, ran_at, trigger, checked, ok, mismatch, corrupt, missing, unreadable, erased, unsealed, bytes, ms)
    SELECT ?::bigint, ?::bigint, ?::text, ?::int, ?::int, ?::int, ?::int, ?::int, ?::int, ?::int, ?::int, ?::bigint, ?::int WHERE ?::bigint IS NULL OR EXISTS (SELECT 1 FROM site WHERE id = ?::bigint)`);
  const row = async (siteId, c, ms) => await insert.run(siteId, out.at, trigger, c.checked, c.ok, c.mismatch, c.corrupt, c.missing, c.unreadable, c.erased, c.unsealed, c.bytes, ms, siteId, siteId);
  await row(null, out, out.ms);
  for (const [siteId, c] of bySite) if (siteId != null) await row(siteId, c, null);   // the time of a run is not split by home
}

// The latest result for one home: its last run, and the state each of its receipts was last found in (so a damaged file stays
// in the list until a later check finds it fine, whichever run it was seen in). null before the home has been checked.
export async function rawCheckOfHome(siteId) {
  const last = await db.prepare('SELECT ran_at, trigger, checked, bytes FROM raw_check_run WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId);
  if (!last) return null;
  const n = async (sql) => Number((await db.prepare(sql).get(siteId)).n);
  return {
    at: last.ran_at, trigger: last.trigger, checkedInRun: last.checked,
    receipts: await n("SELECT COUNT(*) AS n FROM raw_payload WHERE site_id = ? AND file NOT LIKE 'redacted-%'"),
    covered: await n('SELECT COUNT(*) AS n FROM raw_payload_check WHERE site_id = ?'),
    problems: await n(`SELECT COUNT(*) AS n FROM raw_payload_check WHERE site_id = ? AND state IN (${PROBLEM_STATES.map((s) => `'${s}'`).join(', ')})`),
    problemList: (await db.prepare(`SELECT c.payload_id AS id, src.code AS source, c.state, c.checked_at AS "checkedAt" FROM raw_payload_check c
      JOIN raw_payload p ON p.id = c.payload_id JOIN source src ON src.id = p.source_id
      WHERE c.site_id = ? AND c.state IN (${PROBLEM_STATES.map((s) => `'${s}'`).join(', ')}) ORDER BY c.payload_id LIMIT 50`).all(siteId)),
  };
}

let running = false;
// The run the start-up and the timer do: the least recently checked receipts, up to RAW_VERIFY_BATCH. A run that would overlap
// one still going is skipped (null), like a run with RAW_VERIFY=off.
export async function runRawCheck({ env = process.env, trigger = 'timer' } = {}) {
  const s = rawVerifySettings(env);
  if (s.mode === 'off' || running) return null;
  running = true;
  try { return await verifyRaw({ limit: s.batch, trigger }); } finally { running = false; }
}

// The settings are read (and refused when wrong) by the caller before the port opens. A first run just after the server listens, then one every RAW_VERIFY_HOURS. Background work on purpose: nothing awaits it, a
// failure is logged and never thrown, and the timer does not keep the process alive.
export function startRawCheckSchedule(s = rawVerifySettings()) {
  if (s.mode === 'off') { console.log(rawCheckSummary(null)); return; }
  const go = async (trigger) => {
    try { console.log(rawCheckSummary(await runRawCheck({ trigger }))); } catch (err) { console.error('raw check:', err.message); }
  };
  setImmediate(() => { void go('start'); });
  setInterval(() => { void go('timer'); }, s.hours * 3600 * 1000).unref();
}

// One line for a log: counts only.
export function rawCheckSummary(r) {
  if (!r) return 'raw file check: off or already running';
  const bad = PROBLEM_STATES.reduce((n, k) => n + r[k], 0);
  return `raw file check: ${r.checked} receipts${r.scope.limit ? ` (the ${r.scope.limit} least recently checked)` : ''}, ${(r.bytes / 1e6).toFixed(1)} MB read in ${r.ms} ms, ${r.ok} match their hash`
    + (bad ? `; PROBLEMS ${bad}: ${r.mismatch} changed, ${r.corrupt} corrupt, ${r.missing} missing, ${r.unreadable} unreadable, ${r.unsealed} not sealed` : '; no problems')
    + (r.erased ? `; ${r.erased} sealed files of erased homes cannot be checked` : '');
}
