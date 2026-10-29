// Sign up, sign in, and add a home (/signup, /login, /onboarding): the account (src/core/users.js),
// then the home from a postcode and its providers connected with the user's own logins
// (src/core/signup.js). Logins go to the server once and are never shown again.
import { api, esc } from '../api.js';
import { init } from '../layout.js';

const view = location.pathname.replace(/^\/|\.html$/g, '') || 'login';
const TITLES = {
  signup: ['Create your account', 'An email and a password. Next: your postcode, then your inverter and meter.'],
  login: ['Sign in', 'Welcome back.'],
  onboarding: ['Add your home', 'Your postcode tells us your region, prices and weather; then connect your own providers.'],
};
const $ = (id) => document.getElementById(id);
const content = () => $('content');
const errorBox = (id = 'form-error') => `<div class="form-error" id="${id}" role="alert" aria-live="polite"></div>`;
const showError = (err, id = 'form-error') => { $(id).textContent = err?.message || String(err); };

// Submit a form's fields as JSON, with its button busy meanwhile and any error shown above it.
function onSubmit(form, fn, errId = 'form-error') {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Please wait…';
    $(errId).textContent = '';
    try { await fn(Object.fromEntries(new FormData(form))); } catch (err) { showError(err, errId); } finally { btn.disabled = false; btn.textContent = label; }
  });
}

// ───────────── Sign up and sign in ─────────────

function signupView(state) {
  const demo = !!state.me?.switcher;
  if (state.me?.user && !demo) { location.replace('/onboarding'); return; }
  content().innerHTML = `<div class="auth-wrap"><section class="card"><form class="form" id="f" novalidate>
    ${errorBox()}
    <label>Email<input name="email" type="email" autocomplete="email" required></label>
    <label>Password <small>at least 8 characters</small><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
    <label>Your name <small>optional</small><input name="name" type="text" autocomplete="name"></label>
    <button class="btn btn-primary" type="submit">Create account</button>
    ${demo ? '<p class="muted">Demo server: the new user is picked in the "Viewing as" dropdown, next to the others.</p>' : '<p class="muted">Already have an account? <a href="/login">Sign in</a></p>'}
  </form></section></div>`;
  onSubmit($('f'), async (b) => {
    const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(b) });
    // Demo server: pick the new user in the dropdown (no cookie there), with no home chosen yet.
    if (demo) {
      try { localStorage.setItem('eb.user', String(r.user.id)); localStorage.removeItem('eb.site'); } catch { /* private mode */ }
    }
    location.href = '/onboarding';
  });
}

function loginView(state) {
  if (state.me?.user) { location.replace(state.sites.length ? '/my' : '/onboarding'); return; }
  content().innerHTML = `<div class="auth-wrap"><section class="card"><form class="form" id="f" novalidate>
    ${errorBox()}
    <label>Email<input name="email" type="email" autocomplete="email" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn btn-primary" type="submit">Sign in</button>
    <p class="muted">New here? <a href="/signup">Create an account</a></p>
  </form></section></div>`;
  onSubmit($('f'), async (b) => {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify(b) });
    const me = await api('/api/auth/me');
    try { localStorage.removeItem('eb.site'); } catch { /* private mode */ }
    location.href = me.homes ? '/my' : '/onboarding';
  });
}

// ───────────── Add a home: postcode, then providers ─────────────

const steps = (n) => `<div class="steps" aria-label="Steps">${['Account', 'Postcode', 'Connect providers'].map((t, i) => `<span ${i === n ? 'aria-current="step"' : ''}>${i + 1}. ${t}</span>`).join('')}</div>`;

function onboardingView(state) {
  // The signed-in user, or on the demo server the one picked in the dropdown.
  if (!state.me?.user && !state.user) {
    content().innerHTML = `<div class="auth-wrap"><section class="card empty"><h2>Sign in first</h2><p>Your home belongs to your account.</p>
      <p><a class="btn btn-primary" href="/signup">Create an account</a> <a class="btn" href="/login">Sign in</a></p></section></div>`;
    return;
  }
  const siteId = Number(new URLSearchParams(location.search).get('home')) || null;
  if (siteId) return providersStep(siteId);
  const countries = state.me.countries || [{ code: 'GB', name: 'United Kingdom', example: 'BB12 9BY' }];
  content().innerHTML = `<div class="onb-wrap">${steps(1)}<section class="card"><form class="form" id="f" novalidate>
    ${errorBox()}
    <div class="row">
      <label>Country<select name="country" id="country">${countries.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Postcode<input name="postcode" id="postcode" autocomplete="postal-code" required placeholder="${esc(countries[0].example)}"></label>
    </div>
    <label>Name for this home <small>optional, e.g. "Home" or the street</small><input name="name" type="text"></label>
    <button class="btn btn-primary" type="submit">Continue</button>
  </form></section></div>`;
  $('country').addEventListener('change', () => { $('postcode').placeholder = countries.find((c) => c.code === $('country').value)?.example || ''; });
  onSubmit($('f'), async (b) => {
    const r = await api('/api/onboarding/home', { method: 'POST', body: JSON.stringify(b) });
    try { localStorage.setItem('eb.site', String(r.site.id)); } catch { /* private mode */ }
    history.replaceState(null, '', `/onboarding?home=${r.site.id}`);
    await providersStep(r.site.id, r);
  });
}

