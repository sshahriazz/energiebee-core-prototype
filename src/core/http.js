// Small fetch wrapper for adapters: timeout, retry, JSON parsing and a readable error.
//
// Retries only what can succeed on a second try: network errors, timeouts, HTTP 429 and
// 5xx. Any other status (401 bad key, 404, 400) fails at once, because asking again gives
// the same answer. Waits follow `retryPolicy.delaysMs`, or the server's Retry-After when
// it sends one (capped at `maxWaitMs`). A failure after the last attempt is thrown as
// before, so the sync step records it and the next sync tries again.
import { AsyncLocalStorage } from 'node:async_hooks';

export const retryPolicy = { delaysMs: [1000, 4000], maxWaitMs: 30000 };

// Within shareResponses(cache, fn), fetchJson answers a request identical to one already made in
// the same cache (method, URL and body) with that first answer instead of calling again. The sync
// job wraps the steps of shared providers in it (src/jobs/sync.js), so several homes at one
// location ask Open-Meteo or Quartz once per cycle while each still stores its own facts.
// A request with an authorization header is never shared.
const sharedResponses = new AsyncLocalStorage();
export const shareResponses = (cache, fn) => sharedResponses.run(cache, fn);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const retryable = (status) => status === 429 || status >= 500;

function retryAfterMs(res) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

// One request with retries. Returns { res, text } for any final status; throws only when
// the network or the timeout failed on every attempt.
async function attempt(url, init, timeoutMs) {
  const delays = retryPolicy.delaysMs;
  for (let i = 0; ; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res = null; let text = null; let netErr = null;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
      text = await res.text();
    } catch (err) {
      netErr = err.name === 'AbortError' ? new Error(`timed out after ${timeoutMs} ms`) : err;
    } finally {
      clearTimeout(timer);
    }
    const again = netErr || retryable(res.status);
    if (!again || i >= delays.length) {
      if (netErr) { netErr.attempts = i + 1; throw netErr; }
      return { res, text, attempts: i + 1 };
    }
    await sleep(Math.min(retryAfterMs(res) ?? delays[i], retryPolicy.maxWaitMs));
  }
}

const describe = (method, url) => `${method} ${new URL(url).host}${new URL(url).pathname}`;

export function fetchJson(url, opts = {}) {
  const cache = sharedResponses.getStore();
  const { method = 'GET', headers = {}, body } = opts;
  if (!cache || Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) return fetchJsonOnce(url, opts);
  const key = JSON.stringify([method, url, body === undefined ? null : body]);
  if (!cache.has(key)) cache.set(key, fetchJsonOnce(url, opts).catch((err) => { cache.delete(key); throw err; }));
  return cache.get(key);
}

async function fetchJsonOnce(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const init = {
    method,
    headers: { accept: 'application/json', ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  };
  let out;
  try { out = await attempt(url, init, timeoutMs); } catch (err) {
    throw new Error(`${describe(method, url)} -> ${err.message} (${err.attempts} attempt${err.attempts === 1 ? '' : 's'})`);
  }
  const { res, text, attempts } = out;
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const err = new Error(`${describe(method, url)} -> HTTP ${res.status}${attempts > 1 ? ` (${attempts} attempts)` : ''}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return { json, text };
}

// Same retry rules for a non-JSON body (for example CSV). The caller checks the status.
export async function fetchText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  try {
    const { res, text } = await attempt(url, { method: 'GET', headers }, timeoutMs);
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    throw new Error(`${describe('GET', url)} -> ${err.message} (${err.attempts} attempt${err.attempts === 1 ? '' : 's'})`);
  }
}
