// Users (deltas 070, 071): who is looking, and which homes they may see.
//
// Who: on the main app, a signed-in browser (the eb_session cookie, from sign-up or sign-in: a username
// and a 4-digit PIN, hashed with scrypt; delta 079). Only where USER_SWITCHER=1 (the demo server, npm run demo:start),
// the user the X-User-Id header names: the prototype's "Viewing as" switch, no password, which wins over
// any cookie. Elsewhere that header is refused, so on the main app nobody can become someone else.
// What they see: a user sees the homes user_site gives them (an admin every home). Nobody signed in
// sees only the homes NO user owns: the .env home and every home of a database without users, exactly
// as before users existed (scripts and tests that name no user see what they always did), but never a
// home someone signed up for.
import crypto from 'node:crypto';
import { db } from '../db/db.js';

export const USER_HEADER = 'x-user-id';
export const SESSION_COOKIE = 'eb_session';
export const SESSION_DAYS = 30;
export const switcherOn = (env = process.env) => env.USER_SWITCHER === '1';
// Whether nobody signed in is shown nothing: on, except on the demo server (the switch picks the user) and where
// REQUIRE_LOGIN=0 (tests that read homes without a user, as before accounts existed).
export const loginRequired = (env = process.env) => env.REQUIRE_LOGIN !== '0' && !switcherOn(env);
const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

export function listUsers() {
  return db.prepare(`SELECT u.id, u.name, u.username, u.role, u.note,
      (SELECT COUNT(*) FROM user_site us WHERE us.user_id = u.id) AS homes
    FROM app_user u ORDER BY u.id`).all();
}

export const userById = (id) => db.prepare('SELECT * FROM app_user WHERE id = ?').get(id) ?? null;
// A user as the API shows it: never the PIN hash.
export const publicUser = (u) => (u ? { id: u.id, name: u.name, username: u.username, role: u.role } : null);

