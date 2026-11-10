// FR and NL VAT (EU_VAT_RULES in src/core/tax.js): sourced rules written to tax_rule on every open, so a
// French or Dutch home is priced with VAT instead of 0 %. Rates by date, what pricing applies to the unit
// price and to the fixed charges, and the write: idempotent, superseding (never deleting) on a change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db, syncVatRules, vatRulesChanged } = await import('../src/db/db.js');
const { EU_VAT_RULES, rulesFor, applyTaxes } = await import('../src/core/tax.js');
const { taxesAt } = await import('../src/core/pricing.js');

const paris = (y, m, d) => Date.UTC(y, m - 1, d) / 1000 - (m >= 4 && m <= 10 ? 7200 : 3600);
const current = (country) => db.prepare("SELECT * FROM tax_rule WHERE country = ? AND superseded_at IS NULL ORDER BY valid_from, applies_to").all(country);
const unitVat = (country, ts) => taxesAt({ taxRules: current(country), country, currency: 'EUR', shapes: new Map() }, 'electricity', 'import', ts, { inPrice: true });

test('a fresh database holds the FR and NL VAT rules, sourced, from the first open', () => {
  assert.deepEqual([...vatRulesChanged].sort(), ['FR', 'NL'], 'written on the first open');
  for (const c of ['FR', 'NL']) {
    const rows = current(c);
    assert.equal(rows.length, EU_VAT_RULES.filter((r) => r.country === c).length);
    assert.ok(rows.every((r) => r.origin === 'sourced' && r.unverified === 0 && r.kind === 'percent' && r.fuel === 'electricity' && r.direction === 'import'));
    assert.ok(rows.every((r) => r.source === r.origin_note && r.source.length > 20));
  }
});

test('the rates by date: FR 20 % on everything from 1 Aug 2025 (5.5 % on the subscription before); NL 21 %, 9 % in the second half of 2022', () => {
  const at = (country, ts) => rulesFor(EU_VAT_RULES, { country, fuel: 'electricity', direction: 'import', ts }).map((r) => [r.applies_to, r.value]);
  assert.deepEqual(at('FR', paris(2025, 7, 31)), [['unit', 0.20], ['fixed', 0.055]]);
  assert.deepEqual(at('FR', paris(2025, 8, 1)), [['all', 0.20]]);
  assert.deepEqual(at('FR', paris(2026, 11, 9)), [['all', 0.20]]);
  assert.deepEqual(at('NL', paris(2022, 6, 30)), [['all', 0.21]]);
  assert.deepEqual(at('NL', paris(2022, 7, 1)), [['all', 0.09]]);
  assert.deepEqual(at('NL', paris(2022, 12, 31)), [['all', 0.09]]);
  assert.deepEqual(at('NL', paris(2023, 1, 1)), [['all', 0.21]]);
  assert.deepEqual(at('NL', paris(2026, 11, 9)), [['all', 0.21]]);
  // Export and gas have no rule here (left as they were).
  assert.deepEqual(rulesFor(EU_VAT_RULES, { country: 'FR', fuel: 'electricity', direction: 'export', ts: paris(2026, 11, 9) }), []);
  assert.deepEqual(rulesFor(EU_VAT_RULES, { country: 'NL', fuel: 'gas', direction: 'import', ts: paris(2026, 11, 9) }), []);
});

test('pricing applies them: a French or Dutch unit price and fixed charge carry VAT, from tax_rule, not "none"', () => {
  const fr = unitVat('FR', paris(2026, 11, 9));
  assert.deepEqual([fr.source, fr.vat, fr.levy, fr.unverified], ['tax_rule', 0.2, 0, false]);
  assert.ok(fr.inputs.every((i) => i.origin === 'sourced'));
  const nl = unitVat('NL', paris(2026, 11, 9));
  assert.deepEqual([nl.source, nl.vat], ['tax_rule', 0.21]);
  // Fixed charges: 20 % from Aug 2025, 5.5 % before (the subscription), applied by the same rules.
  const fixedInc = (ts) => applyTaxes(rulesFor(current('FR'), { country: 'FR', fuel: 'electricity', direction: 'import', ts }), { currency: 'EUR', fixedEx: 100 }).inc.fixed;
  assert.ok(Math.abs(fixedInc(paris(2026, 11, 9)) - 120) < 1e-9);
  assert.ok(Math.abs(fixedInc(paris(2025, 7, 1)) - 105.5) < 1e-9);
});

test('writing again changes nothing; a changed list supersedes the old rows (kept) and records the new ones', () => {
  const before = db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country IN ('FR', 'NL')").get().n;
  assert.deepEqual(syncVatRules(), [], 'unchanged: nothing written');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country IN ('FR', 'NL')").get().n, before);
  const changed = EU_VAT_RULES.map((r) => (r.country === 'NL' && r.valid_to == null ? { ...r, value: 0.22 } : r));
  assert.deepEqual(syncVatRules(changed), ['NL'], 'only the country whose rules changed');
  assert.equal(unitVat('NL', paris(2026, 11, 9)).vat, 0.22);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rule WHERE country = 'NL' AND superseded_at IS NOT NULL").get().n, 3, 'the old NL rows are kept, superseded');
  assert.equal(unitVat('FR', paris(2026, 11, 9)).vat, 0.2, 'FR untouched');
  assert.deepEqual(syncVatRules(), ['NL'], 'back to the list');
  assert.equal(unitVat('NL', paris(2026, 11, 9)).vat, 0.21);
});
