// Taxes and levies as ordered rules (the tax_rule table), applied to one slot's charges.
//
// A rule says: in this country, for this fuel, direction and customer class, from valid_from
// (inclusive) to valid_to (exclusive), charge `value` of `kind` on `applies_to`:
//   percent     value is a fraction (0.21 = 21 %) of the running total of the charges it
//               applies to (unit, fixed or all), INCLUDING every tax with a lower seq: a
//               per-kWh energy tax at seq 10 is itself taxed by VAT at seq 100. Rules with the
//               same seq are all worked out on the same running total.
//   per_kwh     value in minor units of `currency` per kWh; always on the unit charge.
//   per_period  value in minor units of `currency` per day, month or year (charge_period),
//               may be negative (the Dutch yearly heffingskorting is a credit). Pro-rated to
//               the slot: value x slot length / length of the LOCAL day, month or year the slot
//               is in, so the slots of a 23 h or 25 h day still add up to exactly one day.
//               Always on the fixed charge.
// Amounts stay in minor units with their fractions: nothing here rounds. Rows read from
// tax_rule can be passed as they are (same field names).
import { assertSameCurrency, currency as currencyOf } from './money.js';
import { GB_VAT_NOTE } from '../db/registry.js';

const KINDS = new Set(['percent', 'per_kwh', 'per_period']);
const APPLIES_TO = new Set(['unit', 'fixed', 'all']);
const PERIOD_LENGTH = { day: 'dayLengthS', month: 'monthLengthS', year: 'yearLengthS' };

// ───── Seed rules ─────

// GB VAT, identical to VAT_RATES in src/db/registry.js (the vat_rate table) — same rates and
// dates; test/tax-gb-vat.test.js keeps them in step. Octopus has published domestic
// electricity at 0 % VAT since 30 Sep 2026 23:00 UTC; gas is still 5 %, export 0 %.
const T_2026_10_01 = Date.UTC(2026, 8, 30, 23, 0) / 1000;
const GB_VAT_SOURCE = 'vat_rate (registry.js VAT_RATES)';
const gbVat = (fuel, direction, value, validFrom, validTo) => Object.freeze({
  country: 'GB', code: 'vat', fuel, direction, customer_class: 'domestic', applies_to: 'all',
  kind: 'percent', value, currency: null, charge_period: null, seq: 100,
  valid_from: validFrom, valid_to: validTo, source: GB_VAT_SOURCE, unverified: false,
  origin: 'sourced', origin_note: GB_VAT_NOTE,
});
export const GB_VAT_RULES = Object.freeze([
  gbVat('electricity', 'import', 0.05, 0, T_2026_10_01),
  gbVat('electricity', 'import', 0.0, T_2026_10_01, null),
  gbVat('electricity', 'export', 0.0, 0, null),
  gbVat('gas', 'import', 0.05, 0, null),
]);

