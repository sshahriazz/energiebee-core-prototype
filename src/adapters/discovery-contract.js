// Integration contract v2: what an integration says about the devices it found (plan 2.4). Pure: no database, no network.
//
// An integration (a hub driver, a cloud connector, a push endpoint) does not name homes or devices by internal id. It reports
// *external* identities: a device is { externalRef, kind, label, attrs, points }, where externalRef is the provider's own name for it
// (a serial, an MPAN, a hub's device id) and each point is { point, metric, ...mapping }: the provider's field and what it means. The
// core resolves them: a link (src/core/links.js) finds or makes the thing, a point binding (point_binding) maps the field to the
// point of that thing (src/core/integration.js). Discovery is idempotent: the same report twice makes nothing new.
//
//   Discovered  { externalRef, kind, label?, attrs?, points?: [{ point, metric, scale?, shift?, part?, min?, max?, access?, kind?, derived? }] }
//   Observation { externalRef, point, ts, value, quality? }                a reading, or a counter's reading with kind: 'counter'
//               { externalRef, point, start, end, value }                    an amount over a period
//               { externalRef, kind: 'ack', ref?, commandId?, ts? }          a device's answer to a command
export const POINT_PARTS = ['all', 'positive', 'negative', 'abs'];
export const POINT_KINDS = ['value', 'counter', 'event'];
export const POINT_ACCESS = ['read', 'write', 'readwrite'];

/** Every way a discovery report breaks the contract ([] when it is fine). */
export function checkDiscovered(devices) {
  if (!Array.isArray(devices)) return ['a discovery report is a list of devices'];
  const errs = [];
  const seen = new Set();
  devices.forEach((d, i) => {
    const at = `device ${i}`;
    if (!d || typeof d !== 'object') return errs.push(`${at}: not an object`);
    if (typeof d.externalRef !== 'string' || d.externalRef === '') errs.push(`${at}: externalRef is the provider's own name for the device (non-empty text)`);
    else if (seen.has(d.externalRef)) errs.push(`${at}: externalRef ${d.externalRef} appears twice`);
    else seen.add(d.externalRef);
    if (typeof d.kind !== 'string' || !/^[a-z][a-z0-9_]*$/.test(d.kind)) errs.push(`${at}: kind is a device kind (lower-case identifier)`);
    if (d.label != null && typeof d.label !== 'string') errs.push(`${at}: label is text`);
    if (d.attrs != null && (typeof d.attrs !== 'object' || Array.isArray(d.attrs))) errs.push(`${at}: attrs is an object`);
    const names = new Set();
    for (const [j, p] of (d.points ?? []).entries()) {
      const pt = `${at} point ${j}`;
      if (!p || typeof p.point !== 'string' || p.point === '') errs.push(`${pt}: point is the provider's field name`);
      else if (names.has(`${p.point}|${p.metric}`)) errs.push(`${pt}: ${p.point} for ${p.metric} appears twice`);
      else names.add(`${p.point}|${p.metric}`);
      if (!p || typeof p.metric !== 'string' || !/^[a-z][a-z0-9_]*$/.test(p.metric)) errs.push(`${pt}: metric is a metric code`);
      if (p?.part != null && !POINT_PARTS.includes(p.part)) errs.push(`${pt}: part is one of ${POINT_PARTS.join(', ')}`);
      if (p?.kind != null && !POINT_KINDS.includes(p.kind)) errs.push(`${pt}: kind is one of ${POINT_KINDS.join(', ')}`);
      if (p?.access != null && !POINT_ACCESS.includes(p.access)) errs.push(`${pt}: access is one of ${POINT_ACCESS.join(', ')}`);
      for (const k of ['scale', 'shift', 'min', 'max']) if (p?.[k] != null && !Number.isFinite(p[k])) errs.push(`${pt}: ${k} is a number`);
    }
  });
  return errs;
}

/** Every way a list of observations breaks the contract ([] when fine). At most `limit` messages. */
export function checkObservations(observations, { limit = 20 } = {}) {
  if (!Array.isArray(observations)) return ['observations is not an array'];
  const errs = [];
  const add = (i, m) => { if (errs.length < limit) errs.push(`observation ${i}: ${m}`); };
  observations.forEach((o, i) => {
    if (!o || typeof o !== 'object') return add(i, 'not an object');
    if (typeof o.externalRef !== 'string' || o.externalRef === '') add(i, 'externalRef is the provider\'s name for the device');
    if (o.kind === 'ack') return;
    if (typeof o.point !== 'string' || o.point === '') add(i, 'point is the provider\'s field name');
    const times = o.ts != null ? [o.ts] : [o.start, o.end];
    if (!times.every((t) => Number.isInteger(t))) add(i, 'give ts, or start and end: whole epoch seconds');
    else if (times.some((t) => t > 1e11)) add(i, 'times look like milliseconds; use epoch seconds');
    else if (o.ts == null && o.end <= o.start) add(i, 'end is after start');
    if (o.value != null && (typeof o.value !== 'number' || !Number.isFinite(o.value))) add(i, 'value is a finite number, or null for missing');
  });
  return errs;
}
