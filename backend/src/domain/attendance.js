// The attendance engine. Spec sections 7, 8, 9.1 and 12.
//
// Presence answers "was this phone on the office network". Attendance answers
// the HR questions: were they late, how late, did they overrun their break, did
// they leave early, and what does that add up to.
//
// Everything here is DERIVED from presence sessions plus explicit events, so a
// day can be recomputed after a correction or a rule change. Nothing is
// mutated in place.
//
// The governing constraint is spec section 29: the software calculates what the
// policy says, it does not become the policy. So this module produces numbers
// and referrals. It never issues a warning, never changes pay, and never
// touches anyone's leave balance.

const crypto = require('crypto');
const { db, tx } = require('../db');
const { config } = require('../config');
const P = require('./presence');
const schedule = require('./schedule');
const T = require('../util/time');

const MIN = 60 * 1000;

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

const selectBreaks = db.prepare(`
  SELECT * FROM break_records
  WHERE employee_id = ? AND date_key = ?
  ORDER BY started_at ASC
`);

const insertBreak = db.prepare(`
  INSERT INTO break_records
    (id, employee_id, date_key, started_at, ended_at, permitted_minutes,
     actual_minutes, excess_minutes, created_at)
  VALUES (@id, @employee_id, @date_key, @started_at, @ended_at, @permitted_minutes,
          @actual_minutes, @excess_minutes, @created_at)
`);

const selectOpenBreak = db.prepare(`
  SELECT * FROM break_records
  WHERE employee_id = ? AND ended_at IS NULL
  ORDER BY started_at DESC LIMIT 1
`);

async function startBreak(employeeId, atMs = T.now()) {
  const open = await selectOpenBreak.get(employeeId);
  if (open) {
    return { ok: false, reason: 'ALREADY_ON_BREAK', startedAt: open.started_at };
  }
  const dateKey = T.dateKey(atMs);
  const s = await schedule.resolve(employeeId, dateKey);
  const id = 'brk_' + crypto.randomBytes(8).toString('hex');

  await insertBreak.run({
    id, employee_id: employeeId, date_key: dateKey,
    started_at: atMs, ended_at: null,
    permitted_minutes: s.permittedBreakMinutes,
    actual_minutes: null, excess_minutes: 0,
    created_at: T.now(),
  });

  return {
    ok: true, breakId: id, startedAt: atMs,
    permittedMinutes: s.permittedBreakMinutes,
    // So the app can warn before the break overruns rather than after.
    dueBackAt: atMs + s.permittedBreakMinutes * MIN,
  };
}

async function endBreak(employeeId, atMs = T.now()) {
  const open = await selectOpenBreak.get(employeeId);
  if (!open) return { ok: false, reason: 'NOT_ON_BREAK' };

  const actual = Math.max(0, Math.round((atMs - open.started_at) / MIN));
  // Spec 12: only the EXCESS enters the deficit ledger. Finishing a break early
  // earns nothing back, and taking the full 30 minutes costs nothing.
  const excess = Math.max(0, actual - open.permitted_minutes);

  await db.prepare(
    'UPDATE break_records SET ended_at = ?, actual_minutes = ?, excess_minutes = ? WHERE id = ?'
  ).run(atMs, actual, excess, open.id);

  return {
    ok: true, breakId: open.id,
    actualMinutes: actual,
    permittedMinutes: open.permitted_minutes,
    excessMinutes: excess,
  };
}

// ---------------------------------------------------------------------------
// Daily derivation
// ---------------------------------------------------------------------------

const selectManualEvents = db.prepare(`
  SELECT * FROM attendance_events
  WHERE employee_id = ? AND date_key = ? AND voided_at IS NULL
  ORDER BY occurred_at ASC
`);

const selectApprovedAdjustment = db.prepare(`
  SELECT COALESCE(SUM(minutes_delta), 0) AS mins
  FROM attendance_deficit_ledger
  WHERE employee_id = ? AND date_key = ? AND entry_type = 'HR_ADJUSTMENT'
`);

/**
 * Derive one employee-day.
 *
 * Pure: reads, computes, returns. Persisting is a separate step so the same
 * calculation can be previewed without writing anything.
 */
