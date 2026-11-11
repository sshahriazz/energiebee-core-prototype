// tounify v2 adapter: EU retail electricity prices per kWh (energy, grid, fees and VAT as separate components) for a
// home's tariff at its postal code. An EU tariff source (not UK): registered for FR and NL only
// (src/db/seed/providers.js: tariff_prices per home, tariff_catalogue shared), switched on but UNLICENSED: the plan
// skips it until the storage and reuse licence is confirmed in writing; TOUNIFY_DEV=1 with a TEST token runs it for
// development, labelled.
//
// The API, as its OpenAPI document (https://api.tounify.io/openapi/v2.json, info.description) and the answers captured
// in test/fixtures/tounify/v2/ show it (Nov 2026):
//   base https://api.tounify.io, header Authorization: Bearer <token> (env TOUNIFY_API_KEY). A token starting
//   tounify_test_sk_ is a free TESTING token, tounify_prod_sk_ a production one. Every answer carries X-Request-Id.
//   GET /v2/{cc}/consumption/companies                  the country's suppliers (national, no address needed)
//   GET /v2/{cc}/grid/companies?postal_code=            the network operator serving a postal code
//   GET /v2/{cc}/consumption/{company}/tariffs          a supplier's household tariffs: { id, name, type, available, link }
//   GET /v2/{cc}/dayahead?consumption_tariff=&postal_code=&include=fees,vat&resolution=900|1800|3600&historic_days=0-3
//        today and tomorrow (once published) and up to 3 days back, in the country's own time zone; each point
//        { from_utc, energy, grid, fees, vat } per kWh in the major unit; `next` is when to ask again. Its ETag is not
//        a validator (the spec says never to send it back): it is read in full each time.
//   There is no connection to register in v2: a price is asked for a tariff id and a postal code. What v3 kept per
//   connection (capacity, metering, off-peak hours) is not taken: v2 prices France's heures creuses on the reference
//   window 23:00-07:00 Paris; the home's own off-peak hours are applied here (mapPrices, offPeak).
//   NO FIXED CHARGES: capacity, standing, subscription and per-connection levies or credits are in no v2 answer. Fixed
//   rows a home already holds (from the v3 preview, or typed in) are kept as they are; none is written or ended here.
//   Errors: an unknown id is a 400 (never a 404); a 403 testingLimit { kind, limit, used, remaining, blocked } means a
//   testing token's total allowance is used up; a 429 may carry rateLimit { resetAt } and Retry-After, and a 429
//   without rateLimit is a daily limit (stop until midnight UTC).
//   A testing token: one request at a time, at most 5 new things per endpoint per day (the country on /companies, the
//   company on /tariffs, the tariff combination on /dayahead), 100 requests a day, 20 companies and 20 tariffs in
//   TOTAL (never reset: a company is spent when its tariffs are listed, a tariff when it is priced on /dayahead).
//
// Client: Bearer token from the environment, never stored, logged or put in a message (scrubbed).
// One request at a time, at least 1 s apart, never before provider_state.next_allowed_at (a 429's
// Retry-After / resetAt / next UTC midnight, persisted so a restart cannot burst). fetch and the
// clock are injectable (tounifyPolicy, or createClient's options).
// ALLOWANCE GUARD (a test token, or one without a known prefix): persisted counters in
// provider_state ('tounify' row, state.allowance): requests today (UTC), the distinct companies and
// tariffs ever named, the new things asked per endpoint today. Defaults 40 requests a day, 8
// companies, 8 tariffs, 5 new things per endpoint per day (TOUNIFY_MAX_REQUESTS_DAY,
// TOUNIFY_MAX_COMPANIES, TOUNIFY_MAX_TARIFFS, TOUNIFY_MAX_NEW_PER_ENDPOINT_DAY; for a test token never
// above the published 100 / 20 / 20 / 5). A call that would pass one is refused before it is sent
// (kind 'allowance': the step is skipped with the reason). A 429 or a 403 testingLimit stops the
// whole run (kind 'rate_limited' / 'allowance_exhausted'); the cooldown or the exhausted allowance
// is persisted, so the next homes of the cycle are not called either.
// Cadence: at most ONE price read per home per UTC day, and never before the answer's `next`; one catalogue refresh
// (suppliers, and the tariffs of the suppliers our homes are on) per country per 7 days, with ETags.
//
// A home's tariff is kept here, not upstream: the connection row (provider 'tounify', external_ref eb-site-<site id>,
// a local reference only) holds in meta the country, the postal code, the tariff ids, the supplier and the off-peak
// hours (registerConnection). No personal data is ever sent: the postal code and the tariff id only.
//
// Mapping:
//   tariff     TOUNIFY-<cc>-<tariff id>, provider 'tounify', the answer's currency; static -> flat or tou (whether the
//              series holds more than one price), dynamic -> dynamic; native_period_s = the resolution asked;
//              taxes_in_price = 1 when every point carries `fees` and `vat`.
//   unit rows  one per price point, home-specific (site_id), price in MINOR units per kWh ex VAT =
//              (energy + grid + fees) x 100; vat is never stored as a price.
//   VAT        each point's rate (vat / (energy + grid + fees)) is compared with our tax_rule VAT: a mismatch is a
//              warning in the step result, our rule is never overridden.
//   origin     'provider', note 'tounify v2 (test token): storage licence unconfirmed' for a test token (and the
//              TOUNIFY_DEV override named when it applies).
// mapPrices and mapComponents also read the v3 preview's answers a home landed before (the Explorer replays them).
// Writes are idempotent (the same answer twice changes nothing), a changed price supersedes the
// stored row (kept as history), nothing is deleted, and every answer is landed raw (landRaw); an
// answer missing an expected field is quarantined ('unexpected shape') and the step fails soft.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, tx, dataDir } from '../db/db.js';
import { landRaw, quarantine } from '../core/facts.js';
import { createTariff, addDevice } from '../core/tariffs.js';
import { supersedeAgreements } from '../core/devices.js';
import { linkSupplier } from '../core/suppliers.js';
import { CURRENCIES, toMinor } from '../core/money.js';
import { rulesFor } from '../core/tax.js';
import { dayBounds, localDate, slotLength, recordedNow } from '../core/time.js';
import { connectable } from '../core/providers.js';

export const PROVIDER = 'tounify';
export const BASE_URL = 'https://api.tounify.io';
export const TEST_PREFIX = 'tounify_test_sk_';
export const PROD_PREFIX = 'tounify_prod_sk_';
export const LABEL = 'tounify (EU tariffs, v2)';
export const ORIGIN_NOTE_TEST = 'tounify v2 (test token): storage licence unconfirmed';
export const ORIGIN_NOTE_PROD = 'tounify v2';
export const DEV_LABEL = 'TOUNIFY_DEV=1: development override of the unconfirmed licence (test token only)';
export const RESOLUTIONS = Object.freeze([900, 1800, 3600]);
// Each country's day, as /dayahead bounds it (the spec's historic_days; the answer does not state it).
export const COUNTRY_ZONE = Object.freeze({ AT: 'Europe/Vienna', BE: 'Europe/Brussels', DE: 'Europe/Berlin', ES: 'Europe/Madrid', FR: 'Europe/Paris', GB: 'Europe/London', IT: 'Europe/Rome', NL: 'Europe/Amsterdam', PT: 'Europe/Lisbon' });
// France's heures creuses as /dayahead prices them: the reference window 23:00-07:00 Paris (the spec: "the network operator
// assigns each meter its own eight off-peak hours ... apply the served off-peak and peak prices to its own window").
export const FR_REFERENCE_OFF_PEAK = Object.freeze({ from: '23:00', to: '07:00' });
const DAY_MS = 86400000;
// What a TESTING token may do, as the API publishes it (info.description, Rate limits).
export const PUBLISHED_TEST_LIMITS = Object.freeze({ requestsPerDay: 100, companies: 20, tariffs: 20, newPerEndpointDay: 5 });
export const DEFAULT_TEST_LIMITS = Object.freeze({ requestsPerDay: 40, companies: 8, tariffs: 8, newPerEndpointDay: 5 });
const LIMIT_ENV = Object.freeze({ requestsPerDay: 'TOUNIFY_MAX_REQUESTS_DAY', companies: 'TOUNIFY_MAX_COMPANIES', tariffs: 'TOUNIFY_MAX_TARIFFS', newPerEndpointDay: 'TOUNIFY_MAX_NEW_PER_ENDPOINT_DAY' });

