// Authentication.
//
// Previously there was none. Every route was reachable unauthenticated with
// CORS set to "*", which meant:
//   - POST /reset-logs destroyed the entire payroll record for anyone who
//     could reach the server
//   - POST /register-device created an employee under any name
//   - POST /mobile-ping accepted a client-supplied employeeId, so marking
//     someone else present was a one-line script
//
// Three separate identities are recognised here, each with its own mechanism.

const crypto = require('crypto');
const { db } = require('../db');
const { config } = require('../config');
const T = require('../util/time');

// --- helpers ---------------------------------------------------------------

/** Constant-time string compare that does not leak length via early return. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // Still burn a comparison so timing does not distinguish length mismatch.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Generate a new opaque token. Only the hash is ever stored. */
function newToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: sha256(token) };
}

/** Generate a short human-typeable enrolment code, e.g. "K7M2-QP4X". */
function newEnrollmentCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
    if (i === 3) out += '-';
  }
  return { code: out, hash: sha256(out) };
}

// --- device (phone app) ----------------------------------------------------

const selectToken = db.prepare(`
  SELECT t.token_hash, t.device_id, t.expires_at, t.revoked_at,
         d.employee_id, d.revoked_at AS device_revoked, d.model, d.platform,
         e.name AS employee_name, e.role AS employee_role, e.active AS employee_active
  FROM device_tokens t
  JOIN devices d   ON d.id = t.device_id
  JOIN employees e ON e.id = d.employee_id
  WHERE t.token_hash = ?
`);
const markTokenUsed = db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ?');

/**
 * Authenticates a phone. On success sets req.auth to the device and the
 * employee the token is bound to.
 *
 * The employee identity comes from the TOKEN. Any employeeId in the request
 * body is ignored - that is what closes the buddy-punching hole.
 */
function requireDevice(req, res, next) {
  const token = bearer(req);
  if (!token) {
    return res.status(401).json({ status: 'ERROR', code: 'NO_TOKEN', message: 'Missing bearer token. Enrol this device first.' });
  }

  const row = selectToken.get(sha256(token));
  const nowMs = T.now();

  if (!row) return res.status(401).json({ status: 'ERROR', code: 'BAD_TOKEN', message: 'Unrecognised device token.' });
  if (row.revoked_at) return res.status(401).json({ status: 'ERROR', code: 'REVOKED', message: 'This device token has been revoked.' });
  if (row.device_revoked) return res.status(401).json({ status: 'ERROR', code: 'DEVICE_REVOKED', message: 'This device has been removed.' });
  if (row.expires_at && row.expires_at < nowMs) {
    return res.status(401).json({ status: 'ERROR', code: 'EXPIRED', message: 'Device token expired. Re-enrol this device.' });
  }
  if (!row.employee_active) {
    return res.status(403).json({ status: 'ERROR', code: 'INACTIVE', message: 'This employee record is inactive.' });
  }

  markTokenUsed.run(nowMs, row.token_hash);
  req.auth = {
    kind: 'device',
    deviceId: row.device_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    employeeRole: row.employee_role,
    model: row.model,
    platform: row.platform,
  };
  next();
}

// --- admin -----------------------------------------------------------------

/** Admin API key, via X-Admin-Key or a bearer token. */
function requireAdmin(req, res, next) {
  if (!config.adminApiKey) {
    return res.status(503).json({
      status: 'ERROR', code: 'ADMIN_NOT_CONFIGURED',
      message: 'ADMIN_API_KEY is not set on the server. Set it in backend/.env',
    });
  }
  const supplied = req.headers['x-admin-key'] || bearer(req);
  if (!supplied || !safeEqual(supplied, config.adminApiKey)) {
    return res.status(401).json({ status: 'ERROR', code: 'BAD_ADMIN_KEY', message: 'Admin authentication required.' });
  }
  req.auth = { kind: 'admin', actor: 'admin' };
  next();
}

// --- hardware sensor (ESP8266) --------------------------------------------

// Signatures already accepted, so a captured request cannot be replayed inside
// the freshness window. Bounded and swept, since this runs on a long-lived
// process.
const seenSignatures = new Map(); // signature -> expiry epoch ms
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function rememberSignature(sig, nowMs) {
  seenSignatures.set(sig, nowMs + REPLAY_WINDOW_MS);
  if (seenSignatures.size > 5000) {
    for (const [k, exp] of seenSignatures) if (exp < nowMs) seenSignatures.delete(k);
  }
}

/**
 * Verifies an HMAC-SHA256 signature over "<timestamp>.<raw body>".
 *
 * The ESP heartbeat previously had no shared secret at all, so anyone could
 * POST a fabricated device list. Requires express.json to have captured
 * req.rawBody (see server.js).
 */
function requireSensor(req, res, next) {
  const sensorId = req.headers['x-sensor-id'];
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];

  if (!sensorId || !timestamp || !signature) {
    return res.status(401).json({
      status: 'ERROR', code: 'UNSIGNED',
      message: 'Sensor requests must carry X-Sensor-Id, X-Timestamp and X-Signature.',
    });
  }

  const secret = config.sensorSecret(sensorId);
  if (!secret) {
    return res.status(401).json({ status: 'ERROR', code: 'UNKNOWN_SENSOR', message: `No shared secret configured for sensor "${sensorId}".` });
  }

  const nowMs = T.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > REPLAY_WINDOW_MS) {
    return res.status(401).json({
      status: 'ERROR', code: 'STALE',
      message: 'Sensor timestamp outside the accepted window. Check the device clock.',
    });
  }

  if (seenSignatures.has(signature)) {
    return res.status(401).json({ status: 'ERROR', code: 'REPLAY', message: 'This request has already been processed.' });
  }

  const body = req.rawBody ? req.rawBody.toString('utf8') : '';
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  if (!safeEqual(signature.toLowerCase(), expected)) {
    return res.status(401).json({ status: 'ERROR', code: 'BAD_SIGNATURE', message: 'Sensor signature did not verify.' });
  }

  rememberSignature(signature, nowMs);
  req.auth = { kind: 'sensor', sensorId: String(sensorId) };
  next();
}

