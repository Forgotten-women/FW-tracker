// Leave engine tests. Spec sections 13, 14, 15, 16 and the acceptance tests
// in section 34.
//
// Policy confirmed 2026-08-27: 20 days, anniversary-based holiday year, monthly
// accrual on completion, nothing carries over, overdraft allowed with HR
// approval, HR-only approval route.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-leave-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = path.join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const L = require('../src/domain/leave');
const T = require('../src/util/time');

function makeEmployee(id, startDate = null) {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());

  if (startDate) {
    db.prepare(`
      INSERT OR REPLACE INTO employment_records
        (id, employee_id, job_title, employment_type, start_date, effective_from, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, startDate, T.now());
  }
  return id;
}

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

// ---------------------------------------------------------------------------
// The anniversary holiday year
// ---------------------------------------------------------------------------

// Confirmed policy is anniversary-based, so a missing start date is not
// something to paper over with a guess.
test('an employee with no start date is reported as blocked, not guessed', () => {
  const emp = makeEmployee('emp_nostart');
  const year = L.holidayYearFor(emp, '2026-08-27');

  assert.equal(year.blocked, true);
  assert.equal(year.reason, 'NO_START_DATE');
  assert.match(year.message, /employment record/i);

  const balance = L.balanceFor(emp, '2026-08-27');
  assert.equal(balance.blocked, true, 'a balance must not be invented either');
});

test('the holiday year runs from the employment anniversary', () => {
  const emp = makeEmployee('emp_anniv', '2025-03-15');

  const firstYear = L.holidayYearFor(emp, '2025-09-01');
  assert.equal(firstYear.yearStart, '2025-03-15');
  assert.equal(firstYear.yearEnd, '2026-03-15');
  assert.equal(firstYear.yearsOfService, 0);

  // Past the first anniversary, the year rolls over.
  const secondYear = L.holidayYearFor(emp, '2026-08-27');
  assert.equal(secondYear.yearStart, '2026-03-15');
  assert.equal(secondYear.yearEnd, '2027-03-15');
  assert.equal(secondYear.yearsOfService, 1);
});

test('a start date at month end does not roll into the next month', () => {
  const emp = makeEmployee('emp_31st', '2025-01-31');
  // One month after 31 January is 28 February, not 3 March.
  assert.equal(L.addMonths('2025-01-31', 1), '2025-02-28');
  const year = L.holidayYearFor(emp, '2025-06-01');
  assert.equal(year.yearStart, '2025-01-31');
});

test('employment that has not started yet is blocked', () => {
  const emp = makeEmployee('emp_future', '2027-01-01');
  const year = L.holidayYearFor(emp, '2026-08-27');
  assert.equal(year.blocked, true);
  assert.equal(year.reason, 'NOT_STARTED');
});

// ---------------------------------------------------------------------------
// Accrual (spec 14)
// ---------------------------------------------------------------------------

// The exact table printed in spec section 14.
test('accrual matches the spec table: 1.67, 3.33, 5.00, 10.00', () => {
  const emp = makeEmployee('emp_accrual', '2025-01-01');
  const expected = [
    ['2025-02-01', 1, 1.67],
    ['2025-03-01', 2, 3.33],
    ['2025-04-01', 3, 5.00],
    ['2025-07-01', 6, 10.00],
    ['2025-12-01', 11, 18.33],
  ];

  for (const [onDate, months, days] of expected) {
    L.accrue(emp, onDate);
    const b = L.balanceFor(emp, onDate);
    assert.equal(b.monthsCompleted, months, `months completed at ${onDate}`);
    assert.equal(b.accruedDays, days, `accrued at ${onDate}`);
  }
});

// The 12th month completes exactly ON the anniversary, which is also the moment
// the year rolls over. Without finalising the outgoing year, nobody would ever
// reach 20 - the year would stop at 11 months and the 12th would land in a new
// year that starts from zero.
test('the twelfth month completes the outgoing year at exactly 20.00', () => {
  const emp = makeEmployee('emp_month12', '2025-01-01');
  for (let m = 1; m <= 11; m++) L.accrue(emp, L.addMonths('2025-01-01', m));
  assert.equal(L.balanceFor(emp, '2025-12-31').accruedDays, 18.33, 'eleven months served');

  // Crossing the anniversary finalises the year just ended.
  L.accrue(emp, '2026-01-02');

  const yearOne = db.prepare(`
    SELECT COALESCE(SUM(days_delta), 0) AS d FROM leave_accrual_ledger
    WHERE employee_id = ? AND leave_year LIKE '%/0' AND entry_type = 'ACCRUAL'
  `).get(emp).d;
  assert.equal(Math.round(yearOne * 100) / 100, 20, 'spec 14: month 12 is 20.00');
});

// The reason accrual is computed cumulatively rather than by adding 20/12
// twelve times, which overshoots in floating point.
test('a full year totals exactly 20, not 19.99 or 20.0000004', () => {
  const emp = makeEmployee('emp_precision', '2025-01-01');
  for (let m = 1; m <= 12; m++) L.accrue(emp, L.addMonths('2025-01-01', m));

  const total = db.prepare(`
    SELECT COALESCE(SUM(days_delta), 0) AS d FROM leave_accrual_ledger
    WHERE employee_id = ? AND leave_year LIKE '%/0' AND entry_type = 'ACCRUAL'
  `).get(emp).d;

  // Cumulative targets rather than adding 20/12 twelve times, which overshoots.
  assert.ok(Math.abs(total - 20) < 1e-9, `expected exactly 20, got ${total}`);
});

test('accrual is idempotent within a month', () => {
  const emp = makeEmployee('emp_idem', '2025-01-01');
  const first = L.accrue(emp, '2025-04-15');
  assert.equal(first.accrued, true);

  for (let i = 0; i < 5; i++) {
    const again = L.accrue(emp, '2025-04-15');
    assert.equal(again.accrued, false);
    assert.equal(again.upToDate, true);
  }
  assert.equal(L.balanceFor(emp, '2025-04-15').accruedDays, 5.00);
});

test('accrual never exceeds the annual entitlement', () => {
  const emp = makeEmployee('emp_cap', '2025-01-01');
  // Repeatedly accruing deep into the second year must not overshoot.
  for (const d of ['2026-06-01', '2026-06-01', '2026-06-02']) L.accrue(emp, d);

  const perYear = db.prepare(`
    SELECT leave_year, SUM(days_delta) AS d FROM leave_accrual_ledger
    WHERE employee_id = ? AND entry_type = 'ACCRUAL' GROUP BY leave_year
  `).all(emp);
  for (const y of perYear) {
    assert.ok(y.d <= 20.005, `${y.leave_year} accrued ${y.d}, above the entitlement`);
  }
});

test('the new holiday year starts from zero, because nothing carries over', () => {
  const emp = makeEmployee('emp_reset', '2025-01-01');
  for (let m = 1; m <= 12; m++) L.accrue(emp, L.addMonths('2025-01-01', m));

  // One day past the anniversary.
  const next = L.balanceFor(emp, '2026-01-02');
  assert.equal(next.leaveYear.endsWith('/1'), true, 'second year of service');
  assert.equal(next.accruedDays, 0, 'the new year begins empty');

  L.accrue(emp, '2026-02-01');
  assert.equal(L.balanceFor(emp, '2026-02-01').accruedDays, 1.67);
});

test('an unused balance is forfeited with a ledger entry, not silently zeroed', () => {
  const emp = makeEmployee('emp_forfeit', '2025-01-01');
  for (let m = 1; m <= 12; m++) L.accrue(emp, L.addMonths('2025-01-01', m));

  const r = L.closeHolidayYear(emp, L.holidayYearFor(emp, '2025-12-31').leaveYear, 20, '2026-01-01');
  assert.equal(r.forfeited, 20);

  const entry = db.prepare(
    "SELECT * FROM leave_accrual_ledger WHERE employee_id = ? AND entry_type = 'FORFEIT'"
  ).get(emp);
  assert.ok(entry, 'the employee must be able to see what was lost and when');
  assert.match(entry.description, /Nothing carries over/);
});

// ---------------------------------------------------------------------------
// Counting days (spec 16)
// ---------------------------------------------------------------------------

test('weekends inside a leave request are not counted', () => {
  const emp = makeEmployee('emp_weekend', '2025-01-01');
  // Thursday 27 August to Monday 31 August 2026.
  const c = L.countLeaveDays(emp, '2026-08-27', '2026-08-31');
  assert.equal(c.totalDays, 3, 'Thu, Fri, Mon - the weekend is not leave');
  assert.equal(c.skipped.length, 2);
});

test('a paid office closure inside a request is not deducted', () => {
  const emp = makeEmployee('emp_closure', '2025-01-01');
  db.prepare(
    'INSERT OR REPLACE INTO office_locations (id,name,time_zone,active,created_at) VALUES (?,?,?,1,?)'
  ).run('off_pk', 'Pakistan Office', 'Asia/Karachi', T.now());
  db.prepare('UPDATE employees SET office_id = ? WHERE id = ?').run('off_pk', emp);
  db.prepare(`
    INSERT OR REPLACE INTO calendar_days (id, office_id, date, day_type, name, is_paid, created_at)
    VALUES (?,?,?,?,?,1,?)
  `).run('cal_eid2', 'off_pk', '2026-08-27', 'PUBLIC_HOLIDAY', 'Eid holiday', T.now());

  const c = L.countLeaveDays(emp, '2026-08-27', '2026-08-28');
  // Spec 16: no annual leave is lost for a day the office is shut.
  assert.equal(c.totalDays, 1, 'only the Friday counts');
  assert.ok(c.skipped.some(s => s.reason === 'Eid holiday'));
});

test('a half day counts as half', () => {
  const emp = makeEmployee('emp_half', '2025-01-01');
  const c = L.countLeaveDays(emp, '2026-08-27', '2026-08-27', 'HALF_DAY_AM');
  assert.equal(c.totalDays, 0.5);
});

// ---------------------------------------------------------------------------
// Requests (spec 15)
// ---------------------------------------------------------------------------

test('the preview shows the figures the spec asks for before submitting', () => {
  const emp = makeEmployee('emp_preview', '2025-01-01');
  for (let m = 1; m <= 7; m++) L.accrue(emp, L.addMonths('2025-01-01', m));

  const p = L.previewRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-08-11', endDate: '2025-08-13',
  });

  assert.equal(p.ok, true);
  assert.equal(p.requestedDays, 3);
  assert.equal(p.balance.accruedDays, 11.67);
  assert.equal(p.projectedAvailableDays, 8.67, 'spec 15 shows the projected balance up front');
  assert.equal(p.exceedsBalance, false);
});

test('a request beyond the accrued balance is allowed but flagged', () => {
  const emp = makeEmployee('emp_over', '2025-01-01');
  L.accrue(emp, '2025-03-01');   // 2 months, 3.33 days

  const p = L.previewRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-03-10', endDate: '2025-03-14',   // 5 working days
  });

  assert.equal(p.ok, true);
  assert.equal(p.exceedsBalance, true);
  assert.equal(p.shortfallDays, 1.67);
  assert.equal(p.requiresOverdraftApproval, true);
  assert.match(p.warning, /HR must approve/);
});

test('sick leave does not come out of the annual balance', () => {
  const emp = makeEmployee('emp_sick', '2025-01-01');
  L.accrue(emp, '2025-04-01');
  const before = L.balanceFor(emp, '2025-04-01').availableDays;

  const p = L.previewRequest({
    employeeId: emp, leaveTypeId: 'sick',
    startDate: '2025-04-07', endDate: '2025-04-08',
  });
  assert.equal(p.leaveType.reducesEntitlement, false);
  assert.equal(p.projectedAvailableDays, before, 'sickness is not a holiday');
});

test('a request goes straight to HR, with no manager step', () => {
  const emp = makeEmployee('emp_route', '2025-01-01');
  L.accrue(emp, '2025-06-01');

  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-06-09', endDate: '2025-06-10',
  });

  assert.equal(r.status, 'PENDING_HR');
  const steps = db.prepare('SELECT * FROM leave_approvals WHERE request_id = ?').all(r.id);
  assert.equal(steps.length, 1, 'HR only, as confirmed');
  assert.equal(steps[0].approver_role, 'hr');
});

test('overlapping requests are refused', () => {
  const emp = makeEmployee('emp_overlap', '2025-01-01');
  L.accrue(emp, '2025-06-01');
  L.submitRequest({ employeeId: emp, leaveTypeId: 'annual', startDate: '2025-06-09', endDate: '2025-06-11' });

  assert.throws(
    () => L.submitRequest({ employeeId: emp, leaveTypeId: 'annual', startDate: '2025-06-10', endDate: '2025-06-12' }),
    /overlaps/i,
  );
});

test('a range with no working days is refused', () => {
  const emp = makeEmployee('emp_nowork', '2025-01-01');
  // Saturday and Sunday.
  const p = L.previewRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2026-08-29', endDate: '2026-08-30',
  });
  assert.equal(p.ok, false);
  assert.match(p.error, /no working days/i);
});

// ---------------------------------------------------------------------------
// Approval (spec 34: approved reduces balance, cancelled restores it)
// ---------------------------------------------------------------------------

test('approving reduces the available balance', () => {
  const emp = makeEmployee('emp_approve', '2025-01-01');
  L.accrue(emp, '2025-07-01');
  const before = L.balanceFor(emp, '2025-07-01').availableDays;

  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-07-07', endDate: '2025-07-09',
  });
  L.decideRequest({ requestId: r.id, decision: 'APPROVED', notes: 'Approved', actor: 'user:hr' });

  const after = L.balanceFor(emp, '2025-07-10').availableDays;
  assert.equal(Math.round((before - after) * 100) / 100, 3);
});

test('cancelling restores the balance without erasing the history', () => {
  const emp = makeEmployee('emp_cancel', '2025-01-01');
  L.accrue(emp, '2025-07-01');
  const before = L.balanceFor(emp, '2025-07-01').availableDays;

  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-07-14', endDate: '2025-07-16',
  });
  L.decideRequest({ requestId: r.id, decision: 'APPROVED', notes: 'Approved', actor: 'user:hr' });
  L.cancelRequest({ requestId: r.id, actor: 'user:hr', reason: 'Trip cancelled' });

  assert.equal(L.balanceFor(emp, '2025-07-20').availableDays, before);

  // Ordered by rowid, which is insertion order. Ordering by `id` was
  // meaningless - those are random hex strings, so the sequence came out
  // differently on about one run in three.
  const entries = db.prepare(
    'SELECT entry_type FROM leave_accrual_ledger WHERE leave_request_id = ? ORDER BY rowid'
  ).all(r.id).map(e => e.entry_type);
  assert.deepEqual(entries, ['BOOKED', 'CANCELLED'], 'reversed, not deleted');
});

// The heart of the confirmed overdraft policy.
test('approving beyond the balance requires an explicit reason', () => {
  const emp = makeEmployee('emp_odapprove', '2025-01-01');
  L.accrue(emp, '2025-03-01');   // 3.33 days

  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-03-10', endDate: '2025-03-14',   // 5 days
  });

  assert.throws(
    () => L.decideRequest({ requestId: r.id, decision: 'APPROVED', notes: 'Fine', actor: 'user:hr' }),
    /exceeds the accrued balance/i,
    'letting someone go into debt must be a deliberate act',
  );

  L.decideRequest({
    requestId: r.id, decision: 'APPROVED', notes: 'Fine',
    actor: 'user:hr', overdraftReason: 'Pre-booked family wedding, agreed at hire',
  });

  const od = db.prepare('SELECT * FROM leave_overdraft_approvals WHERE request_id = ?').get(r.id);
  assert.ok(od, 'the overdraft must be attributable');
  assert.equal(od.shortfall_days, 1.67);
  assert.match(od.reason, /wedding/);

  assert.equal(L.balanceFor(emp, '2025-03-20').isNegative, true);
});

test('rejecting leaves the balance untouched', () => {
  const emp = makeEmployee('emp_reject', '2025-01-01');
  L.accrue(emp, '2025-07-01');
  const before = L.balanceFor(emp, '2025-07-01').availableDays;

  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual',
    startDate: '2025-07-21', endDate: '2025-07-22',
  });
  L.decideRequest({ requestId: r.id, decision: 'REJECTED', notes: 'Cover unavailable', actor: 'user:hr' });

  assert.equal(L.balanceFor(emp, '2025-07-25').availableDays, before);
});

test('a decision requires a note, and cannot be made twice', () => {
  const emp = makeEmployee('emp_dec', '2025-01-01');
  L.accrue(emp, '2025-07-01');
  const r = L.submitRequest({
    employeeId: emp, leaveTypeId: 'annual', startDate: '2025-07-28', endDate: '2025-07-29',
  });

  assert.throws(() => L.decideRequest({ requestId: r.id, decision: 'APPROVED', actor: 'user:hr' }), /note/i);

  L.decideRequest({ requestId: r.id, decision: 'REJECTED', notes: 'No', actor: 'user:hr' });
  assert.throws(
    () => L.decideRequest({ requestId: r.id, decision: 'APPROVED', notes: 'Changed mind', actor: 'user:hr' }),
    /already been/i,
  );
});

// ---------------------------------------------------------------------------
// Adjustments and audit
// ---------------------------------------------------------------------------

test('an HR adjustment needs a reason and is attributed', () => {
  const emp = makeEmployee('emp_adj', '2025-01-01');
  L.accrue(emp, '2025-04-01');

  assert.throws(() => L.adjustBalance({ employeeId: emp, days: 2, actor: 'user:hr' }), /reason/i);

  // onDate matters: without it the adjustment lands in whichever holiday year
  // today falls in, which under an anniversary year is rarely the one meant.
  const after = L.adjustBalance({
    employeeId: emp, days: 2, reason: 'Time off in lieu for the weekend launch',
    actor: 'user:hr', onDate: '2025-04-01',
  });
  assert.equal(after.accruedDays, 7.00, '5.00 accrued plus a 2 day adjustment');
});

test('the whole leave lifecycle is audited', () => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log').all().map(r => r.action);
  for (const expected of [
    'LEAVE_REQUESTED', 'LEAVE_DECIDED', 'LEAVE_CANCELLED', 'LEAVE_ADJUSTED', 'LEAVE_FORFEITED',
  ]) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});

test('accrueAll reports who is blocked rather than skipping them quietly', () => {
  makeEmployee('emp_blocked_a');           // no start date
  makeEmployee('emp_ok_a', '2025-01-01');

  const r = L.accrueAll('2026-08-27');
  assert.ok(r.blocked.some(b => b.employeeId === 'emp_blocked_a'));
  assert.ok(r.blocked.every(b => b.reason), 'each blocked employee carries a reason');
});
