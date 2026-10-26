// Connectors page views: pure functions from the /api/connectors JSON to HTML strings (no DOM), so
// they run in node tests too. Every text that comes from the API goes through esc(). A status is
// always a word on a badge, never a colour only.
import { esc, ago, originBadge, originLegend } from './api.js';
import { roleLabel, SCOPE_WORD } from './providers-ui.js';

// A connector's status: [badge class, word, meaning]. Problems first.
export const CONNECTOR_STATUS = {
  error: ['bad', 'Error', 'built and switched on, but its latest run failed for at least one home; the error is shown on the card'],
  needs_credentials: ['warn', 'Needs credentials', 'built and switched on, but no home has the keys or login it needs (the core has no secret store: they are read from .env, for the .env home only)'],
  connected: ['good', 'Connected', 'built and switched on, and its latest run worked for at least one real home (demo homes never count)'],
  available: ['info', 'Available', 'built and switched on, but nothing has run yet: no home is connected, no sync has run since, or no real home is in its markets'],
  disabled: ['', 'Disabled', 'built, but switched off, its licence is unconfirmed or another process owns it; the reason says which'],
  not_built: ['planned', 'Not built', 'listed in the registry so the gap is visible; no adapter exists yet, so nothing is read'],
};
export const STATUS_ORDER = ['error', 'needs_credentials', 'connected', 'available', 'disabled', 'not_built'];
export const PLANNED_LINE = 'Planned adapters (not built) are listed so gaps are visible; the registry decides what runs.';

// One connector for one home (the API's homes[].status).
const HOME_STATUS = {
  connected: ['good', 'connected'], error: ['bad', 'error'], needs_credentials: ['warn', 'needs credentials'],
  not_connected: ['', 'not connected'], not_run: ['info', 'not synced yet'], idle: ['', 'nothing to fetch'],
  skipped: ['warn', 'skipped'], fallback: ['', 'fallback'], disabled: ['', 'disabled'], not_built: ['planned', 'not built'], demo: ['', 'demo'],
};

const badge = ([cls, word]) => `<span class="badge ${cls}">${esc(word)}</span>`;
export const connectorBadge = (status) => badge(CONNECTOR_STATUS[status] || ['', status || 'unknown']);
const homeBadge = (status) => badge(HOME_STATUS[status] || ['', String(status || 'unknown').replace(/_/g, ' ')]);
const marketName = (code) => (code === '*' ? 'Any market' : code);
const when = (ts) => (ts ? `<span title="${esc(new Date(ts * 1000).toLocaleString('en-GB'))}">${esc(ago(ts))}</span>` : '<span class="faint">never</span>');
const dash = '<span class="faint">–</span>';
// As a sentence: a capital first letter and a full stop.
const sentence = (t) => { const s = String(t ?? '').trim(); return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?)]$/.test(s) ? '' : '.'}` : ''; };
const safeId = (code) => `conn-${String(code ?? '').replace(/[^a-z0-9_-]/gi, '')}`;

/** The roles and markets the filters offer, from the connectors present. */
export function filterOptions(list) {
  const roles = [...new Set(list.flatMap((c) => c.roles || []))];
  const markets = [...new Set(list.flatMap((c) => (c.markets || []).map((m) => m.market_code)))].filter((m) => m !== '*').sort();
  return { roles, markets };
}

/** Connectors matching { status, role, market } ('' = any). A connector listed for every market ('*') matches any market. */
export function applyFilters(list, { status = '', role = '', market = '' } = {}) {
  return list.filter((c) => (!status || c.status === status)
    && (!role || (c.roles || []).includes(role))
    && (!market || (c.markets || []).some((m) => m.market_code === market || m.market_code === '*')));
}

export function summaryChips(summary = {}, active = '') {
  const total = summary.total ?? STATUS_ORDER.reduce((n, s) => n + (summary[s] || 0), 0);
  const chip = (status, n, inner, title) => `<button type="button" class="conn-chip${n ? '' : ' zero'}" data-status="${esc(status)}" aria-pressed="${status === active}" title="${esc(title)}">
    <b>${esc(n)}</b> ${inner}</button>`;
  return `<div class="conn-chips" role="group" aria-label="Connectors by status; choose one to show only those">
    ${chip('', total, '<span>All</span>', 'Show every connector')}
    ${STATUS_ORDER.map((s) => chip(s, summary[s] || 0, connectorBadge(s), `${CONNECTOR_STATUS[s][1]}: ${CONNECTOR_STATUS[s][2]}`)).join('')}
  </div>`;
}

export function filtersHtml(list, f = {}) {
  const { roles, markets } = filterOptions(list);
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="conn-filters" role="search" aria-label="Filter connectors">
    <label for="f-status">Status<select id="f-status">${opt('', 'All statuses', f.status)}${STATUS_ORDER.map((s) => opt(s, CONNECTOR_STATUS[s][1], f.status)).join('')}</select></label>
    <label for="f-role">Provides<select id="f-role">${opt('', 'Any kind of data', f.role)}${roles.map((r) => opt(r, roleLabel(r), f.role)).join('')}</select></label>
    <label for="f-market">Market<select id="f-market">${opt('', 'Any market', f.market)}${markets.map((m) => opt(m, m, f.market)).join('')}</select></label>
    <button type="button" class="btn" id="f-clear">Clear filters</button>
    <span class="conn-count" id="f-count" role="status" aria-live="polite"></span>
  </div>`;
}

