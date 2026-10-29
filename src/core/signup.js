// After sign-up (src/core/users.js): the user's home from a country and postcode, the providers that
// home can connect (the market provider registry, src/core/providers.js), and connecting one with the
// user's own login: checked against the provider first, stored encrypted (src/core/secrets.js), then
// the home's first sync starts. Every later sync (the 10-minute scheduler) reads the stored login.
// hooks: the login checks, the postcode look-up and the sync start, swapped for fakes by the tests so
// they call no provider.
import { db, tx } from '../db/db.js';
import { createSite } from './sites.js';
import { ROLES, providersFor, adapterFor, licensed, providerStatus, connectProvider } from './providers.js';
import { putSecret, hasSecret, secretsReady, deleteSecret } from './secrets.js';
import { retireDevice } from './devices.js';
import { withdrawAttribute } from './attributes.js';
import { markDirty } from './facts.js';
import { processQueue } from './build.js';
import { nowSec, dayBounds } from './time.js';
import { giveHome } from './users.js';
import { resolveSiteGeo } from '../adapters/geo.js';
import { checkSunsynkLogin, listSunsynkPlants } from '../adapters/sunsynk.js';
import { checkOctopusAccount } from '../adapters/octopus.js';
import { ensureSharedConnections, syncSite } from '../jobs/sync.js';

const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

export const hooks = {
  verify: { sunsynk: (c) => checkSunsynkLogin(c), octopus: (c) => checkOctopusAccount(c) },
  plants: { sunsynk: (c) => listSunsynkPlants(c) },
  geo: (site) => resolveSiteGeo(site),
  startSync: (siteId) => syncSite(siteId),
};

// ───────────── The home: country and postcode ─────────────

// The countries a home can be added in at sign-up, with the shape of their postcodes.
export const COUNTRIES = Object.freeze({
  GB: { name: 'United Kingdom', postcode: /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i, example: 'BB12 9BY' },
  FR: { name: 'France', postcode: /^\d{5}$/, example: '75001' },
  NL: { name: 'Netherlands', postcode: /^\d{4}\s*[A-Z]{2}$/i, example: '1012 AB' },
});

export function normalisePostcode(country, postcode) {
  const c = COUNTRIES[country];
  // Spaces anywhere are ignored ("BB 12 9BY", "bb129by"): checked without them, then written the one way.
  const t = String(postcode ?? '').toUpperCase().replace(/\s+/g, '');
  if (!c) throw fail(400, `Homes can be added in ${Object.keys(COUNTRIES).join(', ')} for now`);
  if (!c.postcode.test(t)) throw fail(400, `That is not a ${c.name} postcode (for example ${c.example})`);
  if (country === 'GB') return `${t.slice(0, -3)} ${t.slice(-3)}`;
  if (country === 'NL') return `${t.slice(0, 4)} ${t.slice(4)}`;
  return t;
}

// A new home for the user: { country, postcode, name? }. In GB the postcode is looked up now (coordinates,
// grid supply point, carbon region) so the next step can show the region; when the look-up fails the
// home is still made and the first sync tries again.
export async function addHome(user, { country = 'GB', postcode, name = null } = {}) {
  if (!user) throw fail(401, 'Sign in first');
  const cc = String(country ?? 'GB').toUpperCase();
  const pc = normalisePostcode(cc, postcode);
  let site;
  try { site = createSite({ name: String(name ?? '').trim().slice(0, 100) || `Home ${pc}`, postcode: pc, country: cc }); } catch (err) { throw fail(400, err.message); }
  giveHome(user.id, site.id);
  ensureSharedConnections(site);
  let geoError = null;
  if (cc === 'GB') {
    try { site = await hooks.geo(site); } catch (err) { geoError = `The postcode could not be looked up yet (${err.message}); the first sync tries again.`; }
  }
  return { site, geoError };
}

// ───────────── The providers it can connect ─────────────

// The login each provider asks for. secret fields are stored encrypted and never shown again.
export const FIELDS = Object.freeze({
  sunsynk: [
    { key: 'username', label: 'Sunsynk Connect email', type: 'email', required: true },
    { key: 'password', label: 'Sunsynk Connect password', type: 'password', required: true, secret: true },
    // Not typed: picked from the plants the login sees (findPlants), after the email and password.
    { key: 'plantId', label: 'Plant', type: 'text', required: false, pick: true },
  ],
  octopus: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, secret: true, help: 'From your Octopus dashboard: Personal details, API access' },
    { key: 'accountNumber', label: 'Account number', type: 'text', required: true, pattern: '^A-[0-9A-Fa-f]{8}$', placeholder: 'A-1234ABCD' },
  ],
});
const ABOUT = {
  sunsynk: { name: 'Sunsynk', what: 'Your inverter: solar, battery and home use every 5 minutes.' },
  octopus: { name: 'Octopus Energy', what: 'Your smart meter and tariff: half-hourly import and export, and the prices you pay.' },
  linky: { name: 'Linky (Enedis)', what: 'Your smart meter: half-hourly import and export.' },
  p1: { name: 'P1 meter port', what: 'Your smart meter, read from its P1 port in the home.' },
};

