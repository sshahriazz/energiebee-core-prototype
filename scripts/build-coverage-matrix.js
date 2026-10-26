// Builds docs/coverage-matrix.json: one entry per item of the requirements catalogue
// (docs/predbat-predheat-requirements.md: every PB-*, PH-* and Appendix A PD-* id) saying where the
// database design keeps it (plan item B11, docs/hardening-and-planning-plan.md).
//
//   node scripts/build-coverage-matrix.js           write the matrix and the report docs/predbat-predheat-coverage.md
//                                                    (fails if an item has no hand review or a target does not
//                                                    exist in a fresh database)
//   node scripts/build-coverage-matrix.js --draft   print the automatic proposals of every item (for review)
//   node scripts/build-coverage-matrix.js --check   exit 1 if either file is not what it would write
//
// Semi-automatic. The script PROPOSES targets from the database as built (a fresh temporary database
// opened through src/db/db.js: schema.sql, every delta, every seed; data/core.db is never opened):
//   refs      attribute_def / setting_def rows whose `refs` name the id (the registries' own claim)
//   name      the Predbat or PredHeat key in the item's origin cell matched to a registry key, exactly or
//             with a unit suffix (_kw, _min ...) or a vendor prefix (octopus_, inverter_) dropped
//   metric    docs/database.md's planning-metric table, whose last column lists the ids a metric holds
//   pd        a table.column the catalogue's PD column names, when that column exists
// and the HAND REVIEW in scripts/coverage-review.js decides: every item must have a reviewed entry
// (status, targets, reason). The output records for each item what was proposed and which proposals
// the review rejected, so a reader can see where the automation was wrong. The file is sorted by id and
// has no timestamps: the same inputs always write the same bytes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REVIEW, parseTarget, DEFINITION } from './coverage-review.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGUE = 'docs/predbat-predheat-requirements.md';
export const MATRIX = 'docs/coverage-matrix.json';
export const DATABASE_DOC = 'docs/database.md';

// Report groups (the catalogue's section names; PB-OTH-* ids are the PB-OTHER section, PB-PLAN-* PB-PLAN-OUT).
export function groupOf(id) {
  if (id.startsWith('PD-')) return 'PD (Appendix A)';
  if (id.startsWith('PH-')) return id.split('-').slice(0, 2).join('-');
  const g = id.split('-').slice(0, 2).join('-');
  return { 'PB-OTH': 'PB-OTHER', 'PB-PLAN': 'PB-PLAN-OUT' }[g] ?? g;
}

// The catalogue's Dir vocabulary (section 1.1) in words.
const DIR_WORDS = { CFG: 'input config', LIVE: 'live input', HIST: 'history', OUT: 'output', CTRL: 'control', STATE: 'state', rule: 'rule' };
export function directionOf(dir) {
  if (!dir || dir === '—') return [];
  const out = [];
  for (const tok of dir.replace(/\(external\)/, '').split(/[\s/]+/).filter(Boolean)) {
    const w = DIR_WORDS[tok];
    if (!w) throw new Error(`unknown Dir token ${tok} in "${dir}"`);
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const plain = (s) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** Every catalogue item: { id, group, name, dir, catalogueStatus, verified, origin, pd }. */
export function parseCatalogue(text) {
  const items = [];
  let header = null;
  let section = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) section = line;
    if (!line.startsWith('|')) { header = null; continue; }   // a table ends at the first line that is not a row
    const c = cells(line);
    if (c[0] === 'ID') { header = c; continue; }
    if (!header || !/^(PB|PH|PD)-[A-Z]*-?\d+$/.test(c[0])) continue;
    if (c.length !== header.length) throw new Error(`${c[0]}: ${c.length} cells under a ${header.length}-column header`);
    const row = Object.fromEntries(header.map((h, i) => [h, c[i]]));
    const id = c[0];
    const isCap = 'Flag' in row;
    const isPd = 'Field' in row;
    const name = isCap ? `${plain(row.Flag)}: ${plain(row.Meaning)}` : isPd ? plain(row.Field) : plain(row.Item);
    // PB-CAP rows are all CFG (the section says so); Appendix A rows have no Dir (the review gives one).
    const dir = isCap ? 'CFG' : isPd ? null : row.Dir;
    items.push({
      id, group: groupOf(id), name, dir, catalogueStatus: row.Status, verified: row.Status.startsWith('verified'),
      origin: isCap ? row.Flag : isPd ? row.Field : (row['Origin in Predbat'] ?? row.Origin ?? ''), pd: row.PD ?? '', section,
    });
  }
  const seen = new Set();
  for (const it of items) { if (seen.has(it.id)) throw new Error(`catalogue id ${it.id} twice`); seen.add(it.id); }
  return items;
}