export function createUser({ name, username = null, email = null, role = 'owner', note = null, pinHash = null }) {
  const r = db.prepare('INSERT INTO app_user (name, username, email, role, note, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, username, email, role, note, pinHash, Date.now());
  return userById(Number(r.lastInsertRowid));
}

export function giveHome(userId, siteId) {
  db.prepare('INSERT OR IGNORE INTO user_site (user_id, site_id, recorded_at) VALUES (?, ?, ?)').run(userId, siteId, Date.now());
}

// ───────────── PINs and sessions ─────────────

// A username and a 4-digit PIN (delta 079). A PIN has only ten thousand values, so it is kept as a slow scrypt
// hash and an account locks for LOCK_MINUTES after PIN_TRIES wrong PINs in a row.
export const PIN_TRIES = 5;
export const LOCK_MINUTES = 15;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPin(pin, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;
export const normUsername = (u) => String(u ?? '').trim().toLowerCase();
// 400 unless the PIN is 4 digits.
export function checkPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw fail(400, 'The PIN must be exactly 4 digits');
}

// A new account: { username, pin, name? } -> the user (named by the username when no name is given). 400 on a
// bad username or PIN, 409 on a username already taken (any case).
export function signUp({ username, pin, name = null } = {}) {
  const un = normUsername(username);
  if (!USERNAME.test(un)) throw fail(400, 'Choose a username of 3 to 30 letters or digits (dots, dashes and underscores allowed)');
  checkPin(pin);
  if (db.prepare('SELECT 1 FROM app_user WHERE username = ?').get(un)) throw fail(409, 'That username is taken: choose another, or sign in');
  const nm = String(name ?? '').trim().slice(0, 100) || un;
  return createUser({ name: nm, username: un, role: 'owner', pinHash: hashPin(pin) });
}

// The user a username and PIN belong to, or 401 with the same words whichever was wrong. A locked account
// answers 429 until its lock ends, even to the right PIN.
export function signIn({ username, pin } = {}, now = Date.now()) {
  const u = db.prepare('SELECT * FROM app_user WHERE username = ?').get(normUsername(username));
  if (u?.locked_until > now) throw fail(429, `Too many wrong PINs: try again in ${Math.ceil((u.locked_until - now) / 60000)} min`);
  // Hash anyway when there is no such user, so the answer takes as long either way.
  const ok = u?.pin_hash ? verifyPin(pin ?? '', u.pin_hash) : (hashPin(String(pin ?? '')), false);
  if (!ok) {
    if (u) {
      const n = (u.failed_logins ?? 0) + 1;
      const lock = n >= PIN_TRIES;
      db.prepare('UPDATE app_user SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : n, lock ? now + LOCK_MINUTES * 60000 : null, u.id);
      if (lock) throw fail(429, `Too many wrong PINs: try again in ${LOCK_MINUTES} min`);
    }
    throw fail(401, 'Username or PIN is wrong');
  }
  if (u.failed_logins || u.locked_until) db.prepare('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
  return u;
}

// A new PIN for an account (scripts/set-pin.js): unlocks it and signs out every browser it was signed in on.
export function setPin(username, pin) {
  const u = db.prepare('SELECT * FROM app_user WHERE username = ?').get(normUsername(username));
  if (!u) throw fail(404, `No user named ${normUsername(username)}`);
  checkPin(pin);
  db.prepare('UPDATE app_user SET pin_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashPin(pin), u.id);
  db.prepare('DELETE FROM user_session WHERE user_id = ?').run(u.id);
  return userById(u.id);
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
// A new session for the user: the cookie's token (only its hash is stored).
export function startSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM user_session WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO user_session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now, now + SESSION_DAYS * 86400000);
  return token;
}
export const endSession = (token) => { if (token) db.prepare('DELETE FROM user_session WHERE token_hash = ?').run(tokenHash(token)); };
const sessionUser = (token) => {
  if (!token) return null;
  const s = db.prepare('SELECT user_id FROM user_session WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now());
  return s ? userById(s.user_id) : null;
};

export function cookieOf(req, name = SESSION_COOKIE) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
export const sessionCookie = (token, maxAgeS = SESSION_DAYS * 86400) => `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? maxAgeS : 0}`;

// ───────────── Who is asking ─────────────

// Where the switch is on (the demo server), the user X-User-Id names: the dropdown always wins, so
// switching works whoever signed up last. Otherwise the signed-in user (session cookie), else null.
// A stale or expired cookie is no user. The header where the switch is off is 403; an id that is not
// a user is 401, so a stale choice in the browser is noticed instead of showing other homes.
export function userOf(req) {
  const h = req.get(USER_HEADER);
  if (h != null && h !== '') {
    if (!switcherOn()) throw fail(403, 'User switching is off: sign in instead');
    const u = /^\d+$/.test(h) ? userById(Number(h)) : null;
    if (!u) throw fail(401, 'Unknown user');
    return u;
  }
  return sessionUser(cookieOf(req));
}

const owned = (siteId) => !!db.prepare('SELECT 1 FROM user_site WHERE site_id = ?').get(siteId);

// Whether the user may see a home: an admin every home, a user theirs, nobody the homes no user owns.
export function canSee(user, siteId) {
  if (user?.role === 'admin') return true;
  if (!user) return !owned(siteId);
  return !!db.prepare('SELECT 1 FROM user_site WHERE user_id = ? AND site_id = ?').get(user.id, siteId);
}

// The ids of the homes the user may see, null for every home (an admin, or nobody while no home is owned).
export function visibleSiteIds(user) {
  if (user?.role === 'admin') return null;
  if (!user) {
    if (!db.prepare('SELECT 1 FROM user_site LIMIT 1').get()) return null;
    return new Set(db.prepare('SELECT id FROM site WHERE id NOT IN (SELECT site_id FROM user_site)').all().map((r) => r.id));
  }
  return new Set(db.prepare('SELECT site_id FROM user_site WHERE user_id = ?').all(user.id).map((r) => r.site_id));
}
