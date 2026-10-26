// The Compatibility page and GET /api/compatibility (src/core/compatibility.js, the shared check in
// src/core/coverage.js, public/js/compatibility-view.js): the coverage matrix's items with every target
// checked live against the database, how Predbat and PredHeat read data and where it lives here, the
// conflicts, the unverified items and what is not built. Temp database (a fresh one: schema, every delta,
// every seed); the fetch below fails any network call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
globalThis.fetch = async (url) => { throw new Error(`no network in tests: ${url}`); };
// Stand-in secrets and a home with recognisable data, set only in this process: none may reach the JSON.
const SECRETS = { OCTOPUS_API_KEY: 'sk_test_compat_never_1', SUNSYNK_PASSWORD: 'pw_compat_never_2' };
Object.assign(process.env, SECRETS);
const HOME = { name: 'Compat Test Cottage 7781', postcode: 'ZZ9 9ZZ' };
const REF = 'A-COMPATREF-0099';

const { db } = await import('../src/db/db.js');
const { createSite } = await import('../src/core/sites.js');
const { app } = await import('../src/server.js');
const C = await import('../src/core/compatibility.js');
const { targetChecker, documentedJsonKeys } = await import('../src/core/coverage.js');
const plannerRead = await import('../src/core/planner-read.js');
const plans = await import('../src/core/plans.js');
const commands = await import('../src/core/commands.js');
const V = await import('../public/js/compatibility-view.js');

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const matrix = JSON.parse(read('docs/coverage-matrix.json'));
const docs = { matrix, catalogueText: read('docs/predbat-predheat-requirements.md'), reportText: read('docs/predbat-predheat-coverage.md'), databaseMd: read('docs/database.md') };
const MODULES = { 'planner-read': plannerRead, plans, commands };

const site = createSite({ ...HOME, lat: 51.5, lon: -0.1 });
db.prepare("INSERT INTO connection (site_id, provider, external_ref, status, meta) VALUES (?, 'octopus', ?, 'ok', ?)").run(site.id, REF, JSON.stringify({ account: REF }));

const built = C.buildCompatibility(db);
const byId = new Map(built.items.map((i) => [i.id, i]));

test('the summary equals docs/coverage-matrix.json: 481 items, 467 covered, 14 excluded, 0 gaps; 456 of 456 verified data items', () => {
  const c = matrix.counts;
  const s = built.summary;
  assert.equal(s.items, c.all.total);
  assert.equal(s.covered, c.all.covered);
  assert.equal(s.excluded, c.all.excluded_not_data);
  assert.equal(s.gaps, c.all.gap);
  assert.equal(s.data_items, c.all.total - c.all.excluded_not_data);
  assert.equal(s.covered_found, c.all.covered, 'every covered item found live on a fresh database');
  assert.equal(s.verified_items, c.verified.total);
  assert.equal(s.verified_data_items, c.verified.total - c.verified.excluded_not_data);
  assert.equal(s.verified_covered, c.verified.covered);
  assert.equal(s.unverified_items, c.unverified.total);
  assert.equal(s.unverified_covered, c.unverified.covered);
  assert.equal(s.percent_verified_covered, c.covered_pct_of_data_items.verified);
  assert.deepEqual([s.items, s.covered, s.excluded, s.gaps, s.verified_data_items, s.verified_covered], [481, 467, 14, 0, 456, 456]);
  // Groups and products agree with the matrix's own counts.
  for (const g of built.groups) {
    const m = c.by_group[g.id];
    assert.ok(m, `group ${g.id} is a matrix group`);
    assert.deepEqual([g.items, g.covered, g.excluded, g.gaps], [m.total, m.covered, m.excluded_not_data, m.gap], g.id);
    assert.ok(C.GROUP_LABELS[g.id] && g.label === C.GROUP_LABELS[g.id], `${g.id} has a label in words`);
  }
  assert.equal(built.groups.length, Object.keys(c.by_group).length);
  assert.deepEqual(built.groups.slice(0, 2).map((g) => g.id), ['PB-INV', 'PB-CAP'], 'groups in catalogue order');
  const prod = Object.fromEntries(built.products.map((p) => [p.id, p]));
  assert.deepEqual([prod.predbat.items, prod.predheat.items, prod.planning_design.items], [416, 54, 11]);
  assert.equal(built.items[0].id, 'PB-INV-01', 'items in catalogue order');
  assert.equal(built.definition, matrix.definition);
});