const envInt = (env, name, fallback, min, max) => {
  const n = Number(env?.[name]);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

// Mutable so tests can inject a clock and a fetch (as tariffscannerPolicy). The gap can be made
// longer through the environment, never shorter than 1 s.
export const tounifyPolicy = {
  minIntervalMs: envInt(process.env, 'TOUNIFY_MIN_REQUEST_INTERVAL_MS', 1000, 1000, 600000),
  timeoutMs: 30000,
  maxWaitMs: 15000,          // a longer wait skips the call rather than sleeping inside a sync step
  cooldown429Ms: 60000,      // at least this long after a 429
  catalogueEveryMs: 7 * DAY_MS,
  historicDays: 1,           // yesterday too: tounify serves only a few past days, so each read keeps one
  clock: null,               // { now: () => ms, sleep: (ms) => Promise }; null: the real clock
  fetch: null,               // null: globalThis.fetch at call time
};
const policy = tounifyPolicy;
export const REAL_CLOCK = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const clockOf = (c) => c ?? policy.clock ?? REAL_CLOCK;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (r) => `${Math.round(r * 10000) / 100} %`;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export class TounifyError extends Error {
  // kind: auth | allowance | allowance_exhausted | rate_limited | cooldown | network | upstream | shape
  constructor(message, { kind = 'upstream', status = null, code = null } = {}) {
    super(message);
    this.name = 'TounifyError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

// ───────────── Token, credentials, development override ─────────────

/** 'test' | 'prod' | 'unknown' (no known prefix: limited as a test token) | null (no token). */
export function tokenKind(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.startsWith(TEST_PREFIX)) return 'test';
  if (token.startsWith(PROD_PREFIX)) return 'prod';
  return 'unknown';
}

/** The core's own token from the environment: { creds: { token, kind, dev } } or { missing }. */
export function credentialsFromEnv(env = process.env) {
  const token = env.TOUNIFY_API_KEY;
  if (!token) return { missing: 'no credentials: TOUNIFY_API_KEY not set' };
  return { creds: { token, kind: tokenKind(token), dev: devOverrideLabel(env) } };
}

/** The TOUNIFY_DEV label when the override applies (TOUNIFY_DEV=1 and a TEST token), else null. */
export function devOverrideLabel(env = process.env) {
  return env.TOUNIFY_DEV === '1' && tokenKind(env.TOUNIFY_API_KEY) === 'test' ? DEV_LABEL : null;
}

/** The note rate rows and tariffs carry: the token kind and, when used, the development override. */
export function originNote({ kind = 'test', dev = null } = {}) {
  const base = kind === 'prod' ? ORIGIN_NOTE_PROD : ORIGIN_NOTE_TEST;
  return dev ? `${base}; ${dev}` : base;
}

/** The allowance limits for a token kind: test (and unknown) tokens are capped, production ones are not unless set. */
export function limitsFor(kind, env = process.env) {
  const test = kind !== 'prod';
  const out = {};
  for (const [k, name] of Object.entries(LIMIT_ENV)) {
    const max = test ? PUBLISHED_TEST_LIMITS[k] : 1e9;
    out[k] = envInt(env, name, test ? DEFAULT_TEST_LIMITS[k] : null, 0, max);
  }
  return out;
}

// ───────────── Persisted state (provider_state, delta 009; never a token) ─────────────

export function readState(d = db) {
  const r = d.prepare('SELECT state FROM provider_state WHERE provider = ?').get(PROVIDER);
  try { return JSON.parse(r?.state || '{}'); } catch { return {}; }
}
function writeState(s) {
  db.prepare(`INSERT INTO provider_state (provider, state, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).run(PROVIDER, JSON.stringify(s), Date.now());
}
function updateState(fn) { const s = readState(); fn(s); writeState(s); return s; }

// next_allowed_at only ever moves later: a 429's cooldown is not shortened by the normal gap.
export function dbStore() {
  const get = db.prepare('SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = ?');
  const put = db.prepare(`INSERT INTO provider_state (provider, next_allowed_at, cooldown_reason, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET
      cooldown_reason = CASE WHEN excluded.next_allowed_at >= IFNULL(provider_state.next_allowed_at, 0) THEN excluded.cooldown_reason ELSE provider_state.cooldown_reason END,
      next_allowed_at = MAX(IFNULL(provider_state.next_allowed_at, 0), excluded.next_allowed_at),
      updated_at = excluded.updated_at`);
  return {
    nextAllowedAt: () => get.get(PROVIDER)?.next_allowed_at ?? 0,
    reason: () => get.get(PROVIDER)?.cooldown_reason ?? null,
    setNextAllowedAt: (ms, why = null) => { put.run(PROVIDER, Math.ceil(ms), why, Date.now()); },
  };
}

// The allowance counters, reset per UTC day where they are daily.
function allowanceOf(s, nowMs) {
  const a = s.allowance ?? {};
  const today = utcDay(nowMs);
  if (a.day !== today) { a.day = today; a.requests = 0; a.scopes = {}; }
  a.requests ??= 0; a.scopes ??= {}; a.companies ??= []; a.tariffs ??= []; a.exhausted ??= {}; a.upstream ??= {};
  s.allowance = a;
  return a;
}

/** The allowance counters for display (never the token): requests today, distinct companies and tariffs, limits, cooldown. */
export function tounifyAllowance(d = db, { env = process.env, nowMs = clockOf(null).now() } = {}) {
  const kind = tokenKind(env.TOUNIFY_API_KEY);
  const limits = limitsFor(kind ?? 'test', env);
  const s = readState(d);
  const a = allowanceOf(structuredClone(s), nowMs);
  const cd = d.prepare('SELECT next_allowed_at, cooldown_reason FROM provider_state WHERE provider = ?').get(PROVIDER);
  return {
    token_kind: kind,
    token: kind ? `${kind} token set (TOUNIFY_API_KEY)` : 'no token: TOUNIFY_API_KEY not set',
    guarded: kind !== 'prod',
    dev_override: devOverrideLabel(env),
    day_utc: a.day,
    requests_today: a.requests,
    max_requests_day: limits.requestsPerDay,
    companies: { used: a.companies.length, max: limits.companies, ids: [...a.companies] },
    tariffs: { used: a.tariffs.length, max: limits.tariffs, ids: [...a.tariffs] },
    new_per_endpoint_today: Object.fromEntries(Object.entries(a.scopes).map(([k, v]) => [k, v.length])),
    max_new_per_endpoint_day: limits.newPerEndpointDay,
    upstream: a.upstream,
    exhausted: a.exhausted,
    cooldown: cd?.next_allowed_at > nowMs ? { until: iso(cd.next_allowed_at), reason: cd.cooldown_reason ?? null } : null,
    connections: Object.keys(s.connections ?? {}).length,
  };
}

// ───────────── Client ─────────────

function retryAfterMs(res, nowMs) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}
const header = (res, name) => res?.headers?.get?.(name) ?? null;
const intHeader = (res, name) => { const v = header(res, name); const n = Number(v); return v != null && Number.isFinite(n) ? n : null; };

/**
 * A client for one token: { token, baseUrl?, fetch?, clock?, store?, env?, log? }. Methods:
 * request(method, path, { query, body, etag, ifMatch, scope: { endpoint, thing }, names: { companies, tariffs } })
 * -> { status, body, etag, notModified, requestId }; kind, limits, clock, scrub.
 */
export function createClient({ token, baseUrl = BASE_URL, fetch: fetchFn = null, clock = null, store = dbStore(), env = process.env, log = () => {} } = {}) {
  if (!token) throw new TounifyError('no credentials: TOUNIFY_API_KEY not set', { kind: 'auth' });
  const base = String(baseUrl).replace(/\/+$/, '');
  const kind = tokenKind(token);
  const limits = limitsFor(kind, env);
  const clk = () => clockOf(clock);
  const doFetch = (url, init) => (fetchFn ?? policy.fetch ?? globalThis.fetch)(url, init);
  const scrub = (x) => String(x ?? '').split(token).join('[redacted]');
  const fail = (msg, opts) => new TounifyError(scrub(msg), opts);
  const note = (msg, fields = {}) => { try { log(scrub(msg), JSON.parse(scrub(JSON.stringify(fields)))); } catch { /* a logger never breaks a sync */ } };
  let lastAt = -Infinity;
  let tail = Promise.resolve();
  const serial = (fn) => { const r = tail.then(fn); tail = r.then(() => {}, () => {}); return r; };

  // Refused before any call: the reason, or null when the call may be sent. Pure on the state.
  function refusal(a, { scope, names }) {
    if (limits.requestsPerDay != null && a.requests >= limits.requestsPerDay) {
      return `allowance: ${a.requests} of ${limits.requestsPerDay} requests used today (UTC, ${LIMIT_ENV.requestsPerDay}): no request before midnight UTC`;
    }
    for (const k of ['companies', 'tariffs']) {
      const fresh = [...new Set((names?.[k] ?? []).filter(Boolean))].filter((id) => !a[k].includes(id));
      if (!fresh.length) continue;
      if (a.exhausted[k]) return `allowance: tounify refused new ${k} (${a.exhausted[k].blocked?.join(', ') || 'testing allowance exhausted'}): ${fresh.join(', ')} not asked`;
      if (a.upstream[`${k}_remaining`] === 0) return `allowance: tounify reports 0 ${k} left for this testing token: ${fresh.join(', ')} not asked`;
      if (limits[k] != null && a[k].length + fresh.length > limits[k]) {
        return `allowance: ${a[k].length} of ${limits[k]} distinct ${k} already named (${LIMIT_ENV[k]}); ${fresh.join(', ')} would pass it`;
      }
    }
    if (scope && limits.newPerEndpointDay != null) {
      const seen = a.scopes[scope.endpoint] ?? [];
      if (!seen.includes(scope.thing) && seen.length >= limits.newPerEndpointDay) {
        return `allowance: ${seen.length} of ${limits.newPerEndpointDay} new ${scope.endpoint} asked today (UTC, ${LIMIT_ENV.newPerEndpointDay}): ${scope.thing} waits until midnight UTC`;
      }
    }
    return null;
  }

  async function send(method, pathname, { query = null, body = undefined, etag = null, ifMatch = null, scope = null, names = null } = {}) {
    const now0 = clk().now();
    // 1. The allowance, persisted: refused here means no call at all.
    let why = null;
    updateState((s) => {
      const a = allowanceOf(s, now0);
      why = refusal(a, { scope, names });
      if (!why) a.requests++;   // counted before it is sent, so a failed call still counts
    });
    if (why) throw fail(why, { kind: 'allowance' });
    // 2. The gap and the persisted cooldown.
    const at = Math.max(lastAt + policy.minIntervalMs, store.nextAllowedAt() ?? 0);
    if (at - now0 > policy.maxWaitMs) {
      updateState((s) => { const a = allowanceOf(s, now0); a.requests = Math.max(0, a.requests - 1); });
      const r = store.reason?.();
      throw fail(`cooling down: no request to tounify before ${iso(at)}${r ? ` (${r})` : ''}`, { kind: 'cooldown' });
    }
    if (at > now0) await clk().sleep(at - now0);
    const started = clk().now();
    store.setNextAllowedAt(started + policy.minIntervalMs);
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : '';
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (etag) headers['if-none-match'] = etag;
    if (ifMatch) headers['if-match'] = ifMatch;
    let res;
    try {
      res = await doFetch(`${base}${pathname}${qs ? `?${qs}` : ''}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(policy.timeoutMs) });
    } catch (err) {
      lastAt = clk().now();
      store.setNextAllowedAt(lastAt + policy.minIntervalMs);
      const what = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `timed out after ${policy.timeoutMs} ms` : (err?.message ?? String(err));
      throw fail(`tounify ${method} ${pathname} -> ${what}`, { kind: 'network' });
    }
    lastAt = clk().now();
    store.setNextAllowedAt(lastAt + policy.minIntervalMs);
    const requestId = header(res, 'x-request-id');
    const text = res.status === 304 ? '' : await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    // What tounify says is left of a testing token's totals (no header counts requests).
    const up = { companies_remaining: intHeader(res, 'x-testing-companies-remaining'), tariffs_remaining: intHeader(res, 'x-testing-tariffs-remaining'), new_things_remaining: intHeader(res, 'x-ratelimit-remaining') };
    const ok = res.status >= 200 && res.status < 300;
    updateState((s) => {
      const a = allowanceOf(s, lastAt);
      for (const [k, v] of Object.entries(up)) if (v != null) a.upstream[k] = v;
      if (Object.values(up).some((v) => v != null)) a.upstream.at = iso(lastAt);
      if (ok || res.status === 304) {
        if (scope) { const seen = a.scopes[scope.endpoint] ?? []; if (!seen.includes(scope.thing)) a.scopes[scope.endpoint] = [...seen, scope.thing]; }
        for (const k of ['companies', 'tariffs']) for (const id of names?.[k] ?? []) if (id && !a[k].includes(id)) a[k].push(id);
      }
    });
    note('tounify request', { method, path: pathname, status: res.status, request_id: requestId });
    const code = isObj(json) && typeof json.code === 'string' ? json.code : null;
    const where = `tounify ${method} ${pathname}`;
    if (res.status === 304) return { status: 304, notModified: true, body: null, etag: header(res, 'etag') ?? etag, requestId };
    if (res.status === 429) {
      const resetAt = isObj(json?.rateLimit) ? Date.parse(json.rateLimit.resetAt) : NaN;
      const ra = retryAfterMs(res, lastAt);
      // A 429 with neither Retry-After nor rateLimit is a daily limit: no request before midnight UTC.
      const daily = ra == null && !Number.isFinite(resetAt) && code !== 'concurrent_request';
      const until = Math.max(lastAt + policy.cooldown429Ms, ra != null ? lastAt + ra : 0, Number.isFinite(resetAt) ? resetAt : 0, daily ? nextUtcMidnight(lastAt) : 0);
      store.setNextAllowedAt(until, `HTTP 429${code ? ` ${code}` : ''} at ${iso(lastAt)}`);
      throw fail(`${where} -> HTTP 429${code ? ` (${code})` : ''}: run stopped, no request before ${iso(until)}`, { kind: 'rate_limited', status: 429, code });
    }
    if (res.status === 403 && isObj(json?.testingLimit)) {
      const t = json.testingLimit;
      const k = t.kind === 'companies' || t.kind === 'tariffs' ? t.kind : String(t.kind ?? 'unknown');
      updateState((s) => {
        const a = allowanceOf(s, lastAt);
        a.exhausted[k] = { at: iso(lastAt), limit: t.limit ?? null, used: t.used ?? null, remaining: t.remaining ?? null, blocked: Array.isArray(t.blocked) ? t.blocked.map(String) : [] };
        a.upstream[`${k}_remaining`] = num(t.remaining) ? t.remaining : 0;
      });
      throw fail(`${where} -> HTTP 403 (${code ?? 'testing limit'}): the testing allowance of ${k} is used up${t.blocked?.length ? ` (blocked: ${t.blocked.join(', ')})` : ''}; run stopped`, { kind: 'allowance_exhausted', status: 403, code });
    }
    if (!ok) {
      const detail = code ? ` (${code}${json?.param ? `, ${json.param}` : ''})${res.status < 500 && typeof json?.message === 'string' ? `: ${json.message.slice(0, 200)}` : ''}` : '';
      throw fail(`${where} -> HTTP ${res.status}${detail}${requestId ? ` [X-Request-Id ${requestId}]` : ''}`, { kind: res.status === 401 || res.status === 403 ? 'auth' : 'upstream', status: res.status, code });
    }
    if (text && json === null) throw fail(`${where} -> the answer is not JSON`, { kind: 'shape', status: res.status });
    return { status: res.status, notModified: false, body: json, etag: header(res, 'etag'), requestId };
  }

  return {
    kind, limits, scrub,
    get clock() { return clk(); },
    request: (method, pathname, opts) => serial(() => send(method, pathname, opts)),
  };
}

