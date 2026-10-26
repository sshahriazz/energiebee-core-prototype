// Timeline tab: the stored slot timeline (one row per slot) for a day or a range. Choose columns or a
// preset; each unit gets its own chart (never two y-axes on one chart), on a background coloured by the
// slot's state (final / provisional / missing, also given in words), then a table. A bar, a point or a
// table row opens that slot in the Slot inspector.
import {
  ctx, get, ep, loading, emptyBox, errorBox, loadOverview, count, T, esc, writeHash, readHash, addDays, dayDiff, lastDays, dateBounds,
  val, num, pagerHtml, qualityWords, stateBadge, stateLegend, slotHref, STATE, slotNoun, slotNouns, loadVariables, unitLabel,
} from './util.js';
import { lineChart, stackedBars, legendHtml, tipHtml } from './charts.js';

export const PRESETS = {
  flows: { label: 'Energy flows', mode: 'stacked', note: 'Who fed whom: every kWh that moved, by route. Bars are stacked, so a bar is all the energy moved in that slot.', cols: ['solar_to_home', 'battery_to_home', 'grid_to_home', 'solar_to_battery', 'grid_to_battery', 'solar_to_grid', 'battery_to_grid'] },
  money: { label: 'Money', mode: 'lines', note: 'What each slot cost, what it would have cost from the grid alone, and the saving.', cols: ['total_cost', 'grid_only_cost', 'saving', 'export_credit', 'standing_cost'] },
  battery: { label: 'Battery', mode: 'lines', note: 'Energy into and out of the battery, and how full it was.', cols: ['battery_charge', 'battery_discharge', 'soc_end'] },
  prices: { label: 'Prices & carbon', mode: 'lines', note: 'Import price with and without tax, the export price, and how much carbon the grid emitted per kWh.', cols: ['import_rate', 'import_rate_ex', 'export_rate', 'carbon_intensity'] },
  quality: { label: 'Quality', mode: 'lines', note: 'How far the smart meter and the inverter clamp disagree, the energy lost or unexplained, and whether a price was found. The background and the table show each slot\'s state and quality flags.', cols: ['meter_vs_ct', 'loss', 'rate_found'] },
};
const MAX_DAYS = 31;

// Colour follows the column, never its position: sources by their own colour, routes by where the energy came from.
const tint = (c, p) => `color-mix(in srgb, ${c} ${p}%, var(--surface))`;
const KNOWN = {
  solar: 'var(--solar)', solar_forecast: 'var(--ev)', solar_to_home: 'var(--solar)', solar_to_battery: tint('var(--solar)', 62), solar_to_grid: tint('var(--solar)', 36),
  battery_charge: 'var(--battery)', battery_discharge: tint('var(--battery)', 55), battery_to_home: 'var(--battery)', battery_to_grid: tint('var(--battery)', 45), soc_end: 'var(--battery)',
  grid_import: 'var(--grid)', grid_to_home: 'var(--grid)', grid_to_battery: tint('var(--grid)', 55), grid_export: 'var(--export)', export_rate: 'var(--export)', import_rate: 'var(--grid)', import_rate_ex: tint('var(--grid)', 55),
  home: 'var(--text-2)', loss: 'var(--text-3)', ev: 'var(--ev)', gas: 'var(--gas)', carbon_intensity: 'var(--text-2)', carbon_g: 'var(--text-2)', outdoor_temp: 'var(--gas)',
  total_cost: 'var(--grid)', grid_only_cost: 'var(--text-3)', saving: 'var(--battery)', export_credit: 'var(--export)', standing_cost: 'var(--ev)',
  meter_vs_ct: 'var(--grid)', rate_found: 'var(--text-2)',
};
const FALLBACK = ['var(--grid)', 'var(--solar)', 'var(--battery)', 'var(--export)', 'var(--ev)', 'var(--gas)', 'var(--text-2)', 'var(--text-3)'];
export function colorsFor(names) {
  const used = new Set(); const out = {};
  for (const n of names) { const c = KNOWN[n]; if (c && !used.has(c)) { out[n] = c; used.add(c); } }
  for (const n of names) if (!out[n]) { const c = FALLBACK.find((x) => !used.has(x)) || 'var(--text-3)'; out[n] = c; used.add(c); }
  return out;
}
export const humanCol = (name) => String(name).replace(/_ex$/, ' (before VAT)').replace(/_to_/g, ' → ').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/\bhome\b/i, 'house');

