// Deficit card: monthly settlement and the separate penalty, plus annual
// leave charges held as outstanding adjustments.
// "Office App - Update Requirements" (HR, 2026-11-12), sections 7-16, 36.

const test = require('node:test');
const assert = require('node:assert');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('deficit_periods');

const { db } = require('../src/db');
const A = require('../src/domain/attendance');
const L = require('../src/domain/leave');
const DP = require('../src/domain/deficitPeriods');
const T = require('../src/util/time');

test.before(prepareDatabase);
test.after(dropDatabase);

const BASE = DP.PERIODS_FROM;               // 2026-11
const NEXT = DP.nextPeriod(BASE);           // 2026-12
const baseStart = DP.periodBounds(BASE).start;
const at = (dateKey) => T.endOfDay(dateKey) - 3_600_000; // 11pm office time on that day
const rand = () => Math.random().toString(16).slice(2, 10);

async function makeEmployee(id, startDate = '2024-01-15') {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO NOTHING'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  await db.prepare(`
    INSERT INTO employment_records (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING
  `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  return id;
}

// Straight into the ledger with a chosen created_at, as the daily posting does.
async function postDeficit(employeeId, minutes, dateKey) {
  const prev = await db.prepare(
    'SELECT balance_after FROM attendance_deficit_ledger WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  ).get(employeeId);
  const bal = Math.max(0, Number(prev?.balance_after || 0) + minutes);
  await db.prepare(`
    INSERT INTO attendance_deficit_ledger
      (id, employee_id, date_key, entry_type, minutes_delta, balance_after, whole_days_after, carry_forward_after, description, created_at, created_by)
    VALUES (?,?,?, 'DAILY_DEFICIT', ?, ?, ?, ?, 'Attendance deficit', ?, 'system')
  `).run('def_' + rand(), employeeId, dateKey, minutes, bal, Math.floor(bal / 480), bal % 480, at(dateKey));
}

// A fixed "now" inside the second period so both periods exist.
const NOW = at(DP.periodBounds(NEXT).start) + 86_400_000 * 3;

test('8 hours is one deficit day; 26h 54m is 3 days + 2h 54m, never rounded up', async () => {
  const emp = await makeEmployee('emp_dp_calc');
  // 8h carried in from October (before the baseline), 18h 54m in November.
  await postDeficit(emp, 480, '2026-10-20');
  await postDeficit(emp, 600, `${BASE}-05`);
  await postDeficit(emp, 534, `${BASE}-12`);

  const v = await DP.periodView(emp, BASE, NOW);
  assert.equal(v.period.previous.minutes, 480, 'the October balance is the previous period deficit');
  assert.equal(v.period.current.netMinutes, 1134);
  assert.equal(v.period.total.minutes, 1614);
  assert.equal(v.period.convertedDays, 3);
  assert.equal(v.period.remaining.minutes, 174);
  assert.equal(v.period.remaining.formatted, '2h 54m');
  assert.equal(v.period.carriedForward.minutes, 1614, 'nothing settled yet: everything carries');
  assert.equal(v.dayMinutes, 480);
});

test('HR settles part of the deficit; carry forward is computed and the next period opens with it', async () => {
  const emp = await makeEmployee('emp_dp_settle');
  await postDeficit(emp, 1614, `${BASE}-10`); // 3 days + 2h 54m
  await L.accrue(emp, `${BASE}-15`);           // some annual leave to draw on

  // 36.6: more than the available deficit is refused.
  await assert.rejects(
    DP.settle({ employeeId: emp, periodKey: BASE, unpaidDays: 4, reason: 'x', actor: 'user:hr', approvedBy: 'HR', nowMs: NOW }),
    err => err.code === 'EXCEEDS_AVAILABLE' && /exceeds available deficit/i.test(err.message),
  );
  // 36.10: a reason and an approver are mandatory.
  await assert.rejects(DP.settle({ employeeId: emp, periodKey: BASE, unpaidDays: 1, reason: '', actor: 'user:hr', approvedBy: 'HR', nowMs: NOW }), /reason/i);
  await assert.rejects(DP.settle({ employeeId: emp, periodKey: BASE, unpaidDays: 1, reason: 'ok', actor: 'user:hr', approvedBy: '', nowMs: NOW }), /approved by/i);

  const before = (await L.balanceFor(emp, `${BASE}-15`)).availableDays;
  // Option B of section 11: settle 2 days (1 paid annual leave, 1 unpaid), carry 1 day + 2h 54m.
  const r = await DP.settle({
    employeeId: emp, periodKey: BASE, alDays: 1, unpaidDays: 1, reason: 'Agreed with manager',
    actor: 'user:hr', approvedBy: 'HR Manager', nowMs: NOW,
  });
  const p = r.view.period;
  assert.equal(p.settled.minutes, 960);
  assert.equal(p.settled.alDays, 1);
  assert.equal(p.settled.unpaidDays, 1);
  assert.equal(p.carriedForward.minutes, 654, '26h 54m - 16h = 10h 54m');
  assert.equal(p.carriedForward.days, 1);
  assert.equal(p.carriedForward.remainingMinutes, 174);
  // The original figures stay visible (36.12).
  assert.equal(p.total.minutes, 1614);
  assert.equal(p.convertedDays, 3);

  // Annual leave: exactly one day used to cover a deficit day, reported apart.
  const after = await L.balanceFor(emp, `${BASE}-15`);
  assert.equal(Math.round((before - after.availableDays) * 100) / 100, 1);
  assert.equal(after.deficitCoverDays, 1);
  assert.equal(after.penaltyDays, 0);

  // The lifetime ledger agrees with the card.
  const bal = await A.balanceFor(emp, NOW, false);
  assert.equal(bal.balanceMinutes, 654);

  // December opens with what November carried forward.
  const next = await DP.periodView(emp, NEXT, NOW);
  assert.equal(next.period.previous.minutes, 654);
  assert.equal(next.history[0].periodKey, BASE, 'previous-period history is retained');

  // Unpaid time reaches payroll only through this settlement, once.
  const PR = require('../src/domain/payroll');
  const unclaimed = await DP.unclaimedUnpaidSettlements({ employeeId: emp, throughDate: DP.periodBounds(NEXT).end, adjustmentType: PR.ATTENDANCE_DEFICIT_DAY });
  assert.equal(unclaimed.length, 1);
  assert.equal(unclaimed[0].dayEquivalents, 1);
});

test('hours and minutes can be settled as unpaid too; the remainder still carries', async () => {
  const emp = await makeEmployee('emp_dp_hours');
  await postDeficit(emp, 1614, `${BASE}-10`);
  const r = await DP.settle({
    employeeId: emp, periodKey: BASE, unpaidDays: 3, unpaidMinutes: 60, reason: 'All days unpaid plus one hour',
    actor: 'user:hr', approvedBy: 'HR Manager', nowMs: NOW,
  });
  assert.equal(r.view.period.settled.minutes, 1500);
  assert.equal(r.view.period.carriedForward.minutes, 114, '1h 54m carries into December');
  const unclaimed = await DP.unclaimedUnpaidSettlements({ employeeId: emp, throughDate: DP.periodBounds(NEXT).end, adjustmentType: 'ATTENDANCE_DEFICIT_DAY' });
  assert.equal(unclaimed[0].dayEquivalents, 3.125, '3 days + 1 hour at 8 hours a day');
});

test('the penalty is fixed, separate from settlement, and never applied twice', async () => {
  const emp = await makeEmployee('emp_dp_penalty');
  await postDeficit(emp, 1440, `${BASE}-10`); // 3 deficit days
  await L.accrue(emp, `${BASE}-15`);
  const before = (await L.balanceFor(emp, `${BASE}-15`)).availableDays;

  // Section 7 / 14: option 2 on 3 deficit days is 2 annual leave days, not 6.
  const r = await DP.applyPenalty({
    employeeId: emp, periodKey: BASE, option: 'OPTION_2', reason: 'Repeated deficit',
    actor: 'user:hr', approvedBy: 'HR Manager', nowMs: NOW,
  });
  assert.equal(r.view.period.penalty.alDays, 2);
  assert.equal(r.view.period.penalty.payDays, 0);
  const after = await L.balanceFor(emp, `${BASE}-15`);
  assert.equal(Math.round((before - after.availableDays) * 100) / 100, 2);
  assert.equal(after.penaltyDays, 2);
  // The deficit itself is untouched by the penalty (section 15).
  assert.equal(r.view.period.carriedForward.minutes, 1440);

  // 36.4: a second penalty for the same period is refused, with the details.
  await assert.rejects(
    DP.applyPenalty({ employeeId: emp, periodKey: BASE, option: 'OPTION_1', reason: 'again', actor: 'user:hr', approvedBy: 'HR', nowMs: NOW }),
    err => err.code === 'PENALTY_ALREADY_APPLIED' && err.details.approvedBy === 'HR Manager',
  );

  // Option 1 next period: 1 annual leave day and 1 day's pay, proposed to payroll.
  await postDeficit(emp, 480, `${NEXT}-02`);
  const r2 = await DP.applyPenalty({
    employeeId: emp, periodKey: NEXT, option: 'OPTION_1', reason: 'Again in December',
    actor: 'user:hr', approvedBy: 'HR Manager', nowMs: NOW,
  });
  assert.equal(r2.view.period.penalty.payDays, 1);
  const pay = await DP.unclaimedPenaltyPay({ employeeId: emp, throughDate: DP.periodBounds(NEXT).end, adjustmentType: 'ATTENDANCE_PENALTY_PAY' });
  assert.equal(pay.length, 1);
  assert.equal(pay[0].payDays, 1);
});

test('with too little annual leave the charge is refused, or held as an outstanding adjustment on request', async () => {
  const emp = await makeEmployee('emp_dp_outstanding', '2026-10-20'); // no month of service completed: nothing accrued
  await postDeficit(emp, 960, `${BASE}-10`); // 2 deficit days
  const bal = await L.balanceFor(emp, `${BASE}-15`);
  assert.ok(bal.availableDays < 2, `test needs a short balance, got ${bal.availableDays}`);

  // 36.3: the warning, nothing written.
  await assert.rejects(
    DP.settle({ employeeId: emp, periodKey: BASE, alDays: 2, reason: 'Cover with leave', actor: 'user:hr', approvedBy: 'HR', nowMs: NOW }),
    err => err.code === 'INSUFFICIENT_BALANCE' && err.details.requiredDays === 2,
  );
  assert.equal((await DP.periodView(emp, BASE, NOW)).period.settled.minutes, 0);

  // HR reviews and chooses to hold the shortfall as an outstanding adjustment (section 8).
  const r = await DP.settle({
    employeeId: emp, periodKey: BASE, alDays: 2, reason: 'Cover with leave; shortfall outstanding',
    actor: 'user:hr', approvedBy: 'HR Manager', allowOutstanding: true, nowMs: NOW,
  });
  assert.ok(r.outstandingId);
  const after = await L.balanceFor(emp, `${BASE}-15`);
  assert.ok(after.availableDays >= -0.005, 'the balance never goes below zero');
  const outstanding = await L.listOutstandingAdjustments(emp);
  assert.equal(outstanding.length, 1);
  assert.equal(outstanding[0].status, 'OPEN');
  assert.equal(Math.round((outstanding[0].remainingDays + after.deficitCoverDays) * 100) / 100, 2, 'deducted now + outstanding = 2 days');

  // The leaver calculation takes the outstanding adjustment off the final balance.
  const PR = require('../src/domain/payroll');
  await PR.setSalary({ employeeId: emp, amount: 1000, effectiveFrom: '2026-09-01', reason: 'Start', actor: 'user:hr' });
  const leaver = await PR.leaverCalculation({ employeeId: emp, lastWorkingDate: `${NEXT}-15` });
  assert.equal(leaver.leave.outstandingAdjustmentDays, outstanding[0].remainingDays);
  assert.equal(leaver.leave.untakenDays, Math.max(0, Math.round((leaver.leave.accruedBalanceDays - outstanding[0].remainingDays) * 100) / 100));
});

test('the old resolve-deficit route is gone', async () => {
  const { app } = require('../src/server');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/leave/employee/emp_dp_calc/resolve-deficit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY },
      body: JSON.stringify({ wholeDays: 1, resolutionType: 'ANNUAL_LEAVE' }),
    });
    assert.equal(res.status, 410);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
