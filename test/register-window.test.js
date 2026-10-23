// Register windows stored as data (delta 006 register_window, calendar, calendar_day) and expanded
// FROM THE STORED ROWS (src/core/tariffs.js storeWindows / expandStored); a Tempo day whose colour
// is not known yet priced with the caller's cautious default and marked estimated all the way to
// the built slot (quality bit, lineage, check, provenance block), then replaced by the real colour.
// New, empty database; synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { createTariff, putRateRows, agreeTariff, addDevice, storeWindows, expandStored, putCalendar } = await import('../src/core/tariffs.js');
const { expandWindows, parseRanges } = await import('../src/core/tariff-expand.js');
const { buildSite } = await import('../src/core/build.js');
const { seriesId, putIntervals, QUALITY } = await import('../src/core/facts.js');
const { dayBounds, recordedNow } = await import('../src/core/time.js');
const { periodProvenance } = await import('../src/core/provenance.js');

const TZ = 'Europe/Paris';
const SYN = { origin: 'synthetic', originNote: 'test data' };
const PRICES = { blue_hc: 12.3, blue_hp: 14.9, white_hc: 13.9, white_hp: 17.3, red_hc: 14.6, red_hp: 64.7 };
const TEMPO = ['blue', 'white', 'red'].flatMap((c) => [
  { register: `${c}_hp`, calendar: 'fr_tempo', day_type: c, start_min: 360, end_min: 1320 },
  { register: `${c}_hc`, calendar: 'fr_tempo', day_type: c, start_min: 1320, end_min: 360 },
]);

const site = createSite({ name: 'Tempo home', market: 'FR', isDemo: true });
const dev = addDevice({ siteId: site.id, kind: 'meter_import', provider: 'synthetic', externalRef: 'PDL-T' });
const other = addDevice({ siteId: site.id, kind: 'meter_export', provider: 'synthetic', externalRef: 'PDL-X' });
const tempo = createTariff({ provider: 'synthetic', tariffCode: 'SYN-TEMPO-T', country: 'FR', currency: 'EUR', structure: 'windows', kind: 'calendar_tou', ...SYN });
const [d1] = dayBounds(TZ, '2026-01-12'); const [, d2] = dayBounds(TZ, '2026-01-13');
agreeTariff({ siteId: site.id, deviceId: dev.id, tariffId: tempo.id, validFrom: d1, validTo: d2 });
const rows = [];
for (let t = d1; t < d2; t += 1800) rows.push({ start: t, end: t + 1800, value: 0.5 });
putIntervals(seriesId('device', dev.id, 'grid_import_kwh', 'octopus_meter'), rows);