// One client per token in this process, so every caller shares its queue and its gap.
const clients = new Map();
export function clientFor(creds) {
  const key = createHash('sha256').update(String(creds?.token ?? '')).digest('hex');
  if (!clients.has(key)) clients.set(key, createClient({ token: creds?.token, log: (m, f) => { if (process.env.TOUNIFY_LOG === '1') console.log(m, JSON.stringify(f)); } }));
  return clients.get(key);
}
export const resetClients = () => clients.clear();

// ───────────── Requests ─────────────

export const referenceOf = (site) => `eb-site-${site.id}`;
const v2path = (cc, rest) => `/v2/${encodeURIComponent(cc)}${rest}`;

/** The price query for a home's tariff: GET /v2/{cc}/dayahead with fees and VAT, at the home's slot length. */
export function dayaheadQuery({ consumption, feedin = null, postalCode, resolution, historicDays = policy.historicDays }) {
  return { consumption_tariff: consumption, ...(feedin ? { feedin_tariff: feedin } : {}), ...(postalCode ? { postal_code: postalCode } : {}), include: 'fees,vat', resolution, historic_days: historicDays };
}
/** Prices of a tariff at a postal code. Each tariff id named spends one of a testing token's distinct tariffs (once). */
export function getPrices(client, cc, q) {
  const ids = [q.consumption_tariff, q.feedin_tariff].filter(Boolean);
  return client.request('GET', v2path(cc, '/dayahead'), { query: q, scope: { endpoint: 'GET dayahead', thing: ids.join('+') }, names: { tariffs: ids } });
}

// ───────────── Mapping (pure) ─────────────

const SECTOR_GROUPS = ['consumption', 'feedin', 'grid'];

const hm = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const inWindow = (min, a, b) => (a < b ? min >= a && min < b : min >= a || min < b);
const localMinute = (zone, ts) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts * 1000)).split(':').map(Number); return h * 60 + m; };

/**
 * A home's own off-peak hours on a French heures creuses tariff: /dayahead prices it on the reference window
 * (FR_REFERENCE_OFF_PEAK); each day's off-peak price is moved to the home's own windows and its peak price to the
 * rest of the day. Only where every day holds one price inside the reference window and one outside it; otherwise
 * the rows are left as served and a warning says why. Returns { rows, applied }.
 */
export function applyOffPeak(rows, { zone, windows, reference = FR_REFERENCE_OFF_PEAK, resolution }) {
  const ref = [hm(reference.from), hm(reference.to)];
  const own = (windows ?? []).map((w) => [hm(w.from), hm(w.to)]).filter(([a, b]) => a != null && b != null && a !== b);
  if (!own.length) return { rows, applied: null };
  const same = own.length === 1 && own[0][0] === ref[0] && own[0][1] === ref[1];
  if (same) return { rows, applied: null };
  const days = new Map();
  for (const r of rows) {
    const d = localDate(zone, r.validFrom);
    const e = days.get(d) ?? { off: new Set(), peak: new Set() };
    (inWindow(localMinute(zone, r.validFrom), ref[0], ref[1]) ? e.off : e.peak).add(r.price);
    days.set(d, e);
  }
  for (const [d, e] of days) if (e.off.size !== 1 || e.peak.size !== 1) return { rows, applied: null, warning: `off-peak hours not applied: ${d} holds ${e.off.size} price(s) inside the reference window ${reference.from}-${reference.to} and ${e.peak.size} outside it, not one each` };
  const misaligned = own.some(([a, b]) => a % (resolution / 60) || b % (resolution / 60));
  const out = rows.map((r) => {
    const e = days.get(localDate(zone, r.validFrom));
    const min = localMinute(zone, r.validFrom);
    const off = own.some(([a, b]) => inWindow(min, a, b));
    return { ...r, price: [...(off ? e.off : e.peak)][0] };
  });
  return { rows: out, applied: own.map(([a, b]) => `${hhmmOf(a)}-${hhmmOf(b)}`).join(', '), ...(misaligned ? { warning: `the off-peak hours do not fall on ${resolution / 60}-minute boundaries: each period takes the price of its start` } : {}) };
}
const hhmmOf = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * A /dayahead answer (v2; or a v3 /prices answer landed earlier) -> { ok: true, tariff, rows, feedin, vat, window,
 * next, resolutionS, settlementS, taxesInPrice, company, grid, offPeak, warnings } or { ok: false, problems }. Rows
 * are { validFrom, validTo, price (minor per kWh ex VAT), estimated }. Options: country, currency, catalogue (tariff
 * id -> listing: its name), company (the supplier's id, which a v2 answer does not name), offPeak ({ windows:
 * [{ from, to }] }: a French home's own heures creuses), kind / dev (the origin note). Unknown fields are ignored; a
 * missing expected field is a problem (the caller quarantines the answer). Pure.
 */
