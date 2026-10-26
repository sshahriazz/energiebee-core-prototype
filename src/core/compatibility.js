// GET /api/compatibility: HOW and WHY the database is compatible with Predbat and PredHeat, checked live.
//
// Built from the files of plan item B11, read from disk:
//   docs/coverage-matrix.json               every catalogue item (481) with its status and targets
//   docs/predbat-predheat-requirements.md   the catalogue: each item's sources (Src column, section 1.2
//                                           URLs) and the section 1.4 conflicts
//   docs/predbat-predheat-coverage.md       the generated report: the schema's choice for each conflict
//   docs/database.md                        the documented keys of JSON columns
// and every target is checked to exist in the RUNNING database at request time, with the same check as
// test/coverage-matrix.test.js (src/core/coverage.js): a column by PRAGMA table_info, a registry key,
// metric, source, device action or view by its row, a read function by the module's exports. The
// result is cached for 60 s (CACHE_MS).
//
// Holds no credential and no home's data: the check reads the schema and the registry tables only
// (attribute_def, setting_def, device_kind, metric, source, device_action, sqlite_master), never a
// site, a reading, a connection or the environment. Nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as plannerRead from './planner-read.js';
import * as plans from './plans.js';
import * as commands from './commands.js';
import { targetChecker, documentedJsonKeys } from './coverage.js';

const root = path.resolve(import.meta.dirname, '..', '..');
export const FILES = Object.freeze({
  matrix: 'docs/coverage-matrix.json',
  catalogue: 'docs/predbat-predheat-requirements.md',
  report: 'docs/predbat-predheat-coverage.md',
  gaps: 'docs/coverage-gaps.md',
  database: 'docs/database.md',
});
export const CACHE_MS = 60_000;

// The matrix's read_function targets name planner-read exports only (test/coverage-matrix.test.js);
// the "how they read" list also names the plan and command helpers, so it may use all three.
const MATRIX_READ_MODULES = { 'planner-read': plannerRead };
export const READ_MODULES = Object.freeze({ 'planner-read': plannerRead, plans, commands });
export const READ_MODULE_FILES = Object.freeze({ 'planner-read': 'src/core/planner-read.js', plans: 'src/core/plans.js', commands: 'src/core/commands.js' });

export const PRODUCTS = Object.freeze([
  { id: 'predbat', label: 'Predbat', note: 'the battery planner (catalogue section 2, PB-* ids)' },
  { id: 'predheat', label: 'PredHeat', note: 'the heating predictor (catalogue section 3, PH-* ids)' },
  { id: 'planning_design', label: 'Planning design', note: 'fields of the planning documents with no Predbat source (catalogue Appendix A, PD-* ids)' },
]);
export const productOf = (id) => (id.startsWith('PB-') ? 'predbat' : id.startsWith('PH-') ? 'predheat' : 'planning_design');

// The catalogue's groups in plain words (its section names; PB-OTHER holds the PB-OTH-* ids, PB-PLAN-OUT the PB-PLAN-* ids).
export const GROUP_LABELS = Object.freeze({
  'PB-INV': 'Inverter and battery: set-up, live sensors, derived values',
  'PB-CAP': 'What each inverter type can be told to do',
  'PB-RATE': 'Energy prices, events and car dispatches',
  'PB-PV': 'Solar generation and forecast',
  'PB-LOAD': 'House use: history, prediction and scaling',
  'PB-CAR': 'Electric cars',
  'PB-OTHER': 'Other planner settings: immersion heater, battery value, keep level, weights',
  'PB-PLAN-OUT': 'The plan and its predictions',
  'PB-CTRL': 'Commands to devices, read-back and write limits',
  'PB-DIAG': 'Status, logs and prediction history',
  'PH-CFG': 'PredHeat set-up',
  'PH-SEN': 'Heating sensors',
  'PH-WX': 'Weather forecast',
  'PH-MOD': 'The house and heating model',
  'PH-RATE': 'Heating energy price',
  'PH-STATE': 'What PredHeat carries between runs',
  'PH-OUT': 'PredHeat predictions',
  'PH-LINK': 'Links between PredHeat and Predbat',
  'PH-CTRL': 'PredHeat control',
  'PH-DIAG': 'PredHeat status',
  'PD (Appendix A)': 'Planning-design fields with no Predbat source',
});

