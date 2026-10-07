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
const { db, tx, audit } = require('../db');
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

// A break left open from an earlier day. One break per day, never spanning
// midnight, so an open one from before today can only mean "End break" never
// reached the server (on 2026-10-01 the laptops' DNS failed mid-break). Left
// alone it made every later heartbeat count as break time for days: the
// employee showed as not arrived while working.
const selectStaleBreaks = db.prepare(`
  SELECT * FROM break_records
  WHERE ended_at IS NULL AND date_key < ? AND (employee_id = ? OR ?::text IS NULL)
`);

/**
 * Closes breaks still open from before today, at the end of their permitted
 * allowance: when the person actually came back is unknown, and a request that
 * failed should not cost them excess break. The day is re-derived and the
 * closure audited. Pass employeeId to limit it to one person.
 */
async function closeStaleBreaks(employeeId = null, nowMs = T.now()) {
  const today = T.dateKey(nowMs);
  const stale = await selectStaleBreaks.all(today, employeeId, employeeId);
  for (const b of stale) {
    const permitted = Number(b.permitted_minutes) || 30;
    const endedAt = Number(b.started_at) + permitted * MIN;
    await db.prepare(
      'UPDATE break_records SET ended_at = ?, actual_minutes = ?, excess_minutes = 0 WHERE id = ? AND ended_at IS NULL'
    ).run(endedAt, permitted, b.id);
    await audit({
      actor: 'system', action: 'BREAK_AUTO_CLOSED',
      targetType: 'employee', targetId: b.employee_id,
      after: { breakId: b.id, dateKey: b.date_key, endedAt },
      note: 'Break was still open on a later day; closed at the end of the permitted allowance.',
    });
    try { await recomputeDay(b.employee_id, b.date_key, nowMs); } catch (_) {}
  }
  return stale.length;
}

/**
 * Ends the employee's working day: a CLOCK_OUT attendance event (once per
 * day), any open break closed, the day's laptop sessions marked CHECKED_OUT.
 * After it nothing more is credited that day (buildDayView stops at the
 * clock-out, and the desktop heartbeat stops crediting).
 *
 * Used by "End shift" on the laptop and by the automatic clock-out after the
 * shift (jobs.autoClockOut). Returns null if the day was already clocked out.
 */
async function clockOut(employeeId, {
  atMs = T.now(), dateKey = T.dateKey(atMs), source = 'SYSTEM', deviceId = null, actor = 'system',
  nowMs = T.now(), capOpenBreak = false,
} = {}) {
  const existing = await db.prepare(`
    SELECT id FROM attendance_events
    WHERE employee_id = ? AND date_key = ? AND event_type = 'CLOCK_OUT' AND voided_at IS NULL LIMIT 1
  `).get(employeeId, dateKey);
  if (existing) return null;

  const open = await db.prepare(
    'SELECT started_at, permitted_minutes FROM break_records WHERE employee_id = ? AND date_key = ? AND ended_at IS NULL'
  ).get(employeeId, dateKey);
  if (open) {
    // A person clocking out ends their break then. The automatic clock-out
    // (capOpenBreak) can't know when they came back, so it closes the break
    // no later than its allowance rather than charging hours of excess.
    const allowanceEnd = Number(open.started_at) + (Number(open.permitted_minutes) || 30) * MIN;
    const endAt = capOpenBreak ? Math.min(atMs, allowanceEnd, nowMs) : atMs;
    await endBreak(employeeId, Math.max(Number(open.started_at), endAt));
  }

  const id = 'ae_' + crypto.randomBytes(8).toString('hex');
  await db.prepare(`
    INSERT INTO attendance_events
      (id, employee_id, date_key, occurred_at, event_type, source, device_id, created_at, created_by)
    VALUES (?, ?, ?, ?, 'CLOCK_OUT', ?, ?, ?, ?)
  `).run(id, employeeId, dateKey, atMs, source, deviceId, nowMs, actor);
  await db.prepare(`UPDATE workstation_sessions SET status = 'CHECKED_OUT', updated_at = ? WHERE employee_id = ? AND session_date = ?`)
    .run(nowMs, employeeId, dateKey);
  await recomputeDay(employeeId, dateKey, nowMs);
  return { id, atMs, dateKey };
}

/**
 * Why an employee's OWN clock-out (laptop End shift, phone clock-out) can't be
 * a real end of the day right now, or null if it can. Refused before the shift
 * has started or within its first hour, and before they have been seen at all
 * today. People pressed End shift on arriving (25 Sep - 7 Oct, every time
 * within 25 minutes of 11:00, often before any presence); once End shift became
 * a real clock-out that ended their working day before it began. HR's and the
 * automatic clock-out don't go through this.
 */
const SELF_CLOCK_OUT_EARLIEST_MS = 60 * MIN;

async function selfClockOutRefusal(employeeId, nowMs = T.now()) {
  const dateKey = T.dateKey(nowMs);
  const d = await deriveDay(employeeId, dateKey, nowMs);
  const s = d.schedule || {};
  if (s.isWorkingDay && s.scheduledStartAt && nowMs < s.scheduledStartAt + SELF_CLOCK_OUT_EARLIEST_MS) {
    const from = T.displayTime(s.scheduledStartAt + SELF_CLOCK_OUT_EARLIEST_MS);
    return {
      reason: 'TOO_EARLY',
      message: `Your shift only started at ${T.displayTime(s.scheduledStartAt)}, so End shift isn't available until ${from}. If you really need to leave, ask HR.`,
    };
  }
  if (!d.firstInAt) {
    return { reason: 'NOT_ARRIVED', message: "You haven't been recorded as arrived today, so there is no shift to end." };
  }
  return null;
}

