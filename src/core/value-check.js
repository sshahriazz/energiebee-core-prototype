// Checking a typed-in or provider value against its registry row: an attribute (attribute_def,
// src/core/attributes.js) or a planner setting (setting_def, src/core/settings.js). One set of rules
// for both, so a new key is a registry row, never new code:
//   value_type   number | integer | boolean | string | enum | json
//   min_value, max_value   inclusive bounds (number, integer)
//   step         the value must be a whole multiple of it (plan_interval_min: 5)
//   allowed_values   JSON array: the only values an enum (or a string that lists them) may take
//   json_shape   the name of a structure check below (a curve, a list of arrays, a schedule ...);
//                a shape name the code does not know only requires valid JSON
// A value that fails is refused with a RangeError naming the key, the rule and the value.
// null, undefined and '' mean "no value" (a withdrawal or a reset to the default) and are not checked.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const inRange = (x, lo, hi) => isNum(x) && x >= lo && x <= hi;
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Each shape: what it looks like (for the error message) and a check returning null when the value
// fits, or the first problem found.
export const SHAPES = Object.freeze({
  soc_curve: {
    looks: 'an object {"<state of charge %, 0-100>": <rate factor 0-1>}, e.g. {"0": 1, "90": 0.6, "100": 0.2}',
    check: (v) => curve(v, 0, 100, 0, 1),
  },
  temp_curve: {
    looks: 'an object {"<battery temperature degC, -40 to 80>": <rate factor 0-1>}, e.g. {"0": 0.5, "10": 1}',
    check: (v) => curve(v, -40, 80, 0, 1),
  },
  crate_curve: {
    looks: 'an object {"<battery temperature degC, -40 to 80>": <C-rate 0-5>}, e.g. {"0": 0.1, "10": 0.5, "20": 1}',
    check: (v) => curve(v, -40, 80, 0, 5),
  },
  wc_curve: {
    looks: 'an object {"<outdoor degC, -40 to 40>": <flow degC 15-90>} that includes -20 and 20, e.g. {"-20": 55, "0": 45, "20": 30}',
    check: (v) => curve(v, -40, 40, 15, 90) ?? (Object.keys(v).map(Number).includes(-20) && Object.keys(v).map(Number).includes(20) ? null : 'must include -20 and 20'),
  },
  delta_t_curve: {
    looks: 'an object {"<water-to-air difference K, 0-100>": <output factor 0-3>}, e.g. {"50": 1, "30": 0.5}',
    check: (v) => curve(v, 0, 100, 0, 3),
  },
  efficiency_curve: {
    looks: 'an object {"<return water degC, 0-100>": <efficiency 0.3-1.2>}, e.g. {"30": 0.97, "60": 0.87}',
    check: (v) => curve(v, 0, 100, 0.3, 1.2),
  },
  cop_curve: {
    looks: 'an object {"<outdoor degC, -30 to 40>": <COP 0.5-10>}, e.g. {"-5": 2.6, "7": 3.8}',
    check: (v) => curve(v, -30, 40, 0.5, 10),
  },
  export_triggers: {
    looks: 'a list [{name, minutes >= 0, energy (kWh) >= 0}]',
    check: (v) => list(v, 0, 50, (t, i) => {
      if (!isObject(t) || typeof t.name !== 'string' || !/^[a-z0-9_]+$/.test(t.name)) return `trigger ${i}: name must be a code [a-z0-9_]`;
      if (!(Number.isInteger(t.minutes) && t.minutes >= 0)) return `trigger ${i}: minutes must be a whole number >= 0`;
      if (!(isNum(t.energy) && t.energy >= 0)) return `trigger ${i}: energy must be kWh >= 0`;
      return null;
    }),
  },
  pv_arrays: {
    looks: 'a list [{kwp > 0, tilt 0-90, azimuth 0-360 (180 = south), shading 0-1, shading_factors [0-1 ...], efficiency 0-2, inverter_id, name (all but kwp, tilt, azimuth optional)}]',
    check: (v) => list(v, 1, 50, (a, i) => {
      if (!isObject(a)) return `array ${i} is not an object`;
      if (!(isNum(a.kwp) && a.kwp > 0 && a.kwp <= 1000)) return `array ${i}: kwp must be a number in (0, 1000]`;
      if (!inRange(a.tilt, 0, 90)) return `array ${i}: tilt must be 0-90 degrees`;
      if (!inRange(a.azimuth, 0, 360)) return `array ${i}: azimuth must be 0-360 degrees`;
      if (a.shading != null && !inRange(a.shading, 0, 1)) return `array ${i}: shading must be a fraction 0-1`;
      if (a.shading_factors != null && !(Array.isArray(a.shading_factors) && a.shading_factors.every((x) => inRange(x, 0, 1)))) return `array ${i}: shading_factors must be a list of fractions 0-1`;
      if (a.efficiency != null && !inRange(a.efficiency, 0, 2)) return `array ${i}: efficiency must be 0-2`;
      if (a.inverter_id != null && !['string', 'number'].includes(typeof a.inverter_id)) return `array ${i}: inverter_id must be a string or number`;
      return null;
    }),
  },
  cop_grid: {
    looks: 'an object {"<outdoor degC, -30 to 40>": {"<flow degC, 20-80>": <COP 0.5-10>}}, e.g. {"-5": {"35": 2.6, "45": 2.1}, "7": {"35": 3.8}}',
    check: (v) => {
      if (!isObject(v) || !Object.keys(v).length) return 'not a non-empty object';
      for (const [out, row] of Object.entries(v)) {
        if (!inRange(Number(out), -30, 40) || out.trim() === '') return `outdoor temperature "${out}" is not a number in -30..40`;
        const p = curve(row, 20, 80, 0.5, 10);
        if (p) return `outdoor ${out}: ${p}`;
      }
      return null;
    },
  },
  zones: {
    looks: 'a list [{id, name, target_temp_c 5-30 (optional), floor_area_m2 > 0 (optional), emitter_type (optional)}] with distinct ids',
    check: (v) => {
      const p = list(v, 1, 50, (z, i) => {
        if (!isObject(z)) return `zone ${i} is not an object`;
        if (!['string', 'number'].includes(typeof z.id) || String(z.id) === '') return `zone ${i}: id is required`;
        if (z.name != null && typeof z.name !== 'string') return `zone ${i}: name must be text`;
        if (z.target_temp_c != null && !inRange(z.target_temp_c, 5, 30)) return `zone ${i}: target_temp_c must be 5-30`;
        if (z.floor_area_m2 != null && !(isNum(z.floor_area_m2) && z.floor_area_m2 > 0)) return `zone ${i}: floor_area_m2 must be > 0`;
        return null;
      });
      if (p) return p;
      return new Set(v.map((z) => String(z.id))).size === v.length ? null : 'zone ids repeat';
    },
  },
  schedule: {
    looks: 'a list [{start "HH:MM", end "HH:MM", target_c 5-90 (optional), days ["mon".."sun"] (optional)}] (an empty list: no schedule)',
    check: (v) => list(v, 0, 100, (s, i) => {
      if (!isObject(s)) return `entry ${i} is not an object`;
      if (!HHMM.test(s.start ?? '') || !HHMM.test(s.end ?? '')) return `entry ${i}: start and end must be "HH:MM"`;
      if (s.target_c != null && !inRange(s.target_c, 5, 90)) return `entry ${i}: target_c must be 5-90`;
      if (s.days != null && !(Array.isArray(s.days) && s.days.every((d) => DAYS.includes(d)))) return `entry ${i}: days must be a list of ${DAYS.join(', ')}`;
      return null;
    }),
  },
  days_list: {
    looks: 'a list of 1-14 whole numbers of days back, 1-28, e.g. [7] or [1, 7]',
    check: (v) => list(v, 1, 14, (d, i) => (Number.isInteger(d) && d >= 1 && d <= 28 ? null : `entry ${i} is not a whole number 1-28`)),
  },
  weights: {
    looks: 'a list of 1-14 weights, each 0-10, e.g. [1] or [0.5, 1]',
    check: (v) => list(v, 1, 14, (w, i) => (inRange(w, 0, 10) ? null : `entry ${i} is not a number 0-10`)),
  },
  time_hhmm: { looks: 'a local time "HH:MM" (24-hour)', check: (v) => (typeof v === 'string' && HHMM.test(v) ? null : 'not "HH:MM"') },
  code: { looks: 'a code of lower-case letters, digits and _ (e.g. gb_bank_holiday)', check: (v) => (typeof v === 'string' && /^[a-z0-9_]+$/.test(v) ? null : 'not a code [a-z0-9_]') },
});