// ── PLACEHOLDERS, NOT AUTHORITATIVE ──
// The FR and NL values below were written from memory to exercise the rule shapes (per-kWh
// levy, then VAT on top; a negative yearly credit). Every one is marked unverified: true and
// must be checked against the official source named in `source` before it prices anything.
// They are not written to the database by the deltas. Provenance: origin 'placeholder', with the
// `source` text as the note, wherever they are written (see src/core/provenance.js). Simplifications to resolve when
// verifying: NL energiebelasting is banded by yearly consumption (only the first band is
// here); FR CTA is a percentage of the transport part of the fixed charge only (left out).
const NL_2025 = { from: Date.UTC(2024, 11, 31, 23) / 1000, to: Date.UTC(2025, 11, 31, 23) / 1000 };
const FR_ACCISE_FROM = Date.UTC(2025, 0, 31, 23) / 1000;   // 1 Feb 2025, Paris
const FR_TVA_FROM = Date.UTC(2025, 6, 31, 22) / 1000;      // 1 Aug 2025, Paris
const placeholder = (r) => Object.freeze({
  customer_class: 'domestic', currency: null, charge_period: null, valid_to: null, ...r, unverified: true,
  origin: 'placeholder', origin_note: r.source,
});
export const PLACEHOLDER_TAX_RULES = Object.freeze([
  placeholder({
    country: 'NL', code: 'energiebelasting', fuel: 'electricity', direction: 'import', applies_to: 'unit',
    kind: 'per_kwh', value: 10.154, currency: 'EUR', seq: 10, valid_from: NL_2025.from, valid_to: NL_2025.to,
    source: 'UNVERIFIED placeholder (first band, ex BTW); verify against Belastingdienst "Tabellen tarieven milieubelastingen"',
  }),
  placeholder({
    country: 'NL', code: 'heffingskorting', fuel: 'electricity', direction: 'import', applies_to: 'fixed',
    kind: 'per_period', value: -63519, currency: 'EUR', charge_period: 'year', seq: 20,
    valid_from: NL_2025.from, valid_to: NL_2025.to,
    source: 'UNVERIFIED placeholder (vermindering energiebelasting, ex BTW); verify against Belastingdienst "Tabellen tarieven milieubelastingen"',
  }),
  placeholder({
    country: 'NL', code: 'btw', fuel: 'electricity', direction: 'import', applies_to: 'all',
    kind: 'percent', value: 0.21, seq: 100, valid_from: NL_2025.from, valid_to: NL_2025.to,
    source: 'UNVERIFIED placeholder; verify against Belastingdienst (btw-tarieven)',
  }),
  placeholder({
    country: 'FR', code: 'accise', fuel: 'electricity', direction: 'import', applies_to: 'unit',
    kind: 'per_kwh', value: 3.37, currency: 'EUR', seq: 10, valid_from: FR_ACCISE_FROM,
    source: 'UNVERIFIED placeholder (accise sur l\'electricite, menages); verify against douane.gouv.fr / Legifrance (CIBS)',
  }),
  placeholder({
    country: 'FR', code: 'tva', fuel: 'electricity', direction: 'import', applies_to: 'all',
    kind: 'percent', value: 0.20, seq: 100, valid_from: FR_TVA_FROM,
    source: 'UNVERIFIED placeholder (TVA on subscription and consumption); verify against impots.gouv.fr / Legifrance (CGI)',
  }),
]);

export const SEED_TAX_RULES = Object.freeze([...GB_VAT_RULES, ...PLACEHOLDER_TAX_RULES]);

// ───── Selecting and applying ─────

// The rules in force at ts for one country, fuel, direction and customer class, in seq order.
export function rulesFor(rules, { country, fuel, direction, customerClass = 'domestic', ts }) {
  return rules
    .map((r, i) => [r, i])
    .filter(([r]) => r.country === country && r.fuel === fuel && r.direction === direction
      && (r.customer_class ?? 'domestic') === customerClass && r.superseded_at == null
      && r.valid_from <= ts && (r.valid_to == null || r.valid_to > ts))
    .sort((a, b) => a[0].seq - b[0].seq || a[1] - b[1])
    .map(([r]) => r);
}

function checkRule(r) {
  if (!KINDS.has(r.kind)) throw new RangeError(`tax rule ${r.code}: unknown kind ${r.kind}`);
  if (!APPLIES_TO.has(r.applies_to)) throw new RangeError(`tax rule ${r.code}: unknown applies_to ${r.applies_to}`);
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw new TypeError(`tax rule ${r.code}: value is not a number`);
  if (!Number.isInteger(r.seq)) throw new TypeError(`tax rule ${r.code}: seq must be an integer`);
  if (r.kind === 'percent' && r.currency != null) throw new RangeError(`tax rule ${r.code}: a percent has no currency`);
  if (r.kind !== 'percent' && r.currency == null) throw new RangeError(`tax rule ${r.code}: ${r.kind} needs a currency`);
  if (r.kind === 'per_kwh' && r.applies_to !== 'unit') throw new RangeError(`tax rule ${r.code}: per_kwh applies to unit`);
  if (r.kind === 'per_period') {
    if (r.applies_to !== 'fixed') throw new RangeError(`tax rule ${r.code}: per_period applies to fixed`);
    if (!PERIOD_LENGTH[r.charge_period]) throw new RangeError(`tax rule ${r.code}: charge_period must be day, month or year`);
  }
}

