// Compatibility: is the database ready for Predbat and PredHeat, how they read data and where it lives
// here, and the evidence item by item (GET /api/compatibility). Not about one home: it renders with or
// without one. The headline, the "how" table and the group bars come first, in plain words; then the
// 481 catalogue items, searchable and filterable, one page of 25 at a time (rendering all at once would
// be slow on a phone); then the definition, exclusions, conflicts, unverified items and what is not built.
import { api, esc } from '../api.js';
import { init } from '../layout.js';
import {
  heroHtml, howHtml, groupsHtml, controlsHtml, groupOptions, listHtml, countText, applyFilters, emptyFilters, filterOptions,
  definitionHtml, excludedHtml, conflictsHtml, unverifiedHtml, notBuiltHtml, filesHtml, FILTER_KEYS, PAGE_SIZE,
} from '../compatibility-view.js';

const filters = emptyFilters();
let page = 0;
{
  const q = new URLSearchParams(location.search);
  for (const k of FILTER_KEYS) filters[k] = q.get(k) || '';
  page = Math.max(0, Number(q.get('page')) - 1 || 0);
}
let data = null;
let drawn = false;
const openIds = new Set();   // expanded rows survive a page change, a filter change and a refresh

// Filters and page in the address, so a filtered view can be shared or reloaded.
function keepFilters() {
  const q = new URLSearchParams(location.search);
  for (const k of FILTER_KEYS) { if (filters[k]) q.set(k, filters[k]); else q.delete(k); }
  if (page) q.set('page', String(page + 1)); else q.delete('page');
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
}

function drawList() {
  const shown = applyFilters(data.items, filters);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  document.getElementById('compat-list').innerHTML = listHtml(shown, data, page, openIds);
  document.getElementById('f-count').textContent = countText(shown.length, data.items.length, page);
  document.getElementById('f-clear').disabled = FILTER_KEYS.every((k) => !filters[k]);
  keepFilters();
}

// A catalogue id elsewhere on the page shows that item in the list, opened.
function showItem(id) {
  Object.assign(filters, emptyFilters(), { q: id });
  page = 0;
  openIds.add(id);
  syncControls();
  drawList();
  const el = document.querySelector(`.compat-item[data-id="${CSS.escape(id)}"]`);
  if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); el.querySelector('summary')?.focus({ preventScroll: true }); }
}

function syncControls() {
  for (const k of FILTER_KEYS) {
    const el = document.getElementById(`f-${k}`);
    if (k === 'group') el.innerHTML = groupOptions(data, filters);
    if (el) el.value = filters[k];
  }
}

function section(id, title, note, body) {
  return `<section class="card section compat-section" id="${id}" aria-labelledby="${id}-h">
    <div class="card-head"><div><h2 id="${id}-h">${title}</h2>${note ? `<p>${note}</p>` : ''}</div></div>${body}</section>`;
}

