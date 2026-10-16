// Timeline: everything in one chart. One shared time axis, one row per part of
// the system (each with its source), forecast after now, events along the bottom.
// Hover anywhere for every value at that half-hour; click for its evidence.
import { api, fmt, timeFmt, esc, ago, COLORS } from '../api.js';
import { init, evidenceLink } from '../layout.js';
import { svgEl, niceScale, tipHtml } from '../charts.js';

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const GAS = 'var(--gas)';
const faded = (c, p = 45) => `color-mix(in srgb, ${c} ${p}%, var(--surface))`;

function lanesFor(d) {
  const all = [...d.rows, ...d.forecast];
  const ev = d.devices.find((x) => x.kind === 'ev');
  const has = (k) => all.some((r) => (r[k] || 0) > 0.001);
  const conn = d.connections;
  const fresh = (...ps) => { const c = ps.map((p) => conn[p]).find(Boolean); return c ? { at: c.last_success_at, status: c.status, error: c.last_error } : null; };
  const meterSource = conn.demo ? 'Demo meter (Octopus-shaped)' : 'Octopus smart meter; inverter clamp until it arrives';
  return [
    { key: 'solar', label: 'Solar', part: `Panels ${d.site.pv_kwp ? `${d.site.pv_kwp} kWp ` : ''}→ inverter`, source: 'Sunsynk 5-min · forecast', h: 58, unit: 'kWh', color: COLORS.solar, fresh: fresh('sunsynk', 'demo'),
      pos: [{ get: (r) => r.solar, color: COLORS.solar }], line: { get: (r) => (r.state === 'forecast' ? null : r.solar_forecast), color: 'var(--text-2)', dash: true } },
    { key: 'battery', label: 'Battery', part: `Battery ${d.site.battery_kwh ? `${d.site.battery_kwh} kWh` : ''}`, source: conn.demo ? 'Demo inverter' : 'Sunsynk 5-min', h: 58, unit: 'kWh', color: COLORS.battery, fresh: fresh('sunsynk', 'demo'),
      pos: [{ get: (r) => r.battery_discharge, color: COLORS.battery }], neg: [{ get: (r) => r.battery_charge, color: faded(COLORS.battery, 55) }] },
    { key: 'soc', label: 'Charge level', part: 'Battery state of charge', source: conn.demo ? 'Demo inverter' : 'Sunsynk 5-min', h: 40, unit: '%', color: COLORS.battery, fresh: fresh('sunsynk', 'demo'),
      line: { get: (r) => r.soc_end, color: COLORS.battery, area: true }, fixed: [0, 100] },
    { key: 'grid', label: 'Grid', part: `Grid connection${d.site.region ? ` · region ${d.site.region}` : ''}`, source: meterSource, h: 58, unit: 'kWh', color: COLORS.grid, fresh: fresh('octopus', 'demo', 'sunsynk'),
      pos: [{ get: (r) => r.grid_import, color: COLORS.grid }], neg: [{ get: (r) => r.grid_export, color: COLORS.export }] },
    { key: 'home', label: 'House', part: 'Everything the house used', source: 'Core: energy balance', h: 58, unit: 'kWh', color: 'var(--text-2)',
      pos: [{ get: (r) => r.solar_to_home, color: COLORS.solar }, { get: (r) => r.battery_to_home, color: COLORS.battery }, { get: (r) => r.grid_to_home, color: COLORS.grid }] },
    (ev || has('ev')) && { key: 'ev', label: 'EV', part: ev ? `${ev.label}${ev.state === 'SMART_CONTROL_NOT_AVAILABLE' ? ' · smart control off' : ''}` : 'Car charging', source: 'Octopus Kraken dispatches', h: 40, unit: 'kWh', color: COLORS.ev, fresh: fresh('octopus', 'demo'),
      pos: [{ get: (r) => r.ev, color: COLORS.ev }], bands: 'dispatch' },
    has('gas') && { key: 'gas', label: 'Gas', part: 'Gas meter', source: 'Octopus smart meter', h: 40, unit: 'kWh', color: GAS, fresh: fresh('octopus'),
      pos: [{ get: (r) => r.gas, color: GAS }] },
    { key: 'price', label: 'Price', part: 'Import and export price', source: conn.demo ? 'Octopus Agile rates (public)' : 'Octopus tariff rates', h: 50, unit: 'p/kWh', color: COLORS.grid, fresh: fresh('octopus', 'tariff', 'demo'),
      lines: [{ get: (r) => r.import_rate, color: COLORS.grid, step: true }, { get: (r) => r.export_rate, color: COLORS.export, step: true }] },
    { key: 'cost', label: 'Cost', part: 'Bill per half-hour (dashed: grid only)', source: 'Core: priced build', h: 50, unit: '£', color: 'var(--text-2)', money: true,
      pos: [{ get: (r) => Math.max(0, r.total_cost ?? 0), color: 'var(--text-2)' }], neg: [{ get: (r) => Math.max(0, -(r.total_cost ?? 0)), color: COLORS.export }],
      line: { get: (r) => r.grid_only_cost, color: 'var(--text-3)', dash: true } },
    { key: 'carbon', label: 'Grid carbon', part: 'Regional intensity', source: 'NESO', h: 18, kind: 'heat', color: 'var(--text)', fresh: fresh('carbon'), get: (r) => r.carbon_intensity },
    { key: 'weather', label: 'Outside', part: 'Temperature', source: 'Open-Meteo', h: 36, unit: '°C', color: 'var(--text-2)', fresh: fresh('weather'),
      line: { get: (r) => r.outdoor_temp, color: 'var(--text-2)' } },
    { key: 'quality', label: 'Data state', part: 'Final · provisional · missing', source: 'Core: checks', h: 14, kind: 'states', color: 'var(--good)' },
    { key: 'events', label: 'Events', part: 'Syncs, data, tariffs, alerts', source: 'All sources', h: 50, kind: 'events', color: 'var(--accent)' },
  ].filter(Boolean);
}

