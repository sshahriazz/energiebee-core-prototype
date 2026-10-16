// Page shell: top bar, navigation, home and period pickers, sync button, footer.
import { api, ago, esc } from './api.js';

const PAGES = [
  ['index', 'Home', '/'], ['breakdown', 'Breakdown', '/breakdown'], ['solar', 'Solar', '/solar'], ['battery', 'Battery', '/battery'],
  ['grid', 'Grid', '/grid'], ['ev', 'EV', '/ev'], ['data', 'Data & trust', '/data'],
];
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days']];

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const BEE = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 2.5 28 9.25v13.5L16 29.5 4 22.75V9.25z" fill="var(--solar)"/>
  <path d="M10 13h12M9.5 17h13M11 21h10" stroke="var(--text)" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

export async function init({ page, title, subtitle, periods = true, render }) {
  const params = new URLSearchParams(location.search);
  const state = {
    period: params.get('period') || store.get('eb.period') || 'today',
    siteId: Number(params.get('site') || store.get('eb.site')) || null,
    sites: [], site: null,
  };

  const theme = store.get('eb.theme');
  if (theme) document.documentElement.dataset.theme = theme;

  document.body.insertAdjacentHTML('afterbegin', `
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="/">${BEE}<span>EnergieBee <small>core prototype</small></span></a>
      <nav class="nav">${PAGES.map(([k, l, h]) => `<a href="${h}" data-page="${k}" ${k === page ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div class="controls">
        <select id="site-select" aria-label="Home"></select>
        <button class="btn" id="sync-btn" title="Fetch new data from every provider and rebuild">↻ Sync</button>
        <button class="btn icon-btn" id="theme-btn" title="Light or dark">◐</button>
      </div>
    </div></header>`);
  const main = document.querySelector('main');
  main.insertAdjacentHTML('afterbegin', `
    <div id="banner-slot"></div>
    <div class="page-head">
      <div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
      ${periods ? `<div class="segmented" role="group" aria-label="Period">${PERIODS.map(([k, l]) => `<button data-period="${k}" aria-pressed="${k === state.period}">${l}</button>`).join('')}</div>` : ''}
    </div>`);
  document.body.insertAdjacentHTML('beforeend', `
    <footer class="foot">
      <img src="/img/technext-logo.png" alt="Technext">
      <span>Prototype built by Technext for EnergieBee · every number on these pages comes from the half-hour core and can be traced on the Data &amp; trust page.</span>
    </footer>`);

  const select = document.getElementById('site-select');
  const syncBtn = document.getElementById('sync-btn');

  const keepUrl = () => {
    const q = new URLSearchParams(location.search);
    q.set('period', state.period);
    if (state.siteId) q.set('site', state.siteId);
    history.replaceState(null, '', `${location.pathname}?${q}`);
    document.querySelectorAll('.nav a').forEach((a) => {
      const href = a.getAttribute('href').split('?')[0];
      a.setAttribute('href', `${href}?site=${state.siteId || ''}&period=${state.period}`);
    });
  };

  const banner = () => {
    const s = state.site;
    const slot = document.getElementById('banner-slot');
    if (!s) { slot.innerHTML = ''; return; }
    const errors = s.connections.filter((c) => c.status === 'error');
    let html = '';
    if (s.is_demo) {
      html += `<div class="banner"><span>🐝</span><div><b>Demo home.</b> A simulated house in ${esc(s.postcode)} with ${s.pv_kwp} kWp of solar, a ${s.battery_kwh} kWh battery and an EV.
        Prices are the real Agile Octopus and Outgoing Octopus rates for region ${esc(s.gsp_region || '?')}; sunlight is the real weather there.
        Its data is shaped like Sunsynk and Octopus payloads and goes through the same pipeline as a real home.</div></div>`;
    }
    if (errors.length) {
      html += `<div class="banner bad"><span>!</span><div>${errors.map((c) => `<b>${esc(c.provider)}</b>: ${esc(c.last_error)}`).join('<br>')}</div></div>`;
    }
    if (s.syncing || (!s.days?.n && !s.lastSync?.finished_at)) {
      html += `<div class="banner warn"><span class="spin">↻</span><div>Loading data from the providers and building the half-hour timeline… this takes a few seconds on first run.</div></div>`;
    }
    slot.innerHTML = html;
  };

  async function loadSites() {
    state.sites = await api('/api/sites');
    if (!state.sites.find((s) => s.id === state.siteId)) state.siteId = state.sites[0]?.id || null;
    state.site = state.sites.find((s) => s.id === state.siteId) || null;
    state.tz = state.site?.timezone || 'Europe/London';
    select.innerHTML = state.sites.map((s) => `<option value="${s.id}" ${s.id === state.siteId ? 'selected' : ''}>${esc(s.name)}${s.is_demo ? ' (demo)' : ''}</option>`).join('')
      + (state.sites.some((s) => s.is_demo) ? '' : '<option value="demo">+ Add demo home</option>');
    syncBtn.disabled = !!state.site?.syncing;
    syncBtn.innerHTML = state.site?.syncing ? '<span class="spin">↻</span> Syncing' : '↻ Sync';
    syncBtn.title = state.site?.lastSync ? `Last sync ${ago(state.site.lastSync.finished_at || state.site.lastSync.started_at)} (${state.site.lastSync.status})` : 'Never synced';
    banner();
    keepUrl();
  }

  let rendering = false;
  async function rerender() {
    if (rendering || !state.site) return;
    rendering = true;
    try { await render(state); } catch (err) { console.error(err); } finally { rendering = false; }
  }

  async function waitForSync() {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await loadSites();
      if (!state.site?.syncing) break;
    }
    await rerender();
  }

  select.addEventListener('change', async () => {
    if (select.value === 'demo') {
      const r = await api('/api/demo', { method: 'POST' });
      state.siteId = r.id;
    } else state.siteId = Number(select.value);
    store.set('eb.site', String(state.siteId));
    await loadSites();
    await rerender();
    if (state.site?.syncing) waitForSync();
  });
  syncBtn.addEventListener('click', async () => {
    if (!state.site) return;
    await api(`/api/sites/${state.site.id}/sync`, { method: 'POST' });
    await loadSites();
    waitForSync();
  });
  document.getElementById('theme-btn').addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('eb.theme', next);
    rerender();
  });
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    store.set('eb.period', state.period);
    document.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    keepUrl();
    rerender();
  }));

  await loadSites();
  if (!state.site) {
    document.getElementById('content').innerHTML = `<div class="card empty"><h2>No home yet</h2><p>Add the demo home, or put Sunsynk and Octopus details in <span class="mono">.env</span> and restart.</p><button class="btn btn-primary" id="add-demo">Add demo home</button></div>`;
    document.getElementById('add-demo').onclick = async () => { const r = await api('/api/demo', { method: 'POST' }); state.siteId = r.id; await loadSites(); waitForSync(); };
    return state;
  }
  await rerender();
  if (state.site.syncing || !state.site.days?.n) waitForSync();
  // Keep "now" fresh without a manual reload.
  setInterval(async () => { await loadSites(); rerender(); }, 120000);
  return state;
}

// Card with a heading, an optional note and a body slot.
export function card(title, note = '', body = '', extra = '') {
  return `<section class="card" ${extra}><div class="card-head"><div><h2>${title}</h2>${note ? `<p>${note}</p>` : ''}</div></div>${body}</section>`;
}

export function kpi(label, value, sub = '', swatch = '') {
  return `<div class="kpi"><div class="label">${swatch ? `<i class="swatch" style="background:${swatch}"></i>` : ''}${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

export function evidenceLink(state, slot) {
  return `/data?site=${state.siteId}&period=${state.period}&slot=${slot}#evidence`;
}
