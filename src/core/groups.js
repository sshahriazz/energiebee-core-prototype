// Groups of homes viewed together (delta 070). Everything here reads site_hh SLOT ROWS: never site_day, which
// fills a missing slot with zero and stores ratios. How each column combines is DATA (column_class), not code
// per column: a column without a class is refused (test/groups-classes.test.js).
//
// Rules, from docs/slot-engine-stress-test.md section 1:
//  - Money is summed only within one currency; a group of GBP and EUR homes has two totals, never one number.
//  - A group day is cut in the GROUP's one time zone. A home's slot belongs to the bucket its slot_start falls in;
//    a slot is never split (a 30-minute slot is not cut in two for a finer bucket - such a bucket is refused).
//    Day totals therefore differ from a home's own local days when the zones differ (measured, docs/groups-and-access.md).
//  - A value is null (not zero) when any home's slot behind it is missing or has no figure; the `partial` figure
//    is what is known. A group slot is final only if every member slot is final.
//  - Ratios (self-sufficiency ...) are recomputed from the summed figures, never averaged; prices are weighted by
//    the energy they apply to; charge level is summed in kWh with each battery's size as known at the slot.
//  - Membership is dated (valid time) and recorded (transaction time): a home that leaves on day X counts before X
//    and not after, and the membership as it was known at an earlier moment can be asked for again. The slot rows
//    are the current ones (a rebuilt day shows its rebuilt figures; its history is in site_day_revision).
//  - With a viewer, only homes the viewer may read are included, for the periods the viewer's grants cover. A home
//    the viewer has no grant on is left out as if it were not a member: no count, no gap marker.
import { db } from '../db/db.js';
import { dayBounds, addDays } from './time.js';
import { attributeAt } from './attributes.js';
import { viewWindows } from './access.js';

// ───────────── Column classes (data) ─────────────

export function loadClasses() {
  return new Map(db.prepare("SELECT column_name, class, weight_by FROM column_class WHERE table_name = 'site_hh'").all().map((r) => [r.column_name, { cls: r.class, weightBy: r.weight_by }]));
}
const colsOf = (classes, ...names) => [...classes].filter(([, v]) => names.includes(v.cls)).map(([k]) => k);

// ───────────── Groups, membership, sharing ─────────────

export function createGroup({ name, ownerId, timezone, now = Date.now() }) {
  if (!String(name ?? '').trim()) throw new Error('a group needs a name');
  if (!timezone) throw new Error('a group needs a time zone: its days are cut in it');
  new Intl.DateTimeFormat('en', { timeZone: timezone });   // throws on an unknown zone
  return Number(db.prepare('INSERT INTO site_group (name, owner_id, timezone, created_at) VALUES (?, ?, ?, ?)').run(name, ownerId, timezone, now).lastInsertRowid);
}
export const getGroup = (groupId) => db.prepare('SELECT * FROM site_group WHERE id = ?').get(groupId);

// A home counts in the group from `from` to `to` (seconds; null = open).
export function addMember(groupId, siteId, { from = null, to = null, now = Date.now() } = {}) {
  return Number(db.prepare('INSERT INTO site_group_member (group_id, site_id, valid_from, valid_to, recorded_at) VALUES (?, ?, ?, ?, ?)').run(groupId, siteId, from, to, now).lastInsertRowid);
}

// The home stops counting at `at` (seconds). Earlier periods stay: the open row is superseded and written again
// with its end, so the membership as recorded before this call can still be asked for.
export function endMembership(groupId, siteId, at, { now = Date.now() } = {}) {
  const open = db.prepare('SELECT * FROM site_group_member WHERE group_id = ? AND site_id = ? AND superseded_at IS NULL AND (valid_to IS NULL OR valid_to > ?)').all(groupId, siteId, at);
  for (const o of open) {
    db.prepare('UPDATE site_group_member SET superseded_at = ? WHERE id = ?').run(now, o.id);
    if (o.valid_from == null || o.valid_from < at) {
      db.prepare('INSERT INTO site_group_member (group_id, site_id, valid_from, valid_to, recorded_at) VALUES (?, ?, ?, ?, ?)').run(groupId, siteId, o.valid_from, at, now);
    }
  }
  return open.length;
}