// The home's providers: { connect: per-home providers (inverter, meter) as cards, each with the login
// it asks for (no values), whether it is connected and how its last sync went; automatic: the shared
// providers that need no login (weather, carbon, prices), with their status }.
export function homeProviders(site) {
  const market = site.market_code ?? 'GB';
  const conns = new Map(db.prepare('SELECT provider, external_ref, status, last_success_at, last_error, meta FROM connection WHERE site_id = ?').all(site.id).map((c) => [c.provider, c]));
  const connect = [];
  for (const r of ROLES.filter((x) => x.scope === 'home')) {
    for (const row of providersFor(db, market, r.role)) {
      const impl = adapterFor(row.adapter);
      const fields = FIELDS[row.adapter] ?? null;
      const reason = !row.enabled ? 'Coming soon: not switched on yet'
        : !impl ? 'Coming soon: not built yet'
          : !licensed(row, impl) ? 'Coming soon: licence not confirmed'
            : row.owner !== 'core' ? 'Run by another service' : !fields ? 'Connected another way' : null;
      const conn = conns.get(impl?.connection ?? row.adapter);
      const stored = conn ? hasSecret(site.id, impl?.connection ?? row.adapter) : false;
      connect.push({
        role: r.role, role_label: r.label, adapter: row.adapter, ...(ABOUT[row.adapter] ?? { name: row.adapter, what: '' }),
        available: !reason, reason, fields: reason ? [] : fields,
        connected: !!conn && (stored || site.env_key === 'env'), login: stored ? 'stored' : conn && site.env_key === 'env' ? 'env' : null,
        external_ref: conn?.external_ref ?? null, account: !conn ? null : JSON.parse(conn.meta || '{}').account
          ?? (conn.external_ref ? (row.adapter === 'sunsynk' ? { plantId: conn.external_ref } : { accountNumber: conn.external_ref }) : null),
        can_disconnect: stored, status: conn?.status ?? null, last_success_at: conn?.last_success_at ?? null, last_error: conn?.last_error ?? null,
      });
    }
  }
  const automatic = providerStatus(db, site).filter((p) => p.scope === 'shared' && p.adapter && p.status !== 'none')
    .map((p) => ({ role: p.role, label: p.label, adapter: p.adapter, status: p.status, reason: p.reason ?? null }));
  return { secrets_ready: secretsReady(), connect, automatic };
}

// ───────────── Picking the plant (Sunsynk) ─────────────

// The plants a login sees, for the user to pick one before connecting: { plants: [{ id, name,
// address }] }. Nothing is stored. 400 when the login is refused.
export async function findPlants(user, site, { provider, credentials } = {}) {
  if (!user) throw fail(401, 'Sign in first');
  const card = homeProviders(site).connect.find((c) => c.adapter === provider);
  if (!card?.available || !hooks.plants[provider]) throw fail(400, `${card?.name ?? provider} has no plants to pick`);
  const given = credentials && typeof credentials === 'object' ? credentials : {};
  const creds = {};
  for (const f of card.fields.filter((x) => x.required)) {
    const v = given[f.key] == null ? '' : String(given[f.key]).trim();
    if (!v) throw fail(400, `${f.label} is needed`);
    creds[f.key] = v;
  }
  let plants;
  try { plants = await hooks.plants[provider](creds); } catch (err) { throw fail(400, `${card.name} did not accept this login: ${err.message}`); }
  return { plants };
}

// ───────────── Connecting one ─────────────

