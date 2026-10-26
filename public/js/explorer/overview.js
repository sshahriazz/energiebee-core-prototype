// Overview tab: how much data this home has at each stage (raw files → facts → slots → checks), how
// complete each day is, the sources and their raw volume, and a "validate this period" run that lists
// what failed with links into the Slot inspector.
import {
  ctx, get, ep, loading, emptyBox, errorBox, loadOverview, lastDays, dateBounds, count, bytes, plural, T, esc, slotNoun, slotNouns,
  stateLegend, hashOf, pagerHtml, dayDiff, addDays,
} from './util.js';
import { coverageStripHtml } from './charts.js';
import { summaryHtml, checkHtml, CHECK_KEY } from './checks.js';

let built = false;
let val = { from: '', to: '', all: false, page: 0, data: null, err: null, busy: false };
const PAGE = 10;
export function reset() { built = false; val = { from: '', to: '', all: false, page: 0, data: null, err: null, busy: false }; }
export const hashState = () => ({ value: '', params: {} });

const card = (id, title, note, body, cls = '') => `<section class="card section xp-card ${cls}" id="${id}" aria-labelledby="${id}-h"><div class="card-head"><div><h2 id="${id}-h">${title}</h2>${note ? `<p>${note}</p>` : ''}</div></div>${body}</section>`;

/** Final / provisional / missing per day. Takes the API's days[] if it has counts, else counts the rows. */
export async function dayCoverage(from, to) {
  const norm = (d) => {
    const f = d.final ?? d.slots_final ?? 0; const p = d.provisional ?? d.slots_provisional ?? 0; const m = d.missing ?? d.slots_missing ?? 0;
    return { local_date: d.local_date || d.date, slots: d.slots ?? f + p + m, final: f, provisional: p, missing: m };
  };
  const t = await get(ep('timeline', { from, to, cols: '', limit: 1 }));
  const days = (t.days || []).filter((d) => d && typeof d === 'object' && (d.local_date || d.date));
  if (days.length && days.some((d) => d.final != null || d.slots_final != null)) return days.map(norm);
  const n = dayDiff(from, to) + 1;
  const full = await get(ep('timeline', { from, to, cols: '', limit: n * Math.ceil(86400 / ctx.slotS) + n * 4 }));
  const by = new Map();
  for (const r of full.rows || []) {
    const d = by.get(r.local_date) || { local_date: r.local_date, slots: 0, final: 0, provisional: 0, missing: 0 };
    d.slots++; if (d[r.state] != null) d[r.state]++;
    by.set(r.local_date, d);
  }
  return [...by.values()].sort((a, b) => (a.local_date < b.local_date ? -1 : 1));
}

function pathHtml(o) {
  const facts = (o.sources || []).reduce((a, s) => a + (s.facts || 0), 0);
  const tl = o.timeline || {};
  const pct = tl.slots ? Math.round(((tl.final || 0) / tl.slots) * 100) : null;
  const step = (n, href, big, label, note) => `<li class="xp-pstep"><span class="path-n" aria-hidden="true">${n}</span><div><a href="${href}" class="xp-pbig">${big}</a><b>${label}</b><p>${note}</p></div></li>`;
  return `<ol class="xp-path" aria-label="How the data moves through the core">
    ${step(1, '#raw', count(o.raw?.count || 0), `raw files · ${esc(bytes(o.raw?.bytes))}`, 'What the providers sent, kept exactly as received, from ' + plural((o.raw?.by_source || []).length, 'source', 'sources') + '.')}
    ${step(2, '#facts', count(facts), `facts in ${plural(o.series_count || 0, 'series', 'series')}`, 'Each reading taken out of a raw file, with the moment we learnt it. A correction is added as a new version; nothing is overwritten.')}
    ${step(3, '#timeline', count(tl.slots || 0), `${esc(slotNouns())}${pct != null ? ` · ${pct}&nbsp;% final` : ''}`, `One row per ${esc(slotNoun())}: energy, money and carbon worked out from the facts.${tl.restated ? ` ${plural(tl.restated, `${slotNoun()} was`, `${slotNouns()} were`)} revised after first being final.` : ''}`)}
    ${step(4, '#overview&go=validate', `${count(o.checks?.fail || 0)} <small>failed</small>`, 'cross-checks', `Each ${esc(slotNoun())} compared with independent sources. ${summaryHtml(o.checks)}`)}
  </ol>`;
}

