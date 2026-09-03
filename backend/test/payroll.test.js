// Payroll preparation tests. Spec sections 17, 18, 29 and the acceptance tests
// in section 34.
//
// Policy confirmed 2026-08-27: daily rate is monthly x 12 / 52 / 5, the break
// is paid, and every leaver settlement is decided by HR.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('payroll');

test.before(prepareDatabase);


const { db } = require('../src/db');
const PR = require('../src/domain/payroll');
const L = require('../src/domain/leave');
const T = require('../src/util/time');

async function makeEmployee(id, startDate = null) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  if (startDate) {
    await db.prepare(`
      INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET employee_id = EXCLUDED.employee_id, job_title = EXCLUDED.job_title, employment_type = EXCLUDED.employment_type, start_date = EXCLUDED.start_date, effective_from = EXCLUDED.effective_from, created_at = EXCLUDED.created_at
    `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  }
  return id;
}

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// The rate chain (spec 17)
// ---------------------------------------------------------------------------

// The exact worked example printed in spec section 17.
test('the spec 17 example: 2000 a month gives 24000, 461.54 and 92.31', async () => {
  const r = PR.rates(2000);
  assert.equal(r.monthly, 2000);
  assert.equal(r.annual, 24000, 'monthly x 12, as confirmed');
  assert.equal(r.weekly, 461.54);
  assert.equal(r.daily, 92.31);
  assert.equal(r.workingDaysPerYear, 260, 'the equivalent divisor the spec gives');
});

test('the equivalent formula agrees: annual / 260', async () => {
  const r = PR.rates(2000);
  assert.equal(PR.money(r.annual / 260), r.daily);
});

test('the rate chain scales', async () => {
  assert.equal(PR.rates(1800).daily, 83.08);
  assert.equal(PR.rates(0).daily, 0);
});

// ---------------------------------------------------------------------------
// Salary history (spec 17)
// ---------------------------------------------------------------------------

test('a pay rise never overwrites what someone was previously paid', async () => {
  const emp = await makeEmployee('emp_rise', '2025-06-01');

  await PR.setSalary({
    employeeId: emp, amount: 1800, effectiveFrom: '2026-01-01',
    reason: 'Starting salary', actor: 'user:hr',
  });
  await PR.setSalary({
    employeeId: emp, amount: 2000, effectiveFrom: '2026-06-01',
    reason: 'Annual review', actor: 'user:hr',
  });

  // The spec's own example: 1800 from January, 2000 from June, and BOTH must
  // stay answerable.
  assert.equal(await (await PR.salaryAt(emp, '2026-03-15')).monthly, 1800);
  assert.equal(await (await PR.salaryAt(emp, '2026-08-15')).monthly, 2000);
  assert.equal(await (await PR.salaryAt(emp, '2026-05-31')).monthly, 1800, 'the day before the rise');
  assert.equal(await (await PR.salaryAt(emp, '2026-06-01')).monthly, 2000, 'the day of the rise');

  assert.equal(await (await PR.salaryHistoryFor(emp)).length, 2);
});

test('salary periods never overlap', async () => {
  const rows = await db.prepare(
    "SELECT effective_from, effective_to FROM salary_history WHERE employee_id = 'emp_rise' ORDER BY effective_from"
  ).all();
  assert.equal(rows[0].effective_to, '2026-05-31', 'closed the day before the next begins');
  assert.equal(rows[1].effective_to, null, 'the current salary is open-ended');
});

test('a salary change requires a reason', async () => {
  const emp = await makeEmployee('emp_noreason', '2025-01-01');
  await assert.rejects(
    async () => await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2026-01-01', actor: 'user:hr' }),
    /reason/i,
  );
});

test('an employee with no salary on record is blocked, not assumed to be zero', async () => {
  const emp = await makeEmployee('emp_nosalary', '2025-01-01');
  const s = await PR.salaryAt(emp, '2026-08-27');
  assert.equal(s.blocked, true);
  assert.equal(s.reason, 'NO_SALARY_ON_RECORD');
});

