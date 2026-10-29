// Push ingest: a device or gateway POSTs its readings to /api/ingest and they go through the SAME channels, counters, events and rules as every
// other provider (core/channels.js ingestObservations). This file is the shared half of the processor template for pushed data:
// the format parsers (core/push-formats.js) are pure and per format; everything here is the same for every sender:
//   1 check the token (optional)   2 read the body   3 find the home   4 parse by format   5 find or register the device
//   6 check acks   7 keep the raw receipt   8 ingest through the channels   9 log what happened   10 answer
// Every body leaves a row in push_log (delta 073), accepted or refused, so the Devices page and a person debugging can see it.
import crypto from 'node:crypto';
import { db, sourceId } from '../db/db.js';
import { landRaw, quarantine } from './facts.js';
import { ingestObservations, channelsFor } from './channels.js';
import { checkDeviceKind, setDeviceAttrs } from './devices.js';
import { getCommand, recordAckRef } from './commands.js';
import { nowSec } from './time.js';
import { FORMATS, PushError, parsePush } from './push-formats.js';

export const MAX_BODY_BYTES = 1024 * 1024;       // enforced by the route (413 too_large)
export const MAX_OBSERVATIONS = 5000;            // enforced here (400 too_many_observations)
export const ENDPOINT = '/api/ingest';

const truthy = (v) => v === true || v === 1 || ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

// ───────────── 1 The optional shared secret ─────────────
// INGEST_TOKEN unset: the endpoint is open (the page says so). Set: every push must carry it, as `Authorization: Bearer <token>` or `X-Ingest-Token`.
// The comparison is constant time: both sides are hashed to the same length, then compared with timingSafeEqual.
export const tokenRequired = (env = process.env) => Boolean(env.INGEST_TOKEN);
export function checkToken(headers = {}, env = process.env) {
  const want = env.INGEST_TOKEN;
  if (!want) return;
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  const auth = String(h('authorization') ?? '');
  const given = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : (h('x-ingest-token') ?? '');
  // A refused token leaves no push_log row: anyone who can reach the port could otherwise fill the log (there is no rate limit).
  const refuse = (code, msg) => Object.assign(new PushError(401, code, msg), { noLog: true });
  if (!given) throw refuse('token_required', 'This core requires a token: send it as "Authorization: Bearer <token>" or "X-Ingest-Token: <token>"');
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  if (!crypto.timingSafeEqual(a, b)) throw refuse('bad_token', 'The token is not the one this core expects');
}

