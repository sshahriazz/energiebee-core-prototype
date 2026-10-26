// The Data Explorer's endpoints (GET /api/explorer/*: src/routes/explorer.js, src/core/explorer.js)
// over HTTP, on the three SYNTHETIC homes of scripts/lib/multi-market.js (GB half-hours, FR, NL
// quarter-hours) in a temp database, plus a Tariffscanner page (test/fixtures) landed as a raw
// payload: every endpoint's shape, re-derivation of a payload and a tampered row caught, as-of reads,
// a corrupted stored row failing validation with its explanation, correlation numbers against a
// hand computation, bad input 400, and no credential in any answer. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useDb } from './helpers.js';

useDb();
globalThis.fetch0 = globalThis.fetch;
const SECRETS = { OCTOPUS_API_KEY: 'sk_live_explorer_never_1', SUNSYNK_PASSWORD: 'pw_explorer_never_2', TOUNIFY_TOKEN: 'tounify_test_sk_explorer_never_3' };
Object.assign(process.env, SECRETS);
const m = await import('../scripts/lib/multi-market.js');
const { db } = await import('../src/db/db.js');
const { app } = await import('../src/server.js');
const { landRaw, putReadings, seriesId } = await import('../src/core/facts.js');
const TS = await import('../src/adapters/tariffscanner.js');
const X = await import('../src/core/explorer.js');
const { dayBounds } = await import('../src/core/time.js');

const homes = m.buildScenario();
const { gb, fr, nl } = homes;
const server = app.listen(0);
after(() => server.close());
const seen = [];
async function call(p) {
  const res = await globalThis.fetch0(`http://127.0.0.1:${server.address().port}${p}`);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, body: JSON.parse(text) };
}
const get = async (p) => { const r = await call(p); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const stamp = (b, site) => { assert.equal(b.site, site); assert.ok(Number.isInteger(b.generated_at) && b.generated_at > 1.7e9); };

// A Tariffscanner page (no home) and an Octopus-style rate payload of the GB home, landed raw.
const page = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'tariffscanner', 'page-1.json'), 'utf8'));
const tsRaw = landRaw({ source: 'tariffscanner', siteId: null, request: { method: 'POST', path: TS.DOMESTIC, query: { offset: 0, limit: 5 } }, body: page }).rawId;
TS.storeMapped(TS.mapRecords(page.data), { rawId: tsRaw });
const octoRaw = landRaw({ source: 'octopus_rates', siteId: gb.site.id, request: { url: `https://api.octopus.energy/v1/x/?api_key=${SECRETS.OCTOPUS_API_KEY}&page_size=1500` }, body: { results: [] } }).rawId;
const octoRaw2 = landRaw({ source: 'octopus_meter', siteId: gb.site.id, request: { url: 'https://api.octopus.energy/v1/y/' }, body: { results: [{ consumption: 1 }] } }).rawId;

test('overview: range, slot length, currency, sources, raw payloads, timeline states and checks', async () => {
  const o = await get(`/api/explorer/overview?site=${gb.site.id}`);
  stamp(o, gb.site.id);
  assert.deepEqual(o.range, { first_date: m.GB.from, last_date: m.GB.to });
  assert.equal(o.slot_s, 1800); assert.equal(o.currency, 'GBP');
  const ss = o.sources.find((s) => s.code === 'sunsynk_5min');
  assert.equal(ss.series, 7);
  assert.ok(ss.facts > 0 && ss.first_ts < ss.last_ts);
  assert.ok(o.series_count >= 9);
  assert.equal(o.raw.count, 2);
  assert.deepEqual(o.raw.by_source.map((x) => [x.source, x.count, x.unlinked]), [['octopus_meter', 1, 1], ['octopus_rates', 1, 1]]);
  assert.ok(o.raw.bytes > 0);
  const t = o.timeline;
  assert.equal(t.slots, m.hhRows(gb.site.id, m.GB.from, m.GB.to).length);
  assert.equal(t.final + t.provisional + t.missing, t.slots);
  assert.deepEqual(Object.keys(o.checks).sort(), ['fail', 'pass', 'skip', 'warn']);
  assert.equal((await get(`/api/explorer/overview?site=${nl.site.id}`)).slot_s, 900);
});

