// SOURCE -> PROCESSOR -> SLOT DATA: the processor template.
//
// Copy this file to src/adapters/<code>.js and fill in the marked places. Nothing here is
// imported by the app; it is a starting point.
//
//   source ──► PROCESSOR ──────────────────────────────────────► facts ──► build engine ──► slots
//              1 fetch   2 validate   3 land raw   4 parse   5 write   6 mark dirty         (site_hh)
//
// What a processor IS: a contract (what the source means), a fetch (how to ask for it), and a
// pure parse (raw body -> normalised rows). Everything else is the same for every source, which
// is why processSource() below should not need to change.
//
// Canonical conventions every parse() must produce (the slot engine assumes them):
//   time     UTC epoch SECONDS. Convert local clocks with time.js (localToUtc), never add 24 h.
//            A local day is 23, 24 or 25 hours.
//   power    W            energy  kWh           state of charge  %            temperature  deg C
//   money    MINOR units per kWh (pence, cents), net of VAT, with the currency on the row
//   signs    one direction per metric (grid_import_w and grid_export_w, both >= 0): split any
//            signed source value into separate metrics here, never in the build engine.
//   missing  null. Never 0, never a guess, never a typical value. A sentinel (-100, 9999) is null.
//   kinds    reading   a value at an instant                       -> putReadings
//            interval  an amount over [start, end) (a meter half-hour, a daily total) -> putIntervals
//            forecast  a prediction issued at a time               -> putForecasts
//
// Facts are append-only: a changed value is a new version and the old one is kept, so parse()
// may return the same rows again on every sync; unchanged rows cost nothing.

import { landRaw, quarantine, seriesId, putReadings, putIntervals, putForecasts, markDirty, asWriter } from '../core/facts.js';
import { fetchJson } from '../core/http.js';
import { nowSec } from '../core/time.js';

// ───────────── 0. DECLARE: what the source means (data, not code) ─────────────
// Copy SOURCE into SOURCES and METRICS into METRICS in src/db/registry.js. A new source or metric
// is a registry row, never a schema change.
export const SOURCE = {
  code: 'my_source',                 // lower-case identifier; also the folder name under data/raw
  name: 'My source (describe it in a few words)',
  contract: {
    timeZone: 'how the source states time (UTC, local with offset, local without zone) and how parse() turns it into UTC',
    timeRole: 'instant samples | interval: <length> | forecast issues',
    signs: 'what positive means in the source, and how parse() splits it into direction metrics',
    units: 'the source units and the conversion to canonical units',
    missing: 'how the source says "no data" (absent row, null, sentinel) and that parse() returns null for it',
    revisions: 'whether and when old values are corrected (arrives late, grows until the day closes, never)',
    upstreamHistory: 'how far back the source can be asked (days, unlimited, live only)',
  },
};

export const METRICS = [
  // { code: 'my_metric_w', label: 'What it is', unit: 'W', timeRole: 'instant', aggregation: 'mean', domain: 'energy' },
  // timeRole: instant | interval      aggregation: sum | mean | last | integrate
];

// ───────────── 1. FETCH: how to ask (the only part that touches the network) ─────────────
// Return what to call and a loggable copy of the request WITHOUT secrets (it is stored with the raw file).
export function buildRequest(site, creds, window) {
  const url = `https://example.invalid/api/data?from=${window.from}&to=${window.to}`;     // FILL IN
  return { url, opts: { headers: { authorization: `Bearer ${creds.token}` } }, log: { url } };
}

// ───────────── 2. VALIDATE: is this the shape we know? ─────────────
// Return null when fine, or a short reason. A body of an unexpected shape is quarantined (kept,
// marked, produces no facts) so the build treats the input as missing instead of guessing.
export function checkShape(body) {
  if (!body || typeof body !== 'object') return 'body is not an object';
  // if (!Array.isArray(body.data)) return 'no data array';                                 // FILL IN
  return null;
}

// ───────────── 4. PARSE: raw body -> normalised rows (PURE: no database, no network, no clock) ─────────────
// Returns a list of series:
//   { kind: 'reading',  metric, subject: { kind: 'site'|'device'|'region', id }, rows: [{ ts, value, quality? }] }
//   { kind: 'interval', metric, subject, rows: [{ start, end, value, quality? }] }
//   { kind: 'forecast', metric, subject, issuedAt, rows: [{ start, end, value }] }
// A pure function can be tested with a saved real body and re-run later on the stored raw file.
export function parse(body, { site, window }) {
  const out = [];
  // for (const r of body.data) { ... convert to canonical units, UTC seconds, null for missing ... }   // FILL IN
  return out;
}

