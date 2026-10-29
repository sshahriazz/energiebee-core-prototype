// Devices: every device of a home with its status and data, and for a SYNTHETIC demo device a way to watch the architecture work:
// simulate the next period (what the pipeline did with each reading) and send a test command (the path to a confirmed, verified change).
// Reads GET /api/sites/:id/devices and .../devices/:deviceId; writes only through the simulate and commands routes, which the server
// accepts for synthetic devices only.
import { esc } from '../api.js';
import { init } from '../layout.js';
import * as V from '../devices-view.js';

let ctx = null;          // the page shell's state (the selected home)
let list = [];           // GET /api/sites/:id/devices
let demo = { exists: false };
let detail = null;       // GET /api/sites/:id/devices/:deviceId
let selected = null;     // device id (a number, or 'site')
let hours = 36;
let sim = null;          // the last simulate result
let cmd = null;          // the last command result
let asking = false;      // the create-demo confirmation is open
let push = { connect: null, pushes: [], error: null };   // GET /api/sites/:id/pushes: how to connect, and the log of what arrived
let pollTimer = null;

const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const msg = (kind, html) => `<div class="ob-msg ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}"><div>${html}</div></div>`;
async function call(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ───────────── Loading ─────────────
async function loadPush() {
  const r = await call(`/api/sites/${ctx.siteId}/pushes?limit=20`);
  push = r.ok ? { connect: r.data.connect, pushes: r.data.pushes, error: null } : { connect: push.connect, pushes: push.pushes, error: r.data.error ?? `HTTP ${r.status}` };
}
async function loadList() {
  const [l, d] = await Promise.all([call(`/api/sites/${ctx.siteId}/devices`), call('/api/demo/iot'), loadPush()]);
  if (!l.ok) throw new Error(l.data.error ?? `HTTP ${l.status}`);
  list = l.data; demo = d.ok ? d.data : { exists: false };
}
async function loadDetail() {
  if (selected == null) { detail = null; return; }
  const r = await call(`/api/sites/${ctx.siteId}/devices/${selected}?hours=${hours}`);
  if (!r.ok) { detail = { error: r.data.error ?? `HTTP ${r.status}` }; return; }
  detail = r.data;
}
function pickInitial() {
  const want = new URLSearchParams(location.search).get('device');
  const ids = list.map((d) => String(d.id));
  if (want && ids.includes(want)) selected = want === 'site' ? 'site' : Number(want);
  else if (selected == null || !ids.includes(String(selected))) selected = list.find((d) => d.synthetic)?.id ?? list[0]?.id ?? null;
}

// ───────────── The page ─────────────
function demoCard() {
  if (ctx.site?.is_demo) return '';
  if (demo.exists) {
    return `<section class="card dv-demo"><div class="card-head"><div><h2>See the IoT side</h2><p>This database has a synthetic demo home with a smart plug, a heat pump, an EV charger, a battery and a temperature sensor, all generated.</p></div>
      <button class="btn btn-primary" id="dv-open-demo">Open the synthetic demo home</button></div></section>`;
  }
  return `<section class="card dv-demo"><div class="card-head"><div><h2>See the IoT side</h2><p>Your real home has meters and a car but no smart plug, heat pump or charger. To watch counters, events, roles and control work, you can add a <b>synthetic demo home</b>: five generated devices with three days of data.</p></div>
    ${asking ? '' : '<button class="btn btn-primary" id="dv-create">Create the synthetic demo home</button>'}</div>
    ${asking ? `<div class="ob-msg warn" role="alertdialog" aria-labelledby="dv-confirm-t"><div><b id="dv-confirm-t">Add a demo home to this database?</b> This creates a separate home called "Synthetic IoT home (demo data)" with generated devices and readings, labelled synthetic everywhere. It does not change your real home or its data. You can tell it apart in the home list by "(demo, synthetic)".
      <div class="dv-confirm"><button class="btn btn-primary" id="dv-confirm">Yes, add the demo home</button><button class="btn" id="dv-cancel">Cancel</button></div></div></div>` : ''}
    <div id="dv-demo-msg"></div></section>`;
}

function drawPage() {
  const content = document.getElementById('content');
  V.setChartWidth((content.clientWidth || 820) - 44);   // the card's padding and border
  drawnWidth = content.clientWidth;
  const tz = ctx.site?.timezone ?? 'Europe/London';
  const isSynth = !!ctx.site?.is_demo && list.some((d) => d.synthetic);
  const unsyn = list.filter((d) => !d.synthetic).length;
  content.innerHTML = `
    ${V.explainerHtml()}
    ${isSynth ? V.bannerHtml() : ''}
    ${demoCard()}
    <div class="ob-top"><span class="muted">${list.length} device${list.length === 1 ? '' : 's'} in <b>${esc(ctx.site?.name ?? 'this home')}</b>${isSynth ? ' (synthetic)' : unsyn ? ' (real)' : ''}.</span><span class="spacer"></span><button class="btn" id="dv-reload">↻ Refresh</button></div>
    ${list.length ? `<div class="dv-grid" role="list">${list.map((d) => `<div role="listitem">${V.cardHtml(d, tz, String(d.id) === String(selected))}</div>`).join('')}</div>` : '<section class="card empty"><h2>No devices in this home</h2><p>The home has no devices yet. Create the synthetic demo home above to see how devices look.</p></section>'}
    ${connectCard(tz)}
    <div id="dv-detail">${detailHtml(tz)}</div>`;
  wire();
}

// ───────────── Connect a real device, and the log of pushes ─────────────
function connectCard(tz) {
  if (push.error && !push.connect) return `<section class="card dv-connect">${msg('bad', `How to connect a device could not be loaded: ${esc(push.error)}`)}</section>`;
  if (!push.connect) return '<section class="card dv-connect"><div class="skeleton">Loading how to connect a device…</div></section>';
  // the example names the selected device only when it is one that pushes (registered through the endpoint): a meter or an inverter is read by the core, not pushed
  const dev = detail && !detail.error && detail.device && selected !== 'site' && detail.device.provider === 'push' ? detail.device : null;
  const points = dev ? [...new Set((detail.channels ?? []).filter((c) => c.point && c.access === 'read').map((c) => c.point))] : [];
  return `<section class="card dv-connect" id="dv-connect" aria-labelledby="dv-connect-t">
    <div class="card-head"><div><h2 id="dv-connect-t">Connect a real device</h2><p>Plugs, heat pumps, chargers, sensors and gateways can push their readings to this core. They are read exactly like every other provider.</p></div>
      <button class="btn" id="dv-push-reload" type="button">↻ Refresh log</button></div>
    <div id="dv-push-msg" aria-live="polite">${push.error ? msg('bad', `The push log could not be refreshed: ${esc(push.error)}`) : ''}</div>
    <div class="dv-connect-grid">
      <div>${V.connectHtml({ connect: push.connect, origin: location.origin, siteId: ctx.siteId, device: dev, points })}</div>
      <div><h3 class="dv-h3 first">Pushes received</h3><div id="dv-pushlog" aria-live="polite">${V.pushLogHtml(push.pushes, tz)}</div></div>
    </div></section>`;
}

function detailHtml(tz) {
  if (selected == null) return '';
  if (!detail) return '<div class="skeleton">Loading the device…</div>';
  if (detail.error) return `<section class="card">${msg('bad', `The device could not be loaded: ${esc(detail.error)}`)}</section>`;
  const d = detail; const f = V.clock(tz);
  const st = d.status;
  return `<section class="card dv-detail" aria-labelledby="dv-title">
    <div class="card-head"><div><h2 id="dv-title" tabindex="-1">${esc(d.device.label)}</h2>
      <p><span class="dv-status ${esc(st.status)}"><i aria-hidden="true"></i>${esc(st.words)}${d.newestTs ? `, last data ${esc(V.ageWords(st.ageS))}` : ''}</span>
      ${d.roles.length ? ` · fills: ${d.roles.map((r) => esc(V.roleWord(r.role))).join(', ')}` : ' · fills no role'}</p></div>
      <div class="segmented" role="group" aria-label="How much history">${[[12, '12 h'], [36, '36 h'], [72, '3 days']].map(([h, l]) => `<button data-hours="${h}" aria-pressed="${h === hours}">${l}</button>`).join('')}</div></div>
    ${d.synthetic ? V.syntheticLine() : d.emulated ? V.emulatedLine() : ''}
    ${d.synthetic ? actionPanels(d, tz) : realNote(d)}
    ${d.pushes?.length ? `<h3 class="dv-h3">Recent pushes from this device</h3>${V.pushLogHtml(d.pushes, tz)}` : ''}
    <h3 class="dv-h3">What the device sent</h3>
    ${V.chartsHtml(d, tz)}
    <h3 class="dv-h3">What happened in this window, in words</h3>
    ${V.explanationsHtml(d, tz)}
    <h3 class="dv-h3">Its channels</h3>
    <p class="ob-note">One row per point the device sends. A channel turns a point into a standard measurement; a counter also gets the energy of each period derived from it.</p>
    ${V.channelsTable(d, tz)}
    <h3 class="dv-h3">Refused readings</h3>
    ${V.rejectsPanel(d, tz)}
  </section>`;
}

function realNote(d) {
  if (d.emulated) return `<div class="ob-msg" role="note"><div>Nothing on this page can simulate more data for it or send it a command. To send more readings run <span class="mono">npm run demo:push -- --site ${esc(ctx.siteId)} --device ${esc(d.device.ref ?? 'emu-plug-1')}</span>.</div></div>`;
  return `<div class="ob-msg" role="note"><div>This is a real device of this home. This page only shows what it sent: nothing here can simulate data or send it a command.</div></div>`;
}

function actionPanels(d) {
  const controls = d.controllable;
  return `<div class="dv-actions ${controls ? '' : 'single'}">
    <section class="dv-panel" aria-labelledby="dv-act-t"><h3 id="dv-act-t">Data in action</h3>
      <p class="ob-note">Press the button and the demo home moves forward in time, one five-minute period each. The readings go through the same steps a real device's would. The demo history stops half an hour before now, so the devices show "no new data" until you catch up.</p>
      <div class="ob-actions"><button class="btn btn-primary" id="dv-sim1">Simulate next period</button><button class="btn" id="dv-sim12">Catch up to now</button></div>
      </section>
    ${controls ? `<section class="dv-panel" aria-labelledby="dv-ctl-t"><h3 id="dv-ctl-t">Control</h3>
      <p class="ob-note">Send the battery a test command: charge to a target level. It is queued, sent, then read back from the device. Only when the device reports the new setting is the command confirmed, and later its effect is checked in the readings.</p>
      ${V.settingsHtml(d)}
      <div class="ob-actions" style="margin-top:10px"><button class="btn btn-primary" id="dv-cmd">Send test command</button><span class="ob-note" style="margin:0">Alternates the target between 80 % and 90 %.</span></div>
      <div id="dv-cmd-out" aria-live="polite">${V.commandPathHtml(cmd)}</div>
      <h4 class="dv-h4">Command history</h4>${V.commandsTable(d, ctx.site?.timezone ?? 'Europe/London')}</section>` : ''}
  </div>
  <div id="dv-sim-out" class="dv-simout" aria-live="polite">${V.pipelineHtml(sim, ctx.site?.timezone ?? 'Europe/London')}</div>`;
}

// ───────────── Events ─────────────
function wire() {
  const $ = (id) => document.getElementById(id);
  $('dv-reload')?.addEventListener('click', refresh);
  $('dv-create')?.addEventListener('click', () => { asking = true; drawPage(); $('dv-confirm')?.focus(); });
  $('dv-cancel')?.addEventListener('click', () => { asking = false; drawPage(); });
  $('dv-confirm')?.addEventListener('click', createDemo);
  $('dv-open-demo')?.addEventListener('click', () => go(demo.siteId));
  document.querySelectorAll('.dv-card').forEach((b) => b.addEventListener('click', () => select(b.dataset.device)));
  document.querySelectorAll('[data-hours]').forEach((b) => b.addEventListener('click', async () => { hours = Number(b.dataset.hours); await loadDetail(); drawPage(); }));
  $('dv-sim1')?.addEventListener('click', () => simulate(1));
  $('dv-sim12')?.addEventListener('click', () => simulate(12));
  $('dv-cmd')?.addEventListener('click', sendCommand);
  $('dv-push-reload')?.addEventListener('click', reloadLog);
  $('dv-copy')?.addEventListener('click', copyCurl);
}

async function reloadLog() {
  await loadPush();
  const tz = ctx.site?.timezone ?? 'Europe/London';
  const el = document.getElementById('dv-pushlog');
  if (el) el.innerHTML = V.pushLogHtml(push.pushes, tz);
  const m = document.getElementById('dv-push-msg');
  if (m) m.innerHTML = push.error ? msg('bad', `The push log could not be refreshed: ${esc(push.error)}. The rows below are the last ones that loaded.`) : '';
}

async function copyCurl() {
  const text = document.getElementById('dv-curl')?.textContent ?? '';
  const out = document.getElementById('dv-copied');
  try { await navigator.clipboard.writeText(text); if (out) out.textContent = 'Copied'; }
  catch {
    const range = document.createRange(); range.selectNodeContents(document.getElementById('dv-curl'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    if (out) out.textContent = 'Selected: press Ctrl+C or ⌘C to copy';
  }
}

// While the page is open the log follows the pushes: every few seconds it asks for the newest rows, and when a new push has arrived the devices
// and the open device are read again too, so a device that starts pushing appears and its charts move. Paused when the tab is hidden.
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden || !ctx) return;
    const newest = push.pushes[0]?.id ?? 0;
    try {
      await loadPush();
      if ((push.pushes[0]?.id ?? 0) !== newest) { await loadList(); pickInitial(); await loadDetail(); drawPage(); } else await reloadLog();
    } catch { /* the next tick tries again */ }
  }, 5000);
}

