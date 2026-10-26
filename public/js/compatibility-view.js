// Compatibility page views: pure functions from the /api/compatibility JSON to HTML strings (no DOM),
// so they run in node tests too. Every text that comes from the API goes through esc() (code`spans`
// are turned into <code> after escaping). A status is always a word, never a colour only: found and
// missing places carry the words "found" and "missing", every badge says what it means.
import { esc, ago } from './api.js';

export const PAGE_SIZE = 25;

// An item's status: [badge class, word, meaning]. 'target_missing' is a covered item whose place the
// live check did not find in this database.
export const ITEM_STATUS = {
  covered: ['good', 'Covered', 'every piece of data it names has a place in the database, and the live check found each place'],
  target_missing: ['bad', 'Missing now', 'marked covered, but the live check did not find at least one of its places in this database'],
  excluded_not_data: ['planned', 'Excluded: not data', 'not data at all (Home Assistant wiring, screen layout, a fixed code rule or an archived key); the reason is given'],
  gap: ['bad', 'Gap', 'data that has no place in the database yet'],
};
export const STATUS_ORDER = ['covered', 'target_missing', 'excluded_not_data', 'gap'];
export const PRODUCT_WORD = { predbat: 'Predbat', predheat: 'PredHeat', planning_design: 'Planning design' };
export const KIND_WORD = {
  table_column: 'column', registry_key: 'registry row', metric: 'metric', source: 'source',
  device_action: 'device action', view: 'view', read_function: 'read function',
};
const DIR_WORD = {
  'input config': 'set-up value', 'live input': 'live reading', history: 'history', output: 'output',
  control: 'command to a device', state: 'carried state', rule: 'rule',
};

