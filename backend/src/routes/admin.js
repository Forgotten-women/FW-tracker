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
const L = require('../domain/leave');
const T = require('../util/time');
const { config } = require('../config');

router.use(requireAdmin);

const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- employees -------------------------------------------------------------

router.get('/employees', async (req, res) => {
  const rows = await db.prepare(`
    SELECT e.*,
           COALESCE(er.job_title, e.role) AS effective_job_title,
           er.start_date AS employment_start_date,
           sh.amount AS base_salary,
           sh.currency AS salary_currency,
           sh.daily_rate AS salary_daily_rate,
           (SELECT COUNT(*) FROM devices d WHERE d.employee_id = e.id AND d.revoked_at IS NULL) AS device_count
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT job_title, start_date FROM employment_records
      WHERE employee_id = e.id AND effective_to IS NULL
      ORDER BY effective_from DESC
      LIMIT 1
    ) er ON TRUE
    LEFT JOIN LATERAL (
      SELECT amount, currency, daily_rate FROM salary_history
      WHERE employee_id = e.id AND effective_to IS NULL
      ORDER BY effective_from DESC
      LIMIT 1
    ) sh ON TRUE
    ORDER BY e.active DESC, e.name
  `).all();
  res.json({
    status: 'SUCCESS',
    employees: rows.map(r => ({
      id: r.id,
      name: r.name,
      role: r.effective_job_title || r.role,
      employeeNumber: r.employee_number || null,
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

router.post('/employees', async (req, res) => {
  const { name, role, baseSalary, currency, startDate, reason } = req.body || {};
  let { employeeNumber } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'Employee name is required.' });
  }

  const people = require('../domain/people');
  if (employeeNumber && String(employeeNumber).trim()) {
    employeeNumber = String(employeeNumber).trim().toUpperCase();
    const existing = await db.prepare('SELECT id FROM employees WHERE UPPER(employee_number) = ?').get(employeeNumber);
    if (existing) {
      return res.status(409).json({ status: 'ERROR', message: `Employee ID ${employeeNumber} is already assigned to another employee.` });
    }
  } else {
    employeeNumber = await people.nextEmployeeNumber();
  }

  const id = 'emp_' + crypto.randomBytes(6).toString('hex');
  const nowMs = T.now();
  const employee = {
    id,
    name: String(name).trim(),
    role: String(role || 'Team Member').trim(),
    employeeNumber,
  };
  const PR = require('../domain/payroll');

  await tx(async () => {
    await db.prepare('INSERT INTO employees (id,name,role,active,employee_number,created_at,updated_at) VALUES (?,?,?,1,?,?,?)')
      .run(employee.id, employee.name, employee.role, employeeNumber, nowMs, nowMs);

    if (startDate) {
      await db.prepare(`
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
      await PR.setSalary({
        employeeId: id,
        amount: Number(baseSalary),
        currency: currency || 'PKR',
        effectiveFrom: startDate || T.dateKey(),
        reason: reason || 'Initial base salary on onboarding',
        actor: 'admin',
      });
    }

    await audit({ actor: 'admin', action: 'EMPLOYEE_CREATED', targetType: 'employee', targetId: id, after: employee });
  });

  if (startDate) {
    try {
      await L.accrue(id, T.dateKey());
    } catch (_) {}
  }

  res.status(201).json({ status: 'SUCCESS', employee });
});

router.patch('/employees/:id', async (req, res) => {
  const before = await db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  if (req.body?.employeeNumber !== undefined && req.body.employeeNumber !== before.employee_number) {
    return res.status(400).json({ status: 'ERROR', message: 'Employee ID is permanent and cannot be modified.' });
  }
  if (req.body?.employee_number !== undefined && req.body.employee_number !== before.employee_number) {
    return res.status(400).json({ status: 'ERROR', message: 'Employee ID is permanent and cannot be modified.' });
  }

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : before.name;
  const role = req.body?.role !== undefined ? String(req.body.role).trim() : before.role;
  const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : before.active;

  await tx(async () => {
    await db.prepare('UPDATE employees SET name=?, role=?, active=?, updated_at=? WHERE id=?')
      .run(name, role, active, T.now(), req.params.id);
    await audit({
      actor: 'admin', action: 'EMPLOYEE_UPDATED', targetType: 'employee', targetId: req.params.id,
      before: { name: before.name, role: before.role, active: !!before.active },
      after: { name, role, active: !!active },
    });
  });

  res.json({
    status: 'SUCCESS',
    employee: { id: req.params.id, name, role, employeeNumber: before.employee_number, active: !!active },
  });
});

router.patch('/employees/:id/employment', async (req, res) => {
  const employeeId = req.params.id;
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  const { startDate, reason = 'Correcting join date' } = req.body || {};
  if (!startDate || !String(startDate).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'startDate is required (YYYY-MM-DD).' });
  }

  const cleanStartDate = String(startDate).trim();

  // Find earliest (initial) employment_records row for this employee
  const earliestRecord = await db.prepare(`
    SELECT * FROM employment_records
    WHERE employee_id = ?
    ORDER BY created_at ASC, start_date ASC
    LIMIT 1
  `).get(employeeId);

  const nowMs = T.now();

  await tx(async () => {
    if (earliestRecord) {
      await db.prepare(`
        UPDATE employment_records
        SET start_date = ?, effective_from = ?, change_reason = ?
        WHERE id = ?
      `).run(cleanStartDate, cleanStartDate, reason, earliestRecord.id);

      await audit({
        actor: 'admin',
        action: 'START_DATE_UPDATED',
        targetType: 'employee',
        targetId: employeeId,
        before: { startDate: earliestRecord.start_date },
        after: { startDate: cleanStartDate, reason },
      });
    } else {
      const recId = 'er_' + crypto.randomBytes(6).toString('hex');
      await db.prepare(`
        INSERT INTO employment_records
          (id, employee_id, job_title, employment_type, start_date, effective_from, created_at, created_by, change_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(recId, employeeId, employee.role || 'Team Member', 'Full-time', cleanStartDate, cleanStartDate, nowMs, 'admin', reason);

      await audit({
        actor: 'admin',
        action: 'START_DATE_UPDATED',
        targetType: 'employee',
        targetId: employeeId,
        before: null,
        after: { startDate: cleanStartDate, reason },
      });
    }

    // Keep earliest salary record effective_from in sync with employment start date
    const earliestSalary = await db.prepare(`
      SELECT id, effective_from FROM salary_history
      WHERE employee_id = ?
      ORDER BY created_at ASC, effective_from ASC
      LIMIT 1
    `).get(employeeId);

    if (earliestSalary) {
      await db.prepare(`
        UPDATE salary_history
        SET effective_from = ?
        WHERE id = ?
      `).run(cleanStartDate, earliestSalary.id);
    }
  });

  try {
    await db.prepare("DELETE FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'ACCRUAL'").run(employeeId);
    await L.accrue(employeeId, T.dateKey());
  } catch (err) {
    console.error('Error re-accruing leave for employee:', err);
  }

  const updatedRecord = await db.prepare(`
    SELECT * FROM employment_records
    WHERE employee_id = ?
    ORDER BY created_at ASC, start_date ASC
    LIMIT 1
  `).get(employeeId);

  res.json({
    status: 'SUCCESS',
    message: 'Start date updated successfully.',
    record: updatedRecord,
  });
});

router.delete('/employees/:id', async (req, res) => {
  return res.status(400).json({
    status: 'ERROR',
    message: 'Permanent deletion of employee records is strictly prohibited to preserve historical attendance, payroll, leave, and audit integrity. Every Employee ID must remain attached to its historical record and cannot be deleted or reissued. To disconnect the mobile app, use "Unpair App"; to mark an employee departure, change their status to "Left employment".',
  });
});

router.post('/employees/:id/unpair-devices', async (req, res) => {
  const people = require('../domain/people');
  try {
    const result = await people.unpairEmployeeDevices({
      employeeId: req.params.id,
      actor: 'admin',
    });
    res.json({ status: 'SUCCESS', ...result });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// --- enrolment codes -------------------------------------------------------

// Hand the returned code to the employee. It is single-use and expires in 24h.
router.post('/employees/:id/enrollment-code', async (req, res) => {
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });
  if (!employee.active) return res.status(400).json({ status: 'ERROR', message: 'Employee is inactive.' });

  const { code, hash } = newEnrollmentCode();
  const nowMs = T.now();
  const expiresAt = nowMs + CODE_TTL_MS;

  await tx(async () => {
    await db.prepare('INSERT INTO enrollment_codes (code_hash, employee_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(hash, employee.id, nowMs, expiresAt);
    // The code itself is never written to the audit log - only the fact one
    // was issued. Only its hash is stored.
    await audit({ actor: 'admin', action: 'ENROLLMENT_CODE_ISSUED', targetType: 'employee', targetId: employee.id });
  });

  res.status(201).json({
    status: 'SUCCESS',
    code,
    employee: { id: employee.id, name: employee.name },
    expiresAt,
    expiresAtDisplay: `${T.displayDate(expiresAt)} at ${T.displayTime(expiresAt)}`,
    message: 'Single-use code. Give it to the employee to enter in the app.',
  });
});

// --- devices & workstations -------------------------------------------------

router.get('/devices', async (req, res) => {
  const rows = await db.prepare(`
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

router.get('/employees/:id/devices', async (req, res) => {
  const employee = await db.prepare('SELECT id, name, employee_number FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  const rows = await db.prepare(`
    SELECT d.*, 
           dt.last_used_at,
           dt.created_at AS token_created_at
    FROM devices d
    LEFT JOIN device_tokens dt ON dt.device_id = d.id AND dt.revoked_at IS NULL
    WHERE d.employee_id = ? AND d.revoked_at IS NULL
    ORDER BY COALESCE(d.last_seen_at, dt.last_used_at, d.enrolled_at) DESC
  `).all(req.params.id);

  const nowMs = T.now();
  res.json({
    status: 'SUCCESS',
    employee: {
      id: employee.id,
      name: employee.name,
      employeeNumber: employee.employee_number || null,
    },
    devices: rows.map(d => {
      const lastActiveMs = d.last_seen_at || d.last_used_at || null;
      const isRecentlyActive = lastActiveMs ? (nowMs - lastActiveMs) < 24 * 60 * 60 * 1000 : false;
      return {
        id: d.id,
        employeeId: d.employee_id,
        platform: d.platform,
        model: d.model || 'Handset',
        label: d.label || null,
        enrolledAt: d.enrolled_at ? T.displayTime(d.enrolled_at) : 'Unknown',
        lastSeenAt: lastActiveMs,
        lastSeen: lastActiveMs ? T.displayTime(lastActiveMs) : 'Never',
        isRecentlyActive,
      };
    }),
  });
});

router.get('/workstations', async (req, res) => {
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);
  const rows = await db.prepare(`
    SELECT ws.*, e.name AS employee_name, e.role AS employee_role, d.platform, d.model, d.label
    FROM workstation_sessions ws
    JOIN employees e ON e.id = ws.employee_id
    JOIN devices d ON d.id = ws.device_id
    WHERE ws.session_date = ? AND d.revoked_at IS NULL
    ORDER BY ws.last_heartbeat_at DESC
  `).all(dateKey);

  // Synchronize break records for today (from mobile check-ins / HR breaks)
  const breakRows = await db.prepare(`
    SELECT employee_id, started_at, ended_at, actual_minutes
    FROM break_records
    WHERE date_key = ?
  `).all(dateKey);

  const breaksByEmp = new Map();
  for (const br of breakRows) {
    const mins = br.ended_at
      ? (br.actual_minutes != null ? br.actual_minutes : Math.round((br.ended_at - br.started_at) / 60000))
      : Math.max(0, Math.round((nowMs - br.started_at) / 60000));
    breaksByEmp.set(br.employee_id, (breaksByEmp.get(br.employee_id) || 0) + mins);
  }

  // Fetch verified in-office presence session stats for today
  const attRows = await db.prepare(`
    SELECT employee_id, total_minutes, first_in_at, last_active_at
    FROM attendance_days
    WHERE date_key = ?
  `).all(dateKey);
  const attByEmp = new Map(attRows.map(a => [a.employee_id, a]));

  res.json({
    status: 'SUCCESS',
    dateKey,
    workstations: rows.map(r => {
      const mobileBreakMins = breaksByEmp.get(r.employee_id) || 0;
      const wsBreakMins = Math.round((r.break_seconds || 0) / 60);
      const totalBreakMins = Math.max(wsBreakMins, mobileBreakMins);
      const att = attByEmp.get(r.employee_id);
      const presenceMins = att ? Math.round(att.total_minutes || 0) : 0;

      const timeSinceHeartbeat = nowMs - (r.last_heartbeat_at || 0);
      let effectiveStatus = r.status;
      if (timeSinceHeartbeat > 10 * 60 * 1000) {
        effectiveStatus = 'OFFLINE';
      } else if (timeSinceHeartbeat > 2 * 60 * 1000 && effectiveStatus === 'ACTIVE') {
        effectiveStatus = 'AWAY';
      }

      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        employeeRole: r.employee_role,
        deviceId: r.device_id,
        platform: r.platform,
        model: r.model,
        label: r.label,
        status: effectiveStatus,
        activeMinutes: Math.round(r.active_seconds / 60),
        idleMinutes: Math.floor((r.idle_seconds || 0) / 60),
        breakMinutes: totalBreakMins,
        presenceMinutes: presenceMins,
        inOffice: timeSinceHeartbeat <= 10 * 60 * 1000 && !!r.in_office,
        lockState: r.lock_state,
        connectedBssid: r.connected_bssid,
        lastHeartbeat: T.displayTime(r.last_heartbeat_at),
      };
    }),
  });
});

router.get('/anomalies', async (req, res) => {
  const rows = await db.prepare(`
    SELECT pa.*, e.name AS employee_name, d.model, d.platform
    FROM process_anomalies pa
    JOIN employees e ON e.id = pa.employee_id
    JOIN devices d ON d.id = pa.device_id
    ORDER BY pa.detected_at DESC
    LIMIT 100
  `).all();

  res.json({
    status: 'SUCCESS',
    anomalies: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      deviceModel: r.model,
      platform: r.platform,
      processName: r.process_name,
      windowTitle: r.window_title,
      durationMinutes: Math.round(r.duration_seconds / 60),
      detectedAt: T.displayTime(r.detected_at),
      detectedDate: T.displayDate(r.detected_at),
      resolved: !!r.resolved,
      notes: r.notes,
    })),
  });
});

router.get('/app-usage', async (req, res) => {
  const nowMs = T.now();
  const dateKey = String(req.query.date || T.dateKey(nowMs));
  const rows = await db.prepare(`
    SELECT au.*, e.name AS employee_name, d.model, d.platform
    FROM workstation_app_usage au
    JOIN employees e ON e.id = au.employee_id
    JOIN devices d ON d.id = au.device_id
    WHERE au.session_date = ?
    ORDER BY au.active_seconds DESC
  `).all(dateKey);

  const wsRows = await db.prepare(`
    SELECT employee_id, active_seconds
    FROM workstation_sessions
    WHERE session_date = ?
  `).all(dateKey);
  const wsByEmp = new Map(wsRows.map(w => [w.employee_id, w.active_seconds]));

  res.json({
    status: 'SUCCESS',
    dateKey,
    appUsage: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      deviceModel: r.model,
      platform: r.platform,
      appName: r.app_name,
      activeSeconds: r.active_seconds,
      activeMinutes: Math.round(r.active_seconds / 60),
      workstationActiveSeconds: wsByEmp.get(r.employee_id) || 0,
      lastUsedAt: T.displayTime(r.last_used_at),
    })),
  });
});

router.post('/anomalies/:id/resolve', async (req, res) => {
  await db.prepare('UPDATE process_anomalies SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ status: 'SUCCESS' });
});

// Revoking cuts the device off immediately: its token stops authenticating.
router.delete('/devices/:id', async (req, res) => {
  const device = await db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ status: 'ERROR', message: 'No such device.' });

  const nowMs = T.now();
  await tx(async () => {
    await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(nowMs, req.params.id);
    await db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE device_id = ?').run(nowMs, req.params.id);
    // Otherwise the sensors would keep recognising this handset and recording
    // attendance for someone who has handed their phone back.
    await bindings.revokeForDevice(req.params.id, 'Device revoked by administrator');
    await audit({
      actor: 'admin', action: 'DEVICE_REVOKED', targetType: 'device', targetId: req.params.id,
      before: { employeeId: device.employee_id, model: device.model },
    });
  });
  

  res.json({ status: 'SUCCESS', message: 'Device revoked.' });
});

// --- attendance corrections ------------------------------------------------

// Corrections are additive and attributable. The event log is never edited, so
// the original sensor record stays intact and the adjustment is visible next
// to it.
router.post('/attendance/:employeeId/:dateKey/adjust', async (req, res) => {
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
  const employee = await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!employee) return res.status(404).json({ status: 'ERROR', message: 'No such employee.' });

  const before = await P.deriveDay(employeeId, dateKey);
  const nowMs = T.now();

  await tx(async () => {
    await db.prepare(`
      INSERT INTO attendance_days (employee_id, date_key, adjustment_minutes, adjustment_note, derived_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(employee_id, date_key) DO UPDATE SET
        adjustment_minutes = excluded.adjustment_minutes,
        adjustment_note    = excluded.adjustment_note
    `).run(employeeId, dateKey, Math.round(minutes), note, nowMs);
    await audit({
      actor: 'admin', action: 'ATTENDANCE_ADJUSTED',
      targetType: 'attendance', targetId: `${employeeId}/${dateKey}`,
      before: { totalMinutes: before.totalMinutes, adjustmentMinutes: before.adjustmentMinutes },
      after: { adjustmentMinutes: Math.round(minutes) },
      note,
    });
  });
  

  const after = await P.recomputeDay(employeeId, dateKey);
  res.json({ status: 'SUCCESS', attendance: await P.presentDay(after, employee) });
});

// --- audit, export, maintenance -------------------------------------------

router.get('/audit', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = await db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
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
router.get('/export', async (req, res) => {
  const from = String(req.query.from || T.dateKey());
  const to = String(req.query.to || T.dateKey());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
  }

  const rows = await db.prepare(`
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

  await audit({ actor: 'admin', action: 'ATTENDANCE_EXPORTED', note: `${from}..${to}, ${rows.length} rows` });
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
  await tx(async () => {
    const affected = (await db.prepare('SELECT COUNT(*) c FROM employees WHERE active = 1').get()).c;
    await db.prepare('UPDATE employees SET active = 0, updated_at = ? WHERE active = 1').run(nowMs);
    await db.prepare('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
    await db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(nowMs);
    await audit({
      actor: 'admin', action: 'ARCHIVE_ALL', targetType: 'database',
      after: { deactivatedEmployees: affected, backup: backupPath },
      note: 'Attendance history retained',
    });
  });
  

  res.json({ status: 'SUCCESS', message: 'All employees deactivated and devices revoked. Attendance history retained.', backup: backupPath });
});

router.post('/backup', async (req, res) => {
  const p = await backup();
  await audit({ actor: 'admin', action: 'BACKUP_CREATED', note: p });
  res.json({ status: 'SUCCESS', backup: p });
});

// Rebuild every cached attendance day from the event log. Safe by design -
// the events are the source of truth, the cache is derived.
router.post('/recompute', async (req, res) => {
  const count = await P.recomputeAll();
  await audit({ actor: 'admin', action: 'RECOMPUTE_ALL', note: `${count} employee-days` });
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

router.get('/settings', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM org_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ status: 'SUCCESS', settings });
});

router.post('/settings', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ status: 'ERROR', message: 'Key and value are required.' });
  }

  const before = await db.prepare('SELECT * FROM org_settings WHERE key = ?').get(key);
  const nowMs = T.now();
  await db.prepare(`
    INSERT INTO org_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, ?, 'admin')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(String(key).trim(), String(value), nowMs);

  await audit({
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


