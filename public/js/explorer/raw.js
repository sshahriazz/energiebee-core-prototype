// Raw data tab: every payload a provider sent, filterable by source, status and time, one page at a
// time (the API pages with a cursor). A payload opens in a drawer: what it is, the re-derive verdict
// (we read the file again with the same code: same facts or not), the facts it produced with links to
// their series and slots, and the body itself (a JSON tree or plain text; never run as HTML).
import {
  ctx, get, ep, loading, emptyBox, errorBox, loadOverview, dateBounds, count, bytes, plural, T, esc, writeHash, readHash,
  fromLocal, addDays, val, seriesLink, slotLink, hashOf, slotNoun, localDate, requestText,
} from './util.js';
import { jsonViewer } from './json-tree.js';

const LIMIT = 50;
const STATUS = { accepted: ['good', 'Accepted', 'read and turned into facts'], quarantined: ['bad', 'Quarantined', 'kept aside: it could not be trusted or read, so no facts came from it'] };
const statusBadge = (s) => { const [c, w] = STATUS[s] || ['', s || 'unknown']; return `<span class="badge ${c}">${esc(w)}</span>`; };

let built = false;
const f = { source: '', status: '', from: '', to: '' };
let cursors = [null]; let page = 0; let openId = null;
export function reset() { built = false; Object.assign(f, { source: '', status: '', from: '', to: '' }); cursors = [null]; page = 0; openId = null; }
export const hashState = () => ({ value: '', params: { ...f, id: openId ?? '' } });
const keepHash = () => { if (readHash().tab === 'raw') writeHash('raw', '', hashState().params); };

function listQuery() {
  return {
    source: f.source, status: f.status, limit: LIMIT, cursor: cursors[page] || '',
    from: f.from ? fromLocal(f.from, 0) : '', to: f.to ? fromLocal(addDays(f.to, 1), 0) : '',
  };
}