const n = (v) => Number(v ?? 0).toLocaleString('en-GB');
const plural = (k, one, many) => `${n(k)} ${Number(k) === 1 ? one : many}`;
export const statusOf = (it) => (it.live === 'target_missing' ? 'target_missing' : it.status);
export const statusBadge = (s) => { const [cls, word] = ITEM_STATUS[s] || ['', String(s || 'unknown')]; return `<span class="badge ${cls}">${esc(word)}</span>`; };
/** Escaped text with `code` spans as <code> (the docs' markdown back-ticks). */
export const codeText = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
/** A review note as a sentence: a capital first letter, unless it starts with a code name (num_inverters, plan_run.x). */
const capital = (s) => { const t = String(s ?? '').trim(); return /^[a-z]+(?=[\s,:;)]|$)/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t; };
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>`]+$/.test(u) ? u : null);
const mark = (ok) => (ok ? '<span class="compat-mark ok"><span aria-hidden="true">✓</span> found</span>' : '<span class="compat-mark bad"><span aria-hidden="true">✗</span> missing</span>');
const findLink = (id) => `<a href="#evidence" class="compat-find mono" data-find="${esc(id)}">${esc(id)}</a>`;
const targetRef = (t) => `${t.ref}${t.json_key ? `#${t.json_key}` : ''}`;

// ───── (a) The headline ─────

/** The answer, the live-check badge and the honest limit. A missing place turns the card red and lists it. */
export function heroHtml(d, nowMs = Date.now()) {
  const s = d.summary || {};
  const lc = d.live_check || {};
  const ok = !!lc.ok;
  const checkedTs = Math.floor(Date.parse(d.generated_at) / 1000);
  const checked = Number.isFinite(checkedTs) ? `checked ${esc(ago(Math.min(checkedTs, Math.floor(nowMs / 1000))))}` : 'checked just now';
  const total = n((lc.targets_checked || 0) + (lc.how_targets_checked || 0));
  const missingAll = [...(lc.missing || []).map((m) => ({ who: m.item, ...m })), ...(lc.how_missing || []).map((m) => ({ who: m.title || m.entry, ...m }))];
  const badge = ok
    ? `<span class="badge good compat-live-badge"><span aria-hidden="true">✓</span> Live check passed</span>`
    : `<span class="badge bad compat-live-badge"><span aria-hidden="true">✗</span> Live check failed</span>`;
  const liveLine = ok
    ? `All ${total} places named below were just looked up in this database and found.`
    : `${plural(missingAll.length, 'place was', 'places were')} not found in this database${lc.catalogue_matches_matrix === false ? ', and the coverage matrix was built from a different catalogue than the one on disk' : ''}.`;
  const answer = ok
    ? `<b>Yes, for storing and reading the data.</b> <span class="compat-big">${n(s.verified_covered)} of ${n(s.verified_data_items)}</span> verified data items have a home in the database.`
    : `<b>Not fully: something is missing.</b> <span class="compat-big">${n(s.verified_covered)} of ${n(s.verified_data_items)}</span> verified data items have a home in this database right now.`;
  const missingList = missingAll.length
    ? `<div class="compat-missing" role="alert"><b>Not found in this database</b><ul>${missingAll.slice(0, 30).map((m) => `<li>${m.item ? findLink(m.item) : `<a href="#how">“${esc(m.who)}”</a> (how they read)`} needs the ${esc(KIND_WORD[m.kind] || m.kind)} <code>${esc(targetRef(m))}</code> ${mark(false)}</li>`).join('')}</ul>${missingAll.length > 30 ? `<p>and ${n(missingAll.length - 30)} more.</p>` : ''}</div>`
    : '';
  const stat = (big, label, note) => `<div class="proof-stat"><div class="big">${big}</div><div class="label">${label}</div><div class="note">${note}</div></div>`;
  return `<section class="card compat-hero ${ok ? 'ok' : 'bad'}" aria-labelledby="compat-q">
    <h2 id="compat-q" class="compat-question">${esc(d.headline?.question || 'Is our database ready for Predbat and PredHeat?')}</h2>
    <p class="compat-answer">${answer}</p>
    <div class="compat-live" role="status">${badge} <span>${esc(liveLine)}</span> <span class="faint">${checked}; re-checked at most once every ${esc(lc.cache_s || 60)} s.</span></div>
    ${missingList}
    <p class="compat-limit"><b>The limit.</b> ${esc(d.headline?.limit || '')}</p>
    <div class="proof-stats compat-stats">
      ${stat(`${n(s.covered_found)} of ${n(s.data_items)}`, 'data items covered', `All ${n(s.items)} catalogue items, less the ${n(s.excluded)} that are not data.`)}
      ${stat(`${s.percent_verified_covered ?? '–'}&nbsp;%`, 'of verified data items', 'Read in Predbat\'s or PredHeat\'s own docs or code: the measure of 100&nbsp;%.')}
      ${stat(n(s.excluded), 'excluded: not data', 'Wiring, layout, fixed rules, archived keys. Each has a reason below.')}
      ${stat(n(s.gaps), s.gaps === 1 ? 'gap' : 'gaps', 'Data with no place yet.')}
      ${stat(`${n(s.unverified_covered)} of ${n(s.unverified_data_items)}`, 'unverified items covered', 'Counted apart: not found in a fetched source.')}
    </div>
  </section>`;
}

// ───── (b) How they read data, and where it lives here ─────

const productPills = (list = []) => list.map((p) => `<span class="pill">${esc(PRODUCT_WORD[p] || p)}</span>`).join('');

export function howHtml(d) {
  const rows = (d.how_it_consumes || []).map((h) => {
    const where = (h.where_it_lives_in_our_db || []).map((w) => `<li class="compat-chip${w.exists ? '' : ' bad'}" title="${esc(KIND_WORD[w.kind] || w.kind)}: ${w.exists ? 'found' : 'missing'}"><code>${esc(w.ref)}</code> ${w.exists ? '<span class="compat-mark ok"><span aria-hidden="true">✓</span><span class="sr-only"> found</span></span>' : mark(false)}</li>`).join('');
    const fn = h.read_function || {};
    const dot = String(fn.ref || '').indexOf('.');
    const fnName = dot > 0 ? fn.ref.slice(dot + 1) : fn.ref;
    return `<tr>
      <th scope="row">${h.title ? `<span class="q compat-htitle">${esc(h.title)}</span>` : ''}<span class="compat-what">${esc(h.what_they_read)}</span>
        <span class="compat-pills">${productPills(h.products)}</span>
        ${h.their_names?.length ? `<small>Their names: ${h.their_names.map((x) => `<code>${esc(x)}</code>`).join(', ')}</small>` : ''}
        ${h.items?.length ? `<small>Catalogue items: ${h.items.map((i) => findLink(i.id)).join(' ')}</small>` : ''}</th>
      <td data-label="Where it lives here"><ul class="compat-chips" aria-label="Places in the database">${where}</ul></td>
      <td data-label="Read through" class="compat-fn"><code title="${esc(fn.ref)}">${esc(fnName)}()</code> ${mark(!!fn.exists)}${fn.file ? `<small>in <span class="mono">${esc(fn.file)}</span></small>` : ''}</td>
      <td data-label="Why this is compatible" class="compat-why">${esc(h.why_compatible)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap compat-how-wrap"><table class="compat-how">
    <caption class="sr-only">How Predbat and PredHeat read data, where it lives in our database, the function that reads it, and why this is compatible</caption>
    <thead><tr><th scope="col">What they read</th><th scope="col">Where it lives here</th><th scope="col">Read through</th><th scope="col">Why this is compatible</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="compat-foot">A <span class="compat-mark ok"><span aria-hidden="true">✓</span> found</span> mark means the place was just looked up in this database (a column by its table's columns, a registry row, metric, source, device action or view by its row, a function by its module's exports).</p>`;
}

// ───── (c) Coverage by group ─────

function groupRow(g, { strong = false } = {}) {
  const p = g.percent_covered;
  const bar = `<span class="compat-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, Number(p) || 0))}%"></i></span>`;
  const extra = [
    `${plural(g.excluded, 'excluded', 'excluded')} (not data)`,
    plural(g.gaps, 'gap', 'gaps'),
    ...(g.target_missing ? [`<span class="bad-text">${plural(g.target_missing, 'missing now', 'missing now')}</span>`] : []),
  ].join(' · ');
  return `<li class="compat-grow${strong ? ' total' : ''}">
    <span class="compat-glabel">${strong ? `<b>${esc(g.label)}</b>` : `${esc(g.label)} <span class="mono faint">${esc(g.id)}</span>`}</span>
    <span class="compat-gbar">${bar}<b>${p == null ? '–' : `${esc(p)}&nbsp;%`}</b></span>
    <span class="compat-gtext">${n(g.covered_found)} of ${plural(g.data_items, 'data item', 'data items')} covered <span class="faint">· ${plural(g.items, 'item', 'items')} in all · ${extra}</span></span>
  </li>`;
}

export function groupsHtml(d) {
  return (d.products || []).map((p) => {
    const groups = (d.groups || []).filter((g) => g.product === p.id);
    return `<div class="compat-product">
      <h3>${esc(p.label)} <span class="faint">${esc(p.note || '')}</span></h3>
      <ul class="compat-groups">${groups.length > 1 ? groupRow({ ...p, label: `${p.label}: all ${groups.length} groups` }, { strong: true }) : ''}${groups.map((g) => groupRow(g)).join('')}</ul>
    </div>`;
  }).join('');
}

// ───── (d) Explore the evidence ─────

export const FILTER_KEYS = ['q', 'product', 'group', 'status', 'dir', 'ver'];
export const emptyFilters = () => ({ q: '', product: '', group: '', status: '', dir: '', ver: '' });

/** Items matching the filters: product, group, status (incl. target_missing), direction, verified, text on id and name. */
export function applyFilters(items, f = {}) {
  const q = String(f.q || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  return items.filter((it) => (!f.product || it.product === f.product)
    && (!f.group || it.group === f.group)
    && (!f.status || statusOf(it) === f.status)
    && (!f.dir || (it.direction || []).includes(f.dir))
    && (!f.ver || (f.ver === 'verified' ? it.verified : !it.verified))
    && (!words.length || words.every((w) => `${it.id} ${it.name}`.toLowerCase().includes(w))));
}

export function filterOptions(d) {
  const items = d.items || [];
  const dirs = [...new Set(items.flatMap((i) => i.direction || []))];
  const statuses = STATUS_ORDER.filter((s) => s !== 'target_missing' || items.some((i) => statusOf(i) === s));
  return { dirs, statuses };
}

export function controlsHtml(d, f) {
  const { dirs, statuses } = filterOptions(d);
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="conn-filters compat-filters" role="search" aria-label="Search and filter the catalogue items">
    <label for="f-q" class="compat-search">Search id or name<input type="search" id="f-q" value="${esc(f.q)}" placeholder="e.g. PB-RATE or heat loss" autocomplete="off" spellcheck="false"></label>
    <label for="f-product">Product<select id="f-product">${opt('', 'All products', f.product)}${(d.products || []).map((p) => opt(p.id, p.label, f.product)).join('')}</select></label>
    <label for="f-group">Group<select id="f-group">${groupOptions(d, f)}</select></label>
    <label for="f-status">Status<select id="f-status">${opt('', 'Any status', f.status)}${statuses.map((s) => opt(s, ITEM_STATUS[s][1], f.status)).join('')}</select></label>
    <label for="f-dir">Direction<select id="f-dir">${opt('', 'Any direction', f.dir)}${dirs.map((x) => opt(x, `${x} (${DIR_WORD[x] || x})`, f.dir)).join('')}</select></label>
    <label for="f-ver">Catalogue<select id="f-ver">${opt('', 'Verified and unverified', f.ver)}${opt('verified', 'Verified only', f.ver)}${opt('unverified', 'Unverified only', f.ver)}</select></label>
    <button type="button" class="btn" id="f-clear">Clear</button>
  </div>
  <p class="conn-count compat-count" id="f-count" role="status" aria-live="polite"></p>`;
}

