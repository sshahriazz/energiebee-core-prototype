// Solar: what the panels made, where it went, what it was worth, and the forecast. Actual
// output is set against two yardsticks on one axis: the forecast made before each half-hour,
// and what the weather that actually happened should have given (an expectation, labelled so).
import { api, fmt, timeFmt, delta, COLORS } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, legend, tipHtml } from '../charts.js';
import { isFc } from '../timeline.js';

const FORECAST_HOURS = 30;
const ADVANCE = 'var(--text-2)';     // forecast made in advance: dashed
const EXPECTED = 'var(--text)';      // expected for the weather: solid
const RANGE = 'var(--text-2)';       // forecast's 10th–90th percentile band

// The latest forecast after the last built half-hour, so every view that includes today runs
// past, now and ahead on one axis (loadTimeline adds it to "Today" only). Split as timeline.js does.
function withForecast(t, fc) {
  if (!fc) return { rows: t.rows, nowIndex: null };
  const last = t.rows.length ? t.rows[t.rows.length - 1].slot_start : 0;
  const now = Date.now() / 1000;
  const ahead = fc.slots.filter((s) => s.slot_start > last && s.slot_start < now + FORECAST_HOURS * 3600).map((s) => ({
    slot_start: s.slot_start, local_date: s.local_date, _fc: true, solar: s.solar, solar_low: s.solar_low, solar_high: s.solar_high,
    solar_to_home: s.solar != null && s.home != null ? Math.min(s.solar, s.home) : null, solar_to_battery: s.solar_to_battery ?? null, solar_to_grid: s.grid_export,
  }));
  return { rows: t.rows.concat(ahead), nowIndex: t.rows.length + Math.min(1, Math.max(0, (now - (ahead[0]?.slot_start ?? now)) / 1800)) };
}

