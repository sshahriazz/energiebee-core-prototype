// Sign in (/login), create an account (/signup), and add a home (/onboarding): the account (src/core/users.js),
// then the home from a postcode and its providers connected with the user's own logins
// (src/core/signup.js). Logins go to the server once and are never shown again.
import { api, esc } from '../api.js';
import { init, BEE } from '../layout.js';

const view = location.pathname.replace(/^\/|\.html$/g, '') || 'login';
const TITLES = {
  login: ['Sign in', ''],
  signup: ['Create your account', ''],
  onboarding: ['Add your home', ''],
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

// ───────────── Sign in (/login) and create an account (/signup) ─────────────

const steps = (n) => `<div class="steps" aria-label="Steps">${['Account', 'Postcode', 'Connect providers'].map((t, i) => `<span ${i === n ? 'aria-current="step"' : ''}>${i + 1}. ${t}</span>`).join('')}</div>`;

// A centred card: the bee, a heading, the form, and a link to the other page.
const authCard = ({ heading, sub, form, alt = '', top = '' }) => `<div class="auth-shell">
  ${top}<section class="auth-card">
    <div class="auth-logo">${BEE}</div>
    <h1>${heading}</h1><p class="auth-sub">${sub}</p>
    ${form}
    ${alt ? `<p class="auth-alt">${alt}</p>` : ''}
  </section>
  <p class="auth-note">Your Sunsynk and Octopus logins are checked with them and stored encrypted. They are never shown again.</p>
</div>`;
const usernameField = (hint = '') => `<label>Username${hint ? ` <small>${hint}</small>` : ''}<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="30" required></label>`;
const pinField = (autocomplete) => `<label>PIN <small>4 digits</small><input name="pin" class="pin-input" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="${autocomplete}" placeholder="••••" required></label>`;

function loginView(state) {
  if (state.me?.user) { location.replace(state.sites.length ? '/my' : '/onboarding'); return; }
  content().innerHTML = authCard({
    heading: 'Welcome back', sub: 'Sign in with your username and 4-digit PIN.',
    form: `<form class="form" id="f" novalidate>${errorBox()}${usernameField()}${pinField('current-password')}
      <button class="btn btn-primary" type="submit">Sign in</button></form>`,
    alt: 'New to EnergieBee? <a href="/signup">Create a new account</a>',
  });
  $('f').querySelector('input').focus();
  onSubmit($('f'), async (b) => {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify(b) });
    const me = await api('/api/auth/me');
    try { localStorage.removeItem('eb.site'); } catch { /* private mode */ }
    location.href = me.homes ? '/my' : '/onboarding';
  });
}

// The demo server makes users here too (picked in its "Viewing as" dropdown, without a PIN to sign in with).
function signupView(state) {
  const demo = !!state.me?.switcher;
  if (state.me?.user && !demo) { location.replace('/onboarding'); return; }
  content().innerHTML = authCard({
    top: steps(0),
    heading: 'Create your account', sub: 'Pick a username and a 4-digit PIN. Next: your postcode, then your inverter and meter.',
    form: `<form class="form" id="f" novalidate>${errorBox()}${usernameField('3 to 30 letters or digits')}${pinField('new-password')}
      <button class="btn btn-primary" type="submit">Create account</button></form>`,
    alt: demo ? 'Demo server: the new user is picked in the "Viewing as" dropdown, next to the others.' : 'Already have an account? <a href="/login">Sign in</a>',
  });
  $('f').querySelector('input').focus();
  onSubmit($('f'), async (b) => {
    const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(b) });
    // Demo server: pick the new user in the dropdown (no cookie there), with no home chosen yet.
    if (demo) {
      try { localStorage.setItem('eb.user', String(r.user.id)); localStorage.removeItem('eb.site'); } catch { /* private mode */ }
    }
    location.href = '/onboarding';
  });
}

// ───────────── Add a home: postcode, then providers ─────────────


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
  content().innerHTML = `<div class="onb-flow">${steps(1)}<section class="card onb-card">
    <div class="onb-card-head"><h2>Where is your home?</h2><p>Your postcode gives us your region, prices and weather.</p></div>
    <form class="form" id="f" novalidate>
    ${errorBox()}
    <div class="row">
      <label>Country<select name="country" id="country">${countries.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Postcode<input name="postcode" id="postcode" autocomplete="postal-code" required placeholder="${esc(countries[0].example)}"></label>
    </div>
    <label>Name for this home <small>optional, e.g. "Home" or the street</small><input name="name" type="text"></label>
    <button class="btn btn-primary" type="submit">Continue</button>
  </form></section></div>`;
  $('postcode').focus();
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