// Connect a provider to the user's home with their login: { provider, credentials }. Refused unless
// the provider is one of the home's available cards and every required field is given; the login is
// checked against the provider (400 with its answer when refused), stored encrypted, the connection
// row made, and the home's first sync started (not awaited). The reply never echoes a secret.
export async function connectHome(user, site, { provider, credentials } = {}) {
  if (!user) throw fail(401, 'Sign in first');
  const card = homeProviders(site).connect.find((c) => c.adapter === provider);
  if (!card) throw fail(400, `${provider} is not a provider for this home`);
  if (!card.available) throw fail(400, `${card.name}: ${card.reason}`);
  const given = credentials && typeof credentials === 'object' && !Array.isArray(credentials) ? credentials : {};
  const creds = {};
  for (const f of card.fields) {
    const raw = given[f.key] == null ? '' : String(given[f.key]).trim();
    const v = f.key === 'accountNumber' ? raw.toUpperCase() : raw;
    if (!v) { if (f.required) throw fail(400, `${f.label} is needed`); continue; }
    if (v.length > 500) throw fail(400, `${f.label} is too long`);
    if (f.pattern && !new RegExp(f.pattern).test(v)) throw fail(400, `${f.label} should look like ${f.placeholder}`);
    creds[f.key] = v;
  }
  if (!secretsReady()) throw fail(503, 'Logins cannot be stored: SECRET_KEY (32+ characters) is not set in .env');
  let checked;
  try { checked = await hooks.verify[provider](creds); } catch (err) { throw fail(400, `${card.name} did not accept this login: ${err.message}`); }
  if (provider === 'sunsynk' && checked?.plantId) creds.plantId = checked.plantId;
  // Another account than the one connected: its data must not mix with the old one's, so the old
  // one is disconnected first (same account, e.g. a new password: the data stays).
  const was = card.account;
  const other = provider === 'sunsynk' ? was?.plantId != null && String(was.plantId) !== String(creds.plantId ?? checked?.plantId)
    : was?.accountNumber != null && was.accountNumber !== creds.accountNumber;
  let replaced = null;
  if (card.connected && card.can_disconnect && other) replaced = disconnectHome(user, site, provider);
  putSecret(site.id, adapterFor(provider).connection, creds);
  connectProvider(db, site, { provider, role: card.role, credentials: creds });
  // Which account this is, to show on the card (no secret: the login name, plant or account).
  const account = provider === 'sunsynk' ? { login: creds.username, plantId: checked?.plantId ?? creds.plantId ?? null, plantName: checked?.plantName ?? null }
    : { accountNumber: creds.accountNumber, postcode: checked?.postcode ?? null };
  const conn = db.prepare('SELECT meta FROM connection WHERE site_id = ? AND provider = ?').get(site.id, adapterFor(provider).connection);
  db.prepare('UPDATE connection SET meta = ? WHERE site_id = ? AND provider = ?').run(JSON.stringify({ ...JSON.parse(conn?.meta || '{}'), account }), site.id, adapterFor(provider).connection);
  Promise.resolve().then(() => hooks.startSync(site.id)).catch((err) => console.error(`first sync of home ${site.id}:`, err.message));
  const { password, apiKey, ...shown } = checked ?? {};
  return { connected: true, provider, role: card.role, checked: shown, syncing: true, replaced: replaced ? { withdrawn: replaced.withdrawn } : null };
}

// ───────────── Disconnecting one ─────────────

// Disconnect a provider from the user's home, e.g. after a wrong login: its stored login and its
// connection are removed, and the data it brought is withdrawn from the home (superseded, kept for
// the history, with a fact_correction row saying why), its meters retired, and the details it gave
// (panel size, battery size from the inverter) withdrawn. The home's built days are rebuilt without
// it. Connecting again (any account) starts with the full first window, as a new provider.
export function disconnectHome(user, site, provider) {
  if (!user) throw fail(401, 'Sign in first');
  const card = homeProviders(site).connect.find((c) => c.adapter === provider);
  if (!card) throw fail(400, `${provider} is not a provider for this home`);
  if (!card.connected) throw fail(400, `${card.name} is not connected to this home`);
  if (!card.can_disconnect) throw fail(400, `${card.name} on this home is read from .env: change it there`);
  const connection = adapterFor(provider).connection;
  const mine = (col) => `(${col} = ? OR substr(${col}, 1, ?) = ?)`;   // the provider and its own sources (octopus_meter, octopus_kraken)
  const p = [provider, provider.length + 1, `${provider}_`];
  const devices = db.prepare(`SELECT id FROM device WHERE site_id = ? AND ${mine('provider')}`).all(site.id, ...p).map((d) => d.id);
  const series = db.prepare(`SELECT se.id FROM series se JOIN source so ON so.id = se.source_id WHERE
      (se.subject_kind = 'site' AND se.subject_id = ? AND ${mine('so.code')})
      OR (se.subject_kind = 'device' AND se.subject_id IN (${devices.map(() => '?').join(',') || "''"}))`)
    .all(String(site.id), ...p, ...devices.map(String)).map((r) => r.id);
  const now = Date.now();
  const reason = `${card.name} was disconnected from this home by its owner: the data it brought is withdrawn.`;
  let withdrawn = 0;
  tx(() => {
    for (const id of series) {
      const n = db.prepare('UPDATE reading SET superseded_at = ? WHERE series_id = ? AND superseded_at IS NULL').run(now, id).changes
        + db.prepare('UPDATE interval_fact SET superseded_at = ? WHERE series_id = ? AND superseded_at IS NULL').run(now, id).changes;
      if (n) db.prepare('INSERT INTO fact_correction (site_id, corrected_at, series_id, rows, reason) VALUES (?, ?, ?, ?, ?)').run(site.id, nowSec(), id, n, reason);
      withdrawn += n;
    }
    deleteSecret(site.id, connection);
    db.prepare('DELETE FROM connection WHERE site_id = ? AND provider = ?').run(site.id, connection);
  });
  for (const id of devices) retireDevice(id);
  if (provider === 'sunsynk') {
    for (const [attr, source] of [['pv_kwp', 'provider'], ['battery_kwh', 'provider'], ['battery_kwh', 'measured']]) withdrawAttribute(site.id, attr, source);
  }
  // Rebuild every day built: what the provider gave reaches back to the first one.
  const first = db.prepare('SELECT MIN(local_date) AS d FROM site_day WHERE site_id = ?').get(site.id).d;
  let rebuilt = [];
  if (first) {
    markDirty(site.id, dayBounds(site.timezone, first)[0], nowSec(), `${provider} disconnected`);
    rebuilt = processQueue().filter((r) => r.siteId === site.id);
  }
  return { disconnected: true, provider, withdrawn, devices: devices.length, rebuilt };
}
