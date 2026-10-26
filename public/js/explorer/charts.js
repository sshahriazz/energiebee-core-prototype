// Data Explorer charts: hand-written SVG, no library. Each chart redraws itself when its box changes
// width; colours are CSS variables, so a theme change needs no redraw. One y-axis per chart (two
// measures of different units get two charts). Every chart has a hover/focus cursor with a tooltip,
// keyboard steps (← → Home End, Enter to open, Esc to hide) and an aria-label.
//   lineChart     multi-series lines over time, gaps as breaks, hollow markers, state bands, shared cursor
//   stackedBars   stacked bars over time (above and below zero), state bands, shared cursor
//   scatter       X against Y with the regression line
//   heatmap       a variable by time of day (columns) and date (rows), with a scale legend
//   histogram     how values are spread
//   flows         where each kWh came from and went (sources → uses)
//   coverageStripHtml, groupBarsHtml, legendHtml: plain HTML pieces
import { svgEl, niceScale } from '../charts.js';
import { esc, T, localHM, localDate, fromLocal, addDays, ctx, num } from './util.js';

// ───── Redraw on resize ─────
const watched = new WeakMap();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const w = watched.get(e.target);
    if (w && Math.abs(e.contentRect.width - w.width) > 4) { w.width = e.contentRect.width; w.draw(); }
  }
});
function mount(host, draw) {
  host.classList.add('chart', 'xp-chart');
  const prev = watched.get(host);
  watched.set(host, { width: host.clientWidth, draw });
  if (!prev) ro.observe(host);
  draw();
}
/** Redraw every chart under root (after the tab becomes visible: hidden charts measured 0 wide). */
export function redrawAll(root = document) { root.querySelectorAll('.xp-chart').forEach((h) => { const w = watched.get(h); if (w) { w.width = h.clientWidth; w.draw(); } }); }

// ───── Shared cursor between charts of one group ─────
const groups = new Map();
function join(group, member) {
  if (!group) return;
  let set = groups.get(group);
  if (!set) groups.set(group, (set = new Set()));
  for (const m of set) if (!m.host.isConnected || m.host === member.host) set.delete(m);
  set.add(member);
}
function broadcast(group, host, t) {
  for (const m of groups.get(group) || []) if (m.host !== host && m.host.isConnected) { if (t == null) m.hide(); else m.show(t); }
}

