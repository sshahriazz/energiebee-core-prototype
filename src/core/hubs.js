// More than one hub (fix list R22, case 17): a home may have several hubs and each device is served_by one. A hub is offline when none of
// the devices it serves has reported for `staleS`; then those devices are marked offline, and the devices of the other hubs are not. A device
// that no hub serves (cloud-only, case 20) is never marked by a hub.
import { db } from '../db/db.js';
import { relationsAt } from './things.js';

/** [{ hub, name, state: 'online' | 'offline' | 'unknown', lastSeen, devices: [{ id, name, offline }] }] for the hubs of a home at `now` (epoch s). */
export async function hubStatus(homeId, { now = Math.floor(Date.now() / 1000), staleS = 1800 } = {}) {
  const served = await relationsAt(homeId, { rels: ['served_by'], at: null });
  const byHub = new Map();
  for (const r of served) (byHub.get(Number(r.to_id)) ?? byHub.set(Number(r.to_id), []).get(Number(r.to_id))).push(Number(r.from_id));
  const out = [];
  for (const [hubId, deviceIds] of byHub) {
    const hub = await db.prepare('SELECT id, name FROM thing WHERE id = ?').get(hubId);
    const seen = new Map((await db.prepare(`SELECT p.thing_id, MAX(ps.reported_ts) AS at FROM point p JOIN point_state ps ON ps.point_id = p.id
      WHERE p.thing_id = ANY(?::bigint[]) AND p.superseded_at IS NULL GROUP BY p.thing_id`).all(`{${deviceIds.join(',')}}`)).map((r) => [Number(r.thing_id), r.at == null ? null : Number(r.at)]));
    const last = Math.max(0, ...[...seen.values()].filter((v) => v != null));
    const state = last === 0 ? 'unknown' : now - last > staleS ? 'offline' : 'online';
    const names = new Map((await db.prepare('SELECT id, name FROM thing WHERE id = ANY(?::bigint[])').all(`{${deviceIds.join(',')}}`)).map((r) => [Number(r.id), r.name]));
    out.push({ hub: hubId, name: hub?.name ?? null, state, lastSeen: last || null, devices: deviceIds.map((id) => ({ id, name: names.get(id), offline: state === 'offline' })) });
  }
  return out.sort((a, b) => a.hub - b.hub);
}
