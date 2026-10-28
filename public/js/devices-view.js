// Devices page: the pieces that turn the read model (GET /api/sites/:id/devices and .../devices/:id) into HTML and SVG.
// Pure functions of the model: no fetching, no DOM, no state, so they can be tested in Node. pages/devices.js owns the page.
import { esc } from './api.js';

export const SYNTHETIC_BANNER = 'Synthetic demo data: generated for this page, not from a real device';
export const KIND_WORDS = {
  smart_plug: 'Smart plug', heat_pump: 'Heat pump', ev_charger: 'EV charger', ev: 'Electric car', battery: 'Battery', temperature_sensor: 'Temperature sensor', inverter: 'Inverter',
  meter_import: 'Import meter', meter_export: 'Export meter', meter_gas: 'Gas meter', meter_heat: 'Heat meter',
};
export const KIND_ICON = { plug: '⏻', heat: '♨', ev: '🚗', battery: '▮', temp: '°', solar: '☀', meter: '⌁', gas: '◬', device: '◆' };
export const STATUS_WORDS = { fresh: 'Receiving data', stale: 'No new data', missing: 'No data yet' };
const ROLE_WORDS = {
  inverter_5min: 'Inverter, 5-minute', inverter_daily: 'Inverter, daily totals', meter_energy: 'Smart meter', gas_cv: 'Gas calorific value', carbon: 'Carbon intensity', weather_temp: 'Outdoor temperature',
  ev_dispatch: 'EV charge dispatch', solar_forecast: 'Solar forecast', heat_pump_energy: 'Heat pump electricity', heat_output_energy: 'Heat delivered', heat_telemetry: 'Heating telemetry',
  ev_charger_energy: 'EV charger energy', plug_energy: 'Smart plug energy',
};
export const minuteOfDay = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
const settingText = (s) => (s.word ?? (/minute of day/i.test(s.label ?? '') && s.value != null ? minuteOfDay(s.value) : num(s.value, s.unit)));
export const roleWord = (r) => ROLE_WORDS[r] ?? r.replace(/_/g, ' ');

