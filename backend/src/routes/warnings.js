// Warning and disciplinary API. Spec sections 9, 10, 19.5 and 21.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const {
  requireDevice, requireUser, requirePermission, requireEmployeeAccess, requireUserOrAdminKey,
} = require('../middleware/auth');
const W = require('../domain/warnings');
const rbac = require('../domain/rbac');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

// GET /api/warnings/mine - spec 19.2 and 19.5.
router.get('/mine', requireDevice, async (req, res) => {
  res.json({ status: 'SUCCESS', ...await W.employeeWarningView(req.auth.employeeId) });
});

// POST /api/warnings/:id/acknowledge
router.post('/:id/acknowledge', requireDevice, async (req, res) => {
  try {
    const r = await W.acknowledgeWarning({
      warningId: req.params.id,
      employeeId: req.auth.employeeId,
      comments: req.body?.comments ? String(req.body.comments).trim() : null,
    });
    res.json({
      status: 'SUCCESS', ...r,
      // Said explicitly, because signing to say you received something is not
      // the same as agreeing with it.
      message: 'Receipt acknowledged. This records that you received the warning, not that you agree with it.',
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// HR: the warning board (spec 21)
// ---------------------------------------------------------------------------

router.get('/board', requireUserOrAdminKey('warning.read'), async (req, res) => {
  const dateKey = String(req.query.date || T.dateKey());
  const visible = await rbac.accessibleEmployeeIds(req.auth);
  const employees = (await db.prepare('SELECT id, name, role, employee_number FROM employees WHERE active = 1').all())
    .filter(e => visible.includes(e.id));

  const rows = await Promise.all(employees.map(async e => {
    const view = await W.employeeWarningView(e.id, dateKey);
    return {
      employeeId: e.id,
      employeeName: e.name,
      employeeNumber: e.employee_number || null,
      role: e.role,
      band: view.band,
      bandLabel: view.bandLabel,
      lateOccurrences: view.lateness.resolved ? view.lateness.count : null,
      allowed: view.lateness.resolved ? view.lateness.allowed : null,
      pendingReview: view.pendingReview,
      activeWarnings: view.standing.activeWarnings,
      highestLevel: view.standing.highestLevelLabel,
      nextLevelIfConfirmed: view.standing.nextLevelIfConfirmed,
      sequenceExhausted: view.standing.sequenceExhausted,
    };
  }));

  // Ordered by urgency, so the people needing action are not buried.
  const rank = { RED: 0, AMBER: 1, UNKNOWN: 2, GREEN: 3 };
  rows.sort((a, b) => rank[a.band] - rank[b.band] || a.employeeName.localeCompare(b.employeeName));

  res.json({
    status: 'SUCCESS',
    counts: {
      red: rows.filter(r => r.band === 'RED').length,
      amber: rows.filter(r => r.band === 'AMBER').length,
      green: rows.filter(r => r.band === 'GREEN').length,
      unknown: rows.filter(r => r.band === 'UNKNOWN').length,
    },
    employees: rows,
  });
});

// GET /api/warnings/triggers?status=PENDING_REVIEW
router.get('/triggers', requireUserOrAdminKey('warning.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const rows = (await db.prepare(`
    SELECT t.*, e.name, e.employee_number FROM warning_triggers t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.status = ? ORDER BY t.triggered_at ASC
  `).all(String(req.query.status || 'PENDING_REVIEW')))
    .filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    triggers: await Promise.all(rows.map(async r => {
      const standing = await W.standingFor(r.employee_id);
      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.name,
        employeeNumber: r.employee_number || null,
        reason: r.trigger_reason,
        occurrences: r.occurrence_count,
        period: r.related_dates,
        raisedAt: T.displayTime(r.triggered_at),
        raisedOn: T.dateKey(r.triggered_at),
        status: r.status,
        // What WOULD be issued if confirmed. Shown before the decision, so it
        // is never a surprise to whoever is making it.
        proposedLevel: standing.nextLevel,
        proposedLevelLabel: standing.nextLevel ? W.levelLabel(standing.nextLevel) : null,
        sequenceExhausted: standing.sequenceExhausted,
        priorWarnings: standing.warningsIssued,
      };
    })),
  });
});

// GET /api/warnings/formal
router.get('/formal', requireUserOrAdminKey('warning.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const rows = (await db.prepare(`
    SELECT w.*, e.name AS employee_name, e.role AS employee_role, e.employee_number,
           a.acknowledged_at, a.comments AS ack_comments
    FROM formal_warnings w
    JOIN employees e ON e.id = w.employee_id
    LEFT JOIN warning_acknowledgements a ON a.warning_id = w.id
    ORDER BY w.issued_at DESC
  `).all()).filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    warnings: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      employeeNumber: r.employee_number || null,
      employeeRole: r.employee_role,
      level: r.warning_level,
      levelLabel: W.levelLabel(r.warning_level),
      warningType: r.warning_type,
      explanation: r.explanation,
      issuedAt: T.displayTime(r.issued_at),
      issuedAtMs: r.issued_at,
      issuedDate: T.dateKey(r.issued_at),
      expiryDate: r.expiry_date,
      status: r.status,
      acknowledgedAt: r.acknowledged_at ? T.displayTime(r.acknowledged_at) : null,
      ackComments: r.ack_comments,
      outcome: r.outcome,
    })),
  });
});

// POST /api/warnings/triggers/:id/review
router.post('/triggers/:id/review',
  requireUserOrAdminKey('warning.issue'),
  async (req, res) => {
    const trigger = await db.prepare('SELECT * FROM warning_triggers WHERE id = ?').get(req.params.id);
    if (!trigger) return res.status(404).json({ status: 'ERROR', message: 'No such trigger.' });
    if (!await rbac.canAccessEmployee(req.auth, trigger.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such trigger.' });
    }

    try {
      const r = await W.reviewTrigger({
        triggerId: req.params.id,
        decision: req.body?.decision,
        notes: req.body?.notes,
        explanation: req.body?.explanation,
        actor: req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`,
      });
      res.json({
        status: 'SUCCESS',
        decision: r.decision,
        warning: r.warning ? { ...r.warning, levelLabel: W.levelLabel(r.warning.level) } : null,
      });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

// ---------------------------------------------------------------------------
// HR: formal warnings
// ---------------------------------------------------------------------------

router.get('/employee/:employeeId',
  requireUserOrAdminKey('warning.read'), requireEmployeeAccess(),
  async (req, res) => {
    res.json({ status: 'SUCCESS', ...await W.employeeWarningView(req.params.employeeId) });
  });

// Issue a warning directly, without a trigger. Spec 3.3 allows HR to issue
// formal warnings; not every disciplinary matter starts with a lateness count.
router.post('/employee/:employeeId/issue',
  requireUserOrAdminKey('warning.issue'), requireEmployeeAccess(),
  async (req, res) => {
    const { level, warningType, explanation } = req.body || {};
    if (!explanation || !String(explanation).trim()) {
      return res.status(400).json({ status: 'ERROR', message: 'An explanation the employee will see is required.' });
    }
    const { config } = require('../config');
    if (!config.warningEscalationSequence.includes(level)) {
      return res.status(400).json({
        status: 'ERROR',
        message: `level must be one of ${config.warningEscalationSequence.join(', ')}.`,
      });
    }

    const warning = await W.issueFormalWarning({
      employeeId: req.params.employeeId,
      level,
      warningType: String(warningType || 'OTHER'),
      explanation: String(explanation).trim(),
      actor: req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`,
    });
    await W.refreshStanding(req.params.employeeId);

    res.status(201).json({
      status: 'SUCCESS',
      warning: { ...warning, levelLabel: W.levelLabel(warning.level) },
    });
  });

router.post('/:id/withdraw', requireUserOrAdminKey('warning.issue'), async (req, res) => {
  const w = await db.prepare('SELECT * FROM formal_warnings WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ status: 'ERROR', message: 'No such warning.' });
  if (!await rbac.canAccessEmployee(req.auth, w.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such warning.' });
  }

  try {
    await W.withdrawWarning({
      warningId: req.params.id,
      reason: req.body?.reason,
      actor: req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`,
    });
    res.json({ status: 'SUCCESS', message: 'Warning withdrawn. It no longer counts toward escalation.' });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// HR: absences (spec 10)
// ---------------------------------------------------------------------------

// GET /api/warnings/absences/mine - employee view of reported absences & no-shows
router.get('/absences/mine', requireDevice, async (req, res) => {
  const list = await W.listAbsences({ employeeId: req.auth.employeeId });
  res.json({
    status: 'SUCCESS',
    absences: list,
  });
});

// POST /api/warnings/absences/self-report - employee self-reports sickness / emergency (Spec 2.2)
router.post('/absences/self-report', requireDevice, async (req, res) => {
  const { dateKey, absenceType, reason, evidenceDocumentId } = req.body || {};
  if (!dateKey) {
    return res.status(400).json({ status: 'ERROR', message: 'dateKey (YYYY-MM-DD) is required.' });
  }

  try {
    const result = await W.selfReportAbsence({
      employeeId: req.auth.employeeId,
      dateKey,
      absenceType: absenceType || 'SICK',
      reason: reason || '',
      evidenceDocumentId: evidenceDocumentId || null,
    });
    res.status(201).json({
      status: 'SUCCESS',
      ...result,
      message: `Absence report for ${dateKey} submitted to HR for review.`,
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// HR: Unauthorised absence & no-show management (spec 10)
// ---------------------------------------------------------------------------

// POST /api/warnings/absences/scan - manual date scan for unscheduled no-shows
router.post('/absences/scan', requireUserOrAdminKey('attendance.write'), async (req, res) => {
  const dateKey = String(req.body?.dateKey || T.dateKey());
  try {
    const result = await W.scanDailyAbsences(dateKey, T.now(), true);
    res.json({
      status: 'SUCCESS',
      ...result,
      message: `Scanned ${result.scannedCount} employees for ${dateKey}. Flagged ${result.detectedCount} suspected absence(s).`,
    });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// GET /api/warnings/absences?status=ALL|PENDING_REVIEW|CONFIRMED|DISMISSED
router.get('/absences', requireUserOrAdminKey('warning.read'), async (req, res) => {
  const visible = new Set(await rbac.accessibleEmployeeIds(req.auth));
  const status = String(req.query.status || 'ALL');
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  const rows = await (await W.listAbsences({ status, from, to }))
    .filter(r => visible.has(r.employeeId));

  res.json({
    status: 'SUCCESS',
    absences: rows,
    counts: {
      pending: rows.filter(r => r.status === 'PENDING_REVIEW').length,
      confirmed: rows.filter(r => r.status === 'CONFIRMED').length,
      dismissed: rows.filter(r => r.status === 'DISMISSED').length,
    },
    note: 'No consequence is applied automatically. Each outcome is chosen per case and then approved before payroll.',
  });
});

router.post('/absences/:id/review',
  requireUserOrAdminKey('attendance.write'),
  async (req, res) => {
    const record = await db.prepare('SELECT * FROM absence_records WHERE id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ status: 'ERROR', message: 'No such absence record.' });
    if (!await rbac.canAccessEmployee(req.auth, record.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such absence record.' });
    }

    try {
      const r = await W.reviewAbsence({
        absenceId: req.params.id,
        status: req.body?.status,
        deductAnnualLeave: req.body?.deductAnnualLeave ?? null,
        treatAsUnpaid: req.body?.treatAsUnpaid ?? null,
        createWarningTrigger: req.body?.createWarningTrigger ?? null,
        notes: req.body?.notes,
        actor: req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`,
      });
      res.json({
        status: 'SUCCESS', ...r,
        message: 'Recorded. The chosen consequences are proposals and take effect only once approved.',
      });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

module.exports = router;
