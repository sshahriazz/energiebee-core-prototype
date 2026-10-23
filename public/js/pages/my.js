// My energy: the consumer view. Answers three questions first (how much am I
// spending, am I doing well, what should I do next) in pounds and plain English;
// kWh and charts sit underneath for anyone who wants them.
import { api, fmt, timeFmt, esc, ago, COLORS, slotsPerHour, minorSymbol } from '../api.js';
import { init } from '../layout.js';
import { timeChart, tipHtml, legend } from '../charts.js';

// Ofgem Typical Domestic Consumption Values, medium use, in force from 1 July 2026
// (Ofgem, "Review of typical domestic consumption values: decision", May 2026, Table 1).
// Electricity depends on the meter's profile class: 1 = single rate, 2 = multi-rate.
const TDCV = {
  source: 'Ofgem typical domestic consumption values (medium use), from 1 July 2026',
  url: 'https://www.ofgem.gov.uk/sites/default/files/2026-05/Review%20of%20typical%20domestic%20consumption%20values%20decision.pdf',
  electricity: { 1: 2500, 2: 3400 }, gas: 9500,
};

const localToday = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const daysInMonth = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
const pounds = (p) => fmt.gbp(p);
// Small amounts read better in pence, larger ones in pounds.
const money = (p) => (p == null ? '–' : Math.abs(p) < 100 ? fmt.p(p) : fmt.gbp(p));
const monthName = (d) => new Date(`${d}T12:00:00Z`).toLocaleString('en-GB', { month: 'long' });

function section(q, title, body, extra = '') {
  return `<section class="card my-card" ${extra}><div class="q">${q}</div><h2 class="my-h">${title}</h2>${body}</section>`;
}