function marketPills(markets = []) {
  if (!markets.length) return dash;
  return markets.map((m) => {
    const state = !m.enabled ? 'off' : !m.licence_confirmed ? 'unlicensed' : '';
    const title = `${marketName(m.market_code)}: ${m.enabled ? 'switched on' : 'switched off'}, licence ${m.licence_confirmed ? 'confirmed' : 'unconfirmed'}, priority ${m.priority}`;
    return `<span class="pill${state ? ' off' : ''}" title="${esc(title)}">${esc(marketName(m.market_code))}${state ? ` <small>(${esc(state)})</small>` : ''}</span>`;
  }).join('');
}

function homesLine(c) {
  const n = c.homes_total_in_markets || 0;
  const demo = c.homes_demo ? ` <span class="faint">· ${esc(c.homes_demo)} demo ${c.homes_demo === 1 ? 'home' : 'homes'}, not counted</span>` : '';
  if (!c.built) return `${n ? `${esc(n)} ${n === 1 ? 'home' : 'homes'} in its markets` : 'No real home in its markets'}${demo}`;
  if (!n) return `No real home in its markets${demo}`;
  return `<b>${esc(c.homes_connected || 0)} of ${esc(n)}</b> ${c.scope === 'home' ? 'connected' : 'served'}${c.homes_error ? `, <span class="bad-text">${esc(c.homes_error)} failing</span>` : ''}${demo}`;
}

function runsWord(c) {
  const scopes = c.scopes || (c.scope ? [c.scope] : []);
  if (!scopes.length) return dash;
  const main = SCOPE_WORD[c.scope]?.[0] || c.scope;
  return `${esc(main)}${scopes.length > 1 ? ` <span class="faint">(also ${esc(scopes.filter((s) => s !== c.scope).map((s) => SCOPE_WORD[s]?.[0]?.toLowerCase() || s).join(', '))})</span>` : ''}`;
}

function reasonBlock(c) {
  if (c.status === 'error') return `<p class="conn-reason bad"><b>Last error</b>${esc(c.last_error || c.reason || 'failed')}</p>`;
  if (c.status === 'needs_credentials') return `<p class="conn-reason warn"><b>Why</b>${esc(sentence(c.reason))}</p>`;
  if (c.status === 'connected') return c.warning ? `<p class="conn-reason warn"><b>Next sync</b>${esc(sentence(c.warning))}</p>` : '';
  if (c.status === 'available' || c.status === 'disabled') return c.reason ? `<p class="conn-reason"><b>Why</b>${esc(sentence(c.reason))}</p>` : '';
  return '';
}

function homesList(c) {
  const homes = c.homes || [];
  if (!homes.length) return '';
  const item = (h) => `<li><a href="/data?site=${encodeURIComponent(h.site_id)}#providers">${esc(h.name)}</a> <span class="mono faint">${esc(h.market_code)}</span>
    ${homeBadge(h.status)}${h.is_demo ? ` ${originBadge('synthetic')}` : ''}${h.last_success_at ? ` <span class="faint">· last success ${when(h.last_success_at)}</span>` : ''}
    ${h.reason ? `<small>${esc(sentence(h.reason))}</small>` : ''}${h.next && h.next !== h.reason ? `<small>Next sync: ${esc(sentence(h.next))}</small>` : ''}</li>`;
  return `<details class="conn-more"><summary>Homes in its markets (${esc(homes.length)})</summary><ul>${homes.map(item).join('')}</ul></details>`;
}

function registryRows(c) {
  const rows = (c.markets || []).flatMap((m) => (m.roles || []).map((r) => ({ market: m.market_code, ...r })));
  if (!rows.length) return '';
  const item = (r) => `<li><b>${esc(marketName(r.market))}</b> · ${esc(roleLabel(r.role))} · priority ${esc(r.priority)} · ${r.enabled ? 'on' : 'off'} · licence ${r.licence_confirmed ? 'confirmed' : 'unconfirmed'}
    · ${r.needs_credentials ? 'credentials needed' : 'no credentials'} · ${esc(SCOPE_WORD[r.scope]?.[0]?.toLowerCase() || r.scope)}${r.note ? `<small>${esc(sentence(r.note))}</small>` : ''}</li>`;
  return `<details class="conn-more"><summary>Registry rows (${esc(rows.length)})</summary><ul>${rows.map(item).join('')}</ul></details>`;
}

