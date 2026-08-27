// Payroll preparation API. Spec sections 17, 18 and 29.
//
// Every response here is a CALCULATION. Nothing in this router changes anyone's
// pay: adjustments are proposed, and a separate call by a person approves them.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireUser, requirePermission, requireEmployeeAccess } = require('../middleware/auth');
const PR = require('../domain/payroll');
const rbac = require('../domain/rbac');
const T = require('../util/time');

// Reading pay is a sensitive permission; spec 3.2 keeps it away from managers
// unless it has been explicitly granted.
router.use(requireUser);

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId/salary',
  requirePermission('employee.salary.read'), requireEmployeeAccess(),
  (req, res) => {
    const onDate = String(req.query.on || T.dateKey());
    const current = PR.salaryAt(req.params.employeeId, onDate);
    res.json({
      status: 'SUCCESS',
      onDate,
      current,
      history: PR.salaryHistoryFor(req.params.employeeId),
    });
  });

router.post('/employee/:employeeId/salary',
  requirePermission('employee.salary.write'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = PR.setSalary({
        employeeId: req.params.employeeId,
        amount: req.body?.amount,
        effectiveFrom: req.body?.effectiveFrom,
        reason: req.body?.reason,
        currency: req.body?.currency,
        payFrequency: req.body?.payFrequency,
        actor: `user:${req.auth.id}`,
      });
      res.status(201).json({
        status: 'SUCCESS',
        salary: r,
        message: 'Recorded. The previous salary is preserved, not overwritten.',
      });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// ---------------------------------------------------------------------------
// Starters and leavers
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId/starter',
  requirePermission('payroll.read'), requireEmployeeAccess(),
  (req, res) => {
    const periodStart = String(req.query.from || '');
    const periodEnd = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
    }
    res.json({
      status: 'SUCCESS',
      calculation: PR.starterCalculation({
        employeeId: req.params.employeeId, periodStart, periodEnd,
      }),
    });
  });

router.get('/employee/:employeeId/leaver',
  requirePermission('payroll.read'), requireEmployeeAccess(),
  (req, res) => {
    try {
      res.json({
        status: 'SUCCESS',
        calculation: PR.leaverCalculation({
          employeeId: req.params.employeeId,
          lastWorkingDate: String(req.query.lastWorkingDate || ''),
          periodStart: req.query.from ? String(req.query.from) : null,
        }),
      });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

router.get('/periods', requirePermission('payroll.read'), (req, res) => {
  const rows = db.prepare('SELECT * FROM payroll_periods ORDER BY start_date DESC').all();
  res.json({
    status: 'SUCCESS',
    periods: rows.map(p => ({
      id: p.id, name: p.name, from: p.start_date, to: p.end_date, status: p.status,
      approvedBy: p.approved_by,
      approvedAt: p.approved_at ? T.displayTime(p.approved_at) : null,
    })),
  });
});

router.post('/periods', requirePermission('payroll.approve'), (req, res) => {
  try {
    const p = PR.createPeriod({
      name: req.body?.name,
      startDate: req.body?.startDate,
      endDate: req.body?.endDate,
      actor: `user:${req.auth.id}`,
    });
    res.status(201).json({ status: 'SUCCESS', period: p });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// The preparation sheet. Read-only: computing it writes nothing.
router.get('/periods/:id/prepare', requirePermission('payroll.read'), (req, res) => {
  try {
    const sheet = PR.preparePeriod(req.params.id);
    const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
    res.json({
      status: 'SUCCESS',
      ...sheet,
      employees: sheet.employees.filter(e => visible.has(e.employeeId)),
      blocked: sheet.blocked.filter(b => visible.has(b.employeeId)),
    });
  } catch (err) {
    res.status(404).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/periods/:id/close', requirePermission('payroll.approve'), (req, res) => {
  try {
    res.json({ status: 'SUCCESS', ...PR.closePeriod({ periodId: req.params.id, actor: `user:${req.auth.id}` }) });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

router.get('/periods/:id/adjustments', requirePermission('payroll.read'), (req, res) => {
  const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
  const rows = db.prepare(`
    SELECT a.*, e.name FROM payroll_adjustments a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.period_id = ? ORDER BY a.created_at DESC
  `).all(req.params.id).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    adjustments: rows.map(a => ({
      id: a.id,
      employeeId: a.employee_id,
      employeeName: a.name,
      type: a.adjustment_type,
      // Kept apart on purpose: an overridden figure stays visible as an
      // override rather than replacing what was calculated.
      calculated: { days: a.calculated_days, amount: a.calculated_amount },
      approved: a.status === 'APPROVED'
        ? { days: a.approved_days, amount: a.approved_amount }
        : null,
      status: a.status,
      explanation: a.explanation,
      approvedBy: a.approved_by,
      approvedAt: a.approved_at ? T.displayTime(a.approved_at) : null,
    })),
  });
});

router.post('/periods/:id/adjustments', requirePermission('payroll.read'), (req, res) => {
  try {
    const a = PR.proposeAdjustment({
      periodId: req.params.id,
      employeeId: req.body?.employeeId,
      adjustmentType: req.body?.adjustmentType,
      calculatedDays: req.body?.calculatedDays,
      calculatedAmount: req.body?.calculatedAmount,
      explanation: req.body?.explanation,
      sourceReference: req.body?.sourceReference,
      actor: `user:${req.auth.id}`,
    });
    res.status(201).json({
      status: 'SUCCESS', adjustment: a,
      message: 'Proposed. It affects nothing until it is approved.',
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// Approving is a distinct permission from proposing, so the person who works
// out a deduction is not necessarily the person who signs it off.
router.post('/adjustments/:id/decide', requirePermission('payroll.approve'), (req, res) => {
  try {
    const r = PR.decideAdjustment({
      adjustmentId: req.params.id,
      decision: req.body?.decision,
      approvedDays: req.body?.approvedDays ?? null,
      approvedAmount: req.body?.approvedAmount ?? null,
      notes: req.body?.notes,
      actor: `user:${req.auth.id}`,
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
