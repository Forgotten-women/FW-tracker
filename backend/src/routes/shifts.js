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
// PUT /api/shifts/assign/:employeeId - Assign shift and work mode to an employee
// ---------------------------------------------------------------------------
router.put('/assign/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  const { workingPatternId, workMode, remoteAllowed } = req.body;

  const emp = await db.prepare('SELECT id, name, work_mode, remote_allowed FROM employees WHERE id = ?').get(employeeId);
  if (!emp) {
    return res.status(404).json({ status: 'ERROR', message: 'Employee not found.' });
  }

  if (workingPatternId) {
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
    await tx(async () => {
      // 1. Update working_pattern_id on active employment record
      if (workingPatternId !== undefined) {
        const activeRecord = await db.prepare(
          'SELECT id FROM employment_records WHERE employee_id = ? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
        ).get(employeeId);

        if (activeRecord) {
          await db.prepare('UPDATE employment_records SET working_pattern_id = ? WHERE id = ?')
            .run(workingPatternId || null, activeRecord.id);
        } else {
          // If no active employment record exists, create one with default settings
          const newErId = `er_${crypto.randomUUID().slice(0, 8)}`;
          await db.prepare(`
            INSERT INTO employment_records (
              id, employee_id, job_title, working_pattern_id, start_date, effective_from, created_at, created_by
            ) VALUES (?, ?, 'Team Member', ?, ?, ?, ?, ?)
          `).run(newErId, employeeId, workingPatternId || null, T.dateKey(nowMs), T.dateKey(nowMs), nowMs, 'HR');
        }
      }

      // 2. Update work_mode and remote_allowed on employees
      const newWorkMode = workMode || emp.work_mode || 'IN_OFFICE';
      const newRemoteAllowed = remoteAllowed !== undefined ? (remoteAllowed ? 1 : 0) : (newWorkMode === 'REMOTE' || newWorkMode === 'HYBRID' ? 1 : (emp.remote_allowed || 0));

      await db.prepare(`
        UPDATE employees
        SET work_mode = ?,
            remote_allowed = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newWorkMode, newRemoteAllowed, nowMs, employeeId);

      await audit({
        actor: req.auth.user ? req.auth.user.username : 'HR',
        action: 'EMPLOYEE_SHIFT_ASSIGNED',
        targetType: 'employee',
        targetId: employeeId,
        after: { workingPatternId, workMode: newWorkMode, remoteAllowed: newRemoteAllowed },
      });
    });

    // Re-resolve new schedule
    const resolved = await schedule.resolve(employeeId, T.dateKey(nowMs));

    res.json({
      status: 'SUCCESS',
      message: 'Employee shift and work mode updated successfully.',
      employee: {
        id: employeeId,
        workMode: workMode || emp.work_mode,
        remoteAllowed: remoteAllowed !== undefined ? !!remoteAllowed : !!emp.remote_allowed,
        schedule: {
          patternId: resolved.patternId,
          patternName: resolved.patternName,
          startTime: resolved.startTime,
          endTime: resolved.endTime,
          graceMinutes: resolved.graceMinutes,
          permittedBreakMinutes: resolved.permittedBreakMinutes,
          dayEquivalentMinutes: resolved.dayEquivalentMinutes,
          workingDays: resolved.workingDays || 'mon,tue,wed,thu,fri',
        },
      },
    });
  } catch (err) {
    console.error('[shifts/assign] Error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Failed to assign shift to employee.' });
  }
});

module.exports = router;
