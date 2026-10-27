// Providers: which provider fills each role of a home, how its points are translated, what was rejected, and the
// flow to add, change or remove a provider with a preview of what it would do to the slots already built
// (GET /api/sites/:id/onboarding, POST /api/sites/:id/bindings/preview, ...). Nothing is kept until the last step.
import { api, esc, fmt } from '../api.js';
import { init } from '../layout.js';
import { explainerHtml, roleCard, rejectsCard, historyCard, PART_WORDS, dateFmt } from '../onboarding-view.js';

let ctx = null;        // the page shell's state (the selected home)
let model = null;      // GET /api/sites/:id/onboarding
let catalog = null;    // GET /api/sources
let wz = null;         // the flow in progress, or null

const FLOWS = {
  bind: ['pick', 'map', 'when', 'reason', 'confirm'],
  unbind: ['pick', 'when', 'reason', 'confirm'],
};
const STEP = {
  pick: { label: 'Role and provider', title: 'Which role, and which provider?', help: 'A role is what the timeline needs. Pick the provider that should fill it. A provider that is not listed has to be added to the system first (a source row).' },
  map: { label: 'Map its points', title: 'How do its points become standard measurements?', help: 'Each row says what one point the provider sends becomes. Rows that already exist, or the provider\'s built-in mapping, are filled in. Rows with no point are ignored.' },
  when: { label: 'Start and preview', title: 'When does it start, and what would change?', help: 'Slots before the start stay exactly as they are. A start in the past rebuilds slots that are already built, so the preview shows what would move. Nothing is kept yet.' },
  reason: { label: 'Reason', title: 'Why are you making this change?', help: 'The reason is kept with the change. It is required when the change alters slots that are already built.' },
  confirm: { label: 'Confirm', title: 'Check and confirm', help: 'This is the last step. Confirming saves the mapping and the binding, then queues the affected days for a rebuild.' },
};
const FIELD_LABELS = { solar: ['Solar', 'kWh'], home: ['Home use', 'kWh'], grid_import: ['Grid import', 'kWh'], grid_export: ['Grid export', 'kWh'], total_cost: ['Cost', 'money'], state: ['Slot status (final, waiting, missing)', ''] };

// ───────────── Small helpers ─────────────
async function call(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const roleOf = (code) => model.roles.find((r) => r.role === code);
const srcOf = (code) => catalog.sources.find((s) => s.code === code);
const sourceColors = () => { const m = new Map(); for (const r of model.roles) for (const b of r.bindings) if (!m.has(b.source)) m.set(b.source, m.size); return m; };
const msg = (kind, html) => `<div class="ob-msg ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}"><div>${html}</div></div>`;
const hasDevices = () => model.devices.some((d) => !d.retiredAt);

// ───────────── The page ─────────────
async function load() {
  const [m, c] = await Promise.all([api(`/api/sites/${ctx.siteId}/onboarding`), catalog ? Promise.resolve(catalog) : api('/api/sources')]);
  model = m; catalog = c;
}

function drawPage() {
  const content = document.getElementById('content');
  const tz = model.site.timezone;
  const colors = sourceColors();
  const unfilled = model.roles.filter((r) => !r.bindings.length).length;
  content.innerHTML = `
    ${explainerHtml()}
    <div class="ob-top">
      <button class="btn btn-primary" id="ob-add">Add a provider</button>
      <span class="muted">${model.roles.length} roles for <b>${esc(model.site.name)}</b>${unfilled ? `, ${unfilled} with no provider` : ''}.</span>
      <span class="spacer"></span>
      <button class="btn" id="ob-reload" title="Read the current state again">↻ Refresh</button>
    </div>
    <div id="wizard"></div>
    <div id="ob-flash"></div>
    <div class="ob-roles">${model.roles.map((r) => roleCard(r, model, tz, colors)).join('')}</div>
    <div class="ob-two">${rejectsCard(model, tz)}${historyCard(model, tz)}</div>`;
  document.getElementById('ob-add').addEventListener('click', () => openFlow({ mode: 'bind' }));
  document.getElementById('ob-reload').addEventListener('click', refresh);
  content.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => onAction(b)));
  if (wz) drawWizard();
}

async function refresh() {
  try { await load(); drawPage(); } catch (err) { document.getElementById('content').innerHTML = `<div class="card empty"><h2>Providers could not be loaded</h2><p>${esc(err.message)}</p></div>`; }
}

