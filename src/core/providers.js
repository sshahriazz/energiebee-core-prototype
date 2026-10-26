// Market provider registry: which provider fills each role a home needs (market_provider, delta 008,
// seeded from src/db/seed/providers.js), the implementation registered for each adapter code, and
// the plan of sync steps for one home built from both. src/jobs/sync.js runs the plan; the steps
// themselves (wrapping the adapters exactly as the sync job called them) are in src/jobs/steps.js.
//
// A home's plan = its market's enabled shared roles + the per-home roles it has a connection row for.
// For each role the first usable provider by priority is used; the others are listed with the reason
// they are not: disabled, unlicensed, owned by another process (assertOwner), adapter not built,
// not connected, or no credentials. A skip is recorded on the sync run as 'skipped: <reason>', never
// as an error. Shared steps run once per tariff / region / zone / location per sync cycle.
// In an additive role (ROLES[].additive: tariff_catalogue) every usable provider runs; one listed
// after the role is already served is an extra, so when it cannot run the plan and providerStatus
// say why but the sync log does not repeat it for every home on every cycle.
//
// Credentials: the core has NO secret store. Secrets stay in the environment (.env) as before the
// registry, and only the home configured in .env (env_key 'env') reads them; a connection row keeps
// the non-secret reference only (account number, plant id). Any other home's step that needs
// credentials is skipped with 'no credentials' until a secret store exists. A shared provider queried
// with the core's OWN credential, not a home's (Tariffscanner: TARIFFSCAN_USERNAME, TARIFFSCAN_PASSWORD),
// reads it from .env whichever home's sync runs the step (SERVICE_CREDENTIALS).
import { assertOwner } from '../adapters/contract.js';

// Every role a home can need, in the order the sync runs them (a provider's own steps may sit
// elsewhere: the Octopus postcode look-up runs before the inverter). scope is the usual one.
// additive: catalogues add up, so EVERY usable provider of the role runs (Octopus's products list
// and Tariffscanner's catalogue), in priority order; any other role uses the first usable one and
// the rest are fallbacks.
export const ROLES = Object.freeze([
  { role: 'inverter', order: 10, scope: 'home', label: 'Inverter' },
  { role: 'location', order: 20, scope: 'shared', label: 'Location (coordinates and regions)' },
  { role: 'weather', order: 30, scope: 'shared', label: 'Weather' },
  { role: 'carbon', order: 40, scope: 'shared', label: 'Carbon intensity' },
  { role: 'meter', order: 50, scope: 'home', label: 'Meter' },
  { role: 'gas_cv', order: 60, scope: 'shared', label: 'Gas calorific value' },
  { role: 'tariff_prices', order: 70, scope: 'shared', label: 'Tariff prices' },
  { role: 'tariff_catalogue', order: 75, scope: 'shared', label: 'Tariff catalogue', additive: true },
  { role: 'compare', order: 80, scope: 'shared', label: 'Comparison tariffs' },
  { role: 'solar_forecast', order: 90, scope: 'shared', label: 'Solar forecast' },
].map((r) => Object.freeze(r)));
export const ROLE_CODES = Object.freeze(ROLES.map((r) => r.role));
export const STATUSES = Object.freeze(['ok', 'error', 'skipped', 'disabled', 'none']);
export const NO_PROVIDER = 'no provider for this market';
export const MANUAL_FALLBACK = 'Manual entry is always allowed: a tariff and its prices can be typed in by hand (labelled user), whatever the market and whether or not a price source exists.';
export const CREDENTIALS_NOTE = 'Secrets are not stored: the core has no secret store. The connection keeps only the non-secret reference (account number, plant id). API keys and passwords are read from .env, for the .env home only (OCTOPUS_API_KEY, OCTOPUS_ACCOUNT_NUMBER, SUNSYNK_USERNAME, SUNSYNK_PASSWORD); any other home is skipped with "no credentials" until a secret store exists.';

// ───────────── Implementations ─────────────

const adapters = new Map();

