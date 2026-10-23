// Home: the blend of everything. Live flows now, the period's cost and saving,
// the timeline of where energy came from (with the forecast after now), prices and insights.
import { api, fmt, timeFmt, ago, delta, esc, COLORS, priceUnit, zeroPrice, slotNoun, slotNouns, slotsPerHour, originBadge } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, legend, tipHtml, hhTicks } from '../charts.js';
import { loadTimeline, isFc } from '../timeline.js';

// Live flow split, same priority rule as the build engine.
function liveFlows(l) {
  const solar = l.solar_w || 0; const load = l.load_w || 0;
  const chg = l.battery_charge_w || 0; const dis = l.battery_discharge_w || 0;
  const imp = l.grid_import_w || 0; const exp = l.grid_export_w || 0;
  return { solar, load, chg, dis, imp, exp, ev: l.ev_w || 0, soc: l.battery_soc_pct };
}

function flowSvg(f) {
  const hub = [260, 150];
  const nodes = {
    solar: { x: 260, y: 42, label: 'Solar', value: fmt.w(f.solar), color: COLORS.solar },
    grid: { x: 78, y: 150, label: f.exp > f.imp ? 'Grid · exporting' : f.imp > 0 ? 'Grid · importing' : 'Grid · idle', value: fmt.w(Math.max(f.imp, f.exp)), color: f.exp > f.imp ? COLORS.export : COLORS.grid },
    home: { x: 442, y: 150, label: 'Home', value: fmt.w(f.load), color: 'var(--text-2)' },
    battery: { x: 260, y: 258, label: `Battery${f.soc != null ? ` ${Math.round(f.soc)}%` : ''}`, value: f.chg > f.dis ? `${fmt.w(f.chg)} in` : f.dis > 0 ? `${fmt.w(f.dis)} out` : 'idle', color: COLORS.battery },
  };
  const edge = (from, to, on, color) => `<path class="edge ${on ? 'on' : 'idle'}" d="M${from[0]},${from[1]} L${to[0]},${to[1]}" ${on ? `style="stroke:${color}"` : ''}/>`;
  const at = (k, dx = 0, dy = 0) => [nodes[k].x + dx, nodes[k].y + dy];
  let edges = '';
  edges += edge(at('solar', 0, 27), hub, f.solar > 0, COLORS.solar);
  edges += f.exp > f.imp ? edge(hub, at('grid', 55, 0), f.exp > 0, COLORS.export) : edge(at('grid', 55, 0), hub, f.imp > 0, COLORS.grid);
  edges += f.chg > f.dis ? edge(hub, at('battery', 0, -27), f.chg > 0, COLORS.battery) : edge(at('battery', 0, -27), hub, f.dis > 0, COLORS.battery);
  edges += edge(hub, at('home', -55, 0), f.load > 0, 'var(--text-2)');
  let ev = '';
  if (f.ev > 0) {
    edges += edge(at('home', 0, 27), [442, 238], true, COLORS.ev);
    ev = `<g class="node"><rect x="387" y="238" width="110" height="44" rx="10" style="stroke:${COLORS.ev}"/><text x="442" y="256" text-anchor="middle" class="l">EV charging</text><text x="442" y="273" text-anchor="middle" class="v">${fmt.w(f.ev)}</text></g>`;
  }
  const node = (k) => { const n = nodes[k]; return `<g class="node"><rect x="${n.x - 55}" y="${n.y - 27}" width="110" height="54" rx="10" style="stroke:${n.color}"/><text x="${n.x}" y="${n.y - 6}" text-anchor="middle" class="l">${n.label}</text><text x="${n.x}" y="${n.y + 14}" text-anchor="middle" class="v">${n.value}</text></g>`; };
  // What goes in (solar, grid, battery) minus what comes out (home, export, charging):
  // the inverter's own conversion loss and standby draw, or a clamp that reads short.
  const gap = f.solar + f.imp + f.dis - f.load - f.exp - f.chg;
  const gapText = Math.abs(gap) >= 25
    ? `<text x="${hub[0] + 10}" y="${hub[1] + 20}" class="gap">${gap > 0 ? `≈${fmt.w(gap)} inverter loss` : `≈${fmt.w(-gap)} not measured`}</text>` : '';
  return `<div class="flow"><svg viewBox="0 0 520 300" role="img" aria-label="Live energy flows">${edges}<circle cx="${hub[0]}" cy="${hub[1]}" r="5" fill="var(--text-3)"/>${gapText}${['solar', 'grid', 'home', 'battery'].map(node).join('')}${ev}</svg></div>`;
}

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [now, summary, tl, insights] = await Promise.all([
    api(`/api/sites/${id}/now`), api(`/api/sites/${id}/summary?period=${state.period}`),
    loadTimeline(state), api(`/api/sites/${id}/insights`),
  ]);
  const fc = tl.forecast || await api(`/api/sites/${id}/forecast?hours=48`);
  const c = summary.current; const p = summary.previous;
  const live = now.live;
  const periodName = { today: 'today so far', yesterday: 'yesterday', '7d': 'over 7 days', '30d': 'over 30 days' }[state.period];

  // ── Now ──
  const flowCard = card('Right now', live ? `${live.source === 'sunsynk_live' ? 'Live inverter flow' : 'Latest 5-minute reading'} · ${ago(live.ts)}` : 'No live reading yet',
    live ? flowSvg(liveFlows(live)) : '<div class="skeleton">Waiting for the first inverter reading.</div>');
  const next = now.next.filter((x) => x.import != null);
  const ps = [now.price, ...next].map((x) => x.import ?? 0);
  const minP = Math.min(0, ...ps); const maxP = Math.max(minP + 1, ...ps);
  const barH = (v) => 20 + (((v ?? 0) - minP) / (maxP - minP)) * 80;
  const n24 = fc.next24h;
  // Low–high case after the expected value, when the forecast has one.
  const range = (lo, hi, f) => (lo != null && hi != null ? ` <span class="faint">(${f(lo)}–${f(hi)})</span>` : '');
  const kwhRange = (k) => range(n24[`${k}_low`], n24[`${k}_high`], (v) => v.toFixed(1));
  const solarSrc = { quartz: 'Quartz', sunlight: 'Open-Meteo sunlight × this home’s learned response' }[fc.model?.solar?.path];
  const priceCard = card('Price and outlook', now.price.tariff ? `<span class="mono">${esc(now.price.tariff)}</span> ${originBadge(now.price.origin)}${now.price.estimated ? ' <span class="badge warn">estimated</span>' : ''}` : 'No tariff found', `
    <div class="price-now">
      <div><div class="faint">Import now</div><div class="big">${fmt.pkwh(now.price.import)}</div></div>
      <div><div class="faint">Export now</div><div class="big">${fmt.pkwh(now.price.export)}</div></div>
      <div><div class="faint">Grid carbon</div><div class="big">${now.carbon != null ? `${now.carbon} g` : '–'}</div></div>
    </div>
    <div class="faint" style="margin-top:10px">Next 3 hours</div>
    <div class="mini-prices" title="Import price, next 3 hours">${[now.price, ...next].map((x) => `<i style="height:${barH(x.import)}%" title="${tf.time(x.slot)} ${fmt.pkwh(x.import)}"></i>`).join('')}</div>
    <h3 style="margin:16px 0 6px">Next 24 hours (forecast)</h3>
    <div class="rows">
      <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.solar}"></i>Solar expected</span><b>${fmt.kwh(n24.solar)}${kwhRange('solar')}</b></div>
      <div class="row"><span class="k">Home use expected</span><b>${fmt.kwh(n24.home)}${kwhRange('home')}</b></div>
      <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.grid}"></i>Import expected</span><b>${fmt.kwh(n24.import)}${kwhRange('import')}</b></div>
      <div class="row"><span class="k">Cost while prices are known <span class="faint">(${n24.pricedSlots / slotsPerHour()} h)</span></span><b>${fmt.gbp(n24.cost)}${range(n24.cost_low, n24.cost_high, fmt.gbp)}</b></div>
      <div class="row"><span class="k">Expected saving</span><b>${fmt.gbp(n24.saving)}</b></div>
      ${fc.cheapestWindow ? `<div class="row"><span class="k">Cheapest 2 hours</span><b>${tf.time(fc.cheapestWindow.start)}–${tf.time(fc.cheapestWindow.end)} · ${fmt.pkwh(fc.cheapestWindow.avg)}</b></div>` : ''}
    </div>
    <p class="faint" style="margin:8px 0 0;font-size:12px">Prices published until ${fc.pricesPublishedUntil ? tf.dayTime(fc.pricesPublishedUntil) : '–'}. ${solarSrc ? `Solar forecast issued ${ago(fc.solarIssuedAt)} (${solarSrc}).` : 'No solar forecast yet.'}</p>`);

  // ── KPIs ──
  const kpis = `<div class="kpis">
    ${kpi(`Cost ${periodName}`, fmt.gbp(c.total_cost), delta(c.total_cost, p.total_cost, { lowerIsBetter: true, format: (v) => fmt.gbp(v), vs: summary.previousLabel }) || 'after export credit')}
    ${kpi('Saved', fmt.gbp(c.saving), `vs ${fmt.gbp(c.grid_only_cost)} with grid only`)}
    ${kpi('Self-sufficiency', fmt.pct(c.self_sufficiency), 'home use not bought from the grid')}
    ${kpi('Solar generated', fmt.kwh(c.solar), delta(c.solar, p.solar, { format: (v) => fmt.kwh(v), vs: summary.previousLabel }), COLORS.solar)}
    ${kpi('Imported', fmt.kwh(c.grid_import), `${fmt.gbp((c.grid_to_home_cost || 0) + (c.grid_to_battery_cost || 0) + (c.loss_cost || 0))} · avg ${fmt.pkwh(c.import_rate_paid)}`, COLORS.grid)}
    ${kpi('Exported', fmt.kwh(c.grid_export), `${fmt.gbp(c.export_credit)} credit`, COLORS.export)}
    ${kpi('Cost of energy used', fmt.pkwh(c.blended_rate), `grid average ${fmt.pkwh(c.avg_import_rate)}`)}
    ${kpi('Carbon avoided', fmt.kg(c.carbon_saved_g), `${fmt.kg(c.carbon_g)} from the grid`)}
  </div>`;

  // ── Cost breakdown ──
  const costRows = `<div class="rows">
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.grid}"></i>Grid power used at home</span><b>${fmt.gbp(c.grid_to_home_cost)}</b></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.battery}"></i>Grid power stored in the battery</span><b>${fmt.gbp(c.grid_to_battery_cost)}</b></div>
    ${c.loss_cost > 0.5 ? `<div class="row"><span class="k"><i class="swatch" style="background:var(--text-3)"></i>Grid power lost in the inverter</span><b>${fmt.gbp(c.loss_cost)}</b></div>` : ''}
    <div class="row"><span class="k">Standing charges</span><b>${fmt.gbp(c.standing_cost)}</b></div>
    ${c.gas ? `<div class="row"><span class="k">Gas</span><b>${fmt.gbp(c.gas_cost)}</b></div>` : ''}
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.export}"></i>Export credit</span><b>−${fmt.gbp(c.export_credit)}</b></div>
    <div class="row total"><span class="k">Net cost</span><b>${fmt.gbp(c.total_cost)}</b></div>
    <div class="row"><span class="k">Same home on grid power only</span><b>${fmt.gbp(c.grid_only_cost)}</b></div>
    <div class="row total"><span class="k" style="color:var(--good)">Saved by solar and battery</span><b style="color:var(--good)">${fmt.gbp(c.saving)}</b></div>
  </div>
  <p class="faint" style="font-size:12px;margin:10px 0 0">Battery energy is valued first in, first out: it carries the price it was charged at (solar = ${zeroPrice()}), so nothing is counted twice.
  ${c.unpriced ? `<br><b style="color:var(--warn)">${c.unpriced} ${slotNouns()} have no price and are left out of the cost.</b>` : ''}</p>`;

  const insightHtml = insights.length ? `<div class="insights">${insights.map((i) => `<div class="insight"><span class="dot ${i.tone}">${{ good: '✓', tip: '★', info: 'i', warn: '!' }[i.tone] || 'i'}</span><div><b>${esc(i.title)}</b><p>${esc(i.detail)}</p></div></div>`).join('')}</div>` : '<div class="skeleton">Insights appear once a day of data is built.</div>';

  const multiDay = tl.step === 'hh' && new Set(tl.rows.map((r) => r.local_date)).size > 2;
  document.getElementById('content').innerHTML = `
    <div class="grid cols-main">${flowCard}${priceCard}</div>
    <div class="section">${kpis}</div>
    <div class="section">${card('Where the home’s energy came from', `Above the line: what powered the home. Below: where spare energy went. ${tl.nowIndex != null ? 'Faded bars after “now” are the forecast.' : ''} Click a bar to see its evidence. <a href="/breakdown?site=${state.siteId}&period=${state.period}">Full breakdown →</a>`,
      `${legend([{ label: 'Solar', color: COLORS.solar }, { label: 'Battery', color: COLORS.battery }, { label: 'Grid', color: COLORS.grid }, { label: 'Into battery', color: COLORS.battery, faded: true }, { label: 'Exported', color: COLORS.export }])}<div id="energy-chart"></div>`)}</div>
    ${tl.step === 'day' ? '' : `<div class="section">${card('Electricity price', 'Import and export price per kWh, including VAT. After “now”: published prices.',
      `${legend([{ label: 'Import', color: COLORS.grid, type: 'line' }, { label: 'Export', color: COLORS.export, type: 'line' }])}<div id="price-chart"></div>`)}</div>`}
    <div class="section grid cols-2">${card(`Cost ${periodName}`, `${tl.from === tl.to ? tf.date(tl.from) : `${tf.date(tl.from)} – ${tf.date(tl.to)}`}`, costRows)}${card('Insights', `Rules over the ${slotNoun()} data`, insightHtml)}</div>`;

  const ticks = tl.step === 'day' ? (r, i) => (i % Math.ceil(tl.rows.length / 10) === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null) : hhTicks(tf, multiDay);
  const head = (r) => (tl.step === 'day' ? tf.date(r.local_date) : `${tf.dayTime(r.slot_start)}${isFc(r) ? ' · forecast' : r.state !== 'final' ? ` · ${r.state}` : ''}`);
  const pick = (r) => { if (tl.step === 'hh' && !isFc(r)) location.href = evidenceLink(state, r.slot_start); };
  timeChart(document.getElementById('energy-chart'), {
    rows: tl.rows, height: 240, unit: 'kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex, onPick: pick,
    pos: [
      { label: 'Solar', color: COLORS.solar, get: (r) => r.solar_to_home },
      { label: 'Battery', color: COLORS.battery, get: (r) => r.battery_to_home },
      { label: 'Grid', color: COLORS.grid, get: (r) => r.grid_to_home },
    ],
    neg: [
      { label: 'Into battery', color: 'color-mix(in srgb, var(--battery) 45%, var(--surface))', get: (r) => (r.solar_to_battery || 0) + (r.grid_to_battery || 0) },
      { label: 'Exported', color: COLORS.export, get: (r) => r.grid_export },
    ],
    tip: (r) => tipHtml(head(r), [
      ['Home use', null, fmt.kwh(r.home, 2)],
      ['From solar', COLORS.solar, fmt.kwh(r.solar_to_home, 2)],
      ['From battery', COLORS.battery, fmt.kwh(r.battery_to_home, 2)],
      ['From grid', COLORS.grid, fmt.kwh(r.grid_to_home, 2)],
      (r.solar_to_battery || r.grid_to_battery) ? ['Into battery', COLORS.battery, fmt.kwh((r.solar_to_battery || 0) + (r.grid_to_battery || 0), 2)] : null,
      r.grid_export ? ['Exported', COLORS.export, fmt.kwh(r.grid_export, 2)] : null,
      r.ev ? ['of which EV', COLORS.ev, fmt.kwh(r.ev, 2)] : null,
      ['Cost', null, fmt.gbp(r.total_cost)], ['Saved', null, fmt.gbp(r.saving)],
    ], tl.step === 'hh' && !isFc(r) ? 'Click for evidence' : ''),
  });
  const priceRows = tl.rows;
  if (tl.step !== 'day') {
    timeChart(document.getElementById('price-chart'), {
      rows: priceRows, height: 170, unit: priceUnit(), tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex, yMin: Math.min(0, ...priceRows.map((r) => r.import_rate ?? 0)),
      lines: [
        { label: 'Import', color: COLORS.grid, get: (r) => r.import_rate, step: true },
        { label: 'Export', color: COLORS.export, get: (r) => r.export_rate, step: true },
      ],
      tip: (r) => tipHtml(head(r), [['Import', COLORS.grid, fmt.pkwh(r.import_rate)], ['Export', COLORS.export, fmt.pkwh(r.export_rate)], r.carbon_intensity != null ? ['Grid carbon', null, `${Math.round(r.carbon_intensity)} g/kWh`] : null]),
    });
  }
}

init({ page: 'index', title: 'Home energy', subtitle: 'One slot timeline for the whole home: solar, battery, grid and EV, with cost and saving on every slot.', render });
