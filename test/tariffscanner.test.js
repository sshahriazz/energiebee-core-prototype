// Tariffscanner adapter (src/adapters/tariffscanner.js) and its registry step: the mapper on real
// records captured from the API (test/fixtures/tariffscanner: three pages of 5 records, limit 5,
// active=true; page-day-night also rate_type=day_night), the client against a fake fetch and a fake
// clock (no network, no real waiting), the sweep's idempotent and bitemporal writes, the plan and
// the sync step. Temp database; any request not sent to a fake is refused and recorded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { useDb } from './helpers.js';

useDb();
const stray = [];
const refuse = async (url) => { stray.push(String(url)); throw new Error(`no network in tests: ${url}`); };
globalThis.fetch = refuse;
for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD', 'TARIFFSCAN_BASE_URL', 'OCTOPUS_API_KEY', 'OCTOPUS_ACCOUNT_NUMBER', 'SUNSYNK_USERNAME', 'SUNSYNK_PASSWORD', 'IMPORT_TARIFF_CODE']) delete process.env[k];
// Stand-in credential, set only in this test process; never printed.
const SECRET = { user: 'svc-user@example.test', pass: 'pw-never-printed-3' };

const { db } = await import('../src/db/db.js');
const TS = await import('../src/adapters/tariffscanner.js');
const P = await import('../src/core/providers.js');
const { syncAll, syncSite } = await import('../src/jobs/sync.js');   // registers the steps
const { createSite } = await import('../src/core/sites.js');
const { rateRow } = await import('../src/core/pricing.js');
const { app } = await import('../src/server.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'tariffscanner');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const PAGE1 = load('page-1.json');
const PAGE2 = load('page-2.json');
const DN = load('page-day-night.json');
const RECORDS = [...PAGE1.data, ...PAGE2.data, ...DN.data];
const rec = (pid) => structuredClone(RECORDS.find((r) => r.product_id === pid));
const london = (y, m, d) => Date.UTC(y, m - 1, d) / 1000 - (m > 3 && m < 11 ? 3600 : 0);   // midnight, BST from April to October here

// One clock for the whole file, so the persisted next_allowed_at never lies in a later test's past.
const clock = { t: Date.UTC(2026, 9, 23, 12), sleeps: [], now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; } };
const resp = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const page = (data, { offset = 0, limit = 1000, more = false, next = null } = {}) => resp(200, { data, pagination: { offset, limit, returned: data.length, has_more: more, next_offset: next } });

// A fake Tariffscanner: the token endpoint, and pages(call) for the data endpoint.
function fakeApi(pages, { tokenStatus = () => 200 } = {}) {
  const calls = [];
  let tokens = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { at: clock.now(), url: String(url), method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    if (u.host !== 'api.tariffscan.futureenergy.associates') return resp(404, {});
    if (u.pathname === '/authentication/token') {
      const s = tokenStatus(call);
      // A refused login echoing the username, as some servers do: it must never reach a message.
      if (s !== 200) return resp(s, { detail: `unknown user ${new URLSearchParams(init.body).get('username')}` });
      tokens++;
      return resp(200, { access_token: `tok-${tokens}`, token_type: 'bearer' });
    }
    if (u.pathname === TS.DOMESTIC) return pages(call, calls);
    return resp(404, {});
  };
  return { fetch, calls, data: () => calls.filter((c) => c.path === TS.DOMESTIC), tokens: () => calls.filter((c) => c.path === '/authentication/token') };
}
const newClient = (api, { store = TS.memoryStore(), log } = {}) => TS.createClient({ username: SECRET.user, password: SECRET.pass, fetch: api.fetch, clock, store, log });
const gaps = (calls) => calls.slice(1).map((c, i) => c.at - calls[i].at);
// A Tariffscanner holding the fixture records: region batches by dno_region_id, else everything.
const catalogueApi = (records = RECORDS) => fakeApi((call) => page(records.filter((r) => call.query.dno_region_id === undefined || r.dno_region_id === Number(call.query.dno_region_id))));
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const tsRows = () => db.prepare(`SELECT r.* FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.provider = 'tariffscanner' ORDER BY r.id`).all().map((r) => ({ ...r }));
const freshState = () => db.exec("DELETE FROM provider_state WHERE provider = 'tariffscanner'");