// The definition of "100 %" in one plain paragraph; the exact one is the matrix's `definition`.
export const PLAIN_DEFINITION = 'An item counts as covered when every piece of data it names has a place in the database: a column, a registry row, a metric, a device action, a view, or a read function that works it out from stored facts. Items that are not data (Home Assistant wiring, screen layout, fixed code rules, archived keys) are excluded, each with its reason. 100 % means every verified Predbat and PredHeat item that is data is covered. Unverified items are counted apart.';
export const LIMIT_SENTENCE = 'This covers storing and reading the data. The planner itself, device adapters and real heating data are not built.';

// The ways Predbat and PredHeat read (or produce) data, where each lives here, and why that fits.
// Every `where` entry is a target like the matrix's and is checked live; `read_function` is checked
// against the module's exports; `items` are catalogue ids (test/compatibility.test.js checks both).
export const HOW_IT_CONSUMES = Object.freeze([
  {
    id: 'daily_counters', title: 'Daily running totals', products: ['predbat'],
    what_they_read: 'Today\'s running totals: house use, grid import, grid export and solar generated, each a counter that resets at midnight.',
    their_names: ['load_today', 'import_today', 'export_today', 'pv_today'],
    where: [['metric', 'metric:load_kwh'], ['metric', 'metric:grid_import_kwh'], ['metric', 'metric:grid_export_kwh'], ['metric', 'metric:solar_kwh'],
      ['table_column', 'reading.value'], ['table_column', 'reading.ts'], ['source', 'source:sunsynk_5min'], ['source', 'source:sunsynk_daily']],
    read_function: 'planner-read.counterDifferenceSeries',
    items: ['PB-LOAD-01', 'PB-LOAD-02', 'PB-LOAD-03', 'PB-PV-01'],
    why_compatible: 'We keep the inverter\'s 5-minute power readings and its daily totals, and the read function turns them back into the same running counter, reset at each local midnight, including the 23- and 25-hour days when the clocks change.',
  },
  {
    id: 'rates', title: 'Prices for each slot', products: ['predbat', 'predheat'],
    what_they_read: 'The import and export price of every slot of the plan (a list of rates per half-hour on a GB tariff), the standing charge, and the gas price PredHeat uses.',
    their_names: ['metric_octopus_import', 'metric_octopus_export', 'metric_octopus_gas', 'metric_standing_charge', 'rate_gas'],
    where: [['table_column', 'rate_interval.price_ex_vat'], ['table_column', 'rate_interval.valid_from'], ['table_column', 'rate_interval.valid_to'], ['table_column', 'rate_interval.component'],
      ['table_column', 'tariff.direction'], ['table_column', 'tariff_agreement.tariff_id'], ['table_column', 'tax_rule.value'], ['source', 'source:octopus_rates']],
    read_function: 'planner-read.rates',
    items: ['PB-RATE-03', 'PB-RATE-04', 'PB-RATE-05', 'PB-RATE-07', 'PB-RATE-09', 'PH-RATE-01'],
    why_compatible: 'Each price is stored once per tariff with the time it is valid and its taxes as dated rules, and the read function lays the prices, tax included, onto any slot length (15, 30 or 60 minutes) exactly as the timeline prices a slot.',
  },
  {
    id: 'solar_forecast', title: 'Solar forecast and its cases', products: ['predbat'],
    what_they_read: 'The solar forecast for each slot of the next 48 hours: a central case plus a pessimistic (p10), median (p50) and optimistic (p90) case.',
    their_names: ['pv_forecast_today', 'pv_forecast_tomorrow', 'detailedForecast (pv_estimate10 / 50 / 90)'],
    where: [['metric', 'metric:solar_kwh'], ['metric', 'metric:solar_kwh_p10'], ['metric', 'metric:solar_kwh_p50'], ['metric', 'metric:solar_kwh_p90'],
      ['table_column', 'forecast_fact.value'], ['table_column', 'forecast_fact.issued_at'], ['table_column', 'forecast_fact.recorded_at'], ['source', 'source:quartz'], ['source', 'source:core_solar_cases']],
    read_function: 'planner-read.forecast',
    items: ['PB-PV-02', 'PB-PV-10', 'PB-PV-17'],
    why_compatible: 'Every forecast issue is kept with the time it was issued and the time we stored it, each case is its own metric, and the read function returns the issue that was current at any moment, so a plan can be re-run on the forecast it actually had.',
  },
  {
    id: 'load_history', title: 'Load history', products: ['predbat', 'predheat'],
    what_they_read: 'The house\'s use on previous days (how many days back and how much each counts), to predict today\'s use.',
    their_names: ['days_previous', 'days_previous_weight', 'predheat.days_previous'],
    where: [['registry_key', 'setting_def:days_previous'], ['registry_key', 'setting_def:days_previous_weight'], ['registry_key', 'setting_def:predheat_days_previous'],
      ['metric', 'metric:load_kwh'], ['metric', 'metric:load_w'], ['table_column', 'reading.value'], ['table_column', 'site_hh.home']],
    read_function: 'planner-read.loadHistory',
    items: ['PB-LOAD-09', 'PB-LOAD-10', 'PB-LOAD-08', 'PH-CFG-05'],
    why_compatible: 'Past use is kept as timestamped facts and on the timeline, and the read function lines each previous day up on the local clock so 17:00 matches 17:00, then predictLoad takes the same weighted mean over days_previous that Predbat does.',
  },
  {
    id: 'live_sensors', title: 'Live sensor values', products: ['predbat'],
    what_they_read: 'The latest live values: battery charge level, battery power, solar power, house load, grid power and battery temperature.',
    their_names: ['soc_kw', 'soc_percent', 'battery_power', 'pv_power', 'load_power', 'grid_power', 'battery_temperature'],
    where: [['metric', 'metric:battery_soc_pct'], ['metric', 'metric:battery_charge_w'], ['metric', 'metric:battery_discharge_w'], ['metric', 'metric:solar_w'], ['metric', 'metric:load_w'],
      ['metric', 'metric:grid_import_w'], ['metric', 'metric:grid_export_w'], ['metric', 'metric:battery_temperature_c'], ['table_column', 'reading.ts'], ['source', 'source:sunsynk_live']],
    read_function: 'planner-read.state',
    items: ['PB-INV-49', 'PB-INV-50', 'PB-INV-51', 'PB-INV-52', 'PB-INV-53', 'PB-INV-54', 'PB-INV-55'],
    why_compatible: 'Every reading is a timestamped fact per device and metric, and the read function returns the latest of each with its age and in Predbat\'s signs (battery positive when discharging, grid negative when importing), while freshness() flags any that is too old to plan on.',
  },
  {
    id: 'temperatures', title: 'Temperatures', products: ['predheat'],
    what_they_read: 'Outside and inside temperature history, the thermostat set-point, and the outdoor temperature forecast.',
    their_names: ['predheat.external_temperature', 'predheat.internal_temperature', 'predheat.target_temperature', 'predheat.weather'],
    where: [['metric', 'metric:outdoor_temp_c'], ['metric', 'metric:indoor_temp_c'], ['metric', 'metric:indoor_temp_setpoint_c'], ['table_column', 'reading.value'],
      ['table_column', 'forecast_fact.issued_at'], ['source', 'source:open_meteo'], ['source', 'source:heating_telemetry']],
    read_function: 'planner-read.series',
    items: ['PH-SEN-01', 'PH-SEN-02', 'PH-SEN-03', 'PH-WX-01'],
    why_compatible: 'Temperatures are stored like any other metric, history as readings and the weather forecast as dated issues, and the read function resamples them to 5-minute steps, averaging several inside sensors as PredHeat does.',
  },
  {
    id: 'configuration', title: 'Settings and installation figures', products: ['predbat', 'predheat'],
    what_they_read: 'Their settings and the home\'s installation figures: battery size and losses, reserve, the planner mode, weights, and the house\'s heat loss.',
    their_names: ['input_number.predbat_*', 'switch.predbat_*', 'select.predbat_mode', 'apps.yaml keys', 'predheat.heat_loss_watts'],
    where: [['table_column', 'setting_def.default_value'], ['table_column', 'site_setting.value'], ['table_column', 'attribute_value.value'], ['table_column', 'attribute_value.source'],
      ['registry_key', 'setting_def:mode'], ['registry_key', 'setting_def:battery_loss'], ['registry_key', 'attribute_def:usable_kwh'], ['registry_key', 'attribute_def:heat_loss_w_per_k']],
    read_function: 'planner-read.state',
    items: ['PB-INV-21', 'PB-INV-26', 'PB-OTH-22', 'PB-CTRL-01', 'PH-MOD-01', 'PH-CFG-02'],
    why_compatible: 'Each Predbat or PredHeat setting is one registry row with its unit, range and default, each home\'s value is kept with its history, and the read function returns the settings and figures as they stood at the moment of the plan.',
  },
  {
    id: 'time_grid', title: 'The time grid', products: ['predbat', 'predheat'],
    what_they_read: 'The planning frame: 5-minute steps inside slots of the plan\'s length, starting at the current slot, over a 48-hour horizon.',
    their_names: ['plan_interval_minutes', 'forecast_hours', 'minutes_now'],
    where: [['table_column', 'site.slot_s'], ['table_column', 'site.timezone'], ['table_column', 'plan_run.step_s'], ['table_column', 'plan_run.slot_s'], ['table_column', 'plan_run.horizon_h'],
      ['registry_key', 'setting_def:forecast_hours']],
    read_function: 'planner-read.window',
    items: ['PB-PLAN-04', 'PB-RATE-01', 'PB-OTH-61'],
    why_compatible: 'Our slots are keyed by their start time in UTC with each home\'s own length, and the read function gives the plan start, the minutes already gone and the 5-minute steps for any horizon, clock changes included.',
  },
  {
    id: 'plan_outputs', title: 'The plan', products: ['predbat', 'predheat'],
    what_they_read: 'The plan they publish: the action for each slot (charge, export, freeze, hold), its limits, the predicted battery level, cost and, for heating, inside temperature.',
    their_names: ['predbat.plan_html rows', 'export limit tuple', 'predheat.internal_temp'],
    where: [['table_column', 'plan_run.plan_start'], ['table_column', 'plan_run.summary'], ['table_column', 'plan_slot.action'], ['table_column', 'plan_slot.charge_limit_pct'],
      ['table_column', 'plan_slot.export_limit_pct'], ['table_column', 'plan_slot.power_fraction'], ['table_column', 'plan_slot.soc_end_kwh'], ['table_column', 'plan_slot.cost_minor'],
      ['table_column', 'plan_slot.indoor_temp_c_end'], ['view', 'view:v_current_plan'], ['view', 'view:v_plan_window']],
    read_function: 'plans.currentPlan',
    items: ['PB-PLAN-05', 'PB-PLAN-06', 'PB-PLAN-07', 'PB-PLAN-08', 'PB-PLAN-09', 'PH-OUT-01'],
    why_compatible: 'A plan has its own table with one row per device and slot, holding Predbat\'s actions, limits and predictions (and PredHeat\'s temperatures), and views give the plan in force and its merged windows; nothing writes a plan yet.',
  },
  {
    id: 'commands', title: 'Commands and read-back', products: ['predbat'],
    what_they_read: 'What they tell a device to do (charge window, target level, mode) and what the device reports back, with a count of writes and failures.',
    their_names: ['adjust_charge_window', 'adjust_battery_target', 'predbat.inverter_register_writes', 'predbat.control_failures'],
    where: [['table_column', 'command.desired'], ['table_column', 'command.status'], ['table_column', 'command.valid_until'], ['table_column', 'command.reported'], ['table_column', 'command.readback_raw_id'],
      ['table_column', 'command_log.event'], ['device_action', 'device_action:inverter.charge'], ['device_action', 'device_action:battery.freeze_export']],
    read_function: 'commands.lastAcked',
    items: ['PB-CTRL-03', 'PB-CTRL-04', 'PB-CTRL-17', 'PB-CTRL-19', 'PB-INV-59', 'PD-07'],
    why_compatible: 'Each instruction is a command with an expiry, stored only when it differs from what the device last confirmed and marked done only when the read-back matches, with every step in a log that cannot be changed; no adapter sends commands yet.',
  },
]);