/** One connector as a card: name, status word, origin, what it provides, where, how, and why. */
export function connectorCard(c) {
  const id = safeId(c.adapter);
  const notes = c.note && !(c.reason && String(c.reason).includes(c.note)) ? `<p class="conn-note">${esc(sentence(c.note))}</p>` : '';
  const planned = c.status === 'not_built' ? `<p class="conn-note">${esc(sentence(c.reason || c.note))}</p>` : '';
  // The latest run that held its steps: when, and each step's outcome in words.
  const outcome = (s) => (s.ok === false ? 'failed' : s.skipped ? 'skipped' : s.shared ? 'ok, shared' : 'ok');
  const lastRun = c.last_run?.steps?.length
    ? `${when(c.last_run.at)} <span class="faint">·</span> ${c.last_run.steps.map((s) => `<span class="mono">${esc(s.step)}</span> ${esc(outcome(s))}`).join(', ')}` : '';
  return `<article class="card conn" id="${id}" aria-labelledby="${id}-name">
    <header class="conn-head">
      <div><h3 id="${id}-name">${esc(c.label || c.adapter)}</h3><span class="mono">${esc(c.adapter)}</span></div>
      <div class="conn-badges">${connectorBadge(c.status)} ${c.origin ? originBadge(c.origin) : ''}</div>
    </header>
    ${reasonBlock(c)}
    <dl class="conn-facts">
      <dt>Provides</dt><dd>${(c.roles || []).map((r) => esc(roleLabel(r))).join(' · ') || dash}</dd>
      <dt>Markets</dt><dd>${marketPills(c.markets)}</dd>
      <dt>Runs</dt><dd>${runsWord(c)}</dd>
      <dt>Credentials</dt><dd>${c.auth === 'credentials' ? 'Needed' : 'Not needed'}</dd>
      <dt>Built</dt><dd>${c.built ? 'Yes' : 'No, planned'}</dd>
      <dt>Licence</dt><dd>${c.licence_confirmed == null ? dash : c.licence_confirmed ? 'Confirmed' : '<b>Unconfirmed</b>'}</dd>
      ${c.owner && c.owner !== 'core' ? `<dt>Owner</dt><dd>Another process (the core must not call it)</dd>` : ''}
      <dt>Homes</dt><dd>${homesLine(c)}</dd>
      <dt>Last success</dt><dd>${c.built ? when(c.last_success_at) : dash}</dd>
      ${lastRun ? `<dt>Last run</dt><dd>${lastRun}</dd>` : ''}
    </dl>
    ${c.status === 'not_built' ? planned : notes}
    ${homesList(c)}
    ${registryRows(c)}
  </article>`;
}

/** The connectors grouped by status, problems first; an empty result says so. */
export function groupsHtml(list) {
  if (!list.length) return '<div class="card empty"><p>No connector matches these filters.</p></div>';
  return STATUS_ORDER.filter((s) => list.some((c) => c.status === s)).map((s) => {
    const items = list.filter((c) => c.status === s);
    return `<section class="conn-group" aria-labelledby="g-${s}">
      <h2 id="g-${s}">${connectorBadge(s)} <span>${esc(items.length)} ${items.length === 1 ? 'connector' : 'connectors'}</span></h2>
      <p>${esc(sentence(CONNECTOR_STATUS[s][2]))}</p>
      <div class="conn-grid">${items.map(connectorCard).join('')}</div>
    </section>`;
  }).join('');
}

// The scope words, as said about every home (the Data & trust page says them about one home).
const SCOPE_LEGEND = [
  [SCOPE_WORD.shared[0], 'fetched from public data once per region, tariff or location, and used by every home of its markets that needs it'],
  [SCOPE_WORD.home[0], 'runs only for a home with its own connection (its supplier account, its inverter)'],
];

/** What the status words mean, the scope words, and the origin labels present. */
export function legendHtml(list = []) {
  const origins = ['sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'].filter((o) => list.some((c) => c.origin === o));
  return `<section class="card section" id="conn-legend" aria-labelledby="conn-legend-h">
    <div class="card-head"><div><h2 id="conn-legend-h">What the words mean</h2><p>${esc(PLANNED_LINE)}</p></div></div>
    <div class="state-notes conn-legend"><dl>
      ${STATUS_ORDER.map((s) => `<dt>${connectorBadge(s)}</dt><dd>${esc(sentence(CONNECTOR_STATUS[s][2]))}</dd>`).join('')}
      ${SCOPE_LEGEND.map(([w, d]) => `<dt>${esc(w)}</dt><dd>${esc(sentence(d))}</dd>`).join('')}
      <dt>Credentials</dt><dd>Whether the registry says the provider needs keys or a login (yes or no). It does not record what kind (API key, password, token).</dd>
    </dl>${origins.length ? originLegend(origins) : ''}
    <p class="faint">Demo homes hold generated data and are never synced: they are listed with each connector as demo, and never counted as connected. Keys and passwords are never stored or shown here.</p></div>
  </section>`;
}

/** The line under the chips: how many real and demo homes the statuses cover. */
export function homesNote(homes = {}) {
  const real = homes.total || 0;
  const demo = homes.demo || 0;
  return `Statuses cover ${esc(real)} real ${real === 1 ? 'home' : 'homes'}${demo ? ` and leave out ${esc(demo)} demo ${demo === 1 ? 'home' : 'homes'} ${originBadge('synthetic')} (generated data, never synced, never counted as connected)` : ''}.`;
}
