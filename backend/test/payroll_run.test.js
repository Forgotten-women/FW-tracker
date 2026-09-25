// The automated monthly payroll run (migration 024).
//
// The tick opens each calendar month's period and, after the cut-off (the
// 25th), generates its deductions and hands it to HR. Only a person approving
// the run turns it into payslips - "the system calculates, a person approves".
//
// Every test drives time explicitly (nowMs), never the real clock, and each
// scenario uses its own calendar month of 2025. The tests share one schema and
// run in order: later ones build on the payslips earlier ones publish.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// The run broadcasts events and notifications. With Upstash credentials in the
// environment those would be pushed onto the live event list that production
// dashboards read, so this suite switches the shared bus off for itself
// (dotenv never overrides a variable that is already set).
process.env.UPSTASH_REDIS_REST_URL = '';
process.env.UPSTASH_REDIS_REST_TOKEN = '';

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('payroll_run');

const express = require('express');
const { db } = require('../src/db');
const PR = require('../src/domain/payroll');
const jobs = require('../src/jobs');
const T = require('../src/util/time');

test.before(async () => {
  await prepareDatabase();
  await setSetting('show_salary_to_employees', '1');
});
test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const at = (dateKey, hhmm = '12:00') => T.wallClockToEpoch(dateKey, hhmm);
const daily = monthly => monthly * 12 / 52 / 5;
const rand = () => crypto.randomBytes(6).toString('hex');

async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO org_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value'
  ).run(key, value, T.now());
  PR.invalidatePayrollCache();
}

