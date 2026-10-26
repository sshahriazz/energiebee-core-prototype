// Delta 012: overlap guards that also hold for UPDATE (rate_interval, tariff_agreement, tax_rule),
// an overlap check for register windows (INSERT and UPDATE), and consistency checks that a NULL can
// no longer bypass. The ordinary writers' flows (supersede, then insert) still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

useDb();
const { db, syncGbVat } = await import('../src/db/db.js');
const { supersedeAgreements } = await import('../src/core/devices.js');
const { putWindows } = await import('../src/core/tariffs.js');

const run = (sql, ...a) => db.prepare(sql).run(...a);
const id = (r) => Number(r.lastInsertRowid);
const site = id(run("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Home', 1, 'GB', 'GB', 'GBP')"));
const meter = id(run("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'meter_import', 'octopus', 'M1')", site));
const tariffOf = (code, currency = 'GBP', country = 'GB') => id(run("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, currency, country) VALUES ('t', ?, 'electricity', 'import', 'flat', ?, ?)", code, currency, country));
const T1 = tariffOf('T-1');
const T2 = tariffOf('T-2');
const rate = (from, to, extra = {}) => id(run(`INSERT INTO rate_interval (tariff_id, component, register, valid_from, valid_to, price_ex_vat, recorded_at, superseded_at)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?)`, extra.tariff ?? T1, extra.component ?? 'unit', extra.register ?? 'single', from, to, extra.price ?? 20, extra.superseded ?? null));

test('rate_interval: an UPDATE that would overlap a current row is refused; superseding and re-inserting still works', () => {
  const a = rate(1000, 2000);
  const b = rate(2000, 3000);
  assert.throws(() => run('UPDATE rate_interval SET valid_to = 2500 WHERE id = ?', a), /overlapping current rate interval/);
  assert.throws(() => run('UPDATE rate_interval SET valid_from = 1500 WHERE id = ?', b), /overlapping current rate interval/);
  assert.throws(() => run('UPDATE rate_interval SET valid_to = NULL WHERE id = ?', a), /overlapping/, 'open-ended over the next row');
  // An old version made current again over the row that replaced it.
  const old = rate(2000, 3000, { price: 19, superseded: 5 });
  assert.throws(() => run('UPDATE rate_interval SET superseded_at = NULL WHERE id = ?', old), /overlapping/);
  // Moving a row onto another register or tariff where it would overlap.
  const night = rate(1000, 3000, { register: 'night' });
  assert.throws(() => run("UPDATE rate_interval SET register = 'single' WHERE id = ?", night), /overlapping/);
  assert.doesNotThrow(() => run("UPDATE rate_interval SET register = 'day' WHERE id = ?", night));
  // Ordinary updates are untouched: a price, a shorter validity, the supersede-then-insert flow.
  assert.doesNotThrow(() => run('UPDATE rate_interval SET price_ex_vat = 21 WHERE id = ?', a));
  assert.doesNotThrow(() => run('UPDATE rate_interval SET valid_to = 1900 WHERE id = ?', a));
  assert.doesNotThrow(() => run('UPDATE rate_interval SET superseded_at = 10 WHERE id = ?', b));
  assert.doesNotThrow(() => rate(2000, 3000, { price: 22 }));
  assert.doesNotThrow(() => run('UPDATE rate_interval SET superseded_at = 11 WHERE id IN (?, ?)', a, night));
});

test('tariff_agreement: an UPDATE that would overlap is refused; supersedeAgreements still replaces the list', () => {
  supersedeAgreements(site, meter, [{ tariffId: T1, from: 100, to: 200 }, { tariffId: T2, from: 200, to: null }]);
  const [x, y] = db.prepare('SELECT id FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from').all(meter).map((r) => r.id);
  assert.throws(() => run('UPDATE tariff_agreement SET valid_to = 250 WHERE id = ?', x), /overlapping tariff agreement/);
  assert.throws(() => run('UPDATE tariff_agreement SET valid_from = 150 WHERE id = ?', y), /overlapping tariff agreement/);
  const replaced = db.prepare('SELECT id FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').all(meter).map((r) => r.id);
  supersedeAgreements(site, meter, [{ tariffId: T2, from: 100, to: null }]);
  assert.throws(() => run('UPDATE tariff_agreement SET superseded_at = NULL WHERE id = ?', replaced[1]), /overlapping|UNIQUE/);
  assert.doesNotThrow(() => run('UPDATE tariff_agreement SET recorded_at = 7 WHERE id = ?', x), 'a recorded time is not a validity');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').get(meter).n, 1);
});

