// Connectors: every adapter the core has or needs, one entry per adapter code, with a status word.
// Built at request time from three things, nothing stored:
//   - the market provider registry: the market_provider rows of every market (delta 008), merged by
//     adapter code (an adapter listed in several markets or roles is one connector);
//   - the implementation registry (registerAdapter, src/jobs/steps.js): is the adapter built;
//   - what the homes' syncs recorded: each home's latest sync_run log, its connection rows and the
//     adapter's own status hook (Tariffscanner's sweep state, typed-in tariffs for manual entry).
//
// status, the first that applies:
//   not_built          listed in the registry, no implementation registered (the note says what is planned)
//   disabled           built, but no row can run: every row switched off, unlicensed or owned by another
//                      process, or the adapter is listed in no market (reason from the note, as the plan words it)
//   error              built and usable, and the latest outcome failed for at least one home: a failed step
//                      in that home's latest sync log, a failing status hook, or a connection row in error
//   connected          built and usable, and the latest outcome is ok for at least one home (for a shared
//                      provider: its step last succeeded for that home, or was shared to it in the cycle)
//   needs_credentials  built and usable, needs credentials, and no home has them (or no home is connected
//                      to give them): the core has no secret store, keys are read from .env for one home
//   available          built and usable, nothing has run yet: no home connected (per home), or no run
//                      recorded (shared), or no home in its markets
// Demo homes (is_demo) are never synced: they are listed as 'demo' and counted apart (homes_demo),
// never as connected and never in homes_total_in_markets.
//
// Never contains a credential: the plan's credentials are never read here, no connection reference
// (external_ref) is returned, and every text is cleaned of the secret values set in the environment.
import { ROLES, adapterFor, adapterCodes, plan, licensed, devOverride } from './providers.js';
import { assertOwner } from '../adapters/contract.js';

export const CONNECTOR_STATUSES = Object.freeze(['error', 'needs_credentials', 'connected', 'available', 'disabled', 'not_built']);
// Per home: connected, error, needs_credentials, not_connected, not_run (usable, not synced yet),
// idle (usable, nothing to fetch), skipped, fallback (another provider of the role is used),
// disabled, not_built, demo.
export const DEMO_REASON = 'demo home: its data is generated, nothing is synced';

// Human names. The registry records adapter codes only; a code missing here is shown as itself.
export const CONNECTOR_LABELS = Object.freeze({
  sunsynk: 'Sunsynk Connect',
  geo: 'Postcode look-up (postcodes.io)',
  open_meteo: 'Open-Meteo',
  neso: 'NESO Carbon Intensity',
  octopus: 'Octopus Energy',
  national_gas: 'National Gas Data Portal',
  tariffscanner: 'Tariffscanner (FEA)',
  compare: 'Comparison tariffs (Octopus)',
  quartz: 'Quartz Solar (Open Climate Fix)',
  manual: 'Manual entry',
  linky: 'Linky (Enedis)',
  p1: 'P1 port reader (DSMR)',
  tounify: 'tounify (EU tariffs, v3 preview)',
  entsoe: 'ENTSO-E',
});

const ROLE_ORDER = new Map(ROLES.map((r, i) => [r.role, i]));
const byRole = (a, b) => (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) || a.priority - b.priority || a.market_code.localeCompare(b.market_code);
const marketOrder = (a, b) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b));

// Values of the environment's secret variables (keys, passwords, tokens, logins), longest first.
const SECRET_VAR = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|USERNAME|ACCOUNT_NUMBER)/i;
export function secretValues(env = process.env) {
  return [...new Set(Object.entries(env).filter(([k, v]) => SECRET_VAR.test(k) && typeof v === 'string' && v.length >= 6).map(([, v]) => v))]
    .sort((a, b) => b.length - a.length);
}
function scrub(x, secrets) {
  if (typeof x === 'string') return secrets.reduce((s, v) => s.split(v).join('[redacted]'), x);
  if (Array.isArray(x)) return x.map((y) => scrub(y, secrets));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v, secrets)]));
  return x;
}

