// HR Shift Management & Working Pattern Administration Routes
//
// Restricted strictly to HR/Admin. Employees cannot modify their own shift.
// Manages working patterns (e.g. 10:00-18:00, 11:00-19:00, 12:00-20:00)
// and assigns shifts and work mode (IN_OFFICE, REMOTE, HYBRID) to individual employees.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db, audit, tx } = require('../db');
const { requireRole, requireAdmin } = require('../middleware/auth');
const T = require('../util/time');
const schedule = require('../domain/schedule');

// All shift management routes require HR or System Admin privileges
router.use(requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN'));

// Any shift edit or assignment drops schedule.js's cached default pattern once
// the write has finished, so this instance applies it immediately (others
// within the cache's 60s TTL).
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => schedule.invalidate());
  next();
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// GET /api/shifts - List all available shift patterns
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const patterns = await db.prepare(`
      SELECT id, name, working_days, start_time, end_time,
             permitted_break_minutes, day_equivalent_minutes, grace_minutes,
             is_default, active, created_at
      FROM working_patterns
      ORDER BY is_default DESC, name ASC
    `).all();

    res.json({
      status: 'SUCCESS',
      shifts: patterns.map(p => ({
        id: p.id,
        name: p.name,
        workingDays: p.working_days,
        startTime: p.start_time,
        endTime: p.end_time,
        permittedBreakMinutes: p.permitted_break_minutes,
        dayEquivalentMinutes: p.day_equivalent_minutes,
        graceMinutes: p.grace_minutes ?? 10,
        isDefault: p.is_default === 1,
        active: p.active === 1,
        createdAt: p.created_at,
      })),
    });
  } catch (err) {
    console.error('[shifts/list] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to retrieve shifts.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/shifts - Create a new working pattern / shift template
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const {
    name,
    startTime = '11:00',
    endTime = '19:00',
    workingDays = 'mon,tue,wed,thu,fri',
    permittedBreakMinutes = 30,
    dayEquivalentMinutes = 450,
    graceMinutes = 10,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ status: 'ERROR', message: 'Shift name is required.' });
  }
  if (!TIME_RE.test(String(startTime)) || !TIME_RE.test(String(endTime))) {
    return res.status(400).json({ status: 'ERROR', message: 'startTime and endTime must be in HH:MM 24-hour format.' });
  }

  const shiftId = `wp_${crypto.randomUUID().slice(0, 8)}`;
  const nowMs = T.now();

  try {
    await db.prepare(`
      INSERT INTO working_patterns (
        id, name, working_days, start_time, end_time,
        permitted_break_minutes, day_equivalent_minutes, grace_minutes,
        is_default, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `).run(
      shiftId,
      String(name).trim(),
      String(workingDays).toLowerCase().trim(),
      String(startTime).trim(),
      String(endTime).trim(),
      parseInt(permittedBreakMinutes, 10) || 30,
      parseInt(dayEquivalentMinutes, 10) || 450,
      graceMinutes !== undefined ? parseInt(graceMinutes, 10) : 10,
      nowMs
    );

    await audit({
      actor: req.auth.user ? req.auth.user.username : 'HR',
      action: 'SHIFT_CREATED',
      targetType: 'working_pattern',
      targetId: shiftId,
      after: { name, startTime, endTime, workingDays },
    });

    res.json({
      status: 'SUCCESS',
      message: 'Shift created successfully.',
      shift: {
        id: shiftId,
        name: String(name).trim(),
        workingDays,
        startTime,
        endTime,
        permittedBreakMinutes,
        dayEquivalentMinutes,
        graceMinutes,
        isDefault: false,
        active: true,
      },
    });
  } catch (err) {
    console.error('[shifts/create] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to create shift template.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/shifts/:id - Update an existing working pattern
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM working_patterns WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ status: 'ERROR', message: 'Shift pattern not found.' });
  }

  const {
    name = existing.name,
    startTime = existing.start_time,
    endTime = existing.end_time,
    workingDays = existing.working_days,
    permittedBreakMinutes = existing.permitted_break_minutes,
    dayEquivalentMinutes = existing.day_equivalent_minutes,
    graceMinutes = existing.grace_minutes,
    active = existing.active,
  } = req.body;

  if (startTime && !TIME_RE.test(String(startTime))) {
    return res.status(400).json({ status: 'ERROR', message: 'Invalid startTime format.' });
  }
  if (endTime && !TIME_RE.test(String(endTime))) {
    return res.status(400).json({ status: 'ERROR', message: 'Invalid endTime format.' });
  }

  try {
    await db.prepare(`
      UPDATE working_patterns
      SET name = ?,
          start_time = ?,
          end_time = ?,
          working_days = ?,
          permitted_break_minutes = ?,
          day_equivalent_minutes = ?,
          grace_minutes = ?,
          active = ?
      WHERE id = ?
    `).run(
      String(name).trim(),
      String(startTime).trim(),
      String(endTime).trim(),
      String(workingDays).toLowerCase().trim(),
      parseInt(permittedBreakMinutes, 10) || 30,
      parseInt(dayEquivalentMinutes, 10) || 450,
      graceMinutes !== undefined ? parseInt(graceMinutes, 10) : 10,
      active ? 1 : 0,
      id
    );

    await audit({
      actor: req.auth.user ? req.auth.user.username : 'HR',
      action: 'SHIFT_UPDATED',
      targetType: 'working_pattern',
      targetId: id,
      before: existing,
      after: { name, startTime, endTime, workingDays, active },
    });

    res.json({
      status: 'SUCCESS',
      message: 'Shift updated successfully.',
    });
  } catch (err) {
    console.error('[shifts/update] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to update shift template.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/shifts/assign/:employeeId - Get current assignment for an employee
// ---------------------------------------------------------------------------
router.get('/assign/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const nowMs = T.now();
  const dateKey = T.dateKey(nowMs);

  const emp = await db.prepare('SELECT id, name, work_mode, remote_allowed, overtime_counted FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
  }

  const resolved = await schedule.resolve(employeeId, dateKey);
  res.json({
    status: 'SUCCESS',
    employee: {
      id: emp.id,
      name: emp.name,
      workMode: emp.work_mode || 'IN_OFFICE',
      remoteAllowed: Boolean(emp.remote_allowed),
      overtimeCounted: Boolean(emp.overtime_counted === 1 || emp.overtime_counted === true || emp.overtime_counted === '1'),
      schedule: {
        patternId: resolved.patternId,
        patternName: resolved.patternName,
        startTime: resolved.startTime,
        endTime: resolved.endTime,
        graceMinutes: resolved.graceMinutes,
        permittedBreakMinutes: resolved.permittedBreakMinutes,
        dayEquivalentMinutes: resolved.dayEquivalentMinutes,
        workingDays: resolved.workingDays || 'mon,tue,wed,thu,fri',
        overtimeCounted: Boolean(resolved.overtimeCounted),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/shifts/assign/:employeeId - Assign shift (preset or custom) & work mode & overtime policy
// ---------------------------------------------------------------------------
router.put('/assign/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { workingPatternId, customShift, workMode, remoteAllowed, overtimeCounted } = req.body;

  // Ensure column exists
  await db.prepare('ALTER TABLE employees ADD COLUMN IF NOT EXISTS overtime_counted BIGINT NOT NULL DEFAULT 0').run().catch(() => {});

  const emp = await db.prepare('SELECT id, name, work_mode, remote_allowed, overtime_counted FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
  }

  let targetPatternId = workingPatternId;

  // Handle custom manual shift time & break time
  if (customShift && typeof customShift === 'object') {
    const {
      startTime = '11:00',
      endTime = '19:00',
      permittedBreakMinutes = 30,
      workingDays = 'mon,tue,wed,thu,fri',
      graceMinutes = 10,
    } = customShift;

    if (!TIME_RE.test(String(startTime)) || !TIME_RE.test(String(endTime))) {
      return res.status(400).json({ status: 'ERROR', message: 'Custom shift startTime and endTime must be in HH:MM format.' });
    }

    const [sh, sm] = String(startTime).split(':').map(Number);
    const [eh, em] = String(endTime).split(':').map(Number);
    let shiftDuration = (eh * 60 + em) - (sh * 60 + sm);
    if (shiftDuration <= 0) shiftDuration += 24 * 60; // Cross-midnight shift support

    const breakMins = parseInt(permittedBreakMinutes, 10) || 30;
    const grace = graceMinutes !== undefined ? parseInt(graceMinutes, 10) : 10;
    const days = String(workingDays).toLowerCase().trim() || 'mon,tue,wed,thu,fri';
    const dayEquiv = shiftDuration; // Total shift duration target

    const customId = `wp_custom_${employeeId}`;
    const customName = `Custom (${startTime} - ${endTime}, ${breakMins}m break)`;
    const nowMs = T.now();

    const existingCustom = await db.prepare('SELECT id FROM working_patterns WHERE id = ?').get(customId);
    if (existingCustom) {
      await db.prepare(`
        UPDATE working_patterns
        SET name = ?, start_time = ?, end_time = ?, working_days = ?,
            permitted_break_minutes = ?, day_equivalent_minutes = ?, grace_minutes = ?, active = 1
        WHERE id = ?
      `).run(customName, String(startTime).trim(), String(endTime).trim(), days, breakMins, dayEquiv, grace, customId);
    } else {
      await db.prepare(`
        INSERT INTO working_patterns (
          id, name, working_days, start_time, end_time,
          permitted_break_minutes, day_equivalent_minutes, grace_minutes,
          is_default, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
      `).run(customId, customName, days, String(startTime).trim(), String(endTime).trim(), breakMins, dayEquiv, grace, nowMs);
    }

    targetPatternId = customId;
  } else if (workingPatternId) {
    const wp = await db.prepare('SELECT id FROM working_patterns WHERE id = ?').get(workingPatternId);
    if (!wp) {
      return res.status(400).json({ status: 'ERROR', message: 'Invalid working pattern ID.' });
    }
  }

  const validWorkModes = ['IN_OFFICE', 'REMOTE', 'HYBRID'];
  if (workMode && !validWorkModes.includes(workMode)) {
    return res.status(400).json({ status: 'ERROR', message: `workMode must be one of: ${validWorkModes.join(', ')}` });
  }

  const nowMs = T.now();

  try {
    const newWorkMode = workMode || emp.work_mode || 'IN_OFFICE';
    const newRemoteAllowed = remoteAllowed !== undefined
      ? (remoteAllowed ? 1 : 0)
      : (newWorkMode === 'REMOTE' || newWorkMode === 'HYBRID' ? 1 : (emp.remote_allowed || 0));
    const newOvertimeCounted = overtimeCounted !== undefined
      ? (overtimeCounted ? 1 : 0)
      : (emp.overtime_counted !== undefined ? Number(emp.overtime_counted) : 0);

    await tx(async () => {
      // 1. Update working_pattern_id on active employment record
      if (targetPatternId !== undefined) {
        const activeRecord = await db.prepare(
          'SELECT id FROM employment_records WHERE employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
        ).get(employeeId);

        if (activeRecord) {
          await db.prepare('UPDATE employment_records SET working_pattern_id = ? WHERE id = ?')
            .run(targetPatternId || null, activeRecord.id);
        } else {
          // If no active employment record exists, create one with default settings
          const newErId = `er_${crypto.randomUUID().slice(0, 8)}`;
          await db.prepare(`
            INSERT INTO employment_records (
              id, employee_id, job_title, working_pattern_id, start_date, effective_from, created_at, created_by
            ) VALUES (?, ?, 'Team Member', ?, ?, ?, ?, ?)
          `).run(newErId, employeeId, targetPatternId || null, T.dateKey(nowMs), T.dateKey(nowMs), nowMs, 'HR');
        }
      }

      // 2. Update work_mode, remote_allowed, and overtime_counted on employees
      await db.prepare(`
        UPDATE employees
        SET work_mode = ?,
            remote_allowed = ?,
            overtime_counted = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newWorkMode, newRemoteAllowed, newOvertimeCounted, nowMs, employeeId);

      await audit({
        actor: req.auth.user ? req.auth.user.username : 'HR',
        action: 'EMPLOYEE_SHIFT_ASSIGNED',
        targetType: 'employee',
        targetId: employeeId,
        after: {
          workingPatternId: targetPatternId,
          workMode: newWorkMode,
          remoteAllowed: newRemoteAllowed,
          overtimeCounted: newOvertimeCounted,
          customShift: customShift || null,
        },
      });
    });

    // Invalidate cached default pattern and derive fresh schedule
    schedule.invalidate();
    const resolved = await schedule.resolve(employeeId, T.dateKey(nowMs));

    // Recompute today's attendance so changes take effect immediately
    const attendance = require('../domain/attendance');
    await attendance.recomputeDay(employeeId, T.dateKey(nowMs), nowMs).catch(() => {});

    res.json({
      status: 'SUCCESS',
      message: 'Employee shift, work mode, and overtime tracking settings updated successfully.',
      employee: {
        id: employeeId,
        workMode: newWorkMode,
        remoteAllowed: Boolean(newRemoteAllowed),
        overtimeCounted: Boolean(newOvertimeCounted),
        schedule: {
          patternId: resolved.patternId,
          patternName: resolved.patternName,
          startTime: resolved.startTime,
          endTime: resolved.endTime,
          graceMinutes: resolved.graceMinutes,
          permittedBreakMinutes: resolved.permittedBreakMinutes,
          dayEquivalentMinutes: resolved.dayEquivalentMinutes,
          workingDays: resolved.workingDays || 'mon,tue,wed,thu,fri',
          overtimeCounted: Boolean(resolved.overtimeCounted),
        },
      },
    });
  } catch (err) {
    console.error('[shifts/assign] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to assign shift to employee.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/shifts/manual-break - HR manually adds a break record for an employee
// ---------------------------------------------------------------------------
router.post('/manual-break', async (req, res) => {
  const {
    employeeId,
    dateKey = T.dateKey(),
    breakMinutes,
    startTime,
    endTime,
    reason = 'HR manual break entry',
    permittedMinutes,
  } = req.body;

  if (!employeeId) {
    return res.status(400).json({ status: 'ERROR', message: 'employeeId is required.' });
  }

  const emp = await db.prepare('SELECT id, name FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
  }

  const nowMs = T.now();
  const sched = await schedule.resolve(employeeId, dateKey);
  const permitted = permittedMinutes ? parseInt(permittedMinutes, 10) : (sched.permittedBreakMinutes || 30);

  let startedAtMs;
  let endedAtMs;
  let actualMinutes;

  if (startTime && endTime) {
    if (!TIME_RE.test(String(startTime)) || !TIME_RE.test(String(endTime))) {
      return res.status(400).json({ status: 'ERROR', message: 'startTime and endTime must be in HH:MM format.' });
    }
    startedAtMs = T.wallClockToEpoch(dateKey, String(startTime));
    endedAtMs = T.wallClockToEpoch(dateKey, String(endTime));
    if (endedAtMs <= startedAtMs) {
      return res.status(400).json({ status: 'ERROR', message: 'endTime must be after startTime.' });
    }
    actualMinutes = Math.max(1, Math.round((endedAtMs - startedAtMs) / 60000));
  } else {
    actualMinutes = parseInt(breakMinutes, 10);
    if (isNaN(actualMinutes) || actualMinutes <= 0) {
      return res.status(400).json({ status: 'ERROR', message: 'breakMinutes must be a positive integer.' });
    }
    // Place mid-shift or current time
    endedAtMs = dateKey === T.dateKey(nowMs) ? nowMs : T.wallClockToEpoch(dateKey, '14:30');
    startedAtMs = endedAtMs - (actualMinutes * 60000);
  }

  const excessMinutes = Math.max(0, actualMinutes - permitted);
  const breakId = `brk_hr_${crypto.randomUUID().slice(0, 8)}`;

  try {
    await db.prepare(`
      INSERT INTO break_records (
        id, employee_id, date_key, started_at, ended_at, permitted_minutes,
        actual_minutes, excess_minutes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      breakId,
      employeeId,
      dateKey,
      startedAtMs,
      endedAtMs,
      permitted,
      actualMinutes,
      excessMinutes,
      nowMs
    );

    await audit({
      actor: req.auth.user ? req.auth.user.username : 'HR',
      action: 'HR_MANUAL_BREAK_ADDED',
      targetType: 'break_record',
      targetId: breakId,
      details: {
        employeeId,
        dateKey,
        actualMinutes,
        permittedMinutes: permitted,
        excessMinutes,
        reason: String(reason).trim(),
      },
    });

    const attendance = require('../domain/attendance');
    await attendance.recomputeDay(employeeId, dateKey, nowMs);

    res.json({
      status: 'SUCCESS',
      message: `Manual break of ${actualMinutes} minutes recorded for ${emp.name} on ${dateKey}.`,
      breakRecord: {
        id: breakId,
        employeeId,
        dateKey,
        startedAt: startedAtMs,
        endedAt: endedAtMs,
        actualMinutes,
        permittedMinutes: permitted,
        excessMinutes,
        reason,
      },
    });
  } catch (err) {
    console.error('[shifts/manual-break] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to record manual break entry.' });
  }
});

module.exports = router;

