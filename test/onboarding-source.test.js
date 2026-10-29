// Adding a new source from the Providers screen (POST /api/sources): a source row described in words, with traits, created by the
// user and never touched by the registry seed. Through a real server on a copy of the frozen real GB home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useDb, hasLive } from './helpers.js';

const skip = hasLive ? false : 'no test/fixtures/gb-home.db (node scripts/make-fixture.js)';
const dbFile = hasLive ? useDb({ snapshot: true }) : null;
const { db } = hasLive ? await import('../src/db/db.js') : {};
const { app } = hasLive ? await import('../src/server.js') : {};

let server; let base;
before(async () => { if (hasLive) await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server?.address().port}`; });
after(() => server?.close());

const SITE = 1;
const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => { const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

const good = (over = {}) => ({
  code: 'acme_inverter', name: 'Acme inverter cloud',
  contract: { timeZone: 'UTC epoch seconds', timeRole: 'instant every 5 minutes', signs: 'grid positive means importing', units: 'kW and kWh', missing: 'the point is left out', revisions: 'never', upstreamHistory: '30 days' },
  traits: { holdS: 300, expectedEveryS: 300 }, ...over,
});

test('a new source is created, marked as the user\'s, listed at once, and can be bound and mapped like any other', { skip }, async () => {
  const r = await post('/api/sources', good());
  assert.equal(r.status, 201);
  assert.equal(r.body.source.code, 'acme_inverter');
  assert.equal(r.body.source.createdByUser, true);
  assert.deepEqual([r.body.source.traits.holdS, r.body.source.traits.expectedEveryS, r.body.source.traits.created_by], [300, 300, 'user']);
  assert.equal(r.body.source.contract.units, 'kW and kWh');
  const list = await get('/api/sources');
  assert.ok(list.body.sources.some((s) => s.code === 'acme_inverter' && s.createdByUser), 'listed at once');
  assert.equal(list.body.sources.find((s) => s.code === 'sunsynk_5min').createdByUser, false, 'code-defined sources are not marked');
  assert.equal(list.body.contractFields.length, 7);
  // usable by the existing flow: map a point, preview a bind
  const ch = await post(`/api/sites/${SITE}/channels`, { source: 'acme_inverter', point: 'pv_kw', metric: 'solar_w', scale: 1000, part: 'positive', min: 0, max: 60000 });
  assert.equal(ch.status, 201);
  const pv = await post(`/api/sites/${SITE}/bindings/preview`, { action: 'bind', role: 'inverter_5min', source: 'acme_inverter', from: 'now' });
  assert.equal(pv.status, 200);
  assert.ok(pv.body.warnings.some((w) => /no data for this home yet/.test(w)), 'a source with no data says so');
});

test('dryRun validates and returns the row but creates nothing', { skip }, async () => {
  const before = count('source');
  const r = await post('/api/sources?dryRun=1', good({ code: 'acme_dry' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.source.code, 'acme_dry');
  assert.equal(count('source'), before);
  assert.equal(db.prepare("SELECT 1 FROM source WHERE code = 'acme_dry'").get(), undefined);
});

test('every validation error has a status, a code and the field at fault, and writes nothing', { skip }, async () => {
  const before = count('source');
  const cases = [
    [good({ code: '' }), 400, 'missing_field', 'code'],
    [good({ code: 'Acme' }), 400, 'bad_code', 'code'],
    [good({ code: 'a' }), 400, 'bad_code', 'code'],
    [good({ code: '1acme' }), 400, 'bad_code', 'code'],
    [good({ code: 'acme-inverter' }), 400, 'bad_code', 'code'],
    [good({ code: 'a'.repeat(41) }), 400, 'bad_code', 'code'],
    [good({ code: 'sunsynk_5min' }), 409, 'source_exists', 'code'],
    [good({ code: 'acme_inverter' }), 409, 'source_exists', 'code'],
    [good({ code: 'acme_x', name: '' }), 400, 'missing_field', 'name'],
    [good({ code: 'acme_x', name: 'n'.repeat(101) }), 400, 'bad_value', 'name'],
    [good({ code: 'acme_x', contract: { ...good().contract, units: '' } }), 400, 'missing_field', 'contract.units'],
    [good({ code: 'acme_x', contract: { ...good().contract, signs: 's'.repeat(301) } }), 400, 'bad_value', 'contract.signs'],
    [good({ code: 'acme_x', contract: undefined }), 400, 'missing_field', 'contract.timeZone'],
    [good({ code: 'acme_x', traits: { holdS: 'abc' } }), 400, 'bad_number', 'traits.holdS'],
    [good({ code: 'acme_x', traits: { holdS: 0 } }), 400, 'bad_number', 'traits.holdS'],
    [good({ code: 'acme_x', traits: { holdS: 1.5 } }), 400, 'bad_number', 'traits.holdS'],
    [good({ code: 'acme_x', traits: { expectedEveryS: -5 } }), 400, 'bad_number', 'traits.expectedEveryS'],
    [good({ code: 'acme_x', traits: { live: true, forecastOnly: true } }), 400, 'bad_value', 'traits.forecastOnly'],
    [good({ code: 'acme_x', traits: { irregular: true, expectedEveryS: 60 } }), 400, 'bad_value', 'traits.irregular'],
  ];
  for (const [body, status, code, field] of cases) {
    const r = await post('/api/sources', body);
    assert.deepEqual([r.status, r.body.code, r.body.field], [status, code, field], JSON.stringify(body).slice(0, 80));
    assert.ok(r.body.error && r.body.error.length > 5, 'a plain message');
  }
  assert.equal(count('source'), before, 'nothing was created');
});

test('a source created on the screen survives the registry seed on the next open, and the code-defined ones are intact', { skip }, () => {
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-src-')), 'copy.db');
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  const script = `const { db } = await import(${JSON.stringify(path.resolve(import.meta.dirname, '../src/db/db.js'))});
    const a = db.prepare("SELECT name, contract, traits FROM source WHERE code = 'acme_inverter'").get();
    const b = db.prepare("SELECT traits FROM source WHERE code = 'sunsynk_5min'").get();
    console.log(JSON.stringify({ a, b, n: db.prepare('SELECT COUNT(*) n FROM source').get().n }));`;
  const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, DB_FILE: copy }, encoding: 'utf8' });
  for (const pass of [1, 2]) {   // open twice: the seed runs on each open
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.a.name, 'Acme inverter cloud', `pass ${pass}`);
    assert.equal(JSON.parse(out.a.traits).created_by, 'user');
    assert.equal(JSON.parse(out.a.contract).units, 'kW and kWh');
    assert.equal(JSON.parse(out.b.traits).expectedEveryS, 300, 'the code-defined source keeps its traits');
    assert.equal(out.n, db.prepare('SELECT COUNT(*) n FROM source').get().n);
  }
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });
});