const EVENT_STYLE = {
  sync: { row: 0, color: 'var(--text-3)', label: 'Sync' },
  data: { row: 1, color: COLORS.grid, label: 'Meter data arrived' },
  tariff: { row: 1, color: 'var(--accent)', label: 'Tariff change' },
  forecast: { row: 2, color: COLORS.solar, label: 'Forecast issued' },
  dispatch: { row: 2, color: COLORS.ev, label: 'Smart-charge slot' },
  check: { row: 3, color: 'var(--warn)', label: 'Check warning' },
  quarantine: { row: 3, color: 'var(--bad)', label: 'Quarantined payload' },
};

function draw(host, d, lanes, tf, state) {
  host.innerHTML = '';
  const rows = [...d.rows, ...d.forecast];
  if (!rows.length) { host.innerHTML = '<div class="skeleton">No half-hours in this period yet.</div>'; return; }
  const W = Math.max(320, host.clientWidth);
  const narrow = W < 700;
  const gut = narrow ? 96 : 190; const right = 10; const top = 26; const gap = 6;
  const iw = W - gut - right;
  const n = rows.length; const band = iw / n;
  let y = top;
  for (const l of lanes) { l.y = y; y += l.h + gap; }
  const H = y + 18;
  const x = (i) => gut + i * band;
  // Bars are placed by row; clock times (events, now) map onto the same rows, which start at the first half-hour with data.
  const t0 = rows[0].slot_start; const tN = rows[rows.length - 1].slot_start + 1800;
  const xt = (ts) => gut + ((ts - t0) / 1800) * band;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Everything on one timeline' }, host);
  svg.style.display = 'block'; svg.style.width = '100%';

  // Lane backgrounds and labels.
  lanes.forEach((l, k) => {
    if (k % 2 === 0) svgEl('rect', { x: 0, y: l.y - gap / 2, width: W, height: l.h + gap, fill: 'var(--surface-2)', 'fill-opacity': 0.45 }, svg);
    svgEl('rect', { x: 4, y: l.y + 2, width: 3, height: Math.max(6, l.h - 4), rx: 1.5, fill: l.color }, svg);
    const t1 = svgEl('text', { x: 12, y: l.y + Math.min(14, l.h - 2), style: `fill:var(--text);font-size:${l.h < 20 ? 11 : 12}px;font-weight:600` }, svg);
    t1.textContent = l.label;
    if (!narrow && l.h >= 34) {
      const t2 = svgEl('text', { x: 12, y: l.y + 28, style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t2.textContent = l.source.length > 34 ? `${l.source.slice(0, 33)}…` : l.source;
    }
  });

  // Forecast region, day boundaries, axis labels, now line.
  const firstFc = rows.findIndex((r) => r.state === 'forecast');
  if (firstFc >= 0) {
    svgEl('rect', { x: x(firstFc), y: top - 4, width: iw - firstFc * band, height: H - top - 14, fill: 'var(--text)', 'fill-opacity': 0.04 }, svg);
    const t = svgEl('text', { x: x(firstFc) + 4, y: top - 8, style: 'fill:var(--text-3);font-size:11px' }, svg);
    t.textContent = 'Forecast →';
  }
  let lastLabel = -1e9;
  rows.forEach((r, i) => {
    const { h, m } = tf.hm(r.slot_start);
    if (m !== 0) return;
    if (h === 0) {
      svgEl('line', { x1: x(i), x2: x(i), y1: top - 4, y2: H - 14, stroke: 'var(--border)', 'stroke-width': 1 }, svg);
      if (x(i) - lastLabel > 54) {
        const t = svgEl('text', { x: x(i) + 3, y: top - 8, style: 'fill:var(--text-2);font-size:11px;font-weight:600' }, svg);
        t.textContent = tf.day(r.slot_start).split(' ').slice(0, 2).join(' ');
        lastLabel = x(i);
      }
    }
    if (n <= 110 && h % (narrow ? 6 : 3) === 0) {
      const t = svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t.textContent = `${String(h).padStart(2, '0')}:00`;
    } else if (n > 110 && h === 12 && band * 48 > 40) {
      const t = svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t.textContent = tf.day(r.slot_start).split(' ').slice(1, 3).join(' ');
    }
  });

  const isFc = (r) => r.state === 'forecast';
  for (const l of lanes) {
    const g = svgEl('g', {}, svg);
    if (l.kind === 'heat') {
      const vals = rows.map(l.get).filter((v) => v != null);
      const lo = Math.min(...vals); const hi = Math.max(...vals);
      rows.forEach((r, i) => {
        const v = l.get(r);
        if (v == null) return;
        const p = hi > lo ? 8 + ((v - lo) / (hi - lo)) * 80 : 40;
        svgEl('rect', { x: x(i), y: l.y + 1, width: band + 0.3, height: l.h - 2, style: `fill:color-mix(in srgb, var(--text) ${p.toFixed(0)}%, var(--surface))` }, g);
      });
      if (vals.length) {
        const t = svgEl('text', { x: W - right - 2, y: l.y - 1, 'text-anchor': 'end', style: 'fill:var(--text-3);font-size:10px' }, svg);
        t.textContent = `${Math.round(lo)}–${Math.round(hi)} g/kWh`;
      }
      continue;
    }
    if (l.kind === 'states') {
      const col = { final: faded('var(--good)', 70), provisional: faded('var(--warn)', 75), missing: 'var(--bad)', forecast: 'var(--surface-2)' };
      rows.forEach((r, i) => {
        svgEl('rect', { x: x(i), y: l.y + 1, width: band + 0.3, height: l.h - 2, style: `fill:${col[r.state] || 'var(--surface-2)'}` }, g);
        if (r.quality & 128) svgEl('circle', { cx: x(i) + band / 2, cy: l.y + l.h / 2, r: 2, fill: 'var(--text)' }, g);
      });
      continue;
    }
    if (l.kind === 'events') {
      const rowsY = [l.y + 7, l.y + 19, l.y + 31, l.y + 43];
      for (const e of d.events) {
        const st = EVENT_STYLE[e.kind]; if (!st) continue;
        const ex = xt(e.ts);
        if (ex < gut - 1 || ex > W - right + 1) continue;
        const ey = rowsY[st.row];
        if (e.kind === 'sync') svgEl('line', { x1: ex, x2: ex, y1: ey - 4, y2: ey + 4, stroke: e.status === 'ok' ? 'var(--text-3)' : 'var(--warn)', 'stroke-width': 1.2 }, g);
        else if (e.kind === 'dispatch') svgEl('rect', { x: ex, y: ey - 3, width: Math.max(2, ((e.end - e.ts) / 1800) * band), height: 6, rx: 2, fill: st.color }, g);
        else if (e.kind === 'data') svgEl('path', { d: `M${ex},${ey - 5} L${ex + 5},${ey} L${ex},${ey + 5} L${ex - 5},${ey} Z`, fill: st.color }, g);
        else if (e.kind === 'tariff') svgEl('path', { d: `M${ex},${ey + 5} V${ey - 6} L${ex + 7},${ey - 3} L${ex},${ey}`, fill: st.color, stroke: st.color }, g);
        else if (e.kind === 'forecast') svgEl('circle', { cx: ex, cy: ey, r: 2.6, fill: st.color }, g);
        else svgEl('path', { d: `M${ex},${ey - 5} L${ex + 5},${ey + 4} L${ex - 5},${ey + 4} Z`, fill: e.status === 'fail' || e.kind === 'quarantine' ? 'var(--bad)' : 'var(--warn)' }, g);
      }
      continue;
    }
    // Value lanes: own scale, zero line between charge-type and supply-type values.
    const pos = l.pos || []; const neg = l.neg || []; const lines = [...(l.lines || []), ...(l.line ? [l.line] : [])];
    let hi = 0; let lo = 0;
    rows.forEach((r) => {
      hi = Math.max(hi, pos.reduce((s, p) => s + Math.max(0, p.get(r) || 0), 0));
      lo = Math.max(lo, neg.reduce((s, p) => s + Math.max(0, p.get(r) || 0), 0));
      for (const ln of lines) { const v = ln.get(r); if (v != null && Number.isFinite(v)) { hi = Math.max(hi, v); if (v < 0) lo = Math.max(lo, -v); } }
    });
    let minV = -lo; let maxV = hi;
    if (l.fixed) { [minV, maxV] = l.fixed; }
    if (!lines.length || pos.length) minV = Math.min(minV, 0);
    if (l.key === 'weather') { const vs = rows.map((r) => r.outdoor_temp).filter((v) => v != null); if (vs.length) { minV = Math.floor(Math.min(...vs)) - 1; maxV = Math.ceil(Math.max(...vs)) + 1; } }
    if (maxV - minV < 1e-9) maxV = minV + 1;
    const pad = 3;
    const yv = (v) => l.y + pad + (l.h - 2 * pad) * (1 - (v - minV) / (maxV - minV));
    if (minV < 0 && maxV > 0) svgEl('line', { x1: gut, x2: W - right, y1: yv(0), y2: yv(0), stroke: 'var(--border)' }, g);
    const scaleText = svgEl('text', { x: W - right - 2, y: l.y + 9, 'text-anchor': 'end', style: 'fill:var(--text-3);font-size:10px' }, svg);
    const f = (v) => (l.money ? fmt.gbp(v) : l.unit === '%' ? `${Math.round(v)}%` : `${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)} ${l.unit}`);
    scaleText.textContent = minV < 0 ? `${f(maxV)} / ${f(minV)}` : `max ${f(maxV)}`;

    const bars = (series, sign) => {
      const acc = new Array(n).fill(0);
      for (const s of series) {
        let dA = ''; let dF = '';
        rows.forEach((r, i) => {
          const v = Math.max(0, s.get(r) || 0);
          if (v <= 0) return;
          const a = acc[i]; acc[i] += v;
          const y1 = yv(sign * a); const y2 = yv(sign * (a + v));
          const seg = `M${x(i).toFixed(2)},${Math.min(y1, y2).toFixed(2)}h${Math.max(0.6, band - (band > 3 ? 0.6 : 0)).toFixed(2)}v${Math.max(0.6, Math.abs(y2 - y1)).toFixed(2)}h${(-Math.max(0.6, band - (band > 3 ? 0.6 : 0))).toFixed(2)}Z`;
          if (isFc(r)) dF += seg; else dA += seg;
        });
        if (dA) svgEl('path', { d: dA, style: `fill:${s.color}` }, g);
        if (dF) svgEl('path', { d: dF, style: `fill:${s.color}`, 'fill-opacity': 0.4 }, g);
      }
    };
    bars(pos, 1); bars(neg, -1);
    for (const ln of lines) {
      let dd = ''; let area = ''; let open = false; let sx = 0; let lastX = 0;
      rows.forEach((r, i) => {
        const v = ln.get(r);
        if (v == null || !Number.isFinite(v)) {
          if (open && ln.area) area += `L${lastX},${yv(Math.max(minV, 0))}L${sx},${yv(Math.max(minV, 0))}Z`;
          open = false; return;
        }
        const px = ln.step ? x(i) : x(i) + band / 2; const py = yv(v);
        if (!open) { dd += `M${px.toFixed(1)},${py.toFixed(1)}`; area += `M${px.toFixed(1)},${yv(Math.max(minV, 0)).toFixed(1)}L${px.toFixed(1)},${py.toFixed(1)}`; sx = px; open = true; }
        else if (ln.step) { dd += `H${px.toFixed(1)}V${py.toFixed(1)}`; area += `H${px.toFixed(1)}V${py.toFixed(1)}`; }
        else { dd += `L${px.toFixed(1)},${py.toFixed(1)}`; area += `L${px.toFixed(1)},${py.toFixed(1)}`; }
        if (ln.step) { dd += `H${(x(i) + band).toFixed(1)}`; area += `H${(x(i) + band).toFixed(1)}`; }
        lastX = ln.step ? x(i) + band : px;
      });
      if (open && ln.area) area += `L${lastX},${yv(Math.max(minV, 0))}L${sx},${yv(Math.max(minV, 0))}Z`;
      if (ln.area) svgEl('path', { d: area, style: `fill:${ln.color}`, 'fill-opacity': 0.15 }, g);
      svgEl('path', { d: dd, fill: 'none', style: `stroke:${ln.color}`, 'stroke-width': 1.5, 'stroke-dasharray': ln.dash ? '4 3' : null, 'stroke-linejoin': 'round' }, g);
    }
    if (l.bands === 'dispatch') {
      for (const e of d.events.filter((x2) => x2.kind === 'dispatch')) {
        const ex = xt(e.ts);
        svgEl('rect', { x: ex, y: l.y, width: Math.max(1, ((e.end - e.ts) / 1800) * band), height: l.h, style: `fill:${COLORS.ev}`, 'fill-opacity': 0.12 }, g);
      }
    }
  }

  // Now line across every lane.
  if (d.now >= t0 && d.now <= tN) {
    const nx = xt(d.now);
    svgEl('line', { x1: nx, x2: nx, y1: top - 14, y2: H - 14, stroke: 'var(--text)', 'stroke-dasharray': '3 3' }, svg);
    const t = svgEl('text', { x: nx, y: top - 16, 'text-anchor': 'middle', style: 'fill:var(--text);font-size:11px;font-weight:600' }, svg);
    t.textContent = 'Now';
  }

  // One crosshair through every lane, one tooltip with everything at that half-hour.
  const cross = svgEl('rect', { x: 0, y: top - 4, width: Math.max(1, band), height: H - top - 10, fill: 'var(--text)', 'fill-opacity': 0.08, visibility: 'hidden' }, svg);
  const overlay = svgEl('rect', { x: gut, y: 0, width: iw, height: H, fill: 'transparent', style: 'cursor:crosshair' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.style.minWidth = '250px';
  tip.hidden = true;
  host.appendChild(tip);
  const evLane = lanes.find((l) => l.kind === 'events');
  const at = (ev) => {
    const box = svg.getBoundingClientRect();
    const mx = ((ev.clientX - box.left) / box.width) * W; const my = ((ev.clientY - box.top) / box.height) * H;
    return { i: Math.min(n - 1, Math.max(0, Math.floor((mx - gut) / band))), mx, my, box };
  };
  overlay.addEventListener('pointermove', (ev) => {
    const { i, mx, my, box } = at(ev);
    const r = rows[i];
    cross.setAttribute('x', x(i)); cross.setAttribute('width', Math.max(1.5, band)); cross.setAttribute('visibility', 'visible');
    let html = '';
    if (evLane && my >= evLane.y && my <= evLane.y + evLane.h) {
      const near = d.events.filter((e) => Math.abs(xt(e.ts) - mx) < Math.max(6, band) || (e.end && e.ts <= r.slot_start && e.end > r.slot_start)).slice(0, 8);
      if (near.length) html = `<div class="t-head">Events</div>${near.map((e) => `<div style="margin-top:4px"><b>${esc(e.label)}</b> <span class="faint">${tf.dayTime(e.ts)}</span><br><span class="muted">${esc(e.detail || '')}</span></div>`).join('')}`;
    }
    if (!html) html = tipFor(r, lanes, d, tf);
    tip.innerHTML = html;
    tip.hidden = false;
    const px = ((x(i) + band) / W) * box.width; const tw = tip.offsetWidth;
    tip.style.left = `${px + tw + 16 > box.width ? Math.max(0, ((x(i)) / W) * box.width - tw - 10) : px + 10}px`;
    const py = ((my / H) * box.height) - tip.offsetHeight / 2;
    tip.style.top = `${Math.min(Math.max(0, py), box.height - tip.offsetHeight)}px`;
  });
  overlay.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  overlay.addEventListener('click', (ev) => { const r = rows[at(ev).i]; if (r.state !== 'forecast') location.href = evidenceLink(state, r.slot_start); });
}

function tipFor(r, lanes, d, tf) {
  const on = new Set(lanes.map((l) => l.key));
  const k = (v, dp = 2) => fmt.kwh(v, dp);
  const line = (label, color, value, src) => `<div class="t-row"><span>${color ? `<i class="swatch" style="background:${color}"></i>` : ''}${label}</span><b>${value}${src ? ` <span class="faint" style="font-weight:400">${src}</span>` : ''}</b></div>`;
  const out = [];
  const fc = r.state === 'forecast';
  out.push(`<div class="t-head">${tf.dayTime(r.slot_start)} <span class="badge ${fc ? '' : r.state === 'final' ? 'good' : r.state === 'missing' ? 'bad' : 'warn'}">${fc ? 'forecast' : r.state}</span></div>`);
  if (on.has('solar')) out.push(line('Solar made', COLORS.solar, k(r.solar), r.solar_forecast != null && !fc ? `fc ${fmt.num(r.solar_forecast, 2)}` : ''));
  if (on.has('battery')) out.push(line('Battery out / in', COLORS.battery, `${fmt.num(r.battery_discharge, 2)} / ${fmt.num(r.battery_charge, 2)} kWh`));
  if (on.has('soc') && r.soc_end != null) out.push(line('Charge level', COLORS.battery, `${Math.round(r.soc_end)}%`));
  if (on.has('grid')) out.push(line('Grid in / out', COLORS.grid, `${fmt.num(r.grid_import, 2)} / ${fmt.num(r.grid_export, 2)} kWh`, fc ? '' : r.import_source === 'octopus_meter' ? 'meter' : r.import_source === 'sunsynk_ct' ? 'clamp' : ''));
  if (on.has('home')) out.push(line('House used', 'var(--text-2)', k(r.home), r.home ? `solar ${fmt.num(r.solar_to_home, 2)} · battery ${fmt.num(r.battery_to_home, 2)} · grid ${fmt.num(r.grid_to_home, 2)}` : ''));
  if (on.has('home') && r.loss != null && Math.abs(r.loss) > 0.005) out.push(line(r.loss > 0 ? 'Inverter loss' : 'Unmeasured', 'var(--text-3)', k(Math.abs(r.loss))));
  if (on.has('ev') && r.ev) out.push(line('EV', COLORS.ev, k(r.ev)));
  if (on.has('gas') && r.gas) out.push(line('Gas', GAS, k(r.gas)));
  if (on.has('price')) out.push(line('Price in / out', COLORS.grid, `${fmt.p(r.import_rate)} / ${fmt.p(r.export_rate)}`, r.register && r.register !== 'single' ? r.register : ''));
  if (on.has('cost')) out.push(line('Cost', null, fmt.gbp(r.total_cost), r.grid_only_cost != null ? `grid only ${fmt.gbp(r.grid_only_cost)}` : ''));
  if (on.has('carbon') && r.carbon_intensity != null) out.push(line('Grid carbon', null, `${Math.round(r.carbon_intensity)} g/kWh`));
  if (on.has('weather') && r.outdoor_temp != null) out.push(line('Outside', null, `${r.outdoor_temp.toFixed(1)} °C`));
  const evs = d.events.filter((e) => (e.end ? e.ts < r.slot_start + 1800 && e.end > r.slot_start : e.ts >= r.slot_start && e.ts < r.slot_start + 1800) && e.kind !== 'sync');
  if (evs.length) out.push(`<div class="t-foot">${evs.slice(0, 4).map((e) => esc(e.label)).join(' · ')}</div>`);
  if (!fc) out.push('<div class="t-foot">Click for the evidence behind this half-hour</div>');
  return out.join('');
}

// ───── What the house used, by source, and what it cost ─────
// Past half-hours use the core's priced build: grid energy at the import price, battery
// energy at what it cost to store (first in, first out; solar-charged = 0p). Forecast
// half-hours have no stored-energy cost yet, so only what comes from the grid is paid.
function priced(r) {
  const p = r.import_rate;
  if (p == null) return { worth: null, paid: null, saved: null };
  const worth = r.home == null ? null : r.home * p;
  // A forecast without a grid figure has no split, so nothing is claimed as saved.
  const paid = r.state === 'forecast' ? (r.grid_import == null ? null : r.grid_import * p)
    : r.grid_to_home_cost == null ? null : r.grid_to_home_cost + (r.battery_to_home_cost || 0);
  return { worth, paid, saved: paid == null || worth == null ? null : worth - paid };
}

// Period totals from past half-hours only. Grid energy is paid at the price it is worth,
// so the whole saving splits into solar (free) and the battery (worth minus stored cost).
function pricedTotals(rows) {
  const t = { home: 0, solar: 0, battery: 0, grid: 0, worth: 0, paid: 0, fromSolar: 0, fromBattery: 0, unpriced: 0 };
  for (const r of rows) {
    t.home += r.home || 0; t.solar += r.solar_to_home || 0; t.battery += r.battery_to_home || 0; t.grid += r.grid_to_home || 0;
    const p = r.import_rate;
    if (p == null || r.grid_to_home_cost == null) { if (r.home > 0) t.unpriced++; continue; }
    t.worth += (r.home || 0) * p;
    t.paid += r.grid_to_home_cost + (r.battery_to_home_cost || 0);
    t.fromSolar += (r.solar_to_home || 0) * p;
    t.fromBattery += (r.battery_to_home || 0) * p - (r.battery_to_home_cost || 0);
  }
  t.saved = t.worth - t.paid;
  return t;
}

// Consecutive half-hours at one import price become one block (an off-peak window, a day
// rate). Agile changes every half-hour, so its blocks are often a single half-hour wide.
function priceBlocks(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const p = r.import_rate; const fc = r.state === 'forecast';
    if (p == null) return;
    const b = out[out.length - 1];
    if (b && b.end === i && b.fc === fc && Math.abs(b.price - p) < 1e-6 && rows[i - 1].slot_start === r.slot_start - 1800) b.end = i + 1;
    else out.push({ start: i, end: i + 1, price: p, fc });
  });
  return out;
}
const priceFill = (t) => `color-mix(in srgb, var(--price-hi) ${Math.round(t * 100)}%, var(--price-lo))`;
const priceRange = (rows) => {
  const ps = rows.map((r) => r.import_rate).filter((v) => v != null);
  const lo = Math.min(...ps); const hi = Math.max(...ps);
  return { lo, hi, n: ps.length, t: (p) => (hi - lo > 1e-6 ? (p - lo) / (hi - lo) : 0.5) };
};

function drawPriced(host, d, tf, state) {
  host.innerHTML = '';
  const rows = [...d.rows, ...d.forecast];
  if (!rows.length) { host.innerHTML = '<div class="skeleton">No half-hours in this period yet.</div>'; return { negDrawn: false }; }
  const W = Math.max(320, host.clientWidth);
  const narrow = W < 700;
  // Same gutter as the timeline above, so a half-hour sits at the same x in both cards.
  const gut = narrow ? 96 : 190; const right = 10; const top = 30; const gap = 10; const pad = 3;
  const iw = W - gut - right;
  const n = rows.length; const band = iw / n;
  const x = (i) => gut + i * band;
  const isFc = (r) => r.state === 'forecast';
  const money = rows.map(priced);
  const pr = priceRange(rows);
  const lanes = [
    { key: 'price', label: narrow ? 'Price' : 'Import price', sub: 'p/kWh', h: narrow ? 26 : 34, color: 'var(--price-hi)' },
    { key: 'use', label: narrow ? 'Used' : 'House used', sub: narrow ? 'kWh' : 'kWh, by source', h: narrow ? 86 : 104, color: 'var(--text-2)' },
    { key: 'cost', label: narrow ? 'Cost' : 'Paid and saved', sub: narrow ? 'pence' : 'pence; top = grid price', h: narrow ? 86 : 104, color: 'var(--good)' },
  ];
  let y = top;
  for (const l of lanes) { l.y = y; y += l.h + gap; }
  const bottom = y - gap;
  const H = bottom + 20;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'What the house used, by source, and what it cost' }, host);
  svg.style.display = 'block'; svg.style.width = '100%';

  lanes.forEach((l, k) => {
    if (k % 2 === 0) svgEl('rect', { x: 0, y: l.y - gap / 2, width: W, height: l.h + gap, fill: 'var(--surface-2)', 'fill-opacity': 0.45 }, svg);
    svgEl('rect', { x: 4, y: l.y + 2, width: 3, height: Math.max(6, l.h - 4), rx: 1.5, fill: l.color }, svg);
    const t1 = svgEl('text', { x: 12, y: l.y + 13, style: 'fill:var(--text);font-size:12px;font-weight:600' }, svg);
    t1.textContent = l.label;
    if (l.h >= 34) {
      const t2 = svgEl('text', { x: 12, y: l.y + 27, style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t2.textContent = l.sub;
    }
  });

  // Forecast region, day boundaries and axis labels, as on the timeline above.
  const firstFc = rows.findIndex(isFc);
  if (firstFc >= 0) svgEl('rect', { x: x(firstFc), y: top - 4, width: iw - firstFc * band, height: bottom - top + 8, fill: 'var(--text)', 'fill-opacity': 0.04 }, svg);
  let lastLabel = -1e9;
  const dayLabels = [];
  rows.forEach((r, i) => {
    const { h, m } = tf.hm(r.slot_start);
    if (m !== 0) return;
    if (h === 0) {
      svgEl('line', { x1: x(i), x2: x(i), y1: top - 4, y2: bottom + 4, stroke: 'var(--border)', 'stroke-width': 1 }, svg);
      if (x(i) - lastLabel > 54) { dayLabels.push([x(i) + 3, tf.day(r.slot_start).split(' ').slice(0, 2).join(' ')]); lastLabel = x(i); }
    }
    if (n <= 110 && h % (narrow ? 6 : 3) === 0) {
      const t = svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t.textContent = `${String(h).padStart(2, '0')}:00`;
    } else if (n > 110 && h === 12 && band * 48 > 40) {
      const t = svgEl('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', style: 'fill:var(--text-3);font-size:10.5px' }, svg);
      t.textContent = tf.day(r.slot_start).split(' ').slice(1, 3).join(' ');
    }
  });

  // 1. Price blocks, labelled when the price fits inside (whole pence as a fallback from 10p up,
  // where rounding moves the number by under 5%).
  const pl = lanes[0];
  const gp = svgEl('g', {}, svg);
  for (const b of priceBlocks(rows)) {
    const w = (b.end - b.start) * band; const inset = w > 4 ? 0.5 : 0;
    const t = pr.t(b.price);
    svgEl('rect', { x: x(b.start) + inset, y: pl.y, width: Math.max(0.5, w - 2 * inset), height: pl.h, rx: w > 8 ? 2 : 0, style: `fill:${priceFill(t)}`, 'fill-opacity': b.fc ? 0.55 : 1 }, gp);
    const label = [fmt.p(b.price), Math.abs(b.price) >= 10 && `${Math.round(b.price)}p`].find((s) => s && s.length * 6.2 + 6 <= w);
    if (!label) continue;
    // Dark ink on the cheap end, surface ink on the dear end (faded forecast blocks count as cheaper-looking).
    const ink = (b.fc ? t * 0.55 : t) > 0.6 ? 'var(--surface)' : 'var(--text)';
    const tx = svgEl('text', { x: x(b.start) + w / 2, y: pl.y + pl.h / 2 + 3.5, 'text-anchor': 'middle', style: `fill:${ink};font-size:10.5px;font-weight:600` }, gp);
    tx.textContent = label;
  }

  // 2 and 3. Stacked bars on the lane's own scale: positives up from zero, negatives down.
  let negDrawn = false;
  const stack = (l, series, tick) => {
    let hi = 0; let lo = 0;
    rows.forEach((r, i) => {
      hi = Math.max(hi, series.reduce((s, sr) => s + Math.max(0, sr.get(r, i) ?? 0), 0));
      lo = Math.min(lo, series.reduce((s, sr) => s + Math.min(0, sr.get(r, i) ?? 0), 0));
    });
    const sc = niceScale(0, hi > 1e-9 ? hi : 1, 4);
    // Negatives keep their true size, so a fraction of a penny does not claim a whole tick.
    const maxV = sc.hi; const minV = lo;
    const yv = (v) => l.y + pad + (l.h - 2 * pad) * (1 - (v - minV) / (maxV - minV));
    const g = svgEl('g', {}, svg);
    for (let v = 0; v <= maxV + 1e-9; v += sc.step) {
      svgEl('line', { x1: gut, x2: W - right, y1: yv(v), y2: yv(v), stroke: v === 0 ? 'var(--text-3)' : 'var(--border)', 'stroke-width': v === 0 ? 0.8 : 1 }, g);
      const t = svgEl('text', { x: gut - 6, y: yv(v) + 3.5, 'text-anchor': 'end', style: 'fill:var(--text-3);font-size:10px' }, g);
      t.textContent = tick(v, sc.step);
    }
    if (lo < -0.08 * maxV) {
      const t = svgEl('text', { x: gut - 6, y: yv(lo), 'text-anchor': 'end', style: 'fill:var(--text-3);font-size:10px' }, g);
      t.textContent = tick(lo, sc.step);
    }
    const bw = Math.max(0.6, band - (band > 8 ? 1.5 : band > 3 ? 0.6 : 0));
    for (const sign of [1, -1]) {
      const acc = new Array(n).fill(0);
      for (const s of series) {
        let dA = ''; let dF = '';
        rows.forEach((r, i) => {
          const v = Math.max(0, sign * (s.get(r, i) ?? 0));
          if (v <= 0) return;
          const a = acc[i]; acc[i] += v;
          const y1 = yv(sign * a); const y2 = yv(sign * (a + v));
          // Sub-pixel slivers (thousandths of a penny from a few Wh) would only show as specks.
          if (Math.abs(y2 - y1) < 0.5) return;
          const seg = `M${(x(i) + (band - bw) / 2).toFixed(2)},${Math.min(y1, y2).toFixed(2)}h${bw.toFixed(2)}v${Math.abs(y2 - y1).toFixed(2)}h${(-bw).toFixed(2)}Z`;
          if (isFc(r)) dF += seg; else dA += seg;
          if (sign < 0 && s.negColor) negDrawn = true;
        });
        const color = sign < 0 && s.negColor ? s.negColor : s.color;
        if (dA) svgEl('path', { d: dA, style: `fill:${color}` }, g);
        if (dF) svgEl('path', { d: dF, style: `fill:${color}`, 'fill-opacity': 0.4 }, g);
      }
    }
  };
  stack(lanes[1], [
    { get: (r) => r.solar_to_home, color: COLORS.solar },
    { get: (r) => r.battery_to_home, color: COLORS.battery },
    { get: (r) => r.grid_to_home, color: COLORS.grid },
  ], (v, step) => v.toFixed(step < 1 ? 1 : 0));
  stack(lanes[2], [
    { get: (r, i) => money[i].paid, color: 'var(--text-2)' },
    { get: (r, i) => money[i].saved, color: 'var(--good)', negColor: 'var(--bad)' },
  ], (v) => `${Math.round(v)}p`);

  // Now, inside the half-hour that contains it, on the same index axis as the bars.
  const nowI = rows.findIndex((r) => d.now >= r.slot_start && d.now < r.slot_start + 1800);
  const nx = nowI >= 0 ? x(nowI) + ((d.now - rows[nowI].slot_start) / 1800) * band : firstFc >= 0 ? x(firstFc) : null;
  if (nx != null) {
    svgEl('line', { x1: nx, x2: nx, y1: 14, y2: bottom + 4, stroke: 'var(--text)', 'stroke-dasharray': '3 3' }, svg);
    const t = svgEl('text', { x: nx, y: 11, 'text-anchor': 'middle', style: 'fill:var(--text);font-size:11px;font-weight:600' }, svg);
    t.textContent = 'Now';
    if (firstFc >= 0 && nx + 80 < W - right) {
      const f = svgEl('text', { x: nx + 18, y: 11, style: 'fill:var(--text-3);font-size:11px' }, svg);
      f.textContent = 'Forecast →';
    }
  }
  // Day labels last, with a surface halo, so the now line never runs through one.
  for (const [lx, text] of dayLabels) {
    const t = svgEl('text', { x: lx, y: top - 8, style: 'fill:var(--text-2);font-size:11px;font-weight:600;paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round' }, svg);
    t.textContent = text;
  }

  // One crosshair through all three rows, one tooltip for the half-hour.
  const cross = svgEl('rect', { x: 0, y: top - 4, width: Math.max(1.5, band), height: bottom - top + 8, fill: 'var(--text)', 'fill-opacity': 0.08, visibility: 'hidden' }, svg);
  const overlay = svgEl('rect', { x: gut, y: 0, width: iw, height: H, fill: 'transparent', style: 'cursor:crosshair' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.style.minWidth = '230px';
  tip.hidden = true;
  host.appendChild(tip);
  const at = (ev) => {
    const box = svg.getBoundingClientRect();
    const mx = ((ev.clientX - box.left) / box.width) * W; const my = ((ev.clientY - box.top) / box.height) * H;
    return { i: Math.min(n - 1, Math.max(0, Math.floor((mx - gut) / band))), my, box };
  };
  overlay.addEventListener('pointermove', (ev) => {
    const { i, my, box } = at(ev);
    cross.setAttribute('x', x(i)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = pricedTip(rows[i], money[i], pr, tf);
    tip.hidden = false;
    const px = ((x(i) + band) / W) * box.width; const tw = tip.offsetWidth;
    tip.style.left = `${px + tw + 16 > box.width ? Math.max(0, (x(i) / W) * box.width - tw - 10) : px + 10}px`;
    const py = ((my / H) * box.height) - tip.offsetHeight / 2;
    tip.style.top = `${Math.min(Math.max(0, py), box.height - tip.offsetHeight)}px`;
  });
  overlay.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  overlay.addEventListener('click', (ev) => { const r = rows[at(ev).i]; if (!isFc(r)) location.href = evidenceLink(state, r.slot_start); });
  return { negDrawn };
}

function pricedTip(r, mo, pr, tf) {
  const fc = r.state === 'forecast';
  const p = r.import_rate;
  const note = (s) => ` <span class="faint" style="font-weight:400">${s}</span>`;
  const head = `${tf.dayTime(r.slot_start)} <span class="badge ${fc ? '' : r.state === 'final' ? 'good' : r.state === 'missing' ? 'bad' : 'warn'}">${fc ? 'forecast' : r.state}</span>`;
  // Past saving splits into solar (free) and battery (worth minus what it cost to store).
  const split = !fc && p != null && mo.saved != null
    ? note(`solar ${fmt.p((r.solar_to_home || 0) * p)} · battery ${fmt.p((r.battery_to_home || 0) * p - (r.battery_to_home_cost || 0))}`) : '';
  return tipHtml(head, [
    ['Import price', p != null ? priceFill(pr.t(p)) : null, fmt.pkwh(p)],
    ['From solar', COLORS.solar, fmt.kwh(r.solar_to_home, 2)],
    ['From battery', COLORS.battery, fmt.kwh(r.battery_to_home, 2)],
    ['From grid', COLORS.grid, fmt.kwh(r.grid_to_home, 2)],
    ['At grid price', null, fmt.p(mo.worth)],
    ['Paid', 'var(--text-2)', `${fmt.p(mo.paid)}${!fc && r.battery_to_home_cost ? note(`grid ${fmt.p(r.grid_to_home_cost)} · battery ${fmt.p(r.battery_to_home_cost)}`) : ''}`],
    ['Saved', mo.saved < 0 ? 'var(--bad)' : 'var(--good)', `${fmt.p(mo.saved)}${split}`],
  ], fc ? 'Forecast: grid imports paid at the import price' : 'Click for the evidence behind this half-hour');
}

const STATE_NOTES = [
  ['final', faded('var(--good)', 70), 'Smart-meter readings received and every check run. Will not change unless the provider revises its data.'],
  ['provisional', faded('var(--warn)', 70), 'Built from the inverter’s grid clamp because smart-meter data hasn’t arrived yet (Octopus delivers about a day late), or the day isn’t over. Rebuilt automatically when the meter data arrives.'],
  ['missing', faded('var(--bad)', 70), 'No grid reading from any source for that half-hour.'],
  ['forecast', 'var(--surface-2);box-shadow:inset 0 0 0 1px var(--border)', 'After now, from the forecast.'],
  ['revised', 'var(--text);border-radius:50%;width:6px;height:6px;margin:0 2px', 'The numbers changed after the half-hour was first shown as final.'],
];

async function render(state) {
  const tf = timeFmt(state.tz);
  const d = await api(`/api/sites/${state.site.id}/everything?period=${state.period}`);
  const lanes = lanesFor(d);
  const hidden = new Set(store.get('eb.lanes.hidden') || []);
  const counts = d.rows.reduce((m, r) => (m[r.state] = (m[r.state] || 0) + 1, m), {});
  const chip = (l) => {
    const f = l.fresh;
    const stale = f && f.status === 'error';
    return `<button class="lane-chip ${hidden.has(l.key) ? 'off' : ''}" data-lane="${l.key}" title="${esc(l.source)}${f?.error ? ` — ${esc(f.error)}` : ''}">
      <i class="swatch" style="background:${l.color}"></i><span><b>${esc(l.label)}</b><small>${esc(l.part)}</small>
      <small class="${stale ? 'bad' : ''}">${esc(l.source)}${f ? ` · ${stale ? 'error' : ago(f.at)}` : ''}</small></span></button>`;
  };
  const evKinds = [...new Set(d.events.map((e) => e.kind))];
  const pt = pricedTotals(d.rows);
  const pr = priceRange([...d.rows, ...d.forecast]);
  const excluded = [d.forecast.length && `the ${d.forecast.length} forecast half-hours are excluded`, pt.unpriced && `${pt.unpriced} half-hours without a price are left out of the money`].filter(Boolean);
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-head"><div><h2>The system</h2><p>Every part of ${esc(d.site.name)} and the source that reports it. Click a part to show or hide its row.</p></div></div>
      <div class="lane-chips">${lanes.map(chip).join('')}</div>
    </div>
    <div class="section card">
      <div class="card-head"><div><h2>Everything, one timeline</h2>
        <p>${d.rows.length} half-hours (${counts.final || 0} final, ${counts.provisional || 0} provisional, ${counts.missing || 0} missing)${d.forecast.length ? ` + ${d.forecast.length} forecast` : ''} · ${d.events.length} events.
        Each row has its own scale (top right of the row). Hover for everything at that moment; click for its evidence.</p></div></div>
      <div id="everything" class="chart"></div>
      <div class="legend" style="margin-top:10px">
        ${[['final', 'var(--good)'], ['provisional', 'var(--warn)'], ['missing', 'var(--bad)']].map(([l, c]) => `<span><i class="swatch" style="background:${faded(c, 70)}"></i>${l}</span>`).join('')}
        <span><i class="swatch" style="background:var(--text);border-radius:50%;width:6px;height:6px"></i>revised</span>
        ${evKinds.filter((k2) => EVENT_STYLE[k2]).map((k2) => `<span><i class="swatch" style="background:${EVENT_STYLE[k2].color}"></i>${EVENT_STYLE[k2].label}</span>`).join('')}
        <span><i class="dash" style="color:var(--text-2)"></i>forecast / grid-only</span>
      </div>
      <div class="state-notes">
        <h3>What the states mean</h3>
        <dl>${STATE_NOTES.map(([k2, bg, text]) => `<dt><i class="swatch" style="background:${bg}"></i>${k2}</dt><dd>${text}</dd>`).join('')}</dl>
      </div>
    </div>
    <div class="section card">
      <div class="card-head"><div><h2>What the house used, by source, and what it cost</h2>
        <p>Each half-hour: the import price (half-hours at the same price merged into one block), where the house's energy came from, and what it cost.
        A full cost bar is that use at the grid price; the grey part was paid and the green part saved. Battery energy is priced at what it cost to store
        (first in, first out; solar-charged = 0p). Hover for the numbers; click for the evidence.</p></div></div>
      <p class="priced-totals">Used <b>${fmt.kwh(pt.home)}</b> (solar ${fmt.num(pt.solar)} · battery ${fmt.num(pt.battery)} · grid ${fmt.num(pt.grid)} kWh).
        At grid prices that would have cost <b>${fmt.gbp(pt.worth)}</b>; paid <b>${fmt.gbp(pt.paid)}</b>;
        saved <b style="color:var(--good)">${fmt.gbp(pt.saved)}</b> (${fmt.gbp(pt.fromSolar)} from solar, ${fmt.gbp(pt.fromBattery)} from the battery).
        <span class="faint">Past half-hours only${excluded.length ? `; ${excluded.join('; ')}` : ''}. Energy only: no standing charge, export or inverter losses.</span></p>
      <div id="priced" class="chart"></div>
      <div class="legend" style="margin-top:10px">
        ${pr.n ? `<span><i class="price-ramp"></i>import price ${fmt.p(pr.lo)} → ${fmt.p(pr.hi)}/kWh</span>` : ''}
        <span><i class="swatch" style="background:${COLORS.solar}"></i>from solar</span>
        <span><i class="swatch" style="background:${COLORS.battery}"></i>from battery</span>
        <span><i class="swatch" style="background:${COLORS.grid}"></i>from grid</span>
        <span><i class="swatch" style="background:var(--text-2)"></i>paid</span>
        <span><i class="swatch" style="background:var(--good)"></i>saved</span>
        <span id="neg-saved-key" style="display:none"><i class="swatch" style="background:var(--bad)"></i>saved below zero: cost more than the grid price</span>
        ${d.forecast.length ? '<span><i class="swatch" style="background:var(--text-2);opacity:.4"></i>forecast (faded)</span>' : ''}
      </div>
    </div>`;
  const host = document.getElementById('everything');
  const redraw = () => draw(host, d, lanes.filter((l) => !hidden.has(l.key)), tf, state);
  redraw();
  let lastW = host.clientWidth;
  new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 4) { lastW = host.clientWidth; redraw(); } }).observe(host);
  // The "below zero" key shows only when the chart actually drew a negative saving at this width.
  const pHost = document.getElementById('priced');
  const redrawPriced = () => { const { negDrawn } = drawPriced(pHost, d, tf, state); document.getElementById('neg-saved-key').style.display = negDrawn ? '' : 'none'; };
  redrawPriced();
  let lastPW = pHost.clientWidth;
  new ResizeObserver(() => { if (Math.abs(pHost.clientWidth - lastPW) > 4) { lastPW = pHost.clientWidth; redrawPriced(); } }).observe(pHost);
  document.querySelectorAll('.lane-chip').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.lane;
    if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
    store.set('eb.lanes.hidden', [...hidden]);
    b.classList.toggle('off', hidden.has(key));
    redraw();
  }));
}

init({ page: 'everything', title: 'Timeline', subtitle: 'Every part of the home, every source and every event on one time axis: past, now and forecast.', render });
