// Data & trust: why every number can be relied on. How the sources come together for each
// slot, how independent measurements agree, where every kWh went, how each day changed
// (and how it looked at any earlier moment), the path of one slot from provider response
// to bill, and the connections, syncs and rebuild behind it all.
import { api, fmt, timeFmt, ago, esc, minorName, slotNoun, slotNouns, SlotNoun, originBadge, originLegend } from '../api.js';
import { init, card } from '../layout.js';
import { headlineCard, coverageCard, drawCoverage, crossCheckCard, balanceCard, revisionsCard, asOfCard, wireAsOf, correctionsCard, detailHistoryHtml, evidenceFlow } from './trust-views.js';

const QUALITY = [[1, 'measured'], [2, 'fallback source'], [4, 'interpolated'], [8, 'estimated'], [16, 'partial coverage'], [32, 'suspect'], [64, 'check failed'], [128, 'restated']];
const badge = (status, text = status) => `<span class="badge ${{ pass: 'good', ok: 'good', final: 'good', warn: 'warn', partial: 'warn', provisional: 'warn', fail: 'bad', error: 'bad', missing: 'bad', interrupted: 'warn' }[status] || ''}">${esc(text)}</span>`;

async function showRaw(id) {
  const dlg = document.getElementById('raw-dialog');
  dlg.querySelector('.body').innerHTML = '<div class="skeleton">Loading…</div>';
  dlg.showModal();
  const r = await api(`/api/raw/${id}`);
  let pretty = r.body;
  try { pretty = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* keep text */ }
  if (pretty.length > 60000) pretty = `${pretty.slice(0, 60000)}\n… (${r.size} bytes in total)`;
  dlg.querySelector('.body').innerHTML = `<div class="card-head"><div><h2>Raw payload #${r.id} · ${esc(r.source)}</h2>
    <p>Fetched ${new Date(r.fetched_at * 1000).toLocaleString('en-GB')} · ${r.status}${r.reason ? ` · ${esc(r.reason)}` : ''} · <span class="mono">${esc(r.file)}</span></p></div></div>
    <p class="mono muted" style="word-break:break-all">${esc(r.request)}</p><pre class="json">${esc(pretty)}</pre>`;
}