export function mapPrices(body, { country = null, currency = null, catalogue = null, company: companyIn = null, offPeak = null, kind = 'test', dev = null } = {}) {
  const problems = [];
  const warnings = [];
  const no = (p) => { problems.push(p); return { ok: false, problems }; };
  if (!isObj(body)) return no('the answer is not an object');
  const v3 = isObj(body.applied);
  if (typeof body.currency !== 'string' || !body.currency) problems.push('no currency');
  else if (!CURRENCIES[body.currency]) problems.push(`currency ${body.currency} is not one the core holds`);
  else if (currency && body.currency !== currency) problems.push(`currency ${body.currency}, but the home is billed in ${currency} (no FX)`);
  if (!RESOLUTIONS.includes(body.resolution)) problems.push(`resolution ${body.resolution ?? 'missing'} is not 900, 1800 or 3600`);
  if (!num(body.next)) problems.push('no next');
  if (country && body.country !== undefined && body.country !== country) problems.push(`country ${body.country}, expected ${country}`);
  const cc = typeof body.country === 'string' ? body.country : country;
  const zone = v3 ? (typeof body.applied.zone === 'string' ? body.applied.zone : null) : COUNTRY_ZONE[cc] ?? null;
  if (!zone) problems.push(v3 ? 'no applied.zone' : `no time zone known for country ${cc ?? '(none)'}`);
  if (v3 && body.applied.grid_gap) problems.push(`applied.grid_gap ${body.applied.grid_gap}: no network charge held, an incomplete price is never summed`);
  const id = (isObj(body.consumption_tariff) && typeof body.consumption_tariff.id === 'string' && body.consumption_tariff.id)
    || (typeof body.consumption_tariff === 'string' && body.consumption_tariff) || (typeof body.applied?.consumption?.id === 'string' && body.applied.consumption.id) || null;
  if (!id) problems.push('no consumption tariff id (consumption_tariff.id)');
  if (!Array.isArray(body.consumption) || !body.consumption.length) problems.push('no consumption series');
  if (problems.length) return { ok: false, problems };

  const res = body.resolution;
  const pts = [];
  body.consumption.forEach((p, i) => {
    if (!isObj(p)) { problems.push(`point ${i} is not an object`); return; }
    if (!num(p.from_utc) || !Number.isInteger(p.from_utc) || p.from_utc % 300) { problems.push(`point ${i}: from_utc ${p.from_utc} is not whole seconds on the 5-minute grid`); return; }
    if (!num(p.energy)) { problems.push(`point ${i}: no energy`); return; }
    if (p.grid !== undefined && !num(p.grid)) { problems.push(`point ${i}: grid is not a number`); return; }
    if (p.fees !== undefined && !num(p.fees)) { problems.push(`point ${i}: fees is not a number`); return; }
    if (p.vat !== undefined && !num(p.vat)) { problems.push(`point ${i}: vat is not a number`); return; }
    pts.push(p);
  });
  if (problems.length) return { ok: false, problems: problems.slice(0, 10) };
  pts.sort((a, b) => a.from_utc - b.from_utc);
  for (let i = 1; i < pts.length; i++) if (pts[i].from_utc - pts[i - 1].from_utc < res) return no(`points ${i - 1} and ${i} overlap at resolution ${res} s`);
  if (pts.some((p) => p.grid === undefined)) warnings.push('points without grid: the network charge is taken as 0 (no postal code or grid tariff priced it)');
  const withFees = pts.every((p) => num(p.fees));
  if (!withFees) warnings.push('points without fees: the levies are left to our own tax rules (taxes_in_price 0)');
  const exOf = (p) => p.energy + (p.grid ?? 0) + (p.fees ?? 0);
  // VAT: v3 states its rates (applied.vat); v2 gives each point's VAT amount, so its rate is vat / (energy + grid + fees),
  // kept where it changes (rounded to 0.01 %), and only on points whose sum is not ~0.
  let vat;
  if (v3) vat = Array.isArray(body.applied.vat) ? body.applied.vat.filter((v) => isObj(v) && num(v.rate) && num(v.from_utc)).map((v) => ({ fromUtc: v.from_utc, rate: v.rate, source: v.source ?? null })) : [];
  else {
    vat = [];
    for (const p of pts) {
      if (!num(p.vat) || Math.abs(exOf(p)) < 1e-6) continue;
      const rate = Math.round((p.vat / exOf(p)) * 10000) / 10000;
      if (vat.at(-1)?.rate !== rate) vat.push({ fromUtc: p.from_utc, rate, source: 'per point (vat / ex-VAT sum)' });
    }
  }
  const taxesInPrice = withFees && vat.length > 0 ? 1 : 0;
  const cur = body.currency;
  const total = (p) => toMinor(exOf(p), cur);
  const forecastFrom = num(body.forecast_from) ? body.forecast_from : null;
  const settlementS = num(body.applied?.consumption?.settlement_interval) ? body.applied.consumption.settlement_interval : null;
  let rows = seriesRows(pts, res, settlementS, total, forecastFrom, warnings);

  // Kind: dynamic as the answer types it; a static tariff by its series (one price or more).
  const type = (isObj(body.consumption_tariff) ? body.consumption_tariff.type : null) ?? null;
  const listing = catalogue?.[id] ?? null;
  let tKind;
  let basis;
  if (type === 'dynamic') { tKind = 'dynamic'; basis = 'dynamic (a published series)'; }
  else if (v3 && Number.isInteger(listing?.time_of_use_rates)) { tKind = listing.time_of_use_rates >= 2 ? 'tou' : 'flat'; basis = `static, time_of_use_rates ${listing.time_of_use_rates} (catalogue)`; }
  else { tKind = new Set(rows.map((r) => r.price)).size > 1 ? 'tou' : 'flat'; basis = `static${type ? '' : ' (type not given)'}, ${tKind === 'tou' ? 'more than one price' : 'one price'} in the series`; }
  // A French heures creuses tariff: the home's own off-peak hours (v2 prices the reference window only).
  let offPeakApplied = null;
  if (!v3 && cc === 'FR' && tKind === 'tou' && offPeak?.windows?.length) {
    const op = applyOffPeak(rows, { zone, windows: offPeak.windows, resolution: res });
    rows = op.rows;
    offPeakApplied = op.applied;
    if (op.warning) warnings.push(op.warning);
  }
  const company = companyIn ?? (typeof body.applied?.consumption?.company === 'string' ? body.applied.consumption.company : null) ?? (typeof listing?.companyid === 'string' ? listing.companyid : null);
  const api = v3 ? 'per connection (v3)' : 'at the home\'s postal code';
  const tariff = {
    provider: PROVIDER, tariffCode: `TOUNIFY-${cc}-${id}`, productCode: id, fuel: 'electricity', direction: 'import',
    structure: tKind, kind: tKind, country: cc, currency: cur, nativePeriodS: settlementS ?? res,
    name: typeof listing?.name === 'string' ? listing.name : `${company ? `${company} ` : ''}${id}`,
    origin: 'provider', originNote: `${originNote({ kind, dev })}; tariff ${id}${company ? ` of ${company}` : ''}, ${basis}; prices (energy + grid + fees) ${api}, VAT ${taxesInPrice ? 'stated apart' : 'not stated'}`,
    taxesInPrice,
  };
  // Feed-in: what the producer is paid, net of the producer's own levy (energy - fees); no grid, no vat.
  let feedin = null;
  const fid = (isObj(body.feedin_tariff) && typeof body.feedin_tariff.id === 'string' && body.feedin_tariff.id) || (typeof body.feedin_tariff === 'string' && body.feedin_tariff) || null;
  if (fid && Array.isArray(body.feedin) && body.feedin.length) {
    const fpts = body.feedin.filter((p) => isObj(p) && Number.isInteger(p.from_utc) && !(p.from_utc % 300) && num(p.energy) && (p.fees === undefined || num(p.fees))).sort((a, b) => a.from_utc - b.from_utc);
    if (fpts.length !== body.feedin.length) warnings.push(`feed-in: ${body.feedin.length - fpts.length} points without from_utc or energy left out`);
    const fSettle = num(body.applied?.feedin?.settlement_interval) ? body.applied.feedin.settlement_interval : null;
    const fKind = body.feedin_tariff?.type === 'dynamic' ? 'dynamic' : 'flat';
    feedin = {
      tariff: {
        ...tariff, tariffCode: `TOUNIFY-${cc}-${fid}`, productCode: fid, direction: 'export', structure: fKind, kind: fKind, nativePeriodS: fSettle ?? res,
        name: `${fid} (feed-in)`, taxesInPrice: fpts.every((p) => num(p.fees)) ? 1 : 0,
        originNote: `${originNote({ kind, dev })}; feed-in tariff ${fid}: energy paid less the producer's fees per exported kWh`,
      },
      rows: seriesRows(fpts, res, fSettle, (p) => toMinor(p.energy - (p.fees ?? 0), cur), forecastFrom, warnings),
    };
  }
  const gridId = (isObj(body.grid_tariff) && typeof body.grid_tariff.id === 'string' && body.grid_tariff.id) || (typeof body.grid_tariff === 'string' && body.grid_tariff) || null;
  return {
    ok: true, tariff, rows, feedin, vat, company, warnings, taxesInPrice, offPeak: offPeakApplied,
    window: { from: rows[0].validFrom, to: rows[rows.length - 1].validTo },
    next: body.next, pendingFrom: num(body.pending_from) ? body.pending_from : null, forecastFrom,
    resolutionS: res, settlementS, zone,
    grid: v3 ? (isObj(body.applied.grid) ? { id: body.applied.grid.id ?? null, version: body.applied.grid.version ?? null, source: body.applied.grid.source ?? null } : null)
      : (gridId ? { id: gridId, source: 'the postal code' } : null),
    version: body.applied?.consumption?.version ?? null,
  };
}

// Points -> rate rows. Where the answer repeats a price held for settlementS at a finer resolution
// (NL: hourly prices asked at 900 s), a complete block of equal points becomes one row of the
// settlement length; anything else stays one row per point.
function seriesRows(pts, res, settlementS, priceOf, forecastFrom, warnings) {
  const one = (p) => ({ validFrom: p.from_utc, validTo: p.from_utc + res, price: priceOf(p), estimated: forecastFrom != null && p.from_utc >= forecastFrom });
  if (!settlementS || settlementS <= res || settlementS % res) return pts.map(one);
  const per = settlementS / res;
  const out = [];
  let split = 0;
  for (let i = 0; i < pts.length;) {
    const start = pts[i].from_utc - (((pts[i].from_utc % settlementS) + settlementS) % settlementS);
    const block = [];
    while (i < pts.length && pts[i].from_utc < start + settlementS) block.push(pts[i++]);
    const prices = block.map(priceOf);
    const whole = block.length === per && block.every((p, k) => p.from_utc === start + k * res);
    if (whole && prices.every((x) => x === prices[0])) {
      out.push({ validFrom: start, validTo: start + settlementS, price: prices[0], estimated: block.some((p) => forecastFrom != null && p.from_utc >= forecastFrom) });
    } else { out.push(...block.map(one)); split++; }
  }
  if (split) warnings.push(`${split} block(s) of settlement_interval ${settlementS} s were not one price at ${res} s: kept per point`);
  return out;
}

/**
 * A v3 /components answer (landed by the v3 preview; v2 serves no fixed charge) -> { ok: true, rows, unsized, defaultsUsed, defaults, warnings } or { ok: false,
 * problems }. Rows: { register: '<group>:<kind>', chargePeriod, price (minor per period, signed),
 * validFrom, quantitySource, originNote }, one per charge with a resolved amount. Pure.
 */
export function mapComponents(body, { currency = null, zone = 'UTC', captureDayStart, kind = 'test', dev = null } = {}) {
  const problems = [];
  if (!isObj(body)) return { ok: false, problems: ['the answer is not an object'] };
  for (const g of SECTOR_GROUPS) if (!Array.isArray(body[g])) problems.push(`no ${g} array`);
  if (problems.length) return { ok: false, problems };
  const rows = [];
  const unsized = [];
  const warnings = [];
  const used = new Map();
  for (const group of SECTOR_GROUPS) {
    body[group].forEach((c, i) => {
      if (!isObj(c) || typeof c.kind !== 'string' || !isObj(c.rate)) { problems.push(`${group}[${i}]: no kind or rate`); return; }
      const what = `${group} ${c.kind} "${typeof c.name === 'string' ? c.name : '?'}"`;
      const r = c.resolved;
      if (!isObj(r) || !num(r.amount)) { unsized.push({ group, kind: c.kind, name: c.name ?? null, requires: c.quantity?.requires ?? null, not_applied: c.not_applied ?? null }); return; }
      const period = ['day', 'month', 'year'].includes(r.interval) ? r.interval : ['day', 'month', 'year'].includes(c.rate.interval) ? c.rate.interval : null;
      if (!period) { unsized.push({ group, kind: c.kind, name: c.name ?? null, reason: `interval ${r.interval ?? c.rate.interval ?? 'missing'}` }); return; }
      const ccy = r.currency ?? c.rate.currency ?? null;
      if (currency && ccy && ccy !== currency) { warnings.push(`${what}: in ${ccy}, the home is billed in ${currency}: not stored (no FX)`); return; }
      let register = `${group}:${c.kind}`;
      const n = (used.get(register) ?? 0) + 1;
      used.set(register, n);
      if (n > 1) register = `${register}:${n}`;
      const qsrc = isObj(c.defaults_used) ? 'defaulted' : (c.quantity?.source ?? 'not stated');
      if (c.rate.vat_treatment && c.rate.vat_treatment !== 'standard') warnings.push(`${what}: vat_treatment ${c.rate.vat_treatment}, but our VAT rule applies to every fixed charge`);
      const from = typeof c.valid_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.valid_from) ? dayBounds(zone, c.valid_from)[0] : captureDayStart;
      rows.push({
        register, chargePeriod: period, price: toMinor(r.amount, ccy ?? currency ?? 'EUR'), validFrom: from, group, kind: c.kind, quantitySource: qsrc,
        originNote: `${originNote({ kind, dev })}; ${what}: ${num(r.quantity) ? r.quantity : '?'} x ${num(r.rate) ? r.rate : '?'} = ${r.amount} ${ccy ?? ''}/${period}; quantity ${qsrc}`
          + `${c.kind === 'capacity' ? ' (the resolved amount, not the per-unit rate)' : ''}${c.valid_to ? `; upstream valid_to ${c.valid_to} not used as an end` : ''}`,
      });
    });
  }
  if (problems.length) return { ok: false, problems: problems.slice(0, 10) };
  return { ok: true, rows, unsized, warnings, defaultsUsed: isObj(body.defaults_used) ? body.defaults_used : null, defaults: Array.isArray(body.defaults) ? body.defaults : null };
}