test('live check on a fresh database: every target of every covered item exists, and every "how" place and read function', () => {
  const lc = built.live_check;
  const nTargets = matrix.items.reduce((n, i) => n + (i.targets?.length ?? 0), 0);
  assert.equal(lc.targets_checked, nTargets);
  assert.ok(nTargets > 1000);
  assert.deepEqual(lc.missing, []);
  assert.deepEqual(lc.how_missing, []);
  assert.equal(lc.catalogue_matches_matrix, true, 'the matrix was built from the catalogue on disk');
  assert.equal(lc.ok, true);
  for (const it of built.items.filter((i) => i.status === 'covered')) {
    assert.ok(it.targets.length > 0, it.id);
    for (const t of it.targets) assert.equal(t.exists, true, `${it.id}: ${t.ref}`);
    assert.equal(it.live, 'found', it.id);
  }
  // Same targets as the matrix, in the same order (the API adds only `exists`).
  for (const m of matrix.items) assert.deepEqual(byId.get(m.id).targets.map(({ exists, ...t }) => t), (m.targets ?? []).map((t) => ({ kind: t.kind, ref: t.ref, ...(t.json_key ? { json_key: t.json_key } : {}) })), m.id);
});

test('a missing target is reported: exists false on the target, the item, its group and the summary, and the live check fails', () => {
  // The shared check itself: a fake ref of every kind is false, a real one true.
  const exists = targetChecker(db, { readModules: { 'planner-read': plannerRead }, jsonKeys: documentedJsonKeys(docs.databaseMd) });
  for (const t of [
    { kind: 'table_column', ref: 'plan_slot.no_such_column' }, { kind: 'table_column', ref: 'no_such_table.id' },
    { kind: 'table_column', ref: 'plan_run.summary', json_key: 'no_such_key' }, { kind: 'registry_key', ref: 'attribute_def:no_such_key' },
    { kind: 'registry_key', ref: 'setting_def:no_such_key' }, { kind: 'registry_key', ref: 'device_kind:no_such_kind' }, { kind: 'registry_key', ref: 'other_def:x' },
    { kind: 'metric', ref: 'metric:no_such_metric' }, { kind: 'source', ref: 'source:no_such_source' }, { kind: 'device_action', ref: 'device_action:battery.no_such_action' },
    { kind: 'view', ref: 'view:v_no_such_view' }, { kind: 'read_function', ref: 'planner-read.noSuchFunction' }, { kind: 'read_function', ref: 'plans.currentPlan' },
    { kind: 'read_function', ref: 'planner-read.STEP_S' }, { kind: 'no_such_kind', ref: 'x' },
  ]) assert.equal(exists(t), false, JSON.stringify(t));
  for (const t of [{ kind: 'table_column', ref: 'plan_slot.action' }, { kind: 'metric', ref: 'metric:solar_kwh_p10' }, { kind: 'read_function', ref: 'planner-read.rates' },
    { kind: 'view', ref: 'view:v_plan_in_force' }, { kind: 'device_action', ref: 'device_action:battery.freeze_export' }]) assert.equal(exists(t), true, t.ref);

  // Through the API's builder: one verified Predbat item gains a target that does not exist.
  const broken = structuredClone(matrix);
  const victim = broken.items.find((i) => i.id === 'PB-RATE-03');
  victim.targets.push({ kind: 'metric', ref: 'metric:no_such_metric' });
  const r = C.buildCompatibility(db, { ...docs, matrix: broken });
  assert.equal(r.live_check.ok, false);
  assert.equal(r.live_check.targets_missing, 1);
  assert.deepEqual(r.live_check.missing, [{ item: 'PB-RATE-03', kind: 'metric', ref: 'metric:no_such_metric' }]);
  const it = r.items.find((i) => i.id === 'PB-RATE-03');
  assert.equal(it.live, 'target_missing');
  assert.equal(it.targets.at(-1).exists, false);
  assert.equal(it.targets_missing, 1);
  assert.equal(r.summary.verified_covered, 455);
  assert.equal(r.summary.target_missing, 1);
  assert.equal(r.summary.percent_verified_covered, 99.8);
  assert.equal(r.groups.find((g) => g.id === 'PB-RATE').target_missing, 1);
  // The page goes red, names the item and the missing place, in words.
  const hero = V.heroHtml(r);
  assert.match(hero, /compat-hero bad/);
  assert.match(hero, /Live check failed/);
  assert.match(hero, /PB-RATE-03.*metric:no_such_metric.*missing/s);
  assert.match(hero, /455 of 456/);
  assert.match(V.itemHtml(it, r), /Missing now.*✗<\/span> missing/s);
  assert.ok(V.filterOptions(r).statuses.includes('target_missing'), 'the status filter offers "Missing now" when there is one');
  assert.ok(!V.filterOptions(built).statuses.includes('target_missing'));
});