/**
 * Register the implementation of an adapter code (replacing any earlier one). Returns a function
 * that puts the previous implementation back (tests use it to swap in fakes).
 * impl: {
 *   owner        'core' (default) | 'external' (another process owns the provider's rate budget):
 *                only the owner may call the provider, so the core never calls an 'external' one (assertOwner)
 *   connection   the home's connection row it needs for a per-home role ('octopus', 'sunsynk'),
 *                null when it needs none (manual entry)
 *   licenceOverride  (row, env) => label | null: a development override of an UNCONFIRMED licence
 *                (licence_confirmed = 0) for this adapter's rows; the label says why it runs and is
 *                carried on the plan entry (dev_override). Only tounify has one (TOUNIFY_DEV=1 with
 *                a test token); every other adapter is gated as before.
 *   credentials  (site) => { creds } | { missing: reason }, checked when the registry row says
 *                needs_credentials; reasons name variables, never values
 *   externalRef  (credentials) => the non-secret reference kept on the connection row
 *   publicFields credential fields that are not secret (stored as external_ref)
 *   roles        { [role]: { steps: [step], via: [step names of other roles that also serve it],
 *                  idle: why the role has no step of its own to run, status: (db, site) => {status, reason} } }
 * }
 * step: { step (name in the sync log), order, connection (row it updates; null: none),
 *   when(p)       plan time: false leaves the step out of this home's plan ({ site, conns })
 *   applies(ctx)  run time: false means nothing to do yet (not run, not logged)
 *   ensure        create the connection row just before running
 *   prepare(ctx)  the step's window, computed before running
 *   share(ctx, a) { key, from }: work shared between homes; a later home whose window starts at or
 *                 after `from` reuses it instead of calling the provider again
 *   onShared(ctx, hit), shareResponses (reuse the provider's identical answers within the cycle),
 *   run(ctx, a, creds), after(ctx) (runs after the step whatever its outcome) }
 */
export function registerAdapter(code, impl) {
  if (typeof code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(code)) throw new Error(`adapter code must be a lower-case identifier, not ${code}`);
  const roles = {};
  for (const [role, def] of Object.entries(impl?.roles ?? {})) {
    if (!ROLE_CODES.includes(role)) throw new Error(`${code}: unknown role ${role} (one of ${ROLE_CODES.join(', ')})`);
    const d = Array.isArray(def) ? { steps: def } : { ...def };
    d.steps = (d.steps ?? []).map((s) => {
      if (!s.step || typeof s.run !== 'function') throw new Error(`${code}/${role}: a step needs a name and run()`);
      return { order: ROLES.find((r) => r.role === role).order, connection: null, ...s };
    });
    d.via = d.via ?? [];
    roles[role] = d;
  }
  const prev = adapters.get(code);
  adapters.set(code, { owner: 'core', ...impl, code, roles });
  return () => { if (prev) adapters.set(code, prev); else adapters.delete(code); };
}

export const adapterFor = (code) => adapters.get(code) ?? null;
// Every adapter code with an implementation registered (the Connectors page lists these with the registry rows).
export const adapterCodes = () => [...adapters.keys()];

// ───────────── Registry rows ─────────────

/** Every provider listed for a role in a market (its own rows and the '*' ones), in the order they are tried. */
export function providersFor(db, marketCode, role) {
  return db.prepare(`SELECT * FROM market_provider WHERE market_code IN (?, '*') AND role = ?
    ORDER BY priority, market_code = '*', adapter`).all(marketCode ?? 'GB', role).map((r) => ({ ...r }));
}

// Credentials from the environment, for the .env home only (see the note at the top).
// vars and optional map credential fields to variable names.
export function envCredentials(site, vars, optional = {}, env = process.env) {
  if (site?.env_key !== 'env') return { missing: 'no credentials: secrets are read from .env for the .env home only (the core has no secret store yet)' };
  const absent = Object.values(vars).filter((v) => !env[v]);
  if (absent.length) return { missing: `no credentials: ${absent.join(', ')} not set (start the server with --env-file=.env)` };
  return { creds: Object.fromEntries([...Object.entries(vars), ...Object.entries(optional)].filter(([, v]) => env[v]).map(([k, v]) => [k, env[v]])) };
}

// The core's own credential for a shared provider (not a home's secret): read from .env as for the
// .env home, whichever home's sync runs the step. envCredentials(SERVICE_CREDENTIALS, vars).
export const SERVICE_CREDENTIALS = Object.freeze({ env_key: 'env' });

