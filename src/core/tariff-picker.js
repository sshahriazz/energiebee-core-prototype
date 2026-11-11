// The tariff picker: a home chooses its own electricity supplier and tariff, whatever source lists them.
// One interface for every country; the source is chosen from the home's market:
//   GB      Tariffscanner, the UK catalogue the core already holds (src/adapters/tariffscanner.js): every
//           list is read from our own tables, no call is made.
//   FR, NL  tounify v2 (src/adapters/tounify.js): the country's suppliers and a supplier's tariffs (kept 7 days);
//           the choice is kept here (v2 has no connection to register) and the home's prices are read right away
//           at its postal code, on its own off-peak hours for a French heures creuses tariff.
// Every source answers in the same shape, so the onboarding screen never knows which one it shows:
//   listSuppliers(site)            -> { country, source, available, reason?, suppliers: [{ code, name, tariffs }] }
//   listTariffs(site, supplier)    -> { country, source, supplier: { code, name }, tariffs: [TariffOption] }
//   chooseTariff(site, choice)     -> what was stored
//   tariffChoice(site)             -> the current choice, the questions and whether the picker applies
// TariffOption: { id, name, variant, kind: 'one_price' | 'two_rate' | 'dynamic', prices_known,
//   options: [{ payment_method, label, unit: [{ register, label, price }], standing: { price, per } }],
//   default_payment_method, hours, questions }; prices in minor units (pence, cents) as stored, before VAT.
// What a choice writes is the same for every source: the supplier (delta 080), a meter of the home on the
// tariff from a start date with the payment method (tariff_agreement), the meter's own two-rate hours
// (register_window with device_id) and the answers (contracted kVA on the home). The build then prices the
// home like any other (src/core/pricing.js: the home's payment method, the meter's own Economy 7 hours).
import { db, tx } from '../db/db.js';
import { resolveRegion } from './regions.js';
import { backfillSuppliers, ensureSupplier } from './suppliers.js';
import { supersedeAgreements, retireDevice } from './devices.js';
import { putWindows } from './tariffs.js';
import { markDirty } from './facts.js';
import { dayBounds, localDate, nowSec } from './time.js';
import { connectable } from './providers.js';
import { setContractedCapacity } from './sites.js';
import { rulesFor } from './tax.js';
import * as TU from '../adapters/tounify.js';

// The device a picked tariff sits on, for a home whose meter no account reports (no Octopus login): one
// import meter per home, provider 'picker'. Retired, with its agreements ended, once an account meter
// (Octopus) prices the home (retirePickedMeters).
export const PICKER = 'picker';
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Tariffscanner's payment methods, as its records name them.
export const PAYMENT_METHODS = Object.freeze({
  DDM: 'Monthly Direct Debit', DDQ: 'Quarterly Direct Debit', CAC: 'Cash or cheque, on receipt of the bill', PRE: 'Prepayment meter',
  ANY: 'Any way of paying',
});
const paymentLabel = (pm) => PAYMENT_METHODS[pm] ?? `${pm} (as the source names it)`;
const REGISTER_LABEL = { single: 'Price', day: 'Day', night: 'Night', hc: 'Off-peak', hp: 'Peak' };
const SERVICE = { E: null, D: 'with gas (dual fuel)', G: 'gas' };

const hhmm = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m || +m[1] > 24 || +m[2] > 59 || (+m[1] === 24 && +m[2] > 0)) return null;
  return +m[1] * 60 + +m[2];
};

// ───────────── Questions (market_question rows, delta 080) ─────────────

export function questionsFor(market, kind) {
  return db.prepare(`SELECT field, label, help, input, allowed, required FROM market_question
    WHERE market_code IN (?, '*') AND (when_kind = '*' OR when_kind = ?) ORDER BY seq, field`).all(market, kind === 'two_rate' ? 'two_rate' : '*')
    .map((q) => ({ ...q, required: q.required === 1, allowed: q.allowed ? JSON.parse(q.allowed) : null }));
}

// ───────────── Sources ─────────────

