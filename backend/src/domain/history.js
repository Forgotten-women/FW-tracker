// Attendance history for any past date: the employee's own (phone) and any
// employee's (HR dashboard). One implementation, so the two never disagree.
//
// Built from what was persisted as each day was derived -- attendance_days and
// attendance_daily_summary -- plus breaks, leave, absences, corrections and
// laptop time, NOT by replaying raw presence_events. Those are deleted by the
// retention job after a while (replaying would show old days as empty), and a
// replay per day is exactly the egress-heavy read the live paths had to stop
// doing. A range is a handful of set-based queries whatever its length; the
// schedule is resolved per day because a pattern or holiday can change.

const { db } = require('../db');
const schedule = require('./schedule');
const T = require('../util/time');

const MAX_RANGE_DAYS = 62;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class HistoryError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function weekday(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Validates and clamps a requested range: YYYY-MM-DD, from <= to, never past today. */
function normaliseRange(from, to, nowMs = T.now()) {
  const today = T.dateKey(nowMs);
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new HistoryError('from and to must be dates in YYYY-MM-DD format.');
  }
  if (from > to) throw new HistoryError('from must be on or before to.');
  const end = to > today ? today : to;
  if (from > end) return { from, to: end, dates: [] };
  const dates = [];
  for (let d = from; d <= end; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new HistoryError(`A range can cover at most ${MAX_RANGE_DAYS} days.`);
    }
  }
  return { from, to: end, dates };
}

const selectEmployee = db.prepare('SELECT id, name, role, created_at FROM employees WHERE id = ?');
// Start: the earliest employment record's start (or effective date). End: the
// contract end on the current record, if any. With no employment record at
// all, the employee's creation date stands in for the start, so days before
// they existed in the system aren't reported as absences.
const selectEmploymentBounds = db.prepare(`
  SELECT MIN(COALESCE(start_date, effective_from)) AS start_date,
         MAX(CASE WHEN effective_to IS NULL THEN contract_end_date END) AS end_date
  FROM employment_records WHERE employee_id = ?
`);
const selectSummaries = db.prepare(`
  SELECT date_key, first_clock_in, last_clock_out, worked_minutes, break_minutes, late_minutes,
         excess_break_minutes, early_departure_minutes, unauthorised_missing_minutes,
         approved_adjustment_minutes, daily_deficit_minutes, attendance_status
  FROM attendance_daily_summary
  WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
`);
const selectDays = db.prepare(`
  SELECT date_key, first_in_at, last_active_at, total_minutes, adjustment_minutes, adjustment_note, status
  FROM attendance_days
  WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
`);
const selectLeave = db.prepare(`
  SELECT lr.id, lr.start_date, lr.end_date, lr.day_portion, lr.status, lr.total_days,
         COALESCE(lr.is_paid, lt.is_paid) AS is_paid, lt.name AS type_name
  FROM leave_requests lr
  LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
  WHERE lr.employee_id = ? AND lr.status IN ('APPROVED', 'PENDING')
    AND lr.start_date <= ? AND lr.end_date >= ?
`);
const selectAbsences = db.prepare(`
  SELECT date_key, status, treat_as_unpaid, absence_type
  FROM absence_records
  WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
`);
const selectCorrectionCounts = db.prepare(`
  SELECT date_key, status, COUNT(*) AS c
  FROM attendance_corrections
  WHERE employee_id = ? AND date_key >= ? AND date_key <= ?
  GROUP BY date_key, status
`);
const selectLaptop = db.prepare(`
  SELECT session_date, SUM(active_seconds) AS active_s, SUM(idle_seconds) AS idle_s
  FROM workstation_sessions
  WHERE employee_id = ? AND session_date >= ? AND session_date <= ?
  GROUP BY session_date
`);

function parseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch (_) { return value; }
}

const byDate = (rows, key = 'date_key') => new Map(rows.map(r => [r[key], r]));
const clock = (ms) => (ms ? T.displayTime(Number(ms)) : null);

/**
 * Plain-language outcome for a day, from most to least specific. The raw
 * attendance status is returned alongside for anyone who needs it.
 */
