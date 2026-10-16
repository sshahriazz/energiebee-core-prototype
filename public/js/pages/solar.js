// Solar: what the panels made, where it went, what it was worth, and the forecast.
import { api, fmt, timeFmt, delta, COLORS } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, legend, tipHtml, hhTicks } from '../charts.js';
import { loadTimeline, isFc } from '../timeline.js';

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [summary, tl, month] = await Promise.all([
    api(`/api/sites/${id}/summary?period=${state.period}`), loadTimeline(state, { forecastHours: 30 }),
    api(`/api/sites/${id}/timeline?period=30d&step=day`),
  ]);
  const c = summary.current; const p = summary.previous; const vs = summary.previousLabel;
  const kwp = state.site.pv_kwp;
  const days = summary.days;

  const kpis = `<div class="kpis">
    ${kpi('Generated', fmt.kwh(c.solar), delta(c.solar, p.solar, { format: (v) => fmt.kwh(v), vs }), COLORS.solar)}
    ${kpi('Used in the home', fmt.pct(c.self_consumption), `${fmt.kwh(c.solar_to_home)} direct · ${fmt.kwh(c.solar_to_battery)} via battery`)}
    ${kpi('Exported', fmt.kwh(c.solar_to_grid), `${fmt.gbp(c.solar_export_value)} at ${fmt.pkwh(c.export_rate_avg)}`, COLORS.export)}
    ${kpi('Value of solar', fmt.gbp(c.solar_value), 'grid power it replaced + export credit')}
    ${kpi('Yield', kwp && c.solar != null ? `${(c.solar / kwp / days).toFixed(2)} kWh/kWp` : '–', `per day, ${kwp ?? '?'} kWp system`)}
    ${kpi('Forecast accuracy', c.forecast_accuracy != null ? fmt.pct(c.forecast_accuracy) : '–', c.solar_forecast != null ? `actual vs Quartz, ${fmt.kwh(c.solar_with_forecast)} vs ${fmt.kwh(c.solar_forecast)}` : 'builds up as forecasts are kept')}
  </div>`;

  const valueRows = `<div class="rows">
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.solar}"></i>Used straight away</span><b>${fmt.kwh(c.solar_to_home)} · ${fmt.gbp(c.solar_home_value)}</b></div>
    <div class="row sub"><span class="k">valued at the import price it replaced, half-hour by half-hour</span><span></span></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.battery}"></i>Stored for later</span><b>${fmt.kwh(c.solar_to_battery)}</b></div>
    <div class="row sub"><span class="k">enters the battery at 0p; its value shows on the battery page when it is used</span><span></span></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.export}"></i>Exported</span><b>${fmt.kwh(c.solar_to_grid)} · ${fmt.gbp(c.solar_export_value)}</b></div>
    <div class="row total"><span class="k">Value so far</span><b>${fmt.gbp(c.solar_value)}</b></div>
  </div>`;

  const multiDay = tl.step === 'hh' && new Set(tl.rows.map((r) => r.local_date)).size > 2;
  document.getElementById('content').innerHTML = `
    ${kpis}
    <div class="section">${card('Solar output and where it went', `Half-hour energy from the inverter, split by destination. Dashed: the forecast made before each half-hour happened (kept from 16 Oct onward). ${tl.nowIndex != null ? 'After “now”: the latest forecast.' : ''}`,
      `${legend([{ label: 'Used at home', color: COLORS.solar }, { label: 'Into battery', color: COLORS.battery }, { label: 'Exported', color: COLORS.export }, { label: 'Forecast', color: 'var(--text-2)', type: 'dash' }])}<div id="solar-chart"></div>`)}</div>
    <div class="section grid cols-main">
      ${card('Last 30 days', 'Daily generation and forecast', `${legend([{ label: 'Used at home', color: COLORS.solar }, { label: 'Into battery', color: COLORS.battery }, { label: 'Exported', color: COLORS.export }, { label: 'Forecast', color: 'var(--text-2)', type: 'dash' }])}<div id="month-chart"></div>`)}
      ${card('What the solar was worth', state.period === 'today' ? 'Today so far' : `${tf.date(summary.from)} – ${tf.date(summary.to)}`, valueRows)}
    </div>`;

  const ticks = tl.step === 'day' ? (r, i) => (i % 3 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null) : hhTicks(tf, multiDay);
  const head = (r) => (tl.step === 'day' ? tf.date(r.local_date) : `${tf.dayTime(r.slot_start)}${isFc(r) ? ' · forecast' : ''}`);
  timeChart(document.getElementById('solar-chart'), {
    rows: tl.rows, height: 240, unit: 'kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex,
    onPick: (r) => { if (tl.step === 'hh' && !isFc(r)) location.href = evidenceLink(state, r.slot_start); },
    pos: [
      { label: 'Used at home', color: COLORS.solar, get: (r) => r.solar_to_home },
      { label: 'Into battery', color: COLORS.battery, get: (r) => r.solar_to_battery },
      { label: 'Exported', color: COLORS.export, get: (r) => r.solar_to_grid },
    ],
    lines: [{ label: 'Forecast', color: 'var(--text-2)', get: (r) => (isFc(r) ? null : r.solar_forecast), dash: true, width: 1.5 }],
    tip: (r) => tipHtml(head(r), [
      ['Generated', COLORS.solar, fmt.kwh(r.solar, 2)],
      ['Used at home', COLORS.solar, fmt.kwh(r.solar_to_home, 2)],
      ['Into battery', COLORS.battery, fmt.kwh(r.solar_to_battery, 2)],
      ['Exported', COLORS.export, fmt.kwh(r.solar_to_grid, 2)],
      r.solar_forecast != null && !isFc(r) ? ['Forecast was', null, fmt.kwh(r.solar_forecast, 2)] : null,
      r.outdoor_temp != null ? ['Outside', null, `${r.outdoor_temp.toFixed(1)} °C`] : null,
    ]),
  });
  timeChart(document.getElementById('month-chart'), {
    rows: month.rows, height: 200, unit: 'kWh', tick: (r, i) => (i % 5 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null),
    pos: [
      { label: 'Used at home', color: COLORS.solar, get: (r) => r.solar_to_home },
      { label: 'Into battery', color: COLORS.battery, get: (r) => r.solar_to_battery },
      { label: 'Exported', color: COLORS.export, get: (r) => r.solar_to_grid },
    ],
    lines: [{ label: 'Forecast', color: 'var(--text-2)', get: (r) => r.solar_forecast, dash: true, width: 1.5 }],
    tip: (r) => tipHtml(tf.date(r.local_date), [
      ['Generated', COLORS.solar, fmt.kwh(r.solar)], ['Self-consumption', null, fmt.pct(r.self_consumption)],
      r.solar_forecast != null ? ['Forecast', null, fmt.kwh(r.solar_forecast)] : null,
      ['Slots final', null, `${r.slots_final}/${r.slots}`],
    ]),
  });
}

init({ page: 'solar', title: 'Solar', subtitle: 'Generation from the inverter, where every kWh went, what it was worth, and what the panels are expected to make next.', render });