async function evidence(state, slot) {
  const box = document.getElementById('evidence-body');
  const tf = timeFmt(state.tz);
  let e;
  try { e = await api(`/api/sites/${state.site.id}/evidence?slot=${slot}`); } catch (err) { box.innerHTML = `<div class="skeleton">${esc(err.message)}</div>`; return; }
  const r = e.row;
  const flags = QUALITY.filter(([b]) => r.quality & b).map(([, l]) => l);
  const lin = r.lineage || {};
  const v = (x, d = 3) => (x == null ? '–' : Number(x).toFixed(d));
  const impInc = r.import_rate_ex != null ? r.import_rate_ex * (1 + (r.import_vat || 0)) : null;
  box.innerHTML = `
    ${evidenceFlow(e)}
    <h3>All the numbers</h3>
    <div class="grid cols-3">
      <div><h3>Energy (kWh)</h3><div class="rows">
        ${[['Solar', r.solar], ['Grid import', r.grid_import], ['Grid export', r.grid_export], ['Battery charge', r.battery_charge], ['Battery discharge', r.battery_discharge], ['Home (by balance)', r.home], ['Loss / error', r.loss], ['EV', r.ev], ['Charge level end', r.soc_end != null ? `${Math.round(r.soc_end)}%` : null]]
          .map(([k, x]) => `<div class="row"><span class="k">${k}</span><b class="mono">${typeof x === 'string' ? x : v(x)}</b></div>`).join('')}
      </div></div>
      <div><h3>Who fed whom (kWh)</h3><div class="rows">
        ${[['Solar → home', r.solar_to_home], ['Solar → battery', r.solar_to_battery], ['Solar → grid', r.solar_to_grid], ['Battery → home', r.battery_to_home], ['Battery → grid', r.battery_to_grid], ['Grid → home', r.grid_to_home], ['Grid → battery', r.grid_to_battery]]
          .map(([k, x]) => `<div class="row"><span class="k">${k}</span><b class="mono">${v(x)}</b></div>`).join('')}
      </div></div>
      <div><h3>Price and cost (${minorName()})</h3><div class="rows">
        <div class="row"><span class="k">Import price before VAT${lin.levy ? ' (incl. per-kWh levy)' : ''}</span><b class="mono">${v(r.import_rate_ex, 2)}</b></div>
        <div class="row"><span class="k">VAT</span><b class="mono">${r.import_vat != null ? fmt.pct(r.import_vat) : '–'}</b></div>
        <div class="row"><span class="k">Export price</span><b class="mono">${v(r.export_rate, 2)}</b></div>
        <div class="row"><span class="k">Grid → home</span><b class="mono">${v(r.grid_to_home_cost, 2)}</b></div>
        <div class="row"><span class="k">Grid → battery</span><b class="mono">${v(r.grid_to_battery_cost, 2)}</b></div>
        <div class="row"><span class="k">Battery → home (FIFO)</span><b class="mono">${v(r.battery_to_home_cost, 2)}</b></div>
        <div class="row"><span class="k">Standing share</span><b class="mono">${v(r.standing_cost, 2)}</b></div>
        <div class="row"><span class="k">Export credit</span><b class="mono">${v(r.export_credit, 2)}</b></div>
        <div class="row total"><span class="k">Total</span><b class="mono">${v(r.total_cost, 2)}</b></div>
        <div class="row"><span class="k">Grid only</span><b class="mono">${v(r.grid_only_cost, 2)}</b></div>
        <div class="row total"><span class="k">Saving</span><b class="mono">${v(r.saving, 2)}</b></div>
      </div></div>
    </div>
    <div class="section rows">
      <div class="row"><span class="k">State</span><span>${badge(r.state)} ${flags.map((f) => badge(f === 'measured' ? 'pass' : 'warn', f)).join(' ')}</span></div>
      <div class="row"><span class="k">Import from</span><b class="mono">${esc(lin.import || '–')}</b></div>
      <div class="row"><span class="k">Inverter coverage of this ${slotNoun()}</span><b class="mono">${lin.coverage != null ? fmt.pct(lin.coverage) : '–'}</b></div>
      <div class="row"><span class="k">Daily-total fit factors</span><b class="mono">${lin.fit ? Object.entries(lin.fit).map(([k, x]) => `${k} ${Number(x).toFixed(3)}`).join(' · ') : '–'}</b></div>
      <div class="row"><span class="k">Tariff · register</span><b class="mono">${esc(lin.tariff || '–')} · ${esc(lin.register || '–')}${lin.estimated ? ' · <span class="badge warn">estimated price</span>' : ''}</b></div>
      <div class="row"><span class="k">Where the prices came from</span><span>${lin.origin ? originBadge(lin.origin) : '<span class="faint">built before origins were recorded: rebuild to label</span>'} · energy data ${originBadge(lin.data_origin || 'provider')}</span></div>
      ${(lin.placeholder_inputs || []).length ? `<div class="row"><span class="k">Not verified</span><span class="mono" style="white-space:normal;text-align:right">${lin.placeholder_inputs.map(esc).join('<br>')}</span></div>` : ''}
      <div class="row"><span class="k">Carbon</span><b class="mono">${r.carbon_intensity != null ? `${Math.round(r.carbon_intensity)} g/kWh (${esc(lin.carbon)})` : '–'}</b></div>
      <div class="row"><span class="k">Built</span><b class="mono">${esc(r.method_version)} · ${new Date(r.built_at * 1000).toLocaleString('en-GB')}</b></div>
    </div>
    <h3 class="section">Facts used (${e.facts.length}) · crossed out = superseded by a later version</h3>
    <div class="table-wrap" style="max-height:360px;overflow:auto"><table>
      <thead><tr><th>Metric</th><th>Source</th><th>Time</th><th class="r">Value</th><th>Recorded</th><th>Raw</th></tr></thead>
      <tbody>${e.facts.map((f) => `<tr class="${f.superseded_at ? 'superseded' : ''}"><td>${esc(f.metric)}</td><td class="mono">${esc(f.source)}</td>
        <td>${tf.time(f.start_ts)}${f.end_ts ? `–${tf.time(f.end_ts)}` : ''}</td><td class="r mono">${f.value == null ? 'null' : Number(f.value).toFixed(3)} ${esc(f.unit)}</td>
        <td class="faint">${new Date(f.recorded_at).toLocaleTimeString('en-GB')}</td><td>${f.raw_id ? `<button class="btn" data-raw="${f.raw_id}" style="height:24px">#${f.raw_id}</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    <h3 class="section">Prices in force</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Tariff</th><th>Component</th><th>Valid</th><th class="r">Ex tax</th><th>Origin</th><th>Raw</th></tr></thead>
      <tbody>${e.rates.map((x) => `<tr class="${x.superseded_at ? 'superseded' : ''}"><td class="mono">${esc(x.tariff_code)}</td><td>${x.component} · ${x.register} · ${x.payment_method}${x.estimated ? ' · <span class="badge warn">estimated</span>' : ''}</td>
        <td>${tf.dayTime(x.valid_from)} → ${x.valid_to ? tf.dayTime(x.valid_to) : 'open'}</td><td class="r mono">${Number(x.price_ex_vat).toFixed(4)}</td>
        <td>${originBadge(x.origin, x.origin_note)}</td>
        <td>${x.raw_id ? `<button class="btn" data-raw="${x.raw_id}" style="height:24px">#${x.raw_id}</button>` : ''}</td></tr>`).join('')}
      ${(e.taxRules?.length ? e.taxRules : []).map((x) => `<tr><td class="mono">${esc(x.country)} ${esc(x.code)}</td><td>${x.fuel} · ${x.direction} · on ${x.applies_to}</td><td>${tf.dayTime(x.valid_from)} → ${x.valid_to ? tf.dayTime(x.valid_to) : 'open'}</td>
        <td class="r mono">${x.kind === 'percent' ? fmt.pct(x.value, 2) : `${Number(x.value).toFixed(3)} ${esc(x.currency || '')}${x.charge_period ? `/${esc(x.charge_period)}` : '/kWh'}`}</td><td>${originBadge(x.origin, x.origin_note)}</td><td></td></tr>`).join('')}
      ${e.taxRules?.length ? '' : e.vat.map((x) => `<tr><td class="mono">VAT</td><td>${x.fuel} · ${x.direction}</td><td>${tf.dayTime(x.valid_from)} → ${x.valid_to ? tf.dayTime(x.valid_to) : 'open'}</td><td class="r mono">${fmt.pct(x.rate)}</td><td>${originBadge(x.origin, x.origin_note)}</td><td></td></tr>`).join('')}</tbody>
    </table></div>${originLegend()}`;
  box.querySelectorAll('[data-raw]').forEach((b) => b.addEventListener('click', () => showRaw(b.dataset.raw)));
}

// The system's physical details, where each value comes from, and how to replace
// estimates with the installer's figures from the MCS paperwork.
function systemCard(sys, t) {
  const tag = { installer: ['good', 'from installer'], provider: ['info', 'from provider'], measured: ['info', 'measured'], estimated: ['warn', 'estimate'], unknown: ['bad', 'not known'] };
  const rows = sys.items.map((i) => `<tr><td><b>${esc(i.label)}</b></td><td class="r mono">${i.value != null ? `${i.value} ${esc(i.unit)}` : '–'}</td>
    <td><span class="badge ${tag[i.status][0]}">${tag[i.status][1]}</span></td><td class="muted" style="white-space:normal">${esc(i.source)}</td>
    <td class="mono" style="white-space:nowrap">${esc(i.key)}</td><td class="muted" style="white-space:normal">${esc(i.mcs)}</td></tr>`).join('');
  const needsInstaller = sys.items.some((i) => i.status !== 'installer');
  return card("Your system's details", 'Used by the solar forecast and the battery figures. Each value shows where it comes from.', `
    <div class="table-wrap"><table>
      <thead><tr><th>Detail</th><th class="r">Value</th><th>Status</th><th>Where it comes from</th><th>Setting in .env</th><th>Where to find it</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${t ? detailHistoryHtml(t) : ''}
    ${needsInstaller ? `<div class="banner warn" style="margin-top:12px"><span>i</span><div>
      <b>Replace estimates with the installer's figures</b>
      <ol style="margin:6px 0 0 18px;padding:0">
        <li>Find the handover pack from your installer${sys.installer ? ` (${esc(sys.installer)}, from ${esc(sys.installerSource)})` : ''}. It contains the <b>MCS certificate</b> and the <b>MCS performance estimate</b>. If you don't have it, ask the installer for a copy.</li>
        <li>From the performance estimate, read the <b>system size</b> (kWp) and, for the panels, the <b>inclination</b> (tilt from flat, in degrees) and the <b>orientation</b> (the direction they face). From the battery datasheet or the handover pack, read the battery's <b>usable capacity</b> (kWh).</li>
        <li>Write the direction as a compass bearing: east 90, south-east 135, south 180, south-west 225, west 270. If it is given as degrees away from south, use 180 minus that number for panels turned towards the east, or 180 plus it for panels turned towards the west.</li>
        <li>Put them in <span class="mono">.env</span> as <span class="mono">PV_KWP</span>, <span class="mono">PV_TILT</span>, <span class="mono">PV_ORIENTATION</span> and <span class="mono">BATTERY_KWH</span>, then restart the server (<span class="mono">npm start</span>).</li>
      </ol>
      <p style="margin:6px 0 0">The new values replace the estimates on the next sync. The solar forecast then uses Quartz for those panels, compared with this home's actual output for 2 days before it is relied on. If panels face more than one direction, note each array's figures. This prototype models one direction, which the output data suggests is right here (both strings produce equal power).</p>
    </div></div>` : ''}`);
}

// Providers for this home (the API's site.providers, one entry per role): which adapter the market's
// registry gives each kind of data, how its last sync went, where its data comes from (origin badge)
// and whether it is shared across homes or per home. The status is always a word on a badge, never
// a colour only. Entry: { role, adapter, status, origin, note, scope } (+ label, reason, alternatives
// when the backend sends them).
const ROLE_LABEL = {
  inverter: 'Inverter', meter: 'Meter', location: 'Location', weather: 'Weather', carbon: 'Grid carbon intensity',
  gas_cv: 'Gas energy content', tariff_prices: 'Tariff prices', tariff_catalogue: 'Tariffs on sale',
  compare: 'Tariffs to compare with', solar_forecast: 'Solar forecast',
};
const PROVIDER_STATUS = {
  ok: ['good', 'OK', 'the last sync from this provider worked'],
  error: ['bad', 'Error', 'the last sync failed; the other providers still ran'],
  skipped: ['warn', 'Skipped', 'not run on the last sync (nothing to fetch yet, no credentials, or a demo home); not a failure'],
  disabled: ['', 'Disabled', 'listed for this market but switched off; the note says why'],
  none: ['', 'None', 'no provider is listed for this kind of data in this market'],
};
const SCOPE_WORD = { shared: ['Shared across homes', 'fetched once per region, tariff or location and used by every home that needs it'],
  home: ['Per home', "uses this home's own connection (an account or an inverter)"] };
const ORIGIN_ORDER = ['sourced', 'provider', 'user', 'derived', 'placeholder', 'synthetic'];
const NO_PROVIDER_RE = /^no provider for this market\.?$/i;

const statusBadge = (status) => {
  const [cls, word] = PROVIDER_STATUS[status] || ['', status || 'unknown'];
  return `<span class="badge ${cls}">${esc(word)}</span>`;
};

function providerNote(x) {
  const lines = [];
  if (x.status === 'none') lines.push('No provider for this market.');
  const note = x.note && !NO_PROVIDER_RE.test(String(x.note).trim()) ? String(x.note).trim() : '';
  // As a sentence: capital first letter and a full stop, so the next sentence does not run on.
  if (note) lines.push(esc(`${note.charAt(0).toUpperCase()}${note.slice(1)}${/[.!?)]$/.test(note) ? '' : '.'}`));
  if (x.role === 'tariff_prices' && (x.status === 'none' || x.status === 'disabled')) lines.push('Tariffs can be entered by hand.');
  const reason = x.reason && !NO_PROVIDER_RE.test(String(x.reason).trim()) && !(note && String(x.reason).includes(note)) ? String(x.reason) : '';
  const extra = [];
  if (reason) extra.push(`${x.status === 'disabled' ? 'Why' : 'Last sync'}: ${esc(reason)}`);
  if ((x.alternatives || []).length) {
    extra.push(`Also listed: ${x.alternatives.map((a) => `<span class="mono">${esc(a.adapter)}</span> (${esc((PROVIDER_STATUS[a.status]?.[1] || a.status || 'unknown').toLowerCase())})`).join(', ')}`);
  }
  return `${lines.join(' ') || '<span class="faint">–</span>'}${extra.map((e) => `<small>${e}</small>`).join('')}`;
}

function providersCard(site) {
  const title = 'Providers for this home';
  const list = Array.isArray(site?.providers) ? site.providers : null;
  if (!list || !list.length) return card(title, '', '<p class="muted" style="margin:0">Provider information not available.</p>');
  const none = '<span class="faint" role="img" aria-label="none">–</span>';
  const rows = list.map((x) => {
    const has = x.status !== 'none' && x.adapter;
    const scope = SCOPE_WORD[x.scope]?.[0];
    return `<tr role="row">
      <th role="rowheader" scope="row">${esc(ROLE_LABEL[x.role] || x.label || String(x.role || '').replace(/_/g, ' '))}<span class="mono">${esc(x.role)}</span></th>
      <td role="cell" data-label="Provider">${has ? `<span class="mono">${esc(x.adapter)}</span>` : none}</td>
      <td role="cell" data-label="Status">${statusBadge(x.status)}</td>
      <td role="cell" data-label="Origin">${has ? originBadge(x.origin) : none}</td>
      <td role="cell" data-label="Shared or per home">${has && scope ? esc(scope) : none}</td>
      <td role="cell" data-label="Note" class="prov-note">${providerNote(x)}</td></tr>`;
  }).join('');
  const present = new Set(list.filter((x) => x.status !== 'none' && x.adapter).map((x) => (ORIGIN_ORDER.includes(x.origin) ? x.origin : 'placeholder')));
  const key = `<div class="state-notes prov-key"><h3>What the words mean</h3><dl>
      ${Object.keys(PROVIDER_STATUS).map((s) => `<dt>${statusBadge(s)}</dt><dd>${esc(PROVIDER_STATUS[s][2])}</dd>`).join('')}
      ${Object.values(SCOPE_WORD).map(([w, d]) => `<dt>${esc(w)}</dt><dd>${esc(d)}</dd>`).join('')}
    </dl>${present.size ? originLegend(ORIGIN_ORDER.filter((o) => present.has(o))) : ''}
    <p class="faint">A tariff and its prices can always be typed in by hand (labelled ${originBadge('user')}), in any market. Keys and passwords are never stored by the core: they are read from <span class="mono">.env</span>, for the .env home only.</p></div>`;
  return card(title, `Which provider fills each kind of data${site.market_code ? ` in market ${esc(site.market_code)}` : ''}, and how its last sync went.`, `
    <div class="table-wrap"><table class="providers" role="table" aria-label="${title}, one row per kind of data">
      <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">What it provides</th><th role="columnheader" scope="col">Provider</th><th role="columnheader" scope="col">Status</th>
        <th role="columnheader" scope="col">Origin</th><th role="columnheader" scope="col">Shared or per home</th><th role="columnheader" scope="col">Note</th></tr></thead>
      <tbody role="rowgroup">${rows}</tbody></table></div>${key}`, 'id="providers"');
}

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [h, catalog, sys, t] = await Promise.all([api(`/api/sites/${id}/health`), api('/api/catalog'), api(`/api/sites/${id}/system`),
    api(`/api/sites/${id}/trust?period=${state.period}`)]);
  const q = new URLSearchParams(location.search);
  const slotParam = Number(q.get('slot')) || null;

  const conns = `<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Status</th><th>Last success</th><th>Error</th></tr></thead><tbody>
    ${h.connections.map((c) => `<tr><td>${esc(c.provider)}${c.external_ref ? ` <span class="faint mono">${esc(c.external_ref)}</span>` : ''}</td><td>${badge(c.status)}</td><td>${ago(c.last_success_at)}</td><td class="muted" style="white-space:normal">${esc(c.last_error || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
  const runs = `<div class="rows">${h.runs.map((r) => `<details class="row" style="display:block"><summary>${badge(r.status)} ${new Date(r.started_at * 1000).toLocaleString('en-GB')} · ${r.finished_at ? `${r.finished_at - r.started_at}s` : 'running'}</summary>
    <div class="table-wrap"><table><tbody>${r.detail.map((s) => `<tr><td>${esc(s.step || '')}</td><td>${s.ok === false ? badge('fail', 'failed') : badge('pass', 'ok')}</td><td class="r">${s.ms ?? ''} ms</td>
      <td class="mono muted" style="white-space:normal">${esc(s.error || JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !['step', 'ok', 'ms'].includes(k)))))}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}</div>`;

  const st = h.storage;
  const storage = `<div class="rows">
    <div class="row"><span class="k">Database file</span><b>${(st.dbBytes / 1024 / 1024).toFixed(1)} MB</b></div>
    <div class="row"><span class="k">Raw payloads landed</span><b>${st.raw}</b></div>
    <div class="row"><span class="k">Readings (5-minute and live)</span><b>${st.readings.toLocaleString('en-GB')} <span class="faint">· ${st.superseded} superseded</span></b></div>
    <div class="row"><span class="k">Interval facts · forecasts · price rows</span><b>${st.intervals.toLocaleString('en-GB')} · ${st.forecasts.toLocaleString('en-GB')} · ${st.rates.toLocaleString('en-GB')}</b></div>
    <div class="row"><span class="k">${SlotNoun()}s served</span><b>${st.halfHours.toLocaleString('en-GB')} <span class="faint">· ${h.restated} restated</span></b></div>
    <div class="row"><span class="k">Build method</span><b class="mono">${esc(h.method)}</b></div>
  </div>
  <button class="btn" id="rebuild-btn" style="margin-top:12px">Rebuild every ${slotNoun()} from facts</button><div id="rebuild-out" class="faint" style="margin-top:8px;font-size:13px"></div>`;

  const quarantine = h.quarantined.length ? `<div class="table-wrap"><table><tbody>${h.quarantined.map((x) => `<tr><td>${esc(x.source)}</td><td class="muted">${esc(x.reason)}</td><td>${ago(x.fetched_at)}</td><td><button class="btn" data-raw="${x.id}" style="height:24px">#${x.id}</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted" style="margin:0">Nothing quarantined. Payloads that fail their source contract are kept here, never loaded.</p>';

  const contracts = `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Time</th><th>Signs</th><th>Units</th><th>Revisions</th></tr></thead><tbody>
    ${catalog.sources.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="mono faint">${esc(s.code)}</span></td>${['timeZone', 'signs', 'units', 'revisions'].map((k) => `<td class="muted" style="white-space:normal;min-width:160px;font-size:12px">${esc(s.contract[k])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;

  document.getElementById('content').innerHTML = `
    ${headlineCard(t, tf)}
    <div class="section">${coverageCard(t)}</div>
    <div class="section">${crossCheckCard(t, tf)}</div>
    <div class="section">${balanceCard(t, tf)}</div>
    <div class="section">${revisionsCard(t, tf)}</div>
    <div class="section">${asOfCard(t, tf)}</div>
    <div class="section" id="evidence">${card(`The path of one ${slotNoun()}`, `From the providers' responses to the bill, step by step. Pick a ${slotNoun()}, or click any bar on the other pages.`,
      `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><select id="ev-day">${h.days.map((d) => `<option value="${d.local_date}">${tf.date(d.local_date)}</option>`).join('')}</select><select id="ev-slot"></select></div><div id="evidence-body"><div class="skeleton">Choose a ${slotNoun()}.</div></div>`)}</div>
    <div class="section" id="system">${systemCard(sys, t)}</div>
    <div class="section">${correctionsCard(t, tf)}</div>
    <div class="banner section"><span>⛓</span><div><b>Pipeline:</b> provider API → adapter (applies the source contract) → raw payload kept → facts (append-only, versioned) → build engine (${esc(h.method)}) → ${slotNoun()} timeline → these pages.
      Pages never call a provider; they read the timeline.</div></div>
    <div class="section">${providersCard(state.site)}</div>
    <div class="section grid cols-2">${card('Connections', 'One per provider for this home', conns)}${card('Recent syncs', 'Each step runs on its own; one failure never blocks the rest', runs)}</div>
    <div class="section grid cols-2">${card('Storage and rebuild', 'Serving tables are disposable: they can always be rebuilt from facts.', storage)}${card('Quarantine', '', quarantine)}</div>
    <div class="section">${card('Source contracts', 'Everything the core knows about each provider’s quirks lives here, not in the build engine.', contracts)}</div>
    <dialog id="raw-dialog"><div class="body"></div><form method="dialog" style="text-align:right;margin-top:10px"><button class="btn">Close</button></form></dialog>`;

  drawCoverage(document.getElementById('coverage'), t, tf);
  wireAsOf(state, t, tf);
  const daySel = document.getElementById('ev-day');
  const slotSel = document.getElementById('ev-slot');
  const fillSlots = async (date, pick) => {
    const t = await api(`/api/sites/${id}/timeline?from=${date}&to=${date}&step=hh`);
    slotSel.innerHTML = t.rows.map((r) => `<option value="${r.slot_start}">${tf.time(r.slot_start)} · ${r.state} · ${fmt.kwh(r.home, 2)} · ${fmt.gbp(r.total_cost)}</option>`).join('');
    const choice = pick && t.rows.some((r) => r.slot_start === pick) ? pick
      : (t.rows.reduce((a, b) => ((b.battery_to_home || 0) > (a?.battery_to_home || 0) ? b : a), null) || t.rows[t.rows.length - 1])?.slot_start;
    if (choice) { slotSel.value = String(choice); evidence(state, choice); }
  };
  daySel.addEventListener('change', () => fillSlots(daySel.value));
  slotSel.addEventListener('change', () => evidence(state, Number(slotSel.value)));
  if (slotParam) {
    const dayOf = h.days.find((d) => tf.date(d.local_date) === tf.day(slotParam));
    if (dayOf) daySel.value = dayOf.local_date;
    await fillSlots(daySel.value, slotParam);
    if (location.hash === '#evidence') document.getElementById('evidence').scrollIntoView();
  } else if (h.days.length) {
    daySel.value = h.days[Math.min(1, h.days.length - 1)].local_date;
    await fillSlots(daySel.value);
  }
  document.querySelectorAll('#content [data-raw]').forEach((b) => b.addEventListener('click', () => showRaw(b.dataset.raw)));
  document.getElementById('rebuild-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    const out = document.getElementById('rebuild-out');
    out.textContent = 'Rebuilding…';
    const r = await api(`/api/sites/${id}/rebuild`, { method: 'POST' });
    const same = r.before.c === r.after.c && r.before.h === r.after.h && r.before.n === r.after.n;
    out.innerHTML = `${r.days} days, ${r.slots} ${slotNouns()} rebuilt in ${r.ms} ms. Total cost ${fmt.gbp(r.before.c)} → ${fmt.gbp(r.after.c)}, home use ${fmt.kwh(r.before.h)} → ${fmt.kwh(r.after.h)}. ${same ? badge('pass', 'identical: same facts, same numbers') : badge('warn', 'changed: new facts arrived since the last build')}`;
    ev.target.disabled = false;
  });
}

init({ page: 'data', title: 'Data & trust', subtitle: 'Why these numbers can be trusted: where each one comes from, how independent measurements agree, and what changed.', render });