/** The group options, by product (only the chosen product's groups when one is chosen). */
export function groupOptions(d, f) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const products = (d.products || []).filter((p) => !f.product || p.id === f.product);
  return `${opt('', 'All groups', f.group)}${products.map((p) => `<optgroup label="${esc(p.label)}">${(d.groups || []).filter((g) => g.product === p.id).map((g) => opt(g.id, `${g.id}: ${g.label}`, f.group)).join('')}</optgroup>`).join('')}`;
}

/** One item as an expandable row: id, name, status word and flags; inside, its places with found / missing, its source and notes. */
export function itemHtml(it, d, open = false) {
  const s = statusOf(it);
  const group = (d.groups || []).find((g) => g.id === it.group);
  const conflict = it.conflict ? (d.conflicts || []).find((c) => c.n === it.conflict) : null;
  const codes = d.source_codes || {};
  const sources = (it.source_codes || []).map((c) => ({ code: c, ...codes[c] })).filter((x) => safeUrl(x.url));
  const sourceHtml = sources.length
    ? `${sources.map((x) => `<a href="${esc(safeUrl(x.url))}" rel="noopener noreferrer" target="_blank">${esc(x.label || x.code)}</a>`).join(' · ')}<small>Catalogue column: ${esc(it.source || '')}</small>`
    : `<span>No public link: ${esc(it.source || 'no source named')}</span>${it.product === 'planning_design' ? '<small>A planning document (local text extract), not a Predbat or PredHeat source.</small>' : ''}`;
  const targets = (it.targets || []).length
    ? `<ul class="compat-targets">${it.targets.map((t) => `<li>${mark(t.exists)} <span class="faint">${esc(KIND_WORD[t.kind] || t.kind)}</span> <code>${esc(t.ref)}</code>${t.json_key ? ` <span class="faint">JSON key</span> <code>${esc(t.json_key)}</code>` : ''}</li>`).join('')}</ul>`
    : '<span class="faint">None: not data, so nothing is stored.</span>';
  const flags = [
    !it.verified ? '<span class="badge warn">Unverified</span>' : '',
    it.conflict ? `<span class="badge info">Conflict ${esc(it.conflict)}</span>` : '',
  ].join(' ');
  return `<details class="compat-item" data-id="${esc(it.id)}"${open ? ' open' : ''}>
    <summary><span class="compat-id mono">${esc(it.id)}</span><span class="compat-name">${esc(it.name)}</span><span class="compat-tags">${statusBadge(s)} ${flags}</span></summary>
    <dl class="conn-facts compat-facts">
      <dt>Status</dt><dd>${statusBadge(s)} ${esc(ITEM_STATUS[s]?.[2] || '')}.</dd>
      <dt>Product</dt><dd>${esc(PRODUCT_WORD[it.product] || it.product)} · ${esc(group?.label || it.group)} <span class="mono faint">${esc(it.group)}</span></dd>
      <dt>Direction</dt><dd>${(it.direction || []).map((x) => `${esc(x)} <span class="faint">(${esc(DIR_WORD[x] || x)})</span>`).join(', ') || '<span class="faint">–</span>'}</dd>
      <dt>Catalogue</dt><dd>${it.verified ? 'Verified' : '<b>Unverified</b>'} <span class="faint">(${esc(it.catalogue_status || '')})</span></dd>
      <dt>Source</dt><dd>${sourceHtml}</dd>
      <dt>${it.status === 'excluded_not_data' ? 'Places' : 'Where it lives'}</dt><dd>${targets}</dd>
      ${it.reason ? `<dt>Why excluded</dt><dd>${esc(it.reason)}</dd>` : ''}
      ${it.gap ? `<dt>What is missing</dt><dd>${esc(it.gap.description || '')}</dd>` : ''}
      ${it.note ? `<dt>Note</dt><dd>${codeText(capital(it.note))}</dd>` : ''}
      ${conflict ? `<dt>Conflict</dt><dd>${esc(conflict.n)}. ${codeText(conflict.title)}: ${codeText(conflict.catalogue_text)}<small>What the schema chose: ${codeText(conflict.schema_choice || '')}</small></dd>` : ''}
    </dl>
  </details>`;
}

