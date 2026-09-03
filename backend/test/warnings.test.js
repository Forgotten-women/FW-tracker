// Warning engine tests. Spec sections 9, 10, 21 and the acceptance tests in 34.
//
// The policy encoded here was confirmed by Forgotten Women on 2026-08-27. Where
// the spec left something undecided and it has NOT been confirmed, the tests
// assert that the engine refuses rather than guesses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTestDatabase, prepareDatabase, dropDatabase } = require('./helpers/pg');
useTestDatabase('warnings');


const { db } = require('../src/db');
const W = require('../src/domain/warnings');
const A = require('../src/domain/attendance');
const P = require('../src/domain/presence');
const T = require('../src/util/time');

const MIN = 60 * 1000;
const OFFICE_IP = '192.168.18.59';

async function makeEmployee(id) {
  await db.prepare(
    'INSERT INTO employees (id, name, role, active, created_at, updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, active = EXCLUDED.active, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at'
  ).run(id, 'Test ' + id, 'Engineering', T.now(), T.now());
  return id;
}

/** Records a late arrival on a working day and derives it. */
async function lateDay(employeeId, dateKey, arrival = '11:30') {
  for (let t = T.wallClockToEpoch(dateKey, arrival);
       t <= T.wallClockToEpoch(dateKey, '19:00'); t += 30 * MIN) {
    await P.recordEvent({ employeeId, source: 'APP', srcIp: OFFICE_IP, observedAt: t });
  }
  await A.recomputeDay(employeeId, dateKey, T.wallClockToEpoch(dateKey, '23:59'));
}

// Four working days in September 2026 (Tue-Fri).
const LATE_DAYS = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
const REVIEW_DATE = '2026-09-10';

test.after(dropDatabase);

// ---------------------------------------------------------------------------
// Triggers are referrals, not warnings (spec 9.3)
// ---------------------------------------------------------------------------

test('three late occurrences raise no trigger', async () => {
  const emp = await makeEmployee('emp_three');
  for (const d of LATE_DAYS.slice(0, 3)) await lateDay(emp, d);

  const r = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(r.triggered, false, 'the 3rd is the last permitted occurrence');
  assert.equal(r.status.count, 3);
  assert.equal(r.status.remaining, 0);
});

test('the fourth raises a trigger, and NOT a warning', async () => {
  const emp = await makeEmployee('emp_four');
  for (const d of LATE_DAYS) await lateDay(emp, d);

  const r = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(r.triggered, true);
  assert.equal(r.status.count, 4);
  assert.equal(r.proposedLevel, 'INFORMAL_NOTICE', 'the first step of the confirmed sequence');

  const trigger = await db.prepare('SELECT * FROM warning_triggers WHERE id = ?').get(r.triggerId);
  assert.equal(trigger.status, 'PENDING_REVIEW');

  // Spec 9.3: a late record may later be corrected or authorised, so nothing
  // formal exists until a person decides.
  assert.equal(
    (await db.prepare('SELECT COUNT(*) c FROM formal_warnings WHERE employee_id = ?').get(emp)).c, 0,
  );
});

test('re-evaluating does not raise the same referral twice', async () => {
  const emp = await makeEmployee('emp_idem');
  for (const d of LATE_DAYS) await lateDay(emp, d);

  const first = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(first.triggered, true);

  // The maintenance tick runs every minute; without idempotence HR would be
  // buried in duplicate referrals.
  for (let i = 0; i < 5; i++) {
    const again = await W.evaluateLateness(emp, REVIEW_DATE);
    assert.equal(again.triggered, false);
    assert.equal(again.alreadyRaised, true);
  }
  assert.equal(
    (await db.prepare('SELECT COUNT(*) c FROM warning_triggers WHERE employee_id = ?').get(emp)).c, 1,
  );
});

// ---------------------------------------------------------------------------
// HR review (spec 9.3)
// ---------------------------------------------------------------------------

test('waiving a trigger closes it without a warning', async () => {
  const emp = await makeEmployee('emp_waive');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const { triggerId } = await W.evaluateLateness(emp, REVIEW_DATE);

  const r = await W.reviewTrigger({
    triggerId, decision: 'WAIVED', actor: 'user:hr',
    notes: 'Manager had authorised the late starts that week',
  });

  assert.equal(r.warning, null);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM formal_warnings WHERE employee_id = ?').get(emp)).c, 0);
  assert.equal(await (await W.standingFor(emp)).warningsIssued, 0, 'a waived trigger must not advance escalation');
});

