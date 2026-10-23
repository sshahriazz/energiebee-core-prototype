// Price-provider adapter contract. Every source of tariffs or prices (Octopus, Tariffscanner
// through eb-auth, tounify, ENTSO-E, …) is wrapped in one object of this shape, so the core can
// list catalogues, follow versions and capture price days without knowing the provider.
// Pure: no database, no network. The checks below look at the shape of an adapter and of the
// rows it returns; they never call the adapter's functions.
//
// Rules every adapter keeps:
// - Prices are returned in MINOR units of the market currency per kWh (pence, cents, øre),
//   one row per component, NET of VAT: VAT and levies are the 'tax' and 'fees' components,
//   never folded into 'energy'. A provider in major units (EUR/kWh) or per MWh converts here.
// - Times are UTC epoch SECONDS, [fromUtc, toUtc). A local day is 23, 24 or 25 hours: rows are
//   bucketed by their own fromUtc, never by counting them.
// - Negative prices are kept as they are (spot hours with surplus solar).
// - External ids are opaque and case-sensitive: stored and sent back byte for byte, never
//   trimmed, upper-cased or checked against a pattern.
// - owner names the ONE process allowed to call the provider. Tariffscanner is owned by eb-auth
//   (one 20 requests/minute budget for the whole company), so the core reads eb-auth's copy and
//   never calls it; assertOwner() stops a second caller.
// - etag is the opaque validator from the previous call of the same listing; an unchanged
//   listing answers { status: 'not_modified' } and costs nothing to store.

export const ROLES = ['catalogue', 'prices', 'both', 'market'];
export const OWNERS = ['core', 'eb-auth'];
export const PRICE_COMPONENTS = ['energy', 'grid', 'fees', 'tax'];
export const RESOLUTIONS = [900, 1800, 3600];

/**
 * @typedef {'catalogue'|'prices'|'both'|'market'} ProviderRole
 *   catalogue: lists tariffs and versions; prices: price series for a tariff; both; market:
 *   one wholesale series per bidding zone (ENTSO-E), shared by every site in the zone.
 *
 * @typedef {object} TariffRef
 * @property {string} provider     adapter code
 * @property {string} externalId   opaque, case-sensitive
 * @property {string} country      ISO 3166-1 alpha-2
 * @property {'consumption'|'feedin'|'grid'} [sector]
 * @property {string} [versionDate] 'YYYYMMDD', or '' for "as of today"
 *
 * @typedef {object} TariffListing
 * @property {TariffRef} ref
 * @property {string} name
 * @property {string} [companyId]
 * @property {'flat'|'tou'|'calendar_tou'|'dynamic'|'spot_indexed'|'dispatch'|'market'} [kind]
 * @property {boolean} [available]  still offered to new customers
 *
 * @typedef {object} ListResult
 * @property {'ok'|'not_modified'|'skipped'} status
 * @property {string|null} [etag]   pass back on the next call
 * @property {TariffListing[]} [tariffs]
 * @property {string} [skipped]     why nothing was asked ('no token', 'disabled', …)
 *
 * @typedef {object} VersionsResult
 * @property {'ok'|'not_modified'|'skipped'} status
 * @property {string|null} [etag]
 * @property {{versionDate: string, available: boolean}[]} [versions]  newest first
 * @property {string} [skipped]
 *
 * @typedef {object} PriceRow
 * @property {number} fromUtc      epoch seconds
 * @property {number} toUtc        epoch seconds, > fromUtc
 * @property {'energy'|'grid'|'fees'|'tax'} component
 * @property {number} minorPerKwh  signed; negative prices are kept
 * @property {string} currency     ISO 4217 ('EUR', 'GBP')
 * @property {boolean} estimated   true when not yet published (a forecast or an assumed day type)
 *
 * @typedef {object} PriceDaysResult
 * @property {PriceRow[]} rows
 * @property {number|null} [nextPollAt]  epoch seconds the provider advises polling again
 * @property {number} [billedCalls]      billed upstream calls this result cost
 * @property {string} [skipped]
 *
 * @typedef {object} PriceAdapter
 * @property {string} code                    'octopus' | 'tariffscan' | 'tounify' | 'entsoe' | …
 * @property {string[]} countries             ISO 3166-1 alpha-2
 * @property {ProviderRole} role
 * @property {'core'|'eb-auth'} owner
 * @property {(country: string, etag?: string|null) => Promise<ListResult>} [listTariffs]       catalogue, both
 * @property {(ref: TariffRef, etag?: string|null) => Promise<VersionsResult>} [versions]       catalogue, both
 * @property {(ref: TariffRef, variant: string, dates: string[], resolutionS: number) => Promise<PriceDaysResult>} [priceDays]
 *   prices, both, market. variant: grid-tariff id or postal zone ('' for none); dates: local
 *   'YYYY-MM-DD' days of the market; resolutionS: 900 | 1800 | 3600.
 * @property {(site: object) => {scheme: string, code: string}|null} regionOf
 *   the provider's region for a site (scheme as in the region table: gb_dno, bzn, …), or null.
 */