// Only a clock-out the employee made themselves can be resumed by them; one by
// HR or the automatic 20:00 clock-out only by HR.
const SELF_CLOCK_OUT_SOURCES = ['DESKTOP_AGENT', 'MOBILE_APP'];
const RESUME_UNTIL_AFTER_SHIFT_MS = 60 * 60 * 1000;
const RESUME_PRESENCE_STEP_MS = 5 * MIN;

/**
 * Reopen today's working day after a clock-out: the CLOCK_OUT is voided
 * (audited) and the day counts again from now. Until the automatic clock-out
 * time (shift end + 1 h), after which the automatic clock-out would close it
 * again at once.
 *
 * An employee may only undo their own End shift. HR (byHr) may reopen any
 * clock-out, and with creditGap records the person as present from the
 * clock-out until now (presence entered by HR every 5 minutes, so it forms one
 * session) for when they were working all along. Without it the time between
 * the clock-out and the resume is not counted (nothing was recorded then).
 */
async function resumeDay(employeeId, { nowMs = T.now(), actor = 'employee', byHr = false, creditGap = false } = {}) {
  const dateKey = T.dateKey(nowMs);
  const out = await db.prepare(`
    SELECT id, source, occurred_at FROM attendance_events
    WHERE employee_id = ? AND date_key = ? AND event_type = 'CLOCK_OUT' AND voided_at IS NULL
    ORDER BY occurred_at DESC LIMIT 1
  `).get(employeeId, dateKey);
  if (!out) {
    return { ok: false, reason: 'NOT_CLOCKED_OUT', message: byHr ? 'This shift is not ended, so there is nothing to resume.' : 'Your shift is not ended, so there is nothing to resume.' };
  }
  if (!byHr && !SELF_CLOCK_OUT_SOURCES.includes(out.source)) {
    return { ok: false, reason: 'NOT_YOURS', message: 'Your day was closed by HR or automatically, so only HR can reopen it.' };
  }
  const s = await schedule.resolve(employeeId, dateKey);
  if (!s.isWorkingDay || !s.scheduledEndAt || nowMs >= s.scheduledEndAt + RESUME_UNTIL_AFTER_SHIFT_MS) {
    return {
      ok: false, reason: 'SHIFT_OVER',
      message: byHr
        ? 'The shift is over (past the automatic clock-out time), so it can no longer be resumed. Use Add Manual Time or a correction instead.'
        : 'Your shift is over, so it can no longer be resumed. Ask HR if this is wrong.',
    };
  }
  const who = byHr ? 'HR' : 'the employee';
  await db.prepare('UPDATE attendance_events SET voided_at = ?, voided_reason = ? WHERE id = ?')
    .run(nowMs, `Shift resumed by ${who}`, out.id);
  await db.prepare(`UPDATE workstation_sessions SET status = 'ACTIVE', updated_at = ? WHERE employee_id = ? AND session_date = ?`)
    .run(nowMs, employeeId, dateKey);

  let credited = 0;
  if (byHr && creditGap) {
    // From the clock-out (not before the shift start) up to now.
    const from = Math.max(Number(out.occurred_at), s.scheduledStartAt || Number(out.occurred_at));
    for (let t = from; t < nowMs; t += RESUME_PRESENCE_STEP_MS) {
      await P.recordEvent({ employeeId, source: 'ADMIN', location: 'OFFICE', observedAt: t, note: 'Shift resumed by HR: present since the clock-out' });
      credited++;
    }
    await P.recordEvent({ employeeId, source: 'ADMIN', location: 'OFFICE', observedAt: nowMs, note: 'Shift resumed by HR: present since the clock-out' });
    await P.recomputeDay(employeeId, dateKey, nowMs);
  }

  await audit({
    actor, action: 'SHIFT_RESUMED', targetType: 'employee', targetId: employeeId,
    after: { dateKey, voidedClockOut: out.id, clockOutSource: out.source, creditedSinceClockOut: Boolean(byHr && creditGap) },
    note: byHr ? 'Working day reopened by HR' : 'End shift undone by the employee the same day',
  });
  await recomputeDay(employeeId, dateKey, nowMs);
  return { ok: true, dateKey, voidedClockOutAt: Number(out.occurred_at), creditedFrom: byHr && creditGap ? Number(out.occurred_at) : null, presenceEntries: credited };
}