function curve(v, kLo, kHi, vLo, vHi) {
  if (!isObject(v) || !Object.keys(v).length) return 'not a non-empty object';
  for (const [k, x] of Object.entries(v)) {
    if (k.trim() === '' || !inRange(Number(k), kLo, kHi)) return `key "${k}" is not a number in ${kLo}..${kHi}`;
    if (!inRange(x, vLo, vHi)) return `value at "${k}" is not a number in ${vLo}..${vHi}`;
  }
  return null;
}
function list(v, lo, hi, each) {
  if (!Array.isArray(v)) return 'not a list';
  if (v.length < lo || v.length > hi) return `must have ${lo}-${hi} entries, has ${v.length}`;
  for (let i = 0; i < v.length; i++) { const p = each(v[i], i); if (p) return p; }
  return null;
}

const parseList = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

// A registry row as read from SQLite (attribute_def or setting_def), with its JSON columns parsed.
export function parseDef(row) {
  if (!row) return null;
  return { ...row, allowed_values: parseList(row.allowed_values), applies_to: parseList(row.applies_to) ?? row.applies_to, origins: parseList(row.origins) ?? null, refs: parseList(row.refs) ?? [] };
}

/**
 * The value checked and normalised for storing (a number, boolean, string, object or list), or null
 * for "no value". `what` names it in the error, e.g. "attribute reserve_pct".
 */
