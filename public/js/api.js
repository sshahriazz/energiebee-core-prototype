// Fetch helpers and number formats shared by every page.
export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const n = (v) => v != null && Number.isFinite(v);

// Money is in minor units of the home's currency (the API's `currency`); layout.js sets it when the
// home is loaded. GBP: £ and p; EUR: € and c.
const CURRENCIES = { GBP: { symbol: '£', minor: 'p' }, EUR: { symbol: '€', minor: 'c' } };
let cur = CURRENCIES.GBP;
export function setCurrency(code) { cur = CURRENCIES[code] || CURRENCIES.GBP; }
export const currencySymbol = () => cur.symbol;
export const priceUnit = () => `${cur.minor}/kWh`;   // unit prices: p/kWh or c/kWh
export const minorSymbol = () => cur.minor;
export const zeroPrice = () => `0${cur.minor}`;      // "0p" or "0c": what solar energy costs
export const minorName = () => (cur.minor === 'c' ? 'cents' : 'pence');

// The home's slot length (the API's slot_s); layout.js sets it with the currency. Words for it:
// slotNoun() "half-hour" | "quarter-hour" | "hour", slotNouns() the plural, perSlot() "per half-hour".
const NOUNS = { 900: 'quarter-hour', 1800: 'half-hour', 3600: 'hour' };
let slotLen = 1800;
export function setSlot(slotS) { slotLen = NOUNS[slotS] ? Number(slotS) : 1800; }
export const slotSeconds = () => slotLen;
export const slotNoun = (slotS = slotLen) => NOUNS[slotS] || 'slot';
export const slotNouns = (slotS = slotLen) => `${slotNoun(slotS)}s`;
export const SlotNoun = (slotS = slotLen) => slotNoun(slotS).replace(/^./, (c) => c.toUpperCase());
export const perSlot = (slotS = slotLen) => `per ${slotNoun(slotS)}`;
export const slotsPerHour = (slotS = slotLen) => 3600 / slotS;

// ───── Provenance (src/core/provenance.js): one word per origin, on a badge ─────
// sourced (named, checkable source) · provider (live from a provider) · user (typed in) ·
// derived · placeholder (not verified) · synthetic (generated demo/test data). Placeholder and
// synthetic badges are dashed and coloured differently, and always carry the word itself.
export const ORIGIN_TEXT = {
  sourced: 'taken from a named, checkable source',
  provider: 'live data from the provider for this home',
  user: 'typed in by the user or installer',
  derived: 'computed by the core from the inputs above',
  placeholder: 'a stand-in value, NOT verified against an official source',
  synthetic: 'generated demo or test data, not real',
};
export function originBadge(origin, note = '') {
  const o = ORIGIN_TEXT[origin] ? origin : 'placeholder';
  const title = `${o}: ${ORIGIN_TEXT[o]}${note ? ` (${note})` : ''}${origin ? '' : ' (no origin recorded)'}`;
  return `<span class="badge origin origin-${o}" title="${esc(title)}" aria-label="origin: ${esc(title)}">${o === 'placeholder' || o === 'synthetic' ? '⚠ ' : ''}${o}</span>`;
}
export function originLegend(origins = ['sourced', 'provider', 'user', 'placeholder', 'synthetic']) {
  return `<div class="origin-legend" aria-label="What the origin labels mean">${origins.map((o) => `<span>${originBadge(o)} ${esc(ORIGIN_TEXT[o])}</span>`).join('')}</div>`;
}

// "HH:MM" of a slot-of-day index for a home whose slots are slotS seconds long (the API's slot_s:
// 900, 1800 or 3600). Index 0 is local midnight.
export function slotClock(index, slotS = 1800) {
  const m = (index * slotS) / 60;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export const fmt = {
  kwh: (v, d = 1) => (n(v) ? `${v.toFixed(Math.abs(v) < 10 && d === 1 ? 1 : d)} kWh` : '–'),
  kw: (v) => (n(v) ? `${v.toFixed(1)} kW` : '–'),
  w: (v) => (!n(v) ? '–' : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kW` : `${Math.round(v)} W`),
  gbp: (minor) => (!n(minor) ? '–' : `${minor < 0 ? '−' : ''}${cur.symbol}${(Math.abs(minor) / 100).toFixed(2)}`),
  p: (v) => (n(v) ? `${v.toFixed(1)}${cur.minor}` : '–'),
  pkwh: (v) => (n(v) ? `${v.toFixed(1)}${cur.minor}/kWh` : '–'),
  pct: (v, d = 0) => (n(v) ? `${(v * 100).toFixed(d)}%` : '–'),
  num: (v, d = 1) => (n(v) ? v.toFixed(d) : '–'),
  kg: (g) => (n(g) ? `${(g / 1000).toFixed(1)} kg` : '–'),
};

export function timeFmt(tz) {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  return {
    time: (ts) => time.format(ts * 1000),
    day: (ts) => day.format(ts * 1000),
    dayTime: (ts) => `${day.format(ts * 1000)} ${time.format(ts * 1000)}`,
    date: (d) => day.format(Date.parse(`${d}T12:00:00Z`)),
    hm: (ts) => { const p = Object.fromEntries(parts.formatToParts(ts * 1000).map((x) => [x.type, x.value])); return { h: +p.hour, m: +p.minute }; },
  };
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Change against the previous period of the same length. lowerIsBetter flips the colour.
export function delta(cur, prev, { lowerIsBetter = false, format = (v) => v.toFixed(1), vs = 'previous period' } = {}) {
  if (!n(cur) || !n(prev) || Math.abs(prev) < 1e-6) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1e-6) return `<span class="faint">same as ${vs}</span>`;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `<span class="${better ? 'delta-good' : 'delta-bad'}">${d > 0 ? '▲' : '▼'} ${format(Math.abs(d))}</span> <span class="faint">vs ${vs}</span>`;
}

export const COLORS = { solar: 'var(--solar)', battery: 'var(--battery)', grid: 'var(--grid)', export: 'var(--export)', ev: 'var(--ev)' };
