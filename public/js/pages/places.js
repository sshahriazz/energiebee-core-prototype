// Places: Home, then floors and rooms, then devices (plan 6.1). One tree on the left; the panel on the right shows what is selected: its timeline,
// what happened to it, what it can be asked, and where it is. Devices that have no room yet are listed to be placed (plan 6.2). Everything
// is read from the thing API by uid (GET /api/homes/:uid/graph, /api/things/:uid, .../timeline, .../events, .../controls).
import { api, esc } from '../api.js';
import { init } from '../layout.js';
import { timeChart } from '../charts.js';

let ctx = null; let graph = null; let selected = null; let detail = null; let busy = null;
const HOME_WIDE = new Set(['inverter', 'pv_array', 'battery', 'home_supply', 'grid_connection', 'hub']);
const SPACE = new Set(['floor', 'room', 'garage', 'loft', 'outdoor', 'outside_wall', 'driveway']);
const num = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const when = (ts) => new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const msg = (kind, html) => `<div class="pl-msg ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${html}</div>`;
const post = async (path, body) => await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

function find(node, uid) { if (node.uid === uid) return node; for (const c of node.children ?? []) { const f = find(c, uid); if (f) return f; } return null; }
function allNodes(node, out = []) { out.push(node); for (const c of node.children ?? []) allNodes(c, out); return out; }

function treeHtml(node) {
  const label = `${esc(node.name)} <small>${esc(node.type.replace(/_/g, ' '))}</small>`;
  const kids = (node.children ?? []).slice().sort((a, b) => (SPACE.has(a.type) === SPACE.has(b.type) ? a.name.localeCompare(b.name) : SPACE.has(a.type) ? -1 : 1));
  return `<li><button type="button" data-uid="${node.uid}" aria-current="${node.uid === selected}">${label}</button>${kids.length ? `<ul>${kids.map(treeHtml).join('')}</ul>` : ''}</li>`;
}

async function loadDetail() {
  const t = Math.floor(Date.now() / 1000);
  const q = `from=${t - 86400}&to=${t + 1800}`;
  const d = await api(`/api/things/${selected}`);
  const isDevice = d.thing.kind === 'device';
  const [timeline, events, controls] = await Promise.all([
    api(`/api/things/${selected}/timeline?${q}${isDevice ? '&lanes=actual,forecast,price' : ''}`).catch((e) => ({ error: e.message, lines: [] })),
    api(`/api/things/${selected}/events?${q}&limit=30`).catch(() => ({ events: [] })),
    isDevice ? api(`/api/things/${selected}/controls`).catch(() => null) : Promise.resolve(null),
  ]);
  detail = { ...d, timeline, events: events.events, controls };
}

function chartsHtml() {
  const lines = detail.timeline.lines ?? [];
  if (!lines.length) return `<p class="pl-note">${detail.timeline.error ? esc(detail.timeline.error) : 'No timeline for the last day: nothing has been measured here yet.'}</p>`;
  return lines.slice(0, 6).map((l, i) => `<div class="pl-chart"><h3>${esc(l.key ?? l.metric.replace(/_/g, ' '))} <small class="pl-note">${esc(l.unit ?? '')}</small></h3><div id="pl-chart-${i}"></div></div>`).join('');
}
function drawCharts() {
  const lines = detail.timeline.lines ?? [];
  lines.slice(0, 6).forEach((l, i) => {
    const host = document.getElementById(`pl-chart-${i}`);
    if (!host) return;
    const pick = (s) => (s.value != null ? s.value : s.delta != null && l.class !== 'measurement' ? s.delta : s.mean);
    const rows = l.slots.map((s) => ({ ...s, v: pick(s) })).filter((s) => s.v != null);
    const bars = l.class === 'total' || (l.slots[0]?.value != null && /kwh|_g|minor/.test(l.metric));
    timeChart(host, { rows, height: 130, unit: l.unit, label: l.key ?? l.metric, ...(bars ? { pos: [{ key: 'v', label: l.key ?? l.metric, color: 'var(--solar, #eda100)', get: (r) => r.v }] } : { lines: [{ label: l.key ?? l.metric, color: 'var(--solar, #eda100)', get: (r) => r.v, step: true }] }),
      tick: (r, k) => (new Date(r.slot_start * 1000).getMinutes() === 0 && k % 2 === 0 ? `${String(new Date(r.slot_start * 1000).getHours()).padStart(2, '0')}:00` : null),
      tip: (r) => `${when(r.slot_start)}<br>${num(r.v, 3)} ${esc(l.unit ?? '')}` });
  });
}

