// Unauthorised Absence & Sickness Self-Reporting Tests (Spec Sections 10 & 2.2)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('absences');


const { db } = require('../src/db');
const W = require('../src/domain/warnings');
const T = require('../src/util/time');

test.before(prepareDatabase);

async function createTestEmployee(id, name) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, name, 'Engineering', T.now(), T.now());
  return id;
}

test.after(dropDatabase);

test('scanDailyAbsences flags scheduled employee with no attendance and no leave', async () => {
  const empId = await createTestEmployee('emp_noshow_1', 'No Show Worker');
  const dateKey = '2026-09-01'; // Tuesday (Working Day)

  const scan = await W.scanDailyAbsences(dateKey);
  assert.ok(scan.scannedCount > 0);
  const found = scan.detected.find(d => d.employeeId === empId);
  assert.ok(found, 'Employee with no clock-in should be flagged as suspected absence');

  const rows = await W.listAbsences({ status: 'PENDING_REVIEW', from: dateKey, to: dateKey });
  const row = rows.find(r => r.employeeId === empId);
  assert.ok(row);
  assert.strictEqual(row.absenceType, 'SUSPECTED_NO_SHOW');
  assert.strictEqual(row.status, 'PENDING_REVIEW');
});

test('scanDailyAbsences ignores employees with approved leave', async () => {
  const empId = await createTestEmployee('emp_leave_1', 'Leave Worker');
  const dateKey = '2026-09-01';

  // Insert approved leave
  await db.prepare(`
    INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, total_days, status, submitted_at, created_at)
    VALUES ('lr_test_1', ?, 'annual', ?, ?, 1.0, 'APPROVED', ?, ?)
  `).run(empId, dateKey, dateKey, T.now(), T.now());

  const scan = await W.scanDailyAbsences(dateKey);
  const found = scan.detected.find(d => d.employeeId === empId);
  assert.strictEqual(found, undefined, 'Employee on approved leave should not be flagged');
});

test('employee self-reporting sickness records pending absence', async () => {
  const empId = await createTestEmployee('emp_sick_1', 'Sick Worker');
  const dateKey = '2026-09-02';

  const report = await W.selfReportAbsence({
    employeeId: empId,
    dateKey,
    absenceType: 'SICK',
    reason: 'Sudden fever and flu symptoms',
  });

  assert.strictEqual(report.status, 'PENDING_REVIEW');
  assert.strictEqual(report.absenceType, 'SICK');

  const rows = await W.listAbsences({ employeeId: empId });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].reason, 'Sudden fever and flu symptoms');
});

test('HR reviews absence and chooses the 3 independent policy switches', async () => {
  const empId = await createTestEmployee('emp_review_1', 'Absence Review Worker');
  const dateKey = '2026-09-03';

  const sus = await W.recordSuspectedAbsence({ employeeId: empId, dateKey });
  assert.ok(sus.id);

  const review = await W.reviewAbsence({
    absenceId: sus.id,
    status: 'CONFIRMED',
    deductAnnualLeave: true,
    treatAsUnpaid: true,
    createWarningTrigger: false,
    notes: 'Unexcused no-show confirmed by manager.',
    actor: 'hr:admin_1',
  });

  assert.strictEqual(review.status, 'CONFIRMED');
  assert.strictEqual(review.proposedConsequences.deductAnnualLeave, true);
  assert.strictEqual(review.proposedConsequences.treatAsUnpaid, true);
  assert.strictEqual(review.proposedConsequences.createWarningTrigger, false);

  const updated = await (await W.listAbsences({ employeeId: empId })).find(r => r.id === sus.id);
  assert.strictEqual(updated.status, 'CONFIRMED');
  assert.strictEqual(updated.deductAnnualLeave, true);
  assert.strictEqual(updated.treatAsUnpaid, true);
  assert.strictEqual(updated.createWarningTrigger, false);
});