// ───────────── the shared boilerplate: steps 1, 2, 3, 5, 6 (normally leave as is) ─────────────
export async function processSource(site, creds, window) {
  const req = buildRequest(site, creds, window);
  const body = await fetchJson(req.url, req.opts);                                          // 1 fetch
  const reason = checkShape(body);                                                          // 2 validate
  if (reason) {
    quarantine({ source: SOURCE.code, siteId: site.id, request: req.log, body, reason });
    throw new Error(`${SOURCE.code}: unexpected shape (${reason}); quarantined`);
  }
  const { rawId } = landRaw({ source: SOURCE.code, siteId: site.id, request: req.log, body }); // 3 land raw

  let changed = 0;
  let earliest = Infinity;
  const parsed = parse(body, { site, window });                                             // 4 parse
  // An answer that parsed to nothing is an error the sync log shows, not a quiet success (a source that can legitimately be empty may skip this).
  if (!parsed.some((s) => s.rows.length)) throw new Error(`${SOURCE.code}: the answer had no rows`);
  asWriter(SOURCE.code, () => {                                                             // writes may only touch this source's series
    for (const s of parsed) {
      const id = seriesId(s.subject.kind, String(s.subject.id), s.metric, SOURCE.code);
      const n = s.kind === 'reading' ? putReadings(id, s.rows, rawId)                       // 5 write
        : s.kind === 'interval' ? putIntervals(id, s.rows, rawId)
          : putForecasts(id, s.issuedAt, s.rows, rawId);
      if (n) {
        changed += n;
        earliest = Math.min(earliest, ...s.rows.map((r) => r.ts ?? r.start));
      }
    }
  });
  if (changed) markDirty(site.id, earliest, nowSec(), `new ${SOURCE.code} data`);          // 6 mark dirty: the build rebuilds from there
  return { facts: changed };
}

// ───────────── 7. REGISTER (paste into src/jobs/steps.js; do not register from this file) ─────────────
//
// registerAdapter('my_source', {
//   connection: 'my_source',                       // the home's connection row; omit for a shared feed
//   credentials: (site) => envCredentials(site, { token: 'MY_SOURCE_TOKEN' }),   // reasons name variables, never values
//   roles: {
//     // one of: location, inverter, meter, weather, carbon, solar_forecast, gas_cv, tariff_catalogue, tariff_prices, compare
//     inverter: [{
//       step: 'my_source', order: 20, connection: 'my_source',
//       prepare: (ctx) => ({ from: ..., to: ... }),            // the window: resume from the last success, within the source's history
//       run: (ctx, a, creds) => processSource(ctx.site, creds, a),
//     }],
//   },
// });
//
// ...and one row per market that may use it (a delta or src/db/seed/providers.js):
//   market_provider(market_code, role, adapter, priority, enabled, owner, scope, needs_credentials,
//                   licence_confirmed, origin, note)
//   'core' owner unless another process owns the source's rate limit; licence_confirmed = 0 keeps it off.
//
// ───────────── TEST SKELETON (test/<code>.test.js; temp database, no network) ─────────────
//   1. parse(savedRealBody) equals the expected rows. Trim the fixture; keep it free of secrets and personal data.
//   2. processSource twice with the same body: the second run reports { facts: 0 } (idempotent).
//   3. a changed value becomes one new version and the old one is superseded, never overwritten.
//   4. a body of the wrong shape is quarantined: a raw row with status 'quarantined', zero facts.
//   5. a clock-change day (23 and 25 hours) and a gap in the source: gaps stay null, nothing is invented.
//   6. missing credentials: the step is skipped with a reason and makes no network call.
//
// ───────────── THE SLOT SIDE: how a new source reaches the slots (no engine edit) ─────────────
// The build and the planner read ask for ROLES, not vendors (src/core/inputs.js ROLES): inverter_5min,
// inverter_daily, meter_energy, gas_cv, carbon, weather_temp, ev_dispatch, solar_forecast. To add a source:
//   1. a source row (registry.js SOURCES) with traits when it needs them: { holdS: <seconds a sample holds> }.
//   2. channel rows (src/core/channels.js defineChannel) mapping each of its points to a canonical metric,
//      with scale / shift / part (positive | negative) / min / max. A vendor in kW or with one signed grid figure
//      is only rows. Then call ingestObservations(siteId, source, [{ point, ts, value }]) from parse(), instead of
//      converting inside the processor: unmapped points are reported and bad values land in channel_reject.
//   3. a binding (inputs.js bind) from a date: bind(siteId, 'inverter_5min', 'my_source', { from, reason }).
//      Slots before the date never change; a past date needs a reason. previewImpact (impact.js) shows the
//      effect first; unbind ends a role. Test: test/channels.test.js and test/runtime-provider.test.js.
