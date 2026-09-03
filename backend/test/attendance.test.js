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

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('attendance');

test.before(prepareDatabase);


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

async function makeEmployee(id) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

/** Continuous presence between two wall-clock times. */
async function present(employeeId, fromHHMM, toHHMM, stepMin = 5) {
  const from = at(fromHHMM);
  const to = at(toHHMM);
  for (let t = from; t <= to; t += stepMin * MIN) {
    await P.recordEvent({ employeeId, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
  }
  // The step will usually not land exactly on the end time, and the last
  // sighting is what early-departure is measured from.
  await P.recordEvent({ employeeId, source: 'APP', srcIp: OFFICE_IP, observedAt: to });
}

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test('the confirmed schedule is 11:00-19:00 with 10 minutes grace', async () => {
  const emp = await makeEmployee('emp_sched');
  const s = await schedule.resolve(emp, DAY);

  assert.equal(s.isWorkingDay, true);
  assert.equal(s.startTime, '11:00');
  assert.equal(s.endTime, '19:00');
  assert.equal(s.permittedBreakMinutes, 30);
  assert.equal(s.dayEquivalentMinutes, 480);
  assert.equal(s.graceMinutes, 10);
  // 11:10:59 is the last on-time instant, so 11:11 is late.
  assert.equal(s.latestOnTimeAt, at('11:10') + 59999);
});

test('a weekend is not a working day', async () => {
  const emp = await makeEmployee('emp_weekend');
  const saturday = await schedule.resolve(emp, '2026-08-29');
  assert.equal(saturday.isWorkingDay, false);
  assert.equal(saturday.nonWorkingReason, 'Rest day');
});

// ---------------------------------------------------------------------------
// Lateness (spec 34: "Employee clocks in before 11:00 -> no late occurrence")
// ---------------------------------------------------------------------------

test('arriving before the start time is not late', async () => {
  const emp = await makeEmployee('emp_early');
  await present(emp, '10:55', '19:00');
  const d = await A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.isLateOccurrence, false);
  assert.equal(d.lateMinutes, 0);
  assert.equal(d.attendanceStatus, 'PRESENT');
});

test('inside the 10-minute grace period has 0 late minutes and is NOT a late occurrence', async () => {
  const emp = await makeEmployee('emp_grace');
  await present(emp, '11:08', '19:00');
  const d = await A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.isLateOccurrence, false, '11:08 is within the 10 minute grace');
  assert.equal(d.lateMinutes, 0, '11:08 is within 10m grace so 0 late minutes');
  assert.equal(d.dailyDeficitMinutes, 0, '0 deficit inside grace period');
});

test('11:10 is on time and 11:11 is late', async () => {
  const onTime = await makeEmployee('emp_1110');
  await present(onTime, '11:10', '19:00');
  assert.equal(await (await A.deriveDay(onTime, DAY, at('19:30'))).isLateOccurrence, false);

  const late = await makeEmployee('emp_1111');
  await present(late, '11:11', '19:00');
  const d = await A.deriveDay(late, DAY, at('19:30'));
  assert.equal(d.isLateOccurrence, true);
  assert.equal(d.lateMinutes, 1);
  assert.equal(d.attendanceStatus, 'LATE');
});

// ---------------------------------------------------------------------------
// Breaks (spec 34: "exactly 30 minutes -> no deficit", "41 minutes -> 11")
// ---------------------------------------------------------------------------

test('a break of exactly the permitted length costs nothing', async () => {
  const emp = await makeEmployee('emp_break30');
  await present(emp, '11:00', '19:00');

  await A.startBreak(emp, at('14:00'));
  const r = await A.endBreak(emp, at('14:30'));

  assert.equal(r.actualMinutes, 30);
  assert.equal(r.excessMinutes, 0);
  assert.equal(await (await A.deriveDay(emp, DAY, at('19:30'))).excessBreakMinutes, 0);
});

