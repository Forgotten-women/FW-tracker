// Notifications feed. Spec section 22.
//
// The notifications table is already written to by the warning, leave and alert
// engines. This is the read/dismiss surface for it, on both sides: an employee
// reads their own via the device token, an HR user reads theirs via a session
// or the admin key.

const express = require('express');
const router = express.Router();

const { db } = require('../db');
const { requireDevice, requireUserOrAdminKey } = require('../middleware/auth');
const T = require('../util/time');

function present(rows) {
  return rows.map(n => ({
    id: n.id,
    category: n.category,
    title: n.title,
    body: n.body,
    severity: n.severity,
    link: n.link,
    at: T.displayTime(n.created_at),
    date: T.dateKey(n.created_at),
    read: !!n.read_at,
    dismissed: !!n.dismissed_at,
  }));
}

// ---------------------------------------------------------------------------
// Employee (device token) - own notifications
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, (req, res) => {
  const includeDismissed = req.query.all === 'true';
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE employee_id = ? ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
    ORDER BY created_at DESC LIMIT 100
  `).all(req.auth.employeeId);
  const unread = db.prepare(
    'SELECT COUNT(*) c FROM notifications WHERE employee_id = ? AND read_at IS NULL AND dismissed_at IS NULL'
  ).get(req.auth.employeeId).c;
  res.json({ status: 'SUCCESS', unread, notifications: present(rows) });
});

router.post('/mine/read', requireDevice, (req, res) => {
  // Marks all as read, or a specific one if an id is given.
  const nowMs = T.now();
  if (req.body?.id) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND employee_id = ? AND read_at IS NULL')
      .run(nowMs, req.body.id, req.auth.employeeId);
  } else {
    db.prepare('UPDATE notifications SET read_at = ? WHERE employee_id = ? AND read_at IS NULL')
      .run(nowMs, req.auth.employeeId);
  }
  res.json({ status: 'SUCCESS' });
});

router.post('/mine/:id/dismiss', requireDevice, (req, res) => {
  db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND employee_id = ?')
    .run(T.now(), req.params.id, req.auth.employeeId);
  res.json({ status: 'SUCCESS' });
});

// ---------------------------------------------------------------------------
// HR / admin user - own notifications
// ---------------------------------------------------------------------------

router.get('/', requireUserOrAdminKey('report.read'), (req, res) => {
  // The admin key has no user row, so it sees the shared HR-facing feed
  // (user_id-addressed notifications). A real user sees their own.
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  const rows = userId
    ? db.prepare(`
        SELECT * FROM notifications
        WHERE user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 100
      `).all(userId)
    : db.prepare(`
        SELECT * FROM notifications
        WHERE user_id IS NOT NULL AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 100
      `).all();
  res.json({ status: 'SUCCESS', notifications: present(rows) });
});

router.post('/:id/dismiss', requireUserOrAdminKey('report.read'), (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  if (userId) {
    db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND user_id = ?')
      .run(T.now(), req.params.id, userId);
  } else {
    db.prepare('UPDATE notifications SET dismissed_at = ? WHERE id = ? AND user_id IS NOT NULL')
      .run(T.now(), req.params.id);
  }
  res.json({ status: 'SUCCESS' });
});

module.exports = router;
