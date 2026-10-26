// Slot inspector: one slot, explained step by step in plain words. A navigator (previous / next, a day
// and a time, an optional "as known at" moment), a header (local time, state, quality flags in words,
// whether recomputing it now gives the stored numbers), the numbered steps (explanation first, then the
// formula, the inputs with links to their series and raw file, the working and the result), where each
// kWh came from and went, the price breakdown, the validation checks, and a "copy as text" button.
import {
  ctx, get, ep, loading, errorBox, loadOverview, T, esc, writeHash, readHash, addDays, dataRange, dateBounds, localDate, fromLocal,
  val, valText, num, rawBtn, seriesLink, stateBadge, STATE, slotsOfDay, slotLabel, hashOf, toLocalInput, fromLocalInput, count, plural, nice, loadVariables,
} from './util.js';
import { flows, flowsListHtml, nodeLabel } from './charts.js';
import { groupedChecksHtml, summaryHtml, checkText, CHECK_KEY } from './checks.js';
import { priceUnit, minorSymbol, slotNoun, SlotNoun, originBadge } from '../api.js';

let built = false;
const s = { slot: null, asof: '' };
let data = null; let checks = null; let checksErr = null;
export function reset() { built = false; s.slot = null; s.asof = ''; data = null; checks = null; checksErr = null; }
export const hashState = () => ({ value: s.slot ?? '', params: { site: ctx.siteId, asof: s.asof } });
const keepHash = (push = false) => { if (readHash().tab === 'slot') writeHash('slot', s.slot ?? '', { site: ctx.siteId, asof: s.asof }, { push }); };

function defaultSlot() {
  const { first, last } = dataRange();
  if (!last) return null;
  const day = first && first < last ? addDays(last, -1) : last;
  return fromLocal(day, first && first < last ? 12 * 60 : 0);
}

