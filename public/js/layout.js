// Page shell: top bar, navigation, home and period pickers, sync button, footer.
import { api, ago, esc, fmt, setCurrency, setSlot, slotNoun, slotNouns, originBadge, originLegend, minorSymbol } from './api.js';

const PAGES = [
  ['my', 'My energy', '/my'], ['index', 'Home', '/'], ['everything', 'Timeline', '/timeline'], ['breakdown', 'Breakdown', '/breakdown'], ['solar', 'Solar', '/solar'], ['battery', 'Battery', '/battery'],
  ['grid', 'Grid', '/grid'], ['tariffs', 'Tariffs', '/tariffs'], ['ev', 'EV', '/ev'], ['data', 'Data & trust', '/data'],
  ['connectors', 'Connectors', '/connectors'], ['compatibility', 'Compatibility', '/compatibility'], ['explorer', 'Data Explorer', '/explorer'],
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

// homeScoped false: a page about the whole core, not one home (Connectors). It renders with or
// without a home, and shows none of the selected home's banners (errors, provenance, basis).
export async function init({ page, title, subtitle, periods = true, homeScoped = true, render }) {
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
    <div id="provenance-slot"></div>
    <div class="page-head">
      <div><h1>${esc(title)}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
      ${periods ? `<div class="segmented" role="group" aria-label="Period">${PERIODS.map(([k, l]) => `<button data-period="${k}" aria-pressed="${k === state.period}">${l}</button>`).join('')}</div>` : ''}
    </div>
    <div id="basis-slot"></div>`);
  document.body.insertAdjacentHTML('beforeend', `
    <footer class="foot">
      <img src="/img/technext-logo.png" alt="Technext">
      <span>Prototype built by Technext for EnergieBee · every number on these pages comes from the core's slot timeline and can be traced on the Data &amp; trust page.</span>
    </footer>`);

  const select = document.getElementById('site-select');
  const syncBtn = document.getElementById('sync-btn');

  const keepUrl = () => {
    const q = new URLSearchParams(location.search);
    q.set('period', state.period);
    if (state.siteId) q.set('site', state.siteId);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);   // keep the hash: pages keep state in it
    document.querySelectorAll('.nav a').forEach((a) => {
      const href = a.getAttribute('href').split('?')[0];
      a.setAttribute('href', `${href}?site=${state.siteId || ''}&period=${state.period}`);
    });
  };

  const banner = () => {
    const s = state.site;
    const slot = document.getElementById('banner-slot');
    if (!s || !homeScoped) { slot.innerHTML = ''; return; }
    const errors = s.connections.filter((c) => c.status === 'error');
    let html = '';
    if (errors.length) {
      html += `<div class="banner bad"><span>!</span><div>${errors.map((c) => `<b>${esc(c.provider)}</b>: ${esc(c.last_error)}`).join('<br>')}</div></div>`;
    }
    if (!s.is_demo && (s.syncing || (!s.days?.n && !s.lastSync?.finished_at))) {
      html += `<div class="banner warn"><span class="spin">↻</span><div>Loading data from the providers and building the ${slotNoun()} timeline… this takes a few seconds on first run.</div></div>`;
    }
    slot.innerHTML = html;
  };

  // Provenance banner, on every page: a demo home's values are synthetic, and a period priced with
  // any placeholder or synthetic input says which ones (from the period's provenance block).
  function provenanceBanner(p) {
    const slot = document.getElementById('provenance-slot');
    const s = state.site;
    if (!s || !homeScoped) { slot.innerHTML = ''; return; }
    const lines = [];
    if (s.is_demo || p?.demo) lines.push(`<b>Demo data: values below are synthetic.</b> This home's readings, tariffs and prices were generated for testing; none of it is real market data. ${originBadge('synthetic')}`);
    const unverified = (p?.placeholders || []).filter((x) => /\[placeholder\]$/.test(x));
    if (unverified.length || p?.worst === 'placeholder') lines.push(`<b>Contains placeholder values that are not verified.</b> ${originBadge('placeholder')} They were written from memory or assumed, not checked against an official source.`);
    if (p?.estimated_slots) lines.push(`<b>${p.estimated_slots} ${p.estimated_slots === 1 ? slotNoun() : slotNouns()} priced with an estimate:</b> the day type (e.g. a Tempo colour) was not published yet.`);
    if (!lines.length) { slot.innerHTML = ''; return; }
    const list = (p?.placeholders || []).length ? `<details><summary>Inputs that are not verified (${p.placeholders.length})</summary><ul>${p.placeholders.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul></details>` : '';
    slot.innerHTML = `<div class="banner ${s.is_demo || p?.worst === 'synthetic' ? 'bad' : 'warn'} provenance" role="status"><span aria-hidden="true">⚠</span><div>${lines.join('<br>')}${list}${originLegend()}</div></div>`;
  }

  async function loadSites() {
    state.sites = await api('/api/sites');
    if (!state.sites.find((s) => s.id === state.siteId)) state.siteId = state.sites[0]?.id || null;
    state.site = state.sites.find((s) => s.id === state.siteId) || null;
    state.tz = state.site?.timezone || 'Europe/London';
    setCurrency(state.site?.currency);
    setSlot(state.site?.slot_s);
    provenanceBanner(state.provenance);
    select.innerHTML = state.sites.map((s) => `<option value="${s.id}" ${s.id === state.siteId ? 'selected' : ''}>${esc(s.name)}${s.is_demo ? ' (demo, synthetic)' : ''}</option>`).join('');
    syncBtn.disabled = !!state.site?.syncing || !!state.site?.is_demo;
    syncBtn.innerHTML = state.site?.syncing ? '<span class="spin">↻</span> Syncing' : '↻ Sync';
    syncBtn.title = state.site?.is_demo ? 'Demo home: its data is synthetic, there is nothing to sync'
      : state.site?.lastSync ? `Last sync ${ago(state.site.lastSync.finished_at || state.site.lastSync.started_at)} (${state.site.lastSync.status})` : 'Never synced';
    banner();
    keepUrl();
  }

  // What every figure on the page rests on, for the selected period: how many half-hours are
  // final, provisional or missing, and how the checks went, with a link to the proof.
  async function basis() {
    const slot = document.getElementById('basis-slot');
    if (!state.site || !homeScoped) { slot.innerHTML = ''; return; }
    try {
      // The summary also carries the period's provenance, shown in the banner on every page.
      const sum = await api(`/api/sites/${state.site.id}/summary?period=${state.period}`);
      state.provenance = sum.provenance || null;
      provenanceBanner(state.provenance);
      const b = sum.basis;
      if (!periods || page === 'data' || !b?.halfHours) { slot.innerHTML = ''; return; }
      const c = b.checks || {}; const run = (c.pass || 0) + (c.warn || 0) + (c.fail || 0);
      const w = (n) => `${(n / b.halfHours) * 100}%`;
      slot.innerHTML = `<div class="basis"><span class="basis-bar" aria-hidden="true"><i style="width:${w(b.final)};background:var(--good)"></i><i style="width:${w(b.provisional)};background:var(--warn)"></i><i style="width:${w(b.missing)};background:var(--bad)"></i></span>
        <span>Based on ${b.halfHours} ${b.halfHours === 1 ? slotNoun() : slotNouns()}: <b>${Math.round((b.final / b.halfHours) * 100)}% final</b>${b.provisional ? `, ${b.provisional} provisional (waiting for smart-meter readings)` : ''}${b.missing ? `, ${b.missing} missing` : ''}${run ? ` · ${c.pass} of ${run} cross-checks agree` : ''}</span>
        <a href="/data?site=${state.siteId}&period=${state.period}#proof">See the proof →</a></div>`;
    } catch { slot.innerHTML = ''; }
  }

  let rendering = false;
  async function rerender() {
    if (rendering || (homeScoped && !state.site)) return;
    rendering = true;
    try { await Promise.all([render(state), basis()]); } catch (err) { console.error(err); } finally { rendering = false; }
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
    state.siteId = Number(select.value);
    state.provenance = null;
    store.set('eb.site', String(state.siteId));
    await loadSites();
    await rerender();
    if (state.site?.syncing) waitForSync();
  });
  syncBtn.addEventListener('click', async () => {
    if (!state.site || state.site.is_demo) return;
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
  if (!state.site && homeScoped) {
    document.getElementById('content').innerHTML = `<div class="card empty"><h2>No home yet</h2><p>Put Sunsynk and Octopus details in <span class="mono">.env</span> and restart.</p></div>`;
    return state;
  }
  await rerender();
  if (state.site && !state.site.is_demo && (state.site.syncing || !state.site.days?.n)) waitForSync();
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

// The tariffs in force (the API's /tariffs rows), each figure with its origin badge: the tariff,
// its rates now, the fixed charge per day and every tax rule (VAT, levies) applied on top.
export function tariffRowsHtml(tariffs, { legendToo = true } = {}) {
  const current = tariffs.filter((t) => t.current);
  if (!current.length) return '<div class="skeleton">No tariff found for this home.</div>';
  const tax = (x) => `${esc(x.code)} ${x.kind === 'percent' ? fmt.pct(x.value, x.value * 100 % 1 ? 2 : 0) : x.kind === 'per_kwh' ? `${fmt.num(x.value, 3)}${minorSymbol()}/kWh` : `${fmt.num(x.value, 2)} per ${esc(x.charge_period || 'period')}`} ${originBadge(x.origin, x.origin_note)}`;
  return `<div class="rows">${current.map((t) => `
    <div class="row"><span class="k">${esc(t.label || t.kind)}</span><span><span class="mono">${esc(t.tariff_code)}</span> ${originBadge(t.origin, t.origin_note)}</span></div>
    <div class="row sub"><span class="k">${esc(t.name || t.structure)} · ${esc(t.structure)}${t.estimated ? ' · <span class="badge warn">estimated price</span>' : ''}</span>
      <b>${fmt.pkwh(t.unitNow)} now${t.rate_origin ? ` ${originBadge(t.rate_origin)}` : ''}${t.direction === 'import' && t.standingPerDay != null ? ` · ${fmt.p(t.standingPerDay)}/day` : ''}</b></div>
    ${t.taxes?.length ? `<div class="row sub"><span class="k">Taxes on it</span><span>${t.taxes.map(tax).join(' · ')}</span></div>` : ''}`).join('')}</div>
    ${legendToo ? originLegend() : ''}`;
}