// Membership rows as known at knownAt (ms; null = now).
export function membersOf(groupId, { knownAt = null } = {}) {
  const at = knownAt ?? Number.MAX_SAFE_INTEGER;
  return db.prepare('SELECT * FROM site_group_member WHERE group_id = ? AND recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?) ORDER BY site_id, valid_from IS NOT NULL, valid_from').all(groupId, at, at);
}

export function shareGroup({ groupId, userId, role = 'viewer', now = Date.now() }) {
  return Number(db.prepare('INSERT INTO group_grant (group_id, user_id, role, recorded_at) VALUES (?, ?, ?, ?)').run(groupId, userId, role, now).lastInsertRowid);
}
export function revokeGroupShare({ groupId, userId, now = Date.now() }) {
  return Number(db.prepare('UPDATE group_grant SET revoked_at = ? WHERE group_id = ? AND user_id = ? AND revoked_at IS NULL').run(now, groupId, userId).changes);
}
export function canViewGroup(userId, groupId, now = Date.now()) {
  const g = getGroup(groupId);
  if (!g) return false;
  if (g.owner_id === userId) return true;
  return Boolean(db.prepare('SELECT 1 FROM group_grant WHERE group_id = ? AND user_id = ? AND recorded_at <= ? AND (revoked_at IS NULL OR revoked_at > ?)').get(groupId, userId, now, now));
}

// ───────────── Windows ─────────────

const NEG = -Infinity; const POS = Infinity;
function mergeWindows(ws) {
  const s = ws.filter((w) => w.to > w.from).sort((a, b) => a.from - b.from);
  const out = [];
  for (const w of s) { const last = out[out.length - 1]; if (last && w.from <= last.to) last.to = Math.max(last.to, w.to); else out.push({ ...w }); }
  return out;
}
const overlapS = (windows, lo, hi) => windows.reduce((t, w) => t + Math.max(0, Math.min(w.to, hi) - Math.max(w.from, lo)), 0);
const inWindows = (windows, t) => windows.some((w) => t >= w.from && t < w.to);

// ───────────── Slot buckets ─────────────

const sumOf = (xs) => xs.reduce((t, v) => t + v, 0);
const worst = (states) => (states.includes('incomplete') ? 'incomplete' : states.includes('provisional') ? 'provisional' : 'final');

/**
 * The group's slots re-bucketed to one grid.
 * @param opts { viewer (user id), knownAt (ms: membership as recorded then), bucketS (default: the longest
 *   member slot; a bucket shorter than a member's slot is refused), now (ms, for grants) }
 * @returns { group, bucketS, from, to, currencies, sites (the homes that counted), buckets: [...] }
 */