test('a 41 minute break is an 11 minute deficit', async () => {
  const emp = await makeEmployee('emp_break41');
  await present(emp, '11:00', '19:00');

  await A.startBreak(emp, at('14:00'));
  const r = await A.endBreak(emp, at('14:41'));

  assert.equal(r.actualMinutes, 41);
  assert.equal(r.excessMinutes, 11, 'only the excess enters the ledger');
  assert.equal(await (await A.deriveDay(emp, DAY, at('19:30'))).excessBreakMinutes, 11);
});

test('finishing a break early earns nothing back', async () => {
  const emp = await makeEmployee('emp_break20');
  await present(emp, '11:00', '19:00');
  await A.startBreak(emp, at('14:00'));
  const r = await A.endBreak(emp, at('14:20'));

  assert.equal(r.actualMinutes, 20);
  assert.equal(r.excessMinutes, 0, 'excess floors at zero, it never goes negative');
});

test('two breaks cannot run at once', async () => {
  const emp = await makeEmployee('emp_dblbreak');
  await A.startBreak(emp, at('14:00'));
  const second = await A.startBreak(emp, at('14:05'));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ALREADY_ON_BREAK');
  await A.endBreak(emp, at('14:30'));
});

test('ending a break that was never started is refused', async () => {
  const emp = await makeEmployee('emp_nobreak');
  const r = await A.endBreak(emp, at('14:00'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_ON_BREAK');
});

// ---------------------------------------------------------------------------
// The full worked example from spec 8.1
// ---------------------------------------------------------------------------

// Arrival 11:17 (17 late), break 42 minutes (12 excess), clock-out 18:53
// (7 early) = 36 attendance-deficit minutes.
test('the spec 8.1 worked example produces 36 deficit minutes', async () => {
  const emp = await makeEmployee('emp_worked');
  // Present 11:17-14:00, break, back 14:42 until 18:53.
  await present(emp, '11:17', '14:00');
  await present(emp, '14:42', '18:53');

  await A.startBreak(emp, at('14:00'));
  await A.endBreak(emp, at('14:42'));

  const d = await A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.lateMinutes, 7, 'arrived 11:17 with 10m grace period');
  assert.equal(d.excessBreakMinutes, 12, '42 minute break against 30 permitted');
  assert.equal(d.earlyDepartureMinutes, 7, 'left 18:53 against a 19:00 finish');
  assert.equal(d.unauthorisedMissingMinutes, 0, 'the gap was a declared break');
  assert.equal(d.dailyDeficitMinutes, 26, '7 + 12 + 7 = 26');

  // And it IS a late occurrence, since 11:17 is past the 11:10 grace.
  assert.equal(d.isLateOccurrence, true);
});

test('an undeclared gap is unauthorised missing time, not a free break', async () => {
  const emp = await makeEmployee('emp_gap');
  await present(emp, '11:00', '14:00');
  await present(emp, '15:00', '19:00');   // an hour away, nothing declared

  const d = await A.deriveDay(emp, DAY, at('19:30'));

  assert.equal(d.excessBreakMinutes, 0, 'no break was declared');
  assert.ok(d.unauthorisedMissingMinutes >= 55,
    `expected roughly an hour missing, got ${d.unauthorisedMissingMinutes}`);
  assert.ok(d.needsReview.some(r => /no declared break/.test(r)));
});

// ---------------------------------------------------------------------------
// Deficit ledger (spec 8.2, 8.3, and the section 34 acceptance tests)
// ---------------------------------------------------------------------------

test('479 minutes is 0 whole-day equivalents, 480 is 1', async () => {
  const emp = await makeEmployee('emp_479');
  await A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 479, reason: 'test', actor: 'test' });

  let b = await A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 479);
  assert.equal(b.wholeDayEquivalents, 0);
  assert.equal(b.carryForwardMinutes, 479);

  await A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 1, reason: 'test', actor: 'test' });
  b = await A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 480);
  assert.equal(b.wholeDayEquivalents, 1);
  assert.equal(b.carryForwardMinutes, 0);
});

// Spec 8.3 states this example explicitly.
test('527 minutes is 1 whole day plus 47 carried forward', async () => {
  const emp = await makeEmployee('emp_527');
  await A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 527, reason: 'test', actor: 'test' });

  const b = await A.balanceFor(emp);
  assert.equal(b.balanceMinutes, 527);
  assert.equal(b.wholeDayEquivalents, 1);
  assert.equal(b.carryForwardMinutes, 47, 'both values are kept, this is not 1.1 days');
});

