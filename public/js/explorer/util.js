// Data Explorer: shared state, fetch with caching, words for statuses, number and time formats,
// the address-hash state, pagers and the empty / error / loading boxes. Every text that comes from
// the API goes through esc() before it reaches innerHTML; raw payload bodies never do (see json-tree.js).
import { api, esc, slotNoun, slotNouns, currencySymbol, minorSymbol, priceUnit } from '../api.js';

// The selected home, set by the page on every render: id, tz, slot length and currency come from the API.
export const ctx = { siteId: null, site: null, tz: 'Europe/London', slotS: 1800, currency: 'GBP', overview: null, variables: null };

// ───── Fetching ─────
const cache = new Map();
/** GET an explorer endpoint, cached per address until the home changes. Throws Error(message). */
export async function get(path, { fresh = false } = {}) {
  if (!fresh && cache.has(path)) return cache.get(path);
  const p = api(path);
  cache.set(path, p);
  try { return await p; } catch (err) { cache.delete(path); throw err; }
}
export const clearCache = () => cache.clear();
export const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
export const ep = (name, params = {}) => `/api/explorer/${name}?${qs({ site: ctx.siteId, ...params })}`;

// ───── Boxes ─────
export const loading = (what = 'Loading…') => `<div class="skeleton xp-loading" role="status"><span class="spin" aria-hidden="true">↻</span> ${esc(what)}</div>`;
export const emptyBox = (title, text = '') => `<div class="xp-msg"><b>${esc(title)}</b>${text ? `<p>${text}</p>` : ''}</div>`;
export const errorBox = (what, err) => `<div class="xp-msg bad" role="alert"><b>${esc(what)}</b><p>Endpoint failed: ${esc(err?.message || String(err))}</p></div>`;

// ───── Status words (always a word, never a colour only) ─────
export const CHECK = {
  pass: ['good', '✓', 'PASS', 'the two values agree within the tolerance'],
  warn: ['warn', '!', 'WARN', 'they differ by more than usual, but not enough to call it wrong'],
  fail: ['bad', '✗', 'FAIL', 'they disagree by more than the tolerance, or a rule is broken'],
  skip: ['', '–', 'SKIP', 'the check could not run, usually because one side has no value'],
};
export const CHECK_ORDER = ['fail', 'warn', 'pass', 'skip'];
export const checkBadge = (s) => { const [cls, ic, word] = CHECK[s] || ['', '?', String(s || 'unknown').toUpperCase()]; return `<span class="badge ${cls} xp-cbadge"><span aria-hidden="true">${ic}</span> ${esc(word)}</span>`; };

export const STATE = {
  final: ['good', 'Final', 'Smart-meter readings received and every check run. It will not change unless a provider revises its data.'],
  provisional: ['warn', 'Provisional', 'Built from the inverter while the smart-meter data has not arrived yet, or the day is not over. Rebuilt when the meter data arrives.'],
  missing: ['bad', 'Missing', 'No grid reading from any source, so this slot cannot be worked out fully.'],
};
export const stateBadge = (s) => { const [cls, word] = STATE[s] || ['', String(s || 'unknown')]; return `<span class="badge ${cls}">${esc(word)}</span>`; };
export const stateColor = { final: 'var(--good)', provisional: 'var(--warn)', missing: 'var(--bad)' };
export function stateLegend() {
  return `<dl class="xp-state-legend" aria-label="What the background colours mean">${Object.entries(STATE).map(([k, [, word, text]]) => `<div><dt><i class="xp-sw xp-fg-${k}" aria-hidden="true"></i>${esc(word)}</dt><dd>${esc(text.replace('this slot', `this ${slotNoun()}`))}</dd></div>`).join('')}</dl>`;
}

// Quality bits of a slot (same table as the Data & trust page).
export const QUALITY = [[1, 'measured'], [2, 'fallback source'], [4, 'interpolated'], [8, 'estimated'], [16, 'partial coverage'], [32, 'suspect'], [64, 'check failed'], [128, 'restated']];
export const qualityWords = (q) => (q == null ? '–' : QUALITY.filter(([b]) => q & b).map(([, w]) => w).join(', ') || 'none');