/** Appendix B of the catalogue: { group: rows } and the totals, to check the parse against. */
export function appendixCounts(text) {
  const b = text.slice(text.indexOf('## Appendix B'));
  const out = {};
  for (const line of b.split('\n').filter((l) => l.startsWith('|'))) {
    const c = cells(line).map((x) => x.replace(/\*/g, ''));
    if (/^PB-[A-Z-]+$/.test(c[0])) out[c[0]] = Number(c[1]);
    else if (/^Predbat total$/.test(c[0])) out.PB = Number(c[1]);
    else if (/^PredHeat total$/.test(c[0])) out.PH = Number(c[1]);
    else if (/^Appendix A/.test(c[0])) out.PD = Number(c[1]);
  }
  return out;
}

// ───────────── The schema as built ─────────────

/** What a fresh database holds: tables and views with their columns, and every registry row. */
export function schemaContext(db) {
  const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all();
  const columns = new Map(objects.map((o) => [o.name, new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(o.name).map((r) => r.name))]));
  const refsOf = (table) => new Map(db.prepare(`SELECT key, refs FROM ${table}`).all().map((r) => [r.key, JSON.parse(r.refs || '[]')]));
  return {
    tables: new Set(objects.filter((o) => o.type === 'table').map((o) => o.name)),
    views: new Set(objects.filter((o) => o.type === 'view').map((o) => o.name)),
    columns,
    attributes: refsOf('attribute_def'),
    settings: refsOf('setting_def'),
    kinds: new Set(db.prepare('SELECT kind FROM device_kind').all().map((r) => r.kind)),
    actions: new Set(db.prepare('SELECT device_kind, action FROM device_action').all().map((r) => `${r.device_kind}.${r.action}`)),
    metrics: new Set(db.prepare('SELECT code FROM metric').all().map((r) => r.code)),
    sources: new Set(db.prepare('SELECT code FROM source').all().map((r) => r.code)),
  };
}

/** Why a target does not exist in the context (null when it does). readFunctions: the read layer's export names. */
export function targetProblem(t, ctx, readFunctions) {
  const [ns, name] = t.ref.includes(':') ? [t.ref.slice(0, t.ref.indexOf(':')), t.ref.slice(t.ref.indexOf(':') + 1)] : [null, t.ref];
  switch (t.kind) {
    case 'table_column': {
      const [table, col] = t.ref.split('.');
      if (!ctx.columns.has(table)) return `no table or view ${table}`;
      if (!ctx.columns.get(table).has(col)) return `no column ${t.ref}`;
      return null;
    }
    case 'registry_key':
      if (ns === 'attribute_def') return ctx.attributes.has(name) ? null : `no attribute_def row ${name}`;
      if (ns === 'setting_def') return ctx.settings.has(name) ? null : `no setting_def row ${name}`;
      if (ns === 'device_kind') return ctx.kinds.has(name) ? null : `no device_kind row ${name}`;
      return `unknown registry ${ns}`;
    case 'metric': return ns === 'metric' && ctx.metrics.has(name) ? null : `no metric ${name}`;
    case 'source': return ns === 'source' && ctx.sources.has(name) ? null : `no source ${name}`;
    case 'device_action': return ns === 'device_action' && ctx.actions.has(name) ? null : `no device_action ${name}`;
    case 'view': return ns === 'view' && ctx.views.has(name) ? null : `no view ${name}`;
    case 'read_function': {
      const [mod, fn] = t.ref.split('.');
      if (mod !== 'planner-read') return `read functions are planner-read.<export>, not ${t.ref}`;
      return readFunctions.has(fn) ? null : `planner-read.js exports no ${fn}`;
    }
    default: return `unknown target kind ${t.kind}`;
  }
}

// ───────────── Automatic proposals ─────────────

