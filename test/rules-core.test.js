// The rules of the core schema (homes, devices, tariffs, regions, groups, plans, commands, facts, limits), broken on purpose and
// refused (fix list D1, plan rule 7): see test/rules/lib.js for how an area proves its rules and declares them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './rules/lib.js';

const { db, run, get, ins, refused, maintained, excluded, checkDeclared } = await harness('core');
const { seriesId } = await import('../src/core/facts.js');
const { erase } = await import('../src/core/erasure.js');

const NOW = 1_800_000_000;   // seconds; a fixed moment keeps every case independent of the clock
const site = (name, cur, country, market) => ins('INSERT INTO site (name, created_at, timezone, currency, country, market_code) VALUES (?, ?, ?, ?, ?, ?)', name, NOW, 'Europe/London', cur, country, market);
const device = (siteId, kind, ref) => ins("INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, ?, 'test', ?)", siteId, kind, ref);
const A = await site('A', 'GBP', 'GB', 'GB');
const B = await site('B', 'EUR', 'NL', 'NL');
const batA = await device(A, 'battery', 'bat-a');
const meterA = await device(A, 'meter_import', 'meter-a');
const batB = await device(B, 'battery', 'bat-b');
const tariff = (code, cur, country) => ins("INSERT INTO tariff (provider, tariff_code, fuel, direction, structure, currency, country) VALUES ('test', ?, 'electricity', 'import', 'flat', ?, ?)", code, cur, country);
const tGbp = await tariff('T-GBP', 'GBP', 'GB');
const tEur = await tariff('T-EUR', 'EUR', 'NL');
const agA = await ins('INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (?, ?, ?, 0, 0)', A, meterA, tGbp);

await test('homes: a new home gets its versions and default bindings; country and currency follow the market', async () => {
  const defaults = (await get('SELECT COUNT(*) AS n FROM binding_default')).n;
  assert.ok(defaults > 0);
  assert.equal((await get('SELECT COUNT(*) AS n FROM binding WHERE site_id = ?', A)).n, defaults); maintained('site_default_bindings');
  assert.equal((await get('SELECT currency FROM site_version WHERE site_id = ? AND superseded_at IS NULL', A)).currency, 'GBP'); maintained('site_version_on_insert');
  await run('UPDATE site SET battery_kwh = 10 WHERE id = ?', A);
  assert.deepEqual((await db.prepare('SELECT battery_kwh, superseded_at IS NULL AS cur FROM site_version WHERE site_id = ? ORDER BY recorded_at').all(A)).map((r) => [r.battery_kwh, r.cur]), [[null, 0], [10, 1]]);
  maintained('site_version_on_update');
  await refused('site_country_matches_market_insert', "INSERT INTO site (name, created_at, country, market_code) VALUES ('x', 0, 'FR', 'GB')");
  await refused('site_country_matches_market_update', "UPDATE site SET country = 'FR' WHERE id = ?", A);
  await refused('site_currency_matches_market_insert', "INSERT INTO site (name, created_at, currency, country, market_code) VALUES ('x', 0, 'EUR', 'GB', 'GB')");
  await refused('site_currency_matches_market_update', "UPDATE site SET currency = 'GBP' WHERE id = ?", B);
  await refused('site_currency_implied_matches_agreements', "UPDATE site SET currency = 'EUR', country = 'NL', market_code = 'NL' WHERE id = ?", A);
});

await test('identity: a home\'s, a device\'s and a connection\'s uid never changes', async () => {
  const conn = await ins("INSERT INTO connection (site_id, provider, external_ref) VALUES (?, 'test', 'c')", A);
  await refused('site_uid_fixed', 'UPDATE site SET uid = uuidv7() WHERE id = ?', A);
  await refused('device_uid_fixed', 'UPDATE device SET uid = uuidv7() WHERE id = ?', batA);
  await refused('connection_uid_fixed', 'UPDATE connection SET uid = uuidv7() WHERE id = ?', conn);
  await run('UPDATE site SET uid = uid, name = ? WHERE id = ?', 'A2', A);   // an update that keeps it is fine
});

