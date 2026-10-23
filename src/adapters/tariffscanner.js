// Tariffscanner (FEA) adapter: the UK domestic tariff catalogue, queried with the core's own
// credential (TARIFFSCAN_USERNAME, TARIFFSCAN_PASSWORD; TARIFFSCAN_BASE_URL optional), registered
// as a second GB tariff_catalogue provider (src/db/seed/providers.js, src/jobs/steps.js).
//
// The API, as its OpenAPI document and live answers show it:
//   POST /authentication/token     form-encoded username + password (JSON is refused), answers
//                                  { access_token, token_type }; a token lasts 24 hours
//   POST /v1/general/get_domestic_product
//                                  every parameter in the QUERY STRING, no body; one page
//                                  { data, pagination: { offset, limit, returned, has_more, next_offset } }
//                                  limit 1-1000. A query needs a filter (active, query_date, a
//                                  date bound or one region), else HTTP 400. A short page is NOT the
//                                  last one (filtering after paging): only has_more says so.
//   limits                         20 requests a minute, at least 3 s between two requests, per
//                                  credential: anything else using the same credential shares them.
//
// Client: one token per credential, reused until 5 minutes before it lapses; one new token and one
// retry on a 401. Every request, the token call included, goes through one queue: at least 3 s
// apart (start to start and end to start), and never before provider_state.next_allowed_at (delta
// 009), written before and after every request, so a restarted server cannot burst. A 429 sets
// next_allowed_at from its Retry-After (60 s at least) and aborts the run. Each run has a hard
// request budget (default 60, the token call counted); reaching it stops the sweep cleanly at a
// saved cursor. fetch and the clock are injectable (tests); nothing here logs or throws a
// credential or the token (every message is scrubbed).
//
// Sweep (once a day at most unless forced): the first sweep reads every active tariff, one region
// batch at a time (dno_region_id 1-14), saving the cursor after each page, over as many runs as the
// budget needs. Once a full sweep has completed, each later sweep asks only for what changed:
// active=true&last_updated_min=<day before the last complete sweep started>.
//
// Mapping, one upstream record = product x region x payment method x service type (E electricity,
// D dual fuel, G gas) x rate type:
//   tariff   one per product x service type x rate type x part x region, because rate rows carry
//            no region (as Octopus has one tariff code per region): part E electricity import,
//            G gas, X electricity export. tariff_code TS-<product_id>-<service>-<rate_type>-<part>-<gb_dno>,
//            region = the gb_dno code (MPAN 10-23) resolved from Tariffscanner's region name and id
//            through the region aliases (tariffscan_name, tariffscan_id 1-14: NOT the MPAN numbering;
//            a record whose name and id disagree is skipped). Country GB, GBP, origin 'provider'.
//   rows     unit (p/kWh) and standing (p/day) rate rows, one per payment method (DDM, CAC, PRE ...
//            stored as given): never merged, so pricing.js rateRow uses them only where every method
//            agrees, as for Octopus. Pence are stored as published: the API does not state the VAT
//            basis. A 0 means "no such component", never free. valid_from = Europe/London midnight
//            of the later of available_from and the day the rate was added (rate_added_ts, else
//            last_updated); valid_to = the midnight after available_to (NULL while it is offered).
//   structure constant -> flat; day_night -> e7 (unit rows day and night, the overnight_start /
//            overnight_end hours stored as register_window rows, NOT used for pricing because a
//            meter's own switch times may differ, as for Octopus Economy 7); export -> export.
//            Other rate types (half_hourly, static_tou, dynamic_tou, day_night_e10, export_tou ...)
//            carry no time structure in the record and are skipped, counted by reason.
//   annual_cost (pounds) is converted to minor units (x 100) in the mapped record, not stored:
//            it is upstream's estimate for an assumed consumption, not a price.
// Writes are idempotent: an identical sweep changes nothing; a changed price supersedes the current
// row (kept as history, with the part before the new start kept at the old price); nothing is
// deleted. Withdrawn tariffs are not detected (no deleted-ids feed is read): their rows stay.
import { createHash } from 'node:crypto';
import { db, tx } from '../db/db.js';
import { landRaw } from '../core/facts.js';
import { createTariff, putWindows } from '../core/tariffs.js';
import { resolveRegion, aliasesOf } from '../core/regions.js';
import { dayBounds, localDate, addDays } from '../core/time.js';
import { envCredentials, SERVICE_CREDENTIALS } from '../core/providers.js';
import { assertOwner } from './contract.js';
import { tariffKindOf, nativePeriodOf } from './octopus.js';

