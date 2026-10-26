// Connectors: every adapter the core has or needs, across all homes and markets, and how each is
// doing (GET /api/connectors). Summary chips, three filters (status, kind of data, market), then
// one card per connector grouped by status, problems first, and a legend. Not about one home: it
// renders with or without one, and shows none of a home's banners.
import { api, esc } from '../api.js';
import { init } from '../layout.js';
import { summaryChips, filtersHtml, groupsHtml, legendHtml, homesNote, applyFilters, filterOptions, PLANNED_LINE, STATUS_ORDER } from '../connectors-view.js';

const KEYS = ['status', 'role', 'market'];
const filters = { status: '', role: '', market: '' };
{
  const q = new URLSearchParams(location.search);
  for (const k of KEYS) filters[k] = q.get(k) || '';
}
let data = null;

// Filters in the address, so a filtered view can be shared or reloaded.
function keepFilters() {
  const q = new URLSearchParams(location.search);
  for (const k of KEYS) { if (filters[k]) q.set(k, filters[k]); else q.delete(k); }
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

function drawList() {
  const shown = applyFilters(data.connectors, filters);
  document.getElementById('conn-list').innerHTML = groupsHtml(shown);
  const total = data.connectors.length;
  document.getElementById('f-count').textContent = shown.length === total ? `Showing all ${total} connectors` : `Showing ${shown.length} of ${total} connectors`;
  document.querySelectorAll('.conn-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === filters.status)));
  for (const k of KEYS) document.getElementById(`f-${k}`).value = filters[k];
  document.getElementById('f-clear').disabled = KEYS.every((k) => !filters[k]);
  keepFilters();
}

async function render() {
  const content = document.getElementById('content');
  const focused = document.activeElement?.id || null;
  try {
    data = await api('/api/connectors');
  } catch (err) {
    content.innerHTML = `<div class="card empty"><h2>Connectors could not be loaded</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  // A filter from the address that names nothing present is dropped.
  const { roles, markets } = filterOptions(data.connectors);
  if (!STATUS_ORDER.includes(filters.status)) filters.status = '';
  if (!roles.includes(filters.role)) filters.role = '';
  if (!markets.includes(filters.market)) filters.market = '';

  content.innerHTML = `
    <div class="conn-top">
      ${summaryChips(data.summary, filters.status)}
      <p class="conn-planned">${homesNote(data.homes)} ${esc(PLANNED_LINE)}</p>
      ${filtersHtml(data.connectors, filters)}
    </div>
    <div id="conn-list"></div>
    ${legendHtml(data.connectors)}`;

  content.querySelectorAll('.conn-chip').forEach((b) => b.addEventListener('click', () => {
    const s = b.dataset.status;
    filters.status = s && filters.status === s ? '' : s;
    drawList();
  }));
  for (const k of KEYS) {
    document.getElementById(`f-${k}`).addEventListener('change', (e) => { filters[k] = e.target.value; drawList(); });
  }
  document.getElementById('f-clear').addEventListener('click', () => {
    for (const k of KEYS) filters[k] = '';
    drawList();
    document.getElementById('f-status').focus();
  });
  drawList();
  if (focused) document.getElementById(focused)?.focus();
}

init({
  page: 'connectors', title: 'Connectors', periods: false, homeScoped: false, render,
  subtitle: 'Every adapter the core has or needs, and how each one is doing across all homes: problems first. Read from the provider registry and the latest syncs; this page calls no provider.',
});