await test('devices: a kind and an action must be in the registry', async () => {
  await refused('device_kind_known_insert', "INSERT INTO device (site_id, kind, provider, external_ref) VALUES (?, 'flux_capacitor', 'test', 'x')", A);
  await refused('device_kind_known_update', "UPDATE device SET kind = 'flux_capacitor' WHERE id = ?", batA);
  await run("INSERT INTO device_capability (device_id, action, supported, source, recorded_at) VALUES (?, 'charge', 1, 'adapter', 0)", batA);
  await run("INSERT INTO device_capability (device_id, action, supported, source, recorded_at) VALUES (?, 'export', 0, 'adapter', 0)", batA);
  await refused('device_capability_known_action', "INSERT INTO device_capability (device_id, action, supported, source, recorded_at) VALUES (?, 'teleport', 1, 'adapter', 0)", batA);
  await refused('device_capability_known_action_update', "UPDATE device_capability SET action = 'teleport' WHERE device_id = ? AND action = 'charge'", batA);
});

await test('tariffs: versions are kept; an agreement matches its home in currency and meter; windows and periods never overlap', async () => {
  assert.equal((await get('SELECT COUNT(*) AS n FROM tariff_version WHERE tariff_id = ?', tGbp)).n, 1); maintained('tariff_version_on_insert');
  await run("UPDATE tariff SET region = 'G' WHERE id = ?", tGbp);
  assert.equal((await get('SELECT COUNT(*) AS n FROM tariff_version WHERE tariff_id = ? AND superseded_at IS NULL', tGbp)).n, 1);
  assert.equal((await get('SELECT COUNT(*) AS n FROM tariff_version WHERE tariff_id = ?', tGbp)).n, 2); maintained('tariff_version_on_update');
  await refused('agreement_currency_implied_insert', 'INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (?, ?, ?, 0, 0)', A, meterA, tEur);
  await refused('agreement_currency_implied_update', 'UPDATE tariff_agreement SET tariff_id = ? WHERE id = ?', tEur, agA);
  await refused('agreement_device_same_site_insert', 'INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (?, ?, ?, 0, 0)', B, meterA, tEur);
  await refused('agreement_device_same_site_update', 'UPDATE tariff_agreement SET device_id = ? WHERE id = ?', batB, agA);
  await refused('tariff_currency_implied_matches_agreements', "UPDATE tariff SET currency = 'EUR' WHERE id = ?", tGbp);
  await excluded('agreement_no_overlap', 'INSERT INTO tariff_agreement (site_id, device_id, tariff_id, valid_from, recorded_at) VALUES (?, ?, ?, 100, 0)', A, meterA, tGbp);

  const win = "INSERT INTO register_window (tariff_id, register, start_min, end_min, weekdays, clock, recorded_at) VALUES (?, ?, ?, ?, 127, 'local', 0)";
  await run(win, tGbp, 'night', 0, 420);
  const day = await ins(win, tGbp, 'day', 420, 1440);
  await refused('register_window_no_overlap_insert', win, tGbp, 'peak', 400, 500);
  await refused('register_window_no_overlap_update', 'UPDATE register_window SET start_min = 400 WHERE id = ?', day);

  const rate = "INSERT INTO rate_interval (tariff_id, component, valid_from, price_ex_vat, recorded_at) VALUES (?, 'unit', ?, 20, 0)";
  await run(rate, tGbp, 0);
  await excluded('rate_no_overlap', rate, tGbp, 3600);

  const tax = "INSERT INTO tax_rule (country, code, fuel, direction, applies_to, kind, value, valid_from, source, recorded_at) VALUES ('ZZ', 'vat', 'electricity', 'import', 'all', 'percent', 0.2, ?, 'test', 0)";
  await run(tax, 0);
  const later = await ins("INSERT INTO tax_rule (country, code, fuel, direction, applies_to, kind, value, valid_from, valid_to, source, recorded_at) VALUES ('ZZ', 'vat2', 'electricity', 'import', 'all', 'percent', 0.05, 0, 100, 'test', 0)");
  await refused('tax_rule_no_overlap', tax, 50);
  await refused('tax_rule_no_overlap_update', "UPDATE tax_rule SET code = 'vat' WHERE id = ?", later);
});

