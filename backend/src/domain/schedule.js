// Which schedule applies to an employee on a given date.
//
// Everything in the attendance engine depends on this. "Late" is meaningless
// without knowing what time this person was due to start, and spec section 6 is
// explicit that the schedule must be configurable "because future employees,
// departments or offices may use different schedules" - so nothing here reads a
// constant.
//
// Resolution order, most specific first:
//   1. the working pattern on the employee's current employment record
//   2. the pattern flagged as the organisation default
//   3. config/office.json
//
// The office calendar overrides all three: a public holiday or an organisation
// closure is not a working day no matter what pattern applies.

const { db } = require('../db');
const { config } = require('../config');
const T = require('../util/time');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const selectEmploymentPattern = db.prepare(`
  SELECT wp.*, er.office_id
  FROM employment_records er
  LEFT JOIN working_patterns wp ON wp.id = er.working_pattern_id
  WHERE er.employee_id = ?
    AND er.effective_from <= ?
    AND (er.effective_to IS NULL OR er.effective_to >= ?)
  ORDER BY er.effective_from DESC
  LIMIT 1
`);

const selectDefaultPattern = db.prepare(
  'SELECT * FROM working_patterns WHERE is_default = 1 AND active = 1 LIMIT 1'
);

const selectEmployeeOffice = db.prepare('SELECT office_id FROM employees WHERE id = ?');

const selectCalendarDay = db.prepare(
  'SELECT * FROM calendar_days WHERE office_id = ? AND date = ?'
);

/** The local weekday key for a date, e.g. 'mon'. */
function weekdayKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The schedule in force for one employee on one date.
 *
 * Always returns something usable - a missing employment record falls back to
 * the organisation default rather than throwing, because an employee with no
 * schedule should still show up on the dashboard rather than crashing it.
 */
function resolve(employeeId, dateKey = T.dateKey()) {
  const row = selectEmploymentPattern.get(employeeId, dateKey, dateKey);
  const pattern = (row && row.id) ? row : selectDefaultPattern.get();

  const workingDays = (pattern?.working_days || config.office.workingDays?.join(',') || 'mon,tue,wed,thu,fri')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const startTime = pattern?.start_time || config.workStartTime;
  const endTime = pattern?.end_time || config.workEndTime;
  const permittedBreakMinutes = pattern?.permitted_break_minutes
    ?? config.office.permittedBreakMinutes ?? 30;
  const dayEquivalentMinutes = pattern?.day_equivalent_minutes
    ?? config.office.dayEquivalentMinutes ?? 480;

  // A NULL grace on the pattern means "use the organisation setting", not
  // "zero" - those are different statements and conflating them would decide
  // policy by accident.
  const graceMinutes = pattern?.grace_minutes ?? config.latenessGraceMinutes;

  const day = weekdayKey(dateKey);
  let isWorkingDay = workingDays.includes(day);
  let nonWorkingReason = isWorkingDay ? null : 'Rest day';

  // Office calendar. Spec 16: an employee must not lose annual leave for a day
  // configured as a paid office closure.
  const officeId = row?.office_id || selectEmployeeOffice.get(employeeId)?.office_id;
  let calendarEntry = null;
  if (officeId) {
    calendarEntry = selectCalendarDay.get(officeId, dateKey) || null;
    if (calendarEntry && calendarEntry.day_type !== 'WORKING') {
      isWorkingDay = false;
      nonWorkingReason = calendarEntry.name || calendarEntry.day_type;
    }
  }

  return {
    employeeId,
    dateKey,
    patternId: pattern?.id || null,
    patternName: pattern?.name || 'Organisation default',
    isWorkingDay,
    nonWorkingReason,
    calendarDayType: calendarEntry?.day_type || (isWorkingDay ? 'WORKING' : 'REST_DAY'),
    isPaidNonWorkingDay: calendarEntry ? !!calendarEntry.is_paid : false,
    startTime,
    endTime,
    permittedBreakMinutes,
    dayEquivalentMinutes,
    graceMinutes,
    officeId: officeId || null,

    // Absolute instants, so callers never re-derive them and risk disagreeing.
    scheduledStartAt: T.wallClockToEpoch(dateKey, startTime),
    scheduledEndAt: T.wallClockToEpoch(dateKey, endTime),
    // The latest arrival that is still not a late OCCURRENCE.
    latestOnTimeAt: T.wallClockToEpoch(dateKey, startTime) + graceMinutes * 60000,
  };
}

/** Scheduled working dates in a range, for absence detection and reports. */
function workingDaysBetween(employeeId, fromKey, toKey) {
  const out = [];
  let cursor = T.startOfDay(fromKey);
  const end = T.startOfDay(toKey);
  // Bounded so a malformed range cannot spin.
  for (let guard = 0; cursor <= end && guard < 800; guard++) {
    const key = T.dateKey(cursor);
    const s = resolve(employeeId, key);
    if (s.isWorkingDay) out.push(key);
    cursor = T.endOfDay(key);
  }
  return out;
}

module.exports = { resolve, workingDaysBetween, weekdayKey };