// ───── Numbers ─────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A number with sensible decimals for its size. */
export function num(v, d) {
  if (!isNum(v)) return v == null ? '–' : esc(String(v));
  const a = Math.abs(v);
  // Without d: up to 3 significant decimals, no trailing zeros (95, 94.8, 0.325). With d: exactly d decimals.
  const dp = d ?? (a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3);
  return v.toLocaleString('en-GB', { minimumFractionDigits: d ?? 0, maximumFractionDigits: dp }).replace(/^-/, '−');
}
// The API's units in words a person reads: money in the home's own minor unit (p or c), °C, gCO₂.
const UNIT_WORD = { degC: '°C', gCO2: 'gCO₂', 'gCO2/kWh': 'gCO₂/kWh', m3: 'm³', 'MJ/m3': 'MJ/m³', 'W/m2': 'W/m²', count: '', factor: '', s: 's', readings: 'readings' };
/** The unit as shown: 'minor' → p or c, 'minor/kWh' → p/kWh, 'fraction' and 'ratio' → %, '0/1' → (yes/no). */
export function unitLabel(u) {
  const s = String(u ?? '');
  if (!s) return '';
  if (s === 'minor/kWh') return priceUnit();
  if (/^minor\b/.test(s)) return s.replace(/^minor/, minorSymbol());
  if (s === 'fraction' || s === 'ratio') return '%';
  if (s === '0/1' || s === 'flag') return '';
  return UNIT_WORD[s] ?? s;
}
/** A value with its unit from the API: money in the home's minor unit, fractions as percentages, flags as yes/no. */
export function val(v, unit = '', d) {
  if (v == null) return '<span class="faint">–</span>';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!isNum(v)) return esc(String(v));
  const u = String(unit ?? '');
  if (u === 'ratio' || u === 'fraction') return `${num(v * 100, d)}&nbsp;%`;
  if (u === 'flag' || u === '0/1') return v ? 'yes' : 'no';
  if (u === 'bits') return `${v} <span class="faint">(${esc(qualityWords(v))})</span>`;
  const w = unitLabel(u);
  if (!w) return num(v, d);
  return `${num(v, d)}&nbsp;${esc(w)}`;
}
/** A tolerance in words: a tiny one means the two must be equal. */
export const tolText = (t, unit) => (t == null ? '' : Math.abs(t) <= 1e-5 ? 'must be equal' : `±${val(t, unit)}`);
/** A raw payload's request (a string, or { url } / { query } / anything) as one line of text. */
export function requestText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'object') return [r.method, r.url || r.query || r.path].filter(Boolean).join(' ') || JSON.stringify(r);
  return String(r);
}
// Code names (grid_to_home_cost, solar_w at 15:55) in words, with the API's own labels when known.
const CODE_WORDS = {
  solar_w: 'solar power', load_w: 'house load', grid_import_w: 'grid import power', grid_export_w: 'grid export power', battery_charge_w: 'battery charging power',
  battery_discharge_w: 'battery discharging power', battery_soc_pct: 'battery level', ev_w: 'EV charging power', home: 'house', x_to_loss: 'losses',
};
export function nice(s) {
  const t = String(s ?? '');
  const own = (ctx.variables || []).find((v) => v.name === t)?.label;
  if (own) return own;
  const out = t.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (w) => CODE_WORDS[w] || (ctx.variables || []).find((v) => v.name === w)?.label?.toLowerCase() || w.replace(/_to_/g, ' → ').replace(/_/g, ' '));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