export const WHAT_IS_NOT_BUILT = Object.freeze([
  { what: 'The planner', detail: 'Nothing simulates or optimises a battery or heating plan yet: there is no simulator, no optimiser and no window merge. The plan tables exist and stay empty until one is built.' },
  { what: 'Device adapters for control', detail: 'No adapter sends a command to an inverter, car charger or heat pump, or reads one back. The command tables and device actions exist; nothing writes to them on its own.' },
  { what: 'Real heating data', detail: 'No heating adapter exists. The only indoor temperature, heat-pump and boiler readings so far are synthetic test data. The outdoor temperature from Open-Meteo is real.' },
  { what: 'Machine-learning load forecast', detail: 'Predbat\'s learned load model is not built. The weighted mean of previous days (predictLoad) is; a learned model\'s files would be a cache rebuilt from the stored history.' },
  { what: 'Pessimistic and optimistic solar cases in normal running', detail: 'The p10, p50 and p90 cases have their place and a function that derives them from the home\'s own history, but the sync does not call it yet, and there is no Solcast adapter. The central forecast comes from the Quartz adapter (GB homes whose panel size, tilt and direction are known).' },
  { what: 'Filled tables', detail: 'Covered means the data has a place that exists, not that anything fills it today. Vendor entity names (Home Assistant entities, MQTT topics) were not catalogued and are kept as wiring, not typed columns.' },
]);

