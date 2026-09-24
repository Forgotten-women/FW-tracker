// Payroll preparation API. Spec sections 17, 18 and 29.
//
// Every response here is a CALCULATION. Nothing in this router changes anyone's
// pay: adjustments are proposed, and a separate call by a person approves them.
// The monthly run is the same rule in bulk - the tick prepares a run, and only
// POST /periods/:id/approve-run, by a person holding payroll.approve, turns it
// into payslips.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireDevice, requirePermission, requireEmployeeAccess, requireUserOrAdminKey } = require('../middleware/auth');
const PR = require('../domain/payroll');
const rbac = require('../domain/rbac');
const T = require('../util/time');

/**
 * The { status: 'ERROR', message } body every route here returns. A payroll
 * run error also carries its code, its HTTP status and any detail (the
 * blocking preflight, the lines still undecided) the dashboard needs to show
 * why.
 */
function sendError(res, err, fallbackStatus = 400) {
  if (err instanceof PR.PayrollRunError) {
    return res.status(err.httpStatus || fallbackStatus).json({
      status: 'ERROR', code: err.code, message: err.message, ...(err.details || {}),
    });
  }
  return res.status(fallbackStatus).json({ status: 'ERROR', message: err.message });
}

// ---------------------------------------------------------------------------
// Employee self-service: Monthly Statements & Period History
// ---------------------------------------------------------------------------

router.get('/mine/statements', requireDevice, async (req, res) => {
  try {
    const { employeeId } = req.auth;
    const result = await PR.employeeStatements(employeeId);
    res.json({
      status: 'SUCCESS',
      ...result,
    });
  } catch (err) {
    console.error('Error in /mine/statements:', err);
    res.status(500).json({
      status: 'ERROR',
      message: err.message || 'Failed to load payroll statements',
    });
  }
});

// One of the caller's own published payslips. Scoped to the device's employee,
// so there is no way to ask for anyone else's.
router.get('/mine/payslips/:periodId', requireDevice, async (req, res) => {
  try {
    const payslip = await PR.employeePayslip(req.auth.employeeId, req.params.periodId);
    if (!payslip) {
      return res.status(404).json({ status: 'ERROR', message: 'No published payslip for that period.' });
    }
    res.json({ status: 'SUCCESS', payslip });
  } catch (err) {
    sendError(res, err, 500);
  }
});

// Reading pay is a sensitive permission; spec 3.2 keeps it away from managers
// unless it has been explicitly granted.
router.use(requireUserOrAdminKey());

function getActor(req) {
  return req.auth?.actor || (req.auth?.id ? `user:${req.auth.id}` : 'admin');
}

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId/salary',
  requirePermission('employee.salary.read'), requireEmployeeAccess(),
  async (req, res) => {
    const onDate = String(req.query.on || T.dateKey());
    const current = await PR.salaryAt(req.params.employeeId, onDate);
    res.json({
      status: 'SUCCESS',
      onDate,
      current,
      history: await PR.salaryHistoryFor(req.params.employeeId),
    });
  });

