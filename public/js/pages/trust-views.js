// Trust views for the Data & trust page: why each number can be relied on, shown from the
// facts themselves. Everything here reads /api/sites/:id/trust, /asof and /evidence.
import { api, fmt, esc } from '../api.js';
import { card } from '../layout.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const ICON = { pass: '✓', warn: '!', fail: '✕', skip: '–' };
const CHECK_LABEL = {
  completeness: 'Every half-hour present', rate_coverage: 'Every half-hour priced', energy_balance: 'Energy balance',
  meter_vs_ct: 'Meter vs clamp, import', meter_vs_ct_export: 'Meter vs clamp, export', gas_calorific_value: 'Gas converted',
  counter_fit_solar: 'Solar counter', counter_fit_load: 'House counter', counter_fit_import: 'Import counter', counter_fit_export: 'Export counter',
  counter_fit_charge: 'Battery-in counter', counter_fit_discharge: 'Battery-out counter', battery_efficiency: 'Battery efficiency', battery_stock: 'Stored-energy cost',
};
const checkName = (code) => CHECK_LABEL[code] || code;

// ───────────── 1 Headline ─────────────

export function headlineCard(t, tf) {
  const h = t.headline;
  const built = h.final + h.provisional + h.missing;
  const seg = (n, color, label) => (n ? `<i style="flex:${n};background:var(${color})" title="${label}: ${n}"></i>` : '');
  const run = h.checks.pass + h.checks.warn + h.checks.fail;
  const stat = (big, label, note) => `<div class="proof-stat"><div class="big">${big}</div><div class="label">${label}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  return card(`Can these numbers be trusted? <span class="faint" style="font-weight:500">${tf.date(h.from)} – ${tf.date(h.to)}</span>`,
    'Four things decide it: every half-hour built from the final source, independent measurements agreeing, every number traced to what a provider sent, and every change recorded.', `
    <div class="proof-stats">
      ${stat(`${pct(h.final, built)}% final`, `${h.final} of ${built} half-hours`, `${h.provisional} provisional (waiting for smart-meter readings) · ${h.missing} missing`)}
      ${stat(`${h.checks.pass} of ${run} pass`, 'cross-checks between independent measurements', `${h.checks.warn} warning${h.checks.warn === 1 ? '' : 's'} · ${h.checks.fail} failed · ${h.checks.skip} not judged yet`)}
      ${stat(h.facts ? `${pct(h.factsLinked, h.facts)}% traced` : '–', `${h.facts.toLocaleString('en-GB')} facts from ${h.payloads} provider responses`, 'Every reading links to the raw response it came from, kept unchanged.')}
      ${stat(`${h.restated}`, 'half-hours changed after first shown as final', `${h.revisedDays} day${h.revisedDays === 1 ? '' : 's'} revised in this period · ${t.corrections.length} correction${t.corrections.length === 1 ? '' : 's'} by EnergieBee`)}
    </div>
    <div class="proof-bar" role="img" aria-label="${h.final} final, ${h.provisional} provisional, ${h.missing} missing">${seg(h.final, '--good', 'Final')}${seg(h.provisional, '--warn', 'Provisional')}${seg(h.missing, '--bad', 'Missing')}</div>
    <div class="legend" style="margin-top:8px"><span><i class="swatch" style="background:var(--good)"></i>Final: smart-meter readings in, every check run</span>
      <span><i class="swatch" style="background:var(--warn)"></i>Provisional: inverter clamp until the meter readings arrive (about a day later)</span>
      <span><i class="swatch" style="background:var(--bad)"></i>Missing: no grid reading from any source</span></div>`, 'id="proof"');
}

// ───────────── 2 Source coverage ─────────────

const CELL = {
  o: ['--good', 'On time'], h: ['--grid', 'Loaded with the history when first connected'], l: ['--warn', 'Arrived late'],
  p: ['--export', 'Partial: fewer samples than expected'], w: ['--text-3', 'Waiting: not due from the provider yet'],
  m: ['--bad', 'Missing: overdue'], n: ['--surface-2', 'Not expected'],
};
const STATE = { f: ['--good', 'Final'], p: ['--warn', 'Provisional'], m: ['--bad', 'Missing'], n: ['--surface-2', 'Not built yet'] };
const delayText = (s) => (s == null ? '–' : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

export function coverageCard(t) {
  const rows = t.feeds.map((f) => {
    const c = {}; for (const ch of f.cells) c[ch] = (c[ch] || 0) + 1;
    const due = f.cells.length - (c.n || 0) - (c.w || 0);
    const delays = f.byDay.map((d) => d.medianDelayS).filter((v) => v != null);
    return `<tr><td><b>${esc(f.label)}</b><br><span class="faint">${esc(f.source)}</span></td><td class="muted" style="white-space:normal;min-width:180px">${esc(f.use)}</td>
      <td class="r">${due ? `${pct((c.o || 0) + (c.h || 0) + (c.l || 0), due)}%` : '–'}</td><td class="r">${c.l || 0}</td><td class="r">${c.w || 0}</td><td class="r">${(c.m || 0) + (c.p || 0)}</td>
      <td class="r">${delayText(delays.length ? delays[delays.length - 1] : null)}</td></tr>`;
  }).join('');
  return card('How the timeline comes together',
    'Each row is one source; each column is one half-hour. The bottom row is the result: a half-hour becomes final only when every source it needs has arrived. Hover for detail.', `
    <div id="coverage"></div>
    <div class="legend" style="margin-top:10px">${Object.values(CELL).map(([c, l]) => `<span><i class="swatch" style="background:var(${c})${c === '--surface-2' ? ';outline:1px solid var(--border)' : ''}"></i>${l}</span>`).join('')}</div>
    <details style="margin-top:12px"><summary class="muted">As a table</summary><div class="table-wrap"><table>
      <thead><tr><th>Source</th><th>Used for</th><th class="r">Received when due</th><th class="r">Late</th><th class="r">Waiting</th><th class="r">Missing or partial</th><th class="r">Latest daily median delay</th></tr></thead>
      <tbody>${rows}</tbody></table></div></details>`);
}

export function drawCoverage(host, t, tf) {
  const rows = [...t.feeds.map((f) => ({ label: f.label, sub: f.source, cells: f.cells, map: CELL })),
    { label: 'Result: half-hour state', sub: 'Build engine', cells: t.states, map: STATE, result: true }];
  const ROW = 30; const HEAD = 22; const BAND = 16;
  host.innerHTML = `<div class="cov">
    <div class="cov-labels" style="padding-top:${HEAD}px">${rows.map((r) => `<div class="cov-label${r.result ? ' result' : ''}" style="height:${ROW}px"><b>${esc(r.label)}</b><span>${esc(r.sub)}</span></div>`).join('')}</div>
    <div class="cov-plot"><canvas role="img" aria-label="Arrival of each source for every half-hour; the table below gives the same information"></canvas><div class="tip cov-tip" hidden></div></div></div>`;
  const plot = host.querySelector('.cov-plot'); const canvas = host.querySelector('canvas'); const tip = host.querySelector('.cov-tip');
  const n = t.slotTimes.length;
  const draw = () => {
    const w = plot.clientWidth; const h = HEAD + rows.length * ROW;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const cw = w / n;
    const colors = Object.fromEntries([...Object.values(CELL), ...Object.values(STATE)].map(([v]) => [v, css(v)]));
    rows.forEach((r, ri) => {
      const y = HEAD + ri * ROW + (ROW - BAND) / 2;
      for (let i = 0; i < n; i++) {
        g.fillStyle = colors[(r.map[r.cells[i]] || CELL.n)[0]];
        const x0 = Math.floor(i * cw); const x1 = Math.max(x0 + 1, Math.floor((i + 1) * cw));
        g.fillRect(x0, y, x1 - x0, BAND);
      }
      if (r.result) { g.strokeStyle = css('--border'); g.beginPath(); g.moveTo(0, HEAD + ri * ROW + 0.5); g.lineTo(w, HEAD + ri * ROW + 0.5); g.stroke(); }
    });
    // Day boundaries (a 2px gap) and labels.
    g.font = '11px system-ui, sans-serif';
    let prev = null; let lastLabel = -100;
    t.slotTimes.forEach((s, i) => {
      const d = tf.day(s);
      if (d === prev) return;
      prev = d;
      const x = Math.floor(i * cw);
      if (i) { g.fillStyle = css('--surface'); g.fillRect(x - 1, HEAD - 4, 2, rows.length * ROW + 4); }
      if (x - lastLabel > 72 && x < w - 40) { g.fillStyle = css('--text-2'); g.fillText(d, x + 3, 13); lastLabel = x; }
    });
    const ni = t.slotTimes.findIndex((s) => s + 1800 > t.now);
    if (ni > 0) {
      const x = Math.floor(ni * cw) + 0.5;
      g.strokeStyle = css('--text'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, HEAD - 2); g.lineTo(x, h); g.stroke(); g.setLineDash([]);
    }
  };
  const move = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left; const y = ev.clientY - rect.top;
    const i = Math.floor((x / rect.width) * n); const ri = Math.floor((y - HEAD) / ROW);
    if (i < 0 || i >= n || ri < 0 || ri >= rows.length) { tip.hidden = true; return; }
    const r = rows[ri];
    tip.innerHTML = `<b>${esc(r.label)}</b><br>${tf.dayTime(t.slotTimes[i])}–${tf.time(t.slotTimes[i] + 1800)}<br>${esc((r.map[r.cells[i]] || CELL.n)[1])}`;
    tip.hidden = false;
    tip.style.left = `${Math.max(0, Math.min(x + 12, rect.width - 230))}px`; tip.style.top = `${y + 14}px`;
  };
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  new ResizeObserver(draw).observe(plot);
  draw();
}

// ───────────── 3 Cross-checks ─────────────

const GROUPS = [
  ['Inverter counters vs 5-minute samples', 'The inverter keeps its own daily totals; the 5-minute readings, added up, must match them within 10% (or 0.2 kWh).',
    [['counter_fit_solar', 'Solar'], ['counter_fit_load', 'House'], ['counter_fit_import', 'Grid import'], ['counter_fit_export', 'Grid export'], ['counter_fit_charge', 'Battery in'], ['counter_fit_discharge', 'Battery out']]],
  ['Smart meter vs inverter clamp', 'Two different devices measure the same grid connection; they must agree within 5%.',
    [['meter_vs_ct', 'Import'], ['meter_vs_ct_export', 'Export']]],
  ['Energy balance', "Energy in minus energy out (house, exports, charging) is what the inverter used; it must be close to this home's own typical day.",
    [['energy_balance', 'Inverter use']]],
  ['Coverage', 'Every half-hour has a grid reading and a price; gas is converted with the published calorific value.',
    [['completeness', 'Present'], ['rate_coverage', 'Priced'], ['gas_calorific_value', 'Gas converted']]],
  ['Battery', 'Round trip measured from the inverter counters; cost of stored energy known.',
    [['battery_efficiency', 'Efficiency'], ['battery_stock', 'Stored cost']]],
];

function cellValue(code, c) {
  const m = c.measured;
  if (m == null) return '';
  if (code.startsWith('counter_fit')) return `${m >= 1 ? '+' : '−'}${Math.abs((m - 1) * 100).toFixed(1)}%`;
  if (code.startsWith('meter_vs_ct')) return `${m >= 0 ? '+' : '−'}${Math.abs(m * 100).toFixed(1)}%`;
  if (code === 'energy_balance') return `${m.toFixed(1)} kWh`;
  if (code === 'battery_efficiency') return `${(m * 100).toFixed(1)}%`;
  if (code === 'gas_calorific_value') return m ? `${m} waiting` : '';
  if (code === 'completeness' || code === 'rate_coverage') return `${Math.round(m * 100)}%`;
  return '';
}

export function crossCheckCard(t, tf) {
  const dates = [...new Set(t.balance.map((b) => b.date).concat(t.checks.map((c) => c.local_date)))].sort();
  const by = new Map(t.checks.map((c) => [`${c.local_date}|${c.check_code}`, c]));
  const present = new Set(t.checks.map((c) => c.check_code));
  const body = GROUPS.map(([title, note, list]) => {
    const rows = list.filter(([code]) => present.has(code));
    if (!rows.length) return '';
    return `<tr class="xg-group"><th colspan="${dates.length + 1}"><b>${esc(title)}</b> <span class="faint">${esc(note)}</span></th></tr>
      ${rows.map(([code, label]) => `<tr><th scope="row">${esc(label)}</th>${dates.map((d) => {
        const c = by.get(`${d}|${code}`);
        if (!c) return '<td class="xg-cell none"></td>';
        return `<td class="xg-cell ${c.status}" title="${esc(`${tf.date(d)} · ${c.status}: ${c.detail || ''}`)}"><span class="ic">${ICON[c.status]}</span><span class="v">${esc(cellValue(code, c))}</span></td>`;
      }).join('')}</tr>`).join('')}`;
  }).join('');
  return card('Independent measurements agree',
    'Each figure on these pages is measured more than one way. For every completed day the core compares them. Hover a cell for the exact numbers.', `
    <div class="table-wrap"><table class="xgrid"><thead><tr><th></th>${dates.map((d) => `<th class="r">${esc(tf.date(d).replace(/^\w+ /, ''))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="legend" style="margin-top:8px"><span><b class="xg-key pass">✓</b>Agrees</span><span><b class="xg-key warn">!</b>Outside the tolerance: a warning, figures kept</span><span><b class="xg-key fail">✕</b>Failed</span><span><b class="xg-key skip">–</b>Not judged yet</span></div>`);
}

// ───────────── 4 Daily balance ─────────────

export function balanceCard(t, tf) {
  const days = t.balance.filter((b) => b.in.solar != null);
  const total = (b) => (b.in.solar || 0) + (b.in.grid || 0) + (b.in.battery || 0);
  const max = Math.max(1, ...days.map(total));
  const bar = (parts) => `<div class="bal-bar">${parts.map(([v, c, l]) => (v > 0.005 ? `<i style="width:${(v / max) * 100}%;background:var(${c})" title="${l}: ${v.toFixed(2)} kWh"></i>` : '')).join('')}</div>`;
  const rows = days.map((b) => {
    const fits = b.counters.filter((c) => c.status);
    const agree = fits.filter((c) => c.status === 'pass').length;
    const mv = (x) => (x ? `${x.meterKwh.toFixed(2)} vs ${x.clampKwh.toFixed(2)} kWh` : '<span class="faint">meter not in yet</span>');
    return `<div class="bal-row">
      <div class="bal-date">${tf.date(b.date)}</div>
      <div class="bal-bars">
        ${bar([[b.in.solar, '--solar', 'Solar'], [b.in.grid, '--grid', 'Grid import'], [b.in.battery, '--battery', 'Battery out']])}
        ${bar([[b.to.home, '--text-2', 'House'], [b.to.grid, '--export', 'Exported'], [b.to.battery, '--battery', 'Into the battery'], [b.to.inverter, '--text-3', 'Inverter used or lost']])}
      </div>
      <div class="bal-num"><b>${total(b).toFixed(1)} kWh</b> in = out<br><span class="faint">inverter ${b.to.inverter.toFixed(1)} kWh</span></div>
      <div class="bal-checks muted">Counters: ${fits.length ? `${agree} of ${fits.length} agree` : '–'}<br>Meter vs clamp: ${mv(b.meterVsClamp.import)}</div>
    </div>`;
  }).join('');
  return card('Every kWh accounted for, each day',
    'Top bar: where the energy came from. Bottom bar: where it went. They are always equal: each kWh goes to exactly one place, and what is left after the house, exports and charging is what the inverter used.', `
    <div class="legend" style="margin-bottom:10px"><span><i class="swatch" style="background:var(--solar)"></i>Solar</span><span><i class="swatch" style="background:var(--grid)"></i>Grid import</span>
      <span><i class="swatch" style="background:var(--battery)"></i>Battery (out on top, in below)</span><span><i class="swatch" style="background:var(--text-2)"></i>House</span>
      <span><i class="swatch" style="background:var(--export)"></i>Exported</span><span><i class="swatch" style="background:var(--text-3)"></i>Inverter used or lost</span></div>
    <div class="bal">${rows}</div>`);
}

// ───────────── 5 Revisions and "as known at" ─────────────

const FIELD = { slots_final: 'final half-hours', slots_provisional: 'provisional', slots_missing: 'missing', solar: 'solar kWh', home: 'house kWh', grid_import: 'import kWh', grid_export: 'export kWh', gas: 'gas kWh', total_cost: 'bill', saving: 'saving', method_version: 'build method' };
const showVal = (f, v) => (v == null ? '–' : ['total_cost', 'saving'].includes(f) ? fmt.gbp(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));

export function revisionsCard(t, tf) {
  const revs = [...t.revisions].sort((a, b) => b.local_date.localeCompare(a.local_date) || b.revised_at - a.revised_at || b.id - a.id);
  const rows = revs.map((r) => {
    const recon = r.kind === 'reconstructed';
    const what = !r.changed
      ? `<span class="faint">${recon ? 'Earliest version that can be reconstructed' : 'First record; history starts here'}: ${r.slots_final} final, ${r.slots_provisional} provisional, gas ${r.gas == null ? 'unknown' : `${r.gas.toFixed(1)} kWh`}, bill ${r.total_cost == null ? 'not priced yet' : fmt.gbp(r.total_cost)}.</span>`
      : !r.changed.length ? '<span class="faint">No change: the same figures, state and checks.</span>'
      : r.changed.map((c) => (c.field.startsWith('check:')
        ? `check <b>${esc(checkName(c.field.slice(6)))}</b> ${esc(c.from ?? '–')} → ${esc(c.to ?? '–')}`
        : `${esc(FIELD[c.field] || c.field)} ${esc(showVal(c.field, c.from))} → <b>${esc(showVal(c.field, c.to))}</b>`)).join(' · ');
    const approx = r.inputs?.approximations?.length ? `<br><span class="faint" title="${esc(r.inputs.approximations.join('; '))}">${r.inputs.approximations.length} input${r.inputs.approximations.length === 1 ? '' : 's'} read as first recorded</span>` : '';
    return `<tr><td>${tf.date(r.local_date)}</td><td>${tf.dayTime(r.revised_at)}<br>${recon ? '<span class="badge info">reconstructed</span>' : '<span class="badge good">recorded</span>'}</td>
      <td class="muted" style="white-space:normal">${esc(r.reason || '–')}${approx}</td><td style="white-space:normal">${what}</td>
      <td class="faint">${r.inputs?.meterSlots ?? '–'} meter · ${r.inputs?.clampSlots ?? '–'} clamp</td></tr>`;
  }).join('');
  return card('How each day changed',
    'Every time a completed day is rebuilt with different figures, state or check results, the change is recorded with its reason. Recorded: written by a live rebuild. Reconstructed: rebuilt afterwards from the facts known at each earlier sync, with today\'s method, for the time before the log was kept.', revs.length ? `
    <div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Day</th><th>Recorded</th><th>Why</th><th>What changed</th><th>Grid from</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No revisions recorded for these days yet.</p>');
}

export function asOfCard(t, tf) {
  const days = [...new Set(t.balance.map((b) => b.date))];
  return card('See a day as it was known at any moment',
    'Facts are never overwritten, so the core can rebuild any day exactly as it stood at an earlier time: what had arrived, what was priced and which checks passed. Nothing is saved; the result is set beside the day as it is now.', `
    <div class="asof-controls">
      <label>Day <select id="asof-day">${days.map((d) => `<option value="${d}">${tf.date(d)}</option>`).join('')}</select></label>
      <label>Known at <select id="asof-at"></select></label>
      <label class="asof-custom" hidden>Moment <input type="datetime-local" id="asof-custom"></label>
      <button class="btn" id="asof-go">Show</button>
    </div>
    <div id="asof-out" style="margin-top:12px"><p class="faint">Pick a day and a moment.</p></div>`);
}

export function wireAsOf(state, t, tf) {
  const daySel = document.getElementById('asof-day'); const atSel = document.getElementById('asof-at');
  const custom = document.getElementById('asof-custom'); const out = document.getElementById('asof-out');
  if (!daySel || !daySel.options.length) return;
  const fill = () => {
    const d = daySel.value;
    const end = t.slotTimes.filter((s) => tf.day(s) === tf.date(d)).pop();
    const ends = (end ?? Date.parse(`${d}T23:30:00Z`) / 1000) + 1800;
    const opts = [];
    for (const r of t.revisions.filter((x) => x.local_date === d)) opts.push([r.revised_at, `${tf.dayTime(r.revised_at)} (recorded change)`]);
    for (const [off, l] of [[3600, 'an hour after the day ended'], [12 * 3600, 'noon the next day'], [36 * 3600, 'two days later']]) if (ends + off < t.now) opts.push([ends + off, `${tf.dayTime(ends + off)} (${l})`]);
    opts.push([t.now, 'now']);
    opts.sort((a, b) => a[0] - b[0]);
    atSel.innerHTML = `${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}<option value="custom">Another moment…</option>`;
  };
  daySel.addEventListener('change', fill);
  atSel.addEventListener('change', () => { document.querySelector('.asof-custom').hidden = atSel.value !== 'custom'; });
  // Start on the latest completed day, the one most likely to have changed.
  daySel.value = daySel.options[Math.max(0, daySel.options.length - 2)].value;
  fill();
  document.getElementById('asof-go').addEventListener('click', async () => {
    const at = atSel.value === 'custom' ? Math.floor(Date.parse(custom.value) / 1000) : Number(atSel.value);
    if (!Number.isFinite(at)) { out.innerHTML = '<p class="muted">Pick a moment.</p>'; return; }
    out.innerHTML = '<div class="skeleton">Rebuilding from the facts known then…</div>';
    let r;
    try { r = await api(`/api/sites/${state.site.id}/asof?date=${daySel.value}&at=${at}`); } catch (err) { out.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
    out.innerHTML = r.known ? asOfResult(r, tf) : `<p class="muted">${esc(r.note)}</p>`;
  });
}

function strip(hh) {
  return `<div class="hh-strip">${hh.map((x) => `<i class="${x.state}${x.import_source === 'sunsynk_ct' ? ' clamp' : ''}" title="${esc(`${x.state}${x.import_source ? ` · grid from the ${x.import_source === 'octopus_meter' ? 'smart meter' : 'inverter clamp'}` : ''}`)}"></i>`).join('')}</div>`;
}

function asOfResult(r, tf) {
  const a = r.then.day; const b = r.now.day;
  const line = (label, f, money) => {
    const x = a?.[f]; const y = b?.[f];
    const same = x === y || (x != null && y != null && Math.abs(x - y) < (money ? 0.5 : 0.0005));
    const show = (v) => (v == null ? '–' : money ? fmt.gbp(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
    return `<tr><td>${label}</td><td class="r">${show(x)}</td><td class="r"><b>${show(y)}</b></td><td>${same ? '<span class="faint">same</span>' : '<span class="badge warn">changed</span>'}</td></tr>`;
  };
  const codes = [...new Set([...r.then.checks.map((c) => c.code), ...r.now.checks.map((c) => c.code)])].sort();
  const st = (list, code) => { const s = list.find((c) => c.code === code)?.status; return s ? `<span class="xg-key ${s}">${ICON[s]}</span>` : '<span class="faint">not run</span>'; };
  const inputs = r.then.inputs;
  return `
    <div class="grid cols-2">
      <div><h3>Known at ${tf.dayTime(r.at)}</h3>${strip(r.then.hh)}<p class="faint" style="margin:6px 0 0">${inputs ? `${inputs.meterSlots} half-hours from the smart meter, ${inputs.clampSlots} from the inverter clamp · battery ${inputs.batteryKwh} kWh (${esc(inputs.batterySource || '–')})` : ''}</p></div>
      <div><h3>Now</h3>${strip(r.now.hh)}<p class="faint" style="margin:6px 0 0">Rebuilt in ${r.ms} ms with ${esc(r.method)}.</p></div>
    </div>
    ${r.then.approximations?.length ? `<div class="banner" style="margin-top:10px"><span>i</span><div>Read as first recorded, because no earlier version was kept: ${r.then.approximations.map(esc).join('; ')}.</div></div>` : ''}
    <div class="legend" style="margin:8px 0"><span><i class="swatch" style="background:var(--good)"></i>Final</span><span><i class="swatch" style="background:var(--warn)"></i>Provisional</span><span><i class="swatch" style="background:var(--bad)"></i>Missing</span><span><i class="swatch hatch"></i>Grid from the inverter clamp (plain: smart meter)</span></div>
    <div class="grid cols-2">
      <div class="table-wrap"><table><thead><tr><th></th><th class="r">Then</th><th class="r">Now</th><th></th></tr></thead><tbody>
        ${line('Final half-hours', 'slots_final')}${line('Provisional', 'slots_provisional')}${line('Missing', 'slots_missing')}
        ${line('Solar kWh', 'solar')}${line('House kWh', 'home')}${line('Import kWh', 'grid_import')}${line('Export kWh', 'grid_export')}${line('Gas kWh', 'gas')}
        ${line('Bill', 'total_cost', true)}${line('Saving', 'saving', true)}</tbody></table></div>
      <div class="table-wrap"><table><thead><tr><th>Check</th><th>Then</th><th>Now</th></tr></thead><tbody>
        ${codes.map((c) => `<tr><td>${esc(checkName(c))}</td><td>${st(r.then.checks, c)}</td><td>${st(r.now.checks, c)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
}

// ───────────── 6 Corrections and system details history ─────────────

export function correctionsCard(t, tf) {
  return card('Corrections made by EnergieBee',
    'When the core finds it stored something a provider did not send, it withdraws it (kept, marked superseded) and records why here.', t.corrections.length ? `
    <div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th class="r">Facts</th><th>Why</th></tr></thead><tbody>
      ${t.corrections.map((c) => `<tr><td>${tf.dayTime(c.corrected_at)}</td><td class="mono">${esc(c.source || '')} · ${esc(c.metric || '')}</td><td class="r">${c.rows}</td><td class="muted" style="white-space:normal">${esc(c.reason)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted" style="margin:0">None.</p>');
}

const ATTR_LABEL = { pv_kwp: 'Panel size (kWp)', pv_tilt: 'Panel tilt (°)', pv_orientation: 'Panel direction (° compass)', battery_kwh: 'Battery size (kWh)' };
export function detailHistoryHtml(t) {
  const rows = [...t.detailHistory].sort((a, b) => b.recorded_at - a.recorded_at);
  return `<details style="margin-top:12px"><summary class="muted">Every recorded value (${rows.length})</summary><div class="table-wrap"><table>
    <thead><tr><th>Detail</th><th>Source</th><th class="r">Value</th><th>Recorded</th><th>Replaced</th><th>How it was obtained</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.superseded_at ? 'superseded' : ''}"><td>${ATTR_LABEL[r.attr] || r.attr}</td><td>${esc(r.source)}</td><td class="r mono">${r.value ?? '–'}</td>
      <td class="faint">${new Date(r.recorded_at).toLocaleString('en-GB')}</td><td class="faint">${r.superseded_at ? new Date(r.superseded_at).toLocaleString('en-GB') : 'in use'}</td><td class="muted" style="white-space:normal">${esc(r.detail || '')}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

// ───────────── 7 The path of one half-hour ─────────────

export function evidenceFlow(e) {
  const r = e.row; const lin = r.lineage || {};
  const k = (v, d = 3) => (v == null ? '–' : Number(v).toFixed(d));
  const bySource = {};
  for (const f of e.facts) { const s = (bySource[f.source] ||= { current: 0, old: 0 }); if (f.superseded_at) s.old++; else s.current++; }
  const impInc = r.import_rate_ex != null ? r.import_rate_ex * (1 + (r.import_vat || 0)) : null;
  const meterUsed = lin.import === 'octopus_meter';
  const step = (n, title, body) => `<div class="path-step"><div class="path-n">${n}</div><div class="path-body"><h4>${title}</h4>${body}</div></div>`;
  const checks = (e.checks || []).map((c) => `<div class="path-check" title="${esc(c.detail || '')}"><span class="xg-key ${c.status}">${ICON[c.status]}</span>${esc(checkName(c.check_code))}</div>`).join('');
  const raws = {};
  for (const x of e.raws) (raws[x.source] ||= []).push(x);
  return `<div class="path">
    ${step('1', 'Provider responses', `${Object.keys(raws).length ? Object.entries(raws).map(([src, list]) => `<div class="path-src"><b>${esc(src)}</b> <span class="faint">${list.length > 1 ? `${list.length} responses` : new Date(list[0].fetched_at * 1000).toLocaleString('en-GB')}</span><br>${list.map((x) => `<button class="chip-btn" data-raw="${x.id}" title="Fetched ${new Date(x.fetched_at * 1000).toLocaleString('en-GB')}">#${x.id}</button>`).join(' ')}</div>`).join('') : '<span class="faint">none</span>'}<p class="faint">Kept unchanged, as received. Click one to read it.</p>`)}
    ${step('2', 'Facts', `${Object.entries(bySource).map(([s, v]) => `<div><b>${esc(s)}</b>: ${v.current} in use${v.old ? `, <span class="faint">${v.old} older version${v.old === 1 ? '' : 's'}</span>` : ''}</div>`).join('')}<p class="faint">Each value with its time, unit and source; a later version supersedes, never overwrites.</p>`)}
    ${step('3', 'Align', `5-minute power → half-hour kWh, then each day matched to the inverter's daily totals:<br><span class="mono">${lin.fit ? Object.entries(lin.fit).map(([n, x]) => `${n} ×${Number(x).toFixed(3)}`).join(' · ') : '–'}</span><br><span class="faint">inverter coverage ${lin.coverage != null ? fmt.pct(lin.coverage) : '–'}</span>`)}
    ${step('4', 'Reconcile', `Grid import <b>${k(r.grid_import)} kWh</b> from the ${meterUsed ? 'smart meter' : 'inverter clamp'}${meterUsed && lin.ct ? `<br><span class="faint">the clamp read ${k(lin.ct.imp)} kWh; the meter wins</span>` : !meterUsed ? '<br><span class="faint">meter readings not arrived yet</span>' : ''}<br>House <b>${k(r.home)} kWh</b> (inverter load)<br>Inverter used <b>${k((r.solar_to_loss || 0) + (r.battery_to_loss || 0) + (r.grid_to_loss || 0))} kWh</b>`)}
    ${step('5', 'Allocate', `<span class="mono">solar → house ${k(r.solar_to_home)}<br>battery → house ${k(r.battery_to_home)}<br>grid → house ${k(r.grid_to_home)}<br>solar → battery ${k(r.solar_to_battery)}<br>grid → battery ${k(r.grid_to_battery)}<br>exported ${k((r.solar_to_grid || 0) + (r.battery_to_grid || 0))}</span>`)}
    ${step('6', 'Price', `${esc(lin.tariff || '–')}<br>${esc(lin.register || '')} rate <b>${impInc != null ? fmt.pkwh(impInc) : 'not priced'}</b>${r.import_vat != null ? ` incl. VAT ${fmt.pct(r.import_vat)}` : ''}<br>bill <b>${fmt.gbp(r.total_cost)}</b> · grid only ${fmt.gbp(r.grid_only_cost)}`)}
    ${step('7', 'Check', `<span class="badge ${r.state === 'final' ? 'good' : r.state === 'provisional' ? 'warn' : 'bad'}">${esc(r.state)}</span><div style="margin-top:6px">${checks || '<span class="faint">day checks not run yet</span>'}</div>${e.revisions?.n ? `<br><span class="faint">${e.revisions.n} recorded version${e.revisions.n === 1 ? '' : 's'} of this day</span>` : ''}`)}
  </div>`;
}