// ───────────── Mapper ─────────────

test('mapper: pence stay pence, annual_cost pounds become minor units, one tariff per part and region', () => {
  const eco = rec(3097);   // Ecotricity dual fuel, single rate, DDM, Southern (Tariffscanner region 11)
  const m = TS.mapRecord(eco);
  assert.equal(m.skipped, null);
  assert.equal(m.annualCostMinor, 169701, '1697.01 pounds = 169701 pence; not stored');
  const by = Object.fromEntries(m.tariffs.map((t) => [t.tariff.tariffCode, t]));
  assert.deepEqual(Object.keys(by).sort(), ['TS-3097-D-constant-E-20', 'TS-3097-D-constant-G-20']);
  const e = by['TS-3097-D-constant-E-20'];
  assert.deepEqual([e.tariff.provider, e.tariff.country, e.tariff.currency, e.tariff.origin, e.tariff.fuel, e.tariff.direction, e.tariff.structure, e.tariff.kind, e.tariff.region],
    ['tariffscanner', 'GB', 'GBP', 'provider', 'electricity', 'import', 'flat', 'flat', '20']);
  assert.deepEqual(e.rows.map((r) => [r.component, r.register, r.paymentMethod, r.price]), [['unit', 'single', 'DDM', 29.21], ['standing', 'single', 'DDM', 49.7]]);
  // Price from the later of available_from (2017-11-29) and the day the rate was added (2026-04-01), London midnight.
  assert.deepEqual([e.rows[0].validFrom, e.rows[0].validTo], [london(2026, 4, 1), null]);
  assert.deepEqual(by['TS-3097-D-constant-G-20'].rows.map((r) => [r.component, r.price]), [['unit', 7.17], ['standing', 28.55]]);
  assert.match(e.tariff.originNote, /Southern \(id 11\) = gb_dno 20 Southern England/);
  // Published decimals are stored as they are (no rounding).
  const uw = TS.mapRecord(rec(329260)).tariffs.find((t) => t.tariff.fuel === 'electricity');
  assert.equal(uw.rows.find((r) => r.component === 'standing').price, 69.49295238095237);
  // 0 is "no such component": an electricity-only record has no gas tariff.
  assert.deepEqual(TS.mapRecord(rec(330112)).tariffs.map((t) => t.tariff.fuel), ['electricity']);
});

test('mapper: Tariffscanner region ids 1-14 are its own numbering, resolved through the aliases (Norweb 7 = MPAN 16)', () => {
  const norweb = rec(330335);
  assert.deepEqual([norweb.dno_region, norweb.dno_region_id], ['Norweb', 7]);
  const [t] = TS.mapRecord(norweb).tariffs;
  assert.equal(t.tariff.region, '16');
  assert.equal(t.tariff.tariffCode, 'TS-330335-E-constant-E-16');
  assert.match(TS.mapRecord({ ...norweb, dno_region_id: 1 }).skipped, /^region Norweb and dno_region_id 1 disagree$/);
  assert.equal(TS.mapRecord({ ...norweb, dno_region: null }).tariffs[0].tariff.region, '16', 'the id alone resolves through its alias');
  assert.match(TS.mapRecord({ ...norweb, dno_region: 'Atlantis', dno_region_id: 16 }).skipped, /not known/, '16 is an MPAN id, not a Tariffscanner one');
});

