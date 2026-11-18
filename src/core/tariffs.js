// Writing tariffs, their rate rows and agreements from core code (no provider calls): what a
// price adapter or an installer form hands over, in the shape the build prices from.
//   createTariff     a tariff with its market, currency, kind, price grain and origin (and
//                    taxesInPrice: its prices already hold the levies, delta 011; default 0)
//   putRateRows      unit, standing, fixed (per day / month / year) or capacity rows, ex tax
//   storeWindows     a tariff's register windows (HP/HC, Tempo, day/night with known times),
//                    stored in register_window (calendar days in calendar_day) and expanded FROM
//                    THOSE ROWS by tariff-expand.js into unit rows, one per register interval
//   expandStored     the same expansion from the stored rows, without writing anything
//   agreeTariff      a meter on a tariff from a moment; refused when the currencies differ
// Every tariff, rate row, window and calendar day carries an origin from the provenance
// vocabulary (src/core/provenance.js): the caller states it, rate rows default to their tariff's.
// The recorded_at of rate rows, windows and calendar days defaults to time.js recordedNow(): never
// the same millisecond twice in a process, so a write that corrects another made just before it is
// always recorded after it.
import { db, tx } from '../db/db.js';
import { expandWindows } from './tariff-expand.js';
import { currency as currencyOf } from './money.js';
import { checkOrigin } from './provenance.js';
import { dayBounds, addDays, recordedNow } from './time.js';
import { mapAsync } from "./async.js";
import { markTariffDirty, markHomeDirty } from './price-marks.js';

const KINDS = ['flat', 'tou', 'calendar_tou', 'dynamic', 'spot_indexed', 'dispatch', 'market'];

