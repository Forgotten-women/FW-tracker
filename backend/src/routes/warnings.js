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
router.get('/mine', requireDevice, (req, res) => {
  res.json({ status: 'SUCCESS', ...W.employeeWarningView(req.auth.employeeId) });
});

// POST /api/warnings/:id/acknowledge
router.post('/:id/acknowledge', requireDevice, (req, res) => {
  try {
    const r = W.acknowledgeWarning({
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

router.get('/board', requireUserOrAdminKey('warning.read'), (req, res) => {
  const dateKey = String(req.query.date || T.dateKey());
  const visible = rbac.accessibleEmployeeIds(req.auth);
  const employees = db.prepare('SELECT id, name, role FROM employees WHERE active = 1').all()
    .filter(e => visible.includes(e.id));

  const rows = employees.map(e => {
    const view = W.employeeWarningView(e.id, dateKey);
    return {
      employeeId: e.id,
      employeeName: e.name,
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
  });

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
router.get('/triggers', requireUserOrAdminKey('warning.read'), (req, res) => {
  const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
  const rows = db.prepare(`
    SELECT t.*, e.name FROM warning_triggers t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.status = ? ORDER BY t.triggered_at ASC
  `).all(String(req.query.status || 'PENDING_REVIEW'))
    .filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    triggers: rows.map(r => {
      const standing = W.standingFor(r.employee_id);
      return {
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.name,
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
    }),
  });
});

// GET /api/warnings/formal
router.get('/formal', requireUserOrAdminKey('warning.read'), (req, res) => {
  const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
  const rows = db.prepare(`
    SELECT w.*, e.name AS employee_name, e.role AS employee_role,
           a.acknowledged_at, a.comments AS ack_comments
    FROM formal_warnings w
    JOIN employees e ON e.id = w.employee_id
    LEFT JOIN warning_acknowledgements a ON a.warning_id = w.id
    ORDER BY w.issued_at DESC
  `).all().filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    warnings: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
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
  (req, res) => {
    const trigger = db.prepare('SELECT * FROM warning_triggers WHERE id = ?').get(req.params.id);
    if (!trigger) return res.status(404).json({ status: 'ERROR', message: 'No such trigger.' });
    if (!rbac.canAccessEmployee(req.auth, trigger.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such trigger.' });
    }

    try {
      const r = W.reviewTrigger({
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
  (req, res) => {
    res.json({ status: 'SUCCESS', ...W.employeeWarningView(req.params.employeeId) });
  });

// Issue a warning directly, without a trigger. Spec 3.3 allows HR to issue
// formal warnings; not every disciplinary matter starts with a lateness count.
router.post('/employee/:employeeId/issue',
  requireUserOrAdminKey('warning.issue'), requireEmployeeAccess(),
  (req, res) => {
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

    const warning = W.issueFormalWarning({
      employeeId: req.params.employeeId,
      level,
      warningType: String(warningType || 'OTHER'),
      explanation: String(explanation).trim(),
      actor: req.auth.kind === 'admin' ? 'admin' : `user:${req.auth.id}`,
    });
    W.refreshStanding(req.params.employeeId);

    res.status(201).json({
      status: 'SUCCESS',
      warning: { ...warning, levelLabel: W.levelLabel(warning.level) },
    });
  });

router.post('/:id/withdraw', requireUserOrAdminKey('warning.issue'), (req, res) => {
  const w = db.prepare('SELECT * FROM formal_warnings WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ status: 'ERROR', message: 'No such warning.' });
  if (!rbac.canAccessEmployee(req.auth, w.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such warning.' });
  }

  try {
    W.withdrawWarning({
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

router.get('/absences', requireUserOrAdminKey('attendance.read'), (req, res) => {
  const visible = new Set(rbac.accessibleEmployeeIds(req.auth));
  const rows = db.prepare(`
    SELECT a.*, e.name FROM absence_records a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.status = ? ORDER BY a.date_key DESC
  `).all(String(req.query.status || 'PENDING_REVIEW'))
    .filter(r => visible.has(r.employee_id));

  res.json({
    status: 'SUCCESS',
    absences: rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.name,
      date: r.date_key,
      type: r.absence_type,
      detectedAt: T.displayTime(r.detected_at),
      status: r.status,
      // Null means nobody has decided. Rendered as "not decided", never as "no".
      consequences: {
        deductAnnualLeave: r.deduct_annual_leave === null ? null : !!r.deduct_annual_leave,
        treatAsUnpaid: r.treat_as_unpaid === null ? null : !!r.treat_as_unpaid,
        createWarningTrigger: r.create_warning_trigger === null ? null : !!r.create_warning_trigger,
      },
    })),
    note: 'No consequence is applied automatically. Each outcome is chosen per case and then approved before payroll.',
  });
});

router.post('/absences/:id/review',
  requireUserOrAdminKey('attendance.write'),
  (req, res) => {
    const record = db.prepare('SELECT * FROM absence_records WHERE id = ?').get(req.params.id);
    if (!record) return res.status(404).json({ status: 'ERROR', message: 'No such absence record.' });
    if (!rbac.canAccessEmployee(req.auth, record.employee_id)) {
      return res.status(404).json({ status: 'ERROR', message: 'No such absence record.' });
    }

    try {
      const r = W.reviewAbsence({
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