/** Plain-text version of val() for tooltips' copy text. */
export const valText = (v, unit = '', d) => val(v, unit, d).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export const bytes = (b) => (!isNum(b) ? '–' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`);
export const count = (n) => (isNum(n) ? n.toLocaleString('en-GB') : '–');
export const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;
export const money = () => `${currencySymbol()} / ${minorSymbol()}`;

// ───── Time (epoch seconds UTC in the API; shown in the home's time zone) ─────
const fmts = new Map();
const fmt = (opts) => { const k = `${ctx.tz}|${JSON.stringify(opts)}`; if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, ...opts })); return fmts.get(k); };
const partsF = () => fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
/** Recorded and superseded times may be ms or s: values above 1e11 are taken as ms. */
export const toSec = (t) => (t == null ? null : t > 1e11 ? t / 1000 : t);
export const T = {
  time: (t) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t * 1000),
  day: (t) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(t * 1000),
  dayYear: (t) => fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(t * 1000),
  /** HH:MM, with the zone when that wall-clock time happens twice (the hour the clocks go back). */
  clock: (t) => (repeated(t) ? `${T.time(t)} ${T.zone(t)}` : T.time(t)),
  dayTime: (t) => `${T.day(t)} ${T.clock(t)}`,
  span: (a, b) => `${T.day(a)} ${T.clock(a)}–${T.clock(b)}`,
  full: (t) => (t == null ? '–' : `${T.dayYear(t)}, ${T.time(t)}`),
  stamp: (t) => (t == null ? '–' : fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(toSec(t) * 1000)),
  date: (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(Date.parse(`${d}T12:00:00Z`)) : '–'),
  shortDate: (d) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(Date.parse(`${d}T12:00:00Z`)) : '–'),
  zone: (t) => fmt({ timeZoneName: 'short', hour: '2-digit' }).formatToParts(t * 1000).find((p) => p.type === 'timeZoneName')?.value || '',
};
const repeated = (t) => { const m = localHM(t); return localHM(t - 3600) === m || localHM(t + 3600) === m; };
function parts(t) {
  const p = Object.fromEntries(partsF().formatToParts(t * 1000).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const offCache = new Map();
/** Offset of the home's zone from UTC at t, in seconds (cached per hour). */
export function tzOffset(t) {
  const k = `${ctx.tz}|${Math.floor(t / 900)}`;
  if (offCache.has(k)) return offCache.get(k);
  const p = parts(t);
  const o = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000 - Math.floor(t);
  offCache.set(k, o);
  return o;
}
export const localDate = (t) => { const p = parts(t); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const localHM = (t) => { const p = parts(t); return p.h * 60 + p.mi; };
/** Epoch of a local wall-clock time on a date in the home's zone (the first, if it happens twice). */
export function fromLocal(date, minutes = 0) {
  const [y, m, d] = String(date).split('-').map(Number);
  const g = Date.UTC(y, m - 1, d) / 1000 + minutes * 60;   // the wall clock read as if it were UTC
  // The zone's offset before and after any change that day; a valid candidate shows the asked clock.
  const cands = [g - tzOffset(g - 43200), g - tzOffset(g + 43200)].sort((a, b) => a - b);
  const ok = cands.filter((t) => localDate(t) === date && localHM(t) === minutes % 1440);
  return ok.length ? ok[0] : cands[1];
}
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
/** The slots of a local day: [{ t, label }], DST-aware (a 25-hour day has the repeated hour twice, labelled with its zone). */
export function slotsOfDay(date) {
  const a = fromLocal(date, 0); const b = fromLocal(addDays(date, 1), 0);
  const out = [];
  const seen = new Map();
  for (let t = a; t < b; t += ctx.slotS) {
    const l = T.time(t);
    seen.set(l, (seen.get(l) || 0) + 1);
    out.push({ t, label: l });
  }
  for (const o of out) if (seen.get(o.label) > 1) o.label = `${o.label} ${T.zone(o.t)}`;
  return out;
}
export const slotLabel = (t) => `${T.dayYear(t)}, ${T.clock(t)}–${T.clock(t + ctx.slotS)}`;
/** A 'YYYY-MM-DDTHH:MM' value for <input type="datetime-local"> in the home's zone, and back. */
export const toLocalInput = (ms) => { const t = Math.floor(ms / 1000); const p = parts(t); return `${localDate(t)}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };
export const fromLocalInput = (v) => { const [d, hmv] = String(v).split('T'); if (!d || !hmv) return null; const [h, m] = hmv.split(':').map(Number); return fromLocal(d, h * 60 + m) * 1000; };

