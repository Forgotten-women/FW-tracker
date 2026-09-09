// Attendance API: employee self-service and HR administration.
// Spec sections 7, 11, 12, 19.1-19.3 and 24.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db, tx, audit } = require('../db');
const {
  requireDevice, requireUser, requirePermission, requireEmployeeAccess,
  requireUserOrAdminKey,
} = require('../middleware/auth');
const A = require('../domain/attendance');
const schedule = require('../domain/schedule');
const importer = require('../domain/import');
const rbac = require('../domain/rbac');
const P = require('../domain/presence');
const N = require('../domain/notifications');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Employee self-service (phone app, device token)
// ---------------------------------------------------------------------------

// GET /api/attendance/home-summary - consolidated fast batch for the mobile dashboard.
// Delivers today's details, past 7 days history, dispute corrections, and notification counts in ONE call.
router.get('/home-summary', requireDevice, async (req, res) => {
  const { employeeId, employeeName, employeeRole } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  // 1. Derive today's day first so it can be reused across all calculations
  const day = await A.deriveDay(employeeId, dateKey, nowMs);

  // 2. Run companion metrics in parallel reusing pre-derived `day`
  const [lateness, balance, workingHours, correctionRows, notifsResult] = await Promise.all([
    A.latenessStatus(employeeId, dateKey),
    A.balanceFor(employeeId),
    A.calculateWorkingHoursMetrics(employeeId, dateKey, day),
    db.prepare('SELECT * FROM attendance_corrections WHERE employee_id = ? ORDER BY requested_at DESC LIMIT 20').all(employeeId),
    N.listForEmployee(employeeId, { includeDismissed: false }).catch(() => ({ unreadCount: 0, notifications: [] })),
  ]);

  // 3. Fast history: Today reuses day.presence directly. Past 6 days loaded from attendance_days cache.
  const days = 7;
  const dayKeys = [];
  for (let i = 0; i < days; i++) {
    dayKeys.push(T.dateKey(nowMs - i * 24 * 60 * 60 * 1000));
  }

  const pastKeys = dayKeys.slice(1);
  const placeholders = pastKeys.map(() => '?').join(',');
  const cachedRows = await db.prepare(
    `SELECT * FROM attendance_days WHERE employee_id = ? AND date_key IN (${placeholders})`
  ).all(employeeId, ...pastKeys);
  const cachedMap = new Map(cachedRows.map(r => [r.date_key, r]));

  const summaryRows = await db.prepare(
    `SELECT * FROM attendance_daily_summary WHERE employee_id = ? AND date_key IN (${placeholders})`
  ).all(employeeId, ...pastKeys);
  const summaryMap = new Map(summaryRows.map(r => [r.date_key, r]));

  const historyDays = await Promise.all(
    dayKeys.map(async (key, idx) => {
      if (idx === 0 && day.presence) {
        return P.presentDay(day.presence, { name: employeeName, role: employeeRole });
      }
      const cached = cachedMap.get(key);
      if (cached) {
        let sessions = [];
        try { sessions = JSON.parse(cached.sessions_json || '[]'); } catch (_) {}
        const summ = summaryMap.get(key);
        const workedMins = (summ && summ.worked_minutes != null) ? summ.worked_minutes : cached.total_minutes;
        const d = {
          employeeId,
          dateKey: key,
          firstInAt: cached.first_in_at,
          lastActiveAt: cached.last_active_at,
          sessions,
          totalMinutes: workedMins,
          status: cached.status,
          statusLabel: cached.status === 'IN_OFFICE' ? 'Active in Office' : (cached.status === 'CLOSED' ? 'Day closed' : (cached.status || 'Not Arrived Yet')),
          inactivityMinutes: 0,
          graceMinutesLeft: 0,
          eventCount: sessions.length,
          exceededCap: false,
          lastSource: null,
          sensorCarried: false,
        };
        return P.presentDay(d, { name: employeeName, role: employeeRole });
      }
      const d = await P.deriveDay(employeeId, key, nowMs);
      return P.presentDay(d, { name: employeeName, role: employeeRole });
    })
  );

  const corrections = correctionRows.map(r => ({
    id: r.id, date: r.date_key, reason: r.reason, status: r.status,
    requestedAt: T.displayTime(r.requested_at),
    reviewedAt: r.reviewed_at ? T.displayTime(r.reviewed_at) : null,
    reviewNotes: r.review_notes,
  }));

  res.json({
    status: 'SUCCESS',
    employee: { id: employeeId, name: employeeName, role: employeeRole },
    today: A.present(day),
    workingHours,
    lateness,
    deficitBalance: {
      minutes: balance.balanceMinutes,
      formatted: T.formatMinutes(balance.balanceMinutes),
      wholeDayEquivalents: balance.wholeDayEquivalents,
      carryForwardMinutes: balance.carryForwardMinutes,
      dayEquivalentMinutes: balance.dayEquivalentMinutes,
    },
    history: historyDays,
    corrections,
    unreadNotificationsCount: notifsResult.unreadCount || 0,
    serverTimeMs: nowMs,
  });
});