async function deriveDay(employeeId, dateKey = T.dateKey(), nowMs = T.now()) {
  const s = await schedule.resolve(employeeId, dateKey);
  const presence = await P.deriveDay(employeeId, dateKey, nowMs);
  const breaks = await selectBreaks.all(employeeId, dateKey);
  const manual = await selectManualEvents.all(employeeId, dateKey);

  const dayStart = T.startOfDay(dateKey);
  const dayEnd = T.endOfDay(dateKey);
  const isToday = nowMs >= dayStart && nowMs < dayEnd;

  // A manual HR clock-in overrides the sensor-derived one. HR correcting a
  // record is the highest-authority statement about what happened.
  const manualIn = manual.find(e => e.event_type === 'CLOCK_IN');
  const manualOut = [...manual].reverse().find(e => e.event_type === 'CLOCK_OUT');

  const firstIn = manualIn ? manualIn.occurred_at : presence.firstInAt;
  const lastSeen = manualOut ? manualOut.occurred_at : presence.lastActiveAt;

  const base = {
    employeeId,
    dateKey,
    schedule: s,
    isWorkingDay: s.isWorkingDay,
    firstInAt: firstIn,
    lastSeenAt: lastSeen,
    presenceStatus: presence.status,
    presenceSource: presence.lastSource,
    sensorCarried: presence.sensorCarried,
    workedMinutes: presence.totalMinutes,
    sessions: presence.sessions,
    breaks: breaks.map(b => ({
      startedAt: b.started_at,
      endedAt: b.ended_at,
      actualMinutes: b.actual_minutes,
      permittedMinutes: b.permitted_minutes,
      excessMinutes: b.excess_minutes,
      open: b.ended_at === null,
    })),
    lateMinutes: 0,
    isLateOccurrence: false,
    excessBreakMinutes: 0,
    earlyDepartureMinutes: 0,
    unauthorisedMissingMinutes: 0,
    approvedAdjustmentMinutes: 0,
    dailyDeficitMinutes: 0,
    attendanceStatus: 'PENDING',
    needsReview: [],
  };

  // A rest day, public holiday or office closure produces no deficit at all.
  if (!s.isWorkingDay) {
    return {
      ...base,
      attendanceStatus: 'NON_WORKING_DAY',
      nonWorkingReason: s.nonWorkingReason,
    };
  }

  if (!firstIn) {
    return {
      ...base,
      // Deliberately not "unauthorised absence". That determination belongs to
      // the absence engine, which must also check approved leave before
      // accusing anyone of anything. Spec 10.1.
      attendanceStatus: isToday ? 'PENDING' : 'NO_ATTENDANCE_RECORDED',
    };
  }

  // --- late arrival (spec 8.1, 9.1) ----------------------------------------
  //
  // 10 minutes grace allowed: arrivals up to 11:10 are on time (0 late minutes, 0 deficit).
  // Arrivals from 11:11 onwards are late and count late minutes.
  const isLateOccurrence = firstIn > s.latestOnTimeAt;
  const lateMinutes = isLateOccurrence
    ? Math.max(0, Math.round((firstIn - s.scheduledStartAt) / MIN))
    : 0;

  // --- excess break (spec 12) ----------------------------------------------
  const excessBreakMinutes = breaks.reduce((a, b) => a + (b.excess_minutes || 0), 0);
  const openBreak = breaks.find(b => b.ended_at === null);

  // --- early departure ------------------------------------------------------
  // Only meaningful once the scheduled end has passed; someone still at their
  // desk at 3pm has not left early.
  let earlyDepartureMinutes = 0;
  if (!isToday || nowMs >= s.scheduledEndAt) {
    if (lastSeen && lastSeen < s.scheduledEndAt) {
      earlyDepartureMinutes = Math.max(0, Math.round((s.scheduledEndAt - lastSeen) / MIN));
    }
  }

  // --- unauthorised missing time -------------------------------------------
  //
  // Gaps between presence sessions inside the scheduled day that no declared
  // break accounts for. This is the "+ Unauthorised Missing Time" term of spec
  // 8.1, and it is why declaring a break matters: an undeclared absence costs
  // the whole gap, a declared one costs only the excess.
  let unauthorisedMissingMinutes = 0;
  const sessions = presence.sessions;
  for (let i = 1; i < sessions.length; i++) {
    const gapStart = sessions[i - 1].end;
    const gapEnd = sessions[i].start;

    const from = Math.max(gapStart, s.scheduledStartAt);
    const to = Math.min(gapEnd, s.scheduledEndAt);
    if (to <= from) continue;

    const gapMinutes = Math.round((to - from) / MIN);
    const coveredByBreak = breaks.some(b =>
      b.started_at <= gapStart + 5 * MIN &&
      (b.ended_at === null || b.ended_at >= gapEnd - 5 * MIN)
    );
    if (!coveredByBreak) unauthorisedMissingMinutes += gapMinutes;
  }

  const approvedAdjustmentMinutes = (await selectApprovedAdjustment.get(employeeId, dateKey)).mins || 0;

  // Spec 8.1, exactly.
  const dailyDeficitMinutes = Math.max(0,
    lateMinutes
    + excessBreakMinutes
    + earlyDepartureMinutes
    + unauthorisedMissingMinutes
    - Math.abs(approvedAdjustmentMinutes)
  );

  const needsReview = [];
  if (openBreak && !isToday) needsReview.push('Break was never ended');
  if (presence.exceededCap) needsReview.push('Session exceeded the maximum, phone may have been left in the office');
  if (unauthorisedMissingMinutes > 0) needsReview.push(`${unauthorisedMissingMinutes} min gap with no declared break`);

  return {
    ...base,
    lateMinutes,
    isLateOccurrence,
    excessBreakMinutes,
    earlyDepartureMinutes,
    unauthorisedMissingMinutes,
    approvedAdjustmentMinutes,
    dailyDeficitMinutes,
    attendanceStatus: isLateOccurrence ? 'LATE' : 'PRESENT',
    onBreak: !!openBreak,
    breakDueBackAt: openBreak ? openBreak.started_at + openBreak.permitted_minutes * MIN : null,
    needsReview,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const upsertSummary = db.prepare(`
  INSERT INTO attendance_daily_summary
    (employee_id, date_key, scheduled_start, scheduled_end, is_working_day,
     first_clock_in, last_clock_out, worked_minutes, break_minutes,
     late_minutes, excess_break_minutes, early_departure_minutes,
     unauthorised_missing_minutes, approved_adjustment_minutes,
     daily_deficit_minutes, is_late_occurrence, attendance_status, derived_at)
  VALUES
    (@employee_id, @date_key, @scheduled_start, @scheduled_end, @is_working_day,
     @first_clock_in, @last_clock_out, @worked_minutes, @break_minutes,
     @late_minutes, @excess_break_minutes, @early_departure_minutes,
     @unauthorised_missing_minutes, @approved_adjustment_minutes,
     @daily_deficit_minutes, @is_late_occurrence, @attendance_status, @derived_at)
  ON CONFLICT(employee_id, date_key) DO UPDATE SET
    scheduled_start = excluded.scheduled_start,
    scheduled_end   = excluded.scheduled_end,
    is_working_day  = excluded.is_working_day,
    first_clock_in  = excluded.first_clock_in,
    last_clock_out  = excluded.last_clock_out,
    worked_minutes  = excluded.worked_minutes,
    break_minutes   = excluded.break_minutes,
    late_minutes    = excluded.late_minutes,
    excess_break_minutes = excluded.excess_break_minutes,
    early_departure_minutes = excluded.early_departure_minutes,
    unauthorised_missing_minutes = excluded.unauthorised_missing_minutes,
    approved_adjustment_minutes = excluded.approved_adjustment_minutes,
    daily_deficit_minutes = excluded.daily_deficit_minutes,
    is_late_occurrence = excluded.is_late_occurrence,
    attendance_status  = excluded.attendance_status,
    derived_at = excluded.derived_at
`);

const selectSummary = db.prepare(
  'SELECT * FROM attendance_daily_summary WHERE employee_id = ? AND date_key = ?'
);

/** Derive and persist. Returns the derived day. */
async function recomputeDay(employeeId, dateKey = T.dateKey(), nowMs = T.now()) {
  const d = await deriveDay(employeeId, dateKey, nowMs);
  const previous = await selectSummary.get(employeeId, dateKey);

  await upsertSummary.run({
    employee_id: employeeId,
    date_key: dateKey,
    scheduled_start: d.schedule.startTime,
    scheduled_end: d.schedule.endTime,
    is_working_day: d.isWorkingDay ? 1 : 0,
    first_clock_in: d.firstInAt,
    last_clock_out: d.lastSeenAt,
    worked_minutes: d.workedMinutes,
    break_minutes: d.breaks.reduce((a, b) => a + (b.actualMinutes || 0), 0),
    late_minutes: d.lateMinutes,
    excess_break_minutes: d.excessBreakMinutes,
    early_departure_minutes: d.earlyDepartureMinutes,
    unauthorised_missing_minutes: d.unauthorisedMissingMinutes,
    approved_adjustment_minutes: d.approvedAdjustmentMinutes,
    daily_deficit_minutes: d.dailyDeficitMinutes,
    is_late_occurrence: d.isLateOccurrence ? 1 : 0,
    attendance_status: d.attendanceStatus,
    derived_at: nowMs,
  });

  // If the employee is present or has worked minutes, clear any unreviewed suspected no-show records
  if (d.firstInAt != null || d.workedMinutes > 0) {
    try {
      await db.prepare(`
        DELETE FROM absence_records
        WHERE employee_id = ? AND date_key = ? AND absence_type = 'SUSPECTED_NO_SHOW' AND status = 'PENDING_REVIEW'
      `).run(employeeId, dateKey);
    } catch (_) {}
  }

  // The ledger records the day's deficit once it is settled. Writing it while
  // the day is still running would post a figure that keeps changing.
  const dayEnded = nowMs >= T.endOfDay(dateKey);
  if (dayEnded) {
    const changed = !previous || previous.daily_deficit_minutes !== d.dailyDeficitMinutes;
    if (changed) await postDeficit(employeeId, dateKey, d.dailyDeficitMinutes, nowMs);
  }

  return d;
}

// ---------------------------------------------------------------------------
// Deficit ledger (spec 8.2, 8.3)
// ---------------------------------------------------------------------------

const selectLatestLedger = db.prepare(`
  SELECT * FROM attendance_deficit_ledger
  WHERE employee_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
`);

const selectLedgerForDay = db.prepare(`
  SELECT * FROM attendance_deficit_ledger
  WHERE employee_id = ? AND date_key = ? AND entry_type = 'DAILY_DEFICIT'
`);

const insertLedger = db.prepare(`
  INSERT INTO attendance_deficit_ledger
    (id, employee_id, date_key, entry_type, minutes_delta, balance_after,
     whole_days_after, carry_forward_after, description, created_at, created_by)
  VALUES (@id, @employee_id, @date_key, @entry_type, @minutes_delta, @balance_after,
          @whole_days_after, @carry_forward_after, @description, @created_at, @created_by)
`);

/**
 * Current running balance, with the whole-day view spec 8.3 asks for.
 *
 * Both values are kept: 527 minutes is one whole-day equivalent PLUS 47 minutes
 * carried forward, not 1.1 days. They are derived from the balance rather than
 * stored separately, so they cannot drift apart.
 */
async function balanceFor(employeeId, nowMs = T.now(), includeToday = true) {
  const latest = await selectLatestLedger.get(employeeId);
  let balance = latest ? Math.max(0, latest.balance_after) : 0;

  if (includeToday) {
    const todayDateKey = T.dateKey(nowMs);
    const todaySettled = await selectLedgerForDay.get(employeeId, todayDateKey);
    // If today's deficit has not yet been settled into the ledger at end of day
    if (!todaySettled) {
      const todaySummary = await deriveDay(employeeId, todayDateKey, nowMs);
      balance += (todaySummary.dailyDeficitMinutes || 0);
    }
  }

  const dayEquivalent = await (await schedule.resolve(employeeId)).dayEquivalentMinutes;
  return {
    balanceMinutes: balance,
    wholeDayEquivalents: Math.floor(balance / dayEquivalent),
    carryForwardMinutes: balance % dayEquivalent,
    dayEquivalentMinutes: dayEquivalent,
  };
}

async function postDeficit(employeeId, dateKey, minutes, nowMs = T.now(), { createdBy = 'system' } = {}) {
  const existing = await selectLedgerForDay.get(employeeId, dateKey);
  // Recomputing a day must adjust by the difference, not post the whole figure
  // again - otherwise a correction would double-count.
  const delta = existing ? minutes - existing.minutes_delta : minutes;
  if (existing && delta === 0) return null;

  const current = await balanceFor(employeeId);
  const balanceAfter = Math.max(0, current.balanceMinutes + delta);
  const dayEquivalent = current.dayEquivalentMinutes;

  const entry = {
    id: 'def_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    date_key: dateKey,
    entry_type: existing ? 'CORRECTION' : 'DAILY_DEFICIT',
    minutes_delta: delta,
    balance_after: balanceAfter,
    whole_days_after: Math.floor(balanceAfter / dayEquivalent),
    carry_forward_after: balanceAfter % dayEquivalent,
    description: existing
      ? `Recalculated ${dateKey}: ${existing.minutes_delta} -> ${minutes} min`
      : `Attendance deficit for ${dateKey}`,
    created_at: nowMs,
    created_by: createdBy,
  };

  await insertLedger.run(entry);

  // Spec 8.3: reaching a whole-day equivalent "should create an HR action". It
  // deliberately does NOT alter salary, leave or discipline on its own.
  const crossedThreshold =
    Math.floor(balanceAfter / dayEquivalent) > Math.floor(current.balanceMinutes / dayEquivalent);

  return { entry, crossedThreshold, balanceAfter };
}

/** An explicit HR adjustment to the balance. Always attributed. */
async function adjustBalance({ employeeId, dateKey, minutes, reason, actor }) {
  if (!reason) throw new Error('An adjustment needs a reason.');
  const nowMs = T.now();
  const current = await balanceFor(employeeId);
  const balanceAfter = Math.max(0, current.balanceMinutes + minutes);

  const entry = {
    id: 'def_' + crypto.randomBytes(8).toString('hex'),
    employee_id: employeeId,
    date_key: dateKey || T.dateKey(nowMs),
    entry_type: 'HR_ADJUSTMENT',
    minutes_delta: minutes,
    balance_after: balanceAfter,
    whole_days_after: Math.floor(balanceAfter / current.dayEquivalentMinutes),
    carry_forward_after: balanceAfter % current.dayEquivalentMinutes,
    description: reason,
    created_at: nowMs,
    created_by: actor,
  };
  await insertLedger.run(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Lateness occurrences (spec 9.1, 9.6)
// ---------------------------------------------------------------------------

/**
 * The bounds of the current monitoring period.
 *
 * Spec 9.6 left the reset period undecided and warned against hard-coding it.
 * Forgotten Women confirmed CALENDAR_MONTH on 2026-08-27. An unconfigured value
 * still refuses rather than assuming, because guessing here silently decides
 * who receives a warning.
 */
function monitoringPeriod(dateKey = T.dateKey()) {
  const period = config.latenessMonitoringPeriod;
  const [y, m] = String(dateKey).split('-').map(Number);

  switch (period) {
    case 'CALENDAR_MONTH': {
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { period, from, to: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
    }
    case 'ROLLING_30_DAYS': {
      const to = dateKey;
      const from = T.dateKey(T.startOfDay(dateKey) - 29 * 24 * 60 * MIN);
      return { period, from, to };
    }
    case 'CALENDAR_YEAR':
      return { period, from: `${y}-01-01`, to: `${y}-12-31` };
    case 'QUARTER': {
      const q = Math.floor((m - 1) / 3);
      const startMonth = q * 3 + 1;
      const endMonth = startMonth + 2;
      const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
      return {
        period,
        from: `${y}-${String(startMonth).padStart(2, '0')}-01`,
        to: `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      };
    }
    default:
      return { period: 'UNSET', from: null, to: null, unresolved: true };
  }
}

const countLateInRange = db.prepare(`
  SELECT COUNT(*) c FROM attendance_daily_summary
  WHERE employee_id = ? AND is_late_occurrence = 1 AND date_key >= ? AND date_key <= ?
`);

const selectLateDates = db.prepare(`
  SELECT date_key, late_minutes FROM attendance_daily_summary
  WHERE employee_id = ? AND is_late_occurrence = 1 AND date_key >= ? AND date_key <= ?
  ORDER BY date_key
`);

/**
 * Lateness standing for the current monitoring period.
 *
 * Returns the numbers and the referral state. It does NOT create a warning -
 * spec 9.3 is explicit that an automatic alert and a formal warning are
 * different things, because a late record may later be corrected or authorised.
 */
async function latenessStatus(employeeId, dateKey = T.dateKey()) {
  const window = monitoringPeriod(dateKey);

  if (window.unresolved) {
    return {
      resolved: false,
      reason: 'latenessMonitoringPeriod is not configured',
      // Said plainly, because the alternative is silently picking a period and
      // deciding who gets disciplined.
      message: 'Lateness cannot be evaluated until the reset period is configured.',
    };
  }

  const allowed = config.latenessOccurrencesAllowed;
  const count = (await countLateInRange.get(employeeId, window.from, window.to)).c;
  const occurrences = await selectLateDates.all(employeeId, window.from, window.to);

  const remaining = Math.max(0, allowed - count);
  const thresholdReached = count > allowed;

  let level = 'OK';
  if (thresholdReached) level = 'THRESHOLD_REACHED';
  else if (count >= allowed) level = 'AT_LIMIT';
  else if (count > 0) level = 'APPROACHING';

  // The wording spec 9.2 asks the employee dashboard to show.
  let message;
  if (thresholdReached) {
    message = 'The lateness warning threshold has been reached. This has been referred to HR for review.';
  } else if (count >= allowed) {
    message = `You have reached ${count} late occurrences. If you are late again during the current monitoring period, a warning will be triggered.`;
  } else if (count > 0) {
    message = `You have been late ${count} time${count === 1 ? '' : 's'} during the current monitoring period. You have ${remaining} permitted late occurrence${remaining === 1 ? '' : 's'} remaining before the warning threshold is reached.`;
  } else {
    message = `No late occurrences during the current monitoring period. ${allowed} permitted.`;
  }

  return {
    resolved: true,
    periodType: window.period,
    periodFrom: window.from,
    periodTo: window.to,
    allowed,
    count,
    remaining,
    thresholdReached,
    level,
    message,
    occurrences: occurrences.map(o => ({ date: o.date_key, lateMinutes: o.late_minutes })),
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function present(d) {
  const activeBreak = d.breaks.find(b => b.open);
  return {
    employeeId: d.employeeId,
    date: d.dateKey,
    isWorkingDay: d.isWorkingDay,
    nonWorkingReason: d.nonWorkingReason || null,
    scheduledStart: d.schedule.startTime,
    scheduledEnd: d.schedule.endTime,
    status: d.attendanceStatus,
    firstIn: d.firstInAt ? T.displayTime(d.firstInAt) : '--',
    lastSeen: d.lastSeenAt ? T.displayTime(d.lastSeenAt) : '--',
    worked: T.formatMinutes(d.workedMinutes),
    workedMinutes: d.workedMinutes,
    presenceSource: d.presenceSource ? d.presenceSource.label : null,
    sensorCarried: d.sensorCarried,

    // The four components shown separately, so the employee dashboard can
    // explain WHY a deficit exists rather than showing one bare number.
    deficit: {
      lateMinutes: d.lateMinutes,
      excessBreakMinutes: d.excessBreakMinutes,
      earlyDepartureMinutes: d.earlyDepartureMinutes,
      unauthorisedMissingMinutes: d.unauthorisedMissingMinutes,
      approvedAdjustmentMinutes: Math.abs(d.approvedAdjustmentMinutes || 0),
      totalMinutes: d.dailyDeficitMinutes,
      formatted: T.formatMinutes(d.dailyDeficitMinutes),
    },

    isLateOccurrence: d.isLateOccurrence,
    onBreak: Boolean(d.onBreak),
    breakDueBack: d.breakDueBackAt ? T.displayTime(d.breakDueBackAt) : null,
    breakDueBackAtMs: d.breakDueBackAt || null,
    activeBreakStartedAtMs: activeBreak ? activeBreak.startedAt : null,
    permittedBreakMinutes: activeBreak ? activeBreak.permittedMinutes : (d.schedule ? d.schedule.permittedBreakMinutes : 30),
    breakMinutesTaken: d.breaks.reduce((a, b) => a + (b.actualMinutes || 0), 0),
    breaks: d.breaks.map(b => ({
      from: T.displayTime(b.startedAt),
      to: b.endedAt ? T.displayTime(b.endedAt) : null,
      taken: b.actualMinutes === null ? null : `${b.actualMinutes} / ${b.permittedMinutes} mins`,
      actualMinutes: b.actualMinutes,
      permittedMinutes: b.permittedMinutes,
      excessMinutes: b.excessMinutes,
      open: b.open,
    })),
    sessions: d.sessions.map(s => ({
      from: T.displayTime(s.start),
      to: s.open ? 'now' : T.displayTime(s.end),
      duration: T.formatMinutes(s.minutes),
      open: s.open,
    })),
    needsReview: d.needsReview,
  };
}

module.exports = {
  deriveDay, recomputeDay, present,
  startBreak, endBreak,
  balanceFor, postDeficit, adjustBalance,
  latenessStatus, monitoringPeriod,
};