export function groupSlots(groupId, fromTs, toTs, opts = {}) {
  const group = getGroup(groupId);
  if (!group) throw new RangeError(`no group ${groupId}`);
  const now = opts.now ?? Date.now();
  const viewer = opts.viewer ?? null;
  if (viewer != null && !canViewGroup(viewer, groupId, now)) throw new Error('no access to this group');
  const classes = loadClasses();
  const energyCols = colsOf(classes, 'energy', 'flow', 'carbon', 'forecast');
  const moneyCols = colsOf(classes, 'money');
  const priceCols = colsOf(classes, 'price');
  const intensityCols = colsOf(classes, 'intensity');

  // Each member home's windows: its membership intersected with what the viewer may read.
  const byHome = new Map();
  for (const m of membersOf(groupId, { knownAt: opts.knownAt ?? null })) {
    const mw = { from: Math.max(fromTs, m.valid_from ?? NEG), to: Math.min(toTs, m.valid_to ?? POS) };
    const parts = viewer == null ? [mw] : viewWindows(viewer, m.site_id, now).map((w) => ({ from: Math.max(mw.from, w.from ?? NEG), to: Math.min(mw.to, w.to ?? POS) }));
    byHome.set(m.site_id, [...(byHome.get(m.site_id) ?? []), ...parts]);
  }
  const homes = [];
  for (const [siteId, ws] of byHome) {
    const windows = mergeWindows(ws);
    if (windows.length) homes.push({ siteId, windows, site: db.prepare('SELECT id, currency, slot_s, battery_kwh FROM site WHERE id = ?').get(siteId) });
  }

  // The rows, once.
  const rowsOf = new Map();
  for (const h of homes) {
    const lo = Math.min(...h.windows.map((w) => w.from)); const hi = Math.max(...h.windows.map((w) => w.to));
    rowsOf.set(h.siteId, db.prepare('SELECT * FROM site_hh WHERE site_id = ? AND slot_start >= ? AND slot_start < ? ORDER BY slot_start').all(h.siteId, lo, hi).filter((r) => inWindows(h.windows, r.slot_start)));
  }
  const longest = Math.max(0, ...[...rowsOf.values()].flat().map((r) => r.dur_s), ...homes.map((h) => h.site?.slot_s ?? 0));
  const bucketS = opts.bucketS ?? (longest || 3600);
  if (!Number.isInteger(bucketS) || bucketS <= 0 || bucketS % 900) throw new RangeError('bucketS is a multiple of 900 seconds');
  const tooLong = [...rowsOf.entries()].find(([, rs]) => rs.some((r) => r.dur_s > bucketS));
  if (tooLong) throw new RangeError(`bucket ${bucketS} s is shorter than the ${Math.max(...tooLong[1].map((r) => r.dur_s))} s slots of home ${tooLong[0]}: a slot is never split, ask for a longer bucket`);

  const capAt = (h, slotStart) => attributeAt(h.siteId, 'battery_kwh', slotStart * 1000)?.value ?? h.site?.battery_kwh ?? null;
  const buckets = []; const currencies = new Set();
  for (let b = Math.floor(fromTs / bucketS) * bucketS; b < toTs; b += bucketS) {
    const bEnd = b + bucketS;
    const lo = Math.max(b, fromTs); const hi = Math.min(bEnd, toTs);
    const per = [];   // one entry per home active in the bucket
    for (const h of homes) {
      const expected = overlapS(h.windows, lo, hi);
      if (!expected) continue;
      const rs = rowsOf.get(h.siteId).filter((r) => r.slot_start >= b && r.slot_start < bEnd);
      const usable = rs.filter((r) => r.state !== 'missing');   // a missing slot carries zeros that are not measurements
      const finalS = sumOf(usable.filter((r) => r.state === 'final').map((r) => r.dur_s));
      const provS = sumOf(usable.filter((r) => r.state === 'provisional').map((r) => r.dur_s));
      per.push({ h, rs, usable, expected, finalS, provS, missingS: Math.max(0, expected - finalS - provS) });
    }
    if (!per.length) { buckets.push({ start: b, end: bEnd, bucketS, members: 0, state: 'incomplete', expected_s: 0, final_s: 0, provisional_s: 0, missing_s: 0, coverage: null, values: {}, partial: {}, money: {}, prices: {}, intensity: {}, soc: null, perSite: {}, ratios: {}, quality_or: 0, methods: [], mixedMethod: false, builtAt: null }); continue; }

    const expected = sumOf(per.map((p) => p.expected)); const finalS = sumOf(per.map((p) => p.finalS)); const provS = sumOf(per.map((p) => p.provS)); const missingS = sumOf(per.map((p) => p.missingS));
    const state = missingS > 0 ? 'incomplete' : provS > 0 ? 'provisional' : 'final';

    // Additive columns: the sum when every home has every figure behind it, else null; `partial` is what is known.
    const total = (cols, members, rowFilter = () => true) => {
      const values = {}; const partial = {};
      for (const c of cols) {
        let strict = true; let sum = 0;
        for (const p of members) {
          if (p.missingS > 0) strict = false;
          for (const r of p.usable.filter(rowFilter)) { if (r[c] == null) strict = false; else sum += r[c]; }
        }
        values[c] = strict ? sum : null; partial[c] = sum;
      }
      return { values, partial };
    };
    const { values, partial } = total(energyCols, per);

    // Money: one set of totals per currency, from the rows in that currency.
    const money = {}; const prices = {};
    const homeCur = (p) => new Set([...p.usable.map((r) => r.currency ?? p.h.site?.currency), ...(p.rs.length ? [] : [p.h.site?.currency])].filter(Boolean));
    for (const c of new Set(per.flatMap((p) => [...homeCur(p)]))) {
      currencies.add(c);
      const members = per.filter((p) => homeCur(p).has(c));
      const rowCur = (r) => (r.currency ?? members.find((p) => p.usable.includes(r))?.h.site?.currency) === c;
      money[c] = total(moneyCols, members, rowCur);
      prices[c] = {};
      for (const pc of priceCols) {
        const w = classes.get(pc).weightBy; let num = 0; let den = 0;
        for (const p of members) for (const r of p.usable.filter(rowCur)) if (r[pc] != null && r[w] != null && r[w] > 0) { num += r[pc] * r[w]; den += r[w]; }
        prices[c][pc] = den > 0 ? num / den : null;
      }
    }
    const intensity = {};
    for (const ic of intensityCols) {
      const w = classes.get(ic).weightBy; let num = 0; let den = 0;
      for (const p of per) for (const r of p.usable) if (r[ic] != null && r[w] != null && r[w] > 0) { num += r[ic] * r[w]; den += r[w]; }
      intensity[ic] = den > 0 ? num / den : null;
    }

    // Charge level: kWh with each battery's size as known at the slot, summed at the last slot of the bucket.
    let soc = null;
    {
      let kwh = 0; let cap = 0; let ok = true;
      for (const p of per) {
        const last = [...p.usable].reverse().find((r) => r.soc_end != null);
        const size = last ? capAt(p.h, last.slot_start) : null;
        if (!last || !size || p.missingS > 0) { ok = false; break; }
        kwh += (last.soc_end / 100) * size; cap += size;
      }
      soc = ok && cap > 0 ? { kwh, capacityKwh: cap, pct: (kwh / cap) * 100 } : null;
    }

    // Per home only: temperature (time-weighted) and the meter-vs-clamp diagnostic.
    const perSite = {};
    for (const p of per) {
      const t = p.usable.filter((r) => r.outdoor_temp != null);
      const tw = sumOf(t.map((r) => r.dur_s));
      const d = [...p.usable].reverse().find((r) => r.meter_vs_ct != null);
      perSite[p.h.siteId] = { outdoor_temp: tw > 0 ? sumOf(t.map((r) => r.outdoor_temp * r.dur_s)) / tw : null, meter_vs_ct: d?.meter_vs_ct ?? null };
    }

    const v = values;
    const ratios = {
      self_consumption: v.solar > 0.01 && v.solar_to_home != null && v.solar_to_battery != null ? (v.solar_to_home + v.solar_to_battery) / v.solar : null,
      self_sufficiency: v.home > 0.01 && v.grid_to_home != null ? 1 - v.grid_to_home / v.home : null,
    };
    const all = per.flatMap((p) => p.usable);
    const methods = [...new Set(all.map((r) => r.method_version))];
    buckets.push({ start: b, end: bEnd, bucketS, members: per.length, state, expected_s: expected, final_s: finalS, provisional_s: provS, missing_s: missingS,
      coverage: expected ? (finalS + provS) / expected : null, values, partial, money, prices, intensity, soc, perSite, ratios,
      quality_or: all.reduce((q, r) => q | r.quality, 0), methods, mixedMethod: methods.length > 1, builtAt: all.length ? Math.max(...all.map((r) => r.built_at)) : null });
  }
  return { group: { id: group.id, name: group.name, timezone: group.timezone }, bucketS, from: fromTs, to: toTs, currencies: [...currencies].sort(), sites: homes.map((h) => h.siteId), buckets };
}