// ───────────── The log ─────────────
function logPush(row) {
  const info = db.prepare(`INSERT INTO push_log (site_id, device_id, source, format, received_at, observations, written, forecasts, derived, rejected, unmapped, warnings, raw_id, status, error, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.siteId ?? null, row.deviceId ?? null, row.source ?? null, row.format ?? null, row.at ?? Date.now(), row.observations ?? 0, row.written ?? 0, row.forecasts ?? 0, row.derived ?? 0,
      row.rejected ?? 0, row.unmapped ?? 0, row.warnings?.length ? JSON.stringify(row.warnings) : null, row.rawId ?? null, row.status, row.error ?? null, row.errorCode ?? null);
  return Number(info.lastInsertRowid);
}

/** The newest push_log rows of a home, newest first (also the pushes that could not be assigned to a home). */
export function recentPushes(siteId, { limit = 20, deviceId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const rows = deviceId != null
    ? db.prepare('SELECT * FROM push_log WHERE site_id = ? AND device_id = ? ORDER BY id DESC LIMIT ?').all(siteId, deviceId, lim)
    : db.prepare('SELECT * FROM push_log WHERE site_id = ? OR site_id IS NULL ORDER BY id DESC LIMIT ?').all(siteId, lim);
  const dev = db.prepare('SELECT label, external_ref FROM device WHERE id = ?');
  return rows.map((r) => {
    const d = r.device_id != null ? dev.get(r.device_id) : null;
    return { id: r.id, at: r.received_at, siteId: r.site_id, unassigned: r.site_id == null, deviceId: r.device_id, device: d ? d.label : null, deviceRef: d ? d.external_ref : null,
      source: r.source, format: r.format, observations: r.observations, written: r.written, forecasts: r.forecasts, derived: r.derived, rejected: r.rejected, unmapped: r.unmapped,
      warnings: r.warnings ? JSON.parse(r.warnings) : [], status: r.status, error: r.error, errorCode: r.error_code, rawId: r.raw_id };
  });
}

/** When a device last pushed something that was accepted (ms), or null. */
export const lastPushAt = (deviceId) => db.prepare("SELECT MAX(received_at) AS t FROM push_log WHERE device_id = ? AND status = 'ok'").get(deviceId)?.t ?? null;

// ───────────── 3 The home ─────────────
function resolveSite(given) {
  if (given != null && given !== '') {
    const id = Number(given);
    const s = Number.isInteger(id) ? db.prepare('SELECT * FROM site WHERE id = ?').get(id) : null;
    if (!s) throw new PushError(404, 'unknown_site', `No home ${given}`, 'site');
    return s;
  }
  const homes = db.prepare('SELECT * FROM site WHERE is_demo = 0 ORDER BY id').all();
  if (homes.length === 1) return homes[0];
  throw new PushError(400, 'site_required', homes.length
    ? `This core has ${homes.length} homes, so the push must say which one: add "site": <id> (or ?site=<id>). Homes: ${homes.map((h) => `${h.id} ${h.name}`).join('; ')}`
    : 'This core has no real home to default to, so the push must say which one: add "site": <id> (or ?site=<id>)', 'site');
}

// ───────────── 5 The device ─────────────
function findDevice(site, ref) {
  const s = String(ref);
  return db.prepare('SELECT * FROM device WHERE site_id = ? AND retired_at IS NULL AND external_ref = ? ORDER BY id LIMIT 1').get(site.id, s)
    ?? (/^\d+$/.test(s) ? db.prepare('SELECT * FROM device WHERE site_id = ? AND retired_at IS NULL AND id = ?').get(site.id, Number(s)) : undefined);
}

function registerDevice(site, ref, { kind, label, emulated }) {
  if (!kind) throw new PushError(400, 'kind_required', 'To register a device say what it is: "kind": e.g. smart_plug, heat_pump, ev_charger, temperature_sensor', 'kind');
  try { checkDeviceKind(kind); } catch (err) { throw new PushError(400, 'unknown_kind', err.message, 'kind'); }
  const name = String(label ?? ref).slice(0, 80);
  const id = Number(db.prepare("INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, ?, 'push', ?, ?, '{}', ?)")
    .run(site.id, kind, String(ref).slice(0, 80), name, Date.now()).lastInsertRowid);
  setDeviceAttrs(id, emulated ? { emulated: true } : {});
  return db.prepare('SELECT * FROM device WHERE id = ?').get(id);
}

/**
 * Handle one push. rawText: the body exactly as received. query: the URL's query parameters. Returns { status, body } for a push that was
 * understood, and throws PushError for one that was refused (the route turns it into { error, code, field? }). Either way a push_log row is written.
 */
export function handlePush(rawText, { query = {}, headers = {}, now = nowSec() } = {}) {
  const at = Date.now();
  const ctx = { at, format: query.format ?? null };           // what the log row knows so far
  const refuse = (err) => {
    ctx.logId = logPush({ ...ctx, status: 'rejected', error: err.message, errorCode: err.code });
    err.logId = ctx.logId; throw err;
  };
  try {
    // 1 token
    checkToken(headers);

    // 2 the body: JSON only; anything else is kept as a quarantined receipt (never parsed into facts)
    let body;
    try { body = JSON.parse(rawText); } catch (e) {
      try { quarantine({ source: 'push_native', siteId: null, request: { path: ENDPOINT }, body: String(rawText).slice(0, 20000), reason: 'malformed JSON' }); } catch { /* the receipt is best effort */ }
      throw new PushError(400, 'malformed_json', `The body is not valid JSON: ${e.message}`);
    }
    if (body === null || typeof body !== 'object') throw new PushError(400, 'bad_body', 'The body must be a JSON object or array');

    // the envelope: for the native format the body is the envelope; for a vendor format the body is the vendor's JSON and the envelope comes from the
    // query string, or from a wrapper { format, site, device, ..., payload: <vendor JSON> }
    const wrapped = !Array.isArray(body) && body.payload !== undefined && typeof body.format === 'string';
    const format = (wrapped ? body.format : null) ?? query.format ?? (Array.isArray(body) ? 'homeassistant_state' : body.format) ?? 'native';
    ctx.format = format;
    if (!FORMATS[format]) throw new PushError(400, 'unknown_format', `Unknown format "${format}": one of ${Object.keys(FORMATS).join(', ')}`, 'format');
    const env = (format === 'native' || wrapped) && !Array.isArray(body) ? body : {};
    const payload = wrapped ? body.payload : body;
    const pick = (k) => env[k] ?? query[k];

    // 3 the home
    const site = resolveSite(pick('site'));
    ctx.siteId = site.id;

    // 4 parse (pure)
    if (format === 'native' && payload && Array.isArray(payload.observations) && payload.observations.length > MAX_OBSERVATIONS) {
      throw new PushError(400, 'too_many_observations', `At most ${MAX_OBSERVATIONS} observations per push (this one has ${payload.observations.length}): split it`, 'observations');
    }
    let parsed;
    try { parsed = parsePush(format, payload, { now, tz: site.timezone }); } catch (err) {
      if (err instanceof PushError) {
        try { quarantine({ source: FORMATS[format].source, siteId: site.id, request: { path: ENDPOINT, format }, body: rawText, reason: `${err.code}: ${err.message}`.slice(0, 300) }); } catch { /* best effort */ }
      }
      throw err;
    }
    if (parsed.observations.length > MAX_OBSERVATIONS) throw new PushError(400, 'too_many_observations', `At most ${MAX_OBSERVATIONS} observations per push`, 'observations');
    const warnings = [...parsed.warnings];

    // the source: the format's own unless the native body names another known one
    const source = pick('source') ?? FORMATS[format].source;
    try { sourceId(source); } catch { throw new PushError(400, 'unknown_source', `Unknown source "${source}": a source is described once before data is pushed under it (push_native is available)`, 'source'); }
    ctx.source = source; ctx.observations = parsed.observations.length;

    // 5 the device (none named = the home itself)
    const ref = pick('device') ?? parsed.deviceHint ?? null;
    let device = null; let created = false;
    if (ref != null && ref !== '') {
      device = findDevice(site, ref);
      if (device?.provider === 'synthetic') throw new PushError(400, 'synthetic_device', `"${ref}" is a synthetic demo device: the demo generator feeds it, not pushes`, 'device');
      if (!device) {
        if (!truthy(pick('register'))) throw new PushError(404, 'unknown_device', `No device "${ref}" in home ${site.id}. Register it by sending "register": true (and "kind": e.g. smart_plug), or create it first`, 'device');
        device = registerDevice(site, ref, { kind: pick('kind') ?? parsed.kindHint, label: pick('label'), emulated: truthy(pick('emulated')) });
        created = true; warnings.push(`registered a new ${device.kind} "${device.label}" with its standard channels`);
      }
      ctx.deviceId = device.id;
    }

    // 6 acks: a receipt for a command that does not exist (or belongs to another home) is refused, before anything is stored
    const acks = parsed.observations.filter((o) => o.kind === 'ack');
    for (const a of acks) {
      const c = getCommand(a.commandId);
      const owner = c ? db.prepare('SELECT site_id FROM device WHERE id = ?').get(c.device_id)?.site_id : null;
      if (!c || owner !== site.id) throw new PushError(404, 'unknown_command', `No command ${a.commandId} in home ${site.id}: an ack must name a command this home sent`, 'commandId');
    }

    // 7 the raw receipt (identical bodies are kept once)
    const { rawId, duplicate } = landRaw({ source, siteId: site.id, request: { path: ENDPOINT, format, device: ref ?? null }, body: rawText });
    ctx.rawId = rawId;
    if (duplicate) warnings.push('this exact body was received before: the receipt is the same one');

    // 8 ingest through the channels: units, signs, limits, counters, events, states all as for any provider
    const res = ingestObservations(site.id, source, parsed.observations, rawId, { deviceId: device?.id ?? null, now });
    for (const a of res.acks) { if (a.commandId != null) recordAckRef(a.commandId, a.ref); }
    const kinds = new Map();
    for (const o of parsed.observations) if (o.point && !kinds.has(o.point)) kinds.set(o.point, channelsFor(site.id, source, o.point, device?.id ?? null)[0]?.kind ?? null);
    const events = parsed.observations.filter((o) => o.point && kinds.get(o.point) === 'event' && o.value !== 0).length;
    if (res.unmapped.length) warnings.push(`no channel for: ${res.unmapped.join(', ')} (reported, not stored)`);
    if (res.rejected) warnings.push(`${res.rejected} reading${res.rejected === 1 ? ' was' : 's were'} refused by the channel rules (see the rejected values)`);

    // 9 log and 10 answer
    const logId = logPush({ ...ctx, written: res.written, forecasts: res.forecasts, derived: res.derived, rejected: res.rejected, unmapped: res.unmapped.length, warnings, status: 'ok' });
    return { status: 200, body: {
      ok: true, site: site.id, device: device?.id ?? null, deviceRef: device?.external_ref ?? null, created, format, source, observations: parsed.observations.length,
      written: res.written, forecasts: res.forecasts, derived: res.derived, counters: res.counters, events, states: res.states, acks: res.acks.length, stuck: res.stuck,
      rejected: res.rejected, unmapped: res.unmapped, warnings, rawId, duplicate, logId } };
  } catch (err) {
    if (err instanceof PushError) {
      if (err.logId == null && !err.noLog) refuse(err);
      throw err;
    }
    // a failure inside the core: logged as an error, answered as a 500 without the internals
    ctx.logId = logPush({ ...ctx, status: 'error', error: String(err.message).slice(0, 300), errorCode: 'internal' });
    const e = new PushError(500, 'internal', 'The core failed to store this push; it was logged', null); e.logId = ctx.logId; e.cause = err;
    throw e;
  }
}

export { PushError, FORMATS };
