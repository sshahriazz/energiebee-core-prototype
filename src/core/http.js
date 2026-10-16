// Small fetch wrapper for adapters: timeout, JSON parsing and a readable error.
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const err = new Error(`${method} ${new URL(url).host}${new URL(url).pathname} -> HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    return { json, text };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