// ---------------------------------------------------------------------------
// Starters (spec 18)
// ---------------------------------------------------------------------------

// Spec 18: "Daily salary x 4 working days = calculated first-month pay".
test('a starter working four days is paid for four days', async () => {
  // Starts Monday 24 August 2026, so Mon-Thu is four working days to the 27th.
  const emp = await makeEmployee('emp_starter', '2026-08-24');
  await PR.setSalary({
    employeeId: emp, amount: 2000, effectiveFrom: '2026-08-24',
    reason: 'Starting salary', actor: 'user:hr',
  });

  const c = await PR.starterCalculation({
    employeeId: emp, periodStart: '2026-08-01', periodEnd: '2026-08-27',
  });

  assert.equal(c.applicable, true);
  assert.equal(c.eligibleWorkingDays, 4);
  assert.equal(c.dailyRate, 92.31);

  // Full precision throughout gives 369.23. The spec's example shows 369.24
  // because it rounds the daily rate first - both are surfaced so the penny is
  // never a mystery.
  assert.equal(c.calculatedGross, 369.23);
  assert.equal(c.calculatedGrossRoundedDaily, 369.24, 'the spec 18 figure, for comparison');
});

test('weekends are not paid working days for a starter', async () => {
  // Starts Friday 28 August 2026: Friday only, since the 29th and 30th are the
  // weekend and the 31st is outside the period.
  const emp = await makeEmployee('emp_friday', '2026-08-28');
  await PR.setSalary({
    employeeId: emp, amount: 2000, effectiveFrom: '2026-08-28',
    reason: 'Start', actor: 'user:hr',
  });
  const c = await PR.starterCalculation({
    employeeId: emp, periodStart: '2026-08-01', periodEnd: '2026-08-30',
  });
  assert.equal(c.eligibleWorkingDays, 1);
  assert.equal(c.calculatedGross, 92.31);
});

test('someone who did not start in the period is not a starter', async () => {
  const emp = await makeEmployee('emp_existing', '2024-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2024-01-01', reason: 'Start', actor: 'user:hr' });
  const c = await PR.starterCalculation({ employeeId: emp, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
  assert.equal(c.applicable, false);
});

// ---------------------------------------------------------------------------
// Leavers (spec 18) - confirmed: HR decides, nothing is proposed
// ---------------------------------------------------------------------------

test('a leaver calculation produces every figure spec 18 asks for', async () => {
  const emp = await makeEmployee('emp_leaver', '2025-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2025-01-01', reason: 'Start', actor: 'user:hr' });
  for (let m = 1; m <= 6; m++) await L.accrue(emp, L.addMonths('2025-01-01', m));

  const c = await PR.leaverCalculation({ employeeId: emp, lastWorkingDate: '2025-07-15' });

  assert.equal(c.blocked, false);
  assert.equal(c.lastWorkingDate, '2025-07-15');
  assert.ok(c.eligibleWorkingDays > 0);
  assert.equal(c.salary.daily, 92.31);

  assert.equal(c.leave.blocked, false);
  assert.equal(c.leave.accruedDays, 10.00, 'six months accrued');
  assert.equal(c.leave.untakenDays, 10.00);
  assert.equal(c.leave.untakenValue, PR.money(92.307692307 * 10));
  assert.equal(c.leave.excessTakenDays, 0);

  assert.ok('wholeDayEquivalents' in c.attendanceDeficit);
});

// The heart of the confirmed policy, and of spec 29.
test('a leaver calculation proposes nothing and changes nothing', async () => {
  const before = {
    adjustments: (await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c,
    ledger: (await db.prepare('SELECT COUNT(*) c FROM leave_accrual_ledger').get()).c,
  };

  const c = await PR.leaverCalculation({ employeeId: 'emp_leaver', lastWorkingDate: '2025-07-15' });

  assert.deepEqual(c.proposedAdjustments, [], 'HR decides every settlement');
  assert.match(c.note, /decided by HR/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c, before.adjustments);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM leave_accrual_ledger').get()).c, before.ledger,
    'calculating a settlement must not touch the leave ledger');
});

