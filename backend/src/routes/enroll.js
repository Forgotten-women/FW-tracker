// Device enrolment.

const express = require('express');
const router = express.Router();

const { db, tx, audit } = require('../db');
const { newToken, sha256 } = require('../middleware/auth');
const { pushDeviceAndToken, pushEnrollmentCode } = require('../db/supabase-sync');
const T = require('../util/time');
const crypto = require('crypto');

const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

const attempts = new Map();
const MAX_ATTEMPTS = 20;
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
router.post('/', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ status: 'ERROR', code: 'RATE_LIMITED', message: 'Too many enrolment attempts. Try again later.' });
  }

  const { code, platform, model, label } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ status: 'ERROR', code: 'NO_CODE', message: 'An enrolment code is required.' });
  }

  // Normalize code: strip spaces/hyphens and test both canonical forms
  const rawClean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const hyphenated = rawClean.length === 8 ? `${rawClean.slice(0, 4)}-${rawClean.slice(4)}` : rawClean;

  const row = selectCode.get(sha256(hyphenated)) || selectCode.get(sha256(rawClean));
  const nowMs = T.now();

  const reject = () => res.status(401).json({
    status: 'ERROR', code: 'BAD_CODE',
    message: 'That enrolment code is not valid, has expired, or has already been used.',
  });

  const plat = String(platform || 'unknown').toLowerCase();
  const isDesktop = plat.includes('win') || plat.includes('mac') || plat.includes('darwin') || plat.includes('linux');
  const isMobile = plat.includes('android') || plat.includes('ios');
  const deviceType = isDesktop ? 'desktop' : 'mobile';

  if (!row) return reject();
  if (row.expires_at < nowMs) return reject();

  if (row.used_at) {
    // Check if the previous enrollment was for the complementary device type (1 mobile + 1 desktop per code)
    const prevDevice = row.used_by_device ? db.prepare('SELECT platform, device_type FROM devices WHERE id = ?').get(row.used_by_device) : null;
    if (prevDevice) {
      const prevPlat = String(prevDevice.platform || '').toLowerCase();
      const prevIsDesktop = prevPlat.includes('win') || prevPlat.includes('mac') || prevPlat.includes('darwin') || prevPlat.includes('linux') || prevDevice.device_type === 'desktop';
      const prevIsMobile = prevPlat.includes('android') || prevPlat.includes('ios') || prevDevice.device_type === 'mobile';

      // If already used for desktop and this is desktop, or already used for mobile and this is mobile, reject
      if ((prevIsDesktop && isDesktop) || (prevIsMobile && isMobile)) {
        return reject();
      }
    } else {
      return reject();
    }
  }

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
      label: String(label || (isDesktop ? 'Work Laptop' : 'Mobile Phone')).slice(0, 80),
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

  // AWAITED, not fire-and-forget.
  //
  // These writes used to be started and abandoned, with the 201 sent
  // immediately afterwards. On a serverless host the instance freezes the
  // moment the response goes out, so the writes were routinely killed in
  // flight: the token existed only in that instance's local database. The
  // phone's very next request reached a different instance, got BAD_TOKEN, and
  // the app treated that as "not enrolled" and returned to the pairing screen.
  //
  // The token must be durable BEFORE we hand it to the device, otherwise we are
  // issuing a credential we have not actually saved.
  try {
    await pushDeviceAndToken(
      { id: deviceId, employee_id: employee.id, platform: String(platform || 'unknown'), model: String(model || ''), label: String(label || ''), enrolled_at: nowMs },
      { token_hash: hash, device_id: deviceId, issued_at: nowMs, expires_at: nowMs + TOKEN_TTL_MS }
    );
    await pushEnrollmentCode({ code_hash: row.code_hash, employee_id: employee.id, created_at: row.created_at, expires_at: row.expires_at, used_at: nowMs, used_by_device: deviceId });
  } catch (err) {
    console.error('[enroll] could not persist the device token:', err.message);
    return res.status(503).json({
      status: 'ERROR', code: 'ENROLMENT_NOT_SAVED',
      message: 'Could not save this device. Please try enrolling again.',
    });
  }

  res.status(201).json({
    status: 'SUCCESS',
    token,
    deviceId,
    employee: { id: employee.id, name: employee.name, role: employee.role },
    expiresAt: nowMs + TOKEN_TTL_MS,
  });
});

module.exports = router;