export const PROVIDER = 'tariffscanner';
export const DEFAULT_BASE_URL = 'https://api.tariffscan.futureenergy.associates';
export const DOMESTIC = '/v1/general/get_domestic_product';
const TOKEN_PATH = '/authentication/token';
const TZ = 'Europe/London';
const DAY_MS = 86400000;
const TOKEN_TTL_MS = DAY_MS;              // "tokens are valid for 24 hours"; the answer has no expires_in
const TOKEN_MARGIN_MS = 5 * 60 * 1000;    // renewed this long before it lapses, so a sweep never meets it
// Tariffscanner's own region ids (1-14), used only to batch the first sweep by region.
export const REGION_IDS = Object.freeze(Array.from({ length: 14 }, (_, i) => i + 1));

const envInt = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

// Mutable so tests can inject a clock and a fetch (as http.js retryPolicy is). The gap can be made
// longer through the environment, never shorter than the published 3 s.
export const tariffscannerPolicy = {
  minIntervalMs: envInt('TARIFFSCAN_MIN_REQUEST_INTERVAL_MS', 3000, 3000, 600000),
  timeoutMs: envInt('TARIFFSCAN_HTTP_TIMEOUT_MS', 30000, 1000, 120000),
  budget: envInt('TARIFFSCAN_REQUEST_BUDGET', 60, 1, 1000),
  pageSize: envInt('TARIFFSCAN_PAGE_SIZE', 1000, 1, 1000),
  sweepEveryMs: DAY_MS,
  cooldown429Ms: 60000,    // after a 429 without Retry-After
  maxWaitMs: 15000,        // a longer wait skips the run rather than sleeping inside a sync step
  clock: null,             // { now: () => ms, sleep: (ms) => Promise }; null: the real clock
  fetch: null,             // null: globalThis.fetch at call time
};
const policy = tariffscannerPolicy;
export const REAL_CLOCK = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const clockOf = (c) => c ?? policy.clock ?? REAL_CLOCK;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class TariffscannerError extends Error {
  // kind: auth | upstream | rate_limited | budget | cooldown | network | shape
  constructor(message, { kind = 'upstream', status = null } = {}) {
    super(message);
    this.name = 'TariffscannerError';
    this.kind = kind;
    this.status = status;
  }
}

// ───────────── Persisted cooldown (provider_state, delta 009) ─────────────

// next_allowed_at only ever moves later: a 429's cooldown is not shortened by the normal gap.
export function dbStore(provider = PROVIDER) {
  const get = db.prepare('SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = ?');
  const put = db.prepare(`INSERT INTO provider_state (provider, next_allowed_at, cooldown_reason, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET
      cooldown_reason = CASE WHEN excluded.next_allowed_at >= IFNULL(provider_state.next_allowed_at, 0) THEN excluded.cooldown_reason ELSE provider_state.cooldown_reason END,
      next_allowed_at = MAX(IFNULL(provider_state.next_allowed_at, 0), excluded.next_allowed_at),
      updated_at = excluded.updated_at`);
  return {
    nextAllowedAt: () => get.get(provider)?.next_allowed_at ?? 0,
    reason: () => get.get(provider)?.cooldown_reason ?? null,
    setNextAllowedAt: (ms, why = null) => { put.run(provider, Math.ceil(ms), why, Date.now()); },
  };
}

// Same shape, in memory (the smoke script: nothing written).
export function memoryStore() {
  let next = 0;
  let why = null;
  return {
    nextAllowedAt: () => next,
    reason: () => why,
    setNextAllowedAt: (ms, reason = null) => { if (ms >= next) { next = ms; why = reason; } },
  };
}

// ───────────── Client ─────────────

function retryAfterMs(res, nowMs) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

// Every parameter goes in the query string; a list repeats its key (dno_region=A&dno_region=B).
export function queryString(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, String(x));
  }
  return q.toString();
}

/**
 * A client for one credential. { username, password, baseUrl?, fetch?, clock?, store?, log? }.
 * store: dbStore() (persisted cooldown) or memoryStore(). log(message, fields) gets progress lines
 * with no credential, token or response body. Methods: beginRun(budget), used, domestic(params),
 * paginate(params, { offset, limit, stop }).
 */