/** The current page of the filtered list, and a pager. */
export function listHtml(shown, d, page, openIds = new Set()) {
  if (!shown.length) return '<div class="card empty"><p>No catalogue item matches these filters.</p></div>';
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = shown.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  return `<div class="compat-items">${slice.map((it) => itemHtml(it, d, openIds.has(it.id))).join('')}</div>${pagerHtml(p, pages)}`;
}

export function pagerHtml(p, pages) {
  if (pages <= 1) return '';
  return `<nav class="compat-pager" aria-label="Pages of items">
    <button type="button" class="btn" data-page="${p - 1}"${p === 0 ? ' disabled' : ''}>← Previous</button>
    <span>Page ${n(p + 1)} of ${n(pages)}</span>
    <button type="button" class="btn" data-page="${p + 1}"${p >= pages - 1 ? ' disabled' : ''}>Next →</button>
  </nav>`;
}

export function countText(shownN, total, page) {
  if (!shownN) return `No item of ${n(total)} matches.`;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(shownN, (page + 1) * PAGE_SIZE);
  return `${shownN === total ? `All ${n(total)} items` : `${n(shownN)} of ${n(total)} items match`}; showing ${n(from)} to ${n(to)}.`;
}

// ───── (e) What "100 %" means, and what is excluded and why ─────

