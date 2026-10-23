// Tariffs: the tariffs, rates and taxes in force (each with its origin badge), then the home's own
// slots re-priced on other tariffs (Agile in GB; the other tariffs held for its market elsewhere),
// with where the gain or loss comes from.
import { api, fmt, timeFmt, esc, slotClock, currencySymbol, priceUnit, originBadge, slotNoun, slotNouns, SlotNoun } from '../api.js';
import { init, card, tariffRowsHtml } from '../layout.js';
import { timeChart, legend, tipHtml, hhTicks } from '../charts.js';

const YOURS = 'var(--cmp-yours)';
const AGILE = 'var(--cmp-agile)';
const signed = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${fmt.gbp(Math.abs(p))}`;

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const [c, tariffs] = await Promise.all([api(`/api/sites/${id}/compare?period=${state.period}`), api(`/api/sites/${id}/tariffs`)]);
  const content = document.getElementById('content');
  const inForce = `<div class="section">${card('<div class="q">In force now</div>Tariffs, rates and taxes', 'Each figure carries where it came from: a named source, the provider, the user, or a placeholder or synthetic value that is not real or not verified.', tariffRowsHtml(tariffs))}</div>`;
  if (!c.ready) { content.innerHTML = `${card('Tariff comparison', '', `<div class="empty"><p>${esc(c.reason)}</p></div>`)}${inForce}`; return; }

  const cur = c.scenarios[0];
  const ag = c.scenarios.find((x) => x.key === (c.primaryKey || 'agile'));
  // The primary alternative: Agile in GB, the first other tariff of the market elsewhere.
  const ALT = c.primaryName || 'Agile';
  const periodText = c.from === c.to ? tf.date(c.from) : `${tf.date(c.from)} – ${tf.date(c.to)}`;
  const better = ag && ag.vsCurrent > 0;

  const verdict = ag ? `<div class="card" style="border-color:${better ? 'color-mix(in srgb, var(--good) 40%, var(--border))' : 'color-mix(in srgb, var(--warn) 50%, var(--border))'}">
    <div class="q">Verdict · ${periodText}</div>
    <p style="margin:4px 0 0;font-size:16px;line-height:1.55">With the same use, <b>your tariff cost ${fmt.gbp(cur.net)}</b> ${originBadge(cur.origin)} for electricity and <b>${esc(ALT)} would have cost ${fmt.gbp(ag.net)}</b> ${originBadge(ag.origin)}.
    ${better ? `You were <b style="color:var(--good)">${fmt.gbp(ag.vsCurrent)} better off</b>` : `${esc(ALT)} would have saved <b style="color:var(--warn)">${fmt.gbp(-ag.vsCurrent)}</b>`},
    about <b>${fmt.gbp(Math.abs(ag.perYear))} a year</b> if this pattern held.</p>
    <p class="faint" style="margin:8px 0 0;font-size:12.5px">${c.days} day${c.days === 1 ? '' : 's'} · ${fmt.kwh(c.importKwh)} imported, ${fmt.kwh(c.exportKwh)} exported · electricity only (gas unchanged)
    ${c.provisionalSlots ? ` · ${c.provisionalSlots} ${slotNouns()} use the inverter clamp until meter data arrives` : ''}${c.skipped ? ` · ${c.skipped} ${slotNouns()} without prices on every tariff left out` : ''}</p></div>` : '';

  const tiles = `<div class="kpis">${c.scenarios.map((x) => `<div class="kpi" ${x.current ? 'style="border-color:var(--cmp-yours)"' : ''}>
      <div class="label">${x.current ? '<i class="swatch" style="background:var(--cmp-yours)"></i>' : x.key === ag?.key ? '<i class="swatch" style="background:var(--cmp-agile)"></i>' : ''}${esc(x.name)} ${originBadge(x.origin)}</div>
      <div class="value">${fmt.gbp(x.net)}</div>
      <div class="sub">${x.current ? 'what you paid' : `<span class="${x.vsCurrent > 0 ? 'delta-good' : 'delta-bad'}">${signed(x.vsCurrent)}</span> vs yours`}</div>
      <div class="sub">import ${fmt.pkwh(x.avgImport)} · export ${fmt.pkwh(x.avgExport)}</div>
      <div class="sub mono" style="font-size:10.5px;white-space:normal">${esc(x.note || '')}</div></div>`).join('')}</div>`;

  const breakdownRows = `<div class="table-wrap"><table>
    <thead><tr><th>Tariff</th><th class="r">Energy bought</th><th class="r">Standing</th><th class="r">Export credit</th><th class="r">Net</th><th class="r">vs yours</th></tr></thead>
    <tbody>${c.scenarios.map((x) => `<tr><td>${esc(x.name)} ${originBadge(x.origin)}</td><td class="r">${fmt.gbp(x.importCost)}</td><td class="r">${fmt.gbp(x.standing)}</td><td class="r">−${fmt.gbp(x.exportCredit)}</td>
      <td class="r"><b>${fmt.gbp(x.net)}</b></td><td class="r">${x.current ? '–' : `<span class="${x.vsCurrent > 0 ? 'delta-good' : 'delta-bad'}">${signed(x.vsCurrent)}</span>`}</td></tr>`).join('')}</tbody></table></div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">Positive “vs yours” means that tariff would have cost more, so your tariff is ahead.</p>`;

  const w = c.windows;
  const windowRows = `<div class="rows">${[['Your off-peak window', w.offPeak], ['16:00–19:00 peak', w.peak], ['All other times', w.other]].filter(([, x]) => x.kwh > 0.01).map(([l, x]) => `
    <div class="row"><span class="k">${l}</span><b>${fmt.kwh(x.kwh)}</b></div>
    <div class="row sub"><span class="k">yours ${fmt.pkwh(x.cur / x.kwh)} · ${esc(ALT)} ${fmt.pkwh(x.agile / x.kwh)}</span><b class="${x.agile > x.cur ? 'delta-good' : 'delta-bad'}">${signed(x.agile - x.cur)}</b></div>`).join('')}</div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">Imports split by when they happened, priced both ways. Positive = ${esc(ALT)} would have cost more then.</p>`;

  const daily = [...c.daily].reverse();
  const table = `<div class="table-wrap"><table>
    <thead><tr><th>Day</th><th class="r">Imported</th><th class="r">Exported</th><th class="r">Yours</th><th class="r">${esc(ALT)}</th><th class="r">Difference</th>${c.scenarios.slice(2).map((x) => `<th class="r">${esc(x.name)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${c.daily.map((d) => `<tr><td>${tf.date(d.date)}</td><td class="r">${fmt.kwh(d.import)}</td><td class="r">${fmt.kwh(d.export)}</td><td class="r"><b>${fmt.gbp(d.current)}</b></td><td class="r">${fmt.gbp(d.agile)}</td>
      <td class="r"><span class="${d.agile > d.current ? 'delta-good' : 'delta-bad'}">${signed(d.agile - d.current)}</span></td>${c.scenarios.slice(2).map((x) => `<td class="r">${fmt.gbp(d[x.key])}</td>`).join('')}
      <td>${d.provisional ? '<span class="badge warn">provisional</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;

  const insights = `<div class="insights">${c.insights.map((i) => `<div class="insight"><span class="dot ${i.tone}">${{ good: '✓', tip: '★', info: 'i', warn: '!' }[i.tone] || 'i'}</span><div><b>${esc(i.title)}</b><p>${esc(i.detail)}</p></div></div>`).join('')}</div>`;

  const showSlots = c.slots.length <= (86400 / (c.slot_s || 1800)) * 8;
  content.innerHTML = `
    ${verdict}
    ${inForce}
    <div class="section">${tiles}</div>
    <div class="section grid cols-main">
      ${card(`<div class="q">Gain or loss</div>${esc(ALT)} minus your tariff, per day`, `Above the line: your tariff was cheaper that day. Below: ${esc(ALT)} would have been cheaper.`,
        `${legend([{ label: 'Your tariff cheaper', color: YOURS }, { label: `${ALT} cheaper`, color: AGILE }])}<div id="diff-chart"></div>`)}
      ${card('<div class="q">Insights</div>Where the difference comes from', '', insights)}
    </div>
    <div class="section grid cols-2">
      ${card('<div class="q">Bill</div>What each tariff would have charged', periodText, breakdownRows)}
      ${card('<div class="q">When it matters</div>Imports by time window', '', windowRows)}
    </div>
    <div class="section">${card('<div class="q">Why</div>Price by time of day', `Average import price at each ${slotNoun()} over the period, with the home’s average import below.`,
      `${legend([{ label: 'Your tariff', color: YOURS, type: 'line' }, { label: ALT, color: AGILE, type: 'line' }])}<div id="tod-price"></div>
       <div style="margin-top:10px">${legend([{ label: 'Imported (average)', color: 'var(--text-3)' }])}</div><div id="tod-import"></div>`)}</div>
    ${showSlots ? `<div class="section">${card(`<div class="q">${SlotNoun()} by ${slotNoun()}</div>Both prices and what was imported`, `Hover to compare any ${slotNoun()}.`,
      `${legend([{ label: 'Your tariff', color: YOURS, type: 'line' }, { label: ALT, color: AGILE, type: 'line' }])}<div id="slot-price"></div>
       <div style="margin-top:10px">${legend([{ label: 'Imported', color: 'var(--text-3)' }])}</div><div id="slot-import"></div>`)}</div>` : ''}
    <div class="section">${card('<div class="q">Day by day</div>Every tariff, every day', periodText, table)}</div>`;

  timeChart(document.getElementById('diff-chart'), {
    rows: daily, height: 220, unit: currencySymbol(), yFormat: (v) => fmt.gbp(v),
    tick: (r, i) => (daily.length <= 10 || i % Math.ceil(daily.length / 8) === 0 ? tf.date(r.date).split(' ').slice(1).join(' ') : null),
    pos: [{ label: 'Your tariff cheaper', color: YOURS, get: (r) => Math.max(0, r.agile - r.current) }],
    neg: [{ label: `${ALT} cheaper`, color: AGILE, get: (r) => Math.max(0, r.current - r.agile) }],
    tip: (r) => tipHtml(tf.date(r.date), [['Your tariff', YOURS, fmt.gbp(r.current)], [ALT, AGILE, fmt.gbp(r.agile)], ['Difference', null, signed(r.agile - r.current)], ['Imported', null, fmt.kwh(r.import)]]),
  });
  const slotS = c.slot_s || 1800;
  const todTick = (r) => (r.index % ((3 * 3600) / slotS) === 0 ? slotClock(r.index, slotS) : null);
  const todHead = (r) => `${slotClock(r.index, slotS)} on an average day`;
  timeChart(document.getElementById('tod-price'), {
    rows: c.profile, height: 170, unit: priceUnit(), tick: todTick, yMin: Math.min(0, ...c.profile.map((r) => r.agile ?? 0)),
    lines: [{ label: 'Your tariff', color: YOURS, get: (r) => r.current, step: true }, { label: ALT, color: AGILE, get: (r) => r.agile, step: true }],
    tip: (r) => tipHtml(todHead(r), [['Your tariff', YOURS, fmt.pkwh(r.current)], [ALT, AGILE, fmt.pkwh(r.agile)], ['Imported', null, fmt.kwh(r.import, 2)]]),
  });
  timeChart(document.getElementById('tod-import'), {
    rows: c.profile, height: 110, unit: 'kWh', tick: todTick,
    pos: [{ label: 'Imported', color: 'var(--text-3)', get: (r) => r.import }],
    tip: (r) => tipHtml(todHead(r), [['Imported', null, fmt.kwh(r.import, 2)], ['Your tariff', YOURS, fmt.pkwh(r.current)], [ALT, AGILE, fmt.pkwh(r.agile)]]),
  });
  if (showSlots) {
    const multiDay = c.slots.length > 2 * (86400 / slotS);
    const tick = hhTicks(tf, multiDay);
    const head = (r) => tf.dayTime(r.slot_start);
    timeChart(document.getElementById('slot-price'), {
      rows: c.slots, height: 180, unit: priceUnit(), tick, yMin: Math.min(0, ...c.slots.map((r) => r.agile ?? 0)),
      lines: [{ label: 'Your tariff', color: YOURS, get: (r) => r.current, step: true }, { label: ALT, color: AGILE, get: (r) => r.agile, step: true }],
      tip: (r) => tipHtml(head(r), [['Your tariff', YOURS, fmt.pkwh(r.current)], [ALT, AGILE, fmt.pkwh(r.agile)], ['Imported', null, fmt.kwh(r.import, 2)], ['Cost difference', null, signed(r.import * ((r.agile ?? 0) - r.current))]]),
    });
    timeChart(document.getElementById('slot-import'), {
      rows: c.slots, height: 110, unit: 'kWh', tick,
      pos: [{ label: 'Imported', color: 'var(--text-3)', get: (r) => r.import }],
      tip: (r) => tipHtml(head(r), [['Imported', null, fmt.kwh(r.import, 2)], ['Your tariff', YOURS, fmt.pkwh(r.current)], [ALT, AGILE, fmt.pkwh(r.agile)]]),
    });
  }
}

init({ page: 'tariffs', title: 'Tariffs', subtitle: 'The tariffs, rates and taxes in force, with where each figure came from; then your own use re-priced on other tariffs: what you gained or lost, and when.', render });