test('crossing a whole-day equivalent is flagged for HR, not acted on', async () => {
  const emp = await makeEmployee('emp_cross');
  await A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: 470, reason: 'seed', actor: 'test' });

  const below = await A.postDeficit(emp, '2026-08-27', 5, T.now());
  assert.equal(below.crossedThreshold, false);

  const across = await A.postDeficit(emp, '2026-08-28', 10, T.now());
  assert.equal(across.crossedThreshold, true, 'HR must be told when 480 is reached');

  // Spec 8.3: the platform must not silently alter salary, leave or discipline.
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM formal_warnings').get()).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM leave_accrual_ledger').get()).c, 0);
});

test('recomputing a day adjusts the balance rather than double-counting', async () => {
  const emp = await makeEmployee('emp_recompute');
  await A.postDeficit(emp, DAY, 30, T.now());
  assert.equal(await (await A.balanceFor(emp)).balanceMinutes, 30);

  // The same day recalculated at a lower figure, e.g. after a correction.
  await A.postDeficit(emp, DAY, 10, T.now());
  assert.equal(await (await A.balanceFor(emp)).balanceMinutes, 10,
    'a correction must restate the day, not add to it');

  const entries = (await db.prepare(
    "SELECT entry_type FROM attendance_deficit_ledger WHERE employee_id = ?"
  ).all(emp)).map(r => r.entry_type);
  assert.deepEqual(entries, ['DAILY_DEFICIT', 'CORRECTION'], 'the original entry is preserved');
});

