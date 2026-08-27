// Device enrolment.
//
// Replaces the old flow, where the phone invented its own employee id as
// emp_${millis % 10000} (a 10,000-value space, generated client-side) and
// POST /register-device accepted whatever name it was sent - so anyone could
// create an employee called anything.
//
// Now an admin creates the employee and issues a single-use, short-TTL code.
// The phone exchanges that code exactly once for a device-bound token.

const express = require('express');
const router = express.Router();

const { db, tx, audit } = require('../db');
const { newToken, sha256 } = require('../middleware/auth');
const T = require('../util/time');
const crypto = require('crypto');

const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// Brute-forcing an 8-character code is impractical, but rate limiting makes it
// hopeless and stops the endpoint being used to probe for valid codes.
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(ip) {
  const nowMs = T.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < nowMs) {
    attempts.set(ip, { count: 1, resetAt: nowMs + ATTEMPT_WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_ATTEMPTS;
}

const selectCode = db.prepare('SELECT * FROM enrollment_codes WHERE code_hash = ?');
const markCodeUsed = db.prepare('UPDATE enrollment_codes SET used_at = ?, used_by_device = ? WHERE code_hash = ?');
const insertDevice = db.prepare(`
  INSERT INTO devices (id, employee_id, platform, model, label, enrolled_at)
  VALUES (@id, @employee_id, @platform, @model, @label, @enrolled_at)
`);
const insertToken = db.prepare(`
  INSERT INTO device_tokens (token_hash, device_id, issued_at, expires_at)
  VALUES (?, ?, ?, ?)
`);
const selectEmployee = db.prepare('SELECT id, name, role, active FROM employees WHERE id = ?');

// POST /api/enroll  { code, platform, model, label }
router.post('/', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ status: 'ERROR', code: 'RATE_LIMITED', message: 'Too many enrolment attempts. Try again later.' });
  }

  const { code, platform, model, label } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ status: 'ERROR', code: 'NO_CODE', message: 'An enrolment code is required.' });
  }

  const normalized = code.trim().toUpperCase();
  const row = selectCode.get(sha256(normalized));
  const nowMs = T.now();

  // Deliberately the same message for every failure mode, so the response
  // cannot be used to distinguish "wrong code" from "already used".
  const reject = () => res.status(401).json({
    status: 'ERROR', code: 'BAD_CODE',
    message: 'That enrolment code is not valid, has expired, or has already been used.',
  });

  if (!row) return reject();
  if (row.used_at) return reject();
  if (row.expires_at < nowMs) return reject();

  const employee = selectEmployee.get(row.employee_id);
  if (!employee || !employee.active) return reject();

  const deviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
  const { token, hash } = newToken();

  const run = tx(() => {
    insertDevice.run({
      id: deviceId,
      employee_id: employee.id,
      platform: String(platform || 'unknown').slice(0, 20),
      model: String(model || '').slice(0, 80),
      label: String(label || '').slice(0, 80),
      enrolled_at: nowMs,
    });
    insertToken.run(hash, deviceId, nowMs, nowMs + TOKEN_TTL_MS);
    markCodeUsed.run(nowMs, deviceId, row.code_hash);
    audit({
      actor: `employee:${employee.id}`,
      action: 'DEVICE_ENROLLED',
      targetType: 'device',
      targetId: deviceId,
      after: { employeeId: employee.id, platform, model },
      note: `Enrolled from ${ip}`,
    });
    db.prepare('INSERT INTO movements (at, type, employee_id, employee_name, details) VALUES (?,?,?,?,?)')
      .run(nowMs, 'DEVICE_ENROLLED', employee.id, employee.name, `${model || 'Device'} paired`);
  });
  run();

  // The raw token is returned exactly once and never stored in the clear.
  res.status(201).json({
    status: 'SUCCESS',
    token,
    deviceId,
    employee: { id: employee.id, name: employee.name, role: employee.role },
    expiresAt: nowMs + TOKEN_TTL_MS,
  });
});

module.exports = router;
