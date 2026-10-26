// Facts tab: the catalogue of series (searchable), and for one series its points over time with every
// version: the current value as a line (broken where readings are missing), replaced values as hollow
// markers, an "as known at" control that shows what the core knew at an earlier moment, the stats,
// how the values are spread, and a table where each point links to its raw file and its slot.
import {
  ctx, get, ep, loading, emptyBox, errorBox, loadOverview, count, plural, T, esc, writeHash, readHash, fromLocal, addDays, localDate,
  val, num, rawBtn, slotLink, pagerHtml, qualityWords, toLocalInput, fromLocalInput, toSec, dateBounds,
} from './util.js';
import { lineChart, histogram, legendHtml, tipHtml } from './charts.js';

const CAT_PAGE = 12;
const PT_PAGE = 50;
let built = false;
const s = { q: '', source: '', series: '', from: '', to: '', asof: '', sup: '1' };
let catPage = 0; let ptPage = 0; let catalogue = null; let detail = null;
export function reset() { built = false; Object.assign(s, { q: '', source: '', series: '', from: '', to: '', asof: '', sup: '1' }); catPage = 0; ptPage = 0; catalogue = null; detail = null; }
export const hashState = () => ({ value: '', params: { ...s, sup: s.sup === '1' ? '' : '0' } });
const keepHash = () => { if (readHash().tab === 'facts') writeHash('facts', '', hashState().params); };

const ROLE = { instant: 'a reading at a moment', interval: 'a total or average over a period', forecast: 'a forecast for a period' };

function seriesItem(x) {
  const on = String(x.series_id) === String(s.series);
  return `<li><button type="button" class="xp-series" data-series="${esc(x.series_id)}" aria-pressed="${on}">
    <b>${esc(x.label || x.metric)}</b>
    <span class="mono">${esc(x.metric)} · ${esc(x.source)} · ${esc(x.unit || 'no unit')}</span>
    <span class="faint">${count(x.count)} facts${x.superseded_count ? ` · ${count(x.superseded_count)} replaced` : ''} · ${x.first_ts ? `${esc(T.day(x.first_ts))} to ${esc(T.day(x.last_ts))}` : 'empty'}</span>
  </button></li>`;
}

async function drawCatalogue() {
  const box = document.getElementById('facts-cat');
  box.innerHTML = loading('Finding series…');
  try { catalogue = await get(ep('series', { q: s.q, source: s.source })); } catch (err) { box.innerHTML = errorBox('The series could not be listed', err); return; }
  if (!Array.isArray(catalogue) || !catalogue.length) { box.innerHTML = emptyBox(s.q || s.source ? 'No series match' : 'No series stored', s.q || s.source ? 'Try other words or another source.' : 'This home has no facts yet.'); return; }
  const pages = Math.ceil(catalogue.length / CAT_PAGE);
  const sel = catalogue.findIndex((x) => String(x.series_id) === String(s.series));
  if (sel >= 0 && catPage === -1) catPage = Math.floor(sel / CAT_PAGE);
  catPage = Math.max(0, Math.min(catPage, pages - 1));
  box.innerHTML = `<p class="xp-count" role="status">${plural(catalogue.length, 'series', 'series')}</p>
    <ul class="xp-serieslist">${catalogue.slice(catPage * CAT_PAGE, (catPage + 1) * CAT_PAGE).map(seriesItem).join('')}</ul>${pagerHtml(catPage, pages, 'series')}`;
}

function gapOf(ts) {
  if (ts.length < 3) return null;
  const d = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) d.push(ts[i] - ts[i - 1]);
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] * 1.6 : null;
}

