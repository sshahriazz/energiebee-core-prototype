// Breakdown: who produced the energy, who used it, how it got there, when, what
// it cost or earned, and how the bill ends up lower than grid-only.
import { api, fmt, timeFmt, esc, COLORS } from '../api.js';
import { init, card } from '../layout.js';
import { timeChart, legend, tipHtml, sankey, waterfall, hbars } from '../charts.js';

const SRC = [
  { key: 'solar', label: 'Solar', color: COLORS.solar },
  { key: 'battery', label: 'Battery', color: COLORS.battery },
  { key: 'grid', label: 'Grid', color: COLORS.grid },
];
const DST = [
  { key: 'home', label: 'Home', color: 'var(--text-2)' },
  { key: 'battery', label: 'Battery', color: COLORS.battery },
  { key: 'export', label: 'Exported', color: COLORS.export },
];

function flows(t) {
  // [from, to, kWh, money in pence, what the money is]
  return [
    ['solar', 'home', t.solar_to_home, t.solar_home_value, 'worth at grid price'],
    ['solar', 'battery', t.solar_to_battery, 0, 'stored at 0p'],
    ['solar', 'export', t.solar_to_grid, t.solar_export_credit, 'earned'],
    ['battery', 'home', t.battery_to_home, t.battery_to_home_cost, 'stored cost'],
    ['battery', 'export', t.battery_to_grid, t.battery_export_credit, 'earned'],
    ['grid', 'home', t.grid_to_home, t.grid_to_home_cost, 'paid'],
    ['grid', 'battery', t.grid_to_battery, t.grid_to_battery_cost, 'paid'],
  ].map(([from, to, kwh, money, what]) => ({ from, to, kwh: kwh || 0, money: money || 0, what }));
}

function matrix(fl, t) {
  const cell = (f) => (f && f.kwh > 0.005 ? `<b>${fmt.kwh(f.kwh)}</b><small>${fmt.gbp(f.money)} ${f.what}</small>` : '<span class="faint">–</span>');
  const find = (a, b) => fl.find((f) => f.from === a && f.to === b);
  const rowTotal = (k) => fl.filter((f) => f.from === k).reduce((s, f) => s + f.kwh, 0);
  const colTotal = (k) => fl.filter((f) => f.to === k).reduce((s, f) => s + f.kwh, 0);
  return `<div class="table-wrap"><table class="matrix">
    <thead><tr><th>From ↓ · To →</th>${DST.map((d) => `<th>${d.label}</th>`).join('')}<th>Total out</th></tr></thead>
    <tbody>${SRC.map((s) => `<tr><td><span class="k" style="display:inline-flex;gap:6px;align-items:center"><i class="swatch" style="background:${s.color}"></i>${s.label}</span></td>
      ${DST.map((d) => `<td>${s.key === d.key ? '<span class="faint">–</span>' : cell(find(s.key, d.key))}</td>`).join('')}<td><b>${fmt.kwh(rowTotal(s.key))}</b></td></tr>`).join('')}
      <tr class="total"><td>Total in</td>${DST.map((d) => `<td>${fmt.kwh(colTotal(d.key))}</td>`).join('')}<td></td></tr>
    </tbody></table></div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">Battery “stored cost” is what the energy cost when it went in (first in, first out; solar = 0p).
    It is already counted in “Grid → Battery”, so it is shown here but not added to the bill twice.</p>`;
}

