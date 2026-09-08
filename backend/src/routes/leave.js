// Leave API. Spec sections 13, 14, 15 and 19.4.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const {
  requireDevice, requireUser, requirePermission, requireEmployeeAccess, requireUserOrAdminKey,
} = require('../middleware/auth');
const L = require('../domain/leave');
const rbac = require('../domain/rbac');
const T = require('../util/time');

function presentBalance(b) {
  if (!b || b.blocked) {
    return {
      blocked: true, reason: b?.reason || 'NOT_AVAILABLE', message: b?.message || 'Leave balance not computable.',
    };
  }
  return {
    blocked: false,
    holidayYear: {
      from: b.cycleStartDate || b.yearStart,
      to: b.cycleEndDate || b.yearEnd,
      anniversaryDate: b.nextRenewalDate || b.yearEnd,
      monthsCompleted: b.monthsCompleted,
    },
    cycleStartDate: b.cycleStartDate || b.yearStart,
    cycleEndDate: b.cycleEndDate || b.yearEnd,
    nextRenewalDate: b.nextRenewalDate || b.yearEnd,
    nextAccrualDate: b.nextAccrualDate,
    officialJoiningDate: b.officialJoiningDate || b.startDate,

    // 8-Metric Leave Report Breakdown (spec & policy):
    // 1. Current year's/cycle's annual leave entitlement
    annualEntitlement: b.annualEntitlementDays,
    annualEntitlementDays: b.annualEntitlementDays,
    // 2. Leave accrued to date
    accrued: b.accruedDays,
    accruedDays: b.accruedDays,
    // 3. Leave already used
    taken: b.takenDays,
    takenDays: b.takenDays,
    // 4. Approved carry-forward leave from the previous cycle
    approvedCarryForward: b.approvedCarryForwardDays || 0,
    approvedCarryForwardDays: b.approvedCarryForwardDays || 0,
    // 5. Remaining current-cycle leave
    remainingCurrentCycle: b.remainingCurrentCycleDays != null ? b.remainingCurrentCycleDays : b.availableDays,
    remainingCurrentCycleDays: b.remainingCurrentCycleDays != null ? b.remainingCurrentCycleDays : b.availableDays,
    // 6. Leave due to expire
    dueToExpire: b.leaveDueToExpire || 0,
    leaveDueToExpire: b.leaveDueToExpire || 0,
    // 7. Leave that has already lapsed
    alreadyLapsed: b.leaveAlreadyLapsed || 0,
    leaveAlreadyLapsed: b.leaveAlreadyLapsed || 0,
    // 8. Next leave renewal / work-anniversary date
    renewalDate: b.nextRenewalDate || b.yearEnd,

    // Balances
    booked: b.bookedDays,
    bookedDays: b.bookedDays,
    available: b.availableDays,
    availableDays: b.availableDays,
    isNegative: b.isNegative,
    carryForwardDecision: b.carryForwardDecision || null,
  };
}

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, async (req, res) => {
  const { employeeId } = req.auth;
  const balance = await L.balanceFor(employeeId);

  const requests = await db.prepare(`
    SELECT r.*, t.name AS type_name FROM leave_requests r
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.employee_id = ? ORDER BY r.start_date DESC LIMIT 50
  `).all(employeeId);

  res.json({
    status: 'SUCCESS',
    balance: presentBalance(balance),
    requests: requests.map(r => ({
      id: r.id, type: r.type_name, from: r.start_date, to: r.end_date,
      days: r.total_days, status: r.status,
      submittedAt: T.displayTime(r.submitted_at),
      decidedAt: r.decided_at ? T.displayTime(r.decided_at) : null,
    })),
  });
});

router.get('/types', requireDevice, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM leave_types WHERE active = 1').all();
  res.json({
    status: 'SUCCESS',
    types: rows.map(t => ({
      id: t.id, name: t.name,
      reducesEntitlement: !!t.reduces_entitlement,
      requiresEvidence: !!t.requires_evidence,
      isPaid: !!t.is_paid,
    })),
  });
});

// Spec 15 asks for the figures to be shown BEFORE submission, so nobody
// discovers a shortfall after the fact.
router.post('/preview', requireDevice, async (req, res) => {
  const { leaveTypeId, startDate, endDate, dayPortion } = req.body || {};
  const p = await L.previewRequest({
    employeeId: req.auth.employeeId, leaveTypeId, startDate, endDate, dayPortion,
  });
  if (!p.ok) return res.status(400).json({ status: 'ERROR', ...p });

  res.json({
    status: 'SUCCESS',
    requestedDays: p.requestedDays,
    skipped: p.skipped,
    balance: presentBalance(p.balance),
    projectedAvailable: p.projectedAvailableDays,
    exceedsBalance: p.exceedsBalance,
    shortfallDays: p.shortfallDays,
    warning: p.warning,
  });
});

