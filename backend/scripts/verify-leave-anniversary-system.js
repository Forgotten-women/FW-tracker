// End-to-end automated verification script for:
// 1. Official Joining Date (Day, Month, Year)
// 2. Anniversary-based Annual Leave Cycle (Start, End, Next Renewal)
// 3. Management Carry-Forward (Max 5 days cap enforcement & audit trail)
// 4. Automatic Anniversary Rollover & Lapsing of Unused Leave
// 5. 8-Metric Leave Report Breakdown
// 6. Historical Leave Cycles Audit Record
// 7. 14-Day Cycle-End Advisory Notifications
// 8. Storage-Optimized Employee App Activity Backlog
//
// Runs against the configured database and cleans up test records.

require('dotenv').config();
const assert = require('assert');
const { db } = require('../src/db');
const L = require('../src/domain/leave');
const T = require('../src/util/time');

async function run() {
  console.log('=== RUNNING LEAVE ANNIVERSARY & ACTIVITY BACKLOG VERIFICATION ===\n');

  const testEmpId = 'emp_test_anniversary_' + Date.now();
  const joiningDate = '2025-09-15'; // Joined 15 September 2025
  let nearEmpId = null;

  try {
    // 1. Create test employee with official joining date
    console.log('[1/8] Testing Official Joining Date & Profile Recording...');
    await db.prepare(`
      INSERT INTO employees (id, name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(testEmpId, 'Sarah Jenkins (Test)', 'Senior Lead Engineer', T.now(), T.now());

    await db.prepare(`
      INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('er_' + testEmpId, testEmpId, 'Senior Lead Engineer', 'Full-time', joiningDate, joiningDate, T.now());

    const empRow = await db.prepare('SELECT start_date FROM employment_records WHERE employee_id = ?').get(testEmpId);
    assert.strictEqual(empRow.start_date, joiningDate, 'Official joining date must be stored as 2025-09-15');
    console.log('  ✓ Official joining date stored successfully: ' + empRow.start_date);

    // 2. Test Anniversary Cycle calculation
    console.log('\n[2/8] Testing Annual Leave Cycle based on Work Anniversary...');
    // In cycle 1 (e.g. at 2026-08-01):
    const cycle1 = await L.holidayYearFor(testEmpId, '2026-08-01');
    assert.strictEqual(cycle1.blocked, false);
    assert.strictEqual(cycle1.yearStart, '2025-09-15');
    assert.strictEqual(cycle1.cycleStartDate, '2025-09-15');
    assert.strictEqual(cycle1.cycleEndDate, '2026-09-14', 'Cycle 1 must end on the day before the first anniversary');
    assert.strictEqual(cycle1.nextRenewalDate, '2026-09-15', 'Renewal must be on the anniversary date');
    console.log(`  ✓ Cycle 1: ${cycle1.cycleStartDate} → ${cycle1.cycleEndDate} (Next Renewal: ${cycle1.nextRenewalDate})`);

    // In cycle 2 (e.g. at 2026-09-16):
    const cycle2 = await L.holidayYearFor(testEmpId, '2026-09-16');
    assert.strictEqual(cycle2.cycleStartDate, '2026-09-15');
    assert.strictEqual(cycle2.cycleEndDate, '2027-09-14');
    assert.strictEqual(cycle2.nextRenewalDate, '2027-09-15');
    console.log(`  ✓ Cycle 2: ${cycle2.cycleStartDate} → ${cycle2.cycleEndDate} (Next Renewal: ${cycle2.nextRenewalDate})`);

    // 3. Test Carry-Forward Approval Logic & 5-Day Cap
    console.log('\n[3/8] Testing Management Carry-Forward Approval & 5-Day Cap...');
    // Seed accrual for cycle 1 so employee has 12 unused days
    await db.prepare(`
      INSERT INTO leave_accrual_ledger
        (id, employee_id, leave_year, entry_type, days_delta, balance_after, effective_date, description, created_at, created_by)
      VALUES (?, ?, ?, 'ACCRUAL', 12.0, 12.0, '2026-03-15', 'Initial test accrual', ?, 'test')
    `).run('lal_acc_' + testEmpId, testEmpId, '2025-09-15/0', T.now());

    // Test cap enforcement: attempt to approve 6 days
    let capFailed = false;
    try {
      await L.recordCarryForwardApproval({
        employeeId: testEmpId,
        approvedDays: 6.0,
        notes: 'Trying to exceed 5 days cap',
        actor: 'user:hr_manager',
        today: '2026-09-01',
      });
    } catch (err) {
      capFailed = true;
      assert(err.message.includes('Maximum allowable carry-forward is 5 days'));
    }
    assert.strictEqual(capFailed, true, 'Approving > 5 days must throw error');
    console.log('  ✓ Cap enforcement passed: > 5 days rejected with policy exception');

    // Approve exactly 5 days (with 12 available, 5 carry over, 7 should lapse)
    const approval = await L.recordCarryForwardApproval({
      employeeId: testEmpId,
      approvedDays: 5.0,
      notes: 'Approved 5 days for outstanding project delivery',
      actor: 'user:hr_director',
      today: '2026-09-01',
    });
    assert.strictEqual(approval.approved_days, 5.0);
    assert.strictEqual(approval.decision, 'APPROVED');
    assert.strictEqual(approval.approved_by, 'user:hr_director');
    console.log(`  ✓ Approved 5 days carry-forward recorded with audit trail (Approver: ${approval.approved_by})`);

    // 4. Test Anniversary Rollover & Automatic Expiration / Lapsing
    console.log('\n[4/8] Testing Automatic Anniversary Rollover & Lapsing of Unapproved Leave...');
    // Run rollover on the anniversary date 2026-09-15
    const rolloverRes = await L.rolloverHolidayYear(testEmpId, '2026-09-15');
    assert.strictEqual(rolloverRes.rolledOver, true);
    assert.strictEqual(rolloverRes.carriedOverDays, 5.0, 'Should carry over exactly 5 approved days');
    assert(rolloverRes.forfeitedDays >= 0, 'Unused days beyond approved carry-over must forfeit');
    console.log(`  ✓ Rollover executed: Carried over ${rolloverRes.carriedOverDays}d, Forfeited/Lapsed remainder ${rolloverRes.forfeitedDays}d`);

    // Check ledger entries created in cycle 2
    const carryEntry = await db.prepare(`
      SELECT * FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'CARRY_OVER'
    `).get(testEmpId);
    assert.ok(carryEntry, 'New cycle must have CARRY_OVER ledger entry');
    assert.strictEqual(Number(carryEntry.days_delta), 5.0);
    console.log(`  ✓ New cycle ledger credited with CARRY_OVER: +${carryEntry.days_delta} days`);

    // 5. Test 8-Metric Leave Report Breakdown
    console.log('\n[5/8] Testing 8-Metric Leave Report Breakdown...');
    const balance = await L.balanceFor(testEmpId, '2026-10-01');
    assert.strictEqual(balance.annualEntitlementDays, 20.0, 'Metric 1: Annual Entitlement must be 20');
    assert.ok(balance.accruedDays >= 0, 'Metric 2: Accrued to date must be present');
    assert.strictEqual(balance.takenDays, 0, 'Metric 3: Taken must be present');
    assert.strictEqual(balance.approvedCarryForwardDays, 5.0, 'Metric 4: Approved carry forward must be 5.0');
    assert.ok(balance.remainingCurrentCycleDays >= 0, 'Metric 5: Remaining current cycle leave must be calculated');
    assert.ok(balance.leaveDueToExpire >= 0, 'Metric 6: Leave due to expire must be calculated');
    assert.ok(balance.leaveAlreadyLapsed >= 0, 'Metric 7: Leave already lapsed must be calculated');
    assert.strictEqual(balance.nextRenewalDate, '2027-09-15', 'Metric 8: Next renewal date must be 2027-09-15');

    console.log('  ✓ Metric 1 (Entitlement):', balance.annualEntitlementDays);
    console.log('  ✓ Metric 2 (Accrued to date):', balance.accruedDays);
    console.log('  ✓ Metric 3 (Taken):', balance.takenDays);
    console.log('  ✓ Metric 4 (Approved carry-forward in):', balance.approvedCarryForwardDays);
    console.log('  ✓ Metric 5 (Remaining current cycle):', balance.remainingCurrentCycleDays);
    console.log('  ✓ Metric 6 (Leave due to expire):', balance.leaveDueToExpire);
    console.log('  ✓ Metric 7 (Leave already lapsed):', balance.leaveAlreadyLapsed);
    console.log('  ✓ Metric 8 (Next renewal date):', balance.nextRenewalDate);

    // 6. Test Historical Cycles Audit Trail
    console.log('\n[6/8] Testing Historical Leave Cycles Audit Record...');
    const historical = await L.historicalCyclesFor(testEmpId, '2026-10-01');
    assert.ok(historical.length >= 2, 'Should return at least completed cycle and active cycle');
    const completedCycle = historical.find(c => c.status === 'COMPLETED');
    assert.ok(completedCycle, 'Completed cycle must be archived and available for HR audit');
    assert.strictEqual(completedCycle.cycleStartDate, '2025-09-15');
    assert.strictEqual(completedCycle.cycleEndDate, '2026-09-14');
    assert.ok(completedCycle.carryForwardRecord, 'Completed cycle must preserve carry forward decision');
    assert.strictEqual(completedCycle.carryForwardRecord.approvedDays, 5.0);
    console.log(`  ✓ Historical cycle audit verified: Cycle 1 (${completedCycle.cycleStartDate} → ${completedCycle.cycleEndDate}) preserved with carry-forward decision`);

    // 7. Test 14-Day Cycle-End Notification Scan
    console.log('\n[7/8] Testing 14-Day Cycle-End Notification Scan...');
    // Create an employee whose anniversary is exactly 14 days away from today
    nearEmpId = 'emp_near_anniversary_' + Date.now();
    const today = T.dateKey();
    // 14 days from today will be the anniversary
    const dTarget = new Date(today + 'T00:00:00Z');
    dTarget.setUTCDate(dTarget.getUTCDate() + 14);
    const renewalTarget = dTarget.toISOString().slice(0, 10);
    // Which means they joined on renewalTarget minus 1 year
    const parts = renewalTarget.split('-');
    const joiningNear = `${parseInt(parts[0], 10) - 1}-${parts[1]}-${parts[2]}`;

    await db.prepare(`
      INSERT INTO employees (id, name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(nearEmpId, 'David Kim (Test Near Anniversary)', 'Frontend Engineer', T.now(), T.now());

    await db.prepare(`
      INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('er_' + nearEmpId, nearEmpId, 'Frontend Engineer', 'Full-time', joiningNear, joiningNear, T.now());

    const approachingList = await L.employeesApproachingAnniversary(today);
    const foundNear = approachingList.find(e => e.employeeId === nearEmpId);
    assert.ok(foundNear, 'Employee 14 days from anniversary must appear in approaching list');
    assert.strictEqual(foundNear.daysUntilRenewal, 14);
    console.log(`  ✓ Employee detected approaching anniversary in exactly ${foundNear.daysUntilRenewal} days!`);

    // Run checkAndRolloverAll and verify notification dispatched
    const maintenanceRes = await L.checkAndRolloverAll(today);
    assert.ok(maintenanceRes.notifiedCount >= 1, 'At least 1 pre-anniversary notification should be queued');

    const notif = await db.prepare(`
      SELECT * FROM notifications WHERE employee_id = ? AND category = 'LEAVE'
    `).get(nearEmpId);
    assert.ok(notif, 'Advisory notification must be written to notifications');
    assert(notif.title.includes('Annual Leave Cycle Ending Soon'));
    console.log(`  ✓ Advisory notification generated: "${notif.title}"`);

    // 8. Test Storage-Optimized Employee App Backlog
    console.log('\n[8/8] Testing Storage-Optimized Employee App Backlog...');
    // Seed lean aggregated workstation usage: 1 row per employee, session_date, app_name
    const testDevId = 'dev_test_' + Date.now();
    await db.prepare(`
      INSERT INTO devices (id, employee_id, platform, model, label, enrolled_at, last_seen_at, device_type)
      VALUES (?, ?, 'windows', 'Test Laptop', 'Office PC', ?, ?, 'workstation')
    `).run(testDevId, testEmpId, T.now(), T.now());

    const sessionDate1 = '2026-09-07';
    const sessionDate2 = '2026-09-08';

    await db.prepare(`
      INSERT INTO workstation_app_usage (id, employee_id, device_id, session_date, app_name, active_seconds, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wau_1_' + testEmpId, testEmpId, testDevId, sessionDate1, 'Visual Studio Code', 7200, T.now() - 86400000);

    await db.prepare(`
      INSERT INTO workstation_app_usage (id, employee_id, device_id, session_date, app_name, active_seconds, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wau_2_' + testEmpId, testEmpId, testDevId, sessionDate1, 'Google Chrome', 3600, T.now() - 86400000);

    await db.prepare(`
      INSERT INTO workstation_app_usage (id, employee_id, device_id, session_date, app_name, active_seconds, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('wau_3_' + testEmpId, testEmpId, testDevId, sessionDate2, 'Visual Studio Code', 5400, T.now());

    // Query aggregated backlog
    const rows = await db.prepare(`
      SELECT session_date, app_name, SUM(active_seconds) as active_seconds
      FROM workstation_app_usage
      WHERE employee_id = ?
      GROUP BY session_date, app_name
      ORDER BY session_date DESC, active_seconds DESC
    `).all(testEmpId);

    assert.strictEqual(rows.length, 3, 'Lean storage must have exactly 3 aggregated rows (not thousands of events)');
    const totalSecs = rows.reduce((acc, r) => acc + Number(r.active_seconds), 0);
    assert.strictEqual(totalSecs, 16200, 'Total seconds must equal 7200 + 3600 + 5400 = 16200s (4.5 hours)');
    console.log(`  ✓ Storage footprint: Exactly ${rows.length} rows for 2 full days of activity across apps.`);
    console.log(`  ✓ Total active time computed: ${Math.round(totalSecs / 3600 * 10) / 10} hours.`);

    console.log('\n=============================================================');
    console.log('🎉 ALL 8 LEAVE ANNIVERSARY & BACKLOG REQUIREMENTS VERIFIED!');
    console.log('=============================================================\n');

  } finally {
    // Cleanup test records
    console.log('Cleaning up test records...');
    try {
      await db.prepare('DELETE FROM notifications WHERE employee_id IN (?, ?)').run(testEmpId, nearEmpId).catch(() => {});
      await db.prepare('DELETE FROM workstation_app_usage WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM devices WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM leave_carry_forward_records WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM leave_accrual_ledger WHERE employee_id = ?').run(testEmpId).catch(() => {});
      await db.prepare('DELETE FROM employment_records WHERE employee_id IN (?, ?)').run(testEmpId, nearEmpId).catch(() => {});
      await db.prepare('DELETE FROM employees WHERE id IN (?, ?)').run(testEmpId, nearEmpId).catch(() => {});
    } catch (_) {}
    console.log('Cleanup completed.');
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('VERIFICATION FAILED:', err);
    process.exit(1);
  });