// GET /api/attendance/today - everything the employee home screen needs.
router.get('/today', requireDevice, async (req, res) => {
  const { employeeId, employeeName } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  const [day, lateness, balance, workingHours] = await Promise.all([
    A.deriveDay(employeeId, dateKey, nowMs),
    A.latenessStatus(employeeId, dateKey),
    A.balanceFor(employeeId),
    A.calculateWorkingHoursMetrics(employeeId, dateKey),
  ]);

  res.json({
    status: 'SUCCESS',
    employee: { id: employeeId, name: employeeName },
    today: A.present(day),
    workingHours,
    // Spec 19.2: the employee must see their lateness standing clearly.
    lateness,
    // Spec 19.3: the deficit broken down, not one unexplained number.
    deficitBalance: {
      minutes: balance.balanceMinutes,
      formatted: T.formatMinutes(balance.balanceMinutes),
      wholeDayEquivalents: balance.wholeDayEquivalents,
      carryForwardMinutes: balance.carryForwardMinutes,
      dayEquivalentMinutes: balance.dayEquivalentMinutes,
    },
    serverTimeMs: nowMs,
  });
});

// POST /api/attendance/break/start
router.post('/break/start', requireDevice, async (req, res) => {
  const nowMs = T.now();
  const result = await A.startBreak(req.auth.employeeId, nowMs);

  if (!result.ok) {
    return res.status(409).json({
      status: 'ERROR', code: result.reason,
      message: result.reason === 'ALREADY_ON_BREAK'
        ? `A break is already running, started at ${T.displayTime(result.startedAt)}.`
        : (result.message || 'Could not start a break.'),
    });
  }

  await A.recomputeDay(req.auth.employeeId, T.dateKey(nowMs), nowMs);

  try {
    await db.prepare(`
      UPDATE workstation_sessions
      SET status = 'ON_BREAK', updated_at = ?
      WHERE employee_id = ? AND session_date = ?
    `).run(nowMs, req.auth.employeeId, T.dateKey(nowMs));
  } catch (_) {}

  res.status(201).json({
    status: 'SUCCESS',
    breakId: result.breakId,
    startedAt: T.displayTime(result.startedAt),
    permittedMinutes: result.permittedMinutes,
    dueBackAt: T.displayTime(result.dueBackAt),
    dueBackAtMs: result.dueBackAt,
  });
});

// POST /api/attendance/break/end
router.post('/break/end', requireDevice, async (req, res) => {
  const nowMs = T.now();
  const result = await A.endBreak(req.auth.employeeId, nowMs);

  if (!result.ok) {
    return res.status(409).json({
      status: 'ERROR', code: result.reason, message: 'No break is currently running.',
    });
  }

  await A.recomputeDay(req.auth.employeeId, T.dateKey(nowMs), nowMs);

  try {
    await db.prepare(`
      UPDATE workstation_sessions
      SET status = 'ACTIVE', updated_at = ?
      WHERE employee_id = ? AND session_date = ?
    `).run(nowMs, req.auth.employeeId, T.dateKey(nowMs));
  } catch (_) {}

  res.json({
    status: 'SUCCESS',
    actualMinutes: result.actualMinutes,
    permittedMinutes: result.permittedMinutes,
    excessMinutes: result.excessMinutes,
    // Said plainly, so nobody is surprised by a deduction later.
    message: result.excessMinutes > 0
      ? `Break was ${result.actualMinutes} minutes. ${result.excessMinutes} minutes over the permitted ${result.permittedMinutes} have been added to your attendance deficit.`
      : `Break was ${result.actualMinutes} minutes, within the permitted ${result.permittedMinutes}.`,
  });
});