await test('regions: a partition scheme is never an alias scheme, either way', async () => {
  await run("INSERT INTO region (scheme, code) VALUES ('gb_dno', '_A') ON CONFLICT DO NOTHING");
  await run("INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '_A', 'my_alias', 'x')");
  await refused('region_scheme_not_an_alias', "INSERT INTO region (scheme, code) VALUES ('my_alias', 'x')");
  await refused('region_alias_not_a_partition', "INSERT INTO region_alias (scheme, code, alias_scheme, alias_code) VALUES ('gb_dno', '_A', 'bzn', 'y')");
  await refused('region_alias_not_a_partition_update', "UPDATE region_alias SET alias_scheme = 'gb_dno' WHERE alias_scheme = 'my_alias'");
});

await test('groups: a home is a current member of a group once at a time', async () => {
  const owner = await ins("INSERT INTO app_user (name, created_at) VALUES ('owner', 0)");
  const g = await ins("INSERT INTO site_group (name, owner_id, timezone, created_at) VALUES ('g', ?, 'Europe/London', 0)", owner);
  const member = 'INSERT INTO site_group_member (group_id, site_id, valid_from, recorded_at) VALUES (?, ?, ?, 0)';
  await run(member, g, A, 0);
  await excluded('member_no_overlap', member, g, A, 100);
});

// Plans and commands
const run0 = "INSERT INTO plan_run (site_id, scenario, created_at, plan_start, slot_s, horizon_h, facts_as_of, method_version, plan_hash, status, error) VALUES (?, 'live', ?, ?, 1800, 24, ?, 'm', ?, ?, ?)";
const PS = NOW - (NOW % 1800);
const runA = await ins(run0, A, NOW, PS, NOW, 'h1', 'ok', null);
const runB = await ins(run0, B, NOW, PS, NOW, 'h1', 'ok', null);

await test('plans: append-only, one current plan per content, devices and slots of the run\'s own home and grid', async () => {
  await refused('plan_run_unchanged', run0, A, NOW, PS, NOW, 'h1', 'ok', null);
  await refused('plan_run_append_only', "UPDATE plan_run SET plan_hash = 'h9' WHERE id = ?", runA);
  await refused('plan_run_append_only', "UPDATE plan_run SET summary = '{}' WHERE id = ?", runA);   // a column added later (the 032 delta) is fixed too
  const failed = await ins(run0, A, NOW, PS, NOW, 'h2', 'error', 'boom');
  await refused('plan_run_status_flow', "UPDATE plan_run SET status = 'superseded', superseded_at = ? WHERE id = ?", NOW, failed);
  await run("INSERT INTO plan_run_device (plan_run_id, device_id, role) VALUES (?, ?, 'controlled')", runA, batA);
  await refused('plan_run_device_same_site', "INSERT INTO plan_run_device (plan_run_id, device_id, role) VALUES (?, ?, 'controlled')", runA, batB);
  const slot = 'INSERT INTO plan_slot (plan_run_id, device_id, slot_start, action, start_offset_min) VALUES (?, ?, ?, ?, ?)';
  await refused('plan_slot_checks', slot, runA, batA, PS + 60, 'charge', null);              // off the slot grid
  await refused('plan_slot_checks', slot, runA, batA, PS + 25 * 3600, 'charge', null);       // beyond the horizon
  await refused('plan_slot_checks', slot, runA, batA, PS, 'charge', 30);                     // offset not inside the slot
  await refused('plan_slot_checks', slot, runA, meterA, PS, 'charge', null);                 // a device the run does not plan
  await refused('plan_slot_checks', slot, runA, batA, PS, 'heat_on', null);                  // not an action of a battery
  await refused('plan_slot_checks', slot, runA, batA, PS, 'export', null);                   // the device says it cannot
  await run(slot, runA, batA, PS, 'charge', 10);
  await refused('plan_slot_append_only', 'UPDATE plan_slot SET start_offset_min = 5 WHERE plan_run_id = ?', runA);
  assert.equal((await get('SELECT COUNT(*) AS n FROM plan_slot')).n, 1);
});

