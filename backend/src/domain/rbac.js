// Users, passwords, sessions and permission resolution.
//
// Spec section 3. Two things here are doing the real work:
//
// 1. Permissions are resolved from roles PLUS per-user grants, so HR can give
//    one manager access to one sensitive area without inventing a new role.
//    Spec 3.2: "These should require explicit permission."
//
// 2. Access to a given employee is a separate question from holding a
//    permission. A manager with attendance.read may read attendance for their
//    assigned reports and nobody else, and an employee may only ever read
//    themselves. Checking the permission alone would leak the whole workforce.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const T = require('../util/time');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // 12h; spec 27 requires expiry
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// --- passwords -------------------------------------------------------------

// scrypt via node's crypto: memory-hard, no native dependency to build, and
// nothing here ever stores or transmits a reversible form of the password.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, r, p, saltHex, keyHex] = stored.split('$');
  try {
    const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    const expected = Buffer.from(keyHex, 'hex');
    if (key.length !== expected.length) return false;
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Minimum password policy. Deliberately length-first: a long passphrase beats
 * a short string with a symbol bolted on.
 */
function passwordProblems(password) {
  const problems = [];
  if (!password || password.length < 12) problems.push('must be at least 12 characters');
  if (/^\d+$/.test(password || '')) problems.push('cannot be only digits');
  const common = ['password', '12345678', 'qwerty', 'letmein', 'forgottenwomen'];
  if (common.some(c => (password || '').toLowerCase().includes(c))) {
    problems.push('must not contain a common word or the organisation name');
  }
  return problems;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// --- users -----------------------------------------------------------------

const insertUser = db.prepare(`
  INSERT INTO users (id, email, display_name, password_hash, employee_id, active,
                     must_change_password, created_at, updated_at)
  VALUES (@id, @email, @display_name, @password_hash, @employee_id, 1,
          @must_change_password, @now, @now)
`);
const insertUserRole = db.prepare(
  'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at, granted_by) VALUES (?,?,?,?)'
);

function createUser({ email, displayName, password, roles = [], employeeId = null,
                      mustChangePassword = false, actor = 'system' }) {
  if (!email || !String(email).includes('@')) throw new Error('A valid email is required.');
  if (!displayName) throw new Error('A display name is required.');

  const problems = passwordProblems(password);
  if (problems.length) throw new Error(`Password ${problems.join('; ')}.`);

  const known = new Set(db.prepare('SELECT id FROM roles').all().map(r => r.id));
  for (const r of roles) if (!known.has(r)) throw new Error(`Unknown role: ${r}`);

  const id = 'usr_' + crypto.randomBytes(8).toString('hex');
  const nowMs = T.now();

  tx(() => {
    insertUser.run({
      id,
      email: String(email).trim().toLowerCase(),
      display_name: String(displayName).trim(),
      password_hash: hashPassword(password),
      employee_id: employeeId,
      must_change_password: mustChangePassword ? 1 : 0,
      now: nowMs,
    });
    for (const r of roles) insertUserRole.run(id, r, nowMs, actor);
    audit({
      actor, action: 'USER_CREATED', targetType: 'user', targetId: id,
      after: { email, displayName, roles, employeeId },
    });
  })();

  return { id, email, displayName, roles };
}

// --- permission resolution -------------------------------------------------

const selectRolePermissions = db.prepare(`
  SELECT DISTINCT rp.permission_id AS id
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  WHERE ur.user_id = ?
`);
const selectDirectGrants = db.prepare(`
  SELECT permission_id AS id FROM user_permission_grants
  WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
`);
const selectUserRoles = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?');

/** Every permission a user holds, from roles and explicit grants combined. */
function permissionsFor(userId, nowMs = T.now()) {
  const out = new Set();
  for (const r of selectRolePermissions.all(userId)) out.add(r.id);
  for (const r of selectDirectGrants.all(userId, nowMs)) out.add(r.id);
  return out;
}

function rolesFor(userId) {
  return selectUserRoles.all(userId).map(r => r.role_id);
}

// --- employee scoping ------------------------------------------------------

const selectManagedEmployees = db.prepare(`
  SELECT employee_id FROM manager_assignments
  WHERE manager_employee_id = ? AND ended_at IS NULL
`);

/**
 * Whether `user` may see `employeeId` at all, before any question of which
 * fields. Holding a permission is necessary but never sufficient.
 */
function canAccessEmployee(user, employeeId) {
  if (!employeeId) return false;
  // HR and Super Admin see the whole workforce.
  if (user.roles.includes('hr') || user.roles.includes('super_admin')) return true;
  // Anyone may see themselves.
  if (user.employeeId && user.employeeId === employeeId) return true;
  // A manager sees their assigned reports, and only those.
  if (user.roles.includes('manager') && user.employeeId) {
    return selectManagedEmployees.all(user.employeeId).some(r => r.employee_id === employeeId);
  }
  return false;
}

/** The set of employee ids a user may see, for list endpoints. */
function accessibleEmployeeIds(user) {
  if (user.roles.includes('hr') || user.roles.includes('super_admin')) {
    return db.prepare('SELECT id FROM employees').all().map(r => r.id);
  }
  const ids = new Set();
  if (user.employeeId) ids.add(user.employeeId);
  if (user.roles.includes('manager') && user.employeeId) {
    for (const r of selectManagedEmployees.all(user.employeeId)) ids.add(r.employee_id);
  }
  return [...ids];
}

// --- authentication --------------------------------------------------------

const selectUserByEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const logLogin = db.prepare(`
  INSERT INTO login_events (user_id, email_tried, at, outcome, ip, user_agent)
  VALUES (?,?,?,?,?,?)
`);
const insertSession = db.prepare(`
  INSERT INTO user_sessions (token_hash, user_id, issued_at, expires_at, ip, user_agent)
  VALUES (?,?,?,?,?,?)
`);

/**
 * Verifies credentials and issues a session token.
 * Returns { token, user } or throws with a deliberately generic message.
 */
function login({ email, password, ip = null, userAgent = null }) {
  const nowMs = T.now();
  const user = selectUserByEmail.get(String(email || '').trim());

  // The same message for every failure, so the endpoint cannot be used to
  // discover which email addresses have accounts.
  const fail = (outcome) => {
    logLogin.run(user ? user.id : null, String(email || ''), nowMs, outcome, ip, userAgent);
    const err = new Error('Email or password is incorrect.');
    err.code = 'BAD_CREDENTIALS';
    throw err;
  };

  if (!user) {
    // Burn comparable time so a missing account is not distinguishable by timing.
    hashPassword('placeholder-to-equalise-timing');
    return fail('NO_USER');
  }
  if (!user.active) return fail('INACTIVE');
  if (user.locked_until && user.locked_until > nowMs) {
    logLogin.run(user.id, email, nowMs, 'LOCKED', ip, userAgent);
    const err = new Error('This account is temporarily locked. Try again shortly.');
    err.code = 'LOCKED';
    throw err;
  }

  if (!verifyPassword(password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? nowMs + LOCKOUT_MS : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, lockedUntil, user.id);
    return fail('BAD_PASSWORD');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = nowMs + SESSION_TTL_MS;

  tx(() => {
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(nowMs, user.id);
    insertSession.run(sha256(token), user.id, nowMs, expiresAt, ip, userAgent);
    logLogin.run(user.id, email, nowMs, 'SUCCESS', ip, userAgent);
  })();

  return {
    token,
    expiresAt,
    user: describeUser(user.id),
  };
}

const selectSession = db.prepare(`
  SELECT s.*, u.active AS user_active
  FROM user_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
`);

/** Resolves a session token to a user, or null. */
function resolveSession(token) {
  if (!token) return null;
  const row = selectSession.get(sha256(token));
  const nowMs = T.now();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at < nowMs) return null;
  if (!row.user_active) return null;

  db.prepare('UPDATE user_sessions SET last_used_at = ? WHERE token_hash = ?')
    .run(nowMs, row.token_hash);

  return describeUser(row.user_id);
}

function revokeSession(token) {
  db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(T.now(), sha256(token));
}

/** Immediate revocation of every session for a user. Spec 27, for leavers. */
function revokeAllSessions(userId) {
  return db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(T.now(), userId).changes;
}

function describeUser(userId) {
  const u = selectUserById.get(userId);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    employeeId: u.employee_id,
    roles: rolesFor(u.id),
    permissions: permissionsFor(u.id),
    mustChangePassword: !!u.must_change_password,
    mfaEnabled: !!u.mfa_enabled,
  };
}

function changePassword({ userId, currentPassword, newPassword, actor }) {
  const u = selectUserById.get(userId);
  if (!u) throw new Error('No such user.');
  if (currentPassword !== null && !verifyPassword(currentPassword, u.password_hash)) {
    const err = new Error('Current password is incorrect.');
    err.code = 'BAD_CREDENTIALS';
    throw err;
  }
  const problems = passwordProblems(newPassword);
  if (problems.length) throw new Error(`Password ${problems.join('; ')}.`);

  tx(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), T.now(), userId);
    // Changing a password invalidates every existing session, so a stolen one
    // cannot outlive the change.
    revokeAllSessions(userId);
    audit({ actor: actor || userId, action: 'PASSWORD_CHANGED', targetType: 'user', targetId: userId });
  })();
}

module.exports = {
  hashPassword, verifyPassword, passwordProblems,
  createUser, describeUser, changePassword,
  permissionsFor, rolesFor,
  canAccessEmployee, accessibleEmployeeIds,
  login, resolveSession, revokeSession, revokeAllSessions,
  SESSION_TTL_MS, MAX_FAILED_ATTEMPTS,
};