// A development override of an unconfirmed licence (impl.licenceOverride), as its label, or null.
export function devOverride(row, impl, env = process.env) {
  if (row.licence_confirmed || typeof impl?.licenceOverride !== 'function') return null;
  try { return impl.licenceOverride(row, env) || null; } catch { return null; }
}
// Whether a row's licence lets it run: confirmed, or overridden for development (devOverride).
export const licensed = (row, impl, env = process.env) => !!row.licence_confirmed || !!devOverride(row, impl, env);

// Why a listed provider cannot be used for this home ({ reason, log }), or {} with its credentials.
function gate(row, impl, site, conns) {
  if (!row.enabled) return { reason: `disabled: ${row.note || 'switched off'}`, log: true, status: 'disabled' };
  if (!licensed(row, impl)) return { reason: `unlicensed: ${row.note || 'the licence to store and serve its data is unconfirmed'}`, log: true, status: 'disabled' };
  for (const owner of [row.owner, impl?.owner ?? row.owner]) {
    try { assertOwner({ code: row.adapter, owner }); } catch (err) { return { reason: err.message, log: true, status: 'skipped' }; }
  }
  if (!impl) return { reason: `adapter not built: no implementation registered for ${row.adapter}`, log: true, status: 'disabled' };
  if (row.scope === 'home' && impl.connection && !conns.has(impl.connection)) return { reason: 'not connected for this home', log: false, status: 'skipped' };
  if (row.needs_credentials && impl.credentials) {
    const c = impl.credentials(site);
    if (c?.missing) return { reason: c.missing, log: true, status: 'skipped' };
    return { creds: c?.creds ?? {} };
  }
  return {};
}

// Properties a plan entry carries for the runner but never prints (credentials, the step definition).
const hidden = (entry, props) => {
  for (const [k, v] of Object.entries(props)) Object.defineProperty(entry, k, { value: v, enumerable: false });
  return entry;
};

/**
 * The plan of one home, in run order. One entry per step to run ({ run: true, step, connection })
 * and one per provider not used, with why ({ run: false, skipped, log }: log says whether the sync
 * run records the skip; a per-home role the home is not connected to, a fallback or a provider with
 * nothing to fetch is not recorded). A role with no provider in the market has no entry.
 */