async function startBreak(employeeId, atMs = T.now()) {
  await closeStaleBreaks(employeeId, atMs);
  const open = await selectOpenBreak.get(employeeId);
  if (open) {
    return { ok: false, reason: 'ALREADY_ON_BREAK', startedAt: open.started_at };
  }
  const dateKey = T.dateKey(atMs);

  // Spec: Each employee is entitled to one 30-minute break per working day.
  // Once taken or started, they cannot retake, restart, or reset the break.
  const existingBreaks = await selectBreaks.all(employeeId, dateKey);
  if (existingBreaks.length > 0) {
    return {
      ok: false,
      reason: 'BREAK_ALREADY_USED',
      message: 'You have already used your permitted 30-minute break for today. Only one break is permitted per working day.',
    };
  }

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
  await closeStaleBreaks(employeeId, atMs);
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

// ---------------------------------------------------------------------------
// The day view: ONE definition of "today" for the phone, laptop and dashboard
//
// Each app used to compute its own figure from different server fields (four
// "worked today" formulas between them), so the same person showed three
// different numbers. Rules confirmed by Forgotten Women on 2026-10-05:
//   - worked counts from the shift start (early arrival shows as check-in only)
//     and stops at the shift end or a clock-out;
//   - declared break is not worked, whether or not the phone pinged during it;
//     it counts towards the target up to the permitted allowance;
//   - laptop idle (IDLE: no input for 5+ min, AWAY: locked 5+ min) is not
//     worked, measured from real idle spans, never inside a break;
//   - target = the scheduled shift (11:00-19:00 = 480, break included).
// Deficit, lateness and payroll rules are NOT changed by this.
// ---------------------------------------------------------------------------

const selectIdleSpans = db.prepare(`
  SELECT start_at, end_at FROM workstation_idle_spans
  WHERE employee_id = ? AND date_key = ? ORDER BY start_at
`);
const selectLaptopActive = db.prepare(`
  SELECT COALESCE(SUM(active_seconds), 0) AS s FROM workstation_sessions
  WHERE employee_id = ? AND session_date = ?
`);

// Interval helpers. Lists are [start, end] pairs in epoch ms.
function mergeIntervals(list) {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
function clipIntervals(list, from, to) {
  return mergeIntervals(list.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]));
}
function intersectIntervals(A, B) {
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const a = Math.max(A[i][0], B[j][0]);
    const b = Math.min(A[i][1], B[j][1]);
    if (b > a) out.push([a, b]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}
function subtractIntervals(A, B) {
  const out = [];
  for (const [a0, b0] of A) {
    let cur = a0;
    for (const [c, d] of B) {
      if (d <= cur || c >= b0) continue;
      if (c > cur) out.push([cur, c]);
      cur = Math.max(cur, d);
      if (cur >= b0) break;
    }
    if (cur < b0) out.push([cur, b0]);
  }
  return out;
}
const totalMs = (list) => list.reduce((acc, [a, b]) => acc + (b - a), 0);
const toMinutes = (ms) => Math.round(ms / MIN);

/**
 * Builds the shared day view from what deriveDay already loaded. Pure.
 * `s` is the schedule actually in force for the day (half-day leave applied).
 */
function buildDayView({
  employeeId, dateKey, s, presence, breaks, manualIn, manualOut, onLeave,
  idleSpans, laptopActiveSeconds, nowMs,
}) {
  const dayStart = T.startOfDay(dateKey);
  const dayEnd = T.endOfDay(dateKey);
  const isToday = nowMs >= dayStart && nowMs < dayEnd;
  const shift = s.isWorkingDay && s.scheduledStartAt && s.scheduledEndAt;
  const targetMinutes = shift ? toMinutes(s.scheduledEndAt - s.scheduledStartAt) : 0;
  const permittedBreakMinutes = Number(s.permittedBreakMinutes ?? 30);
  const clockOutAt = manualOut ? Number(manualOut.occurred_at) : null;

  // The window worked time is counted in.
  const winStart = shift ? s.scheduledStartAt : dayStart;
  let winEnd = Math.min(shift ? s.scheduledEndAt : dayEnd, nowMs);
  if (clockOutAt) winEnd = Math.min(winEnd, clockOutAt);

  const sessions = mergeIntervals((presence.sessions || []).map(x => [Number(x.start), Number(x.end)]));
  const P_ = winEnd > winStart ? clipIntervals(sessions, winStart, winEnd) : [];
  const B_all = mergeIntervals(breaks.map(b => [Number(b.started_at), b.ended_at ? Number(b.ended_at) : nowMs]));
  const B_ = winEnd > winStart ? clipIntervals(B_all, winStart, winEnd) : [];
  const I_raw = mergeIntervals((idleSpans || []).map(x => [Number(x.start_at), Number(x.end_at)]));
  const I_ = subtractIntervals(intersectIntervals(I_raw, P_), B_);

  const presentMs = totalMs(P_);
  const breakInPresenceMs = totalMs(intersectIntervals(P_, B_));
  const idleMs = totalMs(I_);
  const adjustment = Number(presence.adjustmentMinutes || 0);

  // Rounded parts first, then worked from them, so what each app shows adds
  // up exactly: worked = present - break - idle (+ HR adjustments).
  let presentMinutes = toMinutes(presentMs);
  let idleMinutes = toMinutes(idleMs);
  let breakMinutes = toMinutes(totalMs(B_));
  let workedMinutes = Math.max(0, presentMinutes - toMinutes(breakInPresenceMs) - idleMinutes + adjustment);
  if (onLeave) { workedMinutes = 0; breakMinutes = 0; presentMinutes = 0; idleMinutes = 0; }

  const progressMinutes = workedMinutes + Math.min(breakMinutes, permittedBreakMinutes);
  const progressPercent = targetMinutes > 0 ? Math.min(100, Math.round((progressMinutes / targetMinutes) * 100)) : 0;
  const remainingMinutes = Math.max(0, targetMinutes - progressMinutes);
  const overtimeMinutes = shift && !onLeave
    ? toMinutes(totalMs(clipIntervals(sessions, s.scheduledEndAt, Math.min(nowMs, dayEnd))))
    : 0;

  const onBreak = breaks.some(b => b.ended_at === null);
  const idleNow = I_raw.some(([, b]) => b >= nowMs - 90 * 1000);
  const presentNow = presence.status === 'IN_OFFICE' || presence.status === 'GRACE_PERIOD';
  const counting = Boolean(
    isToday && shift && !onLeave && !clockOutAt && !onBreak && !idleNow && presentNow
    && nowMs >= s.scheduledStartAt && nowMs < s.scheduledEndAt,
  );

  const checkInAt = manualIn ? Number(manualIn.occurred_at) : (presence.firstInAt || null);
  const lastSeenAt = clockOutAt || presence.lastActiveAt || null;
  const show = (ms) => (ms ? T.displayTime(ms) : null);

  return {
    employeeId, dateKey,
    asOf: nowMs,
    counting,
    checkInAt, checkIn: show(checkInAt),
    checkInSetByHr: Boolean(manualIn),
    lastSeenAt, lastSeen: show(lastSeenAt),
    checkedOut: Boolean(clockOutAt), checkedOutAt: clockOutAt, checkedOutTime: show(clockOutAt),
    // The employee ended the shift themselves and it is still their shift:
    // the laptop offers "Resume shift" (attendance.resumeDay).
    canResume: Boolean(
      clockOutAt && isToday && shift && manualOut && ['DESKTOP_AGENT', 'MOBILE_APP'].includes(manualOut.source)
      && nowMs < s.scheduledEndAt + 60 * 60 * 1000,
    ),
    shiftStartAt: shift ? s.scheduledStartAt : null,
    shiftEndAt: shift ? s.scheduledEndAt : null,
    shiftStart: s.startTime || null, shiftEnd: s.endTime || null,
    targetMinutes,
    presentMinutes,
    breakMinutes,
    permittedBreakMinutes,
    idleMinutes,
    workedMinutes,
    workedFormatted: T.formatMinutes(workedMinutes),
    progressMinutes,
    progressPercent,
    remainingMinutes,
    overtimeMinutes,
    onBreak,
    onLeave: Boolean(onLeave),
    isWorkingDay: Boolean(s.isWorkingDay),
    laptop: { activeMinutes: Math.round(Number(laptopActiveSeconds || 0) / 60) },
  };
}

/**
 * Derive one employee-day.
 *
 * Pure: reads, computes, returns. Persisting is a separate step so the same
 * calculation can be previewed without writing anything.
 */
async function deriveDay(employeeId, dateKey = T.dateKey(), nowMs = T.now()) {
  let s = await schedule.resolve(employeeId, dateKey);
  const leave = s.isWorkingDay ? await schedule.leaveOn(employeeId, dateKey) : null;
  const presence = await P.deriveDay(employeeId, dateKey, nowMs);
  const breaks = await selectBreaks.all(employeeId, dateKey);
  const manual = await selectManualEvents.all(employeeId, dateKey);
  const idleSpans = await selectIdleSpans.all(employeeId, dateKey);
  const laptopActive = (await selectLaptopActive.get(employeeId, dateKey))?.s || 0;

  const dayStart = T.startOfDay(dateKey);
  const dayEnd = T.endOfDay(dateKey);
  const isToday = nowMs >= dayStart && nowMs < dayEnd;

  // A manual HR clock-in overrides the sensor-derived one. HR correcting a
  // record is the highest-authority statement about what happened.
  const manualIn = manual.find(e => e.event_type === 'CLOCK_IN');
  const manualOut = [...manual].reverse().find(e => e.event_type === 'CLOCK_OUT');

  const firstIn = manualIn ? manualIn.occurred_at : presence.firstInAt;
  const lastSeen = manualOut ? manualOut.occurred_at : presence.lastActiveAt;

  // Half-day leave: only the other half of the shift is expected. Morning off
  // moves the start (and lateness) to midday; afternoon off moves the end.
  // Applied before anything is measured so worked time, the target and
  // lateness all use the same half-day window.
  if (leave && leave.half && s.isWorkingDay && s.scheduledStartAt && s.scheduledEndAt) {
    const mid = s.scheduledStartAt + Math.round((s.scheduledEndAt - s.scheduledStartAt) / 2);
    s = leave.half === 'FIRST_HALF'
      ? { ...s, scheduledStartAt: mid, latestOnTimeAt: mid + (s.graceMinutes || 0) * MIN + 59999 }
      : { ...s, scheduledEndAt: mid };
    s.dayEquivalentMinutes = Math.round((s.dayEquivalentMinutes || 480) / 2);
  }

  const day = buildDayView({
    employeeId, dateKey, s, presence, breaks, manualIn, manualOut,
    onLeave: Boolean(leave && leave.fullDay),
    idleSpans, laptopActiveSeconds: laptopActive, nowMs,
  });

  // Presence inside the shift window, before break and idle are taken off.
  // Only the break-offset rule below uses it, so deficit and lateness keep
  // exactly the rules they had; everything shown as "worked" is day.workedMinutes.
  let shiftWorkedMinutes = 0;
  if (s.isWorkingDay && s.scheduledStartAt) {
    shiftWorkedMinutes = (presence.sessions || []).reduce((acc, sess) => {
      const start = Math.max(sess.start, s.scheduledStartAt);
      const end = s.scheduledEndAt ? Math.min(sess.end, s.scheduledEndAt) : sess.end;
      if (end <= start) return acc;
      return acc + Math.max(0, Math.round((end - start) / MIN));
    }, 0);
    shiftWorkedMinutes = Math.max(0, shiftWorkedMinutes + (presence.adjustmentMinutes || 0));
  } else {
    shiftWorkedMinutes = presence.totalMinutes;
  }

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
    // What every app shows as worked (see buildDayView).
    workedMinutes: day.workedMinutes,
    presenceWorkedMinutes: shiftWorkedMinutes,
    day,
    rawPresenceMinutes: presence.totalMinutes,
    adjustmentMinutes: presence.adjustmentMinutes || 0,
    sessions: presence.sessions,
    presence,
    breaks: breaks.map(b => ({
      startedAt: b.started_at,
      endedAt: b.ended_at,
      actualMinutes: b.actual_minutes,
      permittedMinutes: b.permitted_minutes,
      excessMinutes: b.excess_minutes,
      open: b.ended_at === null,
    })),
    lateMinutes: 0,
    recoveredLateMinutes: 0,
    netLateMinutes: 0,
    overtimeMinutes: 0,
    isLateOccurrence: false,
    excessBreakMinutes: 0,
    earlyDepartureMinutes: 0,
    unauthorisedMissingMinutes: 0,
    approvedAdjustmentMinutes: 0,
    dailyDeficitMinutes: 0,
    attendanceStatus: 'PENDING',
    leaveRequestId: leave ? leave.requestId : null,
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

  // Approved leave: the person was not due in, so nothing is late, missing or
  // worked, even if a laptop or phone was on and reporting.
  if (leave && leave.fullDay) {
    return { ...base, workedMinutes: 0, attendanceStatus: 'ON_LEAVE' };
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
  // Arrivals from 11:11 onwards are late, and the deficit is measured beyond grace
  // (e.g., at 11:11, deficit is 1 min; at 11:12, deficit is 2 mins).
  const isLateArrival = firstIn > s.latestOnTimeAt;
  const graceEndMs = s.scheduledStartAt + (s.graceMinutes * MIN);
  const lateMinutes = isLateArrival
    ? Math.max(1, Math.round((firstIn - graceEndMs) / MIN))
    : 0;

  // --- excess break (spec 12) ----------------------------------------------
  let excessBreakMinutes = breaks.reduce((a, b) => a + (b.excess_minutes || 0), 0);
  const openBreak = breaks.find(b => b.ended_at === null);
  if (openBreak) {
    const ongoingMinutes = Math.max(0, Math.round((nowMs - openBreak.started_at) / MIN));
    const ongoingExcess = Math.max(0, ongoingMinutes - openBreak.permitted_minutes);
    excessBreakMinutes += ongoingExcess;
  }

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

  // --- late arrival & break offset policy ----------------------------------
  // 1. Staying late past scheduled end (e.g. 7:00 PM / 19:00) does NOT offset morning lateness.
  //    (Overtime is recorded for visibility, but does not forgive late arrival).
  const overtimeMinutes = (lastSeen && lastSeen > s.scheduledEndAt)
    ? Math.max(0, Math.round((lastSeen - s.scheduledEndAt) / MIN))
    : 0;

  // 2. Break Offset Rule:
  //    If an employee arrives within the 30-minute late window (by 11:30 AM), takes NO break
  //    during the entire day (0 break minutes taken), AND completes the full 8-hour shift time
  //    (shiftWorkedMinutes >= dayEquivalentMinutes || 480), their permitted break allowance
  //    offsets their late arrival without penalty.
  const isWithin30MinLateWindow = firstIn <= (s.scheduledStartAt + 30 * MIN);
  const totalBreakMinutesTaken = breaks.reduce((sum, b) => {
    const mins = b.actual_minutes != null
      ? b.actual_minutes
      : (b.ended_at ? Math.max(0, Math.round((b.ended_at - b.started_at) / MIN)) : Math.max(0, Math.round((nowMs - b.started_at) / MIN)));
    return sum + mins;
  }, 0);

  const completes8Hours = shiftWorkedMinutes >= (s.dayEquivalentMinutes || 480);
  let breakOffsetLateMinutes = 0;
  if (isLateArrival && isWithin30MinLateWindow && totalBreakMinutesTaken === 0 && completes8Hours) {
    breakOffsetLateMinutes = Math.min(lateMinutes, s.permittedBreakMinutes || 30);
  }

  const recoveredLateMinutes = breakOffsetLateMinutes;
  const netLateMinutes = Math.max(0, lateMinutes - recoveredLateMinutes);
  const isLateOccurrence = isLateArrival && netLateMinutes > 0;

  const approvedAdjustmentMinutes = (await selectApprovedAdjustment.get(employeeId, dateKey)).mins || 0;

  // Deficit calculation:
  const dailyDeficitMinutes = Math.max(0,
    netLateMinutes
    + excessBreakMinutes
    + earlyDepartureMinutes
    + unauthorisedMissingMinutes
    - Math.abs(approvedAdjustmentMinutes)
  );

  let attendanceStatus = 'PRESENT';
  if (isLateOccurrence) {
    attendanceStatus = 'LATE';
  } else if (isLateArrival && recoveredLateMinutes >= lateMinutes) {
    attendanceStatus = 'RECOVERED';
  }

  const needsReview = [];
  if (openBreak && !isToday) needsReview.push('Break was never ended');
  if (presence.exceededCap) needsReview.push('Session exceeded the maximum, phone may have been left in the office');
  if (unauthorisedMissingMinutes > 0) needsReview.push(`${unauthorisedMissingMinutes} min gap with no declared break`);

  return {
    ...base,
    lateMinutes,
    recoveredLateMinutes,
    netLateMinutes,
    overtimeMinutes,
    totalBreakMinutesTaken,
    isLateOccurrence,
    excessBreakMinutes,
    earlyDepartureMinutes,
    unauthorisedMissingMinutes,
    approvedAdjustmentMinutes,
    dailyDeficitMinutes,
    attendanceStatus,
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
     daily_deficit_minutes, is_late_occurrence, attendance_status, leave_request_id, derived_at)
  VALUES
    (@employee_id, @date_key, @scheduled_start, @scheduled_end, @is_working_day,
     @first_clock_in, @last_clock_out, @worked_minutes, @break_minutes,
     @late_minutes, @excess_break_minutes, @early_departure_minutes,
     @unauthorised_missing_minutes, @approved_adjustment_minutes,
     @daily_deficit_minutes, @is_late_occurrence, @attendance_status, @leave_request_id, @derived_at)
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
    leave_request_id   = excluded.leave_request_id,
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
    late_minutes: d.netLateMinutes ?? d.lateMinutes ?? 0,
    excess_break_minutes: d.excessBreakMinutes,
    early_departure_minutes: d.earlyDepartureMinutes,
    unauthorised_missing_minutes: d.unauthorisedMissingMinutes,
    approved_adjustment_minutes: d.approvedAdjustmentMinutes,
    daily_deficit_minutes: d.dailyDeficitMinutes,
    is_late_occurrence: d.isLateOccurrence ? 1 : 0,
    attendance_status: d.attendanceStatus,
    leave_request_id: d.leaveRequestId || null,
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
  WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
`);

const selectLedgerForDay = db.prepare(`
  SELECT * FROM attendance_deficit_ledger
  WHERE employee_id = ? AND date_key = ? AND entry_type = 'DAILY_DEFICIT'
`);

// What the ledger currently holds for one day: the original posting plus its corrections.
const selectPostedForDay = db.prepare(`
  SELECT COALESCE(SUM(minutes_delta), 0) AS mins FROM attendance_deficit_ledger
  WHERE employee_id = ? AND date_key = ? AND entry_type IN ('DAILY_DEFICIT', 'CORRECTION')
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

const selectLedgerAsOf = db.prepare(`
  SELECT * FROM attendance_deficit_ledger
  WHERE employee_id = ? AND created_at < ?
  ORDER BY created_at DESC, id DESC LIMIT 1
`);

/**
 * Point-in-time deficit balance, for payroll: "as it stood through the end of
 * dateKey", not "right now" like balanceFor(). balanceFor always reads the
 * latest row regardless of when it was posted, which would leak deficit
 * accrued after a payroll period's end date (e.g. processing a September
 * period a few days into October) into that period's deduction.
 *
 * Bounded by created_at -- the ledger's real insertion order, which is what
 * balance_after is actually cumulative over -- rather than date_key: a
 * backdated HR_ADJUSTMENT or CORRECTION can carry an arbitrary date_key, but
 * its balance_after still reflects the running total at the moment it was
 * actually inserted, so date_key alone is not a safe cutoff.
 */
async function balanceAsOf(employeeId, dateKey) {
  const cutoffMs = T.endOfDay(dateKey);
  const row = await selectLedgerAsOf.get(employeeId, cutoffMs);
  const dayEquivalent = (await schedule.resolve(employeeId, dateKey)).dayEquivalentMinutes;

  if (!row) {
    return { balanceMinutes: 0, wholeDayEquivalents: 0, carryForwardMinutes: 0, dayEquivalentMinutes: dayEquivalent };
  }

  const balance = Math.max(0, row.balance_after);
  return {
    balanceMinutes: balance,
    // Re-derived from the row's own balance rather than trusting its stored
    // whole_days_after, in case dayEquivalentMinutes has changed since.
    wholeDayEquivalents: Math.floor(balance / dayEquivalent),
    carryForwardMinutes: balance % dayEquivalent,
    dayEquivalentMinutes: dayEquivalent,
  };
}

async function postDeficit(employeeId, dateKey, minutes, nowMs = T.now(), { createdBy = 'system' } = {}) {
  const existing = await selectLedgerForDay.get(employeeId, dateKey);
  // Recomputing a day must adjust by the difference from what the ledger
  // already holds for it -- the original posting PLUS every earlier
  // correction. Measuring against the original alone took the same minutes
  // off again on a second recalculation (Zoha Khan's 1 Oct: 630 -> 180 -> 40
  // posted -450 then -590 instead of -140, and the balance clamped to 0).
  const posted = existing ? Number((await selectPostedForDay.get(employeeId, dateKey)).mins) || 0 : 0;
  const delta = existing ? minutes - posted : minutes;
  if (existing && delta === 0) return null;

  // Settled balance only: today's provisional deficit is not on the ledger yet,
  // and folding it in would carry it into this past day's balance_after.
  const current = await balanceFor(employeeId, nowMs, false);
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
      ? `Recalculated ${dateKey}: ${posted} -> ${minutes} min`
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
  const current = await balanceFor(employeeId, nowMs, false);
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
  // The payroll sheet is briefly cached; an HR balance change must show at once.
  try { require('./payroll').invalidatePayrollCache(); } catch (_) {}
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
    status: (d.presenceStatus === 'IN_OFFICE' || d.presenceStatus === 'GRACE_PERIOD')
      ? 'IN_OFFICE'
      : (d.presenceStatus || (d.attendanceStatus === 'PRESENT' ? 'IN_OFFICE' : d.attendanceStatus)),
    attendanceStatus: d.attendanceStatus,
    statusLabel: d.statusLabel || (d.attendanceStatus === 'PRESENT' ? 'Active in Office' : (d.attendanceStatus === 'CLOSED' ? 'Shift Ended' : (d.attendanceStatus || 'Not checked in'))),
    firstIn: d.firstInAt ? T.displayTime(d.firstInAt) : '--',
    lastSeen: d.lastSeenAt ? T.displayTime(d.lastSeenAt) : '--',
    worked: T.formatMinutes(d.workedMinutes),
    workedMinutes: d.workedMinutes,
    // The shared day view: what the phone, laptop and dashboard all display.
    day: d.day || null,
    presenceSource: d.presenceSource ? d.presenceSource.label : null,
    sensorCarried: d.sensorCarried,

    // The components shown separately, so the employee dashboard can
    // explain WHY a deficit exists rather than showing one bare number.
    deficit: {
      lateMinutes: d.lateMinutes,
      recoveredLateMinutes: d.recoveredLateMinutes || 0,
      netLateMinutes: d.netLateMinutes || 0,
      excessBreakMinutes: d.excessBreakMinutes,
      earlyDepartureMinutes: d.earlyDepartureMinutes,
      unauthorisedMissingMinutes: d.unauthorisedMissingMinutes,
      approvedAdjustmentMinutes: Math.abs(d.approvedAdjustmentMinutes || 0),
      totalMinutes: d.dailyDeficitMinutes,
      formatted: T.formatMinutes(d.dailyDeficitMinutes),
    },
    overtimeMinutes: d.overtimeMinutes || 0,
    recoveredLateMinutes: d.recoveredLateMinutes || 0,

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
      minutes: s.minutes,
      open: s.open,
    })),
    needsReview: d.needsReview,
  };
}