test('mapper: payment methods stay distinct rows; pricing uses them only where they agree', () => {
  const ddm = rec(330112);   // Octopus 12M Fixed, electricity only, DDM, Swalec
  const cac = { ...structuredClone(ddm), payment_method: 'CAC', tariff_id: 'derived-in-this-test', elec_import_unit_rate: ddm.elec_import_unit_rate + 1.5 };
  const m = TS.mapRecords([ddm, cac]);
  assert.equal(m.tariffs.size, 1);
  const [t] = m.tariffs.values();
  assert.equal(t.tariff.region, '21');
  assert.deepEqual(t.rows.map((r) => [r.component, r.paymentMethod, r.price]),
    [['unit', 'DDM', 30.93], ['standing', 'DDM', 54.44], ['unit', 'CAC', 32.43], ['standing', 'CAC', 54.44]]);
  const p = { rates: t.rows.map((r, i) => ({ id: i, tariff_id: 1, site_id: null, component: r.component, register: r.register, charge_period: null, payment_method: r.paymentMethod, valid_from: r.validFrom, valid_to: r.validTo, price_ex_vat: r.price })) };
  const ts = london(2026, 10, 20);
  assert.equal(rateRow(p, 1, 'unit', 'single', ts), null, 'unit prices differ by payment method: not priced on a guess');
  assert.equal(rateRow(p, 1, 'standing', 'single', ts).price_ex_vat, 54.44, 'equal standing charges are used');
  assert.deepEqual(m.warnings, []);
});

test('mapper: day/night records give day and night registers and the overnight hours as a window', () => {
  const edf = TS.mapRecord(rec(330067));   // EDF prepayment, dual fuel, day_night, Manweb (4 = MPAN 13)
  const e = edf.tariffs.find((t) => t.tariff.fuel === 'electricity');
  assert.deepEqual([e.tariff.tariffCode, e.tariff.structure, e.tariff.kind, e.tariff.defaultRegister], ['TS-330067-D-day_night-E-13', 'e7', 'tou', 'day']);
  assert.deepEqual(e.rows.map((r) => [r.component, r.register, r.paymentMethod, r.price]),
    [['unit', 'day', 'PRE', 34.582], ['unit', 'night', 'PRE', 15.393], ['standing', 'single', 'PRE', 67.019]]);
  assert.deepEqual(e.windows.map((w) => [w.register, w.start_min, w.end_min, w.weekdays, w.clock]), [['night', 23 * 60, 7 * 60, 127, 'local']]);
  assert.deepEqual(edf.tariffs.find((t) => t.tariff.fuel === 'gas').rows.map((r) => r.price), [8.99535, 35.3283]);
  assert.deepEqual(TS.mapRecord(rec(574)).tariffs[0].windows.map((w) => [w.start_min, w.end_min]), [[0, 420]], 'a window from midnight');
  // A single-rate record's overnight fields (sent as datetimes) are not a window.
  assert.deepEqual(TS.mapRecord(rec(3097)).tariffs.map((t) => t.windows.length), [0, 0]);
  // Rate types whose times the record does not carry are skipped with the reason, never guessed.
  assert.match(TS.mapRecord({ ...rec(330112), rate_type: 'half_hourly' }).skipped, /^rate_type half_hourly: no time structure in the record/);
  assert.equal(TS.mapRecord({ ...rec(330112), active: false }).skipped, 'inactive');
});

// ───────────── Client ─────────────

test('client: form-encoded token call, data in the query string with no body, the token reused, no secret in logs or errors', async () => {
  const lines = [];
  const api = fakeApi(() => page(PAGE1.data, { limit: 5 }));
  const c = newClient(api, { log: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`) });
  c.beginRun(10);
  await c.domestic({ active: true, offset: 0, limit: 5 });
  await c.domestic({ active: true, dno_region: ['Norweb', 'Swalec'], offset: 5, limit: 5 });
  const [tok, d1, d2] = api.calls;
  assert.equal(api.calls.length, 3, 'one token for both data calls');
  assert.deepEqual([tok.method, tok.path, tok.headers['content-type']], ['POST', '/authentication/token', 'application/x-www-form-urlencoded']);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tok.body)), { username: SECRET.user, password: SECRET.pass });
  assert.deepEqual([d1.method, d1.body, d1.headers.authorization], ['POST', undefined, 'Bearer tok-1']);
  assert.deepEqual(d1.query, { active: 'true', offset: '0', limit: '5' });
  assert.match(d2.url, /dno_region=Norweb&dno_region=Swalec/);
  assert.ok(!d1.url.includes(SECRET.pass) && !d1.url.includes(SECRET.user));
  // A refused login: the error names the variables, never their values or the echoed body.
  const bad = fakeApi(() => page([]), { tokenStatus: () => 401 });
  const b = newClient(bad, { log: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`) });
  b.beginRun(5);
  const err = await b.domestic({ active: true }).catch((e) => e);
  assert.equal(err.kind, 'auth');
  assert.equal(err.message, 'Tariffscanner authentication failed: HTTP 401 (check TARIFFSCAN_USERNAME and TARIFFSCAN_PASSWORD)');
  for (const s of [...lines, err.message, String(err.stack)]) for (const secret of [SECRET.user, SECRET.pass, 'tok-1']) assert.ok(!s.includes(secret), `no secret in: ${s}`);
});