let built = false;
const s = { from: '', to: '', preset: 'flows', cols: [], mode: 'stacked', page: 0 };
let data = null; let vars = null;
export function reset() { built = false; Object.assign(s, { from: '', to: '', preset: 'flows', cols: [], mode: 'stacked', page: 0 }); data = null; vars = null; }
export const hashState = () => ({ value: '', params: { from: s.from, to: s.to, preset: s.preset, cols: s.preset === 'custom' ? s.cols.join(',') : '', mode: PRESETS[s.preset]?.mode === s.mode ? '' : s.mode } });
const keepHash = () => { if (readHash().tab === 'timeline') writeHash('timeline', '', hashState().params); };

const timelineVars = () => (vars || []).filter((v) => v.source === 'timeline' || v.source == null);
const labelOf = (name) => data?.cols?.find((c) => c.name === name)?.label || timelineVars().find((v) => v.name === name)?.label || humanCol(name);
const presetCols = (k) => { const c = PRESETS[k]?.cols || []; const known = timelineVars().map((v) => v.name); return known.length ? c.filter((n) => known.includes(n)) : c; };

function chooserHtml() {
  const list = timelineVars();
  if (!list.length) return '<p class="faint">The list of columns could not be loaded; the presets still work.</p>';
  const byKind = new Map();
  for (const v of list) { const k = v.kind || 'other'; if (!byKind.has(k)) byKind.set(k, []); byKind.get(k).push(v); }
  return `<div class="xp-colgroups">${[...byKind.entries()].map(([k, vs]) => `<fieldset><legend>${esc(humanCol(k))}</legend>${vs.map((v) => `<label><input type="checkbox" name="col" value="${esc(v.name)}" ${s.cols.includes(v.name) ? 'checked' : ''}> ${esc(v.label || humanCol(v.name))} <span class="faint">${esc(unitLabel(v.unit))}</span></label>`).join('')}</fieldset>`).join('')}</div>`;
}