const SOURCES = new Map();
/** A catalogue source for some markets: { code, markets, available(site), listSuppliers, listTariffs, choose }. */
export function registerPickerSource(src) { SOURCES.set(src.code, src); }
export function sourceFor(site) {
  const market = site.market_code ?? site.country ?? 'GB';
  for (const s of SOURCES.values()) if (s.markets.includes(market)) return s;
  return null;
}

// ───────────── GB: Tariffscanner (our own tables, no call) ─────────────

const gbRegion = (site) => {
  const r = resolveRegion('octopus_gsp', site.gsp_region) ?? resolveRegion('gb_dno', site.gsp_region);
  return r?.code ?? null;
};
// Tariffs on offer now in a region: an electricity import tariff with a unit row in force now.
const OFFERED = `t.provider = 'tariffscanner' AND t.region = ? AND t.fuel = 'electricity' AND t.direction = 'import'
  AND EXISTS (SELECT 1 FROM rate_interval r WHERE r.tariff_id = t.id AND r.site_id IS NULL AND r.component = 'unit' AND r.superseded_at IS NULL
    AND r.valid_from <= ? AND IFNULL(r.valid_to, 9000000000) > ?)`;

function tsKind(structure) { return structure === 'e7' ? 'two_rate' : 'one_price'; }

function tsOption(t, nowTs, market) {
  const rows = db.prepare(`SELECT component, register, payment_method, price_ex_vat FROM rate_interval WHERE tariff_id = ? AND site_id IS NULL AND superseded_at IS NULL
    AND component IN ('unit', 'standing') AND valid_from <= ? AND IFNULL(valid_to, 9000000000) > ? ORDER BY payment_method, component, register`).all(t.id, nowTs, nowTs);
  const methods = [...new Set(rows.map((r) => r.payment_method))];
  const options = methods.map((pm) => {
    const mine = rows.filter((r) => r.payment_method === pm);
    const st = mine.find((r) => r.component === 'standing');
    return {
      payment_method: pm, label: paymentLabel(pm),
      unit: mine.filter((r) => r.component === 'unit').sort((a, b) => (a.register === 'night') - (b.register === 'night'))
        .map((r) => ({ register: r.register, label: REGISTER_LABEL[r.register] ?? r.register, price: r.price_ex_vat })),
      standing: st ? { price: st.price_ex_vat, per: 'day' } : null,
    };
  });
  const kind = tsKind(t.structure);
  const night = kind === 'two_rate' ? db.prepare(`SELECT start_min, end_min FROM register_window WHERE tariff_id = ? AND device_id IS NULL AND superseded_at IS NULL
    AND register = 'night' ORDER BY start_min LIMIT 1`).get(t.id) : null;
  const service = /^TS-[^-]+-([EDG])-/.exec(t.tariff_code)?.[1];
  const sup = t.supplier_name ? `${t.supplier_name}: ` : '';
  return {
    id: t.tariff_code, name: t.name.startsWith(sup) ? t.name.slice(sup.length) : t.name, variant: SERVICE[service] ?? null,
    kind, prices_known: true, options,
    default_payment_method: methods.includes('DDM') ? 'DDM' : (methods[0] ?? null),
    hours: night ? { from: hhmm(night.start_min), to: hhmm(night.end_min), source: 'the supplier\'s usual night hours' } : null,
    questions: questionsFor(market, kind),
  };
}

registerPickerSource({
  code: 'tariffscanner', markets: ['GB'], label: 'Tariffscanner',
  available(site) {
    if (!gbRegion(site)) return { available: false, reason: 'the home has no electricity region yet (its postcode was not found)' };
    const n = db.prepare(`SELECT COUNT(*) AS n FROM tariff WHERE provider = 'tariffscanner' AND region = ?`).get(gbRegion(site)).n;
    return n ? { available: true } : { available: false, reason: 'no Tariffscanner tariffs are held for this region yet (the daily catalogue sync fills them)' };
  },
  async listSuppliers(site) {
    backfillSuppliers();
    const now = nowSec();
    return db.prepare(`SELECT s.code, s.name, COUNT(*) AS tariffs FROM tariff t JOIN supplier s ON s.id = t.supplier_id
      WHERE ${OFFERED} GROUP BY s.id ORDER BY s.name COLLATE NOCASE`).all(gbRegion(site), now, now);
  },
  async listTariffs(site, sup) {
    const now = nowSec();
    const rows = db.prepare(`SELECT t.*, s.name AS supplier_name FROM tariff t JOIN supplier s ON s.id = t.supplier_id
      WHERE ${OFFERED} AND s.id = ? ORDER BY t.name COLLATE NOCASE, t.structure, t.tariff_code`).all(gbRegion(site), now, now, sup.id);
    return rows.map((t) => tsOption(t, now, 'GB'));
  },
  async choose(site, tariff, choice) {
    return chooseOnPickerMeter(site, tariff, choice);
  },
});