test('client: at least 3 s between any two requests (the token call too, concurrent callers queue), and a restart waits for the persisted gap', async () => {
  freshState();
  const api = fakeApi(() => page([]));
  const c = newClient(api, { store: TS.dbStore() });
  c.beginRun(10);
  await c.domestic({ active: true });
  await Promise.all([c.domestic({ active: true }), c.domestic({ active: true })]);
  assert.equal(api.calls.length, 4);
  for (const g of gaps(api.calls)) assert.ok(g >= 3000, `gap ${g} ms`);
  const persisted = db.prepare("SELECT next_allowed_at FROM provider_state WHERE provider = 'tariffscanner'").get().next_allowed_at;
  assert.equal(persisted, api.calls.at(-1).at + 3000, 'next_allowed_at is in the database');
  // A new process (new client, same database) cannot burst: its token call waits for it.
  const restarted = newClient(api, { store: TS.dbStore() });
  restarted.beginRun(5);
  const before = api.calls.length;
  await restarted.domestic({ active: true });
  assert.ok(api.calls[before].at >= persisted, 'the first request after a restart waits for the persisted gap');
  for (const g of gaps(api.calls)) assert.ok(g >= 3000);
});

test('client: a 401 gets one new token and one retry; a second 401 fails', async () => {
  const expired = fakeApi((call) => (call.headers.authorization === 'Bearer tok-1' ? resp(401, { detail: 'expired' }) : page([])));
  const c = newClient(expired);
  c.beginRun(10);
  await c.domestic({ active: true });
  assert.deepEqual(expired.calls.map((x) => [x.path, x.headers.authorization ?? null]),
    [['/authentication/token', null], [TS.DOMESTIC, 'Bearer tok-1'], ['/authentication/token', null], [TS.DOMESTIC, 'Bearer tok-2']]);
  const refused = fakeApi(() => resp(401, { detail: 'no' }));
  const r = newClient(refused);
  r.beginRun(10);
  const err = await r.domestic({ active: true }).catch((e) => e);
  assert.match(err.message, /HTTP 401 after a new token$/);
  assert.equal(refused.tokens().length, 2, 'one re-authentication only');
  assert.equal(refused.data().length, 2);
});

test('paginate: follows has_more past a short page in the middle; a next_offset that does not advance stops it', async () => {
  const api = fakeApi((call) => {
    const off = Number(call.query.offset);
    if (off === 0) return page(PAGE1.data, { offset: 0, limit: 5, more: true, next: 5 });
    if (off === 5) return page(PAGE2.data.slice(0, 2), { offset: 5, limit: 5, more: true, next: 10 });   // short, not the last
    return page(DN.data, { offset: 10, limit: 5 });
  });
  const c = newClient(api);
  c.beginRun(10);
  const seen = [];
  for await (const p of c.paginate({ active: true }, { limit: 5 })) seen.push([p.offset, p.page.data.length, p.next]);
  assert.deepEqual(seen, [[0, 5, 5], [5, 2, 10], [10, 5, null]]);
  const stuck = fakeApi((call) => page(PAGE1.data, { offset: Number(call.query.offset), limit: 5, more: true, next: Number(call.query.offset) }));
  const s = newClient(stuck);
  s.beginRun(10);
  const stop = {};
  const got = [];
  for await (const p of s.paginate({ active: true }, { limit: 5, stop })) got.push(p.offset);
  assert.deepEqual(got, [0]);
  assert.equal(stuck.data().length, 1, 'the same page is not asked again');
  assert.match(stop.reason, /^next_offset 0 does not advance from offset 0: paging stopped$/);
});

// ───────────── Sweep ─────────────