// ───── Small pieces ─────
const width = (host) => Math.max(260, Math.floor(host.clientWidth || host.parentElement?.clientWidth || 600));
function tooltip(host) {
  const tip = document.createElement('div');
  tip.className = 'tooltip xp-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  host.appendChild(tip);
  return tip;
}
function placeTip(host, tip, px, py) {
  const w = host.clientWidth;
  const tw = tip.offsetWidth; const th = tip.offsetHeight;
  const left = px + 14 + tw > w ? Math.max(0, px - tw - 14) : px + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, py - th / 2)}px`;
}
const text = (parent, attrs, s) => { const t = svgEl('text', attrs, parent); t.textContent = s; return t; };
/** Tooltip body: a heading, then [label, colour, value-html] rows. Callers pass escaped HTML. */
export function tipHtml(head, rows, foot = '') {
  return `<div class="t-head">${head}</div>${rows.filter(Boolean).map(([l, c, v, extra]) => `<div class="t-row"><span>${c ? `<i class="swatch" style="background:${c}${extra === 'hollow' ? ';background:transparent;box-shadow:inset 0 0 0 1.5px ' + c : ''}"></i>` : ''}${l}</span><b>${v}</b></div>`).join('')}${foot ? `<div class="t-foot">${foot}</div>` : ''}`;
}
/** Legend: [{ label, color, type: 'box' | 'line' | 'dash' | 'dot' | 'hollow' }]. Labels are escaped here. */
export function legendHtml(items) {
  const mark = (i) => {
    if (i.type === 'line' || i.type === 'dash') return `<i class="${i.type}" style="color:${i.color}" aria-hidden="true"></i>`;
    if (i.type === 'dot') return `<i class="xp-dot" style="background:${i.color}" aria-hidden="true"></i>`;
    if (i.type === 'hollow') return `<i class="xp-dot hollow" style="color:${i.color}" aria-hidden="true"></i>`;
    return `<i class="swatch" style="background:${i.color}" aria-hidden="true"></i>`;
  };
  return `<div class="legend xp-legend">${items.map((i) => `<span>${mark(i)}${esc(i.label)}</span>`).join('')}</div>`;
}

// ───── Time ticks in the home's zone ─────
const STEPS = [900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800];
function timeTicks(t0, t1, max) {
  const span = Math.max(1, t1 - t0);
  const step = STEPS.find((s) => s >= ctx.slotS / 2 && span / s <= max) || 604800 * Math.ceil(span / 604800 / Math.max(1, max));
  const out = [];
  const short = (t) => T.day(t).split(' ').slice(0, 2).join(' ');
  if (step >= 86400) {
    let d = localDate(t0); let t = fromLocal(d, 0);
    if (t < t0) { d = addDays(d, 1); t = fromLocal(d, 0); }
    const every = Math.round(step / 86400); let k = 0;
    while (t <= t1 && k < 4000) { if (k % every === 0) out.push({ t, label: T.day(t), major: true }); d = addDays(d, 1); t = fromLocal(d, 0); k++; }
  } else {
    const stepMin = step / 60;
    for (let t = Math.ceil(t0 / 900) * 900; t <= t1; t += 900) {
      const m = localHM(t);
      if (m % stepMin === 0) out.push({ t, label: m === 0 ? short(t) : T.time(t), major: m === 0 });
    }
  }
  return out;
}

// ───── Time charts: lines and stacked bars on one frame ─────
/*
 lineChart(host, {
   series: [{ key, label, color, dash, area, markers, points: [{ t, v, hollow }] }],
   height, unit, yFormat(v), gap (s: a longer jump between points breaks the line), zero (include 0, default true),
   bands: [{ from, to, state }], domain: [t0, t1], sync: 'group', label, tip(t) -> html, onPick(t)
 })
 stackedBars(host, { rows: [{ t, dur }], series: [{ key, label, color, get(row) }], …same options })
*/
export function lineChart(host, o) { mount(host, () => drawTime(host, { ...o, kind: 'line' })); }
export function stackedBars(host, o) { mount(host, () => drawTime(host, { ...o, kind: 'bars' })); }

function drawTime(host, o) {
  const W = width(host);
  const H = o.height || 220;
  const m = { l: 52, r: 12, t: 20, b: 26 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  host.innerHTML = '';
  const series = o.series || [];
  const bars = o.kind === 'bars';
  const rows = bars ? (o.rows || []) : [];
  const allPts = bars ? [] : series.flatMap((s) => s.points || []);
  if ((bars && !rows.length) || (!bars && !allPts.length)) { host.innerHTML = `<div class="skeleton">${esc(o.empty || 'Nothing to draw for this range.')}</div>`; return; }

  // Domain
  let t0; let t1;
  if (o.domain) [t0, t1] = o.domain;
  else if (bars) { t0 = rows[0].t; t1 = rows[rows.length - 1].t + (rows[rows.length - 1].dur || ctx.slotS); }
  else { t0 = Math.min(...allPts.map((p) => p.t)); t1 = Math.max(...allPts.map((p) => p.t)); }
  if (t1 <= t0) t1 = t0 + ctx.slotS;
  let lo = Infinity; let hi = -Infinity;
  if (bars) {
    for (const r of rows) {
      let p = 0; let n = 0;
      for (const s of series) { const v = s.get(r); if (v == null || !Number.isFinite(v)) continue; if (v >= 0) p += v; else n += v; }
      hi = Math.max(hi, p); lo = Math.min(lo, n);
    }
  } else for (const p of allPts) if (p.v != null && Number.isFinite(p.v)) { hi = Math.max(hi, p.v); lo = Math.min(lo, p.v); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (o.zero !== false || bars) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const sc = niceScale(lo, hi, o.ticks || 4);
  const y = (v) => m.t + ih - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const yf = o.yFormat || ((v) => num(v, Math.abs(sc.step) < 0.01 ? 3 : Math.abs(sc.step) < 0.1 ? 2 : Math.abs(sc.step) < 1 ? 1 : 0));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || 'Chart over time', tabindex: 0, class: 'xp-svg' }, host);
  const clipId = `xpc${Math.random().toString(36).slice(2, 8)}`;
  svgEl('rect', { x: m.l, y: m.t - 8, width: iw, height: ih + 8 }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, svg)));

  // State bands: a faint wash behind the plot and a stronger strip on top, merged into runs.
  if (o.bands?.length) {
    const g = svgEl('g', { 'clip-path': `url(#${clipId})`, 'aria-hidden': 'true' }, svg);
    const runs = [];
    for (const b of o.bands) {
      const last = runs[runs.length - 1];
      if (last && last.state === b.state && Math.abs(last.to - b.from) < 1) last.to = b.to; else runs.push({ ...b });
    }
    for (const r of runs) {
      const xa = x(r.from); const xb = x(r.to);
      svgEl('rect', { x: xa, y: m.t, width: Math.max(0.5, xb - xa), height: ih, class: `xp-band xp-bg-${r.state}` }, g);
      svgEl('rect', { x: xa, y: m.t - 7, width: Math.max(0.5, xb - xa), height: 4, class: `xp-strip xp-fg-${r.state}` }, g);
    }
  }

  // Grid, y labels, unit
  const axis = svgEl('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
  for (let v = sc.lo; v <= sc.hi + sc.step * 1e-6; v += sc.step) {
    svgEl('line', { class: Math.abs(v) < sc.step * 1e-6 ? 'zero' : 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, axis);
    text(axis, { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, yf(Math.abs(v) < sc.step * 1e-6 ? 0 : v));
  }
  if (o.unit) text(axis, { x: 0, y: 10, 'text-anchor': 'start', class: 'xp-unit' }, o.unit);
  let lastX = -1e9;
  for (const tk of timeTicks(t0, t1, Math.max(2, Math.floor(iw / 74)))) {
    const cx = x(tk.t);
    if (cx < m.l - 1 || cx > W - m.r + 1 || cx - lastX < 50) continue;
    lastX = cx;
    svgEl('line', { class: 'gridline', x1: cx, x2: cx, y1: m.t + ih, y2: m.t + ih + 4 }, axis);
    if (tk.major) svgEl('line', { class: 'gridline xp-dayline', x1: cx, x2: cx, y1: m.t, y2: m.t + ih }, axis);
    text(axis, { x: Math.min(Math.max(cx, m.l + 16), W - m.r - 16), y: H - 7, 'text-anchor': 'middle' }, tk.label);
  }

  const marks = svgEl('g', { 'clip-path': `url(#${clipId})` }, svg);
  let keys;
  if (bars) {
    keys = rows.map((r) => r.t);
    for (const r of rows) {
      const xa = x(r.t); const xb = x(r.t + (r.dur || ctx.slotS));
      const gap = xb - xa > 5 ? 1 : 0;
      const bw = Math.max(0.6, xb - xa - gap);
      let up = 0; let down = 0;
      for (const s of series) {
        const v = s.get(r);
        if (v == null || !Number.isFinite(v) || v === 0) continue;
        if (v > 0) { svgEl('rect', { x: xa + gap / 2, y: y(up + v), width: bw, height: Math.max(0.5, y(up) - y(up + v)), fill: s.color, class: 'xp-seg' }, marks); up += v; }
        else { svgEl('rect', { x: xa + gap / 2, y: y(down), width: bw, height: Math.max(0.5, y(down + v) - y(down)), fill: s.color, class: 'xp-seg' }, marks); down += v; }
      }
    }
  } else {
    const set = new Set();
    for (const s of series) {
      const pts = (s.points || []).filter((p) => !p.hollow).sort((a, b) => a.t - b.t);
      let d = ''; let area = ''; let open = false; let prev = null; let startX = 0; let lastPx = 0;
      const close = () => { if (open && s.area) area += `L${lastPx.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}L${startX.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}Z`; open = false; };
      for (const p of pts) {
        set.add(p.t);
        if (p.v == null || !Number.isFinite(p.v)) { close(); prev = p; continue; }
        const px = x(p.t); const py = y(p.v);
        if (open && o.gap && prev && p.t - prev.t > o.gap) close();
        if (!open) { d += `M${px.toFixed(1)},${py.toFixed(1)}`; area += `M${px.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}`; startX = px; open = true; }
        else { d += `L${px.toFixed(1)},${py.toFixed(1)}`; area += `L${px.toFixed(1)},${py.toFixed(1)}`; }
        lastPx = px; prev = p;
      }
      close();
      if (s.area) svgEl('path', { d: area, fill: s.color, 'fill-opacity': 0.12, stroke: 'none' }, marks);
      svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, marks);
      // Markers: when asked, or when points are sparse enough to see; hollow ones always.
      const dense = pts.length > iw / 7;
      for (const p of s.points || []) {
        if (p.v == null || !Number.isFinite(p.v)) continue;
        if (p.hollow) { set.add(p.t); svgEl('circle', { cx: x(p.t), cy: y(p.v), r: 3.6, fill: 'var(--surface)', stroke: s.color, 'stroke-width': 1.6, class: 'xp-hollow' }, marks); }
        else if (s.markers || !dense) svgEl('circle', { cx: x(p.t), cy: y(p.v), r: dense ? 2 : 3, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 1 }, marks);
      }
    }
    keys = [...set].sort((a, b) => a - b);
  }

  // Cursor, tooltip, keyboard and the shared cursor
  const cursor = svgEl('line', { class: 'xp-cursor', y1: m.t - 8, y2: m.t + ih, visibility: 'hidden' }, svg);
  const hoverBand = bars ? svgEl('rect', { class: 'band-hover', y: m.t, height: ih, visibility: 'hidden' }, svg) : null;
  const tip = tooltip(host);
  const overlay = svgEl('rect', { x: m.l, y: 0, width: iw, height: H, fill: 'transparent', style: o.onPick ? 'cursor:pointer' : null }, svg);
  let idx = -1;
  const scale = () => (svg.getBoundingClientRect().width || W) / W;
  const nearest = (t) => {
    let a = 0; let b = keys.length - 1;
    while (b - a > 1) { const mid = (a + b) >> 1; if (keys[mid] < t) a = mid; else b = mid; }
    return Math.abs(keys[a] - t) <= Math.abs(keys[b] - t) ? a : b;
  };
  const defaultTip = (t) => tipHtml(esc(T.dayTime(t)), series.map((s) => {
    if (bars) { const r = rows[keys.indexOf(t)]; const v = r ? s.get(r) : null; return v == null ? null : [esc(s.label), s.color, `${num(v)}${o.unit ? ` ${esc(o.unit)}` : ''}`]; }
    const p = (s.points || []).find((q) => q.t === t && !q.hollow);
    return p ? [esc(s.label), s.color, `${num(p.v)}${o.unit ? ` ${esc(o.unit)}` : ''}`] : null;
  }));
  const show = (i, { py, local = true } = {}) => {
    if (i < 0 || i >= keys.length) return;
    idx = i;
    const t = keys[i];
    const r = bars ? rows[i] : null;
    const cx = bars ? x(t + (r.dur || ctx.slotS) / 2) : x(t);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    if (hoverBand) { hoverBand.setAttribute('x', x(t)); hoverBand.setAttribute('width', Math.max(1, x(t + (r.dur || ctx.slotS)) - x(t))); hoverBand.setAttribute('visibility', 'visible'); }
    tip.innerHTML = (o.tip ? o.tip(t, r) : defaultTip(t)) || '';
    tip.hidden = !tip.innerHTML;
    placeTip(host, tip, cx * scale(), py ?? (m.t + ih / 3) * scale());
    if (local && o.sync) broadcast(o.sync, host, t);
  };
  const hide = (local = true) => {
    cursor.setAttribute('visibility', 'hidden'); hoverBand?.setAttribute('visibility', 'hidden'); tip.hidden = true;
    if (local && o.sync) broadcast(o.sync, host, null);
  };
  const tAt = (ev) => { const b = svg.getBoundingClientRect(); const mx = ((ev.clientX - b.left) / b.width) * W; return t0 + ((mx - m.l) / iw) * (t1 - t0); };
  // A bar is hit anywhere inside its own time span: the last bar starting at or before t.
  const barAt = (t) => { let a = 0; let b = rows.length - 1; if (t < rows[0].t) return 0; while (a < b) { const mid = (a + b + 1) >> 1; if (rows[mid].t <= t) a = mid; else b = mid - 1; } return a; };
  const indexAt = (ev) => (bars ? barAt(tAt(ev)) : nearest(tAt(ev)));
  overlay.addEventListener('pointermove', (ev) => show(indexAt(ev), { py: ev.clientY - svg.getBoundingClientRect().top }));
  overlay.addEventListener('pointerleave', () => hide());
  if (o.onPick) overlay.addEventListener('click', (ev) => { const i = indexAt(ev); if (keys[i] != null) o.onPick(keys[i], bars ? rows[i] : null); });
  svg.addEventListener('focus', () => show(idx >= 0 ? idx : keys.length - 1));
  svg.addEventListener('blur', () => hide());
  svg.addEventListener('keydown', (ev) => {
    const k = ev.key;
    let i = idx < 0 ? keys.length - 1 : idx;
    if (k === 'ArrowLeft') i -= 1; else if (k === 'ArrowRight') i += 1; else if (k === 'Home') i = 0; else if (k === 'End') i = keys.length - 1;
    else if (k === 'PageUp') i -= 10; else if (k === 'PageDown') i += 10;
    else if (k === 'Enter' && o.onPick && idx >= 0) { ev.preventDefault(); o.onPick(keys[idx], bars ? rows[idx] : null); return; } else if (k === 'Escape') { hide(); return; } else return;
    ev.preventDefault();
    show(Math.max(0, Math.min(keys.length - 1, i)));
  });
  join(o.sync, { host, show: (t) => { if (t < t0 || t > t1) { hide(false); return; } show(nearest(t), { local: false }); }, hide: () => hide(false) });
}

// ───── Scatter with regression line ─────
/* scatter(host, { points: [{ x, y, t }], xLabel, yLabel, xUnit, yUnit, slope, intercept, height, tip(p) -> html, label }) */
export function scatter(host, o) { mount(host, () => drawScatter(host, o)); }
function drawScatter(host, o) {
  const W = width(host); const H = o.height || 300;
  const m = { l: 56, r: 14, t: 18, b: 42 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  host.innerHTML = '';
  const pts = (o.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) { host.innerHTML = '<div class="skeleton">No pairs of values to plot.</div>'; return; }
  const xs = niceScale(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)), 5);
  const ys = niceScale(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)), 4);
  const X = (v) => m.l + ((v - xs.lo) / (xs.hi - xs.lo)) * iw;
  const Y = (v) => m.t + ih - ((v - ys.lo) / (ys.hi - ys.lo)) * ih;
  const f = (s) => (v) => num(v, Math.abs(s.step) < 0.01 ? 3 : Math.abs(s.step) < 0.1 ? 2 : Math.abs(s.step) < 1 ? 1 : 0);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || 'Scatter chart', tabindex: 0, class: 'xp-svg' }, host);
  const clipId = `xps${Math.random().toString(36).slice(2, 8)}`;
  svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih }, svgEl('clipPath', { id: clipId }, svgEl('defs', {}, svg)));
  const axis = svgEl('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
  for (let v = ys.lo; v <= ys.hi + ys.step * 1e-6; v += ys.step) {
    svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, axis);
    text(axis, { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, f(ys)(Math.abs(v) < ys.step * 1e-6 ? 0 : v));
  }
  let lastX = -1e9;
  for (let v = xs.lo; v <= xs.hi + xs.step * 1e-6; v += xs.step) {
    const cx = X(v);
    svgEl('line', { class: 'gridline', x1: cx, x2: cx, y1: m.t, y2: m.t + ih }, axis);
    if (cx - lastX < 40) continue;
    lastX = cx;
    text(axis, { x: cx, y: m.t + ih + 16, 'text-anchor': 'middle' }, f(xs)(Math.abs(v) < xs.step * 1e-6 ? 0 : v));
  }
  text(axis, { x: m.l + iw / 2, y: H - 4, 'text-anchor': 'middle', class: 'xp-axis-title' }, `${o.xLabel || 'X'}${o.xUnit ? ` (${o.xUnit})` : ''}  →`);
  text(axis, { x: 0, y: 10, 'text-anchor': 'start', class: 'xp-axis-title' }, `↑ ${o.yLabel || 'Y'}${o.yUnit ? ` (${o.yUnit})` : ''}`);
  const g = svgEl('g', { 'clip-path': `url(#${clipId})` }, svg);
  const r = pts.length > 800 ? 2 : pts.length > 200 ? 2.6 : 3.4;
  for (const p of pts) svgEl('circle', { cx: X(p.x), cy: Y(p.y), r, fill: 'var(--grid)', 'fill-opacity': pts.length > 400 ? 0.4 : 0.6 }, g);
  if (Number.isFinite(o.slope) && Number.isFinite(o.intercept)) {
    svgEl('line', { x1: X(xs.lo), x2: X(xs.hi), y1: Y(o.intercept + o.slope * xs.lo), y2: Y(o.intercept + o.slope * xs.hi), class: 'xp-fit' }, g);
  }
  const ring = svgEl('circle', { r: 6, class: 'xp-ring', visibility: 'hidden' }, svg);
  const tip = tooltip(host);
  const order = pts.map((p, i) => i).sort((a, b) => pts[a].x - pts[b].x);
  let cur = -1;
  const scale = () => (svg.getBoundingClientRect().width || W) / W;
  const show = (i) => {
    cur = i; const p = pts[i];
    ring.setAttribute('cx', X(p.x)); ring.setAttribute('cy', Y(p.y)); ring.setAttribute('visibility', 'visible');
    tip.innerHTML = o.tip ? o.tip(p) : tipHtml('Point', [['X', '', num(p.x)], ['Y', '', num(p.y)]]);
    tip.hidden = false;
    placeTip(host, tip, X(p.x) * scale(), Y(p.y) * scale());
  };
  const hide = () => { ring.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', (ev) => {
    const b = svg.getBoundingClientRect(); const s = b.width / W;
    const mx = (ev.clientX - b.left) / s; const my = (ev.clientY - b.top) / s;
    let best = -1; let bd = 18 * 18;
    pts.forEach((p, i) => { const d = (X(p.x) - mx) ** 2 + (Y(p.y) - my) ** 2; if (d < bd) { bd = d; best = i; } });
    if (best >= 0) show(best); else hide();
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(order[cur >= 0 ? order.indexOf(cur) : 0]));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (ev) => {
    let k = cur >= 0 ? order.indexOf(cur) : 0;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') k++; else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') k--;
    else if (ev.key === 'Home') k = 0; else if (ev.key === 'End') k = order.length - 1; else if (ev.key === 'Escape') { hide(); return; } else return;
    ev.preventDefault();
    show(order[Math.max(0, Math.min(order.length - 1, k))]);
  });
}