// A skip reason from the plan or the sync log, as a per-home status word.
function skipStatus(reason) {
  const r = String(reason ?? '');
  if (/^no credentials/.test(r)) return 'needs_credentials';
  if (r === 'not connected for this home') return 'not_connected';
  if (/^(disabled|unlicensed):/.test(r) || / is owned by /.test(r)) return 'disabled';
  if (/^adapter not built/.test(r)) return 'not_built';
  if (/^fallback:/.test(r)) return 'fallback';
  return 'skipped';
}
const HOME_RANK = ['needs_credentials', 'not_connected', 'not_run', 'idle', 'skipped', 'fallback', 'disabled', 'not_built'];

// Why no row of a built adapter can run, worded as the plan's gate words it.
function disabledReason(code, impl, own) {
  const on = own.filter((r) => r.enabled);
  if (!on.length) return `disabled: ${own[0].note || 'switched off'}`;
  const lic = on.filter((r) => licensed(r, impl));
  if (!lic.length) return `unlicensed: ${on[0].note || 'the licence to store and serve its data is unconfirmed'}`;
  for (const r of lic) {
    for (const owner of [r.owner, impl.owner ?? r.owner]) {
      try { assertOwner({ code, owner }); } catch (err) { return err.message; }
    }
  }
  return 'switched off';
}

// One home's latest record, read once per request: its last sync log, its connection rows, its plan.
function homeRecord(db, site) {
  const run = db.prepare('SELECT id, started_at, finished_at, status, detail FROM sync_run WHERE site_id = ? AND detail IS NOT NULL ORDER BY id DESC LIMIT 1').get(site.id);
  let log = [];
  try { log = JSON.parse(run?.detail || '[]'); } catch { log = []; }
  if (!Array.isArray(log)) log = [];
  const conns = new Map(db.prepare('SELECT provider, status, last_success_at, last_error FROM connection WHERE site_id = ?').all(site.id).map((c) => [c.provider, { ...c }]));
  let entries = [];
  try { entries = plan(db, site, { conns: new Set(conns.keys()) }); } catch { entries = []; }
  return { run: run ? { id: run.id, started_at: run.started_at } : null, log: log.filter((l) => l && typeof l === 'object' && l.step), conns, plan: entries };
}

// How one connector did for one (non-demo) home: { status, reason, at, has_creds }.
function homeOutcome(db, c, site, rec) {
  const found = rec.log.filter((l) => c.steps.has(l.step));
  const at = rec.run?.started_at ?? null;
  const entries = rec.plan.filter((e) => e.adapter === c.code);
  const has_creds = entries.some((e) => e.chosen && c.credRoles.has(e.role));
  // What the next sync will do when it cannot run a credentialed role now (the reason names variables, never values).
  const next = entries.find((e) => !e.chosen && c.credRoles.has(e.role) && /^no credentials/.test(e.skipped ?? ''))?.skipped ?? null;
  const done = (o) => ({ ...o, has_creds, next });
  const err = found.find((l) => l.ok === false);
  if (err) return done({ status: 'error', reason: err.error ?? 'failed', at });
  const ok = found.find((l) => l.ok && !l.skipped);
  if (ok) return done({ status: 'connected', reason: ok.shared ?? null, at });
  const market = site.market_code ?? 'GB';
  const candidates = [];
  for (const h of c.hooks.filter((x) => x.markets.has(market) || x.markets.has('*'))) {
    let r;
    try { r = h.fn(db, site); } catch (e) { r = { status: 'error', reason: e.message }; }
    if (r?.status === 'error') return done({ status: 'error', reason: r.reason ?? 'failed', at: null });
    if (r?.status === 'ok') return done({ status: 'connected', reason: r.reason ?? null, at: null });
    if (r?.reason) candidates.push({ status: 'idle', reason: r.reason });
  }
  const rows = [...c.conns].map((n) => rec.conns.get(n)).filter(Boolean);
  const cErr = rows.find((x) => x.status === 'error');
  if (cErr) return done({ status: 'error', reason: cErr.last_error ?? 'failed', at: null });
  const cOk = rows.find((x) => x.status === 'ok');
  if (cOk) return done({ status: 'connected', reason: null, at: cOk.last_success_at ?? null });
  const sk = found.find((l) => l.skipped);
  if (sk) return done({ status: skipStatus(sk.skipped), reason: sk.skipped, at });
  for (const e of entries) {
    if (e.chosen) candidates.push(e.run ? { status: 'not_run', reason: 'not synced yet' } : { status: 'idle', reason: e.skipped || 'nothing to fetch' });
    else candidates.push({ status: skipStatus(e.skipped), reason: e.skipped });
  }
  if (!candidates.length) return done({ status: 'skipped', reason: 'not in this home\'s plan' });
  // Stable: a status hook's own words come before the plan's for the same rank.
  return done(candidates.map((x, i) => ({ x, i })).sort((a, b) => HOME_RANK.indexOf(a.x.status) - HOME_RANK.indexOf(b.x.status) || a.i - b.i)[0].x);
}