const STATUS = { ok: ['good', 'synced'], error: ['bad', 'last sync failed'], skipped: ['warn', 'waiting'], running: ['info', 'syncing'], new: ['info', 'waiting for first sync'] };
const statusBadge = (s) => { const [cls, txt] = STATUS[s] || ['info', s || 'not synced yet']; return `<span class="badge ${cls}">${esc(txt)}</span>`; };

async function providersStep(siteId, created = null) {
  let p;
  try { p = await api(`/api/sites/${siteId}/providers`); } catch (err) {
    content().innerHTML = `<div class="onb-wrap"><section class="card empty"><h2>Home not found</h2><p>${esc(err.message)}</p><p><a class="btn" href="/onboarding">Add a home</a></p></section></div>`;
    return;
  }
  const s = created?.site;
  const where = s ? `<p class="muted">${esc(s.name)} · ${esc(s.postcode)}${s.gsp_region ? ` · price region ${esc(s.gsp_region)}` : ''}${s.carbon_region != null ? ` · carbon region ${esc(s.carbon_region)}` : ''} · ${esc(s.currency)}</p>` : '';
  const card = (c) => {
    if (!c.available) return `<article class="prov-card off"><h3>${esc(c.name)} <span class="badge">${esc(c.role_label)}</span></h3><p>${esc(c.what)}</p><p><b>${esc(c.reason)}</b></p></article>`;
    if (c.connected) {
      return `<article class="prov-card"><h3>${esc(c.name)} <span class="badge good">connected</span></h3><p>${esc(c.what)}</p>
        ${accountList(c)}
        <p>${statusBadge(c.status)}${c.last_error ? `<br><small>${esc(c.last_error)}</small>` : ''}</p>
        ${c.can_disconnect ? `<div class="form-error" id="err-dis-${esc(c.adapter)}" role="alert" aria-live="polite"></div>
        <p class="prov-actions"><button class="btn" type="button" data-disconnect="${esc(c.adapter)}">Disconnect</button></p>
        <details><summary>Not your account? Use another login</summary>${form(c)}</details>` : '<p><small>Read from .env on this home.</small></p>'}</article>`;
    }
    return `<article class="prov-card"><h3>${esc(c.name)} <span class="badge">${esc(c.role_label)}</span></h3><p>${esc(c.what)}</p>${form(c)}</article>`;
  };
  // The account connected, so a wrong one is easy to spot: the login, the plant or account it reads.
  const accountList = (c) => {
    const a = c.account || {};
    const rows = c.adapter === 'sunsynk'
      ? [['Login', a.login], ['Plant', a.plantId != null ? `${a.plantId}${a.plantName ? ` · ${a.plantName}` : ''}` : null]]
      : [['Account', a.accountNumber], ['Supply postcode', a.postcode]];
    const shown = rows.filter(([, v]) => v != null && v !== '');
    return shown.length ? `<dl class="prov-account">${shown.map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>` : '';
  };
  // A field marked pick (the Sunsynk plant) is not typed: after the login, the plants it sees are
  // listed and the user picks theirs.
  const picks = (c) => c.fields.some((f) => f.pick);
  const form = (c) => `<form class="form" data-provider="${esc(c.adapter)}" ${picks(c) ? 'data-pick="1"' : ''} novalidate>${errorBox(`err-${esc(c.adapter)}`)}
    ${c.fields.filter((f) => !f.pick).map((f) => `<label>${esc(f.label)}${f.required ? '' : ' <small>optional</small>'}${f.help ? ` <small>${esc(f.help)}</small>` : ''}
      <input name="${esc(f.key)}" type="${esc(f.type)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} autocomplete="${f.secret ? 'new-password' : 'off'}"></label>`).join('')}
    ${picks(c) ? '<fieldset class="plant-pick" hidden><legend>Pick your plant</legend><div class="plant-list"></div></fieldset>' : ''}
    <button class="btn btn-primary" type="submit">${picks(c) ? 'Find my plants' : `Connect ${esc(c.name)}`}</button></form>`;
  content().innerHTML = `<div class="onb-wrap">${steps(2)}
    ${created?.geoError ? `<div class="banner warn" role="status"><span aria-hidden="true">⚠</span><div>${esc(created.geoError)}</div></div>` : ''}
    ${p.secrets_ready ? '' : '<div class="banner bad" role="status"><span aria-hidden="true">⚠</span><div><b>Logins cannot be stored on this server yet:</b> SECRET_KEY is not set in .env.</div></div>'}
    <section class="card"><div class="card-head"><div><h2>Connect your providers</h2><p>Your logins are checked with the provider, then stored encrypted. They are never shown again.</p>${where}</div></div>
      <div id="connect-msg"></div>
      <div class="prov-grid">${p.connect.map(card).join('') || '<p class="muted">No provider to connect in this market yet.</p>'}</div>
    </section>
    <section class="card section"><div class="card-head"><div><h2>Automatic</h2><p>These need no login: they run for every home in your area.</p></div></div>
      <ul class="auto-list">${p.automatic.map((a) => `<li><span class="badge info" title="${esc(a.adapter)}">${esc(a.label)}</span></li>`).join('')}</ul>
    </section>
    <p class="section"><a class="btn btn-primary" href="/my?site=${siteId}">${p.connect.some((c) => c.connected) ? 'Done: see my energy' : 'Skip for now'}</a></p>
  </div>`;
  document.querySelectorAll('button[data-disconnect]').forEach((b) => {
    const provider = b.dataset.disconnect;
    const name = p.connect.find((c) => c.adapter === provider)?.name || provider;
    b.addEventListener('click', async () => {
      if (!confirm(`Disconnect ${name}?\n\nIts login is forgotten and the data it brought is removed from this home. You can connect it again (or another account) at once.`)) return;
      b.disabled = true; b.textContent = 'Disconnecting…';
      try {
        const r = await api(`/api/sites/${siteId}/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
        await providersStep(siteId, created);
        $('connect-msg').innerHTML = `<p class="form-ok" role="status">${esc(name)} disconnected: its login is forgotten${r.withdrawn ? ` and ${r.withdrawn.toLocaleString()} readings removed from this home` : ''}. Connect it again below.</p>`;
      } catch (err) { showError(err, `err-dis-${provider}`); b.disabled = false; b.textContent = 'Disconnect'; }
    });
  });
  document.querySelectorAll('form[data-provider]').forEach((f) => {
    const provider = f.dataset.provider;
    const pick = f.querySelector('.plant-pick');
    const submit = f.querySelector('button[type="submit"]');
    const name = p.connect.find((c) => c.adapter === provider)?.name || provider;
    // A changed login makes the plant list stale: back to "Find my plants".
    if (pick) {
      f.querySelectorAll('input:not([name="plantId"])').forEach((i) => i.addEventListener('input', () => {
        if (pick.hidden) return;
        pick.hidden = true; pick.querySelector('.plant-list').innerHTML = ''; submit.textContent = 'Find my plants';
      }));
    }
    onSubmit(f, async (credentials) => {
      // Step 1 (Sunsynk): the login, checked, gives its plants to pick from.
      if (pick && !credentials.plantId) {
        if (!pick.hidden) throw new Error('Pick your plant first');
        const { plants } = await api(`/api/sites/${siteId}/providers/${encodeURIComponent(provider)}/plants`, { method: 'POST', body: JSON.stringify({ credentials }) });
        pick.querySelector('.plant-list').innerHTML = plants.map((pl, i) => `<label class="plant-opt">
          <input type="radio" name="plantId" value="${esc(pl.id)}" ${plants.length === 1 || i === 0 ? 'checked' : ''}>
          <span><b>${esc(pl.name || `Plant ${pl.id}`)}</b><small>Plant ${esc(pl.id)}${pl.address ? ` · ${esc(pl.address)}` : ''}</small></span></label>`).join('');
        pick.querySelector('legend').textContent = plants.length === 1 ? 'Your plant' : `Pick your plant (${plants.length} on this login)`;
        pick.hidden = false;
        // onSubmit puts the label back when this returns: the next step's label is set after it.
        setTimeout(() => { submit.textContent = `Connect this plant`; });
        return;
      }
      const r = await api(`/api/sites/${siteId}/providers/${encodeURIComponent(provider)}`, { method: 'POST', body: JSON.stringify({ credentials }) });
      f.reset();
      await providersStep(siteId, created);
      $('connect-msg').innerHTML = `<p class="form-ok" role="status">${esc(name)} connected${r.checked?.plantName ? ` (plant "${esc(r.checked.plantName)}")` : ''}${r.replaced ? ', replacing the account connected before (its data is removed)' : ''}. The first sync has started: your data appears in a few minutes.</p>`;
    }, `err-${provider}`);
  });
}

// ───────────── Page ─────────────

// Opened for a home already added: its providers, not a new home.
if (view === 'onboarding' && new URLSearchParams(location.search).get('home')) TITLES.onboarding = ['Your providers', 'The accounts connected to this home. Not yours? Disconnect it, or connect another login.'];
const [title, subtitle] = TITLES[view] || TITLES.login;
let built = false;
init({
  page: 'account', title, subtitle, periods: false, homeScoped: false,
  // Built once: the page shell re-renders every two minutes, which must not wipe a half-filled form.
  render: async (state) => {
    if (built) return;
    built = true;
    if (view === 'signup') signupView(state);
    else if (view === 'onboarding') await onboardingView(state);
    else loginView(state);
  },
});
