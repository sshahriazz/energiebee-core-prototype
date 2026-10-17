// Devices (meters, EV) and their tariff agreements, with history kept so the build can read
// them as they stood at an earlier moment. Nothing is deleted:
//   - a device's details (gas unit, gas zone, EV status …) are versioned in device_attr_version;
//   - a device no longer used is retired (retired_at), not removed;
//   - a changed tariff history supersedes the old agreements and adds the new ones.
import { db, tx } from '../db/db.js';

const atClause = (alias, ms, from = 'recorded_at', to = 'superseded_at') => {
  const a = alias ? `${alias}.` : '';
  if (ms == null) return `${a}${to} IS NULL`;
  const t = Math.floor(ms);
  return `${a}${from} <= ${t} AND (${a}${to} IS NULL OR ${a}${to} > ${t})`;
};

// Record a device's details; writes a version only when they changed.
export function setDeviceAttrs(deviceId, attrs) {
  const json = JSON.stringify(attrs ?? {});
  const cur = db.prepare('SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? AND superseded_at IS NULL').get(deviceId);
  db.prepare('UPDATE device SET attrs = ? WHERE id = ?').run(json, deviceId);
  if (cur?.attrs === json) return false;
  const now = Math.max(Date.now(), (cur?.recorded_at ?? 0) + 1);   // versions always move forward, even within one millisecond
  tx(() => {
    db.prepare('UPDATE device_attr_version SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(now, deviceId);
    db.prepare('INSERT INTO device_attr_version (device_id, attrs, recorded_at) VALUES (?, ?, ?)').run(deviceId, json, now);
  });
  return true;
}

// A device's details as known at `atMs` (null = now). Before its first recorded version the
// earliest one is used and flagged, because earlier details were not kept.
export function deviceAttrsAt(deviceId, atMs = null) {
  const v = db.prepare(`SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? AND ${atClause('', atMs)}`).get(deviceId);
  if (v) return { attrs: JSON.parse(v.attrs), approximate: null };
  const first = db.prepare('SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? ORDER BY recorded_at LIMIT 1').get(deviceId);
  if (first) return { attrs: JSON.parse(first.attrs), approximate: first.recorded_at };
  const cur = db.prepare('SELECT attrs FROM device WHERE id = ?').get(deviceId);
  return { attrs: JSON.parse(cur?.attrs || '{}'), approximate: Date.now() };
}

// Devices in use at `atMs` (null = now), each with its details as known then.
export function devicesAt(siteId, where = '1', atMs = null) {
  const inUse = atMs == null ? 'retired_at IS NULL'
    : `(recorded_at IS NULL OR recorded_at <= ${Math.floor(atMs)}) AND (retired_at IS NULL OR retired_at > ${Math.floor(atMs)})`;
  return db.prepare(`SELECT * FROM device WHERE site_id = ? AND ${inUse} AND ${where}`).all(siteId).map((d) => {
    if (atMs == null) return { ...d, approximateAttrs: null };
    const { attrs, approximate } = deviceAttrsAt(d.id, atMs);
    return { ...d, attrs: JSON.stringify(attrs), approximateAttrs: approximate };
  });
}

// Retire a device and supersede its agreements (both kept for earlier moments).
export function retireDevice(deviceId) {
  const now = Date.now();
  tx(() => {
    db.prepare('UPDATE device SET retired_at = ? WHERE id = ? AND retired_at IS NULL').run(now, deviceId);
    db.prepare('UPDATE tariff_agreement SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(now, deviceId);
  });
}

// Replace a meter's current agreements with a new list: the old ones are superseded, not deleted.
export function supersedeAgreements(siteId, deviceId, rows) {
  const now = Date.now();
  tx(() => {
    db.prepare('UPDATE tariff_agreement SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(now, deviceId);
    const ins = db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(siteId, deviceId, r.tariffId, r.from, r.to ?? null, now);
  });
}

// Databases from before devices were versioned: when each device and agreement was first known
// is taken from the sync log (the first sync whose step for that provider succeeded); details
// get a first version now, flagged as not kept before. Idempotent.
export function seedDeviceHistory(siteId) {
  const firstOk = (provider) => {
    const runs = db.prepare("SELECT finished_at, detail FROM sync_run WHERE site_id = ? AND finished_at IS NOT NULL ORDER BY id").all(siteId);
    for (const r of runs) {
      try { if (JSON.parse(r.detail || '[]').some((s) => s.step === provider && s.ok)) return r.finished_at * 1000; } catch { /* unreadable log row */ }
    }
    return null;
  };
  const stepFor = { octopus: 'octopus', octopus_kraken: 'octopus', env: 'tariff' };
  for (const d of db.prepare('SELECT * FROM device WHERE site_id = ? AND recorded_at IS NULL').all(siteId)) {
    db.prepare('UPDATE device SET recorded_at = ? WHERE id = ?').run(firstOk(stepFor[d.provider] || d.provider) ?? Date.now(), d.id);
  }
  for (const a of db.prepare('SELECT a.id, d.recorded_at FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND a.recorded_at IS NULL').all(siteId)) {
    db.prepare('UPDATE tariff_agreement SET recorded_at = ? WHERE id = ?').run(a.recorded_at ?? Date.now(), a.id);
  }
  for (const d of db.prepare('SELECT id, attrs FROM device WHERE site_id = ?').all(siteId)) {
    if (!db.prepare('SELECT 1 FROM device_attr_version WHERE device_id = ?').get(d.id)) setDeviceAttrs(d.id, JSON.parse(d.attrs || '{}'));
  }
}