// ───────────── Store (idempotent, bitemporal, never deletes) ─────────────

const TARIFF_FIELDS = [['product_code', 'productCode'], ['fuel', 'fuel'], ['direction', 'direction'], ['structure', 'structure'], ['name', 'name'], ['kind', 'kind'],
  ['country', 'country'], ['currency', 'currency'], ['native_period_s', 'nativePeriodS'], ['origin', 'origin'], ['origin_note', 'originNote'], ['taxes_in_price', 'taxesInPrice']];

function upsertTariff(t) {
  const cur = db.prepare('SELECT * FROM tariff WHERE tariff_code = ?').get(t.tariffCode);
  if (!cur) return { row: createTariff(t), created: 1, updated: 0 };
  if (cur.provider !== PROVIDER) throw new Error(`tariff code ${t.tariffCode} belongs to ${cur.provider}: not overwritten`);
  const diff = TARIFF_FIELDS.filter(([col, key]) => (cur[col] ?? null) !== (t[key] ?? null));
  if (!diff.length) return { row: cur, created: 0, updated: 0 };
  db.prepare(`UPDATE tariff SET ${diff.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...diff.map(([, k]) => t[k] ?? null), cur.id);
  return { row: db.prepare('SELECT * FROM tariff WHERE id = ?').get(cur.id), created: 0, updated: 1 };
}

const KEY = "tariff_id = ? AND site_id = ? AND component = ? AND register = ? AND payment_method = 'ANY' AND IFNULL(charge_period, '') = ? AND superseded_at IS NULL";
const END = 9000000000;

/**
 * Home-specific rate rows, idempotent: a row the current rows already say (the current row covering
 * its start has its price, its end and its estimated flag) is left alone; a changed one supersedes
 * every current row it overlaps, the parts of those rows before and after it kept at their old price
 * (new copies). Returns the rows written.
 */
export function putRates(tariffId, siteId, rows, { component = 'unit', rawId = null, recordedAt = recordedNow() } = {}) {
  const covering = db.prepare(`SELECT * FROM rate_interval WHERE ${KEY} AND valid_from <= ? AND IFNULL(valid_to, ${END}) > ? ORDER BY valid_from DESC LIMIT 1`);
  const overlapping = db.prepare(`SELECT * FROM rate_interval WHERE ${KEY} AND valid_from < ? AND IFNULL(valid_to, ${END}) > ?`);
  const sup = db.prepare('UPDATE rate_interval SET superseded_at = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO rate_interval (tariff_id, site_id, component, register, charge_period, payment_method, valid_from, valid_to, price_ex_vat, recorded_at, raw_id, origin, origin_note, estimated)
    VALUES (?, ?, ?, ?, ?, 'ANY', ?, ?, ?, ?, ?, 'provider', ?, ?)`);
  let changed = 0;
  tx(() => {
    for (const r of [...rows].sort((a, b) => a.validFrom - b.validFrom)) {
      const register = r.register ?? 'single';
      const period = r.chargePeriod ?? null;
      const k = [tariffId, siteId, component, register, period ?? ''];
      const est = r.estimated ? 1 : 0;
      const cur = covering.get(...k, r.validFrom, r.validFrom);
      if (cur && (cur.valid_to ?? null) === (r.validTo ?? null) && Math.abs(cur.price_ex_vat - r.price) < 1e-9 && cur.estimated === est) continue;
      for (const o of overlapping.all(...k, r.validTo ?? END, r.validFrom)) {
        sup.run(recordedAt, o.id);
        if (o.valid_from < r.validFrom) ins.run(tariffId, siteId, component, register, period, o.valid_from, r.validFrom, o.price_ex_vat, recordedAt, o.raw_id, o.origin_note, o.estimated);
        if (r.validTo != null && (o.valid_to ?? END) > r.validTo) ins.run(tariffId, siteId, component, register, period, r.validTo, o.valid_to, o.price_ex_vat, recordedAt, o.raw_id, o.origin_note, o.estimated);
      }
      ins.run(tariffId, siteId, component, register, period, r.validFrom, r.validTo ?? null, r.price, recordedAt, rawId, r.originNote ?? null, est);
      changed++;
    }
  });
  return changed;
}

// The home's meter on the tariff (device provider 'tounify', external_ref the reference). Not agreed
// when another meter of the same kind already prices the home (an Octopus or typed-in tariff): the
// rates are stored, the warning says why they do not price it. A changed tariff ends the old
// agreement at the capture day and starts the new one there. Returns { agreed, changed, warning }.
function ensureAgreement(site, tariffId, { kind, externalRef, label, fromTs, captureDayStart }) {
  let dev = db.prepare("SELECT * FROM device WHERE site_id = ? AND provider = 'tounify' AND external_ref = ?").get(site.id, externalRef);
  const others = db.prepare(`SELECT t.tariff_code FROM tariff_agreement a JOIN device d ON d.id = a.device_id JOIN tariff t ON t.id = a.tariff_id
    WHERE a.site_id = ? AND d.kind = ? AND d.id <> ? AND d.retired_at IS NULL AND a.superseded_at IS NULL AND IFNULL(a.valid_to, ${END}) > ?`).all(site.id, kind, dev?.id ?? -1, fromTs);
  if (others.length) return { agreed: false, changed: false, warning: `the home is already priced by ${others[0].tariff_code} (${kind}): tounify rates stored, not agreed` };
  if (!dev) dev = addDevice({ siteId: site.id, kind, provider: PROVIDER, externalRef, label });
  else if (dev.retired_at) db.prepare('UPDATE device SET retired_at = NULL WHERE id = ?').run(dev.id);
  const cur = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from').all(dev.id);
  const open = cur.find((a) => a.valid_to == null);
  const closed = cur.filter((a) => a !== open).map((a) => ({ tariffId: a.tariff_id, from: a.valid_from, to: a.valid_to }));
  if (open?.tariff_id === tariffId) return { agreed: true, changed: false };
  if (open) {
    const at = Math.max(captureDayStart, open.valid_from);
    const keepOld = at > open.valid_from ? [{ tariffId: open.tariff_id, from: open.valid_from, to: at }] : [];
    supersedeAgreements(site.id, dev.id, [...closed, ...keepOld, { tariffId, from: at, to: null }]);
    return { agreed: true, changed: true };
  }
  const after = Math.max(fromTs, ...closed.map((a) => a.to ?? 0));
  supersedeAgreements(site.id, dev.id, [...closed, { tariffId, from: after, to: null }]);
  return { agreed: true, changed: true };
}

// ───────────── VAT cross-check ─────────────

// Our VAT rate (the percent rules, compounded across seq) for a home's country at ts, or null.
function ourVat(country, ts) {
  const rules = rulesFor(db.prepare('SELECT * FROM tax_rule WHERE country = ? AND superseded_at IS NULL').all(country), { country, fuel: 'electricity', direction: 'import', ts }).filter((r) => r.kind === 'percent');
  if (rules.length) {
    const bySeq = new Map();
    for (const r of rules) bySeq.set(r.seq, (bySeq.get(r.seq) ?? 0) + r.value);
    const groups = [...bySeq.values()];
    return { rate: groups.length === 1 ? groups[0] : groups.reduce((m, v) => m * (1 + v), 1) - 1, rules: rules.map((r) => `${r.country}/${r.code}`), unverified: rules.some((r) => r.unverified) };
  }
  return null;
}

/** Each VAT rate tounify states, against ours: [{ from_utc, tounify, ours, rules, match }] and warnings. Never changes a rule. */
export function vatCheck(country, vat) {
  const checks = [];
  const warnings = [];
  for (const v of vat) {
    const o = ourVat(country, v.fromUtc);
    const match = o != null && Math.abs(o.rate - v.rate) < 1e-9;
    checks.push({ from_utc: v.fromUtc, tounify: v.rate, ours: o?.rate ?? null, rules: o?.rules ?? [], match });
    if (!o) warnings.push(`VAT: tounify states ${pct(v.rate)} from ${iso(v.fromUtc * 1000)}; we hold no VAT rule for ${country} then (our rules are kept as they are)`);
    else if (!match) warnings.push(`VAT mismatch: tounify states ${pct(v.rate)} from ${iso(v.fromUtc * 1000)}, our ${o.rules.join(' + ')} says ${pct(o.rate)}${o.unverified ? ' (a placeholder)' : ''}: our rule is kept, check it`);
  }
  return { checks, warnings };
}

// ───────────── One home's daily read ─────────────

function connectionOf(siteId) {
  const c = db.prepare("SELECT * FROM connection WHERE site_id = ? AND provider = 'tounify'").get(siteId);
  if (!c) return null;
  let meta = {};
  try { meta = JSON.parse(c.meta || '{}'); } catch { meta = {}; }
  return { ...c, meta };
}

function dueOf(cs, nowMs) {
  if (cs.last_price_day === utcDay(nowMs)) {
    return { due: false, reason: `not due: one price read a day per connection, read today (UTC); the next after ${iso(Math.max(cs.next_at ?? 0, nextUtcMidnight(nowMs)))}` };
  }
  if (cs.next_at && nowMs < cs.next_at) return { due: false, reason: `not due: tounify advises the next read after ${iso(cs.next_at)}` };
  return { due: true, reason: null };
}