test('leave taken in advance shows as excess, not as a negative untaken figure', async () => {
  const emp = await makeEmployee('emp_overdrawn', '2025-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2025-01-01', reason: 'Start', actor: 'user:hr' });
  await L.accrue(emp, '2025-03-01');   // 3.33 days

  const r = await L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual', startDate: '2025-03-10', endDate: '2025-03-14',
  });
  await L.decideRequest({
    requestId: r.id, decision: 'APPROVED', notes: 'Agreed', actor: 'user:hr',
    overdraftReason: 'Pre-booked before joining',
  });

  const c = await PR.leaverCalculation({ employeeId: emp, lastWorkingDate: '2025-03-20' });
  assert.equal(c.leave.untakenDays, 0);
  assert.equal(c.leave.excessTakenDays, 1.67, 'five days taken against 3.33 accrued');
  assert.ok(c.leave.excessTakenValue > 0);
});

test('a leaver with no salary on record is blocked rather than calculated as zero', async () => {
  const emp = await makeEmployee('emp_leaver_nosal', '2025-01-01');
  const c = await PR.leaverCalculation({ employeeId: emp, lastWorkingDate: '2025-06-30' });
  assert.equal(c.blocked, true);
  assert.equal(c.reason, 'NO_SALARY_ON_RECORD');
});

// ---------------------------------------------------------------------------
// Periods and adjustments (spec 18, 29)
// ---------------------------------------------------------------------------

test('preparing a period computes without writing anything', async () => {
  const period = await PR.createPeriod({
    name: 'August 2026', startDate: '2026-08-01', endDate: '2026-08-31', actor: 'user:hr',
  });
  const before = (await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c;

  const sheet = await PR.preparePeriod(period.id);

  assert.ok(sheet.employees.length > 0);
  assert.match(sheet.note, /Nothing here affects pay/);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c, before);
});

test('employees without a salary are named, not silently dropped', async () => {
  const period = await db.prepare("SELECT id FROM payroll_periods WHERE name = 'August 2026'").get();
  const sheet = await PR.preparePeriod(period.id);

  assert.ok(sheet.blocked.some(b => b.employeeId === 'emp_nosalary'),
    'a missing salary must be visible, not an absent row');
  for (const b of sheet.blocked) assert.ok(b.message, 'each carries a reason');
});

// Spec 8.3: reaching a whole-day equivalent creates an HR action, not a
// deduction.
test('an attendance deficit is shown as a value, never applied', async () => {
  const emp = await makeEmployee('emp_deficit', '2025-01-01');
  await PR.setSalary({ employeeId: emp, amount: 2000, effectiveFrom: '2025-01-01', reason: 'Start', actor: 'user:hr' });

  const A = require('../src/domain/attendance');
  await A.adjustBalance({
    employeeId: emp, dateKey: '2026-08-03', minutes: 500,
    reason: 'Seeded for the test', actor: 'test',
  });

  const period = await db.prepare("SELECT id FROM payroll_periods WHERE name = 'August 2026'").get();
  const row = await (await PR.preparePeriod(period.id)).employees.find(e => e.employeeId === emp);

  assert.equal(row.attendanceDeficit.wholeDayEquivalents, 1);
  assert.equal(row.attendanceDeficit.valueIfDeducted, 92.31);
  assert.equal(row.attendanceDeficit.needsHrDecision, true);

  // Named "valueIfDeducted", and no adjustment exists.
  assert.equal(
    (await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments WHERE employee_id = ?').get(emp)).c, 0,
  );
});

test('an adjustment is proposed, and approval is a separate act', async () => {
  const period = await db.prepare("SELECT id FROM payroll_periods WHERE name = 'August 2026'").get();

  const a = await PR.proposeAdjustment({
    periodId: period.id, employeeId: 'emp_deficit',
    adjustmentType: 'ATTENDANCE_DEFICIT',
    calculatedDays: 1, calculatedAmount: 92.31,
    explanation: 'One whole-day equivalent of attendance deficit',
    actor: 'user:hr',
  });
  assert.equal(a.status, 'PROPOSED');

  const row = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(a.id);
  assert.equal(row.approved_amount, null, 'nothing is approved on creation');
  assert.equal(row.approved_by, null);
});

test('approving records the approved amount separately from the calculated one', async () => {
  const adj = await db.prepare("SELECT * FROM payroll_adjustments WHERE status = 'PROPOSED' LIMIT 1").get();

  const r = await PR.decideAdjustment({
    adjustmentId: adj.id, decision: 'APPROVED',
    approvedAmount: 50.00,   // HR reduces it
    notes: 'Reduced by agreement with the employee', actor: 'user:hr',
  });

  assert.equal(r.approvedAmount, 50.00);

  const row = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adj.id);
  assert.equal(row.calculated_amount, 92.31, 'the calculation is preserved');
  assert.equal(row.approved_amount, 50.00, 'the override is recorded as an override');

  const entry = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'PAYROLL_ADJUSTMENT_DECIDED' ORDER BY at DESC LIMIT 1"
  ).get();
  assert.match(entry.note, /overridden from the calculated 92.31/);
});

