// The core's half of integration contract v2 (plan 2.4, src/adapters/discovery-contract.js): an integration reports the devices it
// found and the readings of their points by the provider's own names; the core finds the thing of each name through its link (making
// the device and the link when there is none), and the point of each field through its point binding. Nothing here knows a vendor.
import { db, sourceId } from '../db/db.js';
import { addDevice } from './tariffs.js';
import { linkFor } from './links.js';
import { ensureChannels, defineChannel, channelsFor, ingestObservations } from './channels.js';
import { checkDiscovered, checkObservations } from '../adapters/discovery-contract.js';

const bad = (message) => Object.assign(new RangeError(message), { status: 400 });

/**
 * Make what an integration found, once. For each device: its thing is the one its link names ('provider' and externalRef), or a new
 * device (and so a new thing and a link) of its kind; its points are bound to the source's fields, the ones its kind brings and the
 * ones the report lists. A second report of the same devices changes nothing.
 * @returns {Promise<{ devices: { externalRef: string, thingId: number, created: boolean }[], created: number, found: number, bindings: number }>}
 */
export async function discoverDevices({ siteId, provider, source, devices }) {
  const errs = checkDiscovered(devices);
  if (errs.length) throw bad(`discovery report: ${errs.join('; ')}`);
  await sourceId(source);   // an unknown source is an error before anything is written
  const out = { devices: [], created: 0, found: 0, bindings: 0 };
  for (const d of devices) {
    const link = await linkFor(siteId, provider, d.externalRef);
    let thingId; let created = false;
    if (link) thingId = Number(link.thing_id);
    else {
      const kind = (await db.prepare('SELECT 1 AS x FROM device_kind WHERE kind = ?').get(d.kind)) ? d.kind : 'generic_device';   // a type with no row yet is read-only until one is added
      thingId = (await addDevice({ siteId, kind, provider, externalRef: d.externalRef, label: d.label ?? null, attrs: d.attrs ?? {} })).id;
      created = true;
    }
    out.devices.push({ externalRef: d.externalRef, thingId, created });
    if (created) out.created++; else out.found++;
    out.bindings += await ensureChannels(siteId, source, thingId);
    for (const p of d.points ?? []) {
      const have = (await channelsFor(siteId, source, p.point, thingId)).find((c) => c.metric === p.metric);
      if (have) continue;
      await defineChannel(siteId, source, p.point, p.metric, { ...p, min: p.min ?? null, max: p.max ?? null, deviceId: thingId });
      out.bindings++;
    }
  }
  return out;
}

/**
 * Readings of points by the provider's names. Observations are grouped by device name; each goes through the point bindings of the
 * thing its link names. A name with no link is not guessed at: it comes back in `unknown`, for the integration to discover first.
 */
export async function ingestByRef(siteId, { provider, source, observations, rawId = null, now }) {
  const errs = checkObservations(observations);
  if (errs.length) throw bad(`observations: ${errs.join('; ')}`);
  const byRef = new Map();
  for (const o of observations) (byRef.get(o.externalRef) ?? byRef.set(o.externalRef, []).get(o.externalRef)).push(o);
  const out = { written: 0, rejected: 0, unknown: [] };
  for (const [ref, obs] of byRef) {
    const link = await linkFor(siteId, provider, ref);
    if (!link) { out.unknown.push(ref); continue; }
    const r = await ingestObservations(siteId, source, obs.map(({ externalRef, ...o }) => o), rawId, { deviceId: Number(link.thing_id), ...(now != null ? { now } : {}) });
    out.written += r.written; out.rejected += r.rejected;
  }
  return out;
}
