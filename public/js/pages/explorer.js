// Data Explorer: every stage of the data for one home, open to inspection. Six tabs, their state kept
// in the address hash (#raw, #facts, #timeline, #slot=<epoch>&site=<id>, #correlate…), so any view can
// be shared or reloaded. The API is /api/explorer/*; times are epoch seconds UTC, shown in the home's
// zone; slot length and currency come from the API, never assumed.
import { init } from '../layout.js';
import { setCurrency, setSlot, esc } from '../api.js';
import { ctx, clearCache, readHash, writeHash, lastHash, TABS, loadOverview, loadVariables } from '../explorer/util.js';
import { redrawAll } from '../explorer/charts.js';
import * as overview from '../explorer/overview.js';
import * as raw from '../explorer/raw.js';
import * as facts from '../explorer/facts.js';
import * as timeline from '../explorer/timeline.js';
import * as slot from '../explorer/slot.js';
import * as correlate from '../explorer/correlate.js';

const MODS = { overview, raw, facts, timeline, slot, correlate };
const LABELS = { overview: 'Overview', raw: 'Raw data', facts: 'Facts', timeline: 'Timeline', slot: 'Slot inspector', correlate: 'Correlations' };

// A deep link's home (#slot=…&site=2) wins over the remembered one: put it in the query layout.js reads.
{
  const s = readHash().params.get('site');
  const q = new URLSearchParams(location.search);
  if (s && q.get('site') !== s) { q.set('site', s); history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`); }
}

let built = false;
let active = null;
const panel = (t) => document.getElementById(`xp-panel-${t}`);

function shell() {
  document.getElementById('content').innerHTML = `
    <div class="xp">
      <div class="xp-tabs" role="tablist" aria-label="Data Explorer sections">${TABS.map((t) => `<button type="button" role="tab" id="xp-tab-${t}" aria-controls="xp-panel-${t}" aria-selected="false" tabindex="-1">${esc(LABELS[t])}</button>`).join('')}</div>
      ${TABS.map((t) => `<section class="xp-panel" role="tabpanel" id="xp-panel-${t}" aria-labelledby="xp-tab-${t}" hidden></section>`).join('')}
      <dialog class="xp-drawer" id="xp-drawer" aria-labelledby="xp-drawer-title"></dialog>
    </div>`;
  const list = document.querySelector('.xp-tabs');
  list.addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) go(b.id.replace('xp-tab-', '')); });
  list.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(active);
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    go(TABS[j]);
    document.getElementById(`xp-tab-${TABS[j]}`).focus();
  });
  raw.wireDrawer(document.getElementById('xp-drawer'));
  // Links shared by every tab: a raw file opens in the drawer over the current tab.
  document.getElementById('content').addEventListener('click', (e) => {
    const b = e.target.closest('[data-raw]');
    if (b) { e.preventDefault(); raw.openRaw(b.dataset.raw, b); }
  });
  built = true;
}

function setTab(tab) {
  const changed = tab !== active;
  active = tab;
  for (const t of TABS) {
    const on = t === tab;
    const b = document.getElementById(`xp-tab-${t}`);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    panel(t).hidden = !on;
  }
  if (changed) document.title = `${LABELS[tab]} · EnergieBee Data Explorer`;
  return changed;
}

/** Show a tab from a tab button: restore what it showed last, as a new history entry. */
function go(tab) {
  if (tab === active) return;
  const st = MODS[tab].hashState?.() || { value: '', params: {} };
  writeHash(tab, st.value, st.params, { push: true });
  route();
}

async function route() {
  if (!built || !ctx.siteId) return;
  const h = readHash();
  lastHash.v = location.hash;
  const dlg = document.getElementById('xp-drawer');
  if (dlg?.open && !(h.tab === 'raw' && h.params.get('id'))) dlg.close();
  const changed = setTab(h.tab);
  try { await MODS[h.tab].show(panel(h.tab), h); } catch (err) { console.error(err); panel(h.tab).insertAdjacentHTML('afterbegin', `<div class="xp-msg bad" role="alert"><b>Something went wrong on this tab.</b><p>${esc(err.message)}</p></div>`); }
  if (changed) redrawAll(panel(h.tab));
}

const onNav = () => { if (location.hash !== lastHash.v) route(); };
addEventListener('hashchange', onNav);
addEventListener('popstate', onNav);

async function render(state) {
  if (!state.site) return;
  if (state.siteId !== ctx.siteId) {
    Object.assign(ctx, { siteId: state.siteId, site: state.site, tz: state.tz || state.site.timezone || 'Europe/London', slotS: state.site.slot_s || 1800, currency: state.site.currency || 'GBP', overview: null, variables: null });
    clearCache();
    for (const m of Object.values(MODS)) m.reset?.();
    if (!built) shell(); else for (const t of TABS) panel(t).innerHTML = '';
    // The home in a deep link follows the home picker.
    const h = readHash();
    if (h.params.get('site') && h.params.get('site') !== String(ctx.siteId)) { h.params.set('site', ctx.siteId); writeHash(h.tab, h.value, Object.fromEntries(h.params)); }
    try { await loadOverview(); } catch { /* each tab shows its own error */ }
    try { await loadVariables(); } catch { /* names stay as the API gives them */ }
    setSlot(ctx.slotS); setCurrency(ctx.currency);
    active = null;
    await route();
    return;
  }
  // Same home: the 2-minute refresh or the theme button. Keep everything; redraw the visible charts.
  redrawAll(panel(active) || document);
}

init({
  page: 'explorer', title: 'Data Explorer', periods: false, render,
  subtitle: 'Every number traced back to where it came from: the files the providers sent, the facts read from them, the timeline built from the facts, and the checks against independent sources. Pick any slot to see, step by step, how its numbers were worked out.',
});
