// Attendance engine tests.
//
// Built directly from the worked examples in spec sections 8 and 12 and the
// acceptance tests in section 34, so the numbers here are the organisation's
// own, not invented for the test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `office-att-test-${process.pid}.db`);
process.env.DB_FILE = TMP;
process.env.ADMIN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.OFFICE_CONFIG_FILE = require('path').join(__dirname, 'fixtures', 'office.test.json');

const { db } = require('../src/db');
const A = require('../src/domain/attendance');
const P = require('../src/domain/presence');
const schedule = require('../src/domain/schedule');
const T = require('../src/util/time');

const MIN = 60 * 1000;
const OFFICE_IP = '192.168.18.59';

// A Wednesday, so it is a working day under mon-fri.
const DAY = '2026-08-26';
const at = (hhmm) => T.wallClockToEpoch(DAY, hhmm);

function makeEmployee(id) {
  db.prepare(
    'INSERT OR REPLACE INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?)'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

/** Continuous presence between two wall-clock times. */
function present(employeeId, fromHHMM, toHHMM, stepMin = 5) {
  const from = at(fromHHMM);
  const to = at(toHHMM);
  for (let t = from; t <= to; t += stepMin * MIN) {
    P.recordEvent({ employeeId, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
  }
  // The step will usually not land exactly on the end time, and the last
  // sighting is what early-departure is measured from.
  P.recordEvent({ employeeId, source: 'APP', srcIp: OFFICE_IP, observedAt: to });
}

test.after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test('the confirmed schedule is 11:00-19:00 with 10 minutes grace', () => {
  const emp = makeEmployee('emp_sched');
  const s = schedule.resolve(emp, DAY);

  assert.equal(s.isWorkingDay, true);
  assert.equal(s.startTime, '11:00');
  assert.equal(s.endTime, '19:00');
  assert.equal(s.permittedBreakMinutes, 30);
  assert.equal(s.dayEquivalentMinutes, 480);
  assert.equal(s.graceMinutes, 10);
  // 11:10 is the last on-time minute, so 11:11 is late.
  assert.equal(s.latestOnTimeAt, at('11:10'));
});

test('a weekend is not a working day', () => {
  const emp = makeEmployee('emp_weekend');
  const saturday = schedule.resolve(emp, '2026-08-29');
  assert.equal(saturday.isWorkingDay, false);
  assert.equal(saturday.nonWorkingReason, 'Rest day');
});

// ---------------------------------------------------------------------------
// Lateness (spec 34: "Employee clocks in before 11:00 -> no late occurrence")
// ---------------------------------------------------------------------------

test('arriving before the start time is not late', () => {
  const emp = makeEmployee('emp_early');
  present(emp, '10:55', '19:00');
  const d = A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.isLateOccurrence, false);
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.attendanceStatus, 'PRESENT');
});

// The distinction that matters most in this engine.
test('inside the grace period is deficit minutes but NOT a late occurrence', () => {
  const emp = makeEmployee('emp_grace');
  present(emp, '11:08', '19:00');
  const d = A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.isLateOccurrence, false, '11:08 is within the 10 minute grace');
  assert.equal(d.lateMinutes, 8, 'but late minutes still run from 11:00');
  assert.equal(d.dailyDeficitMinutes, 8);
});

test('11:10 is on time and 11:11 is late', () => {
  const onTime = makeEmployee('emp_1110');
  present(onTime, '11:10', '19:00');
  assert.equal(A.deriveDay(onTime, DAY, at('19:30')).isLateOccurrence, false);

  const late = makeEmployee('emp_1111');
  present(late, '11:11', '19:00');
  const d = A.deriveDay(late, DAY, at('19:30'));
  assert.equal(d.isLateOccurrence, true);
  assert.equal(d.lateMinutes, 11);
  assert.equal(d.attendanceStatus, 'LATE');
});

// ---------------------------------------------------------------------------
// Breaks (spec 34: "exactly 30 minutes -> no deficit", "41 minutes -> 11")
// ---------------------------------------------------------------------------

test('a break of exactly the permitted length costs nothing', () => {
  const emp = makeEmployee('emp_break30');
  present(emp, '11:00', '19:00');

  A.startBreak(emp, at('14:00'));
  const r = A.endBreak(emp, at('14:30'));

  assert.equal(r.actualMinutes, 30);
  assert.equal(r.excessMinutes, 0);
  assert.equal(A.deriveDay(emp, DAY, at('19:30')).excessBreakMinutes, 0);
});

test('a 41 minute break is an 11 minute deficit', () => {
  const emp = makeEmployee('emp_break41');
  present(emp, '11:00', '19:00');

  A.startBreak(emp, at('14:00'));
  const r = A.endBreak(emp, at('14:41'));

  assert.equal(r.actualMinutes, 41);
  assert.equal(r.excessMinutes, 11, 'only the excess enters the ledger');
  assert.equal(A.deriveDay(emp, DAY, at('19:30')).excessBreakMinutes, 11);
});

test('finishing a break early earns nothing back', () => {
  const emp = makeEmployee('emp_break20');
  present(emp, '11:00', '19:00');
  A.startBreak(emp, at('14:00'));
  const r = A.endBreak(emp, at('14:20'));

  assert.equal(r.actualMinutes, 20);
  assert.equal(r.excessMinutes, 0, 'excess floors at zero, it never goes negative');
});

test('two breaks cannot run at once', () => {
  const emp = makeEmployee('emp_dblbreak');
  A.startBreak(emp, at('14:00'));
  const second = A.startBreak(emp, at('14:05'));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ALREADY_ON_BREAK');
  A.endBreak(emp, at('14:30'));
});

test('ending a break that was never started is refused', () => {
  const emp = makeEmployee('emp_nobreak');
  const r = A.endBreak(emp, at('14:00'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_ON_BREAK');
});

// ---------------------------------------------------------------------------
// The full worked example from spec 8.1
// ---------------------------------------------------------------------------

// Arrival 11:17 (17 late), break 42 minutes (12 excess), clock-out 18:53
// (7 early) = 36 attendance-deficit minutes.
test('the spec 8.1 worked example produces 36 deficit minutes', () => {
  const emp = makeEmployee('emp_worked');
  // Present 11:17-14:00, break, back 14:42 until 18:53.
  present(emp, '11:17', '14:00');
  present(emp, '14:42', '18:53');

  A.startBreak(emp, at('14:00'));
  A.endBreak(emp, at('14:42'));

  const d = A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.lateMinutes, 17, 'arrived 11:17 against an 11:00 start');
  assert.equal(d.excessBreakMinutes, 12, '42 minute break against 30 permitted');
  assert.equal(d.earlyDepartureMinutes, 7, 'left 18:53 against a 19:00 finish');
  assert.equal(d.unauthorisedMissingMinutes, 0, 'the gap was a declared break');
  assert.equal(d.dailyDeficitMinutes, 36, '17 + 12 + 7 = 36');

  // And it IS a late occurrence, since 11:17 is past the 11:10 grace.
  assert.equal(d.isLateOccurrence, true);
});

test('an undeclared gap is unauthorised missing time, not a free break', () => {
  const emp = makeEmployee('emp_gap');
  present(emp, '11:00', '14:00');
  present(emp, '15:00', '19:00');   // an hour away, nothing declared

  const d = A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.excessBreakMinutes, 0, 'no break was declared');
  assert.ok(d.unauthorisedMissingMinutes >= 55,
    `expected roughly an hour missing, got ${d.unauthorisedMissingMinutes}`);
  assert.ok(d.needsReview.some(r => /no declared break/.test(r)));
});

// ---------------------------------------------------------------------------
// Deficit ledger (spec 8.2, 8.3, and the section 34 acceptance tests)
// ---------------------------------------------------------------------------

test('479 minutes is 0 whole-day equivalents, 480 is 1', () => {
  const emp = makeEmployee('emp_479');
  A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 479, reason: 'test', actor: 'test' });

  let b = A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 479);
  assert.equal(b.wholeDayEquivalents, 0);
  assert.equal(b.carryForwardMinutes, 479);

  A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 1, reason: 'test', actor: 'test' });
  b = A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 480);
  assert.equal(b.wholeDayEquivalents, 1);
  assert.equal(b.carryForwardMinutes, 0);
});