export function definitionHtml(d) {
  return `<p class="compat-lead">${esc(d.definition_plain || '')}</p>
    <details class="conn-more"><summary>The exact definition (from the coverage matrix)</summary><p>${esc(d.definition || '')}</p></details>`;
}

export function excludedHtml(d) {
  const list = d.excluded || [];
  if (!list.length) return '<p>No item is excluded.</p>';
  return `<ul class="compat-list">${list.map((x) => `<li><div>${findLink(x.id)} <b>${esc(x.name)}</b> <span class="faint">· ${esc(PRODUCT_WORD[x.product] || x.product)}</span></div>
    <p>${esc(capital(x.reason))}${x.note ? ` <span class="faint">${codeText(capital(x.note))}.</span>` : ''}</p></li>`).join('')}</ul>`;
}

// ───── (f) Conflicts and unverified items ─────

export function conflictsHtml(d) {
  const list = d.conflicts || [];
  const others = d.conflict_notes || [];
  return `<ol class="compat-list compat-conflicts">${list.map((c) => `<li><div><b>${esc(c.n)}. ${codeText(c.title)}</b> ${(c.items || []).map(findLink).join(' ')}</div>
      <p><span class="faint">What the sources say:</span> ${codeText(c.catalogue_text)}</p>
      <p><span class="faint">What the schema chose:</span> ${codeText(c.schema_choice || 'not recorded')}</p></li>`).join('')}</ol>
    ${others.length ? `<p class="compat-foot">Also noted as a conflict by the review, outside the catalogue's seven: ${others.map((o) => `${findLink(o.id)} ${esc(o.name)} (${codeText(o.note)})`).join('; ')}.</p>` : ''}`;
}