/** Whether the home's daily price read may run now ({ due, reason }): registered, read at most once a UTC day, not before `next`, not cooling down. */
export function priceReadDue(siteId, nowMs = clockOf(null).now()) {
  const c = connectionOf(siteId);
  if (!c?.external_ref) return { due: false, reason: 'no tounify tariff recorded for this home' };
  if (!c.meta.tariffs?.consumption) return { due: false, reason: 'no tounify tariff chosen yet for this home' };
  const d = dueOf(readState().connections?.[c.external_ref] ?? {}, nowMs);
  if (!d.due) return d;
  const until = dbStore().nextAllowedAt();
  if (until - nowMs > policy.maxWaitMs) return { due: false, reason: `cooling down: no request to tounify before ${iso(until)}` };
  return d;
}

function rawBody(rawId) {
  const r = rawId ? db.prepare('SELECT file FROM raw_payload WHERE id = ?').get(rawId) : null;
  if (!r) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, r.file), 'utf8')); } catch { return null; }
}

// The home's own off-peak hours on a French heures creuses tariff: what the choice stored on the connection, else
// the meter's own windows. [{ from, to }] or null.
function offPeakWindowsOf(site, meta) {
  const stated = Array.isArray(meta?.off_peak_hours) ? meta.off_peak_hours.filter((w) => isObj(w) && typeof w.from === 'string' && typeof w.to === 'string') : [];
  if (stated.length) return stated;
  return offPeakOf(site.id)?.all_year ?? null;
}

/**
 * One home's read: GET /v2/{cc}/dayahead for the home's tariff at its postal code, at most once a UTC day and never
 * before the last answer's `next` (force skips only that gate, never the allowance), mapped and stored. v2 serves
 * per-kWh prices only: no fixed charge is read, written or ended here (rows the home holds are kept). Returns a
 * compact report; { skipped } when not due, refused by the allowance or cooling down; { failed: true, error } (never
 * a throw) for an answer of an unexpected shape, which is quarantined. A 429, an exhausted testing allowance or an
 * auth failure is thrown: it stops the run.
 */
export async function syncTounifyHome({ site, client, dev = null, force = false } = {}) {
  const c = connectionOf(site.id);
  if (!c?.external_ref) return { skipped: 'no tounify tariff recorded for this home (the tariff picker records it)' };
  const ref = c.external_ref;
  const consumption = c.meta.tariffs?.consumption ?? null;
  if (!consumption) return { skipped: 'no tounify tariff chosen yet for this home (the tariff picker sets it)' };
  const cc = c.meta.country ?? site.country ?? site.market_code;
  const postal = String(c.meta.postal_code ?? site.postcode ?? '').trim();
  const nowMs = client.clock.now();
  const prev = readState().connections?.[ref] ?? {};
  if (!force) { const d = dueOf(prev, nowMs); if (!d.due) return { skipped: d.reason }; }
  const kind = client.kind === 'prod' ? 'prod' : 'test';
  const out = { reference: ref, country: cc, warnings: [] };
  const saveConn = (patch) => updateState((s) => { s.connections ??= {}; s.connections[ref] = { ...(s.connections[ref] ?? {}), country: cc, ...patch }; });
  const resolution = RESOLUTIONS.includes(slotLength(site)) ? slotLength(site) : 3600;
  const catalogue = Object.fromEntries(Object.values(readState().catalogue?.[cc]?.tariffs ?? {}).flat().map((t) => [t.id, t]));
  const company = c.meta.company ?? catalogue[consumption]?.companyid ?? null;
  if (!postal) out.warnings.push('no postal code: priced without the grid operator\'s charge and local levies');

  // Prices.
  const q = dayaheadQuery({ consumption, feedin: c.meta.tariffs?.feedin ?? null, postalCode: postal || null, resolution });
  const pReq = { method: 'GET', path: v2path(cc, '/dayahead'), query: q };
  let r;
  try {
    r = await getPrices(client, cc, q);
  } catch (err) {
    if (err.kind === 'allowance' || err.kind === 'cooldown') return { skipped: err.message };
    throw err;
  }
  const today = utcDay(nowMs);
  const request = { ...pReq, request_id: r.requestId ?? null };
  const offPeak = { windows: offPeakWindowsOf(site, c.meta) };
  const mp = mapPrices(r.body, { country: cc, currency: site.currency ?? null, catalogue, company, offPeak, kind, dev });
  if (!mp.ok) {
    const reason = `unexpected shape: ${mp.problems.join('; ')}`;
    const qr = quarantine({ source: PROVIDER, siteId: site.id, request, body: r.body, reason });
    saveConn({ last_price_day: today, last_read_at: iso(nowMs), last_error: reason });
    return { ...out, failed: true, error: `tounify prices for ${ref}: ${reason}`, quarantined: qr.rawId };
  }
  const pRaw = landRaw({ source: PROVIDER, siteId: site.id, request, body: r.body }).rawId;
  saveConn({ last_price_day: today, last_read_at: iso(nowMs), next_at: mp.next * 1000, prices_raw: pRaw, company: mp.company ?? prev.company ?? null, last_error: null, api: 'v2' });
  const zone = mp.zone || site.timezone;
  const captureDayStart = dayBounds(zone, localDate(zone, Math.floor(nowMs / 1000)))[0];

  // Write: tariff, unit rows, the meter's agreement, the connection's applied info.
  const recordedAt = recordedNow();
  tx(() => {
    const u = upsertTariff(mp.tariff);
    // The supplier as its own row (delta 080): tounify's company id, named as the catalogue lists it.
    if (mp.company) {
      const listed = readState().catalogue?.[mp.tariff.country]?.companies?.find((x) => x.id === mp.company);
      linkSupplier(u.row.id, { provider: PROVIDER, country: mp.tariff.country, externalId: mp.company, name: listed?.name ?? mp.company });
    }
    out.tariff = mp.tariff.tariffCode;
    out.kind = mp.tariff.kind;
    out.taxes_in_price = mp.taxesInPrice;
    out.tariff_created = u.created;
    const note = `${originNote({ kind, dev })}${mp.offPeak ? `; off-peak prices on the home's own hours ${mp.offPeak}` : ''}`;
    out.unit_rows = putRates(u.row.id, site.id, mp.rows.map((x) => ({ ...x, originNote: note })), { component: 'unit', rawId: pRaw, recordedAt });
    out.points = r.body.consumption.length;
    out.rows = mp.rows.length;
    if (mp.offPeak) out.off_peak_hours = mp.offPeak;
    const ag = ensureAgreement(site, u.row.id, { kind: 'meter_import', externalRef: ref, label: `tounify tariff ${consumption} (import)`, fromTs: mp.window.from, captureDayStart });
    if (ag.warning) out.warnings.push(ag.warning);
    out.agreed = ag.agreed;
    out.agreements_changed = ag.changed;
    if (mp.feedin) {
      const f = upsertTariff(mp.feedin.tariff);
      out.feedin_tariff = mp.feedin.tariff.tariffCode;
      out.feedin_rows = putRates(f.row.id, site.id, mp.feedin.rows.map((x) => ({ ...x, originNote: originNote({ kind, dev }) })), { component: 'unit', rawId: pRaw, recordedAt });
      const fa = ensureAgreement(site, f.row.id, { kind: 'meter_export', externalRef: `${ref}:export`, label: `tounify tariff ${mp.feedin.tariff.productCode} (export)`, fromTs: mp.window.from, captureDayStart });
      if (fa.warning) out.warnings.push(fa.warning);
      out.agreements_changed = out.agreements_changed || fa.changed;
    }
    // Fixed charges: none in v2. Say whether the home holds any (kept as they are) or has none.
    const held = db.prepare("SELECT COUNT(*) AS n FROM rate_interval WHERE tariff_id = ? AND site_id = ? AND component = 'fixed' AND superseded_at IS NULL AND valid_to IS NULL").get(u.row.id, site.id).n;
    out.fixed = held ? `${held} fixed charge(s) held from before, kept (tounify v2 serves none)` : 'none: tounify v2 serves per-kWh prices only (subscription and standing charges are not in it)';
    const applied = {
      ...c.meta, country: cc, consumption_tariff: mp.tariff.productCode, company: mp.company ?? c.meta.company ?? null, grid_tariff: mp.grid,
      resolution: mp.resolutionS, taxes_in_price: mp.taxesInPrice, api: 'v2',
    };
    db.prepare("UPDATE connection SET meta = ? WHERE site_id = ? AND provider = 'tounify'").run(JSON.stringify(applied), site.id);
  });
  const v = vatCheck(site.country ?? cc, mp.vat);
  out.vat_check = v.checks;
  out.warnings.push(...mp.warnings, ...v.warnings);
  out.window = { from: iso(mp.window.from * 1000), to: iso(mp.window.to * 1000) };
  out.resolution = mp.resolutionS;
  if (mp.grid?.id) out.grid_tariff = mp.grid.id;
  out.next = iso(mp.next * 1000);
  if (r.requestId) out.request_id = r.requestId;
  if (!out.warnings.length) delete out.warnings;
  return out;
}

/**
 * A tariff's prices for a home before it is chosen (the tariff picker's price preview): GET /v2/{cc}/dayahead for that
 * tariff at the home's postal code and slot length, stored like a read (the tariff, the home's own unit rows, its
 * supplier) but with NO agreement, so the home is not priced on it; the comparison on the Tariffs page can use them.
 * A tariff whose prices for now the home already holds is not asked again. Pricing a new tariff spends one of a
 * testing token's distinct tariffs (refused first by the allowance guard: { available: false, reason }).
 * Returns { available, tariff, kind, cached, rows, reason? }.
 */