// ───────────── FR / NL: tounify v2 (lists kept 7 days, the choice kept here) ─────────────

const tuClient = () => {
  const c = TU.credentialsFromEnv(process.env);
  if (c.missing) throw bad(`tounify cannot be called: ${c.missing}`, 503);
  return { client: TU.clientFor(c.creds), dev: c.creds.dev ?? null };
};
// The tounify answers as ours: a refusal by the allowance or a rate limit -> 429, refused by tounify -> 400,
// anything else (auth, network, an odd answer) -> 502. Never the token.
const tuError = (err) => {
  if (!(err instanceof TU.TounifyError)) return err;
  const status = ['allowance', 'cooldown', 'rate_limited', 'allowance_exhausted'].includes(err.kind) ? 429 : err.kind === 'upstream' && err.status >= 400 && err.status < 500 ? 400 : 502;
  return Object.assign(new Error(err.message), { status });
};
// A tariff's kind from its listing: v2 lists { type: static | dynamic } and a name, no count of rates. A dynamic one
// follows the market; a static one is two-rate where its name says so (France: Heures Creuses, HP/HC; the Netherlands:
// dubbel / dag-nacht / normaal-dal), else one price. A French "Option Base" is one price at every hour, and its bill
// prints no off-peak hours. Tempo (six prices by day colour) is listed as one price per period, priced as served.
const TWO_RATE_NAME = /heures?\s+creuses|\bhp\s*\/\s*hc\b|\bhphc\b|\bhc\b|dubbel|dag\s*\/?\s*nacht|normaal\s*\/?\s*dal|\bdal\b/i;
const isFrBase = (t) => /\bbase\b/i.test(t.name ?? '') && !TWO_RATE_NAME.test(t.name ?? '') && !/tempo/i.test(t.name ?? '');
const tuKind = (t) => (t.type === 'dynamic' ? 'dynamic' : isFrBase(t) ? 'one_price' : TWO_RATE_NAME.test(t.name ?? '') ? 'two_rate' : 'one_price');
// The off-peak hours a French two-rate tariff is priced on by default: tounify's reference window, which the user
// changes to the hours on the bill (the grid operator assigns each meter its own 8 hours).
const tuHours = (market, kind) => (market === 'FR' && kind === 'two_rate'
  ? { ...TU.FR_REFERENCE_OFF_PEAK, source: 'the usual off-peak hours (23:00 to 07:00): change them to the hours on your bill' } : null);