test('raw: keyset pages with filters; one payload with body, forward lineage and a credential-free request', async () => {
  const l1 = await get(`/api/explorer/raw?site=${gb.site.id}&limit=1`);
  stamp(l1, gb.site.id);
  assert.equal(l1.rows.length, 1);
  assert.deepEqual(Object.keys(l1.rows[0]), ['id', 'source', 'fetched_at', 'status', 'reason', 'size', 'hash', 'request', 'facts_linked']);
  assert.equal(l1.rows[0].id, octoRaw2);
  assert.equal(l1.next, octoRaw2);
  const l2 = await get(`/api/explorer/raw?site=${gb.site.id}&limit=1&cursor=${l1.next}`);
  assert.equal(l2.rows[0].id, octoRaw); assert.equal(l2.next, null);
  assert.match(l2.rows[0].request.url, /api_key=\[redacted\]&page_size=1500/);
  assert.deepEqual((await get(`/api/explorer/raw?site=${gb.site.id}&source=octopus_rates`)).rows.map((r) => r.id), [octoRaw]);
  assert.equal((await get(`/api/explorer/raw?site=${gb.site.id}&status=quarantined`)).rows.length, 0);
  const one = await get(`/api/explorer/raw/${octoRaw}?site=${gb.site.id}`);
  assert.equal(one.json_ok, true); assert.equal(one.truncated, false);
  assert.deepEqual(JSON.parse(one.body), { results: [] });
  assert.equal(one.meta.source, 'octopus_rates');
  assert.equal(one.rederive.supported, false);
  assert.match(one.rederive.reason, /no side-effect-free normaliser/);
  assert.equal((await call(`/api/explorer/raw/${octoRaw}?site=${fr.site.id}`)).status, 404);
  assert.equal((await call('/api/explorer/raw/99999')).status, 404);
});

test('rederive: the Tariffscanner normaliser re-run on the stored page equals the stored rows; a tampered row is a diff', async () => {
  const one = await get(`/api/explorer/raw/${tsRaw}`);
  assert.equal(one.site, null);
  assert.ok(one.facts.length > 0 && one.facts.every((f) => f.table === 'rate_interval' && f.metric.startsWith('rate:')));
  assert.equal(one.facts_total, one.facts.length);
  const r = one.rederive;
  assert.equal(r.supported, true); assert.equal(r.ok, true, JSON.stringify(r.diffs));
  assert.equal(r.stored_count, one.facts_total);
  assert.equal(r.rederived_count >= r.stored_count, true);
  assert.deepEqual(r.diffs, []);
  const victim = db.prepare('SELECT id, price_ex_vat FROM rate_interval WHERE raw_id = ? ORDER BY id LIMIT 1').get(tsRaw);
  db.prepare('UPDATE rate_interval SET price_ex_vat = price_ex_vat + 1.5 WHERE id = ?').run(victim.id);
  try {
    const t = (await get(`/api/explorer/raw/${tsRaw}`)).rederive;
    assert.equal(t.ok, false);
    assert.equal(t.diffs.length, 1);
    near(t.diffs[0].stored.value - t.diffs[0].rederived.value, 1.5, 1e-9);
    assert.equal(t.diffs[0].stored.rate_id, victim.id);
  } finally { db.prepare('UPDATE rate_interval SET price_ex_vat = ? WHERE id = ?').run(victim.price_ex_vat, victim.id); }
});

