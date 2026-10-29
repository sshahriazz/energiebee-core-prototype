// Push formats: pure parsers that turn the body a device or gateway posts to POST /api/ingest into the list of observations the
// shared ingest path (core/channels.js ingestObservations) takes. Pure: no database, no network, no clock (the time is passed in),
// so each parser is tested with a saved body. This is the processor template's "parse" step for pushed data.
//
// A parser names points the way the device-kind channel defaults do (registry.js DEVICE_KIND_CHANNELS): `power` in W, `energy_total` in kWh,
// `relay` as 0/1, `temperature` in degC. The vendor's own units are converted HERE because a format knows its vendor's documented
// units (Shelly reports energy in Wh); the channel rows then do only what is the home's own (sign split, limits, counter behaviour).
//
// UNVERIFIED: the Shelly Gen2, Tasmota and Home Assistant shapes below follow the vendors' DOCUMENTED formats. None has been tried against a
// real device. The fixtures in test/fixtures/push/*.documented-shape.json are those documented shapes, not captures.
import { localToUtcAll } from './time.js';

export class PushError extends Error {
  constructor(status, code, message, field = null) { super(message); this.status = status; this.code = code; this.field = field; }
}

export const FORMATS = {
  native: { source: 'push_native', label: 'Native', about: 'The core\'s own format: a list of observations, or a plain set of points read at one time.', points: ['any point the device has a channel for'] },
  shelly_gen2_switch: { source: 'push_shelly_gen2', label: 'Shelly Gen2 switch', about: 'The status object of a Shelly Gen2 switch (also the NotifyStatus message and the whole device status). Energy arrives in Wh.', points: ['power', 'energy_total', 'relay'] },
  tasmota_sensor: { source: 'push_tasmota', label: 'Tasmota SENSOR', about: 'Tasmota SENSOR telemetry with an ENERGY block (and POWER from a STATE message). Time is the device local time.', points: ['power', 'energy_total', 'relay'] },
  homeassistant_state: { source: 'push_homeassistant', label: 'Home Assistant state', about: 'A Home Assistant state object (or a list of them): energy, power, temperature and switch entities.', points: ['energy_total', 'power', 'temperature', 'relay'] },
};