function controlsHtml() {
  return `<div class="xp-controls" id="tl-form">
      <label>From<input type="date" id="tl-from" value="${esc(s.from)}" ${dateBounds()}></label>
      <label>To<input type="date" id="tl-to" value="${esc(s.to)}" ${dateBounds()}></label>
      <span class="xp-btnrow"><button type="button" class="btn" data-shift="-1">← Earlier</button><button type="button" class="btn" data-shift="1">Later →</button></span>
      <label>Draw as<select id="tl-mode"><option value="lines">Lines</option><option value="stacked">Stacked bars</option></select></label>
    </div>
    <div class="segmented xp-presets" role="group" aria-label="Column presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" data-preset="${k}" aria-pressed="${s.preset === k}">${esc(p.label)}</button>`).join('')}<button type="button" data-preset="custom" aria-pressed="${s.preset === 'custom'}">My columns</button></div>
    <details class="xp-details" id="tl-cols-box"><summary>Choose columns (<span id="tl-ncols">${s.cols.length}</span> chosen)</summary><div id="tl-cols">${chooserHtml()}</div></details>`;
}

function syncControls(panel) {
  panel.querySelector('#tl-from').value = s.from;
  panel.querySelector('#tl-to').value = s.to;
  panel.querySelector('#tl-mode').value = s.mode;
  panel.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === s.preset)));
  panel.querySelectorAll('#tl-cols input[name="col"]').forEach((c) => { c.checked = s.cols.includes(c.value); });
  panel.querySelector('#tl-ncols').textContent = String(s.cols.length);
}

async function load(panel) {
  const box = panel.querySelector('#tl-out');
  if (!s.from || !s.to) { box.innerHTML = emptyBox('This home has no data', 'There are no days to show yet.'); return; }
  if (!s.cols.length) { box.innerHTML = emptyBox('No columns chosen', 'Pick a preset, or tick some columns.'); return; }
  const days = dayDiff(s.from, s.to) + 1;
  const limit = days * Math.ceil(86400 / ctx.slotS) + days * 4;
  box.innerHTML = loading(`Loading ${days === 1 ? 'the day' : `${days} days`}…`);
  try { data = await get(ep('timeline', { from: s.from, to: s.to, cols: s.cols.join(','), limit })); } catch (err) { box.innerHTML = errorBox('The timeline could not be loaded', err); return; }
  if (data.slot_s && data.slot_s !== ctx.slotS) ctx.slotS = data.slot_s;
  s.page = Math.min(s.page, 9999);
  draw(panel, limit);
}

function draw(panel, limit) {
  const box = panel.querySelector('#tl-out');
  const rows = data?.rows || [];
  if (!rows.length) { box.innerHTML = emptyBox('No slots in this range', `This home has no ${esc(slotNouns())} between ${esc(T.date(s.from))} and ${esc(T.date(s.to))}. Its data runs from ${esc(T.date(ctx.overview?.range?.first_date))} to ${esc(T.date(ctx.overview?.range?.last_date))}.`); return; }
  const cols = (data.cols?.length ? data.cols : s.cols.map((n) => ({ name: n, unit: '', kind: '' })));
  const units = new Map();
  for (const c of cols) { if (c.unit === 'bits') continue; const k = c.unit === 'fraction' || c.unit === 'ratio' ? '%' : c.unit === '0/1' || c.unit === 'flag' ? 'yes (1) or no (0)' : unitLabel(c.unit) || '(no unit)'; if (!units.has(k)) units.set(k, []); units.get(k).push(c); }
  const counts = rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
  const pageSize = Math.min(96, Math.round(86400 / ctx.slotS));
  const pages = Math.ceil(rows.length / pageSize);
  s.page = Math.max(0, Math.min(s.page, pages - 1));
  const pre = PRESETS[s.preset];
  box.innerHTML = `
    <p class="xp-count" role="status">${count(rows.length)} ${esc(slotNouns())} from ${esc(T.date(s.from))} to ${esc(T.date(s.to))}: ${Object.keys(STATE).map((k) => `${count(counts[k] || 0)} ${esc(STATE[k][1].toLowerCase())}`).join(', ')}.${rows.length >= limit ? ' <b>Only the first ones are shown: pick a shorter range.</b>' : ''}</p>
    ${pre?.note ? `<p class="xp-foot">${esc(pre.note)}</p>` : ''}
    <div id="tl-charts">${[...units.keys()].map((u, i) => `<section class="xp-chartbox" aria-label="${esc(u)} chart"><div id="tl-leg-${i}"></div><div id="tl-chart-${i}"></div></section>`).join('')}</div>
    ${stateLegend()}
    <p class="xp-foot">Select a bar or point (or focus a chart and press Enter) to open that ${esc(slotNoun())} in the Slot inspector.</p>
    <h3 class="xp-h3">The rows</h3>
    <div class="table-wrap xp-scroll"><table class="xp-table xp-tltable"><caption class="sr-only">Timeline rows; open one to inspect that ${esc(slotNoun())}</caption>
      <thead><tr><th scope="col">${esc(slotNoun().replace(/^./, (c) => c.toUpperCase()))}</th><th scope="col">State</th><th scope="col">Quality</th>${cols.map((c) => `<th scope="col" class="r">${esc(labelOf(c.name))}${c.unit && c.unit !== 'bits' && unitLabel(c.unit) ? ` <span class="faint">${esc(unitLabel(c.unit))}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(s.page * pageSize, (s.page + 1) * pageSize).map((r) => `<tr class="clickable" tabindex="0" data-slot="${esc(r.slot_start)}" aria-label="${esc(`${T.dayTime(r.slot_start)}, ${STATE[r.state]?.[1] || r.state}: open in the Slot inspector`)}">
        <td><a class="xp-link" href="${esc(slotHref(r.slot_start))}" tabindex="-1">${esc(T.dayTime(r.slot_start))}</a></td><td>${stateBadge(r.state)}</td><td>${esc(qualityWords(r.quality))}</td>
        ${cols.map((c) => `<td class="r">${c.unit === 'bits' ? esc(String(r[c.name] ?? '–')) : val(r[c.name], ['ratio', 'fraction', 'flag', '0/1'].includes(c.unit) ? c.unit : '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${pagerHtml(s.page, pages, 'rows')}`;
  const bands = rows.map((r) => ({ from: r.slot_start, to: r.slot_start + (r.dur_s || ctx.slotS), state: r.state }));
  const domain = [rows[0].slot_start, rows[rows.length - 1].slot_start + (rows[rows.length - 1].dur_s || ctx.slotS)];
  const pick = (t) => { location.hash = slotHref(t); };
  [...units.entries()].forEach(([u, cs], i) => {
    const colors = colorsFor(cs.map((c) => c.name));
    const stacked = s.mode === 'stacked';
    const label = `${cs.map((c) => labelOf(c.name)).join(', ')} (${u})`;
    // A tint reads well as a filled bar but too faint as a line: lines take the base colour and a dash instead.
    const line = (c) => { const base = /^color-mix/.test(colors[c]) ? colors[c].match(/var\(--[a-z0-9-]+\)/)?.[0] : null; return base ? { color: base, dash: true } : { color: colors[c], dash: false }; };
    panel.querySelector(`#tl-leg-${i}`).innerHTML = `<h3 class="xp-charth">${esc(u === '(no unit)' ? 'No unit' : u)}</h3>${legendHtml(cs.map((c) => (stacked ? { label: labelOf(c.name), color: colors[c.name], type: 'box' } : { label: labelOf(c.name), color: line(c.name).color, type: line(c.name).dash ? 'dash' : 'line' })))}`;
    const host = panel.querySelector(`#tl-chart-${i}`);
    const unit = u === '(no unit)' || u.startsWith('yes') ? '' : u;
    const scale = (c) => (c.unit === 'fraction' || c.unit === 'ratio' ? 100 : 1);
    const tip = (t, r0) => {
      const r = r0 || rows.find((x) => x.slot_start === t);
      if (!r) return '';
      return tipHtml(`${esc(T.dayTime(t))} <span class="badge ${STATE[r.state]?.[0] || ''}">${esc(STATE[r.state]?.[1] || r.state)}</span>`, cs.map((c) => [esc(labelOf(c.name)), colors[c.name], r[c.name] == null ? 'none' : `${num(r[c.name] * scale(c))} ${esc(unit)}`]), 'Click or press Enter to inspect');
    };
    if (stacked) {
      stackedBars(host, { rows: rows.map((r) => ({ ...r, t: r.slot_start, dur: r.dur_s || ctx.slotS })), series: cs.map((c) => ({ key: c.name, label: labelOf(c.name), color: colors[c.name], get: (r) => (r[c.name] == null ? null : r[c.name] * scale(c)) })), unit, bands, domain, sync: 'tl', label, tip, onPick: pick, height: 220 });
    } else {
      const mid = (r) => r.slot_start + (r.dur_s || ctx.slotS) / 2;
      const byMid = new Map(rows.map((r) => [mid(r), r]));
      lineChart(host, { series: cs.map((c) => ({ key: c.name, label: labelOf(c.name), ...line(c.name), points: rows.map((r) => ({ t: mid(r), v: r[c.name] == null ? null : r[c.name] * scale(c) })) })), unit, bands, domain, sync: 'tl', label, gap: ctx.slotS * 1.5, zero: true, height: 220,
        tip: (t) => { const r = byMid.get(t); return r ? tip(r.slot_start, r) : ''; }, onPick: (t) => { const r = byMid.get(t); if (r) pick(r.slot_start); } });
    }
  });
}

export async function show(panel, h) {
  const p = h?.params || new URLSearchParams();
  if (!built) {
    built = true;
    panel.innerHTML = loading('Loading…');
    try { await loadOverview(); } catch { /* fall back to the home's days */ }
    try { vars = await loadVariables(); } catch { vars = []; }
    const d = lastDays(1);
    s.from = d.from; s.to = d.to;
    panel.innerHTML = `<p class="xp-lead">The stored timeline: one row per ${esc(slotNoun())}, worked out from the facts. Each chart has one unit; the background shows whether a ${esc(slotNoun())} is final, provisional or missing.</p>
      ${controlsHtml()}<div id="tl-out"></div>`;
    wire(panel);
  }
  const want = {
    from: p.get('from') || s.from, to: p.get('to') || p.get('from') || s.to,
    preset: PRESETS[p.get('preset')] || p.get('preset') === 'custom' ? p.get('preset') : (p.get('cols') ? 'custom' : s.preset),
  };
  if (want.preset !== 'custom') { want.cols = presetCols(want.preset); want.mode = p.get('mode') || PRESETS[want.preset].mode; } else { want.cols = (p.get('cols') || s.cols.join(',')).split(',').filter(Boolean); want.mode = p.get('mode') || s.mode || 'lines'; }
  if (want.from > want.to) [want.from, want.to] = [want.to, want.from];
  if (dayDiff(want.from, want.to) >= MAX_DAYS) want.from = addDays(want.to, -(MAX_DAYS - 1));
  const changed = !data || ['from', 'to', 'preset', 'mode'].some((k) => want[k] !== s[k]) || want.cols.join() !== s.cols.join();
  if (!changed) return;
  if (want.from !== s.from || want.to !== s.to) s.page = 0;
  Object.assign(s, want);
  syncControls(panel);
  await load(panel);
}

function wire(panel) {
  const reload = () => { keepHash(); syncControls(panel); load(panel); };
  panel.querySelector('#tl-from').addEventListener('change', (e) => { if (!e.target.value) return; s.from = e.target.value; if (s.to < s.from) s.to = s.from; if (dayDiff(s.from, s.to) >= MAX_DAYS) s.to = addDays(s.from, MAX_DAYS - 1); s.page = 0; reload(); });
  panel.querySelector('#tl-to').addEventListener('change', (e) => { if (!e.target.value) return; s.to = e.target.value; if (s.from > s.to) s.from = s.to; if (dayDiff(s.from, s.to) >= MAX_DAYS) s.from = addDays(s.to, -(MAX_DAYS - 1)); s.page = 0; reload(); });
  panel.querySelector('#tl-mode').addEventListener('change', (e) => { s.mode = e.target.value; keepHash(); if (data) draw(panel, Infinity); });
  panel.addEventListener('click', (e) => {
    const sh = e.target.closest('button[data-shift]');
    if (sh) { const n = (dayDiff(s.from, s.to) + 1) * Number(sh.dataset.shift); s.from = addDays(s.from, n); s.to = addDays(s.to, n); s.page = 0; reload(); return; }
    const pr = e.target.closest('button[data-preset]');
    if (pr) {
      s.preset = pr.dataset.preset;
      if (s.preset !== 'custom') { s.cols = presetCols(s.preset); s.mode = PRESETS[s.preset].mode; } else panel.querySelector('#tl-cols-box').open = true;
      reload(); return;
    }
    const pg = e.target.closest('button[data-pg]');
    if (pg && !pg.disabled) { s.page = Number(pg.dataset.pg); draw(panel, Infinity); panel.querySelector('.xp-tltable')?.scrollIntoView({ block: 'nearest' }); panel.querySelector('#tl-out .xp-pager button:not([disabled])')?.focus(); return; }
    const tr = e.target.closest('tr[data-slot]');
    if (tr && !e.target.closest('a, button')) location.hash = slotHref(Number(tr.dataset.slot));
  });
  panel.addEventListener('keydown', (e) => {
    const tr = e.target.closest?.('tr[data-slot]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.hash = slotHref(Number(tr.dataset.slot)); }
  });
  panel.querySelector('#tl-cols').addEventListener('change', (e) => {
    if (e.target.name !== 'col') return;
    s.cols = [...panel.querySelectorAll('#tl-cols input[name="col"]:checked')].map((c) => c.value);
    s.preset = 'custom'; if (!s.mode) s.mode = 'lines';
    reload();
  });
}