// --- user sessions and permissions -----------------------------------------

const rbac = require('../domain/rbac');

/**
 * Authenticates a human user by session token.
 *
 * Kept separate from requireAdmin, which checks a single shared API key. That
 * key stays for machine access and the initial bootstrap, but it cannot say
 * WHO acted - unusable for a payroll audit trail, which is why real accounts
 * exist.
 */
function requireUser(req, res, next) {
  const token = bearer(req) || req.headers['x-session-token'];
  const user = token ? rbac.resolveSession(token) : null;

  if (!user) {
    return res.status(401).json({
      status: 'ERROR', code: 'NO_SESSION', message: 'Sign in to continue.',
    });
  }

  req.auth = { kind: 'user', actor: `user:${user.id}`, ...user };
  next();
}

/**
 * Requires one or more permissions. Use AFTER requireUser.
 *
 *   router.get('/salary', requireUser, requirePermission('employee.salary.read'), handler)
 */
function requirePermission(...needed) {
  return (req, res, next) => {
    if (!req.auth || req.auth.kind !== 'user') {
      return res.status(401).json({ status: 'ERROR', code: 'NO_SESSION', message: 'Sign in to continue.' });
    }
    const held = req.auth.permissions;
    const missing = needed.filter(p => !held.has(p));
    if (missing.length) {
      return res.status(403).json({
        status: 'ERROR', code: 'FORBIDDEN',
        message: 'You do not have permission to do that.',
        // Named so an administrator can grant exactly what is missing rather
        // than guessing, or reaching for a broader role than necessary.
        missing,
      });
    }
    next();
  };
}

/**
 * Requires that the caller may see the employee named by a route parameter.
 *
 * Separate from requirePermission on purpose: holding attendance.read says a
 * user may read attendance, not WHOSE. A manager has it for their assigned
 * reports only, and an employee only for themselves.
 */
function requireEmployeeAccess(paramName = 'employeeId') {
  return (req, res, next) => {
    const employeeId = req.params[paramName] || req.body?.[paramName];
    if (!employeeId) {
      return res.status(400).json({ status: 'ERROR', message: `${paramName} is required.` });
    }
    if (!rbac.canAccessEmployee(req.auth, employeeId)) {
      // 404 rather than 403: confirming that an employee exists is itself a
      // disclosure to someone with no business knowing.
      return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });
    }
    req.targetEmployeeId = employeeId;
    next();
  };
}

/** Allows either a signed-in user with the permission, or the shared admin key. */
// The shared admin key IS super_admin, so it must carry super_admin's full
// permission set - not just the permissions a given route names. Otherwise a
// handler that gates extra field groups on other permissions (an employee
// profile hiding bank details, say) would wrongly hide them from the admin-key
// dashboard. Loaded once and reused.
let adminPermissionSet = null;
function superAdminPermissions() {
  if (!adminPermissionSet) {
    adminPermissionSet = new Set(
      db.prepare("SELECT permission_id AS p FROM role_permissions WHERE role_id = 'super_admin'")
        .all().map(r => r.p),
    );
  }
  return adminPermissionSet;
}

function requireUserOrAdminKey(...needed) {
  return (req, res, next) => {
    const supplied = req.headers['x-admin-key'];
    if (supplied && config.adminApiKey && safeEqual(supplied, config.adminApiKey)) {
      req.auth = {
        kind: 'admin', actor: 'admin-key', roles: ['super_admin'],
        permissions: superAdminPermissions(),
      };
      return next();
    }
    requireUser(req, res, (err) => {
      if (err) return next(err);
      requirePermission(...needed)(req, res, next);
    });
  };
}

// --- SSE tickets -----------------------------------------------------------

// EventSource cannot send an Authorization header, so the dashboard exchanges
// its admin key for a single-use, short-lived ticket and passes that in the
// query string instead. This keeps the long-lived admin key out of URLs,
// access logs and browser history.

const sseTickets = new Map(); // ticket -> expiry epoch ms
const SSE_TICKET_TTL_MS = 30 * 1000;

function issueSseTicket() {
  const ticket = crypto.randomBytes(24).toString('hex');
  const nowMs = T.now();
  sseTickets.set(ticket, nowMs + SSE_TICKET_TTL_MS);
  for (const [k, exp] of sseTickets) if (exp < nowMs) sseTickets.delete(k);
  return { ticket, expiresAt: nowMs + SSE_TICKET_TTL_MS };
}

/** Redeems a ticket. Single use: a redeemed ticket is immediately discarded. */
function consumeSseTicket(ticket) {
  if (!ticket) return false;
  const exp = sseTickets.get(ticket);
  if (!exp) return false;
  sseTickets.delete(ticket);
  return exp >= T.now();
}

module.exports = {
  requireDevice, requireAdmin, requireSensor,
  requireUser, requirePermission, requireEmployeeAccess, requireUserOrAdminKey,
  newToken, newEnrollmentCode, sha256, safeEqual,
  issueSseTicket, consumeSseTicket,
};
