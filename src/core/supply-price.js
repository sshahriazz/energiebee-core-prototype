// The price slots of a home (Phase T.3): what each supply point pays in each slot of the home's own length, and the share of the
// fixed charges that falls in it. A supply point is a meter kind ('meter_import', 'meter_export', 'meter_gas') or, for a sub-meter
// with a tariff of its own (R11), 'device:<id>'. Every cost is slot energy x slot price. The build (stage 4) reads
// the slots from here; the planner, the forecast, heating, the explorer and the explanations price a slot with slotPrice
// (slot-price.js) over the current runs, which is the same maths this file stores, so a number is never priced two ways. The
// comparison and the tariff picker read the slots in a later step.
//
// One code path for the maths, two ways to read it:
//   - computed in memory (slot-price.js slotPrice, fixedShare) from a pricing.js context. A build "as known at" a past moment does
//     only this: the table describes now, and the context was loaded from the rows of that moment.
//   - materialised in supply_price_slot. A current build reads the home's slots from it and computes (and stores) only what is
//     missing or was made from other inputs. Each row carries a stamp of every input it was made from (inputsStamp); a row of another
//     stamp is never read, so a changed rate row, tax rule, agreement, window or dispatch can never be served from the table, whether
//     it was written through a write function (which also queues the rebuild, price-queue.js) or by anything else.
// A slot with no price known has a row too (unit_ex NULL), and a slot with no agreement has a row that says so: it is known, so it is
// not computed again. Nothing is ever guessed: an unpublished price is a NULL, an estimate comes only from a stated rule (Tempo).
import { createHash } from 'node:crypto';
import { db } from '../db/db.js';
import { nowSec } from './time.js';
import { inForce } from './facts.js';
import { rateStamps } from './price-run-store.js';
import { slotPrice, fixedShare } from './slot-price.js';

// Changes with any change of the maths, so slots made by an older method are ignored and made again.
export const PRICE_METHOD = 'supply-price-1';
export const MAIN_METERS = ['meter_import', 'meter_export', 'meter_gas'];
const CHUNK = 250;   // rows per INSERT (21 columns each, far below Postgres' 65535 parameters)

export const subMeterPoint = (deviceId) => `device:${deviceId}`;

// The energy a sub-meter measured: the interval facts (kWh) of the device's own series with one of these metrics. A sub-meter's
// energy is part of the main meter's import (the metrics' own descriptions say so), so it is taken out of the priced import.
export const SUB_METER_METRICS = ['heatpump_elec_kwh', 'ev_charge_kwh', 'immersion_kwh'];
export async function readSubMeterFacts(deviceId, from, to) {
  return await db.prepare(`SELECT f.start_ts, f.end_ts, f.value FROM interval_fact f JOIN series s ON s.id = f.series_id JOIN metric m ON m.id = s.metric_id
    WHERE s.subject_kind = 'device' AND s.subject_id = ? AND m.code IN (${SUB_METER_METRICS.map(() => '?').join(',')}) AND ${inForce('f')} AND f.end_ts > ? AND f.start_ts < ?
    ORDER BY f.start_ts, f.end_ts`).all(String(deviceId), ...SUB_METER_METRICS, from, to);
}

// The supply points of a pricing context: the main meter kinds that have an agreement in it, and each other device with one (a
// sub-meter). `point` is what slotPrice takes: the meter kind, or the device id of a sub-meter; `key` is the name stored.
export function supplyPoints(p) {
  const out = new Map();
  for (const a of p.agreements) {
    if (MAIN_METERS.includes(a.kind)) out.set(a.kind, { point: a.kind, key: a.kind, kind: a.kind, deviceId: null });
    else out.set(subMeterPoint(a.device_id), { point: a.device_id, key: subMeterPoint(a.device_id), kind: a.kind, deviceId: a.device_id });
  }
  return [...out.values()];
}

