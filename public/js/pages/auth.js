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

const steps = (n) => `<div class="steps" aria-label="Steps">${['Account', 'Postcode', 'Supplier & tariff', 'Connect accounts'].map((t, i) => `<span ${i === n ? 'aria-current="step"' : ''}>${i + 1}. ${t}</span>`).join('')}</div>`;

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
// The tariff step (src/core/tariff-picker.js): the supplier picked, a change asked for from the summary, and a
// provider asked for out of turn (Octopus, picked as the supplier: its login gives the exact tariff).
const tariffUi = { supplier: null, change: false, force: null, forceFrom: null };
const TARIFF = { adapter: 'tariff', name: 'Your tariff', role_label: 'electricity tariff' };
const minor = (v, cur) => (v == null ? '' : `${(+v).toFixed(2)}${cur === 'EUR' ? 'c' : 'p'}`);
const KIND_LABEL = { one_price: 'one price', two_rate: 'day / night', dynamic: 'price changes through the day' };
// Off-peak hours a day where the grid operator fixes them (src/core/tariff-picker.js OFF_PEAK_HOURS_PER_DAY).
const OFF_PEAK_HOURS = { FR: 8 };

// Delete the home for good (DELETE /api/sites/:id, src/core/delete-home.js): what goes is shown first, then the home's
// name is typed to confirm. After it, the home is forgotten in this browser and the first home left is opened.
function wireDelete(siteId) {
  const box = $('del-home');
  if (!box) return;
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    let pv;
    try { pv = await api(`/api/sites/${siteId}/delete-preview`); } catch (err) { $('del-body').innerHTML = `<p class="prov-err">${esc(err.message)}</p>`; return; }
    if (pv.env_home) { $('del-body').innerHTML = '<p class="muted">This home is set up in .env on the server, so it cannot be deleted here: remove it from .env instead.</p>'; return; }
    const what = [
      `${pv.days} day${pv.days === 1 ? '' : 's'} of energy data`,
      `${pv.devices} device${pv.devices === 1 ? '' : 's'}`,
      pv.accounts.length ? `the connected account${pv.accounts.length === 1 ? '' : 's'} (${pv.accounts.map(esc).join(', ')}) and the login${pv.logins === 1 ? '' : 's'} stored for them` : null,
      'your tariff for this home',
    ].filter(Boolean);
    $('del-body').innerHTML = `<p><b>This deletes ${esc(pv.name)} for good.</b> It cannot be undone. Gone with it: ${what.join(', ')}.</p>
      <p class="muted">Your accounts with the providers themselves (Octopus, Sunsynk, your supplier) are not touched.</p>
      <form class="form" id="del-form" novalidate>${errorBox('err-del')}
        <label>Type the home's name to confirm: <b>${esc(pv.name)}</b><input name="confirm" autocomplete="off" required></label>
        <button class="btn btn-danger" type="submit" disabled>Delete this home for good</button></form>`;
    const f = $('del-form');
    const btn = f.querySelector('button');
    f.confirm.addEventListener('input', () => { btn.disabled = f.confirm.value.trim() !== pv.name.trim(); });
    onSubmit(f, async (b) => {
      await api(`/api/sites/${siteId}`, { method: 'DELETE', body: JSON.stringify({ confirm: b.confirm }) });
      try { localStorage.removeItem('eb.site'); } catch { /* private mode */ }
      location.href = '/';
    }, 'err-del');
  });
}