export function createClient({ username, password, baseUrl = null, fetch: fetchFn = null, clock = null, store = memoryStore(), log = () => {} } = {}) {
  if (!username || !password) throw new TariffscannerError('no credentials: TARIFFSCAN_USERNAME and TARIFFSCAN_PASSWORD are needed', { kind: 'auth' });
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const clk = () => clockOf(clock);
  const doFetch = (url, init) => (fetchFn ?? policy.fetch ?? globalThis.fetch)(url, init);
  let token = null;          // { value, refreshAt }: memory only, never stored or logged
  let pendingAuth = null;
  let lastAt = -Infinity;    // end of the last request (ms, on the client's clock)
  let tail = Promise.resolve();
  let budget = null;
  let used = 0;
  const scrub = (s) => [username, password, token?.value].filter(Boolean).reduce((o, x) => o.split(x).join('[redacted]'), String(s ?? ''));
  const fail = (msg, opts) => new TariffscannerError(scrub(msg), opts);
  const note = (msg, fields = {}) => { try { log(scrub(msg), JSON.parse(scrub(JSON.stringify(fields)))); } catch { /* a logger never breaks a sweep */ } };

  // One request at a time, in order, each at least minIntervalMs after the previous one ended and
  // not before the persisted next_allowed_at.
  const serial = (fn) => { const r = tail.then(fn); tail = r.then(() => {}, () => {}); return r; };
  async function send(pathAndQuery, init) {
    const path = pathAndQuery.split('?')[0];
    if (budget != null && used >= budget) throw fail(`request budget of ${budget} reached`, { kind: 'budget' });
    const now0 = clk().now();
    const at = Math.max(lastAt + policy.minIntervalMs, store.nextAllowedAt() ?? 0);
    if (at - now0 > policy.maxWaitMs) {
      const why = store.reason?.();
      throw fail(`cooling down: no request to Tariffscanner before ${iso(at)}${why ? ` (${why})` : ''}`, { kind: 'cooldown' });
    }
    if (at > now0) await clk().sleep(at - now0);
    used++;
    const started = clk().now();
    store.setNextAllowedAt(started + policy.minIntervalMs);
    let res;
    try {
      res = await doFetch(`${base}${pathAndQuery}`, { ...init, signal: AbortSignal.timeout(policy.timeoutMs) });
    } catch (err) {
      lastAt = clk().now();
      store.setNextAllowedAt(lastAt + policy.minIntervalMs);
      const what = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `timed out after ${policy.timeoutMs} ms` : (err?.message ?? String(err));
      throw fail(`Tariffscanner ${init.method} ${path} -> ${what}`, { kind: 'network' });
    }
    lastAt = clk().now();
    store.setNextAllowedAt(lastAt + policy.minIntervalMs);
    if (res.status === 429) {
      const until = lastAt + Math.max(retryAfterMs(res, lastAt) ?? 0, policy.cooldown429Ms);
      store.setNextAllowedAt(until, `HTTP 429 at ${iso(lastAt)}`);
      await res.text?.().catch(() => '');
      throw fail(`Tariffscanner ${init.method} ${path} -> HTTP 429 (rate limited): run aborted, no request before ${iso(until)}`, { kind: 'rate_limited', status: 429 });
    }
    return res;
  }

  async function authenticate() {
    const res = await serial(() => send(TOKEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ username, password }).toString(),
    }));
    const text = await res.text().catch(() => '');
    // A refused login's body is never put into a message or a log: it can echo the username.
    if (!res.ok) throw fail(`Tariffscanner authentication failed: HTTP ${res.status} (check TARIFFSCAN_USERNAME and TARIFFSCAN_PASSWORD)`, { kind: 'auth', status: res.status });
    let j = null;
    try { j = JSON.parse(text); } catch { /* checked below */ }
    if (!j?.access_token) throw fail('Tariffscanner authentication: the answer has no access_token', { kind: 'auth', status: res.status });
    const expires = Number(j.expires_in);
    const ttl = Number.isFinite(expires) && expires > 0 ? expires * 1000 : TOKEN_TTL_MS;
    token = { value: j.access_token, refreshAt: clk().now() + ttl - TOKEN_MARGIN_MS };
    note('Tariffscanner token obtained', { valid_s: Math.round(ttl / 1000) });
    return token.value;
  }
  function getToken() {
    if (token && clk().now() < token.refreshAt) return Promise.resolve(token.value);
    pendingAuth ??= authenticate().finally(() => { pendingAuth = null; });
    return pendingAuth;
  }

  async function post(path, params, retried = false) {
    const value = await getToken();
    const qs = queryString(params);
    const res = await serial(() => send(`${path}${qs ? `?${qs}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${value}`, accept: 'application/json' } }));
    if (res.status === 401 && !retried) {
      await res.text().catch(() => '');
      if (token?.value === value) token = null;   // most likely expired: one new token, one retry
      note('Tariffscanner answered 401: new token, one retry', { path });
      return post(path, params, true);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = res.status >= 400 && res.status < 500 && ![401, 403].includes(res.status) && text ? `: ${text.slice(0, 200)}` : '';
      throw fail(`Tariffscanner POST ${path} -> HTTP ${res.status}${retried && res.status === 401 ? ' after a new token' : ''}${detail}`, { kind: res.status === 401 || res.status === 403 ? 'auth' : 'upstream', status: res.status });
    }
    try { return JSON.parse(text); } catch { throw fail(`Tariffscanner POST ${path} -> the answer is not JSON`, { kind: 'shape' }); }
  }

  // Every page of a query, one at a time ({ page, offset, next }). Follows has_more and
  // next_offset only (a short page is not the last); a next_offset that does not advance stops
  // the walk and says why in stop.reason, rather than asking the same page again.
  async function* paginate(params, { offset = 0, limit = policy.pageSize, stop = {} } = {}) {
    let at = offset;
    for (;;) {
      const page = await post(DOMESTIC, { ...params, offset: at, limit });
      if (!Array.isArray(page?.data)) throw fail(`Tariffscanner POST ${DOMESTIC} -> no data array (offset ${at})`, { kind: 'shape' });
      const p = page.pagination ?? {};
      const more = p.has_more === true;
      const next = more ? Number(p.next_offset) : null;
      const advances = more && Number.isInteger(next) && next > at;
      if (more && !advances) stop.reason = `next_offset ${p.next_offset ?? 'missing'} does not advance from offset ${at}: paging stopped`;
      note('Tariffscanner page', { offset: at, returned: page.data.length, has_more: more });
      yield { page, offset: at, next: advances ? next : null };
      if (!advances) return;
      at = next;
    }
  }

  return {
    get clock() { return clk(); },
    get used() { return used; },
    beginRun(n = policy.budget) { budget = n ?? null; used = 0; },
    domestic: (params) => post(DOMESTIC, params),
    paginate,
    scrub,
  };
}

// One client per credential in this process, so every caller shares its queue and its token.
const clients = new Map();
export function clientFor(creds) {
  const key = createHash('sha256').update([creds.baseUrl ?? '', creds.username, creds.password].join('\u0000')).digest('hex');
  if (!clients.has(key)) clients.set(key, createClient({ ...creds, store: dbStore(), log: (m, f) => { if (process.env.TARIFFSCAN_LOG === '1') console.log(m, JSON.stringify(f)); } }));
  return clients.get(key);
}
export const resetClients = () => clients.clear();

// The core's own credential from the environment ({ creds } or { missing: reason naming the variables }).
export const credentialsFromEnv = (env = process.env) => envCredentials(SERVICE_CREDENTIALS,
  { username: 'TARIFFSCAN_USERNAME', password: 'TARIFFSCAN_PASSWORD' }, { baseUrl: 'TARIFFSCAN_BASE_URL' }, env);

// ───────────── Mapper ─────────────

const SERVICE = { E: 'electricity only', D: 'dual fuel', G: 'gas only' };
const RATE_TYPES = { constant: 'flat', day_night: 'e7', export: 'export' };
const RATE_LABEL = { constant: 'single rate', day_night: 'day/night', export: 'export' };
const PART = {
  E: { fuel: 'electricity', direction: 'import', label: 'electricity import' },
  G: { fuel: 'gas', direction: 'import', label: 'gas' },
  X: { fuel: 'electricity', direction: 'export', label: 'electricity export' },
};
// A price in pence, or null for "no such component" (0, missing or not a number).
const price = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const dateOf = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : null);
// '23:00:00' or '2026-10-23 23:00:00' (both forms are sent) -> minutes after midnight.
function minuteOf(v) {
  const m = /(?:^|[ T])(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(v ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * One upstream record -> { tariffs: [{ tariff, rows, windows }], skipped (reason | null), warnings,
 * annualCostMinor }. tariff is createTariff's argument; rows { component, register, paymentMethod,
 * validFrom, validTo, price, originNote }; windows register_window rows (day/night only). Pure.
 */
export function mapRecord(rec) {
  const warnings = [];
  const annual = Number(rec?.annual_cost);
  const annualCostMinor = rec?.annual_cost !== null && rec?.annual_cost !== undefined && Number.isFinite(annual) ? round6(annual * 100) : null;
  const skip = (reason) => ({ tariffs: [], skipped: reason, warnings, annualCostMinor });
  const pid = rec?.product_id;
  if (!(Number.isInteger(pid) || /^\d+$/.test(String(pid ?? '')))) return skip('no product_id');
  const product = String(pid);
  if (rec.active === false) return skip('inactive');
  const pm = typeof rec.payment_method === 'string' && rec.payment_method.trim() ? rec.payment_method : null;
  if (!pm) return skip('no payment_method');
  const st = rec.service_type;
  if (!SERVICE[st]) return skip(`service_type ${st} not known`);
  const rt = rec.rate_type;
  const structure = RATE_TYPES[rt];
  if (!structure) return skip(`rate_type ${rt}: no time structure in the record, not mapped`);
  // Region by Tariffscanner name and by its own id 1-14, through the aliases; never their id as ours.
  const byName = rec.dno_region ? resolveRegion('tariffscan_name', rec.dno_region) : null;
  const byId = rec.dno_region_id != null ? resolveRegion('tariffscan_id', rec.dno_region_id) : null;
  if (byName && byId && byName.code !== byId.code) return skip(`region ${rec.dno_region} and dno_region_id ${rec.dno_region_id} disagree`);
  const region = byName ?? byId;
  if (!region) return skip(`region ${rec.dno_region ?? '?'} / ${rec.dno_region_id ?? '?'} not known`);
  const from = [dateOf(rec.available_from), dateOf(rec.rate_added_ts) ?? dateOf(rec.last_updated)].filter(Boolean).sort().pop();
  if (!from) return skip('no available_from or rate date');
  const validFrom = dayBounds(TZ, from)[0];
  const to = dateOf(rec.available_to);
  const validTo = to ? dayBounds(TZ, to)[1] : null;
  if (validTo !== null && validTo <= validFrom) return skip(`available_to ${to} is before the price start ${from}`);

  const parts = [];
  if (st !== 'G' && structure !== 'export') {
    const standing = price(rec.elec_standing_charge);
    const sc = standing === null ? [] : [['standing', 'single', standing]];
    if (structure === 'flat') {
      const unit = price(rec.elec_import_unit_rate);
      if (unit === null) warnings.push('no electricity unit rate: electricity not stored');
      else parts.push({ part: 'E', structure, rows: [['unit', 'single', unit], ...sc], windows: [] });
    } else {
      const day = price(rec.elec_import_unit_rate);
      const night = price(rec.elec_import_unit_rate_night);
      if (day === null || night === null) warnings.push('day/night record without both rates: electricity not stored');
      else {
        const s = minuteOf(rec.overnight_start);
        const e = minuteOf(rec.overnight_end);
        const windows = s !== null && e !== null && s !== e
          ? [{ register: 'night', start_min: s, end_min: e === 0 ? 1440 : e, weekdays: 127, clock: 'local', source_text: `${hhmm(s)}-${hhmm(e)} (Tariffscanner overnight_start, overnight_end)` }]
          : [];
        if (!windows.length) warnings.push('day/night record without overnight hours: registers stored without times');
        parts.push({ part: 'E', structure, rows: [['unit', 'day', day], ['unit', 'night', night], ...sc], windows });
      }
    }
  }
  if (st === 'D' || st === 'G') {
    const unit = price(rec.gas_unit_rate);
    const standing = price(rec.gas_standing_charge);
    if (unit !== null) parts.push({ part: 'G', structure: 'flat', rows: [['unit', 'single', unit], ...(standing === null ? [] : [['standing', 'single', standing]])], windows: [] });
    else warnings.push('no gas unit rate: gas not stored');
  }
  if (st !== 'G') {
    const exp = price(rec.elec_export_unit_rate);
    if (exp !== null) parts.push({ part: 'X', structure: 'export', rows: [['unit', 'single', exp]], windows: [] });
    else if (structure === 'export') warnings.push('export record without an export rate');
  }
  if (!parts.length) return skip('no price in the record');

  const tsAlias = Object.fromEntries(aliasesOf(region).map((a) => [a.alias_scheme, a.alias_code]));
  const supplier = typeof rec.supplier_name === 'string' && rec.supplier_name.trim() ? rec.supplier_name.trim() : 'Unknown supplier';
  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : `product ${product}`;
  const tariffs = parts.map((p) => {
    const kind = PART[p.part];
    return {
      tariff: {
        provider: PROVIDER, tariffCode: `TS-${product}-${st}-${rt}-${p.part}-${region.code}`, productCode: product,
        fuel: kind.fuel, direction: kind.direction, structure: p.structure, kind: tariffKindOf(p.structure), nativePeriodS: nativePeriodOf(p.structure),
        region: region.code, name: `${supplier}: ${name}`, country: 'GB', currency: 'GBP', origin: 'provider',
        originNote: `Tariffscanner (FEA) get_domestic_product: product ${product} (${rec.tariff_type ?? 'type not given'}), ${SERVICE[st]}, ${RATE_LABEL[rt]}, ${kind.label}; `
          + `Tariffscanner region ${tsAlias.tariffscan_name} (id ${tsAlias.tariffscan_id}) = gb_dno ${region.code} ${region.name}; pence as published (the API does not state the VAT basis)`,
        defaultRegister: p.structure === 'e7' ? 'day' : null,
      },
      rows: p.rows.map(([component, register, value]) => ({
        component, register, paymentMethod: pm, validFrom, validTo, price: value,
        originNote: `Tariffscanner tariff_id ${rec.tariff_id ?? '?'}, rate_id ${rec.rate_id ?? '?'}`,
      })),
      windows: p.windows,
    };
  });
  return { tariffs, skipped: null, warnings, annualCostMinor };
}

/**
 * Many records -> { tariffs: Map(tariff_code -> { tariff, rows, windows }), skipped: { reason: n },
 * records, warnings }. The records of one tariff in other payment methods add their rows; two
 * records giving one row different prices keep the first and say so.
 */
export function mapRecords(records) {
  const tariffs = new Map();
  const skipped = {};
  const warnings = [];
  for (const rec of records ?? []) {
    const m = mapRecord(rec);
    const who = `product ${rec?.product_id ?? '?'} ${rec?.payment_method ?? '?'} ${rec?.service_type ?? '?'}/${rec?.rate_type ?? '?'} ${rec?.dno_region ?? '?'}`;
    for (const w of m.warnings) warnings.push(`${who}: ${w}`);
    if (m.skipped) { skipped[m.skipped] = (skipped[m.skipped] ?? 0) + 1; continue; }
    for (const t of m.tariffs) {
      const code = t.tariff.tariffCode;
      const cur = tariffs.get(code);
      if (!cur) { tariffs.set(code, { tariff: t.tariff, rows: [...t.rows], windows: t.windows }); continue; }
      if (JSON.stringify(cur.tariff) !== JSON.stringify(t.tariff)) warnings.push(`${code}: records disagree on the tariff's details; the first is kept`);
      if (!cur.windows.length) cur.windows = t.windows;
      else if (t.windows.length && JSON.stringify(cur.windows) !== JSON.stringify(t.windows)) warnings.push(`${code}: payment methods give different overnight hours; the first is kept`);
      for (const r of t.rows) {
        const same = cur.rows.find((x) => x.component === r.component && x.register === r.register && x.paymentMethod === r.paymentMethod && x.validFrom === r.validFrom);
        if (!same) cur.rows.push(r);
        else if (same.price !== r.price || same.validTo !== r.validTo) warnings.push(`${code} ${r.paymentMethod} ${r.component}/${r.register}: two records give different prices; the first is kept`);
      }
    }
  }
  return { tariffs, skipped, records: (records ?? []).length, warnings };
}