async function render(state) {
  const id = state.site.id;
  const tz = state.tz;
  const tf = timeFmt(tz);
  const today = localToday(tz);
  const monthStart = `${today.slice(0, 8)}01`;
  const histFrom = addDays(today, -8);

  const [month, daysRes, hist, fc, now, cmp, insights, ev, devices] = await Promise.all([
    api(`/api/sites/${id}/summary?from=${monthStart}&to=${today}`),
    api(`/api/sites/${id}/timeline?from=${monthStart}&to=${today}&step=day`),
    api(`/api/sites/${id}/timeline?from=${histFrom}&to=${addDays(today, -1)}&step=day`),
    api(`/api/sites/${id}/forecast?hours=48`),
    api(`/api/sites/${id}/now`),
    api(`/api/sites/${id}/compare?from=${monthStart}&to=${today}`).catch(() => ({ ready: false })),
    api(`/api/sites/${id}/insights`),
    api(`/api/sites/${id}/ev?period=30d`).catch(() => ({ devices: [], sessions: [] })),
    api(`/api/sites/${id}/devices`).catch(() => []),
  ]);
  const m = month.current;
  const days = daysRes.rows;
  const full = hist.rows.filter((d) => d.local_date < today && d.total_cost != null).slice(-7);

  // ── 1. The bill: so far, and where it is heading ──
  const perDay = full.length ? full.reduce((s, d) => s + d.total_cost, 0) / full.length : null;
  const daysLeft = daysInMonth(today) - +today.slice(8, 10);
  const todaySoFar = days.find((d) => d.local_date === today)?.total_cost ?? 0;
  // Remaining days at the recent daily average; today counts as the rest of a day.
  const estimate = perDay != null ? m.total_cost + daysLeft * perDay + Math.max(0, perDay - todaySoFar) : null;
  const firstDay = days[0]?.local_date;
  const partialMonth = firstDay && firstDay > monthStart;
  const estimatedDays = days.filter((d) => d.slots_provisional > 0).map((d) => d.local_date);
  const meterUpTo = days.filter((d) => !d.slots_provisional && d.slots_final).map((d) => d.local_date).pop();
  const progress = estimate ? Math.min(100, (m.total_cost / estimate) * 100) : 0;
  const hero = `<section class="card my-hero">
    <div class="q">This month so far</div>
    <div class="my-big">${pounds(m.total_cost)}</div>
    <p class="my-lead">${estimate != null ? `On track for about <b>${pounds(estimate)}</b> in ${monthName(today)}` : 'An estimate appears after a few days of data'}${perDay != null ? `, based on your last ${full.length} days (${pounds(perDay)} a day).` : '.'}</p>
    ${estimate != null ? `<div class="my-progress" role="img" aria-label="${Math.round(progress)}% of the month's estimate so far"><i style="width:${progress}%"></i></div>
    <div class="my-progress-labels"><span>${pounds(m.total_cost)} so far</span><span>${daysLeft} day${daysLeft === 1 ? '' : 's'} to go</span></div>` : ''}
    <div class="my-split">
      <div><span class="faint">Electricity</span><b>${pounds((m.grid_to_home_cost || 0) + (m.grid_to_battery_cost || 0) + (m.loss_cost || 0))}</b></div>
      <div><span class="faint">Gas</span><b>${m.gas ? pounds(m.gas_cost) : '–'}</b></div>
      <div><span class="faint">Standing charges</span><b>${pounds(m.standing_cost)}</b></div>
      <div><span class="faint">Export earned</span><b style="color:var(--good)">−${pounds(m.export_credit)}</b></div>
    </div>
    <p class="faint my-note">Includes electricity, gas, standing charges and export payments.
      ${partialMonth ? `EnergieBee has data from ${tf.date(firstDay)}, so earlier days of ${monthName(today)} are not included.` : ''}
      ${estimatedDays.length ? `${estimatedDays.length === 1 ? tf.date(estimatedDays[0]) : `${tf.date(estimatedDays[0])} to ${tf.date(estimatedDays[estimatedDays.length - 1])}`} ${estimatedDays.length === 1 ? 'is an estimate' : 'are estimates'} from your inverter until your smart meter reports${meterUpTo ? ` (meter readings up to ${tf.date(meterUpTo)})` : ''}.` : ''}</p>
  </section>`;

  // ── 2. What to do next: today's cheap and dear times ──
  const slotS = fc.slot_s || 1800;   // the home's slot length, s (from the API)
  const ahead = fc.slots.filter((s) => s.import_rate != null).slice(0, 86400 / slotS);
  const priceNow = now.price.import;
  const prices = ahead.map((s) => s.import_rate);
  const lo = Math.min(...prices); const hi = Math.max(...prices);
  const band = (p) => (hi - lo < 0.5 ? 'mid' : p <= lo + (hi - lo) * 0.25 ? 'cheap' : p >= lo + (hi - lo) * 0.75 ? 'dear' : 'mid');
  // Blocks of the same band, so the strip reads as a few clear periods rather than 48 cells.
  const blocks = [];
  for (const s of ahead) {
    const b = band(s.import_rate);
    const last = blocks[blocks.length - 1];
    if (last && last.band === b && Math.abs(last.price - s.import_rate) < 0.01) { last.end = s.slot_start + slotS; last.n++; }
    else blocks.push({ band: b, start: s.slot_start, end: s.slot_start + slotS, price: s.import_rate, n: 1 });
  }
  const total = ahead.length || 1;
  // The cheapest period ahead: the whole run at the lowest price (e.g. 23:30-05:30 on Intelligent Octopus Go),
  // or the best two hours from the forecast when prices change every slot (Agile).
  const lowest = blocks.filter((b) => b.band === 'cheap').sort((a, b) => a.price - b.price || b.n - a.n)[0];
  const cheapest = lowest && lowest.n >= 3 ? { start: lowest.start, end: lowest.end, avg: lowest.price } : fc.cheapestWindow;
  const strip = ahead.length ? `<div class="my-strip" role="img" aria-label="Electricity price for the next ${ahead.length / slotsPerHour(slotS)} hours">
      ${blocks.map((b) => `<div class="my-block ${b.band}" style="flex:${b.n}" title="${tf.time(b.start)}–${tf.time(b.end)} · ${fmt.pkwh(b.price)}">
        ${b.n / total > 0.08 ? `<b>${fmt.p(b.price)}</b><span>${tf.time(b.start)}</span>` : ''}</div>`).join('')}
    </div>
    <div class="my-strip-key"><span><i class="cheap"></i>Cheapest</span><span><i class="mid"></i>Normal</span><span><i class="dear"></i>Most expensive</span><span class="faint">Now: ${fmt.pkwh(priceNow)}</span></div>` : '<p class="muted">Prices for the coming hours are not published yet.</p>';
  const cheapAvg = cheapest?.avg;
  // Only what the prices support: the difference per kWh moved. Appliances are not known to the core.
  const nudges = cheapest && priceNow != null && priceNow - cheapAvg > 1
    ? `<div class="my-nudges"><div class="my-nudge"><b>Every kWh moved to ${tf.time(cheapest.start)}</b><span>${fmt.pkwh(priceNow)} now → ${fmt.pkwh(cheapAvg)} then</span><em>${money(priceNow - cheapAvg)} less per kWh</em></div></div>`
    : cheapest ? `<p class="muted">The price now (${fmt.pkwh(priceNow)}) is within 1${minorSymbol()} of the cheapest in the next ${ahead.length / slotsPerHour(slotS)} hours.</p>` : '';
  const plan = section('What to do next', cheapest ? `Cheapest time next: <span class="my-hl">${tf.time(cheapest.start)}–${tf.time(cheapest.end)}</span> at ${fmt.pkwh(cheapAvg)}` : 'Electricity prices ahead',
    `${strip}${nudges}<p class="faint my-note">Prices from your tariff for the next ${ahead.length / slotsPerHour(slotS)} hours. The difference is at grid prices; when your battery is covering the house, energy is not being bought at the current price.</p>`);

  // ── 3. Solar and battery: are they paying off ──
  const free = m.home ? ((m.solar_to_home || 0) + (m.battery_to_home || 0)) / m.home : null;
  const solarBattery = section('Your solar and battery', `Saved you <span class="my-hl good">${pounds(m.saving)}</span> this month`,
    `<p class="my-lead">${free != null ? `<b>${Math.round(free * 100)}%</b> of the electricity your home used came from your panels or battery. ` : ''}
      Without them, this month would have cost ${pounds(m.grid_only_cost)}.</p>
     ${legend([{ label: 'From solar', color: COLORS.solar }, { label: 'From battery', color: COLORS.battery }, { label: 'From the grid', color: COLORS.grid }])}
     <div id="my-days"></div>`);

  // ── 4. Where the money went ──
  const parts = [
    ['Electricity used at home', (m.grid_to_home_cost || 0), COLORS.grid],
    ['Charging the battery from the grid', (m.grid_to_battery_cost || 0), COLORS.battery],
    ['Inverter running costs', (m.loss_cost || 0), 'var(--text-3)'],
    ['Gas', m.gas_cost || 0, 'var(--gas)'],
    ['Standing charges', m.standing_cost || 0, 'var(--text-2)'],
  ].filter(([, v]) => v > 0.5);
  const spend = parts.reduce((s, [, v]) => s + v, 0);
  const moneyCard = section('Where your money went', `${pounds(spend)} spent, ${pounds(m.export_credit)} earned back`,
    `<div class="mix my-mix">${parts.map(([l, v, c]) => `<i style="width:${(v / spend) * 100}%;background:${c}" title="${l} ${pounds(v)}"></i>`).join('')}</div>
     <div class="rows">${parts.map(([l, v, c]) => `<div class="row"><span class="k"><i class="swatch" style="background:${c}"></i>${l}</span><b>${pounds(v)} <span class="faint">${Math.round((v / spend) * 100)}%</span></b></div>`).join('')}
       <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.export}"></i>Paid for your exports</span><b style="color:var(--good)">−${pounds(m.export_credit)}</b></div>
       <div class="row total"><span class="k">Your bill so far</span><b>${pounds(m.total_cost)}</b></div></div>`);

  // ── 5. Tariff: one sentence ──
  // The primary alternative: Agile Octopus in GB, the first other tariff of the market elsewhere.
  const ag = cmp.ready ? cmp.scenarios.find((x) => x.key === (cmp.primaryKey || 'agile')) : null;
  const altName = ag?.key === 'agile' ? 'Agile' : ag?.name;
  const altFull = ag?.key === 'agile' ? 'Agile Octopus' : ag?.name;
  const curName = cmp.ready ? (cmp.scenarios[0].import || '').replace(/^E-1R-|-[A-P]$/g, '') : '';
  const tariff = section('Your tariff', ag ? (ag.vsCurrent > 0 ? `You're on the right tariff` : `You might pay less on ${esc(altName)}`) : 'Tariff check',
    ag ? `<p class="my-lead">This month your tariff (<span class="mono">${esc(curName)}</span>) cost <b>${pounds(cmp.scenarios[0].net)}</b> for electricity.
      With the same use, ${esc(altFull)} would have cost <b>${pounds(ag.net)}</b>: ${ag.vsCurrent > 0 ? `you're <b class="good">${pounds(ag.vsCurrent)} better off</b>, about ${pounds(ag.perYear)} a year.` : `<b>${pounds(-ag.vsCurrent)} less</b>, about ${pounds(-ag.perYear)} a year.`}</p>
      <a class="btn" href="/tariffs?site=${id}&period=30d">See the full comparison</a>`
      : '<p class="muted">The comparison appears once tariff prices are synced.</p>');

  // ── 6. Worth a look: only things with an action or a £ value ──
  const looks = [];
  const evOff = (ev.devices || []).find((d) => JSON.parse(d.attrs || '{}').status?.currentState === 'SMART_CONTROL_NOT_AVAILABLE');
  if (evOff) looks.push({ tone: 'warn', title: `Octopus reports smart control is not available for your ${esc(evOff.label)}`, body: `No smart-charge slots have been recorded${(ev.sessions || []).length ? '' : ' for it'}, so only the tariff's off-peak window is cheap.` });
  const base = full.map((d) => d.base_load_kw).filter((v) => v != null);
  const avgRate = full.length ? full.reduce((s, d) => s + (d.grid_to_home_cost || 0), 0) / Math.max(0.1, full.reduce((s, d) => s + (d.grid_to_home || 0), 0)) : null;
  if (base.length && avgRate) {
    const w = Math.min(...base) * 1000;
    looks.push({ tone: 'info', title: `About ${Math.round(w)} W is always on`, body: `Your home's lowest use overnight (01:00–05:00), measured by the inverter. Over a year that is ${Math.round((w / 1000) * 8760)} kWh, about ${pounds((w / 1000) * 8760 * avgRate)} at your average grid price over the last ${full.length} days.` });
  }
  const lossKwh = full.reduce((s, d) => s + Math.max(0, (d.solar_to_loss || 0) + (d.battery_to_loss || 0) + (d.grid_to_loss || 0)), 0);
  if (full.length >= 3 && lossKwh / full.length > 0.5) {
    looks.push({ tone: 'info', title: `Your inverter uses about ${(lossKwh / full.length).toFixed(1)} kWh a day itself`, body: 'Measured as the energy your solar, battery and grid supplied beyond what the house used, exported and stored. It is in your bill but not in your home\'s use.' });
  }
  // Data-quality notes stay on the trust pages; the hero already says which days are estimates.
  for (const i of insights.filter((x) => x.kind === 'export')) looks.push({ tone: i.tone, title: esc(i.title), body: esc(i.detail) });
  const gasDays = full.filter((d) => d.gas != null);
  if (gasDays.length >= 6) {
    const a = gasDays.slice(0, 3).reduce((s, d) => s + d.gas, 0); const b = gasDays.slice(-3).reduce((s, d) => s + d.gas, 0);
    if (a > 0 && b / a > 1.5) looks.push({ tone: 'info', title: `Gas use is up ${Math.round((b / a - 1) * 100)}% on a few days ago`, body: `${b.toFixed(0)} kWh over the last 3 days against ${a.toFixed(0)} kWh over the 3 days before, from your gas meter.` });
  }
  const look = section('Worth a look', looks.length ? `${looks.length} thing${looks.length === 1 ? '' : 's'} to check` : 'Nothing needs your attention',
    looks.length ? `<div class="insights">${looks.slice(0, 5).map((l) => `<div class="insight"><span class="dot ${l.tone}">${{ good: '✓', tip: '★', info: 'i', warn: '!' }[l.tone] || 'i'}</span><div><b>${l.title}</b><p>${l.body}</p></div></div>`).join('')}</div>` : '<p class="muted">Everything looks normal.</p>');

  // ── 7. How you compare ──
  const homeDay = full.length ? full.reduce((s, d) => s + (d.home || 0), 0) / full.length : null;
  const gasDay = gasDays.length ? gasDays.reduce((s, d) => s + d.gas, 0) / gasDays.length : null;
  const evDay = full.length ? full.reduce((s, d) => s + (d.ev || 0), 0) / full.length : 0;
  const cmpRow = (label, yours, typical, color, note) => {
    const top = Math.max(yours || 0, typical);
    return `<div class="my-cmp"><div class="my-cmp-head"><b>${label}</b><span class="faint">${note}</span></div>
      <div class="my-cmp-bar"><span>You</span><div class="hbar-track"><i style="width:${((yours || 0) / top) * 100}%;background:${color}"></i></div><b>${yours != null ? `${Math.round(yours).toLocaleString()} kWh` : '–'}</b></div>
      <div class="my-cmp-bar"><span>Typical</span><div class="hbar-track"><i style="width:${(typical / top) * 100}%;background:var(--text-3)"></i></div><b>${typical.toLocaleString()} kWh</b></div></div>`;
  };
  const importMeter = devices.find((d) => d.kind === 'meter_import');
  const pc = importMeter?.profileClass;
  const typicalElec = TDCV.electricity[pc] ?? null;
  const compare = section('How you compare', 'Your use over a year, against Ofgem\'s typical home',
    `${typicalElec ? cmpRow('Electricity', homeDay != null ? homeDay * 365 : null, typicalElec, COLORS.grid, `${pc === 2 ? 'multi-rate' : 'single-rate'} meter (profile class ${pc}, from Octopus)`) : '<p class="muted">Electricity: your meter\'s profile class is not known, so there is no matching typical figure.</p>'}
     ${gasDay != null ? cmpRow('Gas', gasDay * 365, TDCV.gas, 'var(--gas)', 'from your gas meter') : ''}
     <p class="faint my-note">Yours is your last ${full.length} days scaled to a year, so it reads high or low with the season. Typical: <a href="${TDCV.url}" target="_blank" rel="noopener">${TDCV.source}</a>.</p>`);

  // ── 8. Trust, in plain words ──
  const c = Object.fromEntries((state.site.connections || []).map((x) => [x.provider, x]));
  const freshness = [
    c.octopus && `Smart meter and prices from Octopus, ${c.octopus.status === 'error' ? 'not connected' : `checked ${ago(c.octopus.last_success_at)}`}`,
    c.sunsynk && `Solar and battery from your inverter, ${c.sunsynk.status === 'error' ? 'not connected' : `checked ${ago(c.sunsynk.last_success_at)}`}`,
    meterUpTo && `Meter readings up to ${tf.date(meterUpTo)}`,
  ].filter(Boolean);

  document.getElementById('content').innerHTML = `
    <div class="my-top">${hero}${plan}</div>
    <div class="grid cols-2 section">${solarBattery}${moneyCard}</div>
    <div class="grid cols-2 section">${look}${tariff}</div>
    <div class="section">${compare}</div>
    <p class="faint my-fresh">${freshness.map(esc).join(' · ')}</p>`;

  timeChart(document.getElementById('my-days'), {
    rows: days, height: 170, unit: 'kWh',
    tick: (r, i) => (days.length <= 10 || i % Math.ceil(days.length / 8) === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null),
    pos: [
      { label: 'From solar', color: COLORS.solar, get: (r) => r.solar_to_home },
      { label: 'From battery', color: COLORS.battery, get: (r) => r.battery_to_home },
      { label: 'From the grid', color: COLORS.grid, get: (r) => r.grid_to_home },
    ],
    tip: (r) => tipHtml(tf.date(r.local_date), [
      ['Home used', null, fmt.kwh(r.home)], ['From solar', COLORS.solar, fmt.kwh(r.solar_to_home)], ['From battery', COLORS.battery, fmt.kwh(r.battery_to_home)],
      ['From the grid', COLORS.grid, fmt.kwh(r.grid_to_home)], ['Bill', null, pounds(r.total_cost)], ['Saved', null, pounds(r.saving)],
    ], r.slots_provisional ? 'Estimate until your smart meter reports' : ''),
  });
}

init({ page: 'my', title: 'My energy', subtitle: 'Your bill, the best times to use power, and what your solar and battery are saving you.', periods: false, render });