let firstCounts;
test('sweep: the first sweep reads every active tariff region by region; a second identical sweep changes nothing', async () => {
  freshState();
  const api = catalogueApi();
  const c = newClient(api, { store: TS.dbStore() });
  const r1 = await TS.sweepCatalogue({ client: c, force: true });
  assert.deepEqual([r1.mode, r1.complete, r1.requests, r1.pages, r1.records, r1.skipped_records, r1.warnings], ['full', true, 15, 14, 15, {}, 0]);
  assert.deepEqual(api.data().map((x) => [x.query.active, x.query.dno_region_id, x.query.offset, x.query.limit, x.body]),
    TS.REGION_IDS.map((id) => ['true', String(id), '0', '1000', undefined]));
  for (const g of gaps(api.calls)) assert.ok(g >= 3000);
  firstCounts = {
    tariffs: count("SELECT COUNT(*) n FROM tariff WHERE provider = 'tariffscanner'"),
    rows: tsRows().length,
    windows: count("SELECT COUNT(*) n FROM register_window w JOIN tariff t ON t.id = w.tariff_id WHERE t.provider = 'tariffscanner'"),
  };
  assert.equal(firstCounts.tariffs, r1.tariffs_created);
  assert.equal(firstCounts.rows, r1.rate_rows);
  assert.equal(firstCounts.windows, 5, 'one night window per day/night electricity tariff');
  assert.equal(count("SELECT COUNT(*) n FROM tariff WHERE provider = 'tariffscanner' AND (country <> 'GB' OR currency <> 'GBP' OR origin <> 'provider')"), 0);
  assert.ok(tsRows().every((r) => r.origin === 'provider' && r.raw_id != null && r.site_id === null));
  // Next time: only what changed since the day before that sweep started, no region batches.
  clock.t += 3600 * 1000;
  const before = JSON.stringify([tsRows(), db.prepare("SELECT * FROM tariff WHERE provider = 'tariffscanner' ORDER BY id").all(), db.prepare('SELECT * FROM register_window ORDER BY id').all()]);
  const r2 = await TS.sweepCatalogue({ client: c, force: true });
  assert.deepEqual([r2.mode, r2.complete, r2.tariffs_created, r2.tariffs_updated, r2.rate_rows, r2.windows], ['incremental', true, 0, 0, 0, 0]);
  assert.deepEqual(api.data().at(-1).query, { active: 'true', last_updated_min: '2026-10-22', offset: '0', limit: '1000' });
  assert.equal(r2.requests, 1, 'the token is reused');
  assert.equal(JSON.stringify([tsRows(), db.prepare("SELECT * FROM tariff WHERE provider = 'tariffscanner' ORDER BY id").all(), db.prepare('SELECT * FROM register_window ORDER BY id').all()]), before, 'nothing changed');
});

test('sweep: a changed price supersedes the stored row and keeps what came before; nothing is deleted', async () => {
  const eco = rec(3097);
  const changed = { ...eco, elec_import_unit_rate: 30.5, rate_added_ts: '2026-10-01 09:00:00.000000', last_updated: '2026-10-01 09:00:05' };
  const so = rec(330499);   // a correction of the same rate (same start)
  const corrected = { ...so, elec_standing_charge: 56.1 };
  const others = RECORDS.filter((r) => ![3097, 330499].includes(r.product_id));
  const c = newClient(catalogueApi([changed, corrected, ...others]), { store: TS.dbStore() });
  const r = await TS.sweepCatalogue({ client: c, force: true });
  assert.equal(r.mode, 'incremental');
  const unit = db.prepare(`SELECT r.valid_from, r.valid_to, r.price_ex_vat, r.superseded_at FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
    WHERE t.tariff_code = 'TS-3097-D-constant-E-20' AND r.component = 'unit' ORDER BY r.id`).all().map((x) => [x.valid_from, x.valid_to, x.price_ex_vat, x.superseded_at != null]);
  assert.deepEqual(unit, [
    [london(2026, 4, 1), null, 29.21, true],                  // as stored first: superseded, kept
    [london(2026, 4, 1), london(2026, 10, 1), 29.21, false],  // the months before the change keep the old price
    [london(2026, 10, 1), null, 30.5, false],                 // the new price from the day it was added
  ]);
  const standing = db.prepare(`SELECT COUNT(*) n FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.tariff_code = 'TS-3097-D-constant-E-20' AND r.component = 'standing'`).get().n;
  assert.equal(standing, 1, 'the same standing charge re-stated from a later day changes nothing');
  const sc = db.prepare(`SELECT r.valid_from, r.price_ex_vat, r.superseded_at FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id
    WHERE t.tariff_code = 'TS-330499-E-constant-E-21' AND r.component = 'standing' ORDER BY r.id`).all().map((x) => [x.price_ex_vat, x.superseded_at != null]);
  assert.deepEqual(sc, [[55.53, true], [56.1, false]]);
  assert.equal(r.rate_rows, 2);
  assert.equal(tsRows().length, firstCounts.rows + 3, 'rows are added, never deleted');
});