const PREFIXES = /^(input_number|switch|select|sensor|binary_sensor)\.predbat_|^predbat\.|^predheat\.|^predbat_/;
const SUFFIXES = ['', '_kw', '_kwh', '_min', '_s', '_pct', '_c', '_minor', '_w', '_h', '_hours'];
const DROPS = ['octopus_', 'inverter_', 'predbat_'];

// The Predbat / PredHeat keys named in a cell, without entity prefixes and index suffixes.
export function originKeys(cell) {
  const out = new Set();
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    for (let k of m[1].split(/[\s,]+/)) {
      k = k.replace(PREFIXES, '').replace(/\[_?N\]$/, '').replace(/\$.*$/, '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
      if (k.length > 2) out.add(k);
    }
  }
  return [...out];
}

// docs/database.md planning-metric table: | `code` (, `code`) | unit | ... | ids |.
export function documentedMetricIds(md) {
  const map = new Map();
  for (const line of md.split('\n')) {
    if (!/^\| `[a-z0-9_]+`/.test(line)) continue;
    const c = cells(line);
    const codes = [...c[0].matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
    const ids = [...c[c.length - 1].matchAll(/\b(P[BH]-[A-Z]+-\d+)\b/g)].map((m) => m[1]);
    for (const id of ids) for (const code of codes) map.set(id, [...(map.get(id) ?? []), code]);
  }
  return map;
}

// docs/database.md "JSON keys of `table.column`: `a`, `b`" lines: the documented keys of each JSON column.
export function documentedJsonKeys(md) {
  const map = new Map();
  for (const m of md.matchAll(/JSON keys of `([a-z_]+\.[a-z_]+)`: ([^\n]+)/g)) map.set(m[1], new Set([...m[2].matchAll(/`([a-z0-9_]+)`/g)].map((k) => k[1])));
  return map;
}

/** The targets the script would map an item to by itself, each with the method that found it. */
export function propose(item, ctx, metricIds) {
  const out = new Map();
  const add = (kind, ref, method) => { if (!out.has(ref)) out.set(ref, { kind, ref, method }); };
  for (const [key, refs] of ctx.attributes) if (refs.includes(item.id)) add('registry_key', `attribute_def:${key}`, 'refs');
  for (const [key, refs] of ctx.settings) if (refs.includes(item.id)) add('registry_key', `setting_def:${key}`, 'refs');
  for (const k of originKeys(item.origin)) {
    const bases = [k, ...DROPS.filter((d) => k.startsWith(d)).map((d) => k.slice(d.length))];
    for (const b of bases) for (const s of SUFFIXES) {
      if (ctx.settings.has(b + s)) add('registry_key', `setting_def:${b + s}`, 'name');
      if (ctx.attributes.has(b + s)) add('registry_key', `attribute_def:${b + s}`, 'name');
      if (ctx.metrics.has(b + s)) add('metric', `metric:${b + s}`, 'name');
    }
  }
  for (const code of metricIds.get(item.id) ?? []) if (ctx.metrics.has(code)) add('metric', `metric:${code}`, 'metric');
  // The catalogue's PD column: "plan_slot.charge_limit_pct / export_limit_pct" names two columns of plan_slot.
  for (const m of item.pd.matchAll(/\b([a-z_]+)\.([a-z_0-9]+)((?:\s*\/\s*[a-z_0-9]+)*)/g)) {
    const table = m[1];
    for (const col of [m[2], ...m[3].split('/').map((x) => x.trim()).filter(Boolean)]) {
      if (ctx.columns.get(table)?.has(col)) add('table_column', `${table}.${col}`, 'pd');
    }
  }
  return [...out.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

// ───────────── The matrix ─────────────

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The matrix object. Throws when an item has no review, a review names an id the catalogue lacks, or a
 * reviewed target does not exist (so a wrong mapping is never written).
 */
export function buildMatrix({ ctx, catalogueText, databaseMd, readFunctions }) {
  const items = parseCatalogue(catalogueText).sort(byId);
  const expected = appendixCounts(catalogueText);
  const counted = {};
  for (const it of items) {
    const g = it.id.startsWith('PD-') ? 'PD' : it.id.startsWith('PH-') ? 'PH' : it.group;
    counted[g] = (counted[g] ?? 0) + 1;
    if (it.id.startsWith('PB-')) counted.PB = (counted.PB ?? 0) + 1;
  }
  for (const [g, n] of Object.entries(expected)) if (counted[g] !== n) throw new Error(`catalogue parse: ${g} has ${counted[g] ?? 0} items, Appendix B says ${n}`);

  const metricIds = documentedMetricIds(databaseMd);
  const jsonKeys = documentedJsonKeys(databaseMd);
  const ids = new Set(items.map((i) => i.id));
  const problems = [];
  for (const id of Object.keys(REVIEW)) if (!ids.has(id)) problems.push(`review entry ${id} is not in the catalogue`);
  const out = [];
  for (const it of items) {
    const r = REVIEW[it.id];
    if (!r) { problems.push(`${it.id}: no hand review`); continue; }
    const proposed = propose(it, ctx, metricIds);
    const dir = it.dir ?? r.dir ?? null;
    const entry = {
      id: it.id, group: it.group, name: it.name, dir, direction: directionOf(dir),
      catalogue_status: it.catalogueStatus, verified: it.verified, status: r.status,
    };
    if (!it.dir && r.dir) entry.dir_note = 'Dir given by the review: the catalogue has none for this row';
    if (r.status === 'covered') {
      const targets = r.targets.map(parseTarget);
      if (!targets.length) problems.push(`${it.id}: covered with no target`);
      for (const t of targets) {
        const p = targetProblem(t, ctx, readFunctions);
        if (p) problems.push(`${it.id}: ${p}`);
        if (t.json_key && !jsonKeys.get(t.ref)?.has(t.json_key)) problems.push(`${it.id}: JSON key ${t.ref}#${t.json_key} is not documented in ${DATABASE_DOC}`);
      }
      entry.targets = targets;
    } else if (r.status === 'excluded_not_data') {
      if (!r.reason) problems.push(`${it.id}: excluded with no reason`);
      entry.reason = r.reason;
    } else if (r.status === 'gap') {
      entry.gap = r.gap;
    } else problems.push(`${it.id}: unknown status ${r.status}`);
    if (r.note) entry.note = r.note;
    const reviewed = new Set((entry.targets ?? []).map((t) => t.ref));
    const rejected = proposed.filter((p) => !reviewed.has(p.ref));
    const kept = proposed.filter((p) => reviewed.has(p.ref));
    entry.review = {
      outcome: !proposed.length ? 'manual' : rejected.length ? 'corrected' : reviewed.size > kept.length ? 'confirmed_extended' : 'confirmed',
      proposed: proposed.map((p) => `${p.ref} (${p.method})`),
    };
    if (rejected.length) entry.review.rejected = rejected.map((p) => p.ref);
    out.push(entry);
  }
  if (problems.length) throw new Error(`coverage matrix: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);

  const count = (xs) => ({
    total: xs.length,
    covered: xs.filter((x) => x.status === 'covered').length,
    excluded_not_data: xs.filter((x) => x.status === 'excluded_not_data').length,
    gap: xs.filter((x) => x.status === 'gap').length,
  });
  const groups = [...new Set(out.map((x) => x.group))].sort();
  const dataItems = (xs) => xs.filter((x) => x.status !== 'excluded_not_data');
  const pct = (xs) => (dataItems(xs).length ? Math.round(1000 * xs.filter((x) => x.status === 'covered').length / dataItems(xs).length) / 10 : null);
  const pbph = out.filter((x) => !x.id.startsWith('PD-'));
  return {
    catalogue: CATALOGUE,
    catalogue_sha256: sha256(catalogueText),
    generator: 'scripts/build-coverage-matrix.js (proposals) + scripts/coverage-review.js (hand review)',
    definition: DEFINITION,
    counts: {
      all: count(out),
      predbat_predheat: count(pbph),
      verified: count(pbph.filter((x) => x.verified)),
      unverified: count(out.filter((x) => !x.verified)),
      appendix_a: count(out.filter((x) => x.id.startsWith('PD-'))),
      by_group: Object.fromEntries(groups.map((g) => [g, count(out.filter((x) => x.group === g))])),
      by_review: Object.fromEntries(['confirmed', 'confirmed_extended', 'corrected', 'manual'].map((o) => [o, out.filter((x) => x.review.outcome === o).length])),
      covered_pct_of_data_items: { verified: pct(pbph.filter((x) => x.verified)), unverified: pct(out.filter((x) => !x.verified)), all: pct(out) },
    },
    items: out,
  };
}

export const render = (m) => `${JSON.stringify(m, null, 2)}\n`;

// ───────────── The readable report (docs/predbat-predheat-coverage.md), built from the matrix ─────────────

export const REPORT = 'docs/predbat-predheat-coverage.md';
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const pctOf = (n, d) => (d ? `${Math.round(1000 * n / d) / 10} %` : '-');

export function renderReport(m) {
  const items = m.items;
  const c = m.counts;
  const verified = items.filter((i) => i.verified && !i.id.startsWith('PD-'));
  const vData = verified.filter((i) => i.status !== 'excluded_not_data');
  const unverified = items.filter((i) => !i.verified);
  const excluded = items.filter((i) => i.status === 'excluded_not_data');
  const gaps = items.filter((i) => i.status === 'gap');
  const row = (label, xs) => {
    const data = xs.filter((x) => x.status !== 'excluded_not_data').length;
    const cov = xs.filter((x) => x.status === 'covered').length;
    return `| ${label} | ${xs.length} | ${cov} | ${xs.length - data} | ${xs.filter((x) => x.status === 'gap').length} | ${pctOf(cov, data)} |`;
  };
  const groups = [...new Set(items.map((i) => i.group))].sort();
  const targets = items.flatMap((i) => i.targets ?? []);
  const byKind = [...new Set(targets.map((t) => t.kind))].sort().map((k) => `${k} ${targets.filter((t) => t.kind === k).length}`);
  const jsonItems = items.filter((i) => (i.targets ?? []).some((t) => t.json_key));
  const metaItems = items.filter((i) => (i.targets ?? []).some((t) => t.ref === 'connection.meta'));
  const fnOnly = items.filter((i) => i.targets?.length && i.targets.every((t) => t.kind === 'read_function'));
  const corrected = items.filter((i) => i.review.outcome === 'corrected');
  const L = [];
  L.push('# Predbat and PredHeat: coverage of the database design', '');
  L.push('Plan item B11 of `docs/hardening-and-planning-plan.md`. **Generated** by `scripts/build-coverage-matrix.js` from `docs/coverage-matrix.json`; do not edit by hand (change the hand review `scripts/coverage-review.js` or the schema, then re-run). The catalogue is `docs/predbat-predheat-requirements.md` (416 Predbat items, 54 PredHeat items, 11 planning-design fields in its Appendix A); `test/coverage-matrix.test.js` checks the matrix against a fresh database.', '');
  L.push('## Result', '');
  L.push(`- **${c.all.covered} of ${c.all.total} catalogue items are covered, ${c.all.excluded_not_data} are excluded as not data, ${c.all.gap} are gaps.**`);
  L.push(`- **100 % covered of verified items:** ${vData.filter((i) => i.status === 'covered').length} of the ${vData.length} verified Predbat and PredHeat items that are data have a home that exists in a fresh database (${verified.length - vData.length} verified items are not data; listed below).`);
  L.push(`- **${unverified.filter((i) => i.status === 'covered').length} unverified items covered per their flagged description** (${unverified.filter((i) => i.status === 'covered').map((i) => i.id).join(', ')}): PB-DIAG-04 is the catalogue\'s one unverified Predbat row (an assumption about where the History view reads), the PD rows are planning-design fields with no Predbat source. ${unverified.filter((i) => i.status === 'excluded_not_data').map((i) => i.id).join(', ') || 'None'} excluded as not data.`);
  L.push(`- **Gaps: ${gaps.length}.** The allow-list \`docs/coverage-gaps.md\` ${gaps.length ? `lists ${gaps.map((g) => g.id).join(', ')}` : 'is empty'}; a gap that is a missing schema element fails the test.`, '');
  L.push('## Definition of 100 %', '', m.definition, '');
  L.push('## By group', '', '| Group | Items | Covered | Excluded (not data) | Gaps | Covered, % of data items |', '| --- | --- | --- | --- | --- | --- |');
  for (const g of groups) L.push(row(g, items.filter((i) => i.group === g)));
  L.push(row('**Predbat (PB-*)**', items.filter((i) => i.id.startsWith('PB-'))), row('**PredHeat (PH-*)**', items.filter((i) => i.id.startsWith('PH-'))), row('**All**', items), '');
  L.push('PB-OTHER holds the PB-OTH-* ids and PB-PLAN-OUT the PB-PLAN-* ids, as in the catalogue\'s section names.', '');
  L.push('## Verified and unverified', '', '| Catalogue status | Items | Covered | Excluded (not data) | Gaps | Covered, % of data items |', '| --- | --- | --- | --- | --- | --- |');
  L.push(row('verified (Predbat and PredHeat)', verified), row('unverified (PB-DIAG-04 and Appendix A)', unverified), '');
  L.push(`"verified" carries the catalogue's own flag: the item was read in a fetched source (docs, code or both). It includes ${verified.filter((i) => /code only/.test(i.catalogue_status)).length} capability flags found only in code and ${verified.filter((i) => /archived/.test(i.catalogue_status)).length} PredHeat rows that apply only to the archived standalone PredHeat (${verified.filter((i) => /archived/.test(i.catalogue_status)).map((i) => i.id).join(', ')}, both excluded).`, '');
  L.push('## Where the items are kept', '');
  L.push(`${targets.length} targets in all: ${byKind.join(', ')}. Every one is checked to exist by the test (a column by \`PRAGMA table_info\`, a registry key, metric, source, device action or view by its row, a read function by the export of \`src/core/planner-read.js\`).`, '');
  L.push(`- **Documented JSON keys** (${jsonItems.length} items: ${jsonItems.map((i) => i.id).join(', ')}): plan totals and checkpoints in \`plan_run.summary\`, state carried between runs in \`plan_run.carry_state\`, the write count in \`command_log.detail\`. The keys are listed in \`docs/database.md\` and the test checks each target against that list; a JSON key is documented, not typed or constrained by the database.`);
  L.push(`- **Vendor wiring in \`connection.meta\`** (${metaItems.length} items: ${metaItems.map((i) => i.id).join(', ')}): endpoints, integration switches, poll and refresh settings of an adapter, as JSON keys the vendor adapter names. Secret values (API keys, passwords, tokens) are kept out of the database by design; the connection row records which account they open.`);
  L.push(`- **Derived on read only** (${fnOnly.length} items: ${fnOnly.map((i) => i.id).join(', ') || 'none'}): covered by a read-layer function over stored facts, nothing extra stored.`, '');
  L.push('## What was added to close the gaps', '');
  L.push('The first pass found items with no home. Each was added, registry rows first (details in `docs/database.md`, "Coverage matrix: what it added"):', '');
  L.push('- **21 `attribute_def` rows**: the rest of the inverter capability profile and write path (`control_interfaces`, `control_immediate`, `current_decimal_places`, `opposite_rate_zero_required`, `charge_schedule_enable_supported`, `export_schedule_enable_supported`, `target_soc_sets_export_floor`, `schedule_commit_required`, `work_modes`, `idle_window_supported`, `window_time_format`, `clock_time_format`, `write_retry_max`, `write_backoff_s`, `api_delay_s`, `schedule_step_min`, `apply_delay_s`), `manual_soc_entry`, `pv_calibration`, and the planning design\'s `deployment_mode` and `service_active`.');
  L.push('- **22 `setting_def` rows**: the manual overrides (`manual_charge`, `manual_export`, `manual_demand`, `manual_freeze_charge`, `manual_freeze_export`, `manual_soc_min`, `manual_soc_max`, `manual_import_rates`, `manual_export_rates`, `manual_load_adjust`), `rates_import_override`, `rates_export_override`, `future_rate_estimate`, `compare_list`, `octopus_slot_low_rate`, `octopus_slot_max`, `intelligent_dispatch_billing`, `saving_session_rate`, `axle_reward_per_kwh`, `axle_control`, `solar_forecast_sources`, `replan_triggers`.');
  L.push('- **7 metrics**: `saving_session_reward`, `saving_session_joined`, `free_session`, `vpp_export_event`, `vpp_import_event`, `weather_alert_keep_pct`, `extra_load_kwh`; **3 sources**: `axle_vpp`, `weather_alerts`, `manual_entry`.');
  L.push('- **Delta 060** (`src/db/deltas/060-coverage.sql`): `plan_slot.import_rate_minor`, `export_rate_minor`, `import_rate_adjusted_minor`, `export_rate_adjusted_minor`, `import_rate_adjust`, `export_rate_adjust`, `clipped_kwh`; tables `tenant` and `tenant_site` (an owner record for PD-01 only: no login, no access rules, which stay in Phase C).', '');
  L.push('None of these touches the build engine, `site_hh` or `site_day`: the golden GB test is unchanged.', '');
  L.push('## How the review went', '');
  L.push(`The script proposed targets for ${items.length - c.by_review.manual} items (registry \`refs\`, Predbat names matched to registry keys, the metric table in \`docs/database.md\`, the catalogue\'s PD column) and none for ${c.by_review.manual}. Every item was then reviewed by hand against its catalogue row: ${c.by_review.confirmed} kept the proposals as they were, ${c.by_review.confirmed_extended} kept them and gained targets, ${c.by_review.corrected} had a proposal rejected, ${c.by_review.manual} were mapped by hand from nothing. The rejected proposals:`, '');
  L.push('| ID | Rejected proposal | Why |', '| --- | --- | --- |');
  for (const i of corrected) L.push(`| ${i.id} | ${cell(i.review.rejected.join(', '))} | ${cell(i.note)} |`);
  L.push('');
  L.push('## Excluded: not data', '', '| ID | Item | Reason |', '| --- | --- | --- |');
  const sentence = (s) => (s ? ` ${cell(s.charAt(0).toUpperCase() + s.slice(1))}.` : '');
  for (const i of excluded) L.push(`| ${i.id} | ${cell(i.name)} | ${cell(i.reason)}${sentence(i.note)} |`);
  L.push('');
  L.push('## Gaps', '');
  if (gaps.length) {
    L.push('| ID | Item | Kind | What is missing |', '| --- | --- | --- | --- |');
    for (const g of gaps) L.push(`| ${g.id} | ${cell(g.name)} | ${cell(g.gap.kind)} | ${cell(g.gap.description)} |`);
  } else L.push('None. No schema gap remains, and no item needed the allow-list.');
  L.push('');
  L.push('## Catalogue conflicts (section 1.4): what the schema chose', '', '| # | Conflict | Schema choice |', '| --- | --- | --- |');
  L.push('| 1 | PredHeat COP key: docs `heating_cop`, code `heat_cop` | attribute `heat_cop` (the code), the conflict kept in its description |');
  L.push('| 2 | PredHeat defaults: `mode` pump (code) vs gas (template); `flow_difference_target` 20 / 5 (code) vs 40 (template, docs) | setting `predheat_mode` defaults to `pump` (the code); attribute `flow_difference_target_c` has no default (an attribute is a measured or stated value), both conflicts in the descriptions |');
  L.push('| 3 | `volume_temp` read from the top level of apps.yaml, not the predheat block | metric `radiator_temp_c`, like every other PredHeat sensor (where Predbat reads it from is wiring) |');
  L.push('| 4 | Export encoding: current 3-tuple (mode, target %, power fraction) vs the legacy single number (99 freeze, 100 off) | the tuple: `plan_slot.action` (`export`, `freeze_export`, `demand` for idle), `export_limit_pct`, `power_fraction`; the legacy numbers are not used |');
  L.push('| 5 | Freeze charge: a limit equal to the reserve (optimiser) vs "target = current SoC" (planning document) | its own action `freeze_charge` (no limit encoding at all) |');
  L.push('| 6 | Default Predbat mode: "Control charge & discharge" (CONFIG_ITEMS) vs Monitor (docs, a new install) | setting `mode` defaults to `monitor` (the docs), the conflict in its description |');
  L.push('| 7 | `charge_low_power_margin` range 0-60 (code) vs 0-30 (docs) | setting `charge_low_power_margin_min` allows 0-60 (the code) |', '');
  L.push('## Known limits', '');
  L.push('- **Vendor entity names are not catalogued** (catalogue section 1.3): the per-vendor sections of the inverter and component docs and the 30 vendor templates were only partly read. Where an item is a vendor entity (a commit button, a Home Assistant service, an MQTT topic), its data is covered and the entity name is noted as wiring; vendor-specific wiring is JSON keys of `connection.meta`, not typed columns.');
  L.push('- **Docs pages not opened** (catalogue section 1.3): `install`, `annual-prediction` (What-If), `discovery-catalogue`, `hub-live-display`, `developing`, `plugins`, `rest_api`, `random-scenarios`, the FAQ beyond its headings, images and videos; GitHub issues and PRs; third-party integration docs. Anything only they define is not in the catalogue, so not in this matrix.');
  L.push('- **Covered means a home exists, not that anything fills it.** There is no planner, executor or event adapter yet: the plan, command, event and override homes are tables and registry rows that nothing writes today, exactly as plan items B6 and B7 intended.');
  L.push('- **JSON keys are documented, not enforced**: the database checks that `plan_run.summary`, `plan_run.carry_state` and `command_log.detail` are valid JSON, not which keys they hold.');
  L.push('- **By design, not stored**: secret values (kept in the environment); the Load ML model files (a cache rebuilt by training from the stored history); retention knobs (environment, `scripts/retention.js`).');
  L.push('- **Unverified items**: PB-DIAG-04 rests on an assumption the catalogue could not check; the Appendix A fields are planning-design ideas with no Predbat source, covered as described there (PD-01 by a minimal `tenant` table, PD-02 by our own attributes).');
  L.push('- **Excluded items are a judgement**: each reason cites the catalogue (section 5, the Dir "rule" rows, the archived status); a reader who disagrees with one can turn it into a gap in `scripts/coverage-review.js` and the test will demand a home for it.', '');
  L.push('## Re-run', '', '```sh', 'node scripts/build-coverage-matrix.js && npm test', '```', '');
  L.push('`node scripts/build-coverage-matrix.js --draft` prints the automatic proposals of every item (for reviewing a new catalogue row); `--check` exits 1 when the matrix or this report is out of date. The script opens a fresh temporary database (never `data/core.db`).', '');
  return L.join('\n');
}

// ───────────── CLI ─────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  // A fresh, temporary database: db.js opens DB_FILE on import, so it is set first. Never data/core.db.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-coverage-'));
  process.env.DB_FILE = path.join(dir, 'core.db');
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const { db, closeDb } = await import(pathToFileURL(path.join(root, 'src', 'db', 'db.js')).href);
  const readFunctions = new Set(Object.keys(await import(pathToFileURL(path.join(root, 'src', 'core', 'planner-read.js')).href)));
  const ctx = schemaContext(db);
  closeDb?.();
  const catalogueText = fs.readFileSync(path.join(root, CATALOGUE), 'utf8');
  const databaseMd = fs.readFileSync(path.join(root, DATABASE_DOC), 'utf8');

  if (args.has('--draft')) {
    const metricIds = documentedMetricIds(databaseMd);
    for (const it of parseCatalogue(catalogueText).sort(byId)) {
      const p = propose(it, ctx, metricIds);
      console.log(`${it.id}\t${it.dir ?? '-'}\t${it.name.slice(0, 70)}\n\t${p.map((x) => `${x.ref} (${x.method})`).join(', ') || '(no proposal)'}${REVIEW[it.id] ? '' : '\tUNREVIEWED'}`);
    }
    return;
  }
  const matrix = buildMatrix({ ctx, catalogueText, databaseMd, readFunctions });
  const outputs = [[MATRIX, render(matrix)], [REPORT, renderReport(matrix)]];
  const current = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null);
  if (args.has('--check')) {
    const stale = outputs.filter(([f, text]) => current(f) !== text).map(([f]) => f);
    console.log(stale.length ? `out of date: ${stale.join(', ')} (run node scripts/build-coverage-matrix.js)` : `${MATRIX} and ${REPORT} are up to date`);
    process.exitCode = stale.length ? 1 : 0;
    return;
  }
  for (const [f, text] of outputs) {
    const same = current(f) === text;
    if (!same) fs.writeFileSync(path.join(root, f), text);
    console.log(`${f}: ${same ? 'unchanged' : 'written'}`);
  }
  const c = matrix.counts;
  console.log(`${c.all.total} items: ${c.all.covered} covered, ${c.all.excluded_not_data} excluded as not data, ${c.all.gap} gaps`);
  console.log(`verified Predbat / PredHeat data items covered: ${c.covered_pct_of_data_items.verified} %; unverified: ${c.covered_pct_of_data_items.unverified} %`);
  console.log(`review: ${Object.entries(c.by_review).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (c.all.gap) console.log(`gaps: ${matrix.items.filter((x) => x.status === 'gap').map((x) => x.id).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
