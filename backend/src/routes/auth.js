// Sign-in, sessions and password management.
//
// Spec section 27: strong authentication, session expiry, login history, rate
// limiting and immediate revocation for leavers.

const express = require('express');
const router = express.Router();

const rbac = require('../domain/rbac');
const { requireUser } = require('../middleware/auth');
const { audit, db } = require('../db');
const T = require('../util/time');

// Per-IP throttle in front of the per-account lockout. The account lockout
// stops one account being ground down; this stops one host working through a
// list of accounts, which the per-account counter would never notice.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 30;

function ipThrottled(ip) {
  const nowMs = T.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < nowMs) {
    attempts.set(ip, { count: 1, resetAt: nowMs + WINDOW_MS });
    return false;
  }
  rec.count++;
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (v.resetAt < nowMs) attempts.delete(k);
  }
  return rec.count > MAX_PER_IP;
}

function present(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    employeeId: user.employeeId,
    roles: user.roles,
    // Serialised so the dashboard can hide controls the user cannot use.
    // Never the authority on access - the server re-checks on every request.
    permissions: [...user.permissions].sort(),
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (ipThrottled(ip)) {
    return res.status(429).json({
      status: 'ERROR', code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts. Try again shortly.',
    });
  }

  const { email, password } = req.body || {};
  try {
    const result = await rbac.login({
      email, password, ip,
      userAgent: req.headers['user-agent'] || null,
    });
    res.json({
      status: 'SUCCESS',
      token: result.token,
      expiresAt: result.expiresAt,
      user: present(result.user),
    });
  } catch (err) {
    const code = err.code === 'LOCKED' ? 423 : 401;
    res.status(code).json({ status: 'ERROR', code: err.code || 'BAD_CREDENTIALS', message: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', requireUser, async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers['x-session-token'];
  await rbac.revokeSession(token);
  res.json({ status: 'SUCCESS', message: 'Signed out.' });
});

// GET /api/auth/me
router.get('/me', requireUser, (req, res) => {
  res.json({ status: 'SUCCESS', user: present(req.auth) });
});

// POST /api/auth/change-password
router.post('/change-password', requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    await rbac.changePassword({
      userId: req.auth.id,
      currentPassword: currentPassword ?? '',
      newPassword,
      actor: `user:${req.auth.id}`,
    });
    // Every session was revoked, including this one, so a fresh sign-in is
    // required rather than leaving the old token usable.
    res.json({ status: 'SUCCESS', message: 'Password changed. Please sign in again.' });
  } catch (err) {
    res.status(err.code === 'BAD_CREDENTIALS' ? 401 : 400)
      .json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

// GET /api/auth/sessions - the user's own active sessions.
router.get('/sessions', requireUser, async (req, res) => {
  const rows = await db.prepare(`
    SELECT issued_at, expires_at, last_used_at, ip, user_agent
    FROM user_sessions
    WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY issued_at DESC
  `).all(req.auth.id, T.now());

  res.json({
    status: 'SUCCESS',
    sessions: rows.map(r => ({
      signedInAt: T.displayTime(r.issued_at),
      expiresAt: T.displayTime(r.expires_at),
      lastUsed: r.last_used_at ? T.displayTime(r.last_used_at) : null,
      ip: r.ip,
      userAgent: r.user_agent,
    })),
  });
});

// GET /api/auth/login-history - spec 27 requires this to be visible.
router.get('/login-history', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = await db.prepare(
    'SELECT at, outcome, ip, user_agent FROM login_events WHERE user_id = ? ORDER BY at DESC LIMIT ?'
  ).all(req.auth.id, limit);

  res.json({
    status: 'SUCCESS',
    events: rows.map(r => ({
      at: T.displayTime(r.at),
      date: T.dateKey(r.at),
      outcome: r.outcome,
      ip: r.ip,
      userAgent: r.user_agent,
    })),
  });
});

// POST /api/auth/revoke-all - "sign out everywhere" after a suspected compromise.
router.post('/revoke-all', requireUser, async (req, res) => {
  const count = await rbac.revokeAllSessions(req.auth.id);
  await audit({
    actor: `user:${req.auth.id}`, action: 'SESSIONS_REVOKED',
    targetType: 'user', targetId: req.auth.id, after: { revoked: count },
  });
  res.json({ status: 'SUCCESS', revoked: count });
});

module.exports = router;