test('windows and calendar days are stored as rows; storing them again adds nothing', () => {
  const first = storeWindows(tempo.id, { windows: TEMPO, registerPrices: PRICES, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12',
    calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-11': 'blue', '2026-01-12': 'white' } } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM register_window WHERE tariff_id = ? AND superseded_at IS NULL').get(tempo.id).n, 6);
  assert.deepEqual({ ...db.prepare('SELECT code, day_start_min, origin FROM calendar').get() }, { code: 'fr_tempo', day_start_min: 360, origin: 'synthetic' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM calendar_day WHERE calendar = 'fr_tempo' AND superseded_at IS NULL").get().n, 2);
  // 12 Jan: blue_hc until 06:00 (the night of the blue 11th), white from 06:00.
  assert.deepEqual(first.map((r) => [r.register, r.estimated]), [['blue_hc', false], ['white_hp', false], ['white_hc', false]]);
  const again = storeWindows(tempo.id, { windows: TEMPO, registerPrices: PRICES, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12',
    calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-11': 'blue', '2026-01-12': 'white' } } });
  assert.deepEqual(again, first);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM register_window WHERE tariff_id = ?').get(tempo.id).n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NULL').get(tempo.id).n, 3);
});

test('the expansion comes from the stored rows: the same intervals as expanding the inputs directly', () => {
  const stored = expandStored(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12' });
  const direct = expandWindows({ windows: TEMPO, registerPrices: PRICES, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12',
    calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-11': 'blue', '2026-01-12': 'white' } } });
  assert.deepEqual(stored, direct);
});

test('a meter\'s own windows replace the tariff\'s for that meter only', () => {
  const hphc = createTariff({ provider: 'synthetic', tariffCode: 'SYN-HPHC-T', country: 'FR', currency: 'EUR', structure: 'windows', kind: 'tou', ...SYN });
  const ref = parseRanges('22:00-06:00').map((r) => ({ ...r, register: 'hc' }));
  const own = parseRanges('HC (02H00-07H00 ; 13H00-16H00)').map((r) => ({ ...r, register: 'hc', device_id: dev.id, source_text: 'HC (02H00-07H00 ; 13H00-16H00)' }));
  storeWindows(hphc.id, { windows: ref, registerPrices: { hp: 18.4, hc: 14.1 }, defaultRegister: 'hp', tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12' });
  storeWindows(hphc.id, { windows: [...ref, ...own], registerPrices: { hp: 18.4, hc: 14.1 }, deviceId: dev.id, siteId: site.id, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12' });
  assert.equal(db.prepare('SELECT default_register FROM tariff WHERE id = ?').get(hphc.id).default_register, 'hp');
  assert.deepEqual(db.prepare('SELECT device_id, start_min, end_min, source_text FROM register_window WHERE tariff_id = ? ORDER BY id').all(hphc.id).map((r) => ({ ...r })), [
    { device_id: null, start_min: 1320, end_min: 360, source_text: null },
    { device_id: dev.id, start_min: 120, end_min: 420, source_text: 'HC (02H00-07H00 ; 13H00-16H00)' },
    { device_id: dev.id, start_min: 780, end_min: 960, source_text: 'HC (02H00-07H00 ; 13H00-16H00)' },
  ]);
  const hours = (list) => list.filter((r) => r.register === 'hc').reduce((s, r) => s + (r.validTo - r.validFrom), 0) / 3600;
  assert.equal(hours(expandStored(hphc.id, { registerPrices: { hp: 18.4, hc: 14.1 }, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12' })), 8);   // 00-06 + 22-24
  assert.equal(hours(expandStored(hphc.id, { registerPrices: { hp: 18.4, hc: 14.1 }, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12', deviceId: dev.id })), 8);   // 02-07 + 13-16
  assert.equal(hours(expandStored(hphc.id, { registerPrices: { hp: 18.4, hc: 14.1 }, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12', deviceId: other.id })), 8);
  assert.deepEqual(expandStored(hphc.id, { registerPrices: { hp: 18.4, hc: 14.1 }, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12', deviceId: dev.id })
    .filter((r) => r.register === 'hc').map((r) => [new Date(r.validFrom * 1000).toISOString().slice(11, 16), (r.validTo - r.validFrom) / 3600]), [['01:00', 5], ['12:00', 3]]);
  assert.throws(() => storeWindows(tempo.id, { windows: [{ register: 'x', start_min: 0, end_min: 60, clock: 'solar' }], registerPrices: PRICES, tz: TZ, fromDate: '2026-01-12', toDate: '2026-01-12' }), /CHECK|clock/);
});

test('an unknown colour is refused without an estimate, and priced with the cautious default with one', () => {
  assert.throws(() => storeWindows(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-13', toDate: '2026-01-13' }), /unknown and no estimate/);
  // 13 Jan: before 06:00 the night of the known white 12th; from 06:00 an unknown colour, priced as red.
  const est = storeWindows(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-13', toDate: '2026-01-13', estimate: { dayType: 'red' } });
  assert.deepEqual(est.map((r) => [r.register, r.price, r.estimated]), [['white_hc', 13.9, false], ['red_hp', 64.7, true], ['red_hc', 14.6, true]]);
  const stored = db.prepare('SELECT register, estimated, origin, origin_note FROM rate_interval WHERE tariff_id = ? AND superseded_at IS NULL AND valid_from >= ? ORDER BY valid_from').all(tempo.id, dayBounds(TZ, '2026-01-13')[0]);
  assert.deepEqual(stored.map((r) => [r.register, r.estimated, r.origin]), [['white_hc', 0, 'synthetic'], ['red_hp', 1, 'synthetic'], ['red_hc', 1, 'synthetic']]);
  assert.match(stored[1].origin_note, /estimated: 2026-01-13 day type not known; priced as red/);
});

test('a slot priced from an estimated row is flagged estimated: quality bit, lineage, check and provenance', () => {
  buildSite(site.id, '2026-01-12', '2026-01-13');
  const day = db.prepare("SELECT slot_start, quality, lineage, import_rate_ex FROM site_hh WHERE site_id = ? AND local_date = '2026-01-13' ORDER BY slot_start").all(site.id);
  const [six] = [dayBounds(TZ, '2026-01-13')[0] + 6 * 3600];
  for (const r of day) {
    const lin = JSON.parse(r.lineage);
    const est = r.slot_start >= six;
    assert.equal(!!(r.quality & QUALITY.ESTIMATED), est, `quality at ${r.slot_start}`);
    assert.equal(lin.estimated === true, est, `lineage at ${r.slot_start}`);
  }
  assert.ok(db.prepare("SELECT quality FROM site_hh WHERE site_id = ? AND local_date = '2026-01-12'").all(site.id).every((r) => !(r.quality & QUALITY.ESTIMATED)));
  const chk = db.prepare("SELECT status, measured FROM check_result WHERE site_id = ? AND local_date = '2026-01-13' AND check_code = 'price_estimated'").get(site.id);
  assert.deepEqual({ ...chk }, { status: 'warn', measured: 36 });
  const p = periodProvenance(db, site, '2026-01-12', '2026-01-13');
  assert.equal(p.estimated_slots, 36);
  assert.equal(p.worst, 'synthetic');
});

test('the real colour replaces the estimate: estimated rows superseded (kept), slots rebuilt unestimated', () => {
  storeWindows(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-13', toDate: '2026-01-13', calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-13': 'blue' } } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND estimated = 1 AND superseded_at IS NULL').get(tempo.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND estimated = 1 AND superseded_at IS NOT NULL').get(tempo.id).n, 2);
  buildSite(site.id, '2026-01-12', '2026-01-13');
  const day = db.prepare("SELECT quality, lineage, import_rate_ex FROM site_hh WHERE site_id = ? AND local_date = '2026-01-13' ORDER BY slot_start").all(site.id);
  assert.ok(day.every((r) => !(r.quality & QUALITY.ESTIMATED) && !JSON.parse(r.lineage).estimated));
  assert.equal(day[20].import_rate_ex, 14.9, '10:00 is blue_hp now (no tax rule for FR: taxes taken as 0)');
  assert.ok(JSON.parse(day[20].lineage).placeholder_inputs.includes('no tax rule for FR (taxes taken as 0) [placeholder]'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM check_result WHERE site_id = ? AND check_code = 'price_estimated'").get(site.id).n, 0);
});

test('a colour corrected later replaces the old one: calendar row and rate rows superseded, history kept', () => {
  const at = dayBounds(TZ, '2026-01-14')[0] + 10 * 3600;
  const current = () => db.prepare('SELECT register, price_ex_vat FROM rate_interval WHERE tariff_id = ? AND component = \'unit\' AND superseded_at IS NULL AND valid_from <= ? AND valid_to > ?').all(tempo.id, at, at).map((r) => ({ ...r }));
  storeWindows(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-14', toDate: '2026-01-14', calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-14': 'white' } } });
  assert.deepEqual(current(), [{ register: 'white_hp', price_ex_vat: 17.3 }]);
  storeWindows(tempo.id, { registerPrices: PRICES, tz: TZ, fromDate: '2026-01-14', toDate: '2026-01-14', calendar: { code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-14': 'red' } } });
  assert.deepEqual(current(), [{ register: 'red_hp', price_ex_vat: 64.7 }], 'one current price at every instant');
  assert.deepEqual(db.prepare("SELECT day_type, superseded_at IS NOT NULL AS old FROM calendar_day WHERE local_date = '2026-01-14' ORDER BY recorded_at").all().map((r) => [r.day_type, r.old]), [['white', 1], ['red', 0]]);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM rate_interval WHERE tariff_id = ? AND register = 'white_hp' AND superseded_at IS NOT NULL AND valid_from >= ?").get(tempo.id, dayBounds(TZ, '2026-01-14')[0]).n > 0);
  // A row written by hand over a stored one is still refused (rate_no_overlap).
  assert.throws(() => putRateRows(tempo.id, [{ component: 'unit', register: 'red_hp', validFrom: at, validTo: at + 3600, price: 1 }]), /overlapping/);
});

test('two corrections of one day in the same millisecond: no key clash, recorded in order', () => {
  // recordedNow() never repeats, even called back to back.
  const stamps = Array.from({ length: 50 }, () => recordedNow());
  assert.ok(stamps.every((s, i) => i === 0 || s > stamps[i - 1]));
  // A fixed stamp given twice (the clash the default stamp used to hit): the second row is moved to
  // 1 ms after the first and supersedes it at that moment.
  const fixed = recordedNow();
  const label = { origin: 'synthetic', recordedAt: fixed };
  putCalendar({ code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-20': 'blue' } }, label);
  putCalendar({ code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-20': 'red' } }, label);
  putCalendar({ code: 'fr_tempo', dayStartMin: 360, days: { '2026-01-20': 'white' } }, label);
  assert.deepEqual(db.prepare("SELECT day_type, recorded_at, superseded_at FROM calendar_day WHERE calendar = 'fr_tempo' AND local_date = '2026-01-20' ORDER BY recorded_at").all().map((r) => ({ ...r })), [
    { day_type: 'blue', recorded_at: fixed, superseded_at: fixed + 1 },
    { day_type: 'red', recorded_at: fixed + 1, superseded_at: fixed + 2 },
    { day_type: 'white', recorded_at: fixed + 2, superseded_at: null },
  ]);
});