const BARS = [
  { label: 'Used at home', color: COLORS.solar, get: (r) => r.solar_to_home },
  { label: 'Into battery', color: COLORS.battery, get: (r) => r.solar_to_battery },
  { label: 'Exported', color: COLORS.export, get: (r) => r.solar_to_grid },
];
const LEGEND = [
  ...BARS.map((b) => ({ label: b.label, color: b.color })),
  { label: 'Forecast made in advance', color: ADVANCE, type: 'dash' },
  { label: 'Expected for the weather', color: EXPECTED, type: 'line' },
];

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const withToday = state.period !== 'yesterday';
  // Expected values need the solar-expected endpoint; without it the page still shows the rest.
  const optional = (p) => p.catch(() => null);
  const [summary, t, month, sys, ex, exMonth, fc] = await Promise.all([
    api(`/api/sites/${id}/summary?period=${state.period}`),
    // Half-hours in every view (30 days too), so all four series share one axis.
    api(`/api/sites/${id}/timeline?period=${state.period}&step=hh`),
    api(`/api/sites/${id}/timeline?period=30d&step=day`),
    optional(api(`/api/sites/${id}/system`)),
    optional(api(`/api/sites/${id}/solar-expected?period=${state.period}`)),
    state.period === '30d' ? null : optional(api(`/api/sites/${id}/solar-expected?period=30d`)),
    withToday ? optional(api(`/api/sites/${id}/forecast?hours=48`)) : null,
  ]);
  const exm = state.period === '30d' ? ex : exMonth;
  const unconfirmed = (sys?.items || []).filter((i) => i.key.startsWith('PV_') && i.status !== 'installer');
  const c = summary.current; const p = summary.previous; const vs = summary.previousLabel;
  const kwp = state.site.pv_kwp;
  const yieldText = kwp && c.solar != null ? `${(c.solar / kwp / summary.days).toFixed(2)} kWh/kWp a day` : '';
  const et = ex?.totals;
  const wd = et?.wholeDays;
  const pctRange = wd?.days > 1 ? ` · whole days ${fmt.pct(wd.low)}–${fmt.pct(wd.high)}` : '';

  const kpis = `<div class="kpis">
    ${kpi('Generated', fmt.kwh(c.solar), [yieldText, delta(c.solar, p.solar, { format: (v) => fmt.kwh(v), vs })].filter(Boolean).join(' · '), COLORS.solar)}
    ${kpi('Used in the home', fmt.pct(c.self_consumption), `${fmt.kwh(c.solar_to_home)} direct · ${fmt.kwh(c.solar_to_battery)} via battery`)}
    ${kpi('Exported', fmt.kwh(c.solar_to_grid), `${fmt.gbp(c.solar_export_value)} at ${fmt.pkwh(c.export_rate_avg)}`, COLORS.export)}
    ${kpi('Value of solar', fmt.gbp(c.solar_value), 'grid power it replaced + export credit')}
    ${kpi('Made vs the weather', fmt.pct(et?.performance), et?.performance != null
      ? `the panels made ${fmt.pct(et.performance)} of what the weather allowed: ${fmt.kwh(et.actual)} of ${fmt.kwh(et.expected)} expected${pctRange}`
      : ex ? 'no half-hours with both sunlight data and output yet' : 'expected values not available from the server')}
    ${kpi('Made vs forecast in advance', fmt.pct(c.forecast_accuracy), c.solar_forecast != null
      ? `${fmt.kwh(c.solar_with_forecast)} made vs ${fmt.kwh(c.solar_forecast)} forecast before each half-hour (100% = exact)`
      : 'forecasts are kept from 16 Oct 2026; none for this period')}
  </div>`;

  const valueRows = `<div class="rows">
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.solar}"></i>Used straight away</span><b>${fmt.kwh(c.solar_to_home)} · ${fmt.gbp(c.solar_home_value)}</b></div>
    <div class="row sub"><span class="k">valued at the import price it replaced, half-hour by half-hour</span><span></span></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.battery}"></i>Stored for later</span><b>${fmt.kwh(c.solar_to_battery)}</b></div>
    <div class="row sub"><span class="k">enters the battery at 0p; its value shows on the battery page when it is used</span><span></span></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.export}"></i>Exported</span><b>${fmt.kwh(c.solar_to_grid)} · ${fmt.gbp(c.solar_export_value)}</b></div>
    <div class="row total"><span class="k">Value so far</span><b>${fmt.gbp(c.solar_value)}</b></div>
  </div>`;

  const { rows, nowIndex } = withForecast(t, fc);
  const fitDays = ex?.method?.window?.days ?? 30;
  // How each series is made, one line each, so an expectation is never read as a measurement.
  const key = [
    [BARS.map((b) => `<i class="swatch" style="background:${b.color}"></i>`).join(''), 'Actual', 'Measured by the inverter (Sunsynk) each half-hour, split by where it went. Click a bar for its evidence.'],
    [`<i class="dash" style="color:${ADVANCE}"></i>`, 'Forecast made in advance', 'The latest solar forecast issued before each half-hour started (Quartz\'s where one was held, otherwise this core\'s own). Kept from 16 Oct 2026, so there is no line before then.'],
    [`<i class="line" style="color:${EXPECTED}"></i>`, 'Expected for the weather', `An expectation, not a measurement: Open-Meteo's recorded sunlight for that hour × what these panels made per unit of sunlight at the same hour on the other days of the last ${fitDays} (the day itself left out). No sunlight data, no line.`],
    ...(nowIndex != null ? [[`<i class="swatch" style="background:${COLORS.solar};opacity:.45"></i><i class="swatch" style="background:${RANGE};opacity:.35"></i>`, 'After “now”', 'The latest forecast, split as it expects the solar to be used; the grey band is its 10th–90th percentile range.']] : []),
  ];

  document.getElementById('content').innerHTML = `
    ${unconfirmed.length ? `<div class="banner warn"><span>i</span><div>${unconfirmed.map((i) => `${i.label}: <b>${i.value ?? '–'} ${i.unit}</b> (${i.status === 'estimated' ? 'estimated from this home\'s output' : i.status === 'provider' ? 'from Sunsynk' : 'not known'})`).join(' · ')}.
      These shape the solar forecast. <a href="/data?site=${id}#system">How to replace them with the installer's figures (MCS paperwork) →</a></div></div>` : ''}
    ${kpis}
    <div class="section">${card('Solar output against forecast and weather', `Each half-hour on one axis: what the panels made, what was forecast before it, and what the weather that happened should have given.${nowIndex != null ? ' After “now”: the latest forecast with its range.' : ''}`,
      `${legend([...LEGEND, ...(nowIndex != null ? [{ label: 'Forecast range (10th–90th percentile)', color: RANGE, faded: true }] : [])])}<div id="solar-chart"></div>
      <div class="state-notes"><h3>How each series is made</h3><dl>${key.map(([sw, k, text]) => `<dt>${sw}${k}</dt><dd>${text}</dd>`).join('')}</dl></div>`)}</div>
    <div class="section grid cols-main">
      ${card('Last 30 days', 'Daily totals of the same series. A day\'s forecast point is drawn only when every half-hour of it had a forecast made in advance.',
        `${legend(LEGEND)}<div id="month-chart"></div>
        <h3 style="margin:14px 0 2px">Made vs what the weather allowed</h3>
        <p class="faint" style="margin:0 0 6px;font-size:12.5px">Each day's output ÷ its expected output for the weather, over the half-hours that have both. Above the line: more than expected.</p>
        <div id="perf-chart"></div>`)}
      ${card('What the solar was worth', state.period === 'today' ? 'Today so far' : `${tf.date(summary.from)} – ${tf.date(summary.to)}`, valueRows)}
    </div>`;

  // Half-hour chart: the day at midnight; on short views, every three hours as well.
  const days = new Set(rows.map((r) => r.local_date)).size;
  const everyDays = days > 10 ? 3 : 1;
  const dayNo = new Map([...new Set(rows.map((r) => r.local_date))].map((d, i) => [d, i]));
  const tick = (r) => {
    const { h, m } = tf.hm(r.slot_start);
    if (m !== 0) return null;
    if (h === 0) return dayNo.get(r.local_date) % everyDays === 0 ? (days > 10 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : tf.day(r.slot_start).split(' ').slice(0, 2).join(' ')) : null;
    return days <= 3 && h % 3 === 0 ? `${String(h).padStart(2, '0')}:00` : null;
  };
  const exBy = new Map((ex?.slots || []).map((s) => [s.slot_start, s]));
  const expOf = (r) => (isFc(r) ? null : exBy.get(r.slot_start)?.expected ?? null);
  timeChart(document.getElementById('solar-chart'), {
    rows, height: 260, unit: 'kWh', tick, isForecast: isFc, nowIndex,
    onPick: (r) => { if (!isFc(r)) location.href = evidenceLink(state, r.slot_start); },
    pos: BARS,
    bands: [{ color: RANGE, lo: (r) => (isFc(r) ? r.solar_low : null), hi: (r) => (isFc(r) ? r.solar_high : null), opacity: 0.16 }],
    lines: [
      { label: 'Forecast made in advance', color: ADVANCE, get: (r) => (isFc(r) ? null : r.solar_forecast), dash: true, width: 1.5 },
      { label: 'Expected for the weather', color: EXPECTED, get: expOf, width: 1.25 },
    ],
    tip: (r) => {
      if (isFc(r)) {
        return tipHtml(`${tf.dayTime(r.slot_start)} · forecast`, [
          ['Forecast', COLORS.solar, fmt.kwh(r.solar, 2)],
          r.solar_low != null ? ['Range (10th–90th)', null, `${fmt.num(r.solar_low, 2)}–${fmt.kwh(r.solar_high, 2)}`] : null,
          ['Used at home', COLORS.solar, fmt.kwh(r.solar_to_home, 2)],
          ['Into battery', COLORS.battery, fmt.kwh(r.solar_to_battery, 2)],
          ['Exported', COLORS.export, fmt.kwh(r.solar_to_grid, 2)],
        ], 'Latest forecast, not a measurement.');
      }
      const e = exBy.get(r.slot_start);
      return tipHtml(tf.dayTime(r.slot_start), [
        ['Generated (measured)', COLORS.solar, fmt.kwh(r.solar, 2)],
        ['Used at home', COLORS.solar, fmt.kwh(r.solar_to_home, 2)],
        ['Into battery', COLORS.battery, fmt.kwh(r.solar_to_battery, 2)],
        ['Exported', COLORS.export, fmt.kwh(r.solar_to_grid, 2)],
        ['Forecast made in advance', null, r.solar_forecast != null ? fmt.kwh(r.solar_forecast, 2) : 'none kept'],
        ['Expected for the weather', null, e?.expected != null ? fmt.kwh(e.expected, 2) : 'no sunlight data'],
        e?.ghi_wm2 != null ? ['Sunlight (Open-Meteo)', null, `${Math.round(e.ghi_wm2)} W/m²`] : null,
        r.outdoor_temp != null ? ['Outside', null, `${r.outdoor_temp.toFixed(1)} °C`] : null,
      ]);
    },
  });

  const exDay = new Map((exm?.days || []).map((d) => [d.date, d]));
  const dayTick = (r, i) => (i % 5 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null);
  const perf = (r) => exDay.get(r.local_date)?.performance ?? null;
  timeChart(document.getElementById('month-chart'), {
    rows: month.rows, height: 200, unit: 'kWh', tick: dayTick,
    pos: BARS,
    lines: [
      { label: 'Forecast made in advance', color: ADVANCE, get: (r) => { const d = exDay.get(r.local_date); return d?.forecastComplete ? d.forecast : null; }, dash: true, width: 1.5 },
      { label: 'Expected for the weather', color: EXPECTED, get: (r) => exDay.get(r.local_date)?.expected ?? null, width: 1.5 },
    ],
    tip: (r) => {
      const d = exDay.get(r.local_date);
      const partialFc = d && d.forecast != null && !d.forecastComplete;
      return tipHtml(tf.date(r.local_date), [
        ['Generated (measured)', COLORS.solar, fmt.kwh(r.solar)], ['Self-consumption', null, fmt.pct(r.self_consumption)],
        ['Forecast made in advance', null, d?.forecast == null ? 'none kept' : partialFc ? `${fmt.kwh(d.forecast)} (part day)` : fmt.kwh(d.forecast)],
        ['Expected for the weather', null, fmt.kwh(d?.expected)],
        ['Made vs expected', null, fmt.pct(d?.performance)],
        ['Slots final', null, `${r.slots_final}/${r.slots}`],
      ], partialFc ? `Forecasts were kept for ${d.forecastHalfHours} of this day's half-hours, in which the panels made ${fmt.kwh(d.forecastActual)}.` : '');
    },
  });
  // Above or below 100% as bars around zero, so a shortfall reads as a shortfall.
  const diff = (r) => (perf(r) == null ? null : (perf(r) - 1) * 100);
  timeChart(document.getElementById('perf-chart'), {
    rows: month.rows, height: 110, unit: '% vs expected', tick: dayTick,
    yFormat: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}`,
    pos: [{ label: 'Above expected', color: COLORS.solar, get: (r) => Math.max(0, diff(r) ?? 0) }],
    neg: [{ label: 'Below expected', color: 'var(--text-3)', get: (r) => Math.max(0, -(diff(r) ?? 0)) }],
    tip: (r) => {
      const d = exDay.get(r.local_date);
      return tipHtml(tf.date(r.local_date), [
        ['Made vs expected', null, fmt.pct(d?.performance)],
        ['Made', COLORS.solar, fmt.kwh(d?.actual)],
        ['Expected for the weather', null, fmt.kwh(d?.expected)],
      ], d?.performance == null ? 'No half-hours with both sunlight data and output.' : `Over ${d.compared} half-hours with both${d.whole ? '' : '; the day is not over'}.`);
    },
  });
}

init({ page: 'solar', title: 'Solar', subtitle: 'Generation from the inverter, where every kWh went, what it was worth, how it compares with the forecast and the weather, and what the panels are expected to make next.', render });
