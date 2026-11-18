// Devices (meters, EV) and their tariff agreements, with history kept so the build can read
// them as they stood at an earlier moment. Nothing is deleted:
//   - a device's details (gas unit, gas zone, EV status …) are versioned in device_attr_version;
//   - a device no longer used is retired (retired_at), not removed;
//   - a changed tariff history supersedes the old agreements and adds the new ones.
import { db, tx } from '../db/db.js';
import { mapAsync } from "./async.js";
import { markHomeDirty } from './price-marks.js';

const atClause = (alias, ms, from = 'recorded_at', to = 'superseded_at') => {
  const a = alias ? `${alias}.` : '';
  if (ms == null) return `${a}${to} IS NULL`;
  const t = Math.floor(ms);
  return `${a}${from} <= ${t} AND (${a}${to} IS NULL OR ${a}${to} > ${t})`;
};

// Device kinds (device_kind, delta 020, seeded from src/db/seed/attributes.js): battery, inverter,
// meters, ev, ev_charger, immersion, heat_pump, boiler, thermostat, trv, temperature_sensor,
// hot_water_tank, smart_plug ... each passive or controllable, with the attribute keys and action
// codes it has. A new kind is one registry row. The database refuses a device of a kind with no
// row (triggers device_kind_known_*); checkDeviceKind says so first, in words.
// The action codes are those the kind row lists plus any device_action (delta 030, the authority
// on actions) defines for the kind, so the two registries cannot drift apart.
const parseKind = async (r) => {
  if (!r) return r;
  const listed = JSON.parse(r.action_codes);
  const defined = (await db.prepare('SELECT action FROM device_action WHERE device_kind = ? ORDER BY action').all(r.kind)).map((a) => a.action);
  return { ...r, attribute_keys: JSON.parse(r.attribute_keys), action_codes: [...listed, ...defined.filter((a) => !listed.includes(a))] };
};
export const deviceKind = async (kind) => await parseKind(await db.prepare('SELECT * FROM device_kind WHERE kind = ?').get(kind));
export const deviceKinds = async () => await mapAsync(await db.prepare('SELECT * FROM device_kind ORDER BY kind').all(), parseKind);
export async function checkDeviceKind(kind) {
  const k = await deviceKind(kind);
  if (!k) throw new RangeError(`unknown device kind ${kind}: one of ${(await deviceKinds()).map((d) => d.kind).join(', ')} (a new kind is one device_kind row)`);
  return k;
}