function drawAll() {
  const content = document.getElementById('content');
  const s = data.summary;
  content.innerHTML = `
    <div id="compat-hero">${heroHtml(data)}</div>
    ${section('how', 'How they read data, and where it lives here', 'Predbat and PredHeat read arrays: one number per 5-minute step or per slot. Each row is one way they read, the places in our database that hold it, the function that reads it out, and why that fits.', `<div id="compat-how">${howHtml(data)}</div>`)}
    ${section('groups', 'Coverage by group', `The catalogue's ${esc(data.groups.length)} groups, per product. A bar is the share of the group's data items that are covered and found now; the words say the same.`, `<div id="compat-groups">${groupsHtml(data)}</div>`)}
    ${section('evidence', 'Explore the evidence', `Every one of the ${esc(s.items)} catalogue items. Open a row to see the places it maps to, each marked found or missing by the live check, and the source it was read from.`, `${controlsHtml(data, filters)}<div id="compat-list"></div>`)}
    <div class="grid cols-2 compat-pair">
      ${section('definition', 'What “100 %” means', '', definitionHtml(data))}
      ${section('excluded', 'What is excluded and why', `${esc(data.excluded.length)} items are not data. They are left out of the count, each for the reason given.`, excludedHtml(data))}
    </div>
    <div class="grid cols-2 compat-pair">
      ${section('conflicts', 'Conflicts', 'Where Predbat\'s or PredHeat\'s docs, code and the planning documents disagree (catalogue section 1.4), and what the database chose.', conflictsHtml(data))}
      ${section('unverified', 'Unverified items', `${esc(data.unverified.length)} items were not found in a fetched source: one Predbat assumption and the planning-design fields. They are counted apart from the 100 %.`, unverifiedHtml(data))}
    </div>
    ${section('not-built', 'What is not built yet', 'Stated plainly: the database has a place for the data, but these parts do not exist.', notBuiltHtml(data))}
    ${section('files', 'Where this comes from', 'The files behind this page, in the project.', filesHtml(data))}`;

  const q = document.getElementById('f-q');
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { filters.q = q.value; page = 0; drawList(); }, 150); });
  for (const k of FILTER_KEYS.filter((x) => x !== 'q')) {
    document.getElementById(`f-${k}`).addEventListener('change', (e) => {
      filters[k] = e.target.value;
      if (k === 'product') {
        if (filters.group && !data.groups.some((g) => g.id === filters.group && g.product === filters.product) && filters.product) filters.group = '';
        document.getElementById('f-group').innerHTML = groupOptions(data, filters);
      }
      page = 0;
      drawList();
    });
  }
  document.getElementById('f-clear').addEventListener('click', () => {
    Object.assign(filters, emptyFilters());
    page = 0;
    syncControls();
    drawList();
    q.focus();
  });
  const list = document.getElementById('compat-list');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    page = Number(b.dataset.page);
    drawList();
    document.getElementById('evidence').scrollIntoView({ block: 'start' });
    list.querySelector('.compat-pager button:not([disabled])')?.focus({ preventScroll: true });
  });
  list.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('.compat-item');
    if (d) { if (d.open) openIds.add(d.dataset.id); else openIds.delete(d.dataset.id); }
  }, true);
  content.addEventListener('click', (e) => {
    const a = e.target.closest('a.compat-find');
    if (!a) return;
    e.preventDefault();
    showItem(a.dataset.find);
  });
  drawList();
}

async function render() {
  const content = document.getElementById('content');
  let fresh;
  try {
    fresh = await api('/api/compatibility');
  } catch (err) {
    if (!drawn) content.innerHTML = `<div class="card empty"><h2>The compatibility check could not be loaded</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  // A filter from the address that names nothing present is dropped.
  const { dirs, statuses } = filterOptions(fresh);
  if (!fresh.products.some((p) => p.id === filters.product)) filters.product = '';
  if (!fresh.groups.some((g) => g.id === filters.group)) filters.group = '';
  if (!statuses.includes(filters.status)) filters.status = '';
  if (!dirs.includes(filters.dir)) filters.dir = '';
  if (!['verified', 'unverified'].includes(filters.ver)) filters.ver = '';
  const changed = !data || fresh.generated_at !== data.generated_at;
  data = fresh;
  if (!drawn) { drawAll(); drawn = true; if (location.hash) document.querySelector(location.hash)?.scrollIntoView(); return; }
  // A refresh (every 2 minutes, or the theme button): the live parts only, so the filters keep their focus and value.
  document.getElementById('compat-hero').innerHTML = heroHtml(data);
  if (!changed) return;
  document.getElementById('compat-how').innerHTML = howHtml(data);
  document.getElementById('compat-groups').innerHTML = groupsHtml(data);
  drawList();
}

init({
  page: 'compatibility', title: 'Compatibility', periods: false, homeScoped: false, render,
  subtitle: 'Can our database hold and serve everything Predbat and PredHeat read and write? Measured item by item against their own docs and code, and checked against this database as you open the page. Not about one home: no home\'s data is shown.',
});