function connectorEntry(db, code, own, sites, recordOf) {
  const impl = adapterFor(code);
  own = own.slice().sort(byRole);
  // Licensed, or (tounify only) run on a development override of an unconfirmed licence (providers.js devOverride).
  const usable = impl && (impl.owner ?? 'core') === 'core' ? own.filter((r) => r.enabled && licensed(r, impl) && r.owner === 'core') : [];
  const dev = usable.map((r) => devOverride(r, impl)).find(Boolean) ?? null;
  const primary = usable[0] ?? own[0] ?? null;
  const roles = own.length ? [...new Set(own.map((r) => r.role))] : Object.keys(impl?.roles ?? {}).sort((a, b) => (ROLE_ORDER.get(a) ?? 99) - (ROLE_ORDER.get(b) ?? 99));
  const markets = [...new Set(own.map((r) => r.market_code))].sort(marketOrder).map((m) => {
    const rs = own.filter((r) => r.market_code === m);
    return {
      market_code: m, enabled: rs.some((r) => r.enabled === 1), licence_confirmed: rs.every((r) => r.licence_confirmed === 1), priority: Math.min(...rs.map((r) => r.priority)),
      roles: rs.map((r) => ({ role: r.role, priority: r.priority, enabled: r.enabled === 1, licence_confirmed: r.licence_confirmed === 1, needs_credentials: r.needs_credentials === 1, scope: r.scope, owner: r.owner, origin: r.origin, note: r.note ?? null })),
    };
  });
  const scopeRows = usable.length ? usable : own;
  const scopes = [...new Set(scopeRows.map((r) => r.scope))];
  // The implementation's steps (names in the sync log), connection rows and status hooks.
  const steps = new Set();
  const conns = new Set(impl?.connection ? [impl.connection] : []);
  const hooks = [];
  for (const [role, def] of Object.entries(impl?.roles ?? {})) {
    for (const s of def.steps ?? []) { steps.add(s.step); if (s.connection) conns.add(s.connection); }
    if (typeof def.status === 'function') hooks.push({ role, fn: def.status, markets: new Set(usable.filter((r) => r.role === role).map((r) => r.market_code)) });
  }
  const c = { code, steps, conns, hooks, credRoles: new Set(usable.filter((r) => r.needs_credentials).map((r) => r.role)) };

  const inMarkets = (s) => scopeRows.some((r) => r.market_code === '*' || r.market_code === (s.market_code ?? 'GB'));
  const listed = sites.filter(inMarkets);
  const real = listed.filter((s) => !s.is_demo);
  const demo = listed.filter((s) => s.is_demo);
  const outs = impl && usable.length ? real.map((s) => ({ site: s, rec: recordOf(s), ...homeOutcome(db, c, s, recordOf(s)) })) : [];
  const connected = outs.filter((o) => o.status === 'connected');
  const errors = outs.filter((o) => o.status === 'error').sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const needsCreds = usable.some((r) => r.needs_credentials);
  const perHome = scopes.includes('home');

  let status;
  let reason;
  if (!impl) { status = 'not_built'; reason = primary?.note || `adapter not built: no implementation registered for ${code}`; }
  else if (!own.length) { status = 'disabled'; reason = 'not listed in any market: the registry never runs it'; }
  else if (!usable.length) { status = 'disabled'; reason = disabledReason(code, impl, own); }
  else if (errors.length) { status = 'error'; reason = errors[0].reason; }
  else if (connected.length) { status = 'connected'; reason = null; }
  else if (needsCreds && !outs.some((o) => o.has_creds)) {
    status = 'needs_credentials';
    reason = outs.find((o) => o.status === 'needs_credentials')?.reason
      ?? (real.length ? 'needs credentials: no home is connected with them yet (keys and passwords are read from .env, for the .env home only)' : 'needs credentials: no home in its markets yet');
  } else {
    status = 'available';
    const idle = outs.find((o) => ['idle', 'skipped', 'not_run'].includes(o.status) && o.reason);
    reason = !real.length ? 'built and switched on; no home in its markets yet'
      : perHome && impl.connection && !outs.some((o) => o.status !== 'not_connected') ? 'built and switched on; no home is connected yet'
        : idle?.reason ?? 'built and switched on; not run yet';
  }

  // Latest success over the homes: a successful step in the latest run, or a connection row's last success.
  let lastSuccess = null;
  for (const s of real) {
    if (!impl || !usable.length) break;
    const rec = recordOf(s);
    for (const n of conns) { const t = rec.conns.get(n)?.last_success_at; if (t != null && (lastSuccess == null || t > lastSuccess)) lastSuccess = t; }
    if (rec.run && rec.log.some((l) => steps.has(l.step) && l.ok && !l.skipped) && (lastSuccess == null || rec.run.started_at > lastSuccess)) lastSuccess = rec.run.started_at;
  }
  // The most recent run (over the homes) that holds any of its steps.
  let lastRun = null;
  for (const o of outs) {
    const mine = o.rec.log.filter((l) => steps.has(l.step));
    if (!mine.length || !o.rec.run) continue;
    if (!lastRun || o.rec.run.started_at > lastRun.at) {
      lastRun = { site_id: o.site.id, at: o.rec.run.started_at, steps: mine.map((l) => ({ step: l.step, ok: l.ok !== false, ...(l.skipped ? { skipped: l.skipped } : {}), ...(l.shared ? { shared: l.shared } : {}), ...(l.ok === false ? { error: l.error ?? 'failed' } : {}) })) };
    }
  }
  const lastSuccessOf = (s) => {
    if (!impl || !usable.length) return null;
    const rec = recordOf(s);
    const ts = [...conns].map((n) => rec.conns.get(n)?.last_success_at).filter((t) => t != null);
    return ts.length ? Math.max(...ts) : null;
  };

  return {
    adapter: code,
    label: CONNECTOR_LABELS[code] ?? impl?.label ?? code,
    roles,
    markets,
    scope: perHome ? 'home' : scopes.length ? 'shared' : null,
    scopes,
    owner: own.some((r) => r.owner !== 'core') || (impl && (impl.owner ?? 'core') !== 'core') ? 'external' : 'core',
    auth: own.some((r) => r.needs_credentials === 1) ? 'credentials' : 'none',
    built: !!impl,
    enabled: own.some((r) => r.enabled === 1),
    licence_confirmed: own.length ? own.every((r) => r.licence_confirmed === 1) : null,
    // Present only while an unconfirmed licence is overridden for development (TOUNIFY_DEV=1 with a test token).
    ...(dev ? { dev_override: dev } : {}),
    origin: primary?.origin ?? null,
    origins: [...new Set(own.map((r) => r.origin))],
    note: primary?.note ?? null,
    status,
    reason,
    // Connected or failing now, but the next sync skips it for some home (no credentials in this process).
    warning: ['connected', 'error'].includes(status) && outs.some((o) => o.next)
      ? `the next sync skips it for ${outs.filter((o) => o.next).length} of ${real.length} home${real.length === 1 ? '' : 's'}: ${outs.find((o) => o.next).next}` : null,
    homes_connected: connected.length,
    homes_error: errors.length,
    homes_total_in_markets: real.length,
    homes_demo: demo.length,
    last_success_at: lastSuccess,
    last_error: errors[0]?.reason ?? null,
    last_error_at: errors[0]?.at ?? null,
    steps: [...steps],
    last_run: lastRun,
    homes: [
      ...real.map((s) => {
        const o = outs.find((x) => x.site.id === s.id);
        return { site_id: s.id, name: s.name, market_code: s.market_code ?? 'GB', is_demo: false, status: o?.status ?? status, reason: o ? o.reason ?? null : reason, last_success_at: lastSuccessOf(s), next: o?.next ?? null };
      }),
      ...demo.map((s) => ({ site_id: s.id, name: s.name, market_code: s.market_code ?? 'GB', is_demo: true, status: 'demo', reason: DEMO_REASON, last_success_at: null, next: null })),
    ],
  };
}

