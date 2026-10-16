'use strict';

const crypto = require('crypto');
const { HttpError } = require('./errors');

/** Staff sessions live in memory for 8h by default. */
const SESSION_TTL_MS = Number(process.env.CAFE_SESSION_TTL_MS || 8 * 60 * 60 * 1000);

/**
 * Demo staff directory. Replace with a real identity store (or the
 * CAFE_STAFF_JSON env var) before this is anything but a demo.
 */
const DEMO_STAFF = {
  chef: { password: 'chef123', role: 'CHEF', displayName: 'Kitchen Chef' },
  waiter: { password: 'waiter123', role: 'WAITER', displayName: 'Service Waiter' }
};

function loadStaff() {
  if (!process.env.CAFE_STAFF_JSON) return DEMO_STAFF;
  try {
    const parsed = JSON.parse(process.env.CAFE_STAFF_JSON);
    const directory = {};
    Object.keys(parsed).forEach((username) => {
      const record = parsed[username];
      if (!record || typeof record !== 'object') return;
      const role = String(record.role || '').toUpperCase();
      if (role !== 'CHEF' && role !== 'WAITER') return;
      directory[username.toLowerCase()] = {
        password: String(record.password || ''),
        role,
        displayName: String(record.displayName || username)
      };
    });
    if (Object.keys(directory).length === 0) throw new Error('empty directory');
    return directory;
  } catch (err) {
    console.error('[auth] CAFE_STAFF_JSON was not usable, falling back to demo accounts:', err.message);
    return DEMO_STAFF;
  }
}

const staff = loadStaff();

/** token -> session. Lost on restart, which simply forces staff to sign in again. */
const sessions = new Map();

/** Constant-time string comparison (length is allowed to leak). */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify credentials and mint a session. The role is taken from the staff
 * directory, never from the request.
 * @throws {HttpError} 401
 */
function login(username, password) {
  const key = String(username == null ? '' : username).trim().toLowerCase();
  const record = Object.prototype.hasOwnProperty.call(staff, key) ? staff[key] : null;

  // Always run the comparison so a missing user and a wrong password are hard
  // to tell apart by timing.
  const candidate = record ? record.password : '\u0000invalid\u0000';
  const passwordOk = safeEqual(candidate, String(password == null ? '' : password));

  if (!record || !passwordOk) {
    throw new HttpError(401, 'That username or password was not recognised.', 'UNAUTHENTICATED');
  }

  const session = {
    token: crypto.randomBytes(32).toString('hex'),
    username: key,
    role: record.role,
    displayName: record.displayName,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    expiresAtMs: Date.now() + SESSION_TTL_MS
  };

  sessions.set(session.token, session);
  return session;
}

function logout(token) {
  if (token) sessions.delete(token);
}

/**
 * Resolve a bearer token to a live session.
 * @throws {HttpError} 401 when missing, unknown or expired
 */
function authenticate(token) {
  if (!token) {
    throw new HttpError(401, 'Sign in to continue.', 'UNAUTHENTICATED');
  }
  const session = sessions.get(token);
  if (!session) {
    throw new HttpError(401, 'Your session is no longer valid. Please sign in again.', 'UNAUTHENTICATED');
  }
  if (session.expiresAtMs <= Date.now()) {
    sessions.delete(token);
    throw new HttpError(401, 'Your session has expired. Please sign in again.', 'UNAUTHENTICATED');
  }
  return session;
}

/**
 * Guard a route by role. Called after authenticate().
 * @throws {HttpError} 403
 */
function requireRole(session, role) {
  if (!session || session.role !== role) {
    throw new HttpError(403, 'This action needs the ' + role + ' role.', 'FORBIDDEN');
  }
  return session;
}

module.exports = {
  SESSION_TTL_MS,
  DEMO_STAFF,
  loadStaff,
  safeEqual,
  login,
  logout,
  authenticate,
  requireRole,
  // exposed for tests
  _sessions: sessions
};