// ───── The address hash: #tab[=value]&key=value… ─────
export const TABS = ['overview', 'raw', 'facts', 'timeline', 'slot', 'correlate'];
export function readHash(h = location.hash) {
  const s = h.replace(/^#/, '');
  const [head, ...rest] = s.split('&');
  const [tab0, value = ''] = (head || '').split('=');
  const tab = TABS.includes(tab0) ? tab0 : 'overview';
  const params = new URLSearchParams(rest.join('&'));
  if (tab0 && !TABS.includes(tab0) && head.includes('=')) params.set(tab0, value);
  return { tab, value: decodeURIComponent(value || ''), params };
}
export function hashOf(tab, value = '', params = {}) {
  const rest = qs(params);
  return `#${tab}${value !== '' && value != null ? `=${encodeURIComponent(value)}` : ''}${rest ? `&${rest}` : ''}`;
}
/** Write the hash without firing the router (replace) or as a new history entry (push). */
export function writeHash(tab, value, params, { push = false } = {}) {
  const h = hashOf(tab, value, params);
  if (h === location.hash) return;
  const url = `${location.pathname}${location.search}${h}`;
  if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
  lastHash.v = h;
}
export const lastHash = { v: null };
export const slotHref = (t) => hashOf('slot', t, { site: ctx.siteId });
export const factsHref = (series, extra = {}) => hashOf('facts', '', { series, ...extra });

// ───── Links used across tabs (handled by one delegated click listener in the page) ─────
export const rawBtn = (id, text) => (id == null ? '<span class="faint">–</span>' : `<button type="button" class="xp-link" data-raw="${esc(id)}" title="Open raw payload #${esc(id)}">${esc(text || `raw #${id}`)}</button>`);
export const seriesLink = (id, text) => (id == null ? '<span class="faint">–</span>' : `<a class="xp-link" href="${esc(factsHref(id))}" title="Show series #${esc(id)} in Facts">${esc(text || `series #${id}`)}</a>`);
export const slotLink = (t, text) => (t == null ? '<span class="faint">–</span>' : `<a class="xp-link" href="${esc(slotHref(t))}" title="Open this ${esc(slotNoun())} in the Slot inspector">${esc(text || T.dayTime(t))}</a>`);

// ───── Pager ─────
export function pagerHtml(page, pages, what = 'rows') {
  if (pages <= 1) return '';
  return `<nav class="xp-pager" aria-label="Pages of ${esc(what)}">
    <button type="button" class="btn" data-pg="0" ${page <= 0 ? 'disabled' : ''} aria-label="First page">«</button>
    <button type="button" class="btn" data-pg="${page - 1}" ${page <= 0 ? 'disabled' : ''}>← Previous</button>
    <span>Page ${page + 1} of ${pages}</span>
    <button type="button" class="btn" data-pg="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Next →</button>
    <button type="button" class="btn" data-pg="${pages - 1}" ${page >= pages - 1 ? 'disabled' : ''} aria-label="Last page">»</button>
  </nav>`;
}

// ───── Plain words for a correlation ─────
export function rWords(r) {
  const a = Math.abs(r);
  return a >= 0.9 ? 'very strong' : a >= 0.7 ? 'strong' : a >= 0.5 ? 'moderate' : a >= 0.3 ? 'weak' : a >= 0.1 ? 'very weak' : 'no clear';
}
export function explainR(r, n, xl = 'X', yl = 'Y') {
  if (r == null || !Number.isFinite(r)) return `Not enough varied data to measure a relationship${n != null ? ` (${plural(n, 'point', 'points')})` : ''}.`;
  const a = Math.abs(r);
  let s = `r = ${r.toFixed(2)}: ${rWords(r)}${a >= 0.1 ? (r > 0 ? ' positive' : ' negative') : ''} relationship. `;
  s += a < 0.1 ? `${xl} and ${yl} do not move together in a straight-line way.` : r > 0 ? `When ${xl} is higher, ${yl} tends to be higher too.` : `When ${xl} is higher, ${yl} tends to be lower.`;
  if (n != null && n < 30) s += ` Only ${plural(n, 'point', 'points')}: weak evidence, do not rely on it.`;
  return s;
}

// ───── The home's overview (range, slot length, currency, sources), shared by every tab ─────
/** The overview, cached. A failure falls back to the home's days from /api/sites so the tabs still get a range. */
export async function loadOverview() {
  try {
    const o = await get(ep('overview'));
    if (o?.slot_s) ctx.slotS = o.slot_s;
    if (o?.currency) ctx.currency = o.currency;
    ctx.overview = o;
    return o;
  } catch (err) {
    ctx.overview = null;
    throw err;
  }
}
/** The variables catalogue (timeline columns and series): the API gives { variables: [...] }; an array is accepted too. */
export async function loadVariables() {
  if (ctx.variables) return ctx.variables;
  const v = await get(ep('variables'));
  ctx.variables = Array.isArray(v) ? v : Array.isArray(v?.variables) ? v.variables : [];
  return ctx.variables;
}
/** The home's first and last local dates: from the overview, else from /api/sites. */
export function dataRange() {
  const r = ctx.overview?.range;
  const first = r?.first_date || ctx.site?.days?.first || null;
  const last = r?.last_date || ctx.site?.days?.last || null;
  return { first, last };
}
/** The last n days of data (clamped to the first day). */
export function lastDays(n) {
  const { first, last } = dataRange();
  if (!last) return { from: '', to: '' };
  const from = addDays(last, -(n - 1));
  return { from: first && from < first ? first : from, to: last };
}
/** A date input's bounds from the data range. */
export const dateBounds = () => { const { first, last } = dataRange(); return `${first ? `min="${esc(first)}"` : ''} ${last ? `max="${esc(last)}"` : ''}`; };

export { esc, slotNoun, slotNouns };