const needs = {
  listTariffs: ['catalogue', 'both'],
  versions: ['catalogue', 'both'],
  priceDays: ['prices', 'both', 'market'],
};

// Every way an adapter object breaks the contract, as readable messages ([] when it is fine).
export function checkAdapter(a) {
  if (!a || typeof a !== 'object') return ['adapter is not an object'];
  const errs = [];
  if (typeof a.code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(a.code)) errs.push('code must be a lower-case identifier');
  if (!Array.isArray(a.countries) || !a.countries.length || !a.countries.every((c) => /^[A-Z]{2}$/.test(c))) {
    errs.push('countries must be a non-empty list of ISO 3166-1 alpha-2 codes');
  }
  if (!ROLES.includes(a.role)) errs.push(`role must be one of ${ROLES.join(', ')}`);
  if (!OWNERS.includes(a.owner)) errs.push(`owner must be one of ${OWNERS.join(', ')}`);
  if (typeof a.regionOf !== 'function') errs.push('regionOf(site) is required');
  for (const [fn, roles] of Object.entries(needs)) {
    if (roles.includes(a.role) && typeof a[fn] !== 'function') errs.push(`${fn}() is required for role ${a.role}`);
    if (a[fn] !== undefined && typeof a[fn] !== 'function') errs.push(`${fn} must be a function`);
  }
  return errs.map((e) => `${a.code ?? 'adapter'}: ${e}`);
}

export function assertAdapter(a) {
  const errs = checkAdapter(a);
  if (errs.length) throw new Error(`adapter contract broken: ${errs.join('; ')}`);
  return a;
}

// Only the owning process may call a provider; anyone else reads the owner's copy.
export function assertOwner(a, caller = 'core') {
  if (a.owner !== caller) {
    throw new Error(`${a.code} is owned by ${a.owner}: ${caller} must read ${a.owner}'s copy, not call the provider (one rate budget, one caller)`);
  }
  return a;
}

/**
 * Every way a set of price rows breaks the contract ([] when fine). At most `limit` messages.
 * opts.currency: the market currency the rows must be in; opts.resolutionS: every row's length.
 */
export function checkPriceRows(rows, { currency = null, resolutionS = null, limit = 20 } = {}) {
  if (!Array.isArray(rows)) return ['rows is not an array'];
  const errs = [];
  const add = (i, msg) => { if (errs.length < limit) errs.push(`row ${i}: ${msg}`); };
  const currencies = new Set();
  const byComponent = new Map();
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') return add(i, 'not an object');
    const { fromUtc, toUtc } = r;
    if (!Number.isInteger(fromUtc) || !Number.isInteger(toUtc)) add(i, 'fromUtc and toUtc must be whole epoch seconds');
    else {
      if (fromUtc > 1e11 || toUtc > 1e11) add(i, 'times look like milliseconds; use epoch seconds');
      if (toUtc <= fromUtc) add(i, 'toUtc must be after fromUtc');
      if (fromUtc % 300 || toUtc % 300) add(i, 'times must fall on the 5-minute grid');
      if (resolutionS && toUtc - fromUtc !== resolutionS) add(i, `length ${toUtc - fromUtc} s, expected ${resolutionS} s`);
    }
    if (!PRICE_COMPONENTS.includes(r.component)) add(i, `component must be one of ${PRICE_COMPONENTS.join(', ')}`);
    if (typeof r.minorPerKwh !== 'number' || !Number.isFinite(r.minorPerKwh)) add(i, 'minorPerKwh must be a finite number');
    if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) add(i, 'currency must be an ISO 4217 code');
    else {
      currencies.add(r.currency);
      if (currency && r.currency !== currency) add(i, `currency ${r.currency}, expected ${currency}`);
    }
    if (typeof r.estimated !== 'boolean') add(i, 'estimated must be true or false');
    if (Number.isInteger(fromUtc) && Number.isInteger(toUtc) && PRICE_COMPONENTS.includes(r.component)) {
      if (!byComponent.has(r.component)) byComponent.set(r.component, []);
      byComponent.get(r.component).push({ i, fromUtc, toUtc });
    }
  });
  if (currencies.size > 1 && errs.length < limit) errs.push(`rows mix currencies: ${[...currencies].join(', ')}`);
  for (const [component, list] of byComponent) {
    list.sort((x, y) => x.fromUtc - y.fromUtc);
    for (let k = 1; k < list.length; k++) {
      if (list[k].fromUtc < list[k - 1].toUtc) add(list[k].i, `${component} overlaps row ${list[k - 1].i}`);
    }
  }
  return errs;
}
