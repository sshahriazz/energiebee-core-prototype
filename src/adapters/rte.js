// Grid carbon intensity for France: RTE éCO2mix (national), from RTE's open data portal (ODRÉ, Opendatasoft).
//
// What RTE publishes (checked Nov 2026, no key needed):
//   eco2mix-national-tr        real time, a value every 15 minutes, about 30 minutes behind, from the start of a
//                              rolling window (the current months); future rows exist with taux_co2 null
//   eco2mix-national-cons-def  consolidated and final, every 30 minutes, from 2012 up to where the real-time set begins
//   taux_co2: "Estimation des émissions de carbone générées par la production d'électricité en France", gCO2/kWh, an
//   integer, one value for the whole country (perimetre "France"). There is no forecast.
// Licence: Licence Ouverte v2.0 (Etalab): free reuse, the source credited ("RTE éCO2mix").
//
// Stored as interval facts of source rte_eco2mix on the region series carbon:FR (one series for every French home,
// src/core/carbon-series.js), each value for its own period (15 or 30 minutes); the build spreads them over a home's
// slots by time, as it does NESO's. Null values (the future, or a gap) are skipped, never guessed. Every answer is
// landed raw; an answer that is not a list of { date_heure, taux_co2 } is quarantined.
import { fetchJson } from '../core/http.js';
import { landRaw, quarantine } from '../core/facts.js';
import { ingestObservations } from '../core/channels.js';
import { nowSec, parseIso } from '../core/time.js';

export const SOURCE = 'rte_eco2mix';
export const REGION = 'carbon:FR';
const BASE = 'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets';
export const DATASETS = Object.freeze({
  realtime: { id: 'eco2mix-national-tr', periodS: 900 },
  consolidated: { id: 'eco2mix-national-cons-def', periodS: 1800 },
});

const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The export URL of one dataset for [fromTs, toTs): every non-null value, oldest first, in one answer. */
export function exportUrl(dataset, fromTs, toTs) {
  const q = new URLSearchParams({
    select: 'date_heure,taux_co2',
    where: `date_heure >= '${iso(fromTs)}' and date_heure < '${iso(toTs)}' and taux_co2 is not null`,
    order_by: 'date_heure',
  });
  return `${BASE}/${dataset}/exports/json?${q}`;
}

/** An answer as observations: [{ point, start, end, value }] or { problem } when it is not the expected shape. */
export function mapRows(body, periodS) {
  if (!Array.isArray(body)) return { problem: 'not a list' };
  const out = [];
  for (const r of body) {
    if (!r || typeof r.date_heure !== 'string') return { problem: 'a row without date_heure' };
    if (r.taux_co2 == null) continue;
    const start = parseIso(r.date_heure);
    const value = Number(r.taux_co2);
    if (!Number.isFinite(start) || !Number.isFinite(value) || value < 0) return { problem: `a row with an unreadable time or value: ${JSON.stringify(r).slice(0, 120)}` };
    out.push({ point: 'intensity', start, end: start + periodS, value });
  }
  return { rows: out };
}

async function readDataset(site, key, fromTs, toTs) {
  const { id, periodS } = DATASETS[key];
  const url = exportUrl(id, fromTs, toTs);
  const { json } = await fetchJson(url);
  const m = mapRows(json, periodS);
  if (m.problem) {
    quarantine({ source: SOURCE, siteId: site.id, request: { url }, body: json, reason: `unexpected shape: ${m.problem}` });
    throw new Error(`RTE éCO2mix ${id}: unexpected answer (${m.problem}), quarantined`);
  }
  const { rawId } = landRaw({ source: SOURCE, siteId: site.id, request: { url }, body: json });
  const written = ingestObservations(site.id, SOURCE, m.rows, rawId, { subject: { kind: 'region', id: REGION } }).written;
  return { rows: m.rows, written };
}

/**
 * France's grid carbon intensity for [fromTs, now): the real-time set, and the consolidated set for any part of the
 * window before the real-time set's first value. Returns { written, rows, consolidated?, latest }.
 */
export async function syncRteCarbon(site, fromTs, toTs = nowSec()) {
  const rt = await readDataset(site, 'realtime', fromTs, toTs);
  const out = { written: rt.written, rows: rt.rows.length, latest: rt.rows.length ? iso(rt.rows.at(-1).start) : null };
  const firstRt = rt.rows[0]?.start ?? toTs;
  // The real-time set starts later than the window: the earlier part from the consolidated set (it ends where the
  // real-time set begins, so the two never overlap).
  if (firstRt > fromTs + DATASETS.realtime.periodS) {
    const cd = await readDataset(site, 'consolidated', fromTs, firstRt);
    out.written += cd.written;
    out.consolidated = cd.rows.length;
  }
  return out;
}
