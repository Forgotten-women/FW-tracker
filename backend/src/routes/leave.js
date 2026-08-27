// Leave API. Spec sections 13, 14, 15 and 19.4.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const {
  requireDevice, requireUser, requirePermission, requireEmployeeAccess,
} = require('../middleware/auth');
const L = require('../domain/leave');
const rbac = require('../domain/rbac');
const T = require('../util/time');

function presentBalance(b) {
  if (b.blocked) {
    return {
      blocked: true, reason: b.reason, message: b.message,
    };
  }
  return {
    blocked: false,
    holidayYear: { from: b.yearStart, to: b.yearEnd, monthsCompleted: b.monthsCompleted },
    nextAccrualDate: b.nextAccrualDate,
    // The five figures spec 19.4 asks the employee dashboard to show.
    annualEntitlement: b.annualEntitlementDays,
    accrued: b.accruedDays,
    taken: b.takenDays,
    booked: b.bookedDays,
    available: b.availableDays,
    isNegative: b.isNegative,
  };
}

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, (req, res) => {
  const { employeeId } = req.auth;
  const balance = L.balanceFor(employeeId);

  const requests = db.prepare(`
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

router.get('/types', requireDevice, (req, res) => {
  const rows = db.prepare('SELECT * FROM leave_types WHERE active = 1').all();
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
router.post('/preview', requireDevice, (req, res) => {
  const { leaveTypeId, startDate, endDate, dayPortion } = req.body || {};
  const p = L.previewRequest({
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

router.post('/request', requireDevice, (req, res) => {
  const { leaveTypeId, startDate, endDate, dayPortion, reason, evidenceDocumentId } = req.body || {};
  try {
    const r = L.submitRequest({
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

router.post('/request/:id/cancel', requireDevice, (req, res) => {
  const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!r || r.employee_id !== req.auth.employeeId) {
    return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
  }
  try {
    const out = L.cancelRequest({
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
// HR
// ---------------------------------------------------------------------------

router.get('/pending', requireUser, requirePermission('leave.read'), (req, res) => {
  const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
  const rows = db.prepare(`
    SELECT r.*, e.name AS employee_name, t.name AS type_name, t.reduces_entitlement
    FROM leave_requests r
    JOIN employees e ON e.id = r.employee_id
    JOIN leave_types t ON t.id = r.leave_type_id
    WHERE r.status IN ('PENDING_HR','PENDING_MANAGER') AND r.cancelled_at IS NULL
    ORDER BY r.start_date ASC
  `).all().filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    requests: rows.map(r => {
      // The balance is re-checked at review time, excluding this request, so
      // whoever decides sees the true position rather than the figure that was
      // true when it was submitted.
      const preview = L.previewRequest({
        employeeId: r.employee_id, leaveTypeId: r.leave_type_id,
        startDate: r.start_date, endDate: r.end_date, dayPortion: r.day_portion,
        excludeRequestId: r.id,
      });
      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        type: r.type_name,
        from: r.start_date, to: r.end_date, days: r.total_days,
        reason: r.reason,
        submittedAt: T.displayTime(r.submitted_at),
        balance: preview.ok ? presentBalance(preview.balance) : null,
        exceedsBalance: preview.ok ? preview.exceedsBalance : null,
        shortfallDays: preview.ok ? preview.shortfallDays : null,
        blocked: preview.ok ? null : preview.error,
      };
    }),
  });
});

router.post('/request/:id/decide',
  requireUser, requirePermission('leave.approve'),
  (req, res) => {
    const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
    if (!rbac.canAccessEmployee(req.auth, r.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such request.' });
    }

    try {
      const out = L.decideRequest({
        requestId: req.params.id,
        decision: req.body?.decision,
        notes: req.body?.notes,
        overdraftReason: req.body?.overdraftReason || null,
        actor: `user:${req.auth.id}`,
      });
      res.json({ status: 'SUCCESS', ...out, balance: presentBalance(L.balanceFor(r.employee_id)) });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.get('/employee/:employeeId',
  requireUser, requirePermission('leave.read'), requireEmployeeAccess(),
  (req, res) => {
    const balance = L.balanceFor(req.params.employeeId);
    const ledger = db.prepare(`
      SELECT * FROM leave_accrual_ledger WHERE employee_id = ?
      ORDER BY rowid DESC LIMIT 200
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
  requireUser, requirePermission('leave.write'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const balance = L.adjustBalance({
        employeeId: req.params.employeeId,
        days: Number(req.body?.days),
        reason: req.body?.reason,
        actor: `user:${req.auth.id}`,
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
router.get('/blocked', requireUser, requirePermission('leave.read'), (req, res) => {
  const visible = rbac.accessibleEmployeeIds(req.auth);
  const rows = db.prepare('SELECT id, name FROM employees WHERE active = 1').all()
    .filter(e => visible.includes(e.id))
    .map(e => ({ employee: e, year: L.holidayYearFor(e.id) }))
    .filter(x => x.year.blocked);

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

module.exports = router;