function dayStatus({ isToday, beforeEmployment, afterEmployment, sched, summary, leave, workedMinutes }) {
  if (beforeEmployment) return { status: 'NOT_EMPLOYED', label: 'Before employment started' };
  if (afterEmployment && workedMinutes === 0) return { status: 'NOT_EMPLOYED', label: 'After employment ended' };
  // A leave request spanning a weekend or holiday doesn't turn those days into
  // leave days: only scheduled working days are taken as leave.
  if (leave && leave.status === 'APPROVED' && sched.isWorkingDay) {
    return { status: 'ON_LEAVE', label: leave.dayPortion && leave.dayPortion !== 'FULL' ? `${leave.type} (half day)` : leave.type };
  }
  if (!sched.isWorkingDay) {
    const holiday = sched.calendarDayType === 'PUBLIC_HOLIDAY' || (sched.calendarDayType && sched.calendarDayType !== 'REST_DAY');
    if (holiday) return { status: 'HOLIDAY', label: sched.nonWorkingReason || 'Holiday' };
    return workedMinutes > 0
      ? { status: 'REST_DAY_WORKED', label: 'Rest day (worked)' }
      : { status: 'REST_DAY', label: 'Rest day' };
  }
  if (isToday) {
    return workedMinutes > 0
      ? { status: 'IN_PROGRESS', label: 'Today, in progress' }
      : { status: 'NOT_STARTED', label: 'Today, not arrived yet' };
  }
  const a = summary?.attendance_status;
  if (!summary || a === 'NO_ATTENDANCE_RECORDED' || (workedMinutes === 0 && a !== 'PRESENT' && a !== 'LATE')) {
    return { status: 'ABSENT', label: 'No attendance recorded' };
  }
  if (a === 'LATE') return { status: 'LATE', label: 'Late' };
  if (Number(summary.daily_deficit_minutes) > 0) return { status: 'SHORT', label: 'Present, short of hours' };
  return { status: 'ON_TIME', label: a === 'RECOVERED' ? 'On time (lateness recovered)' : 'On time' };
}

