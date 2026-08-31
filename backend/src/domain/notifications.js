// Centralized Notifications Engine. Spec Section 22.
//
// Manages targeted notifications for both employees (mobile push & feed) and
// HR / Administrators (dashboard drawer, badges, and real-time SSE broadcasts).

const crypto = require('crypto');
const { db, audit } = require('../db');
const events = require('../events');
const T = require('../util/time');

/**
 * Creates a notification record and broadcasts it over SSE.
 *
 * @param {Object} opts
 * @param {string|null} opts.employeeId - If set, targets the employee.
 * @param {string|null} opts.userId - If set, targets a specific HR user; if both employeeId and userId are null, targets all HR users.
 * @param {string} opts.category - LEAVE | CORRECTION | ABSENCE | DOCUMENT | WARNING | HR_ALERT | ATTENDANCE
 * @param {string} opts.title - Short descriptive title.
 * @param {string} opts.body - Actionable details.
 * @param {string} [opts.severity='info'] - info | warning | urgent
 * @param {string|null} [opts.link=null] - Deep link or action identifier (e.g. '/leave', 'corr_123', 'doc_456').
 * @param {number} [opts.nowMs=T.now()] - Timestamp
 */
function notify({
  employeeId = null,
  userId = null,
  category,
  title,
  body,
  severity = 'info',
  link = null,
  nowMs = T.now(),
}) {
  const id = 'ntf_' + crypto.randomBytes(8).toString('hex');

  db.prepare(`
    INSERT INTO notifications (id, employee_id, user_id, category, title, body, severity, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, employeeId, userId, category, title, body, severity, link, nowMs);

  const payload = {
    id,
    employeeId,
    userId,
    category,
    title,
    body,
    severity,
    link,
    createdAt: nowMs,
    at: T.displayTime(nowMs),
    date: T.dateKey(nowMs),
    read: false,
    dismissed: false,
  };

  // Broadcast in real-time over SSE for live desktop dashboard reception
  try {
    events.broadcast('NOTIFICATION', payload);
  } catch (_) {}

  return payload;
}

/**
 * Lists notifications for an employee.
 */
function listForEmployee(employeeId, { includeDismissed = false, limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE employee_id = ? ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
    ORDER BY created_at DESC LIMIT ?
  `).all(employeeId, limit);

  const unreadCount = db.prepare(`
    SELECT COUNT(*) c FROM notifications
    WHERE employee_id = ? AND read_at IS NULL AND dismissed_at IS NULL
  `).get(employeeId).c;

  return {
    unreadCount,
    notifications: rows.map(present),
  };
}

/**
 * Lists notifications for HR / Admins.
 * If userId is provided, returns user-specific and broadcast HR notifications.
 */
function listForHr(userId = null, { includeDismissed = false, limit = 100 } = {}) {
  const rows = userId
    ? db.prepare(`
        SELECT * FROM notifications
        WHERE (user_id = ? OR (user_id IS NULL AND employee_id IS NULL))
        ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, limit)
    : db.prepare(`
        SELECT * FROM notifications
        WHERE employee_id IS NULL
        ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
        ORDER BY created_at DESC LIMIT ?
      `).all(limit);

  const unreadCount = userId
    ? db.prepare(`
        SELECT COUNT(*) c FROM notifications
        WHERE (user_id = ? OR (user_id IS NULL AND employee_id IS NULL))
          AND read_at IS NULL AND dismissed_at IS NULL
      `).get(userId).c
    : db.prepare(`
        SELECT COUNT(*) c FROM notifications
        WHERE employee_id IS NULL AND read_at IS NULL AND dismissed_at IS NULL
      `).get().c;

  return {
    unreadCount,
    notifications: rows.map(present),
  };
}

/**
 * Marks notifications as read.
 */
function markAsRead({ id = null, employeeId = null, userId = null, nowMs = T.now() } = {}) {
  if (id) {
    if (employeeId) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND employee_id = ? AND read_at IS NULL')
        .run(nowMs, id, employeeId);
    } else if (userId) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL) AND read_at IS NULL')
        .run(nowMs, id, userId);
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
        .run(nowMs, id);
    }
  } else {
    // Mark all unread as read
    if (employeeId) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE employee_id = ? AND read_at IS NULL')
        .run(nowMs, employeeId);
    } else if (userId) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL')
        .run(nowMs, userId);
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE employee_id IS NULL AND read_at IS NULL')
        .run(nowMs);
    }
  }
}

/**
 * Dismisses a notification (hides from feed).
 */
function dismiss({ id, employeeId = null, userId = null, nowMs = T.now() }) {
  if (employeeId) {
    db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND employee_id = ?')
      .run(nowMs, id, employeeId);
  } else if (userId) {
    db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)')
      .run(nowMs, id, userId);
  } else {
    db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ?')
      .run(nowMs, id);
  }
}

function present(n) {
  return {
    id: n.id,
    employeeId: n.employee_id,
    userId: n.user_id,
    category: n.category,
    title: n.title,
    body: n.body,
    severity: n.severity,
    link: n.link,
    at: T.displayTime(n.created_at),
    date: T.dateKey(n.created_at),
    createdAt: n.created_at,
    read: !!n.read_at,
    dismissed: !!n.dismissed_at,
  };
}

module.exports = {
  notify,
  listForEmployee,
  listForHr,
  markAsRead,
  dismiss,
  present,
};