async function drawDetail() {
  const box = document.getElementById('facts-detail');
  if (!s.series) { box.innerHTML = emptyBox('Pick a series', 'Choose one from the list to see its values over time, every version of each value, and the file each came from.'); return; }
  const meta = catalogue?.find((x) => String(x.series_id) === String(s.series));
  if (!s.from && meta?.last_ts) { s.to = localDate(meta.last_ts); s.from = addDays(s.to, -1); }
  box.innerHTML = `
    <div class="xp-dethead"><h2 id="facts-title">${esc(meta?.label || `Series #${s.series}`)}</h2>
      <p>${meta ? `<span class="mono">${esc(meta.metric)}</span> from <b class="mono">${esc(meta.source)}</b> for ${esc(meta.subject_kind)} <span class="mono">${esc(meta.subject_id)}</span>: ${esc(ROLE[meta.time_role] || meta.time_role || '')}${meta.aggregation ? `, combined by ${esc(meta.aggregation)}` : ''}. Series #${esc(meta.series_id)}.` : `Series #${esc(s.series)}.`}</p></div>
    <form class="xp-controls" id="facts-form">
      <label>From<input type="date" id="facts-from" value="${esc(s.from)}" ${dateBounds()}></label>
      <label>To<input type="date" id="facts-to" value="${esc(s.to)}" ${dateBounds()}></label>
      <label>As known at <span class="faint">(${esc(ctx.tz)})</span><input type="datetime-local" id="facts-asof" value="${s.asof ? esc(toLocalInput(Number(s.asof))) : ''}"></label>
      <button type="button" class="btn" id="facts-latest" ${s.asof ? '' : 'disabled'}>Latest</button>
      <label class="xp-check-toggle"><input type="checkbox" id="facts-sup" ${s.sup === '1' ? 'checked' : ''}> Show replaced versions</label>
    </form>
    <div id="facts-body">${loading('Loading the points…')}</div>`;
  const body = box.querySelector('#facts-body');
  try {
    detail = await get(ep('facts', {
      series: s.series, from: s.from ? fromLocal(s.from, 0) : '', to: s.to ? fromLocal(addDays(s.to, 1), 0) : '',
      as_of_ms: s.asof || '', include_superseded: s.sup === '1' ? 1 : 0, limit: 5000,
    }));
  } catch (err) { body.innerHTML = errorBox('The points could not be loaded', err); return; }
  ptPage = 0;
  drawPoints();
}

function drawPoints() {
  const body = document.getElementById('facts-body');
  if (!body || !detail) return;
  const unit = detail.series?.unit || catalogue?.find((x) => String(x.series_id) === String(s.series))?.unit || '';
  const pts = (detail.points || []).map((p) => ({ ...p, t: p.ts ?? p.start_ts }));
  const st = detail.stats || {};
  const asOf = detail.as_of_ms ?? (s.asof ? Number(s.asof) : null);
  if (!pts.length) {
    body.innerHTML = `${asOf ? `<p class="xp-msg">Showing what the core knew at <b>${esc(T.stamp(asOf))}</b>.</p>` : ''}${emptyBox('No points in this range', 'Pick another period, or a later "as known at" moment.')}`;
    return;
  }
  const cur = pts.filter((p) => !p.superseded_at).sort((a, b) => a.t - b.t);
  const old = pts.filter((p) => p.superseded_at);
  const gap = gapOf(cur.map((p) => p.t));
  const tile = (label, v, note = '') => `<div class="proof-stat"><div class="big">${v}</div><div class="label">${label}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  const pages = Math.ceil(pts.length / PT_PAGE);
  ptPage = Math.min(ptPage, pages - 1);
  const ordered = pts.slice().sort((a, b) => a.t - b.t || (toSec(a.recorded_at) || 0) - (toSec(b.recorded_at) || 0));
  const slotOf = (t) => t - ((t - fromLocal(localDate(t), 0)) % ctx.slotS);
  body.innerHTML = `
    ${detail.truncated ? `<p class="xp-msg warn">Only the first ${count(pts.length)} points of this range are shown: pick a shorter range to see them all.</p>` : ''}
    ${asOf ? `<p class="xp-msg"><b>As known at ${esc(T.stamp(asOf))}.</b> Values recorded after that moment are hidden, and a value replaced later shows as it was then.</p>` : ''}
    <div class="proof-stats xp-stats">
      ${tile('points', count(st.n ?? cur.length), 'current values')}
      ${tile('lowest', val(st.min, unit))}${tile('highest', val(st.max, unit))}${tile('average', val(st.mean, unit))}
      ${tile('gaps', count(st.gaps ?? 0), 'breaks in the line')}
      ${tile('replaced versions', count(st.versions ?? old.length), 'hollow markers')}
    </div>
    ${legendHtml([{ label: 'Current value', color: 'var(--grid)', type: 'line' }, ...(old.length ? [{ label: 'A value later replaced by a new version', color: 'var(--export)', type: 'hollow' }] : [])])}
    <div id="facts-chart"></div>
    <p class="xp-foot">${gap ? `A break in the line means no reading for more than ${esc(Math.round(gap / 60))} minutes. ` : ''}Hover, or focus the chart and use the arrow keys, to read the values.</p>
    <details class="xp-details"><summary>How the values are spread</summary><div id="facts-hist"></div></details>
    <h3 class="xp-h3">Every point and version</h3>
    <div class="table-wrap xp-scroll"><table class="xp-table"><caption class="sr-only">Points of this series, oldest first, with every version</caption>
      <thead><tr><th scope="col">Time</th><th scope="col" class="r">Value</th><th scope="col">Quality</th><th scope="col">Recorded</th><th scope="col">Version</th><th scope="col">From file</th></tr></thead>
      <tbody>${ordered.slice(ptPage * PT_PAGE, (ptPage + 1) * PT_PAGE).map((p) => `<tr class="${p.superseded_at ? 'superseded' : ''}">
        <td>${slotLink(slotOf(p.t), p.end_ts ? T.span(p.t, p.end_ts) : T.dayTime(p.t))}</td><td class="r">${val(p.value, unit)}</td>
        <td>${esc(qualityWords(p.quality))}</td><td>${esc(T.stamp(p.recorded_at))}</td>
        <td>${p.superseded_at ? `<span class="xp-old">replaced ${esc(T.stamp(p.superseded_at))}</span>` : 'current'}</td><td>${rawBtn(p.raw_id)}</td></tr>`).join('')}</tbody></table></div>
    ${pagerHtml(ptPage, pages, 'points')}`;
  const byT = new Map();
  for (const p of pts) { const a = byT.get(p.t) || []; a.push(p); byT.set(p.t, a); }
  lineChart(body.querySelector('#facts-chart'), {
    height: 240, unit, gap, zero: false, label: `${detail.series?.label || 'Series'} over time`,
    series: [
      { key: 'cur', label: 'Current value', color: 'var(--grid)', points: cur.map((p) => ({ t: p.t, v: p.value })) },
      { key: 'old', label: 'Replaced', color: 'var(--export)', points: old.map((p) => ({ t: p.t, v: p.value, hollow: true })) },
    ],
    tip: (t) => {
      const list = (byT.get(t) || []).slice().sort((a, b) => (toSec(b.recorded_at) || 0) - (toSec(a.recorded_at) || 0));
      return tipHtml(`${esc(T.dayTime(t))}`, list.map((p) => [p.superseded_at ? `replaced, recorded ${esc(T.stamp(p.recorded_at))}` : 'current', p.superseded_at ? 'var(--export)' : 'var(--grid)', `${num(p.value)} ${esc(unit)}`, p.superseded_at ? 'hollow' : '']));
    },
  });
  histogram(body.querySelector('#facts-hist'), { values: cur.map((p) => p.value), unit, label: 'How the current values are spread' });
}

