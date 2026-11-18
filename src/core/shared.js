// Things that move or are shared between homes (fix list R24 and R20).
//
//   rehomeThing(ref, ...)       a device moves to another home (an EV leaves with its owner): the old thing ends in the old home with its
//                               history, a successor begins in the new one with none; thing_rehome ties the two
//   shareThing(...)             one thing serves several homes (communal heating): each home has a dated share of it
//   allocateShared(...)         the shared thing's energy and cost, split to each home by its share, written to the home's own timeline
//                               and labelled allocated: it is a share of what one meter measured, not something measured for that home
import { db, tx } from '../db/db.js';
import * as T from './things.js';
import { addDevice } from './tariffs.js';
import { pointOf } from './points.js';
import { readPointSlots } from './point-slots.js';
import { dayBounds, daysBetween, nowSec } from './time.js';

const fail = (status, message, code = null) => Object.assign(new Error(message), { status, code });

/**
 * A device moves to another home at `at`. Returns { old, thing, boundary }. The old home keeps every fact it has; the new home starts empty: the
 * successor is a new thing (own uid, points and series) with the same kind, provider and reference, so a push or an integration of the new home
 * finds it by its link. `reason` is required.
 */
export async function rehomeThing(ref, { toHomeId, at = nowSec(), reason } = {}) {
  if (!String(reason ?? '').trim()) throw fail(400, 'a move needs a reason');
  const old = await T.getThing(ref);
  const dev = await db.prepare('SELECT * FROM device WHERE id = ?').get(old.id);
  if (!dev) throw fail(400, `only a device moves to another home (a ${old.kind} is placed, retired or split)`);
  if (Number(toHomeId) === Number(old.home_id)) throw fail(400, 'it is in that home already: place it somewhere else in it instead');
  if (!await db.prepare('SELECT 1 FROM site WHERE id = ?').get(toHomeId)) throw fail(404, `no home ${toHomeId}`);
  return await tx(async () => {
    const r = await T.retireThing(old.id, { siteId: old.home_id, at });
    const made = await addDevice({ siteId: toHomeId, kind: dev.kind, provider: dev.provider, externalRef: dev.external_ref, label: dev.label ?? old.name, attrs: JSON.parse(dev.attrs || '{}'), recordedAt: r.boundary * 1000 });
    await db.prepare('UPDATE thing SET valid_from = ? WHERE id = ?').run(r.boundary, made.id);
    await db.prepare('INSERT INTO thing_rehome (from_thing, to_thing, from_home, to_home, effective_at, reason) VALUES (?, ?, ?, ?, ?, ?)').run(old.id, made.id, old.home_id, toHomeId, r.boundary, String(reason).trim());
    return { old: await T.getThing(old.id), thing: await T.getThing(made.id), boundary: r.boundary };
  });
}

/** Where a thing came from and where it went: [{ from, to, at, reason }] for the moves that touch it. */
export async function movesOf(thingId) {
  return await db.prepare('SELECT from_thing, to_thing, from_home, to_home, effective_at, reason FROM thing_rehome WHERE from_thing = ? OR to_thing = ? ORDER BY effective_at').all(thingId, thingId);
}

/**
 * A home takes a share of a thing from `from` (epoch s) until `to` (null: open). The shares of one thing never add up to more than 1 at any
 * time. basis: 'fixed' (an agreed fraction) or 'submeter' (a fraction read from the home's own sub-meter, written by whoever works it out).
 */