test('sweep: the request budget stops it at a saved cursor, and the next run goes on from there (one page back)', async () => {
  freshState();
  const recs = RECORDS.slice(0, 15);
  // Region 1 holds three pages of 5; every other region is empty.
  const api = fakeApi((call) => {
    if (call.query.dno_region_id !== '1') return page([]);
    const off = Number(call.query.offset);
    return page(recs.slice(off, off + 5), { offset: off, limit: 5, more: off < 10, next: off < 10 ? off + 5 : null });
  });
  const c = newClient(api, { store: TS.dbStore() });
  const r1 = await TS.sweepCatalogue({ client: c, force: true, budget: 3, pageSize: 5 });
  assert.deepEqual([r1.complete, r1.requests, r1.pages], [false, 3, 2]);
  assert.match(r1.stopped, /^request budget of 3 reached/);
  assert.deepEqual(TS.readState().full, { started_at: TS.readState().full.started_at, region: 0, offset: 10 });
  const r2 = await TS.sweepCatalogue({ client: c, force: true, budget: 60, pageSize: 5 });
  assert.equal(r2.complete, true);
  const resumed = api.data().slice(2).map((x) => [x.query.dno_region_id, x.query.offset]);
  assert.deepEqual(resumed.slice(0, 3), [['1', '5'], ['1', '10'], ['2', '0']], 'resumes one page before the cursor');
  assert.equal(resumed.length, 2 + 13);
  assert.ok(TS.readState().last_complete_at);
});

