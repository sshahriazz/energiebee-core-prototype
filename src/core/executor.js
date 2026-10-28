// The control executor (Stage 4, docs/control-readback.md). One cycle for one home:
//   expire what is past valid_until, ask each device what it runs (a driver read, ingested as STATE facts through the
//   device's channels), then for the open command of each device:
//     pending  -> the device already runs it: skipped_unchanged, nothing written. Otherwise send, then sent.
//     sent     -> read back: acked only when the DEVICE says it runs the desired state (diffState); not yet: wait; still
//                 not after settleS: retry (back to pending) up to maxAttempts, then failed.
//   afterwards: a command that expired but was in fact applied (the device runs it) is recorded applied_late, and an acked
//   command whose check period has ended gets its effect checked against telemetry (verified | not_verified).
// The device's own read-back decides at every step, never the database's belief. A driver is
//   { source, read(device, { now }) -> observations [{ kind: 'state' | 'ack', point, ts, value, ref, commandId }],
//     send(device, desired, { now }) -> { accepted, ackRef?, error? } }
// where source is the source code the device's channels belong to. createSimulatedDriver is a device in memory for tests.
import { db } from '../db/db.js';
import { ingestObservations } from './channels.js';
import { expireStale, markSent, markSkipped, markAcked, markFailed, markAppliedLate, recordAckRef, setVerify, getCommand, diffState, logObserved } from './commands.js';
import { readReported, checkEffect, STANDARD_POINTS, DEFAULT_MODES } from './control.js';

const LATE_WINDOW_MS = 24 * 3600 * 1000;   // how long after expiry a sent command is still checked for having been applied

function reportedFor(device, desired, now) {
  const r = readReported(device.id, desired, now);
  const mapped = Object.fromEntries(Object.entries(desired).filter(([k]) => r.compared.includes(k)));
  return { ...r, desiredMapped: mapped };
}

// devices: only these device ids (default: every device of the home that the driver handles). A driver may add
// handles(device) -> boolean so one vendor's driver never touches another vendor's device.
export async function runControlCycle(siteId, { driver, now = Date.now(), maxAttempts = 3, settleS = 0, devices: only = null } = {}) {
  if (!driver?.read || !driver?.send || !driver?.source) throw new Error('a driver needs source, read(device) and send(device, desired)');
  const out = { expired: expireStale({ now }).ids, devices: [] };
  const candidates = db.prepare(`SELECT DISTINCT d.* FROM device d JOIN command c ON c.device_id = d.id
    WHERE d.site_id = ? AND (c.status IN ('pending', 'sent')
      OR (c.status = 'expired' AND c.sent_at IS NOT NULL AND c.applied_late_at IS NULL AND c.valid_until * 1000 > ?)
      OR (c.status = 'acked' AND c.verify_status IS NULL))`).all(siteId, now - LATE_WINDOW_MS);
  const devices = candidates.filter((d) => (only ? only.includes(d.id) : true) && (driver.handles ? driver.handles(d) : true));

  for (const device of devices) {
    const step = { deviceId: device.id, did: [] };
    out.devices.push(step);
    // 1. Ask the device. Its answers become state facts (checked against the channels); receipts come back separately.
    const obs = await driver.read(device, { now });
    const ing = ingestObservations(siteId, driver.source, obs, null, { deviceId: device.id });
    step.rejected = ing.rejected;
    for (const ack of ing.acks) {
      const c = ack.commandId != null ? getCommand(ack.commandId) : null;
      if (c) { recordAckRef(c.id, ack.ref, { now }); step.did.push(`ack_ref ${c.id}`); }
    }

    // 2. The open command.
    const open = db.prepare("SELECT id FROM command WHERE device_id = ? AND status IN ('pending', 'sent')").get(device.id);
    if (open) {
      const c = getCommand(open.id);
      const rb = reportedFor(device, c.desired, now);
      if (!rb.compared.length) {
        markFailed(c.id, 'the device has no state point that reports this command, so it cannot be read back', { now });
        step.did.push(`failed ${c.id} (no read-back)`);
      } else if (c.status === 'pending') {
        if (!Object.keys(diffState(rb.desiredMapped, rb.reported)).length && !rb.missing.length) {
          markSkipped(c.id, { reported: rb.reported, now, compare: rb.compared });
          step.did.push(`skipped_unchanged ${c.id}`);
        } else if (now > c.valid_until * 1000) {
          expireStale({ now }); step.did.push(`expired ${c.id}`);
        } else {
          const res = await driver.send(device, c.desired, { now });
          if (!res?.accepted) {
            const r = markFailed(c.id, res?.error ?? 'the device did not accept the write', { retry: true, maxAttempts, now });
            step.did.push(`send_refused ${c.id} -> ${r.status}`);
          } else {
            markSent(c.id, { now, registerWrites: res.registerWrites ?? null });
            if (res.ackRef != null) recordAckRef(c.id, res.ackRef, { now });
            step.did.push(`sent ${c.id}`);
          }
        }
      } else if (c.status === 'sent') {
        const diff = diffState(rb.desiredMapped, rb.reported);
        if (!Object.keys(diff).length && !rb.missing.length) {
          markAcked(c.id, { reported: rb.reported, now, compare: rb.compared });
          if (rb.unverifiable.length) logObserved(c.id, 'unverifiable_fields', { now, detail: { fields: rb.unverifiable } });
          step.did.push(`acked ${c.id}`);
        } else if (now - c.sent_at < settleS * 1000) {
          step.did.push(`waiting ${c.id}`);
        } else {
          markAcked(c.id, { reported: rb.reported, now, compare: rb.compared });   // keeps reported and the diff on the row; stays sent
          const r = markFailed(c.id, `read-back differs: ${Object.keys(diff).join(', ') || rb.missing.join(', ')}`, { retry: true, maxAttempts, now });
          step.did.push(`readback_mismatch ${c.id} -> ${r.status}`);
        }
      }
    }

    // 3. Expired but applied: the device runs a command whose time had passed.
    for (const e of db.prepare("SELECT id FROM command WHERE device_id = ? AND status = 'expired' AND sent_at IS NOT NULL AND applied_late_at IS NULL AND valid_until * 1000 > ?").all(device.id, now - LATE_WINDOW_MS)) {
      const c = getCommand(e.id);
      const rb = reportedFor(device, c.desired, now);
      if (!rb.compared.length || rb.missing.length) continue;
      const r = markAppliedLate(c.id, { reported: rb.reported, now, compare: rb.compared });
      if (r.appliedLate) step.did.push(`applied_late ${c.id}`);
    }

    // 4. Effect check of acked commands.
    for (const a of db.prepare("SELECT id FROM command WHERE device_id = ? AND status = 'acked' AND verify_status IS NULL").all(device.id)) {
      const c = getCommand(a.id);
      const e = checkEffect(c, now);
      if (e.status === 'verified' || e.status === 'not_verified') { setVerify(c.id, e.status, e.evidence, { now }); step.did.push(`${e.status} ${c.id}`); }
    }
  }
  return out;
}