// ───── Pieces ─────
const sentence = (t) => esc(String(t ?? '').trim());
const word = (name) => String(name ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** One value: the number with its unit, or the item's note when it has no number (e.g. "import source: octopus_meter"). */
const itemVal = (x) => (x.value == null && x.note && !x.unit ? `<span class="xp-noteval">${esc(nice(x.note))}</span>` : val(x.value, x.unit));
const SHOW = 8;
function inputLi(x) {
  const links = [x.series_id != null ? seriesLink(x.series_id) : '', x.raw_id != null ? rawBtn(x.raw_id) : ''].filter(Boolean).join(' · ');
  return `<li><span class="xp-io-name">${esc(nice(x.name))}</span><b class="xp-io-val">${itemVal(x)}</b>
    <span class="xp-io-src">${x.source ? `from <span class="mono">${esc(x.source)}</span>` : ''}${links ? `${x.source ? ' · ' : ''}${links}` : ''}${x.recorded_at != null ? ` · <span class="faint">learnt ${esc(T.stamp(x.recorded_at))}</span>` : ''}</span>
    ${x.note && (x.value != null || x.unit) ? `<span class="xp-io-note">${esc(x.note)}</span>` : ''}</li>`;
}
function inputsHtml(list = []) {
  if (!list.length) return '';
  const head = list.slice(0, SHOW); const rest = list.slice(SHOW);
  return `<div class="xp-io-wrap"><h4>Inputs <span class="faint">(${count(list.length)})</span></h4><ul class="xp-io">${head.map(inputLi).join('')}</ul>
    ${rest.length ? `<details class="xp-details xp-more"><summary>Show the other ${count(rest.length)} inputs</summary><ul class="xp-io">${rest.map(inputLi).join('')}</ul></details>` : ''}</div>`;
}
const kvHtml = (title, list = [], cls = '') => (!list.length ? '' : `<div class="xp-kv-wrap ${cls}"><h4>${esc(title)}</h4><dl class="xp-kv">${list.map((x) => `<div><dt>${esc(nice(x.name))}</dt><dd>${itemVal(x)}</dd></div>`).join('')}</dl></div>`);

function stepHtml(st, i) {
  return `<li class="xp-step" id="xp-step-${esc(st.id)}">
    <span class="xp-step-n" aria-hidden="true">${i + 1}</span>
    <div class="xp-step-body">
      <h3><span class="sr-only">Step ${i + 1}: </span>${esc(st.title || st.id)}</h3>
      ${st.plain_explanation ? `<p class="xp-plain">${sentence(st.plain_explanation)}</p>` : ''}
      ${st.formula ? `<p class="xp-formula"><span>The rule</span><code>${esc(st.formula)}</code></p>` : ''}
      ${inputsHtml(st.inputs)}
      ${kvHtml('Working', st.intermediates)}
      ${kvHtml('Result', st.result, 'result')}
    </div></li>`;
}

const priceVal = (v) => (v == null ? '<span class="faint">–</span>' : `${num(v, 2)}&nbsp;${esc(priceUnit())}`);
const humanKey = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
function taxLine(l) {
  const v = l.kind === 'percent' ? val(l.value, 'fraction') : l.kind === 'per_kwh' ? priceVal(l.value) : `${num(l.value)} ${esc(minorSymbol())}${l.charge_period ? ` per ${esc(l.charge_period)}` : ''}`;
  return `<div><dt>${esc(String(l.code || l.name || 'tax').toUpperCase())}${l.applies_to && l.applies_to !== 'all' ? ` <span class="faint">on ${esc(l.applies_to)}</span>` : ''} ${l.origin ? originBadge(l.origin) : ''}${l.unverified ? ' <span class="badge warn">not verified</span>' : ''}</dt><dd>${v}</dd></div>`;
}
function tariffHtml(title, p) {
  if (!p || typeof p !== 'object' || !Object.keys(p).length) return '';
  if (p.unit_ex == null && p.inc == null && !p.pieces) return `<div class="xp-price"><h3>${esc(title)}</h3>${genericKv(p)}</div>`;
  const pieces = (p.pieces || []).filter((x) => x && x.from != null);
  const span = pieces.length ? Math.max(1, pieces[pieces.length - 1].to - pieces[0].from) : 1;
  const lines = p.tax_lines || p.lines || [];
  return `<div class="xp-price"><h3>${esc(title)}${p.estimated ? ' <span class="badge warn">estimated price</span>' : ''}</h3>
    ${p.meaning ? `<p class="xp-foot">${esc(p.meaning.replace(/unit_ex x \(1 \+ vat\)/, 'unit price × (1 + tax)'))}</p>` : ''}
    <dl class="xp-kv">
      ${p.tariff ? `<div><dt>Tariff</dt><dd class="mono xp-wrap">${esc(p.tariff)}${p.register ? ` <span class="faint">· ${esc(p.register)} register</span>` : ''}</dd></div>` : ''}
      ${p.supply_ex != null && p.levy ? `<div><dt>Supplier's unit price</dt><dd>${priceVal(p.supply_ex)}</dd></div><div><dt>Per-kWh levy</dt><dd>+ ${priceVal(p.levy)}</dd></div>` : ''}
      <div><dt>Unit price before tax</dt><dd>${priceVal(p.unit_ex)}</dd></div>
      ${lines.map((l) => (l.code != null || l.kind ? taxLine(l) : `<div><dt>${esc(l.name)}</dt><dd>${typeof l.value === 'number' ? `+ ${priceVal(l.value)}` : esc(String(l.value ?? '–'))}</dd></div>`)).join('')}
      <div class="total"><dt>Unit price with tax</dt><dd>${priceVal(p.inc)}</dd></div>
    </dl>
    ${p.tax_unverified ? '<p class="xp-msg warn">A tax rule behind this price is not verified against an official source.</p>' : ''}
    ${p.weighted ? `<p class="xp-msg warn"><b>The price changed inside this ${esc(slotNoun())}.</b> We used the time-weighted average of the ${count(pieces.length)} prices below: each counts for the share of the ${esc(slotNoun())} it covered.</p>` : ''}
    ${pieces.length > 1 || p.weighted ? `<div class="xp-pieces" role="list" aria-label="Prices in force during the ${esc(slotNoun())}">${pieces.map((x) => `<div role="listitem" class="xp-piece" style="flex:${Math.max(0.05, (x.to - x.from) / span)}"><b>${priceVal(x.price)}</b><span>${esc(T.clock(x.from))}–${esc(T.clock(x.to))}</span>${x.rate?.raw_id != null ? `<span>${rawBtn(x.rate.raw_id, 'source file')}</span>` : ''}</div>`).join('')}</div>`
      : pieces.length === 1 ? `<p class="xp-foot">One price for the whole ${esc(slotNoun())}: ${priceVal(pieces[0].price)} with tax, from ${esc(T.clock(pieces[0].from))} to ${esc(T.clock(pieces[0].to))}${pieces[0].rate?.raw_id != null ? ` (${rawBtn(pieces[0].rate.raw_id, `rate from raw file #${pieces[0].rate.raw_id}`)})` : ''}.</p>` : ''}
  </div>`;
}
// Standing charge: the known keys in words, anything else as it comes.
const STANDING = [['tariff', 'Tariff', 'text'], ['per_day_ex', 'Per day before tax', 'minor/day'], ['vat', 'Tax', 'fraction'], ['per_day_inc', 'Per day with tax', 'minor/day'],
  ['gas_per_day_inc', 'Gas, per day with tax', 'minor/day'], ['n_slots_day', null, 'count'], ['day_length_s', 'Length of the day', 's'], ['per_slot', null, 'minor'], ['per_day', 'Per day', 'minor/day'], ['share', 'Share for this slot', 'minor']];
function standingHtml(p) {
  if (!p || typeof p !== 'object' || !Object.keys(p).length) return '';
  const known = new Set(STANDING.map(([k]) => k).concat(['formula', 'note', 'rate', 'fixed_periods']));
  const rows = STANDING.filter(([k]) => p[k] != null).map(([k, label, unit]) => {
    const lab = label || (k === 'n_slots_day' ? `${SlotNoun()}s in the day` : `Share for this ${slotNoun()}`);
    const v = unit === 'text' ? `<span class="mono xp-wrap">${esc(p[k])}</span>` : unit === 's' ? `${num(p[k] / 3600, 2)} hours` : val(p[k], unit === 'count' ? '' : unit);
    return `<div class="${k === 'per_slot' || k === 'share' ? 'total' : ''}"><dt>${esc(lab)}</dt><dd>${v}</dd></div>`;
  });
  const extra = Object.entries(p).filter(([k, v]) => !known.has(k) && v != null && typeof v !== 'object').map(([k, v]) => `<div><dt>${esc(humanKey(k))}</dt><dd>${typeof v === 'number' ? val(v) : esc(String(v))}</dd></div>`);
  return `<div class="xp-price"><h3>Standing charge</h3><dl class="xp-kv">${rows.join('')}${extra.join('')}</dl>
    ${p.formula ? `<p class="xp-formula"><span>The rule</span><code>${esc(p.formula)}</code></p>` : ''}${p.note ? `<p class="xp-foot">${esc(p.note)}</p>` : ''}
    ${p.rate?.raw_id != null ? `<p class="xp-foot">Read from ${rawBtn(p.rate.raw_id)}.</p>` : ''}</div>`;
}
function genericKv(o) {
  const rows = Object.entries(o).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && k !== 'note');
  return `<dl class="xp-kv">${rows.map(([k, v]) => `<div><dt>${esc(humanKey(k))}</dt><dd class="${typeof v === 'string' ? 'xp-wrap' : ''}">${typeof v === 'number' ? val(v) : esc(String(v))}</dd></div>`).join('')}</dl>${o.note ? `<p class="xp-foot">${esc(o.note)}</p>` : ''}`;
}
function batteryHtml(b) {
  if (!b || typeof b !== 'object') return '';
  const layers = (list) => (list || []).map((l) => `${num(l.kwh, 3)} kWh at ${l.price == null ? 'unknown cost' : `${num(l.price, 2)} ${esc(priceUnit())}`}`).join('; ') || 'empty';
  return `<div class="xp-price"><h3>Battery: what the stored energy cost</h3>
    <p class="xp-foot">Energy taken from the battery is priced at what it cost to put in, oldest first.</p>
    <dl class="xp-kv">
      ${b.capacity_kwh != null ? `<div><dt>Capacity</dt><dd>${val(b.capacity_kwh, 'kWh')}${b.capacity_source ? ` <span class="faint">(${esc(b.capacity_source)})</span>` : ''}</dd></div>` : ''}
      ${b.efficiency != null ? `<div><dt>Round-trip efficiency</dt><dd>${val(b.efficiency, 'fraction', 1)}</dd></div>` : ''}
      ${b.drawn_kwh != null ? `<div><dt>Drawn in this ${esc(slotNoun())}</dt><dd>${val(b.drawn_kwh, 'kWh')}</dd></div>` : ''}
      ${b.draw_cost != null ? `<div><dt>Cost of what was drawn</dt><dd>${val(b.draw_cost, 'minor')}</dd></div>` : ''}
      ${b.from_unknown_kwh ? `<div><dt>Drawn from stock of unknown cost</dt><dd>${val(b.from_unknown_kwh, 'kWh')}</dd></div>` : ''}
      ${b.soc_end != null ? `<div><dt>Charge level at the end</dt><dd>${val(b.soc_end, '%')}</dd></div>` : ''}
    </dl>
    ${b.efficiency_note ? `<p class="xp-foot">Efficiency: ${esc(b.efficiency_note)}</p>` : ''}
    ${b.stock_before || b.stock_after ? `<p class="xp-foot">Stock before: ${esc(layers(b.stock_before))}.<br>Stock after: ${esc(layers(b.stock_after))}.</p>` : ''}</div>`;
}

function diffsHtml(diffs = []) {
  if (!diffs.length) return '';
  const keys = [...new Set(diffs.flatMap((d) => Object.keys(d)))];
  return `<div class="table-wrap xp-scroll"><table class="xp-table"><caption class="sr-only">Stored and recomputed values that differ</caption><thead><tr>${keys.map((k) => `<th scope="col">${esc(humanKey(k))}</th>`).join('')}</tr></thead>
    <tbody>${diffs.map((d) => `<tr>${keys.map((k) => `<td class="${typeof d[k] === 'number' ? 'r' : 'mono'}">${typeof d[k] === 'object' && d[k] ? esc(JSON.stringify(d[k])) : val(d[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function matchBadge(d) {
  if (d.matches_stored === true) return '<span class="badge good xp-bigbadge"><span aria-hidden="true">✓</span> Matches the stored timeline</span>';
  if (d.matches_stored === false) return '<span class="badge bad xp-bigbadge"><span aria-hidden="true">✗</span> Differs from the stored timeline</span>';
  return '<span class="badge planned xp-bigbadge">Not recomputed</span>';
}

function headHtml(d) {
  const st = STATE[d.state];
  const bits = d.quality?.bits || [];
  const t = d.slot ?? s.slot;
  const date = localDate(t);
  const notes = Array.isArray(d.notes) ? d.notes : d.notes ? [d.notes] : [];
  return `<section class="card xp-slothead" aria-labelledby="xp-slot-h">
    <div class="xp-sh-top">
      <div><p class="q">${esc(SlotNoun())} · ${esc(d.timezone || ctx.tz)}</p><h2 id="xp-slot-h" class="xp-sh-time">${esc(slotLabel(t))}</h2>
        <p class="faint">${esc(Math.round((d.dur_s || ctx.slotS) / 60))} minutes · local time ${esc(d.local_time || T.stamp(t))} · ${esc(new Date(t * 1000).toISOString().replace('.000Z', 'Z'))} UTC</p></div>
      <div class="xp-sh-badges">${stateBadge(d.state)} ${matchBadge(d)}</div>
    </div>
    ${st ? `<p class="xp-plain"><b>${esc(st[1])}.</b> ${esc(st[2])}</p>` : ''}
    <div class="xp-qual"><h3>Quality flags <span class="faint">(value ${esc(d.quality?.value ?? '–')}${d.quality?.recomputed != null ? `; ${esc(d.quality.recomputed)} when recomputed now` : ''})</span></h3>${bits.length ? `<ul>${bits.map((b) => `<li><b>${esc(word(b.name))}</b>${b.meaning ? `: ${esc(b.meaning)}` : ''}${b.why ? `. <span class="xp-why">Here: ${esc(b.why)}.</span>` : ''} <span class="faint mono">bit ${esc(b.bit)}</span></li>`).join('')}</ul>` : '<p class="faint">No flags set.</p>'}</div>
    ${d.matches_stored === false ? `<div class="xp-msg bad"><b>Recomputing this ${esc(slotNoun())} now gives different numbers from the ones stored.</b> The stored timeline will change at the next rebuild, or the facts changed after it was built.${diffsHtml(d.diffs)}</div>`
      : d.matches_stored === true ? `<p class="xp-foot">We worked this ${esc(slotNoun())} out again from the stored facts just now and got exactly the stored numbers${d.lineage_matches === false ? ' (only the record of where they came from differs: see below)' : ''}.</p>` : ''}
    ${notes.length ? `<ul class="xp-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="xp-actions">
      <button type="button" class="btn btn-primary" id="slot-copy">Copy as text</button>
      <a class="btn" href="${esc(hashOf('timeline', '', { from: date, to: date }))}">See the day on the Timeline</a>
      <a class="btn" href="/data?site=${esc(ctx.siteId)}&slot=${esc(t)}#evidence">Open on Data &amp; trust</a>
      <span class="xp-copied" id="slot-copied" role="status" aria-live="polite"></span>
    </div>
    <textarea class="xp-copybox" id="slot-copybox" aria-label="The explanation as text" readonly hidden></textarea>
  </section>`;
}

function checksBlock() {
  if (checksErr) return errorBox('The checks could not be run', checksErr);
  if (!checks) return loading('Running the checks…');
  return `<div class="xp-vhead">${summaryHtml(checks.summary)}</div>${groupedChecksHtml(checks.checks, { slot: false })}`;
}

function bodyHtml(d) {
  const steps = d.steps || [];
  const pr = d.price || {};
  const anyPrice = Object.values(pr).some((x) => x && Object.keys(x).length);
  const mv = d.method_version; const rb = d.rebuild;
  return `${headHtml(d)}
    <section class="card section" aria-labelledby="xp-steps-h"><div class="card-head"><div><h2 id="xp-steps-h">How the numbers were worked out</h2><p>${plural(steps.length, 'step', 'steps')}, in the order the core does them. Each says what happens in plain words first, then the rule and the numbers.</p></div></div>
      ${steps.length ? `<ol class="xp-steps">${steps.map(stepHtml).join('')}</ol>` : '<p class="faint">No steps were returned for this slot.</p>'}</section>
    <div class="grid cols-2 xp-pair">
      <section class="card section" aria-labelledby="xp-flows-h"><div class="card-head"><div><h2 id="xp-flows-h">Where each kWh came from and went</h2><p>Left: where the energy came from. Right: where it went. Band width is the amount.</p></div></div>
        <div id="slot-flows"></div>${flowsListHtml(d.flows)}${batteryHtml(d.battery)}</section>
      <section class="card section" aria-labelledby="xp-price-h"><div class="card-head"><div><h2 id="xp-price-h">The prices</h2><p>The unit prices in force, every tax line, and the share of the daily standing charge.</p></div></div>
        ${tariffHtml('Import', pr.import)}${tariffHtml('Export', pr.export)}${standingHtml(pr.standing)}${tariffHtml('Gas', pr.gas)}
        ${!anyPrice ? '<p class="faint">No price information for this slot.</p>' : ''}</section>
    </div>
    <section class="card section" aria-labelledby="xp-val-h"><div class="card-head"><div><h2 id="xp-val-h">Validation: does it agree with independent sources?</h2><p>Each check says what the other source says, what we have, the difference and how much difference is allowed.</p></div></div>
      ${CHECK_KEY}<div id="slot-checks" aria-live="polite">${checksBlock()}</div></section>
    <section class="card section"><details class="xp-details"><summary>Every stored number for this ${esc(slotNoun())}, and where it came from</summary>
      ${mv || rb ? `<dl class="xp-kv xp-kv-one">${mv ? `<div><dt>Built with method</dt><dd class="mono xp-wrap">${esc(typeof mv === 'object' ? `${mv.stored ?? '–'} (current ${mv.current ?? '–'})` : mv)}</dd></div>` : ''}${rb ? `<div><dt>Recomputed over</dt><dd>${esc(T.date(rb.from))} to ${esc(T.date(rb.to))}${rb.ms != null ? `, in ${esc(rb.ms)} ms` : ''}</dd></div>` : ''}${(rb?.approximations || []).length ? `<div><dt>Approximations</dt><dd class="xp-wrap">${rb.approximations.map((x) => esc(typeof x === 'string' ? x : JSON.stringify(x))).join('; ')}</dd></div>` : ''}</dl>` : ''}
      ${d.row ? `<div class="table-wrap xp-scroll xp-tall"><table class="xp-table"><thead><tr><th scope="col">Column</th><th scope="col" class="r">Stored</th>${d.recomputed ? '<th scope="col" class="r">Recomputed now</th>' : ''}</tr></thead><tbody>
        ${Object.keys(d.row).filter((k) => k !== 'lineage').map((k) => { const a = d.row[k]; const b = d.recomputed?.[k]; const diff = d.recomputed && k !== 'built_at' && JSON.stringify(a) !== JSON.stringify(b); return `<tr class="${diff ? 'xp-diffrow' : ''}"><th scope="row" class="mono">${esc(k)}</th><td class="r">${typeof a === 'object' && a ? `<span class="mono">${esc(JSON.stringify(a))}</span>` : val(a)}</td>${d.recomputed ? `<td class="r">${typeof b === 'object' && b ? `<span class="mono">${esc(JSON.stringify(b))}</span>` : val(b)}${diff ? ' <span class="badge bad">differs</span>' : ''}</td>` : ''}</tr>`; }).join('')}
        </tbody></table></div>` : ''}
      ${(d.lineage_diffs || []).length ? `<h4>Where-from record that differs</h4>${diffsHtml(d.lineage_diffs)}` : ''}
      ${d.lineage ? `<h4>Lineage</h4><dl class="xp-kv xp-kv-one">${Object.entries(typeof d.lineage === 'string' ? (() => { try { return JSON.parse(d.lineage); } catch { return { lineage: d.lineage }; } })() : d.lineage).map(([k, v]) => `<div><dt class="mono">${esc(k)}</dt><dd class="mono xp-wrap">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</dd></div>`).join('')}</dl>` : ''}
    </details></section>`;
}

function asText(d) {
  const L = [];
  const t = d.slot ?? s.slot;
  const tv = (x) => (x.value == null && x.note && !x.unit ? x.note : valText(x.value, x.unit));
  L.push(`${SlotNoun()} ${slotLabel(t)} (${ctx.tz}; local ${d.local_time || ''})`);
  L.push(`State: ${STATE[d.state]?.[1] || d.state}. ${STATE[d.state]?.[2] || ''}`);
  L.push(`Quality flags: ${(d.quality?.bits || []).map((b) => `${word(b.name)}${b.why ? ` (${b.why})` : ''}`).join(', ') || 'none'}`);
  L.push(d.matches_stored === true ? 'Recomputed now: matches the stored timeline.' : d.matches_stored === false ? `Recomputed now: DIFFERS from the stored timeline (${(d.diffs || []).map((x) => JSON.stringify(x)).join('; ')}).` : 'Not recomputed.');
  for (const n of Array.isArray(d.notes) ? d.notes : []) L.push(`Note: ${n}`);
  if (s.asof) L.push(`As known at ${T.stamp(Number(s.asof))}.`);
  L.push('');
  (d.steps || []).forEach((st, i) => {
    L.push(`${i + 1}. ${st.title || st.id}`);
    if (st.plain_explanation) L.push(`   ${st.plain_explanation}`);
    if (st.formula) L.push(`   Rule: ${st.formula}`);
    for (const x of st.inputs || []) L.push(`   - ${nice(x.name)}: ${tv(x)}${x.source ? ` (from ${x.source}${x.series_id != null ? `, series #${x.series_id}` : ''}${x.raw_id != null ? `, raw file #${x.raw_id}` : ''})` : ''}${x.note && (x.value != null || x.unit) ? `. ${x.note}` : ''}`);
    for (const x of st.intermediates || []) L.push(`   · ${nice(x.name)}: ${tv(x)}`);
    for (const x of st.result || []) L.push(`   = ${nice(x.name)}: ${tv(x)}`);
    L.push('');
  });
  const fl = (d.flows || []).filter((f) => f.kwh > 0);
  if (fl.length) { L.push('Where the energy went:'); for (const f of fl) L.push(`   ${nodeLabel(f.from)} → ${nodeLabel(f.to)}: ${num(f.kwh, 3)} kWh`); L.push(''); }
  for (const [k, p] of Object.entries(d.price || {})) {
    if (!p || !Object.keys(p).length) continue;
    const taxes = (p.tax_lines || p.lines || []).map((l) => `${l.code || l.name} ${l.kind === 'percent' ? valText(l.value, 'fraction') : typeof l.value === 'number' ? num(l.value, 2) : l.value}`);
    const bits = [p.tariff ? `tariff ${p.tariff}` : '', p.unit_ex != null ? `${num(p.unit_ex, 2)} ${priceUnit()} before tax` : '', ...taxes, p.inc != null ? `${num(p.inc, 2)} ${priceUnit()} with tax` : '', p.weighted ? 'time-weighted average' : '',
      ...(p.unit_ex == null && p.inc == null ? Object.entries(p).filter(([, v]) => v != null && typeof v !== 'object').map(([kk, v]) => `${humanKey(kk)} ${typeof v === 'number' ? num(v) : v}`) : [])].filter(Boolean);
    L.push(`Price, ${k}: ${bits.join('; ')}`);
  }
  if (checks?.checks?.length) { L.push(''); L.push('Validation:'); for (const c of checks.checks) L.push(`   ${checkText(c)}`); }
  return L.join('\n');
}

async function copyText() {
  const txt = asText(data);
  const out = document.getElementById('slot-copied');
  const box = document.getElementById('slot-copybox');
  try {
    await navigator.clipboard.writeText(txt);
    out.textContent = 'Copied to the clipboard.';
    box.hidden = true;
  } catch {
    box.hidden = false; box.value = txt; box.focus(); box.select();
    out.textContent = 'The browser blocked copying: the text is selected below, press Ctrl+C or ⌘C.';
  }
  setTimeout(() => { if (out.isConnected) out.textContent = ''; }, 6000);
}

// ───── Navigator ─────
function navHtml() {
  return `<form class="xp-controls xp-nav" id="slot-nav" aria-label="Choose a ${esc(slotNoun())}">
    <button type="button" class="btn" data-step="-1" aria-label="Previous ${esc(slotNoun())}">← Previous</button>
    <label>Day<input type="date" id="slot-day" ${dateBounds()}></label>
    <label>Time<select id="slot-time"></select></label>
    <button type="button" class="btn" data-step="1" aria-label="Next ${esc(slotNoun())}">Next →</button>
    <label>As known at <span class="faint">(optional)</span><input type="datetime-local" id="slot-asof"></label>
    <button type="button" class="btn" id="slot-latest">Latest</button>
  </form>`;
}
function syncNav(panel) {
  const day = localDate(s.slot);
  panel.querySelector('#slot-day').value = day;
  const opts = slotsOfDay(day);
  const sel = panel.querySelector('#slot-time');
  sel.innerHTML = opts.map((o) => `<option value="${o.t}" ${o.t === s.slot ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  if (!opts.some((o) => o.t === s.slot)) sel.insertAdjacentHTML('afterbegin', `<option value="${s.slot}" selected>${esc(T.time(s.slot))} (off the grid)</option>`);
  panel.querySelector('#slot-asof').value = s.asof ? toLocalInput(Number(s.asof)) : '';
  panel.querySelector('#slot-latest').disabled = !s.asof;
}

async function load(panel) {
  const out = panel.querySelector('#slot-out');
  syncNav(panel);
  if (s.slot == null) { out.innerHTML = '<div class="xp-msg"><b>This home has no data</b><p>There is no slot to inspect yet.</p></div>'; return; }
  out.innerHTML = loading(`Working out ${slotLabel(s.slot)}…`);
  const want = s.slot; const asof = s.asof;
  checks = null; checksErr = null;
  const vReq = get(ep('validate', { slot: want })).then((v) => { checks = v; }).catch((err) => { checksErr = err; });
  try { data = await get(ep('slot', { slot: want, as_of_ms: asof })); } catch (err) {
    if (want !== s.slot) return;
    const { first, last } = dataRange();
    out.innerHTML = `${errorBox(`${SlotNoun()} ${slotLabel(want)} could not be explained`, err)}<p class="xp-foot">This home's data runs from ${esc(T.date(first))} to ${esc(T.date(last))}. Pick another ${esc(slotNoun())} above.</p>`;
    return;
  }
  if (want !== s.slot || asof !== s.asof) return;
  if (data.slot != null && data.slot !== s.slot) { s.slot = data.slot; keepHash(); syncNav(panel); }
  out.innerHTML = `${s.asof ? `<p class="xp-msg"><b>As known at ${esc(T.stamp(Number(s.asof)))}.</b> Facts the core learnt after that moment are left out.</p>` : ''}${bodyHtml(data)}`;
  flows(out.querySelector('#slot-flows'), { flows: data.flows || [], unit: 'kWh', label: `Energy flows in ${slotLabel(s.slot)}` });
  out.querySelector('#slot-copy').addEventListener('click', copyText);
  await vReq;
  if (want !== s.slot) return;
  const cb = out.querySelector('#slot-checks');
  if (cb) cb.innerHTML = checksBlock();
}

export async function show(panel, h) {
  if (!built) {
    built = true;
    panel.innerHTML = loading('Loading…');
    try { await loadOverview(); } catch { /* the range falls back to the home's days */ }
    try { await loadVariables(); } catch { /* names stay as the API gives them */ }
    panel.innerHTML = `<p class="xp-lead">Pick any ${esc(slotNoun())} to see how its numbers were worked out, from the providers' files to the bill, and whether independent sources agree. From the Timeline, select a bar or a row to land here.</p>
      ${navHtml()}<div id="slot-out" aria-live="polite"></div>`;
    wire(panel);
  }
  const v = Number(h?.value);
  const want = Number.isFinite(v) && v > 0 ? v : (s.slot ?? defaultSlot());
  const asof = h?.params?.get('asof') || '';
  if (data && want === s.slot && asof === s.asof && panel.querySelector('#slot-out .xp-slothead')) return;
  s.slot = want; s.asof = asof;
  if (!h?.value && s.slot != null) keepHash();
  await load(panel);
}

function wire(panel) {
  const go = (t, push = true) => { s.slot = t; keepHash(push); load(panel); };
  panel.querySelector('#slot-nav').addEventListener('submit', (e) => e.preventDefault());
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-step]');
    if (b && s.slot != null) { go(s.slot + Number(b.dataset.step) * ctx.slotS); b.focus(); return; }
    if (e.target.id === 'slot-latest') { s.asof = ''; keepHash(); load(panel); panel.querySelector('#slot-asof')?.focus(); }
  });
  panel.querySelector('#slot-day').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const oldMin = s.slot != null ? Math.round((s.slot - fromLocal(localDate(s.slot), 0)) / 60) : 12 * 60;
    const opts = slotsOfDay(e.target.value);
    const target = fromLocal(e.target.value, 0) + oldMin * 60;
    const pick = opts.reduce((a, o) => (Math.abs(o.t - target) < Math.abs(a.t - target) ? o : a), opts[0]);
    go(pick.t);
  });
  panel.querySelector('#slot-time').addEventListener('change', (e) => go(Number(e.target.value)));
  panel.querySelector('#slot-asof').addEventListener('change', (e) => { const ms = fromLocalInput(e.target.value); s.asof = ms ? String(ms) : ''; keepHash(); load(panel); });
}