test('an HR adjustment requires a reason', async () => {
  const emp = await makeEmployee('emp_noreason');
  await assert.rejects(
    async () => await A.adjustBalance({ employeeId: emp, dateKey: DAY, minutes: -60, actor: 'hr' }),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// Lateness occurrences (spec 9.1, 9.2)
// ---------------------------------------------------------------------------

test('the monitoring period is the calendar month, as confirmed', async () => {
  const w = A.monitoringPeriod('2026-08-26');
  assert.equal(w.period, 'CALENDAR_MONTH');
  assert.equal(w.from, '2026-08-01');
  assert.equal(w.to, '2026-08-31');
});

test('lateness counts occurrences and reports the remaining allowance', async () => {
  const emp = await makeEmployee('emp_late_count');

  // Three late days, all inside August.
  for (const [day, arrival] of [['2026-08-03', '11:20'], ['2026-08-04', '11:30'], ['2026-08-05', '11:15']]) {
    for (let t = T.wallClockToEpoch(day, arrival); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    await A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  const status = await A.latenessStatus(emp, '2026-08-26');
  assert.equal(status.resolved, true);
  assert.equal(status.count, 3);
  assert.equal(status.allowed, 3);
  assert.equal(status.remaining, 0);
  assert.equal(status.thresholdReached, false, 'the 4th triggers, not the 3rd');
  assert.equal(status.level, 'AT_LIMIT');
  assert.match(status.message, /If you are late again/);
});

test('the fourth late occurrence reaches the threshold', async () => {
  const emp = await makeEmployee('emp_late_4');

  for (const day of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']) {
    for (let t = T.wallClockToEpoch(day, '11:25'); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    await A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  const status = await A.latenessStatus(emp, '2026-08-26');
  assert.equal(status.count, 4);
  assert.equal(status.thresholdReached, true);
  assert.equal(status.level, 'THRESHOLD_REACHED');
  assert.match(status.message, /referred to HR/);

  // Spec 9.3: the trigger is a referral. No formal warning exists yet.
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM formal_warnings').get()).c, 0);
});

test('lateness in a previous month does not count against this one', async () => {
  const emp = await makeEmployee('emp_late_prev');
  for (const day of ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']) {
    for (let t = T.wallClockToEpoch(day, '11:30'); t <= T.wallClockToEpoch(day, '19:00'); t += 30 * MIN) {
      await P.recordEvent({ employeeId: emp, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
    }
    await A.recomputeDay(emp, day, T.wallClockToEpoch(day, '23:59'));
  }

  assert.equal(await (await A.latenessStatus(emp, '2026-07-20')).count, 4, 'four in July');
  const august = await A.latenessStatus(emp, '2026-08-26');
  assert.equal(august.count, 0, 'the count resets on the 1st');
  assert.equal(august.thresholdReached, false);
});

test('an unconfigured monitoring period refuses to evaluate', async () => {
  const original = require('../src/config').config.latenessMonitoringPeriod;
  require('../src/config').config.latenessMonitoringPeriod = 'UNSET';
  try {
    const status = await A.latenessStatus(await makeEmployee('emp_unset'), DAY);
    assert.equal(status.resolved, false);
    assert.match(status.message, /cannot be evaluated/i);
  } finally {
    require('../src/config').config.latenessMonitoringPeriod = original;


  }
});

// ---------------------------------------------------------------------------
// Non-working days
// ---------------------------------------------------------------------------

test('a paid office closure produces no deficit', async () => {
  const emp = await makeEmployee('emp_holiday');
  await db.prepare(
    'INSERT INTO office_locations (id, name, time_zone, active, created_at) VALUES (?,?,?,1,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, time_zone = EXCLUDED.time_zone, active = EXCLUDED.active, created_at = EXCLUDED.created_at'
  ).run('off_pk', 'Pakistan Office', 'Asia/Karachi', T.now());
  await db.prepare('UPDATE employees SET office_id = ? WHERE id = ?').run('off_pk', emp);
  await db.prepare(`
    INSERT INTO calendar_days (id, office_id, date, day_type, name, is_paid, created_at)
    VALUES (?,?,?,?,?,1,?) ON CONFLICT (id) DO UPDATE SET office_id = EXCLUDED.office_id, date = EXCLUDED.date, day_type = EXCLUDED.day_type, name = EXCLUDED.name, is_paid = EXCLUDED.is_paid, created_at = EXCLUDED.created_at
  `).run('cal_eid', 'off_pk', DAY, 'PUBLIC_HOLIDAY', 'Eid holiday', T.now());

  const d = await A.deriveDay(emp, DAY, at('19:30'));
  assert.equal(d.isWorkingDay, false);
  assert.equal(d.attendanceStatus, 'NON_WORKING_DAY');
  assert.equal(d.dailyDeficitMinutes, 0, 'nobody is late for a day the office is shut');
  assert.equal(d.nonWorkingReason, 'Eid holiday');
});

test('no attendance on a working day is not called unauthorised by this engine', async () => {
  const emp = await makeEmployee('emp_absent');
  // The next morning, so the day has genuinely ended.
  const d = await A.deriveDay(emp, DAY, T.wallClockToEpoch('2026-08-27', '09:00'));

  // Deciding it is unauthorised means first checking approved leave, which is
  // the absence engine's job. Spec 10.1.
  assert.equal(d.attendanceStatus, 'NO_ATTENDANCE_RECORDED');
  assert.notEqual(d.attendanceStatus, 'ABSENT_UNAUTHORISED');
  assert.equal(d.dailyDeficitMinutes, 0);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('the stored summary matches a fresh derivation', async () => {
  const emp = await makeEmployee('emp_persist');
  await present(emp, '11:17', '18:53');
  await A.startBreak(emp, at('14:00'));
  await A.endBreak(emp, at('14:42'));

  const derived = await A.recomputeDay(emp, DAY, at('19:30'));
  const row = await db.prepare(
    'SELECT * FROM attendance_daily_summary WHERE employee_id = ? AND date_key = ?'
  ).get(emp, DAY);

  assert.equal(row.late_minutes, derived.lateMinutes);
  assert.equal(row.excess_break_minutes, derived.excessBreakMinutes);
  assert.equal(row.early_departure_minutes, derived.earlyDepartureMinutes);
  assert.equal(row.daily_deficit_minutes, derived.dailyDeficitMinutes);
  assert.equal(row.is_late_occurrence, derived.isLateOccurrence ? 1 : 0);
});

test('the presented shape breaks the deficit into its four components', async () => {
  const emp = await makeEmployee('emp_present');
  await present(emp, '11:17', '18:53');
  await A.startBreak(emp, at('14:00'));
  await A.endBreak(emp, at('14:42'));

  const view = A.present(await A.deriveDay(emp, DAY, at('19:30')));
  assert.equal(view.deficit.lateMinutes, 7);
  assert.equal(view.deficit.excessBreakMinutes, 12);
  assert.equal(view.deficit.earlyDepartureMinutes, 7);
  assert.equal(view.deficit.totalMinutes, 26);
  assert.equal(view.scheduledStart, '11:00');
  assert.equal(view.status, 'LATE');
});

// ---------------------------------------------------------------------------
// Late Arrival Recovery by Staying Later
// ---------------------------------------------------------------------------

test('arriving at 11:10 and staying until 7:10 PM covers the arrival with no shortage in total hours', async () => {
  const emp = await makeEmployee('emp_rec_1110');
  await present(emp, '11:10', '19:10');

  const d = await A.deriveDay(emp, DAY, at('19:30'));
  assert.equal(d.lateMinutes, 0, '11:10 is within 10m grace period');
  assert.equal(d.recoveredLateMinutes, 0);
  assert.equal(d.netLateMinutes, 0);
  assert.equal(d.dailyDeficitMinutes, 0, 'no deficit');
  assert.equal(d.isLateOccurrence, false, 'not late');
  assert.equal(d.workedMinutes, 480, 'worked full 480 minutes (8 hours)');
});

test('arriving at 11:20 and staying until 7:20 PM fully recovers 10m lateness (0 deficit, status RECOVERED)', async () => {
  const emp = await makeEmployee('emp_rec_1120_full');
  await present(emp, '11:20', '19:20');

  const d = await A.deriveDay(emp, DAY, at('19:40'));
  assert.equal(d.lateMinutes, 10, '10 minutes beyond 10m grace');
  assert.equal(d.overtimeMinutes, 20, '20 minutes worked past 19:00');
  assert.equal(d.recoveredLateMinutes, 10, 'recovers the full 10 late minutes');
  assert.equal(d.netLateMinutes, 0, '0 net late minutes remaining');
  assert.equal(d.dailyDeficitMinutes, 0, '0 deficit after recovery');
  assert.equal(d.isLateOccurrence, false, 'cleared late occurrence upon full recovery');
  assert.equal(d.attendanceStatus, 'RECOVERED');
  assert.equal(d.workedMinutes, 480, 'worked full 480 minutes (8 hours)');
});

test('arriving at 11:20 and staying until 7:05 PM partially recovers lateness (5m deficit remaining)', async () => {
  const emp = await makeEmployee('emp_rec_1120_part');
  await present(emp, '11:20', '19:05');

  const d = await A.deriveDay(emp, DAY, at('19:30'));
  assert.equal(d.lateMinutes, 10, '10 minutes beyond 10m grace');
  assert.equal(d.overtimeMinutes, 5, '5 minutes past 19:00');
  assert.equal(d.recoveredLateMinutes, 5, '5 minutes recovered');
  assert.equal(d.netLateMinutes, 5, '5 minutes net deficit remaining');
  assert.equal(d.dailyDeficitMinutes, 5, '5 deficit');
  assert.equal(d.isLateOccurrence, true, 'still a late occurrence because net > 0');
  assert.equal(d.attendanceStatus, 'LATE');
});

test('arriving at 11:20 and leaving at 7:00 PM has 0 recovery (10m deficit)', async () => {
  const emp = await makeEmployee('emp_rec_1120_none');
  await present(emp, '11:20', '19:00');

  const d = await A.deriveDay(emp, DAY, at('19:30'));
  assert.equal(d.lateMinutes, 10);
  assert.equal(d.overtimeMinutes, 0);
  assert.equal(d.recoveredLateMinutes, 0);
  assert.equal(d.netLateMinutes, 10);
  assert.equal(d.dailyDeficitMinutes, 10);
  assert.equal(d.isLateOccurrence, true);
  assert.equal(d.attendanceStatus, 'LATE');
});