export async function quoteTariff(site, tariffId, { client, company = null, dev = null } = {}) {
  if (!tariffId || typeof tariffId !== 'string') throw bad('a tounify tariff id is required');
  const cc = countryOf(site);
  const code = `TOUNIFY-${cc}-${tariffId}`;
  const now = Math.floor(client.clock.now() / 1000);
  const held = db.prepare(`SELECT COUNT(*) AS n FROM rate_interval r JOIN tariff t ON t.id = r.tariff_id WHERE t.tariff_code = ? AND r.site_id = ?
    AND r.component = 'unit' AND r.superseded_at IS NULL AND r.valid_from <= ? AND IFNULL(r.valid_to, 9000000000) > ?`).get(code, site.id, now, now).n;
  if (held) return { available: true, tariff: code, cached: true };
  const postal = String(site.postcode ?? '').trim();
  const resolution = RESOLUTIONS.includes(slotLength(site)) ? slotLength(site) : 3600;
  const q = dayaheadQuery({ consumption: tariffId, postalCode: postal || null, resolution, historicDays: 0 });
  let r;
  try { r = await getPrices(client, cc, q); } catch (err) {
    if (['allowance', 'cooldown', 'allowance_exhausted'].includes(err.kind)) return { available: false, tariff: code, reason: err.message };
    throw err;
  }
  const request = { method: 'GET', path: v2path(cc, '/dayahead'), query: q, request_id: r.requestId ?? null };
  const kind = client.kind === 'prod' ? 'prod' : 'test';
  const catalogue = Object.fromEntries(Object.values(readState().catalogue?.[cc]?.tariffs ?? {}).flat().map((t) => [t.id, t]));
  const mp = mapPrices(r.body, { country: cc, currency: site.currency ?? null, catalogue, company: company ?? catalogue[tariffId]?.companyid ?? null, kind, dev });
  if (!mp.ok) {
    quarantine({ source: PROVIDER, siteId: site.id, request, body: r.body, reason: `unexpected shape: ${mp.problems.join('; ')}` });
    return { available: false, tariff: code, reason: 'tounify answered in an unexpected shape (quarantined)' };
  }
  const rawId = landRaw({ source: PROVIDER, siteId: site.id, request, body: r.body }).rawId;
  let written = 0;
  tx(() => {
    const u = upsertTariff(mp.tariff);
    if (mp.company) {
      const listed = readState().catalogue?.[cc]?.companies?.find((x) => x.id === mp.company);
      linkSupplier(u.row.id, { provider: PROVIDER, country: cc, externalId: mp.company, name: listed?.name ?? mp.company });
    }
    written = putRates(u.row.id, site.id, mp.rows.map((x) => ({ ...x, originNote: `${originNote({ kind, dev })}; price preview in the tariff picker (the home is not on this tariff)` })), { component: 'unit', rawId, recordedAt: recordedNow() });
  });
  return { available: true, tariff: code, kind: mp.tariff.kind, cached: false, rows: written, warnings: mp.warnings };
}

/** A home's tounify status for the Providers panel and the Connectors page (no secret). */
export function homeStatus(site) {
  const c = connectionOf(site.id);
  if (!c?.external_ref) return { status: 'skipped', reason: 'no tounify tariff recorded for this home yet (choose it in onboarding, or POST /api/sites/:id/connections with provider tounify)' };
  const cs = readState().connections?.[c.external_ref] ?? {};
  if (cs.last_error) return { status: 'error', reason: cs.last_error };
  if (cs.last_read_at) return { status: 'ok', reason: `read ${cs.last_read_at}; ${dueOf(cs, clockOf(null).now()).reason ?? 'due now'}` };
  return { status: 'skipped', reason: c.meta.tariffs?.consumption ? 'tariff recorded, prices not read yet' : 'no tariff chosen yet' };
}

// ───────────── Catalogue (shared, per country, once a week) ─────────────

/** Whether the country's weekly catalogue refresh may run now. */
export function catalogueDue(country, nowMs = clockOf(null).now()) {
  const cat = readState().catalogue?.[country];
  if (cat?.api === 'v2' && cat.refreshed_at && nowMs - cat.refreshed_at < policy.catalogueEveryMs) return false;
  return dbStore().nextAllowedAt() - nowMs <= policy.maxWaitMs;
}

const compactCompany = (x) => ({ id: x.id, name: typeof x.name === 'string' ? x.name : null });
const compactTariff = (x) => ({ id: x.id, name: typeof x.name === 'string' ? x.name : null, companyid: x.companyid ?? null, type: x.type ?? null, available: x.available ?? null, link: typeof x.link === 'string' ? x.link : null });
const listOfIds = (what) => (b) => (Array.isArray(b) && b.every((x) => isObj(x) && typeof x.id === 'string') ? null : `not a list of ${what} with ids`);

// The suppliers our homes in a country are on (each one's tariffs are listed in the weekly refresh; a company is
// spent once on a testing token, so only these are named).
function companiesInUse(country) {
  const st = readState().connections ?? {};
  const out = new Set();
  for (const r of db.prepare("SELECT c.external_ref, c.meta, s.country FROM connection c JOIN site s ON s.id = c.site_id WHERE c.provider = 'tounify' AND c.external_ref IS NOT NULL").all()) {
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}'); } catch { meta = {}; }
    if ((meta.country ?? r.country) !== country) continue;
    const co = meta.company ?? st[r.external_ref]?.company;
    if (co) out.add(co);
  }
  return [...out].sort();
}

/**
 * The country's catalogue, once a week at most (ETags): its suppliers (GET /v2/{cc}/consumption/companies, national),
 * and the tariffs of the suppliers our homes are on (each company named spends one of a testing token's distinct
 * companies, once). Kept in provider_state (and landed raw); used to name a tariff and to list the picker's suppliers.
 */
export async function refreshCatalogue({ country, client, force = false } = {}) {
  const nowMs = client.clock.now();
  // A catalogue read from the v3 preview (no api mark) is read again from v2 at once: its supplier list was narrowed
  // by a connection, and its lists carry v3 fields.
  const v3cat = readState().catalogue?.[country] ?? {};
  const cat0 = v3cat.api === 'v2' ? v3cat : { tariffs: {}, listed_at: {}, api: 'v2' };
  if (!force && cat0.refreshed_at && nowMs - cat0.refreshed_at < policy.catalogueEveryMs) {
    return { skipped: `not due: one catalogue refresh a week per country, the next after ${iso(cat0.refreshed_at + policy.catalogueEveryMs)}` };
  }
  const cat = structuredClone(cat0);
  delete cat.properties;   // a v3 list: v2 takes no connection properties
  cat.etags ??= {};
  cat.raw ??= {};
  cat.listed_at ??= {};
  const out = { country, read: [], not_modified: [], warnings: [] };
  const step = async (key, pathname, opts, accept) => {
    const stored = cat.raw[key] ? rawBody(cat.raw[key]) : null;
    const r = await client.request('GET', pathname, { ...opts, etag: stored && cat.etags[key] ? cat.etags[key] : null });
    cat.listed_at[key] = nowMs;
    if (r.notModified) { out.not_modified.push(key); return stored; }
    const problem = accept(r.body);
    const request = { method: 'GET', path: pathname, request_id: r.requestId ?? null };
    if (problem) {
      quarantine({ source: PROVIDER, siteId: null, request, body: r.body, reason: `unexpected shape: ${problem}` });
      out.warnings.push(`${key}: unexpected shape (${problem}): quarantined`);
      return null;
    }
    cat.raw[key] = landRaw({ source: PROVIDER, siteId: null, request, body: r.body }).rawId;
    cat.etags[key] = r.etag ?? null;
    out.read.push(key);
    return r.body;
  };
  try {
    const comps = await step('companies', v2path(country, '/consumption/companies'), { scope: { endpoint: 'GET companies', thing: country } }, listOfIds('companies'));
    if (comps) cat.companies = comps.map(compactCompany);
    cat.tariffs ??= {};
    for (const company of companiesInUse(country)) {
      const list = await step(`tariffs:${company}`, v2path(country, `/consumption/${encodeURIComponent(company)}/tariffs`),
        { scope: { endpoint: 'GET tariffs', thing: company }, names: { companies: [company] } }, listOfIds('tariffs'));
      if (list) cat.tariffs[company] = list.map(compactTariff);
    }
  } catch (err) {
    updateState((s) => { s.catalogue ??= {}; s.catalogue[country] = { ...cat, last_error: err.message, last_error_at: nowMs }; });
    if (err.kind === 'allowance' || err.kind === 'cooldown') return { skipped: err.message, ...out };
    throw err;
  }
  cat.refreshed_at = nowMs;
  cat.last_error = null;
  updateState((s) => { s.catalogue ??= {}; s.catalogue[country] = cat; });
  out.companies = cat.companies?.length ?? 0;
  out.tariffs = Object.fromEntries(Object.entries(cat.tariffs ?? {}).map(([k, v]) => [k, v.length]));
  out.next_refresh_after = iso(nowMs + policy.catalogueEveryMs);
  if (!out.warnings.length) delete out.warnings;
  return out;
}

// ───────────── Supplier and tariff lists for the tariff picker (src/core/tariff-picker.js) ─────────────

// v2 lists a country's suppliers and a supplier's tariffs with no address and no registration. Each list is kept in
// provider_state (catalogue[country].companies / .tariffs[company], with the moment read) and asked again at most once
// every catalogueEveryMs (7 days), so the second and later homes of a country cost no call. Naming a company spends
// one of a testing token's distinct companies (the allowance guard refuses it first).
async function listCached(country, client, key, pathname, scope, names, force, siteId = null) {
  const cat0 = readState().catalogue?.[country] ?? {};
  const cat = cat0.api === 'v2' ? cat0 : {};   // a list read from the v3 preview is never reused
  const nowMs = client.clock.now();
  const at = cat.listed_at?.[key];
  const held = key === 'companies' ? cat.companies : cat.tariffs?.[key.slice('tariffs:'.length)];
  if (!force && held && at && nowMs - at < policy.catalogueEveryMs) return { list: held, cached: true, country, listed_at: iso(at) };
  const r = await client.request('GET', pathname, { scope, names });
  const request = { method: 'GET', path: pathname, request_id: r.requestId ?? null };
  const problem = listOfIds(key === 'companies' ? 'companies' : 'tariffs')(r.body);
  if (problem) {
    quarantine({ source: PROVIDER, siteId, request, body: r.body, reason: `unexpected shape: ${problem}` });
    throw new TounifyError(`tounify ${key}: unexpected answer (quarantined)`, { kind: 'shape' });
  }
  landRaw({ source: PROVIDER, siteId, request, body: r.body });
  const list = key === 'companies' ? r.body.map(compactCompany) : r.body.map(compactTariff);
  updateState((s) => {
    s.catalogue ??= {};
    if (s.catalogue[country]?.api !== 'v2') s.catalogue[country] = { api: 'v2' };
    const k = s.catalogue[country];
    if (key === 'companies') k.companies = list; else (k.tariffs ??= {})[key.slice('tariffs:'.length)] = list;
    (k.listed_at ??= {})[key] = nowMs;
  });
  return { list, cached: false, country, listed_at: iso(nowMs) };
}
const countryOf = (site) => site.country ?? site.market_code;

/** The electricity suppliers (consumption companies) of the home's country: { list: [{ id, name }], cached, country }. */
export function listCompanies(site, { client, force = false } = {}) {
  const cc = countryOf(site);
  return listCached(cc, client, 'companies', v2path(cc, '/consumption/companies'), { endpoint: 'GET companies', thing: cc }, undefined, force, site.id);
}

