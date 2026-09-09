// verify-bank-holidays.js
//
// Automated integration test for 5 Designated Bank Holidays / Public Holidays System:
//   1. Bank holidays retrieval and 5-holiday count per year
//   2. HR configuration: Updating holiday dates/names for a year
//   3. Leave booking across a bank holiday: Verifying that booking spanning a bank holiday
//      does NOT count the holiday as annual leave and does NOT reduce paid leave entitlement
//   4. Absence calculation exclusion: Verifying that absence scans on a bank holiday
//      exclude employees and do not trigger unauthorized absences
//   5. Monthly required working hours: Verifying that monthly working hours correctly
//      account for paid bank holidays (reducing required hours target)
//   6. Calendar inclusion: Verifying that bank holidays appear in calendar range queries

require('dotenv').config();
const { db } = require('../src/db');
const holidays = require('../src/domain/holidays');
const schedule = require('../src/domain/schedule');
const leave = require('../src/domain/leave');
const warnings = require('../src/domain/warnings');
const attendance = require('../src/domain/attendance');
const crypto = require('crypto');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  console.log('=== VERIFYING DESIGNATED BANK HOLIDAYS SYSTEM ===\n');

  // ---------------------------------------------------------------------------
  // 1. Bank holidays retrieval
  // ---------------------------------------------------------------------------
  console.log('[1/6] Testing Bank Holidays Retrieval & 5-Designated Count...');
  const h2026 = await holidays.listBankHolidays(2026);
  assert(h2026.length === 5, `2026 has exactly 5 designated bank holidays (found: ${h2026.length})`);

  const newYears = h2026.find(h => h.date === '2026-01-01');
  assert(newYears != null, "Found '2026-01-01' New Year's Day in 2026 calendar");
  assert(newYears.name === "New Year's Day", `Holiday name is "${newYears.name}"`);

  // ---------------------------------------------------------------------------
  // 2. HR Configuration: Updating holidays for a year
  // ---------------------------------------------------------------------------
  console.log('\n[2/6] Testing HR Configuration of 5 Designated Bank Holidays...');
  const testYear = 2099;
  const initialHolidays = [
    { date: '2099-01-01', name: "New Year's Day", notes: 'Approved 2099 Holiday 1' },
    { date: '2099-03-25', name: 'Spring Holiday', notes: 'Approved 2099 Holiday 2' },
    { date: '2099-05-25', name: 'Early Summer Holiday', notes: 'Approved 2099 Holiday 3' },
    { date: '2099-08-31', name: 'Late Summer Holiday', notes: 'Approved 2099 Holiday 4' },
    { date: '2099-12-25', name: 'Winter Holiday', notes: 'Approved 2099 Holiday 5' },
  ];

  const configured = await holidays.setYearBankHolidays(testYear, initialHolidays);
  assert(configured.length === 5, `Configured 5 holidays for test year ${testYear}`);

  // Now HR updates holiday #2 name and date
  const updatedList = [
    { date: '2099-01-01', name: "New Year's Day", notes: 'Approved 2099 Holiday 1' },
    { date: '2099-04-02', name: 'Updated Spring Holiday', notes: 'Updated by HR' },
    { date: '2099-05-25', name: 'Early Summer Holiday', notes: 'Approved 2099 Holiday 3' },
    { date: '2099-08-31', name: 'Late Summer Holiday', notes: 'Approved 2099 Holiday 4' },
    { date: '2099-12-25', name: 'Winter Holiday', notes: 'Approved 2099 Holiday 5' },
  ];
  const reconfigured = await holidays.setYearBankHolidays(testYear, updatedList);
  assert(reconfigured.length === 5, 'Reconfigured list retains exactly 5 designated holidays');
  assert(reconfigured.some(h => h.date === '2099-04-02' && h.name === 'Updated Spring Holiday'), 'Updated holiday 2099-04-02 is present');
  assert(!reconfigured.some(h => h.date === '2099-03-25'), 'Old date 2099-03-25 was successfully replaced');

  // Clean up test year
  for (const h of reconfigured) {
    await holidays.deleteBankHoliday(h.id);
  }
  const cleared = await holidays.listBankHolidays(testYear);
  assert(cleared.length === 0, `Test year ${testYear} cleaned up successfully`);

  // ---------------------------------------------------------------------------
  // 3. Leave booking across a bank holiday
  // ---------------------------------------------------------------------------
  console.log('\n[3/6] Testing Leave Booking Across Bank Holiday...');
  // Create a test employee
  const testEmpId = `test_emp_bh_${crypto.randomBytes(4).toString('hex')}`;
  const now = Date.now();
  await db.prepare(`
    INSERT INTO employees (id, name, role, active, created_at, updated_at)
    VALUES (?, 'Bank Holiday Tester', 'Staff', 1, ?, ?)
  `).run(testEmpId, now, now);

  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?, ?, 'Staff Member', 'Full-time', '2025-06-01', '2025-06-01', ?)
  `).run(`er_${testEmpId}`, testEmpId, now);

  // Count leave days from 2026-01-01 (Thu - Bank Holiday) to 2026-01-02 (Fri - Working Day)
  const leaveCount = await leave.countLeaveDays(testEmpId, '2026-01-01', '2026-01-02', 'FULL_DAY');
  assert(leaveCount.totalDays === 1, `2-day span (Jan 1 to Jan 2) counts as exactly 1.0 leave day (found: ${leaveCount.totalDays})`);
  assert(leaveCount.workingDates.includes('2026-01-02'), '2026-01-02 is included as working date');
  assert(!leaveCount.workingDates.includes('2026-01-01'), '2026-01-01 is NOT included as working date');
  assert(leaveCount.skipped.some(s => s.date === '2026-01-01' && s.reason === "New Year's Day"), "2026-01-01 recorded in skipped list as New Year's Day");

  // ---------------------------------------------------------------------------
  // 4. Absence calculation exclusion
  // ---------------------------------------------------------------------------
  console.log('\n[4/6] Testing Absence Calculation Exclusion on Bank Holiday...');
  // 2026-01-01 is New Year's Day. Even though the test employee did not clock in,
  // scanDailyAbsences should find 0 absences for this day.
  const absenceScanResult = await warnings.scanDailyAbsences('2026-01-01');
  const testEmpAbsence = absenceScanResult.detected.find(a => a.employeeId === testEmpId);
  assert(testEmpAbsence == null, 'Employee not flagged as absent on Bank Holiday (2026-01-01)');

  // ---------------------------------------------------------------------------
  // 5. Monthly required working hours calculation
  // ---------------------------------------------------------------------------
  console.log('\n[5/6] Testing Monthly Required Working Hours Accounting...');
  // In January 2026: 31 days total.
  // 22 weekdays: Jan 1 (Thu), Jan 2 (Fri), Jan 5-9, Jan 12-16, Jan 19-23, Jan 26-30.
  // Jan 1 is Bank Holiday. So scheduled working days should be 21 days (not 22).
  const janWorkingDays = await schedule.workingDaysBetween(testEmpId, '2026-01-01', '2026-01-31');
  assert(!janWorkingDays.includes('2026-01-01'), 'January 1 is excluded from monthly working days');
  assert(janWorkingDays.length === 21, `January 2026 has exactly 21 working days excluding the bank holiday (found: ${janWorkingDays.length})`);

  const metrics = await attendance.calculateWorkingHoursMetrics(testEmpId, '2026-01-15');
  assert(metrics.monthly.scheduledWorkingDays === 21, `Monthly scheduled working days is 21 (found: ${metrics.monthly.scheduledWorkingDays})`);
  assert(metrics.monthly.requiredMinutes === 21 * 450, `Monthly required minutes is ${21 * 450} mins (9450 mins = 157.5h)`);

  // ---------------------------------------------------------------------------
  // 6. Company Calendar integration
  // ---------------------------------------------------------------------------
  console.log('\n[6/6] Testing Company Calendar Bank Holiday Inclusion...');
  const calHolidays = await holidays.getBankHolidaysBetween('2026-01-01', '2026-12-31');
  assert(calHolidays.length === 5, `Calendar range 2026-01-01 to 2026-12-31 includes all 5 bank holidays (found: ${calHolidays.length})`);
  assert(calHolidays.every(h => h.dayType === 'PUBLIC_HOLIDAY' && h.isPaid === true), 'All calendar bank holidays marked as paid PUBLIC_HOLIDAY');

  // Cleanup test employee
  console.log('\nCleaning up test records...');
  await db.prepare('DELETE FROM employment_records WHERE employee_id = ?').run(testEmpId);
  await db.prepare('DELETE FROM employees WHERE id = ?').run(testEmpId);
  console.log('Cleanup completed.');

  console.log('\n=============================================================');
  console.log('🎉 ALL 6 BANK HOLIDAY REQUIREMENTS VERIFIED & PASSED!');
  console.log('=============================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