export async function show(panel, h) {
  const p = h?.params || new URLSearchParams();
  const want = { q: p.get('q') || '', source: p.get('source') || '', series: p.get('series') || '', from: p.get('from') || '', to: p.get('to') || '', asof: p.get('asof') || '', sup: p.get('sup') === '0' ? '0' : '1' };
  const catChanged = !built || want.q !== s.q || want.source !== s.source;
  const detChanged = !built || ['series', 'from', 'to', 'asof', 'sup'].some((k) => want[k] !== s[k]);
  if (built && !catChanged && !detChanged) return;
  Object.assign(s, want);
  if (!built) {
    built = true;
    try { await loadOverview(); } catch { /* source list falls back to the address */ }
    const sources = (ctx.overview?.sources || []).map((x) => x.code);
    if (s.source && !sources.includes(s.source)) sources.push(s.source);
    panel.innerHTML = `
      <p class="xp-lead">A fact is one value read from a raw file: a reading at a moment, or a total over a period, with the time the core learnt it. When a provider sends a correction, the new value is added as a new version and the old one is kept, marked as replaced. Nothing is ever overwritten.</p>
      <div class="xp-facts">
        <section class="card xp-cat" aria-labelledby="facts-cat-h"><h2 id="facts-cat-h">Series</h2>
          <form class="xp-controls xp-stack" id="facts-search" role="search" aria-label="Find a series">
            <label>Search<input type="search" id="facts-q" placeholder="e.g. import, solar, temperature" value="${esc(s.q)}" autocomplete="off"></label>
            <label>Source<select id="facts-src"><option value="">Every source</option>${sources.sort().map((x) => `<option value="${esc(x)}" ${x === s.source ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          </form>
          <div id="facts-cat"></div></section>
        <section class="card xp-det" id="facts-detail" aria-labelledby="facts-title" aria-live="polite"></section>
      </div>`;
    let t;
    panel.querySelector('#facts-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { s.q = e.target.value.trim(); catPage = 0; keepHash(); drawCatalogue(); }, 220); });
    panel.querySelector('#facts-search').addEventListener('submit', (e) => e.preventDefault());
    panel.querySelector('#facts-src').addEventListener('change', (e) => { s.source = e.target.value; catPage = 0; keepHash(); drawCatalogue(); });
    panel.querySelector('#facts-cat').addEventListener('click', (e) => {
      const pg = e.target.closest('button[data-pg]');
      if (pg && !pg.disabled) { catPage = Number(pg.dataset.pg); drawCatalogue().then(() => panel.querySelector('#facts-cat .xp-pager button:not([disabled])')?.focus()); return; }
      const b = e.target.closest('button[data-series]');
      if (!b) return;
      s.series = b.dataset.series; s.from = ''; s.to = ''; s.asof = '';
      panel.querySelectorAll('.xp-series').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawDetail().then(() => { keepHash(); });
      if (matchMedia('(max-width: 900px)').matches) document.getElementById('facts-detail').scrollIntoView({ block: 'start' });
    });
    const det = panel.querySelector('#facts-detail');
    det.addEventListener('change', (e) => {
      const id = e.target.id;
      if (id === 'facts-from' || id === 'facts-to') { s.from = det.querySelector('#facts-from').value; s.to = det.querySelector('#facts-to').value; if (s.from && s.to && s.from > s.to) [s.from, s.to] = [s.to, s.from]; }
      else if (id === 'facts-asof') { const ms = fromLocalInput(e.target.value); s.asof = ms ? String(ms) : ''; }
      else if (id === 'facts-sup') s.sup = e.target.checked ? '1' : '0';
      else return;
      keepHash(); drawDetail().then(() => det.querySelector(`#${id}`)?.focus());
    });
    det.addEventListener('submit', (e) => e.preventDefault());
    det.addEventListener('click', (e) => {
      if (e.target.id === 'facts-latest') { s.asof = ''; keepHash(); drawDetail().then(() => det.querySelector('#facts-asof')?.focus()); return; }
      const pg = e.target.closest('button[data-pg]');
      if (pg && !pg.disabled) { ptPage = Number(pg.dataset.pg); drawPoints(); det.querySelector('.xp-pager button:not([disabled])')?.focus(); }
    });
    catPage = -1;
  } else {
    panel.querySelector('#facts-q').value = s.q;
    panel.querySelector('#facts-src').value = s.source;
  }
  if (catChanged) { if (catPage !== -1) catPage = 0; await drawCatalogue(); }
  else panel.querySelectorAll('.xp-series').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.series === String(s.series))));
  if (detChanged) await drawDetail();
}
