// Tests for the "monthly salary minus unpaid days" payroll model: a full
// period is paid the whole monthly salary minus whole-day deductions drawn
// from three sources (attendance-deficit whole-days, HR-confirmed
// unauthorised absences marked unpaid, approved unpaid-leave requests), each
// going through the existing propose -> approve payroll_adjustments
// workflow via the new generatePeriodDeductions() action.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('payroll_unpaid_days');

test.before(prepareDatabase);

const { db } = require('../src/db');
const PR = require('../src/domain/payroll');
const A = require('../src/domain/attendance');
const T = require('../src/util/time');

test.after(dropDatabase);

async function makeEmployee(id, startDate) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active'
  ).run(id, 'Unpaid Days ' + id, 'Engineering', T.now(), T.now());
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET start_date = EXCLUDED.start_date, effective_from = EXCLUDED.effective_from
  `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  return id;
}

// Every period gets a calendar month of its own: the schema allows one payroll
// period per exact date range (uq_payroll_periods_start_date_end_date), and
// several tests below create two. The months run from the current one
// forward, so every window ends on or after today - anything seeded "now"
// (e.g. via attendance.adjustBalance, which always timestamps created_at =
// T.now()) falls inside balanceAsOf()'s window, where a hardcoded historical
// period would not see deficit seeded by a test run long after that period
// supposedly ended. Records dated TODAY are still counted by a later month,
// because the unclaimed-source queries are deliberately unbounded below.
const TODAY = T.dateKey();
let monthOffset = 0;
function nextMonth() {
  const [y, m] = TODAY.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + monthOffset++, 1));
  const yy = first.getUTCFullYear();
  const mm = first.getUTCMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return { startDate: `${yy}-${pad(mm)}-01`, endDate: `${yy}-${pad(mm)}-${pad(last)}` };
}

// ---------------------------------------------------------------------------
// Full period: monthly salary as the baseline, no deductions
// ---------------------------------------------------------------------------

test('a full-period employee with nothing to deduct is paid the whole monthly salary', async () => {
  const emp = await makeEmployee('emp_full_clean', '2020-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2020-01-01', reason: 'Start', actor: 'user:hr' });

  const period = await PR.createPeriod({ name: 'Clean period', ...nextMonth(), actor: 'user:hr' });
  const sheet = await PR.preparePeriod(period.id);
  const row = sheet.employees.find(e => e.employeeId === emp);

  assert.equal(row.isPartialPeriod, false);
  assert.equal(row.grossBaseline, 2000);
  assert.equal(row.calculatedPeriodGross, 2000, 'no unpaid days means the preview equals the full salary');
  assert.equal(row.unpaidDays.totalDays, 0);
  assert.equal(row.netPayable.amount, 2000);
  assert.equal(row.netPayable.basis, 'PROVISIONAL', 'nothing has been proposed yet');
});

// ---------------------------------------------------------------------------
// Attendance deficit: 480+ accumulated minutes = one whole day off
// ---------------------------------------------------------------------------

test('a 500-minute deficit deducts exactly one whole day from a full period', async () => {
  const emp = await makeEmployee('emp_deficit_pay', '2020-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2020-01-01', reason: 'Start', actor: 'user:hr' });
  await A.adjustBalance({ employeeId: emp, dateKey: TODAY, minutes: 500, reason: 'Seeded for test', actor: 'test' });

  const period = await PR.createPeriod({ name: 'Deficit period', ...nextMonth(), actor: 'user:hr' });
  const before = await PR.preparePeriod(period.id);
  const rowBefore = before.employees.find(e => e.employeeId === emp);

  assert.equal(rowBefore.unpaidDays.deficitDays, 1, '500 min crosses one 480-minute threshold');
  assert.equal(rowBefore.unpaidDays.totalDays, 1);
  assert.equal(rowBefore.calculatedPeriodGross, PR.money(2000 - 2000 * 12 / 52 / 5), 'preview only, nothing proposed yet');
  assert.equal(rowBefore.netPayable.amount, 2000, 'net stays the full salary until an adjustment is approved');

  const gen = await PR.generatePeriodDeductions({ periodId: period.id, actor: 'user:hr' });
  assert.equal(gen.createdCount, 1);
  assert.equal(gen.created[0].adjustmentType, PR.ATTENDANCE_DEFICIT_DAY);

  const adjRow = await db.prepare(
    "SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ? AND adjustment_type = ?"
  ).get(period.id, emp, PR.ATTENDANCE_DEFICIT_DAY);
  assert.equal(adjRow.calculated_days, 1);
  assert.equal(adjRow.calculated_amount, -PR.money(2000 * 12 / 52 / 5));
  assert.equal(adjRow.status, 'PROPOSED');

  // Idempotent: running it again creates nothing new for this employee/period.
  const genAgain = await PR.generatePeriodDeductions({ periodId: period.id, actor: 'user:hr' });
  assert.equal(genAgain.createdCount, 0);

  await PR.decideAdjustment({
    adjustmentId: adjRow.id, decision: 'APPROVED', notes: 'Confirmed with employee', actor: 'user:hr',
  });
  // An employee only sees a period once it is final; for a manual period
  // that means closed.
  await PR.closePeriod({ periodId: period.id, actor: 'user:hr' });

  const stmts = await PR.employeeStatements(emp);
  // employeeStatements is gated on an org setting the test DB may not have
  // enabled; enable it so the statement is actually returned.
  if (!stmts.enabled) {
    await db.prepare(
      "INSERT INTO org_settings (key, value, updated_at) VALUES ('show_salary_to_employees', '1', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    ).run(T.now());
  }
  const finalStmts = await PR.employeeStatements(emp);
  const periodStmt = finalStmts.periods.find(p => p.periodId === period.id);
  assert.equal(periodStmt.basePayable, 2000);
  assert.equal(periodStmt.adjustmentsTotal, -PR.money(2000 * 12 / 52 / 5));
  assert.equal(periodStmt.netPayable, PR.money(2000 - 2000 * 12 / 52 / 5));
});

test('a rejected deficit deduction is terminal -- it does not resurface next period', async () => {
  const emp = await makeEmployee('emp_deficit_reject', '2020-01-01');
  await PR.setSalary({ employeeId: emp, amount: 1500, effectiveFrom: '2020-01-01', reason: 'Start', actor: 'user:hr' });
  await A.adjustBalance({ employeeId: emp, dateKey: TODAY, minutes: 480, reason: 'Seeded for test', actor: 'test' });

  const p1 = await PR.createPeriod({ name: 'Reject period 1', ...nextMonth(), actor: 'user:hr' });
  await PR.generatePeriodDeductions({ periodId: p1.id, actor: 'user:hr' });

  const adj = await db.prepare(
    "SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ? AND adjustment_type = ?"
  ).get(p1.id, emp, PR.ATTENDANCE_DEFICIT_DAY);
  assert.ok(adj, 'a deduction was proposed for the 480-minute crossing');

  await PR.decideAdjustment({
    adjustmentId: adj.id, decision: 'REJECTED', notes: 'Waived as a goodwill gesture', actor: 'user:hr',
  });

  // A second period, still ending "today" so it would see the same lifetime
  // balance if the rejection were not terminal.
  const p2 = await PR.createPeriod({ name: 'Reject period 2', ...nextMonth(), actor: 'user:hr' });
  const gen2 = await PR.generatePeriodDeductions({ periodId: p2.id, actor: 'user:hr' });
  assert.equal(gen2.createdCount, 0, 'the rejected whole-day must not be re-proposed in a later period');

  const sheet2 = await PR.preparePeriod(p2.id);
  const row2 = sheet2.employees.find(e => e.employeeId === emp);
  assert.equal(row2.unpaidDays.deficitDays, 0, 'preview must also treat the rejected day as claimed');
});

// ---------------------------------------------------------------------------
// Unauthorised absence marked unpaid
// ---------------------------------------------------------------------------

test('an HR-confirmed unpaid absence deducts one day and stamps consequences_applied_at on approval', async () => {
  const emp = await makeEmployee('emp_absence_unpaid', '2020-01-01');
  await PR.setSalary({ employeeId: emp, amount: 1000, effectiveFrom: '2020-01-01', reason: 'Start', actor: 'user:hr' });

  const absenceId = 'abs_test_1';
  await db.prepare(`
    INSERT INTO absence_records
      (id, employee_id, date_key, absence_type, detected_at, status, treat_as_unpaid, deduct_annual_leave, create_warning_trigger)
    VALUES (?,?,?,?,?, 'CONFIRMED', 1, 0, 0)
  `).run(absenceId, emp, TODAY, 'NO_SHOW', T.now());

  const period = await PR.createPeriod({ name: 'Absence period', ...nextMonth(), actor: 'user:hr' });
  const gen = await PR.generatePeriodDeductions({ periodId: period.id, actor: 'user:hr' });

  const created = gen.created.find(c => c.adjustmentType === PR.UNAUTHORISED_ABSENCE_UNPAID);
  assert.ok(created, 'the confirmed unpaid absence produced an adjustment');

  const adjRow = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(created.id);
  assert.equal(adjRow.source_reference, absenceId);
  assert.equal(adjRow.calculated_days, 1);

  const beforeApproval = await db.prepare('SELECT consequences_applied_at FROM absence_records WHERE id = ?').get(absenceId);
  assert.equal(beforeApproval.consequences_applied_at, null, 'not applied until approved');

  await PR.decideAdjustment({ adjustmentId: adjRow.id, decision: 'APPROVED', notes: 'Confirmed unpaid', actor: 'user:hr' });

  const afterApproval = await db.prepare('SELECT consequences_applied_at FROM absence_records WHERE id = ?').get(absenceId);
  assert.ok(afterApproval.consequences_applied_at, 'approval stamps the absence record');

  // Not re-proposed in a later period.
  const period2 = await PR.createPeriod({ name: 'Absence period 2', ...nextMonth(), actor: 'user:hr' });
  const gen2 = await PR.generatePeriodDeductions({ periodId: period2.id, actor: 'user:hr' });
  assert.equal(gen2.created.filter(c => c.adjustmentType === PR.UNAUTHORISED_ABSENCE_UNPAID).length, 0);
});

// ---------------------------------------------------------------------------
// Approved unpaid leave
// ---------------------------------------------------------------------------

test('an approved unpaid-leave request deducts its full day count', async () => {
  const emp = await makeEmployee('emp_unpaid_leave', '2020-01-01');
  await PR.setSalary({ employeeId: emp, amount: 1200, effectiveFrom: '2020-01-01', reason: 'Start', actor: 'user:hr' });

  const requestId = 'lr_test_1';
  await db.prepare(`
    INSERT INTO leave_requests
      (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, status, submitted_at, decided_at, created_at)
    VALUES (?,?, 'unpaid', ?, ?, 'FULL_DAY', 2, 'APPROVED', ?, ?, ?)
  `).run(requestId, emp, TODAY, TODAY, T.now(), T.now(), T.now());

  const period = await PR.createPeriod({ name: 'Unpaid leave period', ...nextMonth(), actor: 'user:hr' });
  const gen = await PR.generatePeriodDeductions({ periodId: period.id, actor: 'user:hr' });

  const created = gen.created.find(c => c.adjustmentType === PR.UNPAID_LEAVE_DEDUCTION);
  assert.ok(created, 'the approved unpaid-leave request produced an adjustment');

  const adjRow = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(created.id);
  assert.equal(adjRow.source_reference, requestId);
  assert.equal(adjRow.calculated_days, 2);
  assert.equal(adjRow.calculated_amount, -PR.money(1200 * 12 / 52 / 5 * 2));

  // A leave request on a PAID type must never be picked up.
  const period2 = await PR.createPeriod({ name: 'Unpaid leave period control', ...nextMonth(), actor: 'user:hr' });
  await db.prepare(`
    INSERT INTO leave_requests
      (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, status, submitted_at, decided_at, created_at)
    VALUES ('lr_paid_control', ?, 'annual', ?, ?, 'FULL_DAY', 1, 'APPROVED', ?, ?, ?)
  `).run(emp, TODAY, TODAY, T.now(), T.now(), T.now());
  const gen2 = await PR.generatePeriodDeductions({ periodId: period2.id, actor: 'user:hr' });
  assert.equal(gen2.created.filter(c => c.adjustmentType === PR.UNPAID_LEAVE_DEDUCTION).length, 0,
    'a paid leave type must not be treated as an unpaid day');
});

// ---------------------------------------------------------------------------
// Starters: partial period keeps the day-rate basis, unpaid days still apply
// ---------------------------------------------------------------------------

test('a starter with a confirmed unpaid absence in their first period is paid fewer days', async () => {
  // A fixed past month rather than the rolling ones above: starting on Monday
  // 16 March 2026 is always part-way through the period, so the day-rate
  // clamp logic exercises the "isPartialPeriod" branch. Nothing here depends
  // on the deficit ledger's timing, so the window need not reach today.
  const startDate = '2026-03-16';
  const emp = await makeEmployee('emp_starter_unpaid', startDate);
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: startDate, reason: 'Start', actor: 'user:hr' });

  const absenceId = 'abs_starter_1';
  await db.prepare(`
    INSERT INTO absence_records
      (id, employee_id, date_key, absence_type, detected_at, status, treat_as_unpaid, deduct_annual_leave, create_warning_trigger)
    VALUES (?,?,?,?,?, 'CONFIRMED', 1, 0, 0)
  `).run(absenceId, emp, '2026-03-17', 'NO_SHOW', T.now());

  const period = await PR.createPeriod({
    name: 'Starter unpaid period', startDate: '2026-03-01', endDate: '2026-03-31', actor: 'user:hr',
  });
  const sheet = await PR.preparePeriod(period.id);
  const row = sheet.employees.find(e => e.employeeId === emp);

  assert.equal(row.isPartialPeriod, true);
  assert.equal(row.unpaidDays.absenceDays, 1);
  assert.equal(
    row.calculatedPeriodGross,
    PR.money((2000 * 12 / 52 / 5) * Math.max(0, row.workingDaysCount - 1)),
    'a starter subtracts unpaid days from their scheduled day count, not from a full month',
  );
});