// ───── Heatmap: date rows × time-of-day columns ─────
/* heatmap(host, { rows: [{ date, cells: [number|null] }], labels: ['00:00', …], min, max, unit, label, onPick(date, i) }) */
export const heatColor = (v, min, max) => {
  if (v == null || !Number.isFinite(v)) return 'var(--surface-2)';
  const k = max > min ? (v - min) / (max - min) : 0.5;
  return `color-mix(in srgb, var(--price-hi) ${Math.round(6 + Math.max(0, Math.min(1, k)) * 94)}%, var(--price-lo))`;
};
export function heatmap(host, o) { mount(host, () => drawHeat(host, o)); }
function drawHeat(host, o) {
  const W = width(host);
  host.innerHTML = '';
  const rows = o.rows || [];
  if (!rows.length) { host.innerHTML = '<div class="skeleton">No values in this range.</div>'; return; }
  const narrow = W < 520;
  const cols = Math.max(1, ...rows.map((r) => r.cells.length));
  const m = { l: narrow ? 50 : 82, r: 6, t: 4, b: 22 };
  const iw = W - m.l - m.r;
  const ch = rows.length > 40 ? 10 : rows.length > 20 ? 13 : 18;
  const H = m.t + rows.length * ch + m.b;
  const cw = iw / cols;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || 'Heatmap', tabindex: 0, class: 'xp-svg' }, host);
  const axis = svgEl('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
  const lblEvery = Math.max(1, Math.ceil(rows.length / Math.floor((rows.length * ch) / 13)));
  rows.forEach((r, i) => { if (i % lblEvery === 0) text(axis, { x: m.l - 6, y: m.t + i * ch + ch / 2 + 4, 'text-anchor': 'end' }, narrow ? T.shortDate(r.date) : T.date(r.date).replace(/ \d{4}$/, '')); });
  const labels = o.labels || [];
  const every = Math.max(1, Math.ceil(56 / cw));
  const nice = [1, 2, 3, 4, 6, 8, 12, 16, 24, 48, 96].find((n) => n >= every && cols % n === 0) || every;
  for (let c = 0; c < cols; c += nice) {
    const cx = m.l + c * cw;
    if (cx + 18 > W) break;
    svgEl('line', { class: 'gridline', x1: cx, x2: cx, y1: H - m.b, y2: H - m.b + 4 }, axis);
    text(axis, { x: Math.max(cx, m.l + 16), y: H - 6, 'text-anchor': 'middle' }, labels[c] ?? String(c));
  }
  const g = svgEl('g', {}, svg);
  const gap = cw > 5 ? 1 : 0;
  rows.forEach((r, i) => r.cells.forEach((v, c) => {
    svgEl('rect', { x: m.l + c * cw + gap / 2, y: m.t + i * ch + 0.5, width: Math.max(0.5, cw - gap), height: ch - 1, style: `fill:${heatColor(v, o.min, o.max)}` }, g);
  }));
  const ring = svgEl('rect', { class: 'xp-cellring', width: cw, height: ch, visibility: 'hidden' }, svg);
  const tip = tooltip(host);
  let cur = null;
  const scale = () => (svg.getBoundingClientRect().width || W) / W;
  const show = (i, c) => {
    cur = [i, c]; const r = rows[i]; const v = r.cells[c];
    ring.setAttribute('x', m.l + c * cw); ring.setAttribute('y', m.t + i * ch); ring.setAttribute('visibility', 'visible');
    tip.innerHTML = tipHtml(`${esc(T.date(r.date))}, ${esc(labels[c] ?? '')}`, [[esc(o.name || 'Value'), '', v == null ? 'no data' : `${num(v)}${o.unit ? ` ${esc(o.unit)}` : ''}`]], o.onPick ? 'Click or press Enter to open this slot' : '');
    tip.hidden = false;
    placeTip(host, tip, (m.l + c * cw + cw) * scale(), (m.t + i * ch) * scale());
  };
  const hide = () => { ring.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  const at = (ev) => { const b = svg.getBoundingClientRect(); const s = b.width / W; const c = Math.floor(((ev.clientX - b.left) / s - m.l) / cw); const i = Math.floor(((ev.clientY - b.top) / s - m.t) / ch); return i >= 0 && i < rows.length && c >= 0 && c < cols ? [i, c] : null; };
  svg.addEventListener('pointermove', (ev) => { const p = at(ev); if (p) show(...p); else hide(); });
  svg.addEventListener('pointerleave', hide);
  if (o.onPick) { svg.style.cursor = 'pointer'; svg.addEventListener('click', (ev) => { const p = at(ev); if (p) o.onPick(rows[p[0]].date, p[1]); }); }
  svg.addEventListener('focus', () => show(...(cur || [rows.length - 1, Math.floor(cols / 2)])));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (ev) => {
    let [i, c] = cur || [0, 0];
    if (ev.key === 'ArrowLeft') c--; else if (ev.key === 'ArrowRight') c++; else if (ev.key === 'ArrowUp') i--; else if (ev.key === 'ArrowDown') i++;
    else if (ev.key === 'Enter' && o.onPick && cur) { ev.preventDefault(); o.onPick(rows[cur[0]].date, cur[1]); return; } else if (ev.key === 'Escape') { hide(); return; } else return;
    ev.preventDefault();
    show(Math.max(0, Math.min(rows.length - 1, i)), Math.max(0, Math.min(cols - 1, c)));
  });
}
export function heatLegendHtml(min, max, unit, name = '') {
  return `<div class="xp-heat-legend" aria-label="Colour scale">
    <span>${esc(name)} low</span><b>${num(min)}${unit ? ` ${esc(unit)}` : ''}</b><i class="xp-ramp" aria-hidden="true"></i><b>${num(max)}${unit ? ` ${esc(unit)}` : ''}</b><span>high</span>
    <span class="xp-heat-none"><i class="swatch" style="background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border)" aria-hidden="true"></i> no data</span></div>`;
}

