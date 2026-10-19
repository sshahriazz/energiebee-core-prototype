const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const number = (v, digits = 2) =>
  finite(v)
    ? v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';
const energy = (v) => (finite(v) ? `${number(v)} kWh` : 'Unavailable');
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s[0]?.toUpperCase() + s.slice(1))}</span>`;
const names = {
  solar: 'Solar generated',
  home: 'Home consumption',
  grid_import: 'Grid import',
  grid_export: 'Grid export',
  battery_charge: 'Battery charged',
  battery_discharge: 'Battery discharged',
};
const colors = { solar: '#d18c00', battery: '#13865e', grid: '#2469b5', export: '#c45225' };
const checkNames = {
  completeness: 'Grid reading coverage',
  energy_balance: 'Energy balance',
  meter_vs_ct: 'Import: meter vs inverter',
  meter_vs_ct_export: 'Export: meter vs inverter',
  counter_fit_solar: 'Solar daily counter',
  counter_fit_load: 'Home daily counter',
  counter_fit_import: 'Import daily counter',
  counter_fit_export: 'Export daily counter',
  counter_fit_charge: 'Battery charge counter',
  counter_fit_discharge: 'Battery discharge counter',
};
const sourceName = (s) =>
  ({
    sunsynk_ct: 'Inverter clamp',
    sunsynk_5min: 'Inverter samples',
    octopus_meter: 'Smart meter',
    sunsynk_live: 'Live inverter',
    sunsynk_daily: 'Inverter daily counters',
  })[s] ||
  s ||
  'Unavailable';
const metricNames = {
  solar_w: 'Solar power',
  load_w: 'Home power',
  grid_import_w: 'Import power',
  grid_export_w: 'Export power',
  battery_charge_w: 'Battery charge power',
  battery_discharge_w: 'Battery discharge power',
  battery_soc_pct: 'Battery charge level',
  solar_kwh: 'Solar energy',
  load_kwh: 'Home energy',
  grid_import_kwh: 'Imported energy',
  grid_export_kwh: 'Exported energy',
  battery_charge_kwh: 'Battery charged',
  battery_discharge_kwh: 'Battery discharged',
};
let context;
let loadVersion = 0;
let rawVersion = 0;
const view =
  location.pathname === '/how-it-works'
    ? 'guide'
    : location.pathname === '/timeline'
      ? 'timeline'
      : location.pathname === '/evidence'
        ? 'evidence'
        : 'overview';
const titles = {
  overview: 'Your day in energy',
  timeline: 'Every half-hour',
  evidence: 'Follow the evidence',
};

async function api(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The data could not be loaded.');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long to respond. Please retry.');
    if (e instanceof TypeError)
      throw new Error('The server could not be reached. Check the connection and retry.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const url = (path, date = context?.day.date, slot = null, site = context?.site.id) => {
  const q = new URLSearchParams();
  if (site) q.set('site', site);
  if (date) q.set('date', date);
  if (slot != null) q.set('slot', slot);
  return `${path}?${q}`;
};
const time = (ts) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: context.site.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ts * 1000);
const zoneTime = (ts) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: context.site.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(ts * 1000);
const longDate = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
const shortDate = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(date + 'T12:00:00Z'));
const fetchedAt = (ts) =>
  ts
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: context.site.timezone,
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(ts * 1000)
    : 'not yet recorded';

function errorView(message, title = 'We couldn’t open this record') {
  return `<section class="empty" role="alert"><h1>${title}</h1><p>${esc(message)}</p><button type="button" data-retry>Try again</button></section>`;
}
function quality(day) {
  const checked = day.checks.filter((c) => c.status !== 'skip');
  const passed = checked.filter((c) => c.status === 'pass').length;
  return `<div class="quality"><span><strong>${day.states.final}</strong> final</span><span><strong>${day.states.provisional}</strong> provisional</span><span><strong>${day.states.missing}</strong> missing</span><span>${checked.length ? `<strong>${passed}/${checked.length}</strong> energy checks pass` : 'Energy checks not yet available'}</span><a href="${url('/evidence')}#checks">Inspect the evidence →</a></div>`;
}
function notices(day) {
  let out = '';
  if (!day.closed)
    out +=
      '<div class="notice">This day is still in progress in the recorded data. Totals cover recorded half-hours so far, including the current half-hour where available.</div>';
  if (day.partialSlots)
    out += `<div class="notice">${day.partialSlots} half-hour${day.partialSlots === 1 ? ' has' : 's have'} incomplete sensor coverage. Totals sum the available readings; unavailable values stay blank. Flow allocations are withheld when a required input is missing.</div>`;
  if (day.states.provisional)
    out += `<div class="notice">${day.states.provisional} half-hours are provisional. A completed day can still be waiting for smart-meter readings.</div>`;
  const errors = day.connections.filter((c) => c.status === 'error');
  if (errors.length)
    out += `<div class="notice">Connection status in this record: ${errors.map((c) => `${c.provider === 'sunsynk' ? 'inverter' : 'smart meter'} sync failed (last success ${fetchedAt(c.last_success_at)})`).join('; ')}. The recorded day below remains available.</div>`;
  return out;
}
function statesHelp() {
  return `<div class="state-help"><div>${badge('final')}<p>The core has finalised this slot. It may still have check warnings and can change if a provider revises its readings.</p></div><div>${badge('provisional')}<p>The day is still open, or the smart-meter reading is pending. The inverter may supply a provisional grid reading.</p></div><div>${badge('missing')}<p>No usable grid-import reading is available, or the half-hour has not been built. Missing readings are not zero.</p></div></div>`;
}
function chart(rows, large = false) {
  const W = 1100,
    H = large ? 280 : 225,
    left = 46,
    right = 12,
    top = 20,
    bottom = 42,
    iw = W - left - right,
    ih = H - top - bottom;
  const max = Math.max(0.5, ...rows.map((r) => r.home ?? 0));
  const x = (i) => left + (i * iw) / rows.length;
  const bw = iw / rows.length;
  let svg = '';
  for (let n = 0; n <= 3; n++) {
    const y = top + ih - (n * ih) / 3;
    svg += `<text x="${left - 8}" y="${y + 4}" text-anchor="end">${number((max * n) / 3, 1)}</text>`;
  }
  svg += '<text x="7" y="12">kWh</text>';
  rows.forEach((r, i) => {
    const known = [r.solar_to_home, r.battery_to_home, r.grid_to_home].every(finite);
    let bars = '';
    let y = top + ih;
    if (known) {
      for (const [v, c] of [
        [r.grid_to_home, colors.grid],
        [r.battery_to_home, colors.battery],
        [r.solar_to_home, colors.solar],
      ]) {
        const h = (v / max) * ih;
        y -= h;
        bars += `<rect x="${x(i) + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${h}" fill="${c}"/>`;
      }
    } else bars += `<text x="${x(i) + bw / 2}" y="${top + ih - 6}" text-anchor="middle">×</text>`;
    const stateColor = { final: '#478955', provisional: '#b47a20', missing: '#b6554a' }[r.state] || '#b6554a';
    svg += `<a class="bar-link" href="${url('/evidence', context.day.date, r.slot_start)}" aria-label="${esc(zoneTime(r.slot_start))}: ${esc(energy(r.home))}, ${r.state}. Open evidence."><title>${esc(zoneTime(r.slot_start))} · ${esc(energy(r.home))} · ${r.state}${r.partial ? ' · partial coverage' : ''}</title>${bars}<rect x="${x(i) + 1}" y="${top + ih + 5}" width="${Math.max(1, bw - 2)}" height="5" fill="${stateColor}"/><rect class="hit" x="${x(i)}" y="0" width="${bw}" height="${H}"/></a>`;
    if (i % 6 === 0) svg += `<text x="${x(i)}" y="${H - 5}">${time(r.slot_start)}</text>`;
  });
  return `<div class="legend"><span class="solar"><i class="dot"></i>Solar → home</span><span class="battery"><i class="dot"></i>Battery → home</span><span class="grid"><i class="dot"></i>Grid → home</span><span>× Unavailable allocation</span></div><div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Home energy by half-hour. Each bar opens its evidence.">${svg}</svg></div><p class="chart-caption">Select a bar to inspect its evidence. The strip below shows final (green), provisional (amber) and missing (red) states. ${context.day.timezone}; each bar is 30 minutes. On small screens, scroll the chart horizontally.</p>`;
}
function metric(key, total) {
  const c =
    {
      solar: 'solar',
      grid_import: 'grid',
      grid_export: 'export',
      battery_charge: 'battery',
      battery_discharge: 'battery',
    }[key] || '';
  return `<div class="metric ${c}"><dl><dt><i class="dot"></i>${names[key]}</dt><dd>${number(total.value)} <small>kWh</small></dd></dl><small>${total.complete ? 'Recorded total' : `${total.knownSlots}/${context.day.rows.length} slots available · partial total`}</small></div>`;
}
function overview(day) {
  const t = day.totals;
  const supply = [
    ['solar_to_home', 'Solar', colors.solar],
    ['battery_to_home', 'Battery', colors.battery],
    ['grid_to_home', 'Grid', colors.grid],
  ];
  const supplyComplete = supply.every(([k]) => t[k].complete) && t.home.complete;
  const bars =
    supplyComplete && t.home.value > 0
      ? supply
          .map(
            ([k, label, color]) =>
              `<span style="width:${(t[k].value / t.home.value) * 100}%;background:${color}" title="${label}: ${energy(t[k].value)}"></span>`
          )
          .join('')
      : '';
  return `${notices(day)}<section class="hero panel"><div><h2>Electricity used at home</h2><div class="hero-number">${number(t.home.value, 1)} <span>kWh</span></div><p>${t.home.complete ? 'From the recorded half-hour calculations.' : `Partial total: ${t.home.knownSlots} of ${day.rows.length} slots have the inputs needed to report home use.`} Battery charging and grid exports are shown separately below.</p></div><div class="supply"><h3>Where that energy came from</h3><div class="supply-bar" role="img" aria-label="${supplyComplete ? 'Share of home energy supplied by solar, battery and grid' : 'A complete source split is unavailable'}">${bars}</div><div class="supply-list">${supply.map(([k, label, color]) => `<div><span><i class="dot" style="background:${color}"></i>${label}</span><b>${number(t[k].value, 1)} <small>kWh</small></b></div>`).join('')}</div><p style="margin-top:14px">${supplyComplete ? 'Source shares are calculated using the core’s allocation rules, rather than separately metered.' : 'Source totals cover only slots with enough inputs to calculate the allocation.'}</p></div></section>${quality(day)}<div class="metrics">${Object.keys(
    names
  )
    .map((k) => metric(k, t[k]))
    .join(
      ''
    )}</div><section class="panel"><div class="panel-head"><div><h2>A day, half-hour by half-hour</h2><p>See how solar, battery and grid power supplied the home.</p></div><a class="button" href="${url('/timeline')}">Explore the timeline →</a></div>${chart(day.rows)}</section>`;
}
const flowLabels = {
  solar_to_home: 'Solar → home',
  solar_to_battery: 'Solar → battery',
  solar_to_grid: 'Solar → grid',
  battery_to_home: 'Battery → home',
  battery_to_grid: 'Battery → grid',
  grid_to_home: 'Grid → home',
  grid_to_battery: 'Grid → battery',
  solar_to_loss: 'Solar → residual',
  battery_to_loss: 'Battery → residual',
  grid_to_loss: 'Grid → residual',
};
const fitLabels = {
  solar: 'Solar',
  load: 'Measured home load',
  imp: 'Inverter import',
  exp: 'Inverter export',
  chg: 'Battery charge',
  dis: 'Battery discharge',
};
function rowSource(r, k) {
  if (k === 'grid_import') return sourceName(r.source.import);
  if (k === 'grid_export') return sourceName(r.source.export);
  if (k === 'home') return 'Inverter load + balance limit';
  return sourceName(r.source.solar);
}
function rowExplanation(r, day) {
  const known = ['solar', 'grid_import', 'battery_discharge', 'grid_export', 'battery_charge'].every((k) =>
    finite(r[k])
  );
  const balance = known
    ? r.solar + r.grid_import + r.battery_discharge - r.grid_export - r.battery_charge
    : null;
  const flags = [
    [2, 'A fallback source was used.'],
    [16, 'The core flagged partial inverter coverage.'],
    [32, 'The input energy balance was negative by more than 0.02 kWh.'],
    [128, 'This record was revised after finalisation (energy or cost changed).'],
  ]
    .filter(([bit]) => r.quality & bit)
    .map(([, label]) => label);
  return `<details class="record-detail"><summary>Explain ${zoneTime(r.slot_start)}–${zoneTime(r.slot_start + 1800)}: calculations, coverage and evidence</summary>
  <div class="record-explanation"><div><h3>1. What was recorded?</h3><p>This interval starts at ${zoneTime(r.slot_start)} and ends just before ${zoneTime(r.slot_start + 1800)} (${esc(day.timezone)}). UTC start: ${esc(new Date(r.slot_start * 1000).toISOString())}.</p>
  <p>${r.state === 'missing' ? 'The core has no usable import reading, or this interval has not been built.' : r.state === 'provisional' ? 'The day is still open or an expected smart-meter import reading has not arrived.' : 'The day was closed and the core finalised this interval. This does not mean every quality check passed.'}</p>
  <p>${r.partial ? 'Some inputs are missing or have less than 80% coverage. Available energy can represent only part of the interval.' : 'All required inputs are present with at least 80% coverage. See each measurement’s actual percentage above.'} Coverage describes input availability, not measurement accuracy. A smart-meter interval counts as 100%; inverter coverage is the time covered by samples held forward for at most five minutes.</p>
  <p>${flags.length ? esc(flags.join(' ')) : 'No fallback, partial, suspect-balance or revision flags were stored for this row.'} Other core flags may concern costs outside this demo.</p></div>
  <div><h3>2. How was it calculated?</h3><p>Available energy = solar + import + battery discharge − export − battery charge.</p><p class="equation">${known ? `${number(r.solar, 3)} + ${number(r.grid_import, 3)} + ${number(r.battery_discharge, 3)} − ${number(r.grid_export, 3)} − ${number(r.battery_charge, 3)} = ${number(balance, 3)} kWh` : 'Cannot calculate: one or more required inputs are unavailable.'}</p>
  <p>Home use is the inverter’s measured load, capped at the non-negative available energy. Missing required inputs hide home use and dependent allocations.</p><p>Recorded loss / mismatch: <strong>${finite(r.loss) ? number(r.loss, 3) + ' kWh' : 'Unavailable'}</strong>. The core subtracts measured load from available energy. A positive value can include conversion loss or measurement differences; a negative value indicates disagreement, not energy being created. This is not a separately measured loss.</p>
  <p>Daily scaling: ${
    Object.entries(r.fit).length
      ? Object.entries(r.fit)
          .map(([k, v]) => `${esc(fitLabels[k] || k)} × ${number(v, 4)}`)
          .join('; ')
      : 'No factors recorded'
  }. A factor of 1 means unchanged. Completed-day sample totals are scaled to inverter daily counters only when the factor is greater than 0.6 and less than 1.6. These factors do not scale the selected smart-meter readings.</p></div>
  <div><h3>3. Where did the energy go?</h3><dl class="flow-list">${Object.entries(flowLabels)
    .map(
      ([k, label]) =>
        `<div><dt>${label}</dt><dd>${finite(r[k]) ? number(r[k], 3) + ' kWh' : 'Unavailable'}</dd></div>`
    )
    .join(
      ''
    )}</dl><p>These are rule-based allocations, not separately measured wires. Solar is assigned to home first, then battery and export; battery supplies remaining home/export demand, then grid supplies remaining home/charging demand. Source residuals are non-negative leftovers and need not equal the signed loss / mismatch above.</p></div>
  <div><h3>4. Can I verify it?</h3><p>Calculation method: <strong>${esc(r.method || 'Not recorded')}</strong><br>Built: ${fetchedAt(r.built_at)}<br>Battery level: ${finite(r.soc_end) ? number(r.soc_end, 1) + '% (last available reading in this interval)' : 'Unavailable'}.</p><p>Battery percentage is stored charge level, not energy used. Import/export or charging/discharging can both occur within one half-hour as direction changes.</p><p><a class="button" href="${url('/evidence', day.date, r.slot_start)}">Open original readings and version history →</a></p><p><a href="#checks">See this day’s checks</a>. Checks apply to the day; they do not certify each individual row.</p></div></div></details>`;
}
function timeline(day) {
  return `${notices(day)}${quality(day)}<section class="panel"><div class="panel-head"><div><h2>What powered the home</h2><p>${day.rows.length} half-hours shown · ${day.expectedSlots} in this local day.</p></div></div>${chart(day.rows, true)}</section>${statesHelp()}
  <section class="panel"><div class="panel-head"><div><h2>The half-hour record</h2><p>Read the quantities, their sources and their coverage together. Expand any interval for its calculation and evidence.</p></div><a href="${url('/how-it-works')}">How this works →</a></div>
  <div class="record-key"><p><strong>kWh = an amount of electricity.</strong> For example, a 1 kW appliance running for half an hour uses 0.5 kWh. Solar is all generation, home is consumption, import/export is energy entering/leaving the property, and battery charge/discharge is energy entering/leaving storage.</p><p><strong>Unavailable is not zero.</strong> 0.000 is a known value rounded to three decimal places (values below 0.0005 can round to zero). Totals use unrounded stored values. Coverage below 100% means some time is unobserved; below 80% is flagged partial. A dependent value can be unavailable even when its own sensor has coverage.</p><p>Times use ${esc(day.timezone)} with zone labels. A normal day has 48 intervals; clock-change days can have 46 or 50. This frozen demo does not fetch new readings. Scroll the table sideways on smaller screens.</p></div>
  <div class="table-wrap" role="region" aria-label="Detailed half-hour energy record" tabindex="0"><table class="record-table"><caption>Each quantity is for the stated half-hour, not a running daily total. Sources and input coverage appear below each value.</caption><thead><tr><th scope="col">Interval / state</th>${Object.values(
    names
  )
    .map((n) => `<th scope="col">${n}<br>kWh · source · coverage</th>`)
    .join('')}<th scope="col">Battery level<br>% · last reading</th></tr></thead><tbody>${day.rows
    .map(
      (r) =>
        `<tr><th scope="row"><a class="table-link" href="${url('/evidence', day.date, r.slot_start)}">${zoneTime(r.slot_start)}–<br>${zoneTime(r.slot_start + 1800)}</a><br>${badge(r.state)}${r.partial ? '<br>Partial inputs' : ''}${r.quality & 128 ? '<br>Revised' : ''}</th>${Object.keys(
          names
        )
          .map(
            (k) =>
              `<td><strong>${finite(r[k]) ? number(r[k], 3) : 'Unavailable'}</strong><small>${esc(rowSource(r, k))}<br>${number(r.coverage[k] * 100, 0)}% input coverage</small></td>`
          )
          .join(
            ''
          )}<td>${finite(r.soc_end) ? number(r.soc_end, 1) + '%' : 'Unavailable'}</td></tr><tr class="detail-row"><td colspan="8">${rowExplanation(r, day)}</td></tr>`
    )
    .join('')}</tbody><tfoot><tr><th scope="row">Known day totals</th>${Object.keys(names)
    .map(
      (k) =>
        `<td><strong>${finite(day.totals[k].value) ? number(day.totals[k].value, 3) + ' kWh' : 'Unavailable'}</strong><small>${day.totals[k].knownSlots}/${day.rows.length} intervals with values${day.totals[k].complete ? '' : ' · incomplete coverage'}</small></td>`
    )
    .join('')}<td>Not additive</td></tr></tfoot></table></div></section>${checks(day)}`;
}
function guide() {
  const query = new URLSearchParams(location.search);
  const link = (path) => esc(url(path, query.get('date'), null, query.get('site')));
  return `<div class="page-head"><div><h1>A notebook and a calculator for your home</h1><p>What this demo does, in everyday language.</p></div></div>
  <section class="panel"><h2>Imagine keeping a little electricity notebook</h2><p>Your solar panels make electricity. Your home uses it. Your battery saves some for later. The grid supplies more when needed and receives electricity you send out.</p><p>The inverter and smart meter are two reporters. They tell us what happened. EnergieBee keeps their original notes, puts them into matching half-hour pages, and uses a calculator to explain the results. If a reporter corrects a number, we keep the old note too.</p><p><strong>This demo is a saved copy of that notebook.</strong> It shows recorded electricity for one home. It does not control devices or update live.</p></section>
  <section class="panel"><h2>Three ways to read the same story</h2><div class="steps"><article><h3>1. Overview</h3><p>“What happened today?” See the day’s electricity totals and what supplied the home.</p><a href="${link('/')}">Open the overview →</a></article><article><h3>2. Timeline</h3><p>“When did it happen?” Read each half-hour, its sources, coverage and calculation.</p><a href="${link('/timeline')}">Open the timeline →</a></article><article><h3>3. Evidence</h3><p>“Where did that number come from?” Inspect original provider responses, readings, revisions and daily checks.</p><a href="${link('/evidence')}">Open the evidence →</a></article></div></section>
  <section class="panel"><h2>What the software actually does</h2><ol class="process-list"><li><strong>Collect the reporters’ notes.</strong> The full system receives Sunsynk inverter power samples, battery levels and daily counters, plus Octopus smart-meter electricity readings. The demo uses a saved database snapshot of those records.</li><li><strong>Keep the originals.</strong> Provider responses are saved as raw JSON. Readings point back to these responses. Changed readings get new versions; previous versions remain in the history.</li><li><strong>Put readings on the same clock.</strong> Five-minute power samples become half-hour energy amounts. Power means how fast electricity flows; energy means how much flowed over time. Internally intervals use UTC; screens show the home’s local time.</li><li><strong>Choose and reconcile the inputs.</strong> Smart-meter readings take priority for grid import and export. Inverter clamp readings can fill gaps. Completed-day inverter totals can scale the sample-based values, within guarded limits. Missing inputs remain unknown.</li><li><strong>Calculate a consistent picture.</strong> Home consumption uses measured load, limited by the available energy balance. Rules allocate solar to the home first, then battery and export. Battery and grid cover remaining flows. These are calculated shares, not measurements of individual appliances.</li><li><strong>Check and explain.</strong> The core checks coverage, energy balance, meter versus inverter and daily counters. The screens show the same stored half-hours, with their state and evidence. Final means finalised by the core; it is not a promise that every check passed.</li></ol></section>
  <section class="panel"><h2>A small example</h2><p><strong>Illustration only — not a reading from this home.</strong> Between 12:00 and 12:30, imagine solar supplies 1 kWh, the battery supplies 0.5 kWh, and the grid supplies 0.5 kWh. With no export, charging or losses, 2 kWh is available for the home.</p><p class="equation">1 solar + 0.5 battery + 0.5 grid = 2 kWh for the home</p><p>Real readings are less tidy. They can arrive late, cover only part of the interval, or disagree. The demo shows those gaps and checks instead of pretending every number is perfect.</p></section>${statesHelp()}
  <section class="panel"><h2>What this demonstration covers</h2><p>Recorded electricity, solar, battery, grid exchange, half-hour calculations, data quality and traceable evidence for one home.</p><p>It does not demonstrate forecasts, bills or savings, appliance-level EV or heat-pump measurements, device control, thermal / HEM calculations, commercial-site workflows, French provider support or a multi-site network. Those capabilities need their own integrations and validation; this demo does not establish that they are complete.</p><a class="button primary" href="${link('/timeline')}">Walk through a recorded day →</a></section>`;
}
function checks(day) {
  return `<section class="panel" id="checks"><div class="panel-head"><div><h2>Energy checks for this day</h2><p>Finality and quality are separate. A final half-hour can still belong to a day with a warning.</p></div></div>${day.checks.length ? day.checks.map((c) => `<div class="check"><div><h3>${esc(checkNames[c.check_code] || c.check_code)}</h3><p>${esc(c.detail)}</p></div><span class="badge ${esc(c.status)}">${{ pass: 'Pass', warn: 'Warning', fail: 'Failed', skip: 'Not assessed' }[c.status] || esc(c.status)}</span></div>`).join('') : '<p class="muted">No completed-day energy checks are available yet.</p>'}</section>`;
}
function evidenceShell(day) {
  return `${notices(day)}<div class="evidence-picker"><label for="slot">Half-hour to inspect</label><select id="slot">${day.rows.map((r) => `<option value="${r.slot_start}">${zoneTime(r.slot_start)}–${zoneTime(r.slot_start + 1800)} · ${r.state}</option>`).join('')}</select><a class="inline-link" href="${url('/timeline')}">Back to the timeline</a></div><div id="slot-content" aria-live="polite" aria-busy="true"><div class="loading">Loading the readings behind this half-hour…</div></div>${checks(day)}${statesHelp()}`;
}
function evidenceContent(row, e) {
  const facts = e.facts.filter((f) => metricNames[f.metric]);
  const ids = new Set(facts.map((f) => f.raw_id).filter(Boolean));
  const raws = e.raws.filter((r) => ids.has(r.id));
  const currentIds = new Set(facts.filter((f) => !f.superseded_at).map((f) => f.raw_id));
  const currentRaws = raws.filter((r) => currentIds.has(r.id));
  const earlierRaws = raws.filter((r) => !currentIds.has(r.id));
  const rawButtons = (items) =>
    items
      .map(
        (r) =>
          `<button type="button" data-raw="${r.id}" data-source="${esc(r.source)}">${esc(sourceName(r.source))} #${r.id}</button>`
      )
      .join('');
  const allocations = [
    ['solar_to_home', 'Solar → home'],
    ['solar_to_battery', 'Solar → battery'],
    ['solar_to_grid', 'Solar → grid'],
    ['battery_to_home', 'Battery → home'],
    ['battery_to_grid', 'Battery → grid'],
    ['grid_to_home', 'Grid → home'],
    ['grid_to_battery', 'Grid → battery'],
    ['solar_to_loss', 'Solar → inverter loss'],
    ['battery_to_loss', 'Battery → inverter loss'],
    ['grid_to_loss', 'Grid → inverter loss'],
  ];
  return `<section class="panel"><div class="panel-head"><div><h2>${zoneTime(row.slot_start)}–${zoneTime(row.slot_start + 1800)}</h2><p>${longDate(context.day.date)} · Built ${fetchedAt(row.built_at)}${row.quality & 128 ? ' · Revised since first finalised' : ''}</p></div>${badge(row.state)}</div><div class="steps"><article><h3>Read the sources</h3><p>Grid import: <strong>${esc(sourceName(row.source.import))}</strong>.<br>Grid export: <strong>${esc(sourceName(row.source.export))}</strong>.<br>Solar and battery use the inverter samples where available.</p></article><article><h3>Align and reconcile</h3><p>Power samples are integrated into 30-minute energy and fitted to the inverter’s daily counters. Smart-meter readings take priority over the inverter clamp.</p></article><article><h3>Allocate and check</h3><p>Solar supplies home use first, then charging and export. Battery and grid cover the remaining flows. The daily checks below test the result.</p></article></div><div class="table-wrap"><table><thead><tr><th scope="col">Energy reading</th><th scope="col" class="num">kWh</th><th scope="col">Input coverage</th></tr></thead><tbody>${Object.keys(
    names
  )
    .map(
      (k) =>
        `<tr><td>${names[k]}</td><td class="num">${number(row[k], 3)}</td><td>${row[k] == null ? 'Unavailable' : `${number(row.coverage[k] * 100, 0)}%${row.coverage[k] < 0.8 ? ' · partial' : ''}`}</td></tr>`
    )
    .join(
      ''
    )}</tbody></table></div><p class="footer-note">Home consumption is derived from measured load, limited by the energy balance. Unavailable inputs prevent dependent allocations from being shown. Charge level: ${finite(row.soc_end) ? number(row.soc_end, 0) + '%' : 'unavailable'}.</p></section><div class="two-col"><section class="panel"><div class="panel-head"><div><h2>Where the energy went</h2><p>Calculated allocations, in kWh.</p></div></div><table><thead><tr><th scope="col">Flow</th><th scope="col" class="num">kWh</th></tr></thead><tbody>${allocations.map(([k, label]) => `<tr><td>${label}</td><td class="num">${number(row[k], 3)}</td></tr>`).join('')}</tbody></table></section><section class="panel"><div class="panel-head"><div><h2>Provider evidence</h2><p>Open the original stored responses behind the readings listed below.</p></div></div>${raws.length ? `<div class="source-list">${rawButtons(currentRaws)}</div>${earlierRaws.length ? `<details><summary>Earlier responses (${earlierRaws.length})</summary><div class="source-list">${rawButtons(earlierRaws)}</div></details>` : ''}` : '<p>No raw responses are linked to these energy readings.</p>'}<p class="footer-note">Responses may include other readings from the same provider request. They are shown as received; the fact history below includes current and superseded versions.</p><details><summary>Calculation details</summary><p class="muted">Method: ${esc(row.method)}. Daily counter-fit factors:</p><table><tbody>${Object.entries(
    row.fit
  )
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="num">${number(v, 3)}</td></tr>`)
    .join(
      ''
    )}</tbody></table></details></section></div><details class="panel" style="margin-top:22px"><summary>Source readings and versions (${facts.length})</summary><div class="panel-head"><div><p>${facts.length} nearby readings and daily counters used for context and scaling. Crossed-out rows were superseded; they remain in the history. Power is measured in W, energy in kWh.</p></div></div><div class="table-wrap"><table><thead><tr><th scope="col">Measurement</th><th scope="col">Source</th><th scope="col">Time</th><th scope="col" class="num">Value</th><th scope="col">Version</th></tr></thead><tbody>${facts.map((f) => `<tr class="${f.superseded_at ? 'superseded' : ''}"><td>${metricNames[f.metric]}</td><td>${esc(sourceName(f.source))}</td><td>${f.end_ts && f.end_ts - f.start_ts > 7200 ? 'Daily counter' : zoneTime(f.start_ts)}</td><td class="num">${number(f.value, 3)} ${esc(f.unit)}</td><td>${f.superseded_at ? 'Superseded' : 'Current'}<br><small>Recorded ${fetchedAt(f.recorded_at / 1000)}</small></td></tr>`).join('')}</tbody></table></div></details>`;
}
let slotVersion = 0;
async function openSlot(slot) {
  const version = ++slotVersion;
  const row = context.day.rows.find((r) => r.slot_start === slot);
  if (!row) return;
  $('#slot').value = String(slot);
  history.replaceState(null, '', url('/evidence', context.day.date, slot));
  $('#slot-content').setAttribute('aria-busy', 'true');
  $('#slot-content').innerHTML =
    '<div class="loading" role="status">Loading the readings behind this half-hour…</div>';
  try {
    if (!row.built_at) {
      $('#slot-content').innerHTML =
        '<div class="notice">This half-hour has not been built yet. There is no calculation or linked evidence to inspect.</div>';
      return;
    }
    const e = await api(`/api/sites/${context.site.id}/evidence?slot=${slot}`);
    if (version !== slotVersion) return;
    $('#slot-content').innerHTML = evidenceContent(row, e);
  } catch (e) {
    if (version === slotVersion)
      $('#slot-content').innerHTML =
        `<div class="notice error" role="alert"><p>${esc(e.message)}</p><button type="button" data-retry-slot="${slot}">Retry evidence</button></div>`;
  } finally {
    if (version === slotVersion) $('#slot-content').setAttribute('aria-busy', 'false');
  }
}
async function openRaw(id, source) {
  const version = ++rawVersion;
  $('#raw-title').textContent = `${sourceName(source)} · response #${id}`;
  $('#raw-body').innerHTML = '<p role="status">Loading the stored response…</p>';
  if (!$('#raw-dialog').open) $('#raw-dialog').showModal();
  try {
    const r = await api(`/api/raw/${id}`);
    if (version !== rawVersion) return;
    let body = r.body;
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
    $('#raw-body').innerHTML =
      `<p>Received ${esc(fetchedAt(r.fetched_at))} · ${esc(r.status)}${r.size > 200000 ? ' · Preview limited to the first 200,000 characters' : ''}</p><pre>${esc(body)}</pre>`;
  } catch (e) {
    if (version === rawVersion)
      $('#raw-body').innerHTML =
        `<div class="notice error" role="alert"><p>${esc(e.message)}</p><button type="button" data-raw="${id}" data-source="${esc(source)}">Retry response</button></div>`;
  }
}
function shell(sites, metadata, date) {
  const site = metadata.site;
  const dateIndex = metadata.days.findIndex((d) => d.local_date === date);
  const older = metadata.days[dateIndex + 1]?.local_date,
    newer = metadata.days[dateIndex - 1]?.local_date;
  const path = location.pathname;
  $('#nav').innerHTML = [
    ['/', 'Overview', 'overview'],
    ['/timeline', 'Timeline', 'timeline'],
    ['/evidence', 'Evidence', 'evidence'],
    ['/how-it-works', 'How it works', 'guide'],
  ]
    .map(
      ([href, label, key]) =>
        `<a href="${url(href, date, null, site.id)}" ${key === view ? 'aria-current="page"' : ''}>${label}</a>`
    )
    .join('');
  $('.brand').href = url('/', date, null, site.id);
  $('#controls').innerHTML =
    `<div class="controls"><div class="field"><label for="home">Home</label><select id="home">${sites.map((s) => `<option value="${s.id}" ${s.id === site.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label for="date">Recorded day</label><div class="date-controls">${older ? `<a class="button" aria-label="Previous recorded day" href="${url(path, older, null, site.id)}">←</a>` : '<button disabled aria-label="No earlier recorded day">←</button>'}<select id="date">${metadata.days.map((d) => `<option value="${d.local_date}" ${d.local_date === date ? 'selected' : ''}>${shortDate(d.local_date)}${d.slots_final === d.expectedSlots ? ' · final' : ''}</option>`).join('')}</select>${newer ? `<a class="button" aria-label="Next recorded day" href="${url(path, newer, null, site.id)}">→</a>` : '<button disabled aria-label="No later recorded day">→</button>'}</div></div><p class="context">Historical electricity record<br>Times shown in ${esc(site.timezone)}${metadata.capturedAt ? `<br>Snapshot: ${new Intl.DateTimeFormat('en-GB', { timeZone: site.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(metadata.capturedAt * 1000)}` : ''}</p></div>`;
  $('#home').addEventListener('change', (e) => location.assign(url(path, null, null, e.target.value)));
  $('#date').addEventListener('change', (e) => location.assign(url(path, e.target.value, null, site.id)));
}
async function load() {
  const version = ++loadVersion;
  $('#content').setAttribute('aria-busy', 'true');
  $('#content').innerHTML = '<div class="loading" role="status">Loading the recorded energy…</div>';
  try {
    const query = new URLSearchParams(location.search);
    if (view === 'guide') {
      document.title = 'How it works · EnergieBee';
      $('#controls').innerHTML = '';
      $('#nav')
        .querySelectorAll('a')
        .forEach((a) => {
          const path = new URL(a.href).pathname;
          a.href = url(path, query.get('date'), null, query.get('site'));
          if (path === '/how-it-works') a.setAttribute('aria-current', 'page');
        });
      $('#content').innerHTML = guide();
      return;
    }
    const sites = await api('/api/sites');
    if (!sites.length) {
      $('#content').innerHTML =
        '<section class="empty"><h1>No home connected yet</h1><p>There is no recorded energy to show. Connect a home and complete its first sync, then reload this view.</p><button type="button" data-retry>Check again</button></section>';
      return;
    }
    const site = sites.find((s) => s.id === Number(query.get('site'))) || sites[0];
    const metadata = await api(`/api/demo/sites/${site.id}/days`);
    if (!metadata.days.length) {
      $('#content').innerHTML =
        '<section class="empty"><h1>No recorded days yet</h1><p>The home is connected, but its first half-hour record is not ready. Please check again after the first sync.</p><button type="button" data-retry>Check again</button></section>';
      return;
    }
    const requested = query.get('date');
    const date = metadata.days.some((d) => d.local_date === requested) ? requested : metadata.defaultDate;
    shell(sites, metadata, date);
    const day = await api(`/api/demo/sites/${site.id}/day?date=${date}`);
    if (version !== loadVersion) return;
    context = { site: metadata.site, day };
    const slot = query.get('slot');
    history.replaceState(null, '', url(location.pathname, date, view === 'evidence' && slot ? slot : null));
    document.title = `${titles[view]} · EnergieBee`;
    const head = `<div class="page-head"><div><h1>${titles[view]}</h1><p>${esc(site.name)} · ${longDate(date)}</p></div>${view === 'overview' ? `<a class="button primary" href="${url('/timeline')}">Explore this day →</a>` : ''}</div>`;
    const dateNotice =
      requested && requested !== date
        ? '<div class="notice" role="status">The requested date has no recorded data. Showing the default recorded day instead.</div>'
        : '';
    $('#content').innerHTML =
      head +
      dateNotice +
      (view === 'overview' ? overview(day) : view === 'timeline' ? timeline(day) : evidenceShell(day));
    if (view === 'evidence') {
      const selected =
        day.rows.find((r) => r.slot_start === Number(slot)) ||
        day.rows.find((r) => r.home > 0 && r.built_at) ||
        day.rows[0];
      if (slot && !day.rows.some((r) => r.slot_start === Number(slot)))
        $('#slot-content').insertAdjacentHTML(
          'beforebegin',
          '<div class="notice">The requested half-hour is not in this day. Showing the first available half-hour.</div>'
        );
      $('#slot').addEventListener('change', (e) => openSlot(Number(e.target.value)));
      if (selected) await openSlot(selected.slot_start);
    }
    if (location.hash === '#checks') $('#checks')?.scrollIntoView();
  } catch (e) {
    if (version === loadVersion) $('#content').innerHTML = errorView(e.message);
  } finally {
    if (version === loadVersion) $('#content').setAttribute('aria-busy', 'false');
  }
}
document.addEventListener('click', (e) => {
  const raw = e.target.closest('[data-raw]');
  if (raw) openRaw(Number(raw.dataset.raw), raw.dataset.source);
  const retry = e.target.closest('[data-retry]');
  if (retry) load();
  const slot = e.target.closest('[data-retry-slot]');
  if (slot) openSlot(Number(slot.dataset.retrySlot));
});
$('#close-dialog').addEventListener('click', () => $('#raw-dialog').close());
$('#raw-dialog').addEventListener('close', () => {
  rawVersion++;
});
load();