// ───────────── Store (idempotent, bitemporal, never deletes) ─────────────

const TARIFF_FIELDS = [['product_code', 'productCode'], ['fuel', 'fuel'], ['direction', 'direction'], ['structure', 'structure'], ['region', 'region'],
  ['name', 'name'], ['kind', 'kind'], ['country', 'country'], ['currency', 'currency'], ['native_period_s', 'nativePeriodS'], ['origin', 'origin'],
  ['origin_note', 'originNote'], ['default_register', 'defaultRegister']];

function upsertTariffRow(t) {
  const cur = db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(t.tariffCode);
  if (!cur) return { row: createTariff(t), created: 1, updated: 0 };
  if (cur.provider !== PROVIDER) throw new Error(`tariff code ${t.tariffCode} belongs to ${cur.provider}: not overwritten`);
  const diff = TARIFF_FIELDS.filter(([col, key]) => (cur[col] ?? null) !== (t[key] ?? null));
  if (!diff.length) return { row: cur, created: 0, updated: 0 };
  db.prepare(`UPDATE tariff SET ${diff.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...diff.map(([, k]) => t[k] ?? null), cur.id);
  return { row: db.prepare('SELECT * FROM tariff WHERE id = ?').get(cur.id), created: 0, updated: 1 };
}

const KEY = 'tariff_id = ? AND site_id IS NULL AND component = ? AND register = ? AND payment_method = ? AND charge_period IS NULL AND superseded_at IS NULL';
const covering = db.prepare(`SELECT * FROM rate_interval WHERE ${KEY} AND valid_from <= ? AND IFNULL(valid_to, 9000000000) > ? ORDER BY valid_from DESC LIMIT 1`);
const overlapping = db.prepare(`SELECT * FROM rate_interval WHERE ${KEY} AND valid_from < ? AND IFNULL(valid_to, 9000000000) > ?`);
const supRate = db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?');
const insRate = db.prepare(`INSERT INTO rate_interval (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, raw_id, origin, origin_note, estimated)
  VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'provider', ?, 0)`);

// A row the current rows already say is left alone: the current row covering its start has its
// price and its end (the same price re-stated from a later day changes nothing). A changed one
// supersedes every current row it overlaps; the part of an old row before the new start keeps its
// old price (a new copy), what lies after it is upstream's latest word: the new row. Returns the
// rows written.
export function putCatalogueRates(tariffId, rows, { rawId = null, recordedAt = Date.now() } = {}) {
  let changed = 0;
  tx(() => {
    for (const r of [...rows].sort((a, b) => a.validFrom - b.validFrom)) {
      const k = [tariffId, r.component, r.register, r.paymentMethod];
      const cur = covering.get(...k, r.validFrom, r.validFrom);
      if (cur && (cur.valid_to ?? null) === (r.validTo ?? null) && Math.abs(cur.price_ex_vat - r.price) < 1e-9) continue;
      for (const o of overlapping.all(...k, r.validTo ?? 9000000000, r.validFrom)) {
        supRate.run(recordedAt, o.id);
        if (o.valid_from < r.validFrom) insRate.run(tariffId, o.component, o.register, o.payment_method, o.valid_from, r.validFrom, o.price_ex_vat, recordedAt, o.raw_id, o.origin_note);
      }
      insRate.run(tariffId, r.component, r.register, r.paymentMethod, r.validFrom, r.validTo ?? null, r.price, recordedAt, rawId, r.originNote ?? null);
      changed++;
    }
  });
  return changed;
}

// The overnight hours of a day/night tariff: a different set supersedes the current one (kept);
// a record without hours never removes known ones.
function putCatalogueWindows(tariffId, windows, recordedAt) {
  if (!windows.length) return 0;
  const cur = db.prepare('SELECT register, start_min, end_min, weekdays, clock FROM register_window WHERE tariff_id = ? AND device_id IS NULL AND superseded_at IS NULL').all(tariffId);
  const key = (ws) => ws.map((w) => [w.register, w.start_min, w.end_min, w.weekdays ?? 127, w.clock ?? 'local'].join('|')).sort().join(',');
  if (key(cur) === key(windows)) return 0;
  db.prepare('UPDATE register_window SET superseded_at = ? WHERE tariff_id = ? AND device_id IS NULL AND superseded_at IS NULL').run(recordedAt, tariffId);
  return putWindows(tariffId, windows, {
    origin: 'provider', recordedAt,
    originNote: 'Tariffscanner overnight_start / overnight_end: the supplier\'s stated night hours; a meter\'s own switch times may differ, so the tariff (structure e7) is not priced from them',
  });
}

/** Write mapRecords' result in one transaction: { tariffs_created, tariffs_updated, rate_rows, windows }. */
export function storeMapped(mapped, { rawId = null, recordedAt = Date.now() } = {}) {
  const out = { tariffs_created: 0, tariffs_updated: 0, rate_rows: 0, windows: 0 };
  tx(() => {
    for (const { tariff, rows, windows } of mapped.tariffs.values()) {
      const u = upsertTariffRow(tariff);
      out.tariffs_created += u.created;
      out.tariffs_updated += u.updated;
      out.rate_rows += putCatalogueRates(u.row.id, rows, { rawId, recordedAt });
      if (tariff.structure === 'e7') out.windows += putCatalogueWindows(u.row.id, windows, recordedAt);
    }
  });
  return out;
}

// ───────────── Sweep ─────────────

export function readState() {
  const r = db.prepare('SELECT state FROM provider_state WHERE provider = ?').get(PROVIDER);
  try { return JSON.parse(r?.state || '{}'); } catch { return {}; }
}
function writeState(s) {
  db.prepare(`INSERT INTO provider_state (provider, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(PROVIDER, JSON.stringify(s), Date.now());
}

// When the next unforced sweep may start (ms): a day after the last one started, whatever its outcome.
export const nextSweepAt = (state = readState()) => (state.last_run_at ? state.last_run_at + policy.sweepEveryMs : 0);
// Whether an unforced sweep would run now: due, and not cooling down after a 429.
export function sweepDue(nowMs = clockOf(null).now()) {
  return nextSweepAt() <= nowMs && dbStore().nextAllowedAt() - nowMs <= policy.maxWaitMs;
}

let sweeping = false;
const summary = (r) => `${r.complete ? 'complete' : 'partial'} ${r.mode} sweep, ${r.pages} pages, ${r.records} records, ${r.rate_rows} rate rows written${r.stopped ? `; ${r.stopped}` : ''}`;

/**
 * One sweep run: { mode: full | incremental, requests, pages, records, tariffs_created,
 * tariffs_updated, rate_rows, windows, skipped_records: { reason: n }, warnings, complete,
 * stopped?, paging_stopped? }, or { skipped: reason } when not due (unless force), cooling down
 * or already running. The budget stops the run cleanly (cursor saved, complete false); a 429,
 * an auth failure or any other error is recorded in provider_state and thrown.
 */
export async function sweepCatalogue({ client, force = false, budget = policy.budget, pageSize = policy.pageSize } = {}) {
  if (sweeping) return { skipped: 'a Tariffscanner sweep is already running' };
  const clock = client.clock;
  const t0 = clock.now();
  const st = readState();
  if (!force && nextSweepAt(st) > t0) return { skipped: `not due: one sweep a day at most, the next after ${iso(nextSweepAt(st))}` };
  const store = dbStore();
  if (store.nextAllowedAt() - t0 > policy.maxWaitMs) {
    return { skipped: `cooling down: no request to Tariffscanner before ${iso(store.nextAllowedAt())}${store.reason() ? ` (${store.reason()})` : ''}` };
  }
  sweeping = true;
  try {
    return await sweepRun({ client, clock, t0, st, budget, pageSize });
  } finally {
    sweeping = false;
  }
}

async function sweepRun({ client, clock, t0, st, budget, pageSize }) {
  client.beginRun(budget);
  const rep = { mode: st.last_complete_at ? 'incremental' : 'full', requests: 0, pages: 0, records: 0, tariffs_created: 0, tariffs_updated: 0, rate_rows: 0, windows: 0, skipped_records: {}, warnings: 0, complete: false };
  const samples = [];
  st.last_run_at = t0;
  writeState(st);

  // One query's pages from the cursor (one page back when resuming a run: rows that moved up since
  // are read again rather than missed). Each page is landed raw, then written with the cursor in
  // one transaction.
  const batch = async (query, cursor, label) => {
    const stop = {};
    const start = cursor.offset > 0 ? Math.max(0, cursor.offset - pageSize) : 0;
    for await (const { page, offset, next } of client.paginate(query, { offset: start, limit: pageSize, stop })) {
      const { rawId } = landRaw({ source: PROVIDER, siteId: null, request: { method: 'POST', path: DOMESTIC, query: { ...query, offset, limit: pageSize } }, body: page });
      const mapped = mapRecords(page.data);
      tx(() => {
        const n = storeMapped(mapped, { rawId });
        for (const k of Object.keys(n)) rep[k] += n[k];
        cursor.offset = next ?? offset + page.data.length;
        writeState(st);
      });
      rep.pages++;
      rep.records += page.data.length;
      for (const [reason, n] of Object.entries(mapped.skipped)) rep.skipped_records[reason] = (rep.skipped_records[reason] ?? 0) + n;
      rep.warnings += mapped.warnings.length;
      samples.push(...mapped.warnings.slice(0, 5 - samples.length));
    }
    if (stop.reason) (rep.paging_stopped ??= []).push(`${label}: ${stop.reason}`);
  };

  try {
    if (rep.mode === 'full') {
      // First sweep: every active tariff, one Tariffscanner region (id 1-14) at a time.
      st.full ??= { started_at: t0, region: 0, offset: 0 };
      while (st.full.region < REGION_IDS.length) {
        const id = REGION_IDS[st.full.region];
        await batch({ active: true, dno_region_id: id }, st.full, `region ${id}`);
        st.full.region++;
        st.full.offset = 0;
        writeState(st);
      }
      st.last_complete_at = st.full.started_at;
      st.full = null;
    } else {
      // Later sweeps: what changed since the day before the last complete sweep started.
      const since = addDays(localDate(TZ, Math.floor(st.last_complete_at / 1000)), -1);
      if (!st.inc || st.inc.since !== since) st.inc = { since, started_at: t0, offset: 0 };
      await batch({ active: true, last_updated_min: since }, st.inc, `changes since ${since}`);
      st.last_complete_at = st.inc.started_at;
      st.inc = null;
    }
    rep.complete = true;
  } catch (err) {
    if (err?.kind !== 'budget') {
      st.last_error = client.scrub(err?.message ?? String(err));
      st.last_error_at = clock.now();
      writeState(st);
      throw err;
    }
    rep.stopped = `${err.message}: the sweep goes on from its saved cursor next time`;
  }
  rep.requests = client.used;
  if (samples.length) rep.warning_samples = samples;
  st.last_ok_at = clock.now();
  st.last_error = null;
  st.last_summary = summary(rep);
  writeState(st);
  return rep;
}

// For providerStatus: the catalogue's own state, whichever home ran it.
export function sweepStatus() {
  const st = readState();
  if (st.last_error && (st.last_error_at ?? 0) >= (st.last_ok_at ?? 0)) return { status: 'error', reason: st.last_error };
  if (st.last_ok_at) return { status: 'ok', reason: `${st.last_summary ?? 'swept'} (${iso(st.last_ok_at)}); next sweep after ${iso(nextSweepAt(st))}` };
  return { status: 'skipped', reason: 'no sweep yet' };
}

/**
 * Sweep now, whatever the once-a-day gate says (the cooldown after a 429 and the request budget
 * still hold). Uses the registry row (enabled, licensed, owned by the core) and the core's credential
 * from the environment; returns the sweep's report or { skipped: reason }.
 */
export async function forceTariffscannerSweep({ budget = policy.budget, env = process.env } = {}) {
  const row = db.prepare("SELECT enabled, licence_confirmed, owner FROM market_provider WHERE market_code = 'GB' AND role = 'tariff_catalogue' AND adapter = ?").get(PROVIDER);
  if (!row) return { skipped: `${PROVIDER} is not in the market provider registry` };
  if (!row.enabled) return { skipped: `${PROVIDER} is disabled in the market provider registry` };
  if (!row.licence_confirmed) return { skipped: `${PROVIDER}: licence unconfirmed in the market provider registry` };
  assertOwner({ code: PROVIDER, owner: row.owner });
  const c = credentialsFromEnv(env);
  if (c.missing) return { skipped: c.missing };
  return sweepCatalogue({ client: clientFor(c.creds), force: true, budget });
}