const overlaps = (a, b) => a === b || a === 'all' || b === 'all';

// Charges and taxes for one slot.
//   rules   the rules for this slot (see rulesFor); one country, fuel and direction
//   input   { currency, unitEx (minor per kWh, ex tax), kwh, fixedEx (minor, this slot's share
//             of the fixed charge, ex tax), slotS, dayLengthS, monthLengthS, yearLengthS }
//           The period lengths are those of the local day/month/year holding the slot; only
//           the ones a per_period rule needs are required.
// Returns minor-unit amounts { ex, tax, inc } each {unit, fixed, total}, one line per rule,
// and unverified: true when any rule used is a placeholder.
export function applyTaxes(rules, input) {
  const { currency = null, unitEx = 0, kwh = 0, fixedEx = 0, slotS } = input;
  for (const [k, v] of Object.entries({ unitEx, kwh, fixedEx })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${k} is not a finite number: ${v}`);
  }
  if (currency != null) currencyOf(currency);
  rules.forEach(checkRule);
  const scope = new Set(rules.map((r) => `${r.country}/${r.fuel}/${r.direction}/${r.customer_class ?? 'domestic'}`));
  if (scope.size > 1) throw new Error(`tax rules for more than one country, fuel or direction: ${[...scope].join(', ')}`);
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rules[i].code === rules[j].code && overlaps(rules[i].applies_to, rules[j].applies_to)) {
        throw new Error(`tax ${rules[i].code} given twice for the same charge`);
      }
    }
  }

  const ex = { unit: unitEx * kwh, fixed: fixedEx };
  const tax = { unit: 0, fixed: 0 };
  const lines = [];
  const ordered = rules.map((r, i) => [r, i]).sort((a, b) => a[0].seq - b[0].seq || a[1] - b[1]).map(([r]) => r);
  for (let i = 0; i < ordered.length;) {
    const seq = ordered[i].seq;
    const base = { unit: ex.unit + tax.unit, fixed: ex.fixed + tax.fixed };
    const group = [];
    for (; i < ordered.length && ordered[i].seq === seq; i++) {
      const r = ordered[i];
      const part = { unit: 0, fixed: 0 };
      if (r.kind === 'percent') {
        if (r.applies_to !== 'fixed') part.unit = r.value * base.unit;
        if (r.applies_to !== 'unit') part.fixed = r.value * base.fixed;
      } else {
        if (currency == null) throw new TypeError(`tax rule ${r.code} is in ${r.currency}: input.currency is required`);
        assertSameCurrency(r.currency, currency);
        if (r.kind === 'per_kwh') part.unit = r.value * kwh;
        else part.fixed = r.value * share(r, input, slotS);
      }
      group.push({
        code: r.code, kind: r.kind, applies_to: r.applies_to, seq: r.seq,
        unit: part.unit, fixed: part.fixed, amount: part.unit + part.fixed, unverified: r.unverified === true,
      });
    }
    for (const l of group) { tax.unit += l.unit; tax.fixed += l.fixed; }
    lines.push(...group);
  }
  const sum = (o) => ({ ...o, total: o.unit + o.fixed });
  return {
    currency,
    ex: sum(ex),
    tax: sum(tax),
    inc: sum({ unit: ex.unit + tax.unit, fixed: ex.fixed + tax.fixed }),
    lines,
    unverified: lines.some((l) => l.unverified),
  };
}

// Fraction of a per-period amount that falls in this slot.
function share(r, input, slotS) {
  const key = PERIOD_LENGTH[r.charge_period];
  const length = input[key];
  if (!(slotS > 0)) throw new TypeError(`tax rule ${r.code} is per ${r.charge_period}: slotS is required`);
  if (!(length > 0)) throw new TypeError(`tax rule ${r.code} is per ${r.charge_period}: ${key} is required`);
  return slotS / length;
}