async function render(state) {
  ctx = state;
  document.getElementById('content').innerHTML = '<div class="skeleton">Loading the providers of this home…</div>';
  wz = null;
  await refresh();
}

function onAction(b) {
  const a = b.dataset.act;
  if (a === 'add') openFlow({ mode: 'bind', role: b.dataset.role });
  else if (a === 'map') openFlow({ mode: 'bind', role: b.dataset.role, source: b.dataset.source, deviceId: b.dataset.device === '' ? null : Number(b.dataset.device), startAt: 'map' });
  else if (a === 'end') {
    const role = roleOf(b.dataset.role);
    const bd = role.bindings.find((x) => x.id === Number(b.dataset.binding));
    openFlow({ mode: 'unbind', role: role.role, bindingId: bd?.id, startAt: 'when' });
  } else if (a === 'mappoint') {
    const role = model.roles.find((r) => r.bindings.some((x) => x.source === b.dataset.source));
    openFlow({ mode: 'bind', role: role?.role, source: b.dataset.source, pendingPoint: b.dataset.point, startAt: 'map' });
  } else if (a === 'retire') retire(Number(b.dataset.channel));
}

async function retire(id) {
  const r = await call(`/api/sites/${ctx.siteId}/channels/retire`, { id });
  flash(r.ok ? msg('good', `Channel ${id} is no longer used. The point it mapped is reported as unmapped from now on.`) : msg('bad', esc(r.data.error ?? 'Could not remove the channel')));
  if (r.ok) await refresh();
}
function flash(html) { const el = document.getElementById('ob-flash'); if (el) el.innerHTML = html ? `<div style="margin-bottom:16px">${html}</div>` : ''; }