// ───── Histogram ─────
/* histogram(host, { values: [number], unit, color, label, bins }) */
export function histogram(host, o) { mount(host, () => drawHist(host, o)); }
function drawHist(host, o) {
  const W = width(host); const H = o.height || 170;
  const m = { l: 44, r: 10, t: 16, b: 26 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  host.innerHTML = '';
  const vals = (o.values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) { host.innerHTML = '<div class="skeleton">Too few values for a distribution.</div>'; return; }
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  if (hi === lo) { lo -= 0.5; hi += 0.5; }
  const n = o.bins || Math.max(5, Math.min(36, Math.ceil(Math.sqrt(vals.length))));
  const bw = (hi - lo) / n;
  const bins = new Array(n).fill(0);
  for (const v of vals) bins[Math.min(n - 1, Math.floor((v - lo) / bw))]++;
  const ys = niceScale(0, Math.max(...bins), 3);
  const X = (v) => m.l + ((v - lo) / (hi - lo)) * iw;
  const Y = (c) => m.t + ih - (c / ys.hi) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || 'Distribution of values', tabindex: 0, class: 'xp-svg' }, host);
  const axis = svgEl('g', { class: 'axis', 'aria-hidden': 'true' }, svg);
  for (let v = 0; v <= ys.hi + 1e-9; v += ys.step) { svgEl('line', { class: v ? 'gridline' : 'zero', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, axis); text(axis, { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, num(v, 0)); }
  text(axis, { x: 0, y: 10, class: 'xp-unit' }, 'count');
  const xs = niceScale(lo, hi, Math.max(2, Math.floor(iw / 80)));
  for (let v = xs.lo; v <= xs.hi + 1e-9; v += xs.step) { if (v < lo - 1e-9 || v > hi + 1e-9) continue; text(axis, { x: X(v), y: H - 7, 'text-anchor': 'middle' }, `${num(v)}`); }
  if (o.unit) text(axis, { x: W - m.r, y: H - 7 - 12, 'text-anchor': 'end', class: 'xp-unit' }, o.unit);
  const g = svgEl('g', {}, svg);
  const rects = bins.map((c, i) => svgEl('rect', { x: X(lo + i * bw) + 1, y: Y(c), width: Math.max(0.5, X(lo + (i + 1) * bw) - X(lo + i * bw) - 2), height: Math.max(c ? 1 : 0, Y(0) - Y(c)), fill: o.color || 'var(--grid)', rx: 2 }, g));
  const tip = tooltip(host);
  let cur = -1;
  const scale = () => (svg.getBoundingClientRect().width || W) / W;
  const show = (i) => {
    cur = i; rects.forEach((r, k) => r.setAttribute('fill-opacity', k === i ? 1 : 0.7));
    tip.innerHTML = tipHtml(`${num(lo + i * bw)} to ${num(lo + (i + 1) * bw)}${o.unit ? ` ${esc(o.unit)}` : ''}`, [['Values', '', `${bins[i]} of ${vals.length}`]]);
    tip.hidden = false;
    placeTip(host, tip, X(lo + (i + 0.5) * bw) * scale(), Y(bins[i]) * scale());
  };
  const hide = () => { rects.forEach((r) => r.setAttribute('fill-opacity', 1)); tip.hidden = true; };
  svg.addEventListener('pointermove', (ev) => { const b = svg.getBoundingClientRect(); const mx = ((ev.clientX - b.left) / b.width) * W; const i = Math.floor(((mx - m.l) / iw) * n); if (i >= 0 && i < n) show(i); else hide(); });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(cur >= 0 ? cur : 0));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); show(Math.max(0, Math.min(n - 1, (cur < 0 ? 0 : cur) + (ev.key === 'ArrowRight' ? 1 : -1)))); } else if (ev.key === 'Escape') hide();
  });
}