// ───────────── Times and numbers ─────────────
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** A time as epoch seconds. Accepts seconds, milliseconds (above 1e11, with a warning), numeric strings and ISO 8601 (no offset = UTC, with a warning). */
export function toSeconds(v, warnings, field) {
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) v = Number(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PushError(400, 'bad_timestamp', `${field} is not a finite number`, field);
    if (v > 1e11) { warnings.push(`${field}: ${v} is above 1e11, so it was read as milliseconds`); return Math.floor(v / 1000); }
    if (v < 0) throw new PushError(400, 'bad_timestamp', `${field} is negative`, field);
    return Math.floor(v);
  }
  if (typeof v === 'string') {
    const m = ISO.exec(v.trim());
    if (!m) throw new PushError(400, 'bad_timestamp', `${field} is not a number of seconds or an ISO 8601 time: ${String(v).slice(0, 40)}`, field);
    if (!m[8]) warnings.push(`${field}: "${v}" has no time zone offset, so it was read as UTC`);
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ?? ''}${m[8] ? (m[8].toUpperCase() === 'Z' ? 'Z' : m[8].includes(':') ? m[8] : `${m[8].slice(0, 3)}:${m[8].slice(3)}`) : 'Z'}`;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) throw new PushError(400, 'bad_timestamp', `${field} is not a valid time: ${String(v).slice(0, 40)}`, field);
    return Math.floor(t / 1000);
  }
  throw new PushError(400, 'bad_timestamp', `${field} must be a number of seconds or an ISO 8601 string`, field);
}

/** A value as a finite number: numbers, numeric strings, booleans (1 or 0) and the words on/off/true/false. Anything else is refused. */
export function toNumber(v, field) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'on' || s === 'true') return 1;
    if (s === 'off' || s === 'false') return 0;
    if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new PushError(400, 'bad_value', `${field} is not a finite number: ${JSON.stringify(v)?.slice(0, 40)}`, field);
}

const POINT = /^[A-Za-z0-9_.:\-/ ]{1,64}$/;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ───────────── Native ─────────────
/**
 * Native body: { observations: [...] } or { points: { name: value }, ts? }. An observation is { point, value, ts } (an instant, a counter, a state),
 * { point, start, end, value } (a period), { point, start, end, issuedAt, value } (a forecast), { point, ts | start+end } with no value (an event), or
 * { kind: 'ack', commandId, ref, ts }. A client cannot name a raw receipt: rawId is ignored (the core links the receipt itself).
 */
export function parseNative(body, { now }) {
  const warnings = []; const ignored = [];
  if (!isObj(body)) throw new PushError(400, 'bad_body', 'The body must be a JSON object');
  let list;
  if (Array.isArray(body.observations)) list = body.observations;
  else if (isObj(body.points)) {
    const ts = body.ts != null ? toSeconds(body.ts, warnings, 'ts') : now;
    list = Object.entries(body.points).map(([point, value]) => ({ point, value, ts }));
  } else throw new PushError(400, 'no_observations', 'The body needs "observations": [...] or "points": { name: value }', 'observations');
  if (!list.length) throw new PushError(400, 'no_observations', 'The body has no observations', 'observations');
  const observations = [];
  list.forEach((o, i) => {
    const at = `observations[${i}]`;
    if (!isObj(o)) throw new PushError(400, 'bad_observation', `${at} must be an object`, at);
    if (o.kind === 'ack') {
      if (o.commandId == null) throw new PushError(400, 'bad_observation', `${at}: an ack needs commandId`, `${at}.commandId`);
      const id = Number(o.commandId);
      if (!Number.isInteger(id) || id < 1) throw new PushError(400, 'bad_observation', `${at}.commandId must be a command number`, `${at}.commandId`);
      observations.push({ kind: 'ack', commandId: id, ref: o.ref == null ? null : String(o.ref).slice(0, 120), ts: o.ts != null ? toSeconds(o.ts, warnings, `${at}.ts`) : now });
      return;
    }
    if (typeof o.point !== 'string' || !POINT.test(o.point)) throw new PushError(400, 'bad_point', `${at}.point must be a name of up to 64 letters, digits, spaces or . _ : - /`, `${at}.point`);
    if (o.rawId != null) warnings.push(`${at}: rawId is ignored (the core links the receipt itself)`);
    if (o.kind != null && !['state', 'counter', 'event'].includes(o.kind)) throw new PushError(400, 'bad_observation', `${at}.kind must be state, counter, event or ack when given`, `${at}.kind`);
    const out = { point: o.point };
    if (o.kind) out.kind = o.kind;
    if (o.quality != null) { if (!Number.isInteger(o.quality) || o.quality < 0) throw new PushError(400, 'bad_observation', `${at}.quality must be a whole number`, `${at}.quality`); out.quality = o.quality; }
    const hasTs = o.ts != null; const hasSpan = o.start != null || o.end != null;
    if (hasTs && hasSpan) throw new PushError(400, 'bad_observation', `${at} has both ts and start/end: use one`, at);
    if (hasTs) out.ts = toSeconds(o.ts, warnings, `${at}.ts`);
    else if (hasSpan) {
      if (o.start == null || o.end == null) throw new PushError(400, 'bad_observation', `${at} needs both start and end`, at);
      out.start = toSeconds(o.start, warnings, `${at}.start`); out.end = toSeconds(o.end, warnings, `${at}.end`);
      if (!(out.end > out.start)) throw new PushError(400, 'bad_observation', `${at}: end must be after start`, at);
      if (o.issuedAt != null) out.issuedAt = toSeconds(o.issuedAt, warnings, `${at}.issuedAt`);
    } else throw new PushError(400, 'bad_observation', `${at} needs a time: ts, or start and end`, at);
    if (o.value != null) out.value = toNumber(o.value, `${at}.value`);
    else if (!(o.kind === 'event')) throw new PushError(400, 'bad_value', `${at}.value is missing`, `${at}.value`);
    observations.push(out);
  });
  return { observations, warnings, ignored, deviceHint: null, kindHint: null };
}

// ───────────── Shelly Gen2 switch ─────────────
// Documented: the switch status { id, source, output, apower (W), voltage, current, freq, aenergy: { total (Wh), by_minute, minute_ts }, temperature }.
// It arrives bare, inside a NotifyStatus message { src, dst, method, params: { ts, "switch:0": {...} } }, or inside a whole device status { "switch:0": {...} }.
export function parseShellyGen2Switch(body, { now }) {
  const warnings = []; const ignored = [];
  if (!isObj(body)) throw new PushError(400, 'bad_body', 'The body must be a JSON object');
  const holder = isObj(body.params) ? body.params : body;
  const key = Object.keys(holder).find((k) => /^switch:\d+$/.test(k) && isObj(holder[k]));
  const sw = key ? holder[key] : (('apower' in body || 'aenergy' in body || 'output' in body) ? body : null);
  if (!sw) throw new PushError(400, 'unrecognised_shape', 'No Shelly Gen2 switch status found: expected apower, aenergy or output (bare, in params, or as "switch:0")');
  if (key && Object.keys(holder).filter((k) => /^switch:\d+$/.test(k)).length > 1) warnings.push(`the body has several switches; only ${key} was read`);
  const tsRaw = holder.ts ?? body.ts;
  const ts = tsRaw != null ? toSeconds(tsRaw, warnings, 'ts') : now;
  const observations = [];
  if (sw.apower != null) observations.push({ point: 'power', ts, value: toNumber(sw.apower, 'apower') });
  if (isObj(sw.aenergy) && sw.aenergy.total != null) observations.push({ point: 'energy_total', ts, value: toNumber(sw.aenergy.total, 'aenergy.total') / 1000 });   // Wh to kWh
  if (sw.output != null) observations.push({ point: 'relay', ts, value: toNumber(sw.output, 'output') });
  for (const k of ['voltage', 'current', 'freq', 'temperature', 'ret_aenergy', 'pf']) if (sw[k] != null) ignored.push(k);
  if (!observations.length) throw new PushError(400, 'unrecognised_shape', 'The switch status had none of apower, aenergy.total or output');
  if (ignored.length) warnings.push(`not used: ${ignored.join(', ')}`);
  return { observations, warnings, ignored, deviceHint: typeof body.src === 'string' ? body.src : null, kindHint: 'smart_plug' };
}

// ───────────── Tasmota SENSOR ─────────────
// Documented: { "Time": "2026-10-27T10:15:00", "ENERGY": { "Total": kWh, "Yesterday", "Today", "Power": W, "Voltage", "Current", ... } }; a STATE message adds "POWER": "ON".
// Time is the device's LOCAL time with no offset, so it is read in the home's time zone (tz).
export function parseTasmotaSensor(body, { now, tz = 'UTC' }) {
  const warnings = []; const ignored = [];
  if (!isObj(body)) throw new PushError(400, 'bad_body', 'The body must be a JSON object');
  const en = isObj(body.ENERGY) ? body.ENERGY : null;
  if (!en && body.POWER == null) throw new PushError(400, 'unrecognised_shape', 'No Tasmota ENERGY block or POWER state found');
  let ts = now;
  if (body.Time != null) {
    const m = ISO.exec(String(body.Time).trim());
    if (m && !m[8]) {
      // A local time with no zone: it may not exist (clocks went forward: refused) or happen twice (clocks went back: the instant nearest the
      // moment the push arrived, because the device sends its reading as it is made).
      const cands = localToUtcAll(tz, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
      if (!cands.length) throw new PushError(400, 'bad_timestamp', `Time ${body.Time} does not exist in ${tz} (the clocks went forward)`, 'Time');
      ts = cands.reduce((best, c) => (Math.abs(c - now) < Math.abs(best - now) ? c : best)) + Number(m[6] ?? 0);
    } else ts = toSeconds(body.Time, warnings, 'Time');
  }
  const observations = [];
  if (en?.Power != null) observations.push({ point: 'power', ts, value: toNumber(en.Power, 'ENERGY.Power') });
  if (en?.Total != null) observations.push({ point: 'energy_total', ts, value: toNumber(en.Total, 'ENERGY.Total') });
  if (body.POWER != null) observations.push({ point: 'relay', ts, value: toNumber(body.POWER, 'POWER') });
  for (const k of ['Yesterday', 'Today', 'Period', 'ApparentPower', 'ReactivePower', 'Factor', 'Voltage', 'Current']) if (en && en[k] != null) ignored.push(k);
  if (!observations.length) throw new PushError(400, 'unrecognised_shape', 'The Tasmota body had none of ENERGY.Power, ENERGY.Total or POWER');
  if (ignored.length) warnings.push(`not used: ${ignored.join(', ')}`);
  return { observations, warnings, ignored, deviceHint: null, kindHint: 'smart_plug' };
}

// ───────────── Home Assistant state ─────────────
// Documented: { entity_id, state, attributes: { unit_of_measurement, device_class, friendly_name }, last_changed, last_updated }.
const ENERGY_TO_KWH = { wh: 0.001, kwh: 1, mwh: 1000 };
const POWER_TO_W = { w: 1, kw: 1000, mw: 1e6 };
export function parseHomeAssistantState(body, { now }) {
  const warnings = []; const ignored = [];
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || !items.every(isObj)) throw new PushError(400, 'bad_body', 'The body must be a state object or a list of them');
  const observations = []; let kindHint = null;
  items.forEach((s, i) => {
    const at = items.length > 1 ? `[${i}]` : '';
    if (typeof s.entity_id !== 'string' || !('state' in s)) throw new PushError(400, 'unrecognised_shape', `${at}A Home Assistant state needs entity_id and state`, `${at}entity_id`);
    const attrs = isObj(s.attributes) ? s.attributes : {};
    const stateWord = String(s.state ?? '').toLowerCase();
    if (['unavailable', 'unknown', 'none', ''].includes(stateWord)) { warnings.push(`${s.entity_id}: the state is "${s.state}", so nothing was stored`); return; }
    const ts = s.last_updated != null ? toSeconds(s.last_updated, warnings, `${at}last_updated`) : s.last_changed != null ? toSeconds(s.last_changed, warnings, `${at}last_changed`) : now;
    const domain = s.entity_id.split('.')[0];
    const unit = String(attrs.unit_of_measurement ?? '').toLowerCase().replace('°', '');
    const cls = attrs.device_class ?? (unit in ENERGY_TO_KWH ? 'energy' : unit in POWER_TO_W ? 'power' : null);
    if (cls === 'energy' && unit in ENERGY_TO_KWH) { observations.push({ point: 'energy_total', ts, value: toNumber(s.state, `${s.entity_id} state`) * ENERGY_TO_KWH[unit] }); kindHint ??= 'smart_plug'; }
    else if (cls === 'power' && unit in POWER_TO_W) { observations.push({ point: 'power', ts, value: toNumber(s.state, `${s.entity_id} state`) * POWER_TO_W[unit] }); kindHint ??= 'smart_plug'; }
    else if (cls === 'temperature' && (unit === 'c' || unit === 'f')) {
      const v = toNumber(s.state, `${s.entity_id} state`);
      observations.push({ point: 'temperature', ts, value: unit === 'f' ? ((v - 32) * 5) / 9 : v }); kindHint ??= 'temperature_sensor';
    } else if (domain === 'switch' || domain === 'input_boolean') { observations.push({ point: 'relay', ts, value: toNumber(s.state, `${s.entity_id} state`) }); kindHint ??= 'smart_plug'; }
    else { ignored.push(s.entity_id); warnings.push(`${s.entity_id}: device_class ${cls ?? 'none'} with unit "${attrs.unit_of_measurement ?? ''}" is not mapped, so it was not stored`); }
  });
  if (!observations.length) throw new PushError(400, 'nothing_to_store', 'None of the states could be stored: ' + (warnings.join('; ') || 'no mapped entity'));
  return { observations, warnings, ignored, deviceHint: null, kindHint };
}

const PARSERS = { native: parseNative, shelly_gen2_switch: parseShellyGen2Switch, tasmota_sensor: parseTasmotaSensor, homeassistant_state: parseHomeAssistantState };

/** Parse a body of the given format. Returns { observations, warnings, ignored, deviceHint, kindHint } or throws PushError. */
export function parsePush(format, body, opts = {}) {
  const parse = PARSERS[format];
  if (!parse) throw new PushError(400, 'unknown_format', `Unknown format "${format}": one of ${Object.keys(PARSERS).join(', ')}`, 'format');
  return parse(body, { now: opts.now ?? Math.floor(Date.now() / 1000), tz: opts.tz ?? 'UTC' });
}