// ───────────── Formatting ─────────────
export function clock(tz) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  const dt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { time: (ts) => t.format(ts * 1000), day: (ts) => d.format(ts * 1000), dayTime: (ts) => dt.format(ts * 1000) };
}
export function ageWords(s) {
  if (s == null) return '';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
export function num(v, unit = '') {
  if (v == null || !Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  if (unit === '0/1') return n >= 0.5 ? 'on' : 'off';
  if (unit === 'W') return `${Math.round(n).toLocaleString('en-GB')} W`;
  if (unit === 'degC') return `${n.toFixed(1)} °C`;
  if (unit === '%') return `${n.toFixed(0)} %`;
  if (unit === 'kWh') return `${n.toFixed(Math.abs(n) >= 100 ? 1 : 3)} kWh`;
  return `${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}
const quantity = (v, unit) => (unit === 'event' ? '' : num(v, unit));

// ───────────── Explainer and banner ─────────────
export function explainerHtml() {
  return `<div class="ob-explain dv-explain">
    <div><b>Counter</b>A running total, like the meter on a smart plug. The core stores it as it is and works out the energy of each period by subtracting the last reading. It copes with the counter restarting, wrapping or going wrong.</div>
    <div><b>Event</b>Something that happened, such as a defrost cycle or a car being plugged in. It has a start and an end and is never added up or averaged.</div>
    <div><b>Role</b>What the slot timeline needs from a device, such as "heat pump electricity". A device fills a role from a date; the timeline asks for the role, never for a brand.</div>
    <div><b>Channel</b>How one point a device sends (for example <span class="mono">energy_total</span>) becomes a standard measurement, with its unit, sign and allowed range.</div>
  </div>`;
}
export const bannerHtml = () => `<div class="banner dv-banner" role="note"><span><b>Synthetic demo data</b>: generated for this page, not from a real device. Every reading below was made by the demo generator and went through the same ingest path a real device would use.</span></div>`;
export const syntheticLine = () => `<p class="dv-synline"><span class="badge origin origin-synthetic">Synthetic</span> ${SYNTHETIC_BANNER}.</p>`;

// ───────────── Cards ─────────────
function keyValues(d) {
  const want = (c) => c.kind === 'counter' || ['W', 'degC', '%', '0/1', 'kWh', 'm3'].includes(c.unit);
  const chans = d.channels.filter((c) => c.last?.value != null && want(c) && c.access === 'read' && !String(c.metric).startsWith('ctl_'));
  const order = (c) => (c.kind === 'counter' ? 0 : c.unit === 'W' ? 1 : c.unit === 'degC' ? 2 : c.unit === '%' ? 3 : c.unit === 'kWh' || c.unit === 'm3' ? 1.5 : 4);
  return chans.sort((a, b) => order(a) - order(b)).slice(0, 3);
}
export function cardHtml(d, tz, selected = false) {
  const f = clock(tz);
  const kv = keyValues(d);
  return `<button type="button" class="dv-card ${selected ? 'on' : ''}" data-device="${esc(d.id)}" aria-pressed="${selected}" aria-label="${esc(d.label)}: ${esc(STATUS_WORDS[d.status.status])}">
    <span class="dv-card-top"><span class="dv-icon" aria-hidden="true">${KIND_ICON[d.icon] ?? KIND_ICON.device}</span>
      <span class="dv-kind">${esc(KIND_WORDS[d.kind] ?? d.kind)}</span>
      ${d.synthetic ? '<span class="badge origin origin-synthetic">Synthetic</span>' : d.emulated ? '<span class="badge origin origin-synthetic" title="Fed through the real push endpoint by the emulator, with generated data">Emulated</span>' : '<span class="badge good">Real</span>'}</span>
    <span class="dv-name">${esc(d.label)}</span>
    <span class="dv-status ${esc(d.status.status)}"><i aria-hidden="true"></i>${esc(d.status.words)}${d.newestTs ? `, last data ${esc(ageWords(d.status.ageS))}` : ''}</span>
    <span class="dv-vals">${kv.length ? kv.map((c) => `<span><b>${esc(num(c.last.value, c.unit))}</b><small>${esc(c.label)}${c.kind === 'period' ? ', last period' : ''}${c.kind === 'counter' && c.last.period ? `, last period ${esc(num(c.last.period.value, c.last.period.unit))}${c.last.period.partial ? ' (after a restart)' : ''}` : ''}</small></span>`).join('') : '<span><small>No values yet</small></span>'}</span>
    <span class="dv-roles">${d.roles.length ? d.roles.map((r) => `<span class="dv-chip" title="${esc(r.role)}">${esc(roleWord(r.role))}</span>`).join('') : '<span class="faint">No role bound</span>'}</span>
    <span class="dv-foot faint">${d.channelCount} channel${d.channelCount === 1 ? '' : 's'}${d.controllable ? ' · can be controlled' : ''}${d.newestTs ? ` · newest ${esc(f.dayTime(d.newestTs))}` : ''}${d.lastPushAt ? ` · last push ${esc(ageWords(Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(d.lastPushAt / 1000))))}` : ''}</span>
  </button>`;
}

// ───────────── SVG charts (strings) ─────────────
// The charts are drawn at the width of their container (setChartWidth), so their text is the size of the page's text on every screen.
let W = 720; const M = { l: 52, r: 12, t: 18, b: 26 };
export function setChartWidth(w) { W = Math.max(300, Math.round(w)); }
export function niceScale(min, max, ticks = 4) {
  if (!(max > min)) { max = min + 1; }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(min / step + 1e-9) * step, hi: Math.ceil(max / step - 1e-9) * step, step };
}
function frame(win, tz, height) {
  const iw = W - M.l - M.r; const ih = height - M.t - M.b;
  const x = (ts) => M.l + ((Math.min(Math.max(ts, win.start), win.end) - win.start) / (win.end - win.start)) * iw;
  const f = clock(tz);
  // vertical ticks: every 3, 6 or 12 hours by the window's length, labelled with the clock, and the day at local midnight
  // the closest ticks that leave about 85 px for each label, so nothing overlaps on a phone
  const span = win.end - win.start;
  const every = [1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600].find((c) => span / c <= iw / 85) ?? 24 * 3600;
  const ticks = [];
  for (let t = Math.ceil(win.start / every) * every; t <= win.end; t += every) {
    const lab = f.time(t);
    ticks.push({ x: x(t), label: lab === '00:00' ? f.day(t) : lab, midnight: lab === '00:00' });
  }
  return { iw, ih, x, ticks, bottom: M.t + ih };
}
const axisX = (fr) => fr.ticks.map((t) => `<line class="gridline" x1="${t.x.toFixed(1)}" x2="${t.x.toFixed(1)}" y1="${M.t}" y2="${fr.bottom}" ${t.midnight ? 'style="stroke:var(--text-3)"' : ''}/><text x="${t.x.toFixed(1)}" y="${fr.bottom + 16}" text-anchor="middle">${esc(t.label)}</text>`).join('');
function axisY(sc, fr, unit, y) {
  let out = '';
  for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step) out += `<line class="gridline" x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${M.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(Number(v.toFixed(3)))}</text>`;
  return `${out}<text x="4" y="${M.t - 7}" class="ylab">${esc(unit)}</text>`;
}
const svg = (inner, height, label) => `<div class="chart dv-chart"><svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet"><g class="axis">${inner}</g></svg></div>`;
const bandRect = (fr, from, to, cls, title) => `<rect class="${cls}" x="${fr.x(from).toFixed(1)}" y="${M.t}" width="${Math.max(2, fr.x(to) - fr.x(from)).toFixed(1)}" height="${fr.ih}"><title>${esc(title)}</title></rect>`;

// The raw cumulative line of a counter, with restarts (dashed red), gaps (grey bands) and refused samples (crosses).
export function counterRawChart(ch, win, tz, rejects = [], markers = { resets: [], gaps: [] }) {
  const pts = ch.data.raw.filter((p) => p.ts >= win.start - 3600 && p.ts <= win.end);
  const f = clock(tz); const H = 190; const fr = frame(win, tz, H);
  if (!pts.length) return '<div class="skeleton">No counter readings in this window.</div>';
  const vals = pts.map((p) => p.v); const sc = niceScale(Math.min(...vals), Math.max(...vals));
  const y = (v) => M.t + fr.ih - ((v - sc.lo) / (sc.hi - sc.lo)) * fr.ih;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${fr.x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const own = (m) => !m.point || m.point === ch.point;
  const gapBands = markers.gaps.filter(own).map((g) => bandRect(fr, g.from, g.to, 'dv-gap', `No readings from ${f.dayTime(g.from)} to ${f.dayTime(g.to)}`)).join('');
  const resets = markers.resets.filter(own).map((r) => `<line class="dv-reset" x1="${fr.x(r.ts).toFixed(1)}" x2="${fr.x(r.ts).toFixed(1)}" y1="${M.t}" y2="${fr.bottom}"><title>The counter restarted at ${esc(f.dayTime(r.ts))}</title></line>`).join('');
  const bad = rejects.filter((r) => r.point === ch.point && r.reason === 'counter_backwards' && r.ts >= win.start && r.ts <= win.end && r.value != null)
    .map((r) => `<g class="dv-cross"><path d="M${(fr.x(r.ts) - 5).toFixed(1)} ${(y(r.value) - 5).toFixed(1)}l10 10m0 -10l-10 10"/><title>Refused at ${esc(f.dayTime(r.ts))}: reading ${r.value}, lower than before and not a restart</title></g>`).join('');
  return svg(`${axisX(fr)}${axisY(sc, fr, ch.unit, y)}${gapBands}${resets}<path class="dv-line c0" d="${d}"/>${bad}`, H, `${ch.label}: the counter over time`);
}

// Energy per period derived from the counter, as bars: restarts amber, gaps hatched.
export function counterEnergyChart(ch, win, tz) {
  const per = ch.data.periods.filter((p) => p.end > win.start && p.start < win.end);
  const H = 170; const fr = frame(win, tz, H); const f = clock(tz);
  if (!per.length) return '<div class="skeleton">No periods derived in this window.</div>';
  const max = Math.max(...per.filter((p) => p.type === 'ok').map((p) => p.value), 0.001, ...per.filter((p) => p.type === 'reset').map((p) => p.value));
  const sc = niceScale(0, max * 1.05);
  const y = (v) => M.t + fr.ih - ((Math.min(v, sc.hi) - sc.lo) / (sc.hi - sc.lo)) * fr.ih;
  const unit = ch.derivedUnit ?? 'kWh';
  const bars = per.map((p) => {
    const x0 = fr.x(p.start); const x1 = fr.x(p.end); const w = Math.max(1, x1 - x0 - (p.type === 'gap' ? 0 : 0.6));
    const cls = p.type === 'reset' ? 'dv-bar reset' : p.type === 'gap' ? 'dv-bar gap' : 'dv-bar';
    const tip = p.type === 'gap' ? `${f.dayTime(p.start)} to ${f.dayTime(p.end)}: ${p.value.toFixed(3)} ${unit} in total, when within the gap it was used is unknown`
      : `${f.time(p.start)} to ${f.time(p.end)}: ${p.value.toFixed(3)} ${unit}${p.type === 'reset' ? ' (only what the counter shows after the restart)' : ''}`;
    return `<rect class="${cls}" x="${x0.toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, fr.bottom - y(p.value)).toFixed(1)}"><title>${esc(tip)}</title></rect>`;
  }).join('');
  return svg(`${axisX(fr)}${axisY(sc, fr, unit, y)}${bars}`, H, `${ch.label}: energy per period derived from the counter`);
}

// An instant series as a line (a step for 0/1), broken at gaps.
export function valueChart(ch, win, tz, idx = 0) {
  const pts = ch.data.points.filter((p) => p.ts >= win.start && p.ts <= win.end);
  const H = 150; const fr = frame(win, tz, H); const f = clock(tz);
  if (!pts.length) return '<div class="skeleton">No readings in this window.</div>';
  const onoff = ch.unit === '0/1';
  const vals = pts.map((p) => p.v);
  const sc = onoff ? { lo: 0, hi: 1, step: 1 } : niceScale(Math.min(...vals), Math.max(...vals));
  const y = (v) => M.t + fr.ih - ((v - sc.lo) / (sc.hi - sc.lo)) * fr.ih;
  const gaps = ch.data.gaps ?? [];
  const inGap = (a, b) => gaps.some((g) => a >= g.from - 1 && b <= g.to + 1);
  let d = '';
  pts.forEach((p, i) => {
    const brk = i === 0 || inGap(pts[i - 1].ts, p.ts);
    if (brk) d += `M${fr.x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`;
    else d += onoff ? `L${fr.x(p.ts).toFixed(1)} ${y(pts[i - 1].v).toFixed(1)}L${fr.x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}` : `L${fr.x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`;
  });
  const bands = gaps.map((g) => bandRect(fr, g.from, g.to, 'dv-gap', `No readings from ${f.dayTime(g.from)} to ${f.dayTime(g.to)}`)).join('');
  const axis = onoff ? `<text x="${M.l - 6}" y="${(y(1) + 4).toFixed(1)}" text-anchor="end">on</text><text x="${M.l - 6}" y="${(y(0) + 4).toFixed(1)}" text-anchor="end">off</text><line class="gridline" x1="${M.l}" x2="${W - M.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : axisY(sc, fr, ch.unit === 'degC' ? '°C' : ch.unit, y);
  return svg(`${axisX(fr)}${axis}${bands}<path class="dv-line c${(idx % 4) + 1}" d="${d}"/>`, H, `${ch.label} over time`);
}

// Events as bands on one lane.
export function eventChart(ch, win, tz) {
  const H = 64; const fr = frame(win, tz, H); const f = clock(tz);
  const ev = ch.data.intervals.filter((e) => e.end > win.start && e.start < win.end);
  const bands = ev.map((e) => bandRect(fr, e.start, Math.max(e.end, e.start + 600), 'dv-event', `${ch.label}: ${f.dayTime(e.start)} to ${f.time(e.end)}`)).join('');
  return svg(`${axisX(fr)}${bands}`, H, `${ch.label}: ${ev.length} event${ev.length === 1 ? '' : 's'}`);
}

// ───────────── What happened, in words ─────────────
export function explanationsHtml(detail, tz) {
  const f = clock(tz);
  const items = [];
  for (const r of detail.markers.resets) items.push(`<li><b>Restart.</b> The counter <span class="mono">${esc(r.point ?? '')}</span> restarted at ${esc(f.dayTime(r.ts))}. The period that ends there carries only what the counter shows after the restart, and is marked partial: the energy used between the last reading and the restart is unknown, not invented.</li>`);
  for (const g of detail.markers.gaps.filter((x) => x.point)) items.push(`<li><b>Gap.</b> No readings from ${esc(f.dayTime(g.from))} to ${esc(f.dayTime(g.to))}${g.point ? ` for <span class="mono">${esc(g.point)}</span>` : ''}. ${detail.channels.some((c) => c.point === g.point && c.kind === 'counter') ? 'The counter keeps its exact total across the gap; when in the gap the energy was used is unknown, so that period is marked estimated.' : 'The line is broken here: nothing is drawn where nothing was received.'}</li>`);
  for (const r of detail.rejects.filter((x) => x.reason === 'counter_backwards')) items.push(`<li><b>Refused reading.</b> A reading of ${esc(r.value)} at ${esc(f.dayTime(r.ts))} on <span class="mono">${esc(r.point)}</span> was refused: the counter went down, which is neither a restart nor a wrap. It was kept in the list of refused values and never stored as data. The energy of the period around it is worked out from the readings either side of it, so that one period covers the time up to the next good reading.</li>`);
  for (const r of detail.rejects.filter((x) => x.reason === 'unmapped_point')) items.push(`<li><b>Unmapped point.</b> The device sent <span class="mono">${esc(r.point)}</span>, which no channel maps. It was reported, not stored.</li>`);
  return items.length ? `<ul class="dv-explain-list">${items.join('')}</ul>` : '<p class="ob-note">Nothing unusual in this window: no restarts, gaps or refused readings.</p>';
}

// ───────────── Detail panels ─────────────
export function channelsTable(detail, tz) {
  const f = clock(tz);
  const rows = [...(detail.channelList ?? detail.channels), ...detail.settings.map((s) => ({ ...s, kind: 'value', metric: '', label: s.label, unit: s.unit, last: { value: s.value, ts: s.ts, word: s.word }, rejected: 0, source: '', setting: true }))];
  if (!rows.length) return '<p class="ob-note">This device has no channels yet.</p>';
  const multi = new Set(rows.map((r) => r.source).filter(Boolean)).size > 1;   // the same point under two sources: say which is which
  return `<div class="table-wrap"><table><thead><tr><th>Point</th><th>Becomes</th><th>Kind</th><th>Last value</th><th>When</th><th class="r">Refused</th></tr></thead><tbody>${rows.map((c) => `<tr>
    <td class="mono">${c.point ? esc(c.point) : '<span class="faint">no channel</span>'}</td>
    <td>${esc(c.label)}${multi && c.source ? ` <span class="faint">via ${esc(c.source)}</span>` : ''}${c.derivedMetric ? ` <span class="faint">→ energy per period</span>` : ''}${c.part && c.part !== 'all' ? ` <span class="ob-tag">${esc(c.part)} part</span>` : ''}</td>
    <td><span class="badge ${c.kind === 'counter' ? 'info' : c.kind === 'event' ? 'warn' : ''}">${esc(c.setting ? 'setting' : c.kind)}</span></td>
    <td>${c.last?.value == null && !c.last?.event ? '<span class="faint">none yet</span>' : esc(c.setting ? settingText({ ...c, value: c.last.value, word: c.last.word }) : (c.last.word ?? (c.kind === 'event' ? 'happened' : num(c.last.value, c.unit))))}</td>
    <td>${c.last?.ts ? esc(f.dayTime(c.last.ts)) : ''}</td>
    <td class="r">${c.rejected ? `<span class="badge bad">${c.rejected}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function rejectsPanel(detail, tz) {
  const f = clock(tz);
  const WORDS = { counter_backwards: 'the counter went down (not a restart)', unmapped_point: 'a point no channel maps', out_of_range: 'outside the allowed range', not_a_number: 'not a number', future_timestamp: 'dated in the future' };
  if (!detail.rejects.length) return '<p class="ob-note">Nothing was refused for this device in this window.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Point</th><th>Value</th><th>When</th><th>Why it was refused</th></tr></thead><tbody>${detail.rejects.map((r) => `<tr><td class="mono">${esc(r.point)}</td><td>${r.value == null ? '' : esc(r.value)}</td><td>${r.reason === 'unmapped_point' ? '' : esc(f.dayTime(r.ts))}</td><td>${esc(WORDS[r.reason] ?? r.reason)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function chartsHtml(detail, tz) {
  const win = detail.window;
  const out = [];
  let idx = 0;
  for (const ch of detail.channels) {
    if (!ch.data) continue;
    const head = `<div class="dv-chart-head"><h3>${esc(ch.label)}</h3><span class="faint mono">${ch.point ? esc(ch.point) : esc(ch.metric)}</span><span class="badge ${ch.kind === 'counter' ? 'info' : ch.kind === 'event' ? 'warn' : ''}">${esc(ch.kind)}</span></div>`;
    if (ch.kind === 'counter') {
      out.push(`<section class="dv-chart-block">${head}
        <p class="dv-sub">The line is the running total as the device reports it (${esc(ch.unit)}). The bars below are the energy of each period, worked out by subtracting the previous reading.</p>
        ${counterRawChart(ch, win, tz, detail.rejects, detail.markers)}
        <div class="legend"><span><i class="line" style="color:var(--grid)"></i>Counter reading</span><span><i class="swatch" style="background:var(--text-3);opacity:.35"></i>No readings</span><span><i class="dash" style="color:var(--bad)"></i>Counter restarted</span><span><span class="dv-x">✕</span> Refused reading</span></div>
        ${counterEnergyChart(ch, win, tz)}
        <div class="legend"><span><i class="swatch" style="background:var(--battery)"></i>Energy in the period</span><span><i class="swatch" style="background:var(--solar)"></i>Period around a restart (partial)</span><span><i class="swatch dv-hatch"></i>Spans a gap (estimated)</span></div></section>`);
    } else if (ch.kind === 'event') {
      out.push(`<section class="dv-chart-block">${head}<p class="dv-sub">Each band is one event: it has a start and an end and is never added up.</p>${eventChart(ch, win, tz)}</section>`);
    } else {
      out.push(`<section class="dv-chart-block">${head}${valueChart(ch, win, tz, idx++)}</section>`);
    }
  }
  return out.join('') || '<p class="ob-note">No data to draw for this device in this window.</p>';
}

// ───────────── Data in action: what the pipeline did with a reading ─────────────
export function pipelineHtml(sim, tz) {
  const f = clock(tz);
  if (!sim) return '';
  if (!sim.steps.length) return `<div class="ob-msg warn" role="status"><div>${esc(sim.note ?? 'Nothing was added.')}</div></div>`;
  const rows = sim.steps.map((s) => {
    const recv = `${esc(s.point)} = <b>${s.received == null ? 'event' : esc(s.received)}</b>`;
    const tr = `${esc(s.channel.metric)}${s.channel.part !== 'all' ? `, ${esc(s.channel.part)} part` : ''}${s.channel.scale !== 1 ? `, × ${esc(s.channel.scale)}` : ''}`;
    const st = s.stored ? (s.kind === 'counter' ? `reading <b>${esc(s.stored.value)}</b> (before: ${s.stored.previous == null ? 'none' : esc(s.stored.previous)})` : s.kind === 'event' ? 'event period stored' : `reading <b>${esc(s.stored.value)}</b>`) : 'not stored';
    const dv = s.derived ? `<b>${esc(Number(s.derived.value).toFixed(4))}</b> kWh over ${esc(f.time(s.derived.start))} to ${esc(f.time(s.derived.end))}${s.kind === 'counter' && s.stored.previous != null ? ` <span class="faint">(${esc(s.stored.value)} − ${esc(s.stored.previous)})</span>` : ''}${s.derived.partial ? ' <span class="badge warn">partial</span>' : ''}${s.derived.estimated ? ' <span class="badge">estimated</span>' : ''}` : '<span class="faint">no energy to derive</span>';
    return `<tr class="dv-pipe-row"><td class="mono">${esc(s.point)}</td><td class="dv-st" data-stage="1">${recv}</td><td class="dv-st" data-stage="2">${esc(tr)}</td><td class="dv-st" data-stage="3">${st}</td><td class="dv-st" data-stage="4">${dv}</td></tr>`;
  }).join('');
  return `<div class="ob-msg good" role="status"><div>Added ${sim.added} period${sim.added === 1 ? '' : 's'}${sim.to ? `, up to ${esc(f.dayTime(sim.to))}` : ''}. ${esc(sim.note ?? '')} Here is what happened to each reading of the last period.</div></div>
    <div class="table-wrap dv-pipe"><table><thead><tr><th>Point</th><th>1 Received</th><th>2 Translated by the channel</th><th>3 Stored</th><th>4 Energy derived</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ───────────── Control ─────────────
export function settingsHtml(detail) {
  if (!detail.settings.length) return '';
  return `<div class="table-wrap"><table><thead><tr><th>Setting the device reports</th><th>Value</th></tr></thead><tbody>${detail.settings.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.value == null ? '<span class="faint">none yet</span>' : esc(settingText(s))}</td></tr>`).join('')}</tbody></table></div>`;
}
export function commandPathHtml(resp) {
  if (!resp) return '';
  if (!resp.written) return `<div class="ob-msg warn" role="status"><div>No command was queued: ${esc(resp.reason ?? 'nothing changed')}.${(resp.blocks ?? []).map((b) => ` ${esc(b.gate)}`).join('')}</div></div>`;
  return `<ol class="dv-path" aria-label="The path of the command">${resp.path.map((p) => `<li class="${p.failed ? 'bad' : p.done ? 'done' : ''}" data-step="${esc(p.key)}"><i aria-hidden="true">${p.failed ? '✕' : p.done ? '✓' : '·'}</i><span>${esc(p.label)}${p.failed ? ' (not seen)' : ''}</span></li>`).join('')}</ol>
    <p class="ob-note">Target: charge to <b>${esc(resp.target)} %</b>. The command is confirmed only when the device itself reports the new setting, never because the core sent it.</p>`;
}
export function commandsTable(detail, tz) {
  const f = clock(tz);
  if (!detail.commands.length) return '<p class="ob-note">No command has been sent to this device yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Action</th><th>Target</th><th>Sent</th><th>Status</th><th>Effect</th></tr></thead><tbody>${detail.commands.map((c) => `<tr><td>${c.id}</td><td>${esc(c.action)}</td><td>${c.desired?.limit_pct != null ? `${esc(c.desired.limit_pct)} %` : ''}</td><td>${c.sentAt ? esc(f.dayTime(Math.floor(c.sentAt / 1000))) : ''}</td>
    <td><span class="badge ${c.status === 'acked' ? 'good' : c.status === 'failed' || c.status === 'expired' ? 'bad' : ''}">${esc(c.status)}</span></td>
    <td>${c.verifyStatus ? `<span class="badge ${c.verifyStatus === 'verified' ? 'good' : 'warn'}">${esc(c.verifyStatus.replace('_', ' '))}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}


// ───────────── Pushes: connect a real device, and the log of what arrived ─────────────
export const emulatedLine = () => `<p class="dv-synline"><span class="badge origin origin-synthetic">Emulated</span> This device is fed by the push emulator: its data is generated, but it reached the core through the real push endpoint, the same way a real plug's would.</p>`;

const PUSH_ERRORS = {
  unknown_device: 'No device with that reference. Send "register": true (and a "kind") to create it.',
  unknown_kind: 'That kind of device does not exist.', kind_required: 'To register a device the push must say what it is ("kind").',
  site_required: 'The push did not say which home it is for.', unknown_site: 'There is no such home.',
  bad_value: 'A value was not a number.', bad_timestamp: 'A time could not be read.', bad_point: 'A point name was not valid.', bad_observation: 'An observation was malformed.',
  malformed_json: 'The body was not valid JSON (it was kept as a quarantined receipt).', bad_body: 'The body was not a JSON object.', no_observations: 'The body held no observations.',
  unrecognised_shape: 'The body did not look like the format it was sent as (kept as a quarantined receipt).', nothing_to_store: 'None of the readings could be stored.',
  too_many_observations: 'More observations than one push may hold.', unknown_command: 'An acknowledgement named a command this home never sent.',
  synthetic_device: 'That is a synthetic demo device: the demo generator feeds it, not pushes.', unknown_format: 'The format is not one this core reads.', unknown_source: 'The source is not described in this core.',
  internal: 'The core failed to store this push.',
};
export const pushErrorWords = (code, fallback = '') => PUSH_ERRORS[code] ?? fallback;

/** One log row in plain words: what was stored, what was repeated, what had no channel, what was refused. */
export function pushSummary(p) {
  if (p.status === 'rejected') return `Refused. ${pushErrorWords(p.errorCode, p.error ?? '')}`;
  if (p.status === 'error') return `The core failed to store it. ${p.error ?? ''}`;
  const parts = [];
  if (p.written > 0) parts.push(`${p.written} stored${p.derived ? ` (${p.derived} energy period${p.derived === 1 ? '' : 's'} worked out)` : ''}`);
  if (p.forecasts > 0) parts.push(`${p.forecasts} forecast${p.forecasts === 1 ? '' : 's'} stored`);
  if (!p.written && !p.forecasts) parts.push(p.warnings?.some((w) => /received before/.test(w)) ? 'Nothing new: this exact body had already been received' : 'Nothing new stored');
  if (p.unmapped > 0) parts.push(`${p.unmapped} point${p.unmapped === 1 ? '' : 's'} with no channel (reported, not stored)`);
  if (p.rejected > 0) parts.push(`${p.rejected} reading${p.rejected === 1 ? '' : 's'} refused by the channel rules`);
  return parts.join('; ');
}

/** The first curl a person can paste: filled in with this home and, for a selected device, its reference and its real points. */
export function curlExample({ origin, connect, siteId, device = null, points = [], now = Math.floor(Date.now() / 1000) }) {
  const sample = (pt) => (/energy|total|counter/.test(pt) ? 12.5 : /power/.test(pt) ? 120 : /relay|on$/.test(pt) ? 1 : /temp/.test(pt) ? 20.5 : 1);
  const kind = device?.kind && device.kind !== 'inverter' ? device.kind : 'smart_plug';
  const pts = (points.length ? points : ['power', 'energy_total']).slice(0, 4);
  const body = { site: siteId, device: device?.ref ?? 'my-plug', register: true, kind, label: device?.label ?? 'My plug', observations: pts.map((pt) => ({ point: pt, ts: now, value: sample(pt) })) };
  return `curl -X POST '${origin}${connect.endpoint}' \\
  -H 'Content-Type: application/json' \\${connect.tokenRequired ? "\n  -H 'Authorization: Bearer YOUR_TOKEN' \\" : ''}
  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
}

export function connectHtml({ connect, origin, siteId, device = null, points = [], now }) {
  const url = `${origin}${connect.endpoint}`;
  const example = curlExample({ origin, connect, siteId, device, points, now });
  const ref = device?.ref ?? '<device>';
  return `<div class="dv-connect-body">
    <p class="ob-note">A real device, a gateway, or a script sends its readings to this address. They go through the same channels, counters and rules as every other provider, and every push is listed in the log.</p>
    <dl class="dv-facts">
      <div><dt>Address</dt><dd><span class="mono" id="dv-url">${esc(url)}</span></dd></div>
      <div><dt>Home</dt><dd>send <span class="mono">"site": ${esc(siteId)}</span> (or <span class="mono">?site=${esc(siteId)}</span>)</dd></div>
      <div><dt>Token</dt><dd>${connect.tokenRequired
        ? '<span class="badge good">Required</span> send <span class="mono">Authorization: Bearer &lt;token&gt;</span> or <span class="mono">X-Ingest-Token</span>'
        : '<span class="badge warn">Not required</span> this address is <b>open</b>: anyone who can reach it can send data. Set the environment variable <span class="mono">INGEST_TOKEN</span> to require a token.'}</dd></div>
      <div><dt>Limits</dt><dd>${esc(connect.maxObservations)} observations and ${esc(Math.round(connect.maxBytes / 1024 / 1024))} MB per push</dd></div>
    </dl>
    <h4 class="dv-h4">${device ? `Send readings as ${esc(device.label)}` : 'A first push to try'}</h4>
    <div class="dv-code-wrap"><pre class="dv-code" id="dv-curl" tabindex="0" aria-label="A curl command to copy">${esc(example)}</pre>
      <button class="btn btn-sm" id="dv-copy" type="button">Copy</button><span class="ob-note dv-copied" id="dv-copied" role="status"></span></div>
    <p class="ob-note">A device that is not known yet is created by its first push because of <span class="mono">"register": true</span> (it needs a <span class="mono">kind</span> such as smart_plug). Times are epoch seconds or ISO 8601; a number above 1e11 is read as milliseconds and the push says so.</p>
    <details class="ob-details"><summary>Formats the core reads (${connect.formats.length})</summary>
      <div class="table-wrap"><table><thead><tr><th>Format</th><th>What it is</th><th>Points</th></tr></thead><tbody>${connect.formats.map((f) => `<tr><td class="mono">${esc(f.id)}</td><td>${esc(f.about)}${f.id === 'native' ? '' : ` <span class="faint">Add <span class="mono">?format=${esc(f.id)}&amp;device=${esc(ref)}&amp;register=1&amp;kind=smart_plug</span> to the address.</span>`}</td><td class="mono">${f.points.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div>
      <p class="ob-note">The Shelly, Tasmota and Home Assistant shapes follow those products' documentation. They have <b>not</b> been tried on a real device.</p></details>
    <details class="ob-details"><summary>Have an MQTT broker?</summary>
      <p class="ob-note">The core has no MQTT client. Put one in front of it: a Node-RED flow, a Home Assistant automation, or <span class="mono">mosquitto_sub</span> piped to <span class="mono">curl</span> can post each message to the address above.</p></details>
  </div>`;
}

export function pushLogHtml(pushes, tz) {
  const f = clock(tz);
  if (!pushes.length) return '<p class="ob-note">Nothing has been pushed to this core yet. Paste the command on the left, or run <span class="mono">npm run demo:push</span> to send readings from the emulator.</p>';
  // a list, not a table, so each push wraps to the width of a phone: who and when, the result, what the core did
  return `<ul class="dv-pushes" aria-label="Pushes received, newest first">${pushes.map((p) => {
    const cls = p.status !== 'ok' ? 'bad' : (p.unmapped || p.rejected) ? 'warn' : '';
    const label = p.status === 'ok' ? ((p.unmapped || p.rejected) ? 'stored, with notes' : 'stored') : p.status === 'rejected' ? 'refused' : 'error';
    const notes = (p.warnings ?? []).filter((w) => !/^registered a new/.test(w)).slice(0, 2);
    // a refused push has no device row: the name the sender used is in the error text
    const named = p.errorCode === 'unknown_device' ? /No device "([^"]+)"/.exec(p.error ?? '')?.[1] : null;
    const who = p.device ? esc(p.device) : p.deviceRef ? esc(p.deviceRef) : named ? `${esc(named)} <span class="faint">(not found)</span>` : p.unassigned ? '<span class="faint">no home</span>' : '<span class="faint">the home</span>';
    return `<li class="dv-push ${cls}"><div class="dv-push-head"><b class="dv-who">${who}</b><span class="badge ${p.status === 'ok' ? (cls === 'warn' ? 'warn' : 'good') : 'bad'}">${esc(label)}</span></div>
      <div class="dv-when">${esc(f.dayTime(Math.floor(p.at / 1000)))}${p.format ? ` · <span class="mono">${esc(p.format)}</span>` : ''}</div>
      <div class="dv-did">${esc(pushSummary(p))}${(p.warnings ?? []).some((w) => /^registered a new/.test(w)) ? ' <span class="badge info">device registered</span>' : ''}</div>
      ${notes.length ? `<ul class="dv-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</li>`;
  }).join('')}</ul>`;
}
