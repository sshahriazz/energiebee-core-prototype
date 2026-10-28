// Providers screen: the pieces that turn the onboarding read model (GET /api/sites/:id/onboarding) into HTML.
// Pure functions of the model: no fetching here, no state. providers.js owns the page and the flow.
import { esc } from './api.js';

export const PART_WORDS = {
  all: 'As reported',
  positive: 'Positive part only',
  negative: 'Negative part, as positive',
  abs: 'Size, ignoring sign',
};
export const REASON_WORDS = {
  out_of_range: 'outside the allowed range',
  not_a_number: 'not a number',
  unmapped_point: 'a point nobody mapped',
};
const COLORS = ['', 'c1', 'c2', 'c3', 'c4'];

export const dateFmt = (tz) => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { date: (ts) => (ts == null ? '' : f.format(ts * 1000)), dateTime: (ts) => (ts == null ? '' : t.format(ts)), dt: (ms) => (ms == null ? '' : t.format(ms)) };
};

// ───────────── Explainer ─────────────
export function explainerHtml() {
  return `<div class="ob-explain">
    <div><b>Role</b>What the slot timeline needs, such as "the inverter's 5-minute readings" or "the smart meter". The timeline asks for a role, never for a named provider.</div>
    <div><b>Binding</b>Which provider fills a role for this home, and from when. Changing it takes effect from a date you choose; slots before that date stay as they were.</div>
    <div><b>Channel</b>How one point a provider sends (for example <span class="mono">grid_kw</span>) becomes a standard measurement, with its unit, sign and allowed range.</div>
  </div>`;
}

// ───────────── Timeline of one role ─────────────
function axisOf(bindings, now) {
  const stamps = [];
  for (const b of bindings) { if (b.from != null) stamps.push(b.from); if (b.to != null) stamps.push(b.to); if (b.data?.first != null) stamps.push(b.data.first); }
  let start = stamps.length ? Math.min(...stamps) : now - 30 * 86400;
  let end = Math.max(now, ...stamps);
  if (end - start < 7 * 86400) start = end - 7 * 86400;
  const pad = (end - start) * 0.02;
  return { start: start - pad, end: end + pad, now };
}

// Lanes: bindings that overlap in time go on separate rows (two devices at once).
function lanesOf(bindings, now) {
  const lanes = [];
  const sorted = [...bindings].sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity) || a.id - b.id);
  for (const b of sorted) {
    const s = b.from ?? -Infinity; const e = b.to ?? Infinity;
    const lane = lanes.find((l) => l.every((x) => (x.to ?? Infinity) <= s || (x.from ?? -Infinity) >= e));
    if (lane) lane.push(b); else lanes.push([b]);
  }
  return lanes;
}