registerPickerSource({
  code: 'tounify', markets: ['FR', 'NL'], label: 'tounify',
  available(site) {
    try { connectable(db, site, { provider: 'tounify' }); } catch (err) { return { available: false, reason: err.message }; }
    const c = TU.credentialsFromEnv(process.env);
    return c.missing ? { available: false, reason: `tounify cannot be called: ${c.missing}` } : { available: true };
  },
  async listSuppliers(site) {
    const { client } = tuClient();
    try {
      const { list, country } = await TU.listCompanies(site, { client });
      const held = new Map(db.prepare(`SELECT a.external_id, COUNT(t.id) AS n FROM supplier_alias a LEFT JOIN tariff t ON t.supplier_id = a.supplier_id
        WHERE a.provider = 'tounify' AND a.country = ? GROUP BY a.external_id`).all(country).map((r) => [r.external_id, r.n]));
      const out = list.map((c) => { const s = ensureSupplier({ provider: 'tounify', country, externalId: c.id, name: c.name ?? c.id }); return { code: s.code, name: s.name, tariffs: held.get(c.id) || null }; });
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) { throw tuError(err); }
  },
  async listTariffs(site, sup) {
    const { client } = tuClient();
    const market = site.market_code ?? site.country;
    const ext = db.prepare("SELECT external_id FROM supplier_alias WHERE supplier_id = ? AND provider = 'tounify'").get(sup.id)?.external_id;
    if (!ext) throw bad(`${sup.name} is not a tounify supplier`, 404);
    try {
      const { list, country } = await TU.listCompanyTariffs(site, ext, { client });
      return list.filter((t) => t.available !== false).map((t) => {
        const kind = tuKind(t);
        // Pricing a tariff spends one of a testing token's tariffs: the list shows the prices this home already holds
        // (chosen, or previewed with quoteTariff); the others are priced when the user selects one.
        const ps = priceSummary(site, `TOUNIFY-${country}-${t.id}`, Math.floor(client.clock.now() / 1000));
        return {
          id: t.id, name: t.name ?? t.id, variant: null, kind, prices_known: ps.unit.length > 0 || !!ps.range, link: t.link ?? null,
          options: [{ payment_method: 'ANY', label: paymentLabel('ANY'), unit: ps.unit, range: ps.range, standing: null }], default_payment_method: 'ANY',
          vat_rate: ps.vat_rate, price_day: ps.day, quote: 'on_select',
          hours: tuHours(market, kind), questions: questionsFor(market, kind),
        };
      });
    } catch (err) { throw tuError(err); }
  },
  async quote(site, sup, tariffId) {
    const { client, dev } = tuClient();
    const ext = db.prepare("SELECT external_id FROM supplier_alias WHERE supplier_id = ? AND provider = 'tounify'").get(sup.id)?.external_id;
    if (!ext) throw bad(`${sup.name} is not a tounify supplier`, 404);
    try {
      const { list } = await TU.listCompanyTariffs(site, ext, { client });   // kept a week: no call
      if (!list.some((t) => t.id === tariffId && t.available !== false)) throw bad(`tariff ${tariffId} is not offered by ${sup.name}`, 404);
      const q = await TU.quoteTariff(site, tariffId, { client, company: ext, dev });
      return { ...q, ...priceSummary(site, q.tariff, Math.floor(client.clock.now() / 1000)) };
    } catch (err) { throw tuError(err); }
  },
  async choose(site, tariff, choice) {
    const { client, dev } = tuClient();
    const market = site.market_code ?? site.country;
    const ext = db.prepare("SELECT a.external_id FROM supplier_alias a JOIN supplier s ON s.id = a.supplier_id WHERE a.provider = 'tounify' AND s.code = ? AND a.country = ?").get(String(choice.supplier ?? ''), market)?.external_id ?? null;
    const hours = tariff.kind === 'two_rate' ? (choice.hours ?? (tariff.hours ? { from: tariff.hours.from, to: tariff.hours.to } : null)) : null;
    const input = { consumption_tariff: tariff.id, company: ext, ...(hours ? { off_peak_hours: [{ from: hours.from, to: hours.to }] } : {}) };
    try {
      if (choice.contracted_kva != null) setContractedCapacity(site.id, Number(choice.contracted_kva), { origin: 'user', note: 'stated in onboarding (tariff picker)' });
      const reg = await TU.registerConnection(db.prepare('SELECT * FROM site WHERE id = ?').get(site.id), input, { client });
      const sync = await TU.syncTounifyHome({ site: db.prepare('SELECT * FROM site WHERE id = ?').get(site.id), client, dev, force: true });
      const dev2 = db.prepare("SELECT id FROM device WHERE site_id = ? AND provider = 'tounify' AND kind = 'meter_import' AND retired_at IS NULL").get(site.id);
      const tId = db.prepare('SELECT id FROM tariff WHERE tariff_code = ?').get(`TOUNIFY-${market}-${tariff.id}`)?.id;
      if (dev2 && tId && hours) storeMeterHours(dev2.id, tId, hours);
      return { source: 'tounify', tariff: `TOUNIFY-${market}-${tariff.id}`, grid_resolution: reg.grid_resolution ?? null, prices: sync, warnings: [...(reg.warnings ?? []), ...(sync.warnings ?? [])] };
    } catch (err) { throw tuError(err); }
  },
});