test('series and facts: the home\'s series with counts; points as known at a moment hide later versions', async () => {
  const list = await get(`/api/explorer/series?site=${fr.site.id}`);
  assert.ok(Array.isArray(list) && list.length >= 8);
  for (const s of list) {
    for (const k of ['series_id', 'subject_kind', 'subject_id', 'metric', 'label', 'unit', 'time_role', 'aggregation', 'source', 'first_ts', 'last_ts', 'count', 'superseded_count']) assert.ok(k in s, k);
    assert.equal(s.site, fr.site.id); assert.ok(s.generated_at > 0);
  }
  assert.deepEqual((await get(`/api/explorer/series?site=${fr.site.id}&source=octopus_meter`)).map((s) => s.metric), ['grid_import_kwh']);
  assert.ok((await get(`/api/explorer/series?site=${fr.site.id}&q=soc`)).every((s) => s.metric === 'battery_soc_pct'));
  const solar = list.find((s) => s.metric === 'solar_w');
  // A new version of one reading, recorded after `before`.
  const [d0] = dayBounds(m.FR.tz, m.FR.change);
  const ts = d0 + 12 * 3600;
  const old = db.prepare('SELECT value FROM reading WHERE series_id = ? AND ts = ? AND superseded_at IS NULL').get(solar.series_id, ts).value;
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  putReadings(seriesId('site', fr.site.id, 'solar_w', 'sunsynk_5min'), [{ ts, value: old + 1234 }]);
  const q = `/api/explorer/facts?series=${solar.series_id}&from=${ts}&to=${ts + 300}`;
  const now = await get(q);
  stamp(now, fr.site.id);
  assert.equal(now.series.series_id, solar.series_id); assert.equal(now.table, 'reading');
  assert.deepEqual(now.points.map((p) => p.value), [old + 1234]);
  for (const k of ['ts', 'value', 'quality', 'recorded_at', 'superseded_at', 'raw_id']) assert.ok(k in now.points[0], k);
  assert.equal(now.stats.versions, 1);
  const then = await get(`${q}&as_of_ms=${before}`);
  assert.equal(then.as_of_ms, before);
  assert.deepEqual(then.points.map((p) => p.value), [old]);
  assert.equal(then.stats.n, 1); assert.equal(then.stats.mean, old);
  const both = await get(`${q}&include_superseded=1`);
  assert.deepEqual(both.points.map((p) => p.value).sort((a, b) => a - b), [old, old + 1234].sort((a, b) => a - b));
  assert.equal(both.stats.n, 1, 'stats count the version in force only');
  // Interval facts (the meter) and the latest points without a window.
  const meter = list.find((s) => s.source === 'octopus_meter');
  const mf = await get(`/api/explorer/facts?series=${meter.series_id}&limit=10`);
  assert.equal(mf.table, 'interval_fact'); assert.equal(mf.points.length, 10); assert.equal(mf.truncated, true);
  assert.ok('start_ts' in mf.points[0] && 'end_ts' in mf.points[0]);
  assert.equal(mf.points[9].end_ts, meter.last_ts, 'the latest points');
  assert.equal((await call(`/api/explorer/facts?series=${meter.series_id}&site=${gb.site.id}`)).status, 404);
});

test('timeline: chosen columns with units and kinds, rows and day rows', async () => {
  const t = await get(`/api/explorer/timeline?site=${gb.site.id}&from=${m.GB.change}&to=${m.GB.change}&cols=solar,import_rate,total_cost,soc_end,carbon_intensity,outdoor_temp,rate_found`);
  stamp(t, gb.site.id);
  assert.equal(t.slot_s, 1800); assert.equal(t.currency, 'GBP');
  assert.deepEqual(t.cols.map((c) => [c.name, c.unit, c.kind]), [['solar', 'kWh', 'energy'], ['import_rate', 'minor/kWh', 'price'], ['total_cost', 'minor', 'money'], ['soc_end', '%', 'percent'],
    ['carbon_intensity', 'gCO2/kWh', 'carbon'], ['outdoor_temp', 'degC', 'temp'], ['rate_found', '0/1', 'flag']]);
  assert.equal(t.rows.length, 50);
  const stored = m.hhRows(gb.site.id, m.GB.change, m.GB.change);
  for (const [i, r] of t.rows.entries()) {
    for (const k of ['slot_start', 'local_date', 'tod_min', 'state', 'quality', 'solar', 'import_rate', 'total_cost']) assert.ok(k in r, k);
    near(r.import_rate, m.inc(stored[i]), 1e-12);
  }
  assert.equal(t.days.length, 1); assert.equal(t.days[0].local_date, m.GB.change);
  const d = await get(`/api/explorer/timeline?site=${nl.site.id}&from=${m.NL.from}&to=${m.NL.to}`);
  assert.ok(d.cols.length >= 10); assert.equal(d.rows.length, m.hhRows(nl.site.id, m.NL.from, m.NL.to).length);
  assert.equal((await get(`/api/explorer/timeline?site=${nl.site.id}&from=${m.NL.from}&to=${m.NL.to}&limit=10`)).truncated, true);
});

