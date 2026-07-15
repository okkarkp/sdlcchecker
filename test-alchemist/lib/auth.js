/**
 * lib/auth.js — local-account authentication (zero external dependencies).
 *
 * Uses Node's built-in crypto: scrypt for password hashing, HMAC-signed stateless
 * session cookies (no session store, survives restarts while the secret is stable).
 * Cookies are HttpOnly + SameSite=Strict, which also provides CSRF protection for
 * state-changing requests (the browser won't send the cookie cross-site).
 *
 * Auth is OPT-IN so the local single-user experience is unchanged:
 *   • disabled by default (open, like today)
 *   • enabled when AUTH_ENABLED=true, or when any user exists, or when
 *     AUTH_ADMIN_USER + AUTH_ADMIN_PASSWORD are set (auto-seeds an admin on boot)
 *
 * Users live in data/users.json (git-ignored, chmod 600). Manage the first user
 * via the AUTH_ADMIN_* env vars; add more with addUser().
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const USERS_PATH  = path.join(DATA_DIR, 'users.json');
const SECRET_PATH = path.join(DATA_DIR, '.auth-secret');
const COOKIE      = 'ta_session';
const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ── Signing secret — stable across restarts so sessions survive ────────────────
function loadSecret() {
  if (process.env.AUTH_SESSION_SECRET) return process.env.AUTH_SESSION_SECRET;
  ensureDir();
  try { const s = fs.readFileSync(SECRET_PATH, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 }); } catch {}
  return s;
}
const SECRET = loadSecret();

// ── Password hashing (scrypt) ──────────────────────────────────────────────────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const hash     = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch { return false; }
}

// ── User store (data/users.json) ───────────────────────────────────────────────
function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); } catch { return []; } }
function writeUsers(users) { ensureDir(); fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 }); }
function findUser(username) {
  const u = String(username || '').toLowerCase();
  return readUsers().find(x => x.username.toLowerCase() === u) || null;
}
function addUser(username, password, role = 'user', tenant = 'default') {
  if (!username || !password) throw new Error('username and password required');
  const users = readUsers();
  if (users.some(x => x.username.toLowerCase() === username.toLowerCase())) throw new Error(`User "${username}" already exists`);
  users.push({ username, passwordHash: hashPassword(password), role, tenant: tenant || 'default', createdAt: new Date().toISOString() });
  writeUsers(users);
  return { username, role, tenant };
}

// Seed an admin from env on first boot (idempotent).
function seedAdmin() {
  const u = process.env.AUTH_ADMIN_USER;
  const p = process.env.AUTH_ADMIN_PASSWORD;
  if (u && p && !findUser(u)) {
    addUser(u, p, 'admin', process.env.AUTH_ADMIN_TENANT || 'default');
    console.log(`[auth] Seeded admin user "${u}" (workspace "${process.env.AUTH_ADMIN_TENANT || 'default'}") from AUTH_ADMIN_* env`);
  }
}

// ── Enablement ─────────────────────────────────────────────────────────────────
function isAuthEnabled() {
  const flag = String(process.env.AUTH_ENABLED || '').toLowerCase();
  if (flag === 'false') return false;
  if (flag === 'true')  return true;
  return readUsers().length > 0 || !!(process.env.AUTH_ADMIN_USER && process.env.AUTH_ADMIN_PASSWORD);
}

// ── Signed session tokens (stateless) ──────────────────────────────────────────
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── Cookies ──────────────────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// ── Login / current user / middleware ──────────────────────────────────────────
function login(username, password) {
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return signToken({ u: user.username, r: user.role || 'user', t: user.tenant || 'default', exp: Date.now() + SESSION_TTL_MS });
}
function currentUser(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

// Server-authoritative tenant (workspace) for the request. Returns null when auth
// is disabled (single-tenant local mode) so callers fall back to existing behavior.
// NEVER derived from client input — only from the verified session — so a client
// cannot access another workspace's data by spoofing a clientId.
function tenantOf(req) {
  if (!isAuthEnabled()) return null;
  const u = currentUser(req);
  return u ? (u.t || 'default') : null;
}
function requireAuth(req, res, next) {
  if (!isAuthEnabled()) return next();
  const user = currentUser(req);
  if (user) { req.user = user; return next(); }
  return res.status(401).json({ error: 'Authentication required', authRequired: true });
}

module.exports = {
  isAuthEnabled, seedAdmin, addUser, findUser, readUsers,
  login, currentUser, tenantOf, requireAuth,
  setSessionCookie, clearSessionCookie,
  hashPassword, verifyPassword,   // exported for tests
  COOKIE,
};