test('a decision requires a note, and confirming requires an explanation', async () => {
  const emp = await makeEmployee('emp_notes');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const { triggerId } = await W.evaluateLateness(emp, REVIEW_DATE);

  assert.throws(async () => await W.reviewTrigger({ triggerId, decision: 'WAIVED', actor: 'user:hr' }), /note/i);
  assert.throws(
    async () => await W.reviewTrigger({ triggerId, decision: 'CONFIRMED', actor: 'user:hr', notes: 'ok' }),
    /explanation/i,
    'a formal warning must carry an explanation the employee will see',
  );
});

test('a trigger cannot be reviewed twice', async () => {
  const emp = await makeEmployee('emp_twice');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const { triggerId } = await W.evaluateLateness(emp, REVIEW_DATE);

  await W.reviewTrigger({ triggerId, decision: 'WAIVED', actor: 'user:hr', notes: 'First decision' });
  assert.throws(
    async () => await W.reviewTrigger({ triggerId, decision: 'CONFIRMED', actor: 'user:hr', notes: 'x', explanation: 'y' }),
    /already been reviewed/i,
  );
});

// ---------------------------------------------------------------------------
// Escalation (confirmed: informal -> first written -> final written)
// ---------------------------------------------------------------------------

test('confirming issues a warning at the next level in the sequence', async () => {
  const emp = await makeEmployee('emp_escalate');
  for (const d of LATE_DAYS) await lateDay(emp, d);

  const t1 = await W.evaluateLateness(emp, REVIEW_DATE);
  const r1 = await W.reviewTrigger({
    triggerId: t1.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Confirmed after review', explanation: 'Four late arrivals in September.',
  });
  assert.equal(r1.warning.level, 'INFORMAL_NOTICE');

  // A 5th late in the SAME month escalates, because the count is not reset by
  // a warning and every further occurrence escalates.
  await lateDay(emp, '2026-09-07');
  const t2 = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(t2.triggered, true);
  assert.equal(t2.status.count, 5);
  assert.equal(t2.proposedLevel, 'FIRST_WRITTEN');

  const r2 = await W.reviewTrigger({
    triggerId: t2.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Fifth occurrence', explanation: 'A fifth late arrival in September.',
  });
  assert.equal(r2.warning.level, 'FIRST_WRITTEN');

  await lateDay(emp, '2026-09-08');
  const t3 = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(t3.proposedLevel, 'FINAL_WRITTEN');

  const r3 = await W.reviewTrigger({
    triggerId: t3.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Sixth occurrence', explanation: 'A sixth late arrival in September.',
  });
  assert.equal(r3.warning.level, 'FINAL_WRITTEN');
});

// What follows a final written warning was never specified, so the engine must
// stop rather than invent an outcome such as dismissal.
test('the engine refuses to escalate past the confirmed sequence', async () => {
  const emp = 'emp_escalate';   // already at FINAL_WRITTEN from the test above
  const standing = await W.standingFor(emp);
  assert.equal(standing.sequenceExhausted, true);
  assert.equal(standing.nextLevel, null);

  await lateDay(emp, '2026-09-09');
  const t4 = await W.evaluateLateness(emp, REVIEW_DATE);
  assert.equal(t4.triggered, true, 'HR is still told about it');
  assert.equal(t4.sequenceExhausted, true);

  assert.throws(
    async () => await W.reviewTrigger({
      triggerId: t4.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
      notes: 'Seventh', explanation: 'A seventh late arrival.',
    }),
    /exhausted/i,
    'inventing a level beyond final written would be deciding disciplinary policy',
  );
});

// ---------------------------------------------------------------------------
// Expiry versus history
// ---------------------------------------------------------------------------

test('a warning expires after a month but still counts toward escalation', async () => {
  const emp = await makeEmployee('emp_expiry');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const t = await W.evaluateLateness(emp, REVIEW_DATE);
  const issuedAt = T.wallClockToEpoch('2026-09-10', '12:00');

  await W.reviewTrigger({
    triggerId: t.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Confirmed', explanation: 'Four late arrivals.', nowMs: issuedAt,
  });

  const w = await db.prepare('SELECT * FROM formal_warnings WHERE employee_id = ?').get(emp);
  assert.equal(w.status, 'ACTIVE');
  assert.equal(w.expiry_date, '2026-10-10', 'one month after issue');

  // A month later.
  const later = T.wallClockToEpoch('2026-10-15', '09:00');
  const expired = await W.expireWarnings(later);
  assert.ok(expired >= 1);

  const after = await db.prepare('SELECT * FROM formal_warnings WHERE id = ?').get(w.id);
  assert.equal(after.status, 'EXPIRED');

  // The crucial part. Confirmed: history drives escalation, so the next
  // confirmed trigger is a FIRST_WRITTEN and not another informal notice.
  const standing = await W.standingFor(emp);
  assert.equal(standing.activeWarnings, 0, 'nothing is live on the record');
  assert.equal(standing.warningsIssued, 1, 'but it still happened');
  assert.equal(standing.nextLevel, 'FIRST_WRITTEN', 'escalation progresses, it does not reset');
});

