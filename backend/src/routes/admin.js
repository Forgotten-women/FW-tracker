// Admin API. Every route requires the admin key and every mutation is audited.
//
// This is where employee management moved to. It used to be unauthenticated on
// /api/attendance, alongside a /reset-logs endpoint that destroyed the whole
// payroll record with no backup and no audit entry.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db, tx, audit, backup } = require('../db');
const { requireAdmin, newEnrollmentCode, issueSseTicket } = require('../middleware/auth');
const P = require('../domain/presence');
const bindings = require('../domain/bindings');
const T = require('../util/time');
const { config } = require('../config');

router.use(requireAdmin);

const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- employees -------------------------------------------------------------

router.get('/employees', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*,
           COALESCE(er.job_title, e.role) AS effective_job_title,
           er.start_date AS employment_start_date,
           sh.amount AS base_salary,
           sh.currency AS salary_currency,
           sh.daily_rate AS salary_daily_rate,
           (SELECT COUNT(*) FROM devices d WHERE d.employee_id = e.id AND d.revoked_at IS NULL) AS device_count
    FROM employees e
    LEFT JOIN (
      SELECT employee_id, job_title, start_date FROM employment_records
      WHERE effective_to IS NULL
      GROUP BY employee_id
      ORDER BY effective_from DESC
    ) er ON er.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, amount, currency, daily_rate FROM salary_history
      WHERE effective_to IS NULL
      GROUP BY employee_id
      ORDER BY effective_from DESC
    ) sh ON sh.employee_id = e.id
    ORDER BY e.active DESC, e.name
  `).all();
  res.json({
    status: 'SUCCESS',
    employees: rows.map(r => ({
      id: r.id,
      name: r.name,
      role: r.effective_job_title || r.role,
      active: !!r.active,
      deviceCount: r.device_count,
      baseSalary: r.base_salary !== null && r.base_salary !== undefined ? Number(r.base_salary) : null,
      currency: r.salary_currency || null,
      dailyRate: r.salary_daily_rate !== null && r.salary_daily_rate !== undefined ? Number(r.salary_daily_rate) : null,
      startDate: r.employment_start_date || null,
      createdAt: T.displayTime(r.created_at),
    })),
  });
});

router.post('/employees', (req, res) => {
  const { name, role, baseSalary, currency, startDate, reason } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'Employee name is required.' });
  }
  const id = 'emp_' + crypto.randomBytes(6).toString('hex');
  const nowMs = T.now();
  const employee = { id, name: String(name).trim(), role: String(role || 'Team Member').trim() };
  const PR = require('../domain/payroll');

  const run = tx(() => {
    db.prepare('INSERT INTO employees (id,name,role,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
      .run(employee.id, employee.name, employee.role, nowMs, nowMs);

    if (startDate) {
      db.prepare(`
        INSERT INTO employment_records
          (id, employee_id, job_title, employment_type, start_date, effective_from, created_at, created_by, change_reason)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        'er_' + crypto.randomBytes(6).toString('hex'),
        id,
        employee.role,
        'Full-time',
        startDate,
        startDate,
        nowMs,
        'admin',
        reason || 'Initial employment record'
      );
    }

    if (baseSalary !== undefined && baseSalary !== null && Number(baseSalary) > 0) {
      PR.setSalary({
        employeeId: id,
        amount: Number(baseSalary),
        currency: currency || 'PKR',
        effectiveFrom: startDate || T.dateKey(),
        reason: reason || 'Initial base salary on onboarding',
        actor: 'admin',
      });
    }

    audit({ actor: 'admin', action: 'EMPLOYEE_CREATED', targetType: 'employee', targetId: id, after: employee });
  });
  run();

  res.status(201).json({ status: 'SUCCESS', employee });
});

router.patch('/employees/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : before.name;
  const role = req.body?.role !== undefined ? String(req.body.role).trim() : before.role;
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : before.active;

  const run = tx(() => {
    db.prepare('UPDATE employees SET name=?, role=?, active=?, updated_at=? WHERE id=?')
      .run(name, role, active, T.now(), req.params.id);
    audit({
      actor: 'admin', action: 'EMPLOYEE_UPDATED', targetType: 'employee', targetId: req.params.id,
      before: { name: before.name, role: before.role, active: !!before.active },
      after: { name, role, active: !!active },
    });
  });
  run();

  res.json({ status: 'SUCCESS', employee: { id: req.params.id, name, role, active: !!active } });
});

// --- enrolment codes -------------------------------------------------------