/**
 * Every connector the core has or needs: { generated_at, summary: { connected, error,
 * needs_credentials, available, disabled, not_built, total }, homes: { total, demo }, statuses,
 * connectors: [entry] }, problems first (error, needs_credentials), then connected, available,
 * disabled, not_built, each group by label. Entry: { adapter, label, roles, markets: [{ market_code,
 * enabled, licence_confirmed, priority, roles: [{ role, priority, enabled, licence_confirmed,
 * needs_credentials, scope, owner, origin, note }] }], scope, scopes, owner, auth ('none' |
 * 'credentials'), built, enabled, licence_confirmed, origin, origins, note, status, reason, warning,
 * homes_connected, homes_error, homes_total_in_markets, homes_demo, last_success_at, last_error,
 * last_error_at, steps, last_run, homes: [{ site_id, name, market_code, is_demo, status, reason,
 * last_success_at, next }] }. warning / next: connected (or failing) by its last run, but the next
 * sync skips it for want of credentials in this process. Times are epoch seconds. Never contains a
 * credential.
 */
export function connectors(db, { env = process.env } = {}) {
  const rows = db.prepare('SELECT * FROM market_provider').all().map((r) => ({ ...r }));
  const sites = db.prepare('SELECT * FROM site ORDER BY is_demo, id').all().map((s) => ({ ...s }));
  const records = new Map();
  const recordOf = (s) => { if (!records.has(s.id)) records.set(s.id, homeRecord(db, s)); return records.get(s.id); };
  const codes = [...new Set([...rows.map((r) => r.adapter), ...adapterCodes()])];
  const list = codes.map((code) => connectorEntry(db, code, rows.filter((r) => r.adapter === code), sites, recordOf))
    .sort((a, b) => CONNECTOR_STATUSES.indexOf(a.status) - CONNECTOR_STATUSES.indexOf(b.status) || a.label.localeCompare(b.label));
  const summary = Object.fromEntries(CONNECTOR_STATUSES.map((s) => [s, list.filter((c) => c.status === s).length]));
  summary.total = list.length;
  return scrub({
    generated_at: Math.floor(Date.now() / 1000),
    summary,
    homes: { total: sites.filter((s) => !s.is_demo).length, demo: sites.filter((s) => s.is_demo).length },
    statuses: [...CONNECTOR_STATUSES],
    connectors: list,
  }, secretValues(env));
}