test('a withdrawn warning does not count toward escalation', async () => {
  const emp = await makeEmployee('emp_withdraw');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const t = await W.evaluateLateness(emp, REVIEW_DATE);
  const r = await W.reviewTrigger({
    triggerId: t.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Confirmed', explanation: 'Four late arrivals.',
  });

  assert.equal(await (await W.standingFor(emp)).nextLevel, 'FIRST_WRITTEN');

  await W.withdrawWarning({ warningId: r.warning.id, reason: 'Issued in error', actor: 'user:hr' });

  // A warning HR decided should not have been issued must not push the next
  // one up a level.
  assert.equal(await (await W.standingFor(emp)).warningsIssued, 0);
  assert.equal(await (await W.standingFor(emp)).nextLevel, 'INFORMAL_NOTICE');
});

test('withdrawing requires a reason', () => {
  assert.throws(
    async () => await W.withdrawWarning({ warningId: 'nonexistent', actor: 'user:hr' }),
    /reason/i,
  );
});

// ---------------------------------------------------------------------------
// Acknowledgement (spec 9.4, 19.5)
// ---------------------------------------------------------------------------

test('issuing a warning requests acknowledgement and notifies the employee', async () => {
  const emp = await makeEmployee('emp_ack');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  const t = await W.evaluateLateness(emp, REVIEW_DATE);
  const r = await W.reviewTrigger({
    triggerId: t.triggerId, decision: 'CONFIRMED', actor: 'user:hr',
    notes: 'Confirmed', explanation: 'Four late arrivals in September.',
  });

  const ack = await db.prepare('SELECT * FROM warning_acknowledgements WHERE warning_id = ?').get(r.warning.id);
  assert.ok(ack);
  assert.equal(ack.acknowledged_at, null);

  const note = await db.prepare(
    "SELECT * FROM notifications WHERE employee_id = ? AND category = 'WARNING'"
  ).get(emp);
  assert.ok(note, 'the employee must be told');
  assert.equal(note.severity, 'urgent');

  const done = await W.acknowledgeWarning({
    warningId: r.warning.id, employeeId: emp, comments: 'Received, I disagree',
  });
  assert.equal(done.acknowledged, true);

  // Acknowledging receipt is not agreeing, and the record must not imply it is.
  const entry = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'WARNING_ACKNOWLEDGED' ORDER BY at DESC LIMIT 1"
  ).get();
  assert.match(entry.note, /I disagree/);
});

// ---------------------------------------------------------------------------
// Employee view (spec 9.2, 19.2, 21)
// ---------------------------------------------------------------------------

test('the employee view bands green, amber and red with words not just colour', async () => {
  const clean = await makeEmployee('emp_green');
  const green = await W.employeeWarningView(clean, REVIEW_DATE);
  assert.equal(green.band, 'GREEN');
  assert.ok(green.bandLabel.length > 0, 'spec 21: colour must never be the only indicator');

  const amber = await makeEmployee('emp_amber');
  for (const d of LATE_DAYS.slice(0, 2)) await lateDay(amber, d);
  const a = await W.employeeWarningView(amber, REVIEW_DATE);
  assert.equal(a.band, 'AMBER');
  // Spec 9.2 asks for exactly this wording.
  assert.match(a.lateness.message, /You have been late 2 times/);
  assert.match(a.lateness.message, /1 permitted late occurrence remaining/);

  const red = await makeEmployee('emp_red');
  for (const d of LATE_DAYS) await lateDay(red, d);
  await W.evaluateLateness(red, REVIEW_DATE);
  const rv = await W.employeeWarningView(red, REVIEW_DATE);
  assert.equal(rv.band, 'RED');
  assert.equal(rv.pendingReview, true);
  assert.match(rv.lateness.message, /referred to HR/);
});

test('an employee at the limit is warned that the next late triggers review', async () => {
  const emp = await makeEmployee('emp_atlimit');
  for (const d of LATE_DAYS.slice(0, 3)) await lateDay(emp, d);
  const v = await W.employeeWarningView(emp, REVIEW_DATE);
  assert.match(v.lateness.message, /You have reached 3 late occurrences/);
  assert.match(v.lateness.message, /If you are late again/);
});

test('a pending trigger is not presented to the employee as a warning', async () => {
  const emp = await makeEmployee('emp_pending');
  for (const d of LATE_DAYS) await lateDay(emp, d);
  await W.evaluateLateness(emp, REVIEW_DATE);

  const v = await W.employeeWarningView(emp, REVIEW_DATE);
  assert.equal(v.pendingReview, true);
  assert.equal(v.warnings.length, 0, 'nothing formal exists until HR confirms it');
  assert.equal(v.standing.warningsIssued, 0);
});