// The prices of a tariff a home holds for today (its own rows: chosen or previewed), for the list: one price, or a
// peak and an off-peak price, or (a price that changes through the day) today's lowest, highest and time-weighted
// average; ex VAT, in minor units, with the country's VAT rate now to show what is paid.
function vatRateNow(country, ts) {
  const rules = rulesFor(db.prepare('SELECT * FROM tax_rule WHERE country = ? AND superseded_at IS NULL').all(country), { country, fuel: 'electricity', direction: 'import', ts })
    .filter((r) => r.kind === 'percent' && ['unit', 'all'].includes(r.applies_to));
  return rules.length ? rules.reduce((m, r) => m + r.value, 0) : null;
}
export function priceSummary(site, tariffCode, now = nowSec()) {
  const tz = site.timezone || 'Europe/London';
  const q = db.prepare(`SELECT r.valid_from, IFNULL(r.valid_to, ?) AS valid_to, r.price_ex_vat AS p FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
    WHERE t.tariff_code = ? AND r.site_id = ? AND r.component = 'unit' AND r.superseded_at IS NULL AND r.valid_from < ? AND IFNULL(r.valid_to, 9000000000) > ? ORDER BY r.valid_from`);
  // Today; else the latest day the home holds (a tariff previewed or read some days ago), named in `day`.
  let day = localDate(tz, now);
  let [a, b] = dayBounds(tz, day);
  let rows = q.all(b, tariffCode, site.id, b, a);
  if (!rows.length) {
    const last = db.prepare(`SELECT MAX(r.valid_from) AS t FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
      WHERE t.tariff_code = ? AND r.site_id = ? AND r.component = 'unit' AND r.superseded_at IS NULL AND r.valid_from <= ?`).get(tariffCode, site.id, now).t;
    if (last != null) { day = localDate(tz, last); [a, b] = dayBounds(tz, day); rows = q.all(b, tariffCode, site.id, b, a); }
  }
  const vat = vatRateNow(site.country ?? site.market_code, now);
  if (!rows.length) return { unit: [], range: null, vat_rate: vat, day: null };
  const prices = [...new Set(rows.map((r) => r.p))].sort((x, y) => y - x);
  if (prices.length === 1) return { unit: [{ register: 'single', label: 'Price', price: prices[0] }], range: null, vat_rate: vat, day };
  if (prices.length === 2) return { unit: [{ register: 'peak', label: 'Peak', price: prices[0] }, { register: 'off_peak', label: 'Off-peak', price: prices[1] }], range: null, vat_rate: vat, day };
  let w = 0; let sum = 0;
  for (const r of rows) { const d = Math.min(r.valid_to, b) - Math.max(r.valid_from, a); if (d > 0) { w += d; sum += r.p * d; } }
  return { unit: [], range: { min: prices.at(-1), max: prices[0], avg: w ? sum / w : null }, vat_rate: vat, day };
}

// ───────────── Writing a choice on the home's own meter (any source with shared prices) ─────────────

// The meter's own two-rate hours: [{ from: 'HH:MM', to: 'HH:MM' }] -> register_window rows with device_id,
// every day, local clock. The meter's earlier hours are superseded (kept as history).
function storeMeterHours(deviceId, tariffId, hours, register = 'night') {
  const list = Array.isArray(hours) ? hours : [hours];
  const rows = list.map((h) => {
    const a = toMin(h.from); const b = toMin(h.to);
    if (a == null || b == null || a === b) throw bad('hours must be { from: "HH:MM", to: "HH:MM" }, two different times');
    return { device_id: deviceId, register, start_min: a % 1440, end_min: b === 0 ? 1440 : b, weekdays: 127, clock: 'local', source_text: `${h.from}-${h.to}` };
  });
  tx(() => {
    db.prepare('UPDATE register_window SET superseded_at = ? WHERE device_id = ? AND superseded_at IS NULL').run(Date.now(), deviceId);
    putWindows(tariffId, rows, { origin: 'user', originNote: 'the meter\'s own hours, confirmed by the user in onboarding (tariff picker)' });
  });
  return rows.length;
}