// Spec 8.3 states this example explicitly.
test('527 minutes is 1 whole day plus 47 carried forward', () => {
  const emp = makeEmployee('emp_527');
  A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 527, reason: 'test', actor: 'test' });

  const b = A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 527);
  assert.equal(b.wholeDayEquivalents, 1);
  assert.equal(b.carryForwardMinutes, 47, 'both values are kept, this is not 1.1 days');
});

test('crossing a whole-day equivalent is flagged for HR, not acted on', () => {
  const emp = makeEmployee('emp_cross');
  A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 470, reason: 'seed', actor: 'test' });

  const below = A.postDeficit(emp, '2026-08-27', 5, T.now());
  assert.equal(below.crossedThreshold, false);

  const across = A.postDeficit(emp, '2026-08-28', 10, T.now());
  assert.equal(across.crossedThreshold, true, 'HR must be told when 480 is reached');

  // Spec 8.3: the platform must not silently alter salary, leave or discipline.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM formal_warnings').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM leave_accrual_ledger').get().c, 0);
});

test('recomputing a day adjusts the balance rather than double-counting', () => {
  const emp = makeEmployee('emp_recompute');
  A.postDeficit(emp, DAY, 30, T.now());
  assert.equal(A.balanceFor(emp).balanceMinutes, 30);

  // The same day recalculated at a lower figure, e.g. after a correction.
  A.postDeficit(emp, DAY, 10, T.now());
  assert.equal(A.balanceFor(emp).balanceMinutes, 10,
    'a correction must restate the day, not add to it');

  const entries = db.prepare(
    "SELECT entry_type FROM attendance_deficit_ledger WHERE employee_id = ?"
  ).all(emp).map(r => r.entry_type);
  assert.deepEqual(entries, ['DAILY_DEFICIT', 'CORRECTION'], 'the original entry is preserved');
});