// One provider at a time: the inverter first, then the meter, then anything else the home's market lists. Each can be
// skipped; when none is left to ask for, a summary of the accounts connected (disconnect or use another login there).
// A provider not switched on yet in the market (coming soon) is never asked for, only listed in the summary.
const ROLE_ORDER = ['inverter', 'meter'];
const rank = (c) => { const i = ROLE_ORDER.indexOf(c.role); return i < 0 ? ROLE_ORDER.length : i; };
const skipped = new Set();   // skipped on this visit: asked again on the next one

async function providersStep(siteId, created = null, flash = '') {
  let p;
  try { p = await api(`/api/sites/${siteId}/providers`); } catch (err) {
    content().innerHTML = `<div class="onb-flow"><section class="card empty"><h2>Home not found</h2><p>${esc(err.message)}</p><p><a class="btn" href="/onboarding">Add a home</a></p></section></div>`;
    return;
  }
  const s = created?.site;
  const where = s ? `<p class="onb-where">${esc(s.name)}${s.name.includes(s.postcode) ? '' : ` · ${esc(s.postcode)}`}${s.gsp_region ? ` · price region ${esc(s.gsp_region)}` : ''} · ${esc(s.currency)}</p>` : '';
  const list = p.connect.filter((c) => c.available).sort((a, b) => rank(a) - rank(b));
  const soon = p.connect.filter((c) => !c.available);
  const current = list.find((c) => !c.connected && !skipped.has(c.adapter)) || null;
  const next = current ? list.slice(list.indexOf(current) + 1).find((c) => !c.connected && !skipped.has(c.adapter)) : null;
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
  const banners = `${created?.geoError ? `<div class="banner warn" role="status"><span aria-hidden="true">⚠</span><div>${esc(created.geoError)}</div></div>` : ''}
    ${p.secrets_ready ? '' : '<div class="banner bad" role="status"><span aria-hidden="true">⚠</span><div><b>Logins cannot be stored on this server yet:</b> SECRET_KEY is not set in .env.</div></div>'}
    ${flash ? `<p class="form-ok onb-flash" role="status">${flash}</p>` : ''}`;
  // Where the user is: each provider asked for, done, now, skipped or still to come.
  const progress = list.length > 1 ? `<ol class="onb-progress">${list.map((c, i) => {
    const st = c.connected ? 'done' : c === current ? 'now' : skipped.has(c.adapter) ? 'skipped' : 'todo';
    return `<li class="${st}"><span class="onb-dot" aria-hidden="true">${st === 'done' ? '✓' : i + 1}</span><span>${esc(c.name)}<small>${st === 'done' ? 'connected' : st === 'skipped' ? 'skipped' : esc(c.role_label)}</small></span></li>`;
  }).join('<li class="onb-line" aria-hidden="true"></li>')}</ol>` : '';

  if (current) {
    content().innerHTML = `<div class="onb-flow">${steps(2)}${banners}${progress}
      <section class="card onb-card">
        <div class="onb-card-head"><span class="badge">${esc(current.role_label)}</span><h2>Connect ${esc(current.name)}</h2><p>${esc(current.what)}</p>${where}</div>
        ${form(current)}
        <p class="onb-skip"><button type="button" class="link-btn" data-skip="${esc(current.adapter)}">Skip for now${next ? ` and connect ${esc(next.name)}` : ''}</button></p>
      </section>
      <p class="auth-note">Your login is checked with ${esc(current.name)}, then stored encrypted. It is never shown again.</p>
    </div>`;
  } else {
    const any = list.some((c) => c.connected);
    const row = (c) => c.connected
      ? `<article class="prov-row"><div class="prov-row-head"><h3>${esc(c.name)} <span class="badge">${esc(c.role_label)}</span></h3>${statusBadge(c.status)}</div>
        ${accountList(c)}${c.last_error ? `<p class="prov-err">${esc(c.last_error)}</p>` : ''}
        ${c.can_disconnect ? `<div class="form-error" id="err-dis-${esc(c.adapter)}" role="alert" aria-live="polite"></div>
        <div class="prov-actions"><button class="btn" type="button" data-disconnect="${esc(c.adapter)}">Disconnect</button>
          <details><summary>Not your account? Use another login</summary>${form(c)}</details></div>` : '<p class="muted"><small>Read from .env on this home.</small></p>'}</article>`
      : `<article class="prov-row off"><div class="prov-row-head"><h3>${esc(c.name)} <span class="badge">${esc(c.role_label)}</span></h3><span class="badge warn">not connected</span></div>
        <p class="muted">${esc(c.what)}</p><div class="prov-actions"><button class="btn" type="button" data-connect="${esc(c.adapter)}">Connect ${esc(c.name)}</button></div></article>`;
    const soonRow = (c) => `<article class="prov-row off"><div class="prov-row-head"><h3>${esc(c.name)} <span class="badge">${esc(c.role_label)}</span></h3><span class="badge">coming soon</span></div><p class="muted">${esc(c.what)}</p></article>`;
    content().innerHTML = `<div class="onb-flow">${steps(2)}${banners}${progress}
      <section class="card onb-card">
        <div class="onb-card-head">${any ? '<span class="onb-check" aria-hidden="true">✓</span>' : ''}<h2>${any ? 'Your home is connected' : 'No provider connected yet'}</h2>
          <p>${any ? 'Your data is loading: the first sync takes a few minutes.' : 'Connect one to see your energy, or come back to it later from "Manage providers".'}</p>${where}</div>
        <div class="prov-rows">${list.map(row).join('')}${soon.map(soonRow).join('')}${list.length || soon.length ? '' : '<p class="muted">No provider to connect in this market yet.</p>'}</div>
        <a class="btn btn-primary onb-done" href="/my?site=${siteId}">${any ? 'See my energy' : 'Go to my energy'}</a>
      </section>
      ${p.automatic.length ? `<p class="auth-note">Also running for your area, with no login: ${p.automatic.map((a) => esc(a.label)).join(', ')}.</p>` : ''}
    </div>`;
  }

  document.querySelectorAll('button[data-skip]').forEach((b) => b.addEventListener('click', () => { skipped.add(b.dataset.skip); providersStep(siteId, created); }));
  document.querySelectorAll('button[data-connect]').forEach((b) => b.addEventListener('click', () => { skipped.delete(b.dataset.connect); providersStep(siteId, created); }));
  document.querySelectorAll('button[data-disconnect]').forEach((b) => {
    const provider = b.dataset.disconnect;
    const name = p.connect.find((c) => c.adapter === provider)?.name || provider;
    b.addEventListener('click', async () => {
      if (!confirm(`Disconnect ${name}?\n\nIts login is forgotten and the data it brought is removed from this home. You can connect it again (or another account) at once.`)) return;
      b.disabled = true; b.textContent = 'Disconnecting…';
      try {
        const r = await api(`/api/sites/${siteId}/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
        skipped.add(provider);   // back to the summary, not straight into its form
        await providersStep(siteId, created, `${esc(name)} disconnected: its login is forgotten${r.withdrawn ? ` and ${r.withdrawn.toLocaleString()} readings removed from this home` : ''}.`);
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
      skipped.delete(provider);
      await providersStep(siteId, created, `<b>${esc(name)} connected</b>${r.checked?.plantName ? ` (plant "${esc(r.checked.plantName)}")` : ''}${r.replaced ? ', replacing the account connected before (its data is removed)' : ''}. Your data is loading.`);
    }, `err-${provider}`);
  });
  document.querySelector('.onb-card form[data-provider] input')?.focus();
}

// ───────────── Page ─────────────

// Opened for a home already added: its providers, not a new home.
if (view === 'onboarding' && new URLSearchParams(location.search).get('home')) TITLES.onboarding = ['Your providers', ''];
const [title, subtitle] = TITLES[view] || TITLES.login;
let built = false;
init({
  page: 'account', title, subtitle, periods: false, homeScoped: false, bare: view !== 'onboarding',
  // Built once: the page shell re-renders every two minutes, which must not wipe a half-filled form.
  render: async (state) => {
    if (built) return;
    built = true;
    if (view === 'onboarding') await onboardingView(state);
    else if (view === 'signup') signupView(state);
    else loginView(state);
  },
});