// A fingerprint of everything a home's slots are made from that does not depend on the span being built: the home's agreements,
// each tariff's own columns and rate rows, the tax rules and VAT table of its country, its meters' own windows, its smart-charge
// dispatches, the learned off-peak window, the home's settings, the slot length and the method. One cheap aggregate per input.
export async function inputsStamp(siteId, p, slotS) {
  const agreements = await db.prepare('SELECT id, device_id, tariff_id, valid_from, valid_to, payment_method FROM tariff_agreement WHERE site_id = ? AND superseded_at IS NULL ORDER BY id').all(siteId);
  const tariffIds = [...new Set(agreements.map((a) => a.tariff_id))].sort((a, b) => a - b);
  const deviceIds = [...new Set(agreements.map((a) => a.device_id))].sort((a, b) => a - b);
  const q = (ids) => ids.map(() => '?').join(',');
  const tariffs = tariffIds.length ? await db.prepare(`SELECT id, tariff_code, fuel, direction, structure, currency, kind, origin, taxes_in_price, default_register FROM tariff WHERE id IN (${q(tariffIds)}) ORDER BY id`).all(...tariffIds) : [];
  const windows = deviceIds.length ? await db.prepare(`SELECT id, device_id, register, start_min, end_min, weekdays, clock, valid_from, valid_to FROM register_window WHERE device_id IN (${q(deviceIds)}) AND calendar IS NULL AND superseded_at IS NULL ORDER BY id`).all(...deviceIds) : [];
  const rules = p.country ? await db.prepare('SELECT id FROM tax_rule WHERE country = ? AND superseded_at IS NULL ORDER BY id').all(p.country) : [];
  const vat = await db.prepare('SELECT fuel, direction, rate, valid_from, valid_to FROM vat_rate ORDER BY fuel, direction, valid_from').all();
  const dispatches = await db.prepare(`SELECT COUNT(*) AS n, MAX(f.recorded_at) AS r, MAX(f.superseded_at) AS s FROM interval_fact f JOIN series s ON s.id = f.series_id
    JOIN source src ON src.id = s.source_id JOIN metric m ON m.id = s.metric_id
    WHERE s.subject_kind = 'site' AND s.subject_id = ? AND src.code = 'octopus_kraken' AND m.code = 'ev_charge_kwh'`).get(String(siteId));
  const rates = await rateStamps(tariffIds);
  return createHash('sha1').update(JSON.stringify([PRICE_METHOD, slotS, agreements, tariffs, windows, rules, vat, dispatches, [...rates], p.iogWindow, p.tz, p.country, p.currency, p.capacityKva, p.capacityOrigin])).digest('hex').slice(0, 20);
}

// A price as one row of supply_price_slot. null price: no agreement at the slot.
export function slotRow(siteId, point, slot, slotS, price, fixedInc, stamp, builtAt) {
  return {
    site_id: siteId, point, device_id: price?.deviceId ?? null, tariff_id: price?.tariffId ?? null, slot_start: slot, dur_s: slotS, register: price?.register ?? null,
    unit_ex: price?.unitEx ?? null, supply_ex: price?.supplyEx ?? null, vat: price?.vat ?? null, levy: price?.levy ?? null,
    unit_inc: price?.unitEx != null ? price.unitEx * (1 + price.vat) : null, fixed_inc: price ? fixedInc : 0,
    weighted: price?.weighted ? 1 : 0, estimated: price?.estimated ? 1 : 0, capacity_unknown: price?.capacityUnknown ? 1 : 0,
    tax_source: price?.tax?.source ?? null, tax_unverified: price?.tax?.unverified ? 1 : 0,
    lineage: JSON.stringify(price ? { tariff: price.tariffCode, inputs: price.inputs ?? [] } : { agreement: null }), stamp, built_at: builtAt,
  };
}

// A stored row as the price a build reads: the fields the build, the planner and the comparison use. null: no agreement at the slot.
export function priceOfRow(r) {
  if (r.device_id == null) return null;
  const lin = typeof r.lineage === 'string' ? JSON.parse(r.lineage) : r.lineage;
  return {
    tariffCode: lin.tariff ?? null, tariffId: r.tariff_id, deviceId: r.device_id, register: r.register, unitEx: r.unit_ex, supplyEx: r.supply_ex, vat: r.vat, levy: r.levy,
    tax: { source: r.tax_source, unverified: r.tax_unverified === 1 }, inputs: lin.inputs ?? [],
    ...(r.weighted === 1 ? { weighted: true } : {}), ...(r.estimated === 1 ? { estimated: true } : {}), ...(r.capacity_unknown === 1 ? { capacityUnknown: true } : {}),
  };
}