function go(siteId) {
  try { localStorage.setItem('eb.site', String(siteId)); } catch { /* private mode */ }
  location.href = `/devices?site=${siteId}`;
}

async function createDemo() {
  const btn = document.getElementById('dv-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  const r = await call('/api/demo/iot', {});
  if (!r.ok) { asking = false; drawPage(); document.getElementById('dv-demo-msg').innerHTML = msg('bad', esc(r.data.error ?? 'The demo home could not be created')); return; }
  go(r.data.siteId);
}

async function select(id) {
  selected = id === 'site' ? 'site' : Number(id);
  sim = null; cmd = null; detail = null;
  history.replaceState(null, '', `?site=${ctx.siteId}&device=${id}`);
  drawPage();
  await loadDetail();
  drawPage();
  document.getElementById('dv-title')?.focus({ preventScroll: true });
  document.getElementById('dv-detail')?.scrollIntoView({ block: 'start', behavior: reduce() ? 'auto' : 'smooth' });
}

async function refresh() {
  try { await loadList(); pickInitial(); await loadDetail(); drawPage(); }
  catch (err) { document.getElementById('content').innerHTML = `<div class="card empty"><h2>Devices could not be loaded</h2><p>${esc(err.message)}</p></div>`; }
}

// Reveal the stages of a result one after the other, so the steps can be followed; at once for people who ask for less motion.
function reveal(rootSel, itemSel) {
  const items = [...document.querySelectorAll(`${rootSel} ${itemSel}`)];
  if (reduce()) return;
  items.forEach((el) => el.classList.add('hide'));
  items.forEach((el, i) => setTimeout(() => el.classList.remove('hide'), 260 * (i + 1)));
}

async function simulate(periods) {
  const btns = [document.getElementById('dv-sim1'), document.getElementById('dv-sim12')];
  btns.forEach((b) => { if (b) b.disabled = true; });
  const out = document.getElementById('dv-sim-out');
  out.innerHTML = '<div class="ob-loading">Running the periods through the pipeline…</div>';
  const r = await call(`/api/sites/${ctx.siteId}/devices/${selected}/simulate`, { periods });
  if (!r.ok) { sim = null; out.innerHTML = msg('bad', esc(r.data.error ?? 'The simulation failed')); btns.forEach((b) => { if (b) b.disabled = false; }); return; }
  sim = r.data;
  await loadList(); await loadDetail();
  drawPage();
  reveal('#dv-sim-out .dv-pipe .dv-pipe-row:first-child', '.dv-st');
  document.getElementById('dv-sim-out')?.scrollIntoView({ block: 'nearest', behavior: reduce() ? 'auto' : 'smooth' });
}

async function sendCommand() {
  const b = document.getElementById('dv-cmd'); b.disabled = true;
  const out = document.getElementById('dv-cmd-out');
  out.innerHTML = '<div class="ob-loading">Queuing, sending and reading back…</div>';
  const r = await call(`/api/sites/${ctx.siteId}/devices/${selected}/commands`, {});
  if (!r.ok) { cmd = null; out.innerHTML = msg('bad', esc(r.data.error ?? 'The command failed')); b.disabled = false; return; }
  cmd = r.data;
  await loadList(); await loadDetail();
  drawPage();
  reveal('#dv-cmd-out .dv-path', 'li');
}

let resizeTimer = null; let drawnWidth = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const w = document.getElementById('content')?.clientWidth ?? 0; if (list.length && Math.abs(w - drawnWidth) > 30) { drawnWidth = w; drawPage(); } }, 200);
});

async function render(state) {
  ctx = state;
  document.getElementById('content').innerHTML = '<div class="skeleton">Loading the devices of this home…</div>';
  list = []; detail = null; sim = null; cmd = null; asking = false; push = { connect: null, pushes: [], error: null };
  await refresh();
  startPolling();
}

init({
  page: 'devices', title: 'Devices', periods: false, homeScoped: true, render,
  subtitle: 'Every device of this home, what it sent and how the core read it. For a synthetic demo home you can also move time forward and send a test command to watch the new device architecture work.',
});