// Record a device's details; writes a version only when they changed. These are a provider's
// free-form details; a planner's typed figures (rates, limits, curves) go through
// setDeviceAttribute (src/core/attributes.js), checked against the attribute registry.
export async function setDeviceAttrs(deviceId, attrs) {
  const json = JSON.stringify(attrs ?? {});
  const cur = await db.prepare('SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? AND superseded_at IS NULL').get(deviceId);
  await db.prepare('UPDATE device SET attrs = ? WHERE id = ?').run(json, deviceId);
  if (cur?.attrs === json) return false;
  const now = Math.max(Date.now(), (cur?.recorded_at ?? 0) + 1);   // versions always move forward, even within one millisecond
  await tx(async () => {
        await db.prepare('UPDATE device_attr_version SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(now, deviceId);
        await db.prepare('INSERT INTO device_attr_version (device_id, attrs, recorded_at) VALUES (?, ?, ?)').run(deviceId, json, now);
      });
  return true;
}

// A device's details as known at `atMs` (null = now). Before its first recorded version the
// earliest one is used and flagged, because earlier details were not kept.
export async function deviceAttrsAt(deviceId, atMs = null) {
  const v = await db.prepare(`SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? AND ${atClause('', atMs)}`).get(deviceId);
  if (v) return { attrs: JSON.parse(v.attrs), approximate: null };
  const first = await db.prepare('SELECT attrs, recorded_at FROM device_attr_version WHERE device_id = ? ORDER BY recorded_at LIMIT 1').get(deviceId);
  if (first) return { attrs: JSON.parse(first.attrs), approximate: first.recorded_at };
  const cur = await db.prepare('SELECT attrs FROM device WHERE id = ?').get(deviceId);
  return { attrs: JSON.parse(cur?.attrs || '{}'), approximate: Date.now() };
}

// Devices in use at `atMs` (null = now), each with its details as known then.
export async function devicesAt(siteId, where = 'TRUE', atMs = null) {
  const inUse = atMs == null ? 'retired_at IS NULL'
    : `(recorded_at IS NULL OR recorded_at <= ${Math.floor(atMs)}) AND (retired_at IS NULL OR retired_at > ${Math.floor(atMs)})`;
  return await mapAsync((await db.prepare(`SELECT * FROM device WHERE site_id = ? AND ${inUse} AND ${where}`).all(siteId)), async (d) => {
        if (atMs == null) return { ...d, approximateAttrs: null };
        const { attrs, approximate } = await deviceAttrsAt(d.id, atMs);
        return { ...d, attrs: JSON.stringify(attrs), approximateAttrs: approximate };
      });
}

// Retiring a device ends its use, not the supply contract: tariff agreements belong to the supply
// point, so they stay in force and the home keeps its prices (replace them with supersedeAgreements).
export async function retireDevice(deviceId) {
  await db.prepare('UPDATE device SET retired_at = ? WHERE id = ? AND retired_at IS NULL').run(Date.now(), deviceId);
}

// Replace a meter's current agreements with a new list: the old ones are superseded, not deleted.
// rows: [{ tariffId, from, to?, paymentMethod? }] (paymentMethod: how the home pays, delta 080; null = not stated).
export async function supersedeAgreements(siteId, deviceId, rows) {
  const now = Date.now();
  await tx(async () => {
        const before = (await db.prepare('SELECT MIN(valid_from) AS first FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').get(deviceId))?.first;
        await db.prepare('UPDATE tariff_agreement SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(now, deviceId);
        const ins = db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to, recorded_at, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const r of rows) await ins.run(siteId, deviceId, r.tariffId, r.from, r.to ?? null, now, r.paymentMethod ?? null);
        const first = Math.min(...[before, ...rows.map((r) => r.from)].filter((x) => x != null));
        if (Number.isFinite(first)) await markHomeDirty(siteId, first, `tariff agreements replaced for device ${deviceId}`);
      });
}

// Databases from before devices were versioned: when each device and agreement was first known
// is taken from the sync log (the first sync whose step for that provider succeeded); details
// get a first version now, flagged as not kept before. Idempotent.
export async function seedDeviceHistory(siteId) {
  const firstOk = async (provider) => {
    const runs = await db.prepare("SELECT finished_at, detail FROM sync_run WHERE site_id = ? AND finished_at IS NOT NULL ORDER BY id").all(siteId);
    for (const r of runs) {
      try { if (JSON.parse(r.detail || '[]').some((s) => s.step === provider && s.ok)) return r.finished_at * 1000; } catch { /* unreadable log row */ }
    }
    return null;
  };
  const stepFor = { octopus: 'octopus', octopus_kraken: 'octopus', env: 'tariff' };
  for (const d of await db.prepare('SELECT * FROM device WHERE site_id = ? AND recorded_at IS NULL').all(siteId)) {
    await db.prepare('UPDATE device SET recorded_at = ? WHERE id = ?').run(await firstOk(stepFor[d.provider] || d.provider) ?? Date.now(), d.id);
  }
  for (const a of await db.prepare('SELECT a.id, d.recorded_at FROM tariff_agreement a JOIN device d ON d.id = a.device_id WHERE a.site_id = ? AND a.recorded_at IS NULL').all(siteId)) {
    await db.prepare('UPDATE tariff_agreement SET recorded_at = ? WHERE id = ?').run(a.recorded_at ?? Date.now(), a.id);
  }
  for (const d of await db.prepare('SELECT id, attrs FROM device WHERE site_id = ?').all(siteId)) {
    if (!await db.prepare('SELECT 1 FROM device_attr_version WHERE device_id = ?').get(d.id)) await setDeviceAttrs(d.id, JSON.parse(d.attrs || '{}'));
  }
}