// The default start of a chosen tariff: the first day the home has data, so the days already loaded are priced
// too. A home with no data yet (the tariff is asked for before the inverter, whose first sync loads the last
// INITIAL_DAYS) starts BACKFILL_DAYS back, so those days are priced when they arrive. Either way never before the
// tariff's first known price (chooseOnPickerMeter).
const BACKFILL_DAYS = 31;
function firstDataDay(site) {
  const r = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(site.id);
  return r?.d ?? localDate(site.timezone || 'Europe/London', nowSec() - BACKFILL_DAYS * 86400);
}

// An account meter (Octopus) that prices the home: its tariff comes from the account, never from a list.
function accountMeter(siteId) {
  return db.prepare(`SELECT d.provider FROM device d JOIN tariff_agreement a ON a.device_id = d.id AND a.superseded_at IS NULL
    WHERE d.site_id = ? AND d.kind = 'meter_import' AND d.retired_at IS NULL AND d.provider NOT IN ('${PICKER}', 'env', 'tounify') LIMIT 1`).get(siteId);
}

function chooseOnPickerMeter(site, tariff, choice) {
  const tz = site.timezone || 'Europe/London';
  const t = db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(tariff.id);
  // Payment method: one the tariff is priced in (the default when the request names none).
  const methods = tariff.options.map((o) => o.payment_method);
  const pm = choice.payment_method ?? tariff.default_payment_method;
  if (!methods.includes(pm)) throw bad(`payment_method must be one of ${methods.join(', ')} for this tariff`);
  // Two-rate: the meter's own night hours (the supplier's usual hours unless the user changed them).
  const hours = tariff.kind === 'two_rate' ? (choice.hours ?? (tariff.hours ? { from: tariff.hours.from, to: tariff.hours.to } : null)) : null;
  if (tariff.kind === 'two_rate' && !hours) throw bad('hours are required for a day / night tariff: { from: "HH:MM", to: "HH:MM" } of the cheap night rate');
  // Start: the day given, else the first day of data; never before the tariff's first known price.
  const since = choice.since ?? firstDataDay(site);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw bad('since must be a date YYYY-MM-DD');
  const [sinceTs] = dayBounds(tz, since);
  const firstPrice = db.prepare("SELECT MIN(valid_from) AS t FROM rate_interval WHERE tariff_id = ? AND site_id IS NULL AND component = 'unit' AND superseded_at IS NULL").get(t.id).t;
  const from = Math.max(sinceTs, firstPrice ?? sinceTs);
  const notes = [];
  if (from > sinceTs) notes.push(`priced from ${localDate(tz, from)}: the first day this tariff's price is known`);

  let device;
  tx(() => {
    db.prepare(`INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at) VALUES (?, 'meter_import', '${PICKER}', 'import', 'Grid import (tariff chosen by the user)', '{}', ?)
      ON CONFLICT (site_id, provider, external_ref) DO UPDATE SET retired_at = NULL`).run(site.id, Date.now());
    device = db.prepare(`SELECT * FROM device WHERE site_id = ? AND provider = '${PICKER}' AND external_ref = 'import'`).get(site.id);
    // Keep the earlier choices before the new start (history); the new one runs open-ended from it.
    const cur = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from').all(device.id);
    const kept = cur.filter((a) => a.valid_from < from).map((a) => ({ tariffId: a.tariff_id, from: a.valid_from, to: a.valid_to == null || a.valid_to > from ? from : a.valid_to, paymentMethod: a.payment_method }));
    supersedeAgreements(site.id, device.id, [...kept, { tariffId: t.id, from, to: null, paymentMethod: pm }]);
    if (hours) storeMeterHours(device.id, t.id, hours);
  });
  markDirty(site.id, from, nowSec() + 86400, 'tariff chosen by the user');
  return {
    source: 'tariffscanner', tariff: t.tariff_code, name: t.name, payment_method: pm, from: localDate(tz, from),
    hours: hours ? { from: hours.from, to: hours.to } : null, notes,
  };
}

