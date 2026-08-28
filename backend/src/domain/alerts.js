// Advanced HR alerts and performance reviews. Spec sections 5, 20.2, 22 and
// Phase 8.
//
// An alert is DERIVED, not stored: it exists because a date is within its lead
// time and does not exist once the date has been changed or the thing dealt
// with. So this module computes alerts on demand rather than keeping an alert
// table that could drift out of step with the dates behind it.
//
// Lead times confirmed 2026-08-27 from spec section 20.2: contract expiry 30
// days, probation review 7 days, document expiry 30 days. All configurable per
// spec section 30. Alerts are visible to HR and Super Admin only.

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const { config } = require('../config');
const T = require('../util/time');

const A = config.alerts;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deriving alerts
// ---------------------------------------------------------------------------

function daysUntil(dateKey, today = T.dateKey()) {
  return Math.round((T.startOfDay(dateKey) - T.startOfDay(today)) / DAY_MS);
}

/** Overdue is more urgent than merely approaching. */
function severityFor(days) {
  if (days < 0) return 'overdue';
  if (days <= 3) return 'urgent';
  return 'warning';
}

const selectCurrentEmployment = db.prepare(`
  SELECT er.*, e.name AS employee_name, e.active
  FROM employment_records er
  JOIN employees e ON e.id = er.employee_id
  WHERE er.effective_to IS NULL AND e.active = 1
`);

const selectExpiringDocuments = db.prepare(`
  SELECT d.*, e.name AS employee_name, dt.name AS type_name, dt.confidentiality
  FROM employee_documents d
  JOIN employees e ON e.id = d.employee_id
  JOIN document_types dt ON dt.id = d.document_type_id
  WHERE d.expiry_date IS NOT NULL AND d.archived_at IS NULL AND e.active = 1
`);

const selectDueReviews = db.prepare(`
  SELECT r.*, e.name AS employee_name
  FROM performance_reviews r
  JOIN employees e ON e.id = r.employee_id
  WHERE r.status IN ('SCHEDULED', 'IN_PROGRESS') AND e.active = 1
`);

const selectDismissals = db.prepare('SELECT alert_key, dismissed_value FROM alert_dismissals');

/**
 * Every current HR alert.
 *
 * Each alert carries a stable `key` so it can be dismissed, and the `value` the
 * alert is about (the date), so a dismissal is only honoured while that value
 * is unchanged - moving a contract end date brings its alert back.
 */
function currentAlerts(today = T.dateKey()) {
  const alerts = [];

  const push = (a) => {
    a.daysUntil = daysUntil(a.date, today);
    a.severity = severityFor(a.daysUntil);
    alerts.push(a);
  };

  for (const er of selectCurrentEmployment.all()) {
    if (er.contract_end_date) {
      const d = daysUntil(er.contract_end_date, today);
      if (d <= A.contractExpiryDays) {
        push({
          type: 'CONTRACT_EXPIRY',
          key: `contract:${er.id}`,
          value: er.contract_end_date,
          employeeId: er.employee_id,
          employeeName: er.employee_name,
          date: er.contract_end_date,
          title: 'Contract expiring',
          detail: `Contract ends ${er.contract_end_date}`,
        });
      }
    }

    // A probation review only alerts while probation is genuinely open - once
    // an outcome is recorded the date is history, not a task.
    if (er.probation_review_date && !er.probation_outcome) {
      const d = daysUntil(er.probation_review_date, today);
      if (d <= A.probationReviewDays) {
        push({
          type: 'PROBATION_REVIEW',
          key: `probation:${er.id}`,
          value: er.probation_review_date,
          employeeId: er.employee_id,
          employeeName: er.employee_name,
          date: er.probation_review_date,
          title: 'Probation review due',
          detail: `Probation review due ${er.probation_review_date}`,
        });
      }
    }
  }

  for (const doc of selectExpiringDocuments.all()) {
    const d = daysUntil(doc.expiry_date, today);
    if (d <= A.documentExpiryDays) {
      push({
        type: 'DOCUMENT_EXPIRY',
        key: `document:${doc.id}`,
        value: doc.expiry_date,
        employeeId: doc.employee_id,
        employeeName: doc.employee_name,
        date: doc.expiry_date,
        title: `${doc.type_name} expiring`,
        detail: `${doc.title} expires ${doc.expiry_date}`,
        confidentiality: doc.confidentiality,
      });
    }
  }

  for (const r of selectDueReviews.all()) {
    const d = daysUntil(r.due_date, today);
    if (d <= A.performanceReviewDays) {
      push({
        type: 'PERFORMANCE_REVIEW',
        key: `review:${r.id}`,
        value: r.due_date,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        date: r.due_date,
        title: 'Performance review due',
        detail: `${r.review_type} review due ${r.due_date}`,
      });
    }
  }

  // Apply dismissals, but only while the value is unchanged.
  const dismissed = new Map(selectDismissals.all().map(x => [x.alert_key, x.dismissed_value]));
  const live = alerts.filter(a => dismissed.get(a.key) !== a.value);

  // Most urgent first: overdue, then soonest.
  live.sort((x, y) => x.daysUntil - y.daysUntil);
  return live;
}