router.post('/request', requireDevice, async (req, res) => {
  const { leaveTypeId, startDate, endDate, dayPortion, reason, evidenceDocumentId } = req.body || {};
  try {
    const r = await L.submitRequest({
      employeeId: req.auth.employeeId,
      leaveTypeId, startDate, endDate, dayPortion, reason, evidenceDocumentId,
    });
    res.status(201).json({
      status: 'SUCCESS',
      requestId: r.id,
      days: r.requestedDays,
      requestStatus: r.status,
      exceedsBalance: r.exceedsBalance,
      message: r.exceedsBalance
        ? 'Submitted. This is more than you have accrued, so HR must approve going beyond your entitlement.'
        : 'Submitted for HR approval.',
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/request/:id/cancel', requireDevice, async (req, res) => {
  const r = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!r || r.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
  }
  try {
    const out = await L.cancelRequest({
      requestId: req.params.id,
      actor: `employee:${req.auth.employeeId}`,
      reason: req.body?.reason || null,
    });
    res.json({ status: 'SUCCESS', ...out });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// HR / Admin Leave Management
// ---------------------------------------------------------------------------

router.get('/pending', requireUserOrAdminKey('leave.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const rows = (await db.prepare(`
    SELECT r.*, e.name AS employee_name, e.role AS employee_role, e.employee_number, t.name AS type_name, t.reduces_entitlement, t.requires_evidence
    FROM leave_requests r
    JOIN employees e ON e.id = r.employee_id
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.status IN ('PENDING_HR','PENDING_MANAGER') AND r.cancelled_at IS NULL
    ORDER BY r.start_date ASC
  `).all()).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    requests: await Promise.all(rows.map(async r => {
      const preview = await L.previewRequest({
        employeeId: r.employee_id, leaveTypeId: r.leave_type_id,
        startDate: r.start_date, endDate: r.end_date, dayPortion: r.day_portion,
        excludeRequestId: r.id,
      });
      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        employeeNumber: r.employee_number || null,
        employeeRole: r.employee_role,
        type: r.type_name,
        leaveTypeId: r.leave_type_id,
        from: r.start_date, to: r.end_date, days: r.total_days,
        reason: r.reason,
        submittedAt: T.displayTime(r.submitted_at),
        submittedAtMs: r.submitted_at,
        balance: preview.ok ? presentBalance(preview.balance) : null,
        exceedsBalance: preview.ok ? preview.exceedsBalance : null,
        shortfallDays: preview.ok ? preview.shortfallDays : null,
        blocked: preview.ok ? null : preview.error,
        reducesEntitlement: !!r.reduces_entitlement,
        requiresEvidence: !!r.requires_evidence,
      };
    })),
  });
});

router.get('/requests', requireUserOrAdminKey('leave.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const statusFilter = req.query.status;

  let query = `
    SELECT r.*, e.name AS employee_name, e.role AS employee_role, e.employee_number, t.name AS type_name, t.reduces_entitlement, t.requires_evidence
    FROM leave_requests r
    JOIN employees e ON e.id = r.employee_id
    JOIN leave_types t ON t.id = r.leave_type_id
  `;
  const params = [];
  if (statusFilter && statusFilter !== 'ALL') {
    query += ' WHERE r.status = ? ';
    params.push(statusFilter);
  }
  query += ' ORDER BY r.start_date DESC LIMIT 200';

  const rows = (await db.prepare(query).all(...params)).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    requests: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeNumber: r.employee_number || null,
      employeeRole: r.employee_role,
      type: r.type_name,
      leaveTypeId: r.leave_type_id,
      from: r.start_date,
      to: r.end_date,
      days: r.total_days,
      status: r.status,
      reason: r.reason,
      notes: r.decision_notes,
      shortfallDays: r.shortfall_days || 0,
      reducesEntitlement: !!r.reduces_entitlement,
      requiresEvidence: !!r.requires_evidence,
      submittedAt: T.displayTime(r.submitted_at),
      submittedAtMs: r.submitted_at,
      decidedAt: r.decided_at ? T.displayTime(r.decided_at) : null,
      decidedBy: r.decided_by,
    })),
  });
});

router.get('/balances', requireUserOrAdminKey('leave.read'), async (req, res) => {
  const visible = await rbac.accessibleEmployeeIds(req.auth);
  const employees = (await db.prepare('SELECT id, name, role, employee_number FROM employees WHERE active = 1').all())
    .filter(e => visible.includes(e.id));

  const rows = await Promise.all(employees.map(async e => {
    const b = await L.balanceFor(e.id);
    return {
      employeeId: e.id,
      employeeName: e.name,
      employeeNumber: e.employee_number || null,
      role: e.role,
      balance: presentBalance(b),
    };
  }));

  res.json({
    status: 'SUCCESS',
    employees: rows,
  });
});

router.get('/calendar', requireUserOrAdminKey('leave.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const from = String(req.query.from || T.dateKey(T.now() - 30 * 24 * 60 * 60 * 1000));
  const to = String(req.query.to || T.dateKey(T.now() + 60 * 24 * 60 * 60 * 1000));

  const rows = (await db.prepare(`
    SELECT r.*, e.name AS employee_name, e.employee_number, t.name AS type_name
    FROM leave_requests r
    JOIN employees e ON e.id = r.employee_id
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.status = 'APPROVED' AND r.cancelled_at IS NULL
      AND r.start_date <= ? AND r.end_date >= ?
    ORDER BY r.start_date ASC
  `).all(to, from)).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    from,
    to,
    leaves: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeNumber: r.employee_number || null,
      type: r.type_name,
      from: r.start_date,
      to: r.end_date,
      days: r.total_days,
    })),
  });
});

router.post('/request/:id/decide',
  requireUserOrAdminKey('leave.approve'),
  async (req, res) => {
    const r = await db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
    if (!await rbac.canAccessEmployee(req.auth, r.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
    }

    try {
      const actor = req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`;
      const out = await L.decideRequest({
        requestId: req.params.id,
        decision: req.body?.decision,
        notes: req.body?.notes,
        overdraftReason: req.body?.overdraftReason || null,
        actor,
      });
      res.json({ status: 'SUCCESS', ...out, balance: presentBalance(await L.balanceFor(r.employee_id)) });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.get('/employee/:employeeId',
  requireUserOrAdminKey('leave.read'), requireEmployeeAccess(),
  async (req, res) => {
    const balance = await L.balanceFor(req.params.employeeId);
    const ledger = await db.prepare(`
      SELECT * FROM leave_accrual_ledger WHERE employee_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 200
    `).all(req.params.employeeId);

    res.json({
      status: 'SUCCESS',
      balance: presentBalance(balance),
      ledger: ledger.map(l => ({
        type: l.entry_type,
        days: Math.round(l.days_delta * 100) / 100,
        effectiveDate: l.effective_date,
        description: l.description,
        by: l.created_by,
        at: T.displayTime(l.created_at),
      })),
    });
  });

router.post('/employee/:employeeId/adjust',
  requireUserOrAdminKey('leave.write'), requireEmployeeAccess(),
  async (req, res) => {
    try {
      const actor = req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`;
      const balance = await L.adjustBalance({
        employeeId: req.params.employeeId,
        days: Number(req.body?.days),
        reason: req.body?.reason,
        actor,
        onDate: req.body?.onDate || T.dateKey(),
      });
      res.json({ status: 'SUCCESS', balance: presentBalance(balance) });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// Who cannot be assessed at all, and why. Under an anniversary-based year an
// employee with no start date has no computable balance, and that needs to be
// visible rather than showing as zero.
router.get('/blocked', requireUserOrAdminKey('leave.read'), async (req, res) => {
  const visible = await rbac.accessibleEmployeeIds(req.auth);
  // The .filter used to run on the results of an async .map, i.e. on promises,
  // which are always truthy - so every active employee was reported as blocked.
  // Resolve first, then filter.
  const resolved = await Promise.all(
    (await db.prepare('SELECT id, name FROM employees WHERE active = 1').all())
      .filter(e => visible.includes(e.id))
      .map(async e => ({ employee: e, year: await L.holidayYearFor(e.id) })),
  );
  const rows = resolved.filter(x => x.year.blocked);

  res.json({
    status: 'SUCCESS',
    blocked: rows.map(x => ({
      employeeId: x.employee.id,
      employeeName: x.employee.name,
      reason: x.year.reason,
      message: x.year.message,
    })),
  });
});

// ---------------------------------------------------------------------------
// Carry Forward & Anniversary Rollover Endpoints
// ---------------------------------------------------------------------------

router.get('/carry-forward/approaching',
  requireUserOrAdminKey('leave.read'),
  async (req, res) => {
    try {
      const today = String(req.query.date || T.dateKey());
      const list = await L.employeesApproachingAnniversary(today);
      res.json({ status: 'SUCCESS', employees: list });
    } catch (err) {
      res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

router.post('/carry-forward/record',
  requireUserOrAdminKey('leave.approve'),
  async (req, res) => {
    const { employeeId, approvedDays, notes } = req.body || {};
    if (!employeeId) {
      return res.status(400).json({ status: 'ERROR', message: 'employeeId is required.' });
    }
    if (!await rbac.canAccessEmployee(req.auth, employeeId)) {
      return res.status(403).json({ status: 'ERROR', message: 'Access denied.' });
    }

    try {
      const actor = req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`;
      const record = await L.recordCarryForwardApproval({
        employeeId,
        approvedDays: Number(approvedDays),
        notes,
        actor,
      });

      const updatedBalance = await L.balanceFor(employeeId);
      res.json({
        status: 'SUCCESS',
        message: Number(approvedDays) > 0
          ? `${approvedDays} day(s) approved for carry forward.`
          : 'Carry forward rejected; unused leave will lapse at cycle end.',
        record,
        balance: presentBalance(updatedBalance),
      });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.get('/employee/:employeeId/cycles',
  requireUserOrAdminKey('leave.read'), requireEmployeeAccess(),
  async (req, res) => {
    try {
      const cycles = await L.historicalCyclesFor(req.params.employeeId);
      const balance = await L.balanceFor(req.params.employeeId);
      res.json({
        status: 'SUCCESS',
        employeeId: req.params.employeeId,
        currentBalance: presentBalance(balance),
        cycles,
      });
    } catch (err) {
      res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

module.exports = router;
