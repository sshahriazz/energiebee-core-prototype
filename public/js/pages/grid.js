// Grid: what was bought and sold, at what price, the tariff in force, upcoming
// prices, and how the smart meter compares with the inverter's clamp.
import { api, fmt, timeFmt, delta, esc, COLORS } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, legend, tipHtml, hhTicks } from '../charts.js';
import { loadTimeline, isFc } from '../timeline.js';

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [summary, tl, fc, tariffs, health] = await Promise.all([
    api(`/api/sites/${id}/summary?period=${state.period}`), loadTimeline(state, { forecastHours: 30 }),
    api(`/api/sites/${id}/forecast?hours=48`), api(`/api/sites/${id}/tariffs`), api(`/api/sites/${id}/health`),
  ]);
  const c = summary.current; const p = summary.previous; const vs = summary.previousLabel;
  const shift = c.avg_import_rate != null && c.import_rate_paid != null ? c.avg_import_rate - c.import_rate_paid : null;

  const kpis = `<div class="kpis">
    ${kpi('Imported', fmt.kwh(c.grid_import), delta(c.grid_import, p.grid_import, { lowerIsBetter: true, format: (v) => fmt.kwh(v), vs }), COLORS.grid)}
    ${kpi('Import cost', fmt.gbp((c.grid_to_home_cost || 0) + (c.grid_to_battery_cost || 0) + (c.loss_cost || 0)), `every imported kWh, incl. ${fmt.gbp(c.loss_cost || 0)} the inverter used · + ${fmt.gbp(c.standing_cost)} standing`)}
    ${kpi('Average price paid', fmt.pkwh(c.import_rate_paid), shift != null ? `${shift >= 0 ? `${fmt.p(shift)} below` : `${fmt.p(-shift)} above`} the average price (${fmt.pkwh(c.avg_import_rate)})` : '')}
    ${kpi('Exported', fmt.kwh(c.grid_export), `${fmt.gbp(c.export_credit)} at ${fmt.pkwh(c.export_rate_avg)}`, COLORS.export)}
    ${kpi('Peak import', fmt.kw(c.peak_import_kw), 'highest half-hour, as average kW')}
    ${kpi('Grid carbon', fmt.kg(c.carbon_g), `${fmt.kg(c.carbon_saved_g)} avoided`)}
  </div>`;

  const upcoming = fc.slots.filter((s) => s.import_rate != null && s.slot_start >= Date.now() / 1000 - 1800);
  const sorted = [...upcoming].sort((a, b) => a.import_rate - b.import_rate);
  const cheap = new Set(sorted.slice(0, 6).map((s) => s.slot_start));
  const dear = new Set(sorted.slice(-6).map((s) => s.slot_start));
  const upTable = upcoming.length ? `<div class="table-wrap" style="max-height:340px;overflow:auto"><table>
    <thead><tr><th>Half-hour</th><th class="r">Import</th><th class="r">Export</th><th></th></tr></thead>
    <tbody>${upcoming.map((s) => `<tr><td>${tf.dayTime(s.slot_start)}</td><td class="r">${fmt.pkwh(s.import_rate)}</td><td class="r">${fmt.pkwh(s.export_rate)}</td>
      <td>${cheap.has(s.slot_start) ? '<span class="badge good">cheapest</span>' : dear.has(s.slot_start) ? '<span class="badge bad">most expensive</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="skeleton">No published prices ahead.</div>';

  const current = tariffs.filter((t) => t.current);
  const tariffRows = current.length ? `<div class="rows">${current.map((t) => `
    <div class="row"><span class="k">${esc(t.label || t.kind)}</span><span class="mono">${esc(t.tariff_code)}</span></div>
    <div class="row sub"><span class="k">${esc(t.name || t.structure)} · ${t.structure}</span><b>${fmt.pkwh(t.unitNow)} now${t.direction === 'import' ? ` · ${fmt.p(t.standingPerDay)}/day` : ''}</b></div>`).join('')}</div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">Prices are stored without VAT and VAT is added by date, because Octopus restates VAT-inclusive history at today's rate.
    Electricity VAT now: ${current[0]?.vat != null ? fmt.pct(current[0].vat) : '–'}.</p>`
    : '<div class="skeleton">No tariff found for this home.</div>';

  const mvc = health.checks.filter((x) => x.check_code === 'meter_vs_ct');
  const meterTable = mvc.length ? `<div class="table-wrap"><table><thead><tr><th>Day</th><th>Meter vs inverter clamp</th><th class="r">Difference</th><th></th></tr></thead><tbody>
    ${mvc.map((x) => `<tr><td>${tf.date(x.local_date)}</td><td class="muted">${esc(x.detail)}</td><td class="r">${fmt.pct(x.measured, 1)}</td><td><span class="badge ${x.status === 'pass' ? 'good' : 'warn'}">${x.status}</span></td></tr>`).join('')}
    </tbody></table></div><p class="faint" style="font-size:12px;margin:10px 0 0">The smart meter is what the supplier bills, so it wins for cost. The clamp fills in until meter data arrives (about a day late); those half-hours are marked provisional.</p>`
    : '<div class="skeleton">Appears once smart meter data overlaps inverter data.</div>';

  const multiDay = tl.step === 'hh' && new Set(tl.rows.map((r) => r.local_date)).size > 2;
  document.getElementById('content').innerHTML = `
    ${kpis}
    <div class="section">${card('Bought and sold', 'Above the line: imported, by where it went. Below: exported, by source.',
      `${legend([{ label: 'Import to home', color: COLORS.grid }, { label: 'Import to battery', color: COLORS.battery }, { label: 'Export from solar', color: COLORS.solar }, { label: 'Export from battery', color: COLORS.export }])}<div id="grid-chart"></div>`)}</div>
    ${tl.step === 'hh' ? `<div class="section">${card('Price per kWh', 'Including VAT. After “now”: published prices.', `${legend([{ label: 'Import', color: COLORS.grid, type: 'line' }, { label: 'Export', color: COLORS.export, type: 'line' }])}<div id="price-chart"></div>`)}</div>` : ''}
    <div class="section grid cols-2">
      ${card('Tariffs', 'In force now, from the supplier account', tariffRows)}
      ${card('Upcoming prices', `${upcoming.length / 2} hours published`, upTable)}
    </div>
    <div class="section">${card('Smart meter and inverter', 'Daily check of the two import measurements', meterTable)}</div>`;

  const ticks = tl.step === 'day' ? (r, i) => (i % 3 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null) : hhTicks(tf, multiDay);
  const head = (r) => (tl.step === 'day' ? tf.date(r.local_date) : `${tf.dayTime(r.slot_start)}${isFc(r) ? ' · forecast' : r.state !== 'final' ? ` · ${r.state}` : ''}`);
  timeChart(document.getElementById('grid-chart'), {
    rows: tl.rows, height: 230, unit: 'kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex,
    onPick: (r) => { if (tl.step === 'hh' && !isFc(r)) location.href = evidenceLink(state, r.slot_start); },
    pos: [{ label: 'Import to home', color: COLORS.grid, get: (r) => r.grid_to_home }, { label: 'Import to battery', color: COLORS.battery, get: (r) => r.grid_to_battery }],
    neg: [{ label: 'Export from solar', color: COLORS.solar, get: (r) => r.solar_to_grid }, { label: 'Export from battery', color: COLORS.export, get: (r) => r.battery_to_grid }],
    tip: (r) => tipHtml(head(r), [
      ['Imported', COLORS.grid, fmt.kwh(r.grid_import, 2)], ['Exported', COLORS.export, fmt.kwh(r.grid_export, 2)],
      r.import_rate != null ? ['Import price', null, fmt.pkwh(r.import_rate)] : null,
      ['Import cost', null, fmt.gbp((r.grid_to_home_cost || 0) + (r.grid_to_battery_cost || 0) + (r.loss_cost || 0))],
      r.export_credit ? ['Export credit', null, fmt.gbp(r.export_credit)] : null,
      r.meter_vs_ct != null ? ['Meter − clamp', null, fmt.kwh(r.meter_vs_ct, 3)] : null,
    ], r.state === 'provisional' ? 'Provisional: inverter clamp until meter data arrives' : ''),
  });
  if (tl.step === 'hh') {
    timeChart(document.getElementById('price-chart'), {
      rows: tl.rows, height: 170, unit: 'p/kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex, yMin: Math.min(0, ...tl.rows.map((r) => r.import_rate ?? 0)),
      lines: [{ label: 'Import', color: COLORS.grid, get: (r) => r.import_rate, step: true }, { label: 'Export', color: COLORS.export, get: (r) => r.export_rate, step: true }],
      tip: (r) => tipHtml(head(r), [['Import', COLORS.grid, fmt.pkwh(r.import_rate)], ['Export', COLORS.export, fmt.pkwh(r.export_rate)]]),
    });
  }
}

init({ page: 'grid', title: 'Grid', subtitle: 'Energy bought and sold, the prices paid, and the tariff behind them.', render });