// ───── Flows: where each kWh came from (left) and went (right) ─────
const NODE = {
  solar: ['Solar', 'var(--solar)'], grid: ['Grid', 'var(--grid)'], battery: ['Battery', 'var(--battery)'], home: ['House', 'var(--text-2)'],
  house: ['House', 'var(--text-2)'], loss: ['Losses', 'var(--text-3)'], ev: ['EV', 'var(--ev)'], gas: ['Gas', 'var(--gas)'], export: ['Grid', 'var(--export)'],
};
export const nodeLabel = (k) => NODE[k]?.[0] || String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const nodeColor = (k, side = 'L') => (side === 'R' && k === 'grid' ? 'var(--export)' : NODE[k]?.[1] || 'var(--text-3)');
const LEFT_ORDER = ['solar', 'battery', 'grid', 'gas'];
const RIGHT_ORDER = ['home', 'house', 'ev', 'battery', 'grid', 'loss'];
/* flows(host, { flows: [{ from, to, kwh }], unit, label }) */
export function flows(host, o) { mount(host, () => drawFlows(host, o)); }
function drawFlows(host, o) {
  const W = width(host);
  host.innerHTML = '';
  const list = (o.flows || []).filter((f) => Number.isFinite(f.kwh) && f.kwh > 0);
  if (!list.length) { host.innerHTML = '<div class="skeleton">No energy moved in this slot.</div>'; return; }
  const ord = (arr, k) => { const i = arr.indexOf(k); return i < 0 ? 99 : i; };
  const L = [...new Set(list.map((f) => f.from))].sort((a, b) => ord(LEFT_ORDER, a) - ord(LEFT_ORDER, b));
  const R = [...new Set(list.map((f) => f.to))].sort((a, b) => ord(RIGHT_ORDER, a) - ord(RIGHT_ORDER, b));
  const narrow = W < 520;
  const m = { l: narrow ? 92 : 140, r: narrow ? 92 : 140, t: 10, b: 22 };   // room under the last node for its two label lines
  const gap = 18; const bar = 10;
  const sum = (side, k) => list.filter((f) => (side === 'L' ? f.from : f.to) === k).reduce((s, f) => s + f.kwh, 0);
  const total = list.reduce((s, f) => s + f.kwh, 0);
  const minH = 26;
  const H = Math.max(150, Math.min(320, 40 + Math.max(L.length, R.length) * 52));
  const ih = H - m.t - m.b;
  const k = (ih - gap * (Math.max(L.length, R.length) - 1) - minH) / total;
  const place = (keys, side) => {
    const nodes = keys.map((key) => ({ key, v: sum(side, key) }));
    const used = nodes.reduce((s, n) => s + Math.max(minH, n.v * k), 0) + gap * (nodes.length - 1);
    let yy = m.t + Math.max(0, (ih - used) / 2);
    for (const n of nodes) { const room = Math.max(minH, n.v * k); n.h = Math.max(2, n.v * k); n.y = yy + (room - n.h) / 2; n.used = 0; yy += room + gap; }
    return nodes;
  };
  const LN = place(L, 'L'); const RN = place(R, 'R');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || 'Energy flows', class: 'xp-svg' }, host);
  const tip = tooltip(host);
  const x0 = m.l + bar; const x1 = W - m.r;
  const enter = new Map(RN.map((n) => [n.key, n.y]));
  const sorted = [...list].sort((a, b) => ord(L, a.from) - ord(L, b.from) || ord(R, a.to) - ord(R, b.to));
  const g = svgEl('g', {}, svg);
  for (const f of sorted) {
    const s = LN.find((n) => n.key === f.from); const t = RN.find((n) => n.key === f.to);
    const h = Math.max(1.5, f.kwh * k);
    const ys = s.y + s.used; s.used += f.kwh * k;
    const yt = enter.get(f.to); enter.set(f.to, yt + f.kwh * k);
    const mx = (x0 + x1) / 2;
    const d = `M${x0},${ys} C${mx},${ys} ${mx},${yt} ${x1},${yt} L${x1},${yt + h} C${mx},${yt + h} ${mx},${ys + h} ${x0},${ys + h} Z`;
    const p = svgEl('path', { d, fill: nodeColor(f.from), 'fill-opacity': 0.4, class: 'xp-ribbon' }, g);
    p.addEventListener('pointermove', (ev) => {
      p.setAttribute('fill-opacity', 0.7);
      tip.innerHTML = tipHtml(`${esc(nodeLabel(f.from))} → ${esc(nodeLabel(f.to))}`, [['Energy', '', `${num(f.kwh, 3)} ${esc(o.unit || 'kWh')}`]]);
      tip.hidden = false;
      const b = host.getBoundingClientRect();
      placeTip(host, tip, ev.clientX - b.left, ev.clientY - b.top);
    });
    p.addEventListener('pointerleave', () => { p.setAttribute('fill-opacity', 0.4); tip.hidden = true; });
  }
  const node = (n, side) => {
    svgEl('rect', { x: side === 'L' ? m.l : x1, y: n.y, width: bar, height: n.h, rx: 3, fill: nodeColor(n.key, side) }, svg);
    const tx = side === 'L' ? m.l - 8 : x1 + bar + 8; const anchor = side === 'L' ? 'end' : 'start';
    const cy = n.y + n.h / 2;
    const suffix = narrow ? '' : side === 'R' ? { battery: ' (charging)', grid: ' (export)' }[n.key] || '' : { battery: ' (discharging)', grid: ' (import)' }[n.key] || '';
    text(svg, { x: tx, y: cy - 2, 'text-anchor': anchor, class: 'xp-node' }, `${nodeLabel(n.key)}${suffix}`);
    text(svg, { x: tx, y: cy + 13, 'text-anchor': anchor, class: 'xp-node-v' }, `${num(n.v, 3)} ${o.unit || 'kWh'}`);
  };
  LN.forEach((n) => node(n, 'L')); RN.forEach((n) => node(n, 'R'));
}
/** The same flows as a list in words, under the diagram. */
export function flowsListHtml(list, unit = 'kWh') {
  const f = (list || []).filter((x) => Number.isFinite(x.kwh) && x.kwh > 0);
  if (!f.length) return '';
  const to = (k) => (k === 'grid' ? 'Grid (export)' : k === 'battery' ? 'Battery (charging)' : nodeLabel(k));
  return `<ul class="xp-flowlist">${f.map((x) => `<li><i class="swatch" style="background:${nodeColor(x.from)}" aria-hidden="true"></i>${esc(nodeLabel(x.from))} → ${esc(to(x.to))}: <b>${num(x.kwh, 3)} ${esc(unit)}</b></li>`).join('')}</ul>`;
}

