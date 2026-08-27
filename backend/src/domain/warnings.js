// The warning engine. Spec sections 9, 10 and 21.
//
// The single most important rule in this file comes from spec 9.3: an automatic
// policy alert and a formal HR warning are DIFFERENT THINGS. A late record may
// later be corrected or authorised, so the engine only ever raises a TRIGGER -
// a referral for a person to review. Nothing here issues a formal warning by
// itself, and nothing here touches pay or leave.
//
// Policy confirmed by Forgotten Women on 2026-08-27:
//   - 3 late occurrences permitted per calendar month, the 4th refers to HR
//   - escalation informal notice -> first written -> final written
//   - a warning goes inactive after one month but STAYS IN HISTORY, and history
//     is what drives escalation, so the sequence progresses instead of
//     resetting every month
//   - the late count is not reset by a warning; every further late occurrence
//     in the same month escalates
//   - an unauthorised absence has NO automatic consequence

const crypto = require('crypto');
const { db, tx, audit } = require('../db');
const { config } = require('../config');
const A = require('./attendance');
const T = require('../util/time');

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const selectIssuedWarnings = db.prepare(`
  SELECT * FROM formal_warnings
  WHERE employee_id = ? AND status != 'WITHDRAWN'
  ORDER BY issued_at ASC
`);

/**
 * Where an employee sits in the escalation sequence.
 *
 * Counts warnings that were ISSUED, not warnings that are currently active.
 * Expiry controls what shows as live on someone's record; it does not erase the
 * fact that a warning happened. Counting only active warnings would mean nobody
 * ever progressed past the first level, since each expires within a month.
 *
 * WITHDRAWN warnings are excluded: a withdrawn warning is one HR decided should
 * not have been issued, so it must not push the next one up a level.
 */
function standingFor(employeeId) {
  const sequence = config.warningEscalationSequence;
  const issued = selectIssuedWarnings.all(employeeId);

  const nextIndex = issued.length;
  const exhausted = nextIndex >= sequence.length;

  return {
    warningsIssued: issued.length,
    highestLevel: issued.length ? issued[issued.length - 1].warning_level : null,
    lastIssuedAt: issued.length ? issued[issued.length - 1].issued_at : null,
    // Null once the confirmed sequence runs out. What follows a final written
    // warning is not defined by the spec, so the engine refuses to invent one.
    nextLevel: exhausted ? null : sequence[nextIndex],
    sequenceExhausted: exhausted,
    activeWarnings: issued.filter(w => w.status === 'ACTIVE').length,
    history: issued.map(w => ({
      id: w.id,
      level: w.warning_level,
      issuedAt: w.issued_at,
      status: w.status,
      expiryDate: w.expiry_date,
    })),
  };
}

const upsertStanding = db.prepare(`
  INSERT INTO employee_warning_standing
    (employee_id, warnings_issued, highest_level, last_issued_at, next_level, sequence_exhausted, updated_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(employee_id) DO UPDATE SET
    warnings_issued = excluded.warnings_issued,
    highest_level   = excluded.highest_level,
    last_issued_at  = excluded.last_issued_at,
    next_level      = excluded.next_level,
    sequence_exhausted = excluded.sequence_exhausted,
    updated_at      = excluded.updated_at
`);

