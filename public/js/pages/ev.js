// EV: charging sessions, what they cost, how much came from solar, and what is planned tonight.
import { api, fmt, timeFmt, esc, COLORS, slotNoun, SlotNoun } from '../api.js';
import { init, card, kpi, evidenceLink } from '../layout.js';
import { timeChart, tipHtml, hhTicks } from '../charts.js';
import { loadTimeline, isFc } from '../timeline.js';

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [ev, summary, tl] = await Promise.all([
    api(`/api/sites/${id}/ev?period=${state.period}`), api(`/api/sites/${id}/summary?period=${state.period}`), loadTimeline(state, { forecastHours: 24 }),
  ]);
  const content = document.getElementById('content');
  if (!ev.devices.length && !ev.sessions.length) {
    content.innerHTML = card('No EV connected yet', '', `<div class="empty">
      <p>EV charging joins the same ${slotNoun()} timeline as everything else. It can come from:</p>
      <p><b>Octopus Intelligent</b> smart-charge dispatches (Kraken), the <b>Sunsynk</b> charger reading, or a charger's own API later.</p>
      <p class="faint">Nothing in the core changes when one is added: a new adapter writes EV facts and the build engine prices them.</p></div>`);
    return;
  }
  const c = summary.current;
  const kwh = ev.sessions.reduce((s, x) => s + x.kwh, 0);
  const cost = ev.sessions.reduce((s, x) => s + x.cost, 0);
  const solar = ev.sessions.reduce((s, x) => s + x.solar, 0);
  const rate = kwh ? cost / kwh : null;
  const saved = rate != null && ev.averageImportRate != null ? (ev.averageImportRate - rate) * kwh : null;

  // No sessions from any source means charging is not measured, not that there was none.
  if (!ev.sessions.length && !ev.planned.length) {
    const d = ev.devices[0]; const st = JSON.parse(d?.attrs || '{}').status?.currentState;
    content.innerHTML = `<div class="banner warn"><span>i</span><div><b>EV charging is not measured for ${esc(d?.label || 'this car')}.</b>
      ${st === 'SMART_CONTROL_NOT_AVAILABLE' ? 'Octopus reports its smart control as not available, so Octopus records no charging sessions for it.' : 'No source has reported a charging session for it.'}
      Any charging at home is included in the house's use on the other pages, but it can't be separated out without a source for it: Octopus smart charging working again, or a charger or car connection.</div></div>
      ${card('Planned', 'Smart-charge dispatches for the next 24 hours', '<div class="skeleton">No charging planned in the next 24 hours.</div>')}`;
    return;
  }

  const kpis = `<div class="kpis">
    ${kpi('Charged', fmt.kwh(kwh), `${ev.sessions.length} session${ev.sessions.length === 1 ? '' : 's'}`, COLORS.ev)}
    ${kpi('Cost', fmt.gbp(cost), `${fmt.pkwh(rate)} on average`)}
    ${kpi('Smart charging benefit', fmt.gbp(saved), `vs the average price ${fmt.pkwh(ev.averageImportRate)}`)}
    ${kpi('From solar', fmt.kwh(solar), kwh ? `${fmt.pct(solar / kwh)} of charging` : '')}
    ${kpi('Share of home use', c.home ? fmt.pct((c.ev || 0) / c.home) : '–', `${fmt.kwh(c.ev)} of ${fmt.kwh(c.home)}`)}
  </div>`;

  const planned = ev.planned.length ? `<div class="rows">${ev.planned.map((p) => `<div class="row"><span class="k">${tf.dayTime(p.slot)}</span><b>${fmt.kwh(p.kwh, 2)} · ${fmt.pkwh(p.rate)}</b></div>`).join('')}
    <div class="row total"><span class="k">Planned</span><b>${fmt.kwh(ev.planned.reduce((s, p) => s + p.kwh, 0))} · ${ev.planned.every((p) => p.rate != null) ? fmt.gbp(ev.planned.reduce((s, p) => s + p.kwh * p.rate, 0)) : 'prices not published yet'}</b></div></div>`
    : '<div class="skeleton">No charging planned in the next 24 hours.</div>';

  const sessions = ev.sessions.length ? `<div class="table-wrap"><table><thead><tr><th>Start</th><th>End</th><th class="r">Energy</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Solar</th></tr></thead><tbody>
    ${ev.sessions.map((x) => `<tr class="clickable" data-slot="${x.start}"><td>${tf.dayTime(x.start)}</td><td>${tf.time(x.end)}</td><td class="r">${fmt.kwh(x.kwh)}</td><td class="r">${fmt.gbp(x.cost)}</td><td class="r">${fmt.pkwh(x.kwh ? x.cost / x.kwh : null)}</td><td class="r">${fmt.pct(x.kwh ? x.solar / x.kwh : null)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="skeleton">No charging sessions in this period.</div>';

  content.innerHTML = `
    ${kpis}
    <div class="section">${card('Charging', `${SlotNoun()} EV energy from ${esc(ev.devices.map((d) => d.label).join(', ') || 'the car')}, priced at the home's cost of energy in that ${slotNoun()}.`, '<div id="ev-chart"></div>')}</div>
    <div class="section grid cols-main">${card('Sessions', `${tf.date(ev.from)} – ${tf.date(ev.to)} · click a row for its evidence`, sessions)}${card('Planned', 'Smart-charge dispatches for the next 24 hours', planned)}</div>`;

  content.querySelectorAll('tr[data-slot]').forEach((tr) => tr.addEventListener('click', () => { location.href = evidenceLink(state, tr.dataset.slot); }));
  const multiDay = tl.step === 'hh' && new Set(tl.rows.map((r) => r.local_date)).size > 2;
  const ticks = tl.step === 'day' ? (r, i) => (i % 3 === 0 ? tf.date(r.local_date).split(' ').slice(1).join(' ') : null) : hhTicks(tf, multiDay);
  timeChart(document.getElementById('ev-chart'), {
    rows: tl.rows, height: 200, unit: 'kWh', tick: ticks, isForecast: isFc, nowIndex: tl.nowIndex,
    pos: [{ label: 'EV', color: COLORS.ev, get: (r) => r.ev }],
    tip: (r) => tipHtml(tl.step === 'day' ? tf.date(r.local_date) : `${tf.dayTime(r.slot_start)}${isFc(r) ? ' · planned' : ''}`, [
      ['EV charging', COLORS.ev, fmt.kwh(r.ev, 2)],
      r.import_rate != null ? ['Grid price', null, fmt.pkwh(r.import_rate)] : null,
    ]),
  });
}

init({ page: 'ev', title: 'Electric vehicle', subtitle: 'Charging sessions, their cost, and how much of the car ran on sunshine.', render });
