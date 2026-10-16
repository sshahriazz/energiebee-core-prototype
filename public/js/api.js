// Fetch helpers and number formats shared by every page.
export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const n = (v) => v != null && Number.isFinite(v);
export const fmt = {
  kwh: (v, d = 1) => (n(v) ? `${v.toFixed(Math.abs(v) < 10 && d === 1 ? 1 : d)} kWh` : '–'),
  kw: (v) => (n(v) ? `${v.toFixed(1)} kW` : '–'),
  w: (v) => (!n(v) ? '–' : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)} kW` : `${Math.round(v)} W`),
  gbp: (pence) => (!n(pence) ? '–' : `${pence < 0 ? '−' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`),
  p: (v) => (n(v) ? `${v.toFixed(1)}p` : '–'),
  pkwh: (v) => (n(v) ? `${v.toFixed(1)}p/kWh` : '–'),
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