test('slot: the calculation trace over HTTP', async () => {
  const row = m.hhRows(nl.site.id, m.NL.change, m.NL.change)[50];
  const e = await get(`/api/explorer/slot?site=${nl.site.id}&slot=${row.slot_start}`);
  stamp(e, nl.site.id);
  for (const k of ['slot', 'local_time', 'dur_s', 'state', 'quality', 'row', 'recomputed', 'matches_stored', 'diffs', 'steps', 'flows', 'price', 'lineage']) assert.ok(k in e, k);
  assert.equal(e.matches_stored, true); assert.equal(e.dur_s, 900);
  assert.deepEqual(e.steps.map((s) => s.id), ['inputs', 'align', 'reconcile', 'allocate', 'price', 'check']);
  assert.ok(Array.isArray(e.quality.bits));
  assert.ok(e.price.import && e.price.standing && 'pieces' in e.price.import);
  assert.equal(e.flows.length, 10);
});

test('validate a slot: every check says what it compared; synthetic data pass; a corrupted stored row fails with an explanation', async () => {
  const row = m.hhRows(gb.site.id, m.GB.change, m.GB.change)[20];
  const v = await get(`/api/explorer/validate?site=${gb.site.id}&slot=${row.slot_start}`);
  stamp(v, gb.site.id);
  const ids = new Set(v.checks.map((c) => c.id));
  for (const id of ['stored_vs_rebuild', 'completeness', 'meter_vs_ct', 'balance_slot', 'rate_published', 'rate_used', 'tax_rule', 'standing_share', 'cost_arithmetic', 'carbon_used', 'solar_forecast_record', 'temperature', 'unit_sanity', 'counter_fit_solar', 'balance_day']) {
    assert.ok(ids.has(id) || id.startsWith('counter_fit'), `check ${id}`);
  }
  for (const c of v.checks) {
    for (const k of ['id', 'group', 'title', 'how', 'source_value', 'our_value', 'unit', 'diff', 'tolerance', 'status', 'evidence', 'explanation']) assert.ok(k in c, `${c.id}.${k}`);
    assert.ok(['source', 'consistency', 'price', 'forecast'].includes(c.group), c.group);
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(c.status));
    assert.ok(c.how.length > 10, `${c.id}: says how`);
  }
  assert.equal(v.summary.pass + v.summary.warn + v.summary.fail + v.summary.skip, v.checks.length);
  assert.equal(v.summary.fail, 0, JSON.stringify(v.checks.filter((c) => c.status === 'fail')));
  const byId = (list, id) => list.find((c) => c.id === id);
  assert.equal(byId(v.checks, 'stored_vs_rebuild').status, 'pass');
  assert.equal(byId(v.checks, 'cost_arithmetic').status, 'pass');
  assert.equal(byId(v.checks, 'rate_published').status, 'skip', 'synthetic rate rows have no payload');
  assert.match(byId(v.checks, 'rate_published').explanation, /no payload/);
  // Corrupt the stored row: the rebuild comparison fails and names the column; the cost no longer adds up.
  db.prepare('UPDATE site_hh SET total_cost = total_cost + 3 WHERE site_id = ? AND slot_start = ?').run(gb.site.id, row.slot_start);
  try {
    const bad = await get(`/api/explorer/validate?site=${gb.site.id}&slot=${row.slot_start}`);
    const s = byId(bad.checks, 'stored_vs_rebuild');
    assert.equal(s.status, 'fail');
    assert.match(s.explanation, /total_cost stored .* vs rebuilt/);
    near(s.our_value - s.source_value, 3, 1e-9);
    assert.equal(byId(bad.checks, 'cost_arithmetic').status, 'fail');
    near(byId(bad.checks, 'cost_arithmetic').diff, 3, 1e-9);
    const tr = await get(`/api/explorer/slot?site=${gb.site.id}&slot=${row.slot_start}`);
    assert.equal(tr.matches_stored, false);
    assert.ok(tr.diffs.some((d) => d.field === 'total_cost'));
  } finally { db.prepare('UPDATE site_hh SET total_cost = ? WHERE site_id = ? AND slot_start = ?').run(row.total_cost, gb.site.id, row.slot_start); }
});