// Hand the returned code to the employee. It is single-use and expires in 24h.
router.post('/employees/:id/enrollment-code', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });
  if (!employee.active) return res.status(400).json({ status: 'ERROR', message: 'Employee is inactive.' });

  const { code, hash } = newEnrollmentCode();
  const nowMs = T.now();
  const expiresAt = nowMs + CODE_TTL_MS;

  const run = tx(() => {
    db.prepare('INSERT INTO enrollment_codes (code_hash, employee_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(hash, employee.id, nowMs, expiresAt);
    // The code itself is never written to the audit log - only the fact one
    // was issued. Only its hash is stored.
    audit({ actor: 'admin', action: 'ENROLLMENT_CODE_ISSUED', targetType: 'employee', targetId: employee.id });
  });
  run();

  res.status(201).json({
    status: 'SUCCESS',
    code,
    employee: { id: employee.id, name: employee.name },
    expiresAt,
    expiresAtDisplay: `${T.displayDate(expiresAt)} at ${T.displayTime(expiresAt)}`,
    message: 'Single-use code. Give it to the employee to enter in the app.',
  });
});

// --- devices ---------------------------------------------------------------

router.get('/devices', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, e.name AS employee_name FROM devices d
    JOIN employees e ON e.id = d.employee_id ORDER BY d.enrolled_at DESC
  `).all();
  res.json({
    status: 'SUCCESS',
    devices: rows.map(d => ({
      id: d.id, employeeId: d.employee_id, employeeName: d.employee_name,
      platform: d.platform, model: d.model, label: d.label,
      lastSeen: d.last_seen_at ? T.displayTime(d.last_seen_at) : 'never',
      revoked: !!d.revoked_at,
    })),
  });
});

// Revoking cuts the device off immediately: its token stops authenticating.
router.delete('/devices/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ status: 'ERROR', message: 'No such device.' });

  const nowMs = T.now();
  const run = tx(() => {
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(nowMs, req.params.id);
    db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE device_id = ?').run(nowMs, req.params.id);
    // Otherwise the sensors would keep recognising this handset and recording
    // attendance for someone who has handed their phone back.
    bindings.revokeForDevice(req.params.id, 'Device revoked by administrator');
    audit({
      actor: 'admin', action: 'DEVICE_REVOKED', targetType: 'device', targetId: req.params.id,
      before: { employeeId: device.employee_id, model: device.model },
    });
  });
  run();

  res.json({ status: 'SUCCESS', message: 'Device revoked.' });
});

// --- attendance corrections ------------------------------------------------

// Corrections are additive and attributable. The event log is never edited, so
// the original sensor record stays intact and the adjustment is visible next
// to it.
router.post('/attendance/:employeeId/:dateKey/adjust', (req, res) => {
  const { employeeId, dateKey } = req.params;
  const minutes = Number(req.body?.minutes);
  const note = String(req.body?.note || '').trim();

  if (!Number.isFinite(minutes)) {
    return res.status(400).json({ status: 'ERROR', message: 'minutes must be a number (may be negative).' });
  }
  if (!note) {
    return res.status(400).json({ status: 'ERROR', message: 'A note explaining the adjustment is required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ status: 'ERROR', message: 'dateKey must be YYYY-MM-DD.' });
  }
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  const before = P.deriveDay(employeeId, dateKey);
  const nowMs = T.now();

  const run = tx(() => {
    db.prepare(`
      INSERT INTO attendance_days (employee_id, date_key, adjustment_minutes, adjustment_note, derived_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(employee_id, date_key) DO UPDATE SET
        adjustment_minutes = excluded.adjustment_minutes,
        adjustment_note    = excluded.adjustment_note
    `).run(employeeId, dateKey, Math.round(minutes), note, nowMs);
    audit({
      actor: 'admin', action: 'ATTENDANCE_ADJUSTED',
      targetType: 'attendance', targetId: `${employeeId}/${dateKey}`,
      before: { totalMinutes: before.totalMinutes, adjustmentMinutes: before.adjustmentMinutes },
      after: { adjustmentMinutes: Math.round(minutes) },
      note,
    });
  });
  run();

  const after = P.recomputeDay(employeeId, dateKey);
  res.json({ status: 'SUCCESS', attendance: P.presentDay(after, employee) });
});

// --- audit, export, maintenance -------------------------------------------

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
  res.json({
    status: 'SUCCESS',
    entries: rows.map(r => ({
      at: T.displayTime(r.at), date: T.dateKey(r.at),
      actor: r.actor, action: r.action,
      target: r.target_id ? `${r.target_type}:${r.target_id}` : null,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      note: r.note,
    })),
  });
});

// CSV export for payroll.
router.get('/export', (req, res) => {
  const from = String(req.query.from || T.dateKey());
  const to = String(req.query.to || T.dateKey());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
  }

  const rows = db.prepare(`
    SELECT a.*, e.name, e.role FROM attendance_days a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.date_key >= ? AND a.date_key <= ?
    ORDER BY a.date_key, e.name
  `).all(from, to);

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['date,employee_id,employee_name,role,first_in,last_active,worked_minutes,adjustment_minutes,status,note'];
  for (const r of rows) {
    lines.push([
      r.date_key, r.employee_id, esc(r.name), esc(r.role),
      r.first_in_at ? T.displayTime(r.first_in_at) : '',
      r.last_active_at ? T.displayTime(r.last_active_at) : '',
      r.total_minutes, r.adjustment_minutes, r.status, esc(r.adjustment_note),
    ].join(','));
  }

  audit({ actor: 'admin', action: 'ATTENDANCE_EXPORTED', note: `${from}..${to}, ${rows.length} rows` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${from}_${to}.csv"`);
  res.send(lines.join('\n'));
});

