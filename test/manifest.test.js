// The integration manifest (plan 2.6): one entry per integration, and what it merges from the source registry, the market providers and
// the registered adapters adds up: nothing registered without an entry, no source in two entries or in none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDb } from './helpers.js';

await useDb();
const { app } = await import('../src/server.js');
const M = await import('../src/core/manifest.js');
const { db } = await import('../src/db/db.js');

await test('the manifest adds up: every adapter, provider row and source is accounted for', async () => {
  assert.deepEqual(await M.manifestProblems(db), []);
});

await test('an entry says how it is reached and what it brings, with its markets and licence from the provider rows', async () => {
  const list = await M.integrationManifest(db);
  const by = Object.fromEntries(list.map((e) => [e.code, e]));
  assert.deepEqual([by.sunsynk.access, by.sunsynk.auth, by.sunsynk.implemented, by.sunsynk.needsCredentials, by.sunsynk.writes], ['cloud_pull', 'user_login', true, true, []]);
  assert.deepEqual(by.sunsynk.roles, ['inverter']);
  assert.ok(by.sunsynk.discovers.includes('battery') && by.sunsynk.sourceRows.every((s) => s.name), 'its sources are registry rows');
  assert.deepEqual(by.octopus.markets, ['GB']);
  assert.equal(by.tounify.licenceConfirmed, false, 'a provider whose licence is not confirmed says so');
  assert.equal(by.open_meteo.needsCredentials, false);
  assert.equal(by.tariffscanner.rateLimit, '20 requests a minute per credential');
  assert.equal(by.linky.implemented, false, 'a provider the core knows of but has not built');
  assert.ok(list.every((e) => ['cloud_pull', 'public_feed', 'cloud_push', 'hub', 'manual', 'generated', 'core'].includes(e.access)));
  assert.ok(list.every((e) => ['none', 'api_key', 'user_login', 'token', 'account'].includes(e.auth)));
});

await test('GET /api/integrations', async () => {
  const server = app.listen(0); server.unref();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.integrations.length >= 15 && body.integrations.some((e) => e.code === 'sunsynk'));
});