test('an adjustment needs an explanation, and a decision needs a note', async () => {
  const period = await db.prepare("SELECT id FROM payroll_periods WHERE name = 'August 2026'").get();
  await assert.rejects(
    async () => await PR.proposeAdjustment({
      periodId: period.id, employeeId: 'emp_deficit',
      adjustmentType: 'OTHER', calculatedAmount: 10, actor: 'user:hr',
    }),
    /explanation/i,
  );

  const a = await PR.proposeAdjustment({
    periodId: period.id, employeeId: 'emp_deficit', adjustmentType: 'OTHER',
    calculatedAmount: 10, explanation: 'Test', actor: 'user:hr',
  });
  await assert.rejects(
    async () => await PR.decideAdjustment({ adjustmentId: a.id, decision: 'APPROVED', actor: 'user:hr' }),
    /note/i,
  );
  await PR.decideAdjustment({ adjustmentId: a.id, decision: 'REJECTED', notes: 'Not applicable', actor: 'user:hr' });
});

test('an adjustment cannot be decided twice', async () => {
  const adj = await db.prepare("SELECT * FROM payroll_adjustments WHERE status = 'REJECTED' LIMIT 1").get();
  await assert.rejects(
    async () => await PR.decideAdjustment({ adjustmentId: adj.id, decision: 'APPROVED', notes: 'x', actor: 'user:hr' }),
    /already/i,
  );
});

test('a period cannot close while adjustments await a decision', async () => {
  const period = await PR.createPeriod({
    name: 'September 2026', startDate: '2026-09-01', endDate: '2026-09-30', actor: 'user:hr',
  });
  await PR.proposeAdjustment({
    periodId: period.id, employeeId: 'emp_deficit', adjustmentType: 'OTHER',
    calculatedAmount: 25, explanation: 'Pending', actor: 'user:hr',
  });

  await assert.rejects(
    async () => await PR.closePeriod({ periodId: period.id, actor: 'user:hr' }),
    /awaiting a decision/i,
    'closing with undecided adjustments would finalise pay nobody agreed to',
  );
});

test('the whole payroll lifecycle is audited', async () => {
  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(r => r.action);
  for (const expected of [
    'SALARY_SET', 'PAYROLL_PERIOD_CREATED',
    'PAYROLL_ADJUSTMENT_PROPOSED', 'PAYROLL_ADJUSTMENT_DECIDED',
  ]) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// The paid break (confirmed 2026-08-27)
// ---------------------------------------------------------------------------

test('the paid break keeps a full day at 480 minutes', async () => {
  const { config } = require('../src/config');


  assert.equal(config.payroll.breakIsPaid, true);
  // 11:00-19:00 is 8 hours INCLUDING the 30 minute break, so a full day is 480
  // minutes. An unpaid break would make it 450 and change every deficit figure.
  assert.equal(config.office.dayEquivalentMinutes, 480);
  assert.equal(config.office.permittedBreakMinutes, 30);
});
