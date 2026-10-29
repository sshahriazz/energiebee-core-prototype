// A home's provider logins (delta 077, connection_secret): the secret store the core lacked. Each login
// is encrypted with AES-256-GCM under a key derived from SECRET_KEY (.env, at least 32 characters; make
// one with `openssl rand -hex 32`), with (site_id, provider) as associated data. Without SECRET_KEY no
// login is stored or read. Nothing here ever returns a secret to the API: only the sync steps read them,
// through siteCredentials(), which falls back to .env for the .env home exactly as before.
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { envCredentials } from './providers.js';

const keyOf = (env = process.env) => (env.SECRET_KEY && env.SECRET_KEY.length >= 32 ? crypto.createHash('sha256').update(env.SECRET_KEY).digest() : null);
export const secretsReady = (env = process.env) => !!keyOf(env);
const aad = (siteId, provider) => Buffer.from(`connection_secret:${siteId}:${provider}`);

export function putSecret(siteId, provider, value) {
  const key = keyOf();
  if (!key) { const e = new Error('Logins cannot be stored: SECRET_KEY (32+ characters) is not set in .env'); e.status = 503; throw e; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(siteId, provider));
  const ciphertext = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  db.prepare(`INSERT INTO connection_secret (site_id, provider, iv, tag, ciphertext, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (site_id, provider) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, recorded_at = excluded.recorded_at`)
    .run(siteId, provider, iv, c.getAuthTag(), ciphertext, Date.now());
}

export const hasSecret = (siteId, provider) => !!db.prepare('SELECT 1 FROM connection_secret WHERE site_id = ? AND provider = ?').get(siteId, provider);

// The stored login, or null when there is none. Throws when it cannot be read (no key, another key).
export function getSecret(siteId, provider) {
  const r = db.prepare('SELECT iv, tag, ciphertext FROM connection_secret WHERE site_id = ? AND provider = ?').get(siteId, provider);
  if (!r) return null;
  const key = keyOf();
  if (!key) throw new Error('the stored login cannot be read: SECRET_KEY is not set in .env');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv));
    d.setAAD(aad(siteId, provider));
    d.setAuthTag(Buffer.from(r.tag));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(r.ciphertext)), d.final()]).toString('utf8'));
  } catch { throw new Error('the stored login cannot be read: SECRET_KEY has changed since it was stored'); }
}

export const deleteSecret = (siteId, provider) => db.prepare('DELETE FROM connection_secret WHERE site_id = ? AND provider = ?').run(siteId, provider);

// A step's credentials ({ creds } | { missing: reason }, as envCredentials): the home's stored login
// when it has one, else .env for the .env home (vars and optional map fields to variable names).
export function siteCredentials(site, provider, vars, optional = {}) {
  if (site?.id == null || !hasSecret(site.id, provider)) return envCredentials(site, vars, optional);
  let stored;
  try { stored = getSecret(site.id, provider); } catch (err) { return { missing: `no credentials: ${err.message}` }; }
  const absent = Object.keys(vars).filter((k) => !stored?.[k]);
  if (absent.length) return { missing: `no credentials: ${absent.join(', ')} not in the stored login` };
  return { creds: Object.fromEntries([...Object.keys(vars), ...Object.keys(optional)].filter((k) => stored[k]).map((k) => [k, stored[k]])) };
}