// Catalogue section 1.4 conflicts -> the catalogue items they touch (their notes in the matrix say so).
export const CONFLICT_ITEMS = Object.freeze({ 1: ['PH-MOD-09'], 2: ['PH-CFG-02', 'PH-MOD-10'], 3: ['PH-SEN-07'], 4: ['PB-PLAN-09'], 5: ['PB-PLAN-08'], 6: ['PB-OTH-66'], 7: ['PB-OTH-43'] });

// PB-CAP rows have no Src column: the section says "Src CFG INVERTER_DEF + IS §Inverter control options".
export const CAP_SOURCE = 'CFG INVERTER_DEF + IS §Inverter control options';

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const unbold = (s) => String(s ?? '').replace(/\*\*/g, '').trim();

/** Section 1.2 of the catalogue: Map code -> { code, label, url } (only rows with a public https URL). */
export function sourceCodes(catalogueText) {
  const map = new Map();
  for (const m of catalogueText.matchAll(/^\| ([A-Z0-9]+) \| ([^|]+) \| <(https:\/\/[^>\s]+)> \|$/gm)) {
    map.set(m[1], { code: m[1], label: m[2].replace(/`/g, '').trim(), url: m[3] });
  }
  return map;
}

/** Each catalogue item's source text (its Src column), in catalogue order: Map id -> { source, order }. */
export function catalogueSources(catalogueText) {
  const out = new Map();
  let header = null;
  for (const line of catalogueText.split('\n')) {
    if (!line.startsWith('|')) { header = null; continue; }
    const c = cells(line);
    if (c[0] === 'ID') { header = c; continue; }
    if (!header || !/^(PB|PH|PD)-[A-Z]*-?\d+$/.test(c[0])) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, c[i] ?? '']));
    const source = 'Flag' in row ? CAP_SOURCE : (row.Src ?? row['PD source'] ?? '');
    out.set(c[0], { source: source.replace(/`/g, ''), order: out.size });
  }
  return out;
}