function sourcesHtml(o) {
  const rows = (o.sources || []).map((s) => `<tr><th scope="row"><a class="xp-link mono" href="${esc(hashOf('facts', '', { source: s.code }))}" title="See this source's series">${esc(s.code)}</a></th><td class="r">${count(s.series)}</td><td class="r">${count(s.facts)}</td>
    <td>${esc(s.first_ts ? T.dayTime(s.first_ts) : '–')}</td><td>${esc(s.last_ts ? T.dayTime(s.last_ts) : '–')}</td></tr>`).join('');
  return rows ? `<div class="table-wrap"><table class="xp-table"><caption class="sr-only">Facts per source</caption><thead><tr><th scope="col">Source</th><th scope="col" class="r">Series</th><th scope="col" class="r">Facts</th><th scope="col">First reading</th><th scope="col">Latest reading</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="faint">No facts stored yet.</p>';
}

function rawHtml(o) {
  const list = [...(o.raw?.by_source || [])].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  if (!list.length) return '<p class="faint">No raw files stored yet.</p>';
  const top = Math.max(1, ...list.map((s) => s.bytes || 0));
  return `<ul class="xp-rawvol">${list.map((s) => `<li>
      <span class="xp-rv-name"><a class="xp-link mono" href="${esc(hashOf('raw', '', { source: s.source }))}">${esc(s.source)}</a></span>
      <span class="xp-rv-bar" aria-hidden="true"><i style="width:${Math.max(1, ((s.bytes || 0) / top) * 100)}%"></i></span>
      <span class="xp-rv-num"><b>${esc(bytes(s.bytes))}</b> in ${plural(s.count || 0, 'file', 'files')}</span>
      <span class="xp-rv-when">${s.first_at ? `${esc(T.day(s.first_at))} to ${esc(T.dayTime(s.last_at))}` : ''}${s.unlinked ? ` · <span class="xp-warn-text">${plural(s.unlinked, 'file', 'files')} made no new facts</span>` : ''}${s.missing_files ? ` · <span class="xp-warn-text">${plural(s.missing_files, 'file is', 'files are')} not on this machine</span>` : ''}</span>
    </li>`).join('')}</ul>
    <p class="xp-foot">A file that made no new facts is usually fine: a re-fetch whose values were already held (unchanged facts are not stored twice), or a tariff list. A quarantined file is different: open it on the Raw data tab to see why.${o.raw?.shared ? ` ${plural(o.raw.shared, 'catalogue file belongs', 'catalogue files belong')} to no single home.` : ''}</p>`;
}

function validateHtml() {
  if (val.busy) return loading('Running the checks…');
  if (val.err) return errorBox('The checks could not be run', val.err);
  if (!val.data) return '<p class="faint">Pick a period and run the checks to list what failed, each with a link to the ' + esc(slotNoun()) + ' in the Slot inspector.</p>';
  const d = val.data;
  const checks = d.checks || [];
  const problems = checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  const shown = (val.all ? checks : problems).slice().sort((a, b) => ['fail', 'warn', 'pass', 'skip'].indexOf(a.status) - ['fail', 'warn', 'pass', 'skip'].indexOf(b.status) || (a.evidence?.ts ?? 0) - (b.evidence?.ts ?? 0));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  val.page = Math.min(val.page, pages - 1);
  const head = `${val.clamped ? '<p class="xp-msg warn">The checks run on at most 31 days at once, so the period was shortened to the last 31 days of your choice.</p>' : ''}<div class="xp-vhead"><span>${plural(checks.length, 'check', 'checks')} from ${esc(T.date(val.from))} to ${esc(T.date(val.to))}:</span> ${summaryHtml(d.summary)}</div>`;
  const toggle = `<label class="xp-check-toggle"><input type="checkbox" id="ov-all" ${val.all ? 'checked' : ''}> Show the checks that passed or were skipped too</label>`;
  if (!shown.length) return `${head}${toggle}<p class="xp-ok-line"><span class="badge good"><span aria-hidden="true">✓</span> All clear</span> Nothing failed or warned in this period.</p>`;
  return `${head}${toggle}<ul class="xp-checks">${shown.slice(val.page * PAGE, (val.page + 1) * PAGE).map((c) => checkHtml(c)).join('')}</ul>${pagerHtml(val.page, pages, 'checks')}`;
}

function drawValidate() {
  const box = document.getElementById('ov-vresult');
  if (box) box.innerHTML = validateHtml();
}

async function runValidate() {
  val.busy = true; val.err = null; val.page = 0; drawValidate();
  try { val.data = await get(ep('validate', { from: val.from, to: val.to })); } catch (err) { val.err = err; val.data = null; }
  val.busy = false; drawValidate();
}

export async function show(panel, h) {
  if (built) { if (h?.params?.get('go') === 'validate') document.getElementById('ov-validate')?.scrollIntoView({ block: 'start' }); return; }
  built = true;
  panel.innerHTML = loading('Reading the overview…');
  let o;
  try { o = await loadOverview(); } catch (err) { built = false; panel.innerHTML = errorBox('The overview could not be loaded', err); return; }
  const tl = o.timeline || {};
  if (!tl.slots && !o.raw?.count && !o.series_count) {
    panel.innerHTML = emptyBox('This home has no data yet', 'No raw files, facts or slots are stored for it. Once a sync has fetched data from its providers, it all appears here.');
    return;
  }
  const r = o.range || {};
  if (!val.from) Object.assign(val, lastDays(7));
  panel.innerHTML = `
    <p class="xp-lead">Data for <b>${esc(T.date(r.first_date))}</b> to <b>${esc(T.date(r.last_date))}</b>, in ${esc(slotNouns())} (${esc(Math.round((o.slot_s || ctx.slotS) / 60))} minutes), money in ${esc(o.currency || ctx.currency)}.
      For the plain summary of why the numbers can be trusted, see <a href="/data?site=${esc(ctx.siteId)}#proof">Data &amp; trust</a>; this page lets you dig into every step.</p>
    ${pathHtml(o)}
    ${card('ov-days', 'How complete each day is', `Each column is one day: the share of its ${esc(slotNouns())} that are final, provisional or missing. Select a day to see it on the Timeline tab.`, `<div id="ov-strip">${loading('Counting the days…')}</div>${stateLegend()}`)}
    <div class="grid cols-2 xp-pair">
      ${card('ov-sources', 'Facts per source', 'Every series is a stream of readings from one source. Select a source to see its series.', sourcesHtml(o))}
      ${card('ov-raw', 'Raw files per source', 'How much each provider sent, by size.', rawHtml(o))}
    </div>
    ${card('ov-validate', 'Checks', `Every ${esc(slotNoun())} is compared with independent sources. Over all the data: ${summaryHtml(o.checks)}`,
      `${CHECK_KEY}
      <form class="xp-controls" id="ov-vform">
        <label>From<input type="date" id="ov-from" value="${esc(val.from)}" ${dateBounds()} required></label>
        <label>To<input type="date" id="ov-to" value="${esc(val.to)}" ${dateBounds()} required></label>
        <button class="btn btn-primary" type="submit">Validate this period</button>
      </form>
      <div id="ov-vresult" aria-live="polite">${validateHtml()}</div>`)}`;

  // Days strip (its own request: it may be slow on a long history).
  const strip = document.getElementById('ov-strip');
  const days = lastDays(366);
  dayCoverage(days.from, days.to).then((list) => {
    if (!strip.isConnected) return;
    strip.innerHTML = `${coverageStripHtml(list, { href: (d) => hashOf('timeline', '', { from: d, to: d }) })}
      <details class="xp-details"><summary>Show as a table</summary><div class="table-wrap xp-scroll"><table class="xp-table"><thead><tr><th scope="col">Day</th><th scope="col" class="r">${esc(slotNouns().replace(/^./, (c) => c.toUpperCase()))}</th><th scope="col" class="r">Final</th><th scope="col" class="r">Provisional</th><th scope="col" class="r">Missing</th></tr></thead>
      <tbody>${list.slice().reverse().map((d) => `<tr><th scope="row"><a class="xp-link" href="${esc(hashOf('timeline', '', { from: d.local_date, to: d.local_date }))}">${esc(T.date(d.local_date))}</a></th><td class="r">${count(d.slots)}</td><td class="r">${count(d.final)}</td><td class="r">${d.provisional ? count(d.provisional) : '0'}</td><td class="r">${d.missing ? `<span class="bad-text">${count(d.missing)}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }).catch((err) => { if (strip.isConnected) strip.innerHTML = errorBox('The days could not be counted', err); });

  document.getElementById('ov-vform').addEventListener('submit', (e) => {
    e.preventDefault();
    val.from = document.getElementById('ov-from').value; val.to = document.getElementById('ov-to').value;
    if (val.from && val.to && val.from > val.to) [val.from, val.to] = [val.to, val.from];
    val.clamped = false;
    if (val.from && val.to && dayDiff(val.from, val.to) > 30) { val.from = addDays(val.to, -30); val.clamped = true; document.getElementById('ov-from').value = val.from; }
    runValidate();
  });
  const res = document.getElementById('ov-vresult');
  res.addEventListener('change', (e) => { if (e.target.id === 'ov-all') { val.all = e.target.checked; val.page = 0; drawValidate(); document.getElementById('ov-all')?.focus(); } });
  res.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pg]');
    if (!b || b.disabled) return;
    val.page = Number(b.dataset.pg); drawValidate();
    res.querySelector('.xp-pager button:not([disabled])')?.focus();
  });
  if (h?.params?.get('go') === 'validate') document.getElementById('ov-validate')?.scrollIntoView({ block: 'start' });
}