const COLS = ['site_id', 'point', 'device_id', 'tariff_id', 'slot_start', 'dur_s', 'register', 'unit_ex', 'supply_ex', 'vat', 'levy', 'unit_inc', 'fixed_inc', 'weighted', 'estimated', 'capacity_unknown', 'tax_source', 'tax_unverified', 'lineage', 'stamp', 'built_at'];
const KEY_COLS = ['site_id', 'point', 'dur_s', 'slot_start'];

async function storeRows(rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const cells = '(' + COLS.map((c) => (c === 'lineage' ? '?::jsonb' : '?')).join(', ') + ')';
    await db.prepare(`INSERT INTO supply_price_slot (${COLS.join(', ')}) VALUES ${part.map(() => cells).join(', ')}
      ON CONFLICT (site_id, point, dur_s, slot_start) DO UPDATE SET ${COLS.filter((c) => !KEY_COLS.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`)
      .run(...part.flatMap((r) => COLS.map((c) => r[c])));
  }
}

// The slots of a home, for the slot length and zone of a build.
//   materialise  read the stored slots and make and store the missing ones (a current build); false computes every slot in memory (a
//                build "as known at" a moment, the trace of one slot)
//   persist      store what was made (not in a dry run, which writes nothing)
// load(slots) prepares the slots; get(point, slot) returns { price, fixedInc }: price is null with no agreement, else the slot's price
// object (the full one when computed, the stored fields when read: both carry what a build uses), fixedInc the fixed charges of the
// slot with taxes.
export async function supplyPricer({ siteId, p, slotS, tz, materialise = false, persist = true }) {
  const points = supplyPoints(p);
  const byKey = new Map(points.map((pt) => [pt.key, pt]));
  const memo = new Map(points.map((pt) => [pt.key, new Map()]));
  const compute = (pt, slot) => {
    const price = slotPrice(p, pt.point, slot, slotS);
    return { price, fixedInc: price ? fixedShare(price, slot, slotS, tz) : 0 };
  };
  const stamp = materialise ? await inputsStamp(siteId, p, slotS) : null;
  const stats = { read: 0, made: 0, stored: 0 };
  return {
    points: points.map((pt) => pt.key),
    subMeters: points.filter((pt) => pt.deviceId != null).map(({ key, deviceId, kind }) => ({ key, deviceId, kind })),
    stats,
    async load(slots) {
      if (!slots.length) return;
      for (const pt of points) {
        const m = memo.get(pt.key);
        const want = slots.filter((s) => !m.has(s));
        if (!want.length) continue;
        if (materialise) {
          const lo = Math.min(...want); const hi = Math.max(...want);
          for (const r of await db.prepare('SELECT * FROM supply_price_slot WHERE site_id = ? AND point = ? AND dur_s = ? AND stamp = ? AND slot_start >= ? AND slot_start <= ?')
            .all(siteId, pt.key, slotS, stamp, lo, hi)) {
            m.set(r.slot_start, { price: priceOfRow(r), fixedInc: r.fixed_inc });
            stats.read++;
          }
        }
        const made = [];
        for (const s of want) {
          if (m.has(s)) continue;
          const c = compute(pt, s);
          m.set(s, c); made.push([s, c]);
        }
        stats.made += made.length;
        if (materialise && persist && made.length) {
          const at = nowSec();
          await storeRows(made.map(([s, c]) => slotRow(siteId, pt.key, s, slotS, c.price, c.fixedInc, stamp, at)));
          stats.stored += made.length;
        }
      }
    },
    get(key, slot) {
      const pt = byKey.get(key);
      if (!pt) return { price: null, fixedInc: 0 };
      const m = memo.get(key);
      if (!m.has(slot)) m.set(slot, compute(pt, slot));
      return m.get(slot);
    },
  };
}

// A home's rows of any other slot length than its own are dropped (the length is the home's setting; a changed length makes
// every stored row stale anyway).
export async function dropOtherLengths(siteId, slotS) {
  return Number((await db.prepare('DELETE FROM supply_price_slot WHERE site_id = ? AND dur_s <> ?').run(siteId, slotS)).changes);
}
