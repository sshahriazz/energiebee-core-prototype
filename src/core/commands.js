// The control path as data: helpers around command and command_log (src/db/deltas/031-command.sql).
// TABLES ONLY, NO EXECUTOR YET: nothing in the core sends anything to a device. An executor would:
//   1. enqueueIfChanged(the desired state of the window it is in)   writes nothing when unchanged
//   2. expireStale()                                                 a late command is dropped
//   3. read the device; markSkipped() if it already runs the state, else send and markSent()
//   4. on the next cycle read back: markAcked() (acked only when it matches) or markFailed()
// The rules the database enforces itself (triggers): a command needs device_capability supported = 1,
// starts pending, is never sent after valid_until, never changes its desired state, has at most one
// open (pending or sent) row per device, and its final states are final; command_log is append-only.
import { db, tx } from '../db/db.js';
import { canonical, hashOf, capability } from './plans.js';

export const COMMAND_STATUSES = ['pending', 'sent', 'acked', 'failed', 'expired', 'cancelled', 'skipped_unchanged'];
const OPEN = "('pending', 'sent')";
// Typed copies of the desired state (camelCase accepted) -> command columns. windowStart / windowEnd:
// the charge window (or the one window of the action); exportStart / exportEnd: the export window
// (delta 032 added those two, reservePct, chargeRateW, dischargeRateW and currentA).
const TYPED = {
  action: 'action', windowStart: 'window_start', windowEnd: 'window_end', targetSocPct: 'target_soc_pct', limitPct: 'limit_pct', rateW: 'rate_w',
  setpointC: 'setpoint_c', mode: 'mode', reservePct: 'reserve_pct', chargeRateW: 'charge_rate_w', dischargeRateW: 'discharge_rate_w', currentA: 'current_a',
  exportStart: 'export_start', exportEnd: 'export_end',
};

// The neutral desired state with snake_case typed keys, nulls dropped, keys sorted (canonical()).
export function normaliseDesired(desired) {
  const out = {};
  for (const [k, v] of Object.entries(desired || {})) {
    if (v == null) continue;
    out[TYPED[k] ?? k] = v;
  }
  if (!out.action) throw new Error('a desired state needs an action');
  return JSON.parse(canonical(out));
}

const parse = (c) => (c ? { ...c, desired: JSON.parse(c.desired), reported: c.reported ? JSON.parse(c.reported) : null, diff: c.diff ? JSON.parse(c.diff) : null } : null);
const byId = (id) => db.prepare('SELECT * FROM command WHERE id = ?').get(id);
export const getCommand = (id) => parse(byId(id));
const log = (id, at, event, detail = null) => db.prepare('INSERT INTO command_log (command_id, at, event, detail) VALUES (?, ?, ?, ?)').run(id, at, event, detail == null ? null : canonical(detail));
export const commandLog = (id) => db.prepare('SELECT at, event, detail FROM command_log WHERE command_id = ? ORDER BY id').all(id).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

// The last state the device was confirmed to run (acked by read-back, or found already running).
export function lastAcked(deviceId) {
  return parse(db.prepare("SELECT * FROM command WHERE device_id = ? AND status IN ('acked', 'skipped_unchanged') ORDER BY acked_at DESC, id DESC LIMIT 1").get(deviceId));
}
const openCommand = (deviceId) => db.prepare(`SELECT * FROM command WHERE device_id = ? AND status IN ${OPEN}`).get(deviceId);

// Desired minus reported: {field: {desired, reported}} for every desired field the device reports
// differently (numbers within tolerance). Empty = the device runs the desired state.
export function diffState(desired, reported, tolerance = 1e-6) {
  const out = {};
  for (const [k, want] of Object.entries(desired)) {
    const got = reported?.[k];
    const same = typeof want === 'number' && typeof got === 'number' ? Math.abs(want - got) <= tolerance : canonical(want) === canonical(got ?? null);
    if (!same) out[k] = { desired: want, reported: got ?? null };
  }
  return out;
}