// POST /api/attendance/clock-out - the manual fallback spec 23.6 requires,
// because a missed automatic event must not become a payroll event.
router.post('/clock-out', requireDevice, async (req, res) => {
  const { employeeId } = req.auth;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  const open = await db.prepare(
    'SELECT * FROM break_records WHERE employee_id = ? AND ended_at IS NULL'
  ).get(employeeId);
  if (open) await A.endBreak(employeeId, nowMs);

  const id = 'ae_' + crypto.randomBytes(8).toString('hex');
  await db.prepare(`
    INSERT INTO attendance_events
      (id, employee_id, date_key, occurred_at, event_type, source, device_id, created_at, created_by)
    VALUES (?,?,?,?, 'CLOCK_OUT', 'MOBILE_APP', ?, ?, ?)
  `).run(id, employeeId, dateKey, nowMs, req.auth.deviceId, nowMs, `employee:${employeeId}`);

  const day = await A.recomputeDay(employeeId, dateKey, nowMs);
  res.json({ status: 'SUCCESS', clockedOutAt: T.displayTime(nowMs), today: A.present(day) });
});

// POST /api/attendance/corrections - spec 11.
router.post('/corrections', requireDevice, async (req, res) => {
  const { employeeId } = req.auth;
  const { dateKey, requestedChange, reason } = req.body || {};

  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return res.status(400).json({ status: 'ERROR', message: 'dateKey must be YYYY-MM-DD.' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'Please explain what was wrong.' });
  }

  const id = 'corr_' + crypto.randomBytes(8).toString('hex');
  await db.prepare(`
    INSERT INTO attendance_corrections
      (id, employee_id, date_key, requested_by, requested_at, requested_change, reason, status)
    VALUES (?,?,?,?,?,?,?, 'PENDING')
  `).run(id, employeeId, dateKey, `employee:${employeeId}`, T.now(),
         JSON.stringify(requestedChange || {}), String(reason).trim());

  try {
    const emp = await db.prepare('SELECT name FROM employees WHERE id = ?').get(employeeId);
    const empName = emp?.name || employeeId;
    await N.notify({
      category: 'CORRECTION',
      title: `Attendance Dispute: ${empName}`,
      body: `Correction submitted for ${dateKey}: ${String(reason).trim()}`,
      severity: 'warning',
      link: `/attendance?correction=${id}`,
    });
  } catch (_) {}

  res.status(201).json({
    status: 'SUCCESS', correctionId: id,
    message: 'Your correction request has been sent to HR. The original record stays on file until it is reviewed.',
  });
});

router.get('/corrections/mine', requireDevice, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM attendance_corrections WHERE employee_id = ? ORDER BY requested_at DESC LIMIT 50'
  ).all(req.auth.employeeId);

  res.json({
    status: 'SUCCESS',
    corrections: rows.map(r => ({
      id: r.id, date: r.date_key, reason: r.reason, status: r.status,
      requestedAt: T.displayTime(r.requested_at),
      reviewedAt: r.reviewed_at ? T.displayTime(r.reviewed_at) : null,
      reviewNotes: r.review_notes,
    })),
  });
});

// ---------------------------------------------------------------------------
// HR and manager views (user session + permission + employee scoping)
// ---------------------------------------------------------------------------

// GET /api/attendance/employee/:employeeId/day/:dateKey
router.get('/employee/:employeeId/day/:dateKey',
  requireUser, requirePermission('attendance.read'), requireEmployeeAccess(),
  async (req, res) => {
    const { employeeId, dateKey } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ status: 'ERROR', message: 'dateKey must be YYYY-MM-DD.' });
    }
    const day = await A.deriveDay(employeeId, dateKey);
    res.json({
      status: 'SUCCESS',
      day: A.present(day),
      lateness: await A.latenessStatus(employeeId, dateKey),
      deficitBalance: await A.balanceFor(employeeId),
    });
  });

