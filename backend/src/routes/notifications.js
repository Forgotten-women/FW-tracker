// Notifications feed. Spec section 22.

const express = require('express');
const router = express.Router();

const { requireDevice, requireUserOrAdminKey } = require('../middleware/auth');
const N = require('../domain/notifications');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Employee (device token) - own notifications
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, (req, res) => {
  const includeDismissed = req.query.all === 'true';
  const result = N.listForEmployee(req.auth.employeeId, { includeDismissed });
  res.json({
    status: 'SUCCESS',
    unread: result.unreadCount,
    unreadCount: result.unreadCount,
    notifications: result.notifications,
  });
});

router.post('/mine/read', requireDevice, (req, res) => {
  N.markAsRead({
    id: req.body?.id || null,
    employeeId: req.auth.employeeId,
  });
  res.json({ status: 'SUCCESS' });
});

router.post('/mine/:id/dismiss', requireDevice, (req, res) => {
  N.dismiss({
    id: req.params.id,
    employeeId: req.auth.employeeId,
  });
  res.json({ status: 'SUCCESS' });
});

// ---------------------------------------------------------------------------
// HR / admin user - shared and personal feed
// ---------------------------------------------------------------------------

router.get('/', requireUserOrAdminKey('report.read'), (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  const includeDismissed = req.query.all === 'true';
  const result = N.listForHr(userId, { includeDismissed });
  res.json({
    status: 'SUCCESS',
    unreadCount: result.unreadCount,
    notifications: result.notifications,
  });
});

router.post('/read', requireUserOrAdminKey('report.read'), (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  N.markAsRead({
    id: req.body?.id || null,
    userId,
  });
  res.json({ status: 'SUCCESS' });
});

router.post('/:id/dismiss', requireUserOrAdminKey('report.read'), (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  N.dismiss({
    id: req.params.id,
    userId,
  });
  res.json({ status: 'SUCCESS' });
});

module.exports = router;