async function drawList() {
  const box = document.getElementById('raw-list');
  box.innerHTML = loading('Loading raw files…');
  let d;
  try { d = await get(ep('raw', listQuery())); } catch (err) { box.innerHTML = errorBox('The raw files could not be listed', err); return; }
  const rows = d.rows || [];
  if (d.next && cursors.length === page + 1) cursors.push(d.next);
  if (!rows.length) {
    box.innerHTML = emptyBox(page ? 'No more files' : 'No raw files match', page ? '' : 'Try another source, status or period, or clear the filters.');
    return;
  }
  const start = page * LIMIT;
  box.innerHTML = `<p class="xp-count" role="status">Files ${count(start + 1)} to ${count(start + rows.length)}${d.next ? ', more after these' : ''}, newest first.</p>
    <div class="table-wrap xp-scroll"><table class="xp-table xp-rawtable">
      <caption class="sr-only">Raw files; open one to see its contents and the facts it produced</caption>
      <thead><tr><th scope="col">File</th><th scope="col">Fetched</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col" class="r">Size</th><th scope="col" class="r">Facts made</th><th scope="col">Request</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="clickable" data-open="${esc(r.id)}">
        <td><button type="button" class="xp-link" data-raw="${esc(r.id)}">#${esc(r.id)}</button></td>
        <td>${esc(T.stamp(r.fetched_at))}</td><td class="mono">${esc(r.source)}</td><td>${statusBadge(r.status)}${r.reason ? ` <span class="xp-reason" title="${esc(r.reason)}">${esc(r.reason)}</span>` : ''}</td>
        <td class="r">${r.size == null ? '<span class="faint" title="The file is not on this machine">no file</span>' : esc(bytes(r.size))}</td><td class="r">${r.facts_linked ? count(r.facts_linked) : '<span class="faint">none</span>'}</td>
        <td class="xp-req mono" title="${esc(requestText(r.request))}">${esc(requestText(r.request) || '–')}</td></tr>`).join('')}</tbody></table></div>
    <nav class="xp-pager" aria-label="Pages of raw files">
      <button type="button" class="btn" data-rpg="${page - 1}" ${page ? '' : 'disabled'}>← Newer</button><span>Page ${page + 1}</span>
      <button type="button" class="btn" data-rpg="${page + 1}" ${d.next ? '' : 'disabled'}>Older →</button></nav>`;
}

function sourceOptions() {
  const list = (ctx.overview?.raw?.by_source || []).map((s) => s.source);
  if (f.source && !list.includes(f.source)) list.push(f.source);
  return `<option value="">Every source</option>${list.sort().map((s) => `<option value="${esc(s)}" ${s === f.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
}

export async function show(panel, h) {
  const p = h?.params || new URLSearchParams();
  const want = { source: p.get('source') || '', status: p.get('status') || '', from: p.get('from') || '', to: p.get('to') || '' };
  const changed = Object.keys(want).some((k) => want[k] !== f[k]);
  if (!built || changed) {
    Object.assign(f, want); cursors = [null]; page = 0;
  }
  if (!built) {
    built = true;
    try { await loadOverview(); } catch { /* the source list falls back to what the address names */ }
    panel.innerHTML = `
      <p class="xp-lead">Every file a provider sent, stored exactly as it arrived. The core reads facts out of these files; nothing is typed in by hand. Open a file to see what is in it, the facts it produced, and whether reading it again gives the same facts.</p>
      <form class="xp-controls" id="raw-form" role="search" aria-label="Filter raw files">
        <label>Source<select id="raw-source">${sourceOptions()}</select></label>
        <label>Status<select id="raw-status"><option value="">Any status</option>${Object.entries(STATUS).map(([k, [, w]]) => `<option value="${k}">${esc(w)}</option>`).join('')}</select></label>
        <label>Fetched from<input type="date" id="raw-from" ${dateBounds().replace(/max="[^"]*"/, '')}></label>
        <label>to<input type="date" id="raw-to" ${dateBounds().replace(/max="[^"]*"/, '')}></label>
        <button type="button" class="btn" id="raw-clear">Clear filters</button>
      </form>
      <dl class="xp-ckey">${Object.values(STATUS).map(([c, w, m]) => `<div><dt><span class="badge ${c}">${esc(w)}</span></dt><dd>${esc(m)}</dd></div>`).join('')}</dl>
      <div id="raw-list"></div>`;
    const sync = () => { f.source = panel.querySelector('#raw-source').value; f.status = panel.querySelector('#raw-status').value; f.from = panel.querySelector('#raw-from').value; f.to = panel.querySelector('#raw-to').value; cursors = [null]; page = 0; keepHash(); drawList(); };
    panel.querySelector('#raw-form').addEventListener('change', sync);
    panel.querySelector('#raw-form').addEventListener('submit', (e) => { e.preventDefault(); sync(); });
    panel.querySelector('#raw-clear').addEventListener('click', () => { Object.assign(f, { source: '', status: '', from: '', to: '' }); setControls(panel); cursors = [null]; page = 0; keepHash(); drawList(); });
    const list = panel.querySelector('#raw-list');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rpg]');
      if (b && !b.disabled) { page = Number(b.dataset.rpg); drawList().then(() => list.querySelector('.xp-pager button:not([disabled])')?.focus()); return; }
      const tr = e.target.closest('tr[data-open]');
      if (tr && !e.target.closest('button, a')) openRaw(tr.dataset.open, tr.querySelector('button[data-raw]'));
    });
    setControls(panel);
    await drawList();
  } else if (changed) { setControls(panel); await drawList(); }
  const id = p.get('id');
  if (id && String(id) !== String(openId ?? '')) openRaw(id);
}
function setControls(panel) {
  panel.querySelector('#raw-source').innerHTML = sourceOptions();
  panel.querySelector('#raw-status').value = f.status;
  panel.querySelector('#raw-from').value = f.from;
  panel.querySelector('#raw-to').value = f.to;
}

// ───── The drawer ─────
function verdictHtml(rd) {
  if (!rd) return '';
  if (!rd.supported) {
    return `<div class="xp-verdict"><span class="badge planned">Not re-checked</span>
      <p>${rd.stored_count ? `This file produced ${plural(rd.stored_count, 'fact', 'facts')}, but its` : 'This'} source cannot be re-read automatically yet, so the file was not run through the code again. This is not an error: the checks (Overview and Slot inspector) compare the values published in the file with the stored facts instead.</p>
      ${rd.reason ? `<details class="xp-details"><summary>Why not, in technical terms</summary><p class="xp-foot mono xp-wrap">${esc(rd.reason)}</p></details>` : ''}</div>`;
  }
  if (rd.ok) {
    const n = rd.rederived_count ?? rd.stored_count ?? 0;
    return `<div class="xp-verdict is-ok"><span class="badge good"><span aria-hidden="true">✓</span> Same result</span>
      <p>${n ? `We read this file again with the same code and got the same <b>${count(n)}</b> ${n === 1 ? 'fact' : 'facts'} as are stored.` : 'We read this file again with the same code: as before, it produces no facts.'}</p></div>`;
  }
  const diffs = rd.diffs || [];
  return `<div class="xp-verdict is-bad"><span class="badge bad"><span aria-hidden="true">✗</span> Different result</span>
    <p>We read this file again with the same code and got <b>${count(rd.rederived_count)}</b> facts; <b>${count(rd.stored_count)}</b> are stored. ${diffs.length ? `${plural(diffs.length, 'value differs', 'values differ')}:` : ''}</p>
    ${diffs.length ? `<div class="table-wrap xp-scroll"><table class="xp-table"><thead><tr><th scope="col">Fact</th><th scope="col" class="r">Stored</th><th scope="col" class="r">Read again</th></tr></thead>
      <tbody>${diffs.map((d) => `<tr><td class="mono xp-wrap">${esc(d.key)}</td><td class="r">${d.stored == null ? '<span class="faint">not stored</span>' : val(d.stored)}</td><td class="r">${d.rederived == null ? '<span class="faint">not produced</span>' : val(d.rederived)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="xp-foot">A difference means the stored facts no longer match what this file says with today's code: either the parser changed, or the facts were corrected later.</p></div>`;
}

function factsHtml(d) {
  const facts = d.facts || [];
  const total = d.facts_total ?? facts.length;
  const byTable = d.facts_by_table ? Object.entries(d.facts_by_table).filter(([k, n]) => k !== 'total' && n) : [];
  if (!facts.length) return `<p class="faint">${d.meta?.status === 'quarantined' ? 'None: this file was quarantined.' : 'This file produced no facts.'}</p>`;
  const series = [...new Map(facts.map((x) => [x.series_id, x])).values()];
  const ts = facts.map((x) => x.ts ?? x.start_ts).filter((t) => t != null);
  const lo = Math.min(...ts); const hi = Math.max(...facts.map((x) => x.end_ts ?? x.ts ?? x.start_ts));
  const dLo = localDate(lo); const dHi = localDate(hi - 1);
  const slotOf = (t) => t - ((t - fromLocal(localDate(t), 0)) % ctx.slotS);
  const tables = [...new Set(facts.map((x) => x.table).filter(Boolean))];
  return `<p>It feeds ${plural(series.length, 'series', 'series')}${tables.length ? ` (stored in ${tables.map((x) => `<span class="mono">${esc(x)}</span>`).join(' and ')})` : ''}: ${series.map((s) => `<a class="xp-link" href="${esc(hashOf('facts', '', { series: s.series_id, from: dLo, to: dHi }))}">${esc(s.metric)} <span class="faint">#${esc(s.series_id)}</span></a>`).join(', ')};
      and the ${esc(slotNoun())}s from ${slotLink(slotOf(lo), T.dayTime(slotOf(lo)))} to ${slotLink(slotOf(hi - 1), T.dayTime(slotOf(hi - 1)))} (<a class="xp-link" href="${esc(hashOf('timeline', '', { from: dLo, to: dHi }))}">see them on the Timeline</a>).</p>
    ${byTable.length > 1 ? `<p class="xp-foot">${byTable.map(([k, n]) => `${count(n)} in <span class="mono">${esc(k)}</span>`).join(', ')}.</p>` : ''}
    ${total > facts.length || d.facts_truncated ? `<p class="xp-foot">Showing the first ${count(facts.length)} of ${count(total)} facts.</p>` : ''}
    <div class="table-wrap xp-scroll xp-tall"><table class="xp-table"><thead><tr><th scope="col">Series</th><th scope="col">Time</th><th scope="col" class="r">Value</th><th scope="col">Recorded</th><th scope="col">Version</th></tr></thead>
    <tbody>${facts.map((x) => {
      const t = x.ts ?? x.start_ts;
      return `<tr class="${x.superseded_at ? 'superseded' : ''}"><td>${seriesLink(x.series_id, `${x.metric} #${x.series_id}`)}</td>
        <td>${t != null ? slotLink(slotOf(t), x.end_ts ? T.span(t, x.end_ts) : T.dayTime(t)) : '–'}</td>
        <td class="r">${val(x.value)}</td><td>${esc(T.stamp(x.recorded_at))}</td><td>${x.superseded_at ? `replaced ${esc(T.stamp(x.superseded_at))}` : 'current'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

let opener = null;
/** Open raw payload #id in the drawer (from any tab). */
export async function openRaw(id, from = document.activeElement) {
  const dlg = document.getElementById('xp-drawer');
  if (!dlg) return;
  opener = from instanceof HTMLElement ? from : null;
  openId = id;
  if (readHash().tab === 'raw') keepHash();
  dlg.innerHTML = `<div class="xp-dhead"><h2 id="xp-drawer-title">Raw file #${esc(id)}</h2><button type="button" class="btn icon-btn" data-close aria-label="Close">✕</button></div><div class="xp-dbody">${loading('Opening the file…')}</div>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-close]').focus();
  let d;
  try { d = await get(ep(`raw/${encodeURIComponent(id)}`)); } catch (err) {
    if (String(openId) === String(id)) dlg.querySelector('.xp-dbody').innerHTML = errorBox(`Raw file #${id} could not be opened`, err);
    return;
  }
  if (String(openId) !== String(id) || !dlg.open) return;
  const m = d.meta || {};
  const body = typeof d.body === 'string' ? d.body : d.body == null ? '' : JSON.stringify(d.body);
  const shownBytes = new Blob([body]).size;
  dlg.querySelector('.xp-dbody').innerHTML = `
    <dl class="xp-meta">
      <div><dt>Source</dt><dd class="mono">${esc(m.source)}</dd></div>
      <div><dt>Fetched</dt><dd>${esc(T.stamp(m.fetched_at))}</dd></div>
      <div><dt>Status</dt><dd>${statusBadge(m.status)}${m.reason ? ` ${esc(m.reason)}` : ''}</dd></div>
      <div><dt>Size</dt><dd>${esc(bytes(m.size))}</dd></div>
      <div><dt>Facts made</dt><dd>${count(d.facts_total ?? m.facts_linked ?? 0)}</dd></div>
      <div class="wide"><dt>Request</dt><dd class="mono xp-wrap">${esc(requestText(m.request) || '–')}</dd></div>
      ${m.file ? `<div class="wide"><dt>Stored as</dt><dd class="mono xp-wrap">${esc(m.file)}</dd></div>` : ''}
      <div class="wide"><dt>Fingerprint</dt><dd class="mono xp-wrap" title="A hash of the exact bytes: the same file always has the same fingerprint">${esc(m.hash || '–')}</dd></div>
    </dl>
    <section class="xp-dsec" aria-labelledby="xp-d-rd"><h3 id="xp-d-rd">Read it again: same facts?</h3>${verdictHtml(d.rederive)}</section>
    <section class="xp-dsec" aria-labelledby="xp-d-f"><h3 id="xp-d-f">Facts produced from this file</h3>${factsHtml(d)}</section>
    <section class="xp-dsec" aria-labelledby="xp-d-b"><h3 id="xp-d-b">What the provider sent</h3>
      ${m.file_found === false || (d.body == null && m.status !== 'quarantined') ? `<p class="xp-msg warn"><b>The file is not on this machine.</b> The database lists it as <span class="mono">${esc(m.file || '–')}</span>, but it was not found next to the database (a copied database often comes without its raw files).</p>` : ''}
      ${m.redacted ? `<p class="xp-foot">${plural(m.redacted, 'value that looked like a secret was', 'values that looked like secrets were')} hidden before sending.</p>` : ''}
      ${d.truncated ? `<p class="xp-msg warn"><b>Only the start of the file is shown.</b> The file is ${esc(bytes(m.size))}; the first ${esc(bytes(shownBytes))} were sent to the browser, so the end is cut off${d.json_ok ? '' : ' and it cannot be shown as a tree'}. The stored file itself is complete.</p>` : ''}
      ${!d.json_ok && !d.truncated && body ? '<p class="xp-foot">This file is not JSON, so it is shown as plain text (never run as a web page).</p>' : ''}
      <div id="xp-body"></div></section>`;
  jsonViewer(dlg.querySelector('#xp-body'), { body, jsonOk: !!d.json_ok });
}

export function closeDrawer() {
  const dlg = document.getElementById('xp-drawer');
  if (dlg?.open) dlg.close();
}
/** Wire the drawer once: close button, Esc (native), click on the backdrop; focus goes back to the opener. */
export function wireDrawer(dlg) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { dlg.close(); return; }
    if (e.target === dlg) { const r = dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close(); }
  });
  dlg.addEventListener('close', () => {
    openId = null;
    if (readHash().tab === 'raw') keepHash();
    if (opener?.isConnected) opener.focus({ preventScroll: false });
    opener = null;
  });
}
