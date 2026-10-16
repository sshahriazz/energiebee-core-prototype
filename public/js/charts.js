// Hand-written SVG charts: stacked bars around a zero line, optional lines on
// the same axis, a shaded forecast region, a "now" marker and a hover tooltip.
// One y-axis per chart; anything in another unit gets its own chart.
const NS = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export function niceScale(min, max, ticks = 4) {
  if (max - min < 1e-9) max = min + 1;
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(min / step + 1e-9) * step, hi: Math.ceil(max / step - 1e-9) * step, step };
}

export function legend(items) {
  return `<div class="legend">${items.map((i) => `<span>${i.type === 'line' || i.type === 'dash'
    ? `<i class="${i.type}" style="color:${i.color}"></i>`
    : `<i class="swatch" style="background:${i.color};${i.faded ? 'opacity:.45' : ''}"></i>`}${i.label}</span>`).join('')}</div>`;
}

const observed = new WeakMap();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const o = observed.get(e.target);
    if (o && Math.abs(e.contentRect.width - o.width) > 4) draw(e.target, o.opts);
  }
});

/*
 opts: {
   rows, height, unit, yFormat,
   pos: [{ key, label, color, get }], neg: [...],   // stacked bars above / below zero
   lines: [{ label, color, get, dash, step, area, width }],
   tick(row, i) -> label | null, isForecast(row) -> bool, nowIndex,
   tip(row, i) -> html, onPick(row, i), yMin, yMax
 }
*/
export function timeChart(host, opts) {
  host.classList.add('chart');
  if (!observed.has(host)) ro.observe(host);
  draw(host, opts);
}