function controlsHtml() {
  const c = detail.controls;
  if (!c) return '';
  const caps = [...new Set(c.actions.map((a) => a.capability))];
  const open = c.requests.map((r) => `<tr><td>${esc(r.action)}</td><td>${esc(r.priority)}</td><td>until ${when(r.valid_until)}</td><td>${esc(r.source)}${r.external ? ' <span class="pl-chip">changed elsewhere</span>' : ''}</td><td>${c.winners.some((w) => w.request === r.uid) ? '<span class="pl-chip">in force</span>' : ''}</td><td><button class="btn" data-cancel="${r.uid}" type="button">Cancel</button></td></tr>`).join('');
  return `<h3>Controls</h3>${caps.length ? '' : '<p class="pl-note">Nothing can be asked of this device.</p>'}
    <div class="pl-actions">${c.actions.map((a) => `<span>${a.action === 'set_target_temp' ? '<input type="number" step="0.5" data-param="setpointC" value="20" aria-label="Target temperature">' : ''}<button class="btn" type="button" data-ask="${esc(a.capability)}|${esc(a.action)}" ${a.confirmed ? '' : 'disabled title="This device has not been confirmed to take this action"'}>${esc(a.action.replace(/_/g, ' '))}</button></span>`).join('')}</div>
    <p class="pl-note">A request here is manual: it lasts an hour, beats any schedule or the optimiser, and can be cancelled. Nothing is sent until the device's driver is connected.</p>
    ${open ? `<table class="pl-table"><thead><tr><th>Asked</th><th>Priority</th><th>Until</th><th>By</th><th></th><th></th></tr></thead><tbody>${open}</tbody></table>` : ''}`;
}