test('excluded items carry their reasons; gaps none; unverified and conflicts listed with their items', () => {
  assert.equal(built.excluded.length, 14);
  for (const x of built.excluded) {
    assert.ok(typeof x.reason === 'string' && x.reason.length > 20, `${x.id} states why`);
    assert.equal(byId.get(x.id).status, 'excluded_not_data');
    assert.deepEqual(byId.get(x.id).targets, []);
  }
  assert.deepEqual(built.excluded.map((x) => x.id).sort(), matrix.items.filter((i) => i.status === 'excluded_not_data').map((i) => i.id).sort());
  assert.deepEqual(built.unverified.map((u) => u.id), ['PB-DIAG-04', ...Array.from({ length: 11 }, (_, i) => `PD-${String(i + 1).padStart(2, '0')}`)]);
  assert.equal(built.conflicts.length, 7, 'catalogue section 1.4 has seven conflicts');
  for (const c of built.conflicts) {
    assert.ok(c.title && c.catalogue_text && c.schema_choice && c.conflict, `conflict ${c.n} has the sources' words and the schema's choice`);
    assert.ok(c.items.length > 0 && c.items.every((id) => byId.get(id)?.conflict === c.n), `conflict ${c.n} names its items`);
  }
  // Every verified item names a public source; an unverified one may not.
  for (const it of built.items.filter((i) => i.verified)) assert.match(it.source_url ?? '', /^https:\/\//, `${it.id} has a source link`);
  for (const it of built.items) for (const code of it.source_codes) assert.ok(built.source_codes[code]?.url, `${it.id}: source ${code}`);
  assert.ok(built.what_is_not_built.length >= 4 && built.what_is_not_built.some((x) => /planner/i.test(x.what)));
  assert.match(built.headline.limit, /planner itself, device adapters and real heating data are not built/);
});

test('how they read: every entry has a read function that exists in its module (planner-read.js for the facts), real places and catalogue ids, and one sentence why', () => {
  const how = built.how_it_consumes;
  assert.ok(how.length >= 9);
  const ids = new Set(matrix.items.map((i) => i.id));
  for (const h of how) {
    const [mod, name] = h.read_function.ref.split('.');
    assert.ok(MODULES[mod], `${h.id}: ${mod} is a read module`);
    assert.equal(typeof MODULES[mod][name], 'function', `${h.id}: ${h.read_function.ref} is an export of ${C.READ_MODULE_FILES[mod]}`);
    assert.equal(h.read_function.exists, true);
    assert.equal(h.read_function.file, C.READ_MODULE_FILES[mod]);
    assert.ok(h.where_it_lives_in_our_db.length >= 4 && h.where_it_lives_in_our_db.every((w) => w.exists), h.id);
    assert.ok(h.items.length > 0 && h.items.every((i) => ids.has(i.id) && i.name), `${h.id}: catalogue ids`);
    assert.ok(h.title && h.what_they_read && h.their_names.length, h.id);
    assert.match(h.why_compatible, /^[A-Z].*\.$/, `${h.id}: a sentence`);
    assert.equal((h.why_compatible.match(/\.\s+[A-Z]/g) || []).length, 0, `${h.id}: one sentence`);
  }
  // The facts are read through the planner read layer; only the plan and command rows through their own helpers.
  const viaPlannerRead = how.filter((h) => h.read_function.ref.startsWith('planner-read.'));
  assert.ok(viaPlannerRead.length >= 8);
  for (const h of viaPlannerRead) assert.equal(typeof plannerRead[h.read_function.ref.split('.')[1]], 'function');
  assert.deepEqual(how.filter((h) => !h.read_function.ref.startsWith('planner-read.')).map((h) => h.id), ['plan_outputs', 'commands']);
  for (const want of ['counterDifferenceSeries', 'rates', 'forecast', 'loadHistory', 'state', 'series', 'window']) {
    assert.ok(how.some((h) => h.read_function.ref === `planner-read.${want}`), `planner-read.${want} is used`);
  }
});

test('no credential and no home\'s data in the JSON', () => {
  const text = JSON.stringify(built);
  for (const v of [...Object.values(SECRETS), HOME.name, HOME.postcode, REF, '51.5']) assert.ok(!text.includes(v), `contains ${v}`);
  const keys = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); } };
  walk(built);
  for (const k of ['site_id', 'postcode', 'external_ref', 'lat', 'lon', 'meta', 'password', 'token', 'api_key', 'credential', 'name_of_home']) assert.ok(!keys.has(k), `key ${k}`);
});

test('the live check is cached for 60 s, then run again', () => {
  C.clearCompatibilityCache();
  const t = Date.parse('2026-10-26T12:00:00Z');
  const a = C.compatibility(db, { now: t });
  assert.equal(C.compatibility(db, { now: t + 59_000 }), a, 'same result within 60 s');
  const b = C.compatibility(db, { now: t + 60_000 });
  assert.notEqual(b, a, 'checked again after 60 s');
  assert.equal(b.generated_at, new Date(t + 60_000).toISOString());
  assert.equal(a.live_check.cache_s, 60);
  C.clearCompatibilityCache();
});