test('sweep: a 429 aborts the run, the cooldown from Retry-After is persisted, and nothing is asked before it ends', async () => {
  freshState();
  const api = fakeApi((call) => (call.query.dno_region_id === '2' ? resp(429, { detail: 'slow down' }, { 'retry-after': '120' }) : page([])));
  const c = newClient(api, { store: TS.dbStore() });
  const err = await TS.sweepCatalogue({ client: c, force: true }).catch((e) => e);
  assert.equal(err.kind, 'rate_limited');
  assert.match(err.message, /HTTP 429 \(rate limited\): run aborted/);
  const hit = api.calls.at(-1);
  assert.equal(hit.query.dno_region_id, '2', 'no request after the 429');
  const s = db.prepare("SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = 'tariffscanner'").get();
  assert.equal(s.next_allowed_at, hit.at + 120000);
  assert.match(s.cooldown_reason, /^HTTP 429/);
  assert.deepEqual(TS.sweepStatus(), { status: 'error', reason: err.message });
  assert.equal(TS.sweepDue(clock.now()), false);   // the test's clock, not today's: the cooldown is measured from it
  const n = api.calls.length;
  const again = await TS.sweepCatalogue({ client: c, force: true });
  assert.match(again.skipped, /^cooling down: no request to Tariffscanner before .* \(HTTP 429/);
  assert.equal(api.calls.length, n, 'a forced sweep does not call during the cooldown');
  clock.t = s.next_allowed_at + 1000;
  const ok = await TS.sweepCatalogue({ client: newClient(catalogueApi(), { store: TS.dbStore() }), force: true });
  assert.equal(ok.complete, true);
  assert.equal(TS.sweepStatus().status, 'ok');
});

// ───────────── Registry and sync ─────────────

test('registry: plan() runs the catalogue for a GB home when the credential is set, skips it with a reason when not; FR and NL never list it', () => {
  const gb = createSite({ name: 'GB catalogue home', postcode: 'BB12 9BY' });
  let e = P.plan(db, gb).find((x) => x.adapter === 'tariffscanner');
  assert.deepEqual([e.role, e.run, e.chosen, e.log], ['tariff_catalogue', false, false, false]);
  assert.equal(e.skipped, 'no credentials: TARIFFSCAN_USERNAME, TARIFFSCAN_PASSWORD not set (start the server with --env-file=.env)');
  Object.assign(process.env, { TARIFFSCAN_USERNAME: SECRET.user, TARIFFSCAN_PASSWORD: SECRET.pass });
  const p = P.plan(db, gb);
  const cat = p.filter((x) => x.role === 'tariff_catalogue');
  // Additive role: Octopus's products list (read by the comparison step) AND Tariffscanner's catalogue.
  assert.deepEqual(cat.map((x) => [x.adapter, x.chosen, x.run, x.step]), [['octopus', true, false, 'tariff_catalogue:octopus'], ['tariffscanner', true, true, 'tariffscanner']]);
  const ts = cat[1];
  assert.deepEqual([ts.connection, ts.priority, ts.scope, ts.origin], ['tariffscanner', 20, 'shared', 'provider']);
  assert.equal(ts.note, 'Tariffscanner (FEA) UK domestic tariff catalogue, queried with the core\'s own credential; contract terms not read by us.');
  assert.equal(ts.creds.username, SECRET.user, 'the core\'s own credential, for any GB home');
  assert.ok(!('baseUrl' in ts.creds), 'an unset optional variable is left out, never "undefined"');
  assert.ok(!JSON.stringify(p).includes(SECRET.pass));
  const row = db.prepare("SELECT * FROM market_provider WHERE adapter = 'tariffscanner'").all();
  assert.deepEqual(row.map((r) => [r.market_code, r.role, r.enabled, r.needs_credentials, r.licence_confirmed, r.owner, r.origin]), [['GB', 'tariff_catalogue', 1, 1, 1, 'core', 'provider']]);
  for (const country of ['FR', 'NL']) {
    const s = createSite({ name: `${country} home`, country, lat: 50, lon: 4 });
    assert.ok(!P.plan(db, s).some((x) => x.adapter === 'tariffscanner'), country);
  }
  // Status: the role names its first provider; the catalogue it also runs is under `also`.
  const st = P.providerStatus(db, gb).find((x) => x.role === 'tariff_catalogue');
  assert.equal(st.adapter, 'octopus');
  assert.deepEqual(st.also.map((a) => [a.adapter, a.status]), [['tariffscanner', 'ok']]);
  for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD']) delete process.env[k];
});

test('sync: the catalogue step runs once per cycle and once a day; a failure is on its connection row and the other steps go on', async () => {
  freshState();
  Object.assign(process.env, { TARIFFSCAN_USERNAME: SECRET.user, TARIFFSCAN_PASSWORD: SECRET.pass });
  let fail = false;
  const api = fakeApi((call) => (fail ? resp(500, { detail: 'down' }) : page(RECORDS.filter((r) => r.dno_region_id === Number(call.query.dno_region_id ?? r.dno_region_id)))));
  TS.tariffscannerPolicy.clock = clock;
  TS.tariffscannerPolicy.fetch = api.fetch;
  TS.resetClients();
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'api.carbonintensity.org.uk') return json({ data: [{ regionid: 3, data: [] }] });
    if (u.host === 'api.open-meteo.com') return json({ hourly: { time: [] } });
    if (u.host === 'api.octopus.energy' && u.pathname === '/v1/products/') return json({ results: [] });
    if (u.host === 'api.octopus.energy') return json({ results: [], next: null });
    return refuse(url);
  };
  const home = (name) => {
    const s = createSite({ name, postcode: 'BB12 9BY', lat: 53.79, lon: -2.24, gspRegion: 'G', carbonRegion: 3 });
    db.prepare("UPDATE site SET outcode = 'BB12' WHERE id = ?").run(s.id);
    for (const p of ['weather', 'carbon', 'solar_forecast', 'compare']) db.prepare('INSERT OR IGNORE INTO connection (site_id, provider) VALUES (?, ?)').run(s.id, p);
    return s.id;
  };
  try {
    const a = home('Sweeper A');
    const b = home('Sweeper B');
    const [ra, rb] = await syncAll([a, b]);
    const step = (r) => r.log.find((l) => l.step === 'tariffscanner');
    assert.deepEqual([step(ra).ok, step(ra).mode, step(ra).complete, step(ra).requests], [true, 'full', true, 15]);
    assert.equal(step(rb), undefined, 'once per cycle: the second home does not run it, nor log it');
    assert.equal(db.prepare("SELECT status FROM connection WHERE site_id = ? AND provider = 'tariffscanner'").get(a).status, 'ok');
    const n = api.calls.length;
    const [again] = await syncAll([a]);
    assert.equal(step(again), undefined, 'once a day: not due');
    assert.equal(api.calls.length, n);
    // A day later the upstream fails: the step's error is recorded, the home's other steps still run.
    clock.t += 25 * 3600 * 1000;
    fail = true;
    const r = await syncSite(b);
    assert.equal(step(r).ok, false);
    assert.match(step(r).error, /^Tariffscanner POST \/v1\/general\/get_domestic_product -> HTTP 500/);
    assert.equal(db.prepare("SELECT last_error FROM connection WHERE site_id = ? AND provider = 'tariffscanner'").get(b).last_error, step(r).error);
    for (const s of ['weather', 'carbon', 'compare', 'build']) assert.equal(r.log.find((l) => l.step === s)?.ok, true, s);
    assert.equal(TS.sweepStatus().status, 'error');
    assert.ok(!JSON.stringify(db.prepare('SELECT detail FROM sync_run').all()).includes(SECRET.pass), 'no secret in the sync log');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM provider_state').all()).includes('tok-'), 'no token stored');
    // By hand: forced now, whatever the daily gate says (the upstream is back).
    fail = false;
    const forced = await TS.forceTariffscannerSweep();
    assert.equal(forced.complete, true);
    db.prepare("UPDATE market_provider SET enabled = 0 WHERE adapter = 'tariffscanner'").run();
    assert.match((await TS.forceTariffscannerSweep()).skipped, /disabled/);
    db.prepare("UPDATE market_provider SET enabled = 1 WHERE adapter = 'tariffscanner'").run();
    for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD']) delete process.env[k];
    assert.match((await TS.forceTariffscannerSweep()).skipped, /^no credentials: TARIFFSCAN_USERNAME, TARIFFSCAN_PASSWORD not set/);
  } finally {
    globalThis.fetch = refuse;
    TS.tariffscannerPolicy.clock = null;
    TS.tariffscannerPolicy.fetch = null;
    for (const k of ['TARIFFSCAN_USERNAME', 'TARIFFSCAN_PASSWORD']) delete process.env[k];
  }
});