// ───── Coverage strip: one column per day, final / provisional / missing stacked ─────
/* days: [{ local_date, slots, final, provisional, missing }]; href(date) -> link for the day (optional) */
export function coverageStripHtml(days, { href } = {}) {
  if (!days?.length) return '<div class="skeleton">No days to show.</div>';
  const many = days.length > 62;
  const cell = (d) => {
    const n = d.slots || (d.final + d.provisional + d.missing) || 1;
    const pct = (v) => `${((v || 0) / n) * 100}%`;
    const words = `${T.date(d.local_date)}: ${d.final || 0} final, ${d.provisional || 0} provisional, ${d.missing || 0} missing of ${n}`;
    const inner = `<i class="xp-fg-final" style="height:${pct(d.final)}"></i><i class="xp-fg-provisional" style="height:${pct(d.provisional)}"></i><i class="xp-fg-missing" style="height:${pct(d.missing)}"></i>`;
    return href && !many ? `<a class="xp-cov-day" href="${esc(href(d.local_date))}" title="${esc(words)}" aria-label="${esc(words)}">${inner}</a>`
      : `<span class="xp-cov-day" title="${esc(words)}">${inner}</span>`;
  };
  return `<div class="xp-cov" ${many ? `role="img" aria-label="${esc(`${days.length} days from ${days[0].local_date} to ${days[days.length - 1].local_date}; see the table for the numbers`)}"` : 'role="list"'}>${days.map((d) => (many ? cell(d) : `<span role="listitem">${cell(d)}</span>`)).join('')}</div>
    <div class="xp-cov-ends"><span>${esc(T.date(days[0].local_date))}</span><span>${esc(T.date(days[days.length - 1].local_date))}</span></div>`;
}

// ───── Correlation per group: diverging bars from −1 to +1 ─────
export function groupBarsHtml(groups) {
  if (!groups?.length) return '';
  return `<div class="xp-gbars">${groups.map((g) => {
    const r = g.pearson;
    const ok = Number.isFinite(r);
    const w = ok ? Math.abs(r) * 50 : 0;
    const few = (g.n ?? 0) < 30;
    return `<div class="xp-gbar${few ? ' few' : ''}"><span class="xp-gkey">${esc(g.key)}</span>
      <span class="xp-gtrack" aria-hidden="true"><i style="${ok && r < 0 ? `right:50%;width:${w}%;background:var(--export)` : `left:50%;width:${w}%;background:var(--grid)`}"></i></span>
      <span class="xp-gval">${ok ? `r = ${r.toFixed(2)}` : 'r = –'} <span class="faint">n = ${esc(g.n ?? '–')}${few ? ', few points' : ''}</span></span></div>`;
  }).join('')}</div>`;
}
