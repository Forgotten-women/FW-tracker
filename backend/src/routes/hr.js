// Advanced HR API: alert board and performance reviews. Spec sections 20.2,
// 22 and Phase 8. Confirmed 2026-08-27: HR and Super Admin only.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireUserOrAdminKey, requireEmployeeAccess } = require('../middleware/auth');
const AL = require('../domain/alerts');
const T = require('../util/time');

// GET /api/hr/alerts - the Advanced HR board. Spec 20.2.
router.get('/alerts', requireUserOrAdminKey('hr.alerts.read'), (req, res) => {
  const alerts = AL.currentAlerts();
  res.json({
    status: 'SUCCESS',
    summary: AL.summarise(alerts),
    alerts: alerts.map(a => ({
      type: a.type,
      key: a.key,
      value: a.value,
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      date: a.date,
      daysUntil: a.daysUntil,
      // Both are given: colour supplements the words, per spec 21, and is never
      // the only signal.
      severity: a.severity,
      title: a.title,
      detail: a.detail,
      overdue: a.daysUntil < 0,
    })),
  });
});

// POST /api/hr/alerts/dismiss - stops an alert showing, until its date changes.
router.post('/alerts/dismiss', requireUserOrAdminKey('hr.alerts.read'), (req, res) => {
  try {
    const r = AL.dismissAlert({
      alertKey: req.body?.key,
      value: req.body?.value,
      note: req.body?.note || null,
      actor: req.auth.actor,
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Performance reviews (ad-hoc)
// ---------------------------------------------------------------------------

router.get('/reviews/:employeeId',
  requireUserOrAdminKey('hr.reviews.manage'), requireEmployeeAccess(),
  (req, res) => {
    res.json({ status: 'SUCCESS', reviews: AL.reviewsFor(req.params.employeeId) });
  });

router.post('/reviews',
  requireUserOrAdminKey('hr.reviews.manage'), requireEmployeeAccess(),
  (req, res) => {
    try {
      const r = AL.scheduleReview({
        employeeId: req.body?.employeeId,
        reviewType: req.body?.reviewType,
        dueDate: req.body?.dueDate,
        reviewerUserId: req.body?.reviewerUserId || null,
        notes: req.body?.notes || null,
        actor: req.auth.actor,
      });
      res.status(201).json({ status: 'SUCCESS', review: r });
    } catch (err) {
      res.status(400).json({ status: 'ERROR', message: err.message });
    }
  });

router.post('/reviews/:id/complete', requireUserOrAdminKey('hr.reviews.manage'), (req, res) => {
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ status: 'ERROR', message: 'No such review.' });

  const rbac = require('../domain/rbac');
  if (!rbac.canAccessEmployee(req.auth, review.employee_id)) {
    return res.status(404).json({ status: 'ERROR', message: 'No such review.' });
  }

  try {
    const r = AL.recordReviewOutcome({
      reviewId: req.params.id,
      outcome: req.body?.outcome,
      notes: req.body?.notes,
      documentId: req.body?.documentId || null,
      actor: req.auth.actor,
    });
    res.json({ status: 'SUCCESS', ...r });
  } catch (err) {
    res.status(400).json({ status: 'ERROR', message: err.message });
  }
});

module.exports = router;
