const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('notifications');


const { db } = require('../src/db');
const N = require('../src/domain/notifications');
const T = require('../src/util/time');

test.before(prepareDatabase);

test.after(dropDatabase);

async function makeEmployee(id, name = 'Test Person') {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, name, 'Engineering', T.now(), T.now());
  return id;
}

test('Notifications lifecycle (Spec 22)', async (t) => {
  const empId = await makeEmployee('emp_notify_test', 'Notify Tester');

  await t.test('creates notification and lists for employee', async () => {
    const payload = await N.notify({
      employeeId: empId,
      category: 'LEAVE',
      title: 'Leave Approved',
      body: 'Your 2 days have been approved.',
      severity: 'info',
      link: '/leave',
    });

    assert.ok(payload.id.startsWith('ntf_'));
    const list = await N.listForEmployee(empId);
    assert.equal(list.unreadCount, 1);
    assert.equal(list.notifications.length, 1);
    assert.equal(list.notifications[0].title, 'Leave Approved');
    assert.equal(list.notifications[0].read, false);

    // Mark as read
    await N.markAsRead({ id: payload.id, employeeId: empId });
    const afterRead = await N.listForEmployee(empId);
    assert.equal(afterRead.unreadCount, 0);
    assert.equal(afterRead.notifications[0].read, true);

    // Dismiss
    await N.dismiss({ id: payload.id, employeeId: empId });
    const afterDismiss = await N.listForEmployee(empId);
    assert.equal(afterDismiss.notifications.length, 0);

    const withDismissed = await N.listForEmployee(empId, { includeDismissed: true });
    assert.equal(withDismissed.notifications.length, 1);
    assert.equal(withDismissed.notifications[0].dismissed, true);
  });

  await t.test('creates HR notification and lists for HR/Admin feed', async () => {
    const payload = await N.notify({
      category: 'CORRECTION',
      title: 'New Dispute: John Doe',
      body: 'Correction submitted for 2026-08-31',
      severity: 'warning',
      link: '/attendance',
    });

    const hrList = await N.listForHr();
    const item = hrList.notifications.find(n => n.id === payload.id);
    assert.ok(item, 'Item must be in HR feed');
    assert.equal(item.category, 'CORRECTION');
    assert.equal(item.read, false);

    await N.markAsRead({ id: payload.id });
    const afterRead = await N.listForHr();
    const itemAfter = afterRead.notifications.find(n => n.id === payload.id);
    assert.equal(itemAfter.read, true);
  });
});