test('validate a range: per-slot checks aggregated per day, with the day checks', async () => {
  const v = await get(`/api/explorer/validate?site=${nl.site.id}&from=${m.NL.from}&to=${m.NL.to}`);
  assert.equal(v.from, m.NL.from); assert.equal(v.to, m.NL.to);
  const dates = [...new Set(v.checks.filter((c) => c.date).map((c) => c.date))];
  assert.deepEqual(dates, ['2025-10-25', '2025-10-26', '2025-10-27']);
  const agg = v.checks.find((c) => c.id === 'stored_vs_rebuild' && c.date === m.NL.change);
  assert.equal(agg.slots.pass, 100, 'every quarter-hour of the 25-hour day');
  assert.equal(agg.status, 'pass');
  assert.equal(v.summary.fail, 0, JSON.stringify(v.checks.filter((c) => c.status === 'fail').slice(0, 3)));
  assert.equal((await call(`/api/explorer/validate?site=${nl.site.id}`)).status, 400);
  assert.equal((await call(`/api/explorer/validate?site=${nl.site.id}&from=2025-01-01&to=2025-03-01`)).status, 400);
});

test('correlate: Pearson, Spearman and the fit equal a hand computation; lag, groups; fewer than 8 points is an error, not NaN', async () => {
  // The statistic on a tiny dataset, by hand.
  const xs = [1, 2, 3, 4, 5, 6, 7, 8]; const ys = [2, 4, 5, 4, 5, 7, 8, 9];
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs); const my = mean(ys);
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0); const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0); const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const st = X.stats(xs, ys);
  near(st.pearson, sxy / Math.sqrt(sxx * syy), 1e-12); near(st.r2, (sxy * sxy) / (sxx * syy), 1e-12);
  near(st.slope, sxy / sxx, 1e-12); near(st.intercept, my - (sxy / sxx) * mx, 1e-12);
  // Spearman with ties (4 and 5 repeat): Pearson of the mid-ranks.
  const ry = [1, 2.5, 4.5, 2.5, 4.5, 6, 7, 8];
  const mr = mean(ry); const srr = ry.reduce((s, r) => s + (r - mr) ** 2, 0); const sxr = xs.reduce((s, x, i) => s + (x - mx) * (ry[i] - mr), 0);
  near(st.spearman, sxr / Math.sqrt(sxx * srr), 1e-12);
  // Over HTTP on the stored timeline: grid import against total cost, by slot, for one day.
  const c = await get(`/api/explorer/correlate?site=${gb.site.id}&x=grid_import&y=total_cost&from=${m.GB.from}&to=${m.GB.from}&limit_points=10`);
  stamp(c, gb.site.id);
  const rows = m.hhRows(gb.site.id, m.GB.from, m.GB.from).filter((r) => r.grid_import != null && r.total_cost != null);
  const h = X.stats(rows.map((r) => r.grid_import), rows.map((r) => r.total_cost));
  assert.equal(c.n, rows.length);
  near(c.pearson, h.pearson, 1e-12); near(c.spearman, h.spearman, 1e-12); near(c.slope, h.slope, 1e-12);
  assert.deepEqual(c.x, { name: 'grid_import', unit: 'kWh', label: 'Grid import', kind: 'energy', source: 'timeline' });
  assert.equal(c.points.length, 10); assert.equal(c.points_downsampled, true);
  assert.deepEqual(Object.keys(c.points[0]), ['t', 'x', 'y']);
  // Lag: y one slot after x.
  const lag = await get(`/api/explorer/correlate?site=${gb.site.id}&x=solar&y=solar&lag=1&from=${m.GB.from}&to=${m.GB.from}`);
  const all = m.hhRows(gb.site.id, m.GB.from, m.GB.from);
  const pairs = all.slice(0, -1).map((r, i) => [r.solar, all[i + 1].solar]);
  near(lag.pearson, X.stats(pairs.map((p) => p[0]), pairs.map((p) => p[1])).pearson, 1e-12);
  // A series variable resampled by the planner read layer, by hour, grouped by hour.
  const sid = (await get(`/api/explorer/series?site=${gb.site.id}&source=sunsynk_5min`)).find((s) => s.metric === 'solar_w').series_id;
  const g = await get(`/api/explorer/correlate?site=${gb.site.id}&x=series:${sid}&y=solar&step=hour&group=hour&from=${m.GB.from}&to=${m.GB.to}`);
  assert.ok(g.pearson > 0.99, 'mean solar power and solar energy per hour');
  assert.ok(g.by_group.length >= 20 && g.by_group.every((b) => 'key' in b && 'n' in b && 'pearson' in b));
  const few = await get(`/api/explorer/correlate?site=${gb.site.id}&x=solar&y=home&step=day&from=${m.GB.from}&to=${m.GB.to}`);
  assert.equal(few.n, 3); assert.equal(few.error, 'too few points'); assert.equal('pearson' in few, false);
  assert.equal((await call(`/api/explorer/correlate?site=${gb.site.id}&x=nope&y=solar`)).status, 400);
  assert.equal((await call(`/api/explorer/correlate?site=${gb.site.id}&x=series:99999&y=solar`)).status, 400);
});