// ───────────── API ─────────────

const server = app.listen(0);
after(() => server.close());
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${server.address().port}${p}`, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
  }).on('error', reject);
});

test('/api/catalog lists a provider\'s tariffs only when asked, with origin and the rates in force', async () => {
  const plain = await get('/api/catalog');
  assert.deepEqual(Object.keys(plain.json), ['sources', 'metrics', 'vat', 'taxRules', 'markets', 'currencies'], 'unchanged without the parameter');
  assert.ok(plain.json.sources.some((s) => s.code === 'tariffscanner'));
  const r = await get('/api/catalog?tariffs=tariffscanner&region=Norweb');
  assert.equal(r.status, 200);
  assert.ok(r.json.tariffs.length >= 1);
  for (const t of r.json.tariffs) {
    assert.deepEqual([t.region, t.currency, t.country, t.origin], ['16', 'GBP', 'GB', 'provider']);
    assert.ok(t.rates.length && t.rates.every((x) => x.origin === 'provider' && typeof x.price_ex_vat === 'number'));
  }
  const all = await get('/api/catalog?tariffs=tariffscanner&limit=1000');
  assert.equal(all.json.tariffs.length, count("SELECT COUNT(*) n FROM tariff WHERE provider = 'tariffscanner'"));
  assert.deepEqual(stray, [], 'no request left this process');
});