// The stretches between the axis start and now that no binding covers.
function gapsOf(bindings, axis) {
  const iv = bindings.map((b) => [Math.max(b.from ?? axis.start, axis.start), Math.min(b.to ?? axis.now, axis.now)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const gaps = []; let cursor = axis.start;
  for (const [a, b] of iv) { if (a > cursor + 3600) gaps.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (axis.now > cursor + 3600) gaps.push([cursor, axis.now]);
  return gaps;
}

export function timelineHtml(role, tz, now, sourceColors) {
  const f = dateFmt(tz);
  const bs = role.bindings;
  if (!bs.length) return `<div class="ob-track"><div class="ob-empty-track">No provider fills this role. Slots show this input as missing. Use "Add a provider" to bind one.</div></div>`;
  const axis = axisOf(bs, now);
  const span = axis.end - axis.start;
  const pct = (t) => Math.min(100, Math.max(0, ((t - axis.start) / span) * 100));
  const lanes = lanesOf(bs, now);
  const bars = lanes.map((lane) => `<div class="ob-lane">${lane.map((b) => {
    const left = b.from == null ? 0 : pct(b.from);
    const right = b.to == null ? pct(Math.max(now, b.from ?? now)) : pct(b.to);
    const width = Math.max(right - left, 1.2);
    const cls = `ob-bar ${COLORS[sourceColors.get(b.source) % COLORS.length]} ${b.from == null ? 'open-left' : ''} ${b.to == null ? 'open-right' : ''}`;
    const when = `${b.fromDate ?? 'the beginning'} to ${b.toDate ?? 'now'}`;
    const dev = b.deviceId != null ? ` (device ${b.deviceId})` : '';
    return `<div class="${cls}" style="left:${left}%;width:${width}%" title="${esc(`${b.source}${dev}: ${when}`)}">${esc(b.source)}${esc(dev)}</div>`;
  }).join('')}</div>`).join('');
  const gaps = gapsOf(bs, axis);
  const gapText = gaps.length ? `<p class="ob-gap">No provider from ${gaps.map(([a, b]) => `${f.date(a)} to ${f.date(b)}`).join(' and ')}: slots in that time show this input as missing.</p>` : '';
  return `<div class="ob-tl" role="img" aria-label="${esc(`${role.label}: ${bs.map((b) => `${b.source} from ${b.fromDate ?? 'the beginning'} to ${b.toDate ?? 'now'}`).join('; ')}`)}">
    <div class="ob-track">${bars}<div class="ob-now" style="left:${pct(now)}%" title="Now"></div></div>
    <div class="ob-axis"><span>${esc(f.date(axis.start))}</span><span>now</span></div>
  </div>${gapText}`;
}

// ───────────── Bindings table of one role ─────────────
export function bindingsTable(role, tz) {
  const f = dateFmt(tz);
  if (!role.bindings.length) return '';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Provider</th><th>Device</th><th>From</th><th>Until</th><th class="r">Priority</th><th>Data held</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${role.bindings.map((b) => `<tr>
      <td><b>${esc(b.source)}</b><div class="ob-tag">${esc(b.sourceName ?? '')}</div></td>
      <td>${b.deviceId != null ? `device ${b.deviceId}` : '<span class="faint">the home itself</span>'}</td>
      <td>${esc(b.fromDate ?? 'the beginning')}</td>
      <td>${b.toDate ? esc(b.toDate) : '<span class="badge good">open</span>'}</td>
      <td class="r">${b.priority}</td>
      <td>${b.data?.first != null ? `${esc(f.date(b.data.first))} to ${esc(f.date(b.data.last))}` : '<span class="faint">none yet</span>'}</td>
      <td><div class="ob-actions">
        <button class="btn btn-sm" data-act="map" data-role="${esc(role.role)}" data-source="${esc(b.source)}" data-device="${b.deviceId ?? ''}">Edit mapping</button>
        ${b.toDate ? '' : `<button class="btn btn-sm" data-act="end" data-role="${esc(role.role)}" data-binding="${b.id}">End</button>`}
      </div></td></tr>`).join('')}</tbody></table></div>`;
}

// ───────────── Channels of the sources bound to a role ─────────────
export function channelsBlock(role, model) {
  const sources = [...new Set(role.bindings.map((b) => b.source))];
  if (!sources.length) return '';
  return sources.map((src) => {
    const rows = model.channels.filter((c) => c.source === src);
    const def = role.bindings.find((b) => b.source === src)?.defaultChannels ?? [];
    const table = rows.length
      ? `<div class="table-wrap"><table class="ob-ch"><thead><tr><th>Point it sends</th><th>Becomes</th><th class="r">Times</th><th class="r">Plus</th><th>Sign</th><th>Allowed range</th><th>Device</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td class="mono">${esc(c.point)}</td><td><span class="mono">${esc(c.metric)}</span> <span class="ob-tag">${esc(c.unit ?? '')}</span></td>
          <td class="r">${c.scale}</td><td class="r">${c.shift}</td><td>${esc(PART_WORDS[c.part] ?? c.part)}</td>
          <td>${c.min == null && c.max == null ? '<span class="faint">any</span>' : `${c.min ?? '−∞'} to ${c.max ?? '∞'}`}</td>
          <td>${c.deviceId != null ? `device ${c.deviceId}` : '<span class="faint">home</span>'}</td>
          <td><button class="btn btn-sm" data-act="retire" data-channel="${c.id}" aria-label="Stop using the channel for ${esc(c.point)}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
      : (def.length
        ? `<p class="ob-note">No channel rows yet. The provider's built-in mapping below is created the first time it delivers data.</p>
          <div class="table-wrap"><table><thead><tr><th>Point it sends</th><th>Becomes</th><th class="r">Times</th><th>Sign</th></tr></thead><tbody>${def.map((d) => `<tr><td class="mono">${esc(d.point)}</td><td class="mono">${esc(d.metric)}</td><td class="r">${d.scale}</td><td>${esc(PART_WORDS[d.part] ?? d.part)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="ob-note">No mapping yet: nothing this provider sends can be used until its points are mapped. Use "Edit mapping".</p>');
    return `<details class="ob-details"><summary>How ${esc(src)}'s data is translated (${rows.length ? `${rows.length} channel${rows.length === 1 ? '' : 's'}` : def.length ? 'built-in mapping' : 'not mapped'})</summary>${table}</details>`;
  }).join('');
}

export function roleCard(role, model, tz, sourceColors) {
  return `<section class="card" aria-labelledby="role-${esc(role.role)}">
    <div class="card-head">
      <div><div class="ob-role-title"><h2 id="role-${esc(role.role)}">${esc(role.label)}</h2>${role.label !== role.role ? `<code>${esc(role.role)}</code>` : ''}</div>${role.help ? `<p>${esc(role.help)}</p>` : ''}</div>
      <div class="ob-actions"><button class="btn btn-sm" data-act="add" data-role="${esc(role.role)}">${role.bindings.length ? 'Change provider' : 'Add a provider'}</button></div>
    </div>
    ${timelineHtml(role, tz, model.now, sourceColors)}
    ${bindingsTable(role, tz)}
    ${channelsBlock(role, model)}
  </section>`;
}

// ───────────── Rejected values ─────────────
export function rejectsCard(model, tz) {
  const f = dateFmt(tz);
  const r = model.rejects;
  if (!r.total) return `<section class="card"><div class="card-head"><div><h2>Rejected values</h2><p>Values a provider sent that the channels refused, last ${r.days} days.</p></div></div>
    <p class="ob-note">Nothing was rejected. A value outside its allowed range, or not a number, is kept here and never stored as data.</p></section>`;
  const kpis = Object.entries(r.byReason).map(([k, n]) => `<span class="badge ${k === 'unmapped_point' ? 'warn' : 'bad'}">${n} ${esc(REASON_WORDS[k] ?? k)}</span>`).join('');
  const rows = r.byPoint.map((x) => `<tr><td>${esc(x.source)}</td><td class="mono">${esc(x.point)}</td><td>${esc(REASON_WORDS[x.reason] ?? x.reason)}</td><td class="r">${x.count}</td>
    <td>${x.minValue != null ? `${x.minValue}${x.maxValue !== x.minValue ? ` to ${x.maxValue}` : ''}` : ''}</td><td>${esc(f.dt(x.lastAt))}</td>
    <td>${x.reason === 'unmapped_point' ? `<button class="btn btn-sm" data-act="mappoint" data-source="${esc(x.source)}" data-point="${esc(x.point)}">Map this point</button>` : ''}</td></tr>`).join('');
  return `<section class="card"><div class="card-head"><div><h2>Rejected values</h2><p>Values a provider sent that the channels refused, last ${r.days} days. Nothing here was stored as data.</p></div></div>
    <div class="ob-kpis">${kpis}</div>
    <div class="table-wrap"><table><thead><tr><th>Provider</th><th>Point</th><th>Why</th><th class="r">Times</th><th>Values</th><th>Last seen</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ───────────── History of changes ─────────────
export function historyCard(model, tz) {
  const f = dateFmt(tz);
  const rows = model.history.slice(0, 15);
  if (!rows.length) return '';
  return `<section class="card"><div class="card-head"><div><h2>Change history</h2><p>Every binding ever recorded for this home, newest first. Nothing is deleted: a change ends the old row and adds a new one.</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Recorded</th><th>Role</th><th>Provider</th><th>Applies</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows.map((b) => `<tr>
      <td>${b.recordedAt ? esc(f.dt(b.recordedAt)) : '<span class="faint">at setup</span>'}</td><td class="mono">${esc(b.role)}</td><td>${esc(b.source)}${b.deviceId != null ? ` <span class="ob-tag">device ${b.deviceId}</span>` : ''}</td>
      <td>${esc(b.fromDate ?? 'the beginning')} to ${esc(b.toDate ?? 'now')}</td>
      <td>${b.supersededAt ? '<span class="badge">replaced</span>' : '<span class="badge good">current</span>'}</td><td>${esc(b.reason ?? '')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