/**
 * An account meter now prices the home (Octopus): the picker's meter is retired and its agreements end where
 * the account's begin (the days before keep the price the user chose). Called by the Octopus sync step.
 */
export function retirePickedMeters(siteId) {
  const picked = db.prepare(`SELECT id FROM device WHERE site_id = ? AND provider = '${PICKER}' AND retired_at IS NULL`).all(siteId);
  if (!picked.length) return 0;
  const acc = db.prepare(`SELECT MIN(a.valid_from) AS t FROM tariff_agreement a JOIN device d ON d.id = a.device_id
    WHERE d.site_id = ? AND d.kind = 'meter_import' AND d.provider NOT IN ('${PICKER}', 'env') AND d.retired_at IS NULL AND a.superseded_at IS NULL`).get(siteId).t;
  if (acc == null) return 0;
  let first = null;
  for (const d of picked) {
    const cur = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from').all(d.id);
    const kept = cur.filter((a) => a.valid_from < acc).map((a) => ({ tariffId: a.tariff_id, from: a.valid_from, to: a.valid_to == null || a.valid_to > acc ? acc : a.valid_to, paymentMethod: a.payment_method }));
    supersedeAgreements(siteId, d.id, kept);
    retireDevice(d.id);
    for (const a of cur) first = Math.min(first ?? a.valid_from, a.valid_from);
  }
  if (first != null) markDirty(siteId, Math.max(first, acc), nowSec() + 86400, 'account meter replaces the chosen tariff');
  return picked.length;
}

// ───────────── The interface ─────────────

const supplierOf = (site, code) => {
  const country = site.country ?? site.market_code;
  const s = db.prepare('SELECT * FROM supplier WHERE country = ? AND code = ?').get(country, String(code ?? ''));
  if (!s) throw bad(`no supplier ${code} in ${country}`, 404);
  return s;
};
function requireSource(site) {
  if (site.is_demo) throw bad('demo home: its data is generated, it takes no tariff');
  const src = sourceFor(site);
  if (!src) throw bad(`no tariff list for market ${site.market_code ?? site.country} yet: enter the tariff by hand`, 404);
  const a = src.available(site);
  if (!a.available) throw bad(`the ${src.label} tariff list is not available for this home: ${a.reason}`, 503);
  return src;
}

export async function listSuppliers(site) {
  const src = requireSource(site);
  return { country: site.country, market: site.market_code ?? site.country, source: src.code, suppliers: await src.listSuppliers(site) };
}

export async function listTariffs(site, supplierCode) {
  const src = requireSource(site);
  const sup = supplierOf(site, supplierCode);
  return { country: site.country, source: src.code, supplier: { code: sup.code, name: sup.name }, tariffs: await src.listTariffs(site, sup) };
}

/** A tariff's price for the home before it is chosen (a source that prices on demand: tounify). */
export async function quoteTariff(site, supplierCode, tariffId) {
  const src = requireSource(site);
  if (!src.quote) throw bad(`${src.label} lists its prices with its tariffs: nothing to ask`, 404);
  const sup = supplierOf(site, supplierCode);
  return { supplier: { code: sup.code, name: sup.name }, ...(await src.quote(site, sup, String(tariffId ?? ''))) };
}

