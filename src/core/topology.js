// A home's plant, read from its energy graph (plan 2.7, R1): which inverters, PV arrays, batteries, meters and supply it has and how
// they are wired, and whether the allocation the build does (docs/timeline-forecast-and-data-states.md: solar, battery, grid and the
// home's use, from the flows measured at home level) covers it. The build asks before it builds: a home the rules do not cover is
// refused with the reasons, not built into numbers that look right and are not. The check judges a graph that is there: a home whose
// graph is not built yet (no connection and no supply) or has several inverters (each is a unit of the build, bound per device, and the
// seeder does not wire what it cannot know) is covered, and a home with no inverter is read as it always was, from its measured flows.
//
//   plantOf(facts)        PURE: the plant, from the things and relations of a home
//   topologyOf(facts)     PURE: the plant, its class and the reasons it is not covered, if it is not
//   homeTopology(siteId)  reads the graph and the evidence, then topologyOf
//
// Classes: no_plant (meters and tariffs only), solar_only, battery_only is not a class (a battery with no inverter is refused),
// solar_battery (one inverter, hybrid), several_inverters (their figures add up: each is a unit of the build, bound per device).
import { db } from '../db/db.js';

const live = (t) => t.valid_to == null;

/** The plant: the live things of each plant type, and the feeds edges between them (ids). */
export function plantOf({ things, relations }) {
  const by = (type) => things.filter((t) => t.type === type && live(t));
  const feeds = relations.filter((r) => r.rel === 'feeds' && r.valid_to == null);
  const fedInto = (to) => feeds.filter((r) => r.to === to).map((r) => r.from);
  const inverters = by('inverter');
  return {
    inverters: inverters.map((t) => t.id),
    arrays: by('pv_array').map((t) => t.id),
    batteries: by('battery').map((t) => t.id),
    meters: [...by('meter_import'), ...by('meter_export')].map((t) => t.id),
    supply: by('home_supply').map((t) => t.id),
    connection: by('grid_connection').map((t) => t.id),
    // which inverter each array and battery is wired to (an array feeds the inverter's pv port; a battery is fed by the inverter's battery port)
    arrayInverter: Object.fromEntries(by('pv_array').map((a) => [a.id, feeds.find((r) => r.from === a.id && inverters.some((i) => i.id === r.to))?.to ?? null])),
    batteryInverter: Object.fromEntries(by('battery').map((b) => [b.id, fedInto(b.id).find((f) => inverters.some((i) => i.id === f)) ?? null])),
  };
}

/**
 * The class of a home's plant and whether the build's allocation covers it. `evidence.flows` says which home-level flows have been
 * measured (solar, battery, grid); a plant the graph does not explain is refused only when something measured would be wrong for it.
 * @returns {{ class: string, supported: boolean, reasons: string[], plant: object }}
 */
export function topologyOf(facts) {
  const plant = plantOf(facts);
  const flows = facts.evidence?.flows ?? {};
  const reasons = [];
  const unwired = (m) => Object.entries(m).filter(([, i]) => i == null).map(([id]) => Number(id));
  const graphBuilt = plant.connection.length + plant.supply.length > 0;
  if (graphBuilt && plant.inverters.length === 1) {
    if (flows.solar && unwired(plant.arrayInverter).length) reasons.push('a PV array is not wired to the inverter');
    if (flows.battery && unwired(plant.batteryInverter).length) reasons.push('a battery is not wired to the inverter');
  }
  const cls = plant.inverters.length === 0 && !plant.arrays.length && !plant.batteries.length ? 'no_plant'
    : plant.inverters.length > 1 ? 'several_inverters'
      : plant.batteries.length ? 'solar_battery' : 'solar_only';
  return { class: cls, supported: reasons.length === 0, reasons, plant };
}

/** Read a home's graph and what has been measured of it, and classify it. A home with no graph yet is no plant. */
export async function homeTopology(siteId) {
  const things = (await db.prepare(`SELECT id, type, valid_to FROM thing WHERE home_id = ? AND kind = 'device' AND superseded_at IS NULL AND merged_into IS NULL`).all(siteId)).map((t) => ({ id: Number(t.id), type: t.type, valid_to: t.valid_to }));
  const relations = (await db.prepare(`SELECT from_id, to_id, rel, valid_to FROM thing_relation WHERE home_id = ? AND superseded_at IS NULL AND rel = 'feeds'`).all(siteId))
    .map((r) => ({ from: Number(r.from_id), to: Number(r.to_id), rel: r.rel, valid_to: r.valid_to }));
  // the flows measured at home level (a device's own series are the device's: a battery with its own readings is not a plant flow)
  const measured = async (codes) => Boolean(await db.prepare(`SELECT 1 AS x FROM series s JOIN metric m ON m.id = s.metric_id WHERE s.site_id = ? AND s.subject_kind = 'site' AND m.code = ANY(?::text[])
    AND EXISTS (SELECT 1 FROM reading r WHERE r.series_id = s.id) LIMIT 1`).get(siteId, `{${codes.join(',')}}`));
  return topologyOf({ things, relations, evidence: { flows: { solar: await measured(['solar_w']), battery: await measured(['battery_charge_w', 'battery_discharge_w', 'battery_soc_pct']), grid: await measured(['grid_import_w']) } } });
}