export function unverifiedHtml(d) {
  const list = d.unverified || [];
  if (!list.length) return '<p>Every item is verified.</p>';
  // The catalogue's status adds something only beyond the word itself ("unverified (PD only)").
  const extra = (s) => { const m = /^unverified\s*\((.+)\)$/.exec(String(s || '')); return m ? ` <span class="faint">(${esc(m[1])})</span>` : ''; };
  return `<ul class="compat-list">${list.map((u) => `<li><div>${findLink(u.id)} <b>${esc(u.name)}</b> ${statusBadge(u.live === 'target_missing' ? 'target_missing' : u.status)} <span class="badge warn">Unverified</span>${extra(u.catalogue_status)}</div>
    ${u.note || u.reason ? `<p>${codeText(capital(u.note || u.reason))}</p>` : ''}</li>`).join('')}</ul>`;
}

// ───── (g) Not built, (h) files ─────

export function notBuiltHtml(d) {
  return `<ul class="compat-list">${(d.what_is_not_built || []).map((x) => `<li><b>${esc(x.what)}</b><p>${esc(x.detail)}</p></li>`).join('')}</ul>`;
}

export function filesHtml(d) {
  const f = d.files || {};
  const t = d.tests || {};
  const rows = [
    [f.report, 'the full coverage report: counts, every exclusion, the review, known limits'],
    [f.catalogue, 'the requirements catalogue: every item, its sources and links, the conflicts'],
    [f.matrix, 'the coverage matrix: each item and the places it maps to'],
    [f.gaps, `the allow-list of gaps that cannot be stored by design${d.summary?.gaps === 0 ? ' (empty: there are no gaps)' : ''}`],
    [t.coverage_test, 'the test that checks every place exists in a fresh database'],
    [t.compatibility_test, 'the test of this page\'s API and its live check'],
  ].filter(([file]) => file);
  const codes = Object.entries(d.source_codes || {}).filter(([, s]) => safeUrl(s.url));
  return `<ul class="compat-files">${rows.map(([file, what]) => `<li><span class="mono">${esc(file)}</span> <span class="faint">${esc(what)}</span></li>`).join('')}</ul>
    ${codes.length ? `<details class="conn-more"><summary>The ${n(codes.length)} public sources the catalogue was read from</summary><ul class="compat-files">${codes.map(([code, s]) => `<li><span class="mono">${esc(code)}</span> <a href="${esc(safeUrl(s.url))}" rel="noopener noreferrer" target="_blank">${esc(s.label)}</a></li>`).join('')}</ul></details>` : ''}`;
}