test('heatmap and variables', async () => {
  const hm = await get(`/api/explorer/heatmap?site=${nl.site.id}&var=import_rate&from=${m.NL.from}&to=${m.NL.to}`);
  stamp(hm, nl.site.id);
  assert.equal(hm.var, 'import_rate'); assert.equal(hm.unit, 'minor/kWh');
  assert.equal(hm.tod_labels.length, 96); assert.equal(hm.tod_labels[1], '00:15');
  assert.deepEqual(hm.rows.map((r) => r.date), ['2025-10-25', '2025-10-26', '2025-10-27']);
  assert.ok(hm.rows.every((r) => r.cells.length === 96));
  assert.ok(hm.min < 0 && hm.max > hm.min, 'the negative quarter is the minimum');
  const sum = await get(`/api/explorer/heatmap?site=${gb.site.id}&var=solar&agg=sum&from=${m.GB.change}&to=${m.GB.change}`);
  // 01:00-02:00 happens twice on the 25-hour day: its cells add both.
  const rows = m.hhRows(gb.site.id, m.GB.change, m.GB.change).filter((r) => r.tod_min === 60);
  assert.equal(rows.length, 2);
  near(sum.rows[0].cells[2], rows[0].solar + rows[1].solar, 1e-12);
  const v = await get(`/api/explorer/variables?site=${gb.site.id}`);
  stamp(v, gb.site.id);
  assert.ok(v.variables.some((x) => x.name === 'total_cost' && x.source === 'timeline' && x.kind === 'money'));
  assert.ok(v.variables.some((x) => x.name.startsWith('series:') && x.source === 'series' && x.unit === 'W'));
  for (const x of v.variables) for (const k of ['name', 'label', 'unit', 'kind', 'source']) assert.ok(k in x, k);
});

test('bad input is 400 { error }; an unknown home 404', async () => {
  for (const p of ['/api/explorer/overview', '/api/explorer/overview?site=abc', `/api/explorer/raw?site=${gb.site.id}&limit=500`, `/api/explorer/raw?site=${gb.site.id}&source=nope`,
    `/api/explorer/timeline?site=${gb.site.id}&from=2025-13-01`, `/api/explorer/timeline?site=${gb.site.id}&from=2025-10-27&to=2025-10-25`, `/api/explorer/timeline?site=${gb.site.id}&cols=solar,nope`,
    `/api/explorer/slot?site=${gb.site.id}`, `/api/explorer/slot?site=${gb.site.id}&slot=17`, `/api/explorer/facts`, `/api/explorer/facts?series=1&limit=9000`, `/api/explorer/facts?series=1&as_of_ms=1700000000`,
    `/api/explorer/heatmap?site=${gb.site.id}&var=solar&agg=max`, `/api/explorer/correlate?site=${gb.site.id}&x=solar&y=home&step=week`, `/api/explorer/raw/abc`]) {
    const r = await call(p);
    assert.equal(r.status, 400, p);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('/api/explorer/overview?site=9999')).status, 404);
  assert.equal((await call('/api/explorer/facts?series=999999')).status, 404);
});

test('no credential leaves in any answer', () => {
  assert.ok(seen.length > 30);
  for (const text of seen) for (const v of Object.values(SECRETS)) assert.equal(text.includes(v), false, `secret ${v} in an answer`);
  assert.ok(seen.some((t) => t.includes('[redacted]')));
  // Scrubbing by key, in nested bodies and URLs, leaves everything else as it was.
  const n = { count: 0 };
  assert.deepEqual(X.scrub({ token: 'abc', a: [{ password: 'x', ok: 1 }], url: 'https://h/p?apikey=zz&b=2' }, n), { token: '[redacted]', a: [{ password: '[redacted]', ok: 1 }], url: 'https://h/p?apikey=[redacted]&b=2' });
  assert.equal(n.count, 3);
});
