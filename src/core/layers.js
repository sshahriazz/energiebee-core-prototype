// The layers above the facts, in the order they are built (plan 3.2, docs/build/timelines.md): the home's slots (build.js), then the
// timeline of every point (point-slots.js), then of every place made of them (node-slots.js). A rebuild of a range rebuilds each layer
// over the same days, bottom to top, so no layer is ever built from a layer below that is older than it. Each layer carries its own method
// version: rows of an older method are rebuilt (staleDays), and because the layers above are rebuilt with the one below, a change in a
// lower layer reaches every layer above it.
import { db } from '../db/db.js';
import { buildHomePointSlots, POINT_SLOT_VERSION } from './point-slots.js';
import { buildHomeNodeSlots, NODE_SLOT_VERSION } from './node-slots.js';
import { localDate } from './time.js';

/** Rebuild the point layer and then the place layer for the days fromDate..toDate. */
export async function buildLayers(siteId, fromDate, toDate, opts = {}) {
  const points = await buildHomePointSlots(siteId, fromDate, toDate, opts);
  const nodes = await buildHomeNodeSlots(siteId, fromDate, toDate, opts);
  return { points: points.points, pointSlots: points.slots, nodes: nodes.nodes, nodeSlots: nodes.slots };
}

/** The local days of a home whose point or place slots were built by an older method, as { from, to } (or null). */
export async function staleDays(siteId) {
  const home = await db.prepare('SELECT timezone FROM site WHERE id = ?').get(siteId);
  if (!home) return null;
  const rows = await db.prepare(`SELECT MIN(slot_start) AS lo, MAX(slot_start) AS hi FROM (
      SELECT ps.slot_start FROM point_slot ps JOIN point p ON p.id = ps.point_id WHERE p.home_id = ? AND ps.method_version <> ?
      UNION ALL SELECT n.slot_start FROM node_slot n JOIN thing t ON t.id = n.thing_id WHERE t.home_id = ? AND n.method_version <> ?) x`).get(siteId, POINT_SLOT_VERSION, siteId, NODE_SLOT_VERSION);
  return rows?.lo == null ? null : { from: localDate(home.timezone, Number(rows.lo)), to: localDate(home.timezone, Number(rows.hi)) };
}