// ---------------------------------------------------------------------------
// Multi-Period Working Hours Metrics (7:30h / 450m Target Policy)
// ---------------------------------------------------------------------------

function formatHoursMinutes(minutes) {
  const m = Math.round(minutes || 0);
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  const hrs = Math.floor(abs / 60);
  const remMins = abs % 60;
  return `${sign}${hrs}h ${String(remMins).padStart(2, '0')}m`;
}

/**
 * Calculates working hours metrics across Daily, Weekly, and Monthly windows.
 * Based on the policy of 8h 00m (480 mins) required working time per working day (11:00 AM - 7:00 PM, including 30m break).
 */
async function calculateWorkingHoursMetrics(employeeId, dateKey = T.dateKey(), existingDay = null) {
  const sched = await schedule.resolve(employeeId, dateKey);
  // The scheduled shift is the target (11:00-19:00 = 480, break included),
  // the same figure the day view uses. requiredWorkingMinutes was never set
  // by schedule.resolve, so every pattern used to fall back to config 480.
  const shiftLength = (sched.scheduledStartAt && sched.scheduledEndAt)
    ? Math.round((sched.scheduledEndAt - sched.scheduledStartAt) / MIN) : 0;
  const targetPerDay = shiftLength > 0 ? shiftLength : (config.office.requiredDailyWorkingMinutes || 480);

  const todayDay = existingDay || await deriveDay(employeeId, dateKey);
  const view = todayDay.day || null;
  const isWorkingDay = sched.isWorkingDay;
  // Today's figures come straight from the day view so the phone's ring,
  // the widget and the dashboard agree: progress = worked + break allowance.
  const dailyRequiredMinutes = view ? view.targetMinutes : (isWorkingDay ? targetPerDay : 0);
  const dailyWorkedMinutes = todayDay.workedMinutes || 0;
  const dailyProgressMinutes = view ? view.progressMinutes : dailyWorkedMinutes;
  const dailyShortMinutes = view ? view.remainingMinutes : Math.max(0, dailyRequiredMinutes - dailyWorkedMinutes);
  const dailyAdditionalMinutes = view ? view.overtimeMinutes : Math.max(0, dailyWorkedMinutes - dailyRequiredMinutes);
  const dailyRecoveredMinutes = todayDay.recoveredLateMinutes || 0;

  // --- Week calculation (Monday through Sunday) ---
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayMs = dt.getTime() + diffToMonday * 24 * 60 * 60 * 1000;
  const sundayMs = mondayMs + 6 * 24 * 60 * 60 * 1000;
  const weekStartKey = T.dateKey(mondayMs);
  const weekEndKey = T.dateKey(sundayMs);

  const weekWorkingDays = await schedule.workingDaysBetween(employeeId, weekStartKey, weekEndKey);
  const weekWorkingDaysSoFar = weekWorkingDays.filter(k => k <= dateKey);

  const weekRows = await db.prepare(`
    SELECT date_key, worked_minutes FROM attendance_daily_summary
    WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
  `).all(employeeId, weekStartKey, weekEndKey);

  const weekWorkedMap = new Map();
  for (const r of weekRows) {
    weekWorkedMap.set(r.date_key, r.worked_minutes || 0);
  }
  // If today is in this week, use live todayDay workedMinutes
  weekWorkedMap.set(dateKey, dailyWorkedMinutes);

  let weeklyWorkedMinutes = 0;
  for (const k of weekWorkingDaysSoFar) {
    weeklyWorkedMinutes += (weekWorkedMap.get(k) || 0);
  }

  const weeklyRequiredMinutes = weekWorkingDays.length * targetPerDay;
  const weeklyRequiredToDateMinutes = weekWorkingDaysSoFar.length * targetPerDay;
  const weeklyShortMinutes = Math.max(0, weeklyRequiredToDateMinutes - weeklyWorkedMinutes);
  const weeklyAdditionalMinutes = Math.max(0, weeklyWorkedMinutes - weeklyRequiredToDateMinutes);

  // --- Month calculation (1st to last day of month) ---
  const monthStartKey = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEndKey = `${y}-${String(m).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

  const monthWorkingDays = await schedule.workingDaysBetween(employeeId, monthStartKey, monthEndKey);
  const monthWorkingDaysSoFar = monthWorkingDays.filter(k => k <= dateKey);

  const monthRows = await db.prepare(`
    SELECT date_key, worked_minutes FROM attendance_daily_summary
    WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
  `).all(employeeId, monthStartKey, monthEndKey);

  const monthWorkedMap = new Map();
  for (const r of monthRows) {
    monthWorkedMap.set(r.date_key, r.worked_minutes || 0);
  }
  // Ensure today's live minutes are included
  monthWorkedMap.set(dateKey, dailyWorkedMinutes);

  let monthlyWorkedMinutes = 0;
  for (const k of monthWorkingDaysSoFar) {
    monthlyWorkedMinutes += (monthWorkedMap.get(k) || 0);
  }

  const monthlyRequiredMinutes = monthWorkingDays.length * targetPerDay;
  const monthlyRequiredToDateMinutes = monthWorkingDaysSoFar.length * targetPerDay;
  const monthlyShortMinutes = Math.max(0, monthlyRequiredToDateMinutes - monthlyWorkedMinutes);
  const monthlyAdditionalMinutes = Math.max(0, monthlyWorkedMinutes - monthlyRequiredToDateMinutes);

  return {
    policy: {
      targetDailyHoursFormatted: formatHoursMinutes(targetPerDay),
      targetDailyMinutes: targetPerDay,
      officeWindow: `${sched.startTime} – ${sched.endTime}`,
    },
    daily: {
      dateKey,
      isWorkingDay,
      requiredMinutes: dailyRequiredMinutes,
      workedMinutes: dailyWorkedMinutes,
      progressMinutes: dailyProgressMinutes,
      shortMinutes: dailyShortMinutes,
      additionalMinutes: dailyAdditionalMinutes,
      recoveredMinutes: dailyRecoveredMinutes,
      formattedRequired: formatHoursMinutes(dailyRequiredMinutes),
      formattedWorked: formatHoursMinutes(dailyWorkedMinutes),
      formattedShort: formatHoursMinutes(dailyShortMinutes),
      formattedAdditional: formatHoursMinutes(dailyAdditionalMinutes),
      formattedRecovered: formatHoursMinutes(dailyRecoveredMinutes),
      isTargetMet: dailyProgressMinutes >= dailyRequiredMinutes,
      percent: view ? view.progressPercent
        : (dailyRequiredMinutes > 0 ? Math.min(100, Math.round((dailyWorkedMinutes / dailyRequiredMinutes) * 100)) : 100),
    },
    weekly: {
      weekStartKey,
      weekEndKey,
      workingDaysCount: weekWorkingDays.length,
      workingDaysSoFarCount: weekWorkingDaysSoFar.length,
      requiredMinutes: weeklyRequiredMinutes,
      requiredToDateMinutes: weeklyRequiredToDateMinutes,
      workedMinutes: weeklyWorkedMinutes,
      shortMinutes: weeklyShortMinutes,
      additionalMinutes: weeklyAdditionalMinutes,
      formattedRequired: formatHoursMinutes(weeklyRequiredMinutes),
      formattedRequiredToDate: formatHoursMinutes(weeklyRequiredToDateMinutes),
      formattedWorked: formatHoursMinutes(weeklyWorkedMinutes),
      formattedShort: formatHoursMinutes(weeklyShortMinutes),
      formattedAdditional: formatHoursMinutes(weeklyAdditionalMinutes),
      isTargetMet: weeklyWorkedMinutes >= weeklyRequiredToDateMinutes,
      percent: weeklyRequiredToDateMinutes > 0 ? Math.min(100, Math.round((weeklyWorkedMinutes / weeklyRequiredToDateMinutes) * 100)) : 100,
    },
    monthly: {
      monthKey: `${y}-${String(m).padStart(2, '0')}`,
      scheduledWorkingDays: monthWorkingDays.length,
      workingDaysSoFarCount: monthWorkingDaysSoFar.length,
      requiredMinutes: monthlyRequiredMinutes,
      requiredToDateMinutes: monthlyRequiredToDateMinutes,
      workedMinutes: monthlyWorkedMinutes,
      shortMinutes: monthlyShortMinutes,
      additionalMinutes: monthlyAdditionalMinutes,
      formattedRequired: formatHoursMinutes(monthlyRequiredMinutes),
      formattedRequiredToDate: formatHoursMinutes(monthlyRequiredToDateMinutes),
      formattedWorked: formatHoursMinutes(monthlyWorkedMinutes),
      formattedShort: formatHoursMinutes(monthlyShortMinutes),
      formattedAdditional: formatHoursMinutes(monthlyAdditionalMinutes),
      isTargetMet: monthlyWorkedMinutes >= monthlyRequiredToDateMinutes,
      percent: monthlyRequiredMinutes > 0 ? Math.min(100, Math.round((monthlyWorkedMinutes / monthlyRequiredMinutes) * 100)) : 100,
    },
  };
}

module.exports = {
  deriveDay, recomputeDay, present,
  startBreak, endBreak, closeStaleBreaks, clockOut, selfClockOutRefusal, resumeDay, buildDayView,
  balanceFor, balanceAsOf, postDeficit, adjustBalance,
  latenessStatus, monitoringPeriod,
  calculateWorkingHoursMetrics,
};