/** The public sources a Src text names (codes of section 1.2), in the order named, once each. */
export function sourceLinks(srcText, codes) {
  const seen = new Set();
  const out = [];
  for (const part of String(srcText ?? '').split(/[;,+]/)) {
    const code = part.trim().split(/[\s§]/)[0];
    if (codes.has(code) && !seen.has(code)) { seen.add(code); out.push(codes.get(code)); }
  }
  return out;
}

/** Catalogue section 1.4 (what the sources say) joined with the report's table (what the schema chose). */
export function conflicts(catalogueText, reportText) {
  const start = catalogueText.indexOf('### 1.4');
  const section = start < 0 ? '' : catalogueText.slice(start, catalogueText.indexOf('\n---', start) > 0 ? catalogueText.indexOf('\n---', start) : undefined);
  const found = [...section.matchAll(/^(\d+)\. \*\*([^*]+)\*\*:? ?(.*)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2].replace(/[.:]$/, '').trim(), catalogue_text: unbold(m[3]) }));
  const rStart = reportText.indexOf('## Catalogue conflicts');
  const rSection = rStart < 0 ? '' : reportText.slice(rStart, reportText.indexOf('\n## ', rStart + 5) > 0 ? reportText.indexOf('\n## ', rStart + 5) : undefined);
  const choices = new Map([...rSection.matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => [Number(m[1]), { conflict: unbold(m[2]), schema_choice: unbold(m[3]) }]));
  return found.map((c) => ({ ...c, conflict: choices.get(c.n)?.conflict ?? null, schema_choice: choices.get(c.n)?.schema_choice ?? null, items: CONFLICT_ITEMS[c.n] ?? [] }));
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