test('tax_rule: an UPDATE that would charge the same tax twice is refused; syncGbVat still supersedes', () => {
  const ins = db.prepare(`INSERT INTO tax_rule (country, code, fuel, direction, applies_to, kind, value, valid_from, valid_to, source, recorded_at)
    VALUES ('FR', 'tva', 'electricity', 'import', 'all', 'percent', 0.2, ?, ?, 'test', 1)`);
  const a = id(ins.run(1000, 2000));
  const b = id(ins.run(2000, null));
  assert.throws(() => run('UPDATE tax_rule SET valid_to = 2001 WHERE id = ?', a), /overlapping current tax rule/);
  assert.throws(() => run("UPDATE tax_rule SET applies_to = 'unit', valid_from = 1500 WHERE id = ?", b), /overlapping current tax rule/);
  assert.doesNotThrow(() => run('UPDATE tax_rule SET value = 0.21 WHERE id = ?', b));
  // GB VAT: a changed table supersedes the current rules (an UPDATE of superseded_at) and inserts the new set.
  const gb = db.prepare("SELECT COUNT(*) AS n FROM tax_rule WHERE country = 'GB' AND superseded_at IS NULL").get().n;
  assert.equal(syncGbVat([{ fuel: 'electricity', direction: 'import', rate: 0.05, validFrom: 0 }]), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tax_rule WHERE country = 'GB' AND superseded_at IS NULL").get().n, 1);
  assert.ok(gb >= 1);
  db.prepare("DELETE FROM tax_rule WHERE country = 'FR'").run();
});

test('register_window: two registers covering the same minute of one window set are refused; everything the expander accepts is not', () => {
  const T = tariffOf('T-WIN');
  const win = (w) => id(run(`INSERT INTO register_window (tariff_id, device_id, register, start_min, end_min, weekdays, calendar, day_type, clock, valid_from, valid_to, recorded_at, superseded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, T, w.device ?? null, w.register, w.start, w.end, w.weekdays ?? 127, w.calendar ?? null, w.day_type ?? null, w.clock ?? 'local', w.from ?? null, w.to ?? null, w.superseded ?? null));
  const night = win({ register: 'night', start: 1380, end: 420 });                                        // 23:00-07:00, wraps
  assert.doesNotThrow(() => win({ register: 'day', start: 420, end: 1380 }), 'adjacent: no minute shared');
  assert.throws(() => win({ register: 'peak', start: 360, end: 480 }), /two registers at the same minute/, 'over the morning tail of the night');
  assert.throws(() => win({ register: 'peak', start: 0, end: 60 }), /two registers/, 'just after midnight, inside the wrap');
  assert.doesNotThrow(() => win({ register: 'night', start: 0, end: 60 }), 'the same register twice is allowed (the expander accepts it)');
  // Weekdays: a Sunday-only 23:00-07:00 runs into Monday morning; a Monday 06:00 window meets it, a Tuesday one does not.
  const T3 = tariffOf('T-WEEK');
  const wk = (w) => id(run('INSERT INTO register_window (tariff_id, register, start_min, end_min, weekdays, recorded_at) VALUES (?, ?, ?, ?, ?, 1)', T3, w.register, w.start, w.end, w.weekdays));
  wk({ register: 'hc', start: 1380, end: 420, weekdays: 64 });
  assert.throws(() => wk({ register: 'hp', start: 360, end: 600, weekdays: 1 }), /two registers/, 'Sunday night into Monday');
  assert.doesNotThrow(() => wk({ register: 'hp', start: 360, end: 600, weekdays: 2 }));
  assert.doesNotThrow(() => wk({ register: 'hp', start: 360, end: 600, weekdays: 60 }), 'Wednesday to Saturday');
  assert.throws(() => wk({ register: 'hp2', start: 540, end: 660, weekdays: 4 }), /two registers/, 'another register on Wednesday 09:00');
  // Other window sets: a meter's own windows, another clock, another calendar day type, disjoint validity.
  run("INSERT OR IGNORE INTO calendar (code) VALUES ('fr_tempo')");
  assert.doesNotThrow(() => win({ register: 'hc_meter', start: 0, end: 600, device: meter }), 'a meter\'s own windows replace the tariff\'s');
  assert.doesNotThrow(() => win({ register: 'hc_utc', start: 0, end: 600, clock: 'utc' }));
  assert.doesNotThrow(() => win({ register: 'red_hp', start: 0, end: 600, calendar: 'fr_tempo', day_type: 'red' }), 'a calendar window beats a plain one');
  assert.doesNotThrow(() => win({ register: 'blue_hp', start: 0, end: 600, calendar: 'fr_tempo', day_type: 'blue' }), 'two day types are never on one day');
  assert.throws(() => win({ register: 'any_hp', start: 300, end: 700, calendar: 'fr_tempo' }), /two registers/, 'no day type = every day of the calendar');
  assert.ok(night > 0);
});

test('register_window: validity and UPDATE', () => {
  const T = tariffOf('T-VALID');
  const ins = db.prepare('INSERT INTO register_window (tariff_id, register, start_min, end_min, valid_from, valid_to, recorded_at, superseded_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
  const a = id(ins.run(T, 'hc', 0, 480, 1000, 2000, null));
  assert.doesNotThrow(() => ins.run(T, 'hp', 0, 480, 2000, null, null), 'valid one after the other');
  assert.throws(() => ins.run(T, 'hp2', 0, 480, 1500, 1800, null), /two registers/);
  assert.doesNotThrow(() => ins.run(T, 'hp3', 0, 480, 1500, 1800, 9), 'a superseded window is history, not checked');
  assert.throws(() => run('UPDATE register_window SET valid_to = 2100 WHERE id = ?', a), /two registers/);
  assert.throws(() => run('UPDATE register_window SET superseded_at = NULL WHERE register = ? AND tariff_id = ?', 'hp3', T), /two registers/);
  assert.doesNotThrow(() => run('UPDATE register_window SET superseded_at = 10 WHERE id = ?', a));
  assert.doesNotThrow(() => run("UPDATE register_window SET source_text = '00:00-08:00' WHERE id = ?", a));
});

test('register_window: putWindows (the writer) stores a full HP/HC day and refuses an overlapping set', () => {
  const T = tariffOf('T-PUT');
  assert.equal(putWindows(T, [{ register: 'hc', start_min: 1320, end_min: 360 }, { register: 'hp', start_min: 360, end_min: 1320 }], { origin: 'user' }), 2);
  assert.throws(() => putWindows(T, [{ register: 'xx', start_min: 1300, end_min: 1330 }], { origin: 'user' }), /two registers/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM register_window WHERE tariff_id = ?').get(T).n, 2, 'nothing of the refused set was stored');
});

test('consistency: a NULL currency, country or a foreign meter can no longer slip an agreement past the checks', () => {
  const eur = tariffOf('T-EUR', 'EUR', 'FR');
  const frNoCurrency = tariffOf('T-FR-NULL', null, 'FR');
  // A home in market GB with no currency of its own is billed in GBP (its market's).
  const nullHome = id(run("INSERT INTO site (name, created_at, country, market_code) VALUES ('No currency', 1, 'GB', 'GB')"));
  const m2 = id(run("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'meter_import', 'octopus', 'M2')", nullHome));
  const agree = db.prepare('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (?, ?, ?, 0, 1)');
  assert.throws(() => agree.run(nullHome, m2, eur), /currency differs/, 'EUR tariff for a GB-market home without its own currency');
  assert.throws(() => agree.run(site, meter, frNoCurrency), /currency differs/, 'a tariff without currency is in its country\'s market currency');
  assert.doesNotThrow(() => agree.run(nullHome, m2, T1));
  // Changing the home's market or currency, or the tariff's country, re-checks its agreements.
  assert.throws(() => run("UPDATE site SET market_code = 'FR', country = 'FR' WHERE id = ?", nullHome), /currency differs/);
  assert.throws(() => run("UPDATE tariff SET currency = NULL, country = 'FR' WHERE id = ?", T1), /currency differs/);
  // Country and market: consistent when both are set.
  assert.throws(() => run("INSERT INTO site (name, created_at, country, market_code) VALUES ('Paris?', 1, 'FR', 'GB')"), /country differs from its market/);
  assert.throws(() => run("UPDATE site SET country = 'FR' WHERE id = ?", site), /country differs from its market/);
  assert.doesNotThrow(() => run("INSERT INTO site (name, created_at, country) VALUES ('Unknown market', 1, 'FR')"), 'still not judged without a market');
  // The agreement's home is its meter's home.
  const other = id(run("INSERT INTO site (name, created_at, country, market_code, currency) VALUES ('Other', 1, 'GB', 'GB', 'GBP')"));
  const m4 = id(run("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'meter_export', 'octopus', 'M4')", site));
  assert.throws(() => agree.run(other, m4, T2), /differs from its meter home/);
  const own = db.prepare('SELECT id FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL').get(m2).id;
  assert.throws(() => run('UPDATE tariff_agreement SET site_id = ? WHERE id = ?', other, own), /differs from its meter home/);
  // Unknown on one side even after the implied values: not judged (the columns stay nullable).
  const bare = id(run("INSERT INTO site (name, created_at) VALUES ('Bare', 1)"));
  const m3 = id(run("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'meter_import', 'x', 'M3')", bare));
  assert.doesNotThrow(() => agree.run(bare, m3, eur));
});
