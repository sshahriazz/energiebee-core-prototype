// Money. Amounts are held in MINOR units (pence, cents) as plain numbers (REAL in SQL), always
// next to a currency code. Prices keep their fractions (24.567 p/kWh); only a figure that is
// billed or shown is rounded to whole minor units. There is no FX anywhere: amounts in two
// currencies are never added, compared or converted, and anything that would do so throws.

export const CURRENCIES = Object.freeze({
  GBP: Object.freeze({ code: 'GBP', minorExponent: 2, symbol: '£' }),
  EUR: Object.freeze({ code: 'EUR', minorExponent: 2, symbol: '€' }),
});

export function currency(code) {
  const c = typeof code === 'string' ? CURRENCIES[code] : undefined;
  if (!c) throw new RangeError(`unknown currency: ${code}`);
  return c;
}

function finite(x, what = 'amount') {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${what} is not a finite number: ${x}`);
  return x;
}

// Scaling by 10^n leaves binary noise (0.1 + 0.2 -> 30.000000000000004 pence); 15 significant
// digits is the precision a double holds, so keeping 15 removes the noise and nothing else.
const clean = (x) => (x === 0 ? 0 : Number(x.toPrecision(15)));

export function toMinor(major, cur) {
  return clean(finite(major) * 10 ** currency(cur).minorExponent);
}

export function toMajor(minor, cur) {
  return clean(finite(minor) / 10 ** currency(cur).minorExponent);
}

// Whole minor units, half away from zero: 100.5 -> 101, -100.5 -> -101, and 1.005 pounds
// (100.49999999999999 pence in binary) -> 101.
export function roundMinor(minor) {
  finite(minor);
  const r = Math.sign(minor) * Math.round(Math.abs(clean(minor)));
  return r === 0 ? 0 : r;
}

// Display only: rounded to the currency's minor unit, in the reader's locale.
export function format(minor, cur, locale = 'en-GB') {
  const c = currency(cur);
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: c.code,
    minimumFractionDigits: c.minorExponent, maximumFractionDigits: c.minorExponent,
  }).format(roundMinor(minor) / 10 ** c.minorExponent);
}

// a and b are currency codes or anything with a .currency. Returns the shared code.
export function assertSameCurrency(a, b) {
  const code = (x) => (typeof x === 'string' ? x : x?.currency);
  const ca = code(a);
  const cb = code(b);
  if (!ca || !cb) throw new TypeError(`currency missing (${ca ?? 'none'} vs ${cb ?? 'none'})`);
  currency(ca);
  currency(cb);
  if (ca !== cb) throw new Error(`mixed currencies: ${ca} and ${cb} (no FX: amounts in different currencies are never combined)`);
  return ca;
}

// Totals per currency, never across them: [{currency, amount}] -> { GBP: 123.4, EUR: 5 }.
// An amount that is not a number (an unpriced slot) throws rather than counting as zero.
export function sumByCurrency(rows, field = 'amount') {
  const out = {};
  for (const r of rows) {
    const c = currency(r?.currency).code;
    out[c] = (out[c] ?? 0) + finite(r[field], `${field} (${c})`);
  }
  for (const c of Object.keys(out)) out[c] = clean(out[c]);
  return out;
}