export async function createTariff({
  provider, tariffCode, fuel = 'electricity', direction = 'import', structure, kind, country, currency,
  nativePeriodS = null, region = null, name = null, productCode = null, origin, originNote = null, defaultRegister = null, taxesInPrice = 0,
}) {
  if (!provider || !tariffCode || !structure) throw new Error('a tariff needs provider, tariffCode and structure');
  if (!KINDS.includes(kind)) throw new Error(`tariff kind must be one of ${KINDS.join(', ')}, not ${kind}`);
  currencyOf(currency);
  if (!/^[A-Z]{2}$/.test(country ?? '')) throw new Error(`tariff country must be ISO alpha-2, not ${country}`);
  checkOrigin(origin, `tariff ${tariffCode}`);
  if (![0, 1, false, true].includes(taxesInPrice)) throw new Error(`taxesInPrice must be 0 or 1, not ${taxesInPrice}`);
  await db.prepare(`INSERT INTO tariff (provider, product_code, tariff_code, fuel, direction, structure, region, name, kind, country, currency, native_period_s, origin, origin_note, default_register, taxes_in_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(provider, productCode, tariffCode, fuel, direction, structure, region, name, kind, country, currency, nativePeriodS, origin, originNote, defaultRegister, taxesInPrice ? 1 : 0);
  return await db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(tariffCode);
}

async function tariffOrigin(tariffId) {
  const t = await db.prepare('SELECT origin, origin_note FROM tariff WHERE id = ?').get(tariffId);
  if (!t) throw new Error(`no tariff ${tariffId}`);
  return t;
}

/**
 * Rate rows for a tariff, ex tax, in minor units of the tariff's currency:
 * { component: 'unit'|'standing'|'fixed'|'capacity', register = 'single', chargePeriod (fixed,
 *   capacity: day|month|year), validFrom, validTo, price, paymentMethod = 'ANY', estimated = false }.
 * A capacity row's price is per kW (kVA) of the home's contracted capacity per chargePeriod.
 * origin defaults to the tariff's own. New rows only: an overlapping current row is refused by the
 * rate_no_overlap trigger.
 */
export async function putRateRows(tariffId, rows, { siteId = null, recordedAt = recordedNow(), origin = null, originNote = null } = {}) {
  const t = origin ? { origin, origin_note: originNote } : await tariffOrigin(tariffId);
  checkOrigin(t.origin, `rate rows of tariff ${tariffId}`);
  const ins = db.prepare(`INSERT INTO rate_interval (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, origin, origin_note, estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await tx(async () => {
        for (const r of rows) {
          if (typeof r.price !== 'number' || !Number.isFinite(r.price)) throw new TypeError(`rate price is not a number: ${r.price}`);
          await ins.run(tariffId, siteId, r.component ?? 'unit', r.register ?? 'single', r.chargePeriod ?? null, r.paymentMethod ?? 'ANY', r.validFrom, r.validTo ?? null, r.price, recordedAt,
                    t.origin, r.originNote ?? t.origin_note ?? null, r.estimated ? 1 : 0);
        }
        // The tariff's runs are made again from the earliest start, and the homes on it queued (price-queue.js).
        if (rows.length) await markTariffDirty(tariffId, Math.min(...rows.map((r) => r.validFrom)), siteId != null ? `home-specific rate rows for home ${siteId}` : 'rate rows stored');
      });
  return rows.length;
}

// ───────────── Register windows and calendars (delta 006) ─────────────

const WINDOW_KEYS = ['device_id', 'register', 'start_min', 'end_min', 'weekdays', 'calendar', 'day_type', 'clock', 'valid_from', 'valid_to'];
const windowRow = (w, deviceId) => ({
  device_id: w.device_id ?? w.deviceId ?? null, register: w.register,
  start_min: Number(w.start_min ?? w.startMin), end_min: Number(w.end_min ?? w.endMin), weekdays: Number(w.weekdays ?? 127),
  calendar: w.calendar ?? null, day_type: w.day_type ?? w.dayType ?? null, clock: w.clock ?? 'local',
  valid_from: w.valid_from ?? w.validFrom ?? null, valid_to: w.valid_to ?? w.validTo ?? null, source_text: w.source_text ?? w.sourceText ?? null,
  _for: deviceId,
});

// Store windows as rows (a window equal to a current row is not stored twice). A window given
// with device_id is that meter's own; the others belong to the tariff.
export async function putWindows(tariffId, windows, { origin, originNote = null, recordedAt = recordedNow() }) {
  checkOrigin(origin, `register windows of tariff ${tariffId}`);
  const cur = await db.prepare('SELECT * FROM register_window WHERE tariff_id = ? AND superseded_at IS NULL').all(tariffId);
  const same = (a, b) => WINDOW_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
  const ins = db.prepare(`INSERT INTO register_window (tariff_id, device_id, register, start_min, end_min, weekdays, calendar, day_type, clock, valid_from, valid_to, source_text, origin, origin_note, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  await tx(async () => {
        for (const w of windows.map((x) => windowRow(x))) {
          if (cur.some((c) => same(c, w))) continue;
          await ins.run(tariffId, w.device_id, w.register, w.start_min, w.end_min, w.weekdays, w.calendar, w.day_type, w.clock, w.valid_from, w.valid_to, w.source_text, origin, originNote, recordedAt);
          cur.push(w);
          added++;
        }
        // A meter's own windows change that home's registers; a tariff's windows change the tariff's.
        const own = windows.map((x) => windowRow(x)).find((w) => w.device_id != null);
        if (added && own) await markHomeDirty((await db.prepare('SELECT site_id FROM device WHERE id = ?').get(own.device_id)).site_id, 0, `meter windows changed for device ${own.device_id}`);
        else if (added) await markTariffDirty(tariffId, Math.min(...windows.map((x) => windowRow(x).valid_from ?? 0)), 'register windows stored');
      });
  return added;
}

// A calendar and its known days ({ code, dayStartMin, days: { 'YYYY-MM-DD': type } }). A day whose
// type changes supersedes the old row (kept); an equal one is left alone. The new row is always
// recorded after the row it supersedes: a recordedAt that is not later (a caller's fixed stamp
// used twice, a clock stepped back) is moved to 1 ms after the current row's, and the old row is
// superseded at that same moment, so the key (calendar, local_date, recorded_at) never clashes
// and the history stays in order.
export async function putCalendar({ code, dayStartMin = 0, name = null, days = {} }, { origin, originNote = null, recordedAt = recordedNow() }) {
  checkOrigin(origin, `calendar ${code}`);
  await tx(async () => {
        await db.prepare(`INSERT INTO calendar (code, day_start_min, name, origin, origin_note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (code) DO UPDATE SET day_start_min = excluded.day_start_min, name = COALESCE(excluded.name, calendar.name)`).run(code, dayStartMin, name, origin, originNote);
        const cur = db.prepare('SELECT day_type, recorded_at FROM calendar_day WHERE calendar = ? AND local_date = ? AND superseded_at IS NULL');
        const sup = db.prepare('UPDATE calendar_day SET superseded_at = ? WHERE calendar = ? AND local_date = ? AND superseded_at IS NULL');
        const ins = db.prepare('INSERT INTO calendar_day (calendar, local_date, day_type, origin, origin_note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const [d, type] of Object.entries(days instanceof Map ? Object.fromEntries(days) : days)) {
          const c = await cur.get(code, d);
          if (c?.day_type === type) continue;
          const at = c && c.recorded_at >= recordedAt ? c.recorded_at + 1 : recordedAt;
          if (c) await sup.run(at, code, d);
          await ins.run(code, d, type, origin, originNote, at);
        }
      });
}

// The stored calendars a set of windows needs, in the shape expandWindows takes.
async function storedCalendars(codes) {
  return await mapAsync([...new Set(codes.filter(Boolean))], async (code) => {
        const c = await db.prepare('SELECT * FROM calendar WHERE code = ?').get(code);
        if (!c) throw new Error(`calendar ${code} is not stored`);
        const days = Object.fromEntries((await db.prepare('SELECT local_date, day_type FROM calendar_day WHERE calendar = ? AND superseded_at IS NULL').all(code)).map((r) => [r.local_date, r.day_type]));
        return { code, dayStartMin: c.day_start_min, days };
      });
}

/**
 * Expand a tariff's STORED windows (register_window, plus its calendars' stored days) over local
 * days fromDate..toDate. With deviceId, that meter's own windows replace the tariff's; without,
 * only the tariff's windows are used. A day of unknown type is priced with estimate
 * ({ dayType, prices }: the caller's cautious default) and comes back estimated: true; without an
 * estimate an unknown day throws (tariff-expand.js). Nothing is written.
 */
export async function expandStored(tariffId, { registerPrices, tz, fromDate, toDate, deviceId = null, estimate = null }) {
  const t = await db.prepare('SELECT default_register FROM tariff WHERE id = ?').get(tariffId);
  const windows = await db.prepare(`SELECT * FROM register_window WHERE tariff_id = ? AND superseded_at IS NULL AND (device_id IS NULL OR device_id = ?) ORDER BY id`)
      .all(tariffId, deviceId ?? -1);
  if (!windows.length) throw new Error(`tariff ${tariffId} has no stored register windows`);
  return expandWindows({
    windows, registerPrices, tz, fromDate, toDate, calendar: await storedCalendars(windows.map((w) => w.calendar)),
    defaultRegister: t?.default_register ?? null, deviceId, estimate,
  });
}

/**
 * Store a tariff's register windows (register_window; a meter's own with deviceId, kept for that
 * home only via siteId), its calendar days if a calendar is given, and its default register; then
 * expand the STORED windows over local days fromDate..toDate and store the result as unit rows
 * (component 'unit', register = the window's register: hp, hc, blue_hc ...). The tariff's structure
 * must be 'windows', so pricing reads the register from the row covering each instant.
 *
 * A day whose type is not known yet (a Tempo colour beyond tomorrow) is priced with the caller's
 * cautious default, estimate = { dayType, prices }, and its rows are stored estimated = 1 (the
 * build marks such slots estimated). Storing a range again replaces the rows in it that differ
 * (superseded, kept as history), so the real colour replaces the estimate once it is published and
 * a corrected colour replaces the old one; rows that are unchanged are left alone. Without an
 * estimate an unknown day is refused. Returns the expanded intervals.
 */
export async function storeWindows(tariffId, {
  windows = [], registerPrices, tz, fromDate, toDate, calendar = null, defaultRegister = null, deviceId = null, siteId = null,
  estimate = null, recordedAt = recordedNow(), origin = null, originNote = null,
}) {
  const t = await db.prepare('SELECT structure, origin, origin_note FROM tariff WHERE id = ?').get(tariffId);
  if (t?.structure !== 'windows') throw new Error(`tariff ${tariffId}: register windows are stored only for structure 'windows'`);
  const label = { origin: origin ?? t.origin, originNote: originNote ?? t.origin_note, recordedAt };
  checkOrigin(label.origin, `register windows of tariff ${tariffId}`);
  let rows;
  await tx(async () => {
        if (defaultRegister) await db.prepare('UPDATE tariff SET default_register = ? WHERE id = ?').run(defaultRegister, tariffId);
        for (const c of [calendar].flat().filter(Boolean)) await putCalendar(c, label);
        await putWindows(tariffId, windows, label);
        rows = await expandStored(tariffId, { registerPrices, tz, fromDate, toDate, deviceId, estimate });
        // The expansion replaces the unit rows this tariff (for this home, or for everyone) holds inside
        // the range: a row stored exactly as expanded is kept, any other (an estimate, or a day type
        // since corrected) is superseded, so the history is kept and only one price is current.
        const [a] = dayBounds(tz, fromDate);
        const [b] = dayBounds(tz, addDays(toDate, 1));
        const key = (register, from, to, price, est) => `${register}|${from}|${to}|${price}|${est ? 1 : 0}`;
        const want = new Set(rows.map((r) => key(r.register, r.validFrom, r.validTo, r.price, r.estimated)));
        const kept = new Set();
        const sup = db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?');
        let superseded = 0;
        for (const c of await db.prepare(`SELECT id, register, valid_from, valid_to, price_ex_vat, estimated FROM rate_interval WHERE tariff_id = ? AND COALESCE(site_id, 0) = ?
        AND component = 'unit' AND superseded_at IS NULL AND valid_from >= ? AND valid_to <= ?`).all(tariffId, siteId ?? 0, a, b)) {
          const k = key(c.register, c.valid_from, c.valid_to, c.price_ex_vat, c.estimated);
          if (want.has(k) && !kept.has(k)) kept.add(k); else { await sup.run(recordedAt, c.id); superseded++; }
        }
        if (superseded) await markTariffDirty(tariffId, a, 'unit rows superseded by a new expansion of the windows');
        const fresh = rows.filter((r) => !kept.has(key(r.register, r.validFrom, r.validTo, r.price, r.estimated)));
        await putRateRows(tariffId, fresh.map((r) => ({ component: 'unit', register: r.register, validFrom: r.validFrom, validTo: r.validTo, price: r.price, estimated: r.estimated,
                originNote: r.estimated ? `estimated: ${r.calendarDay} day type not known; priced as ${r.dayType} with the caller's cautious default` : undefined })),
              { siteId, recordedAt, origin: label.origin, originNote: label.originNote });
      });
  return rows;
}

// A meter on a tariff over [validFrom, validTo). The database refuses a tariff whose currency is
// not the home's (trigger agreement_same_currency_insert) and an overlap with a current agreement.
export async function agreeTariff({ siteId, deviceId, tariffId, validFrom, validTo = null, recordedAt = Date.now(), paymentMethod = null }) {
  await db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, valid_to, recorded_at, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(siteId, deviceId, tariffId, validFrom, validTo, recordedAt, paymentMethod);
  await markHomeDirty(siteId, validFrom, `tariff agreement added for device ${deviceId}`);
}

// A meter or other device of a home, known from recordedAt (ms).
// uid: the device's identity outside this database, when a hub that discovered it made one (else the database makes it).
export async function addDevice({ siteId, kind, provider, externalRef, label = null, attrs = {}, recordedAt = Date.now(), uid = null }) {
  await db.prepare('INSERT INTO device (site_id, kind, provider, external_ref, label, attrs, recorded_at, uid) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?::uuid, uuidv7()))')
        .run(siteId, kind, provider, externalRef, label, JSON.stringify(attrs), recordedAt, uid);
  return await db.prepare('SELECT * FROM device WHERE site_id = ? AND provider = ? AND external_ref = ?').get(siteId, provider, externalRef);
}