await test('commands: deliverable, of the home\'s own plan, pending first, never late, fixed once made, final states final, an append-only log', async () => {
  const cmd = `INSERT INTO command (plan_run_id, device_id, requested_at, valid_from, valid_until, action, desired, desired_hash, idempotency_key, status, export_start, export_end)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'h', ?, ?, ?, ?)`;
  const ok = (key, over = {}) => { const o = { plan: null, device: batA, req: NOW * 1000, from: NOW, until: NOW + 3600, action: 'charge', status: 'pending', es: null, ee: null, ...over };
    return [o.plan, o.device, o.req, o.from, o.until, o.action, key, o.status, o.es, o.ee]; };
  await refused('command_checks', cmd, ...ok('k1', { action: 'demand' }));                   // no capability row says it can
  await refused('command_checks', cmd, ...ok('k2', { plan: runB }));                          // another home's plan
  await refused('command_checks', cmd, ...ok('k3', { status: 'sent' }));
  await refused('command_checks', cmd, ...ok('k4', { from: NOW - 100, until: NOW - 10 }));    // expired before it was made
  await refused('command_export_window', cmd, ...ok('k5', { es: NOW + 600, ee: NOW + 600 }));
  const c = await ins(cmd, ...ok('k6', { plan: runA }));
  await refused('command_desired_fixed', 'UPDATE command SET rate_w = 5 WHERE id = ?', c);
  await refused('command_desired_fixed', 'UPDATE command SET export_start = ? WHERE id = ?', NOW + 60, c);   // a column added later (the 032 delta) is fixed too
  await refused('command_never_late', "UPDATE command SET status = 'sent', sent_at = ? WHERE id = ?", (NOW + 3601) * 1000, c);
  await run("UPDATE command SET status = 'cancelled' WHERE id = ?", c);
  await refused('command_status_flow', "UPDATE command SET status = 'sent', sent_at = ? WHERE id = ?", NOW * 1000, c);
  const log = await ins("INSERT INTO command_log (command_id, at, event) VALUES (?, ?, 'enqueued')", c, NOW * 1000);
  await refused('command_log_no_update', "UPDATE command_log SET event = 'sent' WHERE id = ?", log);
  await refused('command_log_no_delete', 'DELETE FROM command_log WHERE id = ?', log);
});

await test('facts: a series remembers its longest fact, so a read can bound its range; it never shrinks', async () => {
  for (const [table, metric, source] of [['interval_fact', 'grid_import_kwh', 'octopus_meter'], ['forecast_fact', 'solar_kwh', 'quartz']]) {
    const s = await seriesId('site', A, metric, source);
    const put = table === 'interval_fact'
      ? (a, b) => run('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, recorded_at) VALUES (?, ?, ?, 1, 0)', s, a, b)
      : (a, b) => run('INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, recorded_at) VALUES (?, ?, ?, 0, 1, 0)', s, a, b);
    const span = async () => (await get('SELECT max_span_s FROM series WHERE id = ?', s)).max_span_s;
    await put(0, 1800); assert.equal(await span(), 1800);
    await put(3600, 3900); assert.equal(await span(), 1800, 'a shorter fact does not shrink it');
    maintained(`${table}_span_insert`);
    // Facts are append-only: a fact's period changes only inside a logged erasure.
    await erase({ kind: 'synthetic', reason: 'rules test: a fact span widened' }, async () => await run(`UPDATE ${table} SET end_ts = 7200 WHERE series_id = ? AND start_ts = 3600`, s));
    assert.equal(await span(), 3600); maintained(`${table}_span_update`);
  }
});

await test('limits: a lower source can only tighten a higher one', async () => {
  const lim = 'INSERT INTO control_limit (device_id, action, param, min_value, max_value, source, valid_from, recorded_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)';
  await run(lim, batA, null, 'rate_w', null, 3600, 'legal');
  await run(lim, batA, 'charge', 'rate_w', null, 3000, 'owner');                             // tighter: fine
  await refused('control_limit_ranked', lim, batA, 'charge', 'rate_w', null, 5000, 'owner');  // looser than the legal one
  const opt = await ins(lim, batA, null, 'rate_w', 100, 2000, 'optimiser');
  await refused('control_limit_ranked', 'UPDATE control_limit SET max_value = 4000 WHERE id = ?', opt);
});