async function makeEmployee(id, startDate, { salary = 2000, salaryFrom = startDate, contractEnd = null } = {}) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Run ' + id, 'Engineering', T.now(), T.now());
  await db.prepare(`
    INSERT INTO employment_records
      (id, employee_id, job_title, employment_type, start_date, contract_end_date, effective_from, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('er_' + id, id, 'Engineer', 'Full-time', startDate, contractEnd, startDate, T.now());
  await PR.setSalary({ employeeId: id, amount: salary, effectiveFrom: salaryFrom, reason: 'Start', actor: 'user:hr' });
  return id;
}

async function unpaidAbsence(employeeId, dateKey, id = 'abs_' + rand()) {
  await db.prepare(`
    INSERT INTO absence_records
      (id, employee_id, date_key, absence_type, detected_at, status, treat_as_unpaid, deduct_annual_leave, create_warning_trigger)
    VALUES (?,?,?, 'NO_SHOW', ?, 'CONFIRMED', 1, 0, 0)
  `).run(id, employeeId, dateKey, at(dateKey));
  return id;
}

async function unpaidLeave(employeeId, startDate, endDate, days, id = 'lr_' + rand()) {
  await db.prepare(`
    INSERT INTO leave_requests
      (id, employee_id, leave_type_id, start_date, end_date, day_portion, total_days, status, submitted_at, decided_at, created_at)
    VALUES (?,?, 'unpaid', ?, ?, 'FULL_DAY', ?, 'APPROVED', ?, ?, ?)
  `).run(id, employeeId, startDate, endDate, days, at(startDate), at(startDate), at(startDate));
  return id;
}

// Straight into the ledger, with a created_at inside the month under test:
// balanceAsOf() bounds by created_at, and adjustBalance() would stamp the
// real clock.
async function seedDeficit(employeeId, minutes, dateKey) {
  await db.prepare(`
    INSERT INTO attendance_deficit_ledger
      (id, employee_id, date_key, entry_type, minutes_delta, balance_after,
       whole_days_after, carry_forward_after, description, created_at, created_by)
    VALUES (?,?,?, 'HR_ADJUSTMENT', ?, ?, ?, ?, 'Seeded for test', ?, 'test')
  `).run('def_' + rand(), employeeId, dateKey, minutes, minutes, Math.floor(minutes / 480), minutes % 480, at(dateKey));
}

const tick = dateKey => PR.runPayrollAutomation({ nowMs: at(dateKey) });
const periodStarting = start => db.prepare('SELECT * FROM payroll_periods WHERE start_date = ?').get(start);
const linesFor = (periodId, employeeId) => db.prepare(
  'SELECT * FROM payroll_adjustments WHERE period_id = ? AND employee_id = ? ORDER BY created_at, id'
).all(periodId, employeeId);
const payslipsFor = periodId => db.prepare('SELECT * FROM payslips WHERE period_id = ? ORDER BY employee_id').all(periodId);

async function rejectsWith(promise, code) {
  await assert.rejects(promise, err => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Opening the month
// ---------------------------------------------------------------------------

test('the tick opens exactly one period for the month, even when it runs twice at once', async () => {
  const nowMs = at('2025-01-10');
  const results = await Promise.all([
    PR.runPayrollAutomation({ nowMs }),
    PR.runPayrollAutomation({ nowMs }),
    jobs.payrollRun(nowMs),
  ]);

  const rows = await db.prepare("SELECT * FROM payroll_periods WHERE start_date = '2025-01-01'").all();
  assert.equal(rows.length, 1, 'one period, however many ticks raced');
  const p = rows[0];
  assert.equal(p.name, 'January 2025');
  assert.equal(p.end_date, '2025-01-31');
  assert.equal(p.cutoff_date, '2025-01-25', 'the default cut-off is the 25th');
  assert.equal(p.pay_date, '2025-01-31', 'paid on the last day of the month');
  assert.equal(p.status, 'OPEN');
  assert.equal(p.auto_created, 1);
  assert.equal(p.exchange_rate, 350.0, 'no earlier period to carry a rate from');

  assert.ok(results.slice(0, 2).filter(r => r.opened.created).length <= 1);
  const created = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'PAYROLL_PERIOD_CREATED' AND target_id = ?"
  ).all(p.id);
  assert.equal(created.length, 1, 'audited once');
  assert.equal(created[0].actor, 'system');

  // Ticking again later in the month is a no-op.
  const again = await tick('2025-01-20');
  assert.equal(again.opened.created, false);
  assert.equal(again.opened.periodId, p.id);
});

test('the next month carries the exchange rate forward; a manual period covering a month stops a second one', async () => {
  const jan = await periodStarting('2025-01-01');
  await PR.updatePeriodExchangeRate({ periodId: jan.id, exchangeRate: 360, actor: 'user:hr' });

  await tick('2025-02-03');
  const feb = await periodStarting('2025-02-01');
  assert.equal(feb.name, 'February 2025');
  assert.equal(feb.cutoff_date, '2025-02-25');
  assert.equal(feb.pay_date, '2025-02-28');
  assert.equal(feb.exchange_rate, 360);

  // HR ran November by hand, on dates of their own. Opening "November 2025"
  // as well would pay the overlap twice.
  await PR.createPeriod({ name: 'November (manual)', startDate: '2025-11-03', endDate: '2025-12-02', actor: 'user:hr' });
  const r = await tick('2025-11-20');
  assert.equal(r.opened.created, false);
  assert.equal(await periodStarting('2025-11-01'), undefined);

  // That tick was also past January's and February's cut-offs, so both moved
  // to review (nobody is employed yet, so with no lines at all).
  assert.equal((await periodStarting('2025-01-01')).status, 'IN_REVIEW');
  assert.equal((await periodStarting('2025-02-01')).status, 'IN_REVIEW');
});

// ---------------------------------------------------------------------------
// The cut-off
// ---------------------------------------------------------------------------

test('cut-off: an unpaid absence on the 24th is in this month\'s run; one on the 27th waits for next month', async () => {
  const emp = await makeEmployee('emp_cut', '2024-12-02');

  await tick('2025-03-05');
  const march = await periodStarting('2025-03-01');
  assert.equal(march.status, 'OPEN');

  const before = await unpaidAbsence(emp, '2025-03-24', 'abs_cut_24');
  const after = await unpaidAbsence(emp, '2025-03-27', 'abs_cut_27');

  await tick('2025-03-25');
  assert.equal((await periodStarting('2025-03-01')).status, 'OPEN', 'nothing happens ON the cut-off day');

  const r = await tick('2025-03-26');
  assert.ok(r.generated.some(g => g.periodId === march.id), 'generated on the first tick after the cut-off');
  const marchNow = await periodStarting('2025-03-01');
  assert.equal(marchNow.status, 'IN_REVIEW');
  assert.equal(marchNow.generated_at, at('2025-03-26'));

  const marchLines = await linesFor(march.id, emp);
  assert.deepEqual(marchLines.map(l => l.source_reference), [before],
    'the 24th is inside the cut-off, the 27th is not');

  // April's first tick is after its own cut-off, so it opens and generates at once.
  await tick('2025-04-26');
  const april = await periodStarting('2025-04-01');
  assert.equal(april.status, 'IN_REVIEW');
  const aprilLines = await linesFor(april.id, emp);
  assert.deepEqual(aprilLines.map(l => l.source_reference), [after], 'carried into the next month\'s run');
  assert.equal(aprilLines[0].review_level, 'ROUTINE');
});

// ---------------------------------------------------------------------------
// Generation and classification (May 2025)
// ---------------------------------------------------------------------------

let may;
const E = {};

test('at the cut-off the run is generated, moved to IN_REVIEW, and every line classified', async () => {
  await tick('2025-05-02');
  may = await periodStarting('2025-05-01');

  // Routine leave and absence, plus a derived (so ATTENTION) deficit day.
  E.routine = await makeEmployee('emp_routine', '2024-12-02', { salary: 3000 });
  await unpaidLeave(E.routine, '2025-05-12', '2025-05-12', 1);
  await unpaidAbsence(E.routine, '2025-05-13');
  await seedDeficit(E.routine, 500, '2025-05-19');

  // A starter: every one of their lines needs attention.
  E.starter = await makeEmployee('emp_starter', '2025-05-14');
  await unpaidAbsence(E.starter, '2025-05-15');

  // Four days of unpaid leave: over the 3-day threshold.
  E.big = await makeEmployee('emp_big', '2024-12-02');
  await unpaidLeave(E.big, '2025-05-05', '2025-05-08', 4);

  // A leaver whose last day falls after the cut-off.
  E.leaver = await makeEmployee('emp_leaver', '2024-12-02', { contractEnd: '2025-05-29' });

  const r = await tick('2025-05-26');
  const run = r.generated.find(g => g.periodId === may.id);
  assert.ok(run, 'May was generated');
  assert.equal(run.createdCount, 5);
  assert.equal(run.routineCount, 2);
  assert.equal(run.attentionCount, 3);
  assert.equal((await periodStarting('2025-05-01')).status, 'IN_REVIEW');

  const byType = async emp => Object.fromEntries((await linesFor(may.id, emp)).map(l => [l.adjustment_type, l]));

  const routine = await byType(E.routine);
  assert.equal(routine[PR.UNPAID_LEAVE_DEDUCTION].review_level, 'ROUTINE');
  assert.equal(routine[PR.UNAUTHORISED_ABSENCE_UNPAID].review_level, 'ROUTINE');
  assert.equal(routine[PR.ATTENDANCE_DEFICIT_DAY].review_level, 'ATTENTION');
  assert.ok(JSON.parse(routine[PR.ATTENDANCE_DEFICIT_DAY].review_reasons)
    .includes('Derived from accumulated lateness/early departures'));
  assert.equal(routine[PR.ATTENDANCE_DEFICIT_DAY].calculated_amount, -PR.money(daily(3000)));

  const starter = await byType(E.starter);
  assert.equal(starter[PR.UNAUTHORISED_ABSENCE_UNPAID].review_level, 'ATTENTION');
  assert.match(starter[PR.UNAUTHORISED_ABSENCE_UNPAID].review_reasons, /Starter this period/);

  const big = await byType(E.big);
  assert.equal(big[PR.UNPAID_LEAVE_DEDUCTION].review_level, 'ATTENTION');
  assert.match(big[PR.UNPAID_LEAVE_DEDUCTION].review_reasons, /4 day\(s\) this period, more than 3/);

  // HR is told the run is ready, through the ordinary HR notification feed.
  const note = await db.prepare(
    "SELECT * FROM notifications WHERE category = 'PAYROLL' AND employee_id IS NULL AND title LIKE '%May 2025%'"
  ).all();
  assert.equal(note.length, 1);
  assert.match(note[0].body, /2 routine, 3 needing a decision/);
  assert.equal(note[0].link, `/payroll?period=${may.id}`);
});

test('a line entered by hand is always ATTENTION, and the review sheet flags each employee', async () => {
  const bonus = await PR.proposeAdjustment({
    periodId: may.id, employeeId: 'emp_cut', adjustmentType: 'BONUS',
    calculatedAmount: 100, explanation: 'Covered the open day', actor: 'user:hr',
  });
  const row = await db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(bonus.id);
  assert.equal(row.review_level, 'ATTENTION');
  assert.match(row.review_reasons, /by hand/);

  const sheet = await PR.reviewPeriod(may.id);
  assert.equal(sheet.period.status, 'IN_REVIEW');
  assert.equal(sheet.period.cutoffDate, '2025-05-25');
  assert.equal(sheet.period.payDate, '2025-05-31');
  assert.equal(sheet.totals.employees, 5);
  assert.equal(sheet.totals.routineCount, 2);
  assert.equal(sheet.totals.attentionCount, 4);
  assert.equal(sheet.totals.pendingCount, 6);
  assert.ok(!sheet.preflight.some(c => c.severity === 'BLOCKING'), 'nothing blocks May');

  const flagsOf = id => sheet.employees.find(e => e.employeeId === id).employeeFlags.map(f => f.code);
  assert.deepEqual(flagsOf(E.starter), ['STARTER']);
  assert.deepEqual(flagsOf(E.leaver), ['LEAVER', 'LEAVER_AFTER_CUTOFF']);
  assert.deepEqual(flagsOf(E.routine), []);

  const routineRow = sheet.employees.find(e => e.employeeId === E.routine);
  assert.equal(routineRow.deductionsThrough, '2025-05-25');
  assert.equal(routineRow.expectedNetPayable, PR.money(3000 - 3 * PR.money(daily(3000))));
  assert.ok(routineRow.adjustments.every(a => ['ROUTINE', 'ATTENTION'].includes(a.reviewLevel)));
  assert.ok(routineRow.adjustments.every(a => Array.isArray(a.reviewReasons) && a.reviewReasons.length > 0));
});

// ---------------------------------------------------------------------------
// Approving the run
// ---------------------------------------------------------------------------

test('approve-run refuses while an ATTENTION line is undecided, then publishes payslips from approved lines only', async () => {
  await rejectsWith(PR.approveRun({ periodId: may.id, note: '  ', actor: 'user:hr' }), 'NOTE_REQUIRED');

  let undecided;
  await assert.rejects(
    PR.approveRun({ periodId: may.id, note: 'May payroll', actor: 'user:hr', nowMs: at('2025-05-28') }),
    err => {
      assert.equal(err.code, 'ATTENTION_UNDECIDED');
      undecided = err.details.undecided;
      return true;
    },
  );
  assert.equal(undecided.length, 4, 'the deficit, the starter, the 4-day leave and the hand-entered bonus');

  // Refused means nothing changed - not even the routine lines.
  assert.equal((await periodStarting('2025-05-01')).status, 'IN_REVIEW');
  assert.equal((await payslipsFor(may.id)).length, 0);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) c FROM payroll_adjustments WHERE period_id = ? AND status = 'PROPOSED'"
  ).get(may.id)).c, 6);

  const find = (emp, type) => undecided.find(u => u.employeeId === emp && u.type === type).adjustmentId;
  const r = await PR.approveRun({
    periodId: may.id, note: 'May payroll', actor: 'user:hr', nowMs: at('2025-05-28'),
    decisions: [
      { adjustmentId: find(E.routine, PR.ATTENDANCE_DEFICIT_DAY), decision: 'APPROVED' },
      { adjustmentId: find(E.starter, PR.UNAUTHORISED_ABSENCE_UNPAID), decision: 'REJECTED', notes: 'First week - waived' },
      { adjustmentId: find(E.big, PR.UNPAID_LEAVE_DEDUCTION), decision: 'APPROVED', approvedAmount: -300, notes: 'Reduced by agreement' },
      { adjustmentId: find('emp_cut', 'BONUS'), decision: 'APPROVED' },
    ],
  });
  assert.equal(r.periodStatus, 'PUBLISHED');
  assert.equal(r.payslipCount, 5);
  assert.deepEqual(r.decided, { explicit: 4, routineApproved: 2 });

  const period = await periodStarting('2025-05-01');
  assert.equal(period.status, 'PUBLISHED');
  assert.equal(period.published_by, 'user:hr');
  assert.equal(period.published_at, at('2025-05-28'));

  // The routine lines were approved by the person who approved the run.
  const routineLines = (await linesFor(may.id, E.routine)).filter(l => l.adjustment_type !== PR.ATTENDANCE_DEFICIT_DAY);
  assert.ok(routineLines.every(l => l.status === 'APPROVED' && l.approved_by === 'user:hr'));
  const decided = await db.prepare(
    "SELECT note FROM audit_log WHERE action = 'PAYROLL_ADJUSTMENT_DECIDED' AND note LIKE 'Approved as routine%'"
  ).all();
  assert.equal(decided.length, 2);
  assert.match(decided[0].note, /Approved as routine in the payroll run: May payroll/);
  assert.ok(await db.prepare(
    "SELECT 1 FROM audit_log WHERE action = 'PAYROLL_RUN_APPROVED' AND target_id = ?"
  ).get(may.id));

  // Every payslip's net is its baseline plus its approved lines, and nothing else.
  for (const s of await payslipsFor(may.id)) {
    const approved = (await linesFor(may.id, s.employee_id))
      .filter(l => l.status === 'APPROVED')
      .reduce((sum, l) => sum + l.approved_amount, 0);
    assert.equal(s.net_payable, PR.money(s.gross_baseline + approved), `net for ${s.employee_id}`);
    assert.equal(s.version, 1);
    assert.equal(s.status, 'PUBLISHED');
    assert.match(s.content_hash, /^[0-9a-f]{64}$/);
  }

  const slip = async emp => (await payslipsFor(may.id)).find(s => s.employee_id === emp);
  const routine = await slip(E.routine);
  assert.equal(routine.gross_baseline, 3000);
  assert.equal(routine.net_payable, PR.money(3000 - 3 * PR.money(daily(3000))));
  const lines = JSON.parse(routine.lines_json);
  assert.deepEqual(lines.map(l => [l.label, l.date]).sort(), [
    ['Attendance deficit', '2025-05-25'], ['Unpaid absence', '2025-05-13'], ['Unpaid leave', '2025-05-12'],
  ]);

  const starter = await slip(E.starter);
  assert.equal(starter.is_partial, 1);
  assert.equal(starter.gross_baseline, PR.money(daily(2000) * 13), '13 working days from Wed 14 May');
  assert.equal(starter.net_payable, starter.gross_baseline, 'the rejected absence costs nothing');

  assert.equal((await slip(E.big)).net_payable, 1700, 'the overridden amount, not the calculated one');
  assert.equal((await slip('emp_cut')).net_payable, 2100);
  assert.equal((await slip(E.leaver)).gross_baseline, PR.money(daily(2000) * 21), 'prorated to the last day');

  // Each employee is told, because salaries are visible to employees here.
  const told = await db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE category = 'PAYROLL' AND employee_id = ?"
  ).get(E.routine);
  assert.equal(told.c, 1);
});

test('a second approve-run is refused and writes no duplicate payslips, even when two land at once', async () => {
  await rejectsWith(PR.approveRun({ periodId: may.id, note: 'Again', actor: 'user:hr' }), 'ALREADY_FINAL');
  assert.equal((await payslipsFor(may.id)).length, 5);

  await tick('2025-06-02');
  await tick('2025-06-26');
  const june = await periodStarting('2025-06-01');
  assert.equal(june.status, 'IN_REVIEW');

  const results = await Promise.allSettled([
    PR.approveRun({ periodId: june.id, note: 'June payroll', actor: 'user:hr', nowMs: at('2025-06-28') }),
    PR.approveRun({ periodId: june.id, note: 'June payroll', actor: 'user:hr2', nowMs: at('2025-06-28') }),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1, 'exactly one approval wins');
  const loser = results.find(x => x.status === 'rejected');
  assert.equal(loser.reason.code, 'ALREADY_FINAL');

  const slips = await payslipsFor(june.id);
  // The leaver's contract ended in May, so June has one fewer.
  assert.equal(slips.length, 4);
  assert.equal(new Set(slips.map(s => s.employee_id)).size, 4, 'one payslip per employee');
  assert.ok(!slips.some(s => s.employee_id === E.leaver));
});

test('a published payslip does not change when the salary is changed afterwards', async () => {
  const before = (await payslipsFor(may.id)).find(s => s.employee_id === E.routine);

  // A backdated pay rise reaching back into May.
  await PR.setSalary({ employeeId: E.routine, amount: 5000, effectiveFrom: '2025-05-01', reason: 'Backdated review', actor: 'user:hr' });

  const after = (await payslipsFor(may.id)).find(s => s.employee_id === E.routine);
  assert.deepEqual(after, before);

  const listed = (await PR.listPayslips(may.id)).payslips.find(p => p.employeeId === E.routine);
  assert.equal(listed.integrityOk, true);
  assert.equal(listed.netPayable, PR.money(3000 - 3 * PR.money(daily(3000))));

  const stmts = await PR.employeeStatements(E.routine, { nowMs: at('2025-06-30') });
  const mayStmt = stmts.periods.find(p => p.periodId === may.id);
  assert.equal(mayStmt.monthlyGross, 3000, 'the salary as it was when the payslip was published');
  assert.equal(mayStmt.netPayable, before.net_payable);
});

// ---------------------------------------------------------------------------
// Preflight (July 2025)
// ---------------------------------------------------------------------------

test('the preflight blocks on a pending correction unless waived with a note, and catches deductions that appear after generation', async () => {
  E.corr = await makeEmployee('emp_corr', '2024-12-02', { salary: 2500 });
  await tick('2025-07-02');
  await db.prepare(`
    INSERT INTO attendance_corrections
      (id, employee_id, date_key, requested_by, requested_at, requested_change, reason, status)
    VALUES ('corr_run_1', ?, '2025-07-10', 'employee:emp_corr', ?, '{}', 'Forgot to clock in', 'PENDING')
  `).run(E.corr, at('2025-07-10'));
  await tick('2025-07-26');
  const july = await periodStarting('2025-07-01');
  assert.equal(july.status, 'IN_REVIEW');

  let checks = await PR.payrollPreflight(july.id);
  const pending = checks.find(c => c.code === 'PENDING_CORRECTIONS');
  assert.equal(pending.severity, 'BLOCKING');
  assert.equal(pending.count, 1);
  assert.deepEqual(pending.items[0], {
    employeeId: E.corr, employeeName: 'Run emp_corr', ref: 'corr_run_1', date: '2025-07-10', detail: 'PENDING',
  });

  // HR confirms an absence after the run was generated.
  const late = await unpaidAbsence(E.corr, '2025-07-20');
  checks = await PR.payrollPreflight(july.id);
  const fresh = checks.find(c => c.code === 'NEW_DEDUCTIONS_SINCE_GENERATION');
  assert.equal(fresh.severity, 'BLOCKING');
  assert.equal(fresh.items[0].ref, late);
  assert.equal((await linesFor(july.id, E.corr)).length, 0, 'the preflight is a dry run: it created nothing');

  await assert.rejects(
    PR.approveRun({ periodId: july.id, note: 'July payroll', actor: 'user:hr' }),
    err => {
      assert.equal(err.code, 'PREFLIGHT_BLOCKED');
      assert.deepEqual(err.details.preflight.map(c => c.code).sort(), ['NEW_DEDUCTIONS_SINCE_GENERATION', 'PENDING_CORRECTIONS']);
      return true;
    },
  );

  // Regenerating brings the late absence into this run, as a routine line.
  const regen = await PR.generatePeriodDeductions({ periodId: july.id, actor: 'user:hr' });
  assert.equal(regen.createdCount, 1);
  assert.equal((await linesFor(july.id, E.corr))[0].review_level, 'ROUTINE');
  checks = await PR.payrollPreflight(july.id);
  assert.ok(!checks.some(c => c.code === 'NEW_DEDUCTIONS_SINCE_GENERATION'));

  // The pay rise backdated in the previous test shows on the review sheet.
  const sheet = await PR.reviewPeriod(july.id);
  const rise = sheet.employees.find(e => e.employeeId === E.routine).employeeFlags.find(f => f.code === 'NET_CHANGE_OVER_15_PERCENT');
  assert.ok(rise, 'net pay moved from 3000 in June to 5000');
  assert.equal(rise.previousNet, 3000);

  await rejectsWith(
    PR.approveRun({ periodId: july.id, note: 'July payroll', actor: 'user:hr', waiveBlockers: true }),
    'WAIVER_NOTE_REQUIRED',
  );

  const r = await PR.approveRun({
    periodId: july.id, note: 'July payroll', actor: 'user:hr', nowMs: at('2025-07-28'),
    waiveBlockers: true, waiverNote: 'The correction is for a day already paid in full',
  });
  assert.deepEqual(r.waivedBlockers, ['PENDING_CORRECTIONS']);

  const waived = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'PAYROLL_PREFLIGHT_WAIVED' AND target_id = ?"
  ).get(july.id);
  assert.equal(waived.note, 'The correction is for a day already paid in full');
  assert.equal(waived.actor, 'user:hr');

  const slip = (await payslipsFor(july.id)).find(s => s.employee_id === E.corr);
  assert.equal(slip.net_payable, PR.money(2500 - PR.money(daily(2500))));

  // HR decides the correction, so it stops blocking later months.
  await db.prepare("UPDATE attendance_corrections SET status = 'REJECTED' WHERE id = 'corr_run_1'").run();
});

// ---------------------------------------------------------------------------
// What the employee sees (September 2025)
// ---------------------------------------------------------------------------

let september;

test('employee statements show only published payslips, keep the legacy fields, and carry an estimate', async () => {
  await tick('2025-09-10');
  september = await periodStarting('2025-09-01');
  assert.equal(september.status, 'OPEN');
  // The legacy manual close would end an automatic month with no payslips.
  await assert.rejects(PR.closePeriod({ periodId: september.id, actor: 'user:hr' }), /managed automatically/);
  await unpaidAbsence(E.routine, '2025-09-03');

  // History from before payslips: a closed manual period, computed as always.
  const august = await PR.createPeriod({ name: 'August 2025 (manual)', startDate: '2025-08-01', endDate: '2025-08-31', actor: 'user:hr' });
  await PR.closePeriod({ periodId: august.id, actor: 'user:hr' });

  const stmts = await PR.employeeStatements(E.routine, { nowMs: at('2025-09-10') });
  assert.equal(stmts.enabled, true);

  const july = await periodStarting('2025-07-01');
  const june = await periodStarting('2025-06-01');
  assert.deepEqual(stmts.periods.map(p => p.periodId), [august.id, july.id, june.id, may.id], 'newest first');
  assert.ok(!stmts.periods.some(p => p.periodId === september.id), 'an OPEN period is never shown');

  const m = stmts.periods.find(p => p.periodId === may.id);
  // Every field the current app reads, with the values it expects.
  for (const key of ['periodId', 'name', 'startDate', 'endDate', 'status', 'exchangeRate', 'currency', 'monthlyGross',
    'dailyRate', 'workingDaysCount', 'fullPeriodDays', 'isStarter', 'basePayable', 'adjustmentsTotal', 'netPayable',
    'adjustments', 'effectiveFrom']) {
    assert.ok(key in m, `legacy field ${key}`);
  }
  assert.equal(m.status, 'CLOSED', 'the old app treats CLOSED as final');
  assert.equal(m.name, 'May 2025');
  assert.equal(m.basePayable, 3000);
  assert.equal(m.adjustmentsTotal, PR.money(-3 * PR.money(daily(3000))));
  assert.equal(m.netPayable, PR.money(3000 - 3 * PR.money(daily(3000))));
  assert.equal(m.isStarter, false);
  assert.equal(m.effectiveFrom, '2024-12-02');
  assert.equal(m.adjustments.length, 3);
  for (const a of m.adjustments) {
    assert.deepEqual(Object.keys(a).sort(), ['amount', 'days', 'explanation', 'id', 'type']);
  }
  assert.equal(m.payslipStatus, 'PUBLISHED');
  assert.equal(m.payDate, '2025-05-31');
  assert.equal(m.cutoffDate, '2025-05-25');
  assert.equal(m.publishedAt, at('2025-05-28'));
  assert.equal(m.paidAt, null);
  assert.equal(m.lines.length, 3);

  const aug = stmts.periods.find(p => p.periodId === august.id);
  assert.equal(aug.status, 'CLOSED');
  assert.equal(aug.payslipStatus, null, 'legacy, computed - not a payslip');
  assert.equal(aug.basePayable, 5000);

  assert.deepEqual(stmts.latestPayslip, { periodId: july.id, publishedAt: at('2025-07-28') });

  // Not a single IN_REVIEW month reaches anyone: March and April never did.
  const cut = await PR.employeeStatements('emp_cut', { nowMs: at('2025-09-10') });
  const march = await periodStarting('2025-03-01');
  const april = await periodStarting('2025-04-01');
  assert.ok(!cut.periods.some(p => [march.id, april.id].includes(p.periodId)));

  // The estimate: this month so far, at the calculated figures.
  const est = stmts.estimate;
  assert.equal(est.isEstimate, true);
  assert.equal(est.label, 'Estimate - not final until HR approves');
  assert.equal(est.periodId, september.id);
  assert.equal(est.periodName, 'September 2025');
  assert.equal(est.cutoffDate, '2025-09-25');
  assert.equal(est.payDate, '2025-09-30');
  assert.equal(est.asOf, '2025-09-10');
  assert.equal(est.grossBaseline, 5000);
  assert.deepEqual(est.deductions.map(d => [d.type, d.days, d.amount]), [
    [PR.UNAUTHORISED_ABSENCE_UNPAID, 1, -PR.money(daily(5000))],
  ]);
  assert.equal(est.estimatedNet, PR.money(5000 - PR.money(daily(5000))));
  // 500 minutes seeded in May, one whole day of it already claimed.
  assert.deepEqual(est.deficit, {
    carryForwardMinutes: 20, minutesUntilNextUnpaidDay: 460, wholeDaysSoFar: 0, dayEquivalentMinutes: 480,
  });

  await setSetting('show_payroll_estimate_to_employees', '0');
  assert.equal((await PR.employeeStatements(E.routine, { nowMs: at('2025-09-10') })).estimate, null);
  await setSetting('show_payroll_estimate_to_employees', '1');

  // The phone's cheap "is there a new payslip" check, and the single payslip.
  assert.deepEqual(await PR.latestPayslipFor(E.routine), { periodId: july.id, publishedAt: at('2025-07-28') });
  const one = await PR.employeePayslip(E.routine, may.id);
  assert.equal(one.netPayable, m.netPayable);
  assert.equal(one.lines.length, 3);
  assert.equal(one.integrityOk, true);
  assert.ok(!('publishedBy' in one));
  assert.equal(await PR.employeePayslip(E.routine, september.id), null);

  // With salaries hidden from employees, none of it is shown.
  await setSetting('show_salary_to_employees', '0');
  assert.equal(await PR.latestPayslipFor(E.routine), null);
  assert.equal((await PR.employeeStatements(E.routine)).enabled, false);
  await setSetting('show_salary_to_employees', '1');
});

// ---------------------------------------------------------------------------
// Paying, and what a final period refuses
// ---------------------------------------------------------------------------

test('mark-paid moves PUBLISHED to PAID and stamps the payslips; final periods refuse changes', async () => {
  const before = await payslipsFor(may.id);
  const r = await PR.markPaid({ periodId: may.id, actor: 'user:hr', note: 'Bank batch 0525', nowMs: at('2025-05-31') });
  assert.deepEqual(r, { periodId: may.id, periodStatus: 'PAID', paidAt: at('2025-05-31'), payslipsMarked: 5 });

  const period = await periodStarting('2025-05-01');
  assert.equal(period.status, 'PAID');
  assert.equal(period.paid_at, at('2025-05-31'));

  const after = await payslipsFor(may.id);
  for (const s of after) {
    assert.equal(s.paid_at, at('2025-05-31'));
    const was = before.find(b => b.id === s.id);
    assert.deepEqual({ ...s, paid_at: null }, was, 'nothing but paid_at changed');
  }
  assert.ok((await PR.listPayslips(may.id)).payslips.every(p => p.integrityOk && p.payslipStatus === 'PAID'));

  const stmts = await PR.employeeStatements(E.routine, { nowMs: at('2025-09-10') });
  const m = stmts.periods.find(p => p.periodId === may.id);
  assert.equal(m.payslipStatus, 'PAID');
  assert.equal(m.status, 'CLOSED');
  assert.equal(m.paidAt, at('2025-05-31'));

  assert.equal((await db.prepare(
    "SELECT note FROM audit_log WHERE action = 'PAYROLL_RUN_PAID' AND target_id = ?"
  ).get(may.id)).note, 'Bank batch 0525');

  await rejectsWith(PR.markPaid({ periodId: may.id, actor: 'user:hr' }), 'ALREADY_FINAL');
  await rejectsWith(PR.markPaid({ periodId: september.id, actor: 'user:hr' }), 'NOT_PUBLISHED');

  const june = await periodStarting('2025-06-01');
  await assert.rejects(PR.proposeAdjustment({
    periodId: may.id, employeeId: E.routine, adjustmentType: 'OTHER', calculatedAmount: 1, explanation: 'Too late', actor: 'user:hr',
  }), /paid/);
  await assert.rejects(PR.updatePeriodExchangeRate({ periodId: june.id, exchangeRate: 400, actor: 'user:hr' }), /published/);
  await assert.rejects(PR.generatePeriodDeductions({ periodId: june.id, actor: 'user:hr' }), /published/);
  await assert.rejects(PR.closePeriod({ periodId: june.id, actor: 'user:hr' }), /mark it paid/);
});

test('approving an OPEN period before the cut-off generates it first, then publishes', async () => {
  assert.equal((await periodStarting('2025-09-01')).status, 'OPEN');

  const r = await PR.approveRun({ periodId: september.id, note: 'Early September run', actor: 'user:hr', nowMs: at('2025-09-12') });
  assert.equal(r.periodStatus, 'PUBLISHED');
  assert.equal(r.decided.routineApproved, 1, 'the absence on the 3rd, approved as routine');

  const period = await periodStarting('2025-09-01');
  assert.equal(period.status, 'PUBLISHED');
  assert.equal(period.generated_at, at('2025-09-12'));

  const slip = (await payslipsFor(september.id)).find(s => s.employee_id === E.routine);
  assert.equal(slip.net_payable, PR.money(5000 - PR.money(daily(5000))), 'what the estimate said it would be');

  const stmts = await PR.employeeStatements(E.routine, { nowMs: at('2025-09-12') });
  assert.equal(stmts.latestPayslip.periodId, september.id);
  assert.equal(stmts.estimate, null, 'nothing left to estimate once the month is published');
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('the run endpoints: review, preflight, approve-run, mark-paid and payslips', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/payroll', require('../src/routes/payroll'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/payroll`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_API_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { code: res.status, body: await res.json() };
  };

  try {
    const july = await periodStarting('2025-07-01');
    const june = await periodStarting('2025-06-01');

    const review = await call('GET', `/periods/${may.id}/review`);
    assert.equal(review.code, 200);
    assert.equal(review.body.status, 'SUCCESS');
    assert.equal(review.body.period.status, 'PAID');
    assert.equal(review.body.employees.length, 5);
    assert.ok(review.body.employees.every(e => Array.isArray(e.employeeFlags)));
    assert.ok('routineCount' in review.body.totals && 'attentionCount' in review.body.totals);

    const pre = await call('GET', `/periods/${july.id}/preflight`);
    assert.equal(pre.code, 200);
    assert.equal(pre.body.blocking, false, 'the correction has been decided since');

    const again = await call('POST', `/periods/${may.id}/approve-run`, { note: 'Again' });
    assert.equal(again.code, 409);
    assert.equal(again.body.status, 'ERROR');
    assert.equal(again.body.code, 'ALREADY_FINAL');

    const noNote = await call('POST', `/periods/${may.id}/approve-run`, {});
    assert.equal(noNote.code, 400);
    assert.equal(noNote.body.code, 'NOTE_REQUIRED');

    const paid = await call('POST', `/periods/${june.id}/mark-paid`, { note: 'Bank batch 0625' });
    assert.equal(paid.code, 200);
    assert.equal(paid.body.periodStatus, 'PAID');

    const slips = await call('GET', `/periods/${may.id}/payslips`);
    assert.equal(slips.code, 200);
    assert.equal(slips.body.payslips.length, 5);
    assert.ok(slips.body.payslips.every(p => p.integrityOk));

    const list = await call('GET', '/periods');
    const mayRow = list.body.periods.find(p => p.id === may.id);
    assert.equal(mayRow.cutoffDate, '2025-05-25');
    assert.equal(mayRow.autoCreated, true);
    assert.equal(mayRow.paidAt, at('2025-05-31'));

    const missing = await call('GET', '/periods/pp_nope/review');
    assert.equal(missing.code, 404);
    assert.equal(missing.body.status, 'ERROR');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
