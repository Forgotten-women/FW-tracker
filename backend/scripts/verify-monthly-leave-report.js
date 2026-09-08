// Verification script for Monthly Leave Entitlement Update/Report
// Tests:
// 1. Total annual leave entitlement
// 2. Leave already taken
// 3. Paid leave used (cycle + month)
// 4. Unpaid leave taken (cycle + month)
// 5. Remaining leave balance
// 6. Leave accrued/earned up to that month
// 7. How much paid leave employee is currently entitled to take
// 8. Whether employee has sufficient accrued entitlement for requested leave
// 9. Any leave adjustments made during that month
// 10. Plain-English statement synthesis

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { db } = require('../src/db');
const L = require('../src/domain/leave');
const T = require('../src/util/time');

async function run() {
  console.log('=== VERIFYING MONTHLY LEAVE ENTITLEMENT UPDATE & REPORT ===\n');

  const testEmpId = 'emp_test_monthly_' + Date.now();
  const joiningDate = '2025-09-15';
  const today = T.dateKey(); // e.g. "2026-09-08"
  const currentMonth = today.slice(0, 7); // "2026-09"

  try {
    // 1. Setup test employee & employment record
    console.log('[1/5] Creating test employee and official joining date...');
    await db.prepare(`
      INSERT INTO employees (id, name, role, active, created_at, updated_at)
      VALUES (?, ?, 'Software Engineer', 1, ?, ?)
    `).run(testEmpId, 'Emma Watson (Test)', T.now(), T.now());

    await db.prepare(`
      INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?, ?, 'Software Engineer', 'Full-time', ?, ?, ?)
    `).run('er_' + testEmpId, testEmpId, joiningDate, joiningDate, T.now());

    // 2. Seed accrual: 10 days accrued in cycle 0
    console.log('[2/5] Seeding accrual ledger & monthly adjustment...');
    const leaveYear = '2025-09-15/0';
    await db.prepare(`
      INSERT INTO leave_accrual_ledger
        (id, employee_id, leave_year, entry_type, days_delta, balance_after, effective_date, description, created_at, created_by)
      VALUES (?, ?, ?, 'ACCRUAL', 10.0, 10.0, '2026-03-15', 'Accrual for 6 months', ?, 'system')
    `).run('lal_acc_' + testEmpId, testEmpId, leaveYear, T.now());

    // Seed an adjustment made specifically during the current month (e.g. today's date)
    await db.prepare(`
      INSERT INTO leave_accrual_ledger
        (id, employee_id, leave_year, entry_type, days_delta, balance_after, effective_date, description, created_at, created_by)
      VALUES (?, ?, ?, 'ADJUSTMENT', 1.5, 11.5, ?, 'Overtime compensation adjustment', ?, 'user:hr_manager')
    `).run('lal_adj_' + testEmpId, testEmpId, leaveYear, today, T.now());

    // 3. Seed leave requests:
    // a) Approved paid annual leave: 2 days in the past (taken)
    console.log('[3/5] Seeding paid annual leave and unpaid leave requests...');
    const req1Id = 'lr_paid_' + testEmpId;
    await db.prepare(`
      INSERT INTO leave_requests
        (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, decided_at, created_at)
      VALUES (?, ?, 'annual', '2026-09-01', '2026-09-02', 'FULL_DAY', 2.0, 'Family trip', 'APPROVED', ?, ?, ?)
    `).run(req1Id, testEmpId, T.now() - 864000000, T.now() - 800000000, T.now() - 864000000);

    // b) Approved unpaid leave: 1 day in the past (taken)
    const req2Id = 'lr_unpaid_' + testEmpId;
    await db.prepare(`
      INSERT INTO leave_requests
        (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, decided_at, created_at)
      VALUES (?, ?, 'unpaid', '2026-09-04', '2026-09-04', 'FULL_DAY', 1.0, 'Personal errand', 'APPROVED', ?, ?, ?)
    `).run(req2Id, testEmpId, T.now() - 500000000, T.now() - 400000000, T.now() - 500000000);

    // c) Pending annual leave request for sufficiency testing: 3 days requested
    const req3Id = 'lr_pending_' + testEmpId;
    await db.prepare(`
      INSERT INTO leave_requests
        (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, created_at)
      VALUES (?, ?, 'annual', '2026-09-20', '2026-09-22', 'FULL_DAY', 3.0, 'Autumn break', 'PENDING_HR', ?, ?)
    `).run(req3Id, testEmpId, T.now(), T.now());

    // 4. Generate Monthly Report
    console.log('[4/5] Generating and validating Monthly Leave Report...');
    const report = await L.monthlyReportFor(testEmpId, { monthKey: currentMonth, asOfDate: today });

    assert.strictEqual(report.blocked, false);
    assert.strictEqual(report.annualEntitlementDays, 20.0, 'Metric 1: Annual entitlement must be 20');
    assert.strictEqual(report.leaveAlreadyTaken, 2.0, 'Metric 2: Annual leave already taken must be 2.0');
    assert.strictEqual(report.paidLeaveUsed.cycleTotal, 2.0, 'Metric 3: Cycle paid leave used must be 2.0');
    assert.strictEqual(report.paidLeaveUsed.thisMonth, 2.0, 'Metric 3: Month paid leave used must be 2.0');
    assert.strictEqual(report.unpaidLeaveTaken.cycleTotal, 1.0, 'Metric 4: Cycle unpaid leave taken must be 1.0');
    assert.strictEqual(report.unpaidLeaveTaken.thisMonth, 1.0, 'Metric 4: Month unpaid leave taken must be 1.0');

    // Remaining annual = 20 + 1.5 (adj) - 2.0 (taken) = 19.5 days
    assert.strictEqual(report.remainingAnnualLeave, 19.5, 'Metric 5: Remaining annual leave must be 19.5');
    // Accrued up to month (11 months served): 18.33 days
    assert.strictEqual(report.accruedUpToMonth, 18.33, 'Metric 6: Accrued up to month must be 18.33');
    // Currently entitled paid leave = 18.33 + 1.5 (adj) - 2.0 (taken) = 17.83 days
    assert.strictEqual(report.currentlyEntitledPaidLeave, 17.83, 'Metric 7: Currently entitled paid leave must be 17.83');

    // Metric 8: Sufficiency for requested leave (3 days requested vs 17.83 available)
    assert.strictEqual(report.requestedLeaveSufficiency.hasRequestedLeave, true);
    assert.strictEqual(report.requestedLeaveSufficiency.status, 'SUFFICIENT');
    assert.strictEqual(report.requestedLeaveSufficiency.pendingDays, 3.0);
    assert.strictEqual(report.requestedLeaveSufficiency.shortfallDays, 0);
    console.log('  ✓ Requested leave sufficiency passed: 3 days requested <= 17.83 days accrued');

    // Metric 9: Month adjustments
    assert.strictEqual(report.monthAdjustments.count, 1);
    assert.strictEqual(report.monthAdjustments.totalDays, 1.5);
    assert.strictEqual(report.monthAdjustments.items[0].description, 'Overtime compensation adjustment');
    console.log('  ✓ Month adjustments verified: +1.5 days recorded in this month');

    // Plain-English Explanation
    assert.ok(
      report.summaryExplanation.includes('You have 19.5 days remaining annually, but only 17.83 days have accrued and are currently available to take.'),
      'Must generate plain-English explanation: ' + report.summaryExplanation
    );
    console.log('  ✓ Plain-English synthesized statement: "' + report.summaryExplanation + '"');

    // 5. Test Shortfall / Overdraft case
    console.log('\n[5/5] Testing Overdraft / Insufficient Accrual Case...');
    // Add another large pending request of 20 days (total pending = 23 days > 17.83 available)
    const reqOverdraftId = 'lr_overdraft_' + testEmpId;
    await db.prepare(`
      INSERT INTO leave_requests
        (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, reason, status, submitted_at, created_at)
      VALUES (?, ?, 'annual', '2026-10-01', '2026-10-28', 'FULL_DAY', 20.0, 'Big winter holiday', 'PENDING_HR', ?, ?)
    `).run(reqOverdraftId, testEmpId, T.now(), T.now());

    const reportOverdraft = await L.monthlyReportFor(testEmpId, { monthKey: currentMonth, asOfDate: today });
    assert.strictEqual(reportOverdraft.requestedLeaveSufficiency.status, 'INSUFFICIENT');
    assert.strictEqual(reportOverdraft.requestedLeaveSufficiency.pendingDays, 23.0);
    assert.strictEqual(reportOverdraft.requestedLeaveSufficiency.shortfallDays, 5.17); // 23 - 17.83 = 5.17 days shortfall
    assert(reportOverdraft.requestedLeaveSufficiency.message.includes('exceeds your currently accrued leave'));
    console.log('  ✓ Overdraft detection passed: Shortfall of 5.17 days flagged for HR approval');

    console.log('\n=============================================================');
    console.log('🎉 ALL MONTHLY LEAVE REPORT REQUIREMENTS VERIFIED & PASSED!');
    console.log('=============================================================\n');

  } finally {
    console.log('Cleaning up test records...');
    try {
      await db.prepare('DELETE FROM leave_requests WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM leave_accrual_ledger WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM employment_records WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM employees WHERE id = ?').run(testEmpId).catch(() => {});
    } catch (_) {}
    console.log('Cleanup completed.');
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('VERIFICATION FAILED:', err);
    process.exit(1);
  });