// The audited replacement for the old unauthenticated /reset-logs. It takes a
// backup and deactivates employees; it never deletes attendance rows, because
// those are the payroll record.
router.post('/archive', async (req, res) => {
  const confirm = String(req.body?.confirm || '');
  if (confirm !== 'ARCHIVE') {
    return res.status(400).json({
      status: 'ERROR',
      message: 'Send {"confirm":"ARCHIVE"} to proceed. This deactivates all employees; attendance history is retained.',
    });
  }

  const backupPath = await backup();
  const nowMs = T.now();
  const run = tx(() => {
    const affected = db.prepare('SELECT COUNT(*) c FROM employees WHERE active = 1').get().c;
    db.prepare('UPDATE employees SET active = 0, updated_at = ? WHERE active = 1').run(nowMs);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
    db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
    audit({
      actor: 'admin', action: 'ARCHIVE_ALL', targetType: 'database',
      after: { deactivatedEmployees: affected, backup: backupPath },
      note: 'Attendance history retained',
    });
  });
  run();

  res.json({ status: 'SUCCESS', message: 'All employees deactivated and devices revoked. Attendance history retained.', backup: backupPath });
});

router.post('/backup', async (req, res) => {
  const p = await backup();
  audit({ actor: 'admin', action: 'BACKUP_CREATED', note: p });
  res.json({ status: 'SUCCESS', backup: p });
});

// Rebuild every cached attendance day from the event log. Safe by design -
// the events are the source of truth, the cache is derived.
router.post('/recompute', (req, res) => {
  const count = P.recomputeAll();
  audit({ actor: 'admin', action: 'RECOMPUTE_ALL', note: `${count} employee-days` });
  res.json({ status: 'SUCCESS', recomputedDays: count });
});

router.get('/config', (req, res) => {
  res.json({
    status: 'SUCCESS',
    office: {
      name: config.office.officeName,
      timeZone: config.timeZone,
      networks: (config.office.networks || []).map(n => ({
        name: n.name, ssid: n.ssid, band: n.band,
        bssidCount: (n.bssids || []).length, subnets: n.subnets,
      })),
      activeThresholdMinutes: config.activeThresholdMinutes,
      gracePeriodMinutes: config.gracePeriodMinutes,
      maxSessionMinutes: config.maxSessionMinutes,
      bssidEnforced: config.bssidEnforced,
      retention: config.retention,
    },
  });
});

// --- org settings ----------------------------------------------------------

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM org_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ status: 'SUCCESS', settings });
});

router.post('/settings', (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ status: 'ERROR', message: 'Key and value are required.' });
  }

  const before = db.prepare('SELECT * FROM org_settings WHERE key = ?').get(key);
  const nowMs = T.now();
  db.prepare(`
    INSERT INTO org_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, 'admin')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(String(key).trim(), String(value), nowMs);

  audit({
    actor: 'admin',
    action: 'ORG_SETTING_UPDATED',
    targetType: 'setting',
    targetId: key,
    before: before ? { value: before.value } : null,
    after: { value: String(value) },
  });

  const events = require('../events');
  events.broadcast('SETTINGS_UPDATED', { key, value: String(value) });

  res.json({ status: 'SUCCESS', key, value: String(value) });
});

// Exchanges the admin key for a short-lived ticket the dashboard can pass to
// EventSource, which cannot set an Authorization header.
router.post('/sse-ticket', (req, res) => {
  res.json({ status: 'SUCCESS', ...issueSseTicket() });
});

module.exports = router;