async function render(state) {
  const id = state.site.id;
  const tf = timeFmt(state.tz);
  const b = await api(`/api/sites/${id}/breakdown?period=${state.period}`);
  const t = b.totals;
  const fl = flows(t);
  const homeMix = t.home ? [['Solar', t.solar_to_home, COLORS.solar], ['Battery', t.battery_to_home, COLORS.battery], ['Grid', t.grid_to_home, COLORS.grid]] : [];
  const pct = (v) => (t.home ? `${Math.round(((v || 0) / t.home) * 100)}%` : '–');
  const periodText = b.from === b.to ? tf.date(b.from) : `${tf.date(b.from)} – ${tf.date(b.to)}`;

  const story = `<div class="card"><div class="q">In short · ${periodText}</div>
    <p style="margin:4px 0 0;font-size:15px;line-height:1.6">The panels <b>produced ${fmt.kwh(t.solar)}</b>. The home <b>used ${fmt.kwh(t.home)}</b>:
    ${pct(t.solar_to_home)} straight from solar, ${pct(t.battery_to_home)} from the battery and ${pct(t.grid_to_home)} from the grid.
    ${fmt.kwh(t.grid_import)} was <b>imported</b> for ${fmt.gbp((t.grid_to_home_cost || 0) + (t.grid_to_battery_cost || 0))}${t.grid_to_battery > 0.05 ? ` (${fmt.kwh(t.grid_to_battery)} of it to charge the battery)` : ''},
    and ${fmt.kwh(t.grid_export)} was <b>exported</b> for ${fmt.gbp(t.export_credit)}.
    With standing charges the bill is <b>${fmt.gbp(t.total_cost)}</b>; on grid power alone it would have been ${fmt.gbp(t.grid_only_cost)}, so
    ${t.saving >= 0 ? `<b style="color:var(--good)">${fmt.gbp(t.saving)} saved</b>.` : `<b>${fmt.gbp(-t.saving)} more than grid-only so far</b>: grid energy bought cheaply for the battery counts now and pays back when the battery covers dearer hours.`}</p>
    <div class="mix" style="height:12px;margin-top:12px" title="Home use by source">${homeMix.map(([l, v, c]) => `<i style="width:${(v / t.home) * 100}%;background:${c}" title="${l} ${fmt.kwh(v)}"></i>`).join('')}</div>
    ${legend(homeMix.map(([l, v, c]) => ({ label: `${l} ${pct(v)}`, color: c })))}</div>`;

  // Waterfall over priced half-hours only, so it adds up exactly.
  const steps = [
    { label: 'Grid only', value: t.grid_only, kind: 'total', color: 'var(--text-3)', note: 'Every kWh the home used, bought from the grid at the price of its half-hour, plus standing charges.' },
    { label: 'Solar used directly', value: -(t.solar_direct || 0), kind: 'delta', color: COLORS.solar, note: 'Solar used the moment it was made, valued at the grid price it replaced.' },
    { label: 'Battery covered', value: -(t.battery_cover || 0), kind: 'delta', color: COLORS.battery, note: 'Battery energy used at home, valued at the grid price at the time it was used.' },
    { label: 'Grid charging', value: t.grid_charging || 0, kind: 'delta', color: COLORS.grid, note: 'What the grid energy put into the battery cost when it was bought.' },
    { label: 'Export earned', value: -(t.export_earned || 0), kind: 'delta', color: COLORS.export, note: 'Credit for energy sent to the grid.' },
    { label: 'Actual bill', value: t.actual, kind: 'total', color: 'var(--text)', note: 'Grid energy paid for + standing charges − export credit.' },
  ];
  const check = (t.grid_only || 0) + steps.slice(1, 5).reduce((s, x) => s + x.value, 0) - (t.actual || 0);

  const priceRows = [
    { label: 'Solar', value: 0, color: COLORS.solar, swatch: COLORS.solar, note: 'free once made' },
    { label: 'Battery (stored)', value: t.battery_stored_rate, color: COLORS.battery, swatch: COLORS.battery, note: 'price when charged' },
    { label: 'Grid (paid)', value: t.import_rate_paid, color: COLORS.grid, swatch: COLORS.grid, note: 'average actually paid' },
    { label: 'Blend for the home', value: t.blended_rate, color: 'var(--text)', note: 'all sources together' },
    { label: 'Grid average price', value: t.avg_import_rate, color: 'var(--text-3)', note: 'if use were spread evenly' },
    { label: 'Export earned', value: t.export_rate_avg, color: COLORS.export, swatch: COLORS.export, note: 'per kWh sent out' },
  ];

  const bandMax = Math.max(1e-9, ...b.bands.map((x) => x.kwh));
  const bandRows = b.bands.map((x) => ({ label: x.label, value: x.kwh, color: COLORS.grid, note: `${fmt.gbp(x.cost)}${x.kwh ? ` · ${fmt.pkwh(x.cost / x.kwh)}` : ''}` }));

  const glance = `<div class="rows">
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.solar}"></i>Produced (solar)</span><b>${fmt.kwh(t.solar)}</b></div>
    <div class="row sub"><span class="k">kept in the home (self-consumption)</span><b>${fmt.pct(t.self_consumption)}</b></div>
    <div class="row"><span class="k">Used by the home</span><b>${fmt.kwh(t.home)}</b></div>
    <div class="row sub"><span class="k">not bought from the grid (self-sufficiency)</span><b>${fmt.pct(t.self_sufficiency)}</b></div>
    ${t.ev ? `<div class="row sub"><span class="k"><i class="swatch" style="background:${COLORS.ev}"></i>of which the EV</span><b>${fmt.kwh(t.ev)}</b></div>` : ''}
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.grid}"></i>Imported</span><b>${fmt.kwh(t.grid_import)} · ${fmt.gbp((t.grid_to_home_cost || 0) + (t.grid_to_battery_cost || 0))}</b></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.export}"></i>Exported</span><b>${fmt.kwh(t.grid_export)} · ${fmt.gbp(t.export_credit)}</b></div>
    <div class="row"><span class="k"><i class="swatch" style="background:${COLORS.battery}"></i>Battery in / out</span><b>${fmt.kwh(t.battery_charge)} / ${fmt.kwh(t.battery_discharge)}</b></div>
    <div class="row"><span class="k">Standing charges</span><b>${fmt.gbp(t.standing_cost)}</b></div>
  </div>`;

  // Carbon: imports carry the grid's regional intensity at that half-hour; solar and battery-from-solar carry none.
  const kg = (g) => fmt.kg(g);
  const importIntensity = t.import_with_carbon ? t.carbon_g / t.import_with_carbon : null;
  const cleaner = importIntensity != null && t.carbon_avg ? 1 - importIntensity / t.carbon_avg : null;
  const avoidedShare = t.carbon_grid_only_g ? t.carbon_saved_g / t.carbon_grid_only_g : null;
  const carbonCard = t.carbon_avg == null ? '<div class="skeleton">No carbon data for this period yet.</div>' : `
    <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div class="kpi"><div class="label">Emitted</div><div class="value">${kg(t.carbon_g)}</div><div class="sub">from ${fmt.kwh(t.import_with_carbon)} of grid power</div></div>
      ${t.carbon_saved_g >= 0
        ? `<div class="kpi"><div class="label">Avoided</div><div class="value" style="color:var(--good)">${kg(t.carbon_saved_g)}</div><div class="sub">${fmt.pct(avoidedShare)} less than grid-only (${kg(t.carbon_grid_only_g)})</div></div>`
        : `<div class="kpi"><div class="label">Extra so far</div><div class="value">${kg(-t.carbon_saved_g)}</div><div class="sub">battery charged from the grid; offsets when it is used</div></div>`}
    </div>
    <div class="rows" style="margin-top:12px">
      <div class="row"><span class="k">Carbon in the power imported</span><b>${importIntensity != null ? `${Math.round(importIntensity)} g/kWh` : '–'}</b></div>
      <div class="row"><span class="k">Grid average over the period</span><b>${Math.round(t.carbon_avg)} g/kWh <span class="faint">(${Math.round(t.carbon_min)}–${Math.round(t.carbon_max)})</span></b></div>
      <div class="row"><span class="k">Timing of imports</span><b style="color:${cleaner == null ? 'inherit' : cleaner >= 0 ? 'var(--good)' : 'var(--bad)'}">${cleaner == null ? '–' : `${fmt.pct(Math.abs(cleaner))} ${cleaner >= 0 ? 'cleaner' : 'dirtier'} than average`}</b></div>
      <div class="row"><span class="k">Exported power displaced</span><b>≈ ${kg(t.carbon_export_displaced_g)}</b></div>
      <div class="row"><span class="k">Carbon per kWh the home used</span><b>${t.home ? `${Math.round(t.carbon_g / t.home)} g/kWh` : '–'}</b></div>
    </div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">Avoided = the home’s use at grid intensity minus what was imported. Export displacement is shown separately and not added, since it depends on what the grid would otherwise have run.
    Regional history from NESO is its forecast for each half-hour (no regional actuals are published), so these half-hours are marked estimated.${t.carbon_missing ? ` ${t.carbon_missing} half-hours have no carbon value.` : ''}</p>`;

  const L = b.ledger;
  const sum = (k) => L.reduce((s, d) => s + (d[k] || 0), 0);
  const mixBar = (d) => (d.home ? `<div class="mix">${[[d.solar_to_home, COLORS.solar], [d.battery_to_home, COLORS.battery], [d.grid_to_home, COLORS.grid]].map(([v, c]) => `<i style="width:${((v || 0) / d.home) * 100}%;background:${c}"></i>`).join('')}</div>` : '');
  const stateBadge = (d) => (d.slots_missing ? `<span class="badge bad">${d.slots_missing} missing</span>` : d.slots_provisional ? `<span class="badge warn">provisional</span>` : '<span class="badge good">final</span>');
  const ledger = `<div class="table-wrap"><table>
    <thead><tr><th>Day</th><th class="r">Produced</th><th class="r">Used</th><th>Home from</th><th class="r">Imported</th><th class="r">Exported</th><th class="r">Battery in / out</th><th class="r">Bill</th><th class="r">Saved</th><th class="r">CO₂</th><th>Data</th></tr></thead>
    <tbody>${L.map((d) => `<tr><td>${tf.date(d.local_date)}</td><td class="r">${fmt.kwh(d.solar)}</td><td class="r">${fmt.kwh(d.home)}</td><td>${mixBar(d)}</td>
      <td class="r">${fmt.kwh(d.grid_import)} <span class="faint">${fmt.gbp((d.grid_to_home_cost || 0) + (d.grid_to_battery_cost || 0))}</span></td>
      <td class="r">${fmt.kwh(d.grid_export)} <span class="faint">${fmt.gbp(d.export_credit)}</span></td>
      <td class="r">${fmt.kwh(d.battery_charge)} / ${fmt.kwh(d.battery_discharge)}</td><td class="r"><b>${fmt.gbp(d.total_cost)}</b></td><td class="r" style="color:var(--good)">${fmt.gbp(d.saving)}</td><td class="r">${fmt.kg(d.carbon_g)}</td><td>${stateBadge(d)}</td></tr>`).join('')}
      <tr class="total" style="font-weight:600"><td>Total</td><td class="r">${fmt.kwh(sum('solar'))}</td><td class="r">${fmt.kwh(sum('home'))}</td><td>${mixBar({ home: sum('home'), solar_to_home: sum('solar_to_home'), battery_to_home: sum('battery_to_home'), grid_to_home: sum('grid_to_home') })}</td>
      <td class="r">${fmt.kwh(sum('grid_import'))} <span class="faint">${fmt.gbp(sum('grid_to_home_cost') + sum('grid_to_battery_cost'))}</span></td><td class="r">${fmt.kwh(sum('grid_export'))} <span class="faint">${fmt.gbp(sum('export_credit'))}</span></td>
      <td class="r">${fmt.kwh(sum('battery_charge'))} / ${fmt.kwh(sum('battery_discharge'))}</td><td class="r">${fmt.gbp(sum('total_cost'))}</td><td class="r" style="color:var(--good)">${fmt.gbp(sum('saving'))}</td><td class="r">${fmt.kg(sum('carbon_g'))}</td><td></td></tr>
    </tbody></table></div>`;

  document.getElementById('content').innerHTML = `
    ${story}
    <div class="section">${card('<div class="q">Who produced → who used</div>Energy flows', 'Band width is energy. Hover a band for its kWh and money.', '<div id="sankey"></div>')}</div>
    <div class="section grid cols-2">
      ${card('<div class="q">How it got there</div>Every flow, in kWh and £', 'Rows are where energy came from, columns where it went.', matrix(fl, t))}
      ${card('<div class="q">At a glance</div>Production, usage, import, export', periodText, glance)}
    </div>
    <div class="section grid cols-2">
      ${card('<div class="q">Why the bill is lower</div>From grid-only to the actual bill', `Each step is one reason; they add up exactly${Math.abs(check) > 1 ? ` (off by ${fmt.gbp(check)})` : ''}.${t.unpriced ? ` ${t.unpriced} unpriced half-hours left out.` : ''}`, '<div id="waterfall"></div>')}
      ${card('<div class="q">What each kWh cost</div>Price per kWh by source', 'Including VAT', `${hbars(priceRows, { format: (v) => fmt.pkwh(v) })}
        <h3 style="margin:18px 0 8px">Imports by price paid</h3>${hbars(bandRows, { max: bandMax, format: (v) => fmt.kwh(v) })}`)}
    </div>
    <div class="section">${card('<div class="q">When</div>An average day', `Each half-hour averaged over ${b.days} day${b.days === 1 ? '' : 's'}. Above the line: what powered the home. Below: where spare energy went. Line: solar produced.`,
      `${legend([{ label: 'Solar', color: COLORS.solar }, { label: 'Battery', color: COLORS.battery }, { label: 'Grid', color: COLORS.grid }, { label: 'Into battery', color: COLORS.battery, faded: true }, { label: 'Exported', color: COLORS.export }, { label: 'Solar produced', color: COLORS.solar, type: 'line' }])}<div id="profile"></div>
       <h3 style="margin:14px 0 6px">Price at that time of day</h3>${legend([{ label: 'Import', color: COLORS.grid, type: 'line' }, { label: 'Export', color: COLORS.export, type: 'line' }])}<div id="profile-price"></div>`)}</div>
    <div class="section grid cols-main">
      ${card('<div class="q">When the grid is cleanest</div>Grid carbon by time of day', `Regional grid carbon intensity (${esc(state.site.postcode || '')}, NESO), averaged by half-hour, with the home's average import below.`, `${legend([{ label: 'Carbon intensity (g/kWh)', color: 'var(--text)', type: 'line' }])}<div id="carbon-profile"></div><div style="margin-top:10px">${legend([{ label: 'Imported', color: COLORS.grid }])}</div><div id="carbon-import"></div>`)}
      ${card('<div class="q">Carbon impact</div>CO₂ from this home’s electricity', periodText, carbonCard)}
    </div>
    <div class="section">${card('<div class="q">Day by day</div>Ledger', b.from === b.to ? 'Last 7 days' : periodText, ledger)}</div>`;

  const fmtLink = (f) => tipHtml(`${SRC.find((s) => s.key === f.from).label} → ${DST.find((d) => d.key === f.to).label}`, [
    ['Energy', null, fmt.kwh(f.kwh, 2)],
    [f.what[0].toUpperCase() + f.what.slice(1), null, fmt.gbp(f.money)],
    f.kwh > 0.01 && f.money ? ['Per kWh', null, fmt.pkwh(f.money / f.kwh)] : null,
    f.from === 'battery' && f.to === 'home' ? ['Worth at grid price', null, fmt.gbp(t.battery_avoided)] : null,
  ]);
  sankey(document.getElementById('sankey'), {
    height: 300,
    left: [
      { key: 'solar', label: 'Solar produced', color: COLORS.solar },
      { key: 'battery', label: 'Battery supplied', color: COLORS.battery },
      { key: 'grid', label: 'Grid imported', color: COLORS.grid },
    ],
    right: [
      { key: 'home', label: 'Home used', color: 'var(--text-2)' },
      { key: 'battery', label: 'Battery stored', color: COLORS.battery },
      { key: 'export', label: 'Exported', color: COLORS.export },
    ],
    links: fl.map((f) => ({ from: f.from, to: f.to, value: f.kwh, color: SRC.find((s) => s.key === f.from).color, tip: fmtLink(f) })),
    nodeNote: (n) => {
      const money = { solar: null, battery: null, grid: (t.grid_to_home_cost || 0) + (t.grid_to_battery_cost || 0), home: null, export: t.export_credit }[n.key];
      return `${fmt.kwh(n.value)}${money != null ? ` · ${fmt.gbp(money)}` : ''}`;
    },
  });
  waterfall(document.getElementById('waterfall'), { steps, format: (v, axis) => (axis ? `£${(v / 100).toFixed(Math.abs(v) < 1000 ? 2 : 0)}` : fmt.gbp(v)) });

  const tick = (r) => (r.index % 6 === 0 ? `${String(r.index / 2).padStart(2, '0')}:00` : null);
  const head = (r) => `${String(Math.floor(r.index / 2)).padStart(2, '0')}:${r.index % 2 ? '30' : '00'} on an average day`;
  timeChart(document.getElementById('profile'), {
    rows: b.profile, height: 230, unit: 'kWh', tick,
    pos: [
      { label: 'Solar', color: COLORS.solar, get: (r) => r.solar_to_home },
      { label: 'Battery', color: COLORS.battery, get: (r) => r.battery_to_home },
      { label: 'Grid', color: COLORS.grid, get: (r) => r.grid_to_home },
    ],
    neg: [
      { label: 'Into battery', color: 'color-mix(in srgb, var(--battery) 45%, var(--surface))', get: (r) => (r.solar_to_battery || 0) + (r.grid_to_battery || 0) },
      { label: 'Exported', color: COLORS.export, get: (r) => r.grid_export },
    ],
    lines: [{ label: 'Solar produced', color: COLORS.solar, get: (r) => r.solar, width: 1.75 }],
    tip: (r) => tipHtml(head(r), [
      ['Home used', null, fmt.kwh(r.home, 2)],
      ['from solar', COLORS.solar, fmt.kwh(r.solar_to_home, 2)], ['from battery', COLORS.battery, fmt.kwh(r.battery_to_home, 2)], ['from grid', COLORS.grid, fmt.kwh(r.grid_to_home, 2)],
      ['Solar produced', COLORS.solar, fmt.kwh(r.solar, 2)],
      ((r.solar_to_battery || 0) + (r.grid_to_battery || 0)) > 0.005 ? ['Into battery', COLORS.battery, fmt.kwh((r.solar_to_battery || 0) + (r.grid_to_battery || 0), 2)] : null,
      r.grid_export > 0.005 ? ['Exported', COLORS.export, fmt.kwh(r.grid_export, 2)] : null,
      ['Import price', null, fmt.pkwh(r.import_rate)],
    ]),
  });
  timeChart(document.getElementById('profile-price'), {
    rows: b.profile, height: 140, unit: 'p/kWh', tick, yMin: 0,
    lines: [{ label: 'Import', color: COLORS.grid, get: (r) => r.import_rate, step: true }, { label: 'Export', color: COLORS.export, get: (r) => r.export_rate, step: true }],
    tip: (r) => tipHtml(head(r), [['Import', COLORS.grid, fmt.pkwh(r.import_rate)], ['Export', COLORS.export, fmt.pkwh(r.export_rate)]]),
  });
  timeChart(document.getElementById('carbon-profile'), {
    rows: b.profile, height: 150, unit: 'g/kWh', tick, yMin: 0,
    lines: [{ label: 'Carbon intensity', color: 'var(--text)', get: (r) => r.carbon_intensity, area: true }],
    tip: (r) => tipHtml(head(r), [['Grid carbon', null, r.carbon_intensity != null ? `${Math.round(r.carbon_intensity)} g/kWh` : '–'], ['Home imported', COLORS.grid, fmt.kwh(r.grid_import, 2)]]),
  });
  timeChart(document.getElementById('carbon-import'), {
    rows: b.profile, height: 110, unit: 'kWh', tick,
    pos: [{ label: 'Imported', color: COLORS.grid, get: (r) => r.grid_import }],
    tip: (r) => tipHtml(head(r), [['Imported', COLORS.grid, fmt.kwh(r.grid_import, 2)], ['Grid carbon', null, r.carbon_intensity != null ? `${Math.round(r.carbon_intensity)} g/kWh` : '–']]),
  });
}

init({ page: 'breakdown', title: 'Breakdown', subtitle: 'Who produced the energy, who used it, how it got there, when, and what each part cost or earned.', render });