/**
 * A device in memory. It holds the settings the standard control points report, applies a command when written, and
 * answers a read with its state points. Options let a test make it misbehave:
 *   ignoreWrites    it accepts a write and changes nothing (read-back never matches)
 *   applyAfterMs    it applies a write only this long after it arrives (a slow device)
 *   refuseNext      it refuses the next n writes
 *   noAckRef        it gives no receipt reference
 * It reports state at the cycle's own clock, so a test controls time with `now`.
 */
export function createSimulatedDriver({ source, modes = DEFAULT_MODES, initial = {}, ignoreWrites = false, applyAfterMs = 0, refuseNext = 0, noAckRef = false } = {}) {
  const codeOf = Object.fromEntries(Object.entries(modes).map(([c, w]) => [w, Number(c)]));
  const settings = { work_mode: codeOf.demand ?? 0, charge_target_soc: 100, reserve: 4, export_floor: 100, charge_window_start_min: 0, charge_window_end_min: 0, charge_rate_w: 3000, discharge_rate_w: 3000, setpoint: 20, ...initial };
  const pending = [];
  const sim = {
    source, settings, writes: [], options: { ignoreWrites, applyAfterMs, refuseNext, noAckRef },
    apply(desired, tz) {
      const set = (k, v) => { if (v != null) settings[k] = v; };
      set('work_mode', codeOf[desired.action]);
      set('charge_target_soc', desired.target_soc_pct ?? (desired.action === 'charge' ? desired.limit_pct : undefined));
      set('export_floor', desired.action === 'export' ? desired.limit_pct : undefined);
      set('reserve', desired.reserve_pct);
      set('charge_rate_w', desired.charge_rate_w ?? (desired.action === 'charge' ? desired.rate_w : undefined));
      set('discharge_rate_w', desired.discharge_rate_w ?? (desired.action === 'export' ? desired.rate_w : undefined));
      set('setpoint', desired.setpoint_c);
      if (desired.window_start != null) set('charge_window_start_min', sim.minuteOfDay(desired.window_start, tz));
      if (desired.window_end != null) set('charge_window_end_min', sim.minuteOfDay(desired.window_end, tz));
    },
    minuteOfDay: (ts, tz) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts * 1000)); return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value); },
    async read(device, { now }) {
      const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(device.site_id).timezone;
      for (const p of pending.filter((x) => x.at <= now)) { sim.apply(p.desired, tz); pending.splice(pending.indexOf(p), 1); }
      const ts = Math.floor(now / 1000);
      const obs = STANDARD_POINTS.map(([point]) => ({ kind: 'state', point, ts, value: settings[point === 'work_mode' ? 'work_mode' : point] }));
      for (const a of sim.acks.splice(0)) obs.push({ kind: 'ack', ts, ref: a.ref, commandId: a.commandId });
      return obs;
    },
    acks: [],
    async send(device, desired, { now }) {
      sim.writes.push({ at: now, desired });
      if (sim.options.refuseNext > 0) { sim.options.refuseNext--; return { accepted: false, error: 'device busy' }; }
      const tz = db.prepare('SELECT timezone FROM site WHERE id = ?').get(device.site_id).timezone;
      if (!sim.options.ignoreWrites) {
        if (sim.options.applyAfterMs > 0) pending.push({ at: now + sim.options.applyAfterMs, desired }); else sim.apply(desired, tz);
      }
      const ref = sim.options.noAckRef ? undefined : `ref-${sim.writes.length}`;
      return { accepted: true, ackRef: ref };
    },
  };
  return sim;
}
