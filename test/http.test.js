// Retry rules of the HTTP wrapper, against a local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJson, fetchText, retryPolicy } from '../src/core/http.js';

retryPolicy.delaysMs = [10, 20];
let server; let base; let plan = []; let hits = 0;
const reset = (p) => { plan = p; hits = 0; };

before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const [status, headers = {}] = plan.shift() ?? [200];
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ status }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('retries 503 and 429, then succeeds', async () => {
  reset([[503], [429], [200]]);
  const { json } = await fetchJson(`${base}/x`);
  assert.equal(json.status, 200);
  assert.equal(hits, 3);
});

test('does not retry 401 (a bad key gives the same answer every time)', async () => {
  reset([[401]]);
  await assert.rejects(fetchJson(`${base}/x`), /HTTP 401$/);
  assert.equal(hits, 1);
});

test('gives up after the last attempt and says how many were made', async () => {
  reset([[500], [502], [503]]);
  await assert.rejects(fetchJson(`${base}/x`), /HTTP 503 \(3 attempts\)/);
  assert.equal(hits, 3);
});

test('waits as long as Retry-After asks', async () => {
  reset([[429, { 'retry-after': '1' }], [200]]);
  const t0 = Date.now();
  await fetchJson(`${base}/x`);
  assert.ok(Date.now() - t0 >= 900, 'waited about 1 s');
  assert.equal(hits, 2);
});

test('retries network errors', async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  await assert.rejects(fetchJson(`http://127.0.0.1:${port}/x`), /3 attempts/);
});

test('fetchText returns the final status for the caller to check', async () => {
  reset([[404]]);
  const r = await fetchText(`${base}/x`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(hits, 1);
});
