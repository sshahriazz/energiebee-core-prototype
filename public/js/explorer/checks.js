// Validation checks in words: "Source says X, we have Y, difference Z, tolerance T: PASS", with the
// how, the explanation and links to the evidence. Shared by the Overview and the Slot inspector.
import { esc, val, valText, checkBadge, CHECK, CHECK_ORDER, rawBtn, seriesLink, slotLink, T, count, tolText, hashOf } from './util.js';

export const GROUP = { source: 'Source vs us', consistency: 'Adds up', price: 'Price', forecast: 'Forecast' };
export const GROUP_NOTE = {
  source: 'An independent source measured the same thing.',
  consistency: 'Our own numbers must agree with each other.',
  price: 'The price we used must match the published tariff.',
  forecast: 'How close the forecast came (forecasts are often off; this rarely means our data is wrong).',
};

function evidence(e = {}, { slot = true } = {}) {
  const bits = [];
  if (e.raw_id != null) bits.push(rawBtn(e.raw_id));
  if (e.series_id != null) bits.push(seriesLink(e.series_id));
  if (slot && e.ts != null) bits.push(slotLink(e.ts));
  if (e.table) bits.push(`<span class="mono">${esc(e.table)}${e.rate_id != null ? ` row ${esc(e.rate_id)}` : e.id != null ? ` row ${esc(e.id)}` : ''}</span>`);
  return bits.length ? `<p class="xp-evid"><span>Evidence:</span> ${bits.join(' · ')}</p>` : '';
}

export function checkHtml(c, { slot = true } = {}) {
  const u = c.unit || '';
  const has = c.source_value != null || c.our_value != null;
  const line = has ? `<p class="xp-cline">Source says <b>${val(c.source_value, u)}</b>, we have <b>${val(c.our_value, u)}</b>, difference <b>${val(c.diff, u)}</b>${c.tolerance != null ? `, tolerance <b>${tolText(c.tolerance, u)}</b>` : ''}.</p>` : '';
  return `<li class="xp-check is-${esc(c.status)}">
    <div class="xp-chead">${checkBadge(c.status)} <b class="xp-ctitle">${esc(c.title || c.id)}</b>${c.group ? ` <span class="pill">${esc(GROUP[c.group] || c.group)}</span>` : ''}${c.date ? ` <a class="xp-link" href="${esc(hashOf('timeline', '', { from: c.date, to: c.date }))}">${esc(T.date(c.date))}</a>` : slot && c.evidence?.ts != null ? ` <span class="faint">${esc(T.dayTime(c.evidence.ts))}</span>` : ''}${c.slots ? ` <span class="faint">${['fail', 'warn', 'pass', 'skip'].filter((k) => c.slots[k]).map((k) => `${count(c.slots[k])} ${k}`).join(', ')}</span>` : ''}</div>
    ${line}${c.explanation ? `<p class="xp-cexp">${esc(c.explanation)}</p>` : ''}
    ${c.how ? `<p class="xp-how"><span>How we check:</span> ${esc(c.how)}</p>` : ''}
    ${evidence(c.evidence, { slot })}</li>`;
}

export function checkText(c) {
  const u = c.unit || '';
  const word = (CHECK[c.status] || [])[2] || String(c.status).toUpperCase();
  const has = c.source_value != null || c.our_value != null;
  return `[${word}] ${c.title || c.id}${has ? `: source says ${valText(c.source_value, u)}, we have ${valText(c.our_value, u)}, difference ${valText(c.diff, u)}${c.tolerance != null ? `, tolerance ±${valText(c.tolerance, u)}` : ''}` : ''}.${c.explanation ? ` ${c.explanation}` : ''}`;
}

/** Four counts as words on badges. */
export function summaryHtml(s = {}) {
  const total = CHECK_ORDER.reduce((a, k) => a + (s[k] || 0), 0);
  if (!total) return '<span class="faint">No checks have run.</span>';
  return `<span class="xp-csum">${CHECK_ORDER.map((k) => `<span class="xp-cchip${s[k] ? '' : ' zero'}" title="${esc(`${CHECK[k][2]}: ${CHECK[k][3]}`)}"><b>${count(s[k] || 0)}</b> ${checkBadge(k)}</span>`).join('')}</span>`;
}
export const CHECK_KEY = `<dl class="xp-ckey">${CHECK_ORDER.map((k) => `<div><dt>${checkBadge(k)}</dt><dd>${esc(CHECK[k][3])}</dd></div>`).join('')}</dl>`;

/** Checks grouped by group, problems first inside each. */
export function groupedChecksHtml(checks, { slot = true } = {}) {
  if (!checks?.length) return '<p class="faint">No checks for this selection.</p>';
  const groups = [...new Set(checks.map((c) => c.group || 'other'))].sort((a, b) => Object.keys(GROUP).indexOf(a) - Object.keys(GROUP).indexOf(b));
  const rank = (c) => { const i = CHECK_ORDER.indexOf(c.status); return i < 0 ? 9 : i; };
  return groups.map((g) => {
    const list = checks.filter((c) => (c.group || 'other') === g).sort((a, b) => rank(a) - rank(b));
    return `<div class="xp-cgroup"><h3>${esc(GROUP[g] || g)} <span class="faint">${esc(GROUP_NOTE[g] || '')}</span></h3><ul class="xp-checks">${list.map((c) => checkHtml(c, { slot })).join('')}</ul></div>`;
  }).join('');
}