async function providersStep(siteId, created = null, flash = '') {
  let p;
  let choice = null;
  try { [p, choice] = await Promise.all([api(`/api/sites/${siteId}/providers`), api(`/api/sites/${siteId}/tariff-choice`).catch(() => null)]); } catch (err) {
    content().innerHTML = `<div class="onb-flow"><section class="card empty"><h2>Home not found</h2><p>${esc(err.message)}</p><p><a class="btn" href="/onboarding">Add a home</a></p></section></div>`;
    return;
  }
  const s = created?.site;
  const where = s ? `<p class="onb-where">${esc(s.name)}${s.name.includes(s.postcode) ? '' : ` · ${esc(s.postcode)}`}${s.gsp_region ? ` · price region ${esc(s.gsp_region)}` : ''} · ${esc(s.currency)}</p>` : '';
  const list = p.connect.filter((c) => c.available).sort((a, b) => rank(a) - rank(b));
  const soon = p.connect.filter((c) => !c.available);
  // Right after the postcode: who supplies the home's electricity and on which tariff, from the list its country's
  // source holds for its region (src/core/tariff-picker.js). Then what that choice still needs: picking Octopus asks
  // for the Octopus login (exact tariff and smart-meter readings); any other supplier's tariff gives the prices, and
  // the inverter is asked for next because it measures what the home uses. A tariff held already (an Octopus account
  // connected, or one picked) answers the step; a picked tariff means the meter account is not asked for (it stays
  // in the summary, to connect any time).
  const pickerOn = !!(choice && (choice.available || choice.current?.chosen));
  const meterConnected = list.some((c) => c.role === 'meter' && c.connected);
  const tariffDone = !tariffUi.change && (!!choice?.current || meterConnected);
  const flow = [...(pickerOn ? [{ ...TARIFF, connected: tariffDone }] : []),
    ...list.filter((c) => c.role === 'inverter'),
    ...list.filter((c) => c.role !== 'inverter' && !(c.role === 'meter' && choice?.current?.chosen && !c.connected))];
  const forced = tariffUi.force ? list.find((c) => c.adapter === tariffUi.force) : null;
  const current = forced || flow.find((c) => !c.connected && !skipped.has(c.adapter)) || null;
  const next = current ? flow.slice(flow.indexOf(current) + 1).find((c) => !c.connected && !skipped.has(c.adapter)) : null;
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
  const progress = flow.length > 1 ? `<ol class="onb-progress">${flow.map((c, i) => {
    const st = c.connected ? 'done' : c === current ? 'now' : skipped.has(c.adapter) ? 'skipped' : 'todo';
    return `<li class="${st}"><span class="onb-dot" aria-hidden="true">${st === 'done' ? '✓' : i + 1}</span><span>${esc(c.name)}<small>${st === 'done' ? (c === TARIFF || c.adapter === 'tariff' ? 'set' : 'connected') : st === 'skipped' ? 'skipped' : esc(c.role_label)}</small></span></li>`;
  }).join('<li class="onb-line" aria-hidden="true"></li>')}</ol>` : '';

  if (current?.adapter === 'tariff') return tariffStep(siteId, created, { banners, progress, where, next, choice, octopus: list.find((c) => c.adapter === 'octopus') });
  // A tariff picked from a list gives the prices; the inverter measures what the home uses: both make its costs.
  const why = current?.role === 'inverter' && choice?.current?.chosen
    ? `<p class="onb-why">Your tariff (${esc(choice.current.supplier?.name ?? choice.current.name)}) gives the prices. ${esc(current.name)} measures how much you use, so we can work out your costs.</p>` : '';
  if (current) {
    content().innerHTML = `<div class="onb-flow">${steps(forced && tariffUi.forceFrom !== 'summary' ? 2 : 3)}${banners}${progress}
      <section class="card onb-card">
        <div class="onb-card-head"><span class="badge">${esc(current.role_label)}</span><h2>Connect ${esc(current.name)}</h2><p>${esc(current.what)}</p>${why}${where}</div>
        ${form(current)}
        <p class="onb-skip"><button type="button" class="link-btn" data-skip="${esc(current.adapter)}">${forced ? (tariffUi.forceFrom === 'summary' ? '← Back' : 'Back to the tariff list') : `Skip for now${next ? ` and ${next.adapter === 'tariff' ? 'choose your tariff' : `connect ${esc(next.name)}`}` : ''}`}</button></p>
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
    // A tariff with nothing to measure the home's use: prices but no costs, said plainly.
    const usage = list.some((c) => (c.role === 'inverter' || c.role === 'meter') && c.connected);
    const noUsage = choice?.current && !usage
      ? '<div class="banner warn" role="status"><span aria-hidden="true">⚠</span><div><b>Your tariff is set, but nothing measures your use yet.</b> Connect your inverter (or your smart meter account) to see your costs.</div></div>' : '';
    content().innerHTML = `<div class="onb-flow">${steps(3)}${banners}${noUsage}${progress}
      <section class="card onb-card">
        <div class="onb-card-head">${any ? '<span class="onb-check" aria-hidden="true">✓</span>' : ''}<h2>${any ? 'Your home is connected' : 'No provider connected yet'}</h2>
          <p>${any ? 'Your data is loading: the first sync takes a few minutes.' : 'Connect one to see your energy, or come back to it later from "Manage providers".'}</p>${where}</div>
        <div class="prov-rows">${list.filter((c) => c.role === 'inverter').map(row).join('')}${tariffRow(choice, pickerOn)}${list.filter((c) => c.role !== 'inverter').map(row).join('')}${soon.map(soonRow).join('')}${list.length || soon.length ? '' : '<p class="muted">No provider to connect in this market yet.</p>'}</div>
        <a class="btn btn-primary onb-done" href="/my?site=${siteId}">${any ? 'See my energy' : 'Go to my energy'}</a>
      </section>
      ${p.automatic.length ? `<p class="auth-note">Also running for your area, with no login: ${p.automatic.map((a) => esc(a.label)).join(', ')}.</p>` : ''}
      <section class="card onb-danger"><details id="del-home"><summary>Delete this home</summary>
        <div class="onb-danger-body" id="del-body"><p class="muted">Loading what would be deleted…</p></div></details></section>
    </div>`;
    wireDelete(siteId);
  }

  document.querySelectorAll('button[data-skip]').forEach((b) => b.addEventListener('click', () => {
    if (tariffUi.force === b.dataset.skip) Object.assign(tariffUi, { force: null, forceFrom: null }); else skipped.add(b.dataset.skip);
    providersStep(siteId, created);
  }));
  document.querySelectorAll('button[data-tariff]').forEach((b) => b.addEventListener('click', () => {
    Object.assign(tariffUi, { change: true, supplier: null, force: null }); skipped.delete('tariff'); providersStep(siteId, created);
  }));
  // Connect one from the summary: its login form, whether or not the flow would ask for it (a meter account is left out
  // of the flow once a tariff is picked from a list, so un-skipping it alone showed the summary again).
  document.querySelectorAll('button[data-connect]').forEach((b) => b.addEventListener('click', () => {
    skipped.delete(b.dataset.connect);
    Object.assign(tariffUi, { force: b.dataset.connect, forceFrom: 'summary' });
    providersStep(siteId, created);
  }));
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
      if (tariffUi.force === provider) Object.assign(tariffUi, { force: null, forceFrom: null, supplier: null, change: false });
      await providersStep(siteId, created, `<b>${esc(name)} connected</b>${r.checked?.plantName ? ` (plant "${esc(r.checked.plantName)}")` : ''}${r.replaced ? ', replacing the account connected before (its data is removed)' : ''}. Your data is loading.`);
    }, `err-${provider}`);
  });
  document.querySelector('.onb-card form[data-provider] input')?.focus();
}

// ───────────── Your tariff: supplier, then tariff (one shape for every country's source) ─────────────

// The summary's tariff row: what the home is on, from a list (change it) or from a meter account (read only).
function tariffRow(choice, pickerOn) {
  if (!choice || (!pickerOn && !choice.current)) return '';
  const c = choice.current;
  const hours = c?.hours?.length ? ` · cheap rate ${c.hours.map((h) => `${esc(h.from)}–${esc(h.to)}`).join(', ')}` : '';
  const what = c ? `<p>${c.supplier ? `<b>${esc(c.supplier.name)}</b> · ` : ''}${esc(c.supplier && (c.name || '').startsWith(`${c.supplier.name}: `) ? c.name.slice(c.supplier.name.length + 2) : (c.name || c.tariff))}${hours}</p>
    <p class="muted"><small>${c.chosen ? `Chosen by you, from ${esc(c.from)}${c.payment_method && c.payment_method !== 'ANY' ? ` · ${esc(c.payment_label || c.payment_method)}` : ''}` : `From your ${esc(c.via)} account`}</small></p>` : '<p class="muted">Without it, your costs cannot be worked out.</p>';
  return `<article class="prov-row${c ? '' : ' off'}"><div class="prov-row-head"><h3>Your tariff <span class="badge">electricity tariff</span></h3>${c ? '<span class="badge good">set</span>' : '<span class="badge warn">not set</span>'}</div>
    ${what}${pickerOn ? `<div class="prov-actions"><button class="btn" type="button" data-tariff="1">${c ? 'Change tariff' : 'Choose your tariff'}</button></div>` : ''}</article>`;
}

async function tariffStep(siteId, created, ctx) {
  const shell = (body) => `<div class="onb-flow">${steps(2)}${ctx.banners}${ctx.progress}<section class="card onb-card">${body}</section>
    <p class="auth-note">Prices are the supplier's published prices per kWh for your area, before VAT and with VAT. Change your tariff any time from "Your providers".</p></div>`;
  const skipLabel = tariffUi.change ? 'Keep my current tariff' : `Skip for now${ctx.next ? ` and connect ${esc(ctx.next.name)}` : ''}`;
  const skip = `<p class="onb-skip"><button type="button" class="link-btn" id="t-skip">${skipLabel}</button></p>`;
  const wire = () => {
    $('t-skip')?.addEventListener('click', () => { Object.assign(tariffUi, { change: false, supplier: null }); skipped.add('tariff'); providersStep(siteId, created); });
    $('t-back')?.addEventListener('click', () => { tariffUi.supplier = null; tariffStep(siteId, created, ctx); });
  };
  content().innerHTML = shell('<div class="onb-card-head"><span class="badge">electricity tariff</span><h2>Who supplies your electricity?</h2><p class="muted">Loading the suppliers in your area…</p></div>');

  // Stage 1: the suppliers in the home's area.
  if (!tariffUi.supplier) {
    let r;
    try { r = await api(`/api/sites/${siteId}/suppliers`); } catch (err) {
      content().innerHTML = shell(`<div class="onb-card-head"><span class="badge">electricity tariff</span><h2>Who supplies your electricity?</h2>${ctx.where}</div>
        <div class="banner warn" role="status"><span aria-hidden="true">⚠</span><div>${esc(err.message)}</div></div>${skip}`);
      return wire();
    }
    content().innerHTML = shell(`<div class="onb-card-head"><span class="badge">electricity tariff</span><h2>Who supplies your electricity?</h2>
        <p>Pick your supplier, then your tariff. Your costs are worked out from its prices.</p>${ctx.where}</div>
      <div class="form"><label>Search<input id="t-search" type="search" placeholder="Supplier name" autocomplete="off"></label>
      <div class="sup-list" id="t-sups">${r.suppliers.map((x) => `<button type="button" class="sup-opt" data-sup="${esc(x.code)}" data-name="${esc(x.name.toLowerCase())}">
        <span>${esc(x.name)}</span>${x.tariffs ? `<small>${x.tariffs} tariff${x.tariffs === 1 ? '' : 's'}</small>` : ''}</button>`).join('')}</div>
      ${r.suppliers.length ? '' : '<p class="muted">No supplier is listed for your area yet.</p>'}</div>${skip}`);
    $('t-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.sup-opt').forEach((b) => { b.hidden = q && !b.dataset.name.includes(q); });
    });
    document.querySelectorAll('.sup-opt').forEach((b) => b.addEventListener('click', () => {
      tariffUi.supplier = { code: b.dataset.sup, name: b.querySelector('span').textContent };
      tariffStep(siteId, created, ctx);
    }));
    $('t-search').focus();
    return wire();
  }

  // Stage 2: the supplier's tariffs. Octopus: its own login gives the exact tariff (Agile, Intelligent ...).
  const sup = tariffUi.supplier;
  const octo = /^octopus-energy$/.test(sup.code) && ctx.octopus?.available && !ctx.octopus.connected ? ctx.octopus : null;
  let r;
  try { r = await api(`/api/sites/${siteId}/suppliers/${encodeURIComponent(sup.code)}/tariffs`); } catch (err) {
    content().innerHTML = shell(`<div class="onb-card-head"><span class="badge">electricity tariff</span><h2>${esc(sup.name)}</h2></div>
      <div class="banner warn" role="status"><span aria-hidden="true">⚠</span><div>${esc(err.message)}</div></div>
      <p class="onb-skip"><button type="button" class="link-btn" id="t-back">← Another supplier</button></p>${skip}`);
    return wire();
  }
  const cur = r.country === 'GB' ? 'GBP' : 'EUR';
  // A price with VAT where the source gives the rate (tounify): 18.71c/kWh, 22.45c with 20 % VAT.
  const withVat = (v, t) => (t.vat_rate != null ? v * (1 + t.vat_rate) : null);
  const vatPct = (t) => `${Math.round(t.vat_rate * 1000) / 10} % VAT`;
  const priceText = (t, pm) => {
    const o = t.options.find((x) => x.payment_method === pm) || t.options[0];
    if (o?.range) {
      const { min, max, avg } = o.range;
      const inc = t.vat_rate != null ? ` · with ${vatPct(t)}: ${minor(withVat(min, t), cur)} to ${minor(withVat(max, t), cur)}, average ${minor(withVat(avg, t), cur)}` : '';
      return `Today ${minor(min, cur)} to ${minor(max, cur)}/kWh, average ${minor(avg, cur)}${inc}`;
    }
    if (!o || !o.unit.length) return t.quote === 'on_select' ? 'Select it to see its price for your area' : 'price after you choose it';
    const u = o.unit.map((x) => (o.unit.length > 1 ? `${esc(x.label)} ${minor(x.price, cur)}` : `${minor(x.price, cur)}/kWh`)).join(' · ');
    const inc = t.vat_rate != null ? ` · with ${vatPct(t)}: ${o.unit.map((x) => `${o.unit.length > 1 ? `${esc(x.label)} ` : ''}${minor(withVat(x.price, t), cur)}`).join(' · ')}${o.unit.length > 1 ? '' : '/kWh'}` : '';
    return `${u}${o.unit.length > 1 ? ' /kWh' : ''}${inc}${o.standing ? ` · ${minor(o.standing.price, cur)}/${o.standing.per}` : ''}`;
  };
  // tounify: a tariff not priced yet is priced when selected (one read for this home's postal code, kept).
  const quote = async (t) => {
    if (t.prices_known || t.quote !== 'on_select' || t.quoting) return;
    const el = document.querySelector(`[data-price="${CSS.escape(t.id)}"]`);
    t.quoting = true;
    if (el) el.textContent = 'Getting its price for your area…';
    try {
      const q = await api(`/api/sites/${siteId}/suppliers/${encodeURIComponent(sup.code)}/tariffs/${encodeURIComponent(t.id)}/price`);
      if (q.available === false) { if (el) el.textContent = `Price not available now: ${q.reason}`; return; }
      Object.assign(t.options[0], { unit: q.unit ?? [], range: q.range ?? null });
      t.vat_rate = q.vat_rate ?? t.vat_rate;
      t.prices_known = (q.unit?.length ?? 0) > 0 || !!q.range;
      if (el) el.innerHTML = t.prices_known ? priceText(t, t.default_payment_method) : 'No price published for today yet';
    } catch (err) {
      if (el) el.textContent = `Price not available now: ${err.message}`;
    } finally { t.quoting = false; }
  };
  content().innerHTML = shell(`<div class="onb-card-head"><span class="badge">electricity tariff</span><h2>Which ${esc(r.supplier.name)} tariff?</h2>
      <p>${r.tariffs.length} tariff${r.tariffs.length === 1 ? '' : 's'} for your area.</p>${ctx.where}</div>
    ${octo ? `<div class="banner info" role="status"><span aria-hidden="true">★</span><div><b>With Octopus? Connect your account instead.</b> It gives your exact tariff (including Agile and Intelligent Go) and your smart meter's readings.
      <div class="prov-actions" style="margin-top:8px"><button class="btn btn-primary" type="button" id="t-octo">Connect my Octopus account</button></div></div></div>` : ''}
    <form class="form" id="t-form" novalidate>${errorBox('err-tariff')}
      ${r.tariffs.length > 6 ? '<label>Search<input id="t-filter" type="search" placeholder="Tariff name" autocomplete="off"></label>' : ''}
      <div class="tariff-list">${r.tariffs.map((t, i) => `<label class="plant-opt tariff-opt" data-name="${esc(t.name.toLowerCase())}">
        <input type="radio" name="tariff" value="${esc(t.id)}" ${i === 0 && r.tariffs.length === 1 ? 'checked' : ''}>
        <span><b>${esc(t.name)}</b><small>${esc(KIND_LABEL[t.kind] || t.kind)}${t.variant ? ` · ${esc(t.variant)}` : ''}</small><small class="mono" data-price="${esc(t.id)}">${priceText(t, t.default_payment_method)}</small></span></label>`).join('')}</div>
      <div id="t-details"></div>
      <button class="btn btn-primary" type="submit">Save my tariff</button>
    </form>
    <p class="onb-skip"><button type="button" class="link-btn" id="t-back">← Another supplier</button></p>${skip}`);

  // The questions of the tariff picked: payment method (where prices differ by it), its hours, the market's own.
  const details = () => {
    const id = $('t-form').querySelector('input[name="tariff"]:checked')?.value;
    const t = r.tariffs.find((x) => x.id === id);
    if (!t) { $('t-details').innerHTML = ''; return; }
    const pmSel = t.options.length > 1 ? `<label>How do you pay?<select name="payment_method" id="t-pm">${t.options.map((o) => `<option value="${esc(o.payment_method)}" ${o.payment_method === t.default_payment_method ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>` : '';
    const q = (f) => t.questions.find((x) => x.field === f);
    const hq = q('off_peak_hours');
    const hours = hq ? `<fieldset class="t-hours"><legend>${esc(hq.label)}${hq.required ? '' : ' <small>optional</small>'}</legend>${hq.help ? `<small class="muted">${esc(hq.help)}</small>` : ''}
      <div class="row"><label>From<input name="h_from" type="time" value="${esc(t.hours?.from ?? '')}" ${hq.required ? 'required' : ''}></label><label>To<input name="h_to" type="time" value="${esc(t.hours?.to ?? '')}" ${hq.required ? 'required' : ''}></label></div></fieldset>` : '';
    const others = t.questions.filter((x) => x.field !== 'off_peak_hours').map((x) => `<label>${esc(x.label)}${x.required ? '' : ' <small>optional</small>'}${x.help ? ` <small>${esc(x.help)}</small>` : ''}
      ${x.allowed ? `<select name="${esc(x.field)}" ${x.required ? 'required' : ''}><option value="">Choose…</option>${x.allowed.map((v) => `<option>${esc(v)}</option>`).join('')}</select>` : `<input name="${esc(x.field)}" ${x.required ? 'required' : ''}>`}</label>`).join('');
    const since = r.source === 'tounify' ? '' : '<label>On this tariff since <small>optional: leave empty to price all the days we hold</small><input name="since" type="date"></label>';
    $('t-details').innerHTML = `${pmSel}${hours}${others}${since}`;
    $('t-pm')?.addEventListener('change', (e) => { const el = document.querySelector(`[data-price="${CSS.escape(t.id)}"]`); if (el) el.innerHTML = priceText(t, e.target.value); });
  };
  $('t-form').addEventListener('change', (e) => { if (e.target.name === 'tariff') { details(); quote(r.tariffs.find((x) => x.id === e.target.value)); } });
  details();
  { const pre = r.tariffs.find((x) => x.id === $('t-form').querySelector('input[name="tariff"]:checked')?.value); if (pre) quote(pre); }
  $('t-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.tariff-opt').forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); });
  });
  $('t-octo')?.addEventListener('click', () => { Object.assign(tariffUi, { force: 'octopus', forceFrom: 'tariff' }); skipped.delete('octopus'); providersStep(siteId, created); });
  onSubmit($('t-form'), async (b) => {
    if (!b.tariff) throw new Error('Pick your tariff first');
    const body = { supplier: sup.code, tariff: b.tariff };
    if (b.payment_method) body.payment_method = b.payment_method;
    if (b.h_from || b.h_to) {
      // The same check the server makes: where the grid operator fixes the off-peak hours (France: 8 a day, as on
      // the bill), any other total is refused upstream, so it is caught here with a plain message first.
      if (!b.h_from || !b.h_to) throw new Error('Off-peak hours: give both a start and an end, or leave both empty');
      const mins = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
      const len = ((mins(b.h_to) - mins(b.h_from)) + 1440) % 1440 || 1440;
      const need = OFF_PEAK_HOURS[r.country];
      if (need && len !== need * 60) throw new Error(`Off-peak hours must cover exactly ${need} hours a day, as on your bill: ${b.h_from} to ${b.h_to} is ${Math.floor(len / 60)} h${len % 60 ? ` ${len % 60} min` : ''}`);
      body.hours = { from: b.h_from, to: b.h_to };
    }
    if (b.since) body.since = b.since;
    if (b.contracted_kva) body.contracted_kva = Number(b.contracted_kva);
    const res = await api(`/api/sites/${siteId}/tariff`, { method: 'POST', body: JSON.stringify(body) });
    Object.assign(tariffUi, { change: false, supplier: null });
    skipped.delete('tariff');
    await providersStep(siteId, created, `<b>Tariff saved:</b> ${esc(r.supplier.name)} · ${esc(r.tariffs.find((t) => t.id === b.tariff)?.name ?? b.tariff)}${res.from ? `, priced from ${esc(res.from)}` : ''}.${res.notes?.length ? ` ${esc(res.notes.join('; '))}.` : ''}`);
  }, 'err-tariff');
  return wire();
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