router.post('/employee/:employeeId/salary',
  requirePermission('employee.salary.write'), requireEmployeeAccess(),
  async (req, res) => {
    try {
      const r = await PR.setSalary({
        employeeId: req.params.employeeId,
        amount: req.body?.amount,
        effectiveFrom: req.body?.effectiveFrom,
        reason: req.body?.reason,
        currency: req.body?.currency,
        payFrequency: req.body?.payFrequency,
        actor: getActor(req),
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
  async (req, res) => {
    const periodStart = String(req.query.from || '');
    const periodEnd = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
      return res.status(400).json({ status: 'ERROR', message: 'from and to must be YYYY-MM-DD.' });
    }
    res.json({
      status: 'SUCCESS',
      calculation: await PR.starterCalculation({
        employeeId: req.params.employeeId, periodStart, periodEnd,
      }),
    });
  });

router.get('/employee/:employeeId/leaver',
  requirePermission('payroll.read'), requireEmployeeAccess(),
  async (req, res) => {
    try {
      res.json({
        status: 'SUCCESS',
        calculation: await PR.leaverCalculation({
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

router.get('/periods', requirePermission('payroll.read'), async (req, res) => {
  const rows = await db.prepare('SELECT * FROM payroll_periods ORDER BY start_date DESC').all();
  res.json({
    status: 'SUCCESS',
    periods: rows.map(p => ({
      id: p.id, name: p.name, from: p.start_date, to: p.end_date, status: p.status,
      exchangeRate: p.exchange_rate || 350.0,
      approvedBy: p.approved_by,
      approvedAt: p.approved_at ? T.displayTime(p.approved_at) : null,
      // The monthly run. Timestamps are epoch ms; null until they happen.
      cutoffDate: p.cutoff_date || null,
      payDate: p.pay_date || null,
      autoCreated: !!p.auto_created,
      generatedAt: p.generated_at || null,
      publishedAt: p.published_at || null,
      publishedBy: p.published_by || null,
      paidAt: p.paid_at || null,
    })),
  });
});

router.post('/periods', requirePermission('payroll.approve'), async (req, res) => {
  try {
    const p = await PR.createPeriod({
      name: req.body?.name,
      startDate: req.body?.startDate,
      endDate: req.body?.endDate,
      exchangeRate: req.body?.exchangeRate,
      cutoffDate: req.body?.cutoffDate ?? null,
      payDate: req.body?.payDate ?? null,
      actor: getActor(req),
    });
    res.status(201).json({ status: 'SUCCESS', period: p });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/periods/:id/exchange-rate', requirePermission('payroll.approve'), async (req, res) => {
  try {
    const r = await PR.updatePeriodExchangeRate({
      periodId: req.params.id,
      exchangeRate: req.body?.exchangeRate,
      actor: getActor(req),
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// The preparation sheet. Read-only: computing it writes nothing.
router.get('/periods/:id/prepare', requirePermission('payroll.read'), async (req, res) => {
  try {
    const sheet = await PR.preparePeriod(req.params.id);
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
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

// Turns the unpaid-days preview the prepare sheet already shows into real
// PROPOSED adjustments. Deliberately a separate explicit action (not a side
// effect of GET .../prepare) and gated on payroll.approve rather than
// payroll.read -- generating deductions for the whole period is closer in
// weight to closing it than to a single manual adjustment. Safe to call more
// than once; a second call creates nothing new.
router.post('/periods/:id/generate-deductions', requirePermission('payroll.approve'), async (req, res) => {
  try {
    res.json({ status: 'SUCCESS', ...await PR.generatePeriodDeductions({ periodId: req.params.id, actor: getActor(req) }) });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

router.post('/periods/:id/close', requirePermission('payroll.approve'), async (req, res) => {
  try {
    res.json({ status: 'SUCCESS', ...await PR.closePeriod({ periodId: req.params.id, actor: getActor(req) }) });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// The monthly run: review, approve, pay
// ---------------------------------------------------------------------------

// What would make approving this run wrong right now. Read-only.
router.get('/periods/:id/preflight', requirePermission('payroll.read'), async (req, res) => {
  try {
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
    const checks = await PR.payrollPreflight(req.params.id);
    res.json({
      status: 'SUCCESS',
      periodId: req.params.id,
      blocking: checks.some(c => c.severity === 'BLOCKING'),
      // Counts are the whole run's, since approval publishes the whole run;
      // the named items are limited to employees the caller may see.
      preflight: checks.map(c => ({ ...c, items: c.items.filter(i => !i.employeeId || visible.has(i.employeeId)) })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// The sheet a run is approved from. Read-only.
router.get('/periods/:id/review', requirePermission('payroll.read'), async (req, res) => {
  try {
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
    const sheet = await PR.reviewPeriod(req.params.id, { visibleEmployeeIds: visible });
    res.json({
      status: 'SUCCESS',
      ...sheet,
      preflight: sheet.preflight.map(c => ({ ...c, items: c.items.filter(i => !i.employeeId || visible.has(i.employeeId)) })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Approving a run is a person's decision about every line in it: ROUTINE
// lines are approved in bulk under the required note, ATTENTION lines must
// each be decided (before, or in `decisions`), and blockers need an explicit
// waiver. Refused, it changes nothing.
router.post('/periods/:id/approve-run', requirePermission('payroll.approve'), async (req, res) => {
  try {
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
    const r = await PR.approveRun({
      periodId: req.params.id,
      note: req.body?.note,
      decisions: req.body?.decisions ?? [],
      waiveBlockers: req.body?.waiveBlockers === true,
      waiverNote: req.body?.waiverNote ?? null,
      actor: getActor(req),
      visibleEmployeeIds: visible,
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/periods/:id/mark-paid', requirePermission('payroll.approve'), async (req, res) => {
  try {
    const r = await PR.markPaid({ periodId: req.params.id, actor: getActor(req), note: req.body?.note ?? null });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/periods/:id/payslips', requirePermission('payroll.read'), async (req, res) => {
  try {
    const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
    const r = await PR.listPayslips(req.params.id);
    res.json({ status: 'SUCCESS', period: r.period, payslips: r.payslips.filter(p => visible.has(p.employeeId)) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

router.get('/periods/:id/adjustments', requirePermission('payroll.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const rows = (await db.prepare(`
    SELECT a.*, e.name, e.employee_number FROM payroll_adjustments a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.period_id = ? ORDER BY a.created_at DESC
  `).all(req.params.id)).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    adjustments: rows.map(a => ({
      id: a.id,
      employeeId: a.employee_id,
      employeeName: a.name,
      employeeNumber: a.employee_number || null,
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

router.post('/periods/:id/adjustments', requirePermission('payroll.read'), async (req, res) => {
  try {
    const a = await PR.proposeAdjustment({
      periodId: req.params.id,
      employeeId: req.body?.employeeId,
      adjustmentType: req.body?.adjustmentType,
      calculatedDays: req.body?.calculatedDays,
      calculatedAmount: req.body?.calculatedAmount,
      explanation: req.body?.explanation,
      sourceReference: req.body?.sourceReference,
      actor: getActor(req),
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
router.post('/adjustments/:id/decide', requirePermission('payroll.approve'), async (req, res) => {
  try {
    const r = await PR.decideAdjustment({
      adjustmentId: req.params.id,
      decision: req.body?.decision,
      approvedDays: req.body?.approvedDays ?? null,
      approvedAmount: req.body?.approvedAmount ?? null,
      notes: req.body?.notes,
      actor: getActor(req),
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;