/** Every day in [from, to] for one employee: one entry per date, oldest first. */
async function daysInRange(employeeId, from, to, nowMs = T.now()) {
  const range = normaliseRange(from, to, nowMs);
  const employee = await selectEmployee.get(employeeId);
  if (!employee) throw new HistoryError('No such employee.', 404);
  if (range.dates.length === 0) {
    return { employee: { id: employee.id, name: employee.name, role: employee.role }, from: range.from, to: range.to, days: [] };
  }

  const f = range.from;
  const t = range.to;
  const today = T.dateKey(nowMs);
  const [bounds, summaries, days, leave, absences, corrections, laptop] = await Promise.all([
    selectEmploymentBounds.get(employeeId),
    selectSummaries.all(employeeId, f, t),
    selectDays.all(employeeId, f, t),
    selectLeave.all(employeeId, t, f),
    selectAbsences.all(employeeId, f, t),
    selectCorrectionCounts.all(employeeId, f, t),
    selectLaptop.all(employeeId, f, t),
  ]);
  const employmentStart = bounds?.start_date
    || (employee.created_at ? T.dateKey(Number(employee.created_at)) : null);
  const employmentEnd = bounds?.end_date || null;
  const summaryBy = byDate(summaries);
  const dayBy = byDate(days);
  const absenceBy = byDate(absences);
  const laptopBy = byDate(laptop, 'session_date');
  const correctionsBy = new Map();
  for (const c of corrections) {
    const e = correctionsBy.get(c.date_key) || { pending: 0, total: 0 };
    e.total += Number(c.c) || 0;
    // Anything not yet decided: PENDING, PENDING_HR, PENDING_MANAGER, ...
    if (String(c.status).startsWith('PENDING')) e.pending += Number(c.c) || 0;
    correctionsBy.set(c.date_key, e);
  }

  const schedules = await Promise.all(range.dates.map(d => schedule.resolve(employeeId, d)));

  const out = range.dates.map((dateKey, i) => {
    const sched = schedules[i];
    const s = summaryBy.get(dateKey) || null;
    const d = dayBy.get(dateKey) || null;
    // An approved request wins over a pending one covering the same day.
    const covering = leave.filter(l => l.start_date <= dateKey && l.end_date >= dateKey);
    const lr = covering.find(l => l.status === 'APPROVED') || covering[0] || null;
    const leaveInfo = lr ? {
      requestId: lr.id,
      type: lr.type_name || 'Leave',
      status: lr.status,
      dayPortion: lr.day_portion || 'FULL',
      isPaid: lr.is_paid === null || lr.is_paid === undefined ? null : Number(lr.is_paid) === 1,
    } : null;
    const workedMinutes = Number(s?.worked_minutes ?? d?.total_minutes ?? 0) || 0;
    const firstInAt = Number(s?.first_clock_in || d?.first_in_at || 0) || null;
    const lastOutAt = Number(s?.last_clock_out || d?.last_active_at || 0) || null;
    const lap = laptopBy.get(dateKey);
    const abs = absenceBy.get(dateKey);
    const outcome = dayStatus({
      isToday: dateKey === today,
      beforeEmployment: Boolean(employmentStart && dateKey < employmentStart),
      afterEmployment: Boolean(employmentEnd && dateKey > employmentEnd),
      sched, summary: s, leave: leaveInfo, workedMinutes,
    });

    return {
      dateKey,
      weekday: weekday(dateKey),
      isToday: dateKey === today,
      status: outcome.status,
      statusLabel: outcome.label,
      attendanceStatus: s?.attendance_status || null,
      isWorkingDay: Boolean(sched.isWorkingDay),
      dayType: sched.calendarDayType || (sched.isWorkingDay ? 'WORKING' : 'REST_DAY'),
      nonWorkingReason: sched.nonWorkingReason || null,
      scheduledStart: sched.startTime,
      scheduledEnd: sched.endTime,
      firstInAt,
      firstIn: clock(firstInAt),
      lastOutAt,
      lastOut: clock(lastOutAt),
      workedMinutes,
      workedFormatted: T.formatMinutes(workedMinutes),
      breakMinutes: Number(s?.break_minutes || 0),
      deficit: {
        lateMinutes: Number(s?.late_minutes || 0),
        excessBreakMinutes: Number(s?.excess_break_minutes || 0),
        earlyDepartureMinutes: Number(s?.early_departure_minutes || 0),
        unauthorisedMissingMinutes: Number(s?.unauthorised_missing_minutes || 0),
        approvedAdjustmentMinutes: Math.abs(Number(s?.approved_adjustment_minutes || 0)),
        totalMinutes: Number(s?.daily_deficit_minutes || 0),
      },
      adjustment: d && Number(d.adjustment_minutes) ? { minutes: Number(d.adjustment_minutes), note: d.adjustment_note || null } : null,
      leave: leaveInfo,
      absence: abs ? { status: abs.status, type: abs.absence_type || null, treatAsUnpaid: Number(abs.treat_as_unpaid) === 1 } : null,
      corrections: correctionsBy.get(dateKey) || { pending: 0, total: 0 },
      laptop: lap ? {
        activeMinutes: Math.round((Number(lap.active_s) || 0) / 60),
        idleMinutes: Math.round((Number(lap.idle_s) || 0) / 60),
      } : null,
    };
  });

  return {
    employee: { id: employee.id, name: employee.name, role: employee.role },
    from: range.from, to: range.to, employmentStart, employmentEnd, days: out,
  };
}

const selectBreaks = db.prepare(`
  SELECT started_at, ended_at, permitted_minutes, actual_minutes, excess_minutes
  FROM break_records WHERE employee_id = ? AND date_key = ? ORDER BY started_at ASC
`);
const selectSessionsJson = db.prepare(
  'SELECT sessions_json FROM attendance_days WHERE employee_id = ? AND date_key = ?'
);
const selectCorrections = db.prepare(`
  SELECT id, requested_at, requested_change, reason, status, reviewed_at, review_notes
  FROM attendance_corrections WHERE employee_id = ? AND date_key = ? ORDER BY requested_at ASC
`);
const selectLaptopSessions = db.prepare(`
  SELECT ws.device_id, d.model, d.label, ws.active_seconds, ws.idle_seconds, ws.break_seconds,
         ws.unverified_seconds, ws.created_at, ws.last_heartbeat_at
  FROM workstation_sessions ws LEFT JOIN devices d ON d.id = ws.device_id
  WHERE ws.employee_id = ? AND ws.session_date = ?
`);
const selectTopApps = db.prepare(`
  SELECT app_name, SUM(active_seconds) AS active_s FROM workstation_app_usage
  WHERE employee_id = ? AND session_date = ?
  GROUP BY app_name ORDER BY active_s DESC LIMIT 10
`);
const selectMovements = db.prepare(`
  SELECT at, type, details FROM movements
  WHERE employee_id = ? AND at >= ? AND at < ? ORDER BY at ASC LIMIT 200
`);