function eventsHtml() {
  const ev = detail.events ?? [];
  return `<h3>What happened (last day)</h3>${ev.length ? `<table class="pl-table"><tbody>${ev.slice().reverse().map((e) => `<tr><td>${when(e.ts)}</td><td>${esc(e.thing?.name ?? '')}</td><td>${esc(e.what.replace(/_/g, ' '))}${e.detail?.from !== undefined ? ` ${esc(e.detail.from)} → ${esc(e.detail.to)}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="pl-note">Nothing was recorded.</p>'}`;
}

function crumbHtml() {
  const chain = (detail.place ?? []).slice().reverse();
  return `<div class="pl-crumb">${chain.map((p) => `<button type="button" data-uid="${p.uid}">${esc(p.name)}</button>`).join(' › ')}</div>`;
}

function relationsHtml() {
  const rel = detail.relations;
  const row = (r, dir) => `<tr><td>${dir}</td><td>${esc(r.rel.replace(/_/g, ' '))}</td><td><button type="button" class="pl-link" data-uid="${dir === 'to' ? r.to.uid : r.from.uid}">${esc(dir === 'to' ? r.to.name : r.from.name)}</button> ${esc(dir === 'to' ? r.to.port ?? '' : r.from.port ?? '')}</td></tr>`;
  const rows = [...rel.out.filter((r) => r.rel !== 'located_in').map((r) => row(r, 'to')), ...rel.in.filter((r) => r.rel !== 'located_in').map((r) => row(r, 'from'))];
  return rows.length ? `<h3>Connected to</h3><table class="pl-table"><tbody>${rows.join('')}</tbody></table>` : '';
}

function unplacedHtml() {
  const nodes = allNodes(graph.spatial);
  const rooms = nodes.filter((n) => SPACE.has(n.type) && n.type !== 'outside_wall' && n.type !== 'driveway' || n.type === 'driveway');
  const loose = (graph.spatial.children ?? []).filter((n) => !SPACE.has(n.type) && !HOME_WIDE.has(n.type) && n.kind === 'device');
  if (!loose.length) return '';
  return `<h3>Devices without a room</h3><p class="pl-note">The core found these and has not been told where they are. Placing a device is optional and can be changed later.</p>
    ${loose.map((d) => `<div class="pl-place"><b>${esc(d.name)}</b> <small class="pl-note">${esc(d.type.replace(/_/g, ' '))}</small>
      <select data-place="${d.uid}" aria-label="Room of ${esc(d.name)}"><option value="">Choose a room…</option>${rooms.map((r) => `<option value="${r.uid}">${esc(r.name)}</option>`).join('')}</select>
      <button class="btn" type="button" data-move="${d.uid}">Place</button></div>`).join('')}
    <div class="pl-place"><input id="pl-new-room" type="text" maxlength="60" placeholder="A new room, such as Kitchen" aria-label="New room name"><button class="btn" type="button" id="pl-add-room">Add room</button></div>`;
}

function panelHtml() {
  const t = detail.thing;
  const systems = (detail.systems ?? []).map((s) => `<span class="pl-chip">${esc(s.name)}</span>`).join(' ');
  return `${crumbHtml()}<h2>${esc(t.name)} <small class="pl-note">${esc(t.type.replace(/_/g, ' '))}</small></h2>
    ${systems ? `<p>${systems}</p>` : ''}${busy ? msg(busy.bad ? 'bad' : '', busy.text) : ''}
    ${chartsHtml()}${controlsHtml()}${eventsHtml()}${relationsHtml()}${t.uid === graph.home.uid ? unplacedHtml() : ''}`;
}

function draw() {
  const systems = graph.systems.map((s) => `<li><button type="button" data-uid="${s.uid}" aria-current="${s.uid === selected}">${esc(s.name)} <small>system, ${s.members.length} parts</small></button></li>`).join('');
  document.getElementById('content').innerHTML = `<div class="pl"><nav class="pl-tree" aria-label="Places"><ul>${treeHtml(graph.spatial)}</ul>${systems ? `<h3>Systems</h3><ul>${systems}</ul>` : ''}</nav>
    <section class="pl-panel" aria-live="polite">${detail ? panelHtml() : '<div class="skeleton">Loading…</div>'}</section></div>`;
  if (detail) drawCharts();
  wire();
}

async function select(uid) {
  selected = uid; busy = null; detail = null;
  history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), thing: uid })}`);
  draw();
  await loadDetail();
  draw();
}

async function act(fn, ok) {
  try { const r = await fn(); busy = { text: ok(r) }; } catch (e) { busy = { text: esc(e.message), bad: true }; }
  graph = await api(`/api/homes/${ctx.site.uid}/graph`);
  await loadDetail();
  draw();
}

function wire() {
  const root = document.getElementById('content');
  root.querySelectorAll('[data-uid]').forEach((b) => b.addEventListener('click', () => select(b.dataset.uid)));
  root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => {
    const [capability, action] = b.dataset.ask.split('|');
    const desired = {};
    b.parentElement.querySelectorAll('input[data-param]').forEach((i) => { desired[i.dataset.param] = Number(i.value); });
    act(() => post(`/api/things/${selected}/requests`, { capability, action, desired, forS: 3600 }), (r) => `Asked: ${esc(action.replace(/_/g, ' '))}. ${r.written ? 'A command is queued.' : r.reason ? `No command: ${esc(r.reason.replace(/_/g, ' '))}.` : ''}`);
  }));
  root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => act(() => post(`/api/requests/${b.dataset.cancel}/cancel`), () => 'The request was cancelled.')));
  root.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const to = root.querySelector(`select[data-place="${b.dataset.move}"]`)?.value;
    if (!to) { busy = { text: 'Choose a room first.', bad: true }; draw(); return; }
    act(() => post(`/api/things/${b.dataset.move}/move`, { to }), () => 'Placed.');
  }));
  root.querySelector('#pl-add-room')?.addEventListener('click', () => {
    const name = root.querySelector('#pl-new-room').value.trim();
    if (!name) { busy = { text: 'Give the room a name.', bad: true }; draw(); return; }
    act(() => post(`/api/homes/${ctx.site.uid}/things`, { type: 'room', name }), () => `Room "${esc(name)}" added.`);
  });
}

async function render(state) {
  ctx = state; detail = null; busy = null;
  const el = document.getElementById('content');
  if (!ctx.site?.uid) { el.innerHTML = '<div class="skeleton">Choose a home.</div>'; return; }
  el.innerHTML = '<div class="skeleton">Loading the places of this home…</div>';
  graph = await api(`/api/homes/${ctx.site.uid}/graph`);
  const want = new URLSearchParams(location.search).get('thing');
  selected = want && (find(graph.spatial, want) || graph.systems.some((s) => s.uid === want)) ? want : graph.home.uid;
  draw();
  await loadDetail();
  draw();
}

init({ page: 'places', title: 'Places', periods: false, homeScoped: true, render,
  subtitle: 'The home, its floors and rooms, and every device in them: what each has measured, what happened to it, what it can be asked to do.' });