// ---------------------------------------------------------------------------
// Unauthorised absence (spec 10.2) - confirmed: NO automatic consequence
// ---------------------------------------------------------------------------

test('a suspected absence is recorded with no consequence chosen', async () => {
  const emp = await makeEmployee('emp_absent');
  const r = await W.recordSuspectedAbsence({ employeeId: emp, dateKey: '2026-09-15' });

  const row = await db.prepare('SELECT * FROM absence_records WHERE id = ?').get(r.id);
  assert.equal(row.status, 'PENDING_REVIEW');

  // All three switches null, meaning undecided by design. Coercing them to 0
  // would look like a decision nobody made.
  assert.equal(row.deduct_annual_leave, null);
  assert.equal(row.treat_as_unpaid, null);
  assert.equal(row.create_warning_trigger, null);
});

test('recording an absence twice for one day is a no-op', async () => {
  const emp = await makeEmployee('emp_absent2');
  await W.recordSuspectedAbsence({ employeeId: emp, dateKey: '2026-09-15' });
  const again = await W.recordSuspectedAbsence({ employeeId: emp, dateKey: '2026-09-15' });
  assert.equal(again.alreadyRecorded, true);
});

// The heart of spec 10.2: the supplied wording would apply two penalties for
// one day, so the two must stay separately chosen.
test('absence consequences are chosen per case and only PROPOSED', async () => {
  const emp = await makeEmployee('emp_absrev');
  const { id } = await W.recordSuspectedAbsence({ employeeId: emp, dateKey: '2026-09-16' });

  const r = await W.reviewAbsence({
    absenceId: id, status: 'CONFIRMED',
    deductAnnualLeave: false, treatAsUnpaid: true, createWarningTrigger: false,
    notes: 'No contact all day, unpaid but no leave deduction', actor: 'user:hr',
  });

  assert.equal(r.status, 'CONFIRMED');
  assert.deepEqual(r.proposedConsequences, {
    deductAnnualLeave: false, treatAsUnpaid: true, createWarningTrigger: false,
  });
  // Spec 29: the system calculates, a person approves, and only then does
  // anything happen to pay or leave.
  assert.equal(r.applied, false);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get()).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM leave_accrual_ledger').get()).c, 0);
});

test('reviewing an absence requires a note and a valid status', async () => {
  const emp = await makeEmployee('emp_absnote');
  const { id } = await W.recordSuspectedAbsence({ employeeId: emp, dateKey: '2026-09-17' });
  assert.throws(async () => await W.reviewAbsence({ absenceId: id, status: 'CONFIRMED', actor: 'hr' }), /note/i);
  assert.throws(
    async () => await W.reviewAbsence({ absenceId: id, status: 'MAYBE', notes: 'x', actor: 'hr' }),
    /CONFIRMED or DISMISSED/,
  );
});

// ---------------------------------------------------------------------------
// Auditability
// ---------------------------------------------------------------------------

test('every step of the warning lifecycle is audited', async () => {
  const actions = (await db.prepare('SELECT DISTINCT action FROM audit_log').all()).map(r => r.action);
  for (const expected of [
    'WARNING_TRIGGER_RAISED', 'WARNING_TRIGGER_REVIEWED', 'FORMAL_WARNING_ISSUED',
    'FORMAL_WARNING_WITHDRAWN', 'FORMAL_WARNING_EXPIRED', 'WARNING_ACKNOWLEDGED',
    'ABSENCE_SUSPECTED', 'ABSENCE_REVIEWED',
  ]) {
    assert.ok(actions.includes(expected), `missing audit action: ${expected}`);
  }
});

test('the trigger audit entry states plainly that it is not a warning', async () => {
  const entry = await db.prepare(
    "SELECT * FROM audit_log WHERE action = 'WARNING_TRIGGER_RAISED' ORDER BY at LIMIT 1"
  ).get();
  assert.match(entry.note, /No formal warning has been issued/);
});

// ---------------------------------------------------------------------------
// Refusing to guess
// ---------------------------------------------------------------------------

test('with no confirmed monitoring period the engine refuses to evaluate', async () => {
  const { config } = require('../src/config');

test.before(prepareDatabase);
  const original = config.latenessMonitoringPeriod;
  config.latenessMonitoringPeriod = 'UNSET';
  try {
    const emp = await makeEmployee('emp_unset');
    const r = await W.evaluateLateness(emp, REVIEW_DATE);
    assert.equal(r.evaluated, false, 'guessing the reset period would decide who gets disciplined');
  } finally {
    config.latenessMonitoringPeriod = original;
  }
});