export function checkValue(def, value, what = def?.key) {
  if (!def) throw new RangeError(`${what}: unknown key`);
  if (value === undefined || value === null || value === '') return null;
  const fail = (why) => { throw new RangeError(`${what}: ${why} (got ${JSON.stringify(value)})`); };
  let v = value;
  switch (def.value_type) {
    case 'number':
    case 'integer': {
      v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (!isNum(v)) fail(`must be a ${def.value_type}`);
      if (def.value_type === 'integer' && !Number.isInteger(v)) fail('must be a whole number');
      if (def.min_value != null && v < def.min_value) fail(`must be at least ${def.min_value}${def.unit ? ` ${def.unit}` : ''}`);
      if (def.max_value != null && v > def.max_value) fail(`must be at most ${def.max_value}${def.unit ? ` ${def.unit}` : ''}`);
      if (def.step != null && def.step > 0 && Math.abs(v / def.step - Math.round(v / def.step)) > 1e-9) fail(`must be a multiple of ${def.step}`);
      break;
    }
    case 'boolean':
      if (value === true || value === 1 || value === 'true' || value === '1') v = true;
      else if (value === false || value === 0 || value === 'false' || value === '0') v = false;
      else fail('must be true or false');
      break;
    case 'string':
    case 'enum':
      if (typeof value !== 'string') fail('must be text');
      if ((def.value_type === 'enum' || def.allowed_values) && !(def.allowed_values || []).includes(value)) fail(`must be one of ${(def.allowed_values || []).join(', ')}`);
      break;
    case 'json':
      if (typeof value === 'string') { try { v = JSON.parse(value); } catch { fail('is not valid JSON'); } }
      if (v == null || typeof v !== 'object') fail('must be a JSON object or list');
      break;
    default:
      fail(`has an unknown value_type ${def.value_type}`);
  }
  const shape = def.json_shape ? SHAPES[def.json_shape] : null;
  if (shape) { const p = shape.check(v); if (p) fail(`must be ${shape.looks}: ${p}`); }
  return v;
}

// Stored form (JSON text) and back.
export const encodeValue = (v) => (v == null ? null : JSON.stringify(v));
export const decodeValue = (s) => (s == null ? null : JSON.parse(s));