// GET /api/attendance/employee/:employeeId/summary?from=&to=
router.get('/employee/:employeeId/summary',
  requireUser, requirePermission('attendance.read'), requireEmployeeAccess(),
  async (req, res) => {
    const { employeeId } = req.params;
    const from = String(req.query.from || T.dateKey());
    const to = String(req.query.to || T.dateKey());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
    }

    const rows = await db.prepare(`
      SELECT * FROM attendance_daily_summary
      WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
      ORDER BY date_key DESC
    `).all(employeeId, from, to);

    const empInfo = await db.prepare('SELECT id, name, employee_number FROM employees WHERE id = ?').get(employeeId);
    const workingHours = await A.calculateWorkingHoursMetrics(employeeId, to);

    res.json({
      status: 'SUCCESS',
      employee: empInfo ? { id: empInfo.id, name: empInfo.name, employeeNumber: empInfo.employee_number || null } : null,
      from, to,
      workingHours,
      totals: {
        lateOccurrences: rows.filter(r => r.is_late_occurrence).length,
        lateMinutes: rows.reduce((a, r) => a + r.late_minutes, 0),
        excessBreakMinutes: rows.reduce((a, r) => a + r.excess_break_minutes, 0),
        earlyDepartureMinutes: rows.reduce((a, r) => a + r.early_departure_minutes, 0),
        deficitMinutes: rows.reduce((a, r) => a + r.daily_deficit_minutes, 0),
        workedMinutes: rows.reduce((a, r) => a + r.worked_minutes, 0),
      },
      days: rows.map(r => ({
        date: r.date_key,
        status: r.attendance_status,
        isWorkingDay: !!r.is_working_day,
        firstIn: r.first_clock_in ? T.displayTime(r.first_clock_in) : '--',
        lastSeen: r.last_clock_out ? T.displayTime(r.last_clock_out) : '--',
        worked: T.formatMinutes(r.worked_minutes),
        lateMinutes: r.late_minutes,
        isLateOccurrence: !!r.is_late_occurrence,
        excessBreakMinutes: r.excess_break_minutes,
        earlyDepartureMinutes: r.early_departure_minutes,
        unauthorisedMissingMinutes: r.unauthorised_missing_minutes,
        deficitMinutes: r.daily_deficit_minutes,
      })),
    });
  });

// GET /api/attendance/deficits - who is approaching a whole-day equivalent.
router.get('/deficits', requireUser, requirePermission('attendance.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  // The most recent ledger entry per employee.
  //
  // This keyed off SQLite's implicit rowid, which does not exist here - the
  // table's primary key is a random hex id, so "the highest id" never meant
  // "the latest entry" anyway. Ordering by created_at states the intent, with
  // the id as a stable tiebreak for entries written in the same millisecond.
  const rows = (await db.prepare(`
    SELECT DISTINCT ON (l.employee_id)
           l.employee_id, l.balance_after, l.whole_days_after, l.carry_forward_after, e.name, e.employee_number
    FROM attendance_deficit_ledger l
    JOIN employees e ON e.id = l.employee_id
    ORDER BY l.employee_id, l.created_at DESC, l.id DESC
  `).all()).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    employees: rows.map(r => ({
      employeeId: r.employee_id,
      employeeName: r.name,
      employeeNumber: r.employee_number || null,
      balanceMinutes: r.balance_after,
      balanceFormatted: T.formatMinutes(r.balance_after),
      wholeDayEquivalents: r.whole_days_after,
      carryForwardMinutes: r.carry_forward_after,
      // Spec 8.3: reaching a whole day is an HR action, not an automatic one.
      needsHrAction: r.whole_days_after > 0,
    })),
  });
});

// GET /api/attendance/lateness - the warning-risk board, spec 21.
router.get('/lateness', requireUser, requirePermission('attendance.read'), async (req, res) => {
  const dateKey = String(req.query.date || T.dateKey());
  const visible = await rbac.accessibleEmployeeIds(req.auth);
  const rows = (await db.prepare('SELECT id, name, employee_number FROM employees WHERE active = 1').all())
    .filter(e => visible.includes(e.id));

  const employees = await Promise.all(rows.map(async e => {
    const status = await A.latenessStatus(e.id, dateKey);
    return { employeeId: e.id, employeeName: e.name, employeeNumber: e.employee_number || null, ...status };
  }));

  // Spec 21 asks for green/amber/red, with colour supplementing text and never
  // being the only indicator - so the level is returned as a word.
  res.json({
    status: 'SUCCESS',
    monitoringPeriod: A.monitoringPeriod(dateKey),
    employees,
    counts: {
      ok: employees.filter(e => e.level === 'OK').length,
      approaching: employees.filter(e => e.level === 'APPROACHING').length,
      atLimit: employees.filter(e => e.level === 'AT_LIMIT').length,
      thresholdReached: employees.filter(e => e.level === 'THRESHOLD_REACHED').length,
    },
  });
});

