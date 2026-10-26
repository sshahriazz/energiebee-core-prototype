// Correlations tab: pick two variables (or a preset), a range, a step, a lag and a grouping; see the
// scatter with its regression line and r / R² / Spearman / n / slope, the correlation per group, the two
// series side by side with one cursor, and a heatmap of any variable by time of day and date. Every
// chart has one plain sentence under it; fewer than 30 points is flagged as weak evidence.
import {
  ctx, get, ep, loading, emptyBox, errorBox, loadOverview, T, esc, writeHash, readHash, lastDays, dateBounds, count, num, plural,
  explainR, rWords, slotHref, fromLocal, slotNoun, loadVariables, unitLabel,
} from './util.js';
import { scatter, lineChart, heatmap, heatLegendHtml, groupBarsHtml, legendHtml, tipHtml } from './charts.js';

const isSeriesVar = (v) => v.source === 'series';
const by = (re, field = 'name') => (vars) => vars.find((v) => re.test(String(v[field] || '')));
export const PRESETS = [
  { key: 'meter-ct', label: 'Meter vs inverter clamp',
    // The smart meter's import series (else the timeline's grid import), against the inverter clamp's import power.
    x: (vars) => vars.find((v) => isSeriesVar(v) && v.metric === 'grid_import_kwh' && /meter/i.test(`${v.provider_source} ${v.label}`)) || by(/^grid_import$/)(vars),
    y: (vars) => vars.find((v) => isSeriesVar(v) && v.metric === 'grid_import_w' && /5min/i.test(`${v.provider_source} ${v.label}`))
      || vars.find((v) => isSeriesVar(v) && (v.metric === 'grid_import_w' || /clamp|grid_power/i.test(`${v.label} ${v.kind} ${v.name}`))),
    why: 'Two meters measuring the same grid flow should move together closely: r near 1. The clamp reads power (W), so the slope converts W to kWh rather than being 1.' },
  { key: 'solar-fc', label: 'Solar vs forecast', x: by(/^solar_forecast$/), y: by(/^solar$/), why: 'How well the solar forecast predicted what the panels made.' },
  { key: 'import-price', label: 'Import vs price', x: (v) => by(/^import_rate$/)(v) || by(/^import_rate_ex$/)(v), y: by(/^grid_import$/), why: 'Does the house import less when the price is high? A negative r says yes.' },
  { key: 'load-temp', label: 'Load vs outdoor temp', x: by(/^outdoor_temp$/), y: by(/^home$/), why: 'Does the house use more on cold days (heating) or hot ones (cooling)?' },
  { key: 'batt-price', label: 'Battery charge vs price', x: (v) => by(/^import_rate$/)(v) || by(/^import_rate_ex$/)(v), y: by(/^battery_charge$/), why: 'A battery charging when power is cheap shows a negative r.' },
];
const STEP_WORD = () => ({ slot: `Each ${slotNoun()}`, hour: 'Each hour', day: 'Each day' });
const STEP_S = { hour: 3600, day: 86400 };

let built = false; let vars = [];
const s = { x: '', y: '', from: '', to: '', step: 'slot', lag: '0', group: 'none', hv: '', agg: 'mean', preset: '' };
let res = null;
export function reset() { built = false; vars = []; res = null; Object.assign(s, { x: '', y: '', from: '', to: '', step: 'slot', lag: '0', group: 'none', hv: '', agg: 'mean', preset: '' }); }
export const hashState = () => ({ value: '', params: { x: s.x, y: s.y, from: s.from, to: s.to, step: s.step === 'slot' ? '' : s.step, lag: s.lag === '0' ? '' : s.lag, group: s.group === 'none' ? '' : s.group, hv: s.hv, agg: s.agg === 'mean' ? '' : s.agg } });
const keepHash = () => { if (readHash().tab === 'correlate') writeHash('correlate', '', hashState().params); };
const vOf = (name) => vars.find((v) => v.name === name);
const vLabel = (name, fb) => vOf(name)?.label || fb?.label || name;