export async function shareThing({ thingId, homeId, share, basis = 'fixed', from, to = null }) {
  if (!(share > 0 && share <= 1)) throw fail(400, 'a share is more than 0 and at most 1');
  if (!Number.isInteger(from)) throw fail(400, 'from is epoch seconds');
  if (!await db.prepare('SELECT 1 FROM thing WHERE id = ?').get(thingId)) throw fail(404, 'no such thing');
  return await tx(async () => {
    await db.prepare('SELECT 1 AS x FROM (SELECT pg_advisory_xact_lock(hashtext(?), ?::int)) l').get('eb_thing_share', thingId);
    const others = await db.prepare('SELECT share, valid_from, valid_to FROM thing_share WHERE thing_id = ? AND valid_from < ? AND (valid_to IS NULL OR valid_to > ?)').all(thingId, to ?? 9e15, from);
    for (const t of [from, ...others.map((o) => Number(o.valid_from)).filter((v) => v > from && (to == null || v < to))]) {
      const sum = share + others.filter((o) => Number(o.valid_from) <= t && (o.valid_to == null || Number(o.valid_to) > t)).reduce((a, o) => a + o.share, 0);
      if (sum > 1 + 1e-9) throw fail(409, `the shares of this thing would add up to ${Math.round(sum * 1000) / 1000} at ${t}: at most 1`, 'shares_exceed');
    }
    return Number((await db.prepare('INSERT INTO thing_share (thing_id, home_id, share, basis, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)').run(thingId, homeId, share, basis, from, to)).lastInsertRowid);
  });
}

export const sharesOf = async (thingId) => await db.prepare('SELECT * FROM thing_share WHERE thing_id = ? ORDER BY valid_from, id').all(thingId);

/**
 * Split a shared thing's energy (the metric of one of its points, default the heat it delivered) to the homes that share it, slot by slot, for the
 * local days fromDate..toDate of the thing's home. Each home's own timeline gets `shared_<what>_kwh` and, with unitPrice (money per kWh), `..._cost`;
 * every row's lineage says allocated, with the share, its basis and the thing it came from. Rebuilds replace the rows of the window. Returns { rows }.
 */
export async function allocateShared(thingId, fromDate, toDate, { metric = 'heat_output_kwh', unitPrice = null, builtAt = nowSec() } = {}) {
  const t = await T.getThing(thingId);
  const home = await db.prepare('SELECT timezone, slot_s FROM site WHERE id = ?').get(t.home_id);
  const [from] = dayBounds(home.timezone, fromDate); const to = dayBounds(home.timezone, toDate)[1];
  const point = await pointOf(thingId, metric);
  const slots = await readPointSlots(point, from, to);
  const shares = await sharesOf(thingId);
  const what = metric.replace(/_kwh$/, '').replace(/_counter$/, '');
  const rows = [];
  for (const sl of slots) {
    if (sl.delta == null) continue;
    for (const sh of shares) {
      if (sl.slot_start < Number(sh.valid_from) || (sh.valid_to != null && sl.slot_start >= Number(sh.valid_to))) continue;
      const kwh = Math.round(sl.delta * sh.share * 1e9) / 1e9;
      const lineage = { allocated: true, share: sh.share, basis: sh.basis, from_thing: thingId, shared_total: sl.delta };
      rows.push({ home: Number(sh.home_id), slot: sl, metric: `shared_${what}_kwh`, value: kwh, lineage });
      if (unitPrice != null) rows.push({ home: Number(sh.home_id), slot: sl, metric: `shared_${what}_cost`, value: Math.round(kwh * unitPrice * 1e9) / 1e9, lineage: { ...lineage, unit_price: unitPrice } });
    }
  }
  await tx(async () => {
    const homes = [...new Set([...shares.map((s) => Number(s.home_id))])];
    for (const h of homes) await db.prepare("DELETE FROM node_slot WHERE thing_id = ? AND metric LIKE 'shared\\_%' AND lineage->>'from_thing' = ? AND slot_start >= ? AND slot_start < ?").run(h, String(thingId), from, to);
    for (const r of rows) {
      await db.prepare(`INSERT INTO node_slot (thing_id, slot_start, dur_s, metric, value, coverage, state, lineage, method_version, built_at) VALUES (?, ?, ?, ?, ?, ?, 'final', ?::jsonb, 1, ?)
        ON CONFLICT (thing_id, slot_start, metric) DO UPDATE SET value = excluded.value, coverage = excluded.coverage, lineage = excluded.lineage, built_at = excluded.built_at`)
        .run(r.home, r.slot.slot_start, r.slot.dur_s, r.metric, r.value, r.slot.coverage, JSON.stringify(r.lineage), builtAt);
    }
  });
  return { rows: rows.length };
}