// ---------------------------------------------------------------------------
// HR corrections review (spec 11)
// ---------------------------------------------------------------------------

router.get('/corrections',
  requireUserOrAdminKey('attendance.correction.review'),
  async (req, res) => {
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
    const statusQuery = String(req.query.status || 'PENDING');
    const rows = (statusQuery === 'ALL'
      ? await db.prepare(`
          SELECT c.*, e.name, e.role, e.employee_number FROM attendance_corrections c
          JOIN employees e ON e.id = c.employee_id
          ORDER BY c.requested_at DESC
        `).all()
      : await db.prepare(`
          SELECT c.*, e.name, e.role, e.employee_number FROM attendance_corrections c
          JOIN employees e ON e.id = c.employee_id
          WHERE c.status = ? ORDER BY c.requested_at ASC
        `).all(statusQuery)
    ).filter(r => visible.has(r.employee_id));

    res.json({
      status: 'SUCCESS',
      corrections: rows.map(r => ({
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.name,
        employeeNumber: r.employee_number || null,
        role: r.role,
        date: r.date_key,
        reason: r.reason,
        requestedChange: JSON.parse(r.requested_change || '{}'),
        appliedChange: JSON.parse(r.applied_change || '{}'),
        requestedAt: T.displayTime(r.requested_at),
        reviewedAt: r.reviewed_at ? T.displayTime(r.reviewed_at) : null,
        reviewNotes: r.review_notes,
        status: r.status,
      })),
    });
  });

const handleCorrectionDecision = async (req, res) => {
  const { decision, notes, adjustmentMinutes } = req.body || {};
  const valid = ['APPROVED', 'REJECTED', 'AMENDED', 'INFO_REQUESTED'];
  if (!valid.includes(decision)) {
    return res.status(400).json({ status: 'ERROR', message: `decision must be one of ${valid.join(', ')}.` });
  }
  if (!notes || !String(notes).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'A note explaining the decision is required.' });
  }

  const corr = await db.prepare('SELECT * FROM attendance_corrections WHERE id = ?').get(req.params.id);
  if (!corr) return res.status(404).json({ status: 'ERROR', message: 'No such correction.' });
  if (!await rbac.canAccessEmployee(req.auth, corr.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such correction.' });
  }

  const nowMs = T.now();
  const actor = req.auth.kind === 'user' ? `user:${req.auth.id}` : (req.auth.actor || 'admin');

  await tx(async () => {
    await db.prepare(`
      UPDATE attendance_corrections
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?, applied_change = ?
      WHERE id = ?
    `).run(decision, actor, nowMs, String(notes).trim(),
           JSON.stringify({ adjustmentMinutes: adjustmentMinutes ?? null }), corr.id);

    // An approved or amended correction posts an adjustment. The original record is
    // never edited - spec 11 requires it to remain in the audit history.
    if ((decision === 'APPROVED' || decision === 'AMENDED') && Number.isFinite(Number(adjustmentMinutes))) {
      await A.adjustBalance({
        employeeId: corr.employee_id,
        dateKey: corr.date_key,
        minutes: -Math.abs(Number(adjustmentMinutes)),
        reason: `Correction ${corr.id} ${decision.toLowerCase()}: ${String(notes).trim()}`,
        actor,
      });
    }

    await audit({
      actor, action: 'ATTENDANCE_CORRECTION_REVIEWED',
      targetType: 'correction', targetId: corr.id,
      before: { status: corr.status },
      after: { status: decision, adjustmentMinutes: adjustmentMinutes ?? null },
      note: String(notes).trim(),
    });
  });

  // Recompute so the day reflects the decision immediately.
  const day = await A.recomputeDay(corr.employee_id, corr.date_key, nowMs);

  try {
    const decisionLabel = decision === 'APPROVED' ? 'Approved' : (decision === 'AMENDED' ? 'Amended' : 'Rejected');
    await N.notify({
      employeeId: corr.employee_id,
      category: 'CORRECTION',
      title: `Attendance Dispute ${decisionLabel}`,
      body: `Your dispute for ${corr.date_key} has been ${decision.toLowerCase()} by HR. Note: ${notes}`,
      severity: decision === 'APPROVED' || decision === 'AMENDED' ? 'info' : 'warning',
      link: '/attendance',
      nowMs,
    });
  } catch (_) {}

  res.json({ status: 'SUCCESS', decision, day: A.present(day) });
};