// ───────────── API and page ─────────────

const server = app.listen(0);
after(() => server.close());
const http = (await import('node:http')).default;
const get = (p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${server.address().port}${p}`, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'] }));
  }).on('error', reject);
});

test('GET /api/compatibility: no home needed, the shape the page reads, no credential', async () => {
  const r = await get('/api/compatibility');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  for (const k of ['generated_at', 'definition', 'summary', 'groups', 'items', 'how_it_consumes', 'conflicts', 'what_is_not_built', 'tests', 'live_check', 'excluded', 'unverified']) assert.ok(k in j, k);
  assert.equal(j.tests.coverage_test, 'test/coverage-matrix.test.js');
  assert.equal(j.items.length, 481);
  assert.equal(j.live_check.ok, true);
  const it = j.items.find((i) => i.id === 'PB-INV-01');
  for (const k of ['id', 'name', 'direction', 'status', 'verified', 'source_url', 'targets']) assert.ok(k in it, k);
  assert.ok(it.targets.every((t) => 'kind' in t && 'ref' in t && t.exists === true));
  for (const v of [...Object.values(SECRETS), HOME.name, REF]) assert.ok(!r.text.includes(v));
  const page = await get('/compatibility');
  assert.equal(page.status, 200);
  assert.match(page.text, /\/js\/pages\/compatibility\.js/);
});

test('the page views escape every API text, say each status in words, and page the list', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const d = structuredClone(built);
  const it = d.items.find((i) => i.id === 'PB-INV-01');
  Object.assign(it, { name: evil, note: `${evil} \`code\``, source: evil });
  it.targets[0].ref = evil;
  d.how_it_consumes[0].what_they_read = evil;
  d.how_it_consumes[0].why_compatible = evil;
  d.conflicts[0].schema_choice = evil;
  d.excluded[0].reason = evil;
  d.what_is_not_built = [{ what: evil, detail: evil }];
  d.source_codes.AY = { label: evil, url: 'javascript:alert(1)' };
  const html = [V.heroHtml(d), V.howHtml(d), V.groupsHtml(d), V.itemHtml(it, d), V.excludedHtml(d), V.conflictsHtml(d), V.unverifiedHtml(d), V.notBuiltHtml(d), V.filesHtml(d), V.definitionHtml(d), V.controlsHtml(d, V.emptyFilters())].join('');
  assert.ok(!html.includes('<img'), 'no raw HTML from the API');
  assert.ok(!html.includes('javascript:'), 'only https links');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(V.itemHtml(it, d), /<code>code<\/code>/, 'back-ticks become code spans after escaping');
  // Words, not colour only.
  const row = V.itemHtml(byId.get('PB-INV-01'), built);
  assert.match(row, />Covered</);
  assert.match(row, /✓<\/span> found/);
  assert.match(V.itemHtml(byId.get('PB-CAP-21'), built), /Excluded: not data/);
  assert.match(V.itemHtml(byId.get('PD-01'), built), /Unverified/);
  assert.match(V.heroHtml(built), /Live check passed.*456 of 456|456 of 456.*Live check passed/s);
  assert.match(V.groupsHtml(built), /75 of 75 data items covered/);
  // Paged: 25 rows at a time, filters on product, group, status, direction, verified and text.
  const all = V.applyFilters(built.items, V.emptyFilters());
  assert.equal(all.length, 481);
  assert.equal((V.listHtml(all, built, 0).match(/<details class="compat-item"/g) || []).length, V.PAGE_SIZE);
  assert.match(V.listHtml(all, built, 19), /Page 20 of 20/);
  assert.equal(V.applyFilters(built.items, { ...V.emptyFilters(), product: 'predheat' }).length, 54);
  assert.equal(V.applyFilters(built.items, { ...V.emptyFilters(), status: 'excluded_not_data' }).length, 14);
  assert.equal(V.applyFilters(built.items, { ...V.emptyFilters(), ver: 'unverified' }).length, 12);
  assert.equal(V.applyFilters(built.items, { ...V.emptyFilters(), group: 'PB-RATE' }).length, 46);
  assert.equal(V.applyFilters(built.items, { ...V.emptyFilters(), q: 'heat loss' }).every((i) => /heat loss/i.test(`${i.id} ${i.name}`)), true);
  assert.deepEqual(V.applyFilters(built.items, { ...V.emptyFilters(), q: 'pb-mod' }), []);
  assert.ok(V.applyFilters(built.items, { ...V.emptyFilters(), dir: 'control' }).length > 0);
  assert.match(V.countText(46, 481, 1), /46 of 481 items match; showing 26 to 46/);
});

test('the nav lists the page, and the page file exists', () => {
  assert.match(read('public/js/layout.js'), /\['compatibility', 'Compatibility', '\/compatibility'\]/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'compatibility.html')));
});