test('an HR adjustment requires a reason', () => {
  const emp = makeEmployee('emp_noreason');
  assert.throws(
    () => A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: -60, actor: 'hr' }),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// Lateness occurrences (spec 9.1, 9.2)
// ---------------------------------------------------------------------------

test('the monitoring period is the calendar month, as confirmed', () => {
  const w = A.monitoringPeriod('2026-08-26');
  assert.equal(w.period, 'CALENDAR_MONTH');
  assert.equal(w.from, '2026-08-01');
  assert.equal(w.to, '2026-08-31');
});

test('lateness counts occurrences and reports the remaining allowance', () => {
  const emp = makeEmployee('emp_late_count');

  // Three late days, all inside August.
  for (const [day, arrival] of [['2026-08-03', '11:20'], ['2026-08-04', '11:30'], ['2026-08-05', '11:15']]) {
    for (let t = T.wallClockToEpoch(day, arrival); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  const status = A.latenessStatus(emp, '2026-08-26');
  assert.equal(status.resolved, true);
  assert.equal(status.count, 3);
  assert.equal(status.allowed, 3);
  assert.equal(status.remaining, 0);
  assert.equal(status.thresholdReached, false, 'the 4th triggers, not the 3rd');
  assert.equal(status.level, 'AT_LIMIT');
  assert.match(status.message, /If you are late again/);
});

test('the fourth late occurrence reaches the threshold', () => {
  const emp = makeEmployee('emp_late_4');

  for (const day of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']) {
    for (let t = T.wallClockToEpoch(day, '11:25'); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  const status = A.latenessStatus(emp, '2026-08-26');
  assert.equal(status.count, 4);
  assert.equal(status.thresholdReached, true);
  assert.equal(status.level, 'THRESHOLD_REACHED');
  assert.match(status.message, /referred to HR/);

  // Spec 9.3: the trigger is a referral. No formal warning exists yet.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM formal_warnings').get().c, 0);
});

test('lateness in a previous month does not count against this one', () => {
  const emp = makeEmployee('emp_late_prev');
  for (const day of ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']) {
    for (let t = T.wallClockToEpoch(day, '11:30'); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  assert.equal(A.latenessStatus(emp, '2026-07-20').count, 4, 'four in July');
  const august = A.latenessStatus(emp, '2026-08-26');
  assert.equal(august.count, 0, 'the count resets on the 1st');
  assert.equal(august.thresholdReached, false);
});

test('an unconfigured monitoring period refuses to evaluate', () => {
  const original = require('../src/config').config.latenessMonitoringPeriod;
  require('../src/config').config.latenessMonitoringPeriod = 'UNSET';
  try {
    const status = A.latenessStatus(makeEmployee('emp_unset'), DAY);
    assert.equal(status.resolved, false);
    assert.match(status.message, /cannot be evaluated/i);
  } finally {
    require('../src/config').config.latenessMonitoringPeriod = original;
  }
});

// ---------------------------------------------------------------------------
// Non-working days
// ---------------------------------------------------------------------------

test('a paid office closure produces no deficit', () => {
  const emp = makeEmployee('emp_holiday');
  db.prepare(
    'INSERT OR REPLACE INTO office_locations (id, name, time_zone, active, created_at) VALUES (?,?,?,1,?)'
  ).run('off_pk', 'Pakistan Office', 'Asia/Karachi', T.now());
  db.prepare('UPDATE employees SET office_id = ? WHERE id = ?').run('off_pk', emp);
  db.prepare(`
    INSERT OR REPLACE INTO calendar_days (id, office_id, date, day_type, name, is_paid, created_at)
    VALUES (?,?,?,?,?,1,?)
  `).run('cal_eid', 'off_pk', DAY, 'PUBLIC_HOLIDAY', 'Eid holiday', T.now());

  const d = A.deriveDay(emp, DAY, at('19:30'));
  assert.equal(d.isWorkingDay, false);
  assert.equal(d.attendanceStatus, 'NON_WORKING_DAY');
  assert.equal(d.dailyDeficitMinutes, 0, 'nobody is late for a day the office is shut');
  assert.equal(d.nonWorkingReason, 'Eid holiday');
});

test('no attendance on a working day is not called unauthorised by this engine', () => {
  const emp = makeEmployee('emp_absent');
  // The next morning, so the day has genuinely ended.
  const d = A.deriveDay(emp, DAY, T.wallClockToEpoch('2026-08-27', '09:00'));

  // Deciding it is unauthorised means first checking approved leave, which is
  // the absence engine's job. Spec 10.1.
  assert.equal(d.attendanceStatus, 'NO_ATTENDANCE_RECORDED');
  assert.notEqual(d.attendanceStatus, 'ABSENT_UNAUTHORISED');
  assert.equal(d.dailyDeficitMinutes, 0);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('the stored summary matches a fresh derivation', () => {
  const emp = makeEmployee('emp_persist');
  present(emp, '11:17', '18:53');
  A.startBreak(emp, at('14:00'));
  A.endBreak(emp, at('14:42'));

  const derived = A.recomputeDay(emp, DAY, at('19:30'));
  const row = db.prepare(
    'SELECT * FROM attendance_daily_summary WHERE employee_id = ? AND date_key = ?'
  ).get(emp, DAY);

  assert.equal(row.late_minutes, derived.lateMinutes);
  assert.equal(row.excess_break_minutes, derived.excessBreakMinutes);
  assert.equal(row.early_departure_minutes, derived.earlyDepartureMinutes);
  assert.equal(row.daily_deficit_minutes, derived.dailyDeficitMinutes);
  assert.equal(row.is_late_occurrence, derived.isLateOccurrence ? 1 : 0);
});

test('the presented shape breaks the deficit into its four components', () => {
  const emp = makeEmployee('emp_present');
  present(emp, '11:17', '18:53');
  A.startBreak(emp, at('14:00'));
  A.endBreak(emp, at('14:42'));

  const view = A.present(A.deriveDay(emp, DAY, at('19:30')));
  assert.equal(view.deficit.lateMinutes, 17);
  assert.equal(view.deficit.excessBreakMinutes, 12);
  assert.equal(view.deficit.earlyDepartureMinutes, 7);
  assert.equal(view.deficit.totalMinutes, 36);
  assert.equal(view.scheduledStart, '11:00');
  assert.equal(view.status, 'LATE');
});