router.post('/corrections/:id/review',
  requireUserOrAdminKey('attendance.correction.review'),
  handleCorrectionDecision);

router.post('/corrections/:id/decide',
  requireUserOrAdminKey('attendance.correction.review'),
  handleCorrectionDecision);

// POST /api/attendance/employee/:employeeId/adjust - direct HR adjustment.
router.post('/employee/:employeeId/adjust',
  requireUser, requirePermission('attendance.write'), requireEmployeeAccess(),
  async (req, res) => {
    const { minutes, reason, dateKey } = req.body || {};
    if (!Number.isFinite(Number(minutes))) {
      return res.status(400).json({ status: 'ERROR', message: 'minutes must be a number.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ status: 'ERROR', message: 'A reason is required.' });
    }

    const actor = `user:${req.auth.id}`;
    const entry = await A.adjustBalance({
      employeeId: req.params.employeeId,
      dateKey: dateKey || T.dateKey(),
      minutes: Number(minutes),
      reason: String(reason).trim(),
      actor,
    });

    await audit({
      actor, action: 'DEFICIT_ADJUSTED',
      targetType: 'employee', targetId: req.params.employeeId,
      after: { minutes: Number(minutes), balanceAfter: entry.balance_after },
      note: String(reason).trim(),
    });

    res.json({ status: 'SUCCESS', balance: await A.balanceFor(req.params.employeeId) });
  });

// GET /api/attendance/employee/:employeeId/ledger
router.get('/employee/:employeeId/ledger',
  requireUser, requirePermission('attendance.read'), requireEmployeeAccess(),
  async (req, res) => {
    const rows = await db.prepare(`
      SELECT * FROM attendance_deficit_ledger
      WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT 200
    `).all(req.params.employeeId);

    res.json({
      status: 'SUCCESS',
      balance: await A.balanceFor(req.params.employeeId),
      entries: rows.map(r => ({
        date: r.date_key,
        type: r.entry_type,
        minutes: r.minutes_delta,
        balanceAfter: r.balance_after,
        wholeDays: r.whole_days_after,
        carryForward: r.carry_forward_after,
        description: r.description,
        at: T.displayTime(r.created_at),
        by: r.created_by,
      })),
    });
  });

// ---------------------------------------------------------------------------
// Historical import (spec 24)
// ---------------------------------------------------------------------------

// Two steps on purpose. Spec 24: "Never silently import invalid rows."
// Preview shows exactly what would happen; nothing is written until commit.
router.post('/import/preview',
  requireUser, requirePermission('attendance.import'),
  async (req, res) => {
    const csv = req.body?.csv;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ status: 'ERROR', message: 'Send the file contents as { "csv": "..." }.' });
    }

    const result = await importer.preview(csv);
    if (!result.ok) return res.status(400).json({ status: 'ERROR', ...result });

    res.json({
      status: 'SUCCESS',
      ...result,
      // Capped so a large file does not produce an unreadable response. The
      // counts in `summary` are always complete.
      valid: result.valid.slice(0, 100),
      invalid: result.invalid.slice(0, 200),
      truncated: {
        valid: Math.max(0, result.valid.length - 100),
        invalid: Math.max(0, result.invalid.length - 200),
      },
    });
  });

router.post('/import/commit',
  requireUser, requirePermission('attendance.import'),
  async (req, res) => {
    const csv = req.body?.csv;
    const confirm = String(req.body?.confirm || '');
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ status: 'ERROR', message: 'Send the file contents as { "csv": "..." }.' });
    }
    if (confirm !== 'IMPORT') {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Review the preview first, then send {"confirm":"IMPORT"} to proceed.',
      });
    }

    const result = await importer.commit(csv, {
      actor: `user:${req.auth.id}`,
      replaceExisting: req.body?.replaceExisting === true,
    });
    if (!result.ok) return res.status(400).json({ status: 'ERROR', ...result });

    res.json({
      status: 'SUCCESS',
      summary: result.summary,
      // Returned again so the caller can show what was skipped and why.
      rejected: result.invalid.slice(0, 200),
    });
  });

module.exports = router;