function cancel(c, now, reason) {
  db.prepare("UPDATE command SET status = 'cancelled' WHERE id = ?").run(c.id);
  log(c.id, now, 'cancelled', { reason });
}

/**
 * Queue a desired state for one device, only when it differs from the last state the device
 * confirmed. Writes nothing (written: false) when: the idempotency key was used ('duplicate'), the
 * open command already wants the same ('pending_same'), the last confirmed state is the same
 * ('unchanged'; an open command that wants something else is cancelled), or valid_until has passed
 * ('expired'). Otherwise an open command is cancelled and the new one supersedes it (or the last
 * confirmed one). Throws when the device is not known to deliver the action (device_capability).
 * force: queue even when equal to the last confirmed state (the device drifted from it).
 */
export function enqueueIfChanged({ deviceId, desired, planRunId = null, validFrom, validUntil, idempotencyKey = null, force = false, now = Date.now() }) {
  const d = normaliseDesired(desired);
  const dev = db.prepare('SELECT id, kind FROM device WHERE id = ?').get(deviceId);
  if (!dev) throw new Error(`no device ${deviceId}`);
  if (capability(deviceId, d.action) !== true) throw new Error(`device ${deviceId} (${dev.kind}) cannot deliver ${d.action}: no device_capability row with supported = 1`);
  if (!(Number.isInteger(validFrom) && Number.isInteger(validUntil) && validUntil > validFrom)) throw new RangeError('valid_from and valid_until are epoch seconds, valid_until after valid_from');
  const hash = hashOf(d);
  const key = idempotencyKey ?? hashOf([deviceId, hash, validFrom, validUntil]);
  return tx(() => {
    const dup = db.prepare('SELECT * FROM command WHERE idempotency_key = ?').get(key);
    if (dup) return { written: false, reason: 'duplicate', command: parse(dup) };
    if (validUntil * 1000 <= now) return { written: false, reason: 'expired', command: null };
    const open = openCommand(deviceId);
    if (open && open.desired_hash === hash && !force) return { written: false, reason: 'pending_same', command: parse(open) };
    if (open) cancel(open, now, 'superseded by a changed desired state');
    const last = lastAcked(deviceId);
    if (last && last.desired_hash === hash && !force) return { written: false, reason: 'unchanged', command: last, cancelled: open?.id ?? null };
    const typed = Object.values(TYPED).map((c) => d[c] ?? null);
    const id = Number(db.prepare(`INSERT INTO command (plan_run_id, device_id, requested_at, valid_from, valid_until, ${Object.values(TYPED).join(', ')},
        desired, desired_hash, idempotency_key, supersedes_command_id) VALUES (?, ?, ?, ?, ?, ${typed.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
      .run(planRunId, deviceId, now, validFrom, validUntil, ...typed, canonical(d), hash, key, open?.id ?? last?.id ?? null).lastInsertRowid);
    log(id, now, 'enqueued', { desired_hash: hash, supersedes: open?.id ?? last?.id ?? null });
    return { written: true, command: getCommand(id), cancelled: open?.id ?? null };
  });
}

function mustBe(c, id, statuses) {
  if (!c) throw new Error(`no command ${id}`);
  if (!statuses.includes(c.status)) throw new Error(`command ${id} is ${c.status}, not ${statuses.join(' or ')}`);
}

function expire(c, now) {
  db.prepare("UPDATE command SET status = 'expired' WHERE id = ?").run(c.id);
  log(c.id, now, 'expired', { valid_until: c.valid_until });
}

// The command was written to the device. A command past valid_until is expired instead (never sent late).
// registerWrites: how many registers or API writes it took (Predbat's write counter, PB-CTRL-17).
export function markSent(id, { now = Date.now(), registerWrites = null } = {}) {
  return tx(() => {
    const c = byId(id);
    mustBe(c, id, ['pending']);
    if (now > c.valid_until * 1000) { expire(c, now); return { sent: false, status: 'expired' }; }
    db.prepare("UPDATE command SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(now, id);
    log(id, now, 'sent', { attempt: c.attempts + 1, register_writes: registerWrites ?? undefined });
    return { sent: true, status: 'sent' };
  });
}

// The device's read-back. Acked only when it matches the desired state; otherwise the difference is
// kept (diff, reported, the raw payload) and the command stays sent.
export function markAcked(id, { reported, rawId = null, tolerance = 1e-6, now = Date.now() } = {}) {
  return tx(() => {
    const c = byId(id);
    mustBe(c, id, ['sent']);
    const diff = diffState(JSON.parse(c.desired), reported, tolerance);
    const matched = Object.keys(diff).length === 0;
    db.prepare(`UPDATE command SET reported = ?, diff = ?, readback_raw_id = ?${matched ? ", status = 'acked', acked_at = ?" : ''} WHERE id = ?`)
      .run(canonical(reported ?? {}), canonical(diff), rawId, ...(matched ? [now] : []), id);
    log(id, now, matched ? 'acked' : 'readback', matched ? null : { diff });
    return { acked: matched, diff };
  });
}

// Read before writing: the device already runs the desired state, so nothing is written to it.
export function markSkipped(id, { reported, rawId = null, tolerance = 1e-6, now = Date.now() } = {}) {
  return tx(() => {
    const c = byId(id);
    mustBe(c, id, ['pending']);
    const diff = diffState(JSON.parse(c.desired), reported, tolerance);
    if (Object.keys(diff).length) throw new Error(`command ${id}: the device does not run the desired state (${Object.keys(diff).join(', ')})`);
    db.prepare("UPDATE command SET status = 'skipped_unchanged', acked_at = ?, reported = ?, diff = '{}', readback_raw_id = ? WHERE id = ?").run(now, canonical(reported), rawId, id);
    log(id, now, 'skipped_unchanged');
    return { status: 'skipped_unchanged' };
  });
}

// A write failed. retry: back to pending while attempts < maxAttempts and valid_until has not passed.
export function markFailed(id, error, { retry = false, maxAttempts = 3, now = Date.now() } = {}) {
  return tx(() => {
    const c = byId(id);
    mustBe(c, id, ['pending', 'sent']);
    const again = retry && c.attempts < maxAttempts && now <= c.valid_until * 1000;
    db.prepare(`UPDATE command SET status = ?, last_error = ? WHERE id = ?`).run(again ? 'pending' : 'failed', String(error), id);
    log(id, now, again ? 'retry' : 'failed', { error: String(error), attempts: c.attempts });
    return { status: again ? 'pending' : 'failed' };
  });
}

export function cancelCommand(id, reason, { now = Date.now() } = {}) {
  return tx(() => {
    const c = byId(id);
    mustBe(c, id, ['pending', 'sent']);
    cancel(c, now, reason);
    return { status: 'cancelled' };
  });
}

// Every open command whose valid_until has passed becomes expired. Returns their ids.
export function expireStale({ now = Date.now() } = {}) {
  return tx(() => {
    const due = db.prepare(`SELECT * FROM command WHERE status IN ${OPEN} AND valid_until * 1000 <= ?`).all(now);
    for (const c of due) expire(c, now);
    return { expired: due.length, ids: due.map((c) => c.id) };
  });
}

// What the executor observed but never planned, logged against the command in force (event
// 'observed', detail.state): Predbat's derived states (hold_charging, hold_exporting, hold_for_car),
// a control conflict (detail: control, set, read; PB-CTRL-18), a control failure (requested and
// measured W, minutes not following; PB-CTRL-19), calibration, a stand-aside event or clock skew.
// Counts per day are queries on command_log.
export function logObserved(id, state, { now = Date.now(), detail = {} } = {}) {
  if (!byId(id)) throw new Error(`no command ${id}`);
  log(id, now, 'observed', { state, ...detail });
}