await test('homes on rows: a series takes its subject\'s home, a fact its series\' home; another home is refused', async () => {
  const sA = await seriesId('device', batA, 'battery_soc_pct', 'sunsynk_5min');
  const { metric_id: m, source_id: so } = await get('SELECT metric_id, source_id FROM series WHERE id = ?', sA);
  assert.equal((await get('SELECT site_id FROM series WHERE id = ?', sA)).site_id, A);
  const { point_id: pt } = await get('SELECT point_id FROM series WHERE id = ?', sA);
  await refused('series_home', 'INSERT INTO series (point_id, metric_id, source_id, site_id) VALUES (?, ?, ?, ?)', pt, m, so, B);
  await refused('series_home', 'UPDATE series SET site_id = ? WHERE id = ?', B, sA);
  await refused('reading_home', 'INSERT INTO reading (series_id, ts, value, recorded_at, site_id) VALUES (?, 0, 1, 0, ?)', sA, B);
  await refused('interval_fact_home', 'INSERT INTO interval_fact (series_id, start_ts, end_ts, value, recorded_at, site_id) VALUES (?, 0, 1800, 1, 0, ?)', sA, B);
  await refused('forecast_fact_home', 'INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, recorded_at, site_id) VALUES (?, 0, 1800, 0, 1, 0, ?)', sA, B);
  await run('INSERT INTO reading (series_id, ts, value, recorded_at) VALUES (?, 0, 1, 0)', sA);
  assert.equal((await get('SELECT site_id FROM reading WHERE series_id = ?', sA)).site_id, A, 'set on insert');
});

await test('facts and raw receipts are append-only: superseded once, never changed or deleted, except in a logged erasure', async () => {
  const sR = await seriesId('site', A, 'solar_w', 'sunsynk_5min');
  await run('INSERT INTO reading (series_id, ts, value, recorded_at) VALUES (?, 100, 1, 0)', sR);
  await refused('reading_append_only', 'UPDATE reading SET value = 2 WHERE series_id = ? AND ts = 100', sR);
  await refused('reading_append_only', 'DELETE FROM reading WHERE series_id = ? AND ts = 100', sR);
  await run('UPDATE reading SET superseded_at = 5 WHERE series_id = ? AND ts = 100', sR);                    // superseding once is how a fact changes
  await refused('reading_append_only', 'UPDATE reading SET superseded_at = 6 WHERE series_id = ? AND ts = 100', sR);
  const sI = await seriesId('site', A, 'grid_import_kwh', 'octopus_meter');
  await run('INSERT INTO interval_fact (series_id, start_ts, end_ts, value, recorded_at) VALUES (?, 9000, 10800, 1, 0)', sI);
  await refused('interval_fact_append_only', 'UPDATE interval_fact SET value = 2 WHERE series_id = ? AND start_ts = 9000', sI);
  await refused('interval_fact_append_only', 'DELETE FROM interval_fact WHERE series_id = ? AND start_ts = 9000', sI);
  const sF = await seriesId('site', A, 'solar_kwh', 'quartz');
  await run('INSERT INTO forecast_fact (series_id, start_ts, end_ts, issued_at, value, recorded_at) VALUES (?, 9000, 10800, 1, 1, 0)', sF);
  await refused('forecast_fact_append_only', 'UPDATE forecast_fact SET value = 2 WHERE series_id = ? AND start_ts = 9000', sF);
  const raw = await ins("INSERT INTO raw_payload (source_id, site_id, fetched_at, hash, file) VALUES ((SELECT id FROM source WHERE code = 'sunsynk_5min'), ?, 0, 'h-rules', 'raw/x.json')", A);
  await refused('raw_payload_append_only', 'UPDATE raw_payload SET file = ? WHERE id = ?', 'raw/y.json', raw);
  await refused('raw_payload_append_only', 'DELETE FROM raw_payload WHERE id = ?', raw);
  // Inside an erasure they go, and the erasure is logged with what it removed.
  const out = await erase({ kind: 'synthetic', siteId: A, reason: 'rules test' }, async () => ({ removed: {
    raw_payload: (await run('DELETE FROM raw_payload WHERE id = ?', raw)).changes,
    reading: (await run('DELETE FROM reading WHERE series_id = ? AND ts = 100', sR)).changes } }));
  assert.deepEqual(out.removed, { raw_payload: 1, reading: 1 });
  const log = await get("SELECT kind, site_id, removed, finished_at FROM erasure_log WHERE reason = 'rules test'");
  assert.deepEqual([log.kind, log.site_id, JSON.parse(log.removed).reading, log.finished_at > 0], ['synthetic', A, 1, true]);
  await run('INSERT INTO reading (series_id, ts, value, recorded_at) VALUES (?, 200, 1, 0)', sR);
  await refused('reading_append_only', 'DELETE FROM reading WHERE series_id = ?', sR);                   // the erasure is closed again
});

await test('what the cases above proved is what test/rules/core.json declares (test/rules-all.test.js checks every area against the database)', () => { checkDeclared(); });