export function plan(db, site, { conns = null } = {}) {
  conns ??= new Set(db.prepare('SELECT provider FROM connection WHERE site_id = ?').all(site.id).map((c) => c.provider));
  const market = site.market_code ?? 'GB';
  const p = { site, conns, market };
  const out = [];
  for (const { role, order: roleOrder, additive } of ROLES) {
    let chosen = null;
    for (const row of providersFor(db, market, role)) {
      const impl = adapters.get(row.adapter) ?? null;
      const def = impl?.roles[role] ?? null;
      const base = { role, adapter: row.adapter, market_code: row.market_code, scope: row.scope, priority: row.priority, origin: row.origin, note: row.note };
      const order = def?.steps.length ? Math.min(...def.steps.map((s) => s.order)) : roleOrder;
      // A skipped provider is logged under its step's name when it has one ('octopus'), else role:adapter.
      const skip = (skipped, log, status) => out.push(hidden({ ...base, step: def?.steps[0]?.step ?? `${role}:${row.adapter}`, order,
        connection: def?.steps[0]?.connection ?? impl?.connection ?? null, run: false, chosen: false, log, skipped, status }, { def }));
      if (chosen && !additive) { skip(`fallback: ${chosen} is used`, false, 'skipped'); continue; }
      const g = gate(row, impl, site, conns);
      if (g.reason) { skip(g.reason, g.log && !chosen, g.status); continue; }
      chosen ??= row.adapter;
      // Running on a development override of an unconfirmed licence: said on the entry (never otherwise present).
      const dev = devOverride(row, impl);
      const devMark = dev ? { dev_override: dev } : {};
      const steps = def ? def.steps.filter((s) => !s.when || s.when(p)) : [];
      if (!steps.length) {
        out.push(hidden({ ...base, ...devMark, step: `${role}:${row.adapter}`, order, connection: null, run: false, chosen: true, log: false, skipped: def?.idle || 'nothing to fetch' }, { def }));
        continue;
      }
      for (const s of steps) {
        out.push(hidden({ ...base, ...devMark, step: s.step, order: s.order, connection: s.connection ?? null, run: true, chosen: true, log: true }, { def: s, roleDef: def, creds: g.creds ?? null }));
      }
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

// ───────────── Sync cycle ─────────────

// State shared by the homes synced in one cycle (one scheduler tick): work done once per key
// (region, zone, tariff), and provider answers reused for identical requests (weather, solar
// forecast at one location). A single home's sync gets a cycle of its own.
export const newCycle = () => ({ shared: new Map(), tariffs: new Map(), responses: new Map() });

// ───────────── Status for the API ─────────────

const lastLog = (db, siteId) => {
  const r = db.prepare('SELECT detail FROM sync_run WHERE site_id = ? AND detail IS NOT NULL ORDER BY id DESC LIMIT 1').get(siteId);
  try { return JSON.parse(r?.detail || '[]'); } catch { return []; }
};

// How one used provider of a role did ({ status, reason }): its steps (and the steps of other roles
// that also serve it) in the last sync run, else its own status hook, else its connection row.
function usedStatus(db, site, used, log, conns) {
  const head = used[0];
  const roleDef = head.roleDef ?? head.def;
  const names = [...new Set([...used.filter((e) => e.run).map((e) => e.step), ...(roleDef?.via ?? [])])];
  const found = names.flatMap((n) => log.filter((l) => l.step === n));
  const err = found.find((l) => l.ok === false);
  if (err) return { status: 'error', reason: err.error ?? 'failed' };
  const ok = found.find((l) => l.ok && !l.skipped);
  if (ok) return { status: 'ok', reason: ok.shared ?? null };
  const sk = found.find((l) => l.skipped);
  if (sk) return { status: 'skipped', reason: sk.skipped };
  if (roleDef?.status) return roleDef.status(db, site);
  const conn = used.map((e) => conns.get(e.connection)).find(Boolean);
  if (conn && ['ok', 'error', 'skipped'].includes(conn.status)) return { status: conn.status, reason: conn.last_error ?? null };
  return { status: 'skipped', reason: roleDef?.idle ?? (used.some((e) => e.run) ? 'not synced yet' : head.skipped) };
}

/**
 * Per role, the provider this home uses and how it did: { role, label, adapter, status (ok | error |
 * skipped | disabled | none), origin, note, scope, reason, alternatives }. status comes from the last
 * sync run (the role's own steps, then the steps of other roles that also serve it), else from the
 * connection row. An additive role (tariff_catalogue) gives its first provider here and every other
 * one it also runs in `also` ([{ adapter, status, reason, origin, note }]). Never contains credentials.
 */
export function providerStatus(db, site) {
  const entries = plan(db, site);
  const log = lastLog(db, site.id);
  const conns = new Map(db.prepare('SELECT provider, status, last_error FROM connection WHERE site_id = ?').all(site.id).map((c) => [c.provider, c]));
  return ROLES.map(({ role, scope, label }) => {
    const list = entries.filter((e) => e.role === role);
    if (!list.length) return { role, label, adapter: null, status: 'none', origin: null, note: NO_PROVIDER, scope, reason: NO_PROVIDER, alternatives: [] };
    const chosen = list.filter((e) => e.chosen);
    const alternatives = [...new Map(list.filter((e) => !e.chosen).map((e) => [e.adapter, { adapter: e.adapter, status: e.status, reason: e.skipped, origin: e.origin }])).values()];
    if (!chosen.length) {
      const first = list[0];
      return { role, label, adapter: first.adapter, status: first.status, origin: first.origin, note: first.note, scope: first.scope, reason: first.skipped, alternatives: alternatives.slice(1) };
    }
    const head = chosen[0];
    const out = { role, label, adapter: head.adapter, origin: head.origin, note: head.note, scope: head.scope, alternatives };
    const others = [...new Set(chosen.map((e) => e.adapter))].filter((a) => a !== head.adapter);
    if (site.is_demo) {
      const demo = { status: 'skipped', reason: 'demo home: its data is generated, nothing is synced' };
      return { ...out, ...demo, ...(others.length ? { also: others.map((a) => ({ adapter: a, ...demo })) } : {}) };
    }
    const res = { ...out, ...usedStatus(db, site, chosen.filter((e) => e.adapter === head.adapter), log, conns) };
    if (!others.length) return res;
    return { ...res, also: others.map((a) => {
      const used = chosen.filter((e) => e.adapter === a);
      return { adapter: a, ...usedStatus(db, site, used, log, conns), origin: used[0].origin, note: used[0].note };
    }) };
  });
}

// ───────────── Connecting a provider to a home ─────────────

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * Store a home's connection to a per-home provider (an inverter cloud, a meter account), after
 * checking the registry allows that provider for the home's market. Only the non-secret reference
 * is stored (see CREDENTIALS_NOTE); the reply names the credential fields that were not stored and
 * never echoes a value. Throws a 400 error with a readable message when the provider is refused.
 */
/**
 * The registry check of a per-home connection, shared by every provider (connectProvider, and the
 * tounify registration in src/adapters/tounify.js): the provider must be listed for the home's
 * market in a per-home role, switched on, licensed (or on its development override), owned by the
 * core and built. Returns { row, impl, market }; throws a 400 error with a readable message.
 */
export function connectable(db, site, { provider, role = null } = {}) {
  if (!provider || typeof provider !== 'string') throw bad('provider is required: the adapter code of an inverter or meter (octopus, sunsynk, ...)');
  if (site.is_demo) throw bad('demo home: its data is generated, it takes no provider connection');
  const market = site.market_code ?? 'GB';
  if (role && !ROLE_CODES.includes(role)) throw bad(`unknown role ${role} (one of ${ROLE_CODES.join(', ')})`);
  const rows = db.prepare(`SELECT * FROM market_provider WHERE market_code IN (?, '*') AND adapter = ? ${role ? 'AND role = ?' : ''}
    ORDER BY scope = 'home' DESC, priority`).all(...[market, provider, role].filter(Boolean));
  const homeRoles = db.prepare(`SELECT * FROM market_provider WHERE market_code IN (?, '*') AND scope = 'home' AND enabled = 1 AND owner = 'core'
    ORDER BY role, priority`).all(market).filter((r) => adapters.get(r.adapter)?.connection && licensed(r, adapters.get(r.adapter))).map((r) => `${r.adapter} (${r.role})`);
  const allowed = `connections allowed for a home in market ${market}: ${homeRoles.join(', ') || 'none'}`;
  if (!rows.length) throw bad(`${provider} is not a provider for market ${market}${role ? ` in role ${role}` : ''}; ${allowed}`);
  const row = rows[0];
  if (row.scope !== 'home') throw bad(`${provider} serves ${rows.map((r) => r.role).join(', ')} in market ${market}, a shared role: it runs for every home of the market and needs no connection`);
  if (!row.enabled) throw bad(`${provider} is listed for ${row.role} in market ${market} but disabled: ${row.note}`);
  const impl = adapters.get(provider);
  if (!licensed(row, impl)) throw bad(`${provider} is listed for ${row.role} in market ${market} but its licence is unconfirmed: ${row.note}`);
  try { assertOwner({ code: provider, owner: row.owner }); if (impl) assertOwner(impl); } catch (err) { throw bad(err.message); }
  if (!impl) throw bad(`${provider} is listed for ${row.role} in market ${market} but its adapter is not built`);
  if (!impl.connection) throw bad(`${provider} needs no connection: ${row.note}`);
  return { row, impl, market };
}

export function connectProvider(db, site, { provider, role = null, credentials = null } = {}) {
  const { row, impl, market } = connectable(db, site, { provider, role });
  // A provider that registers the home upstream (tounify: one connection per home, billed per
  // connection) is connected by its own registration, never by a bare row here.
  if (impl.registers) throw bad(`${provider} connects a home by registering it upstream: ${impl.registers}`);
  const given = credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials : {};
  const ref = impl.externalRef?.(given) ?? null;
  const notStored = Object.keys(given).filter((k) => !(impl.publicFields ?? []).includes(k));
  const existed = !!db.prepare('SELECT 1 FROM connection WHERE site_id = ? AND provider = ?').get(site.id, impl.connection);
  db.prepare(`INSERT INTO connection (site_id, provider, external_ref) VALUES (?, ?, ?)
    ON CONFLICT (site_id, provider) DO UPDATE SET external_ref = COALESCE(excluded.external_ref, connection.external_ref)`)
    .run(site.id, impl.connection, ref == null ? null : String(ref));
  const connection = { ...db.prepare('SELECT provider, external_ref, status, last_success_at, last_error FROM connection WHERE site_id = ? AND provider = ?').get(site.id, impl.connection) };
  return { created: !existed, role: row.role, adapter: provider, market, connection, secrets_stored: false, not_stored: notStored, credentials_note: CREDENTIALS_NOTE };
}