function refreshStanding(employeeId) {
  const s = standingFor(employeeId);
  upsertStanding.run(
    employeeId, s.warningsIssued, s.highestLevel, s.lastIssuedAt,
    s.nextLevel, s.sequenceExhausted ? 1 : 0, T.now(),
  );
  return s;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const selectTriggerForOccurrence = db.prepare(`
  SELECT * FROM warning_triggers
  WHERE employee_id = ? AND rule_id = ? AND occurrence_count = ?
    AND related_dates = ?
`);

const insertTrigger = db.prepare(`
  INSERT INTO warning_triggers
    (id, employee_id, rule_id, triggered_at, trigger_reason, occurrence_count,
     related_dates, status)
  VALUES (@id, @employee_id, @rule_id, @triggered_at, @trigger_reason,
          @occurrence_count, @related_dates, 'PENDING_REVIEW')
`);

/**
 * Evaluates the lateness rule for one employee.
 *
 * Idempotent: a trigger is keyed on the occurrence count within the monitoring
 * period, so re-running after every recompute cannot raise the same referral
 * twice. Returns the trigger if one was created, otherwise null.
 */
function evaluateLateness(employeeId, dateKey = T.dateKey(), nowMs = T.now()) {
  const status = A.latenessStatus(employeeId, dateKey);

  // Spec 9.6: with no confirmed reset period the engine refuses to evaluate
  // rather than guessing which arrivals fall inside the window.
  if (!status.resolved) return { evaluated: false, reason: status.reason };
  if (!status.thresholdReached) return { evaluated: true, triggered: false, status };

  const periodKey = `${status.periodFrom}..${status.periodTo}`;
  const existing = selectTriggerForOccurrence.get(
    employeeId, 'wr_lateness', status.count, periodKey,
  );
  if (existing) return { evaluated: true, triggered: false, alreadyRaised: true, status };

  // Confirmed: every further late occurrence escalates. Without that, only the
  // 4th would refer and a 5th and 6th would pass unnoticed.
  if (!config.escalateOnEveryOccurrence && status.count > status.allowed + 1) {
    return { evaluated: true, triggered: false, status };
  }

  const standing = standingFor(employeeId);
  const id = 'wt_' + crypto.randomBytes(8).toString('hex');

  insertTrigger.run({
    id,
    employee_id: employeeId,
    rule_id: 'wr_lateness',
    triggered_at: nowMs,
    trigger_reason:
      `${status.count} late occurrences in ${status.periodType.toLowerCase().replace('_', ' ')} ` +
      `${status.periodFrom} to ${status.periodTo}, against ${status.allowed} permitted`,
    occurrence_count: status.count,
    related_dates: periodKey,
  });

  audit({
    actor: 'system', action: 'WARNING_TRIGGER_RAISED',
    targetType: 'employee', targetId: employeeId,
    after: {
      triggerId: id, occurrences: status.count,
      proposedLevel: standing.nextLevel,
      sequenceExhausted: standing.sequenceExhausted,
    },
    // Spec 9.3: this is a referral, not a warning.
    note: 'Referred to HR for review. No formal warning has been issued.',
  });

  return {
    evaluated: true, triggered: true, triggerId: id,
    status, proposedLevel: standing.nextLevel,
    sequenceExhausted: standing.sequenceExhausted,
  };
}

/** Evaluates every active employee. Called by the maintenance tick. */
function evaluateAll(dateKey = T.dateKey(), nowMs = T.now()) {
  const employees = db.prepare('SELECT id FROM employees WHERE active = 1').all();
  const raised = [];
  for (const e of employees) {
    const r = evaluateLateness(e.id, dateKey, nowMs);
    if (r.triggered) raised.push({ employeeId: e.id, triggerId: r.triggerId });
  }
  return raised;
}

// ---------------------------------------------------------------------------
// HR review (spec 9.3)
// ---------------------------------------------------------------------------

const DECISIONS = ['CONFIRMED', 'WAIVED', 'CORRECTED', 'SUPERSEDED'];

/**
 * A person decides what happens to a trigger.
 *
 * CONFIRMED issues a formal warning at the next level in the sequence.
 * WAIVED and CORRECTED close the referral without one - which is the case spec
 * 9.3 exists for, where the underlying attendance turns out to be wrong or
 * authorised.
 */
function reviewTrigger({ triggerId, decision, notes, actor, explanation, nowMs = T.now() }) {
  if (!DECISIONS.includes(decision)) {
    throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
  }
  if (!notes || !String(notes).trim()) {
    throw new Error('A note explaining the decision is required.');
  }

  const trigger = db.prepare('SELECT * FROM warning_triggers WHERE id = ?').get(triggerId);
  if (!trigger) throw new Error('No such trigger.');
  if (trigger.status !== 'PENDING_REVIEW') {
    throw new Error(`This trigger has already been reviewed (${trigger.status}).`);
  }

  let warning = null;

  tx(() => {
    if (decision === 'CONFIRMED') {
      const standing = standingFor(trigger.employee_id);

      if (standing.sequenceExhausted) {
        // Refusing rather than inventing a level. What follows a final written
        // warning is a decision the organisation has not made.
        throw new Error(
          'The confirmed escalation sequence has been exhausted for this employee ' +
          `(already at ${standing.highestLevel}). What follows a final written warning ` +
          'is not configured, so this cannot be issued automatically. Record the outcome ' +
          'outside the system, or extend warningEscalationSequence in config/office.json.',
        );
      }
      if (!explanation || !String(explanation).trim()) {
        throw new Error('A formal warning needs an explanation the employee will see.');
      }

      warning = issueFormalWarning({
        employeeId: trigger.employee_id,
        triggerId: trigger.id,
        level: standing.nextLevel,
        warningType: 'LATENESS',
        triggeringRule: trigger.trigger_reason,
        relatedIncidents: trigger.related_dates,
        explanation: String(explanation).trim(),
        actor,
        nowMs,
      });
    }

    db.prepare(`
      UPDATE warning_triggers
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?, formal_warning_id = ?
      WHERE id = ?
    `).run(decision, actor, nowMs, String(notes).trim(), warning ? warning.id : null, trigger.id);

    audit({
      actor, action: 'WARNING_TRIGGER_REVIEWED',
      targetType: 'trigger', targetId: trigger.id,
      before: { status: trigger.status },
      after: { status: decision, formalWarningId: warning ? warning.id : null },
      note: String(notes).trim(),
    });
  })();

  refreshStanding(trigger.employee_id);
  return { decision, warning };
}

// ---------------------------------------------------------------------------
// Formal warnings
// ---------------------------------------------------------------------------

/** Adds N calendar months to a local date key. */
function addMonths(dateKey, months) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  // Clamp, so 31 January plus one month is 28 February rather than 3 March.
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  return `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
}

function issueFormalWarning({
  employeeId, triggerId = null, level, warningType, triggeringRule = null,
  relatedIncidents = null, explanation, actor, nowMs = T.now(),
}) {
  const id = 'fw_' + crypto.randomBytes(8).toString('hex');
  const issuedDate = T.dateKey(nowMs);
  const expiryDate = config.warningExpiryMonths
    ? addMonths(issuedDate, config.warningExpiryMonths)
    : null;

  db.prepare(`
    INSERT INTO formal_warnings
      (id, employee_id, trigger_id, warning_type, warning_level, triggering_rule,
       related_incidents, explanation, issued_at, issued_by, review_date, expiry_date, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')
  `).run(id, employeeId, triggerId, warningType, level, triggeringRule,
         relatedIncidents, explanation, nowMs, actor, expiryDate, expiryDate);

  // Spec 9.4 and 19.5: the employee must be able to acknowledge receipt.
  db.prepare(`
    INSERT INTO warning_acknowledgements (id, warning_id, employee_id, requested_at)
    VALUES (?,?,?,?)
  `).run('wa_' + crypto.randomBytes(8).toString('hex'), id, employeeId, nowMs);

  notify({
    employeeId,
    category: 'WARNING',
    title: `A ${levelLabel(level)} has been issued`,
    body: explanation,
    severity: 'urgent',
    nowMs,
  });

  audit({
    actor, action: 'FORMAL_WARNING_ISSUED',
    targetType: 'employee', targetId: employeeId,
    after: { warningId: id, level, warningType, expiryDate },
    note: explanation,
  });

  return { id, level, expiryDate, issuedAt: nowMs };
}

function withdrawWarning({ warningId, reason, actor, nowMs = T.now() }) {
  if (!reason || !String(reason).trim()) throw new Error('A reason is required to withdraw a warning.');
  const w = db.prepare('SELECT * FROM formal_warnings WHERE id = ?').get(warningId);
  if (!w) throw new Error('No such warning.');

  tx(() => {
    db.prepare("UPDATE formal_warnings SET status = 'WITHDRAWN', outcome = ? WHERE id = ?")
      .run(String(reason).trim(), warningId);
    audit({
      actor, action: 'FORMAL_WARNING_WITHDRAWN',
      targetType: 'warning', targetId: warningId,
      before: { status: w.status }, after: { status: 'WITHDRAWN' },
      note: String(reason).trim(),
    });
  })();

  // A withdrawn warning stops counting toward escalation, so the next one is
  // proposed at the level it would have been.
  refreshStanding(w.employee_id);
  return { withdrawn: true };
}

function acknowledgeWarning({ warningId, employeeId, comments = null, nowMs = T.now() }) {
  const row = db.prepare(
    'SELECT * FROM warning_acknowledgements WHERE warning_id = ? AND employee_id = ?'
  ).get(warningId, employeeId);
  if (!row) throw new Error('No acknowledgement is outstanding for this warning.');
  if (row.acknowledged_at) return { alreadyAcknowledged: true, at: row.acknowledged_at };

  db.prepare('UPDATE warning_acknowledgements SET acknowledged_at = ?, comments = ? WHERE id = ?')
    .run(nowMs, comments, row.id);

  audit({
    actor: `employee:${employeeId}`, action: 'WARNING_ACKNOWLEDGED',
    targetType: 'warning', targetId: warningId,
    // Acknowledging receipt is not agreeing with it, and the record should not
    // imply otherwise.
    note: comments || 'Receipt acknowledged',
  });

  return { acknowledged: true, at: nowMs };
}

/**
 * Marks warnings inactive once their expiry date has passed.
 *
 * They remain in the record and continue to count toward escalation - expiry
 * changes what is live, not what happened.
 */
function expireWarnings(nowMs = T.now()) {
  const today = T.dateKey(nowMs);
  const due = db.prepare(
    "SELECT * FROM formal_warnings WHERE status = 'ACTIVE' AND expiry_date IS NOT NULL AND expiry_date < ?"
  ).all(today);

  for (const w of due) {
    db.prepare("UPDATE formal_warnings SET status = 'EXPIRED' WHERE id = ?").run(w.id);
    audit({
      actor: 'system', action: 'FORMAL_WARNING_EXPIRED',
      targetType: 'warning', targetId: w.id,
      note: 'No longer active. Still counts toward escalation history.',
    });
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Unauthorised absence (spec 10)
// ---------------------------------------------------------------------------

/**
 * Records a suspected no-show.
 *
 * Confirmed policy: NO automatic consequence. The three switches spec 10.2
 * requires to be independent are left null, so a person chooses the outcome
 * case by case. This is what prevents one absence silently costing both a day
 * of annual leave and a day of pay.
 */
function recordSuspectedAbsence({ employeeId, dateKey, nowMs = T.now() }) {
  const existing = db.prepare(
    'SELECT * FROM absence_records WHERE employee_id = ? AND date_key = ?'
  ).get(employeeId, dateKey);
  if (existing) return { alreadyRecorded: true, id: existing.id };

  const id = 'abs_' + crypto.randomBytes(8).toString('hex');

  // null stays null. The three switches are deliberately tri-state: true, false
  // and "not decided". Coercing an undecided switch to 0 would look like a
  // decision that nobody made.
  const tri = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));

  db.prepare(`
    INSERT INTO absence_records
      (id, employee_id, date_key, absence_type, detected_at, status,
       deduct_annual_leave, treat_as_unpaid, create_warning_trigger)
    VALUES (?,?,?, 'SUSPECTED_NO_SHOW', ?, 'PENDING_REVIEW', ?,?,?)
  `).run(
    id, employeeId, dateKey, nowMs,
    tri(config.unauthorisedAbsence.deductAnnualLeave),
    tri(config.unauthorisedAbsence.treatAsUnpaid),
    tri(config.unauthorisedAbsence.createWarningTrigger),
  );

  audit({
    actor: 'system', action: 'ABSENCE_SUSPECTED',
    targetType: 'employee', targetId: employeeId,
    after: { date: dateKey },
    note: 'Recorded for HR review. No consequence applied - every outcome is a human decision.',
  });

  return { id, recorded: true };
}

/** A person decides the outcome of a suspected absence. */
function reviewAbsence({
  absenceId, status, deductAnnualLeave = null, treatAsUnpaid = null,
  createWarningTrigger = null, notes, actor, nowMs = T.now(),
}) {
  if (!['CONFIRMED', 'DISMISSED'].includes(status)) {
    throw new Error('status must be CONFIRMED or DISMISSED.');
  }
  if (!notes || !String(notes).trim()) throw new Error('A note explaining the decision is required.');

  const record = db.prepare('SELECT * FROM absence_records WHERE id = ?').get(absenceId);
  if (!record) throw new Error('No such absence record.');

  tx(() => {
    db.prepare(`
      UPDATE absence_records
      SET status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?,
          deduct_annual_leave = ?, treat_as_unpaid = ?, create_warning_trigger = ?
      WHERE id = ?
    `).run(status, actor, nowMs, String(notes).trim(),
           deductAnnualLeave === null ? null : (deductAnnualLeave ? 1 : 0),
           treatAsUnpaid === null ? null : (treatAsUnpaid ? 1 : 0),
           createWarningTrigger === null ? null : (createWarningTrigger ? 1 : 0),
           absenceId);

    audit({
      actor, action: 'ABSENCE_REVIEWED',
      targetType: 'absence', targetId: absenceId,
      before: { status: record.status },
      after: { status, deductAnnualLeave, treatAsUnpaid, createWarningTrigger },
      note: String(notes).trim(),
    });
  })();

  // Chosen consequences are PROPOSED, never applied here. Spec 29: the system
  // calculates, a person approves, and the leave and payroll engines act only
  // on an approved decision.
  return {
    status,
    proposedConsequences: { deductAnnualLeave, treatAsUnpaid, createWarningTrigger },
    applied: false,
  };
}

// ---------------------------------------------------------------------------
// Notifications (spec 22)
// ---------------------------------------------------------------------------

function notify({ employeeId = null, userId = null, category, title, body, severity = 'info', link = null, nowMs = T.now() }) {
  const id = 'ntf_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO notifications (id, employee_id, user_id, category, title, body, severity, link, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, employeeId, userId, category, title, body, severity, link, nowMs);
  return id;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function levelLabel(level) {
  switch (level) {
    case 'INFORMAL_NOTICE': return 'informal attendance notice';
    case 'FIRST_WRITTEN':   return 'first written warning';
    case 'FINAL_WRITTEN':   return 'final written warning';
    default:                return String(level || 'warning').toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Everything the employee warning screen needs. Spec 19.2 and 19.5.
 *
 * The green/amber/red banding spec 21 asks for is returned as a WORD, because
 * the spec is explicit that colour must supplement text and never be the only
 * indicator.
 */
function employeeWarningView(employeeId, dateKey = T.dateKey()) {
  const lateness = A.latenessStatus(employeeId, dateKey);
  const standing = standingFor(employeeId);

  const warnings = db.prepare(
    'SELECT * FROM formal_warnings WHERE employee_id = ? ORDER BY issued_at DESC'
  ).all(employeeId);

  const acks = new Map(
    db.prepare('SELECT * FROM warning_acknowledgements WHERE employee_id = ?').all(employeeId)
      .map(a => [a.warning_id, a]),
  );

  const pendingTriggers = db.prepare(
    "SELECT * FROM warning_triggers WHERE employee_id = ? AND status = 'PENDING_REVIEW'"
  ).all(employeeId);

  let band = 'GREEN';
  if (!lateness.resolved) band = 'UNKNOWN';
  else if (lateness.thresholdReached || pendingTriggers.length) band = 'RED';
  else if (lateness.count >= lateness.allowed) band = 'AMBER';
  else if (lateness.count > 0) band = 'AMBER';

  return {
    band,
    bandLabel: {
      GREEN: 'No warning risk',
      AMBER: 'Approaching the threshold',
      RED: 'Threshold reached - referred to HR',
      UNKNOWN: 'Cannot be assessed',
    }[band],
    lateness,
    standing: {
      warningsIssued: standing.warningsIssued,
      activeWarnings: standing.activeWarnings,
      highestLevel: standing.highestLevel,
      highestLevelLabel: standing.highestLevel ? levelLabel(standing.highestLevel) : null,
      nextLevelIfConfirmed: standing.nextLevel ? levelLabel(standing.nextLevel) : null,
      sequenceExhausted: standing.sequenceExhausted,
    },
    // Under review, so the employee is not told they have a warning when they
    // do not yet have one.
    pendingReview: pendingTriggers.length > 0,
    warnings: warnings.map(w => {
      const ack = acks.get(w.id);
      return {
        id: w.id,
        level: w.warning_level,
        levelLabel: levelLabel(w.warning_level),
        type: w.warning_type,
        explanation: w.explanation,
        issuedOn: T.dateKey(w.issued_at),
        issuedAt: T.displayTime(w.issued_at),
        status: w.status,
        expiryDate: w.expiry_date,
        acknowledgementRequired: !!ack && !ack.acknowledged_at,
        acknowledgedAt: ack?.acknowledged_at ? T.displayTime(ack.acknowledged_at) : null,
      };
    }),
  };
}

module.exports = {
  standingFor, refreshStanding,
  evaluateLateness, evaluateAll,
  reviewTrigger, issueFormalWarning, withdrawWarning, acknowledgeWarning,
  expireWarnings, addMonths,
  recordSuspectedAbsence, reviewAbsence,
  notify, levelLabel, employeeWarningView,
};
