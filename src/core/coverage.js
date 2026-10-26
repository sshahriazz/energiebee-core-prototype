// The coverage check (plan item B11), shared by test/coverage-matrix.test.js and GET /api/compatibility
// (src/core/compatibility.js): does a target of docs/coverage-matrix.json exist in a database?
//
//   table_column   `table.column` by PRAGMA table_info (a view's columns too); with a json_key, the key must
//                  also be listed for that column in docs/database.md ("JSON keys of `table.column`: `a`, `b`")
//   registry_key   `attribute_def:<key>`, `setting_def:<key>` or `device_kind:<kind>` by its row
//   metric         `metric:<code>` by its row          source   `source:<code>` by its row
//   device_action  `device_action:<kind>.<action>` by its row
//   view           `view:<name>` in sqlite_master
//   read_function  `<module>.<export>`: a function exported by one of readModules (the matrix uses
//                  planner-read only: { 'planner-read': the module src/core/planner-read.js })
//
// Read-only: it runs SELECTs on the schema and the registry tables, never on a home's data, and writes nothing.

/** docs/database.md "JSON keys of `table.column`: `a`, `b`" lines: Map table.column -> Set of keys. */
export function documentedJsonKeys(md) {
  return new Map([...String(md ?? '').matchAll(/JSON keys of `([a-z_]+\.[a-z_]+)`: ([^\n]+)/g)]
    .map((m) => [m[1], new Set([...m[2].matchAll(/`([a-z0-9_]+)`/g)].map((k) => k[1]))]));
}

export const TARGET_KINDS = Object.freeze(['table_column', 'registry_key', 'metric', 'source', 'device_action', 'view', 'read_function']);

/**
 * A function target -> true when the target exists in `db` (and the read modules), false otherwise.
 * opts.readModules: { moduleName: module namespace } for read_function targets;
 * opts.jsonKeys: documentedJsonKeys(docs/database.md) for table_column targets with a json_key.
 */
export function targetChecker(db, { readModules = {}, jsonKeys = new Map() } = {}) {
  const q = (sql) => { const st = db.prepare(sql); return (...a) => { try { return !!st.get(...a); } catch { return false; } }; };
  const has = {
    column: q('SELECT 1 FROM pragma_table_info(?) WHERE name = ?'),
    attribute: q('SELECT 1 FROM attribute_def WHERE key = ?'),
    setting: q('SELECT 1 FROM setting_def WHERE key = ?'),
    kind: q('SELECT 1 FROM device_kind WHERE kind = ?'),
    metric: q('SELECT 1 FROM metric WHERE code = ?'),
    source: q('SELECT 1 FROM source WHERE code = ?'),
    action: q('SELECT 1 FROM device_action WHERE device_kind = ? AND action = ?'),
    view: q("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?"),
  };
  return function exists(t) {
    const ref = String(t?.ref ?? '');
    const after = (p) => ref.slice(p.length);
    switch (t?.kind) {
      case 'table_column': {
        const [table, col] = ref.split('.');
        return has.column(table, col) && (!t.json_key || !!jsonKeys.get(ref)?.has(t.json_key));
      }
      case 'registry_key':
        return ref.startsWith('attribute_def:') ? has.attribute(after('attribute_def:'))
          : ref.startsWith('setting_def:') ? has.setting(after('setting_def:'))
            : ref.startsWith('device_kind:') ? has.kind(after('device_kind:')) : false;
      case 'metric': return ref.startsWith('metric:') && has.metric(after('metric:'));
      case 'source': return ref.startsWith('source:') && has.source(after('source:'));
      case 'device_action': {
        if (!ref.startsWith('device_action:')) return false;
        const [kind, action] = after('device_action:').split('.');
        return has.action(kind, action);
      }
      case 'view': return ref.startsWith('view:') && has.view(after('view:'));
      case 'read_function': {
        const dot = ref.indexOf('.');
        if (dot < 1) return false;
        const mod = readModules[ref.slice(0, dot)];
        return !!mod && typeof mod[ref.slice(dot + 1)] === 'function';
      }
      default: return false;
    }
  };
}

/** A target as written in the docs: `ref` plus `#json_key` when it names a key of a JSON column. */
export const targetLabel = (t) => `${t.ref}${t.json_key ? `#${t.json_key}` : ''}`;