// ───────────── Days and ranges (cut in the group's zone) ─────────────

// Combine a list of buckets: a sum is null as soon as one bucket's is, `partial` always has what is known.
function summarise(buckets, bucketS, classes) {
  const energyCols = colsOf(classes, 'energy', 'flow', 'carbon', 'forecast');
  const moneyCols = colsOf(classes, 'money');
  const live = buckets.filter((x) => x.members > 0);
  const e = { values: {}, partial: {} };
  for (const c of energyCols) { e.values[c] = live.length && live.every((x) => x.values[c] != null) ? sumOf(live.map((x) => x.values[c])) : null; e.partial[c] = sumOf(live.map((x) => x.partial[c] ?? 0)); }
  const money = {};
  for (const cur of new Set(live.flatMap((x) => Object.keys(x.money)))) {
    const parts = live.filter((x) => x.money[cur]);
    money[cur] = { values: {}, partial: {} };
    for (const c of moneyCols) { money[cur].values[c] = parts.length === live.length && parts.every((x) => x.money[cur].values[c] != null) ? sumOf(parts.map((x) => x.money[cur].values[c])) : null; money[cur].partial[c] = sumOf(parts.map((x) => x.money[cur].partial[c] ?? 0)); }
  }
  const v = e.values;
  const socs = live.map((x) => x.soc?.pct).filter((x) => x != null);
  return {
    state: live.length ? worst(live.map((x) => x.state)) : 'incomplete',
    expected_s: sumOf(live.map((x) => x.expected_s)), final_s: sumOf(live.map((x) => x.final_s)), provisional_s: sumOf(live.map((x) => x.provisional_s)), missing_s: sumOf(live.map((x) => x.missing_s)),
    values: e.values, partial: e.partial, money,
    // The peak of the group's summed import at the bucket resolution, not the sum of the homes' own peaks.
    peak_import_kw: live.length ? Math.max(...live.map((x) => (x.partial.grid_import ?? 0) / (bucketS / 3600))) : null,
    ratios: {
      self_consumption: v.solar > 0.01 && v.solar_to_home != null && v.solar_to_battery != null ? (v.solar_to_home + v.solar_to_battery) / v.solar : null,
      self_sufficiency: v.home > 0.01 && v.grid_to_home != null ? 1 - v.grid_to_home / v.home : null,
    },
    soc_min: socs.length ? Math.min(...socs) : null, soc_max: socs.length ? Math.max(...socs) : null,
    mixedMethod: live.some((x) => x.mixedMethod),
  };
}

export function groupDay(groupId, date, opts = {}) {
  const g = getGroup(groupId);
  if (!g) throw new RangeError(`no group ${groupId}`);
  const [from, to] = dayBounds(g.timezone, date);
  const res = groupSlots(groupId, from, to, opts);
  return { date, ...res, day: summarise(res.buckets, res.bucketS, loadClasses()) };
}

export function groupRange(groupId, fromDate, toDate, opts = {}) {
  const g = getGroup(groupId);
  if (!g) throw new RangeError(`no group ${groupId}`);
  const days = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) days.push(groupDay(groupId, d, opts));
  const classes = loadClasses();
  const bucketS = Math.max(...days.map((x) => x.bucketS), 0) || 3600;
  const live = days.filter((x) => x.buckets.some((b) => b.members > 0));
  const total = summarise(live.flatMap((x) => x.buckets), bucketS, classes);
  return { group: { id: g.id, name: g.name, timezone: g.timezone }, from: fromDate, to: toDate, days, total, currencies: [...new Set(days.flatMap((x) => x.currencies))].sort() };
}