function varOptions(cur) {
  const groups = [['timeline', 'Timeline columns'], ['series', 'Raw series']];
  const opt = (v) => `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.label || v.name)}${unitLabel(v.unit) ? ` (${esc(unitLabel(v.unit))})` : ''}</option>`;
  const other = vars.filter((v) => !groups.some(([k]) => k === v.source));
  return groups.map(([k, l]) => { const list = vars.filter((v) => v.source === k); return list.length ? `<optgroup label="${esc(l)}">${list.map(opt).join('')}</optgroup>` : ''; }).join('') + other.map(opt).join('');
}

function controlsHtml() {
  return `<div class="segmented xp-presets" role="group" aria-label="Ready-made questions">${PRESETS.map((p) => {
    const ok = p.x(vars) && p.y(vars);
    return `<button type="button" data-cpreset="${p.key}" aria-pressed="${s.preset === p.key}" ${ok ? '' : 'disabled title="Not available for this home: one of the two variables is missing"'}>${esc(p.label)}</button>`;
  }).join('')}</div>
  <form class="xp-controls" id="cr-form">
    <label>X (across)<select id="cr-x">${varOptions(s.x)}</select></label>
    <label>Y (up)<select id="cr-y">${varOptions(s.y)}</select></label>
    <label>From<input type="date" id="cr-from" value="${esc(s.from)}" ${dateBounds()}></label>
    <label>To<input type="date" id="cr-to" value="${esc(s.to)}" ${dateBounds()}></label>
    <label>Compare<select id="cr-step">${Object.entries(STEP_WORD()).map(([k, w]) => `<option value="${k}" ${k === s.step ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
    <label title="How many steps later Y is taken than X: 2 compares X with Y two steps later">Lag (steps)<input type="number" id="cr-lag" min="-96" max="96" step="1" value="${esc(s.lag)}" inputmode="numeric"></label>
    <label>Split by<select id="cr-group"><option value="none">Nothing</option><option value="hour" ${s.group === 'hour' ? 'selected' : ''} ${s.step === 'day' ? 'disabled' : ''}>Hour of the day</option><option value="weekday" ${s.group === 'weekday' ? 'selected' : ''}>Day of the week</option></select></label>
  </form>`;
}

function syncControls(panel) {
  for (const k of ['x', 'y', 'from', 'to', 'step', 'lag', 'group']) { const el = panel.querySelector(`#cr-${k}`); if (el) el.value = s[k]; }
  const hourOpt = panel.querySelector('#cr-group option[value="hour"]');
  if (hourOpt) { hourOpt.disabled = s.step === 'day'; hourOpt.title = s.step === 'day' ? 'Comparing whole days has no hours to split by' : ''; }
  panel.querySelectorAll('[data-cpreset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cpreset === s.preset)));
}

function sentences(r) {
  const xl = vLabel(s.x, r.x); const yl = vLabel(s.y, r.y);
  const out = [explainR(r.pearson, r.n, xl, yl)];
  if (Number.isFinite(r.r2)) out.push(`R² = ${r.r2.toFixed(2)}: a straight line through ${xl} explains ${Math.round(r.r2 * 100)} % of how ${yl} varies.`);
  if (Number.isFinite(r.slope) && Math.abs(r.pearson ?? 0) >= 0.1) out.push(`On average, each extra 1 ${unitLabel(r.x?.unit)} of ${xl} goes with ${num(Math.abs(r.slope))} ${unitLabel(r.y?.unit)} ${r.slope >= 0 ? 'more' : 'less'} ${yl}.`.replace(/ {2,}/g, ' '));
  if (Number.isFinite(r.spearman)) out.push(`Spearman = ${r.spearman.toFixed(2)} (${rWords(r.spearman)}): the same question asked of the order of the values only, so a few extreme values matter less.`);
  return out;
}

function draw(panel) {
  const out = panel.querySelector('#cr-out');
  if (!res) return;
  if (res.error) {
    const few = res.min_points != null || /too few/i.test(res.error);
    out.innerHTML = few ? `<div class="xp-msg warn" role="status"><b>Too few points to compare.</b><p>Only ${plural(res.n ?? 0, 'step has', 'steps have')} a value for both${res.min_points ? `; at least ${esc(res.min_points)} are needed` : ''}. Pick a longer range, a shorter step, or other variables.</p>${(res.notes || []).length ? `<p class="faint">${(Array.isArray(res.notes) ? res.notes : [res.notes]).map(esc).join(' · ')}</p>` : ''}</div>`
      : `<div class="xp-msg bad" role="alert"><b>The correlation could not be worked out.</b><p>${esc(res.error)}</p></div>`;
    return;
  }
  const r = res;
  const xl = vLabel(s.x, r.x); const yl = vLabel(s.y, r.y);
  const xu = unitLabel(r.x?.unit || vOf(s.x)?.unit || ''); const yu = unitLabel(r.y?.unit || vOf(s.y)?.unit || '');
  const pts = (r.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const notes = Array.isArray(r.notes) ? r.notes : r.notes ? [r.notes] : [];
  const tile = (label, v, note) => `<div class="proof-stat"><div class="big">${v}</div><div class="label">${label}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  const few = (r.n ?? pts.length) < 30;
  const pre = PRESETS.find((p) => p.key === s.preset);
  const groups = r.by_group || [];
  const strongest = groups.filter((g) => Number.isFinite(g.pearson) && (g.n ?? 0) >= 3).sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson))[0];
  out.innerHTML = `
    ${pre ? `<p class="xp-foot">${esc(pre.why)}</p>` : ''}
    <div class="proof-stats xp-stats">
      ${tile('r (Pearson)', Number.isFinite(r.pearson) ? r.pearson.toFixed(2) : '–', Number.isFinite(r.pearson) ? esc(`${rWords(r.pearson)}${Math.abs(r.pearson) >= 0.1 ? (r.pearson > 0 ? ' positive' : ' negative') : ''}`) : '')}
      ${tile('R²', Number.isFinite(r.r2) ? r.r2.toFixed(2) : '–', Number.isFinite(r.r2) ? `${Math.round(r.r2 * 100)} % explained` : '')}
      ${tile('Spearman', Number.isFinite(r.spearman) ? r.spearman.toFixed(2) : '–', 'by order only')}
      ${tile('n', count(r.n ?? pts.length), few ? '<span class="xp-warn-text">under 30: weak evidence</span>' : 'pairs of values')}
      ${tile('slope', Number.isFinite(r.slope) ? num(r.slope) : '–', esc(`${yu || 'Y'} per ${xu || 'X'}`))}
    </div>
    ${r.points_downsampled ? `<p class="xp-foot">The charts show an even sample of ${count(pts.length)} of the ${count(r.n)} points; the figures use them all.</p>` : ''}
    <ul class="xp-sentences">${sentences(r).map((x) => `<li>${esc(x)}</li>`).join('')}${notes.map((x) => `<li class="faint">${esc(x)}</li>`).join('')}<li class="faint">A relationship is not proof that one causes the other.</li></ul>
    <div class="grid cols-2 xp-pair">
      <section class="card section" aria-labelledby="cr-sc-h"><div class="card-head"><div><h2 id="cr-sc-h">${esc(yl)} against ${esc(xl)}</h2><p>Each dot is one ${esc(s.step === 'slot' ? slotNoun() : s.step)}${Number(s.lag) ? `, Y taken ${esc(Math.abs(Number(s.lag)))} step${Math.abs(Number(s.lag)) === 1 ? '' : 's'} ${Number(s.lag) > 0 ? 'later' : 'earlier'}` : ''}. The line is the best straight-line fit.</p></div></div>
        ${legendHtml([{ label: 'One pair of values', color: 'var(--grid)', type: 'dot' }, { label: 'Best straight-line fit', color: 'var(--text)', type: 'line' }])}
        <p class="xp-rlabel">r = ${Number.isFinite(r.pearson) ? r.pearson.toFixed(2) : '–'} · R² = ${Number.isFinite(r.r2) ? r.r2.toFixed(2) : '–'} · n = ${count(r.n ?? pts.length)}</p>
        <div id="cr-scatter"></div><p class="xp-say">${esc(explainR(r.pearson, r.n ?? pts.length, xl, yl))}</p></section>
      <section class="card section" aria-labelledby="cr-g-h"><div class="card-head"><div><h2 id="cr-g-h">Per ${s.group === 'hour' ? 'hour of the day' : s.group === 'weekday' ? 'day of the week' : 'group'}</h2><p>The same correlation inside each group: does the relationship hold all day, or only at some times?</p></div></div>
        ${s.group === 'none' ? '<p class="faint">Choose "Split by" above to compare the correlation hour by hour or day by day.</p>' : groups.length ? `${groupBarsHtml(groups)}<p class="xp-say">${strongest ? esc(`Strongest in group ${strongest.key}: r = ${strongest.pearson.toFixed(2)} (${rWords(strongest.pearson)}) from ${plural(strongest.n ?? 0, 'point', 'points')}.`) : 'No group has enough varied data.'} Bars to the right are positive, to the left negative; faded groups have fewer than 30 points.</p>` : '<p class="faint">No groups came back for this split.</p>'}</section>
    </div>
    <section class="card section" aria-labelledby="cr-ts-h"><div class="card-head"><div><h2 id="cr-ts-h">The two side by side</h2><p>${esc(xl)} on top, ${esc(yl)} below, on the same time axis: one cursor moves both.</p></div></div>
      <h3 class="xp-charth">${esc(xl)}${xu ? ` <span class="faint">${esc(xu)}</span>` : ''}</h3><div id="cr-tx"></div>
      <h3 class="xp-charth">${esc(yl)}${yu ? ` <span class="faint">${esc(yu)}</span>` : ''}</h3><div id="cr-ty"></div>
      <p class="xp-say">${esc(Number.isFinite(r.pearson) && Math.abs(r.pearson) >= 0.3 ? `They tend to move ${r.pearson > 0 ? 'together' : 'in opposite directions'}: ${explainR(r.pearson, r.n ?? pts.length, xl, yl).split(': ').slice(1).join(': ')}` : `They do not move together clearly: ${explainR(r.pearson, r.n ?? pts.length, xl, yl).split(': ').slice(1).join(': ')}`)}</p></section>`;
  if (!pts.length) { out.querySelector('#cr-scatter').innerHTML = emptyBox('No pairs of values', 'There is no time in this range when both variables have a value.'); return; }
  scatter(out.querySelector('#cr-scatter'), {
    points: pts, xLabel: xl, yLabel: yl, xUnit: xu, yUnit: yu, slope: r.slope, intercept: r.intercept, label: `${yl} against ${xl}`,
    tip: (p) => tipHtml(esc(p.t != null ? T.dayTime(p.t) : 'Point'), [[esc(xl), '', `${num(p.x)} ${esc(xu)}`], [esc(yl), '', `${num(p.y)} ${esc(yu)}`]]),
  });
  const gap = (STEP_S[s.step] || ctx.slotS) * 1.5;
  const byT = new Map(pts.map((p) => [p.t, p]));
  const tsTip = (t) => { const p = byT.get(t); return p ? tipHtml(esc(T.dayTime(t)), [[esc(xl), 'var(--grid)', `${num(p.x)} ${esc(xu)}`], [esc(yl), 'var(--export)', `${num(p.y)} ${esc(yu)}`]]) : ''; };
  const onPick = s.step === 'slot' ? (t) => { location.hash = slotHref(t); } : null;
  lineChart(out.querySelector('#cr-tx'), { series: [{ key: 'x', label: xl, color: 'var(--grid)', points: pts.map((p) => ({ t: p.t, v: p.x })) }], unit: xu, gap, zero: false, height: 160, sync: 'corr', tip: tsTip, onPick, label: `${xl} over time` });
  lineChart(out.querySelector('#cr-ty'), { series: [{ key: 'y', label: yl, color: 'var(--export)', points: pts.map((p) => ({ t: p.t, v: p.y })) }], unit: yu, gap, zero: false, height: 160, sync: 'corr', tip: tsTip, onPick, label: `${yl} over time` });
}

async function run(panel) {
  const out = panel.querySelector('#cr-out');
  if (!s.x || !s.y) { out.innerHTML = emptyBox('Pick two variables', 'Choose X and Y above, or one of the ready-made questions.'); return; }
  out.innerHTML = loading('Comparing…');
  try { res = await get(ep('correlate', { x: s.x, y: s.y, from: s.from, to: s.to, step: s.step, lag: s.lag, group: s.group })); } catch (err) { res = null; out.innerHTML = errorBox('The correlation could not be loaded', err); return; }
  draw(panel);
}

async function runHeat(panel) {
  const box = panel.querySelector('#cr-heat');
  if (!s.hv) { box.innerHTML = emptyBox('Pick a variable'); return; }
  box.innerHTML = loading('Drawing the heatmap…');
  let h;
  try { h = await get(ep('heatmap', { var: s.hv, from: s.from, to: s.to, agg: s.agg })); } catch (err) { box.innerHTML = errorBox('The heatmap could not be loaded', err); return; }
  if (h.error) { box.innerHTML = `<div class="xp-msg bad" role="alert"><b>The heatmap could not be drawn.</b><p>${esc(h.error)}</p></div>`; return; }
  const rows = h.rows || [];
  if (!rows.length) { box.innerHTML = emptyBox('No values in this range'); return; }
  const all = rows.flatMap((r) => r.cells).filter((v) => Number.isFinite(v));
  if (!all.length) { box.innerHTML = emptyBox('No values in this range', 'This variable has no value on these days.'); return; }
  const min = Number.isFinite(h.min) ? h.min : Math.min(...all); const max = Number.isFinite(h.max) ? h.max : Math.max(...all);
  const label = vLabel(s.hv, h);
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const colS = 86400 / cols;
  // Where the highest values sit, in words.
  const avg = Array.from({ length: cols }, (_, c) => { const v = rows.map((r) => r.cells[c]).filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; });
  const peak = avg.reduce((bi, v, i) => (v != null && (bi < 0 || v > avg[bi]) ? i : bi), -1);
  const hu = unitLabel(h.unit);
  box.innerHTML = `${heatLegendHtml(min, max, hu, label)}<div id="cr-heatmap"></div>
    <p class="xp-say">${esc(`Darker means higher ${label}. Each row is a day and each column a time of day${peak >= 0 ? `; on average it is highest around ${(h.tod_labels || [])[peak] || ''}` : ''}.`)}${colS === ctx.slotS ? ` Select a cell to open that ${esc(slotNoun())}.` : ''}</p>`;
  heatmap(box.querySelector('#cr-heatmap'), {
    rows, labels: h.tod_labels || [], min, max, unit: hu, name: label, label: `${label} by time of day and date`,
    onPick: colS === ctx.slotS ? (date, c) => { location.hash = slotHref(fromLocal(date, Math.round((c * colS) / 60))); } : null,
  });
}

export async function show(panel, h) {
  const p = h?.params || new URLSearchParams();
  if (!built) {
    built = true;
    panel.innerHTML = loading('Loading the variables…');
    try { await loadOverview(); } catch { /* range falls back */ }
    try { vars = await loadVariables(); } catch (err) { built = false; panel.innerHTML = errorBox('The list of variables could not be loaded', err); return; }
    if (!vars.length) { panel.innerHTML = emptyBox('This home has no data', 'There is nothing to compare yet.'); return; }
    const d = lastDays(7);
    Object.assign(s, d);
    const def = PRESETS.find((x) => x.key === 'import-price' && x.x(vars) && x.y(vars)) || PRESETS.find((x) => x.x(vars) && x.y(vars));
    if (def) { s.x = def.x(vars).name; s.y = def.y(vars).name; s.preset = def.key; } else { s.x = vars[0].name; s.y = (vars[1] || vars[0]).name; }
    s.hv = s.y;
    panel.innerHTML = `<p class="xp-lead">Do two things move together? Pick what goes across (X) and up (Y). r runs from −1 (one goes up when the other goes down) through 0 (no straight-line link) to +1 (they rise together).</p>
      ${controlsHtml()}<div id="cr-out" aria-live="polite"></div>
      <section class="card section" aria-labelledby="cr-h-h"><div class="card-head"><div><h2 id="cr-h-h">Heatmap: a variable by time of day and date</h2><p>Patterns that repeat every day (a cheap night, a solar midday) show up as columns.</p></div></div>
        <form class="xp-controls" id="cr-hform"><label>Variable<select id="cr-hv">${varOptions(s.hv)}</select></label>
          <label>Combine values by<select id="cr-agg">${[['mean', 'Average'], ['sum', 'Total']].map(([k, l]) => `<option value="${k}" ${k === s.agg ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <span class="xp-foot">Same days as above.</span></form>
        <div id="cr-heat"></div></section>`;
    wire(panel);
  }
  const want = { ...s };
  for (const k of ['x', 'y', 'from', 'to', 'step', 'lag', 'group', 'hv', 'agg']) if (p.get(k)) want[k] = p.get(k);
  if (!['mean', 'sum'].includes(want.agg)) want.agg = 'mean';
  if (want.step === 'day' && want.group === 'hour') want.group = 'none';
  if (!vOf(want.x)) want.x = s.x; if (!vOf(want.y)) want.y = s.y; if (!vOf(want.hv)) want.hv = s.hv;
  if (p.get('x') || p.get('y')) want.preset = PRESETS.find((x) => x.x(vars)?.name === want.x && x.y(vars)?.name === want.y)?.key || '';
  const corrChanged = !res || ['x', 'y', 'from', 'to', 'step', 'lag', 'group'].some((k) => want[k] !== s[k]);
  const heatChanged = !panel.querySelector('#cr-heatmap') || ['hv', 'agg', 'from', 'to'].some((k) => want[k] !== s[k]);
  Object.assign(s, want);
  syncControls(panel);
  panel.querySelector('#cr-hv').value = s.hv; panel.querySelector('#cr-agg').value = s.agg;
  await Promise.all([corrChanged ? run(panel) : null, heatChanged ? runHeat(panel) : null]);
}

function wire(panel) {
  panel.querySelector('#cr-form').addEventListener('submit', (e) => e.preventDefault());
  panel.querySelector('#cr-hform').addEventListener('submit', (e) => e.preventDefault());
  panel.querySelector('#cr-form').addEventListener('change', (e) => {
    const k = e.target.id.replace('cr-', '');
    if (!(k in s)) return;
    s[k] = e.target.value;
    if (k === 'step' && s.step === 'day' && s.group === 'hour') s.group = 'none';
    if (k === 'lag') s.lag = String(Math.max(-96, Math.min(96, Math.round(Number(e.target.value) || 0))));
    if ((k === 'from' || k === 'to') && s.from && s.to && s.from > s.to) [s.from, s.to] = [s.to, s.from];
    if (k === 'x' || k === 'y') s.preset = PRESETS.find((x) => x.x(vars)?.name === s.x && x.y(vars)?.name === s.y)?.key || '';
    syncControls(panel); keepHash(); run(panel);
    if (k === 'from' || k === 'to') runHeat(panel);
  });
  panel.querySelector('#cr-hform').addEventListener('change', (e) => { if (e.target.id === 'cr-hv') s.hv = e.target.value; if (e.target.id === 'cr-agg') s.agg = e.target.value; keepHash(); runHeat(panel); });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cpreset]');
    if (!b || b.disabled) return;
    const pr = PRESETS.find((x) => x.key === b.dataset.cpreset);
    s.x = pr.x(vars).name; s.y = pr.y(vars).name; s.preset = pr.key; s.hv = s.y;
    panel.querySelector('#cr-hv').value = s.hv;
    syncControls(panel); keepHash(); run(panel); runHeat(panel);
  });
}
