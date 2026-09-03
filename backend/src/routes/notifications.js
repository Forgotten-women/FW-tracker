// Notifications feed. Spec section 22.

const express = require('express');
const router = express.Router();

const { requireDevice, requireUserOrAdminKey } = require('../middleware/auth');
const N = require('../domain/notifications');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Employee (device token) - own notifications
// ---------------------------------------------------------------------------

router.get('/mine', requireDevice, async (req, res) => {
  const includeDismissed = req.query.all === 'true';
  const result = await N.listForEmployee(req.auth.employeeId, { includeDismissed });
  res.json({
    status: 'SUCCESS',
    unread: result.unreadCount,
    unreadCount: result.unreadCount,
    notifications: result.notifications,
  });
});

router.post('/mine/read', requireDevice, async (req, res) => {
  await N.markAsRead({
    id: req.body?.id || null,
    employeeId: req.auth.employeeId,
  });
  res.json({ status: 'SUCCESS' });
});

router.post('/mine/:id/dismiss', requireDevice, async (req, res) => {
  await N.dismiss({
    id: req.params.id,
    employeeId: req.auth.employeeId,
  });
  res.json({ status: 'SUCCESS' });
});

// ---------------------------------------------------------------------------
// HR / admin user - shared and personal feed
// ---------------------------------------------------------------------------

router.get('/', requireUserOrAdminKey('report.read'), async (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  const includeDismissed = req.query.all === 'true';
  const result = await N.listForHr(userId, { includeDismissed });
  res.json({
    status: 'SUCCESS',
    unreadCount: result.unreadCount,
    notifications: result.notifications,
  });
});

router.post('/read', requireUserOrAdminKey('report.read'), async (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  await N.markAsRead({
    id: req.body?.id || null,
    userId,
  });
  res.json({ status: 'SUCCESS' });
});

router.post('/:id/dismiss', requireUserOrAdminKey('report.read'), async (req, res) => {
  const userId = req.auth.kind === 'user' ? req.auth.id : null;
  await N.dismiss({
    id: req.params.id,
    userId,
  });
  res.json({ status: 'SUCCESS' });
});

module.exports = router;