/**
 * One day in full: the summary above plus the sessions timeline, breaks,
 * corrections and laptop activity. `forHr` adds what only HR sees: the
 * movements log and the laptop's top applications.
 */
async function dayDetail(employeeId, dateKey, { nowMs = T.now(), forHr = false } = {}) {
  if (!DATE_RE.test(String(dateKey || ''))) throw new HistoryError('The date must be YYYY-MM-DD.');
  if (dateKey > T.dateKey(nowMs)) throw new HistoryError('That date is in the future.');
  const { employee, days, employmentStart } = await daysInRange(employeeId, dateKey, dateKey, nowMs);
  const day = days[0];

  const [sessionsRow, breaks, corrections, laptops] = await Promise.all([
    selectSessionsJson.get(employeeId, dateKey),
    selectBreaks.all(employeeId, dateKey),
    selectCorrections.all(employeeId, dateKey),
    selectLaptopSessions.all(employeeId, dateKey),
  ]);

  let sessions = [];
  try {
    sessions = JSON.parse(sessionsRow?.sessions_json || '[]').map(s => ({
      startAt: s.start || null,
      endAt: s.open ? null : (s.end || null),
      start: clock(s.start),
      end: s.open ? 'now' : clock(s.end),
      minutes: Number(s.minutes) || 0,
      duration: T.formatMinutes(Number(s.minutes) || 0),
    }));
  } catch (_) { /* a malformed cache row shows no timeline rather than failing */ }

  const detail = {
    employee: { id: employee.id, name: employee.name, role: employee.role },
    employmentStart,
    ...day,
    sessions,
    breaks: breaks.map(b => ({
      startedAt: Number(b.started_at),
      endedAt: b.ended_at ? Number(b.ended_at) : null,
      start: clock(b.started_at),
      end: b.ended_at ? clock(b.ended_at) : null,
      permittedMinutes: Number(b.permitted_minutes) || null,
      actualMinutes: b.actual_minutes === null || b.actual_minutes === undefined ? null : Number(b.actual_minutes),
      excessMinutes: Number(b.excess_minutes || 0),
    })),
    correctionRequests: corrections.map(c => ({
      id: c.id,
      requestedAt: Number(c.requested_at),
      // Stored as JSON text; sent as the object, as /api/attendance/corrections does.
      requestedChange: parseJson(c.requested_change),
      reason: c.reason,
      status: c.status,
      reviewedAt: c.reviewed_at ? Number(c.reviewed_at) : null,
      reviewNotes: c.review_notes || null,
    })),
    laptopSessions: laptops.map(l => ({
      deviceId: l.device_id,
      device: l.model || l.label || 'Laptop',
      activeMinutes: Math.round((Number(l.active_seconds) || 0) / 60),
      idleMinutes: Math.round((Number(l.idle_seconds) || 0) / 60),
      breakMinutes: Math.round((Number(l.break_seconds) || 0) / 60),
      unverifiedMinutes: Math.round((Number(l.unverified_seconds) || 0) / 60),
      firstSeen: clock(l.created_at),
      lastSeen: clock(l.last_heartbeat_at),
    })),
  };

  if (forHr) {
    const start = T.startOfDay(dateKey);
    const end = T.endOfDay(dateKey);
    const [apps, movements] = await Promise.all([
      selectTopApps.all(employeeId, dateKey),
      selectMovements.all(employeeId, start, end),
    ]);
    detail.topApps = apps.map(a => ({ app: a.app_name, minutes: Math.round((Number(a.active_s) || 0) / 60) }));
    detail.movements = movements.map(m => ({ at: Number(m.at), time: clock(m.at), type: m.type, details: m.details || '' }));
  }
  return detail;
}

module.exports = { daysInRange, dayDetail, normaliseRange, HistoryError, MAX_RANGE_DAYS };