/** One supplier's consumption tariffs: { list: [{ id, name, companyid, type, available, link }], cached, country }. */
export function listCompanyTariffs(site, company, { client, force = false } = {}) {
  if (!company || typeof company !== 'string') throw bad('a supplier (tounify company id) is required');
  const cc = countryOf(site);
  return listCached(cc, client, `tariffs:${company}`, v2path(cc, `/consumption/${encodeURIComponent(company)}/tariffs`), { endpoint: 'GET tariffs', thing: company },
    { companies: [company] }, force, site.id);
}

/** The network operator serving a postal code (GET /v2/{cc}/grid/companies?postal_code=): { id, name } or null (not mapped). */
export async function gridOperatorAt(cc, postalCode, { client } = {}) {
  const r = await client.request('GET', v2path(cc, '/grid/companies'), { query: { postal_code: postalCode }, scope: { endpoint: 'GET grid companies', thing: `${cc}:${postalCode}` } });
  if (!Array.isArray(r.body)) return null;
  const op = r.body.find((x) => isObj(x) && typeof x.id === 'string');
  return op ? { id: op.id, name: typeof op.name === 'string' ? op.name : op.id } : null;
}

/** The catalogue's state for a market (status hook). */
export function catalogueStatus(country) {
  const cat = readState().catalogue?.[country];
  if (!cat) return { status: 'skipped', reason: `no tounify catalogue refresh for ${country} yet` };
  if (cat.last_error && (cat.last_error_at ?? 0) >= (cat.refreshed_at ?? 0)) return { status: 'error', reason: cat.last_error };
  // Only the tariff picker's supplier lists are held (catalogue[cc].companies/tariffs, listed_at): the weekly refresh
  // has not run for this market yet.
  if (!Number.isFinite(cat.refreshed_at)) return { status: 'skipped', reason: `no tounify catalogue refresh for ${country} yet (supplier lists read for the tariff picker)` };
  const tariffs = Object.keys(cat.tariffs ?? {});
  return { status: 'ok', reason: `${country}: ${cat.companies?.length ?? 0} suppliers${tariffs.length ? `, the tariffs of ${tariffs.join(', ')}` : ''}, refreshed ${iso(cat.refreshed_at)}` };
}

// ───────────── A home's tariff (kept here: v2 has no connection to register) ─────────────

const hhmm = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// The off-peak hours a home's own meter windows state (register hc / off-peak / night, every day, local clock), or null.
function offPeakOf(siteId) {
  const ws = db.prepare(`SELECT w.start_min, w.end_min FROM register_window w JOIN device d ON d.id = w.device_id
    WHERE d.site_id = ? AND d.retired_at IS NULL AND w.superseded_at IS NULL AND w.calendar IS NULL AND w.clock = 'local' AND w.weekdays = 127
      AND lower(w.register) IN ('hc', 'off_peak', 'offpeak', 'night') ORDER BY w.start_min`).all(siteId);
  if (!ws.length) return null;
  const minutes = ws.reduce((m, w) => m + ((w.end_min - w.start_min + 1440) % 1440 || 1440), 0);
  return { all_year: ws.map((w) => ({ from: hhmm(w.start_min), to: hhmm(w.end_min) })), minutes };
}

/**
 * What is kept for a home's tariff (connection.meta): { country, postal_code, tariffs: { consumption, feedin },
 * company, off_peak_hours, capacity }. The postal code is the home's unless given; the tariff is required unless
 * no_tariff_yet. Off-peak hours: those given (metering.off_peak_hours.all_year, or off_peak_hours), else the meter's
 * own windows. Returns { meta, warnings, names }. Pure on the database; no personal data beyond the postal code.
 */
export function connectionBody(site, input = {}, cc = countryOf(site)) {
  const warnings = [];
  const postal = String(input.postal_code ?? site.postcode ?? '').trim();
  if (!postal) throw bad('postal_code is required: the postal code selects the network operator, the local levies and the time-of-use clock (it is the only address detail sent)');
  const consumption = typeof input.consumption_tariff === 'string' ? input.consumption_tariff.trim() : '';
  if (!consumption && input.no_tariff_yet !== true) throw bad('consumption_tariff is required: the tounify tariff id the home buys its energy on (for example EDFTRVHPHC)');
  const feedin = typeof input.feedin_tariff === 'string' && input.feedin_tariff.trim() ? input.feedin_tariff.trim() : null;
  const given = input.off_peak_hours ?? input.metering?.off_peak_hours?.all_year ?? null;
  const hours = Array.isArray(given) ? given.filter((w) => isObj(w) && typeof w.from === 'string' && typeof w.to === 'string').map((w) => ({ from: w.from, to: w.to }))
    : isObj(given) && typeof given.from === 'string' ? [{ from: given.from, to: given.to }] : (offPeakOf(site.id)?.all_year ?? null);
  for (const k of ['capacity', 'metering', 'grid_operator']) if (input[k] != null && !(k === 'metering' && given)) warnings.push(`${k}: tounify v2 takes no connection details; kept here only where it prices (off-peak hours)`);
  const meta = {
    country: cc, postal_code: postal, tariffs: { consumption: consumption || null, feedin },
    company: typeof input.company === 'string' && input.company ? input.company : null,
    off_peak_hours: hours?.length ? hours : null,
    capacity: site.contracted_kva > 0 ? { contracted_kva: site.contracted_kva } : null,
    api: 'v2',
  };
  return { meta, warnings, names: { tariffs: [consumption, feedin].filter(Boolean) } };
}

/**
 * Record the home's tounify tariff (no call: v2 has no connection): the connection row (provider 'tounify',
 * external_ref eb-site-<site id>, a local reference) with the tariff, postal code, supplier and off-peak hours. With
 * a client, the network operator serving the postal code is looked up (one listing request, nothing spent) and kept
 * for display; a failure there is a warning. The tariff's prices are read by the next daily sync (or right away by
 * the tariff picker). Returns { created, reference, country, grid_resolution, tariffs, connection, warnings }.
 */
export async function registerConnection(site, input = {}, { client = null } = {}) {
  const cc = countryOf(site);
  const ref = referenceOf(site);
  const { meta, warnings } = connectionBody(site, input, cc);
  const prior = connectionOf(site.id);
  let operator = prior?.meta?.postal_code === meta.postal_code ? prior.meta.grid_operator ?? null : null;
  if (!operator && client) {
    try { operator = await gridOperatorAt(cc, meta.postal_code, { client }); if (!operator) warnings.push(`the postal code ${meta.postal_code} maps to no network operator in tounify: prices may lack the grid charge`); } catch (err) {
      if (['rate_limited', 'allowance_exhausted', 'auth'].includes(err.kind)) throw err;
      warnings.push(`network operator not looked up: ${err.message}`);
    }
  }
  meta.grid_operator = operator ?? null;
  meta.updated_at = iso(client?.clock?.now() ?? Date.now());
  const keep = prior?.meta ?? {};
  const full = { ...keep, ...meta, company: meta.company ?? (keep.tariffs?.consumption === meta.tariffs.consumption ? keep.company ?? null : null) };
  db.prepare(`INSERT INTO connection (site_id, provider, external_ref, meta) VALUES (?, 'tounify', ?, ?)
    ON CONFLICT (site_id, provider) DO UPDATE SET external_ref = excluded.external_ref, meta = excluded.meta`).run(site.id, ref, JSON.stringify(full));
  // A new tariff is read in full at the next read (the daily gate is per tariff choice, not per day alone).
  if (keep.tariffs?.consumption !== meta.tariffs.consumption) updateState((s) => { s.connections ??= {}; s.connections[ref] = { ...(s.connections[ref] ?? {}), country: cc, last_price_day: null, next_at: null }; });
  return {
    created: !prior, reference: ref, country: cc,
    grid_resolution: operator ? { operator, location_mapped: true, source: 'postal_code' } : null,
    tariffs: full.tariffs, connection: { provider: PROVIDER, status: 'recorded', external_ref: ref },
    note: 'tounify v2 has no connection: the tariff and postal code are kept here; prices are read at the next daily sync',
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Forget the home's tounify tariff: end its agreements now (kept as history) and drop the row. No call. */
export async function removeConnection(site, { client = null } = {}) {
  const c = connectionOf(site.id);
  if (!c?.external_ref) return { removed: false, reason: 'no tounify tariff recorded for this home' };
  const ref = c.external_ref;
  const cc = c.meta.country ?? countryOf(site);
  const now = Math.floor((client?.clock?.now() ?? Date.now()) / 1000);
  tx(() => {
    for (const d of db.prepare("SELECT id FROM device WHERE site_id = ? AND provider = 'tounify' AND retired_at IS NULL").all(site.id)) {
      const cur = db.prepare('SELECT * FROM tariff_agreement WHERE device_id = ? AND superseded_at IS NULL ORDER BY valid_from').all(d.id);
      if (cur.some((a) => a.valid_to == null && a.valid_from < now)) {
        supersedeAgreements(site.id, d.id, cur.filter((a) => a.valid_from < now).map((a) => ({ tariffId: a.tariff_id, from: a.valid_from, to: a.valid_to == null || a.valid_to > now ? now : a.valid_to })));
      }
    }
    db.prepare("DELETE FROM connection WHERE site_id = ? AND provider = 'tounify'").run(site.id);
  });
  updateState((s) => { if (s.connections) delete s.connections[ref]; });
  return { removed: true, reference: ref, country: cc };
}

/**
 * POST /api/sites/:id/connections with provider 'tounify': the registry gate first (listed for the
 * home's market in a per-home role, switched on, licensed or on TOUNIFY_DEV with a test token, built,
 * owned by the core), then the core's token, then the home's tariff recorded.
 */
export async function connectTounify(d, site, input = {}, { env = process.env, client = null } = {}) {
  const { row, market } = connectable(d, site, { provider: PROVIDER, role: input.role ?? null });
  const c = credentialsFromEnv(env);
  if (c.missing) throw bad(c.missing);
  let r;
  try {
    r = await registerConnection(site, input, { client: client ?? clientFor(c.creds) });
  } catch (err) {
    if (!(err instanceof TounifyError)) throw err;
    // The API's answer as ours: refused here or rate-limited -> 429; refused by tounify -> 400 (its code in
    // the message); anything else (auth, network, an odd answer) -> 502. Never the token.
    const status = ['allowance', 'cooldown', 'rate_limited', 'allowance_exhausted'].includes(err.kind) ? 429
      : err.kind === 'upstream' && err.status >= 400 && err.status < 500 ? 400 : 502;
    throw Object.assign(new Error(err.message), { status, code: err.code ?? null });
  }
  return { ...r, role: row.role, adapter: PROVIDER, market, secrets_stored: false, ...(c.creds.dev ? { dev_override: c.creds.dev } : {}) };
}
