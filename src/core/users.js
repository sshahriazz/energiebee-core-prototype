// Users (deltas 070, 071): who is looking, and which homes they may see.
//
// Who: on the main app, a signed-in browser (the eb_session cookie, from sign-up or sign-in: an email
// and a password, hashed with scrypt). Only where USER_SWITCHER=1 (the demo server, npm run demo:start),
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
const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

export function listUsers() {
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.note,
      (SELECT COUNT(*) FROM user_site us WHERE us.user_id = u.id) AS homes
    FROM app_user u ORDER BY u.id`).all();
}

export const userById = (id) => db.prepare('SELECT * FROM app_user WHERE id = ?').get(id) ?? null;
// A user as the API shows it: never the password hash.
export const publicUser = (u) => (u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null);

export function createUser({ name, email = null, role = 'owner', note = null, passwordHash = null }) {
  const r = db.prepare('INSERT INTO app_user (name, email, role, note, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, email, role, note, passwordHash, Date.now());
  return userById(Number(r.lastInsertRowid));
}

export function giveHome(userId, siteId) {
  db.prepare('INSERT OR IGNORE INTO user_site (user_id, site_id, recorded_at) VALUES (?, ?, ?)').run(userId, siteId, Date.now());
}

// ───────────── Passwords and sessions ─────────────

const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();

// A new account: { email, password, name? } -> the user. 400 on a bad email or a short password, 409 on
// an email already used.
export function signUp({ email, password, name = null } = {}) {
  const em = normEmail(email);
  if (!EMAIL.test(em) || em.length > 200) throw fail(400, 'Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) throw fail(400, 'The password needs at least 8 characters');
  if (password.length > 200) throw fail(400, 'The password is too long (200 characters at most)');
  if (db.prepare('SELECT 1 FROM app_user WHERE email = ?').get(em)) throw fail(409, 'An account with this email already exists: sign in instead');
  const nm = String(name ?? '').trim().slice(0, 100) || em.split('@')[0];
  return createUser({ name: nm, email: em, role: 'owner', passwordHash: hashPassword(password) });
}

// The user an email and password belong to, or 401 with the same words whichever was wrong.
export function signIn({ email, password } = {}) {
  const u = db.prepare('SELECT * FROM app_user WHERE email = ?').get(normEmail(email));
  // Hash anyway when there is no such user, so the answer takes as long either way.
  const ok = u?.password_hash ? verifyPassword(password ?? '', u.password_hash) : (hashPassword(String(password ?? '')), false);
  if (!ok) throw fail(401, 'Email or password is wrong');
  return u;
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