// ───────────── The flow ─────────────
function openFlow({ mode, role = null, source = null, deviceId = null, bindingId = null, startAt = null, pendingPoint = null }) {
  const firstRole = role ?? (mode === 'unbind' ? model.roles.find((r) => r.bindings.length)?.role : model.roles[0]?.role);
  wz = {
    mode, step: startAt ?? 'pick', role: firstRole, source: source ?? null, deviceId, bindingId, priority: 0, keep: false,
    rows: null, rowsKey: null, rowErrors: {}, pendingPoint, whenKind: 'now', date: today(), reason: '', rebuild: true,
    preview: null, previewErr: null, loading: false, busy: false, error: null, done: null,
  };
  if (mode === 'bind' && !wz.source) wz.source = suggestSource(wz.role);
  if (startAt === 'when') wz.whenKind = 'now';
  flash('');
  drawWizard(true);
  if (wz.step === 'when') runPreview();
  document.getElementById('wizard')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function suggestSource(role) {
  const s = catalog.sources.find((x) => x.suggestedRoles.includes(role) && !roleOf(role)?.bindings.some((b) => b.source === x.code));
  return s?.code ?? catalog.sources.find((x) => x.suggestedRoles.includes(role))?.code ?? catalog.sources[0]?.code ?? null;
}

const stepsOf = () => FLOWS[wz.mode];
const stepIndex = () => stepsOf().indexOf(wz.step);

function stepper() {
  const steps = stepsOf(); const at = stepIndex();
  return `<ol class="ob-steps" aria-label="Steps">${steps.map((s, i) => `<li class="${i < at ? 'done' : ''}" ${i === at ? 'aria-current="step"' : ''}><span>${esc(STEP[s].label)}</span></li>`).join('')}</ol>`;
}

function drawWizard(focus = false) {
  const host = document.getElementById('wizard');
  if (!host) return;
  if (!wz) { host.innerHTML = ''; return; }
  const title = wz.mode === 'bind' ? 'Add or change a provider' : 'End a provider';
  if (wz.done) { host.innerHTML = `<section class="card ob-wizard" aria-label="${title}">${doneHtml()}</section>`; wireWizard(); host.querySelector('.ob-step-title')?.focus(); return; }
  const s = STEP[wz.step];
  host.innerHTML = `<section class="card ob-wizard" aria-label="${esc(title)}">
    <div class="card-head"><div><h2>${esc(title)}</h2></div><button class="btn btn-sm" data-w="cancel">Cancel</button></div>
    ${stepper()}
    <h3 class="ob-step-title" tabindex="-1" id="ob-step-title">${esc(s.title)}</h3>
    <p class="ob-step-help">${esc(s.help)}</p>
    <div id="ob-step-body">${stepBody()}</div>
    ${wz.error ? msg('bad', esc(wz.error)) : ''}
    <div class="ob-foot">
      <button class="btn" data-w="back" ${stepIndex() === 0 ? 'disabled' : ''}>Back</button>
      <div class="right">${nextButton()}</div>
    </div>
  </section>`;
  wireWizard();
  if (focus) host.querySelector('.ob-step-title')?.focus();
}

function nextButton() {
  if (wz.step === 'confirm') return `<button class="btn btn-primary" data-w="confirm" ${wz.busy ? 'disabled' : ''}>${wz.busy ? 'Saving…' : wz.mode === 'bind' ? 'Confirm and save' : 'Confirm and end it'}</button>`;
  const need = nextBlocked();
  return `<button class="btn btn-primary" data-w="next" ${need || wz.busy || wz.loading ? 'disabled' : ''} ${need ? `title="${esc(need)}"` : ''}>${wz.step === 'map' ? (wz.busy ? 'Checking…' : 'Check and continue') : 'Continue'}</button>`;
}
function nextBlocked() {
  if (wz.step === 'pick') {
    if (!wz.role) return 'Pick a role';
    if (wz.mode === 'bind' && !wz.source) return 'Pick a provider';
    if (wz.mode === 'unbind' && wz.bindingId == null) return 'Pick which one to end';
  }
  if (wz.step === 'when') {
    if (wz.whenKind === 'date' && !wz.date) return 'Choose a date';
    if (wz.previewErr || !wz.preview) return 'The preview must work first';
  }
  if (wz.step === 'reason' && wz.preview?.needsReason && !wz.reason.trim()) return 'A reason is required: this changes slots that are already built';
  return '';
}

// ── step bodies ──
function stepBody() {
  return { pick: pickStep, map: mapStep, when: whenStep, reason: reasonStep, confirm: confirmStep }[wz.step]();
}

function pickStep() {
  const roleOpts = (wz.mode === 'unbind' ? model.roles.filter((r) => r.bindings.length) : model.roles)
    .map((r) => `<option value="${esc(r.role)}" ${r.role === wz.role ? 'selected' : ''}>${esc(r.label)}${r.label !== r.role ? ` (${esc(r.role)})` : ''}</option>`).join('');
  const role = roleOf(wz.role);
  const roleField = `<label class="ob-field"><span>Role</span><select data-f="role">${roleOpts}</select><small>${esc(role?.help ?? '')}</small></label>`;
  if (wz.mode === 'unbind') {
    const open = role?.bindings.filter((b) => !b.toDate) ?? [];
    return `<div class="ob-form">${roleField}</div>
      <div class="ob-radios" role="radiogroup" aria-label="Which binding to end" style="margin-top:12px">${open.length ? open.map((b) => `
        <label class="ob-radio"><input type="radio" name="bnd" value="${b.id}" data-f="binding" ${b.id === wz.bindingId ? 'checked' : ''}>
        <div><b>${esc(b.source)}${b.deviceId != null ? ` on device ${b.deviceId}` : ''}</b><span>since ${esc(b.fromDate ?? 'the beginning')}${b.data?.last != null ? `, data until ${esc(dateFmt(model.site.timezone).date(b.data.last))}` : ''}</span></div></label>`).join('')
        : '<p class="ob-note">This role has no open binding to end.</p>'}</div>`;
  }
  const ranked = [...catalog.sources].sort((a, b) => Number(b.suggestedRoles.includes(wz.role)) - Number(a.suggestedRoles.includes(wz.role)) || a.code.localeCompare(b.code));
  const srcOpts = ranked.map((s) => `<option value="${esc(s.code)}" ${s.code === wz.source ? 'selected' : ''}>${s.suggestedRoles.includes(wz.role) ? '★ ' : ''}${esc(s.code)} · ${esc(s.name)}</option>`).join('');
  const src = srcOf(wz.source);
  const devOpts = `<option value="">The home itself (one device reports for the whole home)</option>${model.devices.filter((d) => !d.retiredAt).map((d) => `<option value="${d.id}" ${d.id === wz.deviceId ? 'selected' : ''}>Device ${d.id}: ${esc(d.label ?? d.kind)} (${esc(d.kind)})</option>`).join('')}`;
  const c = src?.contract ?? {};
  const facts = src ? [['Time', c.timeZone], ['Units', c.units], ['No data', c.missing], ['Holds a reading', src.traits.holdS ? `${src.traits.holdS} seconds` : null]].filter(([, v]) => v) : [];
  const existing = roleOf(wz.role)?.bindings.filter((b) => !b.toDate) ?? [];
  return `<div class="ob-form">
      ${roleField}
      <label class="ob-field"><span>Provider (source)</span><select data-f="source">${srcOpts}</select><small>★ marks providers whose built-in mapping fits this role. Any listed provider can be bound.</small></label>
      ${hasDevices() ? `<label class="ob-field"><span>Device</span><select data-f="device">${devOpts}</select><small>Pick a device when the home has several of one kind (two inverters): each is its own binding and their figures are added.</small></label>` : ''}
    </div>
    ${src && facts.length ? `<div class="ob-note" style="margin-top:10px"><b>${esc(src.name)}</b><br>${facts.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')}</div>` : ''}
    ${existing.length ? msg('', `Currently bound: ${existing.map((b) => esc(b.source)).join(', ')}. Binding another provider ends ${existing.length > 1 ? 'these' : 'this one'} on the start date you choose, unless you add it beside them below.`) : ''}
    <details class="ob-details"><summary>More options</summary>
      <div class="ob-form" style="margin-top:8px">
        <label class="ob-field"><span>Priority</span><input type="number" min="0" max="99" step="1" value="${wz.priority}" data-f="priority"><small>Only matters when several providers fill one role at once (the solar forecast): the lowest number is used first.</small></label>
        <label class="ob-radio" style="align-self:end"><input type="checkbox" data-f="keep" ${wz.keep ? 'checked' : ''}><div><b>Add beside the current providers</b><span>Do not end the ones already bound.</span></div></label>
      </div>
    </details>`;
}

function initRows() {
  const key = `${wz.source}|${wz.deviceId ?? ''}`;
  if (wz.rowsKey === key && wz.rows) return;
  const existing = model.channels.filter((c) => c.source === wz.source && (c.deviceId ?? null) === (wz.deviceId ?? null));
  const def = srcOf(wz.source)?.defaultChannels ?? [];
  const role = catalog.roles.find((r) => r.role === wz.role);
  let rows;
  if (existing.length) rows = existing.map((c) => ({ id: c.id, orig: { point: c.point, metric: c.metric }, point: c.point, metric: c.metric, scale: c.scale, shift: c.shift, part: c.part, min: c.min ?? '', max: c.max ?? '' }));
  else if (def.length) rows = def.map((d) => ({ id: null, point: d.point, metric: d.metric, scale: d.scale, shift: d.shift, part: d.part, min: d.min ?? '', max: d.max ?? '' }));
  else rows = (role?.metrics ?? []).map((m) => ({ id: null, point: '', metric: m, scale: 1, shift: 0, part: 'all', min: '', max: '' }));
  if (wz.pendingPoint) { rows.push({ id: null, point: wz.pendingPoint, metric: role?.metrics?.[0] ?? catalog.metrics[0]?.code, scale: 1, shift: 0, part: 'all', min: '', max: '' }); wz.pendingPoint = null; }
  wz.rows = rows; wz.rowsKey = key; wz.removed = [];
}

function metricOptions(selected) {
  const role = catalog.roles.find((r) => r.role === wz.role);
  const fits = new Set(role?.metrics ?? []);
  const opt = (m) => `<option value="${esc(m.code)}" ${m.code === selected ? 'selected' : ''}>${esc(m.code)} (${esc(m.unit ?? '')})</option>`;
  const fit = catalog.metrics.filter((m) => fits.has(m.code));
  const rest = catalog.metrics.filter((m) => !fits.has(m.code));
  return `${fit.length ? `<optgroup label="Fits this role">${fit.map(opt).join('')}</optgroup>` : ''}<optgroup label="All measurements">${rest.map(opt).join('')}</optgroup>`;
}

function mapStep() {
  initRows();
  const rows = wz.rows.map((r, i) => `<tr>
    <td><input class="wide mono" aria-label="Point ${i + 1}: the provider's own name" data-row="${i}" data-f="point" value="${esc(r.point)}" placeholder="e.g. grid_kw"></td>
    <td><select aria-label="Measurement for row ${i + 1}" data-row="${i}" data-f="metric">${metricOptions(r.metric)}</select></td>
    <td><input type="number" step="any" aria-label="Times, row ${i + 1}" data-row="${i}" data-f="scale" value="${esc(r.scale)}"></td>
    <td><input type="number" step="any" aria-label="Plus, row ${i + 1}" data-row="${i}" data-f="shift" value="${esc(r.shift)}"></td>
    <td><select aria-label="Sign, row ${i + 1}" data-row="${i}" data-f="part">${Object.entries(PART_WORDS).map(([k, v]) => `<option value="${k}" ${k === r.part ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></td>
    <td><input type="number" step="any" aria-label="Lowest allowed, row ${i + 1}" data-row="${i}" data-f="min" value="${esc(r.min)}" placeholder="any"></td>
    <td><input type="number" step="any" aria-label="Highest allowed, row ${i + 1}" data-row="${i}" data-f="max" value="${esc(r.max)}" placeholder="any"></td>
    <td><button class="btn btn-sm" data-w="delrow" data-i="${i}" aria-label="Remove row ${i + 1}">✕</button>${wz.rowErrors[i] ? `<div class="row-err" role="alert">${esc(wz.rowErrors[i])}</div>` : ''}</td></tr>`).join('');
  return `<div class="table-wrap"><table class="ob-map"><thead><tr><th>Point it sends</th><th>Becomes</th><th>Times</th><th>Plus</th><th>Sign</th><th>Lowest</th><th>Highest</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="faint">No rows yet. Add one.</td></tr>'}</tbody></table></div>
    <div class="ob-actions" style="margin-top:8px"><button class="btn btn-sm" data-w="addrow">+ Add a row</button></div>
    <details class="ob-details"><summary>What do these columns mean?</summary><dl class="ob-map-help">
      <dt>Point it sends</dt><dd>The provider's own name for the measurement, exactly as it sends it.</dd>
      <dt>Becomes</dt><dd>The standard measurement it turns into. These are the same for every provider.</dd>
      <dt>Times and Plus</dt><dd>The unit conversion: value × times + plus. Kilowatts to watts is times 1000.</dd>
      <dt>Sign</dt><dd>For one number that goes both ways (grid: positive is import, negative is export) make two rows for the same point: one with "only the positive part" and one with "only the negative part".</dd>
      <dt>Lowest and Highest</dt><dd>The believable range after conversion. A value outside it is refused and listed under Rejected values, never stored.</dd></dl></details>
    ${msg('', 'Saving a mapping changes how data is read from now on. It does not change facts already stored, so it does not appear in the preview of the next step.')}`;
}

function whenStep() {
  const unb = wz.mode === 'unbind';
  const opt = (k, title, sub) => `<label class="ob-radio"><input type="radio" name="when" value="${k}" data-f="whenKind" ${wz.whenKind === k ? 'checked' : ''}><div><b>${esc(title)}</b><span>${esc(sub)}</span></div></label>`;
  return `<div class="ob-form" style="grid-template-columns:minmax(0,1fr)"><div class="ob-radios" role="radiogroup" aria-label="Start">
      ${opt('now', unb ? 'End it now' : 'From now on', 'No slot that is already built changes.')}
      ${opt('date', unb ? 'End it on a date' : 'From a date', 'A date in the past rebuilds the slots from that date.')}
      ${unb ? '' : opt('beginning', 'From the very beginning', 'Rebuilds every built slot from the first one.')}
    </div>
    ${wz.whenKind === 'date' ? `<label class="ob-field" style="max-width:260px"><span>${unb ? 'End date' : 'Start date'} (local date of the home)</span><input type="date" data-f="date" value="${esc(wz.date)}"></label>` : ''}</div>
    <div id="ob-preview" style="margin-top:14px" aria-live="polite">${previewHtml()}</div>`;
}

function previewHtml() {
  if (wz.loading) return '<p class="ob-loading">Working out what would change… this rebuilds the home twice in memory and keeps nothing.</p>';
  if (wz.previewErr) return msg('bad', esc(wz.previewErr));
  const p = wz.preview;
  if (!p) return '';
  const f = dateFmt(model.site.timezone);
  const im = p.impact;
  const pct = im.slots ? Math.round((im.changed / im.slots) * 100) : 0;
  const out = [];
  out.push(im.changed
    ? `<div class="ob-big"><b>${im.changed}</b><span>of ${im.slots} built slots would change (${pct}%)${im.firstChangedDate ? `, between ${esc(im.firstChangedDate)} and ${esc(im.lastChangedDate)}` : ''}.</span></div><div class="ob-meter" aria-hidden="true"><i style="width:${Math.max(pct, 2)}%"></i></div>`
    : `<div class="ob-big"><b>0</b><span>of ${im.slots} built slots would change.${im.slots ? '' : ' (No slots are built yet.)'}</span></div>`);
  const rows = Object.entries(im.byField).map(([k, v]) => {
    const [label, unit] = FIELD_LABELS[k] ?? [k, ''];
    const net = k === 'state' ? '' : unit === 'money' ? fmt.gbp(v.sum) : `${v.sum >= 0 ? '+' : '−'}${Math.abs(v.sum).toFixed(2)} kWh`;
    return `<tr><td>${esc(label)}</td><td class="r">${v.slots}</td><td class="r">${net}</td></tr>`;
  }).join('');
  if (rows) out.push(`<div class="table-wrap"><table><thead><tr><th>Figure</th><th class="r">Slots that change</th><th class="r">Net change</th></tr></thead><tbody>${rows}</tbody></table></div><p class="ob-tag">Net change adds the slots up, so ups and downs can cancel.</p>`);
  if (p.needsReason) out.push(msg('warn', 'This change starts in the past, so it rewrites slots that are already built. You will be asked for a reason on the next step.'));
  if (p.warnings?.length) out.push(msg('warn', `<ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`));
  out.push(msg('good', 'Nothing has been kept. This is a preview.'));
  const would = p.would?.length ? `<p class="ob-note"><b>After the change, ${esc(p.role)} is filled by:</b> ${p.would.map((b) => `${esc(b.source)}${b.deviceId != null ? ` (device ${b.deviceId})` : ''} ${esc(b.fromDate ?? 'from the beginning')} to ${esc(b.toDate ?? 'now')}`).join('; ')}.</p>` : '<p class="ob-note">After the change, this role has no provider.</p>';
  void f;
  return `<div class="ob-impact">${out.join('')}${would}</div>`;
}

function reasonStep() {
  const need = wz.preview?.needsReason;
  return `<label class="ob-field" style="max-width:640px"><span>Reason ${need ? '(required)' : '(optional)'}</span>
      <textarea data-f="reason" aria-required="${need ? 'true' : 'false'}" placeholder="${need ? 'For example: the inverter was replaced on this date' : 'A short note for the change history'}">${esc(wz.reason)}</textarea>
      <small>${need ? 'This change rewrites slots that are already built, so the system will not accept it without a reason.' : 'Not required: no built slot changes. A note still helps whoever reads the history.'}</small></label>`;
}

function confirmStep() {
  const f = dateFmt(model.site.timezone);
  const p = wz.preview;
  const rows = wz.mode === 'bind' ? changedRows() : [];
  const start = wz.whenKind === 'now' ? 'now' : wz.whenKind === 'beginning' ? 'the very beginning' : wz.date;
  void f;
  return `<div class="ob-summary">
      <div><b>Action</b><span>${wz.mode === 'bind' ? `Bind ${esc(wz.source)} to ${esc(wz.role)}${wz.deviceId != null ? ` on device ${wz.deviceId}` : ''}${wz.keep ? ', beside the current providers' : ''}` : `End ${esc(roleOf(wz.role)?.bindings.find((b) => b.id === wz.bindingId)?.source ?? '')} on ${esc(wz.role)}`}</span></div>
      <div><b>${wz.mode === 'bind' ? 'Starts' : 'Ends'}</b><span>${esc(start)}</span></div>
      ${wz.mode === 'bind' ? `<div><b>Mapping</b><span>${rows.length ? `${rows.length} channel row${rows.length === 1 ? '' : 's'} will be saved or replaced` : 'no mapping changes'}${wz.removed?.length ? `, ${wz.removed.length} removed` : ''}</span></div>` : ''}
      <div><b>Impact</b><span>${p ? `${p.impact.changed} of ${p.impact.slots} built slots change` : ''}</span></div>
      <div><b>Reason</b><span>${esc(wz.reason.trim() || '(none)')}</span></div>
    </div>
    <label class="ob-radio" style="margin-top:12px"><input type="checkbox" data-f="rebuild" ${wz.rebuild ? 'checked' : ''}><div><b>Rebuild the affected days now</b><span>Otherwise they are queued and rebuilt at the next sync.</span></div></label>`;
}

function doneHtml() {
  const d = wz.done;
  const rebuilt = d.rebuilt?.length ? `${d.rebuilt.reduce((t, x) => t + (x.days ?? 0), 0)} days rebuilt` : d.queued ? `queued for a rebuild from ${esc(d.queued.fromDate)}` : 'no built slot is affected';
  return `<h3 class="ob-step-title" tabindex="-1">Done</h3>${msg('good', `${wz.mode === 'bind' ? `${esc(wz.source)} now fills ${esc(wz.role)}.` : `The binding on ${esc(wz.role)} was ended.`} ${rebuilt}.`)}
    <div class="ob-foot"><a class="btn" href="/timeline?site=${ctx.siteId}">See the timeline</a><div class="right"><button class="btn btn-primary" data-w="close">Close</button></div></div>`;
}

// ── mapping rows ──
const num = (v) => (v === '' || v == null ? null : Number(v));
const rowBody = (r) => ({ source: wz.source, point: r.point.trim(), metric: r.metric, scale: num(r.scale) ?? 1, shift: num(r.shift) ?? 0, part: r.part, min: num(r.min), max: num(r.max), ...(wz.deviceId != null ? { deviceId: wz.deviceId } : {}) });
function changedRows() {
  const cur = model.channels.filter((c) => c.source === wz.source && (c.deviceId ?? null) === (wz.deviceId ?? null));
  return (wz.rows ?? []).filter((r) => r.point.trim()).filter((r) => {
    const o = cur.find((c) => c.point === r.point.trim() && c.metric === r.metric);
    return !o || o.scale !== (num(r.scale) ?? 1) || o.shift !== (num(r.shift) ?? 0) || o.part !== r.part || (o.min ?? null) !== num(r.min) || (o.max ?? null) !== num(r.max);
  });
}

async function checkMapping() {
  wz.rowErrors = {}; wz.error = null; wz.busy = true; drawWizard();
  let bad = 0;
  for (const [i, r] of wz.rows.entries()) {
    if (!r.point.trim()) continue;
    const res = await call(`/api/sites/${ctx.siteId}/channels`, { ...rowBody(r), dryRun: true });
    if (!res.ok) { wz.rowErrors[i] = res.data.error ?? 'Not accepted'; bad++; }
  }
  wz.busy = false;
  if (bad) { wz.error = `${bad} row${bad === 1 ? '' : 's'} not accepted. Fix them and continue.`; drawWizard(); return false; }
  return true;
}

// ── preview ──
let previewTimer = null;
function previewBody() {
  const unb = wz.mode === 'unbind';
  const when = wz.whenKind === 'now' ? 'now' : wz.whenKind === 'beginning' ? '' : wz.date;
  const bd = unb ? roleOf(wz.role)?.bindings.find((b) => b.id === wz.bindingId) : null;
  return {
    action: unb ? 'unbind' : 'bind', role: wz.role,
    ...(unb ? { at: when, deviceId: bd?.deviceId == null ? 'home' : bd.deviceId } : { source: wz.source, from: when, priority: wz.priority, keep: wz.keep, ...(wz.deviceId != null ? { deviceId: wz.deviceId } : {}) }),
  };
}
async function runPreview() {
  if (!wz || wz.step !== 'when') return;
  if (wz.whenKind === 'date' && !wz.date) { wz.preview = null; wz.previewErr = null; paintPreview(); return; }
  wz.loading = true; wz.previewErr = null; paintPreview();
  const res = await call(`/api/sites/${ctx.siteId}/bindings/preview`, previewBody());
  if (!wz) return;
  wz.loading = false;
  if (res.ok) { wz.preview = res.data; wz.previewErr = null; } else { wz.preview = null; wz.previewErr = res.data.error ?? `HTTP ${res.status}`; }
  paintPreview();
}
function paintPreview() {
  const el = document.getElementById('ob-preview');
  if (el) el.innerHTML = previewHtml();
  const next = document.querySelector('[data-w="next"]');
  if (next) { const need = nextBlocked(); next.disabled = !!need || wz.busy || wz.loading; if (need) next.title = need; else next.removeAttribute('title'); }
}

// ── events ──
function wireWizard() {
  const host = document.getElementById('wizard');
  host.onclick = (e) => { const b = e.target.closest('[data-w]'); if (b && !b.disabled) onWizardClick(b); };
  host.onchange = (e) => onField(e.target, true);
  host.oninput = (e) => onField(e.target, false);
  host.onkeydown = (e) => { if (e.key === 'Escape') { wz = null; drawWizard(); } };
}

function onField(el, commit) {
  const f = el.dataset.f;
  if (!f) return;
  if (el.dataset.row !== undefined) { wz.rows[Number(el.dataset.row)][f] = el.value; return; }
  if (f === 'reason') { wz.reason = el.value; paintNext(); return; }
  if (f === 'priority') { wz.priority = Number(el.value) || 0; return; }
  if (f === 'keep') { wz.keep = el.checked; return; }
  if (f === 'rebuild') { wz.rebuild = el.checked; return; }
  if (f === 'binding') { wz.bindingId = Number(el.value); paintNext(); return; }
  if (f === 'date') { wz.date = el.value; clearTimeout(previewTimer); previewTimer = setTimeout(runPreview, 300); paintNext(); return; }
  if (!commit) return;
  if (f === 'role') {
    wz.role = el.value; wz.rowsKey = null; wz.bindingId = null;
    if (wz.mode === 'bind') wz.source = suggestSource(wz.role);
    else wz.bindingId = roleOf(wz.role)?.bindings.find((b) => !b.toDate)?.id ?? null;
    drawWizard();
  } else if (f === 'source') { wz.source = el.value; wz.rowsKey = null; drawWizard(); }
  else if (f === 'device') { wz.deviceId = el.value === '' ? null : Number(el.value); wz.rowsKey = null; drawWizard(); }
  else if (f === 'whenKind') { wz.whenKind = el.value; drawWizard(); runPreview(); }
}
function paintNext() { const n = document.querySelector('[data-w="next"]'); if (n) { const need = nextBlocked(); n.disabled = !!need; if (need) n.title = need; else n.removeAttribute('title'); } }

async function onWizardClick(b) {
  const a = b.dataset.w;
  if (a === 'cancel' || a === 'close') { const was = a === 'close'; wz = null; drawWizard(); if (was) await refresh(); return; }
  if (a === 'addrow') { wz.rows.push({ id: null, point: '', metric: catalog.roles.find((r) => r.role === wz.role)?.metrics?.[0] ?? catalog.metrics[0].code, scale: 1, shift: 0, part: 'all', min: '', max: '' }); drawWizard(); return; }
  if (a === 'delrow') { const [r] = wz.rows.splice(Number(b.dataset.i), 1); if (r.id) wz.removed.push(r.id); wz.rowErrors = {}; drawWizard(); return; }
  if (a === 'back') { wz.error = null; wz.step = stepsOf()[stepIndex() - 1]; drawWizard(true); if (wz.step === 'when') runPreview(); return; }
  if (a === 'next') {
    wz.error = null;
    if (wz.step === 'map' && !(await checkMapping())) return;
    wz.step = stepsOf()[stepIndex() + 1];
    drawWizard(true);
    if (wz.step === 'when') runPreview();
    return;
  }
  if (a === 'confirm') await confirm();
}

async function confirm() {
  wz.busy = true; wz.error = null; drawWizard();
  const keepOnError = (text) => { wz.busy = false; wz.error = text; drawWizard(); };
  if (wz.mode === 'bind') {
    for (const r of changedRows()) {
      const res = await call(`/api/sites/${ctx.siteId}/channels`, rowBody(r));
      if (!res.ok) return keepOnError(`Mapping row "${r.point}": ${res.data.error ?? res.status}`);
      if (r.id && r.orig && (r.orig.point !== r.point.trim() || r.orig.metric !== r.metric)) await call(`/api/sites/${ctx.siteId}/channels/retire`, { id: r.id });
    }
    for (const id of wz.removed ?? []) await call(`/api/sites/${ctx.siteId}/channels/retire`, { id });
  }
  const body = { ...previewBody(), reason: wz.reason.trim() || null, rebuild: wz.rebuild };
  delete body.action;
  const res = await call(`/api/sites/${ctx.siteId}/${wz.mode === 'bind' ? 'bindings' : 'bindings/unbind'}`, body);
  if (!res.ok) return keepOnError(res.data.code === 'reason_required' ? 'The system needs a reason for this change. Go back one step and write one.' : res.data.error ?? `HTTP ${res.status}`);
  wz.busy = false; wz.done = res.data;
  await load();
  drawPage();
}

init({
  page: 'providers', title: 'Providers', periods: false, homeScoped: true, render,
  subtitle: 'Which provider fills each part of this home\'s timeline, how its data is translated, and what was refused. Add, change or remove a provider here: every change shows what it would do to the slots already built before anything is kept.',
});