function readDocs() {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return { matrix: JSON.parse(read(FILES.matrix)), catalogueText: read(FILES.catalogue), reportText: read(FILES.report), databaseMd: read(FILES.database) };
}

/**
 * The /api/compatibility payload, its live check run now against `db`. Inputs default to the files on
 * disk; a test passes its own (a matrix with a target that does not exist, to see the red state).
 */
export function buildCompatibility(db, { now = Date.now(), ...given } = {}) {
  const docs = { ...(given.matrix && given.catalogueText && given.reportText && given.databaseMd ? {} : readDocs()), ...given };
  const { matrix, catalogueText, reportText, databaseMd } = docs;
  const jsonKeys = documentedJsonKeys(databaseMd);
  const existsMatrix = targetChecker(db, { readModules: given.readModules ?? MATRIX_READ_MODULES, jsonKeys });
  const existsHow = targetChecker(db, { readModules: READ_MODULES, jsonKeys });
  const codes = sourceCodes(catalogueText);
  const srcOf = catalogueSources(catalogueText);
  const conflictList = conflicts(catalogueText, reportText);
  const conflictOf = new Map(conflictList.flatMap((c) => c.items.map((id) => [id, c.n])));

  // Every item, its targets checked now.
  let targetsChecked = 0;
  const missing = [];
  const items = matrix.items.map((it) => {
    const src = srcOf.get(it.id);
    const links = sourceLinks(src?.source, codes);
    const targets = (it.targets ?? []).map((t) => {
      const ok = existsMatrix(t);
      targetsChecked++;
      if (!ok) missing.push({ item: it.id, kind: t.kind, ref: t.ref, ...(t.json_key ? { json_key: t.json_key } : {}) });
      return { kind: t.kind, ref: t.ref, ...(t.json_key ? { json_key: t.json_key } : {}), exists: ok };
    });
    const found = targets.filter((t) => t.exists).length;
    return {
      id: it.id, name: it.name, group: it.group, product: productOf(it.id), direction: it.direction ?? [], status: it.status,
      // covered and every target found now / covered but a target is missing now / not covered.
      live: it.status !== 'covered' ? null : found === targets.length ? 'found' : 'target_missing',
      verified: !!it.verified, catalogue_status: it.catalogue_status ?? null,
      // source: the catalogue's Src text; source_url: the first public source it names; source_codes: all
      // it names (their labels and URLs in the top-level source_codes).
      source: src?.source || null, source_url: links[0]?.url ?? null, source_codes: links.map((l) => l.code),
      targets, targets_found: found, targets_missing: targets.length - found,
      ...(it.status === 'excluded_not_data' ? { reason: it.reason } : {}),
      ...(it.status === 'gap' ? { gap: it.gap } : {}),
      note: it.note ?? null,
      conflict: conflictOf.get(it.id) ?? null,
    };
  });
  // In the catalogue's own order (PB-INV first, Appendix A last), as a reader of the catalogue meets them.
  const pos = (i) => srcOf.get(i.id)?.order ?? 1e9;
  items.sort((a, b) => pos(a) - pos(b) || a.id.localeCompare(b.id));

  const isData = (i) => i.status !== 'excluded_not_data';
  const count = (list) => {
    const data = list.filter(isData);
    const coveredNow = list.filter((i) => i.live === 'found').length;
    return {
      items: list.length, data_items: data.length, covered: list.filter((i) => i.status === 'covered').length, covered_found: coveredNow,
      excluded: list.length - data.length, gaps: list.filter((i) => i.status === 'gap').length,
      target_missing: list.filter((i) => i.live === 'target_missing').length,
      percent_covered: pct(coveredNow, data.length),
    };
  };
  // "Verified" carries the catalogue's own flag, for Predbat and PredHeat items (PD-* are unverified by definition).
  const verified = items.filter((i) => i.verified && i.product !== 'planning_design');
  const unverified = items.filter((i) => !(i.verified && i.product !== 'planning_design'));
  const all = count(items);
  const v = count(verified);
  const u = count(unverified);
  const summary = {
    items: all.items, data_items: all.data_items, covered: all.covered, excluded: all.excluded, gaps: all.gaps,
    covered_found: all.covered_found, target_missing: all.target_missing,
    verified_items: v.items, verified_data_items: v.data_items, verified_covered: v.covered_found,
    unverified_items: u.items, unverified_data_items: u.data_items, unverified_covered: u.covered_found,
    percent_verified_covered: pct(v.covered_found, v.data_items),
    percent_covered: all.percent_covered,
  };

  // Groups in catalogue order, each with its product and counts.
  const order = [];
  for (const i of items) if (!order.includes(i.group)) order.push(i.group);
  const groups = order.map((g) => {
    const list = items.filter((i) => i.group === g);
    return { id: g, label: GROUP_LABELS[g] ?? g, product: list[0].product, ...count(list) };
  });
  const products = PRODUCTS.map((p) => ({ ...p, ...count(items.filter((i) => i.product === p.id)) }));

  // How they read: every place and read function checked now too.
  let howChecked = 0;
  const howMissing = [];
  const how = HOW_IT_CONSUMES.map((h) => {
    const where = h.where.map(([kind, ref]) => {
      const ok = existsHow({ kind, ref });
      howChecked++;
      if (!ok) howMissing.push({ entry: h.id, title: h.title, kind, ref });
      return { kind, ref, exists: ok };
    });
    const [mod] = h.read_function.split('.');
    const fnOk = existsHow({ kind: 'read_function', ref: h.read_function });
    howChecked++;
    if (!fnOk) howMissing.push({ entry: h.id, title: h.title, kind: 'read_function', ref: h.read_function });
    return {
      id: h.id, title: h.title, products: h.products, what_they_read: h.what_they_read, their_names: h.their_names,
      where_it_lives_in_our_db: where,
      read_function: { ref: h.read_function, file: READ_MODULE_FILES[mod] ?? null, exists: fnOk },
      why_compatible: h.why_compatible,
      items: h.items.map((id) => ({ id, name: items.find((i) => i.id === id)?.name ?? null })),
    };
  });

  const catalogueSha = crypto.createHash('sha256').update(catalogueText).digest('hex');
  const at = new Date(now).toISOString();
  return {
    generated_at: at,
    live_check: {
      checked_at: at, cache_s: CACHE_MS / 1000,
      database: 'the running database (schema and registry tables only)',
      targets_checked: targetsChecked, targets_found: targetsChecked - missing.length, targets_missing: missing.length, missing,
      how_targets_checked: howChecked, how_targets_missing: howMissing.length, how_missing: howMissing,
      catalogue_matches_matrix: catalogueSha === matrix.catalogue_sha256,
      ok: !missing.length && !howMissing.length && catalogueSha === matrix.catalogue_sha256,
      method: 'Each target is looked up in the running database: a column by PRAGMA table_info, a registry key, metric, source, device action or view by its row, a read function by the exports of its module, a JSON key by its list in docs/database.md. The same check runs in test/coverage-matrix.test.js on a fresh database.',
    },
    headline: {
      question: 'Is our database ready for Predbat and PredHeat?',
      limit: LIMIT_SENTENCE,
    },
    definition: matrix.definition,
    definition_plain: PLAIN_DEFINITION,
    summary,
    products,
    groups,
    items,
    how_it_consumes: how,
    excluded: items.filter((i) => i.status === 'excluded_not_data').map((i) => ({ id: i.id, name: i.name, product: i.product, reason: i.reason, note: i.note })),
    conflicts: conflictList,
    conflict_notes: items.filter((i) => !i.conflict && /conflict/i.test(i.note ?? '')).map((i) => ({ id: i.id, name: i.name, note: i.note })),
    unverified: unverified.map((i) => ({ id: i.id, name: i.name, status: i.status, live: i.live, catalogue_status: i.catalogue_status, note: i.note, reason: i.reason ?? null })),
    what_is_not_built: WHAT_IS_NOT_BUILT,
    source_codes: Object.fromEntries([...codes.values()].map((c) => [c.code, { label: c.label, url: c.url }])),
    files: { ...FILES },
    tests: { coverage_test: 'test/coverage-matrix.test.js', compatibility_test: 'test/compatibility.test.js' },
  };
}

// The payload is rebuilt (and every target re-checked) at most once per CACHE_MS.
let cached = null;
export function compatibility(db, { now = Date.now() } = {}) {
  if (!cached || cached.db !== db || now - cached.at >= CACHE_MS || now < cached.at) cached = { db, at: now, value: buildCompatibility(db, { now }) };
  return cached.value;
}
export const clearCompatibilityCache = () => { cached = null; };