function summarise(alerts) {
  const by = (t) => alerts.filter(a => a.type === t).length;
  return {
    total: alerts.length,
    overdue: alerts.filter(a => a.severity === 'overdue').length,
    contractExpiry: by('CONTRACT_EXPIRY'),
    probationReview: by('PROBATION_REVIEW'),
    documentExpiry: by('DOCUMENT_EXPIRY'),
    performanceReview: by('PERFORMANCE_REVIEW'),
  };
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

function dismissAlert({ alertKey, value, actor, note = null }) {
  if (!alertKey || !value) throw new Error('An alert key and its current value are required.');
  db.prepare(`
    INSERT INTO alert_dismissals (alert_key, dismissed_value, dismissed_by, dismissed_at, note)
    VALUES (?,?,?,?,?)
    ON CONFLICT(alert_key) DO UPDATE SET
      dismissed_value = excluded.dismissed_value,
      dismissed_by = excluded.dismissed_by,
      dismissed_at = excluded.dismissed_at,
      note = excluded.note
  `).run(alertKey, String(value), actor, T.now(), note);

  audit({
    actor, action: 'HR_ALERT_DISMISSED',
    targetType: 'alert', targetId: alertKey,
    after: { value }, note,
  });
  return { dismissed: true };
}

// ---------------------------------------------------------------------------
// Daily notification sweep (spec 22)
// ---------------------------------------------------------------------------

const selectHrUsers = db.prepare(`
  SELECT DISTINCT u.id FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  WHERE u.active = 1 AND ur.role_id IN ('hr', 'super_admin')
`);

const selectSent = db.prepare('SELECT sent_value FROM alert_notifications_sent WHERE alert_key = ?');
const recordSent = db.prepare(`
  INSERT INTO alert_notifications_sent (alert_key, sent_value, sent_at)
  VALUES (?,?,?)
  ON CONFLICT(alert_key) DO UPDATE SET sent_value = excluded.sent_value, sent_at = excluded.sent_at
`);

/**
 * Notifies HR of alerts not yet notified.
 *
 * Keyed on (alert, value), so an alert is notified once - and again only if its
 * date changes. Without that the daily scan would re-notify the same expiring
 * contract every morning for a month.
 */
function notifyHr(today = T.dateKey(), nowMs = T.now()) {
  const alerts = currentAlerts(today);
  const hrUsers = selectHrUsers.all().map(u => u.id);
  if (hrUsers.length === 0) return { notified: 0, reason: 'no HR users to notify' };

  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, user_id, category, title, body, severity, link, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);

  let notified = 0;
  const run = tx(() => {
    for (const a of alerts) {
      const already = selectSent.get(a.key);
      if (already && already.sent_value === a.value) continue;

      for (const userId of hrUsers) {
        insertNotification.run(
          'ntf_' + crypto.randomBytes(8).toString('hex'),
          userId, 'HR_ALERT', a.title,
          `${a.employeeName}: ${a.detail}`,
          a.severity === 'overdue' ? 'urgent' : 'warning',
          null, nowMs,
        );
      }
      recordSent.run(a.key, a.value, nowMs);
      notified++;
    }
  });
  run();

  return { notified };
}

// ---------------------------------------------------------------------------
// Performance reviews (ad-hoc, confirmed 2026-08-27)
// ---------------------------------------------------------------------------

function scheduleReview({ employeeId, reviewType = 'GENERAL', dueDate, reviewerUserId = null, notes = null, actor }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ''))) {
    throw new Error('dueDate must be YYYY-MM-DD.');
  }
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) {
    throw new Error('No such employee.');
  }
  const valid = ['GENERAL', 'PROBATION', 'ANNUAL', 'PIP'];
  if (!valid.includes(reviewType)) throw new Error(`reviewType must be one of ${valid.join(', ')}.`);

  const id = 'rev_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO performance_reviews
      (id, employee_id, review_type, due_date, status, reviewer_user_id, notes, created_at, created_by)
    VALUES (?,?,?,?, 'SCHEDULED', ?,?,?,?)
  `).run(id, employeeId, reviewType, dueDate, reviewerUserId, notes, T.now(), actor);

  audit({
    actor, action: 'REVIEW_SCHEDULED',
    targetType: 'employee', targetId: employeeId,
    after: { reviewId: id, reviewType, dueDate },
  });
  return { id, dueDate, status: 'SCHEDULED' };
}

function recordReviewOutcome({ reviewId, outcome, notes, documentId = null, actor }) {
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(reviewId);
  if (!review) throw new Error('No such review.');
  if (review.status === 'COMPLETED') throw new Error('This review is already completed.');
  if (!outcome || !String(outcome).trim()) throw new Error('An outcome is required.');

  const nowMs = T.now();
  db.prepare(`
    UPDATE performance_reviews
    SET status = 'COMPLETED', outcome = ?, notes = ?, document_id = ?, completed_at = ?
    WHERE id = ?
  `).run(String(outcome).trim(), notes || null, documentId, nowMs, reviewId);

  audit({
    actor, action: 'REVIEW_COMPLETED',
    targetType: 'employee', targetId: review.employee_id,
    after: { reviewId, outcome }, note: notes,
  });
  return { reviewId, status: 'COMPLETED' };
}

function reviewsFor(employeeId) {
  return db.prepare(
    'SELECT * FROM performance_reviews WHERE employee_id = ? ORDER BY due_date DESC'
  ).all(employeeId).map(r => ({
    id: r.id,
    type: r.review_type,
    dueDate: r.due_date,
    status: r.status,
    outcome: r.outcome,
    notes: r.notes,
    completedAt: r.completed_at ? T.displayTime(r.completed_at) : null,
  }));
}

module.exports = {
  currentAlerts, summarise, dismissAlert, notifyHr, daysUntil, severityFor,
  scheduleReview, recordReviewOutcome, reviewsFor,
};
