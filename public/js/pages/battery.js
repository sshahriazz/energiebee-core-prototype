// Battery: charge level, what went in and out, what stored energy cost (first in,
// first out) and what it saved, with one half-hour worked through in full.
import { api, fmt, timeFmt, delta, COLORS } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, legend, tipHtml, hhTicks } from '../charts.js';
import { loadTimeline, isFc } from '../timeline.js';

function workedExample(r, tf) {
  if (!r) return '<div class="skeleton">No battery use in this period.</div>';
  const rate = r.import_rate;
  const stored = r.battery_to_home ? r.battery_to_home_cost / r.battery_to_home : 0;
  const homeCost = (r.grid_to_home_cost || 0) + (r.battery_to_home_cost || 0);
  const gridOnly = r.home * rate;
  return `<div class="rows">
    <div class="row"><span class="k">Half-hour</span><b>${tf.dayTime(r.slot_start)}</b></div>
    <div class="row"><span class="k">Home used</span><b>${fmt.kwh(r.home, 2)}</b></div>
    <div class="row sub"><span class="k"><i class="swatch" style="background:${COLORS.solar}"></i>from solar at 0p</span><b>${fmt.kwh(r.solar_to_home, 2)}</b></div>
    <div class="row sub"><span class="k"><i class="swatch" style="background:${COLORS.battery}"></i>from battery, stored at ${fmt.pkwh(stored)}</span><b>${fmt.kwh(r.battery_to_home, 2)} · ${fmt.p(r.battery_to_home_cost)}</b></div>
    <div class="row sub"><span class="k"><i class="swatch" style="background:${COLORS.grid}"></i>from grid at ${fmt.pkwh(rate)}</span><b>${fmt.kwh(r.grid_to_home, 2)} · ${fmt.p(r.grid_to_home_cost)}</b></div>
    <div class="row total"><span class="k">Paid for that energy</span><b>${fmt.p(homeCost)}</b></div>
    <div class="row"><span class="k">Grid only would have cost</span><b>${fmt.p(gridOnly)}</b></div>
    <div class="row total"><span class="k" style="color:var(--good)">Saved</span><b style="color:var(--good)">${fmt.p(gridOnly - homeCost)}</b></div>
    <div class="row"><span class="k">Blended price of energy used</span><b>${fmt.pkwh(r.home ? homeCost / r.home : null)}</b></div>
  </div>
  <p class="faint" style="font-size:12px;margin:10px 0 0">Standing charge and export are left out here to match the energy only. <a href="/data?site=${r._site}&slot=${r.slot_start}#evidence">See every fact behind this half-hour →</a></p>`;
}

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [summary, tl, now] = await Promise.all([
    api(`/api/sites/${id}/summary?period=${state.period}`), loadTimeline(state, { forecastHours: 24 }), api(`/api/sites/${id}/now`),
  ]);
  const c = summary.current; const p = summary.previous; const vs = summary.previousLabel;
  const cap = state.site.battery_kwh;
  const soc = now.live?.battery_soc_pct;

  const kpis = `<div class="kpis">
    ${kpi('Charge level now', soc != null ? `${Math.round(soc)}%` : '–', cap ? `${fmt.kwh((soc / 100) * cap)} of ${cap} kWh` : '', COLORS.battery)}
    ${kpi('Charged', fmt.kwh(c.battery_charge), `${fmt.kwh(c.solar_to_battery)} solar · ${fmt.kwh(c.grid_to_battery)} grid`)}
    ${kpi('Discharged', fmt.kwh(c.battery_discharge), `${fmt.kwh(c.battery_to_home)} home · ${fmt.kwh(c.battery_to_grid)} export`)}
    ${kpi('Cost of stored energy', fmt.pkwh(c.battery_stored_rate), `grid average ${fmt.pkwh(c.avg_import_rate)}`)}
    ${kpi('Battery saving', fmt.gbp(c.battery_value), delta(c.battery_value, p.battery_value, { format: fmt.gbp, vs }) || 'grid power replaced − grid charging cost')}
    ${kpi('Cycles', fmt.num(c.battery_cycles, 2), `charge range ${fmt.num(c.soc_min, 0)}–${fmt.num(c.soc_max, 0)}%${summary.days >= 7 && c.battery_losses > 0 ? ` · ${fmt.kwh(c.battery_losses)} lost` : ''}`)}
  </div>`;

  // The busiest battery half-hour; if today has hardly any yet, use yesterday's.
  const busiest = (rows) => rows.filter((r) => !isFc(r) && r.battery_to_home > 0).reduce((a, b) => (!a || b.battery_to_home > a.battery_to_home ? b : a), null);
  let best = tl.step === 'hh' ? busiest(tl.rows) : null;
  if (!best || best.battery_to_home < 0.3) best = busiest((await api(`/api/sites/${id}/timeline?period=yesterday&step=hh`)).rows) || best;
  if (best) best._site = id;

  const multiDay = tl.step === 'hh' && new Set(tl.rows.map((r) => r.local_date)).size > 2;
  document.getElementById('content').innerHTML = `
    ${kpis}
    ${tl.step === 'hh' ? `<div class="section">${card('Charge level', `State of charge at the end of each half-hour. ${tl.nowIndex != null ? 'After “now”: expected, from the forecast.' : ''}`, '<div id="soc-chart"></div>')}</div>` : ''}
    <div class="section">${card('In and out', 'Above the line: energy the battery supplied. Below: energy it stored, by source.',
      `${legend([{ label: 'To home', color: COLORS.battery }, { label: 'Exported', color: COLORS.export }, { label: 'From solar', color: COLORS.solar }, { label: 'From grid', color: COLORS.grid }])}<div id="flow-chart"></div>`)}</div>
    <div class="section grid cols-2">
      ${card('One half-hour, costed', 'The busiest battery half-hour in this period. Stored energy keeps the price it was bought at (first in, first out).', workedExample(best, tf))}
      ${card('How the battery is valued', '', `<div class="rows">
        <div class="row"><span class="k">Grid power it replaced</span><b>${fmt.gbp(c.battery_avoided)}</b></div>
        <div class="row"><span class="k">Export credit from battery</span><b>${fmt.gbp(c.battery_export_value)}</b></div>
        <div class="row"><span class="k">Cost of charging from the grid</span><b>−${fmt.gbp(c.grid_to_battery_cost)}</b></div>
        <div class="row total"><span class="k">Battery saving</span><b>${fmt.gbp(c.battery_value)}</b></div>
      </div>
      <p class="faint" style="font-size:12px;margin:10px 0 0">Charging from solar costs nothing, so that part of the saving comes from moving free daytime energy into the evening.
      Charging from the grid pays off when it is cheaper than the price at the time of use, after about 10% round-trip loss.</p>`)}
    </div>`;

  const ticks = tl.step === 'day' ? (r, i) => (i % 3 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null) : hhTicks(tf, multiDay);
  const head = (r) => (tl.step === 'day' ? tf.date(r.local_date) : `${tf.dayTime(r.slot_start)}${isFc(r) ? ' · forecast' : ''}`);
  const pick = (r) => { if (tl.step === 'hh' && !isFc(r)) location.href = evidenceLink(state, r.slot_start); };
  if (tl.step === 'hh') {
    timeChart(document.getElementById('soc-chart'), {
      rows: tl.rows, height: 160, unit: '%', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex, yMin: 0, yMaxFixed: 100, yMax: 100,
      lines: [{ label: 'Charge level', color: COLORS.battery, get: (r) => r.soc_end, area: true }],
      tip: (r) => tipHtml(head(r), [['Charge level', COLORS.battery, r.soc_end != null ? `${Math.round(r.soc_end)}%` : '–']]),
    });
  }
  timeChart(document.getElementById('flow-chart'), {
    rows: tl.rows, height: 220, unit: 'kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex, onPick: pick,
    pos: [{ label: 'To home', color: COLORS.battery, get: (r) => r.battery_to_home }, { label: 'Exported', color: COLORS.export, get: (r) => r.battery_to_grid }],
    neg: [{ label: 'From solar', color: COLORS.solar, get: (r) => r.solar_to_battery }, { label: 'From grid', color: COLORS.grid, get: (r) => r.grid_to_battery }],
    tip: (r) => tipHtml(head(r), [
      ['To home', COLORS.battery, fmt.kwh(r.battery_to_home, 2)],
      r.battery_to_grid ? ['Exported', COLORS.export, fmt.kwh(r.battery_to_grid, 2)] : null,
      ['From solar', COLORS.solar, fmt.kwh(r.solar_to_battery, 2)],
      ['From grid', COLORS.grid, fmt.kwh(r.grid_to_battery, 2)],
      r.battery_to_home ? ['Stored cost', null, fmt.pkwh((r.battery_to_home_cost || 0) / r.battery_to_home)] : null,
      r.import_rate != null ? ['Grid price', null, fmt.pkwh(r.import_rate)] : null,
      r.soc_end != null ? ['Charge level', null, `${Math.round(r.soc_end)}%`] : null,
    ]),
  });
}

init({ page: 'battery', title: 'Battery', subtitle: 'Charge level, energy in and out, and what the stored energy cost and saved.', render });