function draw(host, opts) {
  const width = Math.max(280, host.clientWidth || 600);
  observed.set(host, { width, opts });
  host.innerHTML = '';
  const rows = opts.rows || [];
  if (!rows.length) { host.innerHTML = '<div class="skeleton">No data for this period yet.</div>'; return; }
  const height = opts.height || 220;
  const m = { l: 46, r: 10, t: 14, b: 24 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const n = rows.length;
  const band = iw / n;
  const pos = opts.pos || []; const neg = opts.neg || []; const lines = opts.lines || [];

  let hi = 0; let lo = 0;
  rows.forEach((r) => {
    hi = Math.max(hi, pos.reduce((s, x) => s + Math.max(0, x.get(r) || 0), 0));
    lo = Math.min(lo, -neg.reduce((s, x) => s + Math.max(0, x.get(r) || 0), 0));
    for (const l of lines) { const v = l.get(r); if (v != null && Number.isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
  });
  if (opts.yMin != null) lo = Math.min(lo, opts.yMin);
  if (opts.yMax != null) hi = Math.max(hi, opts.yMax);
  const sc = niceScale(lo, hi);
  if (opts.yMaxFixed != null) sc.hi = opts.yMaxFixed;
  const y = (v) => m.t + ih - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  const x = (i) => m.l + i * band;
  const yf = opts.yFormat || ((v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(Number.isInteger(v) ? 0 : 1)));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': opts.label || 'chart' }, host);

  // Forecast region
  if (opts.isForecast) {
    const first = rows.findIndex((r) => opts.isForecast(r));
    if (first >= 0) {
      svgEl('rect', { class: 'forecast-bg', x: x(first), y: m.t, width: iw - first * band, height: ih }, svg);
      const t = svgEl('text', { x: x(first) + 6, y: m.t + 11, class: 'now-label', style: 'fill:var(--text-3);font-weight:500' }, svg);
      t.textContent = 'Forecast';
    }
  }

  // Grid and y labels
  const axis = svgEl('g', { class: 'axis' }, svg);
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
    svgEl('line', { class: Math.abs(v) < 1e-9 ? 'zero' : 'gridline', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }, axis);
    const t = svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, axis);
    t.textContent = yf(v);
  }
  if (opts.unit) {
    const t = svgEl('text', { x: 2, y: m.t - 4, 'text-anchor': 'start' }, axis);
    t.textContent = opts.unit;
  }
  // x labels
  let lastLabelX = -1e9;
  rows.forEach((r, i) => {
    const label = opts.tick ? opts.tick(r, i) : null;
    if (label == null) return;
    const cx = x(i) + (opts.tickAtStart ? 0 : band / 2);
    if (cx - lastLabelX < 34) return;
    lastLabelX = cx;
    svgEl('line', { class: 'gridline', x1: x(i), x2: x(i), y1: m.t + ih, y2: m.t + ih + 4 }, axis);
    const t = svgEl('text', { x: cx, y: height - 6, 'text-anchor': 'middle' }, axis);
    t.textContent = label;
  });

  // Bars
  const gap = band > 8 ? 2 : band > 4 ? 1 : 0;
  const bw = Math.max(1, band - gap);
  const bars = svgEl('g', {}, svg);
  rows.forEach((r, i) => {
    const fc = opts.isForecast?.(r);
    let acc = 0;
    for (const s of pos) {
      const v = Math.max(0, s.get(r) || 0);
      if (v <= 0) continue;
      svgEl('rect', { x: x(i) + gap / 2, y: y(acc + v), width: bw, height: Math.max(0.5, y(acc) - y(acc + v)), fill: s.color, 'fill-opacity': fc ? 0.42 : 1, rx: bw > 6 ? 1.5 : 0 }, bars);
      acc += v;
    }
    acc = 0;
    for (const s of neg) {
      const v = Math.max(0, s.get(r) || 0);
      if (v <= 0) continue;
      svgEl('rect', { x: x(i) + gap / 2, y: y(-acc), width: bw, height: Math.max(0.5, y(-acc - v) - y(-acc)), fill: s.color, 'fill-opacity': fc ? 0.42 : 1, rx: bw > 6 ? 1.5 : 0 }, bars);
      acc += v;
    }
  });
  if (pos.length && gap) {
    // Thin surface gap between stacked segments.
    bars.querySelectorAll('rect').forEach((rect) => { rect.setAttribute('stroke', 'var(--surface)'); rect.setAttribute('stroke-width', '0.75'); });
  }

  // Lines
  for (const l of lines) {
    let d = ''; let area = ''; let open = false; let startX = 0;
    rows.forEach((r, i) => {
      const v = l.get(r);
      if (v == null || !Number.isFinite(v)) {
        if (open && l.area) area += `L${(l.step ? x(i) : x(i - 1) + band / 2).toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}L${startX.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}Z`;
        open = false; return;
      }
      const px = l.step ? x(i) : x(i) + band / 2;
      if (!open) { d += `M${px.toFixed(1)},${y(v).toFixed(1)}`; area += `M${px.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}L${px.toFixed(1)},${y(v).toFixed(1)}`; startX = px; open = true; }
      else if (l.step) { d += `H${px.toFixed(1)}V${y(v).toFixed(1)}`; area += `H${px.toFixed(1)}V${y(v).toFixed(1)}`; }
      else { d += `L${px.toFixed(1)},${y(v).toFixed(1)}`; area += `L${px.toFixed(1)},${y(v).toFixed(1)}`; }
      if (l.step) { d += `H${(x(i) + band).toFixed(1)}`; area += `H${(x(i) + band).toFixed(1)}`; }
    });
    if (open && l.area) area += `L${(l.step ? x(n) : x(n - 1) + band / 2).toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}L${startX.toFixed(1)},${y(Math.max(sc.lo, 0)).toFixed(1)}Z`;
    if (l.area) svgEl('path', { d: area, fill: l.color, 'fill-opacity': 0.14, stroke: 'none' }, svg);
    svgEl('path', { d, fill: 'none', stroke: l.color, 'stroke-width': l.width || 2, 'stroke-dasharray': l.dash ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  // Now marker
  if (opts.nowIndex != null && opts.nowIndex >= 0 && opts.nowIndex <= n) {
    const nx = m.l + opts.nowIndex * band;
    svgEl('line', { class: 'now-line', x1: nx, x2: nx, y1: m.t - 4, y2: m.t + ih }, svg);
    const t = svgEl('text', { class: 'now-label', x: nx, y: m.t - 5, 'text-anchor': 'middle' }, svg);
    t.textContent = 'Now';
  }

  // Hover layer
  const hover = svgEl('rect', { class: 'band-hover', x: 0, y: m.t, width: band, height: ih, visibility: 'hidden' }, svg);
  const overlay = svgEl('rect', { x: m.l, y: 0, width: iw, height, fill: 'transparent', style: opts.onPick ? 'cursor:pointer' : null }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  host.appendChild(tip);
  const indexAt = (ev) => {
    const box = svg.getBoundingClientRect();
    const mx = ((ev.clientX - box.left) / box.width) * width;
    return Math.min(n - 1, Math.max(0, Math.floor((mx - m.l) / band)));
  };
  overlay.addEventListener('pointermove', (ev) => {
    const i = indexAt(ev);
    hover.setAttribute('x', x(i)); hover.setAttribute('visibility', 'visible');
    tip.innerHTML = opts.tip ? opts.tip(rows[i], i) : '';
    tip.hidden = !tip.innerHTML;
    const box = svg.getBoundingClientRect();
    const px = ((x(i) + band) / width) * box.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${px + tw + 16 > box.width ? Math.max(0, px - band * (box.width / width) - tw - 8) : px + 8}px`;
    tip.style.top = `${Math.max(0, ((ev.clientY - box.top) - tip.offsetHeight / 2))}px`;
  });
  overlay.addEventListener('pointerleave', () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  if (opts.onPick) overlay.addEventListener('click', (ev) => opts.onPick(rows[indexAt(ev)], indexAt(ev)));
}

// Tooltip body: a heading, then rows of [label, colour, value].
export function tipHtml(head, items, foot = '') {
  return `<div class="t-head">${head}</div>${items.filter(Boolean).map(([l, c, v]) => `<div class="t-row"><span>${c ? `<i class="swatch" style="background:${c}"></i>` : ''}${l}</span><b>${v}</b></div>`).join('')}${foot ? `<div class="t-foot">${foot}</div>` : ''}`;
}

// Axis ticks for half-hour rows: a label every few hours, the day name at midnight on multi-day views.
export function hhTicks(tf, multiDay) {
  return (r) => {
    const { h, m } = tf.hm(r.slot_start);
    if (m !== 0) return null;
    if (multiDay) return h === 0 ? tf.day(r.slot_start).split(' ').slice(0, 2).join(' ') : null;
    return h % 3 === 0 ? `${String(h).padStart(2, '0')}:00` : null;
  };
}

// ───────────── Sankey: who produced → who used ─────────────
/*
 opts: {
   left: [{ key, label, color }], right: [{ key, label, color }],
   links: [{ from, to, value, color, tip }], height, format(v) -> text, nodeNote(node, total) -> text
 }
 Node size is the sum of its links, so both sides always balance visually.
*/
export function sankey(host, opts) {
  host.classList.add('chart');
  const width = Math.max(300, host.clientWidth || 700);
  const narrow = width < 620;
  const height = opts.height || 300;
  const m = { l: narrow ? 96 : 150, r: narrow ? 108 : 160, t: 8, b: 8 };
  const bar = 12; const gap = 14;
  // Flows under 0.5% of the total are too thin to see and would only crowd the labels.
  const grand = opts.links.reduce((s, l) => s + Math.max(0, l.value), 0);
  const links = opts.links.filter((l) => l.value > Math.max(1e-6, grand * 0.005));
  host.innerHTML = '';
  if (!links.length) { host.innerHTML = '<div class="skeleton">No energy flows in this period.</div>'; return; }
  const sumOf = (set, side, key) => set.filter((l) => (side === 'left' ? l.from : l.to) === key).reduce((s, l) => s + Math.max(0, l.value), 0);
  // Node height follows the drawn bands; the label keeps the full total, thin flows included.
  const L = opts.left.map((n) => ({ ...n, value: sumOf(links, 'left', n.key), total: sumOf(opts.links, 'left', n.key) })).filter((n) => n.value > 1e-6);
  const R = opts.right.map((n) => ({ ...n, value: sumOf(links, 'right', n.key), total: sumOf(opts.links, 'right', n.key) })).filter((n) => n.value > 1e-6);
  const ih = height - m.t - m.b;
  // Every node keeps at least a label's height of room, so two small nodes never overprint.
  const slot = 30;
  const scaleFor = (side) => {
    const sum = side.reduce((s, n) => s + n.value, 0);
    let kk = (ih - gap * (side.length - 1)) / sum;
    const deficit = side.reduce((s, n) => s + Math.max(0, slot - n.value * kk), 0);
    return (ih - gap * (side.length - 1) - deficit) / sum;
  };
  const k = Math.min(scaleFor(L), scaleFor(R));
  const place = (side) => {
    const used = side.reduce((s, n) => s + Math.max(slot, n.value * k), 0) + gap * (side.length - 1);
    let y = m.t + (ih - used) / 2;
    for (const n of side) {
      const room = Math.max(slot, n.value * k);
      n.h = Math.max(1, n.value * k); n.y = y + (room - n.h) / 2; n.out = 0; y += room + gap;
    }
  };
  place(L); place(R);
  const x0 = m.l; const x1 = width - m.r;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': opts.label || 'Energy flows' }, host);
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.hidden = true;
  host.appendChild(tip);
  const byKey = (side, key) => side.find((n) => n.key === key);
  const order = (side) => (a, b) => side.findIndex((n) => n.key === a) - side.findIndex((n) => n.key === b);
  // Links leave each source in right-node order and enter each target in left-node order, so bands do not cross needlessly.
  const sorted = [...links].sort((a, b) => order(L)(a.from, b.from) || order(R)(a.to, b.to));
  const inY = new Map(R.map((n) => [n.key, n.y]));
  const byTarget = [...links].sort((a, b) => order(R)(a.to, b.to) || order(L)(a.from, b.from));
  const enter = new Map();
  for (const l of byTarget) { const y = inY.get(l.to); enter.set(l, y); inY.set(l.to, y + l.value * k); }
  const g = svgEl('g', {}, svg);
  for (const l of sorted) {
    const s = byKey(L, l.from); const t = byKey(R, l.to);
    if (!s || !t) continue;
    const h = Math.max(1, l.value * k);
    const ys = s.y + s.out; s.out += l.value * k;
    const yt = enter.get(l);
    const xa = x0 + bar; const xb = x1; const mx = (xa + xb) / 2;
    const d = `M${xa},${ys} C${mx},${ys} ${mx},${yt} ${xb},${yt} L${xb},${yt + h} C${mx},${yt + h} ${mx},${ys + h} ${xa},${ys + h} Z`;
    const path = svgEl('path', { d, fill: l.color, 'fill-opacity': 0.42, style: 'cursor:default;transition:fill-opacity .15s' }, g);
    path.addEventListener('pointermove', (ev) => {
      path.setAttribute('fill-opacity', 0.75);
      tip.innerHTML = l.tip || '';
      tip.hidden = !tip.innerHTML;
      const box = host.getBoundingClientRect();
      const px = ev.clientX - box.left; const py = ev.clientY - box.top;
      tip.style.left = `${Math.min(px + 12, box.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(0, py - tip.offsetHeight - 10)}px`;
    });
    path.addEventListener('pointerleave', () => { path.setAttribute('fill-opacity', 0.42); tip.hidden = true; });
  }
  const label = (n, x, anchor) => {
    svgEl('rect', { x: anchor === 'end' ? x0 : x1, y: n.y, width: bar, height: n.h, rx: 3, fill: n.color }, svg);
    const cy = n.y + n.h / 2;
    const t1 = svgEl('text', { x, y: cy - 2, 'text-anchor': anchor, style: 'fill:var(--text);font-size:12.5px;font-weight:600' }, svg);
    t1.textContent = n.label;
    const t2 = svgEl('text', { x, y: cy + 13, 'text-anchor': anchor, style: 'fill:var(--text-2);font-size:11.5px' }, svg);
    t2.textContent = opts.nodeNote ? opts.nodeNote({ ...n, value: n.total }) : (opts.format ? opts.format(n.total) : n.total.toFixed(1));
  };
  for (const n of L) label(n, x0 - 8, 'end');
  for (const n of R) label(n, x1 + bar + 8, 'start');
}

// ───────────── Waterfall: how the bill got from grid-only to actual ─────────────
/* steps: [{ label, value, kind: 'total' | 'delta', color, note }] — deltas are signed (negative lowers the bill). */
export function waterfall(host, { steps, format, height = 260 }) {
  host.classList.add('chart');
  const width = Math.max(300, host.clientWidth || 700);
  host.innerHTML = '';
  const m = { l: 50, r: 10, t: 22, b: 40 };
  const iw = width - m.l - m.r; const ih = height - m.t - m.b;
  let run = 0; let lo = 0; let hi = 0;
  const bars = steps.map((s) => {
    const a = s.kind === 'total' ? 0 : run;
    const b = s.kind === 'total' ? s.value : run + s.value;
    run = s.kind === 'total' ? s.value : b;
    lo = Math.min(lo, a, b); hi = Math.max(hi, a, b);
    return { ...s, a, b };
  });
  const sc = niceScale(lo, hi);
  const y = (v) => m.t + ih - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  const band = iw / bars.length; const bw = Math.min(64, band * 0.62);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'How the bill is made up' }, host);
  const axis = svgEl('g', { class: 'axis' }, svg);
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) {
    svgEl('line', { class: Math.abs(v) < 1e-9 ? 'zero' : 'gridline', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }, axis);
    const t = svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, axis);
    t.textContent = format(v, true);
  }
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.hidden = true;
  host.appendChild(tip);
  bars.forEach((s, i) => {
    const cx = m.l + band * i + band / 2;
    const top = Math.min(y(s.a), y(s.b)); const h = Math.max(1, Math.abs(y(s.a) - y(s.b)));
    const r = svgEl('rect', { x: cx - bw / 2, y: top, width: bw, height: h, rx: 3, fill: s.color }, svg);
    if (i < bars.length - 1) svgEl('line', { x1: cx + bw / 2, x2: cx + band - bw / 2, y1: y(s.b), y2: y(s.b), stroke: 'var(--text-3)', 'stroke-dasharray': '3 3' }, svg);
    const v = svgEl('text', { x: cx, y: top - 6, 'text-anchor': 'middle', style: 'fill:var(--text);font-size:12px;font-weight:600' }, svg);
    v.textContent = Math.abs(s.value) < 0.5 ? format(0) : s.kind === 'total' ? format(s.value) : `${s.value > 0 ? '+' : '−'}${format(Math.abs(s.value))}`;
    const words = s.label.split(' ');
    const half = Math.ceil(words.length / 2);
    [words.slice(0, half).join(' '), words.slice(half).join(' ')].forEach((line, j) => {
      if (!line) return;
      const t = svgEl('text', { x: cx, y: height - m.b + 16 + j * 13, 'text-anchor': 'middle', style: 'fill:var(--text-2);font-size:11.5px' }, svg);
      t.textContent = line;
    });
    r.addEventListener('pointermove', (ev) => {
      tip.innerHTML = `<div class="t-head">${s.label}</div>${s.note || ''}`;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      tip.style.left = `${Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - box.top - tip.offsetHeight - 10)}px`;
    });
    r.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

// Horizontal bars in HTML: label, bar, value. Used for price-per-source and price bands.
export function hbars(rows, { max, format }) {
  const top = max ?? Math.max(1e-9, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar"><div class="hbar-label">${r.swatch ? `<i class="swatch" style="background:${r.swatch}"></i>` : ''}${r.label}</div>
      <div class="hbar-track"><i style="width:${r.value == null ? 0 : Math.max(0.5, (Math.abs(r.value) / top) * 100)}%;background:${r.color}"></i></div>
      <div class="hbar-value">${r.value == null ? '–' : format(r.value)}${r.note ? `<span class="faint"> · ${r.note}</span>` : ''}</div></div>`).join('')}</div>`;
}