// Off-peak hours a market's network operator assigns per day, where it fixes them: France 8 h (heures creuses, as the
// bill prints them; the operator assigns each meter its own eight hours).
const OFF_PEAK_HOURS_PER_DAY = Object.freeze({ FR: 8 });
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => { const m = HHMM.exec(hhmm ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** Length of a from-to window in minutes, across midnight when `to` is not after `from` (22:00-06:00 is 480). */
export function windowMinutes(from, to) {
  const a = minutesOf(from); const b = minutesOf(to);
  if (a == null || b == null) return null;
  return b > a ? b - a : b + 1440 - a;
}
/** Refuses off-peak hours that are not HH:MM, or (where the market fixes it) not the day's exact number of hours. */
export function checkOffPeakHours(market, hours) {
  const mins = windowMinutes(hours?.from, hours?.to);
  if (mins == null || hours.from === hours.to) throw bad('Off-peak hours must be { from: "HH:MM", to: "HH:MM" }, two different times, e.g. 22:00 to 06:00');
  const need = OFF_PEAK_HOURS_PER_DAY[market] ?? null;
  if (need != null && mins !== need * 60) {
    const h = Math.floor(mins / 60); const m = mins % 60;
    throw bad(`Off-peak hours must cover exactly ${need} hours a day, as on your bill: ${hours.from} to ${hours.to} is ${h} h${m ? ` ${m} min` : ''}`);
  }
  return mins;
}

/**
 * choice: { supplier, tariff (an id from listTariffs), payment_method?, hours?: { from, to }, since?: 'YYYY-MM-DD',
 * contracted_kva? }. The tariff must be one listTariffs offers now; required questions must be answered.
 */
export async function chooseTariff(site, choice = {}) {
  const src = requireSource(site);
  const account = accountMeter(site.id);
  if (account) throw bad(`this home's tariff comes from its ${account.provider} account; disconnect it first to choose one from a list`, 409);
  const sup = supplierOf(site, choice.supplier);
  const offered = await src.listTariffs(site, sup);
  const tariff = offered.find((t) => t.id === choice.tariff);
  if (!tariff) throw bad(`tariff ${choice.tariff} is not offered by ${sup.name} for this home now`);
  for (const q of tariff.questions.filter((x) => x.required)) {
    const v = q.field === 'off_peak_hours' ? (choice.hours ?? tariff.hours) : choice[q.field];
    if (v == null || v === '') throw bad(`${q.label}: an answer is required`);
    if (q.allowed && q.field !== 'off_peak_hours' && !q.allowed.map(String).includes(String(v))) throw bad(`${q.label} must be one of ${q.allowed.join(', ')}`);
  }
  if (choice.hours != null && tariff.kind === 'two_rate') checkOffPeakHours(site.market_code ?? site.country, choice.hours);
  const r = await src.choose(site, tariff, choice);
  return { supplier: { code: sup.code, name: sup.name }, kind: tariff.kind, ...r };
}

/** What the home is on now, and whether the picker applies to it. */
export function tariffChoice(site) {
  const src = sourceFor(site);
  const avail = src ? src.available(site) : { available: false, reason: 'no tariff list for this market yet' };
  const cur = db.prepare(`SELECT a.valid_from, a.payment_method, d.provider AS meter, d.id AS device_id, t.tariff_code, t.name, t.structure, s.code AS supplier_code, s.name AS supplier_name
    FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id LEFT JOIN supplier s ON s.id = t.supplier_id
    WHERE a.site_id = ? AND d.kind = 'meter_import' AND d.retired_at IS NULL AND a.superseded_at IS NULL AND a.valid_from <= ? AND IFNULL(a.valid_to, 9000000000) > ?
    ORDER BY a.valid_from DESC LIMIT 1`).get(site.id, nowSec(), nowSec());
  const hours = cur ? db.prepare(`SELECT start_min, end_min FROM register_window WHERE device_id = ? AND superseded_at IS NULL ORDER BY start_min`).all(cur.device_id)
    .map((w) => ({ from: hhmm(w.start_min), to: hhmm(w.end_min) })) : [];
  const acc = accountMeter(site.id);
  return {
    source: src?.code ?? null, available: avail.available && !acc, ...(acc ? { reason: `the tariff comes from the home's ${acc.provider} account` } : avail.reason ? { reason: avail.reason } : {}),
    current: cur ? {
      tariff: cur.tariff_code, name: cur.name, supplier: cur.supplier_code ? { code: cur.supplier_code, name: cur.supplier_name } : null,
      from: localDate(site.timezone || 'Europe/London', cur.valid_from), payment_method: cur.payment_method ?? null,
      payment_label: cur.payment_method ? paymentLabel(cur.payment_method) : null,
      chosen: cur.meter === PICKER || cur.meter === 'tounify', via: cur.meter, hours,
    } : null,
  };
}